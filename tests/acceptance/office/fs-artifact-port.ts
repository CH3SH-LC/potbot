/**
 * **物化端口的宿主实现**（design-02 P1；合同 v1.4 R49.1 第二段 / R50 / R51 / R53.1）。
 *
 * ## 为什么这个文件在验收侧
 *
 * R50.4：本批**唯一**允许出现 `node:fs` 的位置是"验收侧宿主实现"（`tests/acceptance/office/**`）。
 * `src/**` 保持零文件 IO、零墙钟。内核只**声明**端口（`src/artifacts/ports.ts`），
 * 真正把字节写进磁盘、改名、回读的只在这里。
 *
 * ## 严格按序（R49.1 第二段，**不得合并**）
 *
 * 1. **版本闸门**：读当前 `TaskRecord.revision`；与请求的 `task_revision` 不等（或任务查不到）
 *    ⇒ 结构化失败 `version_stale`，**一个字节都不写**；
 * 2. **取字节**：`request.payload` 存在 ⇒ **直接写这份字节**（内核已在事务 1 内用纯构建器算好，
 *    再自行重建就是"两处产出、可能分叉"）；不存在 ⇒ 才回退到注入的构建器；
 * 3. **写版本化临时路径** → **第 1 层结构自检**（`src/artifacts/verify.ts`）→ **原子 `rename`** 到最终路径；
 * 4. **回读最终路径**、重算摘要，**核对等于 `expected_content_digest`**（I-1 的可执行形式）——
 *    不等 ⇒ 结构化失败 `self_check_failed`，**不得**返回成功回执；
 * 5. 返回 `materializationSuccess(receipt)`。
 *
 * ## 幂等（R50.3）——**一律以磁盘回读为准，进程内记忆不作捷径**
 *
 * 最终路径已存在、且对其**实际回读**的摘要 == 期望摘要 ⇒ 返回**既有回执**，**不重写**。
 * 关键在于"已存在"必须**每次重新回读核对**：`#receipts` 里的记忆只证明"本实例曾经交付过"，
 * 不证明"最终路径**现在**仍是那份字节"。因此本实现的幂等判定一律落到磁盘上取证据：
 * - **存在且回读摘要相符** ⇒ 既有回执（摘要 / 字节长度 / 条目数全部取自**本次回读**）；
 * - **存在但回读摘要不符**（或读不动、拿不到回读证据）⇒ 结构化失败 `self_check_failed`：
 *   交付面上摆着的不是本产物该有的字节，**不**声称已交付，也**不**静默覆盖（覆盖会把
 *   "盘上被换过"这件事一并抹掉）；
 * - **最终路径不存在** ⇒ 幂等前提不成立，交回物化管线**重新产出**（R49.4 的重放语义）。
 *
 * ## 确定性（R51.5）
 *
 * 本文件**没有墙钟**：回执的 `at` 由注入的 `now()`（逻辑时间）给出；路径由 `plan` 决定，
 * 不掺 `Date` / `process.pid` / 随机数 / 主机名 / 语言环境。`sha256` 用内建原语（字节入口），
 * 与 `src/artifacts/templates/*.ts` 的 `content_digest` 同口径（裸小写 hex）。
 *
 * ## 失败一律结构化（R50.2）
 *
 * 端口**不抛错、不静默**：连"请求与计划不一致"这类编程错误都在此转成 `builder_failed` 结构化失败，
 * 调用方据此落 `failed` / `superseded`。回执与失败都带非空 `detail`。
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname as hostDirname, resolve as resolveHostPath } from 'node:path';

import {
  asLogicalTime,
  type ArtifactRef,
  type LogicalTime,
  type Revision,
  type TaskId,
  type TemplateKind,
} from '../../../src/protocol/index.js';
import {
  assertRequestPlanConsistency,
  materializationFailure,
  materializationSuccess,
  type ArtifactMaterializationPort,
  type ArtifactMaterializationReceipt,
  type ArtifactMaterializationRequest,
  type ArtifactMaterializationResult,
  type KnownFactSnapshotEntry,
} from '../../../src/artifacts/ports.js';
import {
  describeSelfCheckResult,
  selfCheckArtifactBytes,
} from '../../../src/artifacts/verify.js';
import { buildDocxTemplate, type DocxTemplateInput } from '../../../src/artifacts/templates/docx.js';
import {
  buildPresentation,
  type PresentationBuildInput,
} from '../../../src/artifacts/templates/pptx.js';
import {
  buildXlsxTemplate,
  type XlsxSheetSpec,
} from '../../../src/artifacts/templates/xlsx.js';

/** 回执里的验证者标识（**唯一字面量来源**；`publish.test.ts` 也引用同一串）。 */
export const FS_ARTIFACT_PORT_VERIFIER = 'tests/acceptance/office/fs-artifact-port';

/** 三条可注入的失败分支（J10 用）：分别对应 `builder_failed` / `write_failed` / `self_check_failed`。 */
export const FS_ARTIFACT_PORT_FAIL_AT = ['build', 'write', 'verify'] as const;

/**
 * 可注入的故障开关（J10 用）：把一条失败分支钉死在**确定的阶段**上。
 *
 * - `build`  ⇒ `builder_failed`
 * - `write`  ⇒ `write_failed`
 * - `verify` ⇒ `self_check_failed`
 *
 * **可预测性优先**：三条分支都在进入物化管线**之前**短路（版本闸门与幂等检查之后），
 * 因此**不需要**另配 `build_bytes` 或 `payload`，也**不会**真的产生任何文件；
 * `detail` 如实写明"注入故障在写盘前短路"。真实失败路径（构建器抛错 / 写盘抛错 /
 * 自检不通过 / 回读摘要不符）不受影响，仍按各自的阶段如实归类。
 *
 * 它**只**用于验收构造失败分支，不进任何生产路径（同 `Store.faults` 的纪律）。
 */
export type FsArtifactPortFailAt = (typeof FS_ARTIFACT_PORT_FAIL_AT)[number] | null;

/** 构建器的产出：只要字节（条目数由结构自检从**实际字节**得出，不由构建器自报）。 */
export interface ArtifactBytesBuilderResult {
  readonly bytes: Uint8Array;
}

/** `payload` 缺省时的回退构建器（显式注入；不注入且 payload 也缺 ⇒ 结构化失败）。 */
export type ArtifactBytesBuilder = (
  request: ArtifactMaterializationRequest,
) => ArtifactBytesBuilderResult;

/** 三类模板的固定输入（**不含事实快照**——事实快照一律取自请求，保证单一来源）。 */
export interface OfficeTemplateInputs {
  readonly document?: Omit<DocxTemplateInput, 'fact_snapshot'>;
  readonly spreadsheet?: { readonly spec: XlsxSheetSpec };
  readonly presentation?: Omit<PresentationBuildInput, 'fact_snapshot'>;
}

export interface FsArtifactPortOptions {
  /**
   * 读**当前**任务版本（版本闸门的唯一读口）。
   * `null` = 任务不在存储中 ⇒ 按"无法确认就不得发布"放弃物化（**不得**当成 0 或默认版本）。
   */
  readonly read_revision: (taskId: TaskId) => Revision | null;
  /** 逻辑时间读取口（回执 / 失败记录的 `at`）。**不得**是墙钟。 */
  readonly now: () => LogicalTime;
  /** 回执里的验证者标识（默认 {@link FS_ARTIFACT_PORT_VERIFIER}）。 */
  readonly verifier?: string;
  /** `payload` 缺省时的回退构建器；缺省 + 无 payload ⇒ 结构化失败（不假装产出）。 */
  readonly build_bytes?: ArtifactBytesBuilder;
  /** 故障注入（默认关闭）。 */
  readonly fail_at?: FsArtifactPortFailAt;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** 产物字节的 sha256（裸小写 hex）——与三个模板构建器的 `content_digest` 同口径。 */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 计划的**逻辑路径**（`/` 分隔、绝对）→ 宿主机路径。Windows 上由 `node:path` 规范化。 */
function hostPathOf(logicalPath: string): string {
  return resolveHostPath(logicalPath);
}

/**
 * 取请求上的 `payload`（**可选字段**）。
 *
 * 用 `unknown` 投影读取：主协调者正在给 `ArtifactMaterializationRequest` 增加
 * `payload?: Uint8Array`，本文件**在该字段落地前后都能编译**，落地后自动改走"直接写 payload"。
 */
function payloadOf(request: ArtifactMaterializationRequest): Uint8Array | undefined {
  const candidate = (request as unknown as { readonly payload?: unknown }).payload;
  if (candidate === undefined || candidate === null) return undefined;
  if (candidate instanceof Uint8Array) return candidate;
  throw new TypeError(
    'ArtifactMaterializationRequest.payload 必须是 Uint8Array / Buffer，' +
      `收到 ${typeof candidate}`,
  );
}

/** 丢弃临时文件（best-effort：临时路径在交付面之外，丢了不影响任何读者）。 */
function discardStaging(stagingPath: string): void {
  try {
    rmSync(stagingPath, { force: true });
  } catch {
    // 丢弃失败不改变结论：临时文件不在交付面内，也不被任何记录指向。
  }
}

/** 一条失败结果的紧凑可读 detail（自检问题逐条列出，不截断）。 */
function describeSelfCheckProblems(bytes: Uint8Array): string {
  const check = selfCheckArtifactBytes(bytes);
  if (check.ok) return '';
  return `${describeSelfCheckResult(check).replace(/\n/g, ' | ')}`;
}

// ---------------------------------------------------------------------------
// 端口实现
// ---------------------------------------------------------------------------

/**
 * 真实落盘的物化端口（**本批唯一做文件 IO 的实现**）。
 *
 * 计数器（`calls` / `writes`）是**只读旁证**：夹具据此断言"投影只物化了一次""幂等路径没有重写"。
 */
export class FsArtifactMaterializationPort implements ArtifactMaterializationPort {
  readonly #readRevision: (taskId: TaskId) => Revision | null;
  readonly #now: () => LogicalTime;
  readonly #verifier: string;
  readonly #buildBytes: ArtifactBytesBuilder | undefined;
  readonly #failAt: FsArtifactPortFailAt;
  readonly #receipts = new Map<string, ArtifactMaterializationReceipt>();
  #calls = 0;
  #writes = 0;

  constructor(options: FsArtifactPortOptions) {
    this.#readRevision = options.read_revision;
    this.#now = options.now;
    this.#verifier = options.verifier ?? FS_ARTIFACT_PORT_VERIFIER;
    this.#buildBytes = options.build_bytes;
    this.#failAt = options.fail_at ?? null;
  }

  /** 端口被调用次数（含幂等短路与版本闸门；调用方据此核对"没有被重复物化"）。 */
  get calls(): number {
    return this.#calls;
  }

  /** 真正写进临时路径的次数（幂等路径不增加）。 */
  get writes(): number {
    return this.#writes;
  }

  /** 已产出回执的产物 id（升序；只读）。 */
  receiptIds(): readonly string[] {
    return Object.freeze([...this.#receipts.keys()].sort());
  }

  /** 某个产物的回执（幂等路径返回**同一个对象**）。 */
  receiptOf(artifactId: ArtifactRef): ArtifactMaterializationReceipt | undefined {
    return this.#receipts.get(artifactId);
  }

  materialize(request: ArtifactMaterializationRequest): ArtifactMaterializationResult {
    this.#calls += 1;
    const at = asLogicalTime(this.#now());
    try {
      return this.#materializeOrFail(request, at);
    } catch (error) {
      // 宿主实现自身崩了：R50.2 允许抛错，但**不得**让调用方拿到半成品——这里就地转结构化失败。
      return materializationFailure(
        request,
        'builder_failed',
        `物化端口宿主实现异常（阶段不可归因）：${describeError(error)}`,
        at,
      );
    }
  }

  // --- 阶段实现 ---------------------------------------------------------------

  #materializeOrFail(
    request: ArtifactMaterializationRequest,
    at: LogicalTime,
  ): ArtifactMaterializationResult {
    // 请求与计划必须自洽（否则"回执里的路径"与"记录里的身份"会静默分叉）。
    assertRequestPlanConsistency(request);

    const plan = request.plan;
    const finalPath = hostPathOf(plan.final_path);
    const stagingPath = hostPathOf(plan.staging_path);

    // ── 1 版本闸门（R49.1 第二段第一步；不通过 ⇒ 不写任何文件）────────────────
    const currentRevision = this.#readRevision(request.task_id);
    if (currentRevision === null) {
      return materializationFailure(
        request,
        'version_stale',
        `任务 ${request.task_id} 不在存储中：无法核对当前版本，按"不得在无法确认时发布"放弃物化` +
          '（未写任何文件）',
        at,
      );
    }
    if (currentRevision !== request.task_revision) {
      return materializationFailure(
        request,
        'version_stale',
        `版本闸门：当前任务版本 r${String(currentRevision)} ≠ 请求的 task_revision ` +
          `r${String(request.task_revision)}——放弃物化，旧版本不得覆盖最新文件（P2 / 任务书 §13）；未写任何文件`,
        at,
      );
    }

    // ── 幂等（R50.3）：最终路径已存在**且本次回读摘要 == 期望** ⇒ 返回既有回执，不重写 ──
    // 注意：判定**必须**落到磁盘（见 `#existingDeliveryOf` 的注释）——进程内记忆不得短路回读。
    const existing = this.#existingDeliveryOf(request, finalPath, at);
    if (existing !== null) return existing;

    // ── 注入故障（J10）：三条分支都在进入物化管线**之前**短路 ──────────────────
    // 理由（可预测性）：注入结果**只取决于开关**，不取决于是否另配了构建器 / payload；
    // 且因为短路发生在任何写盘之前，**不会**真的产生文件（detail 如实这么写）。
    if (this.#failAt !== null) {
      return this.#injectedFailure(request, at);
    }

    // ── 2 取字节：payload 优先，其次回退构建器 ────────────────────────────────
    const bytes = this.#bytesFor(request, at);
    if (!bytes.ok) return bytes.failure;

    // ── 3a 写版本化临时路径（交付面之外）────────────────────────────────────
    try {
      mkdirSync(hostDirname(stagingPath), { recursive: true });
      writeFileSync(stagingPath, bytes.bytes);
      this.#writes += 1;
    } catch (error) {
      discardStaging(stagingPath);
      return materializationFailure(
        request,
        'write_failed',
        `写临时路径失败（${plan.staging_path}）：${describeError(error)}`,
        at,
      );
    }

    // ── 3b 第 1 层结构自检（**rename 之前**：坏字节不得进交付面）───────────────
    const stagedCheck = selfCheckArtifactBytes(bytes.bytes);
    if (!stagedCheck.ok) {
      discardStaging(stagingPath);
      return materializationFailure(
        request,
        'self_check_failed',
        `第 1 层结构自检不通过（临时文件已丢弃，最终路径未写入）：${describeSelfCheckProblems(bytes.bytes)}`,
        at,
      );
    }

    // ── 3c 原子 rename 到最终路径 ────────────────────────────────────────────
    try {
      mkdirSync(hostDirname(finalPath), { recursive: true });
      renameSync(stagingPath, finalPath);
    } catch (error) {
      discardStaging(stagingPath);
      return materializationFailure(
        request,
        'write_failed',
        `原子改名失败（${plan.staging_path} → ${plan.final_path}）：${describeError(error)}`,
        at,
      );
    }

    // ── 4 回读最终路径、重算摘要、核对期望（I-1：没有回读证据不得为 published）──
    let readBack: Buffer;
    try {
      readBack = readFileSync(finalPath);
    } catch (error) {
      return materializationFailure(
        request,
        'write_failed',
        `回读最终路径失败（${plan.final_path}）：${describeError(error)}`,
        at,
      );
    }
    const readbackDigest = sha256Hex(readBack);
    if (readbackDigest !== request.expected_content_digest) {
      return materializationFailure(
        request,
        'self_check_failed',
        `回读摘要核对不通过：对最终路径 ${plan.final_path} 实际回读得到的 sha256 ` +
          `${readbackDigest} ≠ 期望摘要 ${request.expected_content_digest}——不得返回成功回执`,
        at,
      );
    }
    const finalCheck = selfCheckArtifactBytes(readBack);
    if (!finalCheck.ok) {
      return materializationFailure(
        request,
        'self_check_failed',
        `回读后的结构自检不通过（最终路径 ${plan.final_path}）：` +
          `${describeSelfCheckProblems(readBack)}`,
        at,
      );
    }

    // ── 5 成功回执（回读摘要来自对最终路径的实际回读）────────────────────────
    return this.#succeed(request, readbackDigest, readBack.byteLength, finalCheck.entry_count, at);
  }

  /** 注入故障的结构化结局（`detail` 如实写明"未产生任何文件"）。 */
  #injectedFailure(
    request: ArtifactMaterializationRequest,
    at: LogicalTime,
  ): ArtifactMaterializationResult {
    const reason = '注入的故障（J10 失败分支）：在进入写盘管线之前短路，未产出字节、未写任何文件';
    switch (this.#failAt) {
      case 'build':
        return materializationFailure(request, 'builder_failed', `${reason}；阶段 = 构建`, at);
      case 'write':
        return materializationFailure(
          request,
          'write_failed',
          `${reason}；阶段 = 写盘（临时路径 ${request.plan.staging_path}）`,
          at,
        );
      case 'verify':
        return materializationFailure(
          request,
          'self_check_failed',
          `${reason}；阶段 = 结构自检（最终路径 ${request.plan.final_path} 未写入）`,
          at,
        );
      default:
        // `#injectedFailure` 只在 `failAt !== null` 时被调用。
        return materializationFailure(
          request,
          'builder_failed',
          `${reason}；未知的注入开关 ${String(this.#failAt)}`,
          at,
        );
    }
  }

  /** 取字节：payload 优先；缺省时才调用注入的回退构建器。 */
  #bytesFor(
    request: ArtifactMaterializationRequest,
    at: LogicalTime,
  ): { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly failure: ArtifactMaterializationResult } {
    let payload: Uint8Array | undefined;
    try {
      payload = payloadOf(request);
    } catch (error) {
      return {
        ok: false,
        failure: materializationFailure(
          request,
          'builder_failed',
          `payload 形态非法：${describeError(error)}`,
          at,
        ),
      };
    }
    if (payload !== undefined) {
      return { ok: true, bytes: payload };
    }
    if (this.#buildBytes === undefined) {
      return {
        ok: false,
        failure: materializationFailure(
          request,
          'builder_failed',
          '请求既没有 payload、也没有注入回退构建器（build_bytes）：端口不自行产出字节，' +
            '以免与内核事务 1 内的构建分叉（R48.3 / R50.1）',
          at,
        ),
      };
    }
    try {
      const built = this.#buildBytes(request);
      return { ok: true, bytes: built.bytes };
    } catch (error) {
      return {
        ok: false,
        failure: materializationFailure(
          request,
          'builder_failed',
          `回退构建器抛错（${request.template_kind}）：${describeError(error)}`,
          at,
        ),
      };
    }
  }

  /**
   * 幂等判定（R50.3）——**每次都必须回读最终路径**，`#receipts` 的记忆**不得**短路回读。
   *
   * 记忆只能证明"本实例曾经交付过"，不能证明"最终路径**现在**仍是那份字节"；把前者当后者
   * 就是把"曾经一致"冒充成"现在一致"（W-FIX4 的探针实测：篡改盘上字节后，memo 分支仍返回
   * `ok:true`，且回执摘要与盘上字节不符）。
   *
   * 三种结局：
   * - 最终路径**不存在** ⇒ `null`：R50.3 的幂等前提不成立，交回物化管线**重新产出**
   *   （R49.4 的重放语义——"文件被删"要能补回来，不是把它误认成"已交付"）；
   * - 存在、可读、**本次回读摘要 == `expected_content_digest`** ⇒ 返回既有回执，
   *   摘要 / 字节长度 / 条目数全部取自**本次回读**，不沿用记忆对象里的旧值；
   * - 存在但**回读摘要 ≠ 期望**（或读不动 ⇒ 拿不到回读证据）⇒ 结构化失败 `self_check_failed`：
   *   交付面上摆着的不是本产物该有的字节，**不得**声称已交付，也**不**静默覆盖。
   */
  #existingDeliveryOf(
    request: ArtifactMaterializationRequest,
    finalPath: string,
    at: LogicalTime,
  ): ArtifactMaterializationResult | null {
    // 不存在 ⇒ 幂等前提不成立，交回管线重建（本函数不写盘；重建走 staging + 原子改名）。
    if (!existsSync(finalPath)) return null;

    // 存在 ⇒ **一律回读**。`#receipts` 只用于"交出回执"，不用于"跳过核对"。
    let readBack: Buffer;
    try {
      readBack = readFileSync(finalPath);
    } catch (error) {
      return materializationFailure(
        request,
        'self_check_failed',
        `幂等核对失败：最终路径 ${request.plan.final_path} 已存在但读不动` +
          `（${describeError(error)}）——拿不到回读证据，不得声称已交付`,
        at,
      );
    }

    const digest = sha256Hex(readBack);
    if (digest !== request.expected_content_digest) {
      return materializationFailure(
        request,
        'self_check_failed',
        `幂等核对失败：最终路径 ${request.plan.final_path} 上的字节与期望摘要不符——` +
          `本次实际回读 sha256 ${digest} ≠ 期望摘要 ${request.expected_content_digest}。` +
          'R50.3 的幂等只在"回读摘要与期望一致"时成立；"曾经交付过"不等于"现在仍然一致"，' +
          '故不得返回成功回执（也未被静默覆盖）',
        at,
      );
    }

    // 摘要相符 = 最终路径上就是**本产物该有的字节** ⇒ 不重写，据实交出既有回执。
    const finalCheck = selfCheckArtifactBytes(readBack);
    if (!finalCheck.ok) {
      return materializationFailure(
        request,
        'self_check_failed',
        `幂等核对失败：最终路径 ${request.plan.final_path} 的回读字节摘要与期望相符，` +
          `但容器未通过结构自检：${describeSelfCheckProblems(readBack)}`,
        at,
      );
    }
    return this.#succeed(request, digest, readBack.byteLength, finalCheck.entry_count, at);
  }

  #succeed(
    request: ArtifactMaterializationRequest,
    readbackDigest: string,
    byteLength: number,
    entryCount: number,
    at: LogicalTime,
  ): ArtifactMaterializationResult {
    const receipt: ArtifactMaterializationReceipt = Object.freeze({
      artifact_id: request.artifact_id,
      final_path: request.plan.final_path,
      readback_digest: readbackDigest,
      byte_length: byteLength,
      entry_count: entryCount,
      verifier: this.#verifier,
      at,
    });
    this.#receipts.set(request.artifact_id, receipt);
    return materializationSuccess(receipt);
  }
}

/** 便捷构造（与 `createArtifactPublicationProjection` 同形）。 */
export function createFsArtifactMaterializationPort(
  options: FsArtifactPortOptions,
): FsArtifactMaterializationPort {
  return new FsArtifactMaterializationPort(options);
}

// ---------------------------------------------------------------------------
// payload 缺省时的回退构建器（**显式装配**：三模板各只喂"任务要求"一类输入）
// ---------------------------------------------------------------------------

/**
 * 按 `template_kind` 调对应的**纯构建器**产出字节。
 *
 * 事实快照一律取自**请求**（`request.fact_snapshot`）——构建器的输入里没有"直接传数字"的位置
 * （R48.3），因此这里无法把 8 改成 10；`unknown` / `not_applicable` 也进不来（R48.4 在进入物化前
 * 就阻塞为 `missing_fact`）。
 *
 * @throws {ValidationError} 对应模板的输入契约不满足（输入缺项 / 正文含快照外的数字 …）。
 */
export function buildTemplateBytes(
  templateKind: TemplateKind,
  factSnapshot: readonly KnownFactSnapshotEntry[],
  inputs: OfficeTemplateInputs,
): Uint8Array {
  switch (templateKind) {
    case 'document': {
      if (inputs.document === undefined) {
        throw new Error('回退构建器缺少 document 输入（OfficeTemplateInputs.document）');
      }
      return buildDocxTemplate({ ...inputs.document, fact_snapshot: factSnapshot }).bytes;
    }
    case 'spreadsheet': {
      if (inputs.spreadsheet === undefined) {
        throw new Error('回退构建器缺少 spreadsheet 输入（OfficeTemplateInputs.spreadsheet）');
      }
      return buildXlsxTemplate(inputs.spreadsheet.spec, factSnapshot).bytes;
    }
    case 'presentation': {
      if (inputs.presentation === undefined) {
        throw new Error('回退构建器缺少 presentation 输入（OfficeTemplateInputs.presentation）');
      }
      return buildPresentation({ ...inputs.presentation, fact_snapshot: factSnapshot }).bytes;
    }
    default: {
      const unexpected: never = templateKind;
      throw new Error(`未登记的模板种类：${String(unexpected)}`);
    }
  }
}

/** 把 {@link buildTemplateBytes} 折成端口要的回退构建器形状。 */
export function createTemplateBytesBuilder(inputs: OfficeTemplateInputs): ArtifactBytesBuilder {
  return (request) =>
    Object.freeze({
      bytes: buildTemplateBytes(request.template_kind, request.fact_snapshot, inputs),
    });
}

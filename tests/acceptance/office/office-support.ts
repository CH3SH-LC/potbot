/**
 * **办公产物场景夹具**（design-02 P1 / P3 / P6；合同 v1.4 R47–R53、R56、R61；归属 W-F / D02A-WF1，本次改造 D02A-WFIX1）。
 *
 * ## 这个文件是什么 / 不是什么
 *
 * - **是**：把「任务 + 共享事实 + 产物计划 + 物化端口 + 发布投影」按**公开接口**装起来，
 *   并给出只读观测、确定性逻辑步推进（`mark()`）、独立读回与清理的**验收夹具**；
 * - **不是**：被测逻辑的复制品。夹具**不写工作项状态、不置排队标记、不自己算交付结论**；
 *   `published` 与否一律经 `isDeliveredArtifact()` 从**存储快照**读。
 *
 * ## 夹具纪律（照 `a02a03/harness.ts` 与 `a05/scenario-support.ts` 的成文纪律）
 *
 * 1. **不代办内核步骤**（本版已彻底满足，见下）；2. **不补业务状态**；3. 断言只经只读通道；
 * 4. `mark()` **绝不用墙钟**（逻辑时钟每步 +1，步号是证据里唯一的"时刻"）。
 *
 * ## 产物产生路径（本版现状：内核对产物的两个入口均已上线）
 *
 * 内核侧的两个接缝**已经可用**，夹具因此**完全经公开入口**驱动，不再有任何代办：
 *
 * 1. **暂存（事务 1，R49.1 / R56）**：在装配时登记任务 / 实例 / 成员，然后经公开入口
 *    `onMessage(work_request)` × 3 → `startRun()` 建立一个轮次。轮次在**启动时冻结**任务版本
 *    （`RunRecord.task_revision`），而共享事实在**收尾时才被读取**——这正是版本闸门
 *    （J9：先启动、再超越版本、最后收尾）能被构造出来的原因。
 * 2. **收尾 + 发布（R56.1 / R56.2）**：`materializeAll()` 调 `finishRun({ publications })`，
 *    每条 `completed` 发布携带 `artifact: { intent, fact_keys }`（**Agent 不给数字、不给版本**）。
 *    `finishRun` 在**同一事务**里暂存 `staged` 记录（`src/artifacts/staging.ts`），并在**提交之后**
 *    经 `SchedulerOptions.artifacts` 的投影**自动发布**（版本闸门 → 物化端口 → 回读 → 落库）。
 *
 * 因此 `materializeAll()` 是"**显式推进到产物已发布**"的放行口，**它自己不再写任何记录**：
 * 记录一律由内核的暂存事务写，物化由注入端口做，发布由提交后投影完成。
 * `materializeCalls()` 仍准确反映端口被调用的次数（反作弊判据，被 p1 / office-negative / p3 / p6 断言）。
 *
 * ## 缺事实的路径：**一律由内核拒绝**（不再由夹具伪造失败记录）
 *
 * `run` 收尾时，缺事实 / 值为 `unknown` / `not_applicable` / 只登记了别的版本 ⇒ 内核的
 * `stagePublicationArtifact()` 返回结构化失败 `missing_fact`，写一条 `publication_rejected`
 * 观测事件并**拒绝该条发布**（逐条粒度：不产零值产物、不写任何 `ArtifactRecord`、不调端口）。
 *
 * **由此产生的一处如实标注**：改造前夹具会**自己**为缺事实的产物写一条
 * `failed` 记录（`failure_kind='missing_fact'`）；改造后这条记录**不再存在**，于是
 * "一条事实都没登记（或全部不可用）"的场景里 `artifacts()` 可能是**空数组**——
 * 这是 R48.4 / R56 的**正确行为**（内核不写失败产物记录），验收断言应据 `ArtifactRecord`
 * 的**缺席**而非"failed 记录"来表达"未产出"，请如实保留。
 *
 * ## 产物根（R52.2）与 R61 的裁定
 *
 * 位置由 `tests/acceptance/freeze-identity.ts` 的**位置解析**决定：
 * 正式冻结点 ⇒ `docs/other/evidence/{登记冻结点}/products/{场景}/`；
 * 开发期（复算不符）⇒ `.dev-evidence/{登记冻结点}/products/{场景}/`。
 * 每份产物的 sha256 / 字节长度 / 条目数 / 独立读回结论在 `cleanup()` 时**登记进证据报告**
 * （经 `writeEvidenceArtifacts()`，R52.1 的唯一落盘入口）。
 *
 * > **R61 对 R52.2 / R53.7 冲突的裁定（已并入本文件）**：落点一律按 R52.2
 * > （`{证据落盘位置}/products/`，R53.7 括注"系统临时目录"作废）；证据报告一律经
 * > `writeEvidenceArtifacts` 落盘。
 * > **R61 第 2 条已落地（原"本版未实现的一点"标注作废）**：`cleanup()` **先读身份再决定
 * > 删不删**——身份经 `this.identity()`（`#stamp` 复算）判定，**不得无条件删**：
 * > 正式身份（`frozen: true`）⇒ **保留**产物字节、不删（这些字节是 P1 的证据本身，
 * > 其 sha256 / 字节长度 / 条目数已由上面的证据报告登记，删了就等于只剩"声称产出过"）；
 * > 开发身份（`DEV-UNFROZEN`）⇒ 带重试删除本场景产物根（R53.7 纪律，重试用尽告警不判红）。
 * > `OfficeScenario` 的 14 个成员签名与语义保持不变。
 *
 * ## 场景需要的前置数据
 *
 * 夹具**不预置业务事实**（同 a05 的 `registerTask` / `registerInstance` 纪律）：测试用例经
 * `registerFact()` 登记共享事实。默认产物集消费的事实键见 `OFFICE_FACT_KEYS_BY_KIND`；
 * 缺失的键按 R48.4 由**内核**阻塞为 `missing_fact`（**不产出零值产物**）。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve as resolveHostPath } from 'node:path';

import {
  SenderBinding,
  TEMPLATE_KINDS,
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRequestId,
  asRevision,
  asTaskId,
  createGroupMember,
  createIdSource,
  createInstanceState,
  createMessage,
  createTaskRecord,
  isDeliveredArtifact,
  snapshotArtifacts,
  type ArtifactRecord,
  type ArtifactRef,
  type GroupId,
  type GroupMessage,
  type IdSource,
  type InstanceId,
  type LogicalTime,
  type RequestId,
  type Revision,
  type RunId,
  type SharedFactRecord,
  type Store,
  type StoreSnapshot,
  type TaskId,
  type TemplateKind,
} from '../../../src/protocol/index.js';
import { createMemoryStore } from '../../../src/storage/index.js';
import { LogicalClock } from '../../../src/clock/index.js';
import { createScheduler, type Scheduler } from '../../../src/scheduler/index.js';
import type { ArtifactPublicationIntent } from '../../../src/artifacts/index.js';
import { selfCheckArtifactBytes } from '../../../src/artifacts/verify.js';
import type { DocxTemplateInput } from '../../../src/artifacts/templates/docx.js';
import type { XlsxSheetSpec } from '../../../src/artifacts/templates/xlsx.js';
import type { PresentationBuildInput } from '../../../src/artifacts/templates/pptx.js';
import {
  createFsArtifactMaterializationPort,
  createTemplateBytesBuilder,
  type FsArtifactMaterializationPort,
  type OfficeTemplateInputs,
} from './fs-artifact-port.js';
import { readbackArtifact, type ReadbackResult } from './independent-readback.js';
import { requireToolchain } from './toolchain.js';
import {
  evidenceIdentityStamp,
  evidenceOutputLocationFromStamp,
  writeEvidenceArtifacts,
} from '../freeze-identity.js';

// ---------------------------------------------------------------------------
// 场景常量（**单一来源**；测试用例据此构造前置事实）
// ---------------------------------------------------------------------------

/** 场景任务 id。 */
export const OFFICE_TASK_ID: TaskId = asTaskId('T1');
/** 场景群组 id。 */
export const OFFICE_GROUP_ID: GroupId = asGroupId('G1');
/** 场景实例 id（产物的创建者）。 */
export const OFFICE_INSTANCE_ID: InstanceId = asInstanceId('C');
/** 场景任务版本（版本闸门的比较基准）。 */
export const OFFICE_TASK_REVISION: Revision = asRevision(1);
/** 产物版本（同一任务 + 同一模板种类下的第几版）；首版 = 1。 */
export const OFFICE_ARTIFACT_VERSION = 1;

/**
 * 三类产物各自消费的事实键。
 *
 * 三类**都**消费 `headcount`——这正是 R48.3 的机器判据（三份产物的 `source_fact_refs`
 * 指向**同一条**事实记录）的构造方式。
 */
export const OFFICE_FACT_KEYS_BY_KIND: Readonly<Record<TemplateKind, readonly string[]>> =
  Object.freeze({
    document: Object.freeze(['headcount', 'event.date']),
    spreadsheet: Object.freeze(['headcount']),
    presentation: Object.freeze(['headcount', 'budget.total', 'event.date']),
  });

/** 三类产物共同消费的事实键（R48.3 的"同一版结构化事实"）。 */
export const OFFICE_SHARED_FACT_KEY = 'headcount';

/** 场景全部事实键的并集（测试用例登记事实时可照此清单）。 */
export const OFFICE_FACT_KEYS: readonly string[] = Object.freeze([
  ...new Set(Object.values(OFFICE_FACT_KEYS_BY_KIND).flat()),
]);

/**
 * **保留导出（历史兼容）**：改造前夹具用它给"失败产物"的 `content_digest` 占位
 * （`createArtifactRecord` 要求 `content_digest` 非空）。改造后缺事实路径由内核拒绝、
 * **不再写失败记录**，本常量因此**不再被夹具使用**；保留仅为不改变本模块的导出面。
 */
export const NOT_PRODUCED_CONTENT_DIGEST = 'not-produced';

/**
 * 每个模板种类对应的**工作请求 id**（每类一份工作项，收尾时各发自己那条完成发布）。
 *
 * R48.4 / R56 的逐条粒度要求"一条被拒不阻断同一请求内的其它合法发布"，因此三类产物
 * 分属三个 `request_id`，在同一轮收尾里各自声明结局。
 */
const WORK_REQUEST_IDS: Readonly<Record<TemplateKind, RequestId>> = Object.freeze({
  document: asRequestId('office-document'),
  spreadsheet: asRequestId('office-spreadsheet'),
  presentation: asRequestId('office-presentation'),
});

const DOCUMENT_INPUT: Omit<DocxTemplateInput, 'fact_snapshot'> = Object.freeze({
  requirement: Object.freeze({
    title: '聚餐安排',
    description: '本文件只陈述已确认事实，不改写人数、金额与日期。',
  }),
  references: Object.freeze([
    Object.freeze({ label: '用户确认', detail: '人数与预算由用户在前台确认' }),
  ]),
});

const SPREADSHEET_SPEC: XlsxSheetSpec = Object.freeze({
  sheet_name: '人数汇总',
  label_header: '项目',
  value_header: '数量',
  unit: '人',
  lines: Object.freeze([Object.freeze({ label: '参会人数', fact_key: 'headcount' })]),
  total_label: '合计',
  scale: 0,
});

const PRESENTATION_INPUT: Omit<PresentationBuildInput, 'fact_snapshot'> = Object.freeze({
  title: '聚餐安排',
  goal: '确认聚餐的人数与预算',
  audience: '筹备组成员',
});

/** 三类模板的固定输入（事实快照一律取自请求 / 事实层，**不在这里放数字**）。 */
export const OFFICE_TEMPLATE_INPUTS: OfficeTemplateInputs = Object.freeze({
  document: DOCUMENT_INPUT,
  spreadsheet: Object.freeze({ spec: SPREADSHEET_SPEC }),
  presentation: PRESENTATION_INPUT,
});

// ---------------------------------------------------------------------------
// 产物意图（Agent 只给"意图 + 事实键"，**没有数字、没有版本**；R56 第 1/2 条）
// ---------------------------------------------------------------------------

/** 某个模板种类的产物意图（版本由内核派生，数字由内核从事实取）。 */
function artifactIntentFor(kind: TemplateKind): ArtifactPublicationIntent {
  switch (kind) {
    case 'document':
      return {
        intent: {
          template_kind: 'document',
          requirement: DOCUMENT_INPUT.requirement,
          references: DOCUMENT_INPUT.references,
        },
        fact_keys: OFFICE_FACT_KEYS_BY_KIND.document,
      };
    case 'spreadsheet':
      return {
        intent: { template_kind: 'spreadsheet', sheet: SPREADSHEET_SPEC },
        fact_keys: OFFICE_FACT_KEYS_BY_KIND.spreadsheet,
      };
    case 'presentation':
      return {
        intent: {
          template_kind: 'presentation',
          title: PRESENTATION_INPUT.title,
          goal: PRESENTATION_INPUT.goal,
          audience: PRESENTATION_INPUT.audience,
        },
        fact_keys: OFFICE_FACT_KEYS_BY_KIND.presentation,
      };
  }
}

/**
 * 一条**工作请求**消息（内核经 `createMessage` 构造；发送者必须是**本群已登记成员**）。
 *
 * 发送者用场景实例自己（它已在构造时登记进成员表）：本夹具只关心"有可运行输入"，不构造协作。
 */
function workRequestFor(kind: TemplateKind, idSource: IdSource): GroupMessage {
  const binding = SenderBinding.bind(OFFICE_INSTANCE_ID, {
    group_id: OFFICE_GROUP_ID,
    task_id: OFFICE_TASK_ID,
  });
  return createMessage(
    {
      message_id: asMessageId(`m-office-${kind}`),
      task_id: OFFICE_TASK_ID,
      group_id: OFFICE_GROUP_ID,
      task_revision: OFFICE_TASK_REVISION,
      recipient_instance_id: OFFICE_INSTANCE_ID,
      type: 'work_request',
      request_id: WORK_REQUEST_IDS[kind],
      requires_wakeup: true,
      payload: { content: `场景工作请求：产出 ${kind} 产物` },
    },
    binding,
    { idSource },
  );
}

// ---------------------------------------------------------------------------
// 夹具接口（**冻结**）
// ---------------------------------------------------------------------------

export interface OfficeScenario {
  readonly store: Store;
  readonly scheduler: Scheduler;
  /** 本场景产物根（绝对路径）。 */
  root(): string;
  /** 推进一个确定性逻辑步（**绝不用墙钟**）。 */
  mark(label: string): void;
  snapshot(): StoreSnapshot;
  artifacts(): readonly ArtifactRecord[];
  artifactOf(id: ArtifactRef): ArtifactRecord | undefined;
  /** 端口被调用次数（反作弊：夹具不得代办内核步骤）。 */
  materializeCalls(): number;
  /** 放行投影（等价"投递后显式推进"，不代办内核逻辑）。 */
  materializeAll(): void;
  /** 产物绝对路径（未 published 时抛）。 */
  runFileOf(record: ArtifactRecord): string;
  /** 复用独立读回仪器（第 2 层）。 */
  readback(path: string): ReadbackResult;
  /** 登记共享事实（场景前置数据）。 */
  registerFact(fact: SharedFactRecord): void;
  /** 冻结点身份（经 `evidenceIdentityStamp` 复算）。 */
  identity(): { frozen: boolean; id: string };
  /** 带重试清理本场景产物根（R53.7）。 */
  cleanup(): void;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** 逻辑路径（`/` 分隔）→ 宿主机路径。 */
function hostPathOf(logicalPath: string): string {
  return resolveHostPath(logicalPath);
}

/** 产物根必须用 `/` 拼（`planArtifact` 的路径纪律），故另存一份正斜杠形态。 */
function toForwardSlashes(hostPath: string): string {
  return hostPath.split('\\').join('/');
}

/** 场景标签 → 单一目录名（不含路径分隔符 / `..`）。 */
function sanitizeLabel(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_');
  return cleaned.length === 0 ? 'scenario' : cleaned;
}

// ---------------------------------------------------------------------------
// 装配用的**只读身份快照**（模块级只算一次）
// ---------------------------------------------------------------------------
//
// `evidenceIdentityStamp()` / `evidenceOutputLocation()` 每次都要复算 `src/**` + `tests/**`
// 的**全部** `.ts` 摘要（实测单次 ≈ 1–2 s，`source-digest.ts` 无缓存）。而本文件原先在
// **每次** `buildOfficeScenario()` 的构造期各调一次——一个文件装 N 个场景就付 2N 遍全量复算。
// v6 一文件装 13 个场景 ⇒ 26 遍，占其总耗时的绝大部分（实测单场景装配 ≈ 4 s，其中内核装配
// 仅约 10 ms）。
//
// 可以缓存，因为该值对**默认根**只取决于冻结登记记录（`freezePoint()`，本身已是模块级缓存）
// 与摘要域内的文件内容；而本目录的验收测试**从不修改** `src/**` / `tests/**` 与四个配置清单
// （全部写入都落在 `mkdtempSync` 的临时目录或 `.dev-evidence/`，都不在摘要域内）。故在一次运行
// 之内它是**只读快照**，重复复算得到同一个结果。
//
// **判据一条未动**：取到的仍是同一复算结果，只是不再重复算同一份不变的输入。这与本目录
// `v6-fixture-audit` / `office-negative` / `p1-real-files` 三个文件在模块级缓存
// `EVIDENCE_DIR` 的做法同源，只是把它们各自的那次缓存上提到**唯一**的场景装配入口。
// 显式传 `root` 的调用（临时仓库夹具）不经过本文件，仍是每次真实复算。
const SCENARIO_STAMP = evidenceIdentityStamp();
/**
 * 同一份快照的落盘位置——由**上面已经算好的** `SCENARIO_STAMP` 取出，**不再**调
 * `evidenceOutputLocation()`（后者会在内部**再复算一遍**全量摘要，等于把同一份不变输入
 * 算两遍）。`evidenceOutputLocationFromStamp(evidenceIdentityStamp(...), ...)` 与
 * `evidenceOutputLocation(...)` 逐字段同源（后者就是前者），故取到的目录一字不差。
 *
 * 导出：同目录的 `v6-fixture-audit` / `p1-real-files` / `office-negative` 三个文件本就在
 * 模块级各算一次同样的位置（它们已经在缓存，只是没和本文件共享这次复算）。改为引用本常量后，
 * 一次运行内"整棵树只复算一次"而不改变任何取值。
 */
export const SCENARIO_EVIDENCE_DIR = evidenceOutputLocationFromStamp(SCENARIO_STAMP).absolute_dir;

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 同步退避（清理重试用；**不进入任何身份**，只影响等待时长）。 */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * 带重试删除一棵目录树（R53.7：Office 的 COM 关闭是**异步**的，刚 `Quit()` 完文件可能仍被占用，
 * `rmSync` 抛 `EBUSY`）。重试用尽 ⇒ **打印警告并保留目录**，**不抛错**。
 */
function removeTreeWithRetry(path: string, attempts = 6, delayMs = 250): { removed: boolean } {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return { removed: true };
    } catch (error) {
      if (attempt === attempts) {
        console.warn(
          `[office-support] 清理 ${path} 失败（已重试 ${String(attempts)} 次）：${describeError(error)}；` +
            '按 R53.7 保留目录，不据此判红。',
        );
        return { removed: false };
      }
      sleepSync(delayMs);
    }
  }
  return { removed: false };
}

// ---------------------------------------------------------------------------
// 夹具实现
// ---------------------------------------------------------------------------

class OfficeScenarioImpl implements OfficeScenario {
  readonly #label: string;
  readonly #clock = new LogicalClock();
  readonly #ids: IdSource = createIdSource();
  readonly #store: Store;
  readonly #scheduler: Scheduler;
  readonly #port: FsArtifactMaterializationPort;
  readonly #stamp = SCENARIO_STAMP;
  readonly #productsRoot: string;
  readonly #planRoot: string;
  /** 装配时经公开入口启动的轮次（其 `task_revision` 在启动时冻结——J9 可据此构造）。 */
  readonly #runId: RunId;
  readonly #marks: { readonly label: string; readonly step: LogicalTime }[] = [];
  readonly #readbacks = new Map<string, ReadbackResult>();
  #materialized = false;
  #cleaned = false;

  constructor(label: string) {
    this.#label = sanitizeLabel(label);
    const evidenceDir = SCENARIO_EVIDENCE_DIR;
    this.#productsRoot = join(evidenceDir, 'products', this.#label);
    this.#planRoot = toForwardSlashes(this.#productsRoot);

    this.#store = createMemoryStore({ clock: () => this.#clock.now() });

    // 场景前置状态（只写任务 / 实例 / 成员这类"开工前就有"的记录，不碰收件箱与工作项）。
    const at = this.#clock.now();
    this.#store.transact((tx) => {
      tx.putTask(
        createTaskRecord({
          task_id: OFFICE_TASK_ID,
          goal: '场景：产出真实可编辑办公文件（人数 / 金额 / 日期单一来源）',
          current_group_id: OFFICE_GROUP_ID,
          revision: OFFICE_TASK_REVISION,
          created_at: at,
          updated_at: at,
        }),
      );
      tx.putInstance(
        createInstanceState({
          instance_id: OFFICE_INSTANCE_ID,
          group_id: OFFICE_GROUP_ID,
          updated_at: at,
        }),
      );
      tx.putGroupMember(
        createGroupMember({
          group_id: OFFICE_GROUP_ID,
          instance_id: OFFICE_INSTANCE_ID,
          registered_at: at,
        }),
      );
    });

    // 真实落盘端口（R57：内核会随请求交来事务内构建的 `payload`，端口直接写它、不重建；
    // `build_bytes` 只是"payload 缺省"时**逐字节相同**的回退路径，两条路径不引入分叉）。
    this.#port = createFsArtifactMaterializationPort({
      read_revision: (taskId) => {
        const task = this.#store.snapshot().tasks.find((row) => row.task_id === taskId);
        return task === undefined ? null : task.revision;
      },
      now: () => this.#clock.now(),
      build_bytes: createTemplateBytesBuilder(OFFICE_TEMPLATE_INPUTS),
    });

    // 内核门面：注入**产物端口 + 产物根** ⇒ `finishRun` 会在提交之后自动发布（R56.2）。
    this.#scheduler = createScheduler(this.#store, {
      idSource: this.#ids,
      clock: () => this.#clock.now(),
      default_task_id: OFFICE_TASK_ID,
      artifacts: { port: this.#port },
      artifact_root_dir: this.#planRoot,
    });

    // 经**公开入口**建立可运行输入与轮次：工作请求 × 3 → 启动一个轮次。
    // 轮次在此刻冻结任务版本；共享事实由测试用例随后经 `registerFact()` 登记，在收尾时才被读取。
    for (const kind of TEMPLATE_KINDS) {
      const delivered = this.#scheduler.onMessage(workRequestFor(kind, this.#ids));
      if (delivered.result !== 'accepted') {
        throw new Error(
          `[office-support] 场景装配失败：${kind} 的工作请求未被接受（result=${delivered.result}）`,
        );
      }
    }
    const started = this.#scheduler.startRun({ instance_id: OFFICE_INSTANCE_ID });
    if (!started.started || started.run === null) {
      throw new Error(
        `[office-support] 场景装配失败：轮次未启动（reason=${started.reason ?? 'unknown'}）`,
      );
    }
    this.#runId = started.run.run_id;
  }

  // --- 只读面 ---------------------------------------------------------------

  get store(): Store {
    return this.#store;
  }

  get scheduler(): Scheduler {
    return this.#scheduler;
  }

  root(): string {
    return this.#productsRoot;
  }

  snapshot(): StoreSnapshot {
    return this.#scheduler.snapshot();
  }

  artifacts(): readonly ArtifactRecord[] {
    return snapshotArtifacts(this.#store.snapshot());
  }

  artifactOf(id: ArtifactRef): ArtifactRecord | undefined {
    return this.artifacts().find((record) => record.artifact_id === id);
  }

  materializeCalls(): number {
    return this.#port.calls;
  }

  runFileOf(record: ArtifactRecord): string {
    if (!isDeliveredArtifact(record) || record.receipt === null) {
      throw new Error(
        `产物 ${record.artifact_id} 尚未交付（status=${record.status}，无回执）：` +
          'R47.3 的读侧约定下，未 published 的记录不得当作已交付，也没有可运行的文件路径',
      );
    }
    return hostPathOf(record.receipt.final_path);
  }

  readback(path: string): ReadbackResult {
    const absolute = hostPathOf(path);
    const cached = this.#readbacks.get(absolute);
    if (cached !== undefined) return cached;
    const result = readbackArtifact(requireToolchain(), absolute);
    this.#readbacks.set(absolute, result);
    return result;
  }

  identity(): { frozen: boolean; id: string } {
    return Object.freeze({ frozen: this.#stamp.frozen, id: this.#stamp.id });
  }

  // --- 写入面（经被测内核公开入口）------------------------------------------

  mark(label: string): void {
    const step = this.#clock.advance(1, label);
    this.#marks.push(Object.freeze({ label, step }));
  }

  registerFact(fact: SharedFactRecord): void {
    this.#store.transact((tx) => {
      tx.putSharedFact(fact);
    });
  }

  /**
   * **放行口**：调 `finishRun`，把三类产物的完成发布交给内核。
   *
   * 每条发布携带 `artifact: { intent, fact_keys }`：内核在同一事务里暂存 `staged` 记录，
   * 并在**提交之后**经注入的发布投影自动发布（R56.1 / R56.2）。夹具**不写任何记录**
   * ——`materializeAll()` 之前之后，存储里的产物记录全部来自内核。
   *
   * 幂等：已放行过则直接返回（`finishRun` 对已结束的轮次只会得到 `run_not_active`，
   * 不会重复物化；这里提前短路以保持与旧实现一致的"重复调用端口调用数不增"）。
   */
  materializeAll(): void {
    if (this.#materialized) return;
    const at = asLogicalTime(this.#clock.now());
    const publications = TEMPLATE_KINDS.map((kind) => ({
      kind: 'completed' as const,
      request_id: WORK_REQUEST_IDS[kind],
      // 给出产物意图后，`result_refs` 会被内核产出的产物 id 覆盖（R56 第 3 条）——
      // 这里给空数组，正是"Agent 不能自称产出了什么"的形态。
      result_refs: [] as readonly ArtifactRef[],
      artifact: artifactIntentFor(kind),
    }));
    this.#scheduler.finishRun({ run_id: this.#runId, at, publications });
    this.#materialized = true;
  }

  cleanup(): void {
    if (this.#cleaned) return;
    this.#cleaned = true;
    // ① 先登记（R52.2 / R61 第 3 条）：sha256 / 字节长度 / 条目数 / 独立读回结论逐份进证据报告。
    //    无论正式还是开发身份，证据报告一律经 writeEvidenceArtifacts 落盘（R52.1 不变）。
    this.#writeEvidenceRegistry();
    // ② 再**按身份**决定清理（R61 第 2 / 4 条：先读身份再决定删不删，**不得无条件删**）。
    //
    // **R61 第 2 条两条分支**：
    // - **正式身份（`frozen: true`）** ⇒ **保留**产物字节、不删。这些字节是 P1 的证据本身
    //   （其 sha256 已登记进上面的证据报告）——删了就等于只剩"声称产出过"。
    // - **开发身份（`DEV-UNFROZEN`）** ⇒ 删除产物根（R53.7 的重试纪律；重试用尽告警不判红）。
    //   `.dev-evidence/` 已 gitignore，留着只是垃圾。
    //
    // R61 第 1 条的落点（R52.2 的 `products/`）不变。本分支即 **R61 第 2 条**：
    // 正式身份保留产物字节（开发者身份才删除），同时保持 `OfficeScenario` 的成员签名不变。
    const identity = this.identity();
    if (identity.frozen) {
      console.warn(
        `[office-support] 正式身份 ${identity.id}：按 R61 第 2 条保留产物字节` +
          `（它们是 P1 的证据本身，sha256 已登记在证据报告里），产物保留在 ${this.#productsRoot}`,
      );
      return;
    }
    removeTreeWithRetry(this.#productsRoot);
  }

  // --- 证据登记 -------------------------------------------------------------

  #writeEvidenceRegistry(): void {
    const products = this.artifacts().map((record) => this.#describeProduct(record));
    const payload = {
      schema: 'office-scenario-products.v1',
      task: 'D02A-WFIX1',
      scenario: this.#label,
      task_id: String(OFFICE_TASK_ID),
      task_revision: OFFICE_TASK_REVISION,
      logical_steps: this.#marks.map((entry) => ({ label: entry.label, step: entry.step })),
      root_dir: this.#productsRoot,
      materialization_calls: this.materializeCalls(),
      products,
      // 产物结局**从记录派生**（改造后夹具不再持有投影结局对象：发布由内核的提交后投影完成）。
      outcomes: this.artifacts().map((record) => ({
        kind: record.status,
        artifact_id: String(record.artifact_id),
        status: record.status,
        failure_kind: record.failure_kind,
        detail:
          record.receipt === null
            ? `未发布（${record.failure_kind ?? '尚无结局'}）`
            : `已发布：${record.receipt.final_path}（回读摘要 ${record.receipt.readback_digest}）`,
      })),
      note:
        '产物字节是被测对象，不是证据（R52.2）；本节逐份登记其 sha256 / 字节长度 / 条目数 / ' +
        '独立读回结论。第 3 层（目标软件可打开）由 office-open-check.ts 单独取证。',
    };
    try {
      // `stamp`：复用本场景构造期就取到的**只读身份快照**（`#stamp === SCENARIO_STAMP`）——
      // 不再在每个场景的 `cleanup()` 里各复算一遍全量摘要。取到的 identity 与现算逐字段相同
      // （同一摘要域、同一时刻），落盘所在目录也相同；正式身份的发布闸门仍独立重算，不受影响。
      const outcome = writeEvidenceArtifacts((identity) => [
        {
          file_name: `office-products-${this.#label}.json`,
          content: `${JSON.stringify({ identity, ...payload }, null, 2)}\n`,
        },
      ], { stamp: this.#stamp });
      void outcome;
    } catch (error) {
      // 证据登记失败**不得**把清理（乃至一个通过的用例）判红，但必须**可见**——不静默吞掉。
      console.warn(
        `[office-support] 场景 ${this.#label} 的产物摘要登记失败：${describeError(error)}；` +
          '产物仍在，但证据报告里没有本次登记（R52.1）。',
      );
    }
  }

  #describeProduct(record: ArtifactRecord): Record<string, unknown> {
    const delivered = isDeliveredArtifact(record);
    const finalPath = record.receipt === null ? null : hostPathOf(record.receipt.final_path);
    const receipt = this.#port.receiptOf(record.artifact_id);

    let sha256 = receipt?.readback_digest ?? null;
    let byteLength = receipt?.byte_length ?? null;
    let entryCount = receipt?.entry_count ?? null;
    if (delivered && finalPath !== null && existsSync(finalPath) && (sha256 === null || entryCount === null)) {
      // 端口实例之外的幂等命中（跨实例）时没有 memo：从**实际字节**补，绝不编造。
      try {
        const bytes = readFileSync(finalPath);
        sha256 = sha256Hex(bytes);
        byteLength = bytes.byteLength;
        entryCount = selfCheckArtifactBytes(bytes).entry_count;
      } catch (error) {
        console.warn(
          `[office-support] 登记 ${record.artifact_id} 时无法读回 ${finalPath}：${describeError(error)}`,
        );
      }
    }

    const readback = finalPath === null ? undefined : this.#readbacks.get(finalPath);
    return {
      artifact_id: String(record.artifact_id),
      template_kind: record.template_kind,
      task_revision: record.task_revision,
      artifact_version: record.artifact_version,
      status: record.status,
      delivered,
      final_path: record.receipt === null ? null : record.receipt.final_path,
      sha256,
      byte_length: byteLength,
      entry_count: entryCount,
      source_fact_refs: record.source_fact_refs.map(String),
      failure_kind: record.failure_kind,
      independent_readback:
        readback === undefined
          ? { status: 'not_run', detail: '本场景未调用 readback()（第 3 层由 office-open-check.ts 另测）' }
          : {
              status: readback.ok ? 'ok' : 'failed',
              path: readback.path,
              bad_entry: readback.bad_entry,
              xml_problems: readback.xml_problems.length,
              unzip_exit_code: readback.unzip_test.exit_code,
              python: `${readback.python.via} → ${readback.python.executable} (${readback.python.version})`,
              unzip: `${readback.unzip.via} → ${readback.unzip.executable}`,
            },
    };
  }
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

/**
 * 建一个办公产物场景。
 *
 * @param label 场景标签（同时是产物根下的目录名）。**同一 label 共用一个产物根**，
 *   因此不同用例应使用不同标签。
 */
export function buildOfficeScenario(label: string): OfficeScenario {
  return new OfficeScenarioImpl(label);
}

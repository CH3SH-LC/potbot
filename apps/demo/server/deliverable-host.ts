/**
 * **交付会话宿主**（design-06 P8/P9 的产品入口；合同 R232 / R247 / R250）。
 *
 * ## 这一层把"三种办公格式的交付会话"接到**内核的真实发布链**上
 *
 * 与 `session-host.ts`（字处理链）**同一套发布纪律**，只是 `template_kind` 不再是常量
 * `'document'`，而是由会话自己的文件格式派生——因此表格与演示经**同一条**
 * "暂存 → 物化 → 版本闸门 → 原子发布 → 回读"链路交付：
 *
 * ```text
 * ① 会话在内核存储里有一个**真实任务**（TaskRecord），任务版本由内核自己的
 *    `applyTaskPatch`（deliverables 变更 = 实质性）递增 —— `taskRevision` 的来源。
 * ② 产物在内核存储里落一条 `staged` 记录（`planArtifact` 按 template_kind 派生
 *    id / 版本化路径 / 扩展名 / MIME；`resolveNextArtifactVersion` 派生 artifactVersion）。
 * ③ 字节由宿主先写盘并回读（生产物化端口），再把"确实发生过的写盘与回读"装进同步记忆端口。
 * ④ 发布投影（与生成链**同一个** `createArtifactPublicationProjection`）跑版本闸门 →
 *    写 `published` + 回执 + `artifact_published` 内核事件。
 * ⑤ 回执里的 `readback_digest` 来自**对最终路径的实际回读**（I-1）。
 * ```
 *
 * **没有 `fs.writeFile` 后直接宣称保存成功的路径**：写盘只在物化端口里发生，
 * 而"保存成功"只由内核发布的 `published` 记录回答（`isDeliveredArtifact`）。
 *
 * ## 诚实边界
 *
 * - **落盘与重开**（FA-DELIVERABLE-RESTART）：会话状态由 `SessionPersistence` 落盘，
 *   内核记录由宿主**注入的 `Store`** 承载——生产接线（`main.ts` 的 `createDeliverableHost`）
 *   把它接到**主内核的落盘存储**上（与连续对话宿主共用同一份真相源，不另开账本）。
 *   于是重启后：`restorePersistedSession()` 从落盘状态重开会话（R216），内核任务被**重新登记**
 *   （共享 store 里本来就在则原样复用，版本号因此连续），**产物字节与版本历史都读得回来**。
 * - 恢复的判据与字处理链同口径：**磁盘文件存在 ≠ 重开成功**——读回、解码、重建会话、
 *   重新导出核对摘要、重新登记内核任务，任一步不成立都以具体原因失败（不猜默认值）。
 * - 只读访问器（`status` / `versionBytes` / `completionOf`）带**惰性恢复**：会话不在内存里时
 *   先尝试重开一次，失败则**什么都不改**，读不到的会话仍然如实 404。
 * - 本宿主**不接线网页**：产品入口目前是 HTTP（`/api/deliverables/**`）。
 * - **起始字节必被吸收或被具名拒绝**（FA-DELIVERABLE-INPUT-BYTES）：开会话时给了 `bytes`
 *   就走**导入链**（`DeliverableSession.importBytes`）真吸收；字节不是该格式的合法文件时
 *   以 `import_failed` 具名失败，**绝不**静默丢弃、退回空白源（那是"假成功"）。
 *   不给 `bytes` 才建空白源——行为与接线前逐字一致。
 */

import { createHash } from 'node:crypto';

import {
  applyTaskPatch,
  asFactRef,
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asTaskId,
  createArtifactRecord,
  createGroupMember,
  createIdSource,
  createInstanceState,
  createSharedFactRecord,
  createTaskPatch,
  createTaskRecord,
  createWorkItem,
  isDeliveredArtifact,
  asArtifactRef,
  asRequestId,
  type ArtifactRecord,
  type GroupId,
  type IdSource,
  type InstanceId,
  type LogicalTime,
  type RequestId,
  type Revision,
  type Store,
  type TaskId,
  type TaskRecord,
  type WorkItem,
} from '../../../src/protocol/index.js';
import { createMemoryStore, logicalTimeHighWater } from '../../../src/storage/index.js';
import { LogicalClock } from '../../../src/clock/index.js';
import {
  createArtifactPublicationProjection,
  digestBytes,
  materializationFailure,
  materializationSuccess,
  planArtifact,
  resolveNextArtifactVersion,
  selfCheckArtifactBytes,
  type ArtifactMaterializationPort,
  type ArtifactMaterializationReceipt,
  type ArtifactMaterializationRequest,
  type ArtifactMaterializationResult,
  type ArtifactPlan,
  type KnownFactSnapshotEntry,
  type StagedArtifactFact,
} from '../../../src/artifacts/index.js';
import { normalizeOfficeFilename, type DocumentPort } from '../documents/port.js';
import type { TemplateKind } from '../../../src/protocol/index.js';
import {
  DeliverableSession,
  emptyPresentationSource,
  emptyWorkbook,
  formatSpec,
  pptxDeliverableAdapter,
  xlsxDeliverableAdapter,
  type DeliverablePublishPort,
  type DeliverablePublishRequest,
  type DeliverablePublishResult,
  type DeliverableSessionState,
  type DeliverableStatusView,
  type FileFormat,
  type PptxDeliverableSource,
  type PublishedVersion,
  type PublishInput,
  type PublishSubmission,
  type SessionFailure,
  type SessionPersistence,
  type SessionResult,
  type XlsxDeliverableSource,
} from '../../../src/session/index.js';
import { publicationEventHooks } from './kernel.js';
import { taskCompletionOf, type TaskCompletionView } from './task-completion.js';
// 交付尝试的工作记录走**真实**工作项状态机（`src/workledger`）：终态是吸收态，
// 迟到的结局会被 `terminal_locked` 拒绝——那正是"取消后迟到结果不得变成功"的落点。
import { WorkLedgerError, applyWorkItemTransition } from '../../../src/workledger/index.js';

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

/** 交付会话任务 id 的前缀（与生成链 `T-<hex>`、字处理链 `T-doc-` 分开）。 */
export const DELIVERABLE_TASK_PREFIX = 'T-del-';

/** 会话数量上限（超限**结构化拒绝**；不静默淘汰）。 */
export const DEFAULT_MAX_DELIVERABLES = 64;

export interface DeliverableHostOptions {
  /** 生产物化端口。**未接入即拒绝发布**，绝不退化成直接写文件。 */
  readonly documents: DocumentPort | null;
  /** 内核路径规划的产物根（`/` 分隔）。 */
  readonly artifact_root_dir: string;
  readonly run_id: string;
  readonly max_sessions?: number;
  readonly now?: () => Date;
  readonly session_persistence?: (sessionId: string) => SessionPersistence;
  /**
   * 内核存储（加法；FA-DELIVERABLE-RESTART）。
   *
   * 省略 ⇒ 与接线前**逐字一致**：一个进程内的 `createMemoryStore`（单进程 / 测试用）。
   * 生产接线传入**主内核的落盘存储**（`KernelHost.store`）：交付任务 / 产物 / 工作项因此
   * 与内核其余记录**同一份真相源**、同一份落盘文件，重启后读得回来。
   *
   * 选型纪律：需要跨重启语义的地方**不得**用内存实现冒充（`src/storage/index.ts` 的同一句话）。
   */
  readonly store?: Store;
}

/**
 * 宿主实际持有的会话（**非泛型**：宿主不关心源的类型，只走公开生命周期接口）。
 *
 * `DeliverableSession<S>` 对这些方法**不出现 `S`**，因此任一 `S` 的实例都结构化地满足它；
 * 宿主因此不必为三种格式各写一套注册表，也不必在类型上假装自己知道源是什么。
 */
interface HostedSession {
  readonly id: string;
  readonly filename: string;
  status(): DeliverableStatusView;
  publish(input: PublishInput): Promise<SessionResult<PublishSubmission>>;
  publishedAt(revision: number): PublishedVersion | null;
  publishedVersions(): readonly PublishedVersion[];
}

interface SessionEntry {
  readonly session: HostedSession;
  readonly kernel_task_id: TaskId;
  readonly group_id: GroupId;
  readonly instance_id: InstanceId;
  readonly source_fact_ref: string;
  readonly file_format: FileFormat;
  readonly template_kind: TemplateKind;
}

export interface OpenDeliverableView {
  readonly session_id: string;
  readonly deliverable_id: string;
  readonly filename: string;
  readonly file_format: FileFormat;
  readonly template_kind: TemplateKind;
  readonly kernel_task_id: string;
  readonly edit_revision: number;
  readonly content_digest: string;
}

export interface DeliverableVersionBytes {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly artifact_id: string;
  readonly content_digest: string;
  readonly file_format: FileFormat;
  readonly mime_type: string;
  readonly template_kind: TemplateKind;
}

/** 开会话的通用入参（三种格式共用；格式决定用哪个适配器）。 */
export interface OpenDeliverableInput {
  readonly session_id: string;
  readonly deliverable_id: string;
  readonly filename: string;
  readonly format: FileFormat;
  /** 起始源（不传 = 用该格式的空白源）。 */
  readonly source?: XlsxDeliverableSource | PptxDeliverableSource;
  /** 起始字节（导入；与 `source` 二选一）。 */
  readonly bytes?: Uint8Array;
  /** 空白源的名字 / 标题（`source` 与 `bytes` 都省略时用）。 */
  readonly title?: string;
}

/** 源事实的键（产物记录要求 `source_fact_refs` 非空）。 */
export const DELIVERABLE_SOURCE_FACT_KEY = 'deliverable.source';

/**
 * 一次交付尝试的**结局**形状（只保留记账要用的两位信息）。
 *
 * 为什么不直接用 `SessionResult<PublishSubmission>`：成功分支里没有 `code`/`message`，
 * 而"落一条失败工作项"只需要"成没成 + 为什么不成"。抽成独立形状后，
 * "交付自身抛出"这种非结构化失败也能走同一条收工路径。
 */
type DeliveryOutcome =
  | { readonly ok: true; readonly result_refs: readonly string[] }
  | { readonly ok: false; readonly failure: { readonly code: string; readonly message: string } };

/**
 * 事务包装把**错因**放进了 `cause`（`PersistenceError('事务回滚…', { cause })`），
 * 所以 `instanceof WorkLedgerError` 在事务外**认不出来**——必须顺因果链找。
 *
 * 只认 `terminal_locked` 这一种：它是"终态不可被迟到结果改写"的**预期**拒绝
 * （取消不可复活 / 已完成不可回退）。其它错一律不吞。
 */
function isTerminalLocked(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current instanceof WorkLedgerError && current.reason === 'terminal_locked') {
      return true;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}

function deliveryOutcomeOf(result: SessionResult<PublishSubmission>): DeliveryOutcome {
  if (!result.ok) {
    return { ok: false, failure: { code: result.code, message: result.message } };
  }
  // 交付的**结果**就是这一版产物：没有它就没有"结果引用"，
  // 而工作项状态机不允许在没有结果引用的情况下转 `completed`（P4-10 / A03-10）。
  const published = result.value.published;
  return { ok: true, result_refs: published === null ? [] : [String(published.artifact_id)] };
}

interface SourceFactHolder {
  entry: KnownFactSnapshotEntry | null;
}

// ---------------------------------------------------------------------------
// 宿主
// ---------------------------------------------------------------------------

export class DeliverableHost {
  readonly #options: DeliverableHostOptions;
  readonly #documents: DocumentPort | null;
  readonly #store: Store;
  readonly #ids: IdSource;
  readonly #clock = new LogicalClock();
  readonly #now: () => Date;
  readonly #maxSessions: number;
  readonly #entries = new Map<string, SessionEntry>();

  constructor(options: DeliverableHostOptions) {
    this.#options = options;
    this.#documents = options.documents;
    // 先定存储，再定时钟：时钟的**起步点**取决于已持久化状态的最大逻辑时间（R203）。
    // 与 `KernelHost` 同一套纪律——重启后若时钟倒流，"重启前签发的租约"会重新变成
    // "未过期"，那正是把已作废的租约复活。共享 store 时这一点尤其重要（两份记录混在同一份文件里）。
    this.#store = options.store ?? createMemoryStore({ clock: () => this.#clock.now() });
    const highWater = logicalTimeHighWater(this.#store.snapshot());
    if (highWater > 0) {
      this.#clock.advanceTo(asLogicalTime(highWater), '重启续期：对齐已持久化的最大逻辑时间（R203）');
    }
    this.#ids = createIdSource();
    this.#now = options.now ?? ((): Date => new Date());
    this.#maxSessions = options.max_sessions ?? DEFAULT_MAX_DELIVERABLES;
  }

  /** 内核侧的会话任务 id（确定性派生，无计数器、无随机）。 */
  static taskIdOf(sessionId: string): TaskId {
    const digest = createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 16);
    return asTaskId(`${DELIVERABLE_TASK_PREFIX}${digest}`);
  }

  /**
   * 交付尝试的工作项 id（确定性派生，无计数器、无随机）。
   *
   * 键是 **(会话, 幂等键)**：同一次交付尝试永远映射到同一条工作记录，
   * 因此重放**不会**多出第二条工作项，也不会把已终态的记录复活（R207 的幂等精神）。
   */
  static workItemIdOf(sessionId: string, idempotencyKey: string): RequestId {
    const digest = createHash('sha256')
      .update(`deliverable-work\u0000${sessionId}\u0000${idempotencyKey}`, 'utf8')
      .digest('hex')
      .slice(0, 16);
    return asRequestId(`W-del-${digest}`);
  }

  /**
   * 内存里**已装载**的会话 id（恢复是**惰性**的：落盘里还有、但还没被读到的会话
   * 不在这里。本方法是"宿主此刻手上有哪些"，不是"运行目录里有哪些"）。
   */
  sessionIds(): readonly string[] {
    return Object.freeze([...this.#entries.keys()]);
  }

  /** 内存里是否已装载该会话（**不做**落盘恢复；`status()` 那条路才会）。 */
  has(sessionId: string): boolean {
    return this.#entries.has(sessionId);
  }

  status(sessionId: string): DeliverableStatusView | undefined {
    return this.#entryFor(sessionId)?.session.status();
  }

  fileFormatOf(sessionId: string): FileFormat | undefined {
    return this.#entryFor(sessionId)?.file_format;
  }

  /** 内核里的产物记录（只读旁证；证据用）。 */
  kernelArtifact(artifactId: string): ArtifactRecord | undefined {
    return this.#store.snapshot().artifacts.find((record) => String(record.artifact_id) === artifactId);
  }

  kernelArtifactList(): readonly ArtifactRecord[] {
    return this.#store.snapshot().artifacts;
  }

  kernelTask(sessionId: string): TaskRecord | undefined {
    return this.#store
      .snapshot()
      .tasks.find((task) => task.task_id === DeliverableHost.taskIdOf(sessionId));
  }

  /**
   * 会话对应内核任务的**任务级完成口径**派生视图（contract 附五 R261–R263）。
   *
   * **只读**：没有配套的写口——完成是从工作项 / 轮次 / 动作三个集合**算出来**的，
   * 任何入口都不能"把交付会话置为完成"。会话不存在（或还没登记内核任务）时返回 `undefined`。
   *
   * 时间取本宿主自己的**逻辑**钟：判据 ② 要判轮次租约是否过期，而租约用逻辑时间。
   */
  completionOf(sessionId: string): TaskCompletionView | undefined {
    if (this.#entryFor(sessionId) === undefined) return undefined;
    return taskCompletionOf(this.#store, String(DeliverableHost.taskIdOf(sessionId)), this.#clock.now());
  }

  // --- 开会话 -------------------------------------------------------------

  /**
   * 打开一个交付会话（新建 / 导入 / 空白源）。
   *
   * 同时在内核存储里登记任务 / 实例 / 群成员 / **来源事实**——产物记录要求
   * `source_fact_refs` 非空（"这个产物依据什么"必须可追溯），所以这一步不是可选装饰。
   */
  open(input: OpenDeliverableInput): SessionResult<OpenDeliverableView> {
    if (this.#entries.has(input.session_id)) {
      return failSession('session_already_exists', `会话 ${input.session_id} 已存在`, input.session_id);
    }
    if (this.#entries.size >= this.#maxSessions) {
      return failSession(
        'session_limit_reached',
        `交付会话数已达上限 ${String(this.#maxSessions)}`,
        input.session_id,
      );
    }
    const spec = formatSpec(input.format);
    const taskId = DeliverableHost.taskIdOf(input.session_id);
    const key = taskId.replace(/^T-del-/, '').slice(0, 12);
    const groupId = asGroupId(`G-del-${key}`);
    const instanceId = asInstanceId(`I-del-${key}`);
    const sourceFactRef = asFactRef(`fact-del-${key}-source`);

    const holder: SourceFactHolder = { entry: null };
    const commonOptions = {
      id: input.session_id,
      deliverable_id: input.deliverable_id,
      filename: input.filename,
      persistence: this.#persistenceFor(input.session_id),
      publish_port: this.#publishPortFor(input.session_id, taskId, instanceId, holder),
      now: this.#now,
    } as const;

    const opened = this.#openWith(input, commonOptions);
    if (!opened.ok) return opened;

    holder.entry = this.#registerKernelTask({
      taskId,
      groupId,
      instanceId,
      sourceFactRef,
      sessionId: input.session_id,
      deliverableId: input.deliverable_id,
      fileName: input.filename,
      templateKind: spec.template_kind,
      format: input.format,
    });

    this.#entries.set(input.session_id, {
      session: opened.value.session,
      kernel_task_id: taskId,
      group_id: groupId,
      instance_id: instanceId,
      source_fact_ref: String(sourceFactRef),
      file_format: input.format,
      template_kind: spec.template_kind,
    });

    return {
      ok: true,
      value: Object.freeze({
        session_id: input.session_id,
        deliverable_id: input.deliverable_id,
        filename: input.filename,
        file_format: input.format,
        template_kind: spec.template_kind,
        kernel_task_id: String(taskId),
        edit_revision: opened.value.edit_revision,
        content_digest: opened.value.content_digest,
      }),
    };
  }

  #openWith(
    input: OpenDeliverableInput,
    commonOptions: {
      readonly id: string;
      readonly deliverable_id: string;
      readonly filename: string;
      readonly persistence: SessionPersistence;
      readonly publish_port: DeliverablePublishPort;
      readonly now: () => Date;
    },
  ): SessionResult<{ readonly session: HostedSession; readonly edit_revision: number; readonly content_digest: string }> {
    // 起始源**三选一**：`bytes`（导入）/ `source`（直接给源）/ 都省略（空白源）。
    // `bytes` 与 `source` 同时给 ⇒ 来源不明确：**具名拒绝**，不挑一个静默用另一个
    // （"静默丢弃调用方给的东西"正是 FA-DELIVERABLE-INPUT-BYTES 要堵的那类假成功）。
    if (input.bytes !== undefined && input.source !== undefined) {
      return failSession(
        'unsupported',
        '起始源二选一：bytes（导入字节）与 source（直接给源）不得同时提供',
        input.session_id,
      );
    }
    switch (input.format) {
      case 'xlsx': {
        // 有字节 ⇒ **真吸收**：走既有导入链（`DeliverableSession.importBytes`）。
        // 导入失败（不是合法 xlsx / 是别格式的字节）⇒ `import_failed` 具名失败，
        // **绝不**退化成"悄悄建一份空白源然后把调用方的字节丢掉"。
        if (input.bytes !== undefined) {
          const imported = DeliverableSession.importBytes(
            { ...commonOptions, adapter: xlsxDeliverableAdapter },
            input.bytes,
          );
          return toOpenView(imported);
        }
        // 空白表格的起始表名固定为 Excel 自己的约定名 `Sheet1`：
        // 表名是**内容**（会进 `xl/workbook.xml`），不能由"交付物标题"顺带决定——
        // 否则调用方给一个中文标题就会让后续 `set_cell(sheet:'Sheet1')` 静默找不到表。
        // 想改名字/加表，走编辑操作（`rename_sheet` / `add_sheet`）。
        void input.title;
        const session = DeliverableSession.createNew(
          { ...commonOptions, adapter: xlsxDeliverableAdapter },
          input.source ?? emptyXlsxSource('Sheet1'),
        );
        return toOpenView(session);
      }
      case 'pptx': {
        // 同 xlsx：有字节就真吸收，失败即具名拒绝。
        if (input.bytes !== undefined) {
          const imported = DeliverableSession.importBytes(
            { ...commonOptions, adapter: pptxDeliverableAdapter },
            input.bytes,
          );
          return toOpenView(imported);
        }
        const session = DeliverableSession.createNew(
          { ...commonOptions, adapter: pptxDeliverableAdapter },
          input.source ?? emptyPptxSource(input.deliverable_id, input.title ?? '演示文稿'),
        );
        return toOpenView(session);
      }
      case 'docx':
        // 字处理链由 `/api/sessions/**` 提供（带段落 / 节 / 列表语义）。本宿主**不**重复实现它：
        // 在这里明确拒绝，而不是给一个"能建会话但编辑语义缺失"的半成品入口。
        return failSession(
          'unsupported',
          'docx 请走文档会话入口（/api/sessions）：本入口本轮只交付表格与演示。' +
            '刻意不在此处开一条"同名不同能力"的 Word 通道',
          input.session_id,
        );
      default:
        return failSession('unsupported', `不支持的文件格式 ${String(input.format)}`, input.session_id);
    }
  }

  // --- 重开落盘的会话 -----------------------------------------------------

  /**
   * 只读访问器共用的**惰性恢复**：会话不在内存里时先尝试从落盘状态重开一次。
   *
   * 为什么放在宿主内部而不是某一条路由里：恢复是"**这个会话还在不在**"的语义，
   * 不是 HTTP 的实现细节——任何消费者（HTTP / 将来的网页面）都该得到同一条答案。
   * 恢复失败时本方法**什么都不改**（`#entries` 不变），于是读不到的会话仍然如实 404：
   * 恢复逻辑不会把"没有"变成"什么都能开"。
   */
  #entryFor(sessionId: string): SessionEntry | undefined {
    const existing = this.#entries.get(sessionId);
    if (existing !== undefined) return existing;
    this.restorePersistedSession(sessionId);
    return this.#entries.get(sessionId);
  }

  /**
   * 按**落盘状态**恢复一个交付会话（R216「保存并重新打开」的交付侧）。
   *
   * 与字处理链的 `restorePersistedSession` **同一套判据形状**：磁盘文件存在 ≠ 重开成功——
   * 只有真的读回、解码、重建会话（并重新导出核对摘要）、重新登记内核任务之后才返回
   * `ok: true`；任何一步不成立都以**具体原因**失败。
   *
   * 文件名 / 交付物 id / 文件格式都从落盘状态里读，调用方不必先知道它们；但**不猜**：
   * 缺一个就以具体原因失败——猜一个默认名替它会把"恢复成功"伪装出来。
   *
   * 内核任务被**重新登记**：共享 store 里本来就在则原样复用（版本号因此连续，不会推倒重来）。
   */
  restorePersistedSession(sessionId: string): SessionResult<OpenDeliverableView> {
    if (this.#entries.has(sessionId)) {
      return failSession('session_already_exists', `会话 ${sessionId} 已在内存中`, sessionId);
    }
    const persistence = this.#persistenceFor(sessionId);
    let raw: unknown;
    try {
      raw = persistence.load();
    } catch (error) {
      return failSession('session_not_found', `读取交付会话 ${sessionId} 的落盘状态失败：${describe(error)}`, sessionId);
    }
    if (raw === null || raw === undefined) {
      return failSession('session_not_found', `运行目录里没有交付会话 ${sessionId} 的落盘状态`, sessionId);
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return failSession('session_not_found', `交付会话 ${sessionId} 的落盘状态形状不合法（不是对象）`, sessionId);
    }
    const record = raw as Record<string, unknown>;
    // 格式决定了用哪个适配器重建会话：**只能**从落盘状态里读，不从调用方猜。
    const format = record['file_format'];
    if (format !== 'xlsx' && format !== 'pptx') {
      return failSession(
        'session_not_found',
        `交付会话 ${sessionId} 的落盘状态没有可用的文件格式（${String(format)}），无法安全重开`,
        sessionId,
      );
    }
    const deliverableId = record['deliverable_id'];
    if (typeof deliverableId !== 'string' || deliverableId.trim().length === 0) {
      return failSession(
        'session_not_found',
        `交付会话 ${sessionId} 的落盘状态里没有可用的 deliverable_id，无法安全重开`,
        sessionId,
      );
    }
    const filename = record['filename'];
    if (typeof filename !== 'string' || filename.trim().length === 0) {
      return failSession(
        'session_not_found',
        `交付会话 ${sessionId} 的落盘状态里没有可用的 filename，无法安全重开`,
        sessionId,
      );
    }

    const spec = formatSpec(format);
    const taskId = DeliverableHost.taskIdOf(sessionId);
    const key = taskId.replace(/^T-del-/, '').slice(0, 12);
    const groupId = asGroupId(`G-del-${key}`);
    const instanceId = asInstanceId(`I-del-${key}`);
    const sourceFactRef = asFactRef(`fact-del-${key}-source`);

    const holder: SourceFactHolder = { entry: null };
    const restored = this.#restoreSessionWith(format, {
      id: sessionId,
      deliverable_id: deliverableId,
      filename,
      persistence,
      publish_port: this.#publishPortFor(sessionId, taskId, instanceId, holder),
      now: this.#now,
    });
    if (!restored.ok) return restored;

    holder.entry = this.#registerKernelTask({
      taskId,
      groupId,
      instanceId,
      sourceFactRef,
      sessionId,
      deliverableId,
      fileName: filename,
      templateKind: spec.template_kind,
      format,
    });

    this.#entries.set(sessionId, {
      session: restored.value.session,
      kernel_task_id: taskId,
      group_id: groupId,
      instance_id: instanceId,
      source_fact_ref: String(sourceFactRef),
      file_format: format,
      template_kind: spec.template_kind,
    });

    return {
      ok: true,
      value: Object.freeze({
        session_id: sessionId,
        deliverable_id: deliverableId,
        filename,
        file_format: format,
        template_kind: spec.template_kind,
        kernel_task_id: String(taskId),
        edit_revision: restored.value.edit_revision,
        content_digest: restored.value.content_digest,
      }),
    };
  }

  /** 按格式选适配器重建会话（与 `#openWith` 的同一张表；这里只有"重开"一条路）。 */
  #restoreSessionWith(
    format: FileFormat,
    commonOptions: {
      readonly id: string;
      readonly deliverable_id: string;
      readonly filename: string;
      readonly persistence: SessionPersistence;
      readonly publish_port: DeliverablePublishPort;
      readonly now: () => Date;
    },
  ): SessionResult<{ readonly session: HostedSession; readonly edit_revision: number; readonly content_digest: string }> {
    switch (format) {
      case 'xlsx': {
        const restored = DeliverableSession.restore({ ...commonOptions, adapter: xlsxDeliverableAdapter });
        if (restored.session === null) {
          return failSession('session_not_found', `读回交付会话失败：${restored.result.reason}`, commonOptions.id);
        }
        return { ok: true, value: sessionViewOf(restored.session) };
      }
      case 'pptx': {
        const restored = DeliverableSession.restore({ ...commonOptions, adapter: pptxDeliverableAdapter });
        if (restored.session === null) {
          return failSession('session_not_found', `读回交付会话失败：${restored.result.reason}`, commonOptions.id);
        }
        return { ok: true, value: sessionViewOf(restored.session) };
      }
      default:
        return failSession('unsupported', `不支持的文件格式 ${String(format)}`, commonOptions.id);
    }
  }

  // --- 提交编辑并交付 ------------------------------------------------------

  async publish(
    sessionId: string,
    input: PublishInput,
  ): Promise<SessionResult<PublishSubmission>> {
    const entry = this.#entries.get(sessionId);
    if (entry === undefined) {
      return failSession('session_not_found', `没有交付会话 ${sessionId}`, sessionId);
    }
    // **每次交付尝试都留下真实工作记录**（合同 R264 第 3 条）——成功与失败/被拒都要。
    // 开工先落 `processing`，于是"在途"是一个**可被完成视图读到的事实**，而不是靠时序猜。
    const workId = DeliverableHost.workItemIdOf(sessionId, input.idempotency_key);
    this.#beginDeliveryWork(entry, workId, input);
    let outcome: SessionResult<PublishSubmission>;
    try {
      outcome = await entry.session.publish(input);
    } catch (error) {
      // 交付自身**抛出**（不是结构化失败）：先如实落一条 failed 工作项，再把异常抛回调用方。
      // 否则这条记录会永远停在 `processing`，让任务**永远不可能完成**——那是另一种撒谎。
      this.#settleDeliveryWork(workId, {
        ok: false,
        failure: { code: 'publish_threw', message: describe(error) },
      });
      throw error;
    }
    this.#settleDeliveryWork(workId, deliveryOutcomeOf(outcome));
    return outcome;
  }

  /**
   * 交付尝试**开工**：在内核存储里落一条 `processing` 工作项。
   *
   * - **幂等**：同 (会话, 幂等键) 已有记录就**不新建**——重放不是新工作，
   *   更不能把一条已终态的记录改成 `processing`（终态是吸收态，Q4-b）。
   * - 没有内核任务的会话不记账（**不假装**记过）。
   */
  #beginDeliveryWork(entry: SessionEntry, workId: RequestId, input: PublishInput): void {
    if (this.#workItem(workId) !== undefined) return;
    const task = this.#taskOfTaskId(entry.kernel_task_id);
    if (task === undefined) return;
    const at = asLogicalTime(this.#clock.now());
    this.#store.transact((tx) => {
      tx.putWorkItem(
        createWorkItem({
          request_id: workId,
          task_id: entry.kernel_task_id,
          task_revision: task.revision,
          owner_instance_id: entry.instance_id,
          description:
            `交付编辑（幂等键 ${input.idempotency_key}，基线编辑版本 r${String(input.base_revision)}）`,
          expected_output: '一版可编辑的办公文件（已发布并回读）',
          status: 'processing',
          // 非终态必须有**可指认**的等待原因（构造器会拦）。
          blocker_reason: {
            kind: 'waiting_external',
            detail: '交付进行中：等待物化端口写盘回读与内核发布投影给出结局',
          },
          created_at: at,
          updated_at: at,
        }),
      );
    });
  }

  /**
   * 交付尝试**收工**：把工作项推到一个**终态**（`completed` / `failed`）。
   *
   * **走真实工作项状态机**（`applyWorkItemTransition`）而不是直接改字段：它在终态上会以
   * `terminal_locked` 拒绝。于是"**取消后迟到的成功结果**"不会把工作项改写成 `completed`
   * —— 这正是 R205 / R262 要求的语义，而且是**状态机保证**的，不是本方法自觉。
   *
   * 被拒的编辑（超时 / 未知表 / stale 基线 / 格式不符……）一律落 `failed` 并带失败原因，
   * 于是它**参与**完成口径（`flags.any_work_item_failed`），不会被"没有记录"吞掉。
   */
  #settleDeliveryWork(workId: RequestId, outcome: DeliveryOutcome): void {
    const existing = this.#workItem(workId);
    if (existing === undefined) return;
    const at = asLogicalTime(this.#clock.now());
    try {
      this.#store.transact((tx) => {
        const current = tx.getWorkItem(workId) ?? existing;
        // **交付成功但没有可指认的产物** ⇒ 不得转 `completed`（状态机本身也会拒）：
        // 没有结果引用的"完成"就是 R264 要堵的那种**没有证据的成功**。
        // 如实落 `failed` 并写清原因，而不是把它留在 `processing`（那会让任务永远不能完成）。
        const next =
          outcome.ok && outcome.result_refs.length > 0
            ? applyWorkItemTransition({
                item: current,
                to: 'completed',
                at,
                completion: {
                  request_id: current.request_id,
                  result_refs: outcome.result_refs.map((ref) => asArtifactRef(ref)),
                },
              })
            : applyWorkItemTransition({
                item: current,
                to: 'failed',
                at,
                failure_reason: outcome.ok
                  ? '交付返回成功但没有可指认的产物（结果引用缺失）：不把它当作已完成'
                  : `${outcome.failure.code}：${outcome.failure.message}`,
              });
        tx.putWorkItem(next);
      });
    } catch (error) {
      // **只有"终态锁"是可预期的**：工作项已被取消 / 已定局，迟到的结局不得改写它。
      // 其余错误**不吞**：那是记账本身出了问题，宁可让调用方看见异常，
      // 也不要留下一条"说不清发生了什么"的记录（该异常可安全重试，交付是幂等的）。
      if (isTerminalLocked(error)) return;
      throw error;
    }
  }

  /**
   * **取消本会话尚未定局的交付工作**（R205 / R262：取消不可复活）。
   *
   * 把每条非终态工作项推成 `cancelled`。此后到达的交付结局会被 `terminal_locked` 拒绝
   * ⇒ **迟到结果不会把任务变成功**（`label` 落在"已完成且被取消"）。
   *
   * **诚实登记**：本方法目前**没有 HTTP 入口**（交付链尚未有取消面）；它是完成口径
   * 那条不变量的**可测落点**，不是已交付的产品功能。见 `interface-declaration.md` 的 J-6。
   */
  cancelPendingWork(sessionId: string, reason: string): readonly string[] {
    const entry = this.#entries.get(sessionId);
    if (entry === undefined) return Object.freeze([]);
    const at = asLogicalTime(this.#clock.now());
    const cancelled: string[] = [];
    this.#store.transact((tx) => {
      for (const item of tx.listWorkItems()) {
        if (item.task_id !== entry.kernel_task_id) continue;
        try {
          tx.putWorkItem(
            applyWorkItemTransition({ item, to: 'cancelled', at, cancellation_reason: reason }),
          );
          cancelled.push(String(item.request_id));
        } catch (error) {
          // 已终态的项走不动（终态吸收）——跳过它，不谎称取消成功。
          if (isTerminalLocked(error)) continue;
          throw error;
        }
      }
    });
    return Object.freeze(cancelled);
  }

  /** 该任务的全部工作项（只读旁证；完成视图与证据都用它）。 */
  workItemsOf(sessionId: string): readonly WorkItem[] {
    const entry = this.#entryFor(sessionId);
    if (entry === undefined) return Object.freeze([]);
    return Object.freeze(
      this.#store.snapshot().work_items.filter((item) => item.task_id === entry.kernel_task_id),
    );
  }

  #workItem(requestId: RequestId): WorkItem | undefined {
    return this.#store.snapshot().work_items.find((item) => item.request_id === requestId);
  }

  #taskOfTaskId(taskId: TaskId): TaskRecord | undefined {
    return this.#store.snapshot().tasks.find((task) => task.task_id === taskId);
  }

  // --- 下载某一版 ---------------------------------------------------------

  /**
   * 取某一编辑版本的字节。
   *
   * 走**物化端口的回读**（盘上的真实字节），而不是"内存里的源重新导出一次"：
   * 下载面必须证明"盘上那份就是当初交付的那份"，否则下载就成了自我复述。
   * MIME 与扩展名取自**这一版自己的映射行**（R232：格式随版本走，不另查一张表）。
   */
  async versionBytes(sessionId: string, editRevision: number): Promise<DeliverableVersionBytes | undefined> {
    const entry = this.#entryFor(sessionId);
    if (entry === undefined) return undefined;
    const version = entry.session.publishedAt(editRevision);
    if (version === null) return undefined;
    const documents = this.#documents;
    if (documents === null) return undefined;
    let bytes: Uint8Array | undefined;
    try {
      bytes = await documents.readBack(version.artifact_id, version.file_format);
    } catch {
      return undefined;
    }
    if (bytes === undefined) return undefined;
    if (digestBytes(bytes) !== version.content_digest) {
      // 盘上那份与交付时记的不是同一份：**不返回**（宁可 404 也不发来源不明的字节）。
      return undefined;
    }
    return Object.freeze({
      bytes,
      filename: version.filename,
      artifact_id: version.artifact_id,
      content_digest: version.content_digest,
      file_format: version.file_format,
      mime_type: version.mime_type,
      template_kind: version.template_kind,
    });
  }

  // --- 内部：内核登记 -----------------------------------------------------

  #registerKernelTask(input: {
    readonly taskId: TaskId;
    readonly groupId: GroupId;
    readonly instanceId: InstanceId;
    readonly sourceFactRef: ReturnType<typeof asFactRef>;
    readonly sessionId: string;
    readonly deliverableId: string;
    readonly fileName: string;
    readonly templateKind: TemplateKind;
    readonly format: FileFormat;
  }): KnownFactSnapshotEntry {
    const text =
      `用户要求的${describeFormat(input.format)}交付物（交付物 id ${input.deliverableId}，` +
      `文件名 ${input.fileName}）`;
    const inner = Object.freeze({ type: 'text' as const, text, source: `会话 ${input.sessionId}` });
    // **不是** user_confirmation：它记录"这份交付物从哪来"，不表示内容已被核实（R148）。
    const source = Object.freeze({
      kind: 'external' as const,
      detail: '交付来源登记（含义是"这份产物从哪来"；不表示内容事实已核实，也不得冒充用户确认）',
    });
    const snapshotEntry: KnownFactSnapshotEntry = Object.freeze({
      fact_ref: input.sourceFactRef,
      fact_key: DELIVERABLE_SOURCE_FACT_KEY,
      value: inner,
      source,
    });

    if (this.#store.snapshot().tasks.some((task) => task.task_id === input.taskId)) {
      return snapshotEntry;
    }
    const at = asLogicalTime(this.#clock.now());
    const revision: Revision = asRevision(1);
    this.#store.transact((tx) => {
      tx.putTask(
        createTaskRecord({
          task_id: input.taskId,
          title: `${describeFormat(input.format)}交付会话 ${input.sessionId}`,
          goal:
            `按用户的结构化编辑意图产出并交付一份真实的${describeFormat(input.format)}文件` +
            `（交付物 ${input.deliverableId}）；运行实例 ${this.#options.run_id}`,
          current_group_id: input.groupId,
          deliverables: [`一份可编辑的${describeFormat(input.format)}文件（按编辑修订逐版交付）`],
          revision,
          created_at: at,
          updated_at: at,
        }),
      );
      tx.putInstance(
        createInstanceState({ instance_id: input.instanceId, group_id: input.groupId, updated_at: at }),
      );
      tx.putGroupMember(
        createGroupMember({
          group_id: input.groupId,
          instance_id: input.instanceId,
          registered_at: at,
        }),
      );
      tx.putSharedFact(
        createSharedFactRecord({
          fact_id: input.sourceFactRef,
          task_id: input.taskId,
          task_revision: revision,
          fact_key: DELIVERABLE_SOURCE_FACT_KEY,
          value: Object.freeze({ kind: 'known' as const, value: inner }),
          source,
          confirmed_by: input.instanceId,
          confirmed_at: at,
        }),
      );
    });
    return snapshotEntry;
  }

  // --- 内部：发布端口 -----------------------------------------------------

  #publishPortFor(
    sessionId: string,
    taskId: TaskId,
    instanceId: InstanceId,
    holder: SourceFactHolder,
  ): DeliverablePublishPort {
    return {
      publish: (request: DeliverablePublishRequest): Promise<DeliverablePublishResult> =>
        this.#publish({ sessionId, taskId, instanceId, holder, request }),
    };
  }

  async #publish(input: {
    readonly sessionId: string;
    readonly taskId: TaskId;
    readonly instanceId: InstanceId;
    readonly holder: SourceFactHolder;
    readonly request: DeliverablePublishRequest;
  }): Promise<DeliverablePublishResult> {
    const documents = this.#documents;
    if (documents === null) {
      return {
        ok: false,
        failure: {
          kind: 'document_port_unavailable',
          detail: '物化端口未接入：无法写盘，因此不交付（绝不用直接写文件顶替）',
        },
      };
    }
    const { request } = input;
    const clock = this.#clock;
    const at = asLogicalTime(clock.now());
    const friendlyName = stripExtension(request.filename, request.file_format);
    const sourceFactEntry = input.holder.entry;
    if (sourceFactEntry === null) {
      return {
        ok: false,
        failure: {
          kind: 'host_not_ready',
          detail: '会话尚未完成内核登记（来源事实缺失）：拒绝在没有可追溯来源时发布',
        },
      };
    }
    // **格式互不冒充**（R232 的交付侧守卫）：会话声明的格式必须与请求一致，
    // 且与模板种类自洽。不一致就拒绝，绝不用一个格式的字节冒充另一个格式。
    const expectedKind = formatSpec(request.file_format).template_kind;
    if (request.template_kind !== expectedKind) {
      return {
        ok: false,
        failure: {
          kind: 'format_kind_mismatch',
          detail:
            `文件格式 ${request.file_format} 与模板种类 ${request.template_kind} 不自洽` +
            `（应为 ${expectedKind}）：拒绝发布`,
        },
      };
    }

    // ① 内核任务版本递增 + 落 staged 记录（**同一个事务**）。
    let fact: StagedArtifactFact;
    try {
      fact = this.#store.transact((tx) => {
        const task = tx.getTask(input.taskId);
        if (task === undefined) {
          throw new Error(`内核任务 ${input.taskId} 不在存储中：不得在无法核对版本时发布`);
        }
        const bumped = applyTaskPatch(
          task,
          createTaskPatch(task.task_id, task.revision, [
            {
              field: 'deliverables',
              kind: 'replace',
              value: [`交付物（编辑版本 ${String(request.edit_revision)}）`],
            },
          ]),
          at,
        );
        tx.putTask(bumped);

        // template_kind 由**会话自己的格式**决定 —— planner 据它派生扩展名 / MIME / 版本化路径。
        const artifactVersion = resolveNextArtifactVersion(tx, input.taskId, request.template_kind);
        const artifactPlan: ArtifactPlan = planArtifact({
          task_id: input.taskId,
          task_revision: bumped.revision,
          template_kind: request.template_kind,
          artifact_version: artifactVersion,
          root_dir: this.#options.artifact_root_dir,
          expected_content_digest: request.expected_digest,
        });
        // 规划的扩展名必须与请求的格式一致（两道独立判据：格式声明 + 路径规划）。
        if (artifactPlan.file_extension.toLowerCase() !== formatSpec(request.file_format).extension) {
          throw new Error(
            `内核规划出的扩展名 ${artifactPlan.file_extension} 与请求格式 ` +
              `${request.file_format} 不一致：拒绝用错误的路径发布`,
          );
        }
        const record = createArtifactRecord({
          artifact_id: artifactPlan.artifact_id,
          task_id: input.taskId,
          task_revision: bumped.revision,
          artifact_version: artifactVersion,
          template_kind: request.template_kind,
          byte_length: request.bytes.byteLength,
          content_digest: request.expected_digest,
          source_fact_refs: [sourceFactEntry.fact_ref],
          created_by_instance_id: input.instanceId,
          status: 'staged',
          verifications: [
            {
              kind: 'version_match',
              outcome: 'pass',
              detail:
                `暂存时内核任务版本 r${String(bumped.revision)}（编辑版本 ` +
                `${String(request.edit_revision)}，格式 ${request.file_format}）；发布前投影还会再核对一次`,
            },
          ],
          created_at: at,
        });
        tx.putArtifact(record);
        const materializationRequest: ArtifactMaterializationRequest = Object.freeze({
          artifact_id: artifactPlan.artifact_id,
          task_id: input.taskId,
          task_revision: artifactPlan.task_revision,
          template_kind: request.template_kind,
          fact_snapshot: Object.freeze([sourceFactEntry]),
          plan: artifactPlan,
          expected_content_digest: request.expected_digest,
          payload: request.bytes,
        });
        return Object.freeze({ record, request: materializationRequest });
      });
    } catch (error) {
      return {
        ok: false,
        failure: {
          kind: 'staging_failed',
          detail: `内核暂存失败：${describe(error)}（未写任何文件）`,
        },
      };
    }

    // ② 外部副作用（写盘 + 回读）**只发生在任何事务之外**。
    let memoResult: ArtifactMaterializationResult;
    try {
      memoResult = await this.#materializeFact(documents, fact, at, friendlyName, request.file_format);
    } catch (error) {
      memoResult = materializationFailure(
        fact.request,
        'write_failed',
        `物化端口抛出异常：${describe(error)}`,
        at,
      );
    }

    // ③ 同步记忆端口：把"已经真实发生过的写盘与回读"交给内核的发布投影。
    const memo = new Map<string, ArtifactMaterializationResult>([
      [String(fact.record.artifact_id), memoResult],
    ]);
    const port: ArtifactMaterializationPort = {
      materialize: (materializationRequest: ArtifactMaterializationRequest): ArtifactMaterializationResult => {
        const hit = memo.get(String(materializationRequest.artifact_id));
        if (hit === undefined) {
          return materializationFailure(
            materializationRequest,
            'write_failed',
            '宿主未预先物化该产物（编排错误）：内核不得据未发生过的写盘宣称交付',
            at,
          );
        }
        return hit;
      },
    };

    // ④ 版本闸门 + 发布投影（与生成链、字处理链**同一个**）。
    clock.advance(1, `publish deliverable ${input.sessionId} revision ${String(request.edit_revision)}`);
    const projection = createArtifactPublicationProjection({
      store: this.#store,
      port,
      hooks: publicationEventHooks(this.#ids),
    });
    const outcomes = projection.reconcile([fact], asLogicalTime(clock.now()));
    const published = outcomes.find((outcome) => outcome.kind === 'published');
    const record = published?.record ?? null;

    if (outcomeFailed(outcomes) || record === null || !isDeliveredArtifact(record) || record.receipt === null) {
      const failure = memoResult.ok
        ? { kind: 'publish_failed', detail: outcomes.map((outcome) => outcome.detail).join('；') }
        : memoResult.failure;
      return {
        ok: false,
        failure: Object.freeze({
          kind: failure.kind,
          detail: `${failure.detail}（旧文件与既有版本均未改动）`,
        }),
      };
    }

    // ⑤ 回执：**再核一次格式**（记录里的 MIME 必须就是该格式的官方 MIME）。
    const expectedMime = formatSpec(request.file_format).mime;
    if (record.mime_type !== expectedMime) {
      return {
        ok: false,
        failure: {
          kind: 'format_mime_mismatch',
          detail:
            `产物记录的 MIME ${record.mime_type} 与格式 ${request.file_format} 的官方 MIME ` +
            `${expectedMime} 不一致：拒绝把格式可疑的产物记为已交付`,
        },
      };
    }

    const receipt = record.receipt;
    return {
      ok: true,
      receipt: Object.freeze({
        artifact_id: String(record.artifact_id),
        task_revision: record.task_revision,
        artifact_version: record.artifact_version,
        readback_digest: receipt.readback_digest,
        byte_length: record.byte_length,
        entry_count: receipt.entry_count ?? 0,
        filename: request.filename,
        verifier: receipt.verifier,
        final_path: receipt.final_path,
      }),
    };
  }

  /** 写盘 + 回读 + 结构自检 + 摘要核对（与生成链、字处理链同口径）。 */
  async #materializeFact(
    documents: DocumentPort,
    fact: StagedArtifactFact,
    at: LogicalTime,
    friendlyName: string,
    format: FileFormat,
  ): Promise<ArtifactMaterializationResult> {
    const artifactId = String(fact.record.artifact_id);
    const request = fact.request;
    const payload = request.payload;
    if (payload === undefined) {
      return materializationFailure(request, 'builder_failed', '物化请求缺少 payload 字节', at);
    }

    let receipt: { readonly path: string; readonly sha256: string; readonly byteLength: number };
    try {
      receipt = await documents.materialize({
        artifactId,
        // 文件名走白名单规范化（与生成链、字处理链同一条路），**按交付格式补扩展名**。
        // 标题折成空串时用该格式的语义化兜底名（不是把 `xlsx` 当文件名）。
        filename: normalizeOfficeFilename(friendlyName, format, FALLBACK_STEM[format]),
        bytes: payload,
        expectedSha256: fact.record.content_digest,
        format,
      });
    } catch (error) {
      return materializationFailure(request, 'write_failed', `写盘失败：${describe(error)}`, at);
    }

    let back: Uint8Array | undefined;
    try {
      back = await documents.readBack(artifactId, format);
    } catch (error) {
      return materializationFailure(request, 'write_failed', `回读失败：${describe(error)}`, at);
    }
    if (back === undefined) {
      return materializationFailure(request, 'write_failed', '写盘后回读不到该文件：不得据此声称已交付', at);
    }

    let entryCount: number;
    try {
      const selfCheck = selfCheckArtifactBytes(back);
      if (!selfCheck.ok) {
        return materializationFailure(
          request,
          'self_check_failed',
          `回读字节未通过结构自检：${selfCheck.problems[0]?.detail ?? '未给出细节'}`,
          at,
        );
      }
      entryCount = selfCheck.entry_count;
    } catch (error) {
      return materializationFailure(request, 'self_check_failed', `结构自检自身失败：${describe(error)}`, at);
    }

    const readbackDigest = digestBytes(back);
    if (
      receipt.sha256 !== fact.record.content_digest ||
      receipt.byteLength !== back.byteLength ||
      readbackDigest !== fact.record.content_digest
    ) {
      return materializationFailure(
        request,
        'self_check_failed',
        `回读摘要与暂存期望不一致（期望 ${fact.record.content_digest}，端口回执 ${receipt.sha256}，` +
          `宿主回读 ${readbackDigest}）：拒绝发布被改动或写错的字节`,
        at,
      );
    }

    const fullReceipt: ArtifactMaterializationReceipt = Object.freeze({
      artifact_id: fact.record.artifact_id,
      byte_length: back.byteLength,
      entry_count: entryCount,
      final_path: toForwardSlashes(receipt.path),
      readback_digest: readbackDigest,
      verifier: 'demo-host/office-materialization-port（宿主对最终路径的实际回读）',
      at: asLogicalTime(at),
    });
    return materializationSuccess(fullReceipt);
  }

  #persistenceFor(sessionId: string): SessionPersistence {
    return this.#options.session_persistence?.(sessionId) ?? memoryPersistence();
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * 把一个**会话实例**收敛成宿主视图（开放与恢复**共用**：两条路的返回值形状必须逐字一致，
 * 否则"重开出来的会话"与"新建的会话"在调用方眼里会变成两种东西）。
 */
function sessionViewOf<S>(
  session: DeliverableSession<S>,
): { readonly session: HostedSession; readonly edit_revision: number; readonly content_digest: string } {
  return Object.freeze({
    session: session as unknown as HostedSession,
    edit_revision: session.currentRevision(),
    content_digest: session.currentDigest(),
  });
}

/** 内核任务登记后的开会话返回值（把泛型会话收敛成宿主视图）。 */
function toOpenView<S>(
  opened: SessionResult<DeliverableSession<S>>,
): SessionResult<{ readonly session: HostedSession; readonly edit_revision: number; readonly content_digest: string }> {
  if (!opened.ok) return opened;
  return { ok: true, value: sessionViewOf(opened.value) };
}

/** 空白表格源（表数由调用方决定；这里只给一个起始表）。 */
function emptyXlsxSource(sheetName: string): XlsxDeliverableSource {
  return emptyWorkbook(sheetName);
}

/** 空白演示源（**0 页**；页数由后续编辑决定，不是固定两页）。 */
function emptyPptxSource(presentationId: string, title: string): PptxDeliverableSource {
  return emptyPresentationSource(presentationId, title);
}

function describeFormat(format: FileFormat): string {
  switch (format) {
    case 'docx':
      return 'Word 文档';
    case 'xlsx':
      return '表格';
    case 'pptx':
      return '演示';
    default:
      return String(format);
  }
}

/** 标题折成空串时的兜底文件名主干（按格式各自语义化）。 */
const FALLBACK_STEM: Readonly<Record<FileFormat, string>> = Object.freeze({
  docx: 'document',
  xlsx: 'workbook',
  pptx: 'presentation',
});

/** 去掉该格式的扩展名（`normalizeOfficeFilename` 自己会补回来，避免 `x.xlsx.xlsx`）。 */
function stripExtension(filename: string, format: FileFormat): string {
  const extension = formatSpec(format).extension;
  return filename.replace(new RegExp(`\\.${extension}$`, 'i'), '');
}

function outcomeFailed(outcomes: readonly { readonly kind: string }[]): boolean {
  return outcomes.some((outcome) => outcome.kind === 'failed' || outcome.kind === 'unrecorded');
}

function toForwardSlashes(path: string): string {
  return path.split('\\').join('/');
}

/** 进程内持久化（默认；宿主仍可在 options 里换成落盘实现）。 */
function memoryPersistence(): SessionPersistence {
  let state: unknown = null;
  return {
    save(next: DeliverableSessionState): void {
      state = next;
    },
    load(): unknown {
      return state;
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function failSession(code: string, message: string, sessionId: string): SessionFailure {
  return Object.freeze({
    ok: false as const,
    code: code as SessionFailure['code'],
    message,
    detail: Object.freeze({ extra: Object.freeze({ session_id: sessionId }) }),
  });
}

/**
 * **文档会话宿主**（design-05-P8；合同 §G 全部 + R132–R146）。
 *
 * ## 这一层把"会话"接到**内核的真实发布链**上
 *
 * `src/documents/session/**` 只说"交出字节、拿回回执"，它不知道内核、不知道磁盘。
 * 本文件就是那个"拿回执"的实现，而且**不接受任何绕过任务链的写法**：
 *
 * ```text
 * ① 会话在内核存储里有一个**真实任务**（`src/protocol/task.ts` 的 TaskRecord），
 *    任务版本由**内核自己的** `applyTaskPatch`（deliverables 变更 = 实质性）递增
 *    —— 这就是 `taskRevision` 的来源，不是宿主自己数出来的。
 * ② 产物在内核存储里落一条 `staged` 记录（`planArtifact` 派生 id 与版本化路径，
 *    `resolveNextArtifactVersion` 派生 `artifactVersion`）。
 * ③ 字节由**宿主先写盘并回读**（S5 文档端口：临时文件 + 原子 rename + 回读核对），
 *    再把"确实发生过的写盘与回读"装进一个同步记忆端口。
 * ④ 发布投影（`createArtifactPublicationProjection`，与生成链**同一个**）跑版本闸门 →
 *    写 `published` + 回执 + `artifact_published` 内核事件。
 * ⑤ 回执里的 `readback_digest` 来自**对最终路径的实际回读**（I-1）。
 * ```
 *
 * **没有 `fs.writeFile` 后直接宣称保存成功的路径**：写盘只在 S5 端口里发生，
 * 而"保存成功"只由内核发布的 `published` 记录回答（`isDeliveredArtifact`）。
 *
 * ## 为什么字节不走 `finishRun` 的产物意图
 *
 * 生成链的产物字节由内核模板构建器从**意图**构建（标题 + 2–4 段纯文本）。
 * 编辑链的字节来自"导入 → 改属性 → 导出"，**不可能**由那个构建器复现；
 * 强行改写成模板要求就等于"把文档拍平成文字再重排"，正是 R151 禁止的做法。
 * 所以编辑链**复用发布链的后半段**（版本闸门 + 物化端口 + 投影 + 回执），
 * 而不是复用"从意图构建字节"那一小段。两者的产物记录、版本闸门、
 * 回读核对与发布投影是同一套代码。
 *
 * ## 诚实边界
 *
 * - 会话的内核存储**在进程内**：宿主重启后会话状态由 `SessionPersistence` 恢复（WF-083），
 *   但**内核存储不恢复**——重启后 `published` 记录不在 store 里，本项目一贯如此
 *   （生成链同样"应用索引持久化 ≠ 内核运行恢复"）。这一点在交付说明里显式列出。
 * - 由此引申的一条**必须遵守的纪律**（FA-FIX-ARTIFACT-ID-COLLISION）：内核存储既然从零起，
 *   重新登记的内核任务**绝不能**又从 `r1` 起步——产物 id 是
 *   `(task_id, task_revision, 模板种类, 版本)` 的**纯函数**（`src/artifacts/planner.ts`），
 *   版本从零重算就会在"同名不同内容"的落点上撞号，被物料端口如实拒绝（502）。
 *   因此起始版本一律取**会话已发布记录里的最大 `task_revision`**（见 {@link resumeRevisionOf}）。
 * - 会话数量有上限（`max_sessions`）：超限**结构化拒绝**，不静默丢弃最早的会话。
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
  isDeliveredArtifact,
  type ArtifactRecord,
  type GroupId,
  type IdSource,
  type InstanceId,
  type LogicalTime,
  type Revision,
  type Store,
  type TaskId,
  type TaskRecord,
  type TemplateKind,
} from '../../../src/protocol/index.js';
import { createMemoryStore } from '../../../src/storage/index.js';
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
import { normalizeDocxFilename, type DocumentPort } from '../documents/port.js';
import { formatSpec, type FileFormat } from '../../../src/session/index.js';
import type { NumberingTable } from '../../../src/documents/numbering/index.js';
import { publicationEventHooks } from './kernel.js';
import {
  DocumentSession,
  createMemorySessionPersistence,
  type ContentDigest,
  type DocumentPublishPort,
  type DocumentPublishRequest,
  type DocumentPublishResult,
  type EditRevision,
  type SessionFailure,
  type SessionResult,
  type SessionStatusView,
} from '../../../src/documents/session/index.js';

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

/** 会话任务 id 的前缀（与生成链的 `T-<hex>` 分开，避免身份的两种来源混在一起）。 */
export const SESSION_TASK_PREFIX = 'T-doc-';

/** 会话数量上限（超限结构化拒绝；不静默淘汰）。 */
export const DEFAULT_MAX_SESSIONS = 64;

export interface DocumentSessionHostOptions {
  /** 生产物化端口（S5）。**未接入即拒绝发布**，绝不退化成直接写文件。 */
  readonly documents: DocumentPort | null;
  /** 内核路径规划的产物根（`/` 分隔）。 */
  readonly artifact_root_dir: string;
  readonly run_id: string;
  readonly max_sessions?: number;
  readonly now?: () => Date;
  /** 会话状态的持久化载体（按会话 id 分开保存）；省略时用进程内内存实现。 */
  readonly session_persistence?: (sessionId: string) => SessionPersistenceLike;
}

/** 持久化接缝（结构化，避免直接依赖会话包的内部形状）。 */
export interface SessionPersistenceLike {
  save(state: unknown): void;
  load(): unknown;
}

export interface OpenSessionInput {
  readonly session_id: string;
  readonly filename: string;
  /** 起始包字节（新建 / 导入都走这条；区别只在语义与来源标记）。 */
  readonly template_bytes: Uint8Array;
  /** `new` = 新建（来源记为 user_request）；`import` = 导入既有文件（来源记为 imported）。 */
  readonly mode: 'new' | 'import';
  /**
   * 起始**编号表**（`word/numbering.xml` 的模型侧；省略 = 没有编号表）。
   *
   * 为什么在这里而不是从包里读：编号表可以由本次会话**新建**（原包没有 `numbering.xml`
   * 而我们要写一个），那时它只存在于会话状态里。会话层负责把它持久化、
   * 并在每一次导出（含发布）时交给导出器。
   */
  readonly numbering?: NumberingTable | null;
}

export interface SessionOpenView {
  readonly session_id: string;
  readonly document_id: string;
  readonly filename: string;
  readonly kernel_task_id: string;
  readonly edit_revision: EditRevision;
  readonly content_digest: ContentDigest;
}

export interface SubmitSessionEditInput {
  readonly session_id: string;
  readonly idempotency_key: string;
  readonly base_revision: EditRevision;
  readonly base_digest: ContentDigest;
  readonly intent?: unknown;
  /**
   * **节编辑意图**（WF-045–055 的产品路径；形状见 `src/documents/session/section-ops.ts`）。
   *
   * 与 `intent` **二选一**（两个都给会被会话层拒为 `invalid_expression`）。
   * 宿主只做透传，**不在这里校验节操作**：校验归会话层的编译器，
   * 这样"HTTP 面能过、内核面被拒"这种两套口径的分叉不会出现。
   */
  readonly section_intent?: unknown;
  /**
   * **列表编辑意图**（WF-035–044 的产品路径；形状见 `src/documents/session/list-ops.ts`）。
   *
   * 与 `intent` / `section_intent` **三选一**（同时给会被会话层拒为 `invalid_expression`）。
   * 宿主只做透传：**不在这里校验列表操作**——校验归会话层的编译器，这样"HTTP 面能过、
   * 内核面被拒"这种两套口径的分叉不会出现。
   *
   * 为什么需要它：`list-ops.ts` 与 `numbering/**` 早就完整（加/取消/换级/重启，
   * 且**只写 `numPr` 引用、绝不往正文塞 `•` / `1.`**），但 HTTP 与网页两层从未接线，
   * 于是"给选中段落加项目符号"在页面上只能被拒绝。本字段就是那条缺的接线。
   */
  readonly list_intent?: unknown;
}

export interface VersionBytes {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly artifact_id: string;
  readonly content_digest: ContentDigest;
  /**
   * 这一版的交付文件格式 / MIME / 模板种类。
   *
   * 为什么加在这里而不是让 HTTP 面写死 `DOCX_MIME`：下载头是**消费端唯一的格式线索**，
   * 而它是"这一版交付的是什么"的属性，不是"这个会话链是干什么的"的属性。
   * 硬编码会让"以后这条链也交付别的格式"变成一次静默的响应头错误。
   * 本链只有 DOCX，所以这三个字段恒为 document/docx/…wordprocessingml…（行为不变）。
   */
  readonly file_format: FileFormat;
  readonly mime_type: string;
  readonly template_kind: TemplateKind;
}

// ---------------------------------------------------------------------------
// 宿主
// ---------------------------------------------------------------------------

/** 来源事实的键（产物记录要求 `source_fact_refs` 非空；编辑链的唯一事实就是"文档从哪来"）。 */
export const SOURCE_FACT_KEY = 'edit.source';

/** 本链交付的文件格式（字处理）。MIME 从 protocol 的单一来源读出，不在此另抄字面量。 */
const DOCUMENT_FILE_FORMAT: FileFormat = 'docx';
const DOCUMENT_MIME = formatSpec(DOCUMENT_FILE_FORMAT).mime;

/**
 * 会话构造期的可变持有位。
 *
 * 存在的唯一理由：会话在**构造时**就要拿到发布端口，而来源事实的登记需要文档 id
 * （文档 id 由包决定、开会话时才可知）。用一个小持有位，避免把会话构造两次。
 */
interface SourceFactHolder {
  entry: KnownFactSnapshotEntry | null;
}

interface SessionEntry {
  readonly session: DocumentSession;
  readonly kernel_task_id: TaskId;
  readonly group_id: GroupId;
  readonly instance_id: InstanceId;
  readonly source_fact_ref: string;
}

/**
 * 会话宿主：会话注册表 + 内核任务登记 + **发布端口**。
 *
 * 单实例串行：本类的公开方法都是 `async`，但同一会话上的发布由会话层自己串行化
 * （`publish_port` 的调用点只有一个，`submitEdit` 内部按顺序 await）。
 */
export class DocumentSessionHost {
  readonly #options: DocumentSessionHostOptions;
  readonly #documents: DocumentPort | null;
  readonly #store: Store;
  readonly #ids: IdSource;
  readonly #clock = new LogicalClock();
  readonly #now: () => Date;
  readonly #maxSessions: number;
  readonly #entries = new Map<string, SessionEntry>();

  constructor(options: DocumentSessionHostOptions) {
    this.#options = options;
    this.#documents = options.documents;
    this.#store = createMemoryStore({ clock: () => this.#clock.now() });
    this.#ids = createIdSource();
    this.#now = options.now ?? ((): Date => new Date());
    this.#maxSessions = options.max_sessions ?? DEFAULT_MAX_SESSIONS;
  }

  /** 内核侧的会话任务 id（确定性派生，无计数器、无随机）。 */
  static taskIdOf(sessionId: string): TaskId {
    const digest = createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 16);
    return asTaskId(`${SESSION_TASK_PREFIX}${digest}`);
  }

  sessionIds(): readonly string[] {
    return Object.freeze([...this.#entries.keys()]);
  }

  has(sessionId: string): boolean {
    return this.#entries.has(sessionId);
  }

  status(sessionId: string): SessionStatusView | undefined {
    return this.#entries.get(sessionId)?.session.status();
  }

  /**
   * 内核里的产物记录（只读旁证）。
   *
   * 存在的理由是**证据**：只有拿得到内核那一条记录，才能验证
   * "产物确实经内核任务发布"而不是"宿主自己造了个回执"——
   * `status` / `receipt.readback_digest` / `verifications` 都在那条记录上。
   */
  kernelArtifact(artifactId: string): ArtifactRecord | undefined {
    return this.#store
      .snapshot()
      .artifacts.find((record) => String(record.artifact_id) === artifactId);
  }

  /** 内核里的全部产物记录（只读旁证；数组顺序即入库顺序）。 */
  kernelArtifactList(): readonly ArtifactRecord[] {
    return this.#store.snapshot().artifacts;
  }

  /** 内核里的产物记录条数（幂等断言用：重复提交**不得**增加条数）。 */
  kernelArtifactCount(): number {
    return this.#store.snapshot().artifacts.length;
  }

  /** 内核里的任务（只读旁证；`taskRevision` 从这条记录读出）。 */
  kernelTask(sessionId: string): TaskRecord | undefined {
    return this.#store.snapshot().tasks.find((task) => task.task_id === DocumentSessionHost.taskIdOf(sessionId));
  }

  /**
   * 登记一次**需求变更**：用内核自己的结构化 patch 语义把任务版本 +1（R142 的"新编辑"）。
   *
   * **不是测试钩子**，而是 R142 那句"期间有新编辑则迟到结果必须拒绝"里"新编辑"的
   * 内核侧对应操作：用户改主意了，正在物化的旧候选就此作废，任何随后到达的
   * 发布都会在版本闸门上被拒为 `version_stale`。
   *
   * @returns 新的内核任务版本；会话不存在或任务不在存储里时返回失败。
   */
  reviseDeliverable(sessionId: string, note: string): SessionResult<number> {
    const taskId = DocumentSessionHost.taskIdOf(sessionId);
    if (!this.#entries.has(sessionId)) {
      return failSession('session_not_found', `没有会话 ${sessionId}`, sessionId);
    }
    const at = asLogicalTime(this.#clock.now());
    try {
      const revision = this.#store.transact((tx) => {
        const task = tx.getTask(taskId);
        if (task === undefined) {
          throw new Error(`内核任务 ${taskId} 不在存储中`);
        }
        const bumped = applyTaskPatch(
          task,
          createTaskPatch(task.task_id, task.revision, [
            { field: 'deliverables', kind: 'replace', value: [note] },
          ]),
          at,
        );
        tx.putTask(bumped);
        return bumped.revision;
      });
      return { ok: true, value: revision };
    } catch (error) {
      return failSession('state_unreadable', `需求变更登记失败：${describe(error)}`, sessionId);
    }
  }

  /** 版本映射（R141）：编辑版本 → 内核 taskRevision / artifactVersion。 */
  mapping(sessionId: string): readonly { readonly edit_revision: number; readonly task_revision: number; readonly artifact_version: number }[] {
    const entry = this.#entries.get(sessionId);
    if (entry === undefined) return Object.freeze([]);
    return Object.freeze(
      entry.session.publishedVersions().map((version) => ({
        edit_revision: version.edit_revision,
        task_revision: version.task_revision,
        artifact_version: version.artifact_version,
      })),
    );
  }

  // --- 开会话 -------------------------------------------------------------

  /**
   * 打开（新建或导入）一个会话。
   *
   * 同时在内核存储里登记任务 / 实例 / 群成员 / **来源事实**——产物记录要求
   * `source_fact_refs` 非空（"这个产物依据什么"必须可追溯，P3 的机器判据），
   * 所以这一步不是可选装饰。
   */
  openSession(input: OpenSessionInput): SessionResult<SessionOpenView> {
    if (this.#entries.has(input.session_id)) {
      return failSession('session_already_exists', `会话 ${input.session_id} 已存在`, input.session_id);
    }
    if (this.#entries.size >= this.#maxSessions) {
      return failSession(
        'session_limit_reached',
        `会话数已达上限 ${String(this.#maxSessions)}：请先关闭不再使用的会话（不静默淘汰）`,
        input.session_id,
      );
    }

    const taskId = DocumentSessionHost.taskIdOf(input.session_id);
    const key = taskId.replace(/^T-doc-/, '').slice(0, 12);
    const groupId = asGroupId(`G-doc-${key}`);
    const instanceId = asInstanceId(`I-doc-${key}`);
    const sourceFactRef = asFactRef(`fact-doc-${key}-source`);

    const persistence = this.#persistenceFor(input.session_id);
    const holder: SourceFactHolder = { entry: null };
    const options = {
      id: input.session_id,
      filename: input.filename,
      persistence,
      publish_port: this.#publishPortFor(input.session_id, taskId, instanceId, holder),
      now: this.#now,
      numbering: input.numbering ?? null,
    };

    const opened =
      input.mode === 'new'
        ? DocumentSession.createNew(options, { template: input.template_bytes })
        : DocumentSession.importFrom(options, input.template_bytes);
    if (!opened.ok) {
      return opened as SessionFailure;
    }
    const session = opened.value;

    holder.entry = this.#registerKernelTask({
      taskId,
      groupId,
      instanceId,
      sourceFactRef,
      sessionId: input.session_id,
      mode: input.mode,
      documentId: session.documentId,
      start_revision: resumeRevisionOf(session),
    });

    this.#entries.set(input.session_id, {
      session,
      kernel_task_id: taskId,
      group_id: groupId,
      instance_id: instanceId,
      source_fact_ref: String(sourceFactRef),
    });

    return {
      ok: true,
      value: Object.freeze({
        session_id: input.session_id,
        document_id: session.documentId,
        filename: session.filename,
        kernel_task_id: String(taskId),
        edit_revision: session.currentRevision(),
        content_digest: session.currentDigest(),
      }),
    };
  }

  /**
   * 从持久化载体恢复一个会话（WF-083：保存并重新打开）。
   *
   * **内核任务会被重新登记**（存储是进程内的）：这样恢复后的会话**仍然**能发布
   * ——发布链需要 store 里有这个任务，否则版本闸门会以 `version_stale` 拒绝一切。
   * 但**既有产物的 `published` 记录不会回来**（那是内核运行状态，本项目一贯不持久化），
   * 所以恢复后的第一次发布是一个**新版本**，而不是对旧记录的重放。
   *
   * **起始 `task_revision` 取会话已发布记录的最大值**（而不是恒为 `r1`）：产物 id 与落点
   * 是 `(task_id, task_revision, 模板种类, 版本)` 的纯函数，若重启后又从 `r1` 起步，
   * 恢复后的第一次发布就会重新算出**与重启前同一个 artifact_id**、落到**同一份磁盘路径**上，
   * 而那里躺着的是**另一份字节**——物料端口"不覆盖、不交付"会如实拒绝（502
   * `publish_failed`）。让任务版本**续着走**，新发布就落在新的 `task_revision` 上
   * （id 与路径同时变新），恢复出来的是一个**能继续编辑**的活会话。
   * 这条修法**不动**"同名不同字节不得覆盖"的安全判据：撞号路径仍由端口拒绝。
   */
  restoreSession(input: {
    readonly session_id: string;
    readonly filename: string;
  }): SessionResult<SessionOpenView> {
    if (this.#entries.has(input.session_id)) {
      return failSession('session_already_exists', `会话 ${input.session_id} 已在内存中`, input.session_id);
    }
    const taskId = DocumentSessionHost.taskIdOf(input.session_id);
    const key = taskId.replace(/^T-doc-/, '').slice(0, 12);
    const groupId = asGroupId(`G-doc-${key}`);
    const instanceId = asInstanceId(`I-doc-${key}`);
    const sourceFactRef = asFactRef(`fact-doc-${key}-source`);

    const holder: SourceFactHolder = { entry: null };
    const restored = DocumentSession.restore({
      id: input.session_id,
      filename: input.filename,
      persistence: this.#persistenceFor(input.session_id),
      publish_port: this.#publishPortFor(input.session_id, taskId, instanceId, holder),
      now: this.#now,
    });
    if (restored.session === null) {
      return failSession('session_not_found', `读回会话失败：${restored.result.reason}`, input.session_id);
    }
    const session = restored.session;
    holder.entry = this.#registerKernelTask({
      taskId,
      groupId,
      instanceId,
      sourceFactRef,
      sessionId: input.session_id,
      mode: 'new',
      documentId: session.documentId,
      start_revision: resumeRevisionOf(session),
    });
    this.#entries.set(input.session_id, {
      session,
      kernel_task_id: taskId,
      group_id: groupId,
      instance_id: instanceId,
      source_fact_ref: String(sourceFactRef),
    });
    return {
      ok: true,
      value: Object.freeze({
        session_id: input.session_id,
        document_id: session.documentId,
        filename: session.filename,
        kernel_task_id: String(taskId),
        edit_revision: session.currentRevision(),
        content_digest: session.currentDigest(),
      }),
    };
  }

  /**
   * 按**落盘状态**恢复一个会话：文件名从磁盘里读，调用方不必先知道它。
   *
   * 与 `restoreSession()` 的分工：那个是"知道文件名、要恢复"的通用入口；本方法是
   * "只知道会话 id、问我能不能重开"的入口——HTTP 层的 `GET /api/sessions/:id` 用的就是它。
   * 二者共用同一条恢复实现（本方法**委托**给 `restoreSession`），不各写一套。
   *
   * **磁盘文件存在 ≠ 重开成功**（R216 的判据）：本方法只有真的读回、解码、重建会话
   * 并重新登记内核任务之后才返回 `ok: true`；任何一步不成立都以具体原因失败。
   */
  restorePersistedSession(sessionId: string): SessionResult<SessionOpenView> {
    if (this.#entries.has(sessionId)) {
      return failSession('session_already_exists', `会话 ${sessionId} 已在内存中`, sessionId);
    }
    let raw: unknown;
    try {
      raw = (this.#persistenceFor(sessionId) as SessionPersistenceLike).load();
    } catch (error) {
      return failSession('session_not_found', `读取会话 ${sessionId} 的落盘状态失败：${describe(error)}`, sessionId);
    }
    if (raw === null || raw === undefined) {
      return failSession('session_not_found', `运行目录里没有会话 ${sessionId} 的落盘状态`, sessionId);
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return failSession('session_not_found', `会话 ${sessionId} 的落盘状态形状不合法（不是对象）`, sessionId);
    }
    const filename = (raw as { readonly filename?: unknown }).filename;
    if (typeof filename !== 'string' || filename.trim().length === 0) {
      // 读得回来但没有可用文件名 ⇒ **不猜**一个默认名替它（猜错会把恢复成功伪装出来）。
      return failSession(
        'session_not_found',
        `会话 ${sessionId} 的落盘状态里没有可用的 filename，无法安全重开`,
        sessionId,
      );
    }
    return this.restoreSession({ session_id: sessionId, filename });
  }

  // --- 提交编辑 -----------------------------------------------------------

  async submitEdit(input: SubmitSessionEditInput): Promise<SessionResult<unknown>> {
    const entry = this.#entries.get(input.session_id);
    if (entry === undefined) {
      return failSession('session_not_found', `没有会话 ${input.session_id}`, input.session_id);
    }
    return entry.session.submitEdit({
      idempotency_key: input.idempotency_key,
      base_revision: input.base_revision,
      base_digest: input.base_digest,
      ...(input.intent === undefined ? {} : { intent: input.intent }),
      ...(input.section_intent === undefined ? {} : { section_intent: input.section_intent }),
      ...(input.list_intent === undefined ? {} : { list_intent: input.list_intent }),
    });
  }

  /**
   * 换某个会话的**编号表**（`word/numbering.xml` 的模型侧）。
   *
   * 透传到会话层的 `setNumbering`——**字节的变化与摘要的重算都在那一层发生**，
   * 宿主不自己导出、不自己算摘要（那会造出第二个真相源）。
   */
  setSessionNumbering(sessionId: string, table: NumberingTable | null): SessionResult<NumberingTable | null> {
    const entry = this.#entries.get(sessionId);
    if (entry === undefined) {
      return failSession('session_not_found', `没有会话 ${sessionId}`, sessionId);
    }
    return entry.session.setNumbering(table);
  }

  /** 当前编号表（只读旁证；`null` = 本会话没有编号表）。 */
  sessionNumbering(sessionId: string): NumberingTable | null | undefined {
    return this.#entries.get(sessionId)?.session.numberingTable();
  }

  // --- 下载某一版 ---------------------------------------------------------

  /**
   * 取某一编辑版本的字节。
   *
   * 走的是**物化端口的回读**（盘上的真实字节），而不是"内存里的模型重新导出一次"：
   * 下载面必须证明"盘上那份就是当初交付的那份"，否则下载就成了自我复述。
   */
  async versionBytes(sessionId: string, editRevision: EditRevision): Promise<VersionBytes | undefined> {
    const entry = this.#entries.get(sessionId);
    if (entry === undefined) return undefined;
    const version = entry.session.publishedAt(editRevision);
    if (version === null) return undefined;
    const documents = this.#documents;
    if (documents === null) return undefined;
    let bytes: Uint8Array | undefined;
    try {
      bytes = await documents.readBack(version.artifact_id);
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
      // 本链只交付 DOCX：值来自 protocol 的单一来源，不在此另抄字面量。
      file_format: 'docx' as FileFormat,
      mime_type: DOCUMENT_MIME,
      template_kind: 'document' as TemplateKind,
    });
  }

  // --- 内部：内核登记 -----------------------------------------------------

  #registerKernelTask(input: {
    readonly taskId: TaskId;
    readonly groupId: GroupId;
    readonly instanceId: InstanceId;
    readonly sourceFactRef: ReturnType<typeof asFactRef>;
    readonly sessionId: string;
    readonly mode: 'new' | 'import';
    readonly documentId: string;
    /**
     * 内核任务的**起始版本**。
     *
     * 省略时为 `r1`（新建会话没有可续的历史）。**恢复**时**必须**传
     * {@link resumeRevisionOf} 的结果，否则重启后版本从零重算 ⇒ 产物 id 与落点撞上
     * 重启前那份不同字节的产物 ⇒ 被端口如实拒绝（502）。理由与 `deriveArtifactId`
     * 的纯函数性写在 {@link DocumentSessionHost.restoreSession} 的注释里。
     */
    readonly start_revision?: Revision;
  }): KnownFactSnapshotEntry {
    // 两处形状**不同**，刻意分开写清楚：
    // - 共享事实记录（`SharedFactRecord.value`）是 `{kind:'known', value:<内层>}`；
    // - 物化快照（`KnownFactSnapshotEntry.value`）**直接就是内层**（快照只可能装已知值）。
    const text = `${
      input.mode === 'import' ? '用户导入的既有文档' : '用户新建的文档'
    }（文档 id ${input.documentId}）`;
    const inner = Object.freeze({ type: 'text' as const, text, source: `会话 ${input.sessionId}` });
    // **不是** user_confirmation：它记录"文档从哪来"，不表示文档内容已被核实（R148）。
    const source = Object.freeze({
      kind: 'external' as const,
      detail:
        '文档来源登记（含义是"这份文档从哪来"；不表示正文事实已核实，也不得冒充用户确认）',
    });
    const snapshotEntry: KnownFactSnapshotEntry = Object.freeze({
      fact_ref: input.sourceFactRef,
      fact_key: SOURCE_FACT_KEY,
      value: inner,
      source,
    });

    if (this.#store.snapshot().tasks.some((task) => task.task_id === input.taskId)) {
      return snapshotEntry;
    }
    const at = asLogicalTime(this.#clock.now());
    const revision: Revision = input.start_revision ?? asRevision(1);
    this.#store.transact((tx) => {
      tx.putTask(
        createTaskRecord({
          task_id: input.taskId,
          title: `文档会话 ${input.sessionId}`,
          goal:
            (input.mode === 'import'
              ? `在导入的既有 Word 文档上执行编辑并交付新版本（文档 ${input.documentId}）`
              : `新建 Word 文档并连续编辑交付（文档 ${input.documentId}）`) +
            `；运行实例 ${this.#options.run_id}`,
          current_group_id: input.groupId,
          deliverables: ['一份可编辑的 Word 文档（按编辑修订逐版交付）'],
          revision,
          created_at: at,
          updated_at: at,
        }),
      );
      tx.putInstance(
        createInstanceState({
          instance_id: input.instanceId,
          group_id: input.groupId,
          updated_at: at,
        }),
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
          fact_key: SOURCE_FACT_KEY,
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

  /**
   * 构造某个会话的发布端口。
   *
   * 每次发布：**内核任务版本递增 → 落 staged 记录 → 写盘回读 → 发布投影 → published**。
   * 任一步失败都返回结构化失败，把"旧文件保留"与"未交付"如实交给会话层。
   */
  #publishPortFor(
    sessionId: string,
    taskId: TaskId,
    instanceId: InstanceId,
    holder: SourceFactHolder,
  ): DocumentPublishPort {
    return {
      publish: (request: DocumentPublishRequest): Promise<DocumentPublishResult> =>
        this.#publish({ sessionId, taskId, instanceId, holder, request }),
    };
  }

  async #publish(input: {
    readonly sessionId: string;
    readonly taskId: TaskId;
    readonly instanceId: InstanceId;
    readonly holder: SourceFactHolder;
    readonly request: DocumentPublishRequest;
  }): Promise<DocumentPublishResult> {
    const documents = this.#documents;
    if (documents === null) {
      return {
        ok: false,
        failure: {
          kind: 'document_port_unavailable',
          detail: '文档端口未接入：无法写盘，因此不交付（绝不用直接写文件顶替）',
        },
      };
    }
    const { request } = input;
    const clock = this.#clock;
    const at = asLogicalTime(clock.now());
    const friendlyName = stripDocxSuffix(request.filename);
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

    // ① 内核任务版本递增（**用内核自己的 patch 语义**：deliverables 变更是实质性变更）。
    //    这就是本次发布的 `taskRevision`；它不是宿主自己数的数。
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
              value: [`Word 文档（编辑版本 ${String(request.edit_revision)}）`],
            },
          ]),
          at,
        );
        tx.putTask(bumped);

        const artifactVersion = resolveNextArtifactVersion(tx, input.taskId, 'document');
        const artifactPlan: ArtifactPlan = planArtifact({
          task_id: input.taskId,
          task_revision: bumped.revision,
          template_kind: 'document',
          artifact_version: artifactVersion,
          root_dir: this.#options.artifact_root_dir,
          expected_content_digest: request.expected_digest,
        });
        const record = createArtifactRecord({
          artifact_id: artifactPlan.artifact_id,
          task_id: input.taskId,
          task_revision: bumped.revision,
          artifact_version: artifactVersion,
          template_kind: 'document',
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
                `${String(request.edit_revision)}）；发布前投影还会再核对一次`,
            },
          ],
          created_at: at,
        });
        tx.putArtifact(record);
        const materializationRequest: ArtifactMaterializationRequest = Object.freeze({
          artifact_id: artifactPlan.artifact_id,
          task_id: input.taskId,
          task_revision: artifactPlan.task_revision,
          template_kind: 'document',
          // 编辑链的内容来自"导入 / 用户编辑"，不是从共享事实**装配**出来的；
          // 快照里只放那条**来源事实**（它是记录里 `source_fact_refs` 的对应物），
          // 不放任何"数字事实"——这条链上没有数字需要指认。
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

    // ② 外部副作用（写盘 + 回读）**只发生在任何事务之外**（info-006）。
    let memoResult: ArtifactMaterializationResult;
    try {
      memoResult = await this.#materializeFact(documents, fact, at, friendlyName);
    } catch (error) {
      memoResult = materializationFailure(
        fact.request,
        'write_failed',
        `文档端口抛出异常：${describe(error)}`,
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

    // ④ 版本闸门 + 段 3（与生成链**同一个**发布投影）。
    clock.advance(1, `publish session ${input.sessionId} revision ${String(request.edit_revision)}`);
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
          detail: `${failure.detail}（原文档与既有版本均未改动）`,
        }),
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

  /** 写盘 + 回读 + 结构自检 + 摘要核对（与生成链同口径；失败一律结构化）。 */
  async #materializeFact(
    documents: DocumentPort,
    fact: StagedArtifactFact,
    at: LogicalTime,
    friendlyName: string,
  ): Promise<ArtifactMaterializationResult> {
    const artifactId = String(fact.record.artifact_id);
    const request = fact.request;
    const payload = request.payload;
    if (payload === undefined) {
      return materializationFailure(
        request,
        'builder_failed',
        '物化请求缺少 payload 字节：本版不自行重建，按失败收尾',
        at,
      );
    }

    let receipt: { readonly path: string; readonly sha256: string; readonly byteLength: number };
    try {
      receipt = await documents.materialize({
        artifactId,
        // 文件名走 S5 的白名单规范化函数（与生成链同一条路）：客户端给的名字不能直接进
        // 路径，也不该让下载下来的名字不可读。
        filename: normalizeDocxFilename(friendlyName, 'document'),
        bytes: payload,
        expectedSha256: fact.record.content_digest,
      });
    } catch (error) {
      return materializationFailure(request, 'write_failed', `写盘失败：${describe(error)}`, at);
    }

    let back: Uint8Array | undefined;
    try {
      back = await documents.readBack(artifactId);
    } catch (error) {
      return materializationFailure(request, 'write_failed', `回读失败：${describe(error)}`, at);
    }
    if (back === undefined) {
      return materializationFailure(
        request,
        'write_failed',
        '写盘后回读不到该文件：不得据此声称已交付',
        at,
      );
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
      verifier: 'demo-host/document-port（宿主对最终路径的实际回读）',
      at: asLogicalTime(at),
    });
    return materializationSuccess(fullReceipt);
  }

  #persistenceFor(sessionId: string): SessionPersistenceLike {
    return this.#options.session_persistence?.(sessionId) ?? createMemorySessionPersistence();
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * 内核任务的**续期起点**：会话已发布记录里的最大 `task_revision`（没有则为 `r1`）。
 *
 * ## 为什么必须有这个函数（FA-FIX-ARTIFACT-ID-COLLISION 的根因）
 *
 * 产物 id 与落点是 `deriveArtifactId` / `planArtifact`（`src/artifacts/planner.ts`）算出来的，
 * 输入恰是四元组 `(task_id, task_revision, template_kind, artifact_version)`，**纯函数、
 * 无计数器、无随机数**。而本宿主的 `#store` 是进程内 `createMemoryStore`：重启后 store 空，
 * `#registerKernelTask` 若又从 `r1` 重新登记任务、`resolveNextArtifactVersion` 又从 1 起重数，
 * 恢复后的**第一次发布**就会重算出**与重启前同一个 id 与同一条落盘路径**；
 * 盘上那份是**另一次编辑的另一份字节**，物料端口按"不覆盖、不交付"如实拒绝 ⇒ 502。
 *
 * ## 修法为什么是"续版本"而不是"覆盖"
 *
 * 起始版本取**会话自己持久化下来的最大已发布 `task_revision`**（会话状态里 `published`
 * 每成功一版记一行，且失败不记）⇒ 重新登记的任务版本严格大于重启前的任何一版
 * ⇒ 新发布的 `task_revision` 与 id、路径**同时变新**，撞号不再发生。
 * 这条**没有**放宽端口的安全判据：真出现"同名不同字节"（例如上一次发布写盘成功、
 * 但会话状态还没来得及落盘就断电），端口仍然拒绝、不静默覆盖。
 */
function resumeRevisionOf(session: DocumentSession): Revision {
  let max = 1;
  for (const version of session.publishedVersions()) {
    if (version.task_revision >= max) {
      max = version.task_revision;
    }
  }
  return asRevision(max);
}

/** 去掉 `.docx` 后缀（`normalizeDocxFilename` 自己会补回来，避免出现 `x.docx.docx`）。 */
function stripDocxSuffix(filename: string): string {
  return filename.replace(/\.docx$/i, '');
}

function outcomeFailed(outcomes: readonly { readonly kind: string }[]): boolean {
  return outcomes.some((outcome) => outcome.kind === 'failed' || outcome.kind === 'unrecorded');
}

function toForwardSlashes(path: string): string {
  return path.split('\\').join('/');
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

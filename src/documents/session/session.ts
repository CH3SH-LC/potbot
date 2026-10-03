/**
 * **文档会话**（design-05-P8 / WF-081–090；合同 R132–R146）。
 *
 * ## 一次提交 = 一个事务 = 一次编辑版本 = 一次交付（R136/R138/R144）
 *
 * `submitEdit()` 是这门课唯一的写入口，它把"改文档"和"交出文件"绑成**一次事务**：
 *
 * ```text
 * ① 幂等键查表（R137/R146：命中同输入 ⇒ 原样返回既有回执，不重放、不产第二版）
 * ② 基线核对（R142/R143：baseRevision + baseDigest 任一不符 ⇒ 拒绝 + 当前版本）
 * ③ 意图 → 计划（R133/R134：受限、确定性；不支持的能力在这里被拒，文档零改动）
 * ④ 应用计划（R136：整批成功才产出新模型；失败 ⇒ 不动）
 * ⑤ 导出新字节 + 摘要
 * ⑥ 发布（R144：由注入端口做"原子写盘 + 回读"）
 *    ├─ 成功 ⇒ 采纳新模型、记映射行、记幂等、记日志
 *    └─ 失败 ⇒ **丢弃新模型**（旧文件与旧版本一个字节都不变，R145），只记失败
 * ```
 *
 * 全成功或全不修改。**不存在"编辑成了但没交付、上层以为成了"的中间态**——
 * 第 ⑥ 步失败时 `applyEditPlan` 的产物在内存里被直接丢掉，会话回到提交前的状态。
 *
 * ## 三个号分开建模（R141）
 *
 * 编辑版本由本层维护；`taskRevision` 与 `artifactVersion` 由**发布端口**在回执里带回来
 * （它们归内核记账，本层不猜也不派生）。三者只在 {@link PublishedVersion} 这一张表里相遇，
 * 而表的一行只在回执到手后追加。见 `docs/…` 与 `types.ts` 的对照表。
 *
 * ## 本文件不做的事
 *
 * - **不做文件 IO**：持久化走 {@link SessionPersistence}，写盘走 {@link DocumentPublishPort}；
 * - **不换算单位**（R128：`src/documents/units/**`）；
 * - **不拼 XML**（R107：`src/documents/docx/**`）；
 * - **不解析自然语言**（R134：模型产意图，`intent.ts` 校验后翻计划）。
 */

import { DocxError, exportDocx, importDocx } from '../docx/index.js';
import { applyEditPlan } from '../edit/plan.js';
import type { EditPlan } from '../edit/plan.js';
import type { DocumentModel } from '../model/index.js';
import type { NumberingTable } from '../numbering/types.js';
import { succeed } from '../selection/types.js';
import { digestBytes, fingerprint } from './canonical.js';
import { compileEditIntent } from './intent.js';
import { applyListPlan, compileListIntent } from './list-ops.js';
import { applySectionPlan, compileSectionIntent } from './section-ops.js';
import type { SectionEditPlan, SectionEditStepReport } from './section-ops.js';
import {
  SESSION_SCHEMA,
  type ContentDigest,
  type DocumentPublishPort,
  type DocumentPublishRequest,
  type DocumentPublishResult,
  type EditRevision,
  type HistoryCommandInput,
  type HistoryOperationKind,
  type HistoryOutcome,
  type HistoryView,
  type IdempotencyRecord,
  type OperationLogEntry,
  type OperationLogKind,
  type PublishedVersion,
  type PublicationFailureRecord,
  type SessionFailure,
  type SessionFailureDetail,
  type SessionId,
  type SessionPersistence,
  type SessionResult,
  type SessionState,
  type SessionStepReport,
} from './types.js';

// ---------------------------------------------------------------------------
// 入参 / 出参
// ---------------------------------------------------------------------------

export interface DocumentSessionOptions {
  readonly id: SessionId;
  /**
   * 期望的文档 id（R103 三要素之一）。**省略时取模型自己的 `document_id`**。
   *
   * 为什么可以省略：文档 id 是**导入时由包决定的**（D02 的 `importDocx` 从包内容派生），
   * 不是调用方随口指定的。把"选项里的 id"当成真相，会和模型里的 id 分成两个真相源；
   * 给了就**核对**，不给就**沿用模型**——两种情况下最终都只有一个 id。
   */
  readonly document_id?: string;
  readonly filename: string;
  readonly persistence: SessionPersistence;
  readonly publish_port: DocumentPublishPort;
  /**
   * 墙钟（只用于日志与元数据；**不参与任何判定**）。
   *
   * **必填**，不给默认值。理由不是洁癖：本仓有一条机器化纪律
   * （`tests/acceptance/office/w-disc-kernel-discipline.test.ts`，R50.4）要求
   * `src/**` 的代码里**不出现任何墙钟调用** ——内核层读墙钟必须显式注入，
   * 这样"同一输入 + 同一时刻 ⇒ 同一输出"才是可复算的。给一个"取当前时间"的默认值
   * 会把这条纪律从后门放走。
   */
  readonly now: () => Date;
  /** 操作日志上限；`null` = 不限制。超出时丢最旧的（日志是审计面，不是状态面）。 */
  readonly max_log_entries?: number | null;
  /**
   * 撤销栈上限；`null` = 不限制。默认 100（与 Word 的量级一致）。
   *
   * 历史**只在内存里**（不进 `SessionState`，不进盘）：进程被杀重开后撤销栈为空，
   * 这是 WF-086 预先约定的跨保存行为（见 {@link HistoryOutcome}）。
   */
  readonly max_undo?: number | null;
  /**
   * 起始**编号表**（`word/numbering.xml` 的模型侧；省略 = 本会话没有编号表）。
   *
   * 为什么在选项里而不在模型里：编号表的定义侧**刻意不在**冻结骨架里
   * （见 `src/documents/numbering/types.ts` 头部），只能由调用方带进导出器。
   * 给了它就**每次导出都带上**（含构造期的摘要计算、`exportBytes`、`submitEdit` 的发布），
   * 所以"会话状态里的编号表"与"盘上字节"不会分叉。
   */
  readonly numbering?: NumberingTable | null;
}

/**
 * 新建会话的起点（WF-081）。
 *
 * ## 为什么"新建"要**给一份包字节**，而不是"从零拼一个 DOCX"
 *
 * `exportDocx` 的职责是"包 → 模型 → 包"的**往返**，它**不从零造包**：模型里必须有
 * 包级 `officeDocument` 关系与主部件原始字节，否则导出显式失败（不猜路径）。
 * 这是 D02 的边界，也是 R107（"模型 ↔ OOXML 的转换集中在 docx 子模块"）的直接后果——
 * 本层若自己拼 `[Content_Types].xml` / `.rels`，既越了界，又造出第二个（必然分叉的）包生成器。
 *
 * 因此"新建"= **从一份真实包开始**（空白模板、上一次生成的文件、用户给的空壳都可以）。
 * 这同时消掉了产品的 2–4 段上限：**本层对段数没有任何限制**，
 * [`DOCX_MAX_BODY_PARAGRAPHS`] 是"按短文生成"那条链的上限，不是文档会话的上限。
 */
export interface NewDocumentContent {
  /** 起始包字节（真实 DOCX）。 */
  readonly template: Uint8Array;
}

/** 一次编辑提交。 */
export interface SubmitEditInput {
  /** 调用方生成的幂等键；客户端重试**必须复用同一个键**（R146）。 */
  readonly idempotency_key: string;
  /** 本操作所基于的编辑版本（R103 的 `baseRevision`）。 */
  readonly base_revision: EditRevision;
  /** 本操作所基于的**内容摘要**（R142：与 revision 一起绑定）。 */
  readonly base_digest: ContentDigest;
  /**
   * 结构化意图（本波的首选入口，R134）。与 `plan` / `section_intent` **三选一**。
   *
   * 未来由受约束的模型产出；现在由页面/命令行直接给出。直接格式命令走它 ⇒ **零模型**。
   */
  readonly intent?: unknown;
  /** 已结构化的操作计划（受限路径：调用方已在别处用 `compileEditIntent` 校验过）。 */
  readonly plan?: EditPlan;
  /**
   * **节编辑意图**（WF-045–055 的产品路径接入；形状见 `section-ops.ts`）。
   *
   * 为什么不是 `plan` 的一个变体：节操作的**作用域语法**（节索引）与文本编辑的
   * **范围表达式**（`第2段` / `全文`）不同，执行器也不同（`applySectionPlan` ↔ `applyEditPlan`）。
   * 混进一个 `steps` 数组会造出"这一步的范围是段落还是节"这种没法回答的问题，
   * 因此三条路各走各的，`submitEdit` 只保证"**恰好一条**被用到"。
   */
  readonly section_intent?: unknown;
  /**
   * **列表编辑意图**（WF-035–044 的产品路径接入；形状见 `list-ops.ts`）。
   *
   * 为什么又是独立一条而非 `plan` 的变体：列表操作要判"这个 `numId` 指得对不对"就必须拿到
   * **编号表**（定义在 `word/numbering.xml`，刻意不在冻结骨架里），而 `applyEditPlan(model, plan)`
   * 的签名只收模型；`EditOperation` 也只有 character / paragraph 两域。给共享执行器加第三个参数
   * 要改一个主协调者独占的文件——于是与 `section_intent` 采取同一条路线：**会话包内自成一个域**。
   *
   * 应用列表可能**创建**编号实例（"编号表是旁表"），成功时由会话**一并采纳**新表
   * （见 `AppliedEdit.numbering`），从而"状态里的表"与"交出的 `numbering.xml`"不会分叉。
   */
  readonly list_intent?: unknown;
}

export interface SubmitEditOutcome {
  /** 命中幂等键：**没有**产生第二个版本，回执是第一次的。 */
  readonly replayed: boolean;
  /** 计划合法且执行成功，但**没有一步真的改动模型**（幂等空转）⇒ 不产生新版本。 */
  readonly no_op: boolean;
  /** 本次提交后**当前**的编辑版本。 */
  readonly edit_revision: EditRevision;
  readonly steps: readonly SessionStepReport[];
  /** 当前已交付版本（从未发布过时为 `null`）。 */
  readonly published: PublishedVersion | null;
}

/** 会话状态（`GET /api/sessions/:id` 的语义来源）。 */
export interface SessionStatusView {
  readonly session_id: SessionId;
  readonly document_id: string;
  readonly filename: string;
  readonly created_at: string;
  readonly edit_revision: EditRevision;
  readonly content_digest: ContentDigest;
  readonly source_kind: SessionState['source_kind'];
  /** 导入文档的原始上传字节摘要（新建会话为 `null`）。 */
  readonly source_digest: ContentDigest | null;
  /** 版本映射（R141）：**编辑版本 → {taskRevision, artifactVersion, 回读摘要}**。 */
  readonly published: readonly PublishedVersion[];
  readonly current: PublishedVersion | null;
  readonly last_failure: PublicationFailureRecord | null;
  readonly log: readonly OperationLogEntry[];
}

export interface RestoreResult {
  readonly loaded: boolean;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export class DocumentSession {
  readonly #options: DocumentSessionOptions;
  readonly #now: () => Date;
  readonly #maxLog: number | null;
  #model: DocumentModel;
  #revision: EditRevision;
  #contentDigest: ContentDigest;
  #sourceKind: SessionState['source_kind'];
  #createdAt: string;
  #published: PublishedVersion[];
  #lastFailure: PublicationFailureRecord | null;
  #log: OperationLogEntry[];
  #idempotency: IdempotencyRecord[];
  #seq: number;

  /** 撤销栈：每次**成功的、改变内容的**提交之前的状态（最旧在前，栈顶在末尾）。 */
  #history: ModelSnapshot[];
  /** 重做栈：被撤销掉的状态（撤销时入栈，新的提交清空它）。 */
  #future: ModelSnapshot[];
  #maxUndo: number | null;
  /**
   * 撤销/重做的幂等记录（**内存态**，与 `#history` 同生命周期）。
   *
   * 为什么不去挤 `#idempotency`：那条表要持久化、且只存 `steps`，
   * 而 `HistoryOutcome` 需要 `restored_from_revision` 等字段才能被原样重放；
   * 硬塞会逼出一个"存不下"的形状。撤销栈本身不跨进程，它的幂等表也就不必跨进程。
   */
  #historyKeys: Map<string, { readonly fingerprint: string; readonly outcome: HistoryOutcome }>;

  /** 导入文档的**原始上传字节**摘要（新建会话为 `null`）。与 `content_digest` 不混用。 */
  #sourceDigest: ContentDigest | null;
  /** 当前文件名（`rename()` 会改它；既有版本各自保留发布时的名字）。 */
  #filename: string;
  /** 文档 id（真相源是模型；选项给了就核对过）。 */
  #documentId: string;
  /**
   * 当前编号表（`word/numbering.xml` 的模型侧）。`null` = 不传 `options.numbering`。
   *
   * **每次导出都带上它**（构造期摘要、`exportBytes`、`submitEdit` 的发布三条路径同一个出口），
   * 因此"状态里的表"与"交出的字节"不可能分叉。
   */
  #numbering: NumberingTable | null;

  private constructor(
    options: DocumentSessionOptions,
    seed: {
      readonly model: DocumentModel;
      readonly content_digest: ContentDigest;
      readonly source_kind: SessionState['source_kind'];
      readonly source_digest: ContentDigest | null;
      readonly created_at: string;
    },
  ) {
    this.#options = options;
    this.#now = options.now;
    this.#maxLog = options.max_log_entries === undefined ? 2000 : options.max_log_entries;
    this.#model = seed.model;
    this.#revision = seed.model.revision;
    this.#contentDigest = seed.content_digest;
    this.#sourceKind = seed.source_kind;
    this.#sourceDigest = seed.source_digest;
    this.#filename = options.filename;
    this.#documentId = seed.model.document_id;
    this.#numbering = options.numbering ?? null;
    this.#createdAt = seed.created_at;
    this.#published = [];
    this.#lastFailure = null;
    this.#log = [];
    this.#idempotency = [];
    this.#seq = 0;
    this.#history = [];
    this.#future = [];
    this.#maxUndo = options.max_undo === undefined ? 100 : options.max_undo;
    this.#historyKeys = new Map();
  }

  // --- 构造 ---------------------------------------------------------------

  /**
   * 新建一份文档（WF-081）：以给定的包字节为起点。
   *
   * 内容来源记为 `user_request`（这是"用户要的文档"，不是导入的既有资料）——
   * 来源区分是 R109/R148 的硬要求，`imported` **不得**被升格成用户已确认。
   */
  static createNew(
    options: DocumentSessionOptions,
    content: NewDocumentContent,
  ): SessionResult<DocumentSession> {
    return DocumentSession.#open(options, content.template, 'user_request', 'session_created');
  }

  /**
   * 导入既有 DOCX（WF-082）。
   *
   * 导入**不改写**原字节：`importDocx` 保留未知部件与 rId（R105/R106），
   * 导入结果里的每个 run 携带 `imported` 来源（R109），因此**不得**被当作
   * 用户已确认事实灌进事实快照（R148）——`source_kind` 如实记为 `imported`。
   */
  static importFrom(
    options: DocumentSessionOptions,
    bytes: Uint8Array,
  ): SessionResult<DocumentSession> {
    return DocumentSession.#open(options, bytes, 'imported', 'imported');
  }

  /** 两个公开构造出口的共用实现（差异只有**来源标记**与日志种类）。 */
  static #open(
    options: DocumentSessionOptions,
    bytes: Uint8Array,
    sourceKind: SessionState['source_kind'],
    logKind: OperationLogKind,
  ): SessionResult<DocumentSession> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      return sessionFail('import_failed', '起始包字节为空或不是 Uint8Array', {
        extra: { stage: 'open' },
      });
    }
    let model: DocumentModel;
    try {
      model = importDocx(bytes);
    } catch (error) {
      const reason = error instanceof DocxError ? error.reason : 'unknown';
      return sessionFail('import_failed', `读取起始包失败（${reason}）：${describeError(error)}`, {
        extra: { stage: 'open', reason },
      });
    }
    const now = options.now();
    if (options.document_id !== undefined && options.document_id !== model.document_id) {
      return sessionFail(
        'mismatched_document',
        `选项给出的 document_id（${options.document_id}）与包里的文档 id（${model.document_id}）不符：` +
          '文档身份以包为准，不得由调用方另行指定',
        { extra: { stage: 'open' } },
      );
    }
    const session = new DocumentSession(options, {
      model,
      // 当前摘要 = **模型导出的字节**摘要：编辑基线必须是它，否则第一次编辑会被自己的
      // 基线核对拒掉。原始起始包的摘要另存 `source_digest`，用于"起始包 → 导出"的保真
      // 断言（R151）——两份摘要各有用途，不混用。
      content_digest: digestBytes(exportOrThrow(model, 'open', options.numbering ?? null)),
      source_kind: sourceKind,
      source_digest: digestBytes(bytes),
      created_at: now.toISOString(),
    });
    return session.#afterConstruction(logKind);
  }

  /**
   * 从持久化载体恢复（WF-083：保存并重新打开）。
   *
   * 形状核对在本层做（端口不负责验证）：schema 不符 / 缺字段 / 模型不合法 ⇒ **按失败如实返回**，
   * 由调用方决定是新建还是报错——**不静默**拿一个半截会话继续用。
   */
  static restore(options: DocumentSessionOptions): { session: DocumentSession | null; result: RestoreResult } {
    const raw = options.persistence.load();
    if (raw === null || raw === undefined) {
      return { session: null, result: { loaded: false, reason: '没有既存会话状态（首次）' } };
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return { session: null, result: { loaded: false, reason: '会话状态形状不合法（不是对象）' } };
    }
    const state = raw as Partial<SessionState>;
    if (state.schema !== SESSION_SCHEMA) {
      return {
        session: null,
        result: {
          loaded: false,
          reason: `会话 schema 不匹配（期望 ${SESSION_SCHEMA}，收到 ${String(state.schema)}）`,
        },
      };
    }
    if (typeof state.session_id !== 'string' || state.session_id !== options.id) {
      return {
        session: null,
        result: {
          loaded: false,
          reason: `会话 id 不符（期望 ${options.id}，收到 ${String(state.session_id)}）`,
        },
      };
    }
    if (typeof state.model !== 'object' || state.model === null) {
      return { session: null, result: { loaded: false, reason: '会话状态缺少模型' } };
    }
    const model = state.model as DocumentModel;
    if (options.document_id !== undefined && model.document_id !== options.document_id) {
      return {
        session: null,
        result: {
          loaded: false,
          reason: `模型 document_id 与选项不符（${String(model.document_id)} ≠ ${options.document_id}）`,
        },
      };
    }

    const session = new DocumentSession(options, {
      // 恢复出来的状态里没有字节，摘要只能**当场从模型重算**——这正好把
      // "状态里的摘要"与"模型的真实导出"对齐一次（不一致会在下次导出时被抓住）。
      model,
      content_digest: digestBytes(exportOrThrow(model, 'restore', readNumbering(state))),
      source_kind: state.source_kind ?? 'system',
      source_digest: typeof state.source_digest === 'string' ? state.source_digest : null,
      created_at: typeof state.created_at === 'string' ? state.created_at : options.now().toISOString(),
    });
    session.#numbering = readNumbering(state);
    session.#revision = typeof state.edit_revision === 'number' ? state.edit_revision : model.revision;
    session.#published = [...(state.published ?? [])];
    session.#lastFailure = state.last_failure ?? null;
    session.#log = [...(state.log ?? [])];
    session.#idempotency = [...(state.idempotency ?? [])];
    session.#seq = session.#log.reduce((max, entry) => Math.max(max, entry.seq), 0);
    return {
      session,
      result: Object.freeze({ loaded: true, reason: `读回会话 ${options.id}（编辑版本 ${String(session.#revision)}）` }),
    };
  }

  /** 构造完成后的统一收尾：落一次日志 + 持久化。 */
  #afterConstruction(kind: OperationLogKind): SessionResult<DocumentSession> {
    this.#appendLog({
      kind,
      base_revision: this.#revision,
      result_revision: this.#revision,
      idempotency_key: null,
      plan_digest: null,
      ranges: [],
      hit_counts: [],
      changed: true,
      rejection: null,
    });
    this.#persist();
    return succeed(this);
  }

  // --- 只读视图 -----------------------------------------------------------

  get id(): SessionId {
    return this.#options.id;
  }

  get documentId(): string {
    return this.#documentId;
  }

  get filename(): string {
    return this.#filename;
  }

  /** R141 号 ①：当前编辑版本。 */
  currentRevision(): EditRevision {
    return this.#revision;
  }

  /** 当前模型导出的字节摘要。 */
  currentDigest(): ContentDigest {
    return this.#contentDigest;
  }

  /** 版本映射表（R141）：编辑版本 → 内核 taskRevision / artifactVersion。 */
  publishedVersions(): readonly PublishedVersion[] {
    return Object.freeze([...this.#published]);
  }

  /** 最近一次成功交付；从未交付过时为 `null`（"没交付"必须有结构化的表达）。 */
  currentPublished(): PublishedVersion | null {
    return this.#published.length === 0 ? null : (this.#published[this.#published.length - 1] ?? null);
  }

  publishedAt(editRevision: EditRevision): PublishedVersion | null {
    return this.#published.find((version) => version.edit_revision === editRevision) ?? null;
  }

  operationLog(): readonly OperationLogEntry[] {
    return Object.freeze([...this.#log]);
  }

  lastFailure(): PublicationFailureRecord | null {
    return this.#lastFailure;
  }

  /** 当前模型（只读视图；改写只能经 `submitEdit`）。 */
  model(): DocumentModel {
    return this.#model;
  }

  /** 当前编号表（只读视图；`null` = 本会话没有编号表）。 */
  numberingTable(): NumberingTable | null {
    return this.#numbering;
  }

  status(): SessionStatusView {
    return Object.freeze({
      session_id: this.#options.id,
      document_id: this.#documentId,
      filename: this.#filename,
      created_at: this.#createdAt,
      edit_revision: this.#revision,
      content_digest: this.#contentDigest,
      source_kind: this.#sourceKind,
      source_digest: this.#sourceDigest,
      published: Object.freeze([...this.#published]),
      current: this.currentPublished(),
      last_failure: this.#lastFailure,
      log: Object.freeze([...this.#log]),
    });
  }

  // --- 重命名（WF-081："重命名不混淆身份"） --------------------------------

  /**
   * 改文件名。
   *
   * **只影响之后发布的版本**：既有版本在映射表里各自保留自己发布时的文件名与 artifact id
   * ——"重命名"因此不会把旧交付物从历史里抹掉，也不会让两个不同版本共用一个路径。
   * `document_id` 与 `session_id` **都不变**：名字是标签，身份是 id。
   */
  rename(nextFilename: string): SessionResult<string> {
    if (typeof nextFilename !== 'string' || nextFilename.trim().length === 0) {
      return sessionFail('invalid_range', '文件名不能为空', { extra: { stage: 'rename' } });
    }
    if (!/\.docx$/i.test(nextFilename)) {
      return sessionFail('invalid_range', '文件名必须以 .docx 结尾（本会话只产出 DOCX）', {
        extra: { stage: 'rename', filename: nextFilename },
      });
    }
    const previous = this.#filename;
    this.#filename = nextFilename;
    this.#appendLog({
      kind: 'session_created',
      base_revision: this.#revision,
      result_revision: this.#revision,
      idempotency_key: null,
      plan_digest: null,
      ranges: [],
      hit_counts: [],
      changed: true,
      rejection: null,
    });
    this.#persist();
    void previous;
    return succeed(nextFilename);
  }

  // --- 编号表（WCF-D50 报出的缺口在此闭合） --------------------------------

  /**
   * 换掉当前编号表（`word/numbering.xml` 的模型侧）。
   *
   * ## 为什么这是**状态操作**而不是一次 `submitEdit`
   *
   * 编号表是**引用表**：正文段落里存的是 `w:numId`（**引用**），定义住在 `word/numbering.xml`。
   * 换表改的是"这些引用指向什么"，不是文档内容的排布——它**不经过**范围解析与操作计划
   * （那两者是段落/字符域的），所以走 `submitEdit` 的三种意图都不合适。
   * 这里如实把它做成一次**有日志、有持久化、有摘要重算**的状态操作，
   * 而不是偷偷改一个字段。
   *
   * ## 编辑版本**不动**，但内容摘要**会变**
   *
   * 换表会改变导出的字节（这正是这条路径的意义），因此 `content_digest` 当场重算。
   * 编辑版本不 +1 的理由：`edit_revision` 是**文档内容**的版本（R141/R138 的撤销单元），
   * 而引用表不是文档内容。但既然字节变了，任何"拿着旧摘要提交编辑"的调用方
   * 都会在基线核对里被拒为 `stale_revision`（reason=digest）——这是**正确**的行为，
   * 不是副作用：盘上那份已经不是他手里那份了。
   *
   * 失败（表形状非法 / 导出失败）⇒ **原表原样保留**，状态不前进（R145 的同一条纪律）。
   */
  setNumbering(table: NumberingTable | null): SessionResult<NumberingTable | null> {
    if (table !== null) {
      const shape = checkNumberingShape(table);
      if (shape !== null) {
        return sessionFail('invalid_expression', `编号表形状非法：${shape}`, {
          extra: { stage: 'numbering' },
        });
      }
    }
    const previous = this.#numbering;
    let digest: ContentDigest;
    try {
      digest = digestBytes(exportWith(this.#model, table));
    } catch (error) {
      // 换表后导出不了 ⇒ 不采纳这次换表（旧表与旧摘要一个字节没变）。
      return sessionFail('export_failed', `换编号表后导出失败：${describeError(error)}`, {
        extra: { stage: 'numbering' },
      });
    }
    const changed = digest !== this.#contentDigest;
    this.#numbering = table;
    this.#contentDigest = digest;
    this.#appendLog({
      kind: 'edit_applied',
      base_revision: this.#revision,
      result_revision: this.#revision,
      idempotency_key: null,
      plan_digest: table === null ? null : fingerprint(table),
      ranges: [],
      hit_counts: [],
      changed,
      rejection: null,
    });
    this.#persist();
    void previous;
    return succeed(table);
  }

  // --- 导出 ---------------------------------------------------------------

  /**
   * 导出当前版本的字节。
   *
   * **每次都重算摘并与状态里的摘要比对**：不符即 `export_failed`。
   * 这一条是给"状态文件被换过 / 模型被别处改过"留的探针——宁可拒绝导出，
   * 也不要把一份来源不明的字节当成"这份文档"发布出去。
   */
  exportBytes(): SessionResult<Uint8Array> {
    let bytes: Uint8Array;
    try {
      bytes = exportWith(this.#model, this.#numbering);
    } catch (error) {
      return sessionFail('export_failed', `导出失败：${describeError(error)}`, {
        extra: { stage: 'export' },
      });
    }
    const digest = digestBytes(bytes);
    const expected = this.#contentDigest;
    if (expected !== digest) {
      return sessionFail(
        'export_failed',
        `导出摘要与当前状态记录不符（状态 ${expected} / 实算 ${digest}）：拒绝把来源不一致的字节当成本文档导出`,
        { extra: { stage: 'export', expected, actual: digest } },
      );
    }
    return succeed(bytes);
  }

  // --- 提交（唯一的写入口） -----------------------------------------------

  /**
   * 提交一次编辑（R132–R146 的全部约束都在这一条路径上）。
   *
   * 失败分支一律**不带模型**：调用方据此知道"文档没有任何改动"。
   */
  async submitEdit(input: SubmitEditInput): Promise<SessionResult<SubmitEditOutcome>> {
    if (typeof input.idempotency_key !== 'string' || input.idempotency_key.length === 0) {
      return sessionFail('idempotency_conflict', '必须给出非空的幂等键（R137）', {
        extra: { stage: 'idempotency' },
      });
    }

    // ③ 先编译（纯函数、零副作用）。编译失败 ⇒ 文档一个字节都没动（R140）。
    const compiled = this.#compile(input);
    if (!compiled.ok) {
      this.#logRejection(input, null, [], compiled.code, compiled.message);
      return compiled as SessionFailure;
    }
    const edit = compiled.value;

    // ① 幂等键查表：**先于**任何基线核对——网络重试带的是**原来的** baseRevision，
    //    此时会话已经前进了一版，若不先查幂等就会把一次成功提交误判成 stale。
    const planDigest = edit.digest;
    const fingerprintOfRequest = fingerprint({ base_revision: input.base_revision, plan_digest: planDigest });
    const replay = this.#idempotency.find((record) => record.key === input.idempotency_key);
    if (replay !== undefined) {
      if (replay.fingerprint !== fingerprintOfRequest) {
        const message =
          '这个幂等键已经用于另一次不同的编辑：请换一个幂等键，或按原输入重新提交';
        this.#logRejection(input, planDigest, edit.ranges, 'idempotency_conflict', message);
        return sessionFail('idempotency_conflict', message, {
          extra: { stage: 'idempotency', existing_revision: replay.edit_revision },
        });
      }
      const published = this.publishedAt(replay.edit_revision);
      return succeed({
        replayed: true,
        no_op: false,
        edit_revision: replay.edit_revision,
        steps: replay.steps,
        published,
      });
    }

    // ② 基线核对（R142/R143）：revision 与 digest **两个**都要对得上。
    if (input.base_revision !== this.#revision) {
      this.#logRejection(
        input,
        planDigest,
        edit.ranges,
        'stale_revision',
        `基于编辑版本 ${String(input.base_revision)}，当前 ${String(this.#revision)}`,
      );
      return sessionFail(
        'stale_revision',
        `本次编辑基于编辑版本 ${String(input.base_revision)}，当前已是 ${String(this.#revision)}：` +
          '请基于最新版本重新提交（迟到的结果不得覆盖或发布旧候选）',
        {
          currentRevision: this.#revision,
          requestedRevision: input.base_revision,
          extra: { reason: 'revision', stage: 'base' },
        },
      );
    }
    if (input.base_digest !== this.#contentDigest) {
      this.#logRejection(
        input,
        planDigest,
        edit.ranges,
        'stale_revision',
        '内容摘要与当前文档不符（reason=digest）',
      );
      return sessionFail(
        'stale_revision',
        '本次编辑携带的内容摘要与当前文档不符：你手上的是旧内容（迟到的结果不得套用到新内容上）',
        {
          currentRevision: this.#revision,
          requestedRevision: input.base_revision,
          extra: { reason: 'digest', stage: 'base', current_digest: this.#contentDigest },
        },
      );
    }

    // ④ 应用计划（R136：整批成功才产出新模型；失败**不带模型**）。
    //    文本计划走 `applyEditPlan`，节计划走 `applySectionPlan`——编译期已经二选一定死，
    //    这里只认编译产物自己的执行器（`edit.apply`），不在这里再判一次种类。
    const applied = edit.apply(this.#model);
    if (!applied.ok) {
      this.#appendLog({
        kind: 'edit_rejected',
        base_revision: this.#revision,
        result_revision: this.#revision,
        idempotency_key: input.idempotency_key,
        plan_digest: planDigest,
        ranges: edit.ranges,
        hit_counts: [],
        changed: false,
        rejection: { code: applied.code, message: applied.message },
      });
      this.#persist();
      return applied as SessionFailure;
    }

    const reports = applied.value.reports;
    const nextRevision = applied.value.model.revision;
    // 本轮执行**可能**改动了编号表（列表操作会创建实例）。它就是这一版的旁表；
    // 导出、摘要与最终采纳都用它，从而"状态里的表"与"交出的 numbering.xml"不分叉。
    const nextNumbering =
      applied.value.numbering === undefined ? this.#numbering : applied.value.numbering;
    let bytes: Uint8Array;
    try {
      bytes = exportWith(applied.value.model, nextNumbering);
    } catch (error) {
      // 导出失败 ⇒ 同发布失败：**新模型被丢弃**，旧文件完好（R145）。
      return this.#failWithoutAdopting(
        nextRevision,
        'export_failed',
        `导出失败（模型 → 字节）：${describeError(error)}`,
        input,
        planDigest,
        reports,
      );
    }
    const expectedDigest = digestBytes(bytes);

    // **空转的判据是字节**，不是"执行器自报 changed"。
    //
    // 为什么不看 `report.changed`：段落属性 helper（`src/documents/operations/paragraph/**`）
    // 是**值语义**的纯函数，值没变时也返回新对象，于是"再居中一次"会被报成 changed=true。
    // 用它做判据，就会凭空多出一版内容逐字节相同的文件——"版本"这个概念的稀释是静默的，
    // 而字节比对不会说谎：**导出的字节和当前版本一模一样 ⇒ 这次编辑没有改变文档**。
    if (expectedDigest === this.#contentDigest) {
      this.#appendLog({
        kind: 'edit_applied',
        base_revision: this.#revision,
        result_revision: this.#revision,
        idempotency_key: input.idempotency_key,
        plan_digest: planDigest,
        ranges: reports.map((report) => report.range),
        hit_counts: reports.map((report) => report.hitCount),
        changed: false,
        rejection: null,
      });
      this.#persist();
      return succeed({
        replayed: false,
        no_op: true,
        edit_revision: this.#revision,
        steps: reports,
        published: this.currentPublished(),
      });
    }

    // ⑤⑥ 发布（R144/R145）。端口负责原子写盘 + 回读 + 不覆盖旧文件。
    // 端口是**注入**的：它既可能结构化地返回失败，也可能直接抛异常。两者都必须收敛成
    // 同一种失败形态（`publish_failed`），否则这门唯一的写入口会变成"有时返回失败、
    // 有时抛出去"两种契约，调用方无从写一个确定的错误分支（W-R02 报出的缺口）。
    const published = await this.#publishPort({
      session_id: this.#options.id,
      edit_revision: nextRevision,
      document_id: this.#documentId,
      filename: this.#filename,
      bytes,
      expected_digest: expectedDigest,
      previous_digest: this.#published.length === 0 ? null : this.#contentDigest,
      idempotency_key: input.idempotency_key,
    });
    if (!published.ok) {
      // 端口抛出异常 ⇒ 与"端口返回失败"走**同一条收口**：新模型被丢弃，状态机不前进。
      return this.#failWithoutAdopting(
        nextRevision,
        'port_threw',
        `发布端口抛出异常：${published.detail}`,
        input,
        planDigest,
        reports,
      );
    }
    const result = published.result;

    if (!result.ok) {
      return this.#failWithoutAdopting(
        nextRevision,
        result.failure.kind,
        result.failure.detail,
        input,
        planDigest,
        reports,
      );
    }

    const receipt = result.receipt;
    // 回执摘要**必须**来自端口的实际回读（I-1）。这里再核一次：端口回读的摘要若与
    // 我们交出的字节不符，说明盘上躺着的不是我们算好的那份 —— 拒绝采纳，旧版本保留。
    if (receipt.readback_digest !== expectedDigest) {
      return this.#failWithoutAdopting(
        nextRevision,
        'readback_mismatch',
        `发布回执的回读摘要与导出摘要不符（回读 ${receipt.readback_digest} / 导出 ${expectedDigest}）：` +
          '拒绝采纳这一版（不得据未核对一致的字节声称交付）',
        input,
        planDigest,
        reports,
      );
    }

    const version: PublishedVersion = Object.freeze({
      edit_revision: nextRevision,
      task_revision: receipt.task_revision,
      artifact_version: receipt.artifact_version,
      artifact_id: receipt.artifact_id,
      content_digest: receipt.readback_digest,
      expected_digest: expectedDigest,
      byte_length: receipt.byte_length,
      entry_count: receipt.entry_count,
      filename: receipt.filename,
      published_at: this.#now().toISOString(),
    });

    // 全部成功 ⇒ 才采纳新模型、新旁表与新版本（此前 `this.#model` / `this.#numbering` / `this.#published`
    // 一个字节没变）。
    // WF-086/R138：这是**唯一**入撤销栈的点——一次成功的、改变内容的事务 = 一个撤销单元。
    // 放在采纳之前，快照的是**提交前**的状态；重做栈同时被清空（新的编辑抹掉重做历史）。
    this.#pushHistory();
    this.#model = applied.value.model;
    this.#numbering = nextNumbering;
    this.#revision = nextRevision;
    this.#contentDigest = receipt.readback_digest;
    this.#published = [...this.#published, version];
    this.#lastFailure = null;

    this.#appendLog({
      kind: 'edit_applied',
      base_revision: version.edit_revision - 1,
      result_revision: version.edit_revision,
      idempotency_key: input.idempotency_key,
      plan_digest: planDigest,
      ranges: reports.map((report) => report.range),
      hit_counts: reports.map((report) => report.hitCount),
      changed: true,
      rejection: null,
    });
    this.#appendLog({
      kind: 'published',
      base_revision: version.edit_revision,
      result_revision: version.edit_revision,
      idempotency_key: input.idempotency_key,
      plan_digest: planDigest,
      ranges: [],
      hit_counts: [],
      changed: true,
      rejection: null,
    });
    this.#idempotency = [
      ...this.#idempotency,
      Object.freeze({
        key: input.idempotency_key,
        fingerprint: fingerprintOfRequest,
        edit_revision: version.edit_revision,
        steps: reports,
        at: this.#now().toISOString(),
      }),
    ];
    this.#persist();

    return succeed({
      replayed: false,
      no_op: false,
      edit_revision: version.edit_revision,
      steps: reports,
      published: version,
    });
  }

  // --- 撤销 / 重做（WF-086 / R138） ---------------------------------------

  /** 是否有可撤销的提交（栈非空）。UI 据此灰化按钮，不猜。 */
  canUndo(): boolean {
    return this.#history.length > 0;
  }

  /** 是否有可重做的提交（栈非空）。 */
  canRedo(): boolean {
    return this.#future.length > 0;
  }

  /** 只读历史视图（不暴露栈内的模型快照）。 */
  history(): HistoryView {
    return Object.freeze({
      can_undo: this.#history.length > 0,
      can_redo: this.#future.length > 0,
      undo_depth: this.#history.length,
      redo_depth: this.#future.length,
      capacity: this.#maxUndo,
    });
  }

  /**
   * 撤销一次提交（WF-086）：把文档内容恢复成上一个已交付版本的内容。
   *
   * 落地为一次**向前的**新编辑版本（见 {@link HistoryOutcome} 的说明）；成功后
   * 被撤销的那一版内容进入重做栈。失败（基线不符 / 发布失败 / 栈空）⇒ **状态不动**。
   */
  async undo(input: HistoryCommandInput): Promise<SessionResult<HistoryOutcome>> {
    return this.#historyStep('undo', input);
  }

  /** 重做一次被撤销的提交：把内容恢复成撤销前的那一版（同样是向前的新版本）。 */
  async redo(input: HistoryCommandInput): Promise<SessionResult<HistoryOutcome>> {
    return this.#historyStep('redo', input);
  }

  /** 撤销 / 重做的共用实现（两者只差操作哪条栈、以及成功后如何搬动栈顶）。 */
  async #historyStep(
    kind: HistoryOperationKind,
    input: HistoryCommandInput,
  ): Promise<SessionResult<HistoryOutcome>> {
    if (typeof input.idempotency_key !== 'string' || input.idempotency_key.length === 0) {
      return sessionFail('idempotency_conflict', '必须给出非空的幂等键（R137）', {
        extra: { stage: 'idempotency' },
      });
    }

    const stack = kind === 'undo' ? this.#history : this.#future;
    if (stack.length === 0) {
      const code = kind === 'undo' ? 'nothing_to_undo' : 'nothing_to_redo';
      const message =
        kind === 'undo'
          ? '没有可撤销的提交（撤销栈为空——例如刚刚重开过会话，历史不跨进程）'
          : '没有可重做的提交（重做栈为空）';
      return sessionFail(code, message, { extra: { stage: kind } });
    }
    const target = stack[stack.length - 1] as ModelSnapshot;

    // 幂等（R137/R146）：同一键 + 同一输入 ⇒ 原样返回首次结果；同键不同输入 ⇒ 冲突。
    const fingerprintOfRequest = fingerprint({
      kind,
      base_revision: input.base_revision,
      target_revision: target.revision,
      target_digest: target.digest,
    });
    const replay = this.#historyKeys.get(input.idempotency_key);
    if (replay !== undefined) {
      if (replay.fingerprint !== fingerprintOfRequest) {
        const message = '这个幂等键已经用于另一次不同的历史操作：请换一个幂等键';
        return sessionFail('idempotency_conflict', message, {
          extra: { stage: 'idempotency', existing_revision: replay.outcome.edit_revision },
        });
      }
      return succeed({
        ...replay.outcome,
        remaining_undo: this.#history.length,
        remaining_redo: this.#future.length,
      });
    }

    // 基线核对（R142/R143）：与 submitEdit 同一套纪律。
    const baseError = this.#checkBase(input, 'history');
    if (baseError !== null) return baseError;

    const current = this.#snapshot();
    // 恢复出来的模型**保留内容**但把自身的 revision 顶到当前 + 1：编辑版本只增（R141）。
    const nextRevision = this.#revision + 1;
    const label = kind === 'undo' ? '撤销' : '重做';

    const committed = await this.#commitContent({
      model: { ...target.model, revision: nextRevision },
      numbering: target.numbering,
      nextRevision,
      label,
      planDigest: fingerprintOfRequest,
      input,
      allowIdentical: false,
    });
    if (!committed.ok) return committed as SessionFailure;
    this.#moveStack(kind, current);

    const outcome: HistoryOutcome = Object.freeze({
      kind,
      replayed: false,
      edit_revision: committed.value.no_op ? this.#revision : nextRevision,
      restored_from_revision: target.revision,
      published: committed.value.version ?? this.currentPublished(),
      remaining_undo: this.#history.length,
      remaining_redo: this.#future.length,
    });
    this.#historyKeys.set(input.idempotency_key, { fingerprint: fingerprintOfRequest, outcome });
    this.#persist();
    return succeed(outcome);
  }

  /**
   * 把**当前**内容作为一次新版本发布（不改变内容）。
   *
   * 用途：另存副本（WF-084）——副本是一个新的会话，需要先把它当前的内容真实落盘成第 1 版，
   * 才谈得上"副本有新版本、原件不覆盖"。与 `submitEdit` 的差别只有一点：**内容没变也算一次交付**，
   * 因为交付的对象是**另一份文件**（另一个 session 的首次落地），不是"再存一遍同样的内容"。
   */
  async publishCurrent(input: HistoryCommandInput): Promise<SessionResult<PublishedVersion>> {
    if (typeof input.idempotency_key !== 'string' || input.idempotency_key.length === 0) {
      return sessionFail('idempotency_conflict', '必须给出非空的幂等键（R137）', {
        extra: { stage: 'idempotency' },
      });
    }
    const baseError = this.#checkBase(input, 'publish');
    if (baseError !== null) return baseError;
    const nextRevision = this.#revision + 1;
    const committed = await this.#commitContent({
      model: { ...this.#model, revision: nextRevision },
      numbering: this.#numbering,
      nextRevision,
      label: '发布当前内容',
      planDigest: fingerprint({ publish_current_for: this.#options.id, revision: nextRevision }),
      input,
      allowIdentical: true,
    });
    if (!committed.ok) return committed as SessionFailure;
    this.#persist();
    return succeed(committed.value.version as PublishedVersion);
  }

  /**
   * 把"某个模型 + 某个编号表"作为一次**新版本**导出、发布并采纳（撤销/重做/首发布共用）。
   *
   * 失败时**不采纳**（`this.#model` 等一个字节不动，走 {@link #failWithoutAdopting}）。
   * `version` 为 `null` 只在 `no_op` 为真时出现（内容与当前逐字节相同且调用方不要求强制发布）。
   */
  async #commitContent(params: {
    readonly model: DocumentModel;
    readonly numbering: NumberingTable | null;
    readonly nextRevision: EditRevision;
    readonly label: string;
    readonly planDigest: string;
    readonly input: HistoryCommandInput;
    readonly allowIdentical: boolean;
  }): Promise<SessionResult<{ readonly version: PublishedVersion | null; readonly no_op: boolean }>> {
    let bytes: Uint8Array;
    try {
      bytes = exportWith(params.model, params.numbering);
    } catch (error) {
      return this.#failWithoutAdopting(
        params.nextRevision,
        'export_failed',
        `${params.label}导出失败：${describeError(error)}`,
        params.input,
        params.planDigest,
        [],
      );
    }
    const expectedDigest = digestBytes(bytes);

    // 内容与当前完全一致且调用方不要求强制发布 ⇒ 真·空转：只留痕，不造重复版本。
    if (!params.allowIdentical && expectedDigest === this.#contentDigest) {
      this.#appendLog({
        kind: 'edit_applied',
        base_revision: this.#revision,
        result_revision: this.#revision,
        idempotency_key: params.input.idempotency_key,
        plan_digest: params.planDigest,
        ranges: [params.label],
        hit_counts: [],
        changed: false,
        rejection: null,
      });
      return succeed({ version: null, no_op: true });
    }

    const published = await this.#publishPort({
      session_id: this.#options.id,
      edit_revision: params.nextRevision,
      document_id: this.#documentId,
      filename: this.#filename,
      bytes,
      expected_digest: expectedDigest,
      previous_digest: this.#published.length === 0 ? null : this.#contentDigest,
      idempotency_key: params.input.idempotency_key,
    });
    if (!published.ok) {
      // 撤销/重做/首发布与 `submitEdit` 共用同一套纪律：端口抛异常也收敛成 `publish_failed`。
      return this.#failWithoutAdopting(
        params.nextRevision,
        'port_threw',
        `${params.label}发布端口抛出异常：${published.detail}`,
        params.input,
        params.planDigest,
        [],
      );
    }
    const result = published.result;
    if (!result.ok) {
      return this.#failWithoutAdopting(
        params.nextRevision,
        result.failure.kind,
        result.failure.detail,
        params.input,
        params.planDigest,
        [],
      );
    }
    const receipt = result.receipt;
    if (receipt.readback_digest !== expectedDigest) {
      return this.#failWithoutAdopting(
        params.nextRevision,
        'readback_mismatch',
        `${params.label}回执的回读摘要与导出摘要不符（回读 ${receipt.readback_digest} / 导出 ${expectedDigest}）`,
        params.input,
        params.planDigest,
        [],
      );
    }

    const version: PublishedVersion = Object.freeze({
      edit_revision: params.nextRevision,
      task_revision: receipt.task_revision,
      artifact_version: receipt.artifact_version,
      artifact_id: receipt.artifact_id,
      content_digest: receipt.readback_digest,
      expected_digest: expectedDigest,
      byte_length: receipt.byte_length,
      entry_count: receipt.entry_count,
      filename: receipt.filename,
      published_at: this.#now().toISOString(),
    });

    this.#model = params.model;
    this.#numbering = params.numbering;
    this.#revision = params.nextRevision;
    this.#contentDigest = receipt.readback_digest;
    this.#published = [...this.#published, version];
    this.#lastFailure = null;

    this.#appendLog({
      kind: 'edit_applied',
      base_revision: params.nextRevision - 1,
      result_revision: params.nextRevision,
      idempotency_key: params.input.idempotency_key,
      plan_digest: params.planDigest,
      ranges: [params.label],
      hit_counts: [],
      changed: true,
      rejection: null,
    });
    this.#appendLog({
      kind: 'published',
      base_revision: params.nextRevision,
      result_revision: params.nextRevision,
      idempotency_key: params.input.idempotency_key,
      plan_digest: params.planDigest,
      ranges: [],
      hit_counts: [],
      changed: true,
      rejection: null,
    });
    return succeed({ version, no_op: false });
  }

  /** 提交前状态快照（撤销栈的单元）。 */
  #snapshot(): ModelSnapshot {
    return Object.freeze({
      model: this.#model,
      numbering: this.#numbering,
      revision: this.#revision,
      digest: this.#contentDigest,
    });
  }

  /** 一次成功的内容变更提交后：入撤销栈、清重做栈、按上限裁剪。 */
  #pushHistory(): void {
    const next = [...this.#history, this.#snapshot()];
    this.#history =
      this.#maxUndo === null || next.length <= this.#maxUndo ? next : next.slice(next.length - this.#maxUndo);
    this.#future = [];
  }

  /** 撤销/重做成功（或空转）后搬动栈顶：`state` 是从被操作的那条栈落到另一条栈上的状态。 */
  #moveStack(kind: HistoryOperationKind, state: ModelSnapshot): void {
    if (kind === 'undo') {
      this.#history = this.#history.slice(0, -1);
      this.#future = [...this.#future, state];
    } else {
      this.#future = this.#future.slice(0, -1);
      this.#history = [...this.#history, state];
    }
  }

  /** 基线核对（submitEdit 与历史操作共用；不符时记拒绝日志并返回失败）。 */
  #checkBase(input: { base_revision: EditRevision; base_digest: ContentDigest; idempotency_key: string }, stage: string): SessionFailure | null {
    if (input.base_revision !== this.#revision) {
      const message = `本次操作基于编辑版本 ${String(input.base_revision)}，当前已是 ${String(this.#revision)}：请基于最新版本重新提交`;
      this.#logRejection(
        { idempotency_key: input.idempotency_key } as SubmitEditInput,
        null,
        [],
        'stale_revision',
        message,
      );
      return sessionFail('stale_revision', message, {
        currentRevision: this.#revision,
        requestedRevision: input.base_revision,
        extra: { reason: 'revision', stage },
      });
    }
    if (input.base_digest !== this.#contentDigest) {
      const message = '本次操作携带的内容摘要与当前文档不符：你手上的是旧内容';
      this.#logRejection(
        { idempotency_key: input.idempotency_key } as SubmitEditInput,
        null,
        [],
        'stale_revision',
        message,
      );
      return sessionFail('stale_revision', message, {
        currentRevision: this.#revision,
        requestedRevision: input.base_revision,
        extra: { reason: 'digest', stage, current_digest: this.#contentDigest },
      });
    }
    return null;
  }

  // --- 内部 ---------------------------------------------------------------

  /**
   * 编译意图或校验直接给出的计划。
   *
   * 三条入口（`intent` / `plan` / `section_intent`）**恰好一条**，产出的执行单元形状相同：
   * 计划指纹 + 各步回显标签 + 一个把模型变成新模型（或失败）的执行器。
   * 这样 `submitEdit` 的下游（幂等、基线、日志、发布）对三种编辑**一视同仁**——
   * 没有"节操作走一条旁路、于是绕过了幂等或日志"的可能。
   */
  #compile(input: SubmitEditInput): SessionResult<CompiledEdit> {
    const provided = [
      input.intent !== undefined,
      input.plan !== undefined,
      input.section_intent !== undefined,
      input.list_intent !== undefined,
    ].filter(Boolean).length;
    if (provided !== 1) {
      return sessionFail(
        'invalid_expression',
        '必须且只能给出 intent（结构化意图）/ plan（已校验的操作计划）/ section_intent（节编辑意图）' +
          '/ list_intent（列表编辑意图）之一',
        { extra: { stage: 'compile', provided } },
      );
    }

    if (input.list_intent !== undefined) {
      const compiled = compileListIntent(input.list_intent);
      if (!compiled.ok) return compiled as SessionFailure;
      const plan = compiled.value;
      return succeed<CompiledEdit>({
        digest: fingerprint(plan),
        ranges: plan.steps.map((step) => step.range),
        // 列表执行器**要编号表**；用**本次提交那一刻**的 `#numbering` 闭包捕获它，
        // 结果里的新表由 `submitEdit` 在成功采纳新模型时一并采纳（见 `AppliedEdit.numbering`）。
        apply: (model) => {
          const applied = applyListPlan(model, this.#numbering, plan);
          if (!applied.ok) return applied as SessionFailure;
          return succeed<AppliedEdit>({
            model: applied.value.model,
            reports: applied.value.steps,
            numbering: applied.value.numbering,
          });
        },
      });
    }

    if (input.section_intent !== undefined) {
      const compiled = compileSectionIntent(input.section_intent);
      if (!compiled.ok) return compiled as SessionFailure;
      const plan = compiled.value;
      return succeed<CompiledEdit>({
        digest: fingerprint(plan),
        ranges: plan.steps.map((step) => step.label),
        apply: (model) => {
          const applied = applySectionPlan(model, plan);
          if (!applied.ok) return applied as SessionFailure;
          return succeed<AppliedEdit>({ model: applied.value.model, reports: applied.value.steps });
        },
      });
    }

    if (input.plan !== undefined) {
      const plan = input.plan as EditPlan;
      if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
        return sessionFail('empty_range', '操作计划没有任何步骤（空计划不得计入一次事务）', {
          extra: { stage: 'compile', steps: 0 },
        });
      }
      return succeed<CompiledEdit>(compiledTextPlan(plan));
    }
    const compiled = compileEditIntent(input.intent);
    return compiled.ok ? succeed<CompiledEdit>(compiledTextPlan(compiled.value)) : (compiled as SessionFailure);
  }

  /**
   * 调发布端口，并把**端口抛出的异常**收敛成结构化失败（而不是让它穿到调用方）。
   *
   * ## 为什么不能只依赖端口"优雅返回失败"
   *
   * `DocumentPublishPort` 是**注入**的；契约只保证它返回 {@link DocumentPublishResult}，
   * 拦不住一个实现（磁盘故障、进程被杀、第三方库把错误抛出来）在 `publish()` 里直接抛。
   * 若不在这里接住，"唯一的写入口"就会有两种失败形态——有时 `ok:false`、有时抛异常，
   * 调用方只能靠 try/catch 兜底（W-R02 报出的正是这个缺口）。
   *
   * 收敛点选在这里而不是调用方：只有会话自己知道"抛异常时状态机**有没有**前进"——
   * 答案是**没有**（采纳发生在端口回执到手之后），因此走 {@link #failWithoutAdopting}
   * 与结构化失败完全同路：revision / 既有版本 / 历史栈一个都不动（R145）。
   */
  async #publishPort(
    request: DocumentPublishRequest,
  ): Promise<
    | { readonly ok: true; readonly result: DocumentPublishResult }
    | { readonly ok: false; readonly detail: string }
  > {
    try {
      return { ok: true, result: await this.#options.publish_port.publish(request) };
    } catch (error) {
      return { ok: false, detail: describeError(error) };
    }
  }

  /**
   * 发布（或导出）失败时的收口：**新模型被丢弃**，会话停在提交前的状态。
   *
   * 这是 R145 在本层的唯一实现方式——"原文档完好"不是靠盘上没人动，
   * 而是靠**状态机根本没前进**：`this.#model` 与 `this.#published` 都没被赋值。
   */
  #failWithoutAdopting(
    attemptedRevision: EditRevision,
    kind: string,
    detail: string,
    input: SubmitEditInput,
    planDigest: string,
    reports: readonly SessionStepReport[],
  ): SessionFailure {
    const at = this.#now().toISOString();
    this.#lastFailure = Object.freeze({ edit_revision: attemptedRevision, kind, detail, at });
    this.#appendLog({
      kind: 'publish_failed',
      base_revision: this.#revision,
      result_revision: this.#revision,
      idempotency_key: input.idempotency_key,
      plan_digest: planDigest,
      ranges: reports.map((report) => report.range),
      hit_counts: reports.map((report) => report.hitCount),
      changed: false,
      rejection: { code: kind, message: detail },
    });
    this.#persist();
    const failureDetail: SessionFailureDetail = {
      extra: { stage: 'publish', kind, attempted_revision: attemptedRevision },
      publishFailureKind: kind,
      currentRevision: this.#revision,
    };
    return sessionFail('publish_failed', `发布失败（${kind}）：${detail}（原文档与既有版本均未改动）`, failureDetail);
  }

  /** 记一条**被拒**的提交（R139：拒绝也要留痕，"没成"与"没发生过"是两件事）。 */
  #logRejection(
    input: SubmitEditInput,
    planDigest: string | null,
    ranges: readonly string[],
    code: string,
    message: string,
  ): void {
    this.#appendLog({
      kind: 'edit_rejected',
      base_revision: this.#revision,
      result_revision: this.#revision,
      idempotency_key: input.idempotency_key,
      plan_digest: planDigest,
      ranges,
      hit_counts: [],
      changed: false,
      rejection: { code, message },
    });
    this.#persist();
  }

  #appendLog(entry: Omit<OperationLogEntry, 'seq' | 'at'>): void {
    this.#seq += 1;
    const record: OperationLogEntry = Object.freeze({
      ...entry,
      seq: this.#seq,
      at: this.#now().toISOString(),
    });
    const next = [...this.#log, record];
    this.#log =
      this.#maxLog === null || next.length <= this.#maxLog
        ? next
        : next.slice(next.length - this.#maxLog);
  }

  #persist(): void {
    this.#options.persistence.save(this.#state());
  }

  /** 状态快照（**字节不入状态**：由模型确定性重建，避免两份真相源分叉）。 */
  #state(): SessionState {
    return Object.freeze({
      schema: SESSION_SCHEMA,
      session_id: this.#options.id,
      document_id: this.#documentId,
      filename: this.#filename,
      created_at: this.#createdAt,
      edit_revision: this.#revision,
      model: this.#model,
      content_digest: this.#contentDigest,
      source_kind: this.#sourceKind,
      source_digest: this.#sourceDigest,
      published: Object.freeze([...this.#published]),
      last_failure: this.#lastFailure,
      log: Object.freeze([...this.#log]),
      idempotency: Object.freeze([...this.#idempotency]),
      numbering: this.#numbering,
    });
  }
}

// ---------------------------------------------------------------------------
// 编译产物的形状（**私有不导出**：三种编辑在 `submitEdit` 下游一视同仁的实现方式）
// ---------------------------------------------------------------------------

/** 一次编辑版本的完整内容快照（撤销栈的单元：模型 + 旁表 + 版本号 + 摘要）。 */
interface ModelSnapshot {
  readonly model: DocumentModel;
  readonly numbering: NumberingTable | null;
  readonly revision: EditRevision;
  readonly digest: ContentDigest;
}

/** 应用一步（或一批）计划的结果：新模型 + 逐步回执。**失败分支不带模型**（R136）。 */
interface AppliedEdit {
  readonly model: DocumentModel;
  readonly reports: readonly SessionStepReport[];
  /**
   * 本轮执行**可能**一并改动的编号表（列表操作会创建实例）。
   *
   * `undefined` = 本域不碰编号表（段落 / 字符 / 节）⇒ 沿用会话当前的 `#numbering`。
   * 给了就是**这一版的旁表**：导出、摘要与最终采纳都用它，从而"状态里的表"与
   * "交出的 `word/numbering.xml`"不会分叉（WCF-D50 报出的正是"一处漏传、全链路不写"的缺口形态）。
   */
  readonly numbering?: NumberingTable | null;
}

/** 一个已编译、可执行、可复算的编辑单元。 */
interface CompiledEdit {
  /** 计划原文摘要（进日志与幂等指纹）。 */
  readonly digest: string;
  /** 各步回显标签（与步骤同序；进日志的 `ranges`）。 */
  readonly ranges: readonly string[];
  readonly apply: (model: DocumentModel) => SessionResult<AppliedEdit>;
}

/** 文本计划（段落 / 字符域）的执行单元——走 `edit/plan.ts` 的既有执行器。 */
function compiledTextPlan(plan: EditPlan): CompiledEdit {
  return {
    digest: fingerprint(plan),
    ranges: plan.steps.map((step) => step.range),
    apply: (model) => {
      const applied = applyEditPlan(model, plan);
      if (!applied.ok) return applied as SessionFailure;
      return succeed<AppliedEdit>({ model: applied.value.model, reports: applied.value.steps });
    },
  };
}

// ---------------------------------------------------------------------------
// 编号表：形状核对与"带表导出"
// ---------------------------------------------------------------------------

/**
 * 编号表形状的最低限度核对（**只看能不能当一张表用**）。
 *
 * 刻意只查"两个字段在、且是数组"：会话层不做编号表的语义校验
 * （那是 `numbering/**` 与 `docx/numbering-part.ts` 的事），
 * 但也不能把 `{}` / `null` 之外的东西静默存进状态——那会在很久以后的某次导出上才炸。
 */
function checkNumberingShape(table: NumberingTable): string | null {
  if (typeof table !== 'object' || table === null || Array.isArray(table)) {
    return '必须是对象（{abstract, instances}）';
  }
  const record = table as unknown as Record<string, unknown>;
  if (!Array.isArray(record['abstract'])) return '缺少 abstract 数组';
  if (!Array.isArray(record['instances'])) return '缺少 instances 数组';
  return null;
}

/** 从持久化状态里取编号表；形状不认识则视为没有（**不猜**、不静默造一张空表）。 */
function readNumbering(state: Partial<SessionState>): NumberingTable | null {
  const raw = state.numbering;
  if (raw === undefined || raw === null) return null;
  return checkNumberingShape(raw as NumberingTable) === null ? (raw as NumberingTable) : null;
}

/**
 * 带编号表导出。
 *
 * **唯一的导出出口**：构造期摘要、`exportBytes`、`submitEdit` 的发布三条路径都走它，
 * 因此"状态里的编号表"不可能在某一条路径上被漏掉（那正是 WCF-D50 报出的缺口形态：
 * 一处漏传，全链路的 `numbering.xml` 就都不写）。
 */
function exportWith(model: DocumentModel, numbering: NumberingTable | null): Uint8Array {
  return numbering === null ? exportDocx(model) : exportDocx(model, { numbering });
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function sessionFail(
  code: SessionFailure['code'],
  message: string,
  detail: SessionFailureDetail = {},
): SessionFailure {
  return Object.freeze({ ok: false as const, code, message, detail: Object.freeze(detail) });
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** 构造期导出：失败即抛（构造期没有"半成品会话"可返回）。 */
function exportOrThrow(model: DocumentModel, stage: string, numbering: NumberingTable | null): Uint8Array {
  try {
    return exportWith(model, numbering);
  } catch (error) {
    throw new Error(`${stage} 阶段导出失败：${describeError(error)}`);
  }
}

/** 内存持久化（单测用；进程内，不落盘）。**深拷贝**：状态对象不可变，但读回方会当它可变。 */
export function createMemorySessionPersistence(): SessionPersistence {
  let state: unknown = null;
  return {
    save(next: SessionState): void {
      state = structuredClone(next);
    },
    load(): unknown {
      return state;
    },
  };
}

/** 只读辅助：把失败结果压成一行（日志 / 断言信息用）。 */
export function describeSessionFailure(failure: SessionFailure): string {
  return `${failure.code}：${failure.message}`;
}

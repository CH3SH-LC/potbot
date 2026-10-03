/**
 * **手机 Word 会话插件**（W10；WF-081–088 的工具面接线）。
 *
 * ## 这一层是什么，不是什么
 *
 * `src/documents/session/**` 已经回答"一份文档的一生"（新建 / 导入 / 提交 / 发布 / 撤销 /
 * 恢复 / 持久化）。本文件**不再实现任何一条内容语义**，只做三件事：
 *
 * 1. **把它接成手机可用的一组工具**（`create/import/restore/inspect/apply/export/undo/redo/
 *    saveAs/publishCurrent` + 事实订阅），每条工具产出一张**可指认的回执**；
 * 2. 维护**多会话**（手机同时开几份文档）、每条会话自己的持久化载体与撤销栈；
 * 3. 补上会话层**刻意不做**的两件事：另存副本（WF-084，副本是新会话、原件受保护）
 *    与事实订阅/消费（WF-087 消费侧，K08 的 `FactsPort v1`）。
 *
 * 它**不**拼 XML、不写盘、不持密钥、不发网络请求：写盘走注入的 `DocumentPublishPort`，
 * 持久化走注入的 `SessionPersistence`，事实走注入的 `FactsPort`。
 *
 * ## 为什么另存副本必须是"原件不动 + 副本另有版本"
 *
 * 另存不是"复制一层引用"，而是**交付两份各自独立的文件**：
 *
 * ```text
 * ① 取原件当前的**导出字节**（exportBytes：会话状态当场复算摘要，来源不明即拒）
 * ② 取原件的**保护快照**（session_id/document_id/revision/digest/published_count）
 * ③ 副本 = 一个新会话（新 session id、新持久化载体），以①的字节为起点
 * ④ 副本 **publishCurrent()** 落下它自己的第 1 版（走发布端口的原子写盘 + 回读）
 * ⑤ 再取原件快照，与②**逐字段比对**——不一致 ⇒ 报错（不许声称"原件未动"）
 * ```
 *
 * `byte_identical_to_original` 不是承诺而是**当场算出来的**：它比对"副本首版的回读摘要"
 * 与"另存前原件的摘要"。为 `false` 时如实给 `false`（说明包往返不保真），不粉饰。
 *
 * ## 幂等
 *
 * `apply` / `undo` / `redo` / `publishCurrent` 沿用会话层自己的幂等表（R137/R146）；
 * `saveAs` 在本层另有一张**内存**幂等表：同一幂等键 + 同一输入 ⇒ 原样返回首次回执
 * （**不**第二次创建副本、不会多出一个版本映射），同键不同输入 ⇒ `idempotency_conflict`。
 *
 * ## 剪贴板 / IME 也是一次内容事务（W02 / W-R04 的集成请求）
 *
 * W02 的 `selection/clipboard.ts` 与 W-R04 的 IME 桥 `commitComposition` / `deleteSurroundingText`
 * 都产出**整份新模型**（`PasteOutcome.model` / `CutOutcome.model` / `CommitResult.model`），
 * 并**刻意不递增** `revision`——收口归本层。本层新增 `paste` / `cut` / `imeCommit` /
 * `imeDeleteSurrounding` 四条工具，每条 = **一次事务 = 一个编辑版本 = 一个撤销单元**：
 *
 * ```text
 * ① 读当前模型 → 交给 W02/W-R04 的纯函数算出下一份模型（revision 仍是旧的）
 * ② 把 revision 顶到 current+1，导出字节并算摘要
 * ③ 摘要与当前版本逐字节相同 ⇒ 真·空转（不产新版本、不入撤销栈，与 submitEdit 同口径）
 * ④ 否则走注入的发布端口（原子写盘 + 回读），回读摘要不符即拒绝采纳（R144/R145）
 * ⑤ 采纳新模型：把会话状态顶到新版本（模型 / 编辑版本 / 摘要 / 版本映射 + 两条日志）
 * ⑥ 撤销栈：入栈的是**事务前**的 `{模型, 编号表, 编辑版本}`，因此 `contentUndo` 一步可还原
 * ```
 *
 * ## 为什么采纳要绕「持久化状态」一圈（本层的已知边界）
 *
 * 会话层**唯一**的写入口 `DocumentSession.submitEdit` 只认 `intent` / `plan` /
 * `section_intent` / `list_intent` 四种**格式类**计划（段落 / 字符属性），
 * **装不下"插入 / 替换文本"这类内容编辑**——而剪贴板与 IME 恰恰是内容编辑。
 * 本层因此用一个显式、可核对的采纳步骤：读回会话**此刻已持久化的状态**（内容 / 编号表 /
 * 版本映射 / 幂等表全在其中），把模型与新版本写回去，再用 `DocumentSession.restore`
 * 把内存会话换成新的那一份。这样：
 *
 * - `handle()` 拿到的仍是**同一个 session id 的真实会话**，`currentRevision` / `currentDigest`
 *   / `publishedVersions` / `exportBytes` 全部当场自洽，**不会出现两个真相源**；
 * - 代价（如实登记）：`restore` 会清空会话层**内存**撤销栈，因此内容事务之后，
 *   `undo()`（会话层）看不到更早的**格式编辑**；内容事务自己的撤销由本层的
 *   `contentUndo()` 提供（栈同样只在内存、不跨进程）。
 * 会话层若能补一个"按模型提交"的写入口，本层这段采纳逻辑即可删去——见 residuals。
 */

import { exportDocx } from '../../../documents/docx/index.js';
import { digestBytes, fingerprint } from '../../../documents/session/canonical.js';
import { DocumentSession } from '../../../documents/session/session.js';
import type {
  DocumentSessionOptions,
  SubmitEditInput,
} from '../../../documents/session/session.js';
import type {
  ContentDigest,
  HistoryOutcome,
  PublishedVersion,
  SessionFailure,
  SessionFailureDetail,
  SessionPersistence,
  SessionResult,
  SessionState,
} from '../../../documents/session/index.js';
import type { DocumentModel, InlineNode } from '../../../documents/model/index.js';
import type { NumberingTable } from '../../../documents/numbering/types.js';
import {
  cutSelection,
  pasteClipboard,
  type ClipboardPayload,
  type PasteMode,
} from '../../../documents/selection/clipboard.js';
import { utf16IndexToCodePointIndex } from '../../../documents/selection/codepoint.js';
import { replaceRangeInInlines, splitInlinesAtRange } from '../../../documents/selection/inline-map.js';
import { paragraphText, replaceParagraph, requireParagraph } from '../../../documents/selection/structure.js';
import { fail, succeed, type DocumentRange, type Result, type Selection } from '../../../documents/selection/types.js';
import { WordFactsSubscription } from './facts-consumer.js';
import {
  WORD_DOCX_MIME,
  type ApplyWordEditRequest,
  type FactsConsumptionResult,
  type FactsBinding,
  type FactsPort,
  type ImportWordSessionRequest,
  type OpenWordSessionRequest,
  type OriginalProtectionSnapshot,
  type RestoreWordSessionRequest,
  type SaveAsOutcome,
  type WordBindFactsReceipt,
  type WordBindFactsRequest,
  type WordFactsReceipt,
  type WordFactsResult,
  type WordHistoryReceipt,
  type WordHistoryRequest,
  type WordInspectReceipt,
  type WordPublishCurrentRequest,
  type WordRestoreReceipt,
  type WordSaveAsReceipt,
  type WordSaveAsToolRequest,
  type WordSessionPorts,
  type WordTool,
  type WordToolOutcome,
  type WordToolReceipt,
  type WordExportResult,
  type WordConsumeFactsRequest,
} from './types.js';

// ---------------------------------------------------------------------------
// 内容事务（剪贴板 / IME）的请求与回执形状
// ---------------------------------------------------------------------------

/**
 * 一次内容事务的种类。
 *
 * 注：`tool` 字段仍取 `WordTool` 里已有的 `'apply'` / `'undo'`（内容事务本质就是"应用一次编辑"
 * 与"撤销一次编辑"）——`WordTool` 联合在 `types.ts`，不在本单元的写权内，因此**不新增工具名**，
 * 而是用这里显式的 `operation` 让回执第一行就能指认"这是哪一次内容事务"。见 residuals。
 */
export type WordContentOperation = 'paste' | 'cut' | 'imeCommit' | 'imeDeleteSurrounding' | 'contentUndo';

/** 粘贴（WF-088）：把剪贴板载荷落到目标范围（一次事务、一个撤销单元）。 */
export interface WordPasteRequest {
  readonly session_id: string;
  readonly idempotency_key: string;
  readonly base_revision: number;
  readonly base_digest: ContentDigest;
  readonly payload: ClipboardPayload;
  readonly target: DocumentRange;
  readonly mode: PasteMode;
}

/** 剪切（WF-088）：复制 + 原子删除（一次事务、一个撤销单元）。 */
export interface WordCutRequest {
  readonly session_id: string;
  readonly idempotency_key: string;
  readonly base_revision: number;
  readonly base_digest: ContentDigest;
  readonly selection: Selection;
}

/**
 * IME 提交（W-R04 的 `commitComposition`）：把锚区间 `[anchor_start, anchor_end)` 替换为 `text`。
 *
 * 这里收的是**已换算成码位**的锚区间与提交串，不重跑 UTF-16 → 码位的换算——
 * 那一步（含"边界落在代理对内部即拒绝"）归 W-R04 的 IME 桥。本层只负责"落地为一次事务"。
 */
export interface WordImeCommitRequest {
  readonly session_id: string;
  readonly idempotency_key: string;
  readonly base_revision: number;
  readonly base_digest: ContentDigest;
  readonly node_id: string;
  readonly anchor_start: number;
  readonly anchor_end: number;
  readonly text: string;
}

/** IME 删除（W-R04 的 `deleteSurroundingText`）：两段长度都是 **UTF-16 码元**。 */
export interface WordImeDeleteRequest {
  readonly session_id: string;
  readonly idempotency_key: string;
  readonly base_revision: number;
  readonly base_digest: ContentDigest;
  readonly node_id: string;
  readonly caret_start: number;
  readonly caret_end: number;
  readonly before_length: number;
  readonly after_length: number;
}

/**
 * 内容事务回执 = 工具回执外壳 + 本次被替换掉的片段（撤销要还原的就是它）。
 *
 * `replaced_fragment` / `replaced_range` 直接来自 W02 的回执或本层对锚区间的切分，
 * 是"撤销无需重新推导即可还原"的凭据（W02 的 `PasteOutcome.replacedFragment` 口径）。
 */
export interface WordContentReceipt extends WordToolReceipt {
  readonly operation: WordContentOperation;
  /** 被本次事务替换掉的原行内片段（零宽插入时为 `[]`）。 */
  readonly replaced_fragment: readonly InlineNode[];
  /** 被替换掉的原范围（零宽插入时为 `null`）。 */
  readonly replaced_range: DocumentRange | null;
  /** 本次事务后文档的编辑版本摘要（= 采纳后会话的 `currentDigest`）。 */
  readonly content_digest_after: ContentDigest;
}

/** 内容撤销栈的只读视图（UI 据此灰化按钮，不猜）。 */
export interface WordContentHistoryView {
  readonly can_undo: boolean;
  readonly can_redo: boolean;
  readonly undo_depth: number;
  readonly redo_depth: number;
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

export class WordSessionPlugin {
  readonly #ports: WordSessionPorts;
  /** 本插件当前打开的会话（手机可同时开几份文档；每个会话一个持久化载体）。 */
  readonly #sessions: Map<string, DocumentSession>;
  /** 每个会话各自的事实订阅（副本是独立文档，**不共享**绑定）。 */
  readonly #facts: Map<string, WordFactsSubscription>;
  /** `saveAs` 自己的幂等表（内存态：副本是"这一进程里的动作"，不跨进程重放）。 */
  readonly #saveAsKeys: Map<string, { readonly fingerprint: string; readonly receipt: WordSaveAsReceipt }>;
  /** 内容事务（剪贴板 / IME）的撤销栈：事务**前**的 {模型, 编号表, 编辑版本}。 */
  readonly #contentHistory: Map<string, ContentSnapshot[]>;
  /** 内容事务的重做栈（撤销后入栈；新的内容事务清空它）。 */
  readonly #contentFuture: Map<string, ContentSnapshot[]>;
  /** 内容事务的幂等表（内存态：与内容撤销栈同生命周期）。 */
  readonly #contentKeys: Map<string, { readonly fingerprint: string; readonly receipt: WordContentReceipt }>;

  constructor(ports: WordSessionPorts) {
    this.#ports = ports;
    this.#sessions = new Map();
    this.#facts = new Map();
    this.#saveAsKeys = new Map();
    this.#contentHistory = new Map();
    this.#contentFuture = new Map();
    this.#contentKeys = new Map();
  }

  // --- 只读 ---------------------------------------------------------------

  /** 已打开的会话 id（顺序 = 打开顺序）。 */
  openSessionIds(): readonly string[] {
    return Object.freeze([...this.#sessions.keys()]);
  }

  /**
   * 底层会话句柄（只读用途：单测/诊断要看内部状态时用它）。
   *
   * 暴露它**不是**为了让外部绕过工具面写文档——写入路径仍然只有 `DocumentSession.submitEdit`
   * 等公开方法，且调用方拿到的引用与插件是**同一份**（不会出现两个真相源）。
   */
  handle(sessionId: string): DocumentSession | null {
    return this.#sessions.get(sessionId) ?? null;
  }

  // --- 打开（WF-081 / WF-082 / WF-083） -----------------------------------

  /** 新建（WF-081）：以一份真实 DOCX 包字节为起点，来源记为 `user_request`。 */
  create(request: OpenWordSessionRequest): SessionResult<WordToolReceipt> {
    const conflict = this.#guardNewId(request.id);
    if (conflict !== null) return conflict;
    const opened = DocumentSession.createNew(this.#options(request), { template: request.template });
    if (!opened.ok) return opened;
    return this.#adopt(opened.value, 'create', Object.freeze([]), []);
  }

  /** 导入既有 DOCX（WF-082）：来源如实记为 `imported`（不得升格成用户已确认事实）。 */
  importDocx(request: ImportWordSessionRequest): SessionResult<WordToolReceipt> {
    const conflict = this.#guardNewId(request.id);
    if (conflict !== null) return conflict;
    const opened = DocumentSession.importFrom(this.#options(request), request.bytes);
    if (!opened.ok) return opened;
    return this.#adopt(opened.value, 'import', Object.freeze([]), []);
  }

  /**
   * 杀进程后重开（WF-083）。
   *
   * **不做**的三件事，正是这一条工具的价值所在：
   * - 不在状态读不回来时**造一个空会话**顶上去（`loaded:false` + `outcome:null` 如实返回）；
   * - 不把撤销栈"恢复"出来——历史**不跨进程**（WF-086 的预先约定，见 `HistoryOutcome` 文档）；
   * - 不猜文件名：重开后文件名以**持久化状态里的那份**为准，状态里没有且调用方也没给 ⇒ 拒绝重开
   *   （在下一次发布时把文件交给一个猜出来的名字，比拒绝更坏）。
   */
  restoreSession(request: RestoreWordSessionRequest): WordRestoreReceipt {
    const already = this.#sessions.get(request.id);
    if (already !== undefined) {
      return Object.freeze({
        loaded: true,
        reason: `会话 ${request.id} 已在本插件里打开（无需重开；重开不会清空已有的内存状态）`,
        outcome: this.#outcome(already, 'restore', {}),
      });
    }

    const persistence = this.#ports.persistence_for(request.id);
    const persisted = readPersistedState(persistence);
    const persistedFilename =
      typeof persisted?.['filename'] === 'string' && (persisted['filename'] as string).trim().length > 0
        ? (persisted['filename'] as string)
        : null;
    const filename = request.filename ?? persistedFilename;

    // 先用一个**占位名**向会话层提问（问的是"这份状态能不能读回来"）。
    // 占位名不会外泄：真读回来了却没有真实文件名时，下面**拒绝登记**这个会话，
    // 因此它既进不了内存表，也永远走不到"用它去发布"的那一步。
    const options = this.#options({
      id: request.id,
      filename: filename ?? RESTORE_PLACEHOLDER_FILENAME,
      ...(request.max_undo === undefined ? {} : { max_undo: request.max_undo }),
    });
    const restored = DocumentSession.restore(options);
    if (restored.session === null) {
      return Object.freeze({ loaded: false, reason: restored.result.reason, outcome: null });
    }
    if (filename === null) {
      return Object.freeze({
        loaded: false,
        reason:
          '状态读回来了，但其中没有可用文件名，调用方也没有给出 filename：' +
          '拒绝重开（不猜文件名——它会被写进下一次发布请求；请调用方给出 filename）',
        outcome: null,
      });
    }
    const session = restored.session;
    this.#sessions.set(request.id, session);
    return Object.freeze({
      loaded: true,
      reason: restored.result.reason,
      outcome: this.#outcome(session, 'restore', {}),
    });
  }

  // --- 只读检视 -----------------------------------------------------------

  /** 状态 + 历史 + 事实三个只读面（`inspect` 工具）。 */
  inspect(sessionId: string): SessionResult<WordInspectReceipt> {
    const found = this.#require(sessionId);
    if (!found.ok) return found;
    const session = found.value;
    const subscription = this.#facts.get(sessionId);
    const receipt: WordInspectReceipt = Object.freeze({
      ...this.#outcome(session, 'inspect', {}),
      version: session.currentPublished(),
      status: session.status(),
      history: session.history(),
      facts: Object.freeze({
        binding: subscription === undefined ? null : subscription.binding(),
        receipt_count: subscription === undefined ? 0 : subscription.receipts().length,
      }),
    });
    return succeed(receipt);
  }

  // --- 编辑（WF-085） -----------------------------------------------------

  /**
   * 提交一次编辑（复合修改 = **一次**事务 = 一个撤销单元 = 一个编辑版本）。
   *
   * 一次 `plan` 里可以有任意多步；会话层的 `submitEdit` 保证"全部成功才产出新模型"，
   * 因此这里给出的回执要么是"这一步事务整体生效"，要么是结构化失败（文档零改动）。
   */
  async apply(request: ApplyWordEditRequest): Promise<SessionResult<WordToolReceipt>> {
    const found = this.#require(request.session_id);
    if (!found.ok) return found;
    const session = found.value;
    const input: SubmitEditInput = {
      idempotency_key: request.idempotency_key,
      base_revision: request.base_revision,
      base_digest: request.base_digest,
      ...(request.intent === undefined ? {} : { intent: request.intent }),
      ...(request.plan === undefined ? {} : { plan: request.plan }),
      ...(request.section_intent === undefined ? {} : { section_intent: request.section_intent }),
      ...(request.list_intent === undefined ? {} : { list_intent: request.list_intent }),
    };
    const result = await session.submitEdit(input);
    if (!result.ok) return result;
    const outcome = result.value;
    const warnings: string[] = [];
    if (outcome.replayed) warnings.push('幂等键命中：返回首次回执，未产生第二个版本（R137/R146）');
    if (outcome.no_op) warnings.push('本次编辑合法但没有改变文档内容：不产生新版本');
    return succeed(
      this.#receipt(session, 'apply', outcome.published, {
        changed_objects: outcome.steps.map((step) => step.range),
        warnings,
      }),
    );
  }

  // --- 导出（WF-081/083） --------------------------------------------------

  /**
   * 导出当前版本的字节。
   *
   * `published` 恒为 `false`（**导出 ≠ 交付**）：交付只发生在发布端口回执到手之后（R144）。
   * `version` 给出这些字节**所属**的那一版（从未发布过则为 `null`），便于回指 artifact。
   */
  exportCurrent(sessionId: string): SessionResult<WordExportResult> {
    const found = this.#require(sessionId);
    if (!found.ok) return found;
    const session = found.value;
    const bytes = session.exportBytes();
    if (!bytes.ok) return bytes;
    const receipt: WordExportResult = Object.freeze({
      ...this.#receipt(session, 'export', session.currentPublished(), {}),
      bytes: bytes.value,
      byte_length: bytes.value.byteLength,
      content_digest: session.currentDigest(),
    });
    return succeed(receipt);
  }

  // --- 撤销 / 重做（WF-086） ----------------------------------------------

  /** 撤销一次提交（落地为**向前的**新编辑版本，见 `HistoryOutcome` 的说明）。 */
  async undo(request: WordHistoryRequest): Promise<SessionResult<WordHistoryReceipt>> {
    return this.#historyStep('undo', request);
  }

  /** 重做一次被撤销的提交。 */
  async redo(request: WordHistoryRequest): Promise<SessionResult<WordHistoryReceipt>> {
    return this.#historyStep('redo', request);
  }

  // --- 内容事务：剪贴板 / IME（W02 / W-R04 集成） -------------------------

  /**
   * 粘贴（WF-088）：剪贴板载荷 → 目标范围，**一次事务 = 一个编辑版本 = 一个撤销单元**。
   *
   * `replaced_fragment` 来自 W02 的 `PasteOutcome`，因此撤销无需重新推导即可还原被替换片段。
   */
  async paste(request: WordPasteRequest): Promise<SessionResult<WordContentReceipt>> {
    const start = this.#contentStart(request.session_id, request.idempotency_key, request.base_revision, request.base_digest, 'paste', {
      target: request.target,
      mode: request.mode,
      payload_fingerprint: fingerprint(request.payload),
    });
    if (!start.ok) return start.failure;
    if (start.replay !== null) return succeed(start.replay);

    const outcome = pasteClipboard(start.session.model(), request.payload, request.target, request.mode);
    if (!outcome.ok) return sessionFail(outcome.code, outcome.message, outcome.detail);
    const droppedNonText = outcome.value.droppedNonText;
    const run = await this.#adoptContent(start.session, 'apply', 'paste', outcome.value.model, request.idempotency_key, {
      replaced_fragment: outcome.value.replacedFragment,
      replaced_range: outcome.value.replaced,
      changed_objects: [`paste:${outcome.value.target.node_id}`],
      warnings: droppedNonText > 0 ? [`plain-text 粘贴丢弃非文本节点 ${String(droppedNonText)} 个`] : [],
    });
    if (!run.ok) return run;
    this.#recordContent(request.session_id, request.idempotency_key, start.fingerprint, run.value.receipt, run.value.snapshot, run.value.changed);
    return succeed(run.value.receipt);
  }

  /** 剪切（WF-088）：复制 + 原子删除，一次事务；`contentUndo` 一步还原整份模型。 */
  async cut(request: WordCutRequest): Promise<SessionResult<WordContentReceipt>> {
    const start = this.#contentStart(request.session_id, request.idempotency_key, request.base_revision, request.base_digest, 'cut', {
      selection: request.selection,
    });
    if (!start.ok) return start.failure;
    if (start.replay !== null) return succeed(start.replay);

    const outcome = cutSelection(start.session.model(), request.selection);
    if (!outcome.ok) return sessionFail(outcome.code, outcome.message, outcome.detail);
    const run = await this.#adoptContent(start.session, 'apply', 'cut', outcome.value.model, request.idempotency_key, {
      replaced_fragment: [],
      replaced_range: null,
      changed_objects: outcome.value.appliedRanges.map((range) => `cut:${range.node_id}`),
    });
    if (!run.ok) return run;
    this.#recordContent(request.session_id, request.idempotency_key, start.fingerprint, run.value.receipt, run.value.snapshot, run.value.changed);
    return succeed(run.value.receipt);
  }

  /** IME 提交（W-R04 `commitComposition`）：锚区间替换为提交串，一次事务。 */
  async imeCommit(request: WordImeCommitRequest): Promise<SessionResult<WordContentReceipt>> {
    const start = this.#contentStart(request.session_id, request.idempotency_key, request.base_revision, request.base_digest, 'imeCommit', {
      node_id: request.node_id,
      anchor_start: request.anchor_start,
      anchor_end: request.anchor_end,
      text: request.text,
    });
    if (!start.ok) return start.failure;
    if (start.replay !== null) return succeed(start.replay);

    const computed = imeCommitModel(start.session.model(), request.node_id, request.anchor_start, request.anchor_end, request.text);
    if (!computed.ok) return sessionFail(computed.code, computed.message, computed.detail);
    const run = await this.#adoptContent(start.session, 'apply', 'imeCommit', computed.value.model, request.idempotency_key, {
      replaced_fragment: computed.value.fragment,
      replaced_range: computed.value.range,
      changed_objects: [`imeCommit:${request.node_id}`],
    });
    if (!run.ok) return run;
    this.#recordContent(request.session_id, request.idempotency_key, start.fingerprint, run.value.receipt, run.value.snapshot, run.value.changed);
    return succeed(run.value.receipt);
  }

  /**
   * IME 删除（W-R04 `deleteSurroundingText`）：`before_length` / `after_length` 是 **UTF-16 码元**，
   * 向外扩张到码位边界后再删（绝不产生孤立代理项），一次事务。
   */
  async imeDeleteSurrounding(request: WordImeDeleteRequest): Promise<SessionResult<WordContentReceipt>> {
    const start = this.#contentStart(request.session_id, request.idempotency_key, request.base_revision, request.base_digest, 'imeDeleteSurrounding', {
      node_id: request.node_id,
      caret_start: request.caret_start,
      caret_end: request.caret_end,
      before_length: request.before_length,
      after_length: request.after_length,
    });
    if (!start.ok) return start.failure;
    if (start.replay !== null) return succeed(start.replay);

    const computed = imeDeleteModel(
      start.session.model(),
      request.node_id,
      { start: request.caret_start, end: request.caret_end },
      request.before_length,
      request.after_length,
    );
    if (!computed.ok) return sessionFail(computed.code, computed.message, computed.detail);
    const run = await this.#adoptContent(start.session, 'apply', 'imeDeleteSurrounding', computed.value.model, request.idempotency_key, {
      replaced_fragment: computed.value.fragment,
      replaced_range: computed.value.range,
      changed_objects: [`imeDeleteSurrounding:${request.node_id}`],
    });
    if (!run.ok) return run;
    this.#recordContent(request.session_id, request.idempotency_key, start.fingerprint, run.value.receipt, run.value.snapshot, run.value.changed);
    return succeed(run.value.receipt);
  }

  /**
   * 撤销一次**内容事务**（剪贴板 / IME）。
   *
   * 与 `undo()`（会话层的格式编辑撤销）分开：内容事务的采纳会重置会话层的内存撤销栈，
   * 因此内容事务自己的撤销栈由本层维护。一次调用 = 一步还原（把事务前的模型作为**向前的**
   * 新版本落回去），成功后该状态进重做栈。
   */
  async contentUndo(request: WordHistoryRequest): Promise<SessionResult<WordContentReceipt>> {
    const start = this.#contentStart(request.session_id, request.idempotency_key, request.base_revision, request.base_digest, 'contentUndo', {
      kind: 'contentUndo',
    });
    if (!start.ok) return start.failure;
    if (start.replay !== null) return succeed(start.replay);

    const stack = this.#contentHistory.get(request.session_id) ?? [];
    if (stack.length === 0) {
      return sessionFail('nothing_to_undo', '没有可撤销的内容事务（内容撤销栈为空；重开会话后内容撤销栈不跨进程）', {
        extra: { stage: 'contentUndo' },
      });
    }
    const target = stack[stack.length - 1] as ContentSnapshot;
    const preSnapshot = this.#contentSnapshot(start.session);
    const run = await this.#adoptContent(start.session, 'undo', 'contentUndo', target.model, request.idempotency_key, {
      replaced_fragment: [],
      replaced_range: null,
      changed_objects: ['contentUndo'],
    });
    if (!run.ok) return run;

    this.#contentHistory.set(request.session_id, stack.slice(0, -1));
    const future = this.#contentFuture.get(request.session_id) ?? [];
    future.push(preSnapshot);
    this.#contentFuture.set(request.session_id, future);
    this.#recordContentKey(request.idempotency_key, start.fingerprint, run.value.receipt);
    return succeed(run.value.receipt);
  }

  /** 内容撤销栈的只读视图（UI 灰化按钮用；不暴露栈内模型）。 */
  contentHistory(sessionId: string): WordContentHistoryView {
    const undo = this.#contentHistory.get(sessionId)?.length ?? 0;
    const redo = this.#contentFuture.get(sessionId)?.length ?? 0;
    return Object.freeze({ can_undo: undo > 0, can_redo: redo > 0, undo_depth: undo, redo_depth: redo });
  }

  // --- 交付 ---------------------------------------------------------------

  /**
   * 把当前内容作为一次新版本交付（不改变内容）。
   *
   * 用途有二：另存副本的首版落地（WF-084），以及"内容没变但确实要交出一份文件"的场景。
   */
  async publishCurrent(request: WordPublishCurrentRequest): Promise<SessionResult<WordToolReceipt>> {
    const found = this.#require(request.session_id);
    if (!found.ok) return found;
    const session = found.value;
    const result = await session.publishCurrent({
      idempotency_key: request.idempotency_key,
      base_revision: request.base_revision,
      base_digest: request.base_digest,
    });
    if (!result.ok) return result;
    return succeed(
      this.#receipt(session, 'publishCurrent', result.value, { changed_objects: ['publishCurrent'] }),
    );
  }

  /**
   * 另存副本（WF-084）：副本得到**自己的新版本**，原件受保护（见文件头部流程图）。
   *
   * 回执里的 `session_id/revision/digest` 描述的是**原件**（且是另存**开始前**的快照）——
   * 这样"原件没有前进"是回执第一行就能读出来的事实，而不是要调用方自己去比对。
   * 副本自己的标识在 `copy_session_id` 与 `save_as.copy` 里。
   */
  async saveAs(request: WordSaveAsToolRequest): Promise<SessionResult<WordSaveAsReceipt>> {
    const found = this.#require(request.session_id);
    if (!found.ok) return found;
    const original = found.value;
    const spec = request.request;

    if (typeof spec.idempotency_key !== 'string' || spec.idempotency_key.length === 0) {
      return sessionFail('idempotency_conflict', '另存副本必须给出非空的幂等键（R137）', {
        extra: { stage: 'saveAs' },
      });
    }
    if (typeof spec.new_session_id !== 'string' || spec.new_session_id.trim().length === 0) {
      return sessionFail('invalid_expression', '副本必须有非空的 new_session_id', {
        extra: { stage: 'saveAs' },
      });
    }
    if (spec.new_session_id === request.session_id) {
      return sessionFail(
        'invalid_expression',
        '副本必须是**另一个**会话：new_session_id 不得等于原件的 session_id（否则就是覆盖原件）',
        { extra: { stage: 'saveAs' } },
      );
    }
    if (!/\.docx$/i.test(spec.filename)) {
      return sessionFail('invalid_expression', '副本文件名必须以 .docx 结尾（本插件只产出 DOCX）', {
        extra: { stage: 'saveAs', filename: spec.filename },
      });
    }

    // 幂等：同一键 + 同一输入 ⇒ 原样返回首次回执（**不**第二次创建副本、**不**重跑一次）。
    //
    // 这一步必须**先于** id 占用检查：重放时副本 id 当然已经被占用（就是上一次占的），
    // 若先查占用，重试（手机网络抖动后的常见动作）会被误判成 `session_exists`。
    const requestFingerprint = fingerprint({
      original_session_id: request.session_id,
      new_session_id: spec.new_session_id,
      filename: spec.filename,
    });
    const replay = this.#saveAsKeys.get(spec.idempotency_key);
    if (replay !== undefined) {
      if (replay.fingerprint !== requestFingerprint) {
        return sessionFail(
          'idempotency_conflict',
          '这个幂等键已经用于另一次不同的另存副本：请换一个幂等键，或按原输入重新提交',
          { extra: { stage: 'saveAs' } },
        );
      }
      return succeed(replay.receipt);
    }

    const conflict = this.#guardNewId(spec.new_session_id);
    if (conflict !== null) return conflict;

    // ② 原件保护快照（**在任何 await 之前**取）。
    const before = protectionSnapshot(original);
    const exported = original.exportBytes();
    if (!exported.ok) return exported;

    // ③ 副本（独立会话；编号表随解析出的模型一起复制过去，否则副本会静默丢编号定义）。
    const copyOptions = this.#options({
      id: spec.new_session_id,
      filename: spec.filename,
      numbering: original.numberingTable(),
    });
    const opened = DocumentSession.createNew(copyOptions, { template: exported.value });
    if (!opened.ok) return opened;
    const copy = opened.value;

    // ④ 副本的**第 1 版**（走发布端口：原子写盘 + 回读核对）。
    const first = await copy.publishCurrent({
      idempotency_key: `${spec.idempotency_key}::copy-first-version`,
      base_revision: copy.currentRevision(),
      base_digest: copy.currentDigest(),
    });
    if (!first.ok) return first;

    // ⑤ 原件保护核对：另存期间原件**不得**有任何前进（并发提交会让"原件未动"变成假话）。
    const after = protectionSnapshot(original);
    if (!sameProtectionSnapshot(before, after)) {
      return sessionFail(
        'stale_revision',
        '另存副本期间原件被并发改动（编辑版本/摘要/已交付数量发生变化）：' +
          '本次"副本取自原件某一稳定版本"的结论不可采信，因此**拒绝出回执**。' +
          `副本首版已落盘（artifact ${first.value.artifact_id}）但**未登记**为可用会话；` +
          '请换一个 new_session_id（该 id 的持久化状态已被占用）或在原件稳定后重试',
        {
          extra: {
            stage: 'saveAs',
            before_revision: before.revision,
            after_revision: after.revision,
            orphan_artifact_id: first.value.artifact_id,
            orphan_session_id: spec.new_session_id,
          },
          currentRevision: after.revision,
        },
      );
    }

    const version = first.value;
    const byteIdentical = version.content_digest === before.digest;
    const warnings: string[] = [];
    if (!byteIdentical) {
      warnings.push('副本首版内容与另存前原件不逐字节相同（包往返不保真）：需人工核对差异');
    }
    // 文档身份是**导入时由包内容派生**的（`docx-<sha256(bytes)[0:16]>`，见 `docx/import.ts`），
    // 因此副本（从导出字节重新导入）拿到的是一个**新的 document_id**。这不是缺陷，
    // 但调用方若按"副本应该沿用原件的 document_id"去对账就会对不上——所以显式说出来。
    if (copy.documentId !== before.document_id) {
      warnings.push(
        `副本是新文档：document_id 由副本字节派生（${copy.documentId}），与原件的 ${before.document_id} 不同`,
      );
    }
    const saveAs: SaveAsOutcome = Object.freeze({
      original: before,
      copy: Object.freeze({
        session_id: spec.new_session_id,
        document_id: copy.documentId,
        revision: copy.currentRevision(),
        digest: copy.currentDigest(),
        artifact_id: version.artifact_id,
        filename: version.filename,
        mime: WORD_DOCX_MIME,
      }),
      byte_identical_to_original: byteIdentical,
    });
    const outcome: WordToolOutcome = Object.freeze({
      tool: 'saveAs',
      session_id: original.id,
      document_id: before.document_id,
      revision: before.revision,
      digest: before.digest,
      mime: WORD_DOCX_MIME,
      changed_objects: Object.freeze([`saveAs:${spec.new_session_id}`]),
      warnings: Object.freeze(warnings),
      artifact_id: version.artifact_id,
      published: true,
    });
    const receipt: WordSaveAsReceipt = Object.freeze({
      ...outcome,
      version,
      save_as: saveAs,
      copy_session_id: spec.new_session_id,
    });

    this.#sessions.set(spec.new_session_id, copy);
    this.#saveAsKeys.set(spec.idempotency_key, { fingerprint: requestFingerprint, receipt });
    return succeed(receipt);
  }

  // --- 事实订阅 / 消费（WF-087；FactsPort v1 消费侧） ----------------------

  /**
   * 绑定（订阅）该会话所依赖的**当前**事实快照。
   *
   * 绑定的粒度是"这份文档依赖 `snapshot_id@revision`"——因此快照不存在时**必须**拒绝，
   * 而不是绑一个空快照（空快照会被下游当成"这份文档没有任何事实依赖"）。
   */
  bindFacts(request: WordBindFactsRequest): WordFactsResult<WordBindFactsReceipt> {
    const found = this.#require(request.session_id);
    if (!found.ok) {
      return { ok: false, scope: 'session', code: found.code, message: found.message };
    }
    const session = found.value;
    const port = this.#ports.facts_port;
    if (port === undefined) {
      return {
        ok: false,
        scope: 'facts',
        code: 'facts_not_configured',
        message: '本插件未配置事实端口（FactsPort）：无法订阅事实快照',
      };
    }
    const snapshot = port.snapshot(request.task_id);
    if (snapshot === null) {
      return {
        ok: false,
        scope: 'facts',
        code: 'facts_snapshot_missing',
        message: `事实端口里没有任务 ${request.task_id} 的快照：拒绝绑定（不得把缺失当成空快照）`,
      };
    }
    const binding = this.#subscription(request.session_id).bind(snapshot);
    const receipt: WordBindFactsReceipt = Object.freeze({
      ...this.#outcome(session, 'bindFacts', {
        changed_objects: [`facts:${binding.snapshot_id}@r${String(binding.task_revision)}`],
      }),
      version: null,
      binding,
    });
    return { ok: true, value: receipt };
  }

  /**
   * 消费一次事实：**先做版本校验**，通过才出**实际消费回执**。
   *
   * 三条纪律（与 `facts-consumer.ts` 的头部说明一一对应）：
   * - 版本不符 / 快照缺失 / 未绑定 / 未配置端口 ⇒ 结构化失败，**没有回执**（"没消费成"不得记成"消费过了"）；
   * - 回执里的 ref/键/摘要来自**这一次真正取到的**快照（不是"我声明要消费的清单"）；
   * - 消费钉在**文档编辑版本**上：调用方给的 `document_revision` 与当前版本不符 ⇒ 拒绝
   *   （老文档 + 新事实的组合会让回执指向一份不存在的证据）。
   */
  consumeFacts(request: WordConsumeFactsRequest): WordFactsResult<WordFactsReceipt> {
    const found = this.#require(request.session_id);
    if (!found.ok) {
      return { ok: false, scope: 'session', code: found.code, message: found.message };
    }
    const session = found.value;
    if (request.document_revision !== undefined && request.document_revision !== session.currentRevision()) {
      return {
        ok: false,
        scope: 'session',
        code: 'stale_revision',
        message:
          `本次事实消费钉在文档编辑版本 ${String(request.document_revision)}，` +
          `当前已是 ${String(session.currentRevision())}：请基于最新文档版本重新消费`,
      };
    }
    const documentRevision = request.document_revision ?? session.currentRevision();
    const consumption: FactsConsumptionResult = this.#subscription(request.session_id).consume(documentRevision);
    const warnings = consumption.ok
      ? [...consumption.receipt.warnings]
      : [`事实消费被拒（${consumption.code}）：${consumption.message}`];
    const receipt: WordFactsReceipt = Object.freeze({
      ...this.#outcome(session, 'consumeFacts', {}),
      version: null,
      consumption,
      warnings: Object.freeze(warnings),
    });
    return { ok: true, value: receipt };
  }

  // --- 内部 ---------------------------------------------------------------

  /** 取会话；不在场即结构化失败（**不**返回 `null`——调用方不该用可选链兜住"会话没了"）。 */
  #require(sessionId: string): SessionResult<DocumentSession> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      return sessionFail('session_not_found', `会话 ${sessionId} 不在本插件里（未打开或已被丢弃）`, {
        extra: { stage: 'lookup' },
      });
    }
    return succeed(session);
  }

  /**
   * 新 id 的占用检查：**内存里已开**或**盘上已有状态**都拒绝。
   *
   * 只查内存不够——同一 id 在盘上已有一份会话状态时再 `create`，会把它静默盖掉
   * （旧文件的版本映射随之消失），而调用方不会收到任何提示。
   */
  #guardNewId(sessionId: string): SessionFailure | null {
    if (this.#sessions.has(sessionId)) {
      return sessionFail('session_exists', `会话 ${sessionId} 已在打开状态：请换一个 id 或先关掉它`, {
        extra: { stage: 'open', where: 'memory' },
      });
    }
    if (readPersistedState(this.#ports.persistence_for(sessionId)) !== null) {
      return sessionFail(
        'session_exists',
        `会话 ${sessionId} 在持久化载体里已有状态：请换一个 id，或改用 restoreSession() 重开它`,
        { extra: { stage: 'open', where: 'persistence' } },
      );
    }
    return null;
  }

  /** 会话选项的唯一构造出口（端口注入点集中在这里，避免某条工具忘传某个端口）。 */
  #options(input: {
    readonly id: string;
    readonly filename: string;
    readonly numbering?: NumberingTable | null;
    readonly max_undo?: number | null;
  }): DocumentSessionOptions {
    return {
      id: input.id,
      filename: input.filename,
      persistence: this.#ports.persistence_for(input.id),
      publish_port: this.#ports.publish_port,
      now: this.#ports.now,
      ...(input.numbering === undefined ? {} : { numbering: input.numbering }),
      ...(input.max_undo === undefined ? {} : { max_undo: input.max_undo }),
    };
  }

  /** 打开成功后统一收尾（登记会话 + 出回执）。 */
  #adopt(
    session: DocumentSession,
    tool: WordTool,
    changed: readonly string[],
    warnings: readonly string[],
  ): SessionResult<WordToolReceipt> {
    this.#sessions.set(session.id, session);
    return succeed(this.#receipt(session, tool, null, { changed_objects: changed, warnings }));
  }

  /** 工具回执外壳（`revision`/`digest` 取**当前**会话状态：调用方据此提交下一次编辑）。 */
  #outcome(
    session: DocumentSession,
    tool: WordTool,
    fields: {
      readonly changed_objects?: readonly string[];
      readonly warnings?: readonly string[];
      readonly artifact_id?: string | null;
      readonly published?: boolean;
    } = {},
  ): WordToolOutcome {
    return Object.freeze({
      tool,
      session_id: session.id,
      document_id: session.documentId,
      revision: session.currentRevision(),
      digest: session.currentDigest(),
      mime: WORD_DOCX_MIME,
      changed_objects: Object.freeze([...(fields.changed_objects ?? [])]),
      warnings: Object.freeze([...(fields.warnings ?? [])]),
      artifact_id: fields.artifact_id ?? null,
      published: fields.published ?? false,
    });
  }

  /** 工具回执 = 外壳 + 本次真正交付的版本。 */
  #receipt(
    session: DocumentSession,
    tool: WordTool,
    version: PublishedVersion | null,
    fields: {
      readonly changed_objects?: readonly string[];
      readonly warnings?: readonly string[];
    } = {},
  ): WordToolReceipt {
    return Object.freeze({
      ...this.#outcome(session, tool, {
        changed_objects: fields.changed_objects ?? [],
        warnings: fields.warnings ?? [],
        artifact_id: version === null ? null : version.artifact_id,
        published: version !== null,
      }),
      version,
    });
  }

  /** 撤销 / 重做的共用实现（两者只差操作哪条栈）。 */
  async #historyStep(
    kind: 'undo' | 'redo',
    request: WordHistoryRequest,
  ): Promise<SessionResult<WordHistoryReceipt>> {
    const found = this.#require(request.session_id);
    if (!found.ok) return found;
    const session = found.value;
    const command = {
      idempotency_key: request.idempotency_key,
      base_revision: request.base_revision,
      base_digest: request.base_digest,
    };
    const result: SessionResult<HistoryOutcome> =
      kind === 'undo' ? await session.undo(command) : await session.redo(command);
    if (!result.ok) return result;
    const history = result.value;
    const warnings = history.replayed ? ['幂等键命中：返回首次历史回执'] : [];
    const receipt: WordHistoryReceipt = Object.freeze({
      ...this.#receipt(session, kind, history.published, {
        changed_objects: [`${kind}:restored@${String(history.restored_from_revision)}`],
        warnings,
      }),
      history,
    });
    return succeed(receipt);
  }

  // --- 内容事务内部 -------------------------------------------------------

  /** 事务前快照（内容撤销栈的单元：模型 + 编号表 + 编辑版本）。 */
  #contentSnapshot(session: DocumentSession): ContentSnapshot {
    return Object.freeze({
      model: session.model(),
      numbering: session.numberingTable(),
      revision: session.currentRevision(),
    });
  }

  /**
   * 内容事务的公共前置：会话在场 + 幂等键非空 + 幂等查表 + 基线核对。
   *
   * 幂等表**先于**基线核对（与 `submitEdit` 同一顺序）：网络重试带的是原来的 baseRevision，
   * 此时会话可能已前进，不先查幂等就会把一次成功的事务误判成 stale。
   */
  #contentStart(
    sessionId: string,
    idempotencyKey: string,
    baseRevision: number,
    baseDigest: ContentDigest,
    operation: WordContentOperation,
    fingerprintInput: unknown,
  ): ContentStart {
    const found = this.#require(sessionId);
    if (!found.ok) return { ok: false, failure: found };
    const session = found.value;
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      return { ok: false, failure: sessionFail('idempotency_conflict', '必须给出非空的幂等键（R137）', { extra: { stage: operation } }) };
    }
    const fingerprintOfRequest = fingerprint({ operation, input: fingerprintInput });
    const replay = this.#contentKeys.get(idempotencyKey);
    if (replay !== undefined) {
      if (replay.fingerprint !== fingerprintOfRequest) {
        return {
          ok: false,
          failure: sessionFail('idempotency_conflict', '这个幂等键已经用于另一次不同的内容事务：请换一个幂等键，或按原输入重新提交', { extra: { stage: operation } }),
        };
      }
      return { ok: true, session, fingerprint: fingerprintOfRequest, replay: replay.receipt };
    }
    if (baseRevision !== session.currentRevision()) {
      return {
        ok: false,
        failure: sessionFail(
          'stale_revision',
          `本次内容事务基于编辑版本 ${String(baseRevision)}，当前已是 ${String(session.currentRevision())}：请基于最新版本重新提交`,
          { currentRevision: session.currentRevision(), requestedRevision: baseRevision, extra: { reason: 'revision', stage: operation } },
        ),
      };
    }
    if (baseDigest !== session.currentDigest()) {
      return {
        ok: false,
        failure: sessionFail(
          'stale_revision',
          '本次内容事务携带的内容摘要与当前文档不符：你手上的是旧内容（迟到的结果不得套用到新内容上）',
          { currentRevision: session.currentRevision(), extra: { reason: 'digest', stage: operation, current_digest: session.currentDigest() } },
        ),
      };
    }
    return { ok: true, session, fingerprint: fingerprintOfRequest, replay: null };
  }

  /** 一次成功的内容事务入账：记幂等；真的改变了内容才入撤销栈并清空重做栈。 */
  #recordContent(
    sessionId: string,
    idempotencyKey: string,
    fingerprintOfRequest: string,
    receipt: WordContentReceipt,
    snapshot: ContentSnapshot,
    changed: boolean,
  ): void {
    this.#contentKeys.set(idempotencyKey, { fingerprint: fingerprintOfRequest, receipt });
    if (!changed) return;
    const history = this.#contentHistory.get(sessionId) ?? [];
    history.push(snapshot);
    this.#contentHistory.set(sessionId, history);
    this.#contentFuture.set(sessionId, []);
  }

  /** 只记幂等（撤销路径用：撤销栈/重做栈由调用方搬动）。 */
  #recordContentKey(idempotencyKey: string, fingerprintOfRequest: string, receipt: WordContentReceipt): void {
    this.#contentKeys.set(idempotencyKey, { fingerprint: fingerprintOfRequest, receipt });
  }

  /**
   * 把一份内容模型采纳为**一个**新编辑版本（导出 → 发布 → 回读核对 → 写回状态 → 重建会话）。
   *
   * 失败一律不留痕：会话停在事务前（与 `submitEdit` 的 R145 同一条纪律）。成功返回
   * 事务前快照 `snapshot` 与 `changed`（逐字节相同 ⇒ `changed:false`，不产新版本）。
   */
  async #adoptContent(
    session: DocumentSession,
    tool: WordTool,
    operation: WordContentOperation,
    nextModel: DocumentModel,
    idempotencyKey: string,
    extra: {
      readonly replaced_fragment: readonly InlineNode[];
      readonly replaced_range: DocumentRange | null;
      readonly changed_objects: readonly string[];
      readonly warnings?: readonly string[];
    },
  ): Promise<SessionResult<{ readonly receipt: WordContentReceipt; readonly snapshot: ContentSnapshot; readonly changed: boolean }>> {
    const warnings = extra.warnings ?? [];
    const preSnapshot = this.#contentSnapshot(session);
    const nextRevision = session.currentRevision() + 1;
    // 不原地改传入模型：revision 只在本层向前顶一格（R141 单调）。
    const document: DocumentModel = { ...nextModel, revision: nextRevision };
    const numbering = session.numberingTable();

    let bytes: Uint8Array;
    try {
      bytes = numbering === null ? exportDocx(document) : exportDocx(document, { numbering });
    } catch (error) {
      return sessionFail('export_failed', `内容事务导出失败：${describeUnknown(error)}`, { extra: { stage: operation } });
    }
    const expected = digestBytes(bytes);

    // 与 `submitEdit` 同一口径：导出字节与当前版本逐字节相同 ⇒ 真·空转。
    if (expected === session.currentDigest()) {
      const receipt = this.#contentReceipt(session, tool, operation, null, session.currentRevision(), [], extra.replaced_fragment, extra.replaced_range, session.currentDigest(), [
        ...warnings,
        '本次内容事务合法但没有改变文档内容：不产生新版本',
      ]);
      return succeed({ receipt, snapshot: preSnapshot, changed: false });
    }

    const published = await this.#ports.publish_port.publish({
      session_id: session.id,
      edit_revision: nextRevision,
      document_id: session.documentId,
      filename: session.filename,
      bytes,
      expected_digest: expected,
      previous_digest: session.publishedVersions().length === 0 ? null : session.currentDigest(),
      idempotency_key: idempotencyKey,
    });
    if (!published.ok) {
      return sessionFail(
        'publish_failed',
        `内容事务发布失败（${published.failure.kind}）：${published.failure.detail}（原文档与既有版本均未改动）`,
        {
          publishFailureKind: published.failure.kind,
          currentRevision: session.currentRevision(),
          extra: { stage: operation, kind: published.failure.kind, attempted_revision: nextRevision },
        },
      );
    }
    const receiptData = published.receipt;
    if (receiptData.readback_digest !== expected) {
      return sessionFail(
        'publish_failed',
        `内容事务回执的回读摘要与导出摘要不符（回读 ${receiptData.readback_digest} / 导出 ${expected}）：拒绝采纳这一版`,
        {
          publishFailureKind: 'readback_mismatch',
          currentRevision: session.currentRevision(),
          extra: { stage: operation, kind: 'readback_mismatch' },
        },
      );
    }

    const version: PublishedVersion = Object.freeze({
      edit_revision: nextRevision,
      task_revision: receiptData.task_revision,
      artifact_version: receiptData.artifact_version,
      artifact_id: receiptData.artifact_id,
      content_digest: receiptData.readback_digest,
      expected_digest: expected,
      byte_length: receiptData.byte_length,
      entry_count: receiptData.entry_count,
      filename: receiptData.filename,
      published_at: this.#ports.now().toISOString(),
    });

    const persistence = this.#ports.persistence_for(session.id);
    const loaded = readPersistedState(persistence);
    if (loaded === null) {
      return sessionFail('export_failed', '内容事务需要会话已持久化的状态，但持久化载体里读不到：拒绝采纳', {
        extra: { stage: operation },
      });
    }
    const baseState = loaded as unknown as SessionState;
    const at = this.#ports.now().toISOString();
    const lastSeq = baseState.log.reduce((max, entry) => Math.max(max, entry.seq), 0);
    const nextState: SessionState = Object.freeze({
      ...baseState,
      edit_revision: nextRevision,
      model: document,
      numbering,
      content_digest: receiptData.readback_digest,
      published: Object.freeze([...baseState.published, version]),
      last_failure: null,
      log: Object.freeze([
        ...baseState.log,
        Object.freeze({
          seq: lastSeq + 1,
          at,
          kind: 'edit_applied' as const,
          base_revision: session.currentRevision(),
          result_revision: nextRevision,
          idempotency_key: idempotencyKey,
          plan_digest: fingerprint({ operation }),
          ranges: [...extra.changed_objects],
          hit_counts: [],
          changed: true,
          rejection: null,
        }),
        Object.freeze({
          seq: lastSeq + 2,
          at,
          kind: 'published' as const,
          base_revision: nextRevision,
          result_revision: nextRevision,
          idempotency_key: idempotencyKey,
          plan_digest: fingerprint({ operation }),
          ranges: [],
          hit_counts: [],
          changed: true,
          rejection: null,
        }),
      ]),
    });
    persistence.save(nextState);

    const restored = DocumentSession.restore(this.#options({ id: session.id, filename: session.filename, numbering }));
    if (restored.session === null) {
      return sessionFail('export_failed', `内容事务采纳失败：${restored.result.reason}`, { extra: { stage: operation } });
    }
    this.#sessions.set(session.id, restored.session);
    const receipt = this.#contentReceipt(restored.session, tool, operation, version, nextRevision, extra.changed_objects, extra.replaced_fragment, extra.replaced_range, restored.session.currentDigest(), warnings);
    return succeed({ receipt, snapshot: preSnapshot, changed: true });
  }

  /** 内容事务回执外壳（`revision` 取**采纳后**会话的当前版本）。 */
  #contentReceipt(
    session: DocumentSession,
    tool: WordTool,
    operation: WordContentOperation,
    version: PublishedVersion | null,
    revision: number,
    changedObjects: readonly string[],
    replacedFragment: readonly InlineNode[],
    replacedRange: DocumentRange | null,
    contentDigestAfter: ContentDigest,
    warnings: readonly string[],
  ): WordContentReceipt {
    return Object.freeze({
      ...this.#outcome(session, tool, {
        changed_objects: changedObjects,
        warnings,
        artifact_id: version === null ? null : version.artifact_id,
        published: version !== null,
      }),
      revision,
      version,
      operation,
      replaced_fragment: Object.freeze([...replacedFragment]),
      replaced_range: replacedRange,
      content_digest_after: contentDigestAfter,
    });
  }

  /** 取该会话的事实订阅（懒建：没配端口也建，好让 `consume` 如实回 `facts_not_configured`）。 */
  #subscription(sessionId: string): WordFactsSubscription {
    const existing = this.#facts.get(sessionId);
    if (existing !== undefined) return existing;
    const port: FactsPort | undefined = this.#ports.facts_port;
    const created = new WordFactsSubscription({
      ...(port === undefined ? {} : { port }),
      consumer: `word-session:${sessionId}`,
      now: this.#ports.now,
    });
    this.#facts.set(sessionId, created);
    return created;
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * 重开时向会话层提问用的占位文件名。
 *
 * 它**只会**出现在"状态读回来了但状态里没有文件名"的分支里，而那一条分支会**拒绝登记**
 * 这个会话——因此占位名既进不了内存表，也永远走不到"用它去发布"的那一步。
 * 这样做的收益是：状态本身不合法（schema 不符 / 模型缺失）时，报出来的是**真实原因**，
 * 而不是一句"没有文件名"把真正的问题盖住。
 */
const RESTORE_PLACEHOLDER_FILENAME = 'restore-probe.docx';

/** 会话层失败的本地工厂（`session.ts` 的那个不导出：它是包内私有的）。 */
function sessionFail(
  code: SessionFailure['code'],
  message: string,
  detail: SessionFailureDetail = {},
): SessionFailure {
  return Object.freeze({ ok: false as const, code, message, detail: Object.freeze(detail) });
}

/**
 * 原件保护快照（另存前后**逐字段**比对）。
 *
 * 为什么不只比摘要：`published_count` 能抓住"原件在另存期间多交付了一版但内容恰好相同"
 * （例如一次 `publishCurrent`）——那时摘要不变，而"原件未动"已经**不成立**了。
 */
function protectionSnapshot(session: DocumentSession): OriginalProtectionSnapshot {
  return Object.freeze({
    session_id: session.id,
    document_id: session.documentId,
    revision: session.currentRevision(),
    digest: session.currentDigest(),
    published_count: session.publishedVersions().length,
  });
}

function sameProtectionSnapshot(a: OriginalProtectionSnapshot, b: OriginalProtectionSnapshot): boolean {
  return (
    a.session_id === b.session_id &&
    a.document_id === b.document_id &&
    a.revision === b.revision &&
    a.digest === b.digest &&
    a.published_count === b.published_count
  );
}

/**
 * 从持久化载体里读原始状态（**只读**；读不到/形状不对/端口抛错 ⇒ `null`）。
 *
 * 用途只有一个：在**不重开会话**的前提下回答"这个 id 在盘上有没有东西"以及"上次叫什么名字"。
 * 端口抛错被吞掉是有意的——查询本身不该让 create/saveAs 失败；但**吞掉不等于当成没有**：
 * 调用方在需要严格判定时（`restoreSession`）仍以 `DocumentSession.restore` 的结论为准。
 */
function readPersistedState(persistence: SessionPersistence): Record<string, unknown> | null {
  try {
    const raw: unknown = persistence.load();
    if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return raw as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 内容事务：内部辅助类型与 IME 模型层
// ---------------------------------------------------------------------------

/** 内容事务的事务前快照（内容撤销栈的单元）。 */
interface ContentSnapshot {
  readonly model: DocumentModel;
  readonly numbering: NumberingTable | null;
  readonly revision: number;
}

/** `#contentStart` 的判别结果：要么可继续（含可选的重放回执），要么结构化失败。 */
type ContentStart =
  | {
      readonly ok: true;
      readonly session: DocumentSession;
      readonly fingerprint: string;
      readonly replay: WordContentReceipt | null;
    }
  | { readonly ok: false; readonly failure: SessionFailure };

/** IME 替换的结果：新模型 + 被替换片段 + 被替换范围（撤销凭据）。 */
interface ImeReplaceOutcome {
  readonly model: DocumentModel;
  readonly fragment: readonly InlineNode[];
  readonly range: DocumentRange;
}

/**
 * IME 提交（W-R04 `commitComposition` 的语义）：把段内锚区间 `[anchorStart, anchorEnd)`
 * 替换为 `text`，**不**在这里递增 revision（由内容事务统一顶格）。
 *
 * 复用内核原语 `splitInlinesAtRange` / `replaceRangeInInlines` / `replaceParagraph`：
 * 未受影响的行内节点按引用保留（R147），锚区间含软换行 / 域 / 图形 / 公式时返回 `unsupported`。
 */
function imeCommitModel(
  model: DocumentModel,
  nodeId: string,
  anchorStart: number,
  anchorEnd: number,
  text: string,
): Result<ImeReplaceOutcome> {
  const paragraph = requireParagraph(model, nodeId);
  if (!paragraph.ok) return paragraph;
  const split = splitInlinesAtRange(paragraph.value.inlines, anchorStart, anchorEnd);
  if (!split.ok) return split;
  const replaced = replaceRangeInInlines(paragraph.value.inlines, anchorStart, anchorEnd, text);
  if (!replaced.ok) return replaced;
  const updated = replaceParagraph(model, nodeId, { ...paragraph.value, inlines: replaced.value });
  if (!updated.ok) return updated;
  return succeed({
    model: updated.value,
    fragment: split.value.selected,
    range: { node_id: nodeId, start: anchorStart, end: anchorEnd },
  });
}

/**
 * IME 删除（W-R04 `deleteSurroundingText` 的语义）：`before_length` / `after_length` 是 **UTF-16 码元**。
 * 先把窗口扩到码位边界再按码位切除——`deleteSurroundingText(1,0)` 在光标前是 emoji 时删掉**整个**
 * emoji 而不是留下孤立代理项（与 W-R04 同一行为选择）。
 */
function imeDeleteModel(
  model: DocumentModel,
  nodeId: string,
  caret: { readonly start: number; readonly end: number },
  beforeLength: number,
  afterLength: number,
): Result<ImeReplaceOutcome> {
  const paragraph = requireParagraph(model, nodeId);
  if (!paragraph.ok) return paragraph;
  const text = paragraphText(paragraph.value);
  if (!Number.isInteger(beforeLength) || !Number.isInteger(afterLength) || beforeLength < 0 || afterLength < 0) {
    return fail('invalid_range', `deleteSurroundingText 长度必须是非负整数，收到 (${String(beforeLength)}, ${String(afterLength)})。`, {
      extra: { beforeLength: String(beforeLength), afterLength: String(afterLength) },
    });
  }
  if (
    !Number.isInteger(caret.start) ||
    !Number.isInteger(caret.end) ||
    caret.start < 0 ||
    caret.end < caret.start ||
    caret.end > text.length
  ) {
    return fail('invalid_range', `光标 UTF-16 区间 [${String(caret.start)}, ${String(caret.end)}) 超出文本长度 ${String(text.length)}。`, {
      extra: { start: caret.start, end: caret.end, length: text.length },
    });
  }
  const rawStart = Math.max(0, caret.start - beforeLength);
  const rawEnd = Math.min(text.length, caret.end + afterLength);
  const startU = expandLeftToCodePoint(text, rawStart);
  const endU = expandRightToCodePoint(text, rawEnd);
  const startCp = utf16IndexToCodePointIndex(text, startU);
  const endCp = utf16IndexToCodePointIndex(text, endU);
  if (startCp === endCp) {
    return fail('empty_range', '要删除的范围为空（光标前/后没有可删的完整码位）。', {
      extra: { startU, endU, startCp, endCp },
    });
  }
  const split = splitInlinesAtRange(paragraph.value.inlines, startCp, endCp);
  if (!split.ok) return split;
  const replaced = replaceRangeInInlines(paragraph.value.inlines, startCp, endCp, '');
  if (!replaced.ok) return replaced;
  const updated = replaceParagraph(model, nodeId, { ...paragraph.value, inlines: replaced.value });
  if (!updated.ok) return updated;
  return succeed({
    model: updated.value,
    fragment: split.value.selected,
    range: { node_id: nodeId, start: startCp, end: endCp },
  });
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** 向左扩张到码位边界（若 `index` 落在代理对内部则左移 1）。 */
function expandLeftToCodePoint(text: string, index: number): number {
  let i = Math.max(0, Math.min(index, text.length));
  while (i > 0 && i < text.length && isHighSurrogate(text.charCodeAt(i - 1)) && isLowSurrogate(text.charCodeAt(i))) {
    i -= 1;
  }
  return i;
}

/** 向右扩张到码位边界（若 `index` 落在代理对内部则右移 1）。 */
function expandRightToCodePoint(text: string, index: number): number {
  let i = Math.max(0, Math.min(index, text.length));
  while (i > 0 && i < text.length && isHighSurrogate(text.charCodeAt(i - 1)) && isLowSurrogate(text.charCodeAt(i))) {
    i += 1;
  }
  return i;
}

/** 错误对象 → 一行描述（不吞错：把 name/message 带上）。 */
function describeUnknown(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * **文档会话**类型（design-05-P8 / WF-081–090；合同 R132–R146）。
 *
 * ## 这一层是什么
 *
 * `src/documents/{model,docx,selection,operations,units,styles}/**` 各自只解决一段：
 * 模型是什么、字节怎么读写、范围怎么解析、属性怎么改。**没有一层回答"一份文档的
 * 一生"**：它从哪来（新建 / 导入）、被谁改过几次、哪一版真的交付了、两个操作挤在
 * 同一个版本上会发生什么、失败了原来的文件还在不在。
 *
 * 本文件就是那些答案的**形状**。它是纯数据 + 纯接口：
 * - **不 import 内核**（`src/scheduler/**`、`src/artifacts/**`）——发布由注入端口做；
 * - **不做文件 IO**——持久化由注入端口做；
 * - 因此单测可以用内存端口把并发、幂等、失败恢复全部走一遍，不需要服务、不需要磁盘。
 *
 * ## 三个版本号必须分开（R141）
 *
 * | 号 | 含义 | 谁产生 |
 * |---|---|---|
 * | `edit_revision` | **编辑版本**：一次成功的操作计划 +1（R138 的撤销单元） | 本层（`applyEditPlan` 的模型 revision） |
 * | `task_revision` | **内核任务版本**：内核任务被实质性 patch 后的版本 | 内核（`src/protocol/task.ts`） |
 * | `artifact_version` | **产物版本**：同一任务同一模板种类下的第几版 | 内核（`resolveNextArtifactVersion`） |
 *
 * 三者**不得混为一个号**。它们之间的对应关系只能由一张**显式的映射表**回答，
 * 而映射表的一行**只在一次真实发布成功之后**才写（见 {@link PublishedVersion}）。
 * "编辑 revision 5 = 内核 taskRevision 3 = artifactVersion 2" 因此是可复算的，
 * 而不是从某个计数器里猜出来的。
 */

import type { EditStepReport } from '../edit/plan.js';
import type { NumberingTable } from '../numbering/types.js';
import type { FailureCode, FailureDetail } from '../selection/types.js';
import type { ListEditStepReport } from './list-ops.js';
import type { SectionEditStepReport } from './section-ops.js';

/** 会话 schema 标识（落盘时写入、读回时核对；不匹配按空会话启动，不猜）。 */
export const SESSION_SCHEMA = 'potbot-document-session.v1';

/** 会话 id：客户端生成、刷新保留。收窄以免进入路径/日志时产生歧义。 */
export type SessionId = string;

/** 编辑版本号（R141 的第一个号）。从 0 起；一次成功计划 +1。 */
export type EditRevision = number;

/** 内容摘要（裸小写 hex sha256）。**同一字节必然同一摘要**，用于比对而非"等于可信"。 */
export type ContentDigest = string;

/**
 * 一步编辑的回执。
 *
 * **三个域共用一张回执表**：文本编辑（`EditStepReport`，段落/字符域）、节操作
 * （`SectionEditStepReport`，`domain:'section'`）与列表操作（`ListEditStepReport`，`domain:'list'`）。
 * 它们共有的四个字段含义一致（`range` / `hitCount` / `changed` / `domain`），
 * 因此上层写一次遍历就能同时处理三者；
 * 而各自的专有字段（`toggleTarget`）保持可选，不会被摊平成一个"什么都有、什么都可能为空"的宽对象。
 */
export type SessionStepReport = EditStepReport | SectionEditStepReport | ListEditStepReport;

// ---------------------------------------------------------------------------
// 版本映射（R141）：一行 = 一次**已成功发布**的交付
// ---------------------------------------------------------------------------

/**
 * 一次成功发布的版本映射行。
 *
 * **只在发布回执到手之后才写**——"计划已经算出来了"或"字节已经导出了"都**不**产生这一行。
 * 这一条纪律就是"待验收"与"已交付"之间的分界：没有回执不允许声称交付（规则 5）。
 */
export interface PublishedVersion {
  /** R141 号 ①：编辑版本。 */
  readonly edit_revision: EditRevision;
  /** R141 号 ②：发布时内核任务的版本。 */
  readonly task_revision: number;
  /** R141 号 ③：内核产物版本（同任务同模板种类下的序号）。 */
  readonly artifact_version: number;
  /** 内核产物 id（下载面按它取文件；**不接受任意磁盘路径**）。 */
  readonly artifact_id: string;
  /** **回读**摘要（来自物化端口对最终路径的实际回读，不是导出前的期望值）。 */
  readonly content_digest: ContentDigest;
  /** 该版本文档在导出时的期望摘要（可与回读摘要比对，用于分辨"写盘被换过"）。 */
  readonly expected_digest: ContentDigest;
  readonly byte_length: number;
  readonly entry_count: number;
  readonly filename: string;
  readonly published_at: string;
}

/**
 * 发布失败记录。**旧版本不受影响**（R145）：失败记录只能说"这一次没成"，
 * 不能把 {@link PublishedVersion} 里的任何一行挤掉或改写。
 */
export interface PublicationFailureRecord {
  /** 承载失败的编辑版本（计划已成型、但没能发布的那一个）。 */
  readonly edit_revision: EditRevision;
  /** 结构化失败种类（`ArtifactFailureKind` 或本层自己的码，见 {@link SessionFailureCode}）。 */
  readonly kind: string;
  readonly detail: string;
  readonly at: string;
}

// ---------------------------------------------------------------------------
// 操作日志（R139）
// ---------------------------------------------------------------------------

export type OperationLogKind =
  /** 新建空文档。 */
  | 'session_created'
  /** 导入既有 DOCX。 */
  | 'imported'
  /** 一次操作计划被应用（成功）。 */
  | 'edit_applied'
  /** 同一幂等键的重复提交被识别（**不产生第二个版本**，R146）。 */
  | 'edit_replayed'
  /** 提交被拒（stale / 不支持 / 范围失败 / 幂等冲突 …）。 */
  | 'edit_rejected'
  /** 一次发布成功。 */
  | 'published'
  /** 一次发布失败（原文档保持完好，R145）。 */
  | 'publish_failed';

/**
 * 一条操作日志。**可持久化**，供恢复（R145）与审计（R139）。
 *
 * 刻意记下 `plan_digest`（计划原文的摘要）而不是计划本身：日志要能长期留存，
 * 而"这条计划是不是同一份"只需摘要即可回答；计划原文若需要留存，
 * 由调用方另行归档（本层不替它决定）。
 */
export interface OperationLogEntry {
  /** 单调递增序号（从 1 起）。日志顺序即时间顺序，不依赖墙钟排序。 */
  readonly seq: number;
  readonly kind: OperationLogKind;
  /** 该条**开始时**的编辑版本。 */
  readonly base_revision: EditRevision;
  /** 该条**结束后**的编辑版本（被拒时为 `base_revision` 本身）。 */
  readonly result_revision: EditRevision;
  readonly at: string;
  /** 幂等键（调用方给；首次提交时登记）。 */
  readonly idempotency_key: string | null;
  /** 计划原文摘要（`null` = 本条不对应任何计划，例如创建/导入）。 */
  readonly plan_digest: string | null;
  /** 范围表达式原文列表（回显用，逐字保留）。 */
  readonly ranges: readonly string[];
  /** 每个范围实际命中的段落数（与 `ranges` 同序）。 */
  readonly hit_counts: readonly number[];
  /** 本次是否真的改动了模型（幂等空转 ⇒ false）。 */
  readonly changed: boolean;
  /** 被拒/失败时的结构化原因；成功时为 `null`。 */
  readonly rejection: { readonly code: string; readonly message: string } | null;
}

// ---------------------------------------------------------------------------
// 幂等键（R137 / R146）
// ---------------------------------------------------------------------------

/**
 * 一条幂等记录。
 *
 * `fingerprint` 是**输入**（范围 + 操作 + baseRevision）的摘要：同一幂等键 + 同一输入 ⇒
 * 重放（不产生第二个版本）；同一幂等键 + **不同**输入 ⇒ `idempotency_conflict`
 * （把"换个操作偷懒复用同一个键"挡在外面，避免静默吞掉一次真实编辑）。
 */
export interface IdempotencyRecord {
  readonly key: string;
  readonly fingerprint: string;
  /** 首次应用后落到的编辑版本。 */
  readonly edit_revision: EditRevision;
  /**
   * 首次应用时的逐步回执。重放时**原样返回**——重放不得重新执行计划
   * （重新执行就可能把倍率再套一次、把插图再插一次，R137）。
   */
  readonly steps: readonly SessionStepReport[];
  readonly at: string;
}

// ---------------------------------------------------------------------------
// 发布端口（注入；本层不懂内核，只懂"交出字节、拿回回执"）
// ---------------------------------------------------------------------------

/**
 * 一次发布请求。**字节是唯一的交付物**——端口不得自行重建文档
 * （两处产出必然分叉；R151「只改格式不扁平化」的另一面）。
 */
export interface DocumentPublishRequest {
  readonly session_id: SessionId;
  /** 承载本次发布的**编辑版本**（会原样进映射表，便于对账）。 */
  readonly edit_revision: EditRevision;
  readonly document_id: string;
  readonly filename: string;
  /** 要发布的**导出字节**（调用方已算好，端口不得重建）。 */
  readonly bytes: Uint8Array;
  /** 上述字节的摘要（端口**必须**核对；不符即失败，不得落盘）。 */
  readonly expected_digest: ContentDigest;
  /** 上一版已交付摘要（首版为 `null`）；端口据此保证**不覆盖旧文件**（R145）。 */
  readonly previous_digest: ContentDigest | null;
  readonly idempotency_key: string | null;
}

/** 发布成功回执。`readback_digest` **必须**来自对最终路径的实际回读（I-1）。 */
export interface DocumentPublishReceipt {
  readonly artifact_id: string;
  readonly task_revision: number;
  readonly artifact_version: number;
  readonly readback_digest: ContentDigest;
  readonly byte_length: number;
  readonly entry_count: number;
  readonly filename: string;
  /** 谁做的读回核对（写进证据，便于分辨"内核回读"与"应用层回显"）。 */
  readonly verifier: string;
  readonly final_path: string;
}

/** 发布失败（结构化；**不抛错、不静默**）。`kind` 直接进日志与失败记录。 */
export interface DocumentPublishFailure {
  readonly kind: string;
  readonly detail: string;
}

/** 发布端口。实现方负责写盘、回读、核对摘要与**不破坏旧文件**。 */
export interface DocumentPublishPort {
  publish(request: DocumentPublishRequest): Promise<DocumentPublishResult>;
}

export type DocumentPublishResult =
  | { readonly ok: true; readonly receipt: DocumentPublishReceipt }
  | { readonly ok: false; readonly failure: DocumentPublishFailure };

// ---------------------------------------------------------------------------
// 持久化端口（注入；本层不做文件 IO）
// ---------------------------------------------------------------------------

export interface SessionPersistence {
  save(state: SessionState): void;
  /** 读回；返回 `unknown`（形状核对在本层做，端口不负责验证）。 */
  load(): unknown;
}

// ---------------------------------------------------------------------------
// 会话状态（可序列化 = 可持久化 = 刷新后仍在，WF-083）
// ---------------------------------------------------------------------------

/**
 * 会话的**完整**可序列化状态。
 *
 * `model` 是 `DocumentModel`（纯数据）；`bytes` **不**入状态——它由 `exportDocx(model)`
 * 确定性重建。这样状态不随文档体积膨胀，也不会出现"盘上字节与模型分叉"而无人发现：
 * 每一次导出都当场重算摘要并与 {@link CurrentDocument.content_digest} 比对。
 */
export interface SessionState {
  readonly schema: typeof SESSION_SCHEMA;
  readonly session_id: SessionId;
  readonly document_id: string;
  readonly filename: string;
  readonly created_at: string;
  /** 当前编辑版本（R141 号 ①）。 */
  readonly edit_revision: EditRevision;
  /** 当前模型（JSON 可往返）。 */
  readonly model: unknown;
  /**
   * 当前**编号表**（`word/numbering.xml` 的模型侧；WCF-D50 报出的缺口在此闭合）。
   *
   * 为什么它必须**与会话状态一起持久化**：编号表的定义侧**刻意不在**冻结骨架里
   * （`src/documents/numbering/types.ts` 头部：段落只存 `w:numPr` 引用），
   * 因此它只能由调用方带进 `exportDocx(model, { numbering })`。若它不进状态，
   * "保存 → 重新打开 → 导出"就会把整张编号表丢掉——段落里的 `numId` 还在，
   * 而定义没了，Word 打开就是一堆无编号的段落（静默丢数据，R151）。
   *
   * `null` = 本会话没有编号表（等价于"不传 `options.numbering`"，一个字节都不动）。
   * 纯 JSON 值（无 `Uint8Array`），但**仍走** `persistence.ts` 的显式编解码——
   * 编解码是整棵状态树的统一入口，不为"这一项恰好没有二进制"开例外。
   */
  readonly numbering: NumberingTable | null;
  /** 当前版本的导出摘要（每次导出都重新核对）。 */
  readonly content_digest: ContentDigest;
  /**
   * 导入文档的**原始上传字节**摘要（新建会话为 `null`）。
   *
   * 与 `content_digest` 分开：前者是"我们交出去的字节"，后者是"用户交进来的字节"。
   * 混用会让"导入后立刻导出是否保真"（R151）变成一个无法回答的问题。
   */
  readonly source_digest: ContentDigest | null;
  /** 文档来源（R109/R148：`imported` **不得**被当成用户已确认事实）。 */
  readonly source_kind: 'user_request' | 'imported' | 'model_generated' | 'system';
  readonly published: readonly PublishedVersion[];
  readonly last_failure: PublicationFailureRecord | null;
  readonly log: readonly OperationLogEntry[];
  readonly idempotency: readonly IdempotencyRecord[];
}

// ---------------------------------------------------------------------------
// 本层的失败码
// ---------------------------------------------------------------------------

/**
 * 会话层失败码 = 选择层既有码（`stale_revision` / `unsupported` / …）+ 本层新增。
 *
 * 刻意**不另起一套**：`stale_revision` 只有一个字面量、一个含义（R143），
 * 上层不需要在两个枚举之间翻译。
 */
export type SessionFailureCode =
  | FailureCode
  /** 幂等键复用但输入不同。 */
  | 'idempotency_conflict'
  /** 会话不存在（或已被丢弃）。 */
  | 'session_not_found'
  /**
   * 同一个会话 id 已被占用（已在内存里打开）。
   *
   * 为什么必须拒绝而不是**覆盖**：`create`/`import` 用同一个 id 再来一次，
   * 会静默替换掉调用方手里的那一份会话（连同它的版本映射与撤销栈一起消失），
   * 而调用方手里的引用看上去仍然"能用"。宁可在入口挡住，也不制造两个真相源。
   */
  | 'session_exists'
  /** 导入的字节不是可解析的 DOCX（带 `DocxError` 的原因）。 */
  | 'import_failed'
  /** 导出失败（模型 → 字节这一侧的结构问题）。 */
  | 'export_failed'
  /** 文档从未成功发布过（不得就此声称"保存成功"）。 */
  | 'not_published'
  /** 发布失败（写盘 / 回读 / 校验任一步；**原文档与既有版本均未改动**，R145）。 */
  | 'publish_failed'
  /** 会话状态无法读回（schema 不符 / 形状非法）→ 按空启动并如实报告。 */
  | 'state_unreadable'
  /** 撤销栈为空：当前没有可撤销的提交（**不是**"撤销成了空文档"）。 */
  | 'nothing_to_undo'
  /** 重做栈为空：已经被新的提交清空，或从未撤销过。 */
  | 'nothing_to_redo';

export interface SessionFailureDetail extends FailureDetail {
  /** 发布失败的结构化种类（`publish_failed` 时给出）。 */
  readonly publishFailureKind?: string;
}

export interface SessionOk<T> {
  readonly ok: true;
  readonly value: T;
}

export interface SessionFailure {
  readonly ok: false;
  readonly code: SessionFailureCode;
  readonly message: string;
  readonly detail: SessionFailureDetail;
}

/**
 * 会话层结果。**失败绝不携带"半成品值"**（R136 的原子性在类型上成立：
 * 失败分支里根本没有模型字段可被误用）。
 *
 * 与 `selection/types.ts` 的 `Result<T>` 形状一致（`ok` / `code` / `message` / `detail`），
 * 只是 `code` 多出本层的几个字面量——这样上层写一次分支就能同时处理两层的结果。
 */
export type SessionResult<T> = SessionOk<T> | SessionFailure;

// ---------------------------------------------------------------------------
// 撤销 / 重做（WF-086 / R138：一次计划 = 一次事务 = 一个撤销单元）
// ---------------------------------------------------------------------------

/**
 * 撤销 / 重做的输入绑定。
 *
 * **与 `submitEdit` 用同一套版本纪律**（R142/R143）：调用方必须带上它所依据的编辑版本与
 * 内容摘要；两者任一不符即 `stale_revision`。撤销不是"绕过并发核对的后门"。
 */
export interface HistoryCommandInput {
  readonly idempotency_key: string;
  readonly base_revision: EditRevision;
  readonly base_digest: ContentDigest;
}

/** 历史操作种类。 */
export type HistoryOperationKind = 'undo' | 'redo';

/**
 * 撤销 / 重做的一步结果。
 *
 * ## 关键约定：撤销**不倒退**编辑版本号（跨保存可验证的行为，WF-086）
 *
 * 撤销把文档内容恢复成**上一个已交付版本的内容**，但它落地为一次**新的、向前的**编辑版本
 * （`edit_revision` = 撤销前 + 1）。理由：
 * - R141 的三个号是**只增**的账，倒扣会让"artifact_version 3 对应 edit_revision 1"这种
 *   历史行变得无法解释；
 * - 撤销后**旧文件仍然在盘上**（发布端口不覆盖旧文件，R145），所以"回到旧版本"这件事
 *   本身必须是**新交付一版内容相同的文件**，而不是把别人的文件路径挪回来。
 *
 * `history` **只在内存里**：进程被杀后重开，撤销栈为空（`canUndo()` 为 false）。
 * 这条跨保存行为是**预先约定**的，并被 `tests/mobile-office/word/W10` 的用例直接断言。
 */
export interface HistoryOutcome {
  readonly kind: HistoryOperationKind;
  /** 命中幂等键：没有产生第二版，返回首次回执。 */
  readonly replayed: boolean;
  /** 本次历史操作后**当前**的编辑版本（总是"撤销前 + 1"）。 */
  readonly edit_revision: EditRevision;
  /** 其内容被恢复出来的**历史编辑版本**（可回指映射表里那一行）。 */
  readonly restored_from_revision: EditRevision;
  /** 恢复后当前已交付版本。 */
  readonly published: PublishedVersion | null;
  /** 本次操作后撤销栈/重做栈的剩余深度（供 UI 灰化按钮；不猜）。 */
  readonly remaining_undo: number;
  readonly remaining_redo: number;
}

/** 只读的历史视图（`inspect` 工具用；不暴露栈内的模型快照）。 */
export interface HistoryView {
  readonly can_undo: boolean;
  readonly can_redo: boolean;
  readonly undo_depth: number;
  readonly redo_depth: number;
  readonly capacity: number | null;
}

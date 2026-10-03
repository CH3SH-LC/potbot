/**
 * **交付会话的类型形状**（design-06 P8/P9 的产品入口；合同 R232 / R241–R252 的格式无关部分）。
 *
 * ## 这一层是什么（以及**不是**什么）
 *
 * `src/documents/session/**` 是**字处理会话**：它的"源"是 `DocumentModel`，它的编辑语义是
 * 段落 / 字符 / 节 / 列表，它的导出器是 `exportDocx`。表格与演示没有这些语义。
 *
 * 本层只保留**三种办公格式真正共享的那一段**："一份交付物的一生"——
 * 它有编辑版本号、有操作日志、有幂等键、有"哪些版本真的交付过"的映射表、
 * 有"发布失败时旧文件一个字节都不许动"的纪律。**格式相关的部分全部由注入的
 * 适配器回答**（{@link ./adapter.js}），本层不认识 DOCX / XLSX / PPTX 任何一个。
 *
 * ## 三号分开（R141，与字处理会话同一条纪律）
 *
 * | 号 | 含义 | 谁产生 |
 * |---|---|---|
 * | `edit_revision` | **编辑版本**：一次成功的发布 +1 | 本层 |
 * | `task_revision` | **内核任务版本** | 内核（发布端口带回） |
 * | `artifact_version` | **产物版本** | 内核（发布端口带回） |
 *
 * 三者不混为一个号；它们的对应关系只由 {@link PublishedVersion} 这张表回答，
 * 而**表的一行只在一次真实发布成功之后才写**（规则 5：没有回执不得声称交付）。
 *
 * 纪律：纯数据 + 纯接口；零 IO、零墙钟、零随机数。
 */

import type { TemplateKind } from '../protocol/index.js';
import type { FileFormat } from './formats.js';

/** 会话 schema 标识（落盘时写入、读回时核对；不匹配按空启动，不猜）。 */
export const DELIVERABLE_SESSION_SCHEMA = 'potbot-deliverable-session.v1';

/** 会话 id：客户端生成、刷新保留。 */
export type SessionId = string;

/** 编辑版本号（R141 号 ①）。 */
export type EditRevision = number;

/** 内容摘要（裸小写 hex sha256）。 */
export type ContentDigest = string;

/** 一份交付物从哪里来（R148：`imported` **不得**被当成用户已确认事实）。 */
export type DeliverableSourceKind = 'user_request' | 'imported' | 'model_generated' | 'system';

// ---------------------------------------------------------------------------
// 版本映射（R141）
// ---------------------------------------------------------------------------

/**
 * 一次成功发布的版本映射行。**只在发布回执到手之后才写。**
 *
 * 与字处理会话的同名结构相比，这里多出 `file_format` / `mime_type` / `template_kind`：
 * 下载面必须能**只凭这一行**回答"该发什么 Content-Type、该用什么扩展名"，
 * 而不是回头去问另一个索引——两个真相源必然分叉（R232 的交付侧要求）。
 */
export interface PublishedVersion {
  /** R141 号 ①：编辑版本。 */
  readonly edit_revision: EditRevision;
  /** R141 号 ②：发布时内核任务的版本。 */
  readonly task_revision: number;
  /** R141 号 ③：内核产物版本。 */
  readonly artifact_version: number;
  readonly artifact_id: string;
  /** 回读摘要（来自物化端口对最终路径的**实际回读**）。 */
  readonly content_digest: ContentDigest;
  /** 导出时的期望摘要（可与回读摘要比对，用于分辨"写盘被换过"）。 */
  readonly expected_digest: ContentDigest;
  readonly byte_length: number;
  readonly entry_count: number;
  readonly filename: string;
  /** 交付文件格式（`docx` / `xlsx` / `pptx`）。 */
  readonly file_format: FileFormat;
  /** 该格式的官方 MIME（下载头直接用它，不再另查一张表）。 */
  readonly mime_type: string;
  /** 产物记录里的模板种类（R232：与文件格式**分开**的两个轴）。 */
  readonly template_kind: TemplateKind;
  readonly published_at: string;
}

/** 发布失败记录。**旧版本不受影响**（R145）。 */
export interface PublicationFailureRecord {
  readonly edit_revision: EditRevision;
  readonly kind: string;
  readonly detail: string;
  readonly at: string;
}

// ---------------------------------------------------------------------------
// 操作日志（R139）
// ---------------------------------------------------------------------------

export type OperationLogKind =
  /** 开会话（新建 / 导入）。 */
  | 'session_created'
  /** 一次编辑 + 发布被应用（成功）。 */
  | 'published'
  /** 同一幂等键的重复提交被识别（**不产生第二个版本**，R146）。 */
  | 'replayed'
  /** 提交被拒（基线不符 / 编辑非法 / 幂等冲突 …）。 */
  | 'rejected'
  /** 一次发布失败（旧文件与旧版本保持完好，R145）。 */
  | 'publish_failed';

/** 一条操作日志（可持久化，供恢复与审计）。 */
export interface OperationLogEntry {
  /** 单调递增序号（从 1 起）。日志顺序即时间顺序，不依赖墙钟排序。 */
  readonly seq: number;
  readonly kind: OperationLogKind;
  readonly base_revision: EditRevision;
  /** 本条结束后的编辑版本（被拒时为 `base_revision` 本身）。 */
  readonly result_revision: EditRevision;
  readonly at: string;
  readonly idempotency_key: string | null;
  /** 提交原文摘要（`null` = 本条不对应任何提交，例如开会话）。 */
  readonly submission_digest: string | null;
  /** 本次是否真的改动过源（幂等重放 / 无编辑提交 ⇒ false）。 */
  readonly changed: boolean;
  readonly rejection: { readonly code: string; readonly detail: string } | null;
}

// ---------------------------------------------------------------------------
// 幂等（R137 / R146）
// ---------------------------------------------------------------------------

/**
 * 一条幂等记录。
 *
 * `fingerprint` 是**输入**（编辑内容 + baseRevision）的摘要：同一幂等键 + 同一输入 ⇒
 * 重放（不产第二个版本）；同一幂等键 + **不同**输入 ⇒ `idempotency_conflict`。
 * 后者把"换个编辑偷懒复用同一个键"挡在外面，避免静默吞掉一次真实改动。
 */
export interface IdempotencyRecord {
  readonly key: string;
  readonly fingerprint: string;
  readonly edit_revision: EditRevision;
  /** 首次应用时的发布回执视图（重放时**原样返回**，不重新执行）。 */
  readonly outcome: PublishOutcome;
  readonly at: string;
}

// ---------------------------------------------------------------------------
// 发布端口（注入；本层不懂内核，只懂"交出字节、拿回回执"）
// ---------------------------------------------------------------------------

/**
 * 一次发布请求。**字节是唯一的交付物**——端口不得自行重建文档。
 *
 * `file_format` / `template_kind` / `filename` 一并给出，端口据此做**格式互不冒充**
 * 校验、派生产物记录与落盘路径；本层不假设端口会自己去猜。
 */
export interface DeliverablePublishRequest {
  readonly session_id: SessionId;
  readonly edit_revision: EditRevision;
  /** 会话的稳定 id（进产物记录的来源事实与任务 id 派生）。 */
  readonly deliverable_id: string;
  readonly filename: string;
  readonly file_format: FileFormat;
  readonly template_kind: TemplateKind;
  /** 要发布的**导出字节**（调用方已算好，端口不得重建）。 */
  readonly bytes: Uint8Array;
  /** 上述字节的摘要（端口**必须**核对；不符即失败，不得落盘）。 */
  readonly expected_digest: ContentDigest;
  /** 上一版已交付摘要（首版为 `null`）；端口据此保证**不覆盖旧文件**（R145）。 */
  readonly previous_digest: ContentDigest | null;
  readonly idempotency_key: string | null;
}

/** 发布成功回执。`readback_digest` **必须**来自对最终路径的实际回读（I-1）。 */
export interface DeliverablePublishReceipt {
  readonly artifact_id: string;
  readonly task_revision: number;
  readonly artifact_version: number;
  readonly readback_digest: ContentDigest;
  readonly byte_length: number;
  readonly entry_count: number;
  readonly filename: string;
  readonly verifier: string;
  readonly final_path: string;
}

/** 发布失败（结构化；不抛错、不静默）。 */
export interface DeliverablePublishFailure {
  readonly kind: string;
  readonly detail: string;
}

export type DeliverablePublishResult =
  | { readonly ok: true; readonly receipt: DeliverablePublishReceipt }
  | { readonly ok: false; readonly failure: DeliverablePublishFailure };

/** 发布端口。实现方负责写盘、回读、核对摘要与**不破坏旧文件**。 */
export interface DeliverablePublishPort {
  publish(request: DeliverablePublishRequest): Promise<DeliverablePublishResult>;
}

// ---------------------------------------------------------------------------
// 持久化端口（注入；本层不做文件 IO）
// ---------------------------------------------------------------------------

export interface SessionPersistence {
  save(state: DeliverableSessionState): void;
  /** 读回；返回 `unknown`（形状核对在本层做，端口不负责验证）。 */
  load(): unknown;
}

// ---------------------------------------------------------------------------
// 会话状态（可序列化 = 可持久化 = 刷新后仍在）
// ---------------------------------------------------------------------------

/**
 * 会话的**完整**可序列化状态。
 *
 * `source` 是适配器自己的源对象（`WorkbookState` / `Presentation` / …）：本层只把它
 * 当**不透明 JSON 值**存取，绝不解释它的字段。字节**不**入状态——它由适配器
 * 确定性重算，因此状态不随体积膨胀，也不会出现"盘上字节与源分叉"而无人发现。
 */
export interface DeliverableSessionState {
  readonly schema: typeof DELIVERABLE_SESSION_SCHEMA;
  readonly session_id: SessionId;
  readonly deliverable_id: string;
  readonly filename: string;
  readonly file_format: FileFormat;
  readonly template_kind: TemplateKind;
  readonly created_at: string;
  readonly edit_revision: EditRevision;
  /** 当前源（不透明 JSON；由适配器解释）。 */
  readonly source: unknown;
  /** 当前版本的导出摘要（每次导出都重新核对）。 */
  readonly content_digest: ContentDigest;
  /** 导入源的**原始字节**摘要（新建会话为 `null`）。 */
  readonly source_digest: ContentDigest | null;
  readonly source_kind: DeliverableSourceKind;
  readonly published: readonly PublishedVersion[];
  readonly last_failure: PublicationFailureRecord | null;
  readonly log: readonly OperationLogEntry[];
  readonly idempotency: readonly IdempotencyRecord[];
}

// ---------------------------------------------------------------------------
// 结果类型与失败码
// ---------------------------------------------------------------------------

/**
 * 本层的失败码。刻意**不另起一套**通用码（`stale_revision` 只有一个字面量、一个含义）。
 */
export type DeliverableFailureCode =
  /** 基线不符（R142/R143）。 */
  | 'stale_revision'
  /** 幂等键复用但输入不同。 */
  | 'idempotency_conflict'
  /** 会话不存在。 */
  | 'session_not_found'
  /** 会话已存在。 */
  | 'session_already_exists'
  /**
   * 文件名与声明的文件格式不符（扩展名缺失/不匹配）。
   *
   * 单列一个码而不是并进 `unsupported`：这是**请求侧**的错误（用户把 `.docx` 当成
   * 表格交付），HTTP 面必须回 4xx 且**不可重试**——并进上游失败类会给客户端一个
   * "重试可能就好了"的错误暗示（R232 的互不冒充在状态码上也要说得清）。
   */
  | 'invalid_filename'
  /** 编辑意图不合法 / 不被支持（**源零改动**）。 */
  | 'unsupported'
  /** 导入的字节不是可解析的该格式文件。 */
  | 'import_failed'
  /** 导出失败（源 → 字节这一侧的结构问题）。 */
  | 'export_failed'
  /** 文档从未成功发布过（不得就此声称"保存成功"）。 */
  | 'not_published'
  /** 发布失败（写盘 / 回读 / 校验任一步；**旧文件与既有版本均未改动**，R145）。 */
  | 'publish_failed'
  /** 会话状态无法读回（schema 不符 / 形状非法）。 */
  | 'state_unreadable';

export interface DeliverableFailureDetail {
  readonly extra: Readonly<Record<string, unknown>>;
  /** 发布失败的结构化种类（`publish_failed` 时给出）。 */
  readonly publishFailureKind?: string;
}

export interface SessionOk<T> {
  readonly ok: true;
  readonly value: T;
}

export interface SessionFailure {
  readonly ok: false;
  readonly code: DeliverableFailureCode;
  readonly message: string;
  readonly detail: DeliverableFailureDetail;
}

/**
 * 会话层结果。**失败绝不携带"半成品值"**：失败分支里根本没有源可被误用，
 * 因此"整批成功或整批不修改"在类型上成立（R136 的原子性）。
 */
export type SessionResult<T> = SessionOk<T> | SessionFailure;

/** 一次发布提交的结果（也是幂等重放时原样返回的视图）。 */
export interface PublishOutcome {
  /** 是否命中幂等键（**没有**产生第二个版本）。 */
  readonly replayed: boolean;
  /** 本次是否真的改动了源（无编辑提交 / 编辑空转 ⇒ false）。 */
  readonly changed: boolean;
  readonly edit_revision: EditRevision;
  /** 本次发布后已交付的版本；从未发布过时为 `null`。 */
  readonly published: PublishedVersion | null;
}

/** 会话状态视图（`GET /api/deliverables/:id` 的语义来源）。 */
export interface DeliverableStatusView {
  readonly session_id: SessionId;
  readonly deliverable_id: string;
  readonly filename: string;
  readonly file_format: FileFormat;
  readonly template_kind: TemplateKind;
  readonly created_at: string;
  readonly edit_revision: EditRevision;
  readonly content_digest: ContentDigest;
  readonly source_kind: DeliverableSourceKind;
  readonly source_digest: ContentDigest | null;
  readonly published: readonly PublishedVersion[];
  readonly current: PublishedVersion | null;
  readonly last_failure: PublicationFailureRecord | null;
  readonly log: readonly OperationLogEntry[];
}

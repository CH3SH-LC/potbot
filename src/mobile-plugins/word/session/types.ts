/**
 * **手机 Word 会话插件**的形状（W10；WF-081–088；OfficePlugin v1 + FactsPort v1）。
 *
 * ## 这一层负责什么
 *
 * `src/documents/session/**` 已经回答"一份文档的一生"（新建 / 导入 / 提交 / 发布 / 撤销 /
 * 恢复）。本层把那一套**接成手机可用的一组工具**（README §5 的 `OfficePlugin`
 * `create/import/inspect/apply/export/undo/redo` 面），并补上 W10 判据里另外两件事：
 *
 * - **另存副本（WF-084）**：副本得到**自己的新版本**，原件一个字节不动；
 * - **事实订阅（FactsPort v1，K08 契约的消费侧）**：绑定一个已发布快照的
 *   `snapshotId/revision`，消费时**先做版本校验**，再出一张**实际消费回执**。
 *
 * ## 这一层刻意不做的事
 *
 * - 不拼 DOCX XML（归 `src/documents/docx/**`）；
 * - 不自己记账版本（归 `src/documents/session/**`）；
 * - 不持 API key、不发网络请求（事实由注入的 {@link FactsPort} 提供，端口实现归 K08）。
 */

import type { EditPlan } from '../../../documents/edit/plan.js';
import type {
  ContentDigest,
  HistoryOutcome,
  HistoryView,
  PublishedVersion,
  SessionFailureCode,
  SessionStatusView,
} from '../../../documents/session/index.js';
import type { NumberingTable } from '../../../documents/numbering/types.js';
import type { FactSource, KnownFactValue } from '../../../protocol/index.js';

// ---------------------------------------------------------------------------
// 工具面（OfficePlugin v1 的窄化）
// ---------------------------------------------------------------------------

/** Word 插件产出的 MIME（单一格式：本插件只产出 DOCX）。 */
export const WORD_DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * 本插件暴露的工具名。
 *
 * README §5 的 `OfficePlugin` 面（`create/import/inspect/apply/export/undo/redo`）
 * **原样保留**，再加四个本层实际拥有、且回执必须能被指认的动作：
 * `saveAs`（另存副本，WF-084）、`publishCurrent`（副本首版落地）、
 * `restore`（杀进程后重开，WF-083）、`bindFacts`/`consumeFacts`（事实订阅与消费，WF-087）。
 *
 * 为什么这些也要进 `tool` 字段而不是"借用 import 的名字"：回执是取证材料，
 * 它第一行就要能回答"这是哪一次工具调用产生的"——借名会让证据对不上动作。
 */
export type WordTool =
  | 'create'
  | 'import'
  | 'restore'
  | 'inspect'
  | 'apply'
  | 'export'
  | 'undo'
  | 'redo'
  | 'saveAs'
  | 'publishCurrent'
  | 'bindFacts'
  | 'consumeFacts';

/**
 * 一次工具调用的统一回执外壳（OfficePlugin v1：`artifactId, revision, digest, mime,
 * changedObjects, warnings, receipt`）。
 *
 * `receipt` 刻意是 `null | PublishedVersion`：**没交付就没回执**——"本次没发布"必须能被读出来，
 * 不能用一个空对象冒充"发布过了"。
 */
export interface WordToolOutcome {
  readonly tool: WordTool;
  readonly session_id: string;
  readonly document_id: string;
  readonly revision: number;
  readonly digest: string;
  readonly mime: string;
  /** 本次改动的对象标签（范围表达式 / 撤销重做等）；无改动为 `[]`。 */
  readonly changed_objects: readonly string[];
  readonly warnings: readonly string[];
  /** 本次工具调用交付的 artifact id；未交付为 `null`。 */
  readonly artifact_id: string | null;
  /** 本次是否真的产出了一个新交付版本。 */
  readonly published: boolean;
}

// ---------------------------------------------------------------------------
// 另存副本（WF-084）
// ---------------------------------------------------------------------------

export interface SaveAsRequest {
  /** 幂等键（R137；重试必须复用）。 */
  readonly idempotency_key: string;
  /** 副本自己的会话 id（原件与副本必须是两个会话）。 */
  readonly new_session_id: string;
  /** 副本文件名（须以 .docx 结尾）。 */
  readonly filename: string;
}

/** 原件的保护快照：另存前后**必须逐字段相同**（测试直接断言）。 */
export interface OriginalProtectionSnapshot {
  readonly session_id: string;
  readonly document_id: string;
  readonly revision: number;
  readonly digest: string;
  readonly published_count: number;
}

export interface SaveAsOutcome {
  readonly original: OriginalProtectionSnapshot;
  readonly copy: {
    readonly session_id: string;
    readonly document_id: string;
    readonly revision: number;
    readonly digest: string;
    readonly artifact_id: string;
    readonly filename: string;
    readonly mime: string;
  };
  /** 副本内容是否与副本创建那一刻的原件逐字节相同（应恒为 true；为 false 说明往返不保真）。 */
  readonly byte_identical_to_original: boolean;
}

// ---------------------------------------------------------------------------
// 事实订阅 / 消费（FactsPort v1，消费侧）
// ---------------------------------------------------------------------------

/** 快照里一条**可用**事实（已知值 + 单位 + 来源）。 */
export interface FactsSnapshotEntry {
  readonly fact_key: string;
  readonly fact_ref: string;
  readonly value: KnownFactValue;
  /** 单位（数值事实常有；日期/文本为 `null`）。 */
  readonly unit: string | null;
  readonly source: FactSource;
}

/**
 * 只读事实快照（FactsPort v1 的消费侧视图）。
 *
 * 与 K08 的装配契约一一对应：`snapshotId, revision, sourceRefs, values, units`。
 * 本层**只读不改**——装配与"单一来源"判据在 K08（`src/facts/snapshot.ts`）。
 */
export interface FactsSnapshotView {
  readonly snapshot_id: string;
  readonly task_id: string;
  readonly task_revision: number;
  readonly source_refs: readonly string[];
  readonly values: readonly FactsSnapshotEntry[];
}

/**
 * 事实端口（K08 拥有的正式实现的消费侧接口）。
 *
 * 刻意只给一个**同步取当前快照**的方法：真正的发布、单一来源校验、版本推进都在 K08 那侧。
 * 本层拿到的是某一刻的**只读视图**，因此"校验版本"这件事只能发生在**消费的那一刻**。
 */
export interface FactsPort {
  /** 取该任务当前的只读快照；该任务没有任何快照时返回 `null`（不得伪造成空快照）。 */
  snapshot(task_id: string): FactsSnapshotView | null;
}

/** 文档对某份事实快照的绑定（订阅 = 记下"我依赖的是这一版"）。 */
export interface FactsBinding {
  readonly snapshot_id: string;
  readonly task_id: string;
  readonly task_revision: number;
}

/** 实际消费回执：证明"哪一版的哪些事实、在什么时候、被哪个消费者真正取用"。 */
export interface FactsConsumptionReceipt {
  readonly snapshot_id: string;
  readonly task_id: string;
  readonly consumer: string;
  /** 消费发生时刻文档的编辑版本（把回执钉到具体文档版本上）。 */
  readonly document_revision: number;
  /** 文档绑定的目标版本。 */
  readonly bound_revision: number;
  /** 实际取到的快照版本（校验通过时 == `bound_revision`）。 */
  readonly consumed_revision: number;
  /** 消费的值是否来自与绑定**同一个快照 id**。 */
  readonly snapshot_id_match: boolean;
  /** 实际消费的事实 ref 列表（原样来自快照，不补不删）。 */
  readonly consumed_fact_refs: readonly string[];
  readonly consumed_keys: readonly string[];
  /** 消费值的规范化摘要（独立复算可核对）。 */
  readonly values_digest: string;
  readonly consumed_at: string;
  /** 空快照等需要如实提示的情形（**不是**"消费成功"的替代）。 */
  readonly warnings: readonly string[];
}

export type FactsFailureCode =
  /** 已绑定版本与当前快照版本不一致 ⇒ 拒绝消费（需重新绑定）。 */
  | 'facts_version_changed'
  /** 端口里没有该任务的快照。 */
  | 'facts_snapshot_missing'
  /** 还没绑定任何快照就尝试消费。 */
  | 'facts_not_bound'
  /** 插件没有配置事实端口。 */
  | 'facts_not_configured';

export type FactsConsumptionResult =
  | { readonly ok: true; readonly receipt: FactsConsumptionReceipt }
  | { readonly ok: false; readonly code: FactsFailureCode; readonly message: string };

/** 插件启动参数（每种入口共用的端口与时钟）。 */
export interface WordSessionPorts {
  readonly publish_port: import('../../../documents/session/index.js').DocumentPublishPort;
  /** 按 session id 取持久化载体（每个会话一个）。 */
  readonly persistence_for: (sessionId: string) => import('../../../documents/session/index.js').SessionPersistence;
  /** 墙钟（只用于日志/时间戳；**不参与判定**）。 */
  readonly now: () => Date;
  /** 事实端口（可选；不配则 `consumeFacts` 返回 `facts_not_configured`）。 */
  readonly facts_port?: FactsPort;
}

/** 新建/导入所需的会话元数据。 */
export interface OpenWordSessionInput {
  readonly id: string;
  readonly filename: string;
  readonly numbering?: NumberingTable | null;
  readonly max_undo?: number | null;
}

// ---------------------------------------------------------------------------
// 工具调用：请求形状（每个工具一个显式形状，不用"一个大入参、字段大多可选"的宽对象）
// ---------------------------------------------------------------------------

/** 新建（WF-081）：以一份**真实包字节**为起点。 */
export interface OpenWordSessionRequest extends OpenWordSessionInput {
  readonly template: Uint8Array;
}

/** 导入既有 DOCX（WF-082）。 */
export interface ImportWordSessionRequest extends OpenWordSessionInput {
  readonly bytes: Uint8Array;
}

/**
 * 杀进程后重开（WF-083）。
 *
 * `filename` **刻意可选**：重开后文件名以**持久化状态里的那份**为准
 * （状态是真相源；让 UI 再手输一次，既可能输错，也会让"重开"变成"改名"）。
 * 只有状态里没有可用文件名时，才回落到这里的 `filename`。
 */
export interface RestoreWordSessionRequest {
  readonly id: string;
  readonly filename?: string;
  readonly max_undo?: number | null;
}

/** 一次编辑提交（WF-085：复合修改走一次事务）。 */
export interface ApplyWordEditRequest {
  readonly session_id: string;
  readonly idempotency_key: string;
  readonly base_revision: number;
  readonly base_digest: ContentDigest;
  /** 与 `plan` / `section_intent` / `list_intent` **四选一**（与 `submitEdit` 同一纪律）。 */
  readonly intent?: unknown;
  readonly plan?: EditPlan;
  readonly section_intent?: unknown;
  readonly list_intent?: unknown;
}

/** 撤销 / 重做（WF-086）。 */
export interface WordHistoryRequest {
  readonly session_id: string;
  readonly idempotency_key: string;
  readonly base_revision: number;
  readonly base_digest: ContentDigest;
}

/** 把当前内容作为一次新版本交付（另存副本的首版落地；WF-084）。 */
export interface WordPublishCurrentRequest extends WordHistoryRequest {}

/** 另存副本（WF-084）。 */
export interface WordSaveAsToolRequest {
  readonly session_id: string;
  readonly request: SaveAsRequest;
}

/** 绑定（订阅）一份事实快照。 */
export interface WordBindFactsRequest {
  readonly session_id: string;
  /** 绑定的任务 id：快照按任务取（`FactsPort.snapshot(task_id)`）。 */
  readonly task_id: string;
}

/** 消费一次事实。 */
export interface WordConsumeFactsRequest {
  readonly session_id: string;
  /**
   * 消费所钉住的**文档编辑版本**；省略 = 当前版本。
   *
   * 给了却与当前版本不符 ⇒ 拒绝（`stale_revision`）：拿一张旧文档版本的号码去消费当前事实，
   * 会让回执指向一份**不存在的证据组合**（老文档 + 新事实），这比"没消费"更坏。
   */
  readonly document_revision?: number;
}

// ---------------------------------------------------------------------------
// 工具调用：回执形状（OfficePlugin v1 外壳 + 本次真正交付的东西）
// ---------------------------------------------------------------------------

/**
 * 工具回执：外壳 + 本次真正交付的版本（`null` = 本次没有产出新版本）。
 *
 * 为什么把版本**对象**一并给出、而不是只给 `artifact_id`：手机端要立刻算出"这一版对应哪个
 * artifact / 哪个 taskRevision"，而不是回头再查一次状态——两次查询之间状态可能已经前进，
 * 查回来的就不再是"这一版"了。
 */
export interface WordToolReceipt extends WordToolOutcome {
  readonly version: PublishedVersion | null;
}

/**
 * 导出当前版本的字节（WF-081/083）。
 *
 * `bytes` 与 `content_digest` 是**当场复算**的：`DocumentSession.exportBytes()` 会在导出前
 * 把摘要与状态比对，不符即失败——因此这里给出的字节不是"我以为的这份"，而是"状态认可的那份"。
 * `published` 恒为 `false`：**导出≠交付**（交付只发生在发布端口回执到手之后，R144）。
 */
export interface WordExportResult extends WordToolReceipt {
  readonly bytes: Uint8Array;
  readonly byte_length: number;
  readonly content_digest: ContentDigest;
}

/** 撤销 / 重做回执（WF-086）。 */
export interface WordHistoryReceipt extends WordToolReceipt {
  readonly history: HistoryOutcome;
}

/** 另存副本回执（WF-084）。 */
export interface WordSaveAsReceipt extends WordToolReceipt {
  readonly save_as: SaveAsOutcome;
  /** 副本自己的会话 id（调用方拿它继续改副本）。 */
  readonly copy_session_id: string;
}

/** 事实绑定回执。 */
export interface WordBindFactsReceipt extends WordToolReceipt {
  readonly binding: FactsBinding;
}

/**
 * 事实消费回执。
 *
 * `consumption.ok === false` 时**没有回执**（`facts_version_changed` 等结构化失败）——
 * 与外层的 `SessionResult.ok` 是两件事：这里 `ok:true` 只说"工具跑完了"，
 * "事实到底消费成没成"只由 `consumption` 回答。二者刻意不合并。
 */
export interface WordFactsReceipt extends WordToolReceipt {
  readonly consumption: FactsConsumptionResult;
}

/**
 * 事实工具（`bindFacts` / `consumeFacts`）的结果。
 *
 * 为什么**不**直接复用 `SessionResult<T>`：这两件事的失败分属两层——
 * "会话没找到"是会话层的事，而"端口没配 / 没绑定 / 快照没了"是事实层的结构化失败。
 * 把它们压进同一个 `code` 联合会让上层无法判断"该去建会话还是该去问 K08"。
 * `scope` 就是那个判别位。
 *
 * 注意 `consumption.ok === false`（版本已变等）**不**走这个失败分支：
 * 那时工具确实跑完了，拒绝消费是它的**结果**（见 {@link WordFactsReceipt}）。
 */
export type WordFactsResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly scope: 'session' | 'facts';
      readonly code: SessionFailureCode | FactsFailureCode;
      readonly message: string;
    };

/** 只读检视（`inspect` 工具）：状态 + 历史 + 事实三个只读面。 */
export interface WordInspectReceipt extends WordToolReceipt {
  readonly status: SessionStatusView;
  readonly history: HistoryView;
  readonly facts: {
    readonly binding: FactsBinding | null;
    readonly receipt_count: number;
  };
}

/**
 * 重开结果。
 *
 * `loaded:false` 时 `outcome` 为 `null`（**没有会话可给**——不拿半截会话继续用）：
 * 调用方据此选择"新建"或"导入"，而不是以为重开成功了。
 */
export interface WordRestoreReceipt {
  readonly loaded: boolean;
  readonly reason: string;
  readonly outcome: WordToolOutcome | null;
}

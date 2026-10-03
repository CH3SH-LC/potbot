/**
 * 共享语义常量（合同冻结 v1）。**这里是唯一的字面量来源**，下游模块不得各自复制。
 *
 * 覆盖范围：消息类型、工作项六态、实例活动态、轮次状态、发布拒绝原因、
 * 阻塞原因、路由结果、事件种类、信任标签、revision 触发类别、默认预算。
 * 本文件不含状态、不做 I/O。
 */

// ---------------------------------------------------------------------------
// §8.1 消息类型（任务书:167 — 首版消息类型）
// ---------------------------------------------------------------------------

export const MESSAGE_TYPES = [
  'work_request', // 工作请求
  'work_result', // 工作结果
  'blocked_report', // 阻塞报告
  'cancel', // 取消
  'requirement_update', // 需求更新
  'capability_missing', // 能力缺失
  'user_input_request', // 用户输入请求
  'stage_result', // 必要阶段性成果
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

/** 中文标签，仅用于证据 / 报告的可读输出，不参与任何判定。 */
export const MESSAGE_TYPE_LABELS: Readonly<Record<MessageType, string>> = {
  work_request: '工作请求',
  work_result: '工作结果',
  blocked_report: '阻塞报告',
  cancel: '取消',
  requirement_update: '需求更新',
  capability_missing: '能力缺失',
  user_input_request: '用户输入请求',
  stage_result: '必要阶段性成果',
};

// ---------------------------------------------------------------------------
// §7.3 / 需求 4 工作项六态（合同：封闭最小值，可增不可减）
// ---------------------------------------------------------------------------

export const WORK_ITEM_STATUSES = [
  'pending', // 待处理
  'processing', // 处理中
  'waiting_dependency', // 等待依赖
  'completed', // 已完成
  'failed', // 失败
  'cancelled', // 取消
] as const;

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

/** 终态：完成 / 失败 / 取消。终态互斥，且不得被旧轮次回退（合同 §九-9）。 */
export const TERMINAL_WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  'completed',
  'failed',
  'cancelled',
];

/** 非终态：**必须有**明确等待原因或阻塞原因（任务书:156、附录 A5）。 */
export const NON_TERMINAL_WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  'pending',
  'processing',
  'waiting_dependency',
];

/** 需要"释放运行资源但保留等待原因"的状态（任务书:213、guide:91）。 */
export const RESOURCE_RELEASING_WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  'waiting_dependency',
];

export const WORK_ITEM_STATUS_LABELS: Readonly<Record<WorkItemStatus, string>> = {
  pending: '待处理',
  processing: '处理中',
  waiting_dependency: '等待依赖',
  completed: '已完成',
  failed: '失败',
  cancelled: '取消',
};

// ---------------------------------------------------------------------------
// 附录 A3 实例活动态（实例状态与工作状态分开，任务书:217）
// ---------------------------------------------------------------------------

export const INSTANCE_ACTIVITY_STATES = ['idle', 'active'] as const;
export type InstanceActivityState = (typeof INSTANCE_ACTIVITY_STATES)[number];

// ---------------------------------------------------------------------------
// 轮次状态（P7 载体：run_id + 有限租约）
// ---------------------------------------------------------------------------

export const RUN_STATUSES = ['running', 'finished', 'aborted'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * 发布被拒绝的原因（需求 7 / P7：失去所有权或任务版本已变的轮次必须拒绝发布）。
 * 合同 §九-9。
 *
 * **封闭枚举**：只增不删、不改既有成员的含义；新增一律**顺序追加到末尾**，
 * 避免已持久化 / 已写进证据的取值位移。下游（调度层 `FINISH_RUN_REJECTION_REASONS`）
 * 复用本表，不得各自复制字面量。
 */
export const PUBLICATION_REJECTION_REASONS = [
  'unknown_run', // 找不到该 run_id
  'not_run_owner', // 该轮次不属于该实例（或该实例已无此活动轮次）
  'lease_expired', // 租约已过期（Q7-a：逻辑时间，不自动续租）
  'run_not_active', // 轮次已结束 / 已中止
  'stale_task_revision', // 任务版本已变更（stale publication）
  'task_cancelled', // 任务已取消，本轮全部发布一律拒绝（R33.5 / R41.1）；也不为本轮排下一次运行
] as const;

export type PublicationRejectionReason = (typeof PUBLICATION_REJECTION_REASONS)[number];

// ---------------------------------------------------------------------------
// 阻塞 / 失败原因类别（附录 A5 blocker_reason；合同 Q2-c 能力缺失须可观测）
// ---------------------------------------------------------------------------

export const BLOCKER_KINDS = [
  'waiting_dependency', // 等待依赖结果
  'waiting_user', // 等待用户输入或确认
  'waiting_external', // 等待外部条件（正常等待，≠ 死锁）
  'capability_missing', // 无匹配能力（Q2-c：必须产生工作项，不得静默丢弃）
  'authorization_missing', // 缺权限 / 未授权
  'budget_exhausted', // 预算耗尽
  'unknown_tool_state', // 工具状态未知（任务书:519）
  'cycle_detected', // 循环依赖
  'other',
] as const;

export type BlockerKind = (typeof BLOCKER_KINDS)[number];

export const BLOCKER_KIND_LABELS: Readonly<Record<BlockerKind, string>> = {
  waiting_dependency: '等待依赖',
  waiting_user: '等待用户',
  waiting_external: '等待外部条件',
  capability_missing: '能力缺失',
  authorization_missing: '缺少授权',
  budget_exhausted: '预算耗尽',
  unknown_tool_state: '工具状态未知',
  cycle_detected: '循环依赖',
  other: '其他',
};

// ---------------------------------------------------------------------------
// 投递结果三值（验收场景规格 0.3；D02 负责"重复"分支的判定）
// ---------------------------------------------------------------------------

export const DELIVERY_RESULTS = [
  'accepted', // 已接受（已可靠持久化）
  'duplicate_not_created', // 重复 message_id，未新建业务工作（D02 判定）
  'failed', // 失败（未接受：不得报告已接受，合同 §九-1）
] as const;

export type DeliveryResult = (typeof DELIVERY_RESULTS)[number];

// ---------------------------------------------------------------------------
// 事件种类
// ---------------------------------------------------------------------------

/**
 * 待投递（outbox）调度事件种类。
 * 合同 Q6-b/Q6-d：这类事件与"收件箱写入 + 工作项变更"同事务写入，发布成功后标记已投递。
 */
export const DELIVERY_EVENT_KINDS = [
  'wakeup_queued', // 排队标记被置位（运行机会，不是工作请求）
  'run_requested', // 请求启动一个运行轮次
  'dependency_resolved', // 依赖解除产生的可运行输入（Q5-c）
  'diagnosis_requested', // 触发停滞诊断（Q9）
] as const;

export type DeliveryEventKind = (typeof DELIVERY_EVENT_KINDS)[number];

/**
 * 观测事件种类（合同 §七 Q10-a/Q10-b：内核原生发出结构化事件）。
 *
 * 计数口径与**每种事件对计数器的必填字段**见 `events.ts` 的 `summarizeKernelEvents()`——
 * 那里是唯一权威实现（v1.1 R4）。生产者（内核 / D06 记录器）必须按该表提供字段，
 * 缺字段会让汇总**抛错**而不是静默计 0。
 */
export const KERNEL_EVENT_KINDS = [
  'message_accepted',
  'message_duplicate_rejected',
  'message_rejected',
  'work_item_created',
  'work_item_status_changed',
  'task_revision_advanced',
  'task_control_state_updated',
  'inbox_message_consumed',
  'run_started',
  'run_finished',
  'publication_rejected',
  'delegation_queue_enqueued',
  /** 排队标记被清除（抢占排队项 / 无剩余可运行输入）。计算"峰值排队标记"必需（v1.1 R4）。 */
  'delegation_queue_cleared',
  'diagnosis_performed',
  'recovery_performed',
  'capability_missing_reported',
  'delivery_event_published',
  /**
   * 诊断额度已用尽的**耗尽报告**（合同 v1.3 R44.3；G03 修复批）。
   *
   * **不计入 `summarizeKernelEvents().diagnosis_count`**（该计数只认 `diagnosis_performed`），
   * 也**不参与预算投影**（`CommittedBudgetProjection` 只认 `run_started` 与
   * `diagnosis_performed`）——它是"停止放行"的如实上报，不是一次诊断。
   * `data` 至少携带 `verdict` / `used` / `limit` / `reason`。
   *
   * 与 `PUBLICATION_REJECTION_REASONS` 同纪律：**顺序追加到末尾**（避免取值位移）。
   */
  'diagnosis_budget_exhausted',
  /**
   * 产物发布（design-02 A 批，合同 v1.4 R49.1）。与 `ArtifactRecord.status` 的流转一一对应：
   * - `artifact_staged`：事务 1 内落 `staged`（此时**还没有任何文件被写**）；
   * - `artifact_published`：事务 3 内落 `published`，回执来自**对最终路径的实际回读**（I-1）；
   * - `artifact_publish_failed`：结构化失败（`detail` 非空），**绝不**冒充成功。
   *
   * **不计入** `summarizeKernelEvents()` 的 6 个计数器（那里只认既有的那几类，见 `counters.ts` 的表）。
   * 同纪律：**顺序追加到末尾**。
   */
  'artifact_staged',
  'artifact_published',
  'artifact_publish_failed',
] as const;

export type KernelEventKind = (typeof KERNEL_EVENT_KINDS)[number];

// ---------------------------------------------------------------------------
// 可运行输入来源（Q5-c：依赖解除作为新的可运行输入，不作为新消息入箱）
// ---------------------------------------------------------------------------

export const ACTIONABLE_INPUT_SOURCES = ['message', 'dependency_resolution'] as const;
export type ActionableInputSource = (typeof ACTIONABLE_INPUT_SOURCES)[number];

// ---------------------------------------------------------------------------
// 信任标签（附录 A4 trust_label；§16：群消息自称"用户已批准"不构成授权）
// ---------------------------------------------------------------------------

export const TRUST_LABELS = [
  'kernel', // 内核自身产生
  'user', // 用户前台输入
  'agent', // 群内实例
  'external', // 外部页面 / 文档 / 工具返回（视为数据，不是指令）
] as const;

export type TrustLabel = (typeof TRUST_LABELS)[number];

// ---------------------------------------------------------------------------
// revision 触发类别（合同 Q1-a：结构化 patch 是否触及硬约束 / 交付物 / 禁止事项 / 预算）
// ---------------------------------------------------------------------------

export const REVISION_TRIGGER_KINDS = [
  'hard_constraint',
  'deliverable',
  'forbidden_action',
  'budget',
] as const;

export type RevisionTrigger = (typeof REVISION_TRIGGER_KINDS)[number];

// ---------------------------------------------------------------------------
// 默认预算数值（合同 Q7-a / Q9-a：场景执行前给出，禁止失败后调大）
// ---------------------------------------------------------------------------

/** 有限租约默认时长（**逻辑时间单位**，场景可配，不自动续租）。 */
export const DEFAULT_LEASE_TTL = 1000;

/** A05 诊断预算默认上限 D=4。 */
export const DEFAULT_DIAGNOSIS_BUDGET = 4;

/** 轮次上限默认 R=6。 */
export const DEFAULT_RUN_LIMIT = 6;

/** 逻辑时间预算默认 T=10000。 */
export const DEFAULT_TIME_BUDGET = 10000;

/** 同版同阻塞指纹无新证据时的最大自动恢复次数（合同 §九-7）。 */
export const MAX_AUTO_RECOVERY_PER_FINGERPRINT = 1;

/** 逻辑时间原点（内核不得自行推进时间，Q8-a）。 */
export const LOGICAL_TIME_ORIGIN = 0;

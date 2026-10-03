/**
 * F03 conversations —— 会话列表视图模型的类型与不变量（零依赖、纯 TS、框架无关）。
 *
 * 本包只产出**可断言的列表状态与纯函数**：不渲染、不引框架、不读真实文件字节、
 * 不发网络请求、不持久化、不碰 `KernelClient`。命令形状一律只读消费
 * `contracts/mobile-v1/types.ts`，不自己另发明命令。
 *
 * 只读消费（不改动）：
 *   - `contracts/mobile-v1/types.ts`：`EventStatus`（任务状态与事件状态同词表）。
 *
 * 核心不变量（由 `tests/mobile-ui/F03/` 机器化断言）：
 *   I1 归档 ≠ 删除：归档只是列表整理，仍可被 `status='archived'|'all'` 筛到；
 *      删除直接移出集合，连 `status='all'` 也查不到；两者必须分别命名。
 *   I2 删除范围明确且不殃及他人：删除**必须**显式给出 `DeleteScope`（关联任务 / 文件 /
 *      记忆 / 外部动作的处理方式），且只移除目标会话一个；其余会话逐字段不变。
 *   I3 revision 守卫：任何写操作都要 `expectedRevision`；过期（旧）与未知（较新/非整数）
 *      的 revision 一律被拒（`stale-revision` / `unknown-revision`），不得静默覆盖本地较新状态。
 *   I4 归属唯一：一个任务只能绑定到一个会话；绑定到别处/重复绑定被拒。
 *   I5 分页越界报错：`offset > total` 抛 `page-out-of-range`，不是静默返回空页。
 */

import type { EventStatus } from '../../../../contracts/mobile-v1/types.js';

export type { EventStatus };

// ---------------------------------------------------------------------------
// 列表项
// ---------------------------------------------------------------------------

/** 会话生命周期。`archived` 仍属集合（可筛选到）；删除不在集合里（连 'all' 也查不到）。 */
export type ConversationLifecycle = 'active' | 'archived';

/** 列表筛选：默认只看 `active`（归档是列表整理，不混进主列表）。 */
export type ConversationStatusFilter = 'active' | 'archived' | 'all';

/**
 * 任务绑定：会话里每个任务及其**归属**。
 *
 * `conversationId` 是归属的唯一权威：同一 taskId 不得出现在两个会话里（I4）。
 * 任务状态复用契约事件词表 `EventStatus`，前端不另造状态。
 */
export interface TaskBinding {
  readonly taskId: string;
  readonly title: string;
  readonly status: EventStatus;
  /** 归属：该任务所属会话 id。绑定进别的会话会被拒（I4）。 */
  readonly conversationId: string;
  /** 关联文件引用（仅 id/ref，不读真实 bytes）。 */
  readonly fileRefs?: readonly string[];
  /** 关联记忆引用。 */
  readonly memoryRefs?: readonly string[];
  /** 关联外部动作引用（下单/支付等）；只列引用，不做外部动作。 */
  readonly externalActionRefs?: readonly string[];
}

export interface ConversationView {
  /** 稳定 id：重命名/归档/切换都不改。 */
  readonly id: string;
  readonly title: string;
  /** 内容片段：列表预览与「按内容搜索」的匹配来源（不是完整消息）。 */
  readonly snippet: string;
  /** 乐观锁版本：每次写入 +1；写操作必须带 expectedRevision（I3）。 */
  readonly revision: number;
  readonly lifecycle: ConversationLifecycle;
  /** 最近活跃时间（UTC ISO 8601）。空串表示调用方未提供，排序时置后。 */
  readonly lastActiveAt: string;
  /** 创建序号：确定性排序与 id 生成用，不读时钟、不读随机数。 */
  readonly seq: number;
  /** 归属本会话的任务（含状态）。 */
  readonly tasks: readonly TaskBinding[];
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

export interface ConversationsState {
  readonly conversations: readonly ConversationView[];
  /** id → 下标：O(1) 定位，避免长列表下每次全表扫描。 */
  readonly indexById: Readonly<Record<string, number>>;
  /** 当前选中（切换）的会话；未选为 null；删除选中项后置 null。 */
  readonly selectedId: string | null;
  /** 已分配的最大 seq（单调递增，删除不回退）。 */
  readonly counter: number;
}

// ---------------------------------------------------------------------------
// 查询入参
// ---------------------------------------------------------------------------

export interface ListOptions {
  /** 生命周期筛选。默认 `'active'`。 */
  readonly status?: ConversationStatusFilter;
  /** 搜索关键字（标题或内容片段，忽略大小写、首尾空白）；空串不过滤。 */
  readonly query?: string;
}

export interface PageRequest {
  /** 起始下标，必须是 >= 0 的整数；`offset > total` 抛 `page-out-of-range`。 */
  readonly offset: number;
  /** 每页条数，必须是 >= 1 的整数。 */
  readonly limit: number;
}

export interface ConversationPage {
  readonly items: readonly ConversationView[];
  readonly offset: number;
  readonly limit: number;
  /** 过滤后、排序后的总条数。 */
  readonly total: number;
  readonly hasMore: boolean;
}

/** 定位结果：给「返回原入口恢复滚动位置」用的稳定锚点。 */
export interface ConversationLocation {
  readonly conversationId: string;
  /** 在过滤+排序后序列中的下标。 */
  readonly index: number;
  /** 所在页下标（从 0 起）。 */
  readonly pageIndex: number;
  /** 该页起始 offset；翻到这一页即可复原位置。 */
  readonly offset: number;
  readonly limit: number;
}

// ---------------------------------------------------------------------------
// 删除范围
// ---------------------------------------------------------------------------

/**
 * 删除范围：删除会话前**必须**逐类声明关联对象的处理方式（design-07 行 123/212：
 * 删除会话先说明关联任务、文件、记忆和外部动作的处理范围）。
 * 缺少 scope 或 scope 缺字段 ⇒ 拒绝删除，绝不「猜一个默认范围」。
 */
export interface DeleteScope {
  readonly tasks: 'cascade' | 'retain';
  readonly files: 'cascade' | 'retain';
  readonly memory: 'cascade' | 'retain';
  readonly externalActions: 'none' | 'request-cancel' | 'keep';
}

/** 删除范围预览：给确认面板展示影响范围（不执行删除）。 */
export interface DeletePlan {
  readonly conversationId: string;
  readonly title: string;
  readonly revision: number;
  readonly taskIds: readonly string[];
  /** 仍在运行（pending/running）的任务：删除前需明确处置。 */
  readonly runningTaskIds: readonly string[];
  readonly fileRefCount: number;
  readonly memoryRefCount: number;
  readonly externalActionCount: number;
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export type ConversationErrorCode =
  | 'unknown-conversation'
  | 'duplicate-conversation'
  | 'duplicate-task-binding'
  | 'task-owner-mismatch'
  | 'missing-expected-revision'
  | 'stale-revision'
  | 'unknown-revision'
  | 'invalid-title'
  | 'invalid-activity'
  | 'invalid-lifecycle'
  | 'unsupported-operation'
  | 'invalid-page-request'
  | 'page-out-of-range'
  | 'missing-delete-scope'
  | 'delete-scope-incomplete'
  | 'invalid-scope-field';

/**
 * 视图模型的结构化错误：只带 code + 可读 message + 脱敏 details，
 * 不含密钥/请求体/本地路径。测试按 `code` 断言，避免只匹配文案。
 */
export class ConversationError extends Error {
  readonly code: ConversationErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ConversationErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ConversationError';
    this.code = code;
    this.details = details;
  }
}

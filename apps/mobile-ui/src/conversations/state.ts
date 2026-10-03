/**
 * F03 conversations —— 列表读取、筛选、搜索、排序、分页（纯函数，零依赖）。
 *
 * 排序（最近活跃）是**纯比较**，不读时钟：
 *   1) `lastActiveAt` 降序（空串表示未提供，排最后）；
 *   2) 平手时 `seq` 降序（后创建者在前）；
 *   3) 再平手按 id 升序。
 * 三级 tie-break 保证同一输入在任何环境下得到**同一顺序**，断言可复现。
 *
 * 分页越界**显式报错**（I5）：`offset > total` 抛 `page-out-of-range`，
 * 而不是返回空页——静默空页会把「翻到底了」和「翻过头了」混为一谈。
 */

import {
  ConversationError,
  type ConversationLocation,
  type ConversationPage,
  type ConversationStatusFilter,
  type ConversationView,
  type ConversationsState,
  type DeletePlan,
  type ListOptions,
  type PageRequest,
  type TaskBinding,
} from './types.js';

export const DEFAULT_STATUS_FILTER: ConversationStatusFilter = 'active';

/** 创建空列表状态。 */
export function createConversationsState(): ConversationsState {
  return { conversations: [], indexById: {}, selectedId: null, counter: 0 };
}

/** 按 id 取会话；不存在（含已删除）返回 null。 */
export function getConversation(state: ConversationsState, id: string): ConversationView | null {
  const index = state.indexById[id];
  if (index === undefined) return null;
  return state.conversations[index] ?? null;
}

// ---------------------------------------------------------------------------
// 排序
// ---------------------------------------------------------------------------

/** 最近活跃降序比较（确定性三级 tie-break）。 */
export function compareByRecentActivity(a: ConversationView, b: ConversationView): number {
  if (a.lastActiveAt !== b.lastActiveAt) {
    if (a.lastActiveAt === '') return 1;
    if (b.lastActiveAt === '') return -1;
    return a.lastActiveAt < b.lastActiveAt ? 1 : -1;
  }
  if (a.seq !== b.seq) return b.seq - a.seq;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

// ---------------------------------------------------------------------------
// 筛选 / 搜索 / 排序
// ---------------------------------------------------------------------------

function matchesStatus(view: ConversationView, status: ConversationStatusFilter): boolean {
  if (status === 'all') return true;
  return view.lifecycle === status;
}

function matchesQuery(view: ConversationView, query: string): boolean {
  if (query === '') return true;
  const needle = query.toLowerCase();
  return view.title.toLowerCase().includes(needle) || view.snippet.toLowerCase().includes(needle);
}

/**
 * 列出会话（过滤 + 排序）。删除的会话不在集合里，任何 status 都取不到；
 * 归档的会话在 `status='archived'|'all'` 下仍在（I1）。
 */
export function listConversations(
  state: ConversationsState,
  options: ListOptions = {},
): readonly ConversationView[] {
  const status = options.status ?? DEFAULT_STATUS_FILTER;
  const rawQuery = options.query ?? '';
  const query = rawQuery.trim();
  const rows = state.conversations.filter(
    (view) => matchesStatus(view, status) && matchesQuery(view, query),
  );
  return [...rows].sort(compareByRecentActivity);
}

/** 搜索：按标题或内容片段（忽略大小写）。等价于 `listConversations` 带 query。 */
export function searchConversations(
  state: ConversationsState,
  query: string,
  options: Omit<ListOptions, 'query'> = {},
): readonly ConversationView[] {
  return listConversations(state, { ...options, query });
}

// ---------------------------------------------------------------------------
// 分页
// ---------------------------------------------------------------------------

function assertPageRequest(request: PageRequest): void {
  const { offset, limit } = request;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ConversationError('invalid-page-request', 'offset 必须是 >= 0 的整数', { offset });
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ConversationError('invalid-page-request', 'limit 必须是 >= 1 的整数', { limit });
  }
}

/**
 * 分页。`offset === total` 是合法边界（返回空页）；`offset > total` 抛错（I5）。
 */
export function pageConversations(
  state: ConversationsState,
  request: PageRequest,
  options: ListOptions = {},
): ConversationPage {
  assertPageRequest(request);
  const rows = listConversations(state, options);
  const total = rows.length;
  if (request.offset > total) {
    throw new ConversationError('page-out-of-range', '分页越界：offset 超过总条数', {
      offset: request.offset,
      limit: request.limit,
      total,
    });
  }
  const items = rows.slice(request.offset, request.offset + request.limit);
  return {
    items,
    offset: request.offset,
    limit: request.limit,
    total,
    hasMore: request.offset + request.limit < total,
  };
}

/**
 * 定位某会话所在页：给「从对话返回列表时恢复滚动位置」用的稳定锚点。
 * 不在当前过滤/搜索范围内（或已删除）返回 null——不编造位置。
 */
export function locateConversation(
  state: ConversationsState,
  conversationId: string,
  request: PageRequest,
  options: ListOptions = {},
): ConversationLocation | null {
  assertPageRequest(request);
  const rows = listConversations(state, options);
  const index = rows.findIndex((view) => view.id === conversationId);
  if (index < 0) return null;
  const pageIndex = Math.floor(index / request.limit);
  return {
    conversationId,
    index,
    pageIndex,
    offset: pageIndex * request.limit,
    limit: request.limit,
  };
}

// ---------------------------------------------------------------------------
// 任务归属
// ---------------------------------------------------------------------------

/** 某会话绑定的任务。 */
export function tasksOf(state: ConversationsState, conversationId: string): readonly TaskBinding[] {
  const view = getConversation(state, conversationId);
  return view === null ? [] : view.tasks;
}

/** 任务的归属：返回绑定它的任务对象（含 conversationId）；未绑定返回 null。 */
export function taskOwnership(state: ConversationsState, taskId: string): TaskBinding | null {
  for (const view of state.conversations) {
    for (const task of view.tasks) {
      if (task.taskId === taskId) return task;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 删除范围预览
// ---------------------------------------------------------------------------

/**
 * 计算删除范围（只读、不删除）。删除会话前用它展示关联任务/文件/记忆/外部动作，
 * 不把「删除会话」解释成外部撤销（design-07 行 123、212）。
 */
export function planDelete(state: ConversationsState, conversationId: string): DeletePlan {
  const view = getConversation(state, conversationId);
  if (view === null) {
    throw new ConversationError('unknown-conversation', '会话不存在或已删除', { conversationId });
  }
  const fileRefs = new Set<string>();
  const memoryRefs = new Set<string>();
  const externalRefs = new Set<string>();
  const running: string[] = [];
  for (const task of view.tasks) {
    for (const ref of task.fileRefs ?? []) fileRefs.add(ref);
    for (const ref of task.memoryRefs ?? []) memoryRefs.add(ref);
    for (const ref of task.externalActionRefs ?? []) externalRefs.add(ref);
    if (task.status === 'pending' || task.status === 'running') running.push(task.taskId);
  }
  return {
    conversationId: view.id,
    title: view.title,
    revision: view.revision,
    taskIds: view.tasks.map((task) => task.taskId),
    runningTaskIds: running,
    fileRefCount: fileRefs.size,
    memoryRefCount: memoryRefs.size,
    externalActionCount: externalRefs.size,
  };
}

/**
 * F03 测试夹具：构建一个已知的会话列表状态（显式 id、显式时间，保证可复现）。
 *
 * 时间戳固定为字面量，不读时钟——同一夹具在任何机器上得到同一顺序。
 */

import {
  archiveConversation,
  bindTask,
  createConversation,
  createConversationsState,
  getConversation,
  type ConversationsState,
  type DeleteScope,
} from '../../../apps/mobile-ui/src/conversations/index.js';

export const IDS = {
  weekly: 'conv-weekly',
  expense: 'conv-expense',
  pitch: 'conv-pitch',
  archived: 'conv-archived',
} as const;

/** 删除时的完整范围（测试默认用它拼合法输入）。 */
export function fullScope(): DeleteScope {
  return { tasks: 'retain', files: 'retain', memory: 'retain', externalActions: 'keep' };
}

/**
 * 四个会话：
 *   expense  2026-10-03T11:30Z  active   最近活跃最先
 *   weekly   2026-10-03T09:00Z  active   绑定一个 running 任务 + 文件/记忆/外部引用
 *   pitch    2026-10-02T20:00Z  active
 *   archived 2026-10-01T08:00Z  archived（默认不出现在主列表）
 */
export function seed(): ConversationsState {
  let state = createConversationsState();
  state = createConversation(state, {
    id: IDS.weekly,
    title: '周报整理',
    snippet: '把这份周报改成一页',
    lastActiveAt: '2026-10-03T09:00:00Z',
    select: false,
  });
  state = createConversation(state, {
    id: IDS.expense,
    title: 'Excel 报销',
    snippet: '差旅报销汇总表格',
    lastActiveAt: '2026-10-03T11:30:00Z',
    select: false,
  });
  state = createConversation(state, {
    id: IDS.pitch,
    title: 'PPT 路演',
    snippet: '融资路演大纲',
    lastActiveAt: '2026-10-02T20:00:00Z',
    select: false,
  });
  state = createConversation(state, {
    id: IDS.archived,
    title: '归档旧会话',
    snippet: '上季度回顾',
    lastActiveAt: '2026-10-01T08:00:00Z',
    select: false,
  });

  const weekly = getConversation(state, IDS.weekly);
  if (weekly === null) throw new Error('夹具构建失败：weekly 缺失');
  state = bindTask(state, {
    conversationId: IDS.weekly,
    expectedRevision: weekly.revision,
    task: {
      taskId: 'task-wf-001',
      title: '把周报改成一页',
      status: 'running',
      fileRefs: ['file-report', 'file-logo'],
      memoryRefs: ['mem-preference'],
      externalActionRefs: ['act-send'],
    },
  });

  const archived = getConversation(state, IDS.archived);
  if (archived === null) throw new Error('夹具构建失败：archived 缺失');
  state = archiveConversation(state, {
    conversationId: IDS.archived,
    expectedRevision: archived.revision,
  });

  return state;
}

/** 依次取某会话当前的 revision（负例用它派生旧/新值，避免硬编码漂移）。 */
export function revisionOf(state: ConversationsState, id: string): number {
  const view = getConversation(state, id);
  if (view === null) throw new Error(`夹具读取失败：${id} 缺失`);
  return view.revision;
}

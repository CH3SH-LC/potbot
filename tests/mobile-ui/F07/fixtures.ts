/**
 * F07 测试夹具：构造内核条目视图与列表行。
 *
 * 只放**普通数据**——无密钥、无真实手机号 / 地址、无电脑绝对路径。标识与正文都是合成值。
 */

import {
  toMemoryRow,
  type MemoryEntryView,
  type MemoryRow,
} from '../../../apps/mobile-ui/src/memory/index.js';

export const OWNER = 'owner-1';
export const OTHER_OWNER = 'owner-2';

/** 合成条目（默认一条 active / confirmed 的用户偏好）。 */
export function entry(overrides: Partial<MemoryEntryView> = {}): MemoryEntryView {
  const base: MemoryEntryView = {
    memoryId: 'mem-1',
    ownerId: OWNER,
    kind: 'preference',
    scope: { kind: 'user', taskId: null, templateId: null },
    source: { kind: 'user_statement', detail: '用户在对话里说的一句话' },
    confirmation: 'confirmed',
    status: 'active',
    version: 3,
    createdAt: 10,
    updatedAt: 20,
    body: '偏好喝美式',
    preferenceKey: 'coffee',
  };
  return { ...base, ...overrides };
}

export function row(overrides: Partial<MemoryEntryView> = {}): MemoryRow {
  return toMemoryRow(entry(overrides));
}

/** 一条任务事实（用于范围筛选 / 遗忘范围测试）。 */
export function taskFact(memoryId: string, taskId: string, body = '任务事实'): MemoryEntryView {
  return entry({
    memoryId,
    kind: 'task_fact',
    scope: { kind: 'task', taskId, templateId: null },
    taskId,
    source: { kind: 'tool_result', detail: `工具 ${taskId} 返回` },
    body,
    factKey: 'k',
  });
}

/** 一条模板经验。 */
export function templateExperience(memoryId: string, templateId: string): MemoryEntryView {
  return entry({
    memoryId,
    kind: 'template_experience',
    scope: { kind: 'template', taskId: null, templateId },
    templateId,
    source: { kind: 'inference', detail: '从历史任务归纳' },
    body: '先建目录再写文件更稳',
    appliesToVersion: '1.0.0',
  });
}

/** 一条会话消息。 */
export function sessionMessage(memoryId: string, conversationId = 'conv-1'): MemoryEntryView {
  return entry({
    memoryId,
    kind: 'session_message',
    scope: { kind: 'user', taskId: null, templateId: null },
    conversationId,
    source: { kind: 'external', detail: '会话内容' },
    body: '你好',
  });
}

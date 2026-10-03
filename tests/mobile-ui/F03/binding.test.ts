/**
 * F03 验收：归属与任务绑定（I4）。
 *
 *   - 一个 taskId 只能绑定到一个会话；重复绑定 / 绑到别处 ⇒ `duplicate-task-binding`；
 *   - 任务声明的 `conversationId` 与绑定目标不一致 ⇒ `task-owner-mismatch`；
 *   - `taskOwnership` 能回答「这个任务属于哪个会话」；
 *   - 任务状态必须取自**真实契约词表**（读 contracts/mobile-v1/schemas/event.schema.json
 *     的 `$defs.status.enum`），不是实现自己发明的取值。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ConversationError,
  bindTask,
  getConversation,
  switchConversation,
  taskOwnership,
  tasksOf,
} from '../../../apps/mobile-ui/src/conversations/index.js';
import { IDS, revisionOf, seed } from './fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const EVENT_SCHEMA = join(REPO_ROOT, 'contracts', 'mobile-v1', 'schemas', 'event.schema.json');

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConversationError) return error.code;
    throw error;
  }
  throw new Error('预期抛 ConversationError，但没有抛');
}

describe('F03 / 任务绑定与归属', () => {
  it('绑定成功：归属写入会话 id，taskOwnership 可反查', () => {
    const state = seed();
    const ownership = taskOwnership(state, 'task-wf-001');
    expect(ownership?.conversationId).toBe(IDS.weekly);
    expect(tasksOf(state, IDS.weekly).map((t) => t.taskId)).toEqual(['task-wf-001']);
  });

  it('未绑定的任务 ⇒ null；无任务的会话 ⇒ 空数组', () => {
    const state = seed();
    expect(taskOwnership(state, 'task-nope')).toBeNull();
    expect(tasksOf(state, IDS.pitch)).toEqual([]);
  });

  it('重复绑定同一 taskId（同会话）⇒ duplicate-task-binding', () => {
    const state = seed();
    expect(
      codeOf(() =>
        bindTask(state, {
          conversationId: IDS.weekly,
          expectedRevision: revisionOf(state, IDS.weekly),
          task: { taskId: 'task-wf-001', title: '重复', status: 'pending' },
        }),
      ),
    ).toBe('duplicate-task-binding');
  });

  it('把已属别处的 taskId 绑到另一会话 ⇒ duplicate-task-binding', () => {
    const state = seed();
    expect(
      codeOf(() =>
        bindTask(state, {
          conversationId: IDS.pitch,
          expectedRevision: revisionOf(state, IDS.pitch),
          task: { taskId: 'task-wf-001', title: '抢归属', status: 'pending' },
        }),
      ),
    ).toBe('duplicate-task-binding');
  });

  it('任务声明归属与会话不一致 ⇒ task-owner-mismatch', () => {
    const state = seed();
    expect(
      codeOf(() =>
        bindTask(state, {
          conversationId: IDS.pitch,
          expectedRevision: revisionOf(state, IDS.pitch),
          task: { taskId: 'task-new', title: '错归属', status: 'pending', conversationId: IDS.weekly },
        }),
      ),
    ).toBe('task-owner-mismatch');
  });

  it('绑定需要 revision 守卫：缺 expectedRevision ⇒ missing-expected-revision', () => {
    const state = seed();
    const input = {
      conversationId: IDS.pitch,
      task: { taskId: 'task-new', title: 'x', status: 'pending' },
    } as unknown as Parameters<typeof bindTask>[1];
    expect(codeOf(() => bindTask(state, input))).toBe('missing-expected-revision');
  });

  it('绑定成功推进 revision，且不改变其他会话', () => {
    const state = seed();
    const rev = revisionOf(state, IDS.pitch);
    const weeklyBefore = getConversation(state, IDS.weekly);
    const after = bindTask(state, {
      conversationId: IDS.pitch,
      expectedRevision: rev,
      task: { taskId: 'task-new', title: '新任务', status: 'running' },
    });
    expect(getConversation(after, IDS.pitch)?.revision).toBe(rev + 1);
    expect(getConversation(after, IDS.weekly)).toBe(weeklyBefore);
  });

  it('切换会话不改变其他会话正在运行的任务状态', () => {
    const state = seed();
    const switched = switchConversation(state, IDS.pitch);
    const running = tasksOf(switched, IDS.weekly).filter((t) => t.status === 'running');
    expect(running.map((t) => t.taskId)).toEqual(['task-wf-001']);
  });
});

describe('F03 / 任务状态取自真实契约词表', () => {
  it('所有绑定状态都在 event.schema.json 的 $defs.status.enum 中', () => {
    const schema = JSON.parse(readFileSync(EVENT_SCHEMA, 'utf8')) as {
      $defs?: { status?: { enum?: string[] } };
    };
    const allowed = schema.$defs?.status?.enum;
    expect(Array.isArray(allowed)).toBe(true);
    const state = seed();
    const statuses: string[] = [];
    for (const view of state.conversations) {
      for (const task of view.tasks) statuses.push(task.status);
    }
    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) {
      expect(allowed).toContain(status);
    }
  });
});

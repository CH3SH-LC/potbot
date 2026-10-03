/**
 * F04 验收：事件驱动与 revision 守卫、拒绝内部 Agent 群聊。
 *
 * 核心（对应 I1、I2）：
 *   - 任务态**只**经 `applyTaskEvent` 改变；过期/重复/乱序事件被 `stale-revision` 拒绝且**不覆盖**
 *     本地较新态；缺口事件被 `unknown-revision` 拒绝（验收口径「过期 revision 更新」）。
 *   - 内部 Agent 对话/思维链/工具流水类别一律 `internal-chat-rejected`，且**不产生活动条目**，
 *     状态对象**没有** `messages` 字段（群组不是内部 Agent 群聊）。
 *
 * 定向运行：`npx vitest run tests/mobile-ui/F04/events.test.ts --reporter=basic`
 */

import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_ACTIVITY_KINDS,
  GroupError,
  applyTaskEvent,
  isRenderableActivityKind,
  type TaskEvent,
} from '../../../apps/mobile-ui/src/groups/index.js';
import { IDS, makeEvent, seed, taskOf } from './fixtures.js';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof GroupError) return error.code;
    throw error;
  }
  throw new Error('预期抛 GroupError，但没有抛');
}

const AT = '2026-10-03T10:10:00Z';

describe('F04 / 事件驱动：合法事件推进 revision 并留下活动', () => {
  it('wait 事件进入等资料态并追加活动条目', () => {
    const state = seed();
    const before = taskOf(state, IDS.weeklyTask);
    expect(before.revision).toBe(1);

    const next = applyTaskEvent(
      state,
      makeEvent(
        { taskId: IDS.weeklyTask, kind: 'wait', at: AT, to: 'awaiting-input', waitReason: '等待补充资料' },
        { revision: 2, seq: 5 },
      ),
    );

    const after = taskOf(next, IDS.weeklyTask);
    expect(after.state).toBe('awaiting-input');
    expect(after.waitReason).toBe('等待补充资料');
    expect(after.revision).toBe(2);
    expect(after.lastEventSeq).toBe(5);
    expect(after.activity).toHaveLength(1);
    expect(after.activity[0]?.kind).toBe('wait');
    // 其它任务/群组对象引用不变（不误伤）。
    expect(taskOf(next, IDS.tripTask)).toBe(taskOf(state, IDS.tripTask));
  });
});

describe('F04 / revision 守卫：过期事件被拒且不覆盖较新态', () => {
  it('事件 revision ≤ 当前 ⇒ stale-revision，本地较新态保持', () => {
    const state = seed();
    const advanced = applyTaskEvent(
      state,
      makeEvent(
        { taskId: IDS.weeklyTask, kind: 'wait', at: AT, to: 'awaiting-input', waitReason: '等待补充资料' },
        { revision: 2, seq: 5 },
      ),
    );

    const stale = codeOf(() =>
      applyTaskEvent(
        advanced,
        makeEvent(
          { taskId: IDS.weeklyTask, kind: 'wait', at: AT, to: 'awaiting-authorization', waitReason: '过期原因' },
          { revision: 2, seq: 4 },
        ),
      ),
    );
    expect(stale).toBe('stale-revision');

    // 本地状态完全没有被过期事件覆盖。
    const after = taskOf(advanced, IDS.weeklyTask);
    expect(after.revision).toBe(2);
    expect(after.state).toBe('awaiting-input');
    expect(after.waitReason).toBe('等待补充资料');
    expect(after.activity).toHaveLength(1);
  });

  it('缺口 revision ⇒ unknown-revision（需要重同步）', () => {
    const state = seed();
    expect(
      codeOf(() =>
        applyTaskEvent(
          state,
          makeEvent(
            { taskId: IDS.weeklyTask, kind: 'wait', at: AT, to: 'awaiting-input', waitReason: 'x' },
            { revision: 4, seq: 9 },
          ),
        ),
      ),
    ).toBe('unknown-revision');
    expect(taskOf(state, IDS.weeklyTask).revision).toBe(1);
  });

  it('revision 非整数 ⇒ missing-revision', () => {
    const state = seed();
    expect(
      codeOf(() =>
        applyTaskEvent(
          state,
          makeEvent(
            { taskId: IDS.weeklyTask, kind: 'wait', at: AT, to: 'awaiting-input', waitReason: 'x' },
            { revision: 1.5 },
          ),
        ),
      ),
    ).toBe('missing-revision');
  });

  it('未知任务 ⇒ unknown-task', () => {
    const state = seed();
    expect(
      codeOf(() =>
        applyTaskEvent(
          state,
          makeEvent({ taskId: 'task-ghost', kind: 'state', at: AT, to: 'processing' }, { revision: 2 }),
        ),
      ),
    ).toBe('unknown-task');
  });

  it('非法时间戳 ⇒ invalid-timestamp', () => {
    const state = seed();
    expect(
      codeOf(() =>
        applyTaskEvent(
          state,
          makeEvent(
            { taskId: IDS.weeklyTask, kind: 'wait', at: '2026-10-03', to: 'awaiting-input', waitReason: 'x' },
            { revision: 2 },
          ),
        ),
      ),
    ).toBe('invalid-timestamp');
  });
});

describe('F04 / 群组不是内部 Agent 群聊', () => {
  it('禁止类别清单全部被机器化锁定为不可渲染', () => {
    for (const kind of FORBIDDEN_ACTIVITY_KINDS) {
      expect(isRenderableActivityKind(kind)).toBe(false);
    }
  });

  it('内部对话类别事件被拒，不产生状态或活动', () => {
    const state = seed();
    for (const kind of ['agent-message', 'agent-turn', 'internal-chat', 'reasoning', 'tool-trace', 'prompt']) {
      expect(
        codeOf(() =>
          applyTaskEvent(
            state,
            makeEvent(
              { taskId: IDS.weeklyTask, kind, at: AT, text: '内部思维链不应出现' } as never,
              { revision: 2 },
            ),
          ),
        ),
      ).toBe('internal-chat-rejected');
    }
    const task = taskOf(state, IDS.weeklyTask);
    expect(task.activity).toHaveLength(0);
    expect(task.revision).toBe(1);
  });

  it('任务/群组视图没有 messages 字段', () => {
    const state = seed();
    const task = taskOf(state, IDS.weeklyTask) as unknown as Record<string, unknown>;
    expect('messages' in task).toBe(false);
    const group = state.groups[0] as unknown as Record<string, unknown>;
    expect('messages' in group).toBe(false);
  });
});

describe('F04 / 事件对象形状', () => {
  it('构造的事件满足契约必需字段', () => {
    const event: TaskEvent = makeEvent({ taskId: IDS.weeklyTask, kind: 'state', at: AT, to: 'processing' });
    expect(event.eventId).toBeTruthy();
    expect(Number.isInteger(event.seq)).toBe(true);
    expect(event.commandId).toBeTruthy();
    expect(Number.isInteger(event.revision)).toBe(true);
    expect(typeof event.status).toBe('string');
    expect(event.metadata.taskId).toBe(IDS.weeklyTask);
  });
});

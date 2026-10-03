/**
 * F04 验收：`KernelClient` 事件流 → `applyTaskEvent` 的适配层（批 / 乱序 / 缺口）。
 *
 * 覆盖单元 F-I08 的集成要求：内核事件流不保证「恰好当前 + 1」，而 reducer 强制要求它。
 * 适配层必须**在进 reducer 之前**把批次拆开、按 revision 连续受理；缺口隔离并记重同步，
 * 迟到事件补齐后续上更高 revision；过期/重复记为 replay；reducer 拒收记为 rejected。
 *
 * 关键鉴别性（discriminator）：直接给 reducer 喂缺口 revision 会抛 `unknown-revision`——
 * 这正是适配层存在的理由，测试同时断言「裸喂会炸 / 经适配层不会炸」。
 *
 * 定向运行：`npx vitest run tests/mobile-ui/F04/kernel-adapter.test.ts --reporter=basic`
 */

import { describe, expect, it } from 'vitest';

import {
  GroupError,
  MAX_HELD_PER_TASK,
  applyTaskEvent,
  bindTaskEventStream,
  createGroupsStream,
  reconcileTaskEvents,
  selectTaskEvents,
  taskBucket,
  type EventSubscription,
  type ReconcileCode,
  type ReconcileResult,
  type TaskEvent,
  type TaskEventSource,
} from '../../../apps/mobile-ui/src/groups/index.js';
import { IDS, makeEvent, seed, taskOf } from './fixtures.js';

const AT = '2026-10-03T10:10:00Z';
const AT2 = '2026-10-03T10:11:00Z';

function codes(result: ReconcileResult): ReconcileCode[] {
  return result.outcomes.map((outcome) => outcome.code);
}

function countCode(result: ReconcileResult, code: ReconcileCode): number {
  return result.outcomes.filter((outcome) => outcome.code === code).length;
}

/** 每周任务的合法推进：processing → awaiting-authorization → processing。 */
function weeklyToAuthorization(revision: number): TaskEvent {
  return makeEvent(
    { taskId: IDS.weeklyTask, kind: 'state', at: AT, to: 'awaiting-authorization' },
    { revision, seq: revision * 10 },
  );
}
function weeklyToProcessing(revision: number): TaskEvent {
  return makeEvent(
    { taskId: IDS.weeklyTask, kind: 'state', at: AT2, to: 'processing' },
    { revision, seq: revision * 10 },
  );
}

describe('F04 / 事件流适配：单条与批次连续受理', () => {
  it('单条连续事件被受理并推进 revision', () => {
    const stream = createGroupsStream(seed());
    const result = reconcileTaskEvents(stream, weeklyToAuthorization(2));

    expect(result.changed).toBe(true);
    expect(codes(result)).toEqual(['applied']);
    expect(result.appliedTaskIds).toEqual([IDS.weeklyTask]);
    expect(taskOf(result.stream.state, IDS.weeklyTask).revision).toBe(2);
    expect(taskOf(result.stream.state, IDS.weeklyTask).state).toBe('awaiting-authorization');
    // 另一任务未被误伤。
    expect(taskOf(result.stream.state, IDS.tripTask)).toBe(taskOf(stream.state, IDS.tripTask));
  });

  it('乱序批次被拆开并按 revision 连续受理（不是按到达顺序）', () => {
    const stream = createGroupsStream(seed());
    // 到达顺序：先 rev3（依赖 rev2），再 rev2。若按到达顺序喂，rev3 会因当前仍是
    // processing 而非法（processing → processing 不是合法迁移）被拒。
    const result = reconcileTaskEvents(stream, [weeklyToProcessing(3), weeklyToAuthorization(2)]);

    expect(codes(result)).toEqual(['applied', 'applied']);
    const task = taskOf(result.stream.state, IDS.weeklyTask);
    expect(task.revision).toBe(3);
    expect(task.state).toBe('processing');
  });

  it('一次回调批量投递的连续事件全部受理', () => {
    const stream = createGroupsStream(seed());
    const result = reconcileTaskEvents(stream, [weeklyToAuthorization(2), weeklyToProcessing(3)]);

    expect(codes(result)).toEqual(['applied', 'applied']);
    expect(taskOf(result.stream.state, IDS.weeklyTask).revision).toBe(3);
  });

  it('同一批次里多个任务各自独立推进', () => {
    const stream = createGroupsStream(seed());
    const trip = makeEvent(
      { taskId: IDS.tripTask, kind: 'state', at: AT, to: 'processing' },
      { revision: 2, seq: 20 },
    );
    const result = reconcileTaskEvents(stream, [weeklyToAuthorization(2), trip]);

    expect(result.changed).toBe(true);
    expect([...result.appliedTaskIds].sort()).toEqual([IDS.tripTask, IDS.weeklyTask].sort());
    expect(taskOf(result.stream.state, IDS.weeklyTask).revision).toBe(2);
    expect(taskOf(result.stream.state, IDS.tripTask).revision).toBe(2);
  });
});

describe('F04 / 事件流适配：缺口隔离与迟到补齐', () => {
  it('缺口事件不进 reducer：裸喂会抛 unknown-revision，经适配层则隔离为 gap', () => {
    const state = seed();
    // 鉴别性：直接喂缺口会炸——这就是适配层必须存在的原因。
    let thrown: string | null = null;
    try {
      applyTaskEvent(state, weeklyToAuthorization(3));
    } catch (error) {
      thrown = error instanceof GroupError ? error.code : 'NOT_GROUP_ERROR';
    }
    expect(thrown).toBe('unknown-revision');

    // 经适配层：不炸，缺口隔离，状态不动，要求重同步。
    const result = reconcileTaskEvents(createGroupsStream(state), weeklyToAuthorization(3));
    expect(codes(result)).toEqual(['gap']);
    expect(result.changed).toBe(false);
    expect(result.needsResync).toEqual([IDS.weeklyTask]);
    expect(taskOf(result.stream.state, IDS.weeklyTask).revision).toBe(1);
    expect(result.stream.held[IDS.weeklyTask]).toHaveLength(1);
  });

  it('缺口不被后续更高 revision 事件打断（整批仍可处理其它任务）', () => {
    const stream = createGroupsStream(seed());
    const trip = makeEvent(
      { taskId: IDS.tripTask, kind: 'state', at: AT, to: 'processing' },
      { revision: 2, seq: 20 },
    );
    // weekly 有缺口 rev3，trip 是连续 rev2：trip 必须照常推进，不被 weekly 的缺口拖垮。
    const result = reconcileTaskEvents(stream, [weeklyToAuthorization(3), trip]);

    expect(taskOf(result.stream.state, IDS.tripTask).revision).toBe(2);
    expect(taskOf(result.stream.state, IDS.weeklyTask).revision).toBe(1);
    expect(result.needsResync).toEqual([IDS.weeklyTask]);
  });

  it('迟到事件补齐缺口后，扣留的更高 revision 自动续上', () => {
    // 第一轮：收到 rev3（缺口），被扣留。
    const first = reconcileTaskEvents(createGroupsStream(seed()), weeklyToProcessing(3));
    expect(codes(first)).toEqual(['gap']);
    expect(first.stream.held[IDS.weeklyTask]).toHaveLength(1);

    // 第二轮：迟到的 rev2 到达——先受理 rev2，再把扣留的 rev3 续上。
    const second = reconcileTaskEvents(first.stream, weeklyToAuthorization(2));
    expect(codes(second)).toEqual(['applied', 'applied']);
    const task = taskOf(second.stream.state, IDS.weeklyTask);
    expect(task.revision).toBe(3);
    expect(task.state).toBe('processing');
    expect(second.needsResync).toEqual([]);
    expect(second.stream.held[IDS.weeklyTask]).toBeUndefined();
  });
});

describe('F04 / 事件流适配：过期、未知、拒收、非任务事件', () => {
  it('过期/重复 revision 记为 replay 且状态引用不变', () => {
    const applied = reconcileTaskEvents(createGroupsStream(seed()), weeklyToAuthorization(2));
    const replay = reconcileTaskEvents(applied.stream, weeklyToAuthorization(2));

    expect(codes(replay)).toEqual(['replay']);
    expect(replay.changed).toBe(false);
    // 引用稳定：没有任何新对象被写回。
    expect(replay.stream.state).toBe(applied.stream.state);
  });

  it('未知任务事件记为 unknown-task，不改变任何任务', () => {
    const stream = createGroupsStream(seed());
    const ghost = makeEvent({ taskId: 'task-ghost', kind: 'state', at: AT, to: 'processing' }, { revision: 2 });
    const result = reconcileTaskEvents(stream, ghost);

    expect(codes(result)).toEqual(['unknown-task']);
    expect(result.stream.state).toBe(stream.state);
  });

  it('非任务事件（缺 taskId）记为 not-task-event 并忽略', () => {
    const stream = createGroupsStream(seed());
    const foreign = {
      eventId: 'evt-foreign',
      seq: 1,
      commandId: 'cmd-x',
      revision: 2,
      status: 'running',
      metadata: { at: AT, kind: 'state' },
    } as unknown as TaskEvent;
    const result = reconcileTaskEvents(stream, foreign);

    expect(codes(result)).toEqual(['not-task-event']);
    expect(result.stream.state).toBe(stream.state);
  });

  it('reducer 自身拒收（内部对话类别）记为 rejected，且不产生状态或活动', () => {
    const stream = createGroupsStream(seed());
    const internal = makeEvent(
      { taskId: IDS.weeklyTask, kind: 'agent-message', at: AT, text: '内部思维链' } as never,
      { revision: 2 },
    );
    const result = reconcileTaskEvents(stream, internal);

    const outcome = result.outcomes[0];
    expect(outcome?.code).toBe('rejected');
    expect(outcome?.errorCode).toBe('internal-chat-rejected');
    const task = taskOf(result.stream.state, IDS.weeklyTask);
    expect(task.revision).toBe(1);
    expect(task.activity).toHaveLength(0);
    // 拒收事件不应被扣留（无缺口）。
    expect(result.stream.held[IDS.weeklyTask]).toBeUndefined();
  });

  it('非法迁移记为 rejected（带 illegal-transition）且不推进 revision', () => {
    const stream = createGroupsStream(seed());
    const illegal = makeEvent(
      { taskId: IDS.weeklyTask, kind: 'state', at: AT, to: 'cancelled' },
      { revision: 2 },
    );
    const result = reconcileTaskEvents(stream, illegal);

    expect(result.outcomes[0]?.code).toBe('rejected');
    expect(result.outcomes[0]?.errorCode).toBe('illegal-transition');
    expect(taskOf(result.stream.state, IDS.weeklyTask).revision).toBe(1);
  });
});

describe('F04 / 事件流适配：扣留缓冲有界', () => {
  it('超出 MAX_HELD_PER_TASK 的缺口事件记为 buffer-overflow，不无限增长', () => {
    const stream = createGroupsStream(seed());
    const events: TaskEvent[] = [];
    for (let i = 0; i <= MAX_HELD_PER_TASK; i += 1) {
      const at = `2026-10-03T10:${String(i).padStart(2, '0')}:00Z`;
      events.push(
        makeEvent(
          { taskId: IDS.weeklyTask, kind: 'wait', at, to: 'awaiting-input', waitReason: `r${i}` },
          { revision: 3 + i, seq: 100 + i },
        ),
      );
    }

    const result = reconcileTaskEvents(stream, events);
    expect(countCode(result, 'gap')).toBe(MAX_HELD_PER_TASK);
    expect(countCode(result, 'buffer-overflow')).toBe(1);
    expect(result.stream.held[IDS.weeklyTask]).toHaveLength(MAX_HELD_PER_TASK);
    expect(result.needsResync).toEqual([IDS.weeklyTask]);
  });
});

describe('F04 / 事件流适配：订阅绑定', () => {
  it('bindTaskEventStream 订阅、归约、回调与 unsubscribe', () => {
    let kicked = false;
    let listener: ((event: TaskEvent) => void) | null = null;
    const subscription: EventSubscription = {
      unsubscribe() {
        kicked = true;
      },
    };
    const source: TaskEventSource = {
      subscribe(next) {
        listener = next;
        return subscription;
      },
    };

    const seen: ReconcileCode[][] = [];
    const binding = bindTaskEventStream(source, seed(), {
      onChange: (result) => seen.push(codes(result)),
    });

    expect(listener).not.toBeNull();
    const emit = listener as unknown as (event: TaskEvent) => void;
    emit(weeklyToAuthorization(2));
    emit(weeklyToProcessing(3));

    expect(binding.eventCount).toBe(2);
    expect(seen).toEqual([['applied'], ['applied']]);
    expect(taskOf(binding.stream.state, IDS.weeklyTask).revision).toBe(3);
    expect(binding.lastResult?.changed).toBe(true);
    // 桶随状态推进会变化，证明绑定驱动了真实视图。
    expect(taskBucket(taskOf(binding.stream.state, IDS.weeklyTask))).toBe('in-progress');

    binding.unsubscribe();
    expect(kicked).toBe(true);
  });
});

describe('F04 / 事件流适配：确定性与预筛', () => {
  it('同一输入两次归约得到逐字段相同的结果', () => {
    const batch = [weeklyToProcessing(3), weeklyToAuthorization(2)];
    const a = reconcileTaskEvents(createGroupsStream(seed()), batch);
    const b = reconcileTaskEvents(createGroupsStream(seed()), batch);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('selectTaskEvents 只保留带任务语义的事件', () => {
    const task = weeklyToAuthorization(2);
    const foreign = { eventId: 'e', seq: 1, commandId: 'c', revision: 1, status: 'running', metadata: {} } as never;
    expect(selectTaskEvents([task, foreign])).toEqual([task]);
  });
});

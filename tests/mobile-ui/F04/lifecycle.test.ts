/**
 * F04 验收：阶段、暂停/续接、取消两步、完成有据。
 *
 * 核心（对应 I1、I3、I4、I5）：
 *   - 构造暂停/取消命令**本身不改状态**（状态要等事件）；
 *   - 暂停记录 `resumeFrom`，恢复回到暂停前的态；
 *   - 取消是两步：`cancelling`（非终态）→ 核验 `cancel-result` 才 `cancelled`；
 *     未知核验留在 `cancelling`（未知 ≠ 已取消）；被拒则回 `processing`；**成果保留**；
 *   - 阶段单调推进，回退被 `stage-regression` 拒绝；
 *   - 进入 `completed` 必须有 `status='succeeded'` + `resultRef` + `verificationMode='real'`。
 *
 * 定向运行：`npx vitest run tests/mobile-ui/F04/lifecycle.test.ts --reporter=basic`
 */

import { describe, expect, it } from 'vitest';

import {
  GroupError,
  applyTaskEvent,
  buildCancelCommand,
  buildPauseCommand,
  buildResumeCommand,
  type GroupsState,
  type TaskEvent,
  type TaskState,
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

function stateEvent(to: TaskState, revision: number, at: string, extra: Record<string, unknown> = {}): TaskEvent {
  return makeEvent({ taskId: IDS.weeklyTask, kind: 'state', at, to, ...extra }, { revision });
}

const AT1 = '2026-10-03T10:20:00Z';
const AT2 = '2026-10-03T10:21:00Z';
const AT3 = '2026-10-03T10:22:00Z';

describe('F04 / 命令不改状态（状态由真实事件驱动）', () => {
  it('构造暂停/取消命令后任务态与 revision 逐字段不变', () => {
    const state = seed();
    const before = taskOf(state, IDS.weeklyTask);
    buildPauseCommand({ taskId: IDS.weeklyTask, conversationId: IDS.convWeekly, expectedRevision: before.revision });
    buildCancelCommand({ taskId: IDS.weeklyTask, conversationId: IDS.convWeekly, expectedRevision: before.revision });
    const after = taskOf(state, IDS.weeklyTask);
    expect(after.state).toBe('processing');
    expect(after.revision).toBe(1);
    expect(after.activity).toHaveLength(0);
  });
});

describe('F04 / 暂停保留续接入口', () => {
  it('暂停记录 resumeFrom，恢复回到暂停前的态', () => {
    const state = seed();
    const paused = applyTaskEvent(state, stateEvent('paused', 2, AT1));
    const p = taskOf(paused, IDS.weeklyTask);
    expect(p.state).toBe('paused');
    expect(p.resumeFrom).toBe('processing');

    const resumed = applyTaskEvent(
      paused,
      stateEvent('processing', 3, AT2),
    );
    const r = taskOf(resumed, IDS.weeklyTask);
    expect(r.state).toBe('processing');
    expect(r.resumeFrom).toBeNull();
  });

  it('暂停态下恢复命令可构造（携带当前 revision）', () => {
    const state = seed();
    const paused = applyTaskEvent(state, stateEvent('paused', 2, AT1));
    const cmd = buildResumeCommand({
      taskId: IDS.weeklyTask,
      conversationId: IDS.convWeekly,
      expectedRevision: taskOf(paused, IDS.weeklyTask).revision,
    });
    expect(cmd.operation).toBe('mutate');
    expect(cmd.payload).toMatchObject({ taskId: IDS.weeklyTask, expectedRevision: 2 });
  });
});

describe('F04 / 取消两步：非终态 → 核验 → 终态', () => {
  it('cancelling 非终态，provider-confirmed 后 cancelled 且成果保留', () => {
    const state = seed();
    const cancelling = applyTaskEvent(state, stateEvent('cancelling', 2, AT1));
    const c = taskOf(cancelling, IDS.weeklyTask);
    expect(c.state).toBe('cancelling');
    expect(c.cancel?.outcome).toBe('pending');
    expect(c.artifacts.map((a) => a.refId)).toContain('art-draft');

    const cancelled = applyTaskEvent(
      cancelling,
      makeEvent(
        { taskId: IDS.weeklyTask, kind: 'cancel-result', at: AT2, cancellation: { outcome: 'provider-confirmed' } },
        { revision: 3 },
      ),
    );
    const done = taskOf(cancelled, IDS.weeklyTask);
    expect(done.state).toBe('cancelled');
    expect(done.cancel?.outcome).toBe('provider-confirmed');
    // 已发生的成果保留（取消不销毁已完成结果）。
    expect(done.artifacts.map((a) => a.refId)).toContain('art-draft');
  });

  it('取消被供应方拒绝 ⇒ 回到 processing 并给出原因', () => {
    const state = seed();
    const cancelling = applyTaskEvent(state, stateEvent('cancelling', 2, AT1));
    const rejected = applyTaskEvent(
      cancelling,
      makeEvent(
        { taskId: IDS.weeklyTask, kind: 'cancel-result', at: AT2, cancellation: { outcome: 'provider-rejected' } },
        { revision: 3 },
      ),
    );
    const t = taskOf(rejected, IDS.weeklyTask);
    expect(t.state).toBe('processing');
    expect(t.waitReason).toBe('取消被供应方拒绝，任务继续');
  });

  it('取消结果未知 ⇒ 留在 cancelling，不得声称已取消', () => {
    const state = seed();
    const cancelling = applyTaskEvent(state, stateEvent('cancelling', 2, AT1));
    const unknown = applyTaskEvent(
      cancelling,
      makeEvent(
        { taskId: IDS.weeklyTask, kind: 'cancel-result', at: AT2, cancellation: { outcome: 'unknown' } },
        { revision: 3 },
      ),
    );
    const t = taskOf(unknown, IDS.weeklyTask);
    expect(t.state).toBe('cancelling');
    expect(t.cancel?.outcome).toBe('unknown');
    expect(t.waitReason).toBe('正在确认取消结果');
  });

  it('对未取消任务投递取消核验 ⇒ not-cancelling', () => {
    const state = seed();
    expect(
      codeOf(() =>
        applyTaskEvent(
          state,
          makeEvent(
            { taskId: IDS.weeklyTask, kind: 'cancel-result', at: AT1, cancellation: { outcome: 'provider-confirmed' } },
            { revision: 2 },
          ),
        ),
      ),
    ).toBe('not-cancelling');
  });
});

describe('F04 / 阶段单调推进', () => {
  it('激活 review 时把更早的 pending 阶段补记 done', () => {
    const state: GroupsState = seed();
    const next = applyTaskEvent(
      state,
      makeEvent(
        { taskId: IDS.weeklyTask, kind: 'stage', at: AT1, stageId: 'review', stageStatus: 'active' },
        { revision: 2 },
      ),
    );
    const t = taskOf(next, IDS.weeklyTask);
    expect(t.stages.find((s) => s.stageId === 'draft')?.status).toBe('done');
    expect(t.stages.find((s) => s.stageId === 'review')?.status).toBe('active');
    expect(t.activeStageIndex).toBe(1);
  });

  it('回退已完成阶段 ⇒ stage-regression', () => {
    const state = seed();
    const done = applyTaskEvent(
      state,
      makeEvent(
        { taskId: IDS.weeklyTask, kind: 'stage', at: AT1, stageId: 'draft', stageStatus: 'done' },
        { revision: 2 },
      ),
    );
    expect(
      codeOf(() =>
        applyTaskEvent(
          done,
          makeEvent(
            { taskId: IDS.weeklyTask, kind: 'stage', at: AT2, stageId: 'draft', stageStatus: 'pending' },
            { revision: 3 },
          ),
        ),
      ),
    ).toBe('stage-regression');
  });

  it('未知阶段 ⇒ unknown-stage', () => {
    const state = seed();
    expect(
      codeOf(() =>
        applyTaskEvent(
          state,
          makeEvent(
            { taskId: IDS.weeklyTask, kind: 'stage', at: AT1, stageId: 'nope', stageStatus: 'active' },
            { revision: 2 },
          ),
        ),
      ),
    ).toBe('unknown-stage');
  });
});

describe('F04 / 完成有据（不以空闲/无凭据判完成）', () => {
  it('缺 resultRef 或非 succeeded ⇒ missing-completion-evidence', () => {
    const state = seed();
    expect(
      codeOf(() =>
        applyTaskEvent(state, stateEvent('completed', 2, AT1, {})),
      ),
    ).toBe('missing-completion-evidence');
  });

  it('反向对照：fixture 模式的完成被拒（不得冒充真实凭据）', () => {
    const state = seed();
    expect(
      codeOf(() =>
        applyTaskEvent(
          state,
          makeEvent(
            { taskId: IDS.weeklyTask, kind: 'state', at: AT1, to: 'completed' },
            { revision: 2, status: 'succeeded', resultRef: 'artifact:art-draft@2', verificationMode: 'fixture' },
          ),
        ),
      ),
    ).toBe('missing-completion-evidence');
  });

  it('正例：succeeded + resultRef + real ⇒ completed', () => {
    const state = seed();
    const completed = applyTaskEvent(
      state,
      makeEvent(
        { taskId: IDS.weeklyTask, kind: 'state', at: AT1, to: 'completed' },
        { revision: 2, status: 'succeeded', resultRef: 'artifact:art-draft@2', verificationMode: 'real' },
      ),
    );
    const t = taskOf(completed, IDS.weeklyTask);
    expect(t.state).toBe('completed');
  });

  it('非法迁移（已终态再迁移）⇒ illegal-transition', () => {
    const state = seed();
    const completed = applyTaskEvent(
      state,
      makeEvent(
        { taskId: IDS.weeklyTask, kind: 'state', at: AT1, to: 'completed' },
        { revision: 2, status: 'succeeded', resultRef: 'artifact:x@1', verificationMode: 'real' },
      ),
    );
    expect(
      codeOf(() => applyTaskEvent(completed, stateEvent('processing', 3, AT2))),
    ).toBe('illegal-transition');
  });
});

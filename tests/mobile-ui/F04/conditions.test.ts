/**
 * F04 验收：改条件（T03）——只读预览、影响面校验、事件应用使旧卡失效。
 *
 * 核心（对应 I6）：
 *   - `planChangeConditions` 是只读预览，不改状态；过期 revision 被拒；
 *   - `affected` 里列不存在的产物/动作/确认卡 ⇒ `unknown-affected-id`（不凭空编造影响面）；
 *   - 改条件命令本身不改状态；`condition` 事件应用后约束更新、受影响的待确认动作与外部动作
 *     引用失效、**产物保留**；旧 revision 的后续事件被 `stale-revision` 拒绝。
 *
 * 定向运行：`npx vitest run tests/mobile-ui/F04/conditions.test.ts --reporter=basic`
 */

import { describe, expect, it } from 'vitest';

import {
  GroupError,
  applyTaskEvent,
  buildChangeConditionsCommand,
  planChangeConditions,
  type AffectedSummary,
  type ConditionChange,
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

const AT = '2026-10-03T10:30:00Z';

function affected(): AffectedSummary {
  return { artifactIds: ['art-draft'], actionIds: ['act-send'], decisionIds: ['act-send'] };
}

const CHANGES: readonly ConditionChange[] = [{ field: 'budget', value: '已增加' }];

describe('F04 / 改条件预览（只读）', () => {
  it('给出当前/修改后约束、受影响标签与下一 revision', () => {
    const state = seed();
    const plan = planChangeConditions(state, {
      taskId: IDS.weeklyTask,
      expectedRevision: 1,
      changes: CHANGES,
      affected: affected(),
    });
    expect(plan.currentRevision).toBe(1);
    expect(plan.nextRevision).toBe(2);
    expect(plan.currentConstraints).toContain('budget=已批准');
    expect(plan.nextConstraints).toContain('budget=已增加');
    expect(plan.nextConstraints).not.toContain('budget=已批准');
    expect(plan.nextConstraints).toContain('deadline=2026-10-05');
    expect(plan.affectedArtifactLabels).toEqual(['周报草稿']);
    // 只读：状态未变。
    expect(taskOf(state, IDS.weeklyTask).revision).toBe(1);
    expect(taskOf(state, IDS.weeklyTask).constraints).toContain('budget=已批准');
  });

  it('过期 revision 预览被拒', () => {
    const state = seed();
    expect(
      codeOf(() =>
        planChangeConditions(state, { taskId: IDS.weeklyTask, expectedRevision: 0, changes: CHANGES }),
      ),
    ).toBe('stale-revision');
  });

  it('affected 含不存在的 id ⇒ unknown-affected-id', () => {
    const state = seed();
    expect(
      codeOf(() =>
        planChangeConditions(state, {
          taskId: IDS.weeklyTask,
          expectedRevision: 1,
          changes: CHANGES,
          affected: { artifactIds: ['art-ghost'], actionIds: [], decisionIds: [] },
        }),
      ),
    ).toBe('unknown-affected-id');
  });

  it('空 changes ⇒ invalid-value', () => {
    const state = seed();
    expect(
      codeOf(() => planChangeConditions(state, { taskId: IDS.weeklyTask, expectedRevision: 1, changes: [] })),
    ).toBe('invalid-value');
  });
});

describe('F04 / 改条件命令', () => {
  it('命令携带 changes，且不改变状态', () => {
    const state = seed();
    const cmd = buildChangeConditionsCommand({
      taskId: IDS.weeklyTask,
      conversationId: IDS.convWeekly,
      expectedRevision: 1,
      changes: CHANGES,
      affected: affected(),
    });
    expect(cmd.operation).toBe('mutate');
    expect(cmd.payload).toMatchObject({ taskId: IDS.weeklyTask, expectedRevision: 1 });
    expect(taskOf(state, IDS.weeklyTask).revision).toBe(1);
  });
});

describe('F04 / 改条件事件使旧卡失效', () => {
  it('约束更新、受影响动作失效、产物保留', () => {
    const state = seed();
    const next = applyTaskEvent(
      state,
      makeEvent(
        { taskId: IDS.weeklyTask, kind: 'condition', at: AT, changes: CHANGES, affected: affected() },
        { revision: 2 },
      ),
    );
    const t = taskOf(next, IDS.weeklyTask);
    expect(t.constraints).toContain('budget=已增加');
    expect(t.constraints).toContain('deadline=2026-10-05');
    // 受影响的待确认动作与外部动作引用失效。
    expect(t.pendingDecisions.map((d) => d.actionId)).not.toContain('act-send');
    expect(t.actionRefs).not.toContain('act-send');
    // 产物保留（是结果，不销毁）。
    expect(t.artifacts.map((a) => a.refId)).toContain('art-draft');
    expect(t.revision).toBe(2);
  });

  it('改条件后旧 revision 的后续事件被拒（stale-revision）', () => {
    const state = seed();
    const changed = applyTaskEvent(
      state,
      makeEvent(
        { taskId: IDS.weeklyTask, kind: 'condition', at: AT, changes: CHANGES, affected: affected() },
        { revision: 2 },
      ),
    );
    expect(
      codeOf(() =>
        applyTaskEvent(
          changed,
          makeEvent(
            { taskId: IDS.weeklyTask, kind: 'wait', at: AT, to: 'awaiting-input', waitReason: '旧条件' },
            { revision: 2 },
          ),
        ),
      ),
    ).toBe('stale-revision');
  });
});

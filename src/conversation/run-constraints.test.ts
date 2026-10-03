/**
 * `run-constraints.ts`（CHAT-04）单元测试。
 *
 * 核心是一条**反猜测**主张：归属只由显式绑定（或"唯一活动运行"的计数规则）决定。
 * 因此这里刻意用**文案完全相同**的指令做正反两组对照：
 * - 带显式绑定 ⇒ 各归各的任务；
 * - 不带显式绑定且多任务在跑 ⇒ `needs_clarification`，一条都不落库。
 */

import { describe, expect, it } from 'vitest';

import { asMessageId, asRevision, type Revision } from '../protocol/ids.js';
import { RunConstraintBoard, type ActiveRun, type ApplyRequirementResult } from './run-constraints.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function expectApplied(result: ApplyRequirementResult): Extract<ApplyRequirementResult, { status: 'applied' }> {
  if (result.status !== 'applied') {
    throw new Error(`预期 applied，实际 ${result.status}：${JSON.stringify(result)}`);
  }
  return result;
}

/** 两个在跑的任务，用于"措辞相近但指向不同任务"的对照。 */
function boardWithTwoRuns(): { board: RunConstraintBoard; a: ActiveRun; b: ActiveRun } {
  const board = new RunConstraintBoard({ seed: 'rc' });
  const a = board.startRun({ title: 'Word 报告' });
  const b = board.startRun({ title: 'PPT 汇报' });
  return { board, a, b };
}

// ---------------------------------------------------------------------------
// 归属：显式绑定，绝不靠文本
// ---------------------------------------------------------------------------

describe('归属只认显式绑定（CHAT-04）', () => {
  it('两条措辞完全相同、指向不同任务的指令，各按显式绑定归属', () => {
    const { board, a, b } = boardWithTwoRuns();
    const text = '把篇幅改成 800 字左右';

    const ra = expectApplied(board.applyRequirement({ kind: 'constraint', text, task_id: a.task_id }));
    const rb = expectApplied(board.applyRequirement({ kind: 'constraint', text, task_id: b.task_id }));

    expect(ra.requirement.text).toBe(rb.requirement.text); // 文案逐字相同
    expect(ra.requirement.task_id).toBe(a.task_id);
    expect(rb.requirement.task_id).toBe(b.task_id);
    expect(ra.requirement.origin).toEqual({ by: 'task', task_id: a.task_id });
    expect(rb.requirement.origin).toEqual({ by: 'task', task_id: b.task_id });

    expect(board.requirementsFor(a.task_id)).toHaveLength(1);
    expect(board.requirementsFor(b.task_id)).toHaveLength(1);
  });

  it('反向对照：同样两条指令、无显式绑定且多任务在跑 ⇒ 需要澄清，一条都不落库', () => {
    const { board, a, b } = boardWithTwoRuns();
    const text = '把篇幅改成 800 字左右';

    const r1 = board.applyRequirement({ kind: 'constraint', text });
    const r2 = board.applyRequirement({ kind: 'constraint', text });

    expect(r1.status).toBe('needs_clarification');
    expect(r2.status).toBe('needs_clarification');
    if (r1.status === 'needs_clarification') {
      expect(r1.reason).toBe('ambiguous_task');
      expect(r1.candidates).toHaveLength(2);
      expect(r1.candidates.map((c) => c.task_id).sort()).toEqual([a.task_id, b.task_id].sort());
    }
    // 关键：没有猜、没有落库。
    expect(board.requirementsFor(a.task_id)).toHaveLength(0);
    expect(board.requirementsFor(b.task_id)).toHaveLength(0);
  });

  it('反向对照：正文里点名了另一个任务的标题，仍按显式绑定归属（不做文本匹配）', () => {
    const { board, a, b } = boardWithTwoRuns();
    // 文本"看起来像"在说 b，但绑定指向 a。
    const text = '关于《PPT 汇报》第 2 页，把正文字号改成 14';
    const r = expectApplied(board.applyRequirement({ kind: 'constraint', text, task_id: a.task_id }));

    expect(r.requirement.task_id).toBe(a.task_id);
    expect(board.requirementsFor(a.task_id)).toHaveLength(1);
    expect(board.requirementsFor(b.task_id)).toHaveLength(0); // b 没有被"猜"到
  });

  it('显式任务绑定指向未知任务 ⇒ unknown_task（不静默新建）', () => {
    const board = new RunConstraintBoard({ seed: 'rc' });
    const result = board.applyRequirement({
      kind: 'constraint',
      text: '随便什么',
      task_id: board.startRun({ title: 'a' }).task_id,
    });
    expect(result.status).toBe('applied');

    const unknownBoard = new RunConstraintBoard();
    const unknown = unknownBoard.applyRequirement({
      kind: 'constraint',
      text: '随便什么',
      task_id: 'ghost' as ActiveRun['task_id'],
    });
    expect(unknown.status).toBe('rejected');
    if (unknown.status === 'rejected') expect(unknown.code).toBe('unknown_task');
  });
});

// ---------------------------------------------------------------------------
// 归属：消息绑定与"唯一活动运行"的计数规则
// ---------------------------------------------------------------------------

describe('消息绑定与唯一活动运行（CHAT-04）', () => {
  it('经 message_id 归属：解析到该消息绑定的任务与版本', () => {
    const { board, b } = boardWithTwoRuns();
    const messageId = asMessageId('c9');
    const bound = board.registerMessageBinding({ message_id: messageId, task_id: b.task_id });
    expect(bound.status).toBe('ok');

    const r = expectApplied(
      board.applyRequirement({ kind: 'material', text: '附上参考文件', message_id: messageId }),
    );
    expect(r.requirement.task_id).toBe(b.task_id);
    expect(r.requirement.kind).toBe('material');
    expect(r.requirement.origin).toEqual({ by: 'message', message_id: messageId });
  });

  it('反向对照：未知消息绑定 ⇒ unknown_message，不猜任何任务', () => {
    const { board, a, b } = boardWithTwoRuns();
    const r = board.applyRequirement({
      kind: 'material',
      text: '附上参考文件',
      message_id: asMessageId('no-such-message'),
    });
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.code).toBe('unknown_message');
    expect(board.requirementsFor(a.task_id)).toHaveLength(0);
    expect(board.requirementsFor(b.task_id)).toHaveLength(0);
  });

  it('唯一活动运行时按数量归属（仍不做文本比对）', () => {
    const board = new RunConstraintBoard({ seed: 'rc' });
    const only = board.startRun({ title: '唯一任务' });
    const r = expectApplied(board.applyRequirement({ kind: 'constraint', text: '随便什么文字都一样' }));
    expect(r.requirement.origin.by).toBe('sole_active_run');
    expect(r.requirement.task_id).toBe(only.task_id);
  });

  it('反向对照：一个在跑任务都没有 ⇒ no_active_run', () => {
    const board = new RunConstraintBoard({ seed: 'rc' });
    const result = board.applyRequirement({ kind: 'constraint', text: '没有任务时下达的约束' });
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.code).toBe('no_active_run');
  });

  it('反向对照：唯一活动运行已终态时不参与归属（终态任务不算"在跑"）', () => {
    const board = new RunConstraintBoard({ seed: 'rc' });
    const a = board.startRun({ title: 'a' });
    expect(board.cancel(a.task_id).status).toBe('ok');
    const result = board.applyRequirement({ kind: 'constraint', text: 'x' });
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.code).toBe('no_active_run');
  });
});

// ---------------------------------------------------------------------------
// 版本绑定
// ---------------------------------------------------------------------------

describe('新增要求绑定正确版本（CHAT-04）', () => {
  it('绑定到旧版本 ⇒ revision_mismatch 并回带当前版本；绑定当前版本成功', () => {
    const board = new RunConstraintBoard({ seed: 'rc' });
    const run = board.startRun({ title: 'x' });
    expectApplied(board.applyRequirement({ kind: 'constraint', text: '初版约束', task_id: run.task_id }));

    const advanced = board.advanceRevision(run.task_id);
    expect(advanced?.revision).toBe(1);

    const stale = board.applyRequirement({
      kind: 'constraint',
      text: '按第 0 版下达的约束',
      task_id: run.task_id,
      revision: asRevision(0),
    });
    expect(stale.status).toBe('rejected');
    if (stale.status === 'rejected') {
      expect(stale.code).toBe('revision_mismatch');
      expect(stale.current_revision).toBe(1);
    }

    const fresh = expectApplied(
      board.applyRequirement({
        kind: 'constraint',
        text: '按第 1 版下达的约束',
        task_id: run.task_id,
        revision: asRevision(1),
      }),
    );
    expect(fresh.requirement.revision).toBe(1);
  });

  it('版本推进后，早先绑定可被核对为"已过期"（superseded）', () => {
    const board = new RunConstraintBoard({ seed: 'rc' });
    const run = board.startRun({ title: 'x' });
    expectApplied(board.applyRequirement({ kind: 'constraint', text: 'v0 的约束', task_id: run.task_id }));
    expect(board.supersededRequirements(run.task_id)).toHaveLength(0);

    board.advanceRevision(run.task_id);
    expectApplied(
      board.applyRequirement({
        kind: 'constraint',
        text: 'v1 的约束',
        task_id: run.task_id,
        revision: asRevision(1),
      }),
    );

    const superseded = board.supersededRequirements(run.task_id);
    expect(superseded).toHaveLength(1);
    expect(superseded[0]?.revision).toBe(0);
    expect(superseded[0]?.text).toBe('v0 的约束');
  });

  it('反向对照：空正文被拒', () => {
    const board = new RunConstraintBoard({ seed: 'rc' });
    const run = board.startRun({ title: 'x' });
    const r = board.applyRequirement({ kind: 'constraint', text: '   ', task_id: run.task_id });
    expect(r.status).toBe('rejected');
    if (r.status === 'rejected') expect(r.code).toBe('empty_text');
    expect(board.requirementsFor(run.task_id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 运行中控制：暂停 / 继续 / 取消
// ---------------------------------------------------------------------------

describe('运行中暂停与取消（CHAT-04）', () => {
  it('暂停 → 暂停中仍可改约束 → 继续 → 取消；终态后拒绝新要求', () => {
    const board = new RunConstraintBoard({ seed: 'rc' });
    const run = board.startRun({ title: 'x' });

    expect(board.pause(run.task_id).status).toBe('ok');
    expect(board.getRun(run.task_id)?.status).toBe('paused');

    // 暂停中照常可以改约束 / 补资料。
    expectApplied(board.applyRequirement({ kind: 'constraint', text: '暂停时补的约束', task_id: run.task_id }));
    expectApplied(board.applyRequirement({ kind: 'material', text: '暂停时补的资料', task_id: run.task_id }));

    expect(board.resumeRun(run.task_id).status).toBe('ok');
    expect(board.getRun(run.task_id)?.status).toBe('running');

    expect(board.cancel(run.task_id).status).toBe('ok');
    expect(board.getRun(run.task_id)?.status).toBe('cancelled');

    const afterTerminal = board.applyRequirement({ kind: 'constraint', text: '取消后补的', task_id: run.task_id });
    expect(afterTerminal.status).toBe('rejected');
    if (afterTerminal.status === 'rejected') expect(afterTerminal.code).toBe('run_terminal');
  });

  it('反向对照：重复暂停、对非暂停任务继续、重复取消都被拒', () => {
    const board = new RunConstraintBoard({ seed: 'rc' });
    const run = board.startRun({ title: 'x' });

    // 运行中不能"继续"。
    const resumeRunning = board.resumeRun(run.task_id);
    expect(resumeRunning.status).toBe('rejected');
    if (resumeRunning.status === 'rejected') expect(resumeRunning.code).toBe('invalid_state');

    expect(board.pause(run.task_id).status).toBe('ok');
    const pauseAgain = board.pause(run.task_id);
    expect(pauseAgain.status).toBe('rejected');
    if (pauseAgain.status === 'rejected') expect(pauseAgain.code).toBe('invalid_state');

    expect(board.cancel(run.task_id).status).toBe('ok');
    const cancelAgain = board.cancel(run.task_id);
    expect(cancelAgain.status).toBe('rejected');
    if (cancelAgain.status === 'rejected') expect(cancelAgain.code).toBe('already_terminal');
  });

  it('反向对照：未知任务的控制一律 unknown_task', () => {
    const board = new RunConstraintBoard({ seed: 'rc' });
    const ghost = 'ghost' as ActiveRun['task_id'];
    for (const result of [board.pause(ghost), board.resumeRun(ghost), board.cancel(ghost)]) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.code).toBe('unknown_task');
    }
  });
});

// ---------------------------------------------------------------------------
// 类型级：版本是品牌类型，不能用裸 number 蒙混
// ---------------------------------------------------------------------------

describe('版本绑定是显式的（CHAT-04）', () => {
  it('revision 经 asRevision 构造，可与其他版本比较', () => {
    const board = new RunConstraintBoard({ seed: 'rc' });
    const run = board.startRun({ title: 'x', revision: asRevision(3) });
    const current: Revision = run.revision;
    expect(current).toBe(3);
    const r = expectApplied(
      board.applyRequirement({ kind: 'constraint', text: 'c', task_id: run.task_id, revision: current }),
    );
    expect(r.requirement.revision).toBe(3);
  });
});

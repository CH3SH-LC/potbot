/**
 * 会话内多任务面板单测（CHAT-05；完整能力目录 2026-10-03）。
 *
 * 正反例：
 * - **正例**：同一会话可有多个任务；任务卡/进度/文件/等待条件/决策气泡各自可读；
 * - **正例**：多个会话**同时**在跑（`runningSessions` 同时列出两个会话）；
 * - **反例 1**（核心归位）：**任务 A 的进度不会出现在任务 B 上**——更新 A 后 B 逐字段不变；
 * - **反例 2**：用**别的会话的坐标**取任务被拒（`task_not_in_session`），不跨会话泄漏；
 * - **反例 3**：进度越界被拒；对不存在的任务/决策的操作结构化失败；
 * - **反向对照**：两条 for 循环批量更新后，每个任务的进度**恰好**等于它自己的那次写入。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime, asTaskId } from '../protocol/index.js';
import { asConversationId } from './session-model.js';
import { ConversationTaskBoard } from './session-tasks.js';

const t = (n: number) => asLogicalTime(n);
const cid = (v: string) => asConversationId(v);
const tid = (v: string) => asTaskId(v);

const A = cid('conv-a');
const B = cid('conv-b');
const T1 = tid('T-a-1');
const T2 = tid('T-a-2');
const T3 = tid('T-b-1');

describe('CHAT-05 同一会话可有多个任务', () => {
  it('同会话两张卡各自独立', () => {
    const board = new ConversationTaskBoard();
    expect(board.createTask({ conversation_id: A, task_id: T1, title: '写周报', goal: '生成周报', at: t(1) }).ok).toBe(true);
    expect(board.createTask({ conversation_id: A, task_id: T2, title: '查数据', goal: '取数', at: t(2) }).ok).toBe(true);
    expect(board.taskCount(A)).toBe(2);
    const tasks = board.tasksOf(A);
    expect(tasks.map((c) => c.task_id)).toEqual([T1, T2]);
    expect(tasks.every((c) => c.run_state === 'queued')).toBe(true);
  });

  it('重复任务 id 被拒（全板唯一，不静默覆盖标题）', () => {
    const board = new ConversationTaskBoard();
    board.createTask({ conversation_id: A, task_id: T1, title: '原', goal: 'g', at: t(1) });
    const dup = board.createTask({ conversation_id: A, task_id: T1, title: '改', goal: 'g', at: t(2) });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe('task_already_exists');
    expect(board.tasksOf(A)[0]?.title).toBe('原');
  });
});

describe('CHAT-05 进度归位（核心）', () => {
  it('更新任务 A 的进度，任务 B 逐字段不变', () => {
    const board = new ConversationTaskBoard();
    board.createTask({ conversation_id: A, task_id: T1, title: 'A1', goal: 'g', at: t(1) });
    board.createTask({ conversation_id: A, task_id: T2, title: 'A2', goal: 'g', at: t(1) });
    const before = board.taskCard(A, T2);
    expect(before.ok).toBe(true);

    board.updateProgress(A, T1, { percent: 80, label: '快好了', at: t(5) });

    const a1 = board.taskCard(A, T1);
    const a2 = board.taskCard(A, T2);
    expect(a1.ok && a1.value.progress.percent).toBe(80);
    expect(a1.ok && a1.value.progress.label).toBe('快好了');
    // 反向对照：B（此处指同会话的另一任务 A2）完全没被带动
    expect(a2.ok && a2.value.progress.percent).toBe(0);
    expect(a2.ok && a2.value.progress.label).toBe('已排队');
    expect(a2.ok && a2.value.updated_at).toBe(t(1));
  });

  it('用别的会话的坐标取任务被拒（不跨会话泄漏）', () => {
    const board = new ConversationTaskBoard();
    board.createTask({ conversation_id: A, task_id: T1, title: 'A1', goal: 'g', at: t(1) });
    const cross = board.taskCard(B, T1);
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.code).toBe('task_not_in_session');
    // 反例：拿 A 的坐标去改，也不会误改
    expect(board.updateProgress(B, T1, { percent: 50, at: t(2) }).ok).toBe(false);
    const a1 = board.taskCard(A, T1);
    expect(a1.ok && a1.value.progress.percent).toBe(0);
    expect(board.tasksOf(B)).toHaveLength(0);
  });

  it('批量交叉更新后，每个任务恰好等于自己那次写入（无串写）', () => {
    const board = new ConversationTaskBoard();
    board.createTask({ conversation_id: A, task_id: T1, title: 'A1', goal: 'g', at: t(1) });
    board.createTask({ conversation_id: B, task_id: T3, title: 'B1', goal: 'g', at: t(1) });
    for (let i = 1; i <= 5; i += 1) {
      board.updateProgress(A, T1, { percent: i * 10, label: `a${String(i)}`, at: t(i) });
    }
    for (let i = 1; i <= 3; i += 1) {
      board.updateProgress(B, T3, { percent: i, label: `b${String(i)}`, at: t(10 + i) });
    }
    const a = board.taskCard(A, T1);
    const b = board.taskCard(B, T3);
    expect(a.ok && a.value.progress.percent).toBe(50);
    expect(a.ok && a.value.progress.label).toBe('a5');
    expect(b.ok && b.value.progress.percent).toBe(3);
    expect(b.ok && b.value.progress.label).toBe('b3');
  });

  it('进度越界 / 非有限数被拒，且不污染已有进度', () => {
    const board = new ConversationTaskBoard();
    board.createTask({ conversation_id: A, task_id: T1, title: 'A1', goal: 'g', at: t(1) });
    board.updateProgress(A, T1, { percent: 40, at: t(2) });
    expect(board.updateProgress(A, T1, { percent: 101, at: t(3) }).ok).toBe(false);
    expect(board.updateProgress(A, T1, { percent: -1, at: t(3) }).ok).toBe(false);
    expect(board.updateProgress(A, T1, { percent: Number.NaN, at: t(3) }).ok).toBe(false);
    const card = board.taskCard(A, T1);
    expect(card.ok && card.value.progress.percent).toBe(40);
  });
});

describe('CHAT-05 并行执行（跨会话）', () => {
  it('两个会话可以同时处于 running', () => {
    const board = new ConversationTaskBoard();
    board.createTask({ conversation_id: A, task_id: T1, title: 'A1', goal: 'g', at: t(1) });
    board.createTask({ conversation_id: B, task_id: T3, title: 'B1', goal: 'g', at: t(1) });
    board.startRun(A, T1, 'run-a', t(2));
    board.startRun(B, T3, 'run-b', t(2));
    expect(board.runningTaskCount()).toBe(2);
    expect([...board.runningSessions()].sort()).toEqual(['conv-a', 'conv-b']);
    const a = board.taskCard(A, T1);
    const b = board.taskCard(B, T3);
    expect(a.ok && a.value.run_id).toBe('run-a');
    expect(b.ok && b.value.run_id).toBe('run-b');
    expect(a.ok && a.value.run_id).not.toBe(b.ok ? b.value.run_id : null);
  });

  it('同一任务重复 startRun 不会产生第二个轮次（幂等）', () => {
    const board = new ConversationTaskBoard();
    board.createTask({ conversation_id: A, task_id: T1, title: 'A1', goal: 'g', at: t(1) });
    board.startRun(A, T1, 'run-1', t(2));
    board.startRun(A, T1, 'run-2', t(3));
    const card = board.taskCard(A, T1);
    expect(card.ok && card.value.run_id).toBe('run-1');
    expect(board.runningTaskCount()).toBe(1);
  });

  it('完成一个任务不改变另一个任务的运行态', () => {
    const board = new ConversationTaskBoard();
    board.createTask({ conversation_id: A, task_id: T1, title: 'A1', goal: 'g', at: t(1) });
    board.createTask({ conversation_id: B, task_id: T3, title: 'B1', goal: 'g', at: t(1) });
    board.startRun(A, T1, 'run-a', t(2));
    board.startRun(B, T3, 'run-b', t(2));
    board.completeTask(A, T1, t(5));
    const a = board.taskCard(A, T1);
    const b = board.taskCard(B, T3);
    expect(a.ok && a.value.run_state).toBe('completed');
    expect(a.ok && a.value.progress.percent).toBe(100);
    expect(b.ok && b.value.run_state).toBe('running');
    expect(board.runningSessions()).toEqual(['conv-b']);
  });

  it('对不存在的任务 / 会话操作结构化失败', () => {
    const board = new ConversationTaskBoard();
    const missing = board.startRun(A, T1, 'run-x', t(1));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('task_not_found');
    expect(board.taskCard(A, T1).ok).toBe(false);
  });
});

describe('CHAT-05 文件 / 等待条件 / 决策气泡各自归位', () => {
  it('文件只挂在自己的任务卡上', () => {
    const board = new ConversationTaskBoard();
    board.createTask({ conversation_id: A, task_id: T1, title: 'A1', goal: 'g', at: t(1) });
    board.createTask({ conversation_id: A, task_id: T2, title: 'A2', goal: 'g', at: t(1) });
    board.attachFile(A, T1, { file_id: 'f1', filename: '周报.docx', at: t(2) });
    const t1 = board.taskCard(A, T1);
    const t2 = board.taskCard(A, T2);
    expect(t1.ok && t1.value.files.map((f) => f.file_id)).toEqual(['f1']);
    expect(t1.ok && t1.value.files[0]?.digest).toBeNull(); // 未回读核对 ⇒ null，不冒充"已验证"
    expect(t2.ok && t2.value.files).toEqual([]);
    // 幂等：同文件重复登记不产生第二份
    board.attachFile(A, T1, { file_id: 'f1', filename: '周报.docx', at: t(3) });
    const afterDup = board.taskCard(A, T1);
    expect(afterDup.ok && afterDup.value.files).toHaveLength(1);
    // 移除不存在的文件被拒
    expect(board.removeFile(A, T1, 'nope', t(4)).ok).toBe(false);
  });

  it('等待条件只属于触发它的任务，clearWaiting 后回到 running', () => {
    const board = new ConversationTaskBoard();
    board.createTask({ conversation_id: A, task_id: T1, title: 'A1', goal: 'g', at: t(1) });
    board.createTask({ conversation_id: A, task_id: T2, title: 'A2', goal: 'g', at: t(1) });
    board.startRun(A, T1, 'run-a', t(2));
    board.setWaiting(A, T1, { kind: 'decision', detail: '等用户确认发件人', at: t(3) });
    const t1 = board.taskCard(A, T1);
    const t2 = board.taskCard(A, T2);
    expect(t1.ok && t1.value.waiting?.kind).toBe('decision');
    expect(t1.ok && t1.value.run_state).toBe('waiting');
    expect(t2.ok && t2.value.waiting).toBeNull(); // 没被带动
    board.clearWaiting(A, T1, t(4));
    const afterClear = board.taskCard(A, T1);
    expect(afterClear.ok && afterClear.value.run_state).toBe('running');
  });

  it('决策气泡归位到自己任务；解决别的任务的决策被拒', () => {
    const board = new ConversationTaskBoard();
    board.createTask({ conversation_id: A, task_id: T1, title: 'A1', goal: 'g', at: t(1) });
    board.createTask({ conversation_id: A, task_id: T2, title: 'A2', goal: 'g', at: t(1) });
    board.raiseDecision(A, T1, { decision_id: 'd1', prompt: '发这封邮件吗？', at: t(2) });
    expect(board.pendingDecisionsOf(A, T1).map((d) => d.decision_id)).toEqual(['d1']);
    expect(board.pendingDecisionsOf(A, T2)).toEqual([]);

    // 反例：用 T2 的坐标去解决 T1 的决策 ⇒ 被拒
    const wrong = board.resolveDecision(A, T2, 'd1', 'approved', t(3));
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.code).toBe('decision_not_found');
    expect(board.pendingDecisionsOf(A, T1)).toHaveLength(1); // 原决策仍未定局

    const ok = board.resolveDecision(A, T1, 'd1', 'approved', t(4));
    expect(ok.ok && ok.value.decisions[0]?.state).toBe('approved');
    expect(board.pendingDecisionsOf(A, T1)).toEqual([]);
  });
});

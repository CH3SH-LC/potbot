/**
 * 四类删除语义单测（CHAT-08；完整能力目录 2026-10-03）。
 *
 * 正反例：
 * - **正例**：删除会话 / 取消任务 / 删除文件 / 忘记记忆各有**自己的**产物与作用域；
 * - **反例 1**（核心纪律 ①）：会话被删后，该会话**未获准/未执行**的动作**不得**继续执行
 *   ——`execute` 返回 `session_deleted` 且账本**零新增**；
 * - **反向对照**：会话**没有**被删时，同一条已授权动作会正常执行并留下副作用记录
 *   ——证明"不执行"是删除导致的，不是阀门本来就堵着；
 * - **反例 2**（核心纪律 ②）：所有 `DeletionOutcome.reverted` 都是**字面量 false**，
 *   副作用记录在删除后**仍被保留**，想"撤回"恒返回 `irreversible_side_effect`；
 * - **反例 3**：取消任务只作废**该任务**的动作，同会话别的任务的动作仍可执行；
 * - **反例 4**：四类语义互不冒充——删文件/忘记忆**不**删会话、**不**取消任务。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime, asTaskId } from '../protocol/index.js';
import { ConversationSessions, asConversationId, asConversationMemoryRef, createMemoryConversationPersistence } from './session-model.js';
import { ConversationTaskBoard } from './session-tasks.js';
import {
  ActionGate,
  ConversationDeletion,
  SideEffectLedger,
  createConversationDeletion,
} from './delete-semantics.js';

const t = (n: number) => asLogicalTime(n);
const cid = (v: string) => asConversationId(v);
const tid = (v: string) => asTaskId(v);
const mid = (v: string) => asConversationMemoryRef(v);

const A = cid('conv-a');
const B = cid('conv-b');
const T1 = tid('T-a-1');
const T2 = tid('T-a-2');
const T3 = tid('T-b-1');

interface Rig {
  readonly sessions: ConversationSessions;
  readonly board: ConversationTaskBoard;
  readonly ledger: SideEffectLedger;
  readonly gate: ActionGate;
  readonly deletion: ConversationDeletion;
}

function rig(): Rig {
  const sessions = new ConversationSessions({ persistence: createMemoryConversationPersistence() });
  const board = new ConversationTaskBoard();
  const wired = createConversationDeletion({ sessions, board });
  return { sessions, board, ledger: wired.ledger, gate: wired.gate, deletion: wired.deletion };
}

describe('CHAT-08 四类语义分开（作用域互不冒充）', () => {
  it('删除会话：会话没了，别的会话与任务卡仍在（任务不自动取消）', () => {
    const r = rig();
    r.sessions.createSession({ title: 'A', id: A, at: t(1) });
    r.sessions.createSession({ title: 'B', id: B, at: t(1) });
    r.board.createTask({ conversation_id: A, task_id: T1, title: 'A1', goal: 'g', at: t(2) });
    r.board.createTask({ conversation_id: B, task_id: T3, title: 'B1', goal: 'g', at: t(2) });
    r.sessions.attachTask(A, T1, t(2));

    const outcome = r.deletion.deleteSession(A, t(3));
    expect(outcome.ok).toBe(true);
    expect(outcome.action).toBe('delete_session');
    expect(outcome.removed).toEqual(['conv-a']);
    expect(outcome.detached_tasks).toEqual([T1]); // 任务**脱离**但未取消
    expect(r.sessions.getSession(A)).toBeNull();
    expect(r.sessions.getSession(B)).not.toBeNull();
    // 反向对照：任务卡没被静默取消
    const detachedCard = r.board.taskCard(A, T1);
    expect(detachedCard.ok).toBe(true);
    expect(detachedCard.ok && detachedCard.value.run_state).toBe('queued');
  });

  it('取消任务：会话还在，同会话别的任务不受影响', () => {
    const r = rig();
    r.sessions.createSession({ title: 'A', id: A, at: t(1) });
    r.board.createTask({ conversation_id: A, task_id: T1, title: 'A1', goal: 'g', at: t(2) });
    r.board.createTask({ conversation_id: A, task_id: T2, title: 'A2', goal: 'g', at: t(2) });
    r.sessions.attachTask(A, T1, t(2));
    r.sessions.attachTask(A, T2, t(2));

    const outcome = r.deletion.cancelTask(A, T1, t(3));
    expect(outcome.ok).toBe(true);
    expect(outcome.action).toBe('cancel_task');
    const t1 = r.board.taskCard(A, T1);
    const t2 = r.board.taskCard(A, T2);
    expect(t1.ok && t1.value.run_state).toBe('cancelled');
    expect(t2.ok && t2.value.run_state).toBe('queued'); // 没被带动
    expect(r.sessions.getSession(A)).not.toBeNull(); // 会话仍在
    expect(r.sessions.taskRefsOf(A)).toEqual([T2]); // 任务引用被解绑
  });

  it('删除文件：会话与任务都在，只少了一个文件引用', () => {
    const r = rig();
    r.sessions.createSession({ title: 'A', id: A, at: t(1) });
    r.board.createTask({ conversation_id: A, task_id: T1, title: 'A1', goal: 'g', at: t(2) });
    r.board.attachFile(A, T1, { file_id: 'f1', filename: '周报.docx', at: t(2) });
    r.board.attachFile(A, T1, { file_id: 'f2', filename: '明细.docx', at: t(2) });

    const outcome = r.deletion.deleteFile(A, T1, 'f1', t(3));
    expect(outcome.ok).toBe(true);
    expect(outcome.action).toBe('delete_file');
    expect(outcome.removed).toEqual(['f1']);
    const card = r.board.taskCard(A, T1);
    expect(card.ok && card.value.files.map((f) => f.file_id)).toEqual(['f2']);
    expect(r.sessions.getSession(A)).not.toBeNull();
    expect(card.ok && card.value.run_state).toBe('queued');
    // 反例：删不存在的文件被拒
    expect(r.deletion.deleteFile(A, T1, 'nope', t(4)).ok).toBe(false);
  });

  it('忘记记忆：会话与任务都在，只少了一条记忆引用', () => {
    const r = rig();
    r.sessions.createSession({ title: 'A', id: A, at: t(1) });
    r.sessions.attachMemory(A, mid('mem-1'), t(2));
    r.sessions.attachMemory(A, mid('mem-2'), t(2));
    r.board.createTask({ conversation_id: A, task_id: T1, title: 'A1', goal: 'g', at: t(2) });

    const outcome = r.deletion.forgetMemory(A, mid('mem-1'), t(3));
    expect(outcome.ok).toBe(true);
    expect(outcome.action).toBe('forget_memory');
    expect(r.sessions.memoryRefsOf(A)).toEqual(['mem-2']);
    expect(r.sessions.getSession(A)).not.toBeNull();
    expect(r.board.taskCard(A, T1).ok).toBe(true);
    // 反例：忘记一条不存在的记忆被拒
    expect(r.deletion.forgetMemory(A, mid('nope'), t(4)).ok).toBe(false);
  });

  it('对不存在的会话/任务操作结构化失败，且 code 可判', () => {
    const r = rig();
    const missing = r.deletion.deleteSession(A, t(1));
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe('session_not_found');
    const missingTask = r.deletion.cancelTask(A, T1, t(1));
    expect(missingTask.ok).toBe(false);
    expect(missingTask.code).toBe('task_not_found');
  });
});

describe('CHAT-08 纪律①：删了聊天不得继续执行未获准动作', () => {
  it('会话被删 ⇒ 已授权动作执行被作废，账本零新增', () => {
    const r = rig();
    r.sessions.createSession({ title: 'A', id: A, at: t(1) });
    r.board.createTask({ conversation_id: A, task_id: T1, title: 'A1', goal: 'g', at: t(1) });
    r.sessions.attachTask(A, T1, t(1));

    const raised = r.gate.raise({ action_id: 'act-1', conversation_id: A, task_id: T1, description: '发送邮件', at: t(2) });
    expect(raised.ok).toBe(true);
    expect(r.gate.authorize('act-1', t(3)).ok).toBe(true);
    expect(r.ledger.all()).toHaveLength(0); // 授权本身不是副作用

    const outcome = r.deletion.deleteSession(A, t(4));
    expect(outcome.ok).toBe(true);
    expect(outcome.denied_actions).toEqual(['act-1']);

    const executed = r.gate.execute('act-1', t(5));
    expect(executed.ok).toBe(false);
    if (!executed.ok) expect(executed.code).toBe('session_deleted');
    // **零副作用**：账本里没有任何新记录
    expect(r.ledger.all()).toHaveLength(0);
    expect(r.gate.get('act-1')?.state).toBe('denied');
  });

  it('反向对照：会话**未**被删时，同一条已授权动作正常执行并留下记录', () => {
    const r = rig();
    r.sessions.createSession({ title: 'A', id: A, at: t(1) });
    r.board.createTask({ conversation_id: A, task_id: T1, title: 'A1', goal: 'g', at: t(1) });
    r.sessions.attachTask(A, T1, t(1));

    r.gate.raise({ action_id: 'act-1', conversation_id: A, task_id: T1, description: '发送邮件', at: t(2) });
    r.gate.authorize('act-1', t(3));
    const executed = r.gate.execute('act-1', t(4));
    expect(executed.ok).toBe(true);
    if (executed.ok) {
      expect(executed.value.side_effect.reverted).toBe(false);
      expect(executed.value.side_effect.reversible).toBe(false);
      expect(executed.value.side_effect.description).toBe('发送邮件');
    }
    expect(r.ledger.all()).toHaveLength(1);
    // 幂等：重复执行不产生第二条
    const again = r.gate.execute('act-1', t(5));
    expect(again.ok).toBe(true);
    expect(r.ledger.all()).toHaveLength(1);
  });

  it('未授权（awaiting_authorization）就执行 ⇒ 被拒，零副作用', () => {
    const r = rig();
    r.sessions.createSession({ title: 'A', id: A, at: t(1) });
    r.gate.raise({ action_id: 'act-1', conversation_id: A, description: '删库', at: t(2) });
    const executed = r.gate.execute('act-1', t(3));
    expect(executed.ok).toBe(false);
    if (!executed.ok) expect(executed.code).toBe('action_not_authorized');
    expect(r.ledger.all()).toHaveLength(0);
  });

  it('取消任务只作废**该任务**的动作，同会话别的任务的动作照常执行', () => {
    const r = rig();
    r.sessions.createSession({ title: 'A', id: A, at: t(1) });
    r.board.createTask({ conversation_id: A, task_id: T1, title: 'A1', goal: 'g', at: t(1) });
    r.board.createTask({ conversation_id: A, task_id: T2, title: 'A2', goal: 'g', at: t(1) });
    r.sessions.attachTask(A, T1, t(1));
    r.sessions.attachTask(A, T2, t(1));
    r.gate.raise({ action_id: 'act-1', conversation_id: A, task_id: T1, description: '动作一', at: t(2) });
    r.gate.raise({ action_id: 'act-2', conversation_id: A, task_id: T2, description: '动作二', at: t(2) });
    r.gate.authorize('act-1', t(3));
    r.gate.authorize('act-2', t(3));

    const outcome = r.deletion.cancelTask(A, T1, t(4));
    expect(outcome.denied_actions).toEqual(['act-1']);
    const one = r.gate.execute('act-1', t(5));
    expect(one.ok).toBe(false);
    if (!one.ok) expect(one.code).toBe('task_cancelled');
    const two = r.gate.execute('act-2', t(5));
    expect(two.ok).toBe(true); // 会话仍在、T2 未被取消
    expect(r.ledger.all()).toHaveLength(1);
  });

  it('对已删会话重新 raise 被拒（不给已删会话重新挂未获准动作）', () => {
    const r = rig();
    r.sessions.createSession({ title: 'A', id: A, at: t(1) });
    r.deletion.deleteSession(A, t(2));
    const raised = r.gate.raise({ action_id: 'act-x', conversation_id: A, description: 'x', at: t(3) });
    expect(raised.ok).toBe(false);
    if (!raised.ok) expect(raised.code).toBe('session_not_found');
  });
});

describe('CHAT-08 纪律②：不假称撤销已发生副作用', () => {
  it('四类删除的结果 reverted 恒为字面量 false，且副作用被保留', () => {
    const r = rig();
    r.sessions.createSession({ title: 'A', id: A, at: t(1) });
    r.sessions.attachMemory(A, mid('mem-1'), t(1));
    r.board.createTask({ conversation_id: A, task_id: T1, title: 'A1', goal: 'g', at: t(1) });
    r.sessions.attachTask(A, T1, t(1));
    r.board.attachFile(A, T1, { file_id: 'f1', filename: 'x.docx', at: t(1) });

    // 先制造一条真实的已发生副作用
    r.ledger.record({ effect_id: 'e1', conversation_id: A, task_id: T1, file_id: 'f1', description: '已发送邮件', at: t(2) });

    const outcomes = [
      r.deletion.deleteFile(A, T1, 'f1', t(3)),
      r.deletion.forgetMemory(A, mid('mem-1'), t(3)),
      r.deletion.cancelTask(A, T1, t(3)),
      r.deletion.deleteSession(A, t(3)),
    ];
    for (const outcome of outcomes) {
      expect(outcome.reverted).toBe(false);
    }
    // 删除没有抹掉账本：仍然完整保留
    expect(r.ledger.all()).toHaveLength(1);
    expect(r.ledger.forConversation(A)).toHaveLength(1);
    expect(r.ledger.all()[0]?.reversible).toBe(false);
    expect(r.ledger.all()[0]?.reverted).toBe(false);
    // 删除会话的 outcome 带回被保留的真实记录
    const last = outcomes[3];
    expect(last?.retained_side_effects).toHaveLength(1);
    expect(last?.retained_side_effects[0]?.description).toBe('已发送邮件');
  });

  it('想做"撤销删除"恒被拒：irreversible_side_effect，且不改任何状态', () => {
    const r = rig();
    r.sessions.createSession({ title: 'A', id: A, at: t(1) });
    r.ledger.record({ effect_id: 'e1', conversation_id: A, description: '已发送邮件', at: t(2) });
    const outcome = r.deletion.deleteSession(A, t(3));
    const undo = r.deletion.attemptUndoDeletion(outcome);
    expect(undo.ok).toBe(false);
    if (!undo.ok) expect(undo.code).toBe('irreversible_side_effect');
    // 状态零改动：会话仍是"已删"、账本仍保留那条记录
    expect(r.sessions.getSession(A)).toBeNull();
    expect(r.ledger.all()).toHaveLength(1);
  });
});

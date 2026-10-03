/**
 * `turn-model.ts`（CHAT-03）单元测试。
 *
 * 每个子项至少一条正向断言 + 一条**反向对照**（证明判据真的在起作用，而不是靠文案）。
 * 核心两条：
 * - 「同一条消息重试两次只产生一个任务」；
 * - 「中止回复 ≠ 取消任务」——中止后任务仍是 `running`，取消后任务才是 `cancelled`。
 */

import { describe, expect, it } from 'vitest';

import { asTaskId, type MessageId } from '../protocol/ids.js';
import { TurnModel, type SubmitUserMessageResult } from './turn-model.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 收下一条消息并返回已成功的分支（否则让用例直接炸掉）。 */
function expectSubmit(result: SubmitUserMessageResult): Extract<SubmitUserMessageResult, { ok: true }> {
  if (!result.ok) throw new Error(`预期提交成功，实际失败：${result.code} ${result.message}`);
  return result;
}

function expectOk<T>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string; readonly message: string },
): T {
  if (!result.ok) throw new Error(`预期成功，实际失败：${result.code} ${result.message}`);
  return result.value;
}

function expectFailure(
  result: unknown,
): { readonly ok: false; readonly code: string; readonly message: string } {
  if (typeof result !== 'object' || result === null || (result as { ok?: unknown }).ok !== false) {
    throw new Error(`预期失败，实际：${JSON.stringify(result)}`);
  }
  return result as { readonly ok: false; readonly code: string; readonly message: string };
}

const MODEL_ERROR = Object.freeze({ code: 'model_error', message: '模型调用超时', retryable: true });

/** 建一个"提交了一条消息"的模型，返回常用句柄。 */
function modelWithOneTurn(seed = 'turn-test') {
  const model = new TurnModel({ seed });
  const submitted = expectSubmit(model.submitUserMessage({ text: '写一份周报', client_id: 'c1' }));
  return { model, turnId: submitted.message.message_id, taskId: submitted.task.task_id };
}

// ---------------------------------------------------------------------------
// 稳定 ID / 顺序 + 幂等
// ---------------------------------------------------------------------------

describe('消息的稳定 ID 与顺序（CHAT-03）', () => {
  it('同一 client_id 同文本重发 ⇒ 同一条消息，不新建、不重复建任务', () => {
    const model = new TurnModel({ seed: 's' });
    const first = expectSubmit(model.submitUserMessage({ text: '写一份周报', client_id: 'c1' }));
    expect(first.duplicate).toBe(false);
    expect(first.task_created).toBe(true);
    expect(first.message.message_id).toBe('c1');
    expect(first.message.seq).toBe(1);
    expect(model.taskCount()).toBe(1);

    const again = expectSubmit(model.submitUserMessage({ text: '写一份周报', client_id: 'c1' }));
    expect(again.duplicate).toBe(true);
    expect(again.task_created).toBe(false);
    expect(again.message.message_id).toBe(first.message.message_id);
    expect(again.message.seq).toBe(first.message.seq);
    expect(model.taskCount()).toBe(1);
    expect(model.listMessages()).toHaveLength(1);
  });

  it('反向对照：同一 client_id 换正文 ⇒ idempotency_conflict，不覆盖既有消息', () => {
    const model = new TurnModel({ seed: 's' });
    expectSubmit(model.submitUserMessage({ text: '写一份周报', client_id: 'c1' }));
    const conflict = model.submitUserMessage({ text: '改成月报', client_id: 'c1' });
    expect(conflict.ok).toBe(false);
    expect(expectFailure(conflict).code).toBe('idempotency_conflict');
    // 既有正文一个字节没被改。
    expect(model.getMessage('c1' as MessageId)?.text).toBe('写一份周报');
    expect(model.taskCount()).toBe(1);
  });

  it('新消息 seq 单调递增，与到达顺序一致', () => {
    const model = new TurnModel({ seed: 's' });
    const a = expectSubmit(model.submitUserMessage({ text: '一', client_id: 'c1' }));
    const b = expectSubmit(model.submitUserMessage({ text: '二', client_id: 'c2' }));
    expect(a.message.seq).toBe(1);
    expect(b.message.seq).toBe(2);
    expect(model.listMessages().map((m) => m.seq)).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// 增量回复
// ---------------------------------------------------------------------------

describe('增量回复（CHAT-03）', () => {
  it('片段按顺序累加，message_id / seq 全程不变', () => {
    const { model, turnId } = modelWithOneTurn();
    const started = expectOk(model.beginReply(turnId));
    expect(started.role).toBe('assistant');
    expect(started.message_id).toBe('c1-assistant');
    expect(started.message_id).toBe(model.assistantMessageIdFor(turnId));
    expect(started.seq).toBe(2);

    expectOk(model.appendReplyChunk(turnId, '根据'));
    const second = expectOk(model.appendReplyChunk(turnId, '上周数据'));
    expect(second.chunks).toEqual(['根据', '上周数据']);
    expect(second.text).toBe('根据上周数据');
    expect(second.message_id).toBe(started.message_id);
    expect(second.seq).toBe(started.seq);

    const done = expectOk(model.completeReply(turnId));
    expect(done.state).toBe('completed');
    expect(model.getMessage(turnId)?.reply).toBe('completed');
  });

  it('反向对照：非 streaming 状态下追加片段被拒', () => {
    const { model, turnId } = modelWithOneTurn();
    expectOk(model.beginReply(turnId));
    expectOk(model.completeReply(turnId));
    const late = model.appendReplyChunk(turnId, '迟到的片段');
    expect(late.ok).toBe(false);
    expect(expectFailure(late).code).toBe('not_streaming');
  });
});

// ---------------------------------------------------------------------------
// 发送中 / 已接收 / 失败
// ---------------------------------------------------------------------------

describe('发送状态与失败（CHAT-03）', () => {
  it('sending → received 是两条不同记录，可重入', () => {
    const model = new TurnModel({ seed: 's' });
    const submitted = expectSubmit(
      model.submitUserMessage({ text: '写一份周报', client_id: 'c1', delivery: 'sending' }),
    );
    expect(submitted.message.state).toBe('sending');
    const turnId = submitted.message.message_id;

    const acked = expectOk(model.acknowledgeDelivery(turnId));
    expect(acked.state).toBe('received');
    // 幂等：再确认一次仍是 received。
    expect(expectOk(model.acknowledgeDelivery(turnId)).state).toBe('received');
    expect(model.getMessage(turnId)?.reply).toBe('idle');
  });

  it('失败后消息 state=failed 且带可重试错误；反向对照：失败态不能再被投递确认"洗白"', () => {
    const { model, turnId } = modelWithOneTurn();
    expectOk(model.beginReply(turnId));
    expectOk(model.failReply(turnId, MODEL_ERROR));

    const failed = model.getMessage(turnId);
    expect(failed?.state).toBe('failed');
    expect(failed?.reply).toBe('failed');
    expect(failed?.error?.retryable).toBe(true);
    expect(model.getMessage(model.assistantMessageIdFor(turnId))?.state).toBe('failed');

    const ack = model.acknowledgeDelivery(turnId);
    expect(ack.ok).toBe(false);
    expect(expectFailure(ack).code).toBe('not_pending_delivery');
  });
});

// ---------------------------------------------------------------------------
// 重试幂等 —— 核心断言
// ---------------------------------------------------------------------------

describe('重试不重复建任务（CHAT-03 核心）', () => {
  it('同一条消息重试两次只产生一个任务，且 message_id / seq 不变', () => {
    const { model, turnId, taskId } = modelWithOneTurn();
    expect(model.taskCount()).toBe(1);

    // 第一次：回复失败 → 重试。
    expectOk(model.beginReply(turnId));
    expectOk(model.failReply(turnId, MODEL_ERROR));
    const firstRetry = expectOk(model.retryMessage(turnId));
    expect(model.taskCount()).toBe(1);
    expect(firstRetry.message_id).toBe(turnId);
    expect(firstRetry.seq).toBe(1);
    expect(firstRetry.attempts).toBe(1);
    expect(firstRetry.task_id).toBe(taskId);

    // 第二次：再次失败 → 再重试。
    expectOk(model.beginReply(turnId));
    expectOk(model.failReply(turnId, MODEL_ERROR));
    const secondRetry = expectOk(model.retryMessage(turnId));
    expect(model.taskCount()).toBe(1); // ← 核心断言：两次重试后仍只有一个任务
    expect(secondRetry.message_id).toBe(turnId);
    expect(secondRetry.attempts).toBe(2);
    expect(model.listTasks()).toHaveLength(1);
    expect(model.listTasks()[0]?.task_id).toBe(taskId);
  });

  it('反向对照：在途（streaming）与已完成的消息不可重试', () => {
    const { model, turnId } = modelWithOneTurn();
    expectOk(model.beginReply(turnId));
    const inflight = model.retryMessage(turnId);
    expect(inflight.ok).toBe(false);
    expect(expectFailure(inflight).code).toBe('not_retryable');

    expectOk(model.completeReply(turnId));
    const done = model.retryMessage(turnId);
    expect(done.ok).toBe(false);
    expect(expectFailure(done).code).toBe('not_retryable');
  });

  it('重试后重新开始回复，助手消息 id / seq 稳定', () => {
    const { model, turnId } = modelWithOneTurn();
    expectOk(model.beginReply(turnId));
    expectOk(model.appendReplyChunk(turnId, '半截'));
    const assistantId = model.assistantMessageIdFor(turnId);
    const beforeSeq = model.getMessage(assistantId)?.seq;
    expectOk(model.failReply(turnId, MODEL_ERROR));
    expectOk(model.retryMessage(turnId));

    const restarted = expectOk(model.beginReply(turnId));
    expect(restarted.message_id).toBe(assistantId);
    expect(restarted.seq).toBe(beforeSeq); // seq 不因重试而漂移
    expect(restarted.chunks).toEqual([]); // 上一轮残片被清干净
  });
});

// ---------------------------------------------------------------------------
// 中止回复 ≠ 取消任务 —— 双轴状态
// ---------------------------------------------------------------------------

describe('中止回复与取消任务区分（CHAT-03）', () => {
  it('中止回复：reply=aborted，但任务状态仍是 running，且可重试', () => {
    const { model, turnId, taskId } = modelWithOneTurn();
    expectOk(model.beginReply(turnId));
    expectOk(model.appendReplyChunk(turnId, '部分内容'));

    const aborted = expectOk(model.abortReply(turnId));
    expect(aborted.kind).toBe('reply_aborted');
    expect(aborted.task_status).toBe('running'); // ← 任务没被取消
    expect(model.getTask(taskId)?.status).toBe('running');
    expect(model.getMessage(turnId)?.reply).toBe('aborted');
    expect(model.getMessage(model.assistantMessageIdFor(turnId))?.state).toBe('cancelled');

    // 中止后可重试，且不新建任务。
    expect(model.retryMessage(turnId).ok).toBe(true);
    expect(model.taskCount()).toBe(1);
  });

  it('取消任务：任务= cancelled，消息 reply=cancelled，且不可重试（与中止区分）', () => {
    const { model, turnId, taskId } = modelWithOneTurn();
    expectOk(model.beginReply(turnId));

    const cancelled = expectOk(model.cancelTask(taskId));
    expect(cancelled.kind).toBe('task_cancelled');
    expect(cancelled.aborted_replies).toBe(1);
    expect(model.getTask(taskId)?.status).toBe('cancelled');
    expect(model.getMessage(turnId)?.reply).toBe('cancelled');

    // 反向对照：取消后的轮次不可重试（中止后的可以）——两种语义状态不同。
    const retryAfterCancel = model.retryMessage(turnId);
    expect(retryAfterCancel.ok).toBe(false);
    expect(expectFailure(retryAfterCancel).code).toBe('task_cancelled');
  });

  it('反向对照：没有在生成的回复时不能"中止"；未知任务不能取消、终态不能重复取消', () => {
    const { model, turnId, taskId } = modelWithOneTurn();
    const noReply = model.abortReply(turnId);
    expect(noReply.ok).toBe(false);
    expect(expectFailure(noReply).code).toBe('no_active_reply');

    const unknown = model.cancelTask(asTaskId('nope'));
    expect(unknown.ok).toBe(false);
    expect(expectFailure(unknown).code).toBe('unknown_task');

    expectOk(model.beginReply(turnId));
    expect(model.cancelTask(taskId).ok).toBe(true);
    const again = model.cancelTask(taskId);
    expect(again.ok).toBe(false);
    expect(expectFailure(again).code).toBe('already_terminal');
  });

  it('反向对照：任务取消后不能把回复标成完成（不把取消洗成成功）', () => {
    const { model, turnId, taskId } = modelWithOneTurn();
    expectOk(model.beginReply(turnId));
    expect(model.cancelTask(taskId).ok).toBe(true);
    const complete = model.completeReply(turnId);
    expect(complete.ok).toBe(false);
    expect(expectFailure(complete).code).toBe('task_cancelled');
  });
});

// ---------------------------------------------------------------------------
// 断线续取
// ---------------------------------------------------------------------------

describe('断线续取（CHAT-03）', () => {
  it('只返回 seq 严格大于游标的事件；在途消息进入 pending', () => {
    const { model, turnId } = modelWithOneTurn();
    const cursor0 = model.cursor();

    // 游标之后产生了新事件。
    expectOk(model.beginReply(turnId));
    expectOk(model.appendReplyChunk(turnId, '增量'));

    const resumed = model.resume(cursor0);
    expect(resumed.events.length).toBeGreaterThan(0);
    expect(resumed.events.every((e) => e.seq > cursor0)).toBe(true);
    expect(resumed.events.map((e) => e.kind)).toContain('reply_chunk');
    expect(resumed.cursor).toBeGreaterThan(cursor0);
    // 助手消息在途 ⇒ 出现在 pending 里（客户端据此就地更新）。
    expect(resumed.pending.map((m) => m.message_id)).toContain('c1-assistant');
  });

  it('反向对照：游标取到头部后不重放已消费内容；非法游标抛错', () => {
    const { model, turnId } = modelWithOneTurn();
    expectOk(model.beginReply(turnId));
    expectOk(model.completeReply(turnId));

    const head = model.resume(model.cursor());
    expect(head.events).toHaveLength(0); // 严格大于 ⇒ 不重放

    expect(() => model.resume(-1)).toThrow(RangeError);
    expect(() => model.resume(1.5)).toThrow(RangeError);
  });

  it('续取的消息集合包含新建消息与在途消息（可原地更新）', () => {
    const { model, turnId } = modelWithOneTurn();
    const cursor = model.cursor();
    expectOk(model.beginReply(turnId));
    const resumed = model.resume(cursor);
    const ids = resumed.messages.map((m) => m.message_id);
    expect(ids).toContain('c1-assistant');
    // 不重复列出同一条消息。
    expect(new Set(ids).size).toBe(ids.length);
  });
});

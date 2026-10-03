/**
 * KRN-02 消息收件箱的正反例测试。
 *
 * 每条判据配反向对照：
 * ① 顺序：`saved → delivered → woken`；保存失败 ⇒ 既不投递也不唤醒；
 * ② 三张表分离：读回执 ≠ 工作承诺；
 * ③ 重复 messageId 不重复建工作、不改写首条；内容相同 id 不同分别保留；跨群不算重复；
 * ④ 唤醒失败不丢消息（留在待唤醒队列，可重试）。
 */

import { describe, expect, it } from 'vitest';
import {
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRequestId,
  asRevision,
  asRunId,
  asTaskId,
  type LogicalTime,
  type MessageId,
} from '../protocol/index.js';
import {
  acceptMessage,
  commitmentsOf,
  confirmWakeup,
  createEmptyInboxState,
  isDuplicateInInbox,
  markRead,
  outstandingWakeups,
  phaseOrderViolations,
  readWithoutWork,
  summarizeInbox,
  type InboxPhase,
  type InboxState,
  type StoredMessage,
} from './message-inbox.js';

const L = (n: number): LogicalTime => asLogicalTime(n);
const TASK = asTaskId('task-1');
const GROUP_A = asGroupId('group-a');
const GROUP_B = asGroupId('group-b');
const SENDER = asInstanceId('inst-sender');
const RECEIVER = asInstanceId('inst-receiver');

function messageOf(overrides: Partial<StoredMessage> & { message_id: MessageId }): StoredMessage {
  return Object.freeze({
    message_id: overrides.message_id,
    group_id: overrides.group_id ?? GROUP_A,
    task_id: overrides.task_id ?? TASK,
    task_revision: overrides.task_revision ?? asRevision(1),
    sender_instance_id: overrides.sender_instance_id ?? SENDER,
    recipient_instance_id: overrides.recipient_instance_id ?? RECEIVER,
    request_id: overrides.request_id ?? null,
    requires_wakeup: overrides.requires_wakeup ?? true,
    body: overrides.body ?? '正文',
    created_at: overrides.created_at ?? L(0),
  });
}

describe('KRN-02 判据①：先可靠保存，再投递 / 唤醒', () => {
  it('正常路径阶段顺序严格为 saved → delivered → woken', () => {
    const calls: InboxPhase[] = [];
    const outcome = acceptMessage(
      createEmptyInboxState(),
      { message: messageOf({ message_id: asMessageId('m-1') }), at: L(1) },
      {
        onSaved: () => calls.push('saved'),
        onDelivered: () => calls.push('delivered'),
        onWakeup: () => calls.push('woken'),
      },
    );

    expect(calls).toEqual(['saved', 'delivered', 'woken']);
    expect(outcome.phases).toEqual(['saved', 'delivered', 'woken']);
    expect(outcome.result).toBe('accepted');
    expect(outcome.delivered).toBe(true);
    expect(outcome.woken).toBe(true);
    expect(phaseOrderViolations(outcome.state)).toHaveLength(0);
    const log = outcome.state.phase_log.map((entry) => entry.phase);
    expect(log).toEqual(['saved', 'delivered', 'woken']);
    // 全局序号严格递增 ⇒ 顺序不是靠"同一条消息的数组位置"猜的
    expect(outcome.state.phase_log.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
  });

  it('反向对照：保存失败 ⇒ 消息未保存，且**从未尝试**投递或唤醒', () => {
    let deliveredAttempts = 0;
    let wakeupAttempts = 0;
    expect(() =>
      acceptMessage(
        createEmptyInboxState(),
        { message: messageOf({ message_id: asMessageId('m-boom') }), at: L(1) },
        {
          onSaved: () => {
            throw new Error('持久化失败');
          },
          onDelivered: () => {
            deliveredAttempts += 1;
          },
          onWakeup: () => {
            wakeupAttempts += 1;
          },
        },
      ),
    ).toThrowError(/持久化失败/);

    // 保存没成功，投递/唤醒一次也不该发生
    expect(deliveredAttempts).toBe(0);
    expect(wakeupAttempts).toBe(0);
  });

  it('需要唤醒时若唤醒失败：消息仍已保存并留在待唤醒队列（可重试）', () => {
    const first = acceptMessage(
      createEmptyInboxState(),
      { message: messageOf({ message_id: asMessageId('m-2') }), at: L(1) },
      {
        onWakeup: () => {
          throw new Error('唤醒通道不可用');
        },
      },
    );
    expect(first.result).toBe('accepted');
    expect(first.delivered).toBe(true);
    expect(first.woken).toBe(false);
    expect(first.state.messages[Object.keys(first.state.messages)[0]!]).toBeDefined();
    expect(outstandingWakeups(first.state)).toEqual([asMessageId('m-2')]);
    expect(summarizeInbox(first.state).phase_order_violations).toHaveLength(0);

    // 重试：确认唤醒后队列清空，并补记 woken 阶段
    const retried = confirmWakeup(first.state, asMessageId('m-2'), L(2));
    expect(outstandingWakeups(retried)).toEqual([]);
    expect(retried.phase_log[retried.phase_log.length - 1]?.phase).toBe('woken');
  });

  it('反向对照：唤醒成功的消息**不在**待唤醒队列（不是"永远都排队"）', () => {
    const outcome = acceptMessage(createEmptyInboxState(), {
      message: messageOf({ message_id: asMessageId('m-3') }),
      at: L(1),
    });
    expect(outcome.woken).toBe(true);
    expect(outstandingWakeups(outcome.state)).toEqual([]);
  });
});

describe('KRN-02 判据②：收件箱 / 读回执 / 工作承诺是三张表', () => {
  it('已读不建工作承诺；工作承诺不依赖已读', () => {
    const accepted = acceptMessage(createEmptyInboxState(), {
      message: messageOf({ message_id: asMessageId('m-4'), request_id: null }),
      at: L(1),
    });
    const read = markRead(accepted.state, {
      group_id: GROUP_A,
      message_id: asMessageId('m-4'),
      instance_id: RECEIVER,
      run_id: asRunId('run-1'),
      at: L(2),
    });
    expect(read.read_receipts).toHaveLength(1);
    expect(read.commitments).toHaveLength(0); // 读了 ≠ 建了工作
    expect(readWithoutWork(read, RECEIVER)).toEqual([asMessageId('m-4')]);
  });

  it('带 request_id 的消息建立工作承诺；读回执表仍独立', () => {
    const accepted = acceptMessage(createEmptyInboxState(), {
      message: messageOf({ message_id: asMessageId('m-5'), request_id: asRequestId('req-1') }),
      at: L(1),
    });
    expect(accepted.work_commitment?.request_id).toBe(asRequestId('req-1'));
    expect(accepted.state.commitments).toHaveLength(1);
    expect(accepted.state.read_receipts).toHaveLength(0); // 建了工作 ≠ 读了
    expect(commitmentsOf(accepted.state, RECEIVER)).toHaveLength(1);
    expect(readWithoutWork(accepted.state, RECEIVER)).toEqual([]);
  });

  it('反向对照：对未保存的消息写读回执被拒（不得凭空"已读"）', () => {
    expect(() =>
      markRead(createEmptyInboxState(), {
        group_id: GROUP_A,
        message_id: asMessageId('nope'),
        instance_id: RECEIVER,
        run_id: asRunId('run-1'),
        at: L(1),
      }),
    ).toThrowError(/未保存/);
  });
});

describe('KRN-02 判据③：重复 messageId 不重复建工作', () => {
  it('同群重复送达：不新建工作、不加收件箱条目、首条内容不被改写', () => {
    const first = acceptMessage(createEmptyInboxState(), {
      message: messageOf({ message_id: asMessageId('m-6'), request_id: asRequestId('req-6'), body: '首条正文' }),
      at: L(1),
    });
    const second = acceptMessage(first.state, {
      message: messageOf({
        message_id: asMessageId('m-6'),
        request_id: asRequestId('req-6'),
        body: '被改写过的正文',
      }),
      at: L(2),
    });

    expect(second.result).toBe('duplicate_not_created');
    expect(second.duplicate_of).toBe(asMessageId('m-6'));
    expect(second.work_commitment).toBeNull();
    expect(second.state.commitments).toHaveLength(1); // 工作没有翻倍
    expect(Object.keys(second.state.entries)).toHaveLength(1);
    expect(second.phases).toEqual([]); // 重复送达不产生任何阶段
    expect(second.content_conflict).toBe(true); // 内容冲突被如实标出

    const stored = second.state.messages[Object.keys(second.state.messages)[0]!];
    expect(stored?.body).toBe('首条正文'); // 首条内容未被覆盖（D-1）
  });

  it('反向对照：内容相同但 id 不同 ⇒ 分别保留（绝不按内容去重，Q3-c）', () => {
    const first = acceptMessage(createEmptyInboxState(), {
      message: messageOf({ message_id: asMessageId('m-7a'), request_id: asRequestId('req-7a'), body: '同样的话' }),
      at: L(1),
    });
    const second = acceptMessage(first.state, {
      message: messageOf({ message_id: asMessageId('m-7b'), request_id: asRequestId('req-7b'), body: '同样的话' }),
      at: L(2),
    });

    expect(second.result).toBe('accepted');
    expect(second.content_conflict).toBe(false);
    expect(summarizeInbox(second.state).message_count).toBe(2);
    expect(summarizeInbox(second.state).work_commitment_count).toBe(2);
  });

  it('反向对照：同一 id 在**另一个群**不是重复（群内唯一，Q1-d / Q3-b）', () => {
    const first = acceptMessage(createEmptyInboxState(), {
      message: messageOf({ message_id: asMessageId('m-8'), group_id: GROUP_A }),
      at: L(1),
    });
    const other = acceptMessage(first.state, {
      message: messageOf({ message_id: asMessageId('m-8'), group_id: GROUP_B }),
      at: L(2),
    });
    expect(other.result).toBe('accepted');
    expect(summarizeInbox(other.state).message_count).toBe(2);
    expect(isDuplicateInInbox(other.state, GROUP_A, asMessageId('m-8'))).toBe(true);
    expect(isDuplicateInInbox(other.state, GROUP_B, asMessageId('m-8'))).toBe(true);
  });
});

describe('KRN-02 顺序自检本身可被判红（反向对照）', () => {
  it('人为构造"woken 先于 saved"的状态 ⇒ phaseOrderViolations 非空', () => {
    const malformed: InboxState = Object.freeze({
      ...createEmptyInboxState(),
      phase_log: Object.freeze([
        { message_id: asMessageId('m-x'), sequence: 1, phase: 'woken' as const, at: L(1) },
        { message_id: asMessageId('m-x'), sequence: 2, phase: 'saved' as const, at: L(2) },
      ]),
    });
    expect(phaseOrderViolations(malformed)).toHaveLength(1);
    expect(phaseOrderViolations(malformed)[0]).toMatch(/woken 先于 saved/);
  });
});

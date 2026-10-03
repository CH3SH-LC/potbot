import { describe, expect, it } from 'vitest';

import {
  asEventId,
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asTaskId,
  createDeliveryEvent,
  createIdSource,
  createKernelEvent,
  markEventDelivered,
  undelivered,
  ValidationError,
  type PendingEvent,
} from './index.js';

const TASK = asTaskId('T1');
const GROUP = asGroupId('G1');
const C = asInstanceId('C');
const ids = createIdSource({ seed: 'rec' });
const T = (n: number) => asLogicalTime(n);

function pending(reason = 'r'): PendingEvent {
  return createDeliveryEvent(
    {
      kind: 'wakeup_queued',
      task_id: TASK,
      group_id: GROUP,
      instance_id: C,
      created_at: T(0),
      reason,
    },
    ids,
  );
}

describe('待投递事件（outbox 记录）', () => {
  it('默认未投递；允许注入固定 event_id（确定性场景）', () => {
    const event = pending();
    expect(event.delivered).toBe(false);
    expect(event.delivered_at).toBeNull();
    expect(event.payload).toEqual({});

    const injected = createDeliveryEvent(
      {
        kind: 'run_requested',
        task_id: TASK,
        group_id: GROUP,
        instance_id: C,
        created_at: T(0),
        reason: '注入 id',
        event_id: asEventId('fixed-1'),
      },
      ids,
    );
    expect(injected.event_id).toBe(asEventId('fixed-1'));
  });

  it('未知事件种类被拒绝', () => {
    expect(() =>
      createDeliveryEvent(
        {
          kind: 'not_a_kind' as never,
          task_id: TASK,
          group_id: GROUP,
          instance_id: C,
          created_at: T(0),
          reason: 'x',
        },
        ids,
      ),
    ).toThrow(ValidationError);
  });

  it('markEventDelivered 幂等：已投递的事件原样返回', () => {
    const event = pending();
    const delivered = markEventDelivered(event, T(7));
    expect(delivered.delivered).toBe(true);
    expect(delivered.delivered_at).toBe(T(7));
    expect(markEventDelivered(delivered, T(9))).toBe(delivered); // 不重复改写投递时间
  });

  it('undelivered 只滤出未投递者（存储层 pendingDeliveryEvents 的唯一实现）', () => {
    const first = pending('第一条');
    const second = markEventDelivered(pending('第二条'), T(1));
    const remaining = undelivered([first, second]);
    expect(remaining.map((event) => event.reason)).toEqual(['第一条']);
  });
});

describe('观测事件记录（KernelEvent）', () => {
  it('缺省字段一律为 null；data 缺省为空对象', () => {
    const event = createKernelEvent({ kind: 'diagnosis_performed', at: T(3) }, ids);
    expect(event.task_id).toBeNull();
    expect(event.run_id).toBeNull();
    expect(event.rejection_reason).toBeNull();
    expect(event.data).toEqual({});
  });

  it('未知事件种类被拒绝（事件种类是封闭枚举）', () => {
    expect(() => createKernelEvent({ kind: 'nope' as never, at: T(0) }, ids)).toThrow(ValidationError);
  });

  it('携带 id 字段与拒绝原因（P7 证据）', () => {
    const event = createKernelEvent(
      {
        kind: 'publication_rejected',
        at: T(5),
        rejection_reason: 'lease_expired',
        run_id: null,
        instance_id: C,
      },
      ids,
    );
    expect(event.rejection_reason).toBe('lease_expired');
    expect(event.instance_id).toBe(C);
  });
});

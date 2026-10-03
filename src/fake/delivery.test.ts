import { describe, expect, it } from 'vitest';

import {
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRequestId,
  asRevision,
  asTaskId,
} from '../protocol/index.js';
import {
  DeliveryLog,
  FakeAgentScriptError,
  artifactRefFor,
  createDeliveryRequest,
  defaultRequiresWakeup,
  kernelSenderBinder,
  makeDeliveryReceipt,
  rejectingSenderBinder,
} from './index.js';

const TASK = asTaskId('T1');
const GROUP = asGroupId('G1');
const REV1 = asRevision(1);
const C = asInstanceId('C');
const S1 = asInstanceId('S1');
const T = (n: number) => asLogicalTime(n);

function request(overrides: Partial<Parameters<typeof createDeliveryRequest>[0]> = {}) {
  return createDeliveryRequest({
    task_id: TASK,
    group_id: GROUP,
    task_revision: REV1,
    message_id: asMessageId('m-a02-01'),
    sender_instance_id: S1,
    recipient_instance_id: C,
    type: 'work_request',
    content: '请 C 独立完成工作 j1，期望产物 p1',
    request_id: asRequestId('r-a02-01'),
    at: T(0),
    ...overrides,
  });
}

describe('投递请求构造（验收规格 0.3 第 1 条）', () => {
  it('用 D01 的 createMessage 构造，发送者经 SenderBinder 绑定', () => {
    const built = request();
    expect(built.message.message_id).toBe('m-a02-01');
    expect(built.message.sender_instance_id).toBe('S1');
    expect(built.message.recipient_instance_id).toBe('C');
    expect(built.message.type).toBe('work_request');
    expect(built.message.request_id).toBe('r-a02-01');
    expect(built.message.requires_wakeup).toBe(true);
    expect(built.message.created_at).toBe(0);
    // 内容语义可靠落进 payload（＋ 指纹可对照）
    expect(built.message.payload).toEqual({ content: '请 C 独立完成工作 j1，期望产物 p1' });
    expect(built.content_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('message_id 由测试直接注入并原样采用（Q3-a / A04 依赖）', () => {
    const built = request({ message_id: asMessageId('固定-id-甲') });
    expect(built.message.message_id).toBe('固定-id-甲');
    const again = request({ message_id: asMessageId('固定-id-甲') });
    expect(again.message.message_id).toBe(built.message.message_id);
  });

  it('内容指纹能证明两条消息「逐字相同」、并能区分不同内容（A04-C 的自证）', () => {
    const a = request();
    const b = request({ message_id: asMessageId('m-a04-02'), request_id: asRequestId('r-a04-02') });
    const c = request({ content: '换了内容' });
    expect(a.content_fingerprint).toBe(b.content_fingerprint);
    expect(a.content_fingerprint).not.toBe(c.content_fingerprint);
  });

  it('R2：requires_wakeup 默认按消息类型推导，且落库消息上恒为显式布尔值', () => {
    // stage_result（公共进度）默认 false —— A03「公共进度不触发多余轮次」的依据
    expect(defaultRequiresWakeup('stage_result')).toBe(false);
    const stage = request({ type: 'stage_result' });
    expect(stage.requires_wakeup).toBe(false);
    expect(stage.message.requires_wakeup).toBe(false);
    expect(stage.message.requires_wakeup).toBeTypeOf('boolean');

    // 其余消息类型默认 true
    for (const type of [
      'work_request',
      'work_result',
      'blocked_report',
      'cancel',
      'requirement_update',
      'capability_missing',
      'user_input_request',
    ] as const) {
      expect(defaultRequiresWakeup(type)).toBe(true);
      expect(request({ type }).message.requires_wakeup).toBe(true);
    }
  });

  it('R2：显式给出的 requires_wakeup 覆盖类型默认（反例构造用）', () => {
    expect(request({ requires_wakeup: false }).message.requires_wakeup).toBe(false);
    expect(request({ type: 'stage_result', requires_wakeup: true }).message.requires_wakeup).toBe(true);
  });

  it('拒绝式发送者绑定器使构造失败（P8 负向的接缝）', () => {
    expect(() => request({ sender_instance_id: S1 })).not.toThrow();
    expect(() =>
      createDeliveryRequest(
        {
          task_id: TASK,
          group_id: GROUP,
          task_revision: REV1,
          message_id: asMessageId('m-forged'),
          sender_instance_id: S1,
          recipient_instance_id: C,
          type: 'work_request',
          content: '伪造来源',
        },
        { binder: rejectingSenderBinder },
      ),
    ).toThrow(FakeAgentScriptError);
  });

  it('缺少接收实例身份 → protocol 层拒绝（Q1-c：不得以能力名代替实例身份）', () => {
    expect(() =>
      createDeliveryRequest({
        task_id: TASK,
        group_id: GROUP,
        task_revision: REV1,
        message_id: asMessageId('m-x'),
        sender_instance_id: S1,
        recipient_instance_id: undefined as never,
        type: 'work_request',
        content: 'x',
      }),
    ).toThrow(/recipient_instance_id/);
  });

  it('默认绑定器就是内核绑定入口（可直接使用）', () => {
    const binding = kernelSenderBinder.bind(S1, { group_id: GROUP, task_id: TASK });
    expect(binding.sender_instance_id).toBe('S1');
    expect(binding.group_id).toBe('G1');
    expect(binding.task_id).toBe('T1');
  });

  it('产物引用确定且可追溯', () => {
    expect(artifactRefFor(asRequestId('r-1'))).toBe('r-1#result');
  });
});

describe('DeliveryLog：投递回执与守恒断言的三件套', () => {
  it('按投递顺序记录 message_id / request_id / 三值结果', () => {
    const log = new DeliveryLog();
    const first = request();
    log.record(makeDeliveryReceipt(first, 'accepted', { step: T(0), advance_seq: 0 }));
    log.record(makeDeliveryReceipt(first, 'duplicate_not_created', { step: T(1), advance_seq: 0 }));
    const other = request({ message_id: asMessageId('m-a04-02'), request_id: asRequestId('r-a04-02') });
    log.record(makeDeliveryReceipt(other, 'accepted', { step: T(2), advance_seq: 1 }));

    expect(log.messageIdsInOrder()).toEqual(['m-a02-01', 'm-a02-01', 'm-a04-02']);
    expect(log.requestIdsInOrder()).toEqual(['r-a02-01', 'r-a02-01', 'r-a04-02']);
    expect(log.receiptsFor(asMessageId('m-a02-01'))).toHaveLength(2);
    expect(log.snapshot()).toMatchObject({
      total: 3,
      accepted: 2,
      duplicate_not_created: 1,
      failed: 0,
    });
  });

  it('失败结果单独计数（A04-04：不得有 `失败`）', () => {
    const log = new DeliveryLog();
    log.record(makeDeliveryReceipt(request(), 'failed', { step: T(0), advance_seq: 0 }));
    expect(log.snapshot()).toMatchObject({ failed: 1, accepted: 0, duplicate_not_created: 0 });
  });

  it('无 request_id 的消息不污染请求 id 列表', () => {
    const log = new DeliveryLog();
    const built = createDeliveryRequest({
      task_id: TASK,
      group_id: GROUP,
      task_revision: REV1,
      message_id: asMessageId('m-notice'),
      sender_instance_id: S1,
      recipient_instance_id: C,
      type: 'capability_missing',
      content: '无匹配能力',
    });
    log.record(makeDeliveryReceipt(built, 'accepted', { step: T(0), advance_seq: 0 }));
    expect(built.request_id).toBeNull();
    expect(log.requestIdsInOrder()).toEqual([]);
    expect(log.snapshot().message_ids_in_order).toEqual(['m-notice']);
  });
});

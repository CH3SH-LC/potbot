import { describe, expect, it } from 'vitest';

import {
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRunId,
  summarizeKernelEvents,
  ValidationError,
  type KernelEvent,
} from '../protocol/index.js';
import { EventRecorder, EventRecorderError } from './index.js';
import { canonicalJson } from './digest.js';

const t = (value: number) => asLogicalTime(value);
const instance = asInstanceId('C');
const run1 = asRunId('run-1');

describe('canonicalJson：键序稳定', () => {
  it('对象键按字典序输出，与字面量书写顺序无关', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it('数组保序，嵌套对象同样规范化', () => {
    expect(canonicalJson([{ z: 1, a: [{ y: 2, x: 3 }] }])).toBe('[{"a":[{"x":3,"y":2}],"z":1}]');
  });

  it('undefined 键被丢弃、数组中的 undefined 记为 null', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('非有限数与不可序列化类型显式抛错', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => canonicalJson(() => 0)).toThrow();
    expect(() => canonicalJson({ deep: [{ x: Number.NaN }] })).toThrow(/\$\.deep\[0\]\.x/);
  });
});

describe('EventRecorder：KernelEvent 的落点', () => {
  it('record() 用 createKernelEvent 构造，事件 id 按种子确定性分配', () => {
    const recorder = new EventRecorder({ scenario: 'A02', seed: 'fixed-order' });
    const first = recorder.record({ kind: 'message_accepted', at: t(0), instance_id: instance });
    const second = recorder.record({ kind: 'run_started', at: t(1), instance_id: instance });
    expect(first.event_id).toBe('fixed-order/evt-1');
    expect(second.event_id).toBe('fixed-order/evt-2');
    expect(first.kind).toBe('message_accepted');
    expect(first.at).toBe(0);
    expect(first.message_id).toBeNull();
    expect(second.instance_id).toBe('C');
    expect(recorder.size).toBe(2);
  });

  it('未给种子时事件 id 仍然确定（`evt-N`）', () => {
    const recorder = new EventRecorder();
    expect(recorder.record({ kind: 'run_started', at: t(0) }).event_id).toBe('evt-1');
  });

  it('按种类过滤与计数（计数类断言的来源）', () => {
    const recorder = new EventRecorder({ seed: 's' });
    recorder.record({ kind: 'delegation_queue_enqueued', at: t(0), instance_id: instance });
    recorder.record({ kind: 'run_started', at: t(1), instance_id: instance });
    recorder.record({ kind: 'delegation_queue_enqueued', at: t(2), instance_id: instance });
    expect(recorder.countOf('delegation_queue_enqueued')).toBe(2);
    expect(recorder.countOf('run_started')).toBe(1);
    expect(recorder.countOf('run_finished')).toBe(0);
    expect(recorder.byKind('delegation_queue_enqueued').map((event) => event.at)).toEqual([0, 2]);
  });

  it('counters() 直接给合同 Q10-a 的计数口径（复用 D01 的 summarizeKernelEvents）', () => {
    const recorder = new EventRecorder({ seed: 's' });
    recorder.record({ kind: 'run_started', at: t(0), instance_id: instance, run_id: run1 });
    recorder.record({ kind: 'run_finished', at: t(4), instance_id: instance, run_id: run1 });
    recorder.record({
      kind: 'publication_rejected',
      at: t(5),
      instance_id: instance,
      run_id: run1,
      rejection_reason: 'lease_expired',
    });
    recorder.record({ kind: 'diagnosis_performed', at: t(6), instance_id: instance });
    const counters = recorder.counters();
    // run_count 不含被拒绝的发布尝试；被拒次数单列。
    expect(counters.run_count).toBe(1);
    expect(counters.rejected_publication_count).toBe(1);
    expect(counters.diagnosis_count).toBe(1);
  });

  it('非法事件在**发生点**抛错：非法种类 / 不可序列化数据', () => {
    const recorder = new EventRecorder({ seed: 's' });
    expect(() => recorder.record({ kind: 'not_a_kind' as never, at: t(0) })).toThrow(ValidationError);
    expect(() => recorder.record({ kind: 'run_started', at: Number.NaN as never })).toThrow();
    expect(() =>
      recorder.record({ kind: 'run_started', at: t(0), data: { bad: Number.NaN } }),
    ).toThrow();
    expect(recorder.size).toBe(0);
  });

  it('subscribe 让生产路径的事件同时驱动订阅者（采样器的接入点）', () => {
    const recorder = new EventRecorder({ seed: 's' });
    const seen: KernelEvent[] = [];
    const unsubscribe = recorder.subscribe((event) => seen.push(event));
    recorder.record({ kind: 'run_started', at: t(0), instance_id: instance, run_id: run1 });
    expect(seen.map((event) => event.kind)).toEqual(['run_started']);
    unsubscribe();
    recorder.record({ kind: 'run_finished', at: t(1), instance_id: instance, run_id: run1 });
    expect(seen).toHaveLength(1);
  });

  it('计数口径交给 protocol 的 summarizeKernelEvents（R4：D06 不自算峰值）', () => {
    const recorder = new EventRecorder({ seed: 's' });
    recorder.record({ kind: 'run_started', at: t(0), instance_id: instance, run_id: run1 });
    recorder.record({ kind: 'run_finished', at: t(9), instance_id: instance, run_id: run1 });
    // 唯一权威实现：把记录器缓冲的事件流原样喂给它，结果必须逐字一致。
    expect(recorder.counters()).toEqual(summarizeKernelEvents(recorder.events));
    expect(recorder.counters().run_count).toBe(1);
  });

  it('reset 只清事件、保留元信息与订阅', () => {
    const recorder = new EventRecorder({ scenario: 'A02', seed: 'fixed-order' });
    let calls = 0;
    recorder.subscribe(() => {
      calls += 1;
    });
    recorder.record({ kind: 'run_started', at: t(0), instance_id: instance });
    recorder.reset();
    recorder.record({ kind: 'run_started', at: t(0), instance_id: instance });
    expect(recorder.size).toBe(1);
    expect(calls).toBe(2);
    expect(recorder.meta.scenario).toBe('A02');
    // 事件 id 不因 reset 而重号（同一记录器内保持唯一）。
    expect(recorder.events[0]?.event_id).toBe('fixed-order/evt-2');
  });
});

describe('EventRecorder：可追踪证据与逐字节可复现', () => {
  const feed = (recorder: EventRecorder, reversedKeys: boolean): void => {
    recorder.record({
      kind: 'message_accepted',
      at: t(0),
      instance_id: instance,
      message_id: asMessageId('m-1'),
      data: reversedKeys
        ? { sender: 'S1', recipient: 'C' }
        : { recipient: 'C', sender: 'S1' },
    });
    recorder.record({
      kind: 'run_started',
      at: t(1),
      instance_id: instance,
      run_id: run1,
      data: { snapshot: ['m-1'] },
    });
    recorder.record({ kind: 'run_finished', at: t(4), instance_id: instance, run_id: run1 });
  };

  it('相同语义、不同键序 → 逐字节相同的 JSONL', () => {
    const a = new EventRecorder({ scenario: 'S', seed: 'fixed-order' });
    const b = new EventRecorder({ scenario: 'S', seed: 'fixed-order' });
    feed(a, false);
    feed(b, true);
    expect(a.toJSONL()).toBe(b.toJSONL());
    expect(a.digest()).toBe(b.digest());
  });

  it('不同种子 → 不同事件 id → 不同字节（种子真的进入了证据）', () => {
    const a = new EventRecorder({ seed: 'seed-a' });
    const b = new EventRecorder({ seed: 'seed-b' });
    feed(a, false);
    feed(b, false);
    expect(a.toJSONL()).not.toBe(b.toJSONL());
  });

  it('JSONL 一行一事件；toJSON 含元信息、汇总与计数口径', () => {
    const recorder = new EventRecorder({ scenario: 'A02', seed: 'fixed-order', revision: 'wip' });
    feed(recorder, false);
    const lines = recorder.toJSONL().split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(recorder.toJSON())).toMatchObject({
      meta: { scenario: 'A02', seed: 'fixed-order', revision: 'wip' },
      summary: {
        total: 3,
        byKind: { message_accepted: 1, run_finished: 1, run_started: 1 },
        counters: { run_count: 1, rejected_publication_count: 0 },
      },
    });
  });

  it('summary 含首末逻辑时间与内容摘要', () => {
    const recorder = new EventRecorder({ seed: 's' });
    feed(recorder, false);
    const summary = recorder.summary();
    expect(summary.firstAt).toBe(0);
    expect(summary.lastAt).toBe(4);
    expect(summary.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('事件序列里不含墙钟时间戳（否则必然不可逐字节复现）', () => {
    const recorder = new EventRecorder({ seed: 's' });
    feed(recorder, false);
    const text = recorder.toJSONL();
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(text).not.toMatch(/timestamp|wallClock|recordedAt/i);
  });

  it('空记录器的摘要与输出是确定的', () => {
    const recorder = new EventRecorder();
    expect(recorder.toJSONL()).toBe('');
    const summary = recorder.summary();
    expect(summary.total).toBe(0);
    expect(summary.firstAt).toBeNull();
    expect(summary.lastAt).toBeNull();
    expect(summary.counters.run_count).toBe(0);
  });

  it('订阅者必须是函数', () => {
    const recorder = new EventRecorder();
    expect(() => recorder.subscribe(undefined as never)).toThrow(EventRecorderError);
  });
});

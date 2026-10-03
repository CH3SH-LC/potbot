/**
 * 事实快照装配（design-02 P3）单测。
 *
 * 覆盖：可用表只装已知值；unknown / not_applicable / 未登记键分别进不可用表且 kind 正确；
 * 取代链取新值而旧值仍可查；版本高于所查版本不算当前；单一来源被破坏时按 W-B 判据抛错；
 * “缺失不当零”——未知事实在可用表里不存在、且整张快照没有任何值为 0 的条目。
 */

import { describe, expect, it } from 'vitest';

import {
  asFactRef,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asTaskId,
  createSharedFactRecord,
  factsByKey,
  type SharedFactRecord,
  type SharedFactRecordInput,
} from '../protocol/index.js';

import {
  buildFactSnapshot,
  describeUnusableFacts,
  isFactSnapshotUsable,
  UNUSABLE_FACT_KINDS,
  type FactSnapshotInput,
} from './index.js';

const TASK = asTaskId('T1');
const OTHER_TASK = asTaskId('T2');
const INSTANCE = asInstanceId('I-A');
const R2 = asRevision(2);
const R3 = asRevision(3);
const T0 = asLogicalTime(0);
const T1 = asLogicalTime(1);

function fact(overrides: Record<string, unknown> = {}): SharedFactRecord {
  const base: SharedFactRecordInput = {
    fact_id: asFactRef('fact-1'),
    task_id: TASK,
    task_revision: R2,
    fact_key: 'headcount',
    value: { kind: 'known', value: { type: 'number', amount: 8, unit: '人', currency: null } },
    source: { kind: 'user_confirmation', detail: '用户在会话中确认' },
    confirmed_by: INSTANCE,
    confirmed_at: T0,
  };
  return createSharedFactRecord({ ...base, ...overrides } as SharedFactRecordInput);
}

function snapshotOf(
  facts: readonly SharedFactRecord[],
  factKeys: readonly string[],
  taskRevision = R2,
): ReturnType<typeof buildFactSnapshot> {
  const input: FactSnapshotInput = {
    facts,
    task_id: TASK,
    task_revision: taskRevision,
    fact_keys: factKeys,
  };
  return buildFactSnapshot(input);
}

describe('不可用种类封闭枚举', () => {
  it('恰为 unknown / not_applicable / missing', () => {
    expect([...UNUSABLE_FACT_KINDS]).toEqual(['unknown', 'not_applicable', 'missing']);
  });
});

describe('可用表只装已知值；不可用表按 kind 分类', () => {
  const head = fact({
    fact_id: asFactRef('fact-h'),
    fact_key: 'headcount',
    value: { kind: 'known', value: { type: 'number', amount: 10, unit: '人', currency: null } },
  });
  const date = fact({
    fact_id: asFactRef('fact-d'),
    fact_key: 'event.date',
    value: { kind: 'known', value: { type: 'date', iso_date: '2026-10-02', time_zone: 'Asia/Shanghai' } },
  });
  const budget = fact({
    fact_id: asFactRef('fact-b'),
    fact_key: 'budget.total',
    value: { kind: 'unknown', reason: '预算尚未确定' },
  });
  const venue = fact({
    fact_id: asFactRef('fact-v'),
    fact_key: 'venue',
    value: { kind: 'not_applicable', reason: '本任务不涉及场地' },
  });
  const snapshot = snapshotOf(
    [head, date, budget, venue],
    ['headcount', 'budget.total', 'event.date', 'venue', 'guest.count'],
  );

  it('已知事实进可用表；unknown / not_applicable / 未登记键分别进不可用表且 kind 正确', () => {
    expect(snapshot.usable.map((entry) => entry.fact_key)).toEqual(['headcount', 'event.date']);
    expect(snapshot.unusable.map((entry) => [entry.fact_key, entry.kind])).toEqual([
      ['budget.total', 'unknown'],
      ['venue', 'not_applicable'],
      ['guest.count', 'missing'],
    ]);
  });

  it('可用条目的形状即 KnownFactSnapshotEntry（fact_ref / fact_key / value / source）', () => {
    expect(snapshot.usable[0]).toEqual({
      fact_ref: 'fact-h',
      fact_key: 'headcount',
      value: { type: 'number', amount: 10, unit: '人', currency: null },
      source: { kind: 'user_confirmation', detail: '用户在会话中确认' },
    });
    expect(snapshot.usable[1]?.value).toEqual({
      type: 'date',
      iso_date: '2026-10-02',
      time_zone: 'Asia/Shanghai',
    });
  });

  it('未知 / 缺失的原因来自事实本身；未登记键没有伪造 fact_ref', () => {
    expect(snapshot.unusable[0]?.reason).toBe('预算尚未确定');
    expect(snapshot.unusable[1]?.reason).toBe('本任务不涉及场地');
    expect(snapshot.unusable[2]?.fact_ref).toBeNull();
    expect(snapshot.unusable[2]?.reason).toMatch(/没有登记的当前事实/);
  });

  it('整张快照没有任何值为 0 的条目，不可用条目也不带值载荷', () => {
    for (const entry of snapshot.usable) {
      const looksLikeZero = entry.value.type === 'number' && entry.value.amount === 0;
      expect(looksLikeZero).toBe(false);
    }
    for (const entry of snapshot.unusable) {
      expect('value' in entry).toBe(false);
    }
  });

  it('不可用表非空 ⇒ 不可用；并给出可读的 missing_fact 依据', () => {
    expect(isFactSnapshotUsable(snapshot)).toBe(false);
    expect(describeUnusableFacts(snapshot)).toMatch(/guest\.count \[missing\]/);
    expect(describeUnusableFacts(snapshot)).toMatch(/budget\.total \[unknown\]/);
  });
});

describe('取代链：快照取新事实，旧事实仍可查（历史可追）', () => {
  const oldFact = fact({
    fact_id: asFactRef('fact-old'),
    fact_key: 'headcount',
    value: { kind: 'known', value: { type: 'number', amount: 8, unit: '人', currency: null } },
    confirmed_at: T0,
  });
  const newFact = fact({
    fact_id: asFactRef('fact-new'),
    fact_key: 'headcount',
    value: { kind: 'known', value: { type: 'number', amount: 10, unit: '人', currency: null } },
    supersedes_fact_id: asFactRef('fact-old'),
    confirmed_at: T1,
  });
  const all = [oldFact, newFact];

  it('被取代的旧事实不进可用表；可用表取新事实', () => {
    const snapshot = snapshotOf(all, ['headcount']);
    expect(snapshot.usable).toHaveLength(1);
    expect(snapshot.usable[0]?.fact_ref).toBe('fact-new');
    expect(snapshot.usable[0]?.value).toEqual({
      type: 'number',
      amount: 10,
      unit: '人',
      currency: null,
    });
    expect(snapshot.unusable).toHaveLength(0);
  });

  it('旧事实仍能查到（当前表不算它，但历史可追）', () => {
    const scoped = factsByKey(all, { task_id: TASK, task_revision: R2, fact_key: 'headcount' });
    expect(scoped.map((entry) => entry.fact_id)).toEqual(['fact-old', 'fact-new']);
  });
});

describe('版本：事实的 task_revision 高于所查版本 ⇒ 不算当前', () => {
  const atR2 = fact({
    fact_id: asFactRef('fact-r2'),
    fact_key: 'headcount',
    value: { kind: 'known', value: { type: 'number', amount: 8, unit: '人', currency: null } },
  });
  const atR3 = fact({
    fact_id: asFactRef('fact-r3'),
    task_revision: R3,
    fact_key: 'headcount',
    value: { kind: 'known', value: { type: 'number', amount: 12, unit: '人', currency: null } },
  });

  it('查 R2 时 r3 的事实不算当前（取 R2 的值）', () => {
    const snapshot = snapshotOf([atR2, atR3], ['headcount'], R2);
    expect(snapshot.usable[0]?.fact_ref).toBe('fact-r2');
    expect(snapshot.usable[0]?.value).toEqual({ type: 'number', amount: 8, unit: '人', currency: null });
  });

  it('查 R3 时取 r3 的事实', () => {
    const snapshot = snapshotOf([atR2, atR3], ['headcount'], R3);
    expect(snapshot.usable[0]?.fact_ref).toBe('fact-r3');
  });

  it('只有更高版本的事实 ⇒ 该键在所查版本为 missing（不是 0、不外借别的版本）', () => {
    const snapshot = snapshotOf([atR3], ['headcount'], R2);
    expect(snapshot.usable).toHaveLength(0);
    expect(snapshot.unusable).toEqual([
      expect.objectContaining({ fact_key: 'headcount', fact_ref: null, kind: 'missing' }),
    ]);
  });

  it('别的任务的事实不参与本任务（未登记 ⇒ missing）', () => {
    const other = fact({
      fact_id: asFactRef('fact-other'),
      task_id: OTHER_TASK,
      fact_key: 'headcount',
      value: { kind: 'known', value: { type: 'number', amount: 99, unit: '人', currency: null } },
    });
    const snapshot = snapshotOf([other], ['headcount']);
    expect(snapshot.usable).toHaveLength(0);
    expect(snapshot.unusable[0]?.kind).toBe('missing');
  });
});

describe('单一来源判据：不绕过 W-B 的 currentFactByKey', () => {
  it('同一键两条“当前”事实 ⇒ 抛错（不在本层吞掉）', () => {
    const a = fact({ fact_id: asFactRef('fact-a'), fact_key: 'headcount' });
    const b = fact({
      fact_id: asFactRef('fact-b'),
      fact_key: 'headcount',
      value: { kind: 'known', value: { type: 'number', amount: 10, unit: '人', currency: null } },
    });
    expect(() => snapshotOf([a, b], ['headcount'])).toThrow(/单一来源被破坏/);
  });
});

describe('输入形状：重复键 / 空键是调用方错误', () => {
  it('重复声明同一事实键 ⇒ 抛', () => {
    expect(() => snapshotOf([], ['headcount', 'headcount'])).toThrow(/重复键/);
  });

  it('空键 ⇒ 抛', () => {
    expect(() => snapshotOf([], [''])).toThrow(/非空字符串/);
  });

  it('空 fact_keys ⇒ 两张表都为空且可用', () => {
    const snapshot = snapshotOf([], []);
    expect(snapshot.usable).toHaveLength(0);
    expect(snapshot.unusable).toHaveLength(0);
    expect(isFactSnapshotUsable(snapshot)).toBe(true);
    expect(describeUnusableFacts(snapshot)).toBe('');
  });
});

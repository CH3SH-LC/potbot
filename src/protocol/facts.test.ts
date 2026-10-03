/**
 * `SharedFactRecord` 的构造期不变量与按事实键查找（design-02 P3）。
 *
 * 核心用例是 **P3 的硬要求**：「零」只能表达为 `known` 且值为 0；
 * 结构上（以及运行期校验上）**不可能把"缺失"表达成 0**。
 */

import { describe, expect, it } from 'vitest';

import {
  asFactRef,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asTaskId,
  assertSharedFactInvariants,
  createSharedFactRecord,
  currentFactByKey,
  FACT_SOURCE_KINDS,
  FACT_VALUE_KINDS,
  factValueKind,
  factsByKey,
  isUsableFact,
  KNOWN_FACT_VALUE_TYPES,
  supersededFactIds,
  ValidationError,
  type SharedFactRecordInput,
} from './index.js';

const TASK = asTaskId('T1');
const OTHER_TASK = asTaskId('T2');
const INSTANCE = asInstanceId('I-A');
const R2 = asRevision(2);
const R3 = asRevision(3);
const T0 = asLogicalTime(0);
const T1 = asLogicalTime(1);
const T2 = asLogicalTime(2);

const HEADCOUNT = 'headcount';

function fact(overrides: Record<string, unknown> = {}): SharedFactRecordInput {
  const base: SharedFactRecordInput = {
    fact_id: asFactRef('fact-1'),
    task_id: TASK,
    task_revision: R2,
    fact_key: HEADCOUNT,
    value: { kind: 'known', value: { type: 'number', amount: 8, unit: '人', currency: null } },
    source: { kind: 'user_confirmation', detail: '用户在会话中确认' },
    confirmed_by: INSTANCE,
    confirmed_at: T0,
  };
  return { ...base, ...overrides } as SharedFactRecordInput;
}

describe('事实值的封闭枚举', () => {
  it('值种类恰为 known / unknown / not_applicable；已知值种类恰为三种载荷', () => {
    expect([...FACT_VALUE_KINDS]).toEqual(['known', 'unknown', 'not_applicable']);
    expect([...KNOWN_FACT_VALUE_TYPES]).toEqual(['number', 'date', 'text']);
    expect([...FACT_SOURCE_KINDS]).toEqual([
      'user_confirmation',
      'document',
      'tool_result',
      'external',
    ]);
  });
});

describe('P3 硬要求：「零」只能是 known 且值为 0，缺失不得退化成 0', () => {
  it('known + amount 0 是合法的「零」，并且可用', () => {
    const zero = createSharedFactRecord(
      fact({ value: { kind: 'known', value: { type: 'number', amount: 0, unit: '人', currency: null } } }),
    );
    expect(factValueKind(zero)).toBe('known');
    expect(isUsableFact(zero)).toBe(true);
    expect(zero.value).toEqual({
      kind: 'known',
      value: { type: 'number', amount: 0, unit: '人', currency: null },
    });
  });

  it('unknown 分支**没有**数值载荷：给它塞一个 amount=0 的载荷 ⇒ 抛（用 0 冒充未知）', () => {
    expect(() =>
      createSharedFactRecord(
        fact({
          value: {
            kind: 'unknown',
            reason: '用户未回答第 3 轮追问',
            value: { type: 'number', amount: 0, unit: '人', currency: null },
          },
        }),
      ),
    ).toThrow(/unknown 事实不得携带 value 载荷/);
  });

  it('not_applicable 同样不得携带值载荷', () => {
    expect(() =>
      createSharedFactRecord(
        fact({ value: { kind: 'not_applicable', reason: '本任务不涉及人数', value: 0 } }),
      ),
    ).toThrow(/not_applicable 事实不得携带 value 载荷/);
  });

  it('unknown 必须说明原因，空原因 ⇒ 抛', () => {
    expect(() =>
      createSharedFactRecord(fact({ value: { kind: 'unknown', reason: '' } })),
    ).toThrow(/unknown 事实的 reason 不能为空字符串/);
  });

  it('unknown / not_applicable 都不是可用事实（调用方必须走 missing_fact 阻塞，不得当 0）', () => {
    const unknown = createSharedFactRecord(
      fact({ value: { kind: 'unknown', reason: '资料缺失' } }),
    );
    const notApplicable = createSharedFactRecord(
      fact({ value: { kind: 'not_applicable', reason: '不适用' } }),
    );
    expect(isUsableFact(unknown)).toBe(false);
    expect(isUsableFact(notApplicable)).toBe(false);
    expect(factValueKind(unknown)).toBe('unknown');
    expect(factValueKind(notApplicable)).toBe('not_applicable');
  });
});

describe('known 载荷的形状校验', () => {
  it('数值必须有限（NaN / Infinity 不得充当"未知"）', () => {
    expect(() =>
      createSharedFactRecord(
        fact({ value: { kind: 'known', value: { type: 'number', amount: Number.NaN, unit: '人' } } }),
      ),
    ).toThrow(/amount 必须是有限数/);
    expect(() =>
      createSharedFactRecord(
        fact({
          value: { kind: 'known', value: { type: 'number', amount: Number.POSITIVE_INFINITY, unit: '元' } },
        }),
      ),
    ).toThrow(/amount 必须是有限数/);
  });

  it('数值必须带单位；币种可空但不得为空串', () => {
    expect(() =>
      createSharedFactRecord(
        fact({ value: { kind: 'known', value: { type: 'number', amount: 100, unit: '' } } }),
      ),
    ).toThrow(/unit 不能为空字符串/);
    expect(() =>
      createSharedFactRecord(
        fact({
          value: { kind: 'known', value: { type: 'number', amount: 100, unit: '元', currency: '' } },
        }),
      ),
    ).toThrow(/currency 不能为空字符串/);
  });

  it('日期必须以 YYYY-MM-DD 开头且带时区', () => {
    const ok = createSharedFactRecord(
      fact({
        fact_key: 'event.date',
        value: {
          kind: 'known',
          value: { type: 'date', iso_date: '2026-10-02', time_zone: 'Asia/Shanghai' },
        },
      }),
    );
    expect(ok.value).toEqual({
      kind: 'known',
      value: { type: 'date', iso_date: '2026-10-02', time_zone: 'Asia/Shanghai' },
    });
    expect(() =>
      createSharedFactRecord(
        fact({
          value: {
            kind: 'known',
            value: { type: 'date', iso_date: 'Oct 2', time_zone: 'Asia/Shanghai' },
          },
        }),
      ),
    ).toThrow(/iso_date 必须以 YYYY-MM-DD 开头/);
    expect(() =>
      createSharedFactRecord(
        fact({
          value: { kind: 'known', value: { type: 'date', iso_date: '2026-10-02', time_zone: '' } },
        }),
      ),
    ).toThrow(/time_zone 不能为空字符串/);
  });

  it('文本必须带文本与来源，空串不得充当已知值（应表达为 unknown）', () => {
    expect(() =>
      createSharedFactRecord(
        fact({ value: { kind: 'known', value: { type: 'text', text: '', source: '文档 §2' } } }),
      ),
    ).toThrow(/text 不能为空字符串/);
    expect(() =>
      createSharedFactRecord(
        fact({ value: { kind: 'known', value: { type: 'text', text: '晚宴', source: '' } } }),
      ),
    ).toThrow(/source 不能为空字符串/);
  });

  it('未知的载荷类型 / 未知的值种类 / 缺失的载荷一律抛', () => {
    expect(() =>
      createSharedFactRecord(fact({ value: { kind: 'known', value: { type: 'money', amount: 1 } } })),
    ).toThrow(/value.type 必须是 number \| date \| text 之一/);
    expect(() => createSharedFactRecord(fact({ value: { kind: 'maybe' } }))).toThrow(
      /value.kind 必须是 known \| unknown \| not_applicable 之一/,
    );
    expect(() => createSharedFactRecord(fact({ value: { kind: 'known' } }))).toThrow(
      /known 事实必须携带 value 载荷/,
    );
  });
});

describe('记录级不变量', () => {
  it('fact_key / fact_id / 确认者 / 来源说明都不能为空', () => {
    expect(() => createSharedFactRecord(fact({ fact_key: '' }))).toThrow(
      /fact_key 不能为空字符串/,
    );
    expect(() => createSharedFactRecord(fact({ fact_id: '' }))).toThrow(
      /fact_id 不能为空字符串/,
    );
    expect(() => createSharedFactRecord(fact({ confirmed_by: '' }))).toThrow(
      /confirmed_by 不能为空字符串/,
    );
    expect(() => createSharedFactRecord(fact({ source: { kind: 'user_confirmation', detail: '' } }))).toThrow(
      /source.detail 不能为空字符串/,
    );
  });

  it('来源种类必须是封闭枚举之一', () => {
    expect(() =>
      createSharedFactRecord(fact({ source: { kind: 'rumor', detail: 'x' } })),
    ).toThrow(/source.kind 必须是/);
  });

  it('不能取代自己；可以指向被取代的旧事实', () => {
    expect(() =>
      createSharedFactRecord(fact({ supersedes_fact_id: asFactRef('fact-1') })),
    ).toThrow(/不能取代自己/);
    const next = createSharedFactRecord(
      fact({ fact_id: asFactRef('fact-2'), supersedes_fact_id: asFactRef('fact-1') }),
    );
    expect(next.supersedes_fact_id).toBe('fact-1');
  });

  it('确认时刻必须是有限逻辑时间；记录与嵌套载荷均冻结', () => {
    expect(() => createSharedFactRecord(fact({ confirmed_at: Number.NaN }))).toThrow(
      /confirmed_at 必须是有限数/,
    );
    const record = createSharedFactRecord(fact());
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.value)).toBe(true);
    expect(Object.isFrozen(record.source)).toBe(true);
  });

  it('assertSharedFactInvariants 对合法记录静默，对越界记录抛（与构造期同源）', () => {
    const record = createSharedFactRecord(fact());
    expect(() => assertSharedFactInvariants(record)).not.toThrow();
    const broken = { ...record, fact_key: '' };
    expect(() => assertSharedFactInvariants(broken)).toThrow(/fact_key 不能为空字符串/);
  });
});

describe('按事实键查找：当前事实与被取代的历史', () => {
  const v1 = createSharedFactRecord(
    fact({
      fact_id: asFactRef('fact-1'),
      value: { kind: 'known', value: { type: 'number', amount: 8, unit: '人', currency: null } },
      confirmed_at: T0,
    }),
  );
  const v2 = createSharedFactRecord(
    fact({
      fact_id: asFactRef('fact-2'),
      supersedes_fact_id: asFactRef('fact-1'),
      value: { kind: 'known', value: { type: 'number', amount: 10, unit: '人', currency: null } },
      confirmed_at: T1,
    }),
  );
  const otherRevision = createSharedFactRecord(
    fact({
      fact_id: asFactRef('fact-3'),
      task_revision: R3,
      value: { kind: 'known', value: { type: 'number', amount: 12, unit: '人', currency: null } },
      confirmed_at: T2,
    }),
  );
  const otherTask = createSharedFactRecord(
    fact({
      fact_id: asFactRef('fact-4'),
      task_id: OTHER_TASK,
      value: { kind: 'known', value: { type: 'number', amount: 99, unit: '人', currency: null } },
      confirmed_at: T2,
    }),
  );
  const all = [v1, v2, otherRevision, otherTask];

  it('当前事实 = 未被任何 supersedes 指到的那条', () => {
    const current = currentFactByKey(all, { task_id: TASK, task_revision: R2, fact_key: HEADCOUNT });
    expect(current?.fact_id).toBe('fact-2');
    expect(current?.value).toEqual({
      kind: 'known',
      value: { type: 'number', amount: 10, unit: '人', currency: null },
    });
  });

  it('被取代的旧事实仍可查到，但不作为当前', () => {
    const scoped = factsByKey(all, { task_id: TASK, task_revision: R2, fact_key: HEADCOUNT });
    expect(scoped.map((entry) => entry.fact_id)).toEqual(['fact-1', 'fact-2']);
    expect([...supersededFactIds(scoped)]).toEqual(['fact-1']);
    expect(currentFactByKey(scoped, { task_id: TASK, task_revision: R2, fact_key: HEADCOUNT })?.fact_id).toBe(
      'fact-2',
    );
  });

  it('版本与任务都被收窄：别的版本 / 别的任务的事实不参与当前判定', () => {
    expect(
      currentFactByKey(all, { task_id: TASK, task_revision: R3, fact_key: HEADCOUNT })?.fact_id,
    ).toBe('fact-3');
    expect(
      factsByKey(all, { task_id: OTHER_TASK, task_revision: R2, fact_key: HEADCOUNT }).map(
        (entry) => entry.fact_id,
      ),
    ).toEqual(['fact-4']);
  });

  it('没有该键的事实 ⇒ undefined（调用方必须按缺失处理，而不是当 0）', () => {
    expect(
      currentFactByKey(all, { task_id: TASK, task_revision: R2, fact_key: 'budget.total' }),
    ).toBeUndefined();
  });

  it('同一键出现两条"当前"事实 ⇒ 抛（单一来源被破坏必须显式失败）', () => {
    const conflicting = createSharedFactRecord(
      fact({
        fact_id: asFactRef('fact-9'),
        value: { kind: 'known', value: { type: 'number', amount: 10, unit: '人', currency: null } },
        confirmed_at: T1,
      }),
    );
    expect(() =>
      currentFactByKey([...all, conflicting], {
        task_id: TASK,
        task_revision: R2,
        fact_key: HEADCOUNT,
      }),
    ).toThrow(/单一来源被破坏/);
  });

  it('查找返回的列表按确认时刻稳定排序', () => {
    const scoped = factsByKey([v2, v1], { task_id: TASK, task_revision: R2, fact_key: HEADCOUNT });
    expect(scoped.map((entry) => entry.fact_id)).toEqual(['fact-1', 'fact-2']);
    expect(Object.isFrozen(scoped)).toBe(true);
  });
});

/**
 * 事实提案校验（design-02 P3；R48.2 / R48.4）单测。
 *
 * 逐条写出“缺什么 ⇒ 拒什么”：金额缺币种 / 数值缺单位 / 日期缺时区 / 文本缺来源 /
 * 用 0（或空串、undefined）冒充未知；并断言零与未知在结构上不可互换、来源授权口可注入、
 * 校验失败一律是结构化拒绝而**不抛错**。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  validateFactProposal,
  type FactProposalPolicy,
  type FactProposalValidation,
} from './index.js';

/** 默认策略：授权除 external 以外的来源——策略由调用方注入，本层不硬编码。 */
const policy: FactProposalPolicy = {
  isAuthorizedSource: (source) => source.kind !== 'external',
};

const SOURCE = { kind: 'user_confirmation', detail: '用户在会话中确认' };

function validate(raw: unknown, p: FactProposalPolicy = policy): FactProposalValidation {
  return validateFactProposal(raw, p);
}

function codes(result: FactProposalValidation): string[] {
  return result.ok ? [] : result.rejections.map((entry) => entry.code);
}

describe('通过：合规提案被规范化并冻结', () => {
  it('人数（数值 + 单位 + 显式 currency:null）通过', () => {
    const result = validate({
      fact_key: 'headcount',
      value: { kind: 'known', value: { type: 'number', amount: 8, unit: '人', currency: null } },
      source: SOURCE,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal).toEqual({
        fact_key: 'headcount',
        value: { kind: 'known', value: { type: 'number', amount: 8, unit: '人', currency: null } },
        source: { kind: 'user_confirmation', detail: '用户在会话中确认' },
      });
      expect(Object.isFrozen(result.proposal)).toBe(true);
      expect(Object.isFrozen(result.proposal.value)).toBe(true);
      expect(Object.isFrozen(result.proposal.source)).toBe(true);
    }
  });

  it('金额带币种通过', () => {
    const result = validate({
      fact_key: 'budget.total',
      value: { kind: 'known', value: { type: 'number', amount: 5000, unit: '元', currency: 'CNY' } },
      source: SOURCE,
    });
    expect(result.ok).toBe(true);
  });

  it('日期带时区通过', () => {
    const result = validate({
      fact_key: 'event.date',
      value: {
        kind: 'known',
        value: { type: 'date', iso_date: '2026-10-02T18:00:00+08:00', time_zone: 'Asia/Shanghai' },
      },
      source: SOURCE,
    });
    expect(result.ok).toBe(true);
  });

  it('文本带来源引用通过', () => {
    const result = validate({
      fact_key: 'venue.name',
      value: { kind: 'known', value: { type: 'text', text: '外滩某餐厅', source: '会议纪要 §2' } },
      source: SOURCE,
    });
    expect(result.ok).toBe(true);
  });

  it('unknown（带原因、无值载荷）通过——缺失的合法表达', () => {
    const result = validate({
      fact_key: 'budget.total',
      value: { kind: 'unknown', reason: '预算尚未确定' },
      source: SOURCE,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.value).toEqual({ kind: 'unknown', reason: '预算尚未确定' });
    }
  });

  it('known 且值为 0 是合法的「零」，与 unknown 结构上不同', () => {
    const zero = validate({
      fact_key: 'headcount',
      value: { kind: 'known', value: { type: 'number', amount: 0, unit: '人', currency: null } },
      source: SOURCE,
    });
    const unknown = validate({
      fact_key: 'headcount',
      value: { kind: 'unknown', reason: '未统计' },
      source: SOURCE,
    });
    expect(zero.ok).toBe(true);
    expect(unknown.ok).toBe(true);
    if (zero.ok && unknown.ok) {
      expect(zero.proposal.value).not.toEqual(unknown.proposal.value);
      expect(zero.proposal.value).toEqual({
        kind: 'known',
        value: { type: 'number', amount: 0, unit: '人', currency: null },
      });
    }
  });
});

describe('拒绝：缺什么 ⇒ 拒什么（结构化拒因，不抛错）', () => {
  it('数值缺单位 ⇒ missing_unit', () => {
    const result = validate({
      fact_key: 'headcount',
      value: { kind: 'known', value: { type: 'number', amount: 8, currency: null } },
      source: SOURCE,
    });
    expect(codes(result)).toContain('missing_unit');
  });

  it('金额缺币种（未写 currency）⇒ missing_currency', () => {
    const result = validate({
      fact_key: 'budget.total',
      value: { kind: 'known', value: { type: 'number', amount: 5000, unit: '元' } },
      source: SOURCE,
    });
    expect(codes(result)).toContain('missing_currency');
  });

  it('币种为空串 ⇒ missing_currency（空串不是合法币种，也不得充当“非金额”）', () => {
    const result = validate({
      fact_key: 'budget.total',
      value: { kind: 'known', value: { type: 'number', amount: 5000, unit: '元', currency: '' } },
      source: SOURCE,
    });
    expect(codes(result)).toContain('missing_currency');
  });

  it('日期缺时区 ⇒ missing_time_zone', () => {
    const result = validate({
      fact_key: 'event.date',
      value: { kind: 'known', value: { type: 'date', iso_date: '2026-10-02' } },
      source: SOURCE,
    });
    expect(codes(result)).toContain('missing_time_zone');
  });

  it('日期不可还原为明确日期 ⇒ missing_date', () => {
    const result = validate({
      fact_key: 'event.date',
      value: { kind: 'known', value: { type: 'date', iso_date: 'Oct 2', time_zone: 'Asia/Shanghai' } },
      source: SOURCE,
    });
    expect(codes(result)).toContain('missing_date');
  });

  it('文本缺来源引用 ⇒ missing_source_reference', () => {
    const result = validate({
      fact_key: 'venue.name',
      value: { kind: 'known', value: { type: 'text', text: '外滩某餐厅' } },
      source: SOURCE,
    });
    expect(codes(result)).toContain('missing_source_reference');
  });

  it('文本用空串充当已知值 ⇒ missing_text（空串不是已知值）', () => {
    const result = validate({
      fact_key: 'venue.name',
      value: { kind: 'known', value: { type: 'text', text: '', source: '会议纪要 §2' } },
      source: SOURCE,
    });
    expect(codes(result)).toContain('missing_text');
  });

  it('数值 amount 非有限数 ⇒ invalid_amount（NaN 不得充当未知）', () => {
    const result = validate({
      fact_key: 'headcount',
      value: { kind: 'known', value: { type: 'number', amount: Number.NaN, unit: '人', currency: null } },
      source: SOURCE,
    });
    expect(codes(result)).toContain('invalid_amount');
  });
});

describe('拒绝：不得用 0 / 空串 / undefined 表示未知', () => {
  it('value 缺失（undefined）⇒ missing_value', () => {
    expect(codes(validate({ fact_key: 'headcount', source: SOURCE }))).toContain('missing_value');
  });

  it('value 为裸 0 ⇒ missing_value（用 0 冒充未知）', () => {
    expect(codes(validate({ fact_key: 'headcount', value: 0, source: SOURCE }))).toContain(
      'missing_value',
    );
  });

  it('value 为裸空串 ⇒ missing_value', () => {
    expect(codes(validate({ fact_key: 'headcount', value: '', source: SOURCE }))).toContain(
      'missing_value',
    );
  });

  it('unknown 携带值载荷（0）⇒ unknown_carries_payload（用值冒充未知）', () => {
    const result = validate({
      fact_key: 'headcount',
      value: { kind: 'unknown', reason: '未统计', value: 0 },
      source: SOURCE,
    });
    expect(codes(result)).toContain('unknown_carries_payload');
  });

  it('unknown 缺原因 ⇒ missing_unknown_reason', () => {
    const result = validate({
      fact_key: 'headcount',
      value: { kind: 'unknown' },
      source: SOURCE,
    });
    expect(codes(result)).toContain('missing_unknown_reason');
  });

  it('value.kind 非法 ⇒ unknown_value_kind；known 缺载荷 ⇒ missing_value_payload', () => {
    expect(codes(validate({ fact_key: 'k', value: { kind: 'maybe' }, source: SOURCE }))).toContain(
      'unknown_value_kind',
    );
    expect(codes(validate({ fact_key: 'k', value: { kind: 'known' }, source: SOURCE }))).toContain(
      'missing_value_payload',
    );
  });
});

describe('来源：结构非法与授权范围', () => {
  it('来源结构非法（kind 非枚举 / detail 空）⇒ invalid_source', () => {
    expect(
      codes(
        validate({
          fact_key: 'headcount',
          value: { kind: 'known', value: { type: 'number', amount: 8, unit: '人', currency: null } },
          source: { kind: 'rumor', detail: '小道消息' },
        }),
      ),
    ).toContain('invalid_source');
    expect(
      codes(
        validate({
          fact_key: 'headcount',
          value: { kind: 'known', value: { type: 'number', amount: 8, unit: '人', currency: null } },
          source: { kind: 'user_confirmation', detail: '' },
        }),
      ),
    ).toContain('invalid_source');
  });

  it('来源不在授权范围内 ⇒ source_not_authorized（判定口可注入）', () => {
    const result = validate({
      fact_key: 'headcount',
      value: { kind: 'known', value: { type: 'number', amount: 8, unit: '人', currency: null } },
      source: { kind: 'external', detail: '来自某网页' },
    });
    expect(codes(result)).toContain('source_not_authorized');
  });

  it('换一个注入策略：只授权 document ⇒ document 通过、user_confirmation 被拒', () => {
    const onlyDocument: FactProposalPolicy = {
      isAuthorizedSource: (source) => source.kind === 'document',
    };
    const asDocument = validate(
      {
        fact_key: 'headcount',
        value: { kind: 'known', value: { type: 'number', amount: 8, unit: '人', currency: null } },
        source: { kind: 'document', detail: '合同 §3' },
      },
      onlyDocument,
    );
    const asUser = validate(
      {
        fact_key: 'headcount',
        value: { kind: 'known', value: { type: 'number', amount: 8, unit: '人', currency: null } },
        source: SOURCE,
      },
      onlyDocument,
    );
    expect(asDocument.ok).toBe(true);
    expect(codes(asUser)).toContain('source_not_authorized');
  });

  it('授权判定口收到的是已规范化的 FactSource', () => {
    const spy = vi.fn(() => true);
    validate(
      {
        fact_key: 'headcount',
        value: { kind: 'known', value: { type: 'number', amount: 8, unit: '人', currency: null } },
        source: SOURCE,
      },
      { isAuthorizedSource: spy },
    );
    expect(spy).toHaveBeenCalledWith({ kind: 'user_confirmation', detail: '用户在会话中确认' });
  });
});

describe('鲁棒性：不成形的输入也是结构化拒绝，不抛错', () => {
  it('非对象提案（null / 数 / 数组）⇒ invalid_proposal', () => {
    for (const raw of [null, 42, 'x', [] as unknown]) {
      const result = validate(raw);
      expect(result.ok).toBe(false);
      expect(codes(result)).toContain('invalid_proposal');
    }
  });

  it('fact_key 空 ⇒ invalid_fact_key', () => {
    expect(
      codes(validate({ fact_key: '', value: { kind: 'unknown', reason: 'x' }, source: SOURCE })),
    ).toContain('invalid_fact_key');
  });

  it('一次收齐所有问题（值与来源同时不合规，两条拒因都在）', () => {
    const result = validate({
      fact_key: 'budget.total',
      value: { kind: 'known', value: { type: 'number', amount: 5000, unit: '元' } },
      source: { kind: 'external', detail: '某个网页' },
    });
    const found = codes(result);
    expect(found).toContain('missing_currency');
    expect(found).toContain('source_not_authorized');
  });

  it('校验路径对任意输入都不抛错', () => {
    expect(() =>
      validate({ fact_key: 'x', value: { kind: 'known', value: { type: 'number' } }, source: {} }),
    ).not.toThrow();
  });
});

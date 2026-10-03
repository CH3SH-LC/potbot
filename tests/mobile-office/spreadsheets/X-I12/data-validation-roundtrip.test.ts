/**
 * **X-I12**：数据验证的**全类型** `build(parse(build(x))) === build(x)` 恒等（XLS-11 / design-06-P8）。
 *
 * 与 X06 的往返用例互补：X06 只覆盖 list 内联 / list 区域 / whole(between) / textLength 四种，本用例
 * 把 `ValidationType` 的**每一种**都拉进恒等矩阵，并补上：
 * - inline list（`"甲,乙,丙"`）与 range formula1（`$D$1:$D$3`）的**判别**（含"值本身像区域"的反向对照）
 * - `none`（OOXML 默认"任意值"，真实 Excel 对只带输入提示的验证会省略 type）
 * - 特殊字符（`<` / `&` / 引号）经序列化器的转义往返
 * - 多区域 sqref（空格拼接）
 */

import { describe, expect, it } from 'vitest';

import {
  buildDataValidationsXml,
  parseDataValidationsXml,
  type DataValidationRule,
} from '../../../../src/spreadsheets/validation.js';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

/** `build → parse → build` 一次往返，返回两次字节产物。 */
function dvRoundTrip(rules: readonly DataValidationRule[]): { readonly first: string; readonly second: string; readonly back: readonly DataValidationRule[] } {
  const first = buildDataValidationsXml(rules) as string;
  const back = parseDataValidationsXml(first);
  const second = buildDataValidationsXml(back) as string;
  return { first, second, back };
}

const EVERY_TYPE: readonly DataValidationRule[] = [
  { ranges: ['A1:A10'], type: 'list', list_values: ['甲', '乙', '丙'] },
  { ranges: ['A1'], type: 'list', formula1: '$D$1:$D$3' },
  { ranges: ['A1'], type: 'list', list_values: ['甲'], suppress_dropdown: true },
  { ranges: ['A1:A10', 'C1:C5'], type: 'whole', operator: 'between', formula1: '1', formula2: '100' },
  { ranges: ['A1'], type: 'whole', operator: 'notBetween', formula1: '1', formula2: '100' },
  { ranges: ['A1'], type: 'whole', operator: 'greaterThan', formula1: '0' },
  { ranges: ['A1'], type: 'decimal', operator: 'greaterThanOrEqual', formula1: '0' },
  { ranges: ['A1'], type: 'decimal', operator: 'notEqual', formula1: '1.5' },
  { ranges: ['A1'], type: 'date', operator: 'lessThan', formula1: 'DATE(2020,1,1)' },
  { ranges: ['A1'], type: 'time', operator: 'equal', formula1: 'TIME(9,0,0)' },
  { ranges: ['A1'], type: 'textLength', operator: 'lessThanOrEqual', formula1: '10' },
  { ranges: ['A1'], type: 'custom', formula1: 'ISNUMBER(A1)' },
  { ranges: ['A1'], type: 'none', show_input_message: true, prompt_title: '提示', prompt: '任意值' },
];

const ALL_OPERATORS = ['between', 'notBetween', 'equal', 'notEqual', 'greaterThan', 'lessThan', 'greaterThanOrEqual', 'lessThanOrEqual'] as const;

describe('X-I12 §V1 每一种验证类型的字节恒等', () => {
  for (const rule of EVERY_TYPE) {
    const label = `${rule.type}${rule.operator === undefined ? '' : `/${rule.operator}`}`;
    it(`${label} build(parse(build)) 逐字节相同`, () => {
      const { first, second } = dvRoundTrip([rule]);
      expect(second).toBe(first);
    });
  }

  it('whole / decimal / date / time / textLength 的全部算子都恒等', () => {
    for (const type of ['whole', 'decimal', 'date', 'time', 'textLength'] as const) {
      for (const operator of ALL_OPERATORS) {
        const rule: DataValidationRule =
          operator === 'between' || operator === 'notBetween'
            ? { ranges: ['A1'], type, operator, formula1: '1', formula2: '9' }
            : { ranges: ['A1'], type, operator, formula1: '1' };
        const { first, second } = dvRoundTrip([rule]);
        expect(second, `${type}/${operator}`).toBe(first);
      }
    }
  });

  it('反向对照：矩阵确实覆盖了 ValidationType 的每一种取值', () => {
    const kinds = new Set(EVERY_TYPE.map((rule) => rule.type));
    for (const type of ['none', 'list', 'whole', 'decimal', 'date', 'time', 'textLength', 'custom'] as const) {
      expect(kinds.has(type), `矩阵遗漏了类型 ${type}`).toBe(true);
    }
  });
});

describe('X-I12 §V2 内联列表 vs 区域引用 formula1 的判别', () => {
  it('内联列表还原为 list_values（formula1 不出现），区域引用保持 formula1', () => {
    const { back } = dvRoundTrip([
      { ranges: ['A1'], type: 'list', list_values: ['甲', '乙'] },
      { ranges: ['B1'], type: 'list', formula1: '$D$1:$D$3' },
    ]);
    expect(back[0]?.list_values).toEqual(['甲', '乙']);
    expect(back[0]?.formula1).toBeUndefined();
    expect(back[1]?.formula1).toBe('$D$1:$D$3');
    expect(back[1]?.list_values).toBeUndefined();
  });

  it('反向对照：内联值本身"像区域"（`A1:A2`）时仍还原为 list_values，不被误判成公式', () => {
    const { back } = dvRoundTrip([{ ranges: ['A1'], type: 'list', list_values: ['A1:A2'] }]);
    expect(back[0]?.list_values).toEqual(['A1:A2']);
    expect(back[0]?.formula1).toBeUndefined();
  });

  it('区域引用的 formula1 里含空格（如跨表 `Sheet1!A1:A2`）不被拆成内联列表', () => {
    const { first, second, back } = dvRoundTrip([{ ranges: ['A1'], type: 'list', formula1: "'Sheet 1'!$A$1:$A$2" }]);
    expect(back[0]?.formula1).toBe("'Sheet 1'!$A$1:$A$2");
    expect(second).toBe(first);
  });
});

describe('X-I12 §V3 特殊字符与转义', () => {
  it('内联列表值与 formula 里的 < & 引号经转义后字节恒等', () => {
    const rules: readonly DataValidationRule[] = [
      { ranges: ['A1'], type: 'list', list_values: ['a<b', 'c&d', 'e>f'] },
      { ranges: ['B1'], type: 'custom', formula1: 'AND(A1<5,B1>3,A1&"x"="y")' },
      { ranges: ['C1'], type: 'none', show_input_message: true, prompt_title: 'a<b', prompt: 'c&d' },
    ];
    const { first, second, back } = dvRoundTrip(rules);
    expect(second).toBe(first);
    expect(back[0]?.list_values).toEqual(['a<b', 'c&d', 'e>f']);
    expect(back[1]?.formula1).toBe('AND(A1<5,B1>3,A1&"x"="y")');
    expect(back[2]?.prompt_title).toBe('a<b');
  });
});

describe('X-I12 §V4 none（任意值）与多区域 sqref', () => {
  it('真实 Excel 形状：省略 type 的验证读回为 none，并字节恒等', () => {
    const fragment = `<dataValidation xmlns="${NS}" allowBlank="1" showInputMessage="1" promptTitle="提示" prompt="任意值" sqref="A1:A10"/>`;
    const back = parseDataValidationsXml(fragment);
    expect(back.length).toBe(1);
    expect(back[0]?.type).toBe('none');
    expect(back[0]?.prompt).toBe('任意值');
    // 读回后再写出、再读回，恒等成立
    const first = buildDataValidationsXml(back) as string;
    expect(buildDataValidationsXml(parseDataValidationsXml(first)) as string).toBe(first);
  });

  it('多区域 sqref 以空格拼接并逐个还原', () => {
    const { first, back } = dvRoundTrip([{ ranges: ['E1:E20', 'G1:G20', 'J5'], type: 'textLength', operator: 'lessThanOrEqual', formula1: '10' }]);
    expect(first).toContain('sqref="E1:E20 G1:G20 J5"');
    expect(back[0]?.ranges).toEqual(['E1:E20', 'G1:G20', 'J5']);
  });

  it('反向对照：none 不接受 formula1 / list_values（形状非法即抛）', () => {
    const withFormula = `<dataValidation xmlns="${NS}" type="none" sqref="A1"><formula1>1</formula1></dataValidation>`;
    expect(() => parseDataValidationsXml(withFormula)).toThrow(/none/);
    // 未知的 type 字符串仍然拒绝
    const bogus = `<dataValidation xmlns="${NS}" type="bogus" sqref="A1"/>`;
    expect(() => parseDataValidationsXml(bogus)).toThrow(/未知的数据验证类型/);
  });
});

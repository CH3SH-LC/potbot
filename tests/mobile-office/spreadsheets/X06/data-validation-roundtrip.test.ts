/**
 * **X06**：数据验证的**真实 XML 往返**（design-06-P8 / XLS-11 前半）。
 *
 * 已有 `validation.test.ts` 只验"写出"；本用例补上**读回**这一半，判据是往返恒等：
 * `build(parse(build(rules))) === build(rules)`——读回再写出逐字节相同，才是"文件里的验证
 * 规则真的被读回来了"。
 */

import { describe, expect, it } from 'vitest';

import { parseXml } from '../../../../src/documents/docx/xml-parse.js';
import {
  buildDataValidationXml,
  buildDataValidationsXml,
  parseDataValidationsXml,
  type DataValidationRule,
} from '../../../../src/spreadsheets/validation.js';

const RULES: readonly DataValidationRule[] = [
  {
    ranges: ['A1:A10'],
    type: 'list',
    list_values: ['甲', '乙', '丙'],
    allow_blank: true,
    show_input_message: true,
    prompt_title: '请选择',
    prompt: '从下拉里选一个',
    show_error_message: true,
    error_title: '输入无效',
    error: '只能选下拉里的值',
    error_style: 'stop',
  },
  { ranges: ['B1:B5'], type: 'whole', operator: 'between', formula1: '1', formula2: '100', show_error_message: true },
  { ranges: ['C1'], type: 'list', formula1: '$D$1:$D$3' },
  { ranges: ['E1:E20', 'G1:G20'], type: 'textLength', operator: 'lessThanOrEqual', formula1: '10' },
];

describe('X06 §V1 数据验证往返', () => {
  it('写出 → 读回：字段逐项对齐（内联列表还原为 list_values）', () => {
    const xml = buildDataValidationsXml(RULES) as string;
    const back = parseDataValidationsXml(xml);
    expect(back.length).toBe(4);

    const [list, between, ref, len] = back as [DataValidationRule, DataValidationRule, DataValidationRule, DataValidationRule];
    expect(list.type).toBe('list');
    expect(list.list_values).toEqual(['甲', '乙', '丙']);
    expect(list.formula1).toBeUndefined();
    expect(list.ranges).toEqual(['A1:A10']);
    expect(list.error_style).toBe('stop');
    expect(list.prompt_title).toBe('请选择');

    expect(between.operator).toBe('between');
    expect(between.formula1).toBe('1');
    expect(between.formula2).toBe('100');

    // 区域引用（带引号？不）⇒ 仍是 formula1，不被误当内联列表
    expect(ref.formula1).toBe('$D$1:$D$3');
    expect(ref.list_values).toBeUndefined();

    expect(len.ranges).toEqual(['E1:E20', 'G1:G20']);
    expect(len.operator).toBe('lessThanOrEqual');
  });

  it('字节往返：build(parse(build(rules))) 与 build(rules) 逐字节相同', () => {
    const first = buildDataValidationsXml(RULES) as string;
    const second = buildDataValidationsXml(parseDataValidationsXml(first)) as string;
    expect(second).toBe(first);
  });

  it('单条 <dataValidation> 片段也能读回', () => {
    const single = buildDataValidationXml(RULES[1] as DataValidationRule);
    const back = parseDataValidationsXml(single);
    expect(back.length).toBe(1);
    expect(back[0]?.type).toBe('whole');
  });

  it('反向对照：showDropDown 的"反语义"在往返后仍一致（suppress_dropdown ⇒ showDropDown=1）', () => {
    const rule: DataValidationRule = { ranges: ['A1'], type: 'list', list_values: ['甲'], suppress_dropdown: true };
    const xml = buildDataValidationXml(rule);
    expect(parseXml(xml).attributes.some((a) => a.name === 'showDropDown' && a.value === '1')).toBe(true);
    const back = parseDataValidationsXml(xml);
    expect(back[0]?.suppress_dropdown).toBe(true);
  });

  it('反向对照：畸形片段抛错（缺 sqref / 未知 type）', () => {
    const noSqref = '<dataValidation xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" type="list"/>';
    expect(() => parseDataValidationsXml(noSqref)).toThrow(/sqref/);
    const badType = '<dataValidation xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" type="bogus" sqref="A1"/>';
    expect(() => parseDataValidationsXml(badType)).toThrow(/未知的数据验证类型|需要/);
    const empty = '<dataValidations xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0"/>';
    expect(parseDataValidationsXml(empty).length).toBe(0);
  });
});

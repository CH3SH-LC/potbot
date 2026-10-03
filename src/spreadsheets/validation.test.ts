/**
 * `validation.ts` 的验收用例（design-06-P8 / XLS-11 前半）。
 *
 * 判据是「**产出的是可写进文件的 OOXML**」：用例把片段读回来逐属性核对，
 * 而不是只看函数有没有返回值——这正是 XLS-11「必须写入文件而非仅网页效果」的要求。
 */

import { describe, expect, it } from 'vitest';

import {
  attributeValue,
  childElements,
  findChild,
  parseXml,
  type ParsedXmlElement,
} from '../documents/docx/xml-parse.js';
import { SPREADSHEETML_NAMESPACE } from '../artifacts/templates/xlsx.js';
import {
  buildDataValidationXml,
  buildDataValidationsXml,
  buildInlineListFormula,
  buildSqref,
  MAX_INLINE_LIST_LENGTH,
  type DataValidationRule,
} from './validation.js';

function attrOf(element: ParsedXmlElement, localName: string): string | null {
  return attributeValue(element, '', localName);
}

function childOf(element: ParsedXmlElement, localName: string): ParsedXmlElement {
  const found = findChild(element, SPREADSHEETML_NAMESPACE, localName);
  if (found === null) throw new Error(`缺少子元素 ${localName}`);
  return found;
}

function textOfChild(element: ParsedXmlElement, localName: string): string {
  const child = childOf(element, localName);
  let text = '';
  for (const node of child.children) if (node.kind === 'text') text += node.value;
  return text;
}

const LIST_RULE: DataValidationRule = {
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
};

describe('XLS-11 数据验证 → OOXML', () => {
  it('下拉列表规则产出可解析的 <dataValidation>：type / sqref / 内联 formula1 都在', () => {
    const root = parseXml(buildDataValidationXml(LIST_RULE));
    expect(root.localName).toBe('dataValidation');
    expect(attrOf(root, 'type')).toBe('list');
    expect(attrOf(root, 'sqref')).toBe('A1:A10');
    expect(attrOf(root, 'allowBlank')).toBe('1');
    expect(attrOf(root, 'showInputMessage')).toBe('1');
    expect(attrOf(root, 'showErrorMessage')).toBe('1');
    expect(attrOf(root, 'errorStyle')).toBe('stop');
    expect(attrOf(root, 'promptTitle')).toBe('请选择');
    expect(attrOf(root, 'error')).toBe('只能选下拉里的值');
    expect(textOfChild(root, 'formula1')).toBe('"甲,乙,丙"');
  });

  it('反向对照：showDropDown 是**反的**——缺省不写（显示下拉），suppress_dropdown 才写 "1"', () => {
    const visible = parseXml(buildDataValidationXml(LIST_RULE));
    expect(attrOf(visible, 'showDropDown')).toBeNull();
    const hidden = parseXml(buildDataValidationXml({ ...LIST_RULE, suppress_dropdown: true }));
    expect(attrOf(hidden, 'showDropDown')).toBe('1');
  });

  it('数值区间规则：operator + 两个 formula', () => {
    const rule: DataValidationRule = {
      ranges: ['B1:B5'],
      type: 'whole',
      operator: 'between',
      formula1: '1',
      formula2: '100',
      show_error_message: true,
    };
    const root = parseXml(buildDataValidationXml(rule));
    expect(attrOf(root, 'type')).toBe('whole');
    expect(attrOf(root, 'operator')).toBe('between');
    expect(textOfChild(root, 'formula1')).toBe('1');
    expect(textOfChild(root, 'formula2')).toBe('100');
  });

  it('多范围 sqref 以空格拼接；多规则带 count', () => {
    expect(buildSqref(['A1:A10', 'C1'])).toBe('A1:A10 C1');
    const xml = buildDataValidationsXml([LIST_RULE, { ...LIST_RULE, ranges: ['C1:C5'] }]);
    expect(xml).not.toBeNull();
    const root = parseXml(xml as string);
    expect(root.localName).toBe('dataValidations');
    expect(attrOf(root, 'count')).toBe('2');
    expect(childElements(root).length).toBe(2);
  });

  it('反向对照：没有规则时返回 null（不写 count="0" 的空壳）', () => {
    expect(buildDataValidationsXml([])).toBeNull();
  });

  it('内联列表值含逗号 / 双引号 ⇒ 抛错（无法内联表示，不静默改写）', () => {
    expect(() => buildInlineListFormula(['甲,乙'])).toThrow(/含逗号/);
    expect(() => buildInlineListFormula(['甲"乙'])).toThrow(/含双引号/);
  });

  it('内联列表超长 ⇒ 抛错（不静默截断）', () => {
    const long = 'x'.repeat(MAX_INLINE_LIST_LENGTH);
    expect(() => buildInlineListFormula([long])).toThrow(/超过 Excel 上限/);
    // 反向对照：刚好在上限内的值可以通过
    expect(buildInlineListFormula(['短'])).toBe('"短"');
  });

  it('反向对照：不合法的规则形状一律抛错', () => {
    expect(() => buildDataValidationXml({ ...LIST_RULE, operator: 'between' })).toThrow(/不接受 operator/);
    expect(
      () => buildDataValidationXml({ ranges: ['A1'], type: 'whole', operator: 'between', formula1: '1' }),
    ).toThrow(/需要 formula2/);
    expect(() => buildDataValidationXml({ ranges: ['A1'], type: 'whole' })).toThrow(/需要 formula1/);
    expect(() => buildDataValidationXml({ ranges: ['A1'], type: 'list' })).toThrow(/list_values/);
    expect(() => buildDataValidationXml({ ranges: [], type: 'list', list_values: ['甲'] })).toThrow(/不能为空/);
    expect(() => buildDataValidationXml({ ...LIST_RULE, ranges: ['不是区域'] })).toThrow();
    expect(
      () =>
        buildDataValidationXml({
          ranges: ['A1'],
          type: 'list',
          list_values: ['甲'],
          error_style: 'stop',
        }),
    ).toThrow(/error_style/);
  });

  it('反向对照：list_values 与 formula1 互斥（区域引用与内联列表只能二选一）', () => {
    expect(() =>
      buildDataValidationXml({ ranges: ['A1'], type: 'list', list_values: ['甲'], formula1: '$D$1:$D$3' }),
    ).toThrow(/互斥/);
    // 只给区域引用是合法的
    const root = parseXml(buildDataValidationXml({ ranges: ['A1'], type: 'list', formula1: '$D$1:$D$3' }));
    expect(textOfChild(root, 'formula1')).toBe('$D$1:$D$3');
  });
});

describe('XLS-11 none（任意值）类型（X-I12 加固）', () => {
  it('只带输入提示的验证写出 type="none"', () => {
    const root = parseXml(
      buildDataValidationXml({ ranges: ['A1:A10'], type: 'none', show_input_message: true, prompt_title: '提示', prompt: '任意值' }),
    );
    expect(attrOf(root, 'type')).toBe('none');
    expect(attrOf(root, 'promptTitle')).toBe('提示');
    expect(attrOf(root, 'prompt')).toBe('任意值');
  });

  it('反向对照：none 不接受 formula1 / list_values', () => {
    expect(() => buildDataValidationXml({ ranges: ['A1'], type: 'none', formula1: '1' })).toThrow(/none/);
    expect(() => buildDataValidationXml({ ranges: ['A1'], type: 'none', list_values: ['甲'] })).toThrow(/none/);
  });

  it('反向对照：未知的 type 字符串仍然拒绝', () => {
    expect(() => buildDataValidationXml({ ranges: ['A1'], type: 'bogus' as never })).toThrow(/未知的数据验证类型/);
  });
});

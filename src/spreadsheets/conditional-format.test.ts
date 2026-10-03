/**
 * `conditional-format.ts` 的验收用例（design-06-P8 / XLS-11 后半）。
 *
 * 判据覆盖四件事：优先级语义（含重复即拒绝）、范围迁移 / 清除、x14 与确定性 GUID、
 * 以及**产出可写入文件的 OOXML**（标准块与 x14 块都读回来核对）。
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
  buildConditionalFormattingBlocks,
  buildDxfsXml,
  clearAllRules,
  clearRulesForRange,
  compileConditionalFormats,
  deterministicX14Id,
  migrateCfRuleRanges,
  normalizeColor,
  normalizePriorities,
  removeRuleAt,
  requiresX14,
  sortRulesByPriority,
  validateCfRule,
  X14_NAMESPACE,
  type CfRule,
} from './conditional-format.js';

function attrOf(element: ParsedXmlElement, localName: string): string | null {
  return attributeValue(element, '', localName);
}

function childOf(element: ParsedXmlElement, localName: string): ParsedXmlElement {
  const found = findChild(element, SPREADSHEETML_NAMESPACE, localName);
  if (found === null) throw new Error(`缺少子元素 ${localName}`);
  return found;
}

function makeRules(): readonly CfRule[] {
  return [
    { range: 'A1:A10', priority: 2, type: 'cellIs', operator: 'greaterThan', formulas: ['90'], format: { fill_color: 'FFC7CE', font_color: '9C0006' } },
    { range: 'A1:A10', priority: 1, type: 'expression', formulas: ['$B1>0'], stop_if_true: true, format: { fill_color: 'C6EFCE' } },
    { range: 'B1:B10', priority: 3, type: 'duplicateValues', format: { font_bold: true, fill_color: 'FFEB9C' } },
  ];
}

describe('XLS-11 条件格式优先级', () => {
  it('按优先级排序并重编号为 1..N（消掉删除后的空洞）', () => {
    const normalized = normalizePriorities(makeRules());
    expect(normalized.map((rule) => rule.priority)).toEqual([1, 2, 3]);
    expect(normalized.map((rule) => rule.type)).toEqual(['expression', 'cellIs', 'duplicateValues']);
  });

  it('反向对照：重复优先级 ⇒ 抛错（次序有歧义，拒绝猜测）', () => {
    const dupes: CfRule[] = [
      { range: 'A1:A10', priority: 1, type: 'expression', formulas: ['1'] },
      { range: 'A1:A10', priority: 1, type: 'duplicateValues' },
    ];
    expect(() => normalizePriorities(dupes)).toThrow(/重复优先级/);
    // 0 / 负数 / 非整数同样非法
    expect(() => normalizePriorities([{ range: 'A1', priority: 0, type: 'duplicateValues' }])).toThrow(/优先级/);
    expect(() => normalizePriorities([{ range: 'A1', priority: 1.5, type: 'duplicateValues' }])).toThrow(/优先级/);
  });

  it('sortRulesByPriority 只排序、不重编号', () => {
    expect(sortRulesByPriority(makeRules()).map((rule) => rule.priority)).toEqual([1, 2, 3]);
  });

  it('removeRuleAt 删除一条，剩余规则可再归一化补齐', () => {
    const remaining = removeRuleAt(normalizePriorities(makeRules()), 1);
    expect(remaining.map((rule) => rule.priority)).toEqual([1, 3]);
    expect(normalizePriorities(remaining).map((rule) => rule.priority)).toEqual([1, 2]);
    expect(() => removeRuleAt(remaining, 9)).toThrow(/越界/);
  });
});

describe('XLS-11 应用范围迁移与清除', () => {
  it('范围内插入行 ⇒ 范围变宽；范围前插入 ⇒ 整体下移', () => {
    const inside = migrateCfRuleRanges(makeRules(), 5, 2, 'insert');
    expect(inside.rules[0]?.range).toBe('A1:A12');
    expect(inside.rules[2]?.range).toBe('B1:B12');
    const above = migrateCfRuleRanges(makeRules(), 1, 1, 'insert');
    expect(above.rules[0]?.range).toBe('A2:A11');
  });

  it('删除范围内的行 ⇒ 范围截短；整段删掉 ⇒ 丢弃并登记', () => {
    const truncated = migrateCfRuleRanges(makeRules(), 5, 2, 'delete');
    expect(truncated.rules[0]?.range).toBe('A1:A8');
    expect(truncated.dropped).toEqual([]);

    const dropped = migrateCfRuleRanges(makeRules(), 1, 20, 'delete');
    expect(dropped.rules.length).toBe(0);
    expect(dropped.dropped.map((entry) => entry.range)).toEqual(['A1:A10', 'A1:A10', 'B1:B10']);
  });

  it('范围前删除 ⇒ 整体上移；范围后删除 ⇒ 范围不动（反向对照）', () => {
    const before = migrateCfRuleRanges([{ range: 'D5:D9', priority: 1, type: 'duplicateValues' }], 1, 2, 'delete');
    expect(before.rules[0]?.range).toBe('D3:D7');
    const after = migrateCfRuleRanges([{ range: 'D5:D9', priority: 1, type: 'duplicateValues' }], 20, 2, 'delete');
    expect(after.rules[0]?.range).toBe('D5:D9');
    expect(after.dropped).toEqual([]);
  });

  it('清除：exact 只精确匹配，intersect 连相交的一起清（反向对照）', () => {
    expect(clearRulesForRange(makeRules(), 'A1:A10').length).toBe(1);
    expect(clearRulesForRange(makeRules(), 'A5:A20', 'intersect').map((rule) => rule.range)).toEqual(['B1:B10']);
    expect(clearAllRules().length).toBe(0);
  });
});

describe('XLS-11 x14 语义与确定性 GUID', () => {
  it('deterministicX14Id：同键同值、异键异值、形状是合法 GUID', () => {
    const first = deterministicX14Id('A1:A10#1#dataBar');
    expect(first).toBe(deterministicX14Id('A1:A10#1#dataBar'));
    expect(first).not.toBe(deterministicX14Id('A1:A11#1#dataBar'));
    expect(first).toMatch(/^\{[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}\}$/);
  });

  it('requiresX14 只认显式 extended 标记', () => {
    const bar: CfRule = { range: 'C1:C10', priority: 1, type: 'dataBar', data_bar: { color: '638EC6' } };
    expect(requiresX14(bar)).toBe(false);
    expect(requiresX14({ ...bar, extended: true })).toBe(true);
  });

  it('反向对照：颜色归一化补不透明前缀，非法色值抛错', () => {
    expect(normalizeColor('638ec6')).toBe('FF638EC6');
    expect(normalizeColor('80638EC6')).toBe('80638EC6');
    expect(() => normalizeColor('红色')).toThrow(/十六进制/);
  });
});

describe('XLS-11 条件格式 OOXML', () => {
  it('标准块：按范围分组、dxfId 指向各自差异格式、优先级与算子齐全', () => {
    const compiled = compileConditionalFormats(makeRules());
    expect(compiled.rules.map((rule) => rule.priority)).toEqual([1, 2, 3]);
    expect(compiled.x14_xml).toBeNull();

    // 两个范围 ⇒ 两个并列块
    const blocks = buildConditionalFormattingBlocks(compiled.rules, compiled.dxf_ids);
    expect(blocks.length).toBe(2);

    const firstBlock = parseXml(blocks[0] as string);
    expect(firstBlock.localName).toBe('conditionalFormatting');
    expect(attrOf(firstBlock, 'sqref')).toBe('A1:A10');
    const cfRules = childElements(firstBlock);
    expect(cfRules.length).toBe(2);
    const [expressionRule, cellIsRule] = cfRules as [ParsedXmlElement, ParsedXmlElement];
    expect(attrOf(expressionRule, 'type')).toBe('expression');
    expect(attrOf(expressionRule, 'priority')).toBe('1');
    expect(attrOf(expressionRule, 'stopIfTrue')).toBe('1');
    expect(attrOf(cellIsRule, 'type')).toBe('cellIs');
    expect(attrOf(cellIsRule, 'operator')).toBe('greaterThan');
    // 两条规则各自的不同差异格式 ⇒ dxfId 不同（证明是按格式映射，而不是共用 0）
    expect(attrOf(expressionRule, 'dxfId')).not.toBeNull();
    expect(attrOf(cellIsRule, 'dxfId')).not.toBeNull();
    expect(attrOf(cellIsRule, 'dxfId')).not.toBe(attrOf(expressionRule, 'dxfId'));
    expect(childOf(cellIsRule, 'formula').children[0]).toMatchObject({ value: '90' });
  });

  it('dxfs 去重：同色规则共用一条 dxf', () => {
    const same: CfRule[] = [
      { range: 'A1:A10', priority: 1, type: 'expression', formulas: ['1'], format: { fill_color: 'FFC7CE' } },
      { range: 'A1:A10', priority: 2, type: 'expression', formulas: ['2'], format: { fill_color: 'ffc7ce' } },
    ];
    const compiled = compileConditionalFormats(same);
    const dxfs = parseXml(compiled.dxfs_xml as string);
    expect(attrOf(dxfs, 'count')).toBe('1'); // 归一化后是同一个键（反向对照：不是 2）
  });

  it('x14 块：扩展规则**只**出现在 x14，且带确定性 GUID 与 sqref', () => {
    const extended: CfRule[] = [
      { range: 'C1:C10', priority: 2, type: 'dataBar', data_bar: { color: '638EC6' }, extended: true },
      { range: 'C1:C10', priority: 1, type: 'iconSet', icon_set: { icon_set: '3TrafficLights1', reverse: true }, extended: true },
    ];
    const compiled = compileConditionalFormats(extended);
    expect(compiled.conditional_formatting_xml).toBeNull(); // 反向对照：标准块为空

    const root = parseXml(compiled.x14_xml as string);
    expect(root.localName).toBe('conditionalFormattings');
    expect(root.namespace).toBe(X14_NAMESPACE);
    const blocks = childElements(root);
    expect(blocks.length).toBe(2);
    const first = blocks[0] as ParsedXmlElement;
    const cfRule = first.children.find(
      (node): node is ParsedXmlElement => node.kind === 'element' && node.localName === 'cfRule',
    );
    if (cfRule === undefined) throw new Error('缺少 x14:cfRule');
    expect(attrOf(cfRule, 'type')).toBe('iconSet');
    expect(attrOf(cfRule, 'id')).toMatch(/^\{[0-9a-f-]+\}$/);
    const sqref = first.children.find(
      (node): node is ParsedXmlElement => node.kind === 'element' && node.localName === 'sqref',
    );
    if (sqref === undefined) throw new Error('缺少 xm:sqref');
    expect(sqref.children[0]).toMatchObject({ value: 'C1:C10' });
  });

  it('colorScale 走标准块，端点数不对 ⇒ 抛错', () => {
    const scale: CfRule = {
      range: 'D1:D10',
      priority: 1,
      type: 'colorScale',
      color_scale: [
        { type: 'min', color: 'F8696B' },
        { type: 'percentile', value: '50', color: 'FFEB84' },
        { type: 'max', color: '63BE7B' },
      ],
    };
    const compiled = compileConditionalFormats([scale]);
    expect(compiled.x14_xml).toBeNull();
    const block = parseXml(compiled.conditional_formatting_xml as string);
    const colorScale = childOf(childElements(block)[0] as ParsedXmlElement, 'colorScale');
    expect(childElements(colorScale).length).toBe(6); // 3 个 cfvo + 3 个 color

    expect(() => validateCfRule({ range: 'D1:D10', priority: 1, type: 'colorScale', color_scale: [{ type: 'min', color: 'F8696B' }] })).toThrow(/2 或 3 个端点/);
  });

  it('反向对照：不合法的规则形状一律抛错', () => {
    expect(() => validateCfRule({ range: 'A1', priority: 1, type: 'cellIs', formulas: ['1'] })).toThrow(/需要 operator/);
    expect(() => validateCfRule({ range: 'A1', priority: 1, type: 'expression' })).toThrow(/需要 formulas/);
    expect(() => validateCfRule({ range: 'A1', priority: 1, type: 'containsText', formulas: ['x'] })).toThrow(/需要 text/);
    expect(() => validateCfRule({ range: 'A1', priority: 1, type: 'duplicateValues', operator: 'equal' })).toThrow(/不接受 operator/);
    expect(() => validateCfRule({ range: 'A1', priority: 1, type: 'dataBar' })).toThrow(/data_bar/);
    expect(() => validateCfRule({ range: 'A1', priority: 1, type: 'iconSet', icon_set: { icon_set: '9Arrows' as never } })).toThrow(/未知图标集/);
    expect(() => validateCfRule({ range: 'A1', priority: 1, type: 'expression', formulas: ['1'], extended: true })).toThrow(/x14/);
    expect(() =>
      validateCfRule({
        range: 'A1',
        priority: 1,
        type: 'dataBar',
        data_bar: { color: '638EC6' },
        format: { fill_color: 'FFC7CE' },
        extended: true,
      }),
    ).toThrow(/不接受 format/);
  });

  it('buildDxfsXml：空表返回 null（不写空壳）', () => {
    expect(buildDxfsXml([])).toBeNull();
  });
});

describe('XLS-11 新规则类型与多区域 sqref（X-I12 加固）', () => {
  function firstBlock(rule: CfRule): string {
    const compiled = compileConditionalFormats([rule]);
    return buildConditionalFormattingBlocks(compiled.rules, compiled.dxf_ids)[0] as string;
  }

  it('aboveAverage：aboveAverage="0" / equalAverage / stdDev 都写出', () => {
    const block = firstBlock({ range: 'A1', priority: 1, type: 'aboveAverage', above_average: false, equal_average: true, std_dev: 2 });
    expect(block).toContain('aboveAverage="0"');
    expect(block).toContain('equalAverage="1"');
    expect(block).toContain('stdDev="2"');
  });

  it('timePeriod：写出 timePeriod 属性', () => {
    expect(firstBlock({ range: 'A1', priority: 1, type: 'timePeriod', time_period: 'last7Days' })).toContain('timePeriod="last7Days"');
  });

  it('iconSet 标准块写出 reverse="1"（此前被静默丢弃）', () => {
    expect(firstBlock({ range: 'A1', priority: 1, type: 'iconSet', icon_set: { icon_set: '3Arrows', reverse: true } })).toContain('reverse="1"');
  });

  it('多区域 sqref 通过校验（真实 Excel 形状）；非法 token 仍抛错', () => {
    expect(() => validateCfRule({ range: 'A1:A10 C1:C10', priority: 1, type: 'expression', formulas: ['1'] })).not.toThrow();
    expect(() => validateCfRule({ range: 'A1:A10 不是区域', priority: 1, type: 'expression', formulas: ['1'] })).toThrow(/无法解析/);
    expect(() => validateCfRule({ range: '   ', priority: 1, type: 'expression', formulas: ['1'] })).toThrow(/不能为空/);
  });

  it('timePeriod / aboveAverage 的字段约束', () => {
    expect(() => validateCfRule({ range: 'A1', priority: 1, type: 'timePeriod' })).toThrow(/time_period/);
    expect(() => validateCfRule({ range: 'A1', priority: 1, type: 'timePeriod', time_period: '随便' as never })).toThrow(/time_period/);
    expect(() => validateCfRule({ range: 'A1', priority: 1, type: 'duplicateValues', std_dev: 1 })).toThrow(/aboveAverage/);
    expect(() => validateCfRule({ range: 'A1', priority: 1, type: 'aboveAverage', std_dev: -1 })).toThrow(/std_dev/);
  });
});


/**
 * **X06**：条件格式规则 / 优先级 / dxfs 的**真实 XML 往返**（design-06-P8 / XLS-11 后半）。
 *
 * `conditional-format.test.ts` 只验"写出"；本用例补"读回"：标准块 + dxfs 读回来后**重新编译**
 * 与首次编译**逐字节相同**，并核对 `dxfId` 还原出的 format、优先级、colorScale / dataBar / iconSet。
 */

import { describe, expect, it } from 'vitest';

import {
  buildConditionalFormattingBlocks,
  compileConditionalFormats,
  parseConditionalFormattingBlock,
  parseConditionalFormattingBlocks,
  parseDxfsXml,
  type CfRule,
} from '../../../../src/spreadsheets/conditional-format.js';

function rules(): readonly CfRule[] {
  return [
    {
      range: 'A1:A10',
      priority: 2,
      type: 'cellIs',
      operator: 'greaterThan',
      formulas: ['90'],
      format: { fill_color: 'FFC7CE', font_color: '9C0006' },
    },
    { range: 'A1:A10', priority: 1, type: 'expression', formulas: ['$B1>0'], stop_if_true: true, format: { fill_color: 'C6EFCE' } },
    { range: 'B1:B10', priority: 3, type: 'duplicateValues', format: { font_bold: true, fill_color: 'FFEB9C' } },
    { range: 'D1:D10', priority: 4, type: 'top10', rank: 5, percent: true },
  ];
}

describe('X06 §C1 条件格式往返（标准块 + dxfs）', () => {
  it('写出 → 读回：优先级 / 算子 / 公式 / dxfId 还原出的 format 都在', () => {
    const compiled = compileConditionalFormats(rules());
    const dxfs = parseDxfsXml(compiled.dxfs_xml as string);
    const blocks = buildConditionalFormattingBlocks(compiled.rules, compiled.dxf_ids);
    const back = parseConditionalFormattingBlocks(blocks, dxfs);

    expect(back.length).toBe(4);
    const expression = back.find((rule) => rule.type === 'expression') as CfRule;
    expect(expression.range).toBe('A1:A10');
    expect(expression.priority).toBe(1);
    expect(expression.stop_if_true).toBe(true);
    expect(expression.formulas).toEqual(['$B1>0']);
    expect(expression.format).toEqual({ fill_color: 'FFC6EFCE' });

    const cellIs = back.find((rule) => rule.type === 'cellIs') as CfRule;
    expect(cellIs.operator).toBe('greaterThan');
    expect(cellIs.formulas).toEqual(['90']);
    expect(cellIs.format?.fill_color).toBe('FFFFC7CE');
    expect(cellIs.format?.font_color).toBe('FF9C0006');

    const top10 = back.find((rule) => rule.type === 'top10') as CfRule;
    expect(top10.rank).toBe(5);
    expect(top10.percent).toBe(true);

    // dxfId 不同 ⇒ 还原出的两个差异格式不同（证明按 id 映射，不是共用 0）
    expect(expression.format).not.toEqual(cellIs.format);
  });

  it('字节往返：读回后重新编译，dxfs 与各块与首次逐字节相同', () => {
    const compiled = compileConditionalFormats(rules());
    const dxfs = parseDxfsXml(compiled.dxfs_xml as string);
    const firstBlocks = buildConditionalFormattingBlocks(compiled.rules, compiled.dxf_ids);
    const back = parseConditionalFormattingBlocks(firstBlocks, dxfs);
    const recompiled = compileConditionalFormats(back);

    expect(recompiled.dxfs_xml).toBe(compiled.dxfs_xml);
    expect(buildConditionalFormattingBlocks(recompiled.rules, recompiled.dxf_ids)).toEqual([...firstBlocks]);
  });

  it('colorScale：端点类型 / 值 / 颜色往返一致', () => {
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
    const blocks = buildConditionalFormattingBlocks(compiled.rules, compiled.dxf_ids);
    const back = parseConditionalFormattingBlock(blocks[0] as string, []);
    expect(back[0]?.color_scale).toEqual([
      { type: 'min', color: 'FFF8696B' },
      { type: 'percentile', value: '50', color: 'FFFFEB84' },
      { type: 'max', color: 'FF63BE7B' },
    ]);
    const recompiled = compileConditionalFormats(back);
    expect(buildConditionalFormattingBlocks(recompiled.rules, recompiled.dxf_ids)).toEqual([...blocks]);
  });

  it('dataBar / iconSet：颜色与开关往返一致', () => {
    const bars: readonly CfRule[] = [
      { range: 'C1:C10', priority: 1, type: 'dataBar', data_bar: { color: '638EC6', show_value: false } },
      { range: 'C1:C10', priority: 2, type: 'iconSet', icon_set: { icon_set: '3TrafficLights1', show_value: false } },
    ];
    const compiled = compileConditionalFormats(bars);
    const blocks = buildConditionalFormattingBlocks(compiled.rules, compiled.dxf_ids);
    const back = parseConditionalFormattingBlock(blocks[0] as string, []);
    expect(back[0]?.data_bar?.color).toBe('FF638EC6');
    expect(back[0]?.data_bar?.show_value).toBe(false);
    expect(back[1]?.icon_set?.icon_set).toBe('3TrafficLights1');
    expect(back[1]?.icon_set?.show_value).toBe(false);
    const recompiled = compileConditionalFormats(back);
    expect(buildConditionalFormattingBlocks(recompiled.rules, recompiled.dxf_ids)).toEqual([...blocks]);
  });

  it('反向对照：引用了不存在的 dxfId ⇒ 抛错（不静默当无格式）', () => {
    const block =
      '<conditionalFormatting xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" sqref="A1">' +
      '<cfRule type="expression" dxfId="7" priority="1"><formula>1</formula></cfRule></conditionalFormatting>';
    expect(() => parseConditionalFormattingBlock(block, [])).toThrow(/dxfId/);
    const noPriority =
      '<conditionalFormatting xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" sqref="A1">' +
      '<cfRule type="expression"><formula>1</formula></cfRule></conditionalFormatting>';
    expect(() => parseConditionalFormattingBlock(noPriority, [])).toThrow(/priority/);
  });

  it('dxfs 空表 ⇒ 解析为空数组（反向对照：不产生空白 dxf）', () => {
    const empty = '<dxfs xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0"/>';
    expect(parseDxfsXml(empty).length).toBe(0);
  });
});

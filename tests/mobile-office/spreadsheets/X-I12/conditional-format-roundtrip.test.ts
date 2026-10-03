/**
 * **X-I12**：条件格式**全规则类型**的 `build(parse(build(x))) === build(x)` 恒等（XLS-11 / design-06-P8）。
 *
 * 与 X06 的往返用例互补：X06 只覆盖 expression / cellIs / duplicateValues / top10 / colorScale /
 * dataBar / iconSet 七个类型，本用例把**每一个** `CfRuleType` 都拉进恒等矩阵，并补上此前完全没有
 * 读回能力的形状：
 * - `containsBlanks` / `notContainsBlanks` / `containsErrors` / `notContainsErrors`
 * - `timePeriod`（带 `timePeriod` 属性）
 * - `aboveAverage`（`aboveAverage="0"` / `equalAverage` / `stdDev`）
 * - `iconSet` 的标准块 `reverse` 与 `show_value=true`
 * - 真实 Excel 的**多区域 sqref**（`"A1:A10 C1:C10"`）
 *
 * 判据是两层的：既比较**字节恒等**（重新编译后的块与 dxfs 与原样逐字节相同），也比较**模型保真**
 * （读回后关键字段仍在，不被静默丢成 undefined）。
 */

import { describe, expect, it } from 'vitest';

import {
  buildConditionalFormattingBlocks,
  compileConditionalFormats,
  parseConditionalFormattingBlock,
  parseConditionalFormattingBlocks,
  parseDxfsXml,
  validateCfRule,
  type CfRule,
} from '../../../../src/spreadsheets/conditional-format.js';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

interface CfRoundTrip {
  readonly firstBlocks: readonly string[];
  readonly secondBlocks: readonly string[];
  readonly firstDxfs: string | null;
  readonly secondDxfs: string | null;
  readonly back: readonly CfRule[];
}

/** `build → parse → build` 一次往返，返回两侧产物供断言。 */
function cfRoundTrip(rules: readonly CfRule[]): CfRoundTrip {
  const first = compileConditionalFormats(rules);
  const dxfs = first.dxfs_xml === null ? [] : parseDxfsXml(first.dxfs_xml);
  const firstBlocks = buildConditionalFormattingBlocks(first.rules, first.dxf_ids);
  const back = parseConditionalFormattingBlocks(firstBlocks, dxfs);
  const second = compileConditionalFormats(back);
  const secondBlocks = buildConditionalFormattingBlocks(second.rules, second.dxf_ids);
  return { firstBlocks, secondBlocks, firstDxfs: first.dxfs_xml, secondDxfs: second.dxfs_xml, back };
}

/** 单条规则的往返（优先级固定 1，便于逐条隔离）。 */
function roundTripOne(rule: CfRule): { readonly back: CfRule; readonly trip: CfRoundTrip } {
  const trip = cfRoundTrip([rule]);
  const back = trip.back[0] as CfRule;
  return { back, trip };
}

function expectByteIdentity(trip: CfRoundTrip): void {
  expect(trip.secondBlocks).toEqual([...trip.firstBlocks]);
  expect(trip.secondDxfs).toBe(trip.firstDxfs);
}

const EVERY_KIND: readonly CfRule[] = [
  { range: 'A1', priority: 1, type: 'expression', formulas: ['$B1>0'] },
  { range: 'A1', priority: 1, type: 'cellIs', operator: 'lessThan', formulas: ['1'] },
  { range: 'A1', priority: 1, type: 'cellIs', operator: 'notBetween', formulas: ['1', '9'] },
  { range: 'A1', priority: 1, type: 'containsText', text: 'x', formulas: ['NOT(ISERROR(SEARCH("x",A1)))'] },
  { range: 'A1', priority: 1, type: 'notContainsText', text: 'x', formulas: ['ISERROR(SEARCH("x",A1))'] },
  { range: 'A1', priority: 1, type: 'beginsWith', text: 'x', formulas: ['LEFT(A1,1)="x"'] },
  { range: 'A1', priority: 1, type: 'endsWith', text: 'x', formulas: ['RIGHT(A1,1)="x"'] },
  { range: 'A1', priority: 1, type: 'duplicateValues' },
  { range: 'A1', priority: 1, type: 'uniqueValues' },
  { range: 'A1', priority: 1, type: 'containsBlanks', formulas: ['LEN(TRIM(A1))=0'] },
  { range: 'A1', priority: 1, type: 'notContainsBlanks', formulas: ['LEN(TRIM(A1))>0'] },
  { range: 'A1', priority: 1, type: 'containsErrors', formulas: ['ISERROR(A1)'] },
  { range: 'A1', priority: 1, type: 'notContainsErrors', formulas: ['NOT(ISERROR(A1))'] },
  { range: 'A1', priority: 1, type: 'timePeriod', time_period: 'last7Days', formulas: ['AND(TODAY()-A1<=7,A1<=TODAY())'] },
  { range: 'A1', priority: 1, type: 'top10', rank: 3 },
  { range: 'A1', priority: 1, type: 'top10', rank: 10, percent: true },
  { range: 'A1', priority: 1, type: 'aboveAverage' },
  { range: 'A1', priority: 1, type: 'colorScale', color_scale: [{ type: 'min', color: 'F8696B' }, { type: 'max', color: '63BE7B' }] },
  { range: 'A1', priority: 1, type: 'dataBar', data_bar: { color: '638EC6' } },
  { range: 'A1', priority: 1, type: 'iconSet', icon_set: { icon_set: '3Arrows' } },
];

describe('X-I12 §C1 每一种规则类型的字节恒等', () => {
  for (const rule of EVERY_KIND) {
    it(`${rule.type}${rule.operator === undefined ? '' : `/${rule.operator}`} build(parse(build)) 逐字节相同`, () => {
      expectByteIdentity(roundTripOne(rule).trip);
    });
  }

  it('反向对照：恒等矩阵确实覆盖了 CfRuleType 的每一种取值', () => {
    const kinds = new Set(EVERY_KIND.map((rule) => rule.type));
    for (const type of [
      'cellIs',
      'expression',
      'containsText',
      'notContainsText',
      'beginsWith',
      'endsWith',
      'duplicateValues',
      'uniqueValues',
      'containsBlanks',
      'notContainsBlanks',
      'containsErrors',
      'notContainsErrors',
      'timePeriod',
      'top10',
      'aboveAverage',
      'colorScale',
      'dataBar',
      'iconSet',
    ] as const) {
      expect(kinds.has(type), `矩阵遗漏了类型 ${type}`).toBe(true);
    }
    expect(kinds.size).toBe(18);
  });
});

describe('X-I12 §C2 新类型读回保真（此前无覆盖）', () => {
  it('containsBlanks 家族：类型与公式原样读回', () => {
    for (const type of ['containsBlanks', 'notContainsBlanks', 'containsErrors', 'notContainsErrors'] as const) {
      const { back } = roundTripOne({ range: 'A1', priority: 1, type, formulas: ['LEN(TRIM(A1))=0'] });
      expect(back.type).toBe(type);
      expect(back.formulas).toEqual(['LEN(TRIM(A1))=0']);
    }
  });

  it('timePeriod：周期枚举原样读回', () => {
    for (const time_period of ['today', 'last7Days', 'thisMonth', 'nextWeek'] as const) {
      const { back } = roundTripOne({ range: 'A1', priority: 1, type: 'timePeriod', time_period });
      expect(back.time_period).toBe(time_period);
    }
  });

  it('aboveAverage：aboveAverage="0" / equalAverage / stdDev 三态保真', () => {
    const under = roundTripOne({ range: 'A1', priority: 1, type: 'aboveAverage', above_average: false }).back;
    expect(under.above_average).toBe(false);
    const equal = roundTripOne({ range: 'A1', priority: 1, type: 'aboveAverage', equal_average: true }).back;
    expect(equal.equal_average).toBe(true);
    const dev = roundTripOne({ range: 'A1', priority: 1, type: 'aboveAverage', std_dev: 2 }).back;
    expect(dev.std_dev).toBe(2);
    // 显式 true 也读写一致（写出 aboveAverage="1"）
    expect(roundTripOne({ range: 'A1', priority: 1, type: 'aboveAverage', above_average: true }).back.above_average).toBe(true);
  });
});

describe('X-I12 §C3 dataBar / iconSet 开关与 reverse 保真', () => {
  it('dataBar show_value=true / false 都读回布尔（不再丢成 undefined）', () => {
    expect(roundTripOne({ range: 'A1', priority: 1, type: 'dataBar', data_bar: { color: '638EC6', show_value: true } }).back.data_bar?.show_value).toBe(true);
    expect(roundTripOne({ range: 'A1', priority: 1, type: 'dataBar', data_bar: { color: '638EC6', show_value: false } }).back.data_bar?.show_value).toBe(false);
  });

  it('iconSet show_value / reverse 在标准块里也保真', () => {
    const back = roundTripOne({
      range: 'A1',
      priority: 1,
      type: 'iconSet',
      icon_set: { icon_set: '4Rating', show_value: true, reverse: true },
    }).back;
    expect(back.icon_set?.show_value).toBe(true);
    expect(back.icon_set?.reverse).toBe(true);
    // 字节恒等仍成立（reverse 现在是写出侧的一部分）
    expect(roundTripOne({ range: 'A1', priority: 1, type: 'iconSet', icon_set: { icon_set: '4Rating', reverse: true } }).trip.firstBlocks[0]).toContain('reverse="1"');
  });
});

describe('X-I12 §C4 dxf 差异格式', () => {
  it('fill / font / bold / border 各自与组合都字节恒等', () => {
    for (const format of [
      { fill_color: 'FFC7CE' },
      { font_color: '9C0006' },
      { font_bold: true },
      { border_color: 'FF0000' },
      { fill_color: 'FFC7CE', font_color: '9C0006', font_bold: true, border_color: '1F0000' },
    ]) {
      const { back, trip } = roundTripOne({ range: 'A1', priority: 1, type: 'expression', formulas: ['1'], format });
      expectByteIdentity(trip);
      expect(back.format).toBeDefined();
      if (format.fill_color !== undefined) expect(back.format?.fill_color).toBe(format.fill_color.length === 6 ? `FF${format.fill_color}` : format.fill_color);
      if (format.font_bold === true) expect(back.format?.font_bold).toBe(true);
      if (format.border_color !== undefined) expect(back.format?.border_color).toBe(format.border_color.length === 6 ? `FF${format.border_color}` : format.border_color);
    }
  });

  it('同色不同大小写去重为一条 dxf，两条规则共享同一 dxfId', () => {
    const trip = cfRoundTrip([
      { range: 'A1', priority: 1, type: 'expression', formulas: ['1'], format: { fill_color: 'FFC7CE' } },
      { range: 'A2', priority: 2, type: 'expression', formulas: ['2'], format: { fill_color: 'ffc7ce' } },
    ]);
    expectByteIdentity(trip);
    const dxfs = parseDxfsXml(trip.firstDxfs as string);
    expect(dxfs.length).toBe(1);
  });

  it('真实 Excel 形状：dxf 填充用 fgColor 而非 bgColor 时仍读回颜色', () => {
    const dxfs =
      `<dxfs xmlns="${NS}" count="1"><dxf><fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/></patternFill></fill></dxf></dxfs>`;
    const parsed = parseDxfsXml(dxfs);
    expect(parsed[0]?.fill_color).toBe('FFFFC7CE');
  });
});

describe('X-I12 §C5 多区域 sqref（真实 Excel 形状）', () => {
  it('一条 sqref 里的多个不连续区域原样读回并字节恒等', () => {
    const block =
      `<conditionalFormatting xmlns="${NS}" sqref="A1:A10 C1:C10"><cfRule type="expression" priority="1"><formula>1</formula></cfRule></conditionalFormatting>`;
    const back = parseConditionalFormattingBlock(block, []);
    expect(back.length).toBe(1);
    expect(back[0]?.range).toBe('A1:A10 C1:C10');
    // 读回后再编译，sqref 仍是同一串（不会被拆散或改写）
    const recompiled = compileConditionalFormats(back);
    const rebuilt = buildConditionalFormattingBlocks(recompiled.rules, recompiled.dxf_ids);
    expect(rebuilt[0]).toContain('sqref="A1:A10 C1:C10"');
  });

  it('反向对照：sqref 里夹一个非法区域 token ⇒ 抛错（不放行畸形）', () => {
    const block =
      `<conditionalFormatting xmlns="${NS}" sqref="A1:A10 不是区域"><cfRule type="expression" priority="1"><formula>1</formula></cfRule></conditionalFormatting>`;
    expect(() => parseConditionalFormattingBlock(block, [])).toThrow(/无法解析/);
  });
});

describe('X-I12 §C6 反向对照：畸形与非法形状', () => {
  it('新类型的字段约束仍然生效', () => {
    expect(() => validateCfRule({ range: 'A1', priority: 1, type: 'timePeriod' })).toThrow(/time_period/);
    expect(() => validateCfRule({ range: 'A1', priority: 1, type: 'timePeriod', time_period: '不存在的周期' as never })).toThrow(/time_period/);
    expect(() => validateCfRule({ range: 'A1', priority: 1, type: 'aboveAverage', std_dev: -1 })).toThrow(/std_dev/);
    expect(() => validateCfRule({ range: 'A1', priority: 1, type: 'duplicateValues', above_average: false })).toThrow(/aboveAverage/);
    expect(() => validateCfRule({ range: 'A1', priority: 1, type: 'expression', formulas: ['1'], time_period: 'today' })).toThrow(/timePeriod/);
  });

  it('读回时同样用同一把尺子：timePeriod 缺周期 / 未知周期 ⇒ 抛错', () => {
    const missing = `<conditionalFormatting xmlns="${NS}" sqref="A1"><cfRule type="timePeriod" priority="1"/></conditionalFormatting>`;
    expect(() => parseConditionalFormattingBlock(missing, [])).toThrow(/time_period/);
    const unknown = `<conditionalFormatting xmlns="${NS}" sqref="A1"><cfRule type="timePeriod" priority="1" timePeriod="whenever"/></conditionalFormatting>`;
    expect(() => parseConditionalFormattingBlock(unknown, [])).toThrow(/time_period/);
  });
});

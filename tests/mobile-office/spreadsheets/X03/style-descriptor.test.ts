/**
 * **X03**：XLSX 样式描述符与 `cellXfs` 生成（design-06-P8 / XLS-05）。
 *
 * 判据来自 OOXML 语义，不照抄实现。七组：
 *
 * 1. **去重**：同样式必得同一下标；输入顺序无关（`[A,B]` 与 `[B,A]` 逐字节同输出）；
 * 2. **反面对照（咬得住）**：视觉不同的两样式**不得**被并成同一下标（粗体 vs 常规、
 *    红底 vs 蓝底、两位小数 vs 三位、居中 vs 左对齐）；
 * 3. **真实 numFmt**：百分比 / 货币 / 日期走 ECMA-376 内建 id 或真实格式码，不自造；
 *    不支持的数字格式**必须报错**；
 * 4. **原值 vs 显示值**：`0.15` 配百分比 ⇒ 显示 `15%`，原值仍是 `0.15`；
 * 5. **applyXxx 标志**：只在该属性真正生效时出现；
 * 6. **保留槽位**：`fonts[0]` / `fills[0..1]` / `borders[0]` / `cellXfs[0]` 符合 Excel 约定；
 * 7. **不静默丢弃**：未知键报错、`none` 边框降级进 `warnings`。
 */

import { describe, expect, it } from 'vitest';

import { ValidationError } from '../../../../src/protocol/index.js';
import { fromExcelSerial } from '../../../../src/spreadsheets/excel-date.js';
import { formatDatePattern, type CellNumberFormat, type CellStyle } from '../../../../src/spreadsheets/styles.js';
import {
  BUILTIN_NUMFMT_CODES,
  EMPTY_STYLE_KEY,
  buildStyleTable,
  buildStyleXmlParts,
  describeNumberFormat,
  renderNumberDisplay,
  renderStyleTableXml,
  styleKey,
} from '../../../../src/spreadsheets/style-parts/index.js';

/** 取某样式在表里的下标。 */
function indexOf(table: ReturnType<typeof buildStyleTable>, style: CellStyle): number {
  const index = table.indexByKey.get(styleKey(style));
  if (index === undefined) throw new Error(`样式未在表中：${JSON.stringify(style)}`);
  return index;
}

// ---------------------------------------------------------------------------
// 1. 去重 + 顺序无关
// ---------------------------------------------------------------------------

describe('X03 §1 去重与确定性', () => {
  it('相同样式重复传入只占一个 cellXfs 项', () => {
    const table = buildStyleTable([{ bold: true }, { bold: true }, { bold: true }]);
    // 0 = 默认，1 = 粗体；共两项。
    expect(table.cellXfs.length).toBe(2);
    expect(indexOf(table, { bold: true })).toBe(1);
    expect(table.fonts.length).toBe(2); // 默认 + 粗体
  });

  it('输入顺序无关：两个集合互为倒序得到逐字节相同的 XML', () => {
    const a: CellStyle = { bold: true, font_color: '#FF0000' };
    const b: CellStyle = { fill_color: '#00FF00', horizontal_align: 'center' };
    const forward = JSON.stringify(renderStyleTableXml(buildStyleTable([a, b])));
    const backward = JSON.stringify(renderStyleTableXml(buildStyleTable([b, a])));
    expect(forward).toBe(backward);
  });

  it('空样式命中默认槽位 0', () => {
    const table = buildStyleTable([]);
    expect(table.cellXfs.length).toBe(1);
    expect(table.indexByKey.get(EMPTY_STYLE_KEY)).toBe(0);
    expect(table.cellXfs[0]).toMatchObject({ numFmtId: 0, fontId: 0, fillId: 0, borderId: 0 });
  });

  it('键序无关：字段书写顺序不影响去重键', () => {
    expect(styleKey({ bold: true, font_size: 12 })).toBe(styleKey({ font_size: 12, bold: true }));
  });
});

// ---------------------------------------------------------------------------
// 2. 反面对照：不同样式绝不合并（负例咬合点）
// ---------------------------------------------------------------------------

describe('X03 §2 反面对照：两个不同样式不得被去重成同一个', () => {
  it('粗体 vs 常规：不同键、不同下标、不同 fontId', () => {
    const table = buildStyleTable([{ bold: true }]);
    const bold = indexOf(table, { bold: true });
    const plain = table.indexByKey.get(EMPTY_STYLE_KEY) as number;
    expect(bold).not.toBe(plain);
    expect(table.cellXfs[bold]?.fontId).not.toBe(table.cellXfs[plain]?.fontId);
  });

  it('红底 vs 蓝底：不同 fillId', () => {
    const table = buildStyleTable([{ fill_color: '#FF0000' }, { fill_color: '#0000FF' }]);
    const red = indexOf(table, { fill_color: '#FF0000' });
    const blue = indexOf(table, { fill_color: '#0000FF' });
    expect(red).not.toBe(blue);
    expect(table.cellXfs[red]?.fillId).not.toBe(table.cellXfs[blue]?.fillId);
    expect(table.fills.length).toBe(4); // none + gray125 + 红 + 蓝
  });

  it('两位小数 vs 三位小数：不同 numFmtId', () => {
    const table = buildStyleTable([
      { number_format: { kind: 'number', decimals: 2, grouping: false } },
      { number_format: { kind: 'number', decimals: 3, grouping: false } },
    ]);
    const two = indexOf(table, { number_format: { kind: 'number', decimals: 2, grouping: false } });
    const three = indexOf(table, { number_format: { kind: 'number', decimals: 3, grouping: false } });
    expect(two).not.toBe(three);
    expect(table.cellXfs[two]?.numFmtId).toBe(2); // 内建 0.00
    expect(table.cellXfs[three]?.numFmtId).not.toBe(2); // 自定义 0.000
    expect(table.cellXfs[three]?.numFmtId).toBeGreaterThanOrEqual(164);
  });

  it('居中 vs 左对齐：不同下标', () => {
    const table = buildStyleTable([{ horizontal_align: 'center' }, { horizontal_align: 'left' }]);
    expect(indexOf(table, { horizontal_align: 'center' })).not.toBe(
      indexOf(table, { horizontal_align: 'left' }),
    );
  });

  it('细边框 vs 粗边框：不同 borderId', () => {
    const thin: CellStyle = { borders: { top: { style: 'thin', color: '#000000' } } };
    const thick: CellStyle = { borders: { top: { style: 'thick', color: '#000000' } } };
    const table = buildStyleTable([thin, thick]);
    const a = indexOf(table, thin);
    const b = indexOf(table, thick);
    expect(a).not.toBe(b);
    expect(table.cellXfs[a]?.borderId).not.toBe(table.cellXfs[b]?.borderId);
  });
});

// ---------------------------------------------------------------------------
// 3. 真实 numFmt
// ---------------------------------------------------------------------------

describe('X03 §3 数字格式走真实 numFmt', () => {
  it('百分号 0.00% 用内建 id 10，且与 ECMA 表一致', () => {
    const resolved = describeNumberFormat({ kind: 'percent', decimals: 2 });
    expect(resolved.numFmtId).toBe(10);
    expect(resolved.formatCode).toBeNull();
    expect(BUILTIN_NUMFMT_CODES[10]).toBe('0.00%');
  });

  it('千分位两位用内建 id 4（#,##0.00）', () => {
    const resolved = describeNumberFormat({ kind: 'number', decimals: 2, grouping: true });
    expect(resolved.numFmtId).toBe(4);
    expect(BUILTIN_NUMFMT_CODES[4]).toBe('#,##0.00');
  });

  it('未知小数位数 1：退回自定义码 0.0%，非内建', () => {
    const resolved = describeNumberFormat({ kind: 'percent', decimals: 1 });
    expect(resolved.numFmtId).toBeNull();
    expect(resolved.formatCode).toBe('0.0%');
  });

  it('货币：符号放进引号字面量的真实格式码，自定义 id ≥ 164', () => {
    const table = buildStyleTable([{ number_format: { kind: 'currency', currency: 'CNY', decimals: 2 } }]);
    expect(table.numFmts.length).toBe(1);
    const entry = table.numFmts[0];
    expect(entry?.formatCode).toBe('"¥"#,##0.00');
    expect(entry?.numFmtId).toBeGreaterThanOrEqual(164);
    expect(indexOf(table, { number_format: { kind: 'currency', currency: 'CNY', decimals: 2 } })).toBe(1);
    expect(table.cellXfs[1]?.numFmtId).toBe(entry?.numFmtId);
  });

  it('date m/d/yyyy 用内建 14；yyyy-mm-dd 用真实自定义码', () => {
    expect(describeNumberFormat({ kind: 'date', pattern: 'm/d/yyyy' }).numFmtId).toBe(14);
    const custom = describeNumberFormat({ kind: 'date', pattern: 'yyyy-mm-dd' });
    expect(custom.numFmtId).toBeNull();
    expect(custom.formatCode).toBe('yyyy-mm-dd');
  });

  it('general 不写 applyNumberFormat', () => {
    const resolved = describeNumberFormat({ kind: 'general' });
    expect(resolved.numFmtId).toBe(0);
    expect(resolved.applyNumberFormat).toBe(false);
  });

  it('自定义 numFmt id 按格式码字典序确定分配', () => {
    const table = buildStyleTable([
      { number_format: { kind: 'currency', currency: 'CNY', decimals: 2 } }, // "¥"…
      { number_format: { kind: 'currency', currency: 'USD', decimals: 2 } }, // "$"…
    ]);
    const codes = table.numFmts.map((f) => f.formatCode);
    expect(codes).toEqual([...codes].sort()); // 已排序
    expect(table.numFmts.map((f) => f.numFmtId)).toEqual([164, 165]);
    // '$'(0x24) 字典序在 '¥'(0xA5) 之前。
    expect(table.numFmts[0]?.formatCode).toBe('"$"#,##0.00');
  });

  // --- 反面对照：不支持的数字格式必须报错 ---

  it('反面对照：小数位数超上限必须报错', () => {
    expect(() => describeNumberFormat({ kind: 'number', decimals: 99, grouping: false })).toThrow(
      ValidationError,
    );
  });

  it('反面对照：非整数小数位必须报错', () => {
    expect(() => describeNumberFormat({ kind: 'percent', decimals: 1.5 })).toThrow(ValidationError);
  });

  it('反面对照：负数小数位必须报错', () => {
    expect(() => describeNumberFormat({ kind: 'number', decimals: -1, grouping: false })).toThrow(
      ValidationError,
    );
  });

  it('反面对照：未知 kind 必须报错（不得静默当 general）', () => {
    const bogus = { kind: 'scientific' } as unknown as CellNumberFormat;
    expect(() => describeNumberFormat(bogus)).toThrow(ValidationError);
    expect(() => buildStyleTable([{ number_format: bogus }])).toThrow(ValidationError);
  });

  it('反面对照：未知货币码必须报错', () => {
    const bogus = { kind: 'currency', currency: 'BTC', decimals: 2 } as unknown as CellNumberFormat;
    expect(() => describeNumberFormat(bogus)).toThrow(ValidationError);
  });

  it('反面对照：未知日期图案必须报错', () => {
    const bogus = { kind: 'date', pattern: 'yyyy' } as unknown as CellNumberFormat;
    expect(() => describeNumberFormat(bogus)).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// 4. 原值 vs 显示值
// ---------------------------------------------------------------------------

describe('X03 §4 原值与显示值分开', () => {
  it('0.15 配百分比格式：显示 15%，原值不变', () => {
    const result = renderNumberDisplay(0.15, { kind: 'percent', decimals: 0 });
    expect(result.display).toBe('15%');
    expect(result.value).toBe(0.15); // 未被乘 100 回写
  });

  it('0.15 配两位百分比：显示 15.00%', () => {
    expect(renderNumberDisplay(0.15, { kind: 'percent', decimals: 2 }).display).toBe('15.00%');
  });

  it('千分位与货币只改显示', () => {
    expect(renderNumberDisplay(1234.5, { kind: 'number', decimals: 2, grouping: true }).display).toBe(
      '1,234.50',
    );
    const cur = renderNumberDisplay(1234.5, { kind: 'currency', currency: 'CNY', decimals: 2 });
    expect(cur.display).toBe('¥1,234.50');
    expect(cur.value).toBe(1234.5);
  });

  it('数值格套日期格式：按 Excel 序列号显示，原值不变', () => {
    const result = renderNumberDisplay(45000, { kind: 'date', pattern: 'yyyy-mm-dd' });
    expect(result.display).toBe(formatDatePattern(fromExcelSerial(45000), 'yyyy-mm-dd'));
    expect(result.value).toBe(45000);
  });

  it('负数货币保留符号', () => {
    expect(renderNumberDisplay(-12, { kind: 'currency', currency: 'USD', decimals: 2 }).display).toBe(
      '-$12.00',
    );
  });

  it('general 就是裸数字文本', () => {
    expect(renderNumberDisplay(0.15, undefined).display).toBe('0.15');
  });
});

// ---------------------------------------------------------------------------
// 5. applyXxx 标志
// ---------------------------------------------------------------------------

describe('X03 §5 applyXxx 标志只在属性生效时出现', () => {
  it('默认 xf 无任何 apply 标志', () => {
    const table = buildStyleTable([]);
    expect(table.cellXfs[0]).toMatchObject({
      applyFont: false,
      applyFill: false,
      applyBorder: false,
      applyAlignment: false,
      applyNumberFormat: false,
    });
    const xml = renderStyleTableXml(table).cellXfs;
    expect(xml).toContain('<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>');
  });

  it('粗体 ⇒ applyFont，底纹 ⇒ applyFill，百分比 ⇒ applyNumberFormat', () => {
    const table = buildStyleTable([
      { bold: true },
      { fill_color: '#FFCC00' },
      { number_format: { kind: 'percent', decimals: 0 } },
    ]);
    const xml = renderStyleTableXml(table).cellXfs;
    expect(xml).toContain('applyFont="1"');
    expect(xml).toContain('applyFill="1"');
    expect(xml).toContain('applyNumberFormat="1"');
    const boldXf = table.cellXfs[indexOf(table, { bold: true })];
    expect(boldXf?.applyFont).toBe(true);
    expect(boldXf?.applyFill).toBe(false);
    const fillXf = table.cellXfs[indexOf(table, { fill_color: '#FFCC00' })];
    expect(fillXf?.applyFill).toBe(true);
    expect(fillXf?.applyFont).toBe(false);
  });

  it('对齐 ⇒ applyAlignment + <alignment> 子元素', () => {
    const table = buildStyleTable([{ horizontal_align: 'center', wrap_text: true, indent: 1 }]);
    const xml = renderStyleTableXml(table).cellXfs;
    expect(xml).toContain('applyAlignment="1"');
    expect(xml).toContain('<alignment horizontal="center" wrapText="1" indent="1"/>');
  });

  it('边框 ⇒ applyBorder + 真实边线 + ARGB 颜色', () => {
    const table = buildStyleTable([{ borders: { top: { style: 'thin', color: '#FF0000' } } }]);
    const xml = renderStyleTableXml(table).borders;
    expect(xml).toContain('<top style="thin"><color rgb="FFFF0000"/></top>');
    expect(xml).toContain('<bottom/>');
    const xf = table.cellXfs[indexOf(table, { borders: { top: { style: 'thin', color: '#FF0000' } } })];
    expect(xf?.applyBorder).toBe(true);
  });

  it('字体色 ⇒ <color rgb="ARGB"/>', () => {
    const table = buildStyleTable([{ font_color: '#123456' }]);
    const xml = renderStyleTableXml(table).fonts;
    expect(xml).toContain('<color rgb="FF123456"/>');
  });

  it('自定义 numFmt 渲染进 XML 且引号被转义', () => {
    const parts = buildStyleXmlParts([{ number_format: { kind: 'currency', currency: 'CNY', decimals: 2 } }]);
    expect(parts.numFmts).toContain('formatCode="&quot;¥&quot;#,##0.00"');
  });
});

// ---------------------------------------------------------------------------
// 6. 保留槽位
// ---------------------------------------------------------------------------

describe('X03 §6 Excel 保留槽位', () => {
  it('fonts[0]=Calibri 11，fills[0]=none 且 fills[1]=gray125，borders[0]=全空', () => {
    const table = buildStyleTable([]);
    expect(table.fonts[0]).toMatchObject({ name: 'Calibri', size: 11, bold: false });
    expect(table.fills[0]?.pattern).toBe('none');
    expect(table.fills[1]?.pattern).toBe('gray125');
    expect(table.borders[0]).toMatchObject({ top: null, bottom: null, left: null, right: null });
    const parts = renderStyleTableXml(table);
    expect(parts.fonts).toContain('<fonts count="1">');
    expect(parts.fills).toContain('<patternFill patternType="none"/>');
    expect(parts.fills).toContain('<patternFill patternType="gray125"/>');
  });
});

// ---------------------------------------------------------------------------
// 7. 不静默丢弃
// ---------------------------------------------------------------------------

describe('X03 §7 未知 / 无法表达的样式不静默丢弃', () => {
  it('反面对照：未知顶层键必须报错', () => {
    const bogus = { bold: true, shadow: true } as unknown as CellStyle;
    expect(() => buildStyleTable([bogus])).toThrow(ValidationError);
  });

  it('反面对照：number_format 内多余键必须报错', () => {
    const bogus = {
      number_format: { kind: 'number', decimals: 2, grouping: false, showZero: true },
    } as unknown as CellStyle;
    expect(() => buildStyleTable([bogus])).toThrow(ValidationError);
  });

  it('反面对照：borders 内未知边名必须报错', () => {
    const bogus = { borders: { diagonal: { style: 'thin', color: null } } } as unknown as CellStyle;
    expect(() => buildStyleTable([bogus])).toThrow(ValidationError);
  });

  it('none 边框如实降级为无边框，并记入 warnings（不静默）', () => {
    const style: CellStyle = { borders: { top: { style: 'none', color: '#000000' } } };
    const table = buildStyleTable([style]);
    expect(table.warnings.length).toBe(1);
    expect(table.warnings[0]).toContain('none');
    // 四边皆无 ⇒ 命中默认 borderId 0。
    expect(table.cellXfs[indexOf(table, style)]?.borderId).toBe(0);
  });

  it('降级提示不重复记账（每条描述符只解析一次）', () => {
    const style: CellStyle = { borders: { top: { style: 'none', color: null } } };
    const table = buildStyleTable([style, style]);
    expect(table.warnings.length).toBe(1);
  });
});

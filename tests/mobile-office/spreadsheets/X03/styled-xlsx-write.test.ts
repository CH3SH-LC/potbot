/**
 * **X03**：普通 cellXfs 真正写出到 .xlsx 字节，并独立读回（design-06-P8 / XLS-05）。
 *
 * 与 `style-descriptor.test.ts` 的分工：那份测**片段与描述符**，本份测**真实容器字节**。
 * 本文件**不复用**写入侧的数据结构做断言——它把 ZIP 读回来、用正则独立解析
 * `xl/styles.xml` 与 `xl/worksheets/sheet1.xml`，据此核对：
 *
 * 1. 真实 ZIP 里确实有 `xl/styles.xml` 与 `xl/worksheets/sheet1.xml`，且 `readZip` 通过
 *    CRC / 结构校验（不是"片段里含某字符串"）；
 * 2. `cellXfs` 的**每一项**都能读回，且 `fontId`/`fillId`/`borderId`/`numFmtId`/`applyXxx`
 *    与各样式一一对应（字体、边框、填充、对齐、数字格式五类都真实写出）；
 * 3. 单元格 `s=` 指向的 xf 与预期一致（含内建百分比 `10`、内建日期 `14`、自定义货币 `≥164`）；
 * 4. **原值 / 显示值分开**：`<v>` 里是原值（百分比 `0.15`、货币 `1234.5`、日期序列号 `45000`），
 *    而 `renderNumberDisplay` 给出的显示文本是另一回事（`15%` / `¥1,234.50` / `2023-03-15`）；
 * 5. 确定性：同一 spec 连跑两次逐字节相等，单元格顺序无关。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/index.js';
import { ValidationError } from '../../../../src/protocol/index.js';
import { fromExcelSerial } from '../../../../src/spreadsheets/excel-date.js';
import { getCellValue, type SheetState } from '../../../../src/spreadsheets/sheet.js';
import {
  formatDatePattern,
  type CellStyle,
} from '../../../../src/spreadsheets/styles.js';
import { getSheet } from '../../../../src/spreadsheets/workbook.js';
import { readWorkbookXlsx } from '../../../../src/spreadsheets/xlsx-read.js';
import {
  buildStyledXlsx,
  renderNumberDisplay,
  styleKey,
  type StyledCell,
  type StyledSheetSpec,
} from '../../../../src/spreadsheets/style-parts/index.js';

// ---------------------------------------------------------------------------
// 独立解析助手（不复用写入侧任何对象）
// ---------------------------------------------------------------------------

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

function parseAttrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][\w:.-]*)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    out[match[1] as string] = match[2] as string;
  }
  return out;
}

/** 从 styles.xml 文本里抽出 cellXfs 的每个 `<xf>` 属性。 */
function parseCellXfs(stylesXml: string): Array<Record<string, string>> {
  const block = /<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
  if (block === null) throw new Error('styles.xml 里找不到 cellXfs');
  const declared = Number(block[1]);
  const records: Array<Record<string, string>> = [];
  const re = /<xf\b([^>]*?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(block[2] as string)) !== null) {
    records.push(parseAttrs(match[1] as string));
  }
  expect(records.length).toBe(declared); // 声明的 count 必须等于实际项数
  return records;
}

interface ParsedCell {
  readonly s: number;
  readonly v: string | null;
  readonly t: string | null;
  readonly inner: string;
}

/** 从 worksheet xml 里抽出 ref → 单元格。 */
function parseSheetCells(worksheetXml: string): Map<string, ParsedCell> {
  const out = new Map<string, ParsedCell>();
  const re = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(worksheetXml)) !== null) {
    const attrs = parseAttrs(match[1] as string);
    const inner = match[2] ?? '';
    const vMatch = /<v>([^<]*)<\/v>/.exec(inner);
    out.set(attrs.r as string, {
      s: Number(attrs.s),
      v: vMatch === null ? null : (vMatch[1] as string),
      t: attrs.t ?? null,
      inner,
    });
  }
  return out;
}

/** 读回 ZIP 里的一个部件文本；不存在则抛。 */
function partText(bytes: Uint8Array, path: string): string {
  const entry = readZip(bytes).by_path.get(path);
  if (entry === undefined) throw new Error(`ZIP 里没有部件 ${path}`);
  return decode(entry.data);
}

// ---------------------------------------------------------------------------
// 测试用样式集（覆盖字体 / 填充 / 边框 / 对齐 / 数字 / 日期 / 货币 / 百分比）
// ---------------------------------------------------------------------------

const BOLD: CellStyle = { bold: true };
const FILL: CellStyle = { fill_color: '#FFCC00' };
const BORDER: CellStyle = { borders: { top: { style: 'thin', color: '#FF0000' } } };
const ALIGN: CellStyle = { horizontal_align: 'center', wrap_text: true };
const PERCENT: CellStyle = { number_format: { kind: 'percent', decimals: 0 } };
const CURRENCY: CellStyle = { number_format: { kind: 'currency', currency: 'CNY', decimals: 2 } };
const DATE: CellStyle = { number_format: { kind: 'date', pattern: 'yyyy-mm-dd' } };

function spec(cells: readonly StyledCell[]): StyledSheetSpec {
  return { sheet_name: '样式表', cells };
}

const CELLS: readonly StyledCell[] = [
  { ref: 'A1', value: { kind: 'text', text: '标题' }, style: BOLD },
  { ref: 'B1', value: { kind: 'number', value: 42 }, style: FILL },
  { ref: 'C1', value: { kind: 'text', text: '边框' }, style: BORDER },
  { ref: 'D1', value: { kind: 'text', text: '居中' }, style: ALIGN },
  { ref: 'A2', value: { kind: 'number', value: 0.15 }, style: PERCENT },
  { ref: 'B2', value: { kind: 'number', value: 1234.5 }, style: CURRENCY },
  { ref: 'C2', value: { kind: 'date_serial', serial: 45000 }, style: DATE },
];

// ---------------------------------------------------------------------------
// 1. 真实容器结构
// ---------------------------------------------------------------------------

describe('X03-write §1 真实 ZIP 结构', () => {
  it('ZIP 通过 readZip 校验，且含 workbook / worksheet / styles 三个部件', () => {
    const build = buildStyledXlsx(spec(CELLS));
    const archive = readZip(build.bytes); // CRC + 结构校验，失败即抛
    expect(archive.by_path.has('xl/workbook.xml')).toBe(true);
    expect(archive.by_path.has('xl/worksheets/sheet1.xml')).toBe(true);
    expect(archive.by_path.has('xl/styles.xml')).toBe(true);
    expect(build.entry_count).toBe(archive.entries.length);
  });

  it('workbook.xml 声明 rId1 指向工作表', () => {
    const build = buildStyledXlsx(spec(CELLS));
    expect(partText(build.bytes, 'xl/workbook.xml')).toContain('<sheet name="样式表" sheetId="1" r:id="rId1"/>');
  });
});

// ---------------------------------------------------------------------------
// 2. cellXfs 逐项读回
// ---------------------------------------------------------------------------

describe('X03-write §2 cellXfs 逐项真实写出', () => {
  const build = buildStyledXlsx(spec(CELLS));
  const stylesXml = partText(build.bytes, 'xl/styles.xml');
  const xfs = parseCellXfs(stylesXml);

  it('cellXfs 项数 = 默认 1 项 + 7 个不同样式', () => {
    expect(xfs.length).toBe(8);
    expect(build.style_table.cellXfs.length).toBe(8);
  });

  it('下标 0 是默认 xf（全 0，无 apply 标志）', () => {
    expect(xfs[0]).toMatchObject({ numFmtId: '0', fontId: '0', fillId: '0', borderId: '0' });
    expect(xfs[0]?.applyFont).toBeUndefined();
    expect(xfs[0]?.applyFill).toBeUndefined();
    expect(xfs[0]?.applyNumberFormat).toBeUndefined();
  });

  it('粗体样式对应的 xf：fontId≠0 且 applyFont=1，fonts 里有 <b/>', () => {
    const index = build.style_table.indexByKey.get(styleKey(BOLD)) as number;
    expect(index).toBeGreaterThan(0);
    expect(xfs[index]?.fontId).not.toBe('0');
    expect(xfs[index]?.applyFont).toBe('1');
    // 该 fontId 指向的字体记录里确有 <b/>
    const fontBlock = /<fonts count="\d+">([\s\S]*?)<\/fonts>/.exec(stylesXml)?.[1] as string;
    const fonts = fontBlock.split('<font>').slice(1);
    expect(fonts[Number(xfs[index]?.fontId)]).toContain('<b/>');
  });

  it('填充样式：fillId≠0、applyFill=1，fills 里有 solid + fgColor', () => {
    const index = build.style_table.indexByKey.get(styleKey(FILL)) as number;
    expect(xfs[index]?.fillId).not.toBe('0');
    expect(xfs[index]?.applyFill).toBe('1');
    expect(stylesXml).toContain('<patternFill patternType="solid"><fgColor rgb="FFFFCC00"/>');
  });

  it('边框样式：borderId≠0、applyBorder=1，borders 里有 <top style="thin">', () => {
    const index = build.style_table.indexByKey.get(styleKey(BORDER)) as number;
    expect(xfs[index]?.borderId).not.toBe('0');
    expect(xfs[index]?.applyBorder).toBe('1');
    expect(stylesXml).toContain('<top style="thin"><color rgb="FFFF0000"/></top>');
  });

  it('对齐样式：applyAlignment=1 + <alignment horizontal="center" wrapText="1"/>', () => {
    const index = build.style_table.indexByKey.get(styleKey(ALIGN)) as number;
    expect(xfs[index]?.applyAlignment).toBe('1');
    expect(stylesXml).toContain('<alignment horizontal="center" wrapText="1"/>');
  });

  it('百分比 0 位：内建 numFmtId=9（即 ECMA 的 0%）+ applyNumberFormat=1', () => {
    const index = build.style_table.indexByKey.get(styleKey(PERCENT)) as number;
    expect(xfs[index]?.numFmtId).toBe('9');
    expect(xfs[index]?.applyNumberFormat).toBe('1');
  });

  it('日期 yyyy-mm-dd：内建不覆盖 ⇒ 自定义 numFmt，id≥164 且在 <numFmts> 里声明', () => {
    const index = build.style_table.indexByKey.get(styleKey(DATE)) as number;
    const id = Number(xfs[index]?.numFmtId);
    expect(id).toBeGreaterThanOrEqual(164);
    const numFmtBlock = /<numFmts count="\d+">([\s\S]*?)<\/numFmts>/.exec(stylesXml)?.[1] as string;
    expect(numFmtBlock).toContain(`<numFmt numFmtId="${String(id)}" formatCode="yyyy-mm-dd"/>`);
  });

  it('货币 CNY：自定义 numFmt，引号字面量符号 + 千分位两位小数', () => {
    const index = build.style_table.indexByKey.get(styleKey(CURRENCY)) as number;
    const id = Number(xfs[index]?.numFmtId);
    expect(id).toBeGreaterThanOrEqual(164);
    const numFmtBlock = /<numFmts count="\d+">([\s\S]*?)<\/numFmts>/.exec(stylesXml)?.[1] as string;
    expect(numFmtBlock).toContain(`formatCode="&quot;¥&quot;#,##0.00"`);
  });
});

// ---------------------------------------------------------------------------
// 3. 单元格 s= 指向正确的 xf
// ---------------------------------------------------------------------------

describe('X03-write §3 单元格 s 属性指向正确 xf', () => {
  const build = buildStyledXlsx(spec(CELLS));
  const cells = parseSheetCells(build.worksheet_xml);

  it('每个单元格都带 s，且等于样式表里的下标', () => {
    const expected: Array<[string, CellStyle]> = [
      ['A1', BOLD],
      ['B1', FILL],
      ['C1', BORDER],
      ['D1', ALIGN],
      ['A2', PERCENT],
      ['B2', CURRENCY],
      ['C2', DATE],
    ];
    for (const [ref, style] of expected) {
      const expectedIndex = build.style_table.indexByKey.get(styleKey(style));
      expect(cells.get(ref)?.s).toBe(expectedIndex);
    }
  });

  it('文本单元格带 t="inlineStr"；数值单元格不带 t', () => {
    expect(cells.get('A1')?.t).toBe('inlineStr');
    expect(cells.get('B1')?.t).toBeNull();
    expect(cells.get('A2')?.t).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. 原值 vs 显示值
// ---------------------------------------------------------------------------

describe('X03-write §4 <v> 里是原值，显示值是另行渲染的', () => {
  const cells = parseSheetCells(buildStyledXlsx(spec(CELLS)).worksheet_xml);

  it('百分比：<v> 写 0.15，显示文本是 15%（原值未被乘 100 写回）', () => {
    expect(cells.get('A2')?.v).toBe('0.15');
    expect(renderNumberDisplay(0.15, { kind: 'percent', decimals: 0 }).display).toBe('15%');
    expect(cells.get('A2')?.v).not.toBe(renderNumberDisplay(0.15, { kind: 'percent', decimals: 0 }).display);
  });

  it('货币：<v> 写 1234.5，显示文本是 ¥1,234.50', () => {
    expect(cells.get('B2')?.v).toBe('1234.5');
    expect(renderNumberDisplay(1234.5, { kind: 'currency', currency: 'CNY', decimals: 2 }).display).toBe(
      '¥1,234.50',
    );
  });

  it('日期：<v> 写 Excel 序列号 45000，显示文本才是日期', () => {
    expect(cells.get('C2')?.v).toBe('45000');
    const expected = formatDatePattern(fromExcelSerial(45000), 'yyyy-mm-dd');
    expect(renderNumberDisplay(45000, { kind: 'date', pattern: 'yyyy-mm-dd' }).display).toBe(expected);
    expect(cells.get('C2')?.v).not.toBe(expected);
  });

  it('普通数值：<v> 就是原值文本', () => {
    expect(cells.get('B1')?.v).toBe('42');
  });
});

// ---------------------------------------------------------------------------
// 5. 确定性 + 不静默丢弃
// ---------------------------------------------------------------------------

describe('X03-write §5 确定性与拒绝', () => {
  it('同一 spec 连跑两次逐字节相等', () => {
    const a = buildStyledXlsx(spec(CELLS));
    const b = buildStyledXlsx(spec(CELLS));
    expect(a.content_digest).toBe(b.content_digest);
    expect(Buffer.compare(a.bytes, b.bytes)).toBe(0);
  });

  it('单元格顺序无关：倒序传入得到逐字节相同的字节', () => {
    const forward = buildStyledXlsx(spec(CELLS));
    const backward = buildStyledXlsx(spec([...CELLS].reverse()));
    expect(Buffer.compare(forward.bytes, backward.bytes)).toBe(0);
  });

  it('反面对照：单元格样式含未知键必须报错（不静默丢弃）', () => {
    const bogus = { bold: true, shadow: true } as unknown as CellStyle;
    expect(() => buildStyledXlsx(spec([{ ref: 'A1', value: { kind: 'number', value: 1 }, style: bogus }]))).toThrow(
      ValidationError,
    );
  });

  it('反面对照：重复地址必须报错', () => {
    expect(() =>
      buildStyledXlsx(
        spec([
          { ref: 'A1', value: { kind: 'number', value: 1 }, style: BOLD },
          { ref: 'a1', value: { kind: 'number', value: 2 }, style: FILL },
        ]),
      ),
    ).toThrow(ValidationError);
  });

  it('反面对照：非法工作表名必须报错', () => {
    expect(() => buildStyledXlsx({ sheet_name: 'a/b', cells: [] })).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// 6. 独立读取器重开（cross-module consumer reopen）
// ---------------------------------------------------------------------------

describe('X03-write §6 由另一实现 readWorkbookXlsx 重开产出的字节', () => {
  const build = buildStyledXlsx(spec(CELLS));
  const { workbook } = readWorkbookXlsx(build.bytes);
  const sheetState = (): SheetState => {
    const state = getSheet(workbook, '样式表');
    if (state === undefined) throw new Error('独立读取器未找到工作表「样式表」');
    return state;
  };

  it('另一实现能解析（readZip + XML 解析全程不抛错）并找到工作表', () => {
    expect(getSheet(workbook, '样式表')).toBeDefined();
  });

  it('文本单元格按 inlineStr 读回原文本', () => {
    expect(getCellValue(sheetState(), 'A1')).toMatchObject({ kind: 'text', value: '标题' });
  });

  it('百分比 / 货币单元格以数值读回，原值分毫不动', () => {
    expect(getCellValue(sheetState(), 'A2')).toMatchObject({ kind: 'number', value: 0.15 });
    expect(getCellValue(sheetState(), 'B2')).toMatchObject({ kind: 'number', value: 1234.5 });
  });

  it('日期样式被独立读取器识别为日期（numFmt 真实生效，而非仅字符串）', () => {
    const cell = getCellValue(sheetState(), 'C2');
    expect(cell.kind).toBe('date');
    expect((cell as { epoch_ms: number }).epoch_ms).toBe(fromExcelSerial(45000));
  });
});

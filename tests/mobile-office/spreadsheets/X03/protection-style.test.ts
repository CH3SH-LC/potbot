/**
 * **X03 / X-I10**：单元格保护（`<protection locked="0"/>`）的**样式半边**（XLS-15）。
 *
 * X06 的 `protection/` 交付了"语义半边"（`isCellEditable` 按 `CellLockState = { locked?: boolean }`
 * 判定某格在工作表受保护时能否编辑），但样式描述符当时无法表达"未锁定格"。本文件证明这条缝已经
 * 合上：`CellStyle.protection` 经 `buildStyleTable`/`renderStyleTableXml`/`buildStyledXlsx`
 * 一路写成真实 `.xlsx` 里的 `<protection locked="0"/>`，并保持"不得静默丢弃"。
 *
 * 判据不照抄实现：真实字节由 `readZip` 读回后用正则独立解析 `xl/styles.xml` 与
 * `xl/worksheets/sheet1.xml`。七组：
 *
 * 1. **渲染等价去重**：`locked:true` / `{}` 与空样式同键，`locked:false` 不同键（反面对照）；
 * 2. **不得静默丢弃**：`protection` 内未知键、非对象、非布尔 `locked` 一律 `ValidationError`；
 * 3. **cellXfs 记录**：`locked:false` ⇒ `applyProtection` 为真且记录带 `locked:false`；
 * 4. **XML 片段**：`<protection locked="0"/>` 真写出，`alignment` 在它之前（CT_Xf 顺序）；
 * 5. **接口稳定**：`renderStyleTableXml` 仍只返回 `numFmts/fonts/fills/borders/cellXfs` 五键；
 * 6. **真实字节**：`.xlsx` 的 `styles.xml` 含 `<protection locked="0"/>`，且单元格 `s=` 指向它；
 * 7. **与 X06 的接缝**：`style.protection` 结构可直接喂给 `isCellEditable`。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/index.js';
import { ValidationError } from '../../../../src/protocol/index.js';
import { isCellEditable } from '../../../../src/spreadsheets/protection/index.js';
import { normalizeCellProtection, type CellStyle } from '../../../../src/spreadsheets/styles.js';
import {
  EMPTY_STYLE_KEY,
  buildStyleTable,
  buildStyledXlsx,
  renderStyleTableXml,
  styleKey,
  type StyledCell,
  type StyledSheetSpec,
} from '../../../../src/spreadsheets/style-parts/index.js';

// ---------------------------------------------------------------------------
// 独立字节读回助手（不复用写入侧任何对象）
// ---------------------------------------------------------------------------

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

function partText(bytes: Uint8Array, path: string): string {
  const entry = readZip(bytes).by_path.get(path);
  if (entry === undefined) throw new Error(`ZIP 里没有部件 ${path}`);
  return decode(entry.data);
}

/** 从 styles.xml 文本抽出每个 cellXfs 项（含子元素）的原始 XML。 */
function xfXmlList(stylesXml: string): string[] {
  const block = /<cellXfs count="\d+">([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
  if (block === null) throw new Error('styles.xml 里找不到 cellXfs');
  return [...(block[1] as string).matchAll(/<xf\b[^>]*?\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g)].map((m) => m[0]);
}

/** 从 worksheet xml 抽出 ref → (s 下标)。 */
function sheetCellIndexes(worksheetXml: string): Map<string, number> {
  const out = new Map<string, number>();
  const re = /<c\b([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(worksheetXml)) !== null) {
    const ref = /r="([^"]*)"/.exec(match[1] as string)?.[1];
    const s = /s="(\d+)"/.exec(match[1] as string)?.[1];
    if (ref !== undefined && s !== undefined) out.set(ref, Number(s));
  }
  return out;
}

const UNLOCKED: CellStyle = { protection: { locked: false } };

// ---------------------------------------------------------------------------
// 1. 渲染等价去重（含反面对照）
// ---------------------------------------------------------------------------

describe('X-I10 §1 protection 描述符：渲染等价去重', () => {
  it('反面对照：locked:false 与空样式**不同**键（未锁定格是独立样式）', () => {
    expect(styleKey(UNLOCKED)).not.toBe(EMPTY_STYLE_KEY);
  });

  it('locked:true 是 Excel 默认 ⇒ 与空样式同键（渲染等价）', () => {
    expect(styleKey({ protection: { locked: true } })).toBe(EMPTY_STYLE_KEY);
  });

  it('空 protection 对象无信息 ⇒ 与空样式同键', () => {
    expect(styleKey({ protection: {} })).toBe(EMPTY_STYLE_KEY);
  });

  it('键序无关：protection 与其它字段书写顺序不影响键', () => {
    expect(styleKey({ protection: { locked: false }, bold: true })).toBe(
      styleKey({ bold: true, protection: { locked: false } }),
    );
  });

  it('buildStyleTable：locked:true 不新增 cellXf，locked:false 新增一项', () => {
    const onlyTrue = buildStyleTable([{ protection: { locked: true } }]);
    expect(onlyTrue.cellXfs.length).toBe(1); // 只有默认项

    const withUnlocked = buildStyleTable([UNLOCKED]);
    expect(withUnlocked.cellXfs.length).toBe(2); // 默认 + 未锁定
  });
});

// ---------------------------------------------------------------------------
// 2. 不得静默丢弃（未知键保障，禁止 `&& false`）
// ---------------------------------------------------------------------------

describe('X-I10 §2 protection 未知 / 非法不静默丢弃', () => {
  it('反面对照：protection 内未知键必须报错（不得静默丢弃）', () => {
    const bogus = { protection: { locked: false, hidden: true } } as unknown as CellStyle;
    expect(() => buildStyleTable([bogus])).toThrow(ValidationError);
    expect(() => styleKey(bogus)).toThrow(ValidationError);
  });

  it('反面对照：顶层未知键（whitelist 新增 protection 后仍拦得住）必须报错', () => {
    const bogus = { protected: true } as unknown as CellStyle;
    expect(() => styleKey(bogus)).toThrow(ValidationError);
  });

  it('反面对照：protection 非对象必须报错', () => {
    const bogus = { protection: true } as unknown as CellStyle;
    expect(() => buildStyleTable([bogus])).toThrow(ValidationError);
  });

  it('反面对照：locked 非布尔必须报错', () => {
    expect(() => normalizeCellProtection({ locked: 'no' })).toThrow(ValidationError);
    const bogus = { protection: { locked: 'no' } } as unknown as CellStyle;
    expect(() => buildStyleTable([bogus])).toThrow(ValidationError);
  });

  it('normalizeCellProtection 规范化并冻结合法输入', () => {
    const normalized = normalizeCellProtection({ locked: false });
    expect(normalized.locked).toBe(false);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(normalizeCellProtection({})).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 3. cellXfs 记录
// ---------------------------------------------------------------------------

describe('X-I10 §3 cellXfs 记录携带 applyProtection / protection', () => {
  it('locked:false ⇒ applyProtection=true 且 protection={locked:false}', () => {
    const table = buildStyleTable([UNLOCKED]);
    const index = table.indexByKey.get(styleKey(UNLOCKED)) as number;
    const xf = table.cellXfs[index];
    expect(xf?.applyProtection).toBe(true);
    expect(xf?.protection).toEqual({ locked: false });
  });

  it('默认 xf 无 protection：applyProtection=false、protection=null', () => {
    const table = buildStyleTable([]);
    expect(table.cellXfs[0]?.applyProtection).toBe(false);
    expect(table.cellXfs[0]?.protection).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. XML 片段
// ---------------------------------------------------------------------------

describe('X-I10 §4 cellXfs 片段渲染 <protection locked="0"/>', () => {
  it('未锁定格写出 <protection locked="0"/> 且带 applyProtection="1"', () => {
    const xml = renderStyleTableXml(buildStyleTable([UNLOCKED])).cellXfs;
    expect(xml).toContain('applyProtection="1"');
    expect(xml).toContain('<protection locked="0"/>');
  });

  it('locked:true / 缺省不写 protection 元素', () => {
    const xml = renderStyleTableXml(buildStyleTable([{ protection: { locked: true } }])).cellXfs;
    expect(xml).not.toContain('<protection');
    expect(xml).not.toContain('applyProtection="1"');
  });

  it('CT_Xf 子元素顺序：alignment 在 protection 之前', () => {
    const style: CellStyle = { horizontal_align: 'center', protection: { locked: false } };
    const xml = renderStyleTableXml(buildStyleTable([style])).cellXfs;
    expect(xml).toMatch(/<alignment[^>]*\/><protection locked="0"\/>/);
  });
});

// ---------------------------------------------------------------------------
// 5. 接口稳定（X-I02 消费 renderStyleTableXml）
// ---------------------------------------------------------------------------

describe('X-I10 §5 renderStyleTableXml 接口保持稳定', () => {
  it('返回对象仍恰好是 numFmts / fonts / fills / borders / cellXfs 五个键', () => {
    const parts = renderStyleTableXml(buildStyleTable([UNLOCKED]));
    expect(Object.keys(parts)).toEqual(['numFmts', 'fonts', 'fills', 'borders', 'cellXfs']);
  });
});

// ---------------------------------------------------------------------------
// 6. 真实 .xlsx 字节
// ---------------------------------------------------------------------------

describe('X-I10 §6 未锁定格写进真实 .xlsx 字节', () => {
  const cells: readonly StyledCell[] = [
    { ref: 'A1', value: { kind: 'text', text: '可编辑' }, style: UNLOCKED },
    { ref: 'B1', value: { kind: 'text', text: '锁定' }, style: { bold: true } },
  ];
  const spec: StyledSheetSpec = { sheet_name: '保护', cells };
  const build = buildStyledXlsx(spec);
  const stylesXml = partText(build.bytes, 'xl/styles.xml');

  it('styles.xml 里确实有 <protection locked="0"/>（真实字节 + readZip 校验）', () => {
    expect(stylesXml).toContain('<protection locked="0"/>');
  });

  it('未锁定格 s= 指向的 xf 片段含 protection，且就是含它的那一项', () => {
    const xfs = xfXmlList(stylesXml);
    const index = build.style_table.indexByKey.get(styleKey(UNLOCKED)) as number;
    expect(xfs[index]).toContain('<protection locked="0"/>');
    // 只有这一项带 protection。
    expect(xfs.filter((x) => x.includes('<protection')).length).toBe(1);
    // 工作表里 A1 的 s 指向该项。
    const indexes = sheetCellIndexes(build.worksheet_xml);
    expect(indexes.get('A1')).toBe(index);
    expect(indexes.get('B1')).not.toBe(index);
  });

  it('确定性：同一 spec 连跑两次逐字节相等', () => {
    const again = buildStyledXlsx(spec);
    expect(Buffer.compare(build.bytes, again.bytes)).toBe(0);
    expect(build.content_digest).toBe(again.content_digest);
  });

  it('反面对照：protection 内未知键经 buildStyledXlsx 也必须报错', () => {
    const bogus = { protection: { locked: false, hidden: true } } as unknown as CellStyle;
    expect(() =>
      buildStyledXlsx({ sheet_name: '坏', cells: [{ ref: 'A1', value: { kind: 'number', value: 1 }, style: bogus }] }),
    ).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// 7. 与 X06 protection/ 的接缝
// ---------------------------------------------------------------------------

describe('X-I10 §7 style.protection 可直接喂给 X06 的 isCellEditable', () => {
  it('未锁定格 + 已保护表 + 无有效口令 ⇒ 可编辑', () => {
    expect(isCellEditable({ sheet: true }, UNLOCKED.protection ?? {}, false)).toBe(true);
  });

  it('默认锁定格 + 已保护表 + 无口令 ⇒ 拒绝编辑', () => {
    expect(isCellEditable({ sheet: true }, {}, false)).toBe(false);
  });

  it('未保护表 ⇒ 任何格都可编辑', () => {
    expect(isCellEditable({ sheet: false }, {}, false)).toBe(true);
  });
});

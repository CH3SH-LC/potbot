/**
 * **W-R04 扩展独立验证 — 表格单元格 / 页眉页脚区域的编辑对象定位**
 * （`tests/mobile-office/word/W-R04/`）。
 *
 * 验证 `edit-targeting-ext.ts`：
 * - §A 记录盒子：单元格命中 → 码位光标（区域标记 + 单元格地址）；单元格优先于正文。
 * - §B fail-closed：身份未解析的区域**绝不**静默回落到正文光标。
 * - §C 页眉 / 页脚带：解析路径命中；未解析路径 fail-closed，且正文行盒**不被误用**。
 * - §D 边界：页码不存在 / 点在区域外 / 非有限坐标 / 空区域。
 * - §E 消费 W09 统一分页器输出（`paginateBlocks`）：twips→dp 换算 + 单元格文本命中。
 * - §F 重跑 48dp 触摸目标审计（覆盖扩展区域：单元格 + 页眉/页脚带）。
 *
 * ## 独立判据
 *
 * - 期望的码位下标由**文本自身**（`Array.from`）独立复算，不复用被测模块的换算。
 * - 每条"命成功"都配一条**邻位/反向对照**（左端 vs 右端、单元格 vs 正文、解析 vs 未解析）。
 * - 关键不变量：**身份未解析 ⇒ 必须失败**，且失败时不返回任何"半成品目标"。
 *
 * ## 诚实边界
 *
 * 只到 **unit 层**：行盒来自记录盒或 W09 纯计算分页器，不接真机触摸坐标、不做真实光栅化；
 * 页眉页脚段落不在模型中，其身份由测试**显式提供**（真实解析页眉部件是残余项）。
 */

import { describe, expect, it } from 'vitest';

import type { DocumentModel } from '../../../../src/documents/model/types.js';
import { document, paragraph, paragraphOfRuns, run, table, row, cell } from '../../../../src/documents/selection/testing.js';
import {
  paginateBlocks,
  type UnifiedPageBox,
} from '../../../../src/mobile-plugins/word/rendering/paginate.js';
import { layoutTable, type TableSpec } from '../../../../src/mobile-plugins/word/rendering/tables.js';
import type {
  FontMetricsPort,
  LayoutDiagnostic,
  PageGeometry,
} from '../../../../src/mobile-plugins/word/rendering/types.js';

import { MIN_TOUCH_TARGET_DP, type TouchTarget } from './accessibility.js';
import {
  auditRegionTouchTargets,
  hitTestRegion,
  regionsFromUnifiedPages,
  regionTouchTargets,
  twipsToDp,
  TWIPS_PER_DP,
  type CellAddress,
  type ContentBoxTwips,
  type LayoutIdentity,
  type LayoutRegion,
  type PageRegionLayout,
  type RegionArea,
  type RegionLayout,
  type RegionLineBox,
  type RegionRect,
} from './edit-targeting-ext.js';

// ---------------------------------------------------------------------------
// 独立工具（不复用被测模块的判定）
// ---------------------------------------------------------------------------

/** 按码位切分（独立复算用）。 */
function points(text: string): string[] {
  return Array.from(text);
}

/** 构造一段含表格的模型：正文 p1 + 表格（表头单元格 hdrPara，正文单元格 cellPara）。 */
function tableModel(): DocumentModel {
  return document([
    paragraph('p1', [run('pr1', 'Body')]),
    table('t1', [
      row('r0', [cell('c0', [paragraph('hdrPara', [run('hr1', 'HDR')])])], { header: true }),
      row('r1', [cell('c1', [paragraph('cellPara', [run('cr1', 'CellText')])])]),
    ]),
  ]);
}

/** 只含正文段落 + 一个"页眉占位段落"的模型（后者被显式当作页眉身份使用）。 */
function headerModel(): DocumentModel {
  return document([
    paragraph('p1', [run('pr1', 'Body')]),
    paragraph('hp1', [run('hr1', 'Title')]),
  ]);
}

function rect(x0: number, y0: number, x1: number, y1: number): RegionRect {
  return { x0Dp: x0, x1Dp: x1, y0Dp: y0, y1Dp: y1 };
}

function bodyArea(r: RegionRect): RegionArea {
  return { region: 'body', rect: r, cell: null, identity: 'resolved' };
}

function cellArea(r: RegionRect, address: CellAddress, identity: RegionArea['identity']): RegionArea {
  return { region: 'table-cell', rect: r, cell: address, identity };
}

function bandArea(region: 'header' | 'footer', r: RegionRect, identity: RegionArea['identity']): RegionArea {
  return { region, rect: r, cell: null, identity };
}

function regionLine(
  region: LayoutRegion,
  r: RegionRect,
  node_id: string | null,
  text: string,
  cellAddr: CellAddress | null = null,
): RegionLineBox {
  const cps = points(text).length;
  return { ...r, region, node_id, start: 0, end: cps, cell: cellAddr };
}

function recordedLayout(page: PageRegionLayout, mode: RegionLayout['verificationMode'] = 'fixture'): RegionLayout {
  return { verificationMode: mode, note: 'W-R04 扩展测试记录盒', pages: [page] };
}

const CELL: CellAddress = { table_block_index: 0, table_index: 0, row: 0, column: 0 };

// ===========================================================================
// §A 记录盒子：单元格命中
// ===========================================================================

describe('W-R04 扩展 §A 表格单元格命中', () => {
  const model = tableModel();
  const layout = recordedLayout({
    pageIndex: 0,
    content: rect(10, 10, 400, 600),
    areas: [bodyArea(rect(10, 10, 400, 600)), cellArea(rect(10, 10, 200, 50), CELL, 'resolved')],
    // 正文有一条覆盖全内容区的行，用来验证**单元格优先于正文**。
    lines: [
      regionLine('body', rect(10, 10, 400, 40), 'p1', 'Body'),
      regionLine('table-cell', rect(10, 10, 170, 50), 'cellPara', 'CellText', CELL),
    ],
  });

  it('A1 点在单元格内 ⇒ 单元格段落码位光标（区域标记 + 地址）', () => {
    const hit = hitTestRegion(model, layout, { xDp: 10, yDp: 30 });
    expect(hit.ok).toBe(true);
    if (!hit.ok) return;
    expect(hit.value.kind).toBe('caret');
    expect(hit.value).toMatchObject({ region: 'table-cell', node_id: 'cellPara', offset: 0 });
    expect(hit.value.cell).toEqual(CELL);
  });

  it('A2 单元格右端取整到码位末尾（对照左端 0）', () => {
    const hit = hitTestRegion(model, layout, { xDp: 170, yDp: 30 });
    expect(hit.ok).toBe(true);
    if (!hit.ok || hit.value.kind !== 'caret') return;
    expect(hit.value.node_id).toBe('cellPara');
    expect(hit.value.offset).toBe(points('CellText').length); // 8
  });

  it('A3 单元格优先于同一 y 的正文行（区域不串）', () => {
    const hit = hitTestRegion(model, layout, { xDp: 100, yDp: 30 });
    expect(hit.ok).toBe(true);
    if (!hit.ok) return;
    expect(hit.value.region).toBe('table-cell');
    expect(hit.value.node_id).toBe('cellPara');
  });

  it('A4 表格外的正文点 ⇒ body 区域', () => {
    // y=100 在单元格盒（10..50）之外，落在正文内容区。
    const hit = hitTestRegion(model, layout, { xDp: 100, yDp: 100 });
    expect(hit.ok).toBe(true);
    if (!hit.ok) return;
    expect(hit.value).toMatchObject({ region: 'body', node_id: 'p1' });
    expect(hit.value.cell).toBeNull();
  });
});

// ===========================================================================
// §B fail-closed：身份未解析绝不静默回落
// ===========================================================================

describe('W-R04 扩展 §B 未解析区域 fail-closed', () => {
  it('B1 单元格行 node_id 为空 ⇒ unsupported（不回落到正文光标）', () => {
    const model = tableModel();
    const layout = recordedLayout({
      pageIndex: 0,
      content: rect(10, 10, 400, 600),
      areas: [bodyArea(rect(10, 10, 400, 600)), cellArea(rect(10, 10, 200, 50), CELL, 'unresolved')],
      lines: [
        // 正文行与单元格点**完全重叠**：若实现回落到正文，就会得到 p1 的光标。
        regionLine('body', rect(10, 10, 400, 40), 'p1', 'Body'),
        regionLine('table-cell', rect(10, 10, 170, 50), null, 'CellText', CELL),
      ],
    });
    const hit = hitTestRegion(model, layout, { xDp: 100, yDp: 30 });
    expect(hit.ok).toBe(false);
    if (hit.ok) return;
    expect(hit.code).toBe('unsupported');
    expect(hit.detail.extra?.region).toBe('table-cell');
  });

  it('B2 单元格区域存在但无行盒 ⇒ unsupported', () => {
    const model = tableModel();
    const layout = recordedLayout({
      pageIndex: 0,
      content: rect(10, 10, 400, 600),
      areas: [bodyArea(rect(10, 10, 400, 600)), cellArea(rect(10, 10, 200, 50), CELL, 'unresolved')],
      lines: [regionLine('body', rect(10, 10, 400, 40), 'p1', 'Body')],
    });
    const hit = hitTestRegion(model, layout, { xDp: 100, yDp: 30 });
    expect(hit.ok).toBe(false);
    if (hit.ok) return;
    expect(hit.code).toBe('unsupported');
  });
});

// ===========================================================================
// §C 页眉 / 页脚带
// ===========================================================================

describe('W-R04 扩展 §C 页眉页脚带', () => {
  it('C1 页眉带解析 ⇒ header 区域命中', () => {
    const model = headerModel();
    const layout = recordedLayout({
      pageIndex: 0,
      content: rect(10, 80, 400, 600),
      areas: [bandArea('header', rect(10, 0, 400, 60), 'resolved'), bodyArea(rect(10, 80, 400, 600))],
      lines: [
        regionLine('header', rect(10, 10, 60, 50), 'hp1', 'Title'),
        regionLine('body', rect(10, 80, 400, 120), 'p1', 'Body'),
      ],
    });
    // 左端 xDp=10 即页眉带与行盒左界：fraction 0 ⇒ 码位 0。
    const hit = hitTestRegion(model, layout, { xDp: 10, yDp: 30 });
    expect(hit.ok, JSON.stringify(hit)).toBe(true);
    if (!hit.ok) return;
    expect(hit.value).toMatchObject({ region: 'header', node_id: 'hp1', offset: 0 });
  });

  it('C2 页眉带未解析且与正文区重叠 ⇒ 失败，绝不取正文光标', () => {
    const model = headerModel();
    // 页眉带与正文内容区**故意重叠**（y 0..60 vs 0..600）：分类先取页眉；未解析 ⇒ 必须失败。
    const layout = recordedLayout({
      pageIndex: 0,
      content: rect(10, 0, 400, 600),
      areas: [bandArea('header', rect(10, 0, 400, 60), 'unresolved'), bodyArea(rect(10, 0, 400, 600))],
      lines: [
        regionLine('header', rect(10, 0, 60, 60), null, 'Title'),
        regionLine('body', rect(10, 0, 400, 60), 'p1', 'Body'),
      ],
    });
    const hit = hitTestRegion(model, layout, { xDp: 15, yDp: 30 });
    expect(hit.ok).toBe(false);
    if (hit.ok) return;
    expect(hit.code).toBe('unsupported');
    expect(hit.detail.extra?.region).toBe('header');
  });

  it('C3 页脚带解析 ⇒ footer 区域命中', () => {
    const model = headerModel();
    const layout = recordedLayout({
      pageIndex: 0,
      content: rect(10, 10, 400, 560),
      areas: [bodyArea(rect(10, 10, 400, 560)), bandArea('footer', rect(10, 560, 400, 600), 'resolved')],
      lines: [
        regionLine('body', rect(10, 10, 400, 50), 'p1', 'Body'),
        regionLine('footer', rect(10, 565, 60, 595), 'hp1', 'Title'),
      ],
    });
    const hit = hitTestRegion(model, layout, { xDp: 15, yDp: 575 });
    expect(hit.ok, JSON.stringify(hit)).toBe(true);
    if (!hit.ok) return;
    expect(hit.value.region).toBe('footer');
    expect(hit.value.node_id).toBe('hp1');
  });
});

// ===========================================================================
// §D 边界
// ===========================================================================

describe('W-R04 扩展 §D 边界', () => {
  const model = tableModel();
  const layout = recordedLayout({
    pageIndex: 0,
    content: rect(10, 10, 400, 600),
    areas: [bodyArea(rect(10, 10, 400, 600))],
    lines: [regionLine('body', rect(10, 10, 400, 40), 'p1', 'Body')],
  });

  it('D1 点在所有区域之外（页边距）⇒ not_found', () => {
    const hit = hitTestRegion(model, layout, { xDp: 5, yDp: 5 });
    expect(hit.ok).toBe(false);
    if (hit.ok) return;
    expect(hit.code).toBe('not_found');
  });

  it('D2 pageIndex 无对应页 ⇒ not_found', () => {
    const hit = hitTestRegion(model, layout, { xDp: 100, yDp: 100 }, { pageIndex: 3 });
    expect(hit.ok).toBe(false);
    if (hit.ok) return;
    expect(hit.code).toBe('not_found');
  });

  it('D3 非有限坐标 ⇒ invalid_range', () => {
    const hit = hitTestRegion(model, layout, { xDp: Number.NaN, yDp: 100 });
    expect(hit.ok).toBe(false);
    if (hit.ok) return;
    expect(hit.code).toBe('invalid_range');
    const inf = hitTestRegion(model, layout, { xDp: 1, yDp: Number.POSITIVE_INFINITY });
    expect(inf.ok).toBe(false);
    if (inf.ok) return;
    expect(inf.code).toBe('invalid_range');
  });
});

// ===========================================================================
// §E 消费 W09 统一分页器输出
// ===========================================================================

function metricsPort(): FontMetricsPort {
  return {
    hasFont: () => true,
    hasGlyph: () => true,
    advanceWidthTwips: (_family, _codePoint, sizeTwips) => Math.round(sizeTwips / 2),
    ascentTwips: (_family, sizeTwips) => Math.round(sizeTwips * 0.8),
    descentTwips: (_family, sizeTwips) => Math.round(sizeTwips * 0.2),
  };
}

function tableSpec(): TableSpec {
  return {
    rows: [
      { header: true, cells: [{ blocks: [{ runs: [{ text: 'HDR', fontFamily: 'Calibri', sizePt: 11 }] }] }] },
      { cells: [{ blocks: [{ runs: [{ text: 'AB', fontFamily: 'Calibri', sizePt: 11 }] }] }] },
    ],
    columnWidthsTwips: [1800],
    cellPaddingTwips: { top: 20, bottom: 20, left: 20, right: 20 },
  };
}

const CONTENT: ContentBoxTwips = { leftTwips: 720, topTwips: 720, widthTwips: 9000, heightTwips: 12000 };

function pagerPages(): { pages: readonly UnifiedPageBox[]; diagnostics: LayoutDiagnostic[] } {
  const port = metricsPort();
  const tbox = layoutTable(tableSpec(), port);
  const geometry: PageGeometry = {
    widthTwips: 10440,
    heightTwips: 13440,
    marginsTwips: { top: 720, right: 720, bottom: 720, left: 720 },
    headerHeightTwips: 0,
    footerHeightTwips: 0,
  };
  const diagnostics: LayoutDiagnostic[] = [];
  const { pages } = paginateBlocks({
    blocks: [{ kind: 'table', table: tbox }],
    geometry,
    content: CONTENT,
    header: null,
    footer: null,
    diagnostics,
  });
  return { pages, diagnostics };
}

const PAGER_IDENTITY: LayoutIdentity = {
  paragraphNodeId: () => null,
  tableCellParagraphNodeIds: (tableBlockIndex, rowIndex, columnIndex) => {
    if (tableBlockIndex !== 0 || columnIndex !== 0) return null;
    return rowIndex === 0 ? ['hdrPara'] : ['cellPara'];
  },
};

describe('W-R04 扩展 §E 消费统一分页器输出', () => {
  it('E1 twips→dp 换算常数正确（1 dp = 9 twips）', () => {
    expect(TWIPS_PER_DP).toBe(9);
    expect(twipsToDp(720)).toBeCloseTo(80, 10);
    expect(twipsToDp(1800)).toBeCloseTo(200, 10);
  });

  it('E2 分页器输出的单元格可被命中（身份由调用方提供）', () => {
    const { pages } = pagerPages();
    const layout = regionsFromUnifiedPages({ pages, content: CONTENT, identity: PAGER_IDENTITY });
    expect(layout.verificationMode).toBe('measured');

    const model = tableModel();
    const cellLine = layout.pages[0]?.lines.find((l) => l.region === 'table-cell' && l.node_id === 'cellPara');
    expect(cellLine).toBeDefined();
    if (cellLine === undefined) return;

    const point = { xDp: cellLine.x0Dp + 1, yDp: (cellLine.y0Dp + cellLine.y1Dp) / 2 };
    const hit = hitTestRegion(model, layout, point);
    expect(hit.ok, `${JSON.stringify(point)} :: ${JSON.stringify(hit)}`).toBe(true);
    if (!hit.ok || hit.value.kind !== 'caret') return;
    expect(hit.value.node_id).toBe('cellPara');
    expect(hit.value.region).toBe('table-cell');
    expect(hit.value.offset).toBe(0);
    expect(hit.value.cell).not.toBeNull();
  });

  it('E3 分页器输出的单元格身份缺失 ⇒ 该点 fail-closed', () => {
    const { pages } = pagerPages();
    const noIdentity: LayoutIdentity = { tableCellParagraphNodeIds: () => null };
    const layout = regionsFromUnifiedPages({ pages, content: CONTENT, identity: noIdentity });
    const model = tableModel();
    // 取任一单元格区域的中点。
    const area = layout.pages[0]?.areas.find((a) => a.region === 'table-cell');
    expect(area).toBeDefined();
    if (area === undefined) return;
    const point = { xDp: (area.rect.x0Dp + area.rect.x1Dp) / 2, yDp: (area.rect.y0Dp + area.rect.y1Dp) / 2 };
    const hit = hitTestRegion(model, layout, point);
    expect(hit.ok).toBe(false);
    if (hit.ok) return;
    expect(hit.code).toBe('unsupported');
  });

  it('E4 单元格宽度换算为 dp（1800 twips ⇒ 约 200 dp）', () => {
    const { pages } = pagerPages();
    const layout = regionsFromUnifiedPages({ pages, content: CONTENT, identity: PAGER_IDENTITY });
    const area = layout.pages[0]?.areas.find((a) => a.region === 'table-cell');
    expect(area).toBeDefined();
    if (area === undefined) return;
    expect(area.rect.x1Dp - area.rect.x0Dp).toBeCloseTo(200, 6);
  });
});

// ===========================================================================
// §F 48dp 触摸目标审计（扩展区域）
// ===========================================================================

describe('W-R04 扩展 §F 48dp 触摸目标审计', () => {
  it('F1 达标：单元格与页眉带均 ≥ 48dp ⇒ 无问题', () => {
    const layout = recordedLayout({
      pageIndex: 0,
      content: rect(0, 60, 400, 600),
      areas: [
        bandArea('header', rect(0, 0, 400, 48), 'resolved'),
        bodyArea(rect(0, 60, 400, 600)),
        cellArea(rect(0, 60, 60, 120), CELL, 'resolved'),
      ],
      lines: [],
    });
    expect(auditRegionTouchTargets(layout)).toEqual([]);
    const targets = regionTouchTargets(layout);
    expect(targets.map((t) => t.role)).toEqual(['command', 'text']); // header 带 + 单元格
  });

  it('F2 未达标：40dp 宽单元格 + 30dp 高页眉带 ⇒ 各报 too_small', () => {
    const layout = recordedLayout({
      pageIndex: 0,
      content: rect(0, 60, 400, 600),
      areas: [
        bandArea('header', rect(0, 0, 400, 30), 'resolved'),
        bodyArea(rect(0, 60, 400, 600)),
        cellArea(rect(0, 60, 40, 120), CELL, 'resolved'),
      ],
      lines: [],
    });
    const issues = auditRegionTouchTargets(layout);
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.code)).toEqual(['too_small', 'too_small']);
    const header = issues.find((i) => i.id === 'header:0');
    const cellIssue = issues.find((i) => i.id === 'cell:0:0:0:0');
    expect(header).toMatchObject({ heightDp: 30 });
    expect(cellIssue).toMatchObject({ widthDp: 40 });
    expect(MIN_TOUCH_TARGET_DP).toBe(48);
  });

  it('F3 regionTouchTargets 是只读数据（不改布局）', () => {
    const layout = recordedLayout({
      pageIndex: 0,
      content: rect(0, 60, 400, 600),
      areas: [bodyArea(rect(0, 60, 400, 600)), cellArea(rect(0, 60, 50, 130), CELL, 'resolved')],
      lines: [],
    });
    const before = JSON.stringify(layout);
    const targets: readonly TouchTarget[] = regionTouchTargets(layout);
    expect(targets).toHaveLength(1);
    expect(JSON.stringify(layout)).toBe(before);
  });
});

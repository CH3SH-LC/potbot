/**
 * **W-R04 扩展 — 表格单元格 / 页眉页脚区域的编辑对象定位（edit-targeting-ext）。**
 *
 * ## 这一层解决什么
 *
 * 首轮 `edit-targeting.ts` 的 `hitTest` 只覆盖**正文行盒**：它把 dp 触摸点映射到
 * `(段落 node_id, 码位下标)`。但手机上"点表格单元格里的字""点页眉去改页眉"同样是**同一个
 * 编辑面**——正文、单元格、页眉页脚共享一套"触摸点 → 文档位置"的语义。本模块把这一层
 * 扩到**区域感知**（region-aware）的定位，并保持与首轮完全一致的码位口径（R102）。
 *
 * ## 消费谁来料：W09 统一分页器 或 记录盒子
 *
 * 本模块**不排版**。它消费两类已测量的布局盒子，二者归一到同一个 `RegionLayout`：
 *
 * 1. **W09 统一分页器输出**（`paginate.ts::paginateBlocks` → `UnifiedPageBox[]`）：
 *    {@link regionsFromUnifiedPages} 把页盒（twips）平铺成区域盒子（dp）。段落身份
 *    （`LineBox.paragraphIndex` → `node_id`）由调用方通过 {@link LayoutIdentity} 提供——
 *    这正是 W-I06 `document-spec.ts::buildLayoutDocumentSpec` 产出的 `paragraph_node_ids`
 *    表（以及表格单元格 / 页眉页脚各自的身份解析器）。
 * 2. **记录盒子（recorded boxes）**：调用方直接构造 {@link RegionLayout}（测试与宿主
 *    回放用），不依赖度量端口。
 *
 * ## 单位换算（可复算，不是魔数）
 *
 * 分页器几何是 **twips**（1 pt = 20 twips；1 in = 1440 twips），触摸点是 **dp**。
 * Android 基线密度下 1 dp = 1/160 in ⇒ `1 dp = 1440 / 160 = 9 twips`。
 * 故 `dp = twips / {@link TWIPS_PER_DP}`，常数由 {@link TWIPS_PER_DP} 单点给出。
 *
 * ## 失败必须显式（绝不静默给个光标）
 *
 * 这是本模块相对首轮**最重要**的加强。规则：
 *
 * - 点落在某个**已知区域**（页眉带 / 页脚带 / 单元格 / 正文内容区）内，但该区域**没有可解析
 *   的段落身份**（`node_id` 为空，或该区域没有行盒），返回 `unsupported`——**不回落到正文**，
 *   更不返回一个"看起来合理"的光标。宿主必须据此向用户提示"此处不可编辑 / 尚未解析"。
 * - 点落在**所有已知区域之外**（如页边距空白），返回 `not_found`。
 * - `node_id` 非空但模型里没有该段落 ⇒ 由 `hitTest` 报 `unknown_node`（仍是 fail-closed）。
 * - 触摸点坐标非有限数 ⇒ `invalid_range`；`pageIndex` 无对应页 ⇒ `not_found`。
 *
 * ## 诚实边界（未验证层）
 *
 * - 行盒的来源仍是**测量/记录**的布局（`verificationMode` 标记为 `'measured'` 或
 *   `'fixture'`）；本模块不产生真实字形光栅化、不接 Android `StaticLayout`。
 * - **页眉页脚段落不在 `DocumentModel.blocks` 里**：模型只有部件路径引用
 *   （`SectionProperties.headers`）。因此页眉页脚的段落身份**必须由调用方**经
 *   {@link LayoutIdentity.bandNodeId} 提供；解析页眉/页脚部件不在本模块职责内（残余项）。
 * - 表格单元格内段落虽在模型里（`collectParagraphs` 递归），但**分页器行盒不带 node_id**，
 *   故单元格身份也必须由调用方经 {@link LayoutIdentity.tableCellParagraphNodeIds} 提供。
 * - 返回的目标**不含页码字段**：页序只作为**输入**（`pageIndex`），页码语义归 W04（不做）。
 */

import type { DocumentModel, NodeId } from '../../../../src/documents/model/types.js';
import { fail, succeed, type Result } from '../../../../src/documents/selection/types.js';
import type { UnifiedPageBox } from '../../../../src/mobile-plugins/word/rendering/paginate.js';
import type { Twips, LineBox as MeasurementLineBox } from '../../../../src/mobile-plugins/word/rendering/types.js';

import { auditTouchTargets, type TouchTarget, type TouchTargetIssue } from './accessibility.js';
import {
  hitTest,
  type CaretTarget,
  type LayoutFixture,
  type LineBox,
  type ObjectTarget,
  type ParagraphLayout,
  type TouchPoint,
} from './edit-targeting.js';

// ---------------------------------------------------------------------------
// 单位
// ---------------------------------------------------------------------------

/**
 * 每 dp 的 twips 数 = 1440（twips/in）÷ 160（dp/in，Android 基线密度）= 9。
 * 单点给出，避免散落魔数。
 */
export const TWIPS_PER_DP = 1440 / 160;

/** twips → dp（可复算）。 */
export function twipsToDp(twips: Twips): number {
  return twips / TWIPS_PER_DP;
}

// ---------------------------------------------------------------------------
// 区域布局模型
// ---------------------------------------------------------------------------

/** 编辑区域类别。 */
export type LayoutRegion = 'body' | 'table-cell' | 'header' | 'footer';

/** dp 矩形（相对**页面**左上角）。 */
export interface RegionRect {
  readonly x0Dp: number;
  readonly x1Dp: number;
  readonly y0Dp: number;
  readonly y1Dp: number;
}

/** 表格单元格地址（页序在查询里，故此处不含页码）。 */
export interface CellAddress {
  /** 表格块在文档块序列里的下标（`PlacedTable.blockIndex`）。 */
  readonly table_block_index: number;
  /** 同页第几个表格（0 起，`PlacedTable.tableIndex`）。 */
  readonly table_index: number;
  /** 行号（`TableRowBox.rowIndex`）。 */
  readonly row: number;
  /** 列号（`TableCellBox.colIndex`）。 */
  readonly column: number;
}

/**
 * 一条区域行盒。`start` / `end` 是**码位**区间（与选区同源，R102），
 * `node_id` 为空表示该行所属段落的身份**未解析**（fail-closed 依据）。
 */
export interface RegionLineBox extends RegionRect {
  readonly region: LayoutRegion;
  readonly node_id: NodeId | null;
  readonly start: number;
  readonly end: number;
  /** 仅 `region === 'table-cell'` 时非空。 */
  readonly cell: CellAddress | null;
}

/** 一块可命中的区域（用于分类触摸点归属）。 */
export interface RegionArea {
  readonly region: LayoutRegion;
  readonly rect: RegionRect;
  /** 仅 `region === 'table-cell'` 时非空。 */
  readonly cell: CellAddress | null;
  /** 该区域的段落身份是否已知（未知 ⇒ 命中即 fail-closed）。 */
  readonly identity: 'resolved' | 'unresolved';
}

/** 一页的区域布局。 */
export interface PageRegionLayout {
  readonly pageIndex: number;
  /** 正文内容区（页盒里的 `content` 盒子）。 */
  readonly content: RegionRect;
  readonly areas: readonly RegionArea[];
  readonly lines: readonly RegionLineBox[];
}

/** 与首轮 fixture 同口径的区域布局。`verificationMode` 区分 measured（分页器）与 fixture（记录）。 */
export interface RegionLayout {
  readonly verificationMode: 'measured' | 'fixture';
  readonly note: string;
  readonly pages: readonly PageRegionLayout[];
}

// ---------------------------------------------------------------------------
// 段落身份解析（调用方提供）
// ---------------------------------------------------------------------------

/**
 * 分页器行盒只带数值下标，不带 `node_id`。本接口把**数值下标 → 模型 node_id** 的对应
 * 关系交给调用方一处提供；凡是返回 `null` 的，本模块一律 fail-closed（不猜）。
 */
export interface LayoutIdentity {
  /**
   * 正文段落：`LineBox.paragraphIndex` → node_id。
   * 由 W-I06 `buildLayoutDocumentSpec().paragraph_node_ids` 支撑（同一次遍历产出，天然同序）。
   */
  readonly paragraphNodeId?: (paragraphIndex: number) => NodeId | null;
  /**
   * 表格单元格内段落：`(tableBlockIndex, rowIndex, colIndex)` → 该单元格段落的 node_id 列表
   * （按单元格内段落顺序）。返回 `null` 表示该单元格身份未知。
   */
  readonly tableCellParagraphNodeIds?: (
    tableBlockIndex: number,
    rowIndex: number,
    columnIndex: number,
  ) => readonly NodeId[] | null;
  /** 页眉 / 页脚带段落的 node_id；返回 `null` 表示未解析。 */
  readonly bandNodeId?: (kind: 'header' | 'footer') => NodeId | null;
}

/** 页盒内容区（twips），与 `paginateBlocks` 的入参 `content` 同源。 */
export interface ContentBoxTwips {
  readonly leftTwips: Twips;
  readonly topTwips: Twips;
  readonly widthTwips: Twips;
  readonly heightTwips: Twips;
}

/** {@link regionsFromUnifiedPages} 入参。 */
export interface UnifiedPagerInput {
  readonly pages: readonly UnifiedPageBox[];
  readonly content: ContentBoxTwips;
  readonly identity: LayoutIdentity;
}

// ---------------------------------------------------------------------------
// 由 W09 统一分页器输出构造区域布局
// ---------------------------------------------------------------------------

function rect(
  x0Twips: Twips,
  y0Twips: Twips,
  x1Twips: Twips,
  y1Twips: Twips,
): RegionRect {
  return {
    x0Dp: twipsToDp(x0Twips),
    x1Dp: twipsToDp(x1Twips),
    y0Dp: twipsToDp(y0Twips),
    y1Dp: twipsToDp(y1Twips),
  };
}

/** 行盒的码位起止：取首个 run 的 startOffset 与末个 run 的 endOffset（无 run ⇒ 0,0）。 */
function lineCodePointRange(line: MeasurementLineBox): { start: number; end: number } {
  const first = line.runs[0];
  const last = line.runs[line.runs.length - 1];
  return { start: first?.startOffset ?? 0, end: last?.endOffset ?? 0 };
}

function measuredLineToRegion(
  line: MeasurementLineBox,
  region: LayoutRegion,
  node: NodeId | null,
  cell: CellAddress | null,
): RegionLineBox {
  const range = lineCodePointRange(line);
  return {
    ...rect(
      line.offsetXTwips,
      line.topTwips,
      line.offsetXTwips + line.widthTwips,
      line.topTwips + line.heightTwips,
    ),
    region,
    node_id: node,
    start: range.start,
    end: range.end,
    cell,
  };
}

/**
 * 把 W09 统一分页器（`paginateBlocks`）的页盒平铺成 {@link RegionLayout}：
 * 正文行、每张已摆放表格的单元格（盒子 + 行盒）、页眉页脚带（区域 + 行盒）。
 *
 * 身份解析缺失的段落/区域**如实标为 unresolved**（`node_id: null`），不伪造。
 */
export function regionsFromUnifiedPages(input: UnifiedPagerInput): RegionLayout {
  const { pages, content, identity } = input;
  const contentRect = rect(
    content.leftTwips,
    content.topTwips,
    content.leftTwips + content.widthTwips,
    content.topTwips + content.heightTwips,
  );

  const built: PageRegionLayout[] = pages.map((page) => {
    const areas: RegionArea[] = [];
    const lines: RegionLineBox[] = [];

    // 1) 正文行 + 正文内容区。
    for (const line of page.lines) {
      const node = identity.paragraphNodeId ? identity.paragraphNodeId(line.paragraphIndex) : null;
      lines.push(measuredLineToRegion(line, 'body', node, null));
    }
    areas.push({ region: 'body', rect: contentRect, cell: null, identity: 'resolved' });

    // 2) 已摆放的表格：每个单元格一个区域 + 其行盒。
    //    `PlacedTable.rows` 的单元格/行盒**已是页面坐标**（`paginate.ts::placeRowAt`
    //    已把 `leftTwips` / `topTwips` 平移过），故这里**不再**叠加 `placed.leftTwips`。
    for (const placed of page.tables) {
      for (const row of placed.rows) {
        for (const cellBox of row.cells) {
          const address: CellAddress = {
            table_block_index: placed.blockIndex,
            table_index: placed.tableIndex,
            row: row.rowIndex,
            column: cellBox.colIndex,
          };
          const cellLeftTwips = cellBox.leftTwips;
          areas.push({
            region: 'table-cell',
            rect: rect(
              cellLeftTwips,
              cellBox.topTwips,
              cellLeftTwips + cellBox.widthTwips,
              cellBox.topTwips + cellBox.heightTwips,
            ),
            cell: address,
            identity: 'resolved',
          });

          const ids =
            identity.tableCellParagraphNodeIds !== undefined
              ? identity.tableCellParagraphNodeIds(address.table_block_index, address.row, address.column)
              : null;
          if (ids === null) areas[areas.length - 1] = { ...(areas[areas.length - 1] as RegionArea), identity: 'unresolved' };

          for (const line of cellBox.lines) {
            const node = ids !== null && line.paragraphIndex >= 0 && line.paragraphIndex < ids.length
              ? (ids[line.paragraphIndex] ?? null)
              : null;
            lines.push(measuredLineToRegion(line, 'table-cell', node, address));
          }
        }
      }
    }

    // 3) 页眉 / 页脚带（预留带高 > 0 或有内容时才有可命中区域）。
    const bands: readonly { kind: 'header' | 'footer'; box: typeof page.header }[] = [
      { kind: 'header', box: page.header },
      { kind: 'footer', box: page.footer },
    ];
    for (const { kind, box } of bands) {
      if (box.reservedHeightTwips <= 0 && box.lines.length === 0) continue;
      const node = identity.bandNodeId ? identity.bandNodeId(kind) : null;
      const bandRect = rect(
        content.leftTwips,
        box.topTwips,
        content.leftTwips + content.widthTwips,
        box.topTwips + box.reservedHeightTwips,
      );
      areas.push({
        region: kind,
        rect: bandRect,
        cell: null,
        identity: node !== null && box.hasContent ? 'resolved' : 'unresolved',
      });
      for (const line of box.lines) {
        lines.push(measuredLineToRegion(line, kind, node, null));
      }
    }

    return { pageIndex: page.index, content: contentRect, areas, lines };
  });

  return {
    verificationMode: 'measured',
    note: 'W09 统一分页器（paginateBlocks）输出平铺；身份由调用方 LayoutIdentity 提供。',
    pages: built,
  };
}

// ---------------------------------------------------------------------------
// 区域分类 + 命中
// ---------------------------------------------------------------------------

function contains(r: RegionRect, point: TouchPoint): boolean {
  return point.xDp >= r.x0Dp && point.xDp < r.x1Dp && point.yDp >= r.y0Dp && point.yDp < r.y1Dp;
}

function sameCell(a: CellAddress | null, b: CellAddress | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.table_block_index === b.table_block_index &&
    a.table_index === b.table_index &&
    a.row === b.row &&
    a.column === b.column
  );
}

/**
 * 分类触摸点归属的区域。顺序：页眉带 → 页脚带 → 单元格 → 正文内容区 → 无（null）。
 * 页眉/页脚带在内容区**之外**（上/下），单元格在内容区**之内**，故顺序不会互相遮挡。
 */
function classify(page: PageRegionLayout, point: TouchPoint): RegionArea | null {
  const pick = (region: LayoutRegion): RegionArea | null =>
    page.areas.find((a) => a.region === region && contains(a.rect, point)) ?? null;

  const header = pick('header');
  if (header !== null) return header;
  const footer = pick('footer');
  if (footer !== null) return footer;
  const cell = page.areas.find((a) => a.region === 'table-cell' && contains(a.rect, point));
  if (cell !== undefined) return cell;
  const body = pick('body');
  if (body !== null) return body;
  return null;
}

function verticalDistance(point: TouchPoint, line: RegionLineBox): number {
  if (point.yDp < line.y0Dp) return line.y0Dp - point.yDp;
  if (point.yDp >= line.y1Dp) return point.yDp - line.y1Dp;
  return 0;
}

/** 在候选行盒里挑竖直最近的一行（与首轮 `hitTest` 同判据）。 */
function nearestLine(candidates: readonly RegionLineBox[], point: TouchPoint): RegionLineBox | null {
  let best: RegionLineBox | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const line of candidates) {
    const distance = verticalDistance(point, line);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = line;
      if (distance === 0) return best;
    }
  }
  return best;
}

function candidateLines(page: PageRegionLayout, area: RegionArea): readonly RegionLineBox[] {
  if (area.region === 'table-cell') {
    return page.lines.filter((l) => l.region === 'table-cell' && sameCell(l.cell, area.cell));
  }
  return page.lines.filter((l) => l.region === area.region);
}

/** 扩展后的编辑目标：在原 `CaretTarget` / `ObjectTarget` 上附加区域与单元格地址。 */
export type RegionCaretTarget = CaretTarget & { readonly region: LayoutRegion; readonly cell: CellAddress | null };
export type RegionObjectTarget = ObjectTarget & { readonly region: LayoutRegion; readonly cell: CellAddress | null };
export type RegionEditTarget = RegionCaretTarget | RegionObjectTarget;

/** 查询：触摸点在**哪一页**上（页序只作输入，不进返回值）。 */
export interface RegionQuery {
  readonly pageIndex?: number;
}

/**
 * dp 触摸点 → 区域编辑目标。
 *
 * 失败：
 * - `unsupported`：点落在已知区域内，但该区域**无行盒**或最近行的 `node_id` 为空
 *   （身份未解析）——显式 fail-closed，**绝不回落到正文光标**。
 * - `not_found`：所有区域都不含该点，或 `pageIndex` 无对应页。
 * - `invalid_range`：坐标非有限数。
 * - `unknown_node` / `invalid_range`：由底层 `hitTest` 传播（段落不在模型 / 行盒越界）。
 */
export function hitTestRegion(
  model: DocumentModel,
  layout: RegionLayout,
  point: TouchPoint,
  query: RegionQuery = {},
): Result<RegionEditTarget> {
  if (!Number.isFinite(point.xDp) || !Number.isFinite(point.yDp)) {
    return fail('invalid_range', `触摸点坐标必须是有限数：(${point.xDp}, ${point.yDp})。`, {
      extra: { xDp: String(point.xDp), yDp: String(point.yDp) },
    });
  }

  const pageIndex = query.pageIndex ?? 0;
  const page = layout.pages.find((p) => p.pageIndex === pageIndex);
  if (page === undefined) {
    return fail('not_found', `区域布局里没有第 ${pageIndex} 页。`, {
      extra: { pageIndex, pages: layout.pages.length },
    });
  }

  const area = classify(page, point);
  if (area === null) {
    return fail('not_found', `触摸点 (${point.xDp}, ${point.yDp}) dp 不在任何已知区域（页眉带 / 页脚带 / 单元格 / 正文）内。`, {
      extra: { xDp: point.xDp, yDp: point.yDp, pageIndex },
    });
  }

  const candidates = candidateLines(page, area);
  if (candidates.length === 0) {
    return fail(
      'unsupported',
      `命中区域「${area.region}」但没有可定位的行盒（该区域未解析 / 为空），拒绝返回光标。`,
      { extra: { region: area.region, pageIndex } },
    );
  }

  const line = nearestLine(candidates, point);
  if (line === null || line.node_id === null) {
    return fail(
      'unsupported',
      `命中区域「${area.region}」的最近行没有段落身份（node_id 未解析），拒绝静默给出光标。`,
      { extra: { region: area.region, pageIndex } },
    );
  }

  // 只用有身份的行盒构造 fixture；最近行有身份，故 hitTest 会选中同一行。
  const paragraphs: ParagraphLayout[] = [];
  const byNode = new Map<NodeId, LineBox[]>();
  for (const candidate of candidates) {
    if (candidate.node_id === null) continue;
    const list = byNode.get(candidate.node_id);
    const box: LineBox = {
      start: candidate.start,
      end: candidate.end,
      x0Dp: candidate.x0Dp,
      x1Dp: candidate.x1Dp,
      topDp: candidate.y0Dp,
      bottomDp: candidate.y1Dp,
    };
    if (list === undefined) byNode.set(candidate.node_id, [box]);
    else list.push(box);
  }
  for (const [nodeId, boxes] of byNode) {
    paragraphs.push({ node_id: nodeId, source: 'fixture', lines: boxes });
  }

  const fixture: LayoutFixture = {
    verificationMode: 'fixture',
    note: `W-R04 扩展：区域「${area.region}」行盒（measured 布局投影，非真实分页页码）`,
    paragraphs,
  };

  const hit = hitTest(model, fixture, point);
  if (!hit.ok) return hit;

  if (hit.value.kind === 'caret') {
    return succeed({ ...hit.value, region: area.region, cell: area.cell });
  }
  return succeed({ ...hit.value, region: area.region, cell: area.cell });
}

// ---------------------------------------------------------------------------
// 48dp 触摸目标审计（扩展区域）
// ---------------------------------------------------------------------------

function areaTouchTargetId(area: RegionArea, pageIndex: number): string {
  if (area.region === 'table-cell' && area.cell !== null) {
    return `cell:${pageIndex}:${area.cell.table_block_index}:${area.cell.row}:${area.cell.column}`;
  }
  return `${area.region}:${pageIndex}`;
}

function areaTouchTargetLabel(area: RegionArea): string {
  if (area.region === 'table-cell' && area.cell !== null) {
    return `表格单元格 r${area.cell.row + 1}c${area.cell.column + 1}`;
  }
  if (area.region === 'header') return '页眉';
  if (area.region === 'footer') return '页脚';
  return '正文';
}

/**
 * 把扩展区域折算成 48dp 触摸目标（**只读**审计数据，不改 UI）。
 * 正文内容区本身不是离散目标（整页可点），故跳过；单元格与页眉/页脚带各成一个目标。
 */
export function regionTouchTargets(layout: RegionLayout, pageIndex = 0): readonly TouchTarget[] {
  const page = layout.pages.find((p) => p.pageIndex === pageIndex);
  if (page === undefined) return [];
  const out: TouchTarget[] = [];
  for (const area of page.areas) {
    if (area.region === 'body') continue;
    out.push({
      id: areaTouchTargetId(area, pageIndex),
      label: areaTouchTargetLabel(area),
      role: area.region === 'table-cell' ? 'text' : 'command',
      widthDp: area.rect.x1Dp - area.rect.x0Dp,
      heightDp: area.rect.y1Dp - area.rect.y0Dp,
    });
  }
  return out;
}

/** 对扩展区域重跑 48dp 触摸目标审计：小于 48×48 dp 的目标逐项报 `too_small`。 */
export function auditRegionTouchTargets(layout: RegionLayout, pageIndex = 0): readonly TouchTargetIssue[] {
  return auditTouchTargets(regionTouchTargets(layout, pageIndex));
}

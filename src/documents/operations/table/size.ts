/**
 * 列宽与行高（WF-059；判据："所有尺寸走 `src/documents/units/**`，本包不得出现 20/240/1440
 * 这类换算魔数"）。
 *
 * ## 宽度住在两个地方，必须一起维护
 *
 * OOXML 里列宽有两处表达：
 *
 * 1. `w:tblGrid/w:gridCol@w:w` —— **网格列宽**（表格的骨架，固定布局以它为准）；
 * 2. `w:tcPr/w:tcW` —— 单元格的**首选宽度**（模型里的 `CellProperties.width`）。
 *
 * 只改一处就会得到"看着是 3 cm、实际排版按另一个值"的表格。因此本模块的写法是：
 * **先改网格，再把跨到这一列的单元格宽度同步成它覆盖的若干列之和**；本来没有显式宽度的
 * 单元格保持"未指定"（继续跟随网格）。这条策略在测试里正反都钉住。
 *
 * ## 均分与自适应
 *
 * - **均分**：总量取 twips（`units/length.ts`），按列数整除，余数分给前几列，
 *   保证"加起来仍然等于原来的总宽"（不做四舍五入的悄悄缩水）。
 * - **自适应页面**：给定可用宽度（正文栏宽），按比例缩放网格列宽。
 * - **自适应内容**：需要**真实排版度量**（每个单元格里文字的实际行宽）。本内核没有排版引擎，
 *   因此**明确拒绝**（`unsupported`），不用估算值冒充（R158 的同一取向：没算过就不能说算了）。
 *
 * ## 行高
 *
 * `RowNode.height` 直接承载 OOXML 的 `w:trHeight@w:val|w:hRule`：`exact` = 固定值、
 * `atLeast` = 最小值。默认（`unspecified`）= 由内容决定（Word 的"行高自动"）。
 */

import { DocumentModelError } from '../../model/errors.js';
import { lengthToTwips, twipsToLength } from '../../units/index.js';
import { tableColumnCount } from '../../model/table-grid.js';
import type { CellNode, DocumentModel, Length, NodeId, RowNode, TableNode } from '../../model/types.js';
import { buildGridMap, type GridMap } from './grid.js';
import { findRow, requireCleanGrid, requireTable, withRow, withTable } from './edit.js';
import { runTableEdit, type TableOutcome } from './types.js';

/** 设置列宽请求。 */
export interface SetColumnWidthRequest {
  readonly table_id: NodeId;
  readonly column: number;
  readonly width: Length;
}

/** 设置列宽的结果。 */
export interface SetColumnWidthSuccess {
  readonly model: DocumentModel;
  /** 被同步改写的单元格宽度个数（跨列合并的单元格算一个）。 */
  readonly synced_cells: number;
}

/**
 * 单元格的显式宽度（跨列时 = 覆盖列宽之和）。
 *
 * 返回 `null` 表示"该单元格本来没有显式宽度"——即"未指定"，**不**给它安一个值。
 */
function spannedWidth(grid: readonly Length[], start: number, span: number): Length | null {
  const parts = grid.slice(start, start + span);
  if (parts.length !== span || parts.some((part) => part === undefined)) {
    return null;
  }
  const unit = (parts[0] as Length).unit;
  const totalTwips = parts.reduce((total, part) => total + lengthToTwips(part as Length), 0);
  // 跨列时要精确相加；本行的换算全部经由 units（1 cm = 567 twips 的口径）。
  return exactLength(parts as readonly Length[], unit, totalTwips);
}

/**
 * 用 twips 总量构造某个单位的 `Length`。
 *
 * 单列（span=1）时**原样返回该列自身**，避免"40 mm → twips → 40.000000000000004 mm"
 * 这种无意义的往返漂移；跨列时才真正做加法。
 */
function exactLength(parts: readonly Length[], unit: Length['unit'], totalTwips: number): Length {
  if (parts.length === 1) {
    return parts[0] as Length;
  }
  if (unit === 'twips') {
    return { unit, value: totalTwips };
  }
  return twipsToLength(totalTwips, unit);
}

/**
 * 网格列宽变化后，同步**跨到受影响列**的、且**本来就有显式宽度**的单元格。
 *
 * 两个"只"都是刻意的：
 * - **只同步显式宽度**：`unspecified` 的单元格语义是"跟随网格"，给它安一个值会让
 *   "未指定"变成"显式设置"，从此不再随样式变化（R117）；
 * - **只同步受影响列**：把没改过的列也重算一遍，会在"跨列宽度按 twips 求和"时引入
 *   无谓的单位往返漂移，也让"改了几格"的计数变得不真实。
 */
function syncCellWidths(
  table: TableNode,
  grid: readonly Length[],
  map: GridMap,
  affectedColumn: number | null,
): { readonly table: TableNode; readonly synced: number } {
  let synced = 0;
  const rows = table.rows.map((row, rowIndex) => {
    let changed = false;
    const cells = row.cells.map((cell, cellIndex) => {
      if (cell.properties.width.state !== 'set') {
        return cell;
      }
      const gridMap = map.owner[rowIndex];
      if (gridMap === undefined) {
        return cell;
      }
      const slot = gridMap.find((entry) => entry !== null && entry.cell_index === cellIndex) ?? null;
      if (slot === null) {
        return cell;
      }
      if (affectedColumn !== null && !(affectedColumn >= slot.start && affectedColumn < slot.end)) {
        return cell;
      }
      const next = spannedWidth(grid, slot.start, slot.end - slot.start);
      if (next === null) {
        return cell;
      }
      changed = true;
      synced += 1;
      return { ...cell, properties: { ...cell.properties, width: { state: 'set' as const, value: next } } };
    });
    return changed ? { ...row, cells } : row;
  });
  return { table: { ...table, rows }, synced };
}

/** 设置某一列的宽度（WF-059"固定列宽"）。 */
export function setColumnWidth(
  model: DocumentModel,
  request: SetColumnWidthRequest,
): TableOutcome<SetColumnWidthSuccess> {
  return runTableEdit(() => {
    const table = requireTable(model, request.table_id);
    const columnCount = tableColumnCount(table);
    if (!Number.isInteger(request.column) || request.column < 0 || request.column >= columnCount) {
      throw new DocumentModelError(
        'invalid_index',
        `列号越界：${String(request.column)}（表格共 ${String(columnCount)} 列）`,
      );
    }
    if (table.grid.length === 0) {
      throw new DocumentModelError(
        'unsupported',
        '表格没有网格定义（无 w:tblGrid）——列宽无处安放；请先给表格建立网格列宽',
      );
    }
    const map = requireCleanGrid(table, '设置列宽');
    const grid = table.grid.map((width, index) => (index === request.column ? request.width : width));
    const synced = syncCellWidths(table, grid, map, request.column);
    return { model: withTable(model, request.table_id, { ...synced.table, grid }), synced_cells: synced.synced };
  });
}

/** 均分列宽请求。 */
export interface DistributeColumnsRequest {
  readonly table_id: NodeId;
  /** 总宽；省略时取当前各列之和（"均分"而不是"改成某个总宽"）。 */
  readonly total?: Length;
}

/** 均分列宽的结果。 */
export interface DistributeColumnsSuccess {
  readonly model: DocumentModel;
  /** 分给每列的宽度（余数已摊到前几列，故各列可能相差 1 twip 以内）。 */
  readonly column_widths: readonly Length[];
}

/**
 * 均分列宽（WF-059"均分"）。
 *
 * 余数摊到前几列，保证 `Σ 新列宽 = 总宽`（不因取整而缩水）。单位取原网格第一列的单位。
 */
export function distributeColumns(
  model: DocumentModel,
  request: DistributeColumnsRequest,
): TableOutcome<DistributeColumnsSuccess> {
  return runTableEdit(() => {
    const table = requireTable(model, request.table_id);
    if (table.grid.length === 0) {
      throw new DocumentModelError(
        'unsupported',
        '表格没有网格定义（无 w:tblGrid）——无法均分列宽',
      );
    }
    const map = requireCleanGrid(table, '均分列宽');
    const unit = (table.grid[0] as Length).unit;
    const totalTwips =
      request.total !== undefined
        ? lengthToTwips(request.total)
        : table.grid.reduce((total, width) => total + lengthToTwips(width), 0);
    if (totalTwips <= 0) {
      throw new DocumentModelError('invalid_index', `总宽必须为正，收到 ${String(totalTwips)} twips`);
    }
    const count = table.grid.length;
    const base = Math.floor(totalTwips / count);
    const remainder = totalTwips - base * count;
    const widths = table.grid.map((_width, index) =>
      twipsToLength(base + (index < remainder ? 1 : 0), unit),
    );
    const synced = syncCellWidths(table, widths, map, null);
    return {
      model: withTable(model, request.table_id, { ...synced.table, grid: widths }),
      column_widths: widths,
    };
  });
}

/** 自适应请求。 */
export interface AutofitRequest {
  readonly table_id: NodeId;
  /**
   * `window` = 适应页面（按可用宽度缩放列宽）；`content` = 适应内容。
   *
   * `content` 需要真实排版度量，本内核**没有排版引擎**，因此一律 `unsupported`（不估算冒充）。
   */
  readonly mode: 'window' | 'content';
  /** `window` 模式下正文可用宽度（如 A4 去掉页边距后的宽度）。 */
  readonly available_width?: Length;
}

/** 自适应结果。 */
export interface AutofitSuccess {
  readonly model: DocumentModel;
  readonly layout: 'autofit';
  readonly column_widths: readonly Length[];
}

/**
 * 表格自适应（WF-059）。
 *
 * - `window`：有 `available_width` 时按比例缩放各列；没有时只把布局方式标记为 `autofit`
 *   （交给消费端按窗口宽度重排）。两种情况都把 `TableProperties.layout` 置为 `autofit`。
 * - `content`：**明确拒绝** —— 适应内容要量文字实排宽度，本内核没有排版引擎（R158 取向）。
 */
export function autofitTable(model: DocumentModel, request: AutofitRequest): TableOutcome<AutofitSuccess> {
  return runTableEdit(() => {
    const table = requireTable(model, request.table_id);
    if (request.mode === 'content') {
      throw new DocumentModelError(
        'unsupported',
        '按内容自适应需要真实排版度量（每个单元格文字的实际宽度），本内核没有排版引擎——' +
          '不用估算值冒充自动适应（如需请走渲染适配路线）',
      );
    }
    const map = requireCleanGrid(table, '自适应页面');
    const layoutProperties = { ...table.properties, layout: { state: 'set' as const, value: 'autofit' as const } };
    if (request.available_width === undefined || table.grid.length === 0) {
      return {
        model: withTable(model, request.table_id, { ...table, properties: layoutProperties }),
        layout: 'autofit' as const,
        column_widths: table.grid,
      };
    }
    const target = lengthToTwips(request.available_width);
    if (target <= 0) {
      throw new DocumentModelError(
        'invalid_index',
        `可用宽度必须为正，收到 ${String(target)} twips（单位换算见 src/documents/units）`,
      );
    }
    const unit = (table.grid[0] as Length).unit;
    const total = table.grid.reduce((sum, width) => sum + lengthToTwips(width), 0);
    const widths = table.grid.map((width) => {
      const scaled = Math.round((lengthToTwips(width) * target) / total);
      return twipsToLength(scaled, unit);
    });
    // 缩放后可能有 ±1 twip 的残差：把差值补回最后一列，保证总宽精确等于目标。
    const achieved = widths.reduce((sum, width) => sum + lengthToTwips(width), 0);
    const fixed =
      achieved === target || widths.length === 0
        ? widths
        : widths.map((width, index) =>
            index === widths.length - 1
              ? twipsToLength(lengthToTwips(width) + (target - achieved), unit)
              : width,
          );
    const synced = syncCellWidths(table, fixed, map, null);
    return {
      model: withTable(model, request.table_id, {
        ...synced.table,
        grid: fixed,
        properties: layoutProperties,
      }),
      layout: 'autofit' as const,
      column_widths: fixed,
    };
  });
}

/** 设置行高请求。 */
export interface SetRowHeightRequest {
  readonly row_id: NodeId;
  /** `exact` = 固定值；`atLeast` = 最小值（OOXML `w:hRule`）。 */
  readonly rule: 'exact' | 'atLeast';
  readonly value: Length;
}

/** 行高操作结果。 */
export interface RowHeightSuccess {
  readonly model: DocumentModel;
  readonly row_id: NodeId;
}

/** 设置行高（WF-059"固定/最小高度"）。 */
export function setRowHeight(model: DocumentModel, request: SetRowHeightRequest): TableOutcome<RowHeightSuccess> {
  return runTableEdit(() => {
    const located = findRow(model, request.row_id);
    if (located === null) {
      throw new DocumentModelError('unknown_node', `找不到表格行 ${JSON.stringify(request.row_id)}`);
    }
    const row: RowNode = {
      ...located.table.rows[located.index] as RowNode,
      height: { state: 'set', value: { value: request.value, rule: request.rule } },
    };
    return { model: withRow(model, request.row_id, row), row_id: request.row_id };
  });
}

/** 清除行高（回到"由内容决定"）。 */
export function clearRowHeight(model: DocumentModel, rowId: NodeId): TableOutcome<RowHeightSuccess> {
  return runTableEdit(() => {
    const located = findRow(model, rowId);
    if (located === null) {
      throw new DocumentModelError('unknown_node', `找不到表格行 ${JSON.stringify(rowId)}`);
    }
    const row: RowNode = {
      ...(located.table.rows[located.index] as RowNode),
      height: { state: 'inherit' },
    };
    return { model: withRow(model, rowId, row), row_id: rowId };
  });
}

/** 读取表格的列宽数组（越界表返回空数组）。 */
export function columnWidths(table: TableNode): readonly Length[] {
  return table.grid;
}

/** 供上层判断网格是否与单元格首选宽度一致（诊断用；不产生变更）。 */
export function widthConsistency(table: TableNode): readonly {
  readonly cell_id: NodeId;
  readonly declared: Length;
  readonly from_grid: Length | null;
}[] {
  const map = buildGridMap(table);
  const report: { cell_id: NodeId; declared: Length; from_grid: Length | null }[] = [];
  table.rows.forEach((row, rowIndex) => {
    row.cells.forEach((cell: CellNode, cellIndex: number) => {
      if (cell.properties.width.state !== 'set') {
        return;
      }
      const slot = map.owner[rowIndex]?.find((entry) => entry !== null && entry.cell_index === cellIndex) ?? null;
      if (slot === null) {
        return;
      }
      report.push({
        cell_id: cell.id,
        declared: cell.properties.width.value,
        from_grid: spannedWidth(table.grid, slot.start, slot.end - slot.start),
      });
    });
  });
  return report;
}

/**
 * 表格 / 单元格边框与底纹（WF-062；判据："局部与整表分开，直接设置与样式优先序正确"）。
 *
 * ## "整表"与"局部"是**两组不同字段**，不是同一件事的两种写法
 *
 * - 整表：`TableProperties.borders` / `TableProperties.shading` → `w:tblPr/w:tblBorders`、`w:tblPr/w:shd`
 * - 局部：`CellProperties.borders` / `CellProperties.shading` → `w:tcPr/w:tcBorders`、`w:tcPr/w:shd`
 *
 * 本模块把它们**分开设置、分开清除**：`setTableBorder` 只碰整表字段，
 * `setCellBorder` 只碰单元格字段。混在一起（"设整表顺手把所有单元格也写了"）会让
 * "只给某一格加个红边"变成"整张表都红了"——这正是判据要挡的事。
 *
 * ## 优先序怎么定（`resolveCellBorders`）
 *
 * 逐边判定，自内向外：
 *
 * 1. **单元格直接设置**（`CellProperties.borders` 里显式给了这一边）⇒ 用它（`source: 'cell'`）；
 * 2. 否则**表格直接设置**（`TableProperties.borders` 里显式给了这一边）⇒ 用它（`source: 'table'`）；
 * 3. 都没有 ⇒ `source: 'document_default'`（既没写过 `w:tcBorders` 也没写过 `w:tblBorders` 的这一边，
 *    由文档默认/表格样式决定——**模型里没有这些层级的信息，就不编造一个值**）。
 *
 * `inherit` 态（R117 的"清除覆盖回继承"）的含义在这里是明确的：单元格设 `inherit`
 * ⇒ 单元格这一层被清掉，判定继续落到表格层。这正是"清除单元格边框后整表边框重新生效"，
 * 测试里正反两面都钉住。
 *
 * ## 表格样式（`w:tblStyle`）这一层为什么是"缺口"
 *
 * 冻结模型的 `StyleDefinition` 只有 `run_properties` / `paragraph_properties`，
 * **没有表格边框字段**，因此"表格样式里定义的边框"无法在模型里承载。
 * `resolveCellBorders` 的结果里带 `style_layer_available: false` 与一句说明——
 * 不假装算过样式层（R124：读回有效属性必须标明来源层，标不出来就得说明为什么）。
 */

import { DocumentModelError } from '../../model/errors.js';
import { findNodeById } from '../../model/walk.js';
import { cloneBorderEdge, cloneShading } from '../paragraph/clone.js';
import { VALUED_INHERIT, valuedSet } from '../paragraph/states.js';
import type {
  BorderEdge,
  CellNode,
  DocumentModel,
  NodeId,
  Shading,
  TableNode,
} from '../../model/types.js';
import { requireTable, withCell, withTable } from './edit.js';
import { runTableEdit, type TableOutcome } from './types.js';

/** 表格可设的 6 条边（含内部横线/竖线）。 */
export type TableBorderEdge = 'top' | 'left' | 'bottom' | 'right' | 'insideH' | 'insideV';
/** 单元格可设的 4 条边。 */
export type CellBorderEdge = 'top' | 'left' | 'bottom' | 'right';

/** 表格边框的稳定顺序（供测试遍历）。 */
export const TABLE_BORDER_EDGES: readonly TableBorderEdge[] = Object.freeze([
  'top',
  'left',
  'bottom',
  'right',
  'insideH',
  'insideV',
] as readonly TableBorderEdge[]);

/** 单元格边框的稳定顺序。 */
export const CELL_BORDER_EDGES: readonly CellBorderEdge[] = Object.freeze([
  'top',
  'left',
  'bottom',
  'right',
] as readonly CellBorderEdge[]);

type TableBorders = Partial<Record<TableBorderEdge, BorderEdge>>;
type CellBorders = Partial<Record<CellBorderEdge, BorderEdge>>;

function currentTableBorders(table: TableNode): TableBorders {
  return table.properties.borders.state === 'set' ? table.properties.borders.value : {};
}

function currentCellBorders(cell: CellNode): CellBorders {
  return cell.properties.borders.state === 'set' ? cell.properties.borders.value : {};
}

// ---------------------------------------------------------------------------
// 整表
// ---------------------------------------------------------------------------

/** 设置整表边框的若干条边（WF-062）。只碰**整表**字段。 */
export function setTableBorders(
  model: DocumentModel,
  request: { readonly table_id: NodeId; readonly borders: TableBorders },
): TableOutcome<{ readonly model: DocumentModel; readonly table_id: NodeId }> {
  return runTableEdit(() => {
    const table = requireTable(model, request.table_id);
    const merged: TableBorders = { ...currentTableBorders(table) };
    for (const edge of TABLE_BORDER_EDGES) {
      const value = request.borders[edge];
      if (value !== undefined) {
        merged[edge] = cloneBorderEdge(value);
      }
    }
    const next: TableNode = {
      ...table,
      properties: { ...table.properties, borders: valuedSet(merged) },
    };
    return { model: withTable(model, request.table_id, next), table_id: request.table_id };
  });
}

/** 取消整表边框的一条边；取消后一条不剩则落 `inherit`（写码层删除整个 `w:tblBorders`）。 */
export function clearTableBorder(
  model: DocumentModel,
  request: { readonly table_id: NodeId; readonly edge: TableBorderEdge },
): TableOutcome<{ readonly model: DocumentModel; readonly table_id: NodeId }> {
  return runTableEdit(() => {
    const table = requireTable(model, request.table_id);
    const merged = currentTableBorders(table);
    delete merged[request.edge];
    const borders = Object.keys(merged).length === 0 ? VALUED_INHERIT : valuedSet(merged);
    const next: TableNode = { ...table, properties: { ...table.properties, borders } };
    return { model: withTable(model, request.table_id, next), table_id: request.table_id };
  });
}

/** 取消整表全部边框。 */
export function clearTableBorders(
  model: DocumentModel,
  tableId: NodeId,
): TableOutcome<{ readonly model: DocumentModel; readonly table_id: NodeId }> {
  return runTableEdit(() => {
    const table = requireTable(model, tableId);
    const next: TableNode = { ...table, properties: { ...table.properties, borders: VALUED_INHERIT } };
    return { model: withTable(model, tableId, next), table_id: tableId };
  });
}

/** 设置整表底纹（与单元格底纹、段落底纹三者分开）。 */
export function setTableShading(
  model: DocumentModel,
  request: { readonly table_id: NodeId; readonly shading: Shading },
): TableOutcome<{ readonly model: DocumentModel; readonly table_id: NodeId }> {
  return runTableEdit(() => {
    const table = requireTable(model, request.table_id);
    const next: TableNode = {
      ...table,
      properties: { ...table.properties, shading: valuedSet(cloneShading(request.shading)) },
    };
    return { model: withTable(model, request.table_id, next), table_id: request.table_id };
  });
}

/** 取消整表底纹。 */
export function clearTableShading(
  model: DocumentModel,
  tableId: NodeId,
): TableOutcome<{ readonly model: DocumentModel; readonly table_id: NodeId }> {
  return runTableEdit(() => {
    const table = requireTable(model, tableId);
    const next: TableNode = { ...table, properties: { ...table.properties, shading: VALUED_INHERIT } };
    return { model: withTable(model, tableId, next), table_id: tableId };
  });
}

// ---------------------------------------------------------------------------
// 局部（单元格）
// ---------------------------------------------------------------------------

function requireCell(model: DocumentModel, cellId: NodeId): CellNode {
  const node = findNodeById(model, cellId);
  if (node === null || node.kind !== 'cell') {
    throw new DocumentModelError('unknown_node', `找不到单元格 ${JSON.stringify(cellId)}`);
  }
  return node;
}

/** 设置单元格边框的若干条边（WF-062"局部"）。只碰**该单元格**字段。 */
export function setCellBorders(
  model: DocumentModel,
  request: { readonly cell_id: NodeId; readonly borders: CellBorders },
): TableOutcome<{ readonly model: DocumentModel; readonly cell_id: NodeId }> {
  return runTableEdit(() => {
    const cell = requireCell(model, request.cell_id);
    const merged: CellBorders = { ...currentCellBorders(cell) };
    for (const edge of CELL_BORDER_EDGES) {
      const value = request.borders[edge];
      if (value !== undefined) {
        merged[edge] = cloneBorderEdge(value);
      }
    }
    const next: CellNode = {
      ...cell,
      properties: { ...cell.properties, borders: valuedSet(merged) },
    };
    return { model: withCell(model, request.cell_id, next), cell_id: request.cell_id };
  });
}

/** 取消单元格边框的一条边；取消后一条不剩则落 `inherit`（回落到表格/样式层）。 */
export function clearCellBorder(
  model: DocumentModel,
  request: { readonly cell_id: NodeId; readonly edge: CellBorderEdge },
): TableOutcome<{ readonly model: DocumentModel; readonly cell_id: NodeId }> {
  return runTableEdit(() => {
    const cell = requireCell(model, request.cell_id);
    const merged = currentCellBorders(cell);
    delete merged[request.edge];
    const borders = Object.keys(merged).length === 0 ? VALUED_INHERIT : valuedSet(merged);
    const next: CellNode = { ...cell, properties: { ...cell.properties, borders } };
    return { model: withCell(model, request.cell_id, next), cell_id: request.cell_id };
  });
}

/** 取消单元格全部边框（回落到表格层，`inherit`）。 */
export function clearCellBorders(
  model: DocumentModel,
  cellId: NodeId,
): TableOutcome<{ readonly model: DocumentModel; readonly cell_id: NodeId }> {
  return runTableEdit(() => {
    const cell = requireCell(model, cellId);
    const next: CellNode = { ...cell, properties: { ...cell.properties, borders: VALUED_INHERIT } };
    return { model: withCell(model, cellId, next), cell_id: cellId };
  });
}

/** 设置单元格底纹。 */
export function setCellShading(
  model: DocumentModel,
  request: { readonly cell_id: NodeId; readonly shading: Shading },
): TableOutcome<{ readonly model: DocumentModel; readonly cell_id: NodeId }> {
  return runTableEdit(() => {
    const cell = requireCell(model, request.cell_id);
    const next: CellNode = {
      ...cell,
      properties: { ...cell.properties, shading: valuedSet(cloneShading(request.shading)) },
    };
    return { model: withCell(model, request.cell_id, next), cell_id: request.cell_id };
  });
}

/** 取消单元格底纹。 */
export function clearCellShading(
  model: DocumentModel,
  cellId: NodeId,
): TableOutcome<{ readonly model: DocumentModel; readonly cell_id: NodeId }> {
  return runTableEdit(() => {
    const cell = requireCell(model, cellId);
    const next: CellNode = { ...cell, properties: { ...cell.properties, shading: VALUED_INHERIT } };
    return { model: withCell(model, cellId, next), cell_id: cellId };
  });
}

// ---------------------------------------------------------------------------
// 优先序解析（只读）
// ---------------------------------------------------------------------------

/** 某条边最终生效值的来源层。 */
export type BorderSource = 'cell' | 'table' | 'document_default';

/** 一条边的解析结果。 */
export interface ResolvedBorderEdge {
  readonly edge: CellBorderEdge;
  /** `null` = 没有任何一层显式给过这条边。 */
  readonly value: BorderEdge | null;
  readonly source: BorderSource;
}

/** 单元格四边的解析结果 + 样式层可用性说明。 */
export interface ResolvedCellBorders {
  readonly edges: readonly ResolvedBorderEdge[];
  /**
   * **恒为 `false`**：冻结模型的 `StyleDefinition` 没有表格边框字段，
   * 因此"表格样式里定义的边框"无法参与解析——不编造（R124）。
   */
  readonly style_layer_available: false;
  readonly note: string;
}

/** 样式层缺口的说明（给上层/证据文本用）。 */
export const STYLE_LAYER_NOTE =
  '冻结模型的 StyleDefinition 只有 run/paragraph 属性，没有表格边框字段：' +
  '"表格样式定义的边框"这一层无法参与解析，结果里不编造该层的值（R124）。';

/**
 * 解析某个单元格四边最终生效的边框（自内向外：单元格 → 表格 → 文档默认）。
 *
 * 只读，不产生任何变更。
 */
export function resolveCellBorders(model: DocumentModel, cellId: NodeId): ResolvedCellBorders {
  const cell = requireCell(model, cellId);
  const table = findOwningTable(model, cellId);
  const cellLayer = currentCellBorders(cell);
  const tableLayer = table === null ? {} : currentTableBorders(table);

  const edges = CELL_BORDER_EDGES.map((edge): ResolvedBorderEdge => {
    const own = cellLayer[edge];
    if (own !== undefined) {
      return { edge, value: own, source: 'cell' };
    }
    const inherited = tableLayer[edge];
    if (inherited !== undefined) {
      return { edge, value: inherited, source: 'table' };
    }
    return { edge, value: null, source: 'document_default' };
  });

  return { edges, style_layer_available: false, note: STYLE_LAYER_NOTE };
}

function findOwningTable(model: DocumentModel, cellId: NodeId): TableNode | null {
  const visit = (blocks: readonly TableNode[]): TableNode | null => {
    for (const table of blocks) {
      for (const row of table.rows) {
        for (const cell of row.cells) {
          if (cell.id === cellId) {
            return table;
          }
          const nested: TableNode[] = [];
          for (const block of cell.blocks) {
            if (block.kind === 'table') {
              nested.push(block);
            }
          }
          const found = visit(nested);
          if (found !== null) {
            return found;
          }
        }
      }
    }
    return null;
  };
  const top: TableNode[] = [];
  for (const block of model.blocks) {
    if (block.kind === 'table') {
      top.push(block);
    }
  }
  return visit(top);
}

/** 便捷：把解析结果收成 `{ edge: value }`（`null` 的边不出现）。 */
export function resolvedBorderValues(resolved: ResolvedCellBorders): Partial<Record<CellBorderEdge, BorderEdge>> {
  const result: Partial<Record<CellBorderEdge, BorderEdge>> = {};
  for (const entry of resolved.edges) {
    if (entry.value !== null) {
      result[entry.edge] = entry.value;
    }
  }
  return result;
}

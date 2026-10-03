/**
 * **表格工作流**（WF 文档工作流的"表格"操作面）。
 *
 * ## 这一层是什么、不是什么
 *
 * 它是 `operations/table/**`（WF-056–064 的实现层）之上的**一层薄操作面**：
 * 把"用户/上层想做的表格事"归成一组**意图级**入口（增删行列、合并拆分、列宽行高、
 * 边框底纹、表头重复、表格样式、单元格对齐与文本），并在每次结构改动**之后**
 * 跑一遍自洽性断言。
 *
 * 三层分工（**不得含糊**）：
 *
 * | 层 | 文件 | 职责 |
 * |---|---|---|
 * | 实现层 | `operations/table/**` | 逐能力的纯计算 + 结构化拒绝（`DocumentModelError`） |
 * | **本层** | `table-workflow.ts` | 意图级入口 + **改动后自洽性**（网格无空洞/重叠、合并区合法）+ 内容守恒断言 |
 * | 消费层 | 上层（App / 文档会话） | 决定"要不要写进文件""要不要回显" |
 *
 * ## "操作后既有内容与合并关系必须自洽"是怎么被**断言**的
 *
 * 不是注释里的承诺，而是可复算的检查：
 *
 * 1. `checkTableConsistency` 建**二维占用矩阵**（复用实现层的 `buildGridMap`），报三类网格病
 *    （`hole` / `overlap` / `row_width_mismatch`），再把**每一个合并区**拿来核对：
 *    - 越出表格边界 ⇒ `merge_out_of_bounds`（**报错**）；
 *    - 与另一个合并区矩形相交 ⇒ `merge_overlap`（**报错**）。
 * 2. 结构类入口（增删行列、合并、拆分）在成功后**立刻**跑这一步（`verified()`），
 *    不自洽即整条操作判失败（失败分支**不带 model**，见 `operations/table/types.ts`）。
 * 3. **合并 / 拆分**另加**内容守恒**断言：把改动前后表格里所有 run 文本取成**多重集**比较——
 *    合并是"内容并到左上角"、拆分是"内容留在顶行"，**文本一条都不许蒸发**（WF-058 的判据句）。
 *
 * ## 表格样式（`w:tblStyle`）为什么**没有**入口却仍在清单里
 *
 * 冻结模型 `TableNode` **没有**样式引用字段（`TableProperties` 无 `style_ref`），
 * `StyleDefinition` 的 `table` 类也只有 run/paragraph 属性、没有表格边框字段。
 * 因此"套用表格样式"在本内核**表达不出来**：`setTableStyle` **明确拒绝**（`unsupported`），
 * 并用 `tableStyleSupport()` 把原因说清楚——**不静默无操作**，也不在 `opaque` 里塞一段
 * 导出器不认的片段假装打通（R105/R140/R154 的同一取向）。
 *
 * ## 未验证的部分（**不得当作已验证**）
 *
 * 本层只保证**模型态**自洽；渲染效果（Word 里看起来对不对）**未验证（需消费端）**：
 * 本机无 Word 授权、真机未连接。`TABLE_WORKFLOW_CAPABILITIES` 里每一项的 `wired` 只表示
 * "参数写进了模型且导出器会消费"，**不表示**"渲染正确"。
 *
 * ## 交付说明（身份标注，不得省略）
 *
 * 工作包 **FA-DOC-WF-TABLES**（分支 `fa/doc-wf-tables`）。
 * **子智能体模型身份未确认为 DS**；本文件由该子智能体产出，未经 DS 身份确认。
 */

import { DocumentModelError, type DocumentModelProblemCode } from './model/errors.js';
import {
  createNodeIdAllocator,
  nodePathSegment,
  parseNodeId,
  withSegment,
  type NodePath,
} from './model/ids.js';
import {
  materializeBlockNode,
  textParagraphNode,
  type DraftCellNode,
  type DraftTableNode,
} from './model/nodes.js';
import { collectNodeIds, findNodeById, findTableById, replaceCellInModel } from './model/walk.js';
import type {
  Alignment,
  BorderEdge,
  CellNode,
  DocumentModel,
  Length,
  NodeId,
  ParagraphNode,
  Shading,
  SourceKind,
  TableNode,
} from './model/types.js';
import { setAlignment } from './operations/paragraph/alignment.js';
import {
  autofitTable,
  buildGridMap,
  canMergeCells,
  clearRowHeight,
  deleteTable,
  describeGridProblem,
  distributeColumns,
  insertColumn,
  insertRow,
  insertTable,
  mergeCells,
  mergedRegions,
  regionWithinTable,
  removeColumn,
  removeRow,
  replaceTextInTable,
  runTableEdit,
  setCellBorders,
  setCellShading,
  setCellVerticalAlign,
  setColumnWidth,
  setHeaderRows,
  setRowHeight,
  setTableBorders,
  setTableShading,
  splitCell,
  tableFailure,
  type CellBorderEdge,
  type GridProblem,
  type Region,
  type TableBorderEdge,
  type TableOutcome,
} from './operations/table/index.js';

// ---------------------------------------------------------------------------
// 能力清单（机器可判：测试遍历它，防止"文档说支持、代码没入口"）
// ---------------------------------------------------------------------------

/** 表格工作流的一项能力。 */
export interface TableWorkflowCapability {
  /** 稳定 id（测试按它遍历，**不得随意改名**）。 */
  readonly id: string;
  readonly label: string;
  /** 参数是否**端到端**（写进模型且导出器消费）。`false` ≠ "有入口"，见 `exposed`。 */
  readonly wired: boolean;
  /** 本工作流是否给出了入口。 */
  readonly exposed: boolean;
  /** 说明（含缺口与"未验证"）。 */
  readonly note: string;
}

const RENDER_UNVERIFIED = '渲染效果未验证（需消费端；本机无 Word 授权、真机未连接）';

/**
 * 表格能力清单（WF-056–064）。`wired` 的口径见文件头——
 * 它说的是"进文件"，**不是**"渲染正确"。
 */
export const TABLE_WORKFLOW_CAPABILITIES: readonly TableWorkflowCapability[] = Object.freeze([
  {
    id: 'table.insert',
    label: '插入表格',
    wired: true,
    exposed: true,
    note: `WF-056；相邻表格会被主动隔开（separator_inserted 如实报出）。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'table.delete',
    label: '删除表格',
    wired: true,
    exposed: true,
    note: `WF-056；段落一律不动。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'table.row.insert',
    label: '插入行',
    wired: true,
    exposed: true,
    note: `WF-057；自动生成时接住纵向合并链（continued_merges 如实报出）。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'table.row.delete',
    label: '删除行',
    wired: true,
    exposed: true,
    note: `WF-057；删后修复纵向链（repaired_continues 如实报出）。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'table.column.insert',
    label: '插入列',
    wired: true,
    exposed: true,
    note: `WF-057；列宽必须给出（表格有网格定义时不允许悄悄借邻居宽度）。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'table.column.delete',
    label: '删除列',
    wired: true,
    exposed: true,
    note: `WF-057；切穿跨列合并/打断纵向链时明确拒绝（column_span_conflict）。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'table.cell.merge',
    label: '合并单元格',
    wired: true,
    exposed: true,
    note: `WF-058；越界 invalid_index、切穿既有合并 column_span_conflict；内容按行优先并入左上角（守恒已断言）。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'table.cell.split',
    label: '拆分单元格',
    wired: true,
    exposed: true,
    note: `WF-058；内容留在顶行（守恒已断言）。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'table.column.width',
    label: '列宽',
    wired: true,
    exposed: true,
    note: `WF-059；网格列宽与单元格首选宽度同步改（显式宽度才同步）。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'table.column.distribute',
    label: '均分列宽',
    wired: true,
    exposed: true,
    note: `WF-059；余数摊到前几列，Σ 列宽不缩水。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'table.autofit.window',
    label: '自适应窗口（列宽按可用宽度缩放）',
    wired: true,
    exposed: true,
    note: `WF-059；未给可用宽度时只标记布局为 autofit，交消费端重排。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'table.autofit.content',
    label: '自适应内容',
    wired: false,
    exposed: false,
    note: '需要真实排版度量，本内核没有排版引擎——**明确拒绝**（unsupported），不估算冒充（R158）。',
  },
  {
    id: 'table.row.height',
    label: '行高',
    wired: true,
    exposed: true,
    note: `WF-059；exact = 固定值、atLeast = 最小值。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'table.borders',
    label: '表格边框（整表）',
    wired: true,
    exposed: true,
    note: `WF-062；整表与局部是两组字段，分开设置。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'cell.borders',
    label: '单元格边框（局部）',
    wired: true,
    exposed: true,
    note: `WF-062；优先序 单元格 → 表格 → 文档默认（读回见 resolveCellBorders）。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'table.shading',
    label: '表格底纹',
    wired: true,
    exposed: true,
    note: `WF-062；与单元格底纹、段落底纹分开。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'cell.shading',
    label: '单元格底纹',
    wired: true,
    exposed: true,
    note: `WF-062。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'table.header.repeat',
    label: '表头行重复',
    wired: true,
    exposed: true,
    note: `WF-063；写 RowNode.header，导出器写 w:tblHeader。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'table.style',
    label: '表格样式',
    wired: false,
    exposed: true,
    note:
      '**模型答不上**：冻结模型的 TableNode 没有样式引用字段、StyleDefinition 也没有表格边框字段' +
      `——setTableStyle 明确拒绝（unsupported），不塞 opaque 片段假装打通。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'cell.alignment.vertical',
    label: '单元格垂直对齐',
    wired: true,
    exposed: true,
    note: `WF-061；导出器写 w:vAlign。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'cell.alignment.horizontal',
    label: '单元格水平对齐',
    wired: true,
    exposed: true,
    note:
      'WF-061 的"段落格式"分支：单元格里就是普通段落，水平对齐落在段落的 alignment 上' +
      `（单元格本身没有水平对齐字段）。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'cell.text',
    label: '设置单元格文本',
    wired: true,
    exposed: true,
    note: `WF-064；整格替换（原内容按用户意图丢弃，不是"找不到就静默不动"）。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'table.text.replace',
    label: '表格内查找替换',
    wired: true,
    exposed: true,
    note: 'WF-064；只在该表格的单元格里替换，表外一字不碰；命中 0 处是事实不是错误。',
  },
  {
    id: 'table.grid.consistency',
    label: '网格自洽检查（空洞 / 重叠 / 合并区越界与相交）',
    wired: true,
    exposed: true,
    note: 'WF-057/058 的判据实现：可独立复算，结构类操作后自动跑。',
  },
]);

// ---------------------------------------------------------------------------
// 自洽性（判据的可复算实现）
// ---------------------------------------------------------------------------

/** 一项自洽性问题。`kind` 可机械分支，`detail` 是人类可读补充。 */
export type TableConsistencyProblem =
  | { readonly kind: 'missing_table'; readonly detail: string }
  | { readonly kind: 'grid'; readonly problem: GridProblem; readonly detail: string }
  | { readonly kind: 'merge_out_of_bounds'; readonly region: Region; readonly detail: string }
  | {
      readonly kind: 'merge_overlap';
      readonly region: Region;
      readonly other: Region;
      readonly detail: string;
    };

/** 自洽性报告。 */
export interface TableConsistencyReport {
  readonly ok: boolean;
  readonly table_id: NodeId;
  readonly problems: readonly TableConsistencyProblem[];
}

function regionLabel(region: Region): string {
  return `第 ${String(region.top)}–${String(region.top + region.rows - 1)} 行、第 ${String(
    region.left,
  )}–${String(region.left + region.columns - 1)} 列`;
}

/** 两个合并区矩形是否相交（左上角 + 行列数表达，左闭右开）。 */
function regionsIntersect(left: Region, right: Region): boolean {
  return (
    left.left < right.left + right.columns &&
    right.left < left.left + left.columns &&
    left.top < right.top + right.rows &&
    right.top < left.top + left.rows
  );
}

/**
 * 表格自洽性检查（**只读、可独立复算**，不产生任何变更）。
 *
 * 报三类问题：网格病（空洞 / 重叠 / 参差）、合并区越界、合并区相交。
 * 缺失表格本身也算一项问题（`missing_table`），**不抛**——调用方据此决定是拒绝还是忽略。
 *
 * ## 两支"防御性"检查（**诚实登记：正常模型走不到**）
 *
 * `merge_out_of_bounds` 与 `merge_overlap` 在当前模型里**构造不出来**：
 * 合并区由 `grid.ts` 的 `regionOf` 从网格算术还原，天然落在表内；同一行内各单元格的列区间
 * 是按 `grid_span` **顺序累加**的（`model/table-grid.ts`），因此也不会互相占同一列。
 * 它们留在这里是**回归护栏**——将来若有人引入新的合并表示（或绕过工厂手造节点），
 * 这两支必须能报出来。当前能通过正常入口触发的"越界 / 重叠"是**请求级**的：
 * `mergeCellRange` 的越界 ⇒ `invalid_index`、与既有合并重叠（切穿）⇒ `column_span_conflict`。
 */
export function checkTableConsistency(model: DocumentModel, tableId: NodeId): TableConsistencyReport {
  const table = findTableById(model, tableId);
  if (table === null) {
    return {
      ok: false,
      table_id: tableId,
      problems: [{ kind: 'missing_table', detail: `正文里找不到表格 ${JSON.stringify(tableId)}` }],
    };
  }

  const problems: TableConsistencyProblem[] = [];
  const map = buildGridMap(table);
  for (const problem of map.problems) {
    problems.push({ kind: 'grid', problem, detail: describeGridProblem(problem) });
  }

  const regions = mergedRegions(table);
  for (let index = 0; index < regions.length; index += 1) {
    const region = regions[index];
    if (region === undefined) {
      continue;
    }
    if (!regionWithinTable(map, region)) {
      problems.push({
        kind: 'merge_out_of_bounds',
        region,
        detail: `合并区 ${regionLabel(region)} 越出表格边界（表格 ${String(map.row_count)} 行 ${String(
          map.column_count,
        )} 列）`,
      });
    }
    for (let other = index + 1; other < regions.length; other += 1) {
      const candidate = regions[other];
      if (candidate === undefined) {
        continue;
      }
      if (regionsIntersect(region, candidate)) {
        problems.push({
          kind: 'merge_overlap',
          region,
          other: candidate,
          detail: `合并区 ${regionLabel(region)} 与 ${regionLabel(candidate)} 重叠`,
        });
      }
    }
  }

  return { ok: problems.length === 0, table_id: tableId, problems };
}

/**
 * 断言自洽：不自洽即抛。
 *
 * 表找不到 ⇒ `unknown_node`；网格/合并区有问题 ⇒ `table_shape_invalid`
 * （detail 里带**第一条**问题的具体位置，供上层解释，R116）。
 */
export function assertTableConsistent(model: DocumentModel, tableId: NodeId): void {
  const report = checkTableConsistency(model, tableId);
  if (report.ok) {
    return;
  }
  const first = report.problems[0];
  if (first === undefined) {
    return;
  }
  if (first.kind === 'missing_table') {
    throw new DocumentModelError('unknown_node', first.detail);
  }
  throw new DocumentModelError(
    'table_shape_invalid',
    `表格 ${JSON.stringify(tableId)} 不自洽（共 ${String(report.problems.length)} 项）：${first.detail}`,
  );
}

/**
 * 结构类操作成功后的统一收口：**改动后**跑一遍自洽检查，不自洽即把整条操作判失败。
 *
 * 失败分支不带 `model`（R136）——调用方拿不到"改了一半的表"。
 */
function verified<Payload extends { readonly model: DocumentModel }>(
  outcome: TableOutcome<Payload>,
  tableId: NodeId,
): TableOutcome<Payload> {
  if (!outcome.ok) {
    return outcome;
  }
  const report = checkTableConsistency(outcome.model, tableId);
  if (report.ok) {
    return outcome;
  }
  const first = report.problems[0];
  return tableFailure(
    'table_shape_invalid',
    `操作后表格不自洽（实现缺陷，不是用户输入问题）：${first === undefined ? '<无>' : first.detail}`,
  );
}

/** 取表格（找不到即抛 `unknown_node`）。 */
function requireTable(model: DocumentModel, tableId: NodeId): TableNode {
  const table = findTableById(model, tableId);
  if (table === null) {
    throw new DocumentModelError('unknown_node', `正文里找不到表格 ${JSON.stringify(tableId)}`);
  }
  return table;
}

/** 取单元格（找不到 / 不是单元格即抛 `unknown_node`）。 */
function requireCell(model: DocumentModel, cellId: NodeId): CellNode {
  const node = findNodeById(model, cellId);
  if (node === null || node.kind !== 'cell') {
    throw new DocumentModelError('unknown_node', `找不到单元格 ${JSON.stringify(cellId)}`);
  }
  return node;
}

// ---------------------------------------------------------------------------
// 内容守恒（合并 / 拆分的"文本一条不丢"断言）
// ---------------------------------------------------------------------------

/** 一段段落里的 run 文本（非 run 行内节点不产文本）。 */
function paragraphTexts(paragraph: ParagraphNode): string[] {
  const texts: string[] = [];
  for (const inline of paragraph.inlines) {
    if (inline.kind === 'run') {
      texts.push(inline.text);
    }
  }
  return texts;
}

/**
 * 表格里**有内容的** run 文本（含嵌套表），按文档顺序。
 *
 * **空文本被排除**：拆分/插入产生的占位单元格必须有一个空段落（OOXML 的 `w:tc` 不能没有块），
 * 那是结构占位、不是内容——把它算进多重集会让"合并/拆分新增了几个空格子"污染守恒判定。
 * 这条口径与实现层一致：占位段落的 `source` 是 `system`，不是用户说的话（R109）。
 * 因此本断言管的是"**一个字都不许丢**"，不管"多了几个空壳"。
 */
function tableRunTexts(table: TableNode): string[] {
  const texts: string[] = [];
  const visitBlocks = (blocks: readonly { readonly kind: string }[]): void => {
    for (const block of blocks as readonly (ParagraphNode | TableNode)[]) {
      if (block.kind === 'paragraph') {
        texts.push(...paragraphTexts(block).filter((text) => text.length > 0));
        continue;
      }
      for (const row of block.rows) {
        for (const cell of row.cells) {
          visitBlocks(cell.blocks as readonly { readonly kind: string }[]);
        }
      }
    }
  };
  for (const row of table.rows) {
    for (const cell of row.cells) {
      visitBlocks(cell.blocks as readonly { readonly kind: string }[]);
    }
  }
  return texts;
}

/** 两个文本多重集是否相同（排序后逐项比较；`\u0000` 不会出现在正常文本里）。 */
function sameTextMultiset(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

// ---------------------------------------------------------------------------
// WF-056 表格的增删
// ---------------------------------------------------------------------------

/** 插入表格请求（`index` 省略 = 追加到正文末尾）。 */
export interface AddTableRequest {
  readonly index?: number;
  readonly table: DraftTableNode;
  readonly separate_adjacent_tables?: boolean;
  readonly ensure_trailing_paragraph?: boolean;
}

/** 插入表格（WF-056）。 */
export function addTable(
  model: DocumentModel,
  request: AddTableRequest,
): TableOutcome<{
  readonly model: DocumentModel;
  readonly table_id: NodeId;
  readonly block_index: number;
  readonly separator_inserted: boolean;
  readonly trailing_paragraph_added: boolean;
}> {
  return insertTable(model, {
    index: request.index ?? model.blocks.length,
    table: request.table,
    ...(request.separate_adjacent_tables === undefined
      ? {}
      : { separate_adjacent_tables: request.separate_adjacent_tables }),
    ...(request.ensure_trailing_paragraph === undefined
      ? {}
      : { ensure_trailing_paragraph: request.ensure_trailing_paragraph }),
  });
}

/** 删除表格（WF-056）。 */
export function removeTable(
  model: DocumentModel,
  request: { readonly table_id: NodeId; readonly separate_adjacent_tables?: boolean },
): TableOutcome<{
  readonly model: DocumentModel;
  readonly separator_inserted: boolean;
  readonly removed_index: number;
}> {
  return deleteTable(model, {
    table_id: request.table_id,
    ...(request.separate_adjacent_tables === undefined
      ? {}
      : { separate_adjacent_tables: request.separate_adjacent_tables }),
  });
}

// ---------------------------------------------------------------------------
// WF-057 行列的增删
// ---------------------------------------------------------------------------

/** 插入行请求；`index` 省略 = 追加到表末。 */
export interface AddTableRowRequest {
  readonly table_id: NodeId;
  readonly index?: number;
  readonly cells?: readonly DraftCellNode[] | null;
  readonly source?: SourceKind;
}

/** 插入行（WF-057），成功后再验一次网格自洽。 */
export function addTableRow(
  model: DocumentModel,
  request: AddTableRowRequest,
): TableOutcome<{
  readonly model: DocumentModel;
  readonly row_id: NodeId;
  readonly continued_merges: number;
}> {
  const table = findTableById(model, request.table_id);
  const index = request.index ?? (table === null ? 0 : table.rows.length);
  return verified(
    insertRow(model, {
      table_id: request.table_id,
      index,
      ...(request.cells === undefined ? {} : { cells: request.cells }),
      ...(request.source === undefined ? {} : { source: request.source }),
    }),
    request.table_id,
  );
}

/** 删除行（WF-057），成功后再验一次网格自洽。 */
export function removeTableRow(
  model: DocumentModel,
  request: { readonly table_id: NodeId; readonly index: number },
): TableOutcome<{ readonly model: DocumentModel; readonly repaired_continues: number }> {
  return verified(removeRow(model, request), request.table_id);
}

/** 插入列请求（WF-057）。 */
export interface AddTableColumnRequest {
  readonly table_id: NodeId;
  readonly index: number;
  readonly width?: Length | null;
  readonly cells?: readonly DraftCellNode[] | null;
  readonly source?: SourceKind;
}

/** 插入列（WF-057）。 */
export function addTableColumn(
  model: DocumentModel,
  request: AddTableColumnRequest,
): TableOutcome<{ readonly model: DocumentModel; readonly width: Length | null }> {
  // 表格必须有网格定义时，实现层拒绝"悄悄借邻居宽度"；这里不重复判据，只透传。
  requireTable(model, request.table_id);
  return verified(
    insertColumn(model, {
      table_id: request.table_id,
      index: request.index,
      ...(request.width === undefined ? {} : { width: request.width }),
      ...(request.cells === undefined ? {} : { cells: request.cells }),
      ...(request.source === undefined ? {} : { source: request.source }),
    }),
    request.table_id,
  );
}

/** 删除列（WF-057）；切穿合并时结构化拒绝。 */
export function removeTableColumn(
  model: DocumentModel,
  request: { readonly table_id: NodeId; readonly index: number },
): TableOutcome<{ readonly model: DocumentModel }> {
  return verified(removeColumn(model, request), request.table_id);
}

// ---------------------------------------------------------------------------
// WF-058 合并 / 拆分
// ---------------------------------------------------------------------------

/** 合并请求：一张表 + 一个矩形区域。 */
export interface MergeCellRangeRequest {
  readonly table_id: NodeId;
  readonly region: Region;
}

/** 合并结果（含内容守恒证据）。 */
export interface MergeCellRangeSuccess {
  readonly model: DocumentModel;
  readonly merged_region: Region;
  readonly absorbed_cells: number;
  /** **恒为 `true`**：合并前后文本多重集相同（不守恒即整条失败，不会走到这里）。 */
  readonly content_preserved: true;
}

/** 合并合法性预判（只读，不产生变更）。 */
export interface MergePreflight {
  readonly legal: boolean;
  readonly code: DocumentModelProblemCode | null;
  readonly detail: string;
  /** 合法时：将被并入左上角、从表中消失的单元格数。 */
  readonly absorbed_cells: number;
}

/**
 * 合并前预判（WF-058）。
 *
 * 与 `mergeCellRange` **共用同一份合法性判据**（实现层的 `canMergeCells`），
 * 不存在"预判说行、执行却拒绝"的两套逻辑。
 */
export function preflightMergeRegion(model: DocumentModel, request: MergeCellRangeRequest): MergePreflight {
  const outcome = canMergeCells(model, request);
  if (outcome.ok) {
    return { legal: true, code: null, detail: '可以合并', absorbed_cells: outcome.absorbed_cells };
  }
  return { legal: false, code: outcome.code, detail: outcome.detail, absorbed_cells: 0 };
}

/**
 * 合并单元格（WF-058）。
 *
 * 越界 ⇒ `invalid_index`；切穿既有合并区 ⇒ `column_span_conflict`；
 * 单格 / 已是一整块 ⇒ `unsupported`（**不静默无操作**）。
 * 成功后**断言**：网格自洽 + 文本多重集守恒。
 */
export function mergeCellRange(
  model: DocumentModel,
  request: MergeCellRangeRequest,
): TableOutcome<MergeCellRangeSuccess> {
  const outcome = mergeCells(model, request);
  if (!outcome.ok) {
    return outcome;
  }
  return runTableEdit(() => {
    assertTableConsistent(outcome.model, request.table_id);
    const before = tableRunTexts(requireTable(model, request.table_id));
    const after = tableRunTexts(requireTable(outcome.model, request.table_id));
    if (!sameTextMultiset(before, after)) {
      throw new DocumentModelError(
        'table_shape_invalid',
        '合并后文本不守恒（实现缺陷，不是用户输入问题）——本应把区域内全部内容并入左上角',
      );
    }
    return {
      model: outcome.model,
      merged_region: outcome.merged_region,
      absorbed_cells: outcome.absorbed_cells,
      content_preserved: true as const,
    };
  });
}

/** 拆分请求（定位到区域内任意一格）。 */
export interface SplitMergedCellRequest {
  readonly table_id: NodeId;
  readonly row: number;
  readonly column: number;
}

/** 拆分结果（含内容守恒证据）。 */
export interface SplitMergedCellSuccess {
  readonly model: DocumentModel;
  readonly region: Region;
  readonly created_cells: number;
  readonly content_preserved: true;
}

/**
 * 拆分单元格（WF-058）。没合并（1×1）⇒ `unsupported`；越界 ⇒ `invalid_index`。
 * 成功后**断言**：网格自洽 + 文本多重集守恒。
 */
export function splitMergedCell(
  model: DocumentModel,
  request: SplitMergedCellRequest,
): TableOutcome<SplitMergedCellSuccess> {
  const outcome = splitCell(model, request);
  if (!outcome.ok) {
    return outcome;
  }
  return runTableEdit(() => {
    assertTableConsistent(outcome.model, request.table_id);
    const before = tableRunTexts(requireTable(model, request.table_id));
    const after = tableRunTexts(requireTable(outcome.model, request.table_id));
    if (!sameTextMultiset(before, after)) {
      throw new DocumentModelError(
        'table_shape_invalid',
        '拆分后文本不守恒（实现缺陷，不是用户输入问题）——内容本应留在顶行',
      );
    }
    return {
      model: outcome.model,
      region: outcome.region,
      created_cells: outcome.created_cells,
      content_preserved: true as const,
    };
  });
}

// ---------------------------------------------------------------------------
// WF-059 列宽 / 行高
// ---------------------------------------------------------------------------

/** 设置列宽（WF-059）。 */
export function setTableColumnWidth(
  model: DocumentModel,
  request: { readonly table_id: NodeId; readonly column: number; readonly width: Length },
): TableOutcome<{ readonly model: DocumentModel; readonly synced_cells: number }> {
  return setColumnWidth(model, request);
}

/** 均分列宽（WF-059）。 */
export function distributeTableColumns(
  model: DocumentModel,
  request: { readonly table_id: NodeId; readonly total?: Length },
): TableOutcome<{ readonly model: DocumentModel; readonly column_widths: readonly Length[] }> {
  return distributeColumns(model, {
    table_id: request.table_id,
    ...(request.total === undefined ? {} : { total: request.total }),
  });
}

/**
 * 适应窗口（WF-059）。按可用宽度**等比例**缩放网格列宽；未给可用宽度时只把布局标为
 * `autofit`（交消费端按窗口宽度重排，本层不猜一个宽度）。
 *
 * 按**内容**自适应一律拒绝（需要排版引擎，见能力清单的 `table.autofit.content`）。
 */
export function fitTableToWindow(
  model: DocumentModel,
  request: { readonly table_id: NodeId; readonly available_width?: Length },
): TableOutcome<{ readonly model: DocumentModel; readonly layout: 'autofit'; readonly column_widths: readonly Length[] }> {
  return autofitTable(model, {
    table_id: request.table_id,
    mode: 'window',
    ...(request.available_width === undefined ? {} : { available_width: request.available_width }),
  });
}

/** 设置行高（WF-059）：`exact` 固定值 / `atLeast` 最小值。 */
export function setTableRowHeight(
  model: DocumentModel,
  request: { readonly row_id: NodeId; readonly rule: 'exact' | 'atLeast'; readonly value: Length },
): TableOutcome<{ readonly model: DocumentModel; readonly row_id: NodeId }> {
  return setRowHeight(model, request);
}

/** 清除行高（回到"由内容决定"）。 */
export function clearTableRowHeight(
  model: DocumentModel,
  request: { readonly row_id: NodeId },
): TableOutcome<{ readonly model: DocumentModel; readonly row_id: NodeId }> {
  return clearRowHeight(model, request.row_id);
}

// ---------------------------------------------------------------------------
// WF-062 边框 / 底纹
// ---------------------------------------------------------------------------

/** 设置整表边框的若干条边（WF-062）。 */
export function setTableBorderEdges(
  model: DocumentModel,
  request: { readonly table_id: NodeId; readonly borders: Partial<Record<TableBorderEdge, BorderEdge>> },
): TableOutcome<{ readonly model: DocumentModel; readonly table_id: NodeId }> {
  return setTableBorders(model, request);
}

/** 设置单元格边框的若干条边（WF-062"局部"）。 */
export function setTableCellBorders(
  model: DocumentModel,
  request: { readonly cell_id: NodeId; readonly borders: Partial<Record<CellBorderEdge, BorderEdge>> },
): TableOutcome<{ readonly model: DocumentModel; readonly cell_id: NodeId }> {
  return setCellBorders(model, request);
}

/** 设置整表底纹（WF-062）。 */
export function setTableBackground(
  model: DocumentModel,
  request: { readonly table_id: NodeId; readonly shading: Shading },
): TableOutcome<{ readonly model: DocumentModel; readonly table_id: NodeId }> {
  return setTableShading(model, request);
}

/** 设置单元格底纹（WF-062）。 */
export function setTableCellBackground(
  model: DocumentModel,
  request: { readonly cell_id: NodeId; readonly shading: Shading },
): TableOutcome<{ readonly model: DocumentModel; readonly cell_id: NodeId }> {
  return setCellShading(model, request);
}

// ---------------------------------------------------------------------------
// WF-063 表头重复
// ---------------------------------------------------------------------------

/** 把前 `count` 行标成表头（重复到每页顶部）。 */
export function repeatTableHeaderRows(
  model: DocumentModel,
  request: { readonly table_id: NodeId; readonly count: number },
): TableOutcome<{ readonly model: DocumentModel; readonly header_rows: readonly NodeId[] }> {
  return setHeaderRows(model, request);
}

// ---------------------------------------------------------------------------
// 表格样式（模型缺口 ⇒ 明确拒绝 + 可复算说明）
// ---------------------------------------------------------------------------

/** 表格样式支持情况（只读）。 */
export interface TableStyleSupport {
  /** **恒为 `false`**：冻结模型装不下表格样式引用。 */
  readonly supported: false;
  readonly reason: string;
  /** 缺哪个字段、缺在哪个类型上（供证据文本引用）。 */
  readonly missing: string;
}

/** 读表格样式的支持情况（不产生变更；把"为什么不行"变成可复算的一行）。 */
export function tableStyleSupport(): TableStyleSupport {
  return {
    supported: false,
    reason:
      '冻结模型的 TableNode/TableProperties 没有样式引用字段，StyleDefinition 也只有 run/paragraph ' +
      '属性、没有表格边框字段：套用表格样式在本内核**表达不出来**（不静默无操作，也不塞 opaque 片段）。',
    missing: 'TableProperties.style_ref（+ StyleDefinition 的表格属性层）',
  };
}

/**
 * 设置表格样式（**明确拒绝**，WF-062 的 `w:tblStyle` 分支）。
 *
 * 一律返回 `unsupported`，模型一个字节不动——理由见 `tableStyleSupport()`。
 * 之所以仍给出入口：上层需要**可机械判别**的"不支持"，而不是"调用了一个不存在的函数"。
 */
export function setTableStyle(
  _model: DocumentModel,
  request: { readonly table_id: NodeId; readonly style_id: string },
): TableOutcome<{ readonly model: DocumentModel; readonly table_id: NodeId }> {
  return tableFailure(
    'unsupported',
    `表格 ${JSON.stringify(request.table_id)} 无法套用样式 ${JSON.stringify(request.style_id)}：` +
      tableStyleSupport().reason,
  );
}

// ---------------------------------------------------------------------------
// WF-061/064 单元格对齐与文本
// ---------------------------------------------------------------------------

/** 设置单元格垂直对齐（WF-061）。 */
export function alignCellVertically(
  model: DocumentModel,
  request: { readonly cell_id: NodeId; readonly align: 'top' | 'center' | 'bottom' },
): TableOutcome<{ readonly model: DocumentModel; readonly cell_id: NodeId }> {
  return setCellVerticalAlign(model, request);
}

/**
 * 设置单元格**水平**对齐（WF-061 的"段落格式"分支）。
 *
 * 单元格本身没有水平对齐字段——水平对齐属于单元格里的**段落**。本函数把该单元格直属的
 * 每个段落（含嵌套表所在的段落）都设为给定对齐；嵌套表格的**内部**单元格段落不动
 * （那是另一格的事，越权改它会"改一整片"）。
 */
export function alignCellHorizontally(
  model: DocumentModel,
  request: { readonly cell_id: NodeId; readonly alignment: Alignment },
): TableOutcome<{ readonly model: DocumentModel; readonly cell_id: NodeId; readonly paragraphs: number }> {
  return runTableEdit(() => {
    const cell = requireCell(model, request.cell_id);
    let updated = 0;
    const blocks = cell.blocks.map((block) => {
      if (block.kind !== 'paragraph') {
        return block;
      }
      updated += 1;
      return { ...block, properties: setAlignment(block.properties, request.alignment) };
    });
    return {
      model: replaceCellInModel(model, request.cell_id, { ...cell, blocks }),
      cell_id: request.cell_id,
      paragraphs: updated,
    };
  });
}

/** 单元格自身的路径（从规范 id 反解；反解失败时退回合成路径，唯一性仍由分配器保证）。 */
function cellOwnPath(cellId: NodeId): NodePath {
  return parseNodeId(cellId)?.path ?? [nodePathSegment('cell', 0)];
}

/**
 * 设置单元格文本（WF-064）：把该单元格的块**整体替换**成"一个含给定文本的段落"。
 *
 * `source` 默认 `user_request`——这是用户/上层明确要求写入的内容，**不是**系统占位
 * （与拆分/插入产生的空单元格用 `system` 相反，R109）。
 * 新段落取"单元格路径 + paragraph:0"的稳定 id（R101）。
 */
export function setCellText(
  model: DocumentModel,
  request: { readonly cell_id: NodeId; readonly text: string; readonly source?: SourceKind },
): TableOutcome<{ readonly model: DocumentModel; readonly cell_id: NodeId; readonly block_id: NodeId }> {
  return runTableEdit(() => {
    const cell = requireCell(model, request.cell_id);
    const source: SourceKind = request.source ?? 'user_request';
    const path = withSegment(cellOwnPath(cell.id), 'paragraph', 0);
    const block = materializeBlockNode(
      textParagraphNode({ text: request.text, source }),
      path,
      createNodeIdAllocator(collectNodeIds(model)),
    );
    return {
      model: replaceCellInModel(model, cell.id, { ...cell, blocks: [block] }),
      cell_id: cell.id,
      block_id: block.id,
    };
  });
}

/** 表格内查找替换（WF-064）：只在该表格的单元格里替换，表外一字不碰。 */
export function replaceTableText(
  model: DocumentModel,
  request: { readonly table_id: NodeId; readonly find: string; readonly replace: string },
): TableOutcome<{ readonly model: DocumentModel; readonly replaced: number; readonly cell_ids: readonly NodeId[] }> {
  return replaceTextInTable(model, request);
}

// ---------------------------------------------------------------------------
// 只读快照
// ---------------------------------------------------------------------------

/** 单元格可见文本（块用空格连接；非段落块不产文本）。 */
function cellVisibleText(cell: CellNode): string {
  return cell.blocks
    .map((block) =>
      block.kind !== 'paragraph'
        ? ''
        : block.inlines.map((inline) => (inline.kind === 'run' ? inline.text : '')).join(''),
    )
    .join(' ');
}

/** 表格只读快照（诊断 / 回显用；**不产生任何变更**）。 */
export interface TableSnapshot {
  readonly table_id: NodeId;
  readonly rows: number;
  readonly columns: number;
  readonly merges: readonly Region[];
  readonly header_rows: readonly NodeId[];
  readonly texts: readonly (readonly string[])[];
  /** 网格病（判据"不出现空洞或重叠"的读数）。 */
  readonly grid_problems: readonly GridProblem[];
  readonly consistent: boolean;
}

/** 取表格快照（找不到即抛 `unknown_node`）。 */
export function readTable(model: DocumentModel, tableId: NodeId): TableSnapshot {
  const table = requireTable(model, tableId);
  const map = buildGridMap(table);
  const report = checkTableConsistency(model, tableId);
  return {
    table_id: tableId,
    rows: table.rows.length,
    columns: map.column_count,
    merges: mergedRegions(table),
    header_rows: table.rows.filter((row) => row.header).map((row) => row.id),
    texts: table.rows.map((row) => row.cells.map((cell) => cellVisibleText(cell))),
    grid_problems: map.problems,
    consistent: report.ok,
  };
}

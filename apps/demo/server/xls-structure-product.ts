/**
 * **XLSX 结构操作的产品 HTTP 入口**（工作包 FA-XLS-STRUCTURE-PRODUCT）。
 *
 * ## 这个文件补的是什么缺口（`fa/prod-depth-h` 的实测结论翻正）
 *
 * `fa/prod-depth-h` 实测：产品面 `/api/deliverables/:id/edits` 挂的是**封闭枚举**的
 * `xlsxDeliverableAdapter`（只有 6 个 op）⇒ **冻结窗格 / 合并拆分 / 列宽行高 / 复制 / 移动 /
 * 隐藏**在产品 HTTP 上**根本不存在**（一律 `422 unsupported`）。这些能力在 `src/spreadsheets/**`
 * 里都造好了（`ranges.ts` 的 `freezePanes` / `mergeCells` / `setRowHeight` / `setColumnWidth` /
 * `hideRows` / `hideColumns`，`sheet.ts` 的增删行列与引用迁移），只是**没有产品入口**。
 *
 * 本文件新增独立前缀 `/api/xls-structure/**`（与既有前缀**不重叠**，由 `route-dispatch-scan`
 * 现推校验），把那层能力接到 HTTP。
 *
 * ## 三条硬纪律（每条都配反向对照，见同名 `.test.ts`）
 *
 * 1. **绝不自造行号算术**：行列增删**直接调用** `ranges.ts` 的
 *    `insertSheetRows` / `deleteSheetRows` / `insertSheetColumns` / `deleteSheetColumns`，
 *    由它们**委托** `sheet.ts → formula.ts → reference.ts` 完成"单元格地址 + 公式引用"的迁移。
 *    本文件**一行引用算术都不写**。判据落在**真实字节**上：删/插之后，导出的
 *    `xl/worksheets/sheetN.xml` 里 `<f>` 的引用必须**已经迁移**（见测试的
 *    `A1→A2` / `B1→C1` 断言）。
 * 2. **真实字节 + 独立读回**：导出后**解开 ZIP 逐表读回**（`<cols>/<col>`、`<row ht>`、
 *    `<row hidden>`、`<mergeCells>`、`<pane>`、工作簿里的 `state="hidden"`）。
 *    **反向对照**：不做任何结构操作 ⇒ 导出里**零**这些元素。
 * 3. **具名拒绝且源零改动**：合并越界 / 重叠、删除唯一工作表、非法宽高，都在**导出之前**
 *    具名拒绝（不同 `code`），**不产出任何字节**——即"源零改动"。
 *
 * ## ⚠️ 如实标注（结果不得编造；本层的真实边界）
 *
 * - **几何（行高 / 列宽 / 隐藏行列）需产品层补齐序列化**：本仓工作簿写出器
 *   `writeWorkbookXlsx` 只把 `<pane>`（冻结）、`<mergeCells>`（合并）与工作簿级
 *   `state="hidden"`（整表隐藏）写进字节；`SheetLayoutState` 的**行高 / 列宽 / 隐藏行列**
 *   **没有**写出口（`grep` 可复核：`src/spreadsheets/**` 里没有任何 `el('cols')` /
 *   `customWidth` / `customHeight`）。因此本模块在**导出字节之上**把这几类几何**按
 *   CT_Worksheet 子元素规范序列**注入工作表部件（复用既有 `el`/`attr`/`parseXml`/
 *   `serializeParsedXmlNode`/`readZip`/`writeZip` 原语，**不手拼 XML 字符串、不自己读写 ZIP**）。
 *   这是**如实登记的一处产品层补齐**，不是"内核已有出口"。
 * - **消费端未验证**：真实 Excel / WPS / 安卓办公套件如何呈现这些结构，本包**未验证**
 *   （无消费端在位）。本包只证明"结构**真的写进了 .xlsx 字节**"。
 * - **导入不恢复几何**：读侧（`readWorkbookXlsx`）不建模行高 / 列宽 / 隐藏行列，导入既有
 *   `.xlsx` 时这些几何**不会**被恢复（如实边界，不是静默丢弃——通道本来就不存在）。
 * - **合并越界的判据来自内核 `parseRange`**；重叠判据与 `ranges.ts` 的同名规则一致
 *   （本文件只做**前置**判定以便给具名 `code`；真正的拒绝仍由内核 `mergeCells` 兜底）。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  XML_DECLARATION,
  attr,
  el,
  readZip,
  serializeXmlNode,
  utf8Bytes,
  writeZip,
  type XmlElement,
} from '../../../src/artifacts/ooxml/index.js';
import {
  SPREADSHEETML_NAMESPACE,
  XLSX_WORKBOOK_PART_PATH,
  xlsxContentDigest,
} from '../../../src/artifacts/templates/xlsx.js';
import {
  attributeValue,
  childElements,
  findChild,
  parseXml,
  serializeParsedXmlNode,
  type ParsedXmlAttribute,
  type ParsedXmlElement,
  type ParsedXmlNode,
} from '../../../src/documents/docx/xml-parse.js';
import { ValidationError } from '../../../src/protocol/index.js';
import {
  addSheet,
  autoFitColumn,
  booleanValue,
  clearColumnWidth,
  clearRowHeight,
  columnLettersToNumber,
  copySheet,
  createSheet,
  createSheetLayout,
  createWorkbook,
  deleteSheetColumns,
  deleteSheetRows,
  formulaValue,
  freezePanes,
  getSheet,
  insertSheetColumns,
  insertSheetRows,
  mergeCells,
  moveSheet,
  numberValue,
  parseRange,
  readWorkbookXlsx,
  removeSheet,
  renameSheet,
  setActiveSheet,
  setCellValue,
  setColumnWidth,
  setColumnsHidden,
  setRowHeight,
  setRowsHidden,
  setSheetHidden,
  textValue,
  unmergeCells,
  worksheetPartPath,
  writeWorkbookXlsx,
  type CellValue,
  type SheetLayoutState,
  type SheetState,
  type WorkbookState,
} from '../../../src/spreadsheets/index.js';

// ---------------------------------------------------------------------------
// 挂载点与常量
// ---------------------------------------------------------------------------

/** 本模块独占的路由根；`http.ts` 只按这个前缀转交（与既有前缀不重叠）。 */
export const XLS_STRUCTURE_ROOT = '/api/xls-structure';

/** 请求体上限（与打印入口同口径）。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** 工作表部件路径（读回扫描用）。 */
const WORKSHEET_PART = /^xl\/worksheets\/sheet\d+\.xml$/;

/** 本路由**直接 import 并调用**的内核模块（→ 它们获得了非测试消费者）。 */
export const XLS_STRUCTURE_MODULES_REACHABLE_BY_ROUTE: readonly string[] = Object.freeze([
  'src/spreadsheets/ranges.ts',
  'src/spreadsheets/sheet.ts',
  'src/spreadsheets/workbook.ts',
  'src/spreadsheets/reference.ts',
  'src/spreadsheets/formula.ts',
  'src/spreadsheets/xlsx-write.ts',
  'src/spreadsheets/xlsx-read.ts',
]);

/** 本路由仍未覆盖的边界（如实登记，不声称已覆盖）。 */
export const XLS_STRUCTURE_NOT_WIRED_BY_ROUTE: readonly string[] = Object.freeze([
  '真实 Excel / WPS / 安卓办公套件打开交付字节时如何呈现这些结构 —— 本批无消费端',
  '读侧不建模行高 / 列宽 / 隐藏行列：导入既有 .xlsx 时这些几何不会被恢复',
  '把结构操作接到 `/api/deliverables/:id/edits` 的会话链（本包是独立前缀的一次性入口）',
]);

/** 未验证清单（如实登记，不写进任何"已完成"判定）。 */
export const XLS_STRUCTURE_UNVERIFIED: readonly string[] = Object.freeze([
  '真实消费端（Excel / WPS / 安卓办公套件）对冻结窗格 / 合并 / 宽高 / 隐藏的呈现',
  '安卓端把结构视图渲染成气泡 / 面板的消费路径（本包只交付只读 HTTP 出口 + 一次性导出）',
  '几何序列化对既有第三方 .xlsx 里复杂 cols/row 组合的兼容性（只覆盖本仓写出器产出的部件）',
]);

/** 本层支持的全部结构操作名（`/status` 如实列出）。 */
export const XLS_STRUCTURE_OPS: readonly string[] = Object.freeze([
  'insert_rows',
  'delete_rows',
  'insert_columns',
  'delete_columns',
  'set_row_height',
  'set_column_width',
  'auto_fit_column',
  'set_rows_hidden',
  'set_columns_hidden',
  'freeze_panes',
  'merge_cells',
  'unmerge_cells',
  'add_sheet',
  'delete_sheet',
  'rename_sheet',
  'copy_sheet',
  'move_sheet',
  'hide_sheet',
]);

// ---------------------------------------------------------------------------
// 具名拒绝
// ---------------------------------------------------------------------------

/**
 * 结构操作的**具名拒绝**：带稳定的 `code`，HTTP 层据此映射状态码。
 *
 * 「源零改动」由**时序**保证：所有拒绝都发生在导出**之前**，因此拒绝响应里
 * 既没有字节、也没有摘要——调用方无法拿到"改了一半"的文件。
 */
export class StructureRejection extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StructureRejection';
    this.code = code;
  }
}

/** 拒绝码 → HTTP 状态（只有"目标不存在"是 404，其余都是"字段齐全但被业务规则拒绝"=422）。 */
function statusOfRejection(code: string): number {
  return code === 'sheet_not_found' ? 404 : 422;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new StructureRejection('invalid_op', `${field} 必须是非空字符串`);
  }
  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new StructureRejection('invalid_op', `${field} 必须是整数`);
  }
  return value;
}

/** 列标识：数字列号或字母（`B`）；一律经内核 `columnLettersToNumber` 解析，不自造换算。 */
function requireColumn(value: unknown, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 1) {
      throw new StructureRejection('invalid_op', `${field} 的列号必须是 ≥1 的整数`);
    }
    return value;
  }
  if (typeof value === 'string' && value.length > 0) {
    try {
      return columnLettersToNumber(value);
    } catch (error) {
      throw new StructureRejection('invalid_op', `${field} 的列字母非法：${describe(error)}`);
    }
  }
  throw new StructureRejection('invalid_op', `${field} 必须是列字母或 ≥1 的整数列号`);
}

function decodeBase64Strict(raw: string): Uint8Array | null {
  const text = raw.trim();
  if (text.length === 0 || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  const buffer = Buffer.from(text, 'base64');
  if (buffer.toString('base64') !== text) return null;
  return new Uint8Array(buffer);
}

// ---------------------------------------------------------------------------
// 请求体 → 工作簿
// ---------------------------------------------------------------------------

function readCellValue(raw: Record<string, unknown>): CellValue {
  if (typeof raw['text'] === 'string') return textValue(raw['text']);
  if (typeof raw['number'] === 'number') return numberValue(raw['number']);
  if (typeof raw['boolean'] === 'boolean') return booleanValue(raw['boolean']);
  if (typeof raw['formula'] === 'string') return formulaValue(raw['formula']);
  throw new StructureRejection('invalid_cell', 'cell 需要 text / number / boolean / formula 之一');
}

/** 读工作簿规格：`{ sheets: [{ name, row_count?, column_count?, hidden?, cells?: [{ref, …}] }] }`。 */
function readWorkbookSpec(raw: unknown): WorkbookState {
  if (!isRecord(raw)) throw new StructureRejection('invalid_workbook', 'workbook 必须是对象');
  const sheetsRaw = raw['sheets'];
  if (!Array.isArray(sheetsRaw) || sheetsRaw.length === 0) {
    throw new StructureRejection('invalid_workbook', 'workbook.sheets 必须是非空数组');
  }
  const sheets: SheetState[] = sheetsRaw.map((entry) => {
    if (!isRecord(entry)) throw new StructureRejection('invalid_workbook', 'workbook.sheets 的每一项必须是对象');
    const name = requireString(entry['name'], 'sheet.name');
    const rowCount = entry['row_count'];
    const columnCount = entry['column_count'];
    const hidden = entry['hidden'];
    let sheet = createSheet(name, {
      ...(typeof rowCount === 'number' ? { row_count: rowCount } : {}),
      ...(typeof columnCount === 'number' ? { column_count: columnCount } : {}),
      ...(typeof hidden === 'boolean' ? { hidden } : {}),
    });
    const cells = entry['cells'];
    if (cells !== undefined) {
      if (!Array.isArray(cells)) throw new StructureRejection('invalid_cells', `工作表 ${JSON.stringify(name)} 的 cells 必须是数组`);
      for (const cell of cells) {
        if (!isRecord(cell)) throw new StructureRejection('invalid_cell', 'cell 必须是对象');
        const ref = requireString(cell['ref'], 'cell.ref');
        sheet = setCellValue(sheet, ref, readCellValue(cell));
      }
    }
    return sheet;
  });
  try {
    return createWorkbook(sheets);
  } catch (error) {
    throw new StructureRejection('invalid_workbook', describe(error));
  }
}

// ---------------------------------------------------------------------------
// 操作执行（全部委托内核；本文件不做任何引用算术）
// ---------------------------------------------------------------------------

interface StructureState {
  workbook: WorkbookState;
  layouts: Map<string, SheetLayoutState>;
}

function replaceSheet(workbook: WorkbookState, name: string, sheet: SheetState): WorkbookState {
  const activeName = workbook.sheets[workbook.active_sheet]?.name;
  const rebuilt = createWorkbook(workbook.sheets.map((item) => (item.name === name ? sheet : item)));
  return activeName === undefined ? rebuilt : setActiveSheet(rebuilt, activeName);
}

/** 取某表的几何；`.sheet` 一律以**当前工作簿**为准（避免两处状态漂移）。 */
function layoutFor(state: StructureState, name: string): SheetLayoutState {
  const sheet = getSheet(state.workbook, name);
  if (sheet === undefined) {
    throw new StructureRejection('sheet_not_found', `工作簿里没有工作表 ${JSON.stringify(name)}`);
  }
  const stored = state.layouts.get(name);
  return stored === undefined ? createSheetLayout(sheet) : Object.freeze({ ...stored, sheet });
}

/** 应用一次几何变更：几何回写 `layouts`，其携带的 `SheetState` 回写 `workbook`（两者永远同进同退）。 */
function applyLayout(state: StructureState, name: string, next: SheetLayoutState): void {
  state.workbook = replaceSheet(state.workbook, name, next.sheet);
  state.layouts.set(name, next);
}

function rangesOverlap(a: { start: { column: number; row: number }; end: { column: number; row: number } }, b: { start: { column: number; row: number }; end: { column: number; row: number } }): boolean {
  // 与 `src/spreadsheets/ranges.ts` 的 `rangesOverlap` 同一条规则（前置判定用，内核仍兜底）。
  return (
    a.start.column <= b.end.column &&
    a.end.column >= b.start.column &&
    a.start.row <= b.end.row &&
    a.end.row >= b.start.row
  );
}

function applyOp(state: StructureState, op: Record<string, unknown>): Record<string, unknown> {
  const name = requireString(op['op'], 'op.op');

  switch (name) {
    case 'insert_rows': {
      const sheet = requireString(op['sheet'], 'op.sheet');
      const layout = layoutFor(state, sheet);
      const next = insertSheetRows(layout, requireInteger(op['at'], 'op.at'), requireInteger(op['count'], 'op.count'));
      applyLayout(state, sheet, next);
      return { op: name, sheet, at: op['at'], count: op['count'] };
    }
    case 'delete_rows': {
      const sheet = requireString(op['sheet'], 'op.sheet');
      const layout = layoutFor(state, sheet);
      const next = deleteSheetRows(layout, requireInteger(op['at'], 'op.at'), requireInteger(op['count'], 'op.count'));
      applyLayout(state, sheet, next);
      return { op: name, sheet, at: op['at'], count: op['count'] };
    }
    case 'insert_columns': {
      const sheet = requireString(op['sheet'], 'op.sheet');
      const layout = layoutFor(state, sheet);
      const next = insertSheetColumns(layout, requireInteger(op['at'], 'op.at'), requireInteger(op['count'], 'op.count'));
      applyLayout(state, sheet, next);
      return { op: name, sheet, at: op['at'], count: op['count'] };
    }
    case 'delete_columns': {
      const sheet = requireString(op['sheet'], 'op.sheet');
      const layout = layoutFor(state, sheet);
      const next = deleteSheetColumns(layout, requireInteger(op['at'], 'op.at'), requireInteger(op['count'], 'op.count'));
      applyLayout(state, sheet, next);
      return { op: name, sheet, at: op['at'], count: op['count'] };
    }
    case 'set_row_height': {
      const sheet = requireString(op['sheet'], 'op.sheet');
      const row = requireInteger(op['row'], 'op.row');
      const layout = layoutFor(state, sheet);
      const rawHeight = op['height'];
      if (rawHeight === null || rawHeight === undefined) {
        applyLayout(state, sheet, clearRowHeight(layout, row));
        return { op: name, sheet, row, height: null };
      }
      if (typeof rawHeight !== 'number' || !Number.isFinite(rawHeight) || rawHeight <= 0) {
        throw new StructureRejection('invalid_size', `行高必须是正有限数（收到 ${JSON.stringify(rawHeight)}）`);
      }
      applyLayout(state, sheet, setRowHeight(layout, row, rawHeight));
      return { op: name, sheet, row, height: rawHeight };
    }
    case 'set_column_width': {
      const sheet = requireString(op['sheet'], 'op.sheet');
      const column = requireColumn(op['column'], 'op.column');
      const layout = layoutFor(state, sheet);
      const rawWidth = op['width'];
      if (rawWidth === null || rawWidth === undefined) {
        applyLayout(state, sheet, clearColumnWidth(layout, column));
        return { op: name, sheet, column, width: null };
      }
      if (typeof rawWidth !== 'number' || !Number.isFinite(rawWidth) || rawWidth <= 0) {
        throw new StructureRejection('invalid_size', `列宽必须是正有限数（收到 ${JSON.stringify(rawWidth)}）`);
      }
      applyLayout(state, sheet, setColumnWidth(layout, column, rawWidth));
      return { op: name, sheet, column, width: rawWidth };
    }
    case 'auto_fit_column': {
      const sheet = requireString(op['sheet'], 'op.sheet');
      const column = requireColumn(op['column'], 'op.column');
      const layout = layoutFor(state, sheet);
      const next = autoFitColumn(layout, column);
      applyLayout(state, sheet, next);
      return { op: name, sheet, column, width: next.column_widths.get(column) ?? null };
    }
    case 'set_rows_hidden': {
      const sheet = requireString(op['sheet'], 'op.sheet');
      const layout = layoutFor(state, sheet);
      const next = setRowsHidden(layout, requireInteger(op['at'], 'op.at'), requireInteger(op['count'], 'op.count'), op['hidden'] === true);
      applyLayout(state, sheet, next);
      return { op: name, sheet, at: op['at'], count: op['count'], hidden: op['hidden'] === true };
    }
    case 'set_columns_hidden': {
      const sheet = requireString(op['sheet'], 'op.sheet');
      const layout = layoutFor(state, sheet);
      const next = setColumnsHidden(layout, requireInteger(op['at'], 'op.at'), requireInteger(op['count'], 'op.count'), op['hidden'] === true);
      applyLayout(state, sheet, next);
      return { op: name, sheet, at: op['at'], count: op['count'], hidden: op['hidden'] === true };
    }
    case 'freeze_panes': {
      const sheet = requireString(op['sheet'], 'op.sheet');
      const layout = layoutFor(state, sheet);
      const rows = op['rows'] === undefined ? 0 : requireInteger(op['rows'], 'op.rows');
      const columns = op['columns'] === undefined ? 0 : requireInteger(op['columns'], 'op.columns');
      applyLayout(state, sheet, freezePanes(layout, rows, columns));
      return { op: name, sheet, rows, columns };
    }
    case 'merge_cells': {
      const sheet = requireString(op['sheet'], 'op.sheet');
      const rangeText = requireString(op['range'], 'op.range');
      const layout = layoutFor(state, sheet);
      // 前置判定：越界 / 单格 / 与已有合并区重叠 ⇒ 具名拒绝（真正的执行仍由内核 `mergeCells` 兜底）。
      let range: ReturnType<typeof parseRange>;
      try {
        range = parseRange(rangeText);
      } catch (error) {
        throw new StructureRejection('merge_out_of_bounds', `合并区域 ${JSON.stringify(rangeText)} 越界或写法非法：${describe(error)}`);
      }
      if (range.start.column === range.end.column && range.start.row === range.end.row) {
        throw new StructureRejection('merge_too_small', `合并区域 ${JSON.stringify(rangeText)} 至少需要两格`);
      }
      for (const existing of layout.sheet.merged) {
        if (rangesOverlap(range, parseRange(existing))) {
          throw new StructureRejection('merge_overlap', `合并区域 ${JSON.stringify(rangeText)} 与已有合并区 ${JSON.stringify(existing)} 重叠`);
        }
      }
      applyLayout(state, sheet, mergeCells(layout, rangeText));
      return { op: name, sheet, range: rangeText };
    }
    case 'unmerge_cells': {
      const sheet = requireString(op['sheet'], 'op.sheet');
      const rangeText = requireString(op['range'], 'op.range');
      const layout = layoutFor(state, sheet);
      applyLayout(state, sheet, unmergeCells(layout, rangeText));
      return { op: name, sheet, range: rangeText };
    }
    case 'add_sheet': {
      const sheetName = requireString(op['name'], 'op.name');
      state.workbook = addSheet(state.workbook, sheetName);
      return { op: name, name: sheetName };
    }
    case 'delete_sheet': {
      const sheet = requireString(op['sheet'], 'op.sheet');
      if (getSheet(state.workbook, sheet) === undefined) {
        throw new StructureRejection('sheet_not_found', `工作簿里没有工作表 ${JSON.stringify(sheet)}`);
      }
      if (state.workbook.sheets.length <= 1) {
        throw new StructureRejection('last_sheet_forbidden', '工作簿至少保留一张工作表：拒绝删除最后一张');
      }
      state.workbook = removeSheet(state.workbook, sheet);
      state.layouts.delete(sheet);
      return { op: name, sheet };
    }
    case 'rename_sheet': {
      const from = requireString(op['from'], 'op.from');
      const to = requireString(op['to'], 'op.to');
      state.workbook = renameSheet(state.workbook, from, to);
      const stored = state.layouts.get(from);
      if (stored !== undefined) {
        state.layouts.delete(from);
        state.layouts.set(to, stored);
      }
      return { op: name, from, to };
    }
    case 'copy_sheet': {
      const sheet = requireString(op['sheet'], 'op.sheet');
      const newName = requireString(op['new_name'], 'op.new_name');
      const source = layoutFor(state, sheet);
      state.workbook = copySheet(state.workbook, sheet, newName);
      const cloned = getSheet(state.workbook, newName);
      /* c8 ignore next -- copySheet 成功后该表必然存在 */
      if (cloned === undefined) throw new StructureRejection('invalid_op', `复制工作表 ${JSON.stringify(newName)} 失败`);
      state.layouts.set(newName, Object.freeze({ ...source, sheet: cloned }));
      return { op: name, sheet, new_name: newName };
    }
    case 'move_sheet': {
      const sheet = requireString(op['sheet'], 'op.sheet');
      state.workbook = moveSheet(state.workbook, sheet, requireInteger(op['to_index'], 'op.to_index'));
      return { op: name, sheet, to_index: op['to_index'] };
    }
    case 'hide_sheet': {
      const sheet = requireString(op['sheet'], 'op.sheet');
      state.workbook = setSheetHidden(state.workbook, sheet, op['hidden'] !== false);
      return { op: name, sheet, hidden: op['hidden'] !== false };
    }
    default:
      throw new StructureRejection('invalid_op', `不认识的结构操作 ${JSON.stringify(name)}`);
  }
}

// ---------------------------------------------------------------------------
// 几何序列化：把行高 / 列宽 / 隐藏行列注入工作表部件（产品层补齐，见文件头）
// ---------------------------------------------------------------------------

function hasGeometry(layout: SheetLayoutState): boolean {
  return (
    layout.row_heights.size > 0 ||
    layout.column_widths.size > 0 ||
    layout.hidden_rows.length > 0 ||
    layout.hidden_columns.length > 0
  );
}

function toParsed(element: XmlElement): ParsedXmlElement {
  // 复用写侧原语 `ooxml/xml.ts` 的 `serializeXmlNode` 得到字符串，再由读侧 `parseXml` 解析回元素树
  // —— 与 `print-layout.ts` 的 `toParsedElement` 同一手法，本文件不手拼 XML 字符串。
  return parseXml(serializeXmlNode(element));
}

function buildColsElement(layout: SheetLayoutState): ParsedXmlElement | null {
  const indexes = new Set<number>([...layout.column_widths.keys(), ...layout.hidden_columns]);
  if (indexes.size === 0) return null;
  const sorted = [...indexes].sort((a, b) => a - b);
  const cols = sorted.map((column) => {
    const attributes = [attr('min', String(column)), attr('max', String(column))];
    const width = layout.column_widths.get(column);
    if (width !== undefined) {
      attributes.push(attr('width', String(width)), attr('customWidth', '1'));
    }
    if (layout.hidden_columns.includes(column)) {
      attributes.push(attr('hidden', '1'));
    }
    return el('col', attributes);
  });
  return toParsed(el('cols', [], cols));
}

function withRowFormatting(row: ParsedXmlElement, height: number | null, hidden: boolean): ParsedXmlElement {
  const kept = row.attributes.filter(
    (attribute) => attribute.name !== 'ht' && attribute.name !== 'customHeight' && attribute.name !== 'hidden',
  );
  const additions: ParsedXmlAttribute[] = [];
  if (height !== null) {
    additions.push({ name: 'ht', value: String(height) }, { name: 'customHeight', value: '1' });
  }
  if (hidden) {
    additions.push({ name: 'hidden', value: '1' });
  }
  return Object.freeze({ ...row, attributes: Object.freeze([...kept, ...additions]) });
}

function patchSheetData(sheetData: ParsedXmlElement, layout: SheetLayoutState): ParsedXmlElement {
  if (layout.row_heights.size === 0 && layout.hidden_rows.length === 0) {
    return sheetData; // 没有行级几何 ⇒ 一个字节都不动
  }
  const byNumber = new Map<number, ParsedXmlElement>();
  for (const row of childElements(sheetData)) {
    if (row.localName !== 'row') continue;
    const ref = attributeValue(row, '', 'r');
    if (ref !== null) byNumber.set(Number.parseInt(ref, 10), row);
  }
  const targets = new Set<number>([...byNumber.keys(), ...layout.row_heights.keys(), ...layout.hidden_rows]);
  const rows = [...targets]
    .sort((a, b) => a - b)
    .map((rowNumber) => {
      const existing = byNumber.get(rowNumber) ?? toParsed(el('row', [attr('r', String(rowNumber))]));
      return withRowFormatting(existing, layout.row_heights.get(rowNumber) ?? null, layout.hidden_rows.includes(rowNumber));
    });
  return Object.freeze({ ...sheetData, children: Object.freeze(rows) });
}

function insertBefore(children: readonly ParsedXmlNode[], element: ParsedXmlElement, localName: string): ParsedXmlNode[] {
  const out = [...children];
  const index = out.findIndex((child) => child.kind === 'element' && child.localName === localName);
  if (index < 0) {
    out.push(element);
    return out;
  }
  out.splice(index, 0, element);
  return out;
}

/** 把一表几何注入工作表 XML（幂等：同名元素先移除再按序插入）。 */
export function injectGeometryXml(worksheetXml: string, layout: SheetLayoutState): string {
  const root = parseXml(worksheetXml);
  let children: ParsedXmlNode[] = [...root.children].filter(
    (child) => !(child.kind === 'element' && child.localName === 'cols'),
  );
  const cols = buildColsElement(layout);
  if (cols !== null) {
    children = insertBefore(children, cols, 'sheetData');
  }
  children = children.map((child) =>
    child.kind === 'element' && child.localName === 'sheetData' ? patchSheetData(child, layout) : child,
  );
  return `${XML_DECLARATION}\n${serializeParsedXmlNode(Object.freeze({ ...root, children: Object.freeze(children) }))}`;
}

/** 导出结果。 */
export interface XlsStructureExport {
  readonly bytes: Buffer;
  readonly entry_count: number;
  readonly content_digest: string;
  readonly rewritten_parts: readonly string[];
  readonly sheets_with_geometry: readonly string[];
}

/**
 * 写工作簿为**带几何**的真实 .xlsx。
 *
 * 步骤：① `writeWorkbookXlsx`（含 `<pane>`/`<mergeCells>`/整表 `hidden`）；
 * ② 对**有几何**的表，把 `<cols>` 与行级 `ht`/`hidden` 注入工作表部件；
 * ③ `writeZip` 重新打包（只有被注入的部件文本变了，其余条目**原样按序带回**）。
 *
 * 空白几何 / 无几何的表 ⇒ ② 恒等 ⇒ 字节与 `writeWorkbookXlsx` **逐字节相同**（反向对照建立在此）。
 */
export function writeWorkbookXlsxWithStructure(
  workbook: WorkbookState,
  layouts: ReadonlyMap<string, SheetLayoutState>,
): XlsStructureExport {
  const written = writeWorkbookXlsx(workbook);
  const archive = readZip(written.bytes);
  const replacements = new Map<string, Uint8Array>();
  const rewritten: string[] = [];
  const sheetsWithGeometry: string[] = [];

  workbook.sheets.forEach((sheet, index) => {
    const layout = layouts.get(sheet.name);
    if (layout === undefined || !hasGeometry(layout)) return;
    const partPath = worksheetPartPath(index);
    const part = archive.by_path.get(partPath);
    if (part === undefined) {
      throw new StructureRejection('invalid_workbook', `写出的包缺少工作表部件 ${partPath}：容器不完整，拒绝继续注入`);
    }
    const source = Buffer.from(part.data).toString('utf8');
    const injected = injectGeometryXml(source, layout);
    if (injected !== source) {
      replacements.set(partPath, utf8Bytes(injected));
      rewritten.push(partPath);
    }
    sheetsWithGeometry.push(sheet.name);
  });

  const entries = archive.entries.map((entry) => ({
    path: entry.path,
    data: replacements.get(entry.path) ?? entry.data,
  }));
  const bytes = writeZip(entries);
  return Object.freeze({
    bytes,
    entry_count: entries.length,
    content_digest: xlsxContentDigest(bytes),
    rewritten_parts: Object.freeze(rewritten),
    sheets_with_geometry: Object.freeze(sheetsWithGeometry),
  });
}

// ---------------------------------------------------------------------------
// 读回扫描：字节里到底有没有这些元素（"写了"是可核对的，不是自称的）
// ---------------------------------------------------------------------------

export interface StructurePaneScan {
  readonly xSplit: number | null;
  readonly ySplit: number | null;
  readonly state: string | null;
  readonly topLeftCell: string | null;
}

export interface StructureColScan {
  readonly min: number | null;
  readonly max: number | null;
  readonly width: number | null;
  readonly hidden: boolean;
  readonly customWidth: boolean;
}

export interface StructureRowScan {
  readonly r: number;
  readonly ht: number | null;
  readonly customHeight: boolean;
  readonly hidden: boolean;
}

export interface SheetStructureScan {
  readonly part: string;
  readonly pane: StructurePaneScan | null;
  readonly merge_cells: readonly string[];
  readonly cols: readonly StructureColScan[];
  readonly formatted_rows: readonly StructureRowScan[];
}

export interface XlsxStructureByteScan {
  /** 工作簿里 `state="hidden"` 的工作表名。 */
  readonly hidden_sheets: readonly string[];
  readonly sheets: readonly SheetStructureScan[];
}

function numberOf(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function scanWorksheetPart(part: string, xml: string): SheetStructureScan {
  const root = parseXml(xml);
  // `<pane>` 不是工作表根的直接子元素：它嵌在 `sheetViews > sheetView` 里（CT_SheetView）。
  const sheetView = findChild(findChild(root, SPREADSHEETML_NAMESPACE, 'sheetViews'), SPREADSHEETML_NAMESPACE, 'sheetView');
  const paneElement = findChild(sheetView, SPREADSHEETML_NAMESPACE, 'pane');
  const pane: StructurePaneScan | null =
    paneElement === null
      ? null
      : Object.freeze({
          xSplit: numberOf(attributeValue(paneElement, '', 'xSplit')),
          ySplit: numberOf(attributeValue(paneElement, '', 'ySplit')),
          state: attributeValue(paneElement, '', 'state'),
          topLeftCell: attributeValue(paneElement, '', 'topLeftCell'),
        });

  const mergeBlock = findChild(root, SPREADSHEETML_NAMESPACE, 'mergeCells');
  const mergeCells = mergeBlock === null
    ? []
    : childElements(mergeBlock)
        .map((element) => attributeValue(element, '', 'ref'))
        .filter((ref): ref is string => ref !== null);

  const colsBlock = findChild(root, SPREADSHEETML_NAMESPACE, 'cols');
  const cols: StructureColScan[] = colsBlock === null
    ? []
    : childElements(colsBlock).map((element) =>
        Object.freeze({
          min: numberOf(attributeValue(element, '', 'min')),
          max: numberOf(attributeValue(element, '', 'max')),
          width: numberOf(attributeValue(element, '', 'width')),
          hidden: attributeValue(element, '', 'hidden') === '1',
          customWidth: attributeValue(element, '', 'customWidth') === '1',
        }),
      );

  const sheetData = findChild(root, SPREADSHEETML_NAMESPACE, 'sheetData');
  const formattedRows: StructureRowScan[] = sheetData === null
    ? []
    : childElements(sheetData)
        .filter((element) => element.localName === 'row')
        .filter(
          (element) =>
            attributeValue(element, '', 'ht') !== null || attributeValue(element, '', 'hidden') !== null,
        )
        .map((element) =>
          Object.freeze({
            r: numberOf(attributeValue(element, '', 'r')) ?? 0,
            ht: numberOf(attributeValue(element, '', 'ht')),
            customHeight: attributeValue(element, '', 'customHeight') === '1',
            hidden: attributeValue(element, '', 'hidden') === '1',
          }),
        );

  return Object.freeze({
    part,
    pane,
    merge_cells: Object.freeze(mergeCells),
    cols: Object.freeze(cols),
    formatted_rows: Object.freeze(formattedRows),
  });
}

/**
 * 解开一份 .xlsx 字节，读回其中的结构事实（**本套件自带的 ZIP 解析器** `readZip`）。
 *
 * @throws {ZipReadError} 不是合法 ZIP
 * @throws {XmlParseError} 部件不是合法 XML
 */
export function scanWorkbookStructureBytes(bytes: Uint8Array): XlsxStructureByteScan {
  const archive = readZip(bytes);
  const sheets: SheetStructureScan[] = [];
  for (const entry of archive.entries) {
    if (!WORKSHEET_PART.test(entry.path)) continue;
    sheets.push(scanWorksheetPart(entry.path, Buffer.from(entry.data).toString('utf8')));
  }
  const hiddenSheets: string[] = [];
  const workbookPart = archive.by_path.get(XLSX_WORKBOOK_PART_PATH);
  if (workbookPart !== undefined) {
    const root = parseXml(Buffer.from(workbookPart.data).toString('utf8'));
    const sheetsBlock = findChild(root, SPREADSHEETML_NAMESPACE, 'sheets');
    if (sheetsBlock !== null) {
      for (const element of childElements(sheetsBlock)) {
        if (element.localName !== 'sheet') continue;
        if (attributeValue(element, '', 'state') !== 'hidden') continue;
        const name = attributeValue(element, '', 'name');
        if (name !== null) hiddenSheets.push(name);
      }
    }
  }
  return Object.freeze({ hidden_sheets: Object.freeze(hiddenSheets), sheets: Object.freeze(sheets) });
}

// ---------------------------------------------------------------------------
// 构建：请求体 → 真实字节 + 读回
// ---------------------------------------------------------------------------

interface SheetGeometryView {
  readonly sheet: string;
  readonly row_heights: readonly { readonly row: number; readonly height: number }[];
  readonly column_widths: readonly { readonly column: number; readonly width: number }[];
  readonly hidden_rows: readonly number[];
  readonly hidden_columns: readonly number[];
}

export interface StructureBuild {
  readonly applied: readonly Record<string, unknown>[];
  readonly sheets: readonly Record<string, unknown>[];
  readonly geometry: readonly SheetGeometryView[];
  readonly export: XlsStructureExport;
  readonly readBack: XlsxStructureByteScan;
}

function geometryView(layout: SheetLayoutState | undefined, sheetName: string): SheetGeometryView {
  const rowHeights = layout === undefined ? [] : [...layout.row_heights.entries()];
  const columnWidths = layout === undefined ? [] : [...layout.column_widths.entries()];
  return Object.freeze({
    sheet: sheetName,
    row_heights: Object.freeze(
      rowHeights.sort((a, b) => a[0] - b[0]).map(([row, height]) => Object.freeze({ row, height })),
    ),
    column_widths: Object.freeze(
      columnWidths.sort((a, b) => a[0] - b[0]).map(([column, width]) => Object.freeze({ column, width })),
    ),
    hidden_rows: Object.freeze([...(layout?.hidden_rows ?? [])]),
    hidden_columns: Object.freeze([...(layout?.hidden_columns ?? [])]),
  });
}

/**
 * 执行一次结构构建：读源（`workbook` 规格或 `fileBase64`）→ 顺序应用 `ops`
 * （每个 op 委托内核、失败即**整请求具名拒绝且不产出字节**）→ 导出真实字节 → 读回扫描。
 *
 * @throws {StructureRejection} 具名拒绝（合并越界/重叠、删唯一表、非法宽高等）
 * @throws {ValidationError} 内核拒绝（如删除行列与合并区部分重叠）
 */
export function buildStructure(body: Record<string, unknown>): StructureBuild {
  const fileBase64 = body['fileBase64'];
  let workbook: WorkbookState;
  if (typeof fileBase64 === 'string') {
    const bytes = decodeBase64Strict(fileBase64);
    if (bytes === null) throw new StructureRejection('invalid_format', 'fileBase64 不是合法 base64');
    try {
      workbook = readWorkbookXlsx(bytes).workbook;
    } catch (error) {
      throw new StructureRejection('invalid_format', `导入既有 .xlsx 失败：${describe(error)}`);
    }
  } else {
    workbook = readWorkbookSpec(body['workbook']);
  }

  const state: StructureState = { workbook, layouts: new Map<string, SheetLayoutState>() };
  const ops = body['ops'];
  const applied: Record<string, unknown>[] = [];
  if (ops !== undefined) {
    if (!Array.isArray(ops)) throw new StructureRejection('invalid_op', 'ops 必须是数组');
    for (const raw of ops) {
      if (!isRecord(raw)) throw new StructureRejection('invalid_op', 'ops 的每一项必须是对象');
      applied.push(applyOp(state, raw));
    }
  }

  const exported = writeWorkbookXlsxWithStructure(state.workbook, state.layouts);
  let readBack: XlsxStructureByteScan;
  try {
    readBack = scanWorkbookStructureBytes(exported.bytes);
  } catch (error) {
    throw new StructureRejection('export_failed', `读回导出字节失败：${describe(error)}`);
  }

  const sheets = state.workbook.sheets.map((sheet) =>
    Object.freeze({
      name: sheet.name,
      hidden: sheet.hidden,
      row_count: sheet.row_count,
      column_count: sheet.column_count,
      frozen_rows: sheet.frozen_rows,
      frozen_columns: sheet.frozen_columns,
      merged: sheet.merged,
      migration_blocked: sheet.migration_blocked,
    }),
  );
  const geometry = state.workbook.sheets.map((sheet) => geometryView(state.layouts.get(sheet.name), sheet.name));

  return Object.freeze({
    applied: Object.freeze(applied),
    sheets: Object.freeze(sheets),
    geometry: Object.freeze(geometry),
    export: exported,
    readBack,
  });
}

// ---------------------------------------------------------------------------
// 纯路由（不碰 node:http；可单测）
// ---------------------------------------------------------------------------

export interface XlsStructureWireRequest {
  readonly method: string;
  readonly pathname: string;
  readonly body: unknown;
}

export interface XlsStructureWireResponse {
  readonly status: number;
  readonly body: unknown;
}

/** 本命名空间是否归本模块管（挂载点的可判前缀）。 */
export function isXlsStructurePath(pathname: string): boolean {
  return pathname === XLS_STRUCTURE_ROOT || pathname.startsWith(`${XLS_STRUCTURE_ROOT}/`);
}

function ok(body: unknown, status = 200): XlsStructureWireResponse {
  return Object.freeze({ status, body });
}

function fail(status: number, code: string, message: string): XlsStructureWireResponse {
  return Object.freeze({ status, body: Object.freeze({ code, message, retryable: false }) });
}

function segmentsOf(pathname: string): readonly string[] {
  const rest = pathname.slice(XLS_STRUCTURE_ROOT.length).replace(/^\/+/, '').replace(/\/+$/, '');
  return rest === '' ? [] : rest.split('/');
}

function statusView(): Record<string, unknown> {
  return Object.freeze({
    root: XLS_STRUCTURE_ROOT,
    ready: true,
    ops: XLS_STRUCTURE_OPS,
    modules_reachable: XLS_STRUCTURE_MODULES_REACHABLE_BY_ROUTE,
    not_wired: XLS_STRUCTURE_NOT_WIRED_BY_ROUTE,
    unverified: XLS_STRUCTURE_UNVERIFIED,
    note:
      '结构操作复用 src/spreadsheets/** 的迁移规则（本层不自造行号算术）；几何在导出字节上按 ' +
      'CT_Worksheet 序列注入并**读回核对**。拒绝一律发生在导出之前 ⇒ 拒绝响应无字节（源零改动）。',
  });
}

/**
 * 处理一条 `/api/xls-structure/**` 路由（**纯函数**：不碰 node:http）。
 *
 * @returns `null` = 不是本命名空间（调用方落到 404 / 其它路由）。
 */
export async function routeXlsStructureRequest(
  request: XlsStructureWireRequest,
): Promise<XlsStructureWireResponse | null> {
  const pathname = request.pathname;
  if (!isXlsStructurePath(pathname)) return null;
  const method = request.method.toUpperCase();
  const segments = segmentsOf(pathname);

  // -- GET /api/xls-structure[/status] -------------------------------------
  if (segments.length === 0 || (segments.length === 1 && segments[0] === 'status')) {
    if (method !== 'GET' && method !== 'HEAD') return fail(405, 'method_not_allowed', '只接受 GET');
    return ok(statusView());
  }

  // -- POST /api/xls-structure/apply ---------------------------------------
  if (segments.length === 1 && segments[0] === 'apply') {
    if (method !== 'POST') return fail(405, 'method_not_allowed', '只接受 POST');
    const body = isRecord(request.body) ? request.body : {};
    let built: StructureBuild;
    try {
      built = buildStructure(body);
    } catch (error) {
      if (error instanceof StructureRejection) {
        return fail(statusOfRejection(error.code), error.code, error.message);
      }
      if (error instanceof ValidationError) {
        return fail(422, 'invalid_operation', error.message);
      }
      return fail(500, 'internal_error', `结构构建失败：${describe(error)}`);
    }
    return ok({
      applied: built.applied,
      sheets: built.sheets,
      geometry: built.geometry,
      unverified: XLS_STRUCTURE_UNVERIFIED,
      contentDigest: built.export.content_digest,
      byteLength: built.export.bytes.byteLength,
      entryCount: built.export.entry_count,
      sheetsWithGeometry: built.export.sheets_with_geometry,
      rewrittenParts: built.export.rewritten_parts,
      bytesBase64: Buffer.from(built.export.bytes).toString('base64'),
      readBack: built.readBack,
    });
  }

  return fail(404, 'not_found', `没有这个结构接口 ${method} ${pathname}`);
}

// ---------------------------------------------------------------------------
// node:http 适配器（挂载点）
// ---------------------------------------------------------------------------

export interface XlsStructureHttpInput {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  /** 省略时取 `req.method`。 */
  readonly method?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly tooLarge: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      // 排空剩余数据，避免 RST 让客户端看不到 413（与 http.ts 的同一纪律）。
      try {
        for await (const rest of req) void rest;
      } catch {
        // 对端提前关闭：不影响拒绝结果。
      }
      return { ok: false, tooLarge: true };
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return { ok: true, body: null };
  try {
    return { ok: true, body: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, tooLarge: false };
  }
}

/**
 * **挂载点**：处理一次 `/api/xls-structure/**` 请求（**纯函数路由**：零端口、零落盘、零网络）。
 *
 * @returns `true` = 已写过响应（调用方直接 `return`）；`false` = 不是本命名空间。
 *
 * 协调者在 `http.ts` 里加**两行**（放在 `/api/**` 兜底 404 之前）：
 *
 * ```ts
 * import { handleXlsStructureRequest } from './xls-structure-product.js';
 * ...
 * if (await handleXlsStructureRequest({ req, res, url, method })) return;
 * ```
 */
export async function handleXlsStructureRequest(input: XlsStructureHttpInput): Promise<boolean> {
  const pathname = input.url.pathname;
  if (!isXlsStructurePath(pathname)) return false;

  const method = (input.method ?? input.req.method ?? 'GET').toUpperCase();
  let body: unknown = null;
  if (method !== 'GET' && method !== 'HEAD') {
    const read = await readJsonBody(input.req);
    if (!read.ok) {
      if (read.tooLarge) {
        sendJson(input.res, 413, {
          code: 'body_too_large',
          message: `请求体超过 ${String(MAX_BODY_BYTES)} 字节上限`,
          retryable: false,
        });
      } else {
        sendJson(input.res, 400, { code: 'invalid_json', message: '请求体不是合法 JSON', retryable: false });
      }
      return true;
    }
    body = read.body;
  }

  const response = await routeXlsStructureRequest({ method, pathname, body });
  if (response === null) {
    sendJson(input.res, 404, { code: 'not_found', message: `没有这个结构接口 ${method} ${pathname}`, retryable: false });
    return true;
  }
  sendJson(input.res, response.status, response.body);
  return true;
}

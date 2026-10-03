/**
 * **表格（XLSX）交付适配器**（design-06 P8；合同 R232 / R247 / R248 / R249 / R250）。
 *
 * 把 `src/spreadsheets/**` 的能力接进通用交付会话：源 = 工作簿模型（+ 导入时保留的未知部件），
 * 导出 = `writeWorkbookXlsx`（**真实 .xlsx 容器字节**），导入 = `readWorkbookXlsx`。
 *
 * ## R250：不得只有一张固定分项表
 *
 * 本适配器的源是**任意工作簿**（多表、任意行列、任意取值），不是模板层那张固定的
 * 分项/合计表。`add_sheet` 是产品入口上的一等操作，因此"只能产出一张表"这件事
 * 在结构上不可能发生。
 *
 * ## R248：缺失不当零
 *
 * 编辑只接受**显式的取值形状**（`CellValue` 的七类判别联合），因此"这个格子是多少"
 * 永远有一个可判定的答案；适配器**不会**把"没设过"折成 0——没设过就是 `blank`。
 *
 * ## R249：既有文件的未知部件保留
 *
 * 导入带出 `XlsxResidual`（未建模部件与其关系），导出时原样带回。本适配器**不改**
 * `src/spreadsheets/**`，只是把它已有的保留通道接上。
 *
 * 本适配器是**纯的**：零 IO、零墙钟、零随机数（`src/**` 的机器化断言）。
 */

import type { TemplateKind } from '../../protocol/index.js';
import {
  type CellValue,
  type PrintLayout,
  type WorkbookState,
  type XlsxResidual,
  EMPTY_RESIDUAL,
  addSheet,
  createPrintLayout,
  createSheet,
  createWorkbook,
  getSheet,
  removeSheet,
  renameSheet,
  readWorkbookXlsx,
  setActiveSheet,
  setCellValue,
  clearCell,
  sheetNames,
  writeWorkbookXlsx,
} from '../../spreadsheets/index.js';
import { parseCellReference } from '../../spreadsheets/reference.js';
import { sheetEntries, type SheetState } from '../../spreadsheets/sheet.js';
import {
  DATA_OPERATION_KINDS,
  applyDataOperation,
  describeDataOperation,
  parseCellValue,
  parseDataOperation,
  parseSortKeys,
} from '../../spreadsheets/data-ops/operations.js';
import { appendTableRow, sortTable } from '../../spreadsheets/data-ops/table-compose.js';
import { createStructuredTable, type StructuredTableSpec } from '../../spreadsheets/structured-table.js';
import {
  assertRelationshipsClean,
  type RelationshipsCleanReceipt,
} from '../../spreadsheets/object-parts/relationships.js';
import {
  buildPrintPreview,
  excelColumnWidthToTwips,
  excelRowHeightToTwips,
  resolvePrintSettings,
  type PrintPreview,
  type SheetGridGeometry,
} from '../../mobile-plugins/spreadsheets/rendering/index.js';
import type {
  AdapterEditResult,
  AdapterExportResult,
  AdapterImportResult,
  DeliverableAdapter,
} from '../adapter.js';
import type { FileFormat } from '../formats.js';
import {
  ADAPTER_OPERATION_NAMES,
  applySpreadsheetOperation,
  workbooksEquivalent,
} from '../../mobile-plugins/spreadsheets/session/operations.js';

/**
 * X10 新增的 op（转调 `src/mobile-plugins/spreadsheets/session/operations.ts`）。
 *
 * 原有 6 个 op 的代码路径**原样保留**（含各自的 `changed` 口径）以不改变既有产品行为；
 * 这里把枚举**加宽**到区域读写 / 行列增删 / 排序去重替换。枚举里**刻意仍不含**
 * `merge_cells` / `unmerge_cells` / `move_sheet` / `set_frozen_panes` / `set_column_width` /
 * `set_row_height` / `duplicate_sheet` / `hide_sheet`：`apps/demo/server/format-structure-e2e.test.ts`
 * 断言这些 op 在 `/api/deliverables/**` 未接线——手机会话（`SpreadsheetSession`）走全集，
 * 不受此限。详见 `operations.ts` 头部边界说明。
 */
const REGISTRY_OPERATIONS: ReadonlySet<string> = new Set([
  'set_range',
  'clear_range',
  'insert_rows',
  'delete_rows',
  'insert_columns',
  'delete_columns',
  'sort_range',
  'dedupe_rows',
  'replace_in_range',
]);

/**
 * X05 数据操作（`src/spreadsheets/data-ops/operations.ts` 的封闭 `kind`）：
 * `sort` / `filter` / `dedupe` / `dropBlankRows` / `findReplace`。
 *
 * 转调 `applyDataOperation(sheet, operation)`：它比 X10 注册表的 `sort_range` / `dedupe_rows`
 * 多出 `filter`（不命中整行删除）与 `dropBlankRows`；命名沿用数据操作模块自己的 `kind`，
 * 不与注册表的 `*_rows` 词汇互相冒充。
 */
const DATA_OPERATION_OPS: ReadonlySet<string> = new Set(DATA_OPERATION_KINDS);

/**
 * X05 结构化表格操作（`src/spreadsheets/data-ops/table-compose.ts`）：
 * `sortTable`（只排数据体，标题行 / 汇总行钉住）与 `appendTableRow`（扩表 + 引用迁移）。
 */
const TABLE_OPERATION_OPS: ReadonlySet<string> = new Set(['sortTable', 'appendTableRow']);

/**
 * **本适配器委派出去的 op 全集** = X10 注册表子集 ∪ X05 数据操作 ∪ X05 表操作。
 *
 * "委派"不等于无条件放行：上列三个集合之外的 op（含合并 / 移动 / 冻结 / 列宽行高 / 复制 /
 * 隐藏）仍走 `default` 分支，返回既有具名 `unsupported_op`（文案含「不支持的表格操作」）。
 * X-I19 只做**加宽**，不改这批失败文案，也不改 6 个 legacy op 的代码路径。
 */
const DELEGATED_OPERATIONS: ReadonlySet<string> = new Set<string>([
  ...REGISTRY_OPERATIONS,
  ...DATA_OPERATION_OPS,
  ...TABLE_OPERATION_OPS,
]);

/** 表格交付的源：工作簿 + 导入时保留的未知部件（从零新建时为空残留）。 */
export interface XlsxDeliverableSource {
  readonly workbook: WorkbookState;
  readonly residual: XlsxResidual;
}

/**
 * **产品入口上的表格编辑**（封闭枚举）。
 *
 * 刻意**不做**"自然语言 → 表格操作"：本文件只定义**受约束的结构化意图**，
 * 自然语言到它的翻译是模型层的事（R134）。每个操作都只改一处、且不可变。
 */
export type XlsxEdit =
  | {
      readonly op: 'set_cell';
      readonly sheet: string;
      readonly address: string;
      /** 取值形状与 `src/spreadsheets` 的 `CellValue` **同一套**（不另造第二套词汇）。 */
      readonly value: CellValue;
    }
  | { readonly op: 'clear_cell'; readonly sheet: string; readonly address: string }
  | { readonly op: 'add_sheet'; readonly name: string }
  | { readonly op: 'remove_sheet'; readonly name: string }
  | { readonly op: 'rename_sheet'; readonly from: string; readonly to: string }
  | { readonly op: 'set_active_sheet'; readonly name: string };

/**
 * 从零建一份工作簿（R250：**表数由调用方决定**，不固定成一张分项表）。
 *
 * @throws {ValidationError} 表名非法（交给调用方决定怎么报，本函数不吞错）。
 */
export function emptyWorkbook(...sheetNames: readonly string[]): XlsxDeliverableSource {
  const names = sheetNames.length === 0 ? ['Sheet1'] : [...sheetNames];
  return Object.freeze({
    workbook: createWorkbook(names.map((name) => createSheet(name))),
    residual: EMPTY_RESIDUAL,
  });
}

// ---------------------------------------------------------------------------
// 取值形状校验（R248：不猜、不折算）
// ---------------------------------------------------------------------------

function readCellValue(raw: unknown): CellValue | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  switch (record['kind']) {
    case 'blank':
      return Object.freeze({ kind: 'blank' as const });
    case 'number': {
      const value = record['value'];
      return typeof value === 'number' && Number.isFinite(value)
        ? Object.freeze({ kind: 'number' as const, value })
        : null;
    }
    case 'text': {
      const value = record['value'];
      return typeof value === 'string' ? Object.freeze({ kind: 'text' as const, value }) : null;
    }
    case 'boolean': {
      const value = record['value'];
      return typeof value === 'boolean' ? Object.freeze({ kind: 'boolean' as const, value }) : null;
    }
    case 'date': {
      const epoch = record['epoch_ms'];
      return typeof epoch === 'number' && Number.isFinite(epoch)
        ? Object.freeze({ kind: 'date' as const, epoch_ms: epoch })
        : null;
    }
    case 'error': {
      const code = record['code'];
      return typeof code === 'string' ? Object.freeze({ kind: 'error' as const, code: code as never }) : null;
    }
    case 'formula': {
      const text = record['text'];
      return typeof text === 'string' && text.length > 0
        ? Object.freeze({ kind: 'formula' as const, text })
        : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

const FORMAT: FileFormat = 'xlsx';
const TEMPLATE_KIND: TemplateKind = 'spreadsheet';

function applyXlsxEdit(
  source: XlsxDeliverableSource,
  edit: unknown,
): AdapterEditResult<XlsxDeliverableSource> {
  if (typeof edit !== 'object' || edit === null) {
    return { ok: false, kind: 'invalid_edit', detail: '编辑必须是一个对象' };
  }
  const record = edit as Record<string, unknown>;
  const op = record['op'];
  const workbook = source.workbook;
  // X-I19：把加宽的 op 按来源分派——X10 注册表 / X05 数据操作 / X05 表操作。
  if (typeof op === 'string' && DELEGATED_OPERATIONS.has(op)) {
    if (DATA_OPERATION_OPS.has(op)) return applyDataOperationEdit(source, record);
    if (TABLE_OPERATION_OPS.has(op)) return applyTableOperationEdit(source, record);
    return applySpreadsheetOperation(source, edit);
  }
  try {
    switch (op) {
      case 'set_cell': {
        const sheetName = requireString(record['sheet'], 'sheet');
        const address = requireString(record['address'], 'address');
        const value = readCellValue(record['value']);
        if (value === null) {
          return {
            ok: false,
            kind: 'invalid_value',
            detail: 'value 不是合法的单元格取值（只能是 blank / number / text / boolean / date / error / formula）',
          };
        }
        const sheet = getSheet(workbook, sheetName);
        if (sheet === undefined) {
          return { ok: false, kind: 'unknown_sheet', detail: `没有工作表 ${JSON.stringify(sheetName)}` };
        }
        const next = setCellValue(sheet, address, value);
        return {
          ok: true,
          source: { ...source, workbook: replaceSheet(workbook, sheetName, next) },
          changed: true,
          notes: Object.freeze([`${sheetName}!${address} 设为 ${value.kind}`]),
        };
      }
      case 'clear_cell': {
        const sheetName = requireString(record['sheet'], 'sheet');
        const address = requireString(record['address'], 'address');
        const sheet = getSheet(workbook, sheetName);
        if (sheet === undefined) {
          return { ok: false, kind: 'unknown_sheet', detail: `没有工作表 ${JSON.stringify(sheetName)}` };
        }
        const next = clearCell(sheet, address);
        return {
          ok: true,
          source: { ...source, workbook: replaceSheet(workbook, sheetName, next) },
          changed: true,
          notes: Object.freeze([`${sheetName}!${address} 清空`]),
        };
      }
      case 'add_sheet': {
        const name = requireString(record['name'], 'name');
        if (getSheet(workbook, name) !== undefined) {
          return { ok: false, kind: 'duplicate_sheet', detail: `工作表 ${JSON.stringify(name)} 已存在` };
        }
        return {
          ok: true,
          source: { ...source, workbook: addSheet(workbook, name) },
          changed: true,
          notes: Object.freeze([`新增工作表 ${name}`]),
        };
      }
      case 'remove_sheet': {
        const name = requireString(record['name'], 'name');
        if (getSheet(workbook, name) === undefined) {
          return { ok: false, kind: 'unknown_sheet', detail: `没有工作表 ${JSON.stringify(name)}` };
        }
        if (workbook.sheets.length <= 1) {
          return {
            ok: false,
            kind: 'last_sheet',
            detail: '这是最后一张工作表：删除会让工作簿不合法（R250 要求至少一张真实表）',
          };
        }
        return {
          ok: true,
          source: { ...source, workbook: removeSheet(workbook, name) },
          changed: true,
          notes: Object.freeze([`删除工作表 ${name}`]),
        };
      }
      case 'rename_sheet': {
        const from = requireString(record['from'], 'from');
        const to = requireString(record['to'], 'to');
        if (getSheet(workbook, from) === undefined) {
          return { ok: false, kind: 'unknown_sheet', detail: `没有工作表 ${JSON.stringify(from)}` };
        }
        return {
          ok: true,
          source: { ...source, workbook: renameSheet(workbook, from, to) },
          changed: true,
          notes: Object.freeze([`工作表 ${from} 改名为 ${to}`]),
        };
      }
      case 'set_active_sheet': {
        const name = requireString(record['name'], 'name');
        if (getSheet(workbook, name) === undefined) {
          return { ok: false, kind: 'unknown_sheet', detail: `没有工作表 ${JSON.stringify(name)}` };
        }
        return {
          ok: true,
          source: { ...source, workbook: setActiveSheet(workbook, name) },
          changed: true,
          notes: Object.freeze([`活跃表切到 ${name}`]),
        };
      }
      default:
        return {
          ok: false,
          kind: 'unsupported_op',
          detail: `不支持的表格操作 ${JSON.stringify(String(op))}（封闭枚举：${ADAPTER_OPERATION_NAMES.join(' / ')}）`,
        };
    }
  } catch (error) {
    // 底层纯函数以抛错表达形状问题（非法地址 / 非法表名）：**结构化成编辑失败**，
    // 而不是让异常穿出会话层（那会绕过"源零改动"的承诺）。
    return { ok: false, kind: 'invalid_edit', detail: describe(error) };
  }
}

// ---------------------------------------------------------------------------
// X05 委派：数据操作（sort / filter / dedupe / dropBlankRows / findReplace）
// ---------------------------------------------------------------------------

/**
 * 把 X05 数据操作作用到 `sheet` 上（转调 `applyDataOperation`）。
 *
 * 编辑形状 = `{ op: <kind>, sheet, ...该 kind 的其余字段 }`：本函数只把 `sheet` 剥离、
 * 把 `op` 改名为 `kind` 后交给 `parseDataOperation` 做**严格**反序列化（未知 kind / 缺字段
 * 一律显式失败），再交给 `applyDataOperation` 执行。**不重写**任何运算口径。
 *
 * `changed` 与注册表同口径（按最终工作簿取值比对）：`dedupe` / `dropBlankRows` 这类
 * "回执里有 changedObjects 但取值没变"的操作，`changed` 如实为 `false`，不产生新版本。
 */
function applyDataOperationEdit(
  source: XlsxDeliverableSource,
  record: Record<string, unknown>,
): AdapterEditResult<XlsxDeliverableSource> {
  try {
    const sheetName = requireString(record['sheet'], 'sheet');
    const sheet = getSheet(source.workbook, sheetName);
    if (sheet === undefined) {
      return { ok: false, kind: 'unknown_sheet', detail: `没有工作表 ${JSON.stringify(sheetName)}` };
    }
    const payload: Record<string, unknown> = { ...record };
    delete payload['op'];
    delete payload['sheet'];
    const operation = parseDataOperation({ ...payload, kind: record['op'] });
    const result = applyDataOperation(sheet, operation);
    const workbook = replaceSheet(source.workbook, sheetName, result.sheet);
    return {
      ok: true,
      source: { ...source, workbook },
      changed: !workbooksEquivalent(source.workbook, workbook),
      notes: Object.freeze([`${sheetName}：${describeDataOperation(operation)}`, ...result.warnings]),
    };
  } catch (error) {
    // 底层以抛错表达形状问题（未知 kind / 缺字段 / 越界 / 非法筛选算子）：结构化成编辑失败，
    // 不让异常穿出会话层（那会绕过"源零改动"的承诺）。
    return { ok: false, kind: 'invalid_edit', detail: describe(error) };
  }
}

// ---------------------------------------------------------------------------
// X05 委派：结构化表格（sortTable / appendTableRow）
// ---------------------------------------------------------------------------

/**
 * 把 X05 结构化表格操作作用到 `sheet` 上（转调 `sortTable` / `appendTableRow`）。
 *
 * **为什么要带上 `table` 定义**：本适配器的源只有 `{ workbook, residual }`，**没有**工作簿级的
 * 结构化表格注册表（那是别的包的范围）。因此表操作由命令自己给出表定义（`table` = 与
 * `createStructuredTable` 同一套 `StructuredTableSpec`），本层只把它建成 `StructuredTable`
 * 后转调，不猜、不按坐标临时编一个表。
 *
 * 编辑形状：
 * - `sortTable`：`{ op:'sortTable', sheet, table, keys, blanks? }`；
 * - `appendTableRow`：`{ op:'appendTableRow', sheet, table, values }`（`values` 按表列顺序）。
 */
function applyTableOperationEdit(
  source: XlsxDeliverableSource,
  record: Record<string, unknown>,
): AdapterEditResult<XlsxDeliverableSource> {
  try {
    const sheetName = requireString(record['sheet'], 'sheet');
    const sheet = getSheet(source.workbook, sheetName);
    if (sheet === undefined) {
      return { ok: false, kind: 'unknown_sheet', detail: `没有工作表 ${JSON.stringify(sheetName)}` };
    }
    const table = createStructuredTable(record['table'] as StructuredTableSpec);
    let nextSheet: SheetState;
    let notes: readonly string[];
    if (record['op'] === 'sortTable') {
      const keys = parseSortKeys(record['keys'], 'sortTable');
      const blanks = record['blanks'];
      if (blanks !== undefined && blanks !== 'first' && blanks !== 'last') {
        return { ok: false, kind: 'invalid_edit', detail: "sortTable 的 blanks 只能是 'first' / 'last'" };
      }
      const result = sortTable(sheet, table, keys, blanks === undefined ? {} : { blanks });
      nextSheet = result.sheet;
      notes = Object.freeze([`表 ${table.name} 数据体排序（${String(keys.length)} 键）`, ...result.warnings]);
    } else {
      const rawValues = record['values'];
      if (!Array.isArray(rawValues) || rawValues.length === 0) {
        return { ok: false, kind: 'invalid_edit', detail: 'appendTableRow 的 values 必须是非空数组' };
      }
      const values = rawValues.map((item) => parseCellValue(item));
      const result = appendTableRow(sheet, table, values);
      nextSheet = result.sheet;
      notes = Object.freeze([`表 ${table.name} 追加数据行（第 ${String(result.row)} 行）`]);
    }
    const workbook = replaceSheet(source.workbook, sheetName, nextSheet);
    return {
      ok: true,
      source: { ...source, workbook },
      changed: !workbooksEquivalent(source.workbook, workbook),
      notes,
    };
  } catch (error) {
    return { ok: false, kind: 'invalid_edit', detail: describe(error) };
  }
}

/** 按表名换掉一张工作表（保持其余表与顺序不变；活跃表下标无需动）。 */
function replaceSheet(workbook: WorkbookState, name: string, next: WorkbookState['sheets'][number]): WorkbookState {
  return {
    sheets: workbook.sheets.map((sheet) => (sheet.name === name ? next : sheet)),
    active_sheet: workbook.active_sheet,
  };
}

function requireString(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`${field} 必须是非空字符串`);
  }
  return raw;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// ---------------------------------------------------------------------------
// X-I19 巡检面：关系审计门禁 + 真实分页计划（无独立契约改动，导出独立函数）
// ---------------------------------------------------------------------------

/** Excel 默认列宽（字符宽度单位，与 OOXML `<col width>` 同口径）。 */
const DEFAULT_COLUMN_WIDTH_CHARS = 8.43;
/** Excel 默认行高（点）。 */
const DEFAULT_ROW_HEIGHT_POINTS = 15;

/**
 * 由工作表**已用区域**（有取值的单元格包围盒）算出分页几何。
 *
 * **边界如实登记**：本函数只认"有哪些格子被设过"；自定义列宽 / 行高、隐藏行列**不建模**，
 * 一律按 Excel 默认列宽 8.43 字符 / 行高 15 点换算。要按真实列宽分行，调用方应显式传
 * {@link XlsxInspectOptions.grid}。
 */
function gridOfSheet(sheet: SheetState): SheetGridGeometry {
  let firstRow = Number.POSITIVE_INFINITY;
  let firstColumn = Number.POSITIVE_INFINITY;
  let lastRow = 0;
  let lastColumn = 0;
  for (const entry of sheetEntries(sheet)) {
    const address = parseCellReference(entry.ref);
    if (address.row < firstRow) firstRow = address.row;
    if (address.column < firstColumn) firstColumn = address.column;
    if (address.row > lastRow) lastRow = address.row;
    if (address.column > lastColumn) lastColumn = address.column;
  }
  const empty = lastRow === 0;
  return {
    firstRow: empty ? 1 : firstRow,
    firstColumn: empty ? 1 : firstColumn,
    lastRow: empty ? 1 : lastRow,
    lastColumn: empty ? 1 : lastColumn,
    defaultColumnWidthTwips: excelColumnWidthToTwips(DEFAULT_COLUMN_WIDTH_CHARS),
    defaultRowHeightTwips: excelRowHeightToTwips(DEFAULT_ROW_HEIGHT_POINTS),
  };
}

/** {@link inspectXlsxDeliverable} 的可选项。 */
export interface XlsxInspectOptions {
  /** 要巡检的工作表名；缺省 = 工作簿的活跃表。 */
  readonly sheet?: string;
  /** 该表的打印设置（来自 `print-layout.ts`）；缺省 = 默认布局（A4 / 纵向 / 默认边距）。 */
  readonly layout?: PrintLayout;
  /** 分页几何覆盖；缺省 = 由工作表已用区域按 Excel 默认列宽 / 行高算出。 */
  readonly grid?: SheetGridGeometry;
  /** 页数硬上限（透传分页引擎，超出即截断并给诊断）。 */
  readonly maxPages?: number;
}

/**
 * 巡检结果：通过返回**关系审计回执 + 真实分页预览**；不通过结构化返回（不抛穿）。
 *
 * `preview.totalPages` 是**唯一**页码来源（`PrintPreview.totalPages === plan.totalPages`）；
 * 要写 `&P` / `&N` 的调用方必须取它，不得另算一处。
 */
export type XlsxInspectResult =
  | {
      readonly ok: true;
      /** 被巡检的工作表名。 */
      readonly sheet: string;
      /** 交付前关系门禁回执（`assertRelationshipsClean`）。 */
      readonly relationships: RelationshipsCleanReceipt;
      /** 由几何真实算出的打印预览（逐页行列 / 重复标题 / 页眉页脚）。 */
      readonly preview: PrintPreview;
      /** 总页数（= `preview.totalPages`，冗余给不想深取 `preview` 的调用方）。 */
      readonly total_pages: number;
    }
  | { readonly ok: false; readonly kind: string; readonly detail: string };

/**
 * **交付前巡检**（X-I19 接 X07 的关系门禁 + X09 的分页计划）。
 *
 * 步骤：
 * 1. `exportBytes`（其中已含关系门禁）产出真实 .xlsx 字节；
 * 2. 对同一字节再跑一次 `assertRelationshipsClean`，拿到**回执**（计数 + 生效的隐式类型清单）；
 * 3. 由 `sheet` 的已用区域 + `layout` 解析出的设置算出 `buildPrintPreview` 的分页计划。
 *
 * 任一步失败都**结构化返回** `{ ok:false }`（与适配器 exportBytes 同口径），不抛穿会话层。
 * 门禁不通过 ⇒ `kind === 'relationship_audit_failed'`，消息点名悬挂目标 / 未解析引用 / 孤儿关系。
 */
export function inspectXlsxDeliverable(
  source: XlsxDeliverableSource,
  options: XlsxInspectOptions = {},
): XlsxInspectResult {
  const exported = xlsxDeliverableAdapter.exportBytes(source);
  if (!exported.ok) {
    return { ok: false, kind: exported.kind, detail: exported.detail };
  }
  let relationships: RelationshipsCleanReceipt;
  try {
    relationships = assertRelationshipsClean(exported.bytes);
  } catch (error) {
    return { ok: false, kind: 'relationship_audit_failed', detail: describe(error) };
  }
  const names = sheetNames(source.workbook);
  const name = options.sheet ?? names[source.workbook.active_sheet] ?? names[0];
  if (name === undefined) {
    return { ok: false, kind: 'unknown_sheet', detail: '工作簿没有工作表' };
  }
  const sheet = getSheet(source.workbook, name);
  if (sheet === undefined) {
    return { ok: false, kind: 'unknown_sheet', detail: `没有工作表 ${JSON.stringify(name)}` };
  }
  let preview: PrintPreview;
  try {
    const settings = resolvePrintSettings(options.layout ?? createPrintLayout());
    const grid = options.grid ?? gridOfSheet(sheet);
    preview =
      options.maxPages === undefined
        ? buildPrintPreview({ grid, settings })
        : buildPrintPreview({ grid, settings, maxPages: options.maxPages });
  } catch (error) {
    return { ok: false, kind: 'preview_failed', detail: describe(error) };
  }
  return { ok: true, sheet: name, relationships, preview, total_pages: preview.totalPages };
}

/** 表格交付适配器（唯一实例，纯函数集合）。 */
export const xlsxDeliverableAdapter: DeliverableAdapter<XlsxDeliverableSource> = Object.freeze({
  format: FORMAT,
  template_kind: TEMPLATE_KIND,
  describe(source: XlsxDeliverableSource): string {
    const names = sheetNames(source.workbook);
    return `${String(names.length)} 张工作表（${names.join('、')}）`;
  },
  exportBytes(source: XlsxDeliverableSource): AdapterExportResult {
    let result: ReturnType<typeof writeWorkbookXlsx>;
    try {
      result = writeWorkbookXlsx(source.workbook, source.residual);
    } catch (error) {
      return { ok: false, kind: 'xlsx_write_failed', detail: describe(error) };
    }
    // X-I19：**交付前关系门禁**。写出的字节必须关系自洽（无悬挂目标 / 未解析引用 / 孤儿关系），
    // 否则拒绝交付并结构化说明——"写出来了"不等于"是可交付的文件"。
    try {
      assertRelationshipsClean(result.bytes);
    } catch (error) {
      return { ok: false, kind: 'relationship_audit_failed', detail: describe(error) };
    }
    return {
      ok: true,
      bytes: result.bytes,
      entry_count: result.entry_count,
      digest: result.content_digest,
    };
  },
  applyEdit: applyXlsxEdit,
  importBytes(bytes: Uint8Array): AdapterImportResult<XlsxDeliverableSource> {
    try {
      const read = readWorkbookXlsx(bytes);
      return { ok: true, source: Object.freeze({ workbook: read.workbook, residual: read.residual }) };
    } catch (error) {
      return { ok: false, kind: 'xlsx_read_failed', detail: describe(error) };
    }
  },
});

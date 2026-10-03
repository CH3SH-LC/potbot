/**
 * XLSX 模板构建器（design-02 P6「表格」/ P1 / P3；归属 W-D2）。
 *
 * **纯函数、零 IO**：输入是结构化事实快照 + 单位 + 计算口径，输出是**真实可编辑 .xlsx 的字节**。
 * 本文件不 import `node:fs`、不读时钟、不用 `Math.random` / `process.*`——同一输入必然同一字节。
 *
 * ## 任务书 §6「表格」一行的三条合同，逐条落到本文件的形状上
 *
 * | §6 合同 | 本文件的落实 |
 * |---|---|
 * | 最小输入 = 结构化数据、单位、计算口径 | `XlsxSheetSpec`：`lines`（分项 → 事实键）+ `unit`（单一单位）+ `scale`/`total_label`（计算口径）；**输入里没有任何"预先算好的合计"的位置** |
 * | 可编辑表格、需要的公式或计算结果 | `sheetData` 里写的是**结果值**（数值单元格），分项与合计都由构造期代码核算 |
 * | 缺失值不默认视为零 | 任一事实缺失 / `unknown` / `not_applicable` ⇒ 该单元格**留空**（`blank`），**绝不写 0**；合计同理 |
 * | 通过代码检查关键计算 | `computeLineTotal()` 由分项**在代码里求和**，写入值与它同源（见单测的独立复算） |
 *
 * ## 「缺失不当零」为什么要在**单元格层**再做一遍
 *
 * 端口合同（`src/artifacts/ports.ts` 的 `KnownFactSnapshotEntry`）已把 `unknown` 挡在物化之前，
 * 由调用方阻塞为 `missing_fact`。**但那道防线在构建器外部**——本模块的输入类型
 * `XlsxFactEntry` 因此**故意比端口快照宽**：它的 `value` 是 `KnownFactValue | UnavailableFactValue`，
 * 于是"事实是未知的"这件事**能进入构建器**，而构建器对它唯一合法的处置就是**留空**。
 * 这是 P3 判据（缺失不得写成 0）在**单元格级**的纵深防御：即使上游漏挡，表格也不会出现一个
 * 用 0 冒充缺失的数字。
 *
 * ## 最小部件集（与主协调者实测可打开的探针逐字一致）
 *
 * - `xl/workbook.xml`：`workbook`(xmlns / xmlns:r) → `sheets` → `sheet`(name / sheetId=1 / r:id=rId1)
 * - `xl/worksheets/sheet1.xml`：`worksheet` → `sheetData` → `row` → `c`
 * - 包级关系 → officeDocument → `xl/workbook.xml`；部件级关系 → worksheet → `worksheets/sheet1.xml`
 * - 单元格字符串一律用 **`inlineStr`**：不引入 `sharedStrings`，也就不存在"索引越界"这一类
 *   只在真实软件里才暴露的失败面（实测被 Excel 接受，见任务书探针）。
 *
 * **数值单元格不带 `t`**（`<v>` 直接是数字）；**文本单元格带 `t="inlineStr"`**。
 * 因此 `"120"` 这样的文本绝不会被 Excel 当数字，反之亦然。
 */

import { digestBytes } from '../digest.js';

import {
  ValidationError,
  type FactRef,
  type FactSource,
  type KnownFactValue,
} from '../../protocol/index.js';
import {
  RELATIONSHIPS_CONTENT_TYPE,
  assembleOpcPackage,
  attr,
  el,
  formatDecimal,
  serializeXmlDocument,
  writeZip,
  type OpcPart,
  type RelationshipGroup,
  type XmlElement,
} from '../ooxml/index.js';

// ---------------------------------------------------------------------------
// 固定字面量（内容类型 / 命名空间 / 关系类型 / 部件路径）
// ---------------------------------------------------------------------------

/** 工作簿主体部件的内容类型。 */
export const XLSX_MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';

/** 工作表部件的内容类型。 */
export const XLSX_WORKSHEET_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';

/** SpreadsheetML 主命名空间。 */
export const SPREADSHEETML_NAMESPACE =
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

/** 关系命名空间（`r:id` 用）。 */
export const OFFICE_RELATIONSHIPS_NAMESPACE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** 包级关系：officeDocument → 工作簿。 */
export const OFFICE_DOCUMENT_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

/** 部件级关系：workbook → worksheet。 */
export const WORKSHEET_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';

/** 工作簿部件路径。 */
export const XLSX_WORKBOOK_PART_PATH = 'xl/workbook.xml';

/** 工作表部件路径（唯一工作表；`rId1` 指向它）。 */
export const XLSX_WORKSHEET_PART_PATH = 'xl/worksheets/sheet1.xml';

/** 工作表在包内的相对目标（相对 `xl/`）。 */
const WORKSHEET_RELATIONSHIP_TARGET = 'worksheets/sheet1.xml';

/** Excel 工作表名长度上限。 */
export const XLSX_MAX_SHEET_NAME_LENGTH = 31;

// ---------------------------------------------------------------------------
// 输入形状
// ---------------------------------------------------------------------------

/**
 * 「不可用」的两种事实取值：**未知** 与 **不适用**。
 *
 * 与 `src/protocol/facts.ts` 的 `SharedFactValue` 的未知分支同形；**没有数值载荷字段**，
 * 因此"把缺失写成 0"在这里连表达都表达不出来。
 */
export type UnavailableFactValue =
  | { readonly kind: 'unknown'; readonly reason: string }
  | { readonly kind: 'not_applicable'; readonly reason: string };

/** 构建器接受的事实取值：已知值 **或** 明确不可用。 */
export type XlsxFactValue = KnownFactValue | UnavailableFactValue;

/**
 * 一条事实快照条目。
 *
 * **是 `KnownFactSnapshotEntry` 的超集**：`KnownFactSnapshotEntry` 的 `value` 是 `KnownFactValue`
 * （`XlsxFactValue` 的子集），所以物化端口的快照可以**原样传进来**；同时本类型额外接受
 * `unknown` / `not_applicable`，让"缺失不当零"这条判据在构建器内部**可被直接断言**。
 */
export interface XlsxFactEntry {
  readonly fact_ref: FactRef;
  /** 稳定事实键（`headcount` / `budget.total` / `event.date`）。 */
  readonly fact_key: string;
  readonly value: XlsxFactValue;
  readonly source: FactSource;
}

/** 一个分项：行标签 + 它绑定的事实键。 */
export interface XlsxLineSpec {
  readonly label: string;
  readonly fact_key: string;
}

/**
 * 表格的完整输入（= §6 的"结构化数据、单位、计算口径"）。
 *
 * - `lines` + 事实快照 = **结构化数据**；
 * - `unit` = **单位**（单一来源：进入表头，且**参与校验**——单位不符的分项不得相加）；
 * - `total_label` + `scale` = **计算口径**（合计 = 各分项之和，由代码核算；`scale` 是小数位）。
 *
 * **注意没有"合计值"这个输入字段**：合计只能由代码从分项算出来，Agent 无法"顺手把 8 改成 10"。
 */
export interface XlsxSheetSpec {
  /** 工作表名（也用于工作簿里的 `sheet/@name`）。 */
  readonly sheet_name: string;
  /** 第一列表头（如 `项目`）。 */
  readonly label_header: string;
  /** 第二列表头（如 `金额`）；输出时与单位合成 `金额（元）`。 */
  readonly value_header: string;
  /** 值列的单位（非空）。 */
  readonly unit: string;
  /** 分项（有序：行顺序 = 数组顺序）。 */
  readonly lines: readonly XlsxLineSpec[];
  /** 合计行的行标签（如 `合计`）。 */
  readonly total_label: string;
  /** 计算口径的小数位（0…20）；写入值按此定点格式化。 */
  readonly scale: number;
}

// ---------------------------------------------------------------------------
// 单元格模型（可断言的中间形态）
// ---------------------------------------------------------------------------

/** 单元格留空的结构化原因（封闭枚举）——留空必须可追溯，不得静默。 */
export type XlsxBlankReason =
  | 'missing_fact' // 快照里没有这个事实键（缺失）
  | 'unknown_fact' // 事实存在但为 unknown
  | 'not_applicable_fact' // 事实存在但为 not_applicable
  | 'not_numeric' // 已知值不是数值（date / text），不得塞进数值列
  | 'unit_mismatch' // 值列单位与事实单位不符（不得跨单位求和）
  | 'currency_mismatch' // 同一次求和中出现不同币种
  | 'incomplete_total'; // 合计无法成立（没有任何分项）

/** 一个单元格：文本 / 数值 / 留空。**留空是三等值之一**，不是"null 或 0 的口头约定"。 */
export type XlsxCell =
  | {
      readonly ref: string;
      readonly column: number;
      readonly row: number;
      readonly kind: 'text';
      readonly text: string;
    }
  | {
      readonly ref: string;
      readonly column: number;
      readonly row: number;
      readonly kind: 'number';
      /** 写入 `<v>` 的**精确文本**（由 `formatDecimal` 定点格式化，不经 locale）。 */
      readonly value_text: string;
      /** 原始数值（供测试与调用方复算核对）。 */
      readonly amount: number;
    }
  | {
      readonly ref: string;
      readonly column: number;
      readonly row: number;
      readonly kind: 'blank';
      readonly reason: XlsxBlankReason;
    };

/** 合计的计算结果：要么是一个数，要么是**留空的原因**（永远不是 0）。 */
export type XlsxTotal =
  | { readonly ok: true; readonly amount: number }
  | { readonly ok: false; readonly reason: XlsxBlankReason };

/** 构建结果（形状与物化回执的对应量一致）。 */
export interface XlsxBuildResult {
  /** 容器真实字节（可写盘的 .xlsx）。 */
  readonly bytes: Buffer;
  /** ZIP 部件数（自检 / 独立读回交叉核对用）。 */
  readonly entry_count: number;
  /** 内容摘要：**裸小写十六进制 sha256（真实容器字节）**。 */
  readonly content_digest: string;
}

// ---------------------------------------------------------------------------
// 输入校验（构造期显式失败，不静默降级）
// ---------------------------------------------------------------------------

/** Excel 工作表名禁用字符：`[ ] : * ? / \`。 */
const SHEET_NAME_FORBIDDEN = /[[\]:*?\/\\]/;

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} 不能为空字符串`);
  }
  return value;
}

/** 校验表格输入（工作表名按 Excel 侧合法性收窄）。@throws {ValidationError} */
export function assertXlsxSpec(spec: XlsxSheetSpec): void {
  const name = requireNonEmptyString(spec.sheet_name, 'sheet_name');
  if (name.length > XLSX_MAX_SHEET_NAME_LENGTH) {
    throw new ValidationError(
      `sheet_name 超过 ${String(XLSX_MAX_SHEET_NAME_LENGTH)} 字符（Excel 上限）：${String(name.length)}`,
    );
  }
  if (SHEET_NAME_FORBIDDEN.test(name)) {
    throw new ValidationError(`sheet_name 含 Excel 禁用字符 [ ] : * ? / \\：${JSON.stringify(name)}`);
  }
  requireNonEmptyString(spec.label_header, 'label_header');
  requireNonEmptyString(spec.value_header, 'value_header');
  requireNonEmptyString(spec.unit, 'unit');
  requireNonEmptyString(spec.total_label, 'total_label');
  if (!Number.isSafeInteger(spec.scale) || spec.scale < 0 || spec.scale > 20) {
    throw new ValidationError(`scale 必须是 0…20 的整数，收到 ${String(spec.scale)}`);
  }
  if (!Array.isArray(spec.lines)) {
    throw new ValidationError('lines 必须是数组');
  }
  for (const line of spec.lines) {
    requireNonEmptyString(line.label, 'line.label');
    requireNonEmptyString(line.fact_key, 'line.fact_key');
  }
}

/**
 * 事实键 → 条目索引。**重复键直接抛**（单一来源被破坏，不得任取一条，口径同 `currentFactByKey`）。
 * @throws {ValidationError}
 */
function indexFacts(facts: readonly XlsxFactEntry[]): ReadonlyMap<string, XlsxFactEntry> {
  const index = new Map<string, XlsxFactEntry>();
  for (const fact of facts) {
    const key = requireNonEmptyString(fact.fact_key, 'fact.fact_key');
    requireNonEmptyString(fact.fact_ref, 'fact.fact_ref');
    if (index.has(key)) {
      throw new ValidationError(
        `事实键 ${key} 在快照里出现多条：单一来源被破坏，必须显式失败而不是任取一条（P3）`,
      );
    }
    index.set(key, fact);
  }
  return index;
}

// ---------------------------------------------------------------------------
// 事实 → 可用数值（唯一判定入口）
// ---------------------------------------------------------------------------

type FactRead =
  | { readonly kind: 'amount'; readonly amount: number }
  | { readonly kind: 'unusable'; readonly reason: XlsxBlankReason };

/**
 * 把一条已知值判成"可参与计算的数值"或"不可用的一种原因"。
 * **`unknown` / `not_applicable` 在这里转为 `blank`，绝不做 `?? 0` 之类的缺省。**
 */
function readFactValue(value: XlsxFactValue, unit: string): FactRead {
  if ('kind' in value) {
    return {
      kind: 'unusable',
      reason: value.kind === 'unknown' ? 'unknown_fact' : 'not_applicable_fact',
    };
  }
  if (value.type !== 'number') {
    return { kind: 'unusable', reason: 'not_numeric' };
  }
  if (value.unit !== unit) {
    return { kind: 'unusable', reason: 'unit_mismatch' };
  }
  return { kind: 'amount', amount: value.amount };
}

/** 单条事实（已知数值 + 币种）读取，供币种一致性检查用。 */
function readCurrency(value: XlsxFactValue): string | null {
  return 'kind' in value || value.type !== 'number' ? null : value.currency;
}

// ---------------------------------------------------------------------------
// 关键计算（第 6 节的"通过代码检查关键计算"）
// ---------------------------------------------------------------------------

/**
 * 计算合计：**合计 = 各分项之和**，由代码在事实快照上求和。
 *
 * 只有**全部分项都可作为同单位数值**时才给出合计数；任一分项缺失 / 未知 / 不适用 / 非数值 /
 * 单位不符，或分项之间币种不一致，则**整体不可计算**——返回留空原因而不是"把缺失当零的部分和"。
 * 没有任何分项时同样不给 0（`incomplete_total`）。
 *
 * 返回的是**数**，格式化（小数位）在写入单元格时进行；因此"写入值 == 本函数结果"可被独立核对。
 */
export function computeLineTotal(spec: XlsxSheetSpec, facts: readonly XlsxFactEntry[]): XlsxTotal {
  assertXlsxSpec(spec);
  const index = indexFacts(facts);
  if (spec.lines.length === 0) {
    return { ok: false, reason: 'incomplete_total' };
  }

  let sum = 0;
  let currency: string | null = null;
  let currencySeen = false;

  for (const line of spec.lines) {
    const entry = index.get(line.fact_key);
    if (entry === undefined) {
      return { ok: false, reason: 'missing_fact' };
    }
    const read = readFactValue(entry.value, spec.unit);
    if (read.kind === 'unusable') {
      return { ok: false, reason: read.reason };
    }
    const lineCurrency = readCurrency(entry.value);
    if (lineCurrency !== null) {
      if (currencySeen && lineCurrency !== currency) {
        return { ok: false, reason: 'currency_mismatch' };
      }
      currency = lineCurrency;
      currencySeen = true;
    }
    sum += read.amount;
  }

  return { ok: true, amount: sum };
}

// ---------------------------------------------------------------------------
// 表格模型
// ---------------------------------------------------------------------------

/** 列号（1 起）→ 列字母：`1 → A`、`27 → AA`。 */
function columnLetter(column: number): string {
  let remaining = column;
  let letters = '';
  while (remaining > 0) {
    const offset = (remaining - 1) % 26;
    letters = String.fromCharCode(0x41 + offset) + letters;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return letters;
}

function cellRef(column: number, row: number): string {
  return `${columnLetter(column)}${String(row)}`;
}

function textCell(column: number, row: number, text: string): XlsxCell {
  return Object.freeze({ ref: cellRef(column, row), column, row, kind: 'text' as const, text });
}

function numberCell(column: number, row: number, valueText: string, amount: number): XlsxCell {
  return Object.freeze({
    ref: cellRef(column, row),
    column,
    row,
    kind: 'number' as const,
    value_text: valueText,
    amount,
  });
}

function blankCell(column: number, row: number, reason: XlsxBlankReason): XlsxCell {
  return Object.freeze({ ref: cellRef(column, row), column, row, kind: 'blank' as const, reason });
}

/** 标签列 / 值列的列号（最小表格固定两列）。 */
const LABEL_COLUMN = 1;
const VALUE_COLUMN = 2;

/**
 * 生成表格模型（行 → 单元格）。**这是"写什么"的唯一决策点**，XML 与字节都从它派生。
 *
 * 布局：
 * - 第 1 行：`label_header` | `${value_header}（${unit}）`
 * - 第 2…(n+1) 行：每个分项一行（标签 | 数值或留空）
 * - 第 n+2 行：`total_label` | 合计（数值或留空）
 */
export function buildXlsxTable(
  spec: XlsxSheetSpec,
  facts: readonly XlsxFactEntry[],
): readonly (readonly XlsxCell[])[] {
  assertXlsxSpec(spec);
  const index = indexFacts(facts);

  const rows: XlsxCell[][] = [];

  rows.push([
    textCell(LABEL_COLUMN, 1, spec.label_header),
    textCell(VALUE_COLUMN, 1, `${spec.value_header}（${spec.unit}）`),
  ]);

  spec.lines.forEach((line, position) => {
    const row = position + 2;
    const entry = index.get(line.fact_key);
    let valueCell: XlsxCell;
    if (entry === undefined) {
      valueCell = blankCell(VALUE_COLUMN, row, 'missing_fact');
    } else {
      const read = readFactValue(entry.value, spec.unit);
      valueCell =
        read.kind === 'unusable'
          ? blankCell(VALUE_COLUMN, row, read.reason)
          : numberCell(VALUE_COLUMN, row, formatAmount(read.amount, spec.scale), read.amount);
    }
    rows.push([textCell(LABEL_COLUMN, row, line.label), valueCell]);
  });

  const totalRow = spec.lines.length + 2;
  const total = computeLineTotal(spec, facts);
  rows.push([
    textCell(LABEL_COLUMN, totalRow, spec.total_label),
    total.ok
      ? numberCell(VALUE_COLUMN, totalRow, formatAmount(total.amount, spec.scale), total.amount)
      : blankCell(VALUE_COLUMN, totalRow, total.reason),
  ]);

  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

// ---------------------------------------------------------------------------
// 数字格式化（复用 W-A 的定点格式化，不自己拼字符串）
// ---------------------------------------------------------------------------

/**
 * 把金额按计算口径的小数位格式化成 `<v>` 的精确文本。
 * 用 W-A 的 `formatDecimal`（基于 BigInt 进位，不经 `toFixed` / `toLocaleString`），
 * 保证"金额 → XML 文本"只有一处、且与 locale / 平台无关。
 */
function formatAmount(amount: number, scale: number): string {
  return formatDecimal(amount, scale);
}

// ---------------------------------------------------------------------------
// XML / 包组装
// ---------------------------------------------------------------------------

/** 会被写进 XML 的单元格：文本或数值（留空**整体不写**，这也是 Excel 的空格表示）。 */
type WritableCell = Exclude<XlsxCell, { kind: 'blank' }>;

function isWritableCell(cell: XlsxCell): cell is WritableCell {
  return cell.kind !== 'blank';
}

function cellElement(cell: WritableCell): XmlElement {
  if (cell.kind === 'text') {
    return el('c', [attr('r', cell.ref), attr('t', 'inlineStr')], [
      el('is', [], [el('t', [], [cell.text])]),
    ]);
  }
  // 数值单元格：**不带 `t`**，`<v>` 直接是数字文本。
  return el('c', [attr('r', cell.ref)], [el('v', [], [cell.value_text])]);
}

/** 生成 `xl/worksheets/sheet1.xml` 文本（留空单元格**整体不写**，这也是 Excel 的空格表示）。 */
export function buildXlsxSheetXml(spec: XlsxSheetSpec, facts: readonly XlsxFactEntry[]): string {
  const table = buildXlsxTable(spec, facts);
  const rows = table.map((cells, position) =>
    el(
      'row',
      [attr('r', String(position + 1))],
      cells.filter(isWritableCell).map(cellElement),
    ),
  );
  const worksheet = el('worksheet', [attr('xmlns', SPREADSHEETML_NAMESPACE)], [
    el('sheetData', [], rows),
  ]);
  return serializeXmlDocument(worksheet);
}

/** 生成 `xl/workbook.xml` 文本（单工作表，`rId1` 指向 `sheet1.xml`）。 */
export function buildXlsxWorkbookXml(spec: XlsxSheetSpec): string {
  assertXlsxSpec(spec);
  const workbook = el(
    'workbook',
    [attr('xmlns', SPREADSHEETML_NAMESPACE), attr('xmlns:r', OFFICE_RELATIONSHIPS_NAMESPACE)],
    [
      el('sheets', [], [
        el('sheet', [
          attr('name', spec.sheet_name),
          attr('sheetId', '1'),
          attr('r:id', 'rId1'),
        ]),
      ]),
    ],
  );
  return serializeXmlDocument(workbook);
}

/**
 * 内容摘要：**对容器真实字节取 sha256，输出裸小写十六进制**。
 *
 * 与 W-D1（DOCX 构建器）逐字同口径，也与 W-A 的 golden 向量（`sha256(writeZip(...))`）一致。
 * 不复用两个既有摘要助手的原因：它们**接口上都只接受 `string` 并经 UTF-8 重编码**
 * （`src/dependency/digest.ts` 的 `canonicalDigest`、`src/fake/digest.ts` 的 `sha256Hex`/`contentDigest`），
 * 对二进制容器会改变字节、破坏"回读摘要 = 内容摘要"（I-1）；其中 `contentDigest` 还带 `sha256:`
 * 前缀，与裸 hex 不同域。这里复用**同一个内建原语**做一次字节级调用——不新增依赖、不新增算法、
 * 不新增摘要模块。
 */
/**
 * 表格产物的内容摘要（**裸小写 hex**）。
 *
 * 自 W-DISC 起**委托给唯一实现** `src/artifacts/digest.ts` 的 `digestBytes`——原先三处
 * 逐字节相同的副本已收敛为一处（对外符号名保留，行为逐字节不变）。
 */
export function xlsxContentDigest(bytes: Uint8Array): string {
  return digestBytes(bytes);
}

/**
 * 构建一份真实的 .xlsx。
 *
 * 无 IO、无时钟、无随机：同一 `(spec, facts)` 连跑两次 ⇒ 字节逐字节相等、摘要相等。
 *
 * @throws {ValidationError} 输入非法（工作表名 / 单位 / 小数位 / 分项 / 重复事实键）。
 */
export function buildXlsxTemplate(
  spec: XlsxSheetSpec,
  facts: readonly XlsxFactEntry[],
): XlsxBuildResult {
  const sheetXml = buildXlsxSheetXml(spec, facts);
  const workbookXml = buildXlsxWorkbookXml(spec);

  const parts: readonly OpcPart[] = [
    { path: XLSX_WORKBOOK_PART_PATH, content_type: XLSX_MAIN_CONTENT_TYPE, data: workbookXml },
    { path: XLSX_WORKSHEET_PART_PATH, content_type: XLSX_WORKSHEET_CONTENT_TYPE, data: sheetXml },
  ];

  const relationships: readonly RelationshipGroup[] = [
    {
      owner_part_path: null,
      declarations: [
        { type: OFFICE_DOCUMENT_RELATIONSHIP_TYPE, target: XLSX_WORKBOOK_PART_PATH },
      ],
    },
    {
      owner_part_path: XLSX_WORKBOOK_PART_PATH,
      declarations: [{ type: WORKSHEET_RELATIONSHIP_TYPE, target: WORKSHEET_RELATIONSHIP_TARGET }],
    },
  ];

  const assembled = assembleOpcPackage({
    parts,
    // 关系部件 `_rels/*.rels` 的内容类型由扩展名默认项确定（OPC 要求必须有一条 rels 默认项）。
    content_type_defaults: [{ extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE }],
    relationships,
  });

  const bytes = writeZip(assembled.entries);
  return Object.freeze({
    bytes,
    entry_count: assembled.entries.length,
    content_digest: xlsxContentDigest(bytes),
  });
}

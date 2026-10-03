/**
 * X03：把 {@link file://./cellxfs.ts} 产出的 **cellXfs 真正写进 .xlsx 容器字节**
 * （design-06-P8 / XLS-05「普通 cellXfs 真实写出」）。
 *
 * ## 为什么还要这一层
 *
 * `cellxfs.ts` 只产出 `styles.xml` 的 **XML 片段**（字符串）。"片段里含某个 xf"与
 * "一份真实 .xlsx 里确实带着这个 xf、并且单元格用 `s=` 指向它"是**两件事**——
 * 前者能被 `toContain` 糊弄过去，后者只能靠**真实字节 + 独立读回**证明。
 *
 * 本模块因此：
 *
 * 1. 用 {@link renderStyleSheetXml} 把片段包成结构完整的 `styleSheet`（含 `cellStyleXfs`，
 *    与 `xlsx-write.ts` 的既有最小表同构）；
 * 2. 生成带 `s="{cellXfs 下标}"` 的 `xl/worksheets/sheet1.xml`；
 * 3. 用 W-A 的 `assembleOpcPackage` + `writeZip`（全 STORE、确定性）打出**真实 .xlsx 字节**。
 *
 * 读回那一侧由独立测试用 `readZip` 完成——本模块**不做**任何自校验，避免"自己证明自己"。
 *
 * 单元格保护（`<protection locked="0"/>`，XLS-15 未锁定格）同样经由 {@link renderStyleSheetXml}
 * 的 `cellXfs` 段落写出——本模块不另设参数，`CellStyle.protection` 即足够。
 *
 * ## 原值 / 显示值分开
 *
 * 写入 `<v>` 的是**原值**（数值单元格写原数值文本，日期单元格写 Excel **序列号**）；
 * 显示文本由调用方经 {@link file://./descriptor.ts} 的 `renderNumberDisplay` 另行取得。
 * 本模块**不**把显示文本写进 `<v>`——那正是"把 0.15 写成 15"这类错误的发生点。
 */

import { digestBytes } from '../../artifacts/digest.js';
import {
  RELATIONSHIPS_CONTENT_TYPE,
  XML_DECLARATION,
  XML_NEWLINE,
  attr,
  assembleOpcPackage,
  el,
  serializeXmlDocument,
  writeZip,
  type OpcPart,
  type RelationshipGroup,
  type XmlElement,
} from '../../artifacts/ooxml/index.js';
import {
  OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
  OFFICE_RELATIONSHIPS_NAMESPACE,
  SPREADSHEETML_NAMESPACE,
  WORKSHEET_RELATIONSHIP_TYPE,
  XLSX_MAIN_CONTENT_TYPE,
  XLSX_MAX_SHEET_NAME_LENGTH,
  XLSX_WORKBOOK_PART_PATH,
  XLSX_WORKSHEET_CONTENT_TYPE,
  XLSX_WORKSHEET_PART_PATH,
} from '../../artifacts/templates/xlsx.js';
import { ValidationError } from '../../protocol/index.js';
import { formatCellAddress, parseCellAddress } from '../reference.js';
import type { CellStyle } from '../styles.js';
import {
  XLSX_STYLES_CONTENT_TYPE,
  XLSX_STYLES_PART_PATH,
  STYLES_RELATIONSHIP_TYPE,
} from '../xlsx-write.js';
import {
  buildStyleTable,
  renderStyleTableXml,
  type StyleTable,
} from './cellxfs.js';
import { styleKey } from './descriptor.js';

/** 工作表部件在包内的相对目标（相对 `xl/`）。 */
const WORKSHEET_RELATIONSHIP_TARGET = 'worksheets/sheet1.xml';
/** 样式部件在包内的相对目标（相对 `xl/`）。 */
const STYLES_RELATIONSHIP_TARGET = 'styles.xml';

/** Excel 工作表名禁用字符：`[ ] : * ? / \`。 */
const SHEET_NAME_FORBIDDEN = /[[\]:*?\/\\]/;

/** 纯小数量级上限：超过它 `String(number)` 会退化成指数记法，`<v>` 里非法。 */
const MAX_PLAIN_MAGNITUDE = 1e21;

// ---------------------------------------------------------------------------
// 输入形状（本模块的"操作 schema"）
// ---------------------------------------------------------------------------

/**
 * 单元格写入值（**原值**，不是显示值）。
 *
 * - `number` —— 普通数值，`<v>` 写原数值文本；
 * - `date_serial` —— 日期单元格：`<v>` 写 **Excel 序列号**（数值），由 `s` 指向的
 *   日期 `numFmt` 决定它显示成哪一天；
 * - `text` —— 文本，走 `t="inlineStr"`（不引 sharedStrings，与模板层同口径）。
 */
export type StyledCellValue =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'date_serial'; readonly serial: number }
  | { readonly kind: 'text'; readonly text: string };

/** 一个带样式的单元格：A1 地址 + 原值 + 样式。 */
export interface StyledCell {
  /** A1 地址（如 `B2`）；工作表内唯一。 */
  readonly ref: string;
  readonly value: StyledCellValue;
  /** 该单元格的样式（`styles.ts` 的 `CellStyle`）。 */
  readonly style: CellStyle;
}

/** 一张带样式的工作表。 */
export interface StyledSheetSpec {
  readonly sheet_name: string;
  /** 单元格（顺序无关：输出按行列排序，保证确定性）。 */
  readonly cells: readonly StyledCell[];
}

/** 构建产物：真实容器字节 + 生成的两份 XML + 样式表（供独立读回交叉核对）。 */
export interface StyledXlsxBuild {
  /** 真实 .xlsx 字节（可写盘）。 */
  readonly bytes: Buffer;
  /** 生成的完整 `xl/styles.xml` 文本。 */
  readonly styles_xml: string;
  /** 生成的 `xl/worksheets/sheet1.xml` 文本。 */
  readonly worksheet_xml: string;
  /** 样式键 → cellXfs 下标（单元格 `s` 属性的来源）。 */
  readonly style_table: StyleTable;
  /** ZIP 条目数（独立读回核对用）。 */
  readonly entry_count: number;
  /** 容器真实字节的 sha256（裸小写 hex）。 */
  readonly content_digest: string;
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function requireSheetName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ValidationError('sheet_name 必须是非空字符串');
  }
  if (name.length > XLSX_MAX_SHEET_NAME_LENGTH) {
    throw new ValidationError(
      `sheet_name 超过 ${String(XLSX_MAX_SHEET_NAME_LENGTH)} 字符（Excel 上限）：${String(name.length)}`,
    );
  }
  if (SHEET_NAME_FORBIDDEN.test(name)) {
    throw new ValidationError(`sheet_name 含 Excel 禁用字符 [ ] : * ? / \\：${JSON.stringify(name)}`);
  }
  return name;
}

/** 数值 → `<v>` 文本：拒绝指数记法（`<v>` 只接受十进制定点文本）。 */
function rawNumberText(value: number, where: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${where} 必须是有限数，收到 ${String(value)}`);
  }
  if (Math.abs(value) >= MAX_PLAIN_MAGNITUDE) {
    throw new ValidationError(
      `${where} 量级 ${String(value)} 超出定点文本可表达范围（>= ${String(MAX_PLAIN_MAGNITUDE)}），拒绝写成指数记法`,
    );
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// styles.xml 外壳
// ---------------------------------------------------------------------------

/**
 * 把 {@link renderStyleTableXml} 的五段片段包成结构完整的 `styleSheet`。
 *
 * 子元素顺序遵守 CT_Stylesheet：`numFmts → fonts → fills → borders → cellStyleXfs →
 * cellXfs`。插入一条最小 `cellStyleXfs`（与 `xlsx-write.ts` 的既有最小表同构），
 * 让真实 Excel 能解析 `xfId="0"`。
 */
export function renderStyleSheetXml(table: StyleTable): string {
  const parts = renderStyleTableXml(table);
  const cellStyleXfs =
    '<cellStyleXfs count="1">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>' +
    '</cellStyleXfs>';
  return (
    `${XML_DECLARATION}${XML_NEWLINE}` +
    `<styleSheet xmlns="${SPREADSHEETML_NAMESPACE}">` +
    parts.numFmts +
    parts.fonts +
    parts.fills +
    parts.borders +
    cellStyleXfs +
    parts.cellXfs +
    '</styleSheet>'
  );
}

// ---------------------------------------------------------------------------
// worksheet.xml
// ---------------------------------------------------------------------------

interface PlacedCell {
  readonly ref: string;
  readonly column: number;
  readonly row: number;
  readonly value: StyledCellValue;
  readonly styleIndex: number;
}

function cellElement(cell: PlacedCell): XmlElement {
  const attributes = [attr('r', cell.ref), attr('s', String(cell.styleIndex))];
  if (cell.value.kind === 'text') {
    // 文本：t="inlineStr"；`s` 与 `t` 顺序不影响语义，但固定顺序换来确定性。
    return el('c', [...attributes, attr('t', 'inlineStr')], [
      el('is', [], [el('t', [], [cell.value.text])]),
    ]);
  }
  const raw =
    cell.value.kind === 'number'
      ? rawNumberText(cell.value.value, `单元格 ${cell.ref}`)
      : rawNumberText(cell.value.serial, `单元格 ${cell.ref}`);
  return el('c', attributes, [el('v', [], [raw])]);
}

/**
 * 生成 `xl/worksheets/sheet1.xml`。
 *
 * 单元格按（行、列）升序写入，与传入顺序无关——同一 `spec` 必得逐字节相同的 XML。
 */
export function buildStyledSheetXml(spec: StyledSheetSpec, table: StyleTable): string {
  requireSheetName(spec.sheet_name);
  const seen = new Set<string>();
  const placed: PlacedCell[] = spec.cells.map((cell) => {
    const address = parseCellAddress(cell.ref);
    const canonicalRef = formatCellAddress(address);
    if (seen.has(canonicalRef)) {
      throw new ValidationError(`单元格地址重复：${canonicalRef}`);
    }
    seen.add(canonicalRef);
    const index = table.indexByKey.get(styleKey(cell.style));
    if (index === undefined) {
      throw new ValidationError(`样式未在样式表中（内部错误）：${canonicalRef}`);
    }
    return {
      ref: canonicalRef,
      column: address.column,
      row: address.row,
      value: cell.value,
      styleIndex: index,
    };
  });

  placed.sort((a, b) => (a.row - b.row) || (a.column - b.column));

  const rows: XmlElement[] = [];
  let currentRow = -1;
  let bucket: XmlElement[] = [];
  const flush = (): void => {
    if (bucket.length > 0) {
      rows.push(el('row', [attr('r', String(currentRow))], bucket));
      bucket = [];
    }
  };
  for (const cell of placed) {
    if (cell.row !== currentRow) {
      flush();
      currentRow = cell.row;
    }
    bucket.push(cellElement(cell));
  }
  flush();

  const worksheet = el('worksheet', [attr('xmlns', SPREADSHEETML_NAMESPACE)], [
    el('sheetData', [], rows),
  ]);
  return serializeXmlDocument(worksheet);
}

/** 生成单工作表 `xl/workbook.xml`（`rId1` 指向 worksheet，`rId2` 指向 styles）。 */
export function buildStyledWorkbookXml(spec: StyledSheetSpec): string {
  const name = requireSheetName(spec.sheet_name);
  const workbook = el(
    'workbook',
    [attr('xmlns', SPREADSHEETML_NAMESPACE), attr('xmlns:r', OFFICE_RELATIONSHIPS_NAMESPACE)],
    [el('sheets', [], [el('sheet', [attr('name', name), attr('sheetId', '1'), attr('r:id', 'rId1')])])],
  );
  return serializeXmlDocument(workbook);
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 构建一份**带普通样式的真实 .xlsx**。
 *
 * 纯函数：无 IO、无时钟、无随机——同一 `spec` 连跑两次 ⇒ 字节逐字节相等。
 *
 * @throws {ValidationError} 工作表名非法 / 单元格地址重复或非法 / 样式含未知键
 */
export function buildStyledXlsx(spec: StyledSheetSpec): StyledXlsxBuild {
  requireSheetName(spec.sheet_name);
  const table = buildStyleTable(spec.cells.map((cell) => cell.style));
  const stylesXml = renderStyleSheetXml(table);
  const worksheetXml = buildStyledSheetXml(spec, table);
  const workbookXml = buildStyledWorkbookXml(spec);

  const parts: readonly OpcPart[] = [
    { path: XLSX_WORKBOOK_PART_PATH, content_type: XLSX_MAIN_CONTENT_TYPE, data: workbookXml },
    { path: XLSX_WORKSHEET_PART_PATH, content_type: XLSX_WORKSHEET_CONTENT_TYPE, data: worksheetXml },
    { path: XLSX_STYLES_PART_PATH, content_type: XLSX_STYLES_CONTENT_TYPE, data: stylesXml },
  ];

  const relationships: readonly RelationshipGroup[] = [
    {
      owner_part_path: null,
      declarations: [{ type: OFFICE_DOCUMENT_RELATIONSHIP_TYPE, target: XLSX_WORKBOOK_PART_PATH }],
    },
    {
      owner_part_path: XLSX_WORKBOOK_PART_PATH,
      declarations: [
        { type: WORKSHEET_RELATIONSHIP_TYPE, target: WORKSHEET_RELATIONSHIP_TARGET },
        { type: STYLES_RELATIONSHIP_TYPE, target: STYLES_RELATIONSHIP_TARGET },
      ],
    },
  ];

  const assembled = assembleOpcPackage({
    parts,
    content_type_defaults: [{ extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE }],
    relationships,
  });

  const bytes = writeZip(assembled.entries);
  return Object.freeze({
    bytes,
    styles_xml: stylesXml,
    worksheet_xml: worksheetXml,
    style_table: table,
    entry_count: assembled.entries.length,
    content_digest: digestBytes(bytes),
  });
}

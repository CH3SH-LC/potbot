/**
 * 表格域：图表（XLS-12；FA-XLS-OBJECTS 工作包）。
 *
 * ## 这个文件要证明的事
 *
 * XLS-12 的验收句是「柱/条/折线/饼/散点等常用图表的创建、改数据、标题/轴/图例/样式、删除；
 * **图表数值必须绑定工作簿来源**」。最后半句是本模块的形状决定者：
 *
 * - 一个 `ChartSeries` 只能携带**区域引用**（`{ sheet, range }`），**没有**"一堆数字"这种输入形态；
 *   因此"硬编码数字"在这里连表达都表达不出来（同 `value.ts` 用判别联合封死"文本冒充数值"的手法）。
 * - 每个引用在创建 / 改数据时都会被 {@link validateChartReferences} 拿工作簿**实测**：
 *   表要存在、区域要落在该表的声明范围内、数值列必须是一维连续区域。对不上的引用**显式抛错**，
 *   而不是写进 XML 里等 Excel 打开时报一个更难查的错。
 * - 生成的 `<c:f>` 里写的是 `'表名'!$B$2:$B$5` 这样的**区域公式**，而**不写 `<c:numCache>`**——
 *   图表因此永远跟随工作簿数据变化，而不是把某一次的数字冻结在里面。
 *
 * ## 产出哪些部件
 *
 * | 部件 | 内容 |
 * |---|---|
 * | `xl/charts/chartN.xml` | `c:chartSpace`（绘图区、系列、标题、轴、图例、样式） |
 * | `xl/drawings/drawingN.xml` | `xdr:wsDr` + `xdr:twoCellAnchor`（位置 / 尺寸由锚点决定）+ `c:chart r:id` |
 * | `xl/drawings/_rels/drawingN.xml.rels` | 组装期由 {@link composeWorkbookPackage} 按声明生成（本模块不手写） |
 * | `xl/worksheets/_rels/sheetN.xml.rels` | 同上：工作表 → 绘图的关系 |
 *
 * 工作表 XML 本身由 `xlsx-write.ts` 的 `buildSheetXml` 生成，本模块**只在它末尾追加**
 * `<drawing r:id="…"/>`（并在根元素补 `xmlns:r`）——见 {@link composeWorkbookPackage} 的
 * `transforms`。这是本工作包"不改既有文件"约束下的接线方式：既有写入器一个字节都没改，
 * 扩展部件由本模块声明、由同一个 `assembleOpcPackage` 组装。
 *
 * ## 确定性
 *
 * 无 IO、无时钟（`new Date(` / `Date.now(` 是内核纪律禁词）、无随机、无 locale。
 * 图表名 → 部件路径、系列顺序 → `<c:order val>`，全部由模型显式决定。
 * 同一 `(workbook, chartSet)` ⇒ 同一字节。
 *
 * ## 未验证 / 边界（如实登记）
 *
 * - 产出的 .xlsx **未经真实 Excel / WPS 打开验证**（本工作树无 Office 授权、无设备）：
 *   部件与关系按 ECMA-376 的序列与命名空间书写，并由仓内自研 `readZip` + `parseXmlBytes`
 *   读回核对；**"真实软件能打开"这一点标未验证**。
 * - 本模块不写 `<c:numCache>` / `<c:strCache>`：Excel 打开时按 `<c:f>` 取数重绘，
 *   但"打开后图形与数据一致"同样**未在真实软件中验证**。
 */

import { ValidationError } from '../protocol/index.js';
import {
  RELATIONSHIPS_CONTENT_TYPE,
  assembleOpcPackage,
  attr,
  el,
  escapeAttribute,
  serializeXmlDocument,
  serializeXmlNode,
  writeZip,
  type ContentTypeDefault,
  type OpcPart,
  type RelationshipDeclaration,
  type RelationshipGroup,
  type XmlAttribute,
  type XmlElement,
  type XmlNode,
} from '../artifacts/ooxml/index.js';
import {
  OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
  OFFICE_RELATIONSHIPS_NAMESPACE,
  WORKSHEET_RELATIONSHIP_TYPE,
  XLSX_MAIN_CONTENT_TYPE,
  XLSX_WORKBOOK_PART_PATH,
  XLSX_WORKSHEET_CONTENT_TYPE,
  xlsxContentDigest,
} from '../artifacts/templates/xlsx.js';
import { evaluateWorkbookFormulas, type EvalOutcome } from './evaluate.js';
import { columnNumberToLetters, formatRange, parseRange, type CellRange } from './reference.js';
import type { NamedReference } from './recalc-plan/names.js';
import { tableColumnPosition, type StructuredTable } from './structured-table.js';
import {
  STYLES_RELATIONSHIP_TYPE,
  XLSX_STYLES_CONTENT_TYPE,
  XLSX_STYLES_PART_PATH,
  buildSheetXml,
  buildStylesXml,
  buildWorkbookXml,
  worksheetPartPath,
} from './xlsx-write.js';
import { getSheet, type WorkbookState } from './workbook.js';

// ---------------------------------------------------------------------------
// 命名空间 / 内容类型 / 关系类型 / 部件路径
// ---------------------------------------------------------------------------

/** DrawingML 图表命名空间。 */
export const DRAWINGML_CHART_NAMESPACE =
  'http://schemas.openxmlformats.org/drawingml/2006/chart';

/** DrawingML 主命名空间（`a:` 前缀：填充、文本、图形属性）。 */
export const DRAWINGML_MAIN_NAMESPACE =
  'http://schemas.openxmlformats.org/drawingml/2006/main';

/** 工作表绘图命名空间（`xdr:` 前缀）。 */
export const SPREADSHEET_DRAWING_NAMESPACE =
  'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';

/** 图表部件内容类型。 */
export const XLSX_CHART_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';

/** 绘图部件内容类型。 */
export const XLSX_DRAWING_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.drawing+xml';

/** 部件级关系：worksheet → drawing。 */
export const DRAWING_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing';

/** 部件级关系：drawing → chart。 */
export const CHART_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart';

/** 第 `index`（0 起）个图表部件路径。 */
export function chartPartPath(index: number): string {
  return `xl/charts/chart${String(index + 1)}.xml`;
}

/** 第 `index`（0 起）个绘图部件路径。 */
export function drawingPartPath(index: number): string {
  return `xl/drawings/drawing${String(index + 1)}.xml`;
}

// ---------------------------------------------------------------------------
// 共用的包组装器（charts / pivot / objects 三个扩展模块共用）
// ---------------------------------------------------------------------------

/**
 * 对一个**由本组装器生成**的部件做尾部改写。
 *
 * - `root_attributes`：补到根元素开标签上的属性（如工作表要引 `r:id` 就得先声明 `xmlns:r`）。
 *   已经出现过的同名属性**跳过**（不重复声明）。
 * - `children`：按数组顺序追加到根元素**末尾**（闭合标签之前）的 XML 片段。
 *
 * 追加位置是刻意的：本工作包要追加的元素（`<hyperlinks>`、`<drawing>`、`<legacyDrawing>`、
 * `<pivotCaches>`）在各自父元素的序列里都排在**最后几位**，且它们之间的相对顺序与追加顺序一致，
 * 因此"追加到末尾"既不改动既有子元素，也不违反 ECMA-376 的子元素序列要求。
 */
export interface SpreadsheetPartTransform {
  readonly part_path: string;
  readonly root_attributes?: readonly XmlAttribute[];
  readonly children?: readonly string[];
}

/**
 * 包扩展：在"工作簿基础部件"之上追加的东西。
 *
 * 基础部件（`xl/workbook.xml`、`xl/styles.xml`、各 `xl/worksheets/sheetN.xml`）由
 * {@link composeWorkbookPackage} 用 `xlsx-write.ts` 的**既有导出函数**生成；
 * `parts` 是扩展模块自己的部件（图表 / 绘图 / 媒体 / 透视缓存……）。
 *
 * **关系的 r:id 由声明位置决定**（`relationshipIdAt`），因此扩展模块必须在声明前算清
 * 基础关系的条数——见 {@link workbookRelationshipId}。
 */
export interface SpreadsheetPackageExtension {
  readonly parts?: readonly OpcPart[];
  readonly content_type_defaults?: readonly ContentTypeDefault[];
  readonly relationships?: readonly RelationshipGroup[];
  readonly transforms?: readonly SpreadsheetPartTransform[];
}

/** 空扩展（只想拿到一份干净的基础工作簿时用）。 */
export const EMPTY_PACKAGE_EXTENSION: SpreadsheetPackageExtension = Object.freeze({});

/** 组装结果。 */
export interface SpreadsheetPackageResult {
  /** 真实容器字节（可写盘的 .xlsx）。 */
  readonly bytes: Buffer;
  readonly entry_count: number;
  readonly part_paths: readonly string[];
  /** 裸小写十六进制 sha256（真实容器字节）。 */
  readonly content_digest: string;
}

/**
 * 工作簿级关系里，第 `extraIndex`（0 起）条**扩展**声明会拿到的 r:id。
 *
 * 基础关系组的顺序是：各工作表（按模型顺序）→ 样式。因此扩展声明从
 * `sheets.length + 1` 号位开始编号。扩展模块必须在造 XML 时用本函数算 r:id，
 * 不能在写完之后猜。
 */
export function workbookRelationshipId(workbook: WorkbookState, extraIndex: number): string {
  return `rId${String(workbook.sheets.length + 1 + extraIndex + 1)}`;
}

/** 扩展声明能用的起始下标（= 工作表数 + 样式 1 条）。 */
export function workbookRelationshipCount(workbook: WorkbookState): number {
  return workbook.sheets.length + 1;
}

/** 公式求值缓存（键 `表名!A1`）——与 `xlsx-write.ts` 内部同口径。 */
function evaluationCache(workbook: WorkbookState): ReadonlyMap<string, EvalOutcome> {
  const cache = new Map<string, EvalOutcome>();
  for (const entry of evaluateWorkbookFormulas(workbook)) {
    const ref = `${columnNumberToLetters(entry.address.column)}${String(entry.address.row)}`;
    cache.set(`${entry.sheet}!${ref}`, entry.outcome);
  }
  return cache;
}

/** 根元素开标签的 `>` 下标（属性里的 `>` 已被转义成 `&gt;`，因此第一个 `>` 就是标签结束）。 */
function findRootOpenTagEnd(xml: string): number {
  const declarationEnd = xml.indexOf('?>');
  const start = xml.indexOf('<', declarationEnd === -1 ? 0 : declarationEnd + 2);
  /* c8 ignore next -- 生成器产出的部件一定有根元素；这是防御性分支 */
  if (start < 0) {
    throw new ValidationError('部件 XML 里找不到根元素');
  }
  const end = xml.indexOf('>', start);
  /* c8 ignore next -- 同上 */
  if (end < 0) {
    throw new ValidationError('部件 XML 的根元素开标签未闭合');
  }
  return end;
}

function applyTransform(xml: string, transform: SpreadsheetPartTransform | undefined): string {
  if (transform === undefined) return xml;
  let result = xml;

  const attributes = (transform.root_attributes ?? []).filter(
    (attribute) => !result.includes(` ${attribute.name}="`),
  );
  if (attributes.length > 0) {
    const at = findRootOpenTagEnd(result);
    const text = attributes
      .map((attribute) => ` ${attribute.name}="${escapeAttribute(attribute.value)}"`)
      .join('');
    result = `${result.slice(0, at)}${text}${result.slice(at)}`;
  }

  const children = transform.children ?? [];
  if (children.length > 0) {
    const closeAt = result.lastIndexOf('</');
    /* c8 ignore next -- 生成本模块部件时根元素一定有子元素 */
    if (closeAt < 0) {
      throw new ValidationError('部件 XML 的根元素是自闭合的，无法追加子元素');
    }
    result = `${result.slice(0, closeAt)}${children.join('')}${result.slice(closeAt)}`;
  }
  return result;
}

/**
 * 生成一份完整的 .xlsx：**既有写入器的产出 + 扩展模块的部件**。
 *
 * 复用清单（一个字节都不改既有文件）：
 * - `buildWorkbookXml` / `buildStylesXml` / `buildSheetXml`（`xlsx-write.ts` 的公开导出）
 * - `evaluateWorkbookFormulas`（公式缓存）
 * - `assembleOpcPackage` / `writeZip`（`src/artifacts/ooxml`）
 *
 * **不接受的输入**：`XlsxResidual`。带未知部件的既有文件请先用 `xlsx-read.ts` 读回、
 * 把要保留的部件作为 `extension.parts` 传进来（见 `objects.ts` 的 `readWorkbookObjects`）——
 * 本组装器不做 `mergeResidual` 的那套冲突消解，**宁可让调用方显式列出要保留什么**。
 *
 * @throws {ValidationError} 变换目标不是本组装器生成的部件 / 扩展部件与生成部件路径冲突
 * @throws {OpcError} 关系目标不存在、部件路径非法（由 `assembleOpcPackage` 判定）
 */
export function composeWorkbookPackage(
  workbook: WorkbookState,
  extension: SpreadsheetPackageExtension = EMPTY_PACKAGE_EXTENSION,
): SpreadsheetPackageResult {
  const evaluations = evaluationCache(workbook);
  const activeName = workbook.sheets[workbook.active_sheet]?.name;

  const transforms = new Map<string, SpreadsheetPartTransform>();
  for (const transform of extension.transforms ?? []) {
    if (transforms.has(transform.part_path)) {
      throw new ValidationError(`同一个部件被声明了两次变换：${transform.part_path}`);
    }
    transforms.set(transform.part_path, transform);
  }

  const baseParts: OpcPart[] = [
    {
      path: XLSX_WORKBOOK_PART_PATH,
      content_type: XLSX_MAIN_CONTENT_TYPE,
      data: applyTransform(buildWorkbookXml(workbook), transforms.get(XLSX_WORKBOOK_PART_PATH)),
    },
    {
      path: XLSX_STYLES_PART_PATH,
      content_type: XLSX_STYLES_CONTENT_TYPE,
      data: applyTransform(buildStylesXml(), transforms.get(XLSX_STYLES_PART_PATH)),
    },
  ];
  workbook.sheets.forEach((sheet, index) => {
    const path = worksheetPartPath(index);
    baseParts.push({
      path,
      content_type: XLSX_WORKSHEET_CONTENT_TYPE,
      data: applyTransform(
        buildSheetXml(sheet, evaluations, sheet.name === activeName),
        transforms.get(path),
      ),
    });
  });

  const generatedPaths = new Set(baseParts.map((part) => part.path));
  for (const path of transforms.keys()) {
    if (!generatedPaths.has(path)) {
      throw new ValidationError(
        `变换目标不是本组装器生成的部件（只能是 workbook/styles/worksheets）：${path}`,
      );
    }
  }

  const extensionParts = extension.parts ?? [];
  for (const part of extensionParts) {
    if (generatedPaths.has(part.path)) {
      throw new ValidationError(`扩展部件与生成部件路径冲突：${part.path}`);
    }
  }

  const groups: { owner_part_path: string | null; declarations: RelationshipDeclaration[] }[] = [
    {
      owner_part_path: null,
      declarations: [
        { type: OFFICE_DOCUMENT_RELATIONSHIP_TYPE, target: XLSX_WORKBOOK_PART_PATH },
      ],
    },
    {
      owner_part_path: XLSX_WORKBOOK_PART_PATH,
      declarations: [
        ...workbook.sheets.map((_sheet, index) => ({
          type: WORKSHEET_RELATIONSHIP_TYPE,
          target: `worksheets/sheet${String(index + 1)}.xml`,
        })),
        { type: STYLES_RELATIONSHIP_TYPE, target: 'styles.xml' },
      ],
    },
  ];
  for (const extra of extension.relationships ?? []) {
    const existing = groups.find((group) => group.owner_part_path === extra.owner_part_path);
    if (existing === undefined) {
      groups.push({ owner_part_path: extra.owner_part_path, declarations: [...extra.declarations] });
    } else {
      existing.declarations.push(...extra.declarations);
    }
  }

  const defaults: ContentTypeDefault[] = [
    { extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE },
  ];
  const seen = new Set(['rels']);
  for (const entry of extension.content_type_defaults ?? []) {
    if (seen.has(entry.extension)) continue;
    defaults.push(entry);
    seen.add(entry.extension);
  }

  const assembled = assembleOpcPackage({
    parts: [...baseParts, ...extensionParts],
    content_type_defaults: defaults,
    relationships: groups.map((group) => ({
      owner_part_path: group.owner_part_path,
      declarations: group.declarations,
    })),
  });

  const bytes = writeZip(assembled.entries);
  return Object.freeze({
    bytes,
    entry_count: assembled.entries.length,
    part_paths: Object.freeze(assembled.part_paths),
    content_digest: xlsxContentDigest(bytes),
  });
}

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

/** 五种常用图表（XLS-12 点名的那五种）。 */
export type ChartKind = 'column' | 'bar' | 'line' | 'pie' | 'scatter';

/** 图例位置。 */
export type LegendPosition = 'right' | 'left' | 'top' | 'bottom';

/**
 * 引用的**原始形态**（可选；没有它就是一个普通 A1 区域引用）。
 *
 * - `{ kind: 'table', table, column }`：结构化表格列引用（Excel 里的 `Table1[Amount]`）。
 *   表体是**动态**的——表随结构变化长大 / 收缩时，同一列引用的窗口跟着变。
 * - `{ kind: 'defined_name', name }`：定义名引用（Excel 里的 `Tax`）。
 *
 * 无论哪种形态，{@link ChartRangeRef.sheet} / {@link ChartRangeRef.range} 都**总是**给出
 * 解析后的具体 A1 窗口：校验、迁移、长度比对都作用在这份窗口上；`source` 只决定写进
 * `<c:f>` 的**文本形态**（见 {@link chartReferenceText}）。
 */
export type ChartReferenceSource =
  | { readonly kind: 'table'; readonly table: string; readonly column: string }
  | { readonly kind: 'defined_name'; readonly name: string };

/**
 * 一个**绑定到工作簿**的区域引用。
 *
 * 注意没有"数值数组"这种形态：XLS-12 要求图表数值绑定来源，本模块用类型封死硬编码数字。
 */
export interface ChartRangeRef {
  /** 工作表名（必须存在于工作簿）。 */
  readonly sheet: string;
  /** A1 记法的区域（如 `B2:B5`；单格写 `B1`）。 */
  readonly range: string;
  /** 原始形态（结构化表格列 / 定义名）；缺省 = 普通 A1 区域引用。 */
  readonly source?: ChartReferenceSource;
}

/** 一个数据系列：名称（可选）+ 分类（饼/柱/折线必需；散点当 X）+ 数值（必需）。 */
export interface ChartSeries {
  readonly name?: ChartRangeRef;
  readonly categories?: ChartRangeRef;
  readonly values: ChartRangeRef;
}

/** 坐标轴配置。 */
export interface ChartAxisConfig {
  readonly category_title?: string;
  readonly value_title?: string;
  readonly show_category_gridlines?: boolean;
  readonly show_value_gridlines?: boolean;
}

/** 样式配置。 */
export interface ChartStyle {
  /** Excel 内建图表样式号（1…48）。 */
  readonly variant?: number;
  /** 各系列的颜色（`RRGGBB`，不含 `#`）；按系列顺序取用，多出的忽略。 */
  readonly series_colors?: readonly string[];
  readonly show_data_labels?: boolean;
}

/** 位置 / 尺寸：两格锚点（1 起的行列号，A1 = `{ column: 1, row: 1 }`）。 */
export interface ChartAnchor {
  readonly from_column: number;
  readonly from_row: number;
  readonly to_column: number;
  readonly to_row: number;
}

/** 一张图表的完整状态（不可变）。 */
export interface ChartState {
  readonly name: string;
  readonly kind: ChartKind;
  readonly title: string | null;
  readonly series: readonly ChartSeries[];
  readonly axis: ChartAxisConfig;
  readonly legend: LegendPosition | null;
  readonly style: ChartStyle;
  readonly anchor: ChartAnchor;
}

/** 挂在一张工作表上的图表集合（不可变）。 */
export interface ChartSet {
  readonly sheet: string;
  readonly charts: readonly ChartState[];
}

/** 创建参数。 */
export interface ChartSpec {
  readonly name: string;
  readonly kind: ChartKind;
  readonly series: readonly ChartSeries[];
  readonly title?: string;
  readonly anchor?: ChartAnchor;
  readonly legend?: LegendPosition | null;
  readonly axis?: ChartAxisConfig;
  readonly style?: ChartStyle;
}

const CHART_KINDS: readonly ChartKind[] = Object.freeze([
  'column',
  'bar',
  'line',
  'pie',
  'scatter',
]);

const LEGEND_POSITIONS: readonly LegendPosition[] = Object.freeze(['right', 'left', 'top', 'bottom']);

const LEGEND_POSITION_CODE: Readonly<Record<LegendPosition, string>> = Object.freeze({
  right: 'r',
  left: 'l',
  top: 't',
  bottom: 'b',
});

/** 缺省锚点：C2 到 J17（1 起）。 */
export const DEFAULT_CHART_ANCHOR: ChartAnchor = Object.freeze({
  from_column: 3,
  from_row: 2,
  to_column: 10,
  to_row: 17,
});

// ---------------------------------------------------------------------------
// 引用校验（XLS-12「绑定工作簿来源」的执行点）
// ---------------------------------------------------------------------------

function requireNonEmpty(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${where} 不能是空字符串`);
  }
  return value;
}

/** 绝对引用文本：`$B$2`。 */
function absoluteAddress(address: { readonly column: number; readonly row: number }): string {
  return `$${columnNumberToLetters(address.column)}$${String(address.row)}`;
}

/** 区域 → `$B$2:$B$5`（单格 → `$B$2`）。 */
export function absoluteRangeText(range: CellRange): string {
  const start = absoluteAddress(range.start);
  const end = absoluteAddress(range.end);
  return start === end ? start : `${start}:${end}`;
}

/** 结构化引用里列名的转义：Excel 用前导单引号转义 `'`、`[`、`]`、`#`、`@`。 */
function escapeStructuredColumnName(name: string): string {
  return name.replace(/['[\]@#]/g, (ch) => `'${ch}`);
}

/**
 * 区域 → 图表公式里的引用文本：`'预算'!$B$2:$B$5`。
 *
 * 表名**一律加单引号**（Excel 对含空格 / 中文 / 标点的表名要求如此，统一加不会错），
 * 名字里的单引号按 Excel 的约定转义成两个连续单引号。
 *
 * 带 {@link ChartRangeRef.source} 的引用写它的**原始形态**——结构化表格列写
 * `Table1[Amount]`（列名里的 `'`/`[`/`]`/`#`/`@` 按 Excel 口径转义），定义名写名字本身。
 * 这是 Excel 对表 / 名绑定图表的实际写法：引用跟着表 / 名字走，而不是把某一次的具体区域钉死。
 */
export function chartReferenceText(ref: ChartRangeRef): string {
  if (ref.source !== undefined) {
    return ref.source.kind === 'table'
      ? `${ref.source.table}[${escapeStructuredColumnName(ref.source.column)}]`
      : ref.source.name;
  }
  const sheet = ref.sheet.replace(/'/g, "''");
  return `'${sheet}'!${absoluteRangeText(parseRange(ref.range))}`;
}

/**
 * 结构化表格列引用：把 `Table[Column]` 解析成该列**数据体**（标题行与汇总行之间）的窗口。
 *
 * `range` 存解析后的 A1 窗口（表体随结构变化迁移时跟着变），`source` 存原始形态，
 * 写 `<c:f>` 时输出 `Table[Column]`。
 *
 * @throws {ValidationError} 表里没有该列 / 该列没有数据行（表只有标题行）
 */
export function structuredTableReference(
  table: StructuredTable,
  sheet: string,
  column: string,
): ChartRangeRef {
  const sheetName = requireNonEmpty(sheet, 'structuredTableReference.sheet');
  const columnName = requireNonEmpty(column, 'structuredTableReference.column');
  const position = tableColumnPosition(table, columnName);
  if (position === undefined) {
    throw new ValidationError(`表 ${table.name} 没有列 ${JSON.stringify(columnName)}`);
  }
  const whole = parseRange(table.range);
  const bodyStart = whole.start.row + table.header_row_count;
  const bodyEnd = whole.end.row - table.totals_row_count;
  if (bodyEnd < bodyStart) {
    throw new ValidationError(
      `表 ${table.name} 的列 ${JSON.stringify(columnName)} 没有数据行（表只有标题行` +
        `${table.totals_row_count === 1 ? '与汇总行' : ''}）：图表系列必须有数值来源`,
    );
  }
  const letter = columnNumberToLetters(position.column);
  const range = `${letter}${String(bodyStart)}:${letter}${String(bodyEnd)}`;
  return Object.freeze({
    sheet: sheetName,
    range,
    source: Object.freeze({ kind: 'table' as const, table: table.name, column: columnName }),
  });
}

/**
 * 定义名引用：把一个命名引用（{@link NamedReference}）解析成图表引用。
 *
 * `definition.sheet === null` 的（相对使用表的）定义名用 `default_sheet` 绑定到具体表；
 * `range` 存定义名当前的目标区域，`source` 存名字，写 `<c:f>` 时输出名字本身。
 *
 * @throws {ValidationError} 无法确定工作表 / `definition.ref` 不是合法区域
 */
export function definedNameReference(
  definition: NamedReference,
  default_sheet: string,
): ChartRangeRef {
  const name = requireNonEmpty(definition.name, 'definedNameReference.name');
  const sheet =
    definition.sheet === null
      ? requireNonEmpty(default_sheet, 'definedNameReference.default_sheet')
      : requireNonEmpty(definition.sheet, 'definedNameReference.sheet');
  const range = formatRange(parseRange(definition.ref));
  return Object.freeze({
    sheet,
    range,
    source: Object.freeze({ kind: 'defined_name' as const, name }),
  });
}

function isSingleColumn(range: CellRange): boolean {
  return range.start.column === range.end.column;
}

function isSingleRow(range: CellRange): boolean {
  return range.start.row === range.end.row;
}

/**
 * 校验并归一化一个引用：表必须存在、区域必须落在该表的声明范围内、必须是一维（单行或单列）。
 *
 * @throws {ValidationError} 任一条不满足（**显式失败，不静默降级**）
 */
export function validateChartReference(
  workbook: WorkbookState,
  ref: ChartRangeRef,
  where: string,
): ChartRangeRef {
  const sheetName = requireNonEmpty(ref.sheet, `${where}.sheet`);
  const sheet = getSheet(workbook, sheetName);
  if (sheet === undefined) {
    throw new ValidationError(`${where} 引用了工作簿里不存在的工作表 ${JSON.stringify(sheetName)}`);
  }
  const range = parseRange(requireNonEmpty(ref.range, `${where}.range`));
  if (range.end.row > sheet.row_count || range.end.column > sheet.column_count) {
    throw new ValidationError(
      `${where} 的区域 ${JSON.stringify(ref.range)} 超出工作表 ${JSON.stringify(sheetName)} 的范围` +
        `（该表声明 ${columnNumberToLetters(sheet.column_count)}${String(sheet.row_count)} 内）`,
    );
  }
  if (!isSingleColumn(range) && !isSingleRow(range)) {
    throw new ValidationError(
      `${where} 的区域 ${JSON.stringify(ref.range)} 不是一维区域（图表系列只能绑单行或单列的连续区域）`,
    );
  }
  const source = validateReferenceSource(ref.source, where);
  return Object.freeze({
    sheet: sheetName,
    range: absoluteRangeText(range).replace(/\$/g, ''),
    ...(source === undefined ? {} : { source }),
  });
}

/** 校验并归一化引用的原始形态（结构化表格列 / 定义名）；缺省原样返回 `undefined`。@throws {ValidationError} */
function validateReferenceSource(
  source: ChartReferenceSource | undefined,
  where: string,
): ChartReferenceSource | undefined {
  if (source === undefined) return undefined;
  if (source.kind === 'table') {
    return Object.freeze({
      kind: 'table' as const,
      table: requireNonEmpty(source.table, `${where}.source.table`),
      column: requireNonEmpty(source.column, `${where}.source.column`),
    });
  }
  if (source.kind === 'defined_name') {
    return Object.freeze({
      kind: 'defined_name' as const,
      name: requireNonEmpty(source.name, `${where}.source.name`),
    });
  }
  /* c8 ignore next -- 判别联合已封闭 */
  throw new ValidationError(`${where}.source 的形态未知`);
}

/** 区域长度（单行 / 单列的格数）。 */
function rangeLength(range: CellRange): number {
  return isSingleColumn(range) ? range.end.row - range.start.row + 1 : range.end.column - range.start.column + 1;
}

function validateSeries(workbook: WorkbookState, series: ChartSeries, index: number): ChartSeries {
  const where = `series[${String(index)}]`;
  const values = validateChartReference(workbook, series.values, `${where}.values`);
  const categories =
    series.categories === undefined
      ? undefined
      : validateChartReference(workbook, series.categories, `${where}.categories`);
  if (categories !== undefined && rangeLength(parseRange(categories.range)) !== rangeLength(parseRange(values.range))) {
    throw new ValidationError(
      `${where} 的分类区域与数值区域长度不一致（${categories.range} vs ${values.range}）：` +
        '每个数值必须有一个对应的分类',
    );
  }
  const name =
    series.name === undefined
      ? undefined
      : validateChartReference(workbook, series.name, `${where}.name`);
  return Object.freeze({
    ...(name === undefined ? {} : { name }),
    ...(categories === undefined ? {} : { categories }),
    values,
  });
}

/** 逐系列校验（创建 / 改数据 / 写出前都走这一条）。@throws {ValidationError} */
export function validateChartReferences(workbook: WorkbookState, chart: ChartState): void {
  if (chart.series.length === 0) {
    throw new ValidationError(`图表 ${JSON.stringify(chart.name)} 没有任何数据系列：图表数值必须绑定工作簿来源`);
  }
  chart.series.forEach((series, index) => {
    validateSeries(workbook, series, index);
  });
  if (chart.kind === 'scatter') {
    chart.series.forEach((series, index) => {
      if (series.categories === undefined) {
        throw new ValidationError(
          `散点图的 series[${String(index)}] 缺少 X 值（categories）：散点图需要两条数值轴`,
        );
      }
    });
  }
  if (chart.kind === 'pie' && chart.series.length !== 1) {
    throw new ValidationError('饼图只能有一个数据系列（多个系列在饼图上没有可视化含义）');
  }
}

// ---------------------------------------------------------------------------
// 源表结构变化时的引用同步（XLS-12「源表变化同步图表」）
// ---------------------------------------------------------------------------

/**
 * 一次**源工作表**的结构变化（行列插入 / 删除）。
 *
 * `at` 是 1 起的行号 / 列号，`count` 是插入 / 删除的行数 / 列数；语义与
 * `sheet.ts` 的 `insertRows` / `deleteRows` / `insertColumns` / `deleteColumns` 对齐。
 */
export type StructuralEdit =
  | { readonly kind: 'insert_rows'; readonly at: number; readonly count: number }
  | { readonly kind: 'delete_rows'; readonly at: number; readonly count: number }
  | { readonly kind: 'insert_columns'; readonly at: number; readonly count: number }
  | { readonly kind: 'delete_columns'; readonly at: number; readonly count: number };

/** 引用同步过程中发生的一处降级（**不静默**：调用方能看到哪个系列被丢了 / 窗口缩了）。 */
export interface ChartRetargetWarning {
  /** `series_dropped`：整个系列被删（它的数值 / 分类区域被删光了）。 */
  readonly code: 'series_dropped' | 'reference_window_shrunk';
  readonly series_index: number;
  readonly detail: string;
}

/** 单张图表的同步结果：要么改后仍在（retargeted），要么绑不到任何系列（removed）。 */
export type ChartRetargetOutcome =
  | {
      readonly kind: 'retargeted';
      readonly chart: ChartState;
      readonly warnings: readonly ChartRetargetWarning[];
    }
  | {
      readonly kind: 'removed';
      readonly chart_name: string;
      readonly warnings: readonly ChartRetargetWarning[];
    };

/** 整个图表集合的同步结果。 */
export interface ChartSetRetargetOutcome {
  /** 改后仍在的图表组成的新集合（去掉被删的图）。 */
  readonly set: ChartSet;
  /** 被删掉的图表名（空集 = 没有图表被删）。 */
  readonly removed: readonly string[];
  readonly warnings: readonly ChartRetargetWarning[];
}

function assertStructuralEdit(edit: StructuralEdit): void {
  if (!Number.isInteger(edit.at) || edit.at < 1) {
    throw new ValidationError(`结构变化 at 必须是 ≥1 的整数，收到 ${String(edit.at)}`);
  }
  if (!Number.isInteger(edit.count) || edit.count < 1) {
    throw new ValidationError(`结构变化 count 必须是 ≥1 的整数，收到 ${String(edit.count)}`);
  }
}

const ROW_AXIS: ReadonlySet<StructuralEdit['kind']> = new Set(['insert_rows', 'delete_rows']);

/**
 * 把一个区域沿被编辑的轴迁移；区域被删光 ⇒ `null`。
 *
 * - 插入：端点 **≥ `at`** 的平移到 `+count`；跨过 `at` 的范围因此**变长**（含新插入的行 / 列）。
 * - 删除：落在删除区间的端点**塌缩**到边界；`新end < 新start` ⇒ 区域整个没了。
 */
function migrateRangeOnEdit(range: CellRange, edit: StructuralEdit): CellRange | null {
  const onRowAxis = ROW_AXIS.has(edit.kind);
  const start = onRowAxis ? range.start.row : range.start.column;
  const end = onRowAxis ? range.end.row : range.end.column;
  const inserting = edit.kind === 'insert_rows' || edit.kind === 'insert_columns';
  const last = edit.at + edit.count - 1;

  let nextStart: number;
  let nextEnd: number;
  if (inserting) {
    nextStart = start >= edit.at ? start + edit.count : start;
    nextEnd = end >= edit.at ? end + edit.count : end;
  } else {
    // 删除：区间内塌缩到 at；区间后上移 count；区间前不动。
    nextStart = start < edit.at ? start : start > last ? start - edit.count : edit.at;
    nextEnd = end < edit.at ? end : end > last ? end - edit.count : edit.at - 1;
  }
  if (nextEnd < nextStart) {
    return null;
  }
  if (onRowAxis) {
    return { start: { ...range.start, row: nextStart }, end: { ...range.end, row: nextEnd } };
  }
  return { start: { ...range.start, column: nextStart }, end: { ...range.end, column: nextEnd } };
}

/**
 * 迁移一个引用；`null` = 该引用被这次编辑删掉了。非目标表的引用原样返回。
 *
 * 结构化表格列 / 定义名引用走**同一套迁移**：表体 / 名字目标动，解析后的 A1 窗口跟着动，
 * `source` 原样带上——它的原始形态不因结构性编辑而改变（`Table1[Amount]` 还是同一个引用）。
 */
function migrateChartRef(ref: ChartRangeRef, sheet: string, edit: StructuralEdit): ChartRangeRef | null {
  if (ref.sheet !== sheet) return ref;
  const migrated = migrateRangeOnEdit(parseRange(ref.range), edit);
  if (migrated === null) return null;
  return Object.freeze({
    sheet: ref.sheet,
    range: formatRange(migrated),
    ...(ref.source === undefined ? {} : { source: ref.source }),
  });
}

/**
 * **源表结构变化后同步一张图表**：把引用该表的全部系列区域按行 / 列插入、删除迁移。
 *
 * 只迁移 `sheet` 匹配的引用；指向其它表的引用不动。任一必需引用（数值 / 分类 / 名称）
 * 被删光 ⇒ 整个系列**被删**并记 `warnings`（该系列已没有数据来源，留着就是悬挂引用）。
 * 全部系列被删 ⇒ 结果 `kind: 'removed'`（图表已无绑定，调用方应移除它，而不是留一张空图）。
 *
 * **结构化表格列 / 定义名引用走同一套规则**（{@link ChartRangeRef.source}）：引用按其
 * **解析后的 A1 窗口**迁移（前插下移、内插变长、删光删系列、跨表不动），`source` 原样保留，
 * 因此 `<c:f>` 里仍是 `Table1[Amount]` / `Tax`——表 / 名字动，引用跟着动。
 *
 * `workbook` 必须是**编辑之后**的工作簿：迁移结果会用 {@link validateChartReferences}
 * 在它上面实测一遍，迁移若越出新的声明范围会当场报错。
 *
 * @throws {ValidationError} edit 参数非法 / 迁移后引用超出工作簿
 */
export function retargetChartReferences(
  workbook: WorkbookState,
  chart: ChartState,
  sheet: string,
  edit: StructuralEdit,
): ChartRetargetOutcome {
  assertStructuralEdit(edit);
  const warnings: ChartRetargetWarning[] = [];
  const series: ChartSeries[] = [];

  chart.series.forEach((item, index) => {
    const values = migrateChartRef(item.values, sheet, edit);
    const categories = item.categories === undefined ? undefined : migrateChartRef(item.categories, sheet, edit);
    const name = item.name === undefined ? undefined : migrateChartRef(item.name, sheet, edit);
    if (
      values === null ||
      (item.categories !== undefined && categories === null) ||
      (item.name !== undefined && name === null)
    ) {
      warnings.push({
        code: 'series_dropped',
        series_index: index,
        detail: `series[${String(index)}] 的数据 / 分类区域在 ${edit.kind} 后不复存在`,
      });
      return;
    }
    if (name !== undefined && name !== null) {
      series.push(
        Object.freeze({
          values,
          name,
          ...(categories === undefined || categories === null ? {} : { categories }),
        }),
      );
      return;
    }
    series.push(
      Object.freeze({
        values,
        ...(categories === undefined || categories === null ? {} : { categories }),
      }),
    );
  });

  if (series.length === 0) {
    return Object.freeze({ kind: 'removed', chart_name: chart.name, warnings: Object.freeze(warnings) });
  }

  const next = Object.freeze({ ...chart, series: Object.freeze(series) });
  validateChartReferences(workbook, next);
  return Object.freeze({ kind: 'retargeted', chart: next, warnings: Object.freeze(warnings) });
}

/**
 * 同步**一个图表集合**里每一张图：被删光的图从集合里移除，其余保留新状态。
 *
 * @throws {ValidationError} 与 {@link retargetChartReferences} 同
 */
export function retargetChartSet(
  workbook: WorkbookState,
  set: ChartSet,
  edit: StructuralEdit,
): ChartSetRetargetOutcome {
  const kept: ChartState[] = [];
  const removed: string[] = [];
  const warnings: ChartRetargetWarning[] = [];
  for (const chart of set.charts) {
    const outcome = retargetChartReferences(workbook, chart, set.sheet, edit);
    warnings.push(...outcome.warnings);
    if (outcome.kind === 'removed') {
      removed.push(outcome.chart_name);
    } else {
      kept.push(outcome.chart);
    }
  }
  return Object.freeze({
    set: Object.freeze({ sheet: set.sheet, charts: Object.freeze(kept) }),
    removed: Object.freeze(removed),
    warnings: Object.freeze(warnings),
  });
}

// ---------------------------------------------------------------------------
// 操作（全部不可变）
// ---------------------------------------------------------------------------

function validateAnchor(anchor: ChartAnchor): ChartAnchor {
  const fields: readonly (readonly [number, string])[] = [
    [anchor.from_column, 'from_column'],
    [anchor.from_row, 'from_row'],
    [anchor.to_column, 'to_column'],
    [anchor.to_row, 'to_row'],
  ];
  for (const [value, field] of fields) {
    if (!Number.isInteger(value) || value < 1) {
      throw new ValidationError(`锚点 ${field} 必须是 ≥1 的整数，收到 ${String(value)}`);
    }
  }
  if (anchor.to_column <= anchor.from_column || anchor.to_row <= anchor.from_row) {
    throw new ValidationError(
      '锚点必须右下大于左上（to_column > from_column 且 to_row > from_row）：否则图表没有尺寸',
    );
  }
  return Object.freeze({ ...anchor });
}

function validateStyle(style: ChartStyle): ChartStyle {
  if (style.variant !== undefined && (!Number.isInteger(style.variant) || style.variant < 1 || style.variant > 48)) {
    throw new ValidationError(`图表样式号必须是 1…48 的整数，收到 ${String(style.variant)}`);
  }
  for (const color of style.series_colors ?? []) {
    if (!/^[0-9A-Fa-f]{6}$/.test(color)) {
      throw new ValidationError(`系列颜色必须是 6 位十六进制 RRGGBB（不含 #）：${JSON.stringify(color)}`);
    }
  }
  return Object.freeze({
    ...(style.variant === undefined ? {} : { variant: style.variant }),
    ...(style.series_colors === undefined ? {} : { series_colors: Object.freeze([...style.series_colors]) }),
    ...(style.show_data_labels === undefined ? {} : { show_data_labels: style.show_data_labels }),
  });
}

function validateAxis(axis: ChartAxisConfig): ChartAxisConfig {
  return Object.freeze({
    ...(axis.category_title === undefined ? {} : { category_title: axis.category_title }),
    ...(axis.value_title === undefined ? {} : { value_title: axis.value_title }),
    ...(axis.show_category_gridlines === undefined
      ? {}
      : { show_category_gridlines: axis.show_category_gridlines }),
    ...(axis.show_value_gridlines === undefined ? {} : { show_value_gridlines: axis.show_value_gridlines }),
  });
}

/** 创建一张图表（引用当场校验）。@throws {ValidationError} 名称 / 类型 / 引用 / 锚点 / 样式非法 */
export function createChart(workbook: WorkbookState, spec: ChartSpec): ChartState {
  const name = requireNonEmpty(spec.name, 'chart.name');
  if (!CHART_KINDS.includes(spec.kind)) {
    throw new ValidationError(`未知的图表类型 ${JSON.stringify(spec.kind)}（支持 ${CHART_KINDS.join(' / ')}）`);
  }
  const legend = spec.legend === undefined ? 'right' : spec.legend;
  if (legend !== null && !LEGEND_POSITIONS.includes(legend)) {
    throw new ValidationError(`未知的图例位置 ${JSON.stringify(legend)}`);
  }
  const chart: ChartState = Object.freeze({
    name,
    kind: spec.kind,
    title: spec.title === undefined ? null : spec.title,
    series: Object.freeze([...spec.series]),
    axis: validateAxis(spec.axis ?? {}),
    legend,
    style: validateStyle(spec.style ?? {}),
    anchor: validateAnchor(spec.anchor ?? DEFAULT_CHART_ANCHOR),
  });
  validateChartReferences(workbook, chart);
  return chart;
}

/** 改类型。@throws {ValidationError} */
export function setChartKind(chart: ChartState, kind: ChartKind): ChartState {
  if (!CHART_KINDS.includes(kind)) {
    throw new ValidationError(`未知的图表类型 ${JSON.stringify(kind)}`);
  }
  return Object.freeze({ ...chart, kind });
}

/** 改数据（引用当场校验：改完必须仍然绑定在工作簿上）。@throws {ValidationError} */
export function setChartData(
  workbook: WorkbookState,
  chart: ChartState,
  series: readonly ChartSeries[],
): ChartState {
  const next = Object.freeze({
    ...chart,
    series: Object.freeze(series.map((item, index) => validateSeries(workbook, item, index))),
  });
  validateChartReferences(workbook, next);
  return next;
}

/** 改标题（`null` = 删掉标题）。 */
export function setChartTitle(chart: ChartState, title: string | null): ChartState {
  return Object.freeze({ ...chart, title });
}

/** 改坐标轴配置。@throws {ValidationError} */
export function setChartAxis(chart: ChartState, axis: ChartAxisConfig): ChartState {
  return Object.freeze({ ...chart, axis: validateAxis(axis) });
}

/** 改图例（`null` = 不显示图例）。@throws {ValidationError} */
export function setChartLegend(chart: ChartState, position: LegendPosition | null): ChartState {
  if (position !== null && !LEGEND_POSITIONS.includes(position)) {
    throw new ValidationError(`未知的图例位置 ${JSON.stringify(position)}`);
  }
  return Object.freeze({ ...chart, legend: position });
}

/** 改样式。@throws {ValidationError} */
export function setChartStyle(chart: ChartState, style: ChartStyle): ChartState {
  return Object.freeze({ ...chart, style: validateStyle(style) });
}

/** 改位置 / 尺寸。@throws {ValidationError} */
export function setChartAnchor(chart: ChartState, anchor: ChartAnchor): ChartState {
  return Object.freeze({ ...chart, anchor: validateAnchor(anchor) });
}

/** 重命名（同集合内重名由 {@link replaceChart} 拒绝）。@throws {ValidationError} */
export function renameChart(chart: ChartState, name: string): ChartState {
  return Object.freeze({ ...chart, name: requireNonEmpty(name, 'chart.name') });
}

// ---------------------------------------------------------------------------
// 集合操作
// ---------------------------------------------------------------------------

/** 建一个空集合（表必须存在）。@throws {ValidationError} */
export function createChartSet(workbook: WorkbookState, sheet: string): ChartSet {
  if (getSheet(workbook, sheet) === undefined) {
    throw new ValidationError(`createChartSet：工作簿里没有工作表 ${JSON.stringify(sheet)}`);
  }
  return Object.freeze({ sheet, charts: Object.freeze([] as ChartState[]) });
}

/** 查图表；不存在返回 `undefined`。 */
export function findChart(set: ChartSet, name: string): ChartState | undefined {
  return set.charts.find((chart) => chart.name === name);
}

/** 追加一张图表（重名 ⇒ 抛）。@throws {ValidationError} */
export function addChart(set: ChartSet, chart: ChartState): ChartSet {
  if (findChart(set, chart.name) !== undefined) {
    throw new ValidationError(`addChart 拒绝重名：集合里已有图表 ${JSON.stringify(chart.name)}`);
  }
  return Object.freeze({ sheet: set.sheet, charts: Object.freeze([...set.charts, chart]) });
}

/** 用新状态替换同名图表；不存在 ⇒ 抛。@throws {ValidationError} */
export function replaceChart(set: ChartSet, chart: ChartState): ChartSet {
  if (findChart(set, chart.name) === undefined) {
    throw new ValidationError(`replaceChart：集合里没有图表 ${JSON.stringify(chart.name)}`);
  }
  return Object.freeze({
    sheet: set.sheet,
    charts: Object.freeze(set.charts.map((item) => (item.name === chart.name ? chart : item))),
  });
}

/** 删除图表；不存在 ⇒ 抛（**不静默成功**：调用方必须知道删的是不是真存在）。@throws {ValidationError} */
export function deleteChart(set: ChartSet, name: string): ChartSet {
  if (findChart(set, name) === undefined) {
    throw new ValidationError(`deleteChart：集合里没有图表 ${JSON.stringify(name)}`);
  }
  return Object.freeze({
    sheet: set.sheet,
    charts: Object.freeze(set.charts.filter((chart) => chart.name !== name)),
  });
}

/** 图表引用到的全部区域（读回 / 审计用）。 */
export function chartReferences(chart: ChartState): readonly ChartRangeRef[] {
  const refs: ChartRangeRef[] = [];
  for (const series of chart.series) {
    if (series.name !== undefined) refs.push(series.name);
    if (series.categories !== undefined) refs.push(series.categories);
    refs.push(series.values);
  }
  return Object.freeze(refs);
}

// ---------------------------------------------------------------------------
// XML：图表部件
// ---------------------------------------------------------------------------

function chartNamespaces(): readonly XmlAttribute[] {
  return [
    attr('xmlns:c', DRAWINGML_CHART_NAMESPACE),
    attr('xmlns:a', DRAWINGML_MAIN_NAMESPACE),
    attr('xmlns:r', OFFICE_RELATIONSHIPS_NAMESPACE),
  ];
}

function referenceFormulaElement(ref: ChartRangeRef, textTag: 'c:strRef' | 'c:numRef'): XmlElement {
  return el(textTag, [], [el('c:f', [], [chartReferenceText(ref)])]);
}

function titleElement(text: string): XmlElement {
  return el('c:title', [], [
    el('c:tx', [], [
      el('c:rich', [], [
        el('a:bodyPr', []),
        el('a:lstStyle', []),
        el('a:p', [], [el('a:r', [], [el('a:t', [], [text])])]),
      ]),
    ]),
    el('c:overlay', [attr('val', '0')]),
  ]);
}

function seriesElement(chart: ChartState, series: ChartSeries, index: number): XmlElement {
  const children: XmlNode[] = [
    el('c:idx', [attr('val', String(index))]),
    el('c:order', [attr('val', String(index))]),
  ];
  if (series.name !== undefined) {
    children.push(el('c:tx', [], [referenceFormulaElement(series.name, 'c:strRef')]));
  }
  const color = chart.style.series_colors?.[index];
  if (color !== undefined) {
    children.push(
      el('c:spPr', [], [
        el('a:solidFill', [], [el('a:srgbClr', [attr('val', color.toUpperCase())])]),
      ]),
    );
  }
  if (chart.kind === 'line' || chart.kind === 'scatter') {
    children.push(el('c:marker', [], [el('c:symbol', [attr('val', 'none')])]));
  }
  if (chart.style.show_data_labels === true) {
    children.push(el('c:dLbls', [], [el('c:showVal', [attr('val', '1')])]));
  }
  if (chart.kind === 'scatter') {
    const x = series.categories;
    /* c8 ignore next -- validateChartReferences 已保证散点系列必有 X 值；此处是类型收敛 */
    if (x === undefined) {
      throw new ValidationError(`散点图的 series[${String(index)}] 缺少 X 值引用`);
    }
    children.push(
      el('c:xVal', [], [referenceFormulaElement(x, 'c:numRef')]),
      el('c:yVal', [], [referenceFormulaElement(series.values, 'c:numRef')]),
    );
  } else {
    if (series.categories !== undefined) {
      children.push(el('c:cat', [], [referenceFormulaElement(series.categories, 'c:strRef')]));
    }
    children.push(el('c:val', [], [referenceFormulaElement(series.values, 'c:numRef')]));
  }
  return el('c:ser', [], children);
}

/** 坐标轴（`c:catAx` / `c:valAx` 的子元素序列完全一致）。 */
function axisElement(
  tag: 'c:catAx' | 'c:valAx',
  axisId: number,
  crossAxisId: number,
  position: 'b' | 'l',
  title: string | undefined,
  gridlines: boolean,
): XmlElement {
  const children: XmlNode[] = [
    el('c:axId', [attr('val', String(axisId))]),
    el('c:scaling', [], [el('c:orientation', [attr('val', 'minMax')])]),
    el('c:delete', [attr('val', '0')]),
    el('c:axPos', [attr('val', position)]),
  ];
  if (gridlines) {
    children.push(el('c:majorGridlines', []));
  }
  if (title !== undefined) {
    children.push(titleElement(title));
  }
  children.push(
    el('c:crossAx', [attr('val', String(crossAxisId))]),
    el('c:crosses', [attr('val', 'autoZero')]),
    el('c:auto', [attr('val', '1')]),
  );
  return el(tag, [], children);
}

function plotChartGroup(chart: ChartState): XmlElement {
  const series = chart.series.map((item, index) => seriesElement(chart, item, index));
  switch (chart.kind) {
    case 'column':
    case 'bar':
      return el('c:barChart', [], [
        el('c:barDir', [attr('val', chart.kind === 'bar' ? 'bar' : 'col')]),
        el('c:grouping', [attr('val', 'clustered')]),
        el('c:varyColors', [attr('val', '0')]),
        ...series,
        el('c:axId', [attr('val', '1')]),
        el('c:axId', [attr('val', '2')]),
      ]);
    case 'line':
      return el('c:lineChart', [], [
        el('c:grouping', [attr('val', 'standard')]),
        ...series,
        el('c:axId', [attr('val', '1')]),
        el('c:axId', [attr('val', '2')]),
      ]);
    case 'pie':
      return el('c:pieChart', [], [el('c:varyColors', [attr('val', '1')]), ...series]);
    case 'scatter':
      return el('c:scatterChart', [], [
        el('c:scatterStyle', [attr('val', 'lineMarker')]),
        el('c:varyColors', [attr('val', '0')]),
        ...series,
        el('c:axId', [attr('val', '1')]),
        el('c:axId', [attr('val', '2')]),
      ]);
    default: {
      const never: never = chart.kind;
      throw new ValidationError(`未覆盖的图表类型：${String(never)}`);
    }
  }
}

function plotAreaElement(chart: ChartState): XmlElement {
  const children: XmlNode[] = [el('c:layout', []), plotChartGroup(chart)];
  if (chart.kind === 'bar' || chart.kind === 'column' || chart.kind === 'line') {
    children.push(
      axisElement(
        'c:catAx',
        1,
        2,
        'b',
        chart.axis.category_title,
        chart.axis.show_category_gridlines === true,
      ),
      axisElement('c:valAx', 2, 1, 'l', chart.axis.value_title, chart.axis.show_value_gridlines === true),
    );
  } else if (chart.kind === 'scatter') {
    children.push(
      axisElement('c:valAx', 1, 2, 'b', chart.axis.category_title, chart.axis.show_category_gridlines === true),
      axisElement('c:valAx', 2, 1, 'l', chart.axis.value_title, chart.axis.show_value_gridlines === true),
    );
  }
  return el('c:plotArea', [], children);
}

/**
 * 生成 `xl/charts/chartN.xml` 文本。
 *
 * **不写 `<c:numCache>` / `<c:strCache>`**：系列数值只有 `<c:f>` 一条路通往工作簿。
 * 这就是 XLS-12「图表数值必须绑定工作簿来源」在字节层的形状——图表文件里**没有**
 * 任何一次性的数字副本。
 *
 * @throws {ValidationError} 模型不合法（构造期已挡，这里是纵深防御）
 */
export function buildChartXml(chart: ChartState): string {
  const chartChildren: XmlNode[] = [];
  if (chart.title !== null) {
    chartChildren.push(titleElement(chart.title));
  } else {
    chartChildren.push(el('c:autoTitleDeleted', [attr('val', '1')]));
  }
  chartChildren.push(plotAreaElement(chart));
  if (chart.legend !== null) {
    chartChildren.push(
      el('c:legend', [], [
        el('c:legendPos', [attr('val', LEGEND_POSITION_CODE[chart.legend])]),
        el('c:overlay', [attr('val', '0')]),
      ]),
    );
  }
  chartChildren.push(el('c:plotVisOnly', [attr('val', '1')]), el('c:dispBlanksAs', [attr('val', 'gap')]));

  const children: XmlNode[] = [];
  if (chart.style.variant !== undefined) {
    children.push(el('c:style', [attr('val', String(chart.style.variant))]));
  }
  children.push(el('c:chart', [], chartChildren));

  return serializeXmlDocument(el('c:chartSpace', chartNamespaces(), children));
}

// ---------------------------------------------------------------------------
// XML：绘图部件
// ---------------------------------------------------------------------------

function anchorEdge(tag: 'xdr:from' | 'xdr:to', column: number, row: number): XmlElement {
  return el(tag, [], [
    el('xdr:col', [], [String(column - 1)]),
    el('xdr:colOff', [], ['0']),
    el('xdr:row', [], [String(row - 1)]),
    el('xdr:rowOff', [], ['0']),
  ]);
}

function chartGraphicFrame(chart: ChartState, index: number, relationshipId: string): XmlElement {
  return el('xdr:twoCellAnchor', [], [
    anchorEdge('xdr:from', chart.anchor.from_column, chart.anchor.from_row),
    anchorEdge('xdr:to', chart.anchor.to_column, chart.anchor.to_row),
    el('xdr:graphicFrame', [attr('macro', '')], [
      el('xdr:nvGraphicFramePr', [], [
        el('xdr:cNvPr', [attr('id', String(index + 2)), attr('name', chart.name)]),
        el('xdr:cNvGraphicFramePr', []),
      ]),
      el('xdr:xfrm', [], [el('a:off', [attr('x', '0'), attr('y', '0')]), el('a:ext', [attr('cx', '0'), attr('cy', '0')])]),
      el('a:graphic', [], [
        el('a:graphicData', [attr('uri', DRAWINGML_CHART_NAMESPACE)], [
          el('c:chart', [
            attr('xmlns:c', DRAWINGML_CHART_NAMESPACE),
            attr('xmlns:r', OFFICE_RELATIONSHIPS_NAMESPACE),
            attr('r:id', relationshipId),
          ]),
        ]),
      ]),
    ]),
    el('xdr:clientData', []),
  ]);
}

/**
 * 生成 `xl/drawings/drawingN.xml` 文本。
 *
 * `chartRelationshipIds` 是**每个图表的绘图级关系 id**（按 `charts` 顺序），由调用方用
 * `relationshipIdAt(i)` 给出——因为绘图自己的关系部件是由组装器按声明顺序生成的。
 */
export function buildDrawingXml(
  charts: readonly ChartState[],
  chartRelationshipIds: readonly string[],
): string {
  if (charts.length !== chartRelationshipIds.length) {
    throw new ValidationError('图表数与绘图关系 id 数不一致：每个图表必须有一条 drawing → chart 关系');
  }
  const anchors = charts.map((chart, index) => {
    const relationshipId = chartRelationshipIds[index] as string;
    return chartGraphicFrame(chart, index, relationshipId);
  });
  return serializeXmlDocument(
    el(
      'xdr:wsDr',
      [attr('xmlns:xdr', SPREADSHEET_DRAWING_NAMESPACE), attr('xmlns:a', DRAWINGML_MAIN_NAMESPACE)],
      anchors,
    ),
  );
}

// ---------------------------------------------------------------------------
// 写到 .xlsx
// ---------------------------------------------------------------------------

/** 图表集合 → 包扩展（部件 + 关系 + 工作表尾部改写）。 */
function chartExtension(workbook: WorkbookState, sets: readonly ChartSet[]): SpreadsheetPackageExtension {
  const parts: OpcPart[] = [];
  const relationships: RelationshipGroup[] = [];
  const transforms: SpreadsheetPartTransform[] = [];

  let chartNumber = 0;
  let drawingNumber = 0;
  for (const set of sets) {
    if (set.charts.length === 0) continue;
    const sheetIndex = workbook.sheets.findIndex((sheet) => sheet.name === set.sheet);
    if (sheetIndex < 0) {
      throw new ValidationError(`图表集合指向不存在的工作表 ${JSON.stringify(set.sheet)}`);
    }
    drawingNumber += 1;
    const drawingPath = drawingPartPath(drawingNumber - 1);

    // 每个图表一个 chartN.xml，并配一条 drawing → chart 关系（rId1..N，与声明顺序一致）。
    const drawingDeclarations: RelationshipDeclaration[] = [];
    const chartIds: string[] = [];
    for (const chart of set.charts) {
      validateChartReferences(workbook, chart);
      chartNumber += 1;
      const path = chartPartPath(chartNumber - 1);
      parts.push({ path, content_type: XLSX_CHART_CONTENT_TYPE, data: buildChartXml(chart) });
      chartIds.push(`rId${String(drawingDeclarations.length + 1)}`);
      drawingDeclarations.push({
        type: CHART_RELATIONSHIP_TYPE,
        target: `../charts/chart${String(chartNumber)}.xml`,
      });
    }
    parts.push({
      path: drawingPath,
      content_type: XLSX_DRAWING_CONTENT_TYPE,
      data: buildDrawingXml(set.charts, chartIds),
    });
    relationships.push({ owner_part_path: drawingPath, declarations: drawingDeclarations });

    // 工作表 → 绘图：本表还没有任何部件级关系，因此是 rId1。
    relationships.push({
      owner_part_path: worksheetPartPath(sheetIndex),
      declarations: [{ type: DRAWING_RELATIONSHIP_TYPE, target: `../drawings/drawing${String(drawingNumber)}.xml` }],
    });
    transforms.push({
      part_path: worksheetPartPath(sheetIndex),
      root_attributes: [attr('xmlns:r', OFFICE_RELATIONSHIPS_NAMESPACE)],
      children: [
        serializeXmlNode(el('drawing', [attr('r:id', 'rId1')])),
      ],
    });
  }

  return { parts, relationships, transforms };
}

/**
 * 写出**带图表**的真实 .xlsx。
 *
 * 工作簿的单元格、样式、公式缓存仍由 `xlsx-write.ts` 生成；本函数只在其上追加
 * 图表部件、绘图部件与相应关系。同一 `(workbook, sets)` ⇒ 同一字节。
 *
 * @throws {ValidationError} 引用 / 名称 / 锚点非法，或集合指向不存在的工作表
 */
export function writeChartWorkbookXlsx(
  workbook: WorkbookState,
  sets: readonly ChartSet[],
): SpreadsheetPackageResult {
  const extension = chartExtension(workbook, sets);
  return composeWorkbookPackage(workbook, extension);
}

/** 供上层核对：某集合会被写成哪些部件路径（读回断言用）。 */
export function chartPartPaths(sets: readonly ChartSet[]): readonly string[] {
  const paths: string[] = [];
  let chartNumber = 0;
  let drawingNumber = 0;
  for (const set of sets) {
    if (set.charts.length === 0) continue;
    drawingNumber += 1;
    for (const _chart of set.charts) {
      chartNumber += 1;
      paths.push(chartPartPath(chartNumber - 1));
    }
    paths.push(drawingPartPath(drawingNumber - 1));
  }
  return Object.freeze(paths);
}

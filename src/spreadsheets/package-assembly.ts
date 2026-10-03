/**
 * 表格域：**多来源扩展的统一包整合器**（FA-XLS-INTEGRATE）。
 *
 * ## 这个文件要补的是哪块空白
 *
 * 到此为止，表格域的扩展能力被拆在几个**各自独立、各自都能组装完整包**的模块里：
 *
 * | 模块 | 自己能产出什么 | 入口 |
 * |---|---|---|
 * | `charts.ts` | 图表部件 + 绘图部件 + 两处关系 + 工作表 `<drawing>` | `writeChartWorkbookXlsx` |
 * | `pivot.ts` | 透视缓存（定义 + 记录）+ 透视表本体 + 三处关系 + 工作簿 `<pivotCaches>` | `writePivotWorkbookXlsx` |
 * | `objects.ts` | 批注 / VML / 超链接 / 图片 / 原样保留部件 + 工作表级关系 | `writeObjectWorkbookXlsx` |
 * | `xlsx-write.ts` | 数据验证 / 条件格式 / 结构化表格（`XlsxWriteExtras`） | `writeWorkbookXlsx` |
 * | `print-layout.ts` | 打印布局（**不是包，是注入函数**） | `insertSheetPrintXml` / `insertDefinedNamesXml` |
 *
 * 每个模块内部都调一次 `composeWorkbookPackage`（或 `writeWorkbookXlsx`），也就是**各自把
 * 基础部件重新生成一遍**。于是把它们"合到一起"时会出现三类冲突：
 *
 * 1. **部件名冲突**：`charts.ts` 与 `objects.ts` 都用 `xl/drawings/drawingN.xml`——同一张表上
 *    既有图表又有图片时，两边都想写 `drawing1.xml`；
 * 2. **关系 id 冲突**：两边的部件级关系各自从 `rId1` 起编号，直接拼接就会出现同一个
 *    `xl/worksheets/sheet1.xml` 上有两条 `rId1`；
 * 3. **Content_Types 冲突**：同一部件两条 `Override`（或一条覆盖不到）。
 *
 * 本文件是**唯一一份整合器**：把上述任一来源的产物喂进来，产出**一份**自洽的 .xlsx。
 *
 * ## 怎么合（而不改任何既有文件）
 *
 * 整合器不重新实现各模块的 XML 生成，而是**把每个来源当成一份完整的候选包读回来
 * （`readZip`）再合并**——各模块的公开写出函数一个字节都没有改：
 *
 * 1. **读回**：`readZip` 解包，拆成「业务部件」「关系部件（含 id）」「Content_Types 默认项」；
 * 2. **部件名统一分配**：按来源顺序走一遍，已占用的路径分两类处理——
 *    - **本身就该合并的部件**（`xl/workbook.xml` / `xl/styles.xml` / `xl/worksheets/*.xml` 这类
 *      每个来源都会重新生成的基础部件，以及每张表**最多一个**的 `xl/drawings/drawingN.xml`）
 *      ⇒ **就地合并**（根属性取并集，子元素按前缀追加 / 锚点拼接），**不覆盖**；
 *    - **其余**（媒体、批注、自定义部件……）⇒ **重新编号**到一个空闲路径，**不覆盖**；
 * 3. **关系 id 统一分配**：按「持有者 → 来源顺序 → 声明顺序」重排，同一条声明
 *    （同类型 + 同解析目标）在跨来源时去重；每个来源的**局部 `rIdN` → 全局 `rIdM`** 映射
 *    被用来改写该来源部件里出现的 `r:id` / `r:embed` / `r:link`；
 * 4. **Content_Types**：默认项取并集；`Override` 由 `assembleOpcPackage` 按最终部件表**重新生成**
 *    （因此"每个部件恰好一条覆盖项"是构造性的，不靠人工维护）；
 * 5. **打印**：`print-layout.ts` 不是包，故在合并完成后对 `xl/workbook.xml` 与各
 *    `xl/worksheets/sheetN.xml` 调用 `insertDefinedNamesXml` / `insertSheetPrintXml`；
 * 6. **真实字节读回**：组装完再 `readZip` 一次，逐项核对（部件存在、无重复 `rId`、
 *    每条内部关系的目标确实在包里、每个业务部件恰好一条 `Override`）。
 *
 * ## 忠实性：单来源 ⇒ 与那个模块的产物**逐字节相同**
 *
 * 只给一个来源时，合并退化成"基础包 + 该来源追加的东西"，而各模块本来也是这么写的
 * （`applyTransform` 就是把子元素追加到根元素末尾）。因此
 * `assembleWorkbookPackage(wb, { charts })` 与 `writeChartWorkbookXlsx(wb, sets)` 的字节**相等**；
 * 透视 / 对象 / 附加内容同理（见用例）。这既是整合器"没有偷偷改口径"的证据，
 * 也正是"只给一来源时其余部件一个都不出现"的反向对照。
 *
 * ## 未验证 / 边界（如实登记，不夸大）
 *
 * - 产出的 .xlsx **未经真实 Excel / WPS 打开验证**（本工作树无 Office 授权、无设备）：
 *   "整合后的包在真实软件里能打开、图表与图片同时显示"这一点**未验证**。
 * - **`formulas` 只做一致性复核，不改写字节**：`xlsx-write.ts` 的 `<v>` 缓存来自它自己的
 *   受限求值器，没有注入点；本整合器能做的诚实的事是拿 `formula-cache.ts` 的
 *   `verifyFormulaCache` 逐格复核（不一致即**报错**）并回报条目数，**不声称**缓存由外部来源写入。
 * - **两个来源同时在同一张表写批注 / VML**（两次对象写出的合并）会走"重新编号"路径，
 *   但**不会**把两条 `<legacyDrawing>` 合成一条——这在 OOXML 里本就是"每表一条"的元素，
 *   本整合器**不猜**调用方的意图，宁可让这种组合在真实软件里表现异常，也不伪造合并语义。
 *
 * ## 确定性
 *
 * 无 IO、无时钟、无随机、无 locale；部件顺序 / 关系顺序 / 内容类型顺序全部由「来源顺序 +
 * 各自的声明顺序」唯一决定。同一 `(workbook, sources)` ⇒ 同一字节。
 */

import {
  CONTENT_TYPES_PART_PATH,
  RELATIONSHIPS_CONTENT_TYPE,
  ROOT_RELATIONSHIPS_PART_PATH,
  assembleOpcPackage,
  buildRelsPartPath,
  escapeAttribute,
  readZip,
  relationshipIdAt,
  resolveRelationshipTarget,
  utf8Bytes,
  writeZip,
  type ContentTypeDefault,
  type OpcPart,
  type RelationshipGroup,
  type XmlAttribute,
} from '../artifacts/ooxml/index.js';
import { XLSX_WORKBOOK_PART_PATH, xlsxContentDigest } from '../artifacts/templates/xlsx.js';
import {
  attributeValue,
  childElements,
  parseXmlBytes,
} from '../documents/docx/xml-parse.js';
import { ValidationError } from '../protocol/index.js';
import {
  EMPTY_PACKAGE_EXTENSION,
  composeWorkbookPackage,
  writeChartWorkbookXlsx,
  type ChartSet,
  type SpreadsheetPackageExtension,
} from './charts.js';
import { type CfRule } from './conditional-format.js';
import { verifyFormulaCache, type FormulaCache } from './formula-cache.js';
import { writeObjectWorkbookXlsx, type ObjectInventory } from './objects.js';
import {
  writePivotWorkbookXlsx,
  type PivotCollection,
} from './pivot.js';
import {
  insertDefinedNamesXml,
  insertSheetPrintXml,
  isDefaultPrintLayout,
  type PrintPlan,
} from './print-layout.js';
import { type StructuredTable } from './structured-table.js';
import { type DataValidationRule } from './validation.js';
import type { WorkbookState } from './workbook.js';
import {
  EMPTY_EXTRAS,
  EMPTY_RESIDUAL,
  writeWorkbookXlsx,
  type SheetExtras,
  type XlsxWriteExtras,
} from './xlsx-write.js';

// ---------------------------------------------------------------------------
// 输入 / 输出
// ---------------------------------------------------------------------------

/** 一份**已经是完整 .xlsx 容器**的低层来源（由本仓任一写出器产出，或来自别处）。 */
export interface WorkbookPackageSource {
  /** 日志/回报用的标签（也用于 `idMap` 的身份，必须唯一）。 */
  readonly label: string;
  readonly bytes: Uint8Array;
}

/** 整合器的全部来源。全部可选；一个都不给 ⇒ 等价于一份干净的基础工作簿。 */
export interface WorkbookPackageSources {
  /** 图表集合（`charts.ts`）。 */
  readonly charts?: readonly ChartSet[];
  /** 透视集合（`pivot.ts`）。 */
  readonly pivots?: PivotCollection;
  /** 对象清单（`objects.ts`）。 */
  readonly objects?: ObjectInventory;
  /** 打印计划（`print-layout.ts`）。 */
  readonly print?: PrintPlan;
  /** 公式缓存（`formula-cache.ts`）——**只复核不改写**，见文件头边界。 */
  readonly formulas?: FormulaCache;
  /** 数据验证：工作表名 → 规则（`xlsx-write.ts` 的 `XlsxWriteExtras` 通道）。 */
  readonly validations?: Readonly<Record<string, readonly DataValidationRule[]>>;
  /** 条件格式：工作表名 → 规则。 */
  readonly conditionalFormats?: Readonly<Record<string, readonly CfRule[]>>;
  /** 结构化表格：工作表名 → 表。 */
  readonly tables?: Readonly<Record<string, readonly StructuredTable[]>>;
  /** 低层：已是完整包的来源，读回后合并。 */
  readonly packages?: readonly WorkbookPackageSource[];
  /**
   * 低层：直接的扩展声明（与 `charts.ts`/`pivot.ts`/`objects.ts` 内部产出的同型）。
   *
   * 这是整合器暴露的**统一扩展点**：调用方不必再造一份完整包，只要给出
   * 「部件 + 关系组 + 基础部件改写 + 内容类型默认项」。扩展里的 `rIdN` 按
   * **各自关系组的声明顺序**解释，由整合器统一重编号。
   */
  readonly extensions?: readonly SpreadsheetPackageExtension[];
}

/** 整合结果。 */
export interface WorkbookPackageAssembly {
  /** 真实容器字节（可写盘的 .xlsx）。 */
  readonly bytes: Buffer;
  /** ZIP 条目数（含 `[Content_Types].xml` 与全部 `_rels/*.rels`）。 */
  readonly entry_count: number;
  /** 全部条目路径（顺序 = 写入顺序）。 */
  readonly part_paths: readonly string[];
  /** 裸小写十六进制 sha256（真实容器字节）。 */
  readonly content_digest: string;
  /** 实际参与的来源标签（按合并顺序；第一项恒为 `spine`）。 */
  readonly contribution_labels: readonly string[];
  /** 全部关系条数（含包级）。 */
  readonly relationship_count: number;
  /** `formulas` 来源的缓存条目数（未给该来源时为 0）。 */
  readonly formula_entry_count: number;
  /** 读回核对时的观察记录（**不是错误**；例如某部件引用了自己没声明的 `rId`）。 */
  readonly notes: readonly string[];
}

// ---------------------------------------------------------------------------
// 内部模型
// ---------------------------------------------------------------------------

interface SourcePart {
  readonly path: string;
  readonly content_type: string;
  readonly data: Uint8Array;
}

interface SourceDeclaration {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly target_mode: 'Internal' | 'External';
}

interface SourceRels {
  readonly owner: string | null;
  readonly declarations: readonly SourceDeclaration[];
}

/** 一个**来源**：拆开的部件 + 关系 + 内容类型默认项（+ 低层扩展的基础部件改写）。 */
interface Source {
  readonly label: string;
  readonly parts: readonly SourcePart[];
  readonly rels: readonly SourceRels[];
  readonly defaults: readonly ContentTypeDefault[];
  readonly transforms: readonly {
    readonly owner: string;
    readonly root_attributes?: readonly XmlAttribute[];
    readonly children?: readonly string[];
  }[];
}

/** 包级关系（`owner_part_path === null`）在内部映射表里的键。`|` 不出现在部件路径与标签里。 */
const ROOT_OWNER_KEY = '|root|';

function ownerKey(owner: string | null): string {
  return owner === null ? ROOT_OWNER_KEY : owner;
}

function sourcePartKey(label: string, owner: string | null): string {
  return `${label}|${ownerKey(owner)}`;
}

/** `_rels/.rels` → `null`；`xl/_rels/workbook.xml.rels` → `xl/workbook.xml`。 */
function ownerPathOfRels(relsPath: string): string | null {
  if (relsPath === ROOT_RELATIONSHIPS_PART_PATH) return null;
  const match = /^(.+)\/_rels\/([^/]+)\.rels$/.exec(relsPath);
  if (match === null) {
    throw new ValidationError(`无法识别的关系部件路径：${JSON.stringify(relsPath)}`);
  }
  return `${match[1] as string}/${match[2] as string}`;
}

function extensionOf(path: string): string | null {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash + 1 ? path.slice(dot + 1).toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// 读回一份完整包
// ---------------------------------------------------------------------------

interface ContentTypes {
  readonly defaults: readonly ContentTypeDefault[];
  readonly overrides: ReadonlyMap<string, string>;
}

function readContentTypes(root: ReturnType<typeof parseXmlBytes>): ContentTypes {
  const defaults: ContentTypeDefault[] = [];
  const overrides = new Map<string, string>();
  for (const child of childElements(root)) {
    if (child.localName === 'Default') {
      const extension = attributeValue(child, '', 'Extension');
      const contentType = attributeValue(child, '', 'ContentType');
      if (extension !== null && contentType !== null) {
        defaults.push(Object.freeze({ extension, content_type: contentType }));
      }
    } else if (child.localName === 'Override') {
      const partName = attributeValue(child, '', 'PartName');
      const contentType = attributeValue(child, '', 'ContentType');
      if (partName !== null && contentType !== null) {
        overrides.set(partName.replace(/^\/+/, ''), contentType);
      }
    }
  }
  return { defaults, overrides };
}

function contentTypeOf(path: string, types: ContentTypes): string {
  const override = types.overrides.get(path);
  if (override !== undefined) return override;
  const extension = extensionOf(path);
  if (extension !== null) {
    const entry = types.defaults.find((item) => item.extension.toLowerCase() === extension);
    if (entry !== undefined) return entry.content_type;
  }
  return 'application/octet-stream';
}

/**
 * 读回一份完整 .xlsx，拆成整合器能用的形状。
 *
 * @throws {ValidationError} 同一个关系部件里出现了两条同 `Id` 的 `<Relationship>`
 *   （**关系 id 冲突：报错，不静默覆盖**）
 */
function readSource(label: string, bytes: Uint8Array): Source {
  const archive = readZip(bytes);
  const contentTypesEntry = archive.by_path.get(CONTENT_TYPES_PART_PATH);
  const types: ContentTypes =
    contentTypesEntry === undefined
      ? { defaults: [], overrides: new Map<string, string>() }
      : readContentTypes(parseXmlBytes(contentTypesEntry.data));

  const parts: SourcePart[] = [];
  const rels: SourceRels[] = [];
  for (const entry of archive.entries) {
    if (entry.path === CONTENT_TYPES_PART_PATH) continue;
    if (entry.path.endsWith('.rels')) {
      const owner = ownerPathOfRels(entry.path);
      const declarations: SourceDeclaration[] = [];
      const seen = new Set<string>();
      for (const child of childElements(parseXmlBytes(entry.data))) {
        if (child.localName !== 'Relationship') continue;
        const id = attributeValue(child, '', 'Id');
        const type = attributeValue(child, '', 'Type');
        const target = attributeValue(child, '', 'Target');
        if (id === null || type === null || target === null) continue;
        if (seen.has(id)) {
          throw new ValidationError(
            `来源 ${JSON.stringify(label)} 的 ${entry.path} 里关系 id ${JSON.stringify(id)} 出现了两次：` +
              '关系 id 冲突必须报错，不得静默覆盖',
          );
        }
        seen.add(id);
        declarations.push(
          Object.freeze({
            id,
            type,
            target,
            target_mode:
              attributeValue(child, '', 'TargetMode') === 'External'
                ? ('External' as const)
                : ('Internal' as const),
          }),
        );
      }
      rels.push(Object.freeze({ owner, declarations: Object.freeze(declarations) }));
      continue;
    }
    parts.push(
      Object.freeze({ path: entry.path, content_type: contentTypeOf(entry.path, types), data: entry.data }),
    );
  }
  return Object.freeze({
    label,
    parts: Object.freeze(parts),
    rels: Object.freeze(rels),
    defaults: Object.freeze(types.defaults.filter((entry) => entry.extension !== 'rels')),
    transforms: Object.freeze([]),
  });
}

/** 把一份**扩展声明**当成一个来源（部件 + 关系组按声明顺序编号 + 基础部件改写）。 */
function sourceFromExtension(label: string, extension: SpreadsheetPackageExtension): Source {
  const parts: SourcePart[] = (extension.parts ?? []).map((part) =>
    Object.freeze({
      path: part.path,
      content_type: part.content_type,
      data: typeof part.data === 'string' ? utf8Bytes(part.data) : part.data,
    }),
  );
  const rels: SourceRels[] = (extension.relationships ?? []).map((group) =>
    Object.freeze({
      owner: group.owner_part_path,
      declarations: Object.freeze(
        group.declarations.map((declaration, index) =>
          Object.freeze({
            id: relationshipIdAt(index),
            type: declaration.type,
            target: declaration.target,
            target_mode: declaration.target_mode ?? ('Internal' as const),
          }),
        ),
      ),
    }),
  );
  const transforms = (extension.transforms ?? []).map((transform) =>
    Object.freeze({
      owner: transform.part_path,
      ...(transform.root_attributes === undefined ? {} : { root_attributes: transform.root_attributes }),
      ...(transform.children === undefined ? {} : { children: transform.children }),
    }),
  );
  return Object.freeze({
    label,
    parts: Object.freeze(parts),
    rels: Object.freeze(rels),
    defaults: Object.freeze([...(extension.content_type_defaults ?? [])]),
    transforms: Object.freeze(transforms),
  });
}

// ---------------------------------------------------------------------------
// 部件路径 / XML 合并
// ---------------------------------------------------------------------------

/** 每个来源都会重新生成的基础部件（合并，而不是改名）。 */
function isBasePartPath(path: string): boolean {
  return (
    path === XLSX_WORKBOOK_PART_PATH ||
    path === 'xl/styles.xml' ||
    /^xl\/worksheets\/sheet\d+\.xml$/.test(path)
  );
}

/** 每张表最多一份的绘图部件（原地合并锚点，而不是改名——ECMA-376 只允许一条 `<drawing>`）。 */
function isDrawingPartPath(path: string): boolean {
  return /^xl\/drawings\/drawing\d+\.xml$/.test(path);
}

/** 分配一个空闲路径：优先用文件名尾部的编号 +1，没有编号就在扩展名前插 2。 */
function allocateFreePath(path: string, taken: ReadonlySet<string>): string {
  const slash = path.lastIndexOf('/');
  const directory = slash === -1 ? '' : path.slice(0, slash + 1);
  const basename = slash === -1 ? path : path.slice(slash + 1);
  const match = /^(.*?)(\d+)(\.[A-Za-z0-9]+)?$/.exec(basename);
  const stem = match === null ? basename : (match[1] as string);
  const start = match === null ? 1 : Number.parseInt(match[2] as string, 10);
  const extension = match === null ? '' : (match[3] ?? '');
  for (let n = start + 1; n <= start + 100000; n += 1) {
    const candidate = `${directory}${stem}${String(n)}${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new ValidationError(`无法为部件 ${JSON.stringify(path)} 分配一个空闲路径`);
}

interface RootParts {
  readonly openStart: number;
  readonly openEnd: number;
  readonly selfClosed: boolean;
  readonly rootName: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: string;
}

const ROOT_ATTRIBUTE_PATTERN = /\s([A-Za-z_:][-A-Za-z0-9_.:]*)=("[^"]*")/g;

function splitRoot(xml: string, where: string): RootParts {
  const declarationEnd = xml.indexOf('?>');
  const openStart = xml.indexOf('<', declarationEnd === -1 ? 0 : declarationEnd + 2);
  /* c8 ignore next -- 生成器产出的部件一定有根元素 */
  if (openStart < 0) throw new ValidationError(`部件 ${where} 的 XML 里找不到根元素`);
  const openEnd = xml.indexOf('>', openStart);
  /* c8 ignore next -- 同上 */
  if (openEnd < 0) throw new ValidationError(`部件 ${where} 的根元素开标签未闭合`);
  const openTag = xml.slice(openStart, openEnd + 1);
  const nameMatch = /^<([^\s/>]+)/.exec(openTag);
  /* c8 ignore next -- 上面刚确认过是 `<` 开头的标签 */
  if (nameMatch === null) throw new ValidationError(`部件 ${where} 的根元素名无法解析`);
  const selfClosed = openTag.endsWith('/>');
  const attributes = new Map<string, string>();
  for (const match of openTag.matchAll(ROOT_ATTRIBUTE_PATTERN)) {
    attributes.set(match[1] as string, (match[2] as string).slice(1, -1));
  }
  const closeAt = selfClosed ? -1 : xml.lastIndexOf('</');
  return {
    openStart,
    openEnd,
    selfClosed,
    rootName: nameMatch[1] as string,
    attributes,
    children: selfClosed ? '' : xml.slice(openEnd + 1, closeAt),
  };
}

/**
 * 把子元素串切成**顶层**元素片段。
 *
 * 只接受"纯元素、无顶层文本"的形态（本仓的生成器正是这样写的）；碰到文本就会显式失败，
 * 而不是猜怎么合并。
 *
 * @throws {ValidationError} 顶层出现非元素内容 / 子元素未闭合
 */
function splitTopLevelElements(children: string, where: string): string[] {
  const segments: string[] = [];
  let index = 0;
  while (index < children.length) {
    if (children[index] !== '<') {
      throw new ValidationError(
        `部件 ${where} 的根元素下有非元素内容，整合器不猜合并语义：` +
          JSON.stringify(children.slice(index, index + 24)),
      );
    }
    let depth = 0;
    let cursor = index;
    let finished = false;
    while (cursor < children.length) {
      if (children.startsWith('<!--', cursor)) {
        const commentEnd = children.indexOf('-->', cursor);
        cursor = commentEnd < 0 ? children.length : commentEnd + 3;
        continue;
      }
      if (children[cursor] === '<') {
        if (children[cursor + 1] === '/') {
          depth -= 1;
          cursor = children.indexOf('>', cursor) + 1;
        } else {
          const gt = children.indexOf('>', cursor);
          if (gt < 0) throw new ValidationError(`部件 ${where} 的子元素未闭合`);
          if (children[gt - 1] === '/') {
            cursor = gt + 1;
          } else {
            depth += 1;
            cursor = gt + 1;
          }
        }
        if (depth === 0) {
          finished = true;
          break;
        }
        continue;
      }
      cursor += 1;
    }
    if (!finished) throw new ValidationError(`部件 ${where} 的子元素未闭合`);
    segments.push(children.slice(index, cursor));
    index = cursor;
  }
  return segments;
}

/** CT_Worksheet 的子元素规范序列（ECMA-376 §18.3.1.99；与 `print-layout.ts` 同表）。 */
const WORKSHEET_CHILD_ORDER: readonly string[] = Object.freeze([
  'sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'sheetCalcPr',
  'sheetProtection', 'protectedRanges', 'scenarios', 'autoFilter', 'sortState', 'dataConsolidate',
  'customSheetViews', 'mergeCells', 'phoneticPr', 'conditionalFormatting', 'dataValidations',
  'hyperlinks', 'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks',
  'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing',
  'legacyDrawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst',
]);

/** CT_Workbook 的子元素规范序列（ECMA-376 §18.2.27）。 */
const WORKBOOK_CHILD_ORDER: readonly string[] = Object.freeze([
  'fileVersion', 'fileSharing', 'workbookPr', 'workbookProtection', 'bookViews', 'sheets',
  'functionGroups', 'externalReferences', 'definedNames', 'calcPr', 'oleSize', 'customWorkbookViews',
  'pivotCaches', 'smartTagPr', 'smartTagTypes', 'webPublishing', 'fileRecoveryPr',
  'webPublishObjects', 'extLst',
]);

/** CT_Stylesheet 的子元素规范序列（ECMA-376 §18.8.39）。 */
const STYLESHEET_CHILD_ORDER: readonly string[] = Object.freeze([
  'numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs', 'cellStyles', 'dxfs',
  'tableStyles', 'colors', 'extLst',
]);

function childOrderOf(rootName: string): readonly string[] | null {
  if (rootName === 'worksheet') return WORKSHEET_CHILD_ORDER;
  if (rootName === 'workbook') return WORKBOOK_CHILD_ORDER;
  if (rootName === 'styleSheet') return STYLESHEET_CHILD_ORDER;
  return null;
}

const UNKNOWN_CHILD_RANK = 1000;

/**
 * 合并子元素：以**先到者**的顺序为骨架，逐条追加后来者里**尚未出现**的同名同文片段
 * （完全相同即去重，因此两份来源各写一条 `<drawing r:id="rId1"/>` 不会变成两条）；
 * 非拼接模式下再按 CT 规范序列稳定排序（单来源时顺序不变，因此字节不变）。
 */
function mergeChildren(
  baseChildren: string,
  extraChildren: string,
  rootName: string,
  where: string,
  concatenate: boolean,
): string {
  const base = splitTopLevelElements(baseChildren, where);
  const seen = new Set(base);
  const merged = [...base];
  for (const segment of splitTopLevelElements(extraChildren, where)) {
    if (seen.has(segment)) continue;
    seen.add(segment);
    merged.push(segment);
  }
  if (concatenate) return merged.join('');
  const order = childOrderOf(rootName);
  if (order === null || order.length === 0) return merged.join('');
  return merged
    .map((segment, index) => {
      const name = /^<([^\s/>]+)/.exec(segment)?.[1] ?? '';
      const rank = order.indexOf(name);
      return { segment, index, rank: rank < 0 ? UNKNOWN_CHILD_RANK : rank };
    })
    .sort((left, right) => (left.rank === right.rank ? left.index - right.index : left.rank - right.rank))
    .map((entry) => entry.segment)
    .join('');
}

/**
 * 合并同一路径的两份 XML：根属性取并集（同名以**先到者**为准），子元素取并集
 * （`concatenate` 为真时用于绘图部件：锚点本来就该一起放进同一份 `xdr:wsDr`，不做 CT 排序）。
 *
 * @throws {ValidationError} 顶层出现非元素内容（宁可显式失败，也不猜）
 */
function unionRootXml(
  baseXml: string,
  extraXml: string,
  where: string,
  concatenate: boolean,
): string {
  const base = splitRoot(baseXml, where);
  const extra = splitRoot(extraXml, where);
  const added = [...extra.attributes.entries()]
    .filter(([name]) => !base.attributes.has(name))
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join('');
  const children = mergeChildren(base.children, extra.children, base.rootName, where, concatenate);
  const head = baseXml.slice(0, base.openEnd);
  if (children === '') {
    return base.selfClosed ? `${head}${added}/>` : `${head}${added}></${base.rootName}>`;
  }
  return `${head}${added}>${children}</${base.rootName}>`;
}

// ---------------------------------------------------------------------------
// 关系 id 改写
// ---------------------------------------------------------------------------

const RELATIONSHIP_REFERENCE_PATTERN = /\sr:(?:id|embed|link)="(rId\d+)"/g;

/** 把文本里出现的 `r:id` / `r:embed` / `r:link` 局部编号改写为全局编号。 */
function rewriteRelationshipReferences(
  text: string,
  map: ReadonlyMap<string, string>,
  unresolved: string[],
  where: string,
): string {
  return text.replace(RELATIONSHIP_REFERENCE_PATTERN, (whole, id: string) => {
    const mapped = map.get(id);
    if (mapped === undefined) {
      unresolved.push(`${where} 引用了自己未声明的 ${id}（原样保留）`);
      return whole;
    }
    return whole.replace(`"${id}"`, `"${mapped}"`);
  });
}

/** 相对目标：把 `targetPath` 表示成从 `owner` 所在目录出发的相对路径。 */
function relativeTarget(owner: string | null, targetPath: string): string {
  const base =
    owner === null
      ? []
      : owner
          .slice(0, owner.lastIndexOf('/') + 1)
          .split('/')
          .filter((segment) => segment.length > 0);
  const target = targetPath.split('/').filter((segment) => segment.length > 0);
  let common = 0;
  while (common < base.length && common < target.length - 1 && base[common] === target[common]) {
    common += 1;
  }
  const ups = base.slice(common).map(() => '..');
  return [...ups, ...target.slice(common)].join('/');
}

// ---------------------------------------------------------------------------
// 附加内容（validations / conditionalFormats / tables）
// ---------------------------------------------------------------------------

function buildExtras(workbook: WorkbookState, sources: WorkbookPackageSources): XlsxWriteExtras {
  const names = new Set<string>([
    ...Object.keys(sources.validations ?? {}),
    ...Object.keys(sources.conditionalFormats ?? {}),
    ...Object.keys(sources.tables ?? {}),
  ]);
  if (names.size === 0) return EMPTY_EXTRAS;
  const sheets: Record<string, SheetExtras> = {};
  // 先按工作簿顺序，再补未知表名（后者由 `writeWorkbookXlsx` 显式拒绝，不静默丢弃）
  const ordered = [
    ...workbook.sheets.map((sheet) => sheet.name).filter((name) => names.has(name)),
    ...[...names].filter((name) => !workbook.sheets.some((sheet) => sheet.name === name)).sort(),
  ];
  for (const name of ordered) {
    const dataValidations = sources.validations?.[name];
    const conditionalFormats = sources.conditionalFormats?.[name];
    const tables = sources.tables?.[name];
    sheets[name] = Object.freeze({
      ...(dataValidations === undefined ? {} : { data_validations: dataValidations }),
      ...(conditionalFormats === undefined ? {} : { conditional_formats: conditionalFormats }),
      ...(tables === undefined ? {} : { tables }),
    });
  }
  return Object.freeze({ sheets: Object.freeze(sheets) });
}

// ---------------------------------------------------------------------------
// 真实字节读回核对
// ---------------------------------------------------------------------------

interface Verification {
  readonly relationship_count: number;
  readonly notes: readonly string[];
}

/**
 * `readZip` 解包后逐项核对：部件存在性、无重复 `rId`、内部关系目标存在、
 * 每个业务部件恰好一条 `Override`。任一条不满足即抛（**不留半成品**）。
 */
function verifyPackageBytes(bytes: Uint8Array, expectedPartPaths: readonly string[]): Verification {
  const archive = readZip(bytes);
  const notes: string[] = [];

  for (const path of expectedPartPaths) {
    if (!archive.by_path.has(path)) {
      throw new ValidationError(`读回核对失败：包里缺少部件 ${path}`);
    }
  }

  const contentTypesEntry = archive.by_path.get(CONTENT_TYPES_PART_PATH);
  if (contentTypesEntry === undefined) {
    throw new ValidationError('读回核对失败：包里缺少 [Content_Types].xml');
  }
  const overrideCount = new Map<string, number>();
  for (const child of childElements(parseXmlBytes(contentTypesEntry.data))) {
    if (child.localName !== 'Override') continue;
    const partName = attributeValue(child, '', 'PartName');
    if (partName === null) continue;
    const path = partName.replace(/^\/+/, '');
    overrideCount.set(path, (overrideCount.get(path) ?? 0) + 1);
  }

  let relationships = 0;
  for (const entry of archive.entries) {
    if (!entry.path.endsWith('.rels')) continue;
    const owner = ownerPathOfRels(entry.path);
    const ids = new Set<string>();
    for (const child of childElements(parseXmlBytes(entry.data))) {
      if (child.localName !== 'Relationship') continue;
      const id = attributeValue(child, '', 'Id');
      if (id === null) continue;
      if (ids.has(id)) {
        throw new ValidationError(`读回核对失败：${entry.path} 里关系 id ${id} 重复`);
      }
      ids.add(id);
      relationships += 1;
      const target = attributeValue(child, '', 'Target');
      if (target === null) continue;
      if (attributeValue(child, '', 'TargetMode') === 'External') continue;
      const resolved = resolveRelationshipTarget(owner, target);
      if (!archive.by_path.has(resolved)) {
        throw new ValidationError(`读回核对失败：${entry.path} 的关系目标 ${target} → ${resolved} 不在包里`);
      }
    }
  }

  for (const entry of archive.entries) {
    if (entry.path === CONTENT_TYPES_PART_PATH || entry.path.endsWith('.rels')) continue;
    const count = overrideCount.get(entry.path) ?? 0;
    if (count !== 1) {
      throw new ValidationError(
        `读回核对失败：部件 ${entry.path} 的 Content_Types 覆盖项数为 ${String(count)}（必须恰好 1）`,
      );
    }
  }

  return { relationship_count: relationships, notes: Object.freeze(notes) };
}

// ---------------------------------------------------------------------------
// 整合
// ---------------------------------------------------------------------------

/**
 * 把若干**来源**合成**一份**自洽的 .xlsx。
 *
 * @param workbook 模型（不可变）
 * @param sources 来源（全部可选）
 *
 * @throws {ValidationError} 来源内部关系 id 重复 / 两份 XML 无法合并 / `formulas` 与工作簿不一致
 * @throws {OpcError} 合并后仍有悬空关系目标或重复部件（由 `assembleOpcPackage` 判定）
 */
export function assembleWorkbookPackage(
  workbook: WorkbookState,
  sources: WorkbookPackageSources = {},
): WorkbookPackageAssembly {
  const labels: string[] = ['spine'];
  const unresolved: string[] = [];

  // ① 公式缓存：只复核，不改写字节。
  let formulaEntryCount = 0;
  if (sources.formulas !== undefined) {
    const check = verifyFormulaCache(workbook, sources.formulas);
    if (!check.consistent) {
      const head = check.discrepancies
        .slice(0, 3)
        .map((item) => `${item.key}(${item.kind})`)
        .join('；');
      throw new ValidationError(
        `formulas 缓存与工作簿不一致（共 ${String(check.discrepancies.length)} 处）：${head}`,
      );
    }
    formulaEntryCount = sources.formulas.entries.length;
  }

  // ② 主链（spine）：基础工作簿 + 附加内容（数据验证 / 条件格式 / 结构化表格）。
  const extras = buildExtras(workbook, sources);
  const extrasApplied = extras !== EMPTY_EXTRAS;
  const spineBytes =
    extrasApplied
      ? writeWorkbookXlsx(workbook, EMPTY_RESIDUAL, extras).bytes
      : composeWorkbookPackage(workbook, EMPTY_PACKAGE_EXTENSION).bytes;
  if (extrasApplied) {
    if (Object.keys(sources.validations ?? {}).length > 0) labels.push('validations');
    if (Object.keys(sources.conditionalFormats ?? {}).length > 0) labels.push('conditionalFormats');
    if (Object.keys(sources.tables ?? {}).length > 0) labels.push('tables');
  }

  // ③ 其余来源：各模块的完整包（一个字节都没改它们的公开入口）。
  const sourceList: Source[] = [readSource('spine', spineBytes)];
  if (sources.charts !== undefined && sources.charts.length > 0) {
    labels.push('charts');
    sourceList.push(
      readSource('charts', writeChartWorkbookXlsx(workbook, sources.charts).bytes),
    );
  }
  if (sources.pivots !== undefined && sources.pivots.pivots.length > 0) {
    labels.push('pivots');
    sourceList.push(readSource('pivots', writePivotWorkbookXlsx(workbook, sources.pivots).bytes));
  }
  if (sources.objects !== undefined) {
    labels.push('objects');
    sourceList.push(readSource('objects', writeObjectWorkbookXlsx(workbook, sources.objects).bytes));
  }
  (sources.packages ?? []).forEach((extra, index) => {
    labels.push(extra.label);
    sourceList.push(readSource(`${extra.label}#${String(index)}`, extra.bytes));
  });
  (sources.extensions ?? []).forEach((extension, index) => {
    labels.push(`extension#${String(index)}`);
    sourceList.push(sourceFromExtension(`extension#${String(index)}`, extension));
  });

  // ④ 部件名统一分配：合并类就地合并，其余重新编号（**不覆盖**）。
  const taken = new Set<string>();
  const finalPathOf = new Map<string, string>();
  for (const source of sourceList) {
    for (const part of source.parts) {
      const key = `${source.label}|${part.path}`;
      if (!taken.has(part.path)) {
        taken.add(part.path);
        finalPathOf.set(key, part.path);
        continue;
      }
      if (isBasePartPath(part.path) || isDrawingPartPath(part.path)) {
        finalPathOf.set(key, part.path);
        continue;
      }
      const next = allocateFreePath(part.path, taken);
      taken.add(next);
      finalPathOf.set(key, next);
    }
  }
  const pathOf = (label: string, path: string): string | undefined =>
    finalPathOf.get(`${label}|${path}`);

  // ⑤ 关系 id 统一分配：持有者 → 来源顺序 → 声明顺序；跨来源同一条声明去重。
  //
  // **持有者用「部件重编号后的最终路径」分组**，而不是来源里的原始路径：非基础部件
  // （如第二份 `xl/charts/chart1.xml`）会被重编号成 `chart2.xml`，若仍按原始路径分组，
  // 它的关系就会挂到**第一个**同名部件的 `.rels` 上——"关系跟着别人走"的静默错配，
  // 也正是"合并两份外部包时关系不冲突"要挡的事。重编号只改文件名、不改目录，
  // 因此相对目标（`../media/…`）的解析结果不变。
  const ownerOrder: (string | null)[] = [];
  const mergedByOwner = new Map<string | null, { key: string; declaration: SourceDeclaration; target: string }[]>();
  const idMap = new Map<string, Map<string, string>>();

  for (const source of sourceList) {
    for (const group of source.rels) {
      const owner = group.owner === null ? null : (pathOf(source.label, group.owner) ?? group.owner);
      let list = mergedByOwner.get(owner);
      if (list === undefined) {
        list = [];
        mergedByOwner.set(owner, list);
        ownerOrder.push(owner);
      }
      const map = new Map<string, string>();
      for (const declaration of group.declarations) {
        let target = declaration.target;
        if (declaration.target_mode !== 'External') {
          const resolved = resolveRelationshipTarget(group.owner, declaration.target);
          const finalPath = pathOf(source.label, resolved);
          if (finalPath !== undefined && finalPath !== resolved) {
            target = relativeTarget(owner, finalPath);
          }
        }
        // 去重键用**解析后的部件路径**（而不是原始相对文本）：因此"图表与对象各写一条
        // → 同一份 xl/drawings/drawing1.xml"这类跨来源重复会被识别成同一条声明。
        const resolvedFinal =
          declaration.target_mode === 'External'
            ? target
            : resolveRelationshipTarget(owner, target);
        const key = `${declaration.type}|${declaration.target_mode}|${resolvedFinal}`;
        let index = list.findIndex((entry) => entry.key === key);
        if (index < 0) {
          list.push({ key, declaration, target });
          index = list.length - 1;
        }
        map.set(declaration.id, relationshipIdAt(index));
      }
      // idMap 仍按**原始持有者路径**建索引：部件内容里的 `r:id` 改写（步骤⑥）是按来源里的
      // 原始部件路径查表的，二者必须同一口径。
      idMap.set(sourcePartKey(source.label, group.owner), map);
    }
  }
  ownerOrder.sort((left, right) => (left === null ? -1 : right === null ? 1 : 0));

  // ⑥ 部件内容：改写本来源的关系引用，再合并。
  const order: string[] = [];
  const content = new Map<string, Uint8Array>();
  const contentType = new Map<string, string>();
  const decoder = new TextDecoder('utf-8');
  const encoder = new TextEncoder();
  const textAt = (path: string): string => decoder.decode(content.get(path) as Uint8Array);

  for (const source of sourceList) {
    for (const part of source.parts) {
      const finalPath = pathOf(source.label, part.path) as string;
      const map = idMap.get(sourcePartKey(source.label, part.path));
      let data = part.data;
      if (map !== undefined && map.size > 0) {
        data = encoder.encode(
          rewriteRelationshipReferences(decoder.decode(part.data), map, unresolved, part.path),
        );
      }
      if (!content.has(finalPath)) {
        content.set(finalPath, data);
        contentType.set(finalPath, part.content_type);
        order.push(finalPath);
        continue;
      }
      const merged = unionRootXml(
        textAt(finalPath),
        decoder.decode(data),
        finalPath,
        isDrawingPartPath(finalPath),
      );
      content.set(finalPath, encoder.encode(merged));
    }
  }

  // ⑦ 低层扩展的基础部件改写（`SpreadsheetPackageExtension.transforms` 同语义：追加到根末尾）。
  for (const source of sourceList) {
    for (const transform of source.transforms) {
      const current = content.get(transform.owner);
      if (current === undefined) {
        throw new ValidationError(
          `扩展声明要改写的部件不在包里：${transform.owner}（整合器不猜，显式失败）`,
        );
      }
      const map = idMap.get(sourcePartKey(source.label, transform.owner)) ?? new Map<string, string>();
      const children = (transform.children ?? []).map((child) =>
        rewriteRelationshipReferences(child, map, unresolved, transform.owner),
      );
      const text = decoder.decode(current);
      const root = splitRoot(text, transform.owner);
      const added = (transform.root_attributes ?? [])
        .filter((attribute) => !root.attributes.has(attribute.name))
        .map((attribute) => ` ${attribute.name}="${escapeAttribute(attribute.value)}"`)
        .join('');
      const head = `${text.slice(0, root.openEnd)}${added}`;
      const merged =
        children.length === 0
          ? `${head}${root.selfClosed ? '/>' : `>${root.children}</${root.rootName}>`}`
          : `${head}>${root.children}${children.join('')}</${root.rootName}>`;
      content.set(transform.owner, encoder.encode(merged));
    }
  }

  // ⑧ 打印：不是包，直接注入合并后的基础部件。
  if (sources.print !== undefined) {
    labels.push('print');
    const sheetOrder = workbook.sheets.map((sheet) => sheet.name);
    const workbookXml = textAt(XLSX_WORKBOOK_PART_PATH);
    const withNames = insertDefinedNamesXml(workbookXml, sources.print, sheetOrder);
    if (withNames !== workbookXml) {
      content.set(XLSX_WORKBOOK_PART_PATH, encoder.encode(withNames));
    }
    for (const entry of sources.print.entries) {
      if (isDefaultPrintLayout(entry.layout)) continue;
      const path = `xl/worksheets/sheet${String(sheetOrder.indexOf(entry.sheet) + 1)}.xml`;
      if (!content.has(path)) {
        throw new ValidationError(`打印计划指向的部件不在包里：${path}（工作表 ${entry.sheet}）`);
      }
      content.set(path, encoder.encode(insertSheetPrintXml(textAt(path), entry.layout)));
    }
  }

  // ⑨ 组装 + 出字节 + 真实字节读回核对。
  const parts: OpcPart[] = order.map((path) => ({
    path,
    content_type: contentType.get(path) as string,
    data: content.get(path) as Uint8Array,
  }));

  const defaults: ContentTypeDefault[] = [
    { extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE },
  ];
  const seenExtensions = new Set(['rels']);
  for (const source of sourceList) {
    for (const entry of source.defaults) {
      if (seenExtensions.has(entry.extension)) continue;
      defaults.push(entry);
      seenExtensions.add(entry.extension);
    }
  }

  const groups: RelationshipGroup[] = ownerOrder.map((owner) => ({
    owner_part_path: owner,
    declarations: (mergedByOwner.get(owner) ?? []).map((entry) => ({
      type: entry.declaration.type,
      target: entry.target,
      ...(entry.declaration.target_mode === 'External'
        ? { target_mode: 'External' as const }
        : {}),
    })),
  }));

  const assembled = assembleOpcPackage({
    parts,
    content_type_defaults: defaults,
    relationships: groups,
  });
  const bytes = writeZip(assembled.entries);

  const verification = verifyPackageBytes(bytes, assembled.part_paths);
  const notes = [...verification.notes, ...unresolved];

  return Object.freeze({
    bytes,
    entry_count: assembled.entries.length,
    part_paths: Object.freeze(assembled.part_paths),
    content_digest: xlsxContentDigest(bytes),
    contribution_labels: Object.freeze([...labels]),
    relationship_count: verification.relationship_count,
    formula_entry_count: formulaEntryCount,
    notes: Object.freeze(notes),
  });
}

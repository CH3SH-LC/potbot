/**
 * 表格域：批注 / 超链接 / 图片及其它常见对象（XLS-14；FA-XLS-OBJECTS 工作包）。
 *
 * ## 这个文件要证明的事
 *
 * XLS-14 的验收句是「批注/备注、超链接、图片及常用对象的位置/尺寸/删除；
 * **已有工作簿对象保留**；文本与公式均可定位修改」。前三条与最后一条都落在"部件怎么读写"上，
 * 中间那条决定本模块的整体形状：**读 → 改 → 写必须不丢东西**。
 *
 * 因此本模块的模型不是一个"工作表 + 对象"的简化体，而是一份**清单**（{@link ObjectInventory}）：
 *
 * | 部分 | 是什么 | 写出时怎么处理 |
 * |---|---|---|
 * | `sheets[].comments` | 批注（作者 + 文本 + 单元格） | 重建成 `xl/commentsN.xml` + VML 形状 + `legacyDrawing` 关系 |
 * | `sheets[].hyperlinks` | 超链接（外部 URL 走关系；内部 location 不走） | 重建成工作表里的 `<hyperlinks>` |
 * | `sheets[].images` | 图片（媒体部件 + 锚点 = 位置/尺寸） | 重建成绘图部件里的 `xdr:pic` 锚点 |
 * | `sheets[].drawing.opaque_anchors` | **本模块不建模**的绘图锚点（例如图表 graphicFrame） | **逐字写回**，一个字节不改 |
 * | `parts` | 原样带回的部件（媒体、customXml、threadedComments……） | 原样写回（路径 + 内容类型 + 字节） |
 * | `preserved_relationships` | 未建模的部件级关系 | 原样带回（持有者必须仍在包内） |
 *
 * "已有对象保留"在字节层的证据是：`readWorkbookObjects` → 原地写回后，
 * **未建模部件的字节逐一相等**（见用例里的 `Buffer.compare`），而图表的 `r:id` 靠
 * `sheets[].drawing.preserved_relationships` 保持原编号续命。
 *
 * ## 文本与公式都能挂对象（也是"定位修改"）
 *
 * 批注与超链接只要求"单元格存在且落在表内"，**不关心那格里是文本还是公式**：
 * 用例里把批注挂在 `B5`（`=SUM(B2:B4)` 公式格）上，写回后公式原文一字不变
 * （`<f>SUM(B2:B4)</f>` 仍在），批注也仍在。
 *
 * ## 未验证 / 边界（如实登记）
 *
 * - **未经真实 Excel / WPS 打开验证**（本工作树无 Office / 无设备）：部件与关系按 ECMA-376 书写，
 *   并由仓内 `readZip` + `parseXmlBytes` 读回核对。
 * - **删除图片**会移除锚点，并在**没有别的图片引用同一媒体部件**时把媒体部件一起删掉；
 *   若同一媒体还被**未建模片段**引用，本模块无法得知，此时会保守地留着媒体（宁可留垃圾，不制造断链）。
 * - **工作表级未建模关系会被重新编号**：本模块重建 `drawing` / `comments` / `vmlDrawing` / `hyperlink`
 *   四类关系，其余按原顺序排在后面。它们通常不由工作表 XML 引用（如 `threadedComment`），
 *   但"重新编号一定无副作用"这条**未在真实软件中验证**。
 */

import { ValidationError } from '../protocol/index.js';
import {
  attr,
  el,
  serializeXmlDocument,
  serializeXmlNode,
  type ContentTypeDefault,
  type OpcPart,
  type RelationshipDeclaration,
  type RelationshipGroup,
  type XmlAttribute,
  type XmlElement,
  type XmlNode,
} from '../artifacts/ooxml/index.js';
import { readZip, type ReadZipArchive } from '../artifacts/ooxml/zip-read.js';
import {
  OFFICE_RELATIONSHIPS_NAMESPACE,
  SPREADSHEETML_NAMESPACE,
  XLSX_WORKBOOK_PART_PATH,
} from '../artifacts/templates/xlsx.js';
import {
  attributeValue,
  childElements,
  directText,
  parseXmlBytes,
  serializeParsedXmlNode,
  type ParsedXmlElement,
} from '../documents/docx/xml-parse.js';
import {
  DRAWING_RELATIONSHIP_TYPE,
  DRAWINGML_MAIN_NAMESPACE,
  SPREADSHEET_DRAWING_NAMESPACE,
  XLSX_DRAWING_CONTENT_TYPE,
  composeWorkbookPackage,
  drawingPartPath,
  type SpreadsheetPackageResult,
} from './charts.js';
import { formatCellAddress, parseCellAddress } from './reference.js';
import { getSheet, type WorkbookState } from './workbook.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 批注部件内容类型。 */
export const XLSX_COMMENTS_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml';

/** 旧式批注形状（VML）部件内容类型。 */
export const XLSX_VML_DRAWING_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.vmlDrawing';

/** 关系类型：worksheet → comments。 */
export const COMMENTS_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';

/** 关系类型：worksheet → vmlDrawing。 */
export const VML_DRAWING_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing';

/** 关系类型：worksheet → hyperlink（外部链接）。 */
export const HYPERLINK_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';

/** 关系类型：drawing → image。 */
export const IMAGE_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

/** 本模块**自己重建**的工作表级关系类型（读回时这些声明不再原样保留，见文件头边界说明）。 */
const REGENERATED_SHEET_RELATIONSHIP_TYPES: readonly string[] = Object.freeze([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing',
  COMMENTS_RELATIONSHIP_TYPE,
  VML_DRAWING_RELATIONSHIP_TYPE,
  HYPERLINK_RELATIONSHIP_TYPE,
]);

/** 支持的图片媒体类型 → 扩展名。 */
const MEDIA_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
});

/** 第 `index`（0 起）个批注部件路径。 */
export function commentsPartPath(index: number): string {
  return `xl/comments${String(index + 1)}.xml`;
}

/** 第 `index`（0 起）个批注形状（VML）部件路径。 */
export function vmlDrawingPartPath(index: number): string {
  return `xl/drawings/vmlDrawing${String(index + 1)}.vml`;
}

/** 第 `index`（0 起）个媒体部件路径（新图片按此命名，既有图片保留原路径）。 */
export function mediaPartPath(index: number, content_type: string): string {
  const extension = MEDIA_EXTENSIONS[content_type];
  /* c8 ignore next -- 调用方已校验内容类型 */
  if (extension === undefined) {
    throw new ValidationError(`不支持的图片内容类型：${JSON.stringify(content_type)}`);
  }
  return `xl/media/image${String(index + 1)}.${extension}`;
}

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

/** 位置 / 尺寸：两格锚点（1 起，A1 = `{ column: 1, row: 1 }`）。 */
export interface ObjectAnchor {
  readonly from_column: number;
  readonly from_row: number;
  readonly to_column: number;
  readonly to_row: number;
}

/** 一条批注（XLS-14 的"批注/备注"）。 */
export interface CommentObject {
  /** 挂在哪一格（A1 记法）。 */
  readonly ref: string;
  readonly author: string;
  readonly text: string;
}

/** 超链接目标。 */
export type HyperlinkTarget =
  | { readonly kind: 'external'; readonly url: string }
  | { readonly kind: 'internal'; readonly location: string };

/** 一条超链接。 */
export interface HyperlinkObject {
  readonly ref: string;
  readonly target: HyperlinkTarget;
  readonly tooltip?: string;
  readonly display?: string;
}

/** 一张图片。**媒体字节存在 {@link ObjectInventory.parts} 里**，这里只记元数据。 */
export interface ImageObject {
  readonly name: string;
  /** 媒体部件路径（`xl/media/image1.png`）。 */
  readonly media_path: string;
  readonly content_type: string;
  readonly anchor: ObjectAnchor;
  /**
   * 绘图级关系 id（读回来的图片带着它）；**新建图片为 `null`**，写出时分配。
   * 保留原编号是"不打断未建模片段"的关键：绘图关系的编号一旦重排，
   * 未建模锚点（如图表）里的 `r:id` 就会指错。
   */
  readonly relationship_id: string | null;
}

/** 本模块**不建模**、但要逐字写回的绘图内容。 */
export interface DrawingRecord {
  /** 原绘图根元素上的命名空间声明（保留片段可能依赖它们）。 */
  readonly root_namespaces: readonly XmlAttribute[];
  /** 未建模锚点的 XML 片段（按原顺序）。 */
  readonly opaque_anchors: readonly string[];
  /** 原绘图级关系声明（顺序 = rId 序号，**不得重排**）。 */
  readonly preserved_relationships: readonly RelationshipDeclaration[];
}

/** 一张工作表上的对象。 */
export interface SheetObjects {
  readonly sheet: string;
  readonly comments: readonly CommentObject[];
  readonly hyperlinks: readonly HyperlinkObject[];
  readonly images: readonly ImageObject[];
  readonly drawing: DrawingRecord | null;
}

/** 原样带回的部件。 */
export interface StoredPart {
  readonly path: string;
  readonly content_type: string;
  readonly data: Uint8Array;
}

/** 一组原样带回的关系声明。 */
export interface PreservedRelationshipGroup {
  readonly owner_part_path: string | null;
  readonly declarations: readonly RelationshipDeclaration[];
}

/**
 * 对象清单：读 → 改 → 写 三态之间的**唯一**载体。
 *
 * 它是**不可变**的：所有 `add*` / `update*` / `remove*` 返回新清单。
 */
export interface ObjectInventory {
  readonly sheets: readonly SheetObjects[];
  /** 原样写回的部件（媒体 + 未建模部件）。 */
  readonly parts: readonly StoredPart[];
  /** 原样写回的关系组（未建模的持有者级关系）。 */
  readonly preserved_relationships: readonly PreservedRelationshipGroup[];
  readonly content_type_defaults: readonly ContentTypeDefault[];
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

const EMPTY_SHEET_OBJECTS = (sheet: string): SheetObjects =>
  Object.freeze({
    sheet,
    comments: Object.freeze([]),
    hyperlinks: Object.freeze([]),
    images: Object.freeze([]),
    drawing: null,
  });

function requireNonEmpty(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${where} 不能是空字符串`);
  }
  return value;
}

function validateAnchor(anchor: ObjectAnchor, where: string): ObjectAnchor {
  const fields: readonly (readonly [number, string])[] = [
    [anchor.from_column, 'from_column'],
    [anchor.from_row, 'from_row'],
    [anchor.to_column, 'to_column'],
    [anchor.to_row, 'to_row'],
  ];
  for (const [value, field] of fields) {
    if (!Number.isInteger(value) || value < 1) {
      throw new ValidationError(`${where}.${field} 必须是 ≥1 的整数，收到 ${String(value)}`);
    }
  }
  if (anchor.to_column <= anchor.from_column || anchor.to_row <= anchor.from_row) {
    throw new ValidationError(`${where} 必须右下大于左上：否则对象没有尺寸`);
  }
  return Object.freeze({ ...anchor });
}

/** 单元格地址校验：表必须存在，且地址落在该表的声明范围内。 */
function normalizeCellRef(workbook: WorkbookState, sheet: string, ref: string, where: string): string {
  const target = getSheet(workbook, sheet);
  if (target === undefined) {
    throw new ValidationError(`${where}：工作簿里没有工作表 ${JSON.stringify(sheet)}`);
  }
  const address = parseCellAddress(requireNonEmpty(ref, `${where}.ref`));
  if (address.column > target.column_count || address.row > target.row_count) {
    throw new ValidationError(
      `${where} 的 ${JSON.stringify(ref)} 超出工作表 ${JSON.stringify(sheet)} 的声明范围`,
    );
  }
  return formatCellAddress(address);
}

// ---------------------------------------------------------------------------
// 清单与查询
// ---------------------------------------------------------------------------

/** 空清单（列出工作簿的全部工作表）。 */
export function createObjectInventory(workbook: WorkbookState): ObjectInventory {
  return Object.freeze({
    sheets: Object.freeze(workbook.sheets.map((sheet) => EMPTY_SHEET_OBJECTS(sheet.name))),
    parts: Object.freeze([] as StoredPart[]),
    preserved_relationships: Object.freeze([] as PreservedRelationshipGroup[]),
    content_type_defaults: Object.freeze([] as ContentTypeDefault[]),
  });
}

function sheetOf(inventory: ObjectInventory, sheet: string, where: string): SheetObjects {
  const found = inventory.sheets.find((entry) => entry.sheet === sheet);
  if (found === undefined) {
    throw new ValidationError(`${where}：清单里没有工作表 ${JSON.stringify(sheet)}`);
  }
  return found;
}

function withSheet(inventory: ObjectInventory, next: SheetObjects): ObjectInventory {
  return Object.freeze({
    ...inventory,
    sheets: Object.freeze(
      inventory.sheets.map((entry) => (entry.sheet === next.sheet ? next : entry)),
    ),
  });
}

/** 查批注；不存在返回 `undefined`。 */
export function findComment(
  inventory: ObjectInventory,
  sheet: string,
  ref: string,
): CommentObject | undefined {
  return sheetOf(inventory, sheet, 'findComment').comments.find((item) => item.ref === ref);
}

/** 查超链接；不存在返回 `undefined`。 */
export function findHyperlink(
  inventory: ObjectInventory,
  sheet: string,
  ref: string,
): HyperlinkObject | undefined {
  return sheetOf(inventory, sheet, 'findHyperlink').hyperlinks.find((item) => item.ref === ref);
}

/** 查图片（按名字）；不存在返回 `undefined`。 */
export function findImage(
  inventory: ObjectInventory,
  sheet: string,
  name: string,
): ImageObject | undefined {
  return sheetOf(inventory, sheet, 'findImage').images.find((item) => item.name === name);
}

// ---------------------------------------------------------------------------
// 操作：批注
// ---------------------------------------------------------------------------

/** 加一条批注（同一格只能有一条 ⇒ 已存在则抛）。@throws {ValidationError} */
export function addComment(
  workbook: WorkbookState,
  inventory: ObjectInventory,
  sheet: string,
  comment: { readonly ref: string; readonly author: string; readonly text: string },
): ObjectInventory {
  const ref = normalizeCellRef(workbook, sheet, comment.ref, 'addComment');
  const current = sheetOf(inventory, sheet, 'addComment');
  if (current.comments.some((item) => item.ref === ref)) {
    throw new ValidationError(`addComment：${sheet}!${ref} 已有批注（一格一条）`);
  }
  const entry: CommentObject = Object.freeze({
    ref,
    author: requireNonEmpty(comment.author, 'comment.author'),
    text: requireNonEmpty(comment.text, 'comment.text'),
  });
  return withSheet(
    inventory,
    Object.freeze({ ...current, comments: Object.freeze([...current.comments, entry]) }),
  );
}

/** 改批注（文本 / 作者）；不存在 ⇒ 抛。@throws {ValidationError} */
export function updateComment(
  inventory: ObjectInventory,
  sheet: string,
  ref: string,
  patch: { readonly author?: string; readonly text?: string },
): ObjectInventory {
  const current = sheetOf(inventory, sheet, 'updateComment');
  if (!current.comments.some((item) => item.ref === ref)) {
    throw new ValidationError(`updateComment：${sheet}!${ref} 没有批注`);
  }
  return withSheet(
    inventory,
    Object.freeze({
      ...current,
      comments: Object.freeze(
        current.comments.map((item) =>
          item.ref === ref
            ? Object.freeze({
                ref: item.ref,
                author: patch.author === undefined ? item.author : requireNonEmpty(patch.author, 'comment.author'),
                text: patch.text === undefined ? item.text : requireNonEmpty(patch.text, 'comment.text'),
              })
            : item,
        ),
      ),
    }),
  );
}

/** 删批注；不存在 ⇒ 抛（不静默成功）。@throws {ValidationError} */
export function removeComment(inventory: ObjectInventory, sheet: string, ref: string): ObjectInventory {
  const current = sheetOf(inventory, sheet, 'removeComment');
  if (!current.comments.some((item) => item.ref === ref)) {
    throw new ValidationError(`removeComment：${sheet}!${ref} 没有批注`);
  }
  return withSheet(
    inventory,
    Object.freeze({
      ...current,
      comments: Object.freeze(current.comments.filter((item) => item.ref !== ref)),
    }),
  );
}

// ---------------------------------------------------------------------------
// 操作：超链接
// ---------------------------------------------------------------------------

function validateTarget(target: HyperlinkTarget, where: string): HyperlinkTarget {
  if (target.kind === 'external') {
    const url = requireNonEmpty(target.url, `${where}.url`);
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) {
      throw new ValidationError(`${where}.url 必须是带协议的绝对 URL（如 https://…）：${JSON.stringify(url)}`);
    }
    return Object.freeze({ kind: 'external' as const, url });
  }
  if (target.kind === 'internal') {
    const location = requireNonEmpty(target.location, `${where}.location`);
    if (!/^(?:'[^']+'|[^'!]+)![A-Za-z]{1,3}\d{1,7}$/.test(location)) {
      throw new ValidationError(
        `${where}.location 必须是工作表限定的单元格地址（如 预算!A1 或 '预算 表'!A1）：${JSON.stringify(location)}`,
      );
    }
    return Object.freeze({ kind: 'internal' as const, location });
  }
  /* c8 ignore next -- 判别联合已封闭 */
  throw new ValidationError(`${where} 的目标类型未知`);
}

/** 加一条超链接（同一格只能有一条）。@throws {ValidationError} */
export function addHyperlink(
  workbook: WorkbookState,
  inventory: ObjectInventory,
  sheet: string,
  hyperlink: {
    readonly ref: string;
    readonly target: HyperlinkTarget;
    readonly tooltip?: string;
    readonly display?: string;
  },
): ObjectInventory {
  const ref = normalizeCellRef(workbook, sheet, hyperlink.ref, 'addHyperlink');
  const current = sheetOf(inventory, sheet, 'addHyperlink');
  if (current.hyperlinks.some((item) => item.ref === ref)) {
    throw new ValidationError(`addHyperlink：${sheet}!${ref} 已有超链接（一格一条）`);
  }
  const entry: HyperlinkObject = Object.freeze({
    ref,
    target: validateTarget(hyperlink.target, 'hyperlink.target'),
    ...(hyperlink.tooltip === undefined ? {} : { tooltip: hyperlink.tooltip }),
    ...(hyperlink.display === undefined ? {} : { display: hyperlink.display }),
  });
  return withSheet(
    inventory,
    Object.freeze({ ...current, hyperlinks: Object.freeze([...current.hyperlinks, entry]) }),
  );
}

/** 改超链接（目标 / 提示 / 显示文本）；不存在 ⇒ 抛。@throws {ValidationError} */
export function updateHyperlink(
  inventory: ObjectInventory,
  sheet: string,
  ref: string,
  patch: {
    readonly target?: HyperlinkTarget;
    readonly tooltip?: string;
    readonly display?: string;
  },
): ObjectInventory {
  const current = sheetOf(inventory, sheet, 'updateHyperlink');
  if (!current.hyperlinks.some((item) => item.ref === ref)) {
    throw new ValidationError(`updateHyperlink：${sheet}!${ref} 没有超链接`);
  }
  return withSheet(
    inventory,
    Object.freeze({
      ...current,
      hyperlinks: Object.freeze(
        current.hyperlinks.map((item) => {
          if (item.ref !== ref) return item;
          const next: HyperlinkObject = {
            ref: item.ref,
            target: patch.target === undefined ? item.target : validateTarget(patch.target, 'hyperlink.target'),
            ...((patch.tooltip ?? item.tooltip) === undefined ? {} : { tooltip: patch.tooltip ?? item.tooltip }),
            ...((patch.display ?? item.display) === undefined ? {} : { display: patch.display ?? item.display }),
          };
          return Object.freeze(next);
        }),
      ),
    }),
  );
}

/** 删超链接；不存在 ⇒ 抛。@throws {ValidationError} */
export function removeHyperlink(
  inventory: ObjectInventory,
  sheet: string,
  ref: string,
): ObjectInventory {
  const current = sheetOf(inventory, sheet, 'removeHyperlink');
  if (!current.hyperlinks.some((item) => item.ref === ref)) {
    throw new ValidationError(`removeHyperlink：${sheet}!${ref} 没有超链接`);
  }
  return withSheet(
    inventory,
    Object.freeze({
      ...current,
      hyperlinks: Object.freeze(current.hyperlinks.filter((item) => item.ref !== ref)),
    }),
  );
}

// ---------------------------------------------------------------------------
// 操作：图片
// ---------------------------------------------------------------------------

/** 下一个空闲的媒体编号（避开既有 `xl/media/imageN.*`）。 */
function nextMediaIndex(parts: readonly StoredPart[]): number {
  let highest = 0;
  for (const part of parts) {
    const match = /^xl\/media\/image(\d+)\.[A-Za-z0-9]+$/.exec(part.path);
    if (match !== null) {
      highest = Math.max(highest, Number(match[1] ?? '0'));
    }
  }
  return highest + 1;
}

/**
 * 加一张图片（媒体字节进入 `parts`，对象进入模型）。同名 ⇒ 抛。@throws {ValidationError}
 */
export function addImage(
  workbook: WorkbookState,
  inventory: ObjectInventory,
  sheet: string,
  image: {
    readonly name: string;
    readonly content_type: string;
    readonly data: Uint8Array;
    readonly anchor: ObjectAnchor;
  },
): ObjectInventory {
  const current = sheetOf(inventory, sheet, 'addImage');
  const name = requireNonEmpty(image.name, 'image.name');
  if (current.images.some((item) => item.name === name)) {
    throw new ValidationError(`addImage 拒绝重名：${sheet} 上已有图片 ${JSON.stringify(name)}`);
  }
  if (MEDIA_EXTENSIONS[image.content_type] === undefined) {
    throw new ValidationError(
      `不支持的图片内容类型 ${JSON.stringify(image.content_type)}（支持 ${Object.keys(MEDIA_EXTENSIONS).join(' / ')}）`,
    );
  }
  if (!(image.data instanceof Uint8Array) || image.data.length === 0) {
    throw new ValidationError('addImage 的 data 必须是非空的 Uint8Array（图片字节）');
  }
  const sheetState = getSheet(workbook, sheet);
  /* c8 ignore next -- sheetOf 已保证表在清单里 */
  if (sheetState === undefined) {
    throw new ValidationError(`addImage：工作簿里没有工作表 ${JSON.stringify(sheet)}`);
  }
  const anchor = validateAnchor(image.anchor, 'image.anchor');
  if (
    anchor.to_column > sheetState.column_count ||
    anchor.to_row > sheetState.row_count
  ) {
    throw new ValidationError(
      `addImage 的锚点超出工作表 ${JSON.stringify(sheet)} 的声明范围（${String(sheetState.column_count)} 列 × ${String(sheetState.row_count)} 行）`,
    );
  }
  // `mediaPartPath` 收的是 **0 起**下标；`nextMediaIndex` 给的是下一个**可用编号**（1 起）
  const path = mediaPartPath(nextMediaIndex(inventory.parts) - 1, image.content_type);
  const entry: ImageObject = Object.freeze({
    name,
    media_path: path,
    content_type: image.content_type,
    anchor,
    relationship_id: null,
  });
  return Object.freeze({
    ...withSheet(inventory, Object.freeze({ ...current, images: Object.freeze([...current.images, entry]) })),
    parts: Object.freeze([...inventory.parts, Object.freeze({ path, content_type: image.content_type, data: image.data })]),
  });
}

/** 改图片位置 / 尺寸。@throws {ValidationError} */
export function setImageAnchor(
  workbook: WorkbookState,
  inventory: ObjectInventory,
  sheet: string,
  name: string,
  anchor: ObjectAnchor,
): ObjectInventory {
  const current = sheetOf(inventory, sheet, 'setImageAnchor');
  if (!current.images.some((item) => item.name === name)) {
    throw new ValidationError(`setImageAnchor：${sheet} 上没有图片 ${JSON.stringify(name)}`);
  }
  const sheetState = getSheet(workbook, sheet);
  const validated = validateAnchor(anchor, 'image.anchor');
  if (
    sheetState !== undefined &&
    (validated.to_column > sheetState.column_count || validated.to_row > sheetState.row_count)
  ) {
    throw new ValidationError(`setImageAnchor 的锚点超出工作表 ${JSON.stringify(sheet)} 的声明范围`);
  }
  return withSheet(
    inventory,
    Object.freeze({
      ...current,
      images: Object.freeze(
        current.images.map((item) =>
          item.name === name ? Object.freeze({ ...item, anchor: validated }) : item,
        ),
      ),
    }),
  );
}

/** 重命名图片。@throws {ValidationError} */
export function renameImage(
  inventory: ObjectInventory,
  sheet: string,
  name: string,
  next: string,
): ObjectInventory {
  const current = sheetOf(inventory, sheet, 'renameImage');
  if (!current.images.some((item) => item.name === name)) {
    throw new ValidationError(`renameImage：${sheet} 上没有图片 ${JSON.stringify(name)}`);
  }
  const target = requireNonEmpty(next, 'image.name');
  if (current.images.some((item) => item.name === target)) {
    throw new ValidationError(`renameImage 拒绝重名：${JSON.stringify(target)}`);
  }
  return withSheet(
    inventory,
    Object.freeze({
      ...current,
      images: Object.freeze(
        current.images.map((item) => (item.name === name ? Object.freeze({ ...item, name: target }) : item)),
      ),
    }),
  );
}

/** 删图片（**连同没有人再引用的媒体部件**）；不存在 ⇒ 抛。@throws {ValidationError} */
export function removeImage(
  inventory: ObjectInventory,
  sheet: string,
  name: string,
): ObjectInventory {
  const current = sheetOf(inventory, sheet, 'removeImage');
  const target = current.images.find((item) => item.name === name);
  if (target === undefined) {
    throw new ValidationError(`removeImage：${sheet} 上没有图片 ${JSON.stringify(name)}`);
  }
  const nextSheets = withSheet(
    inventory,
    Object.freeze({ ...current, images: Object.freeze(current.images.filter((item) => item.name !== name)) }),
  );
  const stillUsed = nextSheets.sheets.some((entry) =>
    entry.images.some((item) => item.media_path === target.media_path),
  );
  if (stillUsed) {
    return nextSheets;
  }
  return Object.freeze({
    ...nextSheets,
    parts: Object.freeze(nextSheets.parts.filter((part) => part.path !== target.media_path)),
  });
}

/** 媒体部件的字节（读回 / 断言用）；找不到返回 `undefined`。 */
export function storedPart(inventory: ObjectInventory, path: string): StoredPart | undefined {
  return inventory.parts.find((part) => part.path === path);
}

// ---------------------------------------------------------------------------
// XML：批注 / VML / 绘图 / 超链接
// ---------------------------------------------------------------------------

/** 生成 `xl/commentsN.xml`（作者表 + 批注表）。 */
export function buildCommentsXml(comments: readonly CommentObject[]): string {
  const authors: string[] = [];
  for (const comment of comments) {
    if (!authors.includes(comment.author)) authors.push(comment.author);
  }
  const root = el(
    'comments',
    [attr('xmlns', SPREADSHEETML_NAMESPACE)],
    [
      el('authors', [], authors.map((author) => el('author', [], [author]))),
      el(
        'commentList',
        [],
        comments.map((comment) =>
          el('comment', [attr('ref', comment.ref), attr('authorId', String(authors.indexOf(comment.author)))], [
            el('text', [], [el('r', [], [el('t', [], [comment.text])])]),
          ]),
        ),
      ),
    ],
  );
  return serializeXmlDocument(root);
}

/**
 * 生成旧式批注形状 `xl/drawings/vmlDrawingN.vml`。
 *
 * 每个批注一个 `v:shape` + `x:ClientData ObjectType="Note"`，其中的 `x:Row` / `x:Column`
 * 是**0 起**的单元格坐标。VML 是 Excel 里遗留批注框的载体；没有它，批注在真实 Excel 里
 * 没有可视形状（本仓**未在真实 Excel 中验证**这一点）。
 */
export function buildVmlDrawingXml(comments: readonly CommentObject[]): string {
  const shapes = comments.map((comment, index) => {
    const address = parseCellAddress(comment.ref);
    const column = address.column - 1;
    const row = address.row - 1;
    const anchor = `${String(column + 1)}, 15, ${String(row)}, 2, ${String(column + 3)}, 15, ${String(row + 4)}, 4`;
    return el(
      'v:shape',
      [
        attr('id', `_x0000_s${String(1025 + index)}`),
        attr('type', '#_x0000_t202'),
        attr(
          'style',
          `position:absolute;margin-left:${String(59.25 + index)}pt;margin-top:1.5pt;width:108pt;height:59.25pt;z-index:${String(index + 1)};visibility:hidden`,
        ),
        attr('fillcolor', '#ffffe1'),
        attr('o:insetmode', 'auto'),
      ],
      [
        el('v:fill', [attr('color2', '#ffffe1')]),
        el('v:shadow', [attr('on', 't'), attr('color', 'black'), attr('obscured', 't')]),
        el('v:path', [attr('o:connecttype', 'none')]),
        el('v:textbox', [attr('style', 'mso-direction-alt:auto')], [
          el('div', [attr('style', 'text-align:left')]),
        ]),
        el('x:ClientData', [attr('ObjectType', 'Note')], [
          el('x:MoveWithCells', []),
          el('x:SizeWithCells', []),
          el('x:Anchor', [], [anchor]),
          el('x:AutoFill', [], ['False']),
          el('x:Row', [], [String(row)]),
          el('x:Column', [], [String(column)]),
        ]),
      ],
    );
  });
  const root = el(
    'xml',
    [
      attr('xmlns:v', 'urn:schemas-microsoft-com:vml'),
      attr('xmlns:o', 'urn:schemas-microsoft-com:office:office'),
      attr('xmlns:x', 'urn:schemas-microsoft-com:office:excel'),
    ],
    [
      el('o:shapelayout', [attr('v:ext', 'edit')], [
        el('o:idmap', [attr('v:ext', 'edit'), attr('data', '1')]),
      ]),
      el(
        'v:shapetype',
        [
          attr('id', '_x0000_t202'),
          attr('coordsize', '21600,21600'),
          attr('o:spt', '202'),
          attr('path', 'm,l,21600r21600,l21600,xe'),
        ],
        [
          el('v:stroke', [attr('joinstyle', 'miter')]),
          el('v:path', [attr('gradientshapeok', 't'), attr('o:connecttype', 'rect')]),
        ],
      ),
      ...shapes,
    ],
  );
  return serializeXmlDocument(root);
}

function anchorEdge(tag: 'xdr:from' | 'xdr:to', column: number, row: number): XmlElement {
  return el(tag, [], [
    el('xdr:col', [], [String(column - 1)]),
    el('xdr:colOff', [], ['0']),
    el('xdr:row', [], [String(row - 1)]),
    el('xdr:rowOff', [], ['0']),
  ]);
}

function imageAnchorElement(image: ImageObject, relationshipId: string, index: number): XmlElement {
  return el('xdr:twoCellAnchor', [attr('editAs', 'oneCell')], [
    anchorEdge('xdr:from', image.anchor.from_column, image.anchor.from_row),
    anchorEdge('xdr:to', image.anchor.to_column, image.anchor.to_row),
    el('xdr:pic', [], [
      el('xdr:nvPicPr', [], [
        el('xdr:cNvPr', [attr('id', String(index + 2)), attr('name', image.name), attr('descr', '')]),
        el('xdr:cNvPicPr', [], [el('a:picLocks', [attr('noChangeAspect', '1')])]),
      ]),
      el('xdr:blipFill', [], [
        el('a:blip', [
          attr('xmlns:r', OFFICE_RELATIONSHIPS_NAMESPACE),
          attr('r:embed', relationshipId),
        ]),
        el('a:stretch', [], [el('a:fillRect', [])]),
      ]),
      el('xdr:spPr', [], [
        el('a:xfrm', [], [el('a:off', [attr('x', '0'), attr('y', '0')]), el('a:ext', [attr('cx', '0'), attr('cy', '0')])]),
        el('a:prstGeom', [attr('prst', 'rect')], [el('a:avLst', [])]),
      ]),
    ]),
    el('xdr:clientData', []),
  ]);
}

/**
 * 生成 `xl/drawings/drawingN.xml`：**未建模锚点逐字在前**（不经任何加工），
 * 图片锚点在后。`imageRelationshipIds` 与 `images` 一一对应。
 */
export function buildDrawingXml(
  drawing: DrawingRecord | null,
  images: readonly ImageObject[],
  imageRelationshipIds: readonly string[],
): string {
  if (images.length !== imageRelationshipIds.length) {
    throw new ValidationError('图片数与关系 id 数不一致：每张图片必须有一条 drawing → image 关系');
  }
  const rootAttributes: XmlAttribute[] = [
    attr('xmlns:xdr', SPREADSHEET_DRAWING_NAMESPACE),
    attr('xmlns:a', DRAWINGML_MAIN_NAMESPACE),
  ];
  for (const declaration of drawing?.root_namespaces ?? []) {
    if (declaration.name.startsWith('xmlns:') && !rootAttributes.some((item) => item.name === declaration.name)) {
      rootAttributes.push(declaration);
    }
  }
  const children: string[] = [
    ...(drawing?.opaque_anchors ?? []),
    ...images.map((image, index) =>
      serializeXmlNode(imageAnchorElement(image, imageRelationshipIds[index] as string, index)),
    ),
  ];
  const empty = serializeXmlDocument(el('xdr:wsDr', rootAttributes, []));
  if (children.length === 0) {
    return empty;
  }
  // 自闭合的 `<xdr:wsDr …/>` → 展开成有子节点的形态（`/>` 是最后两个字符）
  return `${empty.slice(0, -2)}>${children.join('')}</xdr:wsDr>`;
}

/** 工作表里的 `<hyperlinks>` 子元素（外部链接带 r:id，内部链接带 location）。 */
export function hyperlinksElement(
  hyperlinks: readonly HyperlinkObject[],
  relationshipIds: readonly (string | null)[],
): XmlElement | null {
  if (hyperlinks.length === 0) return null;
  if (hyperlinks.length !== relationshipIds.length) {
    throw new ValidationError('超链接数与关系 id 数不一致');
  }
  return el(
    'hyperlinks',
    [],
    hyperlinks.map((hyperlink, index) => {
      const attributes: XmlAttribute[] = [attr('ref', hyperlink.ref)];
      const relationshipId = relationshipIds[index];
      if (typeof relationshipId === 'string') attributes.push(attr('r:id', relationshipId));
      if (hyperlink.target.kind === 'internal') {
        attributes.push(attr('location', hyperlink.target.location));
      }
      if (hyperlink.tooltip !== undefined) attributes.push(attr('tooltip', hyperlink.tooltip));
      if (hyperlink.display !== undefined) attributes.push(attr('display', hyperlink.display));
      return el('hyperlink', attributes);
    }),
  );
}

// ---------------------------------------------------------------------------
// 写出
// ---------------------------------------------------------------------------

/** 工作表路径（第 index 张 → `xl/worksheets/sheetN.xml`）。 */
function worksheetPath(index: number): string {
  return `xl/worksheets/sheet${String(index + 1)}.xml`;
}

/** 找出下一个空闲的编号（避开清单里已占用的部件路径）。 */
function nextFreeIndex(parts: readonly StoredPart[], pattern: RegExp): number {
  let highest = 0;
  for (const part of parts) {
    const match = pattern.exec(part.path);
    if (match !== null) highest = Math.max(highest, Number(match[1] ?? '0'));
  }
  return highest + 1;
}

/**
 * 写出**带对象**的真实 .xlsx。
 *
 * 工作簿本体仍由既有写入器生成；本函数追加批注 / VML / 绘图 / 媒体部件与全部关系，
 * 并把 `parts` 里原样带回的部件与关系一起写回去。
 *
 * 同一 `(workbook, inventory)` ⇒ 同一字节。
 *
 * @throws {ValidationError} 清单指向不存在的工作表 / 关系声明非法
 */
export function writeObjectWorkbookXlsx(
  workbook: WorkbookState,
  inventory: ObjectInventory,
): SpreadsheetPackageResult {
  const parts: OpcPart[] = inventory.parts.map((part) => ({
    path: part.path,
    content_type: part.content_type,
    data: part.data,
  }));
  const relationships: RelationshipGroup[] = [];
  const transforms: { part_path: string; root_attributes?: readonly XmlAttribute[]; children?: readonly string[] }[] = [];
  const sheetLevelGroups = new Map<string, RelationshipDeclaration[]>();

  // 原有保留关系：先按持有者分组（工作表级的、本模块会重建的类型除外）。
  const preservedSheetTypes = new Set(REGENERATED_SHEET_RELATIONSHIP_TYPES);
  for (const group of inventory.preserved_relationships) {
    if (group.owner_part_path !== null && group.owner_part_path.startsWith('xl/worksheets/')) {
      const kept = group.declarations.filter((declaration) => !preservedSheetTypes.has(declaration.type));
      if (kept.length === 0) continue;
      const existing = sheetLevelGroups.get(group.owner_part_path) ?? [];
      existing.push(...kept);
      sheetLevelGroups.set(group.owner_part_path, existing);
      continue;
    }
    relationships.push({
      owner_part_path: group.owner_part_path,
      declarations: [...group.declarations],
    });
  }

  let commentsNumber = nextFreeIndex(inventory.parts, /^xl\/comments(\d+)\.xml$/);
  let vmlNumber = nextFreeIndex(inventory.parts, /^xl\/drawings\/vmlDrawing(\d+)\.vml$/);
  let drawingNumber = nextFreeIndex(inventory.parts, /^xl\/drawings\/drawing(\d+)\.xml$/);

  for (const sheetObjects of inventory.sheets) {
    const index = workbook.sheets.findIndex((sheet) => sheet.name === sheetObjects.sheet);
    if (index < 0) {
      throw new ValidationError(
        `对象清单指向不存在的工作表 ${JSON.stringify(sheetObjects.sheet)}：工作簿变了，清单必须重建`,
      );
    }
    const owner = worksheetPath(index);
    const declarations = sheetLevelGroups.get(owner) ?? [];
    const children: string[] = [];

    // ① 超链接：外部链接各占一条工作表级关系（顺序 = 数组顺序）
    const hyperlinkIds: (string | null)[] = sheetObjects.hyperlinks.map((hyperlink) => {
      if (hyperlink.target.kind === 'internal') return null;
      const id = `rId${String(declarations.length + 1)}`;
      declarations.push({ type: HYPERLINK_RELATIONSHIP_TYPE, target: hyperlink.target.url, target_mode: 'External' });
      return id;
    });
    const hyperlinks = hyperlinksElement(sheetObjects.hyperlinks, hyperlinkIds);
    if (hyperlinks !== null) {
      children.push(serializeXmlNode(hyperlinks));
    }

    // ② 绘图：未建模锚点 + 图片
    const drawing = sheetObjects.drawing;
    if (sheetObjects.images.length > 0 || (drawing !== null && drawing.opaque_anchors.length > 0)) {
      const preserved = drawing?.preserved_relationships ?? [];
      const drawingDeclarations: RelationshipDeclaration[] = preserved.map((declaration) => ({ ...declaration }));
      // 保留声明的编号**一个字都不动**（未建模锚点的 r:id 靠它续命）；
      // 新图片从保留声明之后接着编号。
      let newImages = 0;
      const imageIds = sheetObjects.images.map((image) => {
        if (image.relationship_id !== null) {
          return image.relationship_id;
        }
        newImages += 1;
        const id = `rId${String(preserved.length + newImages)}`;
        drawingDeclarations.push({
          type: IMAGE_RELATIONSHIP_TYPE,
          target: relativeMediaTarget(image.media_path),
        });
        return id;
      });
      const path = drawingPartPath(drawingNumber - 1);
      drawingNumber += 1;
      parts.push({
        path,
        content_type: XLSX_DRAWING_CONTENT_TYPE,
        data: buildDrawingXml(drawing, sheetObjects.images, imageIds),
      });
      relationships.push({ owner_part_path: path, declarations: drawingDeclarations });
      declarations.push({ type: DRAWING_RELATIONSHIP_TYPE, target: `../drawings/${basename(path)}` });
      children.push(serializeXmlNode(el('drawing', [attr('r:id', `rId${String(declarations.length)}`)])));
    }

    // ③ 批注：comments 部件 + VML 形状 + legacyDrawing 关系
    if (sheetObjects.comments.length > 0) {
      const commentsPath = commentsPartPath(commentsNumber - 1);
      commentsNumber += 1;
      parts.push({
        path: commentsPath,
        content_type: XLSX_COMMENTS_CONTENT_TYPE,
        data: buildCommentsXml(sheetObjects.comments),
      });
      declarations.push({ type: COMMENTS_RELATIONSHIP_TYPE, target: `../${basename(commentsPath)}` });

      const vmlPath = vmlDrawingPartPath(vmlNumber - 1);
      vmlNumber += 1;
      parts.push({
        path: vmlPath,
        content_type: XLSX_VML_DRAWING_CONTENT_TYPE,
        data: buildVmlDrawingXml(sheetObjects.comments),
      });
      declarations.push({ type: VML_DRAWING_RELATIONSHIP_TYPE, target: `../drawings/${basename(vmlPath)}` });

      children.push(serializeXmlNode(el('legacyDrawing', [attr('r:id', `rId${String(declarations.length)}`)])));
    }

    if (declarations.length > 0) {
      sheetLevelGroups.set(owner, declarations);
    }
    if (children.length > 0) {
      transforms.push({
        part_path: owner,
        root_attributes: [attr('xmlns:r', OFFICE_RELATIONSHIPS_NAMESPACE)],
        children,
      });
    }
  }

  relationships.push(
    ...[...sheetLevelGroups.entries()].map(([owner, declarations]) => ({
      owner_part_path: owner,
      declarations,
    })),
  );

  return composeWorkbookPackage(workbook, {
    parts,
    relationships,
    transforms,
    content_type_defaults: inventory.content_type_defaults,
  });
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** 媒体部件的绘图级关系目标（相对 `xl/drawings/`）。 */
function relativeMediaTarget(mediaPath: string): string {
  return `../media/${basename(mediaPath)}`;
}

// ---------------------------------------------------------------------------
// 读回（"已有对象保留"的入口）
// ---------------------------------------------------------------------------

interface ContentTypes {
  readonly defaults: ReadonlyMap<string, string>;
  readonly overrides: ReadonlyMap<string, string>;
}

function parseContentTypes(root: ParsedXmlElement | undefined): ContentTypes {
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  if (root === undefined) return { defaults, overrides };
  for (const child of childElements(root)) {
    if (child.localName === 'Default') {
      const extension = attributeValue(child, '', 'Extension');
      const type = attributeValue(child, '', 'ContentType');
      if (extension !== null && type !== null) defaults.set(extension.toLowerCase(), type);
    } else if (child.localName === 'Override') {
      const partName = attributeValue(child, '', 'PartName');
      const type = attributeValue(child, '', 'ContentType');
      if (partName !== null && type !== null) overrides.set(partName.replace(/^\/+/, ''), type);
    }
  }
  return { defaults, overrides };
}

function resolveContentType(path: string, types: ContentTypes): string {
  const override = types.overrides.get(path);
  if (override !== undefined) return override;
  const dot = path.lastIndexOf('.');
  if (dot !== -1) {
    const byExtension = types.defaults.get(path.slice(dot + 1).toLowerCase());
    if (byExtension !== undefined) return byExtension;
  }
  return 'application/octet-stream';
}

function childrenOf(element: ParsedXmlElement | null): readonly ParsedXmlElement[] {
  return element === null ? [] : childElements(element);
}

function elementsNamed(element: ParsedXmlElement | null, localName: string): readonly ParsedXmlElement[] {
  return childrenOf(element).filter((child) => child.localName === localName);
}

/** 递归找第一个后代元素（按本地名）。 */
function findDeep(element: ParsedXmlElement, localName: string): ParsedXmlElement | null {
  for (const child of childrenOf(element)) {
    if (child.localName === localName) return child;
    const nested = findDeep(child, localName);
    if (nested !== null) return nested;
  }
  return null;
}

function parseRels(bytes: Uint8Array | undefined): readonly { id: string; declaration: RelationshipDeclaration }[] {
  if (bytes === undefined) return [];
  const root = parseXmlBytes(bytes);
  const entries: { id: string; declaration: RelationshipDeclaration }[] = [];
  for (const child of elementsNamed(root, 'Relationship')) {
    const id = attributeValue(child, '', 'Id');
    const type = attributeValue(child, '', 'Type');
    const target = attributeValue(child, '', 'Target');
    if (id === null || type === null || target === null) continue;
    entries.push({
      id,
      declaration:
        attributeValue(child, '', 'TargetMode') === 'External'
          ? { type, target, target_mode: 'External' }
          : { type, target },
    });
  }
  return entries;
}

function resolveRelative(ownerPath: string, target: string): string {
  const base = ownerPath.slice(0, ownerPath.lastIndexOf('/') + 1);
  const stack: string[] = [];
  for (const segment of `${base}${target}`.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join('/');
}

/** 从绘图部件里读出图片锚点（`xdr:pic`）与未建模锚点。 */
function readDrawing(
  root: ParsedXmlElement,
  drawingPath: string,
  rels: readonly { id: string; declaration: RelationshipDeclaration }[],
  mediaTypes: (mediaPath: string) => string,
): {
  readonly images: readonly ImageObject[];
  readonly drawing: DrawingRecord;
} {
  const declarationById = new Map(rels.map((entry) => [entry.id, entry.declaration]));
  const images: ImageObject[] = [];
  const opaque: string[] = [];
  for (const anchor of childrenOf(root)) {
    if (anchor.localName !== 'twoCellAnchor' && anchor.localName !== 'oneCellAnchor' && anchor.localName !== 'absoluteAnchor') {
      continue;
    }
    const pic = findDeep(anchor, 'pic');
    if (pic === null) {
      opaque.push(serializeParsedXmlNode(anchor));
      continue;
    }
    const from = elementsNamed(anchor, 'from')[0];
    const to = elementsNamed(anchor, 'to')[0];
    const blip = findDeep(pic, 'blip');
    const embed = blip === null ? null : attributeValue(blip, OFFICE_RELATIONSHIPS_NAMESPACE, 'embed');
    const declaration = embed === null ? undefined : declarationById.get(embed);
    const cNvPr = findDeep(pic, 'cNvPr');
    if (from === undefined || to === undefined || embed === null || declaration === undefined) {
      // 结构不认识 ⇒ 当作未建模片段原样保留（宁可不解析，也不猜）
      opaque.push(serializeParsedXmlNode(anchor));
      continue;
    }
    const mediaPath = resolveRelative(drawingPath, declaration.target);
    images.push(
      Object.freeze({
        name: cNvPr === null ? `图片${String(images.length + 1)}` : (attributeValue(cNvPr, '', 'name') ?? '图片'),
        media_path: mediaPath,
        content_type: mediaTypes(mediaPath),
        anchor: Object.freeze({
          from_column: edgeNumber(from, 'col') + 1,
          from_row: edgeNumber(from, 'row') + 1,
          to_column: edgeNumber(to, 'col') + 1,
          to_row: edgeNumber(to, 'row') + 1,
        }),
        relationship_id: embed,
      }),
    );
  }
  return {
    images: Object.freeze(images),
    drawing: Object.freeze({
      root_namespaces: Object.freeze(
        Object.entries(root.namespaces)
          .filter(([prefix]) => prefix !== '' && prefix !== 'xdr' && prefix !== 'a')
          .map(([prefix, uri]) => attr(`xmlns:${prefix}`, uri)),
      ),
      opaque_anchors: Object.freeze(opaque),
      preserved_relationships: Object.freeze(rels.map((entry) => entry.declaration)),
    }),
  };
}

function edgeNumber(edge: ParsedXmlElement, localName: string): number {
  const child = elementsNamed(edge, localName)[0];
  const value = child === undefined ? 0 : Number(directText(child));
  return Number.isFinite(value) ? value : 0;
}

/** 读一张工作表时收集到的中间形态（工作表路径 + 关系 + 对象）。 */
interface ParsedSheet {
  readonly objects: SheetObjects;
  readonly path: string;
  readonly rels: readonly { readonly id: string; readonly declaration: RelationshipDeclaration }[];
  /** 该表的绘图部件路径（被本模块重建时非空）。 */
  readonly drawing_path: string | null;
}

function relsPathOf(partPath: string): string {
  return `xl/worksheets/_rels/${basename(partPath)}.rels`;
}

function externalTarget(
  rels: readonly { readonly id: string; readonly declaration: RelationshipDeclaration }[],
  relationshipId: string,
): HyperlinkTarget | null {
  const declaration = rels.find((entry) => entry.id === relationshipId)?.declaration;
  return declaration === undefined ? null : Object.freeze({ kind: 'external' as const, url: declaration.target });
}

function textOfRuns(container: ParsedXmlElement | null): string {
  if (container === null) return '';
  let text = '';
  for (const child of childrenOf(container)) {
    if (child.localName === 't') text += directText(child);
    else if (child.localName === 'r') text += textOfRuns(child);
  }
  return text;
}

/**
 * 读回一份 .xlsx 里的对象清单（**全部来自真实字节**）。
 *
 * 读得到：批注（`xl/commentsN.xml` + 作者）、超链接（工作表 `<hyperlinks>` + 关系表）、
 * 图片（绘图锚点 + 媒体部件）、以及**一切本模块不建模的部件与关系**（原样带回，写回时逐字节写出）。
 *
 * 判定"重建还是保留"的口径：一个部件只要被本模块**重建**（该表有批注 / 有图片 / 有未建模锚点），
 * 就不进 `parts`（避免同一路径两份内容）；否则原样进 `parts`。
 *
 * @throws {ValidationError} 包结构不合法（缺 `xl/workbook.xml`）
 */
export function readWorkbookObjects(bytes: Uint8Array): ObjectInventory {
  const archive = readZip(bytes);
  const contentTypesBytes = archive.by_path.get('[Content_Types].xml');
  const contentTypes = parseContentTypes(
    contentTypesBytes === undefined ? undefined : parseXmlBytes(contentTypesBytes.data),
  );
  const workbookPart = archive.by_path.get(XLSX_WORKBOOK_PART_PATH);
  if (workbookPart === undefined) {
    throw new ValidationError(`xlsx 缺少部件 ${XLSX_WORKBOOK_PART_PATH}`);
  }
  const root = parseXmlBytes(workbookPart.data);
  const workbookRels = new Map(
    parseRels(archive.by_path.get('xl/_rels/workbook.xml.rels')?.data).map((entry) => [
      entry.id,
      entry.declaration,
    ]),
  );

  const consumed = new Set<string>([
    '[Content_Types].xml',
    '_rels/.rels',
    XLSX_WORKBOOK_PART_PATH,
    'xl/_rels/workbook.xml.rels',
    // 样式部件由既有写入器重建（见 `xlsx-write.ts` 的 `buildStylesXml`）：这里必须消费掉，
    // 否则它会被当成"未建模部件"带回去、与生成的 styles 部件路径冲突。
    'xl/styles.xml',
    'xl/_rels/styles.xml.rels',
    // 工作簿里没有被任何对象引用的绘图部件（空绘图）也要消费吗？——不：它们原样进 parts，
    // 由 `drawingLevelGroups` 把关系一并带回。
  ]);
  const parsedSheets: ParsedSheet[] = [];

  for (const sheet of elementsNamed(findDeep(root, 'sheets'), 'sheet')) {
    const name = attributeValue(sheet, '', 'name');
    const relationshipId = attributeValue(sheet, OFFICE_RELATIONSHIPS_NAMESPACE, 'id');
    if (name === null || relationshipId === null) continue;
    const declaration = workbookRels.get(relationshipId);
    if (declaration === undefined || declaration.target_mode === 'External') continue;
    const sheetPath = resolveRelative(XLSX_WORKBOOK_PART_PATH, declaration.target);
    const sheetBytes = archive.by_path.get(sheetPath)?.data;
    if (sheetBytes === undefined) continue;
    const rels = parseRels(archive.by_path.get(relsPathOf(sheetPath))?.data);

    // ① 批注
    const comments: CommentObject[] = [];
    for (const entry of rels) {
      if (entry.declaration.type !== COMMENTS_RELATIONSHIP_TYPE) continue;
      const commentsPath = resolveRelative(sheetPath, entry.declaration.target);
      const commentsBytes = archive.by_path.get(commentsPath)?.data;
      if (commentsBytes === undefined) continue;
      const commentsRoot = parseXmlBytes(commentsBytes);
      const authors = elementsNamed(findDeep(commentsRoot, 'authors'), 'author').map((author) =>
        directText(author),
      );
      for (const comment of elementsNamed(findDeep(commentsRoot, 'commentList'), 'comment')) {
        const ref = attributeValue(comment, '', 'ref');
        if (ref === null) continue;
        const authorId = Number(attributeValue(comment, '', 'authorId') ?? '0');
        comments.push(
          Object.freeze({
            ref,
            author: authors[authorId] ?? '',
            text: textOfRuns(findDeep(comment, 'text')),
          }),
        );
      }
      consumed.add(commentsPath);
    }

    // ② 超链接
    const hyperlinks: HyperlinkObject[] = [];
    for (const hyperlink of elementsNamed(findDeep(parseXmlBytes(sheetBytes), 'hyperlinks'), 'hyperlink')) {
      const ref = attributeValue(hyperlink, '', 'ref');
      if (ref === null) continue;
      const relId = attributeValue(hyperlink, OFFICE_RELATIONSHIPS_NAMESPACE, 'id');
      const location = attributeValue(hyperlink, '', 'location');
      const target: HyperlinkTarget | null =
        relId !== null
          ? externalTarget(rels, relId)
          : location === null
            ? null
            : Object.freeze({ kind: 'internal' as const, location });
      if (target === null) continue;
      const tooltip = attributeValue(hyperlink, '', 'tooltip');
      const display = attributeValue(hyperlink, '', 'display');
      hyperlinks.push(
        Object.freeze({
          ref,
          target,
          ...(tooltip === null ? {} : { tooltip }),
          ...(display === null ? {} : { display }),
        }),
      );
    }

    // ③ 绘图（图片锚点建模；其它锚点原样保留）
    let images: readonly ImageObject[] = Object.freeze([]);
    let drawing: DrawingRecord | null = null;
    let drawingPath: string | null = null;
    for (const entry of rels) {
      if (entry.declaration.type !== DRAWING_RELATIONSHIP_TYPE) continue;
      const candidate = resolveRelative(sheetPath, entry.declaration.target);
      const drawingBytes = archive.by_path.get(candidate)?.data;
      if (drawingBytes === undefined) continue;
      const drawingRels = parseRels(archive.by_path.get(`xl/drawings/_rels/${basename(candidate)}.rels`)?.data);
      const read = readDrawing(parseXmlBytes(drawingBytes), candidate, drawingRels, (mediaPath) =>
        resolveContentType(mediaPath, contentTypes),
      );
      if (read.images.length === 0 && read.drawing.opaque_anchors.length === 0) {
        continue; // 空绘图：不消费，让它原样进 parts
      }
      images = read.images;
      drawing = read.drawing;
      drawingPath = candidate;
      consumed.add(candidate);
      consumed.add(`xl/drawings/_rels/${basename(candidate)}.rels`);
    }

    // ④ VML 形状（批注的可视框）：本模块重建 ⇒ 消费掉
    for (const entry of rels) {
      if (entry.declaration.type !== VML_DRAWING_RELATIONSHIP_TYPE) continue;
      consumed.add(resolveRelative(sheetPath, entry.declaration.target));
    }
    consumed.add(sheetPath);
    consumed.add(relsPathOf(sheetPath));

    parsedSheets.push({
      objects: Object.freeze({
        sheet: name,
        comments: Object.freeze(comments),
        hyperlinks: Object.freeze(hyperlinks),
        images,
        drawing,
      }),
      path: sheetPath,
      rels,
      drawing_path: drawingPath,
    });
  }

  // 其余一切部件原样带回（含媒体字节与未建模部件）
  const parts: StoredPart[] = [];
  for (const entry of archive.entries) {
    if (consumed.has(entry.path)) continue;
    if (entry.path.includes('/_rels/')) continue; // 关系部件由组装器按声明重建
    parts.push(
      Object.freeze({
        path: entry.path,
        content_type: resolveContentType(entry.path, contentTypes),
        data: entry.data,
      }),
    );
  }

  const preserved: PreservedRelationshipGroup[] = [];
  const rootRels = parseRels(archive.by_path.get('_rels/.rels')?.data);
  const keptRoot = rootRels
    .map((entry) => entry.declaration)
    .filter(
      (declaration) =>
        declaration.type !== 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
    )
    .filter(
      (declaration) =>
        declaration.target_mode === 'External' ||
        archive.by_path.has(declaration.target.replace(/^\/+/, '')),
    );
  if (keptRoot.length > 0) {
    preserved.push(Object.freeze({ owner_part_path: null, declarations: Object.freeze(keptRoot) }));
  }
  preserved.push(
    ...workbookLevelGroups(archive),
    ...sheetLevelGroups(archive, parsedSheets),
    ...drawingLevelGroups(archive, parsedSheets),
  );

  const contentDefaults: ContentTypeDefault[] = [];
  for (const [extension, contentType] of contentTypes.defaults) {
    if (extension === 'rels') continue;
    contentDefaults.push(Object.freeze({ extension, content_type: contentType }));
  }

  return Object.freeze({
    sheets: Object.freeze(parsedSheets.map((entry) => entry.objects)),
    parts: Object.freeze(parts),
    preserved_relationships: Object.freeze(preserved),
    content_type_defaults: Object.freeze(contentDefaults),
  });
}

/** workbook 级保留关系（worksheet / styles 由写入器重建，其余原样带回）。 */
function workbookLevelGroups(archive: ReadZipArchive): readonly PreservedRelationshipGroup[] {
  const entries = parseRels(archive.by_path.get('xl/_rels/workbook.xml.rels')?.data);
  const regenerated = new Set([
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
  ]);
  const kept = entries
    .map((entry) => entry.declaration)
    .filter((declaration) => !regenerated.has(declaration.type))
    .filter((declaration) => declaration.target_mode === 'External' || hasTarget(archive, XLSX_WORKBOOK_PART_PATH, declaration));
  return kept.length === 0
    ? []
    : [Object.freeze({ owner_part_path: XLSX_WORKBOOK_PART_PATH, declarations: Object.freeze(kept) })];
}

/** 工作表级保留关系（本模块重建的类型除外）。 */
function sheetLevelGroups(
  archive: ReadZipArchive,
  sheets: readonly ParsedSheet[],
): readonly PreservedRelationshipGroup[] {
  const regenerated = new Set(REGENERATED_SHEET_RELATIONSHIP_TYPES);
  const groups: PreservedRelationshipGroup[] = [];
  for (const sheet of sheets) {
    const kept = sheet.rels
      .map((entry) => entry.declaration)
      .filter((declaration) => !regenerated.has(declaration.type))
      .filter(
        (declaration) =>
          declaration.target_mode === 'External' || hasTarget(archive, sheet.path, declaration),
      );
    if (kept.length > 0) {
      groups.push(Object.freeze({ owner_part_path: sheet.path, declarations: Object.freeze(kept) }));
    }
  }
  return groups;
}

/** 绘图级关系：被本模块重建的绘图，其关系已存进 `DrawingRecord`；这里只处理**原样保留**的绘图部件。 */
function drawingLevelGroups(
  archive: ReadZipArchive,
  sheets: readonly ParsedSheet[],
): readonly PreservedRelationshipGroup[] {
  const groups: PreservedRelationshipGroup[] = [];
  for (const entry of archive.entries) {
    if (!/^xl\/drawings\/drawing\d+\.xml$/.test(entry.path)) continue;
    if (sheets.some((sheet) => sheet.drawing_path === entry.path)) continue; // 已重建（关系存在 DrawingRecord 里）
    const rels = parseRels(archive.by_path.get(`xl/drawings/_rels/${basename(entry.path)}.rels`)?.data);
    const kept = rels
      .map((item) => item.declaration)
      .filter((declaration) => declaration.target_mode === 'External' || hasTarget(archive, entry.path, declaration));
    if (kept.length > 0) {
      groups.push(Object.freeze({ owner_part_path: entry.path, declarations: Object.freeze(kept) }));
    }
  }
  return groups;
}

/** 某条内部关系的目标是否真的在包里（不在就丢弃——否则组装期会抛）。 */
function hasTarget(
  archive: ReadZipArchive,
  ownerPath: string,
  declaration: RelationshipDeclaration,
): boolean {
  if (declaration.target_mode === 'External') return true;
  return archive.by_path.has(resolveRelative(ownerPath, declaration.target));
}

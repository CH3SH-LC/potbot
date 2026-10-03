/**
 * 表格三样"模型装不下"的属性：**类型化描述符 + 类型化字段映射 + OOXML 片段构造**。
 *
 * ## 背景（谁在什么时候把这条路修通的）
 *
 * WF-060/061/063 的三样属性：
 *
 * | 属性 | OOXML 位置 | 模型里的落点 |
 * |---|---|---|
 * | 文字环绕与定位 | `w:tblPr/w:tblpPr` | `TableProperties.floating` |
 * | 单元格内边距 | `w:tcPr/w:tcMar` | `CellProperties.margins` |
 * | 允许跨页断行 | `w:trPr/w:cantSplit` | `RowNode.cant_split` |
 *
 * **WCF-D05** 落地时冻结模型里还没有这三处字段，因此它只能把参数存成带 `kind` 的描述符
 * 放进节点 `opaque`，并显式登记"XML 未接通"的缺口（`xml_wired: false`）。
 *
 * **WCF-D30** 把导出器侧接通（按类型化字段重建 `w:tblpPr` / `w:tcMar` / `w:cantSplit`），
 * 但明确拒绝去读 D05 的描述符通道——它没有本包的写权。
 *
 * **WCF-D40**（本批）关闭缺口：模型已有类型化字段，本包的操作**同时**写类型化字段与描述符——
 * 前者是导出器真正消费的通道（→ 真的进文件），后者保留下来给**读回**与**片段**使用
 * （既有读回 API `tableTextWrap()` / `rowBreakControl()` / `cellMargins()` 语义不变）。
 * 两条通道同源（同一个参数对象），不会各说各话。
 *
 * ## 描述符通道为什么**不删**
 *
 * 1. `opaque` 里的描述符是**读回**入口（模型没有"只读投影"层，读回靠它）；
 * 2. 与 D02 的 `raw_at_char` 等锚点项**和平共处**、保序保留（R105）；删掉会连带丢掉
 *    同数组里导入保留的片段；
 * 3. 片段构造（`...Xml()`）仍是**可独立复算**的形状证据。
 *
 * ## 描述符装不下、模型也装不下的东西（**必须说清楚**）
 *
 * - **文字环绕的锚点框**（`w:horzAnchor` / `w:vertAnchor`）：模型的 `TableFloatingPosition`
 *   只有**位置预设**（`w:tblpXSpec` / `w:tblpYSpec`）与**偏移**（`w:tblpX` / `w:tblpY`），
 *   没有锚点框字段；导出器（`src/documents/docx/word-xml.ts`，本包只读）固定写
 *   `horzAnchor="margin"` / `vertAnchor="text"`。因此**锚点框只留在描述符里**，
 *   不进 `floating` —— 这是一处**已知的、有损的**映射，见 `toTableFloatingPosition`；
 * - **`w:tblOverlap`**（浮动对象之间能否重叠）：既不是 `w:tblpPr` 的属性（D30 指出的缺陷，
 *   本批已修），模型也没有对应字段 ⇒ 只留在描述符里，`tableOverlapElement()` 单独给元素。
 */

import { attr, el, serializeXmlNode, type XmlElement } from '../../../artifacts/ooxml/xml.js';
import { DocumentModelError } from '../../model/errors.js';
import { lengthToTwips } from '../../units/index.js';
import type { Length, TableFloatingPosition } from '../../model/types.js';

/** 本包引入的扩展描述符种类（刻意不与 D02 的 `raw_*` / `section_index` 撞名）。 */
export type TableExtensionKind = 'table_text_wrap' | 'row_break_control' | 'cell_margins';

/**
 * 给证据/交付文本用的一句话（必须原样出现，别改写成乐观说法）。
 *
 * **WCF-D40 起**：三样属性已同时写进**类型化字段**与描述符，导出器消费类型化字段
 * ⇒ **XML 已接通**。这句话只说明"接通到哪一步"，不承诺渲染效果（R155/R156）。
 */
export const TYPED_FIELD_WIRING_NOTE =
  '环绕定位（w:tblpPr）、单元格内边距（w:tcMar）、禁止跨页断行（w:cantSplit）' +
  '已由 WCF-D40 接通：参数同时写进模型的类型化字段（TableProperties.floating / ' +
  'CellProperties.margins / RowNode.cant_split）与 opaque 描述符，导出器消费类型化字段。' +
  '注意：环绕的**锚点框**（w:horzAnchor/w:vertAnchor）模型没有字段，导出器固定写 ' +
  'margin/text；w:tblOverlap 同样不在模型里——两者都只留在描述符中（有损映射，未验证渲染）。';

/** 文字环绕方式（WF-060）。 */
export type TextWrapMode = 'none' | 'around' | 'topAndBottom' | 'through';

/**
 * 文字环绕的**锚点框**（`w:horzAnchor` / `w:vertAnchor`，`ST_HAnchor`）。
 *
 * 模型没有这个维度（见文件头），因此它只进描述符；导出器固定写 margin/text。
 */
export type TextWrapAnchor = 'margin' | 'page' | 'text';

const TEXT_WRAP_ANCHORS: ReadonlySet<string> = new Set<TextWrapAnchor>(['margin', 'page', 'text']);

/**
 * `w:tblpXSpec` / `w:tblpYSpec` 的合法取值（`ST_XAlign` / `ST_YAlign`）。
 *
 * **与导出器同源**：`src/documents/docx/word-xml.ts`（本包只读）里有一份同样的集合，
 * 它在那里是"写进文件前的最后一道闸"。本包必须先**在操作层**用同一份值域拒绝
 * （R140：不支持的能力操作前拒绝、被拒时文档字节不变），否则非法枚举会先被写进模型，
 * 到导出时才炸——那是"改了一半"。
 */
export const TBLP_X_SPEC: ReadonlySet<string> = new Set([
  'left',
  'center',
  'right',
  'inside',
  'outside',
]);
export const TBLP_Y_SPEC: ReadonlySet<string> = new Set([
  'top',
  'center',
  'bottom',
  'inline',
  'inside',
  'outside',
]);

/** 模型 `TableFloatingPosition` 的**位置预设**（两个 `w:tblpXSpec` / `w:tblpYSpec` 取值）。 */
export interface FloatingPositionSpec {
  readonly horizontal: string;
  readonly vertical: string;
}

/**
 * 省略位置预设时用的默认值。
 *
 * **这是默认值，不是"与调用方意图等价"**：模型的 `horizontal_anchor` / `vertical_anchor`
 * 是 `w:tblpXSpec` / `w:tblpYSpec`（位置预设），而调用方给的可能是锚点框 + 绝对偏移。
 * `left` / `top` 是 Word 新建浮动表的常见预设，也是本批唯一能确定的合法值。
 * 要精确控制位置，调用方应显式传 `horizontal_position_spec` / `vertical_position_spec`。
 */
export const DEFAULT_FLOATING_POSITION_SPEC: FloatingPositionSpec = Object.freeze({
  horizontal: 'left',
  vertical: 'top',
});

/** 零长度（`w:tblpX` / `w:tblpY` 的缺省偏移；单位取 mm，换算在 `units` 一处做）。 */
const ZERO_LENGTH: Length = Object.freeze({ unit: 'mm', value: 0 });

/** 表格的文字环绕与定位参数（对应 `w:tblpPr`）。 */
export interface TableTextWrapDescriptor {
  readonly kind: 'table_text_wrap';
  readonly mode: TextWrapMode;
  /** 与正文文字的左右间距。 */
  readonly distance_left: Length | null;
  readonly distance_right: Length | null;
  /** 水平锚点框与位置（`w:horzAnchor` / `w:tblpX`）。**锚点框模型没有字段**，只进描述符。 */
  readonly horizontal_anchor: TextWrapAnchor | null;
  readonly horizontal_position: Length | null;
  /** 垂直锚点框与位置（`w:vertAnchor` / `w:tblpY`）。**锚点框模型没有字段**，只进描述符。 */
  readonly vertical_anchor: TextWrapAnchor | null;
  readonly vertical_position: Length | null;
  /** `w:tblOverlap`：是否允许与其它浮动对象重叠。**模型没有字段**，只进描述符。 */
  readonly allow_overlap: boolean;
}

/** 行是否允许跨页断开（对应 `w:cantSplit`，`false` 即"禁止断开"）。 */
export interface RowBreakControlDescriptor {
  readonly kind: 'row_break_control';
  readonly allow_break_across_pages: boolean;
}

/** 单元格内边距（对应 `w:tcMar`）。`null` = 该边不指定（继续继承表格级 `w:tblCellMar`）。 */
export interface CellMarginsDescriptor {
  readonly kind: 'cell_margins';
  readonly top: Length | null;
  readonly left: Length | null;
  readonly bottom: Length | null;
  readonly right: Length | null;
}

/** 本包的扩展描述符联合。 */
export type TableExtension = TableTextWrapDescriptor | RowBreakControlDescriptor | CellMarginsDescriptor;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 从节点的 `opaque` 里读某个种类的描述符（**只读**，不改变数组）。
 *
 * 读不到返回 `null`——"没设过"与"设成了空"是两回事，调用方据此区分。
 */
export function readExtension<T extends TableExtension>(
  node: { readonly opaque: readonly unknown[] },
  kind: T['kind'],
): T | null {
  for (const item of node.opaque) {
    if (isRecord(item) && item['kind'] === kind) {
      return item as unknown as T;
    }
  }
  return null;
}

/**
 * 写入 / 替换 / 删除一个描述符，返回新的 `opaque` 数组。
 *
 * 三条纪律：
 * - **其它条目原样保留且顺序不变**（未建模的 XML 片段不能被挤出或重排，R105）；
 * - 同种类只留一个（替换就地做，避免文件里出现两份"环绕参数"）；
 * - `value === null` 表示**删除**该描述符（回到"没设过"）。
 */
export function withExtension(
  node: { readonly opaque: readonly unknown[] },
  kind: TableExtensionKind,
  value: TableExtension | null,
): readonly unknown[] {
  const next: unknown[] = [];
  let placed = false;
  for (const item of node.opaque) {
    if (isRecord(item) && item['kind'] === kind) {
      // 原位替换（并丢掉重复的同种类项）；`value === null` 即"删除"。
      if (!placed && value !== null) {
        next.push(value);
        placed = true;
      }
      continue;
    }
    next.push(item);
  }
  if (!placed && value !== null) {
    next.push(value);
  }
  return next;
}

// ---------------------------------------------------------------------------
// OOXML 片段构造（用与 D02 同一套确定性写入器；不手拼字符串，R107）
// ---------------------------------------------------------------------------

/** `Length` → OOXML 整数 twips 字符串（唯一换算入口是 `units`）。 */
function twips(length: Length): string {
  return String(lengthToTwips(length));
}

function optionalAttr(name: string, length: Length | null): readonly ReturnType<typeof attr>[] {
  return length === null ? [] : [attr(name, twips(length))];
}

/**
 * 造 `w:tblpPr` 元素（应作为 `w:tblPr` 的子元素）。
 *
 * 属性顺序固定为 OOXML 惯例顺序；"没有值的属性就不写"，不塞默认值
 * （写默认值会改变语义：不写 = 继承，写死 = 显式）。
 *
 * ## `w:tblOverlap` 为什么**不在这里**（WCF-D30 指出的缺陷，本批修）
 *
 * `CT_TblPPr` 的属性集是 `leftFromText` / `rightFromText` / `topFromText` / `bottomFromText` /
 * `vertAnchor` / `horzAnchor` / `tblpXSpec` / `tblpX` / `tblpYSpec` / `tblpY` —— **没有**
 * `tblOverlap`。`w:tblOverlap` 是 `w:tblPr` 的**直属子元素**（`w:tblpPr` 的兄弟）。
 * 早先的实现把它 push 进属性列表，产出的是 schema 里不存在的属性
 * （`<w:tblpPr … w:tblOverlap="never"/>`），严格校验器会判文档非法。
 * 现在它由 `tableOverlapElement()` 单独产出，由调用方放在 `w:tblPr` 里、`w:tblpPr` **之后**。
 */
export function tableTextWrapElement(descriptor: TableTextWrapDescriptor): XmlElement {
  const children: ReturnType<typeof attr>[] = [];
  if (descriptor.horizontal_anchor !== null) {
    children.push(attr('w:horzAnchor', descriptor.horizontal_anchor));
  }
  if (descriptor.vertical_anchor !== null) {
    children.push(attr('w:vertAnchor', descriptor.vertical_anchor));
  }
  children.push(...optionalAttr('w:tblpX', descriptor.horizontal_position));
  children.push(...optionalAttr('w:tblpY', descriptor.vertical_position));
  children.push(...optionalAttr('w:leftFromText', descriptor.distance_left));
  children.push(...optionalAttr('w:rightFromText', descriptor.distance_right));
  return el('w:tblpPr', children);
}

/**
 * 造 `w:tblOverlap` 元素（`w:tblPr` 的直属子元素，排在 `w:tblpPr` **之后**）。
 *
 * `w:tblOverlap` 讲的是"**浮动表格之间**能否重叠"（`ST_TblOverlap` = `never` / `overlap`），
 * **不是**文字环绕模式。模型没有对应字段，因此它只作为描述符的伴生片段提供给调用方。
 */
export function tableOverlapElement(descriptor: TableTextWrapDescriptor): XmlElement {
  return el('w:tblOverlap', [attr('w:val', descriptor.allow_overlap ? 'overlap' : 'never')]);
}

/** `w:tblpPr` 的 XML 文本（`null` = 该描述符要求"不写"）。 */
export function tableTextWrapXml(descriptor: TableTextWrapDescriptor): string {
  return serializeXmlNode(tableTextWrapElement(descriptor));
}

/** 造 `w:tcMar` 元素（应作为 `w:tcPr` 的子元素）。四边按 OOXML 顺序 top/left/bottom/right。 */
export function cellMarginsElement(descriptor: CellMarginsDescriptor): XmlElement | null {
  const edges: readonly (readonly ['top' | 'left' | 'bottom' | 'right', Length | null])[] = [
    ['top', descriptor.top],
    ['left', descriptor.left],
    ['bottom', descriptor.bottom],
    ['right', descriptor.right],
  ];
  const children: XmlElement[] = [];
  for (const [name, value] of edges) {
    if (value !== null) {
      children.push(el(`w:${name}`, [attr('w:w', twips(value)), attr('w:type', 'dxa')]));
    }
  }
  return children.length === 0 ? null : el('w:tcMar', [], children);
}

/** `w:tcMar` 的 XML 文本；四边都没指定 ⇒ 返回 `null`（不写空壳元素）。 */
export function cellMarginsXml(descriptor: CellMarginsDescriptor): string | null {
  const element = cellMarginsElement(descriptor);
  return element === null ? null : serializeXmlNode(element);
}

/** 造 `w:cantSplit` 元素（应作为 `w:trPr` 的子元素）；允许断页 ⇒ `null`（不写元素）。 */
export function rowBreakControlElement(descriptor: RowBreakControlDescriptor): XmlElement | null {
  return descriptor.allow_break_across_pages ? null : el('w:cantSplit');
}

/** `w:cantSplit` 的 XML 文本；允许断页 ⇒ `null`。 */
export function rowBreakControlXml(descriptor: RowBreakControlDescriptor): string | null {
  const element = rowBreakControlElement(descriptor);
  return element === null ? null : serializeXmlNode(element);
}

/** 环绕模式是否"浮动"（需要 `w:tblpPr` 定位）。`none` = 嵌入正文，不写定位。 */
export function wrapModeIsFloating(mode: TextWrapMode): boolean {
  return mode !== 'none';
}

// ---------------------------------------------------------------------------
// 描述符 → 类型化字段（WCF-D40 接通：导出器按类型化字段重建 w:tblPr/w:tcPr/w:trPr）
// ---------------------------------------------------------------------------

/** 校验锚点框取值（R140：不认得的枚举**操作前拒绝**，不写进模型、不留给导出器去炸）。 */
export function assertTextWrapAnchor(value: string, axis: '水平' | '垂直'): TextWrapAnchor {
  if (!TEXT_WRAP_ANCHORS.has(value)) {
    throw new DocumentModelError(
      'unsupported',
      `表格${axis}锚点框 ${JSON.stringify(value)} 不是 w:horzAnchor/w:vertAnchor 的合法取值` +
        `（${[...TEXT_WRAP_ANCHORS].join(' / ')}）：写进文件会让消费者认为文档非法（R140 先拒绝）。`,
    );
  }
  return value as TextWrapAnchor;
}

/** 校验位置预设取值（与导出器 `word-xml.ts` 的 `TBLP_X_SPEC` / `TBLP_Y_SPEC` 同一值域）。 */
export function assertFloatingPositionSpec(spec: FloatingPositionSpec): FloatingPositionSpec {
  if (!TBLP_X_SPEC.has(spec.horizontal)) {
    throw new DocumentModelError(
      'unsupported',
      `表格水平位置 ${JSON.stringify(spec.horizontal)} 不是 w:tblpXSpec 的合法取值` +
        `（${[...TBLP_X_SPEC].join(' / ')}）：写进模型会让导出器在重建时抛错（R140 先拒绝）。`,
    );
  }
  if (!TBLP_Y_SPEC.has(spec.vertical)) {
    throw new DocumentModelError(
      'unsupported',
      `表格垂直位置 ${JSON.stringify(spec.vertical)} 不是 w:tblpYSpec 的合法取值` +
        `（${[...TBLP_Y_SPEC].join(' / ')}）：写进模型会让导出器在重建时抛错（R140 先拒绝）。`,
    );
  }
  return spec;
}

/**
 * 描述符 → `TableProperties.floating`（导出器直接消费的通道）。
 *
 * ## 逐字段映射（**哪几处是有损的，必须看清**）
 *
 * | 描述符 | 模型字段 | 保真度 |
 * |---|---|---|
 * | `horizontal_position` / `vertical_position` | `horizontal_offset` / `vertical_offset` | 保真（同一 `Length`） |
 * | `mode` | `text_wrapping` | **有损**：模型只有 `around` / `none`，`topAndBottom` / `through` 被归入 `none` / `around` |
 * | `horizontal_anchor` / `vertical_anchor`（锚点框） | — | **丢弃**（模型无此字段；导出器固定 margin/text） |
 * | `distance_left` / `distance_right` | — | **丢弃**（导出器按 `text_wrapping` 写固定间距） |
 * | `allow_overlap` | — | **丢弃**（模型无此字段） |
 *
 * 被丢弃的三项**没有丢**——它们仍在 `opaque` 里的描述符中（读回不变，R105）。
 * 这里只做"能不能进文件"的映射，不假装模型答得上它答不上的问题。
 *
 * @throws {DocumentModelError} `unsupported`：`spec` 里有非法枚举（R140）。
 */
export function toTableFloatingPosition(
  descriptor: TableTextWrapDescriptor,
  spec: FloatingPositionSpec,
): TableFloatingPosition {
  assertFloatingPositionSpec(spec);
  return {
    horizontal_anchor: spec.horizontal,
    vertical_anchor: spec.vertical,
    horizontal_offset: descriptor.horizontal_position ?? ZERO_LENGTH,
    vertical_offset: descriptor.vertical_position ?? ZERO_LENGTH,
    text_wrapping: descriptor.mode === 'around' || descriptor.mode === 'through' ? 'around' : 'none',
  };
}

/** 描述符 → `CellProperties.margins` 的值（四边按模型的 `top/right/bottom/left` 顺序）。 */
export function toCellMarginsValue(descriptor: CellMarginsDescriptor): {
  readonly top: Length | null;
  readonly right: Length | null;
  readonly bottom: Length | null;
  readonly left: Length | null;
} {
  return {
    top: descriptor.top,
    right: descriptor.right,
    bottom: descriptor.bottom,
    left: descriptor.left,
  };
}

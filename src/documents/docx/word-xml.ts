/**
 * **WordprocessingML ↔ 模型** 的属性转换层（归属 WCF-D02）。
 *
 * 合同 R107 把"模型 ↔ OOXML 部件的转换"钉在 docx 子模块里——本文件就是那一处。
 * 结构解析（段落/run/表格/节的父子关系）在 `import.ts`，本文件只管**属性**：
 * `w:rPr` ↔ `RunProperties`、`w:pPr` ↔ `ParagraphProperties`、`w:sectPr` ↔ `SectionProperties`、
 * `w:tblPr`/`w:trPr`/`w:tcPr` ↔ 表格属性。
 *
 * ## 本文件的职责边界（R128）
 *
 * **只做两件事**：
 * 1. **属性名接线**——模型字段 ↔ `w:` 元素/属性名、元素在 `CT_RPr`/`CT_PPr` 序列里的顺序；
 * 2. **状态分流**——`unspecified` / `on` / `off` / `set` / `inherit` 各自产出什么。
 *
 * **不做单位换算**。twips↔pt、点半值、1/100 字、`w:line` 的 240 基准、行距/段距/缩进/制表位
 * 的换算**全部**调用 `src/documents/units/**`（R128：转换集中一处）。本文件内**不存在**
 * `20` / `240` / `100` / `1440` 这类换算魔数；唯一例外见下方"已上报的缺口"。
 *
 * ## 三个必须能分别产出的状态（R117/R118）
 *
 * - **`unspecified`** ⇒ **不写元素**（"没设过"）；
 * - **`on`** ⇒ `<w:b/>`；**`off`** ⇒ `<w:b w:val="false"/>`（两者必须能分别产出）；
 * - **`inherit`** ⇒ **也不写元素**——它就是"删掉已有的该元素、回落到样式"。
 *
 * `unspecified` 与 `inherit` 在**字节上**都表现为"没有该元素"：OOXML 里"继承"的表达方式
 * **就是**"没有这个属性"，并不存在一个"显式继承"的标记。要让它们产出不同字节，就得发明一个
 * 非标准的写法，那反而会写出别的软件读不懂的文档。本项目对这条的权威表述见
 * `src/documents/units/indent.ts` 的 `indentToOoxml`：
 * "`unspecified` / `inherit` 都产出'该属性不应存在'（`inherit` 在写码层的动作是**删除**元素，
 * 效果同为'不存在'，故此处等价处理）"。
 *
 * 真正**必须**分得开、也是本轮测试钉死的是另一件事：**`inherit` 绝不能写成 `off`**——
 * "清除加粗"若写成 `<w:b w:val="false"/>`，语义就从"回落到样式的加粗"变成了"显式不加粗"。
 * 同理，模型里"显式取消"（如 `highlight: set('none')`、`underline: set('none')`）
 * 走的是 `set`，与 `inherit` 是两条不同的路径。
 *
 * **本层的动作由 `model/attributes.ts` 的写意图契约分流**（R118）：`serializeToggle` /
 * `serializeValued` 不再各自拿 `state.state` 判断，而是先取 `toggleWriteIntent` /
 * `valuedWriteIntent` 再按 intent 分支。这样"未指定（`omit`）"与"清除（`remove`）"
 * 在**代码路径**上始终是两份不同的意图——即便在全量重建里两者产出的字节相同。
 * 为什么重要：局部重建（R151，见 `xml-patch.ts` 的 `patchChildren`——模型槽位为 `null`
 * ⇒ **删除**原树里的同名元素）必须把 `remove` 当成"删掉原字节里的残留"，而 `omit` 只是
 * "本次不产出"；若在这里就把两者塌缩成同一个 `return null`，未来的写者会**分不出**
 * "该不该删"，清除格式的编辑就会静默失效。
 *
 * ## 已上报的缺口（本文件里唯一的一处非 units 换算）
 *
 * **边框宽度的刻度是 1/8 pt**（`w:pBdr`/`w:tblBorders`/`w:tcBorders` 的 `w:sz`），
 * `src/documents/units/**` 目前**没有**这条刻度。按要求"缺了不要自己再写一份"，
 * 本文件只保留**一个具名常量** `EIGHTHS_PER_POINT` 且只有一个使用点，并已把缺口清单
 * 回报协调者（见 `completion.md`）。D04 补上 `borderWidthToEighths` 之后，这里应改为调用。
 */

import type { XmlAttribute, XmlElement } from '../../artifacts/ooxml/xml.js';
import { attr, el, formatInteger } from '../../artifacts/ooxml/xml.js';
import type {
  Alignment,
  BorderEdge,
  CellProperties,
  CharacterSpacing,
  ColorValue,
  FontSet,
  FontSize,
  HighlightColor,
  IndentAmount,
  IndentProperties,
  Length,
  LineSpacing,
  HeaderFooterReference,
  ParagraphProperties,
  ParagraphSpacing,
  RunProperties,
  SectionColumnWidth,
  SectionProperties,
  Shading,
  TabStop,
  TableFloatingPosition,
  TableProperties,
  ToggleState,
  UnderlineStyle,
  ValuedState,
  VerticalAlign,
} from '../model/types.js';
import { DocxError } from './docx-error.js';
import type { RunLanguage } from './language-render.js';
import { TOGGLE_OFF, TOGGLE_ON, TOGGLE_UNSPECIFIED } from '../model/types.js';
import { toggleWriteIntent, valuedWriteIntent } from '../model/attributes.js';
import {
  EMPTY_INDENT_ATTRIBUTES,
  HALF_POINTS_PER_POINT,
  HUNDREDTHS_PER_CHAR,
  fontSizeToPt,
  halfPointsToFontSize,
  indentToOoxml,
  lengthToPoints,
  lengthToTwips,
  lineSpacingFromOoxml,
  lineSpacingToOoxml,
  paragraphSpacingFromOoxml,
  paragraphSpacingToOoxml,
  tabStopsToOoxml,
  twipsToLength,
  twipsToPoints,
  type IndentAttributes,
  type LineRule,
  type SpacingSideAttributes,
} from '../units/index.js';
import type { ParsedXmlElement } from './xml-parse.js';
import { attributeValue, childElements, findChild, findChildren } from './xml-parse.js';

// ---------------------------------------------------------------------------
// 命名空间
// ---------------------------------------------------------------------------

/** WordprocessingML 主命名空间。 */
export const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
/** 关系引用命名空间（`r:id` / `r:embed` / `r:link`）。 */
export const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
/** 包级关系部件命名空间。 */
export const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
/** 内容类型部件命名空间。 */
export const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
/** 标记兼容性命名空间（`mc:AlternateContent` 等）。 */
export const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';

/**
 * 边框宽度刻度：`w:sz` 的单位是 **1/8 pt**。
 *
 * **这是已上报的单位缺口**——`src/documents/units/**` 尚无这条刻度的换算函数，
 * 按"缺了不要自己再写一份"的要求，这里只留一个具名常量、只有一个使用点。
 */
const EIGHTHS_PER_POINT = 8;

/** `w:outlineLvl` 表示"正文"的取值（0–8 是标题 1–9，9 是正文）。 */
const OUTLINE_LEVEL_BODY_TEXT = 9;

// ---------------------------------------------------------------------------
// 状态构造与解析
// ---------------------------------------------------------------------------

const TOGGLE_OFF_VALUES = new Set(['false', '0', 'off']);

/** 读一个开关元素：元素不存在 ⇒ 未指定；存在且 `val` 为假值 ⇒ 显式关闭；否则 ⇒ 显式开。 */
function parseToggle(element: ParsedXmlElement | null): ToggleState {
  if (element === null) return TOGGLE_UNSPECIFIED;
  const value = readVal(element);
  if (value !== null && TOGGLE_OFF_VALUES.has(value.toLowerCase())) return TOGGLE_OFF;
  return TOGGLE_ON;
}

/**
 * 写一个开关元素——动作由 `toggleWriteIntent`（R118）分流。
 *
 * `omit`（未指定）与 `remove`（`inherit` / 清除）**都不产出元素**——见文件头"三个状态"一节：
 * OOXML 里"继承"的表达方式**就是**"没有这个元素"，`inherit` 的动作是**删除该元素**。
 * 反过来说，本函数**绝不会**把 `inherit`（`remove`）写成 `<… w:val="false"/>`
 * （那是 `off` = `write_false` 的字节，语义完全不同）。
 *
 * `omit` 与 `remove` 的**字节**在"从零重建"里相同，但**写意图**不同：局部重建（R151）必须
 * 按 `remove` 删掉原树里的同名元素（`xml-patch.ts` 的 `patchChildren` 对 `null` 槽位即删除），
 * 而 `omit` 只表示"本次不产出"。因此这里显式分两支、不合并判断，保住机器可读的差别。
 */
function serializeToggle(name: string, state: ToggleState): XmlElement | null {
  switch (toggleWriteIntent(state)) {
    case 'write_true':
      return el(name);
    case 'write_false':
      return el(name, [attr('w:val', 'false')]);
    case 'omit':
    case 'remove':
      return null;
  }
}

function setValue<T>(value: T | null): ValuedState<T> {
  return value === null ? { state: 'unspecified' } : { state: 'set', value };
}

/**
 * 写一个带值元素——动作由 `valuedWriteIntent`（R118）分流。
 *
 * `write_value`（`set`，**即使值是 `false` / `0` / `null`**）交给回调产生元素；
 * `omit`（未指定）与 `remove`（`inherit` / 清除）都不写元素。与 `serializeToggle` 同理，
 * `omit` 与 `remove` 的字节在从零重建里相同、**写意图**不同，故分两支不合并：
 * 局部重建必须按 `remove` 删除原元素，别把它当成"没设过"。
 */
function serializeValued<T>(
  state: ValuedState<T>,
  build: (value: T) => XmlElement | null,
): XmlElement | null {
  switch (valuedWriteIntent(state)) {
    case 'write_value':
      return state.state === 'set' ? build(state.value) : null;
    case 'omit':
    case 'remove':
      return null;
  }
}

// ---------------------------------------------------------------------------
// 数值读写
// ---------------------------------------------------------------------------

/** 读一个 `w:` 属性；元素为 `null`（子元素不存在）或属性缺失时返回 `null`。 */
function readAttribute(element: ParsedXmlElement | null, localName: string): string | null {
  return element === null ? null : attributeValue(element, W_NS, localName);
}

/** 读 `w:val`（最常用的一条：开关/枚举/数值都挂它）。 */
function readVal(element: ParsedXmlElement | null): string | null {
  return readAttribute(element, 'val');
}

/** 读一个 `w:` 整数属性；缺失 / 非整数返回 `null`（不猜、不默认成 0）。 */
function readInteger(element: ParsedXmlElement | null, localName: string): number | null {
  const raw = readAttribute(element, localName);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^[+-]?[0-9]+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(value) ? value : null;
}

/** 读一个 `w:` 小数/整数属性（OOXML 里有 `w:w="1.5"` 这类写法）。 */
function readNumber(element: ParsedXmlElement | null, localName: string): number | null {
  const raw = readAttribute(element, localName);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/.test(trimmed)) return null;
  const value = Number.parseFloat(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * 数值格式化：整数走 `formatInteger`，非整数走最短精确十进制。
 * **这不是单位换算**，只是"同一个数怎么写成字符串"——因此留在本层。
 * 非有限数 / 指数表示**显式抛错**（不静默写一个 `NaN` 进文档）。
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`要写入的数值不是有限数：${String(value)}`);
  }
  if (Number.isSafeInteger(value)) return formatInteger(value);
  const text = String(value);
  if (/[eE]/.test(text)) {
    throw new Error(`不支持的数值形态（指数表示）：${text}`);
  }
  return text;
}

/**
 * 字号写前的**校验**（不是换算）：`w:sz` 的最小可表达值是 1 半点（0.5 pt），
 * 且必须落在半点格点上——否则 `units` 的取整会把"12.3pt"悄悄改成"12.5pt"，
 * 而本项目的纪律是**不静默改变用户给的值**。
 *
 * ## 策略已裁定：**拒绝，不取整**（协调者 2026-10-02 裁定）
 *
 * `units` 的 `fontSizeToHalfPoints` 对 12.3pt 会 `Math.round` 到 12.5pt——**本项目不采用那种做法**。
 * 依据 R131（"不存在一个数字到处复用"：值必须带单位、语义明确）与 R136（复合指令"全成功或全不修改"，
 * 非法值不得"前半段成功、后半段悄悄失败"）：**静默取整等于替用户改了他给的输入**，
 * 而且改得看不出来——用户写 12.3pt，文档里出现 12.5pt，中间的偏差没有任何记录。
 * 正确做法是**当场拒绝并说清为什么**，让上层决定是提示用户还是换个值。
 *
 * 换算本身仍由 `fontSizeToHalfPoints`（units）负责；这里只拦"表示不了"的输入。
 * 这条策略由 `word-xml.test.ts` 的「字号可表示性」一组用例钉死（含与 units 取整行为的对照）。
 */
function writableHalfPoints(size: FontSize): number {
  // 中文字号名 → pt 也走 units（本层不另存字号表）。
  const points = fontSizeToPt(size);
  const halfPoints = points * HALF_POINTS_PER_POINT;
  const rounded = Math.round(halfPoints);
  if (Math.abs(halfPoints - rounded) > 1e-9) {
    throw new Error(
      `字号 ${String(points)} pt 无法表示为 0.5 pt 的整数倍（w:sz 的粒度就是 0.5 pt）`,
    );
  }
  if (rounded < 1) {
    throw new Error(`字号 ${String(points)} pt 小于 w:sz 的最小可表达值 0.5 pt`);
  }
  return rounded;
}

// ---------------------------------------------------------------------------
// run 属性
// ---------------------------------------------------------------------------

const UNDERLINE_STYLES: ReadonlySet<string> = new Set([
  'single', 'double', 'thick', 'dotted', 'dash', 'dotDash', 'wave', 'none',
]);

const VERTICAL_ALIGNS: ReadonlySet<string> = new Set(['superscript', 'subscript', 'baseline']);

/** `w:u w:val` 的本仓支持集。**未知取值不猜**：回落为未指定，原字节由包级保留兜底。 */
function parseUnderline(element: ParsedXmlElement | null): ValuedState<UnderlineStyle> {
  if (element === null) return { state: 'unspecified' };
  const value = readVal(element);
  if (value === null) return { state: 'set', value: 'single' };
  return UNDERLINE_STYLES.has(value)
    ? { state: 'set', value: value as UnderlineStyle }
    : { state: 'unspecified' };
}

function parseVertAlign(element: ParsedXmlElement | null): ValuedState<VerticalAlign> {
  if (element === null) return { state: 'unspecified' };
  const value = readVal(element);
  return value !== null && VERTICAL_ALIGNS.has(value)
    ? { state: 'set', value: value as VerticalAlign }
    : { state: 'unspecified' };
}

const HIGHLIGHT_COLORS: ReadonlySet<string> = new Set([
  'yellow', 'green', 'cyan', 'magenta', 'blue', 'red',
  'darkBlue', 'darkCyan', 'darkGreen', 'darkMagenta', 'darkRed',
  'darkYellow', 'darkGray', 'lightGray', 'black', 'none',
]);

function parseHighlight(element: ParsedXmlElement | null): ValuedState<HighlightColor> {
  if (element === null) return { state: 'unspecified' };
  const value = readVal(element);
  return value !== null && HIGHLIGHT_COLORS.has(value)
    ? { state: 'set', value: value as HighlightColor }
    : { state: 'unspecified' };
}

const HEX_COLOR = /^[0-9A-Fa-f]{6}$/;

function parseColor(element: ParsedXmlElement | null): ValuedState<ColorValue> {
  if (element === null) return { state: 'unspecified' };
  const value = readVal(element);
  if (value === null) return { state: 'unspecified' };
  if (value.toLowerCase() === 'auto') return { state: 'set', value: { kind: 'auto' } };
  return HEX_COLOR.test(value)
    ? { state: 'set', value: { kind: 'rgb', hex: value } }
    : { state: 'unspecified' };
}

/** `w:shd`：`w:val` = 图案，`w:fill` = 填充色，`w:color` = 图案色。**
 *  注意 `set('none')` 之类的"显式取消"走 `set`，与 `inherit` 是两条路径。 */
export function parseShading(element: ParsedXmlElement | null): ValuedState<Shading> {
  if (element === null) return { state: 'unspecified' };
  const pattern = readAttribute(element, 'val');
  const fill = readAttribute(element, 'fill');
  const color = readAttribute(element, 'color');
  return {
    state: 'set',
    value: {
      fill_hex: fill === null || fill === 'auto' ? null : fill,
      pattern,
      color_hex: color === null || color === 'auto' ? null : color,
    },
  };
}

export function serializeShading(name: string, shading: Shading): XmlElement {
  return el(name, [
    attr('w:val', shading.pattern ?? 'clear'),
    attr('w:color', shading.color_hex ?? 'auto'),
    attr('w:fill', shading.fill_hex ?? 'auto'),
  ]);
}

function parseFontSet(element: ParsedXmlElement | null): ValuedState<FontSet> {
  if (element === null) return { state: 'unspecified' };
  return {
    state: 'set',
    value: {
      ascii: readAttribute(element, 'ascii'),
      hAnsi: readAttribute(element, 'hAnsi'),
      eastAsia: readAttribute(element, 'eastAsia'),
      cs: readAttribute(element, 'cs'),
    },
  };
}

function parseFontSize(element: ParsedXmlElement | null): ValuedState<FontSize> {
  if (element === null) return { state: 'unspecified' };
  const halfPoints = readNumber(element, 'val');
  if (halfPoints === null) return { state: 'unspecified' };
  // 半点值 → `FontSize` 走 units 的反向换算（本层不除 2，也不猜中文字号名）。
  return { state: 'set', value: halfPointsToFontSize(halfPoints) };
}

function parseCharacterSpacing(element: ParsedXmlElement | null): ValuedState<CharacterSpacing> {
  if (element === null) return { state: 'unspecified' };
  const twips = readNumber(element, 'val');
  if (twips === null || twips === 0) return { state: 'unspecified' };
  return {
    state: 'set',
    value: {
      kind: twips > 0 ? 'expanded' : 'condensed',
      value: { unit: 'pt', value: twipsToPoints(Math.abs(twips)) },
    },
  };
}

function parsePosition(element: ParsedXmlElement | null): ValuedState<Length> {
  if (element === null) return { state: 'unspecified' };
  const halfPoints = readNumber(element, 'val');
  if (halfPoints === null) return { state: 'unspecified' };
  return { state: 'set', value: halfPointsToLength(halfPoints) };
}

/** 空的 run 属性（全 `unspecified`）。 */
export function emptyRunProperties(): RunProperties {
  return {
    bold: TOGGLE_UNSPECIFIED,
    italic: TOGGLE_UNSPECIFIED,
    underline: { state: 'unspecified' },
    strike: TOGGLE_UNSPECIFIED,
    doubleStrike: TOGGLE_UNSPECIFIED,
    vertAlign: { state: 'unspecified' },
    fonts: { state: 'unspecified' },
    size: { state: 'unspecified' },
    scale: { state: 'unspecified' },
    position: { state: 'unspecified' },
    color: { state: 'unspecified' },
    highlight: { state: 'unspecified' },
    shading: { state: 'unspecified' },
    spacing: { state: 'unspecified' },
    caps: TOGGLE_UNSPECIFIED,
    smallCaps: TOGGLE_UNSPECIFIED,
  };
}

/** `w:rPr` → `RunProperties`（元素缺失 ⇒ 全 `unspecified`）。 */
export function parseRunProperties(rPr: ParsedXmlElement | null): RunProperties {
  if (rPr === null) return emptyRunProperties();
  return {
    bold: parseToggle(findChild(rPr, W_NS, 'b')),
    italic: parseToggle(findChild(rPr, W_NS, 'i')),
    underline: parseUnderline(findChild(rPr, W_NS, 'u')),
    strike: parseToggle(findChild(rPr, W_NS, 'strike')),
    doubleStrike: parseToggle(findChild(rPr, W_NS, 'dstrike')),
    vertAlign: parseVertAlign(findChild(rPr, W_NS, 'vertAlign')),
    fonts: parseFontSet(findChild(rPr, W_NS, 'rFonts')),
    size: parseFontSize(findChild(rPr, W_NS, 'sz')),
    scale: setValue(readNumber(findChild(rPr, W_NS, 'w'), 'val')),
    position: parsePosition(findChild(rPr, W_NS, 'position')),
    color: parseColor(findChild(rPr, W_NS, 'color')),
    highlight: parseHighlight(findChild(rPr, W_NS, 'highlight')),
    shading: parseShading(findChild(rPr, W_NS, 'shd')),
    spacing: parseCharacterSpacing(findChild(rPr, W_NS, 'spacing')),
    caps: parseToggle(findChild(rPr, W_NS, 'caps')),
    smallCaps: parseToggle(findChild(rPr, W_NS, 'smallCaps')),
  };
}

/**
 * `RunProperties` → `w:rPr`（没有任何要写的内容时返回 `null`，**不写空元素**）。
 *
 * 元素顺序按 ECMA-376 的 `CT_RPr` 序列（`rFonts` → `b` → `i` → … → `shd`），
 * 保证同一组属性产出同一段字节。
 */
export function serializeRunProperties(
  properties: RunProperties,
  language?: RunLanguage | null,
): XmlElement | null {
  const children: XmlElement[] = [];
  const push = (element: XmlElement | null): void => {
    if (element !== null) children.push(element);
  };

  push(serializeValued(properties.fonts, (fonts) => {
    const attributes = (
      [
        ['w:ascii', fonts.ascii],
        ['w:hAnsi', fonts.hAnsi],
        ['w:eastAsia', fonts.eastAsia],
        ['w:cs', fonts.cs],
      ] as const
    )
      .filter(([, value]) => value !== null)
      .map(([name, value]) => attr(name, value as string));
    return attributes.length === 0 ? null : el('w:rFonts', attributes);
  }));
  push(serializeToggle('w:b', properties.bold));
  push(serializeToggle('w:i', properties.italic));
  push(serializeToggle('w:caps', properties.caps));
  push(serializeToggle('w:smallCaps', properties.smallCaps));
  push(serializeToggle('w:strike', properties.strike));
  push(serializeToggle('w:dstrike', properties.doubleStrike));
  push(serializeValued(properties.color, (color) =>
    el('w:color', [attr('w:val', color.kind === 'auto' ? 'auto' : color.hex)]),
  ));
  push(serializeValued(properties.spacing, (spacing) =>
    el('w:spacing', [
      attr(
        'w:val',
        formatNumber((spacing.kind === 'condensed' ? -1 : 1) * lengthToTwips(spacing.value)),
      ),
    ]),
  ));
  push(serializeValued(properties.scale, (scale) =>
    el('w:w', [attr('w:val', formatNumber(scale))]),
  ));
  push(serializeValued(properties.size, (size) =>
    el('w:sz', [attr('w:val', formatInteger(writableHalfPoints(size)))]),
  ));
  push(serializeValued(properties.size, (size) =>
    el('w:szCs', [attr('w:val', formatInteger(writableHalfPoints(size)))]),
  ));
  push(serializeValued(properties.highlight, (highlight) =>
    el('w:highlight', [attr('w:val', highlight)]),
  ));
  push(serializeValued(properties.underline, (underline) =>
    el('w:u', [attr('w:val', underline)]),
  ));
  push(serializeValued(properties.vertAlign, (vertAlign) =>
    el('w:vertAlign', [attr('w:val', vertAlign)]),
  ));
  push(serializeValued(properties.position, (position) =>
    el('w:position', [attr('w:val', formatNumber(pointsToHalfPoints(position)))]),
  ));
  push(serializeValued(properties.shading, (shading) => serializeShading('w:shd', shading)));
  // `w:lang`（校对语言，WF-096）。`CT_RPr` 序列里它排在 `w:vertAlign` / `w:shd` **之后**，
  // 因此追加在末尾顺序是对的。模型冻结骨架的 `RunProperties` **没有** 这个字段（它属
  // "校对语言"，与字体/字号不是一类），所以它由调用方按**范围**给进来，不在 `RunProperties` 里。
  if (language !== undefined && language !== null && language.val.length > 0) {
    // 属性顺序按 `CT_Lang`（`w:val` → `w:eastAsia` → `w:bidi`）。
    // **可选槽位不给就不写那个属性**——因此"只给 val"的调用产出与从前逐字节相同（R151）。
    const langAttributes = [attr('w:val', language.val)];
    const eastAsia = language.east_asia ?? null;
    if (eastAsia !== null && eastAsia.length > 0) langAttributes.push(attr('w:eastAsia', eastAsia));
    const bidi = language.bidi ?? null;
    if (bidi !== null && bidi.length > 0) langAttributes.push(attr('w:bidi', bidi));
    push(el('w:lang', langAttributes));
  }

  return children.length === 0 ? null : el('w:rPr', [], children);
}

// ---------------------------------------------------------------------------
// 段落属性
// ---------------------------------------------------------------------------

const ALIGNMENTS: Readonly<Record<string, Alignment>> = Object.freeze({
  left: 'left',
  start: 'left',
  center: 'center',
  right: 'right',
  end: 'right',
  both: 'justify',
  justify: 'justify',
  distribute: 'distribute',
});

/** 模型对齐 → OOXML 取值（**一一对应**，不做"分散对齐用空格凑"那类近似）。 */
const ALIGNMENT_TO_XML: Readonly<Record<Alignment, string>> = Object.freeze({
  left: 'left',
  center: 'center',
  right: 'right',
  justify: 'both',
  distribute: 'distribute',
});

function parseAlignment(element: ParsedXmlElement | null): ValuedState<Alignment> {
  if (element === null) return { state: 'unspecified' };
  const value = readVal(element);
  if (value === null) return { state: 'unspecified' };
  const alignment = ALIGNMENTS[value];
  return alignment === undefined ? { state: 'unspecified' } : { state: 'set', value: alignment };
}

/** 行距 + 段距都挂在同一个 `w:spacing` 上，因此解析一次、拆成三份。 */
function parseSpacing(element: ParsedXmlElement | null): {
  lineSpacing: ValuedState<LineSpacing>;
  before: ValuedState<ParagraphSpacing>;
  after: ValuedState<ParagraphSpacing>;
} {
  if (element === null) {
    return {
      lineSpacing: { state: 'unspecified' },
      before: { state: 'unspecified' },
      after: { state: 'unspecified' },
    };
  }
  return {
    lineSpacing: parseLineSpacing(element),
    before: parseParagraphSpacing(element, 'before'),
    after: parseParagraphSpacing(element, 'after'),
  };
}

/** `w:line` + `w:lineRule` → 六类行距（换算走 units 的 `lineSpacingFromOoxml`）。 */
function parseLineSpacing(spacing: ParsedXmlElement): ValuedState<LineSpacing> {
  const line = readNumber(spacing, 'line');
  if (line === null) return { state: 'unspecified' };
  const rawRule = (readAttribute(spacing, 'lineRule') ?? 'auto').toLowerCase();
  const rule: LineRule = rawRule === 'exact' ? 'exact' : rawRule === 'atleast' ? 'atLeast' : 'auto';
  return { state: 'set', value: lineSpacingFromOoxml(line, rule) };
}

/** 段前/段后：三属性（twips / 1/100 行 / 自动）互斥，读回走 units 的 `paragraphSpacingFromOoxml`。 */
function parseParagraphSpacing(
  spacing: ParsedXmlElement,
  which: 'before' | 'after',
): ValuedState<ParagraphSpacing> {
  const side: SpacingSideAttributes = {
    line: readNumber(spacing, which),
    lines: readNumber(spacing, `${which}Lines`),
    autospacing: readInteger(spacing, `${which}Autospacing`) === 1,
  };
  const value = paragraphSpacingFromOoxml(side);
  return value === null ? { state: 'unspecified' } : { state: 'set', value };
}

/**
 * 读 `w:ind` → `IndentProperties`。
 *
 * **units 包目前只提供了写方向（`indentToOoxml`），没有读方向**——这是已上报的缺口之一。
 * 因此这里只做**属性名接线**（`leftChars` → `left` 槽位等），两个数值换算
 * （1/100 字 ↔ 字符、twips ↔ `Length`）都调用 units 的常量与函数，**不另写一份换算**。
 */
function parseIndent(ind: ParsedXmlElement | null): IndentProperties {
  const slot = (charsAttribute: string, lengthAttribute: string): ValuedState<IndentAmount> => {
    const chars = readNumber(ind, charsAttribute);
    if (chars !== null) {
      return { state: 'set', value: { unit: 'chars', value: chars / HUNDREDTHS_PER_CHAR } };
    }
    const twips = readNumber(ind, lengthAttribute);
    if (twips !== null) return { state: 'set', value: twipsToLength(twips, 'pt') };
    return { state: 'unspecified' };
  };

  if (ind === null) {
    return {
      left: { state: 'unspecified' },
      right: { state: 'unspecified' },
      firstLine: { state: 'unspecified' },
      hanging: { state: 'unspecified' },
    };
  }
  // `w:start` / `w:end` 是 `w:left` / `w:right` 的等价写法（ECMA-376 的 transitional/strict 差异）。
  const left = slot('leftChars', 'left');
  const right = slot('rightChars', 'right');
  return {
    left: left.state === 'unspecified' ? slot('startChars', 'start') : left,
    right: right.state === 'unspecified' ? slot('endChars', 'end') : right,
    firstLine: slot('firstLineChars', 'firstLine'),
    hanging: slot('hangingChars', 'hanging'),
  };
}

const TAB_ALIGNMENTS: ReadonlySet<string> = new Set(['left', 'center', 'right', 'decimal', 'bar']);
const TAB_LEADERS: ReadonlySet<string> = new Set(['none', 'dot', 'hyphen', 'underscore', 'middleDot']);

/**
 * 读 `w:tabs`。位置换算走 units 的 `twipsToLength`；排序与去重是**写方向**的规则
 * （`tabStopsToOoxml` 负责），读方向保持文档里的原始顺序。
 */
function parseTabStops(tabs: ParsedXmlElement | null): ValuedState<readonly TabStop[]> {
  if (tabs === null) return { state: 'unspecified' };
  const stops: TabStop[] = [];
  for (const tab of findChildren(tabs, W_NS, 'tab')) {
    const position = readNumber(tab, 'pos');
    if (position === null) continue;
    const alignment = (readAttribute(tab, 'val') ?? 'left').toLowerCase();
    const leader = (readAttribute(tab, 'leader') ?? 'none').toLowerCase();
    stops.push({
      position: twipsToLength(position, 'pt'),
      alignment: (TAB_ALIGNMENTS.has(alignment) ? alignment : 'left') as TabStop['alignment'],
      leader: (TAB_LEADERS.has(leader) ? leader : 'none') as TabStop['leader'],
    });
  }
  return { state: 'set', value: stops };
}

const BORDER_EDGES = ['top', 'left', 'bottom', 'right'] as const;

function parseBorderEdges(
  container: ParsedXmlElement | null,
  edges: readonly string[],
): ValuedState<Partial<Record<string, BorderEdge>>> {
  if (container === null) return { state: 'unspecified' };
  const result: Record<string, BorderEdge> = {};
  let found = false;
  for (const edge of edges) {
    const element = findChild(container, W_NS, edge);
    if (element === null) continue;
    const style = readAttribute(element, 'val');
    if (style === null || style === 'nil' || style === 'none') continue;
    const sizeEighths = readNumber(element, 'sz') ?? 0;
    const color = readAttribute(element, 'color');
    result[edge] = {
      style,
      // 1/8 pt → pt（见文件头的"已上报的缺口"）。
      size: { unit: 'pt', value: sizeEighths / EIGHTHS_PER_POINT },
      color_hex: color === null || color === 'auto' ? null : color,
    };
    found = true;
  }
  return found ? { state: 'set', value: result } : { state: 'unspecified' };
}

function serializeBorderEdges(
  containerName: string,
  borders: Partial<Record<string, BorderEdge>>,
  edges: readonly string[],
): XmlElement | null {
  const children: XmlElement[] = [];
  for (const edge of edges) {
    const border = borders[edge];
    if (border === undefined) continue;
    children.push(
      el(`w:${edge}`, [
        attr('w:val', border.style),
        attr('w:sz', formatNumber(border.size.value * EIGHTHS_PER_POINT)),
        attr('w:space', '0'),
        attr('w:color', border.color_hex ?? 'auto'),
      ]),
    );
  }
  return children.length === 0 ? null : el(containerName, [], children);
}

/** 空的段落属性（全 `unspecified`）。 */
export function emptyParagraphProperties(): ParagraphProperties {
  return {
    alignment: { state: 'unspecified' },
    lineSpacing: { state: 'unspecified' },
    spacingBefore: { state: 'unspecified' },
    spacingAfter: { state: 'unspecified' },
    indent: {
      left: { state: 'unspecified' },
      right: { state: 'unspecified' },
      firstLine: { state: 'unspecified' },
      hanging: { state: 'unspecified' },
    },
    tabStops: { state: 'unspecified' },
    pageBreakBefore: TOGGLE_UNSPECIFIED,
    keepNext: TOGGLE_UNSPECIFIED,
    keepLines: TOGGLE_UNSPECIFIED,
    widowControl: TOGGLE_UNSPECIFIED,
    borders: { state: 'unspecified' },
    shading: { state: 'unspecified' },
    outlineLevel: { state: 'unspecified' },
  };
}

/** `w:pPr` → `ParagraphProperties`（**不含** `pStyle` / `numPr` / `sectPr`，那三样在 `import.ts` 处理）。 */
export function parseParagraphProperties(pPr: ParsedXmlElement | null): ParagraphProperties {
  if (pPr === null) return emptyParagraphProperties();
  const spacing = parseSpacing(findChild(pPr, W_NS, 'spacing'));
  const outlineLevel = readInteger(findChild(pPr, W_NS, 'outlineLvl'), 'val');
  return {
    alignment: parseAlignment(findChild(pPr, W_NS, 'jc')),
    lineSpacing: spacing.lineSpacing,
    spacingBefore: spacing.before,
    spacingAfter: spacing.after,
    indent: parseIndent(findChild(pPr, W_NS, 'ind')),
    tabStops: parseTabStops(findChild(pPr, W_NS, 'tabs')),
    pageBreakBefore: parseToggle(findChild(pPr, W_NS, 'pageBreakBefore')),
    keepNext: parseToggle(findChild(pPr, W_NS, 'keepNext')),
    keepLines: parseToggle(findChild(pPr, W_NS, 'keepLines')),
    widowControl: parseToggle(findChild(pPr, W_NS, 'widowControl')),
    borders: parseBorderEdges(findChild(pPr, W_NS, 'pBdr'), BORDER_EDGES),
    shading: parseShading(findChild(pPr, W_NS, 'shd')),
    // `w:val="9"` 是"正文"这一**显式**取值 ⇒ `set(null)`，与"没有该元素"（未指定）区分开。
    outlineLevel:
      outlineLevel === null
        ? { state: 'unspecified' }
        : { state: 'set', value: outlineLevel === OUTLINE_LEVEL_BODY_TEXT ? null : outlineLevel },
  };
}

/** `w:pPr` 里由调用方（`import.ts` / `export.ts`）另行决定的三个元素。 */
export interface ParagraphPropertyExtras {
  /** `w:pStyle`（命名样式引用，R125）。 */
  readonly pStyle?: XmlElement | null;
  /** `w:numPr`（列表上下文）。 */
  readonly numPr?: XmlElement | null;
  /** `w:sectPr`（段落级节属性，R108）。 */
  readonly sectPr?: XmlElement | null;
}

/**
 * `ParagraphProperties` → `w:pPr` 的**子元素**数组。
 *
 * 顺序照 ECMA-376 的 `CT_PPr` 序列：`pStyle` → 分页控制 → `numPr` → 边框/底纹/制表位 →
 * `spacing` → `ind` → `widowControl` → `outlineLvl` → `jc` → `sectPr`。
 */
export function serializeParagraphPropertyChildren(
  properties: ParagraphProperties,
  extras: ParagraphPropertyExtras = {},
): XmlElement[] {
  const children: XmlElement[] = [];
  const push = (element: XmlElement | null | undefined): void => {
    if (element !== null && element !== undefined) children.push(element);
  };

  push(extras.pStyle ?? null);
  push(serializeToggle('w:keepNext', properties.keepNext));
  push(serializeToggle('w:keepLines', properties.keepLines));
  push(serializeToggle('w:pageBreakBefore', properties.pageBreakBefore));
  push(extras.numPr ?? null);
  push(serializeValued(properties.borders, (borders) =>
    serializeBorderEdges('w:pBdr', borders, BORDER_EDGES),
  ));
  push(serializeValued(properties.shading, (shading) => serializeShading('w:shd', shading)));
  push(serializeValued(properties.tabStops, (stops) =>
    stops.length === 0 ? null : serializeTabs(stops),
  ));

  // 行距 + 段前 + 段后共用一个 `w:spacing`：三件都不产生属性时**一个元素都不写**。
  const spacingAttributes = buildSpacingAttributes(properties);
  push(spacingAttributes.length === 0 ? null : el('w:spacing', spacingAttributes));

  const indentAttributes = buildIndentAttributes(properties.indent);
  push(indentAttributes.length === 0 ? null : el('w:ind', indentAttributes));
  push(serializeToggle('w:widowControl', properties.widowControl));
  push(serializeValued(properties.outlineLevel, (level) =>
    // `set(null)` = 显式"正文"，用 `w:val="9"` 表达，**与未指定区分开**（R118 的同一原则）。
    el('w:outlineLvl', [
      attr('w:val', formatInteger(level === null ? OUTLINE_LEVEL_BODY_TEXT : level)),
    ]),
  ));
  push(serializeValued(properties.alignment, (alignment) =>
    el('w:jc', [attr('w:val', ALIGNMENT_TO_XML[alignment])]),
  ));
  push(extras.sectPr ?? null);

  return children;
}

/** `w:tabs`：位置/对齐/前导符全部走 units 的 `tabStopsToOoxml`（含升序与同位置去重）。 */
function serializeTabs(stops: readonly TabStop[]): XmlElement {
  return el('w:tabs', [], tabStopsToOoxml(stops).map((stop) =>
    el('w:tab', [
      attr('w:val', stop.val),
      attr('w:leader', stop.leader),
      attr('w:pos', formatNumber(stop.pos)),
    ]),
  ));
}

/** `w:spacing` 的属性表：行距 + 段前 + 段后合成**一个**元素（ECMA-376 就只有一个）。 */
function buildSpacingAttributes(properties: ParagraphProperties): XmlAttribute[] {
  const attributes: XmlAttribute[] = [];

  if (properties.lineSpacing.state === 'set') {
    const { line, lineRule } = lineSpacingToOoxml(properties.lineSpacing.value);
    attributes.push(attr('w:line', formatNumber(line)), attr('w:lineRule', lineRule));
  }

  /**
   * 一侧间距：按 units 给的三属性**完整目标状态**写。
   * `autospacing` 为 false 时**显式写 0**——这正是"从自动切回 pt/行时不留残影"的执行点
   * （`paragraph-spacing.ts` 的约定：三属性语义互斥，切换必须一次清干净）。
   */
  const spacingSide = (which: 'before' | 'after', state: ValuedState<ParagraphSpacing>): void => {
    if (state.state !== 'set') return;
    const target = paragraphSpacingToOoxml(state.value);
    if (target.line !== null) attributes.push(attr(`w:${which}`, formatNumber(target.line)));
    if (target.lines !== null) attributes.push(attr(`w:${which}Lines`, formatNumber(target.lines)));
    attributes.push(attr(`w:${which}Autospacing`, target.autospacing ? '1' : '0'));
  };
  spacingSide('before', properties.spacingBefore);
  spacingSide('after', properties.spacingAfter);

  return attributes;
}

/** `w:ind` 的属性表：八属性目标状态里"应当存在"的那些（字符/长度由 units 分流，互斥天然成立）。 */
function buildIndentAttributes(indent: IndentProperties): XmlAttribute[] {
  const target: IndentAttributes = indentToOoxml(indent);
  const attributes: XmlAttribute[] = [];
  const entries: readonly (readonly [string, number | null])[] = [
    ['w:left', target.left],
    ['w:leftChars', target.leftChars],
    ['w:right', target.right],
    ['w:rightChars', target.rightChars],
    ['w:firstLine', target.firstLine],
    ['w:firstLineChars', target.firstLineChars],
    ['w:hanging', target.hanging],
    ['w:hangingChars', target.hangingChars],
  ];
  for (const [name, value] of entries) {
    if (value === null) continue;
    attributes.push(attr(name, formatNumber(value)));
  }
  return attributes;
}

// ---------------------------------------------------------------------------
// 节属性
// ---------------------------------------------------------------------------

export function emptySectionProperties(): SectionProperties {
  return {
    pageSize: { state: 'unspecified' },
    orientation: { state: 'unspecified' },
    margins: { state: 'unspecified' },
    columns: { state: 'unspecified' },
    titlePage: TOGGLE_UNSPECIFIED,
    evenAndOddHeaders: TOGGLE_UNSPECIFIED,
  };
}

/** `w:sectPr` → `SectionProperties`。 */
/**
 * 解析节属性时的**外部解析器**：节属性自己不掌握关系表（`r:id` 要经 `.rels` 才能落地）。
 *
 * **为什么是可选的**：`parseDocumentPart`（导出侧判"改没改"用的重解析）只拿得到主部件字节。
 * 把它做成必填，那条路径就只能传一个"永远查不到"的解析器——那是**用类型系统假装它能解析**。
 * 可选参数说的是实话：**没有关系表 ⇒ 不解析引用**（此时行为与"不解析"逐字节一致）。
 */
export interface SectionParseContext {
  /**
   * `r:id` → 包内部件路径。**查不到返回 `null`**（本函数不抛：悬空 rId 由导入边界的
   * `assertNoDanglingRelationshipIds` 以更明确的错误统一拒绝，R160）。
   * 只处理 `TargetMode="Internal"`：外部关系不是"包里某个部件"（R161 也不抓取）。
   */
  readonly pathOfRelationshipId: (relationshipId: string) => string | null;
}

/**
 * `w:headerReference*` / `w:footerReference*` → `HeaderFooterReference[]`。
 *
 * - `w:type` 缺省 = `default`（**这是 `ST_HdrFtr` 的规范默认值**，不是我们替它猜的）；
 * - `r:id` 查不到落点 ⇒ **跳过这一条**（不猜路径）；悬空 rId 另由导入边界拒绝整包，
 *   那里的错误信息比这里更准；
 * - 顺序 = 文档顺序；同一 `w:type` 出现多次时**照原样都留**（不在这一层静默去重——
 *   重复引用是否非法由不变量检查回答）。
 */
function parseHeaderFooterReferences(
  sectPr: ParsedXmlElement,
  localName: 'headerReference' | 'footerReference',
  context: SectionParseContext | null,
): readonly HeaderFooterReference[] {
  if (context === null) return [];
  const references: HeaderFooterReference[] = [];
  for (const child of findChildren(sectPr, W_NS, localName)) {
    const rawType = readAttribute(child, 'type');
    // `w:type` 的规范默认值是 `default`（缺省 ≠ 无法判定）。
    const kind: HeaderFooterReference['kind'] =
      rawType === 'first' || rawType === 'even' ? rawType : 'default';
    const relationshipId = attributeValue(child, R_NS, 'id');
    if (relationshipId === null) continue;
    const partPath = context.pathOfRelationshipId(relationshipId);
    if (partPath === null) continue;
    references.push({ part_path: partPath, kind });
  }
  return references;
}

export function parseSectionProperties(
  sectPr: ParsedXmlElement | null,
  context: SectionParseContext | null = null,
): SectionProperties {
  if (sectPr === null) return emptySectionProperties();
  const pageSize = findChild(sectPr, W_NS, 'pgSz');
  const width = readNumber(pageSize, 'w');
  const height = readNumber(pageSize, 'h');
  const orient = readAttribute(pageSize, 'orient');

  const margins = findChild(sectPr, W_NS, 'pgMar');
  const cols = findChild(sectPr, W_NS, 'cols');
  const columnCount = readInteger(cols, 'num');
  const columnWidths = parseColumnWidths(cols);

  return {
    pageSize:
      width !== null && height !== null
        ? {
            state: 'set',
            value: {
              width: { unit: 'pt', value: twipsToPoints(width) },
              height: { unit: 'pt', value: twipsToPoints(height) },
            },
          }
        : { state: 'unspecified' },
    orientation:
      orient === 'landscape' || orient === 'portrait'
        ? { state: 'set', value: orient }
        : { state: 'unspecified' },
    margins:
      margins === null
        ? { state: 'unspecified' }
        : {
            state: 'set',
            value: {
              top: { unit: 'pt', value: twipsToPoints(readNumber(margins, 'top') ?? 0) },
              right: { unit: 'pt', value: twipsToPoints(readNumber(margins, 'right') ?? 0) },
              bottom: { unit: 'pt', value: twipsToPoints(readNumber(margins, 'bottom') ?? 0) },
              left: { unit: 'pt', value: twipsToPoints(readNumber(margins, 'left') ?? 0) },
              gutter: { unit: 'pt', value: twipsToPoints(readNumber(margins, 'gutter') ?? 0) },
            },
          },
    columns: columnCount === null ? { state: 'unspecified' } : { state: 'set', value: columnCount },
    // `columnWidths` 是**可选**字段：没有逐栏 `w:col` 时不产出该键（保持"未改动 ⇒ 两侧都没有
    // ⇒ 判等 ⇒ 写回原字节"这条 R151 判据在两种路径上都成立，见 columns.ts 头部）。
    ...(columnWidths === undefined ? {} : { columnWidths }),
    titlePage: parseToggle(findChild(sectPr, W_NS, 'titlePg')),
    evenAndOddHeaders: parseToggle(findChild(sectPr, W_NS, 'evenAndOddHeaders')),
    ...parseSectionExtras(sectPr),
    // 页眉 / 页脚引用：**没有关系表时不产出这两个字段**（而不是产出空数组），
    // 这样"未改动 ⇒ 两侧同样没有 ⇒ 判等 ⇒ 写回原字节"这条 R151 判据在两种路径上都成立。
    ...(context === null
      ? {}
      : {
          headers: parseHeaderFooterReferences(sectPr, 'headerReference', context),
          footers: parseHeaderFooterReferences(sectPr, 'footerReference', context),
        }),
  };
}

/**
 * `w:cols` 的逐栏 `w:col@w:w/@w:space` → `SectionColumnWidth[]`（WF-050 / GAP-WF050-IMPORT-COL-WIDTH）。
 *
 * - 没有 `w:col` 子元素 ⇒ `undefined`（= 等宽栏，由 `@w:num` 表达；**不产出空数组**——
 *   "没这条声明"与"声明了 0 栏"是两回事）；
 * - 宽度是**必填**的（缺 / 非数 / ≤0 ⇒ `DocxError`，R140：先拒绝，不猜、也不默认成 0）；
 * - 间距按 OOXML 的规范默认值 `0`（`CT_Column/w:space` 缺省 0，不是我们替它猜的），负数拒绝；
 * - 单位一律经 `units/**`（R128），落成 **`twips` 的 `Length`**——这样再经 `lengthToTwips`
 *   逐位可还原（导出 → 导入 → 再导出逐项相等，不因换算漂移）。
 */
function parseColumnWidths(cols: ParsedXmlElement | null): readonly SectionColumnWidth[] | undefined {
  if (cols === null) return undefined;
  const colElements = findChildren(cols, W_NS, 'col');
  if (colElements.length === 0) return undefined;
  return colElements.map((column, index) => {
    const where = `第 ${String(index + 1)} 栏`;
    const width = readNumber(column, 'w');
    if (width === null || width <= 0) {
      throw new DocxError(
        'invalid_column_width',
        `w:cols 里 ${where} 的 w:col/@w:w 非法（必须是正的 twips 数）：` +
          `${readAttribute(column, 'w') ?? '(缺失)'}`,
      );
    }
    const space = readNumber(column, 'space') ?? 0;
    if (space < 0) {
      throw new DocxError(
        'invalid_column_width',
        `w:cols 里 ${where} 的 w:col/@w:space 非法（不能为负）：${readAttribute(column, 'space') ?? ''}`,
      );
    }
    return { width: twipsToLength(width, 'twips'), space: twipsToLength(space, 'twips') };
  });
}

/**
 * 节的可选字段（`w:type` / `w:pgNumType` / `w:vAlign`）。
 *
 * **为什么补这一段**（WCF-D51 发现、协调者收口）：导出侧（`serializeSectionProperties`）
 * 早就从模型里写这三个，而导入侧此前**不解析**它们。两侧都用本函数所在的模块解析，
 * 于是"未改动"时两边同样为空 ⇒ 判等 ⇒ 写回原字节（**看起来没事**）；可一旦文档的
 * **任何一处**被编辑，主部件就会按模型重建，这三个字段**静默消失**——正是 R151
 * "未修改区域应保留"要挡的事。返回空对象表示"本节没有这三个字段"。
 *
 * `headers` / `footers` **不在这里解析**：它们存的是**部件路径**，要先把 `r:id` 经
 * 关系表解析出来，而本函数拿不到关系表。这是已知缺口，另行登记（不是"不打算支持"）。
 */
function parseSectionExtras(sectPr: ParsedXmlElement): Partial<SectionProperties> {
  const extras: {
    sectionType?: SectionProperties['sectionType'];
    pageNumbering?: SectionProperties['pageNumbering'];
    verticalAlign?: SectionProperties['verticalAlign'];
  } = {};

  const sectionType = readAttribute(findChild(sectPr, W_NS, 'type'), 'val');
  if (
    sectionType === 'continuous' ||
    sectionType === 'nextPage' ||
    sectionType === 'oddPage' ||
    sectionType === 'evenPage'
  ) {
    extras.sectionType = { state: 'set', value: sectionType };
  }

  const pageNumbering = findChild(sectPr, W_NS, 'pgNumType');
  if (pageNumbering !== null) {
    const format = readAttribute(pageNumbering, 'fmt');
    const start = readInteger(pageNumbering, 'start');
    extras.pageNumbering = {
      format: format ?? '',
      start: start === null ? null : start,
    };
  }

  const verticalAlign = readAttribute(findChild(sectPr, W_NS, 'vAlign'), 'val');
  if (
    verticalAlign === 'top' ||
    verticalAlign === 'center' ||
    verticalAlign === 'bottom' ||
    verticalAlign === 'both'
  ) {
    extras.verticalAlign = { state: 'set', value: verticalAlign };
  }

  return extras;
}

/**
 * 节序列化的外部输入。
 *
 * 页眉 / 页脚引用在模型里存的是**部件路径**（`HeaderFooterReference.part_path`），
 * 而 `w:headerReference` / `w:footerReference` 要的是**关系 id**（`r:id`）。
 * 这层映射由调用方给出——由 `export.ts` 负责"关系不存在就分配一条未占用的"（R106），
 * 本函数只做**查表 + 报错**：查不到就抛，绝不写一个悬空的 `r:id`（那会让 Word 拒绝整包）。
 */
export interface SectionSerializeExtras {
  /**
   * 部件路径 + 角色（页眉 / 页脚）→ 关系 id。返回 `null` / `undefined` 表示"这条引用没有落点"，
   * 本函数随即抛 `missing_section_reference_part`。
   *
   * **为什么带 `role`**：OOXML 里页眉与页脚是**两种关系类型**（`…/header` 与 `…/footer`），
   * 各自要有自己的 `r:id`。若同一个部件既当页眉又当页脚，只按路径查表会返回同一个 id，
   * 于是页脚会拿到一条 `…/header` 的关系——那是错误引用（R162）。
   */
  readonly relationshipIdOf?: (partPath: string, role: 'header' | 'footer') => string | null;
  /**
   * **自定义栏宽 / 栏间距**（WF-050；design-05-P4 的剩余接线）。
   *
   * 等宽 N 栏由 `SectionProperties.columns`（栏数）表达、写 `w:cols/@w:num` 就能导出；
   * 而"每栏宽度与间距都不同"在冻结模型里**没有字段**，只能走 `sections/extras.ts` 的附加项
   * 通道（`model.blocks[0].opaque` 里的 `section_extras`）。那是一条**模型外**的通道，
   * 本函数拿不到——因此由调用方（`export.ts`）把该节的栏宽表**查出来**传进来。
   *
   * `cols` 的 twips 值来自 `sections/columns.ts` 的 `columnWidthsInTwips`（换算在 `units/**`，
   * R128：本层不重算第二份）。`cols` 为空数组 ⇒ 回落到 `SectionProperties.columns`。
   */
  readonly columnsOverride?: {
    readonly count: number;
    readonly cols: readonly { readonly width: number; readonly space: number }[];
  } | null;
}

/** `w:headerReference` / `w:footerReference`：`w:type`（default/first/even）+ `r:id`。 */
function serializeHeaderFooterReference(
  name: 'w:headerReference' | 'w:footerReference',
  reference: HeaderFooterReference,
  extras: SectionSerializeExtras,
): XmlElement {
  const role = name === 'w:headerReference' ? 'header' : 'footer';
  const id = extras.relationshipIdOf?.(reference.part_path, role) ?? null;
  if (id === null) {
    throw new DocxError(
      'missing_section_reference_part',
      `${name} 引用的部件 ${reference.part_path} 在关系表里没有落点：` +
        '写一个指向不存在关系的 r:id 会让消费者拒开整个包（R106/R140）。' +
        '调用方应先为该部件分配关系，或把它从节里去掉。',
    );
  }
  return el(name, [attr('w:type', reference.kind), attr('r:id', id)]);
}

/**
 * `SectionProperties` → `w:sectPr`。
 *
 * 子元素顺序照 `CT_SectPr` 的序列：`headerReference*` → `footerReference*` → `pgSz` →
 * `pgMar` → `pgNumType` → `cols` → `vAlign` → `titlePg` → …。顺序不是审美问题：
 * OOXML 的 `CT_SectPr` 是**序列**（sequence），乱序对严格校验器就是非法文档。
 */
export function serializeSectionProperties(
  section: SectionProperties,
  extras: SectionSerializeExtras = {},
): XmlElement {
  const children: XmlElement[] = [];

  for (const reference of section.headers ?? []) {
    children.push(serializeHeaderFooterReference('w:headerReference', reference, extras));
  }
  for (const reference of section.footers ?? []) {
    children.push(serializeHeaderFooterReference('w:footerReference', reference, extras));
  }

  // `w:type` 在 CT_SectPr 序列里紧跟 `footerReference*`、在 `pgSz` 之前。
  // 语义：本 `sectPr` 描述的是**从本节开始**的分节符类型（不是上一节的结束方式）。
  if (section.sectionType !== undefined && section.sectionType.state === 'set') {
    children.push(el('w:type', [attr('w:val', section.sectionType.value)]));
  }

  if (section.pageSize.state === 'set') {
    children.push(
      el('w:pgSz', [
        attr('w:w', formatNumber(lengthToTwips(section.pageSize.value.width))),
        attr('w:h', formatNumber(lengthToTwips(section.pageSize.value.height))),
        ...(section.orientation.state === 'set' ? [attr('w:orient', section.orientation.value)] : []),
      ]),
    );
  }
  if (section.margins.state === 'set') {
    const margins = section.margins.value;
    children.push(
      el('w:pgMar', [
        attr('w:top', formatNumber(lengthToTwips(margins.top))),
        attr('w:right', formatNumber(lengthToTwips(margins.right))),
        attr('w:bottom', formatNumber(lengthToTwips(margins.bottom))),
        attr('w:left', formatNumber(lengthToTwips(margins.left))),
        attr('w:gutter', formatNumber(lengthToTwips(margins.gutter))),
      ]),
    );
  }
  // `w:pgNumType` 排在 `w:cols` **之前**（CT_SectPr 的序列）。
  const pageNumbering = section.pageNumbering;
  if (pageNumbering !== undefined) {
    const attributes = [];
    if (pageNumbering.format.length > 0) attributes.push(attr('w:fmt', pageNumbering.format));
    if (pageNumbering.start !== null) attributes.push(attr('w:start', formatInteger(pageNumbering.start)));
    // 两个属性都空 ⇒ 不写空壳元素（"没设过"与"设了空值"是两回事）。
    if (attributes.length > 0) children.push(el('w:pgNumType', attributes));
  }

  // `w:cols`：自定义栏宽（`w:equalWidth="0"` + N 个 `w:col`）**优先**于等宽栏数。
  // 两者不能并存：`w:num` 与子元素 `w:col` 是**同一份**声明，只写一半会被消费端按默认解释。
  //
  // 三个来源，**优先级从高到低**：
  //   ① `extras.columnsOverride`（附加项通道：`setColumnLayout` 设的自定义栏宽，**本次改动叠加层**）；
  //   ② `section.columnWidths`（**模型字段**：导入侧从 `w:col` 解析出来的，见 `parseColumnWidths`）；
  //   ③ `section.columns`（等宽栏数）。
  // ② 与"未改动 ⇒ 原字节"的判据是**对称**的：原始字节重解析与模型两侧都带上它 ⇒ 两侧写出同一份
  // `w:cols` ⇒ 判等 ⇒ 写回原字节（R151 不回归），而真正改了栏宽（无论走 ① 还是 ②）两侧就会不等。
  const columnsOverride = extras.columnsOverride;
  if (columnsOverride !== undefined && columnsOverride !== null && columnsOverride.cols.length > 0) {
    children.push(
      el(
        'w:cols',
        [attr('w:num', formatInteger(columnsOverride.count)), attr('w:equalWidth', '0')],
        columnsOverride.cols.map((column) =>
          el('w:col', [
            attr('w:w', formatNumber(column.width)),
            attr('w:space', formatNumber(column.space)),
          ]),
        ),
      ),
    );
  } else if (section.columnWidths !== undefined && section.columnWidths.length > 0) {
    children.push(
      el(
        'w:cols',
        [attr('w:num', formatInteger(section.columnWidths.length)), attr('w:equalWidth', '0')],
        section.columnWidths.map((column) =>
          el('w:col', [
            attr('w:w', formatNumber(lengthToTwips(column.width))),
            attr('w:space', formatNumber(lengthToTwips(column.space))),
          ]),
        ),
      ),
    );
  } else if (section.columns.state === 'set') {
    children.push(el('w:cols', [attr('w:num', formatInteger(section.columns.value))]));
  }

  // `w:vAlign` 排在 `w:cols` **之后**、`w:titlePg` 之前。
  if (section.verticalAlign !== undefined && section.verticalAlign.state === 'set') {
    children.push(el('w:vAlign', [attr('w:val', section.verticalAlign.value)]));
  }

  const titlePage = serializeToggle('w:titlePg', section.titlePage);
  if (titlePage !== null) children.push(titlePage);
  const evenAndOdd = serializeToggle('w:evenAndOddHeaders', section.evenAndOddHeaders);
  if (evenAndOdd !== null) children.push(evenAndOdd);

  return el('w:sectPr', [], children);
}

// ---------------------------------------------------------------------------
// 表格属性
// ---------------------------------------------------------------------------

export function emptyTableProperties(): TableProperties {
  return {
    alignment: { state: 'unspecified' },
    indent: { state: 'unspecified' },
    width: { state: 'unspecified' },
    layout: { state: 'unspecified' },
    borders: { state: 'unspecified' },
    shading: { state: 'unspecified' },
    repeatHeader: false,
  };
}

function parseTableWidth(element: ParsedXmlElement | null): ValuedState<Length> {
  if (element === null) return { state: 'unspecified' };
  const width = readNumber(element, 'w');
  const type = (readAttribute(element, 'type') ?? 'dxa').toLowerCase();
  if (width === null || type === 'auto' || type === 'pct') return { state: 'unspecified' };
  return { state: 'set', value: { unit: 'pt', value: twipsToPoints(width) } };
}

export function parseTableProperties(tblPr: ParsedXmlElement | null): TableProperties {
  if (tblPr === null) return emptyTableProperties();
  const alignment = readVal(findChild(tblPr, W_NS, 'jc'));
  const indent = readNumber(findChild(tblPr, W_NS, 'tblInd'), 'w');
  const layout = readAttribute(findChild(tblPr, W_NS, 'tblLayout'), 'type');

  return {
    alignment:
      alignment === 'left' || alignment === 'center' || alignment === 'right'
        ? { state: 'set', value: alignment }
        : { state: 'unspecified' },
    indent:
      indent === null ? { state: 'unspecified' } : { state: 'set', value: { unit: 'pt', value: twipsToPoints(indent) } },
    width: parseTableWidth(findChild(tblPr, W_NS, 'tblW')),
    layout:
      layout === 'fixed' || layout === 'autofit'
        ? { state: 'set', value: layout }
        : { state: 'unspecified' },
    borders: parseBorderEdges(findChild(tblPr, W_NS, 'tblBorders'), [
      ...BORDER_EDGES,
      'insideH',
      'insideV',
    ]),
    shading: parseShading(findChild(tblPr, W_NS, 'shd')),
    repeatHeader: findChild(tblPr, W_NS, 'tblHeader') !== null,
  };
}

/**
 * `w:tblpXSpec` / `w:tblpYSpec` 的合法取值（`ST_XAlign` / `ST_YAlign`）。
 *
 * 模型的 `TableFloatingPosition.horizontal_anchor` / `vertical_anchor` 承载的是**位置**
 * （字段注释给的值域 `left`/`center`/`right` 与 `top`/`center`/`bottom` 正好就是这两个
 * 简单类型的值域）。**锚点本身模型没有建模**，因此显式写出 Word 的默认锚点
 * （`horzAnchor="margin"` / `vertAnchor="text"`）。
 *
 * 为什么必须**校验**而不是照抄：`w:tblpXSpec` 是枚举属性，写一个枚举外的值
 * （例如 `"middle"`）会让严格校验器判文档非法、Word 报"内容有问题"。R140 的取向是
 * **先拒绝、不产出半成品**，因此这里抛 `unsupported_table_position` 而不是把未知串写进文件。
 */
const TBLP_X_SPEC: ReadonlySet<string> = new Set(['left', 'center', 'right', 'inside', 'outside']);
const TBLP_Y_SPEC: ReadonlySet<string> = new Set([
  'top',
  'center',
  'bottom',
  'inline',
  'inside',
  'outside',
]);

/**
 * 环绕模式 → `w:leftFromText` / `w:rightFromText`（与正文的左右最小间距，twips）。
 *
 * ## 为什么只能映射到"间距"（**这是一处近似，必须说清楚**）
 *
 * Word 界面里浮动表格的"文字环绕：环绕 / 无"在 `w:tblpPr` 里**没有**一个直接的枚举属性：
 * `w:tblpPr` 只提供定位（`tblpX/tblpY/tblpXSpec/tblpYSpec/horzAnchor/vertAnchor`）与四边
 * 文字间距（`leftFromText`/`rightFromText`/`topFromText`/`bottomFromText`）。
 * 而 `w:tblOverlap` 讲的是"**浮动表格之间**能否重叠"（`ST_TblOverlap` = `never`/`overlap`），
 * **不是**文字环绕模式——把它当环绕写是错的。
 *
 * 因此本批的映射是：`around`（四周环绕）⇒ 左右各留 Word 的默认间距 0.125"；
 * `none`（上下型）⇒ 左右间距 0。**这是近似**：它让"是否与正文左右相邻"可表达，
 * 但不声称与 Word 界面的"环绕/无"语义等价；Word 渲染效果**未验证**（见交付说明）。
 */
const TEXT_WRAP_DISTANCE_TWIPS: Readonly<Record<'around' | 'none', number>> = Object.freeze({
  around: 180,
  none: 0,
});

/** `TableFloatingPosition` → `w:tblpPr`（`w:tblPr` 的第一个子元素）。 */
export function tableFloatingPositionElement(floating: TableFloatingPosition): XmlElement {
  if (!TBLP_X_SPEC.has(floating.horizontal_anchor)) {
    throw new DocxError(
      'unsupported_table_position',
      `表格水平位置 ${JSON.stringify(floating.horizontal_anchor)} 不是 w:tblpXSpec 的合法取值` +
        `（${[...TBLP_X_SPEC].join(' / ')}）：写进文件会让消费者认为文档非法（R140 先拒绝）。`,
    );
  }
  if (!TBLP_Y_SPEC.has(floating.vertical_anchor)) {
    throw new DocxError(
      'unsupported_table_position',
      `表格垂直位置 ${JSON.stringify(floating.vertical_anchor)} 不是 w:tblpYSpec 的合法取值` +
        `（${[...TBLP_Y_SPEC].join(' / ')}）：写进文件会让消费者认为文档非法（R140 先拒绝）。`,
    );
  }
  const distance = TEXT_WRAP_DISTANCE_TWIPS[floating.text_wrapping];
  return el('w:tblpPr', [
    attr('w:horzAnchor', 'margin'),
    attr('w:vertAnchor', 'text'),
    attr('w:tblpXSpec', floating.horizontal_anchor),
    attr('w:tblpYSpec', floating.vertical_anchor),
    attr('w:tblpX', formatNumber(lengthToTwips(floating.horizontal_offset))),
    attr('w:tblpY', formatNumber(lengthToTwips(floating.vertical_offset))),
    attr('w:leftFromText', formatNumber(distance)),
    attr('w:rightFromText', formatNumber(distance)),
  ]);
}

export function serializeTableProperties(properties: TableProperties): XmlElement | null {
  const children: XmlElement[] = [];
  const push = (element: XmlElement | null): void => {
    if (element !== null) children.push(element);
  };
  // `w:tblpPr` 必须**排在最前**（CT_TblPr 序列里它在 `w:tblW` 之前）。
  // 只有模型确实设了 `floating` 才写：`w:tblpPr` 的**存在本身**就是"这张表浮动"的判据，
  // 凭空写一个会让内联表变成浮动表（那是行为改变，不是格式保留）。
  push(properties.floating == null ? null : tableFloatingPositionElement(properties.floating));
  push(serializeValued(properties.width, (width) =>
    el('w:tblW', [attr('w:w', formatNumber(lengthToTwips(width))), attr('w:type', 'dxa')]),
  ));
  push(serializeValued(properties.alignment, (alignment) => el('w:jc', [attr('w:val', alignment)])));
  push(serializeValued(properties.indent, (indent) =>
    el('w:tblInd', [attr('w:w', formatNumber(lengthToTwips(indent))), attr('w:type', 'dxa')]),
  ));
  push(serializeValued(properties.borders, (borders) =>
    serializeBorderEdges('w:tblBorders', borders, [...BORDER_EDGES, 'insideH', 'insideV']),
  ));
  push(serializeValued(properties.shading, (shading) => serializeShading('w:shd', shading)));
  push(serializeValued(properties.layout, (layout) => el('w:tblLayout', [attr('w:type', layout)])));
  if (properties.repeatHeader) children.push(el('w:tblHeader'));
  return children.length === 0 ? null : el('w:tblPr', [], children);
}

export function emptyCellProperties(): CellProperties {
  return {
    verticalAlign: { state: 'unspecified' },
    shading: { state: 'unspecified' },
    borders: { state: 'unspecified' },
    width: { state: 'unspecified' },
  };
}

export function parseCellProperties(tcPr: ParsedXmlElement | null): CellProperties {
  if (tcPr === null) return emptyCellProperties();
  const verticalAlign = readVal(findChild(tcPr, W_NS, 'vAlign'));
  return {
    verticalAlign:
      verticalAlign === 'top' || verticalAlign === 'center' || verticalAlign === 'bottom'
        ? { state: 'set', value: verticalAlign }
        : { state: 'unspecified' },
    shading: parseShading(findChild(tcPr, W_NS, 'shd')),
    borders: parseBorderEdges(findChild(tcPr, W_NS, 'tcBorders'), BORDER_EDGES),
    width: parseTableWidth(findChild(tcPr, W_NS, 'tcW')),
  };
}

/**
 * `CellProperties.margins` → `w:tcMar`。
 *
 * 四边按 `CT_TblCellMar` 的序列 `top, left, bottom, right`；某一边是 `null` ⇒ **不写该边**
 * （不写 = 继续继承表格级 `w:tblCellMar`，写 0 = 显式压成 0，两者语义不同）。
 * 四边全 `null` ⇒ 连 `w:tcMar` 空壳都不写。
 */
export function cellMarginsElement(properties: CellProperties): XmlElement | null {
  const margins = properties.margins;
  if (margins === undefined || margins.state !== 'set') return null;
  const children: XmlElement[] = [];
  const pushEdge = (name: string, value: Length | null): void => {
    if (value !== null) {
      children.push(
        el(`w:${name}`, [attr('w:w', formatNumber(lengthToTwips(value))), attr('w:type', 'dxa')]),
      );
    }
  };
  pushEdge('top', margins.value.top);
  pushEdge('left', margins.value.left);
  pushEdge('bottom', margins.value.bottom);
  pushEdge('right', margins.value.right);
  return children.length === 0 ? null : el('w:tcMar', [], children);
}

/**
 * `w:tcPr` 的**子元素**数组（`gridSpan` / `vMerge` 由调用方追加——它们与属性集的写法不同）。
 *
 * `w:tcMar` 的位置照 `CT_TcPr` 的序列：`tcW` → `tcBorders` → `shd` → **`tcMar`** → `vAlign`。
 */
export function serializeCellPropertyChildren(properties: CellProperties): XmlElement[] {
  const children: XmlElement[] = [];
  const push = (element: XmlElement | null): void => {
    if (element !== null) children.push(element);
  };
  push(serializeValued(properties.width, (width) =>
    el('w:tcW', [attr('w:w', formatNumber(lengthToTwips(width))), attr('w:type', 'dxa')]),
  ));
  push(serializeValued(properties.borders, (borders) =>
    serializeBorderEdges('w:tcBorders', borders, BORDER_EDGES),
  ));
  push(serializeValued(properties.shading, (shading) => serializeShading('w:shd', shading)));
  push(cellMarginsElement(properties));
  push(serializeValued(properties.verticalAlign, (align) => el('w:vAlign', [attr('w:val', align)])));
  return children;
}

export function serializeCellProperties(properties: CellProperties): XmlElement | null {
  const children = serializeCellPropertyChildren(properties);
  return children.length === 0 ? null : el('w:tcPr', [], children);
}

// ---------------------------------------------------------------------------
// units 的反向换算再导出（避免调用方为了一个函数去 import 两个模块）
// ---------------------------------------------------------------------------

/**
 * 半点值 → pt 的 `Length`（`w:position` 用；`w:sz` 走 units 的 `halfPointsToFontSize`）。
 * 换算比率来自 units 的常量，本层不写 `2`。
 */
function halfPointsToLength(halfPoints: number): Length {
  return { unit: 'pt', value: halfPoints / HALF_POINTS_PER_POINT };
}

/** `Length` → 半点值（`w:position` 用）。步长换算来自 units。 */
function pointsToHalfPoints(length: Length): number {
  return Math.round(lengthToPoints(length) * HALF_POINTS_PER_POINT);
}

/** 供 `import.ts` / `export.ts` 复用的子元素查询（**不看文本节点**）。 */
export { childElements, findChild, findChildren };
export type { ParsedXmlElement };
export { EMPTY_INDENT_ATTRIBUTES };

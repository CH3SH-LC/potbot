/**
 * `word/styles.xml` 的**写出**（design-05-P3 的导出侧收口；合同 R105 / R122 / R123 / R151）。
 *
 * ## 一句话
 *
 * 模型里的 `StyleTable` 与"从原字节解析出来的样式表"**规范化后不等**才重建这个部件；
 * 相等时**仍写原字节**（R151 的既有纪律，一个字节都不动）。
 *
 * ## 判据为什么是"规范化对规范化"（与 `package-parts.ts` 同一条纪律）
 *
 * 拿"我生成的字节"和"原字节"直接比会**永远不等**（真实 Word 写 `\r\n`、本仓写 `\n`；
 * 属性顺序、自闭合写法也可能不同）。本模块的做法与内容类型表 / 关系表**完全一致**：
 *
 * ```
 * stylesPartXml(模型里的表, null)  ===  stylesPartXml(parseStyles(原字节), null)  ⇒  未改动
 * ```
 *
 * 两侧都过**同一个**序列化器（同一个根元素、同一套子元素顺序），比较的是**结构**。
 *
 * ## 重建走"补丁"，不走"重建整棵树"（R105）
 *
 * 真实 `styles.xml` 里的 `w:docDefaults`、`w:latentStyles`、每个 `w:style` 里的
 * `w:uiPriority` / `w:qFormat` / `w:next` / `w:link`、`w:pPr` 里的 `w:numPr`、
 * `w:style` 上的 `w:default` 属性**都不在模型里**。按模型重建整棵树会让它们**静默消失**。
 * 因此重建把原树保留下来，只替换模型表达得了的槽位（`xml-patch.ts`）。
 *
 * ## 环检测（R123 / R140）
 *
 * `basedOn` 成环或指向不存在的样式时**明确拒绝**（`DocxError`），**不产出半成品**。
 * 注意检测**只在重建路径上**跑：模型与原字节相等时不重建、写原字节，
 * 因此"原文件本来就有坏引用"不会把一次无关的导出变成失败（R151 优先）。
 */

import { attr, el, serializeXmlNode, type XmlElement, type XmlNode } from '../../artifacts/ooxml/xml.js';
import type { ParagraphProperties, RunProperties, StyleDefinition, StyleTable } from '../model/types.js';
import { resolveStyleChain } from '../styles/chain.js';
import { DocxError } from './docx-error.js';
import { parseStyles, STYLES_PART_PATH } from './import.js';
import {
  convertParsedElement,
  isParsedWordElement,
  patchChildren,
  type ChildRankLookup,
  type ModeledSlot,
} from './xml-patch.js';
import { parseXmlBytes, attributeValue, childElements, type ParsedXmlElement } from './xml-parse.js';
import {
  W_NS,
  emptyParagraphProperties,
  emptyRunProperties,
  serializeParagraphPropertyChildren,
  serializeRunProperties,
} from './word-xml.js';

/** 样式部件路径（与 `import.ts` **同一个**常量，避免两处各写一遍字面量）。 */
export { STYLES_PART_PATH };

/** 主部件 → 样式表的**关系类型**。 */
export const STYLES_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles';

/** 样式部件的**内容类型**。 */
export const STYLES_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml';

/** `import.ts` 认可并建模的样式类型（导出侧的分流判据必须与它一致）。 */
const MODELED_STYLE_TYPES: ReadonlySet<string> = new Set([
  'paragraph',
  'character',
  'table',
  'numbering',
]);

/**
 * `CT_Style` 的子元素 schema 顺序（ECMA-376 §17.7.4.17）。
 *
 * 用于两件事：把模型重建出来的子元素插到**正确的槽位**，以及给未建模的同级元素定游标。
 */
const STYLE_CHILD_RANKS: Readonly<Record<string, number>> = {
  name: 1,
  aliases: 2,
  basedOn: 3,
  next: 4,
  link: 5,
  autoRedefine: 6,
  hidden: 7,
  uiPriority: 8,
  semiHidden: 9,
  unhideWhenUsed: 10,
  qFormat: 11,
  locked: 12,
  personal: 13,
  personalCompose: 14,
  personalReply: 15,
  rsid: 16,
  pPr: 17,
  rPr: 18,
  tblPr: 19,
  trPr: 20,
  tcPr: 21,
  tblStylePr: 22,
};

/**
 * `CT_PPrBase` 的子元素 schema 顺序。
 *
 * 与 `word-xml.ts` 的 `serializeParagraphPropertyChildren` 的**写出顺序不完全一致**
 * （那支是主部件既有行为，本批不动它）。这里用 schema 顺序：它作用于**补丁**——把一个槽位
 * 插进真实 Word 写出来的 `w:pPr` 里，落在 schema 槽上最安全。
 */
const PARAGRAPH_CHILD_RANKS: Readonly<Record<string, number>> = {
  pStyle: 1,
  keepNext: 2,
  keepLines: 3,
  pageBreakBefore: 4,
  framePr: 5,
  widowControl: 6,
  numPr: 7,
  suppressLineNumbers: 8,
  pBdr: 9,
  shd: 10,
  tabs: 11,
  suppressAutoHyphens: 12,
  kinsoku: 13,
  wordWrap: 14,
  overflowPunct: 15,
  topLinePunct: 16,
  autoSpaceDE: 17,
  autoSpaceDN: 18,
  bidi: 19,
  adjustRightInd: 20,
  snapToGrid: 21,
  spacing: 22,
  ind: 23,
  contextualSpacing: 24,
  mirrorIndents: 25,
  suppressOverlap: 26,
  jc: 27,
  textDirection: 28,
  textAlignment: 29,
  textboxTightWrap: 30,
  outlineLvl: 31,
  divId: 32,
  cnfStyle: 33,
  rPr: 34,
  sectPr: 35,
  pPrChange: 36,
};

/** `CT_RPr` 的子元素 schema 顺序。 */
const RUN_CHILD_RANKS: Readonly<Record<string, number>> = {
  rStyle: 1,
  rFonts: 2,
  b: 3,
  bCs: 4,
  i: 5,
  iCs: 6,
  caps: 7,
  smallCaps: 8,
  strike: 9,
  dstrike: 10,
  outline: 11,
  shadow: 12,
  emboss: 13,
  imprint: 14,
  noProof: 15,
  snapToGrid: 16,
  vanish: 17,
  webHidden: 18,
  color: 19,
  spacing: 20,
  w: 21,
  kern: 22,
  position: 23,
  sz: 24,
  szCs: 25,
  highlight: 26,
  u: 27,
  effect: 28,
  bdr: 29,
  shd: 30,
  fitText: 31,
  vertAlign: 32,
  rtl: 33,
  cs: 34,
  em: 35,
  lang: 36,
  eastAsianLayout: 37,
  specVanish: 38,
  oMath: 39,
};

/** 未知子元素的兜底位次（排在所有已知位次之后，仅用于防御未来新增）。 */
const UNKNOWN_RANK_BASE = 900;

/**
 * `serializeRunProperties` **可能写出来**的子元素名 = 模型表达得了的 `w:rPr` 槽位。
 *
 * ## 为什么必须显式列出"模型槽位"，而不是"序列化器这次吐了什么"
 *
 * 补丁算法需要区分两件**看起来一样**的事：
 *
 * | 情形 | 正确动作 |
 * |---|---|
 * | 模型把这个属性设成 `unspecified`（用户清掉了粗体） | **删掉**原树里的 `<w:b/>` |
 * | 模型**根本不表达**这个子元素（如 `w:rStyle` / `w:lang`） | **原样保留**（R105） |
 *
 * 只看"序列化器这次吐了什么"分不出这两者：两者都表现为"这次没吐这个元素"。
 * 所以用这张**白名单**划界——在白名单里的、这次没吐的 ⇒ 删；不在白名单里的 ⇒ 一律保留。
 *
 * `w:shd` 在两个名单里都出现（`w:rPr` 与 `w:pPr` 各有一个 `w:shd`），两张表彼此独立，不冲突。
 */
const MODELED_RUN_CHILD_NAMES: readonly string[] = [
  'rFonts',
  'b',
  'i',
  'caps',
  'smallCaps',
  'strike',
  'dstrike',
  'color',
  'spacing',
  'w',
  'sz',
  'szCs',
  'highlight',
  'u',
  'vertAlign',
  'position',
  'shd',
];

/**
 * `serializeParagraphPropertyChildren(properties)`（**不给 `extras`**）可能写出来的子元素名。
 *
 * 刻意**不含** `pStyle` / `numPr` / `sectPr`：它们由 extras 传入，样式的
 * `paragraph_properties` 表达不了，因此在重建时必须**原样保留**（真实 `styles.xml` 里
 * `w:pPr/w:numPr` 极常见——列表样式的定义就靠它）。
 */
const MODELED_PARAGRAPH_CHILD_NAMES: readonly string[] = [
  'keepNext',
  'keepLines',
  'pageBreakBefore',
  'pBdr',
  'shd',
  'tabs',
  'spacing',
  'ind',
  'widowControl',
  'outlineLvl',
  'jc',
];

// ---------------------------------------------------------------------------
// 查询与守卫
// ---------------------------------------------------------------------------

/** 样式表里一个样式都没有。 */
export function isEmptyStyleTable(table: StyleTable): boolean {
  return table.styles.length === 0;
}

/**
 * 写出**之前**的继承链体检（R123 / R140）。
 *
 * 逐条样式跑 `resolveStyleChain`（D04 的**唯一**链解析实现，这里不重写第二套）：
 *
 * - `cycle` ⇒ 拒绝（这是 R123 点名要挡的"无限递归"形态）；
 * - `dangling_reference` ⇒ 拒绝（R123 的"坏引用"；写出去就是一份引用不存在样式的坏表）。
 *
 * `wrong_type`（段落样式基于字符样式之类）**不拒绝**：原文件里真实存在这种写法，
 * 写回去等于"原样保留"，拒绝它反而会让一次无关的导出失败。
 *
 * @throws {DocxError} `style_chain_invalid`
 */
export function assertStyleChainHealthy(table: StyleTable): void {
  for (const style of table.styles) {
    const result = resolveStyleChain(table, style.style_id);
    if (result.ok) continue;
    const { kind, style_id, detail, path } = result.problem;
    if (kind !== 'cycle' && kind !== 'dangling_reference') continue;
    throw new DocxError(
      'style_chain_invalid',
      `样式 ${JSON.stringify(style_id)} 的 basedOn 继承链不可写出（${kind}）：${detail}` +
        (path.length === 0 ? '' : `；链路径：${path.join(' → ')}`),
    );
  }
}

// ---------------------------------------------------------------------------
// 序列化
// ---------------------------------------------------------------------------

/**
 * 样式表 → `styles.xml` 文本。
 *
 * @param table 模型侧的样式表。
 * @param originalBytes 原部件字节；`null` 表示"包里本来没有这个部件"（此时按模型新建一棵树）。
 *   传 `null` 得到的就是**规范化指纹**（只含模型表达得了的部分），用于"是否改动"的比较。
 */
export function stylesPartXml(table: StyleTable, originalBytes: Uint8Array | null): string {
  const root =
    originalBytes === null
      ? el('w:styles', [attr('xmlns:w', W_NS)], table.styles.map((style) => styleElement(null, style)))
      : mergeStyleRoot(parseXmlBytes(originalBytes), table);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${serializeXmlNode(root)}`;
}

/**
 * 样式表的**规范化指纹**：与"从原字节解析出来的表"比，相等即判定未改动。
 *
 * 用 `stylesPartXml(table, null)` 而不是手搓一个字符串——保证指纹与写出器**同源**，
 * 于是"指纹相同但写出来不同"不可能发生。
 */
export function stylesTableFingerprint(table: StyleTable): string {
  return stylesPartXml(table, null);
}

/**
 * 模型与原字节是否等价（等价 ⇒ 写回原字节）。
 *
 * ## 原字节**读不出来**时判"未改动"（保守回退，不是"改成功"）
 *
 * 走到这一步的模型一般来自 `importDocx`，而导入也调 `parseStyles`——所以"导入成功却读不出
 * `styles.xml`"在正常链路上不可能发生。但模型是**纯数据**，调用方可以手搓一个
 * `opaque_parts` 里放着不可解析字节的模型。那时若让 `parseStyles` 的异常冒出去，
 * 就等于"**导出因为一个我们看不懂的既有字节而整体失败**"——比原行为（原样写回）更糟。
 *
 * 因此这里的取舍是：**读不出来 ⇒ 判"未改动" ⇒ 写回原字节，不重建**。
 * 这既不丢内容（R105），也不假装改成功——代价是"模型对样式表的改动不会被应用"，
 * 属刻意的保守边界（判据与 R151 同向：拿不准就保原样）。
 */
export function stylesPartUnchanged(table: StyleTable, originalBytes: Uint8Array): boolean {
  let parsed: StyleTable;
  try {
    parsed = parseStyles(originalBytes, STYLES_PART_PATH);
  } catch {
    return true;
  }
  return stylesTableFingerprint(table) === stylesTableFingerprint(parsed);
}

/**
 * 把原树的顶层子节点按模型改写：`w:style` 按 `styleId` 匹配后打补丁，其余**原样保留**。
 *
 * 分流（三种情形，必须分得清）：
 *
 * | 原树里的 `w:style` | 处理 |
 * |---|---|
 * | 有 `styleId` 且类型在建模集合内，模型里有同 id | **打补丁**重建 |
 * | 有 `styleId` 且在建模集合内，模型里没有 | 视为**删除**（模型侧 `deleteNamedStyle` 的语义） |
 * | 没有 `styleId`，或类型不在建模集合内（导入时就被跳过） | **原样保留**（R105：模型根本没表达过它） |
 *
 * 模型里新增（原树没有）的样式**追加在末尾**——`w:style` 之间没有顺序语义，
 * 追加不会动到任何既有样式的位置。
 */
function mergeStyleRoot(root: ParsedXmlElement, table: StyleTable): XmlElement {
  const byId = new Map<string, StyleDefinition>();
  for (const style of table.styles) byId.set(style.style_id, style);

  const emitted = new Set<string>();
  const children: XmlNode[] = [];
  for (const child of root.children) {
    if (child.kind !== 'element' || !isParsedWordElement(child, 'style')) {
      children.push(child.kind === 'text' ? child.value : convertParsedElement(child));
      continue;
    }
    const styleId = attributeValue(child, W_NS, 'styleId');
    const type = attributeValue(child, W_NS, 'type') ?? 'paragraph';
    if (styleId === null || !MODELED_STYLE_TYPES.has(type)) {
      children.push(convertParsedElement(child));
      continue;
    }
    const style = byId.get(styleId);
    if (style === undefined) continue; // 已删除：不再写出（引用它的段落由模型侧负责改指）
    emitted.add(styleId);
    children.push(styleElement(child, style));
  }

  for (const style of table.styles) {
    if (!emitted.has(style.style_id)) children.push(styleElement(null, style));
  }

  return el(
    'w:styles',
    root.attributes.map((attribute) => attr(attribute.name, attribute.value)),
    children,
  );
}

/**
 * 一个 `w:style` 元素。
 *
 * - 属性：**从原元素继承**（保住 `w:default` / `w:customStyle` 之类模型没建模的属性），
 *   只覆盖 `w:type` / `w:styleId` / `w:default`（后者仅在模型显式 `is_default` 时写出）；
 * - 子节点：`w:name` / `w:basedOn` / `w:pPr` / `w:rPr` 四个槽位按模型重建，
 *   其余（`w:uiPriority`、`w:qFormat`、`w:next`、`w:link` …）**原样保留**。
 */
function styleElement(original: ParsedXmlElement | null, style: StyleDefinition): XmlElement {
  const inherited =
    original === null
      ? []
      : original.attributes
          .filter(
            (attribute) => attribute.name !== 'w:type' && attribute.name !== 'w:styleId',
          )
          .map((attribute) => attr(attribute.name, attribute.value));

  /**
   * `w:default` **是 `w:style` 上的属性**（不是子元素），而模型的 `is_default` 只在
   * "确实是默认样式"时有值——**它表达不了"明确不是默认"**。
   *
   * 因此这里的规则是"**保留原样，只在模型说它默认时才改成 1**"：真实 Word 文件里
   * `<w:style w:default="1" w:styleId="Normal">` 的 `w:default="1"` 因此**不会**在
   * 重建其它样式时被顺手抹掉（R105）。若反过来按 `is_default` 覆写，改一个无关样式
   * 就会把文档的默认样式标记清掉。
   */
  const rest = style.is_default
    ? inherited.filter((attribute) => attribute.name !== 'w:default')
    : inherited;

  const attributes = [
    attr('w:type', style.type),
    attr('w:styleId', style.style_id),
    ...(style.is_default ? [attr('w:default', '1')] : []),
    ...rest,
  ];

  const slots: ModeledSlot[] = [
    { name: 'name', rank: STYLE_CHILD_RANKS.name as number, element: el('w:name', [attr('w:val', style.name)]) },
    {
      name: 'basedOn',
      rank: STYLE_CHILD_RANKS.basedOn as number,
      element: style.based_on === null ? null : el('w:basedOn', [attr('w:val', style.based_on)]),
    },
    {
      name: 'pPr',
      rank: STYLE_CHILD_RANKS.pPr as number,
      element: paragraphPropertiesElement(
        original === null ? null : findWordChild(original, 'pPr'),
        style.paragraph_properties,
      ),
    },
    {
      name: 'rPr',
      rank: STYLE_CHILD_RANKS.rPr as number,
      element: runPropertiesElement(
        original === null ? null : findWordChild(original, 'rPr'),
        style.run_properties,
      ),
    },
  ];

  const children =
    original === null
      ? slots.flatMap((slot) => (slot.element === null ? [] : [slot.element]))
      : patchChildren(original, slots, rankOf(STYLE_CHILD_RANKS));

  return el('w:style', attributes, children);
}

/**
 * `w:pPr`：模型属性 → 子元素，再**打进**原 `w:pPr`（保住 `w:numPr` 等未建模子节点）。
 *
 * `null` 表示"这个槽位不产出"：模型里一个属性都没设、原树里也没有可保留的东西时，
 * 整个 `w:pPr` 不写（而不是写一个空的）。
 */
function paragraphPropertiesElement(
  original: ParsedXmlElement | null,
  properties: Partial<ParagraphProperties>,
): XmlElement | null {
  const built = serializeParagraphPropertyChildren(withParagraphDefaults(properties));
  const slots = modeledSlots(built, MODELED_PARAGRAPH_CHILD_NAMES, PARAGRAPH_CHILD_RANKS);
  if (original === null) {
    const produced = slots.flatMap((slot) => (slot.element === null ? [] : [slot.element]));
    return produced.length === 0 ? null : el('w:pPr', [], produced);
  }
  const children = patchChildren(original, slots, rankOf(PARAGRAPH_CHILD_RANKS));
  return children.length === 0 ? null : el('w:pPr', [], children);
}

/** `w:rPr`：同 `w:pPr` 的补丁策略。 */
function runPropertiesElement(
  original: ParsedXmlElement | null,
  properties: Partial<RunProperties>,
): XmlElement | null {
  const built = serializeRunProperties(withRunDefaults(properties));
  if (original === null) {
    return built;
  }
  // 原树里**有** `w:rPr`：即使模型一个属性都没设，也只能把模型槽位清掉，
  // 不能整块丢弃——`w:rPr` 里可能住着模型没建模的东西（`w:rStyle` / `w:lang` / `w:rtl` …，R105）。
  const produced =
    built === null
      ? []
      : built.children.filter((child): child is XmlElement => typeof child !== 'string');
  const slots = modeledSlots(produced, MODELED_RUN_CHILD_NAMES, RUN_CHILD_RANKS);
  const children = patchChildren(original, slots, rankOf(RUN_CHILD_RANKS));
  return children.length === 0 ? null : el('w:rPr', [], children);
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 位次查询表 → `ChildRankLookup`。 */
function rankOf(table: Readonly<Record<string, number>>): ChildRankLookup {
  return (localName) => table[localName] ?? null;
}

/**
 * "序列化器这次吐出来的元素" + "模型槽位白名单" → 补丁槽位表。
 *
 * 白名单里这次**没**吐出来的 ⇒ `element: null`（**删除**，语义是"用户把这个属性清掉了"）；
 * 吐出来的 ⇒ 用新元素替换。白名单外的子元素完全不出现在槽位表里 ⇒ 原地保留（R105）。
 */
function modeledSlots(
  produced: readonly XmlElement[],
  modeledNames: readonly string[],
  ranks: Readonly<Record<string, number>>,
): ModeledSlot[] {
  const byName = new Map<string, XmlElement>();
  for (const element of produced) byName.set(localNameOf(element.name), element);
  return modeledNames.map((name) => ({
    name,
    rank: ranks[name] ?? UNKNOWN_RANK_BASE,
    element: byName.get(name) ?? null,
  }));
}

/** `w:pPr` → `pPr`（写出器产出的名字一定带 `w:` 前缀；不带前缀时原样返回）。 */
function localNameOf(name: string): string {
  return name.startsWith('w:') ? name.slice(2) : name;
}

/** 原元素里第一个 `w:<localName>` 子元素。 */
function findWordChild(element: ParsedXmlElement, localName: string): ParsedXmlElement | null {
  for (const child of childElements(element)) {
    if (isParsedWordElement(child, localName)) return child;
  }
  return null;
}

/** 把 `Partial<RunProperties>` 补成完整状态（缺的字段 = `unspecified`，不是"显式关闭"，R118）。 */
function withRunDefaults(partial: Partial<RunProperties>): RunProperties {
  const merged: Record<string, unknown> = { ...emptyRunProperties() };
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as unknown as RunProperties;
}

/**
 * 把 `Partial<ParagraphProperties>` 补成完整状态。
 *
 * `indent` 单独深合并：它是**唯一**一个嵌套的普通对象（其余字段都是五态包装），
 * 浅合并会让半份 `indent` 漏掉未给到的槽位，下游 `buildIndentAttributes` 读到 `undefined`。
 */
function withParagraphDefaults(partial: Partial<ParagraphProperties>): ParagraphProperties {
  const defaults = emptyParagraphProperties();
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined) merged[key] = value;
  }
  merged.indent = { ...defaults.indent, ...(partial.indent ?? {}) };
  return merged as unknown as ParagraphProperties;
}

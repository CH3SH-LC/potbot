/**
 * `word/numbering.xml` 的**读 / 写**（design-05-P3 的导出侧收口；合同 R105 / R106 / R151）。
 *
 * ## 为什么这一支要"读"也要"写"
 *
 * 段落上的 `w:numPr` 只是一条**引用**（`w:numId` + `w:ilvl`），列表长什么样住在 `numbering.xml`。
 * 于是"新建的列表在输出里显示正确编号"要成立，`numbering.xml` 必须真的被写出来；
 * 而"没改列表时逐字节不变"（R151）要成立，就必须能**把原字节解析成一张编号表**当比对基线。
 * 两者都要，所以本文件同时提供解析与写出——它是 OOXML ↔ 编号表转换的**唯一**落点（R107）。
 *
 * ## 判据与 `styles-part.ts` 完全同构
 *
 * ```
 * numberingPartXml(模型里的表, null)  ===  numberingPartXml(parseNumberingPart(原字节), null)  ⇒  未改动
 * ```
 *
 * ## `w:numId` / `w:abstractNumId` 一个不动（R106 的同类纪律）
 *
 * 重建时**既有条目按原顺序、按原 id 逐条写出**，新条目**追加**在末尾：
 * 既有 `w:abstractNum` 的位置不会被新条目挤动，既有 `w:num` 的编号不会被重新分配。
 * 新实例的 `w:numId` 由 D32 的 `nextNumId()`（取最小未占用值）在**模型层**分配，
 * 本模块只如实写出，不擅自改号。
 *
 * ## 未建模内容保留（R105）
 *
 * `w:numPicBullet` / `w:numIdMacAtCleanup` / `w:lvl` 里的 `w:legacy` / `w:tentative` /
 * `w:rPr` 上的 `w:hint` 都不在模型里，重建时一律**原地保留**（`xml-patch.ts` 的补丁算法）。
 */

import { attr, el, serializeXmlNode, type XmlElement, type XmlNode } from '../../artifacts/ooxml/xml.js';
import type { FontSet, IndentAmount } from '../model/types.js';
import { toNumberingPartShape } from '../numbering/resolve.js';
import type {
  AbstractNumbering,
  ListLevelDefinition,
  ListLevelFormat,
  NumberingAbstractPartShape,
  NumberingInstance,
  NumberingInstancePartShape,
  NumberingLevelPartShape,
  NumberingTable,
} from '../numbering/types.js';
import { indentAmountToSlotAttributes } from '../units/index.js';
import { DocxError } from './docx-error.js';
import {
  convertParsedElement,
  isParsedWordElement,
  isWordElement,
  patchChildren,
  type ChildRankLookup,
  type ModeledSlot,
} from './xml-patch.js';
import { attributeValue, childElements, findChild, parseXmlBytes, type ParsedXmlElement } from './xml-parse.js';
import { W_NS } from './word-xml.js';

/** 编号部件路径。 */
export const NUMBERING_PART_PATH = 'word/numbering.xml';

/** 主部件 → 编号表的**关系类型**。 */
export const NUMBERING_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering';

/** 编号部件的**内容类型**。 */
export const NUMBERING_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml';

/** 合法的 `w:numFmt` 取值集合（模型侧 `ListLevelFormat` 的解析白名单）。 */
const LEVEL_FORMATS: ReadonlySet<string> = new Set([
  'decimal',
  'lowerLetter',
  'upperLetter',
  'lowerRoman',
  'upperRoman',
  'bullet',
  'none',
]);

const LEVEL_ALIGNMENTS: ReadonlySet<string> = new Set(['left', 'center', 'right']);

const MULTI_LEVEL_TYPES: ReadonlySet<string> = new Set(['singleLevel', 'multilevel', 'hybridMultilevel']);

/** `CT_Lvl` 的子元素 schema 顺序（ECMA-376 §17.9.6）。 */
const LEVEL_CHILD_RANKS: Readonly<Record<string, number>> = {
  start: 1,
  numFmt: 2,
  lvlRestart: 3,
  pStyle: 4,
  isLgl: 5,
  suff: 6,
  lvlText: 7,
  lvlPicBulletId: 8,
  legacy: 9,
  lvlJc: 10,
  pPr: 11,
  rPr: 12,
};

/** `CT_NumLvl` 的子元素顺序：`startOverride` → `lvl`。 */
const OVERRIDE_CHILD_RANKS: Readonly<Record<string, number>> = {
  startOverride: 1,
  lvl: 2,
};

/** `w:ind` 属性在 `w:pPr` 里的位次（`w:pPr` 用 `CT_PPrGeneral`）。 */
const PARAGRAPH_IND_RANK = 23;

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/**
 * `word/numbering.xml` → `NumberingTable`。
 *
 * **容错取向**（与导入侧一致）：认不出来的条目**跳过而不是抛错**——编号表是"能读多少读多少"
 * 的部件，一个坏级别不该让整份文档读不进来。跳过的代价是"该级别会以默认值重建"，
 * 这只在**重建路径**（模型确实改了编号表）上才会发生。
 */
export function parseNumberingPart(bytes: Uint8Array, partPath: string = NUMBERING_PART_PATH): NumberingTable {
  const root = parseXmlBytes(bytes);
  if (root.namespace !== W_NS || root.localName !== 'numbering') {
    throw new DocxError(
      'invalid_document_root',
      `${partPath} 的根元素不是 {${W_NS}}numbering（实际 ${root.name}）`,
    );
  }

  const abstract: AbstractNumbering[] = [];
  const instances: NumberingInstance[] = [];
  for (const child of childElements(root)) {
    if (child.namespace !== W_NS) continue;
    if (child.localName === 'abstractNum') {
      const id = attributeValue(child, W_NS, 'abstractNumId');
      if (id === null) continue;
      const rawType = attributeValue(child, W_NS, 'multiLevelType') ?? 'hybridMultilevel';
      const levels: ListLevelDefinition[] = [];
      for (const lvl of childElements(child)) {
        if (!isParsedWordElement(lvl, 'lvl')) continue;
        const parsed = parseLevelElement(lvl);
        if (parsed !== null) levels.push(parsed);
      }
      levels.sort((left, right) => left.level - right.level);
      abstract.push({
        abstract_num_id: id,
        multi_level_type: MULTI_LEVEL_TYPES.has(rawType)
          ? (rawType as AbstractNumbering['multi_level_type'])
          : 'hybridMultilevel',
        levels,
      });
      continue;
    }
    if (child.localName === 'num') {
      const numId = attributeValue(child, W_NS, 'numId');
      if (numId === null) continue;
      const abstractId = valOf(findChild(child, W_NS, 'abstractNumId'), 'val');
      if (abstractId === null) continue;
      const overrides: NumberingInstance['overrides'][number][] = [];
      for (const override of childElements(child)) {
        if (!isParsedWordElement(override, 'lvlOverride')) continue;
        const ilvl = attributeValue(override, W_NS, 'ilvl');
        if (ilvl === null) continue;
        const level = Number.parseInt(ilvl, 10);
        if (!Number.isInteger(level)) continue;
        const startText = valOf(findChild(override, W_NS, 'startOverride'), 'val');
        const lvl = findChild(override, W_NS, 'lvl');
        overrides.push({
          level,
          start_override: startText === null ? null : Number.parseInt(startText, 10),
          level_definition: lvl === null ? null : parseLevelElement(lvl),
        });
      }
      instances.push({ num_id: numId, abstract_num_id: abstractId, overrides });
    }
  }

  return { abstract, instances };
}

/** 一个 `w:lvl` → 级别定义；`w:ilvl` 缺失或非整数时返回 `null`。 */
function parseLevelElement(element: ParsedXmlElement): ListLevelDefinition | null {
  const ilvl = attributeValue(element, W_NS, 'ilvl');
  if (ilvl === null) return null;
  const level = Number.parseInt(ilvl, 10);
  if (!Number.isInteger(level) || level < 0) return null;

  const rawFormat = valOf(findChild(element, W_NS, 'numFmt'), 'val') ?? 'decimal';
  const rawAlignment = valOf(findChild(element, W_NS, 'lvlJc'), 'val') ?? 'left';
  const startText = valOf(findChild(element, W_NS, 'start'), 'val');
  const restartText = valOf(findChild(element, W_NS, 'lvlRestart'), 'val');
  const pPr = findChild(element, W_NS, 'pPr');
  const ind = pPr === null ? null : findChild(pPr, W_NS, 'ind');
  const rPr = findChild(element, W_NS, 'rPr');
  const rFonts = rPr === null ? null : findChild(rPr, W_NS, 'rFonts');

  return {
    level,
    format: LEVEL_FORMATS.has(rawFormat) ? (rawFormat as ListLevelFormat) : 'decimal',
    text_template: valOf(findChild(element, W_NS, 'lvlText'), 'val') ?? '',
    start: startText === null ? 1 : (Number.parseInt(startText, 10) || 1),
    indent_left: indentAmountOf(ind, 'left', 'leftChars'),
    indent_hanging: indentAmountOf(ind, 'hanging', 'hangingChars'),
    style_ref: valOf(findChild(element, W_NS, 'pStyle'), 'val'),
    alignment: LEVEL_ALIGNMENTS.has(rawAlignment)
      ? (rawAlignment as ListLevelDefinition['alignment'])
      : 'left',
    bullet_font: rFonts === null ? null : attributeValue(rFonts, W_NS, 'ascii'),
    restart_after_level: restartText === null ? null : Number.parseInt(restartText, 10),
  };
}

/**
 * `w:ind` 的一个槽位 → `IndentAmount`。
 *
 * **字符优先**（`w:leftChars` 在时按字符读），否则按 `twips` 读——用 `twips` 而不是 pt
 * 是为了**无损**：`720 twips → 36 pt → 720 twips` 虽然也成立，但一旦遇到 0.5pt 的奇数
 * twips 就会出现浮点尾数。twips 是 OOXML 的原生单位，读写都在转换层（R127 允许）。
 */
function indentAmountOf(
  ind: ParsedXmlElement | null,
  lengthAttr: string,
  charsAttr: string,
): IndentAmount {
  if (ind !== null) {
    const chars = attributeValue(ind, W_NS, charsAttr);
    if (chars !== null && Number.isFinite(Number(chars))) {
      return { unit: 'chars', value: Number(chars) / 100 };
    }
    const twips = attributeValue(ind, W_NS, lengthAttr);
    if (twips !== null && Number.isFinite(Number(twips))) {
      return { unit: 'twips', value: Number(twips) };
    }
  }
  return { unit: 'twips', value: 0 };
}

/** 元素在**无命名空间**的 `w:*` 属性里取值（`attributeValue` 的 null 安全包装）。 */
function valOf(element: ParsedXmlElement | null, localName: string): string | null {
  return element === null ? null : attributeValue(element, W_NS, localName);
}

// ---------------------------------------------------------------------------
// 序列化
// ---------------------------------------------------------------------------

/**
 * 编号表 → `numbering.xml` 文本。
 *
 * @param originalBytes 原部件字节；`null` ⇒ 按模型新建一棵树（也就是**规范化指纹**）。
 */
export function numberingPartXml(table: NumberingTable, originalBytes: Uint8Array | null): string {
  const shape = toNumberingPartShape(table);
  const root =
    originalBytes === null
      ? el('w:numbering', [attr('xmlns:w', W_NS)], [
          ...shape.abstractNums.map((entry) => abstractElement(null, entry)),
          ...shape.nums.map((entry) => numElement(null, entry)),
        ])
      : mergeNumberingRoot(parseXmlBytes(originalBytes), table);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${serializeXmlNode(root)}`;
}

/** 编号表的规范化指纹（与写出器同源）。 */
export function numberingTableFingerprint(table: NumberingTable): string {
  return numberingPartXml(table, null);
}

/**
 * 模型与原字节是否等价（等价 ⇒ 写回原字节）。
 *
 * 与原字节**读不出来**时判"未改动"——理由与 `stylesPartUnchanged` 完全一致：
 * 宁可保原样，也不让"看不懂的既有字节"把整次导出变成失败（与 R151 同向的保守边界）。
 */
export function numberingPartUnchanged(table: NumberingTable, originalBytes: Uint8Array): boolean {
  let parsed: NumberingTable;
  try {
    parsed = parseNumberingPart(originalBytes);
  } catch {
    return true;
  }
  return numberingTableFingerprint(table) === numberingTableFingerprint(parsed);
}

/**
 * 原树 + 模型 → 新树。
 *
 * 既有 `w:abstractNum` / `w:num` **按原顺序、原 id** 逐条重建；模型没有的条目视为删除；
 * 新条目**追加**：新 `w:abstractNum` 插在第一个 `w:num` 之前（CT_Numbering 的 schema 顺序），
 * 新 `w:num` 追加在 `w:numIdMacAtCleanup` 之前（或末尾）。
 */
function mergeNumberingRoot(root: ParsedXmlElement, table: NumberingTable): XmlElement {
  const shape = toNumberingPartShape(table);
  const abstractById = new Map(shape.abstractNums.map((entry) => [entry.abstractNumId, entry]));
  const numById = new Map(shape.nums.map((entry) => [entry.numId, entry]));

  const emittedAbstract = new Set<string>();
  const emittedNum = new Set<string>();
  const children: XmlNode[] = [];

  for (const child of root.children) {
    if (child.kind !== 'element') {
      children.push(child.value);
      continue;
    }
    if (isParsedWordElement(child, 'abstractNum')) {
      const id = attributeValue(child, W_NS, 'abstractNumId');
      if (id === null) {
        children.push(convertParsedElement(child));
        continue;
      }
      const entry = abstractById.get(id);
      if (entry === undefined) continue;
      emittedAbstract.add(id);
      children.push(abstractElement(child, entry));
      continue;
    }
    if (isParsedWordElement(child, 'num')) {
      const id = attributeValue(child, W_NS, 'numId');
      if (id === null) {
        children.push(convertParsedElement(child));
        continue;
      }
      const entry = numById.get(id);
      if (entry === undefined) continue;
      emittedNum.add(id);
      children.push(numElement(child, entry));
      continue;
    }
    children.push(convertParsedElement(child));
  }

  const newAbstracts = shape.abstractNums
    .filter((entry) => !emittedAbstract.has(entry.abstractNumId))
    .map((entry) => abstractElement(null, entry));
  if (newAbstracts.length > 0) {
    const firstNum = children.findIndex((node) => isWordElement(node, 'num'));
    const cleanup = children.findIndex((node) => isWordElement(node, 'numIdMacAtCleanup'));
    const at = firstNum !== -1 ? firstNum : cleanup !== -1 ? cleanup : children.length;
    children.splice(at, 0, ...newAbstracts);
  }

  const newNums = shape.nums
    .filter((entry) => !emittedNum.has(entry.numId))
    .map((entry) => numElement(null, entry));
  if (newNums.length > 0) {
    const cleanup = children.findIndex((node) => isWordElement(node, 'numIdMacAtCleanup'));
    const at = cleanup === -1 ? children.length : cleanup;
    children.splice(at, 0, ...newNums);
  }

  return el(
    'w:numbering',
    root.attributes.map((attribute) => attr(attribute.name, attribute.value)),
    children,
  );
}

/** 一个 `w:abstractNum`：属性从原元素继承（`w:nsid` / `w:tmpl` / `w:styleLink` …），只覆盖 id 与类型。 */
function abstractElement(
  original: ParsedXmlElement | null,
  entry: NumberingAbstractPartShape,
): XmlElement {
  const inherited =
    original === null
      ? []
      : original.attributes
          .filter(
            (attribute) =>
              attribute.name !== 'w:abstractNumId' && attribute.name !== 'w:multiLevelType',
          )
          .map((attribute) => attr(attribute.name, attribute.value));
  const attributes = [
    attr('w:abstractNumId', entry.abstractNumId),
    attr('w:multiLevelType', entry.multiLevelType),
    ...inherited,
  ];

  const originals = new Map<number, ParsedXmlElement>();
  if (original !== null) {
    for (const child of childElements(original)) {
      if (!isParsedWordElement(child, 'lvl')) continue;
      const ilvl = attributeValue(child, W_NS, 'ilvl');
      if (ilvl === null) continue;
      originals.set(Number.parseInt(ilvl, 10), child);
    }
  }

  // `CT_AbstractNum` 的序列是 `nsid? / multiLevelType? / tmpl? / name? / styleLink? /
  // numStyleLink? / lvl*` —— **级别永远在最后**。原树里非 `w:lvl` 的子节点
  // （`w:nsid` / `w:tmpl` / `w:styleLink` …）全部**按原顺序保留**（R105）。
  const preserved: XmlNode[] = [];
  if (original !== null) {
    for (const child of original.children) {
      if (child.kind === 'element' && isParsedWordElement(child, 'lvl')) continue;
      preserved.push(child.kind === 'text' ? child.value : convertParsedElement(child));
    }
  }

  // 按 `w:ilvl` 升序写出（CT_AbstractNum 允许重复的 `w:lvl`，Word 期望升序）。
  const levels = [...entry.levels].sort((left, right) => left.ilvl - right.ilvl);
  const children = [
    ...preserved,
    ...levels.map((level) => levelElement(originals.get(level.ilvl) ?? null, level)),
  ];
  return el('w:abstractNum', attributes, children);
}

/** 一个 `w:num`：`w:numId` 覆盖，其余子节点（`w:lvlOverride`）按模型重建。 */
function numElement(
  original: ParsedXmlElement | null,
  entry: NumberingInstancePartShape,
): XmlElement {
  const inherited =
    original === null
      ? []
      : original.attributes
          .filter((attribute) => attribute.name !== 'w:numId')
          .map((attribute) => attr(attribute.name, attribute.value));
  const attributes = [attr('w:numId', entry.numId), ...inherited];

  const overrideOriginals = new Map<number, ParsedXmlElement>();
  if (original !== null) {
    for (const child of childElements(original)) {
      if (!isParsedWordElement(child, 'lvlOverride')) continue;
      const ilvl = attributeValue(child, W_NS, 'ilvl');
      if (ilvl === null) continue;
      overrideOriginals.set(Number.parseInt(ilvl, 10), child);
    }
  }

  const children: XmlNode[] = [el('w:abstractNumId', [attr('w:val', entry.abstractNumId)])];
  for (const override of entry.overrides) {
    children.push(overrideElement(overrideOriginals.get(override.ilvl) ?? null, override));
  }
  return el('w:num', attributes, children);
}

/** 一个 `w:lvlOverride`：`startOverride`（本地重编号）+ `lvl`（整级替换），二者都可缺。 */
function overrideElement(
  original: ParsedXmlElement | null,
  override: NumberingInstancePartShape['overrides'][number],
): XmlElement {
  const slots: ModeledSlot[] = [
    {
      name: 'startOverride',
      rank: OVERRIDE_CHILD_RANKS.startOverride as number,
      element:
        override.startOverride === null
          ? null
          : el('w:startOverride', [attr('w:val', String(override.startOverride))]),
    },
    {
      name: 'lvl',
      rank: OVERRIDE_CHILD_RANKS.lvl as number,
      element:
        override.levelDefinition === null ? null : levelElement(null, override.levelDefinition),
    },
  ];
  const children =
    original === null
      ? slots.flatMap((slot) => (slot.element === null ? [] : [slot.element]))
      : patchChildren(original, slots, rankOf(OVERRIDE_CHILD_RANKS));
  return el('w:lvlOverride', [attr('w:ilvl', String(override.ilvl))], children);
}

/**
 * 一个 `w:lvl`。
 *
 * 模型槽位（`w:start` / `w:numFmt` / `w:lvlRestart` / `w:pStyle` / `w:lvlText` / `w:lvlJc` /
 * `w:pPr` / `w:rPr`）按 `CT_Lvl` 的 schema 顺序写入；原元素里其余子节点
 * （`w:suff` / `w:isLgl` / `w:legacy` / `w:lvlPicBulletId` …）**原地保留**（R105）。
 */
function levelElement(
  original: ParsedXmlElement | null,
  level: NumberingLevelPartShape,
): XmlElement {
  const slots: ModeledSlot[] = [
    { name: 'start', rank: LEVEL_CHILD_RANKS.start as number, element: el('w:start', [attr('w:val', String(level.start))]) },
    { name: 'numFmt', rank: LEVEL_CHILD_RANKS.numFmt as number, element: el('w:numFmt', [attr('w:val', level.numFmt)]) },
    {
      name: 'lvlRestart',
      rank: LEVEL_CHILD_RANKS.lvlRestart as number,
      element:
        level.lvlRestart === null
          ? null
          : el('w:lvlRestart', [attr('w:val', String(level.lvlRestart))]),
    },
    {
      name: 'pStyle',
      rank: LEVEL_CHILD_RANKS.pStyle as number,
      element: level.pStyle === null ? null : el('w:pStyle', [attr('w:val', level.pStyle)]),
    },
    { name: 'lvlText', rank: LEVEL_CHILD_RANKS.lvlText as number, element: el('w:lvlText', [attr('w:val', level.lvlText)]) },
    { name: 'lvlJc', rank: LEVEL_CHILD_RANKS.lvlJc as number, element: el('w:lvlJc', [attr('w:val', level.lvlJc)]) },
    {
      name: 'pPr',
      rank: LEVEL_CHILD_RANKS.pPr as number,
      element: levelParagraphProperties(
        original === null ? null : findChild(original, W_NS, 'pPr'),
        level.indent_left,
        level.indent_hanging,
      ),
    },
    {
      name: 'rPr',
      rank: LEVEL_CHILD_RANKS.rPr as number,
      element: levelRunProperties(
        original === null ? null : findChild(original, W_NS, 'rPr'),
        level.rFonts,
      ),
    },
  ];

  const children =
    original === null
      ? slots.flatMap((slot) => (slot.element === null ? [] : [slot.element]))
      : patchChildren(original, slots, rankOf(LEVEL_CHILD_RANKS));

  return el('w:lvl', [attr('w:ilvl', String(level.ilvl))], children);
}

/** `w:lvl/w:pPr`：只表达缩进；原 `w:pPr` 里其余子节点保留。 */
function levelParagraphProperties(
  original: ParsedXmlElement | null,
  left: IndentAmount,
  hanging: IndentAmount,
): XmlElement | null {
  const attributes = [
    ...indentAttributes('left', left),
    ...indentAttributes('hanging', hanging),
  ];
  const ind = attributes.length === 0 ? null : el('w:ind', attributes);
  const slots: ModeledSlot[] = ind === null ? [] : [{ name: 'ind', rank: PARAGRAPH_IND_RANK, element: ind }];
  if (original === null) {
    return ind === null ? null : el('w:pPr', [], [ind]);
  }
  const children = patchChildren(original, slots, rankOf({ ind: PARAGRAPH_IND_RANK }));
  return children.length === 0 ? null : el('w:pPr', [], children);
}

/** `w:lvl/w:rPr`：只表达符号字体（`w:rFonts`）；原 `rPr` 的其余属性（如 `w:hint`）保留。 */
function levelRunProperties(original: ParsedXmlElement | null, fonts: FontSet | null): XmlElement | null {
  const originalFonts = original === null ? null : findChild(original, W_NS, 'rFonts');
  if (fonts === null) {
    // 模型没指定字体：原样保留（写一个空 `w:rPr` 等于把原文的字体信息删掉，R105）。
    return original === null ? null : convertParsedElement(original);
  }
  const inherited =
    originalFonts === null
      ? []
      : originalFonts.attributes
          .filter(
            (attribute) =>
              attribute.name !== 'w:ascii' &&
              attribute.name !== 'w:hAnsi' &&
              attribute.name !== 'w:eastAsia' &&
              attribute.name !== 'w:cs',
          )
          .map((attribute) => attr(attribute.name, attribute.value));
  const attributes = [
    ...fontAttributes(fonts),
    // 原 `w:rFonts` 上的其它属性（典型是 `w:hint="default"`）原样保留。
    ...inherited,
  ];
  const rFonts = el('w:rFonts', attributes);
  const slots: ModeledSlot[] = [{ name: 'rFonts', rank: 2, element: rFonts }];
  const children =
    original === null
      ? [rFonts]
      : patchChildren(original, slots, rankOf({ rFonts: 2 }));
  return el('w:rPr', [], children);
}

/** `FontSet` → `w:rFonts` 的属性（只写非 null 的槽位，顺序与 `serializeRunProperties` 一致）。 */
function fontAttributes(fonts: FontSet): ReturnType<typeof attr>[] {
  const entries: readonly (readonly [string, string | null])[] = [
    ['w:ascii', fonts.ascii],
    ['w:hAnsi', fonts.hAnsi],
    ['w:eastAsia', fonts.eastAsia],
    ['w:cs', fonts.cs],
  ];
  return entries
    .filter(([, value]) => value !== null)
    .map(([name, value]) => attr(name, value as string));
}

/**
 * 单个缩进槽位 → 属性。
 *
 * 走 `units` 的 `indentAmountToSlotAttributes`（**唯一**的缩进换算点，R128/R130）：
 * 字符值只进 `w:<slot>Chars`，长度值只进 `w:<slot>`，两条路不会互相串。
 */
function indentAttributes(slot: 'left' | 'hanging', amount: IndentAmount): ReturnType<typeof attr>[] {
  const { chars, length } = indentAmountToSlotAttributes(slot, amount);
  const out: ReturnType<typeof attr>[] = [];
  if (length !== null) out.push(attr(`w:${slot}`, String(length)));
  if (chars !== null) out.push(attr(`w:${slot}Chars`, String(chars)));
  return out;
}

/** 位次查询表 → `ChildRankLookup`。 */
function rankOf(table: Readonly<Record<string, number>>): ChildRankLookup {
  return (localName) => table[localName] ?? null;
}

/**
 * 编号表里一个定义都没有。
 *
 * 判据用于"包里没有 `numbering.xml` 时要不要凭空建一个"：空表不建——
 * 凭空多一个空部件既是无谓的改动，也会破坏"未改动即原字节"（R151）。
 */
export function isEmptyNumberingTable(table: NumberingTable): boolean {
  return table.abstract.length === 0 && table.instances.length === 0;
}

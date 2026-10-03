/**
 * `w:drawing` 片段的**构造与解析**（WF-065–070 的 XML 层）。
 *
 * ## 为什么这段 XML 由本包构造（以及它的边界）
 *
 * R107 要求"模型 ↔ OOXML 的转换集中在 docx 子模块，其他模块不得直接拼 XML 字符串"。
 * 但冻结模型里没有"图片节点"（见 `params.ts` 文件头），D02 也没有"造一段 `w:drawing`"的入口。
 * 本包的折中做法有三条硬约束：
 *
 * 1. **不手拼字符串**：一律用 `src/artifacts/ooxml/xml.ts` 的确定性写入器
 *    （`el` / `attr` / `serializeXmlNode`，与 D02 用的是同一套），因此属性顺序、转义、
 *    换行口径与全仓一致；
 * 2. **命名空间就地声明**：`wp:` / `a:` / `pic:` / `r:` 都声明在使用它们的元素上。
 *    这样即便 D02 把片段包在 `<root>` 里重新解析（丢掉主部件根上的声明），前缀依然有出处，
 *    片段也自洽可解析；
 * 3. **转换只此一处**：整个包里只有本文件产出/解析 `w:drawing`，接缝小到可以整体搬进
 *    `docx/**`（若协调者最终要求 R107 归并，搬这一个文件即可）。
 *
 * ## 解析失败要**保真**
 *
 * `parseDrawing()` 对"看着像 drawing 但不认识"的片段返回 `null`（图形种类 `unknown` 由
 * `describeGraphic()` 给出）；调用方据此**原样保留**（R105/R110：不得静默丢弃）。
 * 本包的任何操作都不改写不认识的片段。
 */

import {
  attr,
  el,
  serializeXmlNode,
  type XmlElement,
} from '../../../artifacts/ooxml/xml.js';
import {
  attributeValue,
  childElements,
  directText,
  parseXmlBytes,
  type ParsedXmlElement,
} from '../../docx/xml-parse.js';
import { utf8Bytes } from '../../../artifacts/ooxml/xml.js';
import {
  DEFAULT_ANCHOR,
  NO_CROP,
  cropFromOoxml,
  cropToOoxml,
  rotationFromOoxml,
  rotationToOoxml,
  type AltText,
  type AnchorSpec,
  type CropRect,
  type DrawingExtent,
  type DrawingParams,
  type WrapMode,
} from './params.js';

/** 本包用到的命名空间。 */
export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
} as const;

const T = (prefix: string, local: string): string => `${prefix}:${local}`;
const xmlns = (prefix: string, uri: string): ReturnType<typeof attr> => attr(`xmlns:${prefix}`, uri);

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

/** 一张图片的构造输入。 */
export interface PictureXmlInput {
  readonly relationship_id: string;
  readonly extent: DrawingExtent;
  readonly rotation_degrees: number;
  readonly crop: CropRect;
  readonly wrap: WrapMode;
  readonly anchor: AnchorSpec;
  readonly alt: AltText;
  /** `wp:docPr@id`（文档内必须唯一；由调用方按"已用最大 id + 1"给出）。 */
  readonly doc_pr_id: number;
  /** 原图文件名（写进 `pic:cNvPr@name`，仅供显示，不参与关系解析）。 */
  readonly file_name: string;
}

/** 环绕方式 → `wp` 的 wrap 元素（`null` = 浮动但不需要 wrap 元素以外的处理）。 */
function wrapElement(mode: WrapMode): XmlElement | null {
  switch (mode) {
    case 'inline':
      return null;
    case 'square':
      return el(T('wp', 'wrapSquare'), [attr('wrapText', 'bothSides')]);
    case 'topAndBottom':
      return el(T('wp', 'wrapTopAndBottom'));
    case 'inFront':
    case 'behind':
      return el(T('wp', 'wrapNone'));
    default: {
      const exhaustive: never = mode;
      throw new Error(`未知环绕方式：${String(exhaustive)}`);
    }
  }
}

function positionElement(kind: 'H' | 'V', from: string, offset: number): XmlElement {
  return el(T('wp', `position${kind}`), [attr('relativeFrom', from)], [
    // `wp:posOffset` 的值是**元素文本**（EMU 整数），不是属性。
    el(T('wp', 'posOffset'), [], [String(Math.round(offset))]),
  ]);
}

/** `a:graphic` 里承载图片的那棵子树。 */
function pictureGraphic(input: PictureXmlInput): XmlElement {
  return el(T('a', 'graphic'), [xmlns('a', NS.a), xmlns('pic', NS.pic), xmlns('r', NS.r)], [
    el(T('a', 'graphicData'), [attr('uri', NS.pic)], [
      el(T('pic', 'pic'), [], [
        el(T('pic', 'nvPicPr'), [], [
          el(T('pic', 'cNvPr'), [attr('id', '0'), attr('name', input.file_name)]),
          el(T('pic', 'cNvPicPr')),
        ]),
        el(T('pic', 'blipFill'), [], [
          // 关系引用就在这里：r:embed 必须指向 word/_rels/document.xml.rels 里真实存在的 rId。
          el(T('a', 'blip'), [attr(`r:embed`, input.relationship_id)]),
          el(T('a', 'srcRect'), [
            attr('l', String(cropToOoxml(input.crop.left))),
            attr('t', String(cropToOoxml(input.crop.top))),
            attr('r', String(cropToOoxml(input.crop.right))),
            attr('b', String(cropToOoxml(input.crop.bottom))),
          ]),
          el(T('a', 'stretch'), [], [el(T('a', 'fillRect'))]),
        ]),
        el(T('pic', 'spPr'), [], [
          el(T('a', 'xfrm'), [attr('rot', String(rotationToOoxml(input.rotation_degrees)))], [
            el(T('a', 'off'), [attr('x', '0'), attr('y', '0')]),
            el(T('a', 'ext'), [attr('cx', String(input.extent.cx)), attr('cy', String(input.extent.cy))]),
          ]),
          el(T('a', 'prstGeom'), [attr('prst', 'rect')], [el(T('a', 'avLst'))]),
        ]),
      ]),
    ]),
  ]);
}

function docPrElement(input: Pick<PictureXmlInput, 'alt' | 'doc_pr_id'>): XmlElement {
  return el(T('wp', 'docPr'), [
    attr('id', String(input.doc_pr_id)),
    attr('name', input.alt.name),
    ...(input.alt.title === null ? [] : [attr('title', input.alt.title)]),
    // 替代文字：空串也**写出来**（"显式为空"≠"没这个属性"，R118 的同一取向）。
    attr('descr', input.alt.description),
  ]);
}

/**
 * 造 `<w:drawing>` 元素。
 *
 * `wrap === 'inline'` ⇒ `wp:inline`（嵌入正文）；其余 ⇒ `wp:anchor`（浮动，带 wrap 元素与
 * 位置偏移，`behindDoc` 由 `inFront` / `behind` 决定）。
 */
export function drawingElement(input: PictureXmlInput): XmlElement {
  return containerElement(input, pictureGraphic(input));
}

/** 容器（`wp:inline` / `wp:anchor`）的公共构造：图片与形状只差 `a:graphic` 那棵子树。 */
function containerElement(
  input: Pick<PictureXmlInput, 'extent' | 'wrap' | 'anchor' | 'alt' | 'doc_pr_id'>,
  graphic: XmlElement,
): XmlElement {
  const extent = el(T('wp', 'extent'), [
    attr('cx', String(input.extent.cx)),
    attr('cy', String(input.extent.cy)),
  ]);
  const effect = el(T('wp', 'effectExtent'), [
    attr('l', '0'),
    attr('t', '0'),
    attr('r', '0'),
    attr('b', '0'),
  ]);
  const framePr = el(T('wp', 'cNvGraphicFramePr'), [], [
    el(T('a', 'graphicFrameLocks'), [xmlns('a', NS.a), attr('noChangeAspect', '1')]),
  ]);

  let container: XmlElement;
  if (input.wrap === 'inline') {
    container = el(
      T('wp', 'inline'),
      [xmlns('wp', NS.wp), attr('distT', '0'), attr('distB', '0'), attr('distL', '0'), attr('distR', '0')],
      [extent, effect, docPrElement(input), framePr, graphic],
    );
  } else {
    const wrap = wrapElement(input.wrap);
    container = el(
      T('wp', 'anchor'),
      [
        xmlns('wp', NS.wp),
        attr('distT', '0'),
        attr('distB', '0'),
        attr('distL', '114300'),
        attr('distR', '114300'),
        attr('simplePos', '0'),
        attr('relativeHeight', '251658240'),
        attr('behindDoc', input.wrap === 'behind' ? '1' : '0'),
        attr('locked', '0'),
        attr('layoutInCell', '1'),
        attr('allowOverlap', '1'),
      ],
      [
        el(T('wp', 'simplePos'), [attr('x', '0'), attr('y', '0')]),
        positionElement('H', input.anchor.horizontal_from, input.anchor.horizontal_offset),
        positionElement('V', input.anchor.vertical_from, input.anchor.vertical_offset),
        extent,
        effect,
        ...(wrap === null ? [] : [wrap]),
        docPrElement(input),
        framePr,
        graphic,
      ],
    );
  }
  return el(T('w', 'drawing'), [xmlns('w', NS.w)], [container]);
}

// ---------------------------------------------------------------------------
// 文本框与形状（WF-070）
// ---------------------------------------------------------------------------

/** 文本框 / 形状的构造输入。 */
export interface ShapeXmlInput {
  readonly preset: 'rect' | 'roundRect' | 'ellipse';
  readonly extent: DrawingExtent;
  readonly wrap: WrapMode;
  readonly anchor: AnchorSpec;
  readonly alt: AltText;
  readonly doc_pr_id: number;
  /** 形状里的文字（文本框的"内容"）。 */
  readonly text: string;
  /** 填充色（6 位十六进制，不带 `#`）；`null` = 不写填充。 */
  readonly fill_hex: string | null;
  /** 描边色；`null` = 不写描边。 */
  readonly outline_hex: string | null;
  /** 形状是否为文本框（`wps:cNvSpPr@txBox`）。 */
  readonly text_box: boolean;
}

function colorFill(tag: string, hex: string | null): XmlElement | null {
  if (hex === null) {
    return null;
  }
  return el(T('a', tag), [], [el(T('a', 'srgbClr'), [attr('val', hex)])]);
}

/** `wps:wsp` 子树（文本框 / 形状本体）。 */
function shapeGraphic(input: ShapeXmlInput): XmlElement {
  const fill = colorFill('solidFill', input.fill_hex);
  const outline = colorFill('solidFill', input.outline_hex);
  const spPrChildren: XmlElement[] = [
    el(T('a', 'xfrm'), [], [
      el(T('a', 'off'), [attr('x', '0'), attr('y', '0')]),
      el(T('a', 'ext'), [attr('cx', String(input.extent.cx)), attr('cy', String(input.extent.cy))]),
    ]),
    el(T('a', 'prstGeom'), [attr('prst', input.preset)], [el(T('a', 'avLst'))]),
    ...(fill === null ? [] : [fill]),
    ...(outline === null ? [] : [el(T('a', 'ln'), [xmlns('a', NS.a)], [outline])]),
  ];
  return el(
    T('a', 'graphic'),
    [xmlns('a', NS.a), xmlns('wps', NS.wps), xmlns('w', NS.w)],
    [
      el(T('a', 'graphicData'), [attr('uri', `${NS.wps}/wordprocessingShape`)], [
        el(T('wps', 'wsp'), [], [
          el(T('wps', 'cNvSpPr'), [attr('txBox', input.text_box ? '1' : '0')]),
          el(T('wps', 'spPr'), [], spPrChildren),
          // 文本框的文字就在 `w:txbxContent` 里——它是一段**真正的 WordprocessingML**。
          el(T('wps', 'txbx'), [], [
            el(T('w', 'txbxContent'), [], [
              el(T('w', 'p'), [], [
                el(T('w', 'r'), [], [el(T('w', 't'), [attr('xml:space', 'preserve')], [input.text])]),
              ]),
            ]),
          ]),
          el(T('wps', 'bodyPr'), [attr('anchor', 't'), attr('wrap', 'square')]),
        ]),
      ]),
    ],
  );
}

/** 造一个文本框 / 形状的 `<w:drawing>` 元素。 */
export function shapeElement(input: ShapeXmlInput): XmlElement {
  return containerElement(input, shapeGraphic(input));
}

/** 文本框 / 形状的 XML 文本。 */
export function shapeXml(input: ShapeXmlInput): string {
  return serializeXmlNode(shapeElement(input));
}

/** 解析出的形状参数。 */
export interface ShapeParams {
  readonly preset: string;
  readonly text: string;
  readonly fill_hex: string | null;
  readonly outline_hex: string | null;
  readonly extent: DrawingExtent;
  readonly wrap: WrapMode;
  readonly anchor: AnchorSpec | null;
  readonly alt: AltText;
}

/** 取某个元素下所有 `w:t` 的文本并串接（形状文字提取用）。 */
function collectText(element: ParsedXmlElement): string {
  const parts: string[] = [];
  const stack: ParsedXmlElement[] = [element];
  while (stack.length > 0) {
    const current = stack.shift() as ParsedXmlElement;
    if (current.localName === 't') {
      parts.push(directText(current));
      continue;
    }
    stack.push(...childElements(current));
  }
  return parts.join('');
}

/** 取第一个 `a:srgbClr@val`（形状填充/描边的颜色）。 */
function firstColor(element: ParsedXmlElement | null): string | null {
  if (element === null) {
    return null;
  }
  const srgb = firstByLocalName(element, 'srgbClr');
  return srgb === null ? null : strAttribute(srgb, 'val', '');
}

/**
 * 解析形状参数；**不认识的图形返回 `null`**（调用方据此原样保留，R105/R110）。
 */
export function parseShape(xml: string): ShapeParams | null {
  const fragment = parseFragment(xml);
  if (fragment === null || describeGraphic(fragment) !== 'shape') {
    return null;
  }
  const params = parseDrawing(xml);
  if (params === null) {
    return null;
  }
  const wsp = firstByLocalName(fragment, 'wsp');
  const spPr = wsp === null ? null : firstByLocalName(wsp, 'spPr');
  const prstGeom = spPr === null ? null : firstByLocalName(spPr, 'prstGeom');
  const txbx = wsp === null ? null : firstByLocalName(wsp, 'txbx');
  const ln = spPr === null ? null : firstByLocalName(spPr, 'ln');
  // 填充是 `spPr` 里**直接子级**的 solidFill（`ln` 里那个是描边，别混）。
  const fill =
    spPr === null
      ? null
      : childElements(spPr).find(
          (child) => child.localName === 'solidFill' && child.namespace === NS.a,
        ) ?? null;
  return {
    preset: strAttribute(prstGeom, 'prst', 'rect'),
    text: txbx === null ? '' : collectText(txbx),
    fill_hex: firstColor(fill),
    outline_hex: firstColor(ln),
    extent: params.extent,
    wrap: params.wrap,
    anchor: params.anchor,
    alt: params.alt,
  };
}

/** `<w:drawing>…</w:drawing>` 的 XML 文本（可写进 `RunNode.opaque` 的 `raw_at_char`）。 */
export function drawingXml(input: PictureXmlInput): string {
  return serializeXmlNode(drawingElement(input));
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/** 解析一段 XML 文本；失败返回 `null`（调用方据此"原样保留"，不丢弃）。 */
export function parseFragment(xml: string): ParsedXmlElement | null {
  try {
    return parseXmlBytes(utf8Bytes(xml));
  } catch {
    return null;
  }
}

function firstByLocalName(element: ParsedXmlElement, localName: string): ParsedXmlElement | null {
  const stack: ParsedXmlElement[] = [...childElements(element)];
  while (stack.length > 0) {
    const current = stack.shift() as ParsedXmlElement;
    if (current.localName === localName) {
      return current;
    }
    stack.push(...childElements(current));
  }
  return null;
}

function numAttribute(element: ParsedXmlElement | null, name: string, fallback: number): number {
  if (element === null) {
    return fallback;
  }
  const raw = element.attributes.find((attribute) => attribute.name === name)?.value;
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function strAttribute(element: ParsedXmlElement | null, name: string, fallback: string): string {
  if (element === null) {
    return fallback;
  }
  return element.attributes.find((attribute) => attribute.name === name)?.value ?? fallback;
}

/**
 * 图形种类判定。
 *
 * - `pic:pic` ⇒ `picture`（图片）；
 * - `wps:wsp` / `wps:txbx` / `v:shape` ⇒ `shape`（文本框 / 形状）；
 * - 其余 ⇒ `unknown`（**认不出就不动它**）。
 */
export function describeGraphic(fragment: ParsedXmlElement): DrawingParams['graphic_kind'] {
  if (firstByLocalName(fragment, 'pic') !== null && firstByLocalName(fragment, 'blip') !== null) {
    return 'picture';
  }
  for (const local of ['wsp', 'txbx', 'shape', 'rect', 'roundRect', 'ellipse']) {
    if (firstByLocalName(fragment, local) !== null) {
      return 'shape';
    }
  }
  return 'unknown';
}

/** 该片段是否是"像 drawing 的一段 XML"。 */
export function isDrawingFragment(fragment: ParsedXmlElement): boolean {
  return fragment.localName === 'drawing' || firstByLocalName(fragment, 'drawing') !== null;
}

/**
 * 从一段 `w:drawing` XML 里读出参数；读不出来（不认识的图形）返回 `null`。
 *
 * 读得出的字段都带**保守默认**：OOXML 里缺省即默认（例如 `rot` 缺省 0 度、
 * `srcRect` 缺省不裁），这与"没设过"的语义一致。
 */
export function parseDrawing(xml: string): DrawingParams | null {
  const fragment = parseFragment(xml);
  if (fragment === null || !isDrawingFragment(fragment)) {
    return null;
  }
  const inline = firstByLocalName(fragment, 'inline');
  const anchorElement = firstByLocalName(fragment, 'anchor');
  if (inline === null && anchorElement === null) {
    return null;
  }
  const container: DrawingParams['container'] = inline === null ? 'anchor' : 'inline';
  const host = (inline ?? anchorElement) as ParsedXmlElement;

  const extent = firstByLocalName(fragment, 'extent');
  const docPr = firstByLocalName(fragment, 'docPr');
  const blip = firstByLocalName(fragment, 'blip');
  const srcRect = firstByLocalName(fragment, 'srcRect');
  const xfrm = firstByLocalName(fragment, 'xfrm');

  const wrap: WrapMode =
    container === 'inline'
      ? 'inline'
      : firstByLocalName(fragment, 'wrapSquare') !== null
        ? 'square'
        : firstByLocalName(fragment, 'wrapTopAndBottom') !== null
          ? 'topAndBottom'
          : strAttribute(host, 'behindDoc', '0') === '1'
            ? 'behind'
            : 'inFront';

  const horizontal = firstByLocalName(fragment, 'positionH');
  const vertical = firstByLocalName(fragment, 'positionV');

  return {
    container,
    extent: {
      cx: numAttribute(extent, 'cx', 0),
      cy: numAttribute(extent, 'cy', 0),
    },
    rotation_degrees: rotationFromOoxml(numAttribute(xfrm, 'rot', 0)),
    crop: {
      left: cropFromOoxml(numAttribute(srcRect, 'l', 0)),
      top: cropFromOoxml(numAttribute(srcRect, 't', 0)),
      right: cropFromOoxml(numAttribute(srcRect, 'r', 0)),
      bottom: cropFromOoxml(numAttribute(srcRect, 'b', 0)),
    },
    wrap,
    anchor:
      container === 'inline'
        ? null
        : {
            horizontal_from: strAttribute(
              horizontal,
              'relativeFrom',
              DEFAULT_ANCHOR.horizontal_from,
            ) as AnchorSpec['horizontal_from'],
            horizontal_offset: offsetOf(horizontal),
            vertical_from: strAttribute(
              vertical,
              'relativeFrom',
              DEFAULT_ANCHOR.vertical_from,
            ) as AnchorSpec['vertical_from'],
            vertical_offset: offsetOf(vertical),
          },
    alt: {
      name: strAttribute(docPr, 'name', ''),
      description: strAttribute(docPr, 'descr', ''),
      title: docPr?.attributes.some((attribute) => attribute.name === 'title') === true
        ? strAttribute(docPr, 'title', '')
        : null,
    },
    relationship_id: blip === null ? null : attributeValue(blip, NS.r, 'embed'),
    graphic_kind: describeGraphic(fragment),
  };
}

/** 取 `wp:positionH/V` 里的 `wp:posOffset` 文本值（EMU）。 */
function offsetOf(position: ParsedXmlElement | null): number {
  if (position === null) {
    return 0;
  }
  const offset = firstByLocalName(position, 'posOffset');
  if (offset === null) {
    return 0;
  }
  const parsed = Number.parseFloat(directText(offset));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 从 XML 里取出 `wp:docPr@id`（分配新 id 时避免撞号）。 */
export function docPrIdOf(xml: string): number | null {
  const fragment = parseFragment(xml);
  if (fragment === null) {
    return null;
  }
  const docPr = firstByLocalName(fragment, 'docPr');
  if (docPr === null) {
    return null;
  }
  const raw = docPr.attributes.find((attribute) => attribute.name === 'id')?.value;
  if (raw === undefined) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 空裁剪的导出（测试与默认值用）。 */
export const EMPTY_CROP: CropRect = NO_CROP;


/**
 * 演示域**导入—编辑—写回**层（design-06 P9；PPT-01「导入 PPTX」/ PPT-03「保留」/
 * PPT-04「精确选区」/ PPT-14「导入既有文件后仍能改指定对象」；R249「既有文件的未知部件保留」）。
 *
 * ## 这一层解决什么
 *
 * FA-F 的 `import.ts` 给的是**部件级保留原语**：把每个部件原样记下来，保存时未列出的部件
 * 逐字节写回。那是 PPT-03 的**必要条件**，但只做到这一步时调用方还得自己拼 XML——
 * 「导入既有文件后仍能改指定对象」（PPT-14）并没有直接可用。
 *
 * 本模块把它补齐成一条可用的往返链：
 *
 * ```
 * 既有 PPTX 字节 ──importPresentation──▶ 对象模型（可编辑）+ 部件绑定（page ↔ part）
 *                                              │
 *                                       operations.*（改文本 / 精确选区）
 *                                              ▼
 *                    编辑后的对象模型 ──exportImportedPresentation──▶ 新 PPTX 字节
 * ```
 *
 * ## 为什么"只有被改的部件变"
 *
 * 导出时**逐页比对**：`renderSlidePartXml(原页) === renderSlidePartXml(改后页)` ⇒ 该页**没被动过**，
 * 于是**写回源字节**（不是写回我们渲染的字节）。因此：
 *
 * - 没动过的页、母版、版式、主题、媒体、`customXml/**`、厂商私有部件 —— 全部**逐字节保留**；
 * - 只有"确实变了的那一页"换新字节；
 * - 而"是否变了"是**渲染口径**上的比对（两侧都过同一个 `renderSlidePartXml`），
 *   因此不会因为"解析—重渲染有细微差异"而误判成改动 —— 保真度缺口**不会**变成多写部件。
 *
 * 反面（本项目要防的）：把整份文件从模型重新渲染一遍。那样母版/版式/自定义部件都会被重造，
 * 页数、母版就算没改也会换字节 —— `import.test.ts` 已用正反例把这条钉死。
 *
 * ## 显式具名错误（**不静默降级**）
 *
 * 解析层读不懂的东西一律报错，**绝不**当成空：
 * - 页上出现本域建模不了的对象（图表 / SmartArt / 内容部件…）⇒ `unsupported_slide_content`；
 * - 表格合并单元格（`gridSpan` / `rowSpan` / `hMerge` / `vMerge`）⇒ `unsupported_merge_span`
 *   （渲染层同样报此错，口径一致）；
 * - 多套母版 ⇒ `multi_master_unsupported`；
 * - 导出时页集合被改（增删页）⇒ `slide_set_changed`——**新增/删除页需要重建
 *   `presentation.xml` 与其 `_rels` 并登记新部件**，本增量未封装该流程，故明确拒绝而不是装作成功；
 * - 导出时切版式到包内不存在的版式 ⇒ `unknown_layout`；该页没有 slideLayout 关系可改 ⇒
 *   `layout_switch_unsupported`（不静默无效）。
 * - 导出时的备注**增 / 删 / 原地改**都已支持：增删交给 `annotations/note-parts.ts`（连 notesMaster
 *   登记一起），原地改仍走同一保留路径。
 *
 * ## 读回（导入侧补的三处）
 *
 * - **对象动画**：页里的 `p:timing` 经 P08 `parseTimingXml` 读回 `Slide.animations`（原先硬编码为空）；
 * - **连接符端点**：`p:cNvCxnSpPr` 下的 `a:stCxn` / `a:endCxn` `@id` 读回 `start_shape_id` / `end_shape_id`；
 * - **导出侧**：源页有 `p:timing` 时，被改页重渲染后按模型动画**重新注入**时序块，改文本不再丢动画。
 *
 * ## 已知边界（如实登记）
 *
 * - 解析按**限定名精确匹配**（`p:sp` / `a:t`）。前缀被改写过的部件会在语义层匹配不到目标元素，
 *   此时报错而不是返回空内容（见 `xml-parse.ts` 的边界说明）。
 * - 事实引用（`fact`）在渲染时已被求值成字面量，**导入回来就是字面量**——往返不保留"这是一条事实引用"。
 *   这是"产物是最终文本"的必然结果，不是缺陷；要保引用请在上层保留模型。
 * - 本模块只处理 **幻灯片部件与其备注部件**的原地编辑；文稿级属性（页尺寸、母版、主题、标题）的
 *   改动不在本进出口内（那要替换 `ppt/presentation.xml` / `docProps/core.xml`，属关系图重建场景）
 *   ——**明确拒绝**（`presentation_properties_change_unsupported`）而不是静默无效。
 *
 * ## 文件会话层（PPT-01 / PPT-03 / PPT-14 文件层）
 *
 * 本文件另有三个入口，把这套原语抬到"一份文件"的粒度：
 *
 * - **会话**：`createPresentationFile`（新建）/ `openPresentationFile`（导入）/ `savePresentationFile`
 *   （保存）/ `savePresentationFileAs`（另存）/ `renamePresentationFile`（重命名）/
 *   `closePresentationFile` + `reopenPresentationFile`（关闭重开编辑）。**全部纯函数**，
 *   因此"保存失败 ⇒ 旧字节仍在"是结构性的（PPT-14「失败保旧」）；
 *   重命名**不换字节、不推进版本号**，保存/另存才推进——两者可被区分。
 * - **结构读取**：`readPresentationStructure` 从**真实部件**读页尺寸比例、母版（含字节摘要）、
 *   版式清单、主题配色十二槽位与逐页背景（PPT-03）。读不出来报具名错误，不降级成默认值。
 * - **版本比较**：`comparePresentationFiles` 按部件字节给出新增/删除/变更清单（PPT-14）。
 *
 * **页数由任务决定**（PPT-01）：会话层没有任何页数常量，新建 = 0 页，页数随 `addSlide` /
 * `removeSlide` 增减，资源上限由调用方预算决定。
 */

import { digestBytes } from '../artifacts/digest.js';
import { readZip, utf8Bytes, type ReadZipEntry } from '../artifacts/ooxml/index.js';
import { ValidationError } from '../protocol/index.js';

import { normalizeOrder, renderSlideTimingXml, type AnimationSpec } from './animation.js';
import { setDeckNotesPart } from './annotations/note-parts.js';
import {
  openPresentation,
  savePresentation,
  type OpenedPresentation,
  type SavePresentationResult,
} from './import.js';
import { speakerNotesText } from './notes.js';
import {
  emptyPresentation,
  renderNotesPartXml,
  renderPresentation,
  renderSlidePartXml,
  type SlideRenderContext,
} from './render.js';
import { serializeEditableDeck, type EditableDeck } from './slide-ops.js';
import { findElementRange, injectTiming, parseTimingXml } from './timing-parts/index.js';
import {
  attributeOf,
  childElements,
  firstElement,
  parseXmlDocument,
  textContentOf,
  XmlParseError,
  type XmlElementNode,
} from './xml-parse.js';

import type {
  ColorScheme,
  Fill,
  FactSnapshot,
  LayoutRef,
  Outline,
  Paragraph,
  Presentation,
  RunStyle,
  Shape,
  ShapeAnimation,
  Slide,
  SlideBackground,
  SlideSize,
  SlideTransition,
  TableCell,
  TableRow,
  TextBody,
  TextRun,
  Transform,
} from './model.js';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 往返层错误原因（**具名**，供上层分类与用例断言）。 */
export type PresentationRoundTripErrorReason =
  | 'malformed_slide_xml'
  | 'malformed_presentation_xml'
  | 'unsupported_slide_content'
  | 'unsupported_merge_span'
  | 'multi_master_unsupported'
  | 'slide_set_changed'
  | 'notes_part_addition_unsupported'
  | 'notes_part_removal_unsupported'
  | 'unknown_layout'
  | 'layout_switch_unsupported'
  | 'presentation_properties_change_unsupported'
  | 'unsupported_background'
  | 'unsupported_color_scheme'
  | 'invalid_file_name';

/** 往返层错误：凡"读不懂 / 表达不了 / 需要重建关系图"的情况都经此报错，不静默降级。 */
export class PresentationRoundTripError extends ValidationError {
  readonly reason: PresentationRoundTripErrorReason;

  constructor(reason: PresentationRoundTripErrorReason, message: string) {
    super(message);
    this.name = 'PresentationRoundTripError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function fail(reason: PresentationRoundTripErrorReason, message: string): never {
  throw new PresentationRoundTripError(reason, message);
}

/** 取一个必须是整数的属性。缺属性、空串、非安全整数一律报错（**不当成 0**）。 */
function requiredInteger(node: XmlElementNode | undefined, attribute: string, context: string): number {
  const raw = attributeOf(node, attribute);
  if (raw === undefined) {
    return fail('malformed_slide_xml', `${context} 缺少整数属性 ${attribute}`);
  }
  if (!/^-?[0-9]+$/.test(raw)) {
    return fail('malformed_slide_xml', `${context} 的属性 ${attribute}="${raw}" 不是整数`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    return fail('malformed_slide_xml', `${context} 的属性 ${attribute}="${raw}" 不是安全整数`);
  }
  return value;
}

function optionalInteger(node: XmlElementNode | undefined, attribute: string, context: string): number | null {
  if (attributeOf(node, attribute) === undefined) {
    return null;
  }
  return requiredInteger(node, attribute, context);
}

/** 包内相对路径规范化（相对 `baseDir`）。 */
function resolvePartPath(baseDir: string, target: string): string {
  const combined = target.startsWith('/')
    ? target.replace(/^\/+/, '')
    : `${baseDir === '' ? '' : `${baseDir}/`}${target}`;
  const stack: string[] = [];
  for (const segment of combined.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join('/');
}

/** 部件路径 → 其关系部件路径（`ppt/slides/slide1.xml` → `ppt/slides/_rels/slide1.xml.rels`）。 */
function relationshipsPathOf(partPath: string): string {
  const cut = partPath.lastIndexOf('/');
  const dir = cut < 0 ? '' : partPath.slice(0, cut);
  const base = cut < 0 ? partPath : partPath.slice(cut + 1);
  return dir === '' ? `_rels/${base}.rels` : `${dir}/_rels/${base}.rels`;
}

/** 部件路径 → 其所在目录（用于把关系目标解析成包内路径）。 */
function directoryOf(partPath: string): string {
  const cut = partPath.lastIndexOf('/');
  return cut < 0 ? '' : partPath.slice(0, cut);
}

/** 一个部件的关系索引（双向）。 */
interface RelationshipIndex {
  /** 包内路径 → 关系 id。 */
  readonly idByPath: ReadonlyMap<string, string>;
  /** 关系 id → 包内路径。 */
  readonly pathById: ReadonlyMap<string, string>;
}

const EMPTY_RELATIONSHIPS: RelationshipIndex = Object.freeze({
  idByPath: new Map<string, string>(),
  pathById: new Map<string, string>(),
});

/**
 * 读某部件的关系。缺关系部件 ⇒ 返回空索引（合法：没有关系的部件就是没有 `_rels`）。
 * 有 `_rels` 但解不出目标 ⇒ **不报错**，只是不入索引：本模块只关心"能不能找到"，
 * 找不到时由调用方按具名错误处理。
 */
function readRelationshipIndex(
  entries: ReadonlyMap<string, ReadZipEntry>,
  partPath: string,
): RelationshipIndex {
  const relsEntry = entries.get(relationshipsPathOf(partPath));
  if (relsEntry === undefined) {
    return EMPTY_RELATIONSHIPS;
  }
  const relsXml = Buffer.from(relsEntry.data).toString('utf8');
  const baseDir = directoryOf(partPath);
  const idByPath = new Map<string, string>();
  const pathById = new Map<string, string>();
  for (const tag of relsXml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const text = tag[0];
    if (/TargetMode\s*=\s*"External"/.test(text)) continue;
    const id = /\bId\s*=\s*"([^"]+)"/.exec(text)?.[1];
    const target = /\bTarget\s*=\s*"([^"]+)"/.exec(text)?.[1];
    if (id === undefined || target === undefined) continue;
    const path = resolvePartPath(baseDir, target);
    pathById.set(id, path);
    if (!idByPath.has(path)) {
      idByPath.set(path, id);
    }
  }
  return { idByPath, pathById };
}

/** 在关系索引里按包内路径形态找一个目标（如"这一页引用的版式 / 备注部件"）。 */
function findRelationshipTarget(rels: RelationshipIndex, pattern: RegExp): string | undefined {
  for (const path of rels.pathById.values()) {
    if (pattern.test(path)) return path;
  }
  return undefined;
}

/** 部件路径 → 去扩展名的部件名（`ppt/slideLayouts/slideLayout1.xml` → `slideLayout1`）。 */
function partNameOf(partPath: string): string {
  return partPath.slice(partPath.lastIndexOf('/') + 1).replace(/\.xml$/, '');
}

// ---------------------------------------------------------------------------
// XML → 模型
// ---------------------------------------------------------------------------

/** 段落对齐：`a:pPr@algn` → 模型取值。未知取值按左对齐（渲染层本就不写未知取值）。 */
function alignmentOf(raw: string | undefined): Paragraph['alignment'] {
  switch (raw) {
    case 'ctr':
      return 'center';
    case 'r':
      return 'right';
    case 'just':
      return 'justify';
    default:
      return 'left';
  }
}

function parseRunStyle(rPr: XmlElementNode | undefined): RunStyle | undefined {
  if (rPr === undefined) return undefined;
  const style: { bold?: boolean; italic?: boolean; size_pt?: number; color?: string; font?: string } = {};

  const bold = attributeOf(rPr, 'b');
  if (bold !== undefined) style.bold = bold === '1' || bold === 'true';
  const italic = attributeOf(rPr, 'i');
  if (italic !== undefined) style.italic = italic === '1' || italic === 'true';

  const size = attributeOf(rPr, 'sz');
  if (size !== undefined) {
    if (!/^[0-9]+$/.test(size)) {
      fail('malformed_slide_xml', `a:rPr 的 sz="${size}" 不是整数`);
    }
    style.size_pt = Number(size) / 100;
  }

  const solidFill = firstElement(rPr, 'a:solidFill');
  const srgb = firstElement(solidFill, 'a:srgbClr');
  const color = attributeOf(srgb, 'val');
  if (color !== undefined) style.color = color;

  const latin = firstElement(rPr, 'a:latin');
  const font = attributeOf(latin, 'typeface');
  if (font !== undefined) style.font = font;

  return Object.keys(style).length === 0 ? undefined : style;
}

function parseRun(r: XmlElementNode): TextRun {
  const rPr = firstElement(r, 'a:rPr');
  const t = firstElement(r, 'a:t');
  const text = t === undefined ? '' : textContentOf(t);
  return { source: { kind: 'literal', text }, style: parseRunStyle(rPr) };
}

function parseParagraph(p: XmlElementNode, context: string): Paragraph {
  const pPr = firstElement(p, 'a:pPr');
  const levelRaw = attributeOf(pPr, 'lvl');
  const level = levelRaw === undefined ? 0 : requiredInteger(pPr, 'lvl', context);
  const alignment = alignmentOf(attributeOf(pPr, 'algn'));
  const bullet = pPr === undefined ? true : firstElement(pPr, 'a:buNone') === undefined;

  const runs: TextRun[] = [];
  for (const child of childElements(p)) {
    if (child.name === 'a:r') {
      runs.push(parseRun(child));
      continue;
    }
    if (child.name === 'a:br') {
      runs.push({ source: { kind: 'literal', text: '\n' } });
      continue;
    }
    if (child.name === 'a:pPr') continue;
    return fail(
      'unsupported_slide_content',
      `${context} 里有本域未建模的段落级元素 <${child.name}>（渲染层同样不支持，故不静默丢弃）`,
    );
  }
  return { runs, level, alignment, bullet };
}

function parseTextBody(txBody: XmlElementNode, context: string): TextBody {
  return { paragraphs: childElements(txBody, 'a:p').map((p) => parseParagraph(p, context)) };
}

/** 文本体是否"空"（无任何 run）——用于把"没有文本的自选图形"还原成 `null` 而不是空段落。 */
function isEmptyTextBody(body: TextBody): boolean {
  return body.paragraphs.every((paragraph) => paragraph.runs.length === 0);
}

function parseTransform(xfrm: XmlElementNode | undefined, context: string): Transform {
  const off = firstElement(xfrm, 'a:off');
  const ext = firstElement(xfrm, 'a:ext');
  const rotationRaw = attributeOf(xfrm, 'rot');
  let rotationDeg = 0;
  if (rotationRaw !== undefined) {
    if (!/^-?[0-9]+$/.test(rotationRaw)) {
      fail('malformed_slide_xml', `${context} 的 a:xfrm@rot="${rotationRaw}" 不是整数`);
    }
    rotationDeg = Number(rotationRaw) / 60000;
  }
  return {
    x_emu: requiredInteger(off, 'x', `${context} 的 a:off`),
    y_emu: requiredInteger(off, 'y', `${context} 的 a:off`),
    cx_emu: requiredInteger(ext, 'cx', `${context} 的 a:ext`),
    cy_emu: requiredInteger(ext, 'cy', `${context} 的 a:ext`),
    rotation_deg: rotationDeg,
    flip_h: attributeOf(xfrm, 'flipH') === '1',
    flip_v: attributeOf(xfrm, 'flipV') === '1',
  };
}

function parseFill(spPr: XmlElementNode | undefined): Fill {
  const solidFill = firstElement(spPr, 'a:solidFill');
  const srgb = firstElement(solidFill, 'a:srgbClr');
  const color = attributeOf(srgb, 'val');
  return color === undefined ? { kind: 'none' } : { kind: 'solid', color };
}

function parseOutline(spPr: XmlElementNode | undefined): Outline | null {
  const ln = firstElement(spPr, 'a:ln');
  if (ln === undefined) return null;
  const width = optionalInteger(ln, 'w', 'a:ln');
  const solidFill = firstElement(ln, 'a:solidFill');
  const srgb = firstElement(solidFill, 'a:srgbClr');
  const color = attributeOf(srgb, 'val');
  return { color: color ?? null, width_emu: width };
}

/**
 * 读连接符端点：`a:stCxn` / `a:endCxn` 的 `@id`（形状 id）。ECMA-376 的 `CT_Connection` 用 `@id`，
 * 但历史上也有写 `@spid` 的产物，故两者都认。属性不存在 ⇒ 端点未绑定（`null`，不猜）；
 * 属性存在但不是整数 ⇒ **具名报错**（读不懂不静默当空）。
 */
function connectorEndpointId(node: XmlElementNode | undefined, context: string): number | null {
  const raw = attributeOf(node, 'id') ?? attributeOf(node, 'spid');
  if (raw === undefined) return null;
  if (!/^-?[0-9]+$/.test(raw)) {
    return fail('malformed_slide_xml', `${context} 的连接点属性不是整数：${raw}`);
  }
  return Number(raw);
}

/** 形状公共部分：`p:cNvPr` 的 id/name。 */
function parseShapeIdentity(nonVisual: XmlElementNode | undefined, context: string): { shape_id: number; name: string } {
  const cNvPr = firstElement(nonVisual, 'p:cNvPr');
  return {
    shape_id: requiredInteger(cNvPr, 'id', `${context} 的 p:cNvPr`),
    name: attributeOf(cNvPr, 'name') ?? '',
  };
}

/** 解析一页的 `p:spTree` 子元素（跳过组前导）。未知元素种类 ⇒ 具名报错。 */
function parseShapeTree(
  spTree: XmlElementNode,
  mediaPathById: (relId: string) => string | undefined,
  context: string,
): readonly Shape[] {
  const shapes: Shape[] = [];
  for (const child of childElements(spTree)) {
    if (child.name === 'p:nvGrpSpPr' || child.name === 'p:grpSpPr') continue;
    shapes.push(parseShape(child, mediaPathById, context));
  }
  return shapes;
}

function parseShape(
  element: XmlElementNode,
  mediaPathById: (relId: string) => string | undefined,
  context: string,
): Shape {
  switch (element.name) {
    case 'p:sp': {
      const nvSpPr = firstElement(element, 'p:nvSpPr');
      const identity = parseShapeIdentity(nvSpPr, context);
      const spPr = firstElement(element, 'p:spPr');
      const transform = parseTransform(firstElement(spPr, 'a:xfrm'), `${context} 的 p:sp`);
      const txBody = firstElement(element, 'p:txBody');
      const isTextBox = attributeOf(firstElement(nvSpPr, 'p:cNvSpPr'), 'txBox') === '1';

      if (isTextBox) {
        if (txBody === undefined) {
          return fail('malformed_slide_xml', `${context} 的文本框 <p:sp id=${String(identity.shape_id)}> 没有 p:txBody`);
        }
        const text = parseTextBody(txBody, `${context} 的文本框 ${String(identity.shape_id)}`);
        return { kind: 'text_box', ...identity, transform, text };
      }

      const preset = attributeOf(firstElement(spPr, 'a:prstGeom'), 'prst');
      if (preset === undefined) {
        return fail('malformed_slide_xml', `${context} 的自选图形 <p:sp id=${String(identity.shape_id)}> 没有 a:prstGeom@prst`);
      }
      const body = txBody === undefined ? null : parseTextBody(txBody, `${context} 的自选图形 ${String(identity.shape_id)}`);
      return {
        kind: 'auto_shape',
        ...identity,
        transform,
        preset,
        text: body === null || isEmptyTextBody(body) ? null : body,
        fill: parseFill(spPr),
        outline: parseOutline(spPr),
      };
    }

    case 'p:cxnSp': {
      const nvCxnSpPr = firstElement(element, 'p:nvCxnSpPr');
      const identity = parseShapeIdentity(nvCxnSpPr, context);
      const spPr = firstElement(element, 'p:spPr');
      const preset = attributeOf(firstElement(spPr, 'a:prstGeom'), 'prst');
      if (preset === undefined) {
        return fail('malformed_slide_xml', `${context} 的连接符 <p:cxnSp id=${String(identity.shape_id)}> 没有 a:prstGeom@prst`);
      }
      const cNvCxnSpPr = firstElement(nvCxnSpPr, 'p:cNvCxnSpPr');
      return {
        kind: 'connector',
        ...identity,
        transform: parseTransform(firstElement(spPr, 'a:xfrm'), `${context} 的连接符`),
        preset,
        outline: parseOutline(spPr),
        start_shape_id: connectorEndpointId(firstElement(cNvCxnSpPr, 'a:stCxn'), `${context} 的连接符起点`),
        end_shape_id: connectorEndpointId(firstElement(cNvCxnSpPr, 'a:endCxn'), `${context} 的连接符终点`),
      };
    }

    case 'p:pic': {
      const nvPicPr = firstElement(element, 'p:nvPicPr');
      const cNvPr = firstElement(nvPicPr, 'p:cNvPr');
      const embed = attributeOf(firstElement(firstElement(element, 'p:blipFill'), 'a:blip'), 'r:embed');
      if (embed === undefined) {
        return fail('malformed_slide_xml', `${context} 的图片没有 a:blip@r:embed`);
      }
      const mediaPath = mediaPathById(embed);
      if (mediaPath === undefined) {
        return fail(
          'malformed_slide_xml',
          `${context} 的图片引用了关系 ${embed}，但该页的 _rels 里没有它指向的包内部件`,
        );
      }
      const srcRect = firstElement(firstElement(element, 'p:blipFill'), 'a:srcRect');
      return {
        kind: 'picture',
        shape_id: requiredInteger(cNvPr, 'id', `${context} 的 p:cNvPr`),
        name: attributeOf(cNvPr, 'name') ?? '',
        transform: parseTransform(firstElement(firstElement(element, 'p:spPr'), 'a:xfrm'), `${context} 的图片`),
        media_path: mediaPath,
        alt_text: attributeOf(cNvPr, 'descr') ?? '',
        crop:
          srcRect === undefined
            ? null
            : {
                l: requiredInteger(srcRect, 'l', 'a:srcRect'),
                t: requiredInteger(srcRect, 't', 'a:srcRect'),
                r: requiredInteger(srcRect, 'r', 'a:srcRect'),
                b: requiredInteger(srcRect, 'b', 'a:srcRect'),
              },
      };
    }

    case 'p:graphicFrame': {
      const identity = parseShapeIdentity(firstElement(element, 'p:nvGraphicFramePr'), context);
      const table = firstElement(firstElement(firstElement(element, 'a:graphic'), 'a:graphicData'), 'a:tbl');
      if (table === undefined) {
        return fail(
          'unsupported_slide_content',
          `${context} 的 p:graphicFrame（id=${String(identity.shape_id)}）不是表格——图表 / SmartArt / 内容部件本域未建模，不静默丢弃`,
        );
      }
      return { kind: 'table', ...identity, transform: parseTransform(firstElement(element, 'p:xfrm'), `${context} 的表格`), ...parseTable(table) };
    }

    case 'p:grpSp': {
      const nvGrpSpPr = firstElement(element, 'p:nvGrpSpPr');
      const identity = parseShapeIdentity(nvGrpSpPr, context);
      const grpSpPr = firstElement(element, 'p:grpSpPr');
      return {
        kind: 'group',
        ...identity,
        transform: parseTransform(firstElement(grpSpPr, 'a:xfrm'), `${context} 的组合`),
        children: parseShapeTree(element, mediaPathById, context),
      };
    }

    default:
      return fail(
        'unsupported_slide_content',
        `${context} 里有本域未建模的形状元素 <${element.name}>（不静默丢弃）`,
      );
  }
}

function parseTable(table: XmlElementNode): { rows: readonly TableRow[]; column_widths_emu: readonly number[] } {
  const columns = childElements(firstElement(table, 'a:tblGrid'), 'a:gridCol').map((col) =>
    requiredInteger(col, 'w', 'a:gridCol'),
  );
  const rows = childElements(table, 'a:tr').map((tr) => ({
    cells: childElements(tr, 'a:tc').map((tc) => parseTableCell(tc)),
  }));
  return { rows, column_widths_emu: columns };
}

function parseTableCell(tc: XmlElementNode): TableCell {
  for (const attribute of ['gridSpan', 'rowSpan', 'hMerge', 'vMerge']) {
    if (attributeOf(tc, attribute) !== undefined) {
      return fail(
        'unsupported_merge_span',
        `表格单元格带 ${attribute}（合并单元格）：渲染层与本层均未实现，不静默降级成普通单元格`,
      );
    }
  }
  const txBody = firstElement(tc, 'a:txBody');
  return {
    text: txBody === undefined ? null : parseTextBody(txBody, '表格单元格'),
    col_span: 1,
    row_span: 1,
  };
}

function parseTransition(sld: XmlElementNode): SlideTransition | null {
  const transition = firstElement(sld, 'p:transition');
  if (transition === undefined) return null;
  const kindElement = childElements(transition)[0];
  if (kindElement === undefined) {
    return fail('malformed_slide_xml', 'p:transition 里没有切换类型元素');
  }
  const colon = kindElement.name.indexOf(':');
  const kind = colon < 0 ? kindElement.name : kindElement.name.slice(colon + 1);
  const duration = optionalInteger(transition, 'dur', 'p:transition');
  return { kind, duration_ms: duration ?? 0 };
}

/**
 * 从幻灯片 XML 里取 `p:timing` 块的**原文**（无则 `null`）；交给 P08 的 `parseTimingXml` 读回。
 * 用 `timing-parts` 的 `findElementRange`（同一套括号配对扫描），不自己正则切。
 */
function extractTimingXml(slideXml: string): string | null {
  const range = findElementRange(slideXml, 'p:timing');
  return range === null ? null : slideXml.slice(range.start, range.end);
}

/**
 * `p:timing` 块 → 模型动画（`AnimationSpec` → `ShapeAnimation`）。
 *
 * 读回顺序即文档顺序；同触发组内的 `order` 用 `animation.normalizeOrder` **重算**（与写侧同一套
 * 分组口径），因此"导入后可见动画"与"再次导出"闭合。类别 / 延迟 / 方向是 `AnimationSpec` 多出的
 * 字段，模型 `ShapeAnimation` 不存——导出时由 `animation.ts` 按同一规则补默认（见其 `animationSpecFromModel`）。
 */
function animationsFromTiming(timingXml: string, context: string): readonly ShapeAnimation[] {
  let specs: readonly AnimationSpec[];
  try {
    specs = parseTimingXml(timingXml);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail('malformed_slide_xml', `${context} 的 p:timing 读不回来：${detail}`);
  }
  return Object.freeze(
    normalizeOrder(specs).map((spec) =>
      Object.freeze({
        shape_id: spec.shape_id,
        effect: spec.effect,
        trigger: spec.trigger,
        duration_ms: spec.duration_ms,
        order: spec.order,
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

/** 一页与它在包里的部件的绑定。 */
export interface ImportedSlideBinding {
  readonly slide_id: number;
  /** 该页的部件路径（如 `ppt/slides/slide1.xml`）。 */
  readonly part_path: string;
  /** 该页的备注部件路径；没有备注部件则为 `null`。 */
  readonly notes_part_path: string | null;
  /**
   * 该页源 `p:timing` 块的**原文**；没有则为 `null`。
   *
   * 导出时"被改页"由 `renderSlidePartXml` 重渲染——而渲染层**不写** `p:timing`，若不管，
   * 改一处文本就会静默丢掉整块动画（P-R01 section D 已确认）。故记下源块，重渲染后按模型
   * 动画重新注入（见 `renderSlideWithTiming`），使"改文本不丢动画"成立。
   */
  readonly timing_xml: string | null;
  /** 导入时刻的该页模型（导出时用来判断"改没改"）。 */
  readonly slide: Slide;
  /** 该页原有的「媒体部件路径 → 关系 id」映射（改过的页要用同一批 id 重新渲染）。 */
  readonly media_rel_id_by_path: ReadonlyMap<string, string>;
}

/** 导入结果：可编辑模型 + 部件绑定 + 打开层对象（导出时原样交回）。 */
export interface ImportedPresentation {
  readonly opened: OpenedPresentation;
  readonly presentation: Presentation;
  readonly bindings: readonly ImportedSlideBinding[];
}

function readCoreTitle(entries: ReadonlyMap<string, ReadZipEntry>): string {
  const core = entries.get('docProps/core.xml');
  if (core === undefined) return '';
  const parsed = parseXmlDocument(Buffer.from(core.data).toString('utf8'));
  let title = '';
  const visit = (node: XmlElementNode): void => {
    for (const child of childElements(node)) {
      if (child.name === 'dc:title' && title === '') {
        title = textContentOf(child);
      }
      visit(child);
    }
  };
  visit(parsed);
  return title;
}

/**
 * 读回一份既有 PPTX：把每一页的部件解析成对象模型，并记下"页 ↔ 部件"的绑定。
 *
 * @throws {PresentationRoundTripError} 结构/内容超出本域建模范围时（见文件头部的具名错误清单）。
 */
export function importPresentation(bytes: Uint8Array): ImportedPresentation {
  const opened = openPresentation(bytes);
  const entries = opened.by_path;

  const presentationEntry = entries.get('ppt/presentation.xml');
  if (presentationEntry === undefined) {
    return fail('malformed_presentation_xml', '包内没有 ppt/presentation.xml');
  }
  let presentationRoot: XmlElementNode;
  try {
    presentationRoot = parseXmlDocument(Buffer.from(presentationEntry.data).toString('utf8'));
  } catch (error) {
    if (error instanceof XmlParseError) {
      return fail('malformed_presentation_xml', `ppt/presentation.xml 解析失败：${error.message}`);
    }
    throw error;
  }

  const masterIds = childElements(firstElement(presentationRoot, 'p:sldMasterIdLst'), 'p:sldMasterId');
  if (masterIds.length === 0) {
    return fail('malformed_presentation_xml', 'ppt/presentation.xml 里没有 p:sldMasterIdLst/p:sldMasterId');
  }
  if (masterIds.length > 1) {
    return fail(
      'multi_master_unsupported',
      `本增量只处理单套母版；该文稿有 ${String(masterIds.length)} 套母版`,
    );
  }
  const masterId = String(requiredInteger(masterIds[0], 'id', 'p:sldMasterId'));
  const master = masterId;

  const slideSize = firstElement(presentationRoot, 'p:sldSz');
  const size = {
    cx_emu: requiredInteger(slideSize, 'cx', 'p:sldSz'),
    cy_emu: requiredInteger(slideSize, 'cy', 'p:sldSz'),
  };

  const slideIdElements = childElements(firstElement(presentationRoot, 'p:sldIdLst'), 'p:sldId');
  if (slideIdElements.length !== opened.slide_part_paths.length) {
    return fail(
      'malformed_presentation_xml',
      `p:sldIdLst 有 ${String(slideIdElements.length)} 项，但包内定位到 ${String(opened.slide_part_paths.length)} 个幻灯片部件`,
    );
  }

  const themePath = entries.has('ppt/theme/theme1.xml') ? 'ppt/theme/theme1.xml' : null;
  const themeId =
    themePath === null ? 'theme1' : themePath.slice(themePath.lastIndexOf('/') + 1).replace(/\.xml$/, '');

  const bindings: ImportedSlideBinding[] = [];
  const slides: Slide[] = [];

  opened.slide_part_paths.forEach((partPath, index) => {
    const entry = entries.get(partPath);
    if (entry === undefined) {
      return fail('malformed_slide_xml', `包内没有幻灯片部件 ${partPath}`);
    }
    const rels = readRelationshipIndex(entries, partPath);

    const slideXml = Buffer.from(entry.data).toString('utf8');
    let slideRoot: XmlElementNode;
    try {
      slideRoot = parseXmlDocument(slideXml);
    } catch (error) {
      if (error instanceof XmlParseError) {
        return fail('malformed_slide_xml', `${partPath} 解析失败：${error.message}`);
      }
      throw error;
    }

    const spTree = firstElement(firstElement(slideRoot, 'p:cSld'), 'p:spTree');
    if (spTree === undefined) {
      return fail('malformed_slide_xml', `${partPath} 里找不到 p:cSld/p:spTree`);
    }

    const context = `${partPath}`;
    const shapes = parseShapeTree(spTree, (relId) => rels.pathById.get(relId), context);

    const layout = findRelationshipTarget(rels, /(^|\/)slideLayouts\/slideLayout[^/]*\.xml$/);
    const layoutId = layout === undefined ? 'blank' : partNameOf(layout);

    const slideId = requiredInteger(slideIdElements[index], 'id', 'p:sldId');
    const notesPath = findRelationshipTarget(rels, /(^|\/)notesSlides\/notesSlide[^/]*\.xml$/);
    const notesEntry = notesPath === undefined ? undefined : entries.get(notesPath);
    let notes: TextBody | null = null;
    if (notesEntry !== undefined) {
      let notesRoot: XmlElementNode;
      try {
        notesRoot = parseXmlDocument(Buffer.from(notesEntry.data).toString('utf8'));
      } catch (error) {
        if (error instanceof XmlParseError) {
          return fail('malformed_slide_xml', `${notesPath} 解析失败：${error.message}`);
        }
        throw error;
      }
      const notesSpTree = firstElement(firstElement(notesRoot, 'p:cSld'), 'p:spTree');
      const notesTextBoxes = childElements(notesSpTree).filter((child) => child.name === 'p:sp');
      const firstTextBox = notesTextBoxes[0];
      const txBody = firstElement(firstTextBox, 'p:txBody');
      notes = txBody === undefined ? null : parseTextBody(txBody, `${notesPath} 的备注文本框`);
    }

    const timingXml = extractTimingXml(slideXml);
    const slide: Slide = {
      slide_id: slideId,
      layout: { master_id: master, layout_id: layoutId },
      hidden: attributeOf(slideRoot, 'show') === '0',
      shapes,
      transition: parseTransition(slideRoot),
      animations: timingXml === null ? Object.freeze([]) : animationsFromTiming(timingXml, context),
      notes,
    };
    slides.push(slide);
    bindings.push({
      slide_id: slideId,
      part_path: partPath,
      notes_part_path: notesPath ?? null,
      timing_xml: timingXml,
      slide,
      media_rel_id_by_path: rels.idByPath,
    });
  });

  const presentation: Presentation = {
    presentation_id: digestBytes(bytes),
    title: readCoreTitle(entries),
    format: 'pptx',
    size,
    master: { master_id: master },
    theme: { theme_id: themeId },
    slides,
    sections: [],
  };

  return Object.freeze({
    opened,
    presentation: Object.freeze(presentation),
    bindings: Object.freeze(bindings),
  });
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/** 导出选项。 */
export interface ExportImportedOptions {
  /** 事实快照（供被改页刷新 `fact` 引用；缺省 = 空快照，与 `importPresentation` 的字面量一致）。 */
  readonly fact_snapshot?: FactSnapshot;
}

/** 导出结果：在 `savePresentation` 的结果上，附「实际换了字节的部件路径」。 */
export interface ExportImportedResult extends SavePresentationResult {
  readonly changed_part_paths: readonly string[];
}

/** 一处"备注部件增 / 删"的动作（交给 `annotations/note-parts.ts` 执行）。 */
interface DeckNotesOp {
  readonly page_number: number;
  readonly text: string | null;
}

/**
 * 重渲染一页并按需把 `p:timing` 重新注入。
 *
 * `render.ts` 的 `renderSlidePartXml` **不写** `p:timing`（时序块由 P08 的 `timing-parts` 内联注入）。
 * 若重渲染后不管动画，改一处文本就会静默丢掉整块动画（P-R01 section D 实测确认）。故：
 * 源页有 `p:timing` 或模型任一状态带动画时，注入由 `animation.renderSlideTimingXml` 生成的时序块。
 */
function renderSlideWithTiming(slide: Slide, context: SlideRenderContext, wantsTiming: boolean): string {
  const body = renderSlidePartXml(slide, context);
  if (!wantsTiming) return body;
  return injectTiming(body, renderSlideTimingXml(slide));
}

/** 求 `fromPartPath` 到 `toPartPath` 的相对 `Target`（供改写关系用）。 */
function relativeTargetFrom(fromPartPath: string, toPartPath: string): string {
  const cut = fromPartPath.lastIndexOf('/');
  const fromDir = cut < 0 ? '' : fromPartPath.slice(0, cut);
  const fromParts = fromDir.split('/').filter((segment) => segment !== '');
  const toParts = toPartPath.split('/');
  let common = 0;
  while (common < fromParts.length && common < toParts.length - 1 && fromParts[common] === toParts[common]) {
    common += 1;
  }
  return `${'../'.repeat(fromParts.length - common)}${toParts.slice(common).join('/')}`;
}

/**
 * 把某页 `_rels` 里 `…/slideLayout` 关系的 Target 改到新版式（P02「导入文稿同样适用」在往返层的落点）。
 *
 * 版式引用住在幻灯片的 `_rels`（幻灯片部件正文并不点名版式），因此"切版式"= 改写那一条关系的 Target。
 * 找不到 slideLayout 关系（例如该页用 blank 版式、没有 _rels）⇒ **具名报错**，不静默无效——
 * 这正是把"看着改了、其实没动"的失败模式挡在外面。
 */
function switchSlideLayoutInRels(
  entries: ReadonlyMap<string, ReadZipEntry>,
  slidePartPath: string,
  layoutId: string,
  context: string,
): { readonly rels_path: string; readonly xml: string } {
  const layoutPartPath = `ppt/slideLayouts/${layoutId}.xml`;
  if (!entries.has(layoutPartPath)) {
    return fail('unknown_layout', `${context} 要切到的版式 ${layoutId} 不在包内（${layoutPartPath}）`);
  }
  const relsPath = relationshipsPathOf(slidePartPath);
  const relsEntry = entries.get(relsPath);
  if (relsEntry === undefined) {
    return fail('layout_switch_unsupported', `${slidePartPath} 没有 _rels，无法改写 slideLayout 关系`);
  }
  const relsXml = Buffer.from(relsEntry.data).toString('utf8');
  const target = relativeTargetFrom(slidePartPath, layoutPartPath);
  let found = false;
  const next = relsXml.replace(/<Relationship\b[^>]*\/?>/g, (tag) => {
    if (!/\/relationships\/slideLayout"/.test(tag)) return tag;
    found = true;
    return tag.replace(/\bTarget\s*=\s*"[^"]*"/, () => `Target="${target}"`);
  });
  if (!found) {
    return fail(
      'layout_switch_unsupported',
      `${slidePartPath} 的 _rels 里没有指向 slideLayout 的关系（该页用 blank 版式），新增关系本增量未封装`,
    );
  }
  return { rels_path: relsPath, xml: next };
}

/** 把源部件（套上替换）装成 `EditableDeck`，再让 `annotations/note-parts.ts` 增 / 删备注部件。 */
function buildDeckWithNotes(
  opened: OpenedPresentation,
  replacements: ReadonlyMap<string, Uint8Array>,
  notesOps: readonly DeckNotesOp[],
): EditableDeck {
  let deck: EditableDeck = Object.freeze({
    parts: Object.freeze(
      opened.entries.map((entry) =>
        Object.freeze({ path: entry.path, data: replacements.get(entry.path) ?? entry.data }),
      ),
    ),
  });
  for (const op of notesOps) {
    deck = setDeckNotesPart(deck, op.page_number, op.text).deck;
  }
  return deck;
}

/** 由**真实产物字节**重算 `SavePresentationResult` 与"实际换了字节 / 新增"的部件路径。 */
function resultFromBytes(opened: OpenedPresentation, bytes: Uint8Array): ExportImportedResult {
  const after = readZip(bytes);
  let preserved = 0;
  let replaced = 0;
  const changed: string[] = [];
  for (const entry of opened.entries) {
    const other = after.by_path.get(entry.path);
    if (other === undefined) {
      changed.push(entry.path);
      continue;
    }
    if (Buffer.compare(Buffer.from(other.data), Buffer.from(entry.data)) === 0) {
      preserved += 1;
    } else {
      replaced += 1;
      changed.push(entry.path);
    }
  }
  for (const entry of after.entries) {
    if (!opened.by_path.has(entry.path)) changed.push(entry.path);
  }
  return Object.freeze({
    bytes: Buffer.from(bytes),
    entry_count: after.entries.length,
    preserved_part_count: preserved,
    replaced_part_count: replaced,
    content_digest: digestBytes(bytes),
    changed_part_paths: Object.freeze(changed),
  });
}

/**
 * 把编辑过的模型写回成 PPTX：**只有确实变了的那几页（与其备注 / `_rels`）换字节**，其余逐字节保留。
 *
 * 判定"变了"用的是**渲染口径的逐页比对**：原页与改后页都过同一个 `renderSlidePartXml`（必要时按
 * 模型动画重新注入 `p:timing`），两侧文本相等 ⇒ 这一页没被动过 ⇒ **写回源字节**（连"源字节长什么样"
 * 都不必知道）。
 *
 * 支持的三类结构改动：
 * - **切版式**（P02）：改写该页 `_rels` 的 slideLayout Target；
 * - **备注部件增 / 删**：交给 `annotations/note-parts.ts`（连 notesMaster 登记一起）而非本层重写关系图；
 * - **动画**：源页有 `p:timing` 时，重渲染后按模型动画重新注入，改文本不再丢动画（P-R01 section D）。
 *
 * @throws {PresentationRoundTripError} 页集合被改 / 版式不存在 / 无 slideLayout 关系可改 / 剩余未建模内容。
 */
export function exportImportedPresentation(
  imported: ImportedPresentation,
  edited: Presentation,
  options?: ExportImportedOptions,
): ExportImportedResult {
  if (edited.slides.length !== imported.bindings.length) {
    return fail(
      'slide_set_changed',
      `导入时有 ${String(imported.bindings.length)} 页，导出时是 ${String(edited.slides.length)} 页：` +
        '增删页需要重建 ppt/presentation.xml 与其 _rels 并登记新部件，本增量未封装该流程',
    );
  }

  assertPresentationPropertiesUnchanged(imported, edited);

  const snapshot: FactSnapshot = options?.fact_snapshot ?? [];
  const replacements = new Map<string, Uint8Array>();
  const changed: string[] = [];
  const notesOps: DeckNotesOp[] = [];
  const entries = imported.opened.by_path;

  imported.bindings.forEach((binding, index) => {
    const editedSlide = edited.slides[index];
    if (editedSlide === undefined || editedSlide.slide_id !== binding.slide_id) {
      return fail(
        'slide_set_changed',
        `第 ${String(index + 1)} 页的 slide_id 与导入时不一致：` +
          `导入 ${String(binding.slide_id)}，导出 ${String(editedSlide?.slide_id)}`,
      );
    }

    const context: SlideRenderContext = {
      snapshot,
      media_rel: (path: string) => {
        const relId = binding.media_rel_id_by_path.get(path);
        if (relId === undefined) {
          return fail(
            'unsupported_slide_content',
            `${binding.part_path} 里没有指向媒体 ${path} 的关系——新增媒体需要登记部件与关系，本增量未封装该流程`,
          );
        }
        return relId;
      },
    };

    const wantsTiming =
      binding.timing_xml !== null || binding.slide.animations.length > 0 || editedSlide.animations.length > 0;
    const before = renderSlideWithTiming(binding.slide, context, wantsTiming);
    const after = renderSlideWithTiming(editedSlide, context, wantsTiming);
    if (after !== before) {
      replacements.set(binding.part_path, utf8Bytes(after));
      changed.push(binding.part_path);
    }

    if (editedSlide.layout.layout_id !== binding.slide.layout.layout_id) {
      const switched = switchSlideLayoutInRels(
        entries,
        binding.part_path,
        editedSlide.layout.layout_id,
        binding.part_path,
      );
      replacements.set(switched.rels_path, utf8Bytes(switched.xml));
      changed.push(switched.rels_path);
    }

    if (binding.notes_part_path === null) {
      if (editedSlide.notes !== null) {
        // 新增备注部件：交给 note-parts（含 notesMaster 登记），而不是本层重写关系图 / 内容类型。
        notesOps.push({ page_number: index + 1, text: speakerNotesText(editedSlide.notes) });
      }
      return;
    }

    if (editedSlide.notes === null) {
      // 删除备注部件：同上，交给 note-parts 逆向删干净（含 notesMaster 清理）。
      notesOps.push({ page_number: index + 1, text: null });
      return;
    }

    if (binding.slide.notes === null || renderNotesPartXml(binding.slide.notes) !== renderNotesPartXml(editedSlide.notes)) {
      replacements.set(binding.notes_part_path, utf8Bytes(renderNotesPartXml(editedSlide.notes)));
      changed.push(binding.notes_part_path);
    }
  });

  if (notesOps.length === 0) {
    const saved = savePresentation(imported.opened, { replacements });
    return Object.freeze({ ...saved, changed_part_paths: Object.freeze(changed) });
  }

  // 备注部件增 / 删要动关系图与内容类型（savePresentation 只能替换既有部件），
  // 故走"装配 EditableDeck → note-parts 应用 → 写回"，末尾再按真实字节重算差异清单。
  const bytes = serializeEditableDeck(buildDeckWithNotes(imported.opened, replacements, notesOps));
  return resultFromBytes(imported.opened, bytes);
}

/**
 * 文稿级属性（页尺寸 / 母版 / 主题 / 标题）被改动 ⇒ **具名报错**。
 *
 * 这四个字段都住在 `ppt/presentation.xml`（或 `docProps/core.xml`）里，而本出口只重渲染
 * **幻灯片与备注部件**。若不拦，调用方改了它们却看到"导出成功"，就是**静默无效**——
 * 正是本项目禁止的失败模式。拦住它，让"改不了"变成可听见的错误。
 */
function assertPresentationPropertiesUnchanged(imported: ImportedPresentation, edited: Presentation): void {
  const original = imported.presentation;
  const changes: string[] = [];
  if (edited.size.cx_emu !== original.size.cx_emu || edited.size.cy_emu !== original.size.cy_emu) {
    changes.push(
      `页尺寸 ${String(original.size.cx_emu)}×${String(original.size.cy_emu)} → ` +
        `${String(edited.size.cx_emu)}×${String(edited.size.cy_emu)}`,
    );
  }
  if (edited.master.master_id !== original.master.master_id) {
    changes.push(`母版 ${original.master.master_id} → ${edited.master.master_id}`);
  }
  if (edited.theme.theme_id !== original.theme.theme_id) {
    changes.push(`主题 ${original.theme.theme_id} → ${edited.theme.theme_id}`);
  }
  if (edited.title !== original.title) {
    changes.push(`标题 ${JSON.stringify(original.title)} → ${JSON.stringify(edited.title)}`);
  }
  if (changes.length > 0) {
    return fail(
      'presentation_properties_change_unsupported',
      `本出口只重渲染幻灯片与备注部件；文稿级属性改动需要替换 ppt/presentation.xml（或 docProps/core.xml）` +
        `并重建关系图，本增量未封装该流程，故明确拒绝而不是静默无效：${changes.join('；')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 文件会话层（PPT-01 新建 / 保存 / 另存 / 重命名 / 关闭重开；PPT-14 版本比较）
// ---------------------------------------------------------------------------

/** 一份演示文件的来源：全新（从空文稿开始）或导入的既有文件。 */
export type PresentationFileOrigin = 'new' | 'imported';

/**
 * 一份**已保存**的演示文件（文件层会话）。
 *
 * 这是"新建 / 导入 → 编辑 → 保存 / 另存 / 重命名 → 关闭重开"这条链上的值对象：
 * - `bytes` 是**当前已保存的字节**（新建时 = 空文稿渲染结果；导入时 = 源包原字节）；
 * - `presentation` 是当前可编辑模型（未保存的内存态由调用方自行持有并传给 `savePresentationFile`）；
 * - `revision` 每保存一次 +1（**重命名不加**——重命名不改内容，见 `renamePresentationFile`）；
 * - `imported` 非空的文件才走"只换被改页、其余逐字节保留"的保真路径。
 *
 * 全部会话操作都是**纯函数**：返回新值，绝不就地改动入参。因此"保存失败 ⇒ 旧字节仍在"
 * 是结构性的（失败时抛出，入参 `file.bytes` 原样可读回），而不是靠调用方回滚。
 */
export interface PresentationFile {
  readonly file_id: string;
  /** 文件名（含扩展名）；重命名改的就是它。 */
  readonly name: string;
  readonly title: string;
  readonly origin: PresentationFileOrigin;
  readonly bytes: Buffer;
  readonly revision: number;
  readonly presentation: Presentation;
  readonly imported: ImportedPresentation | null;
}

/** 「关闭」的产物：交出去的字节 + 名字 + 身份（文件层交给宿主/存储的交接对象）。 */
export interface ClosedPresentationFile {
  readonly file_id: string;
  readonly name: string;
  readonly bytes: Buffer;
  readonly revision: number;
  readonly digest: string;
}

/** 新建一份演示文件（PPT-01「新建」）：从空文稿开始，**页数为 0**，由调用方按任务加页。 */
export interface CreatePresentationFileInput {
  readonly presentation_id: string;
  readonly name: string;
  readonly title: string;
  /** 页尺寸（比例）；缺省 = 4:3（与 `emptyPresentation` 一致）。 */
  readonly size?: SlideSize;
}

/** 打开选项。 */
export interface OpenPresentationFileInput {
  readonly name: string;
}

function requireFileName(name: string): string {
  if (name.trim() === '') {
    return fail('invalid_file_name', '文件名不能为空');
  }
  return name;
}

/**
 * 新建一份演示文件（PPT-01）。页数**不是常数**：这里只给出空文稿，页数由 `addSlide` /
 * `removeSlide` 随任务增减（资源上限由调用方的预算决定，不在本层写死）。
 */
export function createPresentationFile(input: CreatePresentationFileInput): PresentationFile {
  const base = emptyPresentation(input.presentation_id, input.title);
  const presentation: Presentation = input.size === undefined ? base : { ...base, size: input.size };
  const rendered = renderPresentation(presentation);
  return Object.freeze({
    file_id: `new:${input.presentation_id}`,
    name: requireFileName(input.name),
    title: input.title,
    origin: 'new',
    bytes: rendered.bytes,
    revision: 0,
    presentation,
    imported: null,
  });
}

/**
 * 打开一份既有 PPTX（PPT-01「导入」）：解析成可编辑模型，同时**记下全部原始部件**
 * （母版 / 版式 / 主题 / 媒体 / 自定义部件原样保留，PPT-03）。
 */
export function openPresentationFile(bytes: Uint8Array, input: OpenPresentationFileInput): PresentationFile {
  const imported = importPresentation(bytes);
  return Object.freeze({
    file_id: digestBytes(bytes),
    name: requireFileName(input.name),
    title: imported.presentation.title,
    origin: 'imported',
    bytes: Buffer.from(bytes),
    revision: 0,
    presentation: imported.presentation,
    imported,
  });
}

/** 按文件来源选渲染路径：新建走整份渲染，导入走"只换被改页"的保留路径。 */
function renderFileBytes(file: PresentationFile, edited: Presentation): Buffer {
  if (file.imported === null) {
    return renderPresentation(edited).bytes;
  }
  return exportImportedPresentation(file.imported, edited).bytes;
}

/**
 * 保存（PPT-01）：把**编辑后的模型**写回成字节，返回晋级后的文件值。
 *
 * `edited` 缺省 = 当前模型（即"原样保存"）。**纯函数**：入参 `file` 不变，因此保存中途失败
 * （例如给导入件增删页 ⇒ `slide_set_changed`）时，`file.bytes` 仍是旧的、可读回的那个版本
 * ——这就是 PPT-14 的「失败保旧」在文件层的落点。
 */
export function savePresentationFile(file: PresentationFile, edited?: Presentation): PresentationFile {
  const model = edited ?? file.presentation;
  const bytes = renderFileBytes(file, model);
  return Object.freeze({
    ...file,
    bytes,
    presentation: model,
    revision: file.revision + 1,
  });
}

/** 另存选项。 */
export interface SavePresentationFileAsInput {
  readonly name: string;
  /** 另存时的编辑后模型；缺省 = 当前模型。 */
  readonly edited?: Presentation;
}

/**
 * 另存（PPT-01）：把当前（或给定的编辑后）模型写成**一份带新文件名的副本**。
 *
 * **源文件值一个字段都不动**——这正是"另存"与"保存"的区别：保存推进同一个文件，
 * 另存产出一个新文件、原文件（含其字节与版本号）保持原样。
 */
export function savePresentationFileAs(
  file: PresentationFile,
  input: SavePresentationFileAsInput,
): PresentationFile {
  const model = input.edited ?? file.presentation;
  const bytes = renderFileBytes(file, model);
  return Object.freeze({
    ...file,
    name: requireFileName(input.name),
    bytes,
    presentation: model,
    revision: file.revision + 1,
    file_id: `${file.file_id}+as:${input.name}`,
  });
}

/**
 * 重命名（PPT-01）：只改**文件名**，不改内容。
 *
 * 因此 `bytes` **逐字节不变**、`revision` **不变**（重命名不是新版本）。反向对照：
 * 保存/另存会换字节、推进版本号，重命名两者都不动——两者可被区分。
 * 要改文档标题（`dc:title`）不是重命名，那是另存/文稿级属性，本增量未封装（如实登记）。
 */
export function renamePresentationFile(file: PresentationFile, newName: string): PresentationFile {
  return Object.freeze({ ...file, name: requireFileName(newName) });
}

/** 关闭（PPT-01）：交出字节与身份，丢弃内存会话。 */
export function closePresentationFile(file: PresentationFile): ClosedPresentationFile {
  return Object.freeze({
    file_id: file.file_id,
    name: file.name,
    bytes: file.bytes,
    revision: file.revision,
    digest: digestBytes(file.bytes),
  });
}

/**
 * 关闭重开（PPT-01）：用**已保存的字节**重新打开，得到一份可继续编辑的文件值。
 *
 * 重开后走的是导入路径（部件级保留），因此"重开 → 改一页 → 保存"仍然只换被改的那一页。
 */
export function reopenPresentationFile(
  closed: Pick<PresentationFile, 'bytes' | 'name'>,
  name?: string,
): PresentationFile {
  return openPresentationFile(closed.bytes, { name: name ?? closed.name });
}

// ---------------------------------------------------------------------------
// 文稿结构读取（PPT-03：主题 / 母版 / 版式 / 背景 / 配色 / 页面尺寸比例）
// ---------------------------------------------------------------------------

/** 从既有文件读出的**文稿结构**（全部来自真实部件，不是默认表）。 */
export interface PresentationStructure {
  readonly size: SlideSize;
  /** 母版部件路径与其**字节摘要**（"母版有没有被重造"用摘要比，不用肉眼）。 */
  readonly master_part_path: string;
  readonly master_part_digest: string;
  /** 版式部件路径，按母版 `_rels` 的声明顺序。 */
  readonly layout_part_paths: readonly string[];
  readonly theme_part_path: string | null;
  readonly theme_color_scheme: ColorScheme | null;
  /** 逐页背景（按页序）；`inherit` = 该页没有 `p:bg`。 */
  readonly backgrounds: readonly SlideBackground[];
}

function parsePartRoot(entry: { readonly data: Uint8Array }, path: string, reason: 'malformed_slide_xml' | 'malformed_presentation_xml'): XmlElementNode {
  try {
    return parseXmlDocument(Buffer.from(entry.data).toString('utf8'));
  } catch (error) {
    if (error instanceof XmlParseError) {
      return fail(reason, `${path} 解析失败：${error.message}`);
    }
    throw error;
  }
}

/** 读一页的背景（`p:cSld/p:bg`）；读不了的填充**报具名错误**，不降级成 `inherit`。 */
function parseSlideBackground(slideRoot: XmlElementNode, context: string): SlideBackground {
  const bg = firstElement(firstElement(slideRoot, 'p:cSld'), 'p:bg');
  if (bg === undefined) {
    return { kind: 'inherit' };
  }
  const bgPr = firstElement(bg, 'p:bgPr');
  if (bgPr !== undefined) {
    const blip = firstElement(firstElement(bgPr, 'a:blipFill'), 'a:blip');
    const embed = attributeOf(blip, 'r:embed');
    if (embed !== undefined) {
      return { kind: 'image', relation_id: embed };
    }
    const solidFill = firstElement(bgPr, 'a:solidFill');
    const srgb = attributeOf(firstElement(solidFill, 'a:srgbClr'), 'val');
    if (srgb !== undefined) {
      return { kind: 'solid', color: srgb };
    }
    const scheme = attributeOf(firstElement(solidFill, 'a:schemeClr'), 'val');
    if (scheme !== undefined) {
      return { kind: 'scheme', scheme_color: scheme };
    }
    return fail(
      'unsupported_background',
      `${context} 的 p:bgPr 用了本域未建模的填充（只支持纯色 srgbClr / schemeClr 与背景图 blipFill），不静默当成继承母版`,
    );
  }
  const bgRef = firstElement(bg, 'p:bgRef');
  if (bgRef !== undefined) {
    const scheme = attributeOf(firstElement(bgRef, 'a:schemeClr'), 'val');
    if (scheme !== undefined) {
      return { kind: 'scheme', scheme_color: scheme };
    }
    return fail('unsupported_background', `${context} 的 p:bgRef 没有 a:schemeClr，不静默当成继承母版`);
  }
  return fail('unsupported_background', `${context} 的 p:bg 既没有 p:bgPr 也没有 p:bgRef，不静默当成继承母版`);
}

/** 读主题配色的十二个槽位；缺槽位报错（不静默补默认色）。 */
function parseColorScheme(themeRoot: XmlElementNode, themePath: string): ColorScheme | null {
  const scheme = firstElement(firstElement(themeRoot, 'a:themeElements'), 'a:clrScheme');
  if (scheme === undefined) {
    return null;
  }
  const slots: Record<string, string> = {};
  for (const slot of ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']) {
    const element = firstElement(scheme, `a:${slot}`);
    if (element === undefined) {
      return fail('unsupported_color_scheme', `${themePath} 的 a:clrScheme 缺少槽位 a:${slot}`);
    }
    const srgb = attributeOf(firstElement(element, 'a:srgbClr'), 'val');
    const system = attributeOf(firstElement(element, 'a:sysClr'), 'lastClr');
    const value = srgb ?? system;
    if (value === undefined) {
      return fail(
        'unsupported_color_scheme',
        `${themePath} 的 a:${slot} 既没有 a:srgbClr@val 也没有 a:sysClr@lastClr（本域不猜颜色）`,
      );
    }
    slots[slot] = value;
  }
  return Object.freeze(slots) as unknown as ColorScheme;
}

/**
 * 读一份 PPTX 的文稿结构（PPT-03）：页尺寸比例、母版部件（含字节摘要）、版式清单、
 * 主题与配色、逐页背景。**全部来自真实部件**——同一函数用在"导入的既有文件"上，
 * 得到的就是那个文件自己的主题/配色/背景，而不是我们渲染时的默认值。
 *
 * @throws {PresentationRoundTripError} 找不到母版关系 / 背景或配色超出本域建模范围。
 */
export function readPresentationStructure(bytes: Uint8Array): PresentationStructure {
  const opened = openPresentation(bytes);
  const entries = opened.by_path;

  const presentationEntry = entries.get('ppt/presentation.xml');
  if (presentationEntry === undefined) {
    return fail('malformed_presentation_xml', '包内没有 ppt/presentation.xml');
  }
  const presentationRoot = parsePartRoot(presentationEntry, 'ppt/presentation.xml', 'malformed_presentation_xml');
  const slideSize = firstElement(presentationRoot, 'p:sldSz');
  const size: SlideSize = {
    cx_emu: requiredInteger(slideSize, 'cx', 'p:sldSz'),
    cy_emu: requiredInteger(slideSize, 'cy', 'p:sldSz'),
  };

  const presentationRels = readRelationshipIndex(entries, 'ppt/presentation.xml');
  const masterPartPath = findRelationshipTarget(presentationRels, /(^|\/)slideMasters\/slideMaster[^/]*\.xml$/);
  if (masterPartPath === undefined) {
    return fail(
      'malformed_presentation_xml',
      'ppt/presentation.xml.rels 里没有指向 slideMasters/slideMaster*.xml 的内部关系',
    );
  }
  const masterEntry = entries.get(masterPartPath);
  if (masterEntry === undefined) {
    return fail('malformed_presentation_xml', `母版关系指向的部件 ${masterPartPath} 不在包内`);
  }

  const masterRels = readRelationshipIndex(entries, masterPartPath);
  const layoutPartPaths: string[] = [];
  const seenLayouts = new Set<string>();
  for (const path of masterRels.pathById.values()) {
    if (/(^|\/)slideLayouts\/slideLayout[^/]*\.xml$/.test(path) && !seenLayouts.has(path)) {
      seenLayouts.add(path);
      layoutPartPaths.push(path);
    }
  }

  const themePartPath =
    findRelationshipTarget(masterRels, /(^|\/)theme\/theme[^/]*\.xml$/) ??
    (entries.has('ppt/theme/theme1.xml') ? 'ppt/theme/theme1.xml' : undefined);
  let colorScheme: ColorScheme | null = null;
  if (themePartPath !== undefined) {
    const themeEntry = entries.get(themePartPath);
    if (themeEntry !== undefined) {
      colorScheme = parseColorScheme(parsePartRoot(themeEntry, themePartPath, 'malformed_presentation_xml'), themePartPath);
    }
  }

  const backgrounds = opened.slide_part_paths.map((path) => {
    const entry = entries.get(path);
    if (entry === undefined) {
      return fail('malformed_slide_xml', `包内没有幻灯片部件 ${path}`);
    }
    return parseSlideBackground(parsePartRoot(entry, path, 'malformed_slide_xml'), path);
  });

  return Object.freeze({
    size: Object.freeze(size),
    master_part_path: masterPartPath,
    master_part_digest: digestBytes(masterEntry.data),
    layout_part_paths: Object.freeze(layoutPartPaths),
    theme_part_path: themePartPath ?? null,
    theme_color_scheme: colorScheme,
    backgrounds: Object.freeze(backgrounds),
  });
}

// ---------------------------------------------------------------------------
// 版本比较（PPT-14）
// ---------------------------------------------------------------------------

/** 一次版本比较的结果（按**部件字节**如实对比，不靠声明）。 */
export interface PresentationVersionComparison {
  readonly identical: boolean;
  readonly before_digest: string;
  readonly after_digest: string;
  readonly before_slide_count: number;
  readonly after_slide_count: number;
  /** 只在新版本里出现的部件路径。 */
  readonly added_part_paths: readonly string[];
  /** 只在旧版本里出现的部件路径。 */
  readonly removed_part_paths: readonly string[];
  /** 两版都有但字节不同的部件路径（按**旧版**的部件顺序）。 */
  readonly changed_part_paths: readonly string[];
  readonly unchanged_part_count: number;
}

/**
 * 比较两份 PPTX 的版本差异（PPT-14「版本比较」）。
 *
 * 按部件字节逐一比对：`identical` 为真当且仅当**两份字节完全相同**。
 * 这与"导入—编辑—写回"的保真口径一致：没动过的页不会出现在 `changed_part_paths` 里，
 * 因此"改了哪几页"是能直接读出的事实。
 */
export function comparePresentationFiles(before: Uint8Array, after: Uint8Array): PresentationVersionComparison {
  const beforeArchive = openPresentation(before);
  const afterArchive = openPresentation(after);

  const beforeDigest = digestBytes(before);
  const afterDigest = digestBytes(after);

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;

  for (const path of afterArchive.by_path.keys()) {
    if (!beforeArchive.by_path.has(path)) {
      added.push(path);
    }
  }
  for (const entry of beforeArchive.entries) {
    const other = afterArchive.by_path.get(entry.path);
    if (other === undefined) {
      removed.push(entry.path);
      continue;
    }
    if (Buffer.compare(Buffer.from(other.data), Buffer.from(entry.data)) === 0) {
      unchanged += 1;
    } else {
      changed.push(entry.path);
    }
  }

  return Object.freeze({
    identical: beforeDigest === afterDigest,
    before_digest: beforeDigest,
    after_digest: afterDigest,
    before_slide_count: beforeArchive.slide_part_paths.length,
    after_slide_count: afterArchive.slide_part_paths.length,
    added_part_paths: Object.freeze(added),
    removed_part_paths: Object.freeze(removed),
    changed_part_paths: Object.freeze(changed),
    unchanged_part_count: unchanged,
  });
}

/** 便捷入口：比较两个文件值（PPT-14 版本比较）。 */
export function comparePresentationFileVersions(
  before: PresentationFile,
  after: PresentationFile,
): PresentationVersionComparison {
  return comparePresentationFiles(before.bytes, after.bytes);
}

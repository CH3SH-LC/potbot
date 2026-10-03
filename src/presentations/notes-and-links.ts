/**
 * 演示域**链接 / 页脚 / 日期 / 页码**的"更新不留错"层（design-06 P9；PPT-10 补充）。
 *
 * ## 这一层解决什么
 *
 * `notes.ts` 已经给出了链接 / 页脚 / 日期 / 页码的**收敛语义**（`reconcileAnnotations`：删页后
 * 剔除死链与孤儿批注，且是纯函数）。本模块**不另造一套收敛**——它只补两件 `notes.ts` 没做的、
 * 却是 PPT-10 落点的事：
 *
 * 1. **更新**（改链接目标、改页脚）之后的**反向核对**：
 *    - 链接：`retargetLinks` 在改目标前就**拒绝**把链接指向已删页（`target_slide_missing`），
 *      并额外剔除"承载对象已不在该页上"的链接（`carrier_shape_missing`，`notes.ts` 只查承载页）；
 *      改完仍走 `notes.reconcileAnnotations` 收敛——复用而不是重写。
 *    - 页脚：`applyFootersToDeck` 批量套用后，`readBackFooterXml` / `verifyFootersApplied` 把
 *      产物**解析回读**核对，`findStaleFooterText` 找出仍残留旧文本的页——"更新不留遗留错误数据"。
 * 2. **批量套用 + 读回核对**：页脚 / 日期 / 页码一次套到整份文稿的每一页，逐页读回比对。
 *
 * ## 为什么日期 / 页码"读回"要能识破字面量
 *
 * 日期与页码必须是**域**（`a:fld type="datetime"` / `type="slidenum"`）——写成字面量就是遗留
 * 错误数据（换页/跨天不会更新）。因此 `readBackFooterXml` 在读回时会**具名报错**
 * （`literal_date` / `literal_slide_number`）而不是把字面量当成"页脚正常"。这正是
 * `renderFooterShapesXml` 写域、本模块读回核对这一对动作的闭合点。
 *
 * ## 复用边界
 *
 * - 页脚片段渲染完全走 `notes.renderFooterShapesXml`（同一口径，不重写占位符布局）；
 * - 收敛完全走 `notes.reconcileAnnotations`（同一语义，本模块只在其上追加"承载对象是否还在"）；
 * - 批注收敛（`dropped_comments`）不在本模块改写，仍由 `notes.ts` 负责。
 */

import { ValidationError } from '../protocol/index.js';

import type { Presentation, Shape } from './model.js';
import {
  reconcileAnnotations,
  renderFooterShapesXml,
  type Annotations,
  type DroppedLink,
  type HyperlinkTarget,
  type SlideFooterConfig,
  type SlideHyperlink,
} from './notes.js';
import { attributeOf, childElements, firstElement, parseXmlDocument, textContentOf, type XmlElementNode } from './xml-parse.js';

// ---------------------------------------------------------------------------
// 链接收敛（复用 notes.ts 的收敛语义，另加"承载对象是否还在"）
// ---------------------------------------------------------------------------

/** 链接被剔除的原因（前两条沿用 `notes.ts`，第三条是本模块补充的核对面）。 */
export type LinkConvergenceReason =
  | 'carrier_slide_missing'
  | 'target_slide_missing'
  | 'carrier_shape_missing';

/** 被剔除的一条链接 + 具名原因。 */
export interface ConvergedLink {
  readonly link: SlideHyperlink;
  readonly reason: LinkConvergenceReason;
}

/** 收敛报告：保留下来的注解 + 被剔除项（**不静默**）。 */
export interface LinkConvergenceReport {
  readonly annotations: Annotations;
  readonly dropped: readonly ConvergedLink[];
}

function slideOf(presentation: Presentation, slideId: number): Presentation['slides'][number] | undefined {
  return presentation.slides.find((slide) => slide.slide_id === slideId);
}

function hasShape(shapes: readonly Shape[], shapeId: number): boolean {
  for (const shape of shapes) {
    if (shape.shape_id === shapeId) return true;
    if (shape.kind === 'group' && hasShape(shape.children, shapeId)) return true;
  }
  return false;
}

/** 承载链接的对象是否仍在该页上（含组合子对象）。 */
export function linkCarrierExists(
  presentation: Presentation,
  link: SlideHyperlink,
): boolean {
  const slide = slideOf(presentation, link.slide_id);
  if (slide === undefined) return false;
  return hasShape(slide.shapes, link.shape_id);
}

/**
 * 页集合变化 / 对象被删后**收敛链接**（PPT-10「更新不指向失效页面或遗留错误数据」）。
 *
 * 第一步直接调用 `notes.reconcileAnnotations`（**复用**既有收敛语义：剔除承载页已删的链接与
 * 内部跳转目标页已删的链接）；第二步在其**存活集**上剔除"承载对象已不在该页上"的链接
 * （`carrier_shape_missing`）——这是 `notes.ts` 没覆盖、但同样是"遗留错误数据"的一面。
 *
 * 纯函数：入参 `annotations` 不被就地修改。
 */
export function convergeLinks(annotations: Annotations, presentation: Presentation): LinkConvergenceReport {
  const base = reconcileAnnotations(annotations, presentation);
  const dropped: ConvergedLink[] = base.dropped_links.map((entry: DroppedLink) => ({
    link: entry.item,
    reason: entry.reason,
  }));
  const surviving: SlideHyperlink[] = [];
  for (const link of base.annotations.links) {
    if (!linkCarrierExists(presentation, link)) {
      dropped.push({ link, reason: 'carrier_shape_missing' });
      continue;
    }
    surviving.push(link);
  }
  return Object.freeze({
    annotations: Object.freeze({
      footer: base.annotations.footer,
      comments: base.annotations.comments,
      links: Object.freeze(surviving),
    }),
    dropped: Object.freeze(dropped),
  });
}

// ---------------------------------------------------------------------------
// 链接更新（改目标前先拒绝"指向已删页"）
// ---------------------------------------------------------------------------

/** 一条改链接目标的请求：按 `(slide_id, shape_id, rel_id)` 精确指向一条链接。 */
export interface LinkRetargetRequest {
  readonly slide_id: number;
  readonly shape_id: number;
  readonly rel_id: string;
  readonly target: HyperlinkTarget;
}

/** 请求被拒的原因。 */
export type RetargetRefusalReason = 'unknown_link' | 'carrier_slide_missing' | 'target_slide_missing';

/** 被拒的请求 + 具名原因。 */
export interface RetargetRefusal {
  readonly request: LinkRetargetRequest;
  readonly reason: RetargetRefusalReason;
}

/** 改链接目标的结果。 */
export interface RetargetReport {
  readonly annotations: Annotations;
  readonly applied: readonly SlideHyperlink[];
  readonly refused: readonly RetargetRefusal[];
  readonly dropped: readonly ConvergedLink[];
}

function sameLink(left: SlideHyperlink, right: LinkRetargetRequest): boolean {
  return (
    left.slide_id === right.slide_id && left.shape_id === right.shape_id && left.rel_id === right.rel_id
  );
}

/**
 * 批量改链接目标（PPT-10）。**更新在写之前就拒绝"指向失效页面"**：
 *
 * - 找不到对应链接 ⇒ `unknown_link`；
 * - 承载页已删 ⇒ `carrier_slide_missing`；
 * - 新目标是内部跳转且目标页已删 ⇒ `target_slide_missing`（**不写进去**，而不是写了再让消费端点开报错）。
 *
 * 被拒的请求**不落进产物**；接受的请求写完后仍走 `convergeLinks` 收敛（复用 notes 语义）。
 */
export function retargetLinks(
  annotations: Annotations,
  presentation: Presentation,
  requests: readonly LinkRetargetRequest[],
): RetargetReport {
  const liveSlideIds = new Set(presentation.slides.map((slide) => slide.slide_id));
  const links = [...annotations.links];
  const applied: SlideHyperlink[] = [];
  const refused: RetargetRefusal[] = [];

  for (const request of requests) {
    const index = links.findIndex((link) => sameLink(link, request));
    if (index < 0) {
      refused.push({ request, reason: 'unknown_link' });
      continue;
    }
    if (!liveSlideIds.has(request.slide_id)) {
      refused.push({ request, reason: 'carrier_slide_missing' });
      continue;
    }
    if (request.target.kind === 'slide' && !liveSlideIds.has(request.target.slide_id)) {
      refused.push({ request, reason: 'target_slide_missing' });
      continue;
    }
    const current = links[index] as SlideHyperlink;
    const updated: SlideHyperlink = Object.freeze({ ...current, target: request.target });
    links[index] = updated;
    applied.push(updated);
  }

  const converged = convergeLinks({ ...annotations, links }, presentation);
  return Object.freeze({
    annotations: converged.annotations,
    applied: Object.freeze(applied),
    refused: Object.freeze(refused),
    dropped: converged.dropped,
  });
}

// ---------------------------------------------------------------------------
// 页脚 / 日期 / 页码：批量套用 + 读回核对
// ---------------------------------------------------------------------------

/** 幻灯片尺寸（EMU）；页脚三栏按页宽均分。 */
export interface DeckSlideSize {
  readonly cx_emu: number;
  readonly cy_emu: number;
}

/** 套用到某一页的结果。 */
export interface SlideFooterApplication {
  readonly slide_id: number;
  /** 页序（1 起）——页码域的**求值结果**由消费端算，这里只记"这是第几页"。 */
  readonly slide_number: number;
  readonly xml: string;
}

/**
 * 把页脚 / 日期 / 页码**批量套用到整份文稿**（按页序，页码 1 起）。
 *
 * 每页的片段走 `notes.renderFooterShapesXml`（同一口径）；本函数只负责"套到每一页"。
 */
export function applyFootersToDeck(
  presentation: Presentation,
  config: SlideFooterConfig,
  slideSize: DeckSlideSize,
): readonly SlideFooterApplication[] {
  return Object.freeze(
    presentation.slides.map((slide, index) =>
      Object.freeze({
        slide_id: slide.slide_id,
        slide_number: index + 1,
        xml: renderFooterShapesXml(config, index + 1, slideSize),
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// 读回核对
// ---------------------------------------------------------------------------

/** 页脚读回失败原因。 */
export type FooterReadbackErrorReason = 'malformed_footer' | 'literal_date' | 'literal_slide_number';

/** 读回失败：产物里出现了**遗留错误数据**（字面量日期 / 页码）或结构不对。 */
export class FooterReadbackError extends ValidationError {
  readonly reason: FooterReadbackErrorReason;

  constructor(reason: FooterReadbackErrorReason, message: string) {
    super(message);
    this.name = 'FooterReadbackError';
    this.reason = reason;
  }
}

/** 从一页页脚片段读回的配置（"读回核对"的输入）。 */
export interface FooterReadback {
  readonly footer_text: string | null;
  readonly show_date: boolean;
  readonly show_slide_number: boolean;
}

const DATE_LITERAL_PATTERN = /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/;
const NUMBER_LITERAL_PATTERN = /^-?\d+$/;

function paragraphRunText(paragraph: XmlElementNode | undefined): string {
  if (paragraph === undefined) return '';
  let text = '';
  for (const child of childElements(paragraph)) {
    if (child.name === 'a:r' || child.name === 'a:fld') {
      text += textContentOf(child);
    }
  }
  return text;
}

/** `p:sp > p:nvSpPr > p:nvPr > p:ph` 的 `type`（占位符种类）。 */
function placeholderTypeOf(shape: XmlElementNode): string | undefined {
  const nvPr = firstElement(firstElement(shape, 'p:nvSpPr'), 'p:nvPr');
  return attributeOf(firstElement(nvPr, 'p:ph'), 'type');
}

function paragraphOf(shape: XmlElementNode): XmlElementNode | undefined {
  return firstElement(firstElement(shape, 'p:txBody'), 'a:p');
}

/** 要求该段落里有一个**域**（`a:fld`），且域类型正确；否则是遗留错误数据。 */
function requireField(
  paragraph: XmlElementNode | undefined,
  expectedType: string,
  literalReason: FooterReadbackErrorReason,
): void {
  const field = firstElement(paragraph, 'a:fld');
  if (field === undefined) {
    throw new FooterReadbackError(
      literalReason,
      `页脚占位符里没有 ${expectedType} 域（写成了字面量就是遗留错误数据：换页 / 跨天不会更新）`,
    );
  }
  const actualType = attributeOf(field, 'type');
  if (actualType !== expectedType) {
    throw new FooterReadbackError(literalReason, `页脚域的类型是 ${String(actualType)}，应为 ${expectedType}`);
  }
  // 域旁边若还挂着字面量文本（域 + 硬写日期/页码），同样算遗留错误数据。
  for (const child of childElements(paragraph)) {
    if (child.name !== 'a:r') continue;
    const text = textContentOf(child).trim();
    if (expectedType === 'datetime' && DATE_LITERAL_PATTERN.test(text)) {
      throw new FooterReadbackError(literalReason, `页脚里同时出现了硬写的日期文本 ${text}（遗留错误数据）`);
    }
    if (expectedType === 'slidenum' && NUMBER_LITERAL_PATTERN.test(text)) {
      throw new FooterReadbackError(literalReason, `页脚里同时出现了硬写的页码文本 ${text}（遗留错误数据）`);
    }
  }
}

/**
 * 把一页页脚片段**解析回读**成配置（PPT-10 的"读回核对"）。
 *
 * 空串（三项都不显示）⇒ 全默认。日期 / 页码若不是**域**而是字面量 ⇒ 具名抛错，绝不把字面量
 * 当成"页脚正常"。
 *
 * @throws {FooterReadbackError} 结构不对 / 出现字面量日期或页码。
 */
export function readBackFooterXml(xml: string): FooterReadback {
  if (xml.trim() === '') {
    return Object.freeze({ footer_text: null, show_date: false, show_slide_number: false });
  }
  const root = parseXmlDocument(`<root>${xml}</root>`);
  let footerText: string | null = null;
  let showDate = false;
  let showSlideNumber = false;

  for (const shape of childElements(root, 'p:sp')) {
    const type = placeholderTypeOf(shape);
    const paragraph = paragraphOf(shape);
    if (type === 'ftr') {
      footerText = paragraphRunText(paragraph);
    } else if (type === 'dt') {
      requireField(paragraph, 'datetime', 'literal_date');
      showDate = true;
    } else if (type === 'sldNum') {
      requireField(paragraph, 'slidenum', 'literal_slide_number');
      showSlideNumber = true;
    } else if (type === undefined) {
      // 占位符类型缺失：结构不对，具名报错（不静默当成"没有页脚"）。
      throw new FooterReadbackError('malformed_footer', '页脚占位符缺少 p:ph 的 type 属性');
    }
  }

  return Object.freeze({
    footer_text: footerText,
    show_date: showDate,
    show_slide_number: showSlideNumber,
  });
}

/** 一页的读回结果（含页序）。 */
export interface SlideFooterReadback {
  readonly slide_id: number;
  readonly slide_number: number;
  readonly readback: FooterReadback;
}

/** 一处不符。 */
export interface FooterMismatch {
  readonly slide_id: number;
  readonly field: 'footer_text' | 'show_date' | 'show_slide_number';
  readonly expected: string | boolean | null;
  readonly actual: string | boolean | null;
}

/** 核对结果。 */
export interface FooterVerification {
  readonly ok: boolean;
  readonly per_slide: readonly SlideFooterReadback[];
  readonly mismatches: readonly FooterMismatch[];
}

/**
 * 把批量套用的产物**逐页读回**并与期望配置比对（PPT-10「批量套用并读回核对」）。
 *
 * 读回本身失败（字面量日期/页码 / 结构不对）会抛 `FooterReadbackError`——那是比"配置不符"
 * 更严重的遗留错误数据，不吞。
 */
export function verifyFootersApplied(
  applications: readonly SlideFooterApplication[],
  expected: SlideFooterConfig,
): FooterVerification {
  const perSlide: SlideFooterReadback[] = [];
  const mismatches: FooterMismatch[] = [];
  for (const application of applications) {
    const readback = readBackFooterXml(application.xml);
    perSlide.push(
      Object.freeze({
        slide_id: application.slide_id,
        slide_number: application.slide_number,
        readback,
      }),
    );
    if (readback.footer_text !== expected.footer_text) {
      mismatches.push({
        slide_id: application.slide_id,
        field: 'footer_text',
        expected: expected.footer_text,
        actual: readback.footer_text,
      });
    }
    if (readback.show_date !== expected.show_date) {
      mismatches.push({
        slide_id: application.slide_id,
        field: 'show_date',
        expected: expected.show_date,
        actual: readback.show_date,
      });
    }
    if (readback.show_slide_number !== expected.show_slide_number) {
      mismatches.push({
        slide_id: application.slide_id,
        field: 'show_slide_number',
        expected: expected.show_slide_number,
        actual: readback.show_slide_number,
      });
    }
  }
  return Object.freeze({
    ok: mismatches.length === 0,
    per_slide: Object.freeze(perSlide),
    mismatches: Object.freeze(mismatches),
  });
}

/**
 * 找出仍**残留旧页脚文本**的页（"更新不留遗留错误数据"的反向核对）。
 *
 * 典型用法：把页脚从"内部资料"改成"公开版本"后跑一遍，返回仍是"内部资料"的页 id 列表；
 * 期望为空数组。
 */
export function findStaleFooterText(
  applications: readonly SlideFooterApplication[],
  staleText: string,
): readonly number[] {
  const stale: number[] = [];
  for (const application of applications) {
    const readback = readBackFooterXml(application.xml);
    if (readback.footer_text === staleText) {
      stale.push(application.slide_id);
    }
  }
  return Object.freeze(stale);
}

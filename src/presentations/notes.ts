/**
 * 演示域**备注 / 链接 / 页脚日期页码 / 批注**层（design-06 P9；PPT-10）。
 *
 * ## 这一层解决什么
 *
 * `model.ts` 只把**演讲备注**（`Slide.notes`）纳入对象模型，其余三项（链接、页脚/日期/页码、
 * 批注）**不在** `Slide` 上——它们是"随页存在、可整体重建"的附属数据，硬塞进 `Slide` 会把
 * 模型层和关系图（`_rels`）搅在一起。本模块因此把这三项放进一个**与 `Presentation` 并列的
 * 不可变注解容器** `Annotations`，并给出：
 *
 * - **真实 XML 片段**（不是描述文字）：超链接 run、页脚/日期/页码占位符、批注部件与批注作者部件；
 * - **更新不指向失效页面、不留遗留错误数据**：`reconcileAnnotations` 在页集合变化后剔除
 *   "指向已删页"的链接与"挂在已删页上"的批注，并把被剔除项**具名回报**（不静默吞掉）；
 * - 与既有模块**复用**而不改动：备注部件沿用 `render.ts` 的 `renderNotesPartXml`，
 *   设置备注沿用 `operations.ts` 的 `setSlideNotes`。
 *
 * ## 为什么日期/页码用"域"而不是写死的文本
 *
 * 页码与日期若写成字面量 `a:t`，换页/跨天就会**遗留错误数据**（第 3 页显示"1"、昨天打开显示今天）。
 * 因此这里把它们渲染成 DrawingML **域**（`a:fld type="slidenum"` / `type="datetime"`），
 * 由消费端在放映/打印时求值——这是 PPT-10「更新不会遗留错误数据」在产物层面的落点。
 *
 * ## 已知边界（如实登记）
 *
 * - 本模块只产出**片段 / 部件 XML**，不自行重建整份包的 `_rels`；把片段接进哪一页、给超链接
 *   分配哪个 `rId`，由接线方在关系图里登记（`hyperlinkRelationship` 给出该登记所需的声明形状）。
 * - 批注部件的**位置**（`p:pos`）按注解自带的 EMU 坐标写入；不做重叠避让。
 *
 * ## 集成增量 I24（run-20261003-B）补的两块
 *
 * 1. **首个备注母版**（`renderNotesMasterPartXml` / `notesMasterIdListXml` /
 *    `ensureNotesMasterIdList` / `planNotesMasterProvision`）：`import.linkSlideNotes` 要求包里
 *    **已有** notesMaster 关系，否则抛 `unknown_notes_master`——给一份本来没有备注母版的文稿挂第一条
 *    备注因此做不到。本层给出该场景所需的母版部件 XML、`p:notesMasterIdLst` 片段与创建计划（纯函数）。
 * 2. **批注登记册**（`CommentRegister` + `registerComment` / `unregisterComment` /
 *    `unregisterCommentsForSlide` / `retargetComment` / `reconcileCommentRegister`）：把批注从
 *    一次性数组收成一本**不可变**册子（作者按 id 归并、同名一致），供包级批注层
 *    （`annotations/comment-parts.ts`）在多次增删之间保持身份与收敛一致。
 */

import {
  attr,
  el,
  formatInteger,
  serializeXmlDocument,
  serializeXmlNode,
  type XmlElement,
} from '../artifacts/ooxml/index.js';
import { ValidationError } from '../protocol/index.js';

import { literalText, type Presentation, type RunStyle, type TextBody } from './model.js';
import { setSlideNotes } from './operations.js';
import { renderNotesPartXml } from './render.js';

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** 超链接关系类型（`_rels/*.xml.rels` 里 external 目标用它）。 */
export const REL_HYPERLINK =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
/** 内部"跳到某张幻灯片"的动作 URI（`a:hlinkClick` 的 `action`）。 */
export const ACTION_SLIDE_JUMP = 'ppaction://hlinksldjump';

/** `a:fld` 的 id 必须是 GUID；用固定值保证产物确定（同一模型连跑两次逐字节相等）。 */
const FIELD_ID_SLIDE_NUMBER = '{6B3B4A6C-0000-4000-8000-00000000A001}';
const FIELD_ID_DATE_TIME = '{6B3B4A6C-0000-4000-8000-00000000A002}';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 注解层失败原因（具名，供用例断言与上层分类）。 */
export type AnnotationErrorReason =
  | 'unknown_slide'
  | 'empty_comment_text'
  | 'unknown_author'
  /** 登记册里已有同 id 的批注（不许静默覆盖）。 */
  | 'duplicate_comment_id'
  /** 登记册里找不到该 id 的批注。 */
  | 'unknown_comment_id'
  /** 作者 id / 名称非法（空）。 */
  | 'invalid_author'
  /** 同一 author_id 出现两个不同名字（身份不一致）。 */
  | 'author_name_conflict'
  /** notesMaster 的创建描述符非法（状态自相矛盾 / 缺关系 id / 缺 p:sldIdLst）。 */
  | 'invalid_notes_master';

/** 注解层错误：语义不成立时抛出，**不静默**。 */
export class AnnotationError extends ValidationError {
  readonly reason: AnnotationErrorReason;

  constructor(reason: AnnotationErrorReason, message: string) {
    super(message);
    this.name = 'AnnotationError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 链接（PPT-10）
// ---------------------------------------------------------------------------

/**
 * 链接目标。
 *
 * - `url`：外部地址（产物里是 `external` 关系）；
 * - `slide`：**内部跳到某张幻灯片**（按 `slide_id` 指向，不是按页序——页序会随增删移动而变，
 *   按 id 指才不会"跳过一页后指到别处"）。
 */
export type HyperlinkTarget =
  | { readonly kind: 'url'; readonly url: string; readonly tooltip: string | null }
  | { readonly kind: 'slide'; readonly slide_id: number; readonly tooltip: string | null };

/** 关系声明形状（接线方据此写入该页的 `_rels`）。 */
export interface HyperlinkRelationship {
  readonly type: string;
  readonly target: string;
  readonly target_mode: 'External' | 'Internal';
}

/** 由链接目标推出它需要登记的关系（内部跳转的 target 由接线方按页部件路径补全）。 */
export function hyperlinkRelationship(target: HyperlinkTarget): HyperlinkRelationship {
  if (target.kind === 'url') {
    return { type: REL_HYPERLINK, target: target.url, target_mode: 'External' };
  }
  return { type: REL_HYPERLINK, target: '', target_mode: 'Internal' };
}

/** `a:hlinkClick`（run 上的超链接）。内部跳转带 `action="ppaction://hlinksldjump"`。 */
export function hyperlinkClickXml(relId: string, target: HyperlinkTarget): XmlElement {
  const attrs = [
    attr('r:id', relId),
    ...(target.kind === 'slide' ? [attr('action', ACTION_SLIDE_JUMP)] : []),
    ...(target.tooltip === null ? [] : [attr('tooltip', target.tooltip)]),
  ];
  return el('a:hlinkClick', attrs);
}

/**
 * 一个**带链接的文本 run**（`a:r`）：`a:rPr` 下挂 `a:hlinkClick`，文本在 `a:t`。
 *
 * 超链接的可见样式（PowerPoint 惯例是下划线 + 主题色）不写死：`style` 传什么就写什么，
 * 避免把"看起来像链接"当成语义。
 */
export function hyperlinkRunXml(
  relId: string,
  target: HyperlinkTarget,
  text: string,
  style?: RunStyle,
): XmlElement {
  const rPrAttrs = [
    attr('lang', 'zh-CN'),
    ...(style?.bold === true ? [attr('b', '1')] : []),
    ...(style?.italic === true ? [attr('i', '1')] : []),
    ...(style?.size_pt === undefined ? [] : [attr('sz', formatInteger(style.size_pt * 100))]),
    attr('dirty', '0'),
  ];
  const rPrChildren = [
    ...(style?.color === undefined
      ? []
      : [el('a:solidFill', [], [el('a:srgbClr', [attr('val', style.color)])])]),
    ...(style?.font === undefined ? [] : [el('a:latin', [attr('typeface', style.font)])]),
    hyperlinkClickXml(relId, target),
  ];
  return el('a:r', [], [el('a:rPr', rPrAttrs, rPrChildren), el('a:t', [], [text])]);
}

/** 序列化一个带链接的 run 片段（无 XML 声明，供拼进 `p:txBody`）。 */
export function renderHyperlinkRun(
  relId: string,
  target: HyperlinkTarget,
  text: string,
  style?: RunStyle,
): string {
  return serializeXmlNode(hyperlinkRunXml(relId, target, text, style));
}

// ---------------------------------------------------------------------------
// 页脚 / 日期 / 页码（PPT-10）
// ---------------------------------------------------------------------------

/** 页脚 / 日期 / 页码显示配置。 */
export interface SlideFooterConfig {
  /** 页脚文本；`null` = 不显示页脚。 */
  readonly footer_text: string | null;
  /** 是否显示日期**域**（自动求值，不是写死的日期字符串）。 */
  readonly show_date: boolean;
  /** 是否显示页码**域**（自动求值）。 */
  readonly show_slide_number: boolean;
}

/** 默认：三项都不显示（与"新建空白页"一致）。 */
export const NO_FOOTER: SlideFooterConfig = Object.freeze({
  footer_text: null,
  show_date: false,
  show_slide_number: false,
});

/** 页脚区在页面底部的安全边距（EMU）。 */
const FOOTER_MARGIN_EMU = 838200;
const FOOTER_HEIGHT_EMU = 457200;

interface FooterSlot {
  readonly x: number;
  readonly cx: number;
}

/** 底部三栏（日期 / 页脚 / 页码）的横向布局，按页面宽度均分。 */
function footerSlots(cx_emu: number): { date: FooterSlot; footer: FooterSlot; number: FooterSlot } {
  const inner = cx_emu - FOOTER_MARGIN_EMU * 2;
  const quarter = Math.round(inner / 4);
  const half = inner - quarter * 2;
  return {
    date: { x: FOOTER_MARGIN_EMU, cx: quarter },
    footer: { x: FOOTER_MARGIN_EMU + quarter, cx: half },
    number: { x: FOOTER_MARGIN_EMU + quarter + half, cx: quarter },
  };
}

function placeholderShapeXml(
  shapeId: number,
  name: string,
  phType: string,
  slot: FooterSlot,
  y_emu: number,
  body: readonly XmlElement[],
): XmlElement {
  return el('p:sp', [], [
    el('p:nvSpPr', [], [
      el('p:cNvPr', [attr('id', formatInteger(shapeId)), attr('name', name)]),
      el('p:cNvSpPr'),
      el('p:nvPr', [], [el('p:ph', [attr('type', phType), attr('sz', 'quarter')])]),
    ]),
    el('p:spPr', [], [
      el('a:xfrm', [], [
        el('a:off', [attr('x', formatInteger(slot.x)), attr('y', formatInteger(y_emu))]),
        el('a:ext', [attr('cx', formatInteger(slot.cx)), attr('cy', formatInteger(FOOTER_HEIGHT_EMU))]),
      ]),
      el('a:prstGeom', [attr('prst', 'rect')], [el('a:avLst')]),
    ]),
    el('p:txBody', [], [
      el('a:bodyPr', [attr('wrap', 'square')]),
      el('a:lstStyle'),
      el('a:p', [], [
        el('a:pPr', [], [el('a:buNone')]),
        ...body,
      ]),
    ]),
  ]);
}

/** 一个显示"日期域"的 run（`a:fld type="datetime"`，占位文本是 {DATE}，由消费端求值）。 */
function dateFieldRuns(): readonly XmlElement[] {
  return [
    el('a:fld', [attr('id', FIELD_ID_DATE_TIME), attr('type', 'datetime')], [
      el('a:rPr', [attr('lang', 'zh-CN'), attr('dirty', '0')]),
      el('a:t', [], ['{DATE}']),
    ]),
  ];
}

/** 一个显示"页码域"的 run（`a:fld type="slidenum"`）。 */
function slideNumberFieldRuns(): readonly XmlElement[] {
  return [
    el('a:fld', [attr('id', FIELD_ID_SLIDE_NUMBER), attr('type', 'slidenum')], [
      el('a:rPr', [attr('lang', 'zh-CN'), attr('dirty', '0')]),
      el('a:t', [], ['‹#›']),
    ]),
  ];
}

function plainRunXml(text: string): XmlElement {
  return el('a:r', [], [el('a:rPr', [attr('lang', 'zh-CN'), attr('dirty', '0')]), el('a:t', [], [text])]);
}

/** 页码起始：`p:ph type="sldNum"` 的占位符 id 从 100 起（与内容对象区分开）。 */
const FOOTER_SHAPE_BASE_ID = 100;

/**
 * 渲染一页的页脚 / 日期 / 页码占位符（`p:sp` 片段拼接，无 XML 声明）。
 *
 * 日期与页码写的是**域**，不是字面量——换页或跨天不会遗留错误数据。
 */
export function renderFooterShapesXml(
  config: SlideFooterConfig,
  slideNumber: number,
  slideSize: { readonly cx_emu: number; readonly cy_emu: number },
): string {
  if (!Number.isSafeInteger(slideNumber) || slideNumber < 1) {
    throw new AnnotationError('unknown_slide', `页码必须是 ≥ 1 的整数，收到 ${String(slideNumber)}`);
  }
  const slots = footerSlots(slideSize.cx_emu);
  const y = slideSize.cy_emu - FOOTER_MARGIN_EMU - FOOTER_HEIGHT_EMU;
  const fragments: string[] = [];
  if (config.show_date) {
    fragments.push(
      serializeXmlNode(placeholderShapeXml(FOOTER_SHAPE_BASE_ID, 'Date Placeholder', 'dt', slots.date, y, dateFieldRuns())),
    );
  }
  if (config.footer_text !== null) {
    fragments.push(
      serializeXmlNode(
        placeholderShapeXml(FOOTER_SHAPE_BASE_ID + 1, 'Footer Placeholder', 'ftr', slots.footer, y, [
          plainRunXml(config.footer_text),
        ]),
      ),
    );
  }
  if (config.show_slide_number) {
    fragments.push(
      serializeXmlNode(
        placeholderShapeXml(FOOTER_SHAPE_BASE_ID + 2, 'Slide Number Placeholder', 'sldNum', slots.number, y, [
          ...slideNumberFieldRuns(),
        ]),
      ),
    );
  }
  return fragments.join('');
}

// ---------------------------------------------------------------------------
// 演讲备注（PPT-10）
// ---------------------------------------------------------------------------

/** 由备注文本体读回纯文本（段落之间用 `\n`，run 之间直接相接）。 */
export function speakerNotesText(notes: TextBody | null): string {
  if (notes === null) return '';
  return notes.paragraphs
    .map((paragraph) =>
      paragraph.runs
        .map((run) => (run.source.kind === 'literal' ? run.source.text : `{${run.source.fact_key}}`))
        .join(''),
    )
    .join('\n');
}

/**
 * 多行纯文本 → `TextBody`（按 `\n` 拆段）。是 `setSpeakerNotes` 与部件层
 * `annotations/note-parts.ts`（导入后增 / 删备注部件）**共用**的同一构造口径。
 */
export function notesTextBody(text: string): TextBody {
  const lines = text.split('\n');
  return Object.freeze({
    paragraphs: Object.freeze(
      lines.map((line) =>
        Object.freeze({
          runs: literalText(line).paragraphs[0]!.runs,
          level: 0,
          alignment: 'left' as const,
          bullet: false,
        }),
      ),
    ),
  });
}

/**
 * 设置演讲备注：多行文本按 `\n` 拆成多个段落；`null` 清除。
 *
 * 复用 `operations.setSlideNotes`（模型层语义：`null` 清除备注）。
 */
export function setSpeakerNotes(presentation: Presentation, slideId: number, text: string | null): Presentation {
  if (text === null) {
    return setSlideNotes(presentation, slideId, null);
  }
  return setSlideNotes(presentation, slideId, notesTextBody(text));
}

/** 渲染备注部件（`ppt/notesSlides/notesSlideN.xml`）；复用 `render.ts` 的同一口径。 */
export function renderSpeakerNotesPartXml(notes: TextBody): string {
  return renderNotesPartXml(notes);
}

// ---------------------------------------------------------------------------
// 备注母版：首个 notesMaster 的创建（模型 / 描述符层）
// ---------------------------------------------------------------------------
//
// 背景：`import.ts` 的 `linkSlideNotes` 要求 `ppt/_rels/presentation.xml.rels` 里**已有**一条
// 指向 notesMaster 的内部关系，否则抛 `unknown_notes_master`——于是"给一份**本来没有备注母版**的
// 文稿挂第一条备注"是做不到的。本层给出该场景所需的**全部零件**（母版部件 XML、`p:notesMasterIdLst`
// 片段、关系描述符、创建计划），由持有包写权的接线方（`import.linkSlideNotes` / 包装配器 /
// `annotations/note-parts.ts`）落进真实字节：`notes.ts` 是模型层，**不**自行重建整包的 `_rels`。
//
// "已有母版就复用、没有才造"这件事由 `planNotesMasterProvision` 用**调用方读到的包状态**判定，
// 因此本层保持纯函数、可确定复现。

/** 首个备注母版部件路径（包内已有其它 notesMaster 时直接复用，不再造）。 */
export const NOTES_MASTER_PART_PATH = 'ppt/notesMasters/notesMaster1.xml';
/** 备注母版关系类型（`ppt/_rels/presentation.xml.rels` 用它指向母版部件）。 */
export const REL_NOTES_MASTER =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster';
/** 备注母版关系 `Target`（相对 `ppt/` 目录，即 `ppt/presentation.xml` 所在目录）。 */
export const NOTES_MASTER_REL_TARGET = 'notesMasters/notesMaster1.xml';
/** 备注母版内容类型（写进 `[Content_Types].xml` 的 `Override`）。 */
export const CT_NOTES_MASTER =
  'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml';

/** notesMaster 的 `p:spTree` 必需前导（`p:nvGrpSpPr` + `p:grpSpPr`，全零变换）。 */
function notesMasterShapeTreePreamble(): readonly XmlElement[] {
  return [
    el('p:nvGrpSpPr', [], [
      el('p:cNvPr', [attr('id', '1'), attr('name', '')]),
      el('p:cNvGrpSpPr'),
      el('p:nvPr'),
    ]),
    el('p:grpSpPr', [], [
      el('a:xfrm', [], [
        el('a:off', [attr('x', '0'), attr('y', '0')]),
        el('a:ext', [attr('cx', '0'), attr('cy', '0')]),
        el('a:chOff', [attr('x', '0'), attr('y', '0')]),
        el('a:chExt', [attr('cx', '0'), attr('cy', '0')]),
      ]),
    ]),
  ];
}

/**
 * 渲染一份**最小合法** `p:notesMaster` 部件（带 XML 声明）——包内原本没有备注母版时首次创建所用。
 *
 * 只给必须的 `p:cSld/p:spTree` 与 `p:clrMap`（颜色映射齐全），与 `annotations/note-parts.ts`
 * 的创建口径一致；**已有母版时不要调用**（应复用既有的，别造第二份）。
 */
export function renderNotesMasterPartXml(): string {
  return serializeXmlDocument(
    el('p:notesMaster', [attr('xmlns:a', NS_A), attr('xmlns:r', NS_R), attr('xmlns:p', NS_P)], [
      el('p:cSld', [], [el('p:spTree', [], [...notesMasterShapeTreePreamble()])]),
      el('p:clrMap', [
        attr('bg1', 'lt1'),
        attr('tx1', 'dk1'),
        attr('bg2', 'lt2'),
        attr('tx2', 'dk2'),
        attr('accent1', 'accent1'),
        attr('accent2', 'accent2'),
        attr('accent3', 'accent3'),
        attr('accent4', 'accent4'),
        attr('accent5', 'accent5'),
        attr('accent6', 'accent6'),
        attr('hlink', 'hlink'),
        attr('folHlink', 'folHlink'),
      ]),
    ]),
  );
}

/**
 * `p:notesMasterIdLst` 片段（插进 `ppt/presentation.xml` 的 `p:sldIdLst` 之前）。
 *
 * 无 XML 声明（这是片段，不是独立部件）；`relId` 必须是该母版在
 * `ppt/_rels/presentation.xml.rels` 里的关系 id。
 */
export function notesMasterIdListXml(relId: string): string {
  if (relId.trim() === '') {
    throw new AnnotationError('invalid_notes_master', 'notesMasterIdLst 的关系 id 不能为空');
  }
  return serializeXmlNode(
    el('p:notesMasterIdLst', [], [el('p:notesMasterId', [attr('r:id', relId)])]),
  );
}

/**
 * 把 `p:notesMasterIdLst` 插到 `ppt/presentation.xml` 文本里 `p:sldIdLst` 之前。
 *
 * - 已有 `p:notesMasterIdLst` ⇒ **原样返回**（不重复插入）；
 * - 缺 `p:sldIdLst` ⇒ 具名报错（定位不到插入点，不猜）。
 */
export function ensureNotesMasterIdList(presentationXml: string, relId: string): string {
  if (/<p:notesMasterIdLst\b/.test(presentationXml)) return presentationXml;
  if (!/<p:sldIdLst\b/.test(presentationXml)) {
    throw new AnnotationError(
      'invalid_notes_master',
      'ppt/presentation.xml 里没有 p:sldIdLst，无法定位 notesMasterIdLst 的插入点',
    );
  }
  return presentationXml.replace('<p:sldIdLst', `${notesMasterIdListXml(relId)}<p:sldIdLst`);
}

/** 调用方读到的包状态（用于判定要不要造备注母版）。 */
export interface NotesMasterState {
  /** 包内已有的备注母版部件路径；没有 ⇒ `null`。 */
  readonly existing_master_path: string | null;
  /** `ppt/_rels/presentation.xml.rels` 是否**已有** `…/notesMaster` 内部关系。 */
  readonly has_relationship: boolean;
  /** `ppt/presentation.xml` 是否**已有** `p:notesMasterIdLst`。 */
  readonly has_id_list: boolean;
}

/** 备注母版的创建计划：缺什么补什么，已有的不动。 */
export interface NotesMasterProvision {
  /** 直接复用既有母版（不造新部件）。 */
  readonly reuse: boolean;
  readonly part_path: string;
  readonly create_part: boolean;
  /** 需要新建时给出的母版部件 XML；复用既有 ⇒ `null`。 */
  readonly part_xml: string | null;
  readonly content_type: string;
  readonly add_relationship: boolean;
  readonly relationship_type: string;
  /** 关系 `Target`（相对 `ppt/` 目录）。 */
  readonly relationship_target: string;
  readonly add_id_list: boolean;
  /** 需要补 `p:notesMasterIdLst` 时的片段；已有 ⇒ `null`。 */
  readonly id_list_xml: string | null;
}

/**
 * 由包状态推出"首次创建 / 复用备注母版"的完整计划（纯函数）。
 *
 * `relId` = 该母版在 `ppt/_rels/presentation.xml.rels` 里的关系 id——缺关系时由调用方按
 * "既有最大 rId + 1"分配，缺 `notesMasterIdLst` 但它引用的关系已存在时传那个**既有** id。
 *
 * @throws {AnnotationError} `invalid_notes_master`——状态自相矛盾（无部件却有关系）、
 *   或该补东西却没给关系 id。
 */
export function planNotesMasterProvision(state: NotesMasterState, relId: string): NotesMasterProvision {
  const createPart = state.existing_master_path === null;
  if (createPart && state.has_relationship) {
    throw new AnnotationError(
      'invalid_notes_master',
      '状态自相矛盾：包内没有备注母版部件，却已存在指向它（不存在）的 notesMaster 关系',
    );
  }
  const addRelationship = !state.has_relationship;
  const addIdList = !state.has_id_list;
  if ((addRelationship || addIdList) && relId.trim() === '') {
    throw new AnnotationError('invalid_notes_master', '需要登记关系 / notesMasterIdLst 时必须给出关系 id');
  }
  const partPath = state.existing_master_path ?? NOTES_MASTER_PART_PATH;
  return Object.freeze({
    reuse: !createPart,
    part_path: partPath,
    create_part: createPart,
    part_xml: createPart ? renderNotesMasterPartXml() : null,
    content_type: CT_NOTES_MASTER,
    add_relationship: addRelationship,
    relationship_type: REL_NOTES_MASTER,
    relationship_target: partPath.startsWith('ppt/') ? partPath.slice('ppt/'.length) : partPath,
    add_id_list: addIdList,
    id_list_xml: addIdList ? notesMasterIdListXml(relId) : null,
  });
}

// ---------------------------------------------------------------------------
// 批注（PPT-10）
// ---------------------------------------------------------------------------

/** 一条批注。`slide_id` = 批注挂在哪张幻灯片上（按 id，不按页序）。 */
export interface SlideComment {
  readonly comment_id: string;
  readonly slide_id: number;
  readonly author_id: string;
  readonly author_name: string;
  readonly text: string;
  /** ISO 8601 时刻（写作时刻，不是"现在"——本层不读时钟，保持纯函数）。 */
  readonly created_iso: string;
  readonly x_emu: number;
  readonly y_emu: number;
}

/** 由批注集合按**首现顺序**导出作者表（`p:cmAuthorLst` 的输入）。 */
export function commentAuthorsOf(comments: readonly SlideComment[]): readonly { id: string; name: string }[] {
  const seen = new Set<string>();
  const authors: { id: string; name: string }[] = [];
  for (const comment of comments) {
    if (!seen.has(comment.author_id)) {
      seen.add(comment.author_id);
      authors.push({ id: comment.author_id, name: comment.author_name });
    }
  }
  return authors;
}

/** 取某页的批注（按 `slide_id`）。 */
export function commentsForSlide(comments: readonly SlideComment[], slideId: number): readonly SlideComment[] {
  return comments.filter((comment) => comment.slide_id === slideId);
}

/** 单条批注校验：文本不能为空、作者必须出现在作者表里。 */
export function validateComment(comment: SlideComment, authors: readonly { id: string }[]): void {
  if (comment.text.trim() === '') {
    throw new AnnotationError('empty_comment_text', `批注 ${comment.comment_id} 文本为空（不许留空批注）`);
  }
  if (!authors.some((author) => author.id === comment.author_id)) {
    throw new AnnotationError('unknown_author', `批注 ${comment.comment_id} 的作者 ${comment.author_id} 不在作者表里`);
  }
}

/**
 * 渲染批注部件（`ppt/comments/commentN.xml`）——**真实 XML**，不是描述文字。
 *
 * `authorId` 是作者在作者表里的下标；`idx` 是该页内的 1 起序号。
 */
export function renderCommentsPartXml(
  comments: readonly SlideComment[],
  authors: readonly { id: string }[],
): string {
  const root = el('p:cmLst', [attr('xmlns:a', NS_A), attr('xmlns:p', NS_P)], [
    ...comments.map((comment, index) => {
      const authorId = authors.findIndex((author) => author.id === comment.author_id);
      return el('p:cm', [
        attr('authorId', formatInteger(authorId)),
        attr('dt', comment.created_iso),
        attr('idx', formatInteger(index + 1)),
      ], [
        el('p:pos', [
          attr('x', formatInteger(comment.x_emu)),
          attr('y', formatInteger(comment.y_emu)),
        ]),
        el('p:text', [], [comment.text]),
      ]);
    }),
  ]);
  return serializeXmlDocument(root);
}

/**
 * 渲染批注作者部件（`ppt/commentAuthors.xml`）。
 *
 * `lastIdx` / `clrIdx` 由该作者在当前集合里的批注条数推出（不写死）。
 */
export function renderCommentAuthorsPartXml(
  comments: readonly SlideComment[],
): string {
  const authors = commentAuthorsOf(comments);
  const root = el('p:cmAuthorLst', [attr('xmlns:a', NS_A), attr('xmlns:p', NS_P)], [
    ...authors.map((author, index) => {
      const count = comments.filter((comment) => comment.author_id === author.id).length;
      return el('p:cmAuthor', [
        attr('id', formatInteger(index)),
        attr('name', author.name),
        attr('initials', author.name.slice(0, 1)),
        attr('lastIdx', formatInteger(count)),
        attr('clrIdx', '0'),
      ]);
    }),
  ]);
  return serializeXmlDocument(root);
}

// ---------------------------------------------------------------------------
// 注解容器与"不指向失效页面"的收敛（PPT-10 的核心语义）
// ---------------------------------------------------------------------------

/** 挂在某页某个对象上的链接注册项。 */
export interface SlideHyperlink {
  /** 承载链接的幻灯片。 */
  readonly slide_id: number;
  /** 承载链接的对象。 */
  readonly shape_id: number;
  readonly rel_id: string;
  readonly target: HyperlinkTarget;
}

/** 与 `Presentation` 并列的注解容器（不可变）。 */
export interface Annotations {
  readonly footer: SlideFooterConfig;
  readonly comments: readonly SlideComment[];
  readonly links: readonly SlideHyperlink[];
}

/** 空注解容器。 */
export function emptyAnnotations(): Annotations {
  return Object.freeze({ footer: NO_FOOTER, comments: Object.freeze([]), links: Object.freeze([]) });
}

/** 被剔除的项 + 原因（"不静默吞掉"）。 */
export interface DroppedComment {
  readonly item: SlideComment;
  readonly reason: 'slide_missing' | 'empty_text';
}

export interface DroppedLink {
  readonly item: SlideHyperlink;
  readonly reason: 'carrier_slide_missing' | 'target_slide_missing';
}

/** 收敛结果：保留下来的注解 + 被剔除项（具名原因）。 */
export interface AnnotationReconciliation {
  readonly annotations: Annotations;
  readonly dropped_comments: readonly DroppedComment[];
  readonly dropped_links: readonly DroppedLink[];
}

/**
 * 页集合变化后**收敛注解**（PPT-10「更新不会指向失效页面或遗留错误数据」）。
 *
 * 剔除：
 * - 挂在**已不存在的页**上的批注（`slide_missing`）；
 * - 文本为空的批注（`empty_text`，空批注是错误数据）；
 * - 承载页已删除的链接（`carrier_slide_missing`）；
 * - 内部跳转目标页已删除的链接（`target_slide_missing`）——**这是"指向失效页面"的正解**；
 *   剔除而不是留在产物里让消费端点开报错。
 *
 * 纯函数：入参 `annotations` 不被修改（被剔项仍原样留在入参里，供调用方回报审阅）。
 */
export function reconcileAnnotations(
  annotations: Annotations,
  presentation: Presentation,
): AnnotationReconciliation {
  const liveSlideIds = new Set(presentation.slides.map((slide) => slide.slide_id));
  const dropped_comments: DroppedComment[] = [];
  const comments: SlideComment[] = [];
  for (const comment of annotations.comments) {
    if (!liveSlideIds.has(comment.slide_id)) {
      dropped_comments.push({ item: comment, reason: 'slide_missing' });
      continue;
    }
    if (comment.text.trim() === '') {
      dropped_comments.push({ item: comment, reason: 'empty_text' });
      continue;
    }
    comments.push(comment);
  }

  const dropped_links: DroppedLink[] = [];
  const links: SlideHyperlink[] = [];
  for (const link of annotations.links) {
    if (!liveSlideIds.has(link.slide_id)) {
      dropped_links.push({ item: link, reason: 'carrier_slide_missing' });
      continue;
    }
    if (link.target.kind === 'slide' && !liveSlideIds.has(link.target.slide_id)) {
      dropped_links.push({ item: link, reason: 'target_slide_missing' });
      continue;
    }
    links.push(link);
  }

  return Object.freeze({
    annotations: Object.freeze({
      footer: annotations.footer,
      comments: Object.freeze(comments),
      links: Object.freeze(links),
    }),
    dropped_comments: Object.freeze(dropped_comments),
    dropped_links: Object.freeze(dropped_links),
  });
}

/**
 * **只查不改**的失效链接报告（用于"先告诉用户再决定"的场景）。
 *
 * 与 `reconcileAnnotations` 互补：本函数不产出新容器，只列出当前指向已删页/承载页已删的链接。
 */
export function findDeadLinks(
  annotations: Annotations,
  presentation: Presentation,
): readonly DroppedLink[] {
  return reconcileAnnotations(annotations, presentation).dropped_links;
}

// ---------------------------------------------------------------------------
// 批注**登记册**（模型层）：登记 / 撤销 / 改挂 / 收敛
// ---------------------------------------------------------------------------
//
// 上面那组函数把批注当**数组**处理（一次性渲染 / 校验）。包级批注层（`annotations/comment-parts.ts`，
// 集成增量 I06）要的是"批注身份 + 作者表"在多次增删之间保持一致：一条批注有自己的 `comment_id`，
// 作者按 `author_id` 归并（**同一 id 不许出现两个名字**），改挂/删除后**不残留**指向已不存在的
// 页面的批注。本登记册就是那一层所依赖的模型层：把数组收成一本**不可变**册子，并在册子上给出
// 登记 / 撤销 / 改挂 / 收敛四个纯操作。
//
// 作者表 `authors` 由批注列表**按首现顺序导出**（与 `commentAuthorsOf` 同一口径），因此
// "某作者的批注全被删掉后作者是否还在册里"没有二义：作者随批注走，不残留孤儿作者。

/** 登记册里的一位作者（`id` 与批注的 `author_id` 对应）。 */
export interface CommentAuthor {
  readonly id: string;
  readonly name: string;
}

/** 批注登记册（不可变）：批注列表 + 由它导出的作者表。 */
export interface CommentRegister {
  readonly comments: readonly SlideComment[];
  /** 作者表（按批注首现顺序导出；`id` 唯一、同名同 id 才可并存）。 */
  readonly authors: readonly CommentAuthor[];
}

/**
 * 由批注列表登记出一本册子（校验：id 不重复、文本非空、作者 id/名称非空、同一作者名一致）。
 *
 * @throws {AnnotationError} `duplicate_comment_id` / `empty_comment_text` / `invalid_author` /
 *   `author_name_conflict`。
 */
export function commentRegisterOf(comments: readonly SlideComment[]): CommentRegister {
  const seenIds = new Set<string>();
  const nameById = new Map<string, string>();
  for (const comment of comments) {
    if (seenIds.has(comment.comment_id)) {
      throw new AnnotationError('duplicate_comment_id', `批注 id 重复：${comment.comment_id}`);
    }
    seenIds.add(comment.comment_id);
    if (comment.text.trim() === '') {
      throw new AnnotationError('empty_comment_text', `批注 ${comment.comment_id} 文本为空（不许留空批注）`);
    }
    if (comment.author_id.trim() === '' || comment.author_name.trim() === '') {
      throw new AnnotationError('invalid_author', `批注 ${comment.comment_id} 的作者 id / 名称不能为空`);
    }
    const known = nameById.get(comment.author_id);
    if (known !== undefined && known !== comment.author_name) {
      throw new AnnotationError(
        'author_name_conflict',
        `作者 ${comment.author_id} 出现两个名字：${known} / ${comment.author_name}`,
      );
    }
    nameById.set(comment.author_id, comment.author_name);
  }
  const authors = commentAuthorsOf(comments).map((author) => Object.freeze({ id: author.id, name: author.name }));
  return Object.freeze({ comments: Object.freeze([...comments]), authors: Object.freeze(authors) });
}

/** 空登记册。 */
export function emptyCommentRegister(): CommentRegister {
  return Object.freeze({ comments: Object.freeze([]), authors: Object.freeze([]) });
}

/**
 * 登记一条批注（校验走 `commentRegisterOf` 的同一口径：id 重复 / 空文本 / 作者冲突都具名报错）。
 *
 * 纯函数：入参册子不被就地改。
 */
export function registerComment(register: CommentRegister, comment: SlideComment): CommentRegister {
  return commentRegisterOf([...register.comments, comment]);
}

/** 撤销一条批注（按 `comment_id`）。找不到 ⇒ `unknown_comment_id`（不静默）。 */
export function unregisterComment(register: CommentRegister, commentId: string): CommentRegister {
  if (!register.comments.some((comment) => comment.comment_id === commentId)) {
    throw new AnnotationError('unknown_comment_id', `登记册里没有批注 ${commentId}`);
  }
  return commentRegisterOf(register.comments.filter((comment) => comment.comment_id !== commentId));
}

/** 撤销挂在某页上的**全部**批注（删页时用；该页本就没有批注 ⇒ 原样返回、幂等）。 */
export function unregisterCommentsForSlide(register: CommentRegister, slideId: number): CommentRegister {
  const kept = register.comments.filter((comment) => comment.slide_id !== slideId);
  return kept.length === register.comments.length ? register : commentRegisterOf(kept);
}

/** 把一条批注改挂到另一页（按 `comment_id` 定位）。找不到 ⇒ `unknown_comment_id`。 */
export function retargetComment(
  register: CommentRegister,
  commentId: string,
  slideId: number,
): CommentRegister {
  let found = false;
  const next = register.comments.map((comment) => {
    if (comment.comment_id !== commentId) return comment;
    found = true;
    return Object.freeze({ ...comment, slide_id: slideId });
  });
  if (!found) {
    throw new AnnotationError('unknown_comment_id', `登记册里没有批注 ${commentId}`);
  }
  return commentRegisterOf(next);
}

/** 登记册收敛结果：保留下来的册子 + 被剔除项（具名原因，复用 `DroppedComment`）。 */
export interface CommentReconciliation {
  readonly register: CommentRegister;
  readonly dropped: readonly DroppedComment[];
}

/**
 * 页集合变化后**收敛登记册**——语义与 `reconcileAnnotations` 的批注侧**完全一致**（本函数内部就是
 * 把册子交给 `reconcileAnnotations`，再投影回登记册），因此两者不会漂移：
 *
 * - 挂在已删页上的批注 ⇒ `slide_missing`；
 * - 文本为空的批注 ⇒ `empty_text`。
 *
 * 纯函数：入参册子不被就地改。
 */
export function reconcileCommentRegister(
  register: CommentRegister,
  presentation: Presentation,
): CommentReconciliation {
  const base = reconcileAnnotations(
    { footer: NO_FOOTER, comments: register.comments, links: [] },
    presentation,
  );
  return Object.freeze({
    register: commentRegisterOf(base.annotations.comments),
    dropped: base.dropped_comments,
  });
}

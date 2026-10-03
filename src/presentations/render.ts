/**
 * 演示域**渲染层**：模型 → PPTX 字节（design-06 P9 / PPT-01–16）。
 *
 * ## 与既有窄入口的关系
 *
 * `src/artifacts/templates/pptx.ts` 的 `buildPresentation` 是**固定两页纯文本**的窄口，
 * 其字节被 golden 常量钉死（`pptx.test.ts` / `v1-ooxml-templates.test.ts`），因此
 * **一行都不改**。本模块是它的一般化后继：页数由模型决定（PPT-01），对象是可编辑的
 * DrawingML 元素（PPT-07），部件链复用同一套 `src/artifacts/ooxml` 原语与同一份主题
 * （`themeXml` / `renderFactValue` 从 pptx.ts 复用）。
 *
 * ## 确定性
 *
 * 无 `node:fs`、无 `Date`、无 `Math.random`、无 `process.*`；XML 由 `el`/`attr` 显式构造，
 * 属性顺序即传入顺序；数字只经 `formatInteger`。同一模型连跑两次 ⇒ 逐字节相等。
 *
 * ## 已接线 / 未渲染（显式报错，不静默丢弃）
 *
 * **已接线**（FA-PPT-WIRE，把"模型层有、导出发不出"的三处接到渲染链）：
 *
 * 1. 隐藏页 ⇒ `p:sld@show="0"`（`Slide.hidden`；导入侧本就读回 ⇒ 往返不丢）；
 * 2. 段落行距 / 显式缩进 ⇒ `a:lnSpc`（`a:spcPct` / `a:spcPts`）与 `a:pPr@marL`
 *    （`text.ts` 挂在 `Paragraph` 上的扩展字段 `line_spacing` / `indent_emu`）；
 * 3. 合并单元格表格 ⇒ `a:gridSpan` / `a:rowSpan` / `a:hMerge` / `a:vMerge`
 *    （经 `tables.planTableGrid` 规划），以及 `slide → chart → embedded workbook`
 *    的完整图表部件图（`charts.buildChartParts`：图表部件 + 嵌入工作簿 + 关系 + 内容类型）。
 *
 * **已接线**（P-I01 集成波，把 P04/P05/P08 的模块接到最终产物）：
 *
 * 4. 对象动画 ⇒ 幻灯片内联 `p:timing`（`animation.renderSlideTimingXml` 造块、
 *    `timing-parts.inject.applyTimingDescriptor` 按 `CT_Slide` 顺序插到 `p:transition` 之后）；
 * 5. 连接符端点绑定 ⇒ `p:cNvCxnSpPr` 里的 `a:stCxn` / `a:endCxn`（`id` = 被连形状 id）；
 * 6. 含 `media` 形状的文稿 ⇒ 整份交给 `media-parts.assembleAvMediaPackage`（占位替换 + 真实
 *    音视频片段 + 关系 + 放映时间 + 包级读回校验），需 `options.av_board` 提供旁表；
 *    媒体部件内容类型只走扩展名 `Default`（不再重复写部件 `Override`）。
 *
 * **这些改动只在新输入出现时才改变输出**：页不隐藏 / 段落无行距与缩进 / 表格无合并 /
 * 无图表 / 无动画 / 连接符无端点 / 无 `media` 形状时，产物与接线前**逐字节相同**
 * （既有 golden 不变，见 `roundtrip.test.ts`）。
 * 合并结构与网格对不上（span 越界 / 延续格又带 span / 行格数与列数不符）⇒ 仍显式报错
 * （`unsupported_merge_span`），不产出半张表。
 *
 * **仍未渲染**：多媒体母版（一个文稿多套母版）⇒ `multi_master_unsupported`；含 `media`
 * 形状但**未提供** `av_board` ⇒ 逐页渲染报 `unsupported_shape_kind`——**绝不**降级成截图或静默跳过。
 *
 * ## 真机 / Office 播放**未验证**
 *
 * 本工作包只做字节级 + 解析级校验（`verifyChartPackage` / XML 读回）；**没有**在真机
 * PowerPoint / WPS 或桌面 Office 里打开本产物验证播放效果——如实标 **未验证**。
 */

import {
  CONTENT_TYPES_PART_PATH,
  RELATIONSHIPS_CONTENT_TYPE,
  assembleOpcPackage,
  attr,
  contentTypesElement,
  el,
  formatInteger,
  relationshipIdAt,
  serializeXmlDocument,
  writeZip,
  type AssembledOpcPackage,
  type ContentTypeDefault,
  type OpcPart,
  type RelationshipDeclaration,
  type RelationshipGroup,
  type XmlElement,
} from '../artifacts/ooxml/index.js';
import { digestBytes } from '../artifacts/digest.js';
import { renderFactValue, themeXml } from '../artifacts/templates/pptx.js';
import { ValidationError } from '../protocol/index.js';

import { renderSlideTimingXml } from './animation.js';
import type { AvMediaBoard } from './av-media.js';
import {
  NO_CHART_OPTIONS,
  buildChartParts,
  chartOptionsOf,
  chartSlideRelationship,
  type ChartOptionMap,
} from './charts.js';
import type { MediaCatalog } from './media.js';
import { assembleAvMediaPackage } from './media-parts/av-package.js';
import { indentEmuOf, lineSpacingOf, type LineSpacing } from './text.js';
import { planTableGrid, type PlannedCell } from './tables.js';
import { applyTimingDescriptor } from './timing-parts/inject.js';

import {
  resolveRunText,
  type FactSnapshot,
  type Fill,
  type Outline,
  type Paragraph,
  type Presentation,
  type Shape,
  type Slide,
  type TextBody,
  type Transform,
} from './model.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';

/** `a:graphicData@uri`：图表帧（PPT-09）。 */
const CHART_GRAPHIC_DATA_URI = 'http://schemas.openxmlformats.org/drawingml/2006/chart';

/** 表格统一行高（`a:tr@h`）；与 `tables.DEFAULT_ROW_HEIGHT_EMU` 同值。 */
const TABLE_ROW_HEIGHT_EMU = 457200;

const REL_OFFICE_DOCUMENT =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const REL_SLIDE_MASTER =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster';
const REL_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const REL_SLIDE_LAYOUT =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout';
const REL_THEME = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme';
const REL_NOTES_SLIDE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';
const REL_NOTES_MASTER =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster';
const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

const CT_PRESENTATION =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const CT_SLIDE_MASTER =
  'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml';
const CT_SLIDE_LAYOUT =
  'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml';
const CT_SLIDE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const CT_NOTES_SLIDE =
  'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';
const CT_NOTES_MASTER =
  'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml';
const CT_THEME = 'application/vnd.openxmlformats-officedocument.theme+xml';

const MASTER_ID = 2147483648;
const FIRST_LAYOUT_ID = 2147483649;
const FIRST_SLIDE_ID = 256;

const NOTES_WIDTH_EMU = 6858000;
const NOTES_HEIGHT_EMU = 9144000;

const NOTES_BOX = { x: 838200, y: 457200, cx: 7772400, cy: 3076575 } as const;

/** 媒体扩展名 → 内容类型（图片与常见音视频）。未知扩展名 ⇒ 报错，不猜。 */
const MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
});

const RELATIONSHIPS_DEFAULT: ContentTypeDefault = Object.freeze({
  extension: 'rels',
  content_type: RELATIONSHIPS_CONTENT_TYPE,
});

// ---------------------------------------------------------------------------
// 输入 / 输出
// ---------------------------------------------------------------------------

/** 包内媒体部件（图片 / 音视频）。渲染时按 `path` 放进包，幻灯片以关系引用它。 */
export interface PresentationMediaPart {
  /** 包内路径，如 `ppt/media/image1.png`。 */
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** 渲染选项。 */
export interface RenderPresentationOptions {
  /** 事实快照：求值文本里的 `fact` 引用（缺失 ⇒ 占位，见 `resolveRunText`）。 */
  readonly fact_snapshot?: FactSnapshot;
  /** 媒体部件（图片等）。引用了未提供的媒体 ⇒ 报错，不静默跳过。 */
  readonly media?: readonly PresentationMediaPart[];
  /** 图表选项表（`shape_id` → 图例 / 样式 / 轴标题 / 数据标签）；缺省 = `DEFAULT_CHART_OPTIONS`。 */
  readonly chart_options?: ChartOptionMap;
  /**
   * 音视频旁表（PPT-12，P05 `AvMediaBoard`）。**仅在模型含 `media` 形状时需要**：
   * 提供时整份文稿改经 `assembleAvMediaPackage` 装配（占位替换 + 真实音视频片段 + 关系 +
   * 放映时间 + 包级读回校验），而不是逐页渲染报 `unsupported_shape_kind`；未提供时保持
   * 旧行为（含 `media` 形状的页具名报错，不静默丢弃）。媒体字节随 `media` 一并传入。
   */
  readonly av_board?: AvMediaBoard;
}

/** 渲染结果。 */
export interface RenderPresentationResult {
  readonly bytes: Buffer;
  readonly entry_count: number;
  readonly content_digest: string;
  /** 渲染出的**页数**（= 模型 `slides.length`，供 PPT-01 断言"页数由任务决定"）。 */
  readonly slide_count: number;
}

/** 渲染层错误原因。 */
export type PresentationRenderErrorReason =
  | 'unsupported_shape_kind'
  | 'unsupported_shape_id'
  | 'unsupported_merge_span'
  | 'multi_master_unsupported'
  | 'missing_media'
  | 'unknown_media_type'
  | 'empty_slide';

/** 渲染层错误：**接口上必须有**——凡未渲染的对象都经此报错，不静默丢弃。 */
export class PresentationRenderError extends ValidationError {
  readonly reason: PresentationRenderErrorReason;

  constructor(reason: PresentationRenderErrorReason, message: string) {
    super(message);
    this.name = 'PresentationRenderError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 通用片段
// ---------------------------------------------------------------------------

function groupShapeTreePreamble(): readonly XmlElement[] {
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

function xfrmXml(transform: Transform): XmlElement {
  const attrs = [
    attr('rot', formatInteger(Math.round(transform.rotation_deg * 60000))),
    ...(transform.flip_h ? [attr('flipH', '1')] : []),
    ...(transform.flip_v ? [attr('flipV', '1')] : []),
  ];
  return el('a:xfrm', attrs, [
    el('a:off', [attr('x', formatInteger(transform.x_emu)), attr('y', formatInteger(transform.y_emu))]),
    el('a:ext', [attr('cx', formatInteger(transform.cx_emu)), attr('cy', formatInteger(transform.cy_emu))]),
  ]);
}

function fillXml(fill: Fill): XmlElement {
  if (fill.kind === 'none') {
    return el('a:noFill');
  }
  return el('a:solidFill', [], [el('a:srgbClr', [attr('val', fill.color)])]);
}

function outlineXml(outline: Outline | null): XmlElement | null {
  if (outline === null || (outline.color === null && outline.width_emu === null)) {
    return null;
  }
  const attrs =
    outline.width_emu === null ? [] : [attr('w', formatInteger(outline.width_emu))];
  const children =
    outline.color === null
      ? [el('a:solidFill', [], [el('a:schemeClr', [attr('val', 'tx1')])])]
      : [el('a:solidFill', [], [el('a:srgbClr', [attr('val', outline.color)])])];
  return el('a:ln', attrs, children);
}

/**
 * 段落行距 → `a:lnSpc`（PPT-04）：倍数 → `a:spcPct@val`（百分比 ×1000），
 * 固定点数 → `a:spcPts@val`（磅 ×100）。`LineSpacing` 来自 `text.ts` 的模型层扩展字段。
 */
function lineSpacingXml(spacing: LineSpacing): XmlElement {
  return spacing.kind === 'percent'
    ? el('a:lnSpc', [], [el('a:spcPct', [attr('val', formatInteger(Math.round(spacing.value * 1000)))])])
    : el('a:lnSpc', [], [el('a:spcPts', [attr('val', formatInteger(Math.round(spacing.value * 100)))])]);
}

/** 段落 → `a:p`（PPT-04：对齐、缩进层级、行距 / 显式缩进、项目符号、字符样式）。 */
function textBodyXml(body: TextBody, snapshot: FactSnapshot): XmlElement {
  const paragraphs = body.paragraphs.map((paragraph) => paragraphXml(paragraph, snapshot));
  return el('p:txBody', [], [el('a:bodyPr', [attr('wrap', 'square')]), el('a:lstStyle'), ...paragraphs]);
}

const ALIGNMENT_TO_ATTR: Readonly<Record<Paragraph['alignment'], string | null>> = Object.freeze({
  left: null,
  center: 'ctr',
  right: 'r',
  justify: 'just',
});

function paragraphXml(paragraph: Paragraph, snapshot: FactSnapshot): XmlElement {
  const alignment = ALIGNMENT_TO_ATTR[paragraph.alignment];
  // 模型层扩展字段（`text.ts`）：普通段落读回 `null` ⇒ 不写这两个属性 / 子元素（既有字节不变）。
  const indentEmu = indentEmuOf(paragraph);
  const lineSpacing = lineSpacingOf(paragraph);
  const pPrAttrs = [
    ...(paragraph.level > 0 ? [attr('lvl', formatInteger(paragraph.level))] : []),
    ...(alignment === null ? [] : [attr('algn', alignment)]),
    ...(indentEmu === null ? [] : [attr('marL', formatInteger(indentEmu))]),
  ];
  // 子元素顺序须符合 CT_TextParagraphProperties：`a:lnSpc` 在 `a:buNone` 之前。
  const pPr = el('a:pPr', pPrAttrs, [
    ...(lineSpacing === null ? [] : [lineSpacingXml(lineSpacing)]),
    ...(paragraph.bullet ? [] : [el('a:buNone')]),
  ]);
  const runs = paragraph.runs.map((run) => {
    const text = resolveRunText(run.source, snapshot);
    const style = run.style;
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
    ];
    return el('a:r', [], [
      el('a:rPr', rPrAttrs, rPrChildren),
      el('a:t', [], [text]),
    ]);
  });
  return el('a:p', [], [pPr, ...runs]);
}

// ---------------------------------------------------------------------------
// 形状 → XML
// ---------------------------------------------------------------------------

/**
 * 渲染**单张幻灯片**时的上下文：事实快照 + 媒体关系 id 解析。
 *
 * 导出它是为了让「导入 → 编辑 → 写回」路径（`roundtrip.ts`）复用**同一份渲染口径**：
 * 被改过的那一页由它重新产出，媒体关系 id 由**该页原有的 `_rels`** 提供，
 * 而不是另造一套（另造就会与未改动的部件对不上）。
 */
export interface SlideRenderContext {
  readonly snapshot: FactSnapshot;
  readonly media_rel: (path: string) => string;
  /**
   * 图表形状 id → 该页 `_rels` 里指向图表部件的关系 id（PPT-09 接线）。
   *
   * **可选**：`roundtrip.ts` 的"重渲染被改页"路径不提供它（导入侧本就不接受图表形状），
   * 因此不提供时渲染到 `chart` 形状会报 `unsupported_shape_kind`，而不是写出一个空引用。
   */
  readonly chart_rel?: (shapeId: number) => string;
}

/** 兼容内部旧称（本文件内部使用）。 */
type ShapeContext = SlideRenderContext;

function assertShapeId(shapeId: number): void {
  // id 1 保留给 `p:spTree` 的组形状前导；0 与负数非法。
  if (!Number.isSafeInteger(shapeId) || shapeId < 2) {
    throw new PresentationRenderError(
      'unsupported_shape_id',
      `shape_id=${String(shapeId)} 非法：必须是 ≥ 2 的整数（1 保留给形状树前导）`,
    );
  }
}

/** `p:sp` 的非可视属性（自选图形用）。 */
function nonVisualShapeProperties(shape: Shape): XmlElement {
  return el('p:nvSpPr', [], [
    el('p:cNvPr', [attr('id', formatInteger(shape.shape_id)), attr('name', shape.name)]),
    el('p:cNvSpPr'),
    el('p:nvPr'),
  ]);
}

function shapeXml(shape: Shape, context: ShapeContext): XmlElement {
  assertShapeId(shape.shape_id);
  switch (shape.kind) {
    case 'text_box':
      return el('p:sp', [], [
        el('p:nvSpPr', [], [
          el('p:cNvPr', [attr('id', formatInteger(shape.shape_id)), attr('name', shape.name)]),
          el('p:cNvSpPr', [attr('txBox', '1')]),
          el('p:nvPr'),
        ]),
        el('p:spPr', [], [xfrmXml(shape.transform), el('a:prstGeom', [attr('prst', 'rect')], [el('a:avLst')])]),
        textBodyXml(shape.text, context.snapshot),
      ]);

    case 'auto_shape':
      return el('p:sp', [], [
        nonVisualShapeProperties(shape),
        el('p:spPr', [], [
          xfrmXml(shape.transform),
          el('a:prstGeom', [attr('prst', shape.preset)], [el('a:avLst')]),
          fillXml(shape.fill),
          ...(outlineXml(shape.outline) === null ? [] : [outlineXml(shape.outline) as XmlElement]),
        ]),
        ...(shape.text === null ? [el('p:txBody', [], [el('a:bodyPr'), el('a:lstStyle'), el('a:p')])]
          : [textBodyXml(shape.text, context.snapshot)]),
      ]);

    case 'connector':
      return el('p:cxnSp', [], [
        el('p:nvCxnSpPr', [], [
          el('p:cNvPr', [attr('id', formatInteger(shape.shape_id)), attr('name', shape.name)]),
          // 连接绑定：`a:stCxn` / `a:endCxn` 是 `p:cNvCxnSpPr` 的子元素（CT_NonVisualConnectorProperties），
          // `id` = 被连接形状的 `p:cNvPr@id`（非关系 id），`idx` = 连接点索引（模型未表达 ⇒ 0）。
          // 仅有端点时才写（未绑定 ⇒ 逐字节不变）。
          el('p:cNvCxnSpPr', [], [
            ...(shape.start_shape_id === null
              ? []
              : [el('a:stCxn', [attr('id', formatInteger(shape.start_shape_id)), attr('idx', '0')])]),
            ...(shape.end_shape_id === null
              ? []
              : [el('a:endCxn', [attr('id', formatInteger(shape.end_shape_id)), attr('idx', '0')])]),
          ]),
          el('p:nvPr'),
        ]),
        el('p:spPr', [], [
          xfrmXml(shape.transform),
          el('a:prstGeom', [attr('prst', shape.preset)], [el('a:avLst')]),
          ...(outlineXml(shape.outline) === null ? [el('a:ln', [], [el('a:solidFill', [], [el('a:schemeClr', [attr('val', 'tx1')])])])]
            : [outlineXml(shape.outline) as XmlElement]),
        ]),
      ]);

    case 'picture':
      return el('p:pic', [], [
        el('p:nvPicPr', [], [
          el('p:cNvPr', [
            attr('id', formatInteger(shape.shape_id)),
            attr('name', shape.name),
            attr('descr', shape.alt_text),
          ]),
          el('p:cNvPicPr'),
          el('p:nvPr'),
        ]),
        el('p:blipFill', [], [
          el('a:blip', [attr('r:embed', context.media_rel(shape.media_path))]),
          ...(shape.crop === null
            ? []
            : [
                el('a:srcRect', [
                  attr('l', formatInteger(shape.crop.l)),
                  attr('t', formatInteger(shape.crop.t)),
                  attr('r', formatInteger(shape.crop.r)),
                  attr('b', formatInteger(shape.crop.b)),
                ]),
              ]),
          el('a:stretch', [], [el('a:fillRect')]),
        ]),
        el('p:spPr', [], [xfrmXml(shape.transform), el('a:prstGeom', [attr('prst', 'rect')], [el('a:avLst')])]),
      ]);

    case 'table':
      return tableXml(shape);

    case 'group':
      return el('p:grpSp', [], [
        el('p:nvGrpSpPr', [], [
          el('p:cNvPr', [attr('id', formatInteger(shape.shape_id)), attr('name', shape.name)]),
          el('p:cNvGrpSpPr'),
          el('p:nvPr'),
        ]),
        el('p:grpSpPr', [], [
          el('a:xfrm', [], [
            el('a:off', [
              attr('x', formatInteger(shape.transform.x_emu)),
              attr('y', formatInteger(shape.transform.y_emu)),
            ]),
            el('a:ext', [
              attr('cx', formatInteger(shape.transform.cx_emu)),
              attr('cy', formatInteger(shape.transform.cy_emu)),
            ]),
            el('a:chOff', [attr('x', '0'), attr('y', '0')]),
            el('a:chExt', [
              attr('cx', formatInteger(shape.transform.cx_emu)),
              attr('cy', formatInteger(shape.transform.cy_emu)),
            ]),
          ]),
        ]),
        ...shape.children.map((child) => shapeXml(child, context)),
      ]);

    case 'chart': {
      const chartRelId = context.chart_rel?.(shape.shape_id);
      if (chartRelId === undefined) {
        throw new PresentationRenderError(
          'unsupported_shape_kind',
          `图表未接线（shape_id=${String(shape.shape_id)}）：渲染上下文未提供该页的图表关系（需 ` +
            '`renderPresentation` 建立的 slide→chart→embedded workbook 部件图）',
        );
      }
      return chartFrameXml(shape, chartRelId);
    }

    case 'media':
      throw new PresentationRenderError(
        'unsupported_shape_kind',
        `音视频渲染未实现（shape_id=${String(shape.shape_id)}）：需要真实媒体部件与封面，属后续增量`,
      );
  }
}

/** 表格是否含合并（任一格 `col_span`/`row_span` > 1）。 */
function tableHasMerge(shape: Extract<Shape, { kind: 'table' }>): boolean {
  return shape.rows.some((row) => row.cells.some((cell) => cell.col_span > 1 || cell.row_span > 1));
}

/**
 * 表格 → `p:graphicFrame`（PPT-08）。
 *
 * **无合并**时走与接线前**完全一致**的写法（逐格 `a:tc`，不写任何合并属性）⇒ 既有 golden 不变；
 * **有合并**时经 `tables.planTableGrid` 规划成 `gridSpan`/`rowSpan`/`hMerge`/`vMerge`。
 * 合并结构与网格对不上（span 越界 / 延续格又带 span / 行格数与列数不符）⇒ 报
 * `unsupported_merge_span`，不产出半张表（反向对照：span 越界仍必须抛错）。
 */
function tableXml(shape: Extract<Shape, { kind: 'table' }>): XmlElement {
  const columns = shape.column_widths_emu;
  const rows = shape.rows;
  const grid = el('a:tblGrid', [], columns.map((width) => el('a:gridCol', [attr('w', formatInteger(width))])));
  const trs = tableHasMerge(shape)
    ? mergedTableRows(shape)
    : rows.map((row) =>
        el('a:tr', [attr('h', formatInteger(TABLE_ROW_HEIGHT_EMU))], row.cells.map((cell) => tableCellXml(cell.text))),
      );
  return el('p:graphicFrame', [], [
    el('p:nvGraphicFramePr', [], [
      el('p:cNvPr', [attr('id', formatInteger(shape.shape_id)), attr('name', shape.name)]),
      el('p:cNvGraphicFramePr'),
      el('p:nvPr'),
    ]),
    el('p:xfrm', [], [
      el('a:off', [
        attr('x', formatInteger(shape.transform.x_emu)),
        attr('y', formatInteger(shape.transform.y_emu)),
      ]),
      el('a:ext', [
        attr('cx', formatInteger(shape.transform.cx_emu)),
        attr('cy', formatInteger(shape.transform.cy_emu)),
      ]),
    ]),
    el('a:graphic', [], [
      el('a:graphicData', [attr('uri', 'http://schemas.openxmlformats.org/drawingml/2006/table')], [
        el('a:tbl', [], [el('a:tblPr'), grid, ...trs]),
      ]),
    ]),
  ]);
}

function tableCellXml(text: TextBody | null): XmlElement {
  const body = text === null ? emptyCellBodyXml() : tableCellBodyXml(text);
  return el('a:tc', [], [body, el('a:tcPr')]);
}

/** 空单元格文本体（无文本 / 合并延续格）。 */
function emptyCellBodyXml(): XmlElement {
  return el('a:txBody', [], [el('a:bodyPr'), el('a:lstStyle'), el('a:p')]);
}

/** 有文本的单元格文本体（与接线前逐字节一致）。 */
function tableCellBodyXml(text: TextBody): XmlElement {
  return el('a:txBody', [], [
    el('a:bodyPr'),
    el('a:lstStyle'),
    ...text.paragraphs.map((paragraph) =>
      el('a:p', [], [
        ...paragraph.runs.map((run) =>
          el('a:r', [], [
            el('a:rPr', [attr('lang', 'zh-CN'), attr('dirty', '0')]),
            el('a:t', [], [resolveRunText(run.source, [])]),
          ]),
        ),
      ]),
    ),
  ]);
}

/**
 * 合并表格的逐行 `a:tr`（PPT-08）。网格规划交给 `tables.planTableGrid`（与操作层同一份口径）；
 * 规划失败（span 越界 / 网格不符）⇒ 报 `unsupported_merge_span`，不静默出半张表。
 */
function mergedTableRows(shape: Extract<Shape, { kind: 'table' }>): readonly XmlElement[] {
  let plan: readonly (readonly PlannedCell[])[];
  try {
    plan = planTableGrid(shape);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PresentationRenderError(
      'unsupported_merge_span',
      `表格合并结构无法渲染（shape_id=${String(shape.shape_id)}）：${detail}`,
    );
  }
  return shape.rows.map((_row, rowIndex) =>
    el('a:tr', [attr('h', formatInteger(TABLE_ROW_HEIGHT_EMU))], (plan[rowIndex] ?? []).map((cell) => mergedCellXml(cell))),
  );
}

/** 一个规划后的合并单元格 → `a:tc`（`gridSpan`/`rowSpan`/`hMerge`/`vMerge`）。 */
function mergedCellXml(cell: PlannedCell): XmlElement {
  const attrs = [
    ...(cell.grid_span > 1 ? [attr('gridSpan', formatInteger(cell.grid_span))] : []),
    ...(cell.row_span > 1 ? [attr('rowSpan', formatInteger(cell.row_span))] : []),
    ...(cell.h_merge ? [attr('hMerge', '1')] : []),
    ...(cell.v_merge ? [attr('vMerge', '1')] : []),
  ];
  const body =
    cell.h_merge || cell.v_merge || cell.text === null ? emptyCellBodyXml() : tableCellBodyXml(cell.text);
  return el('a:tc', attrs, [body, el('a:tcPr')]);
}

/** 图表形状 → `p:graphicFrame`（PPT-09）。`chartRelId` = 该页 `_rels` 里指向图表部件的关系 id。 */
function chartFrameXml(shape: Extract<Shape, { kind: 'chart' }>, chartRelId: string): XmlElement {
  const t = shape.transform;
  return el('p:graphicFrame', [attr('xmlns:c', NS_C)], [
    el('p:nvGraphicFramePr', [], [
      el('p:cNvPr', [attr('id', formatInteger(shape.shape_id)), attr('name', shape.name)]),
      el('p:cNvGraphicFramePr'),
      el('p:nvPr'),
    ]),
    el('p:xfrm', [], [
      el('a:off', [attr('x', formatInteger(t.x_emu)), attr('y', formatInteger(t.y_emu))]),
      el('a:ext', [attr('cx', formatInteger(t.cx_emu)), attr('cy', formatInteger(t.cy_emu))]),
    ]),
    el('a:graphic', [], [
      el('a:graphicData', [attr('uri', CHART_GRAPHIC_DATA_URI)], [el('c:chart', [attr('r:id', chartRelId)])]),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// 幻灯片 / 备注 / 母版 / 版式
// ---------------------------------------------------------------------------

function slideXml(slide: Slide, context: ShapeContext): string {
  const document = serializeXmlDocument(
    el('p:sld', [
      attr('xmlns:a', NS_A),
      attr('xmlns:r', NS_R),
      attr('xmlns:p', NS_P),
      // 隐藏页（PPT-02）：`p:sld@show="0"`。不隐藏 ⇒ 不写该属性（既有字节不变）。
      ...(slide.hidden ? [attr('show', '0')] : []),
    ], [
      el('p:cSld', [], [
        el('p:spTree', [], [
          ...groupShapeTreePreamble(),
          ...slide.shapes.map((shape) => shapeXml(shape, context)),
        ]),
      ]),
      el('p:clrMapOvr', [], [el('a:masterClrMapping')]),
      ...(slide.transition === null
        ? []
        : [
            el('p:transition', [attr('spd', 'med'), attr('dur', formatInteger(slide.transition.duration_ms))], [
              el(`p:${slide.transition.kind}`),
            ]),
          ]),
    ]),
  );
  // 对象动画（PPT-11）：模型有动画 ⇒ 把 `p:timing` 按 schema 位置（`p:transition` 之后、
  // `</p:sld>` 之前）注入幻灯片部件。无动画 ⇒ 不注入（既有字节不变）。
  if (slide.animations.length === 0) {
    return document;
  }
  return applyTimingDescriptor(document, { xml: renderSlideTimingXml(slide) });
}

/**
 * 渲染**单张幻灯片部件**的 XML 文本（与 `renderPresentation` 逐字节同一口径）。
 *
 * 这是本文件对 `roundtrip.ts` 的**唯一增量出口**：导入层要把"被改过的页"重新产出，
 * 必须与整份渲染用的是同一个函数，否则两条路径会分叉出两套字节。
 * 本函数是纯函数，不改变 `renderPresentation` 的任何行为。
 */
export function renderSlidePartXml(slide: Slide, context: SlideRenderContext): string {
  return slideXml(slide, context);
}

/**
 * 渲染**单个备注部件**的 XML 文本（与 `renderPresentation` 同一口径）。
 * 备注文本里的 `fact` 引用按**空快照**求值（备注不参与事实管线，与整份渲染一致）。
 */
export function renderNotesPartXml(notes: TextBody): string {
  return notesSlideXml(notes);
}

function notesSlideXml(notes: TextBody): string {
  return serializeXmlDocument(
    el('p:notes', [attr('xmlns:a', NS_A), attr('xmlns:r', NS_R), attr('xmlns:p', NS_P)], [
      el('p:cSld', [], [
        el('p:spTree', [], [
          ...groupShapeTreePreamble(),
          el('p:sp', [], [
            el('p:nvSpPr', [], [
              el('p:cNvPr', [attr('id', '2'), attr('name', 'Notes Placeholder')]),
              el('p:cNvSpPr', [attr('txBox', '1')]),
              el('p:nvPr', [], [el('p:ph', [attr('type', 'body'), attr('idx', '1')])]),
            ]),
            el('p:spPr', [], [
              el('a:xfrm', [], [
                el('a:off', [attr('x', formatInteger(NOTES_BOX.x)), attr('y', formatInteger(NOTES_BOX.y))]),
                el('a:ext', [attr('cx', formatInteger(NOTES_BOX.cx)), attr('cy', formatInteger(NOTES_BOX.cy))]),
              ]),
              el('a:prstGeom', [attr('prst', 'rect')], [el('a:avLst')]),
            ]),
            textBodyXml(notes, []),
          ]),
        ]),
      ]),
      el('p:clrMapOvr', [], [el('a:masterClrMapping')]),
    ]),
  );
}

function slideMasterXml(layoutCount: number): string {
  return serializeXmlDocument(
    el('p:sldMaster', [attr('xmlns:a', NS_A), attr('xmlns:r', NS_R), attr('xmlns:p', NS_P)], [
      el('p:cSld', [], [el('p:spTree', [], [...groupShapeTreePreamble()])]),
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
      el('p:sldLayoutIdLst', [], [
        ...Array.from({ length: layoutCount }, (_unused, index) =>
          el('p:sldLayoutId', [
            attr('id', formatInteger(FIRST_LAYOUT_ID + index)),
            attr('r:id', relationshipIdAt(index)),
          ]),
        ),
      ]),
      el('p:txStyles', [], [
        el('p:titleStyle', [], [levelStyle(44, '+mj-lt')]),
        el('p:bodyStyle', [], [levelStyle(28, '+mn-lt')]),
        el('p:otherStyle', [], [levelStyle(18, '+mn-lt')]),
      ]),
    ]),
  );
}

function levelStyle(sizePt: number, typeface: string): XmlElement {
  return el('a:lvl1pPr', [], [
    el('a:defRPr', [attr('sz', formatInteger(sizePt * 100))], [
      el('a:solidFill', [], [el('a:schemeClr', [attr('val', 'tx1')])]),
      el('a:latin', [attr('typeface', typeface)]),
      el('a:ea', [attr('typeface', '')]),
    ]),
  ]);
}

function slideLayoutXml(name: string): string {
  return serializeXmlDocument(
    el('p:sldLayout', [
      attr('xmlns:a', NS_A),
      attr('xmlns:r', NS_R),
      attr('xmlns:p', NS_P),
      attr('type', 'blank'),
      attr('preserve', '1'),
    ], [
      el('p:cSld', [attr('name', name)], [el('p:spTree', [], [...groupShapeTreePreamble()])]),
      el('p:clrMapOvr', [], [el('a:masterClrMapping')]),
    ]),
  );
}

function notesMasterXml(): string {
  return serializeXmlDocument(
    el('p:notesMaster', [attr('xmlns:a', NS_A), attr('xmlns:r', NS_R), attr('xmlns:p', NS_P)], [
      el('p:cSld', [], [el('p:spTree', [], [...groupShapeTreePreamble()])]),
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
      el('p:notesStyle', [], [levelStyle(12, '+mn-lt')]),
    ]),
  );
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/** 模型里是否有顶层 `media`（音视频）形状——决定是否改走 P05 的整包装配器。 */
function hasMediaShape(presentation: Presentation): boolean {
  return presentation.slides.some((slide) => slide.shapes.some((shape) => shape.kind === 'media'));
}

/** 逐页索引：媒体路径（去重、首现顺序）。 */
function mediaPathsOf(slide: Slide): readonly string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const shape of slide.shapes) {
    if (shape.kind === 'picture' && !seen.has(shape.media_path)) {
      seen.add(shape.media_path);
      order.push(shape.media_path);
    }
  }
  return order;
}

/** 逐页索引：图表形状（含组合内），按文档顺序（与 `shapeXml` 遇到它们的顺序一致）。 */
function chartShapesOf(slide: Slide): readonly Extract<Shape, { kind: 'chart' }>[] {
  const found: Extract<Shape, { kind: 'chart' }>[] = [];
  const visit = (shapes: readonly Shape[]): void => {
    for (const shape of shapes) {
      if (shape.kind === 'chart') {
        found.push(shape);
      } else if (shape.kind === 'group') {
        visit(shape.children);
      }
    }
  };
  visit(slide.shapes);
  return found;
}

/** 一个图表形状规划出的部件（图表部件 + 嵌入工作簿）与其关系声明。 */
interface ChartPlan {
  readonly shape_id: number;
  readonly chart_path: string;
  readonly workbook_path: string;
  readonly parts: readonly OpcPart[];
  readonly chart_relationships: readonly RelationshipDeclaration[];
}

/**
 * 媒体部件的内容类型只保留扩展名 `Default`，去掉按部件写的 `Override`（PowerPoint 口径）。
 *
 * `assembleOpcPackage` 会给每个业务部件写一条 `Override`；对 `ppt/media/**` 的图片 / 音视频
 * 来说，这会在 `[Content_Types].xml` 里与扩展名 `Default` 重复。本函数按**同样的** `Defaults`
 * 顺序与 `parts` 顺序重建内容类型（只去掉媒体部件的 `Override`），产物其余部分不变。
 */
function contentTypesWithoutMediaOverrides(
  assembled: AssembledOpcPackage,
  defaults: readonly ContentTypeDefault[],
  parts: readonly OpcPart[],
  mediaPaths: ReadonlySet<string>,
): AssembledOpcPackage {
  const xml = serializeXmlDocument(
    contentTypesElement(defaults, parts.filter((part) => !mediaPaths.has(part.path))),
  );
  const bytes = Buffer.from(xml, 'utf8');
  return {
    ...assembled,
    entries: assembled.entries.map((entry) =>
      entry.path === CONTENT_TYPES_PART_PATH ? { path: entry.path, data: bytes } : entry,
    ),
    content_types: { ...assembled.content_types, xml, bytes },
  };
}

/**
 * 把演示模型渲染成一份 PPTX（**页数 = `presentation.slides.length`**，PPT-01）。
 *
 * 图表（PPT-09）会额外产出 `ppt/charts/chartN.xml` + `ppt/embeddings/Microsoft_Excel_WorksheetN.xlsx`
 * 两份部件、幻灯片 `_rels` 里的 `…/chart` 关系、以及图表部件自身 `_rels` 里的 `…/package` 关系
 * （内容类型由 `assembleOpcPackage` 自动作为 `Override` 写入 `[Content_Types].xml`）。
 *
 * @throws {PresentationRenderError} 未渲染的对象种类 / 非法 shape_id / 缺失媒体 / 多母版 / 合并 span 越界。
 */
export function renderPresentation(
  presentation: Presentation,
  options?: RenderPresentationOptions,
): RenderPresentationResult {
  const snapshot: FactSnapshot = options?.fact_snapshot ?? [];
  const mediaParts = options?.media ?? [];
  const mediaByPath = new Map(mediaParts.map((part) => [part.path, part]));
  const customMasterIds = new Set(presentation.slides.map((slide) => slide.layout.master_id));
  customMasterIds.delete(presentation.master.master_id);
  if (customMasterIds.size > 0) {
    throw new PresentationRenderError(
      'multi_master_unsupported',
      `本增量只渲染单套母版；引用了其它母版：${[...customMasterIds].join(', ')}`,
    );
  }

  // 音视频（PPT-12）：含 `media` 形状的文稿改经 P05 的整包装配器产出（占位替换 + 真实音视频
  // 片段 + 关系 + 放映时间，并在装配内 `verifyAvMediaInPackage` 读回校验），而不是逐页渲染报
  // `unsupported_shape_kind`。未提供 `av_board` ⇒ 不进入此分支，落到逐页渲染（保持旧的具名报错）。
  const avBoard = options?.av_board;
  if (avBoard !== undefined && hasMediaShape(presentation)) {
    const catalog: MediaCatalog = { parts: mediaParts };
    const assembled = assembleAvMediaPackage(presentation, avBoard, catalog, {
      fact_snapshot: snapshot,
    });
    return Object.freeze({
      bytes: assembled.bytes,
      entry_count: assembled.entry_count,
      content_digest: digestBytes(assembled.bytes),
      slide_count: assembled.slide_count,
    });
  }

  // 版式：按幻灯片出现顺序去重（同一 layout_id 只出一份部件）。
  const layoutKeys: string[] = [];
  const layoutIndexByKey = new Map<string, number>();
  for (const slide of presentation.slides) {
    const key = slide.layout.layout_id;
    if (!layoutIndexByKey.has(key)) {
      layoutIndexByKey.set(key, layoutKeys.length);
      layoutKeys.push(key);
    }
  }
  if (layoutKeys.length === 0) {
    layoutKeys.push('blank');
    layoutIndexByKey.set('blank', 0);
  }
  const layoutPartPath = (index: number): string => `ppt/slideLayouts/slideLayout${String(index + 1)}.xml`;

  // 每页的媒体关系与备注部件。
  interface SlidePlan {
    readonly slide: Slide;
    readonly media_paths: readonly string[];
    readonly notes_part: string | null;
  }
  const slidePlans: readonly SlidePlan[] = presentation.slides.map((slide, index) => ({
    slide,
    media_paths: mediaPathsOf(slide),
    notes_part: slide.notes === null ? null : `ppt/notesSlides/notesSlide${String(index + 1)}.xml`,
  }));

  // 媒体部件引用了但未提供 ⇒ 报错（不静默跳过，PPT-06/PPT-12「不假称已嵌入」）。
  for (const plan of slidePlans) {
    for (const path of plan.media_paths) {
      if (!mediaByPath.has(path)) {
        throw new PresentationRenderError(
          'missing_media',
          `幻灯片引用了媒体 ${path}，但未在 options.media 中提供其字节`,
        );
      }
    }
  }

  const hasNotes = slidePlans.some((plan) => plan.notes_part !== null);

  // 图表（PPT-09）：在渲染幻灯片 XML 之前先定下每张图的部件路径与关系（关系 id 与页内顺序绑定）。
  const chartOptions: ChartOptionMap = options?.chart_options ?? NO_CHART_OPTIONS;
  const chartPlansBySlide: ChartPlan[][] = presentation.slides.map(() => []);
  let chartCount = 0;
  presentation.slides.forEach((slide, slideIndex) => {
    const planned = chartPlansBySlide[slideIndex];
    if (planned === undefined) {
      return;
    }
    for (const shape of chartShapesOf(slide)) {
      chartCount += 1;
      const chartPath = `ppt/charts/chart${String(chartCount)}.xml`;
      const workbookPath = `ppt/embeddings/Microsoft_Excel_Worksheet${String(chartCount)}.xlsx`;
      const built = buildChartParts(shape.chart, chartOptionsOf(chartOptions, shape.shape_id), {
        chart_path: chartPath,
        workbook_path: workbookPath,
      });
      planned.push({
        shape_id: shape.shape_id,
        chart_path: chartPath,
        workbook_path: workbookPath,
        parts: built.parts,
        chart_relationships: built.chart_relationships,
      });
    }
  });

  // --- 部件 ---
  const parts: OpcPart[] = [];

  // presentation.xml 的关系顺序：0 = slideMaster，[1 = notesMaster]，其余 = 各幻灯片。
  const masterRelIndex = 0;
  const notesMasterRelIndex = hasNotes ? 1 : -1;
  const firstSlideRelIndex = 1 + (hasNotes ? 1 : 0);
  const slideRelIndex = (index: number): number => firstSlideRelIndex + index;

  parts.push({
    path: 'ppt/presentation.xml',
    content_type: CT_PRESENTATION,
    data: presentationXml(presentation, slidePlans.length, {
      masterRelIds: { presentation: relationshipIdAt(masterRelIndex), notesMaster: notesMasterRelIndex < 0 ? null : relationshipIdAt(notesMasterRelIndex) },
      slideRelId: (index) => relationshipIdAt(slideRelIndex(index)),
    }),
  });

  parts.push({
    path: 'ppt/slideMasters/slideMaster1.xml',
    content_type: CT_SLIDE_MASTER,
    data: slideMasterXml(layoutKeys.length),
  });

  layoutKeys.forEach((layoutId, index) => {
    parts.push({
      path: layoutPartPath(index),
      content_type: CT_SLIDE_LAYOUT,
      data: slideLayoutXml(layoutId === 'blank' ? 'Blank' : layoutId),
    });
  });

  slidePlans.forEach((plan, index) => {
    const mediaRelId = (path: string): string => {
      const position = plan.media_paths.indexOf(path);
      return relationshipIdAt(1 + position); // 0 留给版式
    };
    // 该页图表的关系 id：跟在版式与媒体之后（与下面 _rels 声明顺序一致）。
    const charts = chartPlansBySlide[index] ?? [];
    const chartRelId = (shapeId: number): string => {
      const position = charts.findIndex((chartPlan) => chartPlan.shape_id === shapeId);
      if (position < 0) {
        throw new PresentationRenderError(
          'unsupported_shape_kind',
          `第 ${String(index + 1)} 页找不到图表 shape_id=${String(shapeId)} 的部件规划`,
        );
      }
      return relationshipIdAt(1 + plan.media_paths.length + position);
    };
    parts.push({
      path: `ppt/slides/slide${String(index + 1)}.xml`,
      content_type: CT_SLIDE,
      data: slideXml(plan.slide, { snapshot, media_rel: mediaRelId, chart_rel: chartRelId }),
    });
  });

  // 图表部件（图表 XML + 嵌入工作簿）；内容类型由 `assembleOpcPackage` 作为 Override 写入。
  for (const charts of chartPlansBySlide) {
    for (const chartPlan of charts) {
      for (const part of chartPlan.parts) {
        parts.push(part);
      }
    }
  }

  if (hasNotes) {
    parts.push({
      path: 'ppt/notesMasters/notesMaster1.xml',
      content_type: CT_NOTES_MASTER,
      data: notesMasterXml(),
    });
  }

  slidePlans.forEach((plan) => {
    if (plan.notes_part !== null && plan.slide.notes !== null) {
      parts.push({
        path: plan.notes_part,
        content_type: CT_NOTES_SLIDE,
        data: notesSlideXml(plan.slide.notes),
      });
    }
  });

  parts.push({ path: 'ppt/theme/theme1.xml', content_type: CT_THEME, data: themeXml() });

  // 媒体部件（按调用方给定顺序）。
  const defaults: ContentTypeDefault[] = [RELATIONSHIPS_DEFAULT];
  const seenMediaExtensions = new Set<string>();
  for (const part of mediaParts) {
    const extension = part.path.slice(part.path.lastIndexOf('.') + 1).toLowerCase();
    const contentType = MEDIA_CONTENT_TYPES[extension];
    if (contentType === undefined) {
      throw new PresentationRenderError(
        'unknown_media_type',
        `媒体 ${part.path} 的扩展名 .${extension} 不在受支持表内`,
      );
    }
    if (!seenMediaExtensions.has(extension)) {
      seenMediaExtensions.add(extension);
      defaults.push({ extension, content_type: contentType });
    }
    parts.push({ path: part.path, content_type: contentType, data: part.bytes });
  }

  // --- 关系 ---
  const relationships: RelationshipGroup[] = [
    {
      owner_part_path: null,
      declarations: [{ type: REL_OFFICE_DOCUMENT, target: 'ppt/presentation.xml' }] satisfies RelationshipDeclaration[],
    },
    {
      owner_part_path: 'ppt/presentation.xml',
      declarations: [
        { type: REL_SLIDE_MASTER, target: 'slideMasters/slideMaster1.xml' },
        ...(hasNotes ? [{ type: REL_NOTES_MASTER, target: 'notesMasters/notesMaster1.xml' }] : []),
        ...slidePlans.map((_plan, index) => ({
          type: REL_SLIDE,
          target: `slides/slide${String(index + 1)}.xml`,
        })),
      ] satisfies RelationshipDeclaration[],
    },
    {
      owner_part_path: 'ppt/slideMasters/slideMaster1.xml',
      declarations: [
        ...layoutKeys.map((_layoutId, index) => ({
          type: REL_SLIDE_LAYOUT,
          target: `../slideLayouts/slideLayout${String(index + 1)}.xml`,
        })),
        { type: REL_THEME, target: '../theme/theme1.xml' },
      ] satisfies RelationshipDeclaration[],
    },
    ...layoutKeys.map((_layoutId, index) => ({
      owner_part_path: layoutPartPath(index),
      declarations: [
        { type: REL_SLIDE_MASTER, target: '../slideMasters/slideMaster1.xml' },
      ] satisfies RelationshipDeclaration[],
    })),
    ...slidePlans.map((plan, index) => ({
      owner_part_path: `ppt/slides/slide${String(index + 1)}.xml`,
      declarations: [
        {
          type: REL_SLIDE_LAYOUT,
          target: `../slideLayouts/slideLayout${String((layoutIndexByKey.get(plan.slide.layout.layout_id) ?? 0) + 1)}.xml`,
        },
        ...plan.media_paths.map((path) => ({
          type: REL_IMAGE,
          target: `../${path.replace(/^ppt\//, '')}`,
        })),
        // 图表关系：紧接媒体之后（id = 1 + 媒体数 + 页内图表序，与 `chart_rel` 一致）。
        ...(chartPlansBySlide[index] ?? []).map((chartPlan) => chartSlideRelationship(chartPlan.chart_path)),
        ...(plan.notes_part === null
          ? []
          : [{ type: REL_NOTES_SLIDE, target: `../notesSlides/notesSlide${String(index + 1)}.xml` }]),
      ] satisfies RelationshipDeclaration[],
    })),
    // 每个图表部件自身的关系（指向嵌入工作簿，`…/package`）。
    ...chartPlansBySlide.flatMap((charts) =>
      charts.map((chartPlan) => ({
        owner_part_path: chartPlan.chart_path,
        declarations: chartPlan.chart_relationships,
      })),
    ),
    ...(hasNotes
      ? [
          {
            owner_part_path: 'ppt/notesMasters/notesMaster1.xml',
            declarations: [{ type: REL_THEME, target: '../theme/theme1.xml' }] satisfies RelationshipDeclaration[],
          },
        ]
      : []),
    ...slidePlans.flatMap((plan, index) =>
      plan.notes_part === null
        ? []
        : [
            {
              owner_part_path: plan.notes_part,
              declarations: [
                { type: REL_SLIDE, target: `../slides/slide${String(index + 1)}.xml` },
                { type: REL_NOTES_MASTER, target: '../notesMasters/notesMaster1.xml' },
              ] satisfies RelationshipDeclaration[],
            },
          ],
    ),
  ];

  const assembledBase = assembleOpcPackage({ parts, content_type_defaults: defaults, relationships });
  // 媒体部件内容类型只走扩展名 `Default`（不重复写部件 `Override`）；无媒体 ⇒ 产物字节不变。
  const assembled =
    mediaParts.length === 0
      ? assembledBase
      : contentTypesWithoutMediaOverrides(
          assembledBase,
          defaults,
          parts,
          new Set(mediaParts.map((part) => part.path)),
        );
  const bytes = writeZip(assembled.entries);

  return Object.freeze({
    bytes,
    entry_count: assembled.entries.length,
    content_digest: digestBytes(bytes),
    slide_count: slidePlans.length,
  });
}

function presentationXml(
  presentation: Presentation,
  slideCount: number,
  rels: {
    readonly masterRelIds: { readonly presentation: string; readonly notesMaster: string | null };
    readonly slideRelId: (index: number) => string;
  },
): string {
  return serializeXmlDocument(
    el('p:presentation', [attr('xmlns:a', NS_A), attr('xmlns:r', NS_R), attr('xmlns:p', NS_P)], [
      el('p:sldMasterIdLst', [], [
        el('p:sldMasterId', [attr('id', formatInteger(MASTER_ID)), attr('r:id', rels.masterRelIds.presentation)]),
      ]),
      ...(rels.masterRelIds.notesMaster === null
        ? []
        : [
            el('p:notesMasterIdLst', [], [
              el('p:notesMasterId', [attr('r:id', rels.masterRelIds.notesMaster)]),
            ]),
          ]),
      el('p:sldIdLst', [], [
        ...Array.from({ length: slideCount }, (_unused, index) =>
          el('p:sldId', [
            attr('id', formatInteger(FIRST_SLIDE_ID + index)),
            attr('r:id', rels.slideRelId(index)),
          ]),
        ),
      ]),
      el('p:sldSz', [
        attr('cx', formatInteger(presentation.size.cx_emu)),
        attr('cy', formatInteger(presentation.size.cy_emu)),
      ]),
      el('p:notesSz', [attr('cx', formatInteger(NOTES_WIDTH_EMU)), attr('cy', formatInteger(NOTES_HEIGHT_EMU))]),
    ]),
  );
}

/** 便捷入口：从空文稿开始，按给定页数造一份演示（页数由调用方/任务决定）。 */
export function emptyPresentation(
  presentationId: string,
  title: string,
): Presentation {
  return {
    presentation_id: presentationId,
    title,
    format: 'pptx',
    size: { cx_emu: 9144000, cy_emu: 6858000 },
    master: { master_id: 'master1' },
    theme: { theme_id: 'theme1' },
    slides: [],
    sections: [],
  };
}

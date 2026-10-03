/**
 * 文本框与常用形状（WF-070）。
 *
 * ## 与图片共用同一条通路
 *
 * 文本框/形状与图片一样，都是 run 里的一段 `w:drawing`（区别只在 `a:graphicData` 里是
 * `wps:wsp` 而不是 `pic:pic`），因此插入/改写/删除原语完全复用 `fragment-edit.ts`。
 * **两者都不动媒体**：形状没有 `r:embed`，`checkMediaIntegrity` 对它同样成立
 * （mp 里没有多余的关系，也没有悬空引用）。
 *
 * ## 不认识的图形**必须留住**（WF-070 判据）
 *
 * `unknownGraphics()` 把"是 drawing 但本包认不出（或解析不出参数）"的片段列出来；
 * 任何"改参数"的操作碰到它们都**结构化拒绝**（`unsupported`），不改写、不删除、不搬位置。
 * 测试里用"操作前后该片段 XML 逐字节相等"来钉住这条（R105/R110）。
 */

import { DocumentModelError } from '../../model/errors.js';
import type { DocumentModel, Length, NodeId, ParagraphNode } from '../../model/types.js';
import {
  docPrIdOf,
  parseShape,
  shapeXml,
  type ShapeParams,
  type ShapeXmlInput,
} from './drawing-xml.js';
import {
  insertRunWithFragment,
  removeFragmentFromRun,
  requireParagraph,
  requireRun,
  withParagraph,
  withRunFragment,
} from './fragment-edit.js';
import { findDrawings, isUnknownGraphic, type DrawingRef } from './image.js';
import {
  DEFAULT_ANCHOR,
  lengthToEmu,
  type AltText,
  type AnchorSpec,
  type WrapMode,
} from './params.js';
import { runDrawingEdit, type DrawingOutcome } from './types.js';

/** 常用形状（WF-070 的"常用形状"）。 */
export type ShapePreset = ShapeXmlInput['preset'];

/** 插入文本框 / 形状请求。 */
export interface InsertShapeRequest {
  readonly paragraph_id: NodeId;
  readonly inline_index?: number;
  readonly preset: ShapePreset;
  readonly width: Length;
  readonly height: Length;
  /** 形状里的文字（文本框的正文）。 */
  readonly text?: string;
  readonly fill_hex?: string | null;
  readonly outline_hex?: string | null;
  readonly wrap?: WrapMode;
  readonly anchor?: AnchorSpec;
  readonly alt?: Partial<AltText>;
  /** 是不是文本框（写 `wps:cNvSpPr@txBox`）；默认按 `preset === 'rect' && text 有内容` 判定。 */
  readonly text_box?: boolean;
}

/** 插入结果。 */
export interface InsertShapeSuccess {
  readonly model: DocumentModel;
  readonly run_id: NodeId;
  readonly doc_pr_id: number;
  readonly xml: string;
}

/** 下一个 `wp:docPr@id`（形状也要占号，避免与图片撞）。 */
function nextDocPrId(model: DocumentModel): number {
  let max = 0;
  for (const ref of findDrawings(model)) {
    const id = docPrIdOf(ref.xml);
    if (id !== null && id > max) {
      max = id;
    }
  }
  return max + 1;
}

/** 插入文本框 / 形状（WF-070）。 */
export function insertShape(
  model: DocumentModel,
  request: InsertShapeRequest,
): DrawingOutcome<InsertShapeSuccess> {
  return runDrawingEdit(() => {
    const paragraph = requireParagraph(model, request.paragraph_id);
    const index = request.inline_index ?? paragraph.inlines.length;
    if (request.width.value <= 0 || request.height.value <= 0) {
      throw new DocumentModelError('invalid_node', '形状尺寸必须为正');
    }
    const docPrId = nextDocPrId(model);
    const text = request.text ?? '';
    const alt: AltText = {
      name: request.alt?.name ?? `形状 ${String(docPrId)}`,
      description: request.alt?.description ?? '',
      title: request.alt?.title ?? null,
    };
    const xml = shapeXml({
      preset: request.preset,
      extent: { cx: lengthToEmu(request.width), cy: lengthToEmu(request.height) },
      wrap: request.wrap ?? 'inline',
      anchor: request.anchor ?? DEFAULT_ANCHOR,
      alt,
      doc_pr_id: docPrId,
      text,
      fill_hex: request.fill_hex ?? null,
      outline_hex: request.outline_hex ?? null,
      text_box: request.text_box ?? (request.preset === 'rect' && text.length > 0),
    });
    const inserted = insertRunWithFragment(model, request.paragraph_id, index, xml);
    return { model: inserted.model, run_id: inserted.run_id, doc_pr_id: docPrId, xml };
  });
}

/** 找一个**认识**的形状片段（不认识的图形一律拒绝改写）。 */
function requireShapeRef(
  model: DocumentModel,
  runId: NodeId,
  opaqueIndex?: number,
): { readonly ref: DrawingRef; readonly params: ShapeParams } {
  const candidates = findDrawings(model).filter((ref) => ref.run_id === runId);
  const ref = opaqueIndex === undefined ? candidates[0] : candidates.find((entry) => entry.opaque_index === opaqueIndex);
  if (ref === undefined) {
    throw new DocumentModelError('unknown_node', `run ${JSON.stringify(runId)} 里没有图形片段`);
  }
  const params = parseShape(ref.xml);
  if (params === null) {
    throw new DocumentModelError(
      'unsupported',
      '该片段不是本包认识的形状（可能是 SmartArt/图表/嵌入对象）——不猜、不改写，原样保留',
    );
  }
  return { ref, params };
}

/** 就地重建形状 XML（形状没有关系引用，因此不需要碰包级三件套）。 */
function rebuildShape(
  model: DocumentModel,
  runId: NodeId,
  opaqueIndex: number | undefined,
  params: ShapeParams,
  patch: {
    readonly preset?: ShapePreset;
    readonly text?: string;
    readonly fill_hex?: string | null;
    readonly outline_hex?: string | null;
    readonly extent?: { readonly cx: number; readonly cy: number };
    readonly wrap?: WrapMode;
    readonly anchor?: AnchorSpec;
    readonly alt?: AltText;
  },
): { readonly model: DocumentModel; readonly params: ShapeParams; readonly xml: string } {
  const { ref } = requireShapeRef(model, runId, opaqueIndex);
  const docPrId = docPrIdOf(ref.xml) ?? 1;
  const wrap = patch.wrap ?? params.wrap;
  const next: ShapeParams = {
    preset: patch.preset ?? params.preset,
    text: patch.text ?? params.text,
    fill_hex: patch.fill_hex === undefined ? params.fill_hex : patch.fill_hex,
    outline_hex: patch.outline_hex === undefined ? params.outline_hex : patch.outline_hex,
    extent: patch.extent ?? params.extent,
    wrap,
    anchor: wrap === 'inline' ? null : (patch.anchor ?? params.anchor ?? DEFAULT_ANCHOR),
    alt: patch.alt ?? params.alt,
  };
  const xml = shapeXml({
    preset: next.preset as ShapePreset,
    extent: next.extent,
    wrap: next.wrap,
    anchor: next.anchor ?? DEFAULT_ANCHOR,
    alt: next.alt,
    doc_pr_id: docPrId,
    text: next.text,
    fill_hex: next.fill_hex,
    outline_hex: next.outline_hex,
    text_box: false,
  });
  const paragraph = requireParagraph(model, ref.paragraph_id);
  const run = requireRun(paragraph, ref.run_id);
  const updated: ParagraphNode = {
    ...paragraph,
    inlines: paragraph.inlines.map((inline) =>
      inline.id === ref.run_id ? withRunFragment(run, ref.opaque_index, xml) : inline,
    ),
  };
  return { model: withParagraph(model, ref.paragraph_id, updated), params: next, xml };
}

/** 形状参数操作的结果。 */
export interface ShapeParamsSuccess {
  readonly model: DocumentModel;
  readonly params: ShapeParams;
  readonly xml: string;
}

/** 设置形状里的文字（WF-070）。 */
export function setShapeText(
  model: DocumentModel,
  request: { readonly run_id: NodeId; readonly opaque_index?: number; readonly text: string },
): DrawingOutcome<ShapeParamsSuccess> {
  return runDrawingEdit(() => rebuildShape(model, request.run_id, request.opaque_index, requireShapeRef(model, request.run_id, request.opaque_index).params, { text: request.text }));
}

/** 设置形状填充色（`null` = 清掉填充）。 */
export function setShapeFill(
  model: DocumentModel,
  request: { readonly run_id: NodeId; readonly opaque_index?: number; readonly fill_hex: string | null },
): DrawingOutcome<ShapeParamsSuccess> {
  return runDrawingEdit(() => {
    const { params } = requireShapeRef(model, request.run_id, request.opaque_index);
    return rebuildShape(model, request.run_id, request.opaque_index, params, { fill_hex: request.fill_hex });
  });
}

/** 设置形状描边色（`null` = 清掉描边）。 */
export function setShapeOutline(
  model: DocumentModel,
  request: { readonly run_id: NodeId; readonly opaque_index?: number; readonly outline_hex: string | null },
): DrawingOutcome<ShapeParamsSuccess> {
  return runDrawingEdit(() => {
    const { params } = requireShapeRef(model, request.run_id, request.opaque_index);
    return rebuildShape(model, request.run_id, request.opaque_index, params, { outline_hex: request.outline_hex });
  });
}

/** 设置形状尺寸（`Length`，换算走 `params.ts` 的唯一 EMU 入口）。 */
export function setShapeSize(
  model: DocumentModel,
  request: {
    readonly run_id: NodeId;
    readonly opaque_index?: number;
    readonly width: Length;
    readonly height: Length;
  },
): DrawingOutcome<ShapeParamsSuccess> {
  return runDrawingEdit(() => {
    if (request.width.value <= 0 || request.height.value <= 0) {
      throw new DocumentModelError('invalid_node', '形状尺寸必须为正');
    }
    const { params } = requireShapeRef(model, request.run_id, request.opaque_index);
    return rebuildShape(model, request.run_id, request.opaque_index, params, {
      extent: { cx: lengthToEmu(request.width), cy: lengthToEmu(request.height) },
    });
  });
}

/** 删除形状 / 文本框。 */
export function deleteShape(
  model: DocumentModel,
  request: { readonly run_id: NodeId; readonly opaque_index?: number },
): DrawingOutcome<{ readonly model: DocumentModel; readonly removed_run: boolean }> {
  return runDrawingEdit(() => {
    const { ref } = requireShapeRef(model, request.run_id, request.opaque_index);
    const paragraph = requireParagraph(model, ref.paragraph_id);
    const stripped = removeFragmentFromRun(paragraph, ref.run_id, ref.opaque_index);
    return {
      model: withParagraph(model, ref.paragraph_id, stripped.paragraph),
      removed_run: stripped.run_removed,
    };
  });
}

/** 读回形状参数（不认识的图形 ⇒ `null`；不存在 ⇒ 抛）。 */
export function shapeParams(model: DocumentModel, runId: NodeId, opaqueIndex?: number): ShapeParams | null {
  const ref = findDrawings(model).find(
    (entry) => entry.run_id === runId && (opaqueIndex === undefined || entry.opaque_index === opaqueIndex),
  );
  if (ref === undefined) {
    throw new DocumentModelError('unknown_node', `run ${JSON.stringify(runId)} 里没有图形片段`);
  }
  return parseShape(ref.xml);
}

// ---------------------------------------------------------------------------
// 未知图形的保留清单（WF-070 判据：保留，不静默丢弃）
// ---------------------------------------------------------------------------

/** 文档里"认不出的图形"（含解析失败与未知种类）。 */
export interface UnknownGraphic {
  readonly run_id: NodeId;
  readonly paragraph_id: NodeId;
  readonly opaque_index: number;
  readonly xml: string;
  /** 为什么算"认不出"：解析不出参数 / 种类是 unknown。 */
  readonly reason: 'unparsable' | 'unknown_kind';
}

/** 列出文档里所有认不出的图形片段（它们必须**原样保留**）。 */
export function unknownGraphics(model: DocumentModel): readonly UnknownGraphic[] {
  const result: UnknownGraphic[] = [];
  for (const ref of findDrawings(model)) {
    if (!isUnknownGraphic(ref)) {
      continue;
    }
    result.push({
      run_id: ref.run_id,
      paragraph_id: ref.paragraph_id,
      opaque_index: ref.opaque_index,
      xml: ref.xml,
      reason: ref.params === null ? 'unparsable' : 'unknown_kind',
    });
  }
  return result;
}

/**
 * 图片的插入 / 替换 / 删除 / 尺寸 / 旋转 / 裁剪 / 环绕 / 替代文字 / 题注
 * （WF-065–WF-069）。
 *
 * ## 表示法
 *
 * 图片 = **run 里的一段 `w:drawing` 片段**（`RunNode.opaque` 的 `{kind:'raw_at_char', xml, offset}`），
 * 与 D02 导入器的约定一致（见 `params.ts` 文件头）。因此：
 *
 * - "插图片"= 往段落里插一个新 run，run 的 `opaque` 带一段 `w:drawing`；
 * - "改图片参数"= 就地替换那段 XML（**位置/偏移不动**，图片仍在那句话的同一个位置）；
 * - "删图片"= 拿掉片段 + 拿掉包级三件套；run 若因此变空则一并删掉（Word 的行为）。
 *
 * ## 不认识的图形一律不碰
 *
 * 片段解析不出参数（`parseDrawing` 返回 `null`，例如 SmartArt、图表、嵌入对象）
 * ⇒ 所有"改参数"的操作**结构化拒绝**（`unsupported`），**不静默丢弃、不改写**（R105/R110）。
 *
 * ## 裁剪只写参数
 *
 * `setImageCrop` 只改 `a:srcRect`——**媒体字节一个字节都不动**。判据要求"测试要证明
 * 媒体 sha256 未变"，对应的断言在 `image.test.ts` 里（用 `node:crypto` 现算摘要）。
 *
 * ## 题注只写域指令（R158）
 *
 * `setCaption` 写入 `SEQ 图 \* ARABIC` 域，并把 `refresh_state` 标为 `'unknown'`、
 * `cached_result` 留 `null`：**写入域指令 ≠ 已算出编号**。要拿到真实编号必须有消费端刷新证据。
 */

import { DocumentModelError } from '../../model/errors.js';
import { createNodeIdAllocator, withSegment } from '../../model/ids.js';
import { insertAt } from '../../model/immutable.js';
import { fieldNode, paragraphNode, runNode, type DraftInlineNode } from '../../model/nodes.js';
import { applyStructureBatch } from '../../model/structure.js';
import { collectNodeIds, findBlockLocation } from '../../model/walk.js';
import type {
  DocumentModel,
  DrawingNode,
  Length,
  NodeId,
  ParagraphNode,
} from '../../model/types.js';
import {
  insertRunWithFragment,
  pathOfExistingNode,
  removeFragmentFromRun,
  requireParagraph,
  requireRun,
  withParagraph,
  withRunFragment,
} from './fragment-edit.js';
import {
  docPrIdOf,
  drawingXml,
  parseDrawing,
  type PictureXmlInput,
} from './drawing-xml.js';
import {
  registerImageMedia,
  removeImageMedia,
  extensionForContentType,
  mainDocumentPartPath,
  partRelationships,
} from './media.js';
import {
  cropProblem,
  emuToLength,
  lengthToEmu,
  type AltText,
  type AnchorSpec,
  type CropRect,
  type DrawingParams,
  type WrapMode,
  DEFAULT_ANCHOR,
  NO_CROP,
} from './params.js';
import { runDrawingEdit, type DrawingOutcome } from './types.js';

// ---------------------------------------------------------------------------
// 扫描：文档里有哪些图形
// ---------------------------------------------------------------------------

/** 文档里出现的一段图形（只读投影）。 */
export interface DrawingRef {
  readonly run_id: NodeId;
  readonly paragraph_id: NodeId;
  /** 该片段在 run.opaque 数组里的下标（改这段 XML 时的定位）。 */
  readonly opaque_index: number;
  readonly xml: string;
  /** 解析得出的参数；不认识的图形为 `null`。 */
  readonly params: DrawingParams | null;
  readonly relationship_id: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 收集全文（含表格单元格里的段落）里的 `w:drawing` 片段。 */
export function findDrawings(model: DocumentModel): readonly DrawingRef[] {
  const found: DrawingRef[] = [];
  const visitParagraph = (paragraph: ParagraphNode): void => {
    for (const inline of paragraph.inlines) {
      if (inline.kind !== 'run') {
        continue;
      }
      inline.opaque.forEach((item, index) => {
        if (!isRecord(item) || item['kind'] !== 'raw_at_char' || typeof item['xml'] !== 'string') {
          return;
        }
        const xml = item['xml'];
        const params = parseDrawing(xml);
        if (params === null && !xml.includes('<w:drawing')) {
          return;
        }
        found.push({
          run_id: inline.id,
          paragraph_id: paragraph.id,
          opaque_index: index,
          xml,
          params,
          relationship_id: params === null ? null : params.relationship_id,
        });
      });
    }
  };

  const visitBlocks = (blocks: readonly { readonly kind: string }[]): void => {
    for (const block of blocks as readonly (
      | ParagraphNode
      | { readonly kind: 'table'; readonly rows: readonly { readonly cells: readonly { readonly blocks: readonly { readonly kind: string }[] }[] }[] }
    )[]) {
      if (block.kind === 'paragraph') {
        visitParagraph(block);
        continue;
      }
      for (const row of block.rows) {
        for (const cell of row.cells) {
          visitBlocks(cell.blocks);
        }
      }
    }
  };
  visitBlocks(model.blocks);
  return found;
}

/** 找某段 `w:drawing`（run + 片段下标）；找不到即抛。 */
function requireDrawing(
  model: DocumentModel,
  runId: NodeId,
  opaqueIndex?: number,
): DrawingRef {
  const candidates = findDrawings(model).filter((ref) => ref.run_id === runId);
  const target =
    opaqueIndex === undefined
      ? candidates[0]
      : candidates.find((ref) => ref.opaque_index === opaqueIndex);
  if (target === undefined) {
    throw new DocumentModelError(
      'unknown_node',
      `run ${JSON.stringify(runId)} 里没有${opaqueIndex === undefined ? '' : `下标 ${String(opaqueIndex)} 处的`}图形片段`,
    );
  }
  return target;
}

/** 认不出的图形：解析失败，或解析出来但种类是 `unknown`（SmartArt/图表/嵌入对象等）。 */
export function isUnknownGraphic(ref: DrawingRef): boolean {
  return ref.params === null || ref.params.graphic_kind === 'unknown';
}

/** 必须是**认识**的图片片段（不认识的图形一律拒绝改写，R105/R110）。 */
function requirePicture(ref: DrawingRef): DrawingParams {
  if (ref.params === null) {
    throw new DocumentModelError(
      'unsupported',
      `该图形片段解析不出参数（可能是不认识的图形/对象）——不猜、不改写，原样保留`,
    );
  }
  if (ref.params.graphic_kind !== 'picture') {
    throw new DocumentModelError(
      'unsupported',
      `该片段是 ${ref.params.graphic_kind} 而非图片，图片操作不适用于它`,
    );
  }
  return ref.params;
}

// ---------------------------------------------------------------------------
// 段落 / run 重写
// ---------------------------------------------------------------------------

/** 一段 XML 里出现的全部关系引用取值（`r:embed` / `r:id` / `r:link`）。 */
export function referencedIdsInFragment(xml: string): readonly string[] {
  const ids: string[] = [];
  for (const match of xml.matchAll(/r:(?:embed|id|link)="([^"]+)"/g)) {
    const value = match[1];
    if (value !== undefined && !ids.includes(value)) {
      ids.push(value);
    }
  }
  return ids;
}

/** 文档里下一个 `wp:docPr@id`（OOXML 要求它在文档内唯一）。 */
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

/** 参数 + 关系 + 命名 → 重建 XML 的输入。 */
function toXmlInput(
  params: DrawingParams,
  relationshipId: string,
  docPrId: number,
): PictureXmlInput {
  return {
    relationship_id: relationshipId,
    extent: params.extent,
    rotation_degrees: params.rotation_degrees,
    crop: params.crop,
    wrap: params.wrap,
    anchor: params.anchor ?? DEFAULT_ANCHOR,
    alt: params.alt,
    doc_pr_id: docPrId,
    file_name: params.alt.name.length > 0 ? params.alt.name : 'image',
  };
}

// ---------------------------------------------------------------------------
// 插入
// ---------------------------------------------------------------------------

/** 插入图片请求。 */
export interface InsertImageRequest {
  readonly paragraph_id: NodeId;
  /** 插到段落的第几个行内节点之前；省略 = 追加到段落末尾。 */
  readonly inline_index?: number;
  readonly bytes: Uint8Array;
  readonly content_type: string;
  /** 部件路径（省略时自动取号 `word/media/imageN.<ext>`）。 */
  readonly part_name?: string;
  readonly width: Length;
  readonly height: Length;
  readonly rotation_degrees?: number;
  readonly crop?: CropRect;
  readonly wrap?: WrapMode;
  readonly anchor?: AnchorSpec;
  readonly alt?: Partial<AltText>;
}

/** 插入图片结果。 */
export interface InsertImageSuccess {
  readonly model: DocumentModel;
  readonly run_id: NodeId;
  readonly relationship_id: string;
  readonly part_path: string;
  readonly doc_pr_id: number;
  readonly xml: string;
}

/** 插入图片（WF-065）。包级三件套 + run 里的 `w:drawing` 一次装配到位。 */
export function insertImage(
  model: DocumentModel,
  request: InsertImageRequest,
): DrawingOutcome<InsertImageSuccess> {
  return runDrawingEdit(() => {
    const paragraph = requireParagraph(model, request.paragraph_id);
    const index = request.inline_index ?? paragraph.inlines.length;
    if (!Number.isInteger(index) || index < 0 || index > paragraph.inlines.length) {
      throw new DocumentModelError(
        'invalid_index',
        `行内插入位置越界：${String(index)}（该段共 ${String(paragraph.inlines.length)} 个行内节点）`,
      );
    }
    if (request.width.value <= 0 || request.height.value <= 0) {
      throw new DocumentModelError('invalid_node', '图片显示尺寸必须为正');
    }
    const crop = request.crop ?? NO_CROP;
    const cropIssue = cropProblem(crop);
    if (cropIssue !== null) {
      throw new DocumentModelError('invalid_node', cropIssue);
    }

    const registered = registerImageMedia(model, {
      bytes: request.bytes,
      content_type: request.content_type,
      ...(request.part_name === undefined ? {} : { part_name: request.part_name }),
    });
    const docPrId = nextDocPrId(registered.model);
    const alt: AltText = {
      name: request.alt?.name ?? `图片 ${String(docPrId)}`,
      description: request.alt?.description ?? '',
      title: request.alt?.title ?? null,
    };
    const xml = drawingXml({
      relationship_id: registered.relationship_id,
      extent: { cx: lengthToEmu(request.width), cy: lengthToEmu(request.height) },
      rotation_degrees: request.rotation_degrees ?? 0,
      crop,
      wrap: request.wrap ?? 'inline',
      anchor: request.anchor ?? DEFAULT_ANCHOR,
      alt,
      doc_pr_id: docPrId,
      file_name: `${registered.part_path.slice(registered.part_path.lastIndexOf('/') + 1)}`,
    });
    // 新 run 取新 id，既有 run 与它们的 id 原样不动（R101 的 id 稳定性）。
    const inserted = insertRunWithFragment(registered.model, request.paragraph_id, index, xml);
    return {
      model: inserted.model,
      run_id: inserted.run_id,
      relationship_id: registered.relationship_id,
      part_path: registered.part_path,
      doc_pr_id: docPrId,
      xml,
    };
  });
}


// ---------------------------------------------------------------------------
// 插入（类型化节点表示法，WCF-D40）
// ---------------------------------------------------------------------------

/** 插入图片（类型化 `DrawingNode` 表示法）请求。 */
export interface InsertImageDrawingRequest {
  readonly paragraph_id: NodeId;
  /** 插到段落的第几个行内节点之前；省略 = 追加到段落末尾。 */
  readonly inline_index?: number;
  readonly bytes: Uint8Array;
  readonly content_type: string;
  /** 部件路径（省略时自动取号 `word/media/imageN.<ext>`）。 */
  readonly part_name?: string;
  readonly width: Length;
  readonly height: Length;
  readonly rotation_degrees?: number;
  /** **模型的**环绕取值（`'inline'` / `'square'` / `'topAndBottom'` / `'behind'` / `'front'`）。 */
  readonly wrap?: DrawingNode['wrap'];
  readonly alt_text?: string | null;
}

/** 插入结果（类型化节点表示法）。 */
export interface InsertImageDrawingSuccess {
  readonly model: DocumentModel;
  /** 新建的 `DrawingNode` 的稳定 id（R101）。 */
  readonly node_id: NodeId;
  readonly relationship_id: string;
  readonly part_path: string;
}

/**
 * 插入图片 —— **类型化 `DrawingNode` 表示法**（WF-065；WCF-D40 接通导出侧）。
 *
 * ## 与 `insertImage` 的关系（**两条表示法，不是两套能力**）
 *
 * 同一张图片在模型里有两种可表达方式：
 *
 * | | 落点 | 导出路径 | 谁在用 |
 * |---|---|---|---|
 * | `insertImage` | 新 run 的 `opaque` 里一段 `raw_at_char` 的 `w:drawing` 文本 | 导出器**原样写回**未建模片段（R105 保真） | 导入来的图形、既有的"片段表示法" |
 * | `insertImageDrawing`（本函数） | 段落里一个 `DrawingNode`（类型化，带 `relationship_id`） | 导出器 `renderDrawingNode` **重建** `w:drawing` | 新插入的图片（模型答得上"它是什么"） |
 *
 * 本函数**不改** `insertImage`（既有调用方与用例的表示法不变）；它把 D30 建好的
 * 导出侧渲染桥（`src/documents/docx/drawing-render.ts`）真正接到一个**能产出
 * `DrawingNode` 的操作**上——在此之前，那条路没有任何生产入口。
 *
 * ## 包级三件套一次到位（R106）
 *
 * 媒体部件（字节）、主部件关系（`rId` 只增不重排）、`[Content_Types].xml` 的声明，
 * 由 `registerImageMedia` 一次装配；因此导出的 `r:embed` **不悬空**。
 *
 * ## 形状变了要重来（**不要指望它回头改 `insertImage` 的产物**）
 *
 * 图片参数（尺寸 / 旋转 / 裁剪 / 环绕 / 替代文字）的既有编辑操作
 * （`setImageSize` 等）是按**片段表示法**定位的（`run_id` + `opaque_index`）。
 * 本函数产出的是节点表示法，两者不通用——要合并成一套需要另一批设计。
 */
export function insertImageDrawing(
  model: DocumentModel,
  request: InsertImageDrawingRequest,
): DrawingOutcome<InsertImageDrawingSuccess> {
  return runDrawingEdit(() => {
    const paragraph = requireParagraph(model, request.paragraph_id);
    const index = request.inline_index ?? paragraph.inlines.length;
    if (!Number.isInteger(index) || index < 0 || index > paragraph.inlines.length) {
      throw new DocumentModelError(
        'invalid_index',
        `行内插入位置越界：${String(index)}（该段共 ${String(paragraph.inlines.length)} 个行内节点）`,
      );
    }
    if (request.width.value <= 0 || request.height.value <= 0) {
      throw new DocumentModelError('invalid_node', '图片显示尺寸必须为正');
    }

    const registered = registerImageMedia(model, {
      bytes: request.bytes,
      content_type: request.content_type,
      ...(request.part_name === undefined ? {} : { part_name: request.part_name }),
    });
    // 新节点取新 id（路径 = 段落路径 + drawing:index）；既有行内节点与它们的 id 原样不动（R101）。
    const nodePath = withSegment(pathOfExistingNode(request.paragraph_id, 'paragraph'), 'drawing', index);
    const nodeId = createNodeIdAllocator(collectNodeIds(registered.model)).allocate(nodePath);
    const node: DrawingNode = {
      id: nodeId,
      kind: 'drawing',
      source: 'user_request',
      opaque: [],
      drawing_type: 'picture',
      relationship_id: registered.relationship_id,
      extent: { width: request.width, height: request.height },
      rotation_deg: request.rotation_degrees ?? 0,
      wrap: request.wrap ?? 'inline',
      alt_text: request.alt_text ?? null,
    };
    const next: ParagraphNode = {
      ...paragraph,
      inlines: insertAt(paragraph.inlines, index, node),
    };
    return {
      model: withParagraph(registered.model, request.paragraph_id, next),
      node_id: nodeId,
      relationship_id: registered.relationship_id,
      part_path: registered.part_path,
    };
  });
}

// ---------------------------------------------------------------------------
// 替换 / 删除
// ---------------------------------------------------------------------------

/** 替换图片的字节（保持位置与参数，换媒体与关系）。 */
export function replaceImage(
  model: DocumentModel,
  request: {
    readonly run_id: NodeId;
    readonly opaque_index?: number;
    readonly bytes: Uint8Array;
    readonly content_type: string;
  },
): DrawingOutcome<{ readonly model: DocumentModel; readonly relationship_id: string; readonly part_path: string }> {
  return runDrawingEdit(() => {
    const ref = requireDrawing(model, request.run_id, request.opaque_index);
    const params = requirePicture(ref);
    if (params.relationship_id === null) {
      throw new DocumentModelError('invalid_relationship', '该图片片段没有 r:embed 关系可替换');
    }
    const docPrId = docPrIdOf(ref.xml) ?? nextDocPrId(model);
    // 先注册新图（新 rId 只增不复用），再把片段指向新 rId，最后删掉旧媒体。
    const registered = registerImageMedia(model, {
      bytes: request.bytes,
      content_type: request.content_type,
    });
    const xml = drawingXml(toXmlInput(params, registered.relationship_id, docPrId));
    const updated = withRunFragmentXml(registered.model, ref, xml);
    const cleaned = removeImageMedia(updated, params.relationship_id);
    return {
      model: cleaned,
      relationship_id: registered.relationship_id,
      part_path: registered.part_path,
    };
  });
}

function withRunFragmentXml(model: DocumentModel, ref: DrawingRef, xml: string): DocumentModel {
  const paragraph = requireParagraph(model, ref.paragraph_id);
  const run = requireRun(paragraph, ref.run_id);
  const updated: ParagraphNode = {
    ...paragraph,
    inlines: paragraph.inlines.map((inline) =>
      inline.id === ref.run_id ? withRunFragment(run, ref.opaque_index, xml) : inline,
    ),
  };
  return withParagraph(model, ref.paragraph_id, updated);
}

/** 删除图片请求。 */
export interface DeleteImageRequest {
  readonly run_id: NodeId;
  readonly opaque_index?: number;
  /**
   * 允许删除**认不出**的图形（默认 `false`）。
   *
   * 默认拒绝的理由：认不出就没法判断它引用了哪些关系/媒体，删了可能留下孤儿部件；
   * 传 `true` 时本函数仍会**尽力清理**该片段里出现的 `r:embed` / `r:id` / `r:link` 关系
   * 与对应媒体，但"这个图形到底是什么"仍然未知——后果由调用方承担。
   */
  readonly allow_unknown?: boolean;
}

/** 删除图片结果。 */
export interface DeleteImageSuccess {
  readonly model: DocumentModel;
  readonly removed_run: boolean;
  readonly removed_part_path: string | null;
}

/**
 * 删除图片（WF-065）。
 *
 * 三件事一起做：拿掉片段、拿掉包级三件套、run 变空则连 run 一起删。
 * 不做"只删 XML 留着媒体"这种半吊子——那会留下没人引用的媒体部件（也是脏）。
 */
export function deleteImage(
  model: DocumentModel,
  request: DeleteImageRequest,
): DrawingOutcome<DeleteImageSuccess> {
  return runDrawingEdit(() => {
    const ref = requireDrawing(model, request.run_id, request.opaque_index);
    if (isUnknownGraphic(ref) && request.allow_unknown !== true) {
      throw new DocumentModelError(
        'unsupported',
        '该图形认不出是什么（SmartArt/图表/嵌入对象，或解析失败）——默认不删，' +
          '避免留下孤儿关系/媒体；确需删除请显式传 allow_unknown: true',
      );
    }
    const paragraph = requireParagraph(model, ref.paragraph_id);
    const stripped = removeFragmentFromRun(paragraph, ref.run_id, ref.opaque_index);
    const runBecomesEmpty = stripped.run_removed;
    const withoutFragment = withParagraph(model, ref.paragraph_id, stripped.paragraph);

    let cleaned = withoutFragment;
    let removedPart: string | null = null;
    // 片段里出现的所有关系引用都要清理（认得出的图只有 r:embed，认不出的可能还有
    // r:id / r:link / r:dm 等）——否则会留下没人引用、也说不清归属的关系与媒体。
    for (const relationshipId of referencedIdsInFragment(ref.xml)) {
      const media = cleaned.media.find((part) => part.relationship_id === relationshipId);
      if (media !== undefined && removedPart === null) {
        removedPart = media.path;
      }
      try {
        cleaned = removeImageMedia(cleaned, relationshipId);
      } catch {
        // 该 rId 本来就没有媒体（例如超链接目标）：只删关系。
        cleaned = {
          ...cleaned,
          relationships: cleaned.relationships.filter((record) => record.id !== relationshipId),
        };
      }
    }
    return { model: cleaned, removed_run: runBecomesEmpty, removed_part_path: removedPart };
  });
}

// ---------------------------------------------------------------------------
// 尺寸 / 旋转 / 裁剪 / 环绕 / 替代文字（WF-066–069）
// ---------------------------------------------------------------------------

/** 就地改图片参数：读出现有参数 → 打补丁 → 重建 XML。 */
function mutateDrawing(
  model: DocumentModel,
  runId: NodeId,
  opaqueIndex: number | undefined,
  patch: (params: DrawingParams) => DrawingParams,
): { readonly model: DocumentModel; readonly params: DrawingParams; readonly xml: string } {
  const ref = requireDrawing(model, runId, opaqueIndex);
  const params = requirePicture(ref);
  const next = patch(params);
  if (next.relationship_id === null) {
    throw new DocumentModelError('invalid_relationship', '该图片片段没有 r:embed 关系');
  }
  const xml = drawingXml(toXmlInput(next, next.relationship_id, docPrIdOf(ref.xml) ?? 1));
  // **回读**自己写出去的 XML 作为权威参数：`next` 里手工改的字段（例如 wrap）不一定与
  // 真正写出的元素一致（innerHTML/container 之类的派生态），读回来才不会自欺。
  const readBack = parseDrawing(xml);
  return { model: withRunFragmentXml(model, ref, xml), params: readBack ?? next, xml };
}

/** 尺寸 / 旋转通用结果。 */
export interface ImageParamsSuccess {
  readonly model: DocumentModel;
  readonly params: DrawingParams;
  readonly xml: string;
}

/** 设置图片显示尺寸（WF-066）。 */
export interface SetImageSizeRequest {
  readonly run_id: NodeId;
  readonly opaque_index?: number;
  readonly width?: Length;
  readonly height?: Length;
  /**
   * 保持纵横比：
   * - 只给宽度时按**当前显示尺寸**的宽高比算高度；
   * - 只给高度时按同一比值算宽度。
   *
   * "当前显示尺寸的比值"是模型里**唯一已知**的比值来源——原图像素尺寸不在模型里，
   * 所以本包不去猜一个"原始比例"（要精确的原始比例，须在插入时把尺寸按原图给定）。
   */
  readonly keep_aspect_ratio?: boolean;
}

/** 设置显示尺寸（WF-066）。 */
export function setImageSize(
  model: DocumentModel,
  request: SetImageSizeRequest,
): DrawingOutcome<ImageParamsSuccess> {
  return runDrawingEdit(() =>
    mutateDrawing(model, request.run_id, request.opaque_index, (params) => {
      const keep = request.keep_aspect_ratio ?? false;
      const current = params.extent;
      if (current.cx <= 0 || current.cy <= 0) {
        throw new DocumentModelError('invalid_node', '当前图形尺寸非正，无法据此保持纵横比');
      }
      const ratio = current.cx / current.cy;
      let cx = request.width === undefined ? null : lengthToEmu(request.width);
      let cy = request.height === undefined ? null : lengthToEmu(request.height);
      if (cx !== null && cx <= 0) {
        throw new DocumentModelError('invalid_node', '宽度必须为正');
      }
      if (cy !== null && cy <= 0) {
        throw new DocumentModelError('invalid_node', '高度必须为正');
      }
      if (keep) {
        if (cx !== null && cy === null) {
          cy = Math.round(cx / ratio);
        } else if (cy !== null && cx === null) {
          cx = Math.round(cy * ratio);
        } else if (cx !== null && cy !== null) {
          // 两个都给还要求保持比例：以宽度为准算出高度（宽高比优先）。
          cy = Math.round(cx / ratio);
        }
      }
      if (cx === null && cy === null) {
        throw new DocumentModelError('invalid_node', '至少要给宽度或高度之一');
      }
      return {
        ...params,
        extent: { cx: cx ?? current.cx, cy: cy ?? current.cy },
      };
    }),
  );
}

/** 设置旋转角（WF-066）。负角按 OOXML 的 0–21600000 周期归一化。 */
export function setImageRotation(
  model: DocumentModel,
  request: { readonly run_id: NodeId; readonly opaque_index?: number; readonly degrees: number },
): DrawingOutcome<ImageParamsSuccess> {
  return runDrawingEdit(() => {
    if (!Number.isFinite(request.degrees)) {
      throw new DocumentModelError('invalid_node', '旋转角必须是有限数');
    }
    const normalized = ((request.degrees % 360) + 360) % 360;
    return mutateDrawing(model, request.run_id, request.opaque_index, (params) => ({
      ...params,
      rotation_degrees: normalized,
    }));
  });
}

/**
 * 设置裁剪参数（WF-067）。
 *
 * **只写 `a:srcRect`**：媒体字节不动（测试用 sha256 证明）。参数是**相对原图的比例**，
 * 例如 `{left: 0.1}` = 左边裁掉 10%。
 */
export function setImageCrop(
  model: DocumentModel,
  request: { readonly run_id: NodeId; readonly opaque_index?: number; readonly crop: CropRect },
): DrawingOutcome<ImageParamsSuccess> {
  return runDrawingEdit(() => {
    const issue = cropProblem(request.crop);
    if (issue !== null) {
      throw new DocumentModelError('invalid_node', issue);
    }
    return mutateDrawing(model, request.run_id, request.opaque_index, (params) => ({
      ...params,
      crop: request.crop,
    }));
  });
}

/** 设置环绕方式与锚点（WF-068）。 */
export function setImageWrap(
  model: DocumentModel,
  request: {
    readonly run_id: NodeId;
    readonly opaque_index?: number;
    readonly wrap: WrapMode;
    readonly anchor?: AnchorSpec;
  },
): DrawingOutcome<ImageParamsSuccess> {
  return runDrawingEdit(() =>
    mutateDrawing(model, request.run_id, request.opaque_index, (params) => ({
      ...params,
      wrap: request.wrap,
      anchor: request.wrap === 'inline' ? null : (request.anchor ?? params.anchor ?? DEFAULT_ANCHOR),
    })),
  );
}

/** 设置替代文字（WF-069）。 */
export function setAltText(
  model: DocumentModel,
  request: { readonly run_id: NodeId; readonly opaque_index?: number; readonly alt: Partial<AltText> },
): DrawingOutcome<ImageParamsSuccess> {
  return runDrawingEdit(() =>
    mutateDrawing(model, request.run_id, request.opaque_index, (params) => ({
      ...params,
      alt: {
        name: request.alt.name ?? params.alt.name,
        description: request.alt.description ?? params.alt.description,
        title: request.alt.title === undefined ? params.alt.title : request.alt.title,
      },
    })),
  );
}

/** 读回图片参数（不认识的图形 ⇒ `null`；不存在 ⇒ 抛）。 */
export function imageParams(
  model: DocumentModel,
  runId: NodeId,
  opaqueIndex?: number,
): DrawingParams | null {
  const ref = requireDrawing(model, runId, opaqueIndex);
  return ref.params;
}

/** 便捷：把 EMU 尺寸读成指定单位的 `Length` 对。 */
export function imageSizeIn(
  params: DrawingParams,
  unit: Length['unit'],
): { readonly width: Length; readonly height: Length } {
  return {
    width: emuToLength(params.extent.cx, unit),
    height: emuToLength(params.extent.cy, unit),
  };
}

// ---------------------------------------------------------------------------
// 题注（WF-069）
// ---------------------------------------------------------------------------

/** 满足"题注"语义的域指令前缀。 */
export const CAPTION_FIELD_KIND = 'SEQ';

/** 插入题注请求。 */
export interface SetCaptionRequest {
  readonly run_id: NodeId;
  /** 题注标签（`图` / `表`），默认 `图`。 */
  readonly label?: string;
  /** 标签与域之间的文字，默认空（Word 用空格）。 */
  readonly separator?: string;
  /** 题注段落里的说明文字（可为空）。 */
  readonly text?: string;
}

/** 插入题注结果。 */
export interface SetCaptionSuccess {
  readonly model: DocumentModel;
  readonly paragraph_id: NodeId;
  readonly field_instruction: string;
  /** **恒为 `'unknown'`**：写入域指令不等于消费端已算出编号（R158）。 */
  readonly refresh_state: 'unknown';
  readonly note: string;
}

/**
 * 给图片所在的段落**之后**插入一段题注（WF-069）。
 *
 * 题注号用 `SEQ <label> \* ARABIC` 域表达：**这只是指令**。本内核没有排版引擎，
 * 无法计算真实编号，因此 `cached_result` 留 `null`、`refresh_state` 标 `'unknown'`，
 * 结果里也把这件事写进 `note`——不得把"写了域指令"说成"题注编号已完成"（R158）。
 */
export function setCaption(
  model: DocumentModel,
  request: SetCaptionRequest,
): DrawingOutcome<SetCaptionSuccess> {
  return runDrawingEdit(() => {
    const ref = requireDrawing(model, request.run_id);
    requirePicture(ref);
    const location = findBlockLocation(model, ref.paragraph_id);
    if (location === null || location.container.kind !== 'body') {
      throw new DocumentModelError(
        'unsupported',
        '题注目前只支持正文段落里的图片（单元格内图片的题注序号语义未定义，不猜）',
      );
    }
    const label = request.label ?? '图';
    const instruction = `${CAPTION_FIELD_KIND} ${label} \\* ARABIC`;
    const caption: DraftInlineNode[] = [
      runNode({ text: `${label}${request.separator ?? ' '}`, source: 'system' }),
      fieldNode({
        instruction,
        cached_result: null,
        refresh_state: 'unknown',
        source: 'system',
      }),
      ...(request.text === undefined || request.text.length === 0
        ? []
        : [runNode({ text: ` ${request.text}`, source: 'system' })]),
    ];
    const outcome = applyStructureBatch(model, [
      {
        kind: 'insert_block',
        container: { kind: 'body' },
        index: location.index + 1,
        block: paragraphNode({ source: 'system', inlines: caption }),
      },
    ]);
    if (!outcome.ok) {
      throw new DocumentModelError(outcome.code, outcome.detail || '插入题注失败');
    }
    const inserted = outcome.model.blocks[location.index + 1];
    if (inserted === undefined) {
      throw new DocumentModelError('invalid_block_sequence', '插入题注后定位不到新段落（实现缺陷）');
    }
    return {
      model: outcome.model,
      paragraph_id: inserted.id,
      field_instruction: instruction,
      refresh_state: 'unknown' as const,
      note:
        '题注编号以域指令表达（SEQ）；写入指令 ≠ 已算出编号：本内核没有排版引擎，' +
        '真实编号需消费端刷新域后回读（R158）——未刷新前必须标"未验证"。',
    };
  });
}

/** 主部件路径的只读查询（供上层核对媒体归属）。 */
export function mainPart(model: DocumentModel): string {
  return mainDocumentPartPath(model);
}

/** 主部件现有关系数（诊断用）。 */
export function mainPartRelationshipCount(model: DocumentModel): number {
  return partRelationships(model, mainDocumentPartPath(model)).length;
}

/** 内容类型 → 扩展名（复用，供上层拼部件名）。 */
export function defaultExtensionFor(contentType: string): string {
  return extensionForContentType(contentType);
}

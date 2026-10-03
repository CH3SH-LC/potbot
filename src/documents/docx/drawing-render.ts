/**
 * **`DrawingNode` → `w:drawing`**（导出侧渲染桥；归属 WCF-D30 / design-05-P6 的导出收口）。
 *
 * ## 为什么需要它（以及它解决的是哪一段）
 *
 * `DrawingNode` 是**冻结模型里唯一"必须由导出器主动做事"的行内节点**：
 * 它只带 `relationship_id` 与 `extent`，而真正能被 Word 认的 `w:drawing` 需要
 * `wp:inline` → `wp:extent`（EMU）→ `a:graphic` → `pic:pic` → `a:blip@r:embed` 这一整棵子树。
 * 本模块把"模型字段 → 那棵子树"补齐，并在补齐之前**先把三种会产出坏包的情形挡掉**：
 *
 * | 情形 | 为什么必须先拒绝 | 抛出 |
 * |---|---|---|
 * | `drawing_type` 不是 `picture` / `chart`（形状 / 文本框） | 模型没有形状预设 / 文本框内容这些字段，写不出来 | `unsupported_drawing` |
 * | `relationship_id` 为空 | 图片没有数据源，`a:blip` 无从指向 | `unsupported_drawing` |
 * | `relationship_id` 在主部件关系表里查不到 | 会产出**悬空 `r:embed`**，真实 Word 会因此拒绝整个包 | `dangling_relationship_id` |
 * | `extent` 为空 | `wp:extent` 是必填的显示尺寸，导出器**不猜尺寸** | `unsupported_drawing` |
 *
 * ## 图表（WF-092 / design-05-P9）
 *
 * `drawing_type === 'chart'` 走**另一棵子树**：`w:drawing` → `wp:inline` → `a:graphic` →
 * `a:graphicData@uri="…/2006/chart"` → `c:chart@r:id`，子树构造在 `chart-render.ts`。
 * 判据也更强：关系不仅要存在，还必须是**图表关系**（`…/chart`）且目标部件在包里——
 * "一条页眉关系指向 chart1.xml"是类型错误的关系（R162）。
 *
 * ## 为什么不在这里手拼 XML（R107）
 *
 * `w:drawing` 的构造全仓只有**一处**：`operations/drawing/drawing-xml.ts` 的 `drawingElement`。
 * 本模块直接复用它，而不是在 `docx/**` 里复制一份——复制出第二个构造点，两边迟早发岔，
 * 而"转换集中"正是 R107 要的。代价是 `docx` → `operations/drawing` 的 import（包级双向、
 * 模块级无环：`drawing-xml.ts` 只 import `docx/xml-parse.ts`，不 import `docx/export.ts`）。
 * 若协调者要彻底归并，正确做法是**把 `drawing-xml.ts` 整体搬进 `docx/**`**，而不是让 `docx` 复制实现。
 *
 * ## 未建模字段的取值（**是默认值，不是"语义等价"**）
 *
 * 模型的 `DrawingNode` **有** `crop?`（2026-10-03 追加）：给了就照值写 `a:srcRect`，
 * **缺省**才取 `NO_CROP`（全 0，不裁剪）。此前恒写 `NO_CROP`，裁剪会被静默丢弃（W05 钉住的缺口）。
 * 仍未建模的字段：`anchor` 取 `DEFAULT_ANCHOR`（`wrap !== 'inline'` 时才用得上）、
 * `alt.name/title/description` 由 `alt_text` 与媒体文件名合成。
 * `wrap` 的 `'front'`（模型值）映射到 OOXML 的 `'inFront'`。这些映射都要连同"未验证"一起看。
 */

import { el, type XmlElement } from '../../artifacts/ooxml/xml.js';
import type {
  BlockNode,
  DrawingNode,
  MediaPart,
  RelationshipRecord,
} from '../model/types.js';
import { relationshipTypeHasSuffix } from '../model/preservation.js';
import { chartDrawingElement } from './chart-render.js';
import { DocxError } from './docx-error.js';
import { docPrIdOf, drawingElement, type PictureXmlInput } from '../operations/drawing/drawing-xml.js';
import { DEFAULT_ANCHOR, NO_CROP, lengthToEmu, type WrapMode } from '../operations/drawing/params.js';

/** 渲染一份 `DrawingNode` 需要知道的包级事实。 */
export interface DrawingRenderContext {
  /** 主部件自己的关系（`r:id` 的作用域是**每个部件一份**，正文里的引用只认这一份）。 */
  readonly main_part_relationships: readonly RelationshipRecord[];
  /** 主部件路径（用于把关系目标解析成包内路径）。 */
  readonly main_part_path: string;
  /** 包里**确实存在**的部件路径（`media[]` + `opaque_parts`）。 */
  readonly part_paths: ReadonlySet<string>;
  /** 媒体部件（取文件名与字节做交叉核对）。 */
  readonly media: readonly MediaPart[];
}

/** 模型 `wrap` → OOXML `WrapMode`（两者只差一个词：`front` ↔ `inFront`）。 */
function toWrapMode(wrap: DrawingNode['wrap']): WrapMode {
  switch (wrap) {
    case null:
    case 'inline':
      return 'inline';
    case 'square':
      return 'square';
    case 'topAndBottom':
      return 'topAndBottom';
    case 'behind':
      return 'behind';
    case 'front':
      return 'inFront';
  }
}

/** 关系目标 → 包内路径（与 `model/preservation.resolveRelationshipTarget` 同一口径的最小实现）。 */
function resolveTarget(ownerPartPath: string, target: string): string | null {
  if (target.startsWith('/')) {
    return target.replace(/^\/+/, '');
  }
  if (target.includes('\\') || target.includes(':')) return null;
  const base = ownerPartPath.slice(0, ownerPartPath.lastIndexOf('/') + 1);
  const stack: string[] = [];
  for (const segment of `${base}${target}`.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.length === 0 ? null : stack.join('/');
}

/** 路径最后一段（写进 `pic:cNvPr@name` / `wp:docPr@name`，仅供显示，不参与关系解析）。 */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * 这个图形**能不能**被导出器渲染。
 *
 * 判据与 `renderDrawingNode` 的拒绝条件一一对应（同一个真值来源，避免"能渲染但一渲染就抛"）。
 */
export function isRenderableDrawing(drawing: DrawingNode, context: DrawingRenderContext): boolean {
  if (drawing.relationship_id === null || drawing.relationship_id.length === 0) return false;
  if (drawing.extent === null) return false;
  if (drawing.drawing_type === 'chart') {
    return resolveChartPart(drawing.relationship_id, context) !== null;
  }
  if (drawing.drawing_type !== 'picture') return false;
  return resolvePicturePart(drawing.relationship_id, context) !== null;
}

/**
 * 图表关系 → 图表部件路径（WF-092）。
 *
 * 与 `resolvePicturePart` 同一套路，但多一条判据：**关系类型必须是图表**。只查"目标部件
 * 存在"是不够的——一条 `…/header` 关系指向 `word/charts/chart1.xml` 时目标确实存在，
 * 但把它当图表引用就是**类型错误的关系**（R162 的同一取向）。
 */
function resolveChartPart(
  relationshipId: string,
  context: DrawingRenderContext,
): { readonly partPath: string } | null {
  const record = context.main_part_relationships.find((item) => item.id === relationshipId);
  if (record === undefined) return null;
  if (record.target_mode !== 'Internal') return null;
  if (!relationshipTypeHasSuffix(record.type, 'chart')) return null;
  const resolved = resolveTarget(context.main_part_path, record.target);
  if (resolved === null || !context.part_paths.has(resolved)) return null;
  return { partPath: resolved };
}

/** 图片关系 → 包内路径；查不到 / 目标不在包里 ⇒ `null`（调用方据此报明确的拒绝原因）。 */
function resolvePicturePart(
  relationshipId: string,
  context: DrawingRenderContext,
): { readonly partPath: string; readonly filePath: string } | null {
  const record = context.main_part_relationships.find((item) => item.id === relationshipId);
  if (record === undefined) return null;
  if (record.target_mode !== 'Internal') return null;
  const resolved = resolveTarget(context.main_part_path, record.target);
  if (resolved === null || !context.part_paths.has(resolved)) return null;
  return { partPath: resolved, filePath: baseName(resolved) };
}

/**
 * 文档里已经用掉的 `wp:docPr@id` 最大值。
 *
 * `wp:docPr/@id` 在**文档内必须唯一**。模型里的 `DrawingNode` 不携带 docPr id，而未建模片段
 * （导入保留的 `w:drawing`、D05 以片段形式插入的图片）**带** id，因此分配前必须先扫一遍，
 * 否则新图形会和既有图形撞号。
 *
 * **已知缺口**：扫描只看未建模片段（`raw_at_char` / `raw_before_node` / `raw_before_block`）
 * 里的 `wp:docPr`；`wps:` 文本框等其它承载 docPr 的结构不在扫描范围。
 */
export function collectUsedDocPrIds(blocks: readonly BlockNode[]): number {
  let max = 0;
  const scanOpaque = (opaque: readonly unknown[]): void => {
    for (const item of opaque) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      const kind = record['kind'];
      if (kind !== 'raw_at_char' && kind !== 'raw_before_node' && kind !== 'raw_before_block') {
        continue;
      }
      const xml = record['xml'];
      if (typeof xml !== 'string') continue;
      const id = docPrIdOf(xml);
      if (id !== null && id > max) max = id;
    }
  };

  const visitBlocks = (list: readonly BlockNode[]): void => {
    for (const block of list) {
      scanOpaque(block.opaque);
      if (block.kind === 'paragraph') {
        for (const inline of block.inlines) scanOpaque(inline.opaque);
        continue;
      }
      for (const row of block.rows) {
        scanOpaque(row.opaque);
        for (const cell of row.cells) {
          scanOpaque(cell.opaque);
          visitBlocks(cell.blocks);
        }
      }
    }
  };

  visitBlocks(blocks);
  return max;
}

/**
 * 渲染一份 `DrawingNode` 为 `<w:drawing>` 元素。
 *
 * @param nextDocPrId 分配下一个**未占用**的 `wp:docPr@id`（由调用方持有计数器，
 *   保证同一份文档里多次渲染不撞号）。**只有确实要写出图形时才会被调用**——
 *   拒绝路径不消耗编号。
 * @throws {DocxError} 见文件头的四种拒绝情形；任何一条不满足都**不产出半成品**（R140/R154）。
 */
export function renderDrawingNode(
  drawing: DrawingNode,
  context: DrawingRenderContext,
  nextDocPrId: () => number,
): XmlElement {
  const relationshipId = drawing.relationship_id;

  // 图表（WF-092）：`w:drawing` → `c:chart@r:id` → `word/charts/chartN.xml`。
  // 图表部件本身与它的关系由 `export.ts` 按 `charts` 选项写入，本函数只负责**引用**；
  // 关系查不到 / 不是图表关系 / 目标部件不在包里 ⇒ 拒绝（悬空引用会让 Word 拒开整包）。
  if (drawing.drawing_type === 'chart') {
    if (relationshipId === null || relationshipId.length === 0) {
      throw new DocxError(
        'unsupported_chart_part',
        'chart 类型的 DrawingNode 没有 relationship_id：没有数据源的图表框写出去就是一个空引用。',
      );
    }
    if (resolveChartPart(relationshipId, context) === null) {
      throw new DocxError(
        'unsupported_chart_part',
        `图表关系 ${relationshipId} 在主部件关系表里没有落点（或它不是一条 …/chart 关系，` +
          '又或它指向的图表部件不在包里）：照写会产出悬空的图表引用，真实 Word 会拒开整个包（R106/R162）。',
      );
    }
    const chartExtent = drawing.extent;
    if (chartExtent === null) {
      throw new DocxError(
        'unsupported_chart_part',
        'chart 类型的 DrawingNode 没有 extent：wp:extent 是必填的显示尺寸，导出器不猜尺寸。',
      );
    }
    return chartDrawingElement({
      relationship_id: relationshipId,
      extent: { width: chartExtent.width, height: chartExtent.height },
      doc_pr_id: nextDocPrId(),
      alt_text: drawing.alt_text ?? '',
    });
  }

  if (drawing.drawing_type !== 'picture') {
    throw new DocxError(
      'unsupported_drawing',
      `图形种类 ${drawing.drawing_type} 还没有导出器支持：模型里没有形状预设 / 文本框内容` +
        '这类字段，写出来的图形会与模型说的不是一回事。导出器宁可显式拒绝（R140）。',
    );
  }
  if (relationshipId === null || relationshipId.length === 0) {
    throw new DocxError(
      'unsupported_drawing',
      'picture 类型的 DrawingNode 没有 relationship_id：没有数据源的图片写出去就是一个空 blip。',
    );
  }
  const resolved = resolvePicturePart(relationshipId, context);
  if (resolved === null) {
    throw new DocxError(
      'dangling_relationship_id',
      `图片关系 ${relationshipId} 在主部件关系表里没有落点（或它的目标不在包里）：` +
        '照写会产出悬空 r:embed，真实 Word 会因此拒绝整个包（R106/R160）。',
    );
  }
  const extent = drawing.extent;
  if (extent === null) {
    throw new DocxError(
      'unsupported_drawing',
      'DrawingNode 没有 extent：wp:extent 是必填的显示尺寸，导出器不猜尺寸' +
        '（拍一个"差不多"的尺寸等于替用户决定排版）。',
    );
  }

  const altText = drawing.alt_text;
  const input: PictureXmlInput = {
    relationship_id: relationshipId,
    extent: { cx: lengthToEmu(extent.width), cy: lengthToEmu(extent.height) },
    rotation_degrees: drawing.rotation_deg,
    // `DrawingNode.crop?`（比例）→ `a:srcRect`（千分比）；缺省 = 不裁剪（NO_CROP）。
    // 裁剪只写参数，不动媒体字节（判据明令，W05 用 sha256 证明）。
    crop: drawing.crop ?? NO_CROP,
    wrap: toWrapMode(drawing.wrap),
    anchor: DEFAULT_ANCHOR,
    alt: {
      name: altText !== null && altText.length > 0 ? altText : resolved.filePath,
      description: altText ?? '',
      title: null,
    },
    doc_pr_id: nextDocPrId(),
    file_name: resolved.filePath,
  };
  return drawingElement(input);
}

/** 组装渲染上下文：关系只取**主部件自己**那一份（`r:id` 的作用域是每部件一份）。 */
export function drawingContext(
  mainPartPath: string,
  relationships: readonly RelationshipRecord[],
  partPaths: ReadonlySet<string>,
  media: readonly MediaPart[],
): DrawingRenderContext {
  return {
    main_part_relationships: relationships.filter(
      (record) => record.owner_part_path === mainPartPath,
    ),
    main_part_path: mainPartPath,
    part_paths: partPaths,
    media,
  };
}

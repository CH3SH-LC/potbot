/**
 * **W-R04 — 编辑对象定位（edit-object targeting）与布局 fixture。**
 *
 * ## 这一层解决什么
 *
 * 手机上"点一个字符把光标放那儿""点一张图选中它"都要求把**屏幕触摸点**映射到
 * **文档位置**，而文档位置的偏移空间是**码位**（R102，见 `selection/types.ts`）。
 * 宿主（WebView / 原生 View）拿到的是 dp 坐标；本模块把 dp → (段落 id, 码位下标) 做成
 * 一个**纯函数**，并区分"落在文字上（caret）"与"落在不可编辑对象上（object）"。
 *
 * ## 为什么必须锚定码位而不是 UTF-16
 *
 * 触摸点若按 UTF-16 码元取整，会让"点 emoji 中间"落到**代理对内部**，进而把位置
 * 换算成一个非法字符串下标。本模块的行盒 `start/end` 一律是**码位**，因此取整结果天然
 * 落在码位边界上，不可能落在代理对内部。
 *
 * ## 布局 fixture 的诚实边界（不许编造）
 *
 * 真实分页/换行计算属于 W09（`PotbotPdfLayout.java` 与 `mobile-plugins/word/rendering/`），
 * 本节不做真实排版。`hitTest` 消费的是**记录好的行盒 fixture**，其 `verificationMode`
 * 固定为 `'fixture'`，且**绝不返回页码**——页码语义属 W04。若调用方拿着 fixture 结果
 * 宣称"已按真实布局定位"，那是误用；见模块返回类型里没有 `page_number` 字段即为此约束。
 */

import type { DocumentModel, InlineNode, NodeId } from '../../../../src/documents/model/types.js';
import { buildInlineTextMap } from '../../../../src/documents/selection/inline-map.js';
import { requireParagraph } from '../../../../src/documents/selection/structure.js';
import { fail, succeed, type DocumentRange, type Result } from '../../../../src/documents/selection/types.js';

/** 一行行盒：`[start, end)` 是**码位**区间；`x0Dp/x1Dp/topDp/bottomDp` 是 dp 几何。 */
export interface LineBox {
  readonly start: number;
  readonly end: number;
  readonly x0Dp: number;
  readonly x1Dp: number;
  readonly topDp: number;
  readonly bottomDp: number;
}

/** 一段的布局：行盒按阅读顺序排列。`source` 只能是记录 fixture。 */
export interface ParagraphLayout {
  readonly node_id: NodeId;
  readonly source: 'fixture';
  readonly lines: readonly LineBox[];
}

/** 布局 fixture 的元数据。`verificationMode` 只允许 `'fixture'`——真实布局未实现。 */
export interface LayoutFixture {
  readonly verificationMode: 'fixture';
  readonly note: string;
  readonly paragraphs: readonly ParagraphLayout[];
}

/** 触摸落点（dp，相对文档内容区左上角）。 */
export interface TouchPoint {
  readonly xDp: number;
  readonly yDp: number;
}

/** 落在文字上：光标位。 */
export interface CaretTarget {
  readonly kind: 'caret';
  readonly node_id: NodeId;
  /** 段落内码位下标，落在 `[0, paragraphLength]`。 */
  readonly offset: number;
  /** 命中的行盒下标（便于宿主画光标）。 */
  readonly lineIndex: number;
}

/** 不可编辑行内对象的类别（与 `InlineSegment.kind` 对齐，去掉 `run`）。 */
export type EditObjectKind = 'break' | 'field' | 'drawing' | 'equation';

/** 落在不可编辑对象上：整体对象选区（占且仅占其码位区间）。 */
export interface ObjectTarget {
  readonly kind: 'object';
  readonly node_id: NodeId;
  readonly objectKind: EditObjectKind;
  /** 覆盖该对象的完整码位区间（对 drawing/equation 恰为 1 码位）。 */
  readonly range: DocumentRange;
  /** 对象按定义不可编辑：选区可覆盖、字符格式不可施加。 */
  readonly editable: false;
  /** 无障碍可读标签（图片取 alt_text；公式/域取既定占位文案）。 */
  readonly label: string | null;
}

export type EditTarget = CaretTarget | ObjectTarget;

/** 行盒命中的内部结构。 */
interface LineHit {
  readonly paragraph: ParagraphLayout;
  readonly line: LineBox;
  readonly lineIndex: number;
}

/** 竖直方向距离：点在行盒区间内为 0，否则到最近边界。 */
function verticalDistance(point: TouchPoint, line: LineBox): number {
  if (point.yDp < line.topDp) return line.topDp - point.yDp;
  if (point.yDp >= line.bottomDp) return point.yDp - line.bottomDp;
  return 0;
}

/** 在所有 fixture 行盒里挑竖直最近的一行（含并列时靠前者）。 */
function nearestLine(fixture: LayoutFixture, point: TouchPoint): LineHit | null {
  let best: LineHit | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const paragraph of fixture.paragraphs) {
    for (let lineIndex = 0; lineIndex < paragraph.lines.length; lineIndex += 1) {
      const line = paragraph.lines[lineIndex]!;
      const distance = verticalDistance(point, line);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { paragraph, line, lineIndex };
        if (distance === 0) return best; // 落在行内即为最优，无需继续扫。
      }
    }
  }
  return best;
}

/** 对象标签：图片取替代文字，公式/域取既定可读文案。 */
export function objectLabel(node: InlineNode): string | null {
  switch (node.kind) {
    case 'drawing':
      return node.alt_text;
    case 'equation':
      return '(公式)';
    case 'field':
      return node.cached_result ?? node.instruction;
    case 'break':
      return null;
    case 'run':
      return node.text;
  }
}

/** 段落内承载 `offset` 的**不可编辑**片段（若有）。 */
function nonEditableSegmentAt(
  inlines: readonly InlineNode[],
  offset: number,
): { kind: EditObjectKind; start: number; end: number; inlineIndex: number } | null {
  const map = buildInlineTextMap(inlines);
  for (const segment of map.segments) {
    if (segment.kind === 'run') continue;
    // 落点严格在该片段内部（含末位对齐到片段起点）时判定为对象命中。
    if (segment.start <= offset && offset < segment.end) {
      return { kind: segment.kind as EditObjectKind, start: segment.start, end: segment.end, inlineIndex: segment.inlineIndex };
    }
  }
  return null;
}

/**
 * 触摸点 → 编辑目标。竖直取最近行盒；水平按行盒宽度线性取整到**码位**下标；
 * 若该下标落在不可编辑片段内，返回整体对象选区。
 *
 * 失败：`unknown_node`（fixture 里的段落不在模型中）；`not_found`（fixture 无线盒或该段无行盒）。
 * 返回的 `EditTarget` **不含** `page_number` 字段——fixture 布局不产生页码（W04 领域）。
 */
export function hitTest(model: DocumentModel, fixture: LayoutFixture, point: TouchPoint): Result<EditTarget> {
  if (!Number.isFinite(point.xDp) || !Number.isFinite(point.yDp)) {
    return fail('invalid_range', `触摸点坐标必须是有限数：(${point.xDp}, ${point.yDp})。`, {
      extra: { xDp: String(point.xDp), yDp: String(point.yDp) },
    });
  }
  const hit = nearestLine(fixture, point);
  if (hit === null) {
    return fail('not_found', '布局 fixture 里没有任何行盒，无法定位。', { extra: { paragraphs: fixture.paragraphs.length } });
  }

  const paragraph = requireParagraph(model, hit.paragraph.node_id);
  if (!paragraph.ok) return paragraph;

  const inlines = paragraph.value.inlines;
  const map = buildInlineTextMap(inlines);
  // fixture 的行盒偏移必须落在段落码位长度内，否则是 fixture 与文档对不上。
  if (hit.line.start < 0 || hit.line.end > map.total || hit.line.start > hit.line.end) {
    return fail('invalid_range', `行盒 [${hit.line.start}, ${hit.line.end}) 超出段落 "${hit.paragraph.node_id}" 的码位长度 ${map.total}。`, {
      extra: { node_id: hit.paragraph.node_id, lineStart: hit.line.start, lineEnd: hit.line.end, total: map.total },
    });
  }

  const width = hit.line.x1Dp - hit.line.x0Dp;
  const span = hit.line.end - hit.line.start;
  const fraction = width <= 0 ? 0 : Math.min(1, Math.max(0, (point.xDp - hit.line.x0Dp) / width));
  let offset = hit.line.start + Math.round(fraction * span);
  offset = Math.min(hit.line.end, Math.max(hit.line.start, offset));

  const object = nonEditableSegmentAt(inlines, offset);
  if (object !== null) {
    const node = inlines[object.inlineIndex]!;
    return succeed({
      kind: 'object',
      node_id: hit.paragraph.node_id,
      objectKind: object.kind,
      range: { node_id: hit.paragraph.node_id, start: object.start, end: object.end },
      editable: false,
      label: objectLabel(node),
    });
  }

  return succeed({ kind: 'caret', node_id: hit.paragraph.node_id, offset, lineIndex: hit.lineIndex });
}

/**
 * 无障碍焦点顺序：一个段落里，正文文本折算为**一个**文本目标（覆盖整段），
 * 每个嵌入对象（图片/公式/域）单独一个目标，按文档顺序排列。
 * 宿主据此渲染虚拟视图树；对象的 `label` 为空时仍保留条目（可读文案由 UI 兜底）。
 */
export interface FocusTarget {
  readonly index: number;
  readonly kind: 'text' | EditObjectKind;
  readonly node_id: NodeId;
  readonly range: DocumentRange;
  readonly label: string | null;
  readonly editable: boolean;
}

export function accessibilityFocusOrder(model: DocumentModel, nodeId: NodeId): Result<readonly FocusTarget[]> {
  const paragraph = requireParagraph(model, nodeId);
  if (!paragraph.ok) return paragraph;
  const inlines = paragraph.value.inlines;
  const map = buildInlineTextMap(inlines);

  const targets: FocusTarget[] = [];
  if (map.total > 0) {
    targets.push({
      index: targets.length,
      kind: 'text',
      node_id: nodeId,
      range: { node_id: nodeId, start: 0, end: map.total },
      label: null,
      editable: true,
    });
  }
  for (const segment of map.segments) {
    if (segment.kind === 'run') continue;
    const node = inlines[segment.inlineIndex]!;
    targets.push({
      index: targets.length,
      kind: segment.kind as EditObjectKind,
      node_id: nodeId,
      range: { node_id: nodeId, start: segment.start, end: segment.end },
      label: objectLabel(node),
      editable: false,
    });
  }
  return succeed(targets);
}

/** 供测试与宿主复算：把一段的码位区间映射回行盒下标（不在任何行盒内时返回 -1）。 */
export function lineIndexOfOffset(fixture: LayoutFixture, nodeId: NodeId, offset: number): number {
  const paragraph = fixture.paragraphs.find((p) => p.node_id === nodeId);
  if (paragraph === undefined) return -1;
  for (let i = 0; i < paragraph.lines.length; i += 1) {
    const line = paragraph.lines[i]!;
    if (line.start <= offset && offset <= line.end) return i;
  }
  return -1;
}

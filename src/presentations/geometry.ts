/**
 * 演示域**几何与层级操作**（PPT-05：对象尺寸 / 坐标 / 旋转、对齐 / 分布、前后层级、
 * 组合 / 取消组合；**位置关系在保存重开后保持**）。
 *
 * ## 与 `operations.ts` 的分工
 *
 * `operations.ts` 已有 `moveShape` / `rotateShape` / `reorderShape` / `alignShapes` /
 * `distributeShapes` / `groupShapes` / `ungroupShapes` 等原语。本模块在**不改动**它们的前提下：
 *
 * - 用「整框设坐标」（`setBounds`）、「带锚点的改尺寸」（`resizeShape`）、「翻转」（`flipShape`）、
 *   「对齐到幻灯片」（`alignSelectionToSlide`）、「固定间距分布」（`distributeWithGap`）、
 *   「自动分配组合 id 的组合」（`groupSelection`）把 PPT-05 的常用动作补齐；
 * - 提供 `relativeGeometry` —— 把一组对象的**位置关系**（各自绝对几何、两两相对偏移、尺寸差、
 *   层级）压成一个可比较的快照。用例先记一份，把模型渲染成 PPTX 再导入回来，再记一份，
 *   两份**逐字段相等**即证明「位置关系保存重开后保持」。这不是描述文字，是字节往返后的读回值。
 *
 * ## 为什么能往返
 *
 * `render.ts` 对每个形状发射 `a:xfrm`（`a:off` / `a:ext` / `@rot` / `@flipH` / `@flipV`），
 * `roundtrip.ts` 的 `parseTransform` 按同一口径读回（角度除以 60000，翻转读 `'1'`）。
 * 因此 `x / y / cx / cy / rotation / flip` 六项在"渲染 → 导入"后**逐值一致**；数组顺序 = z 序，
 * 渲染与导入都按文档顺序，故 **z 序也保持**。
 */

import { ValidationError } from '../protocol/index.js';

import {
  alignShapes,
  distributeShapes,
  groupShapes,
  nextAvailableShapeId,
  reorderShape,
  rotateShape,
  ungroupShapes,
  updateShapeTransform,
} from './operations.js';
import { transform as makeTransform } from './model.js';
import type { AlignEdge, Presentation, Shape, SlideSize, Transform } from './model.js';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 几何操作的具名失败面（**不静默**）。 */
export type GeometryErrorReason =
  | 'unknown_slide'
  | 'unknown_shape'
  | 'empty_selection'
  | 'insufficient_selection'
  | 'invalid_bounds'
  | 'duplicate_shape_id';

/** 几何操作在语义不成立时抛出的错误。 */
export class GeometryError extends ValidationError {
  readonly reason: GeometryErrorReason;

  constructor(reason: GeometryErrorReason, message: string) {
    super(message);
    this.name = 'GeometryError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 基础读数
// ---------------------------------------------------------------------------

/** 对象在页内的矩形（EMU）。 */
export interface Bounds {
  readonly x_emu: number;
  readonly y_emu: number;
  readonly cx_emu: number;
  readonly cy_emu: number;
}

/** 一个对象的几何读数（含层级）。 */
export interface ShapeGeometry extends Bounds {
  readonly shape_id: number;
  readonly rotation_deg: number;
  readonly flip_h: boolean;
  readonly flip_v: boolean;
  /** 在页内的 z 序（0 = 最底层）。 */
  readonly z_index: number;
  /**
   * 该对象所属**组合**的 shape_id（顶层对象 = `null`）。
   * 仅在 `relativeGeometry(..., { include_nested: true })` 下填写；缺省路径不产生本字段。
   */
  readonly parent_group_id?: number | null;
  /** 组合嵌套深度（顶层 = 0；组合的直接子对象 = 1；以此类推）。仅 `include_nested` 下填写。 */
  readonly depth?: number;
  /**
   * 相对**宿主组合原点**的偏移（`dx_emu = 本对象有效 x − 组合有效 x`）。
   * 顶层对象 = `null`。仅 `include_nested` 下填写。见下方「组合内相对几何」说明。
   */
  readonly offset_in_group_emu?: { readonly dx_emu: number; readonly dy_emu: number } | null;
}

/** 两个对象之间的相对偏移与尺寸差。 */
export interface PairOffset {
  readonly a: number;
  readonly b: number;
  readonly dx_emu: number;
  readonly dy_emu: number;
  readonly dcx_emu: number;
  readonly dcy_emu: number;
}

/** 一组对象的**位置关系快照**（保存重开后逐字段相等 = 位置关系保持）。 */
export interface RelativeGeometry {
  readonly slide_size: SlideSize;
  readonly shapes: readonly ShapeGeometry[];
  readonly pairs: readonly PairOffset[];
}

/** 取对象的矩形。 */
export function boundsOf(shape: Shape): Bounds {
  const t = shape.transform;
  return { x_emu: t.x_emu, y_emu: t.y_emu, cx_emu: t.cx_emu, cy_emu: t.cy_emu };
}

function requireSlideShapes(presentation: Presentation, slideId: number): readonly Shape[] {
  const slide = presentation.slides.find((candidate) => candidate.slide_id === slideId);
  if (slide === undefined) {
    throw new GeometryError('unknown_slide', `找不到幻灯片 slide_id=${String(slideId)}`);
  }
  return slide.shapes;
}

/** 递归查找顶层或组合内的对象。 */
function findShape(shapes: readonly Shape[], shapeId: number): Shape | undefined {
  for (const shape of shapes) {
    if (shape.shape_id === shapeId) return shape;
    if (shape.kind === 'group') {
      const found = findShape(shape.children, shapeId);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function requireShape(presentation: Presentation, slideId: number, shapeId: number): Shape {
  const shape = findShape(requireSlideShapes(presentation, slideId), shapeId);
  if (shape === undefined) {
    throw new GeometryError('unknown_shape', `找不到对象 shape_id=${String(shapeId)}`);
  }
  return shape;
}

/** 校验一组选中对象都在页上；返回它们（顶层或组合内均可）。 */
function requireSelection(presentation: Presentation, slideId: number, shapeIds: readonly number[]): readonly Shape[] {
  const shapes = requireSlideShapes(presentation, slideId);
  return shapeIds.map((shapeId) => {
    const shape = findShape(shapes, shapeId);
    if (shape === undefined) {
      throw new GeometryError('unknown_shape', `找不到对象 shape_id=${String(shapeId)}`);
    }
    return shape;
  });
}

// ---------------------------------------------------------------------------
// 尺寸 / 坐标 / 旋转 / 翻转（PPT-05）
// ---------------------------------------------------------------------------

/** 整框设坐标与尺寸（一次设定 `x/y/cx/cy`，旋转 / 翻转沿用原值）。 */
export function setBounds(presentation: Presentation, slideId: number, shapeId: number, bounds: Bounds): Presentation {
  if (bounds.cx_emu < 0 || bounds.cy_emu < 0) {
    throw new GeometryError('invalid_bounds', `尺寸不能为负：cx=${String(bounds.cx_emu)} cy=${String(bounds.cy_emu)}`);
  }
  const current = requireShape(presentation, slideId, shapeId).transform;
  const next: Transform = { ...current, ...bounds };
  return updateShapeTransform(presentation, slideId, shapeId, next);
}

/** 改尺寸时哪个锚点保持不动（九宫格）。 */
export type ResizeAnchor =
  | 'top_left'
  | 'top_center'
  | 'top_right'
  | 'center_left'
  | 'center'
  | 'center_right'
  | 'bottom_left'
  | 'bottom_center'
  | 'bottom_right';

/** 锚点在框内的归一化坐标（fx 横向 0=左 1=右，fy 纵向 0=上 1=下）。 */
const RESIZE_ANCHOR_FRACTIONS: Readonly<Record<ResizeAnchor, { readonly fx: number; readonly fy: number }>> =
  Object.freeze({
    top_left: { fx: 0, fy: 0 },
    top_center: { fx: 0.5, fy: 0 },
    top_right: { fx: 1, fy: 0 },
    center_left: { fx: 0, fy: 0.5 },
    center: { fx: 0.5, fy: 0.5 },
    center_right: { fx: 1, fy: 0.5 },
    bottom_left: { fx: 0, fy: 1 },
    bottom_center: { fx: 0.5, fy: 1 },
    bottom_right: { fx: 1, fy: 1 },
  });

/**
 * 改尺寸；`anchor` 决定九宫格里哪个点保持不动（缺省 = 左上角）。
 *
 * `anchor='center'` 与旧版一致：宽高各补偿差分的一半。`top_right` / `bottom_left` / … 是
 * 本次补齐的锚点——它们对"从一个角拖动缩放而不动对角"是必需的。
 */
export function resizeShape(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  cx_emu: number,
  cy_emu: number,
  options?: { readonly anchor?: ResizeAnchor },
): Presentation {
  if (cx_emu < 0 || cy_emu < 0) {
    throw new GeometryError('invalid_bounds', `尺寸不能为负：cx=${String(cx_emu)} cy=${String(cy_emu)}`);
  }
  const t = requireShape(presentation, slideId, shapeId).transform;
  const anchor = options?.anchor ?? 'top_left';
  const fractions = RESIZE_ANCHOR_FRACTIONS[anchor];
  const x = t.x_emu + Math.round((t.cx_emu - cx_emu) * fractions.fx);
  const y = t.y_emu + Math.round((t.cy_emu - cy_emu) * fractions.fy);
  return updateShapeTransform(presentation, slideId, shapeId, { ...t, x_emu: x, y_emu: y, cx_emu, cy_emu });
}

/** 移到绝对坐标 `(x, y)`（尺寸不变）。 */
export function moveShapeTo(presentation: Presentation, slideId: number, shapeId: number, x_emu: number, y_emu: number): Presentation {
  const t = requireShape(presentation, slideId, shapeId).transform;
  return updateShapeTransform(presentation, slideId, shapeId, { ...t, x_emu, y_emu });
}

/** 相对平移（在 `operations.moveShape` 之上加"目标必须存在"的前置校验）。 */
export function nudgeShape(presentation: Presentation, slideId: number, shapeId: number, dx_emu: number, dy_emu: number): Presentation {
  const t = requireShape(presentation, slideId, shapeId).transform;
  return updateShapeTransform(presentation, slideId, shapeId, { ...t, x_emu: t.x_emu + dx_emu, y_emu: t.y_emu + dy_emu });
}

/** 设旋转角（度），归一化到 `[0, 360)`。 */
export function rotateShapeTo(presentation: Presentation, slideId: number, shapeId: number, rotationDeg: number): Presentation {
  return rotateShape(presentation, slideId, shapeId, rotationDeg);
}

/** 设翻转（`'h'` / `'v'` / `'both'` / `'none'`）。 */
export function flipShape(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  axis: 'h' | 'v' | 'both' | 'none',
): Presentation {
  const t = requireShape(presentation, slideId, shapeId).transform;
  const flip_h = axis === 'h' || axis === 'both';
  const flip_v = axis === 'v' || axis === 'both';
  return updateShapeTransform(presentation, slideId, shapeId, { ...t, flip_h, flip_v });
}

// ---------------------------------------------------------------------------
// 对齐 / 分布（PPT-05）
// ---------------------------------------------------------------------------

/** 对齐若干对象（委托原语）。 */
export function alignSelection(presentation: Presentation, slideId: number, shapeIds: readonly number[], edge: AlignEdge): Presentation {
  return alignShapes(presentation, slideId, shapeIds, edge);
}

/**
 * **对齐到幻灯片**（原语没有的语义）：把选中对象的**整体外框**贴到页面边缘 / 居中。
 *
 * 与 `alignShapes`（相互对齐）不同：这里基准是页面 `[0, size]`，选中的对象作为**一个整体**平移，
 * 因此它们彼此的相对位置不变。少于 1 个对象 ⇒ 具名报错。
 */
export function alignSelectionToSlide(
  presentation: Presentation,
  slideId: number,
  shapeIds: readonly number[],
  edge: AlignEdge,
): Presentation {
  if (shapeIds.length < 1) {
    throw new GeometryError('empty_selection', '对齐到幻灯片至少需要 1 个对象');
  }
  const selected = requireSelection(presentation, slideId, shapeIds);
  const left = Math.min(...selected.map((shape) => shape.transform.x_emu));
  const right = Math.max(...selected.map((shape) => shape.transform.x_emu + shape.transform.cx_emu));
  const top = Math.min(...selected.map((shape) => shape.transform.y_emu));
  const bottom = Math.max(...selected.map((shape) => shape.transform.y_emu + shape.transform.cy_emu));
  const { cx_emu, cy_emu } = presentation.size;
  let dx = 0;
  let dy = 0;
  switch (edge) {
    case 'left':
      dx = -left;
      break;
    case 'right':
      dx = cx_emu - right;
      break;
    case 'center_h':
      dx = Math.round(cx_emu / 2) - Math.round((left + right) / 2);
      break;
    case 'top':
      dy = -top;
      break;
    case 'bottom':
      dy = cy_emu - bottom;
      break;
    case 'center_v':
      dy = Math.round(cy_emu / 2) - Math.round((top + bottom) / 2);
      break;
  }
  let next = presentation;
  for (const shapeId of shapeIds) {
    const t = requireShape(next, slideId, shapeId).transform;
    next = updateShapeTransform(next, slideId, shapeId, { ...t, x_emu: t.x_emu + dx, y_emu: t.y_emu + dy });
  }
  return next;
}

/**
 * **对齐到关键对象**（PowerPoint 的"对齐到所选基准对象"）：以 `anchorShapeId` 的框为基准，
 * 把每个 `shapeIds` 里的对象各自的对应边贴到基准对象的对应边上。
 *
 * 与 `alignShapes`（用**选区自身**的外框）和 `alignSelectionToSlide`（用**页面**）都不同：
 * 这里的基准是**另一个对象的框**。基准对象自身（若在选区里）不动。
 *
 * @throws {GeometryError} 选区为空（`empty_selection`）或基准对象不存在（`unknown_shape`）。
 */
export function alignSelectionToShape(
  presentation: Presentation,
  slideId: number,
  shapeIds: readonly number[],
  anchorShapeId: number,
  edge: AlignEdge,
): Presentation {
  if (shapeIds.length < 1) {
    throw new GeometryError('empty_selection', '对齐到关键对象至少需要 1 个对象');
  }
  const anchor = requireShape(presentation, slideId, anchorShapeId).transform;
  const anchorLeft = anchor.x_emu;
  const anchorRight = anchor.x_emu + anchor.cx_emu;
  const anchorCenterX = anchorLeft + Math.round(anchor.cx_emu / 2);
  const anchorTop = anchor.y_emu;
  const anchorBottom = anchor.y_emu + anchor.cy_emu;
  const anchorCenterY = anchorTop + Math.round(anchor.cy_emu / 2);

  let next = presentation;
  for (const shapeId of shapeIds) {
    if (shapeId === anchorShapeId) continue;
    const t = requireShape(next, slideId, shapeId).transform;
    switch (edge) {
      case 'left':
        next = updateShapeTransform(next, slideId, shapeId, { ...t, x_emu: anchorLeft });
        break;
      case 'right':
        next = updateShapeTransform(next, slideId, shapeId, { ...t, x_emu: anchorRight - t.cx_emu });
        break;
      case 'center_h':
        next = updateShapeTransform(next, slideId, shapeId, { ...t, x_emu: anchorCenterX - Math.round(t.cx_emu / 2) });
        break;
      case 'top':
        next = updateShapeTransform(next, slideId, shapeId, { ...t, y_emu: anchorTop });
        break;
      case 'bottom':
        next = updateShapeTransform(next, slideId, shapeId, { ...t, y_emu: anchorBottom - t.cy_emu });
        break;
      case 'center_v':
        next = updateShapeTransform(next, slideId, shapeId, { ...t, y_emu: anchorCenterY - Math.round(t.cy_emu / 2) });
        break;
    }
  }
  return next;
}

/** 等距分布（委托原语，按**间隙**均分）。 */
export function distributeSelection(
  presentation: Presentation,
  slideId: number,
  shapeIds: readonly number[],
  axis: 'horizontal' | 'vertical',
): Presentation {
  return distributeShapes(presentation, slideId, shapeIds, axis);
}

/**
 * **固定间距分布**（原语没有的语义）：按给定 `gap_emu` 依次摆放，首个对象保持原位。
 *
 * 按轴上位置排序后逐个框定，因此与"均分剩余空间"不同：间距是给定的常数。
 */
export function distributeWithGap(
  presentation: Presentation,
  slideId: number,
  shapeIds: readonly number[],
  axis: 'horizontal' | 'vertical',
  gap_emu: number,
): Presentation {
  if (shapeIds.length < 2) {
    throw new GeometryError('insufficient_selection', '固定间距分布至少需要 2 个对象');
  }
  if (!Number.isFinite(gap_emu) || gap_emu < 0) {
    throw new GeometryError('invalid_bounds', `间距不能为负：${String(gap_emu)}`);
  }
  const selected = requireSelection(presentation, slideId, shapeIds)
    .slice()
    .sort((a, b) => (axis === 'horizontal' ? a.transform.x_emu - b.transform.x_emu : a.transform.y_emu - b.transform.y_emu));
  const first = selected[0];
  if (first === undefined) {
    throw new GeometryError('empty_selection', '分布选中的对象为空');
  }
  let cursor = axis === 'horizontal' ? first.transform.x_emu : first.transform.y_emu;
  const positions = new Map<number, number>();
  for (const shape of selected) {
    positions.set(shape.shape_id, cursor);
    cursor += (axis === 'horizontal' ? shape.transform.cx_emu : shape.transform.cy_emu) + gap_emu;
  }
  let next = presentation;
  for (const shape of selected) {
    const position = positions.get(shape.shape_id);
    if (position === undefined) continue;
    const t = requireShape(next, slideId, shape.shape_id).transform;
    next = updateShapeTransform(next, slideId, shape.shape_id, {
      ...t,
      x_emu: axis === 'horizontal' ? position : t.x_emu,
      y_emu: axis === 'vertical' ? position : t.y_emu,
    });
  }
  return next;
}

// ---------------------------------------------------------------------------
// 前后层级（PPT-05）
// ---------------------------------------------------------------------------

/** 置顶。 */
export function bringToFront(presentation: Presentation, slideId: number, shapeId: number): Presentation {
  return reorderShape(presentation, slideId, shapeId, 'front');
}

/** 置底。 */
export function sendToBack(presentation: Presentation, slideId: number, shapeId: number): Presentation {
  return reorderShape(presentation, slideId, shapeId, 'back');
}

/** 上移一层。 */
export function bringForward(presentation: Presentation, slideId: number, shapeId: number): Presentation {
  return reorderShape(presentation, slideId, shapeId, 'forward');
}

/** 下移一层。 */
export function sendBackward(presentation: Presentation, slideId: number, shapeId: number): Presentation {
  return reorderShape(presentation, slideId, shapeId, 'backward');
}

/** 顶层页序（索引即 z 序，0 = 最底）。 */
export function zOrder(presentation: Presentation, slideId: number): readonly number[] {
  return requireSlideShapes(presentation, slideId).map((shape) => shape.shape_id);
}

// ---------------------------------------------------------------------------
// 组合 / 取消组合（PPT-05）
// ---------------------------------------------------------------------------

/** 组合若干对象；`shape_id` 缺省 = 由 `nextAvailableShapeId` 自动分配（保证唯一）。 */
export function groupSelection(
  presentation: Presentation,
  slideId: number,
  shapeIds: readonly number[],
  options?: { readonly shape_id?: number; readonly name?: string },
): { readonly presentation: Presentation; readonly shape_id: number } {
  if (shapeIds.length < 2) {
    throw new GeometryError('insufficient_selection', '组合至少需要 2 个对象');
  }
  const shapeId = options?.shape_id ?? nextAvailableShapeId(presentation, slideId);
  if (shapeIds.includes(shapeId)) {
    throw new GeometryError('duplicate_shape_id', `组合新 id=${String(shapeId)} 与选中对象冲突`);
  }
  const next = groupShapes(presentation, slideId, shapeIds, {
    shape_id: shapeId,
    ...(options?.name === undefined ? {} : { name: options.name }),
  });
  return { presentation: next, shape_id: shapeId };
}

/** 取消组合（委托原语）。 */
export function ungroupSelection(presentation: Presentation, slideId: number, shapeId: number): Presentation {
  return ungroupShapes(presentation, slideId, shapeId);
}

/** 把顶层对象整体缩放 / 平移到给定页面尺寸（PPT-03 页面比例变化的几何侧）。 */
export function scaleBoundsTo(bounds: Bounds, from: SlideSize, to: SlideSize): Bounds {
  if (from.cx_emu <= 0 || from.cy_emu <= 0) {
    throw new GeometryError('invalid_bounds', '源页面尺寸必须为正');
  }
  return {
    x_emu: Math.round((bounds.x_emu * to.cx_emu) / from.cx_emu),
    y_emu: Math.round((bounds.y_emu * to.cy_emu) / from.cy_emu),
    cx_emu: Math.round((bounds.cx_emu * to.cx_emu) / from.cx_emu),
    cy_emu: Math.round((bounds.cy_emu * to.cy_emu) / from.cy_emu),
  };
}

// ---------------------------------------------------------------------------
// 位置关系快照（「保存重开后保持」的判据）
// ---------------------------------------------------------------------------

/**
 * `relativeGeometry` 的选项。
 *
 * - `include_nested`（缺省 `false`）：为 `true` 时把**组合内的子对象**也纳入快照，且子对象的
 *   `x/y/cx/cy` 用**组合合成后的有效几何**（见下）；为 `false` 时行为与旧版**逐字节一致**
 *   （只取顶层对象，不产生 `parent_group_id` / `depth` / `offset_in_group_emu`）。
 * - `shapeIds`：只保留这些 shape_id（顶层或组合内均可）。缺省 = 全部（按 `include_nested` 决定范围）。
 */
export interface NestedGeometryOptions {
  readonly include_nested?: boolean;
  readonly shapeIds?: readonly number[];
}

/**
 * 组合内对象的**有效几何合成**口径。
 *
 * `render.ts` 把 `p:grpSp` 写成 `a:off = 组合自身坐标`、`a:ext = 组合尺寸`，且
 * `a:chOff = (0,0)`、`a:chExt = (组合尺寸)`。按 OOXML 的口径，子元素的 `a:off` 位于
 * **子坐标空间**，映射到父空间为：
 *
 * ```
 * 父坐标 = off + (子坐标 − chOff) × (ext / chExt)
 * ```
 *
 * 因为本渲染器固定 `chOff = (0,0)`、`chExt = ext`（缩放恒为 1），子对象的**有效坐标**就是
 * `组合 off + 子对象自身坐标`。这与"组合整体平移时子对象跟着走"一致（父动一点，子的有效位置动一点）。
 *
 * ⚠️ 诚实边界：`groupShapes`（operations.ts）把子对象按**页面绝对坐标**原样放进组合（不改子坐标），
 * 而渲染器声明的 `chOff = 0` 会把子坐标当作**组合内坐标**。两者若都取"绝对"口径，实际渲染会
 * 平移一次组合原点（这是 render.ts 与 model 约定的潜在不一致，**不在本单元允许改动的文件内**，记入
 * residuals）。本函数按**渲染器实际声明的口径**合成（即包文件真正表达的位置关系），并在
 * `offset_in_group_emu` 里给出"相对宿主组合原点"的偏移，供调用方按需选择。
 */
function composeGroupFrame(frame: GroupFrame, group: Transform): GroupFrame {
  // 组合子坐标空间的缩放 = frame.sx × (ext.cx / chExt.cx) = frame.sx × 1 = frame.sx。
  // （chExt = ext，见 render.ts 的 p:grpSp 分支；ext 为 0 时按 1 处理，保持不放大。）
  return {
    ox: frame.ox + frame.sx * group.x_emu,
    oy: frame.oy + frame.sy * group.y_emu,
    sx: frame.sx,
    sy: frame.sy,
  };
}

interface GroupFrame {
  readonly ox: number;
  readonly oy: number;
  readonly sx: number;
  readonly sy: number;
}

const IDENTITY_FRAME: GroupFrame = Object.freeze({ ox: 0, oy: 0, sx: 1, sy: 1 });

interface NestedEntry {
  readonly shape: Shape;
  readonly x: number;
  readonly y: number;
  readonly cx: number;
  readonly cy: number;
  readonly depth: number;
  readonly parent_group_id: number | null;
  readonly group_origin: { readonly x: number; readonly y: number } | null;
}

/**
 * 遍历形状树（文档顺序 = 渲染顺序 = z 序），把每个对象的**有效几何**按组合合成口径算出来。
 *
 * `parentFrame` = 当前层级的父→页映射；`origin` = 最近一次进入组合时该组合的**有效原点**（顶层为 null）。
 */
function walkNested(
  shapes: readonly Shape[],
  parentFrame: GroupFrame,
  depth: number,
  parentGroupId: number | null,
  groupOrigin: { readonly x: number; readonly y: number } | null,
  out: NestedEntry[],
): void {
  for (const shape of shapes) {
    const x = parentFrame.ox + parentFrame.sx * shape.transform.x_emu;
    const y = parentFrame.oy + parentFrame.sy * shape.transform.y_emu;
    const cx = parentFrame.sx * shape.transform.cx_emu;
    const cy = parentFrame.sy * shape.transform.cy_emu;
    out.push({ shape, x, y, cx, cy, depth, parent_group_id: parentGroupId, group_origin: groupOrigin });
    if (shape.kind === 'group') {
      walkNested(
        shape.children,
        composeGroupFrame(parentFrame, shape.transform),
        depth + 1,
        shape.shape_id,
        { x, y },
        out,
      );
    }
  }
}

/**
 * 记下一组对象的**位置关系**：页面尺寸、各对象的几何与层级、两两之间的相对偏移与尺寸差。
 *
 * 顺序 = 页内 z 序（文档顺序；`include_nested` 时父对象紧跟其组合子对象，与渲染顺序一致）。
 * 旧签名 `relativeGeometry(presentation, slideId, shapeIds?)` 仍然成立：`shapeIds` 现在也可写进
 * `options`；两处都给时以 `options.shapeIds` 为准。
 *
 * **组合内相对几何**：`include_nested: true` 时，组合子对象的 `x/y` 是该对象在页上的**有效坐标**
 * （组合原点 + 子坐标，见 `composeGroupFrame` 的口径），并额外附
 * `parent_group_id` / `depth` / `offset_in_group_emu`（相对宿主组合有效原点的偏移）。
 * 因此"父组合整体平移 ⇒ 子对象的有效坐标与父同步平移、`offset_in_group_emu` 不变"可被断言。
 */
export function relativeGeometry(
  presentation: Presentation,
  slideId: number,
  shapeIdsOrOptions?: readonly number[] | NestedGeometryOptions,
): RelativeGeometry {
  const shapes = requireSlideShapes(presentation, slideId);

  const options: NestedGeometryOptions =
    shapeIdsOrOptions === undefined
      ? {}
      : Array.isArray(shapeIdsOrOptions)
        ? { shapeIds: shapeIdsOrOptions as readonly number[] }
        : (shapeIdsOrOptions as NestedGeometryOptions);
  const includeNested = options.include_nested === true;
  const filterIds = options.shapeIds;

  if (!includeNested) {
    // 缺省路径：与旧版逐字节一致（只取顶层对象，不附加组合字段）。
    const selected =
      filterIds === undefined ? shapes : shapes.filter((shape) => filterIds.includes(shape.shape_id));

    const snapshot: ShapeGeometry[] = selected.map((shape, index) =>
      Object.freeze({
        shape_id: shape.shape_id,
        x_emu: shape.transform.x_emu,
        y_emu: shape.transform.y_emu,
        cx_emu: shape.transform.cx_emu,
        cy_emu: shape.transform.cy_emu,
        rotation_deg: shape.transform.rotation_deg,
        flip_h: shape.transform.flip_h,
        flip_v: shape.transform.flip_v,
        z_index: filterIds === undefined ? index : shapes.indexOf(shape),
      }),
    );

    return freezeSnapshot(presentation, snapshot);
  }

  const entries: NestedEntry[] = [];
  walkNested(shapes, IDENTITY_FRAME, 0, null, null, entries);
  const selected = filterIds === undefined ? entries : entries.filter((entry) => filterIds.includes(entry.shape.shape_id));

  const snapshot: ShapeGeometry[] = selected.map((entry, index) => {
    const offset =
      entry.group_origin === null
        ? null
        : Object.freeze({
            dx_emu: entry.x - entry.group_origin.x,
            dy_emu: entry.y - entry.group_origin.y,
          });
    return Object.freeze({
      shape_id: entry.shape.shape_id,
      x_emu: entry.x,
      y_emu: entry.y,
      cx_emu: entry.cx,
      cy_emu: entry.cy,
      rotation_deg: entry.shape.transform.rotation_deg,
      flip_h: entry.shape.transform.flip_h,
      flip_v: entry.shape.transform.flip_v,
      z_index: index,
      parent_group_id: entry.parent_group_id,
      depth: entry.depth,
      offset_in_group_emu: offset,
    });
  });

  return freezeSnapshot(presentation, snapshot);
}

/** 由快照的形状列表算出两两相对偏移，并连同页尺寸冻结成 `RelativeGeometry`。 */
function freezeSnapshot(presentation: Presentation, snapshot: readonly ShapeGeometry[]): RelativeGeometry {
  const pairs: PairOffset[] = [];
  for (const a of snapshot) {
    for (const b of snapshot) {
      if (a.shape_id >= b.shape_id) continue;
      pairs.push(
        Object.freeze({
          a: a.shape_id,
          b: b.shape_id,
          dx_emu: b.x_emu - a.x_emu,
          dy_emu: b.y_emu - a.y_emu,
          dcx_emu: b.cx_emu - a.cx_emu,
          dcy_emu: b.cy_emu - a.cy_emu,
        }),
      );
    }
  }
  return Object.freeze({
    slide_size: presentation.size,
    shapes: Object.freeze(snapshot),
    pairs: Object.freeze(pairs),
  });
}

/**
 * 单个对象的**有效几何**（组合合成后）：组合子对象返回页上的有效位置/尺寸，顶层对象返回自身。
 *
 * 口径与 `relativeGeometry(..., { include_nested: true })` 一致；同时给出宿主组合 id 与嵌套深度。
 *
 * @throws {GeometryError} 找不到幻灯片（`unknown_slide`）或对象（`unknown_shape`）。
 */
export function effectiveGeometryOf(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
): {
  readonly shape_id: number;
  readonly bounds: Bounds;
  readonly parent_group_id: number | null;
  readonly depth: number;
  readonly offset_in_group_emu: { readonly dx_emu: number; readonly dy_emu: number } | null;
} {
  const shapes = requireSlideShapes(presentation, slideId);
  const entries: NestedEntry[] = [];
  walkNested(shapes, IDENTITY_FRAME, 0, null, null, entries);
  const entry = entries.find((candidate) => candidate.shape.shape_id === shapeId);
  if (entry === undefined) {
    throw new GeometryError('unknown_shape', `找不到对象 shape_id=${String(shapeId)}`);
  }
  return Object.freeze({
    shape_id: shapeId,
    bounds: Object.freeze({ x_emu: entry.x, y_emu: entry.y, cx_emu: entry.cx, cy_emu: entry.cy }),
    parent_group_id: entry.parent_group_id,
    depth: entry.depth,
    offset_in_group_emu:
      entry.group_origin === null
        ? null
        : Object.freeze({ dx_emu: entry.x - entry.group_origin.x, dy_emu: entry.y - entry.group_origin.y }),
  });
}

/** 造一个带几何的形状变换（薄封装 `model.transform`，方便用例与调用方）。 */
export function boundsTransform(bounds: Bounds): Transform {
  return makeTransform(bounds.x_emu, bounds.y_emu, bounds.cx_emu, bounds.cy_emu);
}

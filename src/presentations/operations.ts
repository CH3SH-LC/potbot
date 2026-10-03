/**
 * 演示域**操作层**（design-06 P9 / PPT-01–16）。
 *
 * 全部操作都是**纯函数**：接收模型、返回**新模型**，绝不就地修改入参。
 * 这样"改一处 → 其余对象逐字节不变"成为结构性事实，而不是靠调用方自觉——PPT-03
 * 「既有母版与自定义对象保留，不能每次扁平化重造」与 PPT-14「失败保旧」都建立在这条上。
 *
 * 数组顺序即语义：
 * - `Presentation.slides` 的顺序 = **页序**（PPT-02 移动/复制）；
 * - `Slide.shapes` 的顺序 = **z 序**，索引 0 在最底层（PPT-05 前后层级）。
 *
 * 页数由任务决定（PPT-01）：`addSlide` / `removeSlide` 让页数随任务增减，**没有**任何
 * 写死的页数上限。
 */

import { ValidationError } from '../protocol/index.js';

import {
  transform as makeTransform,
  type AlignEdge,
  type LayoutRef,
  type Paragraph,
  type Presentation,
  type RunStyle,
  type Shape,
  type ShapeAnimation,
  type Slide,
  type SlideTransition,
  type TableRow,
  type TextBody,
  type TextRun,
  type Transform,
} from './model.js';
import {
  TextEditError,
  assertQueryValid,
  findText,
  paragraphTextMap,
  pasteIntoBody,
  replaceParagraphRange,
  replaceText,
  styleParagraphRange,
  type ClipboardContent,
  type FindOptions,
  type TextMatch,
} from './text.js';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 操作层错误原因（用于用例断言与上层分类处理）。 */
export type PresentationOperationErrorReason =
  | 'unknown_slide'
  | 'unknown_shape'
  | 'duplicate_slide_id'
  | 'duplicate_shape_id'
  | 'not_a_group'
  | 'empty_selection'
  | 'shape_has_no_text'
  | 'unknown_paragraph'
  | 'unknown_run'
  | 'selection_out_of_range'
  | 'run_is_not_literal'
  /** 段落含事实引用 run：字符坐标不稳定，按字符编辑 / 查找替换一律拒（不猜）。 */
  | 'paragraph_has_fact_run'
  /** 查找串为空。 */
  | 'empty_query'
  /** 查询模式（正则 / 通配符）本身畸形，无法解析（不静默按字面量、不吞成零命中）。 */
  | 'invalid_pattern';

/** 操作层在语义不成立时抛出的错误（**不静默**）。 */
export class PresentationOperationError extends ValidationError {
  readonly reason: PresentationOperationErrorReason;

  constructor(reason: PresentationOperationErrorReason, message: string) {
    super(message);
    this.name = 'PresentationOperationError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function nextSlideId(presentation: Presentation): number {
  let max = 0;
  for (const slide of presentation.slides) {
    if (slide.slide_id > max) {
      max = slide.slide_id;
    }
  }
  return max + 1;
}

function nextShapeId(shapes: readonly Shape[]): number {
  let max = 1;
  const visit = (list: readonly Shape[]): void => {
    for (const shape of list) {
      if (shape.shape_id > max) {
        max = shape.shape_id;
      }
      if (shape.kind === 'group') {
        visit(shape.children);
      }
    }
  };
  visit(shapes);
  return max + 1;
}

function requireSlide(presentation: Presentation, slideId: number): number {
  const index = presentation.slides.findIndex((slide) => slide.slide_id === slideId);
  if (index < 0) {
    throw new PresentationOperationError('unknown_slide', `找不到幻灯片 slide_id=${String(slideId)}`);
  }
  return index;
}

function withSlide(
  presentation: Presentation,
  slideId: number,
  update: (slide: Slide) => Slide,
): Presentation {
  const index = requireSlide(presentation, slideId);
  const slides = presentation.slides.map((slide, i) => (i === index ? update(slide) : slide));
  return { ...presentation, slides };
}

/** 复制一张幻灯片的内容，但换一个稳定的新 `slide_id`（PPT-02 复制）。 */
function cloneSlide(slide: Slide, slideId: number): Slide {
  return {
    ...slide,
    slide_id: slideId,
    shapes: slide.shapes.map((shape) => cloneShape(shape, shape.shape_id)),
  };
}

function cloneShape(shape: Shape, shapeId: number): Shape {
  if (shape.kind === 'group') {
    return { ...shape, shape_id: shapeId, children: shape.children.map((child) => cloneShape(child, child.shape_id)) };
  }
  return { ...shape, shape_id: shapeId };
}

// ---------------------------------------------------------------------------
// 幻灯片操作（PPT-01 / PPT-02 / PPT-10 / PPT-11）
// ---------------------------------------------------------------------------

/** 在 `at`（含）处插入一张新幻灯片；`at` 缺省 = 追加到末尾。**页数随之 +1**。 */
export function addSlide(
  presentation: Presentation,
  options?: {
    readonly at?: number;
    readonly layout?: LayoutRef;
    readonly slide_id?: number;
  },
): { readonly presentation: Presentation; readonly slide_id: number } {
  const slideId = options?.slide_id ?? nextSlideId(presentation);
  if (presentation.slides.some((slide) => slide.slide_id === slideId)) {
    throw new PresentationOperationError('duplicate_slide_id', `slide_id=${String(slideId)} 已存在`);
  }
  const layout: LayoutRef =
    options?.layout ?? {
      master_id: presentation.master.master_id,
      layout_id: 'blank',
    };
  const slide: Slide = {
    slide_id: slideId,
    layout,
    hidden: false,
    shapes: [],
    transition: null,
    animations: [],
    notes: null,
  };
  const at = options?.at ?? presentation.slides.length;
  if (at < 0 || at > presentation.slides.length) {
    throw new PresentationOperationError('unknown_slide', `插入位置 ${String(at)} 越界`);
  }
  const slides = [...presentation.slides.slice(0, at), slide, ...presentation.slides.slice(at)];
  return { presentation: { ...presentation, slides }, slide_id: slideId };
}

/** 删除一张幻灯片（PPT-02）。 */
export function removeSlide(presentation: Presentation, slideId: number): Presentation {
  requireSlide(presentation, slideId);
  return {
    ...presentation,
    slides: presentation.slides.filter((slide) => slide.slide_id !== slideId),
    sections: presentation.sections.map((section) => ({
      ...section,
      slide_ids: section.slide_ids.filter((id) => id !== slideId),
    })),
  };
}

/** 复制一张幻灯片（PPT-02）；副本带新的 `slide_id`，插在原页之后。 */
export function duplicateSlide(
  presentation: Presentation,
  slideId: number,
): { readonly presentation: Presentation; readonly slide_id: number } {
  const index = requireSlide(presentation, slideId);
  const source = presentation.slides[index];
  if (source === undefined) {
    throw new PresentationOperationError('unknown_slide', `找不到幻灯片 slide_id=${String(slideId)}`);
  }
  const newId = nextSlideId(presentation);
  const copy = cloneSlide(source, newId);
  const slides = [...presentation.slides.slice(0, index + 1), copy, ...presentation.slides.slice(index + 1)];
  return { presentation: { ...presentation, slides }, slide_id: newId };
}

/** 把一张幻灯片移动到 `to` 位置（PPT-02 移动）。 */
export function moveSlide(presentation: Presentation, slideId: number, to: number): Presentation {
  const from = requireSlide(presentation, slideId);
  if (to < 0 || to >= presentation.slides.length) {
    throw new PresentationOperationError('unknown_slide', `目标位置 ${String(to)} 越界`);
  }
  const slides = [...presentation.slides];
  const [moved] = slides.splice(from, 1);
  if (moved === undefined) {
    throw new PresentationOperationError('unknown_slide', `找不到幻灯片 slide_id=${String(slideId)}`);
  }
  slides.splice(to, 0, moved);
  return { ...presentation, slides };
}

/** 显示 / 隐藏一张幻灯片（PPT-02）。 */
export function setSlideHidden(presentation: Presentation, slideId: number, hidden: boolean): Presentation {
  return withSlide(presentation, slideId, (slide) => ({ ...slide, hidden }));
}

/** 切换版式（PPT-02 / PPT-03）。 */
export function setSlideLayout(presentation: Presentation, slideId: number, layout: LayoutRef): Presentation {
  return withSlide(presentation, slideId, (slide) => ({ ...slide, layout }));
}

/** 设置演讲备注（PPT-10）。传 `null` 清除。 */
export function setSlideNotes(presentation: Presentation, slideId: number, notes: TextBody | null): Presentation {
  return withSlide(presentation, slideId, (slide) => ({ ...slide, notes }));
}

/** 设置切换效果（PPT-11）。传 `null` 清除。 */
export function setSlideTransition(
  presentation: Presentation,
  slideId: number,
  transition: SlideTransition | null,
): Presentation {
  return withSlide(presentation, slideId, (slide) => ({ ...slide, transition }));
}

/** 加一条对象动画（PPT-11）。 */
export function addShapeAnimation(
  presentation: Presentation,
  slideId: number,
  animation: ShapeAnimation,
): Presentation {
  return withSlide(presentation, slideId, (slide) => ({
    ...slide,
    animations: [...slide.animations, animation],
  }));
}

/** 清除某页全部动画（PPT-11 的"清除"）。 */
export function clearAnimations(presentation: Presentation, slideId: number): Presentation {
  return withSlide(presentation, slideId, (slide) => ({ ...slide, animations: [] }));
}

/** 设置页面尺寸（PPT-03 的比例/尺寸）。 */
export function setSlideSize(presentation: Presentation, size: { cx_emu: number; cy_emu: number }): Presentation {
  return { ...presentation, size };
}

// ---------------------------------------------------------------------------
// 形状操作（PPT-05 / PPT-06 / PPT-07 / PPT-08 / PPT-09）
// ---------------------------------------------------------------------------

/** 在指定页的 `at`（含）处插入一个对象；`at` 缺省 = 置顶（PPT-05 层级）。 */
export function addShape(
  presentation: Presentation,
  slideId: number,
  shape: Shape,
  options?: { readonly at?: number },
): Presentation {
  return withSlide(presentation, slideId, (slide) => {
    if (slide.shapes.some((existing) => existing.shape_id === shape.shape_id)) {
      throw new PresentationOperationError(
        'duplicate_shape_id',
        `shape_id=${String(shape.shape_id)} 在该页已存在`,
      );
    }
    const at = options?.at ?? slide.shapes.length;
    if (at < 0 || at > slide.shapes.length) {
      throw new PresentationOperationError('unknown_shape', `插入位置 ${String(at)} 越界`);
    }
    return { ...slide, shapes: [...slide.shapes.slice(0, at), shape, ...slide.shapes.slice(at)] };
  });
}

/** 删除一个对象（PPT-06/PPT-07 的删除）。 */
export function removeShape(presentation: Presentation, slideId: number, shapeId: number): Presentation {
  return withSlide(presentation, slideId, (slide) => {
    if (!slide.shapes.some((shape) => shape.shape_id === shapeId)) {
      throw new PresentationOperationError('unknown_shape', `找不到对象 shape_id=${String(shapeId)}`);
    }
    return { ...slide, shapes: slide.shapes.filter((shape) => shape.shape_id !== shapeId) };
  });
}

function mapShape(shapes: readonly Shape[], shapeId: number, update: (shape: Shape) => Shape): readonly Shape[] {
  return shapes.map((shape) => {
    if (shape.shape_id === shapeId) {
      return update(shape);
    }
    if (shape.kind === 'group') {
      return { ...shape, children: mapShape(shape.children, shapeId, update) };
    }
    return shape;
  });
}

function hasShape(shapes: readonly Shape[], shapeId: number): boolean {
  return shapes.some(
    (shape) => shape.shape_id === shapeId || (shape.kind === 'group' && hasShape(shape.children, shapeId)),
  );
}

/** 改一个对象的几何（PPT-05：尺寸/坐标/旋转）。 */
export function updateShapeTransform(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  transform: Transform,
): Presentation {
  return withSlide(presentation, slideId, (slide) => {
    if (!hasShape(slide.shapes, shapeId)) {
      throw new PresentationOperationError('unknown_shape', `找不到对象 shape_id=${String(shapeId)}`);
    }
    return { ...slide, shapes: mapShape(slide.shapes, shapeId, (shape) => ({ ...shape, transform })) };
  });
}

/** 平移一个对象（PPT-05）。 */
export function moveShape(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  dx_emu: number,
  dy_emu: number,
): Presentation {
  return withSlide(presentation, slideId, (slide) => {
    if (!hasShape(slide.shapes, shapeId)) {
      throw new PresentationOperationError('unknown_shape', `找不到对象 shape_id=${String(shapeId)}`);
    }
    return {
      ...slide,
      shapes: mapShape(slide.shapes, shapeId, (shape) => ({
        ...shape,
        transform: { ...shape.transform, x_emu: shape.transform.x_emu + dx_emu, y_emu: shape.transform.y_emu + dy_emu },
      })),
    };
  });
}

/** 旋转一个对象（PPT-05）；角度归一化到 [0, 360)。 */
export function rotateShape(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  rotation_deg: number,
): Presentation {
  const normalized = ((rotation_deg % 360) + 360) % 360;
  return withSlide(presentation, slideId, (slide) => {
    if (!hasShape(slide.shapes, shapeId)) {
      throw new PresentationOperationError('unknown_shape', `找不到对象 shape_id=${String(shapeId)}`);
    }
    return {
      ...slide,
      shapes: mapShape(slide.shapes, shapeId, (shape) => ({
        ...shape,
        transform: { ...shape.transform, rotation_deg: normalized },
      })),
    };
  });
}

/** 前后层级（PPT-05）：`to` = `'front' | 'back' | 'forward' | 'backward'`。 */
export function reorderShape(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  to: 'front' | 'back' | 'forward' | 'backward',
): Presentation {
  return withSlide(presentation, slideId, (slide) => {
    const index = slide.shapes.findIndex((shape) => shape.shape_id === shapeId);
    if (index < 0) {
      throw new PresentationOperationError('unknown_shape', `找不到对象 shape_id=${String(shapeId)}`);
    }
    const shapes = [...slide.shapes];
    const [shape] = shapes.splice(index, 1);
    if (shape === undefined) {
      throw new PresentationOperationError('unknown_shape', `找不到对象 shape_id=${String(shapeId)}`);
    }
    let target: number;
    switch (to) {
      case 'front':
        target = shapes.length;
        break;
      case 'back':
        target = 0;
        break;
      case 'forward':
        target = Math.min(index + 1, shapes.length);
        break;
      case 'backward':
        target = Math.max(index - 1, 0);
        break;
    }
    shapes.splice(target, 0, shape);
    return { ...slide, shapes };
  });
}

/** 对齐若干对象（PPT-05）。选中的对象少于 2 个 ⇒ 报错（不静默）。 */
export function alignShapes(
  presentation: Presentation,
  slideId: number,
  shapeIds: readonly number[],
  edge: AlignEdge,
): Presentation {
  if (shapeIds.length < 2) {
    throw new PresentationOperationError('empty_selection', '对齐至少需要 2 个对象');
  }
  return withSlide(presentation, slideId, (slide) => {
    const selected = slide.shapes.filter((shape) => shapeIds.includes(shape.shape_id));
    const left = Math.min(...selected.map((shape) => shape.transform.x_emu));
    const right = Math.max(...selected.map((shape) => shape.transform.x_emu + shape.transform.cx_emu));
    const top = Math.min(...selected.map((shape) => shape.transform.y_emu));
    const bottom = Math.max(...selected.map((shape) => shape.transform.y_emu + shape.transform.cy_emu));
    const centerX = Math.round((left + right) / 2);
    const centerY = Math.round((top + bottom) / 2);
    const apply = (shape: Shape): Shape => {
      const t = shape.transform;
      switch (edge) {
        case 'left':
          return { ...shape, transform: { ...t, x_emu: left } };
        case 'right':
          return { ...shape, transform: { ...t, x_emu: right - t.cx_emu } };
        case 'top':
          return { ...shape, transform: { ...t, y_emu: top } };
        case 'bottom':
          return { ...shape, transform: { ...t, y_emu: bottom - t.cy_emu } };
        case 'center_h':
          return { ...shape, transform: { ...t, x_emu: centerX - Math.round(t.cx_emu / 2) } };
        case 'center_v':
          return { ...shape, transform: { ...t, y_emu: centerY - Math.round(t.cy_emu / 2) } };
      }
    };
    return {
      ...slide,
      shapes: slide.shapes.map((shape) => (shapeIds.includes(shape.shape_id) ? apply(shape) : shape)),
    };
  });
}

/** 水平或垂直等距分布（PPT-05）。需要 ≥3 个对象。 */
export function distributeShapes(
  presentation: Presentation,
  slideId: number,
  shapeIds: readonly number[],
  axis: 'horizontal' | 'vertical',
): Presentation {
  if (shapeIds.length < 3) {
    throw new PresentationOperationError('empty_selection', '分布至少需要 3 个对象');
  }
  return withSlide(presentation, slideId, (slide) => {
    const selected = slide.shapes
      .filter((shape) => shapeIds.includes(shape.shape_id))
      .slice()
      .sort((a, b) =>
        axis === 'horizontal'
          ? a.transform.x_emu - b.transform.x_emu
          : a.transform.y_emu - b.transform.y_emu,
      );
    const first = selected[0];
    const last = selected[selected.length - 1];
    if (first === undefined || last === undefined) {
      throw new PresentationOperationError('empty_selection', '分布选中的对象为空');
    }
    const start = axis === 'horizontal' ? first.transform.x_emu : first.transform.y_emu;
    const end =
      axis === 'horizontal'
        ? last.transform.x_emu + last.transform.cx_emu
        : last.transform.y_emu + last.transform.cy_emu;
    const total = axis === 'horizontal'
      ? selected.reduce((sum, shape) => sum + shape.transform.cx_emu, 0)
      : selected.reduce((sum, shape) => sum + shape.transform.cy_emu, 0);
    const gap = Math.round((end - start - total) / (selected.length - 1));
    const positions = new Map<number, number>();
    let cursor = start;
    for (const shape of selected) {
      positions.set(shape.shape_id, cursor);
      cursor += (axis === 'horizontal' ? shape.transform.cx_emu : shape.transform.cy_emu) + gap;
    }
    return {
      ...slide,
      shapes: slide.shapes.map((shape) => {
        const position = positions.get(shape.shape_id);
        if (position === undefined) {
          return shape;
        }
        const t = shape.transform;
        return axis === 'horizontal'
          ? { ...shape, transform: { ...t, x_emu: position } }
          : { ...shape, transform: { ...t, y_emu: position } };
      }),
    };
  });
}

/** 组合若干对象（PPT-05）；子对象从页面上移入组合，组合自身放在原最上层位置。 */
export function groupShapes(
  presentation: Presentation,
  slideId: number,
  shapeIds: readonly number[],
  options: { readonly shape_id: number; readonly name?: string },
): Presentation {
  if (shapeIds.length < 2) {
    throw new PresentationOperationError('empty_selection', '组合至少需要 2 个对象');
  }
  return withSlide(presentation, slideId, (slide) => {
    const selected = slide.shapes.filter((shape) => shapeIds.includes(shape.shape_id));
    if (selected.length !== shapeIds.length) {
      throw new PresentationOperationError('unknown_shape', '组合选中的对象里有不存在的 shape_id');
    }
    const rest = slide.shapes.filter((shape) => !shapeIds.includes(shape.shape_id));
    const left = Math.min(...selected.map((shape) => shape.transform.x_emu));
    const top = Math.min(...selected.map((shape) => shape.transform.y_emu));
    const right = Math.max(...selected.map((shape) => shape.transform.x_emu + shape.transform.cx_emu));
    const bottom = Math.max(...selected.map((shape) => shape.transform.y_emu + shape.transform.cy_emu));
    const group: Shape = {
      kind: 'group',
      shape_id: options.shape_id,
      name: options.name ?? `Group ${String(options.shape_id)}`,
      transform: makeTransform(left, top, right - left, bottom - top),
      children: selected,
    };
    return { ...slide, shapes: [...rest, group] };
  });
}

/** 取消组合（PPT-05）：一层的子对象回到页面，接在组合原来的位置上。 */
export function ungroupShapes(presentation: Presentation, slideId: number, shapeId: number): Presentation {
  return withSlide(presentation, slideId, (slide) => {
    const index = slide.shapes.findIndex((shape) => shape.shape_id === shapeId);
    const group = index < 0 ? undefined : slide.shapes[index];
    if (group === undefined) {
      throw new PresentationOperationError('unknown_shape', `找不到对象 shape_id=${String(shapeId)}`);
    }
    if (group.kind !== 'group') {
      throw new PresentationOperationError('not_a_group', `shape_id=${String(shapeId)} 不是组合`);
    }
    const shapes = [...slide.shapes];
    shapes.splice(index, 1, ...group.children);
    return { ...slide, shapes };
  });
}

// ---------------------------------------------------------------------------
// 文本操作（PPT-04）
// ---------------------------------------------------------------------------

/** 设置文本框的文本体；非文本框 ⇒ 报错（不静默丢弃）。 */
export function setShapeText(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  text: TextBody,
): Presentation {
  return withSlide(presentation, slideId, (slide) => {
    if (!hasShape(slide.shapes, shapeId)) {
      throw new PresentationOperationError('unknown_shape', `找不到对象 shape_id=${String(shapeId)}`);
    }
    return {
      ...slide,
      shapes: mapShape(slide.shapes, shapeId, (shape) => {
        if (shape.kind === 'text_box' || shape.kind === 'auto_shape') {
          return { ...shape, text };
        }
        throw new PresentationOperationError(
          'shape_has_no_text',
          `对象 ${shape.kind} 不接受文本（只有 text_box / auto_shape 有文本体）`,
        );
      }),
    };
  });
}

/** 追加一个段落（PPT-04）。 */
export function appendParagraph(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  paragraph: Paragraph,
): Presentation {
  return withSlide(presentation, slideId, (slide) => {
    if (!hasShape(slide.shapes, shapeId)) {
      throw new PresentationOperationError('unknown_shape', `找不到对象 shape_id=${String(shapeId)}`);
    }
    return {
      ...slide,
      shapes: mapShape(slide.shapes, shapeId, (shape) => {
        if (shape.kind === 'text_box' || shape.kind === 'auto_shape') {
          const body = shape.text ?? { paragraphs: [] };
          return { ...shape, text: { paragraphs: [...body.paragraphs, paragraph] } };
        }
        throw new PresentationOperationError(
          'shape_has_no_text',
          `对象 ${shape.kind} 不接受文本（只有 text_box / auto_shape 有文本体）`,
        );
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// 文本精确定位编辑（PPT-04「精确选区保留未选内容」）
// ---------------------------------------------------------------------------

/** 段落定位：页 → 对象 → 段落。 */
export interface ParagraphTarget {
  readonly slide_id: number;
  readonly shape_id: number;
  readonly paragraph_index: number;
}

/** 文本 run 定位：页 → 对象 → 段落 → run。 */
export interface RunTarget extends ParagraphTarget {
  readonly run_index: number;
}

/**
 * 把"目标对象的文本体"换新，返回新模型。
 *
 * 除目标对象本身外，**其余对象、其余段落、其余 run 与其余页一律保持引用相等**——
 * 这是「精确选区不改未选内容」的**结构性**保证（不是靠调用方自觉）：
 * 未选中的东西根本没有被重建过。
 */
function mapShapeTextBody(
  presentation: Presentation,
  target: ParagraphTarget,
  update: (body: TextBody) => TextBody,
): Presentation {
  return withSlide(presentation, target.slide_id, (slide) => {
    if (!hasShape(slide.shapes, target.shape_id)) {
      throw new PresentationOperationError('unknown_shape', `找不到对象 shape_id=${String(target.shape_id)}`);
    }
    return {
      ...slide,
      shapes: mapShape(slide.shapes, target.shape_id, (shape) => {
        if (shape.kind === 'text_box') {
          return { ...shape, text: update(shape.text) };
        }
        if (shape.kind === 'auto_shape') {
          if (shape.text === null) {
            throw new PresentationOperationError(
              'shape_has_no_text',
              `对象 shape_id=${String(target.shape_id)} 没有文本体`,
            );
          }
          return { ...shape, text: update(shape.text) };
        }
        throw new PresentationOperationError(
          'shape_has_no_text',
          `对象 ${shape.kind} 不接受文本（只有 text_box / auto_shape 有文本体）`,
        );
      }),
    };
  });
}

function requireParagraph(body: TextBody, index: number): Paragraph {
  const paragraph = body.paragraphs[index];
  if (paragraph === undefined) {
    throw new PresentationOperationError('unknown_paragraph', `找不到段落 paragraph_index=${String(index)}`);
  }
  return paragraph;
}

function requireRun(paragraph: Paragraph, index: number): TextRun {
  const run = paragraph.runs[index];
  if (run === undefined) {
    throw new PresentationOperationError('unknown_run', `找不到 run run_index=${String(index)}`);
  }
  return run;
}

/** 只替换一个段落，其余段落**引用不变**。 */
function replaceParagraph(body: TextBody, index: number, next: Paragraph): TextBody {
  return { paragraphs: body.paragraphs.map((current, i) => (i === index ? next : current)) };
}

/** 只替换一个 run，同段其余 run**引用不变**。 */
function replaceRun(paragraph: Paragraph, index: number, next: TextRun): Paragraph {
  return { ...paragraph, runs: paragraph.runs.map((current, i) => (i === index ? next : current)) };
}

/**
 * **精确选区**（PPT-04）：把某个 run 里 `[start, end)` 这段字符换成 `replacement`。
 *
 * - 该 run 的**未选中部分**（前缀与后缀）与**字符样式**原样保留；
 * - 同段其余 run、其余段落、其余对象、其余页**引用相等**（`toBe` 可断言）。
 *
 * 只接受**字面量** run：事实引用 run 的文本是渲染期算出来的，"改它的第几个字符"没有稳定语义
 * ⇒ 报 `run_is_not_literal`（既不静默改成字面量，也不静默忽略）。
 *
 * @throws {PresentationOperationError} 对象/段落/run 不存在，或选区越界，或 run 不是字面量。
 */
export function replaceTextSelection(
  presentation: Presentation,
  target: RunTarget,
  start: number,
  end: number,
  replacement: string,
): Presentation {
  return mapShapeTextBody(presentation, target, (body) => {
    const paragraph = requireParagraph(body, target.paragraph_index);
    const run = requireRun(paragraph, target.run_index);
    if (run.source.kind !== 'literal') {
      throw new PresentationOperationError(
        'run_is_not_literal',
        `run(${String(target.paragraph_index)},${String(target.run_index)}) 是事实引用，不能按字符选区编辑`,
      );
    }
    const text = run.source.text;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > text.length
    ) {
      throw new PresentationOperationError(
        'selection_out_of_range',
        `选区 [${String(start)}, ${String(end)}) 超出 run 文本长度 ${String(text.length)}`,
      );
    }
    const next: TextRun = {
      ...run,
      source: { kind: 'literal', text: text.slice(0, start) + replacement + text.slice(end) },
    };
    return replaceParagraph(body, target.paragraph_index, replaceRun(paragraph, target.run_index, next));
  });
}

/**
 * 整体替换某个 run 的文本（来源换成字面量）。用于"改一个文本"的最常见场景。
 * 样式原样保留；同段其余 run 引用不变。
 */
export function setRunText(presentation: Presentation, target: RunTarget, text: string): Presentation {
  return mapShapeTextBody(presentation, target, (body) => {
    const paragraph = requireParagraph(body, target.paragraph_index);
    const run = requireRun(paragraph, target.run_index);
    const next: TextRun = { ...run, source: { kind: 'literal', text } };
    return replaceParagraph(body, target.paragraph_index, replaceRun(paragraph, target.run_index, next));
  });
}

/**
 * 改某个 run 的字符样式（PPT-04 最小集里的字号 / 粗斜体 / 颜色）。
 * 传 `null` = 清空样式（回到继承版式/母版）。文本来源原样保留。
 */
export function setRunStyle(
  presentation: Presentation,
  target: RunTarget,
  style: RunStyle | null,
): Presentation {
  return mapShapeTextBody(presentation, target, (body) => {
    const paragraph = requireParagraph(body, target.paragraph_index);
    const run = requireRun(paragraph, target.run_index);
    const next: TextRun = style === null ? { source: run.source } : { source: run.source, style };
    return replaceParagraph(body, target.paragraph_index, replaceRun(paragraph, target.run_index, next));
  });
}

/** 改某段落的对齐（PPT-04 最小集里的"对齐"）。同段 run 与其余段落引用不变。 */
export function setParagraphAlignment(
  presentation: Presentation,
  target: ParagraphTarget,
  alignment: Paragraph['alignment'],
): Presentation {
  return mapShapeTextBody(presentation, target, (body) => {
    const paragraph = requireParagraph(body, target.paragraph_index);
    return replaceParagraph(body, target.paragraph_index, { ...paragraph, alignment });
  });
}

/** 分配下一个可用的 `shape_id`（供调用方造对象用）。 */
export function nextAvailableShapeId(presentation: Presentation, slideId: number): number {
  const index = requireSlide(presentation, slideId);
  const slide = presentation.slides[index];
  if (slide === undefined) {
    throw new PresentationOperationError('unknown_slide', `找不到幻灯片 slide_id=${String(slideId)}`);
  }
  return nextShapeId(slide.shapes);
}

// ===========================================================================
// P03 增量：跨 run 精确选区 / 查找替换 / 粘贴（PPT-04 精确选区、PPT-14 查找替换与粘贴）
// ===========================================================================
//
// 上面 `replaceTextSelection` 只接受**单个 run** 的字符区间；`text.ts` 的字符坐标引擎
// 把选区语义升到**段落级**（跨 run）。本段是它在 Presentation 上的接线：
// 定位页 → 对象 → 段落，调引擎，再**只重建被改的那一层**——其余页、其余对象、其余段落
// 引用相等，因此"跨 run 改一小段不损其他对象格式"可由 `toBe` 直接断言。

/** 页 → 对象定位（与 `text.ts` 的 `ShapeRef` 同形，此处独立声明避免跨模块耦合）。 */
export interface ShapeTarget {
  readonly slide_id: number;
  readonly shape_id: number;
}

/** 段落级命中：`TextMatch` + 所属段落下标。 */
export interface ShapeTextMatch extends TextMatch {
  readonly paragraph_index: number;
}

/**
 * 命中**所在的位置**——一处命中到底落在正文形状、某个表格单元格，还是演讲备注。
 *
 * 这是"查找范围从文本框 / 自选图形扩到表格与备注"之后**必须显式携带**的信息：
 * 光有 `shape_id + paragraph_index` 无法区分"表格第 1 格第 2 段"和"正文第 2 段"，
 * 也无法表示"备注根本不在任何形状上"。
 */
export type TextMatchLocation =
  | { readonly kind: 'shape' }
  | { readonly kind: 'table_cell'; readonly row_index: number; readonly column_index: number }
  | { readonly kind: 'notes' };

/**
 * 跨页命中：`ShapeTextMatch` + 所属页、对象与位置。
 *
 * `shape_id` 对备注命中是 `null`——备注不挂在形状上，**不用 0 / 哨兵值**冒充（"缺失不当零"）。
 */
export interface SlideFindMatch extends ShapeTextMatch {
  readonly slide_id: number;
  readonly shape_id: number | null;
  readonly location: TextMatchLocation;
}

/** 形状级命中：`ShapeTextMatch` + 所属对象与位置（表格单元格会带 `row_index` / `column_index`）。 */
export interface ShapeFindMatch extends ShapeTextMatch {
  readonly shape_id: number;
  readonly location: TextMatchLocation;
}

/** 取一个对象承载文本的体；不承载文本 ⇒ `null`（表格 / 图表等不在本函数的范围）。 */
function bodyOfTextShape(shape: Shape): TextBody | null {
  if (shape.kind === 'text_box') {
    return shape.text;
  }
  if (shape.kind === 'auto_shape') {
    return shape.text;
  }
  return null;
}

/** 替换对象文本体；非文本对象 ⇒ 具名报错（不静默）。 */
function withBodyOfTextShape(shape: Shape, body: TextBody): Shape {
  if (shape.kind === 'text_box' || shape.kind === 'auto_shape') {
    return { ...shape, text: body };
  }
  throw new PresentationOperationError('shape_has_no_text', `对象 ${shape.kind} 不接受文本`);
}

/** 取某段并确认它不含事实引用 run（按字符编辑的前提）。 */
function requireEditableParagraph(body: TextBody, index: number): Paragraph {
  const paragraph = requireParagraph(body, index);
  if (paragraphTextMap(paragraph).has_fact_run) {
    throw new PresentationOperationError(
      'paragraph_has_fact_run',
      `段落 paragraph_index=${String(index)} 含事实引用 run，字符坐标不稳定，不能按字符编辑`,
    );
  }
  return paragraph;
}

/** 段落级选区校验（越界 ⇒ 具名 `selection_out_of_range`）。 */
function validateParagraphSelection(paragraph: Paragraph, start: number, end: number): void {
  const map = paragraphTextMap(paragraph);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > map.text.length
  ) {
    throw new PresentationOperationError(
      'selection_out_of_range',
      `选区 [${String(start)}, ${String(end)}) 超出段落文本长度 ${String(map.text.length)}`,
    );
  }
}

/**
 * **跨 run 精确选区替换**（PPT-04）：把某段 `[start, end)` 这段字符换成 `replacement`。
 * 选区可横跨多个 run；未落在选区内的 run 引用相等。
 */
export function replaceSelectionAcrossRuns(
  presentation: Presentation,
  target: ParagraphTarget,
  start: number,
  end: number,
  replacement: string,
): Presentation {
  return mapShapeTextBody(presentation, target, (body) => {
    const paragraph = requireEditableParagraph(body, target.paragraph_index);
    validateParagraphSelection(paragraph, start, end);
    const next = replaceParagraphRange(paragraph, start, end, replacement);
    return replaceParagraph(body, target.paragraph_index, next);
  });
}

/** **跨 run 套样式**（PPT-04）：只给某段 `[start, end)` 这段字符合并样式补丁。 */
export function styleSelectionAcrossRuns(
  presentation: Presentation,
  target: ParagraphTarget,
  start: number,
  end: number,
  patch: Partial<RunStyle>,
): Presentation {
  return mapShapeTextBody(presentation, target, (body) => {
    const paragraph = requireEditableParagraph(body, target.paragraph_index);
    validateParagraphSelection(paragraph, start, end);
    const next = styleParagraphRange(paragraph, start, end, patch);
    return replaceParagraph(body, target.paragraph_index, next);
  });
}

/** **跨 run 删除选区**（PPT-04）。 */
export function deleteSelectionAcrossRuns(
  presentation: Presentation,
  target: ParagraphTarget,
  start: number,
  end: number,
): Presentation {
  return replaceSelectionAcrossRuns(presentation, target, start, end, '');
}

/**
 * **粘贴**（PPT-14）：把剪贴板内容贴进某段 `[start, end)`，必要时拆出新段落。
 * 目标段落之外**所有段落引用相等**。
 */
export function pasteIntoPresentation(
  presentation: Presentation,
  target: ParagraphTarget,
  start: number,
  end: number,
  content: ClipboardContent,
): Presentation {
  return mapShapeTextBody(presentation, target, (body) => {
    const paragraph = requireEditableParagraph(body, target.paragraph_index);
    validateParagraphSelection(paragraph, start, end);
    return pasteIntoBody(body, target.paragraph_index, start, end, content);
  });
}

// ---------------------------------------------------------------------------
// 查找替换（PPT-14）：对象级 / 页级 / 文稿级（含表格单元格与演讲备注）
// ---------------------------------------------------------------------------

/**
 * 查询在**文稿层**的入口校验：空串 / 未知模式 / 畸形正则一律**先失败**。
 *
 * 与 `text.assertQueryValid` 的区别只在错误类型——文稿层统一抛 `PresentationOperationError`，
 * 具名 `invalid_pattern` / `empty_query`，让"模式写错"与"零命中"在调用方那里可区分：
 * 前者**失败保旧**（抛错、原文稿不动），后者返回原文稿对象（`===`）。
 */
function assertPresentationQuery(query: string, options?: FindOptions): void {
  if (query === '') {
    throw new PresentationOperationError('empty_query', '查找串不能为空');
  }
  try {
    assertQueryValid(query, options);
  } catch (error) {
    if (error instanceof TextEditError) {
      const reason: PresentationOperationErrorReason =
        error.reason === 'empty_query' ? 'empty_query' : 'invalid_pattern';
      throw new PresentationOperationError(reason, error.message);
    }
    throw error;
  }
}

/** 对象级查找：返回命中（含段落下标）。 */
export function findInTextBody(body: TextBody, query: string, options?: FindOptions): readonly ShapeTextMatch[] {
  const matches: ShapeTextMatch[] = [];
  body.paragraphs.forEach((paragraph, paragraphIndex) => {
    for (const match of findText(paragraph, query, options)) {
      matches.push({ paragraph_index: paragraphIndex, ...match });
    }
  });
  return matches;
}

/** 表格里一个承载文本的格：位置（行 / 列）+ 其文本体。`text === null` 的格不参与查找 / 替换。 */
interface TableCellRef {
  readonly row_index: number;
  readonly column_index: number;
  readonly body: TextBody;
}

function textCellRefs(shape: Extract<Shape, { kind: 'table' }>): readonly TableCellRef[] {
  const refs: TableCellRef[] = [];
  shape.rows.forEach((row, rowIndex) => {
    row.cells.forEach((cell, columnIndex) => {
      if (cell.text !== null) {
        refs.push({ row_index: rowIndex, column_index: columnIndex, body: cell.text });
      }
    });
  });
  return refs;
}

function collectMatches(
  shapes: readonly Shape[],
  slideId: number,
  query: string,
  options: FindOptions | undefined,
  out: SlideFindMatch[],
): void {
  for (const shape of shapes) {
    const body = bodyOfTextShape(shape);
    if (body !== null) {
      for (const match of findInTextBody(body, query, options)) {
        out.push({ slide_id: slideId, shape_id: shape.shape_id, location: { kind: 'shape' }, ...match });
      }
      continue;
    }
    if (shape.kind === 'table') {
      for (const ref of textCellRefs(shape)) {
        for (const match of findInTextBody(ref.body, query, options)) {
          out.push({
            slide_id: slideId,
            shape_id: shape.shape_id,
            location: { kind: 'table_cell', row_index: ref.row_index, column_index: ref.column_index },
            ...match,
          });
        }
      }
      continue;
    }
    if (shape.kind === 'group') {
      collectMatches(shape.children, slideId, query, options, out);
    }
  }
}

/** 演讲备注查找：备注不挂形状，命中记 `location: notes` 且 `shape_id: null`（不用哨兵值冒充）。 */
function collectNotesMatches(
  slide: Slide,
  query: string,
  options: FindOptions | undefined,
  out: SlideFindMatch[],
): void {
  if (slide.notes === null) {
    return;
  }
  for (const match of findInTextBody(slide.notes, query, options)) {
    out.push({ slide_id: slide.slide_id, shape_id: null, location: { kind: 'notes' }, ...match });
  }
}

/** 单对象查找（跨页过滤到指定页 / 对象；表格对象会带上单元格坐标）。 */
export function findInShape(
  presentation: Presentation,
  target: ShapeTarget,
  query: string,
  options?: FindOptions,
): readonly ShapeFindMatch[] {
  return findInPresentation(presentation, query, options)
    .filter(
      (match): match is SlideFindMatch & { readonly shape_id: number } =>
        match.slide_id === target.slide_id && match.shape_id === target.shape_id,
    )
    .map((match) => ({
      shape_id: match.shape_id,
      paragraph_index: match.paragraph_index,
      start: match.start,
      end: match.end,
      text: match.text,
      location: match.location,
    }));
}

/**
 * 整份文稿查找：文本框 / 自选图形文本（组合递归）**+ 表格单元格 + 演讲备注**。
 *
 * 每个命中带 `location` 说明它落在正文形状、表格的哪个格、还是备注；备注命中 `shape_id` 为 `null`。
 * 命中按页序 / z 序（每页先形状后备注）。
 *
 * @throws {PresentationOperationError} 空查询 / 畸形模式（`invalid_pattern`）。
 */
export function findInPresentation(
  presentation: Presentation,
  query: string,
  options?: FindOptions,
): readonly SlideFindMatch[] {
  assertPresentationQuery(query, options);
  const out: SlideFindMatch[] = [];
  for (const slide of presentation.slides) {
    collectMatches(slide.shapes, slide.slide_id, query, options, out);
    collectNotesMatches(slide, query, options, out);
  }
  return out;
}

/** 对象级替换结果。 */
export interface BodyReplaceResult {
  readonly body: TextBody;
  readonly matches: readonly ShapeTextMatch[];
  readonly replaced: number;
}

/**
 * 在某文本体里替换全部命中。**从右往左**逐段应用（`text.replaceText`），未命中的段落引用相等；
 * 全程零命中 ⇒ 返回**原体对象**。
 */
export function replaceInTextBody(
  body: TextBody,
  query: string,
  replacement: string,
  options?: FindOptions,
): BodyReplaceResult {
  if (query === '') {
    throw new PresentationOperationError('empty_query', '查找串不能为空');
  }
  const matches: ShapeTextMatch[] = [];
  let replaced = 0;
  const paragraphs = body.paragraphs.map((paragraph, paragraphIndex) => {
    const result = replaceText(paragraph, query, replacement, options);
    if (result.replaced === 0) {
      return paragraph;
    }
    replaced += result.replaced;
    for (const match of result.matches) {
      matches.push({ paragraph_index: paragraphIndex, ...match });
    }
    return result.paragraph;
  });
  return replaced === 0 ? { body, matches, replaced } : { body: { paragraphs }, matches, replaced };
}

/**
 * 表格单元格 / 演讲备注是**原子单元**：只要某段含事实引用 run，字符坐标替换就**具名拒绝整格 / 整备注**，
 * 不做"改一半留一半"（那会悄悄丢格式语义）。正文形状仍按既有口径跳过事实段（只读查找本就不猜位置）。
 */
function requireNoFactRuns(body: TextBody, where: string): void {
  body.paragraphs.forEach((paragraph, index) => {
    if (paragraphTextMap(paragraph).has_fact_run) {
      throw new PresentationOperationError(
        'paragraph_has_fact_run',
        `${where} 的段落 paragraph_index=${String(index)} 含事实引用 run，字符坐标不稳定，不能按字符替换`,
      );
    }
  });
}

/** 表格行替换：只重建"有命中"的格 / 行；未命中的格、整行对象**引用相等**。 */
function replaceInTableRows(
  rows: readonly TableRow[],
  slideId: number,
  shapeId: number,
  query: string,
  replacement: string,
  options: FindOptions | undefined,
  acc: ReplaceAcc,
): readonly TableRow[] {
  let changed = false;
  const next = rows.map((row, rowIndex) => {
    let rowChanged = false;
    const cells = row.cells.map((cell, columnIndex) => {
      if (cell.text === null) {
        return cell;
      }
      requireNoFactRuns(cell.text, `表格单元格 (${String(rowIndex)},${String(columnIndex)})`);
      const result = replaceInTextBody(cell.text, query, replacement, options);
      if (result.replaced === 0) {
        return cell;
      }
      acc.replaced += result.replaced;
      for (const match of result.matches) {
        acc.matches.push({
          slide_id: slideId,
          shape_id: shapeId,
          location: { kind: 'table_cell', row_index: rowIndex, column_index: columnIndex },
          ...match,
        });
      }
      rowChanged = true;
      return { ...cell, text: result.body };
    });
    if (!rowChanged) {
      return row;
    }
    changed = true;
    return { ...row, cells };
  });
  return changed ? next : rows;
}

/** 文稿级替换结果。 */
export interface PresentationReplaceResult {
  readonly presentation: Presentation;
  readonly matches: readonly SlideFindMatch[];
  readonly replaced: number;
}

interface ReplaceAcc {
  replaced: number;
  matches: SlideFindMatch[];
  /** 只改这一个 `shape_id`（`undefined` = 全改）。 */
  onlyShapeId: number | undefined;
}

function replaceInShapes(
  shapes: readonly Shape[],
  slideId: number,
  query: string,
  replacement: string,
  options: FindOptions | undefined,
  acc: ReplaceAcc,
): readonly Shape[] {
  let changed = false;
  const next = shapes.map((shape) => {
    const body = bodyOfTextShape(shape);
    if (body !== null) {
      if (acc.onlyShapeId !== undefined && shape.shape_id !== acc.onlyShapeId) {
        return shape;
      }
      const result = replaceInTextBody(body, query, replacement, options);
      if (result.replaced === 0) {
        return shape;
      }
      acc.replaced += result.replaced;
      for (const match of result.matches) {
        acc.matches.push({ slide_id: slideId, shape_id: shape.shape_id, location: { kind: 'shape' }, ...match });
      }
      changed = true;
      return withBodyOfTextShape(shape, result.body);
    }
    if (shape.kind === 'table') {
      if (acc.onlyShapeId !== undefined && shape.shape_id !== acc.onlyShapeId) {
        return shape;
      }
      const rows = replaceInTableRows(shape.rows, slideId, shape.shape_id, query, replacement, options, acc);
      if (rows === shape.rows) {
        return shape;
      }
      changed = true;
      return { ...shape, rows };
    }
    if (shape.kind === 'group') {
      const children = replaceInShapes(shape.children, slideId, query, replacement, options, acc);
      if (children.some((child, i) => child !== shape.children[i])) {
        changed = true;
        return { ...shape, children };
      }
    }
    return shape;
  });
  return changed ? next : shapes;
}

/** 演讲备注替换：零命中 ⇒ 返回原页对象；否则只换 `notes`，其余字段与页引用不变。 */
function replaceInNotes(
  slide: Slide,
  query: string,
  replacement: string,
  options: FindOptions | undefined,
  acc: ReplaceAcc,
): Slide {
  if (slide.notes === null) {
    return slide;
  }
  requireNoFactRuns(slide.notes, `演讲备注 slide_id=${String(slide.slide_id)}`);
  const result = replaceInTextBody(slide.notes, query, replacement, options);
  if (result.replaced === 0) {
    return slide;
  }
  acc.replaced += result.replaced;
  for (const match of result.matches) {
    acc.matches.push({ slide_id: slide.slide_id, shape_id: null, location: { kind: 'notes' }, ...match });
  }
  return { ...slide, notes: result.body };
}

function replaceAcross(
  presentation: Presentation,
  query: string,
  replacement: string,
  options: FindOptions | undefined,
  onlyShapeId: number | undefined,
  onlySlideId: number | undefined,
): PresentationReplaceResult {
  assertPresentationQuery(query, options);
  const acc: ReplaceAcc = { replaced: 0, matches: [], onlyShapeId };
  let changed = false;
  const slides = presentation.slides.map((slide) => {
    if (onlySlideId !== undefined && slide.slide_id !== onlySlideId) {
      return slide;
    }
    const shapes = replaceInShapes(slide.shapes, slide.slide_id, query, replacement, options, acc);
    const withShapes: Slide = shapes === slide.shapes ? slide : { ...slide, shapes };
    // 备注不属于任何形状：只在"整稿替换"（未限定 shape_id）时纳入；`replaceInShape` 不碰备注。
    const next = onlyShapeId === undefined ? replaceInNotes(withShapes, query, replacement, options, acc) : withShapes;
    if (next === slide) {
      return slide;
    }
    changed = true;
    return next;
  });
  return {
    presentation: changed ? { ...presentation, slides } : presentation,
    matches: acc.matches,
    replaced: acc.replaced,
  };
}

/**
 * **整份文稿查找替换**（PPT-14）。范围含文本框 / 自选图形 / 表格单元格 / 演讲备注；
 * 命中按页序 / z 序（每页先形状后备注）。未命中的页、对象、段落引用相等。
 * 全程零命中 ⇒ 返回**原文稿对象**（便于"失败保旧"断言）。
 *
 * @throws {PresentationOperationError} 空查询（`empty_query`）/ 畸形模式（`invalid_pattern`）/
 *   表格或备注里含事实引用 run 的段落（`paragraph_has_fact_run`）。
 */
export function replaceInPresentation(
  presentation: Presentation,
  query: string,
  replacement: string,
  options?: FindOptions,
): PresentationReplaceResult {
  return replaceAcross(presentation, query, replacement, options, undefined, undefined);
}

/** **单对象**查找替换（PPT-14「导入既有文件后仍能改指定对象」）。表格对象会改其全部单元格；不含备注。 */
export function replaceInShape(
  presentation: Presentation,
  target: ShapeTarget,
  query: string,
  replacement: string,
  options?: FindOptions,
): PresentationReplaceResult {
  return replaceAcross(presentation, query, replacement, options, target.shape_id, target.slide_id);
}

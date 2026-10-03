/**
 * 几何与层级用例（PPT-05）。
 *
 * ## 核心判据：位置关系保存重开后保持
 *
 * `relativeGeometry` 把一组对象的绝对几何、两两相对偏移与尺寸差、层级压成快照。下面先记一份，
 * 把模型**渲染成 PPTX 字节**再 `importPresentation` 读回，再记一份，断言两份 `toEqual` ——
 * 这是"位置关系在保存重开后保持"的**读回证据**（不是描述文字）。
 *
 * ## 反向对照
 *
 * - `resizeShape` 用 `center` 锚点时必须**补偿**坐标；用例断言了它确实平移，而 `top_left` 不动 ——
 *   相反的实现（改尺寸却不动坐标）会在 `center` 断言处失败。
 * - `alignSelectionToSlide` 必须把选中对象**整体平移**；用例断言对齐前后**两两相对偏移不变** ——
 *   相反的实现（逐个去对齐页面而破坏相对关系）会在 `pairs` 断言处失败。
 */

import { describe, expect, it } from 'vitest';

import { literalText, transform, type Presentation, type Shape } from './model.js';
import { addShape, addSlide } from './operations.js';
import { emptyPresentation, renderPresentation } from './render.js';
import { importPresentation } from './roundtrip.js';
import {
  GeometryError,
  alignSelection,
  alignSelectionToSlide,
  boundsOf,
  boundsTransform,
  bringForward,
  bringToFront,
  distributeSelection,
  distributeWithGap,
  effectiveGeometryOf,
  flipShape,
  groupSelection,
  moveShapeTo,
  nudgeShape,
  relativeGeometry,
  resizeShape,
  rotateShapeTo,
  scaleBoundsTo,
  sendBackward,
  sendToBack,
  setBounds,
  ungroupSelection,
  zOrder,
} from './geometry.js';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

function box(id: number, x: number, y: number, cx = 1000, cy = 500): Shape {
  return {
    kind: 'text_box',
    shape_id: id,
    name: `Box ${String(id)}`,
    transform: transform(x, y, cx, cy),
    text: literalText(`t${String(id)}`),
  };
}

function deckWith(shapes: readonly Shape[]): { readonly deck: Presentation; readonly slideId: number } {
  const added = addSlide(emptyPresentation('p1', '几何测试'));
  let deck = added.presentation;
  for (const shape of shapes) {
    deck = addShape(deck, added.slide_id, shape);
  }
  return { deck, slideId: added.slide_id };
}

function tx(presentation: Presentation, slideId: number, shapeId: number) {
  const shape = presentation.slides.find((slide) => slide.slide_id === slideId)?.shapes.find((s) => s.shape_id === shapeId);
  if (shape === undefined) throw new Error(`找不到对象 ${String(shapeId)}`);
  return shape.transform;
}

// ---------------------------------------------------------------------------
// 尺寸 / 坐标 / 旋转 / 翻转
// ---------------------------------------------------------------------------

describe('PPT-05：尺寸、坐标、旋转、翻转', () => {
  it('setBounds 一次设 x/y/cx/cy，旋转翻转沿用原值', () => {
    const { deck, slideId } = deckWith([box(2, 10, 20)]);
    const rotated = rotateShapeTo(deck, slideId, 2, 30);
    const bounded = setBounds(rotated, slideId, 2, { x_emu: 100, y_emu: 200, cx_emu: 3000, cy_emu: 1500 });
    expect(tx(bounded, slideId, 2)).toMatchObject({ x_emu: 100, y_emu: 200, cx_emu: 3000, cy_emu: 1500, rotation_deg: 30 });
    expect(() => setBounds(deck, slideId, 2, { x_emu: 0, y_emu: 0, cx_emu: -1, cy_emu: 10 })).toThrow(GeometryError);
  });

  it('resizeShape 锚点：top_left 不动坐标；center 补偿半个差（反向对照点）', () => {
    const { deck, slideId } = deckWith([box(2, 100, 200, 1000, 500)]);
    const topLeft = resizeShape(deck, slideId, 2, 2000, 1000);
    expect(tx(topLeft, slideId, 2)).toMatchObject({ x_emu: 100, y_emu: 200, cx_emu: 2000, cy_emu: 1000 });

    const centered = resizeShape(deck, slideId, 2, 2000, 1000, { anchor: 'center' });
    // 宽 +1000 ⇒ x -500；高 +500 ⇒ y -250。
    expect(tx(centered, slideId, 2)).toMatchObject({ x_emu: -400, y_emu: -50, cx_emu: 2000, cy_emu: 1000 });
    // 反向对照：若实现没补偿坐标，这里会是 (100, 200)。
    expect(tx(centered, slideId, 2).x_emu).not.toBe(100);
  });

  it('moveShapeTo 设绝对坐标；nudgeShape 相对平移；rotateShapeTo 归一化；flipShape 设翻转', () => {
    const { deck, slideId } = deckWith([box(2, 0, 0)]);
    expect(tx(moveShapeTo(deck, slideId, 2, 900, 800), slideId, 2)).toMatchObject({ x_emu: 900, y_emu: 800 });
    expect(tx(nudgeShape(deck, slideId, 2, 5, -5), slideId, 2)).toMatchObject({ x_emu: 5, y_emu: -5 });
    expect(tx(rotateShapeTo(deck, slideId, 2, 405), slideId, 2).rotation_deg).toBe(45);
    expect(tx(flipShape(deck, slideId, 2, 'h'), slideId, 2)).toMatchObject({ flip_h: true, flip_v: false });
    expect(tx(flipShape(deck, slideId, 2, 'both'), slideId, 2)).toMatchObject({ flip_h: true, flip_v: true });
    expect(() => nudgeShape(deck, slideId, 99, 1, 1)).toThrow(GeometryError);
  });
});

// ---------------------------------------------------------------------------
// 对齐 / 分布
// ---------------------------------------------------------------------------

describe('PPT-05：对齐与分布', () => {
  it('alignSelection 相互对齐（委托原语）', () => {
    const { deck, slideId } = deckWith([box(2, 100, 0), box(3, 500, 100)]);
    const aligned = alignSelection(deck, slideId, [2, 3], 'left');
    expect([tx(aligned, slideId, 2).x_emu, tx(aligned, slideId, 3).x_emu]).toEqual([100, 100]);
  });

  it('alignSelectionToSlide 把选中对象**整体平移**到页面边缘（相对关系不变，反向对照点）', () => {
    const { deck, slideId } = deckWith([box(2, 100, 0), box(3, 500, 100)]);
    const before = relativeGeometry(deck, slideId, [2, 3]);

    const rightAligned = alignSelectionToSlide(deck, slideId, [2, 3], 'right');
    const rightEdge = Math.max(tx(rightAligned, slideId, 2).x_emu + tx(rightAligned, slideId, 2).cx_emu, tx(rightAligned, slideId, 3).x_emu + tx(rightAligned, slideId, 3).cx_emu);
    expect(rightEdge).toBe(deck.size.cx_emu);

    // 反向对照：整体平移 ⇒ 两两相对偏移逐字段不变。
    expect(relativeGeometry(rightAligned, slideId, [2, 3]).pairs).toEqual(before.pairs);
    expect(() => alignSelectionToSlide(deck, slideId, [], 'left')).toThrow(GeometryError);
  });

  it('distributeSelection 均分间隙；distributeWithGap 固定间距（gap=0 ⇒ 边贴边）', () => {
    const { deck, slideId } = deckWith([box(2, 0, 0), box(3, 5000, 0), box(4, 9000, 0)]);
    const distributed = distributeWithGap(deck, slideId, [2, 3, 4], 'horizontal', 0);
    expect([tx(distributed, slideId, 2).x_emu, tx(distributed, slideId, 3).x_emu, tx(distributed, slideId, 4).x_emu]).toEqual([0, 1000, 2000]);

    const spaced = distributeWithGap(deck, slideId, [2, 3, 4], 'horizontal', 250);
    expect([tx(spaced, slideId, 2).x_emu, tx(spaced, slideId, 3).x_emu, tx(spaced, slideId, 4).x_emu]).toEqual([0, 1250, 2500]);

    // 委托原语：均分后首尾位置不变、中间点落在等分处。
    const even = distributeSelection(deck, slideId, [2, 3, 4], 'horizontal');
    expect(tx(even, slideId, 2).x_emu).toBe(0);
    expect(tx(even, slideId, 4).x_emu + tx(even, slideId, 4).cx_emu).toBe(10000);
    expect(() => distributeWithGap(deck, slideId, [2], 'horizontal', 10)).toThrow(GeometryError);
  });
});

// ---------------------------------------------------------------------------
// 层级 / 组合
// ---------------------------------------------------------------------------

describe('PPT-05：前后层级与组合', () => {
  it('置顶 / 置底 / 上移 / 下移 与 zOrder', () => {
    const { deck, slideId } = deckWith([box(2, 0, 0), box(3, 0, 0), box(4, 0, 0)]);
    expect(zOrder(deck, slideId)).toEqual([2, 3, 4]);
    expect(zOrder(bringToFront(deck, slideId, 2), slideId)).toEqual([3, 4, 2]);
    expect(zOrder(sendToBack(deck, slideId, 4), slideId)).toEqual([4, 2, 3]);
    expect(zOrder(bringForward(deck, slideId, 2), slideId)).toEqual([3, 2, 4]);
    expect(zOrder(sendBackward(deck, slideId, 4), slideId)).toEqual([2, 4, 3]);
  });

  it('groupSelection 自动分配唯一 id；取消组合后子对象回到页面', () => {
    const { deck, slideId } = deckWith([box(2, 100, 100), box(3, 300, 200)]);
    const grouped = groupSelection(deck, slideId, [2, 3]);
    // 已有 id 2/3 ⇒ 自动分配 4。
    expect(grouped.shape_id).toBe(4);
    const group = grouped.presentation.slides[0]?.shapes[0];
    expect(group?.kind).toBe('group');
    expect(boundsOf(group as Shape)).toMatchObject({ x_emu: 100, y_emu: 100, cx_emu: 1200, cy_emu: 600 });

    const ungrouped = ungroupSelection(grouped.presentation, slideId, 4);
    expect(zOrder(ungrouped, slideId)).toEqual([2, 3]);
    // 子对象绝对几何原样（组合不改子坐标）。
    expect(boundsOf(ungrouped.slides[0]?.shapes[0] as Shape)).toEqual({ x_emu: 100, y_emu: 100, cx_emu: 1000, cy_emu: 500 });

    expect(() => groupSelection(deck, slideId, [2])).toThrow(GeometryError);
    expect(() => groupSelection(deck, slideId, [2, 3], { shape_id: 2 })).toThrow(GeometryError);
  });

  it('scaleBoundsTo 按页面比例缩放', () => {
    const scaled = scaleBoundsTo({ x_emu: 100, y_emu: 200, cx_emu: 1000, cy_emu: 500 }, { cx_emu: 1000, cy_emu: 1000 }, { cx_emu: 2000, cy_emu: 500 });
    expect(scaled).toEqual({ x_emu: 200, y_emu: 100, cx_emu: 2000, cy_emu: 250 });
    expect(() => scaleBoundsTo({ x_emu: 0, y_emu: 0, cx_emu: 1, cy_emu: 1 }, { cx_emu: 0, cy_emu: 10 }, { cx_emu: 1, cy_emu: 1 })).toThrow(GeometryError);
  });
});

// ---------------------------------------------------------------------------
// 位置关系保存重开后保持（真实字节）
// ---------------------------------------------------------------------------

describe('PPT-05：位置关系保存重开后保持（渲染 → 导入读回）', () => {
  it('坐标 / 尺寸 / 旋转 / 翻转 / 层级 / 两两相对偏移 全部保持一致', () => {
    const { deck, slideId } = deckWith([box(2, 100, 200, 1000, 500), box(3, 4000, 100, 2000, 800), box(4, 200, 3000, 1500, 600)]);
    const transformed = rotateShapeTo(setBounds(flipShape(deck, slideId, 3, 'h'), slideId, 4, { x_emu: 200, y_emu: 3000, cx_emu: 1500, cy_emu: 600 }), slideId, 2, 45);

    const before = relativeGeometry(transformed, slideId);
    const bytes = renderPresentation(transformed).bytes;
    const reread = importPresentation(bytes);
    const rereadSlideId = reread.presentation.slides[0]?.slide_id;
    if (rereadSlideId === undefined) throw new Error('读回后没有幻灯片');
    const after = relativeGeometry(reread.presentation, rereadSlideId);

    // 逐字段相等：页面尺寸、每个对象的绝对几何、旋转、翻转、层级、两两相对偏移。
    expect(after).toEqual(before);
  });

  it('组合作为一个对象也能往返保持（组整体几何 + 组内子对象层级）', () => {
    const { deck, slideId } = deckWith([box(2, 100, 100), box(3, 300, 200), box(4, 50, 50, 800, 800)]);
    const grouped = groupSelection(deck, slideId, [2, 3], { name: 'G' });
    const bytes = renderPresentation(grouped.presentation).bytes;
    const reread = importPresentation(bytes);
    const rereadSlideId = reread.presentation.slides[0]?.slide_id;
    if (rereadSlideId === undefined) throw new Error('读回后没有幻灯片');

    const group = reread.presentation.slides[0]?.shapes.find((shape) => shape.kind === 'group');
    expect(group?.kind).toBe('group');
    expect(boundsOf(group as Shape)).toMatchObject({ x_emu: 100, y_emu: 100, cx_emu: 1200, cy_emu: 600 });
    if (group?.kind === 'group') {
      expect(group.children.map((child) => child.shape_id)).toEqual([2, 3]);
      expect(boundsOf(group.children[0] as Shape)).toEqual({ x_emu: 100, y_emu: 100, cx_emu: 1000, cy_emu: 500 });
    }
    // 顶层层级也保持：`groupShapes` 把组合放在最上层（其余对象在下），读回仍是这个顺序。
    expect(reread.presentation.slides[0]?.shapes.map((shape) => shape.kind)).toEqual(['text_box', 'group']);
  });

  it('boundsTransform 造出的变换与 boundsOf 互逆', () => {
    const bounds = { x_emu: 7, y_emu: 8, cx_emu: 9, cy_emu: 10 };
    expect(boundsOf({ ...box(2, 0, 0), transform: boundsTransform(bounds) })).toEqual(bounds);
  });
});

// ---------------------------------------------------------------------------
// P-I11：组合内相对几何（include_nested）
// ---------------------------------------------------------------------------

/** 两个盒子组成一个组合（组合 id = 4，bbox = (100,100,1200,600)）。 */
function groupedDeck(): { readonly deck: Presentation; readonly slideId: number; readonly groupId: number } {
  const { deck, slideId } = deckWith([box(2, 100, 100, 1000, 500), box(3, 300, 200, 1000, 500)]);
  const grouped = groupSelection(deck, slideId, [2, 3], { shape_id: 4, name: 'G' });
  return { deck: grouped.presentation, slideId, groupId: 4 };
}

describe('P-I11：组合内相对几何（include_nested）', () => {
  it('缺省不展开组合（旧行为不变）；include_nested 给出子对象有效几何与组内相对偏移', () => {
    const { deck, slideId } = groupedDeck();

    // 缺省：只取顶层对象（这里只有组合本身），且不产生组合字段。
    const flat = relativeGeometry(deck, slideId);
    expect(flat.shapes.map((entry) => entry.shape_id)).toEqual([4]);
    expect('depth' in (flat.shapes[0] as object)).toBe(false);

    // include_nested：父在文档顺序里先于其子（= 渲染顺序），子对象几何按组合合成口径给出。
    const nested = relativeGeometry(deck, slideId, { include_nested: true });
    expect(nested.shapes.map((entry) => entry.shape_id)).toEqual([4, 2, 3]);
    expect(nested.shapes[0]).toMatchObject({ shape_id: 4, parent_group_id: null, depth: 0, x_emu: 100, y_emu: 100 });
    const child2 = nested.shapes.find((entry) => entry.shape_id === 2);
    // 有效坐标 = 组合原点 (100,100) + 子坐标 (100,100) = (200,200)；相对组合原点偏移 = (100,100)。
    expect(child2).toMatchObject({ depth: 1, parent_group_id: 4, x_emu: 200, y_emu: 200 });
    expect(child2?.offset_in_group_emu).toEqual({ dx_emu: 100, dy_emu: 100 });
  });

  it('组合整体平移 ⇒ 子对象有效几何随父平移，组内相对偏移不变（child moves with parent）', () => {
    const { deck, slideId, groupId } = groupedDeck();
    const before = relativeGeometry(deck, slideId, { include_nested: true });
    const moved = moveShapeTo(deck, slideId, groupId, 900, 800);
    const after = relativeGeometry(moved, slideId, { include_nested: true });

    const beforeChild = before.shapes.find((entry) => entry.shape_id === 2);
    const afterChild = after.shapes.find((entry) => entry.shape_id === 2);
    // 组合从 (100,100) 移到 (900,800)：子对象有效坐标同步 +800 / +700。
    expect(afterChild?.x_emu).toBe((beforeChild?.x_emu ?? 0) + 800);
    expect(afterChild?.y_emu).toBe((beforeChild?.y_emu ?? 0) + 700);
    // 组内相对偏移不受父平移影响（子没有相对组合滑动）。
    expect(afterChild?.offset_in_group_emu).toEqual(beforeChild?.offset_in_group_emu);
  });

  it('effectiveGeometryOf 与 include_nested 快照同口径', () => {
    const { deck, slideId } = groupedDeck();
    const effective = effectiveGeometryOf(deck, slideId, 2);
    expect(effective).toMatchObject({ shape_id: 2, parent_group_id: 4, depth: 1, bounds: { x_emu: 200, y_emu: 200 } });
    expect(effective.offset_in_group_emu).toEqual({ dx_emu: 100, dy_emu: 100 });
    expect(() => effectiveGeometryOf(deck, slideId, 404)).toThrow(GeometryError);
  });

  it('include_nested 快照渲染 → 导入后逐字段相等（组合嵌套往返）', () => {
    const { deck, slideId } = groupedDeck();
    const before = relativeGeometry(deck, slideId, { include_nested: true });
    const reread = importPresentation(renderPresentation(deck).bytes);
    const rereadSlideId = reread.presentation.slides[0]?.slide_id;
    if (rereadSlideId === undefined) throw new Error('读回后没有幻灯片');
    const after = relativeGeometry(reread.presentation, rereadSlideId, { include_nested: true });
    expect(after).toEqual(before);
  });
});

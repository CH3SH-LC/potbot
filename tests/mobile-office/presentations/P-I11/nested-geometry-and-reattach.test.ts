/**
 * P-I11：组合内相对几何（`include_nested`）与 legacy null 端点的几何就近重挂。
 *
 * ## 本单元补的是 P04 诚实边界的模型侧对照
 *
 * P04 把"重开后连接符 `start/end_shape_id` 为 null"钉成了事实。P-I01 之后端点绑定进了 XML；
 * 本单元在**模型侧**补两件事：
 *
 * 1. `relativeGeometry(..., { include_nested: true })`：组合子对象按**组合合成口径**给出有效几何，
 *    并附"相对宿主组合原点"的偏移与嵌套深度；父组合平移 ⇒ 子对象有效几何随父平移。
 * 2. `reattachConnectorEndpoints`：对 legacy 的 null 端点，按**几何就近**在容差内重挂到正确形状。
 *
 * ## 独立性
 *
 * 组合合成口径不靠被测代码自证：本文件用 `readZip` 直接读导出页 XML，**自己**解析
 * `p:grpSp` 的 `a:off` / `a:ext` / `a:chOff` / `a:chExt` 与子 `p:sp` 的 `a:off`，按 OOXML 口径
 * 手算 `off + (子 off − chOff) × ext/chExt`，再与被测函数输出比对。
 *
 * 反向对照：`verifyShapeIdentity` 必须挡下"子对象 id 还在页里、但被挪出 `p:grpSp`"的结构退化。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/index.js';
import { transform, type Presentation, type Shape } from '../../../../src/presentations/model.js';
import { addShape, addSlide } from '../../../../src/presentations/operations.js';
import { emptyPresentation, renderPresentation } from '../../../../src/presentations/render.js';
import { importPresentation } from '../../../../src/presentations/roundtrip.js';
import { groupSelection, moveShapeTo, relativeGeometry } from '../../../../src/presentations/geometry.js';
import {
  PresentationShapeError,
  addAutoShape,
  addConnector,
  addFlowDiagram,
  buildShapesDeck,
  disconnectShapes,
  reattachConnectorEndpoints,
  verifyShapeIdentity,
} from '../../../../src/presentations/shapes.js';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

function box(id: number, x: number, y: number, cx = 1000, cy = 500): Shape {
  return {
    kind: 'text_box',
    shape_id: id,
    name: `Box ${String(id)}`,
    transform: transform(x, y, cx, cy),
    text: { paragraphs: [{ runs: [{ source: { kind: 'literal', text: `t${String(id)}` } }], level: 0, alignment: 'left', bullet: false }] },
  };
}

function deckWith(shapes: readonly Shape[]): { readonly deck: Presentation; readonly slideId: number } {
  const added = addSlide(emptyPresentation('p1', 'P-I11'));
  let deck = added.presentation;
  for (const shape of shapes) deck = addShape(deck, added.slide_id, shape);
  return { deck, slideId: added.slide_id };
}

function slideXmlOf(bytes: Uint8Array, index: number): string {
  const entry = readZip(bytes).by_path.get(`ppt/slides/slide${String(index)}.xml`);
  if (entry === undefined) throw new Error(`包内没有第 ${index} 页`);
  return Buffer.from(entry.data).toString('utf8');
}

/** 独立解析一页里第一个 `p:grpSp` 的 xfrm 与它第一个子 `p:sp` 的 a:off（不经被测代码）。 */
function parseFirstGroupXml(xml: string): {
  readonly off: readonly [number, number];
  readonly ext: readonly [number, number];
  readonly chOff: readonly [number, number];
  readonly chExt: readonly [number, number];
  readonly childOff: readonly [number, number];
} {
  const grp = xml.indexOf('<p:grpSp>');
  if (grp < 0) throw new Error('页里没有 p:grpSp');
  const grpSpPrEnd = xml.indexOf('</p:grpSpPr>', grp);
  const preamble = xml.slice(grp, grpSpPrEnd);

  const readXY = (re: RegExp, label: string): readonly [number, number] => {
    const m = re.exec(preamble);
    if (m === null) throw new Error(`preamble 里找不到 ${label}`);
    return [Number(m[1]), Number(m[2])];
  };
  const off = readXY(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/, 'a:off');
  const ext = ((): readonly [number, number] => {
    const m = /<a:ext cx="(-?\d+)" cy="(-?\d+)"\/>/.exec(preamble);
    if (m === null) throw new Error('preamble 里找不到 a:ext');
    return [Number(m[1]), Number(m[2])];
  })();
  const chOff = readXY(/<a:chOff x="(-?\d+)" y="(-?\d+)"\/>/, 'a:chOff');
  const chExt = ((): readonly [number, number] => {
    const m = /<a:chExt cx="(-?\d+)" cy="(-?\d+)"\/>/.exec(preamble);
    if (m === null) throw new Error('preamble 里找不到 a:chExt');
    return [Number(m[1]), Number(m[2])];
  })();

  const body = xml.slice(grpSpPrEnd, xml.indexOf('</p:grpSp>', grpSpPrEnd));
  const childMatch = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(body);
  if (childMatch === null) throw new Error('组合体里找不到子对象 a:off');
  const childOff: readonly [number, number] = [Number(childMatch[1]), Number(childMatch[2])];

  return { off, ext, chOff, chExt, childOff };
}

// ---------------------------------------------------------------------------
// A. 组合内相对几何
// ---------------------------------------------------------------------------

describe('P-I11：组合内相对几何（include_nested）', () => {
  /** 两个盒子 (100,100,1000,500)/(300,200,1000,500) 组成组合 ⇒ bbox (100,100,1200,600)。 */
  function grouped(): { readonly deck: Presentation; readonly slideId: number; readonly groupId: number } {
    const { deck, slideId } = deckWith([box(2, 100, 100), box(3, 300, 200)]);
    const result = groupSelection(deck, slideId, [2, 3], { shape_id: 4, name: 'G' });
    return { deck: result.presentation, slideId, groupId: 4 };
  }

  it('缺省只取顶层（旧行为）；include_nested 展开子对象并给出深度/宿主/组内偏移', () => {
    const { deck, slideId } = grouped();

    const flat = relativeGeometry(deck, slideId);
    expect(flat.shapes.map((entry) => entry.shape_id)).toEqual([4]);

    const nested = relativeGeometry(deck, slideId, { include_nested: true });
    expect(nested.shapes.map((entry) => entry.shape_id)).toEqual([4, 2, 3]);
    expect(nested.shapes[0]).toMatchObject({ shape_id: 4, depth: 0, parent_group_id: null });
    const child = nested.shapes.find((entry) => entry.shape_id === 2);
    expect(child).toMatchObject({ depth: 1, parent_group_id: 4, x_emu: 200, y_emu: 200, cx_emu: 1000, cy_emu: 500 });
    expect(child?.offset_in_group_emu).toEqual({ dx_emu: 100, dy_emu: 100 });
  });

  it('组合平移 ⇒ 子对象有效几何随父平移，组内相对偏移不变', () => {
    const { deck, slideId, groupId } = grouped();
    const beforeChild = relativeGeometry(deck, slideId, { include_nested: true }).shapes.find(
      (entry) => entry.shape_id === 2,
    );
    const moved = moveShapeTo(deck, slideId, groupId, 900, 800); // +800 / +700
    const afterChild = relativeGeometry(moved, slideId, { include_nested: true }).shapes.find(
      (entry) => entry.shape_id === 2,
    );
    expect(afterChild?.x_emu).toBe((beforeChild?.x_emu ?? 0) + 800);
    expect(afterChild?.y_emu).toBe((beforeChild?.y_emu ?? 0) + 700);
    expect(afterChild?.offset_in_group_emu).toEqual(beforeChild?.offset_in_group_emu);
  });

  it('合成口径对得上真实字节（独立解析 p:grpSp xfrm 手算 = 被测输出）', () => {
    const { deck, slideId } = grouped();
    const xml = slideXmlOf(renderPresentation(deck).bytes, 1);
    const parsed = parseFirstGroupXml(xml);

    // 渲染器声明的口径：chOff = 0、chExt = ext（缩放恒为 1）。
    expect(parsed.chOff).toEqual([0, 0]);
    expect(parsed.chExt).toEqual(parsed.ext);

    // OOXML：父坐标 = off + (子 − chOff) × ext/chExt（本例缩放 = 1）。
    const sx = parsed.chExt[0] === 0 ? 1 : parsed.ext[0] / parsed.chExt[0];
    const sy = parsed.chExt[1] === 0 ? 1 : parsed.ext[1] / parsed.chExt[1];
    const expectedX = parsed.off[0] + (parsed.childOff[0] - parsed.chOff[0]) * sx;
    const expectedY = parsed.off[1] + (parsed.childOff[1] - parsed.chOff[1]) * sy;

    const child = relativeGeometry(deck, slideId, { include_nested: true }).shapes.find(
      (entry) => entry.shape_id === 2,
    );
    expect(child?.x_emu).toBe(expectedX);
    expect(child?.y_emu).toBe(expectedY);
  });

  it('include_nested 快照渲染 → 导入后逐字段相等', () => {
    const { deck, slideId } = grouped();
    const before = relativeGeometry(deck, slideId, { include_nested: true });

    const reread = importPresentation(renderPresentation(deck).bytes);
    const rereadSlideId = reread.presentation.slides[0]?.slide_id;
    if (rereadSlideId === undefined) throw new Error('读回后没有幻灯片');
    const after = relativeGeometry(reread.presentation, rereadSlideId, { include_nested: true });

    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// B. legacy null 端点重挂
// ---------------------------------------------------------------------------

describe('P-I11：legacy null 端点按几何就近重挂', () => {
  it('断开端点的流程连线重挂回原来的两个节点', () => {
    const flow = addFlowDiagram(deckWith([]).deck, 1, {
      texts: ['A', 'B', 'C'],
      x_emu: 0,
      y_emu: 0,
      node_width_emu: 1000,
      node_height_emu: 400,
      gap_emu: 1000,
    });
    const original = (flow.presentation.slides[0]?.shapes ?? [])
      .filter((shape): shape is Extract<Shape, { kind: 'connector' }> => shape.kind === 'connector')
      .map((shape) => ({ id: shape.shape_id, from: shape.start_shape_id, to: shape.end_shape_id }));

    // 模拟重开后的 legacy 状态：端点全 null，几何留在原地。
    let deck = flow.presentation;
    for (const id of flow.connector_ids) deck = disconnectShapes(deck, 1, id);

    const result = reattachConnectorEndpoints(deck, 1);
    expect(result.unresolved).toHaveLength(0);
    expect(result.reattached).toHaveLength(original.length * 2);

    for (const binding of original) {
      const connector = result.presentation.slides[0]?.shapes.find((shape) => shape.shape_id === binding.id);
      if (connector?.kind !== 'connector') throw new Error('应当是连接符');
      expect(connector.start_shape_id).toBe(binding.from);
      expect(connector.end_shape_id).toBe(binding.to);
    }

    // 幂等：再跑一次不改变绑定。
    const again = reattachConnectorEndpoints(result.presentation, 1);
    expect(again.presentation).toBe(result.presentation);
  });

  it('容差边界：恰好落在容差内重挂、差 1 EMU 则不挂（保持 null）', () => {
    // 一条只连一端（start 为 null）的连接符：start 点 (500,200)，end 点 (500,4200)。
    // 形状外框 x∈[1000,2000] y∈[0,400]：start 到外框距离 500，end 距离 ≈ 3832。
    let deck = deckWith([]).deck;
    const node = addAutoShape(deck, 1, { transform: transform(1000, 0, 1000, 400), preset: 'rect' });
    deck = node.presentation;
    const wire = addConnector(deck, 1, { preset: 'line', transform: transform(500, 200, 0, 4000) });
    deck = wire.presentation;

    const inTolerance = reattachConnectorEndpoints(deck, 1, { tolerance_emu: 500 });
    expect(inTolerance.reattached).toHaveLength(1);
    expect(inTolerance.reattached[0]).toMatchObject({ endpoint: 'start', shape_id: node.shape_id, distance_emu: 500 });
    expect(inTolerance.unresolved).toHaveLength(1); // end 太远

    const tooTight = reattachConnectorEndpoints(deck, 1, { tolerance_emu: 499 });
    expect(tooTight.reattached).toHaveLength(0);
    expect(tooTight.unresolved).toHaveLength(2);
    expect(tooTight.presentation).toBe(deck);
  });

  it('两端都为空时不会重挂到同一个形状（无自连）；throw_on_unresolved 抛具名错', () => {
    let deck = deckWith([]).deck;
    const a = addAutoShape(deck, 1, { transform: transform(0, 0, 1000, 400), preset: 'rect' });
    deck = a.presentation;
    const wire = addConnector(deck, 1, { preset: 'line', transform: transform(500, 200, 0, 0) });
    deck = wire.presentation;

    const result = reattachConnectorEndpoints(deck, 1, { tolerance_emu: 100000 });
    const connector = result.presentation.slides[0]?.shapes.find((shape) => shape.shape_id === wire.shape_id);
    if (connector?.kind !== 'connector') throw new Error('应当是连接符');
    // 只有一个候选形状：start 抢占，end 因排除同形状而无法确定 ⇒ 该端保持 null。
    expect(connector.start_shape_id).toBe(a.shape_id);
    expect(connector.end_shape_id).toBeNull();
    expect(result.reattached).toHaveLength(1);
    expect(result.unresolved).toHaveLength(1);

    try {
      reattachConnectorEndpoints(deck, 1, { tolerance_emu: 100000, throw_on_unresolved: true });
      throw new Error('应当报错');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationShapeError);
      expect((error as PresentationShapeError).reason).toBe('no_reattach_candidate');
    }
  });
});

// ---------------------------------------------------------------------------
// C. verifyShapeIdentity 组合嵌套
// ---------------------------------------------------------------------------

describe('P-I11：verifyShapeIdentity 组合嵌套校验', () => {
  it('真实渲染的组合（含子对象）通过；子对象被挪出 p:grpSp ⇒ nested_element_mismatch', () => {
    let deck = deckWith([]).deck;
    const a = addAutoShape(deck, 1, { transform: transform(0, 0, 1000, 400), preset: 'rect' });
    deck = a.presentation;
    const b = addAutoShape(deck, 1, { transform: transform(2000, 0, 1000, 400), preset: 'ellipse' });
    deck = b.presentation;
    deck = groupSelection(deck, 1, [a.shape_id, b.shape_id], { shape_id: 4 }).presentation;

    const slide = slideXmlOf(buildShapesDeck(deck).bytes, 1);
    expect(() => verifyShapeIdentity(slide, deck, 1)).not.toThrow();

    // 构造"子对象 id 还在页里、但掉到顶层"的页 XML：结构退化，id 校验抓不到，嵌套校验必须抓住。
    const tampered = [
      '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
      ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">',
      '<p:cSld><p:spTree>',
      '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>',
      `<p:sp><p:nvSpPr><p:cNvPr id="${String(a.shape_id)}" name="a"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`,
      '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000" cy="400"/></a:xfrm>',
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:sp>',
      `<p:sp><p:nvSpPr><p:cNvPr id="${String(b.shape_id)}" name="b"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`,
      '<p:spPr><a:xfrm><a:off x="2000" y="0"/><a:ext cx="1000" cy="400"/></a:xfrm>',
      '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom></p:spPr></p:sp>',
      `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>`,
      '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3000" cy="400"/>',
      '<a:chOff x="0" y="0"/><a:chExt cx="3000" cy="400"/></a:xfrm></p:grpSpPr></p:grpSp>',
      '</p:spTree></p:cSld></p:sld>',
    ].join('');

    try {
      verifyShapeIdentity(tampered, deck, 1);
      throw new Error('应当报错');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationShapeError);
      expect((error as PresentationShapeError).reason).toBe('nested_element_mismatch');
    }
  });
});

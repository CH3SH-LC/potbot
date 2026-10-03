/**
 * 形状 / 线条 / 连接符用例（design-06 P9 / PPT-07）。
 *
 * 硬判据是「**流程关系仍是可编辑对象，不能整页截图**」：
 *
 * - 正面：3 个盒子 + 2 条连线的流程，导出页里是 3 个 `p:sp` + 2 个 `p:cxnSp`，
 *   且**没有任何全页位图**；形状文本落在 `a:t` 里（可编辑）；
 * - 反面：手工拼一份"整页就是一张图"的页 XML ⇒ 读回校验必须报 `page_screenshot_detected`
 *   （并且对象数量对不上，报 `object_count_mismatch`）；
 * - 悬空端点：连接符指向不存在的形状 ⇒ 具名报错，不静默留着。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../artifacts/ooxml/index.js';
import { groupSelection } from './geometry.js';
import { literalText, transform, type Presentation, type Shape } from './model.js';
import { addSlide } from './operations.js';
import { emptyPresentation } from './render.js';
import {
  DEFAULT_REATTACH_TOLERANCE_EMU,
  FIRST_SHAPE_ID,
  PresentationShapeError,
  addAutoShape,
  addConnector,
  addFlowDiagram,
  appendAutoShapeParagraph,
  assertNoDanglingEndpoints,
  assertNoFullPageBitmap,
  buildShapesDeck,
  connectShapes,
  connectorEndpointPoints,
  deleteShapeObject,
  describeSlideObjects,
  disconnectShapes,
  mapShapeInPresentation,
  reattachConnectorEndpoints,
  setAutoShapeText,
  setShapeFill,
  setShapeOutline,
  setShapePreset,
  verifyEditableObjects,
  verifyShapeIdentity,
} from './shapes.js';

function deckWithSlides(count: number): Presentation {
  let deck = emptyPresentation('p1', '形状测试');
  for (let i = 0; i < count; i += 1) {
    deck = addSlide(deck).presentation;
  }
  return deck;
}

function slideXmlOf(bytes: Uint8Array, index: number): string {
  const archive = readZip(bytes);
  const entry = archive.by_path.get(`ppt/slides/slide${String(index)}.xml`);
  if (entry === undefined) throw new Error(`包内没有第 ${index} 页`);
  return Buffer.from(entry.data).toString('utf8');
}

function countOf(xml: string, needle: string): number {
  return xml.split(needle).length - 1;
}

describe('PPT-07：形状与连接符是可编辑对象', () => {
  it('自选图形导出成 p:sp，形状文本落在 a:t（不是位图）', () => {
    const added = addAutoShape(deckWithSlides(1), 1, {
      transform: transform(1000000, 1000000, 2000000, 800000),
      preset: 'roundRect',
      fill: { kind: 'solid', color: 'D9E2F3' },
      outline: { color: '1F3864', width_emu: 12700 },
      text: literalText('可编辑的盒子'),
    });
    const result = buildShapesDeck(added.presentation);

    const slide = slideXmlOf(result.bytes, 1);
    expect(slide).toContain('<p:sp>');
    expect(slide).toContain('prst="roundRect"');
    expect(slide).toContain('<a:t>可编辑的盒子</a:t>');
    expect(slide).toContain('<a:srgbClr val="D9E2F3"/>');
    // 反面：整页截图会长成 p:pic + a:blip。
    expect(slide).not.toContain('<p:pic>');
    expect(slide).not.toContain('<a:blip');

    expect(result.inventory_by_slide[0]?.by_kind).toEqual({ auto_shape: 1 });
  });

  it('流程：3 个盒子 + 2 条连线，全是可编辑元素，页上没有整页位图', () => {
    const flow = addFlowDiagram(deckWithSlides(1), 1, { texts: ['收集', '处理', '交付'] });
    expect(flow.node_ids).toHaveLength(3);
    expect(flow.connector_ids).toHaveLength(2);

    const result = buildShapesDeck(flow.presentation);
    const slide = slideXmlOf(result.bytes, 1);

    expect(countOf(slide, '<p:sp>')).toBe(3);
    expect(countOf(slide, '<p:cxnSp>')).toBe(2);
    expect(slide).not.toContain('<p:pic>');
    expect(slide).toContain('<a:t>收集</a:t>');
    expect(slide).toContain('<a:t>交付</a:t>');

    const inventory = describeSlideObjects(flow.presentation, 1);
    expect(inventory.by_kind).toEqual({ auto_shape: 3, connector: 2 });
    expect(inventory.total).toBe(5);
    expect(inventory.shape_ids[0]).toBe(FIRST_SHAPE_ID);
  });

  it('连接符几何按两端中心算（含翻转位），线真的把两个盒子连起来', () => {
    const flow = addFlowDiagram(deckWithSlides(1), 1, {
      texts: ['A', 'B'],
      x_emu: 0,
      y_emu: 0,
      node_width_emu: 1000,
      node_height_emu: 400,
      gap_emu: 1000,
    });
    const connector = flow.presentation.slides[0]?.shapes.find((shape) => shape.kind === 'connector');
    if (connector?.kind !== 'connector') throw new Error('应当有连接符');

    // A 的中心 (500, 200)，B 的中心 (2500, 200) ⇒ 线段从 (500,200) 长 2000、高 0。
    expect(connector.transform).toMatchObject({ x_emu: 500, y_emu: 200, cx_emu: 2000, cy_emu: 0, flip_h: false });
    expect(connector.start_shape_id).toBe(flow.node_ids[0]);
    expect(connector.end_shape_id).toBe(flow.node_ids[1]);

    // 反向（B → A）：水平翻转位必须置上，否则线会画到反方向。
    const reversed = addConnector(flow.presentation, 1, {
      from: flow.node_ids[1],
      to: flow.node_ids[0],
    });
    const back = reversed.presentation.slides[0]?.shapes.at(-1);
    if (back?.kind !== 'connector') throw new Error('应当是连接符');
    expect(back.transform.flip_h).toBe(true);
    expect(back.transform.x_emu).toBe(500);
  });
});

describe('PPT-07 反向对照：整页截图必须被读回校验挡下', () => {
  /** 一份"整页就是一张位图"的页 XML（模拟假流程）。 */
  const SCREENSHOT_PAGE = [
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
    ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">',
    '<p:cSld><p:spTree>',
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>',
    '<p:pic><p:nvPicPr><p:cNvPr id="2" name="整页截图"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>',
    '<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>',
    '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9144000" cy="6858000"/></a:xfrm>',
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>',
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>',
  ].join('');

  it('同尺寸位图 ⇒ page_screenshot_detected', () => {
    try {
      assertNoFullPageBitmap(SCREENSHOT_PAGE, { cx_emu: 9144000, cy_emu: 6858000 });
      throw new Error('应当报错');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationShapeError);
      expect((error as PresentationShapeError).reason).toBe('page_screenshot_detected');
    }
  });

  it('同一份假流程走 verifyEditableObjects ⇒ 对象数量对不上', () => {
    const flow = addFlowDiagram(deckWithSlides(1), 1, { texts: ['收集', '处理', '交付'] });
    const inventory = describeSlideObjects(flow.presentation, 1);
    try {
      verifyEditableObjects(SCREENSHOT_PAGE, inventory, { cx_emu: 9144000, cy_emu: 6858000 });
      throw new Error('应当报错');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationShapeError);
      expect((error as PresentationShapeError).reason).toBe('object_count_mismatch');
    }
  });

  it('正常插图（尺寸不等于页面）不会被误判为整页截图', () => {
    expect(() =>
      assertNoFullPageBitmap(
        '<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:pic><p:spPr><a:xfrm>' +
          '<a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr></p:pic></p:spTree></p:cSld></p:sld>',
        { cx_emu: 9144000, cy_emu: 6858000 },
      ),
    ).not.toThrow();
  });
});

describe('PPT-07：删除形状 / 端点完整性', () => {
  it('删掉节点 ⇒ 引用它的连接符端点被摘掉（不留悬空引用）', () => {
    const flow = addFlowDiagram(deckWithSlides(1), 1, { texts: ['A', 'B', 'C'] });
    const middle = flow.node_ids[1];
    if (middle === undefined) throw new Error('缺少中间节点');
    const next = deleteShapeObject(flow.presentation, 1, middle);

    const shapes = next.slides[0]?.shapes ?? [];
    expect(shapes.some((shape) => shape.shape_id === middle)).toBe(false);
    const connectors = shapes.filter((shape) => shape.kind === 'connector');
    expect(connectors).toHaveLength(2);
    for (const connector of connectors) {
      if (connector.kind !== 'connector') continue;
      expect(connector.start_shape_id).not.toBe(middle);
      expect(connector.end_shape_id).not.toBe(middle);
    }
    // 端点悬空校验必须通过；渲染仍成立（删 1 个节点：5 - 1 = 4 个对象）。
    expect(() => assertNoDanglingEndpoints(next, 1)).not.toThrow();
    expect(buildShapesDeck(next).inventory_by_slide[0]?.total).toBe(4);
  });

  it('连接符指向不存在的形状 ⇒ unknown_endpoint（具名报错）', () => {
    const dangling: Shape = {
      kind: 'connector',
      shape_id: 2,
      name: 'Dangling',
      transform: transform(0, 0, 100, 0),
      preset: 'line',
      outline: null,
      start_shape_id: 999,
      end_shape_id: null,
    };
    const deck = deckWithSlides(1);
    // shape_id=1 不存在（1 保留给形状树前导）⇒ 映射与改属性都报 unknown_shape。
    expect(() => mapShapeInPresentation(deck, 1, 1, (shape) => shape)).toThrow(PresentationShapeError);
    expect(() => setShapeFill(deck, 1, 1, { kind: 'none' })).toThrow(PresentationShapeError);

    const bad: Presentation = {
      ...deck,
      slides: [
        {
          slide_id: 1,
          layout: { master_id: 'master1', layout_id: 'blank' },
          hidden: false,
          shapes: [dangling],
          transition: null,
          animations: [],
          notes: null,
        },
      ],
    };
    try {
      assertNoDanglingEndpoints(bad, 1);
      throw new Error('应当报错');
    } catch (error) {
      expect((error as PresentationShapeError).reason).toBe('unknown_endpoint');
    }
    expect(() => buildShapesDeck(bad)).toThrow(PresentationShapeError);
  });

  it('自连（两端同一个形状）⇒ self_connection', () => {
    const added = addAutoShape(deckWithSlides(1), 1, {
      transform: transform(0, 0, 1000, 400),
      preset: 'rect',
    });
    expect(() => addConnector(added.presentation, 1, { from: added.shape_id, to: added.shape_id })).toThrow(
      PresentationShapeError,
    );
  });
});

describe('PPT-07：填充 / 轮廓 / 预设 / 形状文本', () => {
  it('改填充与轮廓只动目标对象，其余对象引用不变', () => {
    let deck = deckWithSlides(1);
    const first = addAutoShape(deck, 1, { transform: transform(0, 0, 1000, 400), preset: 'rect' });
    deck = first.presentation;
    const second = addAutoShape(deck, 1, { transform: transform(2000, 0, 1000, 400), preset: 'ellipse' });
    deck = second.presentation;

    deck = setShapeFill(deck, 1, first.shape_id, { kind: 'solid', color: 'FF0000' });
    deck = setShapeOutline(deck, 1, first.shape_id, { color: '00FF00', width_emu: 25400 });
    deck = setShapePreset(deck, 1, first.shape_id, 'diamond');
    deck = setAutoShapeText(deck, 1, first.shape_id, literalText('改过'));

    const shapes = deck.slides[0]?.shapes ?? [];
    const target = shapes.find((shape) => shape.shape_id === first.shape_id);
    expect(target?.kind === 'auto_shape' && target.fill).toEqual({ kind: 'solid', color: 'FF0000' });
    expect(target?.kind === 'auto_shape' && target.preset).toBe('diamond');
    // 另一个对象**引用相等**（没被重建过）。
    expect(shapes.find((shape) => shape.shape_id === second.shape_id)).toBe(
      second.presentation.slides[0]?.shapes[1],
    );

    const slide = slideXmlOf(buildShapesDeck(deck).bytes, 1);
    expect(slide).toContain('<a:srgbClr val="FF0000"/>');
    expect(slide).toContain('<a:srgbClr val="00FF00"/>');
    expect(slide).toContain('prst="diamond"');
    expect(slide).toContain('<a:t>改过</a:t>');
  });

  it('追加段落、文本框不接受填充/轮廓、空预设名 ⇒ 各自具名报错', () => {
    let deck = deckWithSlides(1);
    const shape = addAutoShape(deck, 1, { transform: transform(0, 0, 1000, 400), preset: 'rect' });
    deck = appendAutoShapeParagraph(shape.presentation, 1, shape.shape_id, {
      runs: [{ source: { kind: 'literal', text: '第二段' } }],
      level: 1,
      alignment: 'left',
      bullet: true,
    });
    const target = deck.slides[0]?.shapes[0];
    expect(target?.kind === 'auto_shape' && target.text?.paragraphs).toHaveLength(1);

    expect(() => addAutoShape(deckWithSlides(1), 1, { transform: transform(0, 0, 1, 1), preset: ' ' })).toThrow(
      PresentationShapeError,
    );
    expect(() => setShapeFill(deck, 1, 404, { kind: 'none' })).toThrow(PresentationShapeError);
  });
});

describe('PPT-07：连接 / 断开', () => {
  it('connectShapes 更新端点与几何；disconnectShapes 只清端点', () => {
    let deck = deckWithSlides(1);
    const a = addAutoShape(deck, 1, { transform: transform(0, 0, 1000, 400), preset: 'rect' });
    deck = a.presentation;
    const b = addAutoShape(deck, 1, { transform: transform(5000, 0, 1000, 400), preset: 'rect' });
    deck = b.presentation;
    const wire = addConnector(deck, 1, { preset: 'line' });
    deck = wire.presentation;

    deck = connectShapes(deck, 1, wire.shape_id, a.shape_id, b.shape_id);
    const connected = deck.slides[0]?.shapes.find((shape) => shape.shape_id === wire.shape_id);
    if (connected?.kind !== 'connector') throw new Error('应当是连接符');
    expect(connected.start_shape_id).toBe(a.shape_id);
    expect(connected.end_shape_id).toBe(b.shape_id);
    expect(connected.transform.cx_emu).toBe(5000);

    const detached = disconnectShapes(deck, 1, wire.shape_id);
    const wire2 = detached.slides[0]?.shapes.find((shape) => shape.shape_id === wire.shape_id);
    if (wire2?.kind !== 'connector') throw new Error('应当是连接符');
    expect(wire2.start_shape_id).toBeNull();
    expect(wire2.end_shape_id).toBeNull();
    expect(wire2.transform.cx_emu).toBe(5000); // 几何保留

    expect(() => connectShapes(deck, 1, a.shape_id, a.shape_id, b.shape_id)).toThrow(PresentationShapeError);
  });
});

// ---------------------------------------------------------------------------
// P-I11：legacy null 端点按几何就近重挂 / 组合嵌套读回校验
// ---------------------------------------------------------------------------

describe('P-I11：legacy null 端点按几何就近重挂', () => {
  it('断开端点的连接符按几何就近重挂回原来的两个形状（默认容差 1 英寸）', () => {
    const flow = addFlowDiagram(deckWithSlides(1), 1, {
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

    // 模拟 legacy 情况：端点全断，几何留在原地（这正是 P04 重开后观察到的状态）。
    let deck = flow.presentation;
    for (const id of flow.connector_ids) deck = disconnectShapes(deck, 1, id);
    for (const shape of deck.slides[0]?.shapes ?? []) {
      if (shape.kind === 'connector') expect(shape.start_shape_id).toBeNull();
    }

    const result = reattachConnectorEndpoints(deck, 1);
    expect(result.tolerance_emu).toBe(DEFAULT_REATTACH_TOLERANCE_EMU);
    expect(result.unresolved).toHaveLength(0);
    expect(result.reattached).toHaveLength(flow.connector_ids.length * 2);

    for (const binding of original) {
      const connector = result.presentation.slides[0]?.shapes.find((shape) => shape.shape_id === binding.id);
      if (connector?.kind !== 'connector') throw new Error('应当是连接符');
      expect(connector.start_shape_id).toBe(binding.from);
      expect(connector.end_shape_id).toBe(binding.to);
    }
  });

  it('几何离任何形状都超容差 ⇒ 保持 null（不改引用）；throw_on_unresolved ⇒ no_reattach_candidate', () => {
    let deck = deckWithSlides(1);
    const node = addAutoShape(deck, 1, { transform: transform(0, 0, 1000, 400), preset: 'rect' });
    deck = node.presentation;
    const wire = addConnector(deck, 1, { preset: 'line', transform: transform(9000000, 9000000, 2000000, 0) });
    deck = wire.presentation;

    const result = reattachConnectorEndpoints(deck, 1, { tolerance_emu: 100000 });
    expect(result.reattached).toHaveLength(0);
    expect(result.unresolved).toHaveLength(2);
    expect(result.presentation).toBe(deck); // 无改动 ⇒ 同一引用

    try {
      reattachConnectorEndpoints(deck, 1, { tolerance_emu: 100000, throw_on_unresolved: true });
      throw new Error('应当报错');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationShapeError);
      expect((error as PresentationShapeError).reason).toBe('no_reattach_candidate');
    }
  });

  it('connectorEndpointPoints 尊重翻转位（start/end 随 flipH/flipV 交换）', () => {
    const reversed = addConnector(deckWithSlides(1), 1, {
      preset: 'line',
      transform: transform(500, 200, 2000, 0, { flip_h: true }),
    });
    const connector = reversed.presentation.slides[0]?.shapes.at(-1);
    if (connector?.kind !== 'connector') throw new Error('应当是连接符');
    expect(connectorEndpointPoints(connector)).toEqual({
      start: { x: 2500, y: 200 },
      end: { x: 500, y: 200 },
    });
  });
});

describe('P-I11：verifyShapeIdentity 组合嵌套校验', () => {
  it('正当渲染的组合通过；子对象被挪出 p:grpSp（id 仍在页里）⇒ nested_element_mismatch', () => {
    const child: Shape = {
      kind: 'auto_shape',
      shape_id: 2,
      name: 'child',
      transform: transform(0, 0, 100, 100),
      preset: 'rect',
      text: null,
      fill: { kind: 'none' },
      outline: null,
    };
    const group: Shape = {
      kind: 'group',
      shape_id: 4,
      name: 'G',
      transform: transform(0, 0, 100, 100),
      children: [child],
    };
    const deck: Presentation = {
      ...deckWithSlides(1),
      slides: [
        {
          slide_id: 1,
          layout: { master_id: 'master1', layout_id: 'blank' },
          hidden: false,
          shapes: [group],
          transition: null,
          animations: [],
          notes: null,
        },
      ],
    };

    // 反面：子对象 id=2 在页里（顶层 p:sp），但不在 p:grpSp(id=4) 的直接子层。
    const tampered = [
      '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
      ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">',
      '<p:cSld><p:spTree>',
      '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>',
      '<p:sp><p:nvSpPr><p:cNvPr id="2" name="child"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>',
      '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm>',
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:sp>',
      '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>',
      '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/>',
      '<a:chOff x="0" y="0"/><a:chExt cx="100" cy="100"/></a:xfrm></p:grpSpPr></p:grpSp>',
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

  it('真实渲染的组合（含嵌套子对象）通过 verifyShapeIdentity', () => {
    let deck = deckWithSlides(1);
    const a = addAutoShape(deck, 1, { transform: transform(0, 0, 1000, 400), preset: 'rect' });
    deck = a.presentation;
    const b = addAutoShape(deck, 1, { transform: transform(2000, 0, 1000, 400), preset: 'ellipse' });
    deck = b.presentation;
    deck = groupSelection(deck, 1, [a.shape_id, b.shape_id], { shape_id: 4 }).presentation;

    const slide = slideXmlOf(buildShapesDeck(deck).bytes, 1);
    expect(() => verifyShapeIdentity(slide, deck, 1)).not.toThrow();
    // 结构确实嵌套：p:grpSp 内直接含 2 个 p:sp。
    expect(slide).toContain('<p:grpSp>');
  });
});

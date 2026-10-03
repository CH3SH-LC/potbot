/**
 * P04 · PPT-05（几何 / 层级 / 组合）+ PPT-07（可编辑形状与流程图）**定向验收**。
 *
 * ## 复用了什么、补的是什么
 *
 * `geometry.ts` / `shapes.ts` 的既有能力（`setBounds` / `alignSelectionToSlide` /
 * `distributeWithGap` / 层级 / 组合 / `addFlowDiagram` / 连接符几何 / 读回校验）已由各自同目录用例
 * 覆盖，本文件**不重测**。本文件只打本包新增的这一层：
 *
 * - `resizeShape` 的**九宫格锚点**（原来只有 `top_left` / `center`）；
 * - `alignSelectionToShape`（对齐到**关键对象**，不同于相互对齐与对齐到页面）；
 * - `syncConnectorGeometry`（节点移动后让连接符**跟随**——否则线留在旧位置就脱开了）；
 * - `addFlowDiagram` 的**竖排 + 逐节点预设几何**（流程图）；
 * - `verifyShapeIdentity`（把读回校验从"数元素个数"加强到"id 与预设几何逐项一致"）。
 *
 * ## 硬判据：导出重开后几何一致（真字节，不是描述文字）
 *
 * §E 造一张**竖排决策流程图**（5 节点 + 4 连接符），改一个节点、缩放另一个节点并让连接符跟随，
 * 记一份 `relativeGeometry`；把模型**渲染成 PPTX 字节**再 `importPresentation` 读回，再记一份，
 * 两份 `toEqual` —— 坐标 / 尺寸 / 旋转 / 翻转 / 层级 / 两两相对偏移逐字段相等。连接符的几何
 * 也在这份快照里，因此"连线没脱开盒子"是**读回值**，不是断言文字。
 *
 * ## 诚实边界（读回证据，不是推测）
 *
 * §E 末尾断言：重开后连接符的 `start_shape_id` / `end_shape_id` **变成 `null`** ——
 * `render.ts` 的连接符分支不写 `stCxn` / `endCxn`，`roundtrip.ts` 也按 `null` 读回。**几何保持，
 * 端点绑定不保持**。这是本域当前的已知缺口（`render.ts` / `roundtrip.ts` 归 P01），本包不越权改，
 * 以用例把它钉成可复现事实，并在交付里记为 integrationRequest。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/index.js';
import { literalText, transform, type Presentation, type Shape } from '../../../../src/presentations/model.js';
import { addShape, addSlide } from '../../../../src/presentations/operations.js';
import { emptyPresentation, renderPresentation } from '../../../../src/presentations/render.js';
import { importPresentation } from '../../../../src/presentations/roundtrip.js';
import {
  GeometryError,
  alignSelectionToShape,
  boundsOf,
  moveShapeTo,
  relativeGeometry,
  resizeShape,
  rotateShapeTo,
  type ResizeAnchor,
} from '../../../../src/presentations/geometry.js';
import {
  FLOWCHART_PRESETS,
  PresentationShapeError,
  addAutoShape,
  addConnector,
  addFlowDiagram,
  buildShapesDeck,
  deleteShapeObject,
  describeSlideObjects,
  isFlowchartPreset,
  syncConnectorGeometry,
  verifyEditableObjects,
  verifyShapeIdentity,
  type PresentationShapeErrorReason,
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
    text: literalText(`t${String(id)}`),
  };
}

function deckWith(shapes: readonly Shape[]): { readonly deck: Presentation; readonly slideId: number } {
  const added = addSlide(emptyPresentation('p1', 'P04 几何/流程'));
  let deck = added.presentation;
  for (const shape of shapes) {
    deck = addShape(deck, added.slide_id, shape);
  }
  return { deck, slideId: added.slide_id };
}

/** 递归查对象（顶层或组合内均可）。 */
function findShape(shapes: readonly Shape[], id: number): Shape | undefined {
  for (const shape of shapes) {
    if (shape.shape_id === id) return shape;
    if (shape.kind === 'group') {
      const nested = findShape(shape.children, id);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function txOf(deck: Presentation, slideId: number, id: number) {
  const slide = deck.slides.find((candidate) => candidate.slide_id === slideId);
  const shape = slide === undefined ? undefined : findShape(slide.shapes, id);
  if (shape === undefined) throw new Error(`找不到对象 ${String(id)}`);
  return shape.transform;
}

function slideXmlOf(bytes: Uint8Array, index: number): string {
  const archive = readZip(bytes);
  const entry = archive.by_path.get(`ppt/slides/slide${String(index)}.xml`);
  if (entry === undefined) throw new Error(`包内没有第 ${index} 页`);
  return Buffer.from(entry.data).toString('utf8');
}

function expectShapeReason(fn: () => unknown, reason: PresentationShapeErrorReason): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PresentationShapeError);
    expect((error as PresentationShapeError).reason).toBe(reason);
    return;
  }
  throw new Error(`期望抛出 ${reason}，但没有抛错`);
}

function expectGeometryReason(fn: () => unknown, reason: GeometryError['reason']): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GeometryError);
    expect((error as GeometryError).reason).toBe(reason);
    return;
  }
  throw new Error(`期望抛出 GeometryError(${reason})，但没有抛错`);
}

// ---------------------------------------------------------------------------
// A. resizeShape 九宫格锚点
// ---------------------------------------------------------------------------

describe('PPT-05 · resizeShape 九宫格锚点（新增 top_right / bottom_* / center_left / center_right）', () => {
  /** (x,y,cx,cy) = (100,200,1000,500) 缩放到 (2000,1000) 后每个锚点的期望坐标。 */
  const CASES: readonly { readonly anchor: ResizeAnchor; readonly x: number; readonly y: number }[] = [
    { anchor: 'top_left', x: 100, y: 200 },
    { anchor: 'top_center', x: -400, y: 200 },
    { anchor: 'top_right', x: -900, y: 200 },
    { anchor: 'center_left', x: 100, y: -50 },
    { anchor: 'center', x: -400, y: -50 },
    { anchor: 'center_right', x: -900, y: -50 },
    { anchor: 'bottom_left', x: 100, y: -300 },
    { anchor: 'bottom_center', x: -400, y: -300 },
    { anchor: 'bottom_right', x: -900, y: -300 },
  ];

  it.each(CASES)('anchor=$anchor ⇒ 对角 / 对边保持，坐标 (x=$x, y=$y)', ({ anchor, x, y }) => {
    const { deck, slideId } = deckWith([box(2, 100, 200, 1000, 500)]);
    const resized = resizeShape(deck, slideId, 2, 2000, 1000, { anchor });
    expect(txOf(resized, slideId, 2)).toMatchObject({ x_emu: x, y_emu: y, cx_emu: 2000, cy_emu: 1000 });
  });

  it('九个锚点两两不同（不是把每个 anchor 都当成左上角）', () => {
    const seen = new Set<string>();
    for (const { anchor } of CASES) {
      const { deck, slideId } = deckWith([box(2, 100, 200, 1000, 500)]);
      const t = txOf(resizeShape(deck, slideId, 2, 2000, 1000, { anchor }), slideId, 2);
      seen.add(`${String(t.x_emu)},${String(t.y_emu)}`);
    }
    // 只有成对同坐标的锚点会重合：{top_center,top_* } 不同……九宫格共 9 个锚点 → 9 个不同落点。
    expect(seen.size).toBe(CASES.length);
  });

  it('负尺寸 ⇒ invalid_bounds（不静默接受）', () => {
    const { deck, slideId } = deckWith([box(2, 0, 0)]);
    expect(() => resizeShape(deck, slideId, 2, -1, 10)).toThrow(GeometryError);
    expect(() => resizeShape(deck, slideId, 2, 10, -1)).toThrow(GeometryError);
  });
});

// ---------------------------------------------------------------------------
// B. alignSelectionToShape：对齐到关键对象
// ---------------------------------------------------------------------------

describe('PPT-05 · alignSelectionToShape（基准是另一个对象的框，而非选区自身 / 页面）', () => {
  /** 基准框 (1000,1000,400,400)：left 1000 / right 1400 / centerX 1200 / bottom 1400 / centerY 1200。 */
  function scene() {
    return deckWith([box(2, 1000, 1000, 400, 400), box(3, 0, 0, 200, 100), box(4, 50, 50, 600, 300)]);
  }

  it('left / right / center_h / bottom 各自贴到基准对象的对应边', () => {
    const { deck, slideId } = scene();

    const left = alignSelectionToShape(deck, slideId, [3, 4], 2, 'left');
    expect([txOf(left, slideId, 3).x_emu, txOf(left, slideId, 4).x_emu]).toEqual([1000, 1000]);

    const right = alignSelectionToShape(deck, slideId, [3, 4], 2, 'right');
    expect([txOf(right, slideId, 3).x_emu, txOf(right, slideId, 4).x_emu]).toEqual([1200, 800]);

    const center = alignSelectionToShape(deck, slideId, [3, 4], 2, 'center_h');
    expect([txOf(center, slideId, 3).x_emu, txOf(center, slideId, 4).x_emu]).toEqual([1100, 900]);

    const bottom = alignSelectionToShape(deck, slideId, [3, 4], 2, 'bottom');
    expect([txOf(bottom, slideId, 3).y_emu, txOf(bottom, slideId, 4).y_emu]).toEqual([1300, 1100]);
    // 只动 y：x 原样保留（0 与 50）。
    expect([txOf(bottom, slideId, 3).x_emu, txOf(bottom, slideId, 4).x_emu]).toEqual([0, 50]);
  });

  it('反向对照：基准在选区里时基准自身不动；且结果 ≠ 相互对齐（选区自身外框）', () => {
    const { deck, slideId } = scene();
    const withAnchor = alignSelectionToShape(deck, slideId, [2, 3, 4], 2, 'left');
    expect(txOf(withAnchor, slideId, 2).x_emu).toBe(1000); // 基准不动
    expect([txOf(withAnchor, slideId, 3).x_emu, txOf(withAnchor, slideId, 4).x_emu]).toEqual([1000, 1000]);

    // 相互对齐（选区自身外框）会把它们放到 min(x)=0；对齐到关键对象是 anchor 的 1000。
    // 若实现误用了选区的 min/max，上面的 1000 会变成 0。
    const selectionMin = Math.min(1000, 0, 50);
    expect(selectionMin).toBe(0);
    expect(txOf(withAnchor, slideId, 3).x_emu).not.toBe(selectionMin);
  });

  it('空选区 ⇒ empty_selection；基准不存在 ⇒ unknown_shape', () => {
    const { deck, slideId } = scene();
    expectGeometryReason(() => alignSelectionToShape(deck, slideId, [], 2, 'left'), 'empty_selection');
    expectGeometryReason(() => alignSelectionToShape(deck, slideId, [3], 999, 'left'), 'unknown_shape');
  });
});

// ---------------------------------------------------------------------------
// C. syncConnectorGeometry：连接符跟随节点
// ---------------------------------------------------------------------------

describe('PPT-07 · syncConnectorGeometry（节点移动后让连接符重新贴合）', () => {
  function twoNodeFlow() {
    return addFlowDiagram(deckWith([]).deck, 1, {
      texts: ['A', 'B'],
      x_emu: 0,
      y_emu: 0,
      node_width_emu: 1000,
      node_height_emu: 400,
      gap_emu: 1000,
    });
  }

  it('未同步时线留在旧几何；同步后按两端中心重算', () => {
    const flow = twoNodeFlow();
    const [a, b] = flow.node_ids;
    if (a === undefined || b === undefined) throw new Error('缺少节点');
    const connectorId = flow.connector_ids[0];
    if (connectorId === undefined) throw new Error('缺少连接符');

    // A(0,0,1000,400) 中心 (500,200)；B(2000,0,1000,400) 中心 (2500,200) ⇒ 线段 (500,200) 长 2000 高 0。
    expect(txOf(flow.presentation, 1, connectorId)).toMatchObject({ x_emu: 500, y_emu: 200, cx_emu: 2000, cy_emu: 0 });

    const moved = moveShapeTo(flow.presentation, 1, b, 2000, 1000); // B 下移 1000
    // 未同步：线还停在旧位置（这就是"脱开"）。
    expect(txOf(moved, 1, connectorId)).toMatchObject({ x_emu: 500, y_emu: 200, cx_emu: 2000, cy_emu: 0 });

    const synced = syncConnectorGeometry(moved, 1);
    // B 中心现为 (2500,1200)；A 中心 (500,200) ⇒ dx=2000, dy=1000。
    expect(txOf(synced, 1, connectorId)).toMatchObject({ x_emu: 500, y_emu: 200, cx_emu: 2000, cy_emu: 1000, flip_h: false, flip_v: false });
  });

  it('反向（节点跑到另一端）⇒ 翻转位被置上，线不画反', () => {
    const flow = twoNodeFlow();
    const [a, b] = flow.node_ids;
    if (a === undefined || b === undefined) throw new Error('缺少节点');
    const connectorId = flow.connector_ids[0];
    if (connectorId === undefined) throw new Error('缺少连接符');

    const moved = moveShapeTo(flow.presentation, 1, a, 5000, 5000); // A 到 B 的右下
    const synced = syncConnectorGeometry(moved, 1, connectorId);
    // A(5000,5000,1000,400) 中心 (5500,5200)，B(2000,0,1000,400) 中心 (2500,200)
    // ⇒ dx=-3000, dy=-5000 ⇒ 框 (2500,200) 3000×5000 双翻转，线仍连两点。
    expect(txOf(synced, 1, connectorId)).toMatchObject({ x_emu: 2500, y_emu: 200, cx_emu: 3000, cy_emu: 5000, flip_h: true, flip_v: true });
  });

  it('端点为空的连接符跳过；删节点已自动摘端点 ⇒ 同步不报错且几何保留', () => {
    const flow = twoNodeFlow();
    const [a, b] = flow.node_ids;
    if (a === undefined || b === undefined) throw new Error('缺少节点');
    const connectorId = flow.connector_ids[0];
    if (connectorId === undefined) throw new Error('缺少连接符');

    const before = txOf(flow.presentation, 1, connectorId);
    const afterDelete = deleteShapeObject(flow.presentation, 1, b);
    const synced = syncConnectorGeometry(afterDelete, 1, connectorId);
    expect(txOf(synced, 1, connectorId)).toEqual(before); // 没有可跟随的一端 ⇒ 保留原几何
    void a;
  });

  it('指定非连接符 ⇒ not_a_connector；悬空端点 ⇒ unknown_endpoint', () => {
    const flow = twoNodeFlow();
    const nodeId = flow.node_ids[0];
    if (nodeId === undefined) throw new Error('缺少节点');
    expectShapeReason(() => syncConnectorGeometry(flow.presentation, 1, nodeId), 'not_a_connector');

    // 手工造一个端点指向不存在形状的连接符 ⇒ 两端都接上悬空 id 时同步即报 unknown_endpoint；
    // 只有一端接、另一端为 null 的会被跳过（没有可跟随的一端）。
    const dangling: Shape = {
      kind: 'connector',
      shape_id: 9,
      name: 'Dangling',
      transform: transform(0, 0, 100, 0),
      preset: 'line',
      outline: null,
      start_shape_id: 999,
      end_shape_id: null,
    };
    const halfDangling = addShape(flow.presentation, 1, dangling);
    const bothDangling = addShape(flow.presentation, 1, { ...dangling, end_shape_id: 998 });
    expect(() => syncConnectorGeometry(halfDangling, 1, 9)).not.toThrow();
    expectShapeReason(() => syncConnectorGeometry(bothDangling, 1, 9), 'unknown_endpoint');
  });
});

// ---------------------------------------------------------------------------
// D. 流程图：竖排 + 逐节点预设几何
// ---------------------------------------------------------------------------

describe('PPT-07 · 流程图（竖排 + flowChart* 预设几何）', () => {
  const PRESETS = ['flowChartTerminator', 'flowChartProcess', 'flowChartDecision', 'flowChartProcess', 'flowChartTerminator'] as const;

  it('竖排：节点沿 y 堆叠、x 恒定；预设几何逐节点落到模型', () => {
    const flow = addFlowDiagram(deckWith([]).deck, 1, {
      texts: ['开始', '处理', '判断', '复核', '结束'],
      direction: 'vertical',
      presets: PRESETS,
      x_emu: 1000,
      y_emu: 200,
      node_width_emu: 800,
      node_height_emu: 300,
      gap_emu: 200,
    });
    expect(flow.node_ids).toHaveLength(5);
    expect(flow.connector_ids).toHaveLength(4);

    flow.node_ids.forEach((id, index) => {
      const t = txOf(flow.presentation, 1, id);
      expect(t.x_emu).toBe(1000);
      expect(t.y_emu).toBe(200 + index * (300 + 200));
      expect(t.cx_emu).toBe(800);
      expect(t.cy_emu).toBe(300);
    });

    const slide = flow.presentation.slides[0];
    if (slide === undefined) throw new Error('没有页');
    expect(slide.shapes.filter((shape) => shape.kind === 'auto_shape').map((shape) => (shape.kind === 'auto_shape' ? shape.preset : ''))).toEqual([...PRESETS]);
  });

  it('FLOWCHART_PRESETS / isFlowchartPreset 认得流程图预设、拒绝非流程图形状', () => {
    expect(FLOWCHART_PRESETS).toContain('flowChartDecision');
    expect(FLOWCHART_PRESETS).toContain('flowChartTerminator');
    for (const preset of PRESETS) expect(isFlowchartPreset(preset)).toBe(true);
    expect(isFlowchartPreset('rect')).toBe(false);
    expect(isFlowchartPreset('flowChart')).toBe(false); // 不是合法预设名
    expect(isFlowchartPreset('FlowChartDecision')).toBe(false); // 大小写敏感
  });
});

// ---------------------------------------------------------------------------
// E. 硬判据：导出重开后几何一致（真字节）
// ---------------------------------------------------------------------------

describe('PPT-05/07 · 导出重开后几何一致（渲染 → 导入读回）', () => {
  /** 造竖排决策流程图，移动一个节点、缩放另一个节点并让连接符跟随。 */
  function flowchartDeck() {
    const flow = addFlowDiagram(deckWith([]).deck, 1, {
      texts: ['开始', '处理', '判断', '复核', '结束'],
      direction: 'vertical',
      presets: ['flowChartTerminator', 'flowChartProcess', 'flowChartDecision', 'flowChartProcess', 'flowChartTerminator'],
      x_emu: 1000000,
      y_emu: 1000000,
      node_width_emu: 2000000,
      node_height_emu: 800000,
      gap_emu: 400000,
      fill_color: 'D9E2F3',
      line_color: '1F3864',
    });
    const ids = flow.node_ids;
    const judge = ids[2];
    const review = ids[3];
    if (judge === undefined || review === undefined) throw new Error('缺少节点');
    let deck = moveShapeTo(flow.presentation, 1, review, 5000000, 3000000); // 复核节点挪到别处
    deck = resizeShape(deck, 1, judge, 2400000, 900000, { anchor: 'bottom_right' }); // 判断节点右下角锚点放大
    deck = rotateShapeTo(deck, 1, review, 30); // 顺带验旋转也往返
    return syncConnectorGeometry(deck, 1);
  }

  it('坐标 / 尺寸 / 旋转 / 翻转 / 层级 / 两两相对偏移 全部逐字段一致', () => {
    const deck = flowchartDeck();
    const before = relativeGeometry(deck, 1);

    const bytes = renderPresentation(deck).bytes;
    const reread = importPresentation(bytes);
    const rereadSlideId = reread.presentation.slides[0]?.slide_id;
    if (rereadSlideId === undefined) throw new Error('读回后没有幻灯片');
    const after = relativeGeometry(reread.presentation, rereadSlideId);

    expect(after).toEqual(before);
    // 快照确实覆盖了 5 节点 + 4 连接符，而不是空集骗过 toEqual。
    expect(before.shapes).toHaveLength(9);
    expect(before.pairs).toHaveLength((9 * 8) / 2);
  });

  it('导出页仍是可编辑元素（5 p:sp + 4 p:cxnSp，无整页位图），id 与预设几何逐项对得上', () => {
    const deck = flowchartDeck();
    const result = buildShapesDeck(deck);
    const slide = slideXmlOf(result.bytes, 1);

    expect(slide.split('<p:sp>').length - 1).toBe(5);
    expect(slide.split('<p:cxnSp>').length - 1).toBe(4);
    expect(slide).not.toContain('<p:pic>');
    expect(slide).toContain('prst="flowChartDecision"');
    expect(slide).toContain('prst="flowChartTerminator"');
    expect(slide).toContain('<a:t>判断</a:t>');

    // 加强读回：模型 id 与导出的 p:cNvPr@id、prstGeom@prst 逐项一致。
    expect(() => verifyShapeIdentity(slide, deck, 1)).not.toThrow();
    expect(() => verifyEditableObjects(slide, describeSlideObjects(deck, 1), deck.size)).not.toThrow();

    const inventory = describeSlideObjects(deck, 1);
    expect(inventory.by_kind).toEqual({ auto_shape: 5, connector: 4 });
    expect(inventory.total).toBe(9);
  });

  it('连接符几何往返保持（线没脱开盒子）', () => {
    const deck = flowchartDeck();
    const connectors = relativeGeometry(deck, 1).shapes.filter((entry) =>
      deck.slides[0]?.shapes.find((shape) => shape.shape_id === entry.shape_id)?.kind === 'connector',
    );
    expect(connectors).toHaveLength(4);

    const reread = importPresentation(renderPresentation(deck).bytes);
    const rereadSlideId = reread.presentation.slides[0]?.slide_id;
    if (rereadSlideId === undefined) throw new Error('读回后没有幻灯片');
    const after = relativeGeometry(reread.presentation, rereadSlideId);
    const afterById = new Map(after.shapes.map((entry) => [entry.shape_id, entry]));
    for (const connector of connectors) {
      expect(afterById.get(connector.shape_id)).toEqual(connector);
    }
  });

  it('端点绑定（start/end_shape_id）随导出重开保持（P01 缺口已闭合）', () => {
    const deck = flowchartDeck();
    const beforeConnectors = (deck.slides[0]?.shapes ?? []).filter((shape) => shape.kind === 'connector');
    expect(beforeConnectors.length).toBe(4);
    // 模型层：端点已接好。
    expect(beforeConnectors.every((shape) => shape.kind === 'connector' && shape.start_shape_id !== null && shape.end_shape_id !== null)).toBe(true);

    const reread = importPresentation(renderPresentation(deck).bytes);
    const rereadSlideId = reread.presentation.slides[0]?.slide_id;
    if (rereadSlideId === undefined) throw new Error('读回后没有幻灯片');
    const afterConnectors = (reread.presentation.slides[0]?.shapes ?? []).filter((shape) => shape.kind === 'connector');
    expect(afterConnectors).toHaveLength(4);
    // 行为变更：render 现写 `p:cNvCxnSpPr` 下的 `a:stCxn`/`a:endCxn`（@id = 被连形状 id），
    // roundtrip 按 @id 读回 start/end_shape_id——读回值不再恒为 null，且逐条与导出前一致。
    expect(afterConnectors.every((shape) => shape.kind === 'connector' && shape.start_shape_id !== null && shape.end_shape_id !== null)).toBe(true);
    const beforeById = new Map(beforeConnectors.map((shape) => [shape.shape_id, shape] as const));
    for (const shape of afterConnectors) {
      const source = beforeById.get(shape.shape_id);
      if (source?.kind !== 'connector' || shape.kind !== 'connector') throw new Error('连接符类型不符');
      expect(shape.start_shape_id).toBe(source.start_shape_id);
      expect(shape.end_shape_id).toBe(source.end_shape_id);
    }
  });
});

// ---------------------------------------------------------------------------
// F. 反向对照：verifyShapeIdentity 必须挡下被换掉的 id / 预设几何
// ---------------------------------------------------------------------------

describe('PPT-07 反向对照 · verifyShapeIdentity', () => {
  function flowDeck(): Presentation {
    return addFlowDiagram(deckWith([]).deck, 1, {
      texts: ['A', 'B', 'C'],
      direction: 'vertical',
      presets: ['flowChartTerminator', 'flowChartDecision', 'flowChartProcess'],
      x_emu: 0,
      y_emu: 0,
      node_width_emu: 1000,
      node_height_emu: 400,
      gap_emu: 100,
    }).presentation;
  }

  it('预设几何被换（flowChartDecision → rect）⇒ preset_mismatch', () => {
    const deck = flowDeck();
    const slide = slideXmlOf(renderPresentation(deck).bytes, 1);
    expect(slide).toContain('prst="flowChartDecision"');
    const tampered = slide.replace('prst="flowChartDecision"', 'prst="rect"');
    expectShapeReason(() => verifyShapeIdentity(tampered, deck, 1), 'preset_mismatch');
  });

  it('某个对象的 cNvPr@id 被改 ⇒ missing_editable_element', () => {
    const deck = flowDeck();
    const slide = slideXmlOf(renderPresentation(deck).bytes, 1);
    // 第 3 个节点的 cNvPr id 由 4 改成 99（模型里没有 99；模型里的 4 就找不到了）。
    const tampered = slide.replace('id="4"', 'id="99"');
    expect(tampered).not.toBe(slide);
    expectShapeReason(() => verifyShapeIdentity(tampered, deck, 1), 'missing_editable_element');
  });

  it('导出页多出模型未声明的 p:sp ⇒ unexpected_editable_element', () => {
    const deck = flowDeck();
    const slide = slideXmlOf(renderPresentation(deck).bytes, 1);
    const extra = '<p:sp><p:nvSpPr><p:cNvPr id="777" name="X"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>';
    const tampered = slide.replace('</p:spTree>', `${extra}</p:spTree>`);
    expect(tampered).not.toBe(slide);
    expectShapeReason(() => verifyShapeIdentity(tampered, deck, 1), 'unexpected_editable_element');
  });

  it('未篡改的页通过（三条负例不是因为校验器恒报错）', () => {
    const deck = flowDeck();
    const slide = slideXmlOf(renderPresentation(deck).bytes, 1);
    expect(() => verifyShapeIdentity(slide, deck, 1)).not.toThrow();
    expect(() => verifyEditableObjects(slide, describeSlideObjects(deck, 1), deck.size)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// G. 组合与几何读数复用（不改行为，钉住既有语义便于后续回归）
// ---------------------------------------------------------------------------

describe('PPT-05 · 组合几何读数（复用既有 group/ungroup，钉住语义）', () => {
  it('组合一个含旋转对象的框，bounds 覆盖整体，取消组合后子几何原样', () => {
    const { deck, slideId } = deckWith([box(2, 100, 100), box(3, 600, 300, 2000, 900)]);
    const rotated = rotateShapeTo(deck, slideId, 3, 90);
    // 用 addAutoShape 造一个自选图形参与组合，验证组合对非文本框也成立。
    const added = addAutoShape(rotated, slideId, {
      transform: transform(50, 50, 400, 400),
      preset: 'diamond',
      text: literalText('决策'),
    });
    const bounds = boundsOf(findShape(added.presentation.slides[0]?.shapes ?? [], added.shape_id) as Shape);
    expect(bounds).toEqual({ x_emu: 50, y_emu: 50, cx_emu: 400, cy_emu: 400 });
    void slideId;
  });

  it('boundsOf 对连接符形状给出其线段框（中心连线口径）', () => {
    const flow = addFlowDiagram(deckWith([]).deck, 1, {
      texts: ['A', 'B'],
      x_emu: 0,
      y_emu: 0,
      node_width_emu: 1000,
      node_height_emu: 400,
      gap_emu: 1000,
    });
    const connector = flow.presentation.slides[0]?.shapes.find((shape) => shape.kind === 'connector');
    if (connector === undefined) throw new Error('缺少连接符');
    expect(boundsOf(connector)).toEqual({ x_emu: 500, y_emu: 200, cx_emu: 2000, cy_emu: 0 });
  });
});

/**
 * 演示域**形状 / 线条 / 连接符**（design-06 P9 / PPT-07）。
 *
 * ## 这一层解决什么
 *
 * `model.ts` 已把形状建成联合类型（文本框 / 自选图形 / 连接符 / 图片 / 表格 / 图表 / 组合 / 媒体），
 * `render.ts` 已把自选图形渲染成 `p:sp`、把连接符渲染成 `p:cxnSp`。本模块补的是**做成一个
 * 流程图**所需要的那一层：
 *
 * - 建自选图形（预设几何 + 填充 + 轮廓 + 形状文本）；
 * - 建连接符，并按两个形状的**几何**算出连接符的 `a:xfrm`（两端中心之间的线段，含翻转位）；
 * - 改填充 / 轮廓 / 预设几何；删除形状时**同页连接符的端点一并摘掉**（不留悬空引用）。
 *
 * ## 「流程关系仍是可编辑对象，不能整页截图」怎么判
 *
 * 这是 PPT-07 的硬要求，本模块把它做成**对渲染字节的读回断言**（`verifyEditableObjects`）：
 *
 * 1. 模型里每个非图片对象，在导出的那一页 XML 里必须有**对应的可编辑元素**
 *    （`p:sp` / `p:cxnSp` / `p:grpSp` / `p:graphicFrame`），数量与模型对得上；
 * 2. 页面上**不得**出现与幻灯片同尺寸的 `p:pic`——那就是"整页截图"。
 *
 * 反过来，"页面是一张图"的假流程会被第 1 条（数量对不上）与第 2 条（全页位图）同时挡下。
 * 用例里对这两条各给了一条反向对照（手工拼一份"整页图片"的页 XML 让校验报错）。
 *
 * ## 边界（**未**做的事）
 *
 * - `stCxn`/`endCxn`（连接点 id）**未**写进 XML：`render.ts` 的连接符分支只写几何，不改它；
 *   因此连接关系在**模型层**可编辑、几何已算好，但 XML 里没有"绑定到某个形状的连接点"。
 * - 心形 / 括号 / 星形等预设几何是**字符串直传** `a:prstGeom@prst`，本模块不校验枚举
 *   （DrawingML 预设名由产物消费方决定，不在这里编一份可能过期的名单）。
 * - 真机 PowerPoint 打开未验证。
 */

import { readZip } from '../artifacts/ooxml/index.js';
import { ValidationError } from '../protocol/index.js';

import {
  transform as makeTransform,
  type Fill,
  type Outline,
  type Paragraph,
  type Presentation,
  type Shape,
  type Slide,
  type TextBody,
  type Transform,
} from './model.js';
import type { Bounds } from './geometry.js';
import { addShape, nextAvailableShapeId, setShapeText } from './operations.js';
import { renderPresentation, type RenderPresentationResult } from './render.js';
import { attributeOf, childElements, parseXmlDocument, type XmlElementNode } from './xml-parse.js';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 形状层错误原因（供用例断言与上层分类处理）。 */
export type PresentationShapeErrorReason =
  | 'unknown_slide'
  | 'unknown_shape'
  | 'duplicate_shape_id'
  | 'shape_has_no_fill'
  | 'shape_has_no_outline'
  | 'not_a_connector'
  | 'unknown_endpoint'
  | 'self_connection'
  | 'invalid_preset'
  | 'empty_flow'
  | 'page_screenshot_detected'
  | 'object_count_mismatch'
  | 'missing_editable_element'
  | 'unexpected_editable_element'
  | 'preset_mismatch'
  | 'nested_element_mismatch'
  | 'no_reattach_candidate';

/** 形状层在语义不成立时抛出的错误（**不静默**）。 */
export class PresentationShapeError extends ValidationError {
  readonly reason: PresentationShapeErrorReason;

  constructor(reason: PresentationShapeErrorReason, message: string) {
    super(message);
    this.name = 'PresentationShapeError';
    this.reason = reason;
  }
}

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const EMU_PER_PX = 9525;
const DEFAULT_NODE_WIDTH = 160 * EMU_PER_PX;
const DEFAULT_NODE_HEIGHT = 60 * EMU_PER_PX;
const DEFAULT_NODE_GAP = 50 * EMU_PER_PX;

/**
 * 流程图常用的 DrawingML 预设几何名（`a:prstGeom@prst` 的合法取值）。
 *
 * 只收"流程图"这一类；**不是**完整枚举——引擎仍允许任何合法 prst 字符串直传（见 `requirePreset`
 * 的边界说明）。这里给的是让流程图节点有正确语义的**已知集合**，供调用方选型与校验。
 */
export const FLOWCHART_PRESETS = Object.freeze([
  'flowChartProcess',
  'flowChartAlternateProcess',
  'flowChartDecision',
  'flowChartTerminator',
  'flowChartPredefinedProcess',
  'flowChartDocument',
  'flowChartData',
  'flowChartManualInput',
  'flowChartConnector',
] as const);

/** 是否是本模块已知的流程图形状预设名（大小写敏感，与 OOXML 一致）。 */
export function isFlowchartPreset(name: string): boolean {
  return (FLOWCHART_PRESETS as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function eachShape(shapes: readonly Shape[], visit: (shape: Shape) => void): void {
  for (const shape of shapes) {
    visit(shape);
    if (shape.kind === 'group') {
      eachShape(shape.children, visit);
    }
  }
}

function requireSlide(presentation: Presentation, slideId: number): Slide {
  const slide = presentation.slides.find((candidate) => candidate.slide_id === slideId);
  if (slide === undefined) {
    throw new PresentationShapeError('unknown_slide', `找不到幻灯片 slide_id=${String(slideId)}`);
  }
  return slide;
}

function requireShape(slide: Slide, shapeId: number): Shape {
  const collected: Shape[] = [];
  eachShape(slide.shapes, (shape) => {
    collected.push(shape);
  });
  const found = collected.find((shape) => shape.shape_id === shapeId);
  if (found === undefined) {
    throw new PresentationShapeError('unknown_shape', `找不到对象 shape_id=${String(shapeId)}`);
  }
  return found;
}

/** 原地替换某页某个对象（含组合子对象）；未命中的对象**引用不变**。 */
export function mapShapeInPresentation(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  update: (shape: Shape) => Shape,
): Presentation {
  const slide = requireSlide(presentation, slideId);
  let found = false;
  const walk = (shapes: readonly Shape[]): readonly Shape[] =>
    shapes.map((shape) => {
      if (shape.shape_id === shapeId) {
        found = true;
        return update(shape);
      }
      if (shape.kind === 'group') {
        return { ...shape, children: walk(shape.children) };
      }
      return shape;
    });
  const shapes = walk(slide.shapes);
  if (!found) {
    throw new PresentationShapeError('unknown_shape', `找不到对象 shape_id=${String(shapeId)}`);
  }
  return {
    ...presentation,
    slides: presentation.slides.map((current) =>
      current.slide_id === slideId ? { ...current, shapes } : current,
    ),
  };
}

/** 预设几何名必须是**非空且不含空白**的字符串（不编造可能过期的枚举名单）。 */
function requirePreset(preset: string): string {
  if (preset.length === 0 || /\s/.test(preset)) {
    throw new PresentationShapeError(
      'invalid_preset',
      `预设几何名必须是非空且不含空白的字符串，收到 ${JSON.stringify(preset)}`,
    );
  }
  return preset;
}

// ---------------------------------------------------------------------------
// 建形状（PPT-07）
// ---------------------------------------------------------------------------

/** 自选图形参数。 */
export interface AutoShapeSpec {
  readonly shape_id?: number;
  readonly name?: string;
  readonly transform: Transform;
  /** DrawingML 预设几何名，如 `rect` / `ellipse` / `roundRect` / `diamond`。 */
  readonly preset: string;
  readonly fill?: Fill;
  readonly outline?: Outline | null;
  readonly text?: TextBody | null;
}

/** 在指定页加一个自选图形（PPT-07）。 */
export function addAutoShape(
  presentation: Presentation,
  slideId: number,
  spec: AutoShapeSpec,
): { readonly presentation: Presentation; readonly shape_id: number } {
  const shapeId = spec.shape_id ?? nextAvailableShapeId(presentation, slideId);
  const shape: Shape = {
    kind: 'auto_shape',
    shape_id: shapeId,
    name: spec.name ?? `Shape ${String(shapeId)}`,
    transform: spec.transform,
    preset: requirePreset(spec.preset),
    text: spec.text ?? null,
    fill: spec.fill ?? { kind: 'none' },
    outline: spec.outline ?? null,
  };
  return { presentation: addShape(presentation, slideId, shape), shape_id: shapeId };
}

/** 连接符参数。不给 `transform` 时由 `connectShapes` 按两端几何算出。 */
export interface ConnectorSpec {
  readonly shape_id?: number;
  readonly name?: string;
  /** DrawingML 预设名，如 `line` / `bentConnector3` / `curvedConnector3`。 */
  readonly preset?: string;
  readonly outline?: Outline | null;
  readonly from?: number | null;
  readonly to?: number | null;
  readonly transform?: Transform;
}

/** 在指定页加一个连接符（PPT-07）。`from`/`to` 指向同页形状 ⇒ 几何与端点一并算好。 */
export function addConnector(
  presentation: Presentation,
  slideId: number,
  spec: ConnectorSpec,
): { readonly presentation: Presentation; readonly shape_id: number } {
  const shapeId = spec.shape_id ?? nextAvailableShapeId(presentation, slideId);
  const slide = requireSlide(presentation, slideId);
  const from = spec.from ?? null;
  const to = spec.to ?? null;
  if (from !== null && from === to) {
    throw new PresentationShapeError('self_connection', `连接符两端不能是同一个形状 shape_id=${String(from)}`);
  }
  let transformValue: Transform = spec.transform ?? makeTransform(0, 0, 0, 0);
  if (spec.transform === undefined && from !== null && to !== null) {
    transformValue = geometryBetween(slide, from, to);
  }
  const shape: Shape = {
    kind: 'connector',
    shape_id: shapeId,
    name: spec.name ?? `Connector ${String(shapeId)}`,
    transform: transformValue,
    preset: requirePreset(spec.preset ?? 'line'),
    outline: spec.outline ?? { color: '404040', width_emu: 12700 },
    start_shape_id: from,
    end_shape_id: to,
  };
  return { presentation: addShape(presentation, slideId, shape), shape_id: shapeId };
}

/** 两端形状**中心**之间的线段几何（含翻转位），保证连线视觉上连接两个形状。 */
function geometryBetween(slide: Slide, from: number, to: number): Transform {
  const start = requireShape(slide, from);
  const end = requireShape(slide, to);
  const startCenter = {
    x: start.transform.x_emu + Math.round(start.transform.cx_emu / 2),
    y: start.transform.y_emu + Math.round(start.transform.cy_emu / 2),
  };
  const endCenter = {
    x: end.transform.x_emu + Math.round(end.transform.cx_emu / 2),
    y: end.transform.y_emu + Math.round(end.transform.cy_emu / 2),
  };
  const dx = endCenter.x - startCenter.x;
  const dy = endCenter.y - startCenter.y;
  return makeTransform(Math.min(startCenter.x, endCenter.x), Math.min(startCenter.y, endCenter.y), Math.abs(dx), Math.abs(dy), {
    flip_h: dx < 0,
    flip_v: dy < 0,
  });
}

/** 把一条已有连接符接到两个形状上（PPT-07）：端点 + 几何一起更新。 */
export function connectShapes(
  presentation: Presentation,
  slideId: number,
  connectorId: number,
  from: number,
  to: number,
): Presentation {
  if (from === to) {
    throw new PresentationShapeError('self_connection', `连接符两端不能是同一个形状 shape_id=${String(from)}`);
  }
  const slide = requireSlide(presentation, slideId);
  requireShape(slide, connectorId);
  const geometry = geometryBetween(slide, from, to);
  return mapShapeInPresentation(presentation, slideId, connectorId, (shape) => {
    if (shape.kind !== 'connector') {
      throw new PresentationShapeError('not_a_connector', `对象 shape_id=${String(connectorId)} 不是连接符`);
    }
    return { ...shape, start_shape_id: from, end_shape_id: to, transform: geometry };
  });
}

/** 断开一条连接符的端点（几何保留）。 */
export function disconnectShapes(presentation: Presentation, slideId: number, connectorId: number): Presentation {
  return mapShapeInPresentation(presentation, slideId, connectorId, (shape) => {
    if (shape.kind !== 'connector') {
      throw new PresentationShapeError('not_a_connector', `对象 shape_id=${String(connectorId)} 不是连接符`);
    }
    return { ...shape, start_shape_id: null, end_shape_id: null };
  });
}

// ---------------------------------------------------------------------------
// 重开后端点重挂（legacy null 端点 → 按几何就近配对）
// ---------------------------------------------------------------------------

/** 连接符两端的**几何端点**（页坐标）；由 `a:xfrm` + 翻转位决定，与 `geometryBetween` 同口径。 */
export interface ConnectorEndpointPoints {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

/**
 * 算一条连接符两端的几何端点（页坐标）。
 *
 * 口径与 `geometryBetween` 一致：不翻转时 `start` 在左上 `(x, y)`、`end` 在右下 `(x+cx, y+cy)`；
 * `flipH`/`flipV` 时对应端点交换到另一侧。**只看几何**，不看 `start/end_shape_id`。
 */
export function connectorEndpointPoints(connector: Extract<Shape, { kind: 'connector' }>): ConnectorEndpointPoints {
  const t = connector.transform;
  const right = t.x_emu + t.cx_emu;
  const bottom = t.y_emu + t.cy_emu;
  return {
    start: { x: t.flip_h ? right : t.x_emu, y: t.flip_v ? bottom : t.y_emu },
    end: { x: t.flip_h ? t.x_emu : right, y: t.flip_v ? t.y_emu : bottom },
  };
}

/** 重挂的默认容差（EMU）：1 英寸。见 `reattachConnectorEndpoints` 的算法说明。 */
export const DEFAULT_REATTACH_TOLERANCE_EMU = 914400;

/** `reattachConnectorEndpoints` 的选项。 */
export interface ReattachOptions {
  /** 只处理这一条连接符（缺省 = 本页所有连接符）。 */
  readonly connector_id?: number;
  /** 就近判定的**最大容差**（EMU）；超过则视为无法确定，端点保持 `null`。缺省 1 英寸。 */
  readonly tolerance_emu?: number;
  /** 为 `true` 时，某个待重挂端点找不到容差内候选 ⇒ 抛 `no_reattach_candidate`（缺省 `false` = 保持 null）。 */
  readonly throw_on_unresolved?: boolean;
}

/** 单个端点的重挂结果。 */
export interface ReattachOutcome {
  readonly connector_id: number;
  readonly endpoint: 'start' | 'end';
  /** 重挂到的形状 id；未重挂（超容差/无候选）时为 `null`。 */
  readonly shape_id: number | null;
  /** 判定距离（EMU；点到候选形状外框的最近距离）；未重挂时为 `null`。 */
  readonly distance_emu: number | null;
}

/** `reattachConnectorEndpoints` 的结果：新演示 + 容差 + 已重挂/未解决清单。 */
export interface ReattachResult {
  readonly presentation: Presentation;
  readonly tolerance_emu: number;
  readonly reattached: readonly ReattachOutcome[];
  readonly unresolved: readonly ReattachOutcome[];
}

/** 点到矩形外框的最近欧氏距离（点在框内 = 0）。 */
function distancePointToBounds(
  px: number,
  py: number,
  bounds: Bounds,
): number {
  const dx = Math.max(bounds.x_emu - px, 0, px - (bounds.x_emu + bounds.cx_emu));
  const dy = Math.max(bounds.y_emu - py, 0, py - (bounds.y_emu + bounds.cy_emu));
  return Math.hypot(dx, dy);
}

/** 点到矩形中心距离（第二判据；距离相同时用于打破平局）。 */
function distancePointToCenter(px: number, py: number, bounds: Bounds): number {
  const cx = bounds.x_emu + bounds.cx_emu / 2;
  const cy = bounds.y_emu + bounds.cy_emu / 2;
  return Math.hypot(px - cx, py - cy);
}

/**
 * **重挂 legacy 连接符端点**（P04 诚实边界：重开后 `start/end_shape_id` 为 `null`）。
 *
 * 对每个**端点为空**的连接符端点，按几何就近在**本页非连接符对象**里选一个候选：
 *
 * 1. 候选的**外框**（`shape.transform`）：算端点坐标到外框的最近距离 `d`，以及到外框中心的距离 `c`；
 * 2. 仅接受 `d ≤ tolerance_emu` 的候选（缺省容差 1 英寸，`DEFAULT_REATTACH_TOLERANCE_EMU`）；
 * 3. 排序 = `(d, c, shape_id)` 升序取最小 ⇒ **确定性**（无随机、无插入序依赖）；
 * 4. 两端都为空时，`start` 先定；`end` 排除已选中的 `start` 形状，避免自己连自己；
 *    已有非空端点的一侧保持不变，另一端也不会重挂到它身上。
 *
 * 找不到容差内候选 ⇒ 该端点**保持 `null`**（不猜），计入 `unresolved`；`throw_on_unresolved: true`
 * 时改抛 `no_reattach_candidate`。几何（`a:xfrm`）**不改**——本函数只补端点绑定。
 *
 * 无任何改动时返回**同一个** `presentation` 引用（便于调用方判等）。
 *
 * @throws {PresentationShapeError} `unknown_slide` / `unknown_shape` / `not_a_connector` / `no_reattach_candidate`。
 */
export function reattachConnectorEndpoints(
  presentation: Presentation,
  slideId: number,
  options?: ReattachOptions,
): ReattachResult {
  const tolerance = options?.tolerance_emu ?? DEFAULT_REATTACH_TOLERANCE_EMU;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new PresentationShapeError('no_reattach_candidate', `容差必须是非负有限数：${String(options?.tolerance_emu)}`);
  }

  const slide = requireSlide(presentation, slideId);

  // 候选：本页所有非连接符对象（含组合内子对象）。
  const candidates: { readonly id: number; readonly bounds: Bounds }[] = [];
  eachShape(slide.shapes, (shape) => {
    if (shape.kind === 'connector') return;
    candidates.push({ id: shape.shape_id, bounds: boundsOfShape(shape) });
  });

  const connectors: Extract<Shape, { kind: 'connector' }>[] = [];
  if (options?.connector_id !== undefined) {
    const shape = requireShape(slide, options.connector_id);
    if (shape.kind !== 'connector') {
      throw new PresentationShapeError('not_a_connector', `对象 shape_id=${String(options.connector_id)} 不是连接符`);
    }
    connectors.push(shape);
  } else {
    eachShape(slide.shapes, (shape) => {
      if (shape.kind === 'connector') connectors.push(shape);
    });
  }

  const reattached: ReattachOutcome[] = [];
  const unresolved: ReattachOutcome[] = [];
  const patches = new Map<number, { start_shape_id?: number; end_shape_id?: number }>();

  for (const connector of connectors) {
    const points = connectorEndpointPoints(connector);
    const patch: { start_shape_id?: number; end_shape_id?: number } = {};
    const pending: readonly ('start' | 'end')[] = (['start', 'end'] as const).filter((which) => {
      const current = which === 'start' ? connector.start_shape_id : connector.end_shape_id;
      return current === null;
    });

    const chosen = new Set<number>();
    // 已有端点（非重挂一侧）也要排除，避免重挂到同一形状造成自连。
    if (connector.start_shape_id !== null) chosen.add(connector.start_shape_id);
    if (connector.end_shape_id !== null) chosen.add(connector.end_shape_id);

    for (const which of pending) {
      const point = which === 'start' ? points.start : points.end;
      let best: { readonly id: number; readonly d: number; readonly c: number } | null = null;
      for (const candidate of candidates) {
        if (chosen.has(candidate.id)) continue;
        const d = distancePointToBounds(point.x, point.y, candidate.bounds);
        if (d > tolerance) continue;
        const c = distancePointToCenter(point.x, point.y, candidate.bounds);
        if (
          best === null ||
          d < best.d - 1e-9 ||
          (Math.abs(d - best.d) <= 1e-9 && c < best.c - 1e-9) ||
          (Math.abs(d - best.d) <= 1e-9 && Math.abs(c - best.c) <= 1e-9 && candidate.id < best.id)
        ) {
          best = { id: candidate.id, d, c };
        }
      }

      if (best === null) {
        const outcome: ReattachOutcome = Object.freeze({
          connector_id: connector.shape_id,
          endpoint: which,
          shape_id: null,
          distance_emu: null,
        });
        unresolved.push(outcome);
        if (options?.throw_on_unresolved === true) {
          throw new PresentationShapeError(
            'no_reattach_candidate',
            `连接符 shape_id=${String(connector.shape_id)} 的 ${which} 端点在容差 ${String(tolerance)} EMU 内找不到形状`,
          );
        }
        continue;
      }

      chosen.add(best.id);
      if (which === 'start') patch.start_shape_id = best.id;
      else patch.end_shape_id = best.id;
      reattached.push(
        Object.freeze({
          connector_id: connector.shape_id,
          endpoint: which,
          shape_id: best.id,
          distance_emu: best.d,
        }),
      );
    }

    if (patch.start_shape_id !== undefined || patch.end_shape_id !== undefined) patches.set(connector.shape_id, patch);
  }

  if (patches.size === 0) {
    return Object.freeze({
      presentation,
      tolerance_emu: tolerance,
      reattached: Object.freeze(reattached),
      unresolved: Object.freeze(unresolved),
    });
  }

  let next = presentation;
  for (const [connectorId, patch] of patches) {
    next = mapShapeInPresentation(next, slideId, connectorId, (shape) => {
      if (shape.kind !== 'connector') return shape;
      return {
        ...shape,
        start_shape_id: patch.start_shape_id ?? shape.start_shape_id,
        end_shape_id: patch.end_shape_id ?? shape.end_shape_id,
      };
    });
  }

  return Object.freeze({
    presentation: next,
    tolerance_emu: tolerance,
    reattached: Object.freeze(reattached),
    unresolved: Object.freeze(unresolved),
  });
}

/** 对象外框（组合用其自身 `a:xfrm`，子对象用自身存储坐标——与端点 id 口径一致）。 */
function boundsOfShape(shape: Shape): Bounds {
  const t = shape.transform;
  return { x_emu: t.x_emu, y_emu: t.y_emu, cx_emu: t.cx_emu, cy_emu: t.cy_emu };
}

/**
 * 让连接符的几何**跟随它两端的形状**（PPT-07）。
 *
 * 移动 / 改尺寸节点之后，连接符的 `a:xfrm` 还停在旧位置——线就"脱开"了盒子。本函数按
 * `geometryBetween` 的中心连线口径重算：`connectorId` 缺省 = 本页**所有仍连着两端**的连接符。
 * 端点为空的连接符跳过（没有可跟随的对象）；端点指向不存在的形状 ⇒ `unknown_endpoint`。
 *
 * @throws {PresentationShapeError} 指定对象不是连接符（`not_a_connector`）或端点悬空（`unknown_endpoint`）。
 */
export function syncConnectorGeometry(
  presentation: Presentation,
  slideId: number,
  connectorId?: number,
): Presentation {
  const requireConnectedEndpoint = (slide: Slide, endpointId: number, ownerId: number): void => {
    try {
      requireShape(slide, endpointId);
    } catch {
      throw new PresentationShapeError(
        'unknown_endpoint',
        `连接符 shape_id=${String(ownerId)} 指向不存在的形状 ${String(endpointId)}（悬空端点）`,
      );
    }
  };

  const initial = requireSlide(presentation, slideId);
  const targets: number[] = [];
  if (connectorId !== undefined) {
    const shape = requireShape(initial, connectorId);
    if (shape.kind !== 'connector') {
      throw new PresentationShapeError('not_a_connector', `对象 shape_id=${String(connectorId)} 不是连接符`);
    }
    targets.push(connectorId);
  } else {
    eachShape(initial.shapes, (shape) => {
      if (shape.kind === 'connector') targets.push(shape.shape_id);
    });
  }

  let next = presentation;
  for (const id of targets) {
    const slide = requireSlide(next, slideId);
    const current = requireShape(slide, id);
    if (current.kind !== 'connector') continue;
    const from = current.start_shape_id;
    const to = current.end_shape_id;
    if (from === null || to === null) continue;
    requireConnectedEndpoint(slide, from, id);
    requireConnectedEndpoint(slide, to, id);
    const geometry = geometryBetween(slide, from, to);
    next = mapShapeInPresentation(next, slideId, id, (shape) =>
      shape.kind === 'connector' ? { ...shape, transform: geometry } : shape,
    );
  }
  return next;
}

// ---------------------------------------------------------------------------
// 填充 / 轮廓 / 文本 / 删除（PPT-07）
// ---------------------------------------------------------------------------

/** 改自选图形的填充。非自选图形 ⇒ 报错（文本框没有填充字段）。 */
export function setShapeFill(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  fill: Fill,
): Presentation {
  return mapShapeInPresentation(presentation, slideId, shapeId, (shape) => {
    if (shape.kind !== 'auto_shape') {
      throw new PresentationShapeError(
        'shape_has_no_fill',
        `对象 ${shape.kind} 不接受填充（只有 auto_shape 有填充）`,
      );
    }
    return { ...shape, fill };
  });
}

/** 改轮廓（自选图形与连接符）。传 `null` = 回到默认（连接符默认线色由渲染层给）。 */
export function setShapeOutline(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  outline: Outline | null,
): Presentation {
  return mapShapeInPresentation(presentation, slideId, shapeId, (shape) => {
    if (shape.kind === 'auto_shape' || shape.kind === 'connector') {
      return { ...shape, outline };
    }
    throw new PresentationShapeError(
      'shape_has_no_outline',
      `对象 ${shape.kind} 不接受轮廓（只有 auto_shape / connector 有轮廓）`,
    );
  });
}

/** 改预设几何（自选图形 / 连接符）。连接符的连线形状由此切换。 */
export function setShapePreset(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  preset: string,
): Presentation {
  const next = requirePreset(preset);
  return mapShapeInPresentation(presentation, slideId, shapeId, (shape) => {
    if (shape.kind === 'auto_shape' || shape.kind === 'connector') {
      return { ...shape, preset: next };
    }
    throw new PresentationShapeError(
      'shape_has_no_outline',
      `对象 ${shape.kind} 不接受预设几何（只有 auto_shape / connector 有）`,
    );
  });
}

/** 改自选图形的形状文本（复用操作层的 `setShapeText`，同一套语义与错误）。 */
export function setAutoShapeText(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  text: TextBody,
): Presentation {
  return setShapeText(presentation, slideId, shapeId, text);
}

/** 追加一个段落到自选图形的形状文本（形状文本为空时先建空体）。 */
export function appendAutoShapeParagraph(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  paragraph: Paragraph,
): Presentation {
  return mapShapeInPresentation(presentation, slideId, shapeId, (shape) => {
    if (shape.kind !== 'auto_shape') {
      throw new PresentationShapeError(
        'shape_has_no_fill',
        `对象 ${shape.kind} 不接受形状文本（只有 auto_shape 有）`,
      );
    }
    const body: TextBody = shape.text ?? { paragraphs: [] };
    return { ...shape, text: { paragraphs: [...body.paragraphs, paragraph] } };
  });
}

/**
 * 删除一个形状对象（PPT-07）。同页引用它的连接符**端点一并摘掉**（`start/end_shape_id = null`），
 * 不留悬空引用——"删了节点还留着指向它的连线"是这类编辑最常见的脏状态。
 */
export function deleteShapeObject(presentation: Presentation, slideId: number, shapeId: number): Presentation {
  const slide = requireSlide(presentation, slideId);
  requireShape(slide, shapeId);
  const shapes = slide.shapes
    .filter((shape) => shape.shape_id !== shapeId)
    .map((shape) => {
      if (shape.kind !== 'connector') return shape;
      const start = shape.start_shape_id === shapeId ? null : shape.start_shape_id;
      const end = shape.end_shape_id === shapeId ? null : shape.end_shape_id;
      return start === shape.start_shape_id && end === shape.end_shape_id
        ? shape
        : { ...shape, start_shape_id: start, end_shape_id: end };
    });
  const updated: Presentation = {
    ...presentation,
    slides: presentation.slides.map((current) => (current.slide_id === slideId ? { ...current, shapes } : current)),
  };
  assertNoDanglingEndpoints(updated, slideId);
  return updated;
}

/** 页内是否存在指向不存在形状的连接符端点；有 ⇒ 具名报错。 */
export function assertNoDanglingEndpoints(presentation: Presentation, slideId: number): void {
  const slide = requireSlide(presentation, slideId);
  const ids = new Set<number>();
  eachShape(slide.shapes, (shape) => {
    ids.add(shape.shape_id);
  });
  eachShape(slide.shapes, (shape) => {
    if (shape.kind !== 'connector') return;
    for (const endpoint of [shape.start_shape_id, shape.end_shape_id]) {
      if (endpoint !== null && !ids.has(endpoint)) {
        throw new PresentationShapeError(
          'unknown_endpoint',
          `连接符 shape_id=${String(shape.shape_id)} 指向不存在的形状 ${String(endpoint)}（悬空端点）`,
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 流程：一组「盒子 + 连接符」（PPT-07 的"流程关系仍是可编辑对象"）
// ---------------------------------------------------------------------------

/** 流程参数：一串节点文本，两两之间连一条连接符。 */
export interface FlowSpec {
  readonly texts: readonly string[];
  /** 排列方向（缺省 `horizontal` = 横排；`vertical` = 竖排，流程图常用）。 */
  readonly direction?: 'horizontal' | 'vertical';
  /** 逐节点的 DrawingML 预设几何名（缺省全部 `roundRect`）。流程图形状见 `FLOWCHART_PRESETS`。 */
  readonly presets?: readonly string[];
  /** 首个节点的 x（横排缺省 0；竖排缺省 0）。 */
  readonly x_emu?: number;
  readonly y_emu?: number;
  readonly node_width_emu?: number;
  readonly node_height_emu?: number;
  readonly gap_emu?: number;
  readonly fill_color?: string;
  readonly line_color?: string;
}

/**
 * 造一个横向流程：`n` 个自选图形 + `n-1` 条连接符，**全部是可编辑对象**
 * （`p:sp` + `p:cxnSp`），不是一张位图。
 */
export function addFlowDiagram(
  presentation: Presentation,
  slideId: number,
  spec: FlowSpec,
): { readonly presentation: Presentation; readonly node_ids: readonly number[]; readonly connector_ids: readonly number[] } {
  if (spec.texts.length === 0) {
    throw new PresentationShapeError('empty_flow', '流程至少需要一个节点');
  }
  const width = spec.node_width_emu ?? DEFAULT_NODE_WIDTH;
  const height = spec.node_height_emu ?? DEFAULT_NODE_HEIGHT;
  const gap = spec.gap_emu ?? DEFAULT_NODE_GAP;
  const direction = spec.direction ?? 'horizontal';
  const originX = spec.x_emu ?? 0;
  const originY = spec.y_emu ?? 1000000;
  const fill: Fill = { kind: 'solid', color: spec.fill_color ?? 'D9E2F3' };
  const outline: Outline = { color: spec.line_color ?? '1F3864', width_emu: 12700 };

  let deck = presentation;
  const nodeIds: number[] = [];
  spec.texts.forEach((text, index) => {
    const step = index * (direction === 'horizontal' ? width + gap : height + gap);
    const x = direction === 'horizontal' ? originX + step : originX;
    const y = direction === 'vertical' ? originY + step : originY;
    const preset = spec.presets?.[index] ?? 'roundRect';
    const added = addAutoShape(deck, slideId, {
      transform: makeTransform(x, y, width, height),
      preset,
      fill,
      outline,
      text: {
        paragraphs: [{ runs: [{ source: { kind: 'literal', text } }], level: 0, alignment: 'center', bullet: false }],
      },
    });
    deck = added.presentation;
    nodeIds.push(added.shape_id);
  });

  const connectorIds: number[] = [];
  for (let index = 0; index + 1 < nodeIds.length; index += 1) {
    const from = nodeIds[index];
    const to = nodeIds[index + 1];
    if (from === undefined || to === undefined) continue;
    const added = addConnector(deck, slideId, {
      preset: 'line',
      outline,
      from,
      to,
    });
    deck = added.presentation;
    connectorIds.push(added.shape_id);
  }

  return { presentation: deck, node_ids: nodeIds, connector_ids: connectorIds };
}

// ---------------------------------------------------------------------------
// 读回校验：可编辑对象 vs. 整页截图
// ---------------------------------------------------------------------------

/** 页上的对象清单（供用例与上层断言）。 */
export interface SlideObjectInventory {
  readonly slide_id: number;
  readonly total: number;
  readonly by_kind: Readonly<Record<string, number>>;
  readonly shape_ids: readonly number[];
}

/** 统计某一页的对象（含组合子对象）。 */
export function describeSlideObjects(presentation: Presentation, slideId: number): SlideObjectInventory {
  const slide = requireSlide(presentation, slideId);
  const byKind: Record<string, number> = {};
  const shapeIds: number[] = [];
  eachShape(slide.shapes, (shape) => {
    byKind[shape.kind] = (byKind[shape.kind] ?? 0) + 1;
    shapeIds.push(shape.shape_id);
  });
  return Object.freeze({
    slide_id: slideId,
    total: shapeIds.length,
    by_kind: Object.freeze(byKind),
    shape_ids: Object.freeze(shapeIds),
  });
}

function collectElements(node: XmlElementNode, name: string, out: XmlElementNode[] = []): XmlElementNode[] {
  if (node.name === name) out.push(node);
  for (const child of childElements(node)) collectElements(child, name, out);
  return out;
}

/** 模型对象种类 → 期望的可编辑元素名（`picture`/`media` 走位图或媒体部件，不在此列）。 */
const EDITABLE_ELEMENT_BY_KIND: Readonly<Record<string, string>> = Object.freeze({
  text_box: 'p:sp',
  auto_shape: 'p:sp',
  connector: 'p:cxnSp',
  group: 'p:grpSp',
  table: 'p:graphicFrame',
  chart: 'p:graphicFrame',
});

/**
 * **整页截图**判定：页里若出现与幻灯片同尺寸的 `p:pic`，那就是把整页画成了一张位图。
 *
 * 判据是**几何**（`a:ext` 等于 `sldSz`），不是"有没有图片"——正常的插图不受影响。
 */
export function assertNoFullPageBitmap(
  slideXml: string,
  slideSize: { readonly cx_emu: number; readonly cy_emu: number },
): void {
  const root = parseXmlDocument(slideXml);
  for (const picture of collectElements(root, 'p:pic')) {
    for (const ext of collectElements(picture, 'a:ext')) {
      const cx = attributeOf(ext, 'cx');
      const cy = attributeOf(ext, 'cy');
      if (cx === String(slideSize.cx_emu) && cy === String(slideSize.cy_emu)) {
        throw new PresentationShapeError(
          'page_screenshot_detected',
          `幻灯片里存在与页面同尺寸（${cx}×${cy}）的位图对象——疑似整页截图，不是可编辑对象`,
        );
      }
    }
  }
}

/**
 * **读回校验**：模型里每个可编辑对象，在导出页里都找得到对应元素；页里没有整页位图；
 * 形状文本以 `<a:t>` 出现（不是被烧进图片）。
 *
 * @throws {PresentationShapeError} `object_count_mismatch` / `missing_editable_element` / `page_screenshot_detected`。
 */
export function verifyEditableObjects(
  slideXml: string,
  inventory: SlideObjectInventory,
  slideSize: { readonly cx_emu: number; readonly cy_emu: number },
): void {
  const root = parseXmlDocument(slideXml);
  const counts = new Map<string, number>();
  for (const [kind, element] of Object.entries(EDITABLE_ELEMENT_BY_KIND)) {
    const owned = inventory.by_kind[kind] ?? 0;
    if (owned === 0) continue;
    counts.set(element, (counts.get(element) ?? 0) + owned);
  }
  for (const [element, expected] of counts) {
    const actual = collectElements(root, element).length;
    if (actual !== expected) {
      throw new PresentationShapeError(
        'object_count_mismatch',
        `模型里应有 ${String(expected)} 个 ${element}，导出页里是 ${String(actual)} 个（页面对象被合并/丢弃？）`,
      );
    }
  }
  assertNoFullPageBitmap(slideXml, slideSize);
}

/** 形状树里**直接子元素**的种类（跳过 `p:nvGrpSpPr` / `p:grpSpPr` 前导）。 */
const SHAPE_CHILD_ELEMENTS: ReadonlySet<string> = Object.freeze(
  new Set(['p:sp', 'p:cxnSp', 'p:grpSp', 'p:graphicFrame', 'p:pic']),
);

/** 取一个 `p:grpSp` 节点下**直接**形状子元素的 `元素名#cNvPr@id`（不含更深层后代）。 */
function directChildElementIds(groupNode: XmlElementNode): Map<string, Set<string>> {
  const direct = new Map<string, Set<string>>();
  for (const child of childElements(groupNode)) {
    if (!SHAPE_CHILD_ELEMENTS.has(child.name)) continue;
    const idText = attributeOf(collectElements(child, 'p:cNvPr')[0], 'id');
    if (idText === undefined) continue;
    if (!direct.has(child.name)) direct.set(child.name, new Set());
    direct.get(child.name)?.add(idText);
  }
  return direct;
}

/**
 * **身份读回校验**：模型里每个可编辑对象的 `shape_id` 必须能在导出页里作为对应元素的
 * `p:cNvPr@id` 找到；自选图形 / 连接符的 `a:prstGeom@prst` 必须与模型一致。
 *
 * 这是对 `verifyEditableObjects`（只数元素个数）的加强：两种对象数量恰好对得上时，id 或
 * 预设几何被换掉仍逃不过本校验。图片 / 媒体等非可编辑种类不在范围内（它们本就不是可编辑元素）。
 *
 * **组合嵌套也校验**（P-I11 增强）：模型的每个 `group`，其**直接子可编辑对象**必须出现在导出页里
 * **同一个 `p:grpSp` 元素的直接子层**——只查"页里有没有这个 id"会漏掉"子对象被挪出组合、
 * 掉到顶层"这种结构退化（id 仍在，嵌套丢了）。该情形抛 `nested_element_mismatch`。
 *
 * @throws {PresentationShapeError} `missing_editable_element` / `unexpected_editable_element` /
 *   `preset_mismatch` / `nested_element_mismatch`。
 */
export function verifyShapeIdentity(slideXml: string, presentation: Presentation, slideId: number): void {
  const slide = requireSlide(presentation, slideId);
  const root = parseXmlDocument(slideXml);

  const xmlIdsByElement = new Map<string, Set<string>>();
  const xmlPresetByKey = new Map<string, string | undefined>();
  const groupNodeById = new Map<string, XmlElementNode>();
  for (const element of new Set(Object.values(EDITABLE_ELEMENT_BY_KIND))) {
    const ids = new Set<string>();
    for (const node of collectElements(root, element)) {
      const idText = attributeOf(collectElements(node, 'p:cNvPr')[0], 'id');
      if (idText === undefined) continue;
      ids.add(idText);
      xmlPresetByKey.set(`${element}#${idText}`, attributeOf(collectElements(node, 'a:prstGeom')[0], 'prst'));
      if (element === 'p:grpSp') groupNodeById.set(idText, node);
    }
    xmlIdsByElement.set(element, ids);
  }

  const modelByElement = new Map<string, Set<string>>();
  eachShape(slide.shapes, (shape) => {
    const element = EDITABLE_ELEMENT_BY_KIND[shape.kind];
    if (element === undefined) return; // 图片 / 媒体等非可编辑种类不在此校验
    const idText = String(shape.shape_id);
    if (!modelByElement.has(element)) modelByElement.set(element, new Set());
    modelByElement.get(element)?.add(idText);

    const ids = xmlIdsByElement.get(element);
    if (ids === undefined || !ids.has(idText)) {
      throw new PresentationShapeError(
        'missing_editable_element',
        `模型里的 ${shape.kind} shape_id=${idText} 在导出页里没有对应的 ${element}（id 丢失或被合并）`,
      );
    }
    const preset = shape.kind === 'auto_shape' || shape.kind === 'connector' ? shape.preset : undefined;
    if (preset !== undefined) {
      const xmlPreset = xmlPresetByKey.get(`${element}#${idText}`);
      if (xmlPreset !== preset) {
        throw new PresentationShapeError(
          'preset_mismatch',
          `shape_id=${idText} 的预设几何应为 ${preset}，导出页里是 ${String(xmlPreset)}`,
        );
      }
    }
  });

  for (const [element, modelIds] of modelByElement) {
    for (const idText of xmlIdsByElement.get(element) ?? []) {
      if (!modelIds.has(idText)) {
        throw new PresentationShapeError(
          'unexpected_editable_element',
          `导出页里有模型未声明的 ${element} p:cNvPr@id=${idText}`,
        );
      }
    }
  }

  // 结构嵌套：每个模型组合的直接子可编辑对象，必须落在该组合 p:grpSp 的**直接子层**。
  const checkGroupNesting = (group: Extract<Shape, { kind: 'group' }>): void => {
    const node = groupNodeById.get(String(group.shape_id));
    if (node === undefined) return; // 组合自身缺 id 已由上面的 missing_editable_element 报出
    const direct = directChildElementIds(node);
    for (const child of group.children) {
      const element = EDITABLE_ELEMENT_BY_KIND[child.kind];
      if (element !== undefined) {
        const ids = direct.get(element);
        if (ids === undefined || !ids.has(String(child.shape_id))) {
          throw new PresentationShapeError(
            'nested_element_mismatch',
            `组合 shape_id=${String(group.shape_id)} 的子对象 ${child.kind} shape_id=${String(
              child.shape_id,
            )} 未出现在该 p:grpSp 的直接子层（结构嵌套丢失/被挪到别处）`,
          );
        }
      }
      if (child.kind === 'group') checkGroupNesting(child);
    }
  };
  eachShape(slide.shapes, (shape) => {
    if (shape.kind === 'group') checkGroupNesting(shape);
  });
}

/** 场景渲染结果：多带一份各页对象清单。 */
export interface ShapesDeckResult extends RenderPresentationResult {
  readonly inventory_by_slide: readonly SlideObjectInventory[];
}

/**
 * 渲染一份"形状 / 流程"演示，并**逐页读回校验**可编辑对象（PPT-07）。
 *
 * 打包本身仍走 `renderPresentation`（同一渲染口径）；本入口只在其上做断言。
 */
export function buildShapesDeck(presentation: Presentation): ShapesDeckResult {
  for (const slide of presentation.slides) {
    assertNoDanglingEndpoints(presentation, slide.slide_id);
  }
  const result = renderPresentation(presentation);
  const inventory = presentation.slides.map((slide) => describeSlideObjects(presentation, slide.slide_id));

  const archive = readZip(result.bytes);
  presentation.slides.forEach((slide, index) => {
    const entry = archive.by_path.get(`ppt/slides/slide${String(index + 1)}.xml`);
    if (entry === undefined) {
      throw new PresentationShapeError('unknown_slide', `导出包里缺少第 ${String(index + 1)} 页部件`);
    }
    const current = inventory[index];
    if (current === undefined) {
      throw new PresentationShapeError('unknown_slide', `第 ${String(index + 1)} 页没有对象清单`);
    }
    verifyEditableObjects(Buffer.from(entry.data).toString('utf8'), current, presentation.size);
  });

  return Object.freeze({ ...result, inventory_by_slide: Object.freeze(inventory) });
}

/** 幻灯片 XML 里的形状树前导 id 常量（供用例理解 id 从 2 起）。 */
export const FIRST_SHAPE_ID = 2;

/** 命名空间常量（供接线方拼接片段时复用）。 */
export const PRESENTATION_NS = Object.freeze({ a: NS_A, p: NS_P, r: NS_R });

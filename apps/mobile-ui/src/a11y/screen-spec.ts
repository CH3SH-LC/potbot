/**
 * F-I04 — 可访问性 ScreenSpec 产品侧生产者（生产树 → ScreenSpec）。
 *
 * 背景：`tests/mobile-ui/F-R02/` 交付了独立的可访问性审计器与运行时校验器
 * （`auditScreen()` / `parseScreenSpec()`），但它**只消费**声明式 ScreenSpec，
 * 不自带生产者——R02 的 nextIncrement 明确要求产品侧把**渲染出来的视图树**转成
 * ScreenSpec 形状。本模块就是那个生产者。
 *
 * 输入两种来源：
 *   1. `ViewTree` —— 前端渲染层（F 线 render 单元，形如 F-I03）产出的视图节点树，
 *      坐标已是 dp，字段名与 ScreenSpec 的 NodeSpec 一一对应（见 `ViewNode`）。
 *   2. Android 无障碍节点 dump —— 由 `dump.ts` 把 px 坐标 + `className`/`content-description`
 *      归一化后**先转成 ViewTree**，再走同一条 `viewTreeToScreenSpec()` 路径。本文件不含
 *      平台特有逻辑，只做纯结构映射。
 *
 * 单一事实来源：交互节点"最小触区 48dp"这一阈值**只**从 F01 设计令牌
 * `foundation/tokens.ts` 的 `touch.minTargetDp` 取（design-07 行 105），本模块不另写
 * 常量。渲染树若声明 `expandTouchTargetToMin`，由 `hitSlopToReachMinTarget()` 用同一
 * 阈值算出所需外扩，避免"48"散落多处。
 *
 * 边界（如实标注，不冒充）：本模块**不渲染、不连真机、不读 DOM / Android View**；
 * 真机 TalkBack / 系统字号 / 折叠屏实测属 on-device 层，见 README.md。
 *
 * 类型说明：这里的 `ScreenSpec` / `NodeSpec` 等是**生产者侧的镜像类型**，形状对齐
 * `tests/mobile-ui/F-R02/types.ts`（src 不得反向依赖 tests）。二者一致由
 * `tests/mobile-ui/a11y/screen-spec.test.ts` 以 `parseScreenSpec()`（运行时校验器）和
 * 结构化赋值双向锁定，防止漂移。
 */

import { touch } from '../foundation/tokens.js';

// ---------------------------------------------------------------------------
// 阈值（唯一来源：F01 令牌）
// ---------------------------------------------------------------------------

/** 交互节点有效触区最小边长 dp。等于 F01 令牌 `touch.minTargetDp`（design-07 行 105）。 */
export const MIN_TARGET_DP: number = touch.minTargetDp;

// ---------------------------------------------------------------------------
// ScreenSpec 镜像类型（对齐 tests/mobile-ui/F-R02/types.ts）
// ---------------------------------------------------------------------------

/** dp 矩形（左上角 + 宽高）。 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 节点角色。与 F-R02 `NodeRole` 同集。 */
export const NODE_ROLES = [
  'screen',
  'header',
  'container',
  'list',
  'list-item',
  'card',
  'button',
  'icon-button',
  'input',
  'text',
  'image',
  'decorative-image',
  'heading',
  'status',
  'overlay',
  'sheet',
] as const;

export type NodeRole = (typeof NODE_ROLES)[number];

const ROLE_SET: ReadonlySet<string> = new Set<string>(NODE_ROLES);

/** 文本规格（用于 200% 字号走查）。 */
export interface TextSpec {
  readonly text: string;
  readonly fontSizeSp: number;
  readonly maxLines: number;
  readonly allowTruncate: boolean;
}

/** 一个界面节点。字段语义见 `tests/mobile-ui/F-R02/types.ts`。 */
export interface NodeSpec {
  readonly id: string;
  readonly role: NodeRole;
  readonly bounds: Rect;
  readonly label?: string;
  readonly objectName?: string;
  readonly interactive?: boolean;
  readonly enabled?: boolean;
  readonly focusable?: boolean;
  readonly hitSlopDp?: number;
  readonly focusRingWidthDp?: number;
  readonly focusRingClipped?: boolean;
  readonly criticalControl?: boolean;
  readonly text?: TextSpec;
  readonly type?: string;
  readonly status?: string;
  readonly actionConsequence?: string;
  readonly announcementsPerSecond?: number;
  readonly interruptsReading?: boolean;
  readonly nlEntry?: boolean;
  readonly trapsFocus?: boolean;
  readonly returnsFocusTo?: string;
}

/** 遮挡区类型：铰链 / 挖孔 / 系统手势区。 */
export type OcclusionKind = 'hinge' | 'cutout' | 'gesture';

export interface OcclusionRect extends Rect {
  readonly kind: OcclusionKind;
}

/** 视口规格。 */
export interface ViewportSpec {
  readonly widthDp: number;
  readonly heightDp: number;
  readonly orientation: 'portrait' | 'landscape';
  readonly fontScale: number;
  readonly occlusions: readonly OcclusionRect[];
  readonly columns: 1 | 2;
  readonly collapsesToSingleColumn: boolean;
}

/** 整屏规格（F-R02 `parseScreenSpec()` 的输入类型）。 */
export interface ScreenSpec {
  readonly id: string;
  readonly viewport: ViewportSpec;
  readonly nodes: readonly NodeSpec[];
  readonly focusOrder: readonly string[];
  readonly requiredStateKeys?: readonly string[];
  readonly preservedState?: readonly string[];
}

// ---------------------------------------------------------------------------
// 输入：渲染视图树（F 线 render 单元产出）
// ---------------------------------------------------------------------------

/**
 * 渲染层的视图节点（dp 坐标）。
 *
 * 这是**结构性**接口：F 线渲染单元（F-I03 一类）只要字段名/含义一致，无需 import
 * 本模块即可被消费（duck typing）。`role` 直接取 NodeRole，渲染层负责把组件
 * 映射到角色；`bounds` 必须是已按密度换算好的 dp。
 */
export interface ViewNode {
  readonly id: string;
  readonly role: NodeRole;
  readonly bounds: Rect;
  readonly label?: string;
  readonly objectName?: string;
  readonly interactive?: boolean;
  readonly enabled?: boolean;
  readonly focusable?: boolean;
  readonly hitSlopDp?: number;
  /**
   * 渲染器已用触摸代理把有效触区外扩至最小触区（Android `TouchDelegate` /
   * Material 最小触区）。置 true 时由生产者按 `MIN_TARGET_DP` 算出 `hitSlopDp`，
   * 与显式 `hitSlopDp` 取较大者——阈值只在 F01 令牌出现一次。
   */
  readonly expandTouchTargetToMin?: boolean;
  readonly focusRingWidthDp?: number;
  readonly focusRingClipped?: boolean;
  readonly criticalControl?: boolean;
  readonly text?: TextSpec;
  readonly type?: string;
  readonly status?: string;
  readonly actionConsequence?: string;
  readonly announcementsPerSecond?: number;
  readonly interruptsReading?: boolean;
  readonly nlEntry?: boolean;
  readonly trapsFocus?: boolean;
  readonly returnsFocusTo?: string;
  readonly children?: readonly ViewNode[];
}

/** 一整棵渲染视图树 + 视口声明。 */
export interface ViewTree {
  readonly id: string;
  readonly viewport: ViewportSpec;
  readonly root: ViewNode;
  /** 显式焦点顺序；缺省时由 `deriveFocusOrder()` 从视觉顺序推导。 */
  readonly focusOrder?: readonly string[];
  readonly requiredStateKeys?: readonly string[];
  readonly preservedState?: readonly string[];
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 生产阶段错误：输入缺字段 / 类型错 / 角色未知。带 code 与出错路径。 */
export class ScreenSpecBuildError extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string, message: string) {
    super(`${code} @ ${path}: ${message}`);
    this.name = 'ScreenSpecBuildError';
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// 校验原语
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (!isFiniteNumber(value)) {
    throw new ScreenSpecBuildError('invalid-number', path, `期望有限数值，得到 ${String(value)}`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ScreenSpecBuildError('invalid-string', path, `期望非空字符串，得到 ${String(value)}`);
  }
  return value;
}

function requireRole(value: unknown, path: string): NodeRole {
  const role = requireNonEmptyString(value, path);
  if (!ROLE_SET.has(role)) {
    throw new ScreenSpecBuildError('invalid-role', path, `未知角色 ${role}`);
  }
  return role as NodeRole;
}

function requireRect(value: unknown, path: string): Rect {
  if (value === null || typeof value !== 'object') {
    throw new ScreenSpecBuildError('invalid-rect', path, '期望矩形对象 {x,y,w,h}');
  }
  const r = value as Record<string, unknown>;
  return {
    x: requireFiniteNumber(r['x'], `${path}.x`),
    y: requireFiniteNumber(r['y'], `${path}.y`),
    w: requireFiniteNumber(r['w'], `${path}.w`),
    h: requireFiniteNumber(r['h'], `${path}.h`),
  };
}

function parseText(value: unknown, path: string): TextSpec {
  if (value === null || typeof value !== 'object') {
    throw new ScreenSpecBuildError('invalid-text', path, '期望文本对象');
  }
  const t = value as Record<string, unknown>;
  const maxLines = requireFiniteNumber(t['maxLines'], `${path}.maxLines`);
  if (maxLines < 1) {
    throw new ScreenSpecBuildError('invalid-max-lines', `${path}.maxLines`, `至少 1 行，得到 ${maxLines}`);
  }
  if (typeof t['allowTruncate'] !== 'boolean') {
    throw new ScreenSpecBuildError('invalid-boolean', `${path}.allowTruncate`, `期望布尔`);
  }
  return {
    text: requireNonEmptyString(t['text'], `${path}.text`),
    fontSizeSp: requireFiniteNumber(t['fontSizeSp'], `${path}.fontSizeSp`),
    maxLines,
    allowTruncate: t['allowTruncate'],
  };
}

function parseOcclusion(value: unknown, path: string): OcclusionRect {
  const rect = requireRect(value, path);
  const kind = requireNonEmptyString((value as Record<string, unknown>)['kind'], `${path}.kind`);
  if (kind !== 'hinge' && kind !== 'cutout' && kind !== 'gesture') {
    throw new ScreenSpecBuildError('invalid-occlusion-kind', `${path}.kind`, `未知遮挡类型 ${kind}`);
  }
  return { ...rect, kind };
}

function normalizeViewport(value: unknown, path: string): ViewportSpec {
  if (value === null || typeof value !== 'object') {
    throw new ScreenSpecBuildError('invalid-viewport', path, '期望视口对象');
  }
  const v = value as Record<string, unknown>;
  const widthDp = requireFiniteNumber(v['widthDp'], `${path}.widthDp`);
  const heightDp = requireFiniteNumber(v['heightDp'], `${path}.heightDp`);
  if (widthDp <= 0 || heightDp <= 0) {
    throw new ScreenSpecBuildError('invalid-viewport-size', path, `视口尺寸必须为正，得到 ${widthDp}×${heightDp}`);
  }
  const orientation = requireNonEmptyString(v['orientation'], `${path}.orientation`);
  if (orientation !== 'portrait' && orientation !== 'landscape') {
    throw new ScreenSpecBuildError('invalid-orientation', `${path}.orientation`, `未知朝向 ${orientation}`);
  }
  const fontScale = requireFiniteNumber(v['fontScale'], `${path}.fontScale`);
  if (fontScale <= 0) {
    throw new ScreenSpecBuildError('invalid-font-scale', `${path}.fontScale`, `缩放必须为正，得到 ${fontScale}`);
  }
  const columns = requireFiniteNumber(v['columns'], `${path}.columns`);
  if (columns !== 1 && columns !== 2) {
    throw new ScreenSpecBuildError('invalid-columns', `${path}.columns`, `列数只能是 1 或 2，得到 ${columns}`);
  }
  if (typeof v['collapsesToSingleColumn'] !== 'boolean') {
    throw new ScreenSpecBuildError(
      'invalid-boolean',
      `${path}.collapsesToSingleColumn`,
      '期望布尔',
    );
  }
  const occlusionsRaw = v['occlusions'];
  if (!Array.isArray(occlusionsRaw)) {
    throw new ScreenSpecBuildError('invalid-occlusions', `${path}.occlusions`, '期望遮挡区数组');
  }
  return {
    widthDp,
    heightDp,
    orientation,
    fontScale,
    occlusions: occlusionsRaw.map((o, i) => parseOcclusion(o, `${path}.occlusions[${i}]`)),
    columns,
    collapsesToSingleColumn: v['collapsesToSingleColumn'],
  };
}

// ---------------------------------------------------------------------------
// 触区外扩（阈值唯一来源）
// ---------------------------------------------------------------------------

/**
 * 把 bounds 对称外扩到至少 `targetDp`（默认 `MIN_TARGET_DP`）所需的每侧 hitSlop。
 * 已达标返回 0。非法尺寸抛 `invalid-bounds`。
 */
export function hitSlopToReachMinTarget(bounds: Rect, targetDp: number = MIN_TARGET_DP): number {
  if (!isFiniteNumber(bounds.w) || !isFiniteNumber(bounds.h)) {
    throw new ScreenSpecBuildError('invalid-bounds', 'bounds', `非有限尺寸 ${bounds.w}×${bounds.h}`);
  }
  const shortSide = Math.min(bounds.w, bounds.h);
  if (shortSide >= targetDp) return 0;
  return Math.ceil((targetDp - shortSide) / 2);
}

// ---------------------------------------------------------------------------
// 遍历
// ---------------------------------------------------------------------------

interface Walked {
  readonly node: ViewNode;
  readonly path: string;
}

/** 先序遍历视图树，带上每个节点的路径（用于报错定位）。 */
export function walkViewTree(root: ViewNode): readonly Walked[] {
  const out: Walked[] = [];
  const visit = (node: ViewNode, path: string): void => {
    out.push({ node, path });
    const children = node.children ?? [];
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      if (child === undefined) continue;
      visit(child, `${path}.children[${i}]`);
    }
  };
  visit(root, 'tree.root');
  return out;
}

/** 把视图树拍平成节点数组（先序）。 */
export function flattenViewTree(root: ViewNode): readonly ViewNode[] {
  return walkViewTree(root).map((w) => w.node);
}

/** 是否进入焦点序列（镜像 tests/mobile-ui/F-R02/a11y.ts 的 `isFocusable`）。 */
export function isFocusableView(node: ViewNode): boolean {
  if (node.focusable !== undefined) return node.focusable;
  if (node.interactive === true) return node.enabled !== false;
  return node.role === 'overlay' || node.role === 'sheet';
}

// ---------------------------------------------------------------------------
// 视觉顺序推导（镜像 F-R02 的 visualOrder，用于缺省 focusOrder）
// ---------------------------------------------------------------------------

/**
 * 推导视觉阅读顺序（上→下，同带内左→右）。
 *
 * 算法与 `tests/mobile-ui/F-R02/a11y.ts` 的 `visualOrder()` 一致：按上边排序后，
 * 与当前带垂直范围仍相交的并入同带，否则另起一带；同带内按左边界升序。
 * 这里**刻意重复**该算法：src 不得反向 import tests，而审计器要求声明的焦点顺序
 * 与视觉顺序一致——缺省推导必须命中同一规则。
 */
export function deriveFocusOrder(nodes: readonly NodeSpec[]): readonly string[] {
  const items = nodes.filter(isFocusableSpec).slice();
  items.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
  const bands: NodeSpec[][] = [];
  for (const node of items) {
    const band = bands[bands.length - 1];
    if (band === undefined) {
      bands.push([node]);
      continue;
    }
    const top = Math.min(...band.map((n) => n.bounds.y));
    const bottom = Math.max(...band.map((n) => n.bounds.y + n.bounds.h));
    const overlapsBand = node.bounds.y < bottom && node.bounds.y + node.bounds.h > top;
    if (overlapsBand) {
      band.push(node);
    } else {
      bands.push([node]);
    }
  }
  const order: string[] = [];
  for (const band of bands) {
    band.sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
    for (const node of band) order.push(node.id);
  }
  return order;
}

function isFocusableSpec(node: NodeSpec): boolean {
  if (node.focusable !== undefined) return node.focusable;
  if (node.interactive === true) return node.enabled !== false;
  return node.role === 'overlay' || node.role === 'sheet';
}

// ---------------------------------------------------------------------------
// 节点映射
// ---------------------------------------------------------------------------

function nodeSpecOf(node: ViewNode, path: string): NodeSpec {
  const id = requireNonEmptyString(node.id, `${path}.id`);
  const role = requireRole(node.role, `${path}.role`);
  const bounds = requireRect(node.bounds, `${path}.bounds`);

  let hitSlopDp = node.hitSlopDp;
  if (hitSlopDp !== undefined) {
    requireFiniteNumber(hitSlopDp, `${path}.hitSlopDp`);
  }
  if (node.expandTouchTargetToMin === true) {
    const needed = hitSlopToReachMinTarget(bounds, MIN_TARGET_DP);
    hitSlopDp = Math.max(hitSlopDp ?? 0, needed);
  }

  const spec: NodeSpec = {
    id,
    role,
    bounds,
    ...(node.label !== undefined ? { label: requireNonEmptyOrEmpty(node.label, `${path}.label`) } : {}),
    ...(node.objectName !== undefined
      ? { objectName: requireNonEmptyOrEmpty(node.objectName, `${path}.objectName`) }
      : {}),
    ...(node.interactive !== undefined ? { interactive: requireBool(node.interactive, `${path}.interactive`) } : {}),
    ...(node.enabled !== undefined ? { enabled: requireBool(node.enabled, `${path}.enabled`) } : {}),
    ...(node.focusable !== undefined ? { focusable: requireBool(node.focusable, `${path}.focusable`) } : {}),
    ...(hitSlopDp !== undefined ? { hitSlopDp } : {}),
    ...(node.focusRingWidthDp !== undefined
      ? { focusRingWidthDp: requireFiniteNumber(node.focusRingWidthDp, `${path}.focusRingWidthDp`) }
      : {}),
    ...(node.focusRingClipped !== undefined
      ? { focusRingClipped: requireBool(node.focusRingClipped, `${path}.focusRingClipped`) }
      : {}),
    ...(node.criticalControl !== undefined
      ? { criticalControl: requireBool(node.criticalControl, `${path}.criticalControl`) }
      : {}),
    ...(node.text !== undefined ? { text: parseText(node.text, `${path}.text`) } : {}),
    ...(node.type !== undefined ? { type: requireNonEmptyOrEmpty(node.type, `${path}.type`) } : {}),
    ...(node.status !== undefined ? { status: requireNonEmptyOrEmpty(node.status, `${path}.status`) } : {}),
    ...(node.actionConsequence !== undefined
      ? { actionConsequence: requireNonEmptyOrEmpty(node.actionConsequence, `${path}.actionConsequence`) }
      : {}),
    ...(node.announcementsPerSecond !== undefined
      ? {
          announcementsPerSecond: requireFiniteNumber(
            node.announcementsPerSecond,
            `${path}.announcementsPerSecond`,
          ),
        }
      : {}),
    ...(node.interruptsReading !== undefined
      ? { interruptsReading: requireBool(node.interruptsReading, `${path}.interruptsReading`) }
      : {}),
    ...(node.nlEntry !== undefined ? { nlEntry: requireBool(node.nlEntry, `${path}.nlEntry`) } : {}),
    ...(node.trapsFocus !== undefined ? { trapsFocus: requireBool(node.trapsFocus, `${path}.trapsFocus`) } : {}),
    ...(node.returnsFocusTo !== undefined
      ? { returnsFocusTo: requireNonEmptyOrEmpty(node.returnsFocusTo, `${path}.returnsFocusTo`) }
      : {}),
  };
  return spec;
}

function requireBool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ScreenSpecBuildError('invalid-boolean', path, `期望布尔，得到 ${String(value)}`);
  }
  return value;
}

/** 字符串字段：允许空串（读屏名称可为空，由审计器判"缺名称"），但非字符串拒绝。 */
function requireNonEmptyOrEmpty(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new ScreenSpecBuildError('invalid-string', path, `期望字符串，得到 ${String(value)}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 把渲染视图树转成 F-R02 可消费的 ScreenSpec。
 *
 * - 视口与几何逐项校验；缺字段 / NaN / 未知角色抛 `ScreenSpecBuildError`（带路径）。
 * - `focusOrder` 缺省按 `deriveFocusOrder()` 推导；显式给出时校验为非空字符串数组。
 * - 节点 id 必须唯一（重复抛 `duplicate-node-id`）。
 *
 * 产物保证能被 `tests/mobile-ui/F-R02/schema.ts` 的 `parseScreenSpec()` 接受
 * （由 F-I04 测试锁定）。
 */
export function viewTreeToScreenSpec(tree: ViewTree): ScreenSpec {
  if (tree === null || typeof tree !== 'object') {
    throw new ScreenSpecBuildError('invalid-tree', 'tree', '期望视图树对象');
  }
  const id = requireNonEmptyString(tree.id, 'tree.id');
  const viewport = normalizeViewport(tree.viewport, 'tree.viewport');

  const walked = walkViewTree(tree.root);
  const nodes = walked.map((w) => nodeSpecOf(w.node, w.path));

  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) {
      throw new ScreenSpecBuildError('duplicate-node-id', 'tree.root', `节点 id 重复：${node.id}`);
    }
    seen.add(node.id);
  }

  const focusOrder =
    tree.focusOrder !== undefined
      ? tree.focusOrder.map((nodeId, i) => requireNonEmptyString(nodeId, `tree.focusOrder[${i}]`))
      : deriveFocusOrder(nodes);

  const requiredStateKeys =
    tree.requiredStateKeys !== undefined
      ? tree.requiredStateKeys.map((k, i) => requireNonEmptyString(k, `tree.requiredStateKeys[${i}]`))
      : undefined;
  const preservedState =
    tree.preservedState !== undefined
      ? tree.preservedState.map((k, i) => requireNonEmptyString(k, `tree.preservedState[${i}]`))
      : undefined;

  return {
    id,
    viewport,
    nodes,
    focusOrder,
    ...(requiredStateKeys !== undefined ? { requiredStateKeys } : {}),
    ...(preservedState !== undefined ? { preservedState } : {}),
  };
}

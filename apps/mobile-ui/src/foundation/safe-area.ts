/**
 * F01 foundation —— 安全区（safe area / insets）。
 *
 * 目的：给 F01 验收里的「安全区合格」提供可断言的**纯函数**。设计原件对安全区的要求：
 *   - §0 行 15 / §4 行 117：正式 App 输入区固定在键盘上方，并处理系统安全区、返回和输入法；
 *     内联原型用自然文档流，**不承诺**固定于物理屏幕。
 *   - §12 行 255：紧凑窗口单栏＋底部导航；中等/展开窗口改用导航栏。
 *   - §12 行 256：折叠和旋转保留状态；**铰链/挖孔/手势区域不可放关键控制**。
 *   - §3 行 104：手机页面左右 20dp，窄屏允许 16dp；§3 行 105：有效触区 ≥48dp。
 *
 * design 未给具体 inset 数值（真机相关），故本模块只做**换算**，数值由调用方注入。
 * 零依赖、纯函数。输入非法（负数/NaN）即抛错，不静默夹取。
 */

import { spacing, touch } from './tokens.js';

/** 边（安全区/禁止区所在方向）。 */
export type EdgeId = 'top' | 'right' | 'bottom' | 'left';

/** 四边 inset（dp，均 ≥0）。 */
export interface SafeAreaInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export const ZERO_INSETS: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/** 一个禁止放置关键控制器的边带。 */
export interface ForbiddenZone {
  /** 禁止区标识（挖孔/铰链/手势/系统栏）。 */
  readonly id: 'status-bar' | 'display-cutout' | 'navigation-bar' | 'gesture' | 'hinge';
  readonly edge: EdgeId;
  /** 自该边起的禁止厚度（dp）。 */
  readonly thicknessDp: number;
  readonly reason: string;
}

export interface ForbiddenZoneOptions {
  /** 铰链带宽（dp）；`>0` 时生成 `hinge` 禁止区。缺省 0（无铰链）。 */
  readonly hingeDp?: number;
  /** 铰链靠哪条边；缺省 `left`。 */
  readonly hingeEdge?: EdgeId;
}

export type SafeAreaErrorCode = 'invalid-insets' | 'invalid-thickness' | 'invalid-keyboard-height';

export class SafeAreaError extends Error {
  readonly code: SafeAreaErrorCode;
  constructor(code: SafeAreaErrorCode, message: string) {
    super(message);
    this.name = 'SafeAreaError';
    this.code = code;
  }
}

function assertNonNegative(value: number, code: SafeAreaErrorCode, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new SafeAreaError(code, `${label} 必须为非负有限数，收到 ${String(value)}`);
  }
}

/** 校验 inset；非法即抛 `invalid-insets`。 */
export function validateInsets(insets: SafeAreaInsets): void {
  assertNonNegative(insets.top, 'invalid-insets', 'insets.top');
  assertNonNegative(insets.right, 'invalid-insets', 'insets.right');
  assertNonNegative(insets.bottom, 'invalid-insets', 'insets.bottom');
  assertNonNegative(insets.left, 'invalid-insets', 'insets.left');
}

/**
 * 由系统 inset（+ 可选铰链）推导禁止区边带。
 * 厚度为 0 的边不生成（避免"空"禁止区污染断言）。重叠系统栏（状态栏/挖孔、
 * 导航栏/手势）分开登记，便于按原因追责。
 */
export function forbiddenZones(
  insets: SafeAreaInsets,
  options: ForbiddenZoneOptions = {},
): readonly ForbiddenZone[] {
  validateInsets(insets);
  const hingeDp = options.hingeDp ?? 0;
  const hingeEdge = options.hingeEdge ?? 'left';
  assertNonNegative(hingeDp, 'invalid-thickness', 'hingeDp');

  const zones: ForbiddenZone[] = [];
  if (insets.top > 0) {
    zones.push({ id: 'status-bar', edge: 'top', thicknessDp: insets.top, reason: '系统状态栏' });
    zones.push({ id: 'display-cutout', edge: 'top', thicknessDp: insets.top, reason: '挖孔/刘海' });
  }
  if (insets.bottom > 0) {
    zones.push({ id: 'navigation-bar', edge: 'bottom', thicknessDp: insets.bottom, reason: '系统导航栏' });
    zones.push({ id: 'gesture', edge: 'bottom', thicknessDp: insets.bottom, reason: '手势区域' });
  }
  if (hingeDp > 0) {
    zones.push({ id: 'hinge', edge: hingeEdge, thicknessDp: hingeDp, reason: '折叠铰链' });
  }
  return zones;
}

/** 某条边上最大的禁止厚度（无禁止区时为 0）。 */
export function minInsetForEdge(zones: readonly ForbiddenZone[], edge: EdgeId): number {
  let max = 0;
  for (const zone of zones) {
    if (zone.edge === edge && zone.thicknessDp > max) max = zone.thicknessDp;
  }
  return max;
}

export interface ContentPaddingOptions {
  /** 窄屏：页边用 16dp（§3 行 104）。缺省 false（20dp）。 */
  readonly narrow?: boolean;
  /** 额外禁止区（如铰链）；其边厚会抬高对应方向的 padding。 */
  readonly zones?: readonly ForbiddenZone[];
}

export interface EdgeInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/**
 * 计算内容区 padding：
 *   - 左右：`max(页边, inset, 该边禁止厚度)`（页边 20 / 窄屏 16，§3 行 104）；
 *   - 上：`max(inset.top, 顶部禁止厚度)`；
 *   - 下：底部禁止厚度交给输入区处理（`inputBarOffset`），此处取 inset.bottom 以免内容被系统栏遮住。
 * 保证返回的每个边 ≥ 对应禁止区厚度（铰链/挖孔不可放关键控制，§12 行 256）。
 */
export function contentPadding(insets: SafeAreaInsets, options: ContentPaddingOptions = {}): EdgeInsets {
  validateInsets(insets);
  const zones = options.zones ?? [];
  const base = options.narrow === true ? spacing.pageInlineNarrowDp : spacing.pageInlineDp;

  const left = Math.max(base, insets.left, minInsetForEdge(zones, 'left'));
  const right = Math.max(base, insets.right, minInsetForEdge(zones, 'right'));
  const top = Math.max(insets.top, minInsetForEdge(zones, 'top'));
  const bottom = Math.max(insets.bottom, minInsetForEdge(zones, 'bottom'));

  return { top, right, bottom, left };
}

/** 输入区定位模式（与 `tokens.ShellMode` 对应，但只关心底部偏移）。 */
export type InputPlacement = 'above-keyboard-fixed' | 'document-flow-bottom';

/**
 * 输入区（关键控制）距屏幕底部的偏移：
 *   - `above-keyboard-fixed`（正式 App）：`max(底部安全区, 键盘高)`——键盘抬高且避开手势区；
 *   - `document-flow-bottom`（内联原型）：0（自然文档流，不承诺固定；§0 行 15）。
 * 键盘高非法（负数/NaN）即抛 `invalid-keyboard-height`。
 */
export function inputBarOffset(
  placement: InputPlacement,
  insets: SafeAreaInsets,
  keyboardHeightDp = 0,
): number {
  validateInsets(insets);
  assertNonNegative(keyboardHeightDp, 'invalid-keyboard-height', 'keyboardHeightDp');
  if (placement === 'document-flow-bottom') return 0;
  return Math.max(insets.bottom, keyboardHeightDp);
}

/**
 * 关键控制器（如底部导航/输入条）的最小触区是否仍满足 48dp：
 * 顶部/底部禁止厚度不得超过该边可用高度。此处只做**可用高度检查**的纯函数。
 */
export function criticalControlFits(availableHeightDp: number, minimumDp = touch.minTargetDp): boolean {
  assertNonNegative(availableHeightDp, 'invalid-thickness', 'availableHeightDp');
  return availableHeightDp >= minimumDp;
}

// ---------------------------------------------------------------------------
// 宿主注入钩子（injectable passthrough hooks）
// ---------------------------------------------------------------------------
//
// 设计未给具体 inset 数值（真机相关，见文件头）。foundation **不读**任何 Android API，
// 只提供**透传**入口：Android 宿主把真实系统 inset、IME（软键盘）高度与折叠铰链宽度
// 喂进来，这里换算成内容 padding / 输入区偏移 / 禁止区。非法值一律抛错，不静默夹取。

/** Android 宿主注入的原始系统值（foundation 不得自行猜测或读取）。 */
export interface HostSystemInsets {
  /** 系统窗口安全区（状态栏/导航栏/挖孔/手势），dp，均 ≥0。 */
  readonly system: SafeAreaInsets;
  /** 输入法（IME）高度，dp；键盘收起为 0。 */
  readonly imeHeightDp: number;
  /** 折叠铰链宽度，dp；`>0` 时生成 `hinge` 禁止区。缺省 0（无铰链）。 */
  readonly hingeDp?: number;
  /** 铰链靠哪条边；缺省 `left`。 */
  readonly hingeEdge?: EdgeId;
}

/** 由宿主值算出的可渲染安全区布局。 */
export interface SafeAreaLayout {
  readonly insets: SafeAreaInsets;
  readonly keyboardHeightDp: number;
  readonly zones: readonly ForbiddenZone[];
  readonly padding: EdgeInsets;
  readonly inputBarOffset: number;
}

export interface HostLayoutOptions {
  /** 输入区定位；缺省 `above-keyboard-fixed`（正式 App）。 */
  readonly placement?: InputPlacement;
  /** 窄屏：页边用 16dp（§3 行 104）。 */
  readonly narrow?: boolean;
  /** 额外禁止区（如临时浮层/系统 UI）；与由 inset/铰链推导的禁止区合并。 */
  readonly extraZones?: readonly ForbiddenZone[];
}

/**
 * 纯函数：把宿主注入的系统值换算成安全区布局。
 * 非法 inset / IME 高度 / 铰链宽即抛对应错误（复用已有的校验）。
 */
export function layoutFromHost(host: HostSystemInsets, options: HostLayoutOptions = {}): SafeAreaLayout {
  validateInsets(host.system);
  assertNonNegative(host.imeHeightDp, 'invalid-keyboard-height', 'imeHeightDp');

  const zones: readonly ForbiddenZone[] = [
    ...forbiddenZones(host.system, { hingeDp: host.hingeDp ?? 0, hingeEdge: host.hingeEdge ?? 'left' }),
    ...(options.extraZones ?? []),
  ];

  return {
    insets: host.system,
    keyboardHeightDp: host.imeHeightDp,
    zones,
    padding: contentPadding(host.system, { narrow: options.narrow, zones }),
    inputBarOffset: inputBarOffset(options.placement ?? 'above-keyboard-fixed', host.system, host.imeHeightDp),
  };
}

/** 宿主值变更时的回调。 */
export type SafeAreaListener = (layout: SafeAreaLayout) => void;

/** 宿主→foundation 的透传桥：宿主推送新值，foundation 换算并通知订阅者。 */
export interface SafeAreaBridge {
  /** 合并推送新值（部分字段即可），换算后通知全部订阅者并返回最新布局。非法值抛错，不改变既有状态。 */
  update(patch: Partial<HostSystemInsets>): SafeAreaLayout;
  /** 当前注入值快照（副本，外部改写不污染桥内状态）。 */
  current(): HostSystemInsets;
  /** 最近一次换算出的布局。 */
  layout(): SafeAreaLayout;
  /** 订阅布局变化；返回退订函数（幂等）。 */
  subscribe(listener: SafeAreaListener): () => void;
}

/**
 * 创建安全区注入桥。宿主（Android MainActivity / K01）调用 `update()` 喂真实
 * inset/IME；UI 层调用 `subscribe()` 拿最新布局。foundation 全程零系统调用。
 */
export function createSafeAreaBridge(
  initial: HostSystemInsets,
  options: HostLayoutOptions = {},
): SafeAreaBridge {
  let host: HostSystemInsets = { ...initial };
  let last: SafeAreaLayout = layoutFromHost(host, options);
  const listeners = new Set<SafeAreaListener>();

  return {
    update(patch: Partial<HostSystemInsets>): SafeAreaLayout {
      // 先换算（可能抛错）再提交，保证失败时既有状态不变。
      const next: HostSystemInsets = { ...host, ...patch };
      const layout = layoutFromHost(next, options);
      host = next;
      last = layout;
      for (const listener of [...listeners]) listener(layout);
      return layout;
    },
    current(): HostSystemInsets {
      return { ...host };
    },
    layout(): SafeAreaLayout {
      return last;
    },
    subscribe(listener: SafeAreaListener): () => void {
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
  };
}

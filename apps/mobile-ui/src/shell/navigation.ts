/**
 * F-UI01 shell —— 导航栈（navigation stack，per-page scroll anchors）。
 *
 * 壳层的导航状态：不可变栈 + **每页滚动锚点**表。语义与 design-07 §2「返回目标」列一致：
 *   - 栈顶 = 当前页；根节点 pop 是 no-op（不下溢）；
 *   - push 超过深度上限**拒绝**并抛 `nav-depth-exceeded`（不静默截断旧页）；
 *   - 页面离开前用 `setScrollAnchor` 记录锚点，返回该页时用 `scrollAnchorOf` /
 *     `anchorForTop` 还原（「保留原滚动位置」，如 C03 返回 C01/C02）。
 *
 * 只允许压入**已登记**的屏幕 id（消费 `./registry.js`），防止路由名漂移。
 * 零依赖、纯函数：不读时钟 / 随机数 / 网络，不改动入参。
 */

import { type ScreenId } from './screens.js';
import { isRegisteredScreen, screenDefOf } from './registry.js';

/** 返回栈深度上限；超过即拒绝 push（不静默截断）。 */
export const NAV_DEPTH_LIMIT = 16;

/** 稳定的滚动锚点：翻回某页时用它恢复滚动位置（不依赖绝对像素估算）。 */
export interface ScrollAnchor {
  /** 定位键，例如某会话 / 文件 id。 */
  readonly key: string;
  readonly offsetPx: number;
}

/** 栈帧：一个已登记屏幕 + 其路由参数。 */
export interface NavFrame {
  readonly screen: ScreenId;
  readonly params: Readonly<Record<string, string>>;
}

/** 导航状态：不可变栈 + 每页锚点（按屏幕 id 索引）。 */
export interface NavState {
  readonly stack: readonly NavFrame[];
  readonly anchors: Readonly<Record<string, ScrollAnchor>>;
}

export type NavigationErrorCode =
  | 'nav-depth-exceeded'
  | 'empty-nav-stack'
  | 'unknown-screen'
  | 'invalid-anchor'
  | 'invalid-params';

export class NavigationError extends Error {
  readonly code: NavigationErrorCode;
  readonly detail: readonly string[];
  constructor(code: NavigationErrorCode, message: string, detail: readonly string[] = []) {
    super(message);
    this.name = 'NavigationError';
    this.code = code;
    this.detail = detail;
  }
}

function cloneParams(params: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'string') {
      throw new NavigationError('invalid-params', `路由参数 ${key} 必须为字符串`, [key]);
    }
    out[key] = value;
  }
  return out;
}

function assertRegistered(screen: unknown): asserts screen is ScreenId {
  if (!isRegisteredScreen(screen)) {
    throw new NavigationError('unknown-screen', `未登记的屏幕 id: ${String(screen)}`, [String(screen)]);
  }
}

/** 创建导航栈：以 `root`（缺省 C01 对话主屏）为栈底，`root` 必为四入口根之一或已登记屏幕。 */
export function createNavState(root: ScreenId = 'C01', params: Readonly<Record<string, string>> = {}): NavState {
  assertRegistered(root);
  // 校验 root 确实有定义（screenDefOf 未登记即抛），并保证 route 语义稳定。
  screenDefOf(root);
  return { stack: [{ screen: root, params: cloneParams(params) }], anchors: {} };
}

export function depth(nav: NavState): number {
  return nav.stack.length;
}

/** 栈顶帧；空栈抛 `empty-nav-stack`（正常构造不会为空）。 */
export function currentFrame(nav: NavState): NavFrame {
  const top = nav.stack[nav.stack.length - 1];
  if (top === undefined) {
    throw new NavigationError('empty-nav-stack', '导航栈为空', []);
  }
  return top;
}

export function currentScreen(nav: NavState): ScreenId {
  return currentFrame(nav).screen;
}

/**
 * 压栈到新屏幕。超过 `NAV_DEPTH_LIMIT` 抛 `nav-depth-exceeded`；屏幕未登记抛 `unknown-screen`。
 * 浅拷贝参数，保证调用方对象不被别名修改。
 */
export function pushScreen(
  nav: NavState,
  screen: ScreenId,
  params: Readonly<Record<string, string>> = {},
): NavState {
  assertRegistered(screen);
  if (nav.stack.length >= NAV_DEPTH_LIMIT) {
    throw new NavigationError('nav-depth-exceeded', '返回栈超过深度上限', [
      String(nav.stack.length),
      String(NAV_DEPTH_LIMIT),
    ]);
  }
  return { stack: [...nav.stack, { screen, params: cloneParams(params) }], anchors: nav.anchors };
}

/** 替换栈顶（不改变深度）。空栈抛 `empty-nav-stack`。 */
export function replaceScreen(
  nav: NavState,
  screen: ScreenId,
  params: Readonly<Record<string, string>> = {},
): NavState {
  assertRegistered(screen);
  const top = nav.stack[nav.stack.length - 1];
  if (top === undefined) {
    throw new NavigationError('empty-nav-stack', '空栈无法替换栈顶', []);
  }
  return { stack: [...nav.stack.slice(0, -1), { screen, params: cloneParams(params) }], anchors: nav.anchors };
}

/** 出栈。根节点（长度 <= 1）pop 是 no-op（不下溢）。 */
export function popScreen(nav: NavState): NavState {
  if (nav.stack.length <= 1) return nav;
  return { stack: nav.stack.slice(0, -1), anchors: nav.anchors };
}

/**
 * 记录某页的滚动锚点（离开该页前调用）。`offsetPx` 必须为 >=0 的有限数，
 * `key` 必须非空——不编造位置、不静默夹取。
 */
export function setScrollAnchor(nav: NavState, screen: ScreenId, anchor: ScrollAnchor): NavState {
  assertRegistered(screen);
  if (typeof anchor.key !== 'string' || anchor.key.length === 0) {
    throw new NavigationError('invalid-anchor', '滚动锚点 key 不能为空', [String(anchor.key)]);
  }
  if (typeof anchor.offsetPx !== 'number' || !Number.isFinite(anchor.offsetPx) || anchor.offsetPx < 0) {
    throw new NavigationError('invalid-anchor', '滚动锚点 offsetPx 必须为 >=0 的有限数', [String(anchor.offsetPx)]);
  }
  return {
    stack: nav.stack,
    anchors: { ...nav.anchors, [screen]: { key: anchor.key, offsetPx: anchor.offsetPx } },
  };
}

/** 取某页的滚动锚点；未记录时返回 null（不编造位置）。 */
export function scrollAnchorOf(nav: NavState, screen: ScreenId): ScrollAnchor | null {
  const anchor = nav.anchors[screen];
  return anchor === undefined ? null : { key: anchor.key, offsetPx: anchor.offsetPx };
}

/** 清除某页锚点。 */
export function clearScrollAnchor(nav: NavState, screen: ScreenId): NavState {
  if (!(screen in nav.anchors)) return nav;
  const next: Record<string, ScrollAnchor> = { ...nav.anchors };
  delete next[screen];
  return { stack: nav.stack, anchors: next };
}

/** 当前栈顶页的滚动锚点（进入页面前恢复用）；未记录返回 null。 */
export function anchorForTop(nav: NavState): ScrollAnchor | null {
  return scrollAnchorOf(nav, currentScreen(nav));
}

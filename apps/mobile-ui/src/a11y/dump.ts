/**
 * F-I04 — Android 无障碍节点 dump → ScreenSpec 适配。
 *
 * 真机 `uiautomator` / `AccessibilityNodeInfo` 导出的是一次**像素坐标 + 类名 +
 * content-description** 的节点树：坐标是 px、没有语义角色、没有字号。本模块负责
 * 把这层平台数据归一化成 `screen-spec.ts` 的 `ViewNode`（dp + NodeRole + 读屏名称），
 * 再交给同一条 `viewTreeToScreenSpec()` 通道——**判定逻辑只有一份**，dump 路径不另起一套。
 *
 * 支持的 dump 形状（`boundsInScreen` 优先，其次 `bounds` 字符串）：
 *   - `boundsInScreen: { left, top, right, bottom }`（px）——AccessibilityNodeInfo JSON 常见形态
 *   - `bounds: "[x,y][x2,y2]"`（px，uiautomator XML 属性形态）
 *   根 dump 需带 `density`（每 dp 的 px 数）；缺 density 无法换算，显式报错而非猜。
 *
 * 语义映射规则（逐条可测）：
 *   - `clickable: true` ⇒ `interactive: true`
 *   - `className` ⇒ 角色（按钮 / 输入 / 列表 / 卡片 / 文本 / 容器…，见 `androidClassToRole`）
 *   - `heading: true` ⇒ 角色 `heading`（优先级高于类名）
 *   - 图片且无 `contentDescription`/`text` ⇒ `decorative-image`（读屏不重复朗读）
 *   - `contentDescription` 优先于 `text` 作为 `label`
 *
 * 边界：dump **不含字号**，因此默认不产出 `TextSpec`（200% 字号走查在 dump 路径上会跳过）。
 * 若调用方另行测得字号，可通过 `options.textDefaults` 显式注入，并在 README 标注那是调用方
 * 估值而非 dump 原值。本模块不连真机、不调 adb；真机 dump 采集与 on-device 验证不在本包范围。
 */

import {
  ScreenSpecBuildError,
  viewTreeToScreenSpec,
  type NodeRole,
  type OcclusionRect,
  type Rect,
  type ScreenSpec,
  type TextSpec,
  type ViewNode,
  type ViewTree,
  type ViewportSpec,
} from './screen-spec.js';

// ---------------------------------------------------------------------------
// dump 输入形状
// ---------------------------------------------------------------------------

/** AccessibilityNodeInfo 的 `boundsInScreen`（px）。 */
export interface AndroidBoundsInScreen {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** 一个 Android 无障碍节点（字段名对齐常见 dump JSON）。 */
export interface AndroidA11yNode {
  readonly className?: string;
  readonly text?: string;
  readonly contentDescription?: string;
  readonly viewIdResourceName?: string;
  /** uiautomator 形态："[x,y][x2,y2]"（px）。 */
  readonly bounds?: string;
  /** AccessibilityNodeInfo 形态（px）。 */
  readonly boundsInScreen?: AndroidBoundsInScreen;
  readonly clickable?: boolean;
  readonly enabled?: boolean;
  readonly focusable?: boolean;
  readonly heading?: boolean;
  readonly selected?: boolean;
  readonly children?: readonly AndroidA11yNode[];
}

/** 一棵 Android 无障碍 dump。 */
export interface AndroidA11yDump {
  /** 每 dp 的 px 数（`DisplayMetrics.density`）。 */
  readonly density: number;
  readonly screenWidthPx?: number;
  readonly screenHeightPx?: number;
  readonly root: AndroidA11yNode;
}

/** dump → ScreenSpec 的可选参数。 */
export interface AndroidDumpOptions {
  /** 屏幕 id；缺省 `android-dump`。 */
  readonly screenId?: string;
  /** 节点 id 前缀（避免与产品树撞 id）；缺省 `a11y`。 */
  readonly idPrefix?: string;
  readonly orientation?: 'portrait' | 'landscape';
  readonly fontScale?: number;
  readonly columns?: 1 | 2;
  readonly collapsesToSingleColumn?: boolean;
  /** 铰链 / 挖孔 / 手势区（dp）。 */
  readonly occlusions?: readonly OcclusionRect[];
  /**
   * 文本度量注入：dump 本身不含字号。提供时对带 `text` 的节点补 `TextSpec`
   * （`maxLines` 缺省 1、`allowTruncate` 缺省 false）；不提供则一律不产出 `TextSpec`。
   */
  readonly textDefaults?: {
    readonly fontSizeSp: number;
    readonly maxLines?: number;
    readonly allowTruncate?: boolean;
  };
}

// ---------------------------------------------------------------------------
// 类名 → 角色
// ---------------------------------------------------------------------------

/** 类名子串 → 节点角色（按序匹配，首个命中者胜）。 */
export const ANDROID_ROLE_MAP: readonly (readonly [RegExp, NodeRole])[] = [
  [/ImageButton|MaterialButton|AppCompatButton|Button/i, 'button'],
  [/EditText|AutoComplete|SearchView|SearchEditText/i, 'input'],
  [/MaterialCardView|CardView/i, 'card'],
  [/ImageView|AppCompatImageView/i, 'image'],
  [/RecyclerView|ListView|GridView|ViewPager/i, 'list'],
  [/Toolbar|AppBarLayout/i, 'header'],
  [/TextView|CheckBox|Switch|RadioButton|ToggleButton/i, 'text'],
  [/Dialog|PopupWindow|BottomSheet|DrawerLayout/i, 'overlay'],
  [/Layout|ViewGroup|View$/i, 'container'],
];

/** 把 Android 类名映射到节点角色；未知类名落到 `container`。 */
export function androidClassToRole(className: string | undefined): NodeRole {
  if (className === undefined || className.length === 0) return 'container';
  for (const [pattern, role] of ANDROID_ROLE_MAP) {
    if (pattern.test(className)) return role;
  }
  return 'container';
}

// ---------------------------------------------------------------------------
// 坐标换算
// ---------------------------------------------------------------------------

const BOUNDS_STR = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 解析 px 边界，返回 `{left, top, right, bottom}`；两种形态都不合法则抛错。 */
export function parseAndroidBoundsPx(node: AndroidA11yNode, path: string): AndroidBoundsInScreen {
  if (node !== null && typeof node === 'object' && node.boundsInScreen !== undefined) {
    const box = node.boundsInScreen;
    if (box === null || typeof box !== 'object') {
      throw new ScreenSpecBuildError('invalid-bounds', `${path}.boundsInScreen`, '期望 {left,top,right,bottom}');
    }
    const { left, top, right, bottom } = box;
    if (!isFiniteNumber(left) || !isFiniteNumber(top) || !isFiniteNumber(right) || !isFiniteNumber(bottom)) {
      throw new ScreenSpecBuildError(
        'invalid-bounds',
        `${path}.boundsInScreen`,
        `非有限坐标 ${String(left)},${String(top)},${String(right)},${String(bottom)}`,
      );
    }
    if (right <= left || bottom <= top) {
      throw new ScreenSpecBuildError(
        'invalid-bounds',
        `${path}.boundsInScreen`,
        `宽高必须为正，得到 ${right - left}×${bottom - top}`,
      );
    }
    return { left, top, right, bottom };
  }
  if (typeof node.bounds === 'string') {
    const m = BOUNDS_STR.exec(node.bounds.trim());
    if (m === null) {
      throw new ScreenSpecBuildError('invalid-bounds', `${path}.bounds`, `无法解析 "${node.bounds}"`);
    }
    const left = Number(m[1]);
    const top = Number(m[2]);
    const right = Number(m[3]);
    const bottom = Number(m[4]);
    if (right <= left || bottom <= top) {
      throw new ScreenSpecBuildError(
        'invalid-bounds',
        `${path}.bounds`,
        `宽高必须为正，得到 ${right - left}×${bottom - top}`,
      );
    }
    return { left, top, right, bottom };
  }
  throw new ScreenSpecBuildError('missing-bounds', path, '节点既无 boundsInScreen 也无 bounds');
}

/** px 边界 → dp 矩形（保留两位小数）。 */
export function pxToDpRect(px: AndroidBoundsInScreen, density: number, path: string): Rect {
  if (!isFiniteNumber(density) || density <= 0) {
    throw new ScreenSpecBuildError('invalid-density', `${path}.density`, `每 dp 的 px 数必须为正，得到 ${String(density)}`);
  }
  const round = (v: number): number => Math.round((v / density) * 100) / 100;
  return {
    x: round(px.left),
    y: round(px.top),
    w: round(px.right - px.left),
    h: round(px.bottom - px.top),
  };
}

// ---------------------------------------------------------------------------
// 节点映射
// ---------------------------------------------------------------------------

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return undefined;
}

interface BuildCtx {
  nextIndex: number;
  readonly usedIds: Set<string>;
  readonly prefix: string;
  readonly textDefaults: AndroidDumpOptions['textDefaults'];
}

function androidNodeToViewNode(node: AndroidA11yNode, density: number, path: string, ctx: BuildCtx): ViewNode {
  if (node === null || typeof node !== 'object') {
    throw new ScreenSpecBuildError('invalid-node', path, '期望节点对象');
  }
  const bounds = pxToDpRect(parseAndroidBoundsPx(node, path), density, path);

  let role = androidClassToRole(node.className);
  if (node.heading === true) role = 'heading';
  const label = firstNonEmpty(node.contentDescription, node.text);
  if ((role === 'image' || role === 'decorative-image') && label === undefined) role = 'decorative-image';

  // id：优先 viewIdResourceName 末段，否则顺序编号；去重。
  let base: string;
  if (typeof node.viewIdResourceName === 'string' && node.viewIdResourceName.length > 0) {
    const seg = node.viewIdResourceName.split('/').pop() ?? '';
    base = seg.length > 0 ? seg : 'node';
  } else {
    base = `node-${ctx.nextIndex}`;
  }
  ctx.nextIndex += 1;
  let id = `${ctx.prefix}-${base}`;
  let n = 2;
  while (ctx.usedIds.has(id)) {
    id = `${ctx.prefix}-${base}-${n}`;
    n += 1;
  }
  ctx.usedIds.add(id);

  const interactive = node.clickable === true;
  const text = firstNonEmpty(node.text);
  let textSpec: TextSpec | undefined;
  if (text !== undefined && ctx.textDefaults !== undefined) {
    textSpec = {
      text,
      fontSizeSp: ctx.textDefaults.fontSizeSp,
      maxLines: ctx.textDefaults.maxLines ?? 1,
      allowTruncate: ctx.textDefaults.allowTruncate ?? false,
    };
  }

  const children = (node.children ?? []).map((child, i) =>
    androidNodeToViewNode(child, density, `${path}.children[${i}]`, ctx),
  );

  const view: ViewNode = {
    id,
    role,
    bounds,
    ...(role !== 'decorative-image' && label !== undefined ? { label } : {}),
    ...(interactive ? { interactive: true } : {}),
    ...(node.enabled !== undefined ? { enabled: node.enabled === true } : {}),
    ...(node.focusable !== undefined ? { focusable: node.focusable === true } : {}),
    ...(textSpec !== undefined ? { text: textSpec } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
  return view;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/** 校验并归一化 dump 根对象。 */
export function assertAndroidDump(dump: AndroidA11yDump, path = 'dump'): AndroidA11yDump {
  if (dump === null || typeof dump !== 'object') {
    throw new ScreenSpecBuildError('invalid-dump', path, '期望 dump 对象');
  }
  if (!isFiniteNumber(dump.density) || dump.density <= 0) {
    throw new ScreenSpecBuildError('invalid-density', `${path}.density`, `每 dp 的 px 数必须为正，得到 ${String(dump.density)}`);
  }
  if (dump.root === null || typeof dump.root !== 'object') {
    throw new ScreenSpecBuildError('missing-root', `${path}.root`, 'dump 缺少根节点');
  }
  return dump;
}

function viewportFromDump(dump: AndroidA11yDump): ViewportSpec {
  const density = dump.density;
  let widthPx = dump.screenWidthPx;
  let heightPx = dump.screenHeightPx;
  if (!isFiniteNumber(widthPx) || !isFiniteNumber(heightPx)) {
    const box = parseAndroidBoundsPx(dump.root, 'dump.root');
    widthPx = isFiniteNumber(widthPx) ? widthPx : box.right;
    heightPx = isFiniteNumber(heightPx) ? heightPx : box.bottom;
  }
  const widthDp = Math.round((widthPx / density) * 100) / 100;
  const heightDp = Math.round((heightPx / density) * 100) / 100;
  return {
    widthDp,
    heightDp,
    orientation: widthDp >= heightDp ? 'landscape' : 'portrait',
    fontScale: 1,
    occlusions: [],
    columns: 1,
    collapsesToSingleColumn: true,
  };
}

/** dump → 渲染视图树（dp + 角色）。 */
export function androidDumpToViewTree(dump: AndroidA11yDump, options: AndroidDumpOptions = {}): ViewTree {
  const d = assertAndroidDump(dump);
  const ctx: BuildCtx = {
    nextIndex: 0,
    usedIds: new Set<string>(),
    prefix: options.idPrefix ?? 'a11y',
    textDefaults: options.textDefaults,
  };
  const root = androidNodeToViewNode(d.root, d.density, 'dump.root', ctx);
  return { id: options.screenId ?? 'android-dump', viewport: viewportFromDump(d), root };
}

/** dump → 可直接交给 F-R02 `parseScreenSpec()` / `auditScreen()` 的 ScreenSpec。 */
export function androidDumpToScreenSpec(dump: AndroidA11yDump, options: AndroidDumpOptions = {}): ScreenSpec {
  const d = assertAndroidDump(dump);
  const base = androidDumpToViewTree(d, options);
  const viewport: ViewportSpec = {
    ...base.viewport,
    ...(options.orientation !== undefined ? { orientation: options.orientation } : {}),
    ...(options.fontScale !== undefined ? { fontScale: options.fontScale } : {}),
    ...(options.columns !== undefined ? { columns: options.columns } : {}),
    ...(options.collapsesToSingleColumn !== undefined
      ? { collapsesToSingleColumn: options.collapsesToSingleColumn }
      : {}),
    ...(options.occlusions !== undefined ? { occlusions: options.occlusions } : {}),
  };
  return viewTreeToScreenSpec({ id: options.screenId ?? 'android-dump', viewport, root: base.root });
}

/** 从 JSON 文本解析并转换；非法 JSON 抛 `invalid-json`。 */
export function androidDumpJsonToScreenSpec(json: string, options: AndroidDumpOptions = {}): ScreenSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new ScreenSpecBuildError('invalid-json', 'dump', `JSON 解析失败：${(err as Error).message}`);
  }
  return androidDumpToScreenSpec(assertAndroidDump(parsed as AndroidA11yDump), options);
}

/**
 * F01 foundation —— 最小布局壳（纯函数、零依赖）。
 *
 * 只产出**可断言的结构描述**（header / main / tabbar），不渲染、不引框架、
 * 不产生副作用。真实渲染（DOM、Android View、软键盘避让）留给后续包。
 *
 * 结构依据 design-07：
 *   - §2 行 36：四入口文字导航；正式 App 用底部导航，内联原型按文档流。
 *   - §4 行 112：首页顶部保留小尺寸黑白火锅图标与 potbot 标识、轻量新建入口。
 *   - §4 行 117：输入区固定在键盘上方（app）/ 内容底部（inline）。
 *   - §12 行 255：紧凑单栏＋底部导航；中等导航栏＋单主区；展开导航栏＋双栏。
 */

import {
  breakpoints,
  brand,
  entries,
  type Breakpoint,
  type EntryId,
  type ShellMode,
} from './tokens.js';

/** 缺省选中入口：第一个主入口（design-07 §2 行 36 顺序固定的「对话」）。 */
export const DEFAULT_ENTRY: EntryId = 'chat';

/** 布局区域标识。 */
export type RegionId = 'header' | 'main' | 'tabbar';

export interface HeaderRegion {
  readonly id: 'header';
  /** 品牌素材路径（设计指定引用原图，不重绘）。 */
  readonly brandAsset: string;
  readonly preserveBrandAspect: boolean;
  /** 应用标识文字。 */
  readonly title: string;
  /** 轻量新建入口存在（design-07 §4 行 112）。 */
  readonly newEntry: boolean;
}

export interface MainRegion {
  readonly id: 'main';
  /** 由断点决定的列数。 */
  readonly columns: 1 | 2;
}

export interface TabBarItem {
  readonly id: EntryId;
  readonly label: string;
  readonly selected: boolean;
}

export interface TabBarRegion {
  readonly id: 'tabbar';
  readonly items: readonly TabBarItem[];
  /** 选中态：细橙色下划线（非整块橙底，非粗线）。 */
  readonly indicator: 'underline';
  /** 是否固定在物理屏幕底部；内联原型为 false。 */
  readonly fixed: boolean;
}

export interface LayoutShell {
  readonly mode: ShellMode;
  readonly breakpoint: Breakpoint['id'];
  readonly layout: Breakpoint['layout'];
  /** 输入区相对键盘/内容的定位约束。 */
  readonly inputPlacement: 'above-keyboard-fixed' | 'document-flow-bottom';
  readonly header: HeaderRegion;
  readonly main: MainRegion;
  /** 紧凑窗口用底部导航；更宽窗口导航移出底部 ⇒ 无 tabbar 区域。 */
  readonly tabbar: TabBarRegion | null;
  /** 区域顺序，便于渲染层按序挂载。 */
  readonly order: readonly RegionId[];
}

export interface LayoutShellOptions {
  /** 当前选中的主入口；缺省取第一个（对话）。 */
  readonly activeEntry?: EntryId;
  /** 视口宽度（dp）；缺省按紧凑手机处理。 */
  readonly widthDp?: number;
  /** 运行模式；缺省 `inline`（原型/文档流，非真机承诺）。 */
  readonly mode?: ShellMode;
}

/** 应用标识文字（design-07 §0 行 11 / §4 行 112：保留 potbot 标识）。 */
export const APP_TITLE = 'potbot';

/** 按视口宽度选择断点；宽度缺失/非法时退回紧凑。 */
export function resolveBreakpoint(widthDp: number | undefined): Breakpoint {
  const compact = breakpoints[0];
  if (compact === undefined) throw new Error('breakpoints 令牌缺失');
  if (typeof widthDp !== 'number' || !Number.isFinite(widthDp)) return compact;
  for (const bp of breakpoints) {
    if (widthDp >= bp.minDp && (bp.maxDp === null || widthDp < bp.maxDp)) return bp;
  }
  const last = breakpoints[breakpoints.length - 1];
  return last ?? compact;
}

/**
 * 生成布局壳描述。纯函数：同参数同结果，无副作用。
 *
 * 底部导航只在紧凑窗口出现（design-07 §12 行 255：紧凑窗口采用单栏和底部导航；
 * 中等/展开窗口改用导航栏）。因此 `tabbar` 在 medium/expanded 下为 `null`。
 */
export function layoutShell(options: LayoutShellOptions = {}): LayoutShell {
  const mode: ShellMode = options.mode ?? 'inline';
  const activeEntry: EntryId = options.activeEntry ?? DEFAULT_ENTRY;
  const bp = resolveBreakpoint(options.widthDp);

  const items: readonly TabBarItem[] = entries.map((entry) => ({
    id: entry.id,
    label: entry.label,
    selected: entry.id === activeEntry,
  }));

  const tabbarVisible = bp.id === 'compact';

  return {
    mode,
    breakpoint: bp.id,
    layout: bp.layout,
    inputPlacement: mode === 'app' ? 'above-keyboard-fixed' : 'document-flow-bottom',
    header: {
      id: 'header',
      brandAsset: brand.assetPath,
      preserveBrandAspect: brand.preserveAspect,
      title: APP_TITLE,
      newEntry: true,
    },
    main: {
      id: 'main',
      columns: bp.layout === 'nav-rail-plus-list-detail' ? 2 : 1,
    },
    tabbar: tabbarVisible
      ? { id: 'tabbar', items, indicator: 'underline', fixed: mode === 'app' }
      : null,
    order: tabbarVisible ? ['header', 'main', 'tabbar'] : ['header', 'main'],
  };
}

/**
 * F01 foundation —— 主题快照（consumer-facing theme projection）。
 *
 * `tokens.ts` 是**唯一来源**（带出处/缺口）；本模块把它投影成一个**扁平、可序列化、
 * 深冻结**的对象，供渲染适配层（DOM / Android View）与 CSS 生成器单点消费，避免各页面
 * 各自从 tokens 里挑值、各自编造。
 *
 * 同时给出**品牌素材描述符**：设计指定引用原图 `brand-user.png`、保持比例、不重绘
 * （design-07 §3 行 76）。`PNG_SIGNATURE` 供测试做真实文件魔数核验（属测试侧 IO，
 * 本模块保持零 IO）。
 */

import {
  brand,
  breakpoints,
  colors,
  entries,
  entrySelection,
  motion,
  radius,
  spacing,
  theme,
  touch,
  typography,
  TEMPLATE_LABEL,
  type ColorTokenName,
} from './tokens.js';

/** PNG 文件魔数（8 字节）。测试据此核验品牌原图确为 PNG。 */
export const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 品牌素材描述符：设计指定引用原图，不重绘、不内联 SVG、保持比例。 */
export const brandAsset = {
  /** 相对仓库根的路径。 */
  path: brand.assetPath,
  mimeType: 'image/png',
  preserveAspect: brand.preserveAspect,
  allowRedraw: brand.allowRedraw,
  /** 设计未写死渲染尺寸。 */
  renderSize: brand.renderSize,
  /** 期望的 PNG 魔数（供外部做真实核验）。 */
  pngSignature: PNG_SIGNATURE,
} as const;

/** 主题快照：扁平、可 JSON 序列化、无函数、无循环引用。 */
export interface ThemeSnapshot {
  readonly colorScheme: 'light-only';
  readonly elevation: 'none';
  readonly colors: Readonly<Record<ColorTokenName, string>>;
  readonly typeScale: Readonly<Record<string, { readonly sizeSp: number; readonly lineHeightDp: number }>>;
  readonly weights: {
    readonly title: number;
    readonly body: number;
    readonly buttonMin: number;
    readonly buttonMax: number;
  };
  readonly spacing: {
    readonly baseDp: number;
    readonly commonDp: readonly number[];
    readonly pageInlineDp: number;
    readonly pageInlineNarrowDp: number;
  };
  readonly touch: { readonly minTargetDp: number; readonly prototypeApproxPx: number };
  readonly radius: {
    readonly controlDp: number;
    readonly cardMinDp: number;
    readonly cardMaxDp: number;
  };
  readonly motion: {
    readonly durationMinMs: number;
    readonly durationMaxMs: number;
    readonly respectReducedMotion: boolean;
  };
  readonly breakpoints: readonly {
    readonly id: string;
    readonly minDp: number;
    readonly maxDp: number | null;
    readonly layout: string;
  }[];
  readonly entries: readonly { readonly id: string; readonly label: string; readonly pagePrefix: string }[];
  readonly entrySelection: {
    readonly indicator: 'underline';
    readonly color: string;
    readonly weight: 'fine';
  };
  readonly brand: {
    readonly assetPath: string;
    readonly preserveAspect: boolean;
    readonly allowRedraw: boolean;
  };
  readonly templateLabel: string;
}

/** 构造主题快照（纯函数）。 */
export function themeSnapshot(): ThemeSnapshot {
  const colorMap = Object.fromEntries(
    Object.entries(colors).map(([name, token]) => [name, token.value]),
  ) as Record<ColorTokenName, string>;

  const scale = Object.fromEntries(
    Object.entries(typography.scale).map(([name, entry]) => [
      name,
      { sizeSp: entry.sizeSp, lineHeightDp: entry.lineHeightDp },
    ]),
  );

  const weightTheme = typography.weights;

  return {
    colorScheme: theme.colorScheme,
    elevation: theme.elevation,
    colors: colorMap,
    typeScale: scale,
    weights: {
      title: weightTheme.title,
      body: weightTheme.body,
      buttonMin: weightTheme.buttonMin,
      buttonMax: weightTheme.buttonMax,
    },
    spacing: {
      baseDp: spacing.baseDp,
      commonDp: [...spacing.commonDp],
      pageInlineDp: spacing.pageInlineDp,
      pageInlineNarrowDp: spacing.pageInlineNarrowDp,
    },
    touch: { minTargetDp: touch.minTargetDp, prototypeApproxPx: touch.prototypeApproxPx },
    radius: {
      controlDp: radius.controlDp,
      cardMinDp: radius.cardMinDp,
      cardMaxDp: radius.cardMaxDp,
    },
    motion: {
      durationMinMs: motion.durationMinMs,
      durationMaxMs: motion.durationMaxMs,
      respectReducedMotion: motion.respectReducedMotion,
    },
    breakpoints: breakpoints.map((b) => ({ id: b.id, minDp: b.minDp, maxDp: b.maxDp, layout: b.layout })),
    entries: entries.map((e) => ({ id: e.id, label: e.label, pagePrefix: e.pagePrefix })),
    entrySelection: {
      indicator: entrySelection.indicator,
      color: entrySelection.color,
      weight: entrySelection.weight,
    },
    brand: {
      assetPath: brand.assetPath,
      preserveAspect: brand.preserveAspect,
      allowRedraw: brand.allowRedraw,
    },
    templateLabel: TEMPLATE_LABEL,
  };
}

/** 深冻结：快照不得被宿主渲染层就地改写。 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** 冻结的主题快照。 */
export function frozenThemeSnapshot(): ThemeSnapshot {
  return deepFreeze(themeSnapshot());
}

/**
 * 生成颜色 CSS 变量投影（`--pb-color-<name>`）。
 * 与 `apps/mobile-ui/foundation.css` 的手写投影对齐，由测试比对，防两端漂移。
 */
export function colorCssVariables(): Readonly<Record<string, string>> {
  const vars: Record<string, string> = {};
  for (const [name, token] of Object.entries(colors)) {
    vars[`--pb-color-${name}`] = token.value;
  }
  return vars;
}

// ---------------------------------------------------------------------------
// CSS 变量投影（single token source → CSS custom properties）
// ---------------------------------------------------------------------------
//
// 壳与各模块**只**从 `themeSnapshot()` / `listControls()` 取值，再由这里投影成 CSS
// 自定义属性；`apps/mobile-ui/foundation.css` 是同一投影的落盘副本，由
// `tests/mobile-ui/F01/css-projection.test.ts` 逐变量字节比对，防止两端各写一套。
//
// 设计未写死的值（字体族串、下划线粗细、卡片圆角单值、过渡单值）**不投影**——
// 不为了"看着完整"补一个编造值。

/** 投影参数。 */
export interface ThemeCssOptions {
  /**
   * 系统字体缩放（Android `fontScale`）；缺省 1（100%）。
   * **只**缩放字号/行高，不动颜色/间距/触区/圆角/动效——触区不随字体缩放而变形。
   */
  readonly fontScale?: number;
}

/** 投影/序列化相关的结构化错误。 */
export class ThemeCssError extends Error {
  readonly code: 'invalid-font-scale';
  constructor(code: 'invalid-font-scale', message: string) {
    super(message);
    this.name = 'ThemeCssError';
    this.code = code;
  }
}

/** 字体缩放必须为正有限数；非法即抛错，不静默回落（避免把坏输入当成 1×）。 */
export function assertFontScale(fontScale: number): void {
  if (typeof fontScale !== 'number' || !Number.isFinite(fontScale) || fontScale <= 0) {
    throw new ThemeCssError('invalid-font-scale', `fontScale 必须为正有限数，收到 ${String(fontScale)}`);
  }
}

/**
 * 数值 → CSS 数字串：最多保留 3 位小数并去掉尾零。
 * 确定性、无本地化，供字节级比对（`1.3 × 16 = 20.8` ⇒ `"20.8"`，不是 `"20.800000000000001"`）。
 */
export function formatCssNumber(value: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ThemeCssError('invalid-font-scale', `非有限数不能投影为 CSS 数字: ${String(value)}`);
  }
  return String(Math.round(value * 1000) / 1000);
}

/**
 * 在给定字体缩放下投影字号阶梯。行高与字号**同比**缩放，保持行高/字号比，
 * 不把行高单独压扁（design-07 §12 行 249：200% 字号下正文不截断）。
 */
export function typeScaleAt(
  fontScale = 1,
): Readonly<Record<string, { readonly sizeSp: number; readonly lineHeightDp: number }>> {
  assertFontScale(fontScale);
  const base = themeSnapshot().typeScale;
  const out: Record<string, { sizeSp: number; lineHeightDp: number }> = {};
  for (const [name, entry] of Object.entries(base)) {
    out[name] = { sizeSp: entry.sizeSp * fontScale, lineHeightDp: entry.lineHeightDp * fontScale };
  }
  return out;
}

/**
 * 把主题快照投影成 CSS 自定义属性表（键含 `--` 前缀）。
 * 与 `apps/mobile-ui/foundation.css` 的 `:root` 块一一对应；缺省 `fontScale === 1`
 * 时两者必须逐字节相等（由 css-projection.test.ts 断言）。
 */
export function themeCssVariables(options: ThemeCssOptions = {}): Readonly<Record<string, string>> {
  const fontScale = options.fontScale ?? 1;
  assertFontScale(fontScale);
  const snap = themeSnapshot();
  const vars: Record<string, string> = {};

  // 颜色（14）——与 colorCssVariables() 同源。
  for (const [name, value] of Object.entries(snap.colors)) {
    vars[`--pb-color-${name}`] = value;
  }
  // 主题层级（design-07 §3 行 107：不使用阴影）。
  vars['--pb-elevation'] = snap.elevation;

  // 字号与行高（design-07 §3 行 102）。
  for (const [name, entry] of Object.entries(typeScaleAt(fontScale))) {
    vars[`--pb-font-${name}-size`] = `${formatCssNumber(entry.sizeSp)}sp`;
    vars[`--pb-font-${name}-line`] = `${formatCssNumber(entry.lineHeightDp)}dp`;
  }

  // 字重（design-07 §3 行 103）。
  vars['--pb-weight-title'] = String(snap.weights.title);
  vars['--pb-weight-body'] = String(snap.weights.body);
  vars['--pb-weight-button-min'] = String(snap.weights.buttonMin);
  vars['--pb-weight-button-max'] = String(snap.weights.buttonMax);

  // 间距（design-07 §3 行 104）。
  vars['--pb-space-base'] = `${formatCssNumber(snap.spacing.baseDp)}dp`;
  vars['--pb-space-page-inline'] = `${formatCssNumber(snap.spacing.pageInlineDp)}dp`;
  vars['--pb-space-page-inline-narrow'] = `${formatCssNumber(snap.spacing.pageInlineNarrowDp)}dp`;

  // 触区（design-07 §3 行 105）。
  vars['--pb-touch-min-target'] = `${formatCssNumber(snap.touch.minTargetDp)}dp`;

  // 圆角（design-07 §3 行 106）。
  vars['--pb-radius-control'] = `${formatCssNumber(snap.radius.controlDp)}dp`;
  vars['--pb-radius-card-min'] = `${formatCssNumber(snap.radius.cardMinDp)}dp`;
  vars['--pb-radius-card-max'] = `${formatCssNumber(snap.radius.cardMaxDp)}dp`;

  // 动效（design-07 §3 行 108）。
  vars['--pb-motion-duration-min'] = `${formatCssNumber(snap.motion.durationMinMs)}ms`;
  vars['--pb-motion-duration-max'] = `${formatCssNumber(snap.motion.durationMaxMs)}ms`;

  // 入口选中态颜色（design-07 §2 行 36）——粗细设计未定，故不投影。
  vars['--pb-entry-indicator-color'] = snap.entrySelection.color;

  return vars;
}

/**
 * 确定性序列化：按变量名排序，产出 `  --name: value;` 行（LF 连接）。
 * 供字节级比对与写回 CSS；同一输入恒得同一输出。
 */
export function renderCssVariables(vars: Readonly<Record<string, string>>): string {
  return Object.keys(vars)
    .sort()
    .map((name) => `  ${name}: ${vars[name]};`)
    .join('\n');
}

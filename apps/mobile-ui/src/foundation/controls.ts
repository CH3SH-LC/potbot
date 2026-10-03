/**
 * F01 foundation —— 基础控件规格（base controls）。
 *
 * 本模块补齐 `tokens.ts`（值）与 `layout.ts`（壳）之间缺失的一层：**控件**。
 * 它只导出纯数据与纯函数，零依赖、不渲染、不引框架，不产生副作用。
 *
 * 每个控件的每一项约束都带 `origin`（可回溯到 design-07 原文行号）；设计没写死的
 * 地方显式记 `unresolved`，**不为了"看着完整"编造数值**。取值来源：
 *   - design-07 §3「视觉方向与设计 Token」行 76 / 78 / 82–108
 *   - design-07 §2「四个主入口」行 36
 *   - design-07 §4「对话、会话与输入」行 117
 *   - design-07 §9「组件与状态合同」行 197–206
 *   - design-07 §12「可访问性与 Android 行为」行 249–257
 *
 * 一致性由 `tests/mobile-ui/F01/controls.test.ts` 断言；色值/尺寸仍以
 * `tokens.ts` 为唯一来源（本模块只 `import`，不重复定义）。
 */

import {
  colors,
  entrySelection,
  radius,
  spacing,
  theme,
  touch,
  typography,
  type ColorTokenName,
  type DesignRef,
} from './tokens.js';
import { assertFontScale, formatCssNumber } from './theme.js';

const DESIGN_07 = 'docs/design/design-07-正式发布版App界面与交互.md';
const ref = (line: number): DesignRef => ({ doc: DESIGN_07, line });

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 基础控件标识。 */
export type ControlId =
  | 'primary-button'
  | 'icon-button'
  | 'text-entry'
  | 'text-input'
  | 'card'
  | 'list-row'
  | 'status-chip';

/** 控件种类（渲染层据此选择宿主元素语义）。 */
export type ControlKind = 'button' | 'navigation' | 'input' | 'container' | 'row' | 'badge';

/**
 * 交互态（基础控件层）。design-07 §9 行 197–206 给的是**业务对象**状态
 * （消息/任务/文件…），由各业务包消费；基础控件只固定通用交互态。
 */
export type InteractionState = 'default' | 'pressed' | 'focused' | 'disabled' | 'busy' | 'selected' | 'error';

/**
 * 状态色调。design-07 §9 行 200「动作」区分未知/失败等；§3 行 93/94 给出
 * success/danger 语义。色调到颜色的映射见 `toneTheme()`。
 */
export type ControlTone = 'neutral' | 'accent' | 'success' | 'danger' | 'unknown';

/** 字号角色，必须是 `typography.scale` 的键。 */
export type TypeScaleName = keyof typeof typography.scale;

/** 控件的颜色角色引用（`null` = 该面不使用颜色）。 */
export interface ControlColors {
  readonly background: ColorTokenName | null;
  readonly foreground: ColorTokenName | null;
  readonly border: ColorTokenName | null;
}

export interface ControlSpec {
  readonly id: ControlId;
  readonly kind: ControlKind;
  /** 是否可交互（可聚焦、需触区）。 */
  readonly interactive: boolean;
  /** 有效触区最小边（dp）；非交互控件为 0。 */
  readonly minTouchDp: number;
  /** 圆角（dp）；`range` 表示设计给的是区间。 */
  readonly radiusDp: number | 'range';
  /** 圆角区间（仅 `radiusDp === 'range'` 时给出）。 */
  readonly radiusRangeDp?: readonly [number, number];
  readonly type: TypeScaleName;
  readonly weight: { readonly min: number; readonly max: number };
  readonly colors: ControlColors;
  /** 层级：design-07 §3 行 107「不使用阴影」——恒为 `none`。 */
  readonly elevation: 'none';
  readonly states: readonly InteractionState[];
  /**
   * 是否**必须**由调用方提供可访问名称。design-07 §3 行 76（功能性图标需无障碍名称）
   * 与 §12 行 251（按钮名称不能只有「查看」「确定」而无所属对象）。
   */
  readonly requiresAccessibleLabel: boolean;
  readonly origin: DesignRef;
}

/** `resolveControlTheme()` 的产物：可直接喂给渲染层的具体值。 */
export interface ResolvedControlTheme {
  readonly id: ControlId;
  readonly kind: ControlKind;
  readonly interactive: boolean;
  readonly minTouchDp: number;
  readonly radiusDp: number | 'range';
  readonly fontSizeSp: number;
  readonly lineHeightDp: number;
  readonly fontWeight: { readonly min: number; readonly max: number };
  readonly background: string | null;
  readonly foreground: string | null;
  readonly border: string | null;
  readonly elevation: 'none';
  readonly states: readonly InteractionState[];
  readonly requiresAccessibleLabel: boolean;
  readonly origin: DesignRef;
}

/** 结构化错误。测试按 `code` 断言，不匹配文案。 */
export type ControlErrorCode =
  | 'unknown-control'
  | 'invalid-control-spec'
  | 'missing-accessible-name'
  | 'invalid-tone';

export class ControlError extends Error {
  readonly code: ControlErrorCode;
  readonly detail: readonly string[];
  constructor(code: ControlErrorCode, message: string, detail: readonly string[] = []) {
    super(message);
    this.name = 'ControlError';
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// 控件表
// ---------------------------------------------------------------------------

/**
 * 基础控件规格表（唯一来源）。
 *
 * 只收录 design-07 明确要求存在的基础控件；不发明设计里没有的控件。
 * 触区依据 §3 行 105「正式产品按钮与图标的有效触区至少 48×48dp」；
 * 圆角依据 §3 行 106；无阴影依据 §3 行 107；字号/字重依据 §3 行 102/103。
 */
export const controls: readonly ControlSpec[] = [
  {
    id: 'primary-button',
    kind: 'button',
    interactive: true,
    minTouchDp: touch.minTargetDp,
    radiusDp: radius.controlDp,
    type: 'button',
    weight: { min: typography.weights.buttonMin, max: typography.weights.buttonMax },
    colors: { background: 'action-primary', foreground: 'action-foreground', border: null },
    elevation: 'none',
    states: ['default', 'pressed', 'focused', 'disabled', 'busy'],
    requiresAccessibleLabel: false,
    origin: ref(83),
  },
  {
    id: 'icon-button',
    kind: 'button',
    interactive: true,
    minTouchDp: touch.minTargetDp,
    radiusDp: radius.controlDp,
    type: 'button',
    weight: { min: typography.weights.buttonMin, max: typography.weights.buttonMax },
    colors: { background: null, foreground: 'text-primary', border: null },
    elevation: 'none',
    states: ['default', 'pressed', 'focused', 'disabled', 'busy'],
    // 仅返回/附件/发送这类功能性图标保留；必须有无障碍名称（§3 行 76、§12 行 251）。
    requiresAccessibleLabel: true,
    origin: ref(76),
  },
  {
    id: 'text-entry',
    kind: 'navigation',
    interactive: true,
    minTouchDp: touch.minTargetDp,
    radiusDp: 0,
    type: 'button',
    weight: { min: typography.weights.body, max: typography.weights.title },
    colors: { background: null, foreground: 'text-primary', border: null },
    elevation: 'none',
    // 选中态为细橙色下划线（非整块橙底）；见 entrySelection（§2 行 36）。
    states: ['default', 'pressed', 'focused', 'disabled', 'selected'],
    requiresAccessibleLabel: false,
    origin: ref(36),
  },
  {
    id: 'text-input',
    kind: 'input',
    interactive: true,
    minTouchDp: touch.minTargetDp,
    radiusDp: radius.controlDp,
    type: 'body',
    weight: { min: typography.weights.body, max: typography.weights.body },
    colors: { background: 'input', foreground: 'text-primary', border: 'outline' },
    elevation: 'none',
    states: ['default', 'focused', 'disabled', 'error'],
    // placeholder 不是标签；输入控件须有可访问名称。
    requiresAccessibleLabel: true,
    origin: ref(87),
  },
  {
    id: 'card',
    kind: 'container',
    interactive: false,
    minTouchDp: 0,
    radiusDp: 'range',
    radiusRangeDp: [radius.cardMinDp, radius.cardMaxDp],
    type: 'body',
    weight: { min: typography.weights.body, max: typography.weights.title },
    colors: { background: 'surface', foreground: 'text-primary', border: 'outline' },
    elevation: 'none',
    states: ['default'],
    requiresAccessibleLabel: false,
    origin: ref(106),
  },
  {
    id: 'list-row',
    kind: 'row',
    interactive: true,
    minTouchDp: touch.minTargetDp,
    radiusDp: 0,
    type: 'body',
    weight: { min: typography.weights.body, max: typography.weights.body },
    // §3 行 107：普通列表以间距、文字和细分隔组织，不用卡片阴影。
    colors: { background: 'surface', foreground: 'text-primary', border: 'outline' },
    elevation: 'none',
    states: ['default', 'pressed', 'focused', 'disabled', 'selected'],
    requiresAccessibleLabel: false,
    origin: ref(107),
  },
  {
    id: 'status-chip',
    kind: 'badge',
    interactive: false,
    minTouchDp: 0,
    // §3 行 106：避免连续堆叠胶囊 ⇒ 用控件圆角 12dp，不用全圆 pill。
    radiusDp: radius.controlDp,
    type: 'annotation-minor',
    weight: { min: typography.weights.buttonMin, max: typography.weights.buttonMax },
    colors: { background: 'accent-surface', foreground: 'accent-text', border: null },
    elevation: 'none',
    states: ['default'],
    requiresAccessibleLabel: false,
    origin: ref(93),
  },
];

const byId: ReadonlyMap<ControlId, ControlSpec> = new Map(controls.map((c) => [c.id, c]));

/**
 * 焦点环：键盘焦点至少 2dp，且不能被卡片/浮层裁剪。
 * 出处：design-07 §3 行 95；§12 行 251（浮层圈定焦点、关闭回到触发控件）。
 */
export const focusRing = {
  minWidthDp: 2,
  color: colors['focus-ring'].value,
  mustNotBeClipped: true,
  origin: ref(95),
} as const;

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/** 全部基础控件（只读快照副本，防外部改写）。 */
export function listControls(): readonly ControlSpec[] {
  return controls.map((c) => ({ ...c }));
}

/** 按 id 取控件；未登记 ⇒ 抛 `unknown-control`。 */
export function getControl(id: ControlId): ControlSpec {
  const found = byId.get(id);
  if (found === undefined) {
    throw new ControlError('unknown-control', `未登记的基础控件: ${String(id)}`, [String(id)]);
  }
  return { ...found };
}

/**
 * 色调 → 颜色角色。
 * accent 用轻强调面（§3 行 91/92）；success/danger 只用对应文字色
 * （§3 行 93/94，state 始终有文字）；unknown 走次要文字色，不伪装确定。
 */
export function toneTheme(tone: ControlTone): ControlColors {
  switch (tone) {
    case 'neutral':
      return { background: 'surface', foreground: 'text-secondary', border: 'outline' };
    case 'accent':
      return { background: 'accent-surface', foreground: 'accent-text', border: null };
    case 'success':
      return { background: 'surface', foreground: 'success', border: 'outline' };
    case 'danger':
      return { background: 'surface', foreground: 'danger', border: 'outline' };
    case 'unknown':
      return { background: 'surface', foreground: 'text-secondary', border: 'outline' };
    default: {
      const never: never = tone;
      throw new ControlError('invalid-tone', `未知色调: ${String(never)}`, [String(never)]);
    }
  }
}

/** 把颜色角色解析为具体十六进制；`null` 原样返回。 */
function resolveColor(role: ColorTokenName | null): string | null {
  return role === null ? null : colors[role].value;
}

/** 解析单个控件为可渲染的具体主题值。 */
export function resolveControlTheme(spec: ControlSpec): ResolvedControlTheme {
  const scale = typography.scale[spec.type];
  return {
    id: spec.id,
    kind: spec.kind,
    interactive: spec.interactive,
    minTouchDp: spec.minTouchDp,
    radiusDp: spec.radiusDp,
    fontSizeSp: scale.sizeSp,
    lineHeightDp: scale.lineHeightDp,
    fontWeight: { min: spec.weight.min, max: spec.weight.max },
    background: resolveColor(spec.colors.background),
    foreground: resolveColor(spec.colors.foreground),
    border: resolveColor(spec.colors.border),
    elevation: spec.elevation,
    states: spec.states,
    requiresAccessibleLabel: spec.requiresAccessibleLabel,
    origin: spec.origin,
  };
}

/**
 * 校验一个控件规格，返回**问题列表**（空数组 = 通过）。
 * 规则全部可回溯到 design-07，不做无依据的判定：
 *   - 触区：交互控件 ≥ `touch.minTargetDp`（§3 行 105）
 *   - 字号：`type` 必须在 `typography.scale` 内（§3 行 102）
 *   - 颜色：引用的角色必须在 `colors` 内，防凭空定色（§3 行 82–95）
 *   - 层级：恒为 `none`（§3 行 107）
 *   - 状态：非空且含 `default`；交互控件须含 `focused`（§12 行 251、§3 行 95）
 *   - 可访问名称：`icon-button` 必须要求名称（§3 行 76 / §12 行 251）
 *   - 圆角：`range` 必须带合法的 `radiusRangeDp`
 */
export function validateControlSpec(spec: ControlSpec): readonly string[] {
  const problems: string[] = [];
  const scaleNames = Object.keys(typography.scale);
  if (!scaleNames.includes(spec.type)) {
    problems.push(`${spec.id}: 字号角色 "${String(spec.type)}" 不在 typography.scale 内`);
  }
  if (spec.interactive && spec.minTouchDp < touch.minTargetDp) {
    problems.push(`${spec.id}: 交互控件触区 ${spec.minTouchDp}dp < ${touch.minTargetDp}dp`);
  }
  for (const role of [spec.colors.background, spec.colors.foreground, spec.colors.border]) {
    if (role !== null && !(role in colors)) {
      problems.push(`${spec.id}: 颜色角色 "${String(role)}" 未在 tokens.colors 登记`);
    }
  }
  if (spec.elevation !== 'none') {
    problems.push(`${spec.id}: elevation 必须为 "none"（设计不使用阴影）`);
  }
  if (spec.states.length === 0) {
    problems.push(`${spec.id}: states 为空`);
  } else if (!spec.states.includes('default')) {
    problems.push(`${spec.id}: states 缺少 "default"`);
  }
  if (spec.interactive && !spec.states.includes('focused')) {
    problems.push(`${spec.id}: 交互控件 states 缺少 "focused"`);
  }
  if (spec.id === 'icon-button' && !spec.requiresAccessibleLabel) {
    problems.push(`${spec.id}: 功能性图标控件必须要求可访问名称`);
  }
  if (spec.radiusDp === 'range') {
    const r = spec.radiusRangeDp;
    if (r === undefined || r.length !== 2 || !(r[0] <= r[1])) {
      problems.push(`${spec.id}: radiusDp="range" 必须给出有序的 radiusRangeDp`);
    }
  }
  return problems;
}

/** 校验失败即抛 `invalid-control-spec`，附全部问题。 */
export function assertControlSpec(spec: ControlSpec): void {
  const problems = validateControlSpec(spec);
  if (problems.length > 0) {
    throw new ControlError('invalid-control-spec', `${spec.id} 规格非法`, problems);
  }
}

/**
 * 断言调用方为「需要可访问名称」的控件提供了名称。
 * 空白串不算名称（§12 行 251：名称不能只有「查看」「确定」而无所属对象）。
 */
export function assertAccessibleName(spec: ControlSpec, name: string | undefined): void {
  if (!spec.requiresAccessibleLabel) return;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new ControlError('missing-accessible-name', `${spec.id} 缺少可访问名称`, [spec.id]);
  }
}

/** 汇总导出。 */
export const controlTokens = {
  controls,
  focusRing,
  entryIndicator: entrySelection,
  spacing,
  theme,
} as const;

// ---------------------------------------------------------------------------
// 控件 CSS 变量投影（listControls() → CSS custom properties）
// ---------------------------------------------------------------------------

/** 控件 CSS 投影参数。 */
export interface ControlsCssOptions {
  /** 系统字体缩放；缺省 1（100%）。只缩放字号/行高，触区与圆角不随之变化。 */
  readonly fontScale?: number;
}

/**
 * 把基础控件规格投影成 CSS 自定义属性表（键含 `--` 前缀），命名：
 *   `--pb-control-<id>-{min-touch|radius|radius-min|radius-max|font-size|line-height|
 *                       font-weight-min|font-weight-max|background|foreground|border}`
 *
 * 全部数值经 `resolveControlTheme()`（唯一解析路径）取得，**不重写色值**；
 * 颜色角色为 `null` 的面**不生成**对应变量（不伪造 `transparent`）。
 * 区间圆角（如 `card`）投影为 `-radius-min` / `-radius-max`，单值圆角投影为 `-radius`。
 *
 * 与 `apps/mobile-ui/foundation.css` 的控件段逐字节对应，由 css-projection.test.ts 断言。
 */
export function controlsCssVariables(options: ControlsCssOptions = {}): Readonly<Record<string, string>> {
  const fontScale = options.fontScale ?? 1;
  assertFontScale(fontScale);
  const vars: Record<string, string> = {};

  for (const spec of listControls()) {
    const resolved = resolveControlTheme(spec);
    const prefix = `--pb-control-${spec.id}`;

    vars[`${prefix}-min-touch`] = `${formatCssNumber(resolved.minTouchDp)}dp`;

    if (resolved.radiusDp === 'range') {
      // validateControlSpec 已保证 range 控件带有序区间；此处只做纯投影。
      const range = spec.radiusRangeDp ?? [0, 0];
      vars[`${prefix}-radius-min`] = `${formatCssNumber(range[0])}dp`;
      vars[`${prefix}-radius-max`] = `${formatCssNumber(range[1])}dp`;
    } else {
      vars[`${prefix}-radius`] = `${formatCssNumber(resolved.radiusDp)}dp`;
    }

    vars[`${prefix}-font-size`] = `${formatCssNumber(resolved.fontSizeSp * fontScale)}sp`;
    vars[`${prefix}-line-height`] = `${formatCssNumber(resolved.lineHeightDp * fontScale)}dp`;
    vars[`${prefix}-font-weight-min`] = String(resolved.fontWeight.min);
    vars[`${prefix}-font-weight-max`] = String(resolved.fontWeight.max);

    if (resolved.background !== null) vars[`${prefix}-background`] = resolved.background;
    if (resolved.foreground !== null) vars[`${prefix}-foreground`] = resolved.foreground;
    if (resolved.border !== null) vars[`${prefix}-border`] = resolved.border;
  }

  return vars;
}

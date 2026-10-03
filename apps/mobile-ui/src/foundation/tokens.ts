/**
 * F01 foundation —— 设计令牌唯一来源（design tokens single source）。
 *
 * 取值来源：`docs/design/design-07-正式发布版App界面与交互.md`（v6）与
 * `docs/design/release-ui/README.md`。**设计文件里没有写死的值一律不得虚构**：
 * 本文件里每个数值型令牌要么带 `source.line`（可回溯到设计原文行号），
 * 要么显式标 `UNRESOLVED`（设计给了范围/语义但未定死具体值）。
 *
 * 一致性由 `tests/mobile-ui/F01/design-token-conformance.test.ts` 直接解析设计
 * 文档来断言——设计一改、测试即红。
 *
 * 本模块**零依赖**、不引用任何框架；只导出纯数据与纯函数。
 */

/** 设计原文出处（相对仓库根）。 */
export interface DesignRef {
  /** 设计文档相对仓库根的路径。 */
  readonly doc: string;
  /** 1 起的行号，指向写死该取值的原文行。 */
  readonly line: number;
}

/** 该令牌在设计文件中**没有**写死具体值；必须保留显式缺口而不是编造。 */
export interface Unresolved {
  readonly unresolved: true;
  /** 设计原文里实际写了什么（范围/语义），以及缺的是哪一项具体值。 */
  readonly note: string;
}

export type TokenOrigin = DesignRef | Unresolved;

const DESIGN_07 = 'docs/design/design-07-正式发布版App界面与交互.md';
const RELEASE_UI_README = 'docs/design/release-ui/README.md';

/** 便于书写的出处构造器。 */
const d07 = (line: number): DesignRef => ({ doc: DESIGN_07, line });
const rui = (line: number): DesignRef => ({ doc: RELEASE_UI_README, line });

const unresolved = (note: string): Unresolved => ({ unresolved: true, note });

// ---------------------------------------------------------------------------
// 颜色 —— 全部取自 design-07 §3「视觉方向与设计 Token」表格（行 82–95）。
// 表格行格式：| `name` | `#RRGGBB` | 用途 |
// ---------------------------------------------------------------------------

/** 颜色令牌名。与 design-07 §3 令牌表的 `name` 列一一对应。 */
export type ColorTokenName =
  | 'brand'
  | 'action-primary'
  | 'action-foreground'
  | 'canvas'
  | 'surface'
  | 'input'
  | 'text-primary'
  | 'text-secondary'
  | 'outline'
  | 'accent-surface'
  | 'accent-text'
  | 'success'
  | 'danger'
  | 'focus-ring';

export interface ColorToken {
  /** 六位大写十六进制，形如 `#E9A66D`。 */
  readonly value: string;
  /** 设计原文中的用途描述（表格第三列）。 */
  readonly usage: string;
  readonly origin: DesignRef;
}

export const colors: Readonly<Record<ColorTokenName, ColorToken>> = {
  brand: { value: '#E9A66D', usage: '品牌、文字导航选中下划线', origin: d07(82) },
  'action-primary': { value: '#E9A66D', usage: '主按钮背景', origin: d07(83) },
  'action-foreground': { value: '#241A14', usage: '主按钮文字', origin: d07(84) },
  canvas: { value: '#FFFFFF', usage: '页面底色', origin: d07(85) },
  surface: { value: '#FFFFFF', usage: '面板和浮层', origin: d07(86) },
  input: { value: '#FAFAF9', usage: '输入区背景', origin: d07(87) },
  'text-primary': { value: '#28231F', usage: '正文与标题', origin: d07(88) },
  'text-secondary': { value: '#77716B', usage: '必要辅助信息', origin: d07(89) },
  outline: { value: '#E8E4DF', usage: '分隔线和控件边界', origin: d07(90) },
  'accent-surface': { value: '#FFF0E2', usage: '轻强调背景', origin: d07(91) },
  'accent-text': { value: '#825034', usage: '轻强调文字和待处理信息', origin: d07(92) },
  success: { value: '#306A4B', usage: '有可信完成证据；状态始终有文字', origin: d07(93) },
  danger: { value: '#A73729', usage: '删除、失败、风险后果；不与普通主动作混用', origin: d07(94) },
  'focus-ring': { value: '#825034', usage: '键盘焦点，至少 2dp，不能被卡片裁剪', origin: d07(95) },
};

// ---------------------------------------------------------------------------
// 主题与品牌
// ---------------------------------------------------------------------------

export const theme = {
  /** design-07 §3 行 78：本轮固定白色主题，系统深色偏好也不切换页面底色。 */
  colorScheme: 'light-only',
  /** 同上的出处。 */
  colorSchemeOrigin: d07(78) as TokenOrigin,
  /** design-07 §3 行 107：不使用阴影。 */
  elevation: 'none',
  elevationOrigin: d07(107) as TokenOrigin,
} as const;

/**
 * 品牌素材：黑白火锅图标。设计指定**引用原图**，不重绘、不内联 SVG。
 * 出处：design-07 §3 行 76（`brand-user.png`）与 release-ui/README 行 11。
 */
export const brand = {
  /** 图标文件相对仓库根。 */
  assetPath: 'docs/design/release-ui/brand-user.png',
  /** 设计原文要求：保持原图本体与比例、小尺寸呈现。 */
  preserveAspect: true,
  /** 是否允许重绘——设计明确禁止。 */
  allowRedraw: false,
  origin: d07(76) as TokenOrigin,
  /** design 未写死的具体呈现尺寸，交由后续布局包按容器决定。 */
  renderSize: unresolved(
    'design-07 §3 行 76 只写「小尺寸呈现、保持原图比例」，未给出具体 dp；渲染尺寸不在本包定死',
  ),
} as const;

// ---------------------------------------------------------------------------
// 四个主入口与选中态
// ---------------------------------------------------------------------------

/** 四入口固定命名。出处：design-07 §2 行 36 / release-ui/README 行 13。 */
export const ENTRY_IDS = ['chat', 'group', 'file', 'mine'] as const;
export type EntryId = (typeof ENTRY_IDS)[number];

export interface EntryToken {
  readonly id: EntryId;
  /** 界面显示文字（design-07 §2 行 36：对话 / 群组 / 文件 / 我的）。 */
  readonly label: string;
  /** 页面 ID 前缀（design-07 §2 页面地图：C01/T01/F01/M01）。 */
  readonly pagePrefix: string;
}

export const entries: readonly EntryToken[] = [
  { id: 'chat', label: '对话', pagePrefix: 'C01' },
  { id: 'group', label: '群组', pagePrefix: 'T01' },
  { id: 'file', label: '文件', pagePrefix: 'F01' },
  { id: 'mine', label: '我的', pagePrefix: 'M01' },
];

/**
 * 选中态：**细橙色下划线**。
 * 出处：design-07 §2 行 36「使用文字导航和细橙色选中下划线」、§0 行 11
 * 「以细橙色下划线标示当前页」、§3 行 82 `brand` 用途列。
 * 下划线的具体要求：颜色=brand、形状=下划线、粗细=细（fine）。
 * design 未给出具体的粗细 dp —— 记为 unresolved，不编造数值。
 */
export const entrySelection = {
  indicator: 'underline',
  color: colors.brand.value,
  /** 细：语义上为非粗线；design 未写 dp。 */
  weight: 'fine',
  weightPx: unresolved('design-07 行 36/11/82 只写「细橙色下划线」，未给出具体粗细 dp'),
  origin: d07(36) as TokenOrigin,
} as const;

/**
 * 「模版」是界面统一字形（不是「模板」）。
 * 出处：design-07 §7 行 151「原『插件』入口及其管理页统一显示为『模版』」、
 * §2 行 40「界面入口统一采用用户指定字形『模版』」。
 */
export const TEMPLATE_LABEL = '模版';
export const templateLabelOrigin = d07(40) as TokenOrigin;

// ---------------------------------------------------------------------------
// 字体与排版（design-07 §3 行 101–103）
// ---------------------------------------------------------------------------

export interface TypeScaleEntry {
  /** 字号，单位 sp。 */
  readonly sizeSp: number;
  /** 行高，单位 dp。 */
  readonly lineHeightDp: number;
}

export const typography = {
  /**
   * 字体族：design-07 §3 行 101 只写「Android 系统中文无衬线字体；数字与英文
   * 沿用系统字体」——**没有给出任何具体字体名或 CSS font-family 串**。
   * 因此不编造 family 串，只保留语义描述与缺口。
   */
  family: unresolved(
    'design-07 §3 行 101 只描述为「Android 系统中文无衬线字体，数字与英文沿用系统字体」，未给出具体字体名或 font-family 串',
  ),
  /** 语义描述原样摘录，供后续接入平台时人工决策。 */
  familyDescription: 'Android 系统中文无衬线字体；数字与英文沿用系统字体，关键金额不能靠字体宽度对齐',
  scale: {
    /** 页面标题 24sp/32 */
    'page-title': { sizeSp: 24, lineHeightDp: 32 },
    /** 区块标题 20sp/28 */
    'section-title': { sizeSp: 20, lineHeightDp: 28 },
    /** 正文 16sp/24 */
    body: { sizeSp: 16, lineHeightDp: 24 },
    /** 按钮 16sp/24 */
    button: { sizeSp: 16, lineHeightDp: 24 },
    /** 辅助 14sp/20 */
    auxiliary: { sizeSp: 14, lineHeightDp: 20 },
    /** 非关键标注 12sp/18 */
    'annotation-minor': { sizeSp: 12, lineHeightDp: 18 },
  } satisfies Record<string, TypeScaleEntry>,
  weights: {
    /** 标题 600 */
    title: 600,
    /** 正文 400 */
    body: 400,
    /** 按钮和关键数字 500–600 */
    buttonMin: 500,
    buttonMax: 600,
  },
  origin: d07(101) as TokenOrigin,
  scaleOrigin: d07(102) as TokenOrigin,
  weightsOrigin: d07(103) as TokenOrigin,
  /** design 未指定字体回退链与衬线/等宽细节。 */
  fallback: unresolved('design-07 §3 行 101 未给出字体回退链（fallback stack）'),
} as const;

// ---------------------------------------------------------------------------
// 间距、触区、圆角、动效（design-07 §3 行 104–108）
// ---------------------------------------------------------------------------

export const spacing = {
  /** 基础 4dp */
  baseDp: 4,
  /** 常用 8/12/16/24/32dp */
  commonDp: [8, 12, 16, 24, 32],
  /** 手机页面左右 20dp */
  pageInlineDp: 20,
  /** 窄屏允许 16dp */
  pageInlineNarrowDp: 16,
  origin: d07(104) as TokenOrigin,
} as const;

export const touch = {
  /** 正式产品按钮与图标的有效触区至少 48×48dp */
  minTargetDp: 48,
  /** 浏览原型 44 CSS px 仅作评审近似 */
  prototypeApproxPx: 44,
  origin: d07(105) as TokenOrigin,
} as const;

export const radius = {
  /**
   * 控件约 12dp；成果卡与输入容器 12–20dp（按层级）。
   * design 给的是**区间/约数**，未定死单一 dp ⇒ 记区间，不编造单值。
   */
  controlDp: 12,
  cardMinDp: 12,
  cardMaxDp: 20,
  origin: d07(106) as TokenOrigin,
  cardExact: unresolved('design-07 §3 行 106 只写成果卡与输入容器「12–20dp 按层级」，未定死单值'),
} as const;

export const motion = {
  /** 普通过渡 160–220ms；尊重减少动态效果。 */
  durationMinMs: 160,
  durationMaxMs: 220,
  respectReducedMotion: true,
  origin: d07(108) as TokenOrigin,
  exactDuration: unresolved('design-07 §3 行 108 只写「160–220ms」，未定死单值'),
} as const;

// ---------------------------------------------------------------------------
// 响应式断点（design-07 §12 行 255）
// ---------------------------------------------------------------------------

export interface Breakpoint {
  readonly id: 'compact' | 'medium' | 'expanded';
  /** 含下界（dp）。 */
  readonly minDp: number;
  /** 不含上界（dp）；`null` 表示无上界。 */
  readonly maxDp: number | null;
  readonly layout: 'single-column-bottom-nav' | 'nav-rail-plus-main' | 'nav-rail-plus-list-detail';
}

export const breakpoints: readonly Breakpoint[] = [
  { id: 'compact', minDp: 0, maxDp: 600, layout: 'single-column-bottom-nav' },
  { id: 'medium', minDp: 600, maxDp: 840, layout: 'nav-rail-plus-main' },
  { id: 'expanded', minDp: 840, maxDp: null, layout: 'nav-rail-plus-list-detail' },
];

export const breakpointsOrigin = d07(255) as TokenOrigin;

// ---------------------------------------------------------------------------
// 布局壳运行模式（design-07 §0 行 15、§4 行 117）
// ---------------------------------------------------------------------------

/**
 * `inline` = 内联原型：输入区与导航采用自然文档流，位于内容底部，不固定。
 * `app`    = 正式 Android：输入区固定在键盘上方，处理安全区、返回和输入法。
 * design 明确二者分别约束，浏览器预览不能证明 Android 已通过。
 */
export type ShellMode = 'inline' | 'app';

export const shellModeOrigin = {
  inline: d07(15) as TokenOrigin,
  app: d07(15) as TokenOrigin,
} as const;

/** 汇总导出，便于布局层与 CSS 生成器单点取用。 */
export const tokens = {
  colors,
  theme,
  brand,
  entries,
  entrySelection,
  TEMPLATE_LABEL,
  typography,
  spacing,
  touch,
  radius,
  motion,
  breakpoints,
  shellModeOrigin,
} as const;

export type Tokens = typeof tokens;

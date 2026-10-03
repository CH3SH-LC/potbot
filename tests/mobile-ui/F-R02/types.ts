/**
 * F-R02 —— 可访问性审计的类型/模式（纯类型 + 纯数据，零依赖）。
 *
 * 本包不开产品页面（页面归 F01–F10），只做**独立可访问性对照**：把一份声明式
 * 的界面规格（ScreenSpec）与 `design-07` §12「可访问性与 Android 行为」
 * （docs/design/design-07-正式发布版App界面与交互.md 行 247–257）以及 §3 尺寸
 * 令牌（行 95 焦点环 ≥2dp、行 105 触区 ≥48×48dp 不重叠）逐条比对，输出
 * 可机器断言、可追溯出处行的 Finding 列表。
 *
 * 规格是**描述性**的，不渲染、不依赖 DOM/框架/真机；真机读屏、系统字体缩放、
 * 折叠屏铰链与真机触摸的实测另属 on-device 层，本包不冒充（见 RUNBOOK.md 边界）。
 */

// ---------------------------------------------------------------------------
// 几何
// ---------------------------------------------------------------------------

/** dp 矩形（左上角 + 宽高）。 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

// ---------------------------------------------------------------------------
// 节点
// ---------------------------------------------------------------------------

/** 界面节点角色。 */
export type NodeRole =
  | 'screen'
  | 'header'
  | 'container'
  | 'list'
  | 'list-item'
  | 'card'
  | 'button'
  | 'icon-button'
  | 'input'
  | 'text'
  | 'image'
  | 'decorative-image'
  | 'heading'
  | 'status'
  | 'overlay'
  | 'sheet';

/** 文本规格：用于 200% 字号走查是否截断。 */
export interface TextSpec {
  readonly text: string;
  /** 设计字号（sp）。取自 design-07 §3 行 102 的字号阶梯。 */
  readonly fontSizeSp: number;
  /** 允许占用的最大行数。 */
  readonly maxLines: number;
  /** 是否允许截断（关键参数/按钮后果/错误不得为 true）。 */
  readonly allowTruncate: boolean;
}

/** 一个界面节点。 */
export interface NodeSpec {
  readonly id: string;
  readonly role: NodeRole;
  readonly bounds: Rect;
  /** 读屏名称（accessibility label）。功能性控件必须非空。 */
  readonly label?: string;
  /** 所属对象名；按钮泛称（查看/确定）时必须给出，否则读数无所属对象。 */
  readonly objectName?: string;
  /** 是否可交互（可点击/可编辑）。 */
  readonly interactive?: boolean;
  /** 交互是否可用（禁用态）。 */
  readonly enabled?: boolean;
  /** 是否进入键盘/读屏焦点序列。 */
  readonly focusable?: boolean;
  /** 命中区相对 bounds 每侧外扩 dp（有效触区 = bounds + 2×hitSlop）。 */
  readonly hitSlopDp?: number;
  /** 焦点环宽度 dp（design-07 行 95：至少 2dp）。 */
  readonly focusRingWidthDp?: number;
  /** 焦点环是否被卡片裁剪（design-07 行 95：不能被卡片裁剪）。 */
  readonly focusRingClipped?: boolean;
  /** 关键控制（不可落在铰链/挖孔/手势区；design-07 行 256）。 */
  readonly criticalControl?: boolean;
  /** 文本规格；无文本节点可省。 */
  readonly text?: TextSpec;
  /** 卡片类型（design-07 行 250：读屏朗读卡片类型）。 */
  readonly type?: string;
  /** 状态（design-07 行 250：读屏朗读状态）。 */
  readonly status?: string;
  /** 动作后果（design-07 行 250：读屏朗读动作后果）。 */
  readonly actionConsequence?: string;
  /** 实时公告频率（每秒）；过高会打断阅读（design-07 行 250）。 */
  readonly announcementsPerSecond?: number;
  /** 该公告是否打断当前阅读。 */
  readonly interruptsReading?: boolean;
  /** 是否为唯一自然语言入口（design-07 行 256：双栏不产生第二个）。 */
  readonly nlEntry?: boolean;
  /** 浮层是否圈定焦点（design-07 行 251/107）。 */
  readonly trapsFocus?: boolean;
  /** 浮层关闭后焦点返回的触发控件 id（design-07 行 251）。 */
  readonly returnsFocusTo?: string;
}

// ---------------------------------------------------------------------------
// 视口（横屏 / 折叠屏）
// ---------------------------------------------------------------------------

/** 遮挡区类型：铰链、挖孔、系统手势区（design-07 行 256）。 */
export type OcclusionKind = 'hinge' | 'cutout' | 'gesture';

export interface OcclusionRect extends Rect {
  readonly kind: OcclusionKind;
}

/** 视口规格。 */
export interface ViewportSpec {
  readonly widthDp: number;
  readonly heightDp: number;
  readonly orientation: 'portrait' | 'landscape';
  /** 系统字体缩放倍率；200% 走查用 2.0（design-07 行 249）。 */
  readonly fontScale: number;
  /** 铰链/挖孔/手势遮挡区。 */
  readonly occlusions: readonly OcclusionRect[];
  /** 当前列数。 */
  readonly columns: 1 | 2;
  /** 双列在大字号下是否退化为单列（design-07 行 249）。 */
  readonly collapsesToSingleColumn: boolean;
}

/** 整屏规格。 */
export interface ScreenSpec {
  readonly id: string;
  readonly viewport: ViewportSpec;
  readonly nodes: readonly NodeSpec[];
  /** 声明的焦点顺序（节点 id 序列）。 */
  readonly focusOrder: readonly string[];
  /** 旋转/折叠后必须保留的状态键（design-07 行 256）。 */
  readonly requiredStateKeys?: readonly string[];
  /** 旋转/折叠后实际保留的状态键。 */
  readonly preservedState?: readonly string[];
}

// ---------------------------------------------------------------------------
// 审计结果
// ---------------------------------------------------------------------------

export type Severity = 'error' | 'warning';

/** 审计发现编码。 */
export type FindingCode =
  | 'A11Y_TARGET_TOO_SMALL'
  | 'A11Y_TARGET_OVERLAP'
  | 'A11Y_NESTED_INTERACTIVE'
  | 'A11Y_LABEL_MISSING'
  | 'A11Y_LABEL_GENERIC'
  | 'A11Y_DECORATIVE_ANNOUNCED'
  | 'A11Y_CARD_ANNOUNCE_INCOMPLETE'
  | 'A11Y_ICON_WITHOUT_LABEL'
  | 'A11Y_LIVE_REGION_TOO_NOISY'
  | 'A11Y_FOCUS_ORDER_MISMATCH'
  | 'A11Y_FOCUS_NODE_MISSING'
  | 'A11Y_FOCUS_NODE_EXTRA'
  | 'A11Y_FOCUS_NODE_DUPLICATE'
  | 'A11Y_OVERLAY_NO_TRAP'
  | 'A11Y_FOCUS_NOT_RETURNED'
  | 'A11Y_FOCUS_RING_TOO_THIN'
  | 'A11Y_FOCUS_RING_CLIPPED'
  | 'A11Y_FONTSCALE_TRUNCATION'
  | 'A11Y_FONTSCALE_NO_COLLAPSE'
  | 'A11Y_CRITICAL_IN_OCCLUSION'
  | 'A11Y_SECOND_NL_ENTRY'
  | 'A11Y_LANDSCAPE_STATE_LOST';

/** 一条审计发现。designRef 指向 design-07 的行号，便于人工复核。 */
export interface Finding {
  readonly code: FindingCode;
  readonly severity: Severity;
  readonly nodeId?: string;
  readonly message: string;
  /** 出处，形如 `design-07 L105`。 */
  readonly designRef: string;
}

/** 审计报告。 */
export interface AuditReport {
  readonly screenId: string;
  /** 无 error 级发现时为 true（warning 不置红）。 */
  readonly ok: boolean;
  readonly findings: readonly Finding[];
  readonly errorCount: number;
  readonly warningCount: number;
  /** 参与审计的节点数。 */
  readonly checkedNodes: number;
}

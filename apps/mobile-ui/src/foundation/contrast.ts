/**
 * F01 foundation —— 对比度（WCAG 2.1 相对亮度 / 对比度比）。
 *
 * 目的：给 F01 验收里的「对比度合格」提供**可复算**的证据，而不是引用旧版
 * 数字或凭感觉。设计原件 **没有写死**任何对比度阈值（design-07 §3 行 97：
 * 「旧版静态对比数值不再沿用。最终…仍须完成可访问性验收」），因此本模块：
 *   1. 只提供**计算方法**与**token→token 配对表**；
 *   2. 阈值取业界通用的 WCAG 2.1 AA 下限，显式标注为**工程下限，非设计给定**；
 *   3. 测量结果**如实返回**——低于下限的配对会被标出来，不隐藏、不改阈值凑数。
 *
 * 零依赖、纯函数。着色取 `tokens.colors`，不重复定义色值。
 *
 * 重要发现（见 `tokenContrastAudit()` 的 `brand on canvas`）：品牌杏橙
 * `#E9A66D` 在白底上的对比度约 2.07:1，**低于 WCAG 1.4.11 非文本 3:1 下限**。
 * 设计把它用作「选中下划线/品牌识别」这类非文本指示，该缺口在 §3 行 97 已声明
 * 待验收，本模块据实登记，不伪装通过。
 */

import { colors, type ColorTokenName } from './tokens.js';

/** WCAG 2.1 AA 正文文本下限（工程下限，非 design-07 给定）。 */
export const AA_NORMAL_TEXT = 4.5;
/** WCAG 2.1 AA 大号文本下限（≥18pt 或 ≥14pt 粗体）。 */
export const AA_LARGE_TEXT = 3.0;
/** WCAG 2.1 AA 非文本（图标/边框/图形）下限。 */
export const AA_NON_TEXT = 3.0;

/** 阈值来源说明：显式区分「设计给定」与「工程下限」。 */
export const THRESHOLD_SOURCE = {
  fromDesign: false,
  note: 'design-07 §3 行 97 声明旧对比数值不再沿用且待验收，未给出阈值；本处采用 WCAG 2.1 AA 工程下限',
} as const;

export type ContrastClass = 'normal-text' | 'large-text' | 'non-text';

/** 一个 token 对视作背景/前景的一对颜色。 */
export interface ContrastPair {
  readonly id: string;
  readonly foreground: ColorTokenName;
  readonly background: ColorTokenName;
  readonly kind: ContrastClass;
  readonly note: string;
}

/**
 * 需要核验的 token 配对。只收录 design-07 里实际会同时出现的组合
 * （正文/辅助文字、按钮文字与底色、状态色、强调文字与强调底、焦点环）。
 */
export const contrastPairs: readonly ContrastPair[] = [
  { id: 'body-on-canvas', foreground: 'text-primary', background: 'canvas', kind: 'normal-text', note: '正文与标题 / 页面底色（§3 行 85、88）' },
  { id: 'body-on-surface', foreground: 'text-primary', background: 'surface', kind: 'normal-text', note: '正文与标题 / 面板浮层（§3 行 86、88）' },
  { id: 'secondary-on-canvas', foreground: 'text-secondary', background: 'canvas', kind: 'normal-text', note: '辅助信息 / 页面底色（§3 行 85、89）' },
  { id: 'secondary-on-input', foreground: 'text-secondary', background: 'input', kind: 'normal-text', note: '辅助信息 / 输入区底色（§3 行 87、89）' },
  { id: 'button-label-on-primary', foreground: 'action-foreground', background: 'action-primary', kind: 'normal-text', note: '主按钮文字 / 主按钮底色（§3 行 83、84）' },
  { id: 'accent-on-accent-surface', foreground: 'accent-text', background: 'accent-surface', kind: 'normal-text', note: '轻强调文字 / 轻强调底（§3 行 91、92）' },
  { id: 'success-on-canvas', foreground: 'success', background: 'canvas', kind: 'normal-text', note: '成功色 / 页面底色（§3 行 85、93）' },
  { id: 'danger-on-canvas', foreground: 'danger', background: 'canvas', kind: 'normal-text', note: '危险色 / 页面底色（§3 行 85、94）' },
  { id: 'focus-ring-on-canvas', foreground: 'focus-ring', background: 'canvas', kind: 'non-text', note: '键盘焦点环 / 页面底色（§3 行 85、95）' },
  { id: 'brand-on-canvas', foreground: 'brand', background: 'canvas', kind: 'non-text', note: '品牌色（选中下划线）/ 页面底色（§3 行 82、85）——设计用作非文本指示' },
];

/** 严格校验 `#RRGGBB`（大小写均可），否则抛错——防止把非法色值算成"通过"。 */
export function parseHexColor(value: string): readonly [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(value);
  if (m === null || m[1] === undefined) {
    throw new Error(`非法颜色值（需 #RRGGBB）: ${value}`);
  }
  const hex = m[1];
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

/** sRGB 通道（0–255）→ 线性值（0–1）。 */
function channelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.1 相对亮度（0–1）。 */
export function relativeLuminance(value: string): number {
  const [r, g, b] = parseHexColor(value);
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

/** WCAG 2.1 对比度比，范围 1–21。 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** 该类别对应的下限。 */
export function thresholdFor(kind: ContrastClass): number {
  switch (kind) {
    case 'normal-text':
      return AA_NORMAL_TEXT;
    case 'large-text':
      return AA_LARGE_TEXT;
    case 'non-text':
      return AA_NON_TEXT;
    default: {
      const never: never = kind;
      throw new Error(`未知对比度类别: ${String(never)}`);
    }
  }
}

export interface ContrastResult {
  readonly id: string;
  readonly foreground: string;
  readonly background: string;
  readonly kind: ContrastClass;
  /** 实测对比度比。 */
  readonly ratio: number;
  /** 该类别下限（工程下限）。 */
  readonly threshold: number;
  /** 是否达标。 */
  readonly pass: boolean;
  readonly note: string;
}

/** 计算全部配对，返回**实测**结果（不隐藏不达标项）。 */
export function tokenContrastAudit(): readonly ContrastResult[] {
  return contrastPairs.map((pair) => {
    const fg = colors[pair.foreground].value;
    const bg = colors[pair.background].value;
    const ratio = contrastRatio(fg, bg);
    const threshold = thresholdFor(pair.kind);
    return {
      id: pair.id,
      foreground: fg,
      background: bg,
      kind: pair.kind,
      ratio,
      threshold,
      pass: ratio >= threshold,
      note: pair.note,
    };
  });
}

/** 只列出未达标的配对；空数组 = 全部达标。 */
export function failingContrastPairs(): readonly ContrastResult[] {
  return tokenContrastAudit().filter((r) => !r.pass);
}

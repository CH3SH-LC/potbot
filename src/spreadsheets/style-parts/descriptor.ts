/**
 * X03：单元格样式 → **去重描述符**（design-06-P8 / XLS-05）。
 *
 * ## 描述符是什么
 *
 * 一个"样式描述符"就是一份**规范化后**的 {@link CellStyle}：同样的视觉样式必然得到同样的
 * 描述符，不同的视觉样式必然得到不同的描述符。判等靠 {@link styleKey}——把规范化结果做
 * **键序无关**的序列化（对象键排序、缺省键省略），因此 `{bold:true, font_size:12}` 与
 * `{font_size:12, bold:true}` 同键，而 `{bold:true}` 与 `{bold:false}` 分别是两个键。
 *
 * ## 「不得静默丢弃」
 *
 * `styles.ts` 的 `normalizeCellStyle` 会**忽略它不认识的键**（宽松解析，便于向前兼容）。
 * 本模块站在"生成 XML"的位置，**不能**容忍悄悄丢字段——那会让用户以为样式生效了而其实没有。
 * 因此 {@link canonicalizeStyle} 在委托规范化之前先做**逐层键白名单校验**：任何本模块不认识的
 * 键（顶层、`borders` 各边、`number_format` 内部）一律 {@link ValidationError} 报错。
 *
 * ## 原值与显示值分开
 *
 * {@link renderNumberDisplay} 只**读**一个数、按数字格式产出一段**显示文本**，
 * 返回值里 `value` 原样带回——函数没有可写状态，"把百分比乘 100 写回"这类错误没有发生的入口。
 */

import { ValidationError } from '../../protocol/index.js';
import { fromExcelSerial } from '../excel-date.js';
import {
  CURRENCY_SYMBOLS,
  formatDatePattern,
  normalizeCellStyle,
  type CellNumberFormat,
  type CellStyle,
} from '../styles.js';

// ---------------------------------------------------------------------------
// 键白名单（"不静默丢弃"的判据）
// ---------------------------------------------------------------------------

const STYLE_KEYS: ReadonlySet<string> = new Set([
  'bold',
  'italic',
  'font_family',
  'font_size',
  'font_color',
  'fill_color',
  'horizontal_align',
  'vertical_align',
  'wrap_text',
  'indent',
  'borders',
  'number_format',
  'protection',
]);

const BORDER_SIDE_KEYS: ReadonlySet<string> = new Set(['top', 'bottom', 'left', 'right']);
const BORDER_EDGE_KEYS: ReadonlySet<string> = new Set(['style', 'color']);
/** `protection` 下允许出现的键（`CellProtection`，见 `styles.ts`）。 */
const PROTECTION_KEYS: ReadonlySet<string> = new Set(['locked']);

/** 各 `kind` 下 `number_format` 允许出现的键。 */
const NUMBER_FORMAT_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  general: ['kind'],
  number: ['kind', 'decimals', 'grouping'],
  percent: ['kind', 'decimals'],
  currency: ['kind', 'currency', 'decimals'],
  date: ['kind', 'pattern'],
});

function assertOnlyKeys(value: object, allowed: ReadonlySet<string>, where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ValidationError(`${where} 含有本模块无法表达的键「${key}」（拒绝静默丢弃）`);
    }
  }
}

function assertNumberFormatKeys(format: object, where: string): void {
  const kind: unknown = (format as { kind?: unknown }).kind;
  const allowed = typeof kind === 'string' ? NUMBER_FORMAT_KEYS[kind] : undefined;
  if (allowed === undefined) {
    // 未知 kind 交给 describeNumberFormat 抛出统一错误；这里只拦"已知 kind 的多余键"。
    return;
  }
  assertOnlyKeys(format, new Set(allowed), where);
}

function assertKnownShape(style: CellStyle): void {
  assertOnlyKeys(style as object, STYLE_KEYS, '样式');
  const record = style as Record<string, unknown>;
  const borders = record.borders;
  if (borders !== undefined && borders !== null) {
    if (typeof borders !== 'object') {
      throw new ValidationError(`样式.borders 必须是对象，收到 ${JSON.stringify(borders)}`);
    }
    assertOnlyKeys(borders as object, BORDER_SIDE_KEYS, '样式.borders');
    for (const side of BORDER_SIDE_KEYS) {
      const edge = (borders as Record<string, unknown>)[side];
      if (edge === undefined || edge === null) continue;
      if (typeof edge !== 'object') {
        throw new ValidationError(`样式.borders.${side} 必须是对象，收到 ${JSON.stringify(edge)}`);
      }
      assertOnlyKeys(edge as object, BORDER_EDGE_KEYS, `样式.borders.${side}`);
    }
  }
  const numfmt = record.number_format;
  if (numfmt !== undefined && numfmt !== null) {
    if (typeof numfmt !== 'object') {
      throw new ValidationError(`样式.number_format 必须是对象，收到 ${JSON.stringify(numfmt)}`);
    }
    assertNumberFormatKeys(numfmt as object, '样式.number_format');
  }
  const protection = record.protection;
  if (protection !== undefined && protection !== null) {
    if (typeof protection !== 'object') {
      throw new ValidationError(`样式.protection 必须是对象，收到 ${JSON.stringify(protection)}`);
    }
    assertOnlyKeys(protection as object, PROTECTION_KEYS, '样式.protection');
  }
}

// ---------------------------------------------------------------------------
// 规范化
// ---------------------------------------------------------------------------

/**
 * 去掉与"未设置"渲染等价的显式值。
 *
 * 只处理**确定等价**的四类：`bold/italic/wrap_text === false`（缺省即不加粗 / 不倾斜 / 不换行）、
 * `indent === 0`（缺省缩进即 0）、`number_format.kind === 'general'`（General 就是默认 `numFmtId=0`）、
 * `protection.locked !== false`（Excel 约定默认即锁定，缺省与 `<protection locked="1"/>` 渲染等价）。
 * **对齐字段一律保留**——`'general'` / `'bottom'` 是否等价默认值取决于默认 xf 的定义，
 * 本模块不擅自合并，宁可多出一项 `xf` 也不误并两个语义不同的样式。
 *
 * 注意：本函数在 `normalizeCellStyle` **之后**调用，因此 `protection` 已收敛为
 * `{ locked?: boolean }`——只需看 `locked` 是否为 `false`。
 */
function dropRenderingDefaults(style: CellStyle): CellStyle {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(style as Record<string, unknown>)) {
    if ((key === 'bold' || key === 'italic' || key === 'wrap_text') && value === false) continue;
    if (key === 'indent' && value === 0) continue;
    if (key === 'number_format') {
      const fmt = value as { kind?: unknown } | null | undefined;
      if (fmt !== null && fmt !== undefined && fmt.kind === 'general') continue;
    }
    if (key === 'protection') {
      const prot = value as { locked?: unknown } | null | undefined;
      // 缺省 / 显式 `locked: true` 都等价于"不写 <protection>"（Excel 默认锁定）。
      if (prot === null || prot === undefined || prot.locked !== false) continue;
    }
    out[key] = value;
  }
  return Object.freeze(out) as CellStyle;
}

/**
 * 校验并规范化一份样式为**描述符**（冻结、缺省键省略）。
 *
 * @throws {ValidationError} 含未知键、或字段值非法（委托 `normalizeCellStyle` 的校验）
 */
export function canonicalizeStyle(style: CellStyle): CellStyle {
  if (style === null || typeof style !== 'object') {
    throw new ValidationError(`样式必须是对象，收到 ${JSON.stringify(style)}`);
  }
  assertKnownShape(style);
  return dropRenderingDefaults(normalizeCellStyle(style));
}

// ---------------------------------------------------------------------------
// 去重键
// ---------------------------------------------------------------------------

/** 键序无关的稳定序列化（对象键排序；`undefined` 值随 JSON 语义省略）。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${parts.join(',')}}`;
}

/**
 * 一份样式的**去重键**（对规范化描述符做稳定序列化）。
 *
 * 判据：`key(a) === key(b)` ⟺ a、b 渲染等价。两个视觉上不同的样式必然得到不同键
 * （见测试「两个不同样式不得被去重成同一个」）。
 */
export function styleKey(style: CellStyle): string {
  return stableStringify(canonicalizeStyle(style));
}

/** 空样式（默认描述符）的键——即 `cellXfs[0]` 对应的键。 */
export const EMPTY_STYLE_KEY = styleKey({});

// ---------------------------------------------------------------------------
// 显示值（只读产出；绝不回写实际值）
// ---------------------------------------------------------------------------

function groupThousands(intText: string): string {
  let out = '';
  let count = 0;
  for (let i = intText.length - 1; i >= 0; i -= 1) {
    out = intText.charAt(i) + out;
    count += 1;
    if (count % 3 === 0 && i > 0) out = `,${out}`;
  }
  return out;
}

function formatFixed(value: number, decimals: number, grouping: boolean): string {
  const negative = value < 0;
  const fixed = Math.abs(value).toFixed(decimals);
  const dot = fixed.indexOf('.');
  const intPart = dot === -1 ? fixed : fixed.slice(0, dot);
  const fracPart = dot === -1 ? '' : fixed.slice(dot);
  return `${negative ? '-' : ''}${grouping ? groupThousands(intPart) : intPart}${fracPart}`;
}

/** 数字显示结果：显示文本 + **原样**带回的输入值（"分别验收"的数据形状）。 */
export interface NumberDisplay {
  /** 按数字格式产出的**显示文本**。 */
  readonly display: string;
  /** 输入值，**一个比特都没动**。 */
  readonly value: number;
}

/**
 * 把一个数值按数字格式渲染为**显示文本**。
 *
 * 纯函数：无 `SheetState`、无可写状态。百分比只在此处乘 100（`0.15 → "15%"`），
 * 返回的 `value` 仍是 `0.15`——这正是"原值与显示值分开"的机器化证据。
 *
 * 数值格套日期格式时按 **Excel 序列号**解释成日期文本（数值本身不变）。
 *
 * @throws {ValidationError} 值非有限数
 */
export function renderNumberDisplay(
  value: number,
  format: CellNumberFormat | undefined,
): NumberDisplay {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`renderNumberDisplay 只接受有限数，收到 ${String(value)}`);
  }
  const fmt: CellNumberFormat = format ?? { kind: 'general' };
  let display: string;
  switch (fmt.kind) {
    case 'general':
      display = String(value);
      break;
    case 'number':
      display = formatFixed(value, fmt.decimals, fmt.grouping);
      break;
    case 'percent':
      display = `${formatFixed(value * 100, fmt.decimals, false)}%`;
      break;
    case 'currency': {
      const negative = value < 0;
      display = `${negative ? '-' : ''}${CURRENCY_SYMBOLS[fmt.currency]}${formatFixed(Math.abs(value), fmt.decimals, true)}`;
      break;
    }
    case 'date':
      display = formatDatePattern(fromExcelSerial(value), fmt.pattern);
      break;
    default: {
      const never: never = fmt;
      throw new ValidationError(`renderNumberDisplay 未覆盖的数字格式：${JSON.stringify(never)}`);
    }
  }
  return Object.freeze({ display, value });
}

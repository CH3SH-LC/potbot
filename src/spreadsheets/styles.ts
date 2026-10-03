/**
 * 表格域：单元格样式与数字格式（design-06-P8 / XLS-05）。
 *
 * ## 这个文件要证明的唯一一件事
 *
 * XLS-05 的验收句是「**显示值与实际值分别验收**」。所以本模块把"单元格长什么样"与
 * "单元格是什么"**拆成两个互不相通的对象**：
 *
 * - **实际值** —— 仍是 `value.ts` 的 `CellValue`（本模块**一个字节都不改**）；
 * - **样式** —— 本模块新增的 `CellStyle`，按 A1 地址挂在 {@link CellStyles} 上，**与值分开存**。
 *
 * {@link formatCellDisplay} 只**读**值产出**一段显示文本**，绝不回写值。因此
 * "把百分比格式不小心乘了 100 写回底层"这种错误**在这里没有发生的入口**：函数没有 `SheetState`
 * 参数，也没有返回值可以塞回单元格。{@link displayCell} 同时给出 `display` 与 `actual` 两栏，
 * 让"分别验收"成为调用方拿到的一等数据，而不是一句口头承诺。
 *
 * ## 日期与货币为什么不用 `Intl` / `toLocaleString`
 *
 * 内核纪律（`tests/acceptance/office/w-disc-kernel-discipline.test.ts`）在 `src/**` 禁用
 * `new Date(` / `Date.now(` / `toLocaleString`。更重要的是：`Intl` 的输出**依赖运行时 ICU 版本**，
 * 同一输入在不同 Node 上可能不同——那会直接违反"确定性"。所以日期用**纯整数算术**
 * （Howard Hinnant 的 civil-from-days），货币用**固定符号表**，分组用**手写千分位**。
 */

import { ValidationError } from '../protocol/index.js';
import { fromExcelSerial, MS_PER_DAY } from './excel-date.js';
import {
  formatCellAddress,
  mapReferenceOnColumnDelete,
  mapReferenceOnColumnInsert,
  mapReferenceOnRowDelete,
  mapReferenceOnRowInsert,
  parseCellAddress,
  parseRange,
  type CellRange,
  type ReferenceMapResult,
} from './reference.js';
import { getCellValue, normalizeAddress, type AddressInput, type SheetState } from './sheet.js';
import type { CellValue } from './value.js';

// ---------------------------------------------------------------------------
// 样式模型
// ---------------------------------------------------------------------------

/** 水平对齐（XLS-05「对齐」）。 */
export type CellHorizontalAlign = 'general' | 'left' | 'center' | 'right' | 'fill' | 'justify';

/** 垂直对齐。 */
export type CellVerticalAlign = 'top' | 'middle' | 'bottom';

/** 边框线型（XLS-05「边框」）。 */
export type CellBorderLineStyle = 'none' | 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double';

const HORIZONTAL_ALIGNS: readonly CellHorizontalAlign[] = Object.freeze([
  'general',
  'left',
  'center',
  'right',
  'fill',
  'justify',
]);

const VERTICAL_ALIGNS: readonly CellVerticalAlign[] = Object.freeze(['top', 'middle', 'bottom']);

const BORDER_LINE_STYLES: readonly CellBorderLineStyle[] = Object.freeze([
  'none',
  'thin',
  'medium',
  'thick',
  'dashed',
  'dotted',
  'double',
]);

/** 边框的一条边：线型 + 颜色（`null` 表示沿用默认色，不猜测具体色值）。 */
export interface CellBorderEdge {
  readonly style: CellBorderLineStyle;
  readonly color: string | null;
}

/** 四边边框（缺省的一边表示"未显式设置"）。 */
export interface CellBorders {
  readonly top?: CellBorderEdge;
  readonly bottom?: CellBorderEdge;
  readonly left?: CellBorderEdge;
  readonly right?: CellBorderEdge;
}

/**
 * 单元格保护（XLS-15「有权限才修改」的**样式半边**）。
 *
 * 对应 `xf` 的 `<protection>` 子元素（CT_CellProtection）。Excel 约定：单元格默认
 * `locked = true`，只有在工作表本身被保护（`<sheetProtection>`）时才生效。因此这里
 * **只有显式 `locked: false`（"未锁定格"）才需要写进样式表**——`true` / 缺省与"不写
 * `<protection>`"渲染等价。
 *
 * 与 `protection/sheet-protection.ts` 的 `CellLockState`（`{ locked?: boolean }`）
 * **结构一致**：`isCellEditable(model, style.protection ?? {}, hasUnlock)` 直接可用。
 */
export interface CellProtection {
  /** 是否锁定；缺省 = Excel 默认 `true`（受保护时锁定）。仅 `false` 需写出。 */
  readonly locked?: boolean;
}

/** 货币代码（封闭枚举；符号表见 {@link CURRENCY_SYMBOLS}）。 */
export type CurrencyCode = 'CNY' | 'USD' | 'EUR' | 'JPY' | 'GBP';

const CURRENCY_CODES: readonly CurrencyCode[] = Object.freeze(['CNY', 'USD', 'EUR', 'JPY', 'GBP']);

/**
 * 货币符号表。
 *
 * CNY 与 JPY 都用 `¥`——这是**事实**（两者确实都用该符号），本模块不做消歧（那需要 locale，
 * 而 locale 已被确定性要求排除）。要区分就靠数字格式本身携带的 `currency` 代码。
 */
export const CURRENCY_SYMBOLS: Readonly<Record<CurrencyCode, string>> = Object.freeze({
  CNY: '¥',
  USD: '$',
  EUR: '€',
  JPY: '¥',
  GBP: '£',
});

/** 日期显示图案（封闭枚举；只支持这几种，避免半吊子格式解析器）。 */
export type DateDisplayPattern = 'yyyy-mm-dd' | 'yyyy/mm/dd' | 'm/d/yyyy' | 'dd/mm/yyyy';

const DATE_PATTERNS: readonly DateDisplayPattern[] = Object.freeze([
  'yyyy-mm-dd',
  'yyyy/mm/dd',
  'm/d/yyyy',
  'dd/mm/yyyy',
]);

/**
 * 数字格式（XLS-05「数字格式 / 百分比 / 货币 / 日期」）。
 *
 * **它只决定 `display`，不决定 `actual`。** 判别联合让"给日期用了文本格式"这种混搭写不出来。
 */
export type CellNumberFormat =
  | { readonly kind: 'general' }
  | { readonly kind: 'number'; readonly decimals: number; readonly grouping: boolean }
  | { readonly kind: 'percent'; readonly decimals: number }
  | { readonly kind: 'currency'; readonly currency: CurrencyCode; readonly decimals: number }
  | { readonly kind: 'date'; readonly pattern: DateDisplayPattern };

/** 单元格样式（部分属性；缺省 = 未显式设置，不猜测默认值）。 */
export interface CellStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly font_family?: string;
  /** 字号（磅）。 */
  readonly font_size?: number;
  /** 字体颜色（规范化为 `#RRGGBB`）。 */
  readonly font_color?: string;
  /** 底纹填充色（规范化为 `#RRGGBB`）。 */
  readonly fill_color?: string;
  readonly horizontal_align?: CellHorizontalAlign;
  readonly vertical_align?: CellVerticalAlign;
  readonly wrap_text?: boolean;
  /** 缩进级数（≥0 的整数）。 */
  readonly indent?: number;
  readonly borders?: CellBorders;
  readonly number_format?: CellNumberFormat;
  /** 单元格保护（`<protection>`）；仅 `{ locked: false }` 会写进样式表（见 {@link CellProtection}）。 */
  readonly protection?: CellProtection;
}

/** 样式表：A1 地址 → 样式。**与 `SheetState.cells` 平行、互不覆盖**（XLS-05 分开存）。 */
export type CellStyles = ReadonlyMap<string, CellStyle>;

/** 空样式表（单例；所有操作都不修改输入，只返回新表）。 */
export const emptyCellStyles: CellStyles = new Map<string, CellStyle>();

// ---------------------------------------------------------------------------
// 校验与规范化
// ---------------------------------------------------------------------------

const HEX_COLOR_PATTERN = /^#?([0-9a-fA-F]{6})$/;

/** 规范化颜色为 `#RRGGBB`（大写）。@throws {ValidationError} */
export function normalizeColor(color: unknown, where = '颜色'): string {
  if (typeof color !== 'string') {
    throw new ValidationError(`${where}必须是 #RRGGBB 字符串，收到 ${JSON.stringify(color)}`);
  }
  const match = HEX_COLOR_PATTERN.exec(color.trim());
  const hex = match?.[1];
  if (hex === undefined) {
    throw new ValidationError(`${where}必须是 #RRGGBB（6 位十六进制），收到 ${JSON.stringify(color)}`);
  }
  return `#${hex.toUpperCase()}`;
}

function requireBoolean(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${where}必须是布尔值，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

function requirePositiveNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ValidationError(`${where}必须是正有限数，收到 ${String(value)}`);
  }
  return value;
}

function requireNonNegativeInt(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${where}必须是 ≥0 的整数，收到 ${String(value)}`);
  }
  return value;
}

function requireMember<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ValidationError(
      `${where}必须是 ${allowed.join(' / ')} 之一，收到 ${JSON.stringify(value)}`,
    );
  }
  return value as T;
}

function normalizeBorderEdge(edge: unknown, where: string): CellBorderEdge {
  if (edge === null || typeof edge !== 'object') {
    throw new ValidationError(`${where}必须是边框边对象`);
  }
  const record = edge as { style?: unknown; color?: unknown };
  const style = requireMember(record.style, BORDER_LINE_STYLES, `${where}.style`);
  const color = record.color === undefined || record.color === null ? null : normalizeColor(record.color, `${where}.color`);
  return Object.freeze({ style, color });
}

function normalizeBorders(borders: unknown, where: string): CellBorders {
  if (borders === null || typeof borders !== 'object') {
    throw new ValidationError(`${where}必须是对象`);
  }
  const record = borders as Record<string, unknown>;
  const out: Record<string, CellBorderEdge> = {};
  for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    const edge = record[side];
    if (edge !== undefined) {
      out[side] = normalizeBorderEdge(edge, `${where}.${side}`);
    }
  }
  return Object.freeze(out) as CellBorders;
}

function normalizeNumberFormat(format: unknown, where: string): CellNumberFormat {
  if (format === null || typeof format !== 'object') {
    throw new ValidationError(`${where}必须是数字格式对象`);
  }
  const record = format as Record<string, unknown>;
  const kind = requireMember(
    record.kind,
    ['general', 'number', 'percent', 'currency', 'date'],
    `${where}.kind`,
  );
  switch (kind) {
    case 'general':
      return Object.freeze({ kind: 'general' });
    case 'number':
      return Object.freeze({
        kind: 'number',
        decimals: requireNonNegativeInt(record.decimals, `${where}.decimals`),
        grouping: requireBoolean(record.grouping, `${where}.grouping`),
      });
    case 'percent':
      return Object.freeze({
        kind: 'percent',
        decimals: requireNonNegativeInt(record.decimals, `${where}.decimals`),
      });
    case 'currency':
      return Object.freeze({
        kind: 'currency',
        currency: requireMember(record.currency, CURRENCY_CODES, `${where}.currency`),
        decimals: requireNonNegativeInt(record.decimals, `${where}.decimals`),
      });
    case 'date':
      return Object.freeze({
        kind: 'date',
        pattern: requireMember(record.pattern, DATE_PATTERNS, `${where}.pattern`),
      });
  }
}

/**
 * 校验并规范化一份单元格保护。
 *
 * 只认 `locked` 这一个键（与原 `CellLockState` 同形）；未知键在此**宽松忽略**，由
 * `style-parts/descriptor.ts` 的白名单在"生成 XML"的位置拦下（那才是"不得静默丢弃"的判据）。
 *
 * @throws {ValidationError} 非对象 / `locked` 不是布尔
 */
export function normalizeCellProtection(protection: unknown, where = 'protection'): CellProtection {
  if (protection === null || typeof protection !== 'object') {
    throw new ValidationError(`${where}必须是对象`);
  }
  const record = protection as Record<string, unknown>;
  const out: { locked?: boolean } = {};
  if (record.locked !== undefined) {
    out.locked = requireBoolean(record.locked, `${where}.locked`);
  }
  return Object.freeze(out) as CellProtection;
}

/** 校验并规范化一份样式（返回冻结副本）。@throws {ValidationError} */
export function normalizeCellStyle(style: CellStyle, where = '样式'): CellStyle {
  if (style === null || typeof style !== 'object') {
    throw new ValidationError(`${where}必须是对象`);
  }
  const record = style as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (record.bold !== undefined) out.bold = requireBoolean(record.bold, `${where}.bold`);
  if (record.italic !== undefined) out.italic = requireBoolean(record.italic, `${where}.italic`);
  if (record.wrap_text !== undefined) out.wrap_text = requireBoolean(record.wrap_text, `${where}.wrap_text`);
  if (record.font_family !== undefined) {
    if (typeof record.font_family !== 'string' || record.font_family.length === 0) {
      throw new ValidationError(`${where}.font_family 必须是非空字符串`);
    }
    out.font_family = record.font_family;
  }
  if (record.font_size !== undefined) out.font_size = requirePositiveNumber(record.font_size, `${where}.font_size`);
  if (record.font_color !== undefined) out.font_color = normalizeColor(record.font_color, `${where}.font_color`);
  if (record.fill_color !== undefined) out.fill_color = normalizeColor(record.fill_color, `${where}.fill_color`);
  if (record.horizontal_align !== undefined) {
    out.horizontal_align = requireMember(record.horizontal_align, HORIZONTAL_ALIGNS, `${where}.horizontal_align`);
  }
  if (record.vertical_align !== undefined) {
    out.vertical_align = requireMember(record.vertical_align, VERTICAL_ALIGNS, `${where}.vertical_align`);
  }
  if (record.indent !== undefined) out.indent = requireNonNegativeInt(record.indent, `${where}.indent`);
  if (record.borders !== undefined) out.borders = normalizeBorders(record.borders, `${where}.borders`);
  if (record.number_format !== undefined) {
    out.number_format = normalizeNumberFormat(record.number_format, `${where}.number_format`);
  }
  if (record.protection !== undefined) {
    out.protection = normalizeCellProtection(record.protection, `${where}.protection`);
  }
  return Object.freeze(out) as CellStyle;
}

// ---------------------------------------------------------------------------
// 样式表操作（不可变：输入表原样保留）
// ---------------------------------------------------------------------------

/** 读指定地址的样式；未设置 ⇒ `undefined`（**不是空样式对象**，缺省与"设为空"是两回事）。@throws {ValidationError} */
export function getCellStyle(styles: CellStyles, address: AddressInput): CellStyle | undefined {
  return styles.get(normalizeAddress(address));
}

/** 设置指定地址的样式（**整体替换**）。@throws {ValidationError} */
export function setCellStyle(styles: CellStyles, address: AddressInput, style: CellStyle): CellStyles {
  const ref = normalizeAddress(address);
  const next = new Map(styles);
  next.set(ref, normalizeCellStyle(style, `setCellStyle(${ref})`));
  return next;
}

/** 清除指定地址的样式（回到"未设置"）。@throws {ValidationError} */
export function clearCellStyle(styles: CellStyles, address: AddressInput): CellStyles {
  const ref = normalizeAddress(address);
  if (!styles.has(ref)) {
    return styles;
  }
  const next = new Map(styles);
  next.delete(ref);
  return next;
}

/**
 * 把 `patch` **合并**进指定地址已有样式（浅合并：patch 里有哪几项就改哪几项）。
 *
 * 这是"只改加粗、不动字号"之类局部修改的入口——与 {@link setCellStyle} 的整体替换互补。
 * @throws {ValidationError}
 */
export function mergeCellStyle(styles: CellStyles, address: AddressInput, patch: CellStyle): CellStyles {
  const ref = normalizeAddress(address);
  const existing = styles.get(ref) ?? {};
  const merged = normalizeCellStyle({ ...existing, ...patch }, `mergeCellStyle(${ref})`);
  const next = new Map(styles);
  next.set(ref, merged);
  return next;
}

/** 一次性可施加样式的区域上限（防止"整列"这类巨区域把内存撑爆；超限显式失败）。 */
export const MAX_STYLE_RANGE_CELLS = 250_000;

function rangeCellCount(range: CellRange): number {
  return (range.end.row - range.start.row + 1) * (range.end.column - range.start.column + 1);
}

/**
 * 把同一份 `patch` 合并进区域内的每一个地址（区域上限见 {@link MAX_STYLE_RANGE_CELLS}）。
 * @throws {ValidationError} 区域过大
 */
export function applyRangeStyle(
  styles: CellStyles,
  range: CellRange | string,
  patch: CellStyle,
): CellStyles {
  const resolved = typeof range === 'string' ? parseRange(range) : range;
  if (rangeCellCount(resolved) > MAX_STYLE_RANGE_CELLS) {
    throw new ValidationError(
      `applyRangeStyle 区域超过 ${String(MAX_STYLE_RANGE_CELLS)} 格上限，拒绝展开（避免内存爆炸）`,
    );
  }
  const normalized = normalizeCellStyle(patch, 'applyRangeStyle');
  const next = new Map(styles);
  for (let row = resolved.start.row; row <= resolved.end.row; row += 1) {
    for (let column = resolved.start.column; column <= resolved.end.column; column += 1) {
      const ref = formatCellAddress({ column, row });
      next.set(ref, normalizeCellStyle({ ...(next.get(ref) ?? {}), ...normalized }, `applyRangeStyle(${ref})`));
    }
  }
  return next;
}

/** 清空区域内全部样式（只遍历已存在的 key，成本与"已设样式的格数"成正比）。@throws {ValidationError} */
export function clearRangeStyle(styles: CellStyles, range: CellRange | string): CellStyles {
  const resolved = typeof range === 'string' ? parseRange(range) : range;
  const next = new Map(styles);
  for (const ref of styles.keys()) {
    const address = parseCellAddress(ref);
    if (
      address.column >= resolved.start.column &&
      address.column <= resolved.end.column &&
      address.row >= resolved.start.row &&
      address.row <= resolved.end.row
    ) {
      next.delete(ref);
    }
  }
  return next;
}

/**
 * 行列结构变更时迁移样式 key（XLS-04：变更后地址正确）。
 *
 * **迁移规则直接来自 `reference.ts` 的 `mapReferenceOn*`**——本模块不另造一套行号算术，
 * 与 `sheet.ts` 迁移单元格用的是同一对映射函数，因此样式与值**必然一起移动**。
 * 被删除命中的样式随之消失（`ok: false`）。
 */
export function migrateCellStyles(
  styles: CellStyles,
  axis: 'row' | 'column',
  at: number,
  count: number,
  mode: 'insert' | 'delete',
): CellStyles {
  const map = (address: { column: number; row: number }): ReferenceMapResult => {
    const reference = { ...address, abs_column: false, abs_row: false };
    if (axis === 'row') {
      return mode === 'insert'
        ? mapReferenceOnRowInsert(reference, at, count)
        : mapReferenceOnRowDelete(reference, at, count);
    }
    return mode === 'insert'
      ? mapReferenceOnColumnInsert(reference, at, count)
      : mapReferenceOnColumnDelete(reference, at, count);
  };
  const next = new Map<string, CellStyle>();
  for (const [ref, style] of styles) {
    const mapped = map(parseCellAddress(ref));
    if (!mapped.ok) {
      continue; // 落在被删区间 ⇒ 样式随行列一起消失
    }
    next.set(formatCellAddress(mapped.reference), style);
  }
  return next;
}

// ---------------------------------------------------------------------------
// 显示值（只读产出；绝不回写实际值）
// ---------------------------------------------------------------------------

function pad2(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value);
}

/**
 * 天数（相对 1970-01-01）→ 公历年月日。**Howard Hinnant 的 civil-from-days**，纯整数算术，
 * 不读墙钟、不用 `Date`。
 */
function civilFromDays(days: number): { year: number; month: number; day: number } {
  const shifted = days + 719_468;
  const era = Math.floor(shifted / 146_097);
  const doe = shifted - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const year0 = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: year0 + (month <= 2 ? 1 : 0), month, day };
}

/** epoch 毫秒按图案格式化为日期文本（纯算术；不含时区 / locale）。@throws {ValidationError} 非有限数 */
export function formatDatePattern(epochMs: number, pattern: DateDisplayPattern): string {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) {
    throw new ValidationError(`formatDatePattern 只接受有限毫秒数，收到 ${String(epochMs)}`);
  }
  const days = Math.floor(epochMs / MS_PER_DAY);
  const { year, month, day } = civilFromDays(days);
  switch (pattern) {
    case 'yyyy-mm-dd':
      return `${String(year)}-${pad2(month)}-${pad2(day)}`;
    case 'yyyy/mm/dd':
      return `${String(year)}/${pad2(month)}/${pad2(day)}`;
    case 'm/d/yyyy':
      return `${String(month)}/${String(day)}/${String(year)}`;
    case 'dd/mm/yyyy':
      return `${pad2(day)}/${pad2(month)}/${String(year)}`;
  }
}

/** 手写千分位（不用 `toLocaleString`——它依赖 locale，违反确定性）。 */
function groupThousands(intText: string): string {
  let out = '';
  let count = 0;
  for (let i = intText.length - 1; i >= 0; i -= 1) {
    out = intText.charAt(i) + out;
    count += 1;
    if (count % 3 === 0 && i > 0) {
      out = `,${out}`;
    }
  }
  return out;
}

/** 定点小数 + 可选千分位。符号在最前。 */
function formatFixed(value: number, decimals: number, grouping: boolean): string {
  const negative = value < 0;
  const fixed = Math.abs(value).toFixed(decimals);
  const dot = fixed.indexOf('.');
  const intPart = dot === -1 ? fixed : fixed.slice(0, dot);
  const fracPart = dot === -1 ? '' : fixed.slice(dot);
  const grouped = grouping ? groupThousands(intPart) : intPart;
  return `${negative ? '-' : ''}${grouped}${fracPart}`;
}

function numberToDisplay(value: number, format: CellNumberFormat | undefined): string {
  const fmt: CellNumberFormat = format ?? { kind: 'general' };
  switch (fmt.kind) {
    case 'general':
      return String(value);
    case 'number':
      return formatFixed(value, fmt.decimals, fmt.grouping);
    case 'percent':
      // 只影响显示：底层值仍是 0.5，这里才乘 100 变成 "50%"。
      return `${formatFixed(value * 100, fmt.decimals, false)}%`;
    case 'currency': {
      const negative = value < 0;
      const body = formatFixed(Math.abs(value), fmt.decimals, true);
      return `${negative ? '-' : ''}${CURRENCY_SYMBOLS[fmt.currency]}${body}`;
    }
    case 'date':
      // 数值格套日期格式：按 Excel 序列号解释成日期显示，**数值本身不变**。
      return formatDatePattern(fromExcelSerial(value), fmt.pattern);
  }
}

/**
 * 把一个单元格取值按样式渲染成**显示文本**。纯函数：不接收 `SheetState`，无副作用。
 *
 * 关键不变式（XLS-05）：
 * - **文本/布尔/错误值不套数字格式**（文本 `"0.5"` 加百分比格式仍是 `"0.5"`，不被当数字）；
 * - **日期格永远显示成日期**（不因格式被"降级"成裸数字）；
 * - 数值格套日期格式时按 **Excel 序列号**解释 —— 显示成日期，数值不变。
 */
export function formatCellDisplay(value: CellValue, style?: CellStyle): string {
  switch (value.kind) {
    case 'blank':
      return '';
    case 'text':
      return value.value;
    case 'boolean':
      return value.value ? 'TRUE' : 'FALSE';
    case 'error':
      return value.code;
    case 'formula':
      return `=${value.text}`;
    case 'date': {
      const fmt = style?.number_format;
      const pattern: DateDisplayPattern = fmt !== undefined && fmt.kind === 'date' ? fmt.pattern : 'yyyy-mm-dd';
      return formatDatePattern(value.epoch_ms, pattern);
    }
    case 'number':
      return numberToDisplay(value.value, style?.number_format);
    default: {
      const never: never = value;
      throw new ValidationError(`formatCellDisplay 未覆盖的取值：${JSON.stringify(never)}`);
    }
  }
}

/** 显示值与实际值的**并列**结果——"分别验收"的数据形状。 */
export interface CellDisplay {
  /** 按样式渲染出的显示文本。 */
  readonly display: string;
  /** **未受样式影响**的实际取值（与 `sheet` 里存的一模一样）。 */
  readonly actual: CellValue;
}

/**
 * 同时取出一个单元格的**显示值**与**实际值**。
 *
 * 实现上先读 `actual`（来自 `sheet.ts`），再把 `actual` + 样式交给
 * {@link formatCellDisplay} 产出 `display`——两条路径**不共享可写状态**，因此 `actual`
 * 不可能被格式化过程改动。
 *
 * @throws {ValidationError} 地址非法
 */
export function displayCell(sheet: SheetState, styles: CellStyles, address: AddressInput): CellDisplay {
  const actual = getCellValue(sheet, address);
  const style = getCellStyle(styles, address);
  return Object.freeze({ display: formatCellDisplay(actual, style), actual });
}

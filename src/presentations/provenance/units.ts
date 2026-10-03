/**
 * P-I25（由 P-R06 独立复核模块**提升**进 `src/`）· **数据与单位**（模型生成内容的来源、数据/单位/引用与事实版本）。
 *
 * ## 这一层解决什么
 *
 * 任务书/能力目录反复要求"金额、单位、缺失不当零"（XLS-17）、"事实抽取与**单位/日期识别**"
 * （RES-04）、"保留必要的来源数据与事实校验"（目录 §6）。演示里的数字如果**不带单位**，
 * 就无法判断"8 人"和"8 万元"是不是同一件事，也无法判断两处数字能不能比较、能不能换算。
 *
 * 本模块把"数字"钉成**带单位的量**（{@link Quantity}）：`value` 是数、`unit` 是单位符号、
 * `currency` 仅币种类量非空。构造即校验：
 *
 * - 单位不在注册表 ⇒ `unknown_unit`（不猜、不默认成无量纲）；
 * - 值是 NaN / Infinity ⇒ `non_finite_value`（缺失不得用 NaN 冒充）；
 * - 币种类量必须给 `currency` 且与单位符号一致；非币种类量不得给 `currency`。
 *
 * ## 换算：同维度才可换，跨币种不猜汇率
 *
 * - 同维度（人 ↔ 千人、秒/分/时/天、米/千米…）按**基准倍率**精确换算；
 * - 不同维度 ⇒ `incompatible_unit`（不把"人"当"元"）；
 * - **跨币种换算需要汇率**：本层**拒绝**在拿不到真实汇率时把 CNY 换成 USD（`rate_required`），
 *   而不是塞一个假汇率。这与"不许编造"的纪律一致。
 *
 * ## 确定性
 *
 * 注册表是冻结的字面量表；换算只做乘除；{@link formatQuantity} 不用 `Intl` / 本地化，
 * 因此同一输入在同一台机器上逐字符稳定。
 *
 * 本模块零 IO、零墙钟、不读环境，纯函数；错误一律是 {@link ProvenanceUnitError} 并带 `reason`。
 */

// ---------------------------------------------------------------------------
// 维度与单位定义
// ---------------------------------------------------------------------------

/** 单位维度（封闭枚举）。同维度才可比较/换算。 */
export const UNIT_DIMENSIONS = [
  'headcount',
  'currency',
  'ratio',
  'duration',
  'length',
  'mass',
] as const;
export type UnitDimension = (typeof UNIT_DIMENSIONS)[number];

/** 一个单位的定义。`factor` = 该单位 1 份等于多少个**基准单位**。 */
export interface UnitDef {
  /** 单位符号（`person` / `kperson` / `CNY` / `%` / `min` …）。 */
  readonly symbol: string;
  readonly dimension: UnitDimension;
  /** 换算到该维度基准单位的倍率（基准单位自身为 1）。 */
  readonly factor: number;
  /** 人类可读名（报告用）。 */
  readonly label: string;
}

/**
 * 单位注册表（字面量、冻结）。
 *
 * 币种类的 `factor` 一律为 1：**没有汇率就不换算**，见 {@link convertQuantity}。
 * 维度基准：headcount=`person`、currency=自身、ratio=`ratio`、duration=`s`、length=`m`、mass=`g`。
 */
const RAW_UNITS: readonly UnitDef[] = Object.freeze([
  // 人数
  { symbol: 'person', dimension: 'headcount', factor: 1, label: '人' },
  { symbol: 'kperson', dimension: 'headcount', factor: 1000, label: '千人' },
  // 币种（factor 恒为 1；跨币种需汇率）
  { symbol: 'CNY', dimension: 'currency', factor: 1, label: '人民币' },
  { symbol: 'USD', dimension: 'currency', factor: 1, label: '美元' },
  { symbol: 'EUR', dimension: 'currency', factor: 1, label: '欧元' },
  { symbol: 'JPY', dimension: 'currency', factor: 1, label: '日元' },
  { symbol: 'GBP', dimension: 'currency', factor: 1, label: '英镑' },
  // 比率
  { symbol: 'ratio', dimension: 'ratio', factor: 1, label: '倍率' },
  { symbol: '%', dimension: 'ratio', factor: 0.01, label: '百分比' },
  // 时长
  { symbol: 's', dimension: 'duration', factor: 1, label: '秒' },
  { symbol: 'min', dimension: 'duration', factor: 60, label: '分钟' },
  { symbol: 'h', dimension: 'duration', factor: 3600, label: '小时' },
  { symbol: 'day', dimension: 'duration', factor: 86400, label: '天' },
  // 长度
  { symbol: 'mm', dimension: 'length', factor: 0.001, label: '毫米' },
  { symbol: 'cm', dimension: 'length', factor: 0.01, label: '厘米' },
  { symbol: 'm', dimension: 'length', factor: 1, label: '米' },
  { symbol: 'km', dimension: 'length', factor: 1000, label: '千米' },
  // 质量
  { symbol: 'g', dimension: 'mass', factor: 1, label: '克' },
  { symbol: 'kg', dimension: 'mass', factor: 1000, label: '千克' },
  { symbol: 't', dimension: 'mass', factor: 1_000_000, label: '吨' },
]);

/** 冻结的 `符号 → 定义` 注册表。 */
export const PROVENANCE_UNIT_REGISTRY: Readonly<Record<string, UnitDef>> = Object.freeze(
  Object.fromEntries(RAW_UNITS.map((unit) => [unit.symbol, unit])),
);

/** 全部已登记单位（稳定顺序，供报告/用例枚举）。 */
export const PROVENANCE_UNITS: readonly UnitDef[] = RAW_UNITS;

/** 单位错误的封闭原因集。 */
export const PROVENANCE_UNIT_ERROR_REASONS = [
  'empty_unit',
  'unknown_unit',
  'non_finite_value',
  'currency_required',
  'currency_not_allowed',
  'incompatible_unit',
  'rate_required',
] as const;
export type ProvenanceUnitErrorReason = (typeof PROVENANCE_UNIT_ERROR_REASONS)[number];

/** 单位/量化相关错误。 */
export class ProvenanceUnitError extends Error {
  readonly reason: ProvenanceUnitErrorReason;

  constructor(reason: ProvenanceUnitErrorReason, message: string) {
    super(message);
    this.name = 'ProvenanceUnitError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 带单位的量
// ---------------------------------------------------------------------------

/** 带单位的量：数 + 单位符号 +（仅币种类非空的）币种。 */
export interface Quantity {
  readonly value: number;
  readonly unit: string;
  readonly currency: string | null;
}

/** 取单位定义；未登记 ⇒ `undefined`（不抛，供调用方自行决定语义）。 */
export function unitDef(unit: string): UnitDef | undefined {
  return PROVENANCE_UNIT_REGISTRY[unit];
}

/**
 * 取单位维度；未登记单位**抛** {@link ProvenanceUnitError}（`unknown_unit`）。
 * 暴露"未登记"是刻意的：安静地当成无量纲会让"人 vs 元"的比较通过。
 */
export function dimensionOf(unit: string): UnitDimension {
  const def = unitDef(unit);
  if (def === undefined) {
    throw new ProvenanceUnitError('unknown_unit', `未登记的单位符号 ${JSON.stringify(unit)}`);
  }
  return def.dimension;
}

/**
 * 构造一个带单位的量（构造即校验）。
 *
 * @throws {ProvenanceUnitError}
 * - `non_finite_value`：`value` 不是有限数；
 * - `empty_unit`：单位符号为空串；
 * - `unknown_unit`：单位不在注册表；
 * - `currency_required`：币种类量未给非空 `currency`；
 * - `currency_required`：币种类量的 `currency` 与单位符号不一致；
 * - `currency_not_allowed`：非币种类量却给了 `currency`。
 */
export function parseQuantity(value: number, unit: string, currency: string | null = null): Quantity {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProvenanceUnitError(
      'non_finite_value',
      `量值必须是有限数，收到 ${String(value)}（缺失不得用 NaN / Infinity 冒充）`,
    );
  }
  if (unit.length === 0) {
    throw new ProvenanceUnitError('empty_unit', '单位符号不得为空串');
  }
  const def = unitDef(unit);
  if (def === undefined) {
    throw new ProvenanceUnitError(
      'unknown_unit',
      `未登记的单位符号 ${JSON.stringify(unit)}（不得默认成无量纲）`,
    );
  }
  if (def.dimension === 'currency') {
    if (currency === null || currency.length === 0) {
      throw new ProvenanceUnitError(
        'currency_required',
        `币种类量 ${unit} 必须携带非空 currency`,
      );
    }
    if (currency !== unit) {
      throw new ProvenanceUnitError(
        'currency_required',
        `币种类量的 currency（${currency}）必须等于单位符号（${unit}）`,
      );
    }
  } else if (currency !== null) {
    throw new ProvenanceUnitError(
      'currency_not_allowed',
      `非币种类量（单位 ${unit}，维度 ${def.dimension}）不得携带 currency（收到 ${currency}）`,
    );
  }
  return Object.freeze({ value, unit, currency });
}

/** 两个单位是否同维度（可比较/换算）。任一未登记 ⇒ 抛 `unknown_unit`。 */
export function unitsCompatible(left: string, right: string): boolean {
  return dimensionOf(left) === dimensionOf(right);
}

/**
 * 把量换算到目标单位。
 *
 * @throws {ProvenanceUnitError}
 * - `unknown_unit`：任一侧单位未登记；
 * - `incompatible_unit`：两侧维度不同；
 * - `rate_required`：跨币种换算（无汇率不得猜）。
 */
export function convertQuantity(quantity: Quantity, toUnit: string): Quantity {
  const from = unitDef(quantity.unit);
  if (from === undefined) {
    throw new ProvenanceUnitError('unknown_unit', `未登记的单位符号 ${JSON.stringify(quantity.unit)}`);
  }
  const to = unitDef(toUnit);
  if (to === undefined) {
    throw new ProvenanceUnitError('unknown_unit', `未登记的单位符号 ${JSON.stringify(toUnit)}`);
  }
  if (from.dimension !== to.dimension) {
    throw new ProvenanceUnitError(
      'incompatible_unit',
      `维度不同不可换算：${from.dimension} → ${to.dimension}（${from.symbol} → ${to.symbol}）`,
    );
  }
  if (from.dimension === 'currency' && from.symbol !== to.symbol) {
    throw new ProvenanceUnitError(
      'rate_required',
      `跨币种换算（${from.symbol} → ${to.symbol}）需要真实汇率；本层不猜汇率`,
    );
  }
  const value = (quantity.value * from.factor) / to.factor;
  return parseQuantity(value, to.symbol, to.dimension === 'currency' ? to.symbol : null);
}

/** 稳定数字格式：整数直出，小数最多 6 位且去尾零（不用 `Intl` / 本地化）。 */
export function formatQuantityNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  const fixed = value.toFixed(6);
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
}

/** 确定性人类可读：`8 人`、`CNY 1200`、`15%`、`2 h`。 */
export function formatQuantity(quantity: Quantity): string {
  const def = unitDef(quantity.unit);
  const number = formatQuantityNumber(quantity.value);
  if (def === undefined) return `${number} ${quantity.unit}`;
  if (def.dimension === 'currency') return `${quantity.currency ?? quantity.unit} ${number}`;
  if (quantity.unit === '%') return `${number}%`;
  return `${number} ${def.label}`;
}

/**
 * 从事实值视图里的**数值载荷**造量（跨层复用：protocol 的 `NumberFactValue` 结构上满足）。
 *
 * 这是"事实值 → 带单位量"的**唯一**入口：调用方拿不到"只搬数、不带单位"的机会。
 */
export function quantityFromFactValue(factValue: {
  readonly type: 'number';
  readonly amount: number;
  readonly unit: string;
  readonly currency: string | null;
}): Quantity {
  return parseQuantity(factValue.amount, factValue.unit, factValue.currency);
}

/** 两个量是否**完全相等**（数、单位、币种三者都要一致；不做隐式换算）。 */
export function quantityEquals(left: Quantity, right: Quantity): boolean {
  return left.value === right.value && left.unit === right.unit && left.currency === right.currency;
}

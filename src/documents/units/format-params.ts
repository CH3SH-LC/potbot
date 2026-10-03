/**
 * 格式参数校验域（R153，配合 R147/R150）。**唯一权威实现。**
 *
 * ## 为什么格式参数要有自己的"域"
 *
 * R153 要求：格式参数（12pt / 1.5 倍 / 2 字缩进 / 页边距）与业务数字（8 人、600 元）
 * 走**不同的**校验域。原因在 R147 与 R150：
 *
 * - R147：只改格式时，原文数字原样保留，**不强迫用户逐个确认原文数字**；
 * - R150：页码、列表序号、**格式参数**（12pt、1.5 倍、2 字）**不是**业务事实——
 *   不得进事实快照，也不得被 `untraceableDigitRuns` 误杀为"凭空数字"。
 *
 * 如果格式参数和业务数字共用一个通道，那么"把第二段设成 12 磅"里的 `12` 就会被事实护栏
 * 当成一个凭空出现的数字要用户确认——这正是要避免的。
 *
 * ## 本模块给出的东西
 *
 * - `FORMAT_PARAMETER_DOMAIN` / `BUSINESS_NUMBER_DOMAIN`：两个**不同的域标签**；
 * - `FormatParameter`：带域标签的结构化格式值（不是裸数字）；
 * - `validateFormatParameter`：在**格式域内**做范围校验（如字号 1–819pt），
 *   校验失败给出格式域专属的原因，与业务域的"数字是否可追溯"完全无关。
 *
 * ## 边界
 *
 * 本模块**不实现**事实快照（那属其他包）。它只保证：格式值在本项目里**天然携带域标签**，
 * 无法被误当成业务数字，且校验走自己的规则。
 */

/** 格式参数域标签。 */
export const FORMAT_PARAMETER_DOMAIN = 'format' as const;

/** 业务数字域标签（本模块只声明，用于断言两域不同）。 */
export const BUSINESS_NUMBER_DOMAIN = 'business' as const;

/** 可校验的格式字段。 */
export type FormatField =
  | 'fontSizePt'
  | 'lineSpacingMultiple'
  | 'paragraphSpacingPt'
  | 'paragraphSpacingLines'
  | 'indentChars'
  | 'indentTwips'
  | 'pageMarginTwips'
  | 'tabStopTwips';

/** 带域标签的格式参数值。**刻意不是裸 `number`。** */
export interface FormatParameter {
  readonly domain: typeof FORMAT_PARAMETER_DOMAIN;
  readonly field: FormatField;
  readonly value: number;
}

/** 校验结果。 */
export type FormatValidation =
  | { readonly ok: true; readonly parameter: FormatParameter }
  | { readonly ok: false; readonly field: FormatField; readonly value: number; readonly reason: string; readonly domain: typeof FORMAT_PARAMETER_DOMAIN };

/** 每个格式字段的取值边界（闭区间）与是否必须为整数。 */
interface FieldBounds {
  readonly min: number;
  readonly max: number;
  readonly integer: boolean;
  readonly unit: string;
}

/**
 * 格式域边界。数值取 OOXML 实际可承载范围：
 *
 * - `w:sz` 是半点、上限 1638 ⇒ 字号上限 819pt；
 * - `w:line`(exact/atLeast) 是 twips，字面上限很大，但按 Word 界面上限取 1584pt（=31680 twips）；
 * - 倍数行距取 OOXML 支持的 (0, 100]；
 * - 缩进字符数按 Word 可表达范围 0–9999 字。
 */
const FIELD_BOUNDS: Readonly<Record<FormatField, FieldBounds>> = {
  fontSizePt: { min: 1, max: 819, integer: false, unit: 'pt' },
  lineSpacingMultiple: { min: 0.03125, max: 100, integer: false, unit: 'x' },
  paragraphSpacingPt: { min: 0, max: 1584, integer: false, unit: 'pt' },
  paragraphSpacingLines: { min: 0, max: 999, integer: false, unit: 'line' },
  indentChars: { min: 0, max: 9999, integer: false, unit: 'char' },
  indentTwips: { min: -31680, max: 31680, integer: true, unit: 'twips' },
  pageMarginTwips: { min: 0, max: 31680, integer: true, unit: 'twips' },
  tabStopTwips: { min: 0, max: 31680, integer: true, unit: 'twips' },
};

/**
 * 在**格式域内**校验一个格式参数。
 *
 * 注意：这里既不查"这个数字在原文里出现过吗"，也不产 `untraceableDigitRuns` 之类的结论——
 * 那些属于业务域（R153）。本函数只回答"这个格式值本身是否合法、是否在可表达范围内"。
 */
export function validateFormatParameter(field: FormatField, value: number): FormatValidation {
  const bounds = FIELD_BOUNDS[field];
  const fail = (reason: string): FormatValidation => ({ ok: false, field, value, reason, domain: FORMAT_PARAMETER_DOMAIN });

  if (!Number.isFinite(value)) return fail(`格式值必须是有限数，收到 ${String(value)}`);
  if (bounds.integer && !Number.isInteger(value)) {
    return fail(`${field} 必须是整数(${bounds.unit})，收到 ${value}`);
  }
  if (value < bounds.min || value > bounds.max) {
    return fail(`${field} 超出可表达范围 [${bounds.min}, ${bounds.max}] ${bounds.unit}，收到 ${value}`);
  }
  return { ok: true, parameter: { domain: FORMAT_PARAMETER_DOMAIN, field, value } };
}

/** 运行时守卫：某值是否已被标记为格式参数（而非业务数字）。 */
export function isFormatParameter(value: unknown): value is FormatParameter {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { domain?: unknown; field?: unknown; value?: unknown };
  return (
    candidate.domain === FORMAT_PARAMETER_DOMAIN &&
    typeof candidate.field === 'string' &&
    candidate.field in FIELD_BOUNDS &&
    typeof candidate.value === 'number'
  );
}

/** 校验并丢弃失败细节，成功返回格式参数（供操作层内部使用）。 */
export function requireFormatParameter(field: FormatField, value: number): FormatParameter {
  const result = validateFormatParameter(field, value);
  if (!result.ok) throw new RangeError(result.reason);
  return result.parameter;
}

/** 格式域的全部字段（供测试枚举覆盖）。 */
export const FORMAT_FIELDS: readonly FormatField[] = Object.freeze(
  Object.keys(FIELD_BOUNDS) as FormatField[],
);

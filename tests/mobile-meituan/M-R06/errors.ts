/**
 * M-R06 —— **可机读拒因词表与错误类型**（零依赖、无 IO）。
 *
 * ## 为什么拒因必须是错误码
 *
 * 本包拦的是三类**外部注入**：商家描述里的伪指令、越权工具参数、非官方 endpoint。
 * 若拒因退化成 `false`，调用方无法区分：
 * - "这段描述是**数据**、只是恰好含敏感词"（应放行，但打标），与
 * - "这段描述在**冒充系统指令**"（应拦截）；
 * - "参数多余"（可丢弃）与"参数在**试图下单**"（必须硬拒）。
 *
 * 三种拒绝各有自己的语义，所以各有自己的 `code`；验收按 `code` 断言，
 * 而不是按字符串包含。
 */

/** M-R06 全部可机读拒因（新增必须在此登记）。 */
export const M06_ERROR_CODES = [
  // --- 商品描述注入 ---
  /** 描述不是字符串（null / 数字 / 对象）。描述必须是纯文本数据。 */
  'invalid_description',
  /** 描述在冒充系统/角色指令且处于**严格模式**，拒绝把它交给模型。 */
  'description_injection_blocked',

  // --- 越权工具参数 ---
  /** 工具 ID 不在已登记工具清单里。 */
  'unknown_tool',
  /** 参数名未在该工具的 schema 里声明（越界字段）。 */
  'undeclared_parameter',
  /** 参数名是购买/支付类动作（place_order / submit_order / pay …）：读工具不得携带。 */
  'forbidden_purchase_parameter',
  /** 参数试图升级权限范围（scope 超出该工具允许值）。 */
  'scope_escalation',
  /** 参数类型与 schema 声明不符。 */
  'invalid_parameter_type',
  /** schema 声明的必填参数缺失。 */
  'missing_required_parameter',
  /** 参数名是原型污染类危险键（__proto__ / constructor / prototype）。 */
  'unsafe_parameter_key',
  /** 参数取值不在 schema 的 enumValues 里。 */
  'enum_value_not_allowed',

  // --- 非官方 endpoint ---
  /** URL 无法解析 / 携带 userinfo（形如 host@evil）。 */
  'invalid_endpoint_url',
  /** scheme 不是 https（http / ws / javascript / data / file …）。 */
  'insecure_endpoint_scheme',
  /** host 不在官方 allowlist 内（含后缀仿冒 meituan.com.evil）。 */
  'non_official_endpoint',
  /** host 是 IP 字面量（IPv4 / IPv6）——官方接口不会用裸 IP。 */
  'ip_literal_endpoint',
  /** host 含非 ASCII / punycode（xn--）混淆字符。 */
  'non_ascii_host',
  /** 显式端口不是 443。 */
  'non_default_port',
  /** 查询串里嵌套了指向非官方 host 的绝对 URL（开放重定向/端点走私）。 */
  'nested_non_official_endpoint',
] as const;

export type M06ErrorCode = (typeof M06_ERROR_CODES)[number];

/** 本包唯一的错误类型。所有硬拒绝都抛它。 */
export class M06GuardError extends Error {
  readonly code: M06ErrorCode;
  /** 命中问题的字段/参数名/信号名（无则为 null）。 */
  readonly subject: string | null;

  constructor(code: M06ErrorCode, detail: string, subject: string | null = null) {
    super(`[${code}]${subject === null ? '' : `[${subject}]`} ${detail}`);
    this.name = 'M06GuardError';
    this.code = code;
    this.subject = subject;
  }
}

/** 跨打包边界稳定的守卫（`instanceof` 可能在打包后失效，故同时看 `code`）。 */
export function isM06GuardError(value: unknown): value is M06GuardError {
  return (
    value instanceof M06GuardError ||
    (typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      typeof (value as { code: unknown }).code === 'string' &&
      (M06_ERROR_CODES as readonly string[]).includes((value as { code: string }).code))
  );
}

/**
 * K-I04 宿主装配 —— 宿主层错误（结构边界错误，不是执行结果）。
 *
 * 装配层（`host/**`）把 K01 引导层的固定命令路由（`command.operation`）桥接到各业务模块的
 * 子操作上。**载荷缺字段 / 子操作名不认识 / 时钟不可解析** 属于调用方或配置缺陷，发生在
 * 信任边界之外，按 K01 分层口径**抛结构化错误**，不伪装成 `event`（见 bootstrap/errors.ts）。
 *
 * 业务模块自身抛出的**域错误**（`DispatchError` / `TemplateError` / `AuthorizationError` /
 * `ValidationError`）由各适配器捕获后转成 `failed` 事件（带域错误码），不走本类型。
 */

/** 宿主层可机读错误码（封闭枚举）。 */
export const HOST_ERROR_CODES = [
  /** 载荷缺必填字段 / 字段类型不符（宿主扩展槽 `args` / `filters` 读取失败）。 */
  'HOST_PAYLOAD_INVALID',
  /** 子操作名不在该模块的允许集合里。 */
  'HOST_OP_UNKNOWN',
  /** 注入时钟无法解析为数字（模板/派发/账本需要 `now(): number`）。 */
  'HOST_CLOCK_INVALID',
] as const;

export type HostErrorCode = (typeof HOST_ERROR_CODES)[number];

/** 宿主装配层错误。`field` 是可选的定位字段（沿用 K06 的风格）。 */
export class HostError extends Error {
  readonly code: string;
  readonly field: string | null;

  constructor(code: string, message: string, field: string | null = null) {
    super(message);
    this.name = 'HostError';
    this.code = code;
    this.field = field;
  }
}

export function hostError(code: string, message: string, field: string | null = null): HostError {
  return new HostError(code, message, field);
}

export function isHostError(value: unknown): value is HostError {
  return value instanceof HostError;
}

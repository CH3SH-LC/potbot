/**
 * 手机美团插件 · 协议层业务错误码目录与分类器（零依赖、纯函数）。
 *
 * > 生产出处：本模块由 M-R01 备用包 `tests/mobile-meituan/M-R01/error-codes.ts`
 * > **提升**到生产源码树（M-R01 集成请求 #1）。唯一的行为差异：`WireTransport` 的
 * > `bodyCode` 放宽为 `string | null | undefined`，使"**码缺失**"成为**可表达**的输入
 * > （原类型只允许 `string`，但运行时已处理非字符串；M-I11 要求显式覆盖 absent）。
 *
 * ## 与 M07 `order-submit/codes.ts` 的分工
 *
 * M07 在**领域层**处理字符串业务码（`ok` / `sold_out` / `duplicate_order`…），
 * 判据是"HTTP 200 + 业务失败不得报成功"。本模块在**wire 层**补两件事：
 * 1. 平台信封里的**数值/符号错误码**目录（`code: 1002` 这类），供适配器把 wire 码
 *    映射到 M07 的领域语义；
 * 2. **传输 + 业务两段**合一分类，输出是否 `retryable` / `requiresOrderQuery`，
 *    并强制"未登记码 ⇒ unknown（绝不 ok）"。
 *
 * ## 洞
 *
 * 若适配器只做 `if (body.code === 0) ok else reject`，那么**未登记的新码**会被当成 reject，
 * 而**平台限流 / 系统繁忙**这类"可能已受理"的码会被当成确定性失败——既误报失败，
 * 又可能触发不该有的"重新下单"。本模块把 `requiresOrderQuery`（是否必须先查原单）
 * 从分类里显式导出，堵住这个洞。
 *
 * ## 如实声明
 *
 * 下表的码值**不是**从官方文档核验得到的（M01 未核验 endpoint），是**可替换的示例登记**。
 * 判定算法不依赖具体码值：替换登记表即可，分类逻辑不变。
 */

export const WIRE_ERROR_CATEGORIES = [
  'ok',
  'business_reject',
  'auth',
  'rate_limit',
  'client_error',
  'server_error',
  'unknown',
] as const;
export type WireErrorCategory = (typeof WIRE_ERROR_CATEGORIES)[number];

/** 一条 wire 错误码登记。 */
export interface WireErrorCodeSpec {
  readonly code: string;
  readonly symbol: string;
  readonly category: WireErrorCategory;
  readonly message: string;
  /** 明确可安全重试（未改变外部状态）。 */
  readonly retryable: boolean;
  /** 必须先查原单才能收口（结果可能已产生）。 */
  readonly requiresOrderQuery: boolean;
}

/** 示例 wire 码登记表（synthetic-unverified；替换此表即可接入真实码）。 */
export const WIRE_ERROR_CODE_TABLE: readonly WireErrorCodeSpec[] = Object.freeze([
  Object.freeze({ code: '0', symbol: 'ok', category: 'ok', message: '成功', retryable: false, requiresOrderQuery: false }),
  Object.freeze({ code: '1000', symbol: 'dish_unavailable', category: 'business_reject', message: '菜品不可售', retryable: false, requiresOrderQuery: false }),
  Object.freeze({ code: '1001', symbol: 'below_min_order', category: 'business_reject', message: '未达起送价', retryable: false, requiresOrderQuery: false }),
  Object.freeze({ code: '1002', symbol: 'out_of_delivery_range', category: 'business_reject', message: '超出配送范围', retryable: false, requiresOrderQuery: false }),
  Object.freeze({ code: '1003', symbol: 'price_changed', category: 'business_reject', message: '价格已变动', retryable: false, requiresOrderQuery: false }),
  Object.freeze({ code: '2001', symbol: 'invalid_address', category: 'business_reject', message: '地址无效', retryable: false, requiresOrderQuery: false }),
  Object.freeze({ code: '3001', symbol: 'session_expired', category: 'auth', message: '登录态失效', retryable: false, requiresOrderQuery: false }),
  Object.freeze({ code: '3002', symbol: 'permission_denied', category: 'auth', message: '无下单权限', retryable: false, requiresOrderQuery: false }),
  Object.freeze({ code: '4290', symbol: 'too_many_requests', category: 'rate_limit', message: '请求过于频繁', retryable: true, requiresOrderQuery: false }),
  Object.freeze({ code: '4001', symbol: 'duplicate_order', category: 'unknown', message: '重复下单：须查原单证实', retryable: false, requiresOrderQuery: true }),
  Object.freeze({ code: '5000', symbol: 'system_busy', category: 'server_error', message: '系统繁忙', retryable: true, requiresOrderQuery: true }),
  Object.freeze({ code: '9999', symbol: 'unclassified', category: 'unknown', message: '未分类业务码占位', retryable: false, requiresOrderQuery: true }),
] as const);

const TABLE_BY_CODE: ReadonlyMap<string, WireErrorCodeSpec> = new Map(
  WIRE_ERROR_CODE_TABLE.map((entry) => [entry.code, entry]),
);

const TABLE_BY_SYMBOL: ReadonlyMap<string, WireErrorCodeSpec> = new Map(
  WIRE_ERROR_CODE_TABLE.map((entry) => [entry.symbol, entry]),
);

/** 按数值/字符串码查；未登记返回 undefined（调用方**不得**当成功）。 */
export function lookupWireErrorCode(code: string): WireErrorCodeSpec | undefined {
  return TABLE_BY_CODE.get(code);
}

/** 按符号查（便于可读 fixture 用 `duplicate_order` 代替裸数字）。 */
export function lookupWireErrorSymbol(symbol: string): WireErrorCodeSpec | undefined {
  return TABLE_BY_SYMBOL.get(symbol);
}

export interface WireErrorClassification {
  readonly category: WireErrorCategory;
  /** 可安全重试（未改变外部状态）。 */
  readonly retryable: boolean;
  /** 必须先查原单（结果可能已产生 / 未知）。 */
  readonly requiresOrderQuery: boolean;
  readonly reason: string;
}

/**
 * 传输层结果（与 M07 `OrderTransportResult` 同构，本包独立定义避免跨包耦合）。
 *
 * `bodyCode` 为**可选**（`string | null | undefined`）：平台信封里"业务码缺失"是真实存在的
 * 形态，必须能被表达并**失败关闭**为 `unknown`，而不是被默认成 `ok` 或抛类型错误。
 */
export type WireTransport =
  | { readonly transport: 'response'; readonly httpStatus: number; readonly bodyCode?: string | null }
  | { readonly transport: 'timeout'; readonly detail: string }
  | { readonly transport: 'network_error'; readonly detail: string };

function unknownResult(reason: string, requiresOrderQuery = true): WireErrorClassification {
  return Object.freeze({ category: 'unknown', retryable: true, requiresOrderQuery, reason });
}

/**
 * 传输 + 业务两段分类。**没有任何分支仅凭 `httpStatus === 200` 返回 `ok`**；
 * `ok` 只可能来自"2xx **且** 登记码为 ok"。
 *
 * 2xx 且业务码**缺失 / 空 / 未登记**一律 `unknown`（`requiresOrderQuery: true`）。
 */
export function classifyWireError(result: WireTransport): WireErrorClassification {
  if (result === null || typeof result !== 'object') {
    return unknownResult('执行器未返回可解释的结果对象');
  }
  if (result.transport === 'timeout') {
    return unknownResult(`提交超时（${result.detail}）：可能已到达平台，须查原单`);
  }
  if (result.transport === 'network_error') {
    return unknownResult(`网络错误（${result.detail}）：无法判断是否已到达平台，须查原单`);
  }

  const { httpStatus, bodyCode } = result;
  if (!Number.isInteger(httpStatus)) {
    return unknownResult(`HTTP 状态码非整数：${String(httpStatus)}`);
  }
  if (httpStatus === 429) {
    return Object.freeze({ category: 'rate_limit', retryable: true, requiresOrderQuery: false, reason: 'HTTP 429：被限流，未受理，可退避重试' });
  }
  if (httpStatus >= 500) {
    return unknownResult(`HTTP ${httpStatus}（服务端异常）：结果不可知，须查原单`);
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return Object.freeze({ category: 'auth', retryable: false, requiresOrderQuery: false, reason: `HTTP ${httpStatus}：鉴权/授权失败，须重新取得授权` });
  }
  if (httpStatus >= 400) {
    return Object.freeze({ category: 'client_error', retryable: false, requiresOrderQuery: false, reason: `HTTP ${httpStatus}：请求被明确拒绝，不构成下单` });
  }
  if (httpStatus >= 200 && httpStatus < 300) {
    // 缺失 / null / 非字符串（含空串）都落到"未登记 ⇒ unknown"。
    const spec = lookupWireErrorCode(typeof bodyCode === 'string' ? bodyCode : '');
    if (spec === undefined) {
      const shown = bodyCode === undefined ? '(缺失)' : bodyCode === null ? '(null)' : bodyCode === '' ? '(空)' : bodyCode;
      return unknownResult(`HTTP ${httpStatus} 但业务码 ${shown} 未登记：不得当成功，须查原单`);
    }
    return Object.freeze({
      category: spec.category,
      retryable: spec.retryable,
      requiresOrderQuery: spec.requiresOrderQuery,
      reason: `HTTP ${httpStatus} 且业务码 ${spec.code}(${spec.symbol}) 判为 ${spec.category}`,
    });
  }
  return unknownResult(`HTTP ${httpStatus} 不属于可解释范围：须查原单`);
}

/** 是否可声称"已被平台受理/成功"。**只有 `ok`**。 */
export function mayReportWireSuccess(classification: WireErrorClassification): boolean {
  return classification.category === 'ok';
}

/** 传给 M07 领域层的候选语义（把 wire 码翻译成领域字符串码；未登记 ⇒ 保持原码以便未知）。 */
export function toDomainBusinessCode(bodyCode: string): string {
  const spec = lookupWireErrorCode(bodyCode);
  return spec === undefined ? bodyCode : spec.symbol;
}

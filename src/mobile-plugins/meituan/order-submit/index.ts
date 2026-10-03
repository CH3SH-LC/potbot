/**
 * `src/mobile-plugins/meituan/order-submit` 唯一公开出口（M07：下单提交状态机与幂等语义）。
 *
 * ## 本包做了什么
 *
 * - **提交请求构造**：`buildOrderSubmitRequest` 必须携带幂等键 + K07 语义的一次性
 *   授权引用 + 参数摘要；授权引用必须可信（`createAuthorizationRef` 签发）。
 * - **业务结果码映射**：`classifySubmitResponse` 两段判定（传输 + 业务），
 *   "HTTP 200 但业务失败"落到 `business_failure`，**绝不**是成功。
 * - **幂等**：`computeIdempotencyKey` 由九项绑定确定性导出；同键最多一单。
 * - **未知只查原单**：`unknown` 态再次 `submit()` 被拒（`already_sent_query_only`），
 *   唯一合法动作是 `queryOriginalOrder()`。
 * - **恢复**：`recover()` 只辨明"未发出 / 已发出未知 / 等回执 / 已落定"，
 *   且类型层面不表达"新建订单 / 另发授权"。
 *
 * ## 本包**没有**做什么（边界）
 *
 * - **零网络**：不 import `node:*`，不 import 第三方；执行器与查询端口一律**注入**，
 *   包内只有 fixture 实现。
 * - **不接真实美团接口、不下单、不支付**：真实平台能力尚未核实；任何 fixture "成功"
 *   都不构成真实订单或回执。
 * - **未接 K07 账本与 Android 进程**：授权引用由本包本地签发器产生（同语义）；
 *   真机上应由 K07 账本签发后经适配层传入。
 * - **未持久化到手机 DB**：`createInMemoryOrderStore` 只保证单进程幂等。
 */

export * from './types.js';
export * from './errors.js';
export * from './codes.js';
export * from './authorization.js';
export * from './idempotency.js';
export * from './receipt.js';
export * from './store.js';
export * from './submitter.js';
export * from './fixture.js';

/**
 * 购买边界常量（**结构性声明，不是开关**）。
 *
 * 本包**实现**的正是"下单提交"这一环——但它实现的是**纪律**（授权、结果码、幂等、
 * 未知只查原单），而不是一条到平台的通道：包内没有任何网络调用，执行器由外部注入，
 * 且没有任何真实平台已接通。
 */
export const ORDER_SUBMIT_BOUNDARY = Object.freeze({
  /** 本包自带真实网络调用。 */
  hasRealNetworkCall: false,
  /** 本包内部是否自带执行器实现（必须注入）。 */
  selfExecutorOnly: false,
  /** 真实美团平台是否已接通。 */
  connectsRealPlatform: false,
  /** 本次是否发生真实下单 / 支付。 */
  performsRealOrder: false,
  note:
    'M07 只实现下单提交的状态机与幂等纪律：执行器/查询端口一律注入，包内实现均为 fixture，' +
    '没有任何真实网络调用，也不代表已接通任何真实平台。',
} as const);

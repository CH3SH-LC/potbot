/**
 * `src/mobile-plugins/meituan/payment` 唯一公开出口（M08：官方支付页/SDK、可信链接、回跳、用户支付/取消/失效）。
 *
 * ## 本包做了什么
 *
 * - **官方支付入口如实建模**：`PaymentHandoff` 只能由受控签发器产生，链接必须过
 *   `TrustedLinkPolicy` 白名单（https + 精确域名 + 无内嵌凭据）；
 *   `describeExternalStep` 把「外部支付步骤」如实说出；
 * - **回跳只触发查询**：`handleReturn` 只推进到 `callback_pending_verification`，
 *   即便 URL 里写着 `success` 也不置已付款；
 * - **读回才确认已付款**：`refresh(port)` 拿到**受控签发**且**逐项匹配**的
 *   `PaymentReadback.paidState === 'paid'` 才进入 `confirmed_paid`；
 * - **不代填凭据**：`sensitive.ts` 对含 cardNumber / CVV / OTP / PIN 的载荷直接拒绝；
 * - **用户支付 / 取消 / 失效**是三条独立的词（`confirmed_paid` / `user_cancelled` / `expired`）；
 * - **不匹配即阻断**：读回任一项与本地意图不符 ⇒ 阻断跟踪，须显式 `acknowledge()`。
 *
 * ## 本包**没有**做什么（边界）
 *
 * - **零网络、零凭据**：不 import `node:*`，不 import 第三方；端口一律**注入**，
 *   包内只有 fixture 实现；不收集、不存储、不传输任何银行卡/验证码/PIN；
 * - **不接真实美团支付接口**：真实支付域名与读回码表尚未核实（M01）；fixture 读回
 *   在 `fixture` 模式下**不可能**报已付款（契约不变量，构造即抛）；
 * - **不提交订单、不自动扣款**：本包只管「用户已在外部完成支付后如何被确认」；
 * - **未接 K07 账本与 Android 进程**：真机上读回应由 K07/适配层提供可信来源。
 */

export * from './types.js';
export * from './errors.js';
export * from './money.js';
export * from './sensitive.js';
export * from './links.js';
export * from './readback.js';
export * from './tracker.js';
export * from './fixture.js';
// M08×M09 桥：回跳 → M09 resumeAfterDisconnect（query-first）→ paid 阶段报告。
// 只读依赖 `../order-lifecycle/`，不修改其任何文件。
export * from './lifecycle-bridge.js';

/**
 * 支付边界常量（**结构性声明，不是开关**）。
 *
 * 工作书要求「不代填银行卡/验证码/PIN；回跳只触发状态查询，平台读回才能确认已付款」。
 * 这里把边界写成常量，让下游接线者一眼看到：本包**不是**收款通道，也不自报已接通平台。
 */
export const PAYMENT_BOUNDARY = Object.freeze({
  /** 本包是否收集银行卡号 / CVV / 验证码 / PIN。 */
  collectsPaymentCredentials: false,
  /** 本包是否提交支付 / 自动扣款。 */
  submitsPayment: false,
  /** 本包是否在**没有平台读回**的情况下确认已付款。 */
  confirmsPaymentWithoutReadback: false,
  /** 本包是否允许「回跳即成功」。 */
  treatsCallbackAsPaid: false,
  /** 本包是否自带真实网络调用。 */
  hasRealNetworkCall: false,
  /** 真实美团支付平台是否已接通。 */
  connectsRealPlatform: false,
  note:
    'M08 只做官方支付入口交接、回跳核验与平台读回确认：端口一律注入、包内均为 fixture，' +
    '不收集支付凭据、不提交支付、不把回跳当已付款；真实平台能力待在 M01/M02 核验后接通。',
} as const);

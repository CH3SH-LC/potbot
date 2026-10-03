/**
 * `src/mobile-plugins/meituan/purchase-confirmation` 唯一公开出口（M06：升级美团业务合同、
 * 确认 ViewModel、订单参数摘要与金额上限）。
 *
 * ## 本包做了什么
 *
 * - **升级后的业务合同（v2）**：新增下单/支付/取消动作，但一律要求一次性用户确认、
 *   且**永不**允许自主执行（旧合同的购买保护换成运行期授权链）；
 * - **确认 ViewModel**：商家 / SKU-规格-数量 / 总费用 / 地址（含版本）/ 时段 / 动作范围
 *   逐项显式；`displayOnly: true`——看到它不等于用户已批准；
 * - **订单参数摘要**：`sha256:<64hex>`，覆盖上述关键条件；任一变化即失配；
 * - **金额上限**：未配置上限即拒绝购买；超限即拒；
 * - **一次性原生确认**：**真实消费 K07 账本**的原子占用；确认回执由本包可信根签发，
 *   模型/JS 自造或拷贝一律 `untrusted_native_confirmation`。
 *
 * ## 本包**没有**做什么（边界）
 *
 * - **不接真实美团接口 / 不下单 / 不支付**：真实平台能力尚未核实；包内实现均为 fixture。
 * - **不 import K07 / Android 进程**：`K07LedgerView` 是 K07 账本的结构投影，真机由适配层传入。
 * - **未持久化**：一次性命由 K07 账本保证。
 */

export * from './types.js';
export * from './errors.js';
export * from './contract.js';
export * from './digest.js';
export * from './ceiling.js';
export * from './view-model.js';
export * from './confirmation.js';
export * from './fixture.js';

/**
 * 购买确认边界（**结构性声明，不是开关**）。
 *
 * 本包**实现**的正是「购买确认」这一环，但它实现的是一套**纪律**（合同、ViewModel、
 * 摘要、上限、一次性确认），而不是一条到平台的通道：包内没有任何网络调用，
 * 确认必须经 K07 账本，真实平台尚未接通。
 */
export const PURCHASE_CONFIRMATION_BOUNDARY = Object.freeze({
  /** 本包自带真实网络调用。 */
  hasRealNetworkCall: false,
  /** 真实美团平台是否已接通。 */
  connectsRealPlatform: false,
  /** 本次是否发生真实下单 / 支付。 */
  performsRealOrder: false,
  /** 是否允许无用户确认的自主购买（恒为 false）。 */
  allowsAutonomousPurchase: false,
  /** 确认是否必须消费 K07 一次性授权（恒为 true）。 */
  requiresK07Consumption: true,
  note:
    'M06 只做购买确认的纪律层：业务合同、确认 ViewModel、订单参数摘要、金额上限与一次性原生确认。' +
    '包内无网络调用，确认必须经 K07 账本原子占用，真实平台尚未接通。',
} as const);

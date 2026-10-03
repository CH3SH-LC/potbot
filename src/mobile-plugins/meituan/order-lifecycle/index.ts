/**
 * `src/mobile-plugins/meituan/order-lifecycle` 唯一公开出口（M09：订单生命周期视图）。
 *
 * ## 本包做了什么
 *
 * - **七阶段分别报告**：下单 / 支付 / 商家接单 / 配送 / 完成 / 取消 / 退款，
 *   每个阶段一条 `StageReport`，退款另有独立 `RefundReport`；**没有合并的 ok 字段**；
 * - **匹配校验**：查询结果的 externalId / 账号 / 金额 / 币种必须与本地意图逐项相符，
 *   任一不符 ⇒ `OrderMismatchError` 且**停止跟踪**（blocked，需显式 acknowledge）；
 * - **断线后先查询原单**：只用本地已核验的原 externalId 查；本地没有 externalId
 *   则直接拒绝（不猜单、不重下）；
 * - **流转合法性**：阶段不得回退/跳级、终态不得再变；
 *   退款 `not_requested → settled` **非法**——已申请 ≠ 已到账；
 * - **未知状态不是成功**：状态码不在映射表 ⇒ 七阶段全 `unknown`、
 *   `statusRecognized === false`，`requireRecognizedView()` 直接抛错。
 *
 * ## 集成缝（run-20261003-B 落地）
 *
 * - **可注入状态码注册表**：`createOrderStatusRegistry` / `assertOrderStatusRegistryConformance` /
 *   `orderStatusRegistryCoverage` / `FIXTURE_ORDER_STATUS_REGISTRY`。订单与退款码表不再写死，
 *   核验出真实美团码值后注入即可；只有登记过的码才被当作已识别，「未知码 ⇒ 全 unknown」自动成立。
 * - **已落地下单意图的登记口**：`reviveOrderIntent`（fail-closed 校验持久化字节）+
 *   `snapshotForPersistedIntent`（把五字段意图打成初始快照，立即可落盘）。重启后
 *   `restoreOrderLifecycleTracker` 带回原 intent，`resumeAfterDisconnect(port)` **先查原单**。
 *
 * ## 本包**没有**做什么（边界）
 *
 * - **不接真实美团接口**：真实平台能力尚未核实（未登录、无 token、无工具清单，见 M01）；
 * - **不下单、不支付、不提交**：本包只**查询**既有订单；
 * - **不发起真实退款**：退款状态只能来自平台查询结果；本包不提供退款提交通道
 *   （`cancel/refund 请求`的落地归 M07/M08 的专职包，见工作书）；
 * - **不决定落盘介质**：本包给出**可序列化快照**与「打快照 / 序列化 / 解析 / 恢复」四步
 *   （见 `./persistence.js`），但存到文件 / SQLite / KeyValue 由宿主决定；
 *   恢复会重跑匹配与流转闸门，被篡改的快照直接抛错。
 */

export * from './types.js';
export * from './errors.js';
export * from './money.js';
export * from './status-map.js';
export * from './match.js';
export * from './transitions.js';
export * from './fixture.js';
export * from './lifecycle.js';
export * from './persistence.js';

/**
 * 订单生命周期边界常量（**结构性声明，不是开关**）。
 *
 * 工作书要求「不接真实平台、不能只填一个 ok」。这里把边界写成常量，
 * 让下游接线者一眼看到：本包**不是**订单提交/支付通道，也不自报已连接平台。
 */
export const ORDER_LIFECYCLE_BOUNDARY = Object.freeze({
  /** 本包不提交订单。 */
  canSubmitOrder: false,
  /** 本包不发起支付。 */
  canPay: false,
  /** 本包不发起真实退款（退款状态只来自平台查询回执）。 */
  canRequestRefund: false,
  /** 本包不接真实平台接口（真实能力待在 M01/M02 核验后接通）。 */
  connectsRealPlatform: false,
  /** 本包不把七阶段合并成单一成功标志。 */
  mergesStagesIntoSingleOk: false,
  note: 'M09 只做本地订单生命周期视图：结果来自注入的 OrderQueryPort（fixture 随包提供），七阶段分别报告，未识别状态码一律记 unknown。',
} as const);

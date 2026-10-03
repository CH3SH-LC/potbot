/**
 * `src/mobile-plugins/meituan/address-delivery` 唯一公开出口（M05：地址与配送视图模型）。
 *
 * ## 本包做了什么
 *
 * - 收货地址簿：增删改、设默认；每次实质修改推进**版本**并刷新内容指纹与引用；
 * - 地址版本失效：`checkAddressBinding` / `requireAddressBinding` 判定「地址版本
 *   不符的报价/确认必须失效」；
 * - 配送视图解析：显式选择 / 授权定位 / 被拒时要求显式选择（**不自动换地址**）；
 * - 定位产生地址：`applyLocationFix` / `locateAndBind` 把注入端口的位置固化成带版本的
 *   定位地址；**被拒/失败时不产生地址、不替换默认地址**；
 * - 配送时段：加载、选择、失效判定；
 * - **合并配送方案**：`createDeliveryPlan` 把「地址引用 + 时段 id + 时段过期点」拍成
 *   **一个** `planRef`；`checkDeliveryPlan` / `requireDeliveryPlan` 判定失效（任一变化
 *   即失效）；`locateAndPlan` 编排「定位 → 地址 → 时段 → 单一方案」，被拒/失败时引用恒
 *   `null` 且不替换默认地址；
 * - 定位授权状态机：未授权 / 已授权 / 被拒 / 撤销；
 * - 敏感字段出口：脱敏视图 + 声明用途的 `DeliveryDetailPort`。
 *
 * ## 本包**没有**做什么（边界）
 *
 * - **不接真实美团接口**：平台能力尚未核实（未登录、无 token、无工具清单）；
 * - **不发起真实定位、不请求系统权限、不下单、不支付**；
 * - 真实报价/订单/支付归后续包；用户确认归 M06。
 */

export * from './types.js';
export * from './errors.js';
export * from './digest.js';
export * from './mask.js';
export * from './address-book.js';
export * from './binding.js';
export * from './location.js';
export * from './locate.js';
export * from './slots.js';
export * from './view-model.js';
export * from './bridge.js';
export * from './fixture.js';

/**
 * 地址与配送的操作面（**结构性声明，不是开关**）。
 *
 * 供 M06 确认 ViewModel / M10 业务工具暴露时对齐：每条操作如实标注是否
 * 触碰真实平台、是否需要定位权限、是否改动地址簿。全部为**本地纯逻辑**。
 */
export const ADDRESS_DELIVERY_OPERATIONS = Object.freeze([
  Object.freeze({ name: 'addAddress', kind: 'local-pure', touchesRealPlatform: false, needsPermission: false, mutatesBook: true }),
  Object.freeze({ name: 'updateAddress', kind: 'local-pure', touchesRealPlatform: false, needsPermission: false, mutatesBook: true }),
  Object.freeze({ name: 'removeAddress', kind: 'local-pure', touchesRealPlatform: false, needsPermission: false, mutatesBook: true }),
  Object.freeze({ name: 'setDefaultAddress', kind: 'local-pure', touchesRealPlatform: false, needsPermission: false, mutatesBook: true }),
  Object.freeze({ name: 'resolveDelivery', kind: 'local-pure', touchesRealPlatform: false, needsPermission: false, mutatesBook: false }),
  Object.freeze({ name: 'applyLocationFix', kind: 'local-pure', touchesRealPlatform: false, needsPermission: false, mutatesBook: true }),
  Object.freeze({ name: 'locateAndBind', kind: 'port-driven', touchesRealPlatform: false, needsPermission: true, mutatesBook: true }),
  Object.freeze({ name: 'loadDeliverySlots', kind: 'port-driven', touchesRealPlatform: false, needsPermission: false, mutatesBook: false }),
  Object.freeze({ name: 'selectDeliverySlot', kind: 'local-pure', touchesRealPlatform: false, needsPermission: false, mutatesBook: false }),
  Object.freeze({ name: 'createDeliveryPlan', kind: 'local-pure', touchesRealPlatform: false, needsPermission: false, mutatesBook: false }),
  Object.freeze({ name: 'checkDeliveryPlan', kind: 'local-pure', touchesRealPlatform: false, needsPermission: false, mutatesBook: false }),
  Object.freeze({ name: 'locateAndPlan', kind: 'port-driven', touchesRealPlatform: false, needsPermission: true, mutatesBook: true }),
] as const);

/**
 * 地址与配送边界常量（**结构性声明，不是开关**）。
 *
 * 把工作书的两条纪律写成可断言的常量：
 * - 不接真实平台；
 * - **权限被拒绝不静默替换地址**（`substitutesAddressOnPermissionDenied: false`）。
 */
export const ADDRESS_DELIVERY_BOUNDARY = Object.freeze({
  /** 本包不接真实平台接口。 */
  connectsRealPlatform: false,
  /** 本包不发起真实定位请求。 */
  requestsRealLocation: false,
  /** 本包不请求系统权限。 */
  invokesSystemPermission: false,
  /** 本包不提交订单。 */
  canSubmit: false,
  /** 本包不发起支付。 */
  canPay: false,
  /** **纪律**：定位被拒时不得静默替换成另一个地址（必须显式失败或要求显式选择）。 */
  substitutesAddressOnPermissionDenied: false,
  note: 'M05 只做本地地址/配送视图模型：地址版本使绑定的报价与确认失效，权限被拒时只要求用户显式选择。',
} as const);

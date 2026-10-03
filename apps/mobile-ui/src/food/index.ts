/**
 * F10 food 包出口（barrel）。外卖可见卡片：选店 / 菜单 / 规格 / 购物车 / 地址 / 报价 / 订单。
 *
 * ## 消费哪些 M 组契约
 *
 * - **M04**（`cart/`）：购物车状态 `CartState`、报价 `Quote`、可用性判定 `CartSession.checkQuote`、
 *   整数最小单位金额口径；
 * - **M05**（`address-delivery/`）：脱敏地址视图 `AddressView`、配送解析 `DeliveryResolution`；
 * - **M07**（`order-submit/`）：提交状态词表与 `mayClaimOrderPlaced`；
 * - **M09**（`order-lifecycle/`）：七阶段订单视图 `OrderLifecycleView`。
 *
 * ## 内核接线（`kernel-adapter.ts`，wave-2 集成）
 *
 * - **命令面**：`buildStoreQueryCommand` / `buildMenuQueryCommand` / `buildCartMutationCommand`
 *   产出 v1 `Command`，经注入的 `FoodKernelPort`（真实实现 `src/platform/KernelClient`）下发；
 *   `classifyReceipt` fail-closed（`succeeded` 缺 `resultRef` 绝不算成功）。
 *   购物车 `args` 复用 M04 `validateCartOperationPayload`，不另立字段规格。
 * - **报价 → F05 确认卡**：`buildQuoteConfirmCard` 先跑 F10 报价闸门，只有**可用**报价才由
 *   F05 `createConfirmCard` 产卡；`confirmQuote` 经 F05 `submitThroughNativeTrust` + K07
 *   `NativeTrustPort` 签发授权，**未注入账本即拒**（不在本地自签）。
 * - **进程重启**：`planQuoteResume` 表达「重启后内存报价不是当前报价 ⇒ 必须重新取价」。
 *
 * ## 本包**未做**（如实标注，不算已完成）
 *
 * - **渲染层**：只产出状态与可断言的视图模型 + 少量文本（`title` / `summary` / `detail`），
 *   DOM / Android View / 气泡布局 / 无障碍 / 安全区未实现；真实界面归 F01/F02 及集成。
 * - **M03 目录**：`catalog/` 尚未落地，本包的 `FoodStore` / `FoodMenuItem` / `FoodSpecGroup`
 *   是**供应商无关的目录视图入参**，需接线者从 M03（或 fixture）映射填入；
 *   本包不声称已接通真实目录。
 * - **M06 确认 / K07 授权**：本包只在报价卡给出 `confirmable` 与 `evaluateQuoteConfirmation`
 *   的**拒绝**判定；真正的一次性确认卡与授权账本归 F05 / K07，真实下单提交归 M07。
 *   `buildOrderCardFromLifecycle` 恒返回 `placedClaimable: false`（生命周期查询不等于可信下单回执）。
 * - **持久化 / 事件回填**：配方草稿、报价续期、订单纯查询等宿主行为未接；M 组 fixture 未接生产开关。
 * - **真机未验证**：本轮只在 Node 下跑单元/契约层，无 Android、无真实美团接口。
 */

export * from './types.js';
export * from './money.js';
export * from './catalog.js';
export * from './cart-card.js';
export * from './address-card.js';
export * from './quote-card.js';
export * from './order-card.js';
export * from './kernel-adapter.js';

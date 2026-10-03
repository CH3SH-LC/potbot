/**
 * `src/mobile-plugins/meituan/network-resilience` 唯一公开出口。
 *
 * **来源**：本包由 `tests/mobile-meituan/M-R04` 的暂存模块**提升为生产源码**
 * （M-R04 集成请求 #3 / M-I17）。暂存目录保持只读参考，不改动。
 *
 * M-R04（备用队列）：**网络切换、429/5xx/超时、提交结果未知恢复**。
 *
 * 本包是 M07（`order-submit`）的**传输韧性补充层**：M07 定义了"提交状态机与幂等"，
 * 本层定义"传输结果如何处置、网络切换如何处理、结果未知时下一步做什么"。
 * 它**复用** M07 的业务码表与判据口径，不重造状态机，也不改 M07 源码。
 *
 * ## 本包做了什么
 *
 * - **网络切换**：`NetworkMonitor` 建模 kind 切换、代数（generation）与订阅；离线不发送。
 * - **429/5xx/超时处置**：`classifyOutcome` 把 4xx 拆开——`429` 判为**可重试限流**
 *   （纠正 M07 把 429 当拒单的判据），`408`/`409`/`5xx` 判为未知须查原单。
 * - **有界退避**：`planRetry` + `parseRetryAfter`（采纳 `Retry-After`），确定性、可抖动注入。
 * - **提交结果未知恢复**：`planSubmitRecovery` —— 只有"未到达平台"或"服务端幂等已核验"
 *   才允许续发；其余一律 `query_original_order`，`mayCreateNewOrder` 恒 `false`。
 * - **韧性发送器**：`ResilientSender` 只读可重试、提交"未到达才续发"。
 * - **操作 schemas**：`MOBILE_NETWORK_OPERATIONS` + `validateOperationInput`。
 *
 * ## 本包**没有**做什么（边界，不得当成已完成）
 *
 * - **零网络**：不 import `node:*`、不触网、不读系统时间、不使用随机数。
 * - **不接真实美团接口、不下单、不支付**：传输端口一律注入，包内实现均为 fixture。
 * - **未接 K07 账本 / Android 进程 / 手机 DB**：恢复判据是纯函数，持久化由上层负责。
 * - **未验证**任何真实平台行为。
 */

export * from './types.js';
export * from './network-state.js';
export * from './outcomes.js';
export * from './retry-policy.js';
export * from './disposition.js';
export * from './recovery.js';
export * from './resilient-transport.js';
export * from './schemas.js';

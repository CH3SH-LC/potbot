/**
 * F05 decisions 包出口（barrel）。
 *
 * 消费方式：`import { createConfirmCard, confirmCard } from '<...>/decisions/index.js'`。
 * 本包零依赖、纯 TS、框架无关；不触碰网络 / 文件 / 时钟（`now` 由调用方注入）/ 随机数。
 *
 * 本包**未做**（本轮范围外，交付时如实标注，不算作已完成）：
 *   - 渲染层：只产出状态与**渲染文本行**（`renderCardLines` / `ReceiptView.label`），
 *     DOM / Android View / 气泡布局 / 无障碍未实现。
 *   - 真实一次性授权的持久化：`authorizationGrant` 只按契约形状构造；真实的
 *     签发/存储/消费账本由 K07 独占，本包不实现、也**不声称**已接通。适配边界
 *     （`trust.ts` 的 `asNativeTrustPort` / `createKernelTrustSubmitter`）只做**类型化接线**：
 *     逻辑账本仍由注入方（生产的 K07）持有，本包不持久化。
 *   - 真实回执获取：`ExternalReceipt` 由调用方注入，本包只做展示判定；
 *     未连接任何真实平台，`verificationMode: 'real'` 的回执在本轮**未取得**。
 *   - 事件流回填与冲突处理：内核 revision/conflict 事件未映射进卡片状态。
 */

export * from './types.js';
export * from './card.js';
export * from './compare.js';
export * from './receipt.js';
export * from './trust.js';

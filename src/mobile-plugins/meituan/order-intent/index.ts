/**
 * `src/mobile-plugins/meituan/order-intent` 唯一公开出口
 * （M-I18：落盘下单意图 ⇄ 生命周期快照缝，M07 → M09）。
 *
 * ## 本包做了什么
 *
 * - **可序列化的下单事实记录**（{@link PersistedOrderIntent}）：五字段意图
 *   + 溯源引用 + 完整性指纹；
 * - **M07 桥**：{@link persistedOrderIntentFromSubmission} 由已确认的提交记录
 *   （`providerOrderRef` 即平台单号）派生可跟踪意图；
 * - **落盘/恢复四步**：`create → serialize → parse → restore`，恢复**篡改即拒**；
 * - **M09 桥**：{@link toLifecycleSnapshot} / {@link restoreLifecycleTrackerFromIntent}
 *   把意图投影成 M09 生命周期快照并恢复出跟踪器（结构兼容，M09 原生入口可直接吃）。
 *
 * ## 本包**没有**做什么（边界）
 *
 * - **不接真实美团接口、不发任何网络请求**：恢复是同步纯本地函数，无端口参数；
 * - **不是授权**：本记录无 `grantId` / `consumed` / `expiresAt` 等字段，不可授权、
 *   不可消费、不可重放。授权归 K07 `AuthorizationGrant` / M07 `AuthorizationRef`；
 * - **不下单、不支付、不查单**：那些是 M07 / M08 / M09 的职责；本包只搬运意图事实；
 * - **不决定落盘介质**：给出可序列化文本，存到文件 / SQLite / KeyValue 由宿主决定；
 * - **指纹非密钥**：能发现意外损坏 / 朴素编辑，不能对抗能重算指纹的攻击者——
 *   权威核验是 M09 恢复后重新查原单（见 `./fingerprint.js` 的强度说明）。
 */

export * from './types.js';
export * from './errors.js';
export * from './fingerprint.js';
export * from './intent.js';

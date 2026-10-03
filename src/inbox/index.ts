/**
 * `src/inbox` 公开出口（D02；合同 §八 归属表）。
 *
 * 职责：**收件箱可靠保存 + 群内 message_id 去重 + 输入快照冻结 / 已读 / 依赖解除可运行输入**，
 * 以及 R2 的唤醒默认值。
 * 本模块只提供**事务内原语**与一个收件箱层的便捷入口；工作项状态机（D04）、
 * 轮次与合并唤醒（D03）、依赖诊断（D05）不在此处。
 *
 * 依赖方向：`src/inbox` → `src/protocol`（类型与常量）、`src/storage` 仅经 `Store` 接口。
 * 合同版本：v1 + v1.1 增量（R2 / R3 / R6）+ **v1.2 修复批增量（R37.1 / R37.3）**。
 *
 * 对调度层（E）的三个冻结接缝：
 * - **F04 群作用域查询**：本模块全部消息查询走 `tx.getMessageInGroup(group_id, message_id)`，
 *   群身份取自收件箱条目；`computeFrozenInput` 已不再使用全局 `getMessage()`。
 * - **F09 运行资格**：`isRunnableInputEntry` / `hasEligibleTaskRevision` / `isStaleInboxEntry`
 *   ——"快照读入"与"值不值得起一轮"是两个不同问题（见 `snapshot.ts` 头注释）。
 * - **F10 完整输入身份**：`findActionableInput` / `hasActionableInput`（含已消费）。
 *   身份的**编码**由 D05 的 `resolutionInputRefId` 唯一负责，本模块只按传入的 `ref_id` 做幂等。
 */

export {
  messageScopeKeyOf,
  findScopedMessage,
  findCrossGroupIdCollision,
  isDuplicateDelivery,
  supportsGroupScopedMessages,
  type ScopedMessageRef,
} from './dedup.js';

export {
  defaultRequiresWakeup,
  isWaking,
} from './wakeup.js';

export {
  deliverToInbox,
  deliverMessage,
  type DeliverToInboxOptions,
  type DeliverMessageOutcome,
  type InboxDeliveryOutcome,
} from './delivery.js';

export {
  actionableInputMarks,
  computeFrozenInput,
  findActionableInput,
  freezeInputSnapshot,
  hasActionableInput,
  hasEligibleTaskRevision,
  hasRunnableInput,
  isRunnableInputEntry,
  isStaleInboxEntry,
  markDependencyResolutionInput,
  pendingActionableInputs,
  unreadInboxEntries,
  wakingInboxEntries,
  type FreezeInputRequest,
  type FrozenInputSnapshot,
  type InboxRunEligibilityOptions,
  type MarkDependencyInputRequest,
} from './snapshot.js';

export { appendUnique, patchInstance, requireInstance, type InstancePatch } from './instance-state.js';

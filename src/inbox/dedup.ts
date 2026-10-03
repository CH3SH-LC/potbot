/**
 * 群内 `message_id` 去重判据（合同 v1 Q1-d / Q3-a / Q3-b、**v1.1 R6**；任务书 §9.2；附录 B `on_message`）。
 *
 * 三条被冻结的语义，本文件是它们的**唯一判定处**：
 * 1. **作用域 = 群**：同一个 `message_id` 在**不同群组**是两条不同消息，不得互相去重
 *    （Q1-d："群内唯一"；Q3-b："去重不跨群"；R6：**不变更为全局**）。
 * 2. **相同 id 重复送达 → 不重复建业务工作**；判定必须发生在**写入之前**
 *    （D01 的 D-1 / R6：`putMessage` 是 last-write-wins **覆盖**语义，重复写入会**覆盖**
 *    首次到达的消息，从而静默改写内容）。
 * 3. **内容相似但 id 不同 → 分别保留**。本文件**只看 id**，绝不比较内容
 *    （Q3-c / §9.2"不同消息内容相似不自行合并"，A04-C 对照组的反作弊依据）。
 *
 * ## R6 / F04：作用域查询的落点
 *
 * D01 第一轮的 `hasMessage / getMessage / putMessage` 是**全局键**，接口无法表达群作用域；
 * R6 要求并已落地 `hasMessageInGroup(groupId, messageId)` / `getMessageInGroup(groupId, messageId)`
 * （`protocol/storage.ts` 的 `StorageTransaction` 已声明，`src/storage` 已实现）。
 *
 * 本模块的做法：`scopedApiOf()` 在运行时**探测**该 API——
 * - 已落地（现行存储）：直接用它，去重判定与冲突判定都是群作用域；
 * - 未落地（仅为兼容旧句柄的兜底）：退回"群作用域全表扫描"（`scanInGroup`），
 *   且把"同 id 被别的群占用"显式判为冲突（见 `findCrossGroupIdCollision`）。
 *
 * **本文件当前零处调用全局 `getMessage()` / `hasMessage()`**（F04 / R37.1）：
 * 全局查询在"同 id 跨群复用"时会歧义抛错，而跨群复用同 id 是**合法**的（Q1-d / R6）。
 */

import {
  toMessageScopeKey,
  type GroupId,
  type GroupMessage,
  type MessageId,
  type StorageTransaction,
} from '../protocol/index.js';

/** 参与去重判定的最小消息形状（便于纯函数测试，不要求完整 `GroupMessage`）。 */
export type ScopedMessageRef = Pick<GroupMessage, 'group_id' | 'message_id' | 'recipient_instance_id'>;

/** R6 增补 API 的形状（尚未出现在 `StorageTransaction` 上）。 */
interface ScopedMessageApi {
  getMessageInGroup(groupId: GroupId, messageId: MessageId): GroupMessage | undefined;
  hasMessageInGroup(groupId: GroupId, messageId: MessageId): boolean;
}

/** 运行时探测 R6 增补 API；未落地返回 undefined。 */
function scopedApiOf(tx: StorageTransaction): ScopedMessageApi | undefined {
  const candidate = tx as unknown as Partial<ScopedMessageApi>;
  return typeof candidate.getMessageInGroup === 'function' &&
    typeof candidate.hasMessageInGroup === 'function'
    ? (candidate as ScopedMessageApi)
    : undefined;
}

/**
 * 存储是否已支持**群作用域键**。
 * 未支持时（当前）同一 `message_id` 只能全局存在一条，跨群复用同一个 id 无法共存，
 * 必须显式报错而不是静默覆盖另一个群的消息。
 */
export function supportsGroupScopedMessages(tx: StorageTransaction): boolean {
  return scopedApiOf(tx) !== undefined;
}

/** 该消息的去重作用域键：**群内唯一**（Q1-d / R6）。 */
export function messageScopeKeyOf(message: Pick<GroupMessage, 'group_id' | 'message_id'>): string {
  return toMessageScopeKey(message.group_id, message.message_id);
}

/**
 * 无群作用域键时的**兜底**：全表扫描按 `(group_id, message_id)` 取值。
 *
 * 仍是**群作用域**判定，且**不**触碰全局 `getMessage()`——后者在"同 id 跨群复用"
 * （合法，Q1-d / R6）时会抛歧义错（F04 / R37.1）。存储合同已要求
 * `StorageTransaction.getMessageInGroup`（`protocol/storage.ts`），本兜底只为兼容
 * 尚未提供该 API 的旧句柄。
 */
function scanInGroup(
  tx: StorageTransaction,
  groupId: GroupId,
  messageId: MessageId,
): GroupMessage | undefined {
  return tx.listMessages().find((m) => m.group_id === groupId && m.message_id === messageId);
}

/**
 * 在**同一群组内**查找已存在的同 id 消息（去重判定的唯一读口）。
 * 优先用 R6 的 `getMessageInGroup`；未落地时退回群作用域全表扫描
 * （**不是**全局查询：全局查询表达不了"群内唯一"，且会歧义抛错）。
 */
export function findScopedMessage(
  tx: StorageTransaction,
  message: ScopedMessageRef,
): GroupMessage | undefined {
  const scoped = scopedApiOf(tx);
  if (scoped !== undefined) {
    return scoped.getMessageInGroup(message.group_id, message.message_id);
  }
  return scanInGroup(tx, message.group_id, message.message_id);
}

/**
 * 查找**跨群**的 id 占用（同 id 已被另一个群组使用）。
 *
 * 这是"存储键空间"与"去重作用域"之间的落差，**不是**合同语义：
 * - 已支持群作用域键（R6 增补落地后）→ 两条消息可以共存，本函数恒返回 undefined；
 * - 尚未支持（旧句柄）→ 同 id 跨群会互相覆盖。首版同一任务最多一个活跃群组
 *   （任务书 §5），Q7-c 多群共享资源本轮明确排除，因此 D02 的选择是**显式报错**，
 *   而不是让 `putMessage` 静默改写另一个群的消息。
 *
 * 判定同样**不**用全局 `getMessage()`（同 id 跨群时它会歧义抛错，F04 / R37.1），
 * 而是全表扫描同 id、异群的那一条。
 */
export function findCrossGroupIdCollision(
  tx: StorageTransaction,
  message: ScopedMessageRef,
): GroupMessage | undefined {
  if (scopedApiOf(tx) !== undefined) {
    return undefined;
  }
  return tx
    .listMessages()
    .find((m) => m.message_id === message.message_id && m.group_id !== message.group_id);
}

/**
 * 是否为重复送达：**写入前**必须先调用本函数，否则会覆盖首次到达的记录（D-1 / R6）。
 *
 * 判定来源有两个，任一命中即视为重复——只查消息表还不够健壮：
 * - **本群内**同 id 的消息已存在（正常路径，走群作用域查询）；
 * - 目标实例收件箱里已有该 id 的条目（防御"消息与收件箱条目不同步"的畸形状态，
 *   避免重复追加收件箱条目）。
 *
 * **不比较内容**：内容相同而 id 不同的消息在这里恒为"不重复"（Q3-c）。
 */
export function isDuplicateDelivery(tx: StorageTransaction, message: ScopedMessageRef): boolean {
  return (
    findScopedMessage(tx, message) !== undefined ||
    tx.hasInboxEntry(message.recipient_instance_id, message.message_id)
  );
}

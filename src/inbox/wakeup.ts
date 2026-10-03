/**
 * 唤醒标记的默认取值（合同 **v1.1 R2**；任务书:201「仅发布公共进度 → 不默认唤醒所有成员」）。
 *
 * 硬语义：
 * - 每条消息**显式**带 `requires_wakeup`（`MessageDraft.requires_wakeup` 是必填）。
 * - `stage_result`（公共进度）**默认 false**：只写收件箱与公共上下文，
 *   **不**标记可执行输入、**不**入队 → 不产生多余轮次。
 * - 其余 7 种消息类型默认 true。
 * - `on_message` 事务里「标记可执行输入 + 置排队标记」**只在 `requires_wakeup === true` 时发生**
 *   （该编排归 D03；本模块只提供默认取值与判据，不替 D03 决定在何时入队）。
 *
 * 为什么放在 `src/inbox`：这是"一条消息是否构成一次运行机会"的判据，
 * 与收件箱条目的 `requires_wakeup` 字段同源；D07/D08 构造场景消息时也应从这里取默认值，
 * 避免各处自造一份类型→布尔 的映射。
 */

import type { InboxEntry, MessageType } from '../protocol/index.js';

/**
 * 消息类型的默认唤醒标记（R2 的**唯一实现处**）。
 * 调用方仍可显式覆盖（例如测试要构造"公共进度也唤醒"的对照）。
 */
export function defaultRequiresWakeup(type: MessageType): boolean {
  return type !== 'stage_result';
}

/** 收件箱条目是否构成一次**运行机会**（只有 `requires_wakeup` 为真的条目才算）。 */
export function isWaking(entry: Pick<InboxEntry, 'requires_wakeup'>): boolean {
  return entry.requires_wakeup;
}

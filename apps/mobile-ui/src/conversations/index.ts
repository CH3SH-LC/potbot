/**
 * F03 conversations 包出口（barrel）。
 *
 * 消费方式：`import { createConversationsState, listConversations, pageConversations } from '<...>/conversations/index.js'`。
 * 本包零依赖、纯 TS、框架无关；不触碰网络 / 文件 / 时钟 / 随机数 / `KernelClient`。
 *
 * 覆盖范围（对应 design-07：C02 对话列表、C03 对话内搜索的列表侧）：
 *   - 列表分页（越界报错，不静默空页）
 *   - 搜索（按标题或内容片段）
 *   - 新建与切换（新建进入独立空会话）
 *   - 重命名 / 归档 / 取消归档 / 删除（删除带明确范围）
 *   - 排序（最近活跃，确定性三级 tie-break）
 *   - 每项归属与任务绑定（归属唯一）
 *   - 定位（返回列表恢复滚动位置）
 *
 * 接线（`kernel-adapter.ts`）：命令方向 `dispatchConversationCommand` 已按 `commands.ts` 构造的
 * v1 命令**先订阅后投递**到注入的 `ConversationCommandPort`（结构化形状与 `KernelClient` 一致）；
 * 事件方向 `reconcileConversationEvents` 把内核 `Event` 归约进 `applyConversationUpdate`，
 * 带 revision 连续段拆分与缺口扣留。端口由协调者注入，**真实内核回执/事件流未经实机验证**。
 *
 * 本包**未做**（本轮范围外，交付时如实标注，不算作已完成）：
 *   - 真实 `KernelClient` 接线：`kernel-adapter.ts` 只**接通**注入端口的调用路径，不发真实网络、
 *     不验真实回执；`ConversationEventSource` 的**全局**事件源需协调者在 KernelClient 之上包一层
 *     （KernelClient 目前只按 commandId 订阅）；命令的网络回执与真实事件 revision 流属未验证。
 *   - 渲染层：给出状态与顺序，DOM / Android View / 滚动容器未实现，「恢复滚动位置」只到
 *     `locateConversation` 的锚点计算，不含真实滚动恢复。
 *   - 会话内搜索（C03 的日期/文件命中与定位）：本包只按标题/内容片段匹配，不检索真实消息、
 *     日期或文件。
 *   - 持久化与同步：删除/归档仅作用于内存视图状态，不代表已落盘或已同步到其他设备。
 *   - 删除的实际执行语义：`DeleteScope` 声明如何处理关联任务/文件/记忆/外部动作，
 *     真正级联删除或外部撤销由内核/存储侧完成，本包只要求范围明确并移除目标会话。
 */

export * from './types.js';
export * from './util.js';
export * from './state.js';
export * from './actions.js';
export * from './commands.js';
export * from './kernel-adapter.js';

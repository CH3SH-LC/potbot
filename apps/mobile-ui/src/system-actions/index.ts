/**
 * F-R06 system-actions 包出口（barrel）。
 *
 * 消费方式：`import { buildCalendarForm, buildCalendarEventCommand } from '<...>/system-actions/index.js'`。
 * 本包零依赖、纯 TS、框架无关；不触碰网络 / 文件系统 / 时钟 / 随机数 / 文件字节。
 *
 * 四块能力：
 *   1) 详情的**视图模型**：`buildCalendarForm` / `buildReminderForm` / `buildResearchForm`
 *      （原始输入 → 可渲染、可断言、fail-closed 的表单状态）。
 *   2) **操作命令**：`buildCalendarEventCommand` / `buildReminderCommand` /
 *      `buildResearchQueryCommand` / `buildResearchDeletionCommand`
 *      （v1 契约 `Command`，确定性幂等键）。
 *   3) **回统一对话**：`returnToConversation` / `buildResultRef`。
 *   4) **接线**：`dispatchSystemActionCommand`（命令 → 手机内核 `KernelClient`，断流绝不伪造成功）
 *      与 `buildSystemActionScreen`（`*FormView` → 渲染底座 `ViewNode`，屏幕 T06/T07/C05）。
 *
 * 本包**未做**（本轮范围外，交付时如实标注，不算作已完成）：
 *   - 真实渲染：只产出声明式 `ViewNode`；DOM / Android View 由 host 实现，未真机验证。
 *   - 相对时间解析：相对→绝对由内核/模型侧完成，本包对未解析者 fail-closed。
 *   - 重复规则求值（RRULE）：`rule` 由内核给出，本包只搬运并守卫编辑范围。
 *   - 真机通道：`dispatchSystemActionCommand` 只消费已注入的 `KernelClient`；桥 / WebView
 *     通道与心跳由宿主（Android）注入，本包不自造。
 *   - 真实日历账号读写 / 系统提醒通道 / 真实检索端口 均未接入。
 */

export * from './types.js';
export * from './time.js';
export * from './return.js';
export * from './calendar.js';
export * from './reminder.js';
export * from './research.js';
export * from './command.js';
export * from './screen-adapter.js';

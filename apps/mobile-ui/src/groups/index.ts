/**
 * F04 groups 包出口（barrel）。
 *
 * 消费方式：`import { createGroupsState, listGroups, applyTaskEvent } from '<...>/groups/index.js'`。
 * 本包零依赖、纯 TS、框架无关；不触碰网络 / 文件 / 时钟（时间由调用方注入）/ 随机数。
 *
 * 覆盖范围（对应 design-07：T01 群组列表、T02 任务详情、T03 修改任务、T08 活动记录）：
 *   - 群组列表：聚合任务、按「待处理 / 进行中 / 已结束」筛选、搜索、最近进展、所属对话；
 *   - 任务详情：目标/当前版本、阶段与等待原因、成果、待处理动作、约束、取消状态、活动记录；
 *   - 暂停 / 恢复 / 取消：命令构造（过期 revision 被拒）+ 事件驱动的状态机（暂停可续接、
 *     取消两步、成果保留）；
 *   - 改条件：影响面预览（受影响产物/动作/待失效确认卡）+ 事件应用（旧卡原位失效）；
 *   - 事件驱动：`applyTaskEvent` 是**唯一**改变任务态的入口，带 revision 守卫（过期/缺口被拒）。
 *
 * 本包**未做**（本轮范围外，交付时如实标注，不算作已完成）：
 *   - 真实 `KernelClient` 接线：命令对象已按契约构造，但**未发送**、未订阅事件流；
 *     事件的网络投递与回执属未验证。命令/事件由调用方（测试或适配层）投递。
 *   - 渲染层：只产出状态与文本行（`renderActivityLines`），DOM / Android View / 滚动 /
 *     无障碍未实现。
 *   - 内部 Agent 群聊视图：**有意不做**——群组只呈现进展与活动记录，不呈现内部对话/思维链。
 *   - 持久化与跨设备同步：仅内存视图状态。
 *   - 真实外部动作：`actionRefs` 只列引用；下单/日程等由 K07/M 线负责，本包不做也不声称。
 *   - 完成凭据的真实性判断：`completed` 要求 `verificationMode='real'` + `resultRef`，但
 *     凭据本身是否被伪造不在本包范围（由内核/存储侧校验）。
 */

export * from './types.js';
export * from './ids.js';
export * from './util.js';
export * from './state.js';
export * from './reducer.js';
export * from './commands.js';
export * from './conditions.js';
export * from './activity.js';
export * from './kernel-adapter.js';

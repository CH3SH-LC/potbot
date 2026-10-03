/**
 * F07 memory 包出口（barrel）。
 *
 * 消费方式：`import { toMemoryRow, describeRecall, applyMemoryEdit, startForget, serializeMemoryEntry } from '<...>/memory/index.js'`。
 * 纯 TS、框架无关；不触碰网络 / 文件系统 / 时钟 / 随机数，不直接引 `KernelClient`（只依赖其**结构**）。
 *
 * 只读消费（不修改）`src/memory/**` 的域形状、`apps/mobile-kernel/memory/**` 的真实产物
 * 与 `contracts/mobile-v1/types.ts` 的命令 / 事件类型。
 *
 * 本包**未做**（本轮范围外，交付时如实标注，不算作已完成）：
 *   - 真实检索 / 写入执行：本包不实现内核 `recall()` / `modify()` / `forgetMemory()`；
 *     `kernel-adapter.ts` 只把内核**真实产物**序列化成视图 DTO。
 *   - 直接持有 `KernelClient`：`kernel-adapter.ts` 只依赖一个结构化的 `MemoryCommandDispatcher`
 *     （真实 `KernelClient` 天然满足）；实例由 F 线协调者的装配层注入。
 *   - 遗忘进度的真实来源：`ForgetJob` 由内核事件 / 生命周期产物驱动；本包**不**自己推进进度、
 *     **不**自行判定完成（完成必须有内核回执 `evidenceRef`）。
 *   - 渲染层：只产出状态与描述，DOM / Android View 未实现。
 *   - 分页：列表排序 / 筛选已实现，但未做服务端游标分页。
 */

export * from './types.js';
export * from './rows.js';
export * from './recall.js';
export * from './edit.js';
export * from './forget.js';
export * from './operations.js';
export * from './kernel-adapter.js';

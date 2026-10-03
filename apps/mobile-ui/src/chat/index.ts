/**
 * F02 chat 包出口（barrel）。
 *
 * 消费方式：`import { createChatState, reduce } from '<...>/chat/index.js'`。
 * 本包零依赖、纯 TS、框架无关；不触碰网络 / 文件 / 时钟 / 随机数。
 *
 * 本包**未做**（本轮范围外，交付时如实标注，不算作已完成）：
 *   - **真实** `KernelClient` 本体：`kernel-client-adapter.ts` 已提供传输接线的结构化端口与
 *     适配器（`buildSendCommandForState` → `sendCommand`，`Event` 流 → `kernelEvent` /
 *     `eventStreamEnded`）；但真正的 `src/platform/KernelClient`（真机 HTTP/SSE 通道）由 F 线
 *     协调者单写，本包**未**接入真实传输，命令的真网络投递与回执属**未验证**。
 *   - 渲染层：本包给出状态与渲染**描述**，DOM / Android View / 软键盘避让未实现。
 *   - 附件真实读取与上传：只有 `AttachmentRef` 占位（`bytesRead` 恒为 false）；附件已随消息与
 *     命令**描述**下传，但真实字节读取、上传与结果读回未做。
 *   - 断线续传：中断后不支持在同一 attempt 上续写，只能重试新 attempt（有意为之）。
 *
 * 本批**新增**（见 `events.ts` / `kernel-client-adapter.ts` 与本目录 README）：内核 `Event` →
 * 任务生命周期的映射与归约；`succeeded` 缺 `resultRef` 的 fail-closed 降级；两条流（正文流 +
 * 事件流）联合完成判定 `isMessageFullyDone`；发送时附件随用户消息与命令元数据保留（不再静默
 * 丢弃）；KernelClient 传输接线（命令下发 + 事件流订阅，传输抛出/中止 ⇒ 两条流中断，绝不完成）。
 */

export * from './types.js';
export * from './ids.js';
export * from './draft.js';
export * from './references.js';
export * from './events.js';
export * from './reducer.js';
export * from './command.js';
export * from './kernel-client-adapter.js';

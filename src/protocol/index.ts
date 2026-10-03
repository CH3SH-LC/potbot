/**
 * `src/protocol` 唯一公开出口（D01 落地；合同 §八：共享类型只由本目录落地）。
 *
 * 下游 D02–D09 一律从本模块 import，**不得**各自复制字面量或记录形状。
 * 本目录只提供**类型、语义常量与纯函数**；持久化能力在 `src/storage`。
 */

export * from './ids.js';
export * from './constants.js';
export * from './errors.js';
export * from './task.js';
export * from './task-control.js';
export * from './message.js';
// F07 冻结接缝（R35.2）：入口鉴权对 E 的唯一判据；显式具名导出以便调用方一眼可见。
export { isKernelIssuedBinding } from './message.js';
export * from './work-item.js';
// design-02 A 批：产物记录与共享事实记录（与 ArtifactRef / FactRef 并列的载体记录）。
export * from './artifact.js';
export * from './facts.js';
export * from './instance.js';
// 群成员登记（F07 冻结接缝：入口鉴权的成员资格判据；与 InstanceState 分开）
export * from './membership.js';
export * from './run.js';
export * from './inbox.js';
export * from './events.js';
export * from './counters.js';
export * from './storage.js';

export * from './timestamps.js';

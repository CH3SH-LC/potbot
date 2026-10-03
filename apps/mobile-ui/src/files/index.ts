/**
 * F06 files 包出口（barrel）。
 *
 * 消费方式：`import { createFile, listFiles } from '<...>/files/index.js'`。
 * 本包零依赖、纯 TS、框架无关；不触碰网络 / 文件系统 / 时钟 / 随机数 / 文件字节。
 *
 * 集成端口（本轮新增，均为**结构类型**，不 import 任何外部实现，保持零依赖）：
 *   - `preview.ts` 的 `PreviewProducer`：业务插件（Word/Excel/PPT）产出 `PreviewDescriptor`，
 *     `attachPluginPreview()` 消费并照跑 P1–P5 绑定校验（fail-closed）。
 *   - `history.ts` 的 `HistoryKernelPort`：从内核读回版本链（`loadVersionHistory` /
 *     `loadFileEntryFromKernel`），把版本历史的**事实来源**交还给内核。
 *
 * 本包**未做**（本轮范围外，交付时如实标注，不算作已完成）：
 *   - 文件字节的读取与摘要计算：`BytePresence` 由产出字节的一侧（导出器 / 内核）给出，
 *     本包只校验形状；未与任何真实导出器接线。
 *   - 真实 API 差分解算：差异只搬运业务插件给出的 `PartChange[]`，不比较字节内容。
 *   - 渲染层：只产出状态与描述，DOM / Android View 未实现。
 *   - 预览渲染：`preview.ts` 只**承载/消费**业务插件给出的预览描述，不解析文件、不画像素；
 *     端口已定义，但**未绑定任何真实插件**，也未接真机。
 *   - 真实 KernelClient：`HistoryKernelPort` 已定义，但协调查者的 `KernelClient` 尚未落地，
 *     测试用的端口是受控替身（fixture），不是真实桥。
 *   - 选区解析：占位槽 `wired=false`，解析一律抛 `selection-not-wired`。
 *   - 保存 / 分享的落盘与真实分享通道：只维护容器状态，未发出任何外部动作。
 */

export * from './types.js';
export * from './bytes.js';
export * from './versions.js';
export * from './diff.js';
export * from './selection.js';
export * from './containers.js';
export * from './preview.js';
export * from './history.js';
export * from './list.js';

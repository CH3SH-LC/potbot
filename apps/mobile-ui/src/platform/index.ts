/**
 * F-I01 `platform` 包出口（barrel）。
 *
 * 消费方式：`import { createKernelClientFromBridge } from '<...>/platform/index.js'`。
 *
 * 本包是 F 线（mobile UI）**唯一**的原生调用面 —— 桥 / 命令 / 事件的所有接线都收敛到这里，
 * 子包（chat / conversations / groups / decisions / memory / settings / food）只依赖
 * `KernelClient`，不得各自 import `apps/mobile-kernel/**` 或 Android 桥。
 *
 * 内容：
 *   - {@link createKernelClientFromBridge}：一站式装配（真实运行时 + 真实桥 + 客户端）；
 *   - {@link createKernelClient} / {@link createLocalBridgeAdapter}：分步装配；
 *   - 类型：命令 / 事件 / 回执 / 断流 / 原生信任端口。
 *
 * 本包**未做**（如实标注，不得当成已完成）：
 *   - 真机 WebView 通道与心跳：`signalStreamBreak` 是宿主注入点，非自造健康检测；
 *   - 持久化 / 重连 / 断点续传；
 *   - 原生确认页与 Android 进程（`NativeTrustPort` 只到 K07 内存账本实现层）。
 */

export * from './types.js';
export * from './local-bridge-adapter.js';
export * from './KernelClient.js';

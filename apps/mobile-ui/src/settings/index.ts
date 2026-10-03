/**
 * F09 settings 包出口（barrel）。
 *
 * 消费方式：`import { createKeyRegistry, exportDiagnostics } from '<...>/settings/index.js'`。
 * 本包零依赖、纯 TS、框架无关；不触碰网络 / 文件系统 / 时钟（`now` 由调用方注入）/
 * 随机数；密钥只有引用与状态，**没有**明文字段。
 *
 * `screen.ts`（集成切片 F-I13）在六个域之上补了**组合层**：`buildSettingsScreenView`
 * 装配设置页视图模型 + 占位状态横幅 `buildStubStatusBanner`，`settingsScreenToViewNode`
 * 投影为声明式 `ViewNode`；`bindSettingsPorts` / `createKernelKeyImporter` /
 * `createKernelConnectionTester` 把两个原生端口经 `KernelClient`（结构面
 * `SettingsNativeCalls`）的原生调用转发，设置页**不 import** Android 桥 / 内核实现。
 *
 * 本包**未做**（本轮范围外，交付时如实标注，不算作已完成）：
 *   - 渲染层：产出视图模型 + `ViewNode` 树，但 DOM / Android View / 设置页布局 /
 *     事件绑定 / 无障碍运行时**未实现**；`ViewNode` 只是数据。
 *   - 真实原生密钥库：`NativeKeyImporter` 只定义端口，Android Keystore / 内容选择器 /
 *     一次性 URI 撤销的**实现未做**；经 `KernelClient` 的转发默认标记 `fixture`，
 *     本包不声称已接通真机密钥导入。
 *   - 真实连接：`ConnectionTester` 只定义端口，未连任何真实主机，未取得真实连接证据。
 *   - 真实用量/存储读取：`BudgetInput` / `StorageUsageInput` 由真实宿主注入，
 *     本包只做展示推导与不变量校验。
 *   - 系统权限申请与跳转：仅产出恢复入口**文案**，未调用 Android 权限 API。
 */

export * from './types.js';
export * from './key-status.js';
export * from './connection.js';
export * from './permissions.js';
export * from './budget.js';
export * from './notifications.js';
export * from './diagnostics.js';
export * from './screen.js';

/**
 * F08 templates 包出口（barrel）。
 *
 * 消费方式：
 *   `import { createTemplatesState, installTemplate, catalogRows, manifestFor } from '<...>/templates/index.js'`。
 *
 * 本包零依赖、纯 TS、框架无关；不触碰网络 / 文件 / 时钟 / 随机数 / `KernelClient`。
 *
 * 覆盖范围（对应 design-07 行 157 / 158 / 206 / 243，FRONTEND.md F08 行）：
 *   - 模版目录：七个模板恒可见（未安装也列出），四态分列；
 *   - 四态独立：installed / enabled / authorized / portReady，互不合并（I1/I2）；
 *   - 能力不足可见：缺权限 / 运行时不支持的能力逐条列出，附可操作 remedy（I7）；
 *   - 生命周期：安装 / 卸载（带范围）/ 启用 / 停用 / 授权 / 撤权 / 端口探针；
 *   - 更新比对新增权限并强制再授权（I5）；回滚复原更新前快照（I6）；
 *   - 契约投影：`TemplateManifest`，交真校验器实跑（见 tests/mobile-ui/F08/contract.test.ts）。
 *   - 内核适配（`kernel-adapter.ts`）：把 K06 的**四态读回报告**与**探针事件流 resultRef**
 *     投影到 `recordProbe`；并把 install / enable / authorize / update / uninstall（+ readiness
 *     探针）构造为 K-I04 宿主约定的 v1 `Command`（`redo`/`export` + `args.op`）。
 *
 * 本包**未做**（本轮范围外，交付时如实标注，不算作已完成）：
 *   - 真实 `KernelClient` 投递与订阅：`kernel-adapter.ts` 只**构造**命令、只**投影**事件，
 *     不发送、不订阅；真实命令回执与探针事件的实际到流属未验证（由 F 线协调者的 KernelClient
 *     单写投递面）。
 *   - 四态中 `installed/enabled/authorized` 的核对：适配层只写探针管辖的 `portReady` 等维度；
 *     K06 报告里的另外三态经 `readinessVerdicts` 暴露给调用方**分别**核对，本包不替内核改态。
 *   - 渲染层：给出状态与阻断原因，DOM / Android View 未实现。
 *   - 持久化 / 迁移执行：安装、更新、回滚只作用于内存视图状态；真实插件包安装、
 *     文件落盘与 `migration.strategy` 的实际执行由内核/宿主侧完成，本包只做前置校验与展示。
 *   - 卸载的实际级联删除：`UninstallScope` 只声明处置范围，真正移除数据由存储侧完成。
 *   - 真实字节 / 下载 / 校验：不读取任何模板包字节，不校验签名或摘要。
 */

export * from './types.js';
export * from './catalog.js';
export * from './lifecycle.js';
export * from './readiness.js';
export * from './manifest.js';
export * from './kernel-adapter.js';

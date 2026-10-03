/**
 * `src/dependency` 唯一公开出口（D05；合同 §八：模块归属 `src/dependency/` = 依赖解除与有限诊断 P5）。
 *
 * 下游用法：
 * - **D03（调度器）**：
 *   - 轮次发现需先拿依赖结果 → `planBlockOnDependency(...)` 拿 `→ waiting_dependency` 的转换判定；
 *   - 某依赖项完成 → `planDependencyResolution(items, {at})` +
 *     `deliverResolutionNotices(port, plan.notices)`（端口由 D03 实现：登记可运行输入标记、
 *     置排队标记、写 `dependency_resolved` 待投递事件）；
 *   - 停滞检查 → `diagnoseStagnation(...)` + `recordDiagnosis(tx, ...)`；
 *   - **作用域限定**（合同 v1.2 R37.2 / R37.4；修复批 F03 / F05）：把
 *     `scope: { task_id, task_revision }` 传给 `diagnoseStagnation` / `planDependencyResolution`，
 *     并用 `selectScopedRunnableInstanceIds(...)` 按同一范围筛 `runnable_instance_ids`；
 *   - **启动前预算闸门**（R34.1 / F08）：`wouldExceedNext(limits, usage, 'runs')`；
 *   - **诊断的事前许可**（合同 v1.3 R44.1 / R44.7；G03）：`diagnosisPermit(limits, usage)`
 *     返回 `{ allowed, used, limit }`——`allowed === false` 时**不得**调用 `diagnoseStagnation()`，
 *     改调 `exhaustedDiagnosis({ items, scope, budget, usage, now })` 拿**不消费诊断额度**的
 *     耗尽报告，再交给 `recordDiagnosis(tx, diagnosis, options)` 写
 *     `diagnosis_budget_exhausted` 事件（签名与返回类型不变，调用方无需分支）。
 * - **D07–D09（验收夹具）**：`createCollectingResolutionPort()` 收集通知做断言；
 *   `new RecoveryLedger()` 判"A05-09 同版同阻塞指纹最多一次自动恢复"；
 *   `planCycleStop(...)` 拿 A05 的循环停止计划；`computeBlockingFingerprint(...)` 做 Q9-b 证据。
 *
 * **本模块不 import `src/scheduler/**`**：所有需要"请求唤醒"的动作都走注入端口
 * （`DependencyResolutionPort`），因此可与 D03 并行开发。
 *
 * 本模块**不转发** `src/protocol` / `src/workledger` 的导出：共享类型与构造器一律从
 * `../protocol/index.js` 导入，工作项转换判定从 `../workledger/index.js` 导入——
 * 单一定义来源，避免此处再开一个转发面而与上游漂移。
 */

export * from './errors.js';
export * from './digest.js';
export * from './budget.js';
export * from './scope.js';
export * from './graph.js';
export * from './fingerprint.js';
export * from './recovery.js';
export * from './ports.js';
export * from './diagnosis.js';
export * from './resolution.js';
export * from './events.js';

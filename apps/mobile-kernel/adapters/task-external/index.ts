/**
 * K-I12 任务↔外部副作用桥 barrel。
 *
 * 读法：`errors.ts`（桥自身拒因）→ `bridge.ts`（`TaskExternalBridge`：引用约定校验 +
 * 查询优先结清 + 幂等）。范围与已知局限见 `README.md`。
 *
 * 本包只**新建** `apps/mobile-kernel/adapters/task-external/**`，不 import K10/K07 的
 * 私有实现；只用它们公开导出的定义模块（`actions/ledger.js`、`actions/types.js`、
 * `lifecycle/ledger.js`、`lifecycle/types.js`），不经 barrel——见 `bridge.ts` 头部说明。
 */

export * from './errors.js';
export * from './bridge.js';

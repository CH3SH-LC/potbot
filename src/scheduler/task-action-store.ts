/**
 * 动作台账 / 任务生命周期的**持久化接缝**（FA-S；KRN-07 + KRN-09 接线的存储侧）。
 *
 * ## 为什么需要这一层
 *
 * `src/workledger/action-ledger.ts`（KRN-07）与 `src/scheduler/task-lifecycle.ts`（KRN-09）
 * 落地时是**内存态**：`ActionLedger` 的内部 Map、`TaskLifecycleState` 的调用方持有。
 * R216（重启后恢复动作）与 R225（预算/状态不因重启清零）要求它们进**已有的持久 Store**。
 *
 * 但 `src/storage` 的 `StorageTransaction` / `StoreSnapshot`
 * （定义在 `src/protocol/storage.ts`）里**没有**放这两类记录的位置，而这个文件不在本包写权内
 * （见 `.task-manifest/outputs/FA-S/interface-declaration.md` §2 的逐行补丁）。
 *
 * ## 本模块的立场：**绝不静默降级**
 *
 * - 有接缝就**自动接上**（`taskActionPortOf()` 结构化探测，零集成成本）；
 * - 没有接缝且调用方也没显式注入端口 ⇒ 接线状态如实回报为 `'unwired'`
 *   （调用方可在 `startRun`/`finishRun` 的返回值上读到它），
 *   **不**用进程内存冒充持久介质（R220 明令禁止"把 Map 当完整恢复"）。
 * - 显式要求接缝而接缝不存在 ⇒ `TaskActionSeamMissingError` 大声失败，
 *   **不**退化成内存。
 *
 * 依赖方向：`src/scheduler → src/protocol` + `src/workledger`（均为既有方向，未新增）。
 * 本文件**不** import `src/storage`——它只按**结构化接口**消费事务句柄，因此
 * 接缝落在 protocol/storage 之后，本文件一行不用改。
 */

import { ActionLedgerError, type ActionRecord } from '../workledger/index.js';
import type { ActionRef, StorageTransaction, TaskId } from '../protocol/index.js';
import type { TaskLifecycleState } from './task-lifecycle.js';

/**
 * 动作台账 + 任务生命周期的**事务内**读写接缝。
 *
 * 六个方法与 `TransactionView` 上的同名方法**结构一致**：
 * 一旦 `src/protocol/storage.ts` 的 `StorageTransaction` 补上这六个方法、
 * `src/storage/store-core.ts` 的 `StoreState` 补上 `actions` / `task_lifecycles`
 * 两个集合，`taskActionPortOf(tx)` 会自动认出它们，**无需改动本文件**。
 */
export interface TaskActionStorePort {
  putActionRecord(record: ActionRecord): void;
  getActionRecord(actionId: ActionRef): ActionRecord | undefined;
  listActionRecords(): readonly ActionRecord[];
  putTaskLifecycle(state: TaskLifecycleState): void;
  getTaskLifecycle(taskId: TaskId): TaskLifecycleState | undefined;
  listTaskLifecycles(): readonly TaskLifecycleState[];
}

/** 接缝缺失（调用方显式要求持久接缝，但介质没有实现它）。 */
export class TaskActionSeamMissingError extends ActionLedgerError {
  constructor(detail: string) {
    super(
      'unknown_action',
      `动作台账 / 任务生命周期的持久接缝不可用：${detail}。` +
        '本内核**不**用进程内存冒充持久介质（R220）。请让 Store 介质实现六个接缝方法' +
        '（补丁见 .task-manifest/outputs/FA-S/interface-declaration.md），' +
        '或在 `SchedulerOptions.taskActions` 显式注入一个端口。',
    );
    this.name = 'TaskActionSeamMissingError';
  }
}

const PORT_METHODS = [
  'putActionRecord',
  'getActionRecord',
  'listActionRecords',
  'putTaskLifecycle',
  'getTaskLifecycle',
  'listTaskLifecycles',
] as const;

/** 介质是否实现了完整接缝（六个方法都是函数）。 */
export function hasTaskActionSeam(medium: unknown): boolean {
  if (typeof medium !== 'object' || medium === null) {
    return false;
  }
  return PORT_METHODS.every(
    (name) => typeof (medium as Readonly<Record<string, unknown>>)[name] === 'function',
  );
}

/**
 * 从事务句柄取持久端口。
 *
 * - 介质实现了接缝 → 返回它（`'store'`）；
 * - 未实现 → 返回 `null`（调用方据此如实回报 `'unwired'`），**不静默退化为内存**。
 */
export function taskActionPortOf(tx: StorageTransaction): TaskActionStorePort | null {
  return hasTaskActionSeam(tx) ? (tx as unknown as TaskActionStorePort) : null;
}

/** 接线状态（**必须如实回报**，不得把三种情形混为一谈）。 */
export type TaskActionWiringState =
  /** 端口来自 Store 介质（持久；跨重启有效）。 */
  | 'store'
  /** 端口由调用方显式注入（测试 / 尚未落存储时的临时介质，**非持久**）。 */
  | 'injected'
  /** 没有端口：本轮**未接线**，动作台账与生命周期不参与本次事务。 */
  | 'unwired';

/** 解析本轮实际使用的端口与接线状态。 */
export function resolveTaskActionPort(
  tx: StorageTransaction,
  injected: TaskActionStorePort | undefined,
): { readonly port: TaskActionStorePort | null; readonly wiring: TaskActionWiringState } {
  const fromStore = taskActionPortOf(tx);
  if (fromStore !== null) {
    return { port: fromStore, wiring: 'store' };
  }
  if (injected !== undefined) {
    return { port: injected, wiring: 'injected' };
  }
  return { port: null, wiring: 'unwired' };
}

/**
 * **作用域限定（scope）**——按「当前任务 + 当前版本」收窄依赖判定的输入（合同 v1.2 R37.2 / R37.4；
 * 修复批 F05 / F03）。
 *
 * ## 为什么需要它（F05 的真实反例）
 * 旧实现把**整库**工作项送进诊断：当 T1 rev1 与 T2 rev2 各存在非终态项时，阻塞项跨任务版本
 * ⇒ `fingerprintOfBlockedItems` 抛 `FingerprintError` ⇒ **整个 `finish_run` 事务回滚**，run 永远
 * 停在 running。而「历史项与当前项并存」是**正常**状态（R37.2：历史项必须保留）。
 *
 * 本文件的解法是**收窄参与判定的集合**，而不是删旧项、改版本、关指纹校验或吞异常——
 * 后四条都是 R37.2 明确禁止的"修法"。
 *
 * ## 语义（唯一权威定义处，`diagnoseStagnation` 与 `planDependencyResolution` 都用它）
 * - `task_id` 是**闸门维度**：非空 ⇒ 只保留 `item.task_id === task_id` 的项；
 * - `task_revision` 是**次级收窄**：只在 `task_id` 已给出时生效，再只保留
 *   `item.task_revision === task_revision` 的项；
 * - `task_id` 为 `null` / `undefined`（无论 `task_revision` 给没给）⇒ **不做任何限定**，
 *   行为与"没有 scope"完全一致。
 *
 * 为什么 `task_id` 是闸门而不是"两个维度各自独立过滤"：
 * 1. `task_revision` 是**任务内**编号，只按 `revision` 过滤会把不同任务里"恰好同版本"的项
 *    混到一起，与 R37.2 的"同一任务同一版本"本意相反；
 * 2. 调度层现有的 `scopeWorkItems`（`src/scheduler/stagnation.ts`）就是这个口径
 *    ——"未给 `task_id` ⇒ 整库送诊断（向后兼容路径）"。本模块作为**冻结接缝**与之保持一致，
 *    调度层可以直接把本地实现换成这里的导入而不改变行为。
 *
 * ## 历史项去哪了
 * **留在存储里**，只是不进入本次判定。本模块是纯函数、不触碰存储（写入权归 D03/D04）。
 *
 * ## 与 `FingerprintError` 的关系（不得削弱）
 * 收窄之后，**同一 scope 内**若仍出现跨版本的阻塞项（例如只给了 `task_id` 没给
 * `task_revision`），指纹仍应**如实抛 `FingerprintError`**——那是真实损坏，不是要绕过的噪声。
 */

import type { InstanceId, Revision, TaskId, WorkItem } from '../protocol/index.js';
import { uniqueSorted } from './graph.js';

/**
 * 任务 / 版本限定。两个字段都可省略或为 `null`；但**语义不对称**：
 * `task_id` 是闸门（为空 ⇒ 整个 scope 视为"不限定"），`task_revision` 只在
 * `task_id` 已给出时才作为次级收窄（见文件头的闸门语义）。
 *
 * 形状刻意与调度层的 `scopeWorkItems` 第二参数保持结构兼容：`WorkItem` 本身、
 * `StagnationCheckpointInput` 的子集都能直接传入。
 */
export interface DependencyScope {
  readonly task_id?: TaskId | null;
  readonly task_revision?: Revision | null;
}

/** 任何带任务身份与版本的对象（`WorkItem` 自然满足）。 */
export interface ScopedItemIdentity {
  readonly task_id: TaskId;
  readonly task_revision: Revision;
}

/**
 * 规范化 scope：`task_id` 为空 ⇒ 返回 `null`（表示"不限定"；见文件头的闸门语义）。
 * 返回值冻结，可安全地跨函数传递。
 */
export function normalizeScope(scope?: DependencyScope | null): DependencyScope | null {
  if (scope === null || scope === undefined) {
    return null;
  }
  const taskId = scope.task_id ?? null;
  if (taskId === null) {
    return null;
  }
  return Object.freeze({ task_id: taskId, task_revision: scope.task_revision ?? null });
}

/** 该 scope 是否真的会收窄集合（`null` / 未给 `task_id` ⇒ `false`）。 */
export function isScopeRestricted(scope?: DependencyScope | null): boolean {
  return normalizeScope(scope) !== null;
}

/** 单次判定：该项是否落在 scope 内（不限定 ⇒ 恒 `true`）。 */
export function itemInScope(item: ScopedItemIdentity, scope?: DependencyScope | null): boolean {
  const normalized = normalizeScope(scope);
  return normalized === null || matchesScope(item, normalized);
}

function matchesScope(item: ScopedItemIdentity, scope: DependencyScope): boolean {
  const taskId = scope.task_id;
  if (taskId !== null && taskId !== undefined && item.task_id !== taskId) {
    return false;
  }
  const revision = scope.task_revision;
  if (revision !== null && revision !== undefined && item.task_revision !== revision) {
    return false;
  }
  return true;
}

/**
 * **收窄工作项集合**（R37.2 的唯一实现处）。
 *
 * 不限定（未给 scope / 未给 `task_id`）时**原样返回入参**——保持既有调用方的引用语义
 * 与性能特征不变。
 */
export function scopeWorkItems<T extends ScopedItemIdentity>(
  items: readonly T[],
  scope?: DependencyScope | null,
): readonly T[] {
  const normalized = normalizeScope(scope);
  if (normalized === null) {
    return items;
  }
  return Object.freeze(items.filter((item) => matchesScope(item, normalized)));
}

/** `scopeWorkItems` 的别名（语义同上；供只关心"收窄"语义的调用点使用）。 */
export function restrictToScope<T extends ScopedItemIdentity>(
  items: readonly T[],
  scope?: DependencyScope | null,
): readonly T[] {
  return scopeWorkItems(items, scope);
}

/**
 * scope 内工作项的**负责人实例**（升序去重）。
 *
 * 用途：把"本任务本版本涉及哪些实例"从工作项侧算出来，而不必去读实例表
 * （本模块不 import `src/inbox` / 存储，保持纯函数）。
 */
export function scopedOwnerInstanceIds(
  items: readonly WorkItem[],
  scope?: DependencyScope | null,
): readonly InstanceId[] {
  const owners = new Set<string>();
  for (const item of scopeWorkItems(items, scope)) {
    owners.add(String(item.owner_instance_id));
  }
  return Object.freeze(uniqueSorted([...owners]) as InstanceId[]);
}

/**
 * 「该实例是否有可运行输入」的**调用方注入判定**。
 *
 * 本模块**不 import `src/inbox`**（避免 D05 与 D02/D03 耦合），因此这个判定必须由调用方给出
 * ——调度层传 `hasRunnableInput(tx, instance_id)`，夹具可以传自己的断言函数。
 */
export type RunnableInputPredicate = (instanceId: InstanceId) => boolean;

export interface ScopedRunnableInstanceOptions {
  /** 任务 / 版本限定；省略 = 只按"是否有可运行输入"筛选。 */
  readonly scope?: DependencyScope | null;
  /**
   * "该实例是否有可运行输入"判定。
   *
   * - **省略 / `null`** ⇒ 视为候选**全部**具备可运行输入：此时调用方应传入**自己已筛好**的
   *   `instance_id` 列表（"直接接受 instance_id 列表，由调用方筛好"的形态）；
   * - **给出** ⇒ 只保留判定为真的实例。
   */
  readonly hasRunnableInput?: RunnableInputPredicate | null;
}

/**
 * 从「一批工作项 + 一批实例」里选出**当前任务当前版本的可运行实例**，供调度层填入
 * `StagnationDiagnosisRequest.runnable_instance_ids`（R37.2："可运行输入使用同一范围"）。
 *
 * ## 两道闸门（同时成立才入选）
 * 1. `hasRunnableInput(instance_id)` 为真（未给回调时视为真）；
 * 2. 该实例在 **scope 内**拥有至少一个工作项（`owner_instance_id` 命中，
 *    且该项通过 `scopeWorkItems`）。
 *
 * ## 为什么第 2 道闸门是"拥有 scope 内工作项"
 * 实例本身不带 `task_id` / `task_revision`，工作项是唯一可用的纯函数信号；
 * 这也正是 F05 要消除的失效模式——**无关任务**（T2 rev2）的实例不得因为"有可运行输入"
 * 而把 T1 的诊断判成 `progress_possible`，进而为无关任务重复起轮次与扣费。
 *
 * ## 逃生舱
 * `scope` 为空（`null` / 省略）时第 2 道闸门退化为"拥有至少一个工作项"；若调用方要完全
 * 放开这一闸（例如"只按可运行输入筛选"），请传 `scope: null` 并自行保证候选列表的归属，
 * 或直接使用 `hasRunnableInput` 自行筛选后传入。**给出 scope 时不做例外的"放行"**。
 *
 * 返回值升序去重、冻结。
 */
export function selectScopedRunnableInstanceIds(
  items: readonly WorkItem[],
  candidate_instance_ids: readonly InstanceId[],
  options: ScopedRunnableInstanceOptions = {},
): readonly InstanceId[] {
  const owners = new Set<string>(scopedOwnerInstanceIds(items, options.scope ?? null));
  const predicate = options.hasRunnableInput ?? null;
  const selected: string[] = [];
  for (const candidate of candidate_instance_ids) {
    const id = String(candidate);
    if (!owners.has(id)) {
      continue;
    }
    if (predicate !== null && !predicate(candidate)) {
      continue;
    }
    selected.push(id);
  }
  return Object.freeze(uniqueSorted(selected) as InstanceId[]);
}

/** scope 的可读描述（诊断原因 / 日志 / 断言失败信息用）。 */
export function describeScope(scope?: DependencyScope | null): string {
  const normalized = normalizeScope(scope);
  if (normalized === null) {
    return '全库（未限定任务 / 版本）';
  }
  const task = normalized.task_id === null || normalized.task_id === undefined ? '*' : String(normalized.task_id);
  const revision =
    normalized.task_revision === null || normalized.task_revision === undefined
      ? '*'
      : `r${Number(normalized.task_revision)}`;
  return `task=${task} ${revision}`;
}

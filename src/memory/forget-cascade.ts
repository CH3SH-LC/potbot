/**
 * 记忆生命周期与**联动失效级联**（design-06 P4 / MEM-05；合同 R237 / R238 / R240）。
 *
 * ## 用户可做的五件事
 *
 * 查看（`viewMemory`）、修改（`modifyMemory`）、停用（`disableMemory`）、
 * 删除（`deleteMemory`）、要求忘记（`forgetMemory` / `forgetOwnerMemory`）。
 *
 * ## 派生条目**联动失效**（R238）——本文件补的是仓库漏掉的两格
 *
 * `MemoryRepository` 只在 `delete` / `forget` 时联动失效派生条目。但 R238 要求的是
 * **修改**与**停用**同样触发联动失效：一条记忆的值变了、或不再进入注入，
 * 由它派生的**索引 / 摘要 / 缓存 / 派生经验**就都**不再可信**。
 * `cascadeDerivedInvalidation()` 把这件事补齐，且对 `delete` / `forget` 幂等（可叠加）。
 *
 * 失效是**只加不减**的：一旦失效不会被"重新启用"——重新可用的只能是重新派生的新条目。
 * 未由被触碰条目派生的派生条目**保持有效**（不过度失效，避免误伤）。
 *
 * ## 删除 / 忘记**跨离线恢复不复活**（R238）
 *
 * 本文件只负责把"抹除 + 墓碑 + 联动失效"落到仓库；**离线恢复后不复活**由仓库的
 * tombstone 语义保证。`forget-cascade.test.ts` 用 `restart.ts` 的 `reopenMemoryStore()`
 * 做一次**快照 → 新进程（模拟）→ 读回**的断言：忘记的条目**不再出现**，
 * 派生条目**仍是失效态**。（该断言为**同进程模拟重启**，未做真实跨进程验证。）
 *
 * ## R240：失败**不宣称成功**
 *
 * 每个 `LifecycleOutcome` 都带 `ok`：底层仓库动作失败时 `ok: false`，`affected` 为空，
 * 调用方**拿不到**"已经忘记 / 已经修改"的结论。
 *
 * 纯函数 + 注入仓库：零 IO、时间由调用方经 `LogicalTime` 传入。
 */

import type { LogicalTime } from '../protocol/index.js';
import type {
  DerivedId,
  DerivedRecord,
  MemoryEntry,
  MemoryId,
  MemoryStatus,
  OwnerId,
} from './types.js';
import type { MemoryEntryPatch, MemoryRepository } from './repository.js';

/** 用户可对一条（或一个主体的）记忆做的动作（封闭枚举）。 */
export const MEMORY_LIFECYCLE_ACTIONS = ['view', 'modify', 'disable', 'delete', 'forget'] as const;
export type MemoryLifecycleAction = (typeof MEMORY_LIFECYCLE_ACTIONS)[number];

/** 联动失效的结果。 */
export interface DerivedCascade {
  /** 本次**新**置为失效的派生条目。 */
  readonly invalidated: readonly DerivedId[];
  /** 仍然有效的派生条目（未被误伤的证据）。 */
  readonly surviving: readonly DerivedId[];
}

/**
 * 把**由 `sourceIds` 派生而来**的条目全部置为失效（R238）。
 *
 * 幂等：已失效的不重复计入 `invalidated`；未由 `sourceIds` 派生的**不受影响**。
 */
export function cascadeDerivedInvalidation(
  repository: MemoryRepository,
  sourceIds: readonly MemoryId[],
): DerivedCascade {
  const victims = new Set<string>(sourceIds);
  const invalidated: DerivedId[] = [];

  for (const record of repository.listDerived()) {
    if (record.invalidated) continue;
    if (!record.derived_from.some((source) => victims.has(source))) continue;
    const next: DerivedRecord = Object.freeze({ ...record, invalidated: true });
    repository.registerDerived(next);
    invalidated.push(record.derived_id);
  }

  const surviving = repository
    .listDerived()
    .filter((record) => !record.invalidated)
    .map((record) => record.derived_id);

  return Object.freeze({
    invalidated: Object.freeze(invalidated),
    surviving: Object.freeze(surviving),
  });
}

/** 生命周期动作的统一产出（`ok: false` ⇒ **不得**宣称动作成功，R240）。 */
export interface LifecycleOutcome {
  readonly action: MemoryLifecycleAction;
  readonly ok: boolean;
  readonly owner_id: OwnerId;
  readonly memory_id: MemoryId | null;
  /** 实际被抹除 / 改动的记忆 id。 */
  readonly affected: readonly MemoryId[];
  readonly cascade: DerivedCascade;
  /** 人类可读说明（含失败原因；**不得为空**）。 */
  readonly detail: string;
}

/** 查看的产出（只读；附派生条目状态）。 */
export interface MemoryView {
  readonly action: 'view';
  readonly ok: boolean;
  readonly owner_id: OwnerId;
  readonly memory_id: MemoryId;
  readonly entry: MemoryEntry | null;
  readonly status: MemoryStatus | null;
  readonly derived_for_entry: readonly DerivedRecord[];
  readonly derived_valid: readonly DerivedId[];
  readonly derived_invalidated: readonly DerivedId[];
  readonly detail: string;
}

/**
 * 查看一条记忆（**带隔离**）。
 *
 * `MemoryRepository.get()` **不做隔离**（内部用），因此这里**自己查属主**：
 * 跨用户查看 ⇒ `ok: false` / `entry: null`，**不泄漏**对方内容（R237）。
 */
export function viewMemory(
  repository: MemoryRepository,
  input: { readonly memory_id: MemoryId; readonly owner_id: OwnerId },
): MemoryView {
  const entry = repository.get(input.memory_id);
  if (entry === undefined) {
    return Object.freeze({
      action: 'view',
      ok: false,
      owner_id: input.owner_id,
      memory_id: input.memory_id,
      entry: null,
      status: null,
      derived_for_entry: Object.freeze([]),
      derived_valid: Object.freeze([]),
      derived_invalidated: Object.freeze([]),
      detail: `记忆 ${input.memory_id} 不存在（查不到就是查不到，不得编造内容，R240）`,
    });
  }
  if (entry.owner_id !== input.owner_id) {
    return Object.freeze({
      action: 'view',
      ok: false,
      owner_id: input.owner_id,
      memory_id: input.memory_id,
      entry: null,
      status: null,
      derived_for_entry: Object.freeze([]),
      derived_valid: Object.freeze([]),
      derived_invalidated: Object.freeze([]),
      detail: `记忆 ${input.memory_id} 不属于 ${input.owner_id}：跨用户查看被拒，不泄漏内容（R237 隔离）`,
    });
  }
  const related = repository.listDerived().filter((record) => record.derived_from.includes(input.memory_id));
  const valid = related.filter((record) => !record.invalidated).map((record) => record.derived_id);
  const invalid = related.filter((record) => record.invalidated).map((record) => record.derived_id);
  return Object.freeze({
    action: 'view',
    ok: true,
    owner_id: input.owner_id,
    memory_id: input.memory_id,
    entry,
    status: entry.status,
    derived_for_entry: Object.freeze(related),
    derived_valid: Object.freeze(valid),
    derived_invalidated: Object.freeze(invalid),
    detail:
      `查看 ${entry.kind} 记忆 ${input.memory_id}（状态 ${entry.status}，版本 r${String(entry.version)}）；` +
      `相关派生条目 ${String(related.length)} 个（有效 ${String(valid.length)} / 已失效 ${String(invalid.length)}）`,
  });
}

/** 修改：保留来源、递增版本，并**联动失效**派生条目（R235 / R238）。 */
export function modifyMemory(
  repository: MemoryRepository,
  input: {
    readonly memory_id: MemoryId;
    readonly owner_id: OwnerId;
    readonly patch: MemoryEntryPatch;
    readonly at: LogicalTime;
  },
): LifecycleOutcome {
  const result = repository.modify(input.memory_id, input.owner_id, input.patch, input.at);
  if (!result.ok) {
    return failure('modify', input.owner_id, input.memory_id, `修改失败（${result.reason}）：${result.detail}`);
  }
  const cascade = cascadeDerivedInvalidation(repository, [input.memory_id]);
  return Object.freeze({
    action: 'modify',
    ok: true,
    owner_id: input.owner_id,
    memory_id: input.memory_id,
    affected: Object.freeze([input.memory_id]),
    cascade,
    detail:
      `已修改记忆 ${input.memory_id}（版本 → r${String(result.entry.version)}，来源原样保留）；` +
      `联动失效派生条目 ${String(cascade.invalidated.length)} 个（R238）`,
  });
}

/** 停用：不再进入注入，但保留内容；派生条目**同样联动失效**（R238）。 */
export function disableMemory(
  repository: MemoryRepository,
  input: { readonly memory_id: MemoryId; readonly owner_id: OwnerId; readonly at: LogicalTime },
): LifecycleOutcome {
  const result = repository.disable(input.memory_id, input.owner_id, input.at);
  if (!result.ok) {
    return failure('disable', input.owner_id, input.memory_id, `停用失败（${result.reason}）：${result.detail}`);
  }
  const cascade = cascadeDerivedInvalidation(repository, [input.memory_id]);
  return Object.freeze({
    action: 'disable',
    ok: true,
    owner_id: input.owner_id,
    memory_id: input.memory_id,
    affected: Object.freeze([input.memory_id]),
    cascade,
    detail:
      `已停用记忆 ${input.memory_id}（内容保留、不再进入检索注入）；` +
      `联动失效派生条目 ${String(cascade.invalidated.length)} 个（R238）`,
  });
}

/** 软删除：标记 `deleted` 并写墓碑（保留审计；恢复不复活）；联动失效派生条目。 */
export function deleteMemory(
  repository: MemoryRepository,
  input: { readonly memory_id: MemoryId; readonly owner_id: OwnerId; readonly at: LogicalTime },
): LifecycleOutcome {
  const before = repository.get(input.memory_id);
  if (before === undefined || before.owner_id !== input.owner_id) {
    return failure(
      'delete',
      input.owner_id,
      input.memory_id,
      before === undefined
        ? `记忆 ${input.memory_id} 不存在`
        : `记忆 ${input.memory_id} 不属于 ${input.owner_id}：跨用户删除被拒（R237）`,
    );
  }
  const result = repository.delete(input.memory_id, input.owner_id, input.at);
  const cascade = cascadeDerivedInvalidation(repository, [input.memory_id]);
  return Object.freeze({
    action: 'delete',
    ok: result.forgotten.length > 0,
    owner_id: input.owner_id,
    memory_id: input.memory_id,
    affected: result.forgotten,
    cascade,
    detail: `已删除记忆 ${input.memory_id}（写入墓碑，恢复不复活）；联动失效派生条目 ${String(
      cascade.invalidated.length,
    )} 个（R238）`,
  });
}

/** **硬忘记**（用户要求忘记）：条目从存储移除、id 记入墓碑；派生条目联动失效。 */
export function forgetMemory(
  repository: MemoryRepository,
  input: { readonly memory_id: MemoryId; readonly owner_id: OwnerId },
): LifecycleOutcome {
  const before = repository.get(input.memory_id);
  if (before === undefined || before.owner_id !== input.owner_id) {
    return failure(
      'forget',
      input.owner_id,
      input.memory_id,
      before === undefined
        ? `记忆 ${input.memory_id} 不存在`
        : `记忆 ${input.memory_id} 不属于 ${input.owner_id}：跨用户忘记被拒（R237）`,
    );
  }
  const result = repository.forget(input.memory_id, input.owner_id);
  const cascade = cascadeDerivedInvalidation(repository, [input.memory_id]);
  return Object.freeze({
    action: 'forget',
    ok: result.forgotten.length > 0,
    owner_id: input.owner_id,
    memory_id: input.memory_id,
    affected: result.forgotten,
    cascade,
    detail: `已忘记记忆 ${input.memory_id}（彻底移除 + 墓碑）；联动失效派生条目 ${String(
      cascade.invalidated.length,
    )} 个（R238）`,
  });
}

/** "要求忘记某个主体的全部记忆"（整体入口）。 */
export function forgetOwnerMemory(
  repository: MemoryRepository,
  input: { readonly owner_id: OwnerId },
): LifecycleOutcome {
  const result = repository.forgetOwner(input.owner_id);
  const cascade = cascadeDerivedInvalidation(repository, result.forgotten);
  return Object.freeze({
    action: 'forget',
    ok: true,
    owner_id: input.owner_id,
    memory_id: null,
    affected: result.forgotten,
    cascade,
    detail: `已忘记主体 ${input.owner_id} 的全部记忆，共 ${String(result.forgotten.length)} 条；联动失效派生条目 ${String(
      cascade.invalidated.length,
    )} 个（R238）`,
  });
}

function failure(
  action: MemoryLifecycleAction,
  ownerId: OwnerId,
  memoryId: MemoryId,
  detail: string,
): LifecycleOutcome {
  return Object.freeze({
    action,
    ok: false,
    owner_id: ownerId,
    memory_id: memoryId,
    affected: Object.freeze([]),
    cascade: Object.freeze({ invalidated: Object.freeze([]), surviving: Object.freeze([]) }),
    detail: `${detail}：未做任何改动，不宣称动作成功（R240）`,
  });
}

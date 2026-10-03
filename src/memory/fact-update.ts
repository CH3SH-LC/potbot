/**
 * 任务事实的**版本化更新**（design-06 P4 / MEM-03 未通子项；合同 R235 / R236 / R240）。
 *
 * ## 当前指令优先，但**不悄悄改历史事实**（R236）
 *
 * `src/memory/recall.ts` 的 `resolvePreferenceConflict()` 解决"当前明确指令 vs 旧偏好"——
 * 结论恒为 `applied: 'current'` 并**列出差异**。本文件补上 R236 的另一半：
 * **更新任务事实必须留来源与版本**。
 *
 * 做法是**追加新版本**，而不是原地改写：
 *
 * 1. 读出该 `(owner, task, fact_key)` 当前**有效**的一条事实（**历史版本**）；
 * 2. 写入一条**新版本**条目（`version = 历史最大版本 + 1`，带 `source` 与 `at`）；
 * 3. 把历史条目置 `disabled`——**值原样保留**（可审计），**绝不调用 `modify` 去改它的值**。
 *
 * 于是"历史事实被静默改写"在结构上不可能发生：任何一个旧值都还躺在库里，能用
 * `readTaskFactHistory()` 逐版本读回；默认检索只返回当前有效值，历史不丢。
 *
 * ## R240：不编造
 *
 * 写入失败（注入的 `beforeWrite` 抛错）⇒ 返回 `kind: 'failed'`，**新版本不落库、历史条目保持
 * 原状态**（旧值仍是有效值）——调用方**拿不到**"已更新"这个结论。
 *
 * 纯函数 + 注入仓库：零 IO，时间由调用方经 `LogicalTime` 传入。
 */

import type { LogicalTime, TaskId } from '../protocol/index.js';
import { asRevision } from '../protocol/index.js';
import { createMemoryEntry, type MemoryId, type MemorySource, type OwnerId, type TaskFactMemory } from './types.js';
import type { MemoryRepository } from './repository.js';

/** 更新结论的三个分支（封闭枚举；`no_change` 是一等结局，同 R239 的纪律）。 */
export const TASK_FACT_UPDATE_RESULT_KINDS = ['updated', 'no_change', 'failed'] as const;
export type TaskFactUpdateResultKind = (typeof TASK_FACT_UPDATE_RESULT_KINDS)[number];

/** 失败原因（封闭枚举）。 */
export const TASK_FACT_UPDATE_FAILURES = [
  'missing_source', // 没给来源：R236 要求更新必须留来源
  'store_failed', // 新版本写入失败（未落库）
  'disable_failed', // 新版本已写入，但历史条目未能置为失效（如实失败，不宣称干净退出）
] as const;
export type TaskFactUpdateFailure = (typeof TASK_FACT_UPDATE_FAILURES)[number];

/** **更新**：写出了新版本；历史值原样保留。 */
export interface TaskFactUpdated {
  readonly kind: 'updated';
  readonly entry: TaskFactMemory;
  /** 被本条取代的历史条目 id（首次写入时为 `null`）。 */
  readonly superseded: MemoryId | null;
  /** 历史值（首次写入时为 `null`）——调用方据此向用户**说明差异**（R236）。 */
  readonly previous_value: string | null;
  /** 给用户看的说明（含来源与版本，**不得为空**）。 */
  readonly explanation: string;
}

/** **不新增**：当前有效值已与新值相同，正确动作是不写新版本（避免把库撑大 / 制造假历史）。 */
export interface TaskFactNoChange {
  readonly kind: 'no_change';
  readonly entry: TaskFactMemory;
  readonly reason: string;
}

/** **失败**：如实失败，未宣称更新。 */
export interface TaskFactFailed {
  readonly kind: 'failed';
  readonly reason: TaskFactUpdateFailure;
  readonly detail: string;
}

export type TaskFactUpdateResult = TaskFactUpdated | TaskFactNoChange | TaskFactFailed;

export interface TaskFactUpdateInput {
  readonly repository: MemoryRepository;
  readonly owner_id: OwnerId;
  readonly task_id: TaskId;
  readonly fact_key: string;
  readonly value_text: string;
  /** **必填**：更新任务事实必须留来源（R236）。 */
  readonly source: MemorySource;
  readonly at: LogicalTime;
  /** 生成新条目 id 的确定性接缝。 */
  readonly newMemoryId: () => MemoryId;
}

/** 该 `(owner, task, fact_key)` 下**有效**的事实（按版本降序；通常 ≤ 1 条）。 */
function activeFacts(
  repository: MemoryRepository,
  ownerId: OwnerId,
  taskId: TaskId,
  factKey: string,
): readonly TaskFactMemory[] {
  const facts = repository
    .listByKind('task_fact')
    .filter((entry): entry is TaskFactMemory => entry.kind === 'task_fact')
    .filter(
      (entry) =>
        entry.owner_id === ownerId &&
        entry.task_id === taskId &&
        entry.fact_key === factKey &&
        entry.status === 'active',
    );
  return Object.freeze([...facts].sort((left, right) => right.version - left.version));
}

/** 该 `(owner, task, fact_key)` 的**全部版本**（含已失效），按版本升序——审计用。 */
export function readTaskFactHistory(
  repository: MemoryRepository,
  input: { readonly owner_id: OwnerId; readonly task_id: TaskId; readonly fact_key: string },
): readonly TaskFactMemory[] {
  return Object.freeze(
    repository
      .listByKind('task_fact')
      .filter((entry): entry is TaskFactMemory => entry.kind === 'task_fact')
      .filter(
        (entry) =>
          entry.owner_id === input.owner_id &&
          entry.task_id === input.task_id &&
          entry.fact_key === input.fact_key,
      )
      .sort((left, right) => left.version - right.version),
  );
}

function hasUsableSource(source: MemorySource | undefined): source is MemorySource {
  return (
    source !== undefined &&
    typeof source.kind === 'string' &&
    source.kind.length > 0 &&
    typeof source.detail === 'string' &&
    source.detail.length > 0
  );
}

/**
 * 更新一条任务事实（追加新版本，**不改历史**）。
 *
 * @returns
 * - `updated`：写出新版本，历史条目置失效但**值原样保留**；
 * - `no_change`：当前有效值已与新值相同，**不写**新版本；
 * - `failed`：缺来源 / 写入失败 / 历史失效失败——**不宣称更新**。
 */
export function updateTaskFact(input: TaskFactUpdateInput): TaskFactUpdateResult {
  if (!hasUsableSource(input.source)) {
    return {
      kind: 'failed',
      reason: 'missing_source',
      detail: '更新任务事实必须留来源（R236）：没有来源的更新不得写入',
    };
  }

  const history = activeFacts(input.repository, input.owner_id, input.task_id, input.fact_key);
  const previous: TaskFactMemory | undefined = history[0];

  if (previous !== undefined && previous.value_text === input.value_text) {
    return {
      kind: 'no_change',
      entry: previous,
      reason:
        `当前有效值与待写值相同（"${input.fact_key}" 已是 ${JSON.stringify(input.value_text)}）：` +
        '正确动作是**不新增版本**，而不是写一条同值事实制造假历史（R236）',
    };
  }

  const version = asRevision(previous === undefined ? 0 : previous.version + 1);
  const entry = createMemoryEntry({
    kind: 'task_fact',
    memory_id: input.newMemoryId(),
    owner_id: input.owner_id,
    scope: { kind: 'task', task_id: input.task_id, template_id: null },
    source: input.source,
    confirmation: 'unconfirmed',
    created_at: input.at,
    updated_at: input.at,
    version,
    status: 'active',
    task_id: input.task_id,
    fact_key: input.fact_key,
    value_text: input.value_text,
  }) as TaskFactMemory;

  const written = input.repository.remember(entry);
  if (!written.ok) {
    return {
      kind: 'failed',
      reason: 'store_failed',
      detail: `存储失败，未写入新版本，历史事实保持原状：${written.detail}`,
    };
  }

  if (previous !== undefined) {
    const disabled = input.repository.disable(previous.memory_id, input.owner_id, input.at);
    if (!disabled.ok) {
      return {
        kind: 'failed',
        reason: 'disable_failed',
        detail:
          `新版本已写入，但历史条目 ${previous.memory_id} 未能置为失效：${disabled.detail}；` +
          '如实报告，不宣称干净退出',
      };
    }
  }

  return {
    kind: 'updated',
    entry,
    superseded: previous?.memory_id ?? null,
    previous_value: previous?.value_text ?? null,
    explanation:
      previous === undefined
        ? `首次写入任务事实 "${input.fact_key}"（版本 r${String(version)}，来源 ${input.source.kind}:${input.source.detail}）`
        : `按当前要求把任务事实 "${input.fact_key}" 从 ${JSON.stringify(previous.value_text)} 更新为 ` +
          `${JSON.stringify(input.value_text)}（版本 r${String(previous.version)} → r${String(version)}，` +
          `来源 ${input.source.kind}:${input.source.detail}）；历史版本原样保留可审计，未静默改写（R236）`,
  };
}

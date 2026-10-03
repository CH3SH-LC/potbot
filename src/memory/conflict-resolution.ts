/**
 * 当前指令优先 + 任务事实的**留痕更新**（design-06 P4 / MEM-03；合同 R235 / R236 / R240）。
 *
 * ## 两条现有裁决**只读复用**，本文件不另造
 *
 * - "当前明确指令 vs 旧偏好" ⇒ 直接调 `recall.ts` 的 `resolvePreferenceConflict()`：
 *   结论恒为 `applied: 'current'`，冲突的旧偏好被**列出来**（不删除、不静默丢弃）。
 * - "更新任务事实" ⇒ 直接调 `fact-update.ts` 的 `updateTaskFact()`：
 *   **追加新版本**并把旧版本置失效，值**原样保留**、来源与版本都记下——绝不 `modify` 改写历史。
 *
 * 本层的价值是**把两者收在一个可交付的结论里**：一次"按当前要求执行"的动作，既给出偏好差异，
 * 也给出被更新的事实的新旧对照与来源，并**如实标注失败**（R240）。
 *
 * ## 不悄悄改历史事实（R236）
 *
 * `traceFactVersions()` 让调用方随时把某个 `(任务, 事实键)` 的**全部版本**逐条读回：
 * 每条带自己的 `version`、`value_text`、`status` 与 `source`。旧版本仍在（只是 `disabled`），
 * 因此"旧值是什么、谁在什么时候改的、依据什么来源"都可回答。
 *
 * ## R240：任一步失败 ⇒ 结论如实带失败，不宣称"已更新"
 *
 * 事实更新失败（缺来源 / 存储失败 / 旧版本失效失败）时，`partial` 为 `true`，失败写进 `failures`；
 * 该键**不会被列进 `differences`**——绝不制造"看起来改成了"的对照。
 *
 * 纯函数 + 注入仓库：零 IO，时间由调用方经 `LogicalTime` 传入。
 */

import type { LogicalTime, Revision, TaskId } from '../protocol/index.js';
import {
  resolvePreferenceConflict,
  type CurrentInstruction,
  type PreferenceResolution,
} from './recall.js';
import {
  readTaskFactHistory,
  updateTaskFact,
  type TaskFactUpdateResult,
} from './fact-update.js';
import type { MemoryRepository } from './repository.js';
import type { MemoryId, MemorySource, MemoryStatus, OwnerId, PreferenceMemory } from './types.js';

// ---------------------------------------------------------------------------
// 输入 / 输出形状
// ---------------------------------------------------------------------------

/** 一次要被"按当前要求"更新的任务事实。 */
export interface FactUpdateRequest {
  readonly task_id: TaskId;
  readonly fact_key: string;
  readonly value_text: string;
  /** **必填**：更新必须留来源（R236）。 */
  readonly source: MemorySource;
}

export interface ResolveCurrentInstructionInput {
  readonly repository: MemoryRepository;
  readonly owner_id: OwnerId;
  readonly at: LogicalTime;
  /** 本轮用户明确给出的指令（覆盖旧偏好）。 */
  readonly current_instructions: readonly CurrentInstruction[];
  /** 已记住的旧偏好（用于找冲突；**不删除**它们）。 */
  readonly preferences: readonly PreferenceMemory[];
  /** 需要按当前要求更新的任务事实。 */
  readonly fact_updates: readonly FactUpdateRequest[];
  /** 生成新条目 id 的确定性接缝。 */
  readonly newMemoryId: () => MemoryId;
}

/** 一处"新旧差异"（供向用户说明，R236）。 */
export interface ResolvedDifference {
  readonly kind: 'preference' | 'task_fact';
  readonly key: string;
  /** 旧值（首次写入时为 `'(无)'`）。 */
  readonly from: string;
  /** 本次采用的值。 */
  readonly to: string;
  readonly note: string;
}

/** 一次事实更新的完整结果（含成功与失败），供审计。 */
export interface FactUpdateOutcome {
  readonly request: FactUpdateRequest;
  readonly result: TaskFactUpdateResult;
}

/** 一次"按当前要求执行"的收口结论。 */
export interface ConflictResolutionReport {
  /** 恒为 `current`：按当前要求执行（R236）。 */
  readonly applied: 'current';
  readonly preference_resolution: PreferenceResolution;
  /** 仅成功的变更会出现在这里（失败的键**不**编造差异）。 */
  readonly differences: readonly ResolvedDifference[];
  readonly fact_outcomes: readonly FactUpdateOutcome[];
  /** 是否有任一步失败（R240：如实标注，不宣称全部完成）。 */
  readonly partial: boolean;
  readonly failures: readonly string[];
  /** 给用户 / 决策气泡的一行说明（**不得为空**）。 */
  readonly explanation: string;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 按当前明确指令执行，并把差异与新版本一并交代清楚。
 *
 * 步骤：
 * 1. `resolvePreferenceConflict`：当前指令覆盖旧偏好，冲突列出（结论恒 `current`）；
 * 2. 逐条 `updateTaskFact`：追加新版本、旧版本置失效但**值原样保留**、留来源与版本；
 * 3. 汇总 `differences`（仅成功项）、`failures`（失败项）与 `partial`。
 */
export function resolveCurrentInstructionAgainstMemory(
  input: ResolveCurrentInstructionInput,
): ConflictResolutionReport {
  const preferenceResolution = resolvePreferenceConflict({
    current_instructions: input.current_instructions,
    preferences: input.preferences,
  });

  const differences: ResolvedDifference[] = [];
  for (const conflict of preferenceResolution.conflicts) {
    differences.push(
      Object.freeze({
        kind: 'preference',
        key: conflict.preference_key,
        from: conflict.preferred_value,
        to: conflict.current_value,
        note: conflict.note,
      }),
    );
  }

  const factOutcomes: FactUpdateOutcome[] = [];
  const failures: string[] = [];

  for (const request of input.fact_updates) {
    const result = updateTaskFact({
      repository: input.repository,
      owner_id: input.owner_id,
      task_id: request.task_id,
      fact_key: request.fact_key,
      value_text: request.value_text,
      source: request.source,
      at: input.at,
      newMemoryId: input.newMemoryId,
    });
    factOutcomes.push(Object.freeze({ request, result }));

    switch (result.kind) {
      case 'updated':
        differences.push(
          Object.freeze({
            kind: 'task_fact',
            key: request.fact_key,
            from: result.previous_value ?? '(无)',
            to: result.entry.value_text,
            note: result.explanation,
          }),
        );
        break;
      case 'no_change':
        // 值未变：正确动作是不新增版本，也不制造差异
        break;
      case 'failed':
        failures.push(`任务事实 "${request.fact_key}" 未更新（${result.reason}）：${result.detail}`);
        break;
    }
  }

  const partial = failures.length > 0;
  const explanation =
    `按当前明确要求执行（applied=current）：偏好冲突 ${String(
      preferenceResolution.conflicts.length,
    )} 处、任务事实变更 ${String(
      differences.filter((difference) => difference.kind === 'task_fact').length,
    )} 处` +
    (partial ? `；但有 ${String(failures.length)} 处未能完成，如实标注（R240）` : '') +
    `。旧偏好未删除，历史事实版本原样保留可审计（R236）。`;

  return Object.freeze({
    applied: 'current',
    preference_resolution: preferenceResolution,
    differences: Object.freeze(differences),
    fact_outcomes: Object.freeze(factOutcomes),
    partial,
    failures: Object.freeze(failures),
    explanation,
  });
}

// ---------------------------------------------------------------------------
// 事实版本追溯（不悄悄改历史的证据）
// ---------------------------------------------------------------------------

/** 一条事实版本的可读留痕。 */
export interface FactVersionTraceEntry {
  readonly memory_id: MemoryId;
  readonly version: Revision;
  readonly value_text: string;
  readonly status: MemoryStatus;
  readonly source: MemorySource;
  readonly updated_at: LogicalTime;
}

/** 某个 `(任务, 事实键)` 的版本链。 */
export interface FactVersionTrace {
  readonly task_id: TaskId;
  readonly fact_key: string;
  /** 全部版本（升序，含已失效）——历史的证据。 */
  readonly versions: readonly FactVersionTraceEntry[];
  /** 当前**有效**值（无有效条目时为 `null`）。 */
  readonly current_value: string | null;
  /** 当前有效值的**上一条**历史值（无则为 `null`）——供说明新旧差异。 */
  readonly previous_value: string | null;
}

/**
 * 读回某个 `(owner, task, fact_key)` 的**全部版本**（升序）。
 *
 * 这是"更新不悄悄改历史"的可读证据：旧版本仍在链上（通常是 `disabled`），
 * 各自带 `value_text` / `version` / `source`。新值生效时，`current_value` 与
 * `previous_value` 同时给出，调用方据此向用户交代差异。
 */
export function traceFactVersions(
  repository: MemoryRepository,
  input: { readonly owner_id: OwnerId; readonly task_id: TaskId; readonly fact_key: string },
): FactVersionTrace {
  const history = readTaskFactHistory(repository, input);
  const versions = history.map((entry) =>
    Object.freeze({
      memory_id: entry.memory_id,
      version: entry.version,
      value_text: entry.value_text,
      status: entry.status,
      source: entry.source,
      updated_at: entry.updated_at,
    }),
  );

  const active = history.filter((entry) => entry.status === 'active');
  const current = active[active.length - 1] ?? null;
  const previous = current === null ? null : history.filter((entry) => entry.version < current.version).at(-1) ?? null;

  return Object.freeze({
    task_id: input.task_id,
    fact_key: input.fact_key,
    versions: Object.freeze(versions),
    current_value: current?.value_text ?? null,
    previous_value: previous?.value_text ?? null,
  });
}

/**
 * 检索注入与偏好冲突（design-06 P4 / MEM-03 / MEM-04；合同 R236 / R237 / R240）。
 *
 * ## 注入是**有上限的摘要**，不是"把个人历史整份塞进上下文"（R237）
 *
 * `buildMemoryInjection()` 把 `recall()` 的结果拼成一段**有长度与数量上限**的文本摘要。
 * 上限由 `MemoryQueryLimits` 给出（默认 `max_items=20` / `max_chars=4000`），
 * 超出部分**截断并在 `detail` 里如实标注**。实例**不默认复制全部个人历史**。
 *
 * ## R240：组装环节**同样不编造**
 *
 * `status !== 'found'` 时（查不到 / 不确定 / 失败），**摘要为空串**，`detail` 带上原因。
 * 组装层**绝不**用"看起来像记忆"的占位文本填充——那正是"编造已经记住"的写法。
 *
 * ## R236：当前明确指令优先于旧偏好，并说明差异
 *
 * `resolvePreferenceConflict()` 的结论恒为 `applied: 'current'`：当前明确要求照做；
 * 与之冲突的旧偏好被**列出来并说明差异**，既不静默丢弃，也不反过来压过当前要求。
 */

import type { MemoryId, MemoryQueryLimits, PreferenceMemory } from './types.js';
import { DEFAULT_MEMORY_LIMITS } from './types.js';
import {
  entryText,
  type MemoryQuery,
  type MemoryRecallResult,
  type MemoryRecallStatus,
  type MemoryRepository,
} from './repository.js';

/** 组装好的记忆注入。 */
export interface MemoryInjection {
  readonly status: MemoryRecallStatus;
  /** 注入文本；非 `found` 时**为空串**（不编造）。 */
  readonly digest: string;
  readonly included_ids: readonly MemoryId[];
  readonly truncated: boolean;
  readonly limits: MemoryQueryLimits;
  readonly detail: string | null;
}

/**
 * 组装记忆注入（有上限的摘要）。
 *
 * @throws {ValidationError} 上限非法（非正整数）时——"没有上限"不是本层的选项（R237）。
 */
export function buildMemoryInjection(
  repository: MemoryRepository,
  query: MemoryQuery,
  limits: MemoryQueryLimits = DEFAULT_MEMORY_LIMITS,
): MemoryInjection {
  const recalled: MemoryRecallResult = repository.recall(query, limits);
  if (recalled.status !== 'found') {
    return Object.freeze({
      status: recalled.status,
      digest: '',
      included_ids: Object.freeze([]),
      truncated: false,
      limits: recalled.limits,
      detail: recalled.detail,
    });
  }
  // 摘要：只带来源类别与文本，不带 id（id 另给，供联动失效与审计）
  const digest = recalled.entries.map((entry) => `- [${entry.kind}] ${entryText(entry)}`).join('\n');
  return Object.freeze({
    status: recalled.status,
    digest,
    included_ids: Object.freeze(recalled.entries.map((entry) => entry.memory_id)),
    truncated: recalled.truncated,
    limits: recalled.limits,
    detail: recalled.detail,
  });
}

// ---------------------------------------------------------------------------
// 偏好冲突（R236）
// ---------------------------------------------------------------------------

/** 当前明确指令覆盖到的一条偏好键。 */
export interface CurrentInstruction {
  readonly preference_key: string;
  readonly value: string;
}

/** 一条与当前指令冲突的旧偏好。 */
export interface PreferenceConflict {
  readonly preference_key: string;
  /** 旧偏好的值。 */
  readonly preferred_value: string;
  /** 当前明确指令的值（**本次采用**的那个）。 */
  readonly current_value: string;
  readonly note: string;
}

export interface PreferenceResolution {
  /** 恒为 `current`：按当前要求执行（R236）。 */
  readonly applied: 'current';
  readonly conflicts: readonly PreferenceConflict[];
  /** 未被当前指令覆盖的旧偏好（可继续沿用）。 */
  readonly unopposed: readonly PreferenceMemory[];
}

/**
 * 解决"当前明确指令 vs 旧偏好"的冲突：**照当前要求执行并说明差异**（R236）。
 *
 * 冲突判定 = 同一 `preference_key` 下值不同。被覆盖的旧偏好**不删除**，
 * 只是列出差异；调用方据此向用户说明"这次按你说的来，之前记的是 X"。
 */
export function resolvePreferenceConflict(input: {
  readonly current_instructions: readonly CurrentInstruction[];
  readonly preferences: readonly PreferenceMemory[];
}): PreferenceResolution {
  const conflicts: PreferenceConflict[] = [];
  const unopposed: PreferenceMemory[] = [];

  for (const preference of input.preferences) {
    const instruction = input.current_instructions.find(
      (candidate) => candidate.preference_key === preference.preference_key,
    );
    if (instruction === undefined) {
      unopposed.push(preference);
      continue;
    }
    if (instruction.value === preference.value_text) {
      unopposed.push(preference); // 不冲突：与当前要求一致
      continue;
    }
    conflicts.push(
      Object.freeze({
        preference_key: preference.preference_key,
        preferred_value: preference.value_text,
        current_value: instruction.value,
        note:
          `当前明确要求 "${preference.preference_key}=${instruction.value}"，` +
          `与旧偏好 "${preference.preference_key}=${preference.value_text}" 不同：` +
          '按当前要求执行，并向用户说明这处差异（R236）',
      }),
    );
  }

  return Object.freeze({
    applied: 'current',
    conflicts: Object.freeze(conflicts),
    unopposed: Object.freeze(unopposed),
  });
}

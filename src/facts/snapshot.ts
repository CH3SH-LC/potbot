/**
 * 按版本装配只读事实快照（design-02 P3；合同 v1.4 R48）。
 *
 * ## 这一层为什么存在
 *
 * R48.3 把“单一来源”钉成结构性的：三类模板构建器的输入契约里**没有原始数字的参数位置**，
 * 只有事实键与事实快照。本文件就是“事实记录 → 快照”的那一步，且它**只做装配、不做判断**：
 *
 * - 当前事实由 W-B 的 `currentFactByKey` 决定（**唯一判据**）——同一任务 + 版本 + 键若出现
 *   两条“当前”事实，`currentFactByKey` 会抛 `ValidationError`。本层**刻意不绕过、不吞掉**它：
 *   单一来源被破坏时必须显式失败，而不是在这里再造一套去重/任取一条。
 * - 被 `supersedes_fact_id` 取代的历史事实**不进可用表**，但仍可用 `factsByKey` 查到（历史可追）。
 * - `task_revision` 高于所查版本的事实**不算当前**（`currentFactByKey` 已按版本收窄）。
 *
 * ## “缺失不得当零”在类型上的表达
 *
 * 可用表装的是 `KnownFactSnapshotEntry`——它的 `value` 是 `KnownFactValue`（number | date | text），
 * **类型上就装不进** `unknown` / `not_applicable`。未知、不适用、以及“根本没登记这个键”的
 * 三种情况全部走**不可用表**（`UnusableFactEntry`），带着原因交给调用方阻塞为 `missing_fact`。
 * 本层**不产生任何零值/默认值产物**，也不把缺失“补”成 0 或空串。
 *
 * 纯函数：不含 IO、不含墙钟、不含随机数。
 */

import {
  currentFactByKey,
  ValidationError,
  type FactRef,
  type Revision,
  type SharedFactRecord,
  type TaskId,
} from '../protocol/index.js';
import type { KnownFactSnapshotEntry } from '../artifacts/ports.js';

// ---------------------------------------------------------------------------
// 不可用事实（结构化清单）
// ---------------------------------------------------------------------------

/**
 * 不可用种类（封闭枚举）。
 *
 * - `unknown`：当前事实显式表达为未知（`{ kind: 'unknown', reason }`）；
 * - `not_applicable`：当前事实显式表达为不适用；
 * - `missing`：该键在此任务 + 版本下**没有登记任何当前事实**（未登记 / 只登记了别的版本）。
 */
export const UNUSABLE_FACT_KINDS = ['unknown', 'not_applicable', 'missing'] as const;
export type UnusableFactKind = (typeof UNUSABLE_FACT_KINDS)[number];

/** 不可用事实条目：`missing_fact` 阻塞的结构化依据。 */
export interface UnusableFactEntry {
  readonly fact_key: string;
  /**
   * 当前事实 id；**`missing` 时为 `null`**——没有事实可指，绝不为缺失伪造一个 id。
   */
  readonly fact_ref: FactRef | null;
  readonly kind: UnusableFactKind;
  /** 为什么不可用（未知/不适用的原样透传原因；缺失给可读说明）。**不得为空**。 */
  readonly reason: string;
}

/** 事实快照：可用表（只装已知值）+ 不可用表（unknown / not_applicable / missing）。 */
export interface FactSnapshot {
  readonly task_id: TaskId;
  readonly task_revision: Revision;
  /** 可用事实——只可能是已知值（`KnownFactValue`），类型上装不进未知。 */
  readonly usable: readonly KnownFactSnapshotEntry[];
  /** 不可用事实——调用方据此阻塞为 `missing_fact`。 */
  readonly unusable: readonly UnusableFactEntry[];
}

/** 装配输入。 */
export interface FactSnapshotInput {
  /** 该任务的全部共享事实（可跨版本；本层按 `task_revision` 自己收窄）。 */
  readonly facts: readonly SharedFactRecord[];
  readonly task_id: TaskId;
  readonly task_revision: Revision;
  /**
   * 需要装配的稳定事实键——**模板构建器声明的输入契约**。
   * 输出顺序即本数组顺序。重复键 ⇒ 抛（重复声明会让同一键在快照里出现两次，违反唯一性）。
   */
  readonly fact_keys: readonly string[];
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

function requireFactKeys(factKeys: readonly string[]): void {
  const seen = new Set<string>();
  for (const key of factKeys) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new ValidationError('FactSnapshotInput.fact_keys 的元素必须是非空字符串');
    }
    if (seen.has(key)) {
      throw new ValidationError(
        `FactSnapshotInput.fact_keys 出现重复键 ${key}：同一任务 + 版本 + 键必须唯一，` +
          '重复声明会产生两条同一键的条目（调用方错误）',
      );
    }
    seen.add(key);
  }
}

function missingReason(taskId: TaskId, revision: Revision, factKey: string): string {
  return (
    `事实键 ${factKey} 在任务 ${taskId}@r${String(revision)} 下没有登记的当前事实：` +
    '缺失必须如实上报（missing_fact），不得当零或取默认值'
  );
}

/**
 * 把某任务在某个 `task_revision` 下的当前共享事实装配成两张表。
 *
 * 对每个 `fact_keys` 中的键，取该（任务 + 版本 + 键）的**当前**事实：
 * - 已知 ⇒ 进可用表（`KnownFactSnapshotEntry`）；
 * - `unknown` / `not_applicable` ⇒ 进不可用表，`kind` 与原因原样透传；
 * - 没有当前事实（未登记 / 只登记了别的版本）⇒ 进不可用表，`kind: 'missing'`，`fact_ref: null`。
 *
 * @throws {ValidationError} `fact_keys` 含空串或重复键；或同一键出现两条“当前”事实
 *   （后者由 `currentFactByKey` 抛出——**单一来源判据，刻意保留**）。
 */
export function buildFactSnapshot(input: FactSnapshotInput): FactSnapshot {
  requireFactKeys(input.fact_keys);

  const usable: KnownFactSnapshotEntry[] = [];
  const unusable: UnusableFactEntry[] = [];

  for (const factKey of input.fact_keys) {
    const current = currentFactByKey(input.facts, {
      task_id: input.task_id,
      task_revision: input.task_revision,
      fact_key: factKey,
    });

    if (current === undefined) {
      unusable.push(
        Object.freeze({
          fact_key: factKey,
          fact_ref: null,
          kind: 'missing' as const,
          reason: missingReason(input.task_id, input.task_revision, factKey),
        }),
      );
      continue;
    }

    if (current.value.kind === 'known') {
      usable.push(
        Object.freeze({
          fact_ref: current.fact_id,
          fact_key: factKey,
          value: current.value.value,
          source: current.source,
        }),
      );
    } else if (current.value.kind === 'unknown') {
      unusable.push(
        Object.freeze({
          fact_key: factKey,
          fact_ref: current.fact_id,
          kind: 'unknown' as const,
          reason: current.value.reason,
        }),
      );
    } else {
      unusable.push(
        Object.freeze({
          fact_key: factKey,
          fact_ref: current.fact_id,
          kind: 'not_applicable' as const,
          reason: current.value.reason,
        }),
      );
    }
  }

  return Object.freeze({
    task_id: input.task_id,
    task_revision: input.task_revision,
    usable: Object.freeze(usable),
    unusable: Object.freeze(unusable),
  });
}

/** 该快照是否可安全进入物化：不可用表为空 ⟺ 所有声明的事实键都有已知当前值。 */
export function isFactSnapshotUsable(snapshot: FactSnapshot): boolean {
  return snapshot.unusable.length === 0;
}

/**
 * 把不可用表拼成一段可读串（供调用方填 `missing_fact` 失败记录的 `detail`）。
 * 无不可用项时返回空串——调用方在 `isFactSnapshotUsable()` 为真时不应据此建失败记录。
 */
export function describeUnusableFacts(snapshot: FactSnapshot): string {
  return snapshot.unusable
    .map((entry) => {
      const ref = entry.fact_ref === null ? '（未登记）' : entry.fact_ref;
      return `${entry.fact_key} [${entry.kind}] ${ref}：${entry.reason}`;
    })
    .join('；');
}

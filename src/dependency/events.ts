/**
 * 诊断 / 恢复的**观测事件**构造（D05；合同 §七 Q10-a、v1.1 R4）。
 *
 * R4 要求"不要另算计数"：诊断次数必须**能被 D01 的 `summarizeKernelEvents()` 统计到**。
 * 所以本模块不自己数数，而是把诊断产出成 `KernelEvent`：
 *
 * - `kind = 'diagnosis_performed'` ⇒ `summarizeKernelEvents().diagnosis_count`（A05-03 的 D_max 口径）；
 * - `kind = 'diagnosis_budget_exhausted'` ⇒ 诊断额度已用尽的**耗尽报告**：**不计入**该计数器，
 *   也不进入预算投影（合同 v1.3 R44.3；G03 修复批）；
 * - `kind = 'recovery_performed'` ⇒ 自动恢复的可追踪证据（A05-09 / A05-10）。
 *
 * **只在"报告"时产生诊断事件**：暂停是正常等待，不是停滞诊断——
 * 否则 A05-L-06「无环对照的停滞/死锁诊断事件数 = 0」会被正常等待的检查污染。
 *
 * 事件由调用方写入（`tx.appendKernelEvent`）。事件内容**确定性**（无时间戳以外的不确定字段，
 * 且 `at` 由调用方给出，遵守 Q8-a"内核不自行推进时间"）。
 */

import {
  createKernelEvent,
  type EventIdSource,
  type GroupId,
  type InstanceId,
  type KernelEvent,
  type LogicalTime,
  type RequestId,
  type StorageTransaction,
  type TaskId,
} from '../protocol/index.js';
import type { StagnationDiagnosis } from './diagnosis.js';
import type { AutoRecoveryRecord } from './recovery.js';

/** 是否应为本次诊断产生 `diagnosis_performed` 事件（只有"报告"才产生）。 */
export function shouldEmitDiagnosis(diagnosis: StagnationDiagnosis): boolean {
  return diagnosis.disposition === 'report';
}

export interface DiagnosisEventOptions {
  readonly at: LogicalTime;
  readonly event_ids: EventIdSource;
  readonly task_id?: TaskId | null;
  readonly group_id?: GroupId | null;
  readonly instance_id?: InstanceId | null;
}

/**
 * 构造诊断报告事件；**不产生**（返回 `null`）当诊断只是正常等待 / 可推进。
 *
 * ## 事件种类按 `consumes_diagnosis_budget` 选择（合同 v1.3 R44.2 / R44.3；G03 修复批）
 * - `true`  → `'diagnosis_performed'`：一次真实诊断，**计入** `diagnosis_count`
 *   与 `CommittedBudgetProjection` 的记账事实；
 * - `false` → `'diagnosis_budget_exhausted'`：额度已用尽的**耗尽报告**，
 *   **不计入** `diagnosis_count`、**不进入**预算投影（该种类在 `constants.ts` 已注明）。
 *
 * 因此 **`diagnosis_performed` 事件数 = 台账 `diagnoses` 用量 ≤ `D_max`** 恒成立（R44.2）。
 *
 * `data` 携带可读证据（判定、指纹键与摘要、环路径、预算超限维度）；
 * 计数本身只依赖事件 `kind`（由 `summarizeKernelEvents` 的口径决定）。
 * 耗尽报告额外携带 `used` / `limit`（诊断维度的用量与上限），便于取证（R44.3）。
 */
export function diagnosisKernelEvent(
  diagnosis: StagnationDiagnosis,
  options: DiagnosisEventOptions,
): KernelEvent | null {
  if (!shouldEmitDiagnosis(diagnosis)) {
    return null;
  }
  const data = {
    verdict: diagnosis.verdict,
    disposition: diagnosis.disposition,
    reason: diagnosis.reason,
    blocked_request_ids: [...diagnosis.blocked_request_ids],
    cycle_request_ids: [...diagnosis.cycles.flatMap((cycle) => cycle.request_ids)],
    cycle_descriptions: [...diagnosis.cycle_descriptions],
    fingerprint_key: diagnosis.fingerprint === null ? null : diagnosis.fingerprint.key,
    fingerprint_digest: diagnosis.fingerprint === null ? null : diagnosis.fingerprint.digest,
    budget_exceeded: diagnosis.budget === null ? null : [...diagnosis.budget.exceeded],
    consumes_diagnosis_budget: diagnosis.consumes_diagnosis_budget,
  };
  const base = {
    at: options.at,
    task_id: options.task_id ?? null,
    group_id: options.group_id ?? null,
    instance_id: options.instance_id ?? null,
  };
  if (diagnosis.consumes_diagnosis_budget) {
    return createKernelEvent({ kind: 'diagnosis_performed', ...base, data }, options.event_ids);
  }
  return createKernelEvent(
    {
      kind: 'diagnosis_budget_exhausted',
      ...base,
      data: {
        ...data,
        // R44.3：`data` 至少携带 verdict / used / limit / reason（verdict 与 reason 已在上方）。
        used: diagnosis.budget === null ? null : diagnosis.budget.usage.diagnoses,
        limit: diagnosis.budget === null ? null : diagnosis.budget.limits.diagnoses,
      },
    },
    options.event_ids,
  );
}

/**
 * 构造并（可选）写入诊断报告事件。
 * 返回写入的事件；诊断不需要报告时返回 `null`（不写任何东西）。
 *
 * 签名与返回类型（`KernelEvent | null`）与 G03 修复前**保持一致**：调用方无需分支——
 * 真实报告写 `diagnosis_performed`，耗尽报告写 `diagnosis_budget_exhausted`（R44.2/R44.3）。
 */
export function recordDiagnosis(
  tx: StorageTransaction,
  diagnosis: StagnationDiagnosis,
  options: DiagnosisEventOptions,
): KernelEvent | null {
  const event = diagnosisKernelEvent(diagnosis, options);
  if (event !== null) {
    tx.appendKernelEvent(event);
  }
  return event;
}

export interface RecoveryEventOptions {
  readonly at: LogicalTime;
  readonly event_ids: EventIdSource;
  readonly instance_id: InstanceId;
  readonly task_id?: TaskId | null;
  readonly group_id?: GroupId | null;
  readonly request_id?: RequestId | null;
}

/** 构造 `recovery_performed` 事件（自动恢复的可追踪证据，A05-10：动作内容可指认、不重复）。 */
export function autoRecoveryKernelEvent(
  record: AutoRecoveryRecord,
  options: RecoveryEventOptions,
): KernelEvent {
  return createKernelEvent(
    {
      kind: 'recovery_performed',
      at: options.at,
      task_id: options.task_id ?? null,
      group_id: options.group_id ?? null,
      instance_id: options.instance_id,
      request_id: options.request_id ?? null,
      data: {
        action: record.action,
        action_digest: record.action_digest,
        fingerprint_key: record.fingerprint_key,
        fingerprint_digest: record.fingerprint_digest,
        evidence_ref: record.evidence_ref,
      },
    },
    options.event_ids,
  );
}

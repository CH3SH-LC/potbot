/**
 * **自管提醒**的模型与生命周期（CLK-01 / CLK-02 / CLK-03 / CLK-04 / CLK-07 的纯逻辑部分）。
 *
 * ## 自管 ≠ 系统闹钟（CLK-10，本模块最重要的一条）
 *
 * 这里存的是 **potbot 自己记账的提醒**（`ownership: 'self_managed'`）。它**不是**手机
 * 系统时钟应用里的闹钟，也**不会**出现在系统闹钟列表里。合同 CLK-10 明令：
 * 「不能用自管记录冒充系统闹钟已改」。因此：
 * - {@link AlarmStore.list} **只**返回自管记录；
 * - 任何"手机上的全部闹钟"必须经系统读取接口（见 `handoff.ts` 的 `listSystemAlarms`），
 *   没有该接口时**如实报告未就绪**，绝不用自管记录顶替。
 *
 * ## 幂等与版本（CLK-04 / CLK-09）
 *
 * - `create` 带**幂等键**：同一键重放返回既有记录（`duplicate: true`），不重复创建；
 * - `update` / `remove` / `setEnabled` / `cancelOccurrence` 都要求 `expectedRevision`，
 *   版本不符 ⇒ 显式 `revision_conflict`，**不静默覆盖**（这是"气泡与执行读同一对象"R243 的落点）。
 *
 * 不读墙钟：`nowMs` 与 id 由宿主注入。
 */

import { formatDate, epochToWall } from './civil.js';
import { describeRepeat, nextOccurrence, occurrencesBetween, validateRepeatRule } from './repeat.js';
import type { AlarmDraft, AlarmOccurrence, AlarmRecord } from './types.js';
import type { ZonePort } from './zone.js';

export interface AlarmStoreOptions {
  readonly zonePort: ZonePort;
  /**
   * 稳定 ID 来源。**必须**由宿主提供跨重启唯一的值（合同 R202）。
   * 默认实现仅为**测试便利**，不得用于产品路径。
   */
  readonly idSource?: () => string;
  /** 初始快照（用于恢复）。 */
  readonly snapshot?: string;
}

export interface AlarmCreateOk {
  readonly ok: true;
  readonly record: AlarmRecord;
  /** 是否为幂等重放（true = 命中既有键，**未**新建）。 */
  readonly duplicate: boolean;
}
export interface AlarmCreateFail {
  readonly ok: false;
  readonly reason: 'invalid_draft' | 'unknown_zone';
  readonly problems: readonly string[];
}
export type AlarmCreateResult = AlarmCreateOk | AlarmCreateFail;

export interface AlarmMutationOk {
  readonly ok: true;
  readonly record: AlarmRecord;
}
export interface AlarmMutationFail {
  readonly ok: false;
  readonly reason: 'not_found' | 'revision_conflict' | 'invalid_patch';
  readonly current: AlarmRecord | null;
  readonly problems: readonly string[];
}
export type AlarmMutationResult = AlarmMutationOk | AlarmMutationFail;

export interface AlarmPatch {
  readonly label?: string;
  readonly zoneId?: string;
  readonly firstTriggerMs?: number;
  readonly repeat?: AlarmDraft['repeat'];
}

export interface AlarmStore {
  create(draft: AlarmDraft, idempotencyKey: string): AlarmCreateResult;
  update(id: string, patch: AlarmPatch, expectedRevision: number): AlarmMutationResult;
  setEnabled(id: string, enabled: boolean, expectedRevision: number): AlarmMutationResult;
  remove(id: string, expectedRevision: number): AlarmMutationResult;
  /** 「取消一次发生」：跳过**该次**（按闹钟时区的本地日期），不删除整条（CLK-04）。 */
  cancelOccurrence(id: string, occurrenceEpochMs: number, expectedRevision: number): AlarmMutationResult;
  get(id: string): AlarmRecord | null;
  /** **仅**自管记录（不冒充系统闹钟，CLK-10）。 */
  list(): readonly AlarmRecord[];
  nextTrigger(id: string, afterMs: number): number | null;
  occurrences(id: string, fromMs: number, toMs: number, limit?: number): readonly AlarmOccurrence[];
  /** 展示用摘要（下次触发 + 重复规则），CLK-03。 */
  describe(id: string, nowMs: number): AlarmSummary | null;
  toSnapshot(): string;
}

export interface AlarmSummary {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly ownership: 'self_managed';
  readonly repeatText: string;
  readonly nextTriggerMs: number | null;
  readonly nextTriggerText: string | null;
  readonly revision: number;
}

interface SnapshotShape {
  readonly records: readonly AlarmRecord[];
  readonly idempotency: Readonly<Record<string, string>>;
}

export function createAlarmStore(options: AlarmStoreOptions): AlarmStore {
  const { zonePort } = options;
  const records = new Map<string, AlarmRecord>();
  const idempotency = new Map<string, string>();
  let counter = 0;

  const idSource =
    options.idSource ??
    (() => {
      counter += 1;
      return `alarm-local-${String(counter)}`;
    });

  if (options.snapshot !== undefined) {
    const parsed = parseSnapshot(options.snapshot);
    if (parsed !== null) {
      for (const record of parsed.records) records.set(record.id, record);
      for (const [key, id] of Object.entries(parsed.idempotency)) idempotency.set(key, id);
    }
  }

  const validateDraft = (draft: AlarmDraft): readonly string[] => {
    const problems: string[] = [];
    if (!draft.label.trim()) problems.push('标签不得为空');
    if (!Number.isFinite(draft.firstTriggerMs)) problems.push('首次触发时刻必须是有限数');
    if (zonePort.offsetMinutesAt(draft.zoneId, draft.firstTriggerMs) === null) {
      problems.push(`时区未知或非法：${draft.zoneId}`);
    }
    problems.push(...validateRepeatRule(draft.repeat));
    return problems;
  };

  const snapshot = (): SnapshotShape => ({
    records: [...records.values()],
    idempotency: Object.fromEntries(idempotency),
  });

  const summarize = (record: AlarmRecord, nowMs: number): AlarmSummary => {
    const next = record.enabled
      ? nextOccurrence({
          rule: record.repeat,
          zoneId: record.zoneId,
          zonePort,
          anchorMs: record.firstTriggerMs,
          afterMs: nowMs,
          skippedDates: record.skippedDates,
        })
      : null;
    const offset = next === null ? null : zonePort.offsetMinutesAt(record.zoneId, next);
    return {
      id: record.id,
      label: record.label,
      enabled: record.enabled,
      ownership: 'self_managed',
      repeatText: describeRepeat(record.repeat),
      nextTriggerMs: next,
      nextTriggerText:
        next === null || offset === null ? null : `${formatDate(epochToWall(next, offset))} ${formatTimeText(epochToWall(next, offset))}`,
      revision: record.revision,
    };
  };

  return {
    create(draft, idempotencyKey) {
      const existingId = idempotency.get(idempotencyKey);
      if (existingId !== undefined) {
        const existing = records.get(existingId);
        if (existing !== undefined) return { ok: true, record: existing, duplicate: true };
      }
      const problems = validateDraft(draft);
      if (problems.length > 0) {
        const hasZoneProblem = problems.some((text) => text.startsWith('时区未知'));
        return { ok: false, reason: hasZoneProblem ? 'unknown_zone' : 'invalid_draft', problems };
      }
      const record: AlarmRecord = {
        id: idSource(),
        ownership: 'self_managed',
        label: draft.label,
        zoneId: draft.zoneId,
        firstTriggerMs: draft.firstTriggerMs,
        repeat: draft.repeat,
        enabled: true,
        revision: 1,
        createdAtMs: draft.firstTriggerMs,
        skippedDates: [],
      };
      records.set(record.id, record);
      idempotency.set(idempotencyKey, record.id);
      return { ok: true, record, duplicate: false };
    },

    update(id, patch, expectedRevision) {
      const current = records.get(id);
      if (current === undefined) {
        return { ok: false, reason: 'not_found', current: null, problems: [`未找到提醒：${id}`] };
      }
      if (current.revision !== expectedRevision) {
        return {
          ok: false,
          reason: 'revision_conflict',
          current,
          problems: [`目标版本 ${String(expectedRevision)} 与当前 ${String(current.revision)} 不一致`],
        };
      }
      const next: AlarmRecord = {
        ...current,
        label: patch.label ?? current.label,
        zoneId: patch.zoneId ?? current.zoneId,
        firstTriggerMs: patch.firstTriggerMs ?? current.firstTriggerMs,
        repeat: patch.repeat ?? current.repeat,
        revision: current.revision + 1,
      };
      const problems = validateDraft(next);
      if (problems.length > 0) {
        return { ok: false, reason: 'invalid_patch', current, problems };
      }
      records.set(id, next);
      return { ok: true, record: next };
    },

    setEnabled(id, enabled, expectedRevision) {
      const current = records.get(id);
      if (current === undefined) {
        return { ok: false, reason: 'not_found', current: null, problems: [`未找到提醒：${id}`] };
      }
      if (current.revision !== expectedRevision) {
        return { ok: false, reason: 'revision_conflict', current, problems: ['版本不一致'] };
      }
      const next: AlarmRecord = { ...current, enabled, revision: current.revision + 1 };
      records.set(id, next);
      return { ok: true, record: next };
    },

    remove(id, expectedRevision) {
      const current = records.get(id);
      if (current === undefined) {
        return { ok: false, reason: 'not_found', current: null, problems: [`未找到提醒：${id}`] };
      }
      if (current.revision !== expectedRevision) {
        return { ok: false, reason: 'revision_conflict', current, problems: ['版本不一致'] };
      }
      records.delete(id);
      return { ok: true, record: { ...current, revision: current.revision + 1 } };
    },

    cancelOccurrence(id, occurrenceEpochMs, expectedRevision) {
      const current = records.get(id);
      if (current === undefined) {
        return { ok: false, reason: 'not_found', current: null, problems: [`未找到提醒：${id}`] };
      }
      if (current.revision !== expectedRevision) {
        return { ok: false, reason: 'revision_conflict', current, problems: ['版本不一致'] };
      }
      const offset = zonePort.offsetMinutesAt(current.zoneId, occurrenceEpochMs);
      if (offset === null) {
        return { ok: false, reason: 'invalid_patch', current, problems: [`时区未知：${current.zoneId}`] };
      }
      const localDate = formatDate(epochToWall(occurrenceEpochMs, offset));
      if (current.skippedDates.includes(localDate)) {
        return { ok: true, record: current };
      }
      const next: AlarmRecord = {
        ...current,
        skippedDates: [...current.skippedDates, localDate],
        revision: current.revision + 1,
      };
      records.set(id, next);
      return { ok: true, record: next };
    },

    get(id) {
      return records.get(id) ?? null;
    },

    list() {
      return [...records.values()].sort((a, b) => a.firstTriggerMs - b.firstTriggerMs);
    },

    nextTrigger(id, afterMs) {
      const record = records.get(id);
      if (record === undefined || !record.enabled) return null;
      return nextOccurrence({
        rule: record.repeat,
        zoneId: record.zoneId,
        zonePort,
        anchorMs: record.firstTriggerMs,
        afterMs,
        skippedDates: record.skippedDates,
      });
    },

    occurrences(id, fromMs, toMs, limit = 64) {
      const record = records.get(id);
      if (record === undefined) return [];
      return occurrencesBetween(record, zonePort, fromMs, toMs, limit);
    },

    describe(id, nowMs) {
      const record = records.get(id);
      return record === undefined ? null : summarize(record, nowMs);
    },

    toSnapshot() {
      return JSON.stringify(snapshot());
    },
  };
}

/** 从快照重建（`snapshot` 选项也可用于同一目的；此处是显式入口）。 */
export function restoreAlarmStore(options: AlarmStoreOptions): AlarmStore {
  return createAlarmStore(options);
}

function parseSnapshot(json: string): SnapshotShape | null {
  try {
    const value = JSON.parse(json) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    const candidate = value as { records?: unknown; idempotency?: unknown };
    if (!Array.isArray(candidate.records)) return null;
    return {
      records: candidate.records as readonly AlarmRecord[],
      idempotency: (candidate.idempotency ?? {}) as Readonly<Record<string, string>>,
    };
  } catch {
    return null;
  }
}

function formatTimeText(wall: { hour: number; minute: number }): string {
  return `${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`;
}

/**
 * 重启持久性、备份 / 迁移 / 保留期，与"查不到 / 不确定 / 失败**不编造**"的可用性报告
 * （design-06 P4 / MEM-08；合同 R237 / R238 / R240）。
 *
 * ## 重启后记忆仍可用
 *
 * `serializeMemoryBackup()` 把仓库打成一段**可序列化备份**（含四类条目 + 墓碑 + 派生条目）；
 * `reopenMemoryStore()` 用这段备份在**一个新建仓库**里恢复——模拟"进程重启后重新加载"。
 * 因为墓碑与派生失效位都在备份里，重启后：
 * - 已忘记 / 已删除的条目**不会复活**（R238）；
 * - 派生条目的**失效状态**原样保留（不会"重启后又变有效"）。
 *
 * ## ⚠️ 验证边界（**如实标注**）
 *
 * `reopenMemoryStore()` 是**同进程**模拟：它新建仓库并从备份恢复，**不会**真的起第二个进程、
 * 也不经过真实文件系统的跨进程可见性。因此本模块**不代表**已做真实跨进程验证——
 * 跨进程持久化属于 `src/storage/file-store.ts` 的职责（其跨进程证据另见该模块的测试）。
 *
 * ## 备份 / 迁移 / 保留期**可解释**
 *
 * - `planMemoryMigration()`：目标 schema 已知 ⇒ 给出迁移步骤；**未知 schema ⇒ 拒绝**（不猜测转换）。
 * - `planMemoryRetention()`：给出 `cutoff` 与**删除范围说明**（哪些状态在保留期内、哪些过期）。
 * - `applyMemoryRetention()`：逐条执行并汇总，失败条目**如实计入 `failed`**。
 *
 * ## R240：三值可用性，查不到**不得**宣称"已经记住"
 *
 * `reportMemoryAvailability()` 把一次检索结论映射成
 * `available` / `not_found` / `unavailable`，并给出 `can_claim_remembered`：
 * **只有 `found`** 才是 `true`；`not_found`、`uncertain`、`failed` 一律 `false`。
 *
 * 纯函数 + 注入仓库：零 IO（JSON 序列化除外）、时间由调用方经 `LogicalTime` 传入。
 */

import { ValidationError, asLogicalTime, type LogicalTime } from '../protocol/index.js';
import {
  createMemoryRepository,
  type MemoryQuery,
  type MemoryRecallResult,
  type MemoryRecallStatus,
  type MemoryRepository,
  type MemorySnapshot,
  type MemoryRepositoryFaults,
} from './repository.js';
import { cascadeDerivedInvalidation, type DerivedCascade } from './forget-cascade.js';
import type { MemoryEntry, MemoryId, OwnerId } from './types.js';

/** 备份封套的 schema 版本。 */
export const MEMORY_BACKUP_SCHEMA = 'potbot-memory-backup.v1';

/** 可序列化备份封套。 */
export interface MemoryBackupEnvelope {
  readonly schema: string;
  /** 逻辑时间（**非墙钟**）：本备份生成时刻。 */
  readonly created_at: LogicalTime;
  /** 本备份覆盖的主体范围（删除范围可解释的一部分）。 */
  readonly owner_scope: readonly OwnerId[];
  readonly snapshot: MemorySnapshot;
}

// ---------------------------------------------------------------------------
// 备份
// ---------------------------------------------------------------------------

function inOwnerScope(ownerId: OwnerId, owners: readonly OwnerId[] | undefined): boolean {
  return owners === undefined || owners.includes(ownerId);
}

/** 打出备份封套；给 `owners` 时**只**覆盖这些主体（范围可解释）。 */
export function createMemoryBackup(
  repository: MemoryRepository,
  input: { readonly at: LogicalTime; readonly owners?: readonly OwnerId[] },
): MemoryBackupEnvelope {
  const owners = input.owners;
  const full = repository.snapshot();
  const filter = <T extends { readonly owner_id: OwnerId }>(entries: readonly T[]): readonly T[] =>
    Object.freeze(entries.filter((entry) => inOwnerScope(entry.owner_id, owners)));

  const snapshot: MemorySnapshot = Object.freeze({
    session_messages: filter(full.session_messages),
    task_facts: filter(full.task_facts),
    preferences: filter(full.preferences),
    template_experiences: filter(full.template_experiences),
    tombstones: full.tombstones,
    derived: Object.freeze(full.derived.filter((record) => inOwnerScope(record.owner_id, owners))),
  });

  return Object.freeze({
    schema: MEMORY_BACKUP_SCHEMA,
    created_at: input.at,
    owner_scope: Object.freeze(owners === undefined ? [] : [...owners]),
    snapshot,
  });
}

/** 备份 → JSON 字符串（可落盘 / 跨进程传递）。 */
export function serializeMemoryBackup(
  repository: MemoryRepository,
  input: { readonly at: LogicalTime; readonly owners?: readonly OwnerId[] },
): string {
  return JSON.stringify(createMemoryBackup(repository, input));
}

// ---------------------------------------------------------------------------
// 恢复 / 重启
// ---------------------------------------------------------------------------

/** 恢复报告（对"恢复了什么、挡下了什么"的如实交代）。 */
export interface RestoreReport {
  readonly schema: string;
  readonly incoming_entries: number;
  /** 因**墓碑**被挡下、未复活（也不得复活）的条目数（R238）。 */
  readonly skipped_tombstoned: number;
  readonly tombstones: number;
  readonly derived_records: number;
  readonly entries_present_after: number;
  readonly owner_ids: readonly OwnerId[];
  /** **恒为 `'same_process'`**：本模块只做同进程模拟重启，未做真实跨进程验证。 */
  readonly restart_mode: 'same_process';
  readonly detail: string;
}

export const MEMORY_RESTORE_FAILURES = ['unreadable', 'bad_schema', 'corrupt'] as const;
export type MemoryRestoreFailure = (typeof MEMORY_RESTORE_FAILURES)[number];

export type MemoryRestoreResult =
  | { readonly kind: 'restored'; readonly report: RestoreReport }
  | { readonly kind: 'failed'; readonly reason: MemoryRestoreFailure; readonly detail: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateEnvelope(raw: unknown): { readonly ok: true; readonly envelope: MemoryBackupEnvelope } | { readonly ok: false; readonly reason: MemoryRestoreFailure; readonly detail: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: 'corrupt', detail: `备份不是对象（收到 ${typeof raw}）` };
  }
  if (raw.schema !== MEMORY_BACKUP_SCHEMA) {
    return {
      ok: false,
      reason: 'bad_schema',
      detail: `备份 schema 是 ${JSON.stringify(raw.schema)}，期望 ${JSON.stringify(MEMORY_BACKUP_SCHEMA)}：不猜转换`,
    };
  }
  const snapshot = raw.snapshot;
  if (!isPlainObject(snapshot)) {
    return { ok: false, reason: 'corrupt', detail: '备份缺少 snapshot 对象' };
  }
  const arrayFields = [
    'session_messages',
    'task_facts',
    'preferences',
    'template_experiences',
    'tombstones',
    'derived',
  ] as const;
  for (const field of arrayFields) {
    if (!Array.isArray(snapshot[field])) {
      return { ok: false, reason: 'corrupt', detail: `备份 snapshot.${field} 不是数组` };
    }
  }
  return { ok: true, envelope: raw as unknown as MemoryBackupEnvelope };
}

function incomingEntries(envelope: MemoryBackupEnvelope): readonly MemoryEntry[] {
  return [
    ...envelope.snapshot.session_messages,
    ...envelope.snapshot.task_facts,
    ...envelope.snapshot.preferences,
    ...envelope.snapshot.template_experiences,
  ];
}

/**
 * 把一份备份恢复到**给定**仓库（合并；**先看墓碑**，已抹除的 id 不复活，R238）。
 */
export function restoreMemoryBackup(repository: MemoryRepository, raw: unknown): MemoryRestoreResult {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return {
        kind: 'failed',
        reason: 'unreadable',
        detail: `备份无法解析为 JSON：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const validated = validateEnvelope(parsed);
  if (!validated.ok) {
    return { kind: 'failed', reason: validated.reason, detail: validated.detail };
  }
  const envelope = validated.envelope;

  const tombstoned = new Set<string>([
    ...repository.snapshot().tombstones.map(String),
    ...envelope.snapshot.tombstones.map(String),
  ]);
  const incoming = incomingEntries(envelope);
  const skipped = incoming.filter((entry) => tombstoned.has(entry.memory_id)).length;

  repository.restoreSnapshot(envelope.snapshot);

  const ownerIds = [...new Set(incoming.map((entry) => entry.owner_id))].sort() as OwnerId[];
  const presentAfter = repository
    .listByKind('session_message')
    .length +
    repository.listByKind('task_fact').length +
    repository.listByKind('preference').length +
    repository.listByKind('template_experience').length;

  return {
    kind: 'restored',
    report: Object.freeze({
      schema: envelope.schema,
      incoming_entries: incoming.length,
      skipped_tombstoned: skipped,
      tombstones: envelope.snapshot.tombstones.length,
      derived_records: envelope.snapshot.derived.length,
      entries_present_after: presentAfter,
      owner_ids: Object.freeze(ownerIds),
      restart_mode: 'same_process',
      detail:
        `从备份恢复 ${String(incoming.length)} 条（因墓碑挡下 ${String(skipped)} 条，不复活）；` +
        `恢复后库内 ${String(presentAfter)} 条。注意：这是**同进程模拟重启**，未做真实跨进程验证。`,
    }),
  };
}

export type MemoryReopenResult =
  | { readonly kind: 'reopened'; readonly repository: MemoryRepository; readonly report: RestoreReport }
  | { readonly kind: 'failed'; readonly reason: MemoryRestoreFailure; readonly detail: string };

/**
 * 从一个**全新仓库**开始、用备份恢复——模拟"进程重启后重新加载"。
 *
 * ⚠️ **同进程模拟**：不启动第二个进程。真实跨进程持久化由 `src/storage/file-store.ts` 负责，
 * 本函数**不代表**已做跨进程验证。
 */
export function reopenMemoryStore(
  backup: string | MemoryBackupEnvelope,
  options: { readonly faults?: MemoryRepositoryFaults } = {},
): MemoryReopenResult {
  const repository = createMemoryRepository(options);
  const restored = restoreMemoryBackup(repository, backup);
  if (restored.kind === 'failed') {
    return { kind: 'failed', reason: restored.reason, detail: restored.detail };
  }
  return { kind: 'reopened', repository, report: restored.report };
}

// ---------------------------------------------------------------------------
// 迁移
// ---------------------------------------------------------------------------

export interface MemoryMigrationPlan {
  readonly from_schema: string;
  readonly to_schema: string;
  readonly supported: boolean;
  readonly steps: readonly string[];
  readonly detail: string;
}

/**
 * 规划备份迁移。**未知 schema 一律拒绝**——不猜测转换（"可解释"优先于"能跑通"）。
 */
export function planMemoryMigration(
  fromSchema: string,
  toSchema: string = MEMORY_BACKUP_SCHEMA,
): MemoryMigrationPlan {
  if (toSchema !== MEMORY_BACKUP_SCHEMA) {
    return Object.freeze({
      from_schema: fromSchema,
      to_schema: toSchema,
      supported: false,
      steps: Object.freeze([]),
      detail: `目标 schema ${JSON.stringify(toSchema)} 未知：拒绝迁移，不猜测转换`,
    });
  }
  if (fromSchema === toSchema) {
    return Object.freeze({
      from_schema: fromSchema,
      to_schema: toSchema,
      supported: true,
      steps: Object.freeze(['schema 相同：无需迁移，直接恢复']),
      detail: `备份已是 ${MEMORY_BACKUP_SCHEMA}：无需迁移`,
    });
  }
  return Object.freeze({
    from_schema: fromSchema,
    to_schema: toSchema,
    supported: false,
    steps: Object.freeze([
      `识别到来源 schema ${JSON.stringify(fromSchema)} 未知`,
      '拒绝迁移：不得把未知结构强行当作当前 schema 读入',
    ]),
    detail:
      `来源 schema ${JSON.stringify(fromSchema)} 不在已知迁移路径中：拒绝迁移（宁可报"不能迁移"，` +
      '也不猜一个可能丢数据的转换）',
  });
}

// ---------------------------------------------------------------------------
// 保留期
// ---------------------------------------------------------------------------

/**
 * 保留期策略（逻辑时间度量）。
 *
 * - `max_age`：`now - updated_at` **超过**它即过期；
 * - `retain_disabled`：`true` ⇒ 已停用条目**豁免**（长期保留）；`false` ⇒ 停用条目同样过期；
 * - `retain_deleted_audit`：`true` ⇒ 已软删除条目的**审计记录**长期保留；`false` ⇒ 过期后连审计一并清除
 *   （**墓碑仍会保留**，所以清除审计也**不会**让条目复活，R238）。
 */
export interface MemoryRetentionPolicy {
  readonly max_age: number;
  readonly retain_disabled: boolean;
  readonly retain_deleted_audit: boolean;
}

export interface RetentionPlan {
  readonly cutoff: LogicalTime;
  readonly expired_ids: readonly MemoryId[];
  readonly retained_ids: readonly MemoryId[];
  /** **删除范围说明**（可解释性）：哪类状态在保留期内、哪类会过期。 */
  readonly deletion_scope_explanation: string;
}

function isExpired(
  entry: MemoryEntry,
  now: LogicalTime,
  policy: MemoryRetentionPolicy,
): boolean {
  if (now - entry.updated_at <= policy.max_age) return false; // 保留期内
  switch (entry.status) {
    case 'active':
      return true;
    case 'disabled':
      return !policy.retain_disabled;
    case 'deleted':
      return !policy.retain_deleted_audit;
  }
}

/** 规划保留期清理（**只读**；不改库）。 */
export function planMemoryRetention(
  repository: MemoryRepository,
  input: {
    readonly policy: MemoryRetentionPolicy;
    readonly now: LogicalTime;
    readonly owners?: readonly OwnerId[];
  },
): RetentionPlan {
  if (!Number.isFinite(input.policy.max_age) || input.policy.max_age < 0) {
    throw new ValidationError('保留期 max_age 必须是 ≥ 0 的有限数（逻辑时间跨度）');
  }
  const expired: MemoryId[] = [];
  const retained: MemoryId[] = [];
  const kinds = ['session_message', 'task_fact', 'preference', 'template_experience'] as const;
  for (const kind of kinds) {
    for (const entry of repository.listByKind(kind)) {
      if (input.owners !== undefined && !input.owners.includes(entry.owner_id)) continue;
      if (isExpired(entry, input.now, input.policy)) expired.push(entry.memory_id);
      else retained.push(entry.memory_id);
    }
  }
  const cutoff = asLogicalTime(input.now - input.policy.max_age);
  return Object.freeze({
    cutoff,
    expired_ids: Object.freeze(expired),
    retained_ids: Object.freeze(retained),
    deletion_scope_explanation:
      `保留期 ${String(input.policy.max_age)} 逻辑时间单位（截止 ${String(cutoff)}）：` +
      `活跃条目超期即清除；已停用条目${input.policy.retain_disabled ? '豁免保留' : '同样清除'}；` +
      `已删除条目的审计${input.policy.retain_deleted_audit ? '豁免保留' : '随保留期清除，但墓碑仍保留（不复活）'}。` +
      `本次拟清除 ${String(expired.length)} 条、保留 ${String(retained.length)} 条。`,
  });
}

export interface RetentionOutcome {
  readonly plan: RetentionPlan;
  readonly forgotten: readonly MemoryId[];
  readonly cascade: DerivedCascade;
  /** 逐条失败（如实报告，不宣称整批成功）。 */
  readonly failed: readonly { readonly memory_id: MemoryId; readonly detail: string }[];
  readonly ok: boolean;
}

/** 执行保留期清理：过期条目走**硬忘记**（写墓碑），派生条目联动失效。 */
export function applyMemoryRetention(
  repository: MemoryRepository,
  input: {
    readonly policy: MemoryRetentionPolicy;
    readonly now: LogicalTime;
    readonly owners?: readonly OwnerId[];
  },
): RetentionOutcome {
  const plan = planMemoryRetention(repository, input);
  const forgotten: MemoryId[] = [];
  const failed: { memory_id: MemoryId; detail: string }[] = [];

  for (const memoryId of plan.expired_ids) {
    const entry = repository.get(memoryId);
    if (entry === undefined) {
      failed.push({ memory_id: memoryId, detail: '清理时条目已不存在（并发删除？）' });
      continue;
    }
    const result = repository.forget(memoryId, entry.owner_id);
    if (result.forgotten.length === 0) {
      failed.push({ memory_id: memoryId, detail: '忘记未生效（属主不匹配或条目不存在）' });
      continue;
    }
    forgotten.push(...result.forgotten);
  }

  const cascade = cascadeDerivedInvalidation(repository, forgotten);
  return Object.freeze({
    plan,
    forgotten: Object.freeze(forgotten),
    cascade,
    failed: Object.freeze(failed),
    ok: failed.length === 0,
  });
}

// ---------------------------------------------------------------------------
// 可用性报告（R240：查不到不得宣称"已经记住"）
// ---------------------------------------------------------------------------

export const MEMORY_AVAILABILITY = ['available', 'not_found', 'unavailable'] as const;
export type MemoryAvailability = (typeof MEMORY_AVAILABILITY)[number];

export interface MemoryAvailabilityReport {
  readonly availability: MemoryAvailability;
  /** **只有** `found` 才是 `true`；其余一律 `false`（不得编造"已经记住"）。 */
  readonly can_claim_remembered: boolean;
  readonly source_status: MemoryRecallStatus;
  readonly matched: number;
  readonly detail: string;
}

/** 把一次检索结论映射成**诚实**的可用性报告（R240）。 */
export function reportMemoryAvailability(result: MemoryRecallResult): MemoryAvailabilityReport {
  switch (result.status) {
    case 'found':
      return Object.freeze({
        availability: 'available',
        can_claim_remembered: true,
        source_status: result.status,
        matched: result.total_matched,
        detail: `找到 ${String(result.total_matched)} 条记忆（注入 ${String(result.entries.length)} 条）`,
      });
    case 'not_found':
      return Object.freeze({
        availability: 'not_found',
        can_claim_remembered: false,
        source_status: result.status,
        matched: 0,
        detail: '查不到匹配记忆：**没有记住**，不得宣称"已经记住"（R240）',
      });
    case 'uncertain':
    case 'failed':
      return Object.freeze({
        availability: 'unavailable',
        can_claim_remembered: false,
        source_status: result.status,
        matched: 0,
        detail: `${result.detail ?? '记忆状态不可用'}：存储/完整性不可用，**不得**据此宣称"已经记住"（R240）`,
      });
  }
}

/** 便捷：对仓库做一次检索并给出可用性报告。 */
export function recallAvailability(
  repository: MemoryRepository,
  query: MemoryQuery,
): MemoryAvailabilityReport {
  return reportMemoryAvailability(repository.recall(query));
}

/** 若不足以宣称"已记住" ⇒ 抛（把 R240 变成执行期闸门）。 */
export function assertCanClaimRemembered(report: MemoryAvailabilityReport): void {
  if (!report.can_claim_remembered) {
    throw new ValidationError(
      `记忆不可用于"已记住"结论（availability=${report.availability}，status=${report.source_status}）：${report.detail}`,
    );
  }
}

/**
 * MEM-08 尚未闭合的部分：**备份计划 / 迁移计划 / 保留期**，以及**删除范围可解释**。
 * （design-06 P4 / MEM-08；合同 R234 / R235 / R237 / R238 / R240。）
 *
 * 本文件**只新增**，不改 `src/memory/**` 既有实现；全部能力通过**只读复用** `restart.ts`
 * （`serializeMemoryBackup` / `reopenMemoryStore` / `planMemoryMigration` / `planMemoryRetention`）
 * 落地。四件小事：
 *
 * 1. **备份计划**（`planMemoryBackup`）：四类记忆**分型**说明进不进备份；**密钥与凭据一律不进**——
 *    含凭据的条目被**剔除并记名**（`credential_exclusions[].memory_id`），`assertNoCredentialLeak`
 *    把"带凭据还硬备份"变成执行期闸门（fail-closed）。
 * 2. **迁移计划**（`planMemoryUpgrade` / `applyMemoryUpgrade` / `rollbackMemoryUpgrade`）：
 *    schema 版本升级路径由**已登记的边**解析；**未知 schema 一律拒绝，不猜转换**；
 *    迁移前**必须**保留完整快照（`serializeMemoryBackup`），据此**可回滚**（`reopenMemoryStore`）。
 * 3. **保留期**（`classifyRetention` / `planMemoryRetentionScoped`）：按**范围（用户 / 任务 / 模板）
 *    与时间**给出**删除范围清单**；**执行前可预览**（`previewRetention` 给出将被删的条目 id 列表，
 *    `dry_run` 恒为 `true`）。
 * 4. **删除范围可解释**：每条删除都带"**为什么它属于该范围**"的依据（`reason`）；
 *    **不确定的一律不删**（`uncertain` 列表 + fail-closed 逐条拦截）。
 *
 * ## ⚠️ 如实标注（结果不得编造）
 *
 * - 本模块是**纯计划 / 纯函数层**：不落盘、不起进程、不做真实文件系统 IO。
 * - `KNOWN_MEMORY_BACKUP_SCHEMAS` 目前**只有** `restart.ts` 的 `MEMORY_BACKUP_SCHEMA`
 *   （`potbot-memory-backup.v1`）。因此**跨版本升级在现实中全部被拒**——不是"能跑通"，
 *   而是"没有登记过任何旧版本，宁可不迁移也不猜"。升级链解析逻辑用**显式注入的边**验证，
 *   测试里的合成边**不代表**任何真实历史版本。
 * - `transform_available`：当前**只有同版本 no-op** 可执行；跨版本即便有登记路径，**变换未实现**，
 *   `applyMemoryUpgrade` 一律拒绝（标"未验证"）。
 * - 保留期"不确定"目前覆盖：条目非对象、`updated_at` 非有限数、`scope` 缺失或范围种类未知、
 *   `status` 未知、`kind` 未知。这些都**不删**。
 */

import { ValidationError, type LogicalTime, type TaskId, type TemplateId } from '../protocol/index.js';
import {
  MEMORY_BACKUP_SCHEMA,
  planMemoryMigration,
  planMemoryRetention,
  reopenMemoryStore,
  serializeMemoryBackup,
  type MemoryMigrationPlan,
  type MemoryRetentionPolicy,
  type RestoreReport,
} from './restart.js';
import type { MemoryRepository } from './repository.js';
import {
  MEMORY_KINDS,
  MEMORY_SCOPE_KINDS,
  type MemoryEntry,
  type MemoryId,
  type MemoryKind,
  type MemoryScopeKind,
  type OwnerId,
} from './types.js';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return `${typeof value}(${String(value)})`;
}

function inOwnerScope(ownerId: OwnerId, owners: readonly OwnerId[] | undefined): boolean {
  return owners === undefined || owners.includes(ownerId);
}

// ---------------------------------------------------------------------------
// 1. 凭据扫描（密钥与凭据一律不进备份）
// ---------------------------------------------------------------------------

/** 凭据命中种类：**字段名**像凭据，或**值形态**像密钥。 */
export const CREDENTIAL_FINDING_KINDS = ['sensitive_field', 'secret_value'] as const;
export type CredentialFindingKind = (typeof CREDENTIAL_FINDING_KINDS)[number];

export interface CredentialFinding {
  /** 命中位置（对象路径，如 `preference.value_text`）。 */
  readonly path: string;
  readonly kind: CredentialFindingKind;
  readonly detail: string;
}

/**
 * **凭据字段名**（归一化后含任一 token 即命中）。
 *
 * 归一化：转小写、去掉 `_` `-` `.` 空格，再看 token 是否是子串。
 * 记忆条目的既有字段（`preference_key` / `value_text` / `lesson` …）归一化后**不含**这些 token，
 * 因此不会误伤正常条目。
 */
const SENSITIVE_FIELD_TOKENS: readonly string[] = Object.freeze([
  'apikey',
  'secret',
  'password',
  'passwd',
  'pwd',
  'token',
  'credential',
  'creds',
  'privatekey',
  'accesskey',
  'authorization',
  'bearer',
  'cookie',
  'clientsecret',
  'signingkey',
  'passphrase',
  'pincode',
]);

function isSensitiveFieldName(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_FIELD_TOKENS.some((token) => normalized.includes(token));
}

/**
 * **承载"字段名"的字段**：这些字段的**值**被当作一个字段名看待，
 * 值若像凭据字段（如 `preference_key = 'api_key'`）同样命中。
 */
const KEY_NAME_FIELDS: readonly string[] = Object.freeze(['preference_key', 'fact_key']);

/** **密钥值形态**（在自由文本里也要能揪出来）。 */
const SECRET_VALUE_PATTERNS: readonly { readonly id: string; readonly pattern: RegExp }[] = Object.freeze([
  { id: 'openai_key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { id: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { id: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/ },
  { id: 'pem_private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/ },
  {
    id: 'inline_assignment',
    pattern: /\b(api[_-]?key|apikey|secret|password|passwd|pwd|token|credential)\s*[:=]\s*\S+/i,
  },
]);

/**
 * 扫描**一条记忆**里是否夹带凭据。返回空数组 = 干净（凭据泄漏必须被检出 ⇒ 非空即泄漏）。
 *
 * 只看**字符串值**（自由文本 + 值形态）与**字段名**（字段本身就是凭据字段）。
 */
export function scanEntryForCredentials(entry: MemoryEntry): readonly CredentialFinding[] {
  const findings: CredentialFinding[] = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      for (const { id, pattern } of SECRET_VALUE_PATTERNS) {
        if (pattern.test(value)) {
          findings.push(
            Object.freeze({
              path,
              kind: 'secret_value' as const,
              detail: `${path} 命中密钥形态 ${id}：一律不进备份`,
            }),
          );
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(item, `${path}[${String(index)}]`);
      });
      return;
    }
    if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        const childPath = path.length === 0 ? key : `${path}.${key}`;
        if (isSensitiveFieldName(key)) {
          findings.push(
            Object.freeze({
              path: childPath,
              kind: 'sensitive_field' as const,
              detail: `字段名 ${key} 属凭据字段：一律不进备份`,
            }),
          );
        }
        if (typeof child === 'string' && KEY_NAME_FIELDS.includes(key) && isSensitiveFieldName(child)) {
          findings.push(
            Object.freeze({
              path: childPath,
              kind: 'sensitive_field' as const,
              detail: `字段 ${key} 的取值 ${JSON.stringify(child)} 属凭据字段名：一律不进备份`,
            }),
          );
        }
        walk(child, childPath);
      }
    }
  };
  walk(entry, '');
  return Object.freeze(findings);
}

/** 便捷：这条记忆是否夹带凭据。 */
export function entryHasCredentials(entry: MemoryEntry): boolean {
  return scanEntryForCredentials(entry).length > 0;
}

// ---------------------------------------------------------------------------
// 2. 备份计划
// ---------------------------------------------------------------------------

/** 四类记忆**分型**说明（哪一类、什么范围、进不进备份、为什么）。 */
export interface BackupKindSummary {
  readonly kind: MemoryKind;
  readonly scope: MemoryScopeKind;
  readonly included: boolean;
  /** 范围内该类条目总数。 */
  readonly total: number;
  /** 实际进入备份的条数（剔除凭据后）。 */
  readonly included_count: number;
  /** 因凭据被剔除的条数。 */
  readonly credential_excluded_count: number;
  readonly reason: string;
}

/** 被剔除的条目（**记名**：给出 `memory_id` 与命中依据）。 */
export interface CredentialExclusion {
  readonly memory_id: MemoryId;
  readonly kind: MemoryKind;
  readonly findings: readonly CredentialFinding[];
}

export interface MemoryBackupPlan {
  readonly schema: string;
  readonly at: LogicalTime;
  /** 备份主体范围（空数组 = 全部主体）。 */
  readonly owner_scope: readonly OwnerId[];
  /** 四类分型分别说明。 */
  readonly kinds: readonly BackupKindSummary[];
  /** **含凭据被剔除并记名**的条目。 */
  readonly credential_exclusions: readonly CredentialExclusion[];
  /** 实际进入备份的条目 id（全序，便于比对）。 */
  readonly included_ids: readonly MemoryId[];
  readonly total_entries: number;
  readonly included_count: number;
  readonly credential_leak_detected: boolean;
  readonly summary: string;
}

/** 四类记忆的备份口径（分型说明；四类**都**进备份，凭据在**条目级**剔除）。 */
export const MEMORY_BACKUP_KIND_REASONS: Readonly<Record<MemoryKind, { readonly scope: MemoryScopeKind; readonly reason: string }>> =
  Object.freeze({
    session_message: {
      scope: 'user',
      reason: '会话消息（用户范围）：进备份——用于重启后重建对话上下文',
    },
    task_fact: {
      scope: 'task',
      reason:
        '任务事实（任务范围）：进备份——记忆侧的带来源/版本记载；**不**是产物事实的单一来源（那是 src/facts）',
    },
    preference: {
      scope: 'user',
      reason: '用户长期偏好（用户范围）：进备份——长期有效，任务条件不得自动变来（R235）',
    },
    template_experience: {
      scope: 'template',
      reason: '模板经验（模板范围）：进备份——跨任务复用的模板级经验',
    },
  });

/**
 * 规划一次备份：**哪些数据进备份**（四类分型），以及**哪些条目因凭据被剔除并记名**。
 *
 * 纯读，不改库；不落盘（真正落盘由调用方对返回的 `included_ids` 决定，本层不编造"已备份"）。
 */
export function planMemoryBackup(
  repository: MemoryRepository,
  input: { readonly at: LogicalTime; readonly owners?: readonly OwnerId[] },
): MemoryBackupPlan {
  const exclusions: CredentialExclusion[] = [];
  const includedIds: MemoryId[] = [];
  const summaries: BackupKindSummary[] = [];

  for (const kind of MEMORY_KINDS) {
    const scoped = repository.listByKind(kind).filter((entry) => inOwnerScope(entry.owner_id, input.owners));
    let included = 0;
    let excluded = 0;
    for (const entry of scoped) {
      const findings = scanEntryForCredentials(entry);
      if (findings.length > 0) {
        excluded += 1;
        exclusions.push(
          Object.freeze({ memory_id: entry.memory_id, kind: entry.kind, findings }),
        );
      } else {
        included += 1;
        includedIds.push(entry.memory_id);
      }
    }
    const meta = MEMORY_BACKUP_KIND_REASONS[kind];
    summaries.push(
      Object.freeze({
        kind,
        scope: meta.scope,
        included: true,
        total: scoped.length,
        included_count: included,
        credential_excluded_count: excluded,
        reason: meta.reason,
      }),
    );
  }

  const leak = exclusions.length > 0;
  return Object.freeze({
    schema: MEMORY_BACKUP_SCHEMA,
    at: input.at,
    owner_scope: Object.freeze(input.owners === undefined ? [] : [...input.owners]),
    kinds: Object.freeze(summaries),
    credential_exclusions: Object.freeze(exclusions),
    included_ids: Object.freeze(includedIds),
    total_entries: includedIds.length + exclusions.length,
    included_count: includedIds.length,
    credential_leak_detected: leak,
    summary: leak
      ? `四类分型：共 ${String(includedIds.length)} 条进备份；` +
        `**检出 ${String(exclusions.length)} 条夹带凭据，已剔除并记名**（密钥与凭据一律不进备份）。`
      : `四类分型：共 ${String(includedIds.length)} 条进备份；未检出凭据，无需剔除。`,
  });
}

/** 执行期闸门：计划里还夹带凭据 ⇒ 抛（不编造"备份干净"）。 */
export function assertNoCredentialLeak(plan: MemoryBackupPlan): void {
  if (plan.credential_leak_detected) {
    const named = plan.credential_exclusions.map((item) => String(item.memory_id)).join('、');
    throw new ValidationError(
      `备份计划检出凭据泄漏：${named}（共 ${String(plan.credential_exclusions.length)} 条）。` +
        '密钥与凭据一律不进备份，先剔除再备份。',
    );
  }
}

// ---------------------------------------------------------------------------
// 3. 迁移计划（schema 版本升级路径 + 未知必拒 + 可回滚）
// ---------------------------------------------------------------------------

/** **已登记**的备份 schema 版本。目前只有当前版本——旧版本一律未登记。 */
export const KNOWN_MEMORY_BACKUP_SCHEMAS: readonly string[] = Object.freeze([MEMORY_BACKUP_SCHEMA]);

/** 升级链上的一条**已登记**边（from → to）。 */
export interface MemoryUpgradeStep {
  readonly from: string;
  readonly to: string;
  readonly description: string;
}

/**
 * **默认**升级边集合：**空**。
 *
 * 本项目目前只登记了 `potbot-memory-backup.v1`，没有任何旧版本被登记过，
 * 因此**跨版本升级在现实中全部被拒**（不猜转换）。升级链解析逻辑由
 * `planMemoryUpgrade(..., { edges })` 注入的边驱动；测试里的合成边**不代表**真实历史版本。
 */
export const MEMORY_UPGRADE_EDGES: readonly MemoryUpgradeStep[] = Object.freeze([]);

/** 迁移前**必须**保留快照的要求（可回滚的前提）。 */
export const MIGRATION_ROLLBACK_REQUIREMENT =
  '迁移前必须用 serializeMemoryBackup 保留完整快照；失败或结果不符即可用 reopenMemoryStore 从该快照回滚。';

export interface MemoryUpgradePlan {
  readonly from_schema: string;
  readonly to_schema: string;
  /**
   * 是否存在**已登记**的升级路径（同版本视为「无需迁移」，也算支持）。
   * **默认边集合为空**，因此现实中跨版本一律 `false`。
   */
  readonly supported: boolean;
  /** 可执行变换是否已实现：当前**只有同版本 no-op** 为 `true`。 */
  readonly transform_available: boolean;
  /** 同版本 ⇒ 无需迁移。 */
  readonly no_op: boolean;
  readonly steps: readonly MemoryUpgradeStep[];
  /** 复用 `restart.planMemoryMigration` 的结论（未知 schema 必须拒绝）。 */
  readonly migration: MemoryMigrationPlan;
  readonly rollback_requirement: string;
  readonly detail: string;
}

/** DFS 解析 from → to 的升级链；无路径返回 `null`（**不猜**）。 */
function resolveUpgradeChain(
  from: string,
  to: string,
  edges: readonly MemoryUpgradeStep[],
): readonly MemoryUpgradeStep[] | null {
  if (from === to) return Object.freeze([]);
  const byFrom = new Map<string, MemoryUpgradeStep[]>();
  for (const edge of edges) {
    const list = byFrom.get(edge.from);
    if (list === undefined) byFrom.set(edge.from, [edge]);
    else list.push(edge);
  }
  const visited = new Set<string>([from]);
  const path: MemoryUpgradeStep[] = [];
  const search = (current: string): boolean => {
    for (const edge of byFrom.get(current) ?? []) {
      if (visited.has(edge.to)) continue;
      path.push(edge);
      if (edge.to === to) return true;
      visited.add(edge.to);
      if (search(edge.to)) return true;
      path.pop();
    }
    return false;
  };
  return search(from) ? Object.freeze([...path]) : null;
}

/**
 * 规划 schema 迁移。
 *
 * - 同版本：`supported` 且 `no_op`（无需迁移）；
 * - 未知 schema：**拒绝**（复用 `planMemoryMigration` 的结论，不猜转换；默认边集合为空 ⇒ 无路径）；
 * - 有已登记边但**变换未实现**：`supported` 但 `transform_available: false`（标"未验证"）。
 *
 * ⚠️ `migration` 字段保留 `restart.planMemoryMigration` 的裁决（未知 schema 必拒）；
 * `supported` 只表示"**已登记边**里存在路径"，**不等于**可执行（见 `transform_available`）。
 */
export function planMemoryUpgrade(
  fromSchema: string,
  toSchema: string = MEMORY_BACKUP_SCHEMA,
  options: { readonly edges?: readonly MemoryUpgradeStep[] } = {},
): MemoryUpgradePlan {
  const edges = options.edges ?? MEMORY_UPGRADE_EDGES;
  const migration = planMemoryMigration(fromSchema, toSchema);

  if (fromSchema === toSchema) {
    return Object.freeze({
      from_schema: fromSchema,
      to_schema: toSchema,
      supported: true,
      transform_available: true,
      no_op: true,
      steps: Object.freeze([]),
      migration,
      rollback_requirement: MIGRATION_ROLLBACK_REQUIREMENT,
      detail: `同版本 ${JSON.stringify(fromSchema)}：无需迁移（no-op）。仍建议保留迁移前快照以支持任意点回滚。`,
    });
  }

  const chain = resolveUpgradeChain(fromSchema, toSchema, edges);
  if (chain === null) {
    return Object.freeze({
      from_schema: fromSchema,
      to_schema: toSchema,
      supported: false,
      transform_available: false,
      no_op: false,
      steps: Object.freeze([]),
      migration,
      rollback_requirement: MIGRATION_ROLLBACK_REQUIREMENT,
      detail:
        `拒绝迁移：${migration.detail}；且已登记升级边中**没有** ` +
        `${JSON.stringify(fromSchema)} → ${JSON.stringify(toSchema)} 的路径。`,
    });
  }

  return Object.freeze({
    from_schema: fromSchema,
    to_schema: toSchema,
    supported: true,
    transform_available: false,
    no_op: false,
    steps: chain,
    migration,
    rollback_requirement: MIGRATION_ROLLBACK_REQUIREMENT,
    detail:
      `存在 ${String(chain.length)} 步升级路径，但**变换未实现**（未验证）：` +
      '本层不执行跨版本迁移，只如实报告路径。',
  });
}

/** 回滚句柄：迁移前的完整快照（可回滚的前提）。 */
export interface MigrationRollback {
  readonly from_schema: string;
  readonly to_schema: string;
  readonly at: LogicalTime;
  /** `serializeMemoryBackup` 的产物——迁移前状态。 */
  readonly pre_migration_snapshot: string;
  readonly entry_count: number;
}

export type MemoryUpgradeApplyResult =
  | { readonly kind: 'applied'; readonly plan: MemoryUpgradePlan; readonly rollback: MigrationRollback }
  | { readonly kind: 'rejected'; readonly plan: MemoryUpgradePlan };

/**
 * 执行一次**可回滚**的迁移。
 *
 * 当前**只有同版本 no-op** 可执行（`transform_available: true`）：它**不改变任何条目**，
 * 但**仍然**捕获迁移前快照作为回滚句柄——这样"迁移 → 出问题 → 回滚"这条链路是可实测的。
 * 任何跨版本（即便有登记路径）一律 `rejected`（变换未实现，标"未验证"）。
 */
export function applyMemoryUpgrade(
  repository: MemoryRepository,
  input: {
    readonly from_schema: string;
    readonly to_schema?: string;
    readonly at: LogicalTime;
    readonly edges?: readonly MemoryUpgradeStep[];
  },
): MemoryUpgradeApplyResult {
  const plan = planMemoryUpgrade(
    input.from_schema,
    input.to_schema ?? MEMORY_BACKUP_SCHEMA,
    input.edges === undefined ? {} : { edges: input.edges },
  );
  if (!plan.supported || !plan.transform_available) {
    return Object.freeze({ kind: 'rejected', plan });
  }

  // 迁移前快照（只读复用 restart.serializeMemoryBackup）。
  const snapshot = serializeMemoryBackup(repository, { at: input.at });
  const rollback = Object.freeze({
    from_schema: plan.from_schema,
    to_schema: plan.to_schema,
    at: input.at,
    pre_migration_snapshot: snapshot,
    entry_count: countEntries(repository),
  });
  return Object.freeze({ kind: 'applied', plan, rollback });
}

export type MemoryRollbackResult =
  | { readonly kind: 'rolled_back'; readonly repository: MemoryRepository; readonly report: RestoreReport }
  | { readonly kind: 'failed'; readonly reason: string; readonly detail: string };

/**
 * 从回滚句柄**回滚**：用 `reopenMemoryStore` 从迁移前快照恢复出一个**等价于迁移前**的仓库。
 *
 * ⚠️ 同 `reopenMemoryStore`：**同进程模拟**，不代表已做真实跨进程验证。
 */
export function rollbackMemoryUpgrade(rollback: MigrationRollback): MemoryRollbackResult {
  const reopened = reopenMemoryStore(rollback.pre_migration_snapshot);
  if (reopened.kind === 'failed') {
    return Object.freeze({ kind: 'failed', reason: reopened.reason, detail: reopened.detail });
  }
  return Object.freeze({ kind: 'rolled_back', repository: reopened.repository, report: reopened.report });
}

function countEntries(repository: MemoryRepository): number {
  let total = 0;
  for (const kind of MEMORY_KINDS) total += repository.listByKind(kind).length;
  return total;
}

// ---------------------------------------------------------------------------
// 4. 保留期：按范围与时间的删除范围清单（可预览、可解释、fail-closed）
// ---------------------------------------------------------------------------

/** 保留期**范围过滤**：用户 / 任务 / 模板（可组合；省略 = 不约束）。 */
export interface RetentionScopeFilter {
  readonly scope_kinds?: readonly MemoryScopeKind[];
  readonly owners?: readonly OwnerId[];
  readonly task_ids?: readonly TaskId[];
  readonly template_ids?: readonly TemplateId[];
}

/** 一条**将删 / 保留**候选，带"为什么它属于该范围"的依据。 */
export interface RetentionCandidate {
  readonly memory_id: MemoryId;
  readonly kind: MemoryKind;
  readonly scope: MemoryScopeKind;
  readonly owner_id: OwnerId;
  readonly updated_at: LogicalTime;
  /** `now - updated_at`。 */
  readonly age: number;
  /** **可解释依据**：范围归属 + 状态 + 超期判定。 */
  readonly reason: string;
}

/** 一条**不确定**条目：**一律不删**（fail-closed）。 */
export interface UncertainCandidate {
  readonly memory_id: string;
  readonly kind: string;
  readonly reason: string;
}

export interface RetentionClassification {
  readonly cutoff: LogicalTime;
  readonly to_delete: readonly RetentionCandidate[];
  readonly keep: readonly RetentionCandidate[];
  readonly uncertain: readonly UncertainCandidate[];
  readonly out_of_scope_ids: readonly MemoryId[];
}

/**
 * **不确定**判定（fail-closed 的判据）。返回 `null` = 可判定；否则给出"不确定"的原因。
 *
 * 覆盖：条目非对象 / `updated_at` 非有限数 / `scope` 缺失或范围种类未知 / `status` 未知 / `kind` 未知。
 */
function uncertaintyOf(raw: unknown): string | null {
  if (!isPlainObject(raw)) {
    return `条目不是对象（收到 ${describe(raw)}）：无法判定保留期，不删`;
  }
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(MEMORY_KINDS as readonly string[]).includes(kind)) {
    return `记忆种类未知（${describe(kind)}）：无法归属，不删`;
  }
  const updatedAt = raw.updated_at;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
    return `时间戳不可读（updated_at = ${describe(updatedAt)}）：无法判定是否过期，不删`;
  }
  const scope = raw.scope;
  if (!isPlainObject(scope)) {
    return `范围缺失（scope = ${describe(scope)}）：无法归属用户/任务/模板，不删`;
  }
  const scopeKind = scope.kind;
  if (typeof scopeKind !== 'string' || !(MEMORY_SCOPE_KINDS as readonly string[]).includes(scopeKind)) {
    return `范围种类未知（${describe(scopeKind)}）：无法归属用户/任务/模板，不删`;
  }
  const status = raw.status;
  if (status !== 'active' && status !== 'disabled' && status !== 'deleted') {
    return `状态未知（${describe(status)}）：按 fail-closed 不删`;
  }
  return null;
}

function assertRetentionPolicy(policy: MemoryRetentionPolicy): void {
  if (!Number.isFinite(policy.max_age) || policy.max_age < 0) {
    throw new ValidationError('保留期 max_age 必须是 ≥ 0 的有限数（逻辑时间跨度）');
  }
}

function matchesScope(entry: MemoryEntry, filter: RetentionScopeFilter): boolean {
  if (filter.scope_kinds !== undefined && !filter.scope_kinds.includes(entry.scope.kind)) return false;
  if (filter.owners !== undefined && !filter.owners.includes(entry.owner_id)) return false;
  if (filter.task_ids !== undefined) {
    const taskId = entry.scope.task_id;
    if (taskId === null || !filter.task_ids.includes(taskId)) return false;
  }
  if (filter.template_ids !== undefined) {
    const templateId = entry.scope.template_id;
    if (templateId === null || !filter.template_ids.includes(templateId)) return false;
  }
  return true;
}

function isExpiredStatus(status: string, now: number, updatedAt: number, policy: MemoryRetentionPolicy): boolean {
  if (now - updatedAt <= policy.max_age) return false; // 保留期内
  switch (status) {
    case 'active':
      return true;
    case 'disabled':
      return !policy.retain_disabled;
    case 'deleted':
      return !policy.retain_deleted_audit;
    default:
      return false; // 未知状态：不删（fail-closed）
  }
}

/**
 * 对**任意条目集合**做保留期分类（纯函数；条目可来自仓库或**备份封套**，故允许畸形输入）。
 *
 * 顺序：**先判不确定 ⇒ 一律不删**；再判范围（不在范围内 → `out_of_scope`）；再判过期。
 */
export function classifyRetention(
  entries: readonly MemoryEntry[],
  input: {
    readonly policy: MemoryRetentionPolicy;
    readonly now: LogicalTime;
    readonly filter?: RetentionScopeFilter;
  },
): RetentionClassification {
  assertRetentionPolicy(input.policy);
  const filter = input.filter ?? {};
  const now = input.now as number;
  const cutoff = (now - input.policy.max_age) as LogicalTime;

  const toDelete: RetentionCandidate[] = [];
  const keep: RetentionCandidate[] = [];
  const uncertain: UncertainCandidate[] = [];
  const outOfScope: MemoryId[] = [];

  for (const raw of entries) {
    const uncertainReason = uncertaintyOf(raw);
    if (uncertainReason !== null) {
      const record = raw as unknown as { readonly memory_id?: unknown; readonly kind?: unknown };
      uncertain.push(
        Object.freeze({
          memory_id: typeof record.memory_id === 'string' ? record.memory_id : '<未知 id>',
          kind: typeof record.kind === 'string' ? record.kind : '<未知种类>',
          reason: uncertainReason,
        }),
      );
      continue; // fail-closed：不确定一律不删
    }

    const entry = raw as MemoryEntry;
    if (!matchesScope(entry, filter)) {
      outOfScope.push(entry.memory_id);
      continue;
    }

    const age = now - (entry.updated_at as number);
    const scopeLine =
      `范围 ${entry.scope.kind}（owner=${entry.owner_id}` +
      `${entry.scope.task_id === null ? '' : `, task=${entry.scope.task_id}`}` +
      `${entry.scope.template_id === null ? '' : `, template=${entry.scope.template_id}`}）`;
    const overLine =
      age > input.policy.max_age
        ? `超期（年龄 ${String(age)} > 保留期 ${String(input.policy.max_age)}）`
        : `在保留期内（年龄 ${String(age)} ≤ 保留期 ${String(input.policy.max_age)}）`;
    const candidate = Object.freeze({
      memory_id: entry.memory_id,
      kind: entry.kind,
      scope: entry.scope.kind,
      owner_id: entry.owner_id,
      updated_at: entry.updated_at,
      age,
      reason: `${scopeLine}；状态 ${entry.status}；${overLine}`,
    });

    if (isExpiredStatus(entry.status, now, entry.updated_at as number, input.policy)) {
      toDelete.push(candidate);
    } else {
      keep.push(candidate);
    }
  }

  return Object.freeze({
    cutoff,
    to_delete: Object.freeze(toDelete),
    keep: Object.freeze(keep),
    uncertain: Object.freeze(uncertain),
    out_of_scope_ids: Object.freeze(outOfScope),
  });
}

export interface ScopedRetentionPlan {
  readonly policy: MemoryRetentionPolicy;
  readonly now: LogicalTime;
  readonly filter: RetentionScopeFilter;
  readonly cutoff: LogicalTime;
  /** **恒为 `true`**：本计划是 dry-run 预览，不执行删除。 */
  readonly dry_run: true;
  readonly to_delete: readonly RetentionCandidate[];
  readonly keep: readonly RetentionCandidate[];
  readonly uncertain: readonly UncertainCandidate[];
  readonly out_of_scope_ids: readonly MemoryId[];
  /** 共享实现（`restart.planMemoryRetention`）判为过期、但本层判为不确定/保留的 id（fail-closed 覆盖）。 */
  readonly fail_closed_overrides: readonly MemoryId[];
  readonly deletion_scope_explanation: string;
}

/**
 * 按**范围（用户 / 任务 / 模板）与时间**规划保留期删除清单。
 *
 * 交叉核对：调用 `restart.planMemoryRetention` 取共享实现的过期集；凡是共享实现说要删、
 * 而本层判定**不确定**的 id，记入 `fail_closed_overrides` 并**不删**（fail-closed 优先）。
 */
export function planMemoryRetentionScoped(
  repository: MemoryRepository,
  input: {
    readonly policy: MemoryRetentionPolicy;
    readonly now: LogicalTime;
    readonly filter?: RetentionScopeFilter;
  },
): ScopedRetentionPlan {
  const filter = input.filter ?? {};
  const entries: MemoryEntry[] = [];
  for (const kind of MEMORY_KINDS) entries.push(...repository.listByKind(kind));

  const classification = classifyRetention(entries, { policy: input.policy, now: input.now, filter });

  // 只读复用共享实现，作为交叉核对 / fail-closed 覆盖判据。
  const shared = planMemoryRetention(repository, {
    policy: input.policy,
    now: input.now,
    owners: filter.owners,
  });
  const sharedExpired = new Set<string>(shared.expired_ids.map(String));
  const safeIds = new Set<string>(classification.to_delete.map((item) => String(item.memory_id)));
  const overrides: MemoryId[] = [];
  for (const id of shared.expired_ids) {
    if (!safeIds.has(String(id))) overrides.push(id);
  }

  const scopeLine =
    filter.scope_kinds === undefined ? '全部范围' : `范围 ${filter.scope_kinds.join(' / ')}`;
  return Object.freeze({
    policy: input.policy,
    now: input.now,
    filter,
    cutoff: classification.cutoff,
    dry_run: true,
    to_delete: classification.to_delete,
    keep: classification.keep,
    uncertain: classification.uncertain,
    out_of_scope_ids: classification.out_of_scope_ids,
    fail_closed_overrides: Object.freeze(overrides),
    deletion_scope_explanation:
      `保留期 ${String(input.policy.max_age)} 逻辑时间单位，截止 ${String(classification.cutoff)}；` +
      `范围过滤：${scopeLine}。拟删 ${String(classification.to_delete.length)} 条、` +
      `保留 ${String(classification.keep.length)} 条、**不确定 ${String(classification.uncertain.length)} 条（一律不删）**、` +
      `范围外 ${String(classification.out_of_scope_ids.length)} 条（不处理）。` +
      (overrides.length === 0 ? '' : ` ⚠️ 共享实现判过期但本层 fail-closed 覆盖 ${String(overrides.length)} 条。`),
  });
}

/** dry-run 预览：**执行前**给出将被删的条目 id 列表。 */
export interface RetentionPreview {
  readonly dry_run: true;
  readonly will_delete_ids: readonly MemoryId[];
  readonly will_keep_count: number;
  readonly uncertain_count: number;
  readonly out_of_scope_count: number;
  readonly detail: string;
}

export function previewRetention(plan: ScopedRetentionPlan): RetentionPreview {
  const ids = plan.to_delete.map((item) => item.memory_id);
  return Object.freeze({
    dry_run: true,
    will_delete_ids: Object.freeze(ids),
    will_keep_count: plan.keep.length,
    uncertain_count: plan.uncertain.length,
    out_of_scope_count: plan.out_of_scope_ids.length,
    detail:
      `dry-run：将删 ${String(ids.length)} 条${ids.length === 0 ? '' : `（${ids.map(String).join('、')}）`}；` +
      `保留 ${String(plan.keep.length)} 条；不确定 ${String(plan.uncertain.length)} 条**不删**。` +
      '预览与执行均不改库——确认后才走 applyRetentionPlan。',
  });
}

export interface RetentionApplyOutcome {
  readonly deleted: readonly MemoryId[];
  readonly failed: readonly { readonly memory_id: MemoryId; readonly detail: string }[];
  /** 预览里有、执行时已不再过期（期间被改动）而**跳过**的 id（如实报告，不硬删）。 */
  readonly drift: readonly MemoryId[];
  readonly uncertain_untouched: readonly string[];
  /** 执行前重跑分类、逐条核实；重算集与预览一致才为 `true`。 */
  readonly preview_matched: boolean;
  readonly ok: boolean;
}

/**
 * 执行保留期删除（**执行前重算一次**，只删重算后仍判定为过期的条目；fail-closed）。
 *
 * - 先在**当前**仓库状态上重跑 `planMemoryRetentionScoped`；
 * - 只删重算集里的 id（预览与执行有差异则记入 `drift`）；
 * - `uncertain` 里的 id **绝不**出现在删除集（结构上不可能）。
 */
export function applyRetentionPlan(
  repository: MemoryRepository,
  plan: ScopedRetentionPlan,
): RetentionApplyOutcome {
  const fresh = planMemoryRetentionScoped(repository, {
    policy: plan.policy,
    now: plan.now,
    filter: plan.filter,
  });
  const previewIds = plan.to_delete.map((item) => String(item.memory_id));
  const freshIds = new Set<string>(fresh.to_delete.map((item) => String(item.memory_id)));
  const drift = previewIds.filter((id) => !freshIds.has(id)) as MemoryId[];

  const deleted: MemoryId[] = [];
  const failed: { memory_id: MemoryId; detail: string }[] = [];
  for (const candidate of fresh.to_delete) {
    const entry = repository.get(candidate.memory_id);
    if (entry === undefined) {
      failed.push({ memory_id: candidate.memory_id, detail: '执行时条目已不存在（并发删除？）' });
      continue;
    }
    const result = repository.forget(candidate.memory_id, entry.owner_id);
    if (result.forgotten.length === 0) {
      failed.push({ memory_id: candidate.memory_id, detail: '忘记未生效（属主不匹配或条目不存在）' });
      continue;
    }
    deleted.push(...result.forgotten);
  }

  return Object.freeze({
    deleted: Object.freeze(deleted),
    failed: Object.freeze(failed),
    drift: Object.freeze(drift),
    uncertain_untouched: Object.freeze(fresh.uncertain.map((item) => item.memory_id)),
    preview_matched: drift.length === 0,
    ok: failed.length === 0,
  });
}

/**
 * K06 模板 manifest 生命周期 —— **安装 / 启用 / 停用 / 授权 / 端口就绪四态 + 升级回滚卸载**（零依赖）。
 *
 * ## 三条纪律（本文件的全部价值所在）
 *
 * 1. **四态分别报告，禁止合并**：`reportReadiness()` 返回 `installed / enabled /
 *    authorized / portReady` 四份独立 `StateReport`，每份都带 `ready|not-ready` 与
 *    （未就绪时**必须**有的）原因。产物再过一道 `assertSeparateReadinessStates()`，
 *    任何形如 `{ready: true}` 的合并都会抛 `merged_readiness_forbidden`。
 *
 * 2. **状态来自探针，不来自 manifest 自称**：manifest 的 `probe.*` 四个布尔是模板**声明**，
 *    本模块**一次都不读**它们来判就绪。四条读回路径各走 `TemplateProbePort` 的对应探针；
 *    探针报 `ok:false` ⇒ 该态 `not-ready`，理由取探针给的 `reason`（缺失则用兜底原因，
 *    绝不美化成就绪）。
 *
 * 3. **版本冻结，不静默替换**：任务开始前 `pin(taskId, id)` 把当时在用的版本钉住；
 *    之后 `upgrade()` 只切换**新任务**的在用版本，被钉住的旧版本转入 `frozen` 保留，
 *    `resolve(taskId)` 仍返回**旧版本**。`uninstall()` 对还有在途任务钉着的版本
 *    **只撤权与停用、不移除**（`retainedForPinnedTasks: true`），在途任务照样取得到。
 *    重装同版本（`install()` 命中已卸载但被在途任务保留的记录）**复活既有记录并保留 pin 记账**，
 *    不得重建丢账；未指定版本的新 `pin()` 在**没有在用版本**时必须拒绝，不回退旧版本
 *    （K-R05 D1/D2 / I2、I5）。
 *
 * ## 与契约的关系
 *
 * 形状校验与兼容判定在 `manifest.ts`；本文件只做状态机与探针装配。真实设备上探针是
 * 异步的（查包管理器 / 端口 / 权限），因此 `reportReadiness()` 是 `Promise`。
 * **本包未连接任何真机**：全部结论来自夹具探针，真机层未验证。
 */

import { TemplateError } from './errors.js';
import { assertManifest, assertRuntimeCompatible, assertSeparateReadinessStates, checkRuntimeCompatibility } from './manifest.js';
import {
  type Clock,
  type HostPlatform,
  type InstalledTemplate,
  type ProbeOutcome,
  type ProbeRequest,
  type ReadinessReport,
  type StateReport,
  type TemplateManifest,
  type TemplatePermission,
  type TemplateProbePort,
  type UninstallReport,
} from './types.js';

// ---------------------------------------------------------------------------
// 依赖与内部记录
// ---------------------------------------------------------------------------

export interface TemplateLifecycleDeps {
  readonly clock: Clock;
  readonly host: HostPlatform;
  readonly probe: TemplateProbePort;
  /** 可选：观察每次状态迁移（审计 / 证据用）。 */
  readonly onTransition?: (event: TemplateTransitionEvent) => void;
}

export interface TemplateTransitionEvent {
  readonly kind:
    | 'installed'
    | 'enabled'
    | 'disabled'
    | 'authorized'
    | 'upgraded'
    | 'rolled-back'
    | 'uninstalled'
    | 'pinned'
    | 'released';
  readonly id: string;
  readonly version: string;
  readonly at: number;
  readonly detail: string;
}

/** 内部可变记录（对外只暴露 `InstalledTemplate` 不可变快照）。 */
interface MutableRecord {
  id: string;
  version: string;
  manifest: TemplateManifest;
  installedAt: number;
  enabled: boolean;
  uninstalled: boolean;
  frozen: boolean;
  grantedPermissions: TemplatePermission[];
  pinnedBy: string[];
}

interface AdoptionOptions {
  /** 该安装是否是"升级"（必须给出与当前在用版本对得上的迁移声明）。 */
  readonly requireMigration: boolean;
  /** `strategy: 'manual'` 时是否已获调用方显式确认。 */
  readonly manualConfirmed?: boolean;
}

export interface UpgradeOptions {
  /** `migration.strategy === 'manual'` 时必须为 true，否则拒绝（`migration_manual_confirmation_required`）。 */
  readonly manualConfirmed?: boolean;
}

export interface TemplateLifecycle {
  install(manifest: unknown): InstalledTemplate;
  upgrade(id: string, nextManifest: unknown, options?: UpgradeOptions): InstalledTemplate;
  rollback(id: string): InstalledTemplate;
  enable(id: string, version?: string): InstalledTemplate;
  /**
   * 停用（R230：**阻止新实例**；在途任务的既有钉住不受影响）。
   *
   * 与 `enable` 对称：对已停用版本重复调用是幂等的（不抛错）；对已卸载版本抛
   * `version_not_installed`。停用后 `reportReadiness().enabled` 报 `not-ready(disabled)`。
   * 本模块**不**在 `pin()` 处拦截停用版本——"停用阻止新实例"由消费方读就绪报告执行
   * （与 `src/plugins/registry.ts` 的 `disable` 同口径：仅改状态，不既成事实地回滚在途绑定）。
   */
  disable(id: string, version?: string): InstalledTemplate;
  authorize(id: string, version: string | undefined, granted: readonly TemplatePermission[]): InstalledTemplate;
  uninstall(id: string, version?: string): UninstallReport;
  reportReadiness(id: string, version?: string): Promise<ReadinessReport>;
  /** 任务开始：把当时在用（或指定）版本钉住，返回冻结快照。 */
  pin(taskId: string, id: string, version?: string): InstalledTemplate;
  /** 任务在途：按任务取回它被钉住的版本（**升级/卸载后仍是旧版本**）。 */
  resolve(taskId: string): InstalledTemplate;
  release(taskId: string): void;
  get(id: string, version?: string): InstalledTemplate | null;
  list(id?: string): readonly InstalledTemplate[];
  activeVersionOf(id: string): string | null;
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

export function createTemplateLifecycle(deps: TemplateLifecycleDeps): TemplateLifecycle {
  const { clock, host, probe, onTransition } = deps;

  /** id -> version -> 记录。 */
  const versions = new Map<string, Map<string, MutableRecord>>();
  /** id -> 当前在用版本。 */
  const active = new Map<string, string>();
  /** id -> 采用顺序（升级/回滚历史，供回滚找到"上一个版本"）。 */
  const history = new Map<string, string[]>();
  /** taskId -> 被钉住的版本。 */
  const pins = new Map<string, { readonly id: string; readonly version: string }>();

  function mapOf(id: string): Map<string, MutableRecord> {
    let existing = versions.get(id);
    if (existing === undefined) {
      existing = new Map<string, MutableRecord>();
      versions.set(id, existing);
    }
    return existing;
  }

  function notify(event: TemplateTransitionEvent): void {
    onTransition?.(event);
  }

  function toSnapshot(record: MutableRecord): InstalledTemplate {
    return Object.freeze({
      id: record.id,
      version: record.version,
      manifest: record.manifest,
      installedAt: record.installedAt,
      active: active.get(record.id) === record.version,
      frozen: record.frozen,
      uninstalled: record.uninstalled,
      enabled: record.enabled,
      grantedPermissions: Object.freeze([...record.grantedPermissions]),
      pinnedBy: Object.freeze([...record.pinnedBy]),
    });
  }

  /**
   * 解析"要操作哪个版本"：显式版本优先；否则用在用版本；若在用版本已被卸载清空、
   * 但该 id 只剩**唯一一个**保留版本（被在途任务冻结持有的那个），就用它——
   * 这样卸载后仍能对这一版本报 `installed: not-ready(uninstalled)`。
   * 剩多个版本时不猜（返回 undefined，走"没有在用版本"的拒绝）。
   */
  function resolveTargetVersion(id: string, version?: string): string | undefined {
    if (version !== undefined) {
      return version;
    }
    const activeVersion = active.get(id);
    if (activeVersion !== undefined) {
      return activeVersion;
    }
    const table = versions.get(id);
    if (table !== undefined && table.size === 1) {
      return table.keys().next().value;
    }
    return undefined;
  }

  function requireRecord(id: string, version: string | undefined): MutableRecord {
    const target = resolveTargetVersion(id, version);
    if (target === undefined) {
      throw new TemplateError('template_not_installed', `模板 ${id} 没有任何在用版本（version 未给出）`);
    }
    const record = versions.get(id)?.get(target);
    if (record === undefined) {
      throw new TemplateError('version_not_installed', `模板 ${id} 的版本 ${target} 不存在`, null);
    }
    return record;
  }

  /** 采用（安装 / 升级共用的唯一写入口）。 */
  function adopt(manifest: unknown, options: AdoptionOptions): InstalledTemplate {
    const validated = assertManifest(manifest);
    assertRuntimeCompatible(validated.runtimeCompatibility, host);

    const id = validated.id;
    const version = validated.version;
    const table = mapOf(id);
    const previousActive = active.get(id);

    const existing = table.get(version);
    if (existing !== undefined && !existing.uninstalled) {
      throw new TemplateError(
        'template_already_installed',
        `模板 ${id}@${version} 已安装且未卸载：版本是身份的一部分，不得重复安装或静默覆盖`,
      );
    }
    // 走到这里：`existing` 要么不存在，要么是**已卸载但被在途任务保留**的记录
    // （`uninstalled && pinnedBy.length > 0`）。重装同一版本必须**复活既有记录并原样保留
    // `pinnedBy`**：版本是身份的一部分；另建一条 `pinnedBy: []` 的新记录会悄悄丢掉在途任务的
    // pin 记账，随后 `uninstall()` 会因"无人钉住"判定而把在途任务手里的版本移除
    // （K-R05 D1 / 不变量 I2：被保留版本的 pin 记账不得丢失）。

    if (options.requireMigration) {
      if (previousActive === undefined) {
        throw new TemplateError(
          'template_not_installed',
          `模板 ${id} 没有任何在用版本，无法作为"升级"处理（请先 install）`,
        );
      }
      if (validated.migration.from !== previousActive) {
        throw new TemplateError(
          'migration_chain_mismatch',
          `migration.from=${JSON.stringify(validated.migration.from)} 与当前在用版本 ${previousActive} 不符`,
          'migration.from',
        );
      }
      if (validated.migration.to !== version) {
        throw new TemplateError(
          'migration_chain_mismatch',
          `migration.to=${JSON.stringify(validated.migration.to)} 与目标版本 ${version} 不符`,
          'migration.to',
        );
      }
      if (validated.migration.strategy === 'manual' && options.manualConfirmed !== true) {
        throw new TemplateError(
          'migration_manual_confirmation_required',
          `模板 ${id}@${version} 的迁移策略是 manual，需调用方显式确认后方可升级`,
        );
      }
      // 旧版本转冻结保留：**不静默替换**在途任务手里的版本。
      const prevRecord = table.get(previousActive);
      if (prevRecord !== undefined) {
        prevRecord.frozen = true;
      }
    }

    const now = clock.now();
    let record: MutableRecord;
    if (existing !== undefined) {
      // 复活被保留的已卸载版本：只重置"安装态"，`pinnedBy` 原样保留（在途任务记账不丢）。
      existing.manifest = validated;
      existing.installedAt = now;
      existing.enabled = false;
      existing.uninstalled = false;
      existing.frozen = false;
      existing.grantedPermissions = [];
      record = existing;
    } else {
      record = {
        id,
        version,
        manifest: validated,
        installedAt: now,
        enabled: false,
        uninstalled: false,
        frozen: false,
        grantedPermissions: [],
        pinnedBy: [],
      };
      table.set(version, record);
    }
    active.set(id, version);

    const stack = history.get(id) ?? [];
    if (stack[stack.length - 1] !== version) {
      stack.push(version);
    }
    history.set(id, stack);

    notify({
      kind: options.requireMigration ? 'upgraded' : 'installed',
      id,
      version,
      at: now,
      detail: options.requireMigration
        ? `升级：${String(previousActive)} → ${version}（旧版本冻结保留）`
        : `安装 ${id}@${version}`,
    });
    return toSnapshot(record);
  }

  // -------------------------------------------------------------------------
  // 探针 → 状态报告
  // -------------------------------------------------------------------------

  function combine(facts: readonly (string | null)[], outcome: ProbeOutcome, now: number): StateReport {
    const reasons = facts.filter((fact): fact is string => fact !== null);
    if (!outcome.ok) {
      // 探针失败 = 未就绪。原因取探针给的；探针没给就如实兜底，绝不美化成就绪。
      reasons.push(outcome.reason ?? 'probe_reported_failure');
    }
    if (reasons.length === 0) {
      return Object.freeze({
        state: 'ready' as const,
        reason: null,
        evidenceRef: outcome.evidenceRef ?? null,
        checkedAt: now,
      });
    }
    return Object.freeze({
      state: 'not-ready' as const,
      reason: reasons.join('; '),
      evidenceRef: outcome.evidenceRef ?? null,
      checkedAt: now,
    });
  }

  function probeRequest(record: MutableRecord): ProbeRequest {
    return Object.freeze({
      id: record.id,
      version: record.version,
      capabilities: record.manifest.capabilities,
      permissions: record.manifest.permissions,
    });
  }

  async function reportReadiness(id: string, version?: string): Promise<ReadinessReport> {
    const record = requireRecord(id, version);
    const now = clock.now();
    const request = probeRequest(record);

    const [installedOutcome, enabledOutcome, authorizedOutcome, portOutcome] = await Promise.all([
      probe.probeInstalled(request),
      probe.probeEnabled(request),
      probe.probeAuthorized(request),
      probe.probePorts(request),
    ]);

    const uninstalledFact = record.uninstalled ? 'uninstalled' : null;

    // installed
    const installedFacts: (string | null)[] = [uninstalledFact];

    // enabled
    const enabledFacts: (string | null)[] = [uninstalledFact, record.enabled ? null : 'disabled'];

    // authorized：manifest 声明的权限必须**全部**落在已授予集合里
    const missingPermissions = record.manifest.permissions.filter(
      (permission) => !record.grantedPermissions.includes(permission),
    );
    const authorizedFacts: (string | null)[] = [
      uninstalledFact,
      missingPermissions.length === 0
        ? null
        : `permission_not_granted:${missingPermissions.join(',')}`,
    ];

    // portReady：宿主能力必须覆盖 manifest 声明的能力；且运行时兼容（宿主可能变化）
    const missingCapabilities = record.manifest.capabilities.filter(
      (capability) => !host.capabilities.includes(capability),
    );
    const compatIssues = checkRuntimeCompatibility(record.manifest.runtimeCompatibility, host);
    const portFacts: (string | null)[] = [
      uninstalledFact,
      missingCapabilities.length === 0
        ? null
        : `capability_unavailable:${missingCapabilities.join(',')}`,
      compatIssues.length === 0
        ? null
        : `runtime_incompatible:${compatIssues.map((issue) => issue.field).join(',')}`,
    ];

    const report: ReadinessReport = Object.freeze({
      id: record.id,
      version: record.version,
      installed: combine(installedFacts, installedOutcome, now),
      enabled: combine(enabledFacts, enabledOutcome, now),
      authorized: combine(authorizedFacts, authorizedOutcome, now),
      portReady: combine(portFacts, portOutcome, now),
    });

    // 形状不变量：四态分别报告，任何合并尝试在此抛错。
    assertSeparateReadinessStates(report);
    return report;
  }

  // -------------------------------------------------------------------------
  // 对外 API
  // -------------------------------------------------------------------------

  return {
    install(manifest: unknown): InstalledTemplate {
      return adopt(manifest, { requireMigration: false });
    },

    upgrade(id: string, nextManifest: unknown, options: UpgradeOptions = {}): InstalledTemplate {
      return adopt(nextManifest, {
        requireMigration: true,
        manualConfirmed: options.manualConfirmed === true,
      });
    },

    rollback(id: string): InstalledTemplate {
      const currentVersion = active.get(id);
      if (currentVersion === undefined) {
        throw new TemplateError('template_not_installed', `模板 ${id} 没有任何在用版本，无从回滚`);
      }
      const current = versions.get(id)?.get(currentVersion);
      if (current === undefined) {
        throw new TemplateError('version_not_installed', `模板 ${id} 的在用版本 ${currentVersion} 记录缺失`);
      }
      if (current.manifest.migration.reversible !== true) {
        throw new TemplateError(
          'migration_not_reversible',
          `模板 ${id}@${currentVersion} 的迁移声明 reversible=false：不得回滚`,
        );
      }
      const stack = history.get(id) ?? [];
      // 从后往前找最近一个仍然存在且未卸载的、且不等于当前版本的记录
      let targetVersion: string | null = null;
      for (let index = stack.length - 2; index >= 0; index -= 1) {
        const candidate = stack[index];
        if (candidate === undefined || candidate === currentVersion) {
          continue;
        }
        const candidateRecord = versions.get(id)?.get(candidate);
        if (candidateRecord !== undefined && !candidateRecord.uninstalled) {
          targetVersion = candidate;
          break;
        }
      }
      if (targetVersion === null) {
        throw new TemplateError(
          'version_not_installed',
          `模板 ${id} 没有可回滚的历史版本（历史：${stack.join(' → ')}）`,
        );
      }
      current.frozen = true;
      const target = versions.get(id)?.get(targetVersion);
      if (target === undefined) {
        throw new TemplateError('version_not_installed', `回滚目标 ${id}@${targetVersion} 记录缺失`);
      }
      target.frozen = false;
      active.set(id, targetVersion);
      notify({
        kind: 'rolled-back',
        id,
        version: targetVersion,
        at: clock.now(),
        detail: `回滚：${currentVersion} → ${targetVersion}`,
      });
      return toSnapshot(target);
    },

    enable(id: string, version?: string): InstalledTemplate {
      const record = requireRecord(id, version);
      if (record.uninstalled) {
        throw new TemplateError('version_not_installed', `模板 ${id}@${record.version} 已卸载，不得启用`);
      }
      record.enabled = true;
      notify({ kind: 'enabled', id, version: record.version, at: clock.now(), detail: '启用' });
      return toSnapshot(record);
    },

    disable(id: string, version?: string): InstalledTemplate {
      const record = requireRecord(id, version);
      if (record.uninstalled) {
        throw new TemplateError('version_not_installed', `模板 ${id}@${record.version} 已卸载，不得停用`);
      }
      // 与 enable 对称：重复停用是幂等的；仅对"已卸载"抛错（与 K-R05 既有用例一致）。
      record.enabled = false;
      notify({ kind: 'disabled', id, version: record.version, at: clock.now(), detail: '停用' });
      return toSnapshot(record);
    },

    authorize(id: string, version: string | undefined, granted: readonly TemplatePermission[]): InstalledTemplate {
      const record = requireRecord(id, version);
      if (record.uninstalled) {
        throw new TemplateError('version_not_installed', `模板 ${id}@${record.version} 已卸载，不得授权`);
      }
      const declared = record.manifest.permissions;
      const undeclared = granted.filter((permission) => !declared.includes(permission));
      if (undeclared.length > 0) {
        throw new TemplateError(
          'permission_not_declared',
          `请求授予的权限 ${undeclared.join(',')} 未在 manifest 中声明（不得凭空扩权）`,
          'permissions',
        );
      }
      record.grantedPermissions = [...new Set(granted)];
      notify({
        kind: 'authorized',
        id,
        version: record.version,
        at: clock.now(),
        detail: `授予权限 [${record.grantedPermissions.join(',')}]`,
      });
      return toSnapshot(record);
    },

    uninstall(id: string, version?: string): UninstallReport {
      const record = requireRecord(id, version);
      const revoked = [...record.grantedPermissions];
      const wasActive = active.get(id) === record.version;

      record.uninstalled = true;
      record.enabled = false;
      record.grantedPermissions = [];

      if (wasActive) {
        active.delete(id);
      }

      // 仍被在途任务钉着 ⇒ **保留**（撤权与停用，但不移除），冻结版本照样可取回。
      const retained = record.pinnedBy.length > 0;
      if (retained) {
        record.frozen = true;
      } else {
        versions.get(id)?.delete(record.version);
        const stack = history.get(id);
        if (stack !== undefined) {
          history.set(
            id,
            stack.filter((entry) => entry !== record.version),
          );
        }
      }

      notify({
        kind: 'uninstalled',
        id,
        version: record.version,
        at: clock.now(),
        detail: retained ? '卸载（因在途任务保留冻结版本）' : '卸载并移除',
      });

      return Object.freeze({
        id,
        version: record.version,
        revokedPermissions: Object.freeze(revoked),
        wasActive,
        retainedForPinnedTasks: retained,
        removed: !retained,
      });
    },

    reportReadiness,

    pin(taskId: string, id: string, version?: string): InstalledTemplate {
      const existingPin = pins.get(taskId);
      if (existingPin !== undefined) {
        // 一个任务只钉一个版本；重复钉必须显式 release，避免静默改钉。
        throw new TemplateError(
          'task_already_pinned',
          `任务 ${taskId} 已钉住 ${existingPin.id}@${existingPin.version}，请先 release 再改钉（不得静默换版本）`,
        );
      }
      const record = requireRecord(id, version);
      if (record.uninstalled) {
        throw new TemplateError(
          'version_not_installed',
          `模板 ${id}@${record.version} 已卸载，不得为新任务钉住（已钉住的在途任务仍可取回）`,
        );
      }
      // 未显式指定版本 ⇒ 只能绑**当前在用版本**。若没有任何在用版本（在用版本已被卸载），
      // 不得静默回退到唯一剩余的旧/已被取代版本（K-R05 D2 / 不变量 I5）。
      // 注意：放在"已卸载"检查之后，故"版本已卸载"仍按既有口径抛 `version_not_installed`。
      if (version === undefined && active.get(id) === undefined) {
        throw new TemplateError(
          'template_not_installed',
          `模板 ${id} 没有在用版本（version 未给出）：未指定版本的 pin 不得回退到已被取代的旧版本`,
        );
      }
      if (!record.pinnedBy.includes(taskId)) {
        record.pinnedBy.push(taskId);
      }
      pins.set(taskId, { id, version: record.version });
      notify({ kind: 'pinned', id, version: record.version, at: clock.now(), detail: `任务 ${taskId} 钉住` });
      return toSnapshot(record);
    },

    resolve(taskId: string): InstalledTemplate {
      const pin = pins.get(taskId);
      if (pin === undefined) {
        throw new TemplateError('pin_not_found', `任务 ${taskId} 没有冻结任何模板版本`);
      }
      const record = versions.get(pin.id)?.get(pin.version);
      if (record === undefined) {
        // 只有"被钉住"的版本才会保留；走到这里说明记录被非法移除了。
        throw new TemplateError(
          'version_not_installed',
          `任务 ${taskId} 钉住的 ${pin.id}@${pin.version} 记录缺失（冻结版本不得被移除）`,
        );
      }
      return toSnapshot(record);
    },

    release(taskId: string): void {
      const pin = pins.get(taskId);
      if (pin === undefined) {
        return;
      }
      pins.delete(taskId);
      const record = versions.get(pin.id)?.get(pin.version);
      if (record === undefined) {
        return;
      }
      record.pinnedBy = record.pinnedBy.filter((entry) => entry !== taskId);
      notify({
        kind: 'released',
        id: pin.id,
        version: pin.version,
        at: clock.now(),
        detail: `任务 ${taskId} 释放`,
      });
      // 已卸载且无人再钉 ⇒ 真正移除
      if (record.uninstalled && record.pinnedBy.length === 0) {
        versions.get(pin.id)?.delete(pin.version);
      }
    },

    get(id: string, version?: string): InstalledTemplate | null {
      const target = resolveTargetVersion(id, version);
      if (target === undefined) {
        return null;
      }
      const record = versions.get(id)?.get(target);
      return record === undefined ? null : toSnapshot(record);
    },

    list(id?: string): readonly InstalledTemplate[] {
      const out: InstalledTemplate[] = [];
      for (const [key, table] of versions.entries()) {
        if (id !== undefined && key !== id) {
          continue;
        }
        for (const record of table.values()) {
          out.push(toSnapshot(record));
        }
      }
      return Object.freeze(out);
    },

    activeVersionOf(id: string): string | null {
      return active.get(id) ?? null;
    },
  };
}

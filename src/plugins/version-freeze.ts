/**
 * 版本冻结：**活跃实例固定版本**、**停用阻止新实例**、**撤权即时检查**
 * （design-06 P6 / PLG-04；合同 R228 / R230）。
 *
 * ## 三条规则，本层只做"记账 + 核对"
 *
 * 注册表（`registry.ts`）已经提供原子动作：`pin()` 固化绑定、`gateInstanceCreation()`
 * 在每次新建实例时**现读**状态（不缓存）、`revokeAuthorization()` 即时改状态。本层在其上加一张
 * **活跃实例台账**，把 PLG-04 的三条规则变成**可核对**的事实：
 *
 * 1. **固定版本**：实例一经签发，其 `version` 与 `pinned_at` 就**冻结**。此后插件更新（换清单
 *    版本）**不改写**既有实例——旧实例继续按旧版本跑，新实例才拿新版本。`driftReport()`
 *    如实报告"冻结版本 vs 当前版本"的偏差（`upgraded` / `downgraded`），但**偏差不等于改写**：
 *    台账里的实例始终原样。
 * 2. **停用阻止新实例**：`checkNewInstance()` 直接问注册表闸门；停用后返回 `ok: false`，
 *    活跃实例的既有绑定**不受影响**。
 * 3. **撤权即时检查**：撤权后**下一次** `checkNewInstance()` 立即失败（原因含"未授权"），
 *    不需要重签绑定、不需要等重启；重新授权后恢复。
 *
 * ## 为什么要有 `assertFrozenBindingUnchanged()`
 *
 * "固定版本"的反面是"**悄悄改写**"。该断言把一个候选绑定与台账里的冻结值逐字段比对，
 * 一旦 `version` / `pinned_at` / `plugin_id` 被改动就**结构化抛错**——让"执行中途改规则"
 * 在类型与运行时都无处藏身。
 *
 * 纯内存台账 + 注入的 `PluginRegistry` 与探针：零 IO、不含墙钟与随机数。
 */

import type { CapabilityId, LogicalTime } from '../protocol/index.js';
import { ValidationError } from '../protocol/index.js';
import { compareVersions, type PluginId } from './manifest.js';
import type { DiscoveryProbes, InstanceCreationGate, PluginBinding, PluginRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// 冻结规则（用于说明文案与断言）
// ---------------------------------------------------------------------------

/** PLG-04 的三条规则（封闭列表；测试断言其逐条写出）。 */
export const FREEZE_RULES = [
  '活跃实例固定版本：绑定一经签发，停用/更新/撤权都不改写它的版本与签发时刻（R230）',
  '停用阻止新实例：停用后新建实例被拒，既有绑定不受影响（R230）',
  '授权撤销即时检查：撤权后下一次新建实例立即被拒（原因含"未授权"），重新授权后恢复（R230）',
] as const;

// ---------------------------------------------------------------------------
// 活跃实例台账
// ---------------------------------------------------------------------------

/** 一个被冻结的活跃实例（其绑定不可改写）。 */
export interface FrozenInstance {
  readonly instance_id: string;
  readonly plugin_id: PluginId;
  /** 签发时固化的版本——**永不**被后续更新改写。 */
  readonly version: string;
  readonly capability_ids: readonly CapabilityId[];
  readonly pinned_at: LogicalTime;
}

/** 一次版本偏差核对的结果。 */
export interface VersionDriftEntry {
  readonly instance_id: string;
  readonly frozen_version: string;
  /** 注册表当前记载的版本（插件不再存在时为 `null`，不编造）。 */
  readonly current_version: string | null;
  /** `frozen_version !== current_version`。 */
  readonly drift: boolean;
  /** 相对方向（`compareVersions(frozen, current)` 的语义）。 */
  readonly direction: 'none' | 'upgraded' | 'downgraded' | 'unknown';
  /** 冻结绑定本身是否未被改写。恒为 `true`（本层从不改写台账里的实例）。 */
  readonly frozen_binding_intact: true;
  readonly note: string;
}

function direction(frozen: string, current: string): VersionDriftEntry['direction'] {
  const cmp = compareVersions(frozen, current);
  if (cmp === 0) return 'none';
  return cmp < 0 ? 'upgraded' : 'downgraded';
}

/**
 * 断言一个候选绑定与冻结值**逐字段一致**（没有"悄悄改写"）。
 *
 * @throws {ValidationError} `version` / `pinned_at` / `plugin_id` 任一被改动。
 */
export function assertFrozenBindingUnchanged(frozen: FrozenInstance, candidate: FrozenInstance): void {
  if (
    candidate.plugin_id !== frozen.plugin_id ||
    candidate.version !== frozen.version ||
    candidate.pinned_at !== frozen.pinned_at
  ) {
    throw new ValidationError(
      `活跃实例 ${frozen.instance_id} 的固定绑定被改写：停用 / 更新 / 撤权不得在执行中途改规则（R230）`,
    );
  }
}

/**
 * 活跃实例版本台账。
 *
 * 用**实例 id** 作键：同一个实例只能签发一次绑定（重复签发 ⇒ 抛错，避免"这到底按哪个版本跑"
 * 无法回答）。
 */
export class VersionFreezer {
  private readonly instances = new Map<string, FrozenInstance>();
  private readonly registry: PluginRegistry;

  constructor(registry: PluginRegistry) {
    this.registry = registry;
  }

  /**
   * 为一个活跃实例签发固定绑定并记账。
   *
   * @throws {ValidationError} 插件此刻**不就绪**（注册表闸门拒绝），或该实例 id 已有绑定。
   */
  issue(pluginId: string, instanceId: string, at: LogicalTime, probes: DiscoveryProbes): FrozenInstance {
    if (this.instances.has(instanceId)) {
      throw new ValidationError(
        `实例 ${instanceId} 已有固定绑定：不允许覆盖——一个活跃实例只能有一个冻结版本（R230）`,
      );
    }
    // `pin()` 内部走闸门：未安装 / 未启用 / 未授权 / 依赖缺失 / 未实测 / stub 一律拒绝。
    const binding = this.registry.pin(pluginId, at, probes);
    return this.store(instanceId, binding);
  }

  /** 登记一个**外部已签发**的绑定（用于恢复 / 迁移场景；同样拒绝覆盖已有实例）。 */
  record(instanceId: string, binding: PluginBinding): FrozenInstance {
    if (this.instances.has(instanceId)) {
      throw new ValidationError(`实例 ${instanceId} 已有固定绑定：不允许覆盖（R230）`);
    }
    return this.store(instanceId, binding);
  }

  private store(instanceId: string, binding: PluginBinding): FrozenInstance {
    const frozen = Object.freeze({
      instance_id: instanceId,
      plugin_id: binding.plugin_id,
      version: binding.version,
      capability_ids: Object.freeze([...binding.capability_ids]),
      pinned_at: binding.pinned_at,
    });
    this.instances.set(instanceId, frozen);
    return frozen;
  }

  /** 取一个实例的冻结绑定（不存在返回 `undefined`，不编造）。 */
  get(instanceId: string): FrozenInstance | undefined {
    return this.instances.get(instanceId);
  }

  /** 某插件的全部活跃实例（顺序 = 签发顺序）。 */
  listFor(pluginId: string): readonly FrozenInstance[] {
    return Object.freeze([...this.instances.values()].filter((instance) => instance.plugin_id === pluginId));
  }

  /** 台账里的实例总数。 */
  get size(): number {
    return this.instances.size;
  }

  /** 新建实例闸门（停用阻止、撤权即时；每次都现读注册表状态）。 */
  checkNewInstance(pluginId: string, at: LogicalTime, probes: DiscoveryProbes): InstanceCreationGate {
    return this.registry.gateInstanceCreation(pluginId, at, probes);
  }

  /**
   * 该插件全部活跃实例的**版本偏差报告**（冻结版本 vs 当前版本）。
   * 偏差如实报告，但**不改写**任何冻结实例。
   */
  driftReport(pluginId: string): readonly VersionDriftEntry[] {
    const currentVersion =
      this.registry.recordOf(pluginId)?.version ?? this.registry.manifestOf(pluginId)?.version ?? null;
    return Object.freeze(
      this.listFor(pluginId).map((instance) => {
        if (currentVersion === null) {
          return Object.freeze({
            instance_id: instance.instance_id,
            frozen_version: instance.version,
            current_version: null,
            drift: true,
            direction: 'unknown' as const,
            frozen_binding_intact: true as const,
            note: `插件 ${pluginId} 当前没有版本记载：冻结版本 ${instance.version} 保持不变，偏差方向未知`,
          });
        }
        const dir = direction(instance.version, currentVersion);
        return Object.freeze({
          instance_id: instance.instance_id,
          frozen_version: instance.version,
          current_version: currentVersion,
          drift: dir !== 'none',
          direction: dir,
          frozen_binding_intact: true as const,
          note:
            dir === 'none'
              ? `实例按冻结版本 ${instance.version} 与当前版本一致`
              : `插件当前版本为 ${currentVersion}，实例仍按冻结版本 ${instance.version} 运行（固定版本，R230）`,
        });
      }),
    );
  }
}

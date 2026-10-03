/**
 * K-I10 适配器 · **投影纯函数**：K06 manifest + 探针就绪 ⇒ K05 发现词表。
 *
 * 纯函数、零 IO、不读墙钟、不引随机数、不调用任何探针。同输入恒同输出（含 `digest`）。
 *
 * 三步，各自可断言：
 *   1. `projectCapabilityProviders` —— 逐模板逐能力展开成 `CapabilityProviderView`（诊断面）。
 *   2. `coalesceProviders` —— 按 `capability_id` 合并（见下"冲突口径"），得 K05 词表。
 *   3. `projectCapabilityDiscovery` —— 把前两步 + 缺席模板 + 冲突登记 + 摘要打包成
 *      `CapabilityProjection`。
 *
 * ## 冲突口径（同一能力被多模板声明）
 *
 * K05 的 `classifyCapability` 用 `.find()` 取**第一条**匹配；若目录里把某个能提供该能力、
 * 但当前未就绪的模板排在前面，就会把一条实际可调度的能力误判为阻塞。因此本层在投影时
 * **先合并**：对同一 `capability_id` 的多个提供者，取秩最高者——
 *
 *   `rank = (authorized ? 2 : 0) + (executable ? 1 : 0)`
 *
 * （3 = 已授权且可执行 > 2 = 已授权但不可执行 > 1 = 未授权但可执行 > 0 = 两者皆否），
 * 同秩取**输入顺序在前**者。冲突本身**不隐藏**：登记进 `collisions`，并保留全部提供者在
 * `providers` 里，便于对账。
 */

import { structuralDigest } from '../../dispatch/digest.js';
import type { DiscoveredCapability } from '../../dispatch/types.js';
import { READINESS_STATE_NAMES, type ReadinessReport } from '../../templates/types.js';
import type {
  CapabilityCollision,
  CapabilityProjection,
  CapabilityProviderView,
  TemplateReadinessSnapshot,
} from './types.js';

/** K05 的 `executable` 由 K06 的 `enabled` 与 `portReady` 两态聚合而来。 */
const EXECUTABLE_STATES = ['enabled', 'portReady'] as const;

/**
 * 汇总进 `note` 的态：`enabled` / `authorized` / `portReady`（`installed` 只决定是否出现，
 * 非就绪即整条缺席，不进 note）。`authorized` 必须在内——否则"未授权"这条会丢掉原因，
 * 只留一个 `authorized:false` 的空结论。
 */
const NOTE_STATES = ['enabled', 'authorized', 'portReady'] as const;

function isReady(report: ReadinessReport | null, state: (typeof READINESS_STATE_NAMES)[number]): boolean {
  return report !== null && report[state].state === 'ready';
}

/**
 * 汇总"挡住了这条能力"的非就绪态原因，形如
 * `enabled:disabled; portReady:capability_unavailable:cap.doc.create`。
 * 全就绪（或 installed 之外全就绪）时返回 null。
 */
function notReadyNote(report: ReadinessReport | null, states: readonly string[]): string | null {
  if (report === null) {
    return 'installed:no_installed_version';
  }
  const parts: string[] = [];
  for (const name of states) {
    const named = name as (typeof READINESS_STATE_NAMES)[number];
    const state = report[named];
    if (state.state !== 'ready') {
      parts.push(`${name}:${state.reason ?? 'unknown'}`);
    }
  }
  return parts.length === 0 ? null : parts.join('; ');
}

/** 判断一个模板是否**没有可用安装版本**（含 `readiness === null` 与 `installed: not-ready`）。 */
export function isAbsentTemplate(snapshot: TemplateReadinessSnapshot): boolean {
  return !isReady(snapshot.readiness, 'installed');
}

/**
 * 逐模板逐能力展开成诊断视图。
 *
 * 缺席（未安装 / 已卸载）的模板**不产出任何提供者**：其能力不进目录 ⇒ K05 判
 * `missing_capability`（"没装 / 目录里没有"）。
 */
export function projectCapabilityProviders(
  snapshots: readonly TemplateReadinessSnapshot[],
): readonly CapabilityProviderView[] {
  const providers: CapabilityProviderView[] = [];
  for (const snapshot of snapshots) {
    if (isAbsentTemplate(snapshot)) {
      continue;
    }
    const report = snapshot.readiness;
    const installed = true;
    const enabled = isReady(report, 'enabled');
    const authorized = isReady(report, 'authorized');
    const portReady = isReady(report, 'portReady');
    const executable = EXECUTABLE_STATES.every((state) => isReady(report, state));
    const note = notReadyNote(report, NOTE_STATES);
    for (const capabilityId of snapshot.manifest.capabilities) {
      providers.push(
        Object.freeze({
          capability_id: capabilityId,
          template_id: snapshot.manifest.id,
          template_version: snapshot.manifest.version,
          installed,
          enabled,
          authorized,
          port_ready: portReady,
          executable,
          note,
        }),
      );
    }
  }
  return Object.freeze(providers);
}

/** 提供者的合并秩：已授权 2 分 + 可执行 1 分。 */
function rankOf(provider: CapabilityProviderView): number {
  return (provider.authorized ? 2 : 0) + (provider.executable ? 1 : 0);
}

/**
 * 按 `capability_id` 合并提供者为 K05 词表。返回顺序 = 各能力**首次出现**的顺序
 * （确定性；也决定了 K05 `.find()` 命中哪一条——但合并后每 id 只保留一条）。
 */
export function coalesceProviders(
  providers: readonly CapabilityProviderView[],
): readonly DiscoveredCapability[] {
  const best = new Map<string, CapabilityProviderView>();
  const order: string[] = [];
  for (const provider of providers) {
    const current = best.get(provider.capability_id);
    if (current === undefined) {
      order.push(provider.capability_id);
      best.set(provider.capability_id, provider);
      continue;
    }
    if (rankOf(provider) > rankOf(current)) {
      best.set(provider.capability_id, provider);
    }
  }
  return Object.freeze(
    order.map((capabilityId) => {
      // order 由 best 的键构成，故必存在；缺失即内部不一致（不静默跳过）。
      const provider = best.get(capabilityId);
      if (provider === undefined) {
        throw new Error(`能力合并内部不一致：${capabilityId} 在顺序表里却无提供者`);
      }
      const capability: DiscoveredCapability = {
        capability_id: provider.capability_id,
        template_id: provider.template_id,
        authorized: provider.authorized,
        executable: provider.executable,
        ...(provider.note === null ? {} : { note: provider.note }),
      };
      return Object.freeze(capability);
    }),
  );
}

/** 登记冲突：同一 `capability_id` 被 ≥ 2 个不同模板声明。 */
export function findCollisions(providers: readonly CapabilityProviderView[]): readonly CapabilityCollision[] {
  const byCapability = new Map<string, string[]>();
  for (const provider of providers) {
    const list = byCapability.get(provider.capability_id);
    if (list === undefined) {
      byCapability.set(provider.capability_id, [provider.template_id]);
    } else if (!list.includes(provider.template_id)) {
      list.push(provider.template_id);
    }
  }
  const collisions: CapabilityCollision[] = [];
  for (const [capabilityId, templateIds] of byCapability) {
    if (templateIds.length > 1) {
      collisions.push(Object.freeze({ capability_id: capabilityId, template_ids: Object.freeze([...templateIds]) }));
    }
  }
  return Object.freeze(collisions);
}

/**
 * 由快照直接得 K05 词表（最常用入口；名字对齐 K05 集成请求里的 `projectCapabilityInventory`）。
 */
export function projectCapabilityInventory(
  snapshots: readonly TemplateReadinessSnapshot[],
): readonly DiscoveredCapability[] {
  return coalesceProviders(projectCapabilityProviders(snapshots));
}

/** 完整投影：词表 + 逐提供者视图 + 缺席模板 + 冲突登记 + 确定性摘要。 */
export function projectCapabilityDiscovery(
  snapshots: readonly TemplateReadinessSnapshot[],
): CapabilityProjection {
  const providers = projectCapabilityProviders(snapshots);
  const capabilities = coalesceProviders(providers);
  const absentTemplateIds = snapshots.filter(isAbsentTemplate).map((snapshot) => snapshot.manifest.id);
  const collisions = findCollisions(providers);
  const digest = structuralDigest(
    JSON.stringify({
      capabilities: capabilities.map((capability) => [
        capability.capability_id,
        capability.template_id,
        capability.authorized,
        capability.executable,
      ]),
      absent: [...absentTemplateIds].sort(),
    }),
  );
  return Object.freeze({
    capabilities,
    providers,
    absent_template_ids: Object.freeze([...absentTemplateIds]),
    collisions,
    digest,
  });
}

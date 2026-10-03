/**
 * F08 templates —— 把模板状态投影为契约 `TemplateManifest`（`contracts/mobile-v1/types.ts`）。
 *
 * 为什么需要它：模版目录/详情的四态**不是前端自造**——它是 K06 `TemplateManifest.probe`
 * 的界面投影。本模块保证前端构造出的清单形状与冻结契约逐字段对齐，并由
 * `tests/mobile-ui/F08/contract.test.ts` 交给**真校验器** `contracts/mobile-v1/validate.mjs`
 * 实跑（含反向对照，证明校验器不是空转）。
 *
 * 不变量：`probe` **只有** installed / enabled / authorized / portReady 四个布尔（外加
 * verificationMode / layers / checkedAt），任何合并「就绪」字段都会让契约
 * `additionalProperties: false` 校验失败——本模块另加本地断言 `assertNoCollapsedReady`，
 * 在构造期就拦住回归。
 */

import type { TemplateManifest, TemplateProbe } from '../../../../contracts/mobile-v1/types.js';
import type { TemplateDefinition, TemplateLifecycle, VerificationMode } from './types.js';
import { deriveReadiness } from './readiness.js';
import { getTemplateDefinition } from './catalog.js';
import { getTemplate } from './lifecycle.js';
import { TemplateError } from './types.js';
import type { TemplatesState } from './types.js';

/** `probe` 允许的键，恰好是契约 `$defs.probe` 的键。 */
const PROBE_KEYS: readonly string[] = [
  'installed',
  'enabled',
  'authorized',
  'portReady',
  'verificationMode',
  'layers',
  'checkedAt',
];

/**
 * 本地防回归断言：`probe` 不得出现合并就绪字段（如 `ready` / `usable` / `available`），
 * 且四态字段名必须齐全。契约校验器会再兜一层；这里让构造期直接抛错，定位更快。
 */
export function assertNoCollapsedReady(probe: TemplateProbe): void {
  const keys = Object.keys(probe);
  const extra = keys.filter((key) => !PROBE_KEYS.includes(key));
  if (extra.length > 0) {
    throw new TemplateError('invalid-transition', `probe 含非契约字段（可能是合并就绪态）：${extra.join('、')}`, {
      extra,
    });
  }
  for (const required of ['installed', 'enabled', 'authorized', 'portReady'] as const) {
    if (typeof probe[required] !== 'boolean') {
      throw new TemplateError('invalid-transition', `probe.${required} 必须是独立布尔`, { field: required });
    }
  }
}

/** 由生命周期状态 + 静态定义构造契约 `probe`。 */
export function toProbe(
  lifecycle: TemplateLifecycle,
  overrideMode?: VerificationMode,
): TemplateProbe {
  const readiness = deriveReadiness(lifecycle);
  const probe: TemplateProbe = {
    installed: readiness.installed,
    enabled: readiness.enabled,
    authorized: readiness.authorized,
    portReady: readiness.portReady,
    verificationMode: overrideMode ?? lifecycle.verificationMode,
    layers: [...lifecycle.layers],
    ...(lifecycle.checkedAt === null ? {} : { checkedAt: lifecycle.checkedAt }),
  };
  assertNoCollapsedReady(probe);
  return probe;
}

/**
 * 构造契约 `TemplateManifest`。字段与 `contracts/mobile-v1/schemas/template-manifest.schema.json`
 * 的 required 完全一致：id / version / capabilities / schemas / permissions /
 * runtimeCompatibility / migration / probe。
 *
 * `version`：已安装取安装版本，未安装取目录版本（展示「可安装到 vX」用）；二者都满足 `x.y.z`。
 * `capabilities` 取**静态能力 id**——能力是否可用由 `probe` + 目录行 `capabilityGaps` 表达，
 * 不在 manifest 里冒充。
 */
export function toTemplateManifest(
  definition: TemplateDefinition,
  lifecycle: TemplateLifecycle,
  options: { readonly verificationMode?: VerificationMode } = {},
): TemplateManifest {
  return {
    id: definition.id,
    displayName: definition.displayName,
    version: lifecycle.installedVersion ?? definition.version,
    capabilities: definition.capabilities.map((capability) => capability.id),
    schemas: definition.producesFileFormats.length > 0 ? ['office-plugin.schema.json', 'storage-port.schema.json'] : [],
    permissions: [...definition.permissions],
    runtimeCompatibility: definition.runtimeCompatibility,
    migration: definition.migration,
    probe: toProbe(lifecycle, options.verificationMode),
  };
}

/** 便捷：直接从状态取某模板的契约清单。 */
export function manifestFor(
  state: TemplatesState,
  id: string,
  options: { readonly verificationMode?: VerificationMode } = {},
): TemplateManifest {
  const lifecycle = getTemplate(state, id);
  const definition = getTemplateDefinition(id);
  return toTemplateManifest(definition, lifecycle, options);
}

/** 目录全量清单（七个，按规范顺序）——用于批量契约校验。 */
export function allManifests(
  state: TemplatesState,
  options: { readonly verificationMode?: VerificationMode } = {},
): readonly TemplateManifest[] {
  return state.templates.map((lifecycle) =>
    toTemplateManifest(getTemplateDefinition(lifecycle.id), lifecycle, options),
  );
}

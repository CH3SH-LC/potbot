/**
 * M10 美团模板 manifest 与**生产启用闸门**。
 *
 * ## 契约来源与关系
 *
 * 形状照 `contracts/mobile-v1/schemas/template-manifest.schema.json` 与其 fixture
 * `contracts/mobile-v1/fixtures/success/template-manifest-meituan.json`；完整形状校验归
 * K06（`apps/mobile-kernel/templates/manifest.ts`）。本模块**不重复**整套 validator，
 * 只做 M10 自己关心的三条**硬约束**，并在注释里逐条指出对应契约条款：
 *
 * 1. **四态不得合并**：`probe.installed/enabled/authorized/portReady` 必须各自为布尔，
 *    根对象与 probe 都 `additionalProperties: false` ⇒ 出现 `ready` 这类汇总字段即拒。
 * 2. **verificationMode 必须在场**（契约把它做成 external-receipt 的实质必需字段）。
 * 3. **生产启用闸门**：`assertProductionActivation()` 要求 `verificationMode === 'real'`
 *    且 `portReady === true` 且四态齐备。fixture 构建出的 manifest **永远**过不了这道闸
 *    ——这正是「不能把 fixture 接入生产开关」在 manifest 层的落点。
 *
 * ## 明确未做
 *
 * 本模块不安装/启用/授权任何东西（那是 K06 生命周期）；它只产出**声明**并守住闸门。
 */

import { SCOPE_CAPABILITIES } from './types.js';

// ---------------------------------------------------------------------------
// 结构（字段名严格照契约）
// ---------------------------------------------------------------------------

export const FEATURE_MANIFEST_OS = 'android' as const;

export interface FeatureProbeDeclaration {
  /** 四态：各自独立，禁止合并。 */
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly authorized: boolean;
  readonly portReady: boolean;
  readonly verificationMode: 'fixture' | 'real';
  readonly layers: readonly string[];
  readonly checkedAt?: string;
}

export interface FeatureManifest {
  readonly id: string;
  readonly displayName?: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly schemas: readonly string[];
  readonly permissions: readonly string[];
  readonly runtimeCompatibility: {
    readonly os: typeof FEATURE_MANIFEST_OS;
    readonly minimumOs: number;
    readonly runtimes: readonly string[];
    readonly abis: readonly string[];
  };
  readonly migration: {
    readonly from: string;
    readonly to: string;
    readonly strategy: string;
    readonly reversible: boolean;
  };
  readonly probe: FeatureProbeDeclaration;
}

/** 契约根对象必需字段（顺序照 schema）。 */
export const MANIFEST_ROOT_REQUIRED = [
  'id',
  'version',
  'capabilities',
  'schemas',
  'permissions',
  'runtimeCompatibility',
  'migration',
  'probe',
] as const;

const ROOT_ALLOWED = new Set<string>([...MANIFEST_ROOT_REQUIRED, 'displayName']);
const PROBE_ALLOWED = new Set<string>([
  'installed',
  'enabled',
  'authorized',
  'portReady',
  'verificationMode',
  'layers',
  'checkedAt',
]);

// ---------------------------------------------------------------------------
// 构建
// ---------------------------------------------------------------------------

export interface BuildFeatureManifestOptions {
  readonly verificationMode: 'fixture' | 'real';
  readonly portReady: boolean;
  readonly checkedAt?: string;
  readonly capabilities?: readonly string[];
  readonly version?: string;
}

/**
 * 构建美团业务模板 manifest。
 *
 * **默认值即诚实默认**：`verificationMode` 由调用方显式给出；`portReady` 也是。
 * 在 M01/M02 未交付时，调用方只能填 `fixture` + `portReady: false`——这正是真实现状。
 */
export function buildMeituanFeatureManifest(options: BuildFeatureManifestOptions): FeatureManifest {
  const verificationMode = options.verificationMode;
  const capabilities =
    options.capabilities ??
    SCOPE_CAPABILITIES.map((capability) => `meituan.${capability}`);
  return Object.freeze({
    id: 'meituan-order',
    displayName: '美团外卖',
    version: options.version ?? '1.0.0',
    capabilities: Object.freeze([...capabilities]),
    schemas: Object.freeze([
      'command.schema.json',
      'confirm-action.schema.json',
      'external-receipt.schema.json',
      'template-manifest.schema.json',
    ]),
    permissions: Object.freeze(['network', 'model', 'device', 'external-order']),
    runtimeCompatibility: Object.freeze({
      os: FEATURE_MANIFEST_OS,
      minimumOs: 26,
      runtimes: Object.freeze(['quickjs']),
      abis: Object.freeze(['arm64-v8a']),
    }),
    migration: Object.freeze({
      from: '0.13.0',
      to: options.version ?? '1.0.0',
      strategy: 'transform',
      reversible: false,
    }),
    probe: Object.freeze({
      installed: true,
      enabled: true,
      authorized: true,
      portReady: options.portReady,
      verificationMode,
      layers: Object.freeze(['unit', 'contract']),
      ...(options.checkedAt === undefined ? {} : { checkedAt: options.checkedAt }),
    }),
  });
}

// ---------------------------------------------------------------------------
// 校验（M10 关注的三条硬约束）
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 逐条校验 M10 关注的 manifest 约束；返回问题清单（空 = 通过）。 */
export function validateFeatureManifest(input: unknown): readonly string[] {
  const problems: string[] = [];
  if (!isPlainObject(input)) {
    return ['manifest 必须是对象'];
  }
  // additionalProperties: false（根对象）——拒掉 ready 之类的合并字段。
  for (const key of Object.keys(input)) {
    if (!ROOT_ALLOWED.has(key)) {
      problems.push(`根对象不接受字段 ${key}（四态必须分别上报，不得合并）`);
    }
  }
  for (const key of MANIFEST_ROOT_REQUIRED) {
    if (!(key in input)) {
      problems.push(`根对象缺少必需字段 ${key}`);
    }
  }
  if (typeof input['id'] !== 'string' || (input['id'] as string).length === 0) {
    problems.push('id 必须是非空字符串');
  }
  if (typeof input['version'] !== 'string' || !/^\d+\.\d+\.\d+$/.test(input['version'] as string)) {
    problems.push('version 必须匹配 ^\\d+\\.\\d+\\.\\d+$');
  }
  if (!Array.isArray(input['capabilities']) || (input['capabilities'] as unknown[]).length === 0) {
    problems.push('capabilities 至少需要 1 项');
  }

  const probe = input['probe'];
  if (!isPlainObject(probe)) {
    problems.push('probe 必须是对象');
    return problems;
  }
  for (const key of Object.keys(probe)) {
    if (!PROBE_ALLOWED.has(key)) {
      problems.push(`probe 不接受字段 ${key}（四态不得合并 / 无额外字段）`);
    }
  }
  for (const key of ['installed', 'enabled', 'authorized', 'portReady'] as const) {
    if (!(key in probe)) {
      problems.push(`probe 缺少必需状态字段 ${key}（四态必须分别上报）`);
      continue;
    }
    if (typeof probe[key] !== 'boolean') {
      problems.push(`probe.${key} 必须是独立布尔，实际是 ${typeof probe[key]}`);
    }
  }
  if (probe['verificationMode'] !== 'fixture' && probe['verificationMode'] !== 'real') {
    problems.push('probe.verificationMode 必须是 fixture 或 real');
  }
  if (!Array.isArray(probe['layers']) || (probe['layers'] as unknown[]).length === 0) {
    problems.push('probe.layers 至少需要 1 项');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 生产启用闸门
// ---------------------------------------------------------------------------

export const PRODUCTION_BLOCK_REASONS = [
  'manifest_invalid',
  'not_real_mode',
  'port_not_ready',
  'not_installed',
  'not_enabled',
  'not_authorized',
] as const;
export type ProductionBlockReason = (typeof PRODUCTION_BLOCK_REASONS)[number];

export interface ProductionActivationCheck {
  readonly activatable: boolean;
  readonly blocks: readonly ProductionBlockReason[];
  readonly detail: string;
}

/**
 * 生产启用是否可达。**fixture manifest 恒不可达**。
 *
 * 注意：本函数只判断 manifest **声明**是否满足生产启用条件。真正的生产还需要 M01/M02
 * 核实出的官方 endpoint 与手机直连能力，以及 K07 的确认账本——**那些都还没有**
 * （`host.ts` 的 `createRealFeatureHost` 诚实抛错）。
 */
export function checkProductionActivation(manifest: unknown): ProductionActivationCheck {
  const problems = validateFeatureManifest(manifest);
  if (problems.length > 0) {
    return Object.freeze({
      activatable: false,
      blocks: Object.freeze(['manifest_invalid'] as ProductionBlockReason[]),
      detail: `manifest 不合法：${problems.slice(0, 4).join(' | ')}`,
    });
  }
  const typed = manifest as FeatureManifest;
  const blocks: ProductionBlockReason[] = [];
  if (typed.probe.verificationMode !== 'real') {
    blocks.push('not_real_mode');
  }
  if (typed.probe.portReady !== true) {
    blocks.push('port_not_ready');
  }
  if (typed.probe.installed !== true) {
    blocks.push('not_installed');
  }
  if (typed.probe.enabled !== true) {
    blocks.push('not_enabled');
  }
  if (typed.probe.authorized !== true) {
    blocks.push('not_authorized');
  }
  return Object.freeze({
    activatable: blocks.length === 0,
    blocks: Object.freeze(blocks),
    detail:
      blocks.length === 0
        ? '声明满足生产启用条件（仍需真实 endpoint 与 K07 账本方可真正下单）'
        : `生产启用被以下条件阻断：${blocks.join(', ')}`,
  });
}

/** 不可激活即抛（把闸门变成**执行点**，而不只是查询）。 */
export function assertProductionActivation(manifest: unknown): FeatureManifest {
  const check = checkProductionActivation(manifest);
  if (!check.activatable) {
    throw new Error(
      `fixture/未就绪 manifest 不得进入生产路径：${check.blocks.join(', ')}。${check.detail}`,
    );
  }
  return manifest as FeatureManifest;
}

/** 断言一份 manifest **确实不是**生产可用（用于守住 fixture 构建的产物）。 */
export function assertNotProductionManifest(manifest: unknown): void {
  const check = checkProductionActivation(manifest);
  if (check.activatable) {
    throw new Error('fixture 构建出的 manifest 意外通过了生产启用闸门——这不该发生');
  }
}

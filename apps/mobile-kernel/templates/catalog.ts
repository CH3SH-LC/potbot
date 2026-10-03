/**
 * K06 七模板清单目录 —— 把 **`src/plugins/` 的既有七个业务模板** 投影成 mobile-v1
 * `TemplateManifest`（契约 `contracts/mobile-v1/schemas/template-manifest.schema.json`）。
 *
 * ## 为什么"派生"而不是"再抄一份七个名字"
 *
 * `src/plugins/catalog.ts`（EXISTING 共享代码）已经冻结了"业务模板到底是哪七个"：
 * `template.document / spreadsheet / presentation / meituan / clock / calendar / research`
 * （`BUSINESS_TEMPLATE_IDS`）。本文件**不重抄**这份名单，而是 `BUSINESS_TEMPLATES.map(...)`：
 *
 *  - 少一个 / 多一个 / 改名 ⇒ 本目录立刻跟着变，`tests/mobile-kernel/K06/04-*` 的
 *    数量与 id 对账会红；
 *  - capability 逐条从 `business.capabilities[].capability_id` 取，**不丢声明的能力**；
 *  - 权限经 `PERMISSION_ID_TO_TEMPLATE_PERMISSION` 全量映射：出现没登记的 `permission_id`
 *    ⇒ 构造期**直接抛错**（宁可 import 失败，也不静默丢权）。
 *
 * ## 诚实口径：这是**声明**，不是就绪结论
 *
 * 派生出的 `probe.*` 四个布尔是模板**自称**的探针声明，本模块**一律填 false**：
 * 本机**没有任何真机探针**跑过这七个模板，`verificationMode` 因此只能是 `'fixture'`。
 * 就绪判定由 `lifecycle.reportReadiness()` 走宿主 `TemplateProbePort` 的真实读回完成——
 * 它**不读**这里的 `probe` 字段。
 *
 * 零依赖、纯数据 + 构造期校验；不 import node 内建。
 */

import { BUSINESS_TEMPLATES } from '../../../src/plugins/catalog.js';
import type { BusinessTemplateManifest } from '../../../src/plugins/manifest.js';
import {
  TEMPLATE_OS,
  type MigrationStrategy,
  type TemplateAbi,
  type TemplateManifest,
  type TemplatePermission,
  type TemplateRuntime,
  type VerificationLayer,
  type VerificationMode,
} from './types.js';

// ---------------------------------------------------------------------------
// 权限映射：既有 `permission_id`（点号式） → mobile-v1 `permission` 枚举
// ---------------------------------------------------------------------------

/**
 * `src/plugins` 的 `permission_id` → mobile-v1 契约的 `permission` 枚举。
 *
 * **必须是满射**：`deriveTemplateManifest` 遇到未登记的 `permission_id` 会抛错，
 * 使"目录新增了权限但没人更新映射"这类漏权在构造期就暴露，而不是静默丢权。
 */
export const PERMISSION_ID_TO_TEMPLATE_PERMISSION: Readonly<Record<string, TemplatePermission>> =
  Object.freeze({
    'perm.file.write': 'file-write',
    'perm.network.read': 'network',
    'perm.model.invoke': 'model',
    'perm.clock.schedule': 'device',
    'perm.calendar.read': 'device',
    'perm.calendar.write': 'device',
    'perm.files.read': 'storage',
    'perm.memory.write': 'storage',
    'perm.group.read': 'device',
  });

/** 每个业务模板引用的契约 schema 文件名（mobile-v1 内；**逐模板显式**，缺失即报错）。 */
export const TEMPLATE_SCHEMAS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'template.document': Object.freeze([
    'office-plugin.schema.json',
    'storage-port.schema.json',
    'facts-port.schema.json',
  ]),
  'template.spreadsheet': Object.freeze([
    'office-plugin.schema.json',
    'storage-port.schema.json',
    'facts-port.schema.json',
  ]),
  'template.presentation': Object.freeze([
    'office-plugin.schema.json',
    'storage-port.schema.json',
    'facts-port.schema.json',
  ]),
  'template.meituan': Object.freeze([
    'confirm-action.schema.json',
    'external-receipt.schema.json',
  ]),
  'template.clock': Object.freeze(['command.schema.json', 'event.schema.json']),
  'template.calendar': Object.freeze(['command.schema.json', 'event.schema.json']),
  'template.research': Object.freeze(['facts-port.schema.json', 'storage-port.schema.json']),
});

/** 七模板清单共用的运行时兼容声明（手机内核：quickjs + arm64-v8a + API 26 起）。 */
const CATALOG_MINIMUM_OS = 26;
const CATALOG_RUNTIMES: readonly TemplateRuntime[] = Object.freeze(['quickjs']);
const CATALOG_ABIS: readonly TemplateAbi[] = Object.freeze(['arm64-v8a']);
const CATALOG_LAYERS: readonly VerificationLayer[] = Object.freeze(['unit', 'contract']);
/** 本机未接真机 ⇒ 声明层只能是 fixture（不得写 real）。 */
const CATALOG_VERIFICATION_MODE: VerificationMode = 'fixture';

/**
 * 把既有业务模板的 `plugin_id` 投影成 mobile-v1 的 `id`：
 * 去掉 `template.` 前缀 ⇒ `document / spreadsheet / presentation / meituan / clock / calendar / research`。
 */
export function mobileTemplateId(pluginId: string): string {
  const prefix = 'template.';
  return pluginId.startsWith(prefix) ? pluginId.slice(prefix.length) : pluginId;
}

/**
 * 把一个 `BusinessTemplateManifest` 投影成 mobile-v1 `TemplateManifest`。
 *
 * @throws {Error} 权限未登记映射，或该模板未登记契约 schema 时（构造期暴露漏配，不静默丢权）。
 */
export function deriveTemplateManifest(business: BusinessTemplateManifest): TemplateManifest {
  const schemas = TEMPLATE_SCHEMAS[business.plugin_id];
  if (schemas === undefined) {
    throw new Error(`模板 ${business.plugin_id} 未登记 mobile-v1 契约 schema 清单（不得静默留空）`);
  }

  const mapped: TemplatePermission[] = business.permissions.map((declaration) => {
    const permission = PERMISSION_ID_TO_TEMPLATE_PERMISSION[declaration.permission_id];
    if (permission === undefined) {
      throw new Error(
        `权限 ${declaration.permission_id}（模板 ${business.plugin_id}）没有到 mobile-v1 权限枚举的映射：` +
          '请在 PERMISSION_ID_TO_TEMPLATE_PERMISSION 登记，不得默默丢弃',
      );
    }
    return permission;
  });

  const manifest: TemplateManifest = {
    id: mobileTemplateId(business.plugin_id),
    displayName: business.display_name,
    version: business.version,
    capabilities: Object.freeze(business.capabilities.map((capability) => capability.capability_id as string)),
    schemas: Object.freeze([...schemas]),
    permissions: Object.freeze([...new Set(mapped)]),
    runtimeCompatibility: Object.freeze({
      os: TEMPLATE_OS,
      minimumOs: CATALOG_MINIMUM_OS,
      runtimes: CATALOG_RUNTIMES,
      abis: CATALOG_ABIS,
    }),
    migration: Object.freeze({
      from: '',
      to: business.version,
      strategy: 'none' as MigrationStrategy,
      reversible: true,
    }),
    probe: Object.freeze({
      // 本机无真机探针：四态声明一律 false（就绪由 reportReadiness 走探针另判）。
      installed: false,
      enabled: false,
      authorized: false,
      portReady: false,
      verificationMode: CATALOG_VERIFICATION_MODE,
      layers: CATALOG_LAYERS,
    }),
  };
  return Object.freeze(manifest);
}

/** 七个模板的 mobile-v1 清单（顺序即 `BUSINESS_TEMPLATES` 的顺序）。 */
export const TEMPLATE_MANIFESTS: readonly TemplateManifest[] = Object.freeze(
  BUSINESS_TEMPLATES.map((business) => deriveTemplateManifest(business)),
);

/** 模板数量（应为 7；供测试对账，不硬编码在别处）。 */
export const TEMPLATE_MANIFEST_COUNT = TEMPLATE_MANIFESTS.length;

/** 七个 mobile-v1 模板 id。 */
export const TEMPLATE_MANIFEST_IDS: readonly string[] = Object.freeze(
  TEMPLATE_MANIFESTS.map((manifest) => manifest.id),
);

/** 按 id 取清单（查不到返回 `undefined`，**不编造**）。 */
export function findTemplateManifest(id: string): TemplateManifest | undefined {
  return TEMPLATE_MANIFESTS.find((manifest) => manifest.id === id);
}

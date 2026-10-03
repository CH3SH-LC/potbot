/**
 * K-I11 夹具：合成 K06 manifest 与 `InstalledTemplate` 生命周期快照，装配模板授权策略的
 * 单一事实来源。零依赖（类型取自被测包与 K06 类型模块）。
 *
 * 反例纪律：`expectPolicyError` 在没有抛错时**主动失败**，避免"该拒的没拒"悄悄变绿。
 */

import { expect } from 'vitest';

import {
  isTemplatePolicyError,
  type TemplatePolicyDenyReason,
  type TemplatePolicyError,
  type TemplatePolicySource,
  type TemplateTaskPin,
} from '../../../apps/mobile-kernel/adapters/template-policy/index.js';
import type {
  InstalledTemplate,
  TemplateManifest,
  TemplatePermission,
} from '../../../apps/mobile-kernel/templates/types.js';

export const T0 = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// manifest 构造
// ---------------------------------------------------------------------------

export interface ManifestOptions {
  readonly version?: string;
  readonly capabilities?: readonly string[];
  readonly permissions?: readonly TemplatePermission[];
}

export function manifest(id: string, options: ManifestOptions = {}): TemplateManifest {
  const version = options.version ?? '1.0.0';
  return {
    id,
    displayName: `${id} 模板`,
    version,
    capabilities: [...(options.capabilities ?? [`${id}.run`])],
    schemas: ['command.schema.json'],
    permissions: [...(options.permissions ?? ['storage'])],
    runtimeCompatibility: {
      os: 'android',
      minimumOs: 26,
      runtimes: ['quickjs'],
      abis: ['arm64-v8a'],
    },
    migration: { from: '', to: version, strategy: 'none', reversible: true },
    // manifest 自称的 probe 布尔**不参与**本层判定；判定只读 InstalledTemplate 的授权集合与状态。
    probe: {
      installed: true,
      enabled: true,
      authorized: true,
      portReady: true,
      verificationMode: 'fixture',
      layers: ['unit'],
    },
  };
}

// ---------------------------------------------------------------------------
// InstalledTemplate 构造
// ---------------------------------------------------------------------------

export interface InstalledOptions {
  readonly version?: string;
  readonly active?: boolean;
  readonly enabled?: boolean;
  readonly grantedPermissions?: readonly TemplatePermission[];
  readonly uninstalled?: boolean;
  readonly frozen?: boolean;
  readonly pinnedBy?: readonly string[];
}

export function installed(template: TemplateManifest, options: InstalledOptions = {}): InstalledTemplate {
  return {
    id: template.id,
    version: options.version ?? template.version,
    manifest: template,
    installedAt: T0,
    active: options.active ?? true,
    frozen: options.frozen ?? false,
    uninstalled: options.uninstalled ?? false,
    enabled: options.enabled ?? true,
    grantedPermissions: options.grantedPermissions ?? template.permissions,
    pinnedBy: options.pinnedBy ?? [],
  };
}

// ---------------------------------------------------------------------------
// 目录与来源装配
// ---------------------------------------------------------------------------

export function source(
  manifests: readonly TemplateManifest[],
  installedRecords: readonly InstalledTemplate[],
  pins: readonly TemplateTaskPin[] = [],
): TemplatePolicySource {
  return { manifests, installed: installedRecords, pins };
}

// 三个合成模板：word 需要 file-write，excel / ppt 只需要 storage。
export const WORD = manifest('word', {
  version: '2.0.0',
  capabilities: ['word.edit'],
  permissions: ['file-write'],
});
export const WORD_V1 = manifest('word', {
  version: '1.0.0',
  capabilities: ['word.edit'],
  permissions: ['file-write'],
});
export const EXCEL = manifest('excel', {
  version: '1.0.0',
  capabilities: ['sheet.edit'],
  permissions: ['storage'],
});
export const PPT = manifest('ppt', {
  version: '1.0.0',
  capabilities: ['slide.edit'],
  permissions: ['storage'],
});

/** 全就绪的参照来源：word/excel/ppt 都装了、启用了、按声明授权。 */
export function healthySource(): TemplatePolicySource {
  return source(
    [WORD, EXCEL, PPT],
    [installed(WORD), installed(EXCEL), installed(PPT)],
  );
}

// ---------------------------------------------------------------------------
// 断言助手
// ---------------------------------------------------------------------------

/** 断言抛出的是带指定 reason 的 TemplatePolicyError（没抛即失败）。 */
export function expectPolicyError(
  fn: () => unknown,
  reason: TemplatePolicyDenyReason,
): TemplatePolicyError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, `期望抛出 TemplatePolicyError(${reason})，实际没有抛出`).toBeDefined();
  expect(isTemplatePolicyError(caught), `抛出的不是 TemplatePolicyError：${String(caught)}`).toBe(true);
  if (isTemplatePolicyError(caught)) {
    expect(caught.reason).toBe(reason);
  }
  return caught as TemplatePolicyError;
}

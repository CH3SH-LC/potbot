/**
 * K06 独立验证 ①：manifest 形状校验与"禁止合并就绪态"不变量。
 *
 * 本轮最吃重的负例是**合并就绪态必须被 schema 拒**：
 * 契约根对象与 `probe` 子对象都是 `additionalProperties: false`，
 * 因此 `ready: true` 这类汇总字段必须**直接非法**，而不是"被忽略"。
 */

import { describe, expect, it } from 'vitest';

import {
  READINESS_REPORT_ALLOWED_KEYS,
  READINESS_STATE_NAMES,
  assertManifest,
  assertSeparateReadinessStates,
  createManualClock,
  createTemplateLifecycle,
  isTemplateError,
  validateManifest,
  type ReadinessReport,
} from '../../../apps/mobile-kernel/templates/index.js';
import { baseHost, baseManifest, expectTemplateError, fixtureProbe } from './fixtures.js';

function issuePaths(input: unknown): string[] {
  return validateManifest(input).issues.map((issue) => `${issue.path}:${issue.code}`);
}

describe('K06 正例：标准 manifest 通过校验，且**不是**恒拒', () => {
  it('合法 manifest 0 条问题，assertManifest 不抛且返回同一对象', () => {
    const manifest = baseManifest();
    const result = validateManifest(manifest);
    // 正向对照：若校验器恒拒，这条会红——说明负例是空壳。
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(assertManifest(manifest)).toBe(manifest);
  });
});

describe('K06 负例①：合并就绪态被 schema 直接拒（根对象 additionalProperties=false）', () => {
  it('根对象多出 ready 汇总布尔 ⇒ manifest_invalid，直指 $.ready', () => {
    const merged = { ...baseManifest(), ready: true };
    const paths = issuePaths(merged);
    expect(paths).toContain('$.ready:unknown_field');
    expectTemplateError(() => assertManifest(merged), 'manifest_invalid');
  });

  it('probe 子对象多出 ready 汇总布尔 ⇒ manifest_invalid，直指 $.probe.ready', () => {
    const probe = { ...baseManifest().probe, ready: true };
    const merged = { ...baseManifest(), probe };
    expect(issuePaths(merged)).toContain('$.probe.ready:unknown_field');
    expectTemplateError(() => assertManifest(merged), 'manifest_invalid');
  });

  it('把四态压成单个 ready 布尔（删掉四个独立态）⇒ 四个 missing_required 一起报', () => {
    const merged = {
      ...baseManifest(),
      probe: { ready: true, verificationMode: 'fixture', layers: ['unit'] },
    };
    const paths = issuePaths(merged);
    for (const name of READINESS_STATE_NAMES) {
      expect(paths).toContain(`$.probe.${name}:missing_required`);
    }
    expectTemplateError(() => assertManifest(merged), 'manifest_invalid');
  });

  it('probe 的某个态是裸布尔以外的形状也不行（state 必须是 boolean）', () => {
    const merged = {
      ...baseManifest(),
      probe: { ...baseManifest().probe, installed: { state: 'ready' } },
    };
    expect(issuePaths(merged)).toContain('$.probe.installed:wrong_type');
  });
});

describe('K06 负例②：逐字段的 schema 约束（每条都配正向对照）', () => {
  it('缺必需字段 ⇒ missing_required', () => {
    const { capabilities, ...withoutCapabilities } = baseManifest();
    void capabilities;
    expect(issuePaths(withoutCapabilities)).toContain('$.capabilities:missing_required');
  });

  it('version 不匹配 ^\\d+\\.\\d+\\.\\d+$ ⇒ pattern_mismatch', () => {
    expect(issuePaths(baseManifest({ version: '1.0' }))).toContain('$.version:pattern_mismatch');
    // 正向对照：三段式版本合法
    expect(validateManifest(baseManifest({ version: '12.34.56' })).ok).toBe(true);
  });

  it('capabilities 空数组 ⇒ empty_array（契约 minItems: 1）', () => {
    expect(issuePaths(baseManifest({ capabilities: [] }))).toContain('$.capabilities:empty_array');
  });

  it('permissions 取 enum 外取值 ⇒ invalid_value', () => {
    const manifest = baseManifest();
    const bad = { ...manifest, permissions: ['network', 'sms'] };
    expect(issuePaths(bad)).toContain('$.permissions[1]:invalid_value');
  });

  it('runtimeCompatibility：os 非 android / minimumOs=0 / runtimes 空 ⇒ 三个问题同时报', () => {
    const manifest = baseManifest();
    const bad = {
      ...manifest,
      runtimeCompatibility: { os: 'ios', minimumOs: 0, runtimes: [], abis: ['arm64-v8a'] },
    };
    const paths = issuePaths(bad);
    expect(paths).toContain('$.runtimeCompatibility.os:invalid_value');
    expect(paths).toContain('$.runtimeCompatibility.minimumOs:out_of_range');
    expect(paths).toContain('$.runtimeCompatibility.runtimes:empty_array');
  });

  it('runtimeCompatibility 多余字段 ⇒ unknown_field', () => {
    const manifest = baseManifest();
    const bad = {
      ...manifest,
      runtimeCompatibility: { ...manifest.runtimeCompatibility, gpu: 'adreno' },
    };
    expect(issuePaths(bad)).toContain('$.runtimeCompatibility.gpu:unknown_field');
  });

  it('migration：strategy 非枚举 / 缺 to ⇒ invalid_value + missing_required', () => {
    const manifest = baseManifest();
    const bad = { ...manifest, migration: { from: '1.0.0', strategy: 'merge', reversible: true } };
    const paths = issuePaths(bad);
    expect(paths).toContain('$.migration.strategy:invalid_value');
    expect(paths).toContain('$.migration.to:missing_required');
  });

  it('probe.layers 空数组 ⇒ empty_array（verify 层不得为空）', () => {
    const manifest = baseManifest();
    const bad = { ...manifest, probe: { ...manifest.probe, layers: [] } };
    expect(issuePaths(bad)).toContain('$.probe.layers:empty_array');
  });

  it('id 超长（>128）⇒ out_of_range', () => {
    expect(issuePaths(baseManifest({ id: 'x'.repeat(129) }))).toContain('$.id:out_of_range');
  });
});

describe('K06 负例③：运行期就绪报告不得被压成单布尔', () => {
  it('真实报告通过；手工合并版（多 ready 字段 / 裸布尔态）一律 merged_readiness_forbidden', async () => {
    const clock = createManualClock(0);
    const lifecycle = createTemplateLifecycle({ clock, host: baseHost(), probe: fixtureProbe() });
    lifecycle.install(baseManifest());
    lifecycle.enable('meituan');
    lifecycle.authorize('meituan', undefined, ['network', 'external-order']);

    const report = await lifecycle.reportReadiness('meituan');
    expect(() => assertSeparateReadinessStates(report)).not.toThrow();
    // 报告里恰好是四态 + 身份 + 版本，没有汇总布尔
    expect(Object.keys(report).sort()).toEqual([...READINESS_REPORT_ALLOWED_KEYS].sort());
    expect(READINESS_REPORT_ALLOWED_KEYS).not.toContain('ready');

    const merged = { ...report, ready: true };
    expect(() => assertSeparateReadinessStates(merged)).toThrowError(/merged_readiness_forbidden/);

    const booleanised = { ...report, installed: true } as unknown as ReadinessReport;
    expect(() => assertSeparateReadinessStates(booleanised)).toThrowError(/merged_readiness_forbidden/);
  });

  it('not-ready 时缺 reason 也是非法（原因不得被悄悄丢掉）', async () => {
    const clock = createManualClock(0);
    const lifecycle = createTemplateLifecycle({ clock, host: baseHost(), probe: fixtureProbe() });
    lifecycle.install(baseManifest());
    const report = await lifecycle.reportReadiness('meituan');
    expect(report.enabled.state).toBe('not-ready');

    const reasonless = {
      ...report,
      enabled: { state: 'not-ready', reason: null, evidenceRef: null, checkedAt: 0 },
    };
    expect(() => assertSeparateReadinessStates(reasonless)).toThrowError(/merged_readiness_forbidden/);
  });

  it('isTemplateError 能识别抛出的错误（守卫本身不是空壳）', () => {
    const caught = expectTemplateError(
      () => assertManifest({ ...baseManifest(), ready: true }),
      'manifest_invalid',
    );
    expect(isTemplateError(caught)).toBe(true);
    expect(isTemplateError({ code: 'not_a_real_code' })).toBe(false);
  });
});

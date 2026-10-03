/**
 * APP-07（授权 / 设置）纯逻辑判据 —— 打在**线上那一份** `settings-model.js` 上。
 *
 * 三条硬要求：
 *   ① 撤销语义：撤销的是**本应用今后的使用权**，**不得**让人以为已发生的外部副作用被回滚（R205）；
 *   ② 连接与额度：**「已配置」≠「已实测通过」**；电脑端没上报额度就写「未知」，**不写 0**；
 *   ③ 密钥：形态能被抓出、能被脱敏，且**模块自身源码不含任何密钥形态**（否则断言恒真）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadWebGlobal, WEB_DIR } from './harness.js';

interface Finding { readonly id: string; readonly label: string; readonly index: number; readonly preview: string }

interface SettingsModel {
  AUTHORIZATION_STATES: Record<string, string>;
  AUTHORIZATION_ENTRIES: ReadonlyArray<{ id: string; label: string; revocable: boolean; systemPath: string }>;
  STATE_LABEL: Record<string, string>;
  REVOKE_NOTE: string;
  SECRET_POLICY_NOTE: string;
  createAuthorizationRegistry(initial?: unknown): {
    entries(): Array<{ id: string; state: string; canRevoke: boolean; note: string; stateLabel: string }>;
    stateOf(id: string): string | null;
    granted(): unknown[];
    request(id: string): { ok: boolean };
    grant(id: string): { ok: boolean };
    deny(id: string): { ok: boolean };
    revoke(id: string): { ok: boolean; code: string; note: string; entry: { label: string } | null };
  };
  connectionSummary(input: unknown): { rows: Array<{ key: string; label: string; value: string }>; note: string };
  quotaSummary(input: unknown): { known: boolean; rows: Array<{ key: string; value: string }>; note: string };
  storageSummary(input: unknown): { rows: Array<{ key: string; value: string }>; note: string };
  formatBytes(value: unknown): string;
  actionForError(code: unknown): { code: string; title: string; action: string; retryable: boolean };
  findSecrets(text: unknown): Finding[];
  redactSecrets(text: unknown): string;
  assertNoSecrets(text: unknown): { ok: boolean; findings: Finding[] };
  maskToken(token: unknown): string;
}

const S = loadWebGlobal<SettingsModel>('settings-model.js', 'PotbotSettingsModel');

/* 测试样本：**只在本测试文件里**拼装，避免进入被测源码。 */
const SAMPLE_VENDOR_KEY = 'sk' + '-' + 'abcdefghijklmnop0123';
const SAMPLE_AUTH_HEADER = 'Be' + 'arer' + ' eyJhbGciOiJIUzI1NiJ9.abcdefghij';
const SAMPLE_ASSIGNED = 'api' + '_key' + ': "' + '0123456789abcdef"' + '';
const SAMPLE_PEM = '-----' + 'BEGIN RSA PRIVATE ' + 'KEY-----';

describe('APP-07 授权清单：默认未申请，不假定任何权限已拿到', () => {
  it('清单非空，且每项都写清系统里的去处', () => {
    expect(S.AUTHORIZATION_ENTRIES.length).toBeGreaterThanOrEqual(6);
    for (const entry of S.AUTHORIZATION_ENTRIES) {
      expect(entry.systemPath.length, `${entry.id} 应给出系统设置路径`).toBeGreaterThan(0);
    }
  });

  it('新建台账时全部是 not_requested', () => {
    const registry = S.createAuthorizationRegistry();
    for (const entry of registry.entries()) {
      expect(entry.state).toBe('not_requested');
      expect(entry.canRevoke).toBe(false);
    }
  });

  it('授予后可撤销；撤销后状态为 revoked 且不再可撤销', () => {
    const registry = S.createAuthorizationRegistry();
    expect(registry.grant('files').ok).toBe(true);
    expect(registry.entries().find((e) => e.id === 'files')?.canRevoke).toBe(true);
    const revoked = registry.revoke('files');
    expect(revoked.ok).toBe(true);
    expect(registry.stateOf('files')).toBe('revoked');
    expect(registry.entries().find((e) => e.id === 'files')?.canRevoke).toBe(false);
  });

  it('撤销的说明**明确说出没有撤销什么**（R205）', () => {
    const registry = S.createAuthorizationRegistry();
    registry.grant('storage');
    const revoked = registry.revoke('storage');
    expect(revoked.note).toContain('不会被撤回');
    expect(revoked.note).toContain('外部动作');
    expect(S.REVOKE_NOTE).toContain('R205');
  });

  it('重复撤销：幂等拒绝，不重复记一次', () => {
    const registry = S.createAuthorizationRegistry();
    registry.grant('clock');
    registry.revoke('clock');
    const again = registry.revoke('clock');
    expect(again.ok).toBe(false);
    expect(again.code).toBe('already_revoked');
  });

  it('不可撤销项（网络）拒绝并说明原因', () => {
    const registry = S.createAuthorizationRegistry();
    registry.grant('network');
    const result = registry.revoke('network');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('not_revocable');
    expect(result.note).toContain('系统设置');
  });

  it('未知 id / 未知状态被拒绝', () => {
    const registry = S.createAuthorizationRegistry();
    expect(registry.revoke('nonexistent').code).toBe('unknown_entry');
    expect(registry.request('files').ok).toBe(true);
  });
});

describe('APP-07 连接状态：已配置 ≠ 已实测通过', () => {
  it('两者分列两行，且未实测通过时不写"可用"', () => {
    const summary = S.connectionSummary({
      service: { origin: 'http://10.0.0.2:8787', reachable: true, configured: true, verified: false },
      account: { signedIn: false },
    });
    const configured = summary.rows.find((r) => r.key === 'model_configured');
    const verified = summary.rows.find((r) => r.key === 'model_verified');
    expect(configured?.value).toContain('是');
    expect(verified?.value).toContain('否');
    expect(summary.note).toContain('不是一回事');
  });

  it('字段缺失时如实写「未知」，不假设成功', () => {
    const summary = S.connectionSummary({});
    expect(summary.rows.find((r) => r.key === 'model_verified')?.value).toContain('未知');
    expect(summary.rows.find((r) => r.key === 'service_reachable')?.value).toBe('未知');
  });
});

describe('APP-07 额度与存储：没上报就是未知，绝不写 0', () => {
  it('没有额度数据 ⇒ known=false 且值是「未知」', () => {
    const quota = S.quotaSummary({});
    expect(quota.known).toBe(false);
    expect(quota.rows.every((r) => r.value === '未知')).toBe(true);
    expect(quota.note).toContain('未知');
  });

  it('反向对照：上报了数据 ⇒ known=true 且算出剩余', () => {
    const quota = S.quotaSummary({ quotaBytes: 1000, usedBytes: 250 });
    expect(quota.known).toBe(true);
    expect(quota.rows.find((r) => r.key === 'left')?.value).toBe('750 B');
  });

  it('formatBytes 对非法输入返回「未知」而不是 0', () => {
    expect(S.formatBytes(undefined)).toBe('未知');
    expect(S.formatBytes(null)).toBe('未知');
    expect(S.formatBytes('1024')).toBe('未知');
    expect(S.formatBytes(-5)).toBe('未知');
    expect(S.formatBytes(2048)).toBe('2.0 KB');
  });

  it('存储摘要：计数缺失写「未知」，且注明不影响电脑上的文件', () => {
    const storage = S.storageSummary({ records: 3, sessions: 2, files: null, bytes: null });
    expect(storage.rows.find((r) => r.key === 'files')?.value).toBe('未知 个');
    expect(storage.rows.find((r) => r.key === 'records')?.value).toBe('3 条');
    expect(storage.note).toContain('不会删除电脑上已生成的文件');
  });
});

describe('APP-07 错误 → 用户能采取的动作', () => {
  it('已知错误码给出可执行动作', () => {
    for (const code of ['network_unreachable', 'permission_denied', 'uri_revoked', 'stale_revision', 'storage_full']) {
      const info = S.actionForError(code);
      expect(info.code).toBe(code);
      expect(info.title.length).toBeGreaterThan(0);
      expect(info.action.length, `${code} 应给出动作`).toBeGreaterThan(0);
    }
  });

  it('未知错误码归到 unknown，仍给出动作而不是空串', () => {
    const info = S.actionForError('something_new');
    expect(info.code).toBe('unknown');
    expect(info.action.length).toBeGreaterThan(0);
    expect(info.retryable).toBe(true);
  });
});

describe('APP-07 密钥：能抓、能脱敏、自身源码干净', () => {
  it('能识别厂商密钥 / 授权头 / 赋值字面 / PEM 四种形态', () => {
    expect(S.findSecrets(SAMPLE_VENDOR_KEY).map((f) => f.id)).toContain('vendor_prefix_key');
    expect(S.findSecrets(SAMPLE_AUTH_HEADER).map((f) => f.id)).toContain('auth_header_token');
    expect(S.findSecrets(SAMPLE_ASSIGNED).map((f) => f.id)).toContain('assigned_secret');
    expect(S.findSecrets(SAMPLE_PEM).map((f) => f.id)).toContain('private_key_pem');
  });

  it('干净文本零命中（对照臂，防止扫描器恒真）', () => {
    expect(S.findSecrets('这是一段普通中文说明，讲的是读书会邀请函与季度报表。')).toEqual([]);
    expect(S.assertNoSecrets('task-status / task-stage 这类标识串不是密钥').ok).toBe(true);
  });

  it('preview 已打码：不把原文整段带出去', () => {
    const finding = S.findSecrets(SAMPLE_VENDOR_KEY)[0];
    expect(finding?.preview).not.toBe(SAMPLE_VENDOR_KEY);
    expect(finding?.preview).toContain('…');
  });

  it('redactSecrets 把形态换成占位符，且原文不再出现', () => {
    const redacted = S.redactSecrets('token=' + SAMPLE_VENDOR_KEY + ' end');
    expect(redacted).not.toContain(SAMPLE_VENDOR_KEY);
    expect(redacted).toContain('[已隐藏:');
  });

  it('**模块自身源码不含任何密钥形态**（否则上面的断言是空断言）', () => {
    const source = readFileSync(join(WEB_DIR, 'settings-model.js'), 'utf8');
    const findings = S.assertNoSecrets(source);
    expect(findings.findings, `settings-model.js 自命中：${JSON.stringify(findings.findings)}`).toEqual([]);
    expect(findings.ok).toBe(true);
  });
});

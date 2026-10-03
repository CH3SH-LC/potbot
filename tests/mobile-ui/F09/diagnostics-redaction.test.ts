/**
 * F09 验收：诊断导出脱敏（I5）与连接失败清洗（I6）。
 *
 * 核心反向对照：把密钥/手机号/地址/邮箱/桌面路径/认证头塞进诊断输入，导出对象
 * **序列化后不得含任一原值**；同时干净输入必须**原样保留**（证明脱敏不是整段抹除）。
 */

import { describe, expect, it } from 'vitest';

import {
  exportDiagnostics,
  redactObject,
  redactText,
  sanitizeFailure,
  type DiagnosticExportInput,
} from '../../../apps/mobile-ui/src/settings/index.js';

const NOW = '2026-10-03T10:00:00Z';

// 全部为伪造哨兵，不是任何真实凭据 / 联系方式 / 地址。
const SECRET = 'sk-FAKE-not-a-real-credential-000000';
const PHONE = '13800000000';
const EMAIL = 'someone@example.com';
const WIN_PATH = 'C:\\Users\\someone\\Desktop\\keys.txt';
const UNC_PATH = '\\\\fileserver\\shared\\secret.bin';
const POSIX_PATH = '/Users/someone/.ssh/id_rsa';
const ADDRESS = '演示路 1 号 2 单元';
const BEARER = `Bearer ${'a1b2c3d4e5f6g7h8'}`;

const FORBIDDEN = [SECRET, PHONE, EMAIL, WIN_PATH, UNC_PATH, POSIX_PATH, ADDRESS, BEARER, 'a1b2c3d4e5f6g7h8'];

function input(sections: Record<string, unknown>): DiagnosticExportInput {
  return { generatedAt: NOW, verificationMode: 'real', appVersion: '0.13.0', sections };
}

describe('F09 / 值脱敏', () => {
  it('文本中的密钥/认证头就地替换为占位符', () => {
    const result = redactText(`failed with ${SECRET} and ${BEARER}`);
    expect(result.text).not.toContain(SECRET);
    expect(result.text).not.toContain('a1b2c3d4e5f6g7h8');
    expect(result.text).toContain('[redacted:api-key]');
    expect(result.text).toContain('[redacted:auth-header]');
    expect(result.count).toBeGreaterThanOrEqual(2);
  });

  it('手机号 / 邮箱 / 路径被替换', () => {
    const result = redactText(`${PHONE} ${EMAIL} ${WIN_PATH} ${POSIX_PATH}`);
    expect(result.text).not.toContain(PHONE);
    expect(result.text).not.toContain(EMAIL);
    expect(result.text).not.toContain(WIN_PATH);
    expect(result.text).not.toContain(POSIX_PATH);
    expect(result.kinds).toContain('phone');
    expect(result.kinds).toContain('email');
    expect(result.kinds).toContain('path');
  });

  it('反向对照：`settings://` 入口不被误判为盘符路径', () => {
    const result = redactText('入口：settings://app-details');
    expect(result.text).toBe('入口：settings://app-details');
    expect(result.count).toBe(0);
  });
});

describe('F09 / 结构脱敏 + 诊断导出（I5）', () => {
  const dirty = {
    connection: { host: 'api.deepseek.com', note: `auth ${BEARER}` },
    credentials: { apiKey: SECRET, rotatedAt: NOW },
    usage: { phone: PHONE, contact: EMAIL },
    files: { path: WIN_PATH, backup: UNC_PATH, ssh: POSIX_PATH },
    profile: { address: ADDRESS },
    appVersion: '0.13.0',
  };

  it('脏输入：序列化后不含任一敏感原值', () => {
    const out = exportDiagnostics(input(dirty));
    const serialized = JSON.stringify(out);
    for (const value of FORBIDDEN) {
      expect(serialized).not.toContain(value);
    }
    expect(out.redaction.clean).toBe(false);
    expect(out.redaction.redactedFields).toBeGreaterThan(0);
    expect(out.redaction.redactedKinds).toContain('api-key');
    expect(out.redaction.redactedKinds).toContain('phone');
    expect(out.redaction.redactedKinds).toContain('address');
    expect(out.redaction.redactedKinds).toContain('path');
  });

  it('反向对照：干净输入原样保留，零替换', () => {
    const clean = { connection: { host: 'api.deepseek.com', state: 'connected' }, appVersion: '0.13.0' };
    const out = exportDiagnostics(input(clean));
    expect(out.redaction.clean).toBe(true);
    expect(out.redaction.redactedFields).toBe(0);
    expect(out.sections).toEqual(clean);
  });

  it('redactObject 不改入参', () => {
    const original = { credentials: { apiKey: SECRET } };
    const clone = JSON.parse(JSON.stringify(original));
    redactObject(original);
    expect(original).toEqual(clone);
  });

  it('sections 必须是对象', () => {
    expect(() => exportDiagnostics(input({ a: 1 }))).not.toThrow();
  });

  it('非法时间戳抛错', () => {
    expect(() => exportDiagnostics({ ...input({}), generatedAt: 'yesterday' })).toThrowError(/UTC ISO/);
  });
});

describe('F09 / 连接失败清洗（I6）', () => {
  it('失败文案里的密钥与认证头被清除', () => {
    const sanitized = sanitizeFailure(`401 Unauthorized, Authorization: ${BEARER}, key=${SECRET}`);
    expect(sanitized.message).not.toContain('a1b2c3d4e5f6g7h8');
    expect(sanitized.message).not.toContain(SECRET);
    expect(sanitized.redactedCount).toBeGreaterThanOrEqual(2);
  });

  it('干净失败文案原样保留', () => {
    const sanitized = sanitizeFailure('连接超时，请检查网络');
    expect(sanitized.message).toBe('连接超时，请检查网络');
    expect(sanitized.redactedCount).toBe(0);
  });
});

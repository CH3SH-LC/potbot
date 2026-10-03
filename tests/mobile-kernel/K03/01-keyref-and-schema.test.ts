/**
 * K03 独立验证 ①：keyRef 双重判据 + operation schema 与命令校验。
 *
 * 这些是纯函数判据，不需要端口；用它们先把"引用不能裹明文""命令形状必须显式登记"
 * 两条红线钉死，后续状态机用例才有一个可信的地基。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_KEY_REFS,
  KEY_KINDS,
  KEY_OP_STATUSES,
  KEY_STATES,
  SECURITY_ERROR_CODES,
  SECURITY_OPERATIONS,
  SECURITY_PAYLOAD_KEYS,
  SECURITY_TO_COMMAND_OPERATION,
  assertKeyRef,
  assertSecurityCommand,
  defaultKeyRef,
  isKeyRef,
  issueKeyRef,
  kindOfKeyRef,
  validateSecurityPayload,
} from '../../../apps/mobile-kernel/security/index.js';

import { expectSecurityError, FIXTURE_MODEL_SECRET } from './fixtures.js';

describe('K03 ① keyRef：形状 + 内容双重判据', () => {
  it('默认引用合法且能解析回种类', () => {
    for (const kind of KEY_KINDS) {
      const ref = DEFAULT_KEY_REFS[kind];
      expect(isKeyRef(ref)).toBe(true);
      expect(assertKeyRef(ref)).toBe(ref);
      expect(kindOfKeyRef(ref)).toBe(kind);
      expect(defaultKeyRef(kind)).toBe(ref);
    }
  });

  it('非引用形状（直接塞明文密钥）被拒为 invalid_key_ref', () => {
    expectSecurityError(() => assertKeyRef(FIXTURE_MODEL_SECRET), 'invalid_key_ref');
    expect(isKeyRef(FIXTURE_MODEL_SECRET)).toBe(false);
    expectSecurityError(() => assertKeyRef(''), 'invalid_key_ref');
    expectSecurityError(() => assertKeyRef('keyref:has space'), 'invalid_key_ref');
  });

  it('形状像引用、内容是明文（keyref:sk-...）被拒为 key_ref_contains_secret', () => {
    const disguised = `keyref:${FIXTURE_MODEL_SECRET}`;
    expect(isKeyRef(disguised)).toBe(true); // 形状合法
    expectSecurityError(() => assertKeyRef(disguised), 'key_ref_contains_secret'); // 内容判据抓住
  });

  it('发行 keyRef：别名先过形状，再过内容', () => {
    expect(issueKeyRef('model', 'deepseek-flash')).toBe('keyref:model.deepseek-flash');
    // 形状不过关 ⇒ invalid_key_ref_alias。
    expectSecurityError(() => issueKeyRef('model', 'Bad-Alias'), 'invalid_key_ref_alias');
    expectSecurityError(() => issueKeyRef('model', '_leading'), 'invalid_key_ref_alias');
    // 形状过关、内容像明文 ⇒ 第二道判据（key_ref_contains_secret）接住。
    expectSecurityError(() => issueKeyRef('model', FIXTURE_MODEL_SECRET), 'key_ref_contains_secret');
  });

  it('非法 kind 抛 invalid_key_kind', () => {
    expectSecurityError(() => issueKeyRef('other' as never, 'x'), 'invalid_key_kind');
    expectSecurityError(() => defaultKeyRef('other' as never), 'invalid_key_kind');
  });

  it('拒因词表自洽：关键码都在登记表里', () => {
    for (const code of ['invalid_key_ref', 'key_ref_contains_secret', 'plaintext_secret_in_output', 'backup_not_excluded', 'app_backup_enabled', 'key_already_present', 'revision_conflict', 'manifest_unreadable']) {
      expect(SECURITY_ERROR_CODES as readonly string[]).toContain(code);
    }
    expect(KEY_STATES).toEqual(['absent', 'active', 'blocked']);
    expect(KEY_OP_STATUSES).toEqual(['succeeded', 'failed', 'conflict']);
  });
});

describe('K03 ① operation schema：子操作 → 公共 operation 映射', () => {
  it('五个子操作都有映射，且落在公共命令词表内', () => {
    const commandOps = ['create', 'import', 'mutate', 'apply', 'export', 'undo', 'redo', 'preview', 'inspect', 'query', 'cancel'];
    expect(SECURITY_OPERATIONS).toEqual(['key.import', 'key.rotate', 'key.delete', 'key.status', 'key.recover']);
    for (const op of SECURITY_OPERATIONS) {
      expect(commandOps).toContain(SECURITY_TO_COMMAND_OPERATION[op]);
    }
    expect(SECURITY_TO_COMMAND_OPERATION['key.import']).toBe('import');
    expect(SECURITY_TO_COMMAND_OPERATION['key.rotate']).toBe('mutate');
    expect(SECURITY_TO_COMMAND_OPERATION['key.delete']).toBe('mutate');
    expect(SECURITY_TO_COMMAND_OPERATION['key.status']).toBe('inspect');
    expect(SECURITY_TO_COMMAND_OPERATION['key.recover']).toBe('inspect');
  });

  it('mutation 分支强制 expectedRevision', () => {
    const noRev = validateSecurityPayload('key.delete', { operation: 'key.delete', kind: 'model' });
    expect(noRev.ok).toBe(false);
    expect(noRev.errors.join('；')).toContain('expectedRevision');

    const ok = validateSecurityPayload('key.delete', { operation: 'key.delete', kind: 'model', expectedRevision: 3 });
    expect(ok.ok).toBe(true);
  });

  it('写操作强制 sourceRef；未知键被拒（additionalProperties:false 等价物）', () => {
    expect(validateSecurityPayload('key.import', { operation: 'key.import', kind: 'model' }).ok).toBe(false);
    expect(validateSecurityPayload('key.import', { operation: 'key.import', kind: 'model', sourceRef: 'import-1' }).ok).toBe(true);
    const extra = validateSecurityPayload('key.status', { operation: 'key.status', kind: 'model', secret: 'x' });
    expect(extra.ok).toBe(false);
    expect(extra.errors.join('；')).toContain('未知键');
  });

  it('payload 里误塞明文密钥被拒（明文红线）', () => {
    const bad = validateSecurityPayload('key.import', {
      operation: 'key.import',
      kind: 'model',
      sourceRef: 'import-1',
      keyRef: `keyref:${FIXTURE_MODEL_SECRET}`,
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join('；')).toContain('明文密钥特征');
  });
});

describe('K03 ① 公共命令校验：整条命令', () => {
  function command(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: 'mobile-v1',
      commandId: 'cmd-1',
      operation: 'import',
      idempotencyKey: 'idem-1',
      payload: { operation: 'key.import', kind: 'model', sourceRef: 'import-1' },
      ...overrides,
    };
  }

  it('合法命令解析出子操作', () => {
    expect(assertSecurityCommand(command())).toBe('key.import');
  });

  it('schemaVersion 不符 / 缺字段 ⇒ invalid_command', () => {
    expectSecurityError(() => assertSecurityCommand(command({ schemaVersion: 'v2' })), 'invalid_command');
    expectSecurityError(() => assertSecurityCommand(command({ commandId: '' })), 'invalid_command');
  });

  it('command.operation 与子操作映射不符 ⇒ operation_mismatch', () => {
    expectSecurityError(() => assertSecurityCommand(command({ operation: 'mutate' })), 'operation_mismatch');
  });

  it('payload.operation 不在词表 ⇒ unsupported_operation', () => {
    expectSecurityError(
      () => assertSecurityCommand(command({ payload: { operation: 'key.exfiltrate', kind: 'model' } })),
      'unsupported_operation',
    );
  });

  it('payload 出现明文 ⇒ 明文红线（不回显原文）', () => {
    expectSecurityError(
      () => assertSecurityCommand(command({ payload: { operation: 'key.import', kind: 'model', sourceRef: `sk-${FIXTURE_MODEL_SECRET}` } })),
      'invalid_command',
    );
  });

  it('每个子操作的 payloadKeys 都含 operation 且被 schema 常量登记', () => {
    for (const op of SECURITY_OPERATIONS) {
      expect(SECURITY_PAYLOAD_KEYS[op]).toContain('operation');
    }
  });
});

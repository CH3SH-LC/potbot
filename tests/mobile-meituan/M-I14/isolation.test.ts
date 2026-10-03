/**
 * M-I14 / 凭证隔离：明文形值被拒且**零回显**；未知字段被拒而非静默忽略；用途不串用。
 *
 * `SECRET_SHAPED` 是**形状像凭据的假值**（测试面专属，非真实密钥），用它证明
 * 「误把明文当引用」被挡住。
 */

import { describe, expect, it } from 'vitest';

import {
  CREDENTIAL_BOUNDARY,
  CredentialError,
  KEY_REF_PATTERN,
  type CredentialView,
} from '../../../src/mobile-plugins/meituan/credential-isolation/index.js';
import {
  ACCOUNT_A,
  KEY_A,
  KEY_DEEPSEEK,
  SCOPE_READ,
  SCOPE_SUBMIT,
  SECRET_SHAPED,
  T0,
  TTL_MS,
  makeScenario,
} from './support.js';

/** 深度收集对象图里所有字符串（用于断言"秘密没有出现"）。 */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, out);
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, out);
    }
  }
  return out;
}

describe('M-I14 明文形值被拒且不回显', () => {
  it('把明文当 keyRef 入库被拒，错误消息与序列化都不含该值', () => {
    const { vault } = makeScenario();
    let caught: unknown;
    try {
      vault.importCredential({
        keyRef: SECRET_SHAPED,
        accountRef: ACCOUNT_A,
        provider: 'meituan',
        scopes: [SCOPE_READ],
        issuedAt: T0,
        expiresAt: T0 + TTL_MS,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CredentialError);
    expect((caught as Error).message).not.toContain(SECRET_SHAPED);
    expect(JSON.stringify(caught)).not.toContain(SECRET_SHAPED);
  });

  it('authorize 收到明文形 keyRef => invalid_key_ref，审计只记占位符', () => {
    const { vault } = makeScenario();
    const decision = vault.authorize({
      keyRef: SECRET_SHAPED,
      accountRef: ACCOUNT_A,
      provider: 'meituan',
      requiredScope: SCOPE_READ,
      now: T0 + 1,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('invalid_key_ref');
      expect(decision.keyRef).toBe('<invalid-key-ref>');
    }
    expect(collectStrings(vault.auditLog())).not.toContain(SECRET_SHAPED);
  });

  it('authorize 收到明文形 accountRef => invalid_account_ref，且不落审计', () => {
    const { vault } = makeScenario();
    const decision = vault.authorize({
      keyRef: KEY_A,
      accountRef: SECRET_SHAPED,
      provider: 'meituan',
      requiredScope: SCOPE_READ,
      now: T0 + 1,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('invalid_account_ref');
    }
    expect(collectStrings(vault.auditLog())).not.toContain(SECRET_SHAPED);
  });

  it('keyRef 形状：非 keyref: 前缀一律不匹配', () => {
    expect(KEY_REF_PATTERN.test(KEY_A)).toBe(true);
    expect(KEY_REF_PATTERN.test(SECRET_SHAPED)).toBe(false);
    expect(KEY_REF_PATTERN.test('keyref:has space')).toBe(false);
  });
});

describe('M-I14 未知字段被拒（不静默忽略）', () => {
  it('secret / token / password / plaintext 未声明字段 => 抛错', () => {
    const { vault } = makeScenario();
    for (const extraKey of ['secret', 'token', 'password', 'plaintext']) {
      expect(() =>
        vault.importCredential({
          keyRef: 'keyref:mt:user-a:cred-x',
          accountRef: ACCOUNT_A,
          provider: 'meituan',
          scopes: [SCOPE_READ],
          issuedAt: T0,
          expiresAt: T0 + TTL_MS,
          [extraKey]: SECRET_SHAPED,
        } as never),
      ).toThrowError(CredentialError);
    }
  });

  it('未声明字段的错误码是 unknown_field，且不回显键值', () => {
    const { vault } = makeScenario();
    let caught: unknown;
    try {
      vault.importCredential({
        keyRef: 'keyref:mt:user-a:cred-x',
        accountRef: ACCOUNT_A,
        provider: 'meituan',
        scopes: [SCOPE_READ],
        issuedAt: T0,
        expiresAt: T0 + TTL_MS,
        secret: SECRET_SHAPED,
      } as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CredentialError);
    expect((caught as CredentialError).code).toBe('unknown_field');
    expect((caught as Error).message).not.toContain(SECRET_SHAPED);
  });

  it('CredentialView 字段集合固定，没有秘密落点', () => {
    const { vault } = makeScenario();
    const view: CredentialView = vault.importCredential({
      keyRef: 'keyref:mt:user-a:cred-9',
      accountRef: ACCOUNT_A,
      provider: 'meituan',
      scopes: [SCOPE_READ],
      issuedAt: T0,
      expiresAt: T0 + TTL_MS,
    });
    expect(Object.keys(view).sort()).toEqual(
      ['accountRef', 'expiresAt', 'installId', 'issuedAt', 'keyRef', 'provider', 'revokedAt', 'scopes'].sort(),
    );
  });
});

describe('M-I14 用途隔离与边界常量', () => {
  it('模型 key 不能用于美团动作 => provider_mismatch', () => {
    const { vault } = makeScenario();
    vault.importCredential({
      keyRef: KEY_DEEPSEEK,
      accountRef: ACCOUNT_A,
      provider: 'deepseek',
      scopes: [SCOPE_SUBMIT],
      issuedAt: T0,
      expiresAt: T0 + TTL_MS,
    });
    const decision = vault.authorize({
      keyRef: KEY_DEEPSEEK,
      accountRef: ACCOUNT_A,
      provider: 'meituan',
      requiredScope: SCOPE_SUBMIT,
      now: T0 + 1,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('provider_mismatch');
    }
  });

  it('边界常量恒为假（无明文入口、无网络、未接密钥库）', () => {
    expect(CREDENTIAL_BOUNDARY.acceptsPlaintextSecret).toBe(false);
    expect(CREDENTIAL_BOUNDARY.hasRealNetworkCall).toBe(false);
    expect(CREDENTIAL_BOUNDARY.connectsRealKeystore).toBe(false);
    expect(CREDENTIAL_BOUNDARY.verificationMode).toBe('fixture');
  });
});

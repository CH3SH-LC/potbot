/**
 * M-R05 / 凭证生命周期：撤销、过期、未生效、轮换。
 *
 * 断言的是"判定按当前时钟重算"，不是"记住上一次通过"。
 */

import { describe, expect, it } from 'vitest';
import { CredentialError } from './credential-isolation.js';
import {
  KEY_A,
  KEY_A_ROTATED,
  SCOPE_READ,
  SCOPE_SUBMIT,
  T0,
  TTL_MS,
  ACCOUNT_A,
  makeScenario,
} from './support.js';

const EXPIRES = T0 + TTL_MS;

function authorizeKeyA(vault: ReturnType<typeof makeScenario>['vault'], now: number) {
  return vault.authorize({
    keyRef: KEY_A,
    accountRef: ACCOUNT_A,
    provider: 'meituan',
    requiredScope: SCOPE_READ,
    now,
  });
}

describe('M-R05 有效期判定', () => {
  it('签发时刻之前是 not_yet_valid，不能提前使用', () => {
    const { vault } = makeScenario();
    expect(vault.statusOf(KEY_A, T0 - 1)).toBe('not_yet_valid');
    const decision = authorizeKeyA(vault, T0 - 1);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('not_yet_valid');
    }
  });

  it('有效期内是 active 且放行', () => {
    const { vault } = makeScenario();
    expect(vault.statusOf(KEY_A, T0 + 1)).toBe('active');
    const decision = authorizeKeyA(vault, T0 + 1);
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.grant.keyRef).toBe(KEY_A);
      expect(decision.grant.accountRef).toBe(ACCOUNT_A);
      expect(decision.grant.expiresAt).toBe(EXPIRES);
    }
  });

  it('到期边界：now === expiresAt 即 expired（到期为开区间上界）', () => {
    const { vault } = makeScenario();
    expect(vault.statusOf(KEY_A, EXPIRES - 1)).toBe('active');
    expect(vault.statusOf(KEY_A, EXPIRES)).toBe('expired');
    const decision = authorizeKeyA(vault, EXPIRES);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('expired');
    }
  });
});

describe('M-R05 撤销', () => {
  it('撤销后立即拒绝，且按 now 重算（此前通过不缓存）', () => {
    const { vault } = makeScenario();
    expect(authorizeKeyA(vault, T0 + 10).allowed).toBe(true);
    vault.revoke(KEY_A, T0 + 20);
    expect(vault.statusOf(KEY_A, T0 + 21)).toBe('revoked');
    const decision = authorizeKeyA(vault, T0 + 21);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('revoked');
    }
  });

  it('撤销幂等：重复撤销保留首次撤销时刻', () => {
    const { vault } = makeScenario();
    const first = vault.revoke(KEY_A, T0 + 20);
    const second = vault.revoke(KEY_A, T0 + 999);
    expect(first.revokedAt).toBe(T0 + 20);
    expect(second.revokedAt).toBe(T0 + 20);
  });

  it('撤销优先于过期：即使已过期，报告 revoked', () => {
    const { vault } = makeScenario();
    vault.revoke(KEY_A, T0 + 5);
    expect(vault.statusOf(KEY_A, EXPIRES + 10_000)).toBe('revoked');
    const decision = authorizeKeyA(vault, EXPIRES + 10_000);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('revoked');
    }
  });

  it('撤销未知 keyRef 抛 unknown_key', () => {
    const { vault } = makeScenario();
    expect(() => vault.revoke(KEY_A_ROTATED, T0)).toThrowError(CredentialError);
  });
});

describe('M-R05 轮换', () => {
  it('轮换后旧引用被撤销、新引用可用，账号/用途/范围承接', () => {
    const { vault } = makeScenario();
    const { old: oldView, next: nextView } = vault.rotate(
      KEY_A,
      { newKeyRef: KEY_A_ROTATED, issuedAt: T0 + TTL_MS, expiresAt: T0 + 2 * TTL_MS },
      T0 + TTL_MS,
    );
    expect(oldView.revokedAt).toBe(T0 + TTL_MS);
    expect(nextView.accountRef).toBe(ACCOUNT_A);
    expect([...nextView.scopes]).toEqual([SCOPE_READ, SCOPE_SUBMIT]);

    const oldDecision = vault.authorize({
      keyRef: KEY_A,
      accountRef: ACCOUNT_A,
      provider: 'meituan',
      requiredScope: SCOPE_READ,
      now: T0 + TTL_MS + 1,
    });
    expect(oldDecision.allowed).toBe(false);
    if (!oldDecision.allowed) {
      expect(oldDecision.reason).toBe('revoked');
    }

    const newDecision = vault.authorize({
      keyRef: KEY_A_ROTATED,
      accountRef: ACCOUNT_A,
      provider: 'meituan',
      requiredScope: SCOPE_SUBMIT,
      now: T0 + TTL_MS + 1,
    });
    expect(newDecision.allowed).toBe(true);
  });
});

describe('M-R05 重复入库', () => {
  it('同 keyRef 二次入库被拒（不得静默覆盖）', () => {
    const { vault } = makeScenario();
    expect(() =>
      vault.importCredential({
        keyRef: KEY_A,
        accountRef: ACCOUNT_A,
        provider: 'meituan',
        scopes: [SCOPE_READ],
        issuedAt: T0,
        expiresAt: T0 + TTL_MS,
      }),
    ).toThrowError(CredentialError);
  });

  it('有效期非正被拒', () => {
    const { vault } = makeScenario();
    expect(() =>
      vault.importCredential({
        keyRef: 'keyref:mt:user-a:bad',
        accountRef: ACCOUNT_A,
        provider: 'meituan',
        scopes: [SCOPE_READ],
        issuedAt: T0,
        expiresAt: T0,
      }),
    ).toThrowError(CredentialError);
  });
});

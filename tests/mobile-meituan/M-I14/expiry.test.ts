/**
 * M-I14 / 有效期与撤销：到期为**开区间上界**、撤销**优先于**过期。
 *
 * import **生产路径**（`src/mobile-plugins/meituan/credential-isolation`）。
 */

import { describe, expect, it } from 'vitest';

import { CredentialVault } from '../../../src/mobile-plugins/meituan/credential-isolation/index.js';
import { ACCOUNT_A, KEY_A, SCOPE_READ, T0, TTL_MS, makeScenario } from './support.js';

const EXPIRES = T0 + TTL_MS;

function authorizeAt(vault: CredentialVault, now: number) {
  return vault.authorize({
    keyRef: KEY_A,
    accountRef: ACCOUNT_A,
    provider: 'meituan',
    requiredScope: SCOPE_READ,
    now,
  });
}

describe('M-I14 到期是开区间上界', () => {
  it('now === expiresAt 判为 expired（不是 active）', () => {
    const { vault } = makeScenario();
    expect(vault.statusOf(KEY_A, EXPIRES - 1)).toBe('active');
    expect(vault.statusOf(KEY_A, EXPIRES)).toBe('expired');
    const decision = authorizeAt(vault, EXPIRES);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('expired');
    }
  });

  it('到期前一刻仍放行', () => {
    const { vault } = makeScenario();
    const decision = authorizeAt(vault, EXPIRES - 1);
    expect(decision.allowed).toBe(true);
  });

  it('签发时刻之前是 not_yet_valid', () => {
    const { vault } = makeScenario();
    expect(vault.statusOf(KEY_A, T0 - 1)).toBe('not_yet_valid');
    const decision = authorizeAt(vault, T0 - 1);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('not_yet_valid');
    }
  });
});

describe('M-I14 撤销优先于过期', () => {
  it('已撤销且已过期时报告 revoked（优先于 expired）', () => {
    const { vault } = makeScenario();
    vault.revoke(KEY_A, T0 + 5);
    expect(vault.statusOf(KEY_A, EXPIRES + 10_000)).toBe('revoked');
    const decision = authorizeAt(vault, EXPIRES + 10_000);
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

  it('撤销未知 keyRef 抛错（unknown_key 语义）', () => {
    const { vault } = makeScenario();
    expect(() => vault.revoke('keyref:mt:user-a:missing', T0)).toThrowError();
  });
});

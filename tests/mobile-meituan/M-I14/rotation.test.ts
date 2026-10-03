/**
 * M-I14 / 轮换：`rotate` 必须**撤销旧 keyRef**，新 keyRef 承接账号/用途/范围。
 */

import { describe, expect, it } from 'vitest';

import {
  CredentialError,
  type CredentialVault,
} from '../../../src/mobile-plugins/meituan/credential-isolation/index.js';
import {
  ACCOUNT_A,
  KEY_A,
  KEY_A_ROTATED,
  SCOPE_READ,
  SCOPE_SUBMIT,
  T0,
  TTL_MS,
  makeScenario,
} from './support.js';

describe('M-I14 轮换撤销旧引用', () => {
  it('rotate 后旧 keyRef 立即 revoked，新 keyRef 承接账号与范围', () => {
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

  it('轮换未知旧引用抛 CredentialError', () => {
    const { vault }: { vault: CredentialVault } = makeScenario();
    expect(() =>
      vault.rotate(
        KEY_A_ROTATED,
        { newKeyRef: 'keyref:mt:user-a:cred-9', issuedAt: T0, expiresAt: T0 + TTL_MS },
        T0 + 1,
      ),
    ).toThrowError(CredentialError);
  });
});

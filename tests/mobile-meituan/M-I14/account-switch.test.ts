/**
 * M-I14 / 账号绑定与切换：跨账号 keyRef 必须 `account_mismatch`；
 * 切换账号**单向失效**旧账号的待执行动作（切回不复活）。
 */

import { describe, expect, it } from 'vitest';

import { CredentialError } from '../../../src/mobile-plugins/meituan/credential-isolation/index.js';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  ACTION_1,
  ACTION_2,
  KEY_A,
  KEY_B,
  SCOPE_READ,
  SCOPE_SUBMIT,
  T0,
  TTL_MS,
  makeEmptyVault,
  makeScenario,
} from './support.js';

describe('M-I14 跨账号 keyRef 被拒', () => {
  it('A 账号 keyRef 执行 B 账号动作 => account_mismatch', () => {
    const { vault } = makeScenario();
    const decision = vault.authorize({
      keyRef: KEY_A,
      accountRef: ACCOUNT_B,
      provider: 'meituan',
      requiredScope: SCOPE_READ,
      now: T0 + 1,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('account_mismatch');
    }
  });

  it('两账号凭证并存时互不串用', () => {
    const { vault } = makeScenario();
    vault.importCredential({
      keyRef: KEY_B,
      accountRef: ACCOUNT_B,
      provider: 'meituan',
      scopes: [SCOPE_READ],
      issuedAt: T0,
      expiresAt: T0 + TTL_MS,
    });
    const wrong = vault.authorize({
      keyRef: KEY_B,
      accountRef: ACCOUNT_A,
      provider: 'meituan',
      requiredScope: SCOPE_READ,
      now: T0 + 1,
    });
    const right = vault.authorize({
      keyRef: KEY_B,
      accountRef: ACCOUNT_B,
      provider: 'meituan',
      requiredScope: SCOPE_READ,
      now: T0 + 1,
    });
    expect(wrong.allowed).toBe(false);
    expect(right.allowed).toBe(true);
  });
});

describe('M-I14 切换账号单向失效待执行动作', () => {
  it('切到 B 后 A 的 pending 动作被失效且不可消费', () => {
    const { vault } = makeScenario();
    vault.registerPendingAction({ actionRef: ACTION_1, keyRef: KEY_A, scope: SCOPE_SUBMIT, expiresAt: T0 + TTL_MS });
    expect(vault.getPendingAction(ACTION_1)?.state).toBe('pending');

    const result = vault.switchAccount(ACCOUNT_B, T0 + 10);
    expect(result.previousAccountRef).toBe(ACCOUNT_A);
    expect(result.activeAccountRef).toBe(ACCOUNT_B);
    expect([...result.invalidatedActionRefs]).toEqual([ACTION_1]);

    const action = vault.getPendingAction(ACTION_1);
    expect(action?.state).toBe('invalidated');
    expect(action?.invalidationReason).toBe('account_switched');

    const consumed = vault.consumePendingAction(ACTION_1, T0 + 11);
    expect(consumed.consumed).toBe(false);
    if (!consumed.consumed) {
      expect(consumed.reason).toBe('invalidated');
    }
  });

  it('切回原账号不复活已失效动作', () => {
    const { vault } = makeScenario();
    vault.registerPendingAction({ actionRef: ACTION_1, keyRef: KEY_A, scope: SCOPE_SUBMIT, expiresAt: T0 + TTL_MS });
    vault.switchAccount(ACCOUNT_B, T0 + 10);
    vault.switchAccount(ACCOUNT_A, T0 + 20);
    expect(vault.consumePendingAction(ACTION_1, T0 + 21).consumed).toBe(false);
  });

  it('新账号下登记的待执行动作只绑定新账号', () => {
    const { vault } = makeScenario();
    vault.switchAccount(ACCOUNT_B, T0 + 10);
    vault.importCredential({
      keyRef: KEY_B,
      accountRef: ACCOUNT_B,
      provider: 'meituan',
      scopes: [SCOPE_SUBMIT],
      issuedAt: T0,
      expiresAt: T0 + TTL_MS,
    });
    vault.registerPendingAction({ actionRef: ACTION_2, keyRef: KEY_B, scope: SCOPE_SUBMIT, expiresAt: T0 + TTL_MS });
    expect(vault.getPendingAction(ACTION_2)?.accountRef).toBe(ACCOUNT_B);
    expect(vault.consumePendingAction(ACTION_2, T0 + 11).consumed).toBe(true);
  });

  it('未选账号就登记动作被拒', () => {
    const empty = makeEmptyVault();
    expect(() =>
      empty.registerPendingAction({
        actionRef: 'action:mt:y',
        keyRef: KEY_A,
        scope: SCOPE_SUBMIT,
        expiresAt: T0 + TTL_MS,
      }),
    ).toThrowError(CredentialError);
  });
});

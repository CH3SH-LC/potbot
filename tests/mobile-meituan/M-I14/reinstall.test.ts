/**
 * M-I14 / 手机重装：清空 keyRefs、失效待执行动作、拒绝从备份恢复旧安装凭证。
 */

import { describe, expect, it } from 'vitest';

import { CredentialError } from '../../../src/mobile-plugins/meituan/credential-isolation/index.js';
import {
  ACCOUNT_A,
  ACTION_1,
  INSTALL_1,
  INSTALL_2,
  KEY_A,
  KEY_A_ROTATED,
  SCOPE_READ,
  SCOPE_SUBMIT,
  T0,
  TTL_MS,
  makeScenario,
} from './support.js';

describe('M-I14 重装清空 keyRefs', () => {
  it('重装后旧 keyRef 变 unknown 并拒绝授权', () => {
    const { vault } = makeScenario();
    expect(vault.statusOf(KEY_A, T0 + 1)).toBe('active');

    const result = vault.reinstall(INSTALL_2, T0 + 100);
    expect(result.previousInstallId).toBe(INSTALL_1);
    expect(result.installId).toBe(INSTALL_2);
    expect([...result.wipedKeyRefs]).toEqual([KEY_A]);

    expect(vault.statusOf(KEY_A, T0 + 101)).toBe('unknown');
    expect(vault.listKeyRefs()).toEqual([]);
    const decision = vault.authorize({
      keyRef: KEY_A,
      accountRef: ACCOUNT_A,
      provider: 'meituan',
      requiredScope: SCOPE_READ,
      now: T0 + 101,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('unknown_key');
    }
  });

  it('重装清空活跃账号并失效全部待执行动作', () => {
    const { vault } = makeScenario();
    vault.registerPendingAction({ actionRef: ACTION_1, keyRef: KEY_A, scope: SCOPE_SUBMIT, expiresAt: T0 + TTL_MS });

    const result = vault.reinstall(INSTALL_2, T0 + 100);
    expect([...result.invalidatedActionRefs]).toEqual([ACTION_1]);
    expect(vault.activeAccountRef).toBeNull();

    const action = vault.getPendingAction(ACTION_1);
    expect(action?.state).toBe('invalidated');
    expect(action?.invalidationReason).toBe('reinstalled');
    expect(vault.consumePendingAction(ACTION_1, T0 + 101).consumed).toBe(false);
  });

  it('重装必须换 installId（同值即拒）', () => {
    const { vault } = makeScenario();
    expect(() => vault.reinstall(INSTALL_1, T0 + 100)).toThrowError(CredentialError);
  });

  it('拒绝从备份恢复旧安装凭证（stale_install），库仍为空', () => {
    const { vault } = makeScenario();
    vault.reinstall(INSTALL_2, T0 + 100);
    expect(() =>
      vault.importCredential({
        keyRef: KEY_A,
        accountRef: ACCOUNT_A,
        provider: 'meituan',
        scopes: [SCOPE_READ],
        issuedAt: T0,
        expiresAt: T0 + TTL_MS,
        installId: INSTALL_1,
      }),
    ).toThrowError(CredentialError);
    expect(vault.listKeyRefs()).toEqual([]);
  });

  it('重装后重新导入新引用才恢复可用', () => {
    const { vault } = makeScenario();
    vault.reinstall(INSTALL_2, T0 + 100);
    vault.switchAccount(ACCOUNT_A, T0 + 101);
    vault.importCredential({
      keyRef: KEY_A_ROTATED,
      accountRef: ACCOUNT_A,
      provider: 'meituan',
      scopes: [SCOPE_READ],
      issuedAt: T0 + 101,
      expiresAt: T0 + 101 + TTL_MS,
    });
    const decision = vault.authorize({
      keyRef: KEY_A_ROTATED,
      accountRef: ACCOUNT_A,
      provider: 'meituan',
      requiredScope: SCOPE_READ,
      now: T0 + 102,
    });
    expect(decision.allowed).toBe(true);
  });
});

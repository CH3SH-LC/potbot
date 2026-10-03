/**
 * M-I24 / 断言 (d)：换账号**单向失效**旧账号的待执行动作；且账号绑定一直走到传输层
 * ——拿 A 账号的 keyRef 为 B 账号动作取凭证必然 `account_mismatch`（`credential_missing`，
 * 零端口调用）。
 */

import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_B,
  ACTION_1,
  ACTION_2,
  KEY_B,
} from '../../../src/mobile-plugins/meituan/credential-isolation/index.js';

import {
  ACCOUNT_A,
  buildStack,
  descriptor,
  expectFailure,
  KEY_A,
  makeVault,
  openStackSession,
  SCOPE_READ,
  T0,
  TTL_MS,
} from './support.js';

describe('M-I24 换账号使待执行动作失效', () => {
  it('切换账号失效旧账号的待执行动作，且失败态不可消费', () => {
    const vault = makeVault();
    vault.registerPendingAction({
      actionRef: ACTION_1,
      keyRef: KEY_A,
      scope: SCOPE_READ,
      expiresAt: T0 + TTL_MS,
    });
    expect(vault.getPendingAction(ACTION_1)?.state).toBe('pending');

    const switched = vault.switchAccount(ACCOUNT_B, T0 + 10);
    expect(switched.previousAccountRef).toBe(ACCOUNT_A);
    expect(switched.activeAccountRef).toBe(ACCOUNT_B);
    expect(switched.invalidatedActionRefs).toContain(ACTION_1);

    const view = vault.getPendingAction(ACTION_1);
    expect(view?.state).toBe('invalidated');
    expect(view?.invalidationReason).toBe('account_switched');
    expect(vault.consumePendingAction(ACTION_1, T0 + 11)).toEqual({
      consumed: false,
      reason: 'invalidated',
    });
  });

  it('切回原账号不复活已失效动作（单向）', () => {
    const vault = makeVault();
    vault.registerPendingAction({
      actionRef: ACTION_1,
      keyRef: KEY_A,
      scope: SCOPE_READ,
      expiresAt: T0 + TTL_MS,
    });
    vault.switchAccount(ACCOUNT_B, T0 + 10);
    vault.switchAccount(ACCOUNT_A, T0 + 20);
    expect(vault.getPendingAction(ACTION_1)?.state).toBe('invalidated');
    expect(vault.consumePendingAction(ACTION_1, T0 + 21).consumed).toBe(false);
  });

  it('账号绑定到达传输层：A 的 keyRef 用于 B 账号 ⇒ account_mismatch，零端口调用', async () => {
    const stack = buildStack({ context: { accountRef: ACCOUNT_B, now: T0 + 1 } });
    await openStackSession(stack);

    const outcome = expectFailure(await stack.client.invoke(descriptor({ keyRef: KEY_A }), T0 + 1));
    expect(outcome.failureKind).toBe('credential_missing');
    expect(stack.resolver.lastDenyReason()).toBe('account_mismatch');
    expect(stack.transport.callCount()).toBe(0);
    expect(outcome.network.transport).toBe('not_sent');
  });

  it('双向隔离：B 的新待执行动作在切回 A 时同样失效', () => {
    const vault = makeVault();
    vault.importCredential({
      keyRef: KEY_B,
      accountRef: ACCOUNT_B,
      provider: 'meituan',
      scopes: [SCOPE_READ],
      issuedAt: T0,
      expiresAt: T0 + TTL_MS,
    });
    vault.switchAccount(ACCOUNT_B, T0 + 10);
    vault.registerPendingAction({
      actionRef: ACTION_2,
      keyRef: KEY_B,
      scope: SCOPE_READ,
      expiresAt: T0 + TTL_MS,
    });
    expect(vault.getPendingAction(ACTION_2)?.state).toBe('pending');

    const switched = vault.switchAccount(ACCOUNT_A, T0 + 20);
    expect(switched.invalidatedActionRefs).toContain(ACTION_2);
    expect(vault.getPendingAction(ACTION_2)?.invalidationReason).toBe('account_switched');
  });
});

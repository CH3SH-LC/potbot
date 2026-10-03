/**
 * M02 ②：会话 / 刷新 / 撤销状态机。
 *
 * 钉死三类失误：
 * - 撤销或过期后仍"记得曾经通过"（缓存绿灯）；
 * - 刷新失败后静默重铸回 `active`；
 * - 快照 / 证据里出现令牌明文。
 */

import { describe, expect, it } from 'vitest';

import {
  SessionManager,
  SessionUnavailableError,
  createFakeMinter,
} from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';
import type { TransportCredential } from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';

import { TEST_ACCOUNT_REF, TEST_KEY_REF, T0, standardMintSteps } from './support.js';

const CREDENTIAL: TransportCredential = Object.freeze({ keyRef: TEST_KEY_REF, material: 'test-material' });

function newManager(steps = standardMintSteps()): SessionManager {
  return new SessionManager(createFakeMinter(steps));
}

async function openActive(mgr: SessionManager): Promise<void> {
  await mgr.open({ keyRef: TEST_KEY_REF, accountRef: TEST_ACCOUNT_REF, credential: CREDENTIAL, now: T0 });
}

describe('M02 会话建立', () => {
  it('open ⇒ active，快照无令牌字段', async () => {
    const mgr = newManager();
    await openActive(mgr);
    const snap = mgr.snapshot();
    expect(snap.state).toBe('active');
    expect(snap.tokenRef).toMatch(/^sessref:/);
    expect(snap.accountRef).toBe(TEST_ACCOUNT_REF);
    expect(Object.keys(snap)).not.toContain('token');
    expect(JSON.stringify(snap)).not.toContain('fake-token');
  });

  it('ensureActive 在有效期内返回令牌（供 Authorization 头用）', async () => {
    const mgr = newManager();
    await openActive(mgr);
    const active = mgr.ensureActive(T0 + 1_000);
    expect(active.token).toBe('fake-token-1-1');
    expect(active.tokenRef).toMatch(/^sessref:/);
  });

  it('active 时重复 open 被拒', async () => {
    const mgr = newManager();
    await openActive(mgr);
    await expect(
      mgr.open({ keyRef: TEST_KEY_REF, accountRef: TEST_ACCOUNT_REF, credential: CREDENTIAL, now: T0 + 1 }),
    ).rejects.toBeInstanceOf(SessionUnavailableError);
  });

  it('scope 校验：缺失 scope 抛 scope_missing', async () => {
    const mgr = newManager();
    await openActive(mgr);
    expect(() => mgr.ensureActive(T0 + 1, 'meituan.order')).not.toThrow();
    let caught: unknown;
    try {
      mgr.ensureActive(T0 + 1, 'meituan.refund');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SessionUnavailableError);
    expect((caught as SessionUnavailableError).reason).toBe('scope_missing');
  });
});

describe('M02 过期：每次重新判定，不缓存绿灯', () => {
  it('过了 expiresAt，ensureActive 抛 expired 且状态落到 expired', async () => {
    const mgr = newManager();
    await openActive(mgr);
    // ttl = 1 小时
    let caught: unknown;
    try {
      mgr.ensureActive(T0 + 60 * 60 * 1000);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SessionUnavailableError);
    expect((caught as SessionUnavailableError).reason).toBe('expired');
    expect(mgr.state).toBe('expired');
    // 再次调用仍是 expired（不会"恢复"）
    expect(() => mgr.ensureActive(T0 + 60 * 60 * 1000 + 1)).toThrow(SessionUnavailableError);
  });
});

describe('M02 刷新', () => {
  it('refresh 轮换令牌并 +1 refreshCount，tokenRef 变化', async () => {
    const mgr = newManager();
    await openActive(mgr);
    const before = mgr.snapshot();
    const after = await mgr.refresh({ credential: CREDENTIAL, now: T0 + 1_000 });
    expect(after.state).toBe('active');
    expect(after.refreshCount).toBe(1);
    expect(after.tokenRef).not.toBe(before.tokenRef);
    expect(mgr.ensureActive(T0 + 1_001).token).toBe('fake-token-2-2');
  });

  it('不可刷新会话：refresh 抛 not_refreshable 并落到 expired', async () => {
    const mgr = newManager([{ kind: 'mint', scopes: ['meituan.query'], ttlMs: 1_000, refreshable: false }]);
    await openActive(mgr);
    let caught: unknown;
    try {
      await mgr.refresh({ credential: CREDENTIAL, now: T0 + 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SessionUnavailableError);
    expect((caught as SessionUnavailableError).reason).toBe('not_refreshable');
    expect(mgr.state).toBe('expired');
  });

  it('并发刷新：第二次在 refreshing 期间被拒', async () => {
    const mgr = newManager();
    await openActive(mgr);
    const first = mgr.refresh({ credential: CREDENTIAL, now: T0 + 1 });
    let caught: unknown;
    try {
      await mgr.refresh({ credential: CREDENTIAL, now: T0 + 2 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SessionUnavailableError);
    expect((caught as SessionUnavailableError).reason).toBe('refreshing');
    await first; // 第一次最终成功
    expect(mgr.state).toBe('active');
  });

  it('刷新时铸造失败 ⇒ 落到 expired，不静默重铸', async () => {
    const mgr = newManager([
      { kind: 'mint', scopes: ['meituan.query'], ttlMs: 1_000, refreshable: true },
      { kind: 'fail', reason: 'boom' },
    ]);
    await openActive(mgr);
    await expect(mgr.refresh({ credential: CREDENTIAL, now: T0 + 1 })).rejects.toThrow('假铸造失败');
    expect(mgr.state).toBe('expired');
    expect(() => mgr.ensureActive(T0 + 2)).toThrow(SessionUnavailableError);
  });
});

describe('M02 撤销', () => {
  it('revoke ⇒ 状态 revoked，ensureActive 抛 revoked，刷新也被拒', async () => {
    const mgr = newManager();
    await openActive(mgr);
    const snap = mgr.revoke(T0 + 5_000);
    expect(snap.state).toBe('revoked');
    expect(snap.revokedAt).toBe(T0 + 5_000);

    let caught: unknown;
    try {
      mgr.ensureActive(T0 + 5_001);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SessionUnavailableError);
    expect((caught as SessionUnavailableError).reason).toBe('revoked');

    await expect(mgr.refresh({ credential: CREDENTIAL, now: T0 + 5_002 })).rejects.toBeInstanceOf(
      SessionUnavailableError,
    );
    expect(mgr.state).toBe('revoked');
  });

  it('revoke 幂等：重复撤销不改变首次时刻', async () => {
    const mgr = newManager();
    await openActive(mgr);
    mgr.revoke(T0 + 100);
    const again = mgr.revoke(T0 + 999);
    expect(again.revokedAt).toBe(T0 + 100);
  });

  it('撤销后重新 open 会重新铸造（显式恢复路径存在，非静默）', async () => {
    const mgr = newManager();
    await openActive(mgr);
    mgr.revoke(T0 + 1);
    const reopened = await mgr.open({
      keyRef: TEST_KEY_REF,
      accountRef: TEST_ACCOUNT_REF,
      credential: CREDENTIAL,
      now: T0 + 2,
    });
    expect(reopened.state).toBe('active');
    expect(reopened.revokedAt).toBeNull();
  });
});

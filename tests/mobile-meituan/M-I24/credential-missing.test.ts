/**
 * M-I24 / 断言 (c)：撤销 / 过期 / 未知 的 keyRef 一律 `credential_missing`，
 * 且在端点白名单通过后、**端口调用之前**收口（`port.callCount()===0`）。
 *
 * 关键点：撤销 / 过期由**凭证库**按当前逻辑时钟判定，传输层把桥接抛出的拒绝
 * 归为 `credential_missing`（发出前失败 = `not_sent`），不误报成"可能已到达"。
 */

import { describe, expect, it } from 'vitest';

import {
  buildStack,
  descriptor,
  expectFailure,
  makeVault,
  openStackSession,
  T0,
  TTL_MS,
} from './support.js';

describe('M-I24 撤销 / 过期 / 未知 keyRef ⇒ credential_missing（零端口调用）', () => {
  it('已撤销的 keyRef：credential_missing，拒绝原因 revoked，端口零调用', async () => {
    const vault = makeVault();
    vault.revoke('keyref:mt:user-a:cred-1', T0 + 1);
    const stack = buildStack({ vault });
    await openStackSession(stack);

    const outcome = expectFailure(await stack.client.invoke(descriptor(), T0 + 2));

    expect(outcome.failureKind).toBe('credential_missing');
    expect(stack.resolver.lastDenyReason()).toBe('revoked');
    expect(stack.resolver.resolveCount()).toBe(1);
    expect(stack.transport.callCount()).toBe(0);
    // 发出前失败：可判定未到达平台。
    expect(outcome.network.transport).toBe('not_sent');
    expect(outcome.tokenRef).not.toBeNull();
  });

  it('已过期的 keyRef：会话仍活跃但凭证明细已过期 ⇒ credential_missing', async () => {
    // 凭证明细有效期很短；会话有效期很长——把两层时间解耦，隔离"凭证过期"这一因。
    const vault = makeVault({ expiresAt: T0 + 1_000 });
    const stack = buildStack({
      vault,
      context: { accountRef: 'acct:meituan:user-a', now: T0 + 2_000 },
      sessionTtlMs: 3_600_000,
    });
    await openStackSession(stack, T0);

    // 会话在 T0+2000 仍活跃（未触发 session_unavailable）。
    expect(stack.session.ensureActive(T0 + 2_000).tokenRef.startsWith('sessref:')).toBe(true);

    const outcome = expectFailure(await stack.client.invoke(descriptor(), T0 + 2_000));
    expect(outcome.failureKind).toBe('credential_missing');
    expect(stack.resolver.lastDenyReason()).toBe('expired');
    expect(stack.transport.callCount()).toBe(0);
    expect(outcome.network.transport).toBe('not_sent');
  });

  it('未登记的（形状合法的）keyRef ⇒ credential_missing，原因 unknown_key', async () => {
    const stack = buildStack();
    await openStackSession(stack);

    const outcome = expectFailure(
      await stack.client.invoke(descriptor({ keyRef: 'keyref:mt:user-a:not-imported' }), T0 + 1),
    );

    expect(outcome.failureKind).toBe('credential_missing');
    expect(stack.resolver.lastDenyReason()).toBe('unknown_key');
    // 请求用的引用（本身是引用，不是密钥）照实记录，但材料从未流出。
    expect(outcome.keyRef).toBe('keyref:mt:user-a:not-imported');
    expect(stack.transport.callCount()).toBe(0);
  });

  it('对照：活跃且未过期的 keyRef 能解析出材质（拒绝非空转）', async () => {
    const stack = buildStack();
    await openStackSession(stack);
    const credential = await stack.resolver.resolve('keyref:mt:user-a:cred-1');
    expect(credential.keyRef).toBe('keyref:mt:user-a:cred-1');
    expect(credential.material.length).toBeGreaterThan(0);
    expect(stack.resolver.resolveCount()).toBe(1);
    // 边界：TTL 内仍有效。
    expect(T0 + 1 < T0 + TTL_MS).toBe(true);
  });
});

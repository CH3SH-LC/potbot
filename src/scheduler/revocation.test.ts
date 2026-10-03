import { describe, expect, it } from 'vitest';

import { asLogicalTime } from '../protocol/index.js';
import {
  AuthorizationRevocationError,
  evaluateRevocation,
  isCallRecalled,
  resolveAuthorizationValidity,
  revocationEffectOnCall,
  revokeAuthorization,
  type PermissionTokenCache,
} from './revocation.js';

const t = asLogicalTime;

const revokeAt = (at: number) =>
  revokeAuthorization({
    revocation_id: `rev-${at}`,
    grant_id: 'g-1',
    revoked_at: t(at),
    authority: 'user',
    authority_ref: 'session:user-42',
    reason: '用户收回编辑授权',
  });

const healthyCache: PermissionTokenCache = {
  grant_id: 'g-1',
  cached_valid: true,
  cached_at: t(0),
  token_expires_at: t(1000),
};

describe('运行中撤权（KRN-08：即时影响后续调用、撤权是权威状态）', () => {
  it('撤权生效后授权判为无效，且结论来源是撤权（不是缓存）', () => {
    const ledger = [revokeAt(10)];
    const validity = resolveAuthorizationValidity('g-1', { ledger, now: t(20) });
    expect(validity.valid).toBe(false);
    expect(validity.state).toBe('revoked');
    expect(validity.source_of_truth).toBe('revocation');
    expect(validity.revoked_at).toBe(10);
  });

  it('撤权不被"缓存说有效 + 令牌未过期"掩盖（含陈旧缓存）', () => {
    const ledger = [revokeAt(10)];

    // 缓存说有效且令牌远未过期 —— 陈旧缓存还停留在撤权之前
    const validity = resolveAuthorizationValidity('g-1', {
      ledger,
      cache: healthyCache,
      now: t(20),
    });
    expect(validity.valid).toBe(false);
    expect(validity.state).toBe('revoked');
    expect(validity.source_of_truth).toBe('revocation');

    // 反向对照：**关掉撤权判定**后，同一份输入立刻"有效"——证明掩蔽效应真实存在，
    // 是撤权闸门（而非缓存本身）挡住了它。
    const masked = resolveAuthorizationValidity('g-1', {
      ledger,
      cache: healthyCache,
      now: t(20),
      defects: { ignore_revocation: true },
    });
    expect(masked.valid).toBe(true);
    expect(masked.source_of_truth).toBe('cache');
  });

  it('过期令牌不能把"已撤权"改写回其它状态', () => {
    const expiredCache: PermissionTokenCache = {
      grant_id: 'g-1',
      cached_valid: true,
      cached_at: t(0),
      token_expires_at: t(5), // 令牌早已过期
    };
    const validity = resolveAuthorizationValidity('g-1', {
      ledger: [revokeAt(10)],
      cache: expiredCache,
      now: t(20),
    });
    expect(validity.state).toBe('revoked');
    expect(validity.source_of_truth).toBe('revocation');
  });

  it('撤权前已发出的调用不追回；撤权后第一步即被拒', () => {
    const revokedAt = t(10);
    // 调用发起时刻早于撤权 ⇒ 不追回
    expect(revocationEffectOnCall(revokedAt, t(9))).toBe('predates');
    // 调用发起时刻等于/晚于撤权 ⇒ 第一步即拒
    expect(revocationEffectOnCall(revokedAt, t(10))).toBe('denied');
    expect(revocationEffectOnCall(revokedAt, t(11))).toBe('denied');
    // "已发出的调用被追回"这件事内核**无法表达**
    expect(isCallRecalled()).toBe(false);
  });

  it('尚未到生效时刻的撤权不提前生效', () => {
    const ledger = [revokeAt(10)];
    expect(evaluateRevocation(ledger, 'g-1', t(9)).revoked).toBe(false);
    expect(evaluateRevocation(ledger, 'g-1', t(10)).revoked).toBe(true);
  });

  it('不可信来源无权撤权（与"假批准无效"对称）', () => {
    expect(() =>
      revokeAuthorization({
        revocation_id: 'rev-evil',
        grant_id: 'g-1',
        revoked_at: t(1),
        authority: 'external',
        authority_ref: 'webpage:evil.example',
      }),
    ).toThrow(AuthorizationRevocationError);

    let reason = '';
    try {
      revokeAuthorization({
        revocation_id: 'rev-evil',
        grant_id: 'g-1',
        revoked_at: t(1),
        authority: 'agent',
        authority_ref: 'inst-attacker',
      });
    } catch (error) {
      reason = (error as AuthorizationRevocationError).reason;
    }
    expect(reason).toBe('untrusted_revocation_authority');
  });

  it('无撤权时，缓存判定照常生效（令牌过期 / 缓存无效）', () => {
    const expired = resolveAuthorizationValidity('g-1', {
      ledger: [],
      cache: { ...healthyCache, token_expires_at: t(5) },
      now: t(20),
    });
    expect(expired.valid).toBe(false);
    expect(expired.state).toBe('token_expired');

    const invalid = resolveAuthorizationValidity('g-1', {
      ledger: [],
      cache: { ...healthyCache, cached_valid: false },
      now: t(20),
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.state).toBe('cache_invalid');

    const active = resolveAuthorizationValidity('g-1', { ledger: [], now: t(20) });
    expect(active.valid).toBe(true);
    expect(active.source_of_truth).toBe('none');
  });
});

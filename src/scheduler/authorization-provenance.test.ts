import { describe, expect, it } from 'vitest';

import { asLogicalTime } from '../protocol/index.js';
import {
  AuthorizationProvenanceError,
  authorizationState,
  describeProvenance,
  grantAuthorization,
  grantCovers,
  isTrustedAuthorizationSource,
  latestAuthorization,
  narrowAuthorization,
  normalizeScope,
  traceProvenance,
} from './authorization-provenance.js';

const t = asLogicalTime;

describe('授权来源可追溯（KRN-08：谁、何时、以什么范围）', () => {
  it('如实记录来源、时刻与范围，并标出可信性', () => {
    const grant = grantAuthorization({
      grant_id: 'g-1',
      source: 'user',
      source_ref: 'session:user-42',
      subject_instance_id: null,
      scope: ['doc.read', 'doc.write'],
      granted_at: t(0),
      reason: '用户在会话里批准编辑当前文档',
    });

    const provenance = describeProvenance(grant);
    expect(provenance.source).toBe('user');
    expect(provenance.source_ref).toBe('session:user-42');
    expect(provenance.granted_at).toBe(0);
    expect(provenance.scope).toEqual(['doc.read', 'doc.write']);
    expect(provenance.trusted).toBe(true);
    expect(provenance.reason).toContain('用户在会话里批准');
  });

  it('只把 kernel / user 视为可信来源；agent / external 是数据', () => {
    expect(isTrustedAuthorizationSource('kernel')).toBe(true);
    expect(isTrustedAuthorizationSource('user')).toBe(true);
    expect(isTrustedAuthorizationSource('agent')).toBe(false);
    expect(isTrustedAuthorizationSource('external')).toBe(false);

    const fake = grantAuthorization({
      grant_id: 'g-fake',
      source: 'external',
      source_ref: 'webpage:evil.example',
      subject_instance_id: 'inst-a',
      scope: ['net.fetch'],
      granted_at: t(0),
    });
    expect(describeProvenance(fake).trusted).toBe(false);
  });

  it('范围收窄即时生效：取用方读最新 revision，而不是旧范围', () => {
    const grant = grantAuthorization({
      grant_id: 'g-2',
      source: 'user',
      source_ref: 'session:user-42',
      subject_instance_id: null,
      scope: ['doc.read', 'doc.write', 'net.fetch'],
      granted_at: t(0),
    });
    const narrowed = narrowAuthorization(grant, ['doc.read'], { at: t(5) });

    expect(narrowed.revision).toBe(2);
    expect(narrowed.scope).toEqual(['doc.read']);
    // 旧范围 doc.write 立即失效
    const registry = [grant, narrowed];
    const current = latestAuthorization(registry, 'g-2');
    expect(current?.scope).toEqual(['doc.read']);
    expect(current?.scope.includes('doc.write')).toBe(false);
  });

  it('收窄不得放宽（反向对照：把"收窄"写成并集就会新增权限，必须被拒）', () => {
    const grant = grantAuthorization({
      grant_id: 'g-3',
      source: 'user',
      source_ref: 'session:user-42',
      subject_instance_id: null,
      scope: ['doc.read'],
      granted_at: t(0),
    });

    expect(() => narrowAuthorization(grant, ['doc.read', 'net.fetch'], { at: t(1) })).toThrow(
      AuthorizationProvenanceError,
    );
    let reason = '';
    try {
      narrowAuthorization(grant, ['doc.read', 'net.fetch'], { at: t(1) });
    } catch (error) {
      reason = (error as AuthorizationProvenanceError).reason;
    }
    expect(reason).toBe('scope_widening_forbidden');

    // 反向对照：若把"收窄"实现成并集，net.fetch 会被悄悄加进来（那就是提权）
    const forbiddenUnion = [...new Set([...grant.scope, 'net.fetch'])];
    expect(forbiddenUnion).toContain('net.fetch');
    expect(grant.scope).not.toContain('net.fetch');
  });

  it('收窄不得顺手延长期限', () => {
    const grant = grantAuthorization({
      grant_id: 'g-4',
      source: 'user',
      source_ref: 'session:user-42',
      subject_instance_id: null,
      scope: ['doc.read', 'doc.write'],
      granted_at: t(0),
      expires_at: t(100),
    });
    const narrowed = narrowAuthorization(grant, ['doc.read'], { at: t(5) });
    expect(narrowed.expires_at).toBe(100);
    expect(authorizationState(narrowed, t(100))).toBe('expired');
  });

  it('授权过期后不再放行（反向对照：忽略时间的朴素检查仍返回 true）', () => {
    const grant = grantAuthorization({
      grant_id: 'g-5',
      source: 'user',
      source_ref: 'session:user-42',
      subject_instance_id: null,
      scope: ['doc.write'],
      granted_at: t(0),
      expires_at: t(10),
    });

    expect(grantCovers(grant, 'doc.write', t(9))).toBe(true);
    expect(authorizationState(grant, t(9))).toBe('active');

    expect(grantCovers(grant, 'doc.write', t(10))).toBe(false);
    expect(authorizationState(grant, t(10))).toBe('expired');

    // 反向对照：只查 scope、不看时间的朴素判定在过期之后**仍然**返回 true——
    // 这正是 `grantCovers()` 的时间闸门拦下的东西，证明该闸门是承重的。
    const naiveScopeOnly = grant.scope.includes('doc.write');
    expect(naiveScopeOnly).toBe(true);
    expect(grantCovers(grant, 'doc.write', t(999))).toBe(false);
  });

  it('委派链可整链追溯；缺环时如实截断而不是编造中间环节', () => {
    const root = grantAuthorization({
      grant_id: 'g-root',
      source: 'user',
      source_ref: 'session:user-42',
      subject_instance_id: null,
      scope: ['doc.read', 'doc.write'],
      granted_at: t(0),
    });
    const child = grantAuthorization({
      grant_id: 'g-child',
      source: 'user',
      source_ref: 'session:user-42',
      subject_instance_id: 'inst-child',
      scope: ['doc.read'],
      granted_at: t(1),
      parent_grant_id: 'g-root',
    });

    const chain = traceProvenance([root, child], 'g-child');
    expect(chain.map((p) => p.grant_id)).toEqual(['g-root', 'g-child']);

    // 缺环：parent 指向不在册的授权 ⇒ 只到这一跳为止
    const orphan = grantAuthorization({
      grant_id: 'g-orphan',
      source: 'user',
      source_ref: 'session:user-42',
      subject_instance_id: 'inst-x',
      scope: ['doc.read'],
      granted_at: t(2),
      parent_grant_id: 'g-missing',
    });
    const truncated = traceProvenance([orphan], 'g-orphan');
    expect(truncated.map((p) => p.grant_id)).toEqual(['g-orphan']);
  });

  it('范围 token 规范化：去重并拒绝空 token', () => {
    expect(normalizeScope(['doc.read', 'doc.read', ' doc.write '])).toEqual(['doc.read', 'doc.write']);
    expect(() => normalizeScope(['doc.read', '  '])).toThrow(AuthorizationProvenanceError);
  });

  it('构造授权时校验 id 与有效期', () => {
    expect(() =>
      grantAuthorization({
        grant_id: '   ',
        source: 'user',
        source_ref: 'session:user-42',
        subject_instance_id: null,
        scope: ['doc.read'],
        granted_at: t(0),
      }),
    ).toThrow(AuthorizationProvenanceError);

    expect(() =>
      grantAuthorization({
        grant_id: 'g-bad',
        source: 'user',
        source_ref: 'session:user-42',
        subject_instance_id: null,
        scope: ['doc.read'],
        granted_at: t(10),
        expires_at: t(5),
      }),
    ).toThrow(AuthorizationProvenanceError);
  });
});

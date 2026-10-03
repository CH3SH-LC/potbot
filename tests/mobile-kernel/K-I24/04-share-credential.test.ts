/**
 * K-I24 ④：**分享凭据** —— 可撤销、可过期、钉住版本、不含明文。
 *
 * 判据不依赖实现自述：
 *   - 令牌**不透明**（`share_<64 hex>`），且把凭据所有字符串字段扫一遍，既无电脑绝对路径、
 *     也无内容明文哨兵；
 *   - 撤销 / 过期 / 未知是**可区分的返回值**（不是异常），撤销幂等；
 *   - 凭据**钉住**签发时的版本摘要：artifact 升级后凭据仍指向原版本；
 *   - 跨宿主实例（同一存储）仍能校验——证明凭据落在介质上而非内存里。
 */

import { describe, expect, it } from 'vitest';

import { MemoryStoragePort } from '../../../apps/mobile-kernel/storage/index.js';

import { collectStrings, expectArtifactsError, manualClock, newHost, oracle } from './fixtures.js';

const MARKER = 'SHARE-SECRET-CONTENT';

describe('K-I24 分享凭据：签发 / 校验 / 撤销 / 过期', () => {
  async function seed() {
    const clock = manualClock();
    const storage = new MemoryStoragePort({ now: clock.now });
    const host = newHost(storage, { now: clock.now });
    await host.publish({ conversationId: 'conv-1', taskId: 'task-1', fileName: '报告.docx', artifactId: 'art-a', chunks: [MARKER] });
    return { clock, storage, host };
  }

  it('签发：令牌不透明、钉住版本、字段无明文 / 无电脑路径', async () => {
    const { host } = await seed();
    const share = host.issueShare({ artifactId: 'art-a', artifactVersion: 1, ttlMs: 60_000 });

    expect(share.credentialId).toBe('share-1');
    expect(share.token.startsWith('share_')).toBe(true);
    expect(share.token.length).toBe('share_'.length + 64);
    expect(share.artifactId).toBe('art-a');
    expect(share.artifactVersion).toBe(1);
    expect(share.digest).toBe(oracle(MARKER));
    expect(share.permission).toBe('read');
    expect(share.revokedAt).toBeNull();
    expect(share.expiresAt).not.toBeNull();

    for (const text of collectStrings(share)) {
      expect(text.includes(MARKER)).toBe(false);
      expect(/^[A-Za-z]:[\\/]/.test(text)).toBe(false);
    }
  });

  it('校验：有效 ⇒ ok；未知令牌 ⇒ unknown', async () => {
    const { host } = await seed();
    const share = host.issueShare({ artifactId: 'art-a' });
    const ok = host.verifyShare(share.token);
    expect(ok.status).toBe('ok');
    if (ok.status === 'ok') expect(ok.share.credentialId).toBe(share.credentialId);

    expect(host.verifyShare('share_deadbeef').status).toBe('unknown');
    expect(host.verifyShare('').status).toBe('unknown');
  });

  it('过期：到点前有效、到点后 expired', async () => {
    const { host, clock } = await seed();
    const share = host.issueShare({ artifactId: 'art-a', ttlMs: 1000 });

    clock.advance(999);
    expect(host.verifyShare(share.token).status).toBe('ok');
    clock.advance(1); // 恰好到期
    expect(host.verifyShare(share.token).status).toBe('expired');
  });

  it('撤销：置为 revoked、二次撤销幂等、撤销未知抛 share_not_found', async () => {
    const { host } = await seed();
    const share = host.issueShare({ artifactId: 'art-a' });

    expect(host.revokeShare(share.credentialId)).toEqual({ credentialId: share.credentialId, revoked: true, changed: true });
    const verified = host.verifyShare(share.token);
    expect(verified.status).toBe('revoked');
    if (verified.status === 'revoked') expect(verified.share.revokedAt).not.toBeNull();

    // 幂等：第二次撤销成功但 changed=false。
    expect(host.revokeShare(share.credentialId)).toEqual({ credentialId: share.credentialId, revoked: true, changed: false });
    expectArtifactsError(() => host.revokeShare('share-999'), 'share_not_found');
  });

  it('凭据钉住签发时的版本：artifact 升级后，旧凭据仍指向原版本摘要', async () => {
    const { host } = await seed();
    const shareV1 = host.issueShare({ artifactId: 'art-a', artifactVersion: 1 });
    await host.publish({ conversationId: 'conv-1', fileName: '报告.docx', artifactId: 'art-a', chunks: ['v2'] });

    const verified = host.verifyShare(shareV1.token);
    expect(verified.status).toBe('ok');
    if (verified.status === 'ok') {
      expect(verified.share.artifactVersion).toBe(1);
      expect(verified.share.digest).toBe(oracle(MARKER));
      expect(verified.share.blobUri).toBe(host.listVersions('art-a').find((v) => v.artifactVersion === 1)!.blobUri);
    }
  });

  it('凭据落在介质上：新宿主实例（同一存储）仍能校验', async () => {
    const { storage, host, clock } = await seed();
    const share = host.issueShare({ artifactId: 'art-a' });

    const reopened = newHost(storage, { now: clock.now });
    const verified = reopened.verifyShare(share.token);
    expect(verified.status).toBe('ok');
    expect(reopened.listShares('art-a')).toHaveLength(1);
  });

  it('签发错误路径：未知 artifact / 未知版本 / 非法 ttl', async () => {
    const { host } = await seed();
    expectArtifactsError(() => host.issueShare({ artifactId: 'nope' }), 'artifact_not_found');
    expectArtifactsError(() => host.issueShare({ artifactId: 'art-a', artifactVersion: 9 }), 'version_not_found');
    expectArtifactsError(() => host.issueShare({ artifactId: 'art-a', ttlMs: 0 }), 'invalid_share_ttl');
    expectArtifactsError(() => host.issueShare({ artifactId: 'art-a', ttlMs: -5 }), 'invalid_share_ttl');
  });

  it('listShares 可按 artifactId 过滤，默认不过期凭据 expiresAt=null', async () => {
    const { host } = await seed();
    await host.publish({ conversationId: 'conv-2', fileName: 'b.docx', artifactId: 'art-b', chunks: ['b'] });
    const a = host.issueShare({ artifactId: 'art-a' });
    host.issueShare({ artifactId: 'art-b' });

    expect(a.expiresAt).toBeNull();
    expect(host.listShares()).toHaveLength(2);
    expect(host.listShares('art-b').map((s) => s.artifactId)).toEqual(['art-b']);
  });
});

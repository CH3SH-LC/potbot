/**
 * K-I24 ①：**版本只追加 / 幂等 / 读回** —— 摘要以 `node:crypto` 外部预言机为准。
 *
 * 每个 `digest` 都是本宿主对实际内容字节用 K09 纯 TS SHA-256 算出的；本测试另用
 * `node:crypto` 复算同一串内容，两者必须逐字相等。任一处实现缺陷（字节序、填充、
 * UTF-8 编码）都会让对拍变红——不是自己说自己对。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { MemoryStoragePort } from '../../../apps/mobile-kernel/storage/index.js';

import { bytes, expectArtifactsError, manualClock, newHost, oracle, textOf } from './fixtures.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('K-I24 发布：版本只追加、幂等、读回凭据', () => {
  let clock = manualClock();
  let storage = new MemoryStoragePort({ now: () => clock.now() });

  beforeEach(() => {
    clock = manualClock();
    storage = new MemoryStoragePort({ now: () => clock.now() });
  });

  it('首版发布：摘要与外部预言机一致、字节数正确、落在 content:// 命名空间', async () => {
    const host = newHost(storage, { now: clock.now });
    const result = await host.publish({
      conversationId: 'conv-1',
      taskId: 'task-1',
      fileName: '报告.docx',
      mime: DOCX,
      artifactId: 'art-doc',
      chunks: ['hello ', 'potbot', ' 中文'],
    });

    expect(result.status).toBe('ok');
    expect(result.created).toBe(true);
    expect(result.idempotent).toBe(false);
    expect(result.version.artifactVersion).toBe(1);
    expect(result.version.digest).toBe(oracle('hello potbot 中文'));
    expect(result.version.byteLength).toBe(bytes('hello potbot 中文').length);
    expect(result.version.blobUri.startsWith('content://potbot/artifacts/art-doc/')).toBe(true);
    expect(result.artifact.conversationId).toBe('conv-1');
    expect(result.artifact.taskId).toBe('task-1');
    expect(result.artifact.versions).toHaveLength(1);
  });

  it('同内容重复发布是**幂等**：不新增版本、不写新字节', async () => {
    const host = newHost(storage, { now: clock.now });
    const first = await host.publish({ conversationId: 'conv-1', fileName: 'a.docx', artifactId: 'art-a', chunks: ['same'] });
    const second = await host.publish({ conversationId: 'conv-1', fileName: 'a.docx', artifactId: 'art-a', chunks: ['sa', 'me'] });

    expect(second.idempotent).toBe(true);
    expect(second.created).toBe(false);
    expect(second.version.artifactVersion).toBe(1);
    expect(second.version.digest).toBe(first.version.digest);
    expect(host.listVersions('art-a')).toHaveLength(1);
  });

  it('内容变化 ⇒ 追加新版本，**旧版本仍可读**（从不覆盖）', async () => {
    const host = newHost(storage, { now: clock.now });
    await host.publish({ conversationId: 'conv-1', fileName: 'a.docx', artifactId: 'art-a', chunks: ['v1-content'] });
    const v2 = await host.publish({ conversationId: 'conv-1', fileName: 'a.docx', artifactId: 'art-a', chunks: ['v2-content'] });

    expect(v2.created).toBe(false);
    expect(v2.idempotent).toBe(false);
    expect(v2.version.artifactVersion).toBe(2);

    // 版本列表：最新在前。
    const versions = host.listVersions('art-a');
    expect(versions.map((v) => v.artifactVersion)).toEqual([2, 1]);
    expect(versions[0]!.digest).toBe(oracle('v2-content'));
    expect(versions[1]!.digest).toBe(oracle('v1-content'));

    // 旧版本 v1 的字节仍在，且读回受校验。
    const readV1 = host.readArtifact({ artifactId: 'art-a', artifactVersion: 1 });
    expect(readV1.status).toBe('ok');
    expect(textOf(readV1.bytes!)).toBe('v1-content');
    expect(readV1.readBack?.verified).toBe(true);
    expect(readV1.readBack?.digest).toBe(oracle('v1-content'));

    // 默认读最新版。
    const latest = host.readArtifact({ artifactId: 'art-a' });
    expect(latest.artifactVersion).toBe(2);
    expect(textOf(latest.bytes!)).toBe('v2-content');
  });

  it('读回摘要不符 ⇒ failed/verified=false（期望摘要错时）；给对 ⇒ ok（对照组）', async () => {
    const host = newHost(storage, { now: clock.now });
    await host.publish({ conversationId: 'conv-1', fileName: 'a.docx', artifactId: 'art-a', chunks: ['payload'] });

    const bad = host.readArtifact({ artifactId: 'art-a', expectedDigest: oracle('other') });
    expect(bad.status).toBe('failed');
    expect(bad.readBack?.verified).toBe(false);
    expect(bad.readBack?.digest).toBe(oracle('payload'));

    const good = host.readArtifact({ artifactId: 'art-a', expectedDigest: oracle('payload') });
    expect(good.status).toBe('ok');
    expect(good.readBack?.verified).toBe(true);
  });

  it('未知 artifact / 未知版本 ⇒ not-found（不伪造凭据）', async () => {
    const host = newHost(storage, { now: clock.now });
    await host.publish({ conversationId: 'conv-1', fileName: 'a.docx', artifactId: 'art-a', chunks: ['x'] });

    expect(host.readArtifact({ artifactId: 'nope' }).status).toBe('not-found');
    expect(host.readArtifact({ artifactId: 'art-a', artifactVersion: 99 }).status).toBe('not-found');
    expect(host.getArtifact('nope')).toBeNull();
    expect(host.listVersions('nope')).toEqual([]);
  });

  it('默认 artifactId 由内核生成且单调（art-1 / art-2）', async () => {
    const host = newHost(storage, { now: clock.now });
    const a = await host.publish({ conversationId: 'conv-1', fileName: 'a.docx', chunks: ['a'] });
    const b = await host.publish({ conversationId: 'conv-1', fileName: 'b.docx', chunks: ['b'] });
    expect(a.artifact.artifactId).toBe('art-1');
    expect(b.artifact.artifactId).toBe('art-2');
  });

  it('空内容也能发布（摘要 = 空串摘要，字节数 0）', async () => {
    const host = newHost(storage, { now: clock.now });
    const result = await host.publish({ conversationId: 'conv-1', fileName: 'empty.bin', artifactId: 'art-e', chunks: [] });
    expect(result.version.byteLength).toBe(0);
    expect(result.version.digest).toBe(oracle(''));
    expect(host.readArtifact({ artifactId: 'art-e' }).status).toBe('ok');
  });

  it('expectedDigest 形状非法 ⇒ 抛 invalid_expected_digest（不当成读回失败）', async () => {
    const host = newHost(storage, { now: clock.now });
    await host.publish({ conversationId: 'conv-1', fileName: 'a.docx', artifactId: 'art-a', chunks: ['x'] });
    expectArtifactsError(() => host.readArtifact({ artifactId: 'art-a', expectedDigest: 'sha256:zz' }), 'invalid_expected_digest');
  });

  it('发布往返的时间戳取自注入时钟（确定性）', async () => {
    const host = newHost(storage, { now: clock.now });
    const result = await host.publish({ conversationId: 'conv-1', fileName: 'a.docx', artifactId: 'art-a', chunks: ['x'] });
    expect(result.version.createdAt).toBe(new Date(clock.now()).toISOString());
  });
});

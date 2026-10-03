/**
 * K-I24 ③：**目录无明文红线**。
 *
 * 两条判据，都用"直读存储端口里的原始 blob"或"反向对照"实现，不看实现返回值：
 *   1. **内容字节绝不进目录**：发布一段带哨兵标记的内容后，从存储端口读回**目录快照 blob**
 *      的原始字节，断言里面**没有**那段内容（内容只以摘要形式出现）。
 *   2. **自由文本过闸**：fileName 若是电脑绝对路径 ⇒ `desktop_path_rejected`；若是明文密钥
 *      形状 ⇒ `plaintext_secret_in_catalog`，且拒绝时**不落盘**（目录 blob 不存在）。
 *   3. 纯红扫描器 `assertCatalogNoPlaintext` 的反向对照：干净目录不抛，被污染目录抛。
 */

import { describe, expect, it } from 'vitest';

import {
  artifactBlobUri,
  assertCatalogNoPlaintext,
  emptyCatalog,
  type ArtifactCatalog,
} from '../../../apps/mobile-kernel/artifacts-host/index.js';
import { MemoryStoragePort } from '../../../apps/mobile-kernel/storage/index.js';

import { expectArtifactsError, expectArtifactsErrorAsync, manualClock, newHost, oracle, textOf } from './fixtures.js';

const MARKER = 'TOP-SECRET-CONTENT-不要落进目录';

describe('K-I24 无明文：内容不进目录、自由文本过闸', () => {
  it('发布后目录快照的原始 blob 里**没有**内容明文，只有摘要', async () => {
    const clock = manualClock();
    const storage = new MemoryStoragePort({ now: clock.now });
    const host = newHost(storage, { now: clock.now });
    await host.publish({ conversationId: 'conv-1', fileName: '报告.docx', artifactId: 'art-a', chunks: [MARKER, ' 尾巴'] });

    // 直读目录 blob（不走宿主返回的解析结果）。
    const raw = storage.readBlob(host.catalogUri());
    expect(raw.status).toBe('ok');
    const catalogText = textOf(raw.bytes!);
    expect(catalogText.includes(MARKER)).toBe(false);
    // 摘要确实记录在内（说明不是"目录空的"导致的假阴性）。
    expect(catalogText.includes(oracle(MARKER + ' 尾巴'))).toBe(true);
  });

  it('fileName = 电脑绝对路径 ⇒ desktop_path_rejected，且目录 blob 不落盘', async () => {
    const clock = manualClock();
    const storage = new MemoryStoragePort({ now: clock.now });
    const host = newHost(storage, { now: clock.now });

    await expectArtifactsErrorAsync(
      () => host.publish({ conversationId: 'conv-1', fileName: 'C:/Users/<user>/Desktop/报告.docx', chunks: ['x'] }),
      'desktop_path_rejected',
    );
    expect(storage.readBlob(host.catalogUri()).status).toBe('not-found');
  });

  it('fileName = POSIX 绝对路径 ⇒ desktop_path_rejected', async () => {
    const clock = manualClock();
    const storage = new MemoryStoragePort({ now: clock.now });
    const host = newHost(storage, { now: clock.now });
    await expectArtifactsErrorAsync(
      () => host.publish({ conversationId: 'conv-1', fileName: '/sdcard/Download/x.docx', chunks: ['x'] }),
      'desktop_path_rejected',
    );
  });

  it('fileName 含明文密钥形状 ⇒ plaintext_secret_in_catalog，不落盘', async () => {
    const clock = manualClock();
    const storage = new MemoryStoragePort({ now: clock.now });
    const host = newHost(storage, { now: clock.now });
    await expectArtifactsErrorAsync(
      () => host.publish({ conversationId: 'conv-1', fileName: 'sk-live-abcdefghijklmnop.txt', chunks: ['x'] }),
      'plaintext_secret_in_catalog',
    );
    expect(storage.readBlob(host.catalogUri()).status).toBe('not-found');
  });

  it('纯红扫描器反向对照：干净目录不抛，塞入密钥的目录必抛', () => {
    const clean: ArtifactCatalog = emptyCatalog();
    expect(() => assertCatalogNoPlaintext(clean)).not.toThrow();

    // 干净记录（摘要 / content URI / 中文文件名）合法。
    const honest: ArtifactCatalog = {
      schemaVersion: 1,
      artifactSeq: 1,
      shareSeq: 0,
      artifacts: [
        {
          artifactId: 'art-1',
          conversationId: 'conv-1',
          taskId: null,
          fileName: '报告.docx',
          mime: 'application/octet-stream',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          versions: [
            {
              artifactVersion: 1,
              digest: oracle('x'),
              byteLength: 1,
              mime: 'application/octet-stream',
              blobUri: artifactBlobUri('art-1', 1, 'docx'),
              createdAt: new Date(0).toISOString(),
            },
          ],
        },
      ],
      shares: [],
    };
    expect(() => assertCatalogNoPlaintext(honest)).not.toThrow();

    const poisoned: ArtifactCatalog = {
      ...honest,
      artifacts: [{ ...honest.artifacts[0]!, fileName: 'token-sk-0123456789abcdef' }],
    };
    expectArtifactsError(() => assertCatalogNoPlaintext(poisoned), 'plaintext_secret_in_catalog');

    const withPath: ArtifactCatalog = {
      ...honest,
      artifacts: [{ ...honest.artifacts[0]!, fileName: 'x C:/Users/<user>/y.docx' }],
    };
    expectArtifactsError(() => assertCatalogNoPlaintext(withPath), 'desktop_path_rejected');
  });

  it('fileName 只是"含斜杠的相对名"⇒ invalid_file_name（与绝对路径拒因可区分）', async () => {
    const clock = manualClock();
    const storage = new MemoryStoragePort({ now: clock.now });
    const host = newHost(storage, { now: clock.now });
    await expectArtifactsErrorAsync(
      () => host.publish({ conversationId: 'conv-1', fileName: 'sub/report.docx', chunks: ['x'] }),
      'invalid_file_name',
    );
  });
});

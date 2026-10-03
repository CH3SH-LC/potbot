/**
 * K-I24 ⑤：**跨进程重开后旧产物仍可读**（真磁盘）。
 *
 * 前面四个用例用内存后端驱动语义；这里用 K09 的 `FileStoragePort` 跑在**真实临时目录**上，
 * 用**新实例**读旧数据，验证：
 *   - 每个版本写到**各自独立**的内容 URI，重开后逐版可读（从不覆盖上一版）；
 *   - 目录快照（CAS 写）与分享凭据跨重开仍在；
 *   - 旧版本**内容 blob 在磁盘上真实存在**（不是被某个内存索引假造出来的）。
 *
 * `node:fs` 适配器**只定义在本测试里**（产品树不得依赖 node 内建），与 K09 的 file-store.test.ts 同做法。
 */

import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FileStoragePort,
  type FileSystemPort,
} from '../../../apps/mobile-kernel/storage/index.js';

import { manualClock, newHost, oracle, textOf } from './fixtures.js';

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

class NodeFileSystem implements FileSystemPort {
  ensureDir(path: string): void {
    mkdirSync(path, { recursive: true });
  }
  exists(path: string): boolean {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }
  readFile(path: string): Uint8Array {
    return new Uint8Array(readFileSync(path));
  }
  writeFile(path: string, bytes: Uint8Array): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  rename(from: string, to: string): void {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  }
  removeFile(path: string): void {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  listFiles(path: string): readonly string[] {
    try {
      return readdirSync(path, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      return [];
    }
  }
  listDirs(path: string): readonly string[] {
    try {
      return readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }
}

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'k-i24-artifacts-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function portOn(root: string): FileStoragePort {
  return new FileStoragePort({ root, fs: new NodeFileSystem() });
}

describe('K-I24 跨重开：旧启动器产物可读、目录与分享持久', () => {
  it('关闭后新实例仍能列出全部版本，且每个旧版本字节可读', async () => {
    const root = newRoot();
    const clock = manualClock();

    const a = newHost(portOn(root), { now: clock.now });
    await a.publish({ conversationId: 'conv-1', taskId: 'task-1', fileName: '报告.docx', artifactId: 'art-a', chunks: ['v1-old'] });
    clock.advance(1000);
    await a.publish({ conversationId: 'conv-1', taskId: 'task-1', fileName: '报告.docx', artifactId: 'art-a', chunks: ['v2-new'] });
    const share = a.issueShare({ artifactId: 'art-a', artifactVersion: 1 });

    // 全新实例，只能靠磁盘。
    const b = newHost(portOn(root), { now: clock.now });
    expect(b.listVersions('art-a').map((v) => v.artifactVersion)).toEqual([2, 1]);
    expect(textOf(b.readArtifact({ artifactId: 'art-a', artifactVersion: 1 }).bytes!)).toBe('v1-old');
    expect(textOf(b.readArtifact({ artifactId: 'art-a', artifactVersion: 2 }).bytes!)).toBe('v2-new');
    expect(b.readArtifact({ artifactId: 'art-a', artifactVersion: 1 }).readBack?.digest).toBe(oracle('v1-old'));

    // 分组与分享跨重开仍在。
    expect(b.groupByConversation()[0]!.key).toBe('conv-1');
    expect(b.verifyShare(share.token).status).toBe('ok');

    // 磁盘上确实有两个版本文件（不是内存假造）。
    const dir = join(root, 'data', 'artifacts', 'art-a');
    expect(readdirSync(dir).sort()).toEqual(['v1.docx', 'v2.docx']);
  });

  it('重开后按当前版本摘要幂等命中（不新增版本）', async () => {
    const root = newRoot();
    const clock = manualClock();
    const a = newHost(portOn(root), { now: clock.now });
    await a.publish({ conversationId: 'conv-1', fileName: 'a.docx', artifactId: 'art-a', chunks: ['same-content'] });

    const b = newHost(portOn(root), { now: clock.now });
    const again = await b.publish({ conversationId: 'conv-1', fileName: 'a.docx', artifactId: 'art-a', chunks: ['same-content'] });
    expect(again.idempotent).toBe(true);
    expect(b.listVersions('art-a')).toHaveLength(1);
  });

  it('目录 blob 落盘但不含内容明文（真磁盘口径）', async () => {
    const root = newRoot();
    const clock = manualClock();
    const marker = 'DISK-MARKER-不要落进目录';
    const a = newHost(portOn(root), { now: clock.now });
    await a.publish({ conversationId: 'conv-1', fileName: 'a.docx', artifactId: 'art-a', chunks: [marker] });

    const catalogPath = join(root, 'data', 'artifacts', '_catalog.v1.json');
    const catalogText = readFileSync(catalogPath, 'utf8');
    expect(catalogText.includes(marker)).toBe(false);
    expect(catalogText.includes(oracle(marker))).toBe(true);
  });
});

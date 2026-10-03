/**
 * K-I07 ②：**文件后端 `FileBlobPort`** —— 跑在**真实临时目录**上的字节。
 *
 * 独立判据（不拿实现自证）：
 *   - "新实例能否读到"由**真实文件**决定，不是同一实例的内存缓存；
 *   - 读失败靠**真磁盘上被损坏的字节**触发，不是内存模拟；
 *   - 端口只回内容，**绝不回平台路径**。
 */

import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BlobPortError,
  FileBlobPort,
  isBlobPortError,
} from '../../../apps/mobile-kernel/storage/index.js';

import {
  FaultyFileSystem,
  NodeFileSystem,
  blobPathOf,
  cleanupTempRoots,
  countFiles,
  makeTempRoot,
  writeRawBytes,
} from './fixtures.js';

afterEach(cleanupTempRoots);

describe('FileBlobPort：真磁盘往返与跨进程持久', () => {
  it('write -> read 原样返回（含 CJK 与 BMP 外码点）', () => {
    const root = makeTempRoot();
    const port = new FileBlobPort({ root, fs: new NodeFileSystem() });
    const value = JSON.stringify({ note: '快照', emoji: '🚀', n: 1 });
    port.write('ledger/task-ledger.v1.json', value);
    expect(port.read('ledger/task-ledger.v1.json')).toBe(value);
    expect(port.exists('ledger/task-ledger.v1.json')).toBe(true);
  });

  it('换一个**新实例**指向同一 root 仍能读到（模拟杀进程重开）', () => {
    const root = makeTempRoot();
    const writer = new FileBlobPort({ root, fs: new NodeFileSystem() });
    writer.write('ledger/task-ledger.v1.json', '{"seq":3}');

    // 新实例 = 新进程（没有共享内存）。
    const reader = new FileBlobPort({ root, fs: new NodeFileSystem() });
    expect(reader.read('ledger/task-ledger.v1.json')).toBe('{"seq":3}');
  });

  it('覆盖写是原子替换：读回新值，目录里不多留副本', () => {
    const root = makeTempRoot();
    const port = new FileBlobPort({ root, fs: new NodeFileSystem() });
    port.write('k.json', 'v1');
    port.write('k.json', 'v2-longer');
    expect(port.read('k.json')).toBe('v2-longer');
    expect(countFiles(join(root, 'blobs'))).toBe(1);
  });

  it('未写过的 key 返回 null；remove 幂等；嵌套 key 自动建父目录', () => {
    const root = makeTempRoot();
    const port = new FileBlobPort({ root, fs: new NodeFileSystem() });
    expect(port.read('deep/nested/key.json')).toBeNull();
    port.write('deep/nested/key.json', 'X');
    expect(port.read('deep/nested/key.json')).toBe('X');
    port.remove('deep/nested/key.json');
    expect(port.read('deep/nested/key.json')).toBeNull();
    expect(() => port.remove('deep/nested/key.json')).not.toThrow();
  });

  it('端口只回内容，绝不回平台根路径', () => {
    const root = makeTempRoot();
    const port = new FileBlobPort({ root, fs: new NodeFileSystem() });
    const value = '{"k":"v"}';
    port.write('ledger/x.json', value);
    const read = port.read('ledger/x.json');
    expect(read).toBe(value);
    expect(read!.includes(root)).toBe(false);
  });

  it('key 红线在触碰文件系统之前生效', () => {
    const root = makeTempRoot();
    const port = new FileBlobPort({ root, fs: new NodeFileSystem() });
    expect(() => port.write('C:/Users/<user>/x.json', 'v')).toThrowError(/invalid_blob_key/);
    expect(() => port.exists('C:/Users/<user>/x.json')).toThrowError(/invalid_blob_key/);
    expect(() => port.read('../etc/passwd')).toThrowError(/invalid_blob_key/);
  });
});

describe('FileBlobPort：读失败 ≠ 空库（真磁盘）', () => {
  it('介质在但 readFile 抛错 => blob_read_failed，绝不返回 null', () => {
    const root = makeTempRoot();
    const seed = new FileBlobPort({ root, fs: new NodeFileSystem() });
    seed.write('ledger/x.json', '{"seq":1}');

    const faulty = new FileBlobPort({
      root,
      fs: new FaultyFileSystem({ failRead: (path) => path.endsWith('x.json') }),
    });
    let thrown: unknown;
    try {
      faulty.read('ledger/x.json');
    } catch (error) {
      thrown = error;
    }
    expect(isBlobPortError(thrown)).toBe(true);
    expect((thrown as BlobPortError).code).toBe('blob_read_failed');
    // 反向对照：绝不能是 null。
    expect(thrown).not.toBeNull();
  });

  it('磁盘上字节被损坏（截断的多字节序列）=> 严格解码抛错 => blob_read_failed', () => {
    const root = makeTempRoot();
    const port = new FileBlobPort({ root, fs: new NodeFileSystem() });
    port.write('ledger/x.json', '{"seq":1}');
    // 绕过端口直接覆盖真实文件：只剩一个被截断的 3 字节 UTF-8 序列的开头 2 字节。
    writeRawBytes(blobPathOf(root, 'ledger/x.json'), [0xe4, 0xb8]);

    expect(port.exists('ledger/x.json')).toBe(true);
    let thrown: unknown;
    try {
      port.read('ledger/x.json');
    } catch (error) {
      thrown = error;
    }
    expect((thrown as BlobPortError).code).toBe('blob_read_failed');
    expect(thrown).not.toBeNull();
  });

  it('删除失败时抛 blob_remove_failed（不静默当成已删）', () => {
    const root = makeTempRoot();
    const port = new FileBlobPort({
      root,
      fs: new FaultyFileSystem({ failRemove: () => true }),
    });
    expect(() => port.remove('k.json')).toThrowError(/blob_remove_failed/);
  });

  it('写失败（rename 抛）=> blob_write_failed，且不留半个目标文件', () => {
    const root = makeTempRoot();
    const port = new FileBlobPort({
      root,
      fs: new FaultyFileSystem({ failRename: () => true }),
    });
    let thrown: unknown;
    try {
      port.write('k.json', 'v');
    } catch (error) {
      thrown = error;
    }
    expect((thrown as BlobPortError).code).toBe('blob_write_failed');
    expect(port.exists('k.json')).toBe(false);
    // 临时文件已被尽力清掉。
    expect(countFiles(join(root, 'blobs'))).toBe(0);
  });
});

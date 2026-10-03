/**
 * K-I06 独立验证 ②：**读失败 / 损坏 / schema 不符 ≠ 空库**——经**真实存储端口**驱动。
 *
 * 这是 K08 红线（读失败不得退化成空库）在**适配层**的复现。判据不拿实现自证：
 *   - "真实读失败"由**真磁盘上的边车损坏**制造（`FileStoragePort.readBlob` 真抛错）；
 *   - "非法 UTF-8"由**真实字节**制造；
 *   - "端口报 failed"由装饰器覆盖契约分支（底层仍是真实后端）。
 * 任一情形若落成 `not_found` / `empty`，本组用例红。
 */

import { describe, expect, it } from 'vitest';

import { MemoryStoragePort } from '../../../apps/mobile-kernel/storage/index.js';
import { FileStoragePort } from '../../../apps/mobile-kernel/storage/index.js';
import { createStorageMemoryPersistence } from '../../../apps/mobile-kernel/adapters/memory-store/index.js';
import {
  DEFAULT_MEMORY_KEY,
  isMemoryPersistenceError,
  openPhoneMemory,
  openPhoneMemoryOrThrow,
} from '../../../apps/mobile-kernel/memory/index.js';
import { FaultyStoragePort, NodeFileSystem, corruptMeta, dataPathFor, makeTempRoot, removeTempRoot } from './support.js';

const KEY = DEFAULT_MEMORY_KEY;

/** 独立捕获拒绝，返回错误码（非本线错误返回 'not-memory-error'，绝不静默通过）。 */
async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return isMemoryPersistenceError(error) ? error.code : 'not-memory-error';
  }
}

describe('K-I06 ② 读失败 / 损坏 ≠ 空库', () => {
  it('key 从未写过 ⇒ not_found（唯一空库路径）；openPhoneMemory ⇒ empty', async () => {
    const port = createStorageMemoryPersistence(new MemoryStoragePort({ now: () => 0 }));
    expect(await port.read(KEY)).toEqual({ kind: 'not_found' });
    const opened = await openPhoneMemory({ port });
    expect(opened.kind).toBe('empty');
    if (opened.kind === 'empty') expect(opened.store.allEntries()).toHaveLength(0);
  });

  it('真实 FileStoragePort：边车损坏 ⇒ readBlob 抛错 ⇒ failed(read_failed)，不是空库', async () => {
    const root = makeTempRoot();
    try {
      const fs = new NodeFileSystem();
      const storage = new FileStoragePort({ root, fs, now: () => 0 });
      // 先真实写入一段字节（内容 + 边车都落盘）。
      const okWrite = await createStorageMemoryPersistence(storage).write(KEY, '{"schema":"potbot-memory-backup.v1"}');
      expect(okWrite).toEqual({ kind: 'ok' });
      expect(fs.exists(dataPathFor(root, KEY))).toBe(true);

      // 破坏边车（真实介质损坏，非注入装饰器）——readBlob 读边车时会抛错。
      corruptMeta(root, KEY);

      const port = createStorageMemoryPersistence(storage);
      const read = await port.read(KEY);
      if (read.kind !== 'failed') {
        throw new Error(`期望 failed，实际 ${read.kind}（损坏被当成了空库/读到）`);
      }
      expect(read.reason).toBe('read_failed');
      expect(read.detail.length).toBeGreaterThan(0);
      expect(port.calls.read).toBe(1);

      const opened = await openPhoneMemory({ port });
      expect(opened.kind).toBe('failed');
      // 失败分支不得携带 store：调用方在类型上就拿不到空库。
      expect('store' in (opened as Record<string, unknown>)).toBe(false);
    } finally {
      removeTempRoot(root);
    }
  });

  it('StoragePort 报 readBlob status:failed ⇒ failed(read_failed)（契约分支，绝不是 not_found）', async () => {
    const faulty = new FaultyStoragePort(new MemoryStoragePort({ now: () => 0 }));
    faulty.setReadFault(true);
    const port = createStorageMemoryPersistence(faulty);
    const read = await port.read(KEY);
    if (read.kind !== 'failed') throw new Error(`期望 failed，实际 ${read.kind}`);
    expect(read.reason).toBe('read_failed');
    expect(read.kind).not.toBe('not_found');

    const opened = await openPhoneMemory({ port });
    expect(opened.kind).toBe('failed');
  });

  it('readBlob 抛错（非 StorageError 也接住）⇒ failed(read_failed)', async () => {
    const faulty = new FaultyStoragePort(new MemoryStoragePort({ now: () => 0 }));
    faulty.setReadThrow(true);
    const read = await createStorageMemoryPersistence(faulty).read(KEY);
    if (read.kind !== 'failed') throw new Error(`期望 failed，实际 ${read.kind}`);
    expect(read.reason).toBe('read_failed');
    expect(read.detail).toContain('disk media unreachable');
  });

  it('介质上是非法 UTF-8 字节 ⇒ failed(corrupt)（读到了但解不成字符串）', async () => {
    const storage = new MemoryStoragePort({ now: () => 0 });
    const uri = storage.getContentUri({ relativePath: KEY }).uri;
    await storage.writeStream({ uri, chunks: [new Uint8Array([0xff, 0xfe, 0x00, 0x7b])] });

    const port = createStorageMemoryPersistence(storage);
    const read = await port.read(KEY);
    if (read.kind !== 'failed') throw new Error(`期望 failed，实际 ${read.kind}`);
    expect(read.reason).toBe('corrupt');

    const opened = await openPhoneMemory({ port });
    expect(opened.kind).toBe('failed');
  });

  it('介质上是损坏 JSON（合法 UTF-8）⇒ 端口 ok，openPhoneMemory ⇒ failed(corrupt)，不是 empty', async () => {
    const storage = new MemoryStoragePort({ now: () => 0 });
    await createStorageMemoryPersistence(storage).write(KEY, '{ this is not valid json');

    const port = createStorageMemoryPersistence(storage);
    // 字节层面确实读得到（ok）——判"损坏"是上层的解析结论，不是适配器编的。
    expect((await port.read(KEY)).kind).toBe('ok');

    const opened = await openPhoneMemory({ port });
    expect(opened.kind).not.toBe('empty');
    if (opened.kind !== 'failed') throw new Error(`期望 failed，实际 ${opened.kind}`);
    expect(opened.reason).toBe('corrupt');
  });

  it('介质上是 schema 不符的 JSON ⇒ failed(bad_schema)，不是 empty', async () => {
    const wrongSchema = JSON.stringify({
      schema: 'potbot-memory-backup.v0',
      created_at: 0,
      owner_scope: [],
      snapshot: {
        session_messages: [],
        task_facts: [],
        preferences: [],
        template_experiences: [],
        tombstones: [],
        derived: [],
      },
    });
    const storage = new MemoryStoragePort({ now: () => 0 });
    await createStorageMemoryPersistence(storage).write(KEY, wrongSchema);

    const opened = await openPhoneMemory({ port: createStorageMemoryPersistence(storage) });
    expect(opened.kind).toBe('failed');
    if (opened.kind !== 'failed') throw new Error('unreachable');
    expect(opened.reason).toBe('bad_schema');
  });

  it('电脑绝对路径 key ⇒ failed（可区分 desktop_path_rejected），绝不当空库', async () => {
    const port = createStorageMemoryPersistence(new MemoryStoragePort({ now: () => 0 }));
    const read = await port.read('C:/Users/example/memory.json');
    if (read.kind !== 'failed') throw new Error(`期望 failed，实际 ${read.kind}`);
    expect(read.detail).toContain('desktop_path_rejected');

    const opened = await openPhoneMemory({ port, key: '/home/example/memory.json' });
    expect(opened.kind).toBe('failed');
  });

  it('openPhoneMemoryOrThrow：读失败 ⇒ 抛 load_failed（不给"默默当空"的机会）', async () => {
    const faulty = new FaultyStoragePort(new MemoryStoragePort({ now: () => 0 }));
    faulty.setReadFault(true);
    expect(await rejectionCode(openPhoneMemoryOrThrow({ port: createStorageMemoryPersistence(faulty) }))).toBe(
      'load_failed',
    );
  });
});

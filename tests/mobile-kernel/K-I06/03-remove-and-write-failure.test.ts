/**
 * K-I06 独立验证 ③：**remove 的诚实边界**与**写失败不宣称已保存**。
 *
 * `StoragePort` 没有删除 operation，所以删除是一个**能力边界**：
 *   - 未注入删除钩子 ⇒ `remove` 必须 `failed`（拒绝用"写空串"冒充删除）；
 *   - 注入钩子但没真删 ⇒ `remove` 必须 `failed`（回读校验咬住）；
 *   - 注入钩子且真删 ⇒ `remove` ok 且随后 `read` 回到 `not_found`。
 * 写侧同理：任何非 ok 的写结果都必须让 `save()` 返回 `ok:false`。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime } from '../../../src/protocol/index.js';
import { FileStoragePort, MemoryStoragePort } from '../../../apps/mobile-kernel/storage/index.js';
import { createStorageMemoryPersistence } from '../../../apps/mobile-kernel/adapters/memory-store/index.js';
import { DEFAULT_MEMORY_KEY, openPhoneMemory } from '../../../apps/mobile-kernel/memory/index.js';
import {
  FaultyStoragePort,
  NodeFileSystem,
  dataPathFor,
  makeTempRoot,
  metaPathFor,
  removeTempRoot,
} from './support.js';

const OWNER = 'u1';
const KEY = DEFAULT_MEMORY_KEY;
const URI_PREFIX = 'content://potbot/';

describe('K-I06 ③ remove 的诚实边界', () => {
  it('未注入删除钩子 ⇒ remove failed（拒绝用"写空串"冒充删除）', async () => {
    const port = createStorageMemoryPersistence(new MemoryStoragePort({ now: () => 0 }));
    const out = await port.remove(KEY);
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') {
      expect(out.detail).toContain('removeBlob');
      expect(out.detail).toContain('not_found');
    }
    expect(port.calls.remove).toBe(1);
  });

  it('注入删除钩子 + 真实 FileStoragePort ⇒ remove ok，随后 read = not_found', async () => {
    const root = makeTempRoot();
    try {
      const fs = new NodeFileSystem();
      const storage = new FileStoragePort({ root, fs, now: () => 0 });
      const port = createStorageMemoryPersistence(storage, {
        removeBlob: (uri) => {
          const rel = uri.replace(URI_PREFIX, '');
          fs.removeFile(dataPathFor(root, rel));
          fs.removeFile(metaPathFor(root, rel));
        },
      });

      await port.write(KEY, '{"schema":"potbot-memory-backup.v1"}');
      expect((await port.read(KEY)).kind).toBe('ok');

      const removed = await port.remove(KEY);
      expect(removed).toEqual({ kind: 'ok' });
      // 删除可验证：read 回到唯一的空库态 not_found。
      expect(await port.read(KEY)).toEqual({ kind: 'not_found' });
    } finally {
      removeTempRoot(root);
    }
  });

  it('删除钩子没真删 ⇒ remove failed（回读校验咬住），内容仍在', async () => {
    const root = makeTempRoot();
    try {
      const fs = new NodeFileSystem();
      const storage = new FileStoragePort({ root, fs, now: () => 0 });
      const port = createStorageMemoryPersistence(storage, {
        removeBlob: () => {
          /* 假删除：什么都不做 */
        },
      });
      await port.write(KEY, '{"schema":"potbot-memory-backup.v1"}');

      const removed = await port.remove(KEY);
      expect(removed.kind).toBe('failed');
      if (removed.kind === 'failed') expect(removed.detail).toContain('未确认删除');
      // 没删掉就是没删掉：内容读得回。
      expect((await port.read(KEY)).kind).toBe('ok');
    } finally {
      removeTempRoot(root);
    }
  });
});

describe('K-I06 ③ 写失败不宣称已保存', () => {
  it('writeStream 报 failed ⇒ write failed 且 store.save ok:false，介质无备份', async () => {
    const faulty = new FaultyStoragePort(new MemoryStoragePort({ now: () => 0 }));
    const port = createStorageMemoryPersistence(faulty);
    const opened = await openPhoneMemory({ port });
    if (opened.kind !== 'empty') throw new Error('unreachable');
    opened.store.rememberPreference({ owner_id: OWNER, preference_key: 'k', value_text: 'v' });

    faulty.setWriteFault(true);
    const saved = await opened.store.save(asLogicalTime(1));
    expect(saved.ok).toBe(false);
    if (saved.ok === false) expect(saved.reason).toBe('save_failed');

    const direct = await port.write(KEY, 'x');
    expect(direct.kind).toBe('failed');
    // 介质上仍没有备份。
    expect(await port.read(KEY)).toEqual({ kind: 'not_found' });
  });

  it('writeStream 抛错 ⇒ write failed（接住异常，不冒泡）', async () => {
    const faulty = new FaultyStoragePort(new MemoryStoragePort({ now: () => 0 }));
    faulty.setWriteThrow(true);
    const out = await createStorageMemoryPersistence(faulty).write(KEY, 'x');
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') expect(out.detail).toContain('disk full');
  });

  it('电脑绝对路径 key 的 write ⇒ failed（形状违规也如实失败）', async () => {
    const port = createStorageMemoryPersistence(new MemoryStoragePort({ now: () => 0 }));
    const out = await port.write('C:/Users/example/memory.json', 'x');
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') expect(out.detail).toContain('desktop_path_rejected');
  });
});

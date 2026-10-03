/**
 * K-I06 独立验证 ①：**save → reopen 经真实 `StoragePort`**（记忆库的持久化落到 K09 存储上）。
 *
 * 判据独立于实现：内容能否跨存储实例读回，由**真实介质**决定——
 * 内存后端是同一 `Map`，文件后端是**真磁盘上重新构造的实例**（等价进程重开）。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime } from '../../../src/protocol/index.js';
import { FileStoragePort, MemoryStoragePort } from '../../../apps/mobile-kernel/storage/index.js';
import { createStorageMemoryPersistence } from '../../../apps/mobile-kernel/adapters/memory-store/index.js';
import { DEFAULT_MEMORY_KEY, openPhoneMemory } from '../../../apps/mobile-kernel/memory/index.js';
import { NodeFileSystem, dataPathFor, makeTempRoot, metaPathFor, removeTempRoot } from './support.js';

const OWNER = 'u1';
const KEY = DEFAULT_MEMORY_KEY;

describe('K-I06 ① save → reopen 经真实 StoragePort', () => {
  it('MemoryStoragePort：空库 read=not_found → save → 新适配器重开 loaded', async () => {
    const storage = new MemoryStoragePort({ now: () => 0 });
    const port = createStorageMemoryPersistence(storage);

    // 空库的唯一合法来源：not_found（key 从未写过）。
    expect(await port.read(KEY)).toEqual({ kind: 'not_found' });

    const opened = await openPhoneMemory({ port });
    expect(opened.kind).toBe('empty');
    if (opened.kind !== 'empty') throw new Error('unreachable');

    const written = opened.store.rememberPreference({
      owner_id: OWNER,
      preference_key: 'city',
      value_text: '上海',
      memory_id: 'pref-1',
    });
    expect(written.ok).toBe(true);

    const saved = await opened.store.save(asLogicalTime(100));
    expect(saved.ok).toBe(true);

    // 写完端口读到 ok（不再是 not_found）。
    const after = await port.read(KEY);
    expect(after.kind).toBe('ok');

    // 重开：新适配器实例读同一介质。
    const reopened = await openPhoneMemory({ port: createStorageMemoryPersistence(storage) });
    expect(reopened.kind).toBe('loaded');
    if (reopened.kind !== 'loaded') throw new Error('unreachable');
    const prefs = reopened.store.listByKind('preference');
    expect(prefs).toHaveLength(1);
    expect(prefs[0]?.memory_id).toBe('pref-1');
    if (prefs[0]?.kind === 'preference') expect(prefs[0].value_text).toBe('上海');
    expect(reopened.report.incoming_entries).toBe(1);
  });

  it('FileStoragePort：真实磁盘 save → 构造新存储实例重开 → 记忆仍在（跨实例/跨"进程"）', async () => {
    const root = makeTempRoot();
    try {
      const fs = new NodeFileSystem();
      const storage1 = new FileStoragePort({ root, fs, now: () => 0 });
      const opened = await openPhoneMemory({ port: createStorageMemoryPersistence(storage1) });
      expect(opened.kind).toBe('empty');
      if (opened.kind !== 'empty') throw new Error('unreachable');

      opened.store.rememberPreference({
        owner_id: OWNER,
        preference_key: 'city',
        value_text: '上海',
        memory_id: 'pref-1',
      });
      const saved = await opened.store.save(asLogicalTime(100));
      expect(saved.ok).toBe(true);

      // 磁盘上真的有内容 + 边车（不是内存里自说自话）。
      expect(fs.exists(dataPathFor(root, KEY))).toBe(true);
      expect(fs.exists(metaPathFor(root, KEY))).toBe(true);

      // 新存储实例 = 进程重开：只可能从磁盘恢复。
      const storage2 = new FileStoragePort({ root, fs, now: () => 0 });
      const reopened = await openPhoneMemory({ port: createStorageMemoryPersistence(storage2) });
      expect(reopened.kind).toBe('loaded');
      if (reopened.kind !== 'loaded') throw new Error('unreachable');
      const prefs = reopened.store.listByKind('preference');
      expect(prefs).toHaveLength(1);
      expect(prefs[0]?.memory_id).toBe('pref-1');
      if (prefs[0]?.kind === 'preference') expect(prefs[0].value_text).toBe('上海');
    } finally {
      removeTempRoot(root);
    }
  });

  it('端口写出的字节可被 store 反序列化（write 的结果不是"看着像"）', async () => {
    const storage = new MemoryStoragePort({ now: () => 0 });
    const port = createStorageMemoryPersistence(storage);
    const opened = await openPhoneMemory({ port });
    if (opened.kind !== 'empty') throw new Error('unreachable');
    opened.store.rememberPreference({ owner_id: OWNER, preference_key: 'k', value_text: 'v' });
    await opened.store.save(asLogicalTime(1));

    const raw = await port.read(KEY);
    expect(raw.kind).toBe('ok');
    if (raw.kind !== 'ok') throw new Error('unreachable');
    // 直接 JSON.parse：端口交出的确实是备份 JSON。
    expect(() => JSON.parse(raw.bytes)).not.toThrow();
    expect(JSON.parse(raw.bytes)).toMatchObject({ schema: expect.any(String) });
  });
});

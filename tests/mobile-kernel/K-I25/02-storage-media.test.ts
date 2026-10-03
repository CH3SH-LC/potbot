/**
 * K-I25 ② `StorageMedia`：把崩溃安全的日志库跑在**真实文件字节**上（`node:fs` 适配
 * K09 `FileSystemPort`）。
 *
 * 判据都断言**可观测结局**（磁盘上到底有什么、重开读到什么），不是"没抛错就算过"：
 *  §1 落盘：durable 前缀真实写进文件，`durable()` 从文件读回。
 *  §2 未 sync 崩（`sync:before`）：文件不含该帧，重开丢失。
 *  §3 已 sync 崩（`sync:after`）：文件已含该帧，重开存活。
 *  §4 撕裂写：文件尾部半条帧，重开丢弃且**把文件截断回合法前缀**，再续写。
 *  §5 真磁盘迁移：升级帧落文件，重开已到新版本、回填字段正确。
 */

import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  KernelJournalStore,
  StorageMedia,
  encodeFrame,
  encodeFrames,
} from '../../../apps/mobile-kernel/journal/index.js';
import type { Frame, KillHooks } from '../../../apps/mobile-kernel/journal/index.js';
import { SimulatedCrash, crashOn, mergeHooks, tornSyncOn } from '../K-R02/simulate-crash.js';
import { NodeFileSystem, bytesEqual, cleanupRoots, newRoot, putKey } from './support.js';

const fs = new NodeFileSystem();

afterEach(cleanupRoots);

function openOnDisk(root: string, kill?: KillHooks): { store: KernelJournalStore; path: string } {
  const path = join(root, 'kernel.journal');
  const media = StorageMedia.open({ fs, path });
  return { store: KernelJournalStore.open({ media, kill }), path };
}

const frameA: Frame = { kind: 'put', seq: 1, payload: { key: 'a', value: '1' } };
const frameB: Frame = { kind: 'put', seq: 2, payload: { key: 'b', value: '2' } };

describe('K-I25 §1 StorageMedia 落盘：durable 前缀真实写进文件', () => {
  it('两条 put 后，文件字节 == 两条帧的编码；durable() 从文件读回', () => {
    const root = newRoot('potbot-k-i25-');
    const path = join(root, 'kernel.journal');
    const media = StorageMedia.open({ fs, path });
    const store = KernelJournalStore.open({ media });
    store.put('a', '1');
    store.put('b', '2');

    const expected = encodeFrames([frameA, frameB]);
    expect(bytesEqual(media.durable(), expected)).toBe(true);
    expect(bytesEqual(fs.readFile(path), expected)).toBe(true);
    expect(media.pendingBytes()).toBe(0);

    const restarted = KernelJournalStore.open({ media: StorageMedia.open({ fs, path }) });
    expect([...restarted.entries().keys()]).toEqual(['a', 'b']);
    expect(restarted.recovery.discardedBytes).toBe(0);
  });
});

describe('K-I25 §2 未 sync 崩：文件不含该帧，重开丢失', () => {
  it('sync:before 崩在 b：文件只含 a 的帧；新实例重开只有 a', () => {
    const root = newRoot('potbot-k-i25-');
    const path = join(root, 'kernel.journal');
    const media = StorageMedia.open({ fs, path });
    KernelJournalStore.open({ media }).put('a', '1');

    const doomed = KernelJournalStore.open({
      media,
      kill: crashOn('sync:before', { onFrame: putKey('b') }),
    });
    expect(() => doomed.put('b', '2')).toThrow(SimulatedCrash);
    // 脏区有未落盘字节，但真实文件没变。
    expect(media.pendingBytes()).toBeGreaterThan(0);
    expect(bytesEqual(media.durable(), encodeFrame(frameA))).toBe(true);

    const restarted = KernelJournalStore.open({ media: StorageMedia.open({ fs, path }) });
    expect([...restarted.entries().keys()]).toEqual(['a']);
    expect(restarted.get('b').status).toBe('not-found');
  });
});

describe('K-I25 §3 已 sync 崩：文件已含该帧，重开存活', () => {
  it('sync:after 崩在 b：重开仍读到 a、b（不能当失败丢弃）', () => {
    const root = newRoot('potbot-k-i25-');
    const path = join(root, 'kernel.journal');
    const media = StorageMedia.open({ fs, path });
    KernelJournalStore.open({ media }).put('a', '1');

    const doomed = KernelJournalStore.open({
      media,
      kill: crashOn('sync:after', { onFrame: putKey('b') }),
    });
    expect(() => doomed.put('b', '2')).toThrow(SimulatedCrash);

    const restarted = KernelJournalStore.open({ media: StorageMedia.open({ fs, path }) });
    expect([...restarted.entries().keys()]).toEqual(['a', 'b']);
    expect(restarted.get('b').entry?.value).toBe('2');
    expect(restarted.recovery.discardedBytes).toBe(0);
  });
});

describe('K-I25 §4 撕裂写：文件尾部半条帧被丢弃并截断', () => {
  it('落一半的 c 崩：重开丢弃半帧、把文件截回 a+b，再续写 d 可读回', () => {
    const root = newRoot('potbot-k-i25-');
    const path = join(root, 'kernel.journal');
    const media = StorageMedia.open({ fs, path });
    const store = KernelJournalStore.open({ media });
    store.put('a', '1');
    store.put('b', '2');
    const cleanLength = media.durable().length;

    const torn = mergeHooks(
      tornSyncOn(0.5, { onFrame: putKey('c') }),
      crashOn('sync:after', { onFrame: putKey('c') }),
    );
    const doomed = openOnDisk(root, torn).store;
    expect(() => doomed.put('c', '3')).toThrow(SimulatedCrash);

    // 介质尾部此刻是"半条帧"：文件比干净前缀长。
    expect(fs.readFile(path).length).toBeGreaterThan(cleanLength);

    const restarted = KernelJournalStore.open({ media: StorageMedia.open({ fs, path }) });
    expect([...restarted.entries().keys()]).toEqual(['a', 'b']);
    expect(restarted.recovery.discardedBytes).toBeGreaterThan(0);
    expect(['incomplete-frame', 'bad-digest', 'incomplete-header']).toContain(
      restarted.recovery.discardedReason,
    );
    // 恢复即截断：真实文件回到合法前缀长度。
    expect(fs.readFile(path).length).toBe(cleanLength);

    restarted.put('d', '4');
    const final = KernelJournalStore.open({ media: StorageMedia.open({ fs, path }) });
    expect([...final.entries().keys()].sort()).toEqual(['a', 'b', 'd']);
    expect(final.recovery.discardedBytes).toBe(0);
    expect(final.recovery.discardedReason).toBe('none');
  });
});

describe('K-I25 §5 真磁盘迁移：升级帧落文件、重开已到新版本', () => {
  it('put 后 migrate()：重开 schemaVersion=3、旧条目回填 updatedAt=0 / tags=[]', () => {
    const root = newRoot('potbot-k-i25-');
    const path = join(root, 'kernel.journal');
    const media = StorageMedia.open({ fs, path });
    const store = KernelJournalStore.open({ media });
    store.put('a', '1');
    const result = store.migrate();
    expect(result.to).toBe(3);

    const restarted = KernelJournalStore.open({ media: StorageMedia.open({ fs, path }) });
    expect(restarted.schemaVersion).toBe(3);
    expect(restarted.get('a').entry).toEqual({ key: 'a', value: '1', updatedAt: 0, tags: [] });
    expect(restarted.recovery.discardedBytes).toBe(0);
  });
});

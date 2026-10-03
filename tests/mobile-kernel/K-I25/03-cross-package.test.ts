/**
 * K-I25 ③ 跨包一致性：提升后的日志库与 K09 存储模块**共用一个事实源**。
 *
 * 断言：
 *  §1 帧尾摘要 == K09 `sha256Digest(帧体)`——撕裂写校验锚在 K09 的纯 TS SHA-256 上，
 *     不是另造一份摘要；
 *  §2 `PersistentMedia`（内存模型）与 `StorageMedia`（真文件）在同样操作序列下产出
 *     **逐字节相同**的持久字节——存储后端是内存后端的忠实替代；
 *  §3 从两者字节 `recoverJournal` 得到**相同**的派生状态与恢复报告。
 */

import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HEADER_LEN,
  DIGEST_LEN,
  KernelJournalStore,
  PersistentMedia,
  StorageMedia,
  encodeFrame,
  recoverJournal,
} from '../../../apps/mobile-kernel/journal/index.js';
import type { Frame } from '../../../apps/mobile-kernel/journal/index.js';
import { sha256Digest } from '../../../apps/mobile-kernel/storage/index.js';
import { NodeFileSystem, bytesEqual, cleanupRoots, newRoot } from './support.js';

const fs = new NodeFileSystem();
const DECODER = new TextDecoder('utf-8');

afterEach(cleanupRoots);

const frames: readonly Frame[] = [
  { kind: 'put', seq: 1, payload: { key: 'a', value: '1' } },
  { kind: 'put', seq: 2, payload: { key: 'b', value: '2' } },
  { kind: 'delete', seq: 3, payload: { key: 'a' } },
];

describe('K-I25 §1 帧摘要锚在 K09 sha256', () => {
  it('帧尾 64 字节 == sha256Digest(帧体) 去掉 `sha256:` 前缀', () => {
    for (const frame of frames) {
      const encoded = encodeFrame(frame);
      const body = encoded.subarray(0, encoded.length - DIGEST_LEN);
      const trailer = DECODER.decode(encoded.subarray(encoded.length - DIGEST_LEN));
      expect(trailer).toBe(sha256Digest(body).slice('sha256:'.length));
      expect(encoded.length).toBe(HEADER_LEN + body.length - HEADER_LEN + DIGEST_LEN);
    }
  });
});

describe('K-I25 §2 内存介质与存储介质字节一致', () => {
  it('同样操作序列 ⇒ 两种介质的 durable 字节逐字节相同', () => {
    const memory = new PersistentMedia();
    const memoryStore = KernelJournalStore.open({ media: memory });

    const root = newRoot('potbot-k-i25-x-');
    const path = join(root, 'kernel.journal');
    const disk = StorageMedia.open({ fs, path });
    const diskStore = KernelJournalStore.open({ media: disk });

    for (const store of [memoryStore, diskStore]) {
      store.put('a', '1');
      store.put('b', '2');
      store.delete('a');
      store.migrate();
    }

    expect(bytesEqual(memory.durable(), disk.durable())).toBe(true);
    expect(bytesEqual(disk.durable(), fs.readFile(path))).toBe(true);
  });
});

describe('K-I25 §3 恢复等价：同字节 ⇒ 同状态', () => {
  it('两种介质字节上的 recoverJournal 结果一致', () => {
    const bytes = ((): Uint8Array => {
      const root = newRoot('potbot-k-i25-x-');
      const path = join(root, 'kernel.journal');
      const media = StorageMedia.open({ fs, path });
      const store = KernelJournalStore.open({ media });
      store.put('a', '1');
      store.put('b', '2');
      return media.durable();
    })();

    const a = recoverJournal(bytes);
    const b = recoverJournal(bytes);
    const serialize = (r: typeof a): unknown => ({
      v: r.state.schemaVersion,
      entries: [...r.state.entries.entries()],
      recovery: r.recovery,
    });
    expect(serialize(a)).toEqual(serialize(b));
    expect(a.recovery.discardedBytes).toBe(0);
    expect(a.recovery.framesApplied).toBe(2);
  });
});

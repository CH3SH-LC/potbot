/**
 * K-I08 ①：K10 `TaskLedger` 的落盘 / 冷启动恢复。
 *
 * 硬判据：
 * 1. 存 → 读 往返后任务视图 / 游标 / 日志与原地一致；
 * 2. **blob 不存在**才是干净起点（`null`）；
 * 3. 快照存在但损坏 / 截断 / 版本或类别不符 / 读端口报错，**一律 `invalid_snapshot`**，
 *    绝不返回空账本；
 * 4. 真正落到 K09 `StoragePort`（`MemoryStoragePort`）上也能往返。
 */

import { describe, expect, it } from 'vitest';

import { TaskLedger } from '../../../apps/mobile-kernel/lifecycle/ledger.js';
import { MemoryStoragePort } from '../../../apps/mobile-kernel/storage/memory-store.js';
import {
  LedgerBlobStore,
  MemoryBlobStore,
  StoragePortBlobStore,
  TASK_LEDGER_KEY,
  TaskLedgerStore,
  decodeUtf8Strict,
  isLedgerStoreError,
} from '../../../apps/mobile-kernel/adapters/ledger-store/index.js';
import { manualClock } from './fixtures.js';

function storeOver(blob: MemoryBlobStore | StoragePortBlobStore, key = TASK_LEDGER_KEY): TaskLedgerStore {
  return new TaskLedgerStore(new LedgerBlobStore(blob, key));
}

function seededLedger(): TaskLedger {
  const ledger = new TaskLedger({ clock: manualClock() });
  ledger.registerTask({ taskId: 't1', stepIds: ['s1', 's2', 's3'] });
  ledger.startRun('t1');
  ledger.completeStep('t1', 's1');
  ledger.completeStep('t1', 's2');
  ledger.registerTask({ taskId: 't2', stepIds: ['a'] });
  ledger.beginExternalIntent('t2', 'sub:task-2:act-1');
  return ledger;
}

describe('K-I08 ① 任务账本往返（内存 blob 后端）', () => {
  it('存 → 读 往返后视图 / 游标 / 日志与原地逐项一致', async () => {
    const blob = new MemoryBlobStore();
    const store = storeOver(blob);
    const original = seededLedger();

    await store.save(original);
    const restored = await store.load({ clock: manualClock() });

    expect(restored).not.toBeNull();
    expect(restored!.tasks()).toEqual(original.tasks());
    expect(restored!.cursor('t1')).toBe(2);
    expect(restored!.cursor('t2')).toBe(0);
    expect(restored!.journal()).toHaveLength(original.journal().length);
    expect(restored!.snapshot()).toBe(original.snapshot());
  });

  it('blob 不存在 = 干净起点（null），不是错误', async () => {
    const store = storeOver(new MemoryBlobStore());
    expect(await store.load({ clock: manualClock() })).toBeNull();
  });
});

describe('K-I08 ① 坏快照一律 invalid_snapshot（绝不当空账本）', () => {
  it('非 JSON / 截断（partial）/ 版本不符 / 类别不符 / 缺 payload 全部抛 invalid_snapshot', async () => {
    const cases: Array<[string, string]> = [
      ['非 JSON', '{not json'],
      ['截断的 partial 快照', '{"schema":"potbot.ledger-store","ledger":"task","version":1,"payl'],
      [
        '版本不符',
        JSON.stringify({ schema: 'potbot.ledger-store', ledger: 'task', version: 99, payload: 'x' }),
      ],
      [
        '账本类别不符',
        JSON.stringify({ schema: 'potbot.ledger-store', ledger: 'authorization', version: 1, payload: 'x' }),
      ],
      ['缺 payload', JSON.stringify({ schema: 'potbot.ledger-store', ledger: 'task', version: 1 })],
      [
        '负载不是合法快照',
        JSON.stringify({ schema: 'potbot.ledger-store', ledger: 'task', version: 1, payload: '{"version":1,"entries":[' }),
      ],
    ];
    for (const [label, text] of cases) {
      const blob = new MemoryBlobStore({ key: TASK_LEDGER_KEY, text });
      const store = storeOver(blob);
      let caught: unknown;
      try {
        await store.load({ clock: manualClock() });
      } catch (error) {
        caught = error;
      }
      expect(caught, `${label} 必须抛错`).not.toBeUndefined();
      expect(isLedgerStoreError(caught), `${label} 必须是 LedgerStoreError`).toBe(true);
      expect((caught as { code: string }).code, label).toBe('invalid_snapshot');
    }
  });

  it('读端口报错 → invalid_snapshot（不是 null / 不是空账本）', async () => {
    const blob = new MemoryBlobStore(undefined, { failRead: { detail: '介质不可达' } });
    const store = storeOver(blob);
    let caught: unknown;
    try {
      const result = await store.load({ clock: manualClock() });
      expect(result).toBeNull(); // 不该走到这里
    } catch (error) {
      caught = error;
    }
    expect(isLedgerStoreError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('invalid_snapshot');
    expect((caught as { reason: string }).reason).toBe('read-failed');
  });
});

describe('K-I08 ① 真正落到 K09 StoragePort', () => {
  it('经 MemoryStoragePort 往返；坏字节（非 UTF-8）→ invalid_snapshot', async () => {
    const port = new MemoryStoragePort({ now: () => 0 });
    const store = storeOver(new StoragePortBlobStore(port));
    const original = seededLedger();
    await store.save(original);
    const restored = await store.load({ clock: manualClock() });
    expect(restored!.snapshot()).toBe(original.snapshot());

    // 直接往介质里塞非法 UTF-8 字节，读取必须失败（不是空账本）。
    const uri = port.getContentUri({ relativePath: TASK_LEDGER_KEY }).uri;
    await port.writeStream({ uri, chunks: [new Uint8Array([0xff, 0xfe, 0x00])] });
    let caught: unknown;
    try {
      await store.load({ clock: manualClock() });
    } catch (error) {
      caught = error;
    }
    expect(isLedgerStoreError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('invalid_snapshot');
    expect((caught as { reason: string }).reason).toBe('read-failed');
  });

  it('严格 UTF-8 解码：非法序列抛错而不是静默替换成 U+FFFD', () => {
    expect(() => decodeUtf8Strict(new Uint8Array([0xc3, 0x28]))).toThrow();
    expect(() => decodeUtf8Strict(new Uint8Array([0xff]))).toThrow();
    expect(decodeUtf8Strict(new Uint8Array([0x7b, 0x7d]))).toBe('{}');
    expect(decodeUtf8Strict(new Uint8Array([0xe4, 0xb8, 0xad]))).toBe('中');
  });
});

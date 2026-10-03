/**
 * K-R02 独立验证 —— 杀进程 / 重启 / 升级（数据库迁移）故障注入。
 *
 * 判据（每条都断言**可观测结局**，不是"没抛错就算过"）：
 *
 * §1 重启一致性：无故障写入后重开，条目、版本、恢复报告都对。
 * §2 杀进程：五个注入点各杀一次，重启后状态符合「未落盘丢失 / 已落盘存活 / 撕裂丢弃」。
 * §3 撕裂写检测：对字节直接断言 decodeFrames 的丢弃原因（头缺失 / 摘要不符 / 魔数错）。
 * §4 升级 / 数据库迁移：多步迁移、崩溃落点在迁移前后、重试续跑、幂等、降级拒绝、版本过新拒绝。
 * §5 真实文件对拍：把持久字节写进真实临时文件、追加撕裂尾巴、截断、再续写，走真实 fs。
 * §6 词表自洽：故障点与注入脚手架一一对应、错误码唯一。
 *
 * 诚实边界见同目录 `README.md` §6：本 harness 的"崩溃"是**注入的确定性模型**，
 * 不是真实 kill -9 / 断电；真实 Android SQLite WAL 未验证。
 */

import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// 实现已提升为产品模块（`apps/mobile-kernel/journal/`，K-I25）：以下断言跑在**产品代码**上。
import {
  FAULT_POINTS,
  HEADER_LEN,
  KERNEL_DB_ERROR_CODES,
  KernelJournalError,
  KernelJournalStore,
  PersistentMedia,
  decodeFrames,
  encodeFrame,
  encodeFrames,
  isKernelJournalError,
  recoverJournal,
} from '../../../apps/mobile-kernel/journal/index.js';
// 崩溃注入脚手架是**测试专用**，留在本目录，不进产品树。
import { SimulatedCrash, crashOn, mergeHooks, tornSyncOn } from './simulate-crash.js';
import type { Frame, KillHooks, Media } from '../../../apps/mobile-kernel/journal/index.js';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function open(media: Media, kill?: KillHooks): KernelJournalStore {
  return KernelJournalStore.open({ media, kill });
}

/** 只对 key === k 的 put 帧触发。 */
function putKey(key: string): (frame: Frame) => boolean {
  return (frame) => frame.kind === 'put' && frame.payload.key === key;
}

const anyMigration = (frame: Frame): boolean => frame.kind === 'migration';

function keysOf(store: KernelJournalStore): string[] {
  return [...store.entries().keys()];
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// §1 重启一致性
// ---------------------------------------------------------------------------

describe('K-R02 §1 重启一致性：无故障写入 → 重开读到同样状态', () => {
  it('三条写入后重开，条目在、顺序在、恢复报告零丢弃', () => {
    const media = new PersistentMedia();
    const store = open(media);
    store.put('a', '1');
    store.put('b', '2');
    store.put('c', '3');
    expect(store.get('a').entry?.value).toBe('1');

    const restarted = open(media);
    expect(keysOf(restarted)).toEqual(['a', 'b', 'c']);
    expect(restarted.get('b').entry?.value).toBe('2');
    expect(restarted.schemaVersion).toBe(1);
    expect(restarted.recovery.framesApplied).toBe(3);
    expect(restarted.recovery.discardedBytes).toBe(0);
    expect(restarted.recovery.discardedReason).toBe('none');
    expect(restarted.recovery.lastSeq).toBe(3);
    expect(restarted.recovery.entryCount).toBe(3);
  });

  it('同键覆盖：重开后取最后一次写入的值，且只有一条条目', () => {
    const media = new PersistentMedia();
    const store = open(media);
    store.put('a', '1');
    store.put('a', '2');

    const restarted = open(media);
    expect(restarted.get('a').entry?.value).toBe('2');
    expect(restarted.recovery.entryCount).toBe(1);
  });

  it('删除后重开：被删键消失；删不存在的键返回 not-found 且不写日志', () => {
    const media = new PersistentMedia();
    const store = open(media);
    store.put('a', '1');
    store.put('b', '2');
    const missing = store.delete('zzz');
    expect(missing.status).toBe('not-found');
    expect(store.delete('a').status).toBe('ok');

    const restarted = open(media);
    expect(keysOf(restarted)).toEqual(['b']);
    expect(restarted.get('a').status).toBe('not-found');
  });
});

// ---------------------------------------------------------------------------
// §2 杀进程：五个注入点
// ---------------------------------------------------------------------------

describe('K-R02 §2 杀进程：注入点在写入前后各杀一次，重启后结局符合语义', () => {
  it('append:before —— 帧尚未写介质：该操作从未发生', () => {
    const media = new PersistentMedia();
    const store = open(media, crashOn('append:before', { onFrame: putKey('b') }));
    store.put('a', '1');
    expect(() => store.put('b', '2')).toThrow(SimulatedCrash);
    expect(media.pendingBytes()).toBe(0);

    const restarted = open(media);
    expect(keysOf(restarted)).toEqual(['a']);
    expect(restarted.get('b').status).toBe('not-found');
  });

  it('append:after —— 帧已写脏区但未落盘：崩溃丢失', () => {
    const media = new PersistentMedia();
    const store = open(media, crashOn('append:after', { onFrame: putKey('b') }));
    store.put('a', '1');
    expect(() => store.put('b', '2')).toThrow(SimulatedCrash);
    // 关键前提：字节确已"写"进介质，只是没同步。
    expect(media.pendingBytes()).toBeGreaterThan(0);

    const restarted = open(media);
    expect(keysOf(restarted)).toEqual(['a']);
  });

  it('sync:before —— 崩溃发生在 fsync 之前：丢失', () => {
    const media = new PersistentMedia();
    const store = open(media, crashOn('sync:before', { onFrame: putKey('b') }));
    store.put('a', '1');
    expect(() => store.put('b', '2')).toThrow(SimulatedCrash);
    expect(media.pendingBytes()).toBeGreaterThan(0);

    const restarted = open(media);
    expect(keysOf(restarted)).toEqual(['a']);
  });

  it('sync:after —— 已落盘但没拿到回执：数据仍在（不能当失败丢弃）', () => {
    const media = new PersistentMedia();
    const store = open(media, crashOn('sync:after', { onFrame: putKey('b') }));
    store.put('a', '1');
    expect(() => store.put('b', '2')).toThrow(SimulatedCrash);

    const restarted = open(media);
    expect(keysOf(restarted)).toEqual(['a', 'b']);
    expect(restarted.get('b').entry?.value).toBe('2');
    expect(restarted.recovery.discardedBytes).toBe(0);
  });

  it('sync:after 崩在写入之后：调用方看到"异常"但效果已持久（幂等重放不重复）', () => {
    const media = new PersistentMedia();
    const store = open(media, crashOn('sync:after', { onFrame: putKey('a') }));
    expect(() => store.put('a', '1')).toThrow(SimulatedCrash);

    const restarted = open(media);
    expect(restarted.get('a').entry?.value).toBe('1');
    expect(restarted.recovery.framesApplied).toBe(1);
  });

  it('sync:partial（撕裂写）—— 半条帧落盘：回放丢弃，旧的完整前缀保留', () => {
    const media = new PersistentMedia();
    const store = open(media);
    store.put('a', '1');

    const torn = mergeHooks(
      tornSyncOn(0.5, { onFrame: putKey('b') }),
      crashOn('sync:after', { onFrame: putKey('b') }),
    );
    const store2 = open(media, torn);
    expect(() => store2.put('b', '2')).toThrow(SimulatedCrash);

    const restarted = open(media);
    expect(keysOf(restarted)).toEqual(['a']);
    expect(restarted.recovery.discardedBytes).toBeGreaterThan(0);
    expect(['incomplete-frame', 'bad-digest', 'incomplete-header']).toContain(
      restarted.recovery.discardedReason,
    );
  });
});

// ---------------------------------------------------------------------------
// §3 撕裂写 / 损坏的直接字节断言
// ---------------------------------------------------------------------------

describe('K-R02 §3 撕裂写与损坏检测：对字节直接断言丢弃原因', () => {
  const frameA: Frame = { kind: 'put', seq: 1, payload: { key: 'a', value: '1' } };
  const frameB: Frame = { kind: 'put', seq: 2, payload: { key: 'b', value: '2' } };

  it('缺尾字节 → incomplete-frame，只回放前面的完整帧', () => {
    const bytes = encodeFrames([frameA, frameB]);
    const cut = bytes.subarray(0, bytes.length - 5);
    const decoded = decodeFrames(cut);
    expect(decoded.frames.length).toBe(1);
    expect(decoded.frames[0]!.payload).toEqual({ key: 'a', value: '1' });
    expect(decoded.discardedReason).toBe('incomplete-frame');
    // 丢弃的是**整条不完整帧的剩余字节**（不是被切掉的 5 字节）：validBytes 停在帧 A 末尾。
    expect(decoded.validBytes).toBe(encodeFrame(frameA).length);
    expect(decoded.discardedBytes).toBe(encodeFrame(frameB).length - 5);
  });

  it('改一个 payload 字节 → bad-digest，整帧被丢弃', () => {
    const bytes = encodeFrames([frameA]);
    const tampered = bytes.slice();
    tampered[HEADER_LEN] = (tampered[HEADER_LEN]! ^ 0xff) & 0xff;
    const decoded = decodeFrames(tampered);
    expect(decoded.frames.length).toBe(0);
    expect(decoded.discardedReason).toBe('bad-digest');
  });

  it('尾部追加垃圾字节 → bad-magic，之前的帧全保留', () => {
    const bytes = encodeFrames([frameA]);
    const withGarbage = concatBytes(bytes, new Uint8Array(20));
    const decoded = decodeFrames(withGarbage);
    expect(decoded.frames.length).toBe(1);
    expect(decoded.discardedReason).toBe('bad-magic');
    expect(decoded.validBytes).toBe(bytes.length);
  });

  it('不足一个头 → incomplete-header', () => {
    const bytes = encodeFrames([frameA]);
    const decoded = decodeFrames(bytes.subarray(0, HEADER_LEN - 4));
    expect(decoded.discardedReason).toBe('incomplete-header');
    expect(decoded.frames.length).toBe(0);
    expect(decoded.validBytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §4 升级 / 数据库迁移
// ---------------------------------------------------------------------------

describe('K-R02 §4 升级（数据库迁移）：原子、可续跑、幂等、拒绝降级', () => {
  it('多步迁移 1→2→3：重启后版本与回填字段都对', () => {
    const media = new PersistentMedia();
    const store = open(media);
    store.put('a', '1');
    store.put('b', '2');
    expect(store.schemaVersion).toBe(1);
    expect(store.get('a').entry?.updatedAt).toBeUndefined();

    const result = store.migrate();
    expect(result.from).toBe(1);
    expect(result.to).toBe(3);
    expect(result.alreadyAtVersion).toBe(false);
    expect(result.appliedSteps).toEqual([
      { from: 1, to: 2 },
      { from: 2, to: 3 },
    ]);

    const restarted = open(media);
    expect(restarted.schemaVersion).toBe(3);
    expect(restarted.get('a').entry).toEqual({ key: 'a', value: '1', updatedAt: 0, tags: [] });
    expect(restarted.get('b').entry).toEqual({ key: 'b', value: '2', updatedAt: 0, tags: [] });
    expect(restarted.recovery.discardedBytes).toBe(0);
  });

  it('只迁到 2：有 updatedAt、无 tags（步骤边界清楚）', () => {
    const media = new PersistentMedia();
    const store = open(media);
    store.put('a', '1');
    store.migrate(2);

    const restarted = open(media);
    expect(restarted.schemaVersion).toBe(2);
    expect(restarted.get('a').entry).toEqual({ key: 'a', value: '1', updatedAt: 0 });
    expect(restarted.get('a').entry?.tags).toBeUndefined();
  });

  it('崩溃在迁移帧落盘之前：重启仍旧版本、旧数据完整，重试成功', () => {
    const media = new PersistentMedia();
    open(media).put('a', '1');

    const store = open(media, crashOn('append:before', { onFrame: anyMigration }));
    expect(() => store.migrate()).toThrow(SimulatedCrash);

    const afterCrash = open(media);
    expect(afterCrash.schemaVersion).toBe(1);
    expect(afterCrash.get('a').entry).toEqual({ key: 'a', value: '1' });

    // 重试：从旧版本续跑到底
    const retry = open(media).migrate();
    expect(retry.to).toBe(3);
    const final = open(media);
    expect(final.schemaVersion).toBe(3);
    expect(final.get('a').entry?.updatedAt).toBe(0);
    expect(final.get('a').entry?.tags).toEqual([]);
  });

  it('迁移帧撕裂落盘：重启仍旧版本，重试成功（撕裂帧整段丢弃）', () => {
    const media = new PersistentMedia();
    open(media).put('a', '1');

    const torn = mergeHooks(
      tornSyncOn(0.5, { onFrame: anyMigration }),
      crashOn('sync:after', { onFrame: anyMigration }),
    );
    expect(() => open(media, torn).migrate()).toThrow(SimulatedCrash);

    const afterCrash = open(media);
    expect(afterCrash.schemaVersion).toBe(1);
    expect(afterCrash.get('a').entry).toEqual({ key: 'a', value: '1' });

    expect(open(media).migrate().to).toBe(3);
    expect(open(media).schemaVersion).toBe(3);
  });

  it('崩溃在迁移帧落盘之后：重启已到新版本，续跑补齐剩余步', () => {
    const media = new PersistentMedia();
    open(media).put('a', '1');

    const store = open(media, crashOn('sync:after', { onFrame: anyMigration }));
    expect(() => store.migrate()).toThrow(SimulatedCrash);

    // 第一条迁移帧（1→2）已落盘，即使调用方没拿到回执。
    const afterCrash = open(media);
    expect(afterCrash.schemaVersion).toBe(2);
    expect(afterCrash.get('a').entry?.updatedAt).toBe(0);

    const resumed = afterCrash.migrate();
    expect(resumed.from).toBe(2);
    expect(resumed.to).toBe(3);
    expect(open(media).schemaVersion).toBe(3);
  });

  it('幂等：日志里出现重复的迁移帧不会二次转换', () => {
    const media = new PersistentMedia();
    const store = open(media);
    store.put('a', '1');
    store.migrate(2);

    const duplicate = encodeFrame({ kind: 'migration', seq: 99, payload: { from: 1, to: 2 } });
    const combined = concatBytes(media.durable(), duplicate);

    const { recovery, state } = recoverJournal(combined);
    expect(recovery.schemaVersion).toBe(2);
    expect(state.entries.get('a')).toEqual({ key: 'a', value: '1', updatedAt: 0 });
    expect(state.entries.get('a')?.tags).toBeUndefined();
  });

  it('确定性：同一份日志恢复两次，结果逐字段相同', () => {
    const media = new PersistentMedia();
    const store = open(media);
    store.put('a', '1');
    store.put('b', '2');
    store.migrate();
    const bytes = media.durable();

    const serialize = (): unknown => {
      const { state, recovery } = recoverJournal(bytes);
      return { v: state.schemaVersion, entries: [...state.entries.entries()], frames: recovery.framesApplied };
    };
    expect(serialize()).toEqual(serialize());
    expect(serialize()).toEqual({
      v: 3,
      entries: [
        ['a', { key: 'a', value: '1', updatedAt: 0, tags: [] }],
        ['b', { key: 'b', value: '2', updatedAt: 0, tags: [] }],
      ],
      frames: 4,
    });
  });

  it('拒绝降级：目标版本低于当前 → downgrade_forbidden', () => {
    const media = new PersistentMedia();
    const store = open(media);
    store.put('a', '1');
    store.migrate();
    let caught: unknown;
    try {
      store.migrate(1);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KernelJournalError);
    expect((caught as KernelJournalError).code).toBe('downgrade_forbidden');
  });

  it('拒绝不支持的目标版本 → target_version_unsupported', () => {
    const store = open(new PersistentMedia());
    let caught: unknown;
    try {
      store.migrate(2.5);
    } catch (error) {
      caught = error;
    }
    expect(isKernelJournalError(caught)).toBe(true);
    expect((caught as KernelJournalError).code).toBe('target_version_unsupported');
  });

  it('介质声明更高 schema 版本 → schema_too_new，且不静默丢数据', () => {
    const base = new PersistentMedia();
    open(base).put('a', '1');
    const futureFrame = encodeFrame({ kind: 'migration', seq: 2, payload: { from: 1, to: 9 } });
    const combined = concatBytes(base.durable(), futureFrame);

    const media = new PersistentMedia();
    media.append(combined);
    media.sync();

    expect(() => open(media)).toThrow(/schema_too_new/);
    // 拒开后介质字节原样保留：没有偷偷截断或重写。
    expect(media.durable().length).toBe(combined.length);
  });
});

// ---------------------------------------------------------------------------
// §5 恢复后继续写入（截断撕裂尾部，从合法前缀续写）
// ---------------------------------------------------------------------------

describe('K-R02 §5 恢复后继续写入', () => {
  it('重开时截断撕裂尾部；随后追加正常，二次重开零丢弃', () => {
    const media = new PersistentMedia();
    open(media).put('a', '1');

    const torn = mergeHooks(
      tornSyncOn(0.5, { onFrame: putKey('b') }),
      crashOn('sync:after', { onFrame: putKey('b') }),
    );
    const store = open(media, torn);
    expect(() => store.put('b', '2')).toThrow(SimulatedCrash);

    const recovered = open(media);
    expect(keysOf(recovered)).toEqual(['a']);
    expect(recovered.recovery.discardedBytes).toBeGreaterThan(0);

    recovered.put('c', '3');

    const final = open(media);
    expect(keysOf(final).sort()).toEqual(['a', 'c']);
    expect(final.recovery.discardedBytes).toBe(0);
    expect(final.recovery.discardedReason).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// §6 真实文件对拍（node:fs）
// ---------------------------------------------------------------------------

describe('K-R02 §6 真实文件对拍：字节 → 文件 → 读回 → 截断 → 续写', () => {
  it('真实临时文件上的撕裂尾巴被丢弃，截断后续写可读回', () => {
    const dir = mkdtempSync(join(tmpdir(), 'potbot-k-r02-'));
    const file = join(dir, 'kernel.db');
    try {
      const media = new PersistentMedia();
      const store = open(media);
      store.put('a', '1');
      store.put('b', '2');
      const validLog = media.durable();

      writeFileSync(file, validLog);

      // 模拟真实介质上"写了一半就断电"：追加一条帧的前 10 字节（< HEADER_LEN）。
      const tornFrame = encodeFrame({ kind: 'put', seq: 3, payload: { key: 'c', value: '3' } });
      appendFileSync(file, tornFrame.subarray(0, 10));
      const fd = openSync(file, 'r+');
      fsyncSync(fd);
      closeSync(fd);

      const onDisk = concatBytes(new Uint8Array(readFileSync(file)));
      const { recovery, state } = recoverJournal(onDisk);
      expect(recovery.discardedBytes).toBe(10);
      expect(recovery.discardedReason).toBe('incomplete-header');
      expect([...state.entries.keys()]).toEqual(['a', 'b']);

      // 恢复即截断（WAL 的 truncate-on-recovery），再续写一条。
      truncateSync(file, recovery.validBytes);
      const nextFrame = encodeFrame({ kind: 'put', seq: 4, payload: { key: 'd', value: '4' } });
      appendFileSync(file, nextFrame);
      const fd2 = openSync(file, 'r+');
      fsyncSync(fd2);
      closeSync(fd2);

      const after = concatBytes(new Uint8Array(readFileSync(file)));
      const second = recoverJournal(after);
      expect(second.recovery.discardedBytes).toBe(0);
      expect(second.state.entries.get('d')?.value).toBe('4');
      expect([...second.state.entries.keys()]).toEqual(['a', 'b', 'd']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// §7 词表自洽
// ---------------------------------------------------------------------------

describe('K-R02 §7 词表自洽', () => {
  it('每个会有抛错语义的故障点都有对应注入脚手架（防新增点却无法注入）', () => {
    const hookName: Record<string, keyof KillHooks> = {
      'append:before': 'beforeAppend',
      'append:after': 'afterAppend',
      'sync:before': 'beforeSync',
      'sync:after': 'afterSync',
    };
    for (const point of FAULT_POINTS) {
      if (point === 'sync:partial') {
        expect(typeof tornSyncOn(0.5).partialSync).toBe('function');
        continue;
      }
      const hooks = crashOn(point);
      const name = hookName[point];
      expect(name).toBeDefined();
      expect(typeof hooks[name!]).toBe('function');
    }
  });

  it('错误码唯一且非空', () => {
    expect(new Set(KERNEL_DB_ERROR_CODES).size).toBe(KERNEL_DB_ERROR_CODES.length);
    expect(KERNEL_DB_ERROR_CODES.length).toBeGreaterThan(0);
  });

  it('isKernelJournalError 只认真错误形状', () => {
    expect(isKernelJournalError(new KernelJournalError('schema_too_new', 'x'))).toBe(true);
    expect(isKernelJournalError(new Error('plain'))).toBe(false);
    expect(isKernelJournalError({ code: 42 })).toBe(false);
    expect(isKernelJournalError(null)).toBe(false);
  });
});

/**
 * K-I07 ③：**消费侧落地验证** —— K10 `TaskLedger.snapshot()/replay()` 经 `FileBlobPort`
 * 跨"进程死亡"存活；读失败被如实升级为 `invalid_snapshot`，**绝不当作空账本**。
 *
 * 这是对 K10 集成请求的直接兑现：
 *   「expose a read/write blob port so TaskLedger.snapshot()/replay() persist across
 *     process death; treat a read failure as an error, never as an empty ledger.」
 *
 * `TaskLedger` 来自 K10 包（只读引用，不修改其文件）。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { LifecycleError } from '../../../apps/mobile-kernel/lifecycle/errors.js';
import { TaskLedger } from '../../../apps/mobile-kernel/lifecycle/ledger.js';
import {
  BlobPortError,
  FileBlobPort,
  LEDGER_SNAPSHOT_KEY,
  isBlobPortError,
  type BlobPort,
} from '../../../apps/mobile-kernel/storage/index.js';

import { FaultyFileSystem, NodeFileSystem, blobPathOf, cleanupTempRoots, fixedClock, makeTempRoot, writeRawBytes } from './fixtures.js';

afterEach(cleanupTempRoots);

const KEY = LEDGER_SNAPSHOT_KEY;

/** 捕获抛出的错误（K10 的 `LifecycleError.message` 不含 code，故断言落在 `.code` 上）。 */
function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('期望抛出错误，但没有抛出');
}

/**
 * 消费侧应写的装载逻辑：读失败映射成 `invalid_snapshot`（**不是**空账本）；
 * `null` 只代表"确实还没写过快照"，允许全新开始。
 */
function loadLedger(port: BlobPort, key: string, clock: { now(): number }): TaskLedger | null {
  let text: string | null;
  try {
    text = port.read(key);
  } catch (error) {
    if (isBlobPortError(error)) {
      throw new LifecycleError(
        'invalid_snapshot',
        `账本快照读失败（${error.code}）：拒绝当作空账本继续`,
      );
    }
    throw error;
  }
  if (text === null) return null;
  return TaskLedger.replay(text, { clock });
}

describe('TaskLedger 经 FileBlobPort 跨进程存活', () => {
  it('快照落盘后，新进程用新实例读回并 replay 出同样的游标', () => {
    const clock = fixedClock();
    const root = makeTempRoot();

    // 进程 1
    const port1 = new FileBlobPort({ root, fs: new NodeFileSystem() });
    const ledger1 = new TaskLedger({ clock });
    ledger1.registerTask({ taskId: 't1', stepIds: ['s1', 's2', 's3'] });
    ledger1.startRun('t1');
    ledger1.completeStep('t1', 's1');
    const snapshot = ledger1.snapshot();
    port1.write(KEY, snapshot);

    // 进程 2：独立实例 + 独立 FileBlobPort，没有共享内存。
    const port2 = new FileBlobPort({ root, fs: new NodeFileSystem() });
    const reopened = loadLedger(port2, KEY, clock);
    expect(reopened).toBeInstanceOf(TaskLedger);

    const task = reopened!.getTask('t1');
    expect(task).toBeDefined();
    expect(task!.cursor).toBe(1);
    expect(task!.completedSteps).toEqual(['s1']);
    expect(task!.state).toBe('running');
    expect(reopened!.journal().length).toBe(ledger1.journal().length);
    // 恢复不得重跑已完成步骤：再 complete 一次 s1 必须被拒。
    const dup = captureError(() => reopened!.completeStep('t1', 's1'));
    expect(dup).toBeInstanceOf(LifecycleError);
    expect((dup as LifecycleError).code).toBe('duplicate_step');
  });

  it('读失败 => invalid_snapshot（显式错误），而不是空账本', () => {
    const clock = fixedClock();
    const root = makeTempRoot();

    const seed = new FileBlobPort({ root, fs: new NodeFileSystem() });
    seed.write(KEY, '{"version":1,"seq":0,"killMode":null,"entries":[]}');

    const faulty = new FileBlobPort({
      root,
      fs: new FaultyFileSystem({ failRead: (path) => path.endsWith('task-ledger.v1.json') }),
    });

    let thrown: unknown;
    try {
      loadLedger(faulty, KEY, clock);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LifecycleError);
    expect((thrown as LifecycleError).code).toBe('invalid_snapshot');
    // 反向对照：绝不能"成功返回一个空账本"。
    expect(thrown).not.toBeNull();
  });

  it('磁盘上快照字节损坏 => 读失败 => invalid_snapshot（不是空账本）', () => {
    const clock = fixedClock();
    const root = makeTempRoot();

    const seed = new FileBlobPort({ root, fs: new NodeFileSystem() });
    seed.write(KEY, '{"version":1,"seq":0,"killMode":null,"entries":[]}');
    writeRawBytes(blobPathOf(root, KEY), [0xff, 0xfe]); // 非法 UTF-8 首字节

    const port = new FileBlobPort({ root, fs: new NodeFileSystem() });
    const corrupt = captureError(() => loadLedger(port, KEY, clock));
    expect(corrupt).toBeInstanceOf(LifecycleError);
    expect((corrupt as LifecycleError).code).toBe('invalid_snapshot');
  });

  it('真正的首次冷启动：read 返回 null（允许全新开始），且端口从不交出空串', () => {
    const clock = fixedClock();
    const root = makeTempRoot();
    const port = new FileBlobPort({ root, fs: new NodeFileSystem() });

    // null 表示"协议意义上确实不存在"，与"读失败"是两件事。
    expect(port.read(KEY)).toBeNull();
    expect(loadLedger(port, KEY, clock)).toBeNull();

    // '' 若被当成快照，replay 会抛——这正是端口绝不能在被损坏/读失败时返回空串的理由。
    const empty = captureError(() => TaskLedger.replay('', { clock }));
    expect(empty).toBeInstanceOf(LifecycleError);
    expect((empty as LifecycleError).code).toBe('invalid_snapshot');
  });

  it('端口错误是 BlobPortError 且可机读', () => {
    const root = makeTempRoot();
    const faulty = new FileBlobPort({
      root,
      fs: new FaultyFileSystem({ failRead: () => true }),
    });
    // 先让文件存在。
    new FileBlobPort({ root, fs: new NodeFileSystem() }).write('k', 'v');
    let thrown: unknown;
    try {
      faulty.read('k');
    } catch (error) {
      thrown = error;
    }
    expect(isBlobPortError(thrown)).toBe(true);
    expect((thrown as BlobPortError).code).toBe('blob_read_failed');
  });
});

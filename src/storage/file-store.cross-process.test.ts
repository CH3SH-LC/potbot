/**
 * 落盘存储的**跨进程 / 跨重启**验收（design-06-P5；合同 R214–R220、R225）。
 *
 * 这些用例的意义不在于"文件里有没有字节"，而在于把 R215/R218/R220 三句话
 * 变成可复算的判据，并且**每条正向判据都配一个会变红的对照**：
 *
 * | 用例 | 正向 | 若没有对应实现会怎样 |
 * |---|---|---|
 * | 双工作进程并发写 | 2N 条一条不少 | 丢更新（后写者覆盖前写者） |
 * | 对照组（易失介质） | 读回 0 条 | —— 未实现持久化时的样子，证明上一条不是空转 |
 * | 持锁期间的第二个写入者 | `lock_timeout` 拒绝（未接受） | 若锁是假的，并发写会静默互相覆盖 |
 * | 崩溃点 ③（rename 前硬退出） | 读到**上一版** | 若把残留 tmp 当已提交，会读到未提交的那笔 |
 * | 崩溃点 ⑤（rename 后硬退出） | 读到**新提交** | 若先改内存后落盘，会读到旧版 |
 * | 重启协调 | running → aborted 且落盘 | 已死进程的租约被"复活"，并发判定失真 |
 *
 * **真进程**：并发与崩溃都用 `child_process` 起独立操作系统进程（`src/storage/__fixtures__/
 * file-store-worker.ts`）。同进程内的两个对象做不出"进程崩溃"，也证明不了跨进程锁
 * ——那正是 R215 点名禁止的"用 `Map` 或 Promise 链冒充跨进程锁"。
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asTaskId,
  createDeliveryEvent,
  createIdSource,
  createTaskRecord,
  createWorkItem,
  PersistenceError,
} from '../protocol/index.js';
import { createFileStore, type FileStore } from './file-store.js';
import { createMemoryStore } from './memory-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
/**
 * 夹具住在 `tests/storage/`，**不在 `src/**`**：它们要起进程、读环境、并给持久 Store
 * 注入**真实墙钟**，而这些在 `src/**` 里被合同 R50.4 明令禁止（白名单只有
 * `src/storage/file-store.ts` 一个具名文件，且只放行两个 import specifier）。
 * 详见 `tests/storage/file-store-worker.ts` 头部说明。
 */
const WORKER = 'tests/storage/file-store-worker.ts';
const REGISTER = 'tests/storage/register-loader.mjs';

/** 子进程启动参数：Node 自带类型擦除 + 把 `.js` 说明符解析到 `.ts`（见该 loader 的说明）。 */
function workerArgs(): readonly string[] {
  return ['--experimental-transform-types', '--import', `./${REGISTER}`];
}

/**
 * 子进程环境。**清掉测试框架注入的 `NODE_OPTIONS`**：vitest 会把自己的加载参数
 * 塞进去，工作进程只是普通 Node，带上它们会起不来（实测表现为退出码 1）。
 */
function workerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['NODE_OPTIONS'];
  delete env['VITEST'];
  return env;
}

let workDir: string;
let storePath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'potbot-file-store-'));
  storePath = join(workDir, 'kernel-store.json');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** 同步跑一个工作进程，返回退出码与它输出的那行 JSON。 */
function runWorkerSync(
  mode: string,
  storeKind: 'file' | 'memory',
  count: number,
  tag: string,
): { readonly code: number; readonly report: Record<string, unknown> | null } {
  const result = spawnSync(
    process.execPath,
    [...workerArgs(), WORKER, mode, storeKind, storePath, String(count), tag],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000, env: workerEnv() },
  );
  if (result.status !== 0 && result.status !== 7 && result.status !== 8) {
    // 起不来时必须**看得见原因**：否则失败只会显示"退出码 1"，无法定位。
    writeFileSync(
      join(workDir, `worker-failure-${tag}.log`),
      `${String(result.status)}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      'utf8',
    );
    throw new Error(
      `工作进程 ${tag} 异常退出（码 ${String(result.status)}）：\n${(result.stderr ?? '').slice(0, 2000)}`,
    );
  }
  const line = (result.stdout ?? '')
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => value.startsWith('{'))
    .pop();
  return {
    code: result.status ?? -1,
    report: line === undefined ? null : (JSON.parse(line) as Record<string, unknown>),
  };
}

/** 异步跑一个工作进程（并发用）。 */
function runWorkerAsync(
  mode: string,
  storeKind: 'file' | 'memory',
  count: number,
  tag: string,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [...workerArgs(), WORKER, mode, storeKind, storePath, String(count), tag],
      { cwd: REPO_ROOT, stdio: 'ignore' },
    );
    child.once('error', reject);
    child.once('exit', (code) => resolvePromise(code ?? -1));
  });
}

function openStore(extra: Partial<Parameters<typeof createFileStore>[0]> = {}): FileStore {
  return createFileStore({
    filePath: storePath,
    clock: () => asLogicalTime(0),
    // 宿主注入的**真实墙钟**与锁持有者标识（`src/storage/file-store.ts` 自己不许调用它们：
    // R50.4 的禁用 token 含 `Date.now(` / `new Date(` / `process.pid`）。
    // 本文件是 `*.test.ts`，不在纪律扫描范围内，正是"由宿主提供默认实现"的位置。
    now: () => Date.now(),
    lockOwner: `test:${String(process.pid)}`,
    // 夹具进程可能"崩"在持锁期间，留下陈旧锁；给一个极小阈值让重开能立刻打破它。
    lockStaleMs: 1,
    ...extra,
  });
}

function taskIdsOf(store: FileStore): readonly string[] {
  return store
    .snapshot()
    .tasks.map((task) => task.task_id)
    .sort();
}

function seedTask(store: FileStore, taskId: string, goal: string): void {
  store.transact((tx) => {
    tx.putTask(createTaskRecord({ task_id: asTaskId(taskId), goal, created_at: asLogicalTime(0) }));
  });
}

// ---------------------------------------------------------------------------

describe('文件存储：落盘与重启读回（R216）', () => {
  it('写入 → 进程结束 → 新实例读回同一份状态（不是"文件存在"，是内容逐项对得上）', () => {
    const first = openStore();
    expect(first.loadReport().filePresent).toBe(false);
    seedTask(first, 'T-1', '把八人名单排成表格');
    expect(taskIdsOf(first)).toEqual(['T-1']);

    // 全新实例：模拟"另一个进程 / 重启后"。
    const reopened = openStore();
    const report = reopened.loadReport();
    expect(report.filePresent).toBe(true);
    expect(report.loaded).toBe(true);
    expect(report.counts['tasks']).toBe(1);
    expect(taskIdsOf(reopened)).toEqual(['T-1']);
    expect(reopened.snapshot().tasks[0]?.goal).toBe('把八人名单排成表格');
  });

  it('已投递标记会落盘：重启后不会被当作未投递而重放（outbox 不重复投递）', () => {
    const ids = createIdSource();
    const first = openStore();
    first.transact((tx) => {
      tx.enqueueDeliveryEvent(
        createDeliveryEvent(
          {
            kind: 'wakeup_queued',
            task_id: asTaskId('T-1'),
            group_id: asGroupId('G-1'),
            instance_id: asInstanceId('I-1'),
            created_at: asLogicalTime(1),
            reason: '测试事件',
          },
          ids,
        ),
      );
    });
    expect(first.pendingDeliveryEvents()).toHaveLength(1);

    const delivered = first.publishPending(() => undefined);
    expect(delivered).toHaveLength(1);
    expect(first.pendingDeliveryEvents()).toHaveLength(0);

    const reopened = openStore();
    expect(reopened.pendingDeliveryEvents()).toHaveLength(0);
  });

  it('事务体抛错 ⇒ PersistenceError（accepted=false），磁盘与内存都停在上一版', () => {
    const store = openStore();
    seedTask(store, 'T-keep', '保留');
    const before = statSync(storePath).size;

    expect(() =>
      store.transact(() => {
        throw new Error('事务体中途失败');
      }),
    ).toThrow(PersistenceError);
    expect(taskIdsOf(store)).toEqual(['T-keep']);
    expect(statSync(storePath).size).toBe(before);

    expect(taskIdsOf(openStore())).toEqual(['T-keep']);
  });

  it('文件存在但内容读不回来时**默认拒绝启动**，不静默按空状态起', () => {
    const first = openStore();
    seedTask(first, 'T-x', 'x');
    writeFileSync(storePath, '{ 这不是合法 JSON', 'utf8');

    expect(() => openStore()).toThrow(PersistenceError);

    // 显式选择放弃时才按空状态起，并在报告里说清楚丢弃了什么。
    const lenient = openStore({ onUnreadable: 'start-empty' });
    expect(lenient.loadReport().loaded).toBe(false);
    expect(lenient.loadReport().reason).toContain('显式放弃既有状态');
    expect(taskIdsOf(lenient)).toEqual([]);
  });
});

describe('文件存储：崩溃窗口逐点复现（R215）', () => {
  it('崩溃点③（tmp 写完、rename 前硬退出）：重启读到**上一版**，残留 tmp 被忽略并如实记录', () => {
    const seeded = runWorkerSync('append', 'file', 2, 'B');
    expect(seeded.code).toBe(0);
    expect(taskIdsOf(openStore())).toEqual(['B-0', 'B-1']);

    // 工作进程在 rename 前硬退出：那一笔**从未提交**。
    const crashed = runWorkerSync('crash-before-rename', 'file', 1, 'C');
    expect(crashed.code).toBe(7);

    const reopened = openStore();
    const report = reopened.loadReport();
    expect(report.orphanTemporary).toBe(true);
    expect(report.brokeStaleLock).toBe(true);
    // 关键断言：未提交的 C-0 **不可见**（若把 tmp 当已提交，这里会变成 3 条）。
    expect(taskIdsOf(reopened)).toEqual(['B-0', 'B-1']);
  });

  it('崩溃点⑤（rename 之后硬退出）：重启读到**新提交**（先落盘后改内存的不变式）', () => {
    const crashed = runWorkerSync('crash-after-rename', 'file', 1, 'D');
    expect(crashed.code).toBe(8);

    const reopened = openStore();
    expect(reopened.loadReport().loaded).toBe(true);
    // 关键断言：已 rename 的提交**必须可见**（若"先改内存后落盘"或漏 fsync，这里会空）。
    expect(taskIdsOf(reopened)).toEqual(['D-0']);
  });

  it('崩溃留下的陈旧锁不会永久卡死后续写入（锁必须有失效路径）', () => {
    expect(runWorkerSync('crash-before-rename', 'file', 1, 'E').code).toBe(7);
    const reopened = openStore();
    reopened.transact((tx) => {
      tx.putTask(
        createTaskRecord({ task_id: asTaskId('E-ok'), goal: 'ok', created_at: asLogicalTime(0) }),
      );
    });
    expect(taskIdsOf(reopened)).toEqual(['E-ok']);
  });

  it('持锁进程未退出时，第二个写入者被**拒绝**（锁是真排他，不是装饰）', () => {
    // 工作进程在 rename 前硬退出 ⇒ 锁文件被留下且**新鲜**。
    expect(runWorkerSync('crash-before-rename', 'file', 1, 'L').code).toBe(7);

    // 把陈旧阈值设得极大：这份锁仍然"有效"，第二个写入者必须等不到。
    const blocked = openStore({ lockStaleMs: 60_000, lockTimeoutMs: 50 });
    expect(() => seedTask(blocked, 'L-2', '不该写进去')).toThrow(PersistenceError);
    expect(() => seedTask(blocked, 'L-2', '不该写进去')).toThrow(/锁|超时/);

    // 磁盘上**什么都没有**：崩溃那一笔从未提交，被拒那一笔也没进去。
    // （若锁是装饰品，被拒的那笔会静默落盘，这里就会变成 ['L-2']。）
    const after = openStore();
    expect(taskIdsOf(after)).toEqual([]);

    // 打破陈旧锁后，同一份状态可继续写：锁有失效路径，不会永久卡死。
    seedTask(after, 'L-ok', '打破陈旧锁后写入');
    expect(taskIdsOf(openStore())).toEqual(['L-ok']);
  });
});

describe('文件存储：两个工作进程的交叉负例（R218 / R220）', () => {
  it('两个**操作系统进程**并发各写 20 条：一条不丢（读已提交 + 后写者基于最新状态）', async () => {
    const PER_WORKER = 20;
    const [codeA, codeB] = await Promise.all([
      runWorkerAsync('append', 'file', PER_WORKER, 'PA'),
      runWorkerAsync('append', 'file', PER_WORKER, 'PB'),
    ]);
    expect(codeA).toBe(0);
    expect(codeB).toBe(0);

    const ids = taskIdsOf(openStore());
    expect(ids).toHaveLength(PER_WORKER * 2);
    for (let index = 0; index < PER_WORKER; index += 1) {
      expect(ids).toContain(`PA-${String(index)}`);
      expect(ids).toContain(`PB-${String(index)}`);
    }
  }, 60_000);

  it('对照组：同样的两个进程写**易失实现** ⇒ 父进程读回 0 条（证明上一条不是空转）', async () => {
    const [codeA, codeB] = await Promise.all([
      runWorkerAsync('append', 'memory', 5, 'MA'),
      runWorkerAsync('append', 'memory', 5, 'MB'),
    ]);
    expect(codeA).toBe(0);
    expect(codeB).toBe(0);

    // 没有落盘 ⇒ 磁盘上什么都没有。这正是"未实现持久化"时的样子：
    // 上一条用例若把 file 换成 memory，就会红。
    const reopened = openStore();
    expect(reopened.loadReport().filePresent).toBe(false);
    expect(taskIdsOf(reopened)).toEqual([]);
  }, 60_000);
});

describe('文件存储：与内存实现同语义（读侧口径不分叉）', () => {
  it('同一事务在两个实现上产生同一份快照，且落盘后主键与内存实现一致', () => {
    const fileStore = openStore();
    const memoryStore = createMemoryStore({ clock: () => asLogicalTime(0) });

    for (const store of [fileStore, memoryStore]) {
      store.transact((tx) => {
        tx.putWorkItem(
          createWorkItem({
            request_id: asRequestId('Q-1'),
            owner_instance_id: asInstanceId('I-1'),
            created_at: asLogicalTime(0),
            task_id: asTaskId('T-1'),
            description: '写一段',
            status: 'waiting_dependency',
            blocker_reason: { kind: 'waiting_dependency', detail: '等上游产出' },
            dependency_refs: [{ request_id: asRequestId('Q-0') }],
          }),
        );
      });
    }

    const asRead = (store: { snapshot(): { work_items: readonly { request_id: string }[] } }) =>
      store.snapshot().work_items.map((item) => item.request_id);

    expect(asRead(fileStore)).toEqual(asRead(memoryStore));
    expect(asRead(openStore())).toEqual(['Q-1']);
  });
});

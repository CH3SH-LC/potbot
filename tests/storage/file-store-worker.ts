/**
 * 跨进程测试用的**工作进程**夹具（R220 明文要求"两个工作进程 + 重启的交叉负例"）。
 *
 * 它只用公开 API：`createFileStore` / `createMemoryStore` + `src/protocol` 的记录工厂。
 * 没有任何测试后门——子进程看到的就是产品代码。
 *
 * ## 为什么它住在 `tests/` 而不是 `src/storage/__fixtures__/`
 *
 * 合同 **R50.4**（`tests/acceptance/office/w-disc-kernel-discipline.test.ts`）扫描
 * `src/**` 的**非测试**文件，禁用 token 包括 `Date.now(` / `new Date(` / `process.pid` /
 * `node:fs` 等；白名单**只有具名的 `src/storage/file-store.ts` 一个文件**，且只放行
 * `node:fs` / `node:path` 两个 specifier。
 *
 * 而本夹具是**测试宿主**：它必须起进程、读环境、并给持久 Store 注入**真实墙钟**
 * （跨进程锁的新鲜度必须用同一把真实时钟才可比）。这些在 `src/**` 里是被禁止的——
 * 而且**本就该禁止**：它们是 OS 层测试脚手架，不是内核代码。
 * 所以它按仓库既有惯例（IO 型测试辅助住 `tests/**`）搬到 `tests/storage/`。
 *
 * 用法（由 `src/storage/file-store.cross-process.test.ts` 驱动）：
 * ```
 * node --experimental-transform-types --import ./tests/storage/register-loader.mjs \
 *      tests/storage/file-store-worker.ts <mode> <storeKind> <filePath> <count> <tag>
 * ```
 * - `storeKind`：`file`（落盘实现）| `memory`（易失实现，用作"未落盘"对照组）
 * - `mode`：
 *   - `append`              —— 追加 `count` 条任务后正常退出（退出码 0）
 *   - `crash-before-rename` —— 写完 tmp、rename 前**硬退出**（复现崩溃点 ③，退出码 7）
 *   - `crash-after-rename`  —— rename 之后、返回前**硬退出**（复现崩溃点 ④/⑤，退出码 8）
 *
 * stdout 只输出**一行 JSON**，便于父进程逐字段核对。
 */

import { asLogicalTime, asTaskId, createTaskRecord } from '../../src/protocol/index.js';
import { createFileStore, type FileStore } from '../../src/storage/file-store.js';
import { createMemoryStore } from '../../src/storage/memory-store.js';
import type { Store } from '../../src/protocol/index.js';

interface Report {
  readonly ok: boolean;
  readonly mode: string;
  readonly storeKind: string;
  readonly tag: string;
  readonly appended: number;
  readonly filePresent: boolean;
  readonly loaded: boolean;
  readonly taskCount: number;
  readonly note: string;
}

function emit(report: Report): void {
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

const [mode, storeKind, filePath, rawCount, tag] = process.argv.slice(2);
const count = Number.parseInt(rawCount ?? '0', 10);

if (mode === undefined || storeKind === undefined || filePath === undefined || tag === undefined) {
  process.stderr.write('用法：worker <mode> <file|memory> <filePath> <count> <tag>\n');
  process.exit(2);
}

let store: Store;
let seedReport = { filePresent: false, loaded: false };
if (storeKind === 'file') {
  const created: FileStore = createFileStore({
    filePath,
    // 工作进程注入的**真实墙钟**与进程身份：跨进程锁必须用可比的时间基准。
    now: () => Date.now(),
    lockOwner: `worker:${String(process.pid)}:${tag}`,
    clock: () => asLogicalTime(0),
    ...(mode === 'crash-before-rename'
      ? { hooks: { beforeRename: () => process.exit(7) } }
      : {}),
    ...(mode === 'crash-after-rename' ? { hooks: { afterRename: () => process.exit(8) } } : {}),
  });
  store = created;
  const report = created.loadReport();
  seedReport = { filePresent: report.filePresent, loaded: report.loaded };
} else {
  store = createMemoryStore({ clock: () => asLogicalTime(0) });
}

let appended = 0;
for (let index = 0; index < count; index += 1) {
  store.transact((tx) => {
    tx.putTask(
      createTaskRecord({
        task_id: asTaskId(`${tag}-${String(index)}`),
        goal: `来自工作进程 ${tag} 的第 ${String(index)} 个目标`,
        created_at: asLogicalTime(index),
      }),
    );
  });
  appended += 1;
}

emit({
  ok: true,
  mode,
  storeKind,
  tag,
  appended,
  filePresent: seedReport.filePresent,
  loaded: seedReport.loaded,
  taskCount: store.snapshot().tasks.length,
  note: '工作进程正常退出',
});

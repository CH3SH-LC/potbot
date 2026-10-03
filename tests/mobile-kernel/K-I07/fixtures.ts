/**
 * K-I07 夹具：**真实磁盘**上的 `FileSystemPort` 适配器 + 故障注入包装 + 临时根目录管理。
 *
 * `node:fs` 适配器**只定义在测试里**——产品树（`apps/mobile-kernel/**`）不得依赖 node 内建，
 * 这条纪律与 `tests/mobile-kernel/K09/file-store.test.ts` 一致。安卓原生适配器（SAF /
 * 应用私有目录）属 Android 集成人，不在本包。
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { FileSystemPort } from '../../../apps/mobile-kernel/storage/index.js';

/** 把 `FileSystemPort` 接到真磁盘。 */
export class NodeFileSystem implements FileSystemPort {
  ensureDir(path: string): void {
    mkdirSync(path, { recursive: true });
  }
  exists(path: string): boolean {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }
  readFile(path: string): Uint8Array {
    return new Uint8Array(readFileSync(path));
  }
  writeFile(path: string, bytes: Uint8Array): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  rename(from: string, to: string): void {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  }
  removeFile(path: string): void {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  listFiles(path: string): readonly string[] {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }
  listDirs(path: string): readonly string[] {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }
}

/** 故障计划：谓词返回 true 时该次调用注入失败。 */
export interface FaultPlan {
  readonly failRead?: (path: string) => boolean;
  readonly failWrite?: (path: string) => boolean;
  readonly failRename?: (from: string, to: string) => boolean;
  readonly failRemove?: (path: string) => boolean;
}

/**
 * 包一层 `NodeFileSystem`，按路径注入读/写/rename 失败——用于把 `blob_read_failed`
 * 这类"介质在、但读不动"的分支在真磁盘布局上机器化驱动出来（而不是靠内存模拟）。
 */
export class FaultyFileSystem implements FileSystemPort {
  readonly #inner = new NodeFileSystem();
  readonly #faults: FaultPlan;
  readonly calls = { readFile: 0, writeFile: 0, rename: 0 };

  constructor(faults: FaultPlan = {}) {
    this.#faults = faults;
  }

  ensureDir(path: string): void {
    this.#inner.ensureDir(path);
  }
  exists(path: string): boolean {
    return this.#inner.exists(path);
  }
  readFile(path: string): Uint8Array {
    this.calls.readFile += 1;
    if (this.#faults.failRead?.(path) === true) throw new Error('injected read failure');
    return this.#inner.readFile(path);
  }
  writeFile(path: string, bytes: Uint8Array): void {
    this.calls.writeFile += 1;
    if (this.#faults.failWrite?.(path) === true) throw new Error('injected write failure');
    this.#inner.writeFile(path, bytes);
  }
  rename(from: string, to: string): void {
    this.calls.rename += 1;
    if (this.#faults.failRename?.(from, to) === true) throw new Error('injected rename failure');
    this.#inner.rename(from, to);
  }
  removeFile(path: string): void {
    if (this.#faults.failRemove?.(path) === true) throw new Error('injected remove failure');
    this.#inner.removeFile(path);
  }
  listFiles(path: string): readonly string[] {
    return this.#inner.listFiles(path);
  }
  listDirs(path: string): readonly string[] {
    return this.#inner.listDirs(path);
  }
}

/** 固定时钟，保证 `TaskLedger` 的时间字段确定。 */
export const FIXED_NOW = 1_700_000_000_000;
export function fixedClock(): { now(): number } {
  return { now: () => FIXED_NOW };
}

const tempRoots: string[] = [];

/** 新建一个临时根目录（真磁盘）；`afterEach(cleanupTempRoots)` 负责回收。 */
export function makeTempRoot(prefix = 'k-i07-blob-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

/** 递归清理本测试建的全部临时根。 */
export function cleanupTempRoots(): void {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
}

/** 直接往磁盘写原始字节（绕过端口），用于制造"介质上的内容被损坏"。 */
export function writeRawBytes(path: string, bytes: readonly number[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Uint8Array.from(bytes));
}

/** 白盒：按文档布局拼出 `<root>/blobs/<key>`（布局写死在 blob-port.ts 头注释里）。 */
export function blobPathOf(root: string, key: string): string {
  return join(root, 'blobs', ...key.split('/'));
}

/** 目录下普通文件数（用于断言覆盖写没有留下多个文件）。 */
export function countFiles(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).length;
  } catch {
    return 0;
  }
}

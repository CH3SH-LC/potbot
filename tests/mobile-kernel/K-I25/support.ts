/**
 * K-I25 支持装置 —— 真实 `node:fs` 适配 K09 `FileSystemPort`，把提升后的
 * `StorageMedia` 跑在**真磁盘字节**上。
 *
 * 为什么 `node:fs` 适配器只在测试里：产品代码图必须**零 node 内建**（K09 的既定纪律）。
 * 端口 `FileSystemPort`（`apps/mobile-kernel/storage/fs-port.ts`）是接口，安卓侧由
 * `AndroidFileSystemPort.java` 实现；测试侧用这里的 `NodeFileSystem` 把同一接口接到真文件，
 * 于是"崩溃后重开读到什么"由**真实文件内容**决定，而不是内存里记的。
 *
 * 崩溃注入脚手架（`crashOn` / `tornSyncOn` / `mergeHooks`）复用 K-R02 的测试专用实现
 * （`../K-R02/simulate-crash.js`），不重复造。
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { FileSystemPort } from '../../../apps/mobile-kernel/storage/fs-port.js';
import type { Frame } from '../../../apps/mobile-kernel/journal/index.js';

/** 真实文件系统端口：方法逐一对应 `FileSystemPort`（K09 契约）。 */
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

const roots: string[] = [];

/** 建一个隔离的临时根目录（用例结束由 `cleanupRoots` 统一删）。 */
export function newRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** 删除本文件建过的全部临时根。 */
export function cleanupRoots(): void {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
}

/** 只对 key === k 的 put 帧触发。 */
export function putKey(key: string): (frame: Frame) => boolean {
  return (frame) => frame.kind === 'put' && frame.payload.key === key;
}

/** 拼接字节。 */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 两枚字节数组是否逐字节相等。 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

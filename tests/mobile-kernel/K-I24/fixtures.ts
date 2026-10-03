/**
 * K-I24 独立验证夹具 —— **产物仓宿主 `artifacts-host/`**。
 *
 * 独立判据（不拿实现自证）：
 *   - 每个版本的摘要都与 `node:crypto` 的 `createHash('sha256')` **外部预言机**对拍；
 *   - 目录快照的"无明文"由**直读存储端口里的原始 blob**验证，不看实现返回值；
 *   - 跨进程持久用**新实例读真磁盘**验证（见 05 号用例）。
 */

import { createHash } from 'node:crypto';

import { expect } from 'vitest';

import { createArtifactsHost, isArtifactsHostError } from '../../../apps/mobile-kernel/artifacts-host/index.js';
import { MemoryStoragePort, type StoragePort } from '../../../apps/mobile-kernel/storage/index.js';

export { MemoryStoragePort };
export type { StoragePort };

export const FIXED_NOW = 1_700_000_000_000;

/** 可推进的注入时钟。 */
export interface ManualClock {
  now(): number;
  advance(ms: number): void;
}

export function manualClock(start = FIXED_NOW): ManualClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** `sha256:<64 hex>` 外部预言机。 */
export function oracle(text: string): string {
  return `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`;
}

export function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

export function textOf(value: Uint8Array): string {
  return Buffer.from(value).toString('utf8');
}

/** 造一个落在内存后端上的产物仓宿主（故障/时钟均可注入）。 */
export function newHost(storage: StoragePort, options: { now?: () => number } = {}) {
  return createArtifactsHost({ storage, now: options.now });
}

/** 断言 `fn` 抛出带指定 `code` 的 `ArtifactsHostError`；正常返回则失败。 */
export function expectArtifactsError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    if (!isArtifactsHostError(error)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 [${code}]，但调用正常返回了`);
}

/** 异步版本的 `expectArtifactsError`（用于 `publish`）。 */
export async function expectArtifactsErrorAsync(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (!isArtifactsHostError(error)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 [${code}]，但调用正常返回了`);
}

/** 收集结果里所有字符串字段（跳过字节），用于"绝不返回电脑绝对路径 / 明文"的机器化扫描。 */
export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (value instanceof Uint8Array) void 0;
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}

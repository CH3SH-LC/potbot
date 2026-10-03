/**
 * K-I25 ① 提升面：产品源码 `apps/mobile-kernel/journal/` 公开出口 + 静态契约。
 *
 * 断言：
 *  1. 帧 / 恢复 / 迁移 / 介质的产品出口齐备（`encodeFrame` … `StorageMedia`）；
 *  2. 产品树**零 node 内建**（静态扫描，带变异自证：扫描器会咬假样例）；
 *  3. `framing.ts` 复用 K09 的纯 TS SHA-256（跨包复用，不自造摘要）；
 *  4. K-R02 的 barrel 已**转发**产品模块（28 例断言跑在产品代码上）。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as journal from '../../../apps/mobile-kernel/journal/index.js';
import type { Media } from '../../../apps/mobile-kernel/journal/index.js';

// ---------------------------------------------------------------------------
// 静态扫描器（纯函数，可自证）
// ---------------------------------------------------------------------------

/** 命中产品代码里任何 `node:` 内建 import（含 `import()` 与 `require`）。返回命中行。 */
export function scanNodeBuiltins(source: string): string[] {
  const hits: string[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    // 只认真正的内建引用，避免把注释里出现的 "node:fs" 误报：要求有 import/require 形状。
    if (/(?:from\s*['"]node:|import\s*\(\s*['"]node:|require\s*\(\s*['"]node:)/.test(line)) {
      hits.push(rawLine);
    }
  }
  return hits;
}

const JOURNAL_DIR = fileURLToPath(new URL('../../../apps/mobile-kernel/journal/', import.meta.url));

function listJournalSources(): readonly string[] {
  return readdirSync(JOURNAL_DIR)
    .filter((name) => name.endsWith('.ts'))
    .sort();
}

// ---------------------------------------------------------------------------
// §1 出口齐备
// ---------------------------------------------------------------------------

describe('K-I25 §1 提升面：产品模块公开出口', () => {
  const functions = [
    'encodeFrame',
    'encodeFrames',
    'decodeFrames',
    'recoverJournal',
    'applyFrameToState',
    'buildChain',
    'findStep',
    'createInitialState',
    'cloneState',
    'isKernelJournalError',
    'KernelJournalError',
    'PersistentMedia',
    'StorageMedia',
    'KernelJournalStore',
  ] as const;

  it.each(functions)('导出可调用的 %s', (name) => {
    expect(typeof (journal as Record<string, unknown>)[name]).toBe('function');
  });

  it('帧常量与词表就位', () => {
    expect(journal.HEADER_LEN).toBe(14);
    expect(journal.DIGEST_LEN).toBe(64);
    expect(journal.JOURNAL_MAGIC).toBe('PBJF');
    expect(journal.FRAME_FORMAT_VERSION).toBe(1);
    expect(journal.LATEST_SCHEMA_VERSION).toBe(3);
    expect(journal.SUPPORTED_SCHEMA_VERSIONS).toEqual([1, 2, 3]);
    expect(journal.FAULT_POINTS).toHaveLength(5);
    expect(journal.RECORD_KINDS).toEqual(['put', 'delete', 'migration']);
    expect(new Set(journal.KERNEL_DB_ERROR_CODES).size).toBe(journal.KERNEL_DB_ERROR_CODES.length);
  });

  it('两种介质都满足 `Media` 结构（内存 + 存储）', () => {
    const memory: Media = new journal.PersistentMedia();
    const storage: Media = journal.StorageMedia.open({
      fs: {
        ensureDir: () => {},
        exists: () => false,
        readFile: () => new Uint8Array(0),
        writeFile: () => {},
        rename: () => {},
        removeFile: () => {},
        listFiles: () => [],
        listDirs: () => [],
      },
      path: 'unused',
    });
    for (const media of [memory, storage]) {
      expect(typeof media.append).toBe('function');
      expect(typeof media.sync).toBe('function');
      expect(typeof media.syncPrefix).toBe('function');
      expect(typeof media.durable).toBe('function');
      expect(typeof media.pendingBytes).toBe('function');
      expect(typeof media.truncateTo).toBe('function');
    }
  });
});

// ---------------------------------------------------------------------------
// §2 产品树零 node 内建（带变异自证）
// ---------------------------------------------------------------------------

describe('K-I25 §2 产品树零 node 内建', () => {
  it('扫描器用干净样例不被误报、用假样例必定命中（自证判别力）', () => {
    expect(scanNodeBuiltins("import { sha256Digest } from '../storage/sha256.js';")).toEqual([]);
    expect(scanNodeBuiltins("const fs = require('node:fs');")).toHaveLength(1);
    expect(scanNodeBuiltins("import { readFileSync } from 'node:fs';")).toHaveLength(1);
    expect(scanNodeBuiltins("const m = await import('node:path');")).toHaveLength(1);
  });

  it('所有产品源码都不 import node 内建，且确实复用了 K09 的 sha256', () => {
    const sources = listJournalSources();
    expect(sources).toContain('framing.ts');
    expect(sources).toContain('media.ts');

    const offenders: string[] = [];
    for (const name of sources) {
      const text = readFileSync(new URL(`../../../apps/mobile-kernel/journal/${name}`, import.meta.url), 'utf8');
      for (const hit of scanNodeBuiltins(text)) offenders.push(`${name}: ${hit}`);
    }
    expect(offenders).toEqual([]);

    const framing = readFileSync(new URL('../../../apps/mobile-kernel/journal/framing.ts', import.meta.url), 'utf8');
    expect(framing).toContain("from '../storage/sha256.js'");
  });
});

// ---------------------------------------------------------------------------
// §3 K-R02 已转发产品模块
// ---------------------------------------------------------------------------

describe('K-I25 §3 K-R02 断言改跑产品代码', () => {
  it('K-R02 barrel 转发产品模块，且不再保留实现副本', () => {
    const barrel = readFileSync(
      new URL('../K-R02/index.ts', import.meta.url),
      'utf8',
    );
    expect(barrel).toContain('apps/mobile-kernel/journal/index.js');
    // 原先的实现文件应已提升走：不再在 K-R02 目录里存在。
    for (const moved of ['schemas.ts', 'errors.ts', 'framing.ts', 'migration.ts', 'journal-store.ts']) {
      expect(existsSync(new URL(`../K-R02/${moved}`, import.meta.url))).toBe(false);
    }
  });
});

/**
 * F-I17 守卫（横切，只读）——**裸 NUL（0x00）字节扫描**。
 *
 * 背景：F02 的源码曾被一个**裸 0x00 字节**咬过，随后 F04 又复现了同一类问题。裸 NUL 在
 * `.ts` 里既不报错也不可见：它能悄悄截断字符串、让正则失配、让契约比对走样，因此必须由
 * 一道**字节级**守卫来拦住它。本守卫对 lane F 的全部脚本源文件扫描，任何一个 0x00 都判
 * 失败（退出码 1），交回属主单元修复；本守卫**只读**，绝不改动任何他人文件。
 *
 * 范围：`apps/mobile-ui/src/**` 与 `tests/mobile-ui/**` 下的脚本文本
 * （.ts / .tsx / .mts / .cts / .js / .mjs / .cjs）。不扫描 .md / .css / .json / .log
 * 等非脚本文本——那些应由各自的产物守卫负责。
 *
 * 运行：`npx vitest run tests/mobile-ui/guards --reporter=basic`（干净时退出码 0）。
 *
 * 隐私：本守卫只输出「文件 : 字节偏移」，绝不打印文件内容。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const LANE_ROOTS: readonly string[] = [
  join(REPO_ROOT, 'apps', 'mobile-ui', 'src'),
  join(REPO_ROOT, 'tests', 'mobile-ui'),
];
const SOURCE_EXTS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function walk(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) visit(full);
      else if (SOURCE_EXTS.some((ext) => name.endsWith(ext))) found.push(full);
    }
  };
  visit(root);
  return found;
}

/** 返回内容中每个裸 0x00 的 0 基字节偏移；空数组表示无裸 NUL。 */
function nulOffsets(buf: Uint8Array): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0) offsets.push(i);
  }
  return offsets;
}

const FILES: readonly string[] = LANE_ROOTS.flatMap((root) => walk(root));

describe('F-I17 守卫 / 裸 NUL 字节', () => {
  it('扫描范围非空，且同时覆盖 src 与 tests', () => {
    expect(FILES.length).toBeGreaterThan(50);
    const srcHit = FILES.some((f) => toPosix(f).includes('/apps/mobile-ui/src/'));
    const testHit = FILES.some((f) => toPosix(f).includes('/tests/mobile-ui/'));
    expect(srcHit).toBe(true);
    expect(testHit).toBe(true);
  });

  it('lane 内任何脚本文件都不含裸 0x00 字节', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const offsets = nulOffsets(readFileSync(file));
      if (offsets.length > 0) {
        offenders.push(`${toPosix(relative(REPO_ROOT, file))} @ byte ${offsets.join(',')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('检测器自检：确实能发现 NUL（避免空转通过）', () => {
    expect(nulOffsets(Buffer.from([0x61, 0x00, 0x62]))).toEqual([1]);
    expect(nulOffsets(Buffer.from([0x00]))).toEqual([0]);
    expect(nulOffsets(Buffer.from([0x00, 0x00, 0x61]))).toEqual([0, 1]);
    expect(nulOffsets(Buffer.from('abc', 'utf8'))).toEqual([]);
    expect(nulOffsets(Buffer.alloc(0))).toEqual([]);
  });
});

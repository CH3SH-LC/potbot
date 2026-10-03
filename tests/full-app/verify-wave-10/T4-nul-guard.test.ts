/**
 * FA-VERIFY-WAVE-10 · 第 4 项 —— **裸 NUL 守卫**（`8131d67`）独立复核。
 *
 * 判据（任务原文）：
 *   a) 验证方**自己扫一遍** `apps/**` + `src/**`，确认 0 命中（源码里没有真正的 0x00 字节）；
 *   b) **自造一个含 NUL 的临时文件**，验证守卫**会红**（不是恒绿的摆设）。
 *
 * 做法：(a) 用**验证方自写**的字节级扫描器；(b) 同时喂给**验证方扫描器**与**实现方扫描器**
 * （`tests/full-app/nul-bytes/scan-nul-bytes.ts` 的 `scanDirForNulBytes`），两边都必须检出。
 *
 * 为什么必须是**字节级**：源码里出现真 0x00 会让 git 把该文件判成二进制（`-text`），
 * 于是**没有行级三方合并**——在多 worktree 并行、最后合并的仓里，冲突只能整份取边。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { scanDirForNulBytes } from '../nul-bytes/scan-nul-bytes.js';

const REPO_ROOT = process.cwd();

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.runtime', 'build', 'dist', 'out', 'coverage']);

/** 验证方自写的字节级扫描器（**独立于**实现方的工具）。 */
function scanNulBytes(root: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
        if (readFileSync(full).includes(0)) hits.push(relative(root, full).split(sep).join('/'));
      }
    }
  };
  walk(root);
  return hits.sort();
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('W10-T4 · 扫描器自证（含 NUL 的临时文件必须被检出）', () => {
  it('自造含真 0x00 的临时源码文件 ⇒ 验证方扫描器与实现方扫描器**都**报红', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w10-nul-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, 'nested'), { recursive: true });

    // 真字节 0x00，不是转义写法（转义写法 `\0` 是 5C 30，是合法的）。
    const nulByte = Buffer.from([0x00]);
    writeFileSync(
      join(dir, 'dirty.ts'),
      Buffer.concat([Buffer.from('const x = "a', 'utf8'), nulByte, Buffer.from('b";\n', 'utf8')]),
    );
    writeFileSync(join(dir, 'nested', 'also-dirty.js'), Buffer.concat([Buffer.from('// x', 'utf8'), nulByte, Buffer.from('\n', 'utf8')]));
    writeFileSync(join(dir, 'clean.ts'), 'const y = "\\0"; // 转义写法：合法，不得误报\n');

    const mine = scanNulBytes(dir);
    expect(mine).toEqual(['dirty.ts', 'nested/also-dirty.js']);

    const theirs = scanDirForNulBytes(dir);
    expect(theirs).toEqual(['dirty.ts', 'nested/also-dirty.js']);
  });

  it('干净目录（只有转义写法）⇒ 两个扫描器都不报（守卫不是恒红）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w10-nul-clean-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'ok.ts'), 'const s = "\\0";\n');
    expect(scanNulBytes(dir)).toEqual([]);
    expect(scanDirForNulBytes(dir)).toEqual([]);
  });
});

describe('W10-T4 · 真实源码树必须 0 命中', () => {
  it('验证方扫描 apps + src ⇒ 0 个含裸 NUL 的源码文件', () => {
    const hits = [...scanNulBytes(join(REPO_ROOT, 'apps')), ...scanNulBytes(join(REPO_ROOT, 'src'))];
    // eslint-disable-next-line no-console
    console.log(`[W10 NUL] apps+src 命中 = ${String(hits.length)}${hits.length === 0 ? '' : ` :: ${hits.join(', ')}`}`);
    expect(hits).toEqual([]);
  });

  it('实现方扫描器在 apps + src 上同样 0 命中（对表）', () => {
    const hits = [...scanDirForNulBytes(join(REPO_ROOT, 'apps')), ...scanDirForNulBytes(join(REPO_ROOT, 'src'))];
    expect(hits).toEqual([]);
  });

  it('整仓扫描（含 tests/）也 0 命中（本工作包新增文件不得引入裸 NUL）', () => {
    const hits = scanDirForNulBytes(REPO_ROOT);
    // eslint-disable-next-line no-console
    console.log(`[W10 NUL] 整仓命中 = ${String(hits.length)}${hits.length === 0 ? '' : ` :: ${hits.join(', ')}`}`);
    expect(hits).toEqual([]);
  });
});

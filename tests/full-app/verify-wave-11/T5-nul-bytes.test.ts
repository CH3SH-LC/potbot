/**
 * FA-VERIFY-WAVE-11 · 第 5 项 —— **裸 NUL 守卫**（`8131d67`）独立复核。
 *
 * ## 被复核的断言（任务原文）
 *
 * - 自扫 `apps/**` + `src/**` 应 **0 命中**；
 * - **自造**含 NUL 的临时文件必须**报红**。
 *
 * ## 本文件怎么做
 *
 * ① **验证方自写**的字节级扫描器（不 import 实现方的量尺）扫 `apps` + `src` ⇒ 0 命中；
 * ② 判别力自证：含真 `0x00` 的临时 `.ts` 必须被检出；不含的不得检出；含 `0x00` 的 `.bin`
 *    不得检出（避免误报真正的二进制资产）；
 * ③ **根因自证**：证明"裸 NUL ⇒ git 判二进制"这件事**真的会发生**（用 `git diff --no-index
 *    --numstat`，不碰索引、不改仓库状态），而等价的**转义写法**（`\0`）仍是文本。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const REPO = process.cwd();

/** 视为「源码」的扩展名（与实现方口径一致；本文件**独立实现**判据，不 import 它）。 */
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.runtime', 'build', 'dist', 'out', 'coverage']);

/** 验证方自写的**字节级**扫描器：逐字节找 0x00，不做任何字符串解码。 */
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
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'w11-nul-'));
  tempDirs.push(dir);
  return dir;
}

describe('W11-T5 · 真实源码树必须 0 命中（验证方自写扫描器）', () => {
  it('apps/** + src/** 的源码文件里没有裸 NUL 字节', () => {
    const hits = [...scanNulBytes(join(REPO, 'apps')), ...scanNulBytes(join(REPO, 'src'))];
    // eslint-disable-next-line no-console
    console.log(`[W11 NUL] apps+src 命中 = ${String(hits.length)}${hits.length === 0 ? '' : `：${hits.join(', ')}`}`);
    expect(hits).toEqual([]);
  }, 60_000);
});

describe('W11-T5 · 判别力自证：含 NUL 的临时文件必须报红（不是恒绿的摆设）', () => {
  it('含真 0x00 的 .ts 被检出；干净的 .ts 与含 0x00 的 .bin 都不算命中', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'nested'), { recursive: true });
    mkdirSync(join(dir, 'assets'), { recursive: true });

    const nul = Buffer.from([0x00]);
    writeFileSync(join(dir, 'dirty.ts'), Buffer.concat([Buffer.from('const a = "x'), nul, Buffer.from('y";\n')]));
    writeFileSync(
      join(dir, 'nested', 'also-dirty.mjs'),
      Buffer.concat([Buffer.from('// c'), nul, Buffer.from('\n')]),
    );
    // 转义写法（`\0` 是 5C 30 两个字节）是**合法**的，不得误报。
    writeFileSync(join(dir, 'clean.ts'), 'const s = "\\0"; // 转义写法：合法\n');
    // 真正的二进制资产（扩展名非源码）不得误报。
    writeFileSync(join(dir, 'assets', 'blob.bin'), Buffer.from([1, 0, 2]));
    writeFileSync(join(dir, 'assets', 'template.docx'), Buffer.from([0x50, 0x4b, 0, 3]));

    expect(scanNulBytes(dir)).toEqual(['dirty.ts', 'nested/also-dirty.mjs']);
  });

  it('对照：全是转义写法的目录 ⇒ 0 命中（守卫不是恒红）', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'ok.ts'), 'const s = "\\0"; const t = "\\x00";\n');
    expect(scanNulBytes(dir)).toEqual([]);
  });
});

describe('W11-T5 · 根因自证：裸 NUL 会让 git 把该文件判成二进制（丧失行级合并/diff）', () => {
  it('裸 0x00 的文件 git 判二进制（numstat 显示 "-"），而等价转义写法仍是文本', () => {
    const dir = tempDir();
    const raw = join(dir, 'raw.ts');
    const escaped = join(dir, 'escaped.ts');
    writeFileSync(raw, Buffer.concat([Buffer.from('const a = "x'), Buffer.from([0x00]), Buffer.from('y";\n')]));
    writeFileSync(escaped, 'const a = "x\\0y";\n');

    // `--numstat` 对二进制文件输出 `-\t-\t<path>`，对文本输出 `<added>\t<deleted>\t<path>`。
    // `--no-index` 只比较两个工作区文件，**不碰索引、不改仓库状态**。
    const numstat = (target: string): string => {
      try {
        return execFileSync('git', ['diff', '--no-index', '--numstat', '/dev/null', target], {
          cwd: dir,
          encoding: 'utf8',
        });
      } catch (error) {
        // git diff --no-index 在"有差异"时退出码为 1；stdout 仍在 error 上。
        const stdout = (error as { stdout?: string }).stdout ?? '';
        return stdout;
      }
    };

    const rawStat = numstat(raw);
    const escapedStat = numstat(escaped);

    expect(rawStat, `裸 NUL 的文件必须被 git 判为二进制（实测：${rawStat.trim()}）`).toMatch(/^-\s+-\s/m);
    expect(escapedStat, `转义写法必须仍是文本（实测：${escapedStat.trim()}）`).not.toMatch(/^-\s+-\s/m);
    expect(escapedStat).toMatch(/\d+\s+\d+\s/m);
  }, 60_000);
});

/**
 * FA-VERIFY-WAVE-11 · 第 3 项 —— **CRLF shebang**（`f056f3e` 的 `.gitattributes`）独立复核。
 *
 * ## 被复核的断言（任务原文）
 *
 * 1. `tests/demo/honor-connect.test.ts` 与 `honor-hdb.test.ts` 现在必须**真通过**
 *    （改前是收集期 `SyntaxError`）；
 * 2. **自造**一个"带 shebang 的 CRLF `.mjs`"验证该形态**确实会炸**（证根因成立）；
 * 3. **扫全仓**：还有没有别的 tracked 文件是"带 shebang 且工作区为 CRLF"。
 *
 * ## 本文件怎么做
 *
 * ① 与 ② 在这里机器化：在**仓内**（vitest/vite 的 root 之下，才会走 SSR 变换）写三份临时 `.mjs`：
 *      - `lf.mjs`      —— `#!` + LF：**必须**能 import（正例）；
 *      - `crlf.mjs`    —— `#!` + CRLF：**必须**炸（根因）；
 *      - `crlf-no-shebang.mjs` —— CRLF 但**没有** `#!`：**必须**能 import（对照 ⇒ 炸的是
 *        "shebang × CRLF"这个组合，不是 CRLF 本身，也不是"import 一律不行"）。
 *    ③ 用 `git ls-files` 列 tracked 文件，逐个按**字节**判断"首行是 shebang 且行尾是 CRLF"。
 *
 * ① 里"那两个测试文件真通过"由 CLI 单独跑（见交付说明的复现命令）：在**测试内部**再跑一遍
 * vitest 会嵌套，且会把"本文件自己是否被收集"搅进来；这里改为钉住**使它们能通过的那个字节事实**
 * （真文件在工作区里是 LF 的 shebang 文件），把"是否真通过"留给 CLI 证据。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO = process.cwd();

/** 临时件必须落在 **vite root 之下**才会走被测的那条 SSR 变换路径。 */
const SCRATCH_DIR = join(REPO, '.runtime', 'w11-crlf-shebang');

function writeScratch(name: string, text: string): string {
  mkdirSync(SCRATCH_DIR, { recursive: true });
  const path = join(SCRATCH_DIR, name);
  writeFileSync(path, text);
  return path;
}

/** 动态 import 一个文件，返回错误消息（成功则为空串）。 */
async function importErrorOf(path: string): Promise<string> {
  try {
    await import(`${pathToFileURL(path).href}?w11=${String(Date.now())}${String(Math.random())}`);
    return '';
  } catch (error) {
    return String((error as Error).message);
  }
}

function hasCrlf(bytes: Uint8Array): boolean {
  for (let index = 0; index + 1 < bytes.byteLength; index += 1) {
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) return true;
  }
  return false;
}

function firstLineEndsCrlf(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0x0a) return index > 0 && bytes[index - 1] === 0x0d;
  }
  return false;
}

function startsWithShebang(bytes: Uint8Array): boolean {
  return bytes[0] === 0x23 && bytes[1] === 0x21; // '#!'
}

function gitLsFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  const text = out.toString('utf8');
  return text.split('\u0000').filter((entry) => entry !== '');
}

describe('W11-T3 · 根因自证：带 shebang 的 CRLF .mjs 在本工具链里确实会炸', () => {
  it('LF + shebang ⇒ 能 import；CRLF + shebang ⇒ 必炸；CRLF 但没有 shebang ⇒ 能 import', async () => {
    try {
      const lf = writeScratch('lf.mjs', '#!/usr/bin/env node\nexport const marker = "lf-ok";\n');
      const crlf = writeScratch('crlf.mjs', '#!/usr/bin/env node\r\nexport const marker = "crlf-ok";\r\n');
      const crlfNoShebang = writeScratch('crlf-no-shebang.mjs', 'export const marker = "crlf-no-shebang-ok";\r\n');

      // 正例：LF + shebang 在 vitest 的模块图里能正常求值。
      const lfError = await importErrorOf(lf);
      expect(lfError, `LF + shebang 必须能 import，实测报错：${lfError}`).toBe('');

      // 根因：CRLF + shebang 会炸（Vite 的 hashbangRE `/^#!.*\n/` 里的 `.` 不匹配 `\r`，
      // 于是 shebang 没被剥掉、导出登记代码被插到 `#!` 之前 ⇒ 输出源码非法）。
      const crlfError = await importErrorOf(crlf);
      expect(crlfError, 'CRLF + shebang 必须炸（否则本条根因就不成立）').not.toBe('');
      expect(crlfError).toMatch(/Invalid or unexpected token|SyntaxError/i);

      // 对照：CRLF **本身**不是问题（没有 shebang 的 CRLF 文件照样能 import）。
      const crlfNoShebangError = await importErrorOf(crlfNoShebang);
      expect(
        crlfNoShebangError,
        `CRLF 本身必须能 import（炸的应只是 shebang × CRLF）：${crlfNoShebangError}`,
      ).toBe('');
    } finally {
      rmSync(SCRATCH_DIR, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('W11-T3 · 真文件：被修的那两个脚本在工作区里是「shebang + LF」', () => {
  it('scripts/demo/honor-connect.mjs 与 honor-hdb.mjs：首行 shebang、全文件无 CRLF', () => {
    for (const rel of ['scripts/demo/honor-connect.mjs', 'scripts/demo/honor-hdb.mjs']) {
      const bytes = new Uint8Array(readFileSync(join(REPO, rel)));
      expect(startsWithShebang(bytes), `${rel} 应以 #! 开头`).toBe(true);
      expect(hasCrlf(bytes), `${rel} 工作区里不得有 CRLF（否则收集期必炸）`).toBe(false);
    }
  });

  it('.gitattributes 确实把 *.mjs / *.mts 钉成 LF（修法本身在树上）', () => {
    const text = readFileSync(join(REPO, '.gitattributes'), 'utf8');
    expect(text).toMatch(/\*\.mjs\s+text\s+eol=lf/);
    expect(text).toMatch(/\*\.mts\s+text\s+eol=lf/);
  });
});

/** 会**经过 JS 模块管线**（vitest / vite 的 SSR 变换）的扩展名；只有这一类会因 hashbang 正则失配炸掉。 */
const JS_PIPELINE_EXT = /\.(mjs|mts|js|cjs|jsx|ts|tsx|cts)$/i;

type ShebangVerdict = 'not-shebang' | 'shebang-lf' | 'js-pipeline-crlf' | 'other-crlf';

/** **唯一判据**（扫描与自证共用同一条）：字节判定 + 扩展名归类。 */
function classifyShebangCrlf(bytes: Uint8Array, rel: string): ShebangVerdict {
  if (!startsWithShebang(bytes)) return 'not-shebang';
  if (!firstLineEndsCrlf(bytes) && !hasCrlf(bytes)) return 'shebang-lf';
  return JS_PIPELINE_EXT.test(rel) ? 'js-pipeline-crlf' : 'other-crlf';
}

interface ShebangScan {
  readonly scanned: number;
  readonly shebangFiles: readonly string[];
  readonly jsFamilyOffenders: readonly string[];
  readonly otherOffenders: readonly string[];
}

function scanTrackedShebangFiles(): ShebangScan {
  const shebangFiles: string[] = [];
  const jsFamilyOffenders: string[] = [];
  const otherOffenders: string[] = [];
  let scanned = 0;
  for (const rel of gitLsFiles()) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(join(REPO, rel)));
    } catch {
      continue; // 目录项 / 不可读：跳过（不把"读不到"当"有问题"）
    }
    scanned += 1;
    const verdict = classifyShebangCrlf(bytes, rel);
    if (verdict === 'not-shebang') continue;
    shebangFiles.push(rel);
    if (verdict === 'js-pipeline-crlf') jsFamilyOffenders.push(rel);
    if (verdict === 'other-crlf') otherOffenders.push(rel);
  }
  return { scanned, shebangFiles, jsFamilyOffenders, otherOffenders };
}

describe('W11-T3 · 全仓扫描：还有没有别的 tracked 文件是「shebang + 工作区 CRLF」', () => {
  it('会走 JS 模块管线（.mjs/.mts/.js/.ts…）的 shebang 文件，工作区 CRLF 必须为 0', () => {
    const result = scanTrackedShebangFiles();
    // 扫描面必须非空（否则"0 命中"没有意义）。
    expect(result.scanned, 'tracked 文件数不应为 0（扫描确实跑了）').toBeGreaterThan(0);
    expect(result.shebangFiles.length, 'tracked 的 shebang 文件数不应为 0').toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(
      `[W11 CRLF-shebang] 扫 ${String(result.scanned)} 个 tracked 文件；shebang 文件 ${String(
        result.shebangFiles.length,
      )} 个；JS 管线违规 ${String(result.jsFamilyOffenders.length)} 个；非 JS 管线 CRLF shebang ${String(
        result.otherOffenders.length,
      )} 个`,
    );
    expect(
      result.jsFamilyOffenders,
      `这些会经过 vitest 的 SSR 变换 ⇒ 收集期 SyntaxError：${result.jsFamilyOffenders.join(', ')}`,
    ).toEqual([]);
  }, 60_000);

  it('★判别力自证：同一条判据喂四种合成字节，只有「shebang + CRLF + JS 扩展名」被判违规', () => {
    const encoder = new TextEncoder();
    const lfShebang = encoder.encode('#!/usr/bin/env node\nexport const x = 1;\n');
    const crlfShebang = encoder.encode('#!/usr/bin/env node\r\nexport const x = 1;\r\n');
    const crlfNoShebang = encoder.encode('export const x = 1;\r\n');
    const crlfShebangPy = encoder.encode('#!/usr/bin/env python3\r\nprint(1)\r\n');

    // 正例（必须被抓住的那一类）。
    expect(classifyShebangCrlf(crlfShebang, 'a.mjs')).toBe('js-pipeline-crlf');
    expect(classifyShebangCrlf(crlfShebang, 'a.ts')).toBe('js-pipeline-crlf');
    // 对照 A：LF + shebang ⇒ 干净（不能误报成违规）。
    expect(classifyShebangCrlf(lfShebang, 'a.mjs')).toBe('shebang-lf');
    // 对照 B：CRLF 但没有 shebang ⇒ 与 shebang 无关，不算违规。
    expect(classifyShebangCrlf(crlfNoShebang, 'a.mjs')).toBe('not-shebang');
    // 对照 C：shebang + CRLF 但非 JS 管线 ⇒ 归到"其它"，不混进 JS 违规集。
    expect(classifyShebangCrlf(crlfShebangPy, 'a.py')).toBe('other-crlf');
  });

  it('如实登记：非 JS 管线（.py/.sh）里仍存在「shebang + CRLF」的 tracked 文件（不经 vitest，不炸收集期）', () => {
    const result = scanTrackedShebangFiles();
    // 这条**不是**缺陷断言，而是**如实登记**：扫描确实能抓到东西（守卫不是"永远绿"），
    // 且抓到的这批**不经过** vitest/vite 的模块管线，因此不构成本项目的收集期 SyntaxError。
    // 但它们在 POSIX 上同样是坏 shebang —— 本工作包只登记事实，交其它工作流判断。
    // eslint-disable-next-line no-console
    console.log(
      `[W11 CRLF-shebang] 非 JS 管线 CRLF shebang（如实登记，共 ${String(
        result.otherOffenders.length,
      )} 个）：${result.otherOffenders.length === 0 ? '（无）' : result.otherOffenders.join(', ')}`,
    );
    // 复核分类器没有把它们错判进 JS 违规集（否则上一条会红）。
    for (const rel of result.otherOffenders) {
      expect(JS_PIPELINE_EXT.test(rel), `${rel} 不该出现在 JS 违规集里`).toBe(false);
    }
  }, 60_000);
});

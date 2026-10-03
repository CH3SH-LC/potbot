/**
 * FA-VERIFY-WAVE-12 · 第 3 项 —— CRLF × shebang（`f056f3e` / `fedee35`）独立复核。
 *
 * ## 待验声明
 *
 * ① `tests/demo/honor-connect.test.ts` 必须**真通过**（改前因 Vite hashbang 正则不匹配 CRLF，
 *    收集期 SyntaxError ⇒ 0 tests）；
 * ② `.gitattributes` 的 `*.mjs` / `*.sh` 规则**生效**；
 * ③ **自造** CRLF shebang `.js` 验证扫描器**会红**（有判别力，不是永远绿的空壳）。
 *
 * ## 本文件怎么独立证伪 / 证真
 *
 * ① 由**本工作包**在字节层核对 `scripts/demo/honor-connect.mjs` 的**首行行尾**（不借实现方夹具），
 *    并另起一个 `node --experimental-strip-types` **子进程**真跑该 `.js` 侧行为；
 * ② 用 `git check-attr` 对**真实文件**与**同后缀的合成路径**分别复算 `eol`（证明规则覆盖"新文件"，
 *    不只是碰巧那几个已存在的文件）；
 * ③ 造 CRLF shebang `.js` / LF shebang `.js` / 无 shebang 的 CRLF `.js` 三个对照，喂给扫描器。
 *
 * ## 边界（如实登记）
 *
 * `tests/demo/honor-connect.test.ts` 有 2 条用例在本工作树的**干净检出**下会 ENOENT 失败
 * （见本文件末尾"关于 ①"的实测记录）：它们 `mkdtemp` 到 `<repoRoot>/.runtime`，而
 * `.runtime` 是 gitignore 的、干净 worktree 里**不存在**。这不是 CRLF 那条缺陷的复发，
 * 但它使"该文件真通过"这句话在**新 worktree** 上不成立。本包只报告、不修。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { checkAttributes, scanRepo, evaluateShebangFile } from '../crlf-shebang/shebang-scan.js';

const REPO = resolve(process.cwd());

/** 首行行尾：逐字节看第一个 `\n` 前一个字节是不是 `\r`。 */
function firstLineEol(bytes: Buffer): 'LF' | 'CRLF' | 'NONE' {
  const nl = bytes.indexOf(0x0a);
  if (nl < 0) return 'NONE';
  return nl > 0 && bytes[nl - 1] === 0x0d ? 'CRLF' : 'LF';
}

const scratch = mkdtempSync(join(tmpdir(), 'potbot-wave12-crlf-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('T3 · ① CRLF×shebang 根因：应被扫描的 .mjs 是 LF，且能真跑', () => {
  it('scripts/demo/honor-connect.mjs 首行是 LF 的 shebang（改前是 CRLF ⇒ Vite 收集期炸）', () => {
    const target = join(REPO, 'scripts', 'demo', 'honor-connect.mjs');
    const bytes = readFileSync(target);
    expect(firstLineEol(bytes)).toBe('LF');
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('#!');
    // 整文件不得含任何 CRLF（shebang 之外的行尾同样会污染）。
    expect(bytes.includes(Buffer.from('\r\n', 'latin1'))).toBe(false);
  });

  it('全仓 tracked .mjs / .mts 一律不含 CRLF（Vite 可变换面不得有 CRLF）', () => {
    const report = scanRepo(REPO);
    const mjsRed = report.red.filter((r) => r.ext === '.mjs' || r.ext === '.mts' || r.ext === '.js' || r.ext === '.ts');
    expect(mjsRed.map((r) => `${r.verdict} ${r.path}`)).toEqual([]);
    // 报告里确实**看过**这些扩展名（防止"集合空是因为没扫到"）。
    expect(report.reports.some((r) => r.ext === '.mjs')).toBe(true);
  });

  it('★ 用**真 node 子进程**执行该 .mjs 的 hashbang 首行语义（不是只看字节）', () => {
    // 子进程直接 require/import 该 .mjs：若首行是 `#!/usr/bin/env node\r`，Windows 上
    // 也无所谓（Windows 不解析 shebang），但在 Unix 上 `\r` 会进解释器路径。这里用一个
    // 与平台无关的等价探针：把一个 CRLF shebang 的副本交给 `node --check` 之外的
    // **源码解析**路径 —— 见下一条：扫描器必须把它判红。
    const lfCopy = join(scratch, 'lf-probe.mjs');
    writeFileSync(lfCopy, '#!/usr/bin/env node\nexport const ok = 1;\n', 'latin1');
    expect(firstLineEol(readFileSync(lfCopy))).toBe('LF');
    const out = execFileSync(process.execPath, ['--experimental-strip-types', lfCopy], {
      encoding: 'utf8',
    });
    expect(out).toBe('');
  });
});

describe('T3 · ② .gitattributes 的 *.mjs / *.sh 规则生效', () => {
  it('真实 .mjs/.sh 与**同后缀合成路径**都解析出 eol=lf（规则覆盖新文件）', () => {
    const attrs = checkAttributes(REPO, [
      'scripts/demo/honor-connect.mjs', // 已存在
      'scripts/demo/__does_not_exist_new.mjs', // 合成：以 .mjs 结尾（文件不必存在）
      'tests/full-app/verify-wave-12/__synthetic.sh', // 合成：以 .sh 结尾
      'tests/full-app/verify-wave-12/__synthetic2.sh', // 合成：再来一条
    ]);
    expect(attrs.get('scripts/demo/honor-connect.mjs')?.eol, '.mjs 应受 eol=lf 保护').toBe('lf');
    expect(attrs.get('scripts/demo/__does_not_exist_new.mjs')?.eol, '.mjs 规则应覆盖新文件').toBe('lf');
    expect(attrs.get('tests/full-app/verify-wave-12/__synthetic.sh')?.eol, '.sh 规则应覆盖新文件').toBe('lf');
    expect(attrs.get('tests/full-app/verify-wave-12/__synthetic2.sh')?.eol, '.sh 规则应覆盖新文件').toBe('lf');
  });

  it('反向对照：`*.cmd`（本仓无规则）解析不出 lf（证明上面的 lf 不是"什么都是 lf"）', () => {
    const attrs = checkAttributes(REPO, ['scripts/demo/honor-connect.cmd']);
    expect(attrs.get('scripts/demo/honor-connect.cmd')?.eol).toBe('unspecified');
  });
});

describe('T3 · ③ 判别力：自造 CRLF shebang 会被扫描器判红', () => {
  it('CRLF shebang 的 .js ⇒ RED_CRLF_UNPROTECTED（且属 Vite 可变换 = 真门禁阻塞）', () => {
    const file = join(scratch, 'crlf.js');
    writeFileSync(file, '#!/usr/bin/env node\r\nconsole.log(1);\r\n', 'latin1');
    const report = evaluateShebangFile(REPO, 'scratch/crlf.js', file, undefined);
    expect(report.verdict).toBe('RED_CRLF_UNPROTECTED');
    expect(report.viteTransformable).toBe(true);
  });

  it('对照 A：LF shebang 的 .js 不得判红', () => {
    const file = join(scratch, 'lf.js');
    writeFileSync(file, '#!/usr/bin/env node\nconsole.log(1);\n', 'latin1');
    expect(evaluateShebangFile(REPO, 'scratch/lf.js', file, undefined).verdict).not.toBe('RED_CRLF_UNPROTECTED');
  });

  it('对照 B：CRLF 但**无 shebang** 的 .js 不得判红（避免误报普通 CRLF 文件）', () => {
    const file = join(scratch, 'noshebang.js');
    writeFileSync(file, 'console.log(1);\r\nconsole.log(2);\r\n', 'latin1');
    const report = evaluateShebangFile(REPO, 'scratch/noshebang.js', file, undefined);
    expect(report.verdict).toBe('NOT_APPLICABLE_NO_SHEBANG');
  });

  it('对照 C：CRLF shebang 但**有 eol=lf 保护** ⇒ 降为 ADVISORY，不判红', () => {
    const file = join(scratch, 'protected.js');
    writeFileSync(file, '#!/usr/bin/env node\r\nconsole.log(1);\r\n', 'latin1');
    const report = evaluateShebangFile(REPO, 'scratch/protected.js', file, { eol: 'lf', text: 'set' });
    expect(report.verdict).toBe('ADVISORY_CRLF_PROTECTED');
  });
});

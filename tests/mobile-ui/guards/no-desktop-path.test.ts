/**
 * F-I17 守卫（横切，只读）——**桌面绝对路径 / 密钥类字面量扫描**。
 *
 * 目标：lane F 的**生产与夹具**代码必须与具体机器无关、且不得夹带任何凭据。具体地，
 * 非测试文件里出现下列任一即判失败（退出码 1）：
 *   - 盘符绝对路径（`C:\` / `D:/` …）或 POSIX 家目录路径（`/Users/…`、`/home/…`）；
 *   - 密钥类字面量（`sk-…` / `AKIA…` / `ghp_…` / GitHub PAT / PEM 私钥块）；
 *   - `Bearer <长令牌>`、中国大陆手机号、`NN号` 街道门牌。
 *
 * 为什么**测试文件豁免**路径/手机号/令牌：本仓库的测试**必须**构造敌意输入来证明拒绝逻辑
 * （F02 的 `createAttachmentPlaceholder`、F09 的脱敏用例、F-R06 的表单校验都用桌面路径/假
 * 手机号作为**被拒输入**）。若一刀切，守卫只会对合法负例误报。生产源码与夹具没有这种需要，
 * 因此仍严格禁止。密钥类字面量（真凭据）在**任何**文件里都禁止——包括测试。
 *
 * 注释会先被剔除，所以「注释里描述规则本身」（如 key-status.ts 说明『不接受盘符路径』）
 * 不会误报。
 *
 * 范围：`apps/mobile-ui/src/**` 与 `tests/mobile-ui/**` 下的脚本文本。
 *
 * 运行：`npx vitest run tests/mobile-ui/guards --reporter=basic`（干净时退出码 0）。
 *
 * 隐私：本守卫只输出「文件 : 行号 : 类别」，**绝不打印**命中的字面量本身。
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
const TEST_FILE = /\.test\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

type FindingKind =
  | 'key-material'
  | 'desktop-path'
  | 'posix-home-path'
  | 'bearer-token'
  | 'phone-number'
  | 'street-address';

interface Finding {
  readonly kind: FindingKind;
  readonly line: number;
}

/** 真凭据：任何文件里出现都判失败（测试也不行）。 */
const KEY_MATERIAL: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/,
  /sk-ant-[A-Za-z0-9-]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
/** 机器无关性：非测试文件禁止。 */
const DESKTOP_PATH: readonly RegExp[] = [/(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/];
const POSIX_HOME_PATH: readonly RegExp[] = [/(?:^|[^A-Za-z0-9_])\/(?:Users|home)\/[A-Za-z0-9._-]+/];
/** 疑似凭据/隐私：非测试文件禁止。 */
const SECRET_MARKER: readonly RegExp[] = [/Bearer\s+[A-Za-z0-9._-]{20,}/];
const PHONE: readonly RegExp[] = [/(?:^|[^0-9])1[3-9][0-9]{9}(?:[^0-9]|$)/];
const ADDRESS: readonly RegExp[] = [/[0-9]+\s*号/];

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

/** 剔除块注释与整行 `//` 注释，同时**保留行号**（块注释的非换行字符替换为空格）。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
}

function scanContent(relPath: string, content: string): Finding[] {
  const clean = stripComments(content).split('\n');
  const isTest = TEST_FILE.test(relPath);
  const findings: Finding[] = [];
  clean.forEach((line, idx) => {
    const lineNo = idx + 1;
    // 真凭据：一律失败。
    if (KEY_MATERIAL.some((re) => re.test(line))) {
      findings.push({ kind: 'key-material', line: lineNo });
    }
    // 测试文件可持有敌意/脱敏样本（路径、假手机号、假令牌）；其余文件继续严格检查。
    if (isTest) return;
    if (DESKTOP_PATH.some((re) => re.test(line))) {
      findings.push({ kind: 'desktop-path', line: lineNo });
    }
    if (POSIX_HOME_PATH.some((re) => re.test(line))) {
      findings.push({ kind: 'posix-home-path', line: lineNo });
    }
    if (SECRET_MARKER.some((re) => re.test(line))) {
      findings.push({ kind: 'bearer-token', line: lineNo });
    }
    if (PHONE.some((re) => re.test(line))) {
      findings.push({ kind: 'phone-number', line: lineNo });
    }
    if (ADDRESS.some((re) => re.test(line))) {
      findings.push({ kind: 'street-address', line: lineNo });
    }
  });
  return findings;
}

const FILES: readonly string[] = LANE_ROOTS.flatMap((root) => walk(root));

// 自检用的合成样本：全部**在运行时拼接**，源码里不出现任何真实密钥/手机号字面量。
const FAKE_KEY = ['sk-', 'A'.repeat(24)].join('');
const FAKE_PHONE = ['1', '38', '0013', '8000'].join('');
const FAKE_BEARER = ['Bearer ', 'B'.repeat(24)].join('');
const FAKE_DESKTOP = ['D:', '\\', 'work', '\\', 'x.docx'].join('');
const FAKE_ADDRESS = ['中山', '路 ', '10', '8 ', '号'].join('');

describe('F-I17 守卫 / 桌面路径与密钥字面量', () => {
  it('扫描范围非空', () => {
    expect(FILES.length).toBeGreaterThan(50);
  });

  it('非测试 lane 文件不含桌面路径 / 家目录路径 / 凭据 / 手机号 / 门牌', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const rel = toPosix(relative(REPO_ROOT, file));
      for (const f of scanContent(rel, readFileSync(file, 'utf8'))) {
        offenders.push(`${rel}:${f.line} [${f.kind}]`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('检测器自检：非测试文件命中路径/手机号/令牌/密钥', () => {
    const kinds = (rel: string, src: string): FindingKind[] =>
      scanContent(rel, src).map((f) => f.kind);
    expect(kinds('apps/mobile-ui/src/x.ts', `const p = ${JSON.stringify(FAKE_DESKTOP)};`)).toContain(
      'desktop-path',
    );
    expect(kinds('apps/mobile-ui/src/x.ts', "const p = '/home/u/y.docx';")).toContain(
      'posix-home-path',
    );
    expect(kinds('apps/mobile-ui/src/x.ts', `const k = ${JSON.stringify(FAKE_KEY)};`)).toContain(
      'key-material',
    );
    expect(kinds('apps/mobile-ui/src/x.ts', `const h = ${JSON.stringify(FAKE_BEARER)};`)).toContain(
      'bearer-token',
    );
    expect(kinds('apps/mobile-ui/src/x.ts', `const n = ${JSON.stringify(FAKE_PHONE)};`)).toContain(
      'phone-number',
    );
    expect(kinds('apps/mobile-ui/src/x.ts', `const a = ${JSON.stringify(FAKE_ADDRESS)};`)).toContain(
      'street-address',
    );
  });

  it('检测器自检：测试文件对路径/手机号/令牌豁免，但密钥仍拦截', () => {
    const kinds = (rel: string, src: string): FindingKind[] =>
      scanContent(rel, src).map((f) => f.kind);
    const testRel = 'tests/mobile-ui/F99/fixtures.test.ts';
    expect(kinds(testRel, `const p = ${JSON.stringify(FAKE_DESKTOP)};`)).toEqual([]);
    expect(kinds(testRel, `const n = ${JSON.stringify(FAKE_PHONE)};`)).toEqual([]);
    expect(kinds(testRel, `const h = ${JSON.stringify(FAKE_BEARER)};`)).toEqual([]);
    expect(kinds(testRel, `const k = ${JSON.stringify(FAKE_KEY)};`)).toContain('key-material');
  });

  it('检测器自检：注释里描述规则本身不算违规', () => {
    const src = ['/**', ' * 绝不接受盘符路径（`C:\\...`）——那些不是手机导入来源。', ' */', 'export const ok = 1;', ''].join('\n');
    expect(scanContent('apps/mobile-ui/src/x.ts', src)).toEqual([]);
  });
});

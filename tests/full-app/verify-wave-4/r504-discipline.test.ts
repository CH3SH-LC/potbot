/**
 * FA-VERIFY-WAVE-4 · R50.4 闭环复核：4 处"内核纪律"违约是否真的清零。
 *
 * 合同 `docs/other/prep/full-app-contract-v1.md` 附四（2026-10-03 修订）：
 * 1. `src/**`（非测试）零**代码**禁用 token（白名单文件仅豁免 `node:fs` / `node:path`）；
 * 2. 墙钟 / 随机 / 进程标识（`Date.now(` / `new Date(` / `performance.now(` / `Math.random(` /
 *    `process.pid` / `process.platform`）**包括白名单文件**一律禁止；
 * 3. 除白名单外没有 `src/**` 文件 import `node:fs`。
 *
 * 本文件用**验证方自己的注释剥离器**（状态机）独立复算，**不复用**
 * `tests/acceptance/office/w-disc-kernel-discipline.test.ts` 的扫描器。
 * 扫描器自带正/反两个对照，防"扫描器没生效"造成的假绿。
 */

import { describe, expect, it } from 'vitest';

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

const FORBIDDEN = [
  'node:fs',
  'node:child_process',
  'node:zlib',
  'Date.now(',
  'new Date(',
  'performance.now(',
  'Math.random(',
  'process.pid',
  'process.platform',
  'toLocaleString',
] as const;

/** 白名单：具名文件 + 具名 specifier（附四第 1 条的收窄）。 */
const IO_ALLOWLIST = new Map<string, readonly string[]>([
  ['src/storage/file-store.ts', ['node:fs', 'node:path']],
]);

/**
 * 验证方自造的**注释剥离器**（状态机，非 TS 解析器）。
 *
 * 处理：`//` 行注释、`/* … *\/` 块注释、`'…'` / `"…"` 字符串、`` `…` `` 模板串（含 `${}`）、
 * 以及正则字面量的**粗略**判别（`/` 前一个非空白字符属于运算符/开括号时视为正则起始）。
 * 剥离时把注释替换为**空格**（避免把相邻标识符拼成一个新 token）。
 */
function stripComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  const n = source.length;
  let prevMeaningful = '';
  const isRegexStart = (): boolean => prevMeaningful === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prevMeaningful);

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      out.push(' ');
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out.push(ch);
      i += 1;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') {
          out.push(source[i] ?? '');
          i += 1;
        }
        out.push(source[i] ?? '');
        i += 1;
      }
      out.push(quote);
      i += 1;
      prevMeaningful = quote;
      continue;
    }
    if (ch === '`') {
      out.push(ch);
      i += 1;
      let depth = 0;
      while (i < n) {
        const c = source[i];
        if (c === '\\') {
          out.push(source[i] ?? '', source[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (c === '$' && source[i + 1] === '{') {
          depth += 1;
          out.push('${');
          i += 2;
          continue;
        }
        if (c === '}' && depth > 0) {
          depth -= 1;
          out.push('}');
          i += 1;
          continue;
        }
        if (c === '`' && depth === 0) break;
        out.push(c ?? '');
        i += 1;
      }
      out.push('`');
      i += 1;
      prevMeaningful = '`';
      continue;
    }
    if (ch === '/' && isRegexStart()) {
      out.push('/');
      i += 1;
      while (i < n && source[i] !== '/' && source[i] !== '\n') {
        if (source[i] === '\\') {
          out.push(source[i] ?? '');
          i += 1;
        }
        out.push(source[i] ?? '');
        i += 1;
      }
      out.push('/');
      i += 1;
      prevMeaningful = '/';
      continue;
    }
    out.push(ch ?? '');
    if (ch !== undefined && !/\s/.test(ch)) prevMeaningful = ch;
    i += 1;
  }
  return out.join('');
}

function listSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.test.ts')) continue;
      out.push(absolute);
    }
  };
  walk(SRC_ROOT);
  return out.sort();
}

function repoPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join('/');
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly token: string;
}

function scanCode(): Violation[] {
  const violations: Violation[] = [];
  for (const absolute of listSourceFiles()) {
    const file = repoPath(absolute);
    const code = stripComments(readFileSync(absolute, 'utf8'));
    for (const token of FORBIDDEN) {
      let index = code.indexOf(token);
      while (index !== -1) {
        const allowed = IO_ALLOWLIST.get(file)?.includes(token) ?? false;
        if (!allowed) violations.push({ file, line: lineOf(code, index), token });
        index = code.indexOf(token, index + token.length);
      }
    }
  }
  return violations;
}

describe('V4-R50.4 · 内核纪律（验证方独立扫描器）', () => {
  it('对照（防假绿）：自造违例代码 ⇒ 每个禁用 token 都被命中', () => {
    const snippet = [
      "import { readFileSync } from 'node:fs';",
      "import { execSync } from 'node:child_process';",
      "import { deflateSync } from 'node:zlib';",
      'const a = Date.now();',
      'const b = new Date();',
      'const c = performance.now();',
      'const d = Math.random();',
      'const e = process.pid;',
      'const f = process.platform;',
      'const g = (1234).toLocaleString();',
    ].join('\n');
    const code = stripComments(snippet);
    const found = new Set(FORBIDDEN.filter((token) => code.includes(token)));
    for (const token of FORBIDDEN) {
      expect(found.has(token), `扫描器漏掉 ${token}`).toBe(true);
    }
  });

  it('对照（反向）：同样的内容放进注释 ⇒ 一个都不报', () => {
    const lines = ["import { readFileSync } from 'node:fs';", 'const a = Date.now();'];
    const commented = [...lines.map((line) => `// ${line}`), '/*', ...lines, '*/'].join('\n');
    const code = stripComments(commented);
    for (const token of FORBIDDEN) {
      expect(code.includes(token), `注释内容被误判为代码：${token}`).toBe(false);
    }
  });

  it('src/**（非测试）代码零禁用 token（白名单仅豁免 node:fs / node:path）', () => {
    const violations = scanCode();
    expect(violations, JSON.stringify(violations.slice(0, 20), null, 2)).toEqual([]);
  });

  it('4 处已登记的违约点已清零（逐点复算）', () => {
    const budgets = readFileSync(join(SRC_ROOT, 'scheduler/budgets.ts'), 'utf8');
    expect(stripComments(budgets).includes('node:fs')).toBe(false);

    for (const file of ['adapters/meituan/fact-publication.ts', 'spreadsheets/xls-io.ts']) {
      const code = stripComments(readFileSync(join(SRC_ROOT, file), 'utf8'));
      expect(code.includes('new Date('), `${file} 仍含 new Date(`).toBe(false);
      expect(code.includes('Date.now('), `${file} 仍含 Date.now(`).toBe(false);
    }
  });

  it('替代实现 src/protocol/timestamps.ts 自身不含任何禁用 token', () => {
    const code = stripComments(readFileSync(join(SRC_ROOT, 'protocol/timestamps.ts'), 'utf8'));
    for (const token of FORBIDDEN) {
      expect(code.includes(token), `timestamps.ts 含 ${token}`).toBe(false);
    }
  });

  it('除白名单外无 src/** 文件 import node:fs（粗粒度源码级）', () => {
    const offenders: string[] = [];
    for (const absolute of listSourceFiles()) {
      const file = repoPath(absolute);
      const code = stripComments(readFileSync(absolute, 'utf8'));
      if (code.includes('node:fs') && !IO_ALLOWLIST.has(file)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

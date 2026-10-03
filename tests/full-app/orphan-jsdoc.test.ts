/**
 * FA-FIX-ORPHAN-JSDOC · 孤儿 jsdoc 的机器化守卫（**只读文本，不依赖产品实现**）。
 *
 * ## 为什么要有这条守卫
 *
 * 本仓反复出现过同一个合并病灶：**冲突按"并集"手解**时，新声明连注释一起插进了某段 jsdoc
 * 与它本应描述的声明之间 —— 于是那段 jsdoc **悬空**（与声明分家），而后来的声明自带一段新
 * jsdoc。`tsc` 不报错（悬空的是注释）、单测也不报错（两段注释都不影响运行时），只有肉眼看
 * 才能发现。本守卫把"孤儿 jsdoc"钉成**可机判、可复算**的形态。
 *
 * 判据（与本包修复的两处一一对应）：
 *
 * 1. `orphan-jsdoc`：一段**完整**的 `/* ... *\/` 块注释之后，**紧接**（中间只允许空行）
 *    又开一段块注释 ⇒ 前一段 jsdoc 的声明没了 / 被插到后面去了。
 * 2. `orphan-jsdoc-continuation`：一行 ` * ...`（或 ` *\/`）的**上一非空行不是注释** ⇒
 *    块注释的开口行被吃掉了，续行成了"悬空续行"。
 *
 * 判定范围：`apps/demo/server/*.ts` 的**全部非测试文件**（与 FA-VERIFY-WAVE-14 T2 §2 同一普查面）。
 * 本包已把 `http.ts` / `main.ts` 的两处孤儿 jsdoc 归位，故此处**期望恰好 0 处**。
 *
 * ## 判别力（不恒真 / 不恒空）
 *
 * §0 用**合成反例**自证：人造一个孤儿 jsdoc 的 `.ts` 文本 ⇒ 判据必须报红；正常写法 ⇒ 必须不报。
 * 把任一判据改成"恒返回空数组"，§0 立刻变红。
 *
 * ## 如实记录的边界
 *
 * - 文本级扫描，不做完整 AST：块注释按"先 `/*` 后最近的 `*\/`"配对。字符串 / 模板 / 正则里
 *   若出现 `/*` 会被误配（本仓 `apps/demo/server/**` 现无此形态）。因此本守卫只作**申报**，
 *   最终仍以 tsc 与人工复核为准。
 * - 本判据是"块注释紧跟块注释"的**形态**判据，不区分"文件头 block + 首个声明的 jsdoc"
 *   （那也是一种合法但形态相同的排版）。`apps/demo/server/**` 现无该形态；若将来新增，
 *   需在此处显式加"文件头豁免"而不是默默放宽。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SERVER_DIR = join(process.cwd(), 'apps', 'demo', 'server');

// ===========================================================================
// 扫描器（纯函数，只读文本）
// ===========================================================================

interface Span {
  /** 0 基：`/*` 所在行。 */
  readonly openLine: number;
  /** 0 基：`*\/` 所在行。 */
  readonly closeLine: number;
}

/** 按"先 `/*` 后最近的 `*\/`"配对出所有块注释的起止行（0 基）。 */
function blockCommentSpans(source: string): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('/*', cursor);
    if (open === -1) break;
    const close = source.indexOf('*/', open + 2);
    if (close === -1) break;
    spans.push({ openLine: lineOf(source, open), closeLine: lineOf(source, close) });
    cursor = close + 2;
  }
  return spans;
}

/** 字符偏移 → 0 基行号。 */
function lineOf(source: string, index: number): number {
  let line = 0;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source.charAt(i) === '\n') line += 1;
  }
  return line;
}

interface OrphanFinding {
  readonly kind: 'orphan-jsdoc' | 'orphan-jsdoc-continuation';
  /** 1 基行号。 */
  readonly line: number;
}

/** jsdoc 续行 / 收尾行（行首是 `*`）。 */
const CONTINUATION = /^\s*\*/;
/** 某一行"属于块注释"的形态：`/*` 开口 或 `*` 续行。 */
const IS_COMMENT_LINE = (line: string): boolean => /^\s*\/\*/.test(line) || /^\s*\*/.test(line);

/**
 * 判据 1：一段完整块注释之后，紧接（中间只允许空行）又开一段块注释 ⇒ 前一段悬空。
 */
function findOrphanJsdoc(source: string): OrphanFinding[] {
  const lines = source.split('\n');
  const findings: OrphanFinding[] = [];
  for (const span of blockCommentSpans(source)) {
    let next = span.closeLine + 1;
    while (next < lines.length && (lines[next] ?? '').trim() === '') next += 1;
    if (/^\s*\/\*/.test(lines[next] ?? '')) {
      findings.push({ kind: 'orphan-jsdoc', line: span.openLine + 1 });
    }
  }
  return findings;
}

/**
 * 判据 2：` * ...` / ` *\/` 续行的上一**非空**行不是注释 ⇒ 块注释开口行被吃掉。
 */
function findOrphanContinuations(source: string): OrphanFinding[] {
  const lines = source.split('\n');
  const findings: OrphanFinding[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!CONTINUATION.test(lines[i] ?? '')) continue;
    let p = i - 1;
    while (p >= 0 && (lines[p] ?? '').trim() === '') p -= 1;
    if (!IS_COMMENT_LINE(p < 0 ? '' : (lines[p] ?? ''))) {
      findings.push({ kind: 'orphan-jsdoc-continuation', line: i + 1 });
    }
  }
  return findings;
}

function scanOrphans(source: string): OrphanFinding[] {
  return [...findOrphanJsdoc(source), ...findOrphanContinuations(source)];
}

function serverFile(name: string): string {
  return readFileSync(join(SERVER_DIR, name), 'utf8');
}

/** `apps/demo/server/**` 的非测试 `.ts` 文件（与 W14-T2 §2 同一普查面）。 */
function nonTestServerFiles(): string[] {
  return readdirSync(SERVER_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort();
}

// ===========================================================================
// 0. 判别力自证：合成反例（改成恒空 ⇒ 立即变红）
// ===========================================================================

describe('FA-FIX-ORPHAN-JSDOC §0 · 合成反例（守卫必须能报红）', () => {
  it('人造"两段块注释相邻"（jsdoc 与声明分家）⇒ 必须报 orphan-jsdoc', () => {
    const broken = [
      '/** 给 foo 的说明 */',
      '/**',
      ' * 给 bar 的说明',
      ' */',
      'export function bar() {}',
      '',
    ].join('\n');
    const found = scanOrphans(broken).filter((f) => f.kind === 'orphan-jsdoc');
    expect(found.length, `应恰好 1 处孤儿 jsdoc，实得：${JSON.stringify(found)}`).toBe(1);
    expect(found[0]?.line).toBe(1);
  });

  it('人造"孤儿 jsdoc 中间隔空行"⇒ 仍必须报（空行不算声明）', () => {
    const broken = ['/** 悬空的说明 */', '', '', '/** 真正的说明 */', 'export const x = 1;', ''].join('\n');
    const found = scanOrphans(broken).filter((f) => f.kind === 'orphan-jsdoc');
    expect(found.length).toBe(1);
    expect(found[0]?.line).toBe(1);
  });

  it('★反向：正常的「jsdoc 紧贴声明」⇒ 必须不报', () => {
    const ok = [
      '/** 说明 */',
      'export function foo() {}',
      '',
      '/**',
      ' * 多行说明',
      ' */',
      'export function bar() {}',
      '',
    ].join('\n');
    expect(scanOrphans(ok)).toEqual([]);
  });

  it('人造"注释开口被吃掉"（` * x` 上一行是代码）⇒ 必须报 orphan-jsdoc-continuation', () => {
    const broken = ['const a = 1;', ' * 悬空的续行', ' */', ''].join('\n');
    const found = scanOrphans(broken).filter((f) => f.kind === 'orphan-jsdoc-continuation');
    expect(found.length).toBe(1);
    expect(found[0]?.line).toBe(2);
  });

  it('★反向：完整的块注释续行 ⇒ 必须不报续行孤儿', () => {
    const ok = ['/**', ' * 说明', ' * 续行', ' */', 'export const x = 1;', ''].join('\n');
    expect(scanOrphans(ok).filter((f) => f.kind === 'orphan-jsdoc-continuation')).toEqual([]);
  });
});

// ===========================================================================
// 1. 实测：`apps/demo/server/**` 已无孤儿 jsdoc
// ===========================================================================

describe('FA-FIX-ORPHAN-JSDOC §1 · apps/demo/server 普查（应为 0）', () => {
  it('全部非测试 .ts：**无**孤儿 jsdoc、**无**孤儿续行', () => {
    const files = nonTestServerFiles();
    expect(files.length, '被普查的非测试文件数（应与 W14-T2 §2 的同一普查面一致）').toBeGreaterThanOrEqual(40);
    const hits: string[] = [];
    for (const file of files) {
      for (const finding of scanOrphans(readFileSync(join(SERVER_DIR, file), 'utf8'))) {
        hits.push(`${file}:${finding.line} [${finding.kind}]`);
      }
    }
    expect(hits, '孤儿 jsdoc / 孤儿续行（应为空）').toEqual([]);
  });

  it('http.ts：`读取请求体…` 的 jsdoc 紧贴在 `readBody()` 声明上方', () => {
    const lines = serverFile('http.ts').split('\n').map((l) => l.replace(/\r$/, ''));
    const doc = lines.indexOf('/** 读取请求体（带大小上限；超限直接拒绝，不静默截断）。 */');
    expect(doc, '应能找到该 jsdoc').toBeGreaterThanOrEqual(0);
    expect(lines[doc + 1] ?? '', 'jsdoc 的下一行必须是 readBody 声明').toMatch(
      /^async function readBody\(/,
    );
  });

  it('main.ts：`构造应用台账…` 的 jsdoc 紧贴在 `createJobIndex()` 声明上方', () => {
    const lines = serverFile('main.ts').split('\n').map((l) => l.replace(/\r$/, ''));
    const head = lines.findIndex(
      (l, i) => l === '/**' && (lines[i + 1] ?? '').includes('构造应用台账'),
    );
    expect(head, '应能找到该 jsdoc 块').toBeGreaterThanOrEqual(0);
    let close = head;
    while (close < lines.length && (lines[close] ?? '').trim() !== '*/') close += 1;
    expect(lines[close] ?? '', '块注释应在有限行内收尾').toBe(' */');
    expect(lines[close + 1] ?? '', 'jsdoc 的下一行必须是 createJobIndex 声明').toMatch(
      /^export function createJobIndex\(/,
    );
  });
});

/**
 * FA-VERIFY-WAVE-14 · 第 2 项 —— **`http.ts` / `main.ts` 结构完整性**（并集合并的残留）。
 *
 * ## 判据
 *
 * 本批反复出问题的地方是"冲突按**并集**手解"：新声明连注释一起插进了某段 jsdoc 与它的
 * 声明之间，或整块块体被吃掉只剩壳。`tsc` 不一定报错（吃到的是注释），单测也不一定报错
 * （被吃的分支可能本来没被覆盖）。本项用自带的 `structure-scan.ts` 把这些残留**钉成可机判**：
 *
 * - `decapitated-block`：`if (...) {` 与 `}` 之间**连注释都没有** ⇒ 必须为 0；
 * - `orphan-jsdoc`：一段完整块注释之后紧跟着又开一段块注释（中间无声明）⇒ **本 HEAD 实测 2 处**
 *   （`http.ts:235`、`main.ts:444`），如实**钉住**——它们不是本轮引入（见下方 blame 证据），
 *   但确实是"jsdoc 与声明分家"的并集残留；
 * - `orphan-jsdoc-continuation`：` * ...` 续行的上一非空行不是注释 ⇒ 必须为 0；
 * - 大括号平衡（抹掉注释/字符串/正则后净深度必须为 0）。
 *
 * 同时扫**全部** `apps/demo/server/*.ts`（41 个非测试文件），确认残留**只**在这两处。
 *
 * 【判别力】每个判据都配合成反例（下面 §0）——把扫描器改成恒空/恒真，§0 立刻变红。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  formatStructuralFindings,
  maskCommentsAndStrings,
  scanStructure,
  type StructuralFinding,
} from './structure-scan.js';

const REPO = process.cwd();
const SERVER_DIR = join(REPO, 'apps', 'demo', 'server');

function readServer(file: string): string {
  return readFileSync(join(SERVER_DIR, file), 'utf8');
}

function findingsOf(source: string, kind: StructuralFinding['kind']): StructuralFinding[] {
  return scanStructure(source).filter((f) => f.kind === kind);
}

/**
 * 把每条发现映射到它的**内容锚**（内容锚定，避免行号漂移导致的假红）。
 *
 * 取发现行起、往后 4 行拼接：`orphan-jsdoc` 报的是**块注释的开口行**（多行 jsdoc 时该行只是
 * `/**`），所以必须把紧随其后的几行一起看，才能锚定到注释正文。
 */
function anchorOf(source: string, findings: readonly StructuralFinding[]): string[] {
  const lines = source.split('\n');
  return findings.map((f) =>
    lines
      .slice(f.line - 1, f.line + 3)
      .map((line) => line.trim())
      .join('\n'),
  );
}

// ===========================================================================
// 0. 扫描器自身：合成反例（保证判据有判别力，不恒真）
// ===========================================================================

describe('W14-T2 §0 · 扫描器判别力（合成反例）', () => {
  it('合成空壳块（`if (x) {` 后直接 `}`）⇒ 必须报 decapitated-block', () => {
    const broken = ['function f() {', '  if (flag) {', '  }', '  return 1;', '}', ''].join('\n');
    const found = findingsOf(broken, 'decapitated-block');
    expect(found.length, formatStructuralFindings(scanStructure(broken))).toBe(1);
    expect(found[0]?.line).toBe(2);
  });

  it('★反向：只含注释的 `} catch { // 说明 }` **不**报（合法写法，不误伤）', () => {
    const ok = ['try {', '  f();', '} catch {', '  // 对端提前关闭：吞掉即可', '}', ''].join('\n');
    expect(findingsOf(ok, 'decapitated-block')).toEqual([]);
  });

  it('合成"jsdoc 与声明分家"（两段块注释相邻）⇒ 必须报 orphan-jsdoc', () => {
    const broken = ['/** 给 foo 的说明 */', '/**', ' * 给 bar 的说明', ' */', 'export function bar() {}', ''].join('\n');
    const found = findingsOf(broken, 'orphan-jsdoc');
    expect(found.length).toBe(1);
    expect(found[0]?.line).toBe(1);
  });

  it('★反向：正常的 `/** doc */\\n export function foo()` **不**报', () => {
    const ok = ['/** 说明 */', 'export function foo() {}', '', '/**', ' * 多行说明', ' */', 'export function bar() {}', ''].join('\n');
    expect(findingsOf(ok, 'orphan-jsdoc')).toEqual([]);
  });

  it('合成"注释开口被吃掉"（` * x` 悬空）⇒ 必须报 orphan-jsdoc-continuation', () => {
    const broken = ['const a = 1;', ' * 悬空的续行', ' */', ''].join('\n');
    const found = findingsOf(broken, 'orphan-jsdoc-continuation');
    expect(found.length).toBe(1);
    expect(found[0]?.line).toBe(2);
  });

  it('★反向：正则字面量里的引号不得把遮罩状态机带偏（`/"/g` 吞掉后面几十行）', () => {
    const source = [
      "const a = x.replace(/[^\\x20-\\x7e]/g, '_').replace(/\"/g, '_');",
      'const b = { k: 1 };',
      'if (b) {',
      '  return b;',
      '}',
      '',
    ].join('\n');
    // `{` / `}` 净深度必须为 0（若遮罩被 `"` 带偏，后面的代码会被误当字符串 ⇒ 深度非 0）。
    const masked = maskCommentsAndStrings(source);
    const depth = (masked.match(/\{/g) ?? []).length - (masked.match(/\}/g) ?? []).length;
    expect(depth).toBe(0);
    expect(scanStructure(source)).toEqual([]);
  });
});

// ===========================================================================
// 1. 目标文件：结构残留如实钉住
// ===========================================================================

describe('W14-T2 §1 · http.ts / main.ts 实测结构残留', () => {
  it('http.ts：**无**空壳块、**无**孤儿续行、大括号平衡', () => {
    const source = readServer('http.ts');
    expect(findingsOf(source, 'decapitated-block'), '空壳块（并集吃掉整段块体）').toEqual([]);
    expect(findingsOf(source, 'orphan-jsdoc-continuation')).toEqual([]);
    const depth =
      (maskCommentsAndStrings(source).match(/\{/g) ?? []).length -
      (maskCommentsAndStrings(source).match(/\}/g) ?? []).length;
    expect(depth, '大括号净深度').toBe(0);
  });

  it('main.ts：**无**空壳块、**无**孤儿续行、大括号平衡', () => {
    const source = readServer('main.ts');
    expect(findingsOf(source, 'decapitated-block')).toEqual([]);
    expect(findingsOf(source, 'orphan-jsdoc-continuation')).toEqual([]);
    const masked = maskCommentsAndStrings(source);
    const depth = (masked.match(/\{/g) ?? []).length - (masked.match(/\}/g) ?? []).length;
    expect(depth, '大括号净深度').toBe(0);
  });

  it('★headline：两个文件各有 **1** 处"jsdoc 与声明分家"（按**内容**锚定，不钉行号）', () => {
    // 用内容而非行号锚定：本批 main 在持续前进（合并会让行号漂移），钉行号会随无关改动变红。
    const anchored = anchorOf(readServer('http.ts'), findingsOf(readServer('http.ts'), 'orphan-jsdoc'));
    expect(anchored.length, formatStructuralFindings(findingsOf(readServer('http.ts'), 'orphan-jsdoc'))).toBe(1);
    expect(anchored[0], 'http.ts 悬空的那段 jsdoc 应是「读取请求体（带大小上限…）」').toContain('读取请求体（带大小上限');

    const mainFindings = findingsOf(readServer('main.ts'), 'orphan-jsdoc');
    const mainAnchored = anchorOf(readServer('main.ts'), mainFindings);
    expect(mainAnchored.length, formatStructuralFindings(mainFindings)).toBe(1);
    expect(mainAnchored[0], 'main.ts 悬空的那段 jsdoc 应是「构造应用台账…」').toContain('构造应用台账');
  });

  it('两处残留**不是本轮引入**：seed 基线提交 `3c44540f` 里就已存在（本批之前的既有工作树）', () => {
    // 直接读基线提交里的文件内容 —— 比 blame 稳（行号漂移 / 无关重写都不会影响本判据）。
    const atBaseline = (path: string): string =>
      execFileSync('git', ['show', `3c44540f:${path}`], { cwd: REPO, encoding: 'utf8' });
    expect(atBaseline('apps/demo/server/http.ts')).toContain('读取请求体（带大小上限');
    expect(atBaseline('apps/demo/server/main.ts')).toContain('构造应用台账');
    // 反向对照：基线里**没有**本验证轮次的目录（证明 3c44540f 确实早于本工作包）。
    expect(() => atBaseline('tests/full-app/verify-wave-14/T2-structure-integrity.test.ts')).toThrow();
  });
});

// ===========================================================================
// 2. 全量普查：残留只在这两处
// ===========================================================================

describe('W14-T2 §2 · apps/demo/server 全量普查（41 个非测试文件）', () => {
  const files = readdirSync(SERVER_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  it('全量无空壳块、无孤儿续行；孤儿 jsdoc 恰好 2 处（http.ts + main.ts 各一，按内容锚定）', () => {
    expect(files.length, '被普查的非测试文件数').toBeGreaterThanOrEqual(40);
    const all: { file: string; finding: StructuralFinding; source: string }[] = [];
    for (const file of files) {
      const source = readFileSync(join(SERVER_DIR, file), 'utf8');
      for (const finding of scanStructure(source)) {
        all.push({ file, finding, source });
      }
    }
    const locate = (xs: typeof all): string[] =>
      xs.map((x) => `${x.file}: ${(x.source.split('\n')[x.finding.line - 1] ?? '').trim()}`);
    expect(locate(all.filter((x) => x.finding.kind === 'decapitated-block')), '全量空壳块（应为 0）').toEqual([]);
    expect(
      locate(all.filter((x) => x.finding.kind === 'orphan-jsdoc-continuation')),
      '全量孤儿续行（应为 0）',
    ).toEqual([]);
    const orphans = all.filter((x) => x.finding.kind === 'orphan-jsdoc');
    expect(orphans.map((x) => x.file).sort(), '全量孤儿 jsdoc（应恰好这两个文件各一处）').toEqual([
      'http.ts',
      'main.ts',
    ]);
  });
});

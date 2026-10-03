/**
 * FA-VERIFY-WAVE-13 · 第 4 项 —— **恒真 / 空断言猎捕**。
 *
 * ## 猎的是什么
 *
 * 1. **空断言**：一个 `it()` 块里**一个 `expect(` 都没有** —— 跑得绿，什么都没证明。
 * 2. **硬恒真**：`expect(true).toBe(true)` / `expect(false).toBe(false)` /
 *    `expect(X).toBe(X)`（两侧同文）/ `toBeGreaterThanOrEqual(0)` / `toBeGreaterThan(-1)`
 *    —— 不论实现怎样都绿。
 * 3. **弱断言台账**：`toBeDefined()` / `toBeTruthy()` / `toBeUndefined()` 这类**本身可能是弱**的形态，
 *    逐个列出来人工看它有没有前置的强判据（本文件只做**清点**，不自动判红——自动判红会误伤
 *    "先 `find()` 再 `.toBeDefined()`"这种正当写法）。
 *
 * ## 扫描范围
 *
 * - **被测方**：本批新增端点模块自己的测试（`apps/demo/server/{facts-routes,trace-fact-versions,
 *   krn-orphans,krn-barrel,session-adapters-wiring,route-wiring}.test.ts`）。
 * - **验证方**（我自己）：本目录 `tests/full-app/verify-wave-13` 下的全部 `.test.ts`
 *   —— 验证者的测试**同样**受这两条约束（否则"猎捕"是双标的）。
 *
 * ## 咬合力（不在此文件里跑）
 *
 * 变异测试见同目录 `bite.sh`（≥8 条：把实现改坏 ⇒ 对应测试必须变红，改回 ⇒ 恢复绿）。
 * 本文件是**静态度量**，与 `bite.sh` 的**动态**变异互为补充。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SERVER_DIR = join(process.cwd(), 'apps', 'demo', 'server');
const SELF_DIR = join(process.cwd(), 'tests', 'full-app', 'verify-wave-13');

/** 被测方：本批新增产品的测试文件。 */
const UNDER_TEST = [
  'facts-routes.test.ts',
  'trace-fact-versions.test.ts',
  'krn-orphans.test.ts',
  'krn-barrel.test.ts',
  'session-adapters-wiring.test.ts',
  'route-wiring.test.ts',
].map((name) => join(SERVER_DIR, name));

/** 验证方：本目录自己的测试文件。 */
const SELF = ['T1-endpoint-tristate.test.ts', 'T2-product-mismatch.test.ts', 'T3-merge-ancestry.test.ts', 'T4-vacuous-hunt.test.ts'].map(
  (name) => join(SELF_DIR, name),
);

interface ScanResult {
  readonly file: string;
  /** `it(` / `test(` 块总数（近似：按行首缩进切）。 */
  readonly blocks: number;
  /** 一个 `expect(` 都没有的块数。 */
  readonly emptyBlocks: number;
  /** 硬恒真命中行。 */
  readonly tautologies: readonly string[];
  /** 弱断言行（清点，不判红）。 */
  readonly weak: readonly string[];
}

const HARD_TAUTOLOGY: readonly RegExp[] = [
  /expect\(\s*true\s*\)\s*\.toBe\(\s*true\s*\)/,
  /expect\(\s*false\s*\)\s*\.toBe\(\s*false\s*\)/,
  /expect\(\s*(\d+)\s*\)\s*\.toBe\(\s*\1\s*\)/,
  /toBeGreaterThanOrEqual\(\s*0\s*\)/,
  /toBeGreaterThan\(\s*-1\s*\)/,
];

const WEAK: readonly RegExp[] = [/\.toBeDefined\(\)/, /\.toBeTruthy\(\)/, /\.toBeUndefined\(\)/];

/** 两侧同文的 `expect(X).toBe(X)`（用剥掉空白后的字面比较）。 */
function selfComparison(line: string): boolean {
  const match = /expect\((.+?)\)\s*\.toBe\((.+?)\)/.exec(line);
  if (match === null) return false;
  const left = (match[1] ?? '').trim();
  const right = (match[2] ?? '').replace(/,\s*['"`].*$/, '').trim();
  return left.length > 0 && left === right;
}

function scan(file: string): ScanResult {
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  // 近似切块：行首空白 + `it(` 或 `test(`（`describe(` 不算）。
  const blocks = text.split(/\n\s+(?:it|test)\(/).slice(1);
  let emptyBlocks = 0;
  for (const block of blocks) {
    const body = block.split(/\n\s+(?:it|test)\(/)[0] ?? '';
    if (!/expect\(/.test(body)) emptyBlocks += 1;
  }
  const tautologies: string[] = [];
  const weak: string[] = [];
  lines.forEach((line, index) => {
    // **跳过注释行**：注释里写"反例形态"是文档，不是断言（否则本扫描器会自伤）。
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
    for (const re of HARD_TAUTOLOGY) if (re.test(line)) tautologies.push(`${String(index + 1)}: ${line.trim()}`);
    if (selfComparison(line)) tautologies.push(`${String(index + 1)}: ${line.trim()}`);
    for (const re of WEAK) if (re.test(line)) weak.push(`${String(index + 1)}: ${line.trim()}`);
  });
  return { file, blocks: blocks.length, emptyBlocks, tautologies, weak };
}

const UNDER_TEST_SCANS = UNDER_TEST.map(scan);
const SELF_SCANS = SELF.map(scan);

describe('W13-T4 · 被测方（本批新增端点的测试）无空断言 / 无硬恒真', () => {
  it('每个 it 块至少一个 expect（空断言数 = 0）', () => {
    const offenders = UNDER_TEST_SCANS.filter((row) => row.emptyBlocks > 0).map(
      (row) => `${row.file}: ${String(row.emptyBlocks)} 个空块`,
    );
    expect(offenders, offenders.join('\n')).toEqual([]);
    // 保底：扫描器确实读到了用例（否则"0 个空块"可能只是因为一个块都没扫到）。
    expect(UNDER_TEST_SCANS.reduce((sum, row) => sum + row.blocks, 0)).toBeGreaterThan(50);
  });

  it('无硬恒真断言（true/false 字面 / 自比较 / >=0 / >-1）', () => {
    const offenders = UNDER_TEST_SCANS.flatMap((row) => row.tautologies);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('弱断言清点（只登记，供人工核对是否有前置强判据）', () => {
    const weak = UNDER_TEST_SCANS.flatMap((row) => row.weak.map((line) => `${row.file} ${line}`));
    // 本批实测为 4 条 —— 若数量暴涨，说明新写法引入了大量弱断言，应人工复核。
    expect(weak.length, `弱断言清单：\n${weak.join('\n')}`).toBeLessThanOrEqual(6);
  });
});

describe('W13-T4 · 验证方（本目录）自扫 —— 同一把尺子', () => {
  it('本目录测试同样无空块 / 无硬恒真（不双标）', () => {
    expect(SELF_SCANS.filter((row) => row.emptyBlocks > 0).map((row) => row.file)).toEqual([]);
    expect(SELF_SCANS.flatMap((row) => row.tautologies)).toEqual([]);
    expect(SELF_SCANS.reduce((sum, row) => sum + row.blocks, 0)).toBeGreaterThan(20);
  });
});

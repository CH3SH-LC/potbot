/**
 * FA-VERIFY-WAVE-8 · T2 —— **被吞代码猎捕**（本轮第三疑点）。
 *
 * 扫本批合并涉及的四个文件，用**独立自研**的结构扫描找：
 * - 孤立的注释块（注释本要标注的语句被吞掉留下的悬空 JSDoc）；
 * - 结构上多余的 `}` / 被截断的 `if`（语法诊断 + 独立分隔符配平双保险）；
 * - **派发 if 缺 return**——即 `ec22773` 修的那一次事故形态（语法合法、只有运行时才暴露）。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  delimiterBalanceOf,
  dispatchIfWithoutReturnOf,
  emptyThenBlocksOf,
  orphanCommentsOf,
  parseDiagnosticsOf,
} from './source-scan.js';

const REPO = join(import.meta.dirname, '..', '..', '..');
const MERGE_TOUCHED = [
  'apps/demo/server/http.ts',
  'apps/demo/server/main.ts',
  'apps/demo/server/route-wiring.ts',
  'apps/demo/server/documents-routes.ts',
];

const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

describe('T2 · 被吞代码猎捕', () => {
  it('四个文件都没有 TS 语法诊断（多余 `}` / 被截断的 if 会在这里现形）', () => {
    const bad: Record<string, readonly string[]> = {};
    for (const rel of MERGE_TOUCHED) {
      const diag = parseDiagnosticsOf(rel, read(rel));
      if (diag.length > 0) bad[rel] = diag;
    }
    expect(bad).toEqual({});
  });

  it('四个文件的分隔符都独立配平（不依赖 tsc）', () => {
    const bad: Record<string, unknown> = {};
    for (const rel of MERGE_TOUCHED) {
      const report = delimiterBalanceOf(read(rel));
      if (report.braceDelta !== 0 || report.parenDelta !== 0 || report.bracketDelta !== 0 || report.dipped) {
        bad[rel] = report;
      }
    }
    expect(bad).toEqual({});
  });

  it('四个文件都没有悬空的注释块（孤立 JSDoc = 被吞语句的墓碑）', () => {
    const bad: Record<string, unknown> = {};
    for (const rel of MERGE_TOUCHED) {
      const orphans = orphanCommentsOf(rel, read(rel));
      if (orphans.length > 0) bad[rel] = orphans;
    }
    expect(bad).toEqual({});
  });

  it('四个文件都没有空 `if {}` 主体', () => {
    const bad: Record<string, readonly number[]> = {};
    for (const rel of MERGE_TOUCHED) {
      const empty = emptyThenBlocksOf(rel, read(rel));
      if (empty.length > 0) bad[rel] = empty;
    }
    expect(bad).toEqual({});
  });

  it('http.ts 里没有"引用了派发标识符却没有 return"的 if（ec22773 事故形态）', () => {
    const text = read('apps/demo/server/http.ts');
    const offenders = dispatchIfWithoutReturnOf(
      'apps/demo/server/http.ts',
      text,
      /(handle[A-Z]\w*\s*\(|\.handle\s*\()/,
    );
    expect(offenders).toEqual([]);
  });

  it('探测器本身有牙：对已知事故形态的合成样本必须报警', () => {
    // 合成一段"并集吞掉外层 if 的 return/`}`"的代码，确认探测器会红（防"空断言"）。
    const synthetic = `async function f(handleA: () => Promise<boolean>) {
  if (await handleA()) {
  if (await handleA()) {
    return;
  }
}
`;
    const offenders = dispatchIfWithoutReturnOf('synthetic.ts', synthetic, /handle[A-Z]\w*\s*\(/);
    expect(offenders.length).toBeGreaterThan(0);

    const orphanSynthetic = read('apps/demo/server/http.ts'); // 真实文件应为 0（上一条已断言）
    void orphanSynthetic;
  });
});

/**
 * FA-VERIFY-WAVE-9 · 任务第 3 项（后半）—— 对**本批新增/在用的测试文件**扫恒真断言。
 *
 * 扫描器 `vacuous-scan.ts` 先过**合成源码正/负对照**（植入恒真必报、健全断言不误报），
 * 再扫 `apps/demo/server/*.test.ts` 与 `tests/full-app/**`，每条命中给 `file:line`。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { nonTestFiles, testFilesOf } from './source-probe.js';
import { scanSource, type VacuousHit } from './vacuous-scan.js';

const ROOT = process.cwd();

// 本批工作新产生/在用的测试文件集
function batchTestFiles(root: string): string[] {
  const out: string[] = [];
  for (const f of testFilesOf(root)) {
    if (f.startsWith('tests/full-app/')) out.push(f);
    else if (f.startsWith('apps/demo/server/')) out.push(f);
  }
  return out.sort();
}

describe('W9-T5 · 扫描器自证（合成正/负对照）', () => {
  it('植入恒真（same-expr / literal / null-proxy）⇒ 必各有命中', () => {
    const synth = `
      it('a', () => { const x = f(); expect(x).toEqual(x); });
      it('b', () => { expect(true).toBe(true); });
      it('c', () => { const chunk: T | null = null; expect(chunk).toBeNull(); });
    `;
    const hits = scanSource(synth, 'synth.ts');
    const kinds = new Set(hits.map((h) => h.kind));
    expect(kinds.has('tautology-same-expr')).toBe(true);
    expect(kinds.has('tautology-literal')).toBe(true);
    expect(kinds.has('null-proxy')).toBe(true);
  });

  it('健全断言（运行期变量、期望表、不等值）⇒ **不误报**', () => {
    const synth = `
      it('ok', () => { expect(result.ready).toBe(true); });
      it('ok2', () => { const seen = classify(input); expect(seen).toBe('committed'); });
      it('ok3', () => { expect(status).toBeGreaterThanOrEqual(400); });
      it('ok4', () => { const x = compute(); expect(x).not.toBe(other()); });
    `;
    expect(scanSource(synth, 'synth2.ts')).toEqual([]);
  });
});

describe('W9-T5 · 本批测试文件的恒真命中（file:line）', () => {
  it('扫描并打印全部命中；命中数须如实登记（可为 0）', () => {
    const files = batchTestFiles(ROOT);
    // 防空集假绿：
    expect(files.length).toBeGreaterThan(30);
    const all: { file: string; hit: VacuousHit }[] = [];
    for (const f of files) {
      const text = readFileSync(join(ROOT, f), 'utf8');
      for (const hit of scanSource(text, f)) all.push({ file: f, hit });
    }
    // eslint-disable-next-line no-console
    console.log(
      `[W9 VACUOUS] scanned ${String(files.length)} files; hits=${String(all.length)}\n` +
        all.map((h) => `${h.file}:${String(h.hit.line)}  ${h.hit.kind}  ${h.hit.snippet.slice(0, 100)}`).join('\n'),
    );
    // 已知的持续存在项（上一轮 Q-1 / Q-4 的形态）：至少 research-routes.test.ts 的 null-proxy 应被识别。
    const kinds = new Set(all.map((h) => h.hit.kind));
    expect(kinds.size).toBeGreaterThan(0);
  });

  it('非测试源码不应被当作"测试文件"扫描（扫描面自证）', () => {
    const nonTest = nonTestFiles(ROOT);
    expect(nonTest).toContain('apps/demo/server/http.ts');
    expect(batchTestFiles(ROOT)).not.toContain('apps/demo/server/http.ts');
  });
});

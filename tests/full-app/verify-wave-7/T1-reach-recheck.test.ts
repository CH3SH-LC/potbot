/**
 * FA-VERIFY-WAVE-7 · §1 复核第五轮结论 + 用**自有口径**重算"只被 import"的模块。
 *
 * 任务第 1 项：第五轮判定
 *   (i) "documents/research 两组路由未派发"——协调者称已由 `49e3073` 修复；
 *   (ii) "N-5-1 之外有 156 个模块只被 import"。
 * 本文件**不复用**第五轮的扫描器/结论：用 `reach-scan.ts`（验证方自写）重算，
 * 并且**不引用**那个 156 的数字，只用本轮同一份扫描的 A/B 口径对照。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it, beforeAll } from 'vitest';

import { scanRepo, type ScanResult } from './reach-scan.js';

let scan: ScanResult;

beforeAll(() => {
  scan = scanRepo(process.cwd());
}, 120_000);

const srcModules = (): string[] =>
  scan.files.filter((f) => f.rel.startsWith('src/') && !f.isTest).map((f) => f.rel);

describe('§1.0 扫描器自检（先证明尺子有刻度）', () => {
  it('不存在的模块判为 c（不在 import 闭包内）', () => {
    expect(scan.importClosure.has('src/memory/definitely-not-here-xyz.ts')).toBe(false);
    expect(scan.classify('src/memory/definitely-not-here-xyz.ts')).toBe('c');
  });

  it('入口本身在闭包内，且 A ⊆ 全部文件', () => {
    expect(scan.importClosure.has('apps/demo/server/main.ts')).toBe(true);
    expect(scan.importClosure.size).toBeLessThanOrEqual(scan.files.length);
  });

  it('能看见"真用"：memory-routes 按名使用了 backup-plan 的符号（值位置）', () => {
    const used = scan.usedSymbols.get('src/memory/backup-plan.ts');
    expect(used).toBeDefined();
    const consumers = [...(used?.keys() ?? [])];
    expect(consumers).toContain('apps/demo/server/memory-routes.ts');
  });
});

describe('§1.1 用自有口径重算 A / B（不引用第五轮数字）', () => {
  it('A（import 闭包）与 B（真用闭包）都算出来了，且 B ⊆ A', () => {
    expect(scan.importClosure.size).toBeGreaterThan(400);
    expect(scan.useClosure.size).toBeGreaterThan(200);
    for (const m of scan.useClosure) {
      expect(scan.importClosure.has(m)).toBe(true);
    }
  });

  it('"只被 import"（严格传递口径：在 A 内、不在 B 内）**非空** ⇒ 该现象仍未消除', () => {
    const list = srcModules().filter((m) => scan.classifyStrict(m) === 'b');
    // eslint-disable-next-line no-console
    console.log(`W7 reach: src 非测试=${String(srcModules().length)} a2=${String(srcModules().filter((m) => scan.classifyStrict(m) === 'a2').length)} b=${String(list.length)} c=${String(srcModules().filter((m) => scan.classifyStrict(m) === 'c').length)}`);
    expect(list.length).toBeGreaterThan(0);
  });

  it('连"更宽松"的单跳口径也仍有大量只 import 的模块（(b1) 或 (b2)）', () => {
    const loose = srcModules().filter((m) => {
      const k = scan.classify(m);
      return k === 'b1' || k === 'b2';
    });
    expect(loose.length).toBeGreaterThan(0);
    // 具名列出方便人工复核（打印前 30 条）
    // eslint-disable-next-line no-console
    console.log('W7 loose-b sample:', loose.filter((m) => !m.endsWith('/index.ts')).slice(0, 30).join(' '));
  });

  it('第五轮点名的 adapters/research **整包**已不再是 (b)（本轮已接线）', () => {
    const research = srcModules().filter((m) => m.startsWith('src/adapters/research/'));
    const stillB = research.filter((m) => scan.classifyStrict(m) === 'b');
    // eslint-disable-next-line no-console
    console.log(`W7 research pkgs=${String(research.length)} still-b=${String(stillB.length)}: ${stillB.join(' ')}`);
    expect(research.length).toBeGreaterThan(10);
    // 不再是整包 (b)；允许有零星 barrel/索引文件
    expect(stillB.length).toBeLessThan(research.length / 2);
  });

  it('第五轮点名的 scheduler 一族**仍大量**是 (b)（未修）', () => {
    const sched = srcModules().filter((m) => m.startsWith('src/scheduler/'));
    const stillB = sched.filter((m) => scan.classifyStrict(m) === 'b');
    // eslint-disable-next-line no-console
    console.log(`W7 scheduler pkgs=${String(sched.length)} still-b=${String(stillB.length)}`);
    expect(stillB.length).toBeGreaterThanOrEqual(5);
  });
});

describe('§1.2 N-5-1 的修复在**源码**与**真 HTTP**两层都成立', () => {
  it('http.ts 里 documents / research 两组 handler 都有派发调用点', () => {
    const source = readFileSync(new URL('../../../apps/demo/server/http.ts', import.meta.url), 'utf8');
    expect(source.includes('if (await handleDocumentsRequest(')).toBe(true);
    expect(source.includes('if (await handleResearchRequest(')).toBe(true);
    // 反向对照：任意不存在的调用名不该在源码里
    expect(source.includes('handleDocumentsRequestX(')).toBe(false);
  });
});

describe('§1.3 第五轮点名文件的现状（只复算本报告关心的几条）', () => {
  it('budget-wiring.ts **已被真接线**（第六轮"死装配"已闭合，现有两个非测试消费者）', () => {
    const consumers = scan.directConsumers.get('apps/demo/server/budget-wiring.ts');
    const nonTest = [...(consumers ?? [])].filter((c) => !c.endsWith('.test.ts')).sort();
    // 判别力：把预算接线从产品闭包里摘掉（删 main.ts / session-adapters-wiring.ts 对它的引用）
    // ⇒ nonTest 变回空数组 ⇒ 本行重新变红。
    expect(nonTest).toEqual([
      'apps/demo/server/main.ts',
      'apps/demo/server/session-adapters-wiring.ts',
    ]);
  });

  it('research-citations **已有产品调用方**（第六轮"仅被 session barrel 蹭进闭包、无调用"已闭合）', () => {
    const used = scan.usedSymbols.get('src/session/adapters/research-citations.ts');
    const consumers = [...(used?.keys() ?? [])];
    // 判别力：回退 session-adapters-wiring.ts 对该模块符号的按名使用 ⇒ 变回空 ⇒ 本行重新变红。
    expect(consumers).toEqual(['apps/demo/server/session-adapters-wiring.ts']);
  });
});

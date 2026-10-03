/**
 * FA-VERIFY-WAVE-5 · §3 恒真 / 空断言猎捕（本轮新测试）。
 *
 * 扫描器 `vacuous-scan.ts` 是验证方自写的 **TS AST** 实现；本文件先用**合成源码**
 * 做正/负对照（证明它能变红、也不会乱咬），再扫本轮新增的测试文件。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { scanTestFile, scanTestText } from './vacuous-scan.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** 本轮新合入 / 被改动的**实现侧**测试文件（验证方不搬实现者的用例，只扫文件文本）。 */
const WAVE_TEST_FILES = [
  'apps/demo/server/documents-routes.test.ts',
  'apps/demo/server/research-routes.test.ts',
  'apps/demo/server/conversation-store.test.ts',
  'apps/demo/server/e2e-routes.test.ts',
  'apps/demo/server/memory-routes.test.ts',
  'src/conversation/adapter-to-store.test.ts',
  'src/session/adapters/cal-clock.test.ts',
  'src/scheduler/checkpoint.test.ts',
  'src/plugins/catalog.test.ts',
  'src/adapters/calendar/reconcile.test.ts',
] as const;

describe('§3.1 扫描器自检（正对照：每条规则都能被合成源码触发）', () => {
  it('not-throw-only：只有一个 .not.toThrow() 的用例被抓出', () => {
    const src = `it('x', () => { expect(() => f()).not.toThrow(); });`;
    expect(scanTestText('synthetic.ts', src).map((f) => f.rule)).toContain('not-throw-only');
  });

  it('tautology-same-expr：expect(A).toBe(A) 被抓出', () => {
    const src = `it('x', () => { expect(f(1)).toBe(f(1)); });`;
    expect(scanTestText('synthetic.ts', src).map((f) => f.rule)).toContain('tautology-same-expr');
  });

  it('tautology-literal：expect(true).toBe(true) 被抓出', () => {
    const src = `it('x', () => { expect(true).toBe(true); });`;
    expect(scanTestText('synthetic.ts', src).map((f) => f.rule)).toContain('tautology-same-expr');
  });

  it('weak-only：唯一断言是 toBeDefined 被抓出', () => {
    const src = `it('x', () => { expect(obj.field()).toBeDefined(); });`;
    expect(scanTestText('synthetic.ts', src).map((f) => f.rule)).toContain('weak-only');
  });

  it('trivial-bound：toBeGreaterThanOrEqual(0) 被抓出', () => {
    const src = `it('x', () => { expect(list.length).toBeGreaterThanOrEqual(0); });`;
    expect(scanTestText('synthetic.ts', src).map((f) => f.rule)).toContain('trivial-bound');
  });
});

describe('§3.2 扫描器自检（负对照：有判别力的写法**不得**被误报）', () => {
  const clean = [
    `it('a', () => { expect(() => f()).toThrow(); });`,
    `it('b', () => { expect(list.length).toBeGreaterThan(0); });`,
    `it('c', () => { const v = g(); expect(v.ready).toBe(true); expect(v.list).toEqual([1, 2]); });`,
    `it('d', () => { expect(() => f()).not.toThrow(); expect(g()).toBe(3); });`,
    `it('e', () => { expect(x).toBeDefined(); expect(x.ok).toBe(false); });`,
  ].join('\n');
  const findings = scanTestText('synthetic-clean.ts', clean);

  it('有判别力的写法：0 命中', () => {
    expect(findings).toEqual([]);
  });
});

describe('§3.3 本轮实现侧测试的扫描结果', () => {
  const all = WAVE_TEST_FILES.flatMap((f) => scanTestFile(f, join(ROOT, f)));

  it('`not-throw-only`（整个用例只有 .not.toThrow()）：0 处', () => {
    expect(all.filter((f) => f.rule === 'not-throw-only')).toEqual([]);
  });

  it('`weak-only`（唯一断言是 toBeDefined/toBeTruthy…）：0 处', () => {
    expect(all.filter((f) => f.rule === 'weak-only')).toEqual([]);
  });

  it('`trivial-bound`（恒真上下界）：0 处', () => {
    expect(all.filter((f) => f.rule === 'trivial-bound')).toEqual([]);
  });

  it('`tautology-same-expr`：**0 处**（第六轮 src/scheduler/checkpoint.test.ts:207 的 `expect(f(x)).toBe(f(x))` 已消除）', () => {
    const taut = all.filter((f) => f.rule === 'tautology-same-expr');
    // 判别力：把 `expect(classifyActionState(shared)).toBe(classifyActionState(shared))` 写回
    // src/scheduler/checkpoint.test.ts ⇒ 本行重新变红（§3.1 的正对照已证明该规则会咬）。
    expect(taut).toEqual([]);
  });
});

describe('§3.4 "断言由被测对象自身产生"：本轮的真实发现（实现侧测试）', () => {
  const routesTest = readFileSync(join(ROOT, 'apps/demo/server/documents-routes.test.ts'), 'utf8');

  it('① `expect(body.coverage).toEqual(DOCUMENTS_ROUTE_MODULE_COVERAGE)`——两侧都来自被测模块', () => {
    expect(routesTest).toContain('expect(body[\'coverage\']).toEqual(DOCUMENTS_ROUTE_MODULE_COVERAGE);');
    // 这条断言**不可能**因为"清单不真实"而变红：它比的是被测模块响应里的字段
    // 与被测模块导出的同一个常量。判据不独立于被测对象。
  });

  it('② "可达性自证" 循环遍历的是**同一个文件自己声明的**常量（自证循环）', () => {
    expect(routesTest).toContain('for (const entry of DOCUMENTS_ROUTE_MODULE_COVERAGE) {');
    // 该循环只断言"清单里的模块被 documents-routes.ts 的**源码文本** import 了"，
    // **不检验**：会不会被调用、会不会被派发、是否有产品请求能到达。
  });

  it('③ 判据仍成立：源码文本 `includes` **看不见**"导入了但从不派发"（但 http.ts 本轮已真调用）', () => {
    // 事实翻正：第六轮 documents-routes 的 handler 在非测试代码里调用点为 0；本轮 http.ts 已真调用
    // （T1 §1.1 已机器化断言调用点为 1），故这里的"文本里没有调用模式"已不再成立。
    const httpText = readFileSync(join(ROOT, 'apps/demo/server/http.ts'), 'utf8');
    expect(httpText).toContain('handleDocumentsRequest');
    const callPattern = /(^|[^\w.])handleDocumentsRequest\s*\(/m;
    expect(callPattern.test(httpText), 'http.ts 本轮已真调用（第六轮为 false）').toBe(true);
    // 判别力仍在：判据本身**不恒真** —— 一段"只 import 不调用"的合成文本，`includes` 判 true，
    // 调用模式判 false ⇒ 证明源码文本检查对"import-only"是盲的（这正是它必须配 T1 调用点断言的原因）。
    const importOnly =
      "import { handleDocumentsRequest } from './documents-routes.js';\nexport const x = 1;\n";
    expect(importOnly.includes('handleDocumentsRequest')).toBe(true);
    expect(/(^|[^\w.])handleDocumentsRequest\s*\(/m.test(importOnly)).toBe(false);
  });
});

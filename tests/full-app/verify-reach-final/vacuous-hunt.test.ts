/**
 * FA-VERIFY-REACH-FINAL · 恒真 / 空洞断言猎捕（针对本轮新合入的接线模块与其测试）。
 *
 * 两类目标：
 * 1. **空洞用例**——guard（`if (...) return;`）出现在**第一条实质断言之前**，
 *    于是 guard 触发时整条用例一条断言都不执行，静默通过；
 * 2. **恒真断言**——`expect(X).toBe(X)` / `expect(true).toBe(true)` 之类的同式自比。
 *
 * 【反空断言的要求同样适用于本文件】猎捕器先过**自造反向对照**：一个真的空洞用例
 * 必须被它标红，一个健全用例必须不被误标——否则这个猎捕器本身就是恒真的。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** 本轮新合入 / 被改动的接线模块的测试文件。 */
const WIRING_TESTS = [
  'apps/demo/server/memory-routes.test.ts',
  'apps/demo/server/plugin-routes.test.ts',
  'apps/demo/server/route-wiring.test.ts',
  'apps/demo/server/conversation-loop.test.ts',
  'apps/demo/server/experience-wiring.test.ts',
  'apps/demo/server/memory-persistence.test.ts',
  'apps/demo/server/plugin-persistence.test.ts',
  'apps/demo/server/budget-wiring.test.ts',
  'apps/demo/server/e2e-routes.test.ts',
  'apps/demo/server/e2e-product.test.ts',
  // 第四轮后新合入的两组路由（FA-WIRE-DOCUMENTS-REACH / FA-WIRE-RESEARCH-REACH）：
  // 它们承载了 documents 包 44 个模块的"可达性"，必须一起过恒真 / 空洞猎捕。
  'apps/demo/server/documents-routes.test.ts',
  'apps/demo/server/research-routes.test.ts',
  // 本轮新合入的角色接线（FA-WIRE-ROLES-REACH）：承载 src/roles 整包 5 个模块的可达性。
  'apps/demo/server/roles-wiring.test.ts',
] as const;

/**
 * 提取 `it(...)` 用例块；`depth0Guards` 只统计**顶层**（大括号深度 0）的 `if (...) return;`。
 * 深度统计是为了排除"guard 嵌在回调里"这一类结构性假阳性。
 */
export function analyzeCaseBodies(src: string): ReadonlyArray<{
  readonly title: string;
  readonly hasDepth0Guard: boolean;
  readonly expectsBeforeGuard: number;
  readonly expectsTotal: number;
}> {
  const re = /it\s*\(\s*(['"`])([^\n]*?)\1\s*,\s*(?:async\s*)?\(\)\s*=>\s*\{/g;
  const starts: Array<{ idx: number; end: number; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) starts.push({ idx: m.index, end: re.lastIndex, title: m[2] ?? '' });

  const out: Array<{
    title: string;
    hasDepth0Guard: boolean;
    expectsBeforeGuard: number;
    expectsTotal: number;
  }> = [];

  for (let i = 0; i < starts.length; i += 1) {
    const s = starts[i] as { idx: number; end: number; title: string };
    const next = starts[i + 1];
    const body = src.slice(s.end, next === undefined ? src.length : next.idx);
    const expectsTotal = (body.match(/expect\s*\(/g) ?? []).length;

    let depth = 0;
    let guardIndex = -1;
    for (let k = 0; k < body.length; k += 1) {
      const ch = body[k];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === 'i' && depth === 0 && /^if\s*\([^)]*\)\s*return;/.test(body.slice(k))) {
        guardIndex = k;
        break;
      }
    }
    const before = guardIndex < 0 ? body : body.slice(0, guardIndex);
    out.push({
      title: s.title,
      hasDepth0Guard: guardIndex >= 0,
      expectsBeforeGuard: (before.match(/expect\s*\(/g) ?? []).length,
      expectsTotal,
    });
  }
  return out;
}

/** 同式自比 / 常量自比。 */
export function findTautologies(src: string): readonly string[] {
  const found = new Set<string>();
  const sameSide = /expect\s*\(\s*([^()]+?)\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/g;
  for (const mm of src.matchAll(sameSide)) {
    const expr = (mm[1] ?? '').trim();
    if (expr === 'true' || expr === 'false') continue; // 归入下面的常量自比
    found.add(mm[0]);
  }
  const constTrue = /expect\s*\(\s*(?:true|false)\s*\)\s*\.\s*toBe\s*\(\s*(?:true|false)\s*\)/g;
  for (const mm of src.matchAll(constTrue)) found.add(mm[0]);
  return [...found];
}

const report = ((): { file: string; title: string; expectsBefore: number }[] => {
  const hits: { file: string; title: string; expectsBefore: number }[] = [];
  for (const f of WIRING_TESTS) {
    let src: string;
    try {
      src = readFileSync(join(ROOT, f), 'utf8');
    } catch {
      continue;
    }
    for (const c of analyzeCaseBodies(src)) {
      if (c.hasDepth0Guard && c.expectsBeforeGuard === 0 && c.expectsTotal > 0) {
        hits.push({ file: f, title: c.title, expectsBefore: c.expectsBeforeGuard });
      }
    }
  }
  return hits;
})();

describe('0. 猎捕器自身的辨别力（自造反向对照）', () => {
  it('真的空洞用例（guard 在首条断言之前）⇒ 标红', () => {
    const src = `
      it('空洞', async () => {
        const x = get();
        if (x === null) return;
        expect(x).toBe(1);
      });
    `;
    const [c] = analyzeCaseBodies(src);
    expect(c?.hasDepth0Guard).toBe(true);
    expect(c?.expectsBeforeGuard).toBe(0);
    expect(c?.expectsTotal).toBe(1);
  });

  it('健全用例（guard 在断言之后 / 无 guard）⇒ 不标红', () => {
    const src = `
      it('健全', async () => {
        expect(a).toBe(1);
        const x = get();
        if (x === null) return;
        expect(x).toBe(1);
      });
      it('无 guard', async () => { expect(b).toBe(2); });
    `;
    const cases = analyzeCaseBodies(src);
    expect(cases[0]?.hasDepth0Guard).toBe(true);
    expect(cases[0]?.expectsBeforeGuard).toBe(1);
    expect(cases[1]?.hasDepth0Guard).toBe(false);
  });

  it('guard 嵌在回调里（结构性假阳性）⇒ 不标红', () => {
    const src = `
      it('回调里的 return', async () => {
        createServer((req, res) => { if (handled) return; res.end(); });
        expect(a).toBe(1);
      });
    `;
    const [c] = analyzeCaseBodies(src);
    expect(c?.hasDepth0Guard, '深度 > 0 的 guard 不算').toBe(false);
  });

  it('恒真猎捕器：同式自比能识别，正常断言不误报', () => {
    expect(findTautologies('expect(x).toBe(x);')).toHaveLength(1);
    expect(findTautologies('expect(true).toBe(true);')).toHaveLength(1);
    expect(findTautologies('expect(x).toBe(y);')).toHaveLength(0);
    expect(findTautologies('expect(status).toBe(404);')).toHaveLength(0);
  });
});

describe('1. 接线模块测试的恒真 / 空洞扫描结果', () => {
  it('被扫的测试文件确实存在（缺席会让扫描变成"零发现"的假绿）', () => {
    const missing = WIRING_TESTS.filter((f) => {
      try {
        readFileSync(join(ROOT, f), 'utf8');
        return false;
      } catch {
        return true;
      }
    });
    expect(missing, '被扫文件应全部存在').toEqual([]);
  });

  it('无"guard 在首条断言之前"的空洞用例', () => {
    expect(report, `空洞候选: ${JSON.stringify(report)}`).toEqual([]);
  });

  it('无 expect(X).toBe(X) / expect(true).toBe(true) 类恒真断言', () => {
    const tautologies: string[] = [];
    for (const f of WIRING_TESTS) {
      let src: string;
      try {
        src = readFileSync(join(ROOT, f), 'utf8');
      } catch {
        continue;
      }
      for (const t of findTautologies(src)) tautologies.push(`${f}: ${t}`);
    }
    expect(tautologies).toEqual([]);
  });

  it('扫描面确实覆盖到了用例（不是空集）', () => {
    let cases = 0;
    for (const f of WIRING_TESTS) {
      let src: string;
      try {
        src = readFileSync(join(ROOT, f), 'utf8');
      } catch {
        continue;
      }
      cases += analyzeCaseBodies(src).length;
    }
    expect(cases).toBeGreaterThan(100);
  });
});

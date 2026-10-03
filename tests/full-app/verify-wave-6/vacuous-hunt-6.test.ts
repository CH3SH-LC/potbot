/**
 * FA-VERIFY-WAVE-6 · 恒真 / 空洞断言猎捕（任务第 1 项）。
 *
 * 本轮新增了大量接线与端到端测试。本文件用**验证方自己的扫描器**（不复用
 * `verify-reach-final/vacuous-hunt.test.ts` 的实现者扫描器）找三类"绿得没意义"的形态：
 *
 * - **恒真自比**：`expect(X).toBe(X)` / `expect('a').toBe('a')`；
 * - **空值自证**：`const x = null; ... expect(x).toBeNull()`（断言一个刚被赋 null 的局部量）；
 * - **存在性承重**：`expect(f()).toBeTruthy()` 这类只证明"有返回值"的断言（计入统计，不单独判负）。
 *
 * 扫描器**先过自造反向对照**：一个真的恒真用例必须被标红，一个健全用例必须不被误标——
 * 否则扫描器本身就是恒真的。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** 本轮新增 / 改动的测试文件（被扫对象）。 */
const ROUND6_TESTS = [
  'apps/demo/server/roles-wiring.test.ts',
  'apps/demo/server/task-completion.false-success.test.ts',
  'apps/demo/server/documents-routes.test.ts',
  'apps/demo/server/research-routes.test.ts',
  'apps/demo/server/e2e-doc-research.test.ts',
  'apps/demo/server/adapters-actions.test.ts',
  'tests/full-app/gate-and-device.test.ts',
  'tests/full-app/e2e/a11-fidelity.test.ts',
  'tests/full-app/verify-reach-final/wiring-mount.test.ts',
] as const;

/** 恒真自比：`expect(E).toBe(E)`（含字面量自比与标识符自比）。 */
export function findSelfComparisons(src: string): readonly string[] {
  const found: string[] = [];
  const re = /expect\s*\(\s*([^()\n]+?)\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual|toBeGreaterThanOrEqual|toBeLessThanOrEqual)\s*\(\s*([^()\n]+?)\s*\)/g;
  for (const m of src.matchAll(re)) {
    const left = (m[1] ?? '').trim();
    const right = (m[2] ?? '').trim();
    if (left === right && left.length > 0) found.push(m[0].replace(/\s+/g, ' '));
  }
  return found;
}

/** 空值自证：先 `const x = null;`，随后 `expect(x).toBeNull()`。 */
export function findNullSelfAssertions(src: string): readonly string[] {
  const out: string[] = [];
  const re = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*null\s*;/g;
  for (const m of src.matchAll(re)) {
    const name = m[1] as string;
    const after = src.slice((m.index ?? 0) + (m[0].length));
    if (new RegExp(`expect\\s*\\(\\s*${name}\\s*\\)\\s*\\.\\s*toBeNull\\s*\\(`).test(after)) {
      out.push(`${m[0].trim()} → expect(${name}).toBeNull()`);
    }
  }
  return out;
}

/** 存在性承重断言（统计用）。 */
export function countExistenceOnly(src: string): number {
  return (src.match(/expect\s*\([^)]*\)\s*\.\s*(?:toBeTruthy|toBeDefined|toBeFalsy)\s*\(\s*\)/g) ?? []).length;
}

function read(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8');
}

function scanAll(files: readonly string[], finder: (s: string) => readonly string[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    let src: string;
    try {
      src = read(file);
    } catch {
      continue;
    }
    for (const hit of finder(src)) hits.push(`${file}: ${hit}`);
  }
  return hits;
}

describe('0. 扫描器自身的辨别力（自造反向对照）', () => {
  it('恒真自比：字面量自比 / 标识符自比被识别；不同值不误报', () => {
    expect(findSelfComparisons("expect(x).toBe(x);")).toHaveLength(1);
    expect(findSelfComparisons("expect('a').toBe('a');")).toHaveLength(1);
    expect(findSelfComparisons('expect(404).toEqual(404);')).toHaveLength(1);
    expect(findSelfComparisons('expect(x).toBe(y);')).toHaveLength(0);
    expect(findSelfComparisons('expect(status).toBe(404);')).toHaveLength(0);
  });

  it('空值自证：null 赋值 + toBeNull 被识别；有意义的 toBeNull 不误报', () => {
    const vacuous = 'const chunk = null;\nexpect(chunk).toBeNull();';
    expect(findNullSelfAssertions(vacuous)).toHaveLength(1);
    const sound = 'const found = map.get("k");\nexpect(found).toBeNull();';
    expect(findNullSelfAssertions(sound)).toHaveLength(0);
  });
});

describe('1. 本轮新测试文件的扫描结果（登记式断言）', () => {
  it('被扫文件全部存在（缺席会让扫描变成"零发现"的假绿）', () => {
    const missing = ROUND6_TESTS.filter((file) => {
      try {
        read(file);
        return false;
      } catch {
        return true;
      }
    });
    expect(missing, '被扫文件应全部存在').toEqual([]);
  });

  it('扫描面覆盖到用例（不是空集）', () => {
    let cases = 0;
    for (const file of ROUND6_TESTS) {
      cases += (read(file).match(/\bit\s*\(/g) ?? []).length;
    }
    expect(cases).toBeGreaterThan(100);
  });

  it('恒真自比登记：本轮测试文件里 —— 0 处', () => {
    expect(scanAll(ROUND6_TESTS, findSelfComparisons)).toEqual([]);
  });

  /**
   * **空值自证的登记项**（本轮新测试里两处"断言刚被赋 null 的局部量"）。
   *
   * 这不是"被测行为"——`types.ts` 分支只为了证明"类型模块被 import"，
   * 但以 `const chunk: Chunk | null = null; expect(chunk).toBeNull()` 承载时，断言恒真。
   * 本登记项**一旦被修好（改成断言真实行为或删除）即应更新**——本测试据此变红是预期信号。
   */
  it('空值自证登记：恰有 2 处（均在 research-routes.test.ts 的 types.ts 可达性自证）', () => {
    const hits = scanAll(ROUND6_TESTS, findNullSelfAssertions);
    expect(hits).toHaveLength(2);
    for (const hit of hits) {
      expect(hit).toContain('research-routes.test.ts');
    }
    expect(hits.some((hit) => hit.includes('chunk'))).toBe(true);
    expect(hits.some((hit) => hit.includes('answer'))).toBe(true);
  });

  it('存在性承重断言统计（信息性；不判负，只登记数量）', () => {
    let total = 0;
    for (const file of ROUND6_TESTS) total += countExistenceOnly(read(file));
    // 存有量非零是事实，登记即可（这些断言不承重"行为是否发生"）。
    expect(total).toBeGreaterThanOrEqual(0);
  });
});

describe('2. 弱判据登记（"区间断言"缺辨别力 —— 由兄弟用例兜住）', () => {
  /**
   * `documents-routes.test.ts` 对"删除不存在的图形"只断言 `status ∈ [400,500)`。
   * 验证方实测：把 `unknown_node` 的状态从 404 改成 422，该用例**照绿**（未咬住）；
   * 兜住它的是兄弟用例 `e2e-doc-research.test.ts` 的"越界合并 ⇒ 404 unknown_node"。
   */
  it('区间断言仍在（登记项；若被改成精确断言即应更新）', () => {
    const src = read('apps/demo/server/documents-routes.test.ts');
    expect(src).toContain('expect(badDelete.status).toBeGreaterThanOrEqual(400)');
    expect(src).toContain('expect(badDelete.status).toBeLessThan(500)');
  });

  it('兄弟用例对同一错误给出精确 404（这才是真正咬人的那条）', () => {
    const src = read('apps/demo/server/e2e-doc-research.test.ts');
    expect(src).toContain("expect(outOfRange.status).toBe(404)");
  });
});

describe('3. 恒真负对照 / 存在性代理 登记', () => {
  /**
   * 两处"负对照本身恒为真"与"构造器返回值存在性"，它们**不能承载任何行为判据**：
   * - `roles-wiring.test.ts`：`expect(SOURCE).not.toContain('handleMainAgentRequestX(')`
   *   —— 这个标识符本就没人写，负对照恒真（"尺子有刻度"那半句是装饰）。
   * - `research-routes.test.ts`：`expect(createMemoryBlobPort()).toBeTruthy()` 等
   *   —— 只证明"有个非空返回值"，任何对象都过。它们只用于"证明模块被 import 并调用"。
   */
  it('登记项仍在（修好后应更新本登记）', () => {
    expect(read('apps/demo/server/roles-wiring.test.ts')).toContain("not.toContain('handleMainAgentRequestX(')");
    expect(read('apps/demo/server/research-routes.test.ts')).toContain('expect(createMemoryBlobPort()).toBeTruthy();');
    expect(read('apps/demo/server/research-routes.test.ts')).toContain("expect(createMemorySourcePort(new Map([['s', utf8('x')]]))).toBeTruthy();");
  });
});

describe('4. 自我产出式断言登记（常量自证）', () => {
  /**
   * 多处断言"接口返回的常量 == 我在测试里重写的同一常量"，例如
   * `roles-wiring.test.ts` 的 `/api/roles/reachability` 与
   * `documents-routes.test.ts` 的 `coverage`。这类断言**由被测对象自身产出**，
   * 只能证明"两边引用同一个常量"，不能证明常量本身是真的——**登记为弱判据**。
   */
  it('三处常量自证登记仍在（弱判据；需要独立事实源才可升级）', () => {
    expect(read('apps/demo/server/roles-wiring.test.ts')).toContain('expect(result.body.reachable_modules).toEqual([...ROLES_MODULES_REACHABLE_BY_WIRING])');
    expect(read('apps/demo/server/documents-routes.test.ts')).toContain("expect(body['coverage']).toEqual(DOCUMENTS_ROUTE_MODULE_COVERAGE)");
    expect(read('tests/full-app/gate-and-device.test.ts')).toContain("expect(DEVICE_REACHABILITY).toBe('reachable')");
  });
});

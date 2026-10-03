/**
 * FA-VERIFY-WAVE-3 · 产品可达性普查（本轮最要紧的一条）
 *
 * 命题：**大量新增内核模块只活在自己的 `.test.ts` 里**，产品入口
 * （`apps/demo/server/main.ts` 起的真实 HTTP 服务 + `apps/demo/web` 页面）根本够不到。
 *
 * 本文件**自带**一份 import 图扫描（不复用 `_scan-reachability.mjs`，也不复用实现者
 * 任何夹具），从产品入口做 BFS，得出三态：
 *   - 产品可达：BFS 闭包内；
 *   - 仅内核可达：非产品可达，但至少有一个**非测试**文件 import 它；
 *   - 仅测试可达：非产品可达，且引用者**全是测试文件**（或根本没有引用者）。
 *
 * 同时按"传递口径"再算一次：非产品可达、且只能从「非测试根」进入（该根自身只被测试引用）
 * 的模块，整体属于"仅测试可达子系统"——这是比直接口径更接近"产品上真的用不到"的判据。
 *
 * 纪律：只报告、不修；全部结论来自本文件自造的分析，不复用实现者结论。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根：tests/full-app/verify-wave-3/ → 上溯 3 级。 */
const ROOT = resolve(HERE, '..', '..', '..');

const PRODUCT_ENTRIES = ['apps/demo/server/main.ts'];

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === '.runtime') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

const rel = (p: string): string => relative(ROOT, p).split('\\').join('/');
const isTest = (r: string): boolean => /\.(test|spec)\.[cm]?[jt]sx?$/.test(r);

interface Graph {
  readonly edges: Map<string, Set<string>>;
  readonly importersOf: Map<string, Set<string>>;
  readonly codeFiles: string[];
  readonly srcNonTest: string[];
}

function buildGraph(): Graph {
  const all = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'apps', 'demo'))];
  const codeFiles = all.filter((f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f) && !f.endsWith('.d.ts'));

  const importRe =
    /(?:^|[^\w.])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w.])import\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

  const edges = new Map<string, Set<string>>();
  const importersOf = new Map<string, Set<string>>();

  for (const f of codeFiles) {
    const text = readFileSync(f, 'utf8');
    const out = new Set<string>();
    for (const m of text.matchAll(importRe)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (spec === undefined || !spec.startsWith('.')) continue;
      const base = resolve(dirname(f), spec.replace(/\.(js|mjs|cjs)$/, ''));
      const candidates = [
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.mjs`,
        `${base}.js`,
        join(base, 'index.ts'),
        join(base, 'index.tsx'),
        join(base, 'index.js'),
      ];
      const hit = candidates.find((c) => existsSync(c) && statSync(c).isFile());
      if (hit !== undefined) out.add(hit);
    }
    edges.set(f, out);
  }
  for (const [from, tos] of edges) {
    for (const to of tos) {
      if (!importersOf.has(to)) importersOf.set(to, new Set());
      importersOf.get(to)!.add(from);
    }
  }

  const srcNonTest = codeFiles.map(rel).filter((r) => r.startsWith('src/') && !isTest(r)).sort();
  return { edges, importersOf, codeFiles, srcNonTest };
}

function bfs(graph: Graph, roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of graph.edges.get(cur) ?? []) if (!seen.has(next)) queue.push(next);
  }
  return seen;
}

const graph = buildGraph();
const productReachable = bfs(
  graph,
  PRODUCT_ENTRIES.map((r) => join(ROOT, r)).filter(existsSync),
);

/** 直接引用者分类。 */
function importers(moduleRel: string): { nonTest: string[]; test: string[] } {
  const abs = join(ROOT, moduleRel);
  const all = [...(graph.importersOf.get(abs) ?? [])].map(rel);
  return { nonTest: all.filter((i) => !isTest(i)).sort(), test: all.filter(isTest).sort() };
}

const label = (moduleRel: string): '产品可达' | '仅内核可达' | '仅测试可达' | '零引用' => {
  if (productReachable.has(join(ROOT, moduleRel))) return '产品可达';
  const imps = importers(moduleRel);
  if (imps.nonTest.length === 0) return imps.test.length === 0 ? '零引用' : '仅测试可达';
  return '仅内核可达';
};

/** 非产品可达、且传递上只能经"只被测试引用的非测试根"进入。 */
function transitiveTestOnly(): Set<string> {
  const nonTestAbs = graph.codeFiles.filter((f) => !isTest(rel(f)));
  const nonTestSet = new Set(nonTestAbs);
  const inEdges = new Map<string, Set<string>>();
  for (const f of nonTestAbs) inEdges.set(f, new Set());
  for (const [from, tos] of graph.edges) {
    if (!nonTestSet.has(from)) continue;
    for (const to of tos) if (nonTestSet.has(to)) inEdges.get(to)!.add(from);
  }
  const orphanRoots = nonTestAbs.filter(
    (f) => !productReachable.has(f) && (inEdges.get(f)?.size ?? 0) === 0,
  );
  return bfs(graph, orphanRoots);
}

const ttOnly = transitiveTestOnly();

/** 一组模块里，来自包外（前缀之外）的非测试引用者（去重、排序）。 */
function externalNonTestImporters(modules: readonly string[], pkgPrefix: string): string[] {
  const out = new Set<string>();
  for (const m of modules) for (const i of importers(m).nonTest) if (!i.startsWith(pkgPrefix)) out.add(i);
  return [...out].sort();
}

/**
 * 一组模块里，来自包外、且**自身产品可达**的非测试引用者。
 *
 * 这是"整包已接线进产品"的源码级证据：只要这些消费者被接线，它们 import 的包就在产品闭包内；
 * 反过来，若有人把接线回退（消费者不再被产品入口可达，或干脆删掉 import），本函数会返回空数组，
 * 对应的用例随之变红。
 */
function productReachableExternalConsumers(modules: readonly string[], pkgPrefix: string): string[] {
  return externalNonTestImporters(modules, pkgPrefix).filter((i) =>
    productReachable.has(join(ROOT, i)),
  );
}

describe('产品可达性普查 · 扫描根与基本事实', () => {
  it('产品入口存在，且确实 import 了四个 src 内核 barrel（产品-内核桥是通的）', () => {
    const mainRel = 'apps/demo/server/main.ts';
    expect(existsSync(join(ROOT, mainRel))).toBe(true);
    const main = readFileSync(join(ROOT, mainRel), 'utf8');
    for (const barrel of [
      '../../../src/storage/index.js',
      '../../../src/protocol/index.js',
      '../../../src/documents/session/index.js',
      '../../../src/session/index.js',
    ]) {
      expect(main).toContain(barrel);
    }
  });

  it('src 非测试模块总数 ≥ 400（确认扫描真的覆盖了内核）', () => {
    expect(graph.srcNonTest.length).toBeGreaterThan(400);
  });

  it('产品可达的 src 模块里包含文档/表格/演示/协议等主干', () => {
    for (const m of [
      'src/protocol/index.ts',
      'src/storage/index.ts',
      'src/documents/session/session.ts',
      'src/session/session.ts',
      'src/spreadsheets/workbook.ts',
      'src/presentations/model.ts',
    ]) {
      expect(label(m)).toBe('产品可达');
    }
  });
});

describe('产品可达性普查 · 整包接线（原「整包不可达」事实已被本轮接线翻转）', () => {
  const memoryModules = graph.srcNonTest.filter((m) => m.startsWith('src/memory/'));
  const conversationModules = graph.srcNonTest.filter((m) => m.startsWith('src/conversation/'));
  const rolesModules = graph.srcNonTest.filter((m) => m.startsWith('src/roles/'));

  it('src/memory/**：16 个非测试模块，**全部产品可达**（原断言固化"记忆能力产品上够不到"的旧事实）', () => {
    // 【原断言 → 新断言】原断言：16 个模块**全部非产品可达**，包外唯一非测试引用者是
    // `src/roles/experience-agent.ts`（固化本文件第三轮普查时的旧事实）。
    // 本轮 `memory-routes.ts` 等经 `main.ts` / `http.ts` 接线进产品 ⇒ 全部模块产品可达。
    // 若有人把接线回退，下面两条（逐模块可达 + 产品可达消费者存在）会重新变红。
    expect(memoryModules).toHaveLength(16);
    for (const m of memoryModules) {
      expect(label(m)).toBe('产品可达');
    }
    // 源码级证据：确有**产品可达**的非测试消费者把该包拉进产品闭包（不是"碰巧被人 import"）。
    expect(productReachableExternalConsumers(memoryModules, 'src/memory/').length).toBeGreaterThan(0);
  });

  it('src/conversation/**：8 个非测试模块，**全部产品可达**（原断言为 7 个、全部非产品可达）', () => {
    // 【原断言 → 新断言】原断言：7 个模块全部非产品可达、包外无任何非测试引用者。
    // 本轮新增 1 个模块（共 8 个）且整包经 `conversation-loop.ts` 接线进产品。
    // 接线被回退 ⇒ 逐模块可达断言与消费者断言重新变红。
    expect(conversationModules).toHaveLength(8);
    for (const m of conversationModules) {
      expect(label(m)).toBe('产品可达');
    }
    expect(productReachableExternalConsumers(conversationModules, 'src/conversation/')).toContain(
      'apps/demo/server/conversation-loop.ts',
    );
  });

  it('src/roles/**：5 个非测试模块，**全部产品可达**（原断言为"仍非产品可达"）', () => {
    // 【原断言 → 新断言】原断言：5 个模块全部非产品可达、包外唯一非测试引用者
    // `experience-wiring.ts` 自身也不在产品闭包内 ⇒ roles 是孤岛。
    // 本轮 `roles-wiring.ts` 真接线进产品 ⇒ 整包产品可达。
    // 接线被回退 ⇒ 逐模块可达 + 产品可达消费者两条断言重新变红。
    expect(rolesModules).toHaveLength(5);
    for (const m of rolesModules) {
      expect(label(m)).toBe('产品可达');
    }
    expect(productReachableExternalConsumers(rolesModules, 'src/roles/')).toContain(
      'apps/demo/server/roles-wiring.ts',
    );
  });

  it('三个整包的模块仍落在"从孤立非测试根可达"的传递集合里（注意：这不是"产品够不到"的证明）', () => {
    // 【2026-10-03 更新】原用例标题称"无任何非测试入口能进入"，本轮接线后对 memory / conversation
    // **已不成立**（两者已另有产品入口）。断言本身测的是"可从只被测试引用的非测试根 BFS 到达"——
    // 由于该 BFS 会跟随全部边（含进入测试文件的边），membership 对绝大多数模块恒真，判别力极弱。
    // 该断言**不是**"产品够不到"的证据；此处如实改标题、保留断言（其正确结论见上方各整包用例）。
    for (const m of [...memoryModules, ...conversationModules, ...rolesModules]) {
      expect(ttOnly.has(join(ROOT, m))).toBe(true);
    }
  });
});

describe('产品可达性普查 · 检索适配器（src/adapters/research/**）', () => {
  const researchModules = graph.srcNonTest.filter((m) => m.startsWith('src/adapters/research/'));

  it('整个 research 包**已产品可达**（原断言固化"产品入口不接检索适配器"的旧事实）', () => {
    // 【原断言 → 新断言】原断言：整个 research 包非产品可达。本轮经 `research-routes.ts` /
    // `research-citations.ts` 接线进产品 ⇒ 全部模块产品可达。接线被回退 ⇒ 逐模块断言重新变红。
    expect(researchModules).toHaveLength(29);
    for (const m of researchModules) {
      expect(label(m)).toBe('产品可达');
    }
    expect(productReachableExternalConsumers(researchModules, 'src/adapters/research/').length).toBeGreaterThan(0);
  });

  it('research 的对外 barrel 现被**产品可达**的非测试代码消费（原断言：只被自己的测试引用）', () => {
    // 【原断言 → 新断言】原断言：`index.ts` 的 nonTest 引用者为 `[]`、只被 `slice.test.ts` 引用、
    // 因此传递上是"仅测试可达子系统"。本轮 `src/session/adapters/research-citations.ts` 引用了它，
    // 且 `apps/demo/server/session-adapters-wiring.ts` 也按名引用（本轮新增消费方），
    // 两者**均产品可达**。若任一消费者被移除/回退，下面第一条重新变红。
    expect(importers('src/adapters/research/index.ts').nonTest).toEqual([
      'apps/demo/server/session-adapters-wiring.ts',
      'src/session/adapters/research-citations.ts',
    ]);
    expect(productReachable.has(join(ROOT, 'src/session/adapters/research-citations.ts'))).toBe(true);
    expect(productReachable.has(join(ROOT, 'apps/demo/server/session-adapters-wiring.ts'))).toBe(true);
  });
});

describe('产品可达性普查 · 直接口径下的"仅测试可达"清单（本轮接线后大幅收缩）', () => {
  it('仅剩 8 个 src 模块的引用者全是测试文件（原断言 ≥30 → 15 → 本轮 8）', () => {
    // 【原断言 → 新断言】原断言 `>= 30` 固化第三轮普查时的旧事实。本轮把 memory / conversation /
    // research / roles / adapters 等包接线进产品后，仅测试可达的模块降到 8。用**精确值**断言：
    // 接线被回退（模块重新变回仅测试可达）⇒ 数字回升 ⇒ 变红；新增仅测试可达模块也会被看到。
    const onlyTest = graph.srcNonTest.filter((m) => label(m) === '仅测试可达');
    expect(onlyTest).toHaveLength(8);
    // 每个都必须给出唯一（或全部为测试的）引用者——不许有非测试引用者
    for (const m of onlyTest) expect(importers(m).nonTest).toEqual([]);
  });

  it('代表性清单翻转：原 10 个"仅测试可达"现**全部**产品可达', () => {
    // 【原断言 → 新断言】原用例把下列 10 个模块逐个钉为"仅测试可达"。本轮其中 9 个在第六轮已接线，
    // 最后一个 meituan/compare.ts 也由 meituan/index.ts 的再导出纳入产品闭包 ⇒ 断言全部翻转为"产品可达"
    // （接线回退 ⇒ 重新变红）。
    const nowReachable = [
      'src/adapters/calendar/event-mutations.ts',
      'src/adapters/clock/alarm-schedule.ts',
      'src/documents/accept-reject.ts',
      'src/documents/revisions-export.ts',
      'src/memory/backup-plan.ts',
      'src/memory/experience-rollback.ts',
      'src/scheduler/capability-registry.ts',
      'src/spreadsheets/facts-binding.ts',
      'src/documents/reference-audit.ts',
      'src/adapters/meituan/compare.ts', // ← 本轮翻正：第六轮仍"仅测试可达"的唯一一个
    ];
    for (const m of nowReachable) expect(label(m)).toBe('产品可达');
    // 反向对照（判据不恒真）：仍有模块**确实**仅测试可达，其唯一引用者是测试文件。
    expect(label('src/documents/model/fixtures.ts')).toBe('仅测试可达');
    expect(importers('src/documents/model/fixtures.ts').test).toContain(
      'src/documents/model/document.test.ts',
    );
    expect(importers('src/documents/model/fixtures.ts').nonTest).toEqual([]);
  });
});

describe('产品可达性普查 · 孤儿 barrel（src/*/index.ts 导出无人消费）', () => {
  it('仍有若干 index.ts barrel 零引用；但原清单里已接线消费的 barrel **不再是孤儿**', () => {
    // 【原断言 → 新断言】原用例把 10 个 barrel 钉为"孤儿"（除测试外零引用）。本轮接线后
    // `src/conversation/index.ts`（及 documents/equations、operations/drawing、operations/table）
    // 已被非测试代码消费 ⇒ 不再是孤儿。保留仍零引用的 6 个，并把"已接线者**必须不再**是孤儿"
    // 作为可失败的反向对照（接线被回退 ⇒ conversation/index.ts 重新变回孤儿 ⇒ 变红）。
    const barrels = graph.srcNonTest.filter((m) => m.endsWith('/index.ts'));
    expect(barrels.length).toBeGreaterThan(30);
    const orphans = barrels.filter((m) => importers(m).nonTest.length === 0 && importers(m).test.length === 0);
    const stillOrphans = [
      'src/index.ts',
      'src/documents/charts/index.ts',
      'src/documents/proofing/index.ts',
      'src/documents/sections/index.ts',
      'src/documents/selection/index.ts',
      'src/documents/styles/index.ts',
    ];
    for (const m of stillOrphans) expect(orphans).toContain(m);
    // 反向对照：本轮已接线消费的 barrel 不再是孤儿，且确有非测试消费者。
    expect(orphans).not.toContain('src/conversation/index.ts');
    expect(importers('src/conversation/index.ts').nonTest.length).toBeGreaterThan(0);
  });

  it('内核公共入口 src/index.ts 只导出一个常量、无人 import（barrel 是死面）', () => {
    expect(importers('src/index.ts').nonTest).toEqual([]);
    expect(importers('src/index.ts').test).toEqual([]);
    const text = readFileSync(join(ROOT, 'src/index.ts'), 'utf8');
    expect(text).toContain('PACKAGE_VERSION');
    // 除了版本号，没有 re-export 任何内核模块（与"内核包入口"的自述不符）
    expect((text.match(/^export /gm) ?? []).length).toBe(1);
  });
});

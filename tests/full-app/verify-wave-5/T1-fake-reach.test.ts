/**
 * FA-VERIFY-WAVE-5 · §1 **假可达猎捕**：可达（进了 import 闭包）但**不干活**。
 *
 * 判据把"可达"拆成三层：
 * - **import 闭包**（实现者普查口径）：只要有一条 import 边进去即算"可达"；
 * - **真用闭包**（本套件口径）：边必须"按名使用了**由目标模块声明**的符号（值位置）"，
 *   且沿链路每一跳都成立；
 * - **派发可达**（运行时事实）：要有真实请求能走到它。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { request, startProduct, type Running } from './http-util.js';
import {
  buildGraph,
  buildUseGraph,
  closure,
  collectFiles,
  findCallSites,
  referencesNames,
  toModules,
  type CallSite,
  type GraphIndex,
  type RepoFiles,
} from './reach-graph.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DOCUMENTS_ROUTES = join(ROOT, 'apps/demo/server/documents-routes.ts');
const RESEARCH_ROUTES = join(ROOT, 'apps/demo/server/research-routes.ts');
const ENTRY = join(ROOT, 'apps/demo/server/main.ts');

/** 上一轮（第十四波）自称"由不可达变可达"的 62 个模块里，本套件抽样的 38 个。 */
const SAMPLED_BECAME_REACHABLE = [
  'src/adapters/calendar/calendars-and-query.ts',
  'src/adapters/calendar/event-model.ts',
  'src/adapters/calendar/event-mutations.ts',
  'src/adapters/calendar/reconcile.ts',
  'src/adapters/calendar/recurrence.ts',
  'src/adapters/clock/alarm-intent.ts',
  'src/adapters/clock/alarm-query.ts',
  'src/adapters/clock/alarm-schedule.ts',
  'src/adapters/research/answer-compose.ts',
  'src/adapters/research/cache.ts',
  'src/adapters/research/chunk.ts',
  'src/adapters/research/citation-support.ts',
  'src/adapters/research/citation.ts',
  'src/adapters/research/digest.ts',
  'src/adapters/research/extract.ts',
  'src/adapters/research/failure-modes.ts',
  'src/adapters/research/fetch.ts',
  'src/adapters/research/index-store.ts',
  'src/adapters/research/private-corpus.ts',
  'src/adapters/research/query-port.ts',
  'src/adapters/research/refresh.ts',
  'src/adapters/research/relevance.ts',
  'src/adapters/research/search.ts',
  'src/conversation/decision-bubble.ts',
  'src/conversation/delete-semantics.ts',
  'src/conversation/run-constraints.ts',
  'src/conversation/session-model.ts',
  'src/conversation/session-tasks.ts',
  'src/conversation/turn-model.ts',
  'src/memory/backup-plan.ts',
  'src/memory/conflict-resolution.ts',
  'src/memory/experience-pipeline.ts',
  'src/memory/experience.ts',
  'src/memory/recall-limits.ts',
  'src/memory/repository.ts',
  'src/memory/typed-scope.ts',
  'src/scheduler/capability-registry.ts',
  'src/spreadsheets/facts-binding.ts',
] as const;

/**
 * §1.5 的"已翻正"符号清单（模块级：既然 §1.5 的引用查询要在 `beforeAll` 里**一次性**预取，
 * 名字就必须在 `describe` 之外也能看见）。
 */
const FLIPPED_SYMBOL_CASES: readonly (readonly [string, string, string])[] = [
  // [声明该符号的模块, 符号名, 本轮的非测试引用者]
  ['src/session/adapters/research-citations.ts', 'researchCitationPresenter', 'apps/demo/server/session-adapters-wiring.ts'],
  ['src/session/adapters/research-citations.ts', 'renderAnswer', 'apps/demo/server/session-adapters-wiring.ts'],
  ['src/session/adapters/research-citations.ts', 'exportResearchBytes', 'apps/demo/server/session-adapters-wiring.ts'],
  ['src/session/adapters/cal-clock.ts', 'calClockToolAdapter', 'apps/demo/server/session-adapters-wiring.ts'],
  ['src/session/adapters/cal-clock.ts', 'clockCalendarReadiness', 'apps/demo/server/session-adapters-wiring.ts'],
  ['src/memory/conflict-resolution.ts', 'resolveCurrentInstructionAgainstMemory', 'apps/demo/server/mem-inject-product.ts'],
];

/**
 * 本套件要按名查"调用点"和"引用点"的**全部**符号。
 *
 * 两者是**不同判据**（`findCallSites` 只看 `name(` / `new name(` / 模板标签；`referencesNames`
 * 看任意标识符引用），故各预取一次——但**每个判据只做一遍全仓扫描**：
 * 原先 §1.1 / §1.5 里 11 次 `referencesName`（内部每次一遍全仓）+ 2 次 `findCallSites`
 * 共 **13 遍**全仓 AST 扫描，现在合并为 **2 遍**（各取一组名字）。
 * 单名版与多名版对同一名字逐项同结果（`reach-graph.ts` 的 `referencesName` 直接转调
 * `referencesNames` 后过滤，见其注释），故本改动**不动任何断言**，只去掉同输入的重复扫描。
 */
const CALL_SITE_NAMES: readonly string[] = [
  'handleDocumentsRequest',
  'handleResearchRequest',
  'handleMemoryRequest',
];
const REFERENCE_NAMES: readonly string[] = [
  'handleDocumentsRequest',
  'documentsHost',
  'researchOptions',
  ...FLIPPED_SYMBOL_CASES.map(([, symbol]) => symbol),
  'traceFactVersions',
  'serializeMemoryBackup',
];

let files: RepoFiles;
let graph: GraphIndex;
let useClosure: Set<string>;
let importClosure: Set<string>;
let onlyViaRoutes: string[];
/** 预取的两张表：名字 → 调用点 / 名字 → 引用点（用例只做查表，不再各自扫全仓）。 */
let callSitesByName: Map<string, CallSite[]>;
let refsByName: Map<string, CallSite[]>;

/** `referencesName(files, name, exclude)` 的等价查表版（过滤放在扫描后，语义逐项一致）。 */
function refsOf(name: string, excludeFiles: readonly string[] = []): CallSite[] {
  const all = refsByName.get(name) ?? [];
  if (excludeFiles.length === 0) return all;
  const exclude = new Set(excludeFiles.map((p) => p.split('\\').join('/')));
  return all.filter((s) => !exclude.has(s.file));
}

/** `findCallSites(files, [name])` 的等价查表版。 */
function callSitesOf(name: string): CallSite[] {
  return callSitesByName.get(name) ?? [];
}

beforeAll(() => {
  files = collectFiles(ROOT);
  graph = buildGraph(files);
  const useGraph = buildUseGraph(files, graph);
  importClosure = new Set(toModules(ROOT, closure(graph, [ENTRY])));
  useClosure = new Set(toModules(ROOT, closure(useGraph, [ENTRY])));
  const afterCut = new Set(toModules(ROOT, closure(graph, [ENTRY], [DOCUMENTS_ROUTES, RESEARCH_ROUTES])));
  onlyViaRoutes = [...importClosure].filter((m) => !afterCut.has(m));
  // 两遍全仓扫描，替代原先 13 遍（每个名字各一遍）。
  callSitesByName = findCallSites(files, CALL_SITE_NAMES);
  refsByName = referencesNames(files, REFERENCE_NAMES);
}, 300_000);

describe('§1.1 两个路由模块**已真派发**：import + 宿主构造 + 分发链调用俱全（第六轮"唯独没有派发"已翻正）', () => {
  it('两个 handler 在**非测试代码**里各恰有 1 个真调用点，且都在 http.ts（第六轮为 0）', () => {
    // 判别力：回退 http.ts 里那次 dispatch 调用 ⇒ 调用点变回空 ⇒ 本行重新变红
    expect(callSitesOf('handleDocumentsRequest').length).toBe(1);
    expect(callSitesOf('handleResearchRequest').length).toBe(1);
    expect(callSitesOf('handleDocumentsRequest').map((s) => s.file)).toEqual([
      'apps/demo/server/http.ts',
    ]);
    expect(callSitesOf('handleResearchRequest').map((s) => s.file)).toEqual([
      'apps/demo/server/http.ts',
    ]);
  });

  it('反向对照（证明"0 调用"不是因为文件不存在或名字写错）', () => {
    // 同名 handler 的**定义**确实存在
    const defined = refsOf('handleDocumentsRequest');
    expect(defined.some((s) => s.file === 'apps/demo/server/documents-routes.ts')).toBe(true);
    // 且 http.ts 确实把它 import 了（只是不用）——用原文核对，避免"名字写错"的误判
    const httpText = readFileSync(join(ROOT, 'apps/demo/server/http.ts'), 'utf8');
    expect(httpText).toContain("import { createDocumentsRouteHost, handleDocumentsRequest");
    expect(httpText).toContain("import { handleResearchRequest");
    // 另一条真接线对照：handleMemoryRequest 有调用点（说明扫描器能看见调用）
    expect(callSitesOf('handleMemoryRequest').length).toBeGreaterThan(0);
  });

  it('装配局部名 `documentsHost` / `researchOptions` 只在 http.ts 内出现（未泄漏到其它非测试文件）', () => {
    // 判别力：这两组装配若被提升成跨文件共享的全局名，会在别的文件里出现 ⇒ 本行变红
    const docsRefs = refsOf('documentsHost', ['apps/demo/server/http.ts']);
    expect(docsRefs).toEqual([]);
    const researchRefs = refsOf('researchOptions', ['apps/demo/server/http.ts']);
    expect(researchRefs).toEqual([]);
  });
});

describe('§1.2 运行时取证的同一结论（真 HTTP）', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'vw5-t1-'));
  let running: Running;

  beforeAll(async () => {
    running = await startProduct(runDir);
  }, 60_000);

  afterAll(async () => {
    await running.close();
    rmSync(runDir, { recursive: true, force: true });
  });

  it('两条路由的命名空间**已真派发**：/status 均 200，与"不存在的路径"可区分（第六轮两者逐字相同 404）', async () => {
    const docs = await request(running.baseUrl, 'GET', '/api/documents/status');
    const research = await request(running.baseUrl, 'GET', '/api/research/status');
    const nothing = await request(running.baseUrl, 'GET', '/api/definitely-not-a-route');
    // 判别力：回退（http.ts 不再调用 handler）⇒ 两前缀落回兜底 404 ⇒ 本行重新变红
    expect(docs.status).toBe(200);
    expect(research.status).toBe(200);
    expect(nothing.status).toBe(404);
    expect(docs.body).not.toEqual(nothing.body);
    expect(research.body).not.toEqual(nothing.body);
  });

  it('反向对照：同一次运行里，三个**真挂上**的前缀给出 200（不是 404）', async () => {
    for (const path of ['/api/memory/status', '/api/plugins', '/api/conversation-loop/status']) {
      const r = await request(running.baseUrl, 'GET', path);
      expect(r.status, `${path} 应为 200`).toBe(200);
    }
  });
});

describe('§1.3 抽样 ≥15：上一轮"变可达"的模块，逐个判 (a) 真调用 / (b) 只被 import·再导出', () => {
  it('本套件自带的分类器对"根本不存在的模块"给出否定（防止把什么都判成可达）', () => {
    expect(importClosure.has('src/memory/blocked-never.ts')).toBe(false);
  });

  it('38 个抽样里 **30 个是真调用**、8 个是 (b) 假可达（第六轮：31 假 / 7 真）', () => {
    const fake = SAMPLED_BECAME_REACHABLE.filter((m) => importClosure.has(m) && !useClosure.has(m));
    const real = SAMPLED_BECAME_REACHABLE.filter((m) => useClosure.has(m));
    // 判别力：把本轮的真派发回退 ⇒ 相应模块退回 (b) ⇒ real 清单变短、本行重新变红
    expect(real.sort()).toEqual([
      'src/adapters/calendar/calendars-and-query.ts',
      'src/adapters/calendar/event-model.ts',
      'src/adapters/calendar/event-mutations.ts',
      'src/adapters/calendar/reconcile.ts',
      'src/adapters/calendar/recurrence.ts',
      'src/adapters/clock/alarm-intent.ts',
      'src/adapters/clock/alarm-query.ts',
      'src/adapters/clock/alarm-schedule.ts',
      'src/adapters/research/answer-compose.ts',
      'src/adapters/research/cache.ts',
      'src/adapters/research/chunk.ts',
      'src/adapters/research/citation-support.ts',
      'src/adapters/research/citation.ts',
      'src/adapters/research/digest.ts',
      'src/adapters/research/extract.ts',
      'src/adapters/research/failure-modes.ts',
      'src/adapters/research/fetch.ts',
      'src/adapters/research/private-corpus.ts',
      'src/adapters/research/query-port.ts',
      'src/adapters/research/refresh.ts',
      'src/adapters/research/relevance.ts',
      'src/adapters/research/search.ts',
      'src/conversation/run-constraints.ts',
      'src/conversation/turn-model.ts',
      'src/memory/backup-plan.ts',
      'src/memory/experience-pipeline.ts',
      'src/memory/experience.ts',
      'src/memory/recall-limits.ts',
      'src/memory/repository.ts',
      'src/spreadsheets/facts-binding.ts',
    ]);
    expect(fake.length).toBe(8);
    // 具名登记：仍属 (b) 假可达的一类（barrel 蹭进闭包 / 只被 import 未被调用）
    expect(fake).toContain('src/conversation/session-model.ts');
    expect(fake).toContain('src/conversation/session-tasks.ts');
    expect(fake).toContain('src/conversation/delete-semantics.ts');
    expect(fake).toContain('src/conversation/decision-bubble.ts');
    expect(fake).toContain('src/scheduler/capability-registry.ts');
    expect(fake).toContain('src/memory/conflict-resolution.ts');
    // 本轮翻正：以下 5 个第六轮判为 (b)，现已被真调用（两个方向都钉住）
    for (const m of [
      'src/adapters/research/search.ts',
      'src/adapters/research/fetch.ts',
      'src/adapters/calendar/reconcile.ts',
      'src/adapters/clock/alarm-schedule.ts',
      'src/spreadsheets/facts-binding.ts',
    ]) {
      expect(real, `${m} 本轮应属真调用`).toContain(m);
      expect(fake, `${m} 不应再是假可达`).not.toContain(m);
    }
  });
});

describe('§1.4 documents-routes / research-routes 是 **61 个 src 模块的唯一产品入口**（第六轮 44，本轮 61）', () => {
  it('剪掉 documents-routes / research-routes 的出边后，import 闭包少了 61 个 src 模块', () => {
    // 判别力：删掉任一 import 边或把它们移出产品闭包 ⇒ 该数变动 ⇒ 本行变红
    expect(onlyViaRoutes.length).toBe(61);
  });

  it('具名抽样：全部只经 documents-routes 可达，且**每一个非测试引用者都在这座孤岛里**', () => {
    const island = new Set(onlyViaRoutes.map((m) => join(ROOT, m)));
    island.add(DOCUMENTS_ROUTES);
    island.add(RESEARCH_ROUTES);
    const sampled = [
      'src/documents/table-workflow.ts',
      'src/documents/page-workflow.ts',
      'src/documents/header-footer-workflow.ts',
      'src/documents/image-workflow.ts',
      'src/documents/reference-audit.ts',
      'src/documents/revisions-export.ts',
      'src/documents/accept-reject.ts',
      'src/documents/operations/table/index.ts',
      'src/documents/operations/drawing/index.ts',
      'src/documents/references/index.ts',
      'src/documents/review/index.ts',
      'src/documents/equations/index.ts',
      'src/documents/sections/breaks.ts',
    ];
    for (const m of sampled) {
      expect(onlyViaRoutes, `${m} 应只经 documents-routes 可达`).toContain(m);
      const importers = [...(graph.inNonTest.get(join(ROOT, m)) ?? new Set<string>())];
      expect(importers.length, `${m} 应有非测试引用者`).toBeGreaterThan(0);
      for (const imp of importers) {
        // 每个引用者要么与它同在孤岛里，要么**自己根本不可达**（如 `sections/index.ts` 这种零引用 barrel）
        const islandMember = island.has(imp);
        const unreachable = !importClosure.has(toModules(ROOT, new Set([imp]))[0] ?? '');
        expect(islandMember || unreachable, `${m} 的引用者 ${imp} 竟在孤岛之外且产品可达`).toBe(true);
      }
    }
  });
});

describe('§1.5 barrel 蹭进闭包：(b) 类的另一种形态——**名字从没被任何消费者点过**', () => {
  // 【原断言 → 新断言】第六轮这 6 个名字在**非测试代码**里零引用；本轮 `fa/fix-weak-control`
  // 后在 `session-adapters-wiring.ts` / `mem-inject-product.ts` 里被真引用 ⇒ 翻正为"已被真调用"。
  const flipped = FLIPPED_SYMBOL_CASES;

  for (const [module, symbol, caller] of flipped) {
    it(`${symbol}（声明于 ${module}）本轮已被非测试代码真引用（第六轮零引用）`, () => {
      const refs = refsOf(symbol, [module]);
      // 判别力：把该接线回退（删掉 caller 里那次引用）⇒ refs 变回 [] ⇒ 本行重新变红
      expect(refs.length, `${symbol} 应被非测试代码引用：${JSON.stringify(refs)}`).toBeGreaterThan(0);
      expect(refs.map((r) => r.file), `${symbol} 的引用者`).toContain(caller);
    });
  }

  it('仍零引用（**未**翻正，如实保留）：traceFactVersions（声明于 src/memory/conflict-resolution.ts）', () => {
    const refs = refsOf('traceFactVersions', ['src/memory/conflict-resolution.ts']);
    expect(refs, `traceFactVersions 竟被引用：${JSON.stringify(refs)}`).toEqual([]);
  });

  it('反向对照：同样方式查一个**真被调用**的符号，能查到引用（扫描器有辨别力）', () => {
    const refs = refsOf('serializeMemoryBackup', ['src/memory/backup-plan.ts']);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.some((r) => r.file === 'apps/demo/server/memory-routes.ts')).toBe(true);
  });
});

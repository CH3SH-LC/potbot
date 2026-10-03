/**
 * FA-VERIFY-REACH-FINAL · 产品可达性**最终普查**（第五轮复算，HEAD `0529754`）。
 *
 * 判据独立于实现者：这里用的是验证方自己的扫描实现 `reach-scan.ts`，**不复用**任何
 * 实现者的测试、夹具或结论。历史基线由同目录的 CLI 证据工具
 * `_scan-reachability-final.mjs`（另一份独立实现，支持 `FA_SCAN_ROOT` 回放到历史快照）复算：
 * 四个快照都已**逐包逐数复现**，见下方 `PACKAGE_EXPECTATION` 的四列历史值。
 *
 * ## 五轮数字（同一口径，逐轮复算）
 *
 * | 轮次 | 快照 | 总数 | 产品可达 | 不可达 |
 * |---|---|---|---|---|
 * | 第三轮 | `eff0b7a` | 475 | 314 | 161 |
 * | 第四轮 | `df22a09` | 487 | 384 | 103 |
 * | 第五轮 | `8e5bf46` | 488 | 429 | 59 |
 * | 第六轮 | `0529754` | 488 | 434 | 54 |
 * | 本轮   | `e4bb1b7` | 488 | 458 | 30 |
 *
 * ## 本轮（`e4bb1b7`）相较第六轮 `0529754` 的变化（**缺陷闭合 → 探针翻正**）
 *
 * 第六轮在 `0529754` 上把 `documents` / `research` 两组路由与 `src/roles` 翻正后，仍留下两处
 * "只被 barrel 再导出 / 只被 import 而未真正纳入产品闭包"的欠接线；本轮 `wire-*` 系列把它们接进产品：
 *
 * 1. **`src/documents` 的 3 个"仅内核可达"模块翻成产品可达**（`styles/outline.ts`、
 *    `selection/expand.ts`、`charts/facts.ts`）：`documents-routes.ts` 现在真的引用它们，
 *    不可达数 28 → 11。
 * 2. **`src/adapters` 的 7 个"仅测试/仅内核可达"模块**（`clock/reminder-restore.ts` +
 *    `meituan/{compare,candidate-model,candidate-detail,share-intake,handoff-verify,fact-publication}.ts`）
 *    经 `clock/index.ts` / `meituan/index.ts` 纳入产品闭包，不可达数 7 → 0。
 * 3. **`src/roles` 保持整包产品可达**（第六轮已翻正，本轮不回退）。
 *
 * **因此三数**：`488 / 458 / 30`（不可达 54 → 30：documents −17、adapters −7）。
 * 仍不可达的 30 = 17 `src/fake` 脚手架 + 6 `src/documents` 测试助手（fixtures/testing）
 * + 1 `scheduler/test-support` 脚手架 + 6 能力缺口（5 个零引用 barrel + `src/index.ts`）。
 *
 * ## ⚠️ 一条**必须保留**的判据：import-only 接线仍要能被检出
 *
 * 第五轮最有价值的发现是："**只加 import 边、没有派发调用**"会让静态 BFS 把整批模块误判成
 * '产品可达'，而可达性**总数**对此**无感**（import-only 与真派发给出**完全一样**的数字）。
 * 本轮把结论翻正（真派发后数字=真实数字），但**判据本身不能丢**——见 §2.5：
 * 用**真实历史快照** `8e5bf46:apps/demo/server/http.ts` 与**自造反例**双向证明
 * `classifyDispatch` 仍能把 'import-only' 与 'dispatched' 分开。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { classifyDispatch, repoRootOf, scanReachability } from './reach-scan.js';

const ROOT = repoRootOf(fileURLToPath(new URL('.', import.meta.url)));

/** 从历史快照读取仓库内某个文件（只读；用于"判据对真代码咬得动"的反向对照）。 */
function gitShow(spec: string): string {
  return execFileSync('git', ['-C', ROOT, 'show', spec], { encoding: 'utf8' });
}

/** 读取当前 HEAD 的仓库内相对路径文件。 */
function readHead(rel: string): string {
  return gitShow(`HEAD:${rel}`);
}

// ---------------------------------------------------------------------------
// 本文件内置的「期望值」= 本轮复算结果（HEAD 0529754）。
// 任何与实现侧的漂移都会在这里变红，而不是悄悄溜过。
// ---------------------------------------------------------------------------

/**
 * 逐包不可达数：[第三轮 eff0b7a, 第四轮 df22a09, 第五轮 8e5bf46, 第六轮 0529754, 本轮 e4bb1b7]。
 *
 * 本轮相较第六轮的**两处**变化：`src/documents` 28 → 11、`src/adapters` 7 → 0（wire-* 真接线），其余不变。
 */
const PACKAGE_EXPECTATION: ReadonlyArray<
  readonly [string, number, number, number, number, number]
> = [
  ['src/documents', 68, 72, 28, 28, 11], // ← 本轮：3 个"仅内核可达"模块纳入产品闭包
  ['src/adapters', 44, 7, 7, 7, 0], // ← 本轮：7 个"仅测试/仅内核可达"模块整包翻正
  ['src/fake', 17, 17, 17, 17, 17],
  ['src/memory', 16, 0, 0, 0, 0],
  ['src/conversation', 7, 0, 0, 0, 0],
  ['src/roles', 5, 5, 5, 0, 0], // 第六轮翻正：整包产品可达
  ['src/scheduler', 2, 1, 1, 1, 1],
  ['src/spreadsheets', 1, 0, 0, 0, 0],
  ['src', 1, 1, 1, 1, 1], // 顶层零散文件（仅 src/index.ts 一个）
];

/** 仍不可达的**整包**（包内非脚手架模块全部不可达）。 */
const WHOLE_PACKAGE_UNREACHABLE = [
  'src/fake', // 测试脚手架，设计如此
] as const;

/**
 * 第五轮**从不可达变产品可达**、本轮**仍**产品可达的 44 个 `src/documents` 模块（防回退）。
 *
 * ⚠️ 第五轮时这 44 个的"可达"**只**来自 `documents-routes.ts` 那条 import-only 边；
 * 本轮 `documents-routes` 已被真派发（§2.4），故这 44 个的可达性现由**真实分发链**背书。
 * 清单不变，钉死它们是为了防回退。
 */
const FLIPPED_ROUND5_DOCUMENTS = [
  'src/documents/accept-reject.ts',
  'src/documents/equations/index.ts',
  'src/documents/equations/inline-selection.ts',
  'src/documents/equations/inline.ts',
  'src/documents/equations/parse.ts',
  'src/documents/equations/read.ts',
  'src/documents/header-footer-workflow.ts',
  'src/documents/image-workflow.ts',
  'src/documents/operations/drawing/fragment-edit.ts',
  'src/documents/operations/drawing/image.ts',
  'src/documents/operations/drawing/index.ts',
  'src/documents/operations/drawing/media.ts',
  'src/documents/operations/drawing/shape.ts',
  'src/documents/operations/drawing/types.ts',
  'src/documents/operations/table/borders.ts',
  'src/documents/operations/table/cell-format.ts',
  'src/documents/operations/table/content.ts',
  'src/documents/operations/table/edit.ts',
  'src/documents/operations/table/extensions.ts',
  'src/documents/operations/table/grid.ts',
  'src/documents/operations/table/index.ts',
  'src/documents/operations/table/layout.ts',
  'src/documents/operations/table/merge.ts',
  'src/documents/operations/table/size.ts',
  'src/documents/operations/table/table-structure.ts',
  'src/documents/operations/table/types.ts',
  'src/documents/page-workflow.ts',
  'src/documents/reference-audit.ts',
  'src/documents/references/anchors.ts',
  'src/documents/references/bookmarks.ts',
  'src/documents/references/crossref.ts',
  'src/documents/references/fields.ts',
  'src/documents/references/index.ts',
  'src/documents/references/notes.ts',
  'src/documents/review/accept.ts',
  'src/documents/review/comments.ts',
  'src/documents/review/compare.ts',
  'src/documents/review/index.ts',
  'src/documents/review/revisions.ts',
  'src/documents/revisions-export.ts',
  'src/documents/sections/breaks.ts',
  'src/documents/sections/header-footer.ts',
  'src/documents/sections/section-breaks.ts',
  'src/documents/table-workflow.ts',
] as const;

/** 第四轮（df22a09）从「不可达」变「产品可达」的模块（62 个，逐条钉死，防回退）。 */
const BECAME_REACHABLE_ROUND4 = [
  // adapters/calendar（5）
  'src/adapters/calendar/calendars-and-query.ts',
  'src/adapters/calendar/event-model.ts',
  'src/adapters/calendar/event-mutations.ts',
  'src/adapters/calendar/reconcile.ts',
  'src/adapters/calendar/recurrence.ts',
  // adapters/clock（3）
  'src/adapters/clock/alarm-intent.ts',
  'src/adapters/clock/alarm-query.ts',
  'src/adapters/clock/alarm-schedule.ts',
  // adapters/research（29）
  'src/adapters/research/answer-compose.ts',
  'src/adapters/research/answer.ts',
  'src/adapters/research/cache.ts',
  'src/adapters/research/chunk.ts',
  'src/adapters/research/citation-support.ts',
  'src/adapters/research/citation.ts',
  'src/adapters/research/digest.ts',
  'src/adapters/research/extract.ts',
  'src/adapters/research/failure-modes.ts',
  'src/adapters/research/fetch.ts',
  'src/adapters/research/index-store.ts',
  'src/adapters/research/index.ts',
  'src/adapters/research/not-ready.ts',
  'src/adapters/research/parse/docx.ts',
  'src/adapters/research/parse/pdf-filters.ts',
  'src/adapters/research/parse/pdf.ts',
  'src/adapters/research/parse/registry.ts',
  'src/adapters/research/parse/text.ts',
  'src/adapters/research/port-wiring.ts',
  'src/adapters/research/ports.ts',
  'src/adapters/research/privacy.ts',
  'src/adapters/research/private-corpus.ts',
  'src/adapters/research/private-index.ts',
  'src/adapters/research/query-port.ts',
  'src/adapters/research/refresh.ts',
  'src/adapters/research/relevance.ts',
  'src/adapters/research/search.ts',
  'src/adapters/research/tokenize.ts',
  'src/adapters/research/types.ts',
  // conversation（7）
  'src/conversation/decision-bubble.ts',
  'src/conversation/delete-semantics.ts',
  'src/conversation/index.ts',
  'src/conversation/run-constraints.ts',
  'src/conversation/session-model.ts',
  'src/conversation/session-tasks.ts',
  'src/conversation/turn-model.ts',
  // memory（16）
  'src/memory/backup-plan.ts',
  'src/memory/conflict-resolution.ts',
  'src/memory/experience-concurrency.ts',
  'src/memory/experience-merge.ts',
  'src/memory/experience-pipeline.ts',
  'src/memory/experience-rollback.ts',
  'src/memory/experience.ts',
  'src/memory/fact-update.ts',
  'src/memory/forget-cascade.ts',
  'src/memory/index.ts',
  'src/memory/recall-limits.ts',
  'src/memory/recall.ts',
  'src/memory/repository.ts',
  'src/memory/restart.ts',
  'src/memory/typed-scope.ts',
  'src/memory/types.ts',
  // scheduler / spreadsheets（各 1）
  'src/scheduler/capability-registry.ts',
  'src/spreadsheets/facts-binding.ts',
] as const;

/**
 * **本轮**（第五轮 8e5bf46 → HEAD 0529754）从「不可达」变「产品可达」的模块（5 个，全在 `src/roles`）。
 *
 * 这 5 个与 `apps/demo/server/roles-wiring.ts` 的 `ROLES_MODULES_REACHABLE_BY_WIRING`
 * **逐字相同**——实现者自证的清单必须与验证方的扫描结果一致（§2.6 交叉核对）。
 */
const BECAME_REACHABLE_ROLES = [
  'src/roles/index.ts',
  'src/roles/types.ts',
  'src/roles/main-agent.ts',
  'src/roles/group-fork.ts',
  'src/roles/experience-agent.ts',
] as const;

/** 第四轮零引用 barrel 7 个，第五轮起收敛为 6 个（equations 的 barrel 已有人引）。 */
const ZERO_REFERENCE_BARRELS = [
  'src/documents/charts/index.ts',
  'src/documents/proofing/index.ts',
  'src/documents/sections/index.ts',
  'src/documents/selection/index.ts',
  'src/documents/styles/index.ts',
  'src/index.ts',
] as const;

const scan = scanReachability(ROOT);
const byModule = new Map(scan.srcModules.map((r) => [r.module, r]));

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// 0. 扫描器本身先过反向对照（证明它**不是**恒真）
// ===========================================================================

describe('0. 扫描器的辨别力（反向对照，自造最小树）', () => {
  it('自造树：可达 / 传递可达 / 孤儿 三态能分开，且测试引用不算产品引用', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fa-reach-selftest-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, 'apps', 'demo', 'server'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'apps', 'demo', 'server', 'main.ts'),
      "import { a } from '../../../src/a.js';\nexport const x = a;\n",
    );
    writeFileSync(join(dir, 'src', 'a.ts'), "import { b } from './b.js';\nexport const a = b;\n");
    writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 1;\n');
    // 孤儿：无人引用
    writeFileSync(join(dir, 'src', 'orphan.ts'), 'export const o = 1;\n');
    // 只有测试引用：产品够不到
    writeFileSync(join(dir, 'src', 'testonly.ts'), 'export const t = 1;\n');
    writeFileSync(join(dir, 'src', 'testonly.test.ts'), "import { t } from './testonly.js';\nexport const s = t;\n");

    const mini = scanReachability(dir);
    expect(mini.total, '非测试模块 4 个（testonly.test.ts 不算）').toBe(4);
    expect(mini.reachable, 'a 与 b 产品可达').toBe(2);
    expect(mini.unreachable).toBe(2);
    expect(byLabel(mini, 'src/a.ts')).toBe('产品可达');
    expect(byLabel(mini, 'src/b.ts'), '传递可达（经 a）').toBe('产品可达');
    expect(byLabel(mini, 'src/orphan.ts')).toBe('零引用');
    expect(byLabel(mini, 'src/testonly.ts')).toBe('仅测试可达');
  });

  it('反向对照：把 import 边删掉，同一个模块立刻从「可达」变「不可达」', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fa-reach-selftest2-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, 'apps', 'demo', 'server'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'apps', 'demo', 'server', 'main.ts'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    const before = scanReachability(dir);
    expect(byLabel(before, 'src/a.ts'), '无 import 边 ⇒ 零引用').toBe('零引用');
    // 加一条 import 边（等价于"接线"）
    writeFileSync(
      join(dir, 'apps', 'demo', 'server', 'main.ts'),
      "import { a } from '../../../src/a.js';\nexport const x = a;\n",
    );
    const after = scanReachability(dir);
    expect(byLabel(after, 'src/a.ts'), '接线后 ⇒ 产品可达（判据能随实现变红/变绿）').toBe('产品可达');
  });

  function byLabel(res: ReturnType<typeof scanReachability>, module: string): string {
    const row = res.srcModules.find((r) => r.module === module);
    expect(row, `${module} 应在扫描结果中`).toBeDefined();
    return String(row?.label);
  }
});

// ===========================================================================
// 1. 总量（第五轮 488/429/59 的重新复算 → 本轮 488/434/54）
// ===========================================================================

describe('1. 产品可达性总量（第三轮 475/314/161 → 第四轮 487/384/103 → 第五轮 488/429/59 → 第六轮 488/434/54 → 本轮 488/458/30）', () => {
  it('产品入口确实存在（缺席会让整轮普查失去意义）', () => {
    expect(scan.missingProductEntries).toEqual([]);
    expect(scan.productEntriesFound).toEqual(['apps/demo/server/main.ts']);
  });

  it('三数：非测试模块 488 / 产品可达 458 / 不可达 30（第六轮 488/434/54）', () => {
    expect(scan.total).toBe(488);
    expect(scan.reachable).toBe(458);
    expect(scan.unreachable).toBe(30);
    // 总数必须与逐包 total 之和一致（防止"总数对不上逐包"的静默漏扫）
    const sumOfTotals = Object.values(scan.byPackage).reduce((n, b) => n + b.total, 0);
    expect(sumOfTotals).toBe(scan.total);
    // 本轮总数与第六轮**相同**（488）：wire-* 接线都在 apps/** 与既有 barrel，未新增 src 模块
    expect(byModule.get('src/conversation/adapter-to-store.ts')?.product, '第四轮唯一新增模块仍产品可达').toBe(true);
  });

  it('逐包对账（第三轮 → 第四轮 → 第五轮 → 第六轮 → 本轮），并把整包仍不可达者钉死', () => {
    for (const [pkg, r3, r4, r5, r6, now] of PACKAGE_EXPECTATION) {
      const bucket = scan.byPackage[pkg];
      expect(bucket, `${pkg} 应出现在逐包统计中`).toBeDefined();
      expect(
        bucket?.unreachable,
        `${pkg} 不可达数（第三轮 ${String(r3)} → 第四轮 ${String(r4)} → 第五轮 ${String(r5)} → 第六轮 ${String(r6)}）`,
      ).toBe(now);
    }
    for (const pkg of WHOLE_PACKAGE_UNREACHABLE) {
      const modules = scan.srcModules.filter((r) => r.module.startsWith(`${pkg}/`));
      expect(modules.length, `${pkg} 应有模块`).toBeGreaterThan(0);
      expect(
        modules.every((r) => !r.product),
        `${pkg} 整包仍不可达`,
      ).toBe(true);
    }
  });

  it('**第六轮翻正**：src/roles 已**不再**整包不可达 —— 5 个模块全部产品可达（第五轮整包不可达）', () => {
    const roles = scan.srcModules.filter((r) => r.module.startsWith('src/roles/'));
    expect(roles.length).toBe(5);
    expect(roles.filter((r) => !r.product), 'roles 整包产品可达').toEqual([]);
    // 与整包不可达清单互斥：不能同时"整包不可达"又"整包可达"
    expect(WHOLE_PACKAGE_UNREACHABLE.includes('src/roles' as never)).toBe(false);
  });

  it('src/documents 已不再是整包不可达：181 个模块里 170 个产品可达（不可达 11，第六轮为 28）', () => {
    const docs = scan.srcModules.filter((r) => r.module.startsWith('src/documents/'));
    expect(docs.length).toBe(181);
    expect(docs.filter((r) => r.product).length).toBe(170);
    expect(docs.filter((r) => !r.product).length).toBe(11);
    // 与整包不可达清单互斥：不能同时"整包不可达"又"有 170 个可达"
    expect(WHOLE_PACKAGE_UNREACHABLE.includes('src/documents' as never)).toBe(false);
  });

  it('**本轮**：src/adapters 整包翻正 —— 70 个模块全部产品可达（第六轮不可达 7）', () => {
    const adapters = scan.srcModules.filter((r) => r.module.startsWith('src/adapters/'));
    expect(adapters.length).toBe(70);
    expect(adapters.filter((r) => !r.product), 'adapters 整包产品可达').toEqual([]);
  });

  it('第四轮 62 个"由不可达变可达"的模块逐条仍是产品可达（防回退）', () => {
    const notReachable = BECAME_REACHABLE_ROUND4.filter((m) => byModule.get(m)?.product !== true);
    expect(notReachable, '这些模块应产品可达').toEqual([]);
    expect(BECAME_REACHABLE_ROUND4.length).toBe(62);
  });

  it('第五轮 44 个翻转模块逐条仍是产品可达，且每个都有非测试引用者（BFS + 源码双重证据）', () => {
    expect(FLIPPED_ROUND5_DOCUMENTS.length).toBe(44);
    const notReachable = FLIPPED_ROUND5_DOCUMENTS.filter((m) => byModule.get(m)?.product !== true);
    expect(notReachable, '这 44 个应产品可达（删掉 documents-routes 的接线就会整批变红）').toEqual([]);
    const noConsumer = FLIPPED_ROUND5_DOCUMENTS.filter(
      (m) => (byModule.get(m)?.nonTestImporters.length ?? 0) === 0,
    );
    expect(noConsumer, '产品可达的模块必有非测试引用者（产品可达 ≠ 仅测试）').toEqual([]);
  });

  it('**第六轮** 5 个翻转模块（src/roles）逐条产品可达，且都被 roles-wiring.ts 真实引用', () => {
    expect(BECAME_REACHABLE_ROLES.length).toBe(5);
    for (const m of BECAME_REACHABLE_ROLES) {
      const row = byModule.get(m);
      expect(row?.product, `${m} 本轮应产品可达`).toBe(true);
      expect(
        row?.nonTestImporters.includes('apps/demo/server/roles-wiring.ts'),
        `${m} 的非测试引用者里应有 roles-wiring.ts`,
      ).toBe(true);
    }
  });

  it('零引用 barrel 收敛为 6 个（第四轮为 7 个、第三轮为 10 个）', () => {
    expect([...scan.zeroReference].sort()).toEqual([...ZERO_REFERENCE_BARRELS].sort());
  });

  it('barrel 总数仍是 40 个（本轮没有新增 / 删除 barrel）', () => {
    const barrels = scan.srcModules.filter((r) => /(^|\/)index\.[cm]?[jt]sx?$/.test(r.module));
    expect(barrels.length).toBe(40);
  });

  it('40 个 barrel 的四态分布（第六轮翻正）：产品可达 33 / 仅内核可达 0 / 仅测试引用 1 / 零引用 6', () => {
    const barrels = scan.srcModules.filter((r) => /(^|\/)index\.[cm]?[jt]sx?$/.test(r.module));
    const count = (label: string): number => barrels.filter((b) => b.label === label).length;
    expect(count('产品可达')).toBe(33); // 第五轮 32 → 本轮 33（roles/index.ts 翻正）
    expect(count('仅内核可达')).toBe(0); // 第五轮 1（roles/index.ts）→ 本轮 0
    expect(count('仅测试可达')).toBe(1);
    expect(count('零引用')).toBe(6);
    // 第五轮「仅内核可达」的**唯一**一个就是 roles/index.ts，本轮翻成产品可达
    expect(byModule.get('src/roles/index.ts')?.label, 'roles barrel 本轮产品可达').toBe('产品可达');
    // 反向对照：另外两个非"产品可达"的 barrel 仍在，逐条点名
    expect(byModule.get('src/fake/index.ts')?.label, 'fake 仍是仅测试可达').toBe('仅测试可达');
  });

  it('不可达 30 的构成：17 脚手架 + 6 documents 测试助手 + 1 scheduler 脚手架 + 6 能力缺口', () => {
    const unreachable = scan.srcModules.filter((r) => !r.product).map((r) => r.module);
    const fake = unreachable.filter((m) => m.startsWith('src/fake/')).length;
    const schedulerSupport = unreachable.filter((m) => m === 'src/scheduler/test-support.ts').length;
    const docsHelpers = unreachable.filter(
      (m) => m.startsWith('src/documents/') && (/\/fixtures\.ts$/.test(m) || /\/testing\.ts$/.test(m)),
    ).length;
    expect(fake).toBe(17);
    expect(schedulerSupport).toBe(1);
    expect(docsHelpers).toBe(6);
    expect(unreachable.length - fake - schedulerSupport - docsHelpers, '能力缺口').toBe(6);
    // 6 = documents 5（五个零引用 barrel）+ adapters 0 + src/index.ts 1（第六轮还含 adapters 7）
    const gap = (prefix: string): number =>
      unreachable.filter(
        (m) => m.startsWith(prefix) && !/\/fixtures\.ts$/.test(m) && !/\/testing\.ts$/.test(m),
      ).length;
    expect(gap('src/documents/')).toBe(5);
    expect(gap('src/adapters/'), 'adapters 已无能力缺口').toBe(0);
    expect(gap('src/roles/'), 'roles 已无能力缺口').toBe(0);
    expect(unreachable.includes('src/index.ts')).toBe(true);
    expect(
      gap('src/documents/') + gap('src/adapters/') + gap('src/roles/') + (unreachable.includes('src/index.ts') ? 1 : 0),
    ).toBe(6);
  });

  it('整包仍不可达清单：src/fake（17）+ 11 documents 零散 + src/index.ts + scheduler/test-support（roles / adapters 已移出）', () => {
    const unreachable = scan.srcModules.filter((r) => !r.product).map((r) => r.module);
    expect(unreachable.length).toBe(30);
    expect(unreachable.filter((m) => m.startsWith('src/roles/')).length, 'roles 已无不可达模块').toBe(0);
    expect(unreachable.filter((m) => m.startsWith('src/adapters/')).length, 'adapters 本轮整包翻正，已无不可达模块').toBe(0);
    expect(unreachable.filter((m) => m.startsWith('src/fake/')).length).toBe(17);
    expect(unreachable).toContain('src/index.ts');
    expect(unreachable).toContain('src/scheduler/test-support.ts');
    // 非 src/fake 的不可达 = 30 - 17(fake) = 13（11 documents + src/index.ts + scheduler/test-support）
    expect(unreachable.length - 17).toBe(13);
  });
});

// ===========================================================================
// 2. 接线波的"真接线"核对（可达 != 真用；本轮把钩子翻正）
// ===========================================================================

describe('2. 装配层的真伪：可达不等于被用', () => {
  it('src/roles 现由 roles-wiring.ts 真接线：5 个模块产品可达，roles-wiring.ts 是它们的非测试引用者', () => {
    const row = byModule.get('apps/demo/server/roles-wiring.ts');
    expect(row, 'roles-wiring.ts 是 apps/** 文件，不在 src 普查面').toBeUndefined();
    for (const m of BECAME_REACHABLE_ROLES) {
      expect(byModule.get(m)?.product, `${m} 产品可达`).toBe(true);
    }
    // 第五轮 roles 唯一的包外引用者是 experience-wiring.ts（自身也不在闭包内）；
    // 本轮 roles-wiring.ts 把它真正接进了产品 HTTP 闭包。
    const idx = byModule.get('src/roles/index.ts');
    expect(idx?.nonTestImporters).toContain('apps/demo/server/roles-wiring.ts');
    expect(idx?.nonTestImporters).toContain('apps/demo/server/experience-wiring.ts');
  });

  it('src/conversation 全包"可达"，但产品唯一入口只用到 2 个模块的符号（其余靠 barrel re-export 蹭到）', async () => {
    const { readFileSync } = await import('node:fs');
    const loop = readFileSync(join(ROOT, 'apps/demo/server/conversation-loop.ts'), 'utf8');
    // 产品侧对 src/conversation 的**唯一** import 说明符
    const specs = [...loop.matchAll(/from '([^']*conversation[^']*)'/g)].map((m) => m[1]);
    expect(specs, '只应经 barrel').toEqual(['../../../src/conversation/index.js']);
    // barrel 里的 session-model（会话持久化模型）符号在产品侧一个都没用到
    expect(loop.includes('createConversationSessions')).toBe(false);
    expect(loop.includes('CONVERSATION_SESSION_SCHEMA')).toBe(false);
    expect(loop.includes('ConversationSessions')).toBe(false);
    // 真正用到的只有 turn-model / run-constraints 的符号
    expect(loop.includes('TurnModel')).toBe(true);
    expect(loop.includes('RunConstraintBoard')).toBe(true);
  });

  it(
    'barrel 的 re-export 会把"只被 re-export"的模块也算作可达 —— 这是本口径的已知夸大',
    () => {
      // 反证：同一快照两次扫描必须一致（确定性），且该夸大确实存在。
      // 注意：这里刻意**再跑一遍全仓扫描**（不是复用顶部 `scan`），该扫描 ~3s，
      // 故将默认 5s 超时放宽到 30s——这只是运行成本，未放宽任何断言/判别力。
      const again = scanReachability(ROOT);
      expect(again.total).toBe(scan.total);
      expect(byModule.get('src/conversation/session-model.ts')?.product).toBe(true);
    },
    30_000,
  );

  it('§2.4 翻正：documents / research 两组路由**已派发**（不再 import-only），http.ts 里 handler 名各出现 ≥ 2 次', () => {
    const http = readHead('apps/demo/server/http.ts');
    // (a) 三处 import 边仍在（把两组路由拉进 main.ts 的静态闭包）
    expect(http.includes("from './documents-routes.js'")).toBe(true);
    expect(http.includes("from './research-routes.js'")).toBe(true);
    expect(readHead('apps/demo/server/main.ts').includes("from './documents-routes.js'")).toBe(true);
    expect(readHead('apps/demo/server/route-wiring.ts').includes("from './documents-routes.js'")).toBe(true);
    // (b) 关键翻正：**已经调用**。第五轮此处各计数为 1（只有 import），本轮 ≥ 2（import + 调用）。
    const countOf = (needle: string): number => http.split(needle).length - 1;
    expect(
      countOf('handleDocumentsRequest'),
      'http.ts 已调用 handleDocumentsRequest（import + 调用 ⇒ 计数 ≥ 2）',
    ).toBeGreaterThanOrEqual(2);
    expect(
      countOf('handleResearchRequest'),
      'http.ts 已调用 handleResearchRequest（同上）',
    ).toBeGreaterThanOrEqual(2);
    // 真服务实测状态码由 wiring-mount.test.ts 取证（200）
    // (c) 44 个模块的**唯一**非测试消费者仍是该路由模块（可达路径不变，只是现在被真调用）
    const tableWorkflow = byModule.get('src/documents/table-workflow.ts');
    expect(tableWorkflow?.product).toBe(true);
    expect(tableWorkflow?.nonTestImporters).toEqual(['apps/demo/server/documents-routes.ts']);
  });

  it('§2.5 保留判据：import-only 与 dispatched 必须分得开（自造反例）', () => {
    const onlyImport =
      "import { handleDocumentsRequest } from './documents-routes.js';\nexport const x = 1;\n";
    const verdictImportOnly = classifyDispatch(onlyImport, 'handleDocumentsRequest', 'documents-routes');
    expect(verdictImportOnly.imported).toBe(true);
    expect(verdictImportOnly.occurrences).toBe(1);
    expect(verdictImportOnly.kind, '只 import 不调用 ⇒ import-only').toBe('import-only');

    const withCall =
      onlyImport + 'export const y = async (a) => handleDocumentsRequest(a);\n';
    const verdictDispatched = classifyDispatch(withCall, 'handleDocumentsRequest', 'documents-routes');
    expect(verdictDispatched.occurrences).toBeGreaterThanOrEqual(2);
    expect(verdictDispatched.kind, 'import + 调用 ⇒ dispatched').toBe('dispatched');

    // 反向对照：既不 import 也不出现的 handler ⇒ absent（判据不是恒 true）
    expect(classifyDispatch('export const z = 1;\n', 'handleDocumentsRequest', 'documents-routes').kind).toBe(
      'absent',
    );
    // 词边界：createRolesWiring 里的子串**不**能冒充 rolesWiring
    expect(classifyDispatch("import type { createRolesWiring } from './roles-wiring.js';\n", 'rolesWiring', 'roles-wiring').occurrences).toBe(0);
  });

  it('§2.5 保留判据对**真实历史快照** `8e5bf46:http.ts` 咬得动：把 documents / research 判成 import-only', () => {
    const before = gitShow('8e5bf46:apps/demo/server/http.ts');
    const docsBefore = classifyDispatch(before, 'handleDocumentsRequest', 'documents-routes');
    const researchBefore = classifyDispatch(before, 'handleResearchRequest', 'research-routes');
    expect(docsBefore.kind, '第五轮快照：documents 是 import-only').toBe('import-only');
    expect(researchBefore.kind, '第五轮快照：research 是 import-only').toBe('import-only');
    // 同一快照里**真挂载**的兄弟（memory）判成 dispatched —— 证明判据不是全判 import-only
    expect(classifyDispatch(before, 'handleMemoryRequest', 'memory-routes').kind).toBe('dispatched');
    // 反向对照：HEAD 上同一判据判成 dispatched（翻正的方向也能被同一函数看见）
    const now = readHead('apps/demo/server/http.ts');
    expect(classifyDispatch(now, 'handleDocumentsRequest', 'documents-routes').kind).toBe('dispatched');
    expect(classifyDispatch(now, 'handleResearchRequest', 'research-routes').kind).toBe('dispatched');
    expect(classifyDispatch(now, 'rolesWiring', 'roles-wiring').kind).toBe('dispatched');
  });

  it('§2.6 交叉核对：roles-wiring.ts 自证的 ROLES_MODULES_REACHABLE_BY_WIRING 与扫描结果逐字一致', async () => {
    const { readFileSync } = await import('node:fs');
    const wiring = readFileSync(join(ROOT, 'apps/demo/server/roles-wiring.ts'), 'utf8');
    const claimed = [...wiring.matchAll(/'((?:src|apps)\/[A-Za-z0-9_./-]+\.ts)'/g)]
      .map((m) => m[1])
      .filter((p): p is string => typeof p === 'string');
    const rolesClaimed = [...new Set(claimed.filter((p) => p.startsWith('src/roles/')))].sort();
    expect(rolesClaimed).toEqual([...BECAME_REACHABLE_ROLES].sort());
    // 且这些声明必须与真扫描一致（不能只在注释里"声明"）
    for (const m of rolesClaimed) {
      expect(byModule.get(m)?.product, `${m} 实现者声明可达，扫描必须同意`).toBe(true);
    }
  });
});

// ===========================================================================
// 3. 仍不可达模块的"缺哪一步"事实核对
// ===========================================================================

describe('3. 仍不可达者的"缺哪一步"事实核对', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['src/documents/styles/index.ts', '零引用：连测试都不 import，产品更无路径'],
    ['src/documents/charts/index.ts', '零引用'],
    ['src/documents/proofing/index.ts', '零引用'],
    ['src/documents/sections/index.ts', '零引用'],
    ['src/documents/selection/index.ts', '零引用'],
    ['src/documents/operations/table/fixtures.ts', '仅测试可达：产品与内核代码都不 import（测试夹具）'],
    ['src/documents/model/fixtures.ts', '仅测试可达：测试夹具'],
    ['src/scheduler/test-support.ts', '测试脚手架，设计如此'],
    ['src/index.ts', '零引用（内核"包入口"无人 import）'],
  ];

  it.each(cases)('%s 的不可达归因成立', (module, why) => {
    const row = byModule.get(module);
    expect(row, `${module} 应在普查面内`).toBeDefined();
    expect(row?.product, `${module}（${why}）应不可达`).toBe(false);
    if (why.startsWith('零引用')) {
      expect(row?.label).toBe('零引用');
      expect(row?.nonTestImporters.length).toBe(0);
      expect(row?.testImporters.length).toBe(0);
    }
  });

  /**
   * **本轮（e4bb1b7）翻正**：第六轮仍被点名"不可达"的 10 个模块，已由 `wire-*` 接线纳入产品闭包。
   *
   * 判别力：每条断言 `product === true` 且点名的非测试引用者确在 `nonTestImporters` 里。
   * 若有人回退这些接线（删掉 `documents-routes.ts` 对三模块的引用、或 `clock/index.ts` /
   * `meituan/index.ts` 对 7 个叶子模块的再导出），对应条目会**立刻重新变红**。
   */
  const flipped: ReadonlyArray<readonly [string, string]> = [
    ['src/documents/styles/outline.ts', 'apps/demo/server/documents-routes.ts'],
    ['src/documents/selection/expand.ts', 'apps/demo/server/documents-routes.ts'],
    ['src/documents/charts/facts.ts', 'apps/demo/server/documents-routes.ts'],
    ['src/adapters/clock/reminder-restore.ts', 'src/adapters/clock/index.ts'],
    ['src/adapters/meituan/compare.ts', 'src/adapters/meituan/index.ts'],
    ['src/adapters/meituan/candidate-model.ts', 'src/adapters/meituan/index.ts'],
    ['src/adapters/meituan/candidate-detail.ts', 'src/adapters/meituan/index.ts'],
    ['src/adapters/meituan/share-intake.ts', 'src/adapters/meituan/index.ts'],
    ['src/adapters/meituan/handoff-verify.ts', 'src/adapters/meituan/index.ts'],
    ['src/adapters/meituan/fact-publication.ts', 'src/adapters/meituan/index.ts'],
  ];

  it.each(flipped)('%s 本轮已由 %s 纳入产品闭包（缺陷闭合，防回退）', (module, importer) => {
    const row = byModule.get(module);
    expect(row, `${module} 应在普查面内`).toBeDefined();
    expect(row?.product, `${module} 本轮应产品可达`).toBe(true);
    expect(row?.label, `${module} 应为产品可达`).toBe('产品可达');
    expect(
      row?.nonTestImporters.includes(importer),
      `${module} 的非测试引用者里应有 ${importer}`,
    ).toBe(true);
  });

  it('反向对照：第五轮曾被列为"仅内核可达"的 src/roles/main-agent.ts 第六轮已可达（钩子已翻正）', () => {
    const row = byModule.get('src/roles/main-agent.ts');
    expect(row?.product, 'main-agent 现产品可达').toBe(true);
    expect(row?.label).toBe('产品可达');
  });

  it('documents 包内不可达的 11 个里，脚手架占 6（fixtures/testing），能力缺口 5', () => {
    const docsUnreachable = scan.srcModules
      .filter((r) => !r.product && r.module.startsWith('src/documents/'))
      .map((r) => r.module);
    expect(docsUnreachable.length).toBe(11);
    const scaffold = docsUnreachable.filter(
      (m) => /\/fixtures\.ts$/.test(m) || /\/testing\.ts$/.test(m),
    );
    expect(scaffold.length).toBe(6);
    const gaps = docsUnreachable
      .filter((m) => !/\/fixtures\.ts$/.test(m) && !/\/testing\.ts$/.test(m))
      .sort();
    expect(gaps.length).toBe(5);
    // 这 5 个能力缺口与"零引用 barrel"清单里的 documents 项**逐字一致**（防回退）
    expect(gaps).toEqual(
      ZERO_REFERENCE_BARRELS.filter((b) => b.startsWith('src/documents/')).sort(),
    );
  });
});

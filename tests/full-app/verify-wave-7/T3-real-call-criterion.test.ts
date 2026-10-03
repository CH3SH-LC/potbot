/**
 * FA-VERIFY-WAVE-7 · §3 "真调用"判据：对 ≥20 个模块逐个判 (a)/(b)/(c)。
 *
 * 判据（验证方自写，见 `reach-scan.ts`）：
 * - **(a) 真用**：存在**非测试**消费者 C，C 在 import 闭包 A 内，且 C 在**值位置按名使用**了
 *   一个**由该模块声明**的符号（经 barrel 穿透后归属到声明模块）。
 * - **(b) 只 import**：模块在 A 内，但没有这样的消费者。**(b) 一律具名给出**。
 * - **(c) 未引用**：模块不在 A 内（没有任何产品侧相对 import 边进入）。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { describe, expect, it, beforeAll } from 'vitest';

import { scanRepo, type ScanResult } from './reach-scan.js';

let scan: ScanResult;
beforeAll(() => {
  scan = scanRepo(process.cwd());
}, 120_000);

/** 抽样：覆盖第五轮点名过的目录 + 本轮新接线的目录，共 26 条（>20）。 */
const SAMPLE: readonly string[] = [
  // —— 第五轮判为 (b) 的老名单（看是否仍成立） ——
  'src/adapters/calendar/event-model.ts',
  'src/adapters/calendar/reconcile.ts',
  'src/adapters/clock/alarm-intent.ts',
  'src/adapters/clock/alarm-schedule.ts',
  'src/conversation/decision-bubble.ts',
  'src/conversation/session-tasks.ts',
  'src/memory/conflict-resolution.ts',
  'src/memory/typed-scope.ts',
  'src/scheduler/checkpoint.ts',
  'src/scheduler/capability-registry.ts',
  'src/scheduler/worker-loop.ts',
  'src/scheduler/fair-scheduler.ts',
  'src/presentations/shapes.ts',
  'src/spreadsheets/sort-filter.ts',
  'src/spreadsheets/xls-io.ts',
  'src/session/adapters/research-citations.ts',
  // —— 第五轮判为 (a) 的对照（应仍为 a） ——
  'src/memory/backup-plan.ts',
  'src/memory/repository.ts',
  'src/memory/experience.ts',
  'src/conversation/turn-model.ts',
  // —— 本批新接线（研究 / 文档子树 / 角色 / 表格事实） ——
  'src/adapters/research/citation.ts',
  'src/adapters/research/private-corpus.ts',
  'src/documents/operations/table/merge.ts',
  'src/spreadsheets/facts-binding.ts',
  'src/roles/main-agent.ts',
  'src/documents/model/document.ts',
];

interface Verdict {
  readonly rel: string;
  readonly kind: 'a' | 'b' | 'c';
  readonly evidence: string;
}

function judge(rel: string): Verdict {
  const kind = scan.classifyStrict(rel) === 'b' ? 'b' : scan.classifyStrict(rel) === 'c' ? 'c' : 'a';
  const used = scan.usedSymbols.get(rel);
  const liveUsers = [...(used?.entries() ?? [])]
    .filter(([consumer]) => scan.importClosure.has(consumer))
    .map(([consumer, names]) => `${consumer}(${[...names].slice(0, 3).join('+')})`);
  if (kind === 'a' && liveUsers.length > 0) {
    return { rel, kind, evidence: liveUsers.slice(0, 2).join(' ; ') };
  }
  const consumers = [...(scan.directConsumers.get(rel) ?? [])].filter((c) => !c.endsWith('.test.ts'));
  return {
    rel,
    kind,
    evidence: consumers.length === 0 ? '无任何非测试消费者' : `仅被 import/再导出: ${consumers.slice(0, 3).join(', ')}`,
  };
}

describe('§3.1 抽样判定（26 个模块，具名给出 (b)）', () => {
  it('每个模块给出 (a)/(b)/(c) 之一 + 证据', () => {
    const verdicts = SAMPLE.map(judge);
    // eslint-disable-next-line no-console
    console.log('W7 real-call verdicts:');
    for (const v of verdicts) {
      // eslint-disable-next-line no-console
      console.log(`  [${v.kind}] ${v.rel}  ⇐ ${v.evidence}`);
    }
    const bs = verdicts.filter((v) => v.kind === 'b').map((v) => v.rel);
    // eslint-disable-next-line no-console
    console.log('W7 (b) 具名:', bs.join(' | '));
    expect(verdicts).toHaveLength(SAMPLE.length);
    expect(verdicts.every((v) => ['a', 'b', 'c'].includes(v.kind))).toBe(true);
  });

  it('(a) 类的证据是**具体的 消费者 + 符号名**，不是一句"可达"', () => {
    const aOnly = SAMPLE.map(judge).filter((v) => v.kind === 'a');
    expect(aOnly.length).toBeGreaterThan(0);
    for (const v of aOnly) {
      expect(v.evidence).toMatch(/\.ts\(.+\)/);
    }
  });

  it('第五轮的 (b) 老名单里仍有相当一部分**至今仍是 (b)**（问题未被修完）', () => {
    const oldB = SAMPLE.slice(0, 16).map(judge).filter((v) => v.kind === 'b');
    // eslint-disable-next-line no-console
    console.log('W7 老名单仍为 (b):', oldB.map((v) => v.rel).join(' | '));
    expect(oldB.length).toBeGreaterThanOrEqual(8);
  });

  it('反向对照：不存在的模块判为 (c)', () => {
    expect(judge('src/scheduler/never-existed.ts').kind).toBe('c');
  });
});

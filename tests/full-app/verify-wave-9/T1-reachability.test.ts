/**
 * FA-VERIFY-WAVE-9 · 任务第 2 项 —— 用**验证方自写扫描器**复算产品可达性三数，
 * 与历史快照（475/314/161 → 488/458/30）对比，并逐包列出仍不可达者。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { describe, expect, it } from 'vitest';

import { classifyUnreachable, scanReachability } from './reach-scan.js';

// 支持用 `FA_SCAN_ROOT` 指向历史快照（`git archive <rev> | tar -x`）复算同一口径。
const ROOT = process.env['FA_SCAN_ROOT'] ?? process.cwd();

function countByDir(mods: readonly string[], depth: 3): Map<string, number> {
  const map = new Map<string, number>();
  for (const m of mods) {
    const parts = m.split('/');
    const key = parts.slice(0, depth).join('/');
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

describe('FA-VERIFY-WAVE-9 · 产品可达性复算（自有扫描器）', () => {
  const result = scanReachability(ROOT, 'apps/demo/server/main.ts');

  it('入口解析成功（防"入口不存在导致全不可达"的假绿）', () => {
    expect(result.entryResolved).toBe(true);
  });

  it('三数（总数 / 产品可达 / 不可达）打印 + 与历史快照同量级', () => {
    // eslint-disable-next-line no-console
    console.log(
      `[WAVE9 REACH] total=${String(result.total.length)} ` +
        `reachable=${String(result.reachable.length)} unreachable=${String(result.unreachable.length)}`,
    );
    // 历史快照：475/314/161（round-3 @eff0b7a）→ 488/458/30（本轮之前）
    expect(result.total.length).toBeGreaterThanOrEqual(480);
    expect(result.reachable.length).toBeGreaterThan(440);
  });

  it('逐包列出仍不可达（区分脚手架 vs 真缺口）', () => {
    const byDir = countByDir(result.unreachable, 3);
    const rows: string[] = [];
    for (const [dir, n] of [...byDir].sort()) rows.push(`${dir}=${String(n)}`);
    // eslint-disable-next-line no-console
    console.log(`[WAVE9 UNREACHABLE BY DIR] ${rows.join(' | ')}`);

    const items = result.unreachable.map((m) => `${classifyUnreachable(ROOT, m)}  ${m}`);
    // eslint-disable-next-line no-console
    console.log(`[WAVE9 UNREACHABLE LIST]\n${items.join('\n')}`);

    const scaffolding = result.unreachable.filter((m) => classifyUnreachable(ROOT, m) === 'scaffolding');
    const gaps = result.unreachable.filter((m) => classifyUnreachable(ROOT, m) === 'gap');
    // eslint-disable-next-line no-console
    console.log(
      `[WAVE9 UNREACHABLE SPLIT] scaffolding=${String(scaffolding.length)} gaps=${String(gaps.length)}`,
    );
    for (const m of gaps) {
      const referrers = result.inNonTest.get(m) ?? [];
      // eslint-disable-next-line no-console
      console.log(`[WAVE9 GAP REFERRERS] ${m} <- non-test referrers: ${JSON.stringify(referrers)}`);
    }
    expect(scaffolding.length + gaps.length).toBe(result.unreachable.length);
  });
});

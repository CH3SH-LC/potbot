/**
 * FA-A-E2E —— 执行台账的数据质量校验。
 *
 * 保护的是"判据先行"这件事本身：台账不能自称覆盖了不存在的东西，也不能有项既没落点
 * 又没说为什么跳过。全部为**纯数据断言**，不 import 产品实现。
 */
import { describe, expect, it } from 'vitest';

import { A_ITEM_LEDGER, A_ITEM_MODES, EXPECTED_A_IDS, type AItemLedgerEntry } from './a-items.js';
import { coverageSummary } from './index.js';

function validate(entry: AItemLedgerEntry): string[] {
  const problems: string[] = [];
  if (entry.scenario.trim().length === 0) problems.push('scenario 为空');
  if (entry.pass_condition.trim().length === 0) problems.push('pass_condition 为空');
  if (entry.honesty.trim().length === 0) problems.push('honesty 为空（必须写明未证明的边界）');
  if (!A_ITEM_MODES.includes(entry.mode)) problems.push(`未知 mode：${entry.mode}`);
  if ((entry.mode === 'real' || entry.mode === 'partial') && entry.covered_by.length === 0) {
    problems.push(`${entry.mode} 必须有 covered_by 落点`);
  }
  if ((entry.mode === 'skip' || entry.mode === 'partial') && entry.skipped_part.length === 0) {
    problems.push(`${entry.mode} 必须有 skipped_part 及跳过原因`);
  }
  for (const ref of entry.covered_by) {
    if (!/\.test\.ts#/.test(ref)) problems.push(`covered_by 未指向 test 落点：${ref}`);
  }
  for (const reason of entry.skipped_part) {
    if (reason.trim().length === 0) problems.push('skipped_part 含空原因');
  }
  return problems;
}

describe('A 项执行台账', () => {
  it('id 恰好是 A01–A19，无缺项、无重复', () => {
    const ids = A_ITEM_LEDGER.map((entry) => entry.id);
    expect(new Set(ids).size, '出现重复 id').toBe(ids.length);
    expect([...ids].sort()).toEqual([...EXPECTED_A_IDS].sort());
  });

  it('每项形状完整：mode 合法，real/partial 有落点，skip/partial 写明跳过原因', () => {
    for (const entry of A_ITEM_LEDGER) {
      const problems = validate(entry);
      expect(problems, `${entry.id}：${problems.join('；')}`).toEqual([]);
    }
  });

  it('全部 19 项都有归宿；至少 10 项真跑，至少 4 项纯跳过', () => {
    const exercised = A_ITEM_LEDGER.filter((entry) => entry.mode === 'real' || entry.mode === 'partial');
    const pureSkip = A_ITEM_LEDGER.filter((entry) => entry.mode === 'skip');
    expect(exercised.length + pureSkip.length).toBe(A_ITEM_LEDGER.length);
    expect(exercised.length).toBeGreaterThanOrEqual(10);
    expect(pureSkip.length).toBeGreaterThanOrEqual(4);
  });

  it('coverageSummary() 与台账一致（index.ts 的复算出口可用）', () => {
    const summary = coverageSummary();
    expect(summary.total).toBe(A_ITEM_LEDGER.length);
    expect(summary.by_mode.real + summary.by_mode.partial + summary.by_mode.skip).toBe(summary.total);
    expect(summary.exercised).toEqual(
      A_ITEM_LEDGER.filter((entry) => entry.mode === 'real' || entry.mode === 'partial').map((entry) => entry.id),
    );
    expect(summary.with_explicit_skip).toEqual(
      A_ITEM_LEDGER.filter((entry) => entry.mode === 'skip' || entry.mode === 'partial').map((entry) => entry.id),
    );
  });

  it('每个 covered_by 落点都指向本目录下真实存在的用例文件', async () => {
    const { readdirSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const present = new Set(readdirSync(here));
    for (const entry of A_ITEM_LEDGER) {
      for (const ref of entry.covered_by) {
        const file = ref.split('#')[0] ?? '';
        expect(present.has(file), `${entry.id} 指向不存在的用例文件：${file}`).toBe(true);
      }
    }
  });
});

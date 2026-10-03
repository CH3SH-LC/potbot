/**
 * FA-A-E2E —— 跨模板端到端验收套件（A01–A19）的统一出口与说明。
 *
 * ## 这个目录是什么
 * 把能力目录 §9 的跨模板链路写成**可执行、可复算**的用例：能真跑的读真实模块、产真实字节
 * 并读回；不能真跑的（真机 / 消费端 / 外部账号 / 未接入的适配器）一律用显式 `skip` +
 * 原因，**不用假数据冒充端到端通过**。
 *
 * ## 用例文件
 * | 文件 | 覆盖 | 需求簇 |
 * |---|---|---|
 * | `a01-formats-same-version.test.ts` | A01 / A13 / A10（重载） | 1. 三格式同版 |
 * | `a07-cascade.test.ts` | A07 / A08 / A09 / A13 / A16 | 2. 人数 8→10 连锁 |
 * | `a11-fidelity.test.ts` | A11 / A12 / A13 / A14 / A19 | 3. 失败/未知保真 |
 * | `a17-a18-plugin-platform.test.ts` | A06 / A17 / A18 | 4. 模板安装/停用/更新/回滚 + 撤权 |
 * | `a10-memory-lifecycle.test.ts` | A10 / A15 / A17 | 5. 释放实例、经验、忘记、跨用户 |
 * | `a-items.test.ts` | 台账自检 | 执行台账的数据质量 |
 *
 * ## 运行
 * ```bash
 * npx --no-install vitest run tests/full-app/e2e/
 * ```
 *
 * ## 诚实边界（引用前必读）
 * - 本套件证明的是**模型层/内核层**的真实行为，**不等于真机与消费端**已验收；
 * - 每项的真实/跳过状态见 `A_ITEM_LEDGER`（`a-items.ts`），`honesty` 字段写明未被证明的边界；
 * - 交付说明须标注：**子智能体模型身份未确认为 DS**。
 */

export {
  A_ITEM_LEDGER,
  A_ITEM_MODES,
  EXPECTED_A_IDS,
  type AItemLedgerEntry,
  type AItemMode,
} from './a-items.js';

import { A_ITEM_LEDGER, type AItemMode } from './a-items.js';

export interface CoverageSummary {
  readonly total: number;
  readonly by_mode: Readonly<Record<AItemMode, number>>;
  /** 真跑（real + partial）的项 id。 */
  readonly exercised: readonly string[];
  /** 含显式跳过的项 id（skip + partial）。 */
  readonly with_explicit_skip: readonly string[];
}

/** 从台账算出的覆盖摘要（纯计算，便于在报告里复算）。 */
export function coverageSummary(): CoverageSummary {
  const byMode: Record<AItemMode, number> = { real: 0, partial: 0, skip: 0 };
  const exercised: string[] = [];
  const withSkip: string[] = [];
  for (const entry of A_ITEM_LEDGER) {
    byMode[entry.mode] += 1;
    if (entry.mode === 'real' || entry.mode === 'partial') exercised.push(entry.id);
    if (entry.mode === 'skip' || entry.mode === 'partial') withSkip.push(entry.id);
  }
  return Object.freeze({
    total: A_ITEM_LEDGER.length,
    by_mode: Object.freeze(byMode),
    exercised: Object.freeze(exercised),
    with_explicit_skip: Object.freeze(withSkip),
  });
}

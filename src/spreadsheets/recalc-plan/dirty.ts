/**
 * 表格域：重算计划（X04）的**脏单元格传播**与**按需重算顺序**。
 *
 * ## 一句话口径
 *
 * 改了一个格子之后，**需要重算的**是「它自己（若是公式格）+ 所有**传递地**读它的公式格」，
 * 一个不多、一个不少。多算 = 白算（手机上白算就是卡顿），少算 = 结果陈旧（更糟）。
 *
 * ## 为什么反向边不能只看公式格之间
 *
 * 脏传播的**种子**通常是**数据格**（用户改了 `A1` 的值）。数据格不是依赖图的节点，
 * 也就没有任何"公式格 → 数据格"的反向边可查。因此本模块不查反向边，而是拿
 * **原始引用目标**去比区间：`A1` 落在某个公式格的 `SUM(A1:A9)` 里，那个公式格就脏了。
 * 见 {@link targetCovers}。这条路径让"改数据格"和"改公式格的公式"用同一个入口。
 *
 * ## 环与无法解析的公式：**不漏算，也不静默算**
 *
 * - 环成员（{@link RecalcPlan.cycles}）永远**不进** `order`——它们无法算出数值，
 *   把它们当成"重算一遍就好了"就是**伪造结果**；
 * - 语法过不去的公式格（{@link RecalcPlan.unresolved}）同样不进 `order`；
 * - 两者都在批次里**显式列出**（`blocked` / `unresolved`），不静默丢弃；
 * - 依赖它们的格子照常排进 `order`，但被标成 `tainted`（结果不可信，因为输入是坏的）。
 *
 * 需要"要么给我一个干净的顺序，要么直接报错"时用 {@link requireRecalcOrder}。
 *
 * ## 不会死循环
 *
 * 传播用 `dirty` 集合做访问标记，每个公式格最多入队一次。**有环的图同样终止**——
 * 这是"环不得导致死循环"的实际落点（环在这里只是一批永不入 `order` 的节点）。
 */

import { ValidationError } from '../../protocol/index.js';
import type { CycleReport } from './cycles.js';
import { parseCellKey, type CellKey } from './keys.js';
import { targetCovers, type DependencyTarget, type RecalcPlan } from './graph.js';

/** 一批按需重算的结果。 */
export interface RecalcBatch {
  /** 归一化、去重、字典序的种子（触发这次重算的改动格）。 */
  readonly seeds: readonly CellKey[];
  /** 种子里**不是公式格**的那些（改动的是数据 ⇒ 它们自己没有公式要算）。 */
  readonly dataSeeds: readonly CellKey[];
  /** 需要重算的公式格，依赖在前（不含环成员与无法解析的格）。 */
  readonly order: readonly CellKey[];
  /** 落在脏区里的**环成员**（明确报错的对象；这些格子不产出数值）。 */
  readonly blocked: readonly CellKey[];
  /** 落在脏区里的**无法解析**公式格（保留原文并阻塞）。 */
  readonly unresolved: readonly CellKey[];
  /** 脏区里依赖了 `blocked` / `unresolved` 的格子：可以算，但结果不可信。 */
  readonly tainted: readonly CellKey[];
}

/** 循环引用导致的失败。携带完整环清单，便于上层报出"哪几个格子绕在一起"。 */
export class CircularReferenceError extends Error {
  /** 与本次操作相关的环（可能不止一个）。 */
  readonly cycles: readonly CycleReport[];

  constructor(cycles: readonly CycleReport[]) {
    const summary = cycles
      .map((cycle) => `${cycle.members.join(' ↔ ')}（${cycle.kind === 'explicit' ? '显式' : '交叉'}循环）`)
      .join('；');
    super(`重算范围内存在循环引用：${summary}`);
    this.name = 'CircularReferenceError';
    this.cycles = cycles;
  }
}

function normalizeSeeds(seeds: readonly CellKey[]): readonly CellKey[] {
  if (!Array.isArray(seeds)) {
    throw new ValidationError('dirtyClosure 的 seeds 必须是数组');
  }
  const unique = new Set<CellKey>();
  for (const seed of seeds) {
    if (typeof seed !== 'string') {
      throw new ValidationError('dirtyClosure 的种子必须是字符串单元格键（"表名!A1"）');
    }
    const parsed = parseCellKey(seed); // 形状不对 ⇒ ValidationError
    unique.add(`${parsed.sheet}!${parsed.ref}`);
  }
  return Object.freeze([...unique].sort((a, b) => a.localeCompare(b)));
}

/**
 * 从 `seeds` 出发、沿"引用覆盖"可达的全部公式格（含 `seeds` 里本身是公式格的项）。
 *
 * 迭代到不动点；`dirty` 集合保证每个公式格最多入队一次 ⇒ 有环也**必然终止**。
 */
function coverageClosure(plan: RecalcPlan, seeds: readonly CellKey[]): ReadonlySet<CellKey> {
  const formulaKeys = new Set(plan.keys);
  const dirty = new Set<CellKey>();
  const covered = new Map<CellKey, readonly DependencyTarget[]>();
  for (const key of plan.keys) {
    covered.set(key, plan.targets.get(key) ?? Object.freeze([]));
  }

  for (const seed of seeds) {
    if (formulaKeys.has(seed)) {
      dirty.add(seed);
    }
  }

  let frontier: readonly CellKey[] = seeds;
  while (frontier.length > 0) {
    const next: CellKey[] = [];
    for (const seed of frontier) {
      const parsed = parseCellKey(seed);
      for (const formulaKey of plan.keys) {
        if (dirty.has(formulaKey)) continue;
        const formulaSheet = parseCellKey(formulaKey).sheet;
        const targets = covered.get(formulaKey) ?? [];
        if (targets.some((target) => targetCovers(target, formulaSheet, parsed.sheet, parsed.address))) {
          dirty.add(formulaKey);
          next.push(formulaKey);
        }
      }
    }
    frontier = next;
  }
  return dirty;
}

/**
 * 脏传播 + 按需重算顺序。
 *
 * @throws {ValidationError} `seeds` 不是数组，或某个种子不是合法单元格键
 */
export function dirtyClosure(plan: RecalcPlan, seeds: readonly CellKey[]): RecalcBatch {
  const normalized = normalizeSeeds(seeds);
  const formulaKeys = new Set(plan.keys);

  const dirty = new Set(coverageClosure(plan, normalized));
  const dataSeeds = normalized.filter((seed) => !formulaKeys.has(seed));

  const order = plan.order.filter((key) => dirty.has(key));

  const blocked = [...plan.cycleOf.keys()].filter((key) => dirty.has(key)).sort((a, b) => a.localeCompare(b));
  const unresolved = [...plan.unresolved.keys()].filter((key) => dirty.has(key)).sort((a, b) => a.localeCompare(b));

  // 坏输入（环 / 无法解析）的**下游**：可以算，但算出来的东西不可信。
  const broken = [...blocked, ...unresolved].sort((a, b) => a.localeCompare(b));
  const affected = coverageClosure(plan, broken);
  const brokenSet = new Set(broken);
  const tainted = [...affected]
    .filter((key) => !brokenSet.has(key) && dirty.has(key))
    .sort((a, b) => a.localeCompare(b));

  return Object.freeze({
    seeds: normalized,
    dataSeeds: Object.freeze(dataSeeds),
    order: Object.freeze(order),
    blocked: Object.freeze(blocked),
    unresolved: Object.freeze(unresolved),
    tainted: Object.freeze(tainted),
  });
}

/**
 * 计划里没有环时是空操作。
 *
 * @throws {CircularReferenceError} 存在环（携带全部环的报告）
 */
export function assertAcyclic(plan: RecalcPlan): void {
  if (plan.cycles.length > 0) {
    throw new CircularReferenceError(plan.cycles);
  }
}

/** 脏区里出现**语法过不去**的公式格：它被阻塞，因此这一批不能给出干净的顺序。 */
export class UnresolvedFormulaError extends Error {
  readonly cells: readonly CellKey[];

  constructor(cells: readonly CellKey[]) {
    super(`重算范围内存在无法解析的公式格（依赖未知，保留原文并阻塞）：${cells.join('、')}`);
    this.name = 'UnresolvedFormulaError';
    this.cells = cells;
  }
}

/**
 * 只要**这一批**脏区里没有环与无法解析的公式，就返回顺序；
 * 否则**报错**，绝不返回一个"看起来正常、其实漏算"的顺序。
 *
 * 这是"循环必须被检出并明确报错（不得死循环或静默给 0）"的对外入口。
 *
 * @throws {CircularReferenceError} 脏区里出现**环成员**（携带相关环）
 * @throws {UnresolvedFormulaError} 脏区里出现无法解析的公式格
 * @throws {ValidationError} `seeds` 非法
 */
export function requireRecalcOrder(plan: RecalcPlan, seeds: readonly CellKey[]): readonly CellKey[] {
  const batch = dirtyClosure(plan, seeds);
  if (batch.blocked.length > 0) {
    const blockedSet = new Set(batch.blocked);
    const relevant = plan.cycles.filter((cycle) =>
      cycle.members.some((member) => blockedSet.has(member)),
    );
    throw new CircularReferenceError(relevant);
  }
  if (batch.unresolved.length > 0) {
    throw new UnresolvedFormulaError(batch.unresolved);
  }
  return batch.order;
}

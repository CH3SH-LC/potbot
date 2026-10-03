/**
 * 表格域：重算计划（X04）的**循环引用检测与分类**、以及确定性的拓扑排序。
 *
 * ## 为什么循环必须"检出并报错"，不能"给个 0"
 *
 * 循环引用是**用户输入错误**（或模型错误），不是一个可计算的输入。Excel 把它标成
 * 迭代 / 错误值，而不是挑一条路径算下去。本模块的纪律是：
 *
 * 1. 环成员**一律**从可算顺序 `order` 里剔除（见 {@link classifyCycles} 的调用方），
 *    因此"循环引用却算出一个数"在**数据结构上不可表达**；
 * 2. 环以 {@link CycleReport} **显式列出**（成员、路径、分类），调用方可以据此报错；
 * 3. 求值用的是 Tarjan SCC（迭代式，**无递归**）——深链不会爆栈，
 *    环也不会让遍历无限打转（每个节点只入栈一次）。
 *
 * ## 分类：显式循环 / 交叉循环
 *
 * | 分类 | 判据 | 例子 |
 * |---|---|---|
 * | `explicit`（显式循环） | 环退化成**自引用**：该格的公式直接读自己（含经区域读自己） | `A1 = A1+1`、`A1 = SUM(A1:A3)` |
 * | `cross`（交叉循环） | 环**跨**至少两个不同单元格：互相读来读去才能闭环 | `A1 = B1+1` 且 `B1 = A1+1` |
 *
 * 两个维度是**正交**的：`cross` 的环还可能**跨表**（`crossSheet: true`，
 * 如 `Sheet1!A1 = Sheet2!B1` 且 `Sheet2!B1 = Sheet1!A1`）。
 *
 * ## 确定性
 *
 * 强连通分量、分量内成员、环路径、拓扑序全部**按字符串字典序**取唯一确定的结果：
 * 同样的依赖图 ⇒ 同样的分量划分、同样的路径、同样的重算顺序，与输入数组的排列无关。
 */

import { type CellKey } from './keys.js';

/** 环的分类。 */
export type CycleKind = 'explicit' | 'cross';

/** 一个环（一组互相可达的公式格）的报告。 */
export interface CycleReport {
  readonly kind: CycleKind;
  /** 环是否跨表（成员分布在多张工作表上）。 */
  readonly crossSheet: boolean;
  /** 环成员，按字典序（即确定顺序）。 */
  readonly members: readonly CellKey[];
  /**
   * 一条**代表性的闭环路径**，首尾相同：`[A1, B1, C1, A1]`。
   * 起点固定为字典序最小的成员，每一跳都取字典序最小的可用后继 ⇒ 路径本身确定。
   */
  readonly path: readonly CellKey[];
  /** 环成员涉及的工作表名，字典序去重。 */
  readonly sheets: readonly string[];
}

/** 键的字典序比较（`noUncheckedIndexedAccess` 下的空值收窄集中在这里）。 */
function compareKeys(a: CellKey | undefined, b: CellKey | undefined): number {
  return (a ?? '').localeCompare(b ?? '');
}

/**
 * Tarjan 强连通分量（**迭代式**，无递归）。
 *
 * 返回的分量已排序：分量按首个成员字典序排列，分量内成员按字典序排列。
 */
export function stronglyConnectedComponents(
  keys: readonly CellKey[],
  dependencies: ReadonlyMap<CellKey, readonly CellKey[]>,
): readonly (readonly CellKey[])[] {
  const nodes = [...keys].sort(compareKeys);
  const index = new Map<CellKey, number>();
  const lowlink = new Map<CellKey, number>();
  const onStack = new Set<CellKey>();
  const stack: CellKey[] = [];
  const components: CellKey[][] = [];
  let counter = 0;

  interface Frame {
    readonly node: CellKey;
    edge: number;
  }

  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: Frame[] = [{ node: root, edge: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      /* c8 ignore next -- 循环条件已保证非空 */
      if (frame === undefined) break;

      if (frame.edge === 0) {
        index.set(frame.node, counter);
        lowlink.set(frame.node, counter);
        counter += 1;
        stack.push(frame.node);
        onStack.add(frame.node);
      }

      const neighbours = dependencies.get(frame.node) ?? [];
      if (frame.edge < neighbours.length) {
        const next = neighbours[frame.edge];
        frame.edge += 1;
        if (next === undefined) continue;
        if (!index.has(next)) {
          work.push({ node: next, edge: 0 });
        } else if (onStack.has(next)) {
          const current = lowlink.get(frame.node) ?? 0;
          const target = index.get(next) ?? 0;
          lowlink.set(frame.node, Math.min(current, target));
        }
        continue;
      }

      if ((lowlink.get(frame.node) ?? -1) === (index.get(frame.node) ?? -2)) {
        const component: CellKey[] = [];
        for (;;) {
          const popped = stack.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.node) break;
        }
        components.push(component.sort(compareKeys));
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        const current = lowlink.get(parent.node) ?? 0;
        const child = lowlink.get(frame.node) ?? 0;
        lowlink.set(parent.node, Math.min(current, child));
      }
    }
  }

  return components.sort((a, b) => compareKeys(a[0], b[0])).map((component) => Object.freeze(component));
}

/** 分量是不是环：长度 > 1（互达）或长度 1 但自引用。 */
function isCyclicComponent(
  component: readonly CellKey[],
  dependencies: ReadonlyMap<CellKey, readonly CellKey[]>,
): boolean {
  if (component.length > 1) {
    return true;
  }
  const only = component[0];
  if (only === undefined) {
    return false;
  }
  return (dependencies.get(only) ?? []).includes(only);
}

/**
 * 在强连通分量里找一条**简单闭环**（起点 = 字典序最小的成员）。
 *
 * 迭代式 DFS：SCC 保证从起点必然能回到起点，因此必然在**有限步**内返回，
 * 不存在"转不出来"的路径。不在当前路径栈上的节点不会被重复展开（不用 visited 全局表，
 * 因为 SCC 内每条回边都合法）。
 */
function findCyclePath(
  start: CellKey,
  members: ReadonlySet<CellKey>,
  dependencies: ReadonlyMap<CellKey, readonly CellKey[]>,
): readonly CellKey[] {
  const path: CellKey[] = [start];
  const onPath = new Set<CellKey>([start]);

  interface Frame {
    readonly node: CellKey;
    edge: number;
  }

  const work: Frame[] = [{ node: start, edge: 0 }];
  while (work.length > 0) {
    const frame = work[work.length - 1];
    /* c8 ignore next -- 循环条件已保证非空 */
    if (frame === undefined) break;
    const neighbours = (dependencies.get(frame.node) ?? []).filter((candidate) => members.has(candidate));
    if (frame.edge >= neighbours.length) {
      work.pop();
      path.pop();
      onPath.delete(frame.node);
      continue;
    }
    const next = neighbours[frame.edge];
    frame.edge += 1;
    if (next === undefined) continue;
    if (next === start) {
      return Object.freeze([...path, start]);
    }
    if (onPath.has(next)) {
      continue;
    }
    path.push(next);
    onPath.add(next);
    work.push({ node: next, edge: 0 });
  }
  /* c8 ignore next -- SCC 保证必然找到闭环；走到这里只可能是空分量 */
  return Object.freeze([start]);
}

function makeCycleReport(
  kind: CycleKind,
  members: readonly CellKey[],
  dependencies: ReadonlyMap<CellKey, readonly CellKey[]>,
): CycleReport {
  const memberSet = new Set(members);
  const start = members[0];
  /* c8 ignore next -- 调用方保证分量非空 */
  const path = start === undefined ? Object.freeze([]) : findCyclePath(start, memberSet, dependencies);
  const sheets = [...new Set(members.map((member) => member.slice(0, member.lastIndexOf('!'))))].sort();
  return Object.freeze({
    kind,
    crossSheet: sheets.length > 1,
    members: Object.freeze([...members]),
    path,
    sheets: Object.freeze(sheets),
  });
}

/**
 * 由依赖图导出全部环，并给出分类。
 *
 * 环的顺序、成员顺序、路径顺序都确定；同一个依赖图永远得到同一个数组。
 */
export function classifyCycles(
  keys: readonly CellKey[],
  dependencies: ReadonlyMap<CellKey, readonly CellKey[]>,
): readonly CycleReport[] {
  const reports: CycleReport[] = [];
  for (const component of stronglyConnectedComponents(keys, dependencies)) {
    if (!isCyclicComponent(component, dependencies)) continue;
    const kind: CycleKind = component.length === 1 ? 'explicit' : 'cross';
    reports.push(makeCycleReport(kind, component, dependencies));
  }
  return Object.freeze(reports);
}

/** 把 `value` 按字典序插入已排序数组（保持确定性的"每次取最小"）。 */
function insertSorted(sorted: string[], value: string): void {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const probe = sorted[mid];
    if (probe === undefined || probe.localeCompare(value) >= 0) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  sorted.splice(low, 0, value);
}

/**
 * 确定性拓扑排序（Kahn），**依赖在前**。
 *
 * - 每一轮取出**字典序最小**的可用节点 ⇒ 同样的图永远得到同样的序列；
 * - `excluded`（环成员 / 无法解析的格子）整体不参与：它们不与任何节点比大小，
 *   **也不**让依赖它们的节点卡住——后者照常排进顺序（是否"白算"由调用方按 `tainted` 判断）；
 * - 万一出现"排不完"（对已剔除环的剩余图**不可能**发生），剩余节点按字典序**补在尾部**
 *   而不是丢弃：宁可顺序可疑，也不要**静默漏算**某个格子。
 */
export function topoOrder(
  keys: readonly CellKey[],
  dependencies: ReadonlyMap<CellKey, readonly CellKey[]>,
  excluded: ReadonlySet<CellKey>,
): readonly CellKey[] {
  const remaining = keys.filter((key) => !excluded.has(key)).sort(compareKeys);
  const remainingSet = new Set(remaining);
  const indegree = new Map<CellKey, number>();
  const children = new Map<CellKey, string[]>();

  for (const key of remaining) {
    indegree.set(key, 0);
  }
  for (const key of remaining) {
    for (const dependency of dependencies.get(key) ?? []) {
      if (!remainingSet.has(dependency)) continue;
      indegree.set(key, (indegree.get(key) ?? 0) + 1);
      const list = children.get(dependency);
      if (list === undefined) {
        children.set(dependency, [key]);
      } else {
        list.push(key);
      }
    }
  }

  const ready = remaining.filter((key) => (indegree.get(key) ?? 0) === 0).sort(compareKeys);
  const order: CellKey[] = [];

  while (ready.length > 0) {
    const node = ready.shift();
    if (node === undefined) break;
    order.push(node);
    for (const child of children.get(node) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) {
        insertSorted(ready, child);
      }
    }
  }

  if (order.length !== remaining.length) {
    // 理论上不可达：调用方已把环成员剔除，剩余图必为 DAG。补在尾部是为了「不静默漏算」。
    const placed = new Set(order);
    for (const key of remaining) {
      if (!placed.has(key)) order.push(key);
    }
  }

  return Object.freeze(order);
}

/** 是否有环（便捷判据；等价于 `classifyCycles(...).length > 0`）。 */
export function hasCycle(
  keys: readonly CellKey[],
  dependencies: ReadonlyMap<CellKey, readonly CellKey[]>,
): boolean {
  return classifyCycles(keys, dependencies).length > 0;
}

/**
 * 表格域：**重算与依赖顺序**（design-06-P8 / XLS-08）。
 *
 * ## XLS-08 的四件事，各自在本文件的落点
 *
 * | XLS-08 的要求 | 本文件的落点 |
 * |---|---|
 * | 修改数据后公式重算 | {@link recalcWorkbook}：从工作簿现状**整体重算**，逐公式格给出缓存值 |
 * | 依赖顺序（拓扑排序） | {@link buildDependencyGraph} + {@link dependencyOrder}（SCC 缩合图的拓扑序） |
 * | 循环引用与错误值 | 环成员一律 `circular_reference` 阻塞；`#DIV/0!` / `#REF!` / `#N/A` 等按 Excel 语义传播 |
 * | 缓存和公式一致 | {@link checkFormulaCache}：把外存缓存与新算结果逐格比对 |
 *
 * ## 「不支持的公式保留或阻塞，不能返回伪造结果」在本文件的形状
 *
 * 1. **公式格永远是公式格**：本模块**不改**工作簿里的单元格（不改写文本、不把公式替换成数值）。
 *    XLS-06 要求"保存的是可编辑公式"，XLS-08 要求"不支持的公式**保留**原文"——两件事在这里
 *    是同一条实现：`RecalcReport.workbook` 与输入**逐字相同**。缓存值**单独**放在
 *    `values` 映射里（`CellValue` 的判别联合里没有"公式 + 缓存"两态，也不该有）。
 * 2. **阻塞是结果，不是异常**：每个公式格的结局是 {@link EvalOutcome} 的二值之一。
 *    没有"算个大概"的第三态；`values` 里 `ok: false` 的格子**没有数值**。
 * 3. **环不产出数值**：成环的落点在求值前就被标记为 `circular_reference`，
 *    依赖它们的格子读到的也正是这个阻塞（`resolveCell` 返回 `kind: 'blocked'`），
 *    因此"循环引用却算出一个数"在这条实现路径上**不可表达**。
 *
 * ## 依赖是怎么抓的
 *
 * 走 `formula-parse.ts` 的 AST（不是正则）：`reference` 节点是单格，`range` 节点是矩形。
 * 逐公式格比对"本表（或他表）的**公式格**是否落在这些矩形里"——因此**不需要展开区域**
 * （`A1:XFD1048576` 也不会炸），也不会把 `LOG10(100)` 里的 `LOG10` 当成引用
 * （那是一棵 `call` 树，不是 `reference` 节点）。
 *
 * 语法都过不去的公式：依赖**未知**，登记进 {@link DependencyGraph.unparsed}。
 * 未知依赖不参与排序（保守：可能算得早一点），但该格求值必然 `parse_error` 阻塞，
 * **绝不会因此产出数值**。
 *
 * ## 求值用的是哪套函数
 *
 * {@link evaluateWithFunctions}（XLS-07 的扩展函数库）。因此 `SUMIF` / `VLOOKUP` /
 * 日期函数参与的重算链与核心函数走同一条路径、同一套错误值传播。
 */

import { ValidationError } from '../protocol/index.js';
import {
  type EvalOutcome,
  type FormulaEvalBlockReason,
} from './evaluate.js';
import { evaluateWithFunctions, type SpreadsheetFormulaContext } from './functions.js';
import { FormulaParseError, parseFormula, type FormulaNode } from './formula-parse.js';
import { formatCellAddress, parseCellAddress, type CellAddress } from './reference.js';
import { getCellValue, sheetEntries, type SheetState } from './sheet.js';
import { isFormula, valuesEqual } from './value.js';
import { getSheet, type WorkbookState } from './workbook.js';

/** 单元格的全局键：`"Sheet1!A1"`（表名可含空格 / 非 ASCII，解析时按**最后一个** `!` 切分）。 */
export type CellKey = string;

/** 造键。@throws {ValidationError} 地址非法 */
export function cellKey(sheetName: string, address: CellAddress | string): CellKey {
  if (typeof sheetName !== 'string' || sheetName.length === 0) {
    throw new ValidationError('cellKey 的工作表名必须是非空字符串');
  }
  const ref = typeof address === 'string' ? formatCellAddress(parseCellAddress(address)) : formatCellAddress(address);
  return `${sheetName}!${ref}`;
}

/** 拆键。@throws {ValidationError} 键形状不对 */
export function parseCellKey(key: CellKey): { readonly sheet: string; readonly ref: string; readonly address: CellAddress } {
  if (typeof key !== 'string') {
    throw new ValidationError('parseCellKey 只接受字符串');
  }
  const separator = key.lastIndexOf('!');
  if (separator <= 0 || separator === key.length - 1) {
    throw new ValidationError(`不是合法单元格键（应为 "表名!A1"）：${JSON.stringify(key)}`);
  }
  const sheet = key.slice(0, separator);
  const ref = formatCellAddress(parseCellAddress(key.slice(separator + 1)));
  return { sheet, ref, address: parseCellAddress(ref) };
}

// ---------------------------------------------------------------------------
// 依赖图
// ---------------------------------------------------------------------------

/** 公式里出现的一个引用目标（单格即 `start === end`）。`sheet === null` 表示"本表"。 */
export interface DependencyTarget {
  readonly sheet: string | null;
  readonly start: CellAddress;
  readonly end: CellAddress;
}

/**
 * 扫描公式文本里的引用目标。
 *
 * `null` = **语法都过不去** ⇒ 依赖未知（不复用 `formula.ts` 的 `extractFormulaReferences`：
 * 那个函数对**含双引号的公式**一律返回 `null`，会把 `IF(A1>0,"是",B1)` 这种合法公式
 * 误判成"读不懂"；走 AST 没有这个限制）。
 */
export function scanDependencyTargets(text: string): readonly DependencyTarget[] | null {
  let node: FormulaNode;
  try {
    node = parseFormula(text);
  } catch (error) {
    if (error instanceof FormulaParseError) {
      return null;
    }
    throw error;
  }
  const targets: DependencyTarget[] = [];
  const visit = (current: FormulaNode): void => {
    switch (current.kind) {
      case 'reference':
        targets.push({ sheet: current.sheet, start: current.reference, end: current.reference });
        return;
      case 'range':
        targets.push({ sheet: current.sheet, start: current.start, end: current.end });
        return;
      case 'call':
        current.args.forEach(visit);
        return;
      case 'unary':
        visit(current.operand);
        return;
      case 'binary':
        visit(current.left);
        visit(current.right);
        return;
      default:
        return;
    }
  };
  visit(node);
  return Object.freeze(targets);
}

/**
 * 目标是否覆盖 `(sheetName, address)`。
 *
 * `defaultSheet` 是**写公式的那张表**（`target.sheet === null` 时无前缀引用指向它），
 * `sheetName` 是被测地址所在的表——两者分开传，才不会把"无前缀引用"张冠李戴。
 */
function targetCovers(
  target: DependencyTarget,
  defaultSheet: string,
  sheetName: string,
  address: CellAddress,
): boolean {
  const targetSheet = target.sheet ?? defaultSheet;
  if (targetSheet !== sheetName) {
    return false;
  }
  const rowStart = Math.min(target.start.row, target.end.row);
  const rowEnd = Math.max(target.start.row, target.end.row);
  const columnStart = Math.min(target.start.column, target.end.column);
  const columnEnd = Math.max(target.start.column, target.end.column);
  return (
    address.row >= rowStart &&
    address.row <= rowEnd &&
    address.column >= columnStart &&
    address.column <= columnEnd
  );
}

/**
 * 依赖图。
 *
 * - **排序**只用 `dependencies`（公式格之间的边）；
 * - **影响面**（{@link dependentClosure}）用 `targets`（原始引用目标），
 *   因此**改一个数据格**也能正确定位到受影响的公式格——仅仅有公式格之间的边是不够的。
 */
export interface DependencyGraph {
  /** 全部公式格键（按工作簿顺序、行优先，确定性）。 */
  readonly keys: readonly CellKey[];
  /** 键 → 它依赖的公式格键（已去重、已排序，可能含自身 = 自环）。 */
  readonly dependencies: ReadonlyMap<CellKey, readonly CellKey[]>;
  /** 键 → 该公式扫描出的**原始引用目标**（含指向数据格的引用，不展开成格）。 */
  readonly targets: ReadonlyMap<CellKey, readonly DependencyTarget[]>;
  /** 语法解析失败的公式格 → 原因（依赖**未知**，不参与排序）。 */
  readonly unparsed: ReadonlyMap<CellKey, string>;
}

function formulaCells(workbook: WorkbookState): readonly { readonly key: CellKey; readonly sheet: SheetState; readonly ref: string; readonly text: string }[] {
  const found: { key: CellKey; sheet: SheetState; ref: string; text: string }[] = [];
  for (const sheet of workbook.sheets) {
    for (const entry of sheetEntries(sheet)) {
      if (!isFormula(entry.value)) continue;
      found.push({ key: cellKey(sheet.name, entry.ref), sheet, ref: entry.ref, text: entry.value.text });
    }
  }
  return found;
}

/** 从工作簿构建依赖图（纯函数，不改工作簿）。 */
export function buildDependencyGraph(workbook: WorkbookState): DependencyGraph {
  const cells = formulaCells(workbook);
  const keys = cells.map((cell) => cell.key);

  // 公式格按表分组（只跟**本表 / 目标表**的公式格比对，不必扫全簿）。
  const bySheet = new Map<string, { readonly key: CellKey; readonly address: CellAddress }[]>();
  for (const key of keys) {
    const parsed = parseCellKey(key);
    const list = bySheet.get(parsed.sheet);
    if (list === undefined) {
      bySheet.set(parsed.sheet, [{ key, address: parsed.address }]);
    } else {
      list.push({ key, address: parsed.address });
    }
  }

  const dependencies = new Map<CellKey, readonly CellKey[]>();
  const targetsByKey = new Map<CellKey, readonly DependencyTarget[]>();
  const unparsed = new Map<CellKey, string>();

  for (const cell of cells) {
    const targets = scanDependencyTargets(cell.text);
    if (targets === null) {
      unparsed.set(cell.key, '公式语法超出本仓子集，引用目标无法枚举（依赖未知）');
      dependencies.set(cell.key, Object.freeze([]));
      targetsByKey.set(cell.key, Object.freeze([]));
      continue;
    }
    const found = new Set<CellKey>();
    for (const target of targets) {
      const targetSheet = target.sheet ?? cell.sheet.name;
      for (const candidate of bySheet.get(targetSheet) ?? []) {
        if (targetCovers(target, cell.sheet.name, targetSheet, candidate.address)) {
          found.add(candidate.key);
        }
      }
    }
    dependencies.set(cell.key, Object.freeze([...found].sort()));
    targetsByKey.set(cell.key, targets);
  }

  return Object.freeze({
    keys: Object.freeze(keys),
    dependencies,
    targets: targetsByKey,
    unparsed,
  });
}

/**
 * 直接依赖 `key` 的公式格（**包含**只引用数据格的情形）。
 *
 * 实现是"按引用目标覆盖"扫描（而不是只查公式格之间的反向边）：改一个数据格时，
 * 反向边那条路是**查不到**的（数据格不是图的节点）。代价是 O(公式格数 × 目标数)——
 * 本函数服务于**报告影响面**，不在重算热路径上（重算本身是整体重算）。
 */
export function directDependents(graph: DependencyGraph, key: CellKey): readonly CellKey[] {
  const parsed = parseCellKey(key);
  const result: CellKey[] = [];
  for (const [formulaKey, targets] of graph.targets) {
    const formulaSheet = parseCellKey(formulaKey).sheet;
    if (targets.some((target) => targetCovers(target, formulaSheet, parsed.sheet, parsed.address))) {
      result.push(formulaKey);
    }
  }
  return Object.freeze(result.sort());
}

// ---------------------------------------------------------------------------
// 强连通分量（迭代式 Tarjan；无递归，深链也不会爆栈）
// ---------------------------------------------------------------------------

/**
 * Tarjan 的 SCC。**输出顺序即"依赖优先"的求值顺序**：
 * 缩合图里若存在 `A → B`（A 依赖 B），则 `B` 的分量**先**被输出。
 */
function stronglyConnectedComponents(
  keys: readonly CellKey[],
  dependencies: ReadonlyMap<CellKey, readonly CellKey[]>,
): readonly (readonly CellKey[])[] {
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

  for (const root of keys) {
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
        components.push(component.sort());
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
  return components.map((component) => Object.freeze(component));
}

/** 依赖顺序：拓扑序 + 环。 */
export interface DependencyOrder {
  /** 求值顺序（依赖在前）。**不含**环内节点——那些节点一律阻塞。 */
  readonly order: readonly CellKey[];
  /** 检测到的环（每个元素是一组互相可达（或自引用）的公式格，已排序）。 */
  readonly cycles: readonly (readonly CellKey[])[];
}

function isCyclicComponent(component: readonly CellKey[], dependencies: ReadonlyMap<CellKey, readonly CellKey[]>): boolean {
  if (component.length > 1) {
    return true;
  }
  const only = component[0];
  if (only === undefined) {
    return false;
  }
  return (dependencies.get(only) ?? []).includes(only);
}

/** 由依赖图导出求值顺序与环清单。 */
export function dependencyOrder(graph: DependencyGraph): DependencyOrder {
  const components = stronglyConnectedComponents(graph.keys, graph.dependencies);
  const order: CellKey[] = [];
  const cycles: (readonly CellKey[])[] = [];
  for (const component of components) {
    if (isCyclicComponent(component, graph.dependencies)) {
      cycles.push(component);
      continue;
    }
    for (const key of component) {
      order.push(key);
    }
  }
  return Object.freeze({ order: Object.freeze(order), cycles: Object.freeze(cycles) });
}

/**
 * **机器可核的排序证据**：返回违反"依赖在前"的边（应为空）。
 *
 * 只检查**两端都在 `order` 里**的边：依赖环内节点的边必然违反——那正是环的语义。
 */
export function verifyOrder(graph: DependencyGraph, order: readonly CellKey[]): readonly string[] {
  const position = new Map<CellKey, number>();
  order.forEach((key, at) => position.set(key, at));
  const violations: string[] = [];
  for (const [key, deps] of graph.dependencies) {
    const self = position.get(key);
    if (self === undefined) continue;
    for (const dependency of deps) {
      const dep = position.get(dependency);
      if (dep === undefined) continue;
      if (dep >= self) {
        violations.push(`${dependency} 应当排在 ${key} 之前（实际 ${String(dep)} ≥ ${String(self)}）`);
      }
    }
  }
  return Object.freeze(violations);
}

/**
 * 变更影响面：改了 `seeds` 之后**需要重算**的全部公式格（含 `seeds` 里本身是公式格的项）。
 *
 * 这是"修改数据后公式重算"的**最小重算集**：改一个数据格时，只有引用（直接或经引用链）
 * 到它的公式格会变。`directDependents` 走的是**引用覆盖**而不是公式格之间的反向边，
 * 所以数据格种子同样有效。
 */
export function dependentClosure(graph: DependencyGraph, seeds: readonly CellKey[]): readonly CellKey[] {
  const reached = new Set<CellKey>();
  const frontier: CellKey[] = [];
  for (const seed of seeds) {
    if (graph.targets.has(seed) && !reached.has(seed)) {
      reached.add(seed);
      frontier.push(seed);
      continue;
    }
    // 数据格种子：它自己不是"要重算的公式格"，但它的下游是。
    for (const dependent of directDependents(graph, seed)) {
      if (reached.has(dependent)) continue;
      reached.add(dependent);
      frontier.push(dependent);
    }
  }
  while (frontier.length > 0) {
    const current = frontier.shift();
    /* c8 ignore next -- 循环条件已保证非空 */
    if (current === undefined) continue;
    for (const dependent of directDependents(graph, current)) {
      if (reached.has(dependent)) continue;
      reached.add(dependent);
      frontier.push(dependent);
    }
  }
  return Object.freeze([...reached].sort());
}

// ---------------------------------------------------------------------------
// 重算
// ---------------------------------------------------------------------------

/** 重算选项。 */
export interface RecalcOptions {
  /** `TODAY()` 需要的显式当前日期（Excel 序列号）。不提供 ⇒ 含 `TODAY()` 的公式阻塞。 */
  readonly today_serial?: number;
}

/** 一个被阻塞的公式格（**没有数值**，且原文保留）。 */
export interface RecalcBlock {
  readonly key: CellKey;
  readonly text: string;
  readonly reason: FormulaEvalBlockReason;
  readonly detail: string;
}

/** 重算结果。 */
export interface RecalcReport {
  /** 输入工作簿**原样**（公式仍是公式，文本逐字未改）。 */
  readonly workbook: WorkbookState;
  /** 依赖优先的求值顺序（不含环内节点）。 */
  readonly order: readonly CellKey[];
  /** 检测到的环。 */
  readonly cycles: readonly (readonly CellKey[])[];
  /** 排序自检结果（`[]` 表示"依赖确实都在前面"）。 */
  readonly order_violations: readonly string[];
  /** 逐公式格的缓存值（`ok: false` 表示**该格没有数值**）。 */
  readonly values: ReadonlyMap<CellKey, EvalOutcome>;
  /** 被阻塞的公式格清单（与 `values` 里 `ok: false` 的条目一一对应）。 */
  readonly blocked: readonly RecalcBlock[];
}

function formulaTextOf(workbook: WorkbookState, key: CellKey): string {
  const parsed = parseCellKey(key);
  const sheet = getSheet(workbook, parsed.sheet);
  /* c8 ignore next -- 键由 buildDependencyGraph 从工作簿本身生成 */
  if (sheet === undefined) {
    throw new ValidationError(`recalcWorkbook：工作簿里没有工作表 ${JSON.stringify(parsed.sheet)}`);
  }
  const value = getCellValue(sheet, parsed.ref);
  /* c8 ignore next -- 同上 */
  if (!isFormula(value)) {
    throw new ValidationError(`recalcWorkbook：${key} 不是公式格`);
  }
  return value.text;
}

/**
 * 重算整个工作簿的公式，返回逐格缓存值、求值顺序与环。
 *
 * **不改工作簿**（公式保留原文）；算法是"整体重算"——因此缓存与公式**必然一致**
 * （缓存就是在当前工作簿上算出来的），`checkFormulaCache` 是对外存缓存的独立复核。
 *
 * @throws {ValidationError} 工作簿形状异常（不应发生：键来自工作簿自身）
 */
export function recalcWorkbook(workbook: WorkbookState, options: RecalcOptions = {}): RecalcReport {
  const graph = buildDependencyGraph(workbook);
  const { order, cycles } = dependencyOrder(graph);
  const values = new Map<CellKey, EvalOutcome>();

  // 环内节点：**先**钉成阻塞，依赖它们的格子读到的就是这个结论。
  for (const cycle of cycles) {
    const detail = `循环引用：${cycle.join(' → ')} →（回到起点）`;
    for (const key of cycle) {
      values.set(key, { ok: false, reason: 'circular_reference', detail });
    }
  }

  const sheetByName = new Map<string, SheetState>();
  for (const sheet of workbook.sheets) {
    sheetByName.set(sheet.name, sheet);
  }

  for (const key of order) {
    const parsed = parseCellKey(key);
    const text = formulaTextOf(workbook, key);
    const context: SpreadsheetFormulaContext = {
      current_sheet: parsed.sheet,
      today_serial: options.today_serial,
      hasSheet: (name) => sheetByName.has(name),
      resolveCell: (sheet, address) => {
        const targetSheet = sheet ?? parsed.sheet;
        const targetKey = cellKey(targetSheet, address);
        const cached = values.get(targetKey);
        if (cached !== undefined) {
          return cached.ok
            ? { kind: 'value', value: cached.value }
            : {
                kind: 'blocked',
                reason: cached.reason,
                detail: `依赖格 ${targetKey}：${cached.detail}`,
              };
        }
        const sheetState = sheetByName.get(targetSheet);
        if (sheetState === undefined) {
          return {
            kind: 'blocked',
            reason: 'unknown_sheet',
            detail: `工作簿里没有工作表 ${JSON.stringify(targetSheet)}`,
          };
        }
        return { kind: 'value', value: getCellValue(sheetState, address) };
      },
    };
    values.set(key, evaluateWithFunctions(text, context));
  }

  const blocked: RecalcBlock[] = [];
  for (const [key, outcome] of values) {
    if (outcome.ok) continue;
    blocked.push({
      key,
      text: formulaTextOf(workbook, key),
      reason: outcome.reason,
      detail: outcome.detail,
    });
  }
  blocked.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));

  return Object.freeze({
    workbook,
    order,
    cycles,
    order_violations: verifyOrder(graph, order),
    values,
    blocked: Object.freeze(blocked),
  });
}

// ---------------------------------------------------------------------------
// 缓存一致性
// ---------------------------------------------------------------------------

/** 一处缓存不一致（期望 = 现在重算出来的；缓存 = 外存的那份）。 */
export interface CacheMismatch {
  readonly key: CellKey;
  readonly expected: EvalOutcome;
  readonly cached: EvalOutcome | undefined;
}

/** 两个求值结论是否**逐字段相同**（取值用 `valuesEqual`，类别不同即不等）。 */
export function outcomesEqual(left: EvalOutcome, right: EvalOutcome): boolean {
  if (left.ok !== right.ok) {
    return false;
  }
  if (left.ok && right.ok) {
    return valuesEqual(left.value, right.value);
  }
  if (!left.ok && !right.ok) {
    return left.reason === right.reason && left.detail === right.detail;
  }
  /* c8 ignore next -- 上面的两支已覆盖全部组合 */
  return false;
}

/** 缓存一致性复核结果。`consistent` 为真 ⇔ `mismatches` 为空。 */
export interface CacheCheck {
  readonly consistent: boolean;
  readonly mismatches: readonly CacheMismatch[];
}

/**
 * 复核一份（外存的）缓存是否与**当前工作簿**一致。
 *
 * 这是 XLS-08「缓存和公式一致」的可执行判据：把缓存与新算结果**逐格**比对——
 * 不一致的格子会被指认（key / 期望 / 缓存），既不是"看起来没问题"，也不是一句口号。
 */
export function checkFormulaCache(
  workbook: WorkbookState,
  cache: ReadonlyMap<CellKey, EvalOutcome>,
  options: RecalcOptions = {},
): CacheCheck {
  const report = recalcWorkbook(workbook, options);
  const mismatches: CacheMismatch[] = [];
  for (const [key, expected] of report.values) {
    const cached = cache.get(key);
    if (cached === undefined) {
      mismatches.push({ key, expected, cached: undefined });
      continue;
    }
    if (!outcomesEqual(expected, cached)) {
      mismatches.push({ key, expected, cached });
    }
  }
  for (const [key, cached] of cache) {
    if (report.values.has(key)) continue;
    mismatches.push({ key, expected: { ok: false, reason: 'invalid_reference', detail: '当前工作簿里没有这个公式格' }, cached });
  }
  mismatches.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return Object.freeze({ consistent: mismatches.length === 0, mismatches: Object.freeze(mismatches) });
}

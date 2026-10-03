/**
 * 表格域：重算计划（X04）的**依赖图构建**。
 *
 * ## 这一层回答的问题
 *
 * 「从工作表的公式现状出发，谁依赖谁？按什么顺序重算？哪里有环？」
 * 它**不算数**——求值是 `evaluate.ts` / `recalc.ts` 的事。本模块只产出**计划**：
 * 一张依赖图、一个确定的顺序、一份环清单。把"计划"独立出来，是为了让
 * "顺序对不对 / 环抓没抓住"能对着数据结构断言，而不是透过整表求值结果间接猜。
 *
 * ## 与 `recalc.ts` 的关系
 *
 * `recalc.ts` 已经有一份依赖图（XLS-08 用）。本模块**不 import 它、也不改它**——
 * 刻意独立，因为 X04 需要它没有的三件事：
 *
 * 1. **命名引用**解析（`recalc.ts` 的路径上，裸名字是解析失败 ⇒ 依赖未知）；
 * 2. **环的分类**（显式 / 交叉 / 跨表），而不仅是"有一组环成员"；
 * 3. **按需重算**（脏传播 + 受污染标记），而不仅是整体重算。
 *
 * ## 依赖怎么抓（与"展开区域"划清界限）
 *
 * 走 `formula-parse.ts` 的 AST：`reference` 节点是单格，`range` 节点是矩形。
 * 一个公式格的依赖 = **落在它引用目标（单格或矩形）里的公式格**。因此
 * `A1:XFD1048576` 这样的巨型区域也**不会被展开**（只做区间比较），
 * `LOG10(100)` 里的 `LOG10` 也不是引用（那是 `call` 节点）。
 *
 * 引用的表归属：`sheet === null` 的引用指向**写公式的那张表**（`defaultSheet`）。
 * 跨表依赖因此只有写了表名才成立——这是"漏掉跨表就变红"的判据所在。
 *
 * 语法都过不去的公式：依赖**未知**，登记进 {@link RecalcPlan.unresolved}，
 * **不进**可算顺序。未知依赖绝不等于零依赖被悄悄忽略。
 */

import { ValidationError } from '../../protocol/index.js';
import { FormulaParseError, parseFormula, type FormulaNode } from '../formula-parse.js';
import { formatCellAddress, parseCellAddress, type CellAddress } from '../reference.js';
import { classifyCycles, topoOrder, type CycleReport } from './cycles.js';
import { cellKey, sheetNameOf, type CellKey } from './keys.js';
import {
  expandNamedReferences,
  normalizeNamedReferences,
  type NamedReference,
} from './names.js';

/** 公式里出现的一个引用目标（单格即 `start === end`）。`sheet === null` 表示"引用处所在表"。 */
export interface DependencyTarget {
  readonly sheet: string | null;
  readonly start: CellAddress;
  readonly end: CellAddress;
}

/** 计划输入里的一格：`ref` 是 A1 记法；`formula` 省略即"非公式格"（数据格或空）。 */
export interface PlanCell {
  readonly ref: string;
  /** 公式文本，**可含**前导 `=`（会剥掉一个）。省略表示这一格不是公式。 */
  readonly formula?: string;
}

/** 计划输入里的一张表。 */
export interface PlanSheet {
  readonly name: string;
  readonly cells: readonly PlanCell[];
}

/** 计划输入。 */
export interface PlanInput {
  readonly sheets: readonly PlanSheet[];
  /** 命名引用定义（可选）。名字大小写不敏感。 */
  readonly names?: readonly NamedReference[];
}

/** 跨表依赖边（`from` 读 `to`，且两者不在同一张表上）。 */
export interface CrossSheetEdge {
  readonly from: CellKey;
  readonly to: CellKey;
}

/** 依赖重算计划。 */
export interface RecalcPlan {
  /** 工作表顺序（= 输入顺序，确定性的一部分）。 */
  readonly sheetOrder: readonly string[];
  /** 全部公式格键，按「表顺序、行、列」排列（确定性）。 */
  readonly keys: readonly CellKey[];
  /** 公式格 → 它依赖的**公式格**（去重、字典序；可能含自身 = 自引用）。 */
  readonly dependencies: ReadonlyMap<CellKey, readonly CellKey[]>;
  /** 公式格 → 谁依赖它（`dependencies` 的反向；每个公式格都有键，值为确定序）。 */
  readonly precedents: ReadonlyMap<CellKey, readonly CellKey[]>;
  /** 跨表依赖边，按 `(from, to)` 字典序。 */
  readonly crossSheetDependencies: readonly CrossSheetEdge[];
  /** 公式格 → 原始引用目标（含指向**数据格**的引用；不展开成格清单）。 */
  readonly targets: ReadonlyMap<CellKey, readonly DependencyTarget[]>;
  /** 公式格 → 实际送去解析的文本（命名引用已展开）。 */
  readonly formulaText: ReadonlyMap<CellKey, string>;
  /** 公式格 → 本次展开用到的命名引用（原始拼写，字典序）。无则不在表里。 */
  readonly namedUsage: ReadonlyMap<CellKey, readonly string[]>;
  /** 语法过不去的公式格 → 原因。**不进** `order`（阻塞，而不是被当成零依赖）。 */
  readonly unresolved: ReadonlyMap<CellKey, string>;
  /** 被引用但计划里不存在的工作表名（字典序去重）。 */
  readonly missingSheets: readonly string[];
  /** 环清单（分类 + 路径），顺序确定。 */
  readonly cycles: readonly CycleReport[];
  /** 环成员 → 它在 `cycles` 里的下标。环成员**不在** `order` 里。 */
  readonly cycleOf: ReadonlyMap<CellKey, number>;
  /** 可算顺序（依赖在前；不含环成员，也不含 `unresolved`）。 */
  readonly order: readonly CellKey[];
}

/**
 * 扫描公式文本里的引用目标。
 *
 * @returns 目标数组（可能为空）；公式**语法过不去**时返回 `null`（依赖未知）
 * @throws {ValidationError} `text` 不是字符串
 */
export function scanDependencyTargets(text: string): readonly DependencyTarget[] | null {
  if (typeof text !== 'string') {
    throw new ValidationError('scanDependencyTargets 只接受字符串');
  }
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
export function targetCovers(
  target: DependencyTarget,
  defaultSheet: string,
  sheetName: string,
  address: CellAddress,
): boolean {
  const targetSheet = target.sheet ?? defaultSheet;
  if (targetSheet !== sheetName) {
    return false;
  }
  return (
    address.row >= Math.min(target.start.row, target.end.row) &&
    address.row <= Math.max(target.start.row, target.end.row) &&
    address.column >= Math.min(target.start.column, target.end.column) &&
    address.column <= Math.max(target.start.column, target.end.column)
  );
}

interface NormalizedCell {
  readonly ref: string;
  readonly address: CellAddress;
  readonly formula: string | undefined;
}

function normalizeSheets(input: PlanInput): readonly { readonly name: string; readonly cells: readonly NormalizedCell[] }[] {
  if (typeof input !== 'object' || input === null || !Array.isArray(input.sheets)) {
    throw new ValidationError('buildRecalcPlan 需要 { sheets: [...] }');
  }
  if (input.sheets.length === 0) {
    throw new ValidationError('buildRecalcPlan 至少需要一张工作表');
  }
  const seenSheets = new Set<string>();
  return input.sheets.map((sheet) => {
    const name = sheet.name;
    if (typeof name !== 'string' || name.length === 0) {
      throw new ValidationError('工作表名必须是非空字符串');
    }
    if (seenSheets.has(name)) {
      throw new ValidationError(`工作表重名：${JSON.stringify(name)}`);
    }
    seenSheets.add(name);
    if (!Array.isArray(sheet.cells)) {
      throw new ValidationError(`工作表 ${name} 的 cells 必须是数组`);
    }
    const seenRefs = new Set<string>();
    const cells: NormalizedCell[] = sheet.cells.map((cell: PlanCell) => {
      const ref = formatCellAddress(parseCellAddress(cell.ref));
      if (seenRefs.has(ref)) {
        // 同一格里出现两条定义，谁赢都是猜。显式报错，不静默取最后一个。
        throw new ValidationError(`工作表 ${name} 里单元格 ${ref} 重复声明`);
      }
      seenRefs.add(ref);
      let formula: string | undefined;
      if (cell.formula !== undefined) {
        if (typeof cell.formula !== 'string') {
          throw new ValidationError(`单元格 ${name}!${ref} 的 formula 必须是字符串`);
        }
        formula = cell.formula.startsWith('=') ? cell.formula.slice(1) : cell.formula;
      }
      return { ref, address: parseCellAddress(ref), formula };
    });
    cells.sort((a, b) => a.address.row - b.address.row || a.address.column - b.address.column);
    return { name, cells };
  });
}

function compareKeys(a: CellKey, b: CellKey): number {
  return a.localeCompare(b);
}

/**
 * 从计划输入构建依赖图、顺序与环清单（纯函数，不改输入）。
 *
 * @throws {ValidationError} 输入形状非法、工作表重名、单元格重复声明、命名引用非法
 */
export function buildRecalcPlan(input: PlanInput): RecalcPlan {
  const sheets = normalizeSheets(input);
  const sheetOrder = sheets.map((sheet) => sheet.name);
  const knownSheets = new Set(sheetOrder);
  const table = normalizeNamedReferences(input.names ?? []);
  const missingSheets = new Set<string>();

  // 全部公式格（表顺序、行、列），以及按表分组的候选（区域覆盖只需要比同表 / 目标表的公式格）。
  const keys: CellKey[] = [];
  const formulaCells: { readonly key: CellKey; readonly sheet: string; readonly ref: string; readonly text: string }[] = [];
  for (const sheet of sheets) {
    for (const cell of sheet.cells) {
      if (cell.formula === undefined) continue;
      const key = cellKey(sheet.name, cell.address);
      keys.push(key);
      formulaCells.push({ key, sheet: sheet.name, ref: cell.ref, text: cell.formula });
    }
  }

  const bySheet = new Map<string, { readonly key: CellKey; readonly address: CellAddress }[]>();
  for (const cell of formulaCells) {
    const entry = { key: cell.key, address: parseCellAddress(cell.ref) };
    const list = bySheet.get(cell.sheet);
    if (list === undefined) {
      bySheet.set(cell.sheet, [entry]);
    } else {
      list.push(entry);
    }
  }

  const dependencies = new Map<CellKey, readonly CellKey[]>();
  const targetsByKey = new Map<CellKey, readonly DependencyTarget[]>();
  const formulaText = new Map<CellKey, string>();
  const namedUsage = new Map<CellKey, readonly string[]>();
  const unresolved = new Map<CellKey, string>();

  for (const cell of formulaCells) {
    const expansion = expandNamedReferences(cell.text, table, cell.sheet);
    formulaText.set(cell.key, expansion.text);
    if (expansion.used.length > 0) {
      namedUsage.set(cell.key, expansion.used);
    }

    // `scanDependencyTargets` 已把 `FormulaParseError` 转成 `null`（依赖未知）。
    const targets = scanDependencyTargets(expansion.text);

    if (targets === null) {
      unresolved.set(cell.key, `公式语法超出本仓子集，引用目标无法枚举（依赖未知）`);
      dependencies.set(cell.key, Object.freeze([]));
      targetsByKey.set(cell.key, Object.freeze([]));
      continue;
    }

    const found = new Set<CellKey>();
    for (const target of targets) {
      const targetSheet = target.sheet ?? cell.sheet;
      if (!knownSheets.has(targetSheet)) {
        missingSheets.add(targetSheet);
        continue;
      }
      for (const candidate of bySheet.get(targetSheet) ?? []) {
        if (targetCovers(target, cell.sheet, targetSheet, candidate.address)) {
          found.add(candidate.key);
        }
      }
    }
    dependencies.set(cell.key, Object.freeze([...found].sort(compareKeys)));
    targetsByKey.set(cell.key, targets);
  }

  const precedentLists = new Map<CellKey, CellKey[]>();
  for (const key of keys) {
    precedentLists.set(key, []);
  }
  for (const key of keys) {
    for (const dependency of dependencies.get(key) ?? []) {
      precedentLists.get(dependency)?.push(key);
    }
  }
  const precedents = new Map<CellKey, readonly CellKey[]>();
  for (const [key, list] of precedentLists) {
    precedents.set(key, Object.freeze([...list].sort(compareKeys)));
  }

  const crossSheetDependencies: CrossSheetEdge[] = [];
  for (const cell of formulaCells) {
    for (const dependency of dependencies.get(cell.key) ?? []) {
      if (sheetNameOf(dependency) !== cell.sheet) {
        crossSheetDependencies.push({ from: cell.key, to: dependency });
      }
    }
  }
  crossSheetDependencies.sort((a, b) => compareKeys(a.from, b.from) || compareKeys(a.to, b.to));

  const cycles = classifyCycles(keys, dependencies);
  const cycleOf = new Map<CellKey, number>();
  cycles.forEach((cycle, at) => {
    for (const member of cycle.members) {
      cycleOf.set(member, at);
    }
  });

  const excluded = new Set<CellKey>(cycleOf.keys());
  for (const key of unresolved.keys()) {
    excluded.add(key);
  }
  const order = topoOrder(keys, dependencies, excluded);

  return Object.freeze({
    sheetOrder: Object.freeze([...sheetOrder]),
    keys: Object.freeze([...keys]),
    dependencies,
    precedents: precedents as ReadonlyMap<CellKey, readonly CellKey[]>,
    crossSheetDependencies: Object.freeze(crossSheetDependencies.map((edge) => Object.freeze(edge))),
    targets: targetsByKey,
    formulaText,
    namedUsage,
    unresolved,
    missingSheets: Object.freeze([...missingSheets].sort()),
    cycles,
    cycleOf,
    order,
  });
}

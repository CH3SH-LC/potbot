/**
 * **X-R03 → src**：把 {@link SparseOperation} 落到一张 {@link SheetState} 上执行。
 *
 * 这一层把 schema（形状）与 `sparse.ts`（算法）接起来：预算字段在这里翻译成 `RunGuard`，
 * 操作分派到这里，结果按 {@link SparseOperationResult} 归一化返回。测试走的就是
 * 「给请求 → 得到结果 / 得到错误」这条真实链路，而不是直接戳内部函数。
 */

import type { SheetState } from '../sheet.js';
import { RunGuard, estimateSheetMemory, iterateSparseCells, materializeDense } from './sparse.js';
import type {
  MaterializeResult,
  MemoryResult,
  ScanResult,
  SparseOperation,
  SparseOperationResult,
} from './schemas.js';

function smallestDefined(values: readonly (number | undefined)[]): number | undefined {
  let best: number | undefined;
  for (const value of values) {
    if (value !== undefined && (best === undefined || value < best)) {
      best = value;
    }
  }
  return best;
}

/**
 * 由扫描请求里的预算字段造一个 `RunGuard`（无预算则 `undefined`）。
 *
 * 时钟由调用方注入（`now`）——内核不读墙钟（R50.4），故此处**没有**默认时钟。
 */
export function guardFor(operation: SparseOperation, now: () => number): RunGuard | undefined {
  const budget = operation.budget;
  if (budget === undefined || (budget.max_cells === undefined && budget.max_milliseconds === undefined)) {
    return undefined;
  }
  return new RunGuard({
    now,
    ...(budget.max_cells === undefined ? {} : { max_cells: budget.max_cells }),
    ...(budget.max_milliseconds === undefined ? {} : { max_milliseconds: budget.max_milliseconds }),
  });
}

/**
 * 执行一条 X-R03 操作。`now` 是必填的注入时钟（内核不读墙钟，R50.4）；仅当操作带时间 / 格数
 * 预算时它才真正参与判定。
 * @throws {OperationCancelledError | BudgetExceededError | ValidationError}
 */
export function runSparseOperation(
  op: SparseOperation,
  sheet: SheetState,
  now: () => number,
): SparseOperationResult {
  if (op.operation === 'sparse.memory') {
    const estimate = estimateSheetMemory(sheet);
    const result: MemoryResult = {
      operation: 'sparse.memory',
      populated_cells: estimate.populated_cells,
      estimated_bytes: estimate.estimated_bytes,
      dense_grid_bytes: estimate.dense_grid_bytes,
      sparse_ratio: estimate.sparse_ratio,
    };
    return result;
  }

  if (op.operation === 'sparse.scan') {
    const guard = guardFor(op, now);
    const cells: { ref: string; row: number; column: number }[] = [];
    for (const cell of iterateSparseCells(sheet, op.range, guard)) {
      cells.push({ ref: cell.ref, row: cell.row, column: cell.column });
    }
    const result: ScanResult = { operation: 'sparse.scan', populated: cells.length, cells };
    return result;
  }

  // sparse.materialize：把 max_cells 与 budget 里的预算合成一个更严的格数上限。
  const maxCells = smallestDefined([op.max_cells, op.budget?.max_cells]);
  const maxMilliseconds = op.budget?.max_milliseconds;
  const grid = materializeDense(sheet, op.range, {
    now,
    ...(maxCells === undefined ? {} : { max_cells: maxCells }),
    ...(maxMilliseconds === undefined ? {} : { max_milliseconds: maxMilliseconds }),
  });
  const height = grid.length;
  const width = height === 0 ? 0 : (grid[0]?.length ?? 0);
  const result: MaterializeResult = {
    operation: 'sparse.materialize',
    height,
    width,
    area: height * width,
    grid: grid.map((line) => line.map((cell) => ({ kind: cell.kind }))),
  };
  return result;
}

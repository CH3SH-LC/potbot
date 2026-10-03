/**
 * **X-R03 → src**：大表、稀疏存储、内存 / 耗时 / 取消（正式内核模块）。
 *
 * 本文件是储备包 `tests/mobile-office/spreadsheets/X-R03/sparse.ts` 的**落地版**：
 * 接口原样搬到 `src/spreadsheets/sparse/`，供消费方（如 X-I03、导入 / 预览 / 重算路径）
 * **只读 import**，而不必再依赖 `tests/` 下的原型。
 *
 * ## 本模块回答什么
 *
 * 手机内核里一张工作表可能是 `1 048 576 × 16 384`（Excel 全网格 ≈ 1.7×10¹⁰ 格），
 * 但**真正有值的格**通常只有几千个。本模块让"扫描 / 统计 / 实体化"这三类操作
 * **按已填格数或窗口计费，而不是按网格面积计费**，并把三条硬闸门显式做出来：
 *
 * 1. **稀疏存储** —— 迭代只走 `SheetState.cells`（已填格），空格一个都不碰；
 * 2. **流式实体化** —— 密集二维数组按**行窗口**逐块产出（{@link streamDenseWindows} /
 *    {@link streamDenseRows}），**内存 ∝ 窗口大小**，而不是 ∝ 区域面积；因此**不再需要**
 *    旧的 `MAX_DENSE_CELLS` 硬上限（该常量已删除）。{@link materializeDense} 只是把窗口
 *    收成全量密集数组的便捷包装，大区域应直接用流式接口，或用预算 / 取消保护它。
 * 3. **耗时 / 取消** —— 每个格点 / 每行做一次协作式 `checkpoint`：外部 `AbortSignal` 一拉，
 *    或注入的时钟越过时间预算，迭代在下一次检查点立即抛错停止，不做无界长跑。
 *
 * ## 契约（消费方只看这些）
 *
 * - 错误：{@link BudgetExceededError}（越格数 / 耗时预算）、{@link OperationCancelledError}（取消）、
 *   `ValidationError`（输入非法）。
 * - {@link RunGuard.checkpoint} 顺序**固定**：先取消、再格数、后耗时。
 * - 时钟**必须注入**（`RunGuardOptions.now` 为必填）——内核不读墙钟（R50.4）。测试传假时钟 ⇒
 *   时间预算触发确定、可复现，不靠 sleep 撞运气；缺时钟的调用方应显式补上，而不是让内核兜底。
 *
 * ## 确定性
 *
 * 内核纪律是 `src/**` 零墙钟副作用：本模块**自己不读任何时钟**，所有与时间相关的判定
 * 都由调用方通过注入的 `now` 决定；不依赖真实时间即可得到稳定结果。
 */

import { ValidationError } from '../../protocol/index.js';
import type { SheetState } from '../sheet.js';
import {
  parseCellAddress,
  parseRange,
  rangeContainsAddress,
  type CellRange,
} from '../reference.js';
import { blank as BLANK, type CellValue } from '../value.js';

/** 迭代 / 实体化的输入区域：`CellRange` 或 A1 文本。 */
export type RangeInput = CellRange | string;

// ---------------------------------------------------------------------------
// 取消
// ---------------------------------------------------------------------------

/** 操作被调用方取消（`AbortSignal` 拉响或 `cancel()` 被调）。 */
export class OperationCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationCancelledError';
  }
}

/** 操作超出格数 / 时间预算。 */
export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

/** 只读取消令牌：`throwIfCancelled()` 在已取消时抛 `OperationCancelledError`。 */
export interface CancelToken {
  readonly cancelled: boolean;
  readonly reason: string | undefined;
  throwIfCancelled(): void;
}

/** 可写取消控制器，同时是 {@link CancelToken}。 */
export interface CancelController extends CancelToken {
  cancel(reason?: string): void;
}

/**
 * 造一个取消控制器。内部持有一个**真实** `AbortController`，因此与 Node / 浏览器
 * 原生可取消 API 互通，而不是自造一个只有本模块认识的布尔开关。
 */
export function createCancelController(reason?: string): CancelController {
  const controller = new AbortController();
  if (reason !== undefined) {
    controller.abort(reason);
  }
  return {
    get cancelled() {
      return controller.signal.aborted;
    },
    get reason() {
      const value = controller.signal.reason;
      return typeof value === 'string' ? value : undefined;
    },
    throwIfCancelled() {
      if (controller.signal.aborted) {
        const why = controller.signal.reason;
        throw new OperationCancelledError(
          `操作已取消${typeof why === 'string' && why.length > 0 ? `：${why}` : ''}`,
        );
      }
    },
    cancel(next?: string) {
      if (!controller.signal.aborted) {
        controller.abort(next);
      }
    },
  };
}

/** 把一个外部 `AbortSignal` 包成本模块的令牌（不拥有它，只观察）。 */
export function cancelTokenFromSignal(signal: AbortSignal): CancelToken {
  return {
    get cancelled() {
      return signal.aborted;
    },
    get reason() {
      const value = signal.reason;
      return typeof value === 'string' ? value : undefined;
    },
    throwIfCancelled() {
      if (signal.aborted) {
        throw new OperationCancelledError(
          `操作已取消${typeof signal.reason === 'string' && signal.reason.length > 0 ? `：${signal.reason}` : ''}`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 预算 / 检查点
// ---------------------------------------------------------------------------

/** 一次受控运行的预算（任一字段缺省表示该维度不设限）。 */
export interface RunBudget {
  /** 允许访问的格数上限。 */
  readonly max_cells?: number;
  /** 允许消耗的墙钟毫秒上限（用注入时钟计量）。 */
  readonly max_milliseconds?: number;
}

/** `RunGuard` 选项。 */
export interface RunGuardOptions extends RunBudget {
  /** 取消令牌；已取消时任何检查点立即抛 `OperationCancelledError`。 */
  readonly token?: CancelToken;
  /**
   * 时钟（毫秒）——**必填**。内核不读墙钟（R50.4）：时间由调用方注入，测试传假时钟即可
   * 获得确定性；缺时钟的调用方应改调用方，而不是让内核回落到 `Date.now`。
   */
  readonly now: () => number;
}

function requireBudgetNumber(value: number, where: string, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new ValidationError(`${where} 必须是 ≥${String(min)} 的有限数，收到 ${String(value)}`);
  }
  return value;
}

/**
 * 协作式运行守卫：把"格数"与"耗时"两个预算和取消令牌合成**一个**检查点。
 *
 * 语义（顺序固定，测试据此断言）：
 * 1. 先看**取消**——用户/上级取消优先于预算；
 * 2. 再累加 `cost` 到格数计数，超 `max_cells` ⇒ `BudgetExceededError`；
 * 3. 最后看**耗时**，超 `max_milliseconds` ⇒ `BudgetExceededError`。
 */
export class RunGuard {
  private cells = 0;
  private readonly start: number;
  private readonly maxCells: number | undefined;
  private readonly maxMilliseconds: number | undefined;
  private readonly token: CancelToken | undefined;
  private readonly clock: () => number;

  constructor(options: RunGuardOptions) {
    this.maxCells =
      options.max_cells === undefined ? undefined : requireBudgetNumber(options.max_cells, 'max_cells', 0);
    this.maxMilliseconds =
      options.max_milliseconds === undefined
        ? undefined
        : requireBudgetNumber(options.max_milliseconds, 'max_milliseconds', 0);
    this.token = options.token;
    // 时钟**直接取注入值**：不再有 `Date.now` 兜底（R50.4 内核零墙钟）。
    this.clock = options.now;
    this.start = this.clock();
  }

  /** 已计入的格数。 */
  get cells_visited(): number {
    return this.cells;
  }

  /** 自创建起注入时钟走过的毫秒数。 */
  get elapsed_ms(): number {
    return this.clock() - this.start;
  }

  /**
   * 过一个检查点。`cost` 为该检查点代表的格数（默认 1；纯时间/取消探测用 0）。
   * @throws {OperationCancelledError} 已取消
   * @throws {BudgetExceededError} 越格数或耗时预算
   */
  checkpoint(cost = 1): void {
    this.token?.throwIfCancelled();
    this.cells += cost;
    if (this.maxCells !== undefined && this.cells > this.maxCells) {
      throw new BudgetExceededError(
        `超出格数预算：已访问 ${String(this.cells)} 格 > 上限 ${String(this.maxCells)}`,
      );
    }
    if (this.maxMilliseconds !== undefined) {
      const elapsed = this.elapsed_ms;
      if (elapsed > this.maxMilliseconds) {
        throw new BudgetExceededError(
          `超出耗时预算：已用 ${String(elapsed)} ms > 上限 ${String(this.maxMilliseconds)} ms`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 稀疏扫描
// ---------------------------------------------------------------------------

/** 一个已填单元格（带已解析的行列坐标，省得调用方再 parse 一次）。 */
export interface SparseCell {
  readonly ref: string;
  readonly row: number;
  readonly column: number;
  readonly value: CellValue;
}

function resolveRange(range: RangeInput): CellRange {
  return typeof range === 'string' ? parseRange(range) : range;
}

/** 区域面积（格数）。@throws {ValidationError} 区域非法 */
export function rangeArea(range: RangeInput): number {
  const resolved = resolveRange(range);
  return (resolved.end.row - resolved.start.row + 1) * (resolved.end.column - resolved.start.column + 1);
}

/**
 * 取区域内**全部已填格**，按行主序（行升序、同行列升序）稳定排序。
 *
 * 复杂度与内存都 ∝ 已填格数，**与区域面积无关**：扫的是 `sheet.cells`（只有已填格），
 * 不是逐个 grid 坐标去查表。这正是"稀疏存储"在本模块的落地点。
 *
 * @param range 缺省表示整表。
 */
export function sparseCellsInRange(sheet: SheetState, range?: RangeInput): readonly SparseCell[] {
  const resolved = range === undefined ? undefined : resolveRange(range);
  const out: SparseCell[] = [];
  for (const [ref, value] of sheet.cells) {
    const address = parseCellAddress(ref);
    if (
      resolved !== undefined &&
      !rangeContainsAddress(resolved, { column: address.column, row: address.row })
    ) {
      continue;
    }
    out.push({ ref, row: address.row, column: address.column, value });
  }
  out.sort((a, b) => (a.row !== b.row ? a.row - b.row : a.column - b.column));
  return Object.freeze(out);
}

/**
 * 带检查点的稀疏迭代（生成器）：逐格 `yield` 前过一个检查点。
 *
 * 为什么要生成器而不是先返回数组：长扫描中途拉 `AbortSignal` 时，**下一次 `yield` 就停**，
 * 调用方不必等整个数组先建完。排序在生成器启动时一次性完成（`O(n log n)`），
 * 用于保证顺序确定；排序本身不可中断，但已填格数远小于面积，代价可忽略。
 *
 * @throws {OperationCancelledError} / {@link BudgetExceededError} 见 {@link RunGuard.checkpoint}
 */
export function* iterateSparseCells(
  sheet: SheetState,
  range?: RangeInput,
  guard?: RunGuard,
): Generator<SparseCell, void, void> {
  const cells = sparseCellsInRange(sheet, range);
  for (const cell of cells) {
    guard?.checkpoint(1);
    yield cell;
  }
}

/** 区域内已填格数。稀疏：只数已填格，不建数组。 */
export function countPopulated(sheet: SheetState, range?: RangeInput): number {
  return sparseCellsInRange(sheet, range).length;
}

// ---------------------------------------------------------------------------
// 密集实体化：行窗口流式
// ---------------------------------------------------------------------------

/**
 * 一个行窗口：`rows[i]` 是绝对行 `start_row + i` 的一整行。
 * 每行长度 = 区域宽度；空格填 {@link BLANK} 单例（不新建对象）。
 */
export interface DenseWindow {
  readonly start_row: number;
  readonly rows: readonly (readonly CellValue[])[];
}

/** 流式选项。 */
export interface StreamOptions {
  /** 每个窗口的行数；缺省 {@link DEFAULT_WINDOW_ROWS}。必须是 ≥1 的整数。 */
  readonly window_rows?: number;
  /** 运行守卫（取消 / 格数 / 耗时预算）；每行按区域宽度计费。 */
  readonly guard?: RunGuard;
}

/** 缺省窗口行数：64 行一块，兼顾吞吐与内存上界。 */
export const DEFAULT_WINDOW_ROWS = 64;

function normalizeWindowRows(value: number | undefined): number {
  const rows = value ?? DEFAULT_WINDOW_ROWS;
  if (!Number.isInteger(rows) || rows < 1) {
    throw new ValidationError(`window_rows 必须是 ≥1 的整数，收到 ${String(value)}`);
  }
  return rows;
}

/** 把区域内已填格按行分桶，供流式逐行 O(1) 取值（只扫已填格，不扫网格）。 */
function groupPopulatedByRow(sheet: SheetState, resolved: CellRange): Map<number, Map<number, CellValue>> {
  const byRow = new Map<number, Map<number, CellValue>>();
  for (const [ref, value] of sheet.cells) {
    const address = parseCellAddress(ref);
    if (!rangeContainsAddress(resolved, { column: address.column, row: address.row })) {
      continue;
    }
    let rowMap = byRow.get(address.row);
    if (rowMap === undefined) {
      rowMap = new Map<number, CellValue>();
      byRow.set(address.row, rowMap);
    }
    rowMap.set(address.column, value);
  }
  return byRow;
}

function buildRow(byRow: Map<number, Map<number, CellValue>>, row: number, startColumn: number, width: number): CellValue[] {
  const rowMap = byRow.get(row);
  const line = new Array<CellValue>(width);
  for (let offset = 0; offset < width; offset += 1) {
    line[offset] = rowMap?.get(startColumn + offset) ?? BLANK;
  }
  return line;
}

/**
 * 把区域按**行窗口**流式产出（生成器），**不预分配整片密集网格**。
 *
 * 关键性质：内存上界 ∝ `window_rows × 区域宽度`，**与区域高度无关**。因此
 * 全网格尺寸（1 048 576 行）的区域也能"取第一行"在常数时间内完成——这正是
 * 删除 `MAX_DENSE_CELLS` 硬上限的依据：不再需要"先算面积、超限就拒不分配"，
 * 因为根本不整片分配。
 *
 * 依次产出窗口；末窗可为不满 {@link StreamOptions.window_rows} 的部分窗口。
 * 每个窗口起点 `start_row` 是绝对行号（1 起）。
 *
 * @throws {ValidationError} 区域 / `window_rows` 非法
 * @throws {OperationCancelledError} / {@link BudgetExceededError} 见 {@link RunGuard.checkpoint}
 */
export function* streamDenseWindows(
  sheet: SheetState,
  range: RangeInput,
  options: StreamOptions = {},
): Generator<DenseWindow, void, void> {
  const resolved = resolveRange(range);
  const windowRows = normalizeWindowRows(options.window_rows);
  const width = resolved.end.column - resolved.start.column + 1;
  const guard = options.guard;
  const byRow = groupPopulatedByRow(sheet, resolved);

  let buffer: (readonly CellValue[])[] = [];
  let windowStart = resolved.start.row;
  for (let row = resolved.start.row; row <= resolved.end.row; row += 1) {
    guard?.checkpoint(width);
    if (buffer.length === 0) {
      windowStart = row;
    }
    buffer.push(Object.freeze(buildRow(byRow, row, resolved.start.column, width)));
    if (buffer.length >= windowRows) {
      yield Object.freeze({ start_row: windowStart, rows: Object.freeze(buffer) });
      buffer = [];
    }
  }
  if (buffer.length > 0) {
    yield Object.freeze({ start_row: windowStart, rows: Object.freeze(buffer) });
  }
}

/**
 * 单行流式：每次 `yield` 一整行（`streamDenseWindows` 的 `window_rows = 1` 特例）。
 * 取消 / 预算粒度即为"一行"。
 */
export function* streamDenseRows(
  sheet: SheetState,
  range: RangeInput,
  options: Omit<StreamOptions, 'window_rows'> = {},
): Generator<readonly CellValue[], void, void> {
  for (const window of streamDenseWindows(sheet, range, { ...options, window_rows: 1 })) {
    for (const row of window.rows) {
      yield row;
    }
  }
}

/** `materializeDense` 选项。 */
export interface MaterializeOptions {
  /** 运行守卫（取消 / 时间预算）；给了它就忽略下面三个预算字段。 */
  readonly guard?: RunGuard;
  /** 便捷预算：允许访问的格数上限；缺省不设限（用流式接口可避免整片驻留）。 */
  readonly max_cells?: number;
  /** 便捷预算：允许消耗的毫秒上限（注入时钟）。 */
  readonly max_milliseconds?: number;
  /** 取消令牌。 */
  readonly token?: CancelToken;
  /**
   * 时钟（毫秒）。当这里给出任一预算 / 令牌而**未**给 {@link MaterializeOptions.guard} 时
   * **必给**——内核不读墙钟，缺时钟即抛 `ValidationError`（把设计缺口说出来，而非回落到 `Date.now`）。
   */
  readonly now?: () => number;
}

function guardFromOptions(options: MaterializeOptions): RunGuard | undefined {
  if (options.guard !== undefined) {
    return options.guard;
  }
  const hasBudget =
    options.max_cells !== undefined ||
    options.max_milliseconds !== undefined ||
    options.token !== undefined;
  if (!hasBudget) {
    return undefined;
  }
  const now = options.now;
  if (now === undefined) {
    throw new ValidationError(
      'materializeDense 用预算 / 令牌构造 RunGuard 时必须注入时钟 now（内核不读墙钟，R50.4）',
    );
  }
  return new RunGuard({
    now,
    ...(options.max_cells === undefined ? {} : { max_cells: options.max_cells }),
    ...(options.max_milliseconds === undefined ? {} : { max_milliseconds: options.max_milliseconds }),
    ...(options.token === undefined ? {} : { token: options.token }),
  });
}

/**
 * 把区域收成**全量**密集二维数组（空格填 {@link BLANK} 单例）。
 *
 * 这是 {@link streamDenseRows} 的便捷包装——**大区域请直接用流式接口**：本函数会真的
 * 把整片网格驻留内存，其安全边界由调用方给的预算（`max_cells` / `max_milliseconds` /
 * `token`）决定，而**不再**由任何硬编码常量决定（旧的 `MAX_DENSE_CELLS` 已删除）。
 *
 * 给定格数预算时，语义与"面积闸门"等价但更精确：按行累加，累计格数一旦越过上限即抛
 * `BudgetExceededError`（等同 `上限 < 区域面积` 时拒绝，且**不会**分配超过已消费行的内存）。
 *
 * @throws {ValidationError} 区域 / 预算取值非法
 * @throws {BudgetExceededError} 越格数或耗时预算
 * @throws {OperationCancelledError} 取消
 */
export function materializeDense(
  sheet: SheetState,
  range: RangeInput,
  options: MaterializeOptions = {},
): readonly (readonly CellValue[])[] {
  const guard = guardFromOptions(options);
  const grid: (readonly CellValue[])[] = [];
  for (const row of streamDenseRows(sheet, range, guard === undefined ? {} : { guard })) {
    grid.push(row);
  }
  return Object.freeze(grid);
}

// ---------------------------------------------------------------------------
// 内存估算
// ---------------------------------------------------------------------------

/** 一张表的内存估算（字节，启发式）。 */
export interface SheetMemoryEstimate {
  readonly populated_cells: number;
  /** 稀疏存储下这些已填格的估算字节。 */
  readonly estimated_bytes: number;
  /** 若把整网格实体化会占的字节（`行×列×8`，仅作对照）。 */
  readonly dense_grid_bytes: number;
  /** `estimated_bytes / dense_grid_bytes`（越小越稀疏）。 */
  readonly sparse_ratio: number;
}

/** 单个 Map 条目 + 对象头的粗略固定开销（字节）。 */
const PER_CELL_OVERHEAD = 64;

function valuePayloadBytes(value: CellValue): number {
  switch (value.kind) {
    case 'text':
      return value.value.length * 2;
    case 'formula':
      return value.text.length * 2;
    case 'number':
    case 'date':
      return 8;
    case 'boolean':
      return 4;
    case 'error':
      return value.code.length * 2;
    case 'blank':
      return 0;
    default: {
      const never: never = value;
      throw new ValidationError(`estimateSheetMemory 未覆盖的类别：${JSON.stringify(never)}`);
    }
  }
}

/**
 * 估算一张表的驻留字节。关键性质：**只随已填格数与各格负载增长，
 * 不随 `row_count × column_count` 增长**——这正是稀疏存储要证明的。
 */
export function estimateSheetMemory(sheet: SheetState): SheetMemoryEstimate {
  let bytes = 200; // 表级固定开销（名字、尺寸字段、合并区数组等）
  for (const [ref, value] of sheet.cells) {
    bytes += PER_CELL_OVERHEAD + ref.length * 2 + valuePayloadBytes(value);
  }
  const dense = sheet.row_count * sheet.column_count * 8;
  return Object.freeze({
    populated_cells: sheet.cells.size,
    estimated_bytes: bytes,
    dense_grid_bytes: dense,
    sparse_ratio: dense === 0 ? 0 : bytes / dense,
  });
}

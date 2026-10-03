/**
 * **X-R03**：大表、稀疏存储、内存 / 耗时 / 取消。
 *
 * 十组判据。核心不是"跑得动"，而是**在真会炸的地方给出明确错误、在真稀疏的地方
 * 只按已填格 / 窗口计费**：
 *
 * 1. 稀疏扫描只走已填格（与网格面积无关）；
 * 2. 区域过滤（含边界）；
 * 3. 顺序确定性（插入顺序无关，行主序）；
 * 4. 密集实体化正确性（空洞填 `blank` **单例**，原值与位置分别正确）；
 * 5. **行窗口流式**：`MAX_DENSE_CELLS` 硬上限已删除，改由流式承载内存上界
 *    （全网格尺寸也能秒取首行）；预算 / 取消在流上生效；
 * 6. 格数预算：越界即抛，且报出真实已访问格数；
 * 7. 取消：协作式取消、真实 `AbortSignal`、取消**优先于**预算；
 * 8. 耗时预算：用**注入假时钟**确定性地触发；
 * 9. 内存估算随已填格数而非几何增长；
 * 10. schema 校验（未知字段/版本/操作/取值一律报错）与端到端分派。
 *
 * 反面对照贯穿其中：越预算的路径必须**抛**，不能静默返回一个"看起来对"的小数组。
 *
 * **模块来源**：本轮把储备原型提升为正式模块 `src/spreadsheets/sparse/`，本测试从
 * 该模块的**公开入口** `index.js` import（不再依赖同目录原型文件）。
 */

import { describe, expect, it } from 'vitest';

import { createSheet, setCellValue, type SheetState } from '../../../../src/spreadsheets/sheet.js';
import { MAX_COLUMN_NUMBER, MAX_ROW_NUMBER } from '../../../../src/spreadsheets/reference.js';
import { blank, numberValue, textValue } from '../../../../src/spreadsheets/value.js';

import * as sparseModule from '../../../../src/spreadsheets/sparse/index.js';
import {
  BudgetExceededError,
  DEFAULT_WINDOW_ROWS,
  OperationCancelledError,
  RunGuard,
  XR03_SCHEMA_VERSION,
  cancelTokenFromSignal,
  countPopulated,
  createCancelController,
  estimateSheetMemory,
  iterateSparseCells,
  materializeDense,
  parseSparseOperation,
  rangeArea,
  runSparseOperation,
  sparseCellsInRange,
  streamDenseRows,
  streamDenseWindows,
} from '../../../../src/spreadsheets/sparse/index.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** Excel 全网格尺寸（行 × 列）。 */
const FULL_ROWS = MAX_ROW_NUMBER; // 1 048 576
const FULL_COLS = MAX_COLUMN_NUMBER; // 16 384
const FULL_GRID_AREA = FULL_ROWS * FULL_COLS; // 17 179 869 184

/** 一张远大于己身内容的"大表"：全网格尺寸，但只填 `populated` 个散点。 */
function largeSparseSheet(populated: number): SheetState {
  let sheet = createSheet('Big', { row_count: FULL_ROWS, column_count: FULL_COLS });
  for (let i = 0; i < populated; i += 1) {
    const row = i * 300 + 1; // ≤ 1 048 576
    const column = (i % 200) + 1;
    sheet = setCellValue(sheet, { column, row }, numberValue(i));
  }
  return sheet;
}

/** 一个 A1 地址文本（列号 1 起）。 */
function refOf(column: number, row: number): string {
  let n = column;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return `${letters}${String(row)}`;
}

/** 全网格区域文本 `A1:XFD1048576`。 */
const FULL_RANGE = `${refOf(1, 1)}:${refOf(FULL_COLS, FULL_ROWS)}`;

/**
 * 注入时钟：内核**不读墙钟**（R50.4），`RunGuard` / `runSparseOperation` 现在要求显式注入。
 * 这些用例只判格数 / 取消，故给一个恒定假时钟即可（时间预算另有专门用例注入可控时钟）。
 */
const fakeClock = (): number => 0;

// ---------------------------------------------------------------------------

describe('X-R03 §1 稀疏扫描只按已填格计费', () => {
  it('全网格尺寸的表只填 3000 格：扫描恰好返回 3000 格，面积是它的 570 万倍', () => {
    const sheet = largeSparseSheet(3000);
    const all = sparseCellsInRange(sheet);
    expect(all).toHaveLength(3000);
    expect(countPopulated(sheet)).toBe(3000);
    // 区域面积巨大
    expect(rangeArea(FULL_RANGE)).toBe(FULL_GRID_AREA);
    expect(all.length * 1_000_000).toBeLessThan(FULL_GRID_AREA);
  });

  it('迭代产出与扫描一致（生成器不丢格、不重复）', () => {
    const sheet = largeSparseSheet(500);
    const viaIterator = [...iterateSparseCells(sheet)].map((c) => c.ref);
    const viaScan = sparseCellsInRange(sheet).map((c) => c.ref);
    expect(viaIterator).toEqual(viaScan);
    expect(new Set(viaIterator).size).toBe(500);
  });

  it('反面对照：带格数预算去实体化全网格 ⇒ 在分配整片之前就被预算拦下', () => {
    const sheet = largeSparseSheet(3000);
    // 旧的 MAX_DENSE_CELLS 硬闸门已删除；保护改由**显式预算**承担。
    expect(() => materializeDense(sheet, FULL_RANGE, { max_cells: 1000, now: fakeClock })).toThrow(
      BudgetExceededError,
    );
  });
});

describe('X-R03 §2 区域过滤（含边界）', () => {
  it('只返回落在区域内（含四边）的已填格', () => {
    let sheet = createSheet('S', { row_count: 100, column_count: 100 });
    sheet = setCellValue(sheet, 'A1', numberValue(1)); // 区域外的左上
    sheet = setCellValue(sheet, 'B2', numberValue(2)); // 左上角（含）
    sheet = setCellValue(sheet, 'C3', numberValue(3)); // 内部
    sheet = setCellValue(sheet, 'D4', numberValue(4)); // 右下角（含）
    sheet = setCellValue(sheet, 'E5', numberValue(5)); // 区域外的右下

    const inside = sparseCellsInRange(sheet, 'B2:D4');
    expect(inside.map((c) => c.ref)).toEqual(['B2', 'C3', 'D4']);
    expect(countPopulated(sheet, 'B2:D4')).toBe(3);
    // 区域面积 3×3=9，但只有 3 格有值 ⇒ 稀疏比 1/3
    expect(rangeArea('B2:D4')).toBe(9);
  });

  it('空区域返回空数组（不是 null、不是异常）', () => {
    const sheet = createSheet('S', { row_count: 10, column_count: 10 });
    expect(sparseCellsInRange(sheet, 'A1:J10')).toEqual([]);
  });
});

describe('X-R03 §3 顺序确定性（插入顺序无关）', () => {
  it('两种不同插入顺序得到逐项相同的行主序序列', () => {
    const refs: [string, number][] = [
      ['C1', 31],
      ['A1', 11],
      ['B3', 23],
      ['A3', 13],
      ['B1', 21],
    ];
    const forward = refs.reduce(
      (s, [ref, v]) => setCellValue(s, ref, numberValue(v)),
      createSheet('F', { row_count: 10, column_count: 10 }),
    );
    const backward = [...refs].reverse().reduce(
      (s, [ref, v]) => setCellValue(s, ref, numberValue(v)),
      createSheet('B', { row_count: 10, column_count: 10 }),
    );
    const order = (sheet: SheetState) => sparseCellsInRange(sheet).map((c) => c.ref);
    expect(order(forward)).toEqual(['A1', 'B1', 'C1', 'A3', 'B3']);
    expect(order(forward)).toEqual(order(backward));
  });
});

describe('X-R03 §4 密集实体化正确性（空洞填 blank 单例）', () => {
  it('B2:D4 里只有 C3 有值：空洞全等于 blank 单例，值落在正确偏移', () => {
    let sheet = createSheet('S', { row_count: 10, column_count: 10 });
    sheet = setCellValue(sheet, 'C3', textValue('hit'));
    const grid = materializeDense(sheet, 'B2:D4');
    expect(grid).toHaveLength(3);
    for (const line of grid) expect(line).toHaveLength(3);
    // 空洞是同一个 blank 对象（不新建、可 === 判等）
    const flat = grid.flat();
    for (const cell of flat) if (cell.kind === 'blank') expect(cell).toBe(blank);
    // C3 在区域里的偏移是 (row=1, col=1)
    expect(grid[1]?.[1]).toEqual({ kind: 'text', value: 'hit' });
    // 起点 B2 无值 ⇒ blank
    expect(grid[0]?.[0]).toBe(blank);
  });

  it('格数预算刚好等于面积 ⇒ 成功；面积 = 上限 + 1 ⇒ 拒绝（边界精确）', () => {
    const sheet = createSheet('S', { row_count: 10, column_count: 10 });
    // 2×2 = 4
    expect(materializeDense(sheet, 'A1:B2', { max_cells: 4, now: fakeClock })).toHaveLength(2);
    expect(() => materializeDense(sheet, 'A1:B2', { max_cells: 3, now: fakeClock })).toThrow(
      BudgetExceededError,
    );
  });
});

describe('X-R03 §5 行窗口流式：MAX_DENSE_CELLS 已删除，内存 ∝ 窗口', () => {
  it('模块不再导出 MAX_DENSE_CELLS（硬闸门已由流式取代）', () => {
    expect('MAX_DENSE_CELLS' in sparseModule).toBe(false);
  });

  it('全网格尺寸区域的**首行**可在毫秒级取出（流式，不预分配整片网格）', () => {
    const sheet = largeSparseSheet(3000);
    const started = Date.now();
    const first = streamDenseRows(sheet, FULL_RANGE).next();
    const elapsed = Date.now() - started;
    expect(first.done).toBe(false);
    if (first.done === true) {
      throw new Error('流式首行不应结束');
    }
    const row = first.value;
    expect(row).toHaveLength(FULL_COLS);
    // largeSparseSheet 的第 0 格落在 A1（值 0）；本行其余列全 blank 单例
    expect(row[0]).toEqual({ kind: 'number', value: 0 });
    expect(row[1]).toBe(blank);
    expect(row[FULL_COLS - 1]).toBe(blank);
    // 若实现仍是"先分配整片 1.7×10¹⁰ 格"，这里会挂死 / OOM，而不是 <1s 返回
    expect(elapsed).toBeLessThan(1000);
  });

  it('窗口流：window_rows=2 时窗口边界与末窗部分窗口正确', () => {
    let sheet = createSheet('W', { row_count: 5, column_count: 3 });
    sheet = setCellValue(sheet, 'A1', numberValue(1));
    sheet = setCellValue(sheet, 'C5', numberValue(5));
    const windows = [...streamDenseWindows(sheet, 'A1:C5', { window_rows: 2 })];
    expect(windows.map((w) => w.start_row)).toEqual([1, 3, 5]);
    expect(windows.map((w) => w.rows.length)).toEqual([2, 2, 1]);
    expect(windows[0]?.rows[0]?.[0]).toEqual({ kind: 'number', value: 1 });
    expect(windows[0]?.rows[0]?.[1]).toBe(blank);
    // 末窗第 5 行第 3 列是 C5
    expect(windows[2]?.rows[0]?.[2]).toEqual({ kind: 'number', value: 5 });
    // 默认窗口大小是一个正数常量
    expect(DEFAULT_WINDOW_ROWS).toBeGreaterThan(0);
  });

  it('反面：全网格流带格数预算 ⇒ 很快抛 BudgetExceededError，而不是静默跑到底', () => {
    const sheet = largeSparseSheet(3000);
    // 区域宽 16384；上限 100000 格 ⇒ 第 7 行累计 114688 越界
    const guard = new RunGuard({ max_cells: 100_000, now: fakeClock });
    let consumed = 0;
    let caught: unknown;
    const started = Date.now();
    try {
      for (const _row of streamDenseRows(sheet, FULL_RANGE, { guard })) {
        consumed += 1;
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BudgetExceededError);
    expect(consumed).toBe(6);
    expect(guard.cells_visited).toBe(7 * FULL_COLS);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('流式取消：全网格流消费 5 行后 cancel ⇒ 第 6 行检查点抛 OperationCancelledError', () => {
    const sheet = largeSparseSheet(3000);
    const controller = createCancelController();
    const guard = new RunGuard({ token: controller, now: fakeClock });
    let consumed = 0;
    let caught: unknown;
    try {
      for (const _row of streamDenseRows(sheet, FULL_RANGE, { guard })) {
        consumed += 1;
        if (consumed === 5) controller.cancel('表太大');
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OperationCancelledError);
    expect(consumed).toBe(5);
  });

  it('无预算的小区域流式与 materializeDense 结果逐格一致（流式是同一实现）', () => {
    let sheet = createSheet('S', { row_count: 4, column_count: 4 });
    sheet = setCellValue(sheet, 'B2', numberValue(7));
    sheet = setCellValue(sheet, 'D4', textValue('end'));
    const streamed = [...streamDenseRows(sheet, 'A1:D4')];
    const collected = materializeDense(sheet, 'A1:D4');
    expect(streamed).toEqual(collected);
  });
});

describe('X-R03 §6 格数预算', () => {
  it('扫描越格数上限即抛，并报出真实已访问格数', () => {
    const sheet = largeSparseSheet(3000);
    const guard = new RunGuard({ max_cells: 100, now: fakeClock });
    const seen: string[] = [];
    let caught: unknown;
    try {
      for (const cell of iterateSparseCells(sheet, undefined, guard)) {
        seen.push(cell.ref);
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BudgetExceededError);
    expect((caught as Error).message).toMatch(/格数预算/);
    // 消费到第 101 格时被拦下
    expect(seen).toHaveLength(100);
    expect(guard.cells_visited).toBe(101);
  });

  it('预算之内（max_cells = 3000）则全部走完', () => {
    const sheet = largeSparseSheet(3000);
    const guard = new RunGuard({ max_cells: 3000, now: fakeClock });
    expect([...iterateSparseCells(sheet, undefined, guard)]).toHaveLength(3000);
    expect(guard.cells_visited).toBe(3000);
  });
});

describe('X-R03 §7 取消', () => {
  it('协作式取消：消费 10 格后 cancel，下一次检查点抛 OperationCancelledError', () => {
    const sheet = largeSparseSheet(1000);
    const controller = createCancelController();
    const guard = new RunGuard({ token: controller, now: fakeClock });
    const seen: string[] = [];
    let caught: unknown;
    try {
      for (const cell of iterateSparseCells(sheet, undefined, guard)) {
        seen.push(cell.ref);
        if (seen.length === 10) controller.cancel('用户取消');
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OperationCancelledError);
    expect((caught as Error).message).toMatch(/用户取消/);
    expect(seen).toHaveLength(10);
  });

  it('真实 AbortSignal：abort 后 throwIfCancelled 立即抛', () => {
    const ac = new AbortController();
    const token = cancelTokenFromSignal(ac.signal);
    expect(token.cancelled).toBe(false);
    ac.abort('外部中止');
    expect(token.cancelled).toBe(true);
    expect(() => token.throwIfCancelled()).toThrow(OperationCancelledError);
  });

  it('取消优先于预算：已取消时抛取消错，而不是预算错', () => {
    const sheet = largeSparseSheet(1000);
    const controller = createCancelController('先取消');
    controller.cancel('先取消');
    // max_cells = 0：第一个检查点**同时**越预算与命中取消 ⇒ 顺序可判别（取消必须赢）
    const guard = new RunGuard({ max_cells: 0, token: controller, now: fakeClock });
    let caught: unknown;
    try {
      for (const _cell of iterateSparseCells(sheet, undefined, guard)) {
        // 不会到这里
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OperationCancelledError);
    expect(caught).not.toBeInstanceOf(BudgetExceededError);
  });
});

describe('X-R03 §8 耗时预算（注入假时钟，确定性）', () => {
  it('假时钟越过毫秒上限 ⇒ 抛耗时预算错', () => {
    const sheet = largeSparseSheet(1000);
    let clockValue = 0;
    const guard = new RunGuard({ max_milliseconds: 100, now: () => clockValue });
    const seen: string[] = [];
    let caught: unknown;
    try {
      for (const cell of iterateSparseCells(sheet, undefined, guard)) {
        seen.push(cell.ref);
        clockValue += 30; // 每格"耗时" 30ms，第 4 格后 > 100ms
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BudgetExceededError);
    expect((caught as Error).message).toMatch(/耗时预算/);
    expect(seen.length).toBeLessThanOrEqual(4);
  });

  it('冻结时钟：大扫描不会被耗时预算误伤（确定性）', () => {
    const sheet = largeSparseSheet(3000);
    const guard = new RunGuard({ max_milliseconds: 1, now: () => 12345 });
    expect([...iterateSparseCells(sheet, undefined, guard)]).toHaveLength(3000);
    expect(guard.elapsed_ms).toBe(0);
  });

  it('真实墙钟粗检：扫描 3000 格远快于 2 秒（稀疏，不按面积做功）', () => {
    const sheet = largeSparseSheet(3000);
    const started = Date.now();
    expect(countPopulated(sheet)).toBe(3000);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('X-R03 §9 内存估算随已填格数而非几何增长', () => {
  it('同样 50 格：几何放大 100 倍，估算字节不变、稀疏比反而更小', () => {
    const small = createSheet('S', { row_count: 100, column_count: 100 });
    let smallFilled = small;
    let bigFilled = createSheet('B', { row_count: 10_000, column_count: 10_000 });
    for (let i = 0; i < 50; i += 1) {
      const ref = refOf((i % 10) + 1, Math.floor(i / 10) + 1);
      smallFilled = setCellValue(smallFilled, ref, numberValue(i));
      bigFilled = setCellValue(bigFilled, ref, numberValue(i));
    }
    const a = estimateSheetMemory(smallFilled);
    const b = estimateSheetMemory(bigFilled);
    expect(a.populated_cells).toBe(50);
    expect(b.populated_cells).toBe(50);
    expect(a.estimated_bytes).toBe(b.estimated_bytes); // 只随已填格数
    expect(b.dense_grid_bytes).toBe(a.dense_grid_bytes * 10_000); // 几何变大
    expect(b.sparse_ratio).toBeLessThan(a.sparse_ratio);
  });

  it('已填格更多 ⇒ 估算更大；空表 = 固定表级开销', () => {
    const empty = createSheet('E', { row_count: FULL_ROWS, column_count: FULL_COLS });
    expect(estimateSheetMemory(empty).populated_cells).toBe(0);
    expect(estimateSheetMemory(empty).estimated_bytes).toBe(200);

    const few = largeSparseSheet(10);
    const many = largeSparseSheet(1000);
    expect(estimateSheetMemory(many).estimated_bytes).toBeGreaterThan(
      estimateSheetMemory(few).estimated_bytes,
    );
  });
});

describe('X-R03 §10 schema 校验与端到端分派', () => {
  it('合法请求被归一化；scan 无 range 合法', () => {
    const op = parseSparseOperation({ schemaVersion: '1', operation: 'sparse.scan' });
    expect(op.operation).toBe('sparse.scan');

    const withBudget = parseSparseOperation({
      schemaVersion: '1',
      operation: 'sparse.scan',
      range: 'A1:C3',
      budget: { max_cells: 10, max_milliseconds: 5 },
    });
    expect(withBudget.budget).toEqual({ max_cells: 10, max_milliseconds: 5 });
  });

  it('反面对照：版本 / 操作 / 未知字段 / 取值非法一律报错', () => {
    expect(() => parseSparseOperation({ schemaVersion: '2', operation: 'sparse.scan' })).toThrow(/schemaVersion/);
    expect(() => parseSparseOperation({ schemaVersion: '1', operation: 'sparse.explode' })).toThrow(/未知操作/);
    expect(() =>
      parseSparseOperation({ schemaVersion: '1', operation: 'sparse.scan', nope: 1 }),
    ).toThrow(/未知字段/);
    expect(() =>
      parseSparseOperation({ schemaVersion: '1', operation: 'sparse.scan', budget: { max_cells: -1 } }),
    ).toThrow(/max_cells/);
    expect(() =>
      parseSparseOperation({ schemaVersion: '1', operation: 'sparse.materialize' }),
    ).toThrow(/range/);
    expect(() =>
      parseSparseOperation({ schemaVersion: '1', operation: 'sparse.materialize', range: 'A1:B2', max_cells: 1.5 }),
    ).toThrow(/max_cells/);
    expect(() =>
      parseSparseOperation({ schemaVersion: '1', operation: 'sparse.scan', range: 'not-a-range' }),
    ).toThrow(/无法解析/);
    expect(() => parseSparseOperation('nope')).toThrow(/对象/);
  });

  it('端到端：parse → run，扫描只返回已填格坐标', () => {
    let sheet = createSheet('S', { row_count: 1000, column_count: 1000 });
    sheet = setCellValue(sheet, 'A1', numberValue(1));
    sheet = setCellValue(sheet, 'C5', numberValue(2));
    const op = parseSparseOperation({ schemaVersion: XR03_SCHEMA_VERSION, operation: 'sparse.scan' });
    const result = runSparseOperation(op, sheet, fakeClock);
    expect(result.operation).toBe('sparse.scan');
    if (result.operation === 'sparse.scan') {
      expect(result.populated).toBe(2);
      expect(result.cells.map((c) => c.ref)).toEqual(['A1', 'C5']);
      // 结果里不含格值对象（只回坐标，保持轻量）
      expect(Object.keys(result.cells[0] ?? {})).toEqual(['ref', 'row', 'column']);
    }
  });

  it('端到端：materialize 越格数预算抛 BudgetExceededError', () => {
    const sheet = createSheet('S', { row_count: 10, column_count: 10 });
    const op = parseSparseOperation({
      schemaVersion: '1',
      operation: 'sparse.materialize',
      range: 'A1:E5',
      max_cells: 10,
    });
    expect(() => runSparseOperation(op, sheet, fakeClock)).toThrow(BudgetExceededError);
  });

  it('端到端：materialize 预算 ≥ 面积 ⇒ 成功并给出 height/width/area', () => {
    let sheet = createSheet('S', { row_count: 10, column_count: 10 });
    sheet = setCellValue(sheet, 'B2', numberValue(9));
    const op = parseSparseOperation({
      schemaVersion: '1',
      operation: 'sparse.materialize',
      range: 'A1:C2',
      max_cells: 6,
    });
    const result = runSparseOperation(op, sheet, fakeClock);
    expect(result.operation).toBe('sparse.materialize');
    if (result.operation === 'sparse.materialize') {
      expect(result.height).toBe(2);
      expect(result.width).toBe(3);
      expect(result.area).toBe(6);
      expect(result.grid[1]?.[1]).toEqual({ kind: 'number' });
    }
  });

  it('端到端：memory 只回估算字段', () => {
    const sheet = largeSparseSheet(20);
    const op = parseSparseOperation({ schemaVersion: '1', operation: 'sparse.memory' });
    const result = runSparseOperation(op, sheet, fakeClock);
    expect(result.operation).toBe('sparse.memory');
    if (result.operation === 'sparse.memory') {
      expect(result.populated_cells).toBe(20);
      expect(result.estimated_bytes).toBeGreaterThan(0);
      expect(result.sparse_ratio).toBeLessThan(1);
    }
  });
});

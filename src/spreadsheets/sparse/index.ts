/**
 * `src/spreadsheets/sparse` 唯一公开出口（X-R03 落地）。
 *
 * 消费方（导入 / 预览 / 重算 / X-I03 等）**只从这个入口 import**，不要深挖内部文件路径。
 *
 * ## 接口总览（稳定面）
 *
 * - **稀疏扫描**（按已填格计费，与网格面积无关）
 *   - `sparseCellsInRange(sheet, range?)` → `readonly SparseCell[]`（行主序、已冻结）
 *   - `iterateSparseCells(sheet, range?, guard?)` → 生成器，逐格过检查点
 *   - `countPopulated(sheet, range?)`、`rangeArea(range)`
 * - **流式实体化**（按行窗口产出，内存 ∝ 窗口，而非面积）
 *   - `streamDenseRows(sheet, range, { guard? })` → 每次 `yield` 一整行
 *   - `streamDenseWindows(sheet, range, { window_rows?, guard? })` → 每次 `yield` 一个 `DenseWindow`
 *   - `materializeDense(sheet, range, { guard? | max_cells? | max_milliseconds? | token? | now? })`
 *     → 全量密集数组（便捷包装；**大区域请用流式接口**）。给出任一预算 / 令牌时必须同时给
 *     `now`（注入时钟，内核不读墙钟），否则显式抛 `ValidationError`
 *   - 空格一律是 `blank` 单例（可 `===` 判等）
 * - **内存估算**：`estimateSheetMemory(sheet)`（`estimated_bytes` 只随已填格增长）
 * - **预算 / 取消**：`RunGuard`（`checkpoint(cost)` 顺序固定：先取消、再格数、后耗时；
 *   `RunGuardOptions.now` 为**必填**的注入时钟）、
 *   `createCancelController()`、`cancelTokenFromSignal(signal)`
 * - **错误契约**：`BudgetExceededError` / `OperationCancelledError` / `ValidationError`
 * - **操作 schema**：`parseSparseOperation(input)` + `runSparseOperation(op, sheet)`
 *   （`sparse.scan` / `sparse.materialize` / `sparse.memory`）
 *
 * ## 与旧储备包的关系
 *
 * 本模块由 `tests/mobile-office/spreadsheets/X-R03/` 的原型**提升**而来，接口语义保持
 * 一致，唯一的行为变更是：**删除 `MAX_DENSE_CELLS` 硬上限**，改由行窗口流式承载内存上界
 * （见 `sparse.ts` 文件头）。因此 `MAX_DENSE_CELLS` **不再导出**。
 */

export * from './sparse.js';
export * from './schemas.js';
export * from './run.js';

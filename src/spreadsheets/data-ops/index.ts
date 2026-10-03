/**
 * `src/spreadsheets/data-ops` 出口（X05 / XLS-09 × XLS-10 组合层）。
 *
 * 两块：
 * - `operations.ts`：可序列化操作模式 + 反序列化 + 执行回执；
 * - `table-compose.ts`：结构化表格 × 排序 / 追加的跨模块组合；
 * - `xlsx-export.ts`：把排序 / 扩表结果写进**真实 .xlsx 字节**（XLS-09/10 文件边界）。
 *
 * 本目录**不**导出 `sort-filter.ts` / `structured-table.ts` 的既有符号——它们由
 * `src/spreadsheets/index.ts` 直接再导出，这里只提供其上的新层。
 */

export * from './operations.js';
export * from './table-compose.js';
export * from './xlsx-export.js';

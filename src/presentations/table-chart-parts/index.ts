/**
 * P06 · 表格 / 图表**部件与关系描述符**层的唯一出口。
 *
 * 分层：
 * - `parts.ts` —— 部件类别与内容类型、路径校验、关系登记图、表/图帧登记；
 * - `workbook.ts` —— 图表内嵌工作簿的部件清单与"缺件即报错"；
 * - `consistency.ts` —— 数值与图形一致性（A1 引用解析 + 逐点比对）；
 * - `merge-matrix.ts` —— 合并单元格覆盖矩阵（重叠 / 越界即报错）；
 * - `data-edit.ts` —— 数据变更时的同版更新（图形引用 / 工作簿格 / 版本同源）；
 * - `table-facts.ts` —— **表格侧同版事实**（表字面量 / 合并引用迁移 / 同一枚 `dc1-*` 指纹）；
 * - `errors.ts` —— 本层统一错误类型与原因枚举。
 *
 * 本模块**不**改写 `tables.ts` / `charts.ts` / `roundtrip.ts` / `render.ts`。本目录的公开出口
 * 已由 `src/presentations/index.ts` 再导出（integration，run-20261003-B）；调用方也可按目录
 * 路径 import。
 */

export * from './errors.js';
export * from './parts.js';
export * from './workbook.js';
export * from './consistency.js';
export * from './merge-matrix.js';
export * from './table-facts.js';
export * from './data-edit.js';

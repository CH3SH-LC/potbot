/**
 * `src/spreadsheets` 唯一公开出口（design-06-P8 增量一：表格域模型骨架）。
 *
 * ## 分层
 *
 * | 层 | 文件 | 回答的问题 |
 * |---|---|---|
 * | 取值 | `value.ts` | 一个单元格里到底是什么？（XLS-03 六类不互相冒充；R248 缺失不当零） |
 * | 坐标 | `reference.ts` | 这个引用指向哪？行列增删后它指向哪？（XLS-04） |
 * | 公式改写 | `formula.ts` | 这段公式文本能不能安全**改写**？不能就阻塞（XLS-06） |
 * | 公式求值 | `formula-parse.ts` / `evaluate.ts` | 这段公式**算出来是多少**？（XLS-08，受限子集） |
 * | 精度 | `quantity.ts` | 这笔钱精确是多少、什么单位？（XLS-17） |
 * | 工作表 | `sheet.ts` | 一张表的内容与结构变更（XLS-03/04/10） |
 * | 工作簿 | `workbook.ts` | 多张表与它们的关系（XLS-02；R250 不得只有一张固定表） |
 * | 日期 | `excel-date.ts` | Excel 序列号 ↔ epoch 毫秒（XLS-05/11） |
 * | **序列化** | `xlsx-write.ts` | 模型 → **真实 .xlsx 字节**（XLS-01/05/06/11/12） |
 * | **反序列化** | `xlsx-read.ts` | **真实 .xlsx 字节** → 模型（R249 未知部件保留） |
 *
 * ## 与模板层的关系
 *
 * 本层**import** `src/artifacts/templates/xlsx.ts` 的**部件骨架常量**（内容类型 / 命名空间 /
 * 关系类型 / 工作簿部件路径）——这是"复用既有骨架、不重复声明字面量"的刻意选择。
 * 方向是**单向**的：模板层不 import 本层，因此无循环依赖。
 * 模板层产出**一张固定的分项 / 合计表**，本层产出**任意工作簿**；两条路各自独立可验收。
 *
 * ## 与 `ooxml` 的关系
 *
 * 容器与 XML 原语全部来自 `src/artifacts/ooxml/**`（`assembleOpcPackage` / `writeZip` /
 * `el` / `attr` / `readZip`）与 `src/documents/docx/xml-parse.ts`（读侧对偶）。
 * 本层**不自己拼 XML 字符串、不自己写 / 读 ZIP**。
 */

export * from './value.js';
export * from './reference.js';
export * from './formula.js';
export * from './formula-parse.js';
export * from './evaluate.js';
export * from './quantity.js';
export * from './sheet.js';
export * from './workbook.js';
export * from './excel-date.js';
export * from './xlsx-write.js';
export * from './xlsx-read.js';

export * from './cells.js';
export * from './ranges.js';
// `styles.ts` 与 `conditional-format.ts` 各自定义了一个 `normalizeColor`（前者面向单元格样式颜色，
// 后者面向条件格式颜色），`export *` 会因二义性报 TS2308。这里对 `styles.ts` 用**显式具名导出**，
// 并把它的 `normalizeColor` 加后缀区分；条件格式那边保留原名（它的测试直接按原名 import）。
export {
  CURRENCY_SYMBOLS,
  MAX_STYLE_RANGE_CELLS,
  applyRangeStyle,
  clearCellStyle,
  clearRangeStyle,
  displayCell,
  emptyCellStyles,
  formatCellDisplay,
  formatDatePattern,
  getCellStyle,
  mergeCellStyle,
  migrateCellStyles,
  normalizeCellStyle,
  normalizeColor as normalizeStyleColor,
  setCellStyle,
  type CellBorderEdge,
  type CellBorderLineStyle,
  type CellBorders,
  type CellDisplay,
  type CellHorizontalAlign,
  type CellNumberFormat,
  type CellStyle,
  type CellStyles,
  type CellVerticalAlign,
  type CurrencyCode,
  type DateDisplayPattern,
} from './styles.js';
export * from './functions.js';
export * from './recalc.js';
export * from './sort-filter.js';
export * from './structured-table.js';
export * from './validation.js';
export * from './conditional-format.js';
export * from './xls-io.js';
export * from './print-layout.js';
export * from './history.js';

// 下面两个新模块与旧模块存在同名导出，`export *` 会二义（TS2308）。用**显式具名再导出**消歧
// （显式导出优先于星号导出）：
//   - `buildDrawingXml`：`charts.ts`（图表绘图）与 `objects.ts`（对象绘图）各有一个；取图表侧，
//     对象侧请直接从 `./objects.js` 具名导入。
//   - `PreservedRelationshipGroup`：`objects.ts` 与 `xlsx-write.ts` 各有一个；取写侧（既有公共名）。
export * from './charts.js';
export * from './objects.js';
export { buildDrawingXml } from './charts.js';
export { type PreservedRelationshipGroup } from './xlsx-write.js';
export * from './pivot.js';

export * from './formula-model.js';
export * from './formula-cache.js';

export * from './facts-binding.js';

export * from './package-assembly.js';

// ---------------------------------------------------------------------------
// run-20261003-B 六线批次：新增子模块并入公共出口（S05 集成）。
//
// 这些目录此前不在本桶内，消费方只能深链 `./<dir>/index.js`。逐个并入后，
// `import { ... } from 'src/spreadsheets'` 即可取用（`index.js` 后缀按 NodeNext 解析）。
// 与既有符号的同名冲突在下文显式消歧。
// ---------------------------------------------------------------------------

// X01：XLSX 保真（另存字节级审计 + 损坏包分层拒绝）。
export * from './xlsx-preservation/index.js';

// X03：样式部件（数字格式 / 样式描述符 / `cellXfs` 五表 / 带样式 xlsx 组装）。
// 与 `styles.ts` 在同一概念域，但名字不同；若日后出现同名，走显式具名再导出。
export * from './style-parts/index.js';

// X04：重算计划。该目录**没有** `index.ts`，按文件逐个再导出。
//
// `recalc-plan/graph.ts` 与 `recalc-plan/keys.ts` 的若干名字与既有 `recalc.ts` 重名，
// `export *` 会二义（TS2308）：`DependencyTarget` / `scanDependencyTargets` / `CellKey` /
// `cellKey` / `parseCellKey`。这里对**新**的一侧加 `Plan*` 前缀别名再导出，既有 `recalc.ts`
// 的原名保持不变（既有消费方不受影响），两套符号都能从本桶取到。
export {
  buildRecalcPlan,
  targetCovers,
  type PlanCell,
  type PlanSheet,
  type PlanInput,
  type CrossSheetEdge,
  type RecalcPlan,
  type DependencyTarget as PlanDependencyTarget,
  scanDependencyTargets as scanPlanDependencyTargets,
} from './recalc-plan/graph.js';
export {
  sheetNameOf,
  addressOf,
  normalizeCellKey,
  type ParsedCellKey,
  type CellKey as PlanCellKey,
  cellKey as planCellKey,
  parseCellKey as parsePlanCellKey,
} from './recalc-plan/keys.js';
export * from './recalc-plan/names.js';
export * from './recalc-plan/cycles.js';
export * from './recalc-plan/dirty.js';
export * from './recalc-plan/execute.js';

// X05：可序列化数据操作 + 结构化表格组合。
export * from './data-ops/index.js';

// X06：工作表 / 工作簿保护。
export * from './protection/index.js';

// X07：对象部件关系审计（只读）。
export * from './object-parts/index.js';

// X08：分组聚合精确运算层。
export * from './aggregation/index.js';

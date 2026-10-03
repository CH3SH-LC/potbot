/**
 * P06 · 表格 / 图表**部件与关系描述符**层的错误类型。
 *
 * 这一层只做**描述符**（部件路径、内容类型、关系、覆盖矩阵、点位引用），不产出整份
 * PPTX，也不改写 `tables.ts` / `charts.ts` / `roundtrip.ts`。所有判据失败都**具名抛出**，
 * 不静默返回半个结果——上层（接线方）据此区分"没登记完"与"登记错了"。
 */

import { ValidationError } from '../../protocol/index.js';

/** 部件 / 关系描述符层的错误原因（供用例断言与上层分类处理）。 */
export type TableChartPartsErrorReason =
  // —— 部件与关系登记 ——
  | 'unknown_part_kind'
  | 'invalid_part_path'
  | 'duplicate_part_path'
  | 'unknown_part'
  | 'invalid_relationship_id'
  | 'duplicate_relationship_id'
  | 'dangling_relationship'
  | 'unknown_relationship_type'
  | 'missing_relationship'
  | 'wrong_part_kind'
  // —— 内嵌工作簿部件清单 ——
  | 'missing_embedded_workbook'
  | 'duplicate_workbook_role'
  | 'unknown_workbook_role'
  // —— 数值 / 图形一致性 ——
  | 'invalid_a1_reference'
  | 'duplicate_series_name'
  | 'series_count_mismatch'
  | 'series_name_mismatch'
  | 'point_count_mismatch'
  | 'point_value_mismatch'
  | 'category_count_mismatch'
  | 'category_ref_mismatch'
  // —— 合并单元格覆盖矩阵 ——
  | 'merge_span_invalid'
  | 'merge_out_of_bounds'
  | 'merge_overlap'
  | 'grid_mismatch'
  // —— 数据变更：图形与内嵌工作簿同版更新 ——
  | 'invalid_chart_data'
  | 'incomplete_workbook_cells'
  | 'chart_data_desync'
  | 'version_mismatch'
  | 'unknown_edit_target'
  // —— 表格侧同版事实：表字面量 / 合并引用迁移（P-I08） ——
  | 'table_fact_desync'
  | 'table_merge_conflict'
  | 'unknown_table_cell';

/** 描述符层在语义不成立时抛出的错误（**不静默**）。 */
export class TableChartPartsError extends ValidationError {
  readonly reason: TableChartPartsErrorReason;

  constructor(reason: TableChartPartsErrorReason, message: string) {
    super(message);
    this.name = 'TableChartPartsError';
    this.reason = reason;
  }
}

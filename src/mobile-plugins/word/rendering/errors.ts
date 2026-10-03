/**
 * **排版错误**：本包 fail-closed 的两条硬路径。
 *
 * 与本仓其他模块的口径一致（见 `src/documents/docx/docx-error.ts`）：错误是**结构化**的
 * ——调用方拿到的是可分类的 `code`，不是一句自由文本。
 */

export type LayoutErrorCode =
  /** 度量端口缺失 / 形状不完整：**不得假装排版成功**。 */
  | 'metrics_port_missing'
  /** 字体缺失且无可用替代：**不得静默换字体**。 */
  | 'font_missing'
  /** 段落无 run：拿不到任何字体，无法度量行高（**不假装**能排出空行）。 */
  | 'paragraph_without_runs'
  /** 页面几何非法（内容区宽 / 高 ≤ 0）：不假装能排版。 */
  | 'invalid_page_geometry'
  /** 表格没有列宽定义（列为空）：无从确定列网格，不假装能排。 */
  | 'table_no_columns'
  /** 表格没有行：不假装排出一个空表。 */
  | 'table_empty'
  /** 某行的 colSpan 之和 ≠ 列数：网格自相矛盾，不假装能对齐。 */
  | 'table_column_mismatch'
  /** colSpan/rowSpan 越出网格边界或与已有单元格重叠。 */
  | 'table_span_out_of_range';

export interface LayoutErrorDetail {
  /** 请求但缺失的字体族（仅 `font_missing`）。 */
  requestedFont?: string;
  /** 端口上缺失的方法名（仅 `metrics_port_missing`）。 */
  missingMethod?: string;
  /** 出问题的段落下标（仅 `paragraph_without_runs`）。 */
  paragraphIndex?: number;
  /** 出问题的表格行下标（表格类错误）。 */
  rowIndex?: number;
  /** 出问题的表格列下标（`table_span_out_of_range`）。 */
  columnIndex?: number;
  /** 期望 / 实际的列数（`table_column_mismatch`）。 */
  columnCount?: number;
}

export class LayoutError extends Error {
  readonly code: LayoutErrorCode;
  readonly detail: LayoutErrorDetail;

  constructor(code: LayoutErrorCode, detail: LayoutErrorDetail = {}) {
    super(describeLayoutError(code, detail));
    this.name = 'LayoutError';
    this.code = code;
    this.detail = detail;
  }
}

export function describeLayoutError(code: LayoutErrorCode, detail: LayoutErrorDetail): string {
  switch (code) {
    case 'metrics_port_missing':
      return detail.missingMethod === undefined
        ? '字体度量端口缺失：无法在无度量来源的情况下排版（不假装成功）'
        : `字体度量端口形状不完整：缺少方法 \`${detail.missingMethod}\``;
    case 'font_missing':
      return `字体缺失且无可用替代：「${detail.requestedFont ?? '(未指名)'}」——不静默换字体`;
    case 'paragraph_without_runs':
      return `第 ${detail.paragraphIndex ?? '?'} 段没有 run：拿不到字体度量，不假装能排空行`;
    case 'invalid_page_geometry':
      return '页面几何非法：内容区宽或高不为正，无法排版（不假装成功）';
    case 'table_no_columns':
      return '表格没有列宽定义：无从确定列网格，不假装能排版';
    case 'table_empty':
      return '表格没有行：不假装排出一个空表';
    case 'table_column_mismatch':
      return `第 ${detail.rowIndex ?? '?'} 行的列跨度之和与列数（${detail.columnCount ?? '?'}）不符：网格自相矛盾`;
    case 'table_span_out_of_range':
      return `第 ${detail.rowIndex ?? '?'} 行第 ${detail.columnIndex ?? '?'} 列的跨度越出网格边界或与已有单元格重叠`;
  }
}

/** 度量端口必须具备的方法（按此顺序探测，保证确定性错误信息）。 */
export const REQUIRED_METRICS_METHODS = [
  'hasFont',
  'hasGlyph',
  'advanceWidthTwips',
  'ascentTwips',
  'descentTwips',
] as const satisfies readonly (keyof import('./types.js').FontMetricsPort)[];

/** 校验端口形状；不合法即抛 `metrics_port_missing`。返回窄化后的端口。 */
export function assertMetricsPort(port: unknown): import('./types.js').FontMetricsPort {
  if (port === null || typeof port !== 'object') {
    throw new LayoutError('metrics_port_missing', {});
  }
  for (const method of REQUIRED_METRICS_METHODS) {
    if (typeof (port as Record<string, unknown>)[method] !== 'function') {
      throw new LayoutError('metrics_port_missing', { missingMethod: method });
    }
  }
  return port as import('./types.js').FontMetricsPort;
}

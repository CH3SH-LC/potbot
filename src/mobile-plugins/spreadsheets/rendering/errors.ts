/**
 * **分页计算的 fail-closed 错误**：结构性非法输入**不假装能算**，直接抛结构化错误；
 * 而"能算但退化"（如单列超页）走**诊断**返回，不抛。
 *
 * 判据边界：`invalid_*` 属"输入自相矛盾，算不出任何页"；`title_band_too_tall` 属
 * "带本身撑满页面"，由 `computePagePlan` 作为 **error 级诊断**返回（`ok=false`，页数为空），
 * 不抛——调用方仍拿到完整的 `PagePlan` 结构，便于把原因显示给人看。
 */

export type RenderingErrorCode =
  /** 网格几何非法：行列倒挂、默认宽高非正。 */
  | 'invalid_grid_geometry'
  /** 内容区宽/高 ≤ 0（纸张减去边距后没有可排版空间）。 */
  | 'invalid_content_box'
  /** 解析打印设置时字段非法（如手工分页符非整数）。 */
  | 'invalid_settings';

export interface RenderingErrorDetail {
  readonly field?: string;
  readonly value?: unknown;
}

export class RenderingError extends Error {
  readonly code: RenderingErrorCode;
  readonly detail: RenderingErrorDetail;

  constructor(code: RenderingErrorCode, detail: RenderingErrorDetail = {}) {
    super(describeRenderingError(code, detail));
    this.name = 'RenderingError';
    this.code = code;
    this.detail = detail;
  }
}

export function describeRenderingError(code: RenderingErrorCode, detail: RenderingErrorDetail): string {
  switch (code) {
    case 'invalid_grid_geometry':
      return `表格几何非法（${detail.field ?? '?'} = ${JSON.stringify(detail.value)}）：行列倒挂或默认宽高非正，不假装能分页`;
    case 'invalid_content_box':
      return `内容区非法（${detail.field ?? '?'} = ${JSON.stringify(detail.value)}）：纸张减边距后无空间，不假装能分页`;
    case 'invalid_settings':
      return `打印设置非法（${detail.field ?? '?'} = ${JSON.stringify(detail.value)}）`;
  }
}

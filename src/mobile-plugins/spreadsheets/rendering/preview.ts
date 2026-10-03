/**
 * **打印预览模型**：把 {@link PagePlan} 与展开后的页眉页脚合成给 UI 用的 {@link PrintPreview}。
 *
 * 这是"手机本机预览"的数据面——UI 拿到每页的**行列范围 + 标题带 + 页眉页脚三段文本**即可
 * 按自己的渲染器画（后续 Android 侧把 `PagePlanPage.rows/columns` 映射到真实单元格像素）。
 * **本包不画像素、不生成 PDF 字节**：那属真机渲染，标记未验证。
 */

import { headerFooterForPage } from './header-footer.js';
import { computePagePlan } from './paginate.js';
import type { PagePlanInput, PreviewPage, PrintPreview } from './types.js';

/**
 * 计算完整打印预览（分页 + 逐页页眉页脚）。
 *
 * **页码只此一处**：`totalPages` 直接取 `plan.totalPages`（= `plan.pages.length`），
 * `pageNumber` 直接取 `PagePlanPage.pageNumber`；`&P`/`&N` 展开用的就是这两个值，
 * 下游（UI / 适配器 / Android）**不得**另行重算，否则会出现同一份计划两套页码。
 */
export function buildPrintPreview(input: PagePlanInput): PrintPreview {
  const plan = computePagePlan(input);
  const totalPages = plan.totalPages;
  const headerFooter = input.settings.headerFooter;

  const pages: PreviewPage[] = plan.pages.map((page) => {
    const text = headerFooterForPage(headerFooter, page.pageNumber, totalPages);
    return Object.freeze({
      index: page.index,
      pageNumber: page.pageNumber,
      totalPages,
      areaIndex: page.areaIndex,
      rows: page.rows,
      columns: page.columns,
      titleRows: page.titleRows,
      titleColumns: page.titleColumns,
      header: text.header,
      footer: text.footer,
      isFirstPage: page.pageNumber === 1,
      isOddPage: page.pageNumber % 2 === 1,
    });
  });

  return Object.freeze({
    pages: Object.freeze(pages),
    totalPages,
    plan,
    diagnostics: plan.diagnostics,
  });
}

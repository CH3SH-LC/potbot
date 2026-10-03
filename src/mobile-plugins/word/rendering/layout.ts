/**
 * **排版入口**：文档 → 页盒（真实分页）。
 *
 * 单一入口 `layoutDocument(spec, port, options)`：
 *
 * 1. **先验端口**：端口缺失 / 形状不完整 ⇒ `LayoutError('metrics_port_missing')`
 *    ——没有度量来源就**不排版**，绝不返回一份"看起来成功"的空结果。
 * 2. 逐段度量（字体解析 + 断行），字体缺失走替代或失败。
 * 3. 分页（`paginate.ts`）——**页数由真实布局算出**。
 *
 * 返回值里 `pages.length` 就是真页数；本包不渲染页码域（那是 W04 的语义）。
 */

import { assertMetricsPort, LayoutError } from './errors.js';
import { FontResolver } from './fonts.js';
import { measureParagraph, type MeasuredParagraph } from './line-break.js';
import { paginate, type ContentBox } from './paginate.js';
import type {
  FontMetricsPort,
  HeaderFooterSpec,
  LayoutDiagnostic,
  LayoutDocumentSpec,
  LayoutOptions,
  LayoutResult,
  PageGeometry,
  ParagraphSpec,
  RunSpec,
  Twips,
} from './types.js';

function contentBoxOf(geometry: PageGeometry): ContentBox {
  const width = geometry.widthTwips - geometry.marginsTwips.left - geometry.marginsTwips.right;
  const height =
    geometry.heightTwips -
    geometry.marginsTwips.top -
    geometry.marginsTwips.bottom -
    geometry.headerHeightTwips -
    geometry.footerHeightTwips;
  return {
    leftTwips: geometry.marginsTwips.left,
    topTwips: geometry.marginsTwips.top + geometry.headerHeightTwips,
    widthTwips: width,
    heightTwips: height,
  };
}

export function layoutDocument(
  spec: LayoutDocumentSpec,
  port: FontMetricsPort,
  options: LayoutOptions = {},
): LayoutResult {
  const metrics = assertMetricsPort(port);
  const diagnostics: LayoutDiagnostic[] = [];
  const resolver = new FontResolver(metrics, options.substituteFont, diagnostics);

  const geometry = spec.geometry;
  const content = contentBoxOf(geometry);
  if (content.widthTwips <= 0 || content.heightTwips <= 0) {
    throw new LayoutError('invalid_page_geometry', {});
  }

  if (spec.paragraphs.length === 0) {
    diagnostics.push({
      code: 'empty_document',
      severity: 'warning',
      message: '文档没有段落：输出 1 页空页（真页数由分页算出）',
    });
  }

  const measured: MeasuredParagraph[] = spec.paragraphs.map((para, index) => {
    if (para.runs.length === 0) {
      throw new LayoutError('paragraph_without_runs', { paragraphIndex: index });
    }
    return measureParagraph(para, index, {
      port: metrics,
      resolver,
      diagnostics,
      contentWidthTwips: content.widthTwips,
    });
  });

  const header = measureBand(spec.header ?? null, metrics, resolver, diagnostics, content.widthTwips);
  const footer = measureBand(spec.footer ?? null, metrics, resolver, diagnostics, content.widthTwips);

  const { pages } = paginate({ paragraphs: measured, geometry, content, header, footer, diagnostics });

  const usedFonts = new Set<string>();
  for (const page of pages) {
    for (const line of page.lines) for (const run of line.runs) usedFonts.add(run.fontFamily);
    for (const line of page.header.lines) for (const run of line.runs) usedFonts.add(run.fontFamily);
    for (const line of page.footer.lines) for (const run of line.runs) usedFonts.add(run.fontFamily);
  }

  return {
    pages,
    diagnostics,
    ok: diagnostics.every((d) => d.severity !== 'error'),
    usedFonts: [...usedFonts].sort(),
    contentBox: {
      leftTwips: content.leftTwips,
      topTwips: content.topTwips,
      widthTwips: content.widthTwips,
      heightTwips: content.heightTwips,
    },
  };
}

function measureBand(
  band: HeaderFooterSpec | null,
  port: FontMetricsPort,
  resolver: FontResolver,
  diagnostics: LayoutDiagnostic[],
  contentWidthTwips: Twips,
): MeasuredParagraph | null {
  if (band === null || band.runs.length === 0) return null;
  const para: ParagraphSpec = { runs: band.runs as readonly RunSpec[], alignment: band.alignment ?? 'left' };
  return measureParagraph(para, -1, { port, resolver, diagnostics, contentWidthTwips });
}

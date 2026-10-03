/**
 * 范围解析（合同 R111–R116）。
 *
 * 把范围表达式对到**一组具体的 `DocumentRange`**。三条硬规矩：
 * - **R112** 命中零项 → `not_found`，不是静默无操作；
 * - **R113** 命中多项 → `ambiguous` + 候选列表；**相同词出现多处不得擅自全改**，
 *   "全部"必须由调用方显式要求（这是 `resolve` 与 `replace` 的分工：resolve 只报告候选，
 *   替不替、替几处由 WF-085 的操作参数决定）；
 * - **R115** "标题"由**样式/大纲级别**判定，**不由**"第一段"或"字体大"推断——
 *   后者在真实文档里会把加粗的正文首段误判成标题。
 *
 * 反馈一律携带：请求表达式原文、实际命中数、是否需要澄清（R116）。
 */

import type { DocumentModel, ParagraphNode, StyleTable, TableNode } from '../model/types.js';
import { formatRangeExpression, parseRangeExpression } from './expression.js';
import { findText } from './find.js';
import {
  cellParagraphs,
  collectParagraphs,
  collectTables,
  paragraphFullRange,
  tableParagraphs,
} from './structure.js';
import type { DocumentRange, FailureDetail, RangeExpression, RangeResolution, Selection } from './types.js';

export interface ResolveContext {
  /** "当前选区"表达式所需的选区。 */
  readonly current_selection?: Selection;
}

const HEADING_STYLE_NAME = /^(Heading\s*[1-9]|标题\s*[1-9])/i;

/** 该段落是否是标题：大纲级别已设（非 null）或样式（含 `basedOn` 链）指向标题样式（R115）。 */
export function isHeadingParagraph(paragraph: ParagraphNode, styles: StyleTable): boolean {
  const outline = paragraph.properties.outlineLevel;
  if (outline.state === 'set' && outline.value !== null) return true;
  return resolvesToHeadingStyle(styles, paragraph.style_ref, new Set());
}

function resolvesToHeadingStyle(styles: StyleTable, styleRef: string | null, seen: Set<string>): boolean {
  if (styleRef === null) return false;
  if (seen.has(styleRef)) return false; // R123：成环/坏引用时有限终止，不无限递归
  seen.add(styleRef);
  const definition = styles.styles.find((style) => style.style_id === styleRef);
  if (definition === undefined) return false;
  if (HEADING_STYLE_NAME.test(definition.name)) return true;
  return definition.based_on === null ? false : resolvesToHeadingStyle(styles, definition.based_on, seen);
}

function ok(expression: string, ranges: readonly DocumentRange[]): RangeResolution {
  return {
    status: 'ok',
    expression,
    hitCount: ranges.length,
    needsClarification: false,
    ranges,
  };
}

function notFound(expression: string, message: string, extra?: FailureDetail['extra']): RangeResolution {
  return {
    status: 'not_found',
    expression,
    hitCount: 0,
    needsClarification: true,
    message,
    detail: { expression, hitCount: 0, needsClarification: true, ...(extra === undefined ? {} : { extra }) },
  };
}

function invalid(expression: string, message: string): RangeResolution {
  return {
    status: 'invalid',
    expression,
    hitCount: 0,
    needsClarification: true,
    message,
    detail: { expression, hitCount: 0, needsClarification: true },
  };
}

function ambiguous(expression: string, ranges: readonly DocumentRange[], message: string): RangeResolution {
  return {
    status: 'ambiguous',
    expression,
    hitCount: ranges.length,
    needsClarification: true,
    message,
    ranges,
    detail: {
      expression,
      hitCount: ranges.length,
      needsClarification: true,
      candidates: ranges,
    },
  };
}

/** 解析 + 求值。语法错误在这里直接变成 `invalid`（不再单独返回 `Result`）。 */
export function resolveRangeExpression(
  model: DocumentModel,
  expression: string,
  context: ResolveContext = {},
): RangeResolution {
  const parsed = parseRangeExpression(expression);
  if (!parsed.ok) {
    return invalid(expression, parsed.message);
  }
  return resolveRange(model, parsed.value, context, expression);
}

/** 求值一个已解析的表达式。`raw` 只用于反馈回显。 */
export function resolveRange(
  model: DocumentModel,
  expression: RangeExpression,
  context: ResolveContext = {},
  raw?: string,
): RangeResolution {
  const echo = raw ?? formatRangeExpression(expression);

  switch (expression.kind) {
    case 'whole_document':
    case 'body': {
      // 本模型未把页眉/页脚/脚注建模为块（它们在不透明部件里，R105），因此当前版本下
      // "全文"与"正文"解析结果相同。这是**已知边界**，不是"两者本应一样"。
      const paragraphs = collectParagraphs(model.blocks);
      if (paragraphs.length === 0) return notFound(echo, '文档没有任何段落。');
      return ok(echo, paragraphs.map(paragraphFullRange));
    }

    case 'headings': {
      const headings = collectParagraphs(model.blocks).filter((paragraph) =>
        isHeadingParagraph(paragraph, model.styles),
      );
      if (headings.length === 0) {
        return notFound(echo, '文档中没有可识别的标题（无大纲级别、也无标题样式）。');
      }
      return ok(echo, headings.map(paragraphFullRange));
    }

    case 'paragraph': {
      const paragraphs = collectParagraphs(model.blocks);
      const target = paragraphs[expression.index - 1];
      if (target === undefined) {
        return notFound(echo, `文档共 ${paragraphs.length} 段，"第${expression.index}段"超出范围。`, {
          paragraphCount: paragraphs.length,
          requested: expression.index,
        });
      }
      return ok(echo, [paragraphFullRange(target)]);
    }

    case 'paragraph_range': {
      const paragraphs = collectParagraphs(model.blocks);
      if (expression.to > paragraphs.length) {
        return notFound(
          echo,
          `文档共 ${paragraphs.length} 段，"第${expression.from}至${expression.to}段"超出范围。`,
          { paragraphCount: paragraphs.length, requestedTo: expression.to },
        );
      }
      const slice = paragraphs.slice(expression.from - 1, expression.to);
      return ok(echo, slice.map(paragraphFullRange));
    }

    case 'current_selection': {
      const selection = context.current_selection;
      if (selection === undefined) {
        return invalid(echo, '表达式"当前选区"需要调用方提供当前选区。');
      }
      if (selection.ranges.length === 0) {
        return notFound(echo, '当前选区为空。');
      }
      return ok(echo, selection.ranges);
    }

    case 'table': {
      const tables = collectTables(model.blocks);
      const target = tables[expression.index - 1];
      if (target === undefined) {
        return notFound(echo, `文档共 ${tables.length} 个表格，"第${expression.index}个表格"超出范围。`, {
          tableCount: tables.length,
          requested: expression.index,
        });
      }
      return ok(echo, tableParagraphs(target).map(paragraphFullRange));
    }

    case 'table_cell': {
      const tables = collectTables(model.blocks);
      const target: TableNode | undefined = tables[expression.table - 1];
      if (target === undefined) {
        return notFound(
          echo,
          `文档共 ${tables.length} 个表格，"第${expression.table}个表格"超出范围。`,
          { tableCount: tables.length, requested: expression.table },
        );
      }
      const rowNode = target.rows[expression.row - 1];
      if (rowNode === undefined) {
        return notFound(
          echo,
          `第${expression.table}个表格共 ${target.rows.length} 行，"第${expression.row}行"超出范围。`,
          { rowCount: target.rows.length, requested: expression.row },
        );
      }
      const cell = rowNode.cells[expression.column - 1];
      if (cell === undefined) {
        return notFound(
          echo,
          `第${expression.table}个表格第${expression.row}行共 ${rowNode.cells.length} 列，"第${expression.column}列"超出范围。`,
          { columnCount: rowNode.cells.length, requested: expression.column },
        );
      }
      return ok(echo, cellParagraphs(cell).map(paragraphFullRange));
    }

    case 'text': {
      const found = findText(model, expression.query);
      if (!found.ok) {
        return notFound(echo, found.message, { hitCount: 0 });
      }
      const ranges: DocumentRange[] = found.value.map((match) => ({
        node_id: match.paragraph_id,
        start: match.start,
        end: match.end,
      }));
      if (ranges.length > 1) {
        return ambiguous(
          echo,
          ranges,
          `"${expression.query}" 在文档中出现 ${ranges.length} 处，需要用户指明改哪一处（R113）。`,
        );
      }
      return ok(echo, ranges);
    }
  }
}

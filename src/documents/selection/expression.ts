/**
 * 范围语法解析（合同 R111）。
 *
 * 语法是**固定白名单**：`全文` / `正文` / `标题` / `第N段` / `第N至M段` / `当前选区` /
 * `第N个表格` / `第N个表格第R行第C列` / `指定文本`。
 *
 * 刻意**不做模糊匹配**：`第二段`（汉字数字）、`第2段至第4段`、`所有段落` 一律
 * `invalid_expression`——宁可让上层回问用户，也不让"看起来像但还是解析了"的不同实现在这里分叉。
 */

import { fail, succeed, type RangeExpression, type Result } from './types.js';

const RE_PARAGRAPH = /^第([0-9]+)段$/;
const RE_PARAGRAPH_RANGE = /^第([0-9]+)至([0-9]+)段$/;
const RE_TABLE = /^第([0-9]+)个表格$/;
const RE_TABLE_CELL = /^第([0-9]+)个表格第([0-9]+)行第([0-9]+)列$/;
const RE_TEXT = /^指定文本(?::|：)?(.+)$/;

function positiveInteger(raw: string): number | null {
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/** 解析范围表达式。失败时**保留原文**在 detail 里，供 R116 的反馈回显。 */
export function parseRangeExpression(input: string): Result<RangeExpression> {
  const text = input.trim();
  if (text.length === 0) {
    return fail('invalid_expression', '范围表达式为空。', { expression: input });
  }

  if (text === '全文') return succeed({ kind: 'whole_document' });
  if (text === '正文') return succeed({ kind: 'body' });
  if (text === '标题') return succeed({ kind: 'headings' });
  if (text === '当前选区') return succeed({ kind: 'current_selection' });

  const paragraphRange = RE_PARAGRAPH_RANGE.exec(text);
  if (paragraphRange !== null) {
    const from = positiveInteger(paragraphRange[1]!);
    const to = positiveInteger(paragraphRange[2]!);
    if (from === null || to === null) {
      return fail('invalid_expression', `范围表达式 "${input}" 的段号不是正整数。`, { expression: input });
    }
    if (from > to) {
      return fail('invalid_expression', `范围表达式 "${input}" 的起段大于止段。`, {
        expression: input,
        extra: { from, to },
      });
    }
    return succeed({ kind: 'paragraph_range', from, to });
  }

  const paragraph = RE_PARAGRAPH.exec(text);
  if (paragraph !== null) {
    const index = positiveInteger(paragraph[1]!);
    if (index === null) {
      return fail('invalid_expression', `范围表达式 "${input}" 的段号不是正整数。`, { expression: input });
    }
    return succeed({ kind: 'paragraph', index });
  }

  const cell = RE_TABLE_CELL.exec(text);
  if (cell !== null) {
    const table = positiveInteger(cell[1]!);
    const row = positiveInteger(cell[2]!);
    const column = positiveInteger(cell[3]!);
    if (table === null || row === null || column === null) {
      return fail('invalid_expression', `范围表达式 "${input}" 的表/行/列号不是正整数。`, { expression: input });
    }
    return succeed({ kind: 'table_cell', table, row, column });
  }

  const table = RE_TABLE.exec(text);
  if (table !== null) {
    const index = positiveInteger(table[1]!);
    if (index === null) {
      return fail('invalid_expression', `范围表达式 "${input}" 的表格序号不是正整数。`, { expression: input });
    }
    return succeed({ kind: 'table', index });
  }

  const specified = RE_TEXT.exec(text);
  if (specified !== null) {
    return succeed({ kind: 'text', query: specified[1]! });
  }

  return fail('invalid_expression', `无法识别的范围表达式 "${input}"。`, { expression: input });
}

/** 把范围表达式渲染回规范写法（用于反馈与日志；`text` 分支带查找词）。 */
export function formatRangeExpression(expression: RangeExpression): string {
  switch (expression.kind) {
    case 'whole_document':
      return '全文';
    case 'body':
      return '正文';
    case 'headings':
      return '标题';
    case 'paragraph':
      return `第${expression.index}段`;
    case 'paragraph_range':
      return `第${expression.from}至${expression.to}段`;
    case 'current_selection':
      return '当前选区';
    case 'table':
      return `第${expression.index}个表格`;
    case 'table_cell':
      return `第${expression.table}个表格第${expression.row}行第${expression.column}列`;
    case 'text':
      return `指定文本:${expression.query}`;
  }
}

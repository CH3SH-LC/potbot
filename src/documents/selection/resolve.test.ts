/**
 * 范围解析单测（合同 R111–R116）。
 *
 * 重点：
 * - **R112/R116**：命中零项的反馈必须带"请求表达式 + 实际命中数 + 是否需澄清"；
 * - **R113**：同一词出现多处 ⇒ `ambiguous` + 候选列表，**不擅自全改**；
 * - **R115**：标题按**样式/大纲级别**判定，"第一段"或"字体大"都不算。
 */

import { describe, expect, it } from 'vitest';

import { formatRangeExpression, parseRangeExpression } from './expression.js';
import { isHeadingParagraph, resolveRangeExpression } from './resolve.js';
import { cell, document, paragraphOfRuns, row, style, table, unspecifiedParagraphProperties } from './testing.js';

const doc = document(
  [
    paragraphOfRuns('p1', [['r1', '第一段文本']]),
    paragraphOfRuns('p2', [['r2', '天气很好']]),
    paragraphOfRuns('p3', [['r3', '中间标题']], { style_ref: 'Heading1' }),
    paragraphOfRuns('p4', [['r4', '天气又变了']]),
    table('t1', [
      row('row1', [
        cell('c1', [paragraphOfRuns('p5', [['r5', '单元格甲']])]),
        cell('c2', [paragraphOfRuns('p6', [['r6', '单元格乙']])]),
      ]),
      row('row2', [cell('c3', [paragraphOfRuns('p7', [['r7', '第二行']])]), cell('c4', [paragraphOfRuns('p8', [['r8', '第二行乙']])])]),
    ]),
  ],
  {
    styles: {
      styles: [style('Heading1', 'heading 1'), style('S-自定义', '标题 2', { based_on: 'Heading1' })],
    },
  },
);

describe('parseRangeExpression —— R111 固定语法', () => {
  it('接受全部白名单写法', () => {
    expect(parseRangeExpression('全文')).toEqual({ ok: true, value: { kind: 'whole_document' } });
    expect(parseRangeExpression('正文')).toEqual({ ok: true, value: { kind: 'body' } });
    expect(parseRangeExpression('标题')).toEqual({ ok: true, value: { kind: 'headings' } });
    expect(parseRangeExpression('当前选区')).toEqual({ ok: true, value: { kind: 'current_selection' } });
    expect(parseRangeExpression('第3段')).toEqual({ ok: true, value: { kind: 'paragraph', index: 3 } });
    expect(parseRangeExpression('第2至5段')).toEqual({
      ok: true,
      value: { kind: 'paragraph_range', from: 2, to: 5 },
    });
    expect(parseRangeExpression('第1个表格')).toEqual({ ok: true, value: { kind: 'table', index: 1 } });
    expect(parseRangeExpression('第1个表格第2行第1列')).toEqual({
      ok: true,
      value: { kind: 'table_cell', table: 1, row: 2, column: 1 },
    });
    expect(parseRangeExpression('指定文本:天气')).toEqual({ ok: true, value: { kind: 'text', query: '天气' } });
    expect(parseRangeExpression('  全文  ')).toEqual({ ok: true, value: { kind: 'whole_document' } });
  });

  it('拒绝白名单之外的写法（不做模糊匹配）', () => {
    for (const bad of ['', '第二段', '第2段至第4段', '所有段落', '第0段', '第3至2段', '随便什么']) {
      const parsed = parseRangeExpression(bad);
      expect(parsed.ok, `"${bad}" 不应被接受`).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.code).toBe('invalid_expression');
      expect(parsed.detail.expression).toBe(bad);
    }
  });

  it('渲染回规范写法', () => {
    expect(formatRangeExpression({ kind: 'text', query: '天气' })).toBe('指定文本:天气');
    expect(formatRangeExpression({ kind: 'table_cell', table: 1, row: 2, column: 3 })).toBe('第1个表格第2行第3列');
  });
});

describe('resolveRangeExpression —— 段落与文档级范围', () => {
  it('全文/正文 → 覆盖全部段落（含表格内段落，按文档顺序）', () => {
    const resolved = resolveRangeExpression(doc, '全文');
    expect(resolved.status).toBe('ok');
    if (resolved.status !== 'ok') return;
    expect(resolved.ranges.map((range) => range.node_id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);
    expect(resolved.hitCount).toBe(8);
    expect(resolved.needsClarification).toBe(false);

    const body = resolveRangeExpression(doc, '正文');
    expect(body.status).toBe('ok');
  });

  it('第N段：按文档顺序取到整段范围', () => {
    const resolved = resolveRangeExpression(doc, '第2段');
    expect(resolved).toEqual({
      status: 'ok',
      expression: '第2段',
      hitCount: 1,
      needsClarification: false,
      ranges: [{ node_id: 'p2', start: 0, end: 4 }],
    });
  });

  it('第N段越界 → not_found，反馈含表达式、命中数与文档段数（R112/R116）', () => {
    const resolved = resolveRangeExpression(doc, '第99段');
    expect(resolved.status).toBe('not_found');
    if (resolved.status !== 'not_found') return;
    expect(resolved.expression).toBe('第99段');
    expect(resolved.hitCount).toBe(0);
    expect(resolved.needsClarification).toBe(true);
    expect(resolved.detail.extra?.paragraphCount).toBe(8);
  });

  it('第N至M段：命中多段', () => {
    const resolved = resolveRangeExpression(doc, '第2至4段');
    expect(resolved.status).toBe('ok');
    if (resolved.status !== 'ok') return;
    expect(resolved.ranges.map((range) => range.node_id)).toEqual(['p2', 'p3', 'p4']);
  });

  it('第N至M段越界 → not_found', () => {
    const resolved = resolveRangeExpression(doc, '第7至99段');
    expect(resolved.status).toBe('not_found');
  });

  it('语法错误 → invalid，且带请求原文', () => {
    const resolved = resolveRangeExpression(doc, '第二段');
    expect(resolved.status).toBe('invalid');
    if (resolved.status !== 'invalid') return;
    expect(resolved.expression).toBe('第二段');
    expect(resolved.message).toContain('第二段');
  });
});

describe('R115 —— 标题按样式/大纲级别判定', () => {
  it('样式引用命中标题样式（含 basedOn 链）', () => {
    const resolved = resolveRangeExpression(doc, '标题');
    expect(resolved.status).toBe('ok');
    if (resolved.status !== 'ok') return;
    expect(resolved.ranges.map((range) => range.node_id)).toEqual(['p3']);
  });

  it('大纲级别命中；"第一段"与"字体大"都不算标题', () => {
    const outlineDoc = document([
      paragraphOfRuns('a1', [['x1', '普通首段（很大很粗）']]),
      paragraphOfRuns('a2', [['x2', '真正标题']], {
        properties: unspecifiedParagraphProperties({ outlineLevel: { state: 'set', value: 0 } }),
      }),
    ]);
    const resolved = resolveRangeExpression(outlineDoc, '标题');
    expect(resolved.status).toBe('ok');
    if (resolved.status !== 'ok') return;
    expect(resolved.ranges.map((range) => range.node_id)).toEqual(['a2']);

    const first = outlineDoc.blocks[0];
    const firstIsHeading =
      first !== undefined && first.kind === 'paragraph' && isHeadingParagraph(first, outlineDoc.styles);
    expect(firstIsHeading).toBe(false);
  });

  it('没有标题 → not_found（不是静默返回整篇）', () => {
    const plain = document([paragraphOfRuns('b1', [['y1', '正文']])]);
    const resolved = resolveRangeExpression(plain, '标题');
    expect(resolved.status).toBe('not_found');
  });
});

describe('表格与单元格', () => {
  it('第1个表格 → 表内全部段落', () => {
    const resolved = resolveRangeExpression(doc, '第1个表格');
    expect(resolved.status).toBe('ok');
    if (resolved.status !== 'ok') return;
    expect(resolved.ranges.map((range) => range.node_id)).toEqual(['p5', 'p6', 'p7', 'p8']);
  });

  it('第1个表格第2行第1列 → 该单元格的段落', () => {
    const resolved = resolveRangeExpression(doc, '第1个表格第2行第1列');
    expect(resolved.status).toBe('ok');
    if (resolved.status !== 'ok') return;
    expect(resolved.ranges).toEqual([{ node_id: 'p7', start: 0, end: 3 }]);
  });

  it('行/列越界 → not_found 且带实际行列数', () => {
    const badRow = resolveRangeExpression(doc, '第1个表格第9行第1列');
    expect(badRow.status).toBe('not_found');
    if (badRow.status !== 'not_found') return;
    expect(badRow.detail.extra?.rowCount).toBe(2);

    const badColumn = resolveRangeExpression(doc, '第1个表格第1行第9列');
    expect(badColumn.status).toBe('not_found');
    if (badColumn.status !== 'not_found') return;
    expect(badColumn.detail.extra?.columnCount).toBe(2);

    const badTable = resolveRangeExpression(doc, '第9个表格');
    expect(badTable.status).toBe('not_found');
  });
});

describe('指定文本 —— R112/R113', () => {
  it('命中一处 → ok', () => {
    const resolved = resolveRangeExpression(doc, '指定文本:中间标题');
    expect(resolved.status).toBe('ok');
    if (resolved.status !== 'ok') return;
    expect(resolved.ranges).toEqual([{ node_id: 'p3', start: 0, end: 4 }]);
  });

  it('命中两处 → ambiguous + 候选列表 + 需澄清（不得擅自全改）', () => {
    const resolved = resolveRangeExpression(doc, '指定文本:天气');
    expect(resolved.status).toBe('ambiguous');
    if (resolved.status !== 'ambiguous') return;
    expect(resolved.hitCount).toBe(2);
    expect(resolved.needsClarification).toBe(true);
    expect(resolved.ranges).toEqual([
      { node_id: 'p2', start: 0, end: 2 },
      { node_id: 'p4', start: 0, end: 2 },
    ]);
    expect(resolved.detail.candidates).toHaveLength(2);
  });

  it('命中零处 → not_found（不是静默无操作）', () => {
    const resolved = resolveRangeExpression(doc, '指定文本:根本没有');
    expect(resolved.status).toBe('not_found');
    if (resolved.status !== 'not_found') return;
    expect(resolved.hitCount).toBe(0);
    expect(resolved.message).toContain('根本没有');
  });
});

describe('当前选区', () => {
  it('没有传入选区 → invalid', () => {
    const resolved = resolveRangeExpression(doc, '当前选区');
    expect(resolved.status).toBe('invalid');
  });

  it('传入选区 → 用选区自身的 ranges', () => {
    const resolved = resolveRangeExpression(doc, '当前选区', {
      current_selection: {
        document_id: doc.document_id,
        base_revision: doc.revision,
        ranges: [{ node_id: 'p2', start: 0, end: 2 }],
      },
    });
    expect(resolved.status).toBe('ok');
    if (resolved.status !== 'ok') return;
    expect(resolved.ranges).toEqual([{ node_id: 'p2', start: 0, end: 2 }]);
  });
});

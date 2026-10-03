/**
 * 批量格式修改测试（WF-044）。
 *
 * 核心判据（正反例）：给一个**含标题与表格**的范围，批量排版后
 * **标题与表格不被改**（默认排除），普通段落被改；且跳过原因逐条可见。
 */

import { describe, expect, it } from 'vitest';
import type { DocumentModel, ParagraphNode, StyleDefinition, StyleTable } from '../model/types.js';
import { createDocumentModel } from '../model/document.js';
import { cellNode, paragraphNode, rowNode, tableNode } from '../model/nodes.js';
import { batchApplyStyle, batchClearFormat, batchFormatBlocks, batchFormatByStyle } from './batch-format.js';
import { findBlockById } from '../model/walk.js';
import { createDefaultParagraphProperties } from '../operations/paragraph/defaults.js';
import { setAlignment } from '../operations/paragraph/alignment.js';
import { setFirstLineIndent } from '../operations/paragraph/indent.js';

function style(style_id: string, extra: Partial<StyleDefinition> = {}): StyleDefinition {
  return {
    style_id,
    name: style_id,
    type: 'paragraph',
    based_on: null,
    run_properties: {},
    paragraph_properties: {},
    is_default: false,
    ...extra,
  };
}

const STYLES: StyleTable = {
  styles: [
    style('Normal', { is_default: true }),
    style('Heading1', { paragraph_properties: { outlineLevel: { state: 'set', value: 0 } } }),
    style('Quote'),
  ],
};

/**
 * 一份含四类目标的文档：标题、两个正文段、表格单元格内的段落。
 * 返回 id 便于逐条断言"谁被改、谁没被改"。
 */
function fixture(): { model: DocumentModel; heading: string; body1: string; body2: string; inTable: string } {
  const model = createDocumentModel({
    document_id: 'doc',
    styles: STYLES,
    blocks: [
      paragraphNode({ source: 'user_request', style_ref: 'Heading1' }),
      paragraphNode({ source: 'user_request' }),
      paragraphNode({ source: 'user_request' }),
      tableNode({
        source: 'user_request',
        grid: [],
        rows: [
          rowNode({
            source: 'user_request',
            cells: [
              cellNode({
                source: 'user_request',
                blocks: [paragraphNode({ source: 'user_request' })],
              }),
            ],
          }),
        ],
      }),
    ],
  });
  const [heading, body1, body2] = model.blocks;
  const table = model.blocks[3];
  const inTable = table !== undefined && table.kind === 'table' ? (table.rows[0]?.cells[0]?.blocks[0]?.id ?? '') : '';
  return {
    model,
    heading: heading?.id ?? '',
    body1: body1?.id ?? '',
    body2: body2?.id ?? '',
    inTable,
  };
}

function asParagraph(model: DocumentModel, id: string): ParagraphNode {
  return findBlockById(model, id) as ParagraphNode;
}

describe('默认排除标题与表格（WF-044 的判据）', () => {
  it('范围含标题与表格：只改正文段，标题/表格跳过并给出原因', () => {
    const { model, heading, body1, body2, inTable } = fixture();
    const result = batchFormatBlocks(
      model,
      [heading, body1, body2, inTable],
      { kind: 'paragraph_format', format: { alignment: { state: 'set', value: 'center' } } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 正面：两个正文段被改。
    expect(result.changed).toEqual([body1, body2]);
    expect(asParagraph(result.model, body1).properties.alignment).toEqual({ state: 'set', value: 'center' });

    // 反面 1：标题**不被改**（否则导航/目录会跟着错，R115）。
    expect(asParagraph(result.model, heading).properties.alignment).not.toEqual({
      state: 'set',
      value: 'center',
    });
    expect(result.skipped).toContainEqual({ id: heading, reason: 'heading' });

    // 反面 2：表格内段落**不被改**。
    expect(asParagraph(result.model, inTable).properties.alignment).not.toEqual({
      state: 'set',
      value: 'center',
    });
    expect(result.skipped).toContainEqual({ id: inTable, reason: 'in_table' });

    // 未被改的块对象引用不变（R151 的取向：没动就是没动）。
    expect(findBlockById(result.model, heading)).toBe(findBlockById(model, heading));
    expect(findBlockById(result.model, inTable)).toBe(findBlockById(model, inTable));
  });

  it('显式关闭排除时，标题与表格才被改（反面控制组）', () => {
    const { model, heading, body1, body2, inTable } = fixture();
    const result = batchFormatBlocks(
      model,
      [heading, body1, body2, inTable],
      { kind: 'paragraph_format', format: { alignment: { state: 'set', value: 'center' } } },
      { exclude_headings: false, exclude_tables: false },
    );
    if (!result.ok) throw new Error('失败');
    expect(result.skipped).toEqual([]);
    expect(result.changed).toHaveLength(4);
    expect(asParagraph(result.model, heading).properties.alignment).toEqual({ state: 'set', value: 'center' });
    expect(asParagraph(result.model, inTable).properties.alignment).toEqual({ state: 'set', value: 'center' });
  });

  it('排除列表项（可选）', () => {
    const { model, body1, body2 } = fixture();
    const listed: DocumentModel = {
      ...model,
      blocks: model.blocks.map((block) =>
        block.id === body2 && block.kind === 'paragraph'
          ? { ...block, numbering: { num_id: '1', level: 0 } }
          : block,
      ),
    };
    const result = batchFormatBlocks(listed, [body1, body2], { kind: 'clear' }, { exclude_lists: true });
    if (!result.ok) throw new Error('失败');
    expect(result.changed).toEqual([body1]);
    expect(result.skipped).toEqual([{ id: body2, reason: 'list' }]);
  });
});

describe('原子性与拒绝（R136/R154）', () => {
  it('反面：目标里有一个不存在的 id → 整批不改', () => {
    const { model, body1 } = fixture();
    const result = batchFormatBlocks(model, [body1, 'ghost-id'], { kind: 'clear' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unknown_target');
    // 原模型未被触碰：body1 仍有直接格式。
    expect(asParagraph(model, body1).properties.alignment).toEqual({ state: 'unspecified' });
  });

  it('反面：套用不存在的命名样式 → 拒绝', () => {
    const { model, body1 } = fixture();
    const result = batchApplyStyle(model, [body1], 'Ghost');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unknown_style');
  });

  it('目标是表格本身（非段落）→ 记为 not_paragraph，不算失败', () => {
    const { model } = fixture();
    const table = model.blocks[3];
    if (table === undefined) throw new Error('缺少表格');
    const result = batchFormatBlocks(model, [table.id], { kind: 'clear' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skipped).toEqual([{ id: table.id, reason: 'not_paragraph' }]);
    expect(result.changed).toEqual([]);
  });
});

describe('套用样式与清除（按引用，不硬写外观）', () => {
  it('batchApplyStyle 写 pStyle 引用并清直接格式（R125）', () => {
    const { model, body1 } = fixture();
    const dirty: DocumentModel = {
      ...model,
      blocks: model.blocks.map((block) =>
        block.id === body1 && block.kind === 'paragraph'
          ? { ...block, properties: setAlignment(createDefaultParagraphProperties(), 'justify') }
          : block,
      ),
    };
    const result = batchApplyStyle(dirty, [body1], 'Quote');
    if (!result.ok) throw new Error('失败');
    const applied = asParagraph(result.model, body1);
    expect(applied.style_ref).toBe('Quote');
    expect(applied.properties.alignment).toEqual({ state: 'inherit' });
  });

  it('batchClearFormat 清段落直接格式，保留 style_ref 与正文', () => {
    const { model, body1 } = fixture();
    const dirty: DocumentModel = {
      ...model,
      blocks: model.blocks.map((block) =>
        block.id === body1 && block.kind === 'paragraph'
          ? { ...block, properties: setFirstLineIndent(createDefaultParagraphProperties(), { unit: 'chars', value: 2 }) }
          : block,
      ),
    };
    const result = batchClearFormat(dirty, [body1]);
    if (!result.ok) throw new Error('失败');
    const cleared = asParagraph(result.model, body1);
    expect(cleared.properties.indent.firstLine).toEqual({ state: 'inherit' });
    expect(cleared.style_ref).toBe(asParagraph(model, body1).style_ref);
    expect(cleared.inlines).toBe(asParagraph(model, body1).inlines);
  });

  it('batchFormatByStyle 现算目标：只改引用该样式的段落', () => {
    const { model, body1, body2 } = fixture();
    const styled: DocumentModel = {
      ...model,
      blocks: model.blocks.map((block) =>
        block.kind === 'paragraph' && block.id === body1 ? { ...block, style_ref: 'Quote' } : block,
      ),
    };
    const result = batchFormatByStyle(styled, 'Quote', {
      kind: 'paragraph_format',
      format: { alignment: { state: 'set', value: 'right' } },
    });
    if (!result.ok) throw new Error('失败');
    expect(result.changed).toEqual([body1]);
    expect(asParagraph(result.model, body2).properties.alignment).toEqual({ state: 'unspecified' });
  });
});

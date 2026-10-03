/**
 * 分页符 / 分栏符（WF-048、WF-050 的分栏符部分）。
 *
 * 本文件的核心判据是**分页符 ≠ 段前分页**：两者都能让内容翻页，但结构完全不同。
 * 这里用"改一个，另一个不动"的对照，把这两件事**分别指认**出来——
 * 如果实现把它们做成了一个东西，下面这几条会立刻红。
 */

import { describe, expect, it } from 'vitest';
import { DocumentModelError } from '../model/errors.js';
import { setPageBreakBefore } from '../operations/paragraph/pagination.js';
import { defaultParagraphProperties, cellNode, rowNode, tableNode, textParagraphNode } from '../model/nodes.js';
import { createDocumentModel } from '../model/document.js';
import {
  blockAt,
  buildSectionsFixture,
  sequentialIds,
  sectionAt,
  sectionWith,
  sectPrXml,
} from './testing.js';
import {
  breaksOfType,
  insertBreakAt,
  insertColumnBreakInBlock,
  insertPageBreak,
  insertPageBreakInBlock,
  paragraphBreakSources,
  removeBreakInBlock,
  removeBreaksInBlock,
  removeBreaksOfType,
  removeInlineBreak,
} from './breaks.js';
import type { ParagraphNode } from '../model/types.js';

function expectModelError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentModelError);
    expect((error as DocumentModelError).code).toBe(code);
    return;
  }
  throw new Error(`预期抛 DocumentModelError(${code})，但没有抛错`);
}

function paragraph(text: string): ParagraphNode {
  const model = createDocumentModel({
    document_id: 'doc-p',
    sections: [sectionWith({})],
    blocks: [textParagraphNode({ text, source: 'imported' })],
  });
  const block = model.blocks[0];
  if (block === undefined || block.kind !== 'paragraph') throw new Error('夹具失败');
  return block;
}

describe('WF-048 分页符：插入 / 删除（段内行内节点）', () => {
  it('插入分页符：落在段内，产生 w:br[@w:type=page] 对应的 BreakNode', () => {
    const before = paragraph('ABCDE');
    const after = insertPageBreak(before, 2, sequentialIds('b'));

    expect(breaksOfType(after, 'page')).toHaveLength(1);
    expect(paragraphBreakSources(after).inline_page_breaks).toHaveLength(1);
    // 文本被切成两段 run，页面内容一字不差（换行不吞字）。
    const texts = after.inlines.map((inline) => (inline.kind === 'run' ? inline.text : '⏎'));
    expect(texts).toEqual(['AB', '⏎', 'CDE']);
  });

  it('偏移是**码位**：emoji 中间插入不会切出半个代理对（R102）', () => {
    const before = paragraph('AB😀CD'); // 5 个码位
    const after = insertPageBreak(before, 3, sequentialIds('b')); // 在 😀 之后
    const texts = after.inlines.map((inline) => (inline.kind === 'run' ? inline.text : '⏎'));
    expect(texts).toEqual(['AB😀', '⏎', 'CD']);
    // 前半段保留原 run 的 id，后半段是新 id（R101）。
    expect(after.inlines[0]?.id).toBe(before.inlines[0]?.id);
    expect(after.inlines[2]?.id).not.toBe(before.inlines[0]?.id);
  });

  it('段首（偏移 0）与段尾（偏移 = 长度）都能插', () => {
    const base = paragraph('AB');
    const atStart = insertPageBreak(base, 0, sequentialIds('s'));
    const atEnd = insertPageBreak(base, 2, sequentialIds('e'));
    expect(atStart.inlines[0]?.kind).toBe('break');
    expect(atStart.inlines[1]?.kind).toBe('run');
    expect(atEnd.inlines[atEnd.inlines.length - 1]?.kind).toBe('break');
  });

  it('越界偏移被拒绝（不夹紧，R136）', () => {
    const base = paragraph('AB');
    expectModelError(() => insertPageBreak(base, -1, sequentialIds()), 'invalid_index');
    expectModelError(() => insertPageBreak(base, 3, sequentialIds()), 'invalid_index');
    expectModelError(() => insertPageBreak(base, 1.5, sequentialIds()), 'invalid_index');
  });

  it('删除：按 id 精确删掉那一个分页符，其余内容不动', () => {
    const base = paragraph('ABCDE');
    const inserted = insertPageBreak(base, 2, sequentialIds('d'));
    const breakId = paragraphBreakSources(inserted).inline_page_breaks[0];
    if (breakId === undefined) throw new Error('没插进去');

    const removed = removeInlineBreak(inserted, breakId);
    expect(paragraphBreakSources(removed).inline_page_breaks).toEqual([]);
    // 文本与顺序回到原样（拆开的两个 run 不自动合并——本批要求保留而非归一化）。
    expect(removed.inlines.map((inline) => (inline.kind === 'run' ? inline.text : '⏎')).join('')).toBe('ABCDE');
  });

  it('删除不存在的 id 报错（不静默无操作，R112）', () => {
    expectModelError(() => removeInlineBreak(paragraph('AB'), 'nope'), 'unknown_node');
  });

  it('按类型批量清掉（"把这一段里的分页符都去掉"）', () => {
    const base = paragraph('AB');
    const twice = insertPageBreak(insertPageBreak(base, 1, sequentialIds('x')), 2, sequentialIds('y'));
    expect(breaksOfType(twice, 'page')).toHaveLength(2);

    const { paragraph: cleaned, removed } = removeBreaksOfType(twice, 'page');
    expect(removed).toBe(2);
    expect(breaksOfType(cleaned, 'page')).toEqual([]);
    expect(breaksOfType(twice, 'page')).toHaveLength(2); // 输入未被原地改（不可变）
  });
});

describe('WF-048 判据：分页符与"段前分页"是两种不同的结构', () => {
  it('插入分页符 **不** 改动段前分页属性（反之亦然）', () => {
    const base = paragraph('AB');
    expect(base.properties.pageBreakBefore).toEqual({ state: 'unspecified' });

    const withBreak = insertPageBreak(base, 1, sequentialIds('p'));
    // 分页符：inlines 里多了一个 break 节点；段属性**没被碰**。
    expect(paragraphBreakSources(withBreak).inline_page_breaks).toHaveLength(1);
    expect(paragraphBreakSources(withBreak).page_break_before).toEqual({ state: 'unspecified' });

    const withProperty = { ...base, properties: setPageBreakBefore(base.properties, true) };
    // 段前分页：属性变了；**没有**产生任何行内分页符。
    expect(paragraphBreakSources(withProperty).page_break_before).toEqual({ state: 'on' });
    expect(paragraphBreakSources(withProperty).inline_page_breaks).toEqual([]);
  });

  it('两者可以并存，互不覆盖', () => {
    const base = paragraph('AB');
    const both = {
      ...insertPageBreak(base, 1, sequentialIds('q')),
      properties: setPageBreakBefore(defaultParagraphProperties(), true),
    };
    const sources = paragraphBreakSources(both);
    expect(sources.inline_page_breaks).toHaveLength(1);
    expect(sources.page_break_before).toEqual({ state: 'on' });
  });

  it('结构位置不同：一个是 inlines 里的节点，一个是 properties 里的字段', () => {
    const withBreak = insertPageBreak(paragraph('AB'), 1, sequentialIds('r'));
    expect(withBreak.inlines.some((inline) => inline.kind === 'break')).toBe(true);
    expect('pageBreakBefore' in withBreak.properties).toBe(true);

    const withProperty = { ...paragraph('AB'), properties: setPageBreakBefore(defaultParagraphProperties(), true) };
    expect(withProperty.inlines.some((inline) => inline.kind === 'break')).toBe(false);
  });
});

describe('WF-048/050 模型级入口：按块 id 操作', () => {
  function doc(): ReturnType<typeof buildSectionsFixture> {
    return buildSectionsFixture({ sections: [sectionWith({})], blocks_per_section: 2 });
  }

  it('在段落块里插/删分页符', () => {
    const model = doc();
    const blockId = blockAt(model, 0).id;
    const next = insertPageBreakInBlock(model, blockId, 1, sequentialIds('m'));
    const block = blockAt(next, 0);
    if (block.kind !== 'paragraph') throw new Error('夹具失败');
    const breakId = paragraphBreakSources(block).inline_page_breaks[0];
    if (breakId === undefined) throw new Error('没插进去');

    const cleaned = removeBreakInBlock(next, blockId, breakId);
    const cleanedBlock = blockAt(cleaned, 0);
    if (cleanedBlock.kind !== 'paragraph') throw new Error('夹具失败');
    expect(paragraphBreakSources(cleanedBlock).inline_page_breaks).toEqual([]);
  });

  it('对表格块插分页符被拒绝', () => {
    const tableModel = createDocumentModel({
      document_id: 'doc-t',
      sections: [sectionWith({})],
      blocks: [
        textParagraphNode({ text: 'x', source: 'imported' }),
        tableNode({
          source: 'imported',
          rows: [
            rowNode({
              source: 'imported',
              cells: [cellNode({ source: 'imported', blocks: [textParagraphNode({ text: 'c', source: 'imported' })] })],
            }),
          ],
        }),
      ],
    });
    const table = tableModel.blocks[1];
    if (table === undefined || table.kind !== 'table') throw new Error('夹具没造出表格');
    expectModelError(() => insertPageBreakInBlock(tableModel, table.id, 0, sequentialIds()), 'unsupported');

    // 但**单元格里的段落**是允许的：分页符是 run 级节点，OOXML 里放在单元格段落里合法
    // （与"分节符只能落在正文段落"不同——那是 CT_SectPr 的约束，见 section-breaks.ts）。
    const cellParagraphId = table.rows[0]?.cells[0]?.blocks[0]?.id ?? '';
    expect(cellParagraphId).not.toBe('');
    const next = insertPageBreakInBlock(tableModel, cellParagraphId, 0, sequentialIds('cell'));
    const cellParagraph = (next.blocks[1] as typeof table).rows[0]?.cells[0]?.blocks[0];
    if (cellParagraph === undefined || cellParagraph.kind !== 'paragraph') throw new Error('夹具失败');
    expect(paragraphBreakSources(cellParagraph).inline_page_breaks).toHaveLength(1);
  });

  it('批量清掉某块里的分页符', () => {
    const model = doc();
    const blockId = blockAt(model, 0).id;
    const withBreak = insertPageBreakInBlock(model, blockId, 1, sequentialIds('n'));
    const cleaned = removeBreaksInBlock(withBreak, blockId, 'page');
    const block = blockAt(cleaned, 0);
    if (block.kind !== 'paragraph') throw new Error('夹具失败');
    expect(paragraphBreakSources(block).inline_page_breaks).toEqual([]);
  });
});

describe('WF-050 分栏符：只在多栏节里有意义', () => {
  it('单栏节里插分栏符被拒绝（操作前拒绝，文档不变，R140）', () => {
    const model = buildSectionsFixture({
      sections: [sectionWith({ columns: 1 })],
      blocks_per_section: 2,
    });
    expectModelError(
      () => insertColumnBreakInBlock(model, blockAt(model, 0).id, 1, sequentialIds()),
      'unsupported',
    );
  });

  it('双栏节里插分栏符成功', () => {
    const model = buildSectionsFixture({
      sections: [sectionWith({ columns: 2 })],
      blocks_per_section: 2,
    });
    const next = insertColumnBreakInBlock(model, blockAt(model, 0).id, 1, sequentialIds('c'));
    const block = blockAt(next, 0);
    if (block.kind !== 'paragraph') throw new Error('夹具失败');
    expect(paragraphBreakSources(block).inline_column_breaks).toHaveLength(1);
  });

  it('未指定栏数时不拒绝（"没设过"不等于"一定是单栏"）', () => {
    const model = buildSectionsFixture({ sections: [sectionWith({})], blocks_per_section: 2 });
    const next = insertColumnBreakInBlock(model, blockAt(model, 0).id, 0, sequentialIds('u'));
    const block = blockAt(next, 0);
    if (block.kind !== 'paragraph') throw new Error('夹具失败');
    expect(paragraphBreakSources(block).inline_column_breaks).toHaveLength(1);
  });

  it('分栏符只改内联节点，不改节属性（sectPr 逐字符不变）', () => {
    const model = buildSectionsFixture({
      sections: [sectionWith({ columns: 2 })],
      blocks_per_section: 2,
    });
    const before = sectPrXml(sectionAt(model, 0));
    const next = insertColumnBreakInBlock(model, blockAt(model, 0).id, 1, sequentialIds('v'));
    expect(sectPrXml(sectionAt(next, 0))).toBe(before);
  });

  it('insertBreakAt 对三种类型都能用（软换行 / 分页 / 分栏）', () => {
    const base = paragraph('AB');
    for (const type of ['line', 'page', 'column'] as const) {
      const next = insertBreakAt(base, 1, type, sequentialIds('t'));
      expect(breaksOfType(next, type), type).toHaveLength(1);
    }
  });
});

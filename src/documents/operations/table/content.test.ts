/**
 * 表格内容编辑与文本互转测试（WF-064）。
 *
 * 判据："查找替换、粘贴行列、文本与表格互转；**不伪造数据**" —— 这里重点钉三件事：
 * 1. 找不到就说找不到（`replaced: 0`），不是假装改了；
 * 2. 互转只搬运原文内容，缺的位置留**空**（测试断言那个格子是空串，而不是任何占位文本）；
 * 3. 表外的块、以及被切开的 run 的**字符格式**都不丢。
 */

import { describe, expect, it } from 'vitest';
import { createDocumentModel } from '../../model/document.js';
import { paragraphNode, runNode, textParagraphNode } from '../../model/nodes.js';
import type { DocumentModel, ParagraphNode } from '../../model/types.js';
import { validateDocument } from '../../model/validation.js';
import { replaceTextInTable, splitInlinesOnSeparator, tableTexts, tableToText, textToTable } from './content.js';
import { cellTextAt, firstTableId, plainTableModel, tableOf } from './fixtures.js';

function errorCount(model: DocumentModel): number {
  return validateDocument(model).errors.length;
}

function textOf(model: DocumentModel, index: number): string {
  const block = model.blocks[index];
  if (block === undefined || block.kind !== 'paragraph') {
    throw new Error(`第 ${String(index)} 块不是段落`);
  }
  return block.inlines.map((inline) => (inline.kind === 'run' ? inline.text : '')).join('');
}

describe('表格内查找替换（WF-064）', () => {
  it('替换命中若干处，计数与单元格列表如实返回', () => {
    const model = plainTableModel();
    const outcome = replaceTextInTable(model, { table_id: firstTableId(model), find: 'a', replace: '甲' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // a1 / a2 / a3 三处。
    expect(outcome.replaced).toBe(3);
    expect(outcome.cell_ids.length).toBe(3);
    expect(cellTextAt(outcome.model, 0, 0)).toBe('甲1');
    expect(cellTextAt(outcome.model, 2, 0)).toBe('甲3');
    expect(errorCount(outcome.model)).toBe(0);
  });

  it('一处都找不到 ⇒ replaced: 0（事实，不是编造），模型不变', () => {
    const model = plainTableModel();
    const outcome = replaceTextInTable(model, { table_id: firstTableId(model), find: '找不到', replace: 'x' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.replaced).toBe(0);
    expect(outcome.model).toBe(model);
  });

  it('表外的正文一个字都不碰（对象引用不变）', () => {
    const model = plainTableModel();
    const outcome = replaceTextInTable(model, { table_id: firstTableId(model), find: 'a', replace: '甲' });
    if (!outcome.ok) throw new Error('应先成功');
    expect(outcome.model.blocks[0]).toBe(model.blocks[0]);
    expect(outcome.model.blocks[2]).toBe(model.blocks[2]);
  });

  it('空查找串 ⇒ unsupported（语义不清，明确拒绝）', () => {
    const model = plainTableModel();
    const outcome = replaceTextInTable(model, { table_id: firstTableId(model), find: '', replace: 'x' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('unsupported');
  });

  it('同一单元格里多处出现也被逐处替换', () => {
    const model = createDocumentModel({
      document_id: 'doc-repeat',
      blocks: [
        {
          kind: 'table',
          source: 'imported',
          opaque: [],
          properties: {
            alignment: { state: 'unspecified' },
            indent: { state: 'unspecified' },
            width: { state: 'unspecified' },
            layout: { state: 'unspecified' },
            borders: { state: 'unspecified' },
            shading: { state: 'unspecified' },
            repeatHeader: false,
          },
          grid: [],
          rows: [
            {
              kind: 'row',
              source: 'imported',
              opaque: [],
              height: { state: 'unspecified' },
              header: false,
              cells: [
                {
                  kind: 'cell',
                  source: 'imported',
                  opaque: [],
                  grid_span: 1,
                  vertical_merge: null,
                  properties: {
                    verticalAlign: { state: 'unspecified' },
                    shading: { state: 'unspecified' },
                    borders: { state: 'unspecified' },
                    width: { state: 'unspecified' },
                  },
                  blocks: [textParagraphNode({ text: 'x x x', source: 'imported' })],
                },
              ],
            },
          ],
        },
      ],
    });
    const outcome = replaceTextInTable(model, { table_id: firstTableId(model), find: 'x', replace: 'y' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.replaced).toBe(3);
    expect(cellTextAt(outcome.model, 0, 0)).toBe('y y y');
  });
});

describe('表格 → 文本（WF-064）', () => {
  it('一行一段，单元格用分隔符连接；表外段落引用不变', () => {
    const model = plainTableModel();
    const outcome = tableToText(model, { table_id: firstTableId(model), separator: '\t' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.paragraphs).toBe(3);
    expect(outcome.text).toBe('a1\tb1\tc1\na2\tb2\tc2\na3\tb3\tc3');
    expect(outcome.model.blocks.map((block) => block.kind)).toEqual([
      'paragraph',
      'paragraph',
      'paragraph',
      'paragraph',
      'paragraph',
    ]);
    // 表前后段落还是同一批对象。
    expect(outcome.model.blocks[0]).toBe(model.blocks[0]);
    expect(outcome.model.blocks[4]).toBe(model.blocks[2]);
    // 转出的段落沿用原表来源（imported），不冒充用户新说的话（R109/R148）。
    expect(outcome.model.blocks[1]?.source).toBe('imported');
    expect(errorCount(outcome.model)).toBe(0);
  });

  it('转出的文本与模型内容一字不差（text 字段可用于核对）', () => {
    const model = plainTableModel();
    const outcome = tableToText(model, { table_id: firstTableId(model), separator: '|' });
    if (!outcome.ok) throw new Error('应先成功');
    const lines = outcome.text.split('\n');
    expect(lines).toEqual(['a1|b1|c1', 'a2|b2|c2', 'a3|b3|c3']);
    expect(lines.map((_line, index) => textOf(outcome.model, index + 1))).toEqual(lines);
  });
});

describe('文本 → 表格（WF-064）', () => {
  function paragraphsModel(texts: readonly string[]): DocumentModel {
    return createDocumentModel({
      document_id: 'doc-paragraphs',
      blocks: texts.map((text) => textParagraphNode({ text, source: 'user_request' })),
    });
  }

  it('按分隔符切分成单元格；短行右侧补**空**格（不补假数据）', () => {
    const model = paragraphsModel(['a,b,c', 'd,e']);
    const outcome = textToTable(model, { from_index: 0, to_index: 1, separator: ',' , source: 'user_request' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rows).toBe(2);
    expect(outcome.columns).toBe(3);
    expect(tableTexts(tableOf(outcome.model))).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e', ''],
    ]);
    expect(outcome.model.blocks.length).toBe(1);
    expect(outcome.model.blocks[0]?.kind).toBe('table');
    expect(errorCount(outcome.model)).toBe(0);
  });

  it('range 里含非段落 ⇒ unsupported，模型不变', () => {
    const model = plainTableModel(); // [段, 表, 段]
    const outcome = textToTable(model, { from_index: 0, to_index: 2, separator: ',' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('unsupported');
    expect(model.blocks.length).toBe(3);
  });

  it('区间非法 / 空分隔符 ⇒ 结构化拒绝', () => {
    const model = paragraphsModel(['x']);
    const bad = textToTable(model, { from_index: 1, to_index: 0, separator: ',' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('invalid_index');
    const noSeparator = textToTable(model, { from_index: 0, to_index: 0, separator: '' });
    expect(noSeparator.ok).toBe(false);
    if (!noSeparator.ok) expect(noSeparator.code).toBe('unsupported');
  });

  it('切分保留 run 的字符格式（加粗片段转换后仍加粗）', () => {
    const bold = { ...zeroRunProps(), bold: { state: 'on' as const } };
    const paragraph: ParagraphNode | undefined = undefined;
    void paragraph;
    const model = createDocumentModel({
      document_id: 'doc-bold',
      blocks: [
        paragraphNode({
          source: 'user_request',
          inlines: [
            runNode({ text: 'plain,', source: 'user_request' }),
            runNode({ text: 'bold', source: 'user_request', properties: bold }),
          ],
        }),
      ],
    });
    const outcome = textToTable(model, { from_index: 0, to_index: 0, separator: ',' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const table = tableOf(outcome.model);
    const second = table.rows[0]?.cells[1];
    const block = second?.blocks[0];
    if (block === undefined || block.kind !== 'paragraph') {
      throw new Error('第二格应有段落');
    }
    // 第 2 格里可能还带着切分产生的空 run（"plain," 切出的后半段是空串）——
    // 空 run 刻意保留：它承载原 run 的格式，删掉才是真正丢信息。
    const texts = block.inlines.map((inline) => (inline.kind === 'run' ? inline.text : ''));
    expect(texts.join('')).toBe('bold');
    const boldRun = block.inlines.find((inline) => inline.kind === 'run' && inline.text === 'bold');
    expect(boldRun?.kind).toBe('run');
    if (boldRun?.kind === 'run') {
      expect(boldRun.properties.bold).toEqual({ state: 'on' });
    }
  });

  it('文本 → 表格 → 文本 回到同一串（往返一致）', () => {
    const model = paragraphsModel(['p,q,r', 's,t,u']);
    const toTable = textToTable(model, { from_index: 0, to_index: 1, separator: ',' });
    if (!toTable.ok) throw new Error('应先成功');
    const back = tableToText(toTable.model, { table_id: toTable.table_id, separator: ',' });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.text).toBe('p,q,r\ns,t,u');
  });

  it('splitInlinesOnSeparator 支持软换行与域节点（不丢节点）', () => {
    const model = createDocumentModel({
      document_id: 'doc-breaks',
      blocks: [
        paragraphNode({
          source: 'user_request',
          inlines: [
            runNode({ text: 'a', source: 'user_request' }),
            { kind: 'break', breakType: 'line', source: 'user_request', opaque: [] },
            runNode({ text: 'b,c', source: 'user_request' }),
          ],
        }),
      ],
    });
    const paragraph = model.blocks[0];
    if (paragraph === undefined || paragraph.kind !== 'paragraph') {
      throw new Error('应是段落');
    }
    const groups = splitInlinesOnSeparator(paragraph, ',');
    // 整段文本是 "a⏎b,c"（⏎ = 软换行），按 ',' 切 ⇒ 两格："a⏎b" 与 "c"。
    // 软换行节点留在它原来所在的片段里，没有被丢掉。
    expect(groups.length).toBe(2);
    expect(groups[0]?.map((inline) => inline.kind)).toEqual(['run', 'break', 'run']);
    expect(groups[1]?.map((inline) => inline.kind)).toEqual(['run']);
  });
});

/** 全 unspecified 的 run 属性（构造"只加粗"的测试属性）。 */
function zeroRunProps(): import('../../model/types.js').RunProperties {
  const unspecified = { state: 'unspecified' as const };
  return {
    bold: unspecified,
    italic: unspecified,
    underline: unspecified,
    strike: unspecified,
    doubleStrike: unspecified,
    vertAlign: unspecified,
    fonts: unspecified,
    size: unspecified,
    scale: unspecified,
    position: unspecified,
    color: unspecified,
    highlight: unspecified,
    shading: unspecified,
    spacing: unspecified,
    caps: unspecified,
    smallCaps: unspecified,
  };
}

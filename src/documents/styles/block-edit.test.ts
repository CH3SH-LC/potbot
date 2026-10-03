/**
 * 段落/块移动、复制、删除测试（WF-043）。
 *
 * 判据：
 * - **稳定定位**：以 id 为入口，移动/删除后按 id 仍能找到同一个块；
 * - **内部引用保持**：副本保留 `style_ref` / `numbering`（指向同一份样式与同一个 numId）；
 * - **邻接格式保持**：未受影响的块**对象引用不变**（机械判据，不是读回比对）；
 * - 复制必须取新 id（否则文档里出现两个同 id 节点）。
 */

import { describe, expect, it } from 'vitest';
import type { DocumentModel, ParagraphNode } from '../model/types.js';
import type { StyleDefinition, StyleTable } from '../model/types.js';
import { createDocumentModel } from '../model/document.js';
import { cellNode, paragraphNode, rowNode, tableNode } from '../model/nodes.js';
import { blockById, copyBlock, deleteBlock, duplicateBlock, moveBlock, moveBlockBefore, neighborSnapshot } from './block-edit.js';
import { collectNodeIds } from '../model/walk.js';

function style(style_id: string): StyleDefinition {
  return {
    style_id,
    name: style_id,
    type: 'paragraph',
    based_on: null,
    run_properties: {},
    paragraph_properties: {},
    is_default: false,
  };
}

const STYLES: StyleTable = { styles: [style('Quote')] };

/** 四段文档：p1 / p2（引用样式 + 列表）/ p3 / 表格。 */
function fixture(): DocumentModel {
  return createDocumentModel({
    document_id: 'doc',
    styles: STYLES,
    blocks: [
      paragraphNode({ source: 'user_request' }),
      paragraphNode({ source: 'user_request', style_ref: 'Quote', numbering: { num_id: '7', level: 1 } }),
      paragraphNode({ source: 'user_request' }),
      tableNode({
        source: 'user_request',
        grid: [],
        rows: [
          rowNode({
            source: 'user_request',
            cells: [cellNode({ source: 'user_request', blocks: [paragraphNode({ source: 'user_request' })] })],
          }),
        ],
      }),
    ],
  });
}

function paragraph(model: DocumentModel, index: number): ParagraphNode {
  return model.blocks[index] as ParagraphNode;
}

describe('移动（WF-043）', () => {
  it('按 id 移动，位置变化但身份不变', () => {
    const model = fixture();
    const target = paragraph(model, 2);
    const result = moveBlock(model, target.id, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.blocks[0]?.id).toBe(target.id);
    // 身份不变：还是同一个对象（连同其 id 原样搬运，R101）。
    expect(result.model.blocks[0]).toBe(target);
    // 原模型未变。
    expect(model.blocks[2]).toBe(target);
  });

  it('邻接格式保持：未受影响的块对象引用不变', () => {
    const model = fixture();
    const moved = paragraph(model, 1);
    const result = moveBlock(model, moved.id, 3);
    if (!result.ok) throw new Error('移动失败');
    // 未参与移动的 p3 与表格：引用原样。
    expect(result.model.blocks.find((block) => block.id === paragraph(model, 2).id)).toBe(paragraph(model, 2));
    // 表未参与移动：它在移动后的新下标上，但仍是同一个对象。
    expect(result.model.blocks[2]).toBe(model.blocks[3]);
    expect(result.model.blocks[3]).toBe(moved);
  });

  it('moveBlockBefore 把块拖到另一个块之前（含自后向前的下标换算）', () => {
    const model = fixture();
    const third = paragraph(model, 2);
    const first = paragraph(model, 0);
    const result = moveBlockBefore(model, third.id, first.id);
    if (!result.ok) throw new Error('移动失败');
    expect(result.model.blocks[0]?.id).toBe(third.id);
    expect(result.model.blocks[1]?.id).toBe(first.id);
  });

  it('反面：移动不存在的块 → 失败且不产出模型', () => {
    const result = moveBlock(fixture(), 'ghost', 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unknown_node');
  });

  it('反面：越界目标下标 → 失败', () => {
    const model = fixture();
    const result = moveBlock(model, paragraph(model, 0).id, 99);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_index');
  });
});

describe('删除（WF-043）', () => {
  it('删掉中间段后，序列顺序正确且邻居引用不变', () => {
    const model = fixture();
    const middle = paragraph(model, 1);
    const before = neighborSnapshot(model, middle.id);
    expect(before?.previous?.id).toBe(paragraph(model, 0).id);
    expect(before?.next?.id).toBe(paragraph(model, 2).id);

    const result = deleteBlock(model, middle.id);
    if (!result.ok) throw new Error('删除失败');
    expect(result.model.blocks).toHaveLength(3);
    expect(blockById(result.model, middle.id)).toBeNull();
    // 邻接格式保持：前后邻居仍是同一批对象。
    expect(blockById(result.model, before?.previous?.id ?? '')).toBe(before?.previous);
    expect(blockById(result.model, before?.next?.id ?? '')).toBe(before?.next);
  });

  it('反面：删除不存在的块 → 失败', () => {
    const result = deleteBlock(fixture(), 'ghost');
    expect(result.ok).toBe(false);
  });
});

describe('复制（WF-043 的"内部引用保持"）', () => {
  it('副本获得全新 id，但保留样式引用与列表引用', () => {
    const model = fixture();
    const source = paragraph(model, 1);
    const result = copyBlock(model, source.id, 4);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const copy = result.model.blocks[4] as ParagraphNode;
    expect(copy.id).not.toBe(source.id);
    // 内部引用保持：同一个命名样式、同一个列表实例。
    expect(copy.style_ref).toBe('Quote');
    expect(copy.numbering).toEqual({ num_id: '7', level: 1 });
    // 原件不动，仍在原位。
    expect(result.model.blocks[1]).toBe(source);
  });

  it('副本内部节点 id 全部是新的（文档里不存在两个同 id 节点）', () => {
    const model = fixture();
    const source = paragraph(model, 1);
    const result = copyBlock(model, source.id, 4);
    if (!result.ok) throw new Error('复制失败');
    const ids = collectNodeIds(result.model);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('duplicateBlock 紧跟其后插入，副本 id 与源不同', () => {
    const model = fixture();
    const source = paragraph(model, 0);
    const result = duplicateBlock(model, source.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.copy_id).not.toBe(source.id);
    expect(result.model.blocks[1]?.id).toBe(result.copy_id);
  });

  it('复制表格：保留网格与单元格结构，id 全换新', () => {
    const model = fixture();
    const table = model.blocks[3];
    if (table === undefined) throw new Error('缺少表格');
    const result = copyBlock(model, table.id, 0);
    if (!result.ok) throw new Error('复制失败');
    const copy = result.model.blocks[0];
    expect(copy?.kind).toBe('table');
    expect(copy?.id).not.toBe(table.id);
    if (copy?.kind === 'table' && table.kind === 'table') {
      expect(copy.rows[0]?.cells[0]?.id).not.toBe(table.rows[0]?.cells[0]?.id);
      expect(copy.rows[0]?.cells[0]?.blocks[0]?.id).not.toBe(table.rows[0]?.cells[0]?.blocks[0]?.id);
    }
  });

  it('复制单元格内的块（单元格容器路径）', () => {
    const model = fixture();
    const table = model.blocks[3];
    if (table === undefined || table.kind !== 'table') throw new Error('缺少表格');
    const inner = table.rows[0]?.cells[0]?.blocks[0];
    if (inner === undefined) throw new Error('缺少单元格内段落');
    const result = copyBlock(model, inner.id, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const newTable = result.model.blocks[3];
    if (newTable?.kind !== 'table') throw new Error('表格丢失');
    expect(newTable.rows[0]?.cells[0]?.blocks).toHaveLength(2);
    expect(newTable.rows[0]?.cells[0]?.blocks[0]).toBe(inner);
    expect(newTable.rows[0]?.cells[0]?.blocks[1]?.id).not.toBe(inner.id);
  });

  it('反面：复制不存在的块 → 失败', () => {
    const result = copyBlock(fixture(), 'ghost', 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unknown_node');
  });

  it('反面：越界插入下标 → 失败且不产出模型', () => {
    const model = fixture();
    const result = copyBlock(model, paragraph(model, 0).id, 99);
    expect(result.ok).toBe(false);
  });
});

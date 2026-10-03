/**
 * 整篇不变量自检（R100–R110 / R159–R162）。
 *
 * 要挡死的三条硬项：**id 唯一**、**块序列合法**、**关系目标存在**（悬空 rId）。
 * 另外本组将"error 与 warning 的分界"作为**可执行的判据**钉住：
 * 首行/悬挂冲突、相邻两表、run 文本里的换行都只报 warning（导入不得因此被拒），
 * 而重复 id、槽位里放错节点、锚点指向不存在的节点则是 error。
 *
 * 造"坏模型"的做法：先造合法模型，**取真实物化过的节点**再打补丁——
 * 避免手搓嵌套节点时把 id 之类的东西漏掉，让用例偏离它真正想测的那一项。
 */

import { describe, expect, it } from 'vitest';

import { specified } from './attributes.js';
import { createDocumentModel } from './document.js';
import { DocumentModelError } from './errors.js';
import { defaultIndentProperties, defaultParagraphProperties, paragraphNode } from './nodes.js';
import { twoByTwoTable, blockAt, errorCodes, paragraphBlockAt, rowAt, sampleDocument, tableBlockAt, warningCodes } from './fixtures.js';
import type { BlockNode, CellNode, CommentNode, DocumentModel, InlineNode, RowNode, TableNode } from './types.js';
import { assertDocumentInvariants, describeValidationReport, isSourceKind, validateDocument } from './validation.js';

function tableSample(): DocumentModel {
  return createDocumentModel({ document_id: 'doc-table', blocks: [twoByTwoTable()] });
}

describe('干净模型：通过且无 error', () => {
  it('样本文档 0 error', () => {
    const report = validateDocument(sampleDocument());
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(describeValidationReport(report)).toContain('通过');
  });

  it('表格样本 0 error', () => {
    expect(validateDocument(tableSample()).ok).toBe(true);
  });
});

describe('硬项一：id 唯一', () => {
  it('同一 id 出现两次 ⇒ duplicate_id（error）', () => {
    const base = sampleDocument();
    const first = blockAt(base, 0);
    const broken: DocumentModel = { ...base, blocks: [first, first] };
    const report = validateDocument(broken);
    expect(report.ok).toBe(false);
    expect(errorCodes(report)).toContain('duplicate_id');
  });

  it('非规范 id ⇒ 只报 warning（导入的历史 id 不该让整篇被拒）', () => {
    const base = sampleDocument();
    // 只改第 1 块（第 0 块是批注锚点目标，改它只会额外报悬空锚点，偏离本用例意图）
    const broken: DocumentModel = {
      ...base,
      blocks: [blockAt(base, 0), { ...blockAt(base, 1), id: 'p1' } as BlockNode, ...base.blocks.slice(2)],
    };
    const report = validateDocument(broken);
    expect(errorCodes(report)).toEqual([]);
    expect(warningCodes(report)).toContain('non_canonical_id');
  });

  it('assertDocumentInvariants 抛错且带 code', () => {
    const base = sampleDocument();
    const first = blockAt(base, 0);
    const broken: DocumentModel = { ...base, blocks: [first, first] };
    let code: string | null = null;
    try {
      assertDocumentInvariants(broken);
    } catch (error) {
      code = error instanceof DocumentModelError ? error.code : 'not-model-error';
    }
    expect(code).toBe('duplicate_id');
  });
});

describe('硬项二：块序列合法', () => {
  it('块槽位里放 run ⇒ invalid_block_sequence', () => {
    const base = sampleDocument();
    const runAsBlock = paragraphBlockAt(base, 2).inlines[0] as unknown as BlockNode;
    const broken: DocumentModel = { ...base, blocks: [runAsBlock] };
    expect(errorCodes(validateDocument(broken))).toContain('invalid_block_sequence');
  });

  it('行内槽位里放表格行 ⇒ invalid_node', () => {
    // 样本文档：第 0 段是段落、第 3 块是表格
    const base = sampleDocument();
    const row = rowAt(tableBlockAt(base, 3), 0) as unknown as InlineNode;
    const paragraph = paragraphBlockAt(base, 0);
    const broken: DocumentModel = { ...base, blocks: [{ ...paragraph, inlines: [row] }] };
    expect(errorCodes(validateDocument(broken))).toContain('invalid_node');
  });

  it('source 不在四类之内 ⇒ invalid_node（R109）', () => {
    const base = sampleDocument();
    const broken: DocumentModel = {
      ...base,
      blocks: [{ ...blockAt(base, 0), source: 'made_up' } as unknown as BlockNode],
    };
    expect(errorCodes(validateDocument(broken))).toContain('invalid_node');
    expect(isSourceKind('imported')).toBe(true);
    expect(isSourceKind('made_up')).toBe(false);
  });
});

describe('表格结构不变量', () => {
  it('行没有任何单元格 ⇒ table_shape_invalid', () => {
    const base = tableSample();
    const table = tableBlockAt(base, 0);
    const emptyRow: RowNode = { ...rowAt(table, 0), cells: [] };
    const broken: DocumentModel = { ...base, blocks: [{ ...table, rows: [emptyRow] }] };
    expect(errorCodes(validateDocument(broken))).toContain('table_shape_invalid');
  });

  it('vertical_merge="continue" 上方没有 restart ⇒ table_shape_invalid', () => {
    const base = tableSample();
    const table = tableBlockAt(base, 0);
    const row0 = rowAt(table, 0);
    const cell0 = row0.cells[0] as CellNode;
    const patchedRow0: RowNode = { ...row0, cells: [{ ...cell0, vertical_merge: 'continue' }, row0.cells[1] as CellNode] };
    const patchedTable: TableNode = { ...table, rows: [patchedRow0, rowAt(table, 1)] };
    const broken: DocumentModel = { ...base, blocks: [patchedTable] };
    expect(errorCodes(validateDocument(broken))).toContain('table_shape_invalid');
  });

  it('grid_span 为 0 ⇒ table_shape_invalid', () => {
    const base = tableSample();
    const table = tableBlockAt(base, 0);
    const row0 = rowAt(table, 0);
    const cell0 = row0.cells[0] as CellNode;
    const patchedRow0: RowNode = { ...row0, cells: [{ ...cell0, grid_span: 0 }, row0.cells[1] as CellNode] };
    const broken: DocumentModel = { ...base, blocks: [{ ...table, rows: [patchedRow0, rowAt(table, 1)] }] };
    expect(errorCodes(validateDocument(broken))).toContain('table_shape_invalid');
  });
});

describe('硬项三：批注锚点', () => {
  it('锚点指向不存在的节点 ⇒ dangling_comment_anchor（error）', () => {
    const base = sampleDocument();
    const comment = base.comments[0] as CommentNode;
    const broken: DocumentModel = {
      ...base,
      comments: [{ ...comment, anchor: { node_id: 'n/body:0/paragraph:99', start: 0, end: 1 } }],
    };
    expect(errorCodes(validateDocument(broken))).toContain('dangling_comment_anchor');
  });

  it('锚点指向存在的节点 ⇒ 通过（构造期就把路径解析成了 id）', () => {
    const base = sampleDocument();
    const comment = base.comments[0] as CommentNode;
    expect(comment.anchor?.node_id).toBe(blockAt(base, 0).id);
    expect(validateDocument(base).ok).toBe(true);
  });

  it('锚点路径解析不到 ⇒ 构造期即抛（不把锚点挂到别的节点上）', () => {
    expect(() =>
      createDocumentModel({
        document_id: 'doc-anchor',
        blocks: [paragraphNode({ source: 'user_request' })],
        comments: [
          {
            kind: 'comment',
            source: 'user_request',
            opaque: [],
            author: '诚哥',
            text: 'x',
            anchor: { path: [{ kind: 'body', index: 0 }, { kind: 'paragraph', index: 5 }], start: 0, end: 1 },
          },
        ],
      }),
    ).toThrow(DocumentModelError);
  });
});

describe('warning 的可表示项（不阻断导入）', () => {
  it('相邻两张表 ⇒ adjacent_tables（warning，构造不受阻）', () => {
    const model = createDocumentModel({
      document_id: 'doc-adjacent',
      blocks: [twoByTwoTable(), twoByTwoTable()],
    });
    const report = validateDocument(model);
    expect(report.ok).toBe(true);
    expect(warningCodes(report)).toContain('adjacent_tables');
  });

  it('首行缩进与悬挂缩进同时设置 ⇒ conflicting_indent（warning）', () => {
    const model = createDocumentModel({
      document_id: 'doc-indent',
      blocks: [
        paragraphNode({
          source: 'imported',
          properties: {
            ...defaultParagraphProperties(),
            indent: {
              ...defaultIndentProperties(),
              firstLine: specified({ unit: 'chars', value: 2 }),
              hanging: specified({ unit: 'chars', value: 1 }),
            },
          },
        }),
      ],
    });
    const report = validateDocument(model);
    expect(report.ok).toBe(true);
    expect(warningCodes(report)).toContain('conflicting_indent');
  });

  it('文档没有节 ⇒ warning（可表示但要提醒）', () => {
    const base = sampleDocument();
    const report = validateDocument({ ...base, sections: [] });
    expect(report.ok).toBe(true);
    expect(warningCodes(report)).toContain('invalid_document');
  });

  it('媒体内容类型不是 image/* ⇒ warning', () => {
    const model = createDocumentModel(
      {
        document_id: 'doc-media',
        blocks: [paragraphNode({ source: 'imported' })],
        relationships: [
          {
            id: 'rId1',
            type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
            target: 'media/pic.bin',
            target_mode: 'Internal',
            owner_part_path: 'word/document.xml',
          },
        ],
        media: [
          {
            path: 'word/media/pic.bin',
            content_type: 'application/octet-stream',
            relationship_id: 'rId1',
            bytes: new Uint8Array([1, 2, 3]),
          },
        ],
      },
      { known_part_paths: ['word/document.xml'] },
    );
    const report = validateDocument(model, { known_part_paths: ['word/document.xml'] });
    expect(report.ok).toBe(true);
    expect(warningCodes(report)).toContain('invalid_node');
  });
});

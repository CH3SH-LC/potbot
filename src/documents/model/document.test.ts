/**
 * `DocumentModel` 构造与自检、节点工厂、文本投影，以及不可变更新原语。
 */

import { describe, expect, it } from 'vitest';

import { UNSPECIFIED_VALUE } from './attributes.js';
import { TOGGLE_UNSPECIFIED } from './types.js';
import {
  createDocumentModel,
  createEmptyDocumentModel,
  describeDocumentModel,
  emptyContentTypeTable,
  emptyStyleTable,
  recheckDocument,
} from './document.js';
import { DocumentModelError } from './errors.js';
import {
  cloneDocument,
  deepFreezeDocument,
  insertAt,
  moveWithin,
  removeAt,
  replaceAt,
  withRevision,
} from './immutable.js';
import { isNodeId } from './ids.js';
import {
  breakNode,
  cellNode,
  defaultRunProperties,
  fieldNode,
  paragraphNode,
  rowNode,
  runNode,
  tableNode,
  textParagraphNode,
} from './nodes.js';
import { documentParagraphTexts, documentPlainText, paragraphPlainText } from './text.js';
import { collectNodeIds, countBlocks } from './walk.js';
import type { DocumentModel } from './types.js';
import { blockAt, paragraphBlockAt, sampleBlocks, sampleDocument } from './fixtures.js';

describe('createDocumentModel：构造 + 立刻自检', () => {
  it('按文档顺序分配规范 id，且 id 唯一', () => {
    const model = sampleDocument();
    const ids = collectNodeIds(model);
    expect(ids.filter((id) => !isNodeId(id))).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
    // 文档顺序 = 深度优先：第 0 块是第 0 段
    expect(ids[0]).toBe('n/body:0/paragraph:0');
    expect(collectNodeIds(model)[0]).toBe(blockAt(model, 0).id);
  });

  it('元数据与默认值', () => {
    const model = createDocumentModel({ document_id: 'doc-meta' });
    expect(model.document_id).toBe('doc-meta');
    expect(model.revision).toBe(0);
    expect(model.blocks).toEqual([]);
    expect(model.sections.length).toBe(1);
    expect(model.styles).toEqual(emptyStyleTable());
    expect(model.content_types).toEqual(emptyContentTypeTable());
    expect(model.relationships).toEqual([]);
    expect(model.media).toEqual([]);
    expect(model.opaque_parts).toEqual([]);
    expect(describeDocumentModel(model)).toContain('document_id=doc-meta');
  });

  it('批注锚点路径被解析成真实节点 id', () => {
    const model = sampleDocument();
    const comment = model.comments[0];
    expect(comment?.id).toBe('n/comment:0');
    expect(comment?.anchor?.node_id).toBe(blockAt(model, 0).id);
  });

  it('document_id 为空 / revision 非法 ⇒ 构造期即拒', () => {
    expect(() => createDocumentModel({ document_id: '' })).toThrow(DocumentModelError);
    expect(() => createDocumentModel({ document_id: 'd', revision: -1 })).toThrow(DocumentModelError);
    expect(() => createDocumentModel({ document_id: 'd', revision: 1.5 })).toThrow(DocumentModelError);
  });

  it('非法文档在构造期就被挡住（不产出半成品）', () => {
    // 媒体绑定了不存在的关系 ⇒ 悬空 rId
    expect(() =>
      createDocumentModel({
        document_id: 'd',
        blocks: [textParagraphNode({ text: 'x', source: 'imported' })],
        media: [
          {
            path: 'word/media/a.png',
            content_type: 'image/png',
            relationship_id: 'rId404',
            bytes: new Uint8Array([1]),
          },
        ],
      }),
    ).toThrow(DocumentModelError);
  });

  it('recheckDocument 给出结构化报告，不抛错', () => {
    const model = sampleDocument();
    const report = recheckDocument(model);
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });
});

describe('createEmptyDocumentModel', () => {
  it('一份最小可写空文档：一个空段落 + 一个默认节', () => {
    const model = createEmptyDocumentModel({ document_id: 'doc-empty' });
    expect(model.blocks.length).toBe(1);
    expect(paragraphBlockAt(model, 0).inlines).toEqual([]);
    expect(model.sections.length).toBe(1);
    expect(model.revision).toBe(0);
  });

  it('占位段落默认来源是 system（不是 user_request，R109/R148）', () => {
    expect(paragraphBlockAt(createEmptyDocumentModel({ document_id: 'd' }), 0).source).toBe('system');
    const asUser = createEmptyDocumentModel({ document_id: 'd', paragraph_source: 'user_request' });
    expect(paragraphBlockAt(asUser, 0).source).toBe('user_request');
  });
});

describe('节点工厂', () => {
  it('run 的默认属性全部是"未指定"（不写元素）', () => {
    const properties = defaultRunProperties();
    expect(properties.bold).toBe(TOGGLE_UNSPECIFIED);
    expect(properties.size).toBe(UNSPECIFIED_VALUE);
    expect(properties.underline).toBe(UNSPECIFIED_VALUE);
  });

  it('source 必须显式给出且合法（R109）', () => {
    expect(() => runNode({ text: 'x', source: 'nope' as never })).toThrow(DocumentModelError);
    expect(runNode({ text: 'x', source: 'imported' }).source).toBe('imported');
  });

  it('breakType / grid_span / refresh_state 非法即拒', () => {
    expect(() => breakNode({ breakType: 'nope' as never, source: 'system' })).toThrow(
      DocumentModelError,
    );
    expect(() => fieldNode({ instruction: '', source: 'system' })).toThrow(DocumentModelError);
    expect(() => fieldNode({ instruction: 'PAGE', source: 'system', refresh_state: 'nope' as never })).toThrow(
      DocumentModelError,
    );
    expect(() => cellNode({ source: 'system', grid_span: 0 })).toThrow(DocumentModelError);
    expect(() => cellNode({ source: 'system', vertical_merge: 'nope' as never })).toThrow(
      DocumentModelError,
    );
  });

  it('域节点表达"写了指令 ≠ 已刷新"（R158）', () => {
    const model = createDocumentModel({
      document_id: 'doc-field',
      blocks: [
        paragraphNode({
          source: 'model_generated',
          inlines: [fieldNode({ instruction: 'PAGE', source: 'model_generated' })],
        }),
      ],
    });
    const inline = paragraphBlockAt(model, 0).inlines[0];
    expect(inline).toMatchObject({ kind: 'field', cached_result: null, refresh_state: 'unknown' });
    // 没有缓存值 ⇒ 投影为空，不凭空造出页码
    expect(paragraphPlainText(paragraphBlockAt(model, 0))).toBe('');
  });
});

describe('文本投影（只读，不参与导出）', () => {
  it('文档投影按块分行；表格用制表符分列', () => {
    const model = createDocumentModel({
      document_id: 'doc-text',
      blocks: [
        textParagraphNode({ text: '标题', source: 'user_request' }),
        tableNode({
          source: 'model_generated',
          rows: [
            rowNode({
              source: 'model_generated',
              cells: [
                cellNode({ source: 'model_generated', blocks: [textParagraphNode({ text: 'a', source: 'model_generated' })] }),
                cellNode({ source: 'model_generated', blocks: [textParagraphNode({ text: 'b', source: 'model_generated' })] }),
              ],
            }),
          ],
        }),
      ],
    });
    expect(documentPlainText(model)).toBe('标题\na\tb');
    expect(documentParagraphTexts(model)).toEqual(['标题', 'a', 'b']);
  });

  it('样本文档的段落投影保留软换行与空白', () => {
    const texts = documentParagraphTexts(sampleDocument());
    expect(texts[0]).toBe('第一段');
    expect(texts[2]).toContain('\n');
    expect(texts[2]?.startsWith('软换行前\n')).toBe(true);
    expect(texts[2]?.endsWith('  ')).toBe(true);
  });

  it('块计数含单元格内的块', () => {
    const model = sampleDocument();
    // 3 段 + 1 表 + 4 单元格各 1 段 = 8
    expect(countBlocks(model)).toBe(8);
  });
});

describe('withRevision / 深冻结 / 深拷贝', () => {
  it('withRevision 只换版本号', () => {
    const model = sampleDocument();
    const next = withRevision(model, 7);
    expect(next.revision).toBe(7);
    expect(model.revision).toBe(0);
    expect(next.blocks).toBe(model.blocks);
  });

  it('深冻结后原地改写会抛错（不可变性成为可执行断言）', () => {
    const frozen = deepFreezeDocument(createDocumentModel({ document_id: 'd', blocks: sampleBlocks() }));
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(() => {
      (frozen as { revision: number }).revision = 99;
    }).toThrow(TypeError);
  });

  it('深拷贝与原模型值相同但不是同一对象（Uint8Array 也被复制）', () => {
    const model = createDocumentModel({
      document_id: 'd',
      blocks: sampleBlocks(),
      opaque_parts: [
        { path: 'word/theme/theme1.xml', content_type: 'application/xml', bytes: new Uint8Array([1, 2, 3]) },
      ],
    });
    const copy = cloneDocument(model);
    expect(copy).toEqual(model);
    expect(copy).not.toBe(model);
    expect(copy.opaque_parts[0]?.bytes).not.toBe(model.opaque_parts[0]?.bytes);
    expect(copy.opaque_parts[0]?.bytes).toEqual(model.opaque_parts[0]?.bytes);
  });
});

describe('不可变列表原语：越界抛错而不夹紧（R136 的"不许前半段悄悄成功"）', () => {
  const list: readonly string[] = ['a', 'b', 'c'];

  it('insertAt / removeAt / replaceAt 返回新数组', () => {
    expect(insertAt(list, 1, 'x')).toEqual(['a', 'x', 'b', 'c']);
    expect(insertAt(list, 3, 'x')).toEqual(['a', 'b', 'c', 'x']);
    expect(removeAt(list, 0)).toEqual(['b', 'c']);
    expect(replaceAt(list, 2, 'z')).toEqual(['a', 'b', 'z']);
    expect(list).toEqual(['a', 'b', 'c']);
  });

  it('removeAt 允许删到空；insertAt 允许空表插入', () => {
    expect(removeAt(['a'], 0)).toEqual([]);
    expect(insertAt([], 0, 'a')).toEqual(['a']);
  });

  it('越界即抛', () => {
    expect(() => insertAt(list, 4, 'x')).toThrow(DocumentModelError);
    expect(() => removeAt(list, 3)).toThrow(DocumentModelError);
    expect(() => replaceAt(list, -1, 'x')).toThrow(DocumentModelError);
    expect(() => insertAt(list, 1.5, 'x')).toThrow(DocumentModelError);
  });

  it('moveWithin 的 to 是**移动后**的最终下标', () => {
    expect(moveWithin(list, 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveWithin(list, 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveWithin(list, 1, 1)).toBe(list);
    expect(() => moveWithin(list, 0, 3)).toThrow(DocumentModelError);
  });
});

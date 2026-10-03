/**
 * R101 稳定标识：**同输入 ⇒ 同 id**，且读—改—写往返不变。
 *
 * 这组用例要挡住的错误实现是"每次按当前顺序重新编号"：那样在第 1 段前插一段，
 * 后面所有段落的身份都会平移——范围定位、批注锚点、失败重试全部失准。
 * 因此这里的判据是**位置变了、身份不变**。
 */

import { describe, expect, it } from 'vitest';

import { createDocumentModel } from './document.js';
import { DocumentModelError } from './errors.js';
import {
  allocateNodeId,
  createNodeIdAllocator,
  formatNodePath,
  isNodeId,
  nodePath,
  nodePathSegment,
  parseNodeId,
  stableNodeId,
  withSegment,
} from './ids.js';
import { textParagraphNode } from './nodes.js';
import { applyStructureEdit } from './structure.js';
import type { DocumentModel } from './types.js';
import { validateDocument } from './validation.js';
import { collectNodeIds } from './walk.js';
import { documentParagraphTexts } from './text.js';
import { sampleBlocks } from './fixtures.js';

const BODY = nodePathSegment('body', 0);

describe('R101 确定性分配规则', () => {
  it('同一路径两次分配得到同一 id（纯函数，无隐藏计数器）', () => {
    const path = nodePath([BODY, nodePathSegment('paragraph', 3), nodePathSegment('run', 1)]);
    expect(stableNodeId(path)).toBe(stableNodeId(path));
    expect(stableNodeId(path)).toBe('n/body:0/paragraph:3/run:1');
  });

  it('不同路径得到不同 id', () => {
    const a = stableNodeId(nodePath([BODY, nodePathSegment('paragraph', 0)]));
    const b = stableNodeId(nodePath([BODY, nodePathSegment('paragraph', 1)]));
    const c = stableNodeId(nodePath([BODY, nodePathSegment('table', 0)]));
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('id 是规范形态，且可反解出路径与 occurrence', () => {
    const path = nodePath([BODY, nodePathSegment('table', 0), nodePathSegment('row', 2)]);
    const id = stableNodeId(path, 2);
    expect(isNodeId(id)).toBe(true);
    expect(formatNodePath(path)).toBe('body:0/table:0/row:2');
    expect(parseNodeId(id)?.occurrence).toBe(2);
    expect(parseNodeId(id)?.path).toEqual([
      { kind: 'body', index: 0 },
      { kind: 'table', index: 0 },
      { kind: 'row', index: 2 },
    ]);
  });

  it('非规范字符串不被当作 id（不猜、不放行）', () => {
    expect(isNodeId('p1')).toBe(false);
    expect(isNodeId('')).toBe(false);
    expect(isNodeId('n')).toBe(false);
    expect(isNodeId('n/body:0#')).toBe(false);
    expect(isNodeId('n/body:-1')).toBe(false);
    expect(isNodeId(42)).toBe(false);
    expect(parseNodeId('第3段')).toBeNull();
  });

  it('非法路径段即拒绝（kind 形态、索引为负）', () => {
    expect(() => nodePathSegment('bad kind', 0)).toThrow(DocumentModelError);
    expect(() => nodePathSegment('paragraph', -1)).toThrow(DocumentModelError);
    expect(() => nodePathSegment('paragraph', 1.5)).toThrow(DocumentModelError);
    expect(() => nodePath([])).toThrow(DocumentModelError);
  });

  it('分配器对已占路径追加 occurrence 后缀，仍然确定性', () => {
    const allocator = createNodeIdAllocator();
    const path = nodePath([BODY, nodePathSegment('paragraph', 0)]);
    expect(allocator.allocate(path)).toBe('n/body:0/paragraph:0');
    expect(allocator.allocate(path)).toBe('n/body:0/paragraph:0#1');
    expect(allocator.allocate(path)).toBe('n/body:0/paragraph:0#2');
    expect(allocator.has('n/body:0/paragraph:0#1')).toBe(true);
  });

  it('预留 id 撞号即抛（两份节点不得共享身份）', () => {
    const allocator = createNodeIdAllocator(['n/body:0/paragraph:0']);
    expect(() => {
      allocator.reserve('n/body:0/paragraph:0');
    }).toThrow(DocumentModelError);
    expect(allocator.allocate(nodePath([BODY, nodePathSegment('paragraph', 0)]))).toBe(
      'n/body:0/paragraph:0#1',
    );
  });

  it('allocateNodeId 不与既有 id 冲突，且同输入同结果', () => {
    const existing = ['n/body:0/paragraph:0', 'n/body:0/paragraph:0#1'];
    const path = nodePath([BODY, nodePathSegment('paragraph', 0)]);
    const first = allocateNodeId(existing, path);
    const second = allocateNodeId(existing, path);
    expect(first).toBe('n/body:0/paragraph:0#2');
    expect(second).toBe(first);
    expect(existing).not.toContain(first);
  });

  it('withSegment 逐段延伸路径', () => {
    const path = withSegment(withSegment(nodePath([BODY]), 'paragraph', 1), 'run', 0);
    expect(formatNodePath(path)).toBe('body:0/paragraph:1/run:0');
  });
});

describe('R101 构造与往返：id 不变', () => {
  it('同一份草稿两次构造 ⇒ 完全相同的 id 序列（顺序也相同）', () => {
    const first = createDocumentModel({ document_id: 'doc-a', blocks: sampleBlocks() });
    const second = createDocumentModel({ document_id: 'doc-a', blocks: sampleBlocks() });
    expect(collectNodeIds(first)).toEqual(collectNodeIds(second));
    expect(collectNodeIds(first).length).toBeGreaterThan(10);
  });

  it('构造出的 id 全部是规范形态且互不重复', () => {
    const model = createDocumentModel({ document_id: 'doc-a', blocks: sampleBlocks() });
    const ids = collectNodeIds(model);
    expect(ids.every((id) => isNodeId(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('JSON 往返后 id 逐字不变，且仍通过自检', () => {
    const model = createDocumentModel({ document_id: 'doc-a', blocks: sampleBlocks() });
    const revived = JSON.parse(JSON.stringify(model)) as DocumentModel;

    expect(collectNodeIds(revived)).toEqual(collectNodeIds(model));
    expect(documentParagraphTexts(revived)).toEqual(documentParagraphTexts(model));
    const report = validateDocument(revived);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('在中间插入一段后：**位置变了，身份不变**（既有 id 一个都没变）', () => {
    const before = createDocumentModel({ document_id: 'doc-a', blocks: sampleBlocks() });
    const beforeIds = collectNodeIds(before);
    const textsBefore = documentParagraphTexts(before);

    const outcome = applyStructureEdit(before, {
      kind: 'insert_block',
      container: { kind: 'body' },
      index: 1,
      block: textParagraphNode({ text: '插入段', source: 'user_request' }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }

    const afterIdsAll = collectNodeIds(outcome.model);
    const afterIds = new Set(afterIdsAll);
    for (const id of beforeIds) {
      expect(afterIds.has(id)).toBe(true);
    }
    // 新增的 id 只来自新段落本身（段落 + 它的 run），不是"旧节点被改名"造成的假增量
    const added = afterIdsAll.filter((id) => !beforeIds.includes(id));
    expect(added.length).toBe(2);
    expect(added[0]).toBe('n/body:0/paragraph:1#1');

    const textsAfter = documentParagraphTexts(outcome.model);
    expect(textsAfter.slice(0, 1)).toEqual(textsBefore.slice(0, 1));
    expect(textsAfter[1]).toBe('插入段');
    expect(textsAfter.slice(2)).toEqual(textsBefore.slice(1));
  });

  it('插入导致路径撞号时，**新**节点让号（旧节点不重编号）', () => {
    const before = createDocumentModel({
      document_id: 'doc-a',
      blocks: [
        textParagraphNode({ text: 'A', source: 'user_request' }),
        textParagraphNode({ text: 'B', source: 'user_request' }),
      ],
    });
    // 第 1 块（下标 1）现在的 id 就是新插入点要用的路径
    const shifted = before.blocks[1];
    expect(shifted?.id).toBe('n/body:0/paragraph:1');

    const outcome = applyStructureEdit(before, {
      kind: 'insert_block',
      container: { kind: 'body' },
      index: 1,
      block: textParagraphNode({ text: 'X', source: 'user_request' }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.model.blocks[1]?.id).toBe('n/body:0/paragraph:1#1');
    expect(outcome.model.blocks[2]?.id).toBe('n/body:0/paragraph:1');
  });
});

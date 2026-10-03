/**
 * 版本比较单测（WF-080）。
 *
 * 判据：**不只用整文件 hash**——能报出"哪一段的哪几个字变了"，格式变化单独分类。
 */

import { describe, expect, it } from 'vitest';

import { boldOn, document, paragraphOfRuns } from '../selection/testing.js';
import { compareDocuments, textDiff } from './compare.js';

describe('textDiff —— 文字变化定位', () => {
  it('替换一个字：给出变化段与前后子串', () => {
    expect(textDiff('ABCXYZ', 'ABQXYZ')).toEqual({ start: 2, end: 3, before: 'C', after: 'Q' });
  });

  it('整段新增（前为空）', () => {
    expect(textDiff('', '你好')).toEqual({ start: 0, end: 0, before: '', after: '你好' });
  });

  it('整段删除（后为空）', () => {
    expect(textDiff('你好', '')).toEqual({ start: 0, end: 2, before: '你好', after: '' });
  });

  it('未变 ⇒ null', () => {
    expect(textDiff('same', 'same')).toBeNull();
  });
});

describe('compareDocuments —— 文字与格式分开', () => {
  it('文字变化定位到哪一段的哪几个字', () => {
    const before = document([paragraphOfRuns('p1', [['r1', 'ABCXYZ']])]);
    const after = document([paragraphOfRuns('p1', [['r1', 'ABQXYZ']])]);
    const diff = compareDocuments(before, after);
    const paragraph = diff.paragraphs[0];
    expect(paragraph?.kind).toBe('modified');
    expect(paragraph?.text_diff).toEqual({ start: 2, end: 3, before: 'C', after: 'Q' });
    expect(diff.summary.text_changes).toBe(1);
  });

  it('文字相同、格式不同 ⇒ 单独报格式变化（hash 做不到）', () => {
    const before = document([paragraphOfRuns('p1', [['r1', 'hello']])]);
    const after = document([paragraphOfRuns('p1', [['r1', 'hello', boldOn()]])]);
    const diff = compareDocuments(before, after);
    const paragraph = diff.paragraphs[0];
    expect(paragraph?.kind).toBe('modified');
    expect(paragraph?.text_diff).toBeNull();
    expect(paragraph?.format_changes).toEqual([
      { scope: 'run', run_index: 0, property: 'bold', before: { state: 'unspecified' }, after: { state: 'on' } },
    ]);
    expect(diff.summary.text_changes).toBe(0);
    expect(diff.summary.format_changes).toBe(1);
  });

  it('新增 / 删除段落', () => {
    const before = document([paragraphOfRuns('p1', [['r1', 'A']]), paragraphOfRuns('p3', [['r3', '要删的']])]);
    const after = document([paragraphOfRuns('p1', [['r1', 'A']]), paragraphOfRuns('p2', [['r2', '新增的']])]);
    const diff = compareDocuments(before, after);
    const byId = new Map(diff.paragraphs.map((paragraph) => [paragraph.node_id, paragraph]));
    expect(byId.get('p1')?.kind).toBe('unchanged');
    expect(byId.get('p2')?.kind).toBe('inserted');
    expect(byId.get('p2')?.after_text).toBe('新增的');
    expect(byId.get('p3')?.kind).toBe('removed');
    expect(byId.get('p3')?.before_text).toBe('要删的');
    expect(diff.summary.inserted).toBe(1);
    expect(diff.summary.removed).toBe(1);
    expect(diff.summary.unchanged).toBe(1);
  });

  it('文档 id 取后一份', () => {
    const before = document([paragraphOfRuns('p1', [['r1', 'A']])], { document_id: 'v1' });
    const after = document([paragraphOfRuns('p1', [['r1', 'A']])], { document_id: 'v2' });
    expect(compareDocuments(before, after).document_id).toBe('v2');
  });
});

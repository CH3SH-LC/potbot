/**
 * 查找单测（WF-085 查找半边；R102/R112/R113）。
 *
 * 重点：**跨 run 命中**（词被拆在多个 run 里也要找到）与**不重叠**（替换要能按倒序落地）。
 */

import { describe, expect, it } from 'vitest';

import { findInInlines, findMatchesInText, findText } from './find.js';
import { document, paragraphOfRuns, ZWJ_FAMILY } from './testing.js';

describe('findMatchesInText —— 码位偏移', () => {
  it('基础命中与多次命中，偏移是码位', () => {
    expect(findMatchesInText('今天天气很好，天气不错', '天气')).toEqual([
      { start: 2, end: 4 },
      { start: 7, end: 9 },
    ]);
  });

  it('不重叠：`aa` 在 `aaaa` 里只命中两处', () => {
    expect(findMatchesInText('aaaa', 'aa')).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it('emoji 前的命中偏移按码位计', () => {
    const text = `${ZWJ_FAMILY}天气`;
    expect(findMatchesInText(text, '天气')).toEqual([{ start: 5, end: 7 }]);
  });

  it('默认区分大小写；可显式开启不区分', () => {
    expect(findMatchesInText('Cat cat', 'cat')).toEqual([{ start: 4, end: 7 }]);
    expect(findMatchesInText('Cat cat', 'cat', { caseSensitive: false })).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
  });

  it('整词匹配：ASCII 相邻字母会阻止命中，中文相邻不会', () => {
    expect(findMatchesInText('concatenate', 'cat', { wholeWord: true })).toEqual([]);
    expect(findMatchesInText('a cat b', 'cat', { wholeWord: true })).toEqual([{ start: 2, end: 5 }]);
    expect(findMatchesInText('今天天气很好', '天气', { wholeWord: true })).toEqual([{ start: 2, end: 4 }]);
  });

  it('空查询返回空数组（由上层判 invalid_query）', () => {
    expect(findMatchesInText('abc', '')).toEqual([]);
  });
});

describe('findInInlines —— 跨 run', () => {
  it('词被拆在 3 个 run 里也能命中', () => {
    const paragraph = paragraphOfRuns('p1', [
      ['r1', '他天'],
      ['r2', '气很'],
      ['r3', '好啊'],
    ]);
    expect(findInInlines(paragraph.inlines, '天气很好')).toEqual([{ start: 1, end: 5 }]);
  });
});

describe('findText —— 全文档', () => {
  const doc = document([
    paragraphOfRuns('p1', [['r1', '天气很好']]),
    paragraphOfRuns('p2', [['r2', '今天']]),
    paragraphOfRuns('p3', [['r3', '天气又变了']]),
  ]);

  it('命中多处，返回段落 id + 码位区间 + 命中原文本', () => {
    const found = findText(doc, '天气');
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value).toEqual([
      { paragraph_id: 'p1', start: 0, end: 2, text: '天气' },
      { paragraph_id: 'p3', start: 0, end: 2, text: '天气' },
    ]);
  });

  it('命中零项 → not_found，带查找词与命中数（R112）', () => {
    const found = findText(doc, '没有这个词');
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.code).toBe('not_found');
    expect(found.detail.expression).toBe('没有这个词');
    expect(found.detail.hitCount).toBe(0);
    expect(found.detail.needsClarification).toBe(true);
  });

  it('空查询 → invalid_query（"没查"与"查不到"是两回事）', () => {
    const found = findText(doc, '');
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.code).toBe('invalid_query');
  });

  it('表格单元格内的段落也参与查找', () => {
    const withTable = document([
      paragraphOfRuns('p1', [['r1', '甲']]),
      {
        kind: 'table',
        id: 't1',
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
            id: 'row1',
            source: 'imported',
            opaque: [],
            height: { state: 'unspecified' },
            header: false,
            cells: [
              {
                kind: 'cell',
                id: 'c1',
                source: 'imported',
                opaque: [],
                properties: {
                  verticalAlign: { state: 'unspecified' },
                  shading: { state: 'unspecified' },
                  borders: { state: 'unspecified' },
                  width: { state: 'unspecified' },
                },
                blocks: [paragraphOfRuns('p2', [['r2', '天气']])],
                grid_span: 1,
                vertical_merge: null,
              },
            ],
          },
        ],
      },
    ]);
    const found = findText(withTable, '天气');
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value).toEqual([{ paragraph_id: 'p2', start: 0, end: 2, text: '天气' }]);
  });
});

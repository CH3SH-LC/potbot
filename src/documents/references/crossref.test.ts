/**
 * 交叉引用单测（WF-075/076）。
 *
 * 判据：**不断链**——被引标题改文字后引用仍指向它；目标被删 ⇒ `not_found`，**不伪造**。
 */

import { describe, expect, it } from 'vitest';

import { document, paragraph, paragraphOfRuns, run, style } from '../selection/testing.js';
import { addBookmark } from './bookmarks.js';
import { createCrossReference, refreshCrossReference, resolveCrossReference } from './crossref.js';
import { emptyReferenceIndex } from './types.js';

const styles = { styles: [style('Heading1', 'Heading 1')] };

const base = document(
  [
    paragraph('h1', [run('r1', '第一章 总则')], { style_ref: 'Heading1' }),
    paragraphOfRuns('p1', [['r2', '见 第一章 的说明。']]),
  ],
  { styles },
);

function refToHeading() {
  const created = createCrossReference(base, emptyReferenceIndex(), {
    id: 'x1',
    range: { node_id: 'p1', start: 2, end: 5 },
    target: { kind: 'heading', node_id: 'h1', bookmark_id: null },
    show: 'text',
  });
  if (!created.ok) throw new Error('setup');
  const ref = created.value.cross_references[0];
  if (ref === undefined) throw new Error('setup');
  return { index: created.value, ref };
}

describe('交叉引用：不断链', () => {
  it('创建时目标必须存在；解析取目标当前文字', () => {
    const { index, ref } = refToHeading();
    const resolved = resolveCrossReference(base, index, ref);
    expect(resolved.ok && resolved.value).toBe('第一章 总则');
  });

  it('被引标题改了文字 ⇒ 引用跟着变（仍指向它，不是旧快照）', () => {
    const { index, ref } = refToHeading();
    const renamed = document(
      [
        paragraph('h1', [run('r1', '第二章 分则')], { style_ref: 'Heading1' }),
        paragraphOfRuns('p1', [['r2', '见 第一章 的说明。']]),
      ],
      { styles },
    );
    const resolved = resolveCrossReference(renamed, index, ref);
    expect(resolved.ok && resolved.value).toBe('第二章 分则');
  });

  it('目标被删 ⇒ not_found（不伪造旧文字）', () => {
    const { index, ref } = refToHeading();
    const deleted = document([paragraphOfRuns('p1', [['r2', '见 第一章 的说明。']])]);
    const resolved = resolveCrossReference(deleted, index, ref);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe('not_found');
  });

  it('标题序号型引用（show:number）', () => {
    const made = createCrossReference(base, emptyReferenceIndex(), {
      id: 'x2',
      range: { node_id: 'p1', start: 2, end: 5 },
      target: { kind: 'heading', node_id: 'h1', bookmark_id: null },
      show: 'number',
    });
    if (!made.ok) throw new Error('setup');
    const ref = made.value.cross_references[0];
    if (ref === undefined) throw new Error('setup');
    const resolved = resolveCrossReference(base, made.value, ref);
    expect(resolved.ok && resolved.value).toBe('1');
  });

  it('页码型引用 ⇒ precondition（无排版证据，R158）', () => {
    const made = createCrossReference(base, emptyReferenceIndex(), {
      id: 'x3',
      range: { node_id: 'p1', start: 2, end: 5 },
      target: { kind: 'heading', node_id: 'h1', bookmark_id: null },
      show: 'page',
    });
    if (!made.ok) throw new Error('setup');
    const ref = made.value.cross_references[0];
    if (ref === undefined) throw new Error('setup');
    const resolved = resolveCrossReference(base, made.value, ref);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe('precondition');
  });

  it('创建时目标不存在 ⇒ not_found', () => {
    const made = createCrossReference(base, emptyReferenceIndex(), {
      id: 'x4',
      range: { node_id: 'p1', start: 0, end: 1 },
      target: { kind: 'heading', node_id: 'ghost', bookmark_id: null },
      show: 'text',
    });
    expect(made.ok).toBe(false);
    if (!made.ok) expect(made.code).toBe('not_found');
  });
});

describe('交叉引用：书签目标', () => {
  it('书签型引用解析书签文字；书签被删 ⇒ not_found', () => {
    const withBookmark = addBookmark(emptyReferenceIndex(), {
      id: 'bm1',
      name: '标记',
      range: { node_id: 'h1', start: 0, end: 3 },
    });
    if (!withBookmark.ok) throw new Error('setup');
    const made = createCrossReference(base, withBookmark.value, {
      id: 'x5',
      range: { node_id: 'p1', start: 2, end: 5 },
      target: { kind: 'bookmark', node_id: null, bookmark_id: 'bm1' },
      show: 'text',
    });
    if (!made.ok) throw new Error('setup');
    const ref = made.value.cross_references[0];
    if (ref === undefined) throw new Error('setup');
    const resolved = resolveCrossReference(base, made.value, ref);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value).toBe('第一章');

    const withoutBookmark = { ...made.value, bookmarks: [] };
    expect(resolveCrossReference(base, withoutBookmark, ref).ok).toBe(false);
  });
});

describe('refreshCrossReference —— 缓存刷新如实标注', () => {
  it('成功解析 ⇒ refreshed 且写入 cached_text', () => {
    const { index, ref } = refToHeading();
    const refreshed = refreshCrossReference(base, index, ref);
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.value.ref.refresh_state).toBe('refreshed');
    expect(refreshed.value.ref.cached_text).toBe('第一章 总则');
  });

  it('目标被删 ⇒ 标 stale（不冒充解析成功）', () => {
    const { index, ref } = refToHeading();
    const deleted = document([paragraphOfRuns('p1', [['r2', '见 第一章 的说明。']])]);
    const refreshed = refreshCrossReference(deleted, index, ref);
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.value.ref.refresh_state).toBe('stale');
    expect(refreshed.value.ref.cached_text).toBeNull();
  });
});

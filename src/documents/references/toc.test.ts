/**
 * 目录单测（WF-074；R115/R158）。
 *
 * 判据：**只生成结构，不编造页码缓存**。条目里根本没有页码字段；
 * 想拿到页码必须交出排版证据，否则 `precondition` 拒绝。
 */

import { describe, expect, it } from 'vitest';

import { document, paragraph, run, style, unspecifiedParagraphProperties } from '../selection/testing.js';
import { applyPageNumbers, buildToc, flattenToc, headingLevelOf, tocCache, updateToc } from './toc.js';
import type { LayoutEvidence } from './types.js';

const styles = { styles: [style('Heading1', 'Heading 1'), style('Heading2', 'Heading 2')] };

const doc = document(
  [
    paragraph('h1', [run('r1', '第一章')], { style_ref: 'Heading1' }),
    paragraph('h2', [run('r2', '1.1 节')], { style_ref: 'Heading2' }),
    paragraph('h3', [run('r3', '第二章')], { style_ref: 'Heading1' }),
    paragraph('p', [run('r4', '正文段落')]),
  ],
  { styles },
);

describe('headingLevelOf —— 层级判定（R115，不按字体大小猜）', () => {
  it('标题样式算出层级', () => {
    const paragraphs = doc.blocks;
    const h1 = paragraphs[0];
    const h2 = paragraphs[1];
    if (h1?.kind !== 'paragraph' || h2?.kind !== 'paragraph') throw new Error('setup');
    expect(headingLevelOf(h1, doc.styles)).toBe(1);
    expect(headingLevelOf(h2, doc.styles)).toBe(2);
  });

  it('大纲级别优先于样式', () => {
    const withOutline = paragraph('o', [run('ro', '自定义')], {
      properties: unspecifiedParagraphProperties({ outlineLevel: { state: 'set', value: 2 } }),
    });
    expect(headingLevelOf(withOutline, doc.styles)).toBe(3);
  });

  it('正文段落返回 null', () => {
    const body = doc.blocks[3];
    if (body?.kind !== 'paragraph') throw new Error('setup');
    expect(headingLevelOf(body, doc.styles)).toBeNull();
  });
});

describe('buildToc —— 只生成结构（R158）', () => {
  it('按层级嵌套，条目不含页码', () => {
    const toc = buildToc(doc);
    expect(toc.ok).toBe(true);
    if (!toc.ok) return;
    expect(toc.value).toHaveLength(2);
    expect(toc.value[0]?.text).toBe('第一章');
    expect(toc.value[0]?.children).toHaveLength(1);
    expect(toc.value[0]?.children[0]?.text).toBe('1.1 节');
    expect(toc.value[1]?.text).toBe('第二章');
    // 条目里没有 page 字段——类型上就不给"凭空页码"的位置。
    expect('page' in (toc.value[0] as object)).toBe(false);
  });

  it('没有标题 ⇒ not_found', () => {
    const plain = document([paragraph('p', [run('r', '纯正文')])]);
    const toc = buildToc(plain);
    expect(toc.ok).toBe(false);
    if (!toc.ok) expect(toc.code).toBe('not_found');
  });
});

describe('页码必须来自排版证据（R158）', () => {
  const evidence: LayoutEvidence = {
    engine: 'Microsoft Word 16.0.20430',
    measured_at: '2026-10-03T00:00:00+08:00',
    page_of: { h1: 1, h2: 1, h3: 3 },
  };

  it('默认缓存未刷新、无页码', () => {
    const toc = buildToc(doc);
    if (!toc.ok) throw new Error('setup');
    const cache = tocCache(toc.value);
    expect(cache.refresh_state).toBe('unknown');
    expect(cache.page_numbers).toEqual({});
    expect(cache.evidence).toBeNull();
  });

  it('没有证据就填页码 ⇒ precondition 拒绝', () => {
    const toc = buildToc(doc);
    if (!toc.ok) throw new Error('setup');
    const cache = tocCache(toc.value);
    const filled = applyPageNumbers(cache, null);
    expect(filled.ok).toBe(false);
    if (!filled.ok) expect(filled.code).toBe('precondition');
  });

  it('有排版证据 ⇒ 填入页码并标 refreshed', () => {
    const toc = buildToc(doc);
    if (!toc.ok) throw new Error('setup');
    const filled = applyPageNumbers(tocCache(toc.value), evidence);
    expect(filled.ok).toBe(true);
    if (!filled.ok) return;
    expect(filled.value.refresh_state).toBe('refreshed');
    expect(filled.value.page_numbers['h3']).toBe(3);
    expect(filled.value.evidence?.engine).toBe('Microsoft Word 16.0.20430');
  });

  it('证据不完整（空引擎）⇒ 拒绝', () => {
    const toc = buildToc(doc);
    if (!toc.ok) throw new Error('setup');
    const bad = applyPageNumbers(tocCache(toc.value), { engine: '  ', measured_at: 'x', page_of: {} });
    expect(bad.ok).toBe(false);
  });
});

describe('updateToc —— 标题集合变化则旧页码作废', () => {
  const evidence: LayoutEvidence = {
    engine: 'engine',
    measured_at: '2026-10-03T00:00:00+08:00',
    page_of: { h1: 1, h2: 1, h3: 3 },
  };

  it('标题没变 ⇒ 保留页码', () => {
    const toc = buildToc(doc);
    if (!toc.ok) throw new Error('setup');
    const refreshed = applyPageNumbers(tocCache(toc.value), evidence);
    if (!refreshed.ok) throw new Error('setup');
    const updated = updateToc(doc, refreshed.value);
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.refresh_state).toBe('refreshed');
    expect(updated.value.page_numbers['h3']).toBe(3);
  });

  it('新增标题 ⇒ 页码清空、状态回 unknown（不续用旧数字）', () => {
    const toc = buildToc(doc);
    if (!toc.ok) throw new Error('setup');
    const refreshed = applyPageNumbers(tocCache(toc.value), evidence);
    if (!refreshed.ok) throw new Error('setup');

    const grown = document(
      [...doc.blocks, paragraph('h4', [run('r9', '第三章')], { style_ref: 'Heading1' })],
      { styles },
    );
    const updated = updateToc(grown, refreshed.value);
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.refresh_state).toBe('unknown');
    expect(updated.value.page_numbers).toEqual({});
  });
});

describe('flattenToc', () => {
  it('展平按文档顺序', () => {
    const toc = buildToc(doc);
    if (!toc.ok) throw new Error('setup');
    expect(flattenToc(toc.value).map((entry) => entry.text)).toEqual(['第一章', '1.1 节', '第二章']);
  });
});

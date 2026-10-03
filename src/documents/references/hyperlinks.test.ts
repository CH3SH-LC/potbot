/**
 * 超链接单测（WF-072/073；R161）。
 *
 * 判据：**外部目标不抓取**（R161）——创建外部超链接只记录；解析是同步纯函数，
 * 返回 URL 原文而不会去访问它；只有显式的 `externalRelationshipFor` 才产出关系记录，且 `TargetMode` 为 `External`。
 */

import { describe, expect, it } from 'vitest';

import { addBookmark } from './bookmarks.js';
import {
  createHyperlink,
  externalRelationshipFor,
  hyperlinkTargetMode,
  modifyHyperlink,
  removeHyperlink,
  resolveHyperlink,
} from './hyperlinks.js';
import { emptyReferenceIndex } from './types.js';

describe('外部超链接（R161：只记录，不抓取）', () => {
  it('创建外部链接：记录 URL，目标模式为 External', () => {
    const created = createHyperlink(emptyReferenceIndex(), {
      id: 'h1',
      range: { node_id: 'p1', start: 2, end: 4 },
      target: { kind: 'external', url: 'https://example.com/a', relationship_id: null },
      text: '官网',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const hyperlink = created.value.hyperlinks[0];
    expect(hyperlink?.target).toEqual({ kind: 'external', url: 'https://example.com/a', relationship_id: null });
    expect(hyperlink && hyperlinkTargetMode(hyperlink)).toBe('External');
  });

  it('解析外部链接是同步纯函数：返回 URL 原文，不做任何访问', () => {
    const created = createHyperlink(emptyReferenceIndex(), {
      id: 'h1',
      range: { node_id: 'p1', start: 2, end: 4 },
      target: { kind: 'external', url: 'https://example.com/a', relationship_id: null },
      text: '官网',
    });
    if (!created.ok) throw new Error('setup');
    const hyperlink = created.value.hyperlinks[0];
    if (hyperlink === undefined) throw new Error('setup');

    // 若这里发生了网络访问，测试会在无网/慢网环境表现为挂起或失败——它没有。
    const resolved = resolveHyperlink(created.value, hyperlink);
    expect(resolved.ok && resolved.value).toBe('https://example.com/a');
  });

  it('外部关系记录 TargetMode=External；内部链接不产生关系', () => {
    const external = createHyperlink(emptyReferenceIndex(), {
      id: 'h1',
      range: { node_id: 'p1', start: 2, end: 4 },
      target: { kind: 'external', url: 'https://example.com/a', relationship_id: null },
      text: '官网',
    });
    if (!external.ok) throw new Error('setup');
    const link = external.value.hyperlinks[0];
    if (link === undefined) throw new Error('setup');

    const record = externalRelationshipFor(link, 'rId9');
    expect(record).not.toBeNull();
    expect(record?.target_mode).toBe('External');
    expect(record?.target).toBe('https://example.com/a');
  });
});

describe('内部超链接（指向书签）', () => {
  it('书签不存在 ⇒ not_found（不留悬空引用）', () => {
    const created = createHyperlink(emptyReferenceIndex(), {
      id: 'h1',
      range: { node_id: 'p1', start: 2, end: 4 },
      target: { kind: 'internal', bookmark: '不存在' },
      text: '跳转',
    });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.code).toBe('not_found');
  });

  it('书签存在 ⇒ 目标模式 Internal，解析返回书签名', () => {
    const withBookmark = addBookmark(emptyReferenceIndex(), {
      id: 'bm1',
      name: '目标',
      range: { node_id: 'p2', start: 0, end: 2 },
    });
    if (!withBookmark.ok) throw new Error('setup');
    const created = createHyperlink(withBookmark.value, {
      id: 'h1',
      range: { node_id: 'p1', start: 2, end: 4 },
      target: { kind: 'internal', bookmark: '目标' },
      text: '跳转',
    });
    if (!created.ok) throw new Error('setup');
    const link = created.value.hyperlinks[0];
    if (link === undefined) throw new Error('setup');
    expect(hyperlinkTargetMode(link)).toBe('Internal');
    const resolved = resolveHyperlink(created.value, link);
    expect(resolved.ok && resolved.value).toBe('目标');
    expect(externalRelationshipFor(link, 'rId1')).toBeNull();
  });

  it('内部目标书签被删 ⇒ 解析 not_found', () => {
    const withBookmark = addBookmark(emptyReferenceIndex(), {
      id: 'bm1',
      name: '目标',
      range: { node_id: 'p2', start: 0, end: 2 },
    });
    if (!withBookmark.ok) throw new Error('setup');
    const created = createHyperlink(withBookmark.value, {
      id: 'h1',
      range: { node_id: 'p1', start: 2, end: 4 },
      target: { kind: 'internal', bookmark: '目标' },
      text: '跳转',
    });
    if (!created.ok) throw new Error('setup');
    const withoutBookmark = { ...created.value, bookmarks: [] };
    const link = withoutBookmark.hyperlinks[0];
    if (link === undefined) throw new Error('setup');
    expect(resolveHyperlink(withoutBookmark, link).ok).toBe(false);
  });
});

describe('修改 / 移除超链接', () => {
  function withExternal() {
    const created = createHyperlink(emptyReferenceIndex(), {
      id: 'h1',
      range: { node_id: 'p1', start: 2, end: 4 },
      target: { kind: 'external', url: 'https://a.example', relationship_id: null },
      text: 'A',
    });
    if (!created.ok) throw new Error('setup');
    return created.value;
  }

  it('修改目标与文字', () => {
    const modified = modifyHyperlink(withExternal(), 'h1', {
      target: { kind: 'external', url: 'https://b.example', relationship_id: null },
      text: 'B',
    });
    expect(modified.ok).toBe(true);
    if (!modified.ok) return;
    const link = modified.value.hyperlinks[0];
    expect(link?.text).toBe('B');
    expect(link?.target.kind === 'external' && link.target.url).toBe('https://b.example');
  });

  it('改到不存在的内部书签 ⇒ not_found', () => {
    const modified = modifyHyperlink(withExternal(), 'h1', {
      target: { kind: 'internal', bookmark: '没这个' },
    });
    expect(modified.ok).toBe(false);
  });

  it('移除后列表为空', () => {
    const removed = removeHyperlink(withExternal(), 'h1');
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.hyperlinks).toHaveLength(0);
  });
});

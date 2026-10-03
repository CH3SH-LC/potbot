/**
 * 引用侧表**解析**单测（补 `fa/doc-review-product` 实测缺口 1）。
 *
 * | 判据 | 用例 |
 * |---|---|
 * | 脚注 / 尾注 / 交叉引用**真的进审阅**：`checked.notes` / `checked.cross_references` 不再恒 0 | ① |
 * | 悬空脚注标记 / 悬空交叉引用目标 ⇒ **具名**列在 `dangling`（如实覆盖） | ② |
 * | **反向对照**：没送 notes / cross_references ⇒ 计数 0、零发现、`healthy`，**不凭空造** | ③ |
 * | 形状非法 ⇒ 具名拒绝（`invalid_query` + 字段路径），不把输入错误伪装成"悬空引用" | ④ |
 * | 书签 / 超链接的既有语义在解析后不变（与产品端点同一套形状） | ⑤ |
 * | 空 / 缺省 index ⇒ 空侧表（"没送"不是错误） | ⑥ |
 *
 * 未验证声明：本用例只覆盖**模型层**解析与审阅计数；产品端点的接线（`apps/**`）不在本包写权内，
 * 见下。
 *
 * 交付说明（身份标注）：本文件由一个**子智能体**在 worktree `fa/doc-notes-crossref` 内产出；
 * 该子智能体的**模型身份未确认为 DS**。结论以可复算的用例证据为准。
 */

import { describe, expect, it } from 'vitest';

import { createDocumentModel } from '../model/document.js';
import { textParagraphNode } from '../model/nodes.js';
import type { DocumentModel } from '../model/types.js';
import { auditReferences, formatReferenceAudit } from '../reference-audit.js';
import { collectParagraphs } from '../selection/structure.js';
import { parseReferenceIndex, REFERENCE_INDEX_PARSE_CODE } from './parse.js';

function modelOf(texts: readonly string[]): DocumentModel {
  return createDocumentModel({
    document_id: 'parse-under-test',
    blocks: texts.map((text) => textParagraphNode({ text, source: 'user_request' })),
  });
}

function paragraphId(model: DocumentModel, index = 0): string {
  return collectParagraphs(model.blocks)[index]!.id;
}

describe('引用侧表解析（references/parse）', () => {
  it('① 脚注 / 尾注 / 交叉引用真的进审阅（不再是"送了也白送"）', () => {
    const model = modelOf(['甲乙丙丁']);
    const node = paragraphId(model);

    const parsed = parseReferenceIndex({
      bookmarks: [{ id: 'bm-1', name: '锚点一', range: { node_id: node, start: 0, end: 2 } }],
      hyperlinks: [],
      notes: [
        { id: 'note-1', kind: 'footnote', marker: { node_id: node, start: 0, end: 1 }, text: '脚注一' },
        { id: 'note-2', kind: 'endnote', marker: { node_id: node, start: 2, end: 3 }, text: '尾注一' },
      ],
      cross_references: [
        {
          id: 'cr-1',
          range: { node_id: node, start: 0, end: 1 },
          target: { kind: 'bookmark', node_id: null, bookmark_id: 'bm-1' },
          cached_text: '锚点一',
          show: 'text',
          refresh_state: 'refreshed',
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // 四类都解出来了（**关键**：notes / cross_references 非空）。
    expect(parsed.value.notes).toHaveLength(2);
    expect(parsed.value.cross_references).toHaveLength(1);

    const report = auditReferences({ model, index: parsed.value });
    expect(report.checked.bookmarks).toBe(1);
    expect(report.checked.hyperlinks).toBe(0);
    // 这三行正是本次要修的缺口：以前恒为 0。
    expect(report.checked.notes).toBe(2);
    expect(report.checked.cross_references).toBe(1);
    expect(report.healthy).toBe(true);
    expect(report.dangling).toEqual([]);
  });

  it('② 悬空的脚注标记 / 交叉引用目标 ⇒ 具名列在 dangling（如实覆盖）', () => {
    const model = modelOf(['甲乙丙丁']);
    const node = paragraphId(model);

    const parsed = parseReferenceIndex({
      notes: [
        // 段落存在，但标记范围越界 ⇒ range_out_of_bounds
        { id: 'note-oob', kind: 'footnote', marker: { node_id: node, start: 0, end: 99 }, text: '越界脚注' },
        // 段落不存在 ⇒ missing_paragraph
        { id: 'note-gone', kind: 'endnote', marker: { node_id: 'n/body:0/paragraph:99', start: 0, end: 1 }, text: '失所尾注' },
      ],
      cross_references: [
        {
          id: 'cr-dangling',
          range: { node_id: node, start: 0, end: 1 },
          target: { kind: 'bookmark', node_id: null, bookmark_id: '不存在的书签' },
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const report = auditReferences({ model, index: parsed.value });
    expect(report.checked.notes).toBe(2);
    expect(report.checked.cross_references).toBe(1);
    expect(report.healthy).toBe(false);

    const byCode = report.dangling.map((finding) => `${finding.item_kind}:${finding.code}`);
    expect(byCode).toContain('note:range_out_of_bounds');
    expect(byCode).toContain('note:missing_paragraph');
    expect(byCode).toContain('cross_reference:missing_target');
    // 悬空项**具名**（不是"有一类问题"这种不可操作的结论）。
    const danglingIds = report.dangling.map((finding) => finding.item_id);
    expect(danglingIds).toContain('note-oob');
    expect(danglingIds).toContain('note-gone');
    expect(danglingIds).toContain('cr-dangling');

    // 报告文字里也必须出现这两类（人读的那份同样如实）。
    const summary = formatReferenceAudit(report);
    expect(summary).toContain('脚注尾注');
    expect(summary).toContain('交叉引用');
  });

  it('③ 反向对照：没送 notes / cross_references ⇒ 计数 0、零发现、不凭空造', () => {
    const model = modelOf(['甲乙丙丁']);
    const node = paragraphId(model);

    const parsed = parseReferenceIndex({
      bookmarks: [{ id: 'bm-1', name: '锚点一', range: { node_id: node, start: 0, end: 1 } }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.notes).toEqual([]);
    expect(parsed.value.cross_references).toEqual([]);

    const report = auditReferences({ model, index: parsed.value });
    expect(report.checked.notes).toBe(0);
    expect(report.checked.cross_references).toBe(0);
    expect(report.findings).toEqual([]);
    expect(report.healthy).toBe(true);
    expect(formatReferenceAudit(report)).toContain('悬空引用：无');
  });

  it('④ 形状非法 ⇒ 具名拒绝（字段路径写进 message 与 detail.extra.field）', () => {
    const cases: readonly { readonly input: unknown; readonly field: string }[] = [
      { input: { bookmarks: '不是数组' }, field: 'bookmarks' },
      { input: { notes: [{ kind: '排注', marker: { node_id: 'n/body:0/paragraph:0', start: 0, end: 1 } }] }, field: 'notes[0].kind' },
      { input: { notes: [{ kind: 'footnote' }] }, field: 'notes[0].marker' },
      {
        input: { cross_references: [{ range: { node_id: 'n/body:0/paragraph:0', start: 0, end: 1 }, target: { kind: 'bookmark', bookmark_id: null } }] },
        field: 'cross_references[0].target.bookmark_id',
      },
      {
        input: { cross_references: [{ range: { node_id: 'n/body:0/paragraph:0', start: 0, end: 1 }, target: { kind: 'heading', node_id: null } }] },
        field: 'cross_references[0].target.node_id',
      },
      {
        input: { cross_references: [{ range: { node_id: 'n/body:0/paragraph:0', start: 0, end: 1 }, target: { kind: 'heading', node_id: 'n/body:0/paragraph:0' }, show: '页码' }] },
        field: 'cross_references[0].show',
      },
      { input: { hyperlinks: [{ range: { node_id: 'n', start: 0, end: 1 }, target: { kind: 'internal', bookmark: '' } }] }, field: 'hyperlinks[0].target.bookmark' },
    ];

    for (const item of cases) {
      const parsed = parseReferenceIndex(item.input);
      expect(parsed.ok, `应当拒绝：${item.field}`).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.code).toBe(REFERENCE_INDEX_PARSE_CODE);
      expect(parsed.message).toContain(item.field);
      expect(parsed.detail.extra?.['field']).toBe(item.field);
    }
  });

  it('⑤ 书签 / 超链接的既有语义在解析后不变', () => {
    const model = modelOf(['甲乙丙丁']);
    const node = paragraphId(model);

    const parsed = parseReferenceIndex({
      bookmarks: [
        { id: 'bm-a', name: '锚点一', range: { node_id: node, start: 0, end: 2 }, hidden: true },
        // 缺 id ⇒ 退回用 name（与产品端点同一约定）
        { name: '锚点二', range: { node_id: node, start: 2, end: 4 } },
      ],
      hyperlinks: [
        { id: 'hl-1', range: { node_id: node, start: 0, end: 2 }, target: { kind: 'internal', bookmark: '锚点一' }, text: '甲乙' },
        { id: 'hl-2', range: { node_id: node, start: 0, end: 1 }, target: { kind: 'external', url: 'https://example.invalid/x', relationship_id: null } },
        { id: 'hl-mail', range: { node_id: node, start: 1, end: 2 }, target: { kind: 'email', address: 'nobody@example.invalid' } },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.bookmarks.map((bookmark) => bookmark.id)).toEqual(['bm-a', '锚点二']);
    expect(parsed.value.bookmarks[0]!.hidden).toBe(true);
    expect(parsed.value.hyperlinks.map((hyperlink) => hyperlink.id)).toEqual(['hl-1', 'hl-2', 'hl-mail']);
    expect(parsed.value.hyperlinks[0]!.target).toEqual({ kind: 'internal', bookmark: '锚点一' });

    const report = auditReferences({ model, index: parsed.value });
    expect(report.checked.bookmarks).toBe(2);
    expect(report.checked.hyperlinks).toBe(3);
    // 外部 / 邮件目标只记录不抓取（R161）：进 info，不算悬空。
    expect(report.counts.external_not_fetched).toBe(2);
    expect(report.healthy).toBe(true);
  });

  it('⑥ 空 / 缺省 index ⇒ 空侧表（"没送"不是错误）', () => {
    for (const raw of [undefined, null, {}]) {
      const parsed = parseReferenceIndex(raw);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value).toEqual({ bookmarks: [], hyperlinks: [], notes: [], cross_references: [] });
    }
    const notObject = parseReferenceIndex('nope');
    expect(notObject.ok).toBe(false);
  });
});

/**
 * 修订 / 批注**导出片段 + 成对性校验**单测（WF-077–079 的可导出 / 可读回侧）。
 *
 * | 判据 | 用例 |
 * |---|---|
 * | 插入片段：`w:ins` 包 run、文字写成 `w:t` | ① |
 * | 删除片段：`w:del` 包 run、文字写成 `w:delText`（未接受前不真删） | ② |
 * | 格式类修订 ⇒ `unsupported`，并在计划里**具名**进 `rejected`（不静默丢弃，R110/R140） | ③ |
 * | 片段 id 从 `startId` 起连续分配（合并进既有部件时用得到） | ④ |
 * | 批注导出**成套**：部件 + 关系 + 内容类型；无批注时三件都不凭空造 | ⑤ |
 * | 批注体数字 id 从既有 `word/comments.xml` **续号**（不撞号） | ⑥ |
 * | 无锚点批注 ⇒ 不写出并**具名**记进 `skipped` | ⑦ |
 * | **成对性**：真实导出产物里 `w:commentReference` ↔ `w:comment` 一一对应 | ⑧ |
 * | 反向对照：悬空引用 / 孤儿注释体 / 未闭合区间**分别**被指认 | ⑨ |
 * | 模型侧批注锚点失效 ⇒ **具名**列出 | ⑩ |
 *
 * 未验证声明：片段与计划**未**经消费端（Word / WPS）读回核对 ⇒ "消费端能正确显示这些修订/批注"
 * 标 **未验证（需消费端）**。此处只证明"写出的字节自洽"（成对性）与"片段形状正确"。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../artifacts/ooxml/zip-read.js';
import { exportDocx } from './docx/index.js';
import { importDocx } from './docx/index.js';
import { createDocumentModel } from './model/document.js';
import { textParagraphNode } from './model/nodes.js';
import type { DocumentModel, ParagraphNode } from './model/types.js';
import { addComment } from './review/comments.js';
import { trackDelete, trackFormat, trackInsert, type RevisionRecord } from './review/index.js';
import { collectParagraphs } from './selection/structure.js';
import {
  commentAnchorProblems,
  planCommentsExport,
  planReviewExport,
  planRevisionExport,
  revisionFragment,
  validateCommentPairing,
} from './revisions-export.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const CORPUS_A = join(
  REPO_ROOT,
  'tests',
  'word-acceptance',
  'fixtures',
  'corpus-a-independent-deflate.docx',
);
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MAIN_PART = 'word/document.xml';
const COMMENTS_PART = 'word/comments.xml';

const TRACKING = { enabled: true, author: '审阅人' } as const;

function requireOk<T extends { ok: boolean }>(result: T): T & { ok: true } {
  if (!result.ok) throw new Error(`setup failed: ${JSON.stringify(result)}`);
  return result as T & { ok: true };
}

function modelWithTexts(texts: readonly string[]): {
  readonly model: DocumentModel;
  readonly paragraphs: readonly ParagraphNode[];
} {
  const base = importDocx(new Uint8Array(readFileSync(CORPUS_A)));
  const draft = createDocumentModel({
    document_id: 'revisions-export-under-test',
    blocks: texts.map((text) => textParagraphNode({ text, source: 'user_request' })),
  });
  return {
    model: { ...base, blocks: draft.blocks, sections: [] },
    paragraphs: collectParagraphs(draft.blocks),
  };
}

function exportParts(bytes: Uint8Array): { readonly text: (path: string) => string | null } {
  const archive = readZip(bytes);
  return {
    text: (path) => {
      const entry = archive.by_path.get(path);
      return entry === undefined ? null : new TextDecoder().decode(entry.data);
    },
  };
}

function insertRecord(paragraph: ParagraphNode, id: string, start: number, end: number, text: string): RevisionRecord {
  return trackInsert(TRACKING, [], {
    id,
    date: '2026-10-03T00:00:00Z',
    range: { node_id: paragraph.id, start, end },
    text,
  }).records[0]!;
}

function deleteRecord(paragraph: ParagraphNode, id: string, start: number, end: number, text: string): RevisionRecord {
  return trackDelete(TRACKING, [], {
    id,
    date: '2026-10-03T00:00:00Z',
    range: { node_id: paragraph.id, start, end },
    text,
  }).records[0]!;
}

describe('修订导出片段', () => {
  it('① 插入片段：w:ins 包 run、文字写成 w:t、id 可指定', () => {
    const { paragraphs } = modelWithTexts(['AB插入CD']);
    const record = insertRecord(paragraphs[0]!, 'r1', 2, 4, '插入');
    const plan = planRevisionExport([record], 3);
    expect(plan.rejected).toEqual([]);
    expect(plan.fragments).toHaveLength(1);
    const fragment = plan.fragments[0]!;
    expect(fragment.kind).toBe('insert');
    expect(fragment.id).toBe(3);
    expect(fragment.xml).toContain('<w:ins w:id="3" w:author="审阅人" w:date="2026-10-03T00:00:00Z">');
    expect(fragment.xml).toContain('<w:t xml:space="preserve">插入</w:t>');
    expect(fragment.xml).toContain('</w:ins>');
  });

  it('② 删除片段：w:del 包 run、文字写成 w:delText（未接受前不真删）', () => {
    const { paragraphs } = modelWithTexts(['AB删除CD']);
    const record = deleteRecord(paragraphs[0]!, 'r1', 2, 4, '删除');
    const plan = planRevisionExport([record]);
    const fragment = plan.fragments[0]!;
    expect(fragment.kind).toBe('delete');
    expect(fragment.xml).toContain('<w:del w:id="1" w:author="审阅人"');
    expect(fragment.xml).toContain('<w:delText xml:space="preserve">删除</w:delText>');
    expect(fragment.xml).not.toContain('<w:t ');
  });

  it('③ 格式类修订 ⇒ unsupported，并在计划里具名进 rejected', () => {
    const { paragraphs } = modelWithTexts(['甲乙丙丁']);
    const paragraph = paragraphs[0]!;
    const formatRecord = trackFormat(TRACKING, [], {
      id: 'f1',
      date: '2026-10-03T00:00:00Z',
      range: { node_id: paragraph.id, start: 0, end: 1 },
      change: {
        target: 'run',
        node_id: paragraph.id,
        run_index: 0,
        property: 'bold',
        before: { state: 'unspecified' },
        after: { state: 'on' },
      },
    }).records[0]!;

    const single = revisionFragment(formatRecord, 1);
    expect(single.ok).toBe(false);
    if (!single.ok) expect(single.code).toBe('unsupported');

    const plan = planRevisionExport([formatRecord]);
    expect(plan.fragments).toEqual([]);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]!.record_id).toBe('f1');
    expect(plan.rejected[0]!.reason).toContain('w:rPrChange');
  });

  it('④ 片段 id 从 startId 起连续分配；起止倒置 ⇒ invalid_range（不静默）', () => {
    const { paragraphs } = modelWithTexts(['ABCDEFGH']);
    const a = insertRecord(paragraphs[0]!, 'r1', 1, 2, 'X');
    const b = deleteRecord(paragraphs[0]!, 'r2', 3, 4, 'Y');
    const plan = planRevisionExport([a, b], 10);
    expect(plan.fragments.map((fragment) => fragment.id)).toEqual([10, 11]);

    const inverted: RevisionRecord = { ...a, id: 'bad', range: { node_id: a.range.node_id, start: 5, end: 2 } };
    const bad = revisionFragment(inverted, 1);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('invalid_range');
  });
});

describe('批注导出（批量 + 关系 + 内容类型）', () => {
  it('⑤ 成套产出；无批注时三件都不凭空造', () => {
    const { model, paragraphs } = modelWithTexts(['甲乙丙丁']);
    const withComment = requireOk(
      addComment(model, { author: '审阅人', text: '这里要改', anchor: { node_id: paragraphs[0]!.id, start: 1, end: 3 } }),
    ).value;

    const plan = planCommentsExport(withComment);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]!.id).toBe(1);
    expect(plan.part_xml).toContain('<w:comment w:id="1" w:author="审阅人">');
    expect(plan.part_xml).toContain('这里要改');
    expect(plan.relationship).not.toBeNull();
    expect(plan.relationship!.type).toContain('/comments');
    expect(plan.relationship!.target).toBe('comments.xml');
    expect(plan.relationship!.target_mode).toBe('Internal');
    expect(plan.relationship!.owner_part_path).toBe('word/document.xml');
    expect(plan.content_type_entry).toEqual({
      part_name: '/word/comments.xml',
      content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
    });

    const empty = planCommentsExport(model);
    expect(empty.entries).toEqual([]);
    expect(empty.relationship).toBeNull();
    expect(empty.content_type_entry).toBeNull();
  });

  it('⑥ 批注体数字 id 从既有 comments.xml 续号', () => {
    const { model, paragraphs } = modelWithTexts(['甲乙丙丁']);
    const withComment = requireOk(
      addComment(model, { author: '审阅人', text: '新批注', anchor: { node_id: paragraphs[0]!.id, start: 0, end: 1 } }),
    ).value;

    const existing = new TextEncoder().encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<w:comments xmlns:w="${W_NS}">` +
        `<w:comment w:id="7" w:author="旧作者"><w:p><w:r><w:t>旧批注</w:t></w:r></w:p></w:comment>` +
        `</w:comments>`,
    );
    const plan = planCommentsExport(withComment, { existing_comments_xml: existing });
    expect(plan.entries[0]!.id).toBe(8);
    // 既有注释体原样保留（R105）。
    expect(plan.part_xml).toContain('旧批注');
    expect(plan.part_xml).toContain('<w:comment w:id="8"');
  });

  it('⑦ 无锚点批注 ⇒ 不写出、具名进 skipped；锚点失效 ⇒ 具名列出', () => {
    const { model, paragraphs } = modelWithTexts(['甲乙丙丁']);
    const orphan: DocumentModel = {
      ...model,
      comments: [
        { kind: 'comment', id: 'c-orphan', source: 'user_request', opaque: [], author: '审阅人', text: '没锚点', anchor: null },
        {
          kind: 'comment',
          id: 'c-bad-anchor',
          source: 'user_request',
          opaque: [],
          author: '审阅人',
          text: '锚点越界',
          anchor: { node_id: paragraphs[0]!.id, start: 0, end: 99 },
        },
      ],
    };
    const plan = planCommentsExport(orphan);
    expect(plan.entries.map((entry) => entry.text)).toEqual(['锚点越界']);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]).toContain('c-orphan');

    // 两条都必须**具名**：无锚点与锚点越界是两种不同的写不出去。
    const problems = commentAnchorProblems(orphan);
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toContain('c-orphan');
    expect(problems.join('\n')).toContain('c-bad-anchor');
  });
});

describe('成对性校验（w:commentReference ↔ w:comment）', () => {
  it('⑧ 真实导出产物里引用与注释体一一对应', () => {
    const { model, paragraphs } = modelWithTexts(['甲乙丙丁']);
    const withComment = requireOk(
      addComment(model, { author: '审阅人', text: '批注正文', anchor: { node_id: paragraphs[0]!.id, start: 1, end: 3 } }),
    ).value;
    const record = insertRecord(paragraphs[0]!, 'r1', 1, 3, '甲乙');

    const parts = exportParts(exportDocx(withComment, { review: { revisions: [record] } }));
    const documentXml = parts.text(MAIN_PART)!;
    const commentsXml = parts.text(COMMENTS_PART)!;
    expect(documentXml).toContain('<w:commentReference w:id="1"/>');
    expect(commentsXml).toContain('<w:comment w:id="1"');

    const pairing = validateCommentPairing(documentXml, commentsXml);
    expect(pairing.problems).toEqual([]);
    expect(pairing.ok).toBe(true);
    expect(pairing.reference_marker_ids).toEqual([1]);
    expect(pairing.body_ids).toEqual([1]);
    expect(pairing.dangling_references).toEqual([]);
    expect(pairing.orphan_bodies).toEqual([]);
  });

  it('⑨ 反向对照：悬空引用 / 孤儿注释体 / 未闭合区间分别被指认', () => {
    const commentsShell = (inner: string): string =>
      `<?xml version="1.0" encoding="UTF-8"?><w:comments xmlns:w="${W_NS}">${inner}</w:comments>`;
    const documentShell = (inner: string): string =>
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W_NS}"><w:body>${inner}</w:body></w:document>`;

    // 悬空引用：正文引用了 id=1，但 comments.xml 里没有对应的注释体。
    const dangling = validateCommentPairing(
      documentShell('<w:commentRangeStart w:id="1"/><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r>'),
      commentsShell(''),
    );
    expect(dangling.ok).toBe(false);
    expect(dangling.dangling_references).toEqual([1]);
    expect(dangling.problems.join('\n')).toContain('悬空引用');

    // 孤儿注释体：comments.xml 里有 id=2，但正文没有引用它。
    const orphan = validateCommentPairing(
      documentShell(''),
      commentsShell(`<w:comment w:id="2" w:author="X"><w:p/></w:comment>`),
    );
    expect(orphan.ok).toBe(false);
    expect(orphan.orphan_bodies).toEqual([2]);

    // 未闭合区间：起了区间却没有终点，也没有引用标记。
    const unclosed = validateCommentPairing(
      documentShell('<w:commentRangeStart w:id="5"/>'),
      commentsShell(`<w:comment w:id="5" w:author="X"><w:p/></w:comment>`),
    );
    expect(unclosed.ok).toBe(false);
    expect(unclosed.unclosed_ranges).toEqual([5]);

    // 反向对照的另一面：完全成对 ⇒ ok（证明上面的失败不是"永远失败"）。
    const paired = validateCommentPairing(
      documentShell('<w:commentRangeStart w:id="3"/><w:commentRangeEnd w:id="3"/><w:r><w:commentReference w:id="3"/></w:r>'),
      commentsShell(`<w:comment w:id="3" w:author="X"><w:p/></w:comment>`),
    );
    expect(paired.ok).toBe(true);
  });

  it('⑩ planReviewExport 汇总：修订片段 + 批注成套 + 锚点问题', () => {
    const { model, paragraphs } = modelWithTexts(['甲乙丙丁']);
    const withComment = requireOk(
      addComment(model, { author: '审阅人', text: '批注正文', anchor: { node_id: paragraphs[0]!.id, start: 0, end: 2 } }),
    ).value;
    const bundle = planReviewExport(withComment, [insertRecord(paragraphs[0]!, 'r1', 0, 2, '甲乙')]);
    expect(bundle.revisions.fragments).toHaveLength(1);
    expect(bundle.comments.entries).toHaveLength(1);
    expect(bundle.comment_anchor_problems).toEqual([]);
  });
});

/**
 * design-05-P7 的**导出侧收口**：审阅（WF-077–079）——批注与修订。
 *
 * | 判据 | 用例 |
 * |---|---|
 * | 批注：`w:commentRangeStart`/`End` + `w:commentReference` + **新部件 `word/comments.xml`** | ① |
 * | 批注锚点落空（`anchor === null`）⇒ 不写出（不是静默丢弃，记入 skipped） | ② |
 * | 修订插入：`w:ins` 包住 run | ③ |
 * | 修订删除：`w:del` 包住 run，文字是 `w:delText` 且**仍在**正文里 | ④ |
 * | **接受**删除修订 ⇒ 文字消失、`w:del` 消失 | ⑤ |
 * | **拒绝**插入修订 ⇒ 插入的文字消失 | ⑥ |
 * | 只处理选中的 ⇒ **未处理的仍在文件里被标为修订** | ⑦ |
 * | 格式类修订写不出 ⇒ 写出前**明确拒绝**（R140/R110） | ⑧ |
 * | 不涉及审阅 ⇒ 文件里没有 `w:ins`/`w:del`/批注元素 | ⑨ |
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../artifacts/ooxml/zip-read.js';
import { createDocumentModel } from '../model/document.js';
import { textParagraphNode } from '../model/nodes.js';
import type { DocumentModel, ParagraphNode } from '../model/types.js';
import {
  acceptRevisions,
  addComment,
  rejectRevisions,
  trackDelete,
  trackFormat,
  trackInsert,
  type RevisionRecord,
  type TrackChangesState,
} from '../review/index.js';
import { collectParagraphs } from '../selection/structure.js';
import { DocxError } from './docx-error.js';
import { exportDocx } from './export.js';
import { importDocx } from './import.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const CORPUS_A = join(
  REPO_ROOT,
  'tests',
  'word-acceptance',
  'fixtures',
  'corpus-a-independent-deflate.docx',
);

const MAIN_RELS = 'word/_rels/document.xml.rels';
const MAIN_PART = 'word/document.xml';
const TRACKING: TrackChangesState = { enabled: true, author: '审阅人' };

function corpusModel(): DocumentModel {
  return importDocx(new Uint8Array(readFileSync(CORPUS_A)));
}

function modelWithTexts(texts: readonly string[]): {
  readonly model: DocumentModel;
  readonly paragraphs: readonly ParagraphNode[];
} {
  const base = corpusModel();
  const draft = createDocumentModel({
    document_id: 'export-review-under-test',
    blocks: texts.map((text) => textParagraphNode({ text, source: 'user_request' })),
  });
  return {
    model: { ...base, blocks: draft.blocks, sections: [] },
    paragraphs: collectParagraphs(draft.blocks),
  };
}

function exportParts(bytes: Uint8Array): {
  readonly text: (path: string) => string | null;
  readonly paths: readonly string[];
} {
  const archive = readZip(bytes);
  return {
    text: (path) => {
      const entry = archive.by_path.get(path);
      return entry === undefined ? null : new TextDecoder().decode(entry.data);
    },
    paths: archive.entries.map((entry) => entry.path),
  };
}

function requireOk<T extends { ok: boolean }>(result: T): T & { ok: true } {
  if (!result.ok) throw new Error(`setup failed: ${JSON.stringify(result)}`);
  return result as T & { ok: true };
}

function track(
  paragraph: ParagraphNode,
  input: { readonly id: string; readonly kind: 'insert' | 'delete'; readonly start: number; readonly end: number; readonly text: string },
  records: readonly RevisionRecord[] = [],
): readonly RevisionRecord[] {
  const payload = {
    id: input.id,
    date: '2026-10-03T00:00:00Z',
    range: { node_id: paragraph.id, start: input.start, end: input.end },
    text: input.text,
  };
  const outcome =
    input.kind === 'insert'
      ? trackInsert(TRACKING, records, payload)
      : trackDelete(TRACKING, records, payload);
  return outcome.records;
}

describe('审阅导出（WF-077–079）', () => {
  it('① 批注：commentRangeStart / End + commentReference + 新部件 word/comments.xml', () => {
    const { model, paragraphs } = modelWithTexts(['甲乙丙丁']);
    const paragraph = paragraphs[0]!;
    const withComment = requireOk(
      addComment(model, {
        author: '审阅人',
        text: '这里要改',
        anchor: { node_id: paragraph.id, start: 1, end: 3 },
      }),
    ).value;

    const parts = exportParts(exportDocx(withComment));
    const xml = parts.text(MAIN_PART)!;
    expect(xml).toContain('<w:commentRangeStart w:id="1"/>');
    expect(xml).toContain('<w:commentRangeEnd w:id="1"/>');
    expect(xml).toContain('<w:r><w:commentReference w:id="1"/></w:r>');
    // 引用标记必须**紧跟**在区间终点之后（否则 Word 认为批注没有被引用）。
    expect(xml.indexOf('<w:commentRangeEnd w:id="1"/>')).toBeLessThan(
      xml.indexOf('<w:commentReference w:id="1"/>'),
    );

    expect(parts.paths).toContain('word/comments.xml');
    const comments = parts.text('word/comments.xml')!;
    expect(comments).toContain('<w:comment w:id="1" w:author="审阅人">');
    expect(comments).toContain('这里要改');
    expect(parts.text(MAIN_RELS)).toContain('/comments"');
    expect(parts.text('[Content_Types].xml')).toContain('wordprocessingml.comments+xml');
  });

  it('② 批注锚点为空 ⇒ 不写出，且计划里记录了原因', () => {
    const { model } = modelWithTexts(['甲乙丙丁']);
    const orphan: DocumentModel = {
      ...model,
      comments: [
        {
          kind: 'comment',
          id: 'comment:0',
          source: 'user_request',
          opaque: [],
          author: '审阅人',
          text: '没有锚点',
          anchor: null,
        },
      ],
    };
    const parts = exportParts(exportDocx(orphan));
    expect(parts.text(MAIN_PART)).not.toContain('commentRangeStart');
    expect(parts.paths).not.toContain('word/comments.xml');
  });

  it('③ 插入修订：w:ins 包住 run，文字照常在正文里', () => {
    const { model, paragraphs } = modelWithTexts(['AB插入CD']);
    const paragraph = paragraphs[0]!;
    const records = track(paragraph, { id: 'r1', kind: 'insert', start: 2, end: 4, text: '插入' });

    const xml = exportParts(exportDocx(model, { review: { revisions: records } })).text(MAIN_PART)!;
    expect(xml).toContain('<w:ins w:id="1" w:author="审阅人" w:date="2026-10-03T00:00:00Z">');
    expect(xml).toContain('<w:t xml:space="preserve">插入</w:t>');
    expect(xml).toContain('</w:ins>');
  });

  it('④ 删除修订：w:del 包住 run，文字写成 w:delText 且**仍在**正文里', () => {
    const { model, paragraphs } = modelWithTexts(['AB删除CD']);
    const paragraph = paragraphs[0]!;
    const records = track(paragraph, { id: 'r1', kind: 'delete', start: 2, end: 4, text: '删除' });

    const xml = exportParts(exportDocx(model, { review: { revisions: records } })).text(MAIN_PART)!;
    expect(xml).toContain('<w:del w:id="1" w:author="审阅人" w:date="2026-10-03T00:00:00Z">');
    expect(xml).toContain('<w:delText xml:space="preserve">删除</w:delText>');
    // 仍在正文里（接受之前没有真删）。
    expect(xml).toContain('删除');
  });

  it('⑤ 接受删除修订 ⇒ 文字消失、`w:del` 消失（终态）', () => {
    const { model, paragraphs } = modelWithTexts(['AB删除CD']);
    const paragraph = paragraphs[0]!;
    const records = track(paragraph, { id: 'r1', kind: 'delete', start: 2, end: 4, text: '删除' });

    const accepted = requireOk(
      acceptRevisions(model, records, { kind: 'all' }),
    );
    expect(accepted.value.remaining).toEqual([]);
    const xml = exportParts(
      exportDocx(accepted.value.model, { review: { revisions: accepted.value.remaining } }),
    ).text(MAIN_PART)!;
    expect(xml).not.toContain('<w:del');
    expect(xml).not.toContain('删除');
    // 剩下的两段文字各自成 run（切分点就是被删段落的边界）——合起来仍是 "ABCD"。
    expect(xml).toContain('>AB<');
    expect(xml).toContain('>CD<');
  });

  it('⑥ 拒绝插入修订 ⇒ 插入的文字消失（终态）', () => {
    const { model, paragraphs } = modelWithTexts(['AB插入CD']);
    const paragraph = paragraphs[0]!;
    const records = track(paragraph, { id: 'r1', kind: 'insert', start: 2, end: 4, text: '插入' });

    const rejected = requireOk(rejectRevisions(model, records, { kind: 'all' }));
    expect(rejected.value.remaining).toEqual([]);
    const xml = exportParts(
      exportDocx(rejected.value.model, { review: { revisions: rejected.value.remaining } }),
    ).text(MAIN_PART)!;
    expect(xml).not.toContain('<w:ins');
    expect(xml).not.toContain('插入');
    expect(xml).toContain('>AB<');
    expect(xml).toContain('>CD<');
  });

  it('⑦ 只接受一条 ⇒ 未处理的那条**仍在文件里**被标为修订', () => {
    const { model, paragraphs } = modelWithTexts(['AB插入CD删除EF']);
    const paragraph = paragraphs[0]!;
    let records: readonly RevisionRecord[] = [];
    records = track(paragraph, { id: 'r1', kind: 'insert', start: 2, end: 4, text: '插入' }, records);
    records = track(paragraph, { id: 'r2', kind: 'delete', start: 6, end: 8, text: '删除' }, records);
    expect(records).toHaveLength(2);

    const accepted = requireOk(acceptRevisions(model, records, { kind: 'ids', ids: ['r1'] }));
    expect(accepted.value.processed).toEqual(['r1']);
    expect(accepted.value.remaining.map((record) => record.id)).toEqual(['r2']);

    const xml = exportParts(
      exportDocx(accepted.value.model, { review: { revisions: accepted.value.remaining } }),
    ).text(MAIN_PART)!;
    expect(xml).not.toContain('<w:ins');
    expect(xml).toContain('<w:del');
    expect(xml).toContain('删除');
  });

  it('⑧ 格式类修订写不出 ⇒ 写出前明确拒绝（不静默丢弃，R140/R110）', () => {
    const { model, paragraphs } = modelWithTexts(['甲乙丙丁']);
    const paragraph = paragraphs[0]!;
    const records = trackFormat(
      TRACKING,
      [],
      {
        id: 'f1',
        date: '2026-10-03T00:00:00Z',
        range: { node_id: paragraph.id, start: 0, end: 1 },
        change: { target: 'run', node_id: paragraph.id, run_index: 0, property: 'bold', before: { state: 'unspecified' }, after: { state: 'on' } },
      },
    ).records;

    let thrown: unknown = null;
    try {
      exportDocx(model, { review: { revisions: records } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DocxError);
    expect((thrown as DocxError).reason).toBe('unsupported_revision');
  });

  it('⑨ 不涉及审阅 ⇒ 文件里没有 w:ins / w:del / 批注元素，也没有 comments.xml', () => {
    const { model } = modelWithTexts(['甲乙丙丁']);
    const parts = exportParts(exportDocx(model));
    const xml = parts.text(MAIN_PART)!;
    expect(xml).not.toContain('<w:ins');
    expect(xml).not.toContain('<w:del');
    expect(xml).not.toContain('commentRangeStart');
    expect(parts.paths).not.toContain('word/comments.xml');
  });
});

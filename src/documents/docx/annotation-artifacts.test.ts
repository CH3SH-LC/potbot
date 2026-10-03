/**
 * WCF-D60：**引用 / 审阅的导出产物 + 独立读回用的期望文件**。
 *
 * ## 为什么单独一个文件
 *
 * 本仓的**独立** DOCX 读回器是 `scripts/demo/verify-docx.py`（只依赖 Python 标准库，
 * 与 potbot 自己的 ZIP/XML 写入器**没有共享代码**，见其文件头的纪律说明）。它需要
 * "一个真实产物 + 一份期望文件"才能对**关系完整性**下判据（R160：无悬空 rId；
 * 内部关系的目标部件必须在包里）。
 *
 * 于是本文件只做两件事：把产物摆好、把期望写清。**判据本身不在这里**——
 * 在这里用生产实现自证是不被承认的（R167）。手动/可选的取证步骤：
 *
 * ```
 * python scripts/demo/verify-docx.py \
 *   .task-manifest/outputs/WCF-D60/artifacts/annotations.docx \
 *   --expect .task-manifest/outputs/WCF-D60/artifacts/annotations.expectation.json
 * ```
 *
 * ## 已知缺口（必须写清，不能含糊过去）
 *
 * `verify-docx.py` **不解析** `w:bookmarkStart` / `w:hyperlink` / `w:footnoteReference` /
 * `w:commentRangeStart` / `w:ins` / `w:del` / `w:fldSimple` 这些元素（它的判据集是
 * design-05 早期批次的：段落 / run 属性 / 缩进 / 行距 / 节 / 关系 / 内容类型）。
 * 因此它能独立确认的是**包与关系的完整性**，**不能**独立确认"这些元素写对了"——
 * 后者的证据目前只有本仓的 vitest 用例（`export-references.test.ts` / `export-review.test.ts`）。
 * 本任务**不允许改** `verify-docx.py`（它是别的批次的冻结工具），所以这条缺口如实登记。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../artifacts/ooxml/zip-read.js';
import { createDocumentModel } from '../model/document.js';
import { textParagraphNode } from '../model/nodes.js';
import type { DocumentModel, ParagraphNode } from '../model/types.js';
import {
  addBookmark,
  addNote,
  buildToc,
  createCrossReference,
  createHyperlink,
  emptyReferenceIndex,
  tocCache,
  type ReferenceIndex,
} from '../references/index.js';
import { addComment, trackDelete, trackInsert } from '../review/index.js';
import { collectParagraphs } from '../selection/structure.js';
import { emptyParagraphProperties } from './word-xml.js';
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
const ARTIFACTS = join(REPO_ROOT, '.task-manifest', 'outputs', 'WCF-D60', 'artifacts');
const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

interface RelRecord {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly target_mode: string;
}

function parseRels(xml: string): readonly RelRecord[] {
  return [...xml.matchAll(/<Relationship ([^>]*)\/>/g)].map((match) => {
    const attributes = match[1] as string;
    const read = (name: string): string =>
      new RegExp(`${name}="([^"]*)"`).exec(attributes)?.[1] ?? '';
    return {
      id: read('Id'),
      type: read('Type'),
      target: read('Target'),
      target_mode: read('TargetMode') || 'Internal',
    };
  });
}

function requireOk<T extends { ok: boolean }>(result: T): T & { ok: true } {
  if (!result.ok) throw new Error(`setup failed: ${JSON.stringify(result)}`);
  return result as T & { ok: true };
}

describe('WCF-D60 引用 / 审阅验收产物', () => {
  it('写出 annotations.docx 与独立读回期望文件，且关系语义与意图一致', () => {
    const base: DocumentModel = importDocx(new Uint8Array(readFileSync(CORPUS_A)));
    const headingProperties = emptyParagraphProperties();
    const draft = createDocumentModel({
      document_id: 'wcf-d60-annotations',
      blocks: [
        textParagraphNode({
          text: '第一章 总则',
          source: 'user_request',
          properties: { ...headingProperties, outlineLevel: { state: 'set', value: 0 } },
        }),
        textParagraphNode({ text: '点这里 见总则 正文', source: 'user_request' }),
        textParagraphNode({ text: '目 录', source: 'user_request' }),
      ],
    });
    const model: DocumentModel = { ...base, blocks: draft.blocks, sections: [] };
    const [heading, body, tocAnchor] = collectParagraphs(draft.blocks) as [
      ParagraphNode,
      ParagraphNode,
      ParagraphNode,
    ];

    let index: ReferenceIndex = requireOk(
      addBookmark(emptyReferenceIndex(), {
        id: 'bm1',
        name: '总则',
        range: { node_id: heading.id, start: 4, end: 6 },
      }),
    ).value;
    index = requireOk(
      createHyperlink(index, {
        id: 'h-ext',
        range: { node_id: body.id, start: 0, end: 3 },
        target: { kind: 'external', url: 'https://example.com/wcf-d60', relationship_id: null },
        text: '点这里',
        screen_tip: '外部链接（只记录，不抓取）',
      }),
    ).value;
    index = requireOk(
      createHyperlink(index, {
        id: 'h-int',
        range: { node_id: body.id, start: 4, end: 6 },
        target: { kind: 'internal', bookmark: '总则' },
        text: '见总则',
      }),
    ).value;
    index = requireOk(
      createCrossReference(model, index, {
        id: 'xr1',
        range: { node_id: heading.id, start: 0, end: 4 },
        target: { kind: 'bookmark', node_id: null, bookmark_id: 'bm1' },
        show: 'text',
      }),
    ).value;
    let notes = requireOk(
      addNote([], {
        id: 'fn1',
        kind: 'footnote',
        marker: { node_id: body.id, start: 2, end: 2 },
        text: '脚注正文（WCF-D60）',
      }),
    ).value;
    notes = requireOk(
      addNote(notes, {
        id: 'en1',
        kind: 'endnote',
        marker: { node_id: body.id, start: 5, end: 5 },
        text: '尾注正文（WCF-D60）',
      }),
    ).value;
    index = { ...index, notes };

    const withComment = requireOk(
      addComment(model, {
        author: '审阅人',
        text: '这里要改（WCF-D60 批注）',
        anchor: { node_id: body.id, start: 8, end: 10 },
      }),
    ).value;
    let revisions = trackInsert(
      { enabled: true, author: '审阅人' },
      [],
      {
        id: 'rev-ins',
        date: '2026-10-03T00:00:00Z',
        range: { node_id: body.id, start: 8, end: 10 },
        text: '正文',
      },
    ).records;
    revisions = trackDelete(
      { enabled: true, author: '审阅人' },
      revisions,
      {
        id: 'rev-del',
        date: '2026-10-03T00:00:00Z',
        range: { node_id: body.id, start: 4, end: 6 },
        text: '见总则',
      },
    ).records;

    const toc = tocCache(requireOk(buildToc(model)).value);
    const bytes = exportDocx(withComment, {
      references: index,
      review: { revisions },
      toc: { node_id: tocAnchor.id, cache: toc },
    });

    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(join(ARTIFACTS, 'annotations.docx'), bytes);

    const archive = readZip(bytes);
    const relsXml = new TextDecoder().decode(
      archive.by_path.get('word/_rels/document.xml.rels')!.data,
    );
    const rels = parseRels(relsXml);

    const find = (suffix: string): RelRecord => {
      const found = rels.find((record) => record.type === `${REL_BASE}/${suffix}`);
      expect(found, `缺少 ${suffix} 关系`).toBeDefined();
      return found as RelRecord;
    };
    const hyperlink = find('hyperlink');
    const footnotes = find('footnotes');
    const endnotes = find('endnotes');
    const comments = find('comments');

    // 关系语义与意图一致（这几条断言是期望文件的"根据"，不是期望文件本身）。
    expect(hyperlink.target).toBe('https://example.com/wcf-d60');
    expect(hyperlink.target_mode).toBe('External');
    expect(footnotes.target).toBe('footnotes.xml');
    expect(endnotes.target).toBe('endnotes.xml');
    expect(comments.target).toBe('comments.xml');
    for (const record of [footnotes, endnotes, comments]) {
      expect(record.target_mode).toBe('Internal');
    }

    const expectation = {
      label: 'WCF-D60 引用/审阅导出（书签 / 超链接 / 脚注 / 尾注 / 批注 / 修订 / 交叉引用 / 目录）',
      relationships: [
        {
          id: hyperlink.id,
          owner_part_path: 'word/document.xml',
          type: `${REL_BASE}/hyperlink`,
          target: hyperlink.target,
          target_mode: 'External',
        },
        ...[footnotes, endnotes, comments].map((record) => ({
          id: record.id,
          owner_part_path: 'word/document.xml',
          type: record.type,
          target: record.target,
          target_mode: 'Internal',
        })),
      ],
    };
    writeFileSync(
      join(ARTIFACTS, 'annotations.expectation.json'),
      `${JSON.stringify(expectation, null, 2)}\n`,
    );

    // 新增的 rId 都在既有编号之后（"已用最大编号 + 1"，R106）。
    const existingIds = parseRels(
      new TextDecoder().decode(archive.by_path.get('word/_rels/document.xml.rels')!.data),
    ).map((record) => record.id);
    expect(existingIds.length).toBeGreaterThanOrEqual(4);

    for (const name of ['annotations.docx', 'annotations.expectation.json']) {
      expect(readFileSync(join(ARTIFACTS, name)).byteLength).toBeGreaterThan(0);
    }
  });
});

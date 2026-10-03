/**
 * **导入批注**单测（补 `fa/doc-review-product` 实测缺口 2：`importDocx` 不解析 `comments.xml`）。
 *
 * | 判据 | 用例 |
 * |---|---|
 * | 带 `word/comments.xml` 的包 ⇒ 批注**进模型**（作者 / 文字 / 锚点） | ① |
 * | 锚点是**真位置的码位区间**（不是"随手一个点"）：`readComments` 读回被锚文字 | ② |
 * | **反向对照**：没有 `comments.xml` ⇒ `comments` 为空、不凭空造 | ③ |
 * | **成对性仍必须校验**：`validateCommentPairing` 对真实字节给出引用 ↔ 注释体的一一对应 | ④ |
 * | 未配对的一半**如实呈现**：只有引用没有体 ⇒ 具名 dangling；只有体没有引用 ⇒ 孤儿（`anchor:null`） | ⑤ |
 * | 真实语料（corpus-d / corpus-e）走同一条路径 | ⑥ |
 * | **R151 不回归**：导入带批注的文档再导出 ⇒ 每个部件**逐字节不变**（批注不二次写出） | ⑦ |
 * | 改过的导入批注 ⇒ 导出**具名拒绝**（R140/R110，不静默丢弃修改） | ⑧ |
 *
 * 未验证声明：**批注的消费端显示（Word / WPS）本批未验证**；本用例只覆盖字节、
 * 模型与配对校验。真实 Word 打开核对未做。
 *
 * 交付说明（身份标注）：本文件由一个**子智能体**在 worktree `fa/doc-notes-crossref` 内产出；
 * 该子智能体的**模型身份未确认为 DS**。结论以可复算的用例证据为准。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readZip } from '../../artifacts/ooxml/zip-read.js';
import { writeZip } from '../../artifacts/ooxml/zip.js';
import { readComments } from '../review/comments.js';
import { validateCommentPairing } from '../revisions-export.js';
import { DocxError } from './docx-error.js';
import { exportDocx } from './export.js';
import {
  COMMENTS_CONTENT_TYPE,
  COMMENTS_PART_PATH,
  COMMENTS_RELATIONSHIP_TYPE,
  DOCX_MAIN_CONTENT_TYPE,
  importDocx,
  importedCommentOriginOf,
} from './index.js';

// ---------------------------------------------------------------------------
// 手工拼一个**最小包**（STORE zip，`writeZip` 造 ⇒ `importDocx` 读）
// ---------------------------------------------------------------------------

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const DOCUMENT_PATH = 'word/document.xml';
const DOC_RELS_PATH = 'word/_rels/document.xml.rels';
const ROOT_RELS_PATH = '_rels/.rels';
const CONTENT_TYPES_PATH = '[Content_Types].xml';

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * 正文：`甲乙丙丁` 之后的 `戊己` 被 id=7 的批注区间**完整覆盖**。
 *
 * 偏移空间（码位）：`甲0 乙1 丙2 丁3 | 戊4 己5 |` ⇒ 区间应为 `[4, 6)`。
 */
const DOCUMENT_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>` +
  `<w:p><w:r><w:t>甲乙丙丁</w:t></w:r>` +
  `<w:commentRangeStart w:id="7"/><w:r><w:t>戊己</w:t></w:r><w:commentRangeEnd w:id="7"/>` +
  `<w:r><w:commentReference w:id="7"/></w:r></w:p>` +
  `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>` +
  `</w:body></w:document>`;

/** 只有引用、没有区间起止的正文（`w:commentReference` 单点引用）。 */
const DOCUMENT_XML_REFERENCE_ONLY =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>` +
  `<w:p><w:r><w:t>甲乙丙丁</w:t></w:r><w:r><w:commentReference w:id="7"/></w:r></w:p>` +
  `</w:body></w:document>`;

/** 引用了 id=5，但包里注释体只有 id=7（悬空引用）。 */
const DOCUMENT_XML_DANGLING_REFERENCE =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>` +
  `<w:p><w:r><w:t>甲乙丙丁</w:t></w:r><w:r><w:commentReference w:id="5"/></w:r></w:p>` +
  `</w:body></w:document>`;

function commentsXml(id: number, author: string, text: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:comments xmlns:w="${W}">` +
    `<w:comment w:id="${String(id)}" w:author="${author}" w:date="2026-10-03T00:00:00Z">` +
    `<w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:comment></w:comments>`
  );
}

const ROOT_RELS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<Relationships xmlns="${RELS}">` +
  `<Relationship Id="rId1" Type="${OFFICE}/officeDocument" Target="${DOCUMENT_PATH}"/>` +
  `</Relationships>`;

function documentRelsXml(withComments: boolean): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
    `<Relationships xmlns="${RELS}">` +
    (withComments
      ? `<Relationship Id="rIdComments" Type="${COMMENTS_RELATIONSHIP_TYPE}" Target="comments.xml"/>`
      : '') +
    `</Relationships>`
  );
}

function contentTypesXml(withComments: boolean): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
    `<Types xmlns="${CT}">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/${DOCUMENT_PATH}" ContentType="${DOCX_MAIN_CONTENT_TYPE}"/>` +
    (withComments ? `<Override PartName="/${COMMENTS_PART_PATH}" ContentType="${COMMENTS_CONTENT_TYPE}"/>` : '') +
    `</Types>`
  );
}

function buildPackage(options: {
  readonly documentXml?: string;
  readonly comments?: string | null;
}): Uint8Array {
  const comments = options.comments ?? null;
  const withComments = comments !== null;
  const entries = [
    { path: CONTENT_TYPES_PATH, data: utf8(contentTypesXml(withComments)) },
    { path: ROOT_RELS_PATH, data: utf8(ROOT_RELS_XML) },
    { path: DOCUMENT_PATH, data: utf8(options.documentXml ?? DOCUMENT_XML) },
    { path: DOC_RELS_PATH, data: utf8(documentRelsXml(withComments)) },
  ];
  if (comments !== null) entries.push({ path: COMMENTS_PART_PATH, data: utf8(comments) });
  return new Uint8Array(writeZip(entries));
}

// ---------------------------------------------------------------------------
// 真实语料
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const FIXTURES_DIR = join(REPO_ROOT, 'tests', 'word-acceptance', 'fixtures');
const CORPUS_A = join(FIXTURES_DIR, 'corpus-a-independent-deflate.docx');
const CORPUS_D = join(FIXTURES_DIR, 'corpus-d-reference-elements.docx');
const CORPUS_E = join(FIXTURES_DIR, 'corpus-e-annotation-export.docx');

function readFixture(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

function textOf(bytes: Uint8Array, path: string): string {
  const entry = readZip(bytes).by_path.get(path);
  if (entry === undefined) throw new Error(`包里没有 ${path}`);
  return new TextDecoder().decode(entry.data);
}

describe('导入批注（docx/import 的 comments.xml 解析）', () => {
  it('① 带 comments.xml 的包 ⇒ 批注进模型（作者 / 文字 / 锚点）', () => {
    const model = importDocx(buildPackage({ comments: commentsXml(7, '审阅人', '这两字要改') }));

    expect(model.comments).toHaveLength(1);
    const comment = model.comments[0]!;
    expect(comment.kind).toBe('comment');
    expect(comment.source).toBe('imported');
    expect(comment.author).toBe('审阅人');
    expect(comment.text).toBe('这两字要改');
    // id 走规范分配器（R101），不是裸数字。
    expect(comment.id).toBe('n/comment:0');
    // 原包里的 `w:id` 记在来源标记上（导出侧判定"这条已在包里"的依据）。
    expect(importedCommentOriginOf(comment)?.ooxml_id).toBe(7);
    expect(comment.anchor).not.toBeNull();
  });

  it('② 锚点是真位置的码位区间：`readComments` 读回被锚文字', () => {
    const model = importDocx(buildPackage({ comments: commentsXml(7, '审阅人', '这两字要改') }));
    const view = readComments(model)[0]!;
    expect(view.anchor_valid).toBe(true);
    expect(view.comment.anchor?.start).toBe(4);
    expect(view.comment.anchor?.end).toBe(6);
    // 段落偏移空间是 `甲乙丙丁戊己` ⇒ [4, 6) 正是被批注覆盖的 `戊己`。
    expect(view.anchored_text).toBe('戊己');
  });

  it('③ 反向对照：没有 comments.xml ⇒ `comments` 为空，不凭空造', () => {
    const model = importDocx(buildPackage({ comments: null }));
    expect(model.comments).toEqual([]);
    // 且导出时也不会"顺手"补一个空的 comments.xml 部件。
    const exported = readZip(exportDocx(model));
    expect(exported.by_path.has(COMMENTS_PART_PATH)).toBe(false);
  });

  it('④ 成对性仍必须校验：真实字节里引用标记与注释体一一对应', () => {
    const bytes = buildPackage({ comments: commentsXml(7, '审阅人', '这两字要改') });
    const report = validateCommentPairing(textOf(bytes, DOCUMENT_PATH), textOf(bytes, COMMENTS_PART_PATH));
    expect(report.ok).toBe(true);
    expect(report.reference_marker_ids).toEqual([7]);
    expect(report.range_start_ids).toEqual([7]);
    expect(report.range_end_ids).toEqual([7]);
    expect(report.body_ids).toEqual([7]);
    expect(report.dangling_references).toEqual([]);
    expect(report.orphan_bodies).toEqual([]);
    expect(report.unclosed_ranges).toEqual([]);
  });

  it('⑤ 未配对的一半如实呈现（悬空引用具名 / 孤儿注释体 anchor:null）', () => {
    // (a) 只有引用、没有注释体 ⇒ 配对校验具名报"悬空引用"，模型**不凭空造**批注。
    const danglingBytes = buildPackage({
      documentXml: DOCUMENT_XML_DANGLING_REFERENCE,
      comments: commentsXml(7, '审阅人', '这两字要改'),
    });
    const danglingReport = validateCommentPairing(
      textOf(danglingBytes, DOCUMENT_PATH),
      textOf(danglingBytes, COMMENTS_PART_PATH),
    );
    expect(danglingReport.ok).toBe(false);
    expect(danglingReport.dangling_references).toEqual([5]);

    const danglingModel = importDocx(danglingBytes);
    // 只有 id=7 的注释体进模型；id=5 的引用**没有**被伪造成一条批注。
    expect(danglingModel.comments).toHaveLength(1);
    expect(importedCommentOriginOf(danglingModel.comments[0]!)?.ooxml_id).toBe(7);

    // (b) 只有注释体、没有引用 ⇒ 孤儿注释体：如实给 `anchor: null`（不编一个位置）。
    const orphanBytes = buildPackage({
      documentXml: DOCUMENT_XML_REFERENCE_ONLY,
      comments: commentsXml(9, '审阅人', '没人引用我'),
    });
    const orphanModel = importDocx(orphanBytes);
    expect(orphanModel.comments).toHaveLength(1);
    expect(orphanModel.comments[0]!.anchor).toBeNull();
    expect(readComments(orphanModel)[0]!.anchor_valid).toBe(false);

    const orphanReport = validateCommentPairing(
      textOf(orphanBytes, DOCUMENT_PATH),
      textOf(orphanBytes, COMMENTS_PART_PATH),
    );
    expect(orphanReport.ok).toBe(false);
    expect(orphanReport.orphan_bodies).toEqual([9]);
    expect(orphanReport.dangling_references).toEqual([7]);
  });

  it('⑥ 真实语料走同一条路径：corpus-d / corpus-e 各解出 1 条批注，corpus-a 无批注', () => {
    const corpusD = importDocx(readFixture(CORPUS_D));
    expect(corpusD.comments).toHaveLength(1);
    expect(corpusD.comments[0]!.author).toBe('审阅人');
    expect(corpusD.comments[0]!.text).toBe('这里要改');
    expect(importedCommentOriginOf(corpusD.comments[0]!)?.ooxml_id).toBe(1);
    expect(corpusD.comments[0]!.anchor?.node_id).toBe('n/body:0/paragraph:7');

    const corpusE = importDocx(readFixture(CORPUS_E));
    expect(corpusE.comments).toHaveLength(1);
    expect(corpusE.comments[0]!.author).toBe('审阅人');
    expect(corpusE.comments[0]!.text).toBe('这里要改（WCF-D60 批注）');

    // 反向对照：corpus-a 根本没有 comments.xml。
    expect(importDocx(readFixture(CORPUS_A)).comments).toEqual([]);
  });

  it('⑦ R151 不回归：导入带批注的文档再导出 ⇒ 每个部件逐字节不变', () => {
    for (const [label, bytes] of [
      ['手工最小包', buildPackage({ comments: commentsXml(7, '审阅人', '这两字要改') })],
      ['corpus-d', readFixture(CORPUS_D)],
      ['corpus-e', readFixture(CORPUS_E)],
    ] as const) {
      const before = readZip(bytes);
      const after = readZip(exportDocx(importDocx(bytes as Uint8Array)));
      expect(after.entries.length, `${label}：部件数`).toBe(before.entries.length);
      for (const entry of before.entries) {
        const produced = after.by_path.get(entry.path);
        expect(produced, `${label}：导出后缺部件 ${entry.path}`).toBeDefined();
        expect(
          Buffer.from((produced as { data: Uint8Array }).data).equals(Buffer.from(entry.data)),
          `${label}：部件 ${entry.path} 应逐字节不变`,
        ).toBe(true);
      }
    }
  });

  it('⑧ 改过的导入批注 ⇒ 导出具名拒绝（不静默丢掉修改）', () => {
    const model = importDocx(buildPackage({ comments: commentsXml(7, '审阅人', '这两字要改') }));
    const edited = {
      ...model,
      comments: [{ ...model.comments[0]!, text: '改成了别的' }],
    };

    let thrown: unknown = null;
    try {
      exportDocx(edited);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DocxError);
    expect((thrown as DocxError).reason).toBe('unsupported_reference');
    expect((thrown as DocxError).message).toContain('导入批注');
  });
});

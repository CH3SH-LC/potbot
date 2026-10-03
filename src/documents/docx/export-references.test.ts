/**
 * design-05-P7 的**导出侧收口**：引用（WF-071–076）——书签 / 超链接 / 域 / 脚注 / 交叉引用 / 目录。
 *
 * | 判据 | 用例 |
 * |---|---|
 * | 书签写成 `w:bookmarkStart`/`w:bookmarkEnd`，`w:id` 配对、`w:name` 正确 | ① |
 * | 重命名 / 删除后**不产生悬空配对** | ②③ |
 * | 外部超链接走 `r:id` + `TargetMode="External"`，**URL 原样、不做任何取**（R161） | ④ |
 * | 内部超链接走 `w:anchor`，**不新增关系** | ⑤ |
 * | 新增关系的 **rId 追加在末尾**，既有 rId 编号与顺序逐条不变（R106） | ⑥ |
 * | 域：只写指令 + `w:dirty`（未刷新），**不编造页码**（R158） | ⑦ |
 * | 脚注：`w:footnoteReference` + **新部件 / 新关系 / 新内容类型**（R106） | ⑧ |
 * | 交叉引用：域形式、指向真实存在的书签、不断链 | ⑨ |
 * | 目录：`TOC` 域 + 条目结构、**无页码**、显式标未刷新（R158） | ⑩ |
 * | **无悬空引用**：正文里每个 `r:id` 都在 `.rels` 里，且内部目标部件在包里存在 | ⑪ |
 * | **R151 不回归**：不涉及这些能力时导出**逐字节不变** | ⑫ |
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../artifacts/ooxml/zip-read.js';
import { createDocumentModel } from '../model/document.js';
import { fieldNode, paragraphNode, runNode, textParagraphNode } from '../model/nodes.js';
import type { DocumentModel, ParagraphNode, ParagraphProperties } from '../model/types.js';
import {
  addBookmark,
  addNote,
  buildToc,
  createCrossReference,
  createHyperlink,
  emptyReferenceIndex,
  removeBookmark,
  renameBookmark,
  tocCache,
  type ReferenceIndex,
} from '../references/index.js';
import { addComment, trackInsert } from '../review/index.js';
import { collectParagraphs } from '../selection/structure.js';
import { maxNumericIdInPart, maxNumericIdInRawXml } from './reference-render.js';
import { W_NS, emptyParagraphProperties } from './word-xml.js';
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

function corpusModel(): DocumentModel {
  return importDocx(new Uint8Array(readFileSync(CORPUS_A)));
}

/** 用给定文字重建正文（保留语料的包级事实），并返回段落列表。 */
function modelWithTexts(
  texts: readonly string[],
  properties?: ParagraphProperties,
): { readonly model: DocumentModel; readonly paragraphs: readonly ParagraphNode[] } {
  const base = corpusModel();
  const draft = createDocumentModel({
    document_id: 'export-references-under-test',
    blocks: texts.map((text) =>
      textParagraphNode({ text, source: 'user_request', ...(properties === undefined ? {} : { properties }) }),
    ),
  });
  return {
    model: { ...base, blocks: draft.blocks, sections: [] },
    paragraphs: collectParagraphs(draft.blocks),
  };
}

interface ExportedPackage {
  readonly text: (path: string) => string | null;
  readonly paths: readonly string[];
}

function exportParts(bytes: Uint8Array): ExportedPackage {
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

/** 关系目标 → 包内部件路径（`../` 真的回退一层；测试侧的最小实现，不 import 生产实现）。 */
function resolveRelativeTo(ownerPartPath: string, target: string): string {
  if (target.startsWith('/')) return target.replace(/^\/+/, '');
  const base = ownerPartPath.slice(0, ownerPartPath.lastIndexOf('/') + 1);
  const segments: string[] = [];
  for (const segment of `${base}${target}`.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/** `.rels` 里的关系 id，按文件顺序。 */
function relationshipIds(relsXml: string | null): readonly string[] {
  if (relsXml === null) return [];
  return [...relsXml.matchAll(/Id="([^"]+)"/g)].map((match) => match[1] as string);
}

describe('引用导出（WF-071–076）', () => {
  it('① 书签写成 w:bookmarkStart / w:bookmarkEnd，id 配对且夹住目标文字', () => {
    const { model, paragraphs } = modelWithTexts(['第一章 总则']);
    const paragraph = paragraphs[0]!;
    const index = requireOk(
      addBookmark(emptyReferenceIndex(), {
        id: 'bm1',
        name: '总则',
        range: { node_id: paragraph.id, start: 4, end: 6 },
      }),
    ).value;

    const xml = exportParts(exportDocx(model, { references: index })).text(MAIN_PART)!;
    expect(xml).toContain('<w:bookmarkStart w:id="1" w:name="总则"/>');
    expect(xml).toContain('<w:bookmarkEnd w:id="1"/>');
    // 起点在目标文字**之前**、终点在**之后**（夹住 "总则"）。
    expect(xml.indexOf('<w:bookmarkStart w:id="1"')).toBeGreaterThan(xml.indexOf('>第一章 <'));
    expect(xml.indexOf('<w:bookmarkStart w:id="1"')).toBeLessThan(xml.indexOf('>总则<'));
    expect(xml.indexOf('>总则<')).toBeLessThan(xml.indexOf('<w:bookmarkEnd w:id="1"'));
  });

  it('② 重命名后仍是**一对**，且只剩新名字（不产生悬空配对）', () => {
    const { model, paragraphs } = modelWithTexts(['第一章 总则']);
    const paragraph = paragraphs[0]!;
    let index = requireOk(
      addBookmark(emptyReferenceIndex(), {
        id: 'bm1',
        name: '总则',
        range: { node_id: paragraph.id, start: 4, end: 6 },
      }),
    ).value;
    index = requireOk(renameBookmark(index, 'bm1', '通则')).value;

    const xml = exportParts(exportDocx(model, { references: index })).text(MAIN_PART)!;
    expect(xml).toContain('w:name="通则"');
    expect(xml).not.toContain('w:name="总则"');
    expect(xml.match(/<w:bookmarkStart/g)).toHaveLength(1);
    expect(xml.match(/<w:bookmarkEnd/g)).toHaveLength(1);
    expect(xml).toContain('<w:bookmarkEnd w:id="1"/>');
  });

  it('③ 删除书签后文件里不再出现 bookmarkStart / bookmarkEnd', () => {
    const { model, paragraphs } = modelWithTexts(['第一章 总则']);
    const paragraph = paragraphs[0]!;
    let index = requireOk(
      addBookmark(emptyReferenceIndex(), {
        id: 'bm1',
        name: '总则',
        range: { node_id: paragraph.id, start: 4, end: 6 },
      }),
    ).value;
    index = requireOk(removeBookmark(index, 'bm1')).value;

    const xml = exportParts(exportDocx(model, { references: index })).text(MAIN_PART)!;
    expect(xml).not.toContain('bookmarkStart');
    expect(xml).not.toContain('bookmarkEnd');
  });

  it('④ 外部超链接走 r:id + TargetMode="External"；URL 原样写出（R161：不做任何取）', () => {
    const { model, paragraphs } = modelWithTexts(['点这里']);
    const paragraph = paragraphs[0]!;
    // URL 里带 `&` 与 `?`：写进 `.rels` 时必须按 XML 规则转义，但**语义上原样**（不抓取、不改写）。
    const url = 'https://example.com/a?b=1&c=2';
    const index = requireOk(
      createHyperlink(emptyReferenceIndex(), {
        id: 'h1',
        range: { node_id: paragraph.id, start: 0, end: 1 },
        target: { kind: 'external', url, relationship_id: null },
        text: '点',
      }),
    ).value;

    const parts = exportParts(exportDocx(model, { references: index }));
    const xml = parts.text(MAIN_PART)!;
    const match = /<w:hyperlink r:id="(rId\d+)">/.exec(xml);
    expect(match).not.toBeNull();
    const rels = parts.text(MAIN_RELS)!;
    expect(rels).toContain(`Id="${match![1]}"`);
    expect(rels).toContain('Target="https://example.com/a?b=1&amp;c=2"');
    expect(rels).toContain('TargetMode="External"');
    // 写出 `r:id` 就必须有 `xmlns:r` 绑定——没有绑定 = 前缀未声明的非法 XML，真实 Word 直接拒开。
    expect(xml).toContain('xmlns:r=');
    // 显示文字被包在超链接里。
    expect(xml).toContain('<w:hyperlink r:id="' + match![1] + '"><w:r><w:t xml:space="preserve">点</w:t></w:r></w:hyperlink>');
  });

  it('⑤ 内部超链接走 w:anchor，**不新增任何关系**', () => {
    const { model, paragraphs } = modelWithTexts(['第一章 总则', '见总则']);
    const [heading, body] = paragraphs as [ParagraphNode, ParagraphNode];
    let index: ReferenceIndex = requireOk(
      addBookmark(emptyReferenceIndex(), {
        id: 'bm1',
        name: '总则',
        range: { node_id: heading.id, start: 4, end: 6 },
      }),
    ).value;
    index = requireOk(
      createHyperlink(index, {
        id: 'h1',
        range: { node_id: body.id, start: 1, end: 3 },
        target: { kind: 'internal', bookmark: '总则' },
        text: '总则',
      }),
    ).value;

    const parts = exportParts(exportDocx(model, { references: index }));
    const xml = parts.text(MAIN_PART)!;
    expect(xml).toContain('<w:hyperlink w:anchor="总则">');
    expect(xml).not.toContain('r:id=');
    // 关系表里没有新增 hyperlink 类型的关系。
    expect(parts.text(MAIN_RELS)).not.toContain('/hyperlink');
  });

  it('⑥ 新增关系追加在末尾：既有 rId 编号与顺序逐条不变（R106）', () => {
    const base = corpusModel();
    const before = exportParts(exportDocx(base)).text(MAIN_RELS);
    const beforeIds = relationshipIds(before);
    expect(beforeIds.length).toBeGreaterThan(0);

    const { model, paragraphs } = modelWithTexts(['甲', '乙']);
    const [first, second] = paragraphs as [ParagraphNode, ParagraphNode];
    let index = emptyReferenceIndex();
    index = requireOk(
      createHyperlink(index, {
        id: 'h1',
        range: { node_id: first.id, start: 0, end: 1 },
        target: { kind: 'external', url: 'https://one.example/', relationship_id: null },
        text: '甲',
      }),
    ).value;
    index = requireOk(
      createHyperlink(index, {
        id: 'h2',
        range: { node_id: second.id, start: 0, end: 1 },
        target: { kind: 'external', url: 'https://two.example/', relationship_id: null },
        text: '乙',
      }),
    ).value;

    const after = exportParts(exportDocx(model, { references: index })).text(MAIN_RELS)!;
    const afterIds = relationshipIds(after);
    // 既有 rId 前缀逐条相同。
    expect(afterIds.slice(0, beforeIds.length)).toEqual(beforeIds);
    // 新增两条，且都排在末尾。
    expect(afterIds).toHaveLength(beforeIds.length + 2);
  });

  it('⑦ 域：写指令 + w:dirty（未刷新），缓存为空 ⇒ 不编造任何页码（R158）', () => {
    const { model, paragraphs } = modelWithTexts(['第 页']);
    const paragraph = paragraphs[0]!;
    const draft = createDocumentModel({
      document_id: 'field-under-test',
      blocks: [
        paragraphNode({
          source: 'user_request',
          inlines: [
            runNode({ text: '第 ', source: 'user_request' }),
            fieldNode({ instruction: 'PAGE', source: 'user_request' }),
          ],
        }),
      ],
    });
    const withField: DocumentModel = { ...model, blocks: draft.blocks };

    const xml = exportParts(exportDocx(withField)).text(MAIN_PART)!;
    expect(xml).toContain('<w:instrText xml:space="preserve">PAGE</w:instrText>');
    expect(xml).toContain('<w:fldChar w:fldCharType="begin" w:dirty="true"/>');
    // 缓存为空：没有"算出来的"数字。
    expect(xml).toContain('<w:t xml:space="preserve"></w:t>');
  });

  it('⑧ 脚注：w:footnoteReference + 新部件 / 新关系 / 新内容类型（R106）', () => {
    const { model, paragraphs } = modelWithTexts(['正文注']);
    const paragraph = paragraphs[0]!;
    const notes = requireOk(
      addNote([], {
        id: 'fn1',
        kind: 'footnote',
        marker: { node_id: paragraph.id, start: 2, end: 2 },
        text: '这是脚注正文',
      }),
    ).value;
    const index: ReferenceIndex = { ...emptyReferenceIndex(), notes };

    const parts = exportParts(exportDocx(model, { references: index }));
    const xml = parts.text(MAIN_PART)!;
    expect(xml).toContain('<w:footnoteReference w:id="1"/>');
    // 新部件在包里。
    expect(parts.paths).toContain('word/footnotes.xml');
    const footnotes = parts.text('word/footnotes.xml')!;
    expect(footnotes).toContain('<w:footnote w:id="1">');
    expect(footnotes).toContain('这是脚注正文');
    // 关系 + 内容类型都已声明（无悬空引用）。
    expect(parts.text(MAIN_RELS)).toContain('/footnotes"');
    expect(parts.text('[Content_Types].xml')).toContain('wordprocessingml.footnotes+xml');
  });

  it('⑨ 交叉引用以域形式产出，且指向真实存在的书签（不断链）', () => {
    const { model, paragraphs } = modelWithTexts(['第一章 总则', '见此处']);
    const [heading, body] = paragraphs as [ParagraphNode, ParagraphNode];
    let index: ReferenceIndex = requireOk(
      addBookmark(emptyReferenceIndex(), {
        id: 'bm1',
        name: '总则',
        range: { node_id: heading.id, start: 4, end: 6 },
      }),
    ).value;
    index = requireOk(
      createCrossReference(model, index, {
        id: 'xr1',
        range: { node_id: body.id, start: 1, end: 3 },
        target: { kind: 'bookmark', node_id: null, bookmark_id: 'bm1' },
        show: 'text',
      }),
    ).value;

    const xml = exportParts(exportDocx(model, { references: index })).text(MAIN_PART)!;
    expect(xml).toContain('<w:fldSimple w:instr=" REF 总则 \\h " w:dirty="true"/>');
    // 域指向的书签确实在文件里。
    expect(xml).toContain('w:name="总则"');
  });

  it('⑨b 交叉引用目标是标题节点时，导出器在目标段落上补一个书签，域指向它', () => {
    const headingProperties = emptyParagraphProperties();
    const { model, paragraphs } = modelWithTexts(['第一章 总则', '见此处'], {
      ...headingProperties,
      outlineLevel: { state: 'set', value: 0 },
    });
    const [heading, body] = paragraphs as [ParagraphNode, ParagraphNode];
    const index = requireOk(
      createCrossReference(model, emptyReferenceIndex(), {
        id: 'xr1',
        range: { node_id: body.id, start: 1, end: 3 },
        target: { kind: 'heading', node_id: heading.id, bookmark_id: null },
        show: 'text',
      }),
    ).value;

    const xml = exportParts(exportDocx(model, { references: index })).text(MAIN_PART)!;
    const name = /w:name="(_Ref_[^"]+)"/.exec(xml);
    expect(name).not.toBeNull();
    expect(xml).toContain(`<w:fldSimple w:instr=" REF ${name![1]} \\h " w:dirty="true"/>`);
    // 补出来的书签夹住标题文字。
    expect(xml).toContain('<w:bookmarkStart w:id="1" w:name="' + name![1] + '"/>');
  });

  it('⑩ 目录：TOC 域 + 条目结构，**没有页码**、显式标未刷新（R158）', () => {
    const headingProperties = emptyParagraphProperties();
    const { model, paragraphs } = modelWithTexts(['第一章 总则', '正文', '第二章 分则'], {
      ...headingProperties,
      outlineLevel: { state: 'set', value: 0 },
    });
    const entries = requireOk(buildToc(model)).value;
    const toc = tocCache(entries);
    const anchor = paragraphs[0]!;

    const xml = exportParts(
      exportDocx(model, { toc: { node_id: anchor.id, cache: toc } }),
    ).text(MAIN_PART)!;

    expect(xml).toContain('TOC \\o "1-3" \\h \\z \\u');
    expect(xml).toContain('<w:fldChar w:fldCharType="begin" w:dirty="true"/>');
    expect(xml).toContain('第一章 总则');
    expect(xml).toContain('第二章 分则');
    // **没有页码**：条目段里没有 tab + 数字的样式，也没有任何 w:instrText 里带 PAGEREF。
    expect(xml).not.toContain('PAGEREF');
  });

  it('⑪ 无悬空引用：正文里每个 r:id 都在 .rels 里，且内部关系目标部件在包里', () => {
    const { model, paragraphs } = modelWithTexts(['点这里']);
    const paragraph = paragraphs[0]!;
    const index = requireOk(
      createHyperlink(emptyReferenceIndex(), {
        id: 'h1',
        range: { node_id: paragraph.id, start: 0, end: 1 },
        target: { kind: 'external', url: 'https://example.org/x', relationship_id: null },
        text: '点',
      }),
    ).value;
    const parts = exportParts(exportDocx(model, { references: index }));
    const xml = parts.text(MAIN_PART)!;
    const rels = parts.text(MAIN_RELS)!;

    const used = [...xml.matchAll(/r:id="([^"]+)"/g)].map((match) => match[1] as string);
    expect(used.length).toBeGreaterThan(0);
    for (const id of used) {
      expect(rels).toContain(`Id="${id}"`);
    }
    // 内部关系的目标部件确实在包里（目标相对于 `word/` 解析，`../` 要真的回退）。
    const partPaths = new Set(parts.paths);
    for (const match of rels.matchAll(/<Relationship [^>]*Target="([^"]+)"([^>]*)\/>/g)) {
      if ((match[2] ?? '').includes('TargetMode="External"')) continue;
      expect(partPaths.has(resolveRelativeTo('word/document.xml', match[1] as string))).toBe(true);
    }
  });

  it('⑫ R151 不回归：传空引用侧表 ⇒ 与不传 options **逐字节相同**', () => {
    const base = corpusModel();
    const plain = exportDocx(base);
    const withEmpty = exportDocx(base, { references: emptyReferenceIndex() });
    expect([...withEmpty]).toEqual([...plain]);
  });

  it('⑬ 失效书签不写出（不复活一个模型层已报告为失效的锚点）', () => {
    const { model, paragraphs } = modelWithTexts(['第一章 总则']);
    const paragraph = paragraphs[0]!;
    let index = requireOk(
      addBookmark(emptyReferenceIndex(), {
        id: 'bm1',
        name: '总则',
        range: { node_id: paragraph.id, start: 4, end: 6 },
      }),
    ).value;
    index = { ...index, bookmarks: index.bookmarks.map((bookmark) => ({ ...bookmark, intact: false })) };

    const xml = exportParts(exportDocx(model, { references: index })).text(MAIN_PART)!;
    expect(xml).not.toContain('bookmarkStart');
  });

  it('⑭ 目录落点段落不存在 ⇒ 写出前拒绝（R140）', () => {
    const headingProperties = emptyParagraphProperties();
    const { model } = modelWithTexts(['第一章'], {
      ...headingProperties,
      outlineLevel: { state: 'set', value: 0 },
    });
    const entries = requireOk(buildToc(model)).value;
    let thrown: unknown = null;
    try {
      exportDocx(model, { toc: { node_id: 'n/不存在', cache: tocCache(entries) } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DocxError);
    expect((thrown as DocxError).reason).toBe('unsupported_reference');
  });

  it('⑮ 既有未建模片段里的同类 id 会被避开（不写出两组同号标记）', () => {
    // 直接对扫描原语下断言：正文里已有 `w:bookmarkStart w:id="7"` ⇒ 下一个书签 id 必须 > 7。
    expect(maxNumericIdInRawXml(['<w:bookmarkStart w:id="7" w:name="旧"/>'], ['w:bookmarkStart'])).toBe(7);
    expect(maxNumericIdInRawXml(['<w:ins w:id="3"/>', '<w:del w:id="5"/>'], ['w:ins', 'w:del'])).toBe(5);
    expect(maxNumericIdInRawXml([], ['w:bookmarkStart'])).toBe(0);
    // 既有 `word/comments.xml` 里的 id 同样被避开。
    const comments = new TextEncoder().encode(
      `<w:comments xmlns:w="${W_NS}"><w:comment w:id="4" w:author="a"/><w:comment w:id="9" w:author="b"/></w:comments>`,
    );
    expect(maxNumericIdInPart(comments, ['comment'])).toBe(9);
    expect(maxNumericIdInPart(null, ['comment'])).toBe(0);
  });

  it('⑯ 全量集成：引用 + 审阅 + 目录同在一份文件里，逐个 r:id 有落点、逐个部件在包里', () => {
    const headingProperties = emptyParagraphProperties();
    const { model, paragraphs } = modelWithTexts(
      ['第一章 总则', '点这里 见总则 正文', '目录'],
      { ...headingProperties, outlineLevel: { state: 'set', value: 0 } },
    );
    const [heading, body] = paragraphs as [ParagraphNode, ParagraphNode, ParagraphNode];

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
        target: { kind: 'external', url: 'https://example.com/', relationship_id: null },
        text: '点这里',
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
        text: '脚注一',
      }),
    ).value;
    notes = requireOk(
      addNote(notes, {
        id: 'en1',
        kind: 'endnote',
        marker: { node_id: body.id, start: 5, end: 5 },
        text: '尾注一',
      }),
    ).value;
    index = { ...index, notes };

    const withComment = requireOk(
      addComment(model, {
        author: '审阅人',
        text: '这里要改',
        anchor: { node_id: body.id, start: 8, end: 10 },
      }),
    ).value;
    const revisions = trackInsert(
      { enabled: true, author: '审阅人' },
      [],
      {
        id: 'rev1',
        date: '2026-10-03T00:00:00Z',
        range: { node_id: body.id, start: 8, end: 10 },
        text: '正文',
      },
    ).records;

    const tocAnchor = paragraphs[2]!;
    const toc = tocCache(requireOk(buildToc(model)).value);
    const parts = exportParts(
      exportDocx(withComment, {
        references: index,
        review: { revisions },
        toc: { node_id: tocAnchor.id, cache: toc },
      }),
    );
    const xml = parts.text(MAIN_PART)!;
    const rels = parts.text(MAIN_RELS)!;

    // 八类元素都在。
    for (const needle of [
      '<w:bookmarkStart',
      '<w:bookmarkEnd',
      '<w:hyperlink r:id=',
      '<w:hyperlink w:anchor=',
      '<w:footnoteReference',
      '<w:endnoteReference',
      '<w:commentRangeStart',
      '<w:commentReference',
      '<w:ins',
      '<w:fldSimple w:instr=" REF 总则 \\h "',
      '<w:fldChar w:fldCharType="begin" w:dirty="true"/>',
    ]) {
      expect(xml, `缺少 ${needle}`).toContain(needle);
    }

    // 每个 r:id 都在 .rels 里有落点。
    const usedIds = [...xml.matchAll(/r:id="([^"]+)"/g)].map((match) => match[1] as string);
    expect(usedIds.length).toBeGreaterThan(0);
    for (const id of usedIds) expect(rels).toContain(`Id="${id}"`);

    // 每个**内部**关系的目标部件都在包里；内容类型表为三个新部件都给了声明。
    const partPaths = new Set(parts.paths);
    for (const match of rels.matchAll(/<Relationship [^>]*Target="([^"]+)"([^>]*)\/>/g)) {
      if ((match[2] ?? '').includes('TargetMode="External"')) continue;
      expect(partPaths.has(resolveRelativeTo('word/document.xml', match[1] as string))).toBe(true);
    }
    for (const path of ['word/footnotes.xml', 'word/endnotes.xml', 'word/comments.xml']) {
      expect(partPaths.has(path), `缺少部件 ${path}`).toBe(true);
    }
    const contentTypes = parts.text('[Content_Types].xml')!;
    expect(contentTypes).toContain('wordprocessingml.footnotes+xml');
    expect(contentTypes).toContain('wordprocessingml.endnotes+xml');
    expect(contentTypes).toContain('wordprocessingml.comments+xml');

    // 书签 id **成对**（每个 bookmarkStart 都有同号 bookmarkEnd）。
    const starts = [...xml.matchAll(/<w:bookmarkStart w:id="(\d+)"/g)].map((match) => match[1]);
    const ends = [...xml.matchAll(/<w:bookmarkEnd w:id="(\d+)"/g)].map((match) => match[1]);
    expect(starts.length).toBeGreaterThan(0);
    expect([...ends].sort()).toEqual([...starts].sort());

    // 数值 id 互不重复（书签 / 批注 / 脚注 / 修订各自一类）。
    expect(new Set(starts).size).toBe(starts.length);
    const commentStarts = [...xml.matchAll(/<w:commentRangeStart w:id="(\d+)"/g)].map((m) => m[1]);
    expect(commentStarts).toEqual([...new Set(commentStarts)]);
    expect([...xml.matchAll(/<w:ins w:id="(\d+)"/g)].map((m) => m[1])).toHaveLength(1);
  });
});

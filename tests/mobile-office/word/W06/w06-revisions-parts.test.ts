/**
 * W-I11 独立测试：**多部件读回修订**——页眉 / 页脚 + 脚注 / 尾注（WF-078 读入侧补口）。
 *
 * ## 为什么单列这个用例
 *
 * W06 的 reader（`review/read-revisions.ts`）先前只覆盖 `word/document.xml`。真实 Word 文件里的
 * 修订**同样会出现在页眉 / 页脚 / 脚注 / 尾注部件**里，而"打开一份带修订的 Word 文件逐条审阅"
 * 这条链路必须能看见它们。本用例对准本次增量的独立验收口径：
 * - **多部件读回**：从**真实 ZIP 字节**里的 `word/header1.xml`、`word/footer1.xml`、
 *   `word/footnotes.xml`、`word/endnotes.xml` 分别读出修订，各部件产出**自己的**
 *   `RevisionRecord[]`，其 `range` 是**该部件自己的 rendered_text 空间**里的**码位区间**；
 * - **反向对照**：无修订的部件产出**零记录**（零记录 ≠ 没读到）；
 * - **具名告警保留**：`w:moveFrom`/`w:moveTo`、`w:rPrChange`/`w:pPrChange`、嵌套 `w:ins`/`w:del`
 *   的告警仍在，且**带部件路径归属**。
 *
 * ## 身份 / 边界声明
 *
 * 本用例是 **DS worker W-I11（W 线，pool slot 11）** 在**主树**内产出（未建 worktree），
 * 只写本文件与 `src/documents/review/read-revisions.ts`。fixture 是真 `writeZip` 写出的
 * ZIP 字节、再由**独立** `readZip` 读回（不经过 reader 自己），所以"部件从字节来"不是自证。
 * 本片证明的是**字节 → 多部件记录**这条链的自洽，**不是** Word / WPS 如何显示这些修订 ——
 * 消费端读回 **未验证（本批无设备与授权）**。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/zip-read.js';
import { writeZip } from '../../../../src/artifacts/ooxml/zip.js';
import { acceptRevisions, rejectRevisions } from '../../../../src/documents/review/accept.js';
import {
  classifyRevisionPartPath,
  readRevisionsFromDocumentXml,
  readRevisionsFromParts,
  revisionPartByPath,
  type RevisionPartInput,
} from '../../../../src/documents/review/read-revisions.js';
import { collectParagraphs, paragraphText } from '../../../../src/documents/selection/structure.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const FIXTURES = join(REPO_ROOT, 'tests', 'word-acceptance', 'fixtures');

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function bytes(text: string): Uint8Array {
  return ENCODER.encode(text);
}

function partXml(rootLocalName: string, inner: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<${rootLocalName} xmlns:w="${W_NS}">${inner}</${rootLocalName}>`
  );
}

// 家族 emoji = 5 码位 / 8 UTF-16 码元：证明区间按码位。
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';

const HEADER1_XML = partXml(
  'w:hdr',
  `<w:p>` +
    `<w:r><w:t>页眉</w:t></w:r>` +
    `<w:ins w:id="11" w:author="页眉审阅" w:date="2026-10-03T02:00:00Z"><w:r><w:t>插入页眉</w:t></w:r></w:ins>` +
    `<w:r><w:t>尾</w:t></w:r>` +
    `</w:p>` +
    `<w:p>` +
    `<w:del w:id="12" w:author="页眉审阅" w:date="2026-10-03T02:01:00Z"><w:r><w:delText>删页眉</w:delText></w:r></w:del>` +
    `</w:p>`,
);

const HEADER2_XML = partXml(
  'w:hdr',
  `<w:p>` +
    `<w:r><w:t>AB</w:t></w:r>` +
    `<w:ins w:id="13" w:author="页眉审阅" w:date="2026-10-03T02:02:00Z"><w:r><w:t>${FAMILY}</w:t></w:r></w:ins>` +
    `<w:r><w:t>CD</w:t></w:r>` +
    `</w:p>`,
);

// 反向对照：这部分一个修订都没有。
const FOOTER1_XML = partXml('w:ftr', `<w:p><w:r><w:t>页脚无修订</w:t></w:r></w:p>`);

const FOOTNOTES_XML = partXml(
  'w:footnotes',
  `<w:footnote w:id="-1" w:type="separator"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>` +
    `<w:footnote w:id="1">` +
    `<w:p>` +
    `<w:r><w:t>注</w:t></w:r>` +
    `<w:ins w:id="21" w:author="脚注审阅" w:date="2026-10-03T03:00:00Z"><w:r><w:t>新增注</w:t></w:r></w:ins>` +
    `</w:p>` +
    `<w:p>` +
    `<w:del w:id="22" w:author="脚注审阅" w:date="2026-10-03T03:01:00Z"><w:r><w:delText>旧注</w:delText></w:r></w:del>` +
    `</w:p>` +
    `</w:footnote>`,
);

const ENDNOTES_XML = partXml(
  'w:endnotes',
  `<w:endnote w:id="-1" w:type="separator"><w:p><w:r><w:separator/></w:r></w:p></w:endnote>` +
    `<w:endnote w:id="1">` +
    `<w:p>` +
    `<w:del w:id="31" w:author="尾注审阅" w:date="2026-10-03T04:00:00Z"><w:r><w:delText>旧尾</w:delText></w:r></w:del>` +
    `</w:p>` +
    `</w:endnote>`,
);

const DOCUMENT_XML = partXml(
  'w:document',
  `<w:body><w:p><w:r><w:t>正文无修订</w:t></w:r></w:p></w:body>`,
);

/**
 * 真 `writeZip` 写出一个 DOCX 骨架（含正文 + 页眉 + 页脚 + 脚注 + 尾注），再用**独立**
 * `readZip` 读回，按路径解出部件文本。fixture 的字节来源与 reader 无关。
 */
function readFixtureParts(): readonly RevisionPartInput[] {
  const archive = writeZip([
    { path: 'word/document.xml', data: bytes(DOCUMENT_XML) },
    { path: 'word/header1.xml', data: bytes(HEADER1_XML) },
    { path: 'word/header2.xml', data: bytes(HEADER2_XML) },
    { path: 'word/footer1.xml', data: bytes(FOOTER1_XML) },
    { path: 'word/footnotes.xml', data: bytes(FOOTNOTES_XML) },
    { path: 'word/endnotes.xml', data: bytes(ENDNOTES_XML) },
  ]);
  const zipped = readZip(new Uint8Array(archive));
  const decode = (path: string): string => {
    const entry = zipped.by_path.get(path);
    if (entry === undefined) throw new Error(`fixture 缺少部件：${path}`);
    return DECODER.decode(entry.data);
  };
  return [
    { path: 'word/document.xml', xml: decode('word/document.xml') },
    { path: 'word/header1.xml', xml: decode('word/header1.xml') },
    { path: 'word/header2.xml', xml: decode('word/header2.xml') },
    { path: 'word/footer1.xml', xml: decode('word/footer1.xml') },
    { path: 'word/footnotes.xml', xml: decode('word/footnotes.xml') },
    { path: 'word/endnotes.xml', xml: decode('word/endnotes.xml') },
  ];
}

function documentXmlOf(path: string): string {
  const archive = readZip(new Uint8Array(readFileSync(path)));
  const entry = archive.by_path.get('word/document.xml');
  if (entry === undefined) throw new Error(`fixture 缺少 word/document.xml：${path}`);
  return DECODER.decode(entry.data);
}

function requireOk<T extends { ok: boolean }>(result: T): T & { ok: true } {
  if (!result.ok) throw new Error(`under-test failed: ${JSON.stringify(result)}`);
  return result as T & { ok: true };
}

/** 独立重算：在**该部件物化模型**里，按记录的 range 切片，应等于记录文字。 */
function sliceByRecord(part: ReturnType<typeof readRevisionsFromParts>['parts'][number], index: number): string {
  const record = part.records[index]!;
  const paragraph = collectParagraphs(part.model.blocks).find(
    (candidate) => candidate.id === record.range.node_id,
  );
  if (paragraph === undefined) throw new Error(`记录 ${record.id} 的 node_id 不在模型里`);
  return paragraphText(paragraph).slice(record.range.start, record.range.end);
}

// ---------------------------------------------------------------------------

describe('多部件读取：页眉 / 页脚 + 脚注 / 尾注（真实 ZIP 字节）', () => {
  it('① header1：插入 + 删除各一条，类别 / id / 作者 / 文字 / 码位区间正确', () => {
    const result = readRevisionsFromParts(readFixtureParts());
    const header = revisionPartByPath(result, 'word/header1.xml');
    expect(header).toBeDefined();
    expect(header!.kind).toBe('header');
    expect(header!.ordinal).toBe(1);
    expect(header!.records).toHaveLength(2);

    const [ins, del] = header!.records;
    expect(ins?.kind).toBe('insert');
    expect(ins?.author).toBe('页眉审阅');
    expect(ins?.date).toBe('2026-10-03T02:00:00Z');
    expect(ins?.text).toBe('插入页眉');
    expect({ start: ins?.range.start, end: ins?.range.end }).toEqual({ start: 2, end: 6 });

    expect(del?.kind).toBe('delete');
    expect(del?.text).toBe('删页眉');
    expect({ start: del?.range.start, end: del?.range.end }).toEqual({ start: 0, end: 3 });

    // rendered 空间独立核对。
    expect(header!.parsed.paragraphs[0]!.rendered_text).toBe('页眉插入页眉尾');
    expect(header!.parsed.paragraphs[1]!.rendered_text).toBe('删页眉');
  });

  it('② 每部件记录的 range 在其自身模型上精确切出该记录文字（码位口径）', () => {
    const result = readRevisionsFromParts(readFixtureParts());
    const header = revisionPartByPath(result, 'word/header1.xml')!;
    expect(header.records.map((_, index) => sliceByRecord(header, index))).toEqual([
      '插入页眉',
      '删页眉',
    ]);
    // header1 的 node_id 必来自 header1 自己的段落 id（部件独立物化）。
    for (const record of header.records) {
      expect(header.paragraph_ids).toContain(record.range.node_id);
    }
  });

  it('③ header2：emoji 插入按码位计区间（家族 emoji = 5 码位，不是 8 码元）', () => {
    const result = readRevisionsFromParts(readFixtureParts());
    const header2 = revisionPartByPath(result, 'word/header2.xml')!;
    expect(header2.ordinal).toBe(2);
    expect(header2.records).toHaveLength(1);
    const record = header2.records[0]!;
    expect(record.kind).toBe('insert');
    expect(record.text).toBe(FAMILY);
    // 起点 = "AB" 2 码位；终点 = 2 + 5 码位（不是 10 码元）。
    expect({ start: record.range.start, end: record.range.end }).toEqual({ start: 2, end: 7 });
    expect(header2.parsed.paragraphs[0]!.rendered_text).toBe(`AB${FAMILY}CD`);
  });

  it('④ footnotes / endnotes：脚注与尾注里的修订各归各部件', () => {
    const result = readRevisionsFromParts(readFixtureParts());

    const footnotes = revisionPartByPath(result, 'word/footnotes.xml')!;
    expect(footnotes.kind).toBe('footnotes');
    expect(footnotes.records).toHaveLength(2);
    // 顺序：脚注 1 的 ins 在前，del 在后（separator 段无文字、不产记录）。
    const [ins, del] = footnotes.records;
    expect(ins?.kind).toBe('insert');
    expect(ins?.author).toBe('脚注审阅');
    expect(ins?.text).toBe('新增注');
    expect(del?.kind).toBe('delete');
    expect(del?.text).toBe('旧注');
    expect(footnotes.parsed.paragraphs[1]!.rendered_text).toBe('注新增注');

    const endnotes = revisionPartByPath(result, 'word/endnotes.xml')!;
    expect(endnotes.kind).toBe('endnotes');
    expect(endnotes.records).toHaveLength(1);
    expect(endnotes.records[0]!.kind).toBe('delete');
    expect(endnotes.records[0]!.text).toBe('旧尾');
    expect(endnotes.records[0]!.author).toBe('尾注审阅');

    // 汇总：6 条记录（document 0 + header1 2 + header2 1 + footer1 0 + footnotes 2 + endnotes 1）。
    expect(result.total_records).toBe(6);
  });

  it('⑤ 反向对照：无修订的部件（footer1 / document）零记录，且被如实登记', () => {
    const result = readRevisionsFromParts(readFixtureParts());
    const footer = revisionPartByPath(result, 'word/footer1.xml')!;
    expect(footer.kind).toBe('footer');
    expect(footer.records).toEqual([]);
    expect(footer.parsed.warnings).toEqual([]);

    const document = revisionPartByPath(result, 'word/document.xml')!;
    expect(document.kind).toBe('document');
    expect(document.records).toEqual([]);

    expect(result.files_with_revisions).toEqual([
      'word/header1.xml',
      'word/header2.xml',
      'word/footnotes.xml',
      'word/endnotes.xml',
    ]);
    expect(result.files_without_revisions).toEqual(['word/document.xml', 'word/footer1.xml']);
    expect(result.files_with_warnings).toEqual([]);
  });

  it('⑥ records_by_path 与 parts 一致；part_index 按输入顺序', () => {
    const result = readRevisionsFromParts(readFixtureParts());
    expect(result.records_by_path.get('word/header1.xml')).toBe(
      revisionPartByPath(result, 'word/header1.xml')!.records,
    );
    expect(result.parts.map((part) => part.part_index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.parts.map((part) => part.path)).toEqual([
      'word/document.xml',
      'word/header1.xml',
      'word/header2.xml',
      'word/footer1.xml',
      'word/footnotes.xml',
      'word/endnotes.xml',
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('具名告警保留，且带部件路径归属', () => {
  const HEADER_WARN_XML = partXml(
    'w:hdr',
    `<w:p>` +
      `<w:r><w:t>甲</w:t></w:r>` +
      `<w:moveFrom w:id="3"><w:r><w:delText>移</w:delText></w:r></w:moveFrom>` +
      `<w:moveTo w:id="4"><w:r><w:t>移</w:t></w:r></w:moveTo>` +
      `<w:ins w:id="5"><w:r><w:rPr><w:rPrChange w:id="6" w:author="a"><w:rPr/></w:rPrChange></w:rPr><w:t>新</w:t></w:r></w:ins>` +
      `<w:del w:id="7"><w:ins w:id="8"><w:r><w:t>嵌套</w:t></w:r></w:ins></w:del>` +
      `<w:delText>野</w:delText>` +
      `</w:p>`,
  );

  it('⑦ header 的移动 / 格式 / 嵌套 / del 外 delText 告警逐条带 path', () => {
    const result = readRevisionsFromParts([
      { path: 'word/header1.xml', xml: HEADER_WARN_XML },
      { path: 'word/footer1.xml', xml: FOOTER1_XML },
    ]);
    const headerWarnings = result.warnings.filter((warning) => warning.path === 'word/header1.xml');
    const joined = headerWarnings.map((warning) => warning.message).join('\n');
    expect(joined).toContain('移动修订');
    expect(joined).toContain('格式修订');
    expect(joined).toContain('嵌套');
    expect(joined).toContain('w:delText 出现在 w:del 之外');

    // 无修订部件不背锅：footer 上没有归属告警。
    expect(result.warnings.some((warning) => warning.path === 'word/footer1.xml')).toBe(false);
    expect(result.files_with_warnings).toEqual(['word/header1.xml']);

    // 文字不静默丢：告警归告警，文字照收。
    const header = revisionPartByPath(result, 'word/header1.xml')!;
    expect(header.parsed.paragraphs[0]!.rendered_text).toBe('甲移移新嵌套野');
  });
});

// ---------------------------------------------------------------------------

describe('真实语料：多部件入口与单部件入口同源（不因换入口改语义）', () => {
  const CORPUS_A = join(FIXTURES, 'corpus-a-independent-deflate.docx');
  const CORPUS_D = join(FIXTURES, 'corpus-d-reference-elements.docx');

  it('⑧ corpus-a 真实字节：正文部件零记录、零告警、kind=document（反向对照）', () => {
    const xml = documentXmlOf(CORPUS_A);
    const result = readRevisionsFromParts([{ path: 'word/document.xml', xml }]);
    expect(result.total_records).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.parts[0]!.kind).toBe('document');
    expect(result.files_without_revisions).toEqual(['word/document.xml']);
  });

  it('⑨ corpus-d 真实字节：多部件入口读出与单部件入口相同的两条记录', () => {
    const xml = documentXmlOf(CORPUS_D);
    const viaParts = readRevisionsFromParts([{ path: 'word/document.xml', xml }]);
    const viaDocument = readRevisionsFromDocumentXml(xml);

    expect(viaParts.parts[0]!.parsed.records).toEqual(viaDocument.records);
    expect(viaParts.parts[0]!.parsed.warnings).toEqual(viaDocument.warnings);
    expect(viaParts.total_records).toBe(2);
    expect(viaParts.parts[0]!.records.map((record) => record.text)).toEqual(['新增', '删除']);
  });
});

// ---------------------------------------------------------------------------

describe('归类 / 边界：路径归类、重复路径、未知路径', () => {
  it('⑩ classifyRevisionPartPath 认得正文 / 页眉 / 页脚 / 脚注 / 尾注，不认得其他', () => {
    expect(classifyRevisionPartPath('word/document.xml')).toEqual({ kind: 'document', ordinal: null });
    expect(classifyRevisionPartPath('word/header1.xml')).toEqual({ kind: 'header', ordinal: 1 });
    expect(classifyRevisionPartPath('word/header12.xml')).toEqual({ kind: 'header', ordinal: 12 });
    expect(classifyRevisionPartPath('word/header_3.xml')).toEqual({ kind: 'header', ordinal: 3 });
    expect(classifyRevisionPartPath('word/footer2.xml')).toEqual({ kind: 'footer', ordinal: 2 });
    expect(classifyRevisionPartPath('word/footnotes.xml')).toEqual({ kind: 'footnotes', ordinal: null });
    expect(classifyRevisionPartPath('word/endnotes.xml')).toEqual({ kind: 'endnotes', ordinal: null });
    expect(classifyRevisionPartPath('word/styles.xml')).toBeNull();
    expect(classifyRevisionPartPath('docProps/app.xml')).toBeNull();
    expect(classifyRevisionPartPath('word/header1.xml/Fragment')).toBeNull();
  });

  it('⑪ 重复路径：只读一次、具名告警、不重复计记录', () => {
    const result = readRevisionsFromParts([
      { path: 'word/header1.xml', xml: HEADER1_XML },
      { path: 'word/header1.xml', xml: HEADER1_XML },
    ]);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]!.part_index).toBe(0);
    expect(result.total_records).toBe(2);
    expect(result.warnings.some((warning) => warning.message.includes('重复的部件路径'))).toBe(true);
  });

  it('⑫ 未知路径：kind=unknown 且具名告警，但仍按通用部件读出记录（不静默丢）', () => {
    const result = readRevisionsFromParts([
      { path: 'word/odd-extra.xml', xml: partXml('w:foo', HEADER_WARN_INNER()) },
      { path: 'word/whatever.xml', kind: 'header', xml: HEADER1_XML },
    ]);
    const odd = revisionPartByPath(result, 'word/odd-extra.xml')!;
    expect(odd.kind).toBe('unknown');
    expect(odd.records).toHaveLength(1);
    expect(result.warnings.some(
      (warning) => warning.path === 'word/odd-extra.xml' && warning.message.includes('无法按路径归类'),
    )).toBe(true);
    // 显式 kind 覆盖：路径不认识也照给的类别走，不告警。
    const explicitly = revisionPartByPath(result, 'word/whatever.xml')!;
    expect(explicitly.kind).toBe('header');
    expect(result.warnings.some((warning) => warning.path === 'word/whatever.xml')).toBe(false);
  });
});

function HEADER_WARN_INNER(): string {
  return `<w:p><w:ins w:id="41" w:author="甲" w:date="2026-10-03T05:00:00Z"><w:r><w:t>X</w:t></w:r></w:ins></w:p>`;
}

// ---------------------------------------------------------------------------

describe('部件记录可直接进 accept / reject 引擎（range 已绑该部件模型）', () => {
  const inputs: readonly RevisionPartInput[] = [
    { path: 'word/header1.xml', xml: HEADER1_XML },
  ];

  it('⑬ 接受全部 header 记录 = 只留普通 + 插入；拒绝全部 = 只留普通 + 删除', () => {
    const result = readRevisionsFromParts(inputs);
    const header = result.parts[0]!;

    const accepted = requireOk(
      acceptRevisions(header.model, header.records, { kind: 'all' }),
    );
    const acceptedTexts = collectParagraphs(accepted.value.model.blocks).map(paragraphText);
    expect(acceptedTexts).toEqual(['页眉插入页眉尾', '']);

    const rejected = requireOk(
      rejectRevisions(header.model, header.records, { kind: 'all' }),
    );
    const rejectedTexts = collectParagraphs(rejected.value.model.blocks).map(paragraphText);
    expect(rejectedTexts).toEqual(['页眉尾', '删页眉']);
  });
});

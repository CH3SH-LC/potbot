/**
 * **最小 DOCX 语料工厂**（W-R05 测试侧）——手工拼 XML，经本目录 `zip-writer` 打成 STORE 包。
 *
 * 全部语料都是**手写常量**，没有一份来自被测实现的输出：复核器如果只是「认得出自己人
 * 造的东西」，那它证明不了任何事。这里的正例合 OPC 最小形状，坏包则**只在一处**偏离正例，
 * 保证「哪条判据被触发」可归因。
 */

import { buildZip, corruptEntryData, type WriteEntry } from './zip-writer.js';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const STYLES_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles';
const MAIN_CT =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

/** 默认 `[Content_Types].xml`（正例）：Declare rels/xml，并 Override main document。 */
function defaultContentTypes(): string {
  return (
    XML_DECL +
    `<Types xmlns="${CT_NS}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/word/document.xml" ContentType="${MAIN_CT}"/>` +
    '</Types>'
  );
}

function defaultRootRels(): string {
  return (
    XML_DECL +
    `<Relationships xmlns="${REL_NS}">` +
    `<Relationship Id="rId1" Type="${OFFICE_DOC_REL}" Target="word/document.xml"/>` +
    '</Relationships>'
  );
}

function defaultDocumentRels(): string {
  return (
    XML_DECL +
    `<Relationships xmlns="${REL_NS}">` +
    `<Relationship Id="rId1" Type="${STYLES_REL}" Target="styles.xml"/>` +
    '</Relationships>'
  );
}

const DOCUMENT_XML =
  XML_DECL +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p></w:body></w:document>';

const STYLES_XML =
  XML_DECL +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>';

export interface DocxParts {
  readonly contentTypes: string;
  readonly rootRels: string;
  readonly documentRels: string;
  readonly document: string;
  readonly styles: string;
  /** 追加部件（放在固定顺序之后）。 */
  readonly extra?: readonly WriteEntry[];
}

/** 正例的固定部件集合。 */
export const BASE_PARTS: DocxParts = {
  contentTypes: defaultContentTypes(),
  rootRels: defaultRootRels(),
  documentRels: defaultDocumentRels(),
  document: DOCUMENT_XML,
  styles: STYLES_XML,
};

function orderedEntries(parts: DocxParts): WriteEntry[] {
  const entries: WriteEntry[] = [
    { name: '[Content_Types].xml', data: parts.contentTypes },
    { name: '_rels/.rels', data: parts.rootRels },
    { name: 'word/document.xml', data: parts.document },
    { name: 'word/_rels/document.xml.rels', data: parts.documentRels },
    { name: 'word/styles.xml', data: parts.styles },
  ];
  for (const extra of parts.extra ?? []) {
    entries.push(extra);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 正例
// ---------------------------------------------------------------------------

/** 正例：手工最小 DOCX（5 个部件），应通过全部包级判据。 */
export function goodDocx(): Uint8Array {
  return buildZip(orderedEntries(BASE_PARTS));
}

/**
 * 正例变体：全部条目以 **DEFLATE**（方法 8）存储——真实 Word/WPS 产出的形态。
 * 压缩器由调用方注入（不把 `node:zlib` 写进语料层），CRC 仍按原始字节计。
 */
export function deflatedDocx(compress: (data: Uint8Array) => Uint8Array): Uint8Array {
  const entries = orderedEntries(BASE_PARTS);
  return buildZip(entries, {
    deflateRaw: compress,
    deflateEntries: new Set(entries.map((entry) => entry.name)),
  });
}

/** 变体：正文等长改写（`hello` → `HELLO`），只动一个部件的字节（用于差异测试）。 */
export function goodDocxWithEditedBody(): Uint8Array {
  return buildZip(
    orderedEntries({
      ...BASE_PARTS,
      document: DOCUMENT_XML.replace('hello', 'HELLO'),
    }),
  );
}

/**
 * 变体：**只**多一个部件（`word/footer1.xml`），其余部件（含 `[Content_Types].xml`）逐字节
 * 不变——用于把差异测试的「新增」隔离成**单变量**（显式改 `[Content_Types].xml` 会让
 * changed 同时也亮，就分不清是"新增"还是"改了声明"）。
 */
export function docxWithExtraPart(): Uint8Array {
  return buildZip(
    orderedEntries({
      ...BASE_PARTS,
      extra: [{ name: 'word/footer1.xml', data: '<w:ftr/>' }],
    }),
  );
}

/** 正例：含**外部**关系（TargetMode="External"）——复核器**不得**把它当悬空关系。 */
export function goodDocxWithExternalRelationship(): Uint8Array {
  return buildZip(
    orderedEntries({
      ...BASE_PARTS,
      documentRels:
        XML_DECL +
        `<Relationships xmlns="${REL_NS}">` +
        `<Relationship Id="rId1" Type="${STYLES_REL}" Target="styles.xml"/>` +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" ' +
        'Target="https://example.com/" TargetMode="External"/>' +
        '</Relationships>',
    }),
  );
}

// ---------------------------------------------------------------------------
// 坏包（反向对照，各只在一处偏离正例）
// ---------------------------------------------------------------------------

/** 坏包 ①：`document.xml.rels` 指向一个不存在的部件（悬空关系）。 */
export function badDanglingRelationship(): Uint8Array {
  return buildZip(
    orderedEntries({
      ...BASE_PARTS,
      documentRels:
        XML_DECL +
        `<Relationships xmlns="${REL_NS}">` +
        `<Relationship Id="rId1" Type="${STYLES_REL}" Target="missing-styles.xml"/>` +
        '</Relationships>',
    }),
  );
}

/** 坏包 ②a：写入**错误 CRC**（中央目录与本地头都错）——纯头部不一致。 */
export function badCrcMismatch(): Uint8Array {
  return buildZip(orderedEntries(BASE_PARTS), {
    crcOverrides: new Map([['word/document.xml', 0xdeadbeef]]),
  });
}

/** 坏包 ②b：**数据**被改坏而 CRC 仍是原始值——真实的「内容损坏」形态。 */
export function badCorruptedData(): Uint8Array {
  return corruptEntryData(goodDocx(), 'word/styles.xml', 3);
}

/** 坏包 ③：新增一个扩展名（png）没有任何 Default/Override 声明的部件（内容类型缺声明）。 */
export function badMissingContentType(): Uint8Array {
  return buildZip(
    orderedEntries({
      ...BASE_PARTS,
      extra: [{ name: 'word/media/image1.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }],
    }),
  );
}

/** 坏包 ④：Override 指向不存在的部件（悬空 Override）。 */
export function badDanglingOverride(): Uint8Array {
  return buildZip(
    orderedEntries({
      ...BASE_PARTS,
      contentTypes: defaultContentTypes().replace(
        '</Types>',
        '<Override PartName="/word/ghost.xml" ContentType="application/xml"/></Types>',
      ),
    }),
  );
}

/** 坏包 ⑤：同一 PartName 被两条 Override 重复声明。 */
export function badDuplicateOverride(): Uint8Array {
  return buildZip(
    orderedEntries({
      ...BASE_PARTS,
      contentTypes: defaultContentTypes().replace(
        '</Types>',
        `<Override PartName="/word/document.xml" ContentType="${MAIN_CT}"/></Types>`,
      ),
    }),
  );
}

/** 坏包 ⑥：缺 `[Content_Types].xml` 整个部件。 */
export function badMissingContentTypesPart(): Uint8Array {
  const entries = orderedEntries(BASE_PARTS).filter(
    (entry) => entry.name !== '[Content_Types].xml',
  );
  return buildZip(entries);
}

/** 坏包 ⑦：截断——正例去掉末尾 10 字节。 */
export function badTruncated(): Uint8Array {
  const zip = goodDocx();
  return zip.slice(0, zip.length - 10);
}

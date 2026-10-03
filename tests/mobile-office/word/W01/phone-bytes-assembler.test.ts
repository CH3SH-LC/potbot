/**
 * **W01 —— DOCX 单一装配者：手机 bytes 适配 + 装配回执 + 关系装配**（`tests/mobile-office/word/W01/`）。
 *
 * 本文件是 W01 包对首次增量 `src/documents/docx/phone-bytes.ts` + `sha256.ts` 的**独立**取证，
 * 与同目录 `import-fail-closed.test.ts` 分工不同：那份盯**导入侧的 fail-closed**，
 * 这份盯**装配侧的三条验收**：
 *
 * | 验收判据（WORD.md W01 行） | 本文件怎么证 |
 * |---|---|
 * | 外部 DOCX 定点修改后**未改部件保持** | 真 DEFLATE 源包 → 定点改一段 → 保存 → **独立 `readZip` 逐部件比对**源/产物的**解压字节**，并核对回执的 `preserved` 集合与之一致 |
 * | **未知节点不静默丢** | 源包带段落级 `w:bookmarkStart`、run 内 `w:drawing`、未被指到的未知部件；保存后正文仍含这些片段、未知部件逐字节仍在 |
 * | **拒绝损坏/恶意压缩包** | 截断包经端口导入 ⇒ 有界 `ZipReadError`；空 ref ⇒ 有界 `DocxBytesError('ref_empty')` |
 * | **不依赖桌面 Node 文件系统** | 源码级扫描：`phone-bytes.ts` / `sha256.ts` **零 `node:` 说明符**；端口读到的字节与内存端口一致（无任何磁盘路径参与） |
 * | 关系装配 | 保存后**每一个** `.rels` 都能重新解析；定点编辑不改关系数；新增页眉引用时**追加** rId（不重用、不重排）并补内容类型 |
 *
 * ## 为什么"独立"
 *
 * - 字节比对**不经过**被测回执的 `preserved` 判定：测试自己 `readZip` 两侧、自己比数组，
 *   再**另行**断言回执的判定与之一致（两边同时错才会假绿，而它们走的是两条不同代码路径）。
 * - `sha256Hex` 用 `node:crypto` 作**独立对照**（测试侧允许 `node:*`），覆盖 55/56/63/64/65
 *   这些分块边界——纯实现最容易在"最后一块加不加一个 64 字节块"处出错。
 * - 源包是 `deflateRawSync` 真 DEFLATE（真实 Word/WPS 形态），不是本仓 `zip.ts` 的全 STORE 产物。
 *
 * ## 构造方式
 *
 * 源包由本文件的最小 DEFLATE 构造器拼装（字段可控，含 CRC 覆盖选项以造坏包）；
 * 不读磁盘 fixture、不联网。`node:*` 只出现在**测试侧**（产品路径的零 `node:` 由上文源码扫描守住）。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { crc32 } from '../../../../src/artifacts/ooxml/crc32.js';
import { ZipReadError, readZip } from '../../../../src/artifacts/ooxml/zip-read.js';
import type { DocumentModel } from '../../../../src/documents/model/types.js';
import {
  DOCX_MAIN_CONTENT_TYPE,
  DocxBytesError,
  InMemoryDocxBytesPort,
  loadDocx,
  saveDocx,
  sha256Hex,
} from '../../../../src/documents/docx/index.js';
import { assertZipReadEntryPath } from '../../../../src/artifacts/ooxml/zip-read.js';

// ---------------------------------------------------------------------------
// 命名空间与最小部件
// ---------------------------------------------------------------------------

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const PARTS = {
  contentTypes: '[Content_Types].xml',
  rootRels: '_rels/.rels',
  document: 'word/document.xml',
  documentRels: 'word/_rels/document.xml.rels',
  styles: 'word/styles.xml',
  settings: 'word/settings.xml',
  theme: 'word/theme/theme1.xml',
  customXml: 'customXml/item1.xml',
  core: 'docProps/core.xml',
  order: 'word/unmodelled-thing.xml',
  media: 'word/media/image1.png',
  header1: 'word/header1.xml',
} as const;

const CONTENT_TYPES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<Types xmlns="${CT}">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Default Extension="png" ContentType="image/png"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
  `<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>` +
  `<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
  `<Override PartName="/customXml/item1.xml" ContentType="application/xml"/>` +
  `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
  `</Types>`;

const ROOT_RELS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<Relationships xmlns="${RELS}">` +
  `<Relationship Id="rId1" Type="${OFFICE}/officeDocument" Target="word/document.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
  `</Relationships>`;

const DOCUMENT_RELS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<Relationships xmlns="${RELS}">` +
  `<Relationship Id="rId1" Type="${OFFICE}/styles" Target="styles.xml"/>` +
  `<Relationship Id="rId2" Type="${OFFICE}/settings" Target="settings.xml"/>` +
  `<Relationship Id="rId3" Type="${OFFICE}/theme" Target="theme/theme1.xml"/>` +
  `<Relationship Id="rId4" Type="${OFFICE}/image" Target="media/image1.png"/>` +
  `<Relationship Id="rId5" Type="${OFFICE}/customXml" Target="../customXml/item1.xml"/>` +
  `<Relationship Id="rId6" Type="${OFFICE}/hyperlink" Target="https://example.com/" TargetMode="External"/>` +
  `</Relationships>`;

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<w:styles xmlns:w="${W}">` +
  `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>` +
  `<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>` +
  `</w:styles>`;

const SETTINGS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<w:settings xmlns:w="${W}"><w:zoom w:percent="100"/><w:defaultTabStop w:val="420"/></w:settings>`;

const THEME_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office 主题">` +
  `<a:themeElements><a:clrScheme name="Office"/></a:themeElements></a:theme>`;

const CUSTOM_XML = `<?xml version="1.0" encoding="UTF-8"?>\n<root xmlns="urn:potbot:custom">自定义部件数据</root>`;

const CORE_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
  `xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>雨</dc:title></cp:coreProperties>`;

/** 未被任何关系指到的未知部件（用于验证"不静默丢"）。 */
const UNKNOWN_PART_XML = `<?xml version="1.0"?><x:weird xmlns:x="urn:potbot:weird"><x:a/></x:weird>`;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

/** 正文：命名样式段 + 段落级未建模片段（bookmark）+ run 内未建模片段（drawing）+ 节。 */
function documentXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
    `<w:document xmlns:w="${W}" xmlns:r="${R}">` +
    `<w:body>` +
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>` +
    `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">第一章  雨</w:t></w:r></w:p>` +
    `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>` +
    `<w:r><w:t>正文一</w:t></w:r>` +
    `<w:bookmarkStart w:id="0" w:name="bm0"/><w:r><w:t>正文二</w:t></w:r><w:bookmarkEnd w:id="0"/>` +
    `</w:p>` +
    `<w:p><w:r><w:drawing><a:blip r:embed="rId4"/></w:drawing><w:t>带图</w:t></w:r>` +
    `<w:hyperlink r:id="rId6"><w:r><w:t>链接</w:t></w:r></w:hyperlink></w:p>` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:gutter="0"/></w:sectPr>` +
    `</w:body></w:document>`
  );
}

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

// ---------------------------------------------------------------------------
// 最小 DEFLATE 构造器（真压缩，模拟外部 Word/WPS 包）
// ---------------------------------------------------------------------------

interface ZipEntrySpec {
  readonly path: string;
  readonly data: Uint8Array;
  /** 覆盖中央目录记录的 CRC（造"损坏包"）。 */
  readonly crcOverride?: number;
}

function buildSourceZip(entries: readonly ZipEntrySpec[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  const offsets: number[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const compressed = new Uint8Array(deflateRawSync(Buffer.from(entry.data)));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); // DEFLATE
    local.writeUInt32LE(entry.crcOverride ?? crc32(entry.data), 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(entry.data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    offsets.push(offset);
    locals.push(new Uint8Array(local), new Uint8Array(name), compressed);
    offset += local.byteLength + name.byteLength + compressed.byteLength;
  }

  const centralStart = offset;
  for (const [index, entry] of entries.entries()) {
    const name = Buffer.from(entry.path, 'utf8');
    const compressed = new Uint8Array(deflateRawSync(Buffer.from(entry.data)));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(entry.crcOverride ?? crc32(entry.data), 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(entry.data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offsets[index] as number, 42);
    centrals.push(new Uint8Array(central), new Uint8Array(name));
    offset += central.byteLength + name.byteLength;
  }

  const centralDirectory = concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.byteLength, 12);
  eocd.writeUInt32LE(centralStart, 16);

  return concat([...locals, centralDirectory, new Uint8Array(eocd)]);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** 一份完整的"外部"DOCX（DEFLATE 打包，含未知部件与未建模节点）。 */
function buildExternalDocx(): Uint8Array {
  return buildSourceZip([
    { path: PARTS.contentTypes, data: enc(CONTENT_TYPES_XML) },
    { path: PARTS.rootRels, data: enc(ROOT_RELS_XML) },
    { path: PARTS.document, data: enc(documentXml()) },
    { path: PARTS.documentRels, data: enc(DOCUMENT_RELS_XML) },
    { path: PARTS.styles, data: enc(STYLES_XML) },
    { path: PARTS.settings, data: enc(SETTINGS_XML) },
    { path: PARTS.theme, data: enc(THEME_XML) },
    { path: PARTS.customXml, data: enc(CUSTOM_XML) },
    { path: PARTS.core, data: enc(CORE_XML) },
    { path: PARTS.order, data: enc(UNKNOWN_PART_XML) },
    { path: PARTS.media, data: PNG_BYTES },
  ]);
}

/** 取某个 zip 里某部件的解压字节。 */
function partBytes(zip: Uint8Array, path: string): Uint8Array {
  const entry = readZip(zip).by_path.get(path);
  if (entry === undefined) throw new Error(`包里没有 ${path}`);
  return entry.data;
}

function partText(zip: Uint8Array, path: string): string {
  return new TextDecoder().decode(partBytes(zip, path));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** 只改"第一段的对齐方式"这一处属性（其余一切照旧）。 */
function withFirstParagraphRightAligned(model: DocumentModel): DocumentModel {
  const blocks = model.blocks.map((block, index) => {
    if (index !== 0 || block.kind !== 'paragraph') return block;
    return {
      ...block,
      properties: { ...block.properties, alignment: { state: 'set', value: 'right' } as const },
    };
  });
  return { ...model, blocks };
}

const UNTOUCHED = [
  PARTS.contentTypes,
  PARTS.rootRels,
  PARTS.documentRels,
  PARTS.styles,
  PARTS.settings,
  PARTS.theme,
  PARTS.customXml,
  PARTS.core,
  PARTS.order,
  PARTS.media,
] as const;

// ===========================================================================
// A. 纯 SHA-256 —— 对 node:crypto 的独立对照
// ===========================================================================

describe('W01 sha256Hex —— 与 node:crypto 逐字节对照（含分块边界）', () => {
  const nodeDigest = (bytes: Uint8Array): string =>
    createHash('sha256').update(bytes).digest('hex');

  it('已知向量：空串与 "abc"', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(enc('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('长度覆盖 55/56/63/64/65/127/128（分块边界）与 0/1/1000，全部与 node:crypto 一致', () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 127, 128, 1000]) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = (i * 131 + 7) & 0xff;
      expect(sha256Hex(bytes), `长度 ${String(length)} 的摘要不符`).toBe(nodeDigest(bytes));
    }
  });

  it('对一整份外部 DOCX 的字节，纯实现与 node:crypto 一致', () => {
    const docx = buildExternalDocx();
    expect(sha256Hex(docx)).toBe(nodeDigest(docx));
  });
});

// ===========================================================================
// B. 端口语义 —— 有界拒绝，不产出半成品
// ===========================================================================

describe('W01 bytes 端口 —— 读写语义与有界拒绝', () => {
  it('InMemoryDocxBytesPort 回读同一字节，且回读是复制（改一边不串另一边）', () => {
    const port = new InMemoryDocxBytesPort();
    const original = enc('hello');
    port.put('a.docx', original);
    const first = port.read('a.docx');
    expect(Array.from(first)).toEqual(Array.from(original));
    first[0] = 0x00; // 改回读副本
    expect(Array.from(port.read('a.docx'))).toEqual(Array.from(original));
    expect(port.has('a.docx')).toBe(true);
    expect(port.has('missing.docx')).toBe(false);
  });

  it('读不存在的 ref ⇒ 有界 DocxBytesError(unknown_source_ref)，不是 TypeError/undefined', () => {
    const port = new InMemoryDocxBytesPort();
    let caught: unknown;
    try {
      loadDocx(port, 'nope.docx');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DocxBytesError);
    expect((caught as DocxBytesError).reason).toBe('unknown_source_ref');
  });

  it('ref 读到 0 字节 ⇒ 有界 DocxBytesError(ref_empty)（空包不是空文档）', () => {
    const port = new InMemoryDocxBytesPort();
    port.put('empty.docx', new Uint8Array(0));
    let caught: unknown;
    try {
      loadDocx(port, 'empty.docx');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DocxBytesError);
    expect((caught as DocxBytesError).reason).toBe('ref_empty');
  });

  it('截断的包经端口导入 ⇒ 有界 ZipReadError（不是栈溢出/挂起）', () => {
    const port = new InMemoryDocxBytesPort();
    const full = buildExternalDocx();
    port.put('truncated.docx', full.subarray(0, 40));
    let caught: unknown;
    try {
      loadDocx(port, 'truncated.docx');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ZipReadError);
    expect(caught).not.toBeInstanceOf(RangeError);
  });

  it('CRC 被改坏的条目经端口导入 ⇒ 有界 ZipReadError(crc_mismatch)', () => {
    const port = new InMemoryDocxBytesPort();
    port.put(
      'broken.docx',
      buildSourceZip([
        { path: PARTS.contentTypes, data: enc(CONTENT_TYPES_XML) },
        { path: PARTS.rootRels, data: enc(ROOT_RELS_XML) },
        { path: PARTS.document, data: enc(documentXml()), crcOverride: 1 },
      ]),
    );
    let caught: unknown;
    try {
      loadDocx(port, 'broken.docx');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ZipReadError);
    expect((caught as ZipReadError).reason).toBe('crc_mismatch');
  });

  it('端口返回非 Uint8Array ⇒ 有界拒绝（不把坏类型传进解析器）', () => {
    const badPort = {
      read: (): Uint8Array => 'not bytes' as unknown as Uint8Array,
      write: (): void => undefined,
    };
    expect(() => loadDocx(badPort, 'x.docx')).toThrow(DocxBytesError);
  });
});

// ===========================================================================
// C. 源码纪律 —— 产品路径零 node:
// ===========================================================================

describe('W01 手机适配层 —— 零 node: 说明符（不依赖桌面运行时）', () => {
  it('phone-bytes.ts / sha256.ts 里没有任何 `node:` import 或 require', () => {
    for (const file of ['phone-bytes.ts', 'sha256.ts']) {
      const source = readFileSync(
        new URL(`../../../../src/documents/docx/${file}`, import.meta.url),
        'utf8',
      );
      for (const pattern of [/from\s+['"]node:/, /require\(\s*['"]node:/, /import\(\s*['"]node:/]) {
        expect(pattern.test(source), `${file} 含违反纪律的 ${String(pattern)}`).toBe(false);
      }
    }
  });
});

// ===========================================================================
// D. 定点编辑 → 未改部件逐字节保持（独立 readZip 对照 + 回执一致）
// ===========================================================================

describe('W01 装配 —— 外部 DOCX 定点修改后未改部件保持', () => {
  const source = buildExternalDocx();
  const port = new InMemoryDocxBytesPort();
  port.put('in.docx', source);

  const loaded = loadDocx(port, 'in.docx');
  const edited = withFirstParagraphRightAligned(loaded.model);
  const receipt = saveDocx(port, 'out.docx', edited, {
    source_digest: loaded.source_digest,
    verify_reimport: true,
  });
  const written = port.read('out.docx');

  it('loadDocx 回执：源摘要 = 独立 node:crypto 摘要，源部件清单完整', () => {
    const independent = createHash('sha256').update(source).digest('hex');
    expect(loaded.source_digest).toBe(independent);
    expect(loaded.main_part_path).toBe(PARTS.document);
    expect(loaded.source_entry_count).toBe(11);
    expect(loaded.source_part_paths).toContain(PARTS.order);
  });

  it('独立对照：除主部件外的每一个部件，源与产物**解压字节逐字节相同**', () => {
    for (const path of UNTOUCHED) {
      const before = partBytes(source, path);
      const after = partBytes(written, path);
      expect(bytesEqual(before, after), `部件 ${path} 应当逐字节不变`).toBe(true);
    }
  });

  it('改动的部件确实变了（否则"不变"就没有意义）', () => {
    expect(bytesEqual(partBytes(source, PARTS.document), partBytes(written, PARTS.document))).toBe(
      false,
    );
  });

  it('回执的 preserved 集合与独立比对**一致**：恰好是那 10 个未改部件，且无 removed', () => {
    const expectedPreserved = [...UNTOUCHED].sort();
    expect([...receipt.preserved_parts].sort()).toEqual(expectedPreserved);
    expect(receipt.changed_objects).toEqual([PARTS.document]);
    expect(receipt.parts.some((record) => record.disposition === 'removed')).toBe(false);
    expect(receipt.warnings).toEqual([]);
    expect(receipt.mime).toBe(DOCX_MAIN_CONTENT_TYPE);
    expect(receipt.byte_length).toBe(written.byteLength);
    expect(receipt.digest).toBe(sha256Hex(written));
    expect(receipt.source_digest).toBe(loaded.source_digest);
  });

  it('改动真的落进产物：重新导入产物，第一段变成右对齐', () => {
    const reimported = readZip(written);
    expect(reimported.entries.length).toBeGreaterThan(0);
    const text = partText(written, PARTS.document);
    expect(text).toContain('<w:jc w:val="right"/>');
  });

  it('产物自洽：verify_reimport 已把"装配产物可被重新导入"跑过（保存成功即证据）', () => {
    // saveDocx 打开 verify_reimport 时若产物不能重新导入会抛错；到这里说明通过。
    expect(() => loadDocx(port, 'out.docx')).not.toThrow();
  });
});

// ===========================================================================
// E. 未知节点不静默丢（穿过装配层）
// ===========================================================================

describe('W01 未知节点 / 未知部件不静默丢', () => {
  const source = buildExternalDocx();
  const port = new InMemoryDocxBytesPort();
  port.put('in.docx', source);
  const loaded = loadDocx(port, 'in.docx');
  const receipt = saveDocx(port, 'out.docx', withFirstParagraphRightAligned(loaded.model));
  const written = port.read('out.docx');

  it('段落级未建模片段（w:bookmarkStart/End）在产物正文里仍原样出现', () => {
    const text = partText(written, PARTS.document);
    expect(text).toContain('bookmarkStart');
    expect(text).toContain('w:name="bm0"');
    expect(text).toContain('bookmarkEnd');
  });

  it('run 内未建模片段（w:drawing + r:embed）在产物正文里仍原样出现', () => {
    const text = partText(written, PARTS.document);
    expect(text).toContain('drawing');
    expect(text).toContain('r:embed="rId4"');
  });

  it('未被任何关系指到的未知部件在产物里逐字节仍在，且回执判为 preserved', () => {
    expect(bytesEqual(partBytes(written, PARTS.order), partBytes(source, PARTS.order))).toBe(true);
    const record = receipt.parts.find((part) => part.path === PARTS.order);
    expect(record?.disposition).toBe('preserved');
  });
});

// ===========================================================================
// F. 关系装配 —— 既有 rId 不重排，新增引用只追加 + 补内容类型
// ===========================================================================

describe('W01 关系装配 —— 追加不重排、内容类型同步', () => {
  const source = buildExternalDocx();
  const port = new InMemoryDocxBytesPort();
  port.put('in.docx', source);
  const loaded = loadDocx(port, 'in.docx');
  const edited = withFirstParagraphRightAligned(loaded.model);

  it('定点编辑不改变关系条数：产物每个 .rels 都能重新解析，总数不变', () => {
    const receipt = saveDocx(port, 'same.docx', edited);
    const written = port.read('same.docx');
    // 源里关系总条数：包级 2 条（rId1 officeDocument + rId2 core-properties）
    // + 主部件 6 条 = 8。回执两侧都应等于它。
    expect(receipt.relationships_before).toBe(8);
    expect(receipt.relationships_after).toBe(8);
    // 关系部件在定点编辑下逐字节保持（R106：不得无映射重排 rId）。
    for (const path of [PARTS.rootRels, PARTS.documentRels] as const) {
      expect(bytesEqual(partBytes(source, path), partBytes(written, path))).toBe(true);
    }
  });

  it('新增页眉引用：既有 rId 顺序不变，新 rId = 已用最大编号 + 1，且补了内容类型', () => {
    const headerXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
      `<w:hdr xmlns:w="${W}"><w:p><w:r><w:t>页眉</w:t></w:r></w:p></w:hdr>`;
    const headerBytes = enc(headerXml);

    // 把一份页眉部件加入模型的包级事实，并让唯一的节引用它（WF-051 的关系装配路径）。
    const withHeader: DocumentModel = {
      ...edited,
      opaque_parts: [
        ...edited.opaque_parts,
        {
          path: PARTS.header1,
          content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
          bytes: headerBytes,
        },
      ],
      sections: edited.sections.map((section) => ({
        ...section,
        headers: [{ part_path: PARTS.header1, kind: 'default' as const }],
      })),
    };
    expect(withHeader.sections.length).toBeGreaterThan(0);

    const receipt = saveDocx(port, 'header.docx', withHeader, { verify_reimport: true });
    const written = port.read('header.docx');

    // ① 主部件关系表新增一条 header 关系；既有 rId1..rId6 顺序不变。
    const rels = readZip(written).by_path.get(PARTS.documentRels);
    if (rels === undefined) throw new Error('产物缺主部件关系表');
    const ids = [...new TextDecoder().decode(rels.data).matchAll(/Id="(rId\d+)"/g)].map(
      (match) => match[1],
    );
    expect(ids.slice(0, 6)).toEqual(['rId1', 'rId2', 'rId3', 'rId4', 'rId5', 'rId6']);
    expect(ids).toHaveLength(7);
    expect(ids[6]).toBe('rId7'); // 已用最大编号 + 1，不复用、不重排
    const relsText = new TextDecoder().decode(rels.data);
    expect(relsText).toContain('/relationships/header');
    expect(relsText).toContain('Target="header1.xml"');

    // ② 内容类型补了该部件的 Override（新增部件必须同步声明，R106）。
    const contentTypes = partText(written, PARTS.contentTypes);
    expect(contentTypes).toContain('PartName="/word/header1.xml"');
    expect(contentTypes).toContain('wordprocessingml.header+xml');

    // ③ 回执：关系数 +1，页眉部件逐字节保留，changed_objects 含新写的关系表与内容类型表。
    expect(receipt.relationships_before).toBe(8);
    expect(receipt.relationships_after).toBe(9);
    expect(receipt.parts.find((part) => part.path === PARTS.header1)?.disposition).toBe('preserved');
    expect(receipt.changed_objects).toContain(PARTS.documentRels);
    expect(receipt.changed_objects).toContain(PARTS.contentTypes);
    expect(receipt.warnings).toEqual([]);

    // ④ 正文里的节引用了新 rId，且 rId 与关系表一致（悬空引用会被导入拒绝，verify_reimport 已过）。
    expect(partText(written, PARTS.document)).toContain('r:id="rId7"');
  });
});

// ===========================================================================
// G. zip 路径纪律在适配层同样生效（防"端口绕开校验"）
// ===========================================================================

describe('W01 适配层不绕开 zip 路径校验', () => {
  it('路径穿越条目名经端口导入 ⇒ 有界 ZipReadError(invalid_path)', () => {
    const bytes = buildSourceZip([{ path: '../escape.xml', data: enc('<x/>') }]);
    const port = new InMemoryDocxBytesPort();
    port.put('evil.docx', bytes);
    let caught: unknown;
    try {
      loadDocx(port, 'evil.docx');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ZipReadError);
    expect((caught as ZipReadError).reason).toBe('invalid_path');
  });

  it('对照：同一条校验函数对合法路径不误杀', () => {
    expect(() => assertZipReadEntryPath('word/document.xml')).not.toThrow();
  });
});

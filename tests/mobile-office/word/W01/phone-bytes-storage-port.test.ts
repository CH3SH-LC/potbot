/**
 * **W-I19 —— W01 手机 bytes 适配层落地到 K09 存储端口**（`tests/mobile-office/word/W01/`）。
 *
 * W01 首次增量只交付了 `InMemoryDocxBytesPort`（内存端口）与装配回执。本文件独立取证
 * W-I19 的**宿主接缝**：让 `loadDocx → 定点编辑 → saveDocx` 真正跑在
 * **K09 `StoragePort`**（`apps/mobile-kernel/storage`，本轮用 `MemoryStoragePort` 作真实现）
 * 或一份 K09 形状相符的窄 blob 存储上，而不是只跑在内存端口上。
 *
 * ## 验收判据（本文件各自怎么证）
 *
 * | 判据 | 本文件怎么证 |
 * |---|---|
 * | load → 定点编辑 → save 经**真存储端口**往返 | 源包先 `writeStream` 落进 `MemoryStoragePort`，端口用 `content://` 引用；用 `docxBytesPortOverStoragePort(storage)` 装配后 `loadDocx`→改一段→`saveDocx(verify_reimport)` 全跑通 |
 * | **未改部件逐字节保持** | 测试**自己** `readZip` 两侧、自己比数组（不经回执判定），再另行断言回执 `preserved` 集合与之一致 |
 * | **缺 ref 拒绝** | 端口 `read` 一个没写过的 `content://` ⇒ 有界 `DocxBytesError('unknown_source_ref')`；`loadDocx` 亦然 |
 * | **读失败 fail-closed（空 / 未知 / 非 Uint8Array）** | 空 blob ⇒ `ref_empty`；`status: 'failed'` / 非 Uint8Array / `null` ⇒ `unknown_source_ref`（**绝不当作空文档**） |
 * | K09 交叉核验 | K09 端口读回凭据 `readBack().verified === true`；`revision` 随 CAS 覆盖递增；K09 的 `sha256:<hex>` 摘要与 W01 `sha256Hex` 对同一份产物一致 |
 * | 窄 blob 存储（list/get/put/delete） | `InMemoryDocxBlobStore` 经 `BlobStoreDocxBytesPort` 走同一套 load/edit/save；`has` 走 `list`；`delete` 后 `read` ⇒ `unknown_source_ref` |
 * | 写路径不乱覆盖 | 版本 CAS 恒冲突的有界重试 ⇒ `DocxBytesError('write_rejected')`，且重试次数**恰好**等于配置上限 |
 *
 * ## 独立性
 *
 * - 源包用本文件的**最小 DEFLATE 构造器**拼装（与同目录 `phone-bytes-assembler.test.ts` 同形但不共享代码）。
 * - 字节比对不经过被测回执：测试自己解压两侧、自比；回执判定另行断言。
 * - K09 端口来自 `apps/mobile-kernel/storage`（**不是**本文件自造的替身），它满足
 *   `DocxStoragePortLike` 是本文件在**编译期**就验证的事实（类型标注即断言）。
 */

import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { MemoryStoragePort } from '../../../../apps/mobile-kernel/storage/index.js';
import { crc32 } from '../../../../src/artifacts/ooxml/crc32.js';
import { readZip } from '../../../../src/artifacts/ooxml/zip-read.js';
import type { DocumentModel } from '../../../../src/documents/model/types.js';
import {
  DocxBytesError,
  InMemoryDocxBytesPort,
  loadDocx,
  saveDocx,
  sha256Hex,
} from '../../../../src/documents/docx/index.js';
import {
  BlobStoreDocxBytesPort,
  InMemoryDocxBlobStore,
  StoragePortDocxBytesPort,
  docxBytesPortOverStoragePort,
  type DocxBlobStore,
  type DocxBytesPort,
  type DocxStoragePortLike,
} from '../../../../src/documents/docx/phone-bytes.js';

// ---------------------------------------------------------------------------
// 命名空间与最小部件（外部 Word/WPS 形态）
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

/** 未被任何关系指到的未知部件（验证"不静默丢"）。 */
const UNKNOWN_PART_XML = `<?xml version="1.0"?><x:weird xmlns:x="urn:potbot:weird"><x:a/></x:weird>`;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

/** 正文：命名样式段 + 段落级未建模片段 + run 内未建模片段 + 节。 */
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
    local.writeUInt32LE(crc32(entry.data), 14);
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
    central.writeUInt32LE(crc32(entry.data), 16);
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

const FIXED_NOW = 1_700_000_000_000;
const DOCX_URI = 'content://potbot/artifacts/report.docx';

const nodeDigest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** 让一段断言代码无论抛什么都返回错误对象，便于 `reason` 断言。 */
function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

// ===========================================================================
// A. 经 K09 StoragePort（content:// 引用）的 load → 编辑 → save 往返
// ===========================================================================

describe('W-I19 经 K09 StoragePort 的装配往返', () => {
  async function seedStorage(): Promise<{
    storage: MemoryStoragePort;
    ref: string;
    source: Uint8Array;
    port: DocxBytesPort;
  }> {
    const storage = new MemoryStoragePort({ now: () => FIXED_NOW });
    // 用 K09 自己的 getContentUri 造 content:// 引用（不是手拼字符串）。
    const ref = storage.getContentUri({ relativePath: 'artifacts/report.docx' }).uri;
    const source = buildExternalDocx();
    await storage.writeStream({ uri: ref, chunks: [source] });
    const port = docxBytesPortOverStoragePort(storage);
    return { storage, ref, source, port };
  }

  it('源包先落进 K09 存储，端口以 content:// 引用读回同一字节', async () => {
    const { storage, ref, source, port } = await seedStorage();
    expect(ref).toBe(DOCX_URI);
    expect(storage.readBlob(ref).status).toBe('ok');
    const viaPort = port.read(ref);
    expect(bytesEqual(viaPort, source)).toBe(true);
    expect(sha256Hex(viaPort)).toBe(nodeDigest(source));
    expect(port.has?.(ref)).toBe(true);
  });

  it('load → 定点编辑 → save 全跑通，且未改部件**逐字节保持**（独立 readZip 对照）', async () => {
    const { ref, source, port } = await seedStorage();

    const loaded = loadDocx(port, ref);
    const edited = withFirstParagraphRightAligned(loaded.model);
    const receipt = saveDocx(port, ref, edited, {
      source_digest: loaded.source_digest,
      verify_reimport: true,
    });
    const written = port.read(ref);

    // ① 独立对照：除主部件外的每一个部件，源与产物解压字节逐字节相同。
    for (const path of UNTOUCHED) {
      expect(bytesEqual(partBytes(source, path), partBytes(written, path)), `部件 ${path} 应逐字节不变`).toBe(
        true,
      );
    }
    // ② 改动的部件确实变了（否则"不变"无意义）。
    expect(bytesEqual(partBytes(source, PARTS.document), partBytes(written, PARTS.document))).toBe(false);
    // ③ 回执判定与独立比对一致。
    expect([...receipt.preserved_parts].sort()).toEqual([...UNTOUCHED].sort());
    expect(receipt.changed_objects).toEqual([PARTS.document]);
    expect(receipt.parts.some((record) => record.disposition === 'removed')).toBe(false);
    expect(receipt.warnings).toEqual([]);
    expect(receipt.digest).toBe(sha256Hex(written));
    expect(receipt.source_digest).toBe(loaded.source_digest);
    // ④ 改动真的落进产物。
    expect(partText(written, PARTS.document)).toContain('<w:jc w:val="right"/>');
    // ⑤ 产物自洽：端口能重新导入自己的产物。
    expect(() => loadDocx(port, ref)).not.toThrow();
  });

  it('K09 交叉核验：CAS 覆盖使 revision 递增，读回凭据 verified，K09 摘要与 W01 sha256Hex 一致', async () => {
    const { storage, ref, source, port } = await seedStorage();
    expect(storage.readBlob(ref).revision).toBe(1);

    const loaded = loadDocx(port, ref);
    const receipt = saveDocx(port, ref, withFirstParagraphRightAligned(loaded.model), {
      source_digest: loaded.source_digest,
      verify_reimport: true,
    });

    // 写路径经 compareAndSwap，版本由 1 递增到 2（不是原地无声覆盖）。
    expect(storage.readBlob(ref).revision).toBe(2);
    const readBack = storage.readBack({ uri: ref });
    expect(readBack.status).toBe('ok');
    expect(readBack.readBack?.verified).toBe(true);
    // K09 的 sha256:<hex> 与 W01 的裸 hex 必须是同一份产物摘要。
    expect(storage.readBlob(ref).blob?.digest).toBe(`sha256:${receipt.digest}`);
    expect(receipt.digest).toBe(nodeDigest(port.read(ref)));
    expect(bytesEqual(source, port.read(ref))).toBe(false); // 内容确已改变
  });
});

// ===========================================================================
// B. fail-closed —— 空 / 未知 / 非 Uint8Array 一律拒绝
// ===========================================================================

describe('W-I19 读路径 fail-closed', () => {
  it('缺 ref：读没写过的 content:// ⇒ DocxBytesError(unknown_source_ref)，loadDocx 亦然', async () => {
    const storage = new MemoryStoragePort({ now: () => FIXED_NOW });
    const port = docxBytesPortOverStoragePort(storage);
    const missing = 'content://potbot/artifacts/never-written.docx';

    const direct = capture(() => port.read(missing));
    expect(direct).toBeInstanceOf(DocxBytesError);
    expect((direct as DocxBytesError).reason).toBe('unknown_source_ref');

    const viaLoad = capture(() => loadDocx(port, missing));
    expect(viaLoad).toBeInstanceOf(DocxBytesError);
    expect((viaLoad as DocxBytesError).reason).toBe('unknown_source_ref');
    expect(port.has?.(missing)).toBe(false);
  });

  it('空 blob（0 字节）⇒ DocxBytesError(ref_empty)：空包不是空文档（R140）', async () => {
    const storage = new MemoryStoragePort({ now: () => FIXED_NOW });
    const ref = storage.getContentUri({ relativePath: 'artifacts/empty.docx' }).uri;
    await storage.writeStream({ uri: ref, chunks: [] }); // 写 0 字节
    const port = docxBytesPortOverStoragePort(storage);

    const caught = capture(() => port.read(ref));
    expect(caught).toBeInstanceOf(DocxBytesError);
    expect((caught as DocxBytesError).reason).toBe('ref_empty');
  });

  it('存储返回非 Uint8Array ⇒ unknown_source_ref（不把坏类型传进 ZIP 解析器）', () => {
    const bad: DocxStoragePortLike = {
      readBlob: () => ({ status: 'ok', bytes: 'not bytes' as unknown as Uint8Array, revision: 1 }),
      compareAndSwap: () => ({ status: 'ok', cas: { newRevision: 2 } }),
    };
    const caught = capture(() => new StoragePortDocxBytesPort(bad).read('content://potbot/x.docx'));
    expect(caught).toBeInstanceOf(DocxBytesError);
    expect((caught as DocxBytesError).reason).toBe('unknown_source_ref');
  });

  it('存储返回 status=failed ⇒ unknown_source_ref（读失败绝不降级成空文档）', () => {
    const failed: DocxStoragePortLike = {
      readBlob: () => ({ status: 'failed', bytes: null }),
      compareAndSwap: () => ({ status: 'ok', cas: { newRevision: 1 } }),
    };
    const caught = capture(() => new StoragePortDocxBytesPort(failed).read('content://potbot/x.docx'));
    expect(caught).toBeInstanceOf(DocxBytesError);
    expect((caught as DocxBytesError).reason).toBe('unknown_source_ref');
  });

  it('窄 blob 存储：get 返回 null / 非 Uint8Array / 空 一律 fail-closed', () => {
    const empty: DocxBlobStore = {
      get: () => new Uint8Array(0),
      put: () => undefined,
      delete: () => undefined,
      list: () => [],
    };
    const wrongType: DocxBlobStore = {
      get: () => 'nope' as unknown as Uint8Array,
      put: () => undefined,
      delete: () => undefined,
      list: () => [],
    };
    const missing: DocxBlobStore = {
      get: () => null,
      put: () => undefined,
      delete: () => undefined,
      list: () => [],
    };

    const e1 = capture(() => new BlobStoreDocxBytesPort(empty).read('x'));
    expect((e1 as DocxBytesError).reason).toBe('ref_empty');
    const e2 = capture(() => new BlobStoreDocxBytesPort(wrongType).read('x'));
    expect(e2).toBeInstanceOf(DocxBytesError);
    expect((e2 as DocxBytesError).reason).toBe('unknown_source_ref');
    const e3 = capture(() => new BlobStoreDocxBytesPort(missing).read('x'));
    expect(e3).toBeInstanceOf(DocxBytesError);
    expect((e3 as DocxBytesError).reason).toBe('unknown_source_ref');
  });
});

// ===========================================================================
// C. 窄 blob 存储（list / get / put / delete）上的同一套装配
// ===========================================================================

describe('W-I19 窄 blob 存储（list/get/put/delete）适配', () => {
  it('经 InMemoryDocxBlobStore 的 load → 编辑 → save 往返，未改部件逐字节保持', () => {
    const store = new InMemoryDocxBlobStore();
    const source = buildExternalDocx();
    store.put('report.docx', source);
    const port = new BlobStoreDocxBytesPort(store);

    expect(store.list()).toEqual(['report.docx']);
    expect(port.has?.('report.docx')).toBe(true);

    const loaded = loadDocx(port, 'report.docx');
    const receipt = saveDocx(port, 'report.docx', withFirstParagraphRightAligned(loaded.model), {
      source_digest: loaded.source_digest,
      verify_reimport: true,
    });
    const written = port.read('report.docx');

    for (const path of UNTOUCHED) {
      expect(bytesEqual(partBytes(source, path), partBytes(written, path)), `部件 ${path} 应逐字节不变`).toBe(
        true,
      );
    }
    expect(receipt.changed_objects).toEqual([PARTS.document]);
    expect([...receipt.preserved_parts].sort()).toEqual([...UNTOUCHED].sort());
    expect(receipt.warnings).toEqual([]);
  });

  it('delete 是幂等的；删除后 read ⇒ unknown_source_ref，has ⇒ false', () => {
    const store = new InMemoryDocxBlobStore();
    store.put('gone.docx', enc('bytes'));
    const port = new BlobStoreDocxBytesPort(store);

    store.delete('gone.docx');
    store.delete('gone.docx'); // 幂等，不抛
    expect(store.list()).toEqual([]);
    expect(port.has?.('gone.docx')).toBe(false);
    const caught = capture(() => port.read('gone.docx'));
    expect(caught).toBeInstanceOf(DocxBytesError);
    expect((caught as DocxBytesError).reason).toBe('unknown_source_ref');
  });

  it('InMemoryDocxBytesPort 仍在（本轮不删旧端口）且语义未变', () => {
    const legacy = new InMemoryDocxBytesPort();
    legacy.put('a.docx', enc('hello'));
    expect(Array.from(legacy.read('a.docx'))).toEqual(Array.from(enc('hello')));
    const caught = capture(() => legacy.read('missing.docx'));
    expect((caught as DocxBytesError).reason).toBe('unknown_source_ref');
  });
});

// ===========================================================================
// D. 写路径 —— 有界重试、绝不静默覆盖、非字节拒绝
// ===========================================================================

describe('W-I19 写路径有界拒绝', () => {
  it('版本 CAS 恒冲突 ⇒ write_rejected，且重试次数恰好等于配置上限（不无限循环、不硬覆盖）', () => {
    let casCalls = 0;
    const conflicting: DocxStoragePortLike = {
      readBlob: () => ({ status: 'not-found', bytes: null }),
      compareAndSwap: () => {
        casCalls += 1;
        return { status: 'conflict', cas: { newRevision: 0 } };
      },
    };
    const port = new StoragePortDocxBytesPort(conflicting, { maxWriteAttempts: 3 });

    const caught = capture(() => port.write('content://potbot/x.docx', enc('payload')));
    expect(caught).toBeInstanceOf(DocxBytesError);
    expect((caught as DocxBytesError).reason).toBe('write_rejected');
    expect(casCalls).toBe(3); // 有界，恰好 3 次
  });

  it('写入前读当前版本失败（status=failed）⇒ write_rejected，且从不发起 CAS', () => {
    let casCalls = 0;
    const failedRead: DocxStoragePortLike = {
      readBlob: () => ({ status: 'failed', bytes: null }),
      compareAndSwap: () => {
        casCalls += 1;
        return { status: 'ok', cas: { newRevision: 1 } };
      },
    };
    const caught = capture(() => new StoragePortDocxBytesPort(failedRead).write('content://potbot/x.docx', enc('p')));
    expect((caught as DocxBytesError).reason).toBe('write_rejected');
    expect(casCalls).toBe(0);
  });

  it('对照：正常端口一次 CAS 即写好（首次 attempts 未耗尽）', async () => {
    const storage = new MemoryStoragePort({ now: () => FIXED_NOW });
    const ref = storage.getContentUri({ relativePath: 'artifacts/ok.docx' }).uri;
    const port = new StoragePortDocxBytesPort(storage);
    port.write(ref, enc('v1'));
    expect(storage.readBlob(ref).status).toBe('ok');
    expect(storage.readBlob(ref).revision).toBe(1);
    port.write(ref, enc('v2')); // 覆盖 → revision 2
    expect(storage.readBlob(ref).revision).toBe(2);
  });

  it('非 Uint8Array 的写入在两个适配器上都 ⇒ write_rejected（不落盘半成品）', () => {
    const storage = new MemoryStoragePort({ now: () => FIXED_NOW });
    const port = new StoragePortDocxBytesPort(storage);
    const a = capture(() => port.write('content://potbot/x.docx', 'nope' as unknown as Uint8Array));
    expect((a as DocxBytesError).reason).toBe('write_rejected');

    const store = new InMemoryDocxBlobStore();
    const b = capture(() => new BlobStoreDocxBytesPort(store).write('x', 42 as unknown as Uint8Array));
    expect((b as DocxBytesError).reason).toBe('write_rejected');
    expect(store.list()).toEqual([]); // 半成品没有落进存储
  });
});

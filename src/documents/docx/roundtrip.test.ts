/**
 * DOCX 导入 / 导出 / 保格式往返单测（WCF-D02；design-05-P8；合同 R100–R110、R151、R159–R165）。
 *
 * ## 这份测试要证明的五件事
 *
 * 1. **往返保字节**：导入 → 只改一段的属性 → 导出，**其他部件的解压字节逐字节不变**；
 * 2. **rId 不重排**：含多条关系的包，导出后既有关系 id 与顺序不变；
 * 3. **未知部件保留**：主题 / 设置 / `customXml/` / 核心属性导入导出后仍在且字节一致；
 * 4. **有界拒绝**：超限、重复条目、路径穿越、CRC 错、悬空 rId、`officeDocument` 指错部件，
 *    六种坏包**分别**被拒；
 * 5. **真实 deflate 样本**：样本本身是 `deflateRawSync` 压出来的（真实 Word/WPS 的形态），
 *    不是本仓 `zip.ts` 写出的全 STORE 包——否则"能读真实文件"就成了自说自话。
 *
 * 第 7、8 节（WCF-D41）补的是**导入侧的 id 与不变量**：
 * 6. **规范 id（R101）**：导入产出的**每一个**节点 id 都通过 `isNodeId`（遍历全树，不是抽查），
 *    且形态是路径式（`n/body:0/table:3/row:0/cell:0/paragraph:0`）；两次导入同一份字节 ⇒ 同一批 id；
 *    导入 → 导出 → 再导入 ⇒ id 稳定；
 * 7. **不变量检查真的在跑**：导入路径调用 `validateDocument`——正例（四份语料 + 样本）通过，
 *    反例（空 `w:tr`、同一 `.rels` 内 rId 重号、悬空关系目标）被指认式拒绝。
 *
 * 样本里刻意放了段落级未建模片段（`w:bookmarkStart`）、run 内未建模片段（`w:drawing`）、
 * 合并单元格、页内软换行、命名样式、`../customXml/…` 相对关系目标——用来验证**布局锚点**
 * 与**关系解析**这两处最容易"看起来对了其实错了"的地方。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { crc32 } from '../../artifacts/ooxml/crc32.js';
import { readZip } from '../../artifacts/ooxml/zip-read.js';
import { recheckDocument } from '../model/document.js';
import { DocumentModelError } from '../model/errors.js';
import { isNodeId } from '../model/ids.js';
import type {
  BlockNode,
  DocumentModel,
  ParagraphNode,
  RelationshipRecord,
} from '../model/types.js';
import { validateDocument } from '../model/validation.js';
import { collectNodeIds } from '../model/walk.js';
import { REGISTERED_OVER_STRICT_CHECKS } from './import.js';
import { DocxError, exportDocx, importDocx, parseDocumentPart } from './index.js';

// ---------------------------------------------------------------------------
// 样本构造（DEFLATE，模拟真实 Word/WPS 的包）
// ---------------------------------------------------------------------------

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const PART_PATHS = {
  contentTypes: '[Content_Types].xml',
  rootRels: '_rels/.rels',
  document: 'word/document.xml',
  documentRels: 'word/_rels/document.xml.rels',
  styles: 'word/styles.xml',
  settings: 'word/settings.xml',
  theme: 'word/theme/theme1.xml',
  customXml: 'customXml/item1.xml',
  core: 'docProps/core.xml',
  media: 'word/media/image1.png',
} as const;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

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
  `<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr>` +
  `<w:rPr><w:b/><w:sz w:val="32"/><w:rFonts w:eastAsia="宋体"/></w:rPr></w:style>` +
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

/** 正文：段落属性 + 命名样式 + 段落级未建模片段 + run 内未建模片段 + 表格 + 节。 */
function documentXml(hyperlinkId: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
    `<w:document xmlns:w="${W}" xmlns:r="${R}">` +
    `<w:body>` +
    // ① 标题段：命名样式 + run 格式（粗体、字号、中西文字体）
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>` +
    `<w:r><w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体"/></w:rPr>` +
    `<w:t xml:space="preserve">第一章  雨</w:t></w:r></w:p>` +
    // ② 正文段：居中 + 1.5 倍行距 + 段前 + 首行缩进 2 字 + 段落级未建模片段
    `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:line="360" w:lineRule="auto" w:before="240"/>` +
    `<w:ind w:firstLineChars="200"/></w:pPr>` +
    `<w:r><w:rPr><w:i/></w:rPr><w:t>正文一</w:t></w:r>` +
    `<w:bookmarkStart w:id="0" w:name="bm0"/><w:r><w:t>正文二</w:t></w:r><w:bookmarkEnd w:id="0"/>` +
    `</w:p>` +
    // ③ 软换行段：w:br 是**行内 BreakNode**，不是段落边界
    `<w:p><w:r><w:t>换行前</w:t></w:r><w:r><w:br w:type="page"/></w:r><w:r><w:t>换页后</w:t></w:r></w:p>` +
    // ④ 表格：首行横向合并 2 列
    `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="dxa"/></w:tblPr>` +
    `<w:tblGrid><w:gridCol w:w="2500"/><w:gridCol w:w="2500"/></w:tblGrid>` +
    `<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>合并单元格</w:t></w:r></w:p></w:tc></w:tr>` +
    `<w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc>` +
    `<w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
    // ⑤ 带图与超链接的段：run 内未建模片段 + 引用 rId
    `<w:p><w:r><w:drawing><a:blip r:embed="rId4"/></w:drawing><w:t>带图</w:t></w:r>` +
    `<w:hyperlink r:id="${hyperlinkId}"><w:r><w:t>链接</w:t></w:r></w:hyperlink></w:p>` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:gutter="0"/></w:sectPr>` +
    `</w:body></w:document>`
  );
}

interface BuilderPart {
  readonly path: string;
  readonly data: string | Uint8Array;
  readonly crcOverride?: number;
}

/** 用 DEFLATE 拼一个 DOCX（模拟真实 Word/WPS 的压缩包）。 */
function buildDocx(parts: readonly BuilderPart[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;

  for (const part of parts) {
    const raw =
      typeof part.data === 'string' ? new TextEncoder().encode(part.data) : part.data;
    const name = Buffer.from(part.path, 'latin1');
    const compressed = deflateRawSync(Buffer.from(raw));
    const crc = part.crcOverride ?? crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // DEFLATE
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(raw.byteLength, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    offsets.push(offset);
    locals.push(local, name, compressed);
    offset += local.length + name.length + compressed.byteLength;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const [index, part] of parts.entries()) {
    const raw = typeof part.data === 'string' ? new TextEncoder().encode(part.data) : part.data;
    const name = Buffer.from(part.path, 'latin1');
    const compressed = deflateRawSync(Buffer.from(raw));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(part.crcOverride ?? crc32(raw), 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(raw.byteLength, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offsets[index] as number, 42);
    centrals.push(central, name);
    centralSize += central.length + name.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}

function defaultParts(overrides: Partial<Record<keyof typeof PART_PATHS, BuilderPart>> = {}): BuilderPart[] {
  const parts: BuilderPart[] = [
    { path: PART_PATHS.contentTypes, data: CONTENT_TYPES_XML },
    { path: PART_PATHS.rootRels, data: ROOT_RELS_XML },
    { path: PART_PATHS.document, data: documentXml('rId6') },
    { path: PART_PATHS.documentRels, data: DOCUMENT_RELS_XML },
    { path: PART_PATHS.styles, data: STYLES_XML },
    { path: PART_PATHS.settings, data: SETTINGS_XML },
    { path: PART_PATHS.theme, data: THEME_XML },
    { path: PART_PATHS.customXml, data: CUSTOM_XML },
    { path: PART_PATHS.core, data: CORE_XML },
    { path: PART_PATHS.media, data: PNG_BYTES },
  ];
  for (const [key, part] of Object.entries(overrides)) {
    const index = parts.findIndex((candidate) => candidate.path === PART_PATHS[key as keyof typeof PART_PATHS]);
    if (index === -1 || part === undefined) continue;
    parts[index] = part;
  }
  return parts;
}

function buildSample(): Buffer {
  return buildDocx(defaultParts());
}

/** 从导出的包里取出某个部件的**解压字节**。 */
function partBytes(zipBytes: Uint8Array, path: string): Uint8Array {
  const entry = readZip(zipBytes).by_path.get(path);
  if (entry === undefined) throw new Error(`导出的包里没有 ${path}`);
  return entry.data;
}

function textOf(zipBytes: Uint8Array, path: string): string {
  return new TextDecoder().decode(partBytes(zipBytes, path));
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

// ---------------------------------------------------------------------------
// 1. 导入：结构真的被解析了（不是"读进来一把字节"）
// ---------------------------------------------------------------------------

describe('importDocx — 结构解析', () => {
  const model = importDocx(buildSample());

  it('样本本身是 DEFLATE 包（不是本仓 STORE 写入器的产物）', () => {
    const entry = readZip(buildSample()).by_path.get(PART_PATHS.document);
    expect(entry?.compression_method).toBe(8);
    expect(entry?.compressed_size).toBeLessThan(entry?.uncompressed_size as number);
  });

  it('段落 / run 文本按顺序读出，软换行是行内节点而不是段落边界', () => {
    const kinds = model.blocks.map((block) => block.kind);
    expect(kinds).toEqual(['paragraph', 'paragraph', 'paragraph', 'table', 'paragraph']);

    const first = model.blocks[0] as ParagraphNode;
    expect(first.style_ref).toBe('Heading1');
    expect(first.inlines[0]?.kind).toBe('run');
    expect((first.inlines[0] as { text: string }).text).toBe('第一章  雨');
    // R104：`xml:space="preserve"` 里的两个连续空格**没有被折叠**。
    expect(textOf(buildSample(), PART_PATHS.document)).toContain('第一章  雨');

    const third = model.blocks[2] as ParagraphNode;
    expect(third.inlines.map((inline) => inline.kind)).toEqual(['run', 'break', 'run']);
    expect(third.inlines[1]).toMatchObject({ kind: 'break', breakType: 'page' });
  });

  it('段落属性：对齐、行距、段前、首行缩进字符分别落到各自的字段', () => {
    const second = model.blocks[1] as ParagraphNode;
    expect(second.properties.alignment).toEqual({ state: 'set', value: 'center' });
    expect(second.properties.lineSpacing).toEqual({ state: 'set', value: { kind: 'oneAndHalf' } });
    expect(second.properties.spacingBefore).toEqual({ state: 'set', value: { kind: 'pt', value: 12 } });
    expect(second.properties.indent.firstLine).toEqual({
      state: 'set',
      value: { unit: 'chars', value: 2 },
    });
  });

  it('run 属性：粗体是 on、斜体是 on、字号 16pt、中文字体在 eastAsia 槽位', () => {
    const title = (model.blocks[0] as ParagraphNode).inlines[0];
    expect(title?.kind).toBe('run');
    if (title?.kind !== 'run') return;
    expect(title.properties.bold).toEqual({ state: 'on' });
    expect(title.properties.size).toEqual({ state: 'set', value: { kind: 'pt', value: 16 } });
    expect(title.properties.fonts).toEqual({
      state: 'set',
      value: { ascii: 'Times New Roman', hAnsi: null, eastAsia: '宋体', cs: null },
    });

    const second = (model.blocks[1] as ParagraphNode).inlines[0];
    expect(second?.kind).toBe('run');
    if (second?.kind !== 'run') return;
    expect(second.properties.italic).toEqual({ state: 'on' });
    // 没写 `<w:b/>` ⇒ 未指定（不是"显式关闭"）——R118 要求两者必须能分别产出。
    expect(second.properties.bold).toEqual({ state: 'unspecified' });
  });

  it('表格：网格、行、单元格、横向合并都读出来了', () => {
    const table = model.blocks[3];
    if (table === undefined || table.kind !== 'table') {
      throw new Error('第 4 个块应当是表格');
    }
    expect(table.grid.map((length) => length.value)).toEqual([125, 125]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]?.cells[0]?.grid_span).toBe(2);
    expect(table.rows[1]?.cells).toHaveLength(2);
  });

  it('节属性：纸张与页边距从 w:sectPr 读出（twips → pt）', () => {
    expect(model.sections).toHaveLength(1);
    const size = model.sections[0]?.pageSize;
    expect(size?.state).toBe('set');
    if (size?.state !== 'set') return;
    expect(size.value.width).toEqual({ unit: 'pt', value: 595.3 });
    expect(size.value.height).toEqual({ unit: 'pt', value: 841.9 });
  });

  it('样式表：从 word/styles.xml 读出命名样式（导出仍写回原字节）', () => {
    const heading = model.styles.styles.find((style) => style.style_id === 'Heading1');
    expect(heading?.name).toBe('heading 1');
    expect(heading?.based_on).toBe('Normal');
    expect(heading?.type).toBe('paragraph');
    expect(heading?.run_properties.bold).toEqual({ state: 'on' });
  });

  it('未建模片段进 opaque：段落级 bookmarkStart 与 run 内 drawing 都在', () => {
    const second = model.blocks[1] as ParagraphNode;
    const paragraphOpaque = JSON.stringify(second.opaque);
    expect(paragraphOpaque).toContain('bookmarkStart');
    expect(paragraphOpaque).toContain('bookmarkEnd');

    const last = model.blocks[4] as ParagraphNode;
    const runOpaque = JSON.stringify(last.inlines[0]?.opaque ?? []);
    expect(runOpaque).toContain('drawing');
    // 超链接整段保留（本批不建模 hyperlink 的显示文本）
    expect(JSON.stringify(last.opaque)).toContain('hyperlink');
  });

  it('关系：id、类型、顺序、External 都原样保留', () => {
    const documentRelationships = model.relationships.filter(
      (record) => record.owner_part_path === PART_PATHS.document,
    );
    expect(documentRelationships.map((record) => record.id)).toEqual([
      'rId1', 'rId2', 'rId3', 'rId4', 'rId5', 'rId6',
    ]);
    expect(documentRelationships[4]?.target).toBe('../customXml/item1.xml');
    expect(documentRelationships[5]?.target_mode).toBe('External');
    expect(documentRelationships[5]?.target).toBe('https://example.com/');
  });

  it('媒体部件单独建模，并绑定到指它的那条关系', () => {
    expect(model.media).toHaveLength(1);
    expect(model.media[0]?.path).toBe(PART_PATHS.media);
    expect(model.media[0]?.relationship_id).toBe('rId4');
    expect(model.media[0]?.content_type).toBe('image/png');
    expect(model.media[0]?.bytes).toEqual(PNG_BYTES);
  });

  it('除媒体外的每一个部件都留在 opaque_parts 里（不丢部件）', () => {
    const paths = model.opaque_parts.map((part) => part.path).sort();
    expect(paths).toEqual(
      [
        PART_PATHS.contentTypes,
        PART_PATHS.rootRels,
        PART_PATHS.document,
        PART_PATHS.documentRels,
        PART_PATHS.styles,
        PART_PATHS.settings,
        PART_PATHS.theme,
        PART_PATHS.customXml,
        PART_PATHS.core,
      ].sort(),
    );
  });

  it('内容类型表保留 defaults 与 overrides 及其顺序', () => {
    expect(model.content_types.defaults.map((entry) => entry.extension)).toEqual([
      'rels', 'xml', 'png',
    ]);
    expect(model.content_types.overrides[0]?.part_name).toBe('/word/document.xml');
    expect(model.content_types.overrides).toHaveLength(6);
  });

  it('节点 id 稳定：同一份字节导入两次得到同一组 id', () => {
    const again = importDocx(buildSample());
    const ids = (source: DocumentModel): string[] =>
      source.blocks.map((block) => block.id);
    expect(ids(model)).toEqual(ids(again));
    expect(model.document_id).toBe(again.document_id);
    expect(model.revision).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. 往返保字节（R151）——本批最硬的一条判据
// ---------------------------------------------------------------------------

describe('exportDocx — 往返保字节（R151）', () => {
  const sample = buildSample();
  const model = importDocx(sample);
  const edited = withFirstParagraphRightAligned(model);
  const exported = exportDocx(edited);

  const untouched = [
    PART_PATHS.contentTypes,
    PART_PATHS.rootRels,
    PART_PATHS.documentRels,
    PART_PATHS.styles,
    PART_PATHS.settings,
    PART_PATHS.theme,
    PART_PATHS.customXml,
    PART_PATHS.core,
    PART_PATHS.media,
  ] as const;

  it('只改了一段属性 ⇒ 其他每一个部件的解压字节逐字节不变', () => {
    for (const path of untouched) {
      expect(Array.from(partBytes(exported, path)), `部件 ${path} 应当逐字节不变`).toEqual(
        Array.from(partBytes(sample, path)),
      );
    }
  });

  it('改动的部件确实变了（否则"不变"就没有意义）', () => {
    expect(Array.from(partBytes(exported, PART_PATHS.document))).not.toEqual(
      Array.from(partBytes(sample, PART_PATHS.document)),
    );
  });

  it('改动写进了正文：重新导入导出结果，第一段变成右对齐', () => {
    const reimported = importDocx(exported);
    const first = reimported.blocks[0];
    expect(first?.kind).toBe('paragraph');
    if (first?.kind !== 'paragraph') return;
    expect(first.properties.alignment).toEqual({ state: 'set', value: 'right' });
  });

  it('导入后**原样**导出 ⇒ 整包每一个部件的字节都不变（含主部件）', () => {
    const roundTripped = exportDocx(model);
    for (const path of [PART_PATHS.document, ...untouched]) {
      expect(Array.from(partBytes(roundTripped, path)), `部件 ${path} 应当逐字节不变`).toEqual(
        Array.from(partBytes(sample, path)),
      );
    }
  });

  it('导出是确定性的：同一模型导出两次 ⇒ 同一字节', () => {
    expect(Array.from(exportDocx(model))).toEqual(Array.from(exportDocx(model)));
  });

  it('未建模片段在重建后的正文里仍原样出现（不是"读出来了但写丢了"）', () => {
    const documentText = textOf(exported, PART_PATHS.document);
    expect(documentText).toContain('bookmarkStart');
    expect(documentText).toContain('bookmarkEnd');
    expect(documentText).toContain('drawing');
    expect(documentText).toContain('hyperlink');
    expect(documentText).toContain('r:embed="rId4"');
    expect(documentText).toContain('r:id="rId6"');
    // 命名样式引用写回 pStyle，而不是把样式展开成直接格式（R125）
    expect(documentText).toContain('<w:pStyle w:val="Heading1"/>');
    // 根元素的命名空间声明从原字节带上，未建模片段的前缀才有绑定
    expect(documentText).toContain(`xmlns:w="${W}"`);
    expect(documentText).toContain(`xmlns:r="${R}"`);
  });

  it('表格合并、软换行、首行缩进在重建里保住', () => {
    const documentText = textOf(exported, PART_PATHS.document);
    expect(documentText).toContain('<w:gridSpan w:val="2"/>');
    expect(documentText).toContain('<w:br w:type="page"/>');
    expect(documentText).toContain('w:firstLineChars="200"');
    expect(documentText).toContain('w:line="360"');
  });
});

// ---------------------------------------------------------------------------
// 3. rId 不重排（R106）
// ---------------------------------------------------------------------------

describe('exportDocx — rId 不重排（R106）', () => {
  const sample = buildSample();
  const model = importDocx(sample);

  it('导出后关系部件原样写回，id 与顺序一个不动', () => {
    const exported = exportDocx(withFirstParagraphRightAligned(model));
    const exportedRels = textOf(exported, PART_PATHS.documentRels);
    expect(exportedRels).toBe(textOf(sample, PART_PATHS.documentRels));

    const ids = [...exportedRels.matchAll(/Id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toEqual(['rId1', 'rId2', 'rId3', 'rId4', 'rId5', 'rId6']);
  });

  it('整包级关系同样不重排', () => {
    const exported = exportDocx(withFirstParagraphRightAligned(model));
    expect(textOf(exported, PART_PATHS.rootRels)).toBe(textOf(sample, PART_PATHS.rootRels));
  });
});

// ---------------------------------------------------------------------------
// 4. 未知部件保留（R105）
// ---------------------------------------------------------------------------

describe('exportDocx — 未知部件保留（R105）', () => {
  it('主题 / 设置 / customXml / 核心属性导出后仍在且字节一致', () => {
    const sample = buildSample();
    const exported = exportDocx(withFirstParagraphRightAligned(importDocx(sample)));
    for (const path of [
      PART_PATHS.theme,
      PART_PATHS.settings,
      PART_PATHS.customXml,
      PART_PATHS.core,
      PART_PATHS.styles,
    ] as const) {
      expect(Array.from(partBytes(exported, path))).toEqual(Array.from(partBytes(sample, path)));
    }
    // 内容类型里对它们的声明也还在
    expect(textOf(exported, PART_PATHS.contentTypes)).toContain('/word/theme/theme1.xml');
    expect(textOf(exported, PART_PATHS.contentTypes)).toContain('/customXml/item1.xml');
  });

  it('未被指到的未知部件也不会被丢掉', () => {
    const parts = defaultParts();
    parts.push({ path: 'word/fontTable.xml', data: '<w:fonts/>' });
    // 内容类型里补一条 Default 之外的 Override，才不会让部件"没有 MIME"
    const sample = buildDocx(parts);
    const exported = exportDocx(importDocx(sample));
    expect(Array.from(partBytes(exported, 'word/fontTable.xml'))).toEqual(
      Array.from(partBytes(sample, 'word/fontTable.xml')),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. 有界拒绝与坏包（R159–R162）
// ---------------------------------------------------------------------------

describe('importDocx — 有界拒绝与坏包（R159–R162）', () => {
  it('条目数超限被拒', () => {
    expect(() => importDocx(buildSample(), { limits: { maxEntries: 3 } })).toThrowError(
      /条目数/,
    );
  });

  it('重复条目被拒', () => {
    const parts = defaultParts();
    parts.push({ path: PART_PATHS.document, data: '<?xml version="1.0"?><w:document/>' });
    expect(() => importDocx(buildDocx(parts))).toThrowError(/重复/);
  });

  it('路径穿越被拒', () => {
    const parts = defaultParts();
    parts.push({ path: '../escape.xml', data: '<x/>' });
    expect(() => importDocx(buildDocx(parts))).toThrowError(/路径/);
  });

  it('CRC 不符被拒', () => {
    const parts = defaultParts({
      settings: { path: PART_PATHS.settings, data: SETTINGS_XML, crcOverride: 0x12345678 },
    });
    expect(() => importDocx(buildDocx(parts))).toThrowError(/CRC/);
  });

  it('悬空 rId 被拒（正文引用了关系表里没有的 id）', () => {
    const parts = defaultParts({
      document: { path: PART_PATHS.document, data: documentXml('rId99') },
    });
    try {
      importDocx(buildDocx(parts));
      throw new Error('期望抛出 DocxError');
    } catch (error) {
      expect(error).toBeInstanceOf(DocxError);
      expect((error as DocxError).reason).toBe('dangling_relationship_id');
    }
  });

  it('officeDocument 指向非主部件被拒（R162）', () => {
    const parts = defaultParts({
      rootRels: {
        path: PART_PATHS.rootRels,
        data:
          `<?xml version="1.0"?><Relationships xmlns="${RELS}">` +
          `<Relationship Id="rId1" Type="${OFFICE}/officeDocument" Target="word/styles.xml"/>` +
          `</Relationships>`,
      },
    });
    try {
      importDocx(buildDocx(parts));
      throw new Error('期望抛出 DocxError');
    } catch (error) {
      expect(error).toBeInstanceOf(DocxError);
      expect((error as DocxError).reason).toBe('invalid_main_part_content_type');
    }
  });

  it('内部关系指向不存在的部件被拒', () => {
    const parts = defaultParts({
      documentRels: {
        path: PART_PATHS.documentRels,
        data: DOCUMENT_RELS_XML.replace('Target="settings.xml"', 'Target="missing.xml"'),
      },
    });
    try {
      importDocx(buildDocx(parts));
      throw new Error('期望抛出 DocxError');
    } catch (error) {
      expect(error).toBeInstanceOf(DocxError);
      expect((error as DocxError).reason).toBe('relationship_target_missing');
    }
  });

  it('缺 [Content_Types].xml 被拒', () => {
    const parts = defaultParts().filter((part) => part.path !== PART_PATHS.contentTypes);
    try {
      importDocx(buildDocx(parts));
      throw new Error('期望抛出 DocxError');
    } catch (error) {
      expect((error as DocxError).reason).toBe('missing_content_types');
    }
  });

  it('拒绝时**不产出**半成品：抛错而不是返回一个残缺模型', () => {
    const parts = defaultParts({
      settings: { path: PART_PATHS.settings, data: SETTINGS_XML, crcOverride: 1 },
    });
    let produced: unknown = null;
    try {
      produced = importDocx(buildDocx(parts));
    } catch {
      produced = null;
    }
    expect(produced).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. 导出侧的失败也是显式的
// ---------------------------------------------------------------------------

describe('exportDocx — 显式失败', () => {
  it('模型里没有 officeDocument 关系时导出失败，而不是猜一个路径', () => {
    const model = importDocx(buildSample());
    const broken: DocumentModel = {
      ...model,
      relationships: model.relationships.filter(
        (record) => !record.type.endsWith('/officeDocument'),
      ),
    };
    try {
      exportDocx(broken);
      throw new Error('期望抛出 DocxError');
    } catch (error) {
      expect(error).toBeInstanceOf(DocxError);
      expect((error as DocxError).reason).toBe('export_missing_main_part');
    }
  });

  it('主部件原始字节缺失时导出失败（没有它就无法判断"是否改动"）', () => {
    const model = importDocx(buildSample());
    const broken: DocumentModel = {
      ...model,
      opaque_parts: model.opaque_parts.filter((part) => part.path !== PART_PATHS.document),
    };
    expect(() => exportDocx(broken)).toThrowError(/主部件/);
  });
});

// ---------------------------------------------------------------------------
// 7. 导入侧的 id（R101）：规范形态、确定性、跨往返稳定  —— WCF-D41
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const FIXTURES_DIR = join(REPO_ROOT, 'tests', 'word-acceptance', 'fixtures');

/** `tests/word-acceptance/fixtures/**` 的四份语料（三份 DEFLATE + 一份旧 STORE golden）。 */
const REAL_CORPORA = [
  'corpus-a-independent-deflate.docx',
  'corpus-b-independent-deflate.docx',
  'corpus-c-word16-created.docx',
  'legacy-golden-potbot-store.docx',
] as const;

function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES_DIR, name)));
}

/**
 * **测试自带的**全树遍历（不 import `model/walk.js` 的收集器）。
 *
 * 为什么不用生产的 `collectNodeIds`：要断言的正是"**每一个**节点 id 都规范"，
 * 若遍历本身来自被断言的那套代码，"漏了一层"就会一起漏过去。这里独立走一遍
 * （块 → 行内 / 行 → 单元格 → 单元格内块，递归），再与生产收集器**交叉核对**条数。
 */
function walkAllIds(model: DocumentModel): string[] {
  const ids: string[] = [];
  const visitBlocks = (blocks: readonly BlockNode[]): void => {
    for (const block of blocks) {
      ids.push(block.id);
      if (block.kind === 'paragraph') {
        for (const inline of block.inlines) {
          ids.push(inline.id);
        }
        continue;
      }
      for (const row of block.rows) {
        ids.push(row.id);
        for (const cell of row.cells) {
          ids.push(cell.id);
          visitBlocks(cell.blocks);
        }
      }
    }
  };
  visitBlocks(model.blocks);
  for (const comment of model.comments) {
    ids.push(comment.id);
  }
  return ids;
}

describe('导入的节点 id 全部是规范形态（R101）—— WCF-D41', () => {
  it('路径式 id 形态固定：段落 / 行内 / 表格 / 行 / 单元格 / 单元格内段落逐层可指认', () => {
    const model = importDocx(buildSample());
    // 不写"匹配某个正则"：把**确切**的字符串钉死，形态一变就红。
    expect(model.blocks[0]?.id).toBe('n/body:0/paragraph:0');
    expect((model.blocks[0] as ParagraphNode).inlines[0]?.id).toBe('n/body:0/paragraph:0/run:0');
    // 软换行是段落级行内节点，序号按**行内槽位**算：run0 / break1 / run2
    const third = model.blocks[2] as ParagraphNode;
    expect(third.id).toBe('n/body:0/paragraph:2');
    expect(third.inlines.map((inline) => inline.id)).toEqual([
      'n/body:0/paragraph:2/run:0',
      'n/body:0/paragraph:2/break:1',
      'n/body:0/paragraph:2/run:2',
    ]);
    // 表格在第 4 个块位（下标 3），因此路径段是 table:3——路径段是**分配时刻的出处**，不是"第几张表"
    const table = model.blocks[3];
    if (table === undefined || table.kind !== 'table') throw new Error('第 4 个块应当是表格');
    expect(table.id).toBe('n/body:0/table:3');
    expect(table.rows[0]?.id).toBe('n/body:0/table:3/row:0');
    expect(table.rows[0]?.cells[0]?.id).toBe('n/body:0/table:3/row:0/cell:0');
    const nested = table.rows[0]?.cells[0]?.blocks[0];
    expect(nested?.id).toBe('n/body:0/table:3/row:0/cell:0/paragraph:0');
    expect((nested as ParagraphNode).inlines[0]?.id).toBe(
      'n/body:0/table:3/row:0/cell:0/paragraph:0/run:0',
    );
  });

  it.each(REAL_CORPORA)('真实语料 %s：遍历全树的每一个 id 都通过 isNodeId，且互不重复', (name) => {
    const model = importDocx(readFixture(name));
    const ids = walkAllIds(model);

    expect(ids.length).toBeGreaterThan(0);
    // 逐条断言（不是 `expect(ids.every(...))`——失败时要能指出是哪一个 id）
    for (const id of ids) {
      expect(isNodeId(id), `id ${JSON.stringify(id)} 不是 ids.ts 的规范形态`).toBe(true);
    }
    // id 唯一（重复身份 = 引用必然指错）
    expect(new Set(ids).size).toBe(ids.length);
    // 交叉核对：自写遍历与生产收集器必须看到同一批节点（防"遍历漏了一层"）
    expect(ids).toEqual(collectNodeIds(model));
    // 出处可解析：每个 id 都从 body 路径起（导入的文档正文）
    for (const id of ids) {
      expect(id.startsWith('n/body:0/')).toBe(true);
    }
  });

  it('测试构造的样本：每一个 id 都通过 isNodeId（含表格内部与单元格内）', () => {
    const ids = walkAllIds(importDocx(buildSample()));
    expect(ids).toHaveLength(collectNodeIds(importDocx(buildSample())).length);
    for (const id of ids) {
      expect(isNodeId(id)).toBe(true);
    }
  });

  it('两次导入同一份字节 ⇒ 同一批 id（确定性，R101）', () => {
    const sample = buildSample();
    expect(walkAllIds(importDocx(sample))).toEqual(walkAllIds(importDocx(sample)));
    for (const name of REAL_CORPORA) {
      const bytes = readFixture(name);
      expect(walkAllIds(importDocx(bytes)), `${name} 两次导入应当同 id`).toEqual(
        walkAllIds(importDocx(bytes)),
      );
    }
  });

  it('导入 → 导出 → 再导入 ⇒ id 稳定（R101 的往返口径）', () => {
    const sample = buildSample();
    const first = importDocx(sample);
    const reimported = importDocx(exportDocx(first));
    expect(walkAllIds(reimported)).toEqual(walkAllIds(first));
    // 改了内容、但结构没变：id 依然稳定（id 不随属性变化漂移）
    const edited = importDocx(exportDocx(withFirstParagraphRightAligned(first)));
    expect(walkAllIds(edited)).toEqual(walkAllIds(first));
  });

  it('`parseDocumentPart` 与 `importDocx` 对同一份字节给出同一批 id（导出侧比对基线的前提）', () => {
    const sample = buildSample();
    const model = importDocx(sample);
    const parsed = parseDocumentPart(partBytes(sample, PART_PATHS.document));
    expect(parsed.blocks.map((block) => block.id)).toEqual(model.blocks.map((block) => block.id));
    // 逐层相同（表格内部也一致），否则导出侧"未改动 ⇒ 原字节"会被误判成"改动了"
    expect(walkAllIds({ ...model, blocks: parsed.blocks })).toEqual(walkAllIds(model));
  });
});

// ---------------------------------------------------------------------------
// 8. 不变量检查真的在导入路径上执行（R100/R101/R105/R106/R160）—— WCF-D41
// ---------------------------------------------------------------------------

/**
 * 导入路径上**已登记**的过严检查——**直接取生产侧的同一份清单**（不在这里另抄一份，
 * 免得清单漂移了测试还绿）。
 *
 * `validation.ts` 的 `duplicate_relationship_id` 把**全篇**关系 id 放进一个集合，忽略
 * `owner_part_path`；而 OOXML 的 `Id` 只在**单个 `.rels` 部件内**唯一（真实 Word 文件的
 * 包级 `.rels` 与主部件 `.rels` 各自从 rId1 起编）。`model/**` 对本包只读，不能就地修，
 * 因此导入侧登记式排除该条，并用"同一部件内不得重号"把它收窄回本来的语义（见第 8 节的负例）。
 */
const REGISTERED_OVER_STRICT_IMPORT_CODES = REGISTERED_OVER_STRICT_CHECKS.map((entry) => entry.code);

/** 主部件正文：一个段落 + **没有单元格的表格行**（`<w:tr/>` 不是合法 OOXML 表格行）。 */
const EMPTY_TABLE_ROW_DOCUMENT_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<w:document xmlns:w="${W}"><w:body>` +
  `<w:p><w:r><w:t>正文</w:t></w:r></w:p>` +
  `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2500"/></w:tblGrid><w:tr></w:tr></w:tbl>` +
  `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>` +
  `</w:body></w:document>`;

/**
 * 主部件关系表：**同一个 `.rels` 内** Id 重号（引用歧义，必须拒）。
 *
 * 做法是把 `rId3`(theme) 改成 `rId2`(settings)：正文只引用 `rId4`/`rId6`，
 * 因此不会先被"悬空 rId"拦下——这样才轮得到模型层的重号检查上场。
 */
const DUPLICATE_RID_IN_ONE_PART_RELS_XML = DOCUMENT_RELS_XML.replace('Id="rId3"', 'Id="rId2"');

describe('导入路径真的跑不变量检查 —— WCF-D41', () => {
  it('登记清单被钉住：既不能被悄悄扩大，**且必须保持为空**（模型缺陷已修，排除项已退役）', () => {
    // 2026-10-03：原唯一登记项 `duplicate_relationship_id` 的根因是模型检查忽略了
    // `owner_part_path`；主协调者已在 `model/validation.ts` 就地修好，故排除项退役。
    // 这条断言现在**要求清单为空**——将来若有人想重新开一个"可忽略"的口子，
    // 必须同时改这里并在 PR 里说明理由，不能悄悄加。
    expect(REGISTERED_OVER_STRICT_CHECKS.map((entry) => entry.code)).toEqual([]);
    for (const entry of REGISTERED_OVER_STRICT_CHECKS) {
      expect(entry.why.length, `${entry.code} 未写明理由`).toBeGreaterThan(20);
      expect(entry.compensation.length, `${entry.code} 未写补偿措施`).toBeGreaterThan(10);
    }
  });

  it('正例：四份真实语料 + 测试样本，导入后不变量报告无**未登记**的 error', () => {
    const models: readonly [string, DocumentModel][] = [
      ...REAL_CORPORA.map((name) => [name, importDocx(readFixture(name))] as [string, DocumentModel]),
      ['测试样本', importDocx(buildSample())],
    ];
    for (const [name, model] of models) {
      const report = recheckDocument(model);
      const unregistered = report.errors.filter(
        (problem) => !(REGISTERED_OVER_STRICT_IMPORT_CODES as readonly string[]).includes(problem.code),
      );
      expect(unregistered, `${name} 出现了未登记的 error`).toEqual([]);
    }
  });

  it('正例：不变量报告是"真跑过"的，不是恒 ok（同一份模型，故意弄坏后必须变红）', () => {
    const model = importDocx(buildSample());
    // 样本与真实语料一样是**跨部件**重号（`_rels/.rels` 的 rId1/rId2 与主部件 .rels 的 rId1…rId6），
    // 所以这里同样只能断言"没有**未登记**的 error"——登记项与理由见
    // `import.ts` 的 `REGISTERED_OVER_STRICT_CHECKS`。
    const registered = (code: string): boolean =>
      (REGISTERED_OVER_STRICT_IMPORT_CODES as readonly string[]).includes(code);
    const base = recheckDocument(model);
    expect(base.errors.filter((problem) => !registered(problem.code))).toEqual([]);

    // ① 悬空关系目标，且调用方**声明了**部件范围 ⇒ dangling_relationship_target（真悬空）
    const dangling: DocumentModel = {
      ...model,
      relationships: [
        ...model.relationships,
        {
          id: 'rIdX',
          type: `${OFFICE}/image`,
          target: 'media/missing.png',
          target_mode: 'Internal',
          owner_part_path: PART_PATHS.document,
        } satisfies RelationshipRecord,
      ],
    };
    const declared = validateDocument(dangling, {
      known_part_paths: [...model.opaque_parts.map((part) => part.path), ...model.media.map((part) => part.path)],
      main_document_part_path: PART_PATHS.document,
    });
    expect(declared.errors.map((problem) => problem.code)).toContain('dangling_relationship_target');

    // ② 同一份悬空关系，调用方**没声明**范围 ⇒ package_scope_undeclared（"没查" ≠ "查过了"，R160/R166）
    const undeclared = recheckDocument(dangling);
    expect(undeclared.errors.map((problem) => problem.code)).toContain('package_scope_undeclared');
    expect(undeclared.ok).toBe(false);

    // ③ 节点 id 重复 ⇒ duplicate_id
    const duplicated: DocumentModel = {
      ...model,
      blocks: model.blocks.map((block, index) =>
        index === 1 && block.kind === 'paragraph'
          ? { ...block, id: model.blocks[0]?.id ?? block.id }
          : block,
      ),
    };
    expect(recheckDocument(duplicated).errors.map((problem) => problem.code)).toContain('duplicate_id');
  });

  it('反例：`<w:tr/>`（没有单元格的表格行）被**模型不变量**拦下，不是被 ZIP/包层拦下', () => {
    const parts = defaultParts({
      document: { path: PART_PATHS.document, data: EMPTY_TABLE_ROW_DOCUMENT_XML },
    });

    // 判别力的**正反例**：同一个解析器（`parseDocumentPart`，它**不**跑不变量检查）
    // 读得下这个包，并且如实读出一个"零单元格的行"——说明拒绝**不可能**来自解析/包层，
    // 只可能来自 `validateDocument`。若把不变量检查摘掉，下面的 `importDocx` 就会照常返回模型。
    const parsed = parseDocumentPart(new TextEncoder().encode(EMPTY_TABLE_ROW_DOCUMENT_XML));
    const table = parsed.blocks.find((block) => block.kind === 'table');
    expect(table?.kind).toBe('table');
    if (table?.kind !== 'table') return;
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.cells).toHaveLength(0);

    try {
      importDocx(buildDocx(parts));
      throw new Error('期望抛出 DocumentModelError');
    } catch (error) {
      // 判别关键：拒绝来自**不变量层**（DocumentModelError），而不是 zip/包结构层（DocxError）。
      // 旧的导入路径只做包级检查，这个包**会**被接受；现在它被 `validateDocument` 的
      // `table_shape_invalid` 挡下——这就是"检查真的在跑"的直接证据。
      expect(error).toBeInstanceOf(DocumentModelError);
      expect(error).not.toBeInstanceOf(DocxError);
      expect((error as DocumentModelError).code).toBe('table_shape_invalid');
    }
  });

  it('反例：同一个 `.rels` 内 rId 重号被拒（把登记排除的那条检查收窄回本来的语义）', () => {
    const parts = defaultParts({
      documentRels: { path: PART_PATHS.documentRels, data: DUPLICATE_RID_IN_ONE_PART_RELS_XML },
    });
    try {
      importDocx(buildDocx(parts));
      throw new Error('期望抛出 DocumentModelError');
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentModelError);
      expect((error as DocumentModelError).code).toBe('duplicate_relationship_id');
      expect((error as DocumentModelError).detail).toContain(PART_PATHS.document);
    }
  });

  it('反例：悬空 rId 仍在**包级**被拒（既有能力不回归）', () => {
    const parts = defaultParts({
      document: { path: PART_PATHS.document, data: documentXml('rId99') },
    });
    expect(() => importDocx(buildDocx(parts))).toThrowError(DocxError);
  });

  it('反例：登记排除不是"整条不跑"——跨部件重号放行、跨部件目标悬空仍拒', () => {
    // 跨部件重号（真实 Word 的常态）不被 `duplicate_relationship_id` 误伤：
    // 样本的 `_rels/.rels`（rId1/rId2）与 `word/_rels/document.xml.rels`（rId1…rId6）本来就重号，
    // 它必须能导入（前面所有用例都依赖这一点）。
    const model = importDocx(buildSample());
    const rId1Owners = model.relationships
      .filter((record) => record.id === 'rId1')
      .map((record) => record.owner_part_path ?? '(package)');
    expect(rId1Owners.length).toBeGreaterThan(1);
    // 重号是**跨部件**的（同一个部件内不许重号，那条有单独的负例）
    expect(new Set(rId1Owners).size).toBe(rId1Owners.length);

    // 但"跨部件重号"绝不能被扩大成"关系随便指"：目标不存在的内部关系一律拒（R160）。
    const parts = defaultParts({
      documentRels: {
        path: PART_PATHS.documentRels,
        data: DOCUMENT_RELS_XML.replace('Target="theme/theme1.xml"', 'Target="missing-theme.xml"'),
      },
    });
    expect(() => importDocx(buildDocx(parts))).toThrowError(DocxError);
  });
});

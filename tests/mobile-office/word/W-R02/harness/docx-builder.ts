/**
 * **W-R02 语料工厂**——造真实 DOCX 包（长文 / 多表 / 大图），供规模与恢复场景消费。
 *
 * ## 为什么用仓内 OPC 组装器，而不是手搓 ZIP
 *
 * W-R05 的复核器刻意手搓 ZIP，因为**它验的就是 ZIP/XML 层**（要能对被测实现造反例）。
 * 本包验的是**会话在规模与故障下的行为**，ZIP 层不是被测对象——用仓内既有的
 * `assembleOpcPackage` + `writeZip` 把语料造出来，语料因此是**真的 OPC 包**
 * （有条目定序、内容类型默认项、关系组），而不是"自己人也认得出自己人"的假包。
 * 复核这一包时，被测对象是 `DocumentSession` 与 `docx` 往返，**不是** ZIP 写入器，
 * 所以这里不构成自证循环。
 *
 * ## 确定性
 *
 * 相同的 {@link DocumentProfile} ⇒ **逐字节相同**的包：文本全部由序号派生，
 * 图片字节由确定性伪随机（splitmix 式整数混洗）生成，不读墙钟、不用 `Math.random`。
 *
 * ## 不读密钥、不联网、不碰桌面文件系统
 *
 * 本文件只做纯计算；`node:*` 一个都不 import（`Buffer` 经仓内 `writeZip` 间接使用，
 * 属既有先例）。
 */

import {
  assembleOpcPackage,
  RELATIONSHIPS_CONTENT_TYPE,
  RELATIONSHIPS_EXTENSION,
  relationshipIdAt,
  type OpcPart,
} from '../../../../../src/artifacts/ooxml/opc.js';
import { writeZip } from '../../../../../src/artifacts/ooxml/zip.js';
import { attr, el, serializeXmlDocument, type XmlElement } from '../../../../../src/artifacts/ooxml/xml.js';
import type { DocumentProfile } from './types.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';

const MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const STYLES_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml';
const OFFICE_DOCUMENT_REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const STYLES_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles';
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

const DOCUMENT_PART = 'word/document.xml';
const STYLES_PART = 'word/styles.xml';
const MEDIA_PART = 'word/media/image1.png';

/** 一个段落：`<w:p><w:r><w:t>…</w:t></w:r></w:p>`。 */
function paragraph(text: string): XmlElement {
  return el('w:p', [], [el('w:r', [], [el('w:t', [attr('xml:space', 'preserve')], [text])])]);
}

/** 一张表：`table_rows × table_cols`，每格一个段落，带 `tblGrid` 定列宽。 */
function table(rows: number, cols: number, label: string): XmlElement {
  const gridColumns = Array.from({ length: cols }, () =>
    el('w:gridCol', [attr('w:w', '3000')], []),
  );
  const bodyRows = Array.from({ length: rows }, (_, row) =>
    el(
      'w:tr',
      [],
      Array.from({ length: cols }, (_, col) =>
        el('w:tc', [], [paragraph(`${label}-r${String(row)}c${String(col)}`)]),
      ),
    ),
  );
  return el('w:tbl', [], [el('w:tblGrid', [], gridColumns), ...bodyRows]);
}

/**
 * 一张内联图片（真 `wp:inline` + `a:blip@r:embed`）。
 *
 * 命名空间在 `w:drawing` 上**就地声明**：这样这段 XML 自成一体，
 * 被导入侧当"未建模 run 子元素"原样保留、再导出时不需要外层补命名空间。
 */
function inlineImage(relationshipId: string): XmlElement {
  return el(
    'w:drawing',
    [attr('xmlns:wp', WP_NS), attr('xmlns:a', A_NS), attr('xmlns:pic', PIC_NS)],
    [
      el('wp:inline', [attr('distT', '0'), attr('distB', '0'), attr('distL', '0'), attr('distR', '0')], [
        el('wp:extent', [attr('cx', '914400'), attr('cy', '914400')], []),
        el('a:graphic', [], [
          el('a:graphicData', [attr('uri', PIC_NS)], [
            el('pic:pic', [], [
              el('pic:nvPicPr', [], [
                el('pic:cNvPr', [attr('id', '1'), attr('name', 'image1.png')], []),
                el('pic:cNvPicPr', [], []),
              ]),
              el('pic:blipFill', [], [
                el('a:blip', [attr('r:embed', relationshipId)], []),
                el('a:stretch', [], [el('a:fillRect', [], [])]),
              ]),
              el('pic:spPr', [], [
                el('a:xfrm', [], [
                  el('a:off', [attr('x', '0'), attr('y', '0')], []),
                  el('a:ext', [attr('cx', '914400'), attr('cy', '914400')], []),
                ]),
                el('a:prstGeom', [attr('prst', 'rect')], [el('a:avLst', [], [])]),
              ]),
            ]),
          ]),
        ]),
      ]),
    ],
  );
}

/** 确定性伪随机字节（splitmix64 风格的 32 位整数混洗；不依赖平台 RNG）。 */
export function deterministicBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (state + 0x9e3779b9) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad) >>> 0;
    mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97) >>> 0;
    out[index] = (mixed ^ (mixed >>> 15)) & 0xff;
  }
  // 一张"像 PNG"的头几个字节，便于人工辨认；不影响包结构。
  out[0] = 0x89;
  out[1] = 0x50;
  out[2] = 0x4e;
  out[3] = 0x47;
  return out;
}

/** 造包结果：字节 + 规模事实（供断言复算，不依赖再解析）。 */
export interface BuiltDocx {
  readonly bytes: Uint8Array;
  /** 顶层正文段落数。 */
  readonly paragraph_count: number;
  /** 表格数量。 */
  readonly table_count: number;
  /** 单元格总数（各表 `rows × cols` 之和）。 */
  readonly cell_count: number;
  /** 图片字节数（无图为 0）。 */
  readonly image_byte_length: number;
  /** 正文里放图片的那个段落的**文档级序号**（无图为 `null`）。 */
  readonly image_paragraph_index: number | null;
}

/**
 * 按 profile 造一份 DOCX。
 *
 * 正文顺序 = 段落 → （可选图片段）→ 全部表格。图片段放在正文段落之后、表格之前，
 * 这样"编辑某个正文段落"不会碰到图片段，能验证图片旁边的编辑不损坏图片。
 */
export function buildDocx(profile: DocumentProfile): BuiltDocx {
  assertProfile(profile);
  const imageBytes = profile.with_image ? deterministicBytes(profile.image_bytes, 0x51ed2701) : null;

  const bodyChildren: XmlElement[] = [];
  for (let index = 0; index < profile.paragraphs; index += 1) {
    bodyChildren.push(paragraph(`正文段落 ${String(index)}：这是规模语料的确定性文本。`));
  }
  let imageParagraphIndex: number | null = null;
  if (imageBytes !== null) {
    imageParagraphIndex = bodyChildren.length;
    // 图片与它所在段落的关系 id：document 关系组里 styles 先声明（rId1），图片第二（rId2）。
    bodyChildren.push(
      el('w:p', [], [el('w:r', [], [inlineImage(relationshipIdAt(1))])]),
    );
  }
  for (let index = 0; index < profile.tables; index += 1) {
    bodyChildren.push(table(profile.table_rows, profile.table_cols, `表${String(index)}`));
  }

  const document: XmlElement = el('w:document', [attr('xmlns:w', W_NS), attr('xmlns:r', R_NS)], [
    el('w:body', [], [
      ...bodyChildren,
      el('w:sectPr', [], [
        el('w:pgSz', [attr('w:w', '12240'), attr('w:h', '15840')], []),
      ]),
    ]),
  ]);

  const styles: XmlElement = el('w:styles', [attr('xmlns:w', W_NS)], [
    el('w:docDefaults', [], [
      el('w:rPrDefault', [], [el('w:rPr', [], [])]),
      el('w:pPrDefault', [], [el('w:pPr', [], [])]),
    ]),
    el('w:style', [attr('w:type', 'paragraph'), attr('w:default', '1'), attr('w:styleId', 'Normal')], [
      el('w:name', [attr('w:val', 'Normal')], []),
    ]),
  ]);

  const parts: OpcPart[] = [
    { path: DOCUMENT_PART, content_type: MAIN_CONTENT_TYPE, data: serializeXmlDocument(document) },
    { path: STYLES_PART, content_type: STYLES_CONTENT_TYPE, data: serializeXmlDocument(styles) },
  ];
  if (imageBytes !== null) {
    parts.push({ path: MEDIA_PART, content_type: 'image/png', data: imageBytes });
  }

  const assembled = assembleOpcPackage({
    parts,
    content_type_defaults: [
      { extension: RELATIONSHIPS_EXTENSION, content_type: RELATIONSHIPS_CONTENT_TYPE },
      { extension: 'xml', content_type: 'application/xml' },
      ...(imageBytes === null ? [] : [{ extension: 'png', content_type: 'image/png' }]),
    ],
    relationships: [
      {
        owner_part_path: null,
        declarations: [{ type: OFFICE_DOCUMENT_REL, target: DOCUMENT_PART }],
      },
      {
        owner_part_path: DOCUMENT_PART,
        declarations: [
          { type: STYLES_REL, target: 'styles.xml' },
          ...(imageBytes === null
            ? []
            : [{ type: IMAGE_REL, target: 'media/image1.png' }]),
        ],
      },
    ],
  });

  const bytes = new Uint8Array(writeZip(assembled.entries));
  return Object.freeze({
    bytes,
    paragraph_count: profile.paragraphs + (imageBytes === null ? 0 : 1),
    table_count: profile.tables,
    cell_count: profile.tables * profile.table_rows * profile.table_cols,
    image_byte_length: imageBytes === null ? 0 : imageBytes.byteLength,
    image_paragraph_index: imageParagraphIndex,
  });
}

function assertProfile(profile: DocumentProfile): void {
  const positive = (value: number, name: string): void => {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`DocumentProfile.${name} 必须是正整数，收到 ${String(value)}（零用 with_image 表达）`);
    }
  };
  if (profile.paragraphs < 0 || !Number.isInteger(profile.paragraphs)) {
    throw new Error(`DocumentProfile.paragraphs 必须是非负整数，收到 ${String(profile.paragraphs)}`);
  }
  if (profile.tables > 0) {
    positive(profile.table_rows, 'table_rows');
    positive(profile.table_cols, 'table_cols');
  } else if (profile.tables < 0 || !Number.isInteger(profile.tables)) {
    throw new Error(`DocumentProfile.tables 必须是非负整数，收到 ${String(profile.tables)}`);
  }
  if (profile.with_image) {
    positive(profile.image_bytes, 'image_bytes');
  }
  if (profile.paragraphs === 0 && profile.tables === 0) {
    throw new Error('DocumentProfile 至少要有一个段落或一张表（空文档不是本包的负载）');
  }
}

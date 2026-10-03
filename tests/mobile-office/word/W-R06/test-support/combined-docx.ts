/**
 * **W-R06 组合文档 fixture 构造器**——一份**同时**含引用、批注、公式、图片的 DOCX。
 *
 * ## 为什么要专门造这份 fixture
 *
 * 既有语料是**单一能力**的：`corpus-a` 有图片但无引用/批注/公式；`corpus-d` 有书签/超链接/
 * 域/脚注/批注/公式但无图片；`corpus-e` 有批注/脚注/图片但无公式。没有任何一份**四类齐备**，
 * 于是「四类元素共存时，改一段**是否**波及另一类」这条判据在仓里**无处可验**。本包补的正是它。
 *
 * ## 构造纪律
 *
 * - 文本用 UTF-8 中文，**不含 NUL**（源码新增 NUL 是手机包检查的项）。
 * - ZIP 由本包**自写的 DEFLATE 写出器**（`./zip.ts`）产生，**不**用生产 `writeZip`——
 *   否则「读自己写的东西」不足以说明兼容外部文件。
 * - 部件集合刻意**多于**四类要素本身：`settings` / `theme` / `customXml` / `core` /
 *   `footnotes` / `endnotes` 均为**不透明部件**，用来验证「没建模的东西也没丢」。
 * - 目标段落（可被编辑的纯文本段）与各要素段落**彼此独立**，便于「改一处、证其余不动」。
 */

import { writeZip, type ZipWriteEntry } from './zip.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export const PART = {
  contentTypes: '[Content_Types].xml',
  rootRels: '_rels/.rels',
  document: 'word/document.xml',
  documentRels: 'word/_rels/document.xml.rels',
  styles: 'word/styles.xml',
  settings: 'word/settings.xml',
  theme: 'word/theme/theme1.xml',
  comments: 'word/comments.xml',
  footnotes: 'word/footnotes.xml',
  endnotes: 'word/endnotes.xml',
  core: 'docProps/core.xml',
  customXml: 'customXml/item1.xml',
  media: 'word/media/image1.png',
} as const;

/** 编辑目标段落的**原文**（用例据此断言「旧文本消失、新文本出现」）。 */
export const TARGET_PARAGRAPH_TEXT = '正文段落甲，可被定点改写。';
/** 批注锚定的文字（编辑**其他**段落时必须逐字保留）。 */
export const COMMENTED_TEXT = '被批注的文字';

/** 一张最小 PNG 签名 + 少量字节（往返只关心字节，不关心是否为合法位图）。 */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

const HEADER =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

/** 正文里的图片（`w:drawing` → `a:blip@r:embed=rId11`）。导入侧**不建模** `w:drawing`，
 * 它作为 run 内的未建模片段原样保留——这正是本用例要证的事。 */
const DRAWING_RUN =
  `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
  `<wp:extent cx="914400" cy="914400"/><wp:docPr id="7" name="图片 1" descr="示例图片"/>` +
  `<a:graphic><a:graphicData uri="${PIC}">` +
  `<pic:pic><pic:nvPicPr><pic:cNvPr id="7" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
  `<pic:blipFill><a:blip r:embed="rId11"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
  `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>` +
  `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
  `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

function documentXml(): string {
  return (
    HEADER +
    `<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:m="${M}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}">` +
    `<w:body>` +
    // ① 标题 + 书签（引用）
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>` +
    `<w:bookmarkStart w:id="1" w:name="bm1"/><w:r><w:t>第一章 标题</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>` +
    // ② 超链接（外链 + 内链锚点）
    `<w:p><w:hyperlink r:id="rId20" w:tooltip="外部"><w:r><w:t>外链</w:t></w:r></w:hyperlink>` +
    `<w:hyperlink w:anchor="bm1"><w:r><w:t>内链</w:t></w:r></w:hyperlink></w:p>` +
    // ③ REF 域（引用）
    `<w:p><w:fldSimple w:instr=" REF bm1 \\h " w:dirty="true"><w:r><w:t>第一章 标题</w:t></w:r></w:fldSimple></w:p>` +
    // ④ 编辑目标：一段纯文本正文
    `<w:p><w:r><w:t>${TARGET_PARAGRAPH_TEXT}</w:t></w:r></w:p>` +
    // ⑤ 批注：区间 + 引用 + 注释体（word/comments.xml）
    `<w:p><w:commentRangeStart w:id="1"/><w:r><w:t>${COMMENTED_TEXT}</w:t></w:r>` +
    `<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p>` +
    // ⑥ 行内公式（OMML 分式 1/2）
    `<w:p><w:r><w:t>行内公式：</w:t></w:r>` +
    `<m:oMath><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f></m:oMath></w:p>` +
    // ⑦ 图片（DrawingML 内联图形）
    `<w:p>${DRAWING_RUN}</w:p>` +
    // ⑧ 脚注 + 尾注引用
    `<w:p><w:r><w:t>正文带注：</w:t></w:r>` +
    `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r>` +
    `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:endnoteReference w:id="1"/></w:r></w:p>` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:gutter="0"/>` +
    `<w:cols w:num="1"/></w:sectPr>` +
    `</w:body></w:document>`
  );
}

function documentRelsXml(): string {
  const rel = (id: string, type: string, target: string, mode = ''): string =>
    `<Relationship Id="${id}" Type="${OFFICE}/${type}" Target="${target}"${mode}/>`;
  return (
    HEADER +
    `<Relationships xmlns="${RELS}">` +
    rel('rId10', 'styles', 'styles.xml') +
    rel('rId11', 'image', 'media/image1.png') +
    rel('rId12', 'customXml', '../customXml/item1.xml') +
    rel('rId20', 'hyperlink', 'https://example.com/ref', ' TargetMode="External"') +
    rel('rId22', 'footnotes', 'footnotes.xml') +
    rel('rId23', 'endnotes', 'endnotes.xml') +
    rel('rId24', 'comments', 'comments.xml') +
    `</Relationships>`
  );
}

const ROOT_RELS_XML =
  HEADER +
  `<Relationships xmlns="${RELS}">` +
  `<Relationship Id="rId1" Type="${OFFICE}/officeDocument" Target="word/document.xml"/>` +
  `<Relationship Id="rId2" Type="${OFFICE}/metadata/core-properties" Target="docProps/core.xml"/>` +
  `</Relationships>`;

const CONTENT_TYPES_XML =
  HEADER +
  `<Types xmlns="${CT}">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Default Extension="png" ContentType="image/png"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
  `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>` +
  `<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>` +
  `<Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>` +
  `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
  `</Types>`;

const STYLES_XML =
  HEADER +
  `<w:styles xmlns:w="${W}">` +
  `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
  `</w:styles>`;

const COMMENTS_XML =
  HEADER +
  `<w:comments xmlns:w="${W}">` +
  `<w:comment w:id="1" w:author="审阅者" w:date="2026-10-03T00:00:00Z">` +
  `<w:p><w:r><w:t>这里需要补充来源。</w:t></w:r></w:p></w:comment></w:comments>`;

const FOOTNOTES_XML =
  HEADER +
  `<w:footnotes xmlns:w="${W}">` +
  `<w:footnote w:id="1"><w:p><w:r><w:t>脚注内容。</w:t></w:r></w:p></w:footnote></w:footnotes>`;

const ENDNOTES_XML =
  HEADER +
  `<w:endnotes xmlns:w="${W}">` +
  `<w:endnote w:id="1"><w:p><w:r><w:t>尾注内容。</w:t></w:r></w:p></w:endnote></w:endnotes>`;

const SETTINGS_XML =
  HEADER + `<w:settings xmlns:w="${W}"><w:zoom w:percent="100"/><w:defaultTabStop w:val="420"/></w:settings>`;

const THEME_XML =
  HEADER +
  `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="自定义主题">` +
  `<a:themeElements><a:clrScheme name="potbot"><a:dk1><a:srgbClr val="000000"/></a:dk1></a:clrScheme></a:themeElements></a:theme>`;

const CORE_XML =
  HEADER +
  `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
  `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
  `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
  `<dc:title>组合文档（引用/批注/公式/图片）</dc:title>` +
  `<dc:creator>W-R06 fixture</dc:creator>` +
  `<dcterms:created xsi:type="dcterms:W3CDTF">2026-10-03T00:00:00Z</dcterms:created>` +
  `</cp:coreProperties>`;

const CUSTOM_XML = HEADER + `<root xmlns="urn:potbot:custom-xml"><marker>未建模部件</marker></root>`;

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 组装一份组合 DOCX 的**部件表**（顺序固定 ⇒ 字节确定）。 */
export function combinedDocxParts(): readonly ZipWriteEntry[] {
  return [
    { path: PART.contentTypes, data: utf8(CONTENT_TYPES_XML) },
    { path: PART.rootRels, data: utf8(ROOT_RELS_XML) },
    { path: PART.document, data: utf8(documentXml()) },
    { path: PART.documentRels, data: utf8(documentRelsXml()) },
    { path: PART.styles, data: utf8(STYLES_XML) },
    { path: PART.settings, data: utf8(SETTINGS_XML) },
    { path: PART.theme, data: utf8(THEME_XML) },
    { path: PART.comments, data: utf8(COMMENTS_XML) },
    { path: PART.footnotes, data: utf8(FOOTNOTES_XML) },
    { path: PART.endnotes, data: utf8(ENDNOTES_XML) },
    { path: PART.core, data: utf8(CORE_XML) },
    { path: PART.customXml, data: utf8(CUSTOM_XML) },
    { path: PART.media, data: PNG_BYTES },
  ];
}

/** 组合 DOCX 的字节。 */
export function combinedDocx(): Uint8Array {
  return writeZip(combinedDocxParts());
}

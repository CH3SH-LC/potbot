/**
 * WCF-D34 的 DOCX 夹具（**不是**被测实现的一部分）。
 *
 * 用最小但结构真实的 OOXML 造字节，让 `apps/demo/web/doc-read.js` 在隔离环境里
 * 有确定的输入：
 *   - STORE（method 0）与 DEFLATE（method 8）两种 ZIP 存储方式都覆盖——
 *     本仓自己的 writer 走 STORE，而真实 Word 导出的 DOCX 走 DEFLATE，两条都要能读；
 *   - 段落 / 表格 / 直接格式（`w:b` / `w:jc` / `w:ind`）都能按需拼出来；
 *   - 中文按 UTF-8 编码（`TextEncoder`），路径仍是 ASCII。
 *
 * 纪律：夹具只造**输入**，不复制任何被测逻辑；解析正确性由 `doc-read.test.ts` 断言。
 */

import { deflateRawSync } from 'node:zlib';

export type FixtureBlock =
  | {
      readonly kind: 'paragraph';
      readonly text: string;
      readonly bold?: boolean;
      readonly italic?: boolean;
      readonly alignment?: string;
      readonly firstLineChars?: number;
      /** 多个 run（用来造"选区里格式混合"的段落）。给了它就忽略上面的 text / bold / italic。 */
      readonly runs?: ReadonlyArray<{ readonly text: string; readonly bold?: boolean; readonly italic?: boolean }>;
      /**
       * 段级节属性原文（`w:pPr/w:sectPr` 的内容，**不含外层标签**）。
       * 给了它，这一段的**末尾**就结束一节（R108：多节文档的段级分节）。
       * 内容原样拼进 XML——夹具不解释它，语义由 `doc-read` / 内核决定。
       */
      readonly sectPrXml?: string;
    }
  | { readonly kind: 'table'; readonly rows: ReadonlyArray<ReadonlyArray<{ readonly text: string; readonly bold?: boolean }>> };

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function paragraphXml(block: Extract<FixtureBlock, { kind: 'paragraph' }>): string {
  const pPr: string[] = [];
  if (block.alignment !== undefined) pPr.push(`<w:jc w:val="${escapeXml(block.alignment)}"/>`);
  if (block.firstLineChars !== undefined) {
    pPr.push(`<w:ind w:firstLineChars="${String(block.firstLineChars)}"/>`);
  }
  /* 段级 `w:sectPr` 按 OOXML 的口径排在 `w:pPr` 的**最后**。 */
  if (block.sectPrXml !== undefined) pPr.push(`<w:sectPr>${block.sectPrXml}</w:sectPr>`);
  const runs = block.runs ?? [{ text: block.text, bold: block.bold, italic: block.italic }];
  const runsXml = runs
    .map((run) => {
      const rPr: string[] = [];
      if (run.bold === true) rPr.push('<w:b/>');
      if (run.italic === true) rPr.push('<w:i/>');
      return (
        '<w:r>' +
        (rPr.length > 0 ? `<w:rPr>${rPr.join('')}</w:rPr>` : '') +
        `<w:t xml:space="preserve">${escapeXml(run.text)}</w:t>` +
        '</w:r>'
      );
    })
    .join('');
  return (
    '<w:p>' +
    (pPr.length > 0 ? `<w:pPr>${pPr.join('')}</w:pPr>` : '') +
    runsXml +
    '</w:p>'
  );
}

function tableXml(block: Extract<FixtureBlock, { kind: 'table' }>): string {
  const rows = block.rows
    .map((cells) => {
      const tcs = cells
        .map((cell) => {
          const rPr = cell.bold === true ? '<w:rPr><w:b/></w:rPr>' : '';
          return (
            '<w:tc><w:p><w:r>' + rPr + `<w:t xml:space="preserve">${escapeXml(cell.text)}</w:t>` +
            '</w:r></w:p></w:tc>'
          );
        })
        .join('');
      return `<w:tr>${tcs}</w:tr>`;
    })
    .join('');
  return `<w:tbl>${rows}</w:tbl>`;
}

export interface DocumentXmlOptions {
  /**
   * **body 级** `w:sectPr` 的内容（不含外层标签）。省略 = 空 `<w:sectPr/>`（原行为，逐字不变）。
   * 它在所有段级 `sectPr` 之后 ⇒ 是文档的**最后一节**（与内核 `import.ts` 同序）。
   */
  readonly bodySectPrXml?: string;
}

/** 造一份 `word/document.xml`。 */
export function documentXml(blocks: readonly FixtureBlock[], options: DocumentXmlOptions = {}): string {
  const body = blocks
    .map((block) => (block.kind === 'paragraph' ? paragraphXml(block) : tableXml(block)))
    .join('');
  const trailing = options.bodySectPrXml === undefined
    ? '<w:sectPr/>'
    : `<w:sectPr>${options.bodySectPrXml}</w:sectPr>`;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:document xmlns:w="${W_NS}"><w:body>${body}${trailing}</w:body></w:document>`
  );
}

/* ---------------- 最小 ZIP 写入（STORE / DEFLATE 两种） ---------------- */

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    crc = (CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipInput {
  readonly path: string;
  readonly data: Uint8Array;
  readonly deflate: boolean;
}

function buildZip(inputs: readonly ZipInput[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const input of inputs) {
    const nameBytes = new TextEncoder().encode(input.path);
    const compressed = input.deflate ? new Uint8Array(deflateRawSync(Buffer.from(input.data))) : input.data;
    const method = input.deflate ? 8 : 0;
    const crc = crc32(input.data);

    const local = new Uint8Array(30 + nameBytes.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, method, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0x0021, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, compressed.byteLength, true);
    localView.setUint32(22, input.data.byteLength, true);
    localView.setUint16(26, nameBytes.byteLength, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    chunks.push(local, compressed);

    const entry = new Uint8Array(46 + nameBytes.byteLength);
    const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x02014b50, true);
    entryView.setUint16(4, 20, true);
    entryView.setUint16(6, 20, true);
    entryView.setUint16(8, 0, true);
    entryView.setUint16(10, method, true);
    entryView.setUint16(12, 0, true);
    entryView.setUint16(14, 0x0021, true);
    entryView.setUint32(16, crc, true);
    entryView.setUint32(20, compressed.byteLength, true);
    entryView.setUint32(24, input.data.byteLength, true);
    entryView.setUint16(28, nameBytes.byteLength, true);
    entryView.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    central.push(entry);

    offset += local.byteLength + compressed.byteLength;
  }

  const centralSize = central.reduce((sum, entry) => sum + entry.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, inputs.length, true);
  endView.setUint16(10, inputs.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const all = [...chunks, ...central, end];
  const total = all.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of all) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}

/**
 * 造一份 DOCX 字节。
 * `deflate: true` 用 DEFLATE 存储 `word/document.xml`（模拟真实 Word 的导出），
 * 默认 STORE（模拟本仓自己的 writer）。
 */
export interface DocxPackageOptions {
  readonly deflate?: boolean;
  readonly bodySectPrXml?: string;
}

function docxParts(blocks: readonly FixtureBlock[], options: DocxPackageOptions): readonly ZipInput[] {
  const deflate = options.deflate === true;
  const document = new TextEncoder().encode(
    options.bodySectPrXml === undefined
      ? documentXml(blocks)
      : documentXml(blocks, { bodySectPrXml: options.bodySectPrXml }),
  );
  const contentTypes = new TextEncoder().encode(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  );
  return [
    { path: '[Content_Types].xml', data: contentTypes, deflate: false },
    { path: 'word/document.xml', data: document, deflate },
  ];
}

/** 只求"能预览"的最小包（**没有** `_rels/.rels`）——`doc-read.js` 只认主部件路径。 */
export function buildDocx(
  blocks: readonly FixtureBlock[],
  options: DocxPackageOptions = {},
): Uint8Array {
  return buildZip(docxParts(blocks, options));
}

/**
 * 能被**内核真实导入器**（`importDocx`）接受的最小包：多一个 `_rels/.rels`
 * 指明 officeDocument 关系。WCF-D72 用它把页面的节枚举与 `model.sections` 对拍。
 */
export function buildDocxPackage(
  blocks: readonly FixtureBlock[],
  options: DocxPackageOptions = {},
): Uint8Array {
  const rootRels = new TextEncoder().encode(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  );
  return buildZip([...docxParts(blocks, options), { path: '_rels/.rels', data: rootRels, deflate: false }]);
}

/* ---------------- 多节样张（WCF-D72：节操作入口的输入） ----------------
   节的枚举规则必须与内核 `src/documents/docx/import.ts` 同序：
   段级 `sectPr` 按文档顺序 + body 级 `sectPr` 殿后 ⇒ 三节样张 = 2 个段级 + 1 个 body 级。 */

/** 第 1 节：横向（`w:orient` **显式声明**）+ 四边页边距。 */
export const SECTPR_LANDSCAPE =
  '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>' +
  '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:gutter="0"/>';

/** 第 2 节：纵向（只给宽高，方向靠推断）+ 页码格式 `upperRoman` 从 1 起。 */
export const SECTPR_PORTRAIT_ROMAN =
  '<w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:gutter="0"/>' +
  '<w:pgNumType w:fmt="upperRoman" w:start="1"/>';

/** 第 3 节（body 级）：只给纸张尺寸，**不写页边距也不写页码**（"未指定就是未指定"）。 */
export const SECTPR_PORTRAIT_PLAIN = '<w:pgSz w:w="11906" w:h="16838"/>';

/**
 * 三节样张：段 1 末尾结束第 1 节、段 2 末尾结束第 2 节、body 级 `sectPr` 是第 3 节。
 * 与 `buildDocx(multiSectionBlocks(), { bodySectPrXml: SECTPR_PORTRAIT_PLAIN })` 配套使用。
 */
export function multiSectionBlocks(): readonly FixtureBlock[] {
  return [
    { kind: 'paragraph', text: '第一节的正文（横向）。', sectPrXml: SECTPR_LANDSCAPE },
    { kind: 'paragraph', text: '第二节的正文（纵向、罗马页码）。', sectPrXml: SECTPR_PORTRAIT_ROMAN },
    { kind: 'paragraph', text: '第三节的正文（body 级节属性）。' },
  ];
}

/** 常用样张：三段正文 + 一个 2×2 表格（表格插在第 2 段之后）。 */
export function sampleBlocks(): readonly FixtureBlock[] {
  return [
    { kind: 'paragraph', text: '新生读书会邀请函', bold: true, alignment: 'center' },
    { kind: 'paragraph', text: '亲爱的同学，欢迎你参加本学期的新生读书会。' },
    {
      kind: 'table',
      rows: [
        [{ text: '日期', bold: true }, { text: '周六下午' }],
        [{ text: '地点', bold: true }, { text: '图书馆三楼' }],
      ],
    },
    { kind: 'paragraph', text: '不需要提前准备，带着好奇心来就好。', firstLineChars: 200 },
  ];
}

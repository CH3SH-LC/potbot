/**
 * **X-R04** 的恶意 / 损坏输入语料构造器（测试宿主专属，进不了产品路径）。
 *
 * 为什么自己造 ZIP、而不复用 `src/artifacts/ooxml/zip.ts` 的 `writeZip`：
 * 产品写入器**只写 STORE、且自己就会拒绝重复路径**，而 X-R04 要造的恰恰是
 * "声明值撒谎""多处压缩炸弹""路径穿越""ZIP64 哨兵"这类**产品写不出来的坏包**。
 * 因此本文件用 `node:zlib`（仅测试线程可用，产品写入器不碰）手工拼字节。
 *
 * 语料分三类：
 * 1. **完全合法的**最小 .xlsx（走仓内 `assembleOpcPackage` + `writeZip`）；
 * 2. **结构合法但声明撒谎**的炸弹（`compressedSize` / `uncompressedSize` 覆盖值）；
 * 3. **真的** deflate 炸弹（重复字节真实压缩，头部字段诚实）。
 */

import { deflateRawSync } from 'node:zlib';

import { crc32 } from '../../../../src/artifacts/ooxml/crc32.js';
import {
  RELATIONSHIPS_CONTENT_TYPE,
  assembleOpcPackage,
  type OpcPart,
  type RelationshipGroup,
} from '../../../../src/artifacts/ooxml/index.js';
import { writeZip } from '../../../../src/artifacts/ooxml/zip.js';
import { utf8Bytes } from '../../../../src/artifacts/ooxml/xml.js';
import {
  OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
  SPREADSHEETML_NAMESPACE,
  WORKSHEET_RELATIONSHIP_TYPE,
  XLSX_MAIN_CONTENT_TYPE,
  XLSX_WORKBOOK_PART_PATH,
  XLSX_WORKSHEET_CONTENT_TYPE,
} from '../../../../src/artifacts/templates/xlsx.js';

/** STORE（不压缩）。 */
export const METHOD_STORE = 0;
/** DEFLATE（raw）。 */
export const METHOD_DEFLATE = 8;

export interface FixtureEntry {
  readonly path: string;
  /** **真实**数据。压缩与 CRC 都按它算（除非显式覆盖）。 */
  readonly data: Uint8Array;
  readonly method?: number;
  readonly flags?: number;
  /** 覆盖中央目录 / 本地头里记录的 CRC（造 CRC 不符）。 */
  readonly crcOverride?: number;
  /** 覆盖**记录**的压缩后字节数（造"声明撒谎"）。 */
  readonly compressedSizeOverride?: number;
  /** 覆盖**记录**的解压后字节数（造"声明撒谎"）。 */
  readonly uncompressedSizeOverride?: number;
  /** 覆盖本地头的压缩方法（造"本地头与中央目录不一致"）。 */
  readonly localMethodOverride?: number;
}

function encodeName(path: string, flags: number): Buffer {
  return (flags & 0x0800) !== 0 ? Buffer.from(path, 'utf8') : Buffer.from(path, 'latin1');
}

function storedBytes(entry: FixtureEntry): Buffer {
  const raw = Buffer.from(entry.data);
  return (entry.method ?? METHOD_STORE) === METHOD_DEFLATE ? deflateRawSync(raw) : raw;
}

/**
 * 手工拼一个 ZIP（本地头 + 数据 + 中央目录 + EOCD）。
 *
 * 字段可逐个覆盖，用来造出产品写入器**拒绝写出**的坏包。
 */
export function buildZip(entries: readonly FixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;

  for (const entry of entries) {
    const method = entry.method ?? METHOD_STORE;
    const flags = entry.flags ?? 0;
    const name = encodeName(entry.path, flags);
    const stored = storedBytes(entry);
    const crc = entry.crcOverride ?? crc32(entry.data);
    const compressedSize = entry.compressedSizeOverride ?? stored.byteLength;
    const uncompressedSize = entry.uncompressedSizeOverride ?? entry.data.byteLength;
    const localMethod = entry.localMethodOverride ?? method;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(localMethod, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    offsets.push(offset);
    locals.push(local, name, stored);
    offset += local.byteLength + name.byteLength + stored.byteLength;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const [index, entry] of entries.entries()) {
    const method = entry.method ?? METHOD_STORE;
    const flags = entry.flags ?? 0;
    const name = encodeName(entry.path, flags);
    const stored = storedBytes(entry);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(entry.crcOverride ?? crc32(entry.data), 16);
    central.writeUInt32LE(entry.compressedSizeOverride ?? stored.byteLength, 20);
    central.writeUInt32LE(entry.uncompressedSizeOverride ?? entry.data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offsets[index] ?? 0, 42);
    centrals.push(central, name);
    centralSize += central.byteLength + name.byteLength;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}

/** 文本 → UTF-8 字节。 */
export function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const WORKBOOK_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<workbook xmlns="${SPREADSHEETML_NAMESPACE}" ` +
  `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
  `<sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`;

/** 一张工作表的 XML：单元格 A1 写数字 1（能过 `readWorkbookXlsx` 的最小形状）。 */
export function oneCellWorksheetXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="${SPREADSHEETML_NAMESPACE}"><sheetData>` +
    `<row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`
  );
}

/** 一份**完全合法**的最小 .xlsx 字节（单表 S，A1 = 1）。 */
export function minimalXlsxBytes(): Uint8Array {
  const parts: OpcPart[] = [
    { path: XLSX_WORKBOOK_PART_PATH, content_type: XLSX_MAIN_CONTENT_TYPE, data: WORKBOOK_XML },
    {
      path: 'xl/worksheets/sheet1.xml',
      content_type: XLSX_WORKSHEET_CONTENT_TYPE,
      data: oneCellWorksheetXml(),
    },
  ];
  const relationships: RelationshipGroup[] = [
    {
      owner_part_path: null,
      declarations: [{ type: OFFICE_DOCUMENT_RELATIONSHIP_TYPE, target: XLSX_WORKBOOK_PART_PATH }],
    },
    {
      owner_part_path: XLSX_WORKBOOK_PART_PATH,
      declarations: [{ type: WORKSHEET_RELATIONSHIP_TYPE, target: 'worksheets/sheet1.xml' }],
    },
  ];
  const assembled = assembleOpcPackage({
    parts,
    content_type_defaults: [{ extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE }],
    relationships,
  });
  return writeZip(assembled.entries);
}

/** 一份合法 ZIP，但**没有** `xl/workbook.xml`（"结构上是 OPC 包、内容上不是工作簿"）。 */
export function xlsxWithoutWorkbookBytes(): Uint8Array {
  return buildZip([
    { path: '[Content_Types].xml', data: utf8Bytes('<Types/>') },
    { path: 'xl/worksheets/sheet1.xml', data: utf8Bytes(oneCellWorksheetXml()) },
  ]);
}

/**
 * **真的** deflate 炸弹：`repeatMiB` MiB 的重复字节真实压缩，
 * 头部字段（CRC / 压缩后 / 解压后）全部**诚实**。
 *
 * 返回值里的 `declared` 是这份字节**自称**的解压后大小，供断言压缩比用。
 */
export function realDeflateBomb(repeatMiB: number, path = 'xl/worksheets/sheet1.xml'): {
  readonly bytes: Uint8Array;
  readonly declared_uncompressed: number;
} {
  const raw = Buffer.alloc(repeatMiB * 1024 * 1024, 0x41); // 'A' × N
  const archive = buildZip([{ path, data: raw, method: METHOD_DEFLATE }]);
  return { bytes: archive, declared_uncompressed: raw.byteLength };
}

/**
 * **声明撒谎**的炸弹：数据只有 2 字节，但中央目录**声称**解压后 `declaredMiB` MiB。
 *
 * 这是最难防的一类——攻击者把 `uncompressedSize` 写大、`compressedSize` 写小，
 * 读取器若"相信声明"就会按声明去分配输出缓冲。生产 `readZip` 的口径是
 * **先按声明判闸、再用 `min(声明+1, 上限+1)` 当解压硬顶**，因此既不会 OOM 也不会被骗过。
 */
export function lyingSizeBomb(declaredMiB: number, compressedBytes = 2): {
  readonly bytes: Uint8Array;
  readonly declared_uncompressed: number;
} {
  const declared = declaredMiB * 1024 * 1024;
  const archive = buildZip([
    {
      path: 'xl/worksheets/sheet1.xml',
      data: new Uint8Array([0x41, 0x41]),
      method: METHOD_DEFLATE,
      compressedSizeOverride: compressedBytes,
      uncompressedSizeOverride: declared,
    },
  ]);
  return { bytes: archive, declared_uncompressed: declared };
}

/** 截断：把合法归档砍掉尾部（EOCD 没了）。 */
export function truncate(bytesIn: Uint8Array, keep: number): Uint8Array {
  return bytesIn.slice(0, Math.max(0, bytesIn.length - keep));
}

/** 追加垃圾字节（EOCD 之后多出内容 ⇒ 尾部被追加/污染）。 */
export function appendGarbage(bytesIn: Uint8Array, junk: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytesIn.length + junk.length);
  out.set(bytesIn, 0);
  out.set(junk, bytesIn.length);
  return out;
}

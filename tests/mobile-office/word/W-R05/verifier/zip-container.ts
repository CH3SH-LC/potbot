/**
 * **独立 ZIP 容器解析器**（W-R05）——按 APPNOTE 的**中央目录**口径自行按字节解析，
 * **不复用** `src/artifacts/ooxml/zip-read.ts` 的任何代码。
 *
 * 复核器的价值 = 「另一套实现能否得出同一结论」。若直接 import 被测的 `zip-read`，
 * 那么被测读取器一旦有系统性误解（例如把中央目录偏移读错、或漏检某类条目），
 * 复核也会跟着错——这不叫复核，叫自证。此模块只依赖：
 * - 本目录 `zip-crc32.ts`（同样自研）；
 * - 压缩方法 8（DEFLATE）的解压：**外部注入**（`inflateRaw`），核心本身是纯 TS、零 `node:*`。
 *   注入而非内置，是为了让核心可被任何宿主使用，也便于测试用受控构造器喂数据。
 *
 * 明确不做（本复核器范围外，遇到即显式报错而非猜测）：
 * - ZIP64（`0xFFFFFFFF` 哨兵值）——报 `zip64_unsupported`；
 * - 加密条目（general purpose flag bit 0）——报 `encrypted_entry`；
 * - 数据描述符（bit 3）导致的本地头尺寸为 0——本地头尺寸字段若与中央目录不符，以**中央目录**为准。
 */

import { crc32 } from './zip-crc32.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
/** ZIP 注释字段是 16 位：EOCD 距文件末尾最多 65535 + 22 字节。 */
const MAX_EOCD_SEARCH = 0xffff + EOCD_SIZE;

const FLAG_ENCRYPTED = 0x0001;
const ZIP64_SENTINEL = 0xffffffff;

export type ZipErrorReason =
  /** EOCD / 中央目录 / 本地头对不上（签名、偏移、长度）。 */
  | 'invalid_structure'
  /** 声明的区域超出实际字节数。 */
  | 'truncated'
  /** 压缩方法不是 STORE(0) / DEFLATE(8)。 */
  | 'unsupported_compression'
  /** 出现 ZIP64 哨兵值（本解析器不实现 ZIP64）。 */
  | 'zip64_unsupported'
  /** 条目被加密。 */
  | 'encrypted_entry';

export class ZipStructureError extends Error {
  readonly reason: ZipErrorReason;

  constructor(reason: ZipErrorReason, message: string) {
    super(message);
    this.name = 'ZipStructureError';
    this.reason = reason;
  }
}

/** 解析选项。 */
export interface ZipParseOptions {
  /**
   * DEFLATE（方法 8）条目的解压器。不提供时遇到 DEFLATE 条目即报
   * `unsupported_compression`——**不静默跳过**，避免把「验不了」伪装成「通过」。
   */
  readonly inflateRaw?: (data: Uint8Array) => Uint8Array;
}

/** 一个已解析的 ZIP 条目。 */
export interface ZipEntry {
  /** 条目名（ZIP 里保存的路径，正斜杠分隔，无前导斜杠）。 */
  readonly name: string;
  /** 中央目录记录的 CRC-32。 */
  readonly storedCrc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  /** 0 = STORE，8 = DEFLATE。 */
  readonly method: number;
  readonly flags: number;
  /** 本地头之后的**原始**（可能已压缩）字节。 */
  readonly rawData: Uint8Array;
  /** 解压后的字节（STORE 时与 `rawData` 同一视图）。 */
  readonly content: Uint8Array;
}

export interface ParsedZip {
  readonly entries: readonly ZipEntry[];
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

function findEndOfCentralDirectory(view: DataView, bytes: Uint8Array): number {
  const lowest = Math.max(0, bytes.length - MAX_EOCD_SEARCH);
  for (let offset = bytes.length - EOCD_SIZE; offset >= lowest; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new ZipStructureError('invalid_structure', 'EOCD signature not found');
}

/**
 * 解析一个 ZIP 包的中央目录（并回读每个条目的本地头与数据区）。
 *
 * @throws {ZipStructureError} 结构损坏 / 截断 / 不支持的压缩或加密。
 */
export function parseZip(bytes: Uint8Array, options: ZipParseOptions = {}): ParsedZip {
  if (bytes.length < EOCD_SIZE) {
    throw new ZipStructureError('truncated', `too short for EOCD: ${bytes.length} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view, bytes);

  const totalEntries = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);

  if (centralOffset === ZIP64_SENTINEL || centralSize === ZIP64_SENTINEL) {
    throw new ZipStructureError('zip64_unsupported', 'central directory uses ZIP64 sentinel');
  }
  if (centralOffset + centralSize > bytes.length) {
    throw new ZipStructureError(
      'truncated',
      `central directory [${centralOffset}, ${centralOffset + centralSize}) exceeds ${bytes.length} bytes`,
    );
  }

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + CENTRAL_HEADER_SIZE > bytes.length) {
      throw new ZipStructureError('truncated', `central header #${index} exceeds archive`);
    }
    if (view.getUint32(cursor, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new ZipStructureError('invalid_structure', `bad central signature at #${index}`);
    }

    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const storedCrc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);

    if ((flags & FLAG_ENCRYPTED) !== 0) {
      throw new ZipStructureError('encrypted_entry', 'entry is encrypted');
    }
    if (
      compressedSize === ZIP64_SENTINEL ||
      uncompressedSize === ZIP64_SENTINEL ||
      localOffset === ZIP64_SENTINEL
    ) {
      throw new ZipStructureError('zip64_unsupported', 'entry uses ZIP64 sentinel values');
    }

    const nameStart = cursor + CENTRAL_HEADER_SIZE;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length) {
      throw new ZipStructureError('truncated', 'central entry name exceeds archive');
    }
    const name = utf8(bytes.subarray(nameStart, nameEnd));

    cursor = nameEnd + extraLength + commentLength;

    if (localOffset + LOCAL_HEADER_SIZE > bytes.length) {
      throw new ZipStructureError('truncated', `local header for "${name}" exceeds archive`);
    }
    if (view.getUint32(localOffset, true) !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw new ZipStructureError('invalid_structure', `bad local signature for "${name}"`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + LOCAL_HEADER_SIZE + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) {
      throw new ZipStructureError('truncated', `data for "${name}" exceeds archive`);
    }
    const rawData = bytes.subarray(dataStart, dataEnd);

    let content: Uint8Array;
    if (method === METHOD_STORE) {
      content = rawData;
    } else if (method === METHOD_DEFLATE) {
      if (!options.inflateRaw) {
        throw new ZipStructureError(
          'unsupported_compression',
          `entry "${name}" is DEFLATE but no inflateRaw was provided`,
        );
      }
      content = options.inflateRaw(rawData);
    } else {
      throw new ZipStructureError(
        'unsupported_compression',
        `entry "${name}" uses method ${method}`,
      );
    }

    entries.push({
      name,
      storedCrc,
      compressedSize,
      uncompressedSize,
      method,
      flags,
      rawData,
      content,
    });
  }

  return { entries };
}

/** 便捷：按名字取条目（找不到返回 `undefined`）。 */
export function entryByName(zip: ParsedZip, name: string): ZipEntry | undefined {
  return zip.entries.find((entry) => entry.name === name);
}

/** 便捷：重新校验单个条目的 CRC（独立于解析，供复核器直接引用）。 */
export function entryCrcMatches(entry: ZipEntry): boolean {
  return crc32(entry.content) === entry.storedCrc;
}

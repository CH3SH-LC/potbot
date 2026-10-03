/**
 * **W-R06 自带的独立 ZIP 读写器**（测试侧宿主；零生产代码依赖）。
 *
 * ## 为什么要自写一套
 *
 * 本包的判据是「组合文档往返后**未改部件逐字节不变**」。若拿 `src/artifacts/ooxml/zip-read.ts`
 * 去读产物，就是让被测实现给自己做笔录——部件的边界、CRC 的校验、中央目录的解析全来自同一份
 * 实现，读写两侧共享同一个 bug 时判据会一起失效。因此这里**另写一套**（逐位建表的 CRC-32、
 * 自解析的中央目录、`node:zlib` 的原始 DEFLATE），只用于 **fixture 构造**与**独立读回**。
 *
 * 与生产实现的另一处关键差异：写出用 **DEFLATE**（真实 Word/WPS 的形态），生产写出器是全 STORE。
 * 于是往返测试同时覆盖了「读 DEFLATE 输入 → 写 STORE 输出」这条真实混合路径。
 *
 * ## 独立性边界（不夸大）
 *
 * CRC-32 的多项式与 `node:zlib` 相同；这不构成"独立证明 CRC 算法正确"，只保证**实现路径**独立
 * （逐位建表 vs 仓内查表）。真正被独立核对的是：条目集合、条目字节、路径唯一性、CRC 自洽。
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// CRC-32（逐位建表，独立于仓内实现）
// ---------------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** 标准 CRC-32（IEEE 802.3），返回无符号 32 位数。 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// 写出（DEFLATE，确定性时间戳）
// ---------------------------------------------------------------------------

/** 固定 DOS 时间（1980-01-01 00:00:00）：同一输入 ⇒ 同一字节，便于逐字节比较。 */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

export interface ZipWriteEntry {
  readonly path: string;
  readonly data: Uint8Array;
}

/**
 * 写出一份 ZIP（全 DEFLATE）。输入顺序即目录顺序，无额外重排。
 *
 * @throws {Error} 路径重复 / 路径含反斜杠（会造出消费者读不懂的包）。
 */
export function writeZip(entries: readonly ZipWriteEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    if (seen.has(entry.path)) throw new Error(`duplicate zip entry: ${entry.path}`);
    if (entry.path.includes('\\')) throw new Error(`backslash in zip path: ${entry.path}`);
    seen.add(entry.path);

    const name = encoder.encode(entry.path);
    const crc = crc32(entry.data);
    // `deflateRawSync` 只做 DEFLATE 流（不含 zlib 头），正是 ZIP method 8 需要的。
    const compressed = new Uint8Array(deflateRawSync(Buffer.from(entry.data)));

    const local = new Uint8Array(30 + name.length + compressed.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 8, true); // method = deflate
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compressed.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(compressed, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 8, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressed.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralStart = offset;
  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  ev.setUint16(20, 0, true);

  const total = centralStart + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of locals) {
    out.set(part, cursor);
    cursor += part.length;
  }
  for (const part of centrals) {
    out.set(part, cursor);
    cursor += part.length;
  }
  out.set(eocd, cursor);
  return out;
}

// ---------------------------------------------------------------------------
// 读回（自解析中央目录 + CRC 自校验）
// ---------------------------------------------------------------------------

export interface ZipReadEntry {
  readonly path: string;
  readonly method: number;
  readonly data: Uint8Array;
}

export interface ZipReadResult {
  readonly entries: readonly ZipReadEntry[];
  /** 路径 → 条目（重复路径会在读时被拒）。 */
  readonly by_path: ReadonlyMap<string, ZipReadEntry>;
}

/**
 * 解析一份 ZIP。**只认中央目录**（与生产读取器同一原则：EOCD 是权威）。
 *
 * @throws {Error} 无 EOCD / 中央目录越界 / 重复路径 / 未知压缩方法 / CRC 不符。
 */
export function readZip(bytes: Uint8Array): ZipReadResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  // EOCD 至少 22 字节；注释最长 65535，故从末尾回扫。
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: EOCD not found');

  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const entries: ZipReadEntry[] = [];
  const byPath = new Map<string, ZipReadEntry>();
  const decoder = new TextDecoder();

  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error(`zip: bad central directory signature at ${cursor}`);
    }
    const method = view.getUint16(cursor + 10, true);
    const expectedCrc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const path = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));

    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error(`zip: bad local header for ${path}`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    let data: Uint8Array;
    if (method === 0) {
      data = raw.slice();
    } else if (method === 8) {
      data = new Uint8Array(inflateRawSync(Buffer.from(raw)));
    } else {
      throw new Error(`zip: unsupported method ${method} for ${path}`);
    }

    if (data.length !== uncompressedSize) {
      throw new Error(`zip: size mismatch for ${path}: ${data.length} != ${uncompressedSize}`);
    }
    if (crc32(data) !== expectedCrc) {
      throw new Error(`zip: crc mismatch for ${path}`);
    }
    if (byPath.has(path)) throw new Error(`zip: duplicate entry ${path}`);

    const entry: ZipReadEntry = { path, method, data };
    entries.push(entry);
    byPath.set(path, entry);
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return { entries, by_path: byPath };
}

/** 便捷：取部件文本（UTF-8）；不存在返回 `null`。 */
export function partText(result: ZipReadResult, path: string): string | null {
  const entry = result.by_path.get(path);
  return entry === undefined ? null : new TextDecoder().decode(entry.data);
}

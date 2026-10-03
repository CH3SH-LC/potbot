/**
 * **最小 ZIP 写入器**（W-R05 **测试侧**专用）——全 STORE、无压缩，用于**手工构造**正例与
 * 各类坏包。它刻意与被测的 `src/artifacts/ooxml/zip.ts` 无关，也不被复核器引用：复核器
 * 只吃字节，构造器只负责**造出指定的字节**。
 *
 * 时间戳写死常量 `0`——不读墙钟，保证同一输入构造出**逐字节相同**的包。
 * 可选的 `crcOverrides` / `sizeOverrides` 用于把「CRC 不符」「尺寸不符」做成**受控坏包**，
 * 而不是靠随机破坏字节（受控坏包可复现、可解释）。
 */

import { crc32 } from '../verifier/zip-crc32.js';

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

export interface WriteEntry {
  readonly name: string;
  readonly data: Uint8Array | string;
}

export interface BuildZipOptions {
  /** 为指定条目在**两份头**里都写入这个**故意错误**的 CRC（构造 CRC 坏包）。 */
  readonly crcOverrides?: ReadonlyMap<string, number>;
  /** 为指定条目写入错误的 uncompressed size（构造尺寸坏包）。 */
  readonly sizeOverrides?: ReadonlyMap<string, number>;
  /**
   * 压缩器（注入）。仅当条目名落在 `deflateEntries` 里时使用，压缩方法写 8（DEFLATE）；
   * CRC / uncompressedSize 仍按**原始**字节算（ZIP 口径）。测试侧注入 `node:zlib.deflateRawSync`。
   */
  readonly deflateRaw?: (data: Uint8Array) => Uint8Array;
  /** 需要以 DEFLATE 存储的条目名集合。 */
  readonly deflateEntries?: ReadonlySet<string>;
}

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

/** 构造一个 STORE 型 ZIP 包（确定性；同一入参逐字节相同）。 */
export function buildZip(
  entries: readonly WriteEntry[],
  options: BuildZipOptions = {},
): Uint8Array {
  const prepared = entries.map((entry) => {
    const name = new TextEncoder().encode(entry.name);
    const raw = toBytes(entry.data);
    const deflate = options.deflateEntries?.has(entry.name) === true;
    const stored = deflate ? (options.deflateRaw?.(raw) ?? raw) : raw;
    return {
      name,
      // `data` = 实际写入 ZIP 的字节（可能已压缩）；`rawLength` = 原始长度。
      data: stored,
      crc: options.crcOverrides?.get(entry.name) ?? crc32(raw),
      uncompressedSize: options.sizeOverrides?.get(entry.name) ?? raw.length,
      method: deflate ? 8 : 0,
      localOffset: 0,
    };
  });

  let localSize = 0;
  for (const item of prepared) {
    item.localOffset = localSize;
    localSize += 30 + item.name.length + item.data.length;
  }

  let centralSize = 0;
  for (const item of prepared) {
    centralSize += 46 + item.name.length;
  }

  const total = localSize + centralSize + 22;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let cursor = 0;

  // 本地头 + 数据区。
  for (const item of prepared) {
    view.setUint32(cursor, LOCAL_SIGNATURE, true);
    view.setUint16(cursor + 4, 20, true);
    view.setUint16(cursor + 6, 0, true); // flags
    view.setUint16(cursor + 8, item.method, true); // 0 = STORE，8 = DEFLATE
    view.setUint16(cursor + 10, 0, true); // mod time（写死 0）
    view.setUint16(cursor + 12, 0, true); // mod date（写死 0）
    view.setUint32(cursor + 14, item.crc, true);
    view.setUint32(cursor + 18, item.data.length, true);
    view.setUint32(cursor + 22, item.uncompressedSize, true);
    view.setUint16(cursor + 26, item.name.length, true);
    view.setUint16(cursor + 28, 0, true);
    cursor += 30;
    out.set(item.name, cursor);
    cursor += item.name.length;
    out.set(item.data, cursor);
    cursor += item.data.length;
  }

  const centralOffset = cursor;
  for (const item of prepared) {
    view.setUint32(cursor, CENTRAL_SIGNATURE, true);
    view.setUint16(cursor + 4, 20, true); // version made by
    view.setUint16(cursor + 6, 20, true); // version needed
    view.setUint16(cursor + 8, 0, true);
    view.setUint16(cursor + 10, item.method, true);
    view.setUint16(cursor + 12, 0, true);
    view.setUint16(cursor + 14, 0, true);
    view.setUint32(cursor + 16, item.crc, true);
    view.setUint32(cursor + 20, item.data.length, true);
    view.setUint32(cursor + 24, item.uncompressedSize, true);
    view.setUint16(cursor + 28, item.name.length, true);
    view.setUint16(cursor + 30, 0, true);
    view.setUint16(cursor + 32, 0, true);
    view.setUint16(cursor + 34, 0, true);
    view.setUint16(cursor + 36, 0, true);
    view.setUint32(cursor + 38, 0, true);
    view.setUint32(cursor + 42, item.localOffset, true);
    cursor += 46;
    out.set(item.name, cursor);
    cursor += item.name.length;
  }

  view.setUint32(cursor, EOCD_SIGNATURE, true);
  view.setUint16(cursor + 4, 0, true);
  view.setUint16(cursor + 6, 0, true);
  view.setUint16(cursor + 8, prepared.length, true);
  view.setUint16(cursor + 10, prepared.length, true);
  view.setUint32(cursor + 12, centralSize, true);
  view.setUint32(cursor + 16, centralOffset, true);
  view.setUint16(cursor + 20, 0, true);

  return out;
}

/**
 * 定位某条目**数据区**在包里的字节偏移：扫描本地文件头签名 + 紧随其后的条目名。
 * 这条路径**不经过中央目录**，与复核器的走法是两条独立路线，用于构造「数据被改坏」的包。
 */
export function findLocalDataOffset(zip: Uint8Array, name: string): number {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const nameBytes = new TextEncoder().encode(name);
  for (let cursor = 0; cursor + 30 + nameBytes.length <= zip.length; cursor += 1) {
    if (view.getUint32(cursor, true) !== LOCAL_SIGNATURE) {
      continue;
    }
    const nameLength = view.getUint16(cursor + 26, true);
    const extraLength = view.getUint16(cursor + 28, true);
    if (nameLength !== nameBytes.length) {
      continue;
    }
    let matches = true;
    for (let index = 0; index < nameBytes.length; index += 1) {
      if (zip[cursor + 30 + index] !== nameBytes[index]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return cursor + 30 + nameLength + extraLength;
    }
  }
  throw new Error(`local data offset for "${name}" not found`);
}

/** 返回一个副本：把指定条目的某个数据字节翻转（`^ 0xff`），用于构造内容被破坏的包。 */
export function corruptEntryData(
  zip: Uint8Array,
  name: string,
  offsetWithinData = 0,
): Uint8Array {
  const copy = zip.slice();
  const at = findLocalDataOffset(copy, name) + offsetWithinData;
  copy[at] = (copy[at] ?? 0) ^ 0xff;
  return copy;
}

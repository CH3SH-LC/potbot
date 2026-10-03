/**
 * 有界 ZIP 读取器单测（WCF-D02；合同 R159–R160）。
 *
 * 分四组：
 * 1. **能读**：STORE（`zip.ts` 写的包，读写闭环）与 **DEFLATE**（真实 Word/WPS 的压缩方式）；
 * 2. **有界拒绝**：条目数 / 单条目 / 总量 / 压缩比四条上限各自单独触发；
 * 3. **安全拒绝**：重复路径、`../` 穿越、绝对路径、盘符、反斜杠、目录条目、加密、ZIP64；
 * 4. **完整性拒绝**：CRC 不符、结构损坏、截断、声明尺寸与实际不符。
 *
 * 负例用的 ZIP 由本文件自带的最小构造器产出（`writeZip` 只写 STORE、且它自己就会拒绝重复路径，
 * 因此"坏包"必须手工造）。构造器只在**测试**里用 `node:zlib`——产品写路径仍然不碰它。
 */

import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { crc32 } from './crc32.js';
import { readZip, ZipReadError, resolveZipReadLimits } from './zip-read.js';
import { writeZip } from './zip.js';

// ---------------------------------------------------------------------------
// 最小 ZIP 构造器（只为造出各种"坏包"）
// ---------------------------------------------------------------------------

interface BuiltEntry {
  readonly path: string;
  readonly data: Uint8Array;
  /** 0 = STORE（默认），8 = DEFLATE，其他值用来测"不支持的方法"。 */
  readonly method?: number;
  readonly flags?: number;
  readonly crcOverride?: number;
  readonly compressedSizeOverride?: number;
  readonly uncompressedSizeOverride?: number;
}

function encodeName(path: string, flags: number): Buffer {
  return (flags & 0x0800) !== 0 ? Buffer.from(path, 'utf8') : Buffer.from(path, 'latin1');
}

/** 手工拼一个 ZIP（本地头 + 数据 + 中央目录 + EOCD），字段可控。 */
function buildZip(entries: readonly BuiltEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;

  for (const entry of entries) {
    const method = entry.method ?? 0;
    const flags = entry.flags ?? 0;
    const name = encodeName(entry.path, flags);
    const stored = method === 8 ? deflateRawSync(Buffer.from(entry.data)) : Buffer.from(entry.data);
    const crc = entry.crcOverride ?? crc32(entry.data);
    const compressedSize = entry.compressedSizeOverride ?? stored.byteLength;
    const uncompressedSize = entry.uncompressedSizeOverride ?? entry.data.byteLength;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    offsets.push(offset);
    locals.push(local, name, stored);
    offset += local.length + name.length + stored.byteLength;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const [index, entry] of entries.entries()) {
    const method = entry.method ?? 0;
    const flags = entry.flags ?? 0;
    const name = encodeName(entry.path, flags);
    const stored = method === 8 ? deflateRawSync(Buffer.from(entry.data)) : Buffer.from(entry.data);
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
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 断言抛出的 `ZipReadError` 的 reason。 */
function expectReason(fn: () => unknown, reason: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ZipReadError);
    expect((error as ZipReadError).reason).toBe(reason);
    return;
  }
  throw new Error(`期望抛出 ZipReadError(${reason})，实际没有抛错`);
}

// ---------------------------------------------------------------------------
// 1. 能读
// ---------------------------------------------------------------------------

describe('readZip — 能读', () => {
  it('读回 zip.ts 写的 STORE 包（读写闭环）', () => {
    const archive = writeZip([
      { path: '[Content_Types].xml', data: bytes('<Types/>') },
      { path: 'word/document.xml', data: bytes('<w:document/>') },
    ]);
    const read = readZip(archive);
    expect(read.entries.map((entry) => entry.path)).toEqual([
      '[Content_Types].xml',
      'word/document.xml',
    ]);
    expect(new TextDecoder().decode(read.by_path.get('word/document.xml')?.data)).toBe(
      '<w:document/>',
    );
    expect(read.entries[0]?.compression_method).toBe(0);
  });

  it('读 DEFLATE 压缩的包，并按声明的尺寸与 CRC 校验', () => {
    const payload = '压缩过的正文：'.repeat(64);
    const archive = buildZip([
      { path: 'word/document.xml', data: bytes(payload), method: 8 },
      { path: 'word/styles.xml', data: bytes('<w:styles/>'), method: 8 },
    ]);
    const read = readZip(archive);
    expect(read.by_path.get('word/document.xml')?.compression_method).toBe(8);
    expect(new TextDecoder().decode(read.by_path.get('word/document.xml')?.data)).toBe(payload);
    // 真的压过：压缩后字节数明显小于解压后。
    expect(read.by_path.get('word/document.xml')?.compressed_size).toBeLessThan(
      read.by_path.get('word/document.xml')?.uncompressed_size as number,
    );
    // 口径是**字节**（中文按 UTF-8 多字节计），不是 JS 的 UTF-16 码元数。
    expect(read.total_uncompressed_bytes).toBe(
      bytes(payload).byteLength + bytes('<w:styles/>').byteLength,
    );
  });

  it('读 UTF-8 条目名（bit 11 置位）', () => {
    const archive = buildZip([
      { path: 'word/中文部件.xml', data: bytes('x'), flags: 0x0800 },
    ]);
    expect(readZip(archive).entries[0]?.path).toBe('word/中文部件.xml');
  });

  it('空包（0 条目）可读', () => {
    expect(readZip(buildZip([])).entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. 有界拒绝（R159）
// ---------------------------------------------------------------------------

describe('readZip — 有界拒绝（R159）', () => {
  it('条目数超限被拒', () => {
    const archive = buildZip([
      { path: 'a', data: bytes('1') },
      { path: 'b', data: bytes('2') },
      { path: 'c', data: bytes('3') },
    ]);
    expectReason(() => readZip(archive, { maxEntries: 2 }), 'too_many_entries');
  });

  it('单条目解压后超限被拒', () => {
    const archive = buildZip([{ path: 'big', data: bytes('0123456789') }]);
    expectReason(() => readZip(archive, { maxEntryUncompressedBytes: 4 }), 'entry_limit_exceeded');
  });

  it('全包解压总量超限被拒', () => {
    const archive = buildZip([
      { path: 'a', data: new Uint8Array(10) },
      { path: 'b', data: new Uint8Array(10) },
    ]);
    expectReason(
      () => readZip(archive, { maxEntryUncompressedBytes: 100, maxTotalUncompressedBytes: 15 }),
      'archive_limit_exceeded',
    );
  });

  it('压缩比超限被拒（deflate 炸弹）', () => {
    const bomb = new Uint8Array(200_000); // 全零，压缩后极小
    const archive = buildZip([{ path: 'bomb', data: bomb, method: 8 }]);
    expectReason(
      () =>
        readZip(archive, {
          maxEntryUncompressedBytes: 10_000_000,
          maxTotalUncompressedBytes: 10_000_000,
          maxCompressionRatio: 5,
        }),
      'compression_ratio_exceeded',
    );
  });

  it('归档字节数超限被拒', () => {
    const archive = buildZip([{ path: 'a', data: bytes('hello') }]);
    expectReason(() => readZip(archive, { maxArchiveBytes: 3 }), 'archive_too_large');
  });

  it('默认上限是自洽的（合并覆盖会校验取值范围）', () => {
    const limits = resolveZipReadLimits({ maxEntries: 10 });
    expect(limits.maxEntries).toBe(10);
    expect(limits.maxEntryUncompressedBytes).toBeGreaterThan(10);
    expect(() => resolveZipReadLimits({ maxEntries: -1 })).toThrow(ZipReadError);
    expect(() => resolveZipReadLimits({ maxEntries: 100_000 })).toThrow(ZipReadError);
  });
});

// ---------------------------------------------------------------------------
// 3. 安全拒绝（R160）
// ---------------------------------------------------------------------------

describe('readZip — 安全拒绝（R160）', () => {
  it('路径穿越 `../` 被拒', () => {
    const archive = buildZip([{ path: '../evil.xml', data: bytes('x') }]);
    expectReason(() => readZip(archive), 'invalid_path');
  });

  it('中间段的 `..` 同样被拒', () => {
    const archive = buildZip([{ path: 'word/../../evil.xml', data: bytes('x') }]);
    expectReason(() => readZip(archive), 'invalid_path');
  });

  it('绝对路径被拒', () => {
    const archive = buildZip([{ path: '/etc/passwd', data: bytes('x') }]);
    expectReason(() => readZip(archive), 'invalid_path');
  });

  it('盘符路径被拒', () => {
    const archive = buildZip([{ path: 'C:/windows/evil', data: bytes('x') }]);
    expectReason(() => readZip(archive), 'invalid_path');
  });

  it('反斜杠路径被拒', () => {
    const archive = buildZip([{ path: 'word\\document.xml', data: bytes('x') }]);
    expectReason(() => readZip(archive), 'invalid_path');
  });

  it('目录条目被拒', () => {
    const archive = buildZip([{ path: 'word/', data: bytes('') }]);
    expectReason(() => readZip(archive), 'invalid_path');
  });

  it('重复路径被拒', () => {
    const archive = buildZip([
      { path: 'word/document.xml', data: bytes('first') },
      { path: 'word/document.xml', data: bytes('second') },
    ]);
    expectReason(() => readZip(archive), 'duplicate_path');
  });

  it('加密条目被拒', () => {
    const archive = buildZip([{ path: 'secret', data: bytes('x'), flags: 0x0001 }]);
    expectReason(() => readZip(archive), 'encrypted_entry');
  });

  it('不支持的压缩方法被拒（12 = bzip2）', () => {
    const archive = buildZip([{ path: 'a', data: bytes('x'), method: 12 }]);
    expectReason(() => readZip(archive), 'unsupported_compression');
  });

  it('ZIP64 哨兵值被拒', () => {
    const archive = buildZip([
      { path: 'a', data: bytes('x'), uncompressedSizeOverride: 0xffffffff },
    ]);
    expectReason(() => readZip(archive), 'unsupported_zip64');
  });

  it('非 ASCII 条目名但未置 UTF-8 标志位被拒（不猜代码页）', () => {
    const archive = buildZip([{ path: 'word/中文.xml', data: bytes('x') }]);
    expectReason(() => readZip(archive), 'invalid_path');
  });
});

// ---------------------------------------------------------------------------
// 4. 完整性拒绝
// ---------------------------------------------------------------------------

describe('readZip — 完整性拒绝', () => {
  it('CRC 不符被拒', () => {
    const archive = buildZip([
      { path: 'word/document.xml', data: bytes('real'), crcOverride: 0xdeadbeef },
    ]);
    expectReason(() => readZip(archive), 'crc_mismatch');
  });

  it('截断的归档被拒', () => {
    const archive = buildZip([{ path: 'a', data: bytes('hello') }]);
    expectReason(() => readZip(archive.subarray(0, archive.byteLength - 8)), 'invalid_structure');
  });

  it('不是 ZIP 的字节被拒', () => {
    expectReason(() => readZip(bytes('这不是一个 ZIP 文件，只是一段中文文本。'.repeat(4))), 'invalid_structure');
  });

  it('STORE 条目声明尺寸与实际不符被拒', () => {
    const archive = buildZip([
      { path: 'a', data: bytes('hello'), uncompressedSizeOverride: 99 },
    ]);
    expectReason(() => readZip(archive), 'size_mismatch');
  });

  it('DEFLATE 条目声明尺寸与实际不符被拒', () => {
    const archive = buildZip([
      { path: 'a', data: bytes('hello world hello world'), method: 8, uncompressedSizeOverride: 5 },
    ]);
    // 声明 5 字节但实际解压出 23 字节：解压器被 maxOutputLength 卡在 6 字节 ⇒ size_mismatch。
    expectReason(() => readZip(archive), 'size_mismatch');
  });

  it('DEFLATE 数据损坏被拒（不是静默返回半截）', () => {
    const good = buildZip([{ path: 'a', data: bytes('hello world'), method: 8 }]);
    // 破坏本地头之后的压缩数据。
    const broken = Buffer.from(good);
    broken[30 + 1 + 2] = 0xff;
    broken[30 + 1 + 3] = 0xff;
    expect(() => readZip(broken)).toThrow(ZipReadError);
  });
});

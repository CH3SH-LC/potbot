/**
 * 确定性 ZIP 写入器单测（W-A）。
 *
 * 这个文件里有两类断言，缺一不可：
 * - **golden 摘要向量**：把一组固定部件的输出字节的 sha256 **写死在测试里**。它是"容器字节被钉死"
 *   的合同——任何改动（多一个字节、换个字段、改个常量）都会让它变红，从而必须先被解释。
 * - **结构自洽读回**：用本文件内联的最小 ZIP 解析器逐字段回读本地头/中央目录/EOCD，
 *   断言偏移、长度、CRC、STORE 尺寸、DOS 时间日期、通用位标志、无 extra field。
 *   （解析器就在被测仓里，所以这**不是**独立验证；W-A 另用 Python 3.13 的 `zipfile` 对 golden
 *   向量做过一次外部回读（见下方常量注释），端到端的独立读回由 W-F 负责。）
 *
 * 另有**确定性防线**：换顺序 ⇒ 字节不同、改一个字节 ⇒ 摘要变。这两条用来证明"顺序真的进了字节"，
 * 而不是"看起来有序"。
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { crc32 } from './crc32.js';
import { utf8Bytes } from './xml.js';
import {
  ZIP_CENTRAL_DIRECTORY_SIGNATURE,
  ZIP_DOS_ATTRIBUTES,
  ZIP_DOS_DATE,
  ZIP_DOS_TIME,
  ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE,
  ZIP_GENERAL_PURPOSE_FLAGS,
  ZIP_LOCAL_FILE_HEADER_SIGNATURE,
  ZIP_MAX_ENTRIES,
  ZIP_VERSION_MADE_BY,
  ZIP_VERSION_NEEDED_TO_EXTRACT,
  ZipError,
  writeZip,
  type ZipEntry,
} from './zip.js';

// ---------------------------------------------------------------------------
// 最小 ZIP 解析器（只解析本写入器会产出的形状；用于结构自洽断言）
// ---------------------------------------------------------------------------

interface ParsedEntry {
  readonly path: string;
  readonly localSignature: number;
  readonly versionNeeded: number;
  readonly versionMadeBy: number;
  readonly flags: number;
  readonly method: number;
  readonly dosTime: number;
  readonly dosDate: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly extraLength: number;
  readonly commentLength: number;
  readonly internalAttributes: number;
  readonly externalAttributes: number;
  readonly localHeaderOffset: number;
  readonly data: Uint8Array;
}

interface ParsedZip {
  readonly entries: readonly ParsedEntry[];
  readonly totalEntries: number;
  readonly diskEntries: number;
  readonly centralDirectoryOffset: number;
  readonly centralDirectorySize: number;
  readonly eocdOffset: number;
  readonly eocdLength: number;
  readonly commentLength: number;
  readonly diskNumber: number;
  readonly centralDirectoryDisk: number;
}

function parseZip(bytes: Uint8Array): ParsedZip {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readText = (start: number, length: number): string =>
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, start + length));

  const eocdOffset = bytes.length - 22;
  const eocdSignature = view.getUint32(eocdOffset, true);
  if (eocdSignature !== ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
    throw new Error(`EOCD 签名不在文件末尾：0x${eocdSignature.toString(16)}`);
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const diskEntries = view.getUint16(eocdOffset + 8, true);
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);

  const entries: ParsedEntry[] = [];
  let cursor = centralDirectoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    const signature = view.getUint32(cursor, true);
    if (signature !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`中央目录项 ${index} 签名错误：0x${signature.toString(16)}`);
    }
    const versionMadeBy = view.getUint16(cursor + 4, true);
    const versionNeeded = view.getUint16(cursor + 6, true);
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const dosTime = view.getUint16(cursor + 12, true);
    const dosDate = view.getUint16(cursor + 14, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const diskNumberStart = view.getUint16(cursor + 34, true);
    const internalAttributes = view.getUint16(cursor + 36, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const path = readText(cursor + 46, nameLength);

    const localSignature = view.getUint32(localHeaderOffset, true);
    const localVersionNeeded = view.getUint16(localHeaderOffset + 4, true);
    const localFlags = view.getUint16(localHeaderOffset + 6, true);
    const localMethod = view.getUint16(localHeaderOffset + 8, true);
    const localTime = view.getUint16(localHeaderOffset + 10, true);
    const localDate = view.getUint16(localHeaderOffset + 12, true);
    const localCrc = view.getUint32(localHeaderOffset + 14, true);
    const localCompressed = view.getUint32(localHeaderOffset + 18, true);
    const localUncompressed = view.getUint32(localHeaderOffset + 22, true);
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);

    if (
      localVersionNeeded !== versionNeeded ||
      localFlags !== flags ||
      localMethod !== method ||
      localTime !== dosTime ||
      localDate !== dosDate ||
      localCrc !== crc ||
      localCompressed !== compressedSize ||
      localUncompressed !== uncompressedSize ||
      localNameLength !== nameLength ||
      localExtraLength !== extraLength
    ) {
      throw new Error(`中央目录与本地头不一致：${path}`);
    }
    if (diskNumberStart !== 0) throw new Error(`disk number start 非 0：${path}`);

    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    entries.push({
      path,
      localSignature,
      versionNeeded,
      versionMadeBy,
      flags,
      method,
      dosTime,
      dosDate,
      crc,
      compressedSize,
      uncompressedSize,
      extraLength,
      commentLength,
      internalAttributes,
      externalAttributes,
      localHeaderOffset,
      data: bytes.subarray(dataStart, dataStart + compressedSize),
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  if (cursor - centralDirectoryOffset !== centralDirectorySize) {
    throw new Error('中央目录长度与 EOCD 声明不一致');
  }

  return {
    entries,
    totalEntries,
    diskEntries,
    centralDirectoryOffset,
    centralDirectorySize,
    eocdOffset,
    eocdLength: 22,
    commentLength: view.getUint16(eocdOffset + 20, true),
    diskNumber: view.getUint16(eocdOffset + 4, true),
    centralDirectoryDisk: view.getUint16(eocdOffset + 6, true),
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// golden 部件清单（含中文文本与空文件）
// ---------------------------------------------------------------------------

const GOLDEN_ENTRIES: readonly ZipEntry[] = [
  {
    path: 'docProps/core.xml',
    data: utf8Bytes(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties>中文标题</cp:coreProperties>',
    ),
  },
  { path: 'word/document.xml', data: utf8Bytes('<w:document/>') },
  { path: 'word/media/empty.bin', data: new Uint8Array(0) },
];

/**
 * 容器字节合同：`writeZip(GOLDEN_ENTRIES)` 的 sha256。
 * 任何一处字节改动都会让本常量失配——失配是**信号**，不是噪音：先解释为什么变，再决定是否更新。
 *
 * 取值来源（2026-10-02，本机）：对本写入器的实际输出取 sha256，并已用 **Python 3.13.13 的
 * `zipfile` 独立读回**交叉核对（`testzip()` 返回 `None`、逐字段回读一致、字节数 478 一致）。
 */
const GOLDEN_ZIP_SHA256 =
  '698b1dd190aa3b25c9767eb5f815402640ab66f2653012a2f188aa695efdc05e';

/** golden 归档的总字节数（Python 侧独立回读同为 478）。 */
const GOLDEN_ZIP_LENGTH = 478;

/** golden 各条目 CRC（Python `zipfile` 回读值：`0x458281ab` / `0x0d865add` / `0x00000000`）。 */
const GOLDEN_ENTRY_CRC: ReadonlyMap<string, number> = new Map([
  ['docProps/core.xml', 0x458281ab],
  ['word/document.xml', 0x0d865add],
  ['word/media/empty.bin', 0x00000000],
]);

describe('writeZip —— 结构自洽', () => {
  const bytes = writeZip(GOLDEN_ENTRIES);
  const parsed = parseZip(bytes);

  it('EOCD 字段正确且位于文件末尾', () => {
    expect(parsed.totalEntries).toBe(GOLDEN_ENTRIES.length);
    expect(parsed.diskEntries).toBe(GOLDEN_ENTRIES.length);
    expect(parsed.diskNumber).toBe(0);
    expect(parsed.centralDirectoryDisk).toBe(0);
    expect(parsed.commentLength).toBe(0);
    expect(parsed.eocdOffset + parsed.eocdLength).toBe(bytes.length);
    expect(parsed.centralDirectoryOffset + parsed.centralDirectorySize).toBe(parsed.eocdOffset);
  });

  it('本地头/中央目录顺序 = 输入数组顺序，偏移首尾相接', () => {
    expect(parsed.entries.map((entry) => entry.path)).toEqual(
      GOLDEN_ENTRIES.map((entry) => entry.path),
    );

    let expectedOffset = 0;
    for (const entry of parsed.entries) {
      expect(entry.localHeaderOffset).toBe(expectedOffset);
      const nameLength = new TextEncoder().encode(entry.path).length;
      expectedOffset += 30 + nameLength + entry.uncompressedSize;
    }
    expect(parsed.centralDirectoryOffset).toBe(expectedOffset);
  });

  it('每个条目：STORE、尺寸相等、CRC 与原始字节一致、数据原样', () => {
    for (const entry of parsed.entries) {
      const source = GOLDEN_ENTRIES.find((candidate) => candidate.path === entry.path) as ZipEntry;
      expect(entry.method).toBe(0);
      expect(entry.compressedSize).toBe(entry.uncompressedSize);
      expect(entry.uncompressedSize).toBe(source.data.byteLength);
      expect(entry.crc).toBe(crc32(source.data));
      expect(Array.from(entry.data)).toEqual(Array.from(source.data));
      if (entry.uncompressedSize === 0) expect(entry.crc).toBe(0x00000000);
    }
  });

  it('时间/日期/标志/版本/属性都是钉死的常量，无 extra field / 注释', () => {
    for (const entry of parsed.entries) {
      expect(entry.localSignature).toBe(ZIP_LOCAL_FILE_HEADER_SIGNATURE);
      expect(entry.versionMadeBy).toBe(ZIP_VERSION_MADE_BY);
      expect(entry.versionNeeded).toBe(ZIP_VERSION_NEEDED_TO_EXTRACT);
      expect(entry.versionNeeded).toBe(20);
      expect(entry.flags).toBe(ZIP_GENERAL_PURPOSE_FLAGS);
      expect(entry.flags & 0x0008).toBe(0); // 无数据描述符
      expect(entry.flags & 0x0800).toBe(0); // 无 UTF-8 标志
      expect(entry.dosTime).toBe(ZIP_DOS_TIME);
      expect(entry.dosDate).toBe(ZIP_DOS_DATE);
      expect(entry.dosTime).toBe(0x0000);
      expect(entry.dosDate).toBe(0x0021);
      expect(entry.extraLength).toBe(0);
      expect(entry.commentLength).toBe(0);
      expect(entry.internalAttributes).toBe(ZIP_DOS_ATTRIBUTES);
      expect(entry.externalAttributes).toBe(0);
    }
  });
});

describe('writeZip —— golden 摘要向量与确定性防线', () => {
  it('golden：固定部件清单 ⇒ 钉死的 sha256、长度与各条目 CRC', () => {
    const bytes = writeZip(GOLDEN_ENTRIES);
    expect(sha256(bytes)).toBe(GOLDEN_ZIP_SHA256);
    expect(bytes.length).toBe(GOLDEN_ZIP_LENGTH);
    for (const entry of parseZip(bytes).entries) {
      expect(entry.crc).toBe(GOLDEN_ENTRY_CRC.get(entry.path));
    }
  });

  it('同输入连跑两次字节完全相等', () => {
    const first = writeZip(GOLDEN_ENTRIES);
    const second = writeZip(GOLDEN_ENTRIES);
    expect(Buffer.compare(first, second)).toBe(0);
    expect(sha256(first)).toBe(sha256(second));
  });

  it('换一个声明顺序 ⇒ 字节不同（顺序真的进了字节）', () => {
    const swapped = [GOLDEN_ENTRIES[1] as ZipEntry, GOLDEN_ENTRIES[0] as ZipEntry, GOLDEN_ENTRIES[2] as ZipEntry];
    const reordered = writeZip(swapped);
    expect(sha256(reordered)).not.toBe(GOLDEN_ZIP_SHA256);
    expect(parseZip(reordered).entries.map((entry) => entry.path)).toEqual([
      'word/document.xml',
      'docProps/core.xml',
      'word/media/empty.bin',
    ]);
  });

  it('改一个字节内容 ⇒ 摘要变', () => {
    const mutated = writeZip([
      GOLDEN_ENTRIES[0] as ZipEntry,
      { path: 'word/document.xml', data: utf8Bytes('<w:document />') },
      GOLDEN_ENTRIES[2] as ZipEntry,
    ]);
    expect(sha256(mutated)).not.toBe(GOLDEN_ZIP_SHA256);
    expect(mutated.length).toBe(writeZip(GOLDEN_ENTRIES).length + 1);
  });

  it('空归档是合法的 22 字节 EOCD', () => {
    const empty = writeZip([]);
    expect(empty.length).toBe(22);
    const parsed = parseZip(empty);
    expect(parsed.totalEntries).toBe(0);
    expect(parsed.centralDirectoryOffset).toBe(0);
    expect(parsed.centralDirectorySize).toBe(0);
  });
});

describe('writeZip —— 超限与非法输入显式抛错（不静默降级）', () => {
  it('条目数超过 65535 ⇒ 抛 too_many_entries（不写 ZIP64）', () => {
    const tooMany = Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, index) => ({
      path: `f${index}.txt`,
      data: new Uint8Array(0),
    }));
    expect(tooMany.length).toBe(65536);
    expect(() => writeZip(tooMany)).toThrowError(ZipError);
    try {
      writeZip(tooMany);
      expect.unreachable('应当抛错');
    } catch (error) {
      expect((error as ZipError).reason).toBe('too_many_entries');
    }
  });

  it('单条目超过 4 GiB ⇒ 抛 entry_too_large', () => {
    const oversized = new Uint8Array(1);
    Object.defineProperty(oversized, 'byteLength', { value: 0x1_0000_0000 });
    try {
      writeZip([{ path: 'big.bin', data: oversized }]);
      expect.unreachable('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ZipError);
      expect((error as ZipError).reason).toBe('entry_too_large');
    }
  });

  it('非法路径 ⇒ 抛 invalid_path', () => {
    const cases = ['/leading.xml', 'back\\slash.xml', '中文.xml', 'a//b.xml', 'a/./b.xml', 'a/../b.xml', ''];
    for (const path of cases) {
      try {
        writeZip([{ path, data: utf8Bytes('x') }]);
        expect.unreachable(`路径应被拒绝：${JSON.stringify(path)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(ZipError);
        expect((error as ZipError).reason).toBe('invalid_path');
      }
    }
  });

  it('路径重复 ⇒ 抛 duplicate_path', () => {
    try {
      writeZip([
        { path: 'a.xml', data: utf8Bytes('1') },
        { path: 'a.xml', data: utf8Bytes('2') },
      ]);
      expect.unreachable('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ZipError);
      expect((error as ZipError).reason).toBe('duplicate_path');
    }
  });
});

/**
 * 确定性 ZIP 写入器（归属 W-A）——**只写 STORE，逐字节可复现**。
 *
 * ## 设计约束（每条都是为了让"同一输入 ⇒ 同一字节"，不是风格偏好）
 * - **全 STORE（压缩方法 = 0）**：`compressed_size === uncompressed_size === CRC 的输入长度`。
 *   不 import `node:zlib`：deflate 的输出字节随 zlib 版本漂移，本机复现不等于跨机器复现。
 *   OOXML 的 DOCX/XLSX/PPTX 允许全 STORE（体积换确定性，这是 design-02 批次 A 的既定取舍）。
 * - **通用位标志 = 0**：不设 bit 3（数据描述符）、不设 bit 11（UTF-8 标志）。路径按 ASCII 校验，
 *   因此不需要 UTF-8 标志；尺寸/CRC 在写本地头时就已算好，因此不需要数据描述符。
 * - **DOS 时间/日期是常量**：时间 `0x0000`、日期 `0x0021`（= 1980-01-01）。
 *   本模块**结构上不接受任何时间参数**——这正是用来防"顺手取墙钟"的设计：
 *   没有入口可以传时间，也就不可能写出随运行时刻变化的字节。
 * - **`version made by` 是常量**：`20`（高字节 0 = MS-DOS/FAT 宿主，低字节 20 = 2.0），
 *   **不由 `process.platform` 推导**。跨平台运行同一输入 → 同一字节。
 * - **无 extra field、无注释、无 ZIP64、无目录条目**；内部/外部属性 = 0。
 * - **没有隐式顺序**：输入是**有序数组**，数组顺序即本地头/中央目录的字节顺序。
 *   本模块不读对象键、不遍历 Map、不排序路径。
 *
 * ## 明确会抛错的情形（不静默降级）
 * 条目数 > 65535、单条目 > 4 GiB、任一本地头偏移/中央目录偏移超出 32 位、路径非法、
 * 路径重复。超限时**抛 `ZipError`**，绝不"自动改 ZIP64"或截断。
 *
 * 纯函数：零 IO、零外部依赖、不读时钟、不读环境变量。返回值为 `Buffer`（`Uint8Array` 子类）。
 */

import { crc32 } from './crc32.js';

/** 本地文件头签名 `PK\x03\x04`。 */
export const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
/** 中央目录项签名 `PK\x01\x02`。 */
export const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
/** 中央目录结束记录签名 `PK\x05\x06`。 */
export const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

/** 解压所需版本 = 2.0。 */
export const ZIP_VERSION_NEEDED_TO_EXTRACT = 20;
/** 写入方版本：常量 `20`（宿主 0 = MS-DOS/FAT），**不由 `process.platform` 推导**。 */
export const ZIP_VERSION_MADE_BY = 20;
/** 压缩方法 0 = STORE。 */
export const ZIP_COMPRESSION_METHOD_STORE = 0;
/** 通用位标志恒为 0（无数据描述符、无 UTF-8 标志、无加密）。 */
export const ZIP_GENERAL_PURPOSE_FLAGS = 0;
/** DOS 时间字段常量 `0x0000`（00:00:00）。 */
export const ZIP_DOS_TIME = 0x0000;
/** DOS 日期字段常量 `0x0021`（1980-01-01）。 */
export const ZIP_DOS_DATE = 0x0021;
/** DOS 属性 = 0。 */
export const ZIP_DOS_ATTRIBUTES = 0x0000;

/** 条目数上限（经典 ZIP 字段宽度）。 */
export const ZIP_MAX_ENTRIES = 0xffff;
/** 32 位字段上限：单条目大小与所有偏移都必须 ≤ 它。 */
export const ZIP_MAX_UINT32 = 0xffffffff;
/** 文件名单字段上限。 */
export const ZIP_MAX_NAME_BYTES = 0xffff;

const LOCAL_FILE_HEADER_SIZE = 30;
const CENTRAL_DIRECTORY_HEADER_SIZE = 46;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;

export type ZipErrorReason =
  | 'too_many_entries'
  | 'entry_too_large'
  | 'archive_too_large'
  | 'invalid_path'
  | 'duplicate_path';

export class ZipError extends Error {
  readonly reason: ZipErrorReason;

  constructor(reason: ZipErrorReason, message: string) {
    super(message);
    this.name = 'ZipError';
    this.reason = reason;
  }
}

/** 一个待写入条目：路径（ZIP 内部名）+ 原始字节。 */
export interface ZipEntry {
  /** ZIP 内部路径：正斜杠分隔、无前导斜杠、可打印 ASCII。 */
  readonly path: string;
  /** 原始字节（STORE ⇒ 原样写出）。 */
  readonly data: Uint8Array;
}

/** 可打印 ASCII（`0x20`–`0x7E`）。 */
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/** 路径校验：正斜杠、无前导斜杠、可打印 ASCII、无空段/`.`/`..` 段。 */
export function assertZipEntryPath(path: string): void {
  if (!PRINTABLE_ASCII.test(path)) {
    throw new ZipError(
      'invalid_path',
      `ZIP 条目路径必须是可打印 ASCII（不可含中文、控制字符或反斜杠）：${JSON.stringify(path)}`,
    );
  }
  if (path.startsWith('/')) {
    throw new ZipError('invalid_path', `ZIP 条目路径不得有前导斜杠：${JSON.stringify(path)}`);
  }
  if (path.includes('\\')) {
    throw new ZipError(
      'invalid_path',
      `ZIP 条目路径只能用正斜杠（反斜杠是 Windows 遗留分隔符，ZIP 规范要求正斜杠）：${JSON.stringify(path)}`,
    );
  }
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new ZipError(
        'invalid_path',
        `ZIP 条目路径含非法路径段（空段 / "." / ".."）：${JSON.stringify(path)}`,
      );
    }
  }
}

interface PreparedEntry {
  readonly path: string;
  readonly nameBytes: Buffer;
  readonly data: Uint8Array;
  readonly size: number;
  readonly crc: number;
  readonly localHeaderOffset: number;
}

/**
 * 写出 ZIP。**数组顺序 = 字节顺序**。
 *
 * @throws {ZipError} 条目数超限 / 单条目超 4 GiB / 偏移超 32 位 / 路径非法或重复。
 */
export function writeZip(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > ZIP_MAX_ENTRIES) {
    throw new ZipError(
      'too_many_entries',
      `条目数 ${entries.length} 超过上限 ${ZIP_MAX_ENTRIES}（不写 ZIP64，不静默截断）`,
    );
  }

  // —— 第一遍：校验 + 预算偏移。先算完再拷贝字节，这样"超 4 GiB"在分配任何大缓冲之前就抛错。
  const seenPaths = new Set<string>();
  const prepared: PreparedEntry[] = [];
  let offset = 0;

  for (const entry of entries) {
    assertZipEntryPath(entry.path);
    if (seenPaths.has(entry.path)) {
      throw new ZipError('duplicate_path', `ZIP 条目路径重复：${JSON.stringify(entry.path)}`);
    }
    seenPaths.add(entry.path);

    const size = entry.data.byteLength;
    if (size > ZIP_MAX_UINT32) {
      throw new ZipError('entry_too_large', `条目 ${entry.path} 大小 ${size} 超过 4 GiB 上限`);
    }
    const nameBytes = Buffer.from(entry.path, 'utf8');
    if (nameBytes.length > ZIP_MAX_NAME_BYTES) {
      throw new ZipError('invalid_path', `条目路径过长：${entry.path}`);
    }
    if (offset > ZIP_MAX_UINT32) {
      throw new ZipError('archive_too_large', `本地头偏移 ${offset} 超出 32 位上限`);
    }

    prepared.push({
      path: entry.path,
      nameBytes,
      data: entry.data,
      size,
      crc: crc32(entry.data),
      localHeaderOffset: offset,
    });

    offset += LOCAL_FILE_HEADER_SIZE + nameBytes.length + size;
    if (offset > ZIP_MAX_UINT32) {
      throw new ZipError('archive_too_large', `归档数据区 ${offset} 字节超出 32 位上限`);
    }
  }

  const centralDirectoryOffset = offset;
  const centralDirectorySize = prepared.reduce(
    (total, entry) => total + CENTRAL_DIRECTORY_HEADER_SIZE + entry.nameBytes.length,
    0,
  );
  if (centralDirectorySize > ZIP_MAX_UINT32) {
    throw new ZipError('archive_too_large', '中央目录超出 32 位上限');
  }

  // —— 第二遍：按第一遍算好的偏移写字节。
  const chunks: Uint8Array[] = [];

  for (const entry of prepared) {
    const header = Buffer.alloc(LOCAL_FILE_HEADER_SIZE);
    header.writeUInt32LE(ZIP_LOCAL_FILE_HEADER_SIGNATURE, 0);
    header.writeUInt16LE(ZIP_VERSION_NEEDED_TO_EXTRACT, 4);
    header.writeUInt16LE(ZIP_GENERAL_PURPOSE_FLAGS, 6);
    header.writeUInt16LE(ZIP_COMPRESSION_METHOD_STORE, 8);
    header.writeUInt16LE(ZIP_DOS_TIME, 10);
    header.writeUInt16LE(ZIP_DOS_DATE, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.size, 18);
    header.writeUInt32LE(entry.size, 22);
    header.writeUInt16LE(entry.nameBytes.length, 26);
    header.writeUInt16LE(0, 28); // extra field length
    chunks.push(header, entry.nameBytes, entry.data);
  }

  for (const entry of prepared) {
    const header = Buffer.alloc(CENTRAL_DIRECTORY_HEADER_SIZE);
    header.writeUInt32LE(ZIP_CENTRAL_DIRECTORY_SIGNATURE, 0);
    header.writeUInt16LE(ZIP_VERSION_MADE_BY, 4);
    header.writeUInt16LE(ZIP_VERSION_NEEDED_TO_EXTRACT, 6);
    header.writeUInt16LE(ZIP_GENERAL_PURPOSE_FLAGS, 8);
    header.writeUInt16LE(ZIP_COMPRESSION_METHOD_STORE, 10);
    header.writeUInt16LE(ZIP_DOS_TIME, 12);
    header.writeUInt16LE(ZIP_DOS_DATE, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.size, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.nameBytes.length, 28);
    header.writeUInt16LE(0, 30); // extra field length
    header.writeUInt16LE(0, 32); // file comment length
    header.writeUInt16LE(0, 34); // disk number start
    header.writeUInt16LE(ZIP_DOS_ATTRIBUTES, 36); // internal file attributes
    header.writeUInt32LE(0, 38); // external file attributes
    header.writeUInt32LE(entry.localHeaderOffset, 42);
    chunks.push(header, entry.nameBytes);
  }

  const end = Buffer.alloc(END_OF_CENTRAL_DIRECTORY_SIZE);
  end.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  end.writeUInt16LE(0, 4); // number of this disk
  end.writeUInt16LE(0, 6); // disk where central directory starts
  end.writeUInt16LE(prepared.length, 8); // entries on this disk
  end.writeUInt16LE(prepared.length, 10); // total entries
  end.writeUInt32LE(centralDirectorySize, 12);
  end.writeUInt32LE(centralDirectoryOffset, 16);
  end.writeUInt16LE(0, 20); // comment length
  chunks.push(end);

  return Buffer.concat(chunks);
}

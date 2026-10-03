/**
 * P-R04 · **独立 ZIP 容器校验器**（从零实现，不复用仓库任何 ZIP/CRC 代码）。
 *
 * ## 为什么另写一份
 *
 * 生产侧写包用 `src/artifacts/ooxml/zip.ts`（`writeZip`），读包用 `zip-read.ts`（`readZip`）。
 * "用 `readZip` 去验 `writeZip` 的产物"是**同源自证**——两者共用 `crc32.ts`、共用同一套常量与
 * 结构假设，一方错另一方跟着错。本文件用**另一套技术**重算，专门用来咬住这类同源盲点：
 *
 * - CRC-32 用**逐位**算法（无查表、无 `crc32.ts` 的多项式常量导入）；
 * - ZIP 结构用**手写游标**逐字段读，不 import `zip.ts` / `zip-read.ts` 的任何导出。
 *
 * ## 覆盖的检查（每条都对应一种真实损坏）
 *
 * 1. EOCD 定位 + 条目数/中央目录偏移与大小的自洽；
 * 2. 中央目录每项签名、文件名、长度字段边界；
 * 3. 本地头签名、`csize == usize`（写侧是全 STORE，压缩方法是 0）、本地头与中央目录 flags/方法一致；
 * 4. 数据区**重算 CRC-32** 与中央目录记录比对；
 * 5. 路径重复。
 *
 * 本模块**只读**：`inspectZip` 从不抛异常，把所有问题收进结构化 `problems` 里返回——
 * 这样"损坏输入被检出"本身就是可断言的返回值，而不是靠 `expect(...).toThrow()` 猜。
 */

// ---------------------------------------------------------------------------
// 结果类型（本包的校验 schema）
// ---------------------------------------------------------------------------

/** 独立复算出的一个 ZIP 条目。 */
export interface ScannedEntry {
  /** ZIP 内部路径（正斜杠分隔）。 */
  readonly path: string;
  /** 压缩方法：0 = STORE，8 = DEFLATE。 */
  readonly method: number;
  /** 通用位标志。 */
  readonly flags: number;
  /** 中央目录记录的 CRC-32。 */
  readonly recorded_crc: number;
  /** 本模块**逐位重算**的 CRC-32。 */
  readonly recomputed_crc: number;
  readonly compressed_size: number;
  readonly uncompressed_size: number;
  readonly local_header_offset: number;
  /** 数据区字节（STORE 时即原样；本模块不解压 DEFLATE）。 */
  readonly data: Uint8Array;
}

/** 扫描成功后的归档视图。 */
export interface ScannedArchive {
  readonly entries: readonly ScannedEntry[];
  readonly by_path: ReadonlyMap<string, ScannedEntry>;
  /** EOCD 在字节流中的偏移。 */
  readonly eocd_offset: number;
  readonly central_directory_offset: number;
  readonly central_directory_size: number;
  readonly declared_total_entries: number;
  readonly total_bytes: number;
}

export type ZipProblemKind =
  | 'eocd_missing'
  | 'truncated'
  | 'entry_count_mismatch'
  | 'central_directory_out_of_range'
  | 'bad_central_signature'
  | 'bad_local_signature'
  | 'name_length_out_of_range'
  | 'local_header_flags_mismatch'
  | 'local_header_method_mismatch'
  | 'unsupported_compression'
  | 'store_size_mismatch'
  | 'crc_mismatch'
  | 'duplicate_path'
  | 'non_ascii_name'
  | 'zip64_sentinel';

/** 一条结构性问题。`path` 在能定位到条目时给出。 */
export interface ZipProblem {
  readonly kind: ZipProblemKind;
  readonly detail: string;
  readonly path?: string;
}

export interface ZipInspection {
  /** 结构完整且逐条校验通过时为归档视图，否则为 `null`。 */
  readonly archive: ScannedArchive | null;
  /** 所有检出的问题（空数组 = 通过）。 */
  readonly problems: readonly ZipProblem[];
}

// ---------------------------------------------------------------------------
// 独立 CRC-32（逐位，非查表）
// ---------------------------------------------------------------------------

/** 反射多项式 `0xEDB88320`（ZIP / IEEE 802.3）。此处**字面写出**，不 import `crc32.ts`。 */
const REFLECTED_POLY = 0xedb88320;

/** 逐位计算的 CRC-32（与查表实现数学等价，但技术路径不同——用于交叉验证）。 */
export function crc32Independent(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index] as number;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (REFLECTED_POLY ^ (crc >>> 1)) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// 常量（独立写出，不从 zip.ts 导入）
// ---------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const ZIP64_SENTINEL = 0xffffffff;

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

/** 数据视图 + 字节流的一层薄封装，顺手做边界检查。 */
class Cursor {
  constructor(
    private readonly bytes: Uint8Array,
    private readonly view: DataView,
  ) {}

  get length(): number {
    return this.bytes.byteLength;
  }

  u16(offset: number): number {
    this.require(offset, 2);
    return this.view.getUint16(offset, true);
  }

  u32(offset: number): number {
    this.require(offset, 4);
    return this.view.getUint32(offset, true);
  }

  slice(start: number, end: number): Uint8Array {
    this.require(start, end - start);
    return this.bytes.subarray(start, end);
  }

  private require(offset: number, size: number): void {
    if (offset < 0 || size < 0 || offset + size > this.bytes.byteLength) {
      throw new RangeError(`读越界：offset=${String(offset)} size=${String(size)} len=${String(this.bytes.byteLength)}`);
    }
  }
}

function decodeAsciiName(raw: Uint8Array): { name: string | null; nonAscii: boolean } {
  let out = '';
  for (const byte of raw) {
    if (byte > 0x7f) return { name: null, nonAscii: true };
    out += String.fromCharCode(byte);
  }
  return { name: out, nonAscii: false };
}

interface RawCentral {
  readonly path: string;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

/** 从尾部往前找 EOCD：签名 + 注释长度正好把文件收尾。 */
function findEocd(cursor: Cursor): number | null {
  const start = Math.max(0, cursor.length - EOCD_SIZE - MAX_COMMENT);
  for (let offset = cursor.length - EOCD_SIZE; offset >= start; offset -= 1) {
    if (cursor.u32(offset) !== SIG_EOCD) continue;
    const commentLength = cursor.u16(offset + 20);
    if (offset + EOCD_SIZE + commentLength === cursor.length) return offset;
  }
  return null;
}

/**
 * 扫描一份 ZIP（**纯函数**，从不抛异常）。
 *
 * @returns `archive`：结构完整时给出条目视图（**此时 `problems` 仍可能非空**——
 *          CRC 不符等问题不影响结构与条目枚举）；否则为 `null`。
 */
export function inspectZip(bytes: Uint8Array): ZipInspection {
  const problems: ZipProblem[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cursor = new Cursor(bytes, view);

  if (bytes.byteLength < EOCD_SIZE) {
    problems.push({ kind: 'truncated', detail: `归档仅 ${String(bytes.byteLength)} 字节，放不下 EOCD` });
    return { archive: null, problems };
  }

  let eocdOffset: number;
  try {
    const found = findEocd(cursor);
    if (found === null) {
      problems.push({ kind: 'eocd_missing', detail: '找不到中央目录结束记录（EOCD）' });
      return { archive: null, problems };
    }
    eocdOffset = found;
  } catch (error) {
    problems.push({ kind: 'truncated', detail: `读取 EOCD 越界：${(error as Error).message}` });
    return { archive: null, problems };
  }

  const declaredTotal = cursor.u16(eocdOffset + 10);
  const cdSize = cursor.u32(eocdOffset + 12);
  const cdOffset = cursor.u32(eocdOffset + 16);

  if (declaredTotal === 0xffff || cdSize === ZIP64_SENTINEL || cdOffset === ZIP64_SENTINEL) {
    problems.push({ kind: 'zip64_sentinel', detail: '出现 ZIP64 哨兵值（本校验器不实现 ZIP64）' });
  }
  if (cdOffset + cdSize > eocdOffset || cdOffset < 0) {
    problems.push({
      kind: 'central_directory_out_of_range',
      detail: `中央目录 ${String(cdOffset)}..${String(cdOffset + cdSize)} 越出 EOCD ${String(eocdOffset)}`,
    });
    return { archive: null, problems };
  }

  const central: RawCentral[] = [];
  const seen = new Set<string>();
  let cursorPos = cdOffset;
  for (let index = 0; index < declaredTotal; index += 1) {
    if (cursorPos + CENTRAL_HEADER_SIZE > cdOffset + cdSize) {
      problems.push({ kind: 'truncated', detail: `中央目录第 ${String(index)} 项前提前结束` });
      return { archive: null, problems };
    }
    if (cursor.u32(cursorPos) !== SIG_CENTRAL) {
      problems.push({ kind: 'bad_central_signature', detail: `中央目录第 ${String(index)} 项签名错误 @${String(cursorPos)}` });
      return { archive: null, problems };
    }
    const flags = cursor.u16(cursorPos + 8);
    const method = cursor.u16(cursorPos + 10);
    const crc = cursor.u32(cursorPos + 16);
    const compressedSize = cursor.u32(cursorPos + 20);
    const uncompressedSize = cursor.u32(cursorPos + 24);
    const nameLength = cursor.u16(cursorPos + 28);
    const extraLength = cursor.u16(cursorPos + 30);
    const commentLength = cursor.u16(cursorPos + 32);
    const localHeaderOffset = cursor.u32(cursorPos + 42);

    const nameStart = cursorPos + CENTRAL_HEADER_SIZE;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > cdOffset + cdSize) {
      problems.push({ kind: 'name_length_out_of_range', detail: `第 ${String(index)} 项文件名超出中央目录` });
      return { archive: null, problems };
    }
    const decoded = decodeAsciiName(cursor.slice(nameStart, nameEnd));
    if (decoded.nonAscii || decoded.name === null) {
      problems.push({ kind: 'non_ascii_name', detail: `第 ${String(index)} 项文件名含非 ASCII 字节` });
      return { archive: null, problems };
    }
    const path = decoded.name;
    if (seen.has(path)) {
      problems.push({ kind: 'duplicate_path', detail: `条目路径重复：${JSON.stringify(path)}`, path });
    }
    seen.add(path);

    central.push({ path, flags, method, crc, compressedSize, uncompressedSize, localHeaderOffset });
    cursorPos = nameEnd + extraLength + commentLength;
  }

  if (cursorPos !== cdOffset + cdSize) {
    problems.push({
      kind: 'entry_count_mismatch',
      detail: `中央目录解析后游标 ${String(cursorPos)} 与声明结尾 ${String(cdOffset + cdSize)} 不符`,
    });
    return { archive: null, problems };
  }

  const entries: ScannedEntry[] = [];
  const byPath = new Map<string, ScannedEntry>();
  for (const entry of central) {
    const offset = entry.localHeaderOffset;
    if (offset + LOCAL_HEADER_SIZE > cdOffset) {
      problems.push({ kind: 'truncated', detail: `条目本地头偏移 ${String(offset)} 越界`, path: entry.path });
      return { archive: null, problems };
    }
    if (cursor.u32(offset) !== SIG_LOCAL) {
      problems.push({ kind: 'bad_local_signature', detail: `本地文件头签名错误 @${String(offset)}`, path: entry.path });
      return { archive: null, problems };
    }
    const localFlags = cursor.u16(offset + 6);
    const localMethod = cursor.u16(offset + 8);
    if (localFlags !== entry.flags) {
      problems.push({ kind: 'local_header_flags_mismatch', detail: '本地头与中央目录 flags 不一致', path: entry.path });
    }
    if (localMethod !== entry.method) {
      problems.push({ kind: 'local_header_method_mismatch', detail: '本地头与中央目录压缩方法不一致', path: entry.path });
    }
    if (entry.method !== 0 && entry.method !== 8) {
      problems.push({ kind: 'unsupported_compression', detail: `压缩方法 ${String(entry.method)} 不受支持`, path: entry.path });
    }
    if (entry.method === 0 && entry.compressedSize !== entry.uncompressedSize) {
      problems.push({
        kind: 'store_size_mismatch',
        detail: `STORE 条目 csize=${String(entry.compressedSize)} != usize=${String(entry.uncompressedSize)}`,
        path: entry.path,
      });
    }
    const localNameLength = cursor.u16(offset + 26);
    const localExtraLength = cursor.u16(offset + 28);
    const dataStart = offset + LOCAL_HEADER_SIZE + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > cdOffset) {
      problems.push({ kind: 'truncated', detail: `条目数据区 ${String(dataStart)}..${String(dataEnd)} 越界`, path: entry.path });
      return { archive: null, problems };
    }
    const data = cursor.slice(dataStart, dataEnd);
    const recomputed = crc32Independent(data);
    if (recomputed !== entry.crc) {
      problems.push({
        kind: 'crc_mismatch',
        detail: `CRC 记录 ${entry.crc.toString(16)} != 重算 ${recomputed.toString(16)}`,
        path: entry.path,
      });
    }

    const scanned: ScannedEntry = Object.freeze({
      path: entry.path,
      method: entry.method,
      flags: entry.flags,
      recorded_crc: entry.crc,
      recomputed_crc: recomputed,
      compressed_size: entry.compressedSize,
      uncompressed_size: entry.uncompressedSize,
      local_header_offset: offset,
      data,
    });
    entries.push(scanned);
    byPath.set(entry.path, scanned);
  }

  return {
    archive: Object.freeze({
      entries: Object.freeze(entries),
      by_path: byPath,
      eocd_offset: eocdOffset,
      central_directory_offset: cdOffset,
      central_directory_size: cdSize,
      declared_total_entries: declaredTotal,
      total_bytes: bytes.byteLength,
    }),
    problems,
  };
}

/** 便捷判定：结构完整、条目枚举成功、且没有任何问题。 */
export function isValidZip(bytes: Uint8Array): boolean {
  const { archive, problems } = inspectZip(bytes);
  return archive !== null && problems.length === 0;
}

/** 把条目字节按 UTF-8 解成文本（仅用于 XML 部件）。 */
export function entryText(archive: ScannedArchive, path: string): string {
  const entry = archive.by_path.get(path);
  if (entry === undefined) throw new Error(`包内没有部件 ${path}`);
  return Buffer.from(entry.data).toString('utf8');
}

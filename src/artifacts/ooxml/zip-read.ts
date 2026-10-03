/**
 * **有界 ZIP 读取器**（归属 WCF-D02；合同 R159–R160）——`zip.ts` 的读侧对偶。
 *
 * ## 为什么另开一个文件、而不改 `zip.ts`
 *
 * `zip.ts` 是**确定性写入器**：全 STORE、不 import `node:zlib`、字节可复现（design-02 批次 A 的
 * 既定取舍，本批不得改）。但**真实 Word / WPS 产出的 DOCX 是 DEFLATE 压缩的**，只写 STORE 的
 * 写入器读不了别人的包。于是读侧单独成模块：
 *
 * - **读路径**用本目录的 `inflate.ts`（**纯 TypeScript 的 RFC 1951 解压**，不 import 任何
 *   `node:*`）——因此"`src/**` 的 `node:*` 白名单只有 `node:crypto`"这条既有验收纪律
 *   （`w-disc-kernel-discipline.test.ts`）**不被触碰**，内核也继续保持零运行期依赖；
 * - **写路径一行都不动**——`zip.ts` 保持全 STORE、保持不 import `node:zlib`，
 *   写入字节的逐字节确定性不因本模块而改变。
 *
 * ## 有界（R159）——四条上限，超限即拒，不截断
 *
 * | 上限 | 字段 | 防的是什么 |
 * |---|---|---|
 * | 条目数 | `maxEntries` | 目录炸弹的条目维度（10 万个小条目） |
 * | 单条目解压后字节 | `maxEntryUncompressedBytes` | 单个 4 GiB 条目 |
 * | 全包解压后字节 | `maxTotalUncompressedBytes` | 多个中等条目叠加 |
 * | 压缩比 | `maxCompressionRatio` | "1 KiB → 1 GiB" 的 deflate 炸弹 |
 *
 * 全部**在解压之前**用声明值先判一次（便宜、失败早），解压时再把
 * `min(声明 + 1, 单条目上限 + 1)` 作为输出的**硬上限**交给解压器——它是"边解边卡"的，
 * 不是"解完再截"。因此"声明值撒谎"这条路也是封的（见 `inflateEntry` 里的两条分支）。
 *
 * ## 拒绝项（R160）——逐项检查，不静默跳过
 *
 * 重复条目路径 / 路径穿越（`../`、前导斜杠、盘符、反斜杠）/ CRC 不符 / 结构损坏 /
 * 加密条目 / ZIP64。目录条目（名字以 `/` 结尾）按非法路径拒绝：OOXML 包里没有目录条目，
 * 放行只会让"条目数"与"部件数"对不上。
 *
 * ## 明确不做的事
 *
 * - **不读磁盘、不读时钟、不读环境**：只吃一个 `Uint8Array`，纯函数；
 * - **不自动外联**（R161）：`External` 关系由上层处理，本模块连目标字符串都不解释；
 * - **不解 ZIP64、不解加密**：这两种包在真实 DOCX 里罕见，遇到就**显式拒绝**，
 *   而不是"猜一个"或"只读前 4 GiB"。
 */

import { crc32 } from './crc32.js';
import { InflateError, inflateRaw } from './inflate.js';
import {
  ZIP_CENTRAL_DIRECTORY_SIGNATURE,
  ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE,
  ZIP_LOCAL_FILE_HEADER_SIGNATURE,
  ZIP_MAX_ENTRIES,
  ZIP_MAX_NAME_BYTES,
  ZIP_COMPRESSION_METHOD_STORE,
} from './zip.js';

/** 压缩方法 8 = DEFLATE（raw，无 zlib/gzip 头）。 */
export const ZIP_COMPRESSION_METHOD_DEFLATE = 8;

/** 通用位标志 bit 0：条目已加密。 */
const FLAG_ENCRYPTED = 0x0001;
/** 通用位标志 bit 3：尺寸/CRC 在数据描述符里（本地头可能为 0）。 */
const FLAG_DATA_DESCRIPTOR = 0x0008;
/** 通用位标志 bit 11：文件名为 UTF-8。 */
const FLAG_UTF8_NAME = 0x0800;

const LOCAL_FILE_HEADER_SIZE = 30;
const CENTRAL_DIRECTORY_HEADER_SIZE = 46;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
/** ZIP 注释最大长度（16 位字段）。 */
const MAX_ZIP_COMMENT = 0xffff;

export type ZipReadErrorReason =
  /** EOCD/中央目录/本地头结构不自洽（签名、偏移、长度对不上）。 */
  | 'invalid_structure'
  /** 字节流被截断：声明的区域超出了实际长度。 */
  | 'truncated'
  /** 压缩方法不是 STORE / DEFLATE。 */
  | 'unsupported_compression'
  /** 出现 ZIP64 哨兵值（本读取器不实现 ZIP64）。 */
  | 'unsupported_zip64'
  /** 条目被加密。 */
  | 'encrypted_entry'
  /** 路径非法：前导斜杠 / 反斜杠 / `..` 段 / 盘符 / 空段 / 控制字符 / 目录条目。 */
  | 'invalid_path'
  /** 同一条路径出现两次。 */
  | 'duplicate_path'
  /** 条目数超过上限。 */
  | 'too_many_entries'
  /** 单条目解压后字节超过上限（含解压中途超限）。 */
  | 'entry_limit_exceeded'
  /** 全包解压后字节超过上限。 */
  | 'archive_limit_exceeded'
  /** 压缩比超过上限（deflate 炸弹）。 */
  | 'compression_ratio_exceeded'
  /** 归档字节数超过上限。 */
  | 'archive_too_large'
  /** 解压输出长度与声明的 `uncompressedSize` 不符。 */
  | 'size_mismatch'
  /** CRC-32 与中央目录记录不符。 */
  | 'crc_mismatch';

export class ZipReadError extends Error {
  readonly reason: ZipReadErrorReason;

  constructor(reason: ZipReadErrorReason, message: string) {
    super(message);
    this.name = 'ZipReadError';
    this.reason = reason;
  }
}

/** 读取上限。**每一项都是硬门**：超过即抛错，不截断、不降级。 */
export interface ZipReadLimits {
  /** 条目数上限。 */
  readonly maxEntries: number;
  /** 单个条目解压后字节上限。 */
  readonly maxEntryUncompressedBytes: number;
  /** 全包解压后字节合计上限。 */
  readonly maxTotalUncompressedBytes: number;
  /** 解压比上限（`uncompressed / max(compressed, 1)`）。 */
  readonly maxCompressionRatio: number;
  /** 输入归档字节数上限。 */
  readonly maxArchiveBytes: number;
}

/**
 * 默认上限。
 *
 * 取值的尺子：R163 的工程目标（≥500 段 / ≥5 万汉字 / ≥100 图 / ≥10 MiB DOCX）要能过，
 * 而单条目 64 MiB、全包 256 MiB 对"文档包"来说已远超真实 Word 文件（典型 DOCX < 2 MiB）；
 * 压缩比 200 允许文字高度重复的包（真实 DOCX 常见比值个位数），又挡住 1 KiB → 1 GiB 的炸弹。
 */
export const DEFAULT_ZIP_READ_LIMITS: ZipReadLimits = Object.freeze({
  maxEntries: 4096,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxArchiveBytes: 128 * 1024 * 1024,
});

/** 读出的一个条目：**已解压**的字节 + 原始头字段（供上层核对）。 */
export interface ReadZipEntry {
  /** ZIP 内部路径（正斜杠分隔，无前导斜杠）。 */
  readonly path: string;
  /** 压缩方法（0 = STORE，8 = DEFLATE）。 */
  readonly compression_method: number;
  /** 通用位标志（原样读出）。 */
  readonly flags: number;
  /** 压缩后字节数。 */
  readonly compressed_size: number;
  /** 解压后字节数。 */
  readonly uncompressed_size: number;
  /** 中央目录记录的 CRC-32。 */
  readonly crc: number;
  /** 本地文件头偏移。 */
  readonly local_header_offset: number;
  /** **解压后**的字节（STORE 时是原样拷贝，DEFLATE 时是 raw inflate 的结果）。 */
  readonly data: Uint8Array;
}

/** 读取结果：**有序**条目数组 + 路径索引。 */
export interface ReadZipArchive {
  /** 条目顺序 = **中央目录顺序**。 */
  readonly entries: readonly ReadZipEntry[];
  /** 路径 → 条目（重复路径在读取期已被拒绝，因此这里没有覆盖语义）。 */
  readonly by_path: ReadonlyMap<string, ReadZipEntry>;
  /** 解压后字节合计（供上层核对 R159 的口径）。 */
  readonly total_uncompressed_bytes: number;
}

/** 合并上限：未给的项取默认值。 */
export function resolveZipReadLimits(overrides?: Partial<ZipReadLimits>): ZipReadLimits {
  const merged: ZipReadLimits = { ...DEFAULT_ZIP_READ_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ZipReadError(
        'invalid_structure',
        `ZIP 读取上限 ${key} 必须是非负安全整数，收到 ${String(value)}`,
      );
    }
  }
  if (merged.maxEntries > ZIP_MAX_ENTRIES) {
    throw new ZipReadError(
      'invalid_structure',
      `maxEntries ${String(merged.maxEntries)} 超过 ZIP 经典字段上限 ${String(ZIP_MAX_ENTRIES)}`,
    );
  }
  return Object.freeze(merged);
}

const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;
const DRIVE_LETTER = /^[A-Za-z]:/;

/**
 * 路径校验（R160 的"路径穿越"一项）。
 *
 * 拒绝：空路径、前导斜杠（绝对路径）、反斜杠（Windows 遗留分隔符）、盘符（`C:`）、
 * 空段 / `.` 段 / `..` 段（穿越）、控制字符、结尾斜杠（目录条目）、超出 16 位的长名。
 */
export function assertZipReadEntryPath(path: string): void {
  if (path.length === 0) {
    throw new ZipReadError('invalid_path', 'ZIP 条目路径为空');
  }
  if (CONTROL_CHARACTER.test(path)) {
    throw new ZipReadError(
      'invalid_path',
      `ZIP 条目路径含控制字符：${JSON.stringify(path)}`,
    );
  }
  if (path.startsWith('/')) {
    throw new ZipReadError(
      'invalid_path',
      `ZIP 条目路径不得是绝对路径（前导斜杠）：${JSON.stringify(path)}`,
    );
  }
  if (path.includes('\\')) {
    throw new ZipReadError(
      'invalid_path',
      `ZIP 条目路径不得含反斜杠（路径穿越与平台歧义的常见来源）：${JSON.stringify(path)}`,
    );
  }
  if (DRIVE_LETTER.test(path)) {
    throw new ZipReadError(
      'invalid_path',
      `ZIP 条目路径不得是盘符绝对路径：${JSON.stringify(path)}`,
    );
  }
  if (path.endsWith('/')) {
    throw new ZipReadError(
      'invalid_path',
      `ZIP 目录条目不受支持（OOXML 包里没有目录条目）：${JSON.stringify(path)}`,
    );
  }
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new ZipReadError(
        'invalid_path',
        `ZIP 条目路径含非法路径段（空段 / "." / ".."）：${JSON.stringify(path)}`,
      );
    }
  }
}

/** 条目名解码：UTF-8 标志位（bit 11）置位时按 UTF-8；否则只接受纯 ASCII。 */
function decodeEntryName(nameBytes: Uint8Array, flags: number): string {
  if ((flags & FLAG_UTF8_NAME) !== 0) {
    return new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
  }
  let ascii = '';
  for (const byte of nameBytes) {
    if (byte > 0x7f) {
      throw new ZipReadError(
        'invalid_path',
        'ZIP 条目名含非 ASCII 字节但未置 UTF-8 标志位（bit 11）：本读取器不猜代码页',
      );
    }
    ascii += String.fromCharCode(byte);
  }
  return ascii;
}

/** 中央目录里读出的**未解压**条目描述。 */
interface CentralEntry {
  readonly path: string;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

function readEndOfCentralDirectory(view: DataView, length: number): number {
  const scanStart = Math.max(0, length - END_OF_CENTRAL_DIRECTORY_SIZE - MAX_ZIP_COMMENT);
  for (let offset = length - END_OF_CENTRAL_DIRECTORY_SIZE; offset >= scanStart; offset -= 1) {
    if (view.getUint32(offset, true) !== ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    // 真正的 EOCD 必须**正好**把注释算完：末尾没有多余字节，也不会提前撞上数据里的同值。
    if (offset + END_OF_CENTRAL_DIRECTORY_SIZE + commentLength === length) return offset;
  }
  throw new ZipReadError(
    'invalid_structure',
    '找不到中央目录结束记录（EOCD）：不是 ZIP 归档，或尾部被追加/截断',
  );
}

function readCentralDirectory(
  view: DataView,
  bytes: Uint8Array,
  offset: number,
  size: number,
  entryCount: number,
  limits: ZipReadLimits,
): CentralEntry[] {
  const entries: CentralEntry[] = [];
  const seen = new Set<string>();
  let cursor = offset;
  const end = offset + size;
  if (end > bytes.byteLength) {
    throw new ZipReadError(
      'truncated',
      `中央目录声明 ${String(size)} 字节（偏移 ${String(offset)}），超出归档长度 ${String(bytes.byteLength)}`,
    );
  }

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + CENTRAL_DIRECTORY_HEADER_SIZE > end) {
      throw new ZipReadError(
        'invalid_structure',
        `中央目录在第 ${String(index)} 项处提前结束（声明 ${String(entryCount)} 项）`,
      );
    }
    if (view.getUint32(cursor, true) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new ZipReadError(
        'invalid_structure',
        `中央目录第 ${String(index)} 项签名错误（偏移 ${String(cursor)}）`,
      );
    }

    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);

    if (nameLength > ZIP_MAX_NAME_BYTES) {
      throw new ZipReadError('invalid_path', `条目路径长度字段异常：${String(nameLength)}`);
    }
    const nameStart = cursor + CENTRAL_DIRECTORY_HEADER_SIZE;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > end) {
      throw new ZipReadError('truncated', '条目名超出中央目录区域');
    }
    const path = decodeEntryName(bytes.subarray(nameStart, nameEnd), flags);

    if ((flags & FLAG_ENCRYPTED) !== 0) {
      throw new ZipReadError('encrypted_entry', `条目已加密，本读取器不解密：${JSON.stringify(path)}`);
    }
    if (method !== ZIP_COMPRESSION_METHOD_STORE && method !== ZIP_COMPRESSION_METHOD_DEFLATE) {
      throw new ZipReadError(
        'unsupported_compression',
        `条目 ${JSON.stringify(path)} 的压缩方法 ${String(method)} 不受支持（只支持 0=STORE / 8=DEFLATE）`,
      );
    }
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new ZipReadError(
        'unsupported_zip64',
        `条目 ${JSON.stringify(path)} 使用 ZIP64 字段（本读取器不实现 ZIP64）`,
      );
    }

    assertZipReadEntryPath(path);
    if (seen.has(path)) {
      throw new ZipReadError('duplicate_path', `ZIP 条目路径重复：${JSON.stringify(path)}`);
    }
    seen.add(path);

    entries.push({
      path,
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    cursor = nameEnd + extraLength + commentLength;
  }

  if (cursor !== end) {
    throw new ZipReadError(
      'invalid_structure',
      `中央目录解析后偏移 ${String(cursor)} 与声明结尾 ${String(end)} 不符`,
    );
  }
  return entries;
}

/** 一个条目的数据区位置（由**本地文件头**定位，而不是中央目录里的偏移）。 */
function locateLocalData(
  view: DataView,
  bytes: Uint8Array,
  entry: CentralEntry,
  centralDirectoryOffset: number,
): Uint8Array {
  const offset = entry.localHeaderOffset;
  if (offset + LOCAL_FILE_HEADER_SIZE > centralDirectoryOffset) {
    throw new ZipReadError(
      'truncated',
      `条目 ${JSON.stringify(entry.path)} 的本地头偏移 ${String(offset)} 越界`,
    );
  }
  if (view.getUint32(offset, true) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
    throw new ZipReadError(
      'invalid_structure',
      `条目 ${JSON.stringify(entry.path)} 的本地文件头签名错误（偏移 ${String(offset)}）`,
    );
  }
  // 本地头的通用位标志必须与中央目录一致：不一致说明包被拼接过。
  if (view.getUint16(offset + 6, true) !== entry.flags) {
    throw new ZipReadError(
      'invalid_structure',
      `条目 ${JSON.stringify(entry.path)} 的本地头与中央目录的通用位标志不一致`,
    );
  }
  // 本地头里的压缩方法同样必须一致（数据描述的写法不改变方法本身）。
  if (view.getUint16(offset + 8, true) !== entry.method) {
    throw new ZipReadError(
      'invalid_structure',
      `条目 ${JSON.stringify(entry.path)} 的本地头与中央目录的压缩方法不一致`,
    );
  }
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + LOCAL_FILE_HEADER_SIZE + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > centralDirectoryOffset) {
    throw new ZipReadError(
      'truncated',
      `条目 ${JSON.stringify(entry.path)} 的数据区 ${String(dataStart)}…${String(dataEnd)} ` +
        `越出数据区边界 ${String(centralDirectoryOffset)}`,
    );
  }
  return bytes.subarray(dataStart, dataEnd);
}

/**
 * 归一成**普通 `Uint8Array`**（而不是 `Buffer`）。
 *
 * 调用方完全可能传进来一个 `Buffer`（它是 `Uint8Array` 的子类），而 `subarray`/`slice`
 * 会**按调用者的类别**返回结果——于是同一份字节因为"上游用的是什么"而在 `toEqual`、
 * JSON 序列化（`Buffer` 会变成 `{type:'Buffer',data:[…]}`）等处表现不同。
 * 这里一次抹平，代价只是一次视图包装（不复制）。
 */
function toUint8Array(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** 解压一个条目：STORE 原样，DEFLATE 走 `inflateRawSync`（带输出上限）。 */
function inflateEntry(
  entry: CentralEntry,
  raw: Uint8Array,
  limits: ZipReadLimits,
): Uint8Array {
  if (entry.method === ZIP_COMPRESSION_METHOD_STORE) {
    if (raw.byteLength !== entry.uncompressedSize) {
      throw new ZipReadError(
        'size_mismatch',
        `条目 ${JSON.stringify(entry.path)} 声明 ${String(entry.uncompressedSize)} 字节，实际 ${String(raw.byteLength)}`,
      );
    }
    return toUint8Array(raw.slice());
  }

  // "声明值撒谎"的兜底：即使 `uncompressedSize` 被写小，解压器也**不会**吐出超过
  // (声明 + 1) 字节——多出来的那 1 字节正好用来判 size_mismatch。
  const declaredCap = entry.uncompressedSize + 1;
  const limitCap = limits.maxEntryUncompressedBytes + 1;
  const maxOutputLength = Math.min(declaredCap, limitCap);
  let output: Uint8Array;
  try {
    output = inflateRaw(raw, { maxOutputLength });
  } catch (error) {
    if (error instanceof InflateError && error.reason === 'limit') {
      // 撞的是哪条上限要说清楚：撞"声明值"= 声明撒谎（size_mismatch）；
      // 撞"上限"= 真的太大（entry_limit_exceeded）。两者对调用方的含义完全不同。
      if (declaredCap <= limitCap) {
        throw new ZipReadError(
          'size_mismatch',
          `条目 ${JSON.stringify(entry.path)} 声明解压后 ${String(entry.uncompressedSize)} 字节，` +
            '但压缩流展开后已经超出该声明（声明值与实际不符）',
        );
      }
      throw new ZipReadError(
        'entry_limit_exceeded',
        `条目 ${JSON.stringify(entry.path)} 解压输出超过上限 ${String(limits.maxEntryUncompressedBytes)} 字节`,
      );
    }
    throw new ZipReadError(
      'invalid_structure',
      `条目 ${JSON.stringify(entry.path)} 的 DEFLATE 数据无法解压：${String((error as Error).message)}`,
    );
  }
  if (output.byteLength !== entry.uncompressedSize) {
    throw new ZipReadError(
      'size_mismatch',
      `条目 ${JSON.stringify(entry.path)} 声明 ${String(entry.uncompressedSize)} 字节，解压得到 ${String(output.byteLength)}`,
    );
  }
  // `inflateRaw` 返回的就是普通 `Uint8Array`（见 `inflate.ts` 的 `OutputBuffer`）。
  return output;
}

/**
 * 读取一份 ZIP 归档（**纯函数**：同一输入 ⇒ 同一结果）。
 *
 * 检查顺序（每一项都**先于**昂贵的解压）：
 * 1. 归档字节数上限 → 2. EOCD 结构 → 3. 条目数上限 → 4. 中央目录自洽 →
 * 5. 逐条：加密 / 压缩方法 / ZIP64 / 路径合法 / 路径重复 → 6. 逐条：单条目与总量上限、
 * 压缩比 → 7. 解压（带输出上限）→ 8. 长度核对 → 9. CRC 核对。
 *
 * @throws {ZipReadError} 上述任一检查不通过。
 */
export function readZip(
  bytes: Uint8Array,
  overrides?: Partial<ZipReadLimits>,
): ReadZipArchive {
  const limits = resolveZipReadLimits(overrides);
  if (bytes.byteLength > limits.maxArchiveBytes) {
    throw new ZipReadError(
      'archive_too_large',
      `归档 ${String(bytes.byteLength)} 字节超过上限 ${String(limits.maxArchiveBytes)}`,
    );
  }
  if (bytes.byteLength < END_OF_CENTRAL_DIRECTORY_SIZE) {
    throw new ZipReadError('truncated', `归档只有 ${String(bytes.byteLength)} 字节，放不下 EOCD`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = readEndOfCentralDirectory(view, bytes.byteLength);

  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDirectoryDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0) {
    throw new ZipReadError(
      'unsupported_zip64',
      `分卷 ZIP 不受支持（磁盘号 ${String(diskNumber)} / ${String(centralDirectoryDisk)}）`,
    );
  }
  if (entriesOnDisk !== totalEntries) {
    throw new ZipReadError(
      'invalid_structure',
      `本盘条目数 ${String(entriesOnDisk)} 与总数 ${String(totalEntries)} 不符（分卷 ZIP）`,
    );
  }
  if (totalEntries === ZIP_MAX_ENTRIES) {
    throw new ZipReadError(
      'unsupported_zip64',
      `条目数为 ${String(ZIP_MAX_ENTRIES)}：ZIP64 哨兵值，本读取器不实现 ZIP64`,
    );
  }
  if (totalEntries > limits.maxEntries) {
    throw new ZipReadError(
      'too_many_entries',
      `条目数 ${String(totalEntries)} 超过上限 ${String(limits.maxEntries)}`,
    );
  }

  const central = readCentralDirectory(
    view,
    bytes,
    centralDirectoryOffset,
    centralDirectorySize,
    totalEntries,
    limits,
  );

  const entries: ReadZipEntry[] = [];
  const byPath = new Map<string, ReadZipEntry>();
  let totalUncompressed = 0;

  for (const entry of central) {
    if (entry.uncompressedSize > limits.maxEntryUncompressedBytes) {
      throw new ZipReadError(
        'entry_limit_exceeded',
        `条目 ${JSON.stringify(entry.path)} 声明解压后 ${String(entry.uncompressedSize)} 字节，` +
          `超过单条目上限 ${String(limits.maxEntryUncompressedBytes)}`,
      );
    }
    totalUncompressed += entry.uncompressedSize;
    if (totalUncompressed > limits.maxTotalUncompressedBytes) {
      throw new ZipReadError(
        'archive_limit_exceeded',
        `解压后合计 ${String(totalUncompressed)} 字节超过上限 ${String(limits.maxTotalUncompressedBytes)}`,
      );
    }
    const ratio = entry.uncompressedSize / Math.max(entry.compressedSize, 1);
    if (ratio > limits.maxCompressionRatio) {
      throw new ZipReadError(
        'compression_ratio_exceeded',
        `条目 ${JSON.stringify(entry.path)} 压缩比 ${ratio.toFixed(1)} 超过上限 ` +
          `${String(limits.maxCompressionRatio)}（疑似 deflate 炸弹）`,
      );
    }

    const raw = locateLocalData(view, bytes, entry, centralDirectoryOffset);
    const data = inflateEntry(entry, raw, limits);

    const actual = crc32(data);
    if (actual !== entry.crc) {
      throw new ZipReadError(
        'crc_mismatch',
        `条目 ${JSON.stringify(entry.path)} 的 CRC-32 不符：` +
          `记录 ${entry.crc.toString(16).padStart(8, '0')}，实际 ${actual.toString(16).padStart(8, '0')}`,
      );
    }

    const read: ReadZipEntry = Object.freeze({
      path: entry.path,
      compression_method: entry.method,
      flags: entry.flags,
      compressed_size: entry.compressedSize,
      uncompressed_size: entry.uncompressedSize,
      crc: entry.crc,
      local_header_offset: entry.localHeaderOffset,
      data,
    });
    entries.push(read);
    byPath.set(entry.path, read);
  }

  return Object.freeze({
    entries: Object.freeze(entries),
    by_path: byPath,
    total_uncompressed_bytes: totalUncompressed,
  });
}

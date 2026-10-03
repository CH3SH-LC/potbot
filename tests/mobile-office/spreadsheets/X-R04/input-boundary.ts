/**
 * **X-R04 / 输入边界**：把"压缩炸弹 + 损坏输入"挡在表格内核之外的那道门。
 *
 * ## 为什么需要这一层（而不是直接用 `readWorkbookXlsx`）
 *
 * 生产读路径 `readWorkbookXlsx(bytes)` 内部调 `readZip(bytes)`，**没有把读取上限暴露成参数**。
 * 对手机端这有两个后果：
 *
 * 1. **预算不可调**：手机上 R163 的文档目标与大表目标的可用内存不同，但两者只能用同一套默认上限
 *    （`DEFAULT_ZIP_READ_LIMITS`：单条目 64 MiB / 全包 256 MiB / 压缩比 200）；
 * 2. **没有"解压前"的便宜闸**：`readZip` 的每条上限都是**逐条**执行的——第 0 个条目会先被解压，
 *    第 1 个条目才轮到自己的压缩比闸。对"多条目叠加炸弹"这意味着**先付出一次解压代价**。
 *
 * 本模块提供 `preflightXlsxBytes`：**只走中央目录、一个字节都不解压**的独立元数据闸，
 * 可带自定义预算；`openWorkbookBounded` 先跑它，再用生产读路径做权威校验。
 *
 * ## 独立口径（这一点是故意的）
 *
 * `preflightXlsxBytes` **不 import** `zip-read.ts` 的任何内部函数，自己按 ZIP 规格走一遍中央目录。
 * 因此它与生产 `readZip` 构成**两个独立实现**：对同一份炸弹字节，两边必须给出同一结论；
 * 若哪天生产的闸被改松，本模块的独立实现会在交叉校验用例里把它抓出来。
 *
 * **必要不充分**：preflight 过闸 ≠ 包可用；生产读路径仍然要跑（CRC、本地头一致性、解压、
 * 尺寸核对都在它那边）。本模块**不**宣称可以取代 `readZip`。
 *
 * ## 纪律
 *
 * 纯函数、零 IO、无墙钟、无随机：同一 `(bytes, limits)` ⇒ 同一结论。
 */

import { ValidationError } from '../../../../src/protocol/index.js';
import { ZipReadError, type ZipReadErrorReason } from '../../../../src/artifacts/ooxml/zip-read.js';
import {
  openWorkbookDocument,
  type WorkbookDocument,
} from '../../../../src/spreadsheets/xls-io.js';

// ---------------------------------------------------------------------------
// 预算
// ---------------------------------------------------------------------------

/** 手机端输入预算（各字段含义与 ZIP 规格一致，**全部是硬门**）。 */
export interface SpreadsheetInputLimits {
  /** 输入归档字节数上限。 */
  readonly max_archive_bytes: number;
  /** 条目数上限。 */
  readonly max_entries: number;
  /** 单条目**声明**解压后字节上限。 */
  readonly max_entry_uncompressed_bytes: number;
  /** 全包**声明**解压后字节合计上限。 */
  readonly max_total_uncompressed_bytes: number;
  /** 压缩比上限（`声明解压 / max(声明压缩, 1)`）。 */
  readonly max_compression_ratio: number;
}

/**
 * 手机端默认预算。
 *
 * 取值的尺子：手机上"一次导入"的包在真实语料里是**单表到几十表、几 MiB 级**；
 * 这里给的 32 MiB 单条目 / 96 MiB 全包 / 比值 120 对真实 XLSX 仍宽松（真实文件比值个位数），
 * 但比生产默认（64 MiB / 256 MiB / 200）更紧，给手机留出解压 + 解析 + 模型三份拷贝的余量。
 */
export const MOBILE_DEFAULT_INPUT_LIMITS: SpreadsheetInputLimits = Object.freeze({
  max_archive_bytes: 64 * 1024 * 1024,
  max_entries: 4096,
  max_entry_uncompressed_bytes: 32 * 1024 * 1024,
  max_total_uncompressed_bytes: 96 * 1024 * 1024,
  max_compression_ratio: 120,
});

/** 校验并归一上限；非法值**抛**（不静默取默认）。@throws {ValidationError} */
export function resolveInputLimits(
  overrides?: Partial<SpreadsheetInputLimits>,
): SpreadsheetInputLimits {
  const merged: SpreadsheetInputLimits = { ...MOBILE_DEFAULT_INPUT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ValidationError(`输入上限 ${key} 必须是非负安全整数，收到 ${String(value)}`);
    }
  }
  if (merged.max_compression_ratio < 1) {
    throw new ValidationError(
      `输入上限 max_compression_ratio 必须 ≥ 1，收到 ${String(merged.max_compression_ratio)}`,
    );
  }
  return Object.freeze(merged);
}

// ---------------------------------------------------------------------------
// 解压前预检（独立实现）
// ---------------------------------------------------------------------------

/** 预检拒绝的类别（与 ZIP 规格一一对应，不发明笼统的 "invalid"）。 */
export type PreflightRejectionReason =
  | 'not_a_zip'
  | 'truncated'
  | 'zip64'
  | 'too_many_entries'
  | 'archive_too_large'
  | 'entry_limit_exceeded'
  | 'archive_limit_exceeded'
  | 'compression_ratio_exceeded'
  | 'duplicate_path'
  | 'invalid_path'
  | 'encrypted_entry'
  | 'unsupported_compression';

export interface PreflightOk {
  readonly ok: true;
  readonly entry_count: number;
  /** 全部条目**声明**解压后字节合计。 */
  readonly total_declared_uncompressed_bytes: number;
  /** 最大的单条目**声明**解压后字节。 */
  readonly max_entry_declared_bytes: number;
  /** 最大的**声明**压缩比。 */
  readonly max_declared_compression_ratio: number;
  /** 预检**没有解压任何字节**（供调用方核对这是元数据闸）。 */
  readonly decompressed_bytes: 0;
}

export interface PreflightFail {
  readonly ok: false;
  readonly reason: PreflightRejectionReason;
  readonly detail: string;
  readonly decompressed_bytes: 0;
}

export type PreflightResult = PreflightOk | PreflightFail;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const MAX_COMMENT = 0xffff;
const ZIP64_SENTINEL = 0xffffffff;
const ZIP64_ENTRY_SENTINEL = 0xffff;
const FLAG_ENCRYPTED = 0x0001;
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;
const DRIVE_LETTER = /^[A-Za-z]:/;

function fail(reason: PreflightRejectionReason, detail: string): PreflightFail {
  return Object.freeze({ ok: false, reason, detail, decompressed_bytes: 0 as const });
}

/** 独立实现的条目路径校验（与生产同口径：绝对路径 / 反斜杠 / 盘符 / 穿越段 / 目录条目 / 控制字符）。 */
function pathIsUnsafe(path: string): string | null {
  if (path.length === 0) return '条目路径为空';
  if (CONTROL_CHARACTER.test(path)) return `条目路径含控制字符：${JSON.stringify(path)}`;
  if (path.startsWith('/')) return `条目路径是绝对路径：${JSON.stringify(path)}`;
  if (path.includes('\\')) return `条目路径含反斜杠：${JSON.stringify(path)}`;
  if (DRIVE_LETTER.test(path)) return `条目路径是盘符路径：${JSON.stringify(path)}`;
  if (path.endsWith('/')) return `条目路径是目录条目：${JSON.stringify(path)}`;
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      return `条目路径含非法路径段：${JSON.stringify(path)}`;
    }
  }
  return null;
}

/**
 * **只读中央目录**的预检：不解压任何字节，按**声明值**判定四条炸弹闸。
 *
 * 检查顺序（全部便宜）：
 * 1. 归档字节数 → 2. 找 EOCD → 3. 分卷 / ZIP64 哨兵 → 4. 条目数 → 5. 逐条：
 *    加密 / 压缩方法 / ZIP64 / 路径合法 / 路径重复 → 6. 逐条：单条目声明值、声明总量、声明压缩比。
 *
 * @throws {ValidationError} 上限非法
 */
export function preflightXlsxBytes(
  bytes: Uint8Array,
  overrides?: Partial<SpreadsheetInputLimits>,
): PreflightResult {
  const limits = resolveInputLimits(overrides);
  if (bytes.byteLength > limits.max_archive_bytes) {
    return fail(
      'archive_too_large',
      `归档 ${String(bytes.byteLength)} 字节超过预算 ${String(limits.max_archive_bytes)}`,
    );
  }
  if (bytes.byteLength < EOCD_SIZE) {
    return fail('truncated', `归档只有 ${String(bytes.byteLength)} 字节，放不下 EOCD`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocdOffset = -1;
  const scanFloor = Math.max(0, bytes.byteLength - EOCD_SIZE - MAX_COMMENT);
  for (let offset = bytes.byteLength - EOCD_SIZE; offset >= scanFloor; offset -= 1) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + EOCD_SIZE + commentLength === bytes.byteLength) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) {
    return fail('not_a_zip', '找不到中央目录结束记录（EOCD）：不是 ZIP 归档，或尾部被追加/截断');
  }

  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);

  if (view.getUint16(eocdOffset + 4, true) !== 0 || view.getUint16(eocdOffset + 6, true) !== 0) {
    return fail('zip64', '分卷 ZIP 不受支持');
  }
  if (entriesOnDisk !== totalEntries) {
    return fail('not_a_zip', `本盘条目数 ${String(entriesOnDisk)} 与总数 ${String(totalEntries)} 不符`);
  }
  if (totalEntries === ZIP64_ENTRY_SENTINEL) {
    return fail('zip64', '条目数是 ZIP64 哨兵值：本预检不实现 ZIP64');
  }
  if (totalEntries > limits.max_entries) {
    return fail('too_many_entries', `条目数 ${String(totalEntries)} 超过预算 ${String(limits.max_entries)}`);
  }
  if (
    centralOffset === ZIP64_SENTINEL ||
    centralSize === ZIP64_SENTINEL ||
    centralOffset + centralSize > bytes.byteLength
  ) {
    return fail('truncated', '中央目录声明的区域超出归档长度');
  }

  const seen = new Set<string>();
  let cursor = centralOffset;
  let totalDeclared = 0;
  let maxEntry = 0;
  let maxRatio = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + CENTRAL_HEADER_SIZE > centralOffset + centralSize) {
      return fail('truncated', `中央目录在第 ${String(index)} 项处提前结束`);
    }
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      return fail('not_a_zip', `中央目录第 ${String(index)} 项签名错误`);
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + CENTRAL_HEADER_SIZE;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > centralOffset + centralSize) {
      return fail('truncated', '条目名超出中央目录区域');
    }
    const path = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(nameStart, nameEnd));

    if ((flags & FLAG_ENCRYPTED) !== 0) {
      return fail('encrypted_entry', `条目已加密，不预检也不解密：${JSON.stringify(path)}`);
    }
    if (method !== 0 && method !== 8) {
      return fail(
        'unsupported_compression',
        `条目 ${JSON.stringify(path)} 的压缩方法 ${String(method)} 不受支持（只支持 0/8）`,
      );
    }
    if (
      compressedSize === ZIP64_SENTINEL ||
      uncompressedSize === ZIP64_SENTINEL ||
      localOffset === ZIP64_SENTINEL
    ) {
      return fail('zip64', `条目 ${JSON.stringify(path)} 使用 ZIP64 字段`);
    }
    const unsafe = pathIsUnsafe(path);
    if (unsafe !== null) {
      return fail('invalid_path', unsafe);
    }
    if (seen.has(path)) {
      return fail('duplicate_path', `条目路径重复：${JSON.stringify(path)}`);
    }
    seen.add(path);

    if (uncompressedSize > limits.max_entry_uncompressed_bytes) {
      return fail(
        'entry_limit_exceeded',
        `条目 ${JSON.stringify(path)} 声明解压后 ${String(uncompressedSize)} 字节，` +
          `超过单条目预算 ${String(limits.max_entry_uncompressed_bytes)}`,
      );
    }
    totalDeclared += uncompressedSize;
    if (totalDeclared > limits.max_total_uncompressed_bytes) {
      return fail(
        'archive_limit_exceeded',
        `声明解压后合计 ${String(totalDeclared)} 字节超过预算 ` +
          `${String(limits.max_total_uncompressed_bytes)}`,
      );
    }
    const ratio = uncompressedSize / Math.max(compressedSize, 1);
    if (ratio > limits.max_compression_ratio) {
      return fail(
        'compression_ratio_exceeded',
        `条目 ${JSON.stringify(path)} 声明压缩比 ${ratio.toFixed(1)} 超过预算 ` +
          `${String(limits.max_compression_ratio)}（疑似 deflate 炸弹）`,
      );
    }
    maxEntry = Math.max(maxEntry, uncompressedSize);
    maxRatio = Math.max(maxRatio, ratio);

    cursor = nameEnd + extraLength + commentLength;
  }

  if (cursor !== centralOffset + centralSize) {
    return fail('truncated', '中央目录解析后偏移与声明结尾不符');
  }

  return Object.freeze({
    ok: true,
    entry_count: totalEntries,
    total_declared_uncompressed_bytes: totalDeclared,
    max_entry_declared_bytes: maxEntry,
    max_declared_compression_ratio: maxRatio,
    decompressed_bytes: 0 as const,
  });
}

// ---------------------------------------------------------------------------
// 失败归类（给 UI / 记账用的一致词表）
// ---------------------------------------------------------------------------

/** 面向调用方的拒绝类别（比 ZIP 内部 reason 更粗，够 UI 与记账用）。 */
export type RejectionClass =
  | 'zip_bomb'
  | 'archive_too_large'
  | 'too_many_entries'
  | 'unsafe_path'
  | 'encrypted'
  | 'unsupported_compression'
  | 'zip64'
  | 'truncated'
  | 'corrupt_archive'
  | 'malformed_workbook';

export interface SpreadsheetInputRejection {
  readonly class: RejectionClass;
  /** ZIP 内部 reason（工作簿层失败时为 `'validation_error'`）。 */
  readonly reason: ZipReadErrorReason | 'validation_error';
  readonly detail: string;
  /** 输入类失败**不可重试**（同一份字节再试一次还是同一结论）。 */
  readonly retryable: false;
}

/** ZIP reason → 面向调用方的类别。 */
export function classifyZipReason(reason: ZipReadErrorReason): RejectionClass {
  switch (reason) {
    case 'compression_ratio_exceeded':
    case 'entry_limit_exceeded':
    case 'archive_limit_exceeded':
      return 'zip_bomb';
    case 'archive_too_large':
      return 'archive_too_large';
    case 'too_many_entries':
      return 'too_many_entries';
    case 'invalid_path':
    case 'duplicate_path':
      return 'unsafe_path';
    case 'encrypted_entry':
      return 'encrypted';
    case 'unsupported_compression':
      return 'unsupported_compression';
    case 'unsupported_zip64':
    case 'size_mismatch':
      return 'zip64';
    case 'truncated':
      return 'truncated';
    case 'invalid_structure':
    case 'crc_mismatch':
      return 'corrupt_archive';
    default: {
      const never: never = reason;
      throw new ValidationError(`未覆盖的 ZIP 拒绝原因：${JSON.stringify(never)}`);
    }
  }
}

function toRejection(error: unknown): SpreadsheetInputRejection {
  if (error instanceof ZipReadError) {
    return Object.freeze({
      class: classifyZipReason(error.reason),
      reason: error.reason,
      detail: error.message,
      retryable: false as const,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return Object.freeze({
    class: 'malformed_workbook' as const,
    reason: 'validation_error' as const,
    detail: message,
    retryable: false as const,
  });
}

// ---------------------------------------------------------------------------
// 有界打开
// ---------------------------------------------------------------------------

export type BoundedOpenResult =
  | { readonly ok: true; readonly document: WorkbookDocument; readonly preflight: PreflightOk }
  | { readonly ok: false; readonly rejection: SpreadsheetInputRejection };

/**
 * 有界打开一份 .xlsx：**先预检（不解压）**，再交给生产读路径做权威校验。
 *
 * - 预检失败 ⇒ 直接返回归类好的拒绝，**不调用**生产读路径（连一次解压都不会发生）；
 * - 预检通过 ⇒ 调 `openWorkbookDocument`；ZIP / 工作簿层错误归成同一套类别返回，
 *   **不抛给调用方**（UI 要的是可展示的拒绝，不是栈）；
 * - 只有 `ZipReadError` 与 `ValidationError` 被归类；其他异常（编程错误）**照抛**，不吞。
 */
export function openWorkbookBounded(
  fileName: string,
  bytes: Uint8Array,
  overrides?: Partial<SpreadsheetInputLimits>,
): BoundedOpenResult {
  const preflight = preflightXlsxBytes(bytes, overrides);
  if (!preflight.ok) {
    return Object.freeze({
      ok: false as const,
      rejection: Object.freeze({
        class: preflightClass(preflight.reason),
        reason: preflightReason(preflight.reason),
        detail: preflight.detail,
        retryable: false as const,
      }),
    });
  }
  try {
    const document = openWorkbookDocument(fileName, bytes);
    return Object.freeze({ ok: true as const, document, preflight });
  } catch (error) {
    if (error instanceof ZipReadError || error instanceof ValidationError) {
      return Object.freeze({ ok: false as const, rejection: toRejection(error) });
    }
    throw error;
  }
}

/** 预检 reason → 面向调用方的类别。 */
function preflightClass(reason: PreflightRejectionReason): RejectionClass {
  switch (reason) {
    case 'compression_ratio_exceeded':
    case 'entry_limit_exceeded':
    case 'archive_limit_exceeded':
      return 'zip_bomb';
    case 'archive_too_large':
      return 'archive_too_large';
    case 'too_many_entries':
      return 'too_many_entries';
    case 'invalid_path':
    case 'duplicate_path':
      return 'unsafe_path';
    case 'encrypted_entry':
      return 'encrypted';
    case 'unsupported_compression':
      return 'unsupported_compression';
    case 'zip64':
      return 'zip64';
    case 'truncated':
    case 'not_a_zip':
      return 'corrupt_archive';
    default: {
      const never: never = reason;
      throw new ValidationError(`未覆盖的预检原因：${JSON.stringify(never)}`);
    }
  }
}

/** 预检 reason → ZIP 词表里的等价 reason（让两条实现可以逐项交叉比对）。 */
function preflightReason(reason: PreflightRejectionReason): ZipReadErrorReason {
  switch (reason) {
    case 'not_a_zip':
      return 'invalid_structure';
    case 'zip64':
      return 'unsupported_zip64';
    case 'truncated':
    case 'too_many_entries':
    case 'archive_too_large':
    case 'entry_limit_exceeded':
    case 'archive_limit_exceeded':
    case 'compression_ratio_exceeded':
    case 'duplicate_path':
    case 'invalid_path':
    case 'encrypted_entry':
    case 'unsupported_compression':
      return reason;
    default: {
      const never: never = reason;
      throw new ValidationError(`未覆盖的预检原因：${JSON.stringify(never)}`);
    }
  }
}

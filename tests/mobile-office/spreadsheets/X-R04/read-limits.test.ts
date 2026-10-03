/**
 * **X-I24 / X-R04 读侧 ZIP 上限接线独立验收**。
 *
 * 背景：X-R04 的 `input-boundary.ts` 提供了一道**独立于生产读路径**的解压前元数据闸
 * （`preflightXlsxBytes`，必要不充分）。X-I03 已在生产读路径 `xlsx-read.ts` 上把
 * `ReadWorkbookOptions.limits` 透传给 `readZip`。本单元**不复用 X-I03 的测试**，
 * 用自己构造的真实形状字节，独立核对这条接线：
 *
 * 1. **参数真的被采纳**：每个上限维度都做**边界钉死**——等于真实值 ⇒ 通过；
 *    比真实值小 1 ⇒ 以**该维度的确切 reason** 拒绝。若 `limits` 被忽略，边界两侧不会分叉。
 * 2. **透传真值**：对同一份字节与同一套 `limits`，`readWorkbookXlsx` 抛出的
 *    `ZipReadError.reason` 必须**逐个等于**直接调 `readZip(bytes, limits)` 的 reason —
 *    这条把"读路径确实把调用方给的覆盖原样转给了 ZIP 层"变成可核对的等式。
 * 3. **两道实现同口径**：同一套预算下，`preflightXlsxBytes`（X-R04 独立实现）与
 *    生产 `readZip` 对同一份字节给出**同等的拒绝**；这是"预检没被改松"的交叉证据。
 * 4. **不是一律拒绝**：把上限放到极松 ⇒ 同一份字节照读；上限只作用于 ZIP 层，
 *    不会把工作簿层校验（缺关系 / 坏 XML 等）一并吞掉。
 * 5. **非法上限显式拒绝**：负数 / 非整数 ⇒ `ZipReadError`（不静默取默认）。
 */

import { describe, expect, it } from 'vitest';

import {
  ZipReadError,
  readZip,
  type ZipReadErrorReason,
} from '../../../../src/artifacts/ooxml/zip-read.js';
import { readWorkbookXlsx } from '../../../../src/spreadsheets/xlsx-read.js';
import {
  preflightXlsxBytes,
  type SpreadsheetInputLimits,
} from './input-boundary.js';
import {
  genuineDeflatedXlsx,
  genuineMissingWorkbookRels,
  genuineXlsxBytes,
} from './genuine-malformed.js';

// ---------------------------------------------------------------------------
// 真实字节的静态量（从真实包量出来，不写死猜测值）
// ---------------------------------------------------------------------------

const GENUINE = genuineXlsxBytes();
const DEFLATED = genuineDeflatedXlsx();

const ZIP_STATS = (() => {
  const entries = readZip(GENUINE).entries;
  return Object.freeze({
    entry_count: entries.length,
    total_uncompressed: entries.reduce((sum, entry) => sum + entry.uncompressed_size, 0),
    max_entry_uncompressed: entries.reduce(
      (max, entry) => Math.max(max, entry.uncompressed_size),
      0,
    ),
    archive_bytes: GENUINE.byteLength,
  });
})();

/** 直接调生产 `readZip`，返回 reason（读通则 `null`）。 */
function zipReason(
  bytes: Uint8Array,
  limits?: Partial<import('../../../../src/artifacts/ooxml/zip-read.js').ZipReadLimits>,
): ZipReadErrorReason | null {
  try {
    readZip(bytes, limits);
    return null;
  } catch (error) {
    if (error instanceof ZipReadError) return error.reason;
    throw error;
  }
}

/** 走 `readWorkbookXlsx`，返回 reason 或 `'ok'`（非 ZIP 层错误返回错误名，便于区分）。 */
function readReason(
  bytes: Uint8Array,
  limits?: Partial<import('../../../../src/artifacts/ooxml/zip-read.js').ZipReadLimits>,
): ZipReadErrorReason | 'ok' | string {
  try {
    readWorkbookXlsx(bytes, limits === undefined ? undefined : { limits });
    return 'ok';
  } catch (error) {
    if (error instanceof ZipReadError) return error.reason;
    return error instanceof Error ? error.name : String(error);
  }
}

// ---------------------------------------------------------------------------
// §1 前提：默认上限下，真形状字节读得通
// ---------------------------------------------------------------------------

describe('X-I24 §1 前提：默认上限下真形状字节读得通', () => {
  it('无 options / 空 options 都读出双子表（否则下面的"拒绝"没有信息量）', () => {
    expect(readWorkbookXlsx(GENUINE).workbook.sheets.map((sheet) => sheet.name)).toEqual([
      '预算',
      '明细',
    ]);
    expect(readWorkbookXlsx(GENUINE, {}).workbook.sheets).toHaveLength(2);
    expect(zipReason(GENUINE)).toBeNull();
    // 真实包的静态量自洽（供下面边界钉死用）。
    expect(ZIP_STATS.entry_count).toBeGreaterThan(1);
    expect(ZIP_STATS.max_entry_uncompressed).toBeLessThanOrEqual(ZIP_STATS.total_uncompressed);
  });
});

// ---------------------------------------------------------------------------
// §2 参数被采纳：每个维度边界钉死（等于⇒过，小 1⇒以该维度 reason 拒）
// ---------------------------------------------------------------------------

describe('X-I24 §2 caller-supplied limits 被读路径采纳（边界钉死）', () => {
  it('maxEntries：= 条目数 ⇒ 过；= 条目数-1 ⇒ too_many_entries', () => {
    const exact = ZIP_STATS.entry_count;
    expect(readReason(GENUINE, { maxEntries: exact })).toBe('ok');
    expect(readReason(GENUINE, { maxEntries: exact - 1 })).toBe('too_many_entries');
    expect(zipReason(GENUINE, { maxEntries: exact - 1 })).toBe('too_many_entries');
  });

  it('maxEntryUncompressedBytes：= 最大条目 ⇒ 过；-1 ⇒ entry_limit_exceeded', () => {
    const exact = ZIP_STATS.max_entry_uncompressed;
    expect(readReason(GENUINE, { maxEntryUncompressedBytes: exact })).toBe('ok');
    expect(readReason(GENUINE, { maxEntryUncompressedBytes: exact - 1 })).toBe(
      'entry_limit_exceeded',
    );
  });

  it('maxTotalUncompressedBytes：= 全包合计 ⇒ 过；-1 ⇒ archive_limit_exceeded', () => {
    const exact = ZIP_STATS.total_uncompressed;
    expect(readReason(GENUINE, { maxTotalUncompressedBytes: exact })).toBe('ok');
    expect(readReason(GENUINE, { maxTotalUncompressedBytes: exact - 1 })).toBe(
      'archive_limit_exceeded',
    );
  });

  it('maxArchiveBytes：= 归档字节 ⇒ 过；-1 ⇒ archive_too_large', () => {
    const exact = ZIP_STATS.archive_bytes;
    expect(readReason(GENUINE, { maxArchiveBytes: exact })).toBe('ok');
    expect(readReason(GENUINE, { maxArchiveBytes: exact - 1 })).toBe('archive_too_large');
  });

  it('maxCompressionRatio：真 deflate 包 比值 2.88 ⇒ 2 拒、3 过', () => {
    // 前提核对：这份字节**真的**被 deflate 压缩（否则比值闸没东西可卡）。
    expect(zipReason(DEFLATED)).toBeNull();
    const ratios = readZip(DEFLATED).entries.map(
      (entry) => entry.uncompressed_size / Math.max(entry.compressed_size, 1),
    );
    const maxRatio = Math.max(...ratios);
    expect(maxRatio).toBeGreaterThan(2);
    expect(maxRatio).toBeLessThan(3);

    expect(readReason(DEFLATED, { maxCompressionRatio: 2 })).toBe('compression_ratio_exceeded');
    expect(readReason(DEFLATED, { maxCompressionRatio: 3 })).toBe('ok');
  });

  it('上限只影响被指定的维度（其它维度保持默认，不一并收紧）', () => {
    // 只把条目数收到刚好够 ⇒ 其余维度仍是默认，读通。
    expect(readReason(GENUINE, { maxEntries: ZIP_STATS.entry_count })).toBe('ok');
    // 只把归档字节收到刚好够 ⇒ 读通。
    expect(readReason(GENUINE, { maxArchiveBytes: ZIP_STATS.archive_bytes })).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// §3 透传真值：readWorkbookXlsx 的 reason === 直接 readZip 的 reason
// ---------------------------------------------------------------------------

describe('X-I24 §3 读路径把调用方 limits 原样转给 readZip（逐项等式）', () => {
  const table: readonly {
    readonly name: string;
    readonly limits: Partial<import('../../../../src/artifacts/ooxml/zip-read.js').ZipReadLimits>;
    readonly expected: ZipReadErrorReason;
  }[] = [
    { name: '条目数', limits: { maxEntries: 2 }, expected: 'too_many_entries' },
    {
      name: '单条目解压量',
      limits: { maxEntryUncompressedBytes: 100 },
      expected: 'entry_limit_exceeded',
    },
    {
      name: '全包解压量',
      limits: { maxTotalUncompressedBytes: 200 },
      expected: 'archive_limit_exceeded',
    },
    { name: '归档字节', limits: { maxArchiveBytes: 16 }, expected: 'archive_too_large' },
  ];

  for (const row of table) {
    it(`${row.name}上限：满足调用方数值时 readWorkbookXlsx 与 readZip 给同一 reason（${row.expected}）`, () => {
      // 直接 readZip 的权威结论。
      expect(zipReason(GENUINE, row.limits)).toBe(row.expected);
      // readWorkbookXlsx 必须逐字相同 —— 若它没把 limits 转下去，这里会得到 'ok'。
      expect(readReason(GENUINE, row.limits)).toBe(row.expected);
    });
  }

  it('非法上限（负数 / 非整数）经 readWorkbookXlsx 仍以 ZipReadError 显式拒绝', () => {
    expect(() => readWorkbookXlsx(GENUINE, { limits: { maxEntries: -1 } })).toThrow(ZipReadError);
    expect(() =>
      readWorkbookXlsx(GENUINE, { limits: { maxEntryUncompressedBytes: 1.5 } }),
    ).toThrow(ZipReadError);
    // 且 reason 与直接 readZip 一致（同一套校验）。
    expect(readReason(GENUINE, { maxEntries: -1 })).toBe(
      zipReason(GENUINE, { maxEntries: -1 }),
    );
  });
});

// ---------------------------------------------------------------------------
// §4 两道实现同口径：预检（独立）与生产对同一预算给同等拒绝
// ---------------------------------------------------------------------------

describe('X-I24 §4 独立预检与生产读路径在 caller 预算下同口径', () => {
  /** X-R04 预算 → 生产 ZipReadLimits 覆盖（字段名不同，这里显式映射）。 */
  function toZipLimits(overrides: Partial<SpreadsheetInputLimits>): Record<string, number> {
    const out: Record<string, number> = {};
    if (overrides.max_entries !== undefined) out.maxEntries = overrides.max_entries;
    if (overrides.max_entry_uncompressed_bytes !== undefined) {
      out.maxEntryUncompressedBytes = overrides.max_entry_uncompressed_bytes;
    }
    if (overrides.max_total_uncompressed_bytes !== undefined) {
      out.maxTotalUncompressedBytes = overrides.max_total_uncompressed_bytes;
    }
    if (overrides.max_compression_ratio !== undefined) {
      out.maxCompressionRatio = overrides.max_compression_ratio;
    }
    if (overrides.max_archive_bytes !== undefined) {
      out.maxArchiveBytes = overrides.max_archive_bytes;
    }
    return out;
  }

  const rows: readonly {
    readonly name: string;
    readonly bytes: Uint8Array;
    readonly mobile: Partial<SpreadsheetInputLimits>;
    readonly preflight_reason: string;
    readonly zip_reason: ZipReadErrorReason;
  }[] = [
    {
      name: '条目数',
      bytes: GENUINE,
      mobile: { max_entries: ZIP_STATS.entry_count - 1 },
      preflight_reason: 'too_many_entries',
      zip_reason: 'too_many_entries',
    },
    {
      name: '单条目解压量',
      bytes: GENUINE,
      mobile: { max_entry_uncompressed_bytes: ZIP_STATS.max_entry_uncompressed - 1 },
      preflight_reason: 'entry_limit_exceeded',
      zip_reason: 'entry_limit_exceeded',
    },
    {
      name: '全包解压量',
      bytes: GENUINE,
      mobile: { max_total_uncompressed_bytes: ZIP_STATS.total_uncompressed - 1 },
      preflight_reason: 'archive_limit_exceeded',
      zip_reason: 'archive_limit_exceeded',
    },
    {
      name: '归档字节',
      bytes: GENUINE,
      mobile: { max_archive_bytes: ZIP_STATS.archive_bytes - 1 },
      preflight_reason: 'archive_too_large',
      zip_reason: 'archive_too_large',
    },
    {
      name: '压缩比（真 deflate 包）',
      bytes: DEFLATED,
      mobile: { max_compression_ratio: 2 },
      preflight_reason: 'compression_ratio_exceeded',
      zip_reason: 'compression_ratio_exceeded',
    },
  ];

  for (const row of rows) {
    it(`${row.name}：预检拒绝（${row.preflight_reason}）⟺ 生产 readWorkbookXlsx 也拒（${row.zip_reason}）`, () => {
      const preflight = preflightXlsxBytes(row.bytes, row.mobile);
      expect(preflight.ok).toBe(false);
      if (preflight.ok) return;
      expect(preflight.reason).toBe(row.preflight_reason);
      expect(preflight.decompressed_bytes).toBe(0);
      expect(readReason(row.bytes, toZipLimits(row.mobile))).toBe(row.zip_reason);
    });
  }

  it('预检通过 ⟺ 生产在**同预算**下不因 ZIP 层拒绝（必要不充分的半侧证据）', () => {
    // 把每个维度都放到极松 ⇒ 预检通过；生产也不因 ZIP 层拒绝（它读出双子表）。
    // maxEntries 有 ZIP 经典字段硬顶 65535（见 zip-read.ts `ZIP_MAX_ENTRIES`），故取该上限。
    const lax: Partial<SpreadsheetInputLimits> = {
      max_archive_bytes: 1 << 30,
      max_entries: 65535,
      max_entry_uncompressed_bytes: 1 << 30,
      max_total_uncompressed_bytes: 1 << 30,
      max_compression_ratio: 1 << 20,
    };
    expect(preflightXlsxBytes(GENUINE, lax).ok).toBe(true);
    expect(readReason(GENUINE, toZipLimits(lax))).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// §5 不是一律拒绝 + 上限不越过工作簿层校验
// ---------------------------------------------------------------------------

describe('X-I24 §5 松弛上限照读；上限不吞工作簿层校验', () => {
  it('极松上限 ⇒ 同一份字节仍读出双子表（证明上面的拒绝源于数值，而非读路径坏了）', () => {
    const lax = {
      maxEntries: 65535,
      maxEntryUncompressedBytes: 1 << 30,
      maxTotalUncompressedBytes: 1 << 30,
      maxCompressionRatio: 1 << 20,
      maxArchiveBytes: 1 << 30,
    };
    const result = readWorkbookXlsx(GENUINE, { limits: lax });
    expect(result.workbook.sheets.map((sheet) => sheet.name)).toEqual(['预算', '明细']);
  });

  it('上限只作用于 ZIP 层：松弛上限下，缺 workbook 关系的包仍以 ValidationError 被拒', () => {
    const lax = { maxEntries: 65535, maxArchiveBytes: 1 << 30 };
    // ZIP 层：结构完整、过得了闸。
    expect(zipReason(genuineMissingWorkbookRels(), lax)).toBeNull();
    // 工作簿层：仍然拒绝，且**不是** ZipReadError（limits 没把它一起放过）。
    expect(() => readWorkbookXlsx(genuineMissingWorkbookRels(), { limits: lax })).toThrowError(
      /rId1|关系/,
    );
  });
});

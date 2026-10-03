/**
 * WCF-D52：`DEFAULT_ZIP_READ_LIMITS` 各常数与 R163 容量目标的**一致性核对**（常开用例）。
 *
 * ## 为什么要有它（D11 N6 的原话）
 *
 * D11 独立审查核实：`zip-read.ts` 的四条上限「**为 R163 预留了余量**（注释也这么说），
 * 但**没有任何测试证明**这些常数足以吃下 R163 的目标」。本文件补的正是这一步：
 * 把"注释里说够"变成"读得进去的实测"。
 *
 * ## 本文件**只读**生产代码，不改任何常数
 *
 * 常数是 WCF-D02 的交付物，改它不在本任务写权内。本文件做三件事：
 * 1. **算术核对**：每个上限 vs R163 基线（≥500 段 / ≥5 万汉字 / ≥100 图 / ≥10 MiB），打印余量倍数；
 * 2. **真实准入**：用真实 `writeZip`（STORE）造一份 >10 MiB、104 个条目（100 媒体 + 4 部件）
 *    的归档，用真实 `readZip` 读回来——证明这四条约数**不是纸面数字**；
 * 3. **守卫不是死代码**（R168 精神）：逐条把某一上限调到刚好不够，确认对应错误码**真的会开火**，
 *    而不是配置了却永远用不上。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ZIP_READ_LIMITS,
  ZipReadError,
  readZip,
} from '../../../src/artifacts/ooxml/zip-read.js';
import { writeZip } from '../../../src/artifacts/ooxml/zip.js';
import { R163_BASELINE } from './support.js';

/** 确定性伪随机字节（xorshift32；不用 `Math.random`，保证可复现）。 */
function noiseBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0 || 0x9e3779b9;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    out[index] = state & 0xff;
  }
  return out;
}

/** 造一份"≥100 图 + ≥10 MiB"的真实 DOCX 形状归档（STORE 写入器，无压缩）。 */
function bigArchive(): { bytes: Uint8Array; mediaCount: number; totalBytes: number } {
  const mediaCount = 120;
  const perImage = 96 * 1024; // 每张 96 KiB ⇒ 120 张 ≈ 11.25 MiB
  const entries = [
    { path: '[Content_Types].xml', data: noiseBytes(2048, 11) },
    { path: '_rels/.rels', data: noiseBytes(1024, 22) },
    { path: 'word/document.xml', data: noiseBytes(64 * 1024, 33) },
    ...Array.from({ length: mediaCount }, (_, index) => ({
      path: `word/media/image${index + 1}.png`,
      data: noiseBytes(perImage, 1000 + index),
    })),
  ];
  const bytes = new Uint8Array(writeZip(entries));
  const totalBytes = entries.reduce((sum, entry) => sum + entry.data.byteLength, 0);
  return { bytes, mediaCount, totalBytes };
}

describe('DEFAULT_ZIP_READ_LIMITS 与 R163 容量基线的一致性（只读核对）', () => {
  it('四条上限都能容下 R163 的 ≥100 图 / ≥10 MiB 目标（并打印余量）', () => {
    const limits = DEFAULT_ZIP_READ_LIMITS;
    const modelDocxBytes = 10 * 1024 * 1024; // R163 的容器下限（10 MiB 是二进制口径）
    // 一份 ≥100 图的 DOCX 的**条目数**：100 媒体 + 内容类型 + 包关系 + 主部件 + 部件关系 = 104
    const entriesFor100Images = 100 + 4;

    // 归档总字节上限必须容下 10 MiB
    expect(limits.maxArchiveBytes, 'maxArchiveBytes 容不下 10 MiB DOCX')
      .toBeGreaterThanOrEqual(modelDocxBytes);
    // 单条目上限必须容下 10 MiB（一份只含一个巨部件的包也不能被判超限）
    expect(limits.maxEntryUncompressedBytes).toBeGreaterThanOrEqual(modelDocxBytes);
    // 全包解压上限必须容下 10 MiB
    expect(limits.maxTotalUncompressedBytes).toBeGreaterThanOrEqual(modelDocxBytes);
    // 条目数上限必须容下 100 图规模的包
    expect(limits.maxEntries).toBeGreaterThanOrEqual(entriesFor100Images);

    // 余量（供报告引用；不是在"差不多"，是明确的倍数）
    const headroom = {
      archive: limits.maxArchiveBytes / modelDocxBytes,
      entry: limits.maxEntryUncompressedBytes / modelDocxBytes,
      total: limits.maxTotalUncompressedBytes / modelDocxBytes,
      entries: limits.maxEntries / entriesFor100Images,
    };
    expect(headroom.archive).toBeGreaterThan(1);
    expect(limits.maxCompressionRatio).toBeGreaterThan(1);
  });

  it('真实读取一份 >10 MiB、>100 图规模的归档：四条上限都不越界', () => {
    const { bytes, mediaCount, totalBytes } = bigArchive();
    expect(mediaCount).toBeGreaterThanOrEqual(100);
    expect(bytes.byteLength).toBeGreaterThan(10 * 1024 * 1024);
    expect(bytes.byteLength).toBeLessThanOrEqual(DEFAULT_ZIP_READ_LIMITS.maxArchiveBytes);

    const started = performance.now();
    const archive = readZip(bytes);
    const elapsed = performance.now() - started;

    // 条目数 = 3 个固定部件（内容类型 / 包关系 / 主部件）+ mediaCount 张媒体
    expect(archive.entries.length).toBe(mediaCount + 3);
    const media = archive.entries.filter((entry) => entry.path.startsWith('word/media/'));
    expect(media.length).toBeGreaterThanOrEqual(100);
    // 解压后合计必须与写入前一致——证明读侧没有静默截断（R163：不隐藏截断）
    expect(archive.total_uncompressed_bytes).toBe(totalBytes);
    expect(elapsed).toBeLessThan(60_000);
  });

  it('R159 的四条上限**不是死代码**：逐条收紧后，对应错误码真的开火', () => {
    const bytes = new Uint8Array(writeZip([
      { path: 'word/document.xml', data: noiseBytes(4096, 7) },
    ]));

    const reasons: string[] = [];
    const catches = (fn: () => unknown): string => {
      try {
        fn();
      } catch (error) {
        if (error instanceof ZipReadError) { reasons.push(error.reason); return error.reason; }
        throw error;
      }
      throw new Error('期望抛 ZipReadError，但没有抛');
    };

    expect(catches(() => readZip(bytes, { maxArchiveBytes: 1024 }))).toBe('archive_too_large');
    expect(catches(() => readZip(bytes, { maxEntryUncompressedBytes: 100 })))
      .toBe('entry_limit_exceeded');
    expect(catches(() => readZip(bytes, { maxTotalUncompressedBytes: 100 })))
      .toBe('archive_limit_exceeded');
    // STORE 条目的压缩比恒为 1.0；把上限压到 0 就能确认这条判据真的在跑。
    expect(catches(() => readZip(bytes, { maxCompressionRatio: 0 })))
      .toBe('compression_ratio_exceeded');
    expect(catches(() => readZip(bytes, { maxEntries: 0 }))).toBe('too_many_entries');
    expect(reasons).toHaveLength(5);
  });

  it('基线口径登记在测试里，避免"报告说达标但没人知道基线是多少"', () => {
    expect(R163_BASELINE).toEqual({
      paragraphs: 500, hanzi: 50_000, images: 100, archiveBytes: 10 * 1024 * 1024,
    });
  });
});

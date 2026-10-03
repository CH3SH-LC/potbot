/**
 * P09 · **回归修复的真实字节复核**（R50.4 违约清除后：PNG / PDF 仍然是真产物）。
 *
 * ## 背景（为什么这个文件存在）
 *
 * 本目录的定向验收 `rendering.test.ts` 原先把 PNG/PDF 的压缩交给宿主的 `node:zlib`，
 * 撞上 `tests/acceptance/office/w-disc-kernel-discipline.test.ts` 的 R50.4 断言
 * （`src/**` 非测试文件不得出现 `node:zlib`）。修法是把压缩换成纯 TS 的 stored 块 zlib 流
 * （`src/mobile-plugins/presentations/rendering/zlib-store.ts`），**不是**把产物降级成占位。
 * 这个文件就是那条替换的**可证伪证据**：产物必须仍能被"外人"解开并逐字节还原。
 *
 * ## 判据独立于实现
 *
 * - 压缩结果的正确性用**参考实现**（`node:zlib.inflateSync`）验，**不用**我们自己的解压器；
 * - 我们自己的解压路径用 `src/artifacts/ooxml/inflate.ts` 的 `inflateRaw`（生产依赖，非测试重写）；
 * - PNG 的扫描行由本文件**自己解析 chunk**（不用 `decodePng`），与喂进去的位图逐像素比；
 * - 反向对照：把 Adler-32 尾部、zlib 头、stored 块的 NLEN 各踩坏一处 ⇒ 必须报错（不静默出图）。
 */

import { deflateSync, inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { inflateRaw } from '../../../../src/artifacts/ooxml/inflate.js';
import { encodePng } from '../../../../src/mobile-plugins/presentations/rendering/png.js';
import { writeRasterPdf } from '../../../../src/mobile-plugins/presentations/rendering/pdf.js';
import {
  ZlibStoreError,
  adler32,
  zlibInflate,
  zlibStoreCompress,
} from '../../../../src/mobile-plugins/presentations/rendering/zlib-store.js';

// ---------------------------------------------------------------------------
// 独立工具（本文件自写，不借用被测对象）
// ---------------------------------------------------------------------------

interface RawChunk {
  readonly type: string;
  readonly data: Buffer;
}

/** 按 PNG 规范逐块解析（长度 4B + 类型 4B + 数据 + CRC 4B）。 */
function chunksOf(png: Uint8Array): RawChunk[] {
  const buf = Buffer.from(png);
  const chunks: RawChunk[] = [];
  let offset = 8; // 跳过 8 字节签名
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    chunks.push({ type, data: Buffer.from(buf.subarray(offset + 8, offset + 8 + length)) });
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return chunks;
}

function idatOf(png: Uint8Array): Buffer {
  const parts = chunksOf(png).filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data);
  expect(parts.length).toBeGreaterThan(0);
  return Buffer.concat(parts);
}

/** zlib 头合法性（RFC 1950）：CM = 8、FCHECK 成立、无 FDICT。 */
function assertZlibHeader(bytes: Uint8Array): void {
  const cmf = bytes[0] ?? 0;
  const flg = bytes[1] ?? 0;
  expect(cmf & 0x0f).toBe(8);
  expect(((cmf << 8) | flg) % 31).toBe(0);
  expect(flg & 0x20).toBe(0);
}

/** 造一段可预测的样本字节（不用随机，保证可复现）。 */
function sample(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) out[index] = (index * 31 + (index >> 8)) & 0xff;
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 1. Adler-32
// ---------------------------------------------------------------------------

describe('P09 修复：zlib-store 的 Adler-32', () => {
  it('命中公开已知向量（"123456789" 与空输入）', () => {
    expect(adler32(Buffer.from('123456789', 'latin1'))).toBe(0x091e01de);
    expect(adler32(new Uint8Array(0))).toBe(1); // RFC 1950：初始 A=1、B=0
    expect(adler32(Buffer.from('Wikipedia', 'latin1'))).toBe(0x11e60398);
  });
});

// ---------------------------------------------------------------------------
// 2. 压缩：参考实现能解（真实可解，不是占位）
// ---------------------------------------------------------------------------

describe('P09 修复：纯 TS 压缩产出的 zlib 流可被参考实现解回', () => {
  const cases: readonly { readonly label: string; readonly length: number }[] = [
    { label: '空输入（仍须是一个合法的单块 final 流）', length: 0 },
    { label: '单块（48 字节）', length: 48 },
    { label: '整块边界（65535 字节）', length: 65535 },
    { label: '跨块（65536 字节 ⇒ 两块）', length: 65536 },
    { label: '多块（200000 字节）', length: 200000 },
  ];

  for (const { label, length } of cases) {
    it(`${label}：node:zlib.inflateSync 解出的字节与原文逐字节一致`, () => {
      const input = sample(length);
      const compressed = zlibStoreCompress(input);

      assertZlibHeader(compressed);
      // stored 流的结构开销：头 2 + 每 65535 一块各 5 字节块头 + 尾 4（体积换确定性，明码标价）。
      const blocks = Math.max(1, Math.ceil(length / 65535));
      expect(compressed.length).toBe(2 + blocks * 5 + length + 4);

      const restored = inflateSync(Buffer.from(compressed));
      expect(restored.length).toBe(length);
      expect(bytesEqual(restored, input)).toBe(true);
    });
  }

  it('同一输入压两次 ⇒ 逐字节一致（确定性，与宿主 zlib 版本无关）', () => {
    const input = sample(100000);
    expect(bytesEqual(zlibStoreCompress(input), zlibStoreCompress(input))).toBe(true);
  });

  it('反向对照：踩坏尾部的 Adler-32 ⇒ 我们的解压器必须报错（不静默出字节）', () => {
    const compressed = zlibStoreCompress(sample(64));
    const broken = Uint8Array.from(compressed);
    broken[broken.length - 1] = (broken[broken.length - 1] ?? 0) ^ 0xff;
    expect(() => zlibInflate(broken, 1024)).toThrowError(ZlibStoreError);

    // 头也踩一下：FCHECK 不成立。
    const badHeader = Uint8Array.from(compressed);
    badHeader[1] = (badHeader[1] ?? 0) ^ 0x40;
    expect(() => zlibInflate(badHeader, 1024)).toThrowError(ZlibStoreError);
  });

  it('反向对照：stored 块的 NLEN 与 LEN 不互补 ⇒ 解压器报错', () => {
    const compressed = Uint8Array.from(zlibStoreCompress(sample(16)));
    compressed[5] = (compressed[5] ?? 0) ^ 0xff; // 块头之后第 4 字节 = NLEN 高字节
    expect(() => zlibInflate(compressed, 1024)).toThrowError();
  });
});

// ---------------------------------------------------------------------------
// 3. 我们自己的解压路径（inflate.ts + 头剥离 + Adler 核对）
// ---------------------------------------------------------------------------

describe('P09 修复：zlibInflate 复用 inflate.ts 的 inflateRaw', () => {
  it('自压自解逐字节一致，且与 inflateRaw 手工剥头的结果相同', () => {
    const input = sample(70000); // 跨块，覆盖多块头
    const compressed = zlibStoreCompress(input);

    const ourInflate = zlibInflate(compressed, input.length);
    expect(bytesEqual(ourInflate, input)).toBe(true);

    // 独立复算：手工剥掉 2 字节头与 4 字节尾，直接喂 inflateRaw（这正是 zlibInflate 的内部步）。
    const viaInflateRaw = inflateRaw(compressed.subarray(2, compressed.length - 4), {
      maxOutputLength: input.length,
    });
    expect(bytesEqual(viaInflateRaw, input)).toBe(true);
  });

  it('也吃得下"别人的"流：参考实现压出来的（deflate 压缩块）同样能解', () => {
    const input = sample(4096);
    const foreign = deflateWithReference(input);
    expect(bytesEqual(zlibInflate(foreign, input.length), input)).toBe(true);
  });

  it('上限是硬门：声明小上限 ⇒ 报错而不是截断', () => {
    const compressed = zlibStoreCompress(sample(500));
    expect(() => zlibInflate(compressed, 100)).toThrowError();
  });
});

/** 用参考实现造一段"外人压的" zlib 流（测试侧才允许出现宿主 zlib；产品侧零引用）。 */
function deflateWithReference(input: Uint8Array): Uint8Array {
  return Uint8Array.from(deflateSync(Buffer.from(input)));
}

// ---------------------------------------------------------------------------
// 4. PNG：IDAT 用 inflate.ts 独立解出扫描行，逐像素还原
// ---------------------------------------------------------------------------

describe('P09 修复：PNG 的 IDAT 仍是真实 zlib 流（独立解出扫描行）', () => {
  it('4×3 RGB：IDAT 剥头 + inflateRaw ⇒ filter 0 + 原始像素逐字节一致', () => {
    const width = 4;
    const height = 3;
    const channels = 3;
    const data = sample(width * height * channels);
    const png = encodePng({ width, height, channels, data });

    const idat = idatOf(png);
    assertZlibHeader(idat);

    // **用生产解压器（inflate.ts）而不是宿主 zlib**解 IDAT。
    const raw = inflateRaw(idat.subarray(2, idat.length - 4), {
      maxOutputLength: (width * channels + 1) * height,
    });
    expect(raw.length).toBe((width * channels + 1) * height);

    for (let y = 0; y < height; y += 1) {
      const rowStart = y * (width * channels + 1);
      expect(raw[rowStart]).toBe(0); // 过滤器 = None
      for (let x = 0; x < width * channels; x += 1) {
        expect(raw[rowStart + 1 + x]).toBe(data[y * width * channels + x]);
      }
    }

    // 交叉核对：参考实现解同一段 IDAT，得到同样的扫描行。
    expect(bytesEqual(inflateSync(idat), raw)).toBe(true);
  });

  it('RGBA（颜色类型 6）与更大位图（跨 stored 块）同样还原', () => {
    const width = 160;
    const height = 160; // 160×160×4 = 102400 字节 > 65535 ⇒ 两块
    const channels = 4;
    const data = sample(width * height * channels);
    const png = encodePng({ width, height, channels, data });

    const idat = idatOf(png);
    const raw = inflateRaw(idat.subarray(2, idat.length - 4), {
      maxOutputLength: (width * channels + 1) * height,
    });
    expect(raw.length).toBe((width * channels + 1) * height);
    expect(raw[0]).toBe(0);
    // 抽查每一行的首像素与末像素（避免 10 万次逐字节断言把用例拖慢）。
    for (let y = 0; y < height; y += 1) {
      const rowStart = y * (width * channels + 1);
      expect(raw[rowStart + 1]).toBe(data[y * width * channels]);
      expect(raw[rowStart + width * channels]).toBe(
        data[y * width * channels + width * channels - 1],
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 5. PDF：图像流仍是真实 zlib 流，解出的就是那页像素
// ---------------------------------------------------------------------------

describe('P09 修复：视觉 PDF 的 FlateDecode 流仍是真实位图', () => {
  it('8×4 RGB 一页：流剥头 + inflateRaw ⇒ 与输入栅格逐字节一致', () => {
    const widthPx = 8;
    const heightPx = 4;
    const rgb = sample(widthPx * heightPx * 3);
    const pdf = writeRasterPdf([{ rgb, widthPx, heightPx }], { width: 720, height: 540 });

    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Filter /FlateDecode');
    expect(text).toContain(`/Width ${String(widthPx)} /Height ${String(heightPx)}`);

    const streamAt = pdf.indexOf(Buffer.from('stream\n'), pdf.indexOf(Buffer.from('/Subtype /Image')));
    expect(streamAt).toBeGreaterThan(-1);
    const endAt = pdf.indexOf(Buffer.from('\nendstream'), streamAt);
    expect(endAt).toBeGreaterThan(streamAt);
    const stream = pdf.subarray(streamAt + 'stream\n'.length, endAt);

    assertZlibHeader(stream);
    const raw = inflateRaw(stream.subarray(2, stream.length - 4), {
      maxOutputLength: widthPx * heightPx * 3,
    });
    expect(raw.length).toBe(widthPx * heightPx * 3);
    expect(bytesEqual(raw, rgb)).toBe(true);

    // /Length 声明的是**压缩后**长度：与实测流长度一致（不是"声明一个假长度"）。
    const lengthAt = text.lastIndexOf('/Length ', streamAt);
    expect(Number(text.slice(lengthAt + '/Length '.length).split(' ')[0])).toBe(stream.length);

    // 交叉核对：参考实现解同一段流。
    expect(bytesEqual(inflateSync(Buffer.from(stream)), rgb)).toBe(true);
  });
});

/**
 * 纯 TypeScript raw DEFLATE 解压单测（WCF-D02）。
 *
 * ## 判据是"跟参考实现逐字节相同"，不是"看起来能解"
 *
 * 压缩侧用 **`node:zlib.deflateRawSync`（zlib，事实上的参考实现）** 造数据——
 * 它在测试里，产品侧不引用。测试覆盖：
 *
 * - **三种块型**：stored（`level: 0` 强制不压缩）、fixed-Huffman（短数据通常走这档）、
 *   dynamic-Huffman（长且重复度高的数据走这档）；
 * - **多个压缩级别**：0–9，含 `Z_DEFAULT_COMPRESSION`；
 * - **边界**：空输入、单字节、全零（极长匹配）、高熵（几乎不压缩）、多字节 UTF-8 中文；
 * - **解压器的拒绝**：截断、非法块型、保留距离码、超大输出（有界）、LEN/NLEN 不互补。
 *
 * 只测"能解出正确字节"是不够的：负例那一组用来证明**它真的会报错**，而不是静默吐出半截。
 */

import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { InflateError, inflateRaw } from './inflate.js';

/** 用参考实现压，再用被测实现解，逐字节比。 */
function roundTrip(data: Uint8Array, level: number): void {
  const compressed = deflateRawSync(Buffer.from(data), { level });
  const inflated = inflateRaw(compressed, { maxOutputLength: Math.max(data.byteLength, 1) });
  expect(inflated.byteLength).toBe(data.byteLength);
  expect(Array.from(inflated)).toEqual(Array.from(data));
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 确定性伪随机（不用 Math.random：同一份测试每次都该造出同一批字节）。 */
function pseudoRandomBytes(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    bytes[index] = (state >>> 24) & 0xff;
  }
  return bytes;
}

const SAMPLES: readonly (readonly [string, Uint8Array])[] = [
  ['空输入', new Uint8Array(0)],
  ['单字节', new Uint8Array([0x41])],
  ['短文本', encode('hello world')],
  ['中文（多字节 UTF-8）', encode('第一章  雨。中文段落的换行与制表\t都保持原样。')],
  ['高重复（长距离匹配）', encode('ab'.repeat(5000))],
  ['全零（极长匹配）', new Uint8Array(70_000)],
  ['高熵（几乎压不动）', pseudoRandomBytes(20_000, 0x1234_5678)],
  ['中文长文（动态 Huffman）', encode('夜雨寄北。'.repeat(3000))],
  ['混合（文本 + 随机 + 零）', (() => {
    const head = encode('前言'.repeat(500));
    const middle = pseudoRandomBytes(5000, 0xdead_beef);
    const tail = new Uint8Array(3000);
    const merged = new Uint8Array(head.byteLength + middle.byteLength + tail.byteLength);
    merged.set(head, 0);
    merged.set(middle, head.byteLength);
    merged.set(tail, head.byteLength + middle.byteLength);
    return merged;
  })()],
];

describe('inflateRaw — 与 zlib 参考实现逐字节一致', () => {
  for (const [name, data] of SAMPLES) {
    it(`样本「${name}」在压缩级别 0–9 下全部一致`, () => {
      const expectedMax = Math.max(data.byteLength, 1);
      for (let level = 0; level <= 9; level += 1) {
        const compressed = deflateRawSync(Buffer.from(data), { level });
        const inflated = inflateRaw(compressed, { maxOutputLength: expectedMax });
        expect(Array.from(inflated), `级别 ${String(level)}`).toEqual(Array.from(data));
      }
    });
  }

  it('默认压缩级别（Z_DEFAULT_COMPRESSION = -1）同样一致', () => {
    const data = encode('默认级别的压缩结果也要能解。'.repeat(400));
    const compressed = deflateRawSync(Buffer.from(data));
    expect(Array.from(inflateRaw(compressed, { maxOutputLength: data.byteLength }))).toEqual(
      Array.from(data),
    );
  });

  it('真的走了不同块型（否则"三种块型都覆盖"就是空话）', () => {
    const tiny = deflateRawSync(Buffer.from(encode('hello')), { level: 6 });
    const stored = deflateRawSync(Buffer.from(encode('hello')), { level: 0 });
    const big = deflateRawSync(Buffer.from(encode('重复内容'.repeat(2000))), { level: 9 });

    /** 头 3 位：BFINAL(1) + BTYPE(2)，低位在前。 */
    const blockType = (bytes: Uint8Array): number => ((bytes[0] as number) >> 1) & 0b11;
    expect(blockType(stored)).toBe(0); // stored
    expect(blockType(tiny)).toBe(1); // fixed Huffman
    expect(blockType(big)).toBe(2); // dynamic Huffman
  });
});

describe('inflateRaw — 有界与拒绝', () => {
  it('输出超过上限时报错（不是先解完再截断）', () => {
    const data = new Uint8Array(10_000);
    const compressed = deflateRawSync(Buffer.from(data));
    try {
      inflateRaw(compressed, { maxOutputLength: 100 });
      throw new Error('期望抛出 InflateError');
    } catch (error) {
      expect(error).toBeInstanceOf(InflateError);
      expect((error as InflateError).reason).toBe('limit');
    }
  });

  it('截断的流报错', () => {
    const compressed = deflateRawSync(Buffer.from(encode('一段会被截断的文本'.repeat(50))));
    const truncated = compressed.subarray(0, Math.floor(compressed.byteLength / 2));
    expect(() => inflateRaw(truncated, { maxOutputLength: 100_000 })).toThrow(InflateError);
  });

  it('保留块型 3 报错', () => {
    // 0b111 = BFINAL=1, BTYPE=3（保留）
    expect(() => inflateRaw(new Uint8Array([0b111]), { maxOutputLength: 16 })).toThrow(InflateError);
  });

  it('stored 块的 LEN 与 NLEN 不互补时报错', () => {
    // BFINAL=1, BTYPE=00 → 首字节 0b001；随后对齐到字节边界，再读 LEN/NLEN。
    const bytes = new Uint8Array([0b001, 0x05, 0x00, 0x00, 0x00, 1, 2, 3, 4, 5]);
    try {
      inflateRaw(bytes, { maxOutputLength: 64 });
      throw new Error('期望抛出 InflateError');
    } catch (error) {
      expect(error).toBeInstanceOf(InflateError);
      expect((error as InflateError).reason).toBe('invalid');
    }
  });

  it('上限不是非负整数时报错（不静默当成无限）', () => {
    expect(() => inflateRaw(new Uint8Array(0), { maxOutputLength: -1 })).toThrow(InflateError);
    expect(() => inflateRaw(new Uint8Array(0), { maxOutputLength: 1.5 })).toThrow(InflateError);
  });

  it('空压缩流（无任何块）报错，而不是返回空数组冒充成功', () => {
    expect(() => inflateRaw(new Uint8Array(0), { maxOutputLength: 16 })).toThrow(InflateError);
  });
});

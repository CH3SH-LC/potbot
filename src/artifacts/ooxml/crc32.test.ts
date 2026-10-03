/**
 * CRC-32 单测（W-A）。
 *
 * 锁定的语义：
 * - 标准 golden 向量（`"123456789"` → `0xCBF43926`，这是 CRC-32/ISO-HDLC 的公开校验值）；
 * - 与**逐位参考实现**（无表、每字节 8 次移位）在含中文的样本上逐例一致——查表实现与
 *   数学定义等价这件事必须被证，而不是被假定；
 * - 文本入参按 UTF-8 编码（与 ZIP 里实际写出的字节一致）；
 * - 返回值是无符号 32 位。
 */

import { describe, expect, it } from 'vitest';

import { CRC32_OF_EMPTY, crc32, crc32Hex } from './crc32.js';

/** 逐位参考实现：同一多项式与初值/末值，但不查表。 */
function crc32ByBits(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

describe('crc32', () => {
  it('命中标准 golden 向量', () => {
    expect(crc32('123456789')).toBe(0xcbf43926);
    expect(crc32('')).toBe(CRC32_OF_EMPTY);
    expect(crc32('')).toBe(0x00000000);
    expect(crc32('a')).toBe(0xe8b7be43);
    expect(crc32('abc')).toBe(0x352441c2);
    expect(crc32('The quick brown fox jumps over the lazy dog')).toBe(0x414fa339);
  });

  it('与逐位参考实现一致（含中文与二进制字节）', () => {
    const samples = ['', 'a', '123456789', '中文内容', '中文 + ASCII 混排', '表格：人数 10、金额 100 元'];
    for (const sample of samples) {
      const bytes = new TextEncoder().encode(sample);
      expect(crc32(sample)).toBe(crc32ByBits(bytes));
      expect(crc32(bytes)).toBe(crc32ByBits(bytes));
      expect(crc32(bytes)).toBe(crc32(sample));
    }

    const binary = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff, 0x9c, 0x3d]);
    expect(crc32(binary)).toBe(crc32ByBits(binary));
  });

  it('返回值是无符号 32 位整数', () => {
    for (const sample of ['', 'a', '123456789', '中文内容']) {
      const value = crc32(sample);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffffffff);
      expect(crc32Hex(sample)).toBe(value.toString(16).padStart(8, '0'));
    }
  });

  it('同一输入重复调用结果相同（表缓存不是状态泄漏）', () => {
    const first = crc32('determinism');
    for (let i = 0; i < 100; i += 1) expect(crc32('determinism')).toBe(first);
  });
});

/**
 * K09 独立验证 ①：纯 TS SHA-256 正确性。
 *
 * 判据不是自证。本文件用**外部预言机** `node:crypto` 的 `createHash('sha256')`
 * （测试允许用 node 内建）逐一对拍：
 *   - FIPS 已知向量（空串、"abc"、448/896 位边界）；
 *   - 长度 0..130 的确定性字节（覆盖填充分支的两侧）；
 *   - 随机字节 1 KiB / 1 MiB（覆盖多分组与长度字段高低位）；
 *   - 任意分片下的增量摘要 == 整块摘要。
 *
 * 只要我们那份纯实现的压缩函数、填充、字节序任何一处改错，对拍立刻变红。
 */

import { createHash, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { Sha256, sha256Bytes, sha256Digest, toHex, utf8Encode } from '../../../apps/mobile-kernel/storage/index.js';

function oracle(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function deterministicBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + 7) % 256;
  return out;
}

describe('K09-SHA256 正例：与 node:crypto 对拍', () => {
  it('FIPS 已知向量：空串 / "abc" / 长串', () => {
    expect(sha256Digest('')).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Digest('abc')).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Digest('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      'sha256:248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('长度 0..130 的确定性字节逐一对拍（覆盖 55/56 填充边界两侧）', () => {
    for (let length = 0; length <= 130; length += 1) {
      const bytes = deterministicBytes(length);
      expect(toHex(sha256Bytes(bytes)), `length=${length}`).toBe(oracle(bytes));
    }
  });

  it('随机 1 KiB 与 1 MiB 对拍（多分组 + 长度字段高位）', () => {
    const small = new Uint8Array(randomBytes(1024));
    expect(toHex(sha256Bytes(small))).toBe(oracle(small));
    const big = new Uint8Array(randomBytes(1024 * 1024));
    expect(toHex(sha256Bytes(big))).toBe(oracle(big));
  });

  it('任意分片下增量摘要 == 整块摘要', () => {
    const bytes = new Uint8Array(randomBytes(5000));
    const cuts = [0, 1, 63, 64, 65, 127, 128, 2000, 4999, 5000];
    const hasher = new Sha256();
    for (let i = 0; i + 1 < cuts.length; i += 1) hasher.update(bytes.subarray(cuts[i]!, cuts[i + 1]!));
    expect(toHex(hasher.digest())).toBe(oracle(bytes));
  });

  it('digest() 不破坏状态：可继续 update', () => {
    const hasher = new Sha256();
    hasher.update(utf8Encode('abc'));
    expect(toHex(hasher.digest())).toBe(oracle(utf8Encode('abc')));
    hasher.update(utf8Encode('defghijklmnopqrstuvwxyz'));
    expect(toHex(hasher.digest())).toBe(oracle(utf8Encode('abcdefghijklmnopqrstuvwxyz')));
  });
});

describe('K09-SHA256 正例：UTF-8 编码', () => {
  it('与 Buffer 的 UTF-8 编码逐字节一致（含中文与 BMP 外码点）', () => {
    for (const text of ['', 'ascii', '中文摘要', 'a\\u0000b', 'é€', 'emoji \u{1F600}\u{1F1E8}', '\u{10FFFF}']) {
      expect(toHex(utf8Encode(text)), JSON.stringify(text)).toBe(Buffer.from(text, 'utf8').toString('hex'));
    }
  });

  it('字符串输入按 UTF-8 计摘要（与显式编码一致）', () => {
    expect(sha256Digest('中文')).toBe(`sha256:${oracle(utf8Encode('中文'))}`);
  });
});

describe('K09-SHA256 负例（反向对照）', () => {
  it('摘要不等于"把输入原样返回"或任何平凡函数', () => {
    // 若实现退化成恒等 / 常量，这两条会红。
    expect(sha256Digest('abc')).not.toBe(sha256Digest('abd'));
    expect(sha256Digest('abc')).not.toBe(sha256Digest('abc '));
    const bytes = deterministicBytes(64);
    const identical = toHex(sha256Bytes(bytes));
    const flipped = bytes.slice();
    flipped[63] = flipped[63]! ^ 0x01;
    expect(toHex(sha256Bytes(flipped))).not.toBe(identical);
  });

  it('摘要形状必须是 sha256:<64 位小写 hex>', () => {
    expect(sha256Digest('x')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

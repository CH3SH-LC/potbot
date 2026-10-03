/**
 * M-I20：由**已公布的 FIPS 180-4 已知向量**钉死算法正确性。
 *
 * 这些十六进制串不是「我们算出来的」，而是公开标准向量；命中它们说明实现照标准走，
 * 而不是靠与某个同样可能算错的实现互相对照。
 */

import { describe, expect, it } from 'vitest';

import { sha256Hex, utf8Bytes } from '../../../src/mobile-plugins/meituan/crypto/index.js';

describe('M-I20 纯 TS SHA-256 已知向量（FIPS 180-4）', () => {
  it('空串向量：sha256("")', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    // utf8Bytes('') 也必须给出零长字节数组。
    expect(utf8Bytes('').length).toBe(0);
    expect(sha256Hex(utf8Bytes(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('单块向量：sha256("abc")', () => {
    expect(sha256Hex(utf8Bytes('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('双块向量：448-bit 消息（56 字节，需两个 64 字节块）', () => {
    const message = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
    expect(utf8Bytes(message).length).toBe(56);
    expect(sha256Hex(utf8Bytes(message))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('摘要形状：64 位小写十六进制', () => {
    expect(sha256Hex(utf8Bytes('anything'))).toMatch(/^[0-9a-f]{64}$/);
  });
});

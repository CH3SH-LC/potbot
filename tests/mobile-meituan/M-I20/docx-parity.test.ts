/**
 * M-I20：与 `src/documents/docx/sha256.ts` 的**只读对照**。
 *
 * M06 目前 import 的是 docx 版 `sha256Hex`。本单元提供的美团版必须能**就地替换**它，
 * 因此对同一 `Uint8Array` 必须给出逐字符相同的摘要。这里只**读取** docx 模块的输出，
 * **不修改** `src/documents/**`（写权边界，见 residuals）。
 */

import { describe, expect, it } from 'vitest';

import { sha256Hex as docxSha256Hex } from '../../../src/documents/docx/sha256.js';
import { sha256Hex as meituanSha256Hex, utf8Bytes } from '../../../src/mobile-plugins/meituan/crypto/index.js';
import { BOUNDARY_LENGTHS, CANONICAL_PAYLOADS, deterministicBytes } from './support.js';

describe('M-I20 与 docx SHA-256 模块输出一致（只读对照）', () => {
  it('任意字节：美团版 == docx 版（覆盖分块边界长度）', () => {
    for (const length of BOUNDARY_LENGTHS) {
      const bytes = deterministicBytes(length);
      expect(meituanSha256Hex(bytes), `length=${length}`).toBe(docxSha256Hex(bytes));
    }
  });

  it('规范载荷：美团版 == docx 版', () => {
    for (const payload of CANONICAL_PAYLOADS) {
      const bytes = utf8Bytes(payload);
      expect(meituanSha256Hex(bytes), JSON.stringify(payload)).toBe(docxSha256Hex(bytes));
    }
  });

  it('FIPS 向量上两者一致（同锚点）', () => {
    const abc = utf8Bytes('abc');
    expect(meituanSha256Hex(abc)).toBe(docxSha256Hex(abc));
    expect(meituanSha256Hex(abc)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

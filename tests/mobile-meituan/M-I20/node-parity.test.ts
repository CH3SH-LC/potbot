/**
 * M-I20：被测实现与 `node:crypto` 在**同一输入**上逐字节一致。
 *
 * 这是「不是自己算自己」的独立对照：`node:crypto` 是第三方运行时实现，
 * 与我们的纯 TS 实现无共享代码。
 */

import { describe, expect, it } from 'vitest';

import { sha256Hex, utf8Bytes } from '../../../src/mobile-plugins/meituan/crypto/index.js';
import {
  BOUNDARY_LENGTHS,
  CANONICAL_PAYLOADS,
  deterministicBytes,
  nodeSha256Hex,
  nodeSha256Text,
} from './support.js';

describe('M-I20 与 node:crypto 逐字节一致', () => {
  it('分块边界长度（含 55/56/63/64/65）逐字节一致', () => {
    for (const length of BOUNDARY_LENGTHS) {
      const bytes = deterministicBytes(length);
      expect(sha256Hex(bytes), `length=${length}`).toBe(nodeSha256Hex(bytes));
    }
  });

  it('规范载荷（UTF-8 文本，含多字节与代理对）逐字符一致', () => {
    for (const payload of CANONICAL_PAYLOADS) {
      expect(sha256Hex(utf8Bytes(payload)), JSON.stringify(payload)).toBe(nodeSha256Text(payload));
    }
  });

  it('utf8Bytes 与 Node Buffer UTF-8 编码逐字节一致', () => {
    for (const payload of CANONICAL_PAYLOADS) {
      // 使用 spread 逐元素比较，冲突时给出可读差异。
      expect([...utf8Bytes(payload)], JSON.stringify(payload)).toEqual([
        ...new Uint8Array(Buffer.from(payload, 'utf8')),
      ]);
    }
  });

  it('确定性：同输入多次调用同一摘要', () => {
    const bytes = deterministicBytes(200);
    expect(sha256Hex(bytes)).toBe(sha256Hex(bytes.slice()));
  });
});

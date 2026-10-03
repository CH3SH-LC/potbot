/**
 * M-I20：摘要助手（UTF-8 编码 / `sha256:<64hex>` 口径 / 校验）。
 *
 * 口径必须与 M06 现有写法一致：`sha256:${sha256Hex(utf8Bytes(payload))}`，
 * 因为该串要作为 `ConfirmAction.paramsDigest` 交给 K07 账本（强制 `^sha256:[0-9a-f]{64}$`）。
 */

import { describe, expect, it } from 'vitest';

import {
  DIGEST_PATTERN,
  isPayloadDigest,
  payloadDigest,
  sha256Hex,
  sha256TextHex,
  utf8Bytes,
} from '../../../src/mobile-plugins/meituan/crypto/index.js';
import { CANONICAL_PAYLOADS, nodeSha256Text, nodeUtf8Bytes } from './support.js';

describe('M-I20 美团摘要助手', () => {
  it('sha256TextHex == sha256Hex(utf8Bytes(text))', () => {
    for (const payload of CANONICAL_PAYLOADS) {
      expect(sha256TextHex(payload), JSON.stringify(payload)).toBe(sha256Hex(utf8Bytes(payload)));
    }
  });

  it('payloadDigest 输出 sha256:<64hex>，且与 node:crypto 对照一致', () => {
    for (const payload of CANONICAL_PAYLOADS) {
      const digest = payloadDigest(payload);
      expect(digest, JSON.stringify(payload)).toMatch(DIGEST_PATTERN);
      expect(digest).toBe(`sha256:${nodeSha256Text(payload)}`);
    }
  });

  it('payloadDigest 与 M06 现有写法（sha256: + sha256TextHex）逐字符一致', () => {
    for (const payload of CANONICAL_PAYLOADS) {
      expect(payloadDigest(payload)).toBe(`sha256:${sha256TextHex(payload)}`);
    }
  });

  it('UTF-8 编码：多字节中文 3 字节/字，4 字节码点由代理对正确编码', () => {
    for (const payload of CANONICAL_PAYLOADS) {
      expect([...utf8Bytes(payload)], JSON.stringify(payload)).toEqual([...nodeUtf8Bytes(payload)]);
    }
  });

  it('isPayloadDigest 接受规范串、拒绝畸形串', () => {
    expect(isPayloadDigest(payloadDigest('x'))).toBe(true);
    expect(isPayloadDigest('sha256:' + 'a'.repeat(64))).toBe(true);
    expect(isPayloadDigest('sha256:' + 'A'.repeat(64))).toBe(false); // 必须小写
    expect(isPayloadDigest('sha256:' + 'a'.repeat(63))).toBe(false); // 长度不足
    expect(isPayloadDigest('v1-1234abcd')).toBe(false); // M04 结构指纹，不是本口径
    expect(isPayloadDigest('')).toBe(false);
  });

  it('纯函数：同输入两次调用同一结果（无隐藏状态）', () => {
    const payload = '{"v":1,"merchantId":"m-1"}';
    expect(payloadDigest(payload)).toBe(payloadDigest(payload));
    expect(sha256TextHex(payload)).toBe(sha256TextHex(payload));
  });
});

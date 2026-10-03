/**
 * **美团包自有的摘要助手** —— 把「规范载荷」编码为 UTF-8 字节后取 SHA-256，
 * 并给出与 K07 账本同口径的 `sha256:<64 位小写十六进制>` 串。
 *
 * ## 用途
 *
 * M06（purchase-confirmation）需要 `paramsDigest = sha256:<64hex>`，其规范载荷是纯文本
 * （见 `../purchase-confirmation/digest.ts:canonicalOrderParamsPayload`）。本模块把
 * 「文本 → UTF-8 字节 → SHA-256 → `sha256:` 前缀」这条固定管线收成一处，便于美团内部
 * 复用，且**不依赖** `node:crypto`、`TextEncoder` 或 `src/documents/docx`。
 *
 * ## 纪律
 *
 * - 纯函数：不读时钟、不读随机数、不读环境。
 * - 零依赖：仅相对导入本目录的 `./sha256.js`。
 * - UTF-8 编码自足实现（不依赖 `TextEncoder`），正确处理 1/2/3 字节序列与 UTF-16 代理对
 *   （4 字节码点）。
 */

import { sha256Hex } from './sha256.js';

/** K07 账本强制的摘要口径：`sha256:` + 64 位小写十六进制。 */
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * 把 JS 字符串按 **UTF-8** 编码为字节（自足实现，不依赖 `TextEncoder`）。
 *
 * 孤立代理（无配对）按 UTF-8 的 WTF-8/替换字符语义处理：以 3 字节编码该码元；
 * 与 `Buffer.from(text, 'utf8')`（Node）在孤立代理上的行为**不一致**，故本模块
 * 不对孤立代理作跨实现等价承诺；正常文本（含成对代理的 4 字节码点）逐字节等价。
 */
export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        const codePoint = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        out.push(
          0xf0 | (codePoint >> 18),
          0x80 | ((codePoint >> 12) & 0x3f),
          0x80 | ((codePoint >> 6) & 0x3f),
          0x80 | (codePoint & 0x3f),
        );
        index += 1;
      } else {
        out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(out);
}

/** 对一段文本按 UTF-8 取 SHA-256，返回裸小写十六进制。 */
export function sha256TextHex(text: string): string {
  return sha256Hex(utf8Bytes(text));
}

/**
 * 对**规范载荷**（纯文本、可重现）取摘要，返回 `sha256:<64 位小写十六进制>`（K07 同口径）。
 * 与 M06 现有写法 `sha256:${sha256Hex(utf8Bytes(payload))}` 逐字符一致。
 */
export function payloadDigest(payload: string): string {
  return `sha256:${sha256TextHex(payload)}`;
}

/** 判断字符串是否为合法摘要（K07 口径）。 */
export function isPayloadDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value);
}

/**
 * F06 files —— 字节证据（I1）。
 *
 * 「有字节」不是一句口头声明，而是**可核对的两项证据**：长度 + 内容摘要。
 * 本包不读真实文件、不算真实摘要——摘要由产出字节的一侧（导出器 / 内核）给出；
 * 这里只做**形状与自洽性**校验，并保证「没证据 → 不许声称已生成」。
 */

import { FileError, NO_BYTES, type BytePresence, type BytesAbsent, type BytesPresent } from './types.js';

/** 与 contracts/mobile-v1 同形状的摘要：`sha256:` + 64 位小写十六进制。 */
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** 无字节常量（只读）。 */
export function noBytes(): BytesAbsent {
  return NO_BYTES;
}

/** 是否是「有字节」的分支。 */
export function hasBytes(presence: BytePresence): presence is BytesPresent {
  return presence.present === true;
}

/** 校验摘要形状。 */
export function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_DIGEST.test(value);
}

/**
 * 用长度 + 摘要构造「有字节」证据。任一不合法即抛错——**不接受**半份证据：
 * 没有摘要就等于没有可回读的凭据，不能进入「已生成」。
 */
export function withBytes(byteLength: unknown, digest: unknown): BytesPresent {
  if (typeof byteLength !== 'number' || !Number.isInteger(byteLength) || byteLength <= 0) {
    throw new FileError('invalid-byte-length', 'byteLength 必须是 > 0 的整数', {
      value: byteLength === undefined ? null : String(byteLength),
    });
  }
  if (!isSha256Digest(digest)) {
    throw new FileError('invalid-digest', 'digest 必须是 sha256:<64 位小写十六进制>', {
      value: digest === undefined ? null : String(digest),
    });
  }
  return Object.freeze({ present: true, byteLength, digest });
}

/**
 * 断言有字节，返回证据；无字节抛 `missing-bytes`（fail-closed）。
 * `action` 用于报错时说明「想做什么却被缺字节挡住」，便于定位。
 */
export function assertBytes(presence: BytePresence, action: string): BytesPresent {
  if (!hasBytes(presence)) {
    throw new FileError('missing-bytes', `没有字节证据，不能${action}`, { action });
  }
  return presence;
}

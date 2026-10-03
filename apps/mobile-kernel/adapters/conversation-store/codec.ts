/**
 * K-I05 会话持久化适配层 —— **快照编解码**（零依赖，不 import 任何 node 内建）。
 *
 * ## 为什么自带 UTF-8 解码
 *
 * K09 的 `sha256.ts` 提供了纯 TS 的 `utf8Encode`，但没有解码方向；`TextDecoder` 属于
 * `lib.dom` / `lib.webworker`，本仓库 `tsconfig` 的 `lib` 只有 `ES2023`，产品代码也规定
 * 不依赖 node 内建。会话正文含中文，`JSON.stringify` **不会**把非 ASCII 转义成 `\uXXXX`，
 * 因此字节里必然有 UTF-8 多字节序列——必须自己解码，否则中文会读成乱码或解析失败。
 *
 * 正确性由测试交叉验证：`tests/mobile-kernel/K-I05` 把本解码器与 `Buffer.from(text,'utf8')`
 * 逐字节对拍（含 BMP 外码点 / 代理对），不是自证。
 */

import { utf8Encode } from '../../storage/sha256.js';
import { ConversationAdapterError } from './errors.js';

/**
 * 纯 TypeScript UTF-8 解码（覆盖 1–4 字节序列，代理对按 code point 合并）。
 *
 * 非法字节（非法起始字节、被截断的续字节、续字节高位不对）一律抛
 * {@link ConversationAdapterError}`('snapshot_malformed')`——**不**做替换字符兜底：
 * 静默把坏字节变成 `U+FFFD` 会让一个损坏的快照"看起来能解析"，从而绕过 fail-closed。
 */
export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i]!;
    let cp: number;
    let extra: number;
    if (b0 < 0x80) {
      cp = b0;
      extra = 0;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      cp = b0 & 0x1f;
      extra = 1;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      cp = b0 & 0x0f;
      extra = 2;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      cp = b0 & 0x07;
      extra = 3;
    } else {
      throw new ConversationAdapterError(
        'snapshot_malformed',
        `非法 UTF-8 起始字节 0x${b0.toString(16)}（位置 ${String(i)}）`,
      );
    }
    if (i + extra >= bytes.length) {
      throw new ConversationAdapterError('snapshot_malformed', `UTF-8 序列被截断（位置 ${String(i)}）`);
    }
    for (let k = 1; k <= extra; k += 1) {
      const bk = bytes[i + k]!;
      if ((bk & 0xc0) !== 0x80) {
        throw new ConversationAdapterError(
          'snapshot_malformed',
          `非法 UTF-8 续字节 0x${bk.toString(16)}（位置 ${String(i + k)}）`,
        );
      }
      cp = (cp << 6) | (bk & 0x3f);
    }
    i += extra + 1;
    if (cp > 0xffff) {
      const value = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (value >> 10), 0xdc00 + (value & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
  }
  return out;
}

/** 把任意可序列化值编码成 UTF-8 字节（`JSON.stringify` + 纯 TS 编码）。 */
export function encodeSnapshot(value: unknown): Uint8Array {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new ConversationAdapterError('snapshot_shape_invalid', '快照无法 JSON 序列化（stringify 得到 undefined）');
  }
  return utf8Encode(text);
}

/** 把快照字节解析为 `unknown`：任何一步失败都抛 `snapshot_malformed`，绝不"修一下再解析"。 */
export function decodeSnapshot(bytes: Uint8Array): unknown {
  const text = utf8Decode(bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConversationAdapterError(
      'snapshot_malformed',
      `快照不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

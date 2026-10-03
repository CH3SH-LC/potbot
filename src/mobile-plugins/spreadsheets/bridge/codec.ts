/**
 * 表格存储桥接层 —— **会话状态 ⇄ 字节的序列化器**（零依赖，纯函数）。
 *
 * ## 它把哪两端接起来
 *
 * 一端是 X-I17 的会话持久状态（`session/durable.ts`）：
 * `toDurableState` / `serializeDurableState` / `parseDurableState` / `sessionFromDurableState`，
 * 以及 `serializeSession` —— 产出的是**纯 JSON 字符串**，且内部已把表格源的 `Map` / `Uint8Array`
 * 经 `$map` / `$bytes` 标记编好（直接 `JSON.stringify` 会把整张表悄悄变空）。
 *
 * 另一端是宿主端口（`bridge/types.ts`）——接受 / 返回的是**字节**。
 *
 * 本文件就是中间的**唯一翻译点**：字符串 ⇄ UTF-8 字节。编、解都**严格**：
 *
 * - 编码：纯 TS，遍历码点，含基本平面外（4 字节序列）；不依赖任何 Node 内置，
 *   WebView / 安卓内核都能跑。
 * - 解码：**非法 UTF-8 序列抛错**，绝不静默替换成 U+FFFD——那会把"介质损坏"伪装成
 *   "内容只是有点怪"，进而被 `JSON.parse` 当成坏输入混过去。字节坏了 = 显式失败。
 *
 * ## 回环判据
 *
 * `bytesToSession(sessionToBytes(session))` 必须还原出**同摘要、同版本、同步骤数**的会话——
 * 这正是 `sessionFromDurableState` 内部的 `revision` 与 `sourceDigest()` 两处不变量核对。
 * 任一处对不上就抛错，**不返回半可信会话**。
 */

import {
  deserializeDurableState,
  serializeDurableState,
  serializeSession,
  sessionFromDurableState,
  toDurableState,
} from '../session/index.js';
import type { DurableState, SpreadsheetSession, TransactionRecord } from '../session/index.js';

// ---------------------------------------------------------------------------
// UTF-8（纯 TS，严格）
// ---------------------------------------------------------------------------

/**
 * UTF-8 编码（纯 TS）。码点 ≥ U+10000 走 4 字节序列；与 {@link decodeUtf8Strict} 互逆。
 */
export function encodeUtf8(text: string): Uint8Array {
  const out: number[] = [];
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    index += codePoint > 0xffff ? 2 : 1;
    if (codePoint < 0x80) {
      out.push(codePoint);
    } else if (codePoint < 0x800) {
      out.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      out.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      out.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/**
 * 严格 UTF-8 解码（纯 TS，覆盖基本平面外码点）。**非法序列抛错**，不静默替换。
 *
 * @throws {Error} 非法起始字节 / 续字节 / 过度编码 / 码点越界
 */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  let out = '';
  let index = 0;
  const length = bytes.length;
  while (index < length) {
    const b0 = bytes[index];
    if (b0 === undefined) break;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      index += 1;
      continue;
    }
    if (b0 < 0xc2) {
      throw new Error(`非法 UTF-8 起始字节 0x${b0.toString(16)} @${String(index)}`);
    }
    if (b0 < 0xe0) {
      const b1 = bytes[index + 1];
      if (b1 === undefined || (b1 & 0xc0) !== 0x80) {
        throw new Error(`非法 UTF-8 续字节 @${String(index)}`);
      }
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
      index += 2;
      continue;
    }
    if (b0 < 0xf0) {
      const b1 = bytes[index + 1];
      const b2 = bytes[index + 2];
      if (b1 === undefined || b2 === undefined || (b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) {
        throw new Error(`非法 UTF-8 三字节序列 @${String(index)}`);
      }
      const codePoint = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
      if (codePoint < 0x800) {
        throw new Error(`UTF-8 过度编码 @${String(index)}`);
      }
      out += String.fromCharCode(codePoint);
      index += 3;
      continue;
    }
    if (b0 < 0xf5) {
      const b1 = bytes[index + 1];
      const b2 = bytes[index + 2];
      const b3 = bytes[index + 3];
      if (
        b1 === undefined ||
        b2 === undefined ||
        b3 === undefined ||
        (b1 & 0xc0) !== 0x80 ||
        (b2 & 0xc0) !== 0x80 ||
        (b3 & 0xc0) !== 0x80
      ) {
        throw new Error(`非法 UTF-8 四字节序列 @${String(index)}`);
      }
      const codePoint =
        ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      if (codePoint < 0x10000 || codePoint > 0x10ffff) {
        throw new Error(`UTF-8 码点越界 @${String(index)}`);
      }
      out += String.fromCodePoint(codePoint);
      index += 4;
      continue;
    }
    throw new Error(`非法 UTF-8 起始字节 0x${b0.toString(16)} @${String(index)}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 持久状态（DurableState）⇄ 字节
// ---------------------------------------------------------------------------

/** `DurableState` → 字节（先序列化字符串，再严格 UTF-8 编码）。 */
export function durableStateToBytes(state: DurableState): Uint8Array {
  return encodeUtf8(serializeDurableState(state));
}

/** 字节 → `DurableState`（严格 UTF-8 解码 + 严格 schema 核对；不符即抛）。 */
export function bytesToDurableState(bytes: Uint8Array): DurableState {
  return deserializeDurableState(decodeUtf8Strict(bytes));
}

// ---------------------------------------------------------------------------
// 会话（SpreadsheetSession）⇄ 字节（X-I17 会话状态的回环）
// ---------------------------------------------------------------------------

/** 会话 → 字节（等价于把 `serializeSession(session)` 再编码）。 */
export function sessionToBytes(session: SpreadsheetSession): Uint8Array {
  return encodeUtf8(serializeSession(session));
}

/**
 * 字节 → 会话。走 `sessionFromDurableState`，因此核对 `revision` 与 `sourceDigest()` 两处
 * 不变量；对不上即抛（**不返回半可信会话**）。
 *
 * @throws {import('../../../protocol/index.js').ValidationError} 形状 / 摘要不符
 */
export function bytesToSession(bytes: Uint8Array): SpreadsheetSession {
  return sessionFromDurableState(bytesToDurableState(bytes));
}

/** 便捷：会话 → `DurableState`（本层透出，省得调用方再 import 一层）。 */
export function durableStateOf(session: SpreadsheetSession): DurableState {
  return toDurableState(session);
}

// ---------------------------------------------------------------------------
// 日志（journal）⇄ 字节（append-only 审计轨）
// ---------------------------------------------------------------------------

/**
 * 日志数组 → 字节（`JSON.stringify` 后编码）。
 *
 * 日志本身是纯 JSON 值（`TransactionRecord[]`），因此不需要 `$map` / `$bytes` 标记；
 * 它是**快照记录之外的独立审计轨**：快照回答"怎么重建"，日志回答"哪几笔提交过"。
 */
export function journalToBytes(journal: readonly TransactionRecord[]): Uint8Array {
  return encodeUtf8(JSON.stringify(journal));
}

/** 字节 → 日志的**原始 JSON 值**（不做字段核对：核对归 `parseDurableState` 的快照路径）。 */
export function bytesToJournalRaw(bytes: Uint8Array): unknown {
  return JSON.parse(decodeUtf8Strict(bytes)) as unknown;
}

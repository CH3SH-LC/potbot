/**
 * 手机内核日志库 —— **帧编解码与撕裂写检测**（零依赖；复用 K09 的纯 TS SHA-256）。
 *
 * ## 帧布局（全部小端）
 *
 * ```
 * offset 0   4B  magic = 'PBJF'
 * offset 4   1B  formatVersion
 * offset 5   1B  kind (1=put, 2=delete, 3=migration)
 * offset 6   4B  seq
 * offset 10  4B  payloadLen
 * offset 14  nB  payload (UTF-8 JSON)
 * offset 14+n 64B sha256 hex (ASCII) of bytes[0 .. 14+n)
 * ```
 *
 * `HEADER_LEN = 14`，`DIGEST_LEN = 64`，`frameLen = 14 + payloadLen + 64`。
 *
 * ## 撕裂写为什么能被发现
 *
 * 崩溃可能让介质尾部停在任何字节处。回放时：
 * - 尾部不足一个头 ⇒ `incomplete-header`；
 * - 头完整但声明的 `payloadLen` 之后字节不够 ⇒ `incomplete-frame`；
 * - 字节够但摘要对不上（写入中途被截断 / 介质损坏）⇒ `bad-digest`。
 *
 * 三种都**止于该帧**：之前的帧全部有效，该帧与其后的一切**整段丢弃**。
 * 这是「崩溃后要么整条记录可见、要么整条不可见」的实现基础——不存在"半条记录已生效"。
 */

import { sha256Digest, utf8Encode } from '../storage/sha256.js';
import {
  FRAME_FORMAT_VERSION,
  type DiscardReason,
  type Frame,
  type MigrationPayload,
  type PutPayload,
  type RecordKind,
} from './schemas.js';

/** 头部字节数。 */
export const HEADER_LEN = 14;
/** 尾部摘要字节数（64 位 hex 的 ASCII）。 */
export const DIGEST_LEN = 64;
const DIGEST_PREFIX_LEN = 'sha256:'.length;

const MAGIC_BYTES: readonly number[] = [0x50, 0x42, 0x4a, 0x46]; // 'PBJF'
const KIND_TO_BYTE: Record<RecordKind, number> = { put: 1, delete: 2, migration: 3 };
const BYTE_TO_KIND: Record<number, RecordKind> = { 1: 'put', 2: 'delete', 3: 'migration' };

const DECODER = new TextDecoder('utf-8');

// ---------------------------------------------------------------------------
// 编码
// ---------------------------------------------------------------------------

export function encodeFrame(frame: Frame): Uint8Array {
  const payloadBytes = utf8Encode(JSON.stringify(frame.payload));
  const bodyLen = HEADER_LEN + payloadBytes.length;
  const body = new Uint8Array(bodyLen);
  body.set(MAGIC_BYTES, 0);
  body[4] = FRAME_FORMAT_VERSION;
  body[5] = KIND_TO_BYTE[frame.kind];
  writeU32LE(body, 6, frame.seq);
  writeU32LE(body, 10, payloadBytes.length);
  body.set(payloadBytes, HEADER_LEN);

  const digestHex = sha256Digest(body).slice(DIGEST_PREFIX_LEN);
  const out = new Uint8Array(bodyLen + DIGEST_LEN);
  out.set(body, 0);
  out.set(utf8Encode(digestHex), bodyLen);
  return out;
}

/** 一整条日志的编码（按数组顺序拼接）。 */
export function encodeFrames(frames: readonly Frame[]): Uint8Array {
  const parts = frames.map((frame) => encodeFrame(frame));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 解码 / 回放
// ---------------------------------------------------------------------------

export interface DecodeResult {
  readonly frames: readonly Frame[];
  readonly validBytes: number;
  readonly discardedBytes: number;
  readonly discardedReason: DiscardReason;
}

export function decodeFrames(bytes: Uint8Array): DecodeResult {
  const frames: Frame[] = [];
  let offset = 0;
  let reason: DiscardReason = 'none';

  while (offset < bytes.length) {
    const remaining = bytes.length - offset;
    if (remaining < HEADER_LEN) {
      reason = 'incomplete-header';
      break;
    }
    if (!hasMagic(bytes, offset)) {
      reason = 'bad-magic';
      break;
    }
    if ((bytes[offset + 4] ?? -1) !== FRAME_FORMAT_VERSION) {
      reason = 'unsupported-format';
      break;
    }
    const kind = BYTE_TO_KIND[bytes[offset + 5] ?? -1];
    if (kind === undefined) {
      reason = 'bad-kind';
      break;
    }
    const seq = readU32LE(bytes, offset + 6);
    const payloadLen = readU32LE(bytes, offset + 10);
    const frameLen = HEADER_LEN + payloadLen + DIGEST_LEN;
    if (remaining < frameLen) {
      reason = 'incomplete-frame';
      break;
    }
    const digestStart = offset + HEADER_LEN + payloadLen;
    const expected = DECODER.decode(bytes.subarray(digestStart, digestStart + DIGEST_LEN));
    const actual = sha256Digest(bytes.subarray(offset, digestStart)).slice(DIGEST_PREFIX_LEN);
    if (actual !== expected) {
      reason = 'bad-digest';
      break;
    }
    const json = DECODER.decode(bytes.subarray(offset + HEADER_LEN, digestStart));
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      reason = 'bad-json';
      break;
    }
    const frame = toFrame(kind, seq, parsed);
    if (frame === null) {
      reason = 'bad-payload';
      break;
    }
    frames.push(frame);
    offset += frameLen;
  }

  return {
    frames,
    validBytes: offset,
    discardedBytes: bytes.length - offset,
    discardedReason: reason,
  };
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function toFrame(kind: RecordKind, seq: number, parsed: unknown): Frame | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const raw = parsed as Record<string, unknown>;

  if (kind === 'put') {
    if (typeof raw.key !== 'string' || raw.key.length === 0) return null;
    if (typeof raw.value !== 'string') return null;
    const payload: PutPayload = {
      key: raw.key,
      value: raw.value,
      ...(typeof raw.updatedAt === 'number' ? { updatedAt: raw.updatedAt } : {}),
      ...(Array.isArray(raw.tags) && raw.tags.every((tag) => typeof tag === 'string')
        ? { tags: raw.tags as string[] }
        : {}),
    };
    return { kind: 'put', seq, payload };
  }

  if (kind === 'delete') {
    if (typeof raw.key !== 'string' || raw.key.length === 0) return null;
    return { kind: 'delete', seq, payload: { key: raw.key } };
  }

  if (typeof raw.from !== 'number' || typeof raw.to !== 'number') return null;
  const payload: MigrationPayload = { from: raw.from, to: raw.to };
  return { kind: 'migration', seq, payload };
}

function hasMagic(bytes: Uint8Array, offset: number): boolean {
  for (let i = 0; i < MAGIC_BYTES.length; i += 1) {
    if ((bytes[offset + i] ?? -1) !== MAGIC_BYTES[i]) return false;
  }
  return true;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  const b0 = bytes[offset] ?? 0;
  const b1 = bytes[offset + 1] ?? 0;
  const b2 = bytes[offset + 2] ?? 0;
  const b3 = bytes[offset + 3] ?? 0;
  return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
}

function writeU32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

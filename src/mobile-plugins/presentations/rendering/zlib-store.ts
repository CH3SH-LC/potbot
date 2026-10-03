/**
 * **纯 TypeScript 的 zlib（RFC 1950）包装**——压缩只写 STORE 块，解压复用既有的 raw inflate。
 *
 * ## 为什么要自己写，而不是用宿主库
 *
 * 合同 R50.4 把 `src/**`（非测试）的 `node:*` import 钉死在 `node:crypto` + 具名 IO 适配器
 * （`src/storage/file-store.ts`）。本目录的 PNG 编码原先直接调用宿主的 `deflateSync` /
 * `inflateSync`，**属于违约**（内核要跑在手机的 JS 运行时里，那里没有 Node 内建模块）。
 *
 * ## 压缩：stored（未压缩）deflate 块
 *
 * - 结构：`zlib 头(2B) + 若干 stored 块 + Adler-32(4B, 大端)`；
 * - 每个 stored 块 = 1 字节块头（BFINAL + BTYPE=00，随后补零到字节边界）+ LEN(2B 小端)
 *   + NLEN(2B 小端，LEN 的按位取反) + LEN 字节原文（RFC 1951 §3.2.4）；
 * - 单块 LEN 上限 65535，故输入按 65535 分块，**最后一块**置 BFINAL。
 *
 * stored 块是**任何合规阅读器都必须支持**的路径（`inflate` 的第一条分支），因此产出的是
 * **真实可解的 zlib 流**，不是占位。代价是体积（压缩比 ≈ 1.0），收益是与宿主 zlib 版本
 * **彻底解耦**：同一输入在任何运行时产出**同一字节**——这正是本仓 `zip.ts` 全 STORE 的同一条理由。
 *
 * ## 解压
 *
 * 不重复实现第二个解压器：剥掉 2 字节 zlib 头后交给 `src/artifacts/ooxml/inflate.ts` 的
 * `inflateRaw`（它已覆盖 stored / fixed-Huffman / dynamic-Huffman 三种块型），再核对尾部
 * Adler-32。于是"自己压的能自己解"，且由**第三方压缩器**（如宿主 zlib）产出的流同样能解。
 */

import { InflateError, inflateRaw } from '../../../artifacts/ooxml/inflate.js';

/** zlib 头第一个字节：CM（低 4 位）= 8 表示 deflate，CINFO（高 4 位）= 7 表示 32 KiB 窗口。 */
const ZLIB_CMF_DEFLATE_32K = 0x78;
/**
 * zlib 头第二个字节：FCHECK 使 `(CMF << 8 | FLG) % 31 === 0`、FDICT = 0、FLEVEL = 0。
 * `0x78 0x01` 是 RFC 1950 §2.2 给出的一对**合法**取值，也正是"不压缩"的常规写法。
 */
const ZLIB_FLG = 0x01;

/** stored 块的 LEN 字段是 16 位，故单块原文上限 65535 字节。 */
const MAX_STORED_BLOCK_LENGTH = 0xffff;

/** Adler-32 的模（RFC 1950 §9 规定的最小素数 65521）。 */
const ADLER_MODULUS = 65521;
/** 每累积这么多字节取一次模（照 zlib 的 NMAX；在 JS 的 double 下并非必需，但保持一致）。 */
const ADLER_CHUNK = 5552;

/** 本模块的错误类型（调用方把它翻成自己的错误码，不把宿主异常漏出去）。 */
export type ZlibStoreErrorReason =
  /** 输入不是合法的 zlib 包装（头非法 / 太短 / 解压后校验和不符）。 */
  | 'bad_structure';

export class ZlibStoreError extends Error {
  readonly reason: ZlibStoreErrorReason;

  constructor(reason: ZlibStoreErrorReason, message: string) {
    super(message);
    this.name = 'ZlibStoreError';
    this.reason = reason;
  }
}

/**
 * Adler-32 校验和（RFC 1950 §9）。
 *
 * @param bytes 待求和字节。
 * @returns 32 位无符号校验和（高 16 位为 B，低 16 位为 A）。
 */
export function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  let index = 0;
  while (index < bytes.length) {
    const end = Math.min(index + ADLER_CHUNK, bytes.length);
    while (index < end) {
      a += bytes[index] ?? 0;
      b += a;
      index += 1;
    }
    a %= ADLER_MODULUS;
    b %= ADLER_MODULUS;
  }
  return (((b << 16) | a) >>> 0) >>> 0;
}

/** 大端写 32 位（避免依赖 `Buffer`，本模块只用 `Uint8Array`）。 */
function writeUint32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

/** 大端读 32 位。 */
function readUint32BE(source: Uint8Array, offset: number): number {
  return (
    (((source[offset] ?? 0) << 24) |
      ((source[offset + 1] ?? 0) << 16) |
      ((source[offset + 2] ?? 0) << 8) |
      (source[offset + 3] ?? 0)) >>>
    0
  );
}

/**
 * 把一段字节压成 **zlib 流**（全部用 stored 块）。
 *
 * 返回值是一块**独占**缓冲（`byteOffset === 0`、`byteLength === buffer.byteLength`），
 * 因此调用方可以安全地把它裹进任何"视图型"封装而不必再拷一次。
 *
 * @param input 待压缩字节（空输入也会产出**一个合法的空 final 块**，不会产出裸头）。
 */
export function zlibStoreCompress(input: Uint8Array): Uint8Array {
  const blockCount = Math.max(1, Math.ceil(input.length / MAX_STORED_BLOCK_LENGTH));
  const out = new Uint8Array(2 + blockCount * 5 + input.length + 4);

  out[0] = ZLIB_CMF_DEFLATE_32K;
  out[1] = ZLIB_FLG;

  let write = 2;
  let read = 0;
  for (let block = 0; block < blockCount; block += 1) {
    const length = Math.min(MAX_STORED_BLOCK_LENGTH, input.length - read);
    const isFinal = block === blockCount - 1;
    // 块头：bit0 = BFINAL，bit1-2 = BTYPE(00 = stored)，其余位补零到字节边界。
    out[write] = isFinal ? 0x01 : 0x00;
    out[write + 1] = length & 0xff;
    out[write + 2] = (length >>> 8) & 0xff;
    const complement = length ^ 0xffff;
    out[write + 3] = complement & 0xff;
    out[write + 4] = (complement >>> 8) & 0xff;
    write += 5;
    out.set(input.subarray(read, read + length), write);
    write += length;
    read += length;
  }

  writeUint32BE(out, write, adler32(input));
  return out;
}

/**
 * 解压一段 **zlib 流**（RFC 1950 包装）。
 *
 * 头部校验：CM 必须是 8（deflate）、`(CMF << 8 | FLG) % 31 === 0`、不得置 FDICT
 * （本内核不处理预置字典——遇到就**显式报错**，不静默按无字典解）。正文交给
 * `inflateRaw`（stored / fixed / dynamic 三种块型都支持），最后核对尾部 Adler-32。
 *
 * @param input zlib 流字节。
 * @param maxOutputLength 解压输出上限（**硬门**，传给 `inflateRaw`）。
 * @throws {ZlibStoreError} 头非法 / 太短 / 尾部 Adler-32 不符。
 * @throws {InflateError} 正文结构非法 / 截断 / 距离越界 / 超限（原样上抛，调用方按需翻译）。
 */
export function zlibInflate(input: Uint8Array, maxOutputLength: number): Uint8Array {
  if (input.length < 6) {
    throw new ZlibStoreError('bad_structure', `zlib 流至少 6 字节（头 2 + 尾 4），收到 ${String(input.length)} 字节`);
  }
  const cmf = input[0] ?? 0;
  const flg = input[1] ?? 0;
  if ((cmf & 0x0f) !== 8) {
    throw new ZlibStoreError('bad_structure', `zlib 的 CM 必须是 8（deflate），收到 ${String(cmf & 0x0f)}`);
  }
  if ((((cmf << 8) | flg) % 31) !== 0) {
    throw new ZlibStoreError('bad_structure', 'zlib 头的 FCHECK 不成立（头两字节不是合法的 RFC 1950 头）');
  }
  if ((flg & 0x20) !== 0) {
    throw new ZlibStoreError('bad_structure', 'zlib 头置了 FDICT：本内核不支持预置字典流');
  }

  const body = input.subarray(2, input.length - 4);
  const declared = readUint32BE(input, input.length - 4);
  const inflated = inflateRaw(body, { maxOutputLength });
  const actual = adler32(inflated);
  if (actual !== declared) {
    throw new ZlibStoreError(
      'bad_structure',
      `zlib 尾部的 Adler-32 不符（声明 ${declared.toString(16)}，实算 ${actual.toString(16)}）`,
    );
  }
  return inflated;
}

/** 把任意异常翻成一句可读文本（错误信息里**不**回显可能很长的载荷）。 */
export function describeZlibError(error: unknown): string {
  if (error instanceof InflateError) return `${error.name}(${error.reason})：${error.message}`;
  if (error instanceof ZlibStoreError) return `${error.name}：${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

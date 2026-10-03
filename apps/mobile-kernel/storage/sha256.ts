/**
 * K09 存储端口 —— **纯 TypeScript SHA-256**（零依赖，不 import 任何 node 内建）。
 *
 * ## 为什么不用 `node:crypto`
 *
 * 本模块跑在**手机内核**里（`apps/mobile-kernel/storage/**`）。本项目规定产品代码
 * **不得依赖 node 内建**（`node:fs` 是明文禁止项，`node:crypto` 同样会把内核绑死在
 * Node 运行时上，安卓侧要走同一份逻辑就得重写）。因此摘要算法自带一份纯 TS 实现。
 *
 * ## 怎么证明它是对的（而不是"自己说自己对"）
 *
 * 纯实现最大的风险是自证：`digest(x) === digest(x)` 恒真，毫无意义。
 * 因此测试用**外部预言机**交叉验算：`tests/mobile-kernel/K09/sha256.test.ts` 把本实现
 * 与 `node:crypto` 的 `createHash('sha256')` 在 FIPS 已知向量与大量随机字节上逐一对拍。
 * 只要本文件里的压缩函数、填充、字节序任何一处改错，对拍立刻变红——这是能咬的判据。
 *
 * 契约形状：输出去 `sha256:<64 位小写 hex>`（`contracts/mobile-v1/schemas/storage-port.schema.json`
 * 的 `$defs.digest`）。
 */

/** SHA-256 轮常量（FIPS 180-4 §4.2.2）。 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 初始哈希值（FIPS 180-4 §5.3.3）。 */
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/** 消息调度数组（模块级复用；`compress()` 同步执行，不可重入调用）。 */
const W = new Uint32Array(64);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** 压缩一个 64 字节分组，就地更新 `h`（8 个 32 位字）。 */
function compress(h: Uint32Array, block: Uint8Array, offset: number): void {
  for (let i = 0; i < 16; i += 1) {
    const j = offset + i * 4;
    W[i] = (((block[j]! << 24) | (block[j + 1]! << 16) | (block[j + 2]! << 8) | block[j + 3]!) >>> 0);
  }
  for (let i = 16; i < 64; i += 1) {
    const w15 = W[i - 15]!;
    const w2 = W[i - 2]!;
    const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
    const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
    W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) >>> 0;
  }

  let a = h[0]!;
  let b = h[1]!;
  let c = h[2]!;
  let d = h[3]!;
  let e = h[4]!;
  let f = h[5]!;
  let g = h[6]!;
  let hh = h[7]!;

  for (let i = 0; i < 64; i += 1) {
    const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
    const ch = ((e & f) ^ (~e & g)) >>> 0;
    const t1 = (hh + S1 + ch + K[i]! + W[i]!) >>> 0;
    const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
    const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
    const t2 = (S0 + maj) >>> 0;
    hh = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }

  h[0] = (h[0]! + a) >>> 0;
  h[1] = (h[1]! + b) >>> 0;
  h[2] = (h[2]! + c) >>> 0;
  h[3] = (h[3]! + d) >>> 0;
  h[4] = (h[4]! + e) >>> 0;
  h[5] = (h[5]! + f) >>> 0;
  h[6] = (h[6]! + g) >>> 0;
  h[7] = (h[7]! + hh) >>> 0;
}

/**
 * 增量 SHA-256。`update()` 可重复调用（对应流式写入的分片），`digest()` 不破坏状态，
 * 可继续 `update()`（用于"边写边算摘要、写完再收口"）。
 */
export class Sha256 {
  #h = new Uint32Array(H0);
  #buffer = new Uint8Array(64);
  #bufferLen = 0;
  #totalBytes = 0;

  update(chunk: Uint8Array): this {
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(64 - this.#bufferLen, chunk.length - offset);
      this.#buffer.set(chunk.subarray(offset, offset + take), this.#bufferLen);
      this.#bufferLen += take;
      this.#totalBytes += take;
      offset += take;
      if (this.#bufferLen === 64) {
        compress(this.#h, this.#buffer, 0);
        this.#bufferLen = 0;
      }
    }
    return this;
  }

  /** 32 字节摘要。填充规则 FIPS 180-4 §5.1.1（0x80 + 0x00… + 64 位大端比特长度）。 */
  digest(): Uint8Array {
    const h = this.#h.slice();
    const len = this.#bufferLen;
    const bitLen = this.#totalBytes * 8;
    const hi = Math.floor(bitLen / 0x100000000);
    const lo = bitLen % 0x100000000;

    // 需要补 0x80 之后、长度字段之前的零字节数：使 64 | (len + 1 + zeros + 8)。
    const zeros = (55 - len + 128) % 64;
    const pad = new Uint8Array(1 + zeros + 8);
    pad[0] = 0x80;
    const p = pad.length;
    pad[p - 8] = (hi >>> 24) & 0xff;
    pad[p - 7] = (hi >>> 16) & 0xff;
    pad[p - 6] = (hi >>> 8) & 0xff;
    pad[p - 5] = hi & 0xff;
    pad[p - 4] = (lo >>> 24) & 0xff;
    pad[p - 3] = (lo >>> 16) & 0xff;
    pad[p - 2] = (lo >>> 8) & 0xff;
    pad[p - 1] = lo & 0xff;

    const tail = new Uint8Array(len + p);
    tail.set(this.#buffer.subarray(0, len), 0);
    tail.set(pad, len);
    for (let off = 0; off < tail.length; off += 64) compress(h, tail, off);

    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i += 1) {
      const v = h[i]!;
      out[i * 4] = (v >>> 24) & 0xff;
      out[i * 4 + 1] = (v >>> 16) & 0xff;
      out[i * 4 + 2] = (v >>> 8) & 0xff;
      out[i * 4 + 3] = v & 0xff;
    }
    return out;
  }
}

/** 纯 TS UTF-8 编码（覆盖 BMP 外码点，代理对按 code point 合并）。 */
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) i += 1;
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return Uint8Array.from(out);
}

/** 可接受的摘要输入：字节或字符串（字符串按 UTF-8 编码后计摘要）。 */
export type BytesLike = Uint8Array | string;

/** 把 `BytesLike` 归一为字节。 */
export function toBytes(value: BytesLike): Uint8Array {
  return typeof value === 'string' ? utf8Encode(value) : value;
}

const HEX = '0123456789abcdef';

/** 小写 hex（不带前缀）。 */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i]!;
    out += HEX[(b >>> 4) & 0xf]! + HEX[b & 0xf]!;
  }
  return out;
}

/** 计算 32 字节原始摘要。 */
export function sha256Bytes(value: BytesLike): Uint8Array {
  return new Sha256().update(toBytes(value)).digest();
}

/** 计算 `sha256:<64 hex>` 形式的契约摘要。 */
export function sha256Digest(value: BytesLike): string {
  return `sha256:${toHex(sha256Bytes(value))}`;
}

/** 契约摘要形状校验（`^sha256:[0-9a-f]{64}$`）。 */
export function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

/** 摘要字符串常量前缀；避免在别处硬编码。 */
export const DIGEST_PREFIX = 'sha256:';

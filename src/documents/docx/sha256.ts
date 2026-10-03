/**
 * **纯 TypeScript SHA-256**（W01 手机 bytes 适配层用）。
 *
 * ## 为什么这里需要一份自己的实现
 *
 * 合同（`README.md` §3）要求手机内核里 `node:crypto` **逐项迁移或证明由 APK 内运行时支持**；
 * 在 K01 拿出运行时证据之前，"DOCX 装配回执"里那个 `digest` 不该是**新引入**的桌面运行时依赖。
 * 本模块把"对字节取 sha256"这一件事用纯 `Uint8Array` 算术实现，**零 import**（连 `node:*`
 * 都没有），因此它天然可在任意 JS 运行时（含手机 JSC/V8）执行。
 *
 * ## 与 `src/artifacts/digest.ts` 的关系（**已识别、待收敛**）
 *
 * `src/artifacts/digest.ts:digestBytes` 是"全仓唯一一处字节摘要"（它用 `node:crypto`），
 * 而 `src/documents/docx/import.ts:805` 已经在 import 路径上**无条件**调用它（拿前 16 位拼
 * `document_id`）。也就是说：**今天这条 DOCX 导入链已经传递依赖 `node:crypto`**，
 * 本模块不会、也无法单独消除它——那是 K01/K09 的迁移项，已如实列入 W01 的集成请求。
 * 本模块只保证"W01 新增的装配回执"这一层不再加深该依赖。
 *
 * 输出口径与 `digest.ts` **完全一致**：`sha256`、**裸小写十六进制**、无算法前缀、无换行。
 * 因此两处对同一字节必然给出同一串；收敛成一处时不会出现"摘要域不同"的静默错配。
 *
 * ## 正确性口径
 *
 * 实现照 FIPS 180-4。它是纯函数：同一 `bytes` 必然同一摘要，跨进程/跨机器/跨平台一致；
 * 零文件 IO、零墙钟、零随机数、零 `process.*`、零 locale、零全局可变状态。
 * `tests/mobile-office/word/W01/phone-bytes-assembler.test.ts` 拿 **`node:crypto` 作独立对照**
 * （测试侧允许用 `node:*`），对多组长度（含 55/56/63/64/65 这类分块边界）逐字节比对。
 */

/** FIPS 180-4 的 64 个轮常量。 */
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

/** 无符号 32 位右旋。 */
function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/**
 * 对原始字节取 SHA-256（**裸小写 hex**，无算法前缀）。
 *
 * @param bytes 待摘要的原始字节（`Uint8Array`）。
 * @returns 64 位小写十六进制摘要。
 */
export function sha256Hex(bytes: Uint8Array): string {
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const length = bytes.byteLength;
  // 填充：原文 + 1 个 0x80 + 若干 0x00 + 8 字节大端比特长度，使得总长为 64 的倍数。
  const paddedLength = (((length + 8) >> 6) + 1) << 6;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes, 0);
  buffer[length] = 0x80;
  const bitLength = length * 8;
  // 比特长度写进最后 8 字节（大端）。JS 数字安全到 2^53，故高 32 位用除法取。
  buffer[paddedLength - 8] = Math.floor(bitLength / 0x100000000) >>> 24;
  buffer[paddedLength - 7] = Math.floor(bitLength / 0x100000000) >>> 16;
  buffer[paddedLength - 6] = Math.floor(bitLength / 0x100000000) >>> 8;
  buffer[paddedLength - 5] = Math.floor(bitLength / 0x100000000) & 0xff;
  buffer[paddedLength - 4] = (bitLength >>> 24) & 0xff;
  buffer[paddedLength - 3] = (bitLength >>> 16) & 0xff;
  buffer[paddedLength - 2] = (bitLength >>> 8) & 0xff;
  buffer[paddedLength - 1] = bitLength & 0xff;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const base = offset + i * 4;
      w[i] =
        ((buffer[base] as number) << 24) |
        ((buffer[base + 1] as number) << 16) |
        ((buffer[base + 2] as number) << 8) |
        (buffer[base + 3] as number);
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15] as number;
      const y = w[i - 2] as number;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return (
    hex32(h0) + hex32(h1) + hex32(h2) + hex32(h3) +
    hex32(h4) + hex32(h5) + hex32(h6) + hex32(h7)
  );
}

/** 32 位无符号 → 8 位小写十六进制。 */
function hex32(value: number): string {
  return value.toString(16).padStart(8, '0');
}

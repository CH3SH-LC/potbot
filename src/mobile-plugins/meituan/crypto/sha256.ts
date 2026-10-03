/**
 * **美团包自有的纯 TypeScript SHA-256**（FIPS 180-4）。
 *
 * ## 为什么这里要有一份自己的实现
 *
 * M06（purchase-confirmation）的 `paramsDigest` 口径是 `sha256:<64 位小写十六进制>`（K07 账本
 * 强制 `^sha256:[0-9a-f]{64}$`），它此前**直接** `import` 了
 * `src/documents/docx/sha256.ts`，于是产生一条 **美团 → Word 的跨包依赖**（M06 集成请求 #3，
 * 需协调者裁决）。在裁决落地前，本模块提供**同一算法的美团归属实现**，使美团内部可以就地
 * 收敛掉这条依赖，**无需**移动任何共享文件。
 *
 * 本模块与 docx 版口径**完全一致**：对同一 `Uint8Array` 必然给出**逐字符相同**的
 * 裸小写十六进制串（对照由 `tests/mobile-meituan/M-I20/docx-parity.test.ts` 只读钉死）。
 *
 * ## 纪律
 *
 * - **零 import**（连 `node:*` 都没有）、**零第三方依赖**；纯 `Uint8Array` 算术 + `DataView`。
 * - **纯函数**：不读文件、不读时钟、不读随机数、不读环境；同一字节必然同一摘要。
 * - 因此它天然可在任意 JS 运行时（含手机 JSC/V8）执行。`tests/mobile-meituan/M-I20/boundary.test.ts`
 *   以静态扫描强制「crypto 包源码不得出现 `node:*` / `require(` / 非相对导入」。
 *
 * 实现照 FIPS 180-4 §4.2.2（64 轮常量）、§5.1.1（填充）、§6.2（摘要算法）。
 */

/** FIPS 180-4 §4.2.2 的 64 个轮常量（质数立方根小数部分的前 32 位）。 */
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

/** 无符号 32 位右旋（`bits` 恒为正且小于 32）。 */
function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/**
 * 对原始字节取 SHA-256，返回**裸小写十六进制**（64 字符，无算法前缀、无换行）。
 *
 * @param bytes 待摘要的原始字节（`Uint8Array`；零拷贝读取，不修改入参）。
 * @returns 64 位小写十六进制摘要。
 */
export function sha256Hex(bytes: Uint8Array): string {
  // FIPS 180-4 §5.3.3 初始哈希值（前 8 个质数平方根小数部分的前 32 位）。
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const byteLength = bytes.byteLength;
  const bitLength = byteLength * 8;
  // 填充：原文 + 1 个 0x80 + 若干 0x00 + 8 字节大端比特长度，使总长为 64 的倍数。
  const paddedLength = Math.ceil((byteLength + 9) / 64) * 64;

  const padded = new Uint8Array(paddedLength);
  padded.set(bytes, 0);
  padded[byteLength] = 0x80;

  // 比特长度写进最后 8 字节（大端）。JS 数字安全到 2^53，故高 32 位用除法取。
  const bits = new DataView(padded.buffer);
  bits.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  bits.setUint32(paddedLength - 4, bitLength >>> 0);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = bits.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15] as number;
      const y = w[i - 2] as number;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }

    let a = state[0] as number;
    let b = state[1] as number;
    let c = state[2] as number;
    let d = state[3] as number;
    let e = state[4] as number;
    let f = state[5] as number;
    let g = state[6] as number;
    let h = state[7] as number;

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

    state[0] = ((state[0] as number) + a) >>> 0;
    state[1] = ((state[1] as number) + b) >>> 0;
    state[2] = ((state[2] as number) + c) >>> 0;
    state[3] = ((state[3] as number) + d) >>> 0;
    state[4] = ((state[4] as number) + e) >>> 0;
    state[5] = ((state[5] as number) + f) >>> 0;
    state[6] = ((state[6] as number) + g) >>> 0;
    state[7] = ((state[7] as number) + h) >>> 0;
  }

  let hex = '';
  for (let i = 0; i < 8; i += 1) {
    hex += (state[i] as number).toString(16).padStart(8, '0');
  }
  return hex;
}

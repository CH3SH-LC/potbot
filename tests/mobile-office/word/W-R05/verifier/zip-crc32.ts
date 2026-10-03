/**
 * **独立 CRC-32**（W-R05 自研校验侧）——刻意**不复用** `src/artifacts/ooxml/crc32.ts`。
 *
 * 复核的意义在于「用另一套代码得出同一结论」：如果校验器和被测实现共用同一个 CRC
 * 函数，那么当那个函数本身写错时，两边会**一起错**，校验器给出的是假绿。故此处用
 * **逐位实现**（bit-at-a-time），与仓内那套**查表实现**（table-driven）在算法骨架上就
 * 不是同一份代码，只共享数学定义：反射多项式 `0xEDB88320`、初值/末值 `0xFFFFFFFF`。
 *
 * 纯函数：零 IO、零依赖、不读时钟、不读环境。
 */

const POLYNOMIAL = 0xedb88320;

/**
 * 计算 CRC-32（ZIP / IEEE 802.3 口径）。
 *
 * @param bytes 原始字节。
 * @returns 无符号 32 位整数，按 ZIP 中央目录字段的小端语义可直接比较。
 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index] ?? 0;
    for (let bit = 0; bit < 8; bit += 1) {
      // 最低位为 1 时异或多项式，否则仅右移；每轮处理一位。
      crc = (crc & 1) !== 0 ? POLYNOMIAL ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

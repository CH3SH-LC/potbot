/**
 * CRC-32（IEEE 802.3，反射多项式 `0xEDB88320`）——**全仓唯一实现**。
 *
 * 归属：W-A（design-02 批次 A：确定性 OOXML 容器核心）。下游 `zip.ts` 的每个条目都要写
 * CRC-32 字段；W-D 的模板构建器不应再自带一份（两份实现漂移 = 容器字节不可比）。
 *
 * 为什么是这张表、这个初值/末值：
 * - 多项式 `0xEDB88320` 是标准 CRC-32 的**反射**写法，ZIP（APPNOTE 4.4.5）用的就是它；
 * - 初值 `0xFFFFFFFF` + 末值再异或 `0xFFFFFFFF`（即 `~crc`）是该标准的固定两端；
 * - 表驱动是为了**确定性优先**：逐位实现与查表实现在数学上等价，查表把"每字节 8 次循环"
 *   收敛成一次查表，且不会引入任何平台相关分支。
 *
 * 纯函数：零 IO、零依赖、不读墙钟、不读环境。（表在首次调用时惰性构建后缓存，只是性能优化，
 * 不改变任何输入到输出的映射——同一输入在任何进程、任何次调用下都返回同一结果。）
 */

/** 反射多项式（CRC-32 / ZIP 标准）。 */
export const CRC32_POLYNOMIAL = 0xedb88320;

/** 初值。 */
export const CRC32_INITIAL = 0xffffffff;

/** 末值与结果异或的值。 */
export const CRC32_XOR_OUT = 0xffffffff;

/** 空字节串的 CRC-32（`0x00000000`）——STORE 空文件条目会正好命中这个值。 */
export const CRC32_OF_EMPTY = 0x00000000;

const TABLE_SIZE = 256;

let table: Uint32Array | undefined;

function buildTable(): Uint32Array {
  const built = new Uint32Array(TABLE_SIZE);
  for (let index = 0; index < TABLE_SIZE; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? CRC32_POLYNOMIAL ^ (value >>> 1) : value >>> 1;
    }
    built[index] = value >>> 0;
  }
  return built;
}

function tableOf(): Uint32Array {
  table ??= buildTable();
  return table;
}

/**
 * 计算 CRC-32。
 *
 * @param input 字节串，或将被按 **UTF-8** 编码的文本（中文按 UTF-8 多字节计入，与 ZIP 条目的
 *              实际存储字节一致）。
 * @returns 无符号 32 位整数（`0` … `0xFFFFFFFF`）。
 */
export function crc32(input: Uint8Array | string): number {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const lookup = tableOf();

  let value = CRC32_INITIAL;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] as number;
    value = (lookup[(value ^ byte) & 0xff] as number) ^ (value >>> 8);
  }
  return (value ^ CRC32_XOR_OUT) >>> 0;
}

/** CRC-32 的 8 位十六进制小写形式（证据/日志用；不参与容器字节）。 */
export function crc32Hex(input: Uint8Array | string): string {
  return crc32(input).toString(16).padStart(8, '0');
}

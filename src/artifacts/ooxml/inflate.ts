/**
 * **纯 TypeScript 的 raw DEFLATE 解压**（RFC 1951 的 `inflate`）——归属 WCF-D02。
 *
 * ## 为什么不用 `node:zlib`
 *
 * 读侧用 `node:zlib.inflateRawSync` 本来是最省事的写法，而且入参是内存字节、不违反
 * "`src/**` 零文件 IO"。但它会撞上本仓**既有的验收断言**：
 * `tests/acceptance/office/w-disc-kernel-discipline.test.ts` 把 `src/**`（非测试）的
 * `node:*` 白名单钉死在 **只有 `node:crypto`**，并且连"代码文本里出现 `node:zlib` 字样"
 * 都会判红。那条断言是 design-02 批次（W-DISC）立的合同，**不在本次的写权范围内**，
 * 因此正确的做法不是去改它，而是**让读侧不依赖 `node:zlib`**。
 *
 * 附带的好处是实打实的：
 * - 内核继续"零运行期依赖"，`package.json` 的 `dependencies` 保持为空；
 * - 不依赖宿主 zlib 版本，同一输入在任何 JS 运行时（含**安卓 WebView 那一侧**）解出同一结果；
 * - 解压是**显式有界**的：输出上限在这里是第一等公民，而不是靠宿主库的 `maxOutputLength`。
 *
 * ## 正确性怎么保证
 *
 * 不靠"看起来对"：`inflate.test.ts` 用 **`node:zlib.deflateRawSync`（参考实现）**造数据，
 * 覆盖 stored / fixed-Huffman / dynamic-Huffman 三种块型、多个压缩级别与重复度，
 * 逐字节比对。参考实现在测试侧，产品侧不引用它。
 *
 * ## 有界（R159）
 *
 * 输出一旦要超过 `maxOutputLength`，立刻抛 `InflateError('limit')`——**不是**先解完再截断。
 * 内存分配也按上限收敛（初始容量取 `min(上限, 4 KiB)`，按需倍增，绝不超过上限）。
 */

/** DEFLATE 的最长码长。 */
const MAX_CODE_BITS = 15;
/** 动态块里 code length 字母表的码长（3 位）。 */
const CODELEN_BITS = 7;
/** 固定的 code-length 字母表读取顺序（RFC 1951 §3.2.7）。 */
const CODE_LENGTH_ORDER: readonly number[] = [
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];

/** 长度码 257–285 的基值与额外位数。 */
const LENGTH_BASE: readonly number[] = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];

/** 距离码 0–29 的基值与额外位数。 */
const DISTANCE_BASE: readonly number[] = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA: readonly number[] = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

export type InflateErrorReason =
  /** 压缩流提前结束（比特不够读）。 */
  | 'truncated'
  /** 流的结构非法（保留块型、码表超订、码字不合法、repeat 越界……）。 */
  | 'invalid'
  /** 反向引用的距离超过已输出长度（LZ77 里不可能出现的引用）。 */
  | 'distance'
  /** 输出会超过调用方给的上限。 */
  | 'limit';

export class InflateError extends Error {
  readonly reason: InflateErrorReason;

  constructor(reason: InflateErrorReason, message: string) {
    super(message);
    this.name = 'InflateError';
    this.reason = reason;
  }
}

/** 解压选项。`maxOutputLength` 是**硬门**。 */
export interface InflateOptions {
  readonly maxOutputLength: number;
}

// ---------------------------------------------------------------------------
// 比特读取
// ---------------------------------------------------------------------------

class BitReader {
  private bytePosition = 0;
  private bitBuffer = 0;
  private bitCount = 0;

  constructor(private readonly input: Uint8Array) {}

  /** 读 `count` 位（低位在前）。`count` 为 0 时返回 0。 */
  readBits(count: number): number {
    while (this.bitCount < count) {
      if (this.bytePosition >= this.input.length) {
        throw new InflateError('truncated', '压缩流在读完之前就结束了');
      }
      // bitCount 至多到 count + 7 ≤ 22，故 32 位位运算不会溢出。
      this.bitBuffer |= (this.input[this.bytePosition] as number) << this.bitCount;
      this.bytePosition += 1;
      this.bitCount += 8;
    }
    const value = this.bitBuffer & ((1 << count) - 1);
    this.bitBuffer >>>= count;
    this.bitCount -= count;
    return value;
  }

  /** 丢弃到字节边界（stored 块用）。 */
  alignToByte(): void {
    const drop = this.bitCount & 7;
    this.bitBuffer >>>= drop;
    this.bitCount -= drop;
  }

  /** 按字节读出 `count` 个字节（stored 块用；调用前必须已经对齐）。 */
  readBytes(count: number, output: OutputBuffer): void {
    if ((this.bitCount & 7) !== 0) {
      throw new InflateError('invalid', 'stored 块之前没有对齐到字节边界');
    }
    // 先把位缓冲里已经读进来的整字节吐出去。
    while (this.bitCount >= 8) {
      output.push((this.bitBuffer & 0xff) as number);
      this.bitBuffer >>>= 8;
      this.bitCount -= 8;
    }
    for (let index = 0; index < count; index += 1) {
      if (this.bytePosition >= this.input.length) {
        throw new InflateError('truncated', 'stored 块的数据不完整');
      }
      output.push(this.input[this.bytePosition] as number);
      this.bytePosition += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// 输出缓冲（显式有界）
// ---------------------------------------------------------------------------

const INITIAL_CAPACITY = 4096;

class OutputBuffer {
  private buffer: Uint8Array;
  private length = 0;

  constructor(private readonly limit: number) {
    this.buffer = new Uint8Array(Math.max(1, Math.min(limit, INITIAL_CAPACITY)));
  }

  private ensure(extra: number): void {
    if (this.length + extra > this.limit) {
      throw new InflateError(
        'limit',
        `解压输出将超过上限 ${String(this.limit)} 字节（在已输出 ${String(this.length)} 字节处停下）`,
      );
    }
    if (this.length + extra <= this.buffer.length) return;
    let capacity = this.buffer.length;
    while (capacity < this.length + extra) capacity = Math.min(capacity * 2, Math.max(1, this.limit));
    const grown = new Uint8Array(capacity);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }

  push(byte: number): void {
    this.ensure(1);
    this.buffer[this.length] = byte;
    this.length += 1;
  }

  /** LZ77 反向拷贝：**逐字节**拷贝，因此 `distance < count` 的重叠语义天然正确。 */
  copy(distance: number, count: number): void {
    if (distance < 1 || distance > this.length) {
      throw new InflateError(
        'distance',
        `反向引用距离 ${String(distance)} 超过已输出长度 ${String(this.length)}`,
      );
    }
    this.ensure(count);
    for (let index = 0; index < count; index += 1) {
      this.buffer[this.length] = this.buffer[this.length - distance] as number;
      this.length += 1;
    }
  }

  toUint8Array(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

// ---------------------------------------------------------------------------
// Huffman 表
// ---------------------------------------------------------------------------

interface HuffmanTable {
  /** `counts[length]` = 该长度的码字数（`counts[0]` 不用）。 */
  readonly counts: Uint16Array;
  /** 按（码长, 码字）排序后的符号表。 */
  readonly symbols: Uint16Array;
  readonly maxBits: number;
}

/** 由码长表构建规范 Huffman 表（RFC 1951 §3.2.2）。超订即报错，不静默取一个近似表。 */
function buildHuffman(lengths: readonly number[], symbolCount: number): HuffmanTable {
  const counts = new Uint16Array(MAX_CODE_BITS + 1);
  for (let symbol = 0; symbol < symbolCount; symbol += 1) {
    const length = lengths[symbol] as number;
    counts[length] = (counts[length] as number) + 1;
  }

  let maxBits = 0;
  for (let length = MAX_CODE_BITS; length >= 1; length -= 1) {
    if ((counts[length] as number) > 0) {
      maxBits = length;
      break;
    }
  }
  if (maxBits === 0) {
    // 没有任何码字：合法但不可解码（例如"这个块里没有距离码"）。
    return { counts, symbols: new Uint16Array(0), maxBits: 0 };
  }

  // 超订检查：left 为负表示码长表给出的码字数超过了该长度能容纳的上限。
  let left = 1;
  for (let length = 1; length <= MAX_CODE_BITS; length += 1) {
    left <<= 1;
    left -= counts[length] as number;
    if (left < 0) {
      throw new InflateError('invalid', `Huffman 码长表超订（长度 ${String(length)}）`);
    }
  }

  const offsets = new Uint16Array(MAX_CODE_BITS + 2);
  for (let length = 1; length <= MAX_CODE_BITS; length += 1) {
    offsets[length + 1] = (offsets[length] as number) + (counts[length] as number);
  }
  const symbols = new Uint16Array(symbolCount);
  for (let symbol = 0; symbol < symbolCount; symbol += 1) {
    const length = lengths[symbol] as number;
    if (length === 0) continue;
    symbols[offsets[length] as number] = symbol;
    offsets[length] = (offsets[length] as number) + 1;
  }

  return { counts, symbols, maxBits };
}

/** 逐位解一个符号（puff 的走法：不需要 2^15 的查表，也不需要额外的数学）。 */
function decodeSymbol(reader: BitReader, table: HuffmanTable): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let length = 1; length <= table.maxBits; length += 1) {
    code |= reader.readBits(1);
    const count = table.counts[length] as number;
    if (code - first < count) {
      return table.symbols[index + (code - first)] as number;
    }
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new InflateError('invalid', 'Huffman 码字不在码表内（比特流损坏）');
}

// ---------------------------------------------------------------------------
// 固定码表（BTYPE = 1）
// ---------------------------------------------------------------------------

function fixedLiteralLengths(): Uint8Array {
  const lengths = new Uint8Array(288);
  for (let symbol = 0; symbol <= 143; symbol += 1) lengths[symbol] = 8;
  for (let symbol = 144; symbol <= 255; symbol += 1) lengths[symbol] = 9;
  for (let symbol = 256; symbol <= 279; symbol += 1) lengths[symbol] = 7;
  for (let symbol = 280; symbol <= 287; symbol += 1) lengths[symbol] = 8;
  return lengths;
}

const FIXED_LITERAL_TABLE = buildHuffman(Array.from(fixedLiteralLengths()), 288);
const FIXED_DISTANCE_TABLE = buildHuffman(new Array<number>(30).fill(5), 30);

// ---------------------------------------------------------------------------
// 块解码
// ---------------------------------------------------------------------------

function decodeCompressedBlock(
  reader: BitReader,
  output: OutputBuffer,
  literalTable: HuffmanTable,
  distanceTable: HuffmanTable,
): void {
  for (;;) {
    const symbol = decodeSymbol(reader, literalTable);
    if (symbol < 256) {
      output.push(symbol);
      continue;
    }
    if (symbol === 256) return; // 块结束

    const lengthIndex = symbol - 257;
    const lengthBase = LENGTH_BASE[lengthIndex];
    const lengthExtra = LENGTH_EXTRA[lengthIndex];
    if (lengthBase === undefined || lengthExtra === undefined) {
      throw new InflateError('invalid', `长度码 ${String(symbol)} 超出 RFC 1951 的 257–285 范围`);
    }
    const length = lengthBase + reader.readBits(lengthExtra);

    const distanceSymbol = decodeSymbol(reader, distanceTable);
    const distanceBase = DISTANCE_BASE[distanceSymbol];
    const distanceExtraBits = DISTANCE_EXTRA[distanceSymbol];
    if (distanceBase === undefined || distanceExtraBits === undefined) {
      throw new InflateError('invalid', `距离码 ${String(distanceSymbol)} 超出 0–29 范围`);
    }
    const distance = distanceBase + reader.readBits(distanceExtraBits);

    output.copy(distance, length);
  }
}

function decodeStoredBlock(reader: BitReader, output: OutputBuffer): void {
  reader.alignToByte();
  const lengthLow = reader.readBits(8);
  const lengthHigh = reader.readBits(8);
  const length = lengthLow | (lengthHigh << 8);
  const complementLow = reader.readBits(8);
  const complementHigh = reader.readBits(8);
  const complement = complementLow | (complementHigh << 8);
  if ((length ^ 0xffff) !== complement) {
    throw new InflateError('invalid', 'stored 块的 LEN 与 NLEN 不互补（数据损坏）');
  }
  reader.readBytes(length, output);
}

function decodeDynamicBlock(reader: BitReader, output: OutputBuffer): void {
  const literalCount = reader.readBits(5) + 257;
  const distanceCount = reader.readBits(5) + 1;
  const codeLengthCount = reader.readBits(4) + 4;

  const codeLengthLengths = new Uint8Array(19);
  for (let index = 0; index < codeLengthCount; index += 1) {
    codeLengthLengths[CODE_LENGTH_ORDER[index] as number] = reader.readBits(3);
  }
  const codeLengthTable = buildHuffman(Array.from(codeLengthLengths), 19);

  const total = literalCount + distanceCount;
  const lengths: number[] = new Array<number>(total).fill(0);
  let index = 0;
  while (index < total) {
    const symbol = decodeSymbol(reader, codeLengthTable);
    if (symbol < 16) {
      lengths[index] = symbol;
      index += 1;
      continue;
    }
    let repeat = 0;
    let value = 0;
    if (symbol === 16) {
      if (index === 0) {
        throw new InflateError('invalid', '码长 repeat(16) 出现在第一个位置（没有前一个码长可重复）');
      }
      repeat = 3 + reader.readBits(2);
      value = lengths[index - 1] as number;
    } else if (symbol === 17) {
      repeat = 3 + reader.readBits(3);
    } else if (symbol === 18) {
      repeat = 11 + reader.readBits(7);
    } else {
      throw new InflateError('invalid', `码长字母表出现非法符号 ${String(symbol)}`);
    }
    if (index + repeat > total) {
      throw new InflateError('invalid', '码长 repeat 超出了码字总数');
    }
    for (let step = 0; step < repeat; step += 1) {
      lengths[index] = value;
      index += 1;
    }
  }

  const literalLengths = lengths.slice(0, literalCount);
  const distanceLengths = lengths.slice(literalCount);
  // 末端的零长码不参与（RFC 1951 允许 HLIT/HDIST 比实际用到的多）。
  if ((literalLengths[256] ?? 0) === 0) {
    throw new InflateError('invalid', '动态块缺少块结束码 256');
  }

  const literalTable = buildHuffman(literalLengths, literalCount);
  const distanceTable = buildHuffman(distanceLengths, distanceCount);
  decodeCompressedBlock(reader, output, literalTable, distanceTable);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 解压一段 **raw DEFLATE**（无 zlib 头、无 gzip 头）数据。
 *
 * @param input 压缩字节。
 * @param options `maxOutputLength`：输出上限，超过即抛 `InflateError('limit')`。
 * @throws {InflateError} 结构非法 / 截断 / 距离越界 / 超限。
 */
export function inflateRaw(input: Uint8Array, options: InflateOptions): Uint8Array {
  const limit = options.maxOutputLength;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new InflateError('invalid', `maxOutputLength 必须是非负安全整数，收到 ${String(limit)}`);
  }

  const reader = new BitReader(input);
  const output = new OutputBuffer(limit);

  let isFinal = 0;
  do {
    isFinal = reader.readBits(1);
    const blockType = reader.readBits(2);
    switch (blockType) {
      case 0:
        decodeStoredBlock(reader, output);
        break;
      case 1:
        decodeCompressedBlock(reader, output, FIXED_LITERAL_TABLE, FIXED_DISTANCE_TABLE);
        break;
      case 2:
        decodeDynamicBlock(reader, output);
        break;
      default:
        throw new InflateError('invalid', '块类型 3 是保留值（RFC 1951 不允许）');
    }
  } while (isFinal === 0);

  return output.toUint8Array();
}

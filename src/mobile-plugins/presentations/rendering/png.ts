/**
 * **PNG 编解码（纯 TS）**——真实的逐字节格式，不是占位。
 *
 * - 编码：签名 + IHDR + IDAT（`zlib-store.ts` 造的 zlib 流）+ IEND，每块带 CRC32；
 *   颜色类型 2（RGB）/ 6（RGBA），8 位、非隔行。
 * - 解码：支持位深 8、颜色类型 2/6、非隔行、过滤器 0–4，**校验每块的 CRC32**
 *   （CRC 不符即抛——这样"编码器写坏了 CRC"能被读回时抓到）。
 *
 * 压缩/解压**不用宿主内建模块**（合同 R50.4：内核要跑在手机的 JS 运行时里）：
 * 压缩写 stored deflate 块，解压复用 `src/artifacts/ooxml/inflate.ts`，见 `zlib-store.ts`。
 *
 * 不支持的分支**显式抛错**（`PngError`），不静默产出一张错图。
 */

import { describeZlibError, zlibInflate, zlibStoreCompress } from './zlib-store.js';

import type { SourceImage } from './canvas.js';

/** PNG 层错误。 */
export class PngError extends Error {
  readonly code: 'bad_signature' | 'bad_structure' | 'unsupported' | 'bad_crc' | 'bad_filter';
  constructor(code: PngError['code'], message: string) {
    super(message);
    this.name = 'PngError';
    this.code = code;
  }
}

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** 标准 PNG CRC32。 */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = (CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// 编码
// ---------------------------------------------------------------------------

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'latin1');
  const crcInput = Buffer.concat([typeBytes, Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBytes, Buffer.from(data), crc]);
}

/**
 * 把一张 RGB / RGBA 位图编码成 PNG 字节。
 *
 * 每个扫描行前缀过滤器字节 `0`（None）；IDAT 是 `zlib-store.ts` 造的 zlib 流（stored 块）。
 */
export function encodePng(image: SourceImage): Buffer {
  if (image.data.length !== image.width * image.height * image.channels) {
    throw new PngError(
      'bad_structure',
      `位图数据长度 ${String(image.data.length)} 与 ${String(image.width)}×${String(image.height)}×${String(image.channels)} 不符`,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(image.channels === 4 ? 6 : 2, 9); // color type
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace

  const stride = image.width * image.channels;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const dst = y * (stride + 1);
    raw[dst] = 0; // filter: None
    for (let x = 0; x < stride; x += 1) raw[dst + 1 + x] = image.data[y * stride + x] ?? 0;
  }
  const idat = zlibStoreCompress(raw);

  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 解码
// ---------------------------------------------------------------------------

interface ChunkRecord {
  readonly type: string;
  readonly data: Buffer;
  readonly crcOk: boolean;
}

function readChunks(bytes: Uint8Array): ChunkRecord[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (buf[i] !== PNG_SIGNATURE[i]) throw new PngError('bad_signature', '不是 PNG：签名不符');
  }
  const chunks: ChunkRecord[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) throw new PngError('bad_structure', `块 ${type} 长度越界`);
    const data = buf.subarray(dataStart, dataEnd);
    const storedCrc = buf.readUInt32BE(dataEnd);
    const computed = crc32(buf.subarray(offset + 4, dataEnd));
    chunks.push({ type, data: Buffer.from(data), crcOk: storedCrc === computed });
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

/**
 * 解开 IDAT 负载（多块 IDAT 已按规范拼接）并翻成本层的错误码。
 *
 * 上限取**规范要求的确切长度** `(stride + 1) × height`——非隔行 8 位 PNG 的解压结果必须
 * 正好这么多；超出即结构非法（`inflateRaw` 抛 `limit`），少于此处在调用方判 `bad_structure`。
 */
function inflateIdat(idat: Buffer, expectedLength: number): Uint8Array {
  try {
    return zlibInflate(idat, expectedLength);
  } catch (error) {
    throw new PngError('bad_structure', `IDAT 解压失败：${describeZlibError(error)}`);
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * 解码 PNG 成 `SourceImage`。
 *
 * 只支持位深 8、颜色类型 2（RGB）/ 6（RGBA）、非隔行；其余**抛 `unsupported`**，
 * 由调用方上报 `undecodable_image`，**不静默产错图**。
 */
export function decodePng(bytes: Uint8Array): SourceImage {
  const chunks = readChunks(bytes);
  const badCrc = chunks.find((c) => !c.crcOk);
  if (badCrc !== undefined) throw new PngError('bad_crc', `PNG 块 ${badCrc.type} 的 CRC32 不符`);

  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (ihdr === undefined || ihdr.data.length < 13) {
    throw new PngError('bad_structure', '缺少合法 IHDR');
  }
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data.readUInt8(8);
  const colorType = ihdr.data.readUInt8(9);
  const interlace = ihdr.data.readUInt8(12);
  if (bitDepth !== 8) throw new PngError('unsupported', `只支持 8 位，收到 ${String(bitDepth)} 位`);
  if (colorType !== 2 && colorType !== 6) {
    throw new PngError('unsupported', `只支持颜色类型 2/6，收到 ${String(colorType)}`);
  }
  if (interlace !== 0) throw new PngError('unsupported', '不支持隔行 PNG');

  const channels: 3 | 4 = colorType === 6 ? 4 : 3;
  const bpp = channels;
  const stride = width * bpp;

  const idatParts = chunks.filter((c) => c.type === 'IDAT').map((c) => c.data);
  if (idatParts.length === 0) throw new PngError('bad_structure', '缺少 IDAT');
  const inflated = inflateIdat(Buffer.concat(idatParts), (stride + 1) * height);

  if (inflated.length < (stride + 1) * height) {
    throw new PngError('bad_structure', 'IDAT 解压后长度不足');
  }

  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const srcRow = y * (stride + 1);
    const filter = inflated[srcRow] ?? 0;
    const dstRow = y * stride;
    const prevRow = dstRow - stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[srcRow + 1 + x] ?? 0;
      const left = x >= bpp ? (out[dstRow + x - bpp] ?? 0) : 0;
      const up = y > 0 ? (out[prevRow + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= bpp ? (out[prevRow + x - bpp] ?? 0) : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + ((left + up) >> 1);
          break;
        case 4:
          value = raw + paeth(left, up, upLeft);
          break;
        default:
          throw new PngError('bad_filter', `未知过滤器类型 ${String(filter)}`);
      }
      out[dstRow + x] = value & 0xff;
    }
  }

  return { width, height, channels, data: out };
}

/** 是否为 PNG 字节（按签名）。 */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

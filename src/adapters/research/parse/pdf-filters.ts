/**
 * PDF 流过滤器（有界实现）。
 *
 * 只实现本机真实语料**实际用到**的：`ASCII85Decode`（ReportLab 生成的小样本）
 * 与 `FlateDecode`（Word/ReportLab 通用）。未实现的过滤器**显式报错**，
 * 不静默返回空——否则"读不到"会被误当成"文件没有内容"。
 *
 * **解压复用仓内既有的纯 TypeScript 实现** `src/artifacts/ooxml/inflate.ts`（只读 import），
 * 本文件因此**零 `node:*`**。合同 **R50.4** 要求 `src/**` 保持零文件 IO，
 * 纪律判据 `w-disc-kernel-discipline.test.ts` 禁止 `src/**` 非测试文件出现 `node:zlib`；
 * 按"能复用就复用"的纪律，此处**不再自写**一份 inflate，也不申请豁免。
 *
 * 注意：PDF 的 `FlateDecode` 是 **zlib 包装**（RFC 1950：2 字节头 + deflate + adler32），
 * 而 `inflateRaw` 吃的是**裸 deflate**（RFC 1951）。故先剥离 zlib 头；
 * 尾部 adler32 无需剥离——`inflateRaw` 在 final block 后即停，尾部字节不会被读。
 */
import { InflateError, inflateRaw } from '../../../artifacts/ooxml/inflate.js';

/** 解压输出上限（硬门）：单条 PDF 流 64 MiB 已远超本切片的真实语料。 */
const MAX_STREAM_OUTPUT = 64 * 1024 * 1024;

export interface FilterFailure {
  readonly ok: false;
  readonly reason: string;
}
export interface FilterSuccess {
  readonly ok: true;
  readonly bytes: Uint8Array;
}

/** ASCII85 解码（PDF 1.7 §7.4.3）。`~>` 可选；支持 `z` 简写；忽略空白。 */
export function ascii85Decode(input: Uint8Array): FilterSuccess | FilterFailure {
  const out: number[] = [];
  let group: number[] = [];

  let start = 0;
  let end = input.length;
  if (end - start >= 2 && input[start] === 0x3c && input[start + 1] === 0x7e) {
    start += 2;
  }
  if (end - start >= 2 && input[end - 1] === 0x3e && input[end - 2] === 0x7e) {
    end -= 2;
  }

  for (let i = start; i < end; i += 1) {
    const c = input[i] as number;
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c || c === 0x00) {
      continue;
    }
    if (c === 0x7a) {
      if (group.length !== 0) {
        return { ok: false, reason: "ASCII85 的 'z' 出现在非组边界" };
      }
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) {
      return { ok: false, reason: `ASCII85 非法字符 0x${c.toString(16)}` };
    }
    group.push(c - 0x21);
    if (group.length === 5) {
      let value = 0;
      for (const g of group) {
        value = value * 85 + g;
      }
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
      group = [];
    }
  }

  if (group.length === 1) {
    return { ok: false, reason: 'ASCII85 末尾组长度非法（1）' };
  }
  if (group.length > 1) {
    const pad = 5 - group.length;
    let value = 0;
    for (let i = 0; i < 5; i += 1) {
      value = value * 85 + (i < group.length ? (group[i] as number) : 84);
    }
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    out.push(...bytes.slice(0, 4 - pad));
  }

  return { ok: true, bytes: new Uint8Array(out) };
}

/** 若是 zlib（RFC 1950）包装，返回去掉 2 字节头后的裸 deflate；否则 null。 */
function stripZlibHeader(input: Uint8Array): Uint8Array | null {
  if (input.length < 2) {
    return null;
  }
  const cmf = input[0] as number;
  const flg = input[1] as number;
  if ((cmf & 0x0f) !== 8) {
    return null; // CM 必须是 8 = deflate
  }
  if (((cmf << 8) | flg) % 31 !== 0) {
    return null; // FCHECK 校验失败
  }
  if ((flg & 0x20) !== 0) {
    return null; // 预设字典，本切片不支持
  }
  return input.subarray(2);
}

function tryInflateRaw(input: Uint8Array): FilterSuccess | null {
  try {
    return { ok: true, bytes: inflateRaw(input, { maxOutputLength: MAX_STREAM_OUTPUT }) };
  } catch (error) {
    if (!(error instanceof InflateError)) {
      throw error;
    }
    return null;
  }
}

/** FlateDecode：先按 zlib 包装剥头，再退回裸 deflate。 */
export function flateDecode(input: Uint8Array): FilterSuccess | FilterFailure {
  const zlibBody = stripZlibHeader(input);
  if (zlibBody !== null) {
    const wrapped = tryInflateRaw(zlibBody);
    if (wrapped !== null) {
      return wrapped;
    }
  }
  const bare = tryInflateRaw(input);
  if (bare !== null) {
    return bare;
  }
  return { ok: false, reason: 'FlateDecode 失败：既不是合法 zlib 流也不是合法裸 deflate' };
}

/** 按过滤器名链依次解码。 */
export function applyFilters(input: Uint8Array, filters: readonly string[]): FilterSuccess | FilterFailure {
  let current = input;
  for (const filter of filters) {
    const name = filter.replace(/^\//, '');
    let step: FilterSuccess | FilterFailure;
    if (name === 'FlateDecode' || name === 'Fl') {
      step = flateDecode(current);
    } else if (name === 'ASCII85Decode' || name === 'A85') {
      step = ascii85Decode(current);
    } else {
      return { ok: false, reason: `未实现的 PDF 过滤器：/${name}（本切片只实现 FlateDecode / ASCII85Decode）` };
    }
    if (!step.ok) {
      return step;
    }
    current = step.bytes;
  }
  return { ok: true, bytes: current };
}

/** 从流字典文本里取 `/Filter` 的过滤器名序列。 */
export function parseFilterNames(dict: string): string[] {
  const arrayMatch = /\/Filter\s*\[([^\]]*)\]/.exec(dict);
  if (arrayMatch) {
    const inner = arrayMatch[1] ?? '';
    return [...inner.matchAll(/\/([A-Za-z0-9]+)/g)].map((m) => m[1] as string);
  }
  const single = /\/Filter\s*\/([A-Za-z0-9]+)/.exec(dict);
  return single ? [single[1] as string] : [];
}

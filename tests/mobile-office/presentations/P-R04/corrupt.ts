/**
 * P-R04 · **损坏输入生成器**（测试夹具）。
 *
 * 两种手法：
 * - **原地改字节**（`truncateTail` / `flipByteAt` / `overwriteU32At` / `appendTail`）：不改条目集合，
 *   只动一份真实包的字节，用来喂容器层的独立校验器与生产 `readZip`；
 * - **重建包**（`dropEntry` / `replaceEntryText`）：用生产的 `writeZip` 重新组装（结构合法），
 *   但**故意**让关系图上悬挂——用来验证图级校验器能咬住"ZIP 合法但 OPC 关系断裂"。
 *
 * 这里用 `writeZip` **只做夹具构造**，不参与校验；校验一律走本包的 `independent-zip.ts` /
 * `opc-graph.ts` 两份独立实现。
 */

import { writeZip, type ZipEntry } from '../../../../src/artifacts/ooxml/index.js';
import { inspectZip } from './independent-zip.js';

function clone(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

/** 砍掉末尾 `count` 字节：EOCD 随之消失（真实"下载被截断"）。 */
export function truncateTail(bytes: Uint8Array, count: number): Uint8Array {
  if (count <= 0 || count >= bytes.byteLength) throw new Error(`截断长度非法：${String(count)}`);
  return bytes.slice(0, bytes.byteLength - count);
}

/** 在给定绝对偏移翻转一个字节（`0xFF` 异或）。 */
export function flipByteAt(bytes: Uint8Array, offset: number): Uint8Array {
  const copy = clone(bytes);
  if (offset < 0 || offset >= copy.byteLength) throw new Error(`偏移越界：${String(offset)}`);
  copy[offset] = (copy[offset] as number) ^ 0xff;
  return copy;
}

/** 在给定绝对偏移覆写一个 32 位小端值（用于打坏签名）。 */
export function overwriteU32At(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = clone(bytes);
  if (offset < 0 || offset + 4 > copy.byteLength) throw new Error(`偏移越界：${String(offset)}`);
  new DataView(copy.buffer, copy.byteOffset, copy.byteLength).setUint32(offset, value, true);
  return copy;
}

/** 在末尾追加垃圾字节（EOCD 不再收尾）。 */
export function appendTail(bytes: Uint8Array, extra: number): Uint8Array {
  if (extra <= 0) throw new Error('追加长度必须为正');
  const out = new Uint8Array(bytes.byteLength + extra);
  out.set(bytes, 0);
  out.fill(0x5a, bytes.byteLength);
  return out;
}

/** 找到某条目数据区的绝对起止偏移。 */
function dataRangeOf(bytes: Uint8Array, path: string): { readonly start: number; readonly end: number } {
  const { archive } = inspectZip(bytes);
  if (archive === null) throw new Error('夹具：输入不是可扫描的 ZIP');
  const entry = archive.by_path.get(path);
  if (entry === undefined) throw new Error(`夹具：找不到条目 ${path}`);
  const start = entry.local_header_offset;
  // 本地头 30 + 名长 + extra 长 = 数据起点；用重算 CRC 的字节长度反推数据长度（全 STORE）。
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameLength = view.getUint16(start + 26, true);
  const extraLength = view.getUint16(start + 28, true);
  const dataStart = start + 30 + nameLength + extraLength;
  return { start: dataStart, end: dataStart + entry.compressed_size };
}

/** 翻转某条目数据区内的第 `index` 个字节（第 0 个往往落在 XML 声明里）。 */
export function flipEntryDataByte(bytes: Uint8Array, path: string, index: number): Uint8Array {
  const range = dataRangeOf(bytes, path);
  if (index < 0 || index >= range.end - range.start) throw new Error(`条目数据索引越界：${String(index)}`);
  return flipByteAt(bytes, range.start + index);
}

/** 所有条目的 `{path, data}`（按当前字节序）。 */
function entriesOf(bytes: Uint8Array): ZipEntry[] {
  const { archive } = inspectZip(bytes);
  if (archive === null) throw new Error('夹具：输入不是可扫描的 ZIP');
  return archive.entries.map((entry) => ({ path: entry.path, data: Uint8Array.from(entry.data) }));
}

function rebuild(entries: readonly ZipEntry[]): Uint8Array {
  // writeZip 返回 Buffer；转成普通 Uint8Array，避免 Buffer/Uint8Array 的比较差异。
  return Uint8Array.from(writeZip(entries));
}

/** 去掉一个条目后重建包（ZIP 合法，但其关系可能悬挂）。 */
export function dropEntry(bytes: Uint8Array, path: string): Uint8Array {
  const kept = entriesOf(bytes).filter((entry) => entry.path !== path);
  if (kept.length === entriesOf(bytes).length) throw new Error(`夹具：要删的条目不存在 ${path}`);
  return rebuild(kept);
}

/**
 * 把某条目内的文本片段替换后重建包。
 * 用于"把 `Target="../media/image1.png"` 改成指向一个不存在的部件"——结构合法、关系悬挂。
 */
export function replaceEntryText(bytes: Uint8Array, path: string, from: string, to: string): Uint8Array {
  let replaced = false;
  const next = entriesOf(bytes).map((entry) => {
    if (entry.path !== path) return entry;
    const text = Buffer.from(entry.data).toString('utf8');
    if (!text.includes(from)) throw new Error(`夹具：${path} 内找不到片段 ${JSON.stringify(from)}`);
    replaced = true;
    return { path: entry.path, data: new Uint8Array(Buffer.from(text.split(from).join(to), 'utf8')) };
  });
  if (!replaced) throw new Error(`夹具：未替换任何内容（${path}）`);
  return rebuild(next);
}

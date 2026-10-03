/**
 * 工作包 **FA-PPT-MEDIA-PRODUCT** —— PPT 音视频 / 媒体与形状 / 表格 / 图表（PPT-06 / 07 / 08 / 09 / 12）
 * 的端到端复算。
 *
 * ## 一、这条用例跑在**什么**上（必读，别把它当成产品入口）
 *
 * 产品 HTTP 面（`apps/demo/server/http.ts` → `main.js`）对 PPT 只有两条路：
 * `/api/deliverables`（pptx，**封闭枚举**只有 `add_slide / set_slide_title / remove_slide /
 * set_slide_notes` 四个 op，且 `fileBase64` 在 `DeliverableHost.open()` 里**没被消费**）与
 * `/api/ppt-facts/**`（同版事实 + 表格）。因此 **PPT-06（图片）/ 07（形状）/ 12（音视频）**
 * 在产品面上**没有编辑入口**，08（表格）/ 09（图表）只在 `/api/ppt-facts` 下够得着。
 *
 * 本工作包（FA-PPT-MEDIA-PRODUCT）原先把 PPT-06..12 架在一条**新增的 harness**
 * `./ppt-media-harness.js`（`/api/ppt-media/**`，与 `ppt-facts-product.ts` 同一套契约形状）上，
 * 因为当时不许改 `http.ts`；后续工作包 **FA-PPT-MEDIA-MOUNT** 只在 `http.ts` 加了一行前缀转交，
 * 把它挂进产品宿主（`main.ts` 无端口可注入，故只登记前缀）。本文件用**真 `node:http`**
 * 把它 listen 起来，逐步取状态码。
 *
 * 结论里必须**分开写**（本文件的 describe 分组即按此划分）：
 * - **产品入口**（`createDemoServer`，真落盘内核）：`/api/ppt-facts` 的表格交付与图表同版改写；
 * - **HTTP harness**（真实 HTTP）：图片 / 形状 / 表格 / 图表 / 音视频操作。工作包 **FA-PPT-MEDIA-MOUNT**
 *   已把它挂进产品宿主 `http.ts`（`/api/ppt-media/**`，在 `/api/**` 兜底 404 之前按前缀转交）——
 *   因此这些操作在 `main.js` 产品面上**够得着**（不再是 404）；
 * - **仍需真机播放验证**：音视频播放、第三方软件打开——一律未验证（无消费端）。
 *
 * ## 二、读回判据**自带**（不 import `src` 的任何 verify* / readZip 实现）
 *
 * `verifyMediaPairingInPackage` / `verifyChartPackage` / `assertNoFullPageBitmap` 是**被测对象那一侧**
 * 的判据；拿它们证明"成对 / 一致"，就是**自我复述**。所以本文件从零写了：
 * 最小 ZIP 读取器（EOCD → 中央目录 → 逐条本地头 → deflate 真解压）、最小 ZIP **写**器
 * （stored + 自算 CRC32，供反向对照篡改字节）、以及三个独立判据：
 *
 * 1. `pairMedia(pptx)` —— 每页 `r:embed` ↔ 该页 `_rels` ↔ 包内真实 `ppt/media/**` 部件，
 *    三个方向都查（有 rId 没关系 / 有关系没部件 / 有部件没 rId）；
 * 2. `compareChart(pptx)` —— `c:f` 指向的**嵌入工作簿**单元格，与 `c:ser` 里的 `c:v` 缓存
 *    **逐点**比（工作簿是嵌套 ZIP，本文件自己再解一层）；
 * 3. `fullPageBitmaps(slideXml, size)` —— 页里是否存在与页面同尺寸的 `p:pic`。
 *
 * `src` 的 `readZip/writeZip`（`../artifacts/ooxml`）**只**用来做篡改夹具，不参与任何断言。
 *
 * ## 三、反向对照（每条正向都配一条"看起来通过"的必须被抓）
 *
 * | 正向 | 反向对照 |
 * |---|---|
 * | 图片插入 / 替换 / 删除后媒体部件与 rId 成对 | **抽掉媒体部件** ⇒ 本文件判据与 `POST /verify` 都报 `unpaired_media_relationship` |
 * | 形状 / 流程导出成 `p:sp` + `p:cxnSp`（可编辑），页内**没有**整页位图 | **整页截图页 XML** ⇒ `POST /verify` 报 `page_screenshot_detected`，独立判据同样报 |
 * | 图表缓存与嵌入工作簿逐点一致 | **偷改图表缓存** ⇒ 独立判据报不一致，`POST /verify` 报 `chart_data_desync` |
 * | 图表 `c:externalData` 成对 | **抽掉嵌入工作簿** ⇒ `POST /verify` 报 `chart_part_unpaired` |
 * | 声明嵌入 + 真有部件 ⇒ `embedded:true` | **只有链接** ⇒ `embedded:false`；**声明嵌入却无部件** ⇒ `false_embed_claims` 非空 |
 *
 * ## 四、⚠️ 如实标注（结果不得编造）
 *
 * - **真机 / 消费端播放未验证**：音视频能不能播、第三方软件打开有没有修复提示，本文件**没有**验证过；
 *   随每个 harness 响应原样带出 `unverified` 清单。
 * - **harness 已挂进产品宿主**（FA-PPT-MEDIA-MOUNT）：`/api/ppt-media/**` 在 `main.js` 上由本模块
 *   作答（`/status` 的 `mounted_in_product_host:true`）——本文件把它**断言**成已经发生的事实
 *   （见"产品入口可达性"一节，改前该前缀是 404）。
 * - 本套件只跑本文件（不跑全量套件、不调真实模型）。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { afterAll, describe, expect, it } from 'vitest';

import {
  PPT_MEDIA_EXPLICIT_REFUSALS,
  PPT_MEDIA_ROOT,
  PPT_MEDIA_ROUTES,
  PPT_MEDIA_UNVERIFIED,
  handlePptxMediaRequest,
  routePptxMediaRequest,
} from './ppt-media-harness.js';
import { getBytes, getJson, postJson, startProduct, type Json, type RunningProduct } from './e2e-product-harness.js';

// ===========================================================================
// 一、自带的最小 ZIP 读取器（不 import src 的任何读部件实现）
// ===========================================================================

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressed_size: number;
  readonly local_header_offset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function u16(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset);
}

function u32(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset);
}

function findEocd(buf: Buffer): number {
  const earliest = Math.max(0, buf.length - 22 - 65535);
  for (let offset = buf.length - 22; offset >= earliest; offset -= 1) {
    if (u32(buf, offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('ZIP 里找不到 EOCD：这不是一个 ZIP 容器');
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function listZip(bytes: Uint8Array): readonly ZipEntry[] {
  const buf = asBuffer(bytes);
  const eocd = findEocd(buf);
  const total = u16(buf, eocd + 10);
  let cursor = u32(buf, eocd + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < total; index += 1) {
    if (u32(buf, cursor) !== CENTRAL_SIGNATURE) {
      throw new Error(`第 ${String(index + 1)} 条中央目录项签名不对（偏移 ${String(cursor)}）`);
    }
    const method = u16(buf, cursor + 10);
    const compressedSize = u32(buf, cursor + 20);
    const nameLength = u16(buf, cursor + 28);
    const extraLength = u16(buf, cursor + 30);
    const commentLength = u16(buf, cursor + 32);
    const localOffset = u32(buf, cursor + 42);
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (u32(buf, localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`部件 ${name} 的本地文件头签名不对`);
    }
    entries.push({ name, method, compressed_size: compressedSize, local_header_offset: localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return Object.freeze(entries);
}

function readEntry(bytes: Uint8Array, entry: ZipEntry): Buffer {
  const buf = asBuffer(bytes);
  const nameLength = u16(buf, entry.local_header_offset + 26);
  const extraLength = u16(buf, entry.local_header_offset + 28);
  const dataStart = entry.local_header_offset + 30 + nameLength + extraLength;
  const raw = buf.subarray(dataStart, dataStart + entry.compressed_size);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`部件 ${entry.name} 用了未预期的压缩方法 ${String(entry.method)}`);
}

function entryOf(bytes: Uint8Array, name: string): ZipEntry | undefined {
  return listZip(bytes).find((entry) => entry.name === name);
}

function readPart(bytes: Uint8Array, name: string): Buffer {
  const entry = entryOf(bytes, name);
  if (entry === undefined) throw new Error(`包内没有部件 ${name}`);
  return readEntry(bytes, entry);
}

function textOf(bytes: Uint8Array, name: string): string {
  return readPart(bytes, name).toString('utf8');
}

// ===========================================================================
// 二、自带的最小 ZIP 写器（stored + 自算 CRC32；只用于反向对照篡改）
// ===========================================================================

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function writeStoredZip(entries: readonly { readonly name: string; readonly data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, entry.data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + entry.data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDir, eocd]);
}

/** 把包里某个部件换掉（其余逐字节保留）。 */
function replacePart(pptx: Uint8Array, name: string, data: Buffer): Buffer {
  const entries = listZip(pptx).map((entry) => ({ name: entry.name, data: readEntry(pptx, entry) }));
  return writeStoredZip(entries.map((entry) => (entry.name === name ? { name, data } : entry)));
}

/** 把包里某个部件**抽掉**（其余逐字节保留）。 */
function stripPart(pptx: Uint8Array, name: string): Buffer {
  const entries = listZip(pptx).map((entry) => ({ name: entry.name, data: readEntry(pptx, entry) }));
  return writeStoredZip(entries.filter((entry) => entry.name !== name));
}

// ===========================================================================
// 三、独立的三个判据（不 import src 的 verify*）
// ===========================================================================

function xmlInner(haystack: string, tag: string): readonly string[] {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found: string[] = [];
  const pattern = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, 'g');
  let match = pattern.exec(haystack);
  while (match !== null) {
    found.push(match[1] ?? '');
    match = pattern.exec(haystack);
  }
  return found;
}

/** `ppt/slides/slide1.xml` → `ppt/slides/_rels/slide1.xml.rels`。 */
function relsPathOf(partPath: string): string {
  const slash = partPath.lastIndexOf('/');
  const dir = slash < 0 ? '' : partPath.slice(0, slash);
  const base = partPath.slice(slash + 1);
  return dir === '' ? `_rels/${base}.rels` : `${dir}/_rels/${base}.rels`;
}

/** `ppt/slides/../media/x.png` → `ppt/media/x.png`。 */
function resolveTarget(ownerPart: string, target: string): string {
  const slash = ownerPart.lastIndexOf('/');
  const combined = target.startsWith('/') ? target.slice(1) : `${slash < 0 ? '' : ownerPart.slice(0, slash + 1)}${target}`;
  const stack: string[] = [];
  for (const segment of combined.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') stack.pop();
    else stack.push(segment);
  }
  return stack.join('/');
}

interface MediaPairing {
  readonly references: readonly { readonly slide_part: string; readonly rel_id: string; readonly media_path: string }[];
  readonly media_parts: readonly string[];
  readonly problems: readonly string[];
}

/** **独立**媒体成对判据：有 rId 没关系 / 有关系没部件 / 有部件没 rId，三个方向都查。 */
function pairMedia(pptx: Uint8Array): MediaPairing {
  const names = listZip(pptx).map((entry) => entry.name);
  const mediaParts = names.filter((name) => name.startsWith('ppt/media/'));
  const references: { slide_part: string; rel_id: string; media_path: string }[] = [];
  const problems: string[] = [];
  const referenced = new Set<string>();

  for (const slidePart of names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))) {
    const relsName = relsPathOf(slidePart);
    const targets = new Map<string, string>();
    const relsEntry = entryOf(pptx, relsName);
    if (relsEntry !== undefined) {
      const rels = readEntry(pptx, relsEntry).toString('utf8');
      const relationshipPattern = /<Relationship\b([^>]*)\/?>/g;
      let match = relationshipPattern.exec(rels);
      while (match !== null) {
        const attrs = match[1] ?? '';
        const id = /Id="([^"]+)"/.exec(attrs)?.[1];
        const target = /Target="([^"]+)"/.exec(attrs)?.[1];
        const type = /Type="([^"]+)"/.exec(attrs)?.[1] ?? '';
        const external = /TargetMode="External"/.test(attrs);
        if (id !== undefined && target !== undefined && !external) {
          const resolved = resolveTarget(slidePart, target);
          if (type.endsWith('/image') && !names.includes(resolved)) {
            problems.push(`${relsName} 的关系 ${id} 指向 ${resolved}，但包内没有这份部件（有 rId 没部件）`);
          }
          targets.set(id, resolved);
        }
        match = relationshipPattern.exec(rels);
      }
    }
    const slide = textOf(pptx, slidePart);
    const embedPattern = /r:embed="([^"]+)"/g;
    let embed = embedPattern.exec(slide);
    while (embed !== null) {
      const relId = embed[1] ?? '';
      const resolved = targets.get(relId);
      if (resolved === undefined) {
        problems.push(`${slidePart} 引用了 ${relId}，但该页 _rels 里没有这条关系（有 rId 没关系）`);
      } else if (!names.includes(resolved)) {
        problems.push(`${slidePart} 的 ${relId} 指向 ${resolved}，但包内没有这份部件（有关系没部件）`);
      } else {
        references.push({ slide_part: slidePart, rel_id: relId, media_path: resolved });
        referenced.add(resolved);
      }
      embed = embedPattern.exec(slide);
    }
  }
  for (const part of mediaParts) {
    if (!referenced.has(part)) problems.push(`媒体部件 ${part} 没有任何 rId 引用（有部件没 rId）`);
  }
  return { references, media_parts: mediaParts, problems };
}

interface ChartComparison {
  readonly points: readonly { readonly series: number; readonly kind: 'cat' | 'val'; readonly index: number; readonly cache: string; readonly workbook: string }[];
  readonly mismatches: readonly string[];
  readonly problems: readonly string[];
}

/** 工作表 `A2`/`$B$2:$B$4` → 单元格引用列表。 */
function rangeRefs(formula: string): readonly string[] {
  const body = formula.includes('!') ? formula.slice(formula.indexOf('!') + 1) : formula;
  const clean = body.replace(/\$/g, '');
  if (!clean.includes(':')) return [clean];
  const [start, end] = clean.split(':');
  if (start === undefined || end === undefined) return [clean];
  const startMatch = /^([A-Z]+)(\d+)$/.exec(start);
  const endMatch = /^([A-Z]+)(\d+)$/.exec(end);
  if (startMatch === null || endMatch === null) return [clean];
  const columnIndex = (letters: string): number => letters.split('').reduce((sum, ch) => sum * 26 + (ch.charCodeAt(0) - 64), 0);
  const from = columnIndex(startMatch[1] ?? 'A');
  const to = columnIndex(endMatch[1] ?? 'A');
  const fromRow = Number(startMatch[2]);
  const toRow = Number(endMatch[2]);
  const refs: string[] = [];
  const columnName = (index: number): string => {
    let value = index;
    let name = '';
    while (value > 0) {
      const remainder = (value - 1) % 26;
      name = String.fromCharCode(65 + remainder) + name;
      value = Math.floor((value - 1) / 26);
    }
    return name;
  };
  for (let column = from; column <= to; column += 1) {
    for (let row = fromRow; row <= toRow; row += 1) refs.push(`${columnName(column)}${String(row)}`);
  }
  return refs;
}

/** 嵌入工作簿 `sheet1.xml` → `A1` → 文本。 */
function workbookCells(workbook: Uint8Array): ReadonlyMap<string, string> {
  const sheet = readPart(workbook, 'xl/worksheets/sheet1.xml').toString('utf8');
  const map = new Map<string, string>();
  const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let match = cellPattern.exec(sheet);
  while (match !== null) {
    const attrs = match[1] ?? '';
    const inner = match[2] ?? '';
    const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
    if (ref !== undefined) {
      const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? '';
      map.set(ref, value);
    }
    match = cellPattern.exec(sheet);
  }
  return map;
}

/** **独立**图表一致性判据：`c:f` 指向的嵌入工作簿单元格 vs `c:ser` 里的 `c:v` 缓存，逐点比。 */
function compareChart(pptx: Uint8Array): ChartComparison {
  const problems: string[] = [];
  const points: { series: number; kind: 'cat' | 'val'; index: number; cache: string; workbook: string }[] = [];
  const mismatches: string[] = [];
  const chartName = listZip(pptx)
    .map((entry) => entry.name)
    .find((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
  if (chartName === undefined) {
    return { points, mismatches, problems: ['包内没有图表部件 ppt/charts/chartN.xml'] };
  }
  const chart = textOf(pptx, chartName);
  const external = /<c:externalData[^>]*r:id="([^"]+)"/.exec(chart)?.[1];
  if (external === undefined) problems.push('图表部件没有 c:externalData@r:id（数据不可编辑）');

  const chartRelsName = relsPathOf(chartName);
  let workbookName: string | undefined;
  const chartRels = entryOf(pptx, chartRelsName);
  if (chartRels === undefined) {
    problems.push(`图表部件没有 ${chartRelsName}`);
  } else {
    const rels = readEntry(pptx, chartRels).toString('utf8');
    const relationship = /<Relationship\b([^>]*)\/?>/.exec(rels)?.[1] ?? '';
    const target = /Target="([^"]+)"/.exec(relationship)?.[1];
    if (target === undefined) problems.push('图表 _rels 里没有目标');
    else {
      workbookName = resolveTarget(chartName, target);
      if (external !== undefined) {
        const relId = /Id="([^"]+)"/.exec(relationship)?.[1];
        if (relId !== external) problems.push(`c:externalData@r:id=${external} 与 _rels 里的 ${String(relId)} 不是同一条`);
      }
    }
  }
  const workbookEntry = workbookName === undefined ? undefined : entryOf(pptx, workbookName);
  if (workbookEntry === undefined) {
    problems.push(`嵌入工作簿 ${String(workbookName)} 不在包内（c:externalData 指向它，但部件缺失）`);
    return { points, mismatches, problems };
  }
  const workbook = readEntry(pptx, workbookEntry);

  const cells = workbookCells(workbook);
  const seriesBlocks = xmlInner(chart, 'c:ser');
  seriesBlocks.forEach((block, seriesIndex) => {
    for (const [kind, tag] of [['cat', 'c:cat'], ['val', 'c:val']] as const) {
      const holders = xmlInner(block, tag);
      if (holders.length === 0) continue;
      const holder = holders[0] ?? '';
      const formula = xmlInner(holder, 'c:f')[0];
      const caches = xmlInner(holder, 'c:v');
      if (formula === undefined) {
        problems.push(`第 ${String(seriesIndex)} 个系列的 ${tag} 没有 c:f`);
        continue;
      }
      const refs = rangeRefs(formula);
      if (refs.length !== caches.length) {
        problems.push(`第 ${String(seriesIndex)} 个系列的 ${tag}：c:f 覆盖 ${String(refs.length)} 格，缓存 ${String(caches.length)} 点`);
      }
      caches.forEach((cache, index) => {
        const ref = refs[index];
        const workbookValue = ref === undefined ? undefined : cells.get(ref);
        if (ref === undefined || workbookValue === undefined) {
          problems.push(`第 ${String(seriesIndex)} 个系列的 ${tag}[${String(index)}]：c:f 的 ${String(ref)} 在工作簿里没有值`);
          return;
        }
        points.push({ series: seriesIndex, kind, index, cache, workbook: workbookValue });
        if (cache !== workbookValue) {
          mismatches.push(`第 ${String(seriesIndex)} 个系列 ${tag}[${String(index)}]：缓存 ${cache} ≠ 工作簿 ${ref}=${workbookValue}`);
        }
      });
    }
  });
  return { points, mismatches, problems };
}

/** **独立**整页截图判据：页里有没有与页面同尺寸的 `p:pic`。 */
function fullPageBitmaps(slideXml: string, size: { readonly cx_emu: number; readonly cy_emu: number }): readonly string[] {
  const found: string[] = [];
  for (const picture of xmlInner(slideXml, 'p:pic')) {
    for (const match of picture.matchAll(/<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/g)) {
      if (match[1] === String(size.cx_emu) && match[2] === String(size.cy_emu)) {
        found.push(`p:pic 的 a:ext=${match[1]}×${match[2]} 与页面同尺寸`);
      }
    }
  }
  return found;
}

// ===========================================================================
// 四、夹具与 HTTP 小工具
// ===========================================================================

const PNG_ONE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_TWO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
const PNG_THREE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
const MP4_BYTES = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]);

const PAGE_SIZE = Object.freeze({ cx_emu: 9144000, cy_emu: 6858000 });
const PAGE4 = { id: 'deck-ppt-media', title: '媒体/形状/表格/图表', slides: 2 };
const PAGE1DECK = { id: 'deck-ppt-media', title: '媒体/形状/表格/图表', slides: 1 };

function b64(bytes: Buffer): string {
  return bytes.toString('base64');
}

function rec(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('期望 JSON 对象');
  return value as Record<string, unknown>;
}

function num(value: unknown): number {
  return Number(value);
}

/** PPTX 视图（harness 返回的 `pptx` 字段）取回原始字节。 */
function pptxBytes(view: unknown): Buffer {
  const record = rec(view);
  const base64 = record['base64'];
  if (typeof base64 !== 'string') throw new Error('pptx.base64 不是字符串');
  const bytes = Buffer.from(base64, 'base64');
  expect(bytes.byteLength).toBe(num(record['byte_length']));
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
  return bytes;
}

/** 真 `node:http` 上的 `/api/ppt-media/**`（harness 独立起服务；产品宿主已挂载，见"产品入口可达性"一节）。 */
let harness: Server | undefined;
let harnessBase = '';
let harnessStarted = false;

async function ensureHarness(): Promise<string> {
  if (!harnessStarted) {
    const server = createServer((req, res) => {
      void (async (): Promise<void> => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (await handlePptxMediaRequest({ req, res, url })) return;
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"code":"not_found"}');
      })();
    });
    harness = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('harness 没有拿到端口');
    harnessBase = `http://127.0.0.1:${String(address.port)}`;
    harnessStarted = true;
  }
  return harnessBase;
}

async function harnessPost(path: string, body: unknown): Promise<{ readonly status: number; readonly json: Json }> {
  const origin = await ensureHarness();
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Json };
}

// ===========================================================================
// 五、分组
// ===========================================================================

describe('harness 的 HTTP 契约（真 node:http）', () => {
  it('GET /status ⇒ 200：路由清单 / 明确拒绝项 / 未验证清单 / **已挂载**如实登记', async () => {
    const origin = await ensureHarness();
    const response = await fetch(`${origin}${PPT_MEDIA_ROOT}/status`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = rec(await response.json());
    expect(body['ok']).toBe(true);
    expect(body['routes']).toEqual([...PPT_MEDIA_ROUTES]);
    expect(body['explicit_refusals']).toEqual([...PPT_MEDIA_EXPLICIT_REFUSALS]);
    expect(body['unverified']).toEqual([...PPT_MEDIA_UNVERIFIED]);
    // **如实反映已挂进产品宿主**（FA-PPT-MEDIA-MOUNT）：这一栏为 true，且带一句说明。
    expect(body['mounted_in_product_host']).toBe(true);
    expect(String(body['mount_note'])).toContain('http.ts');
  });

  it('GET 到 POST-only 端点 ⇒ 405；未知子路径 ⇒ 404；非本前缀 ⇒ 本模块不接管', async () => {
    const origin = await ensureHarness();
    expect((await fetch(`${origin}${PPT_MEDIA_ROOT}/pictures`)).status).toBe(405);
    expect(routePptxMediaRequest({ method: 'POST', pathname: `${PPT_MEDIA_ROOT}/nope`, body: {} }).status).toBe(404);
    expect((await fetch(`${origin}/api/health`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PPT-06：图片插入 / 替换 / 删除，媒体部件与 rId 成对
// ---------------------------------------------------------------------------

describe('PPT-06 图片：插入 / 替换 / 删除，媒体部件与 rId 成对（独立 ZIP 判据）', () => {
  it('三步 ops 全部 200；产物里**恰好一份**媒体部件，且每个 r:embed 都有关系指向它', async () => {
    const response = await harnessPost(`${PPT_MEDIA_ROOT}/pictures`, {
      deck: PAGE4,
      parts: [
        { path: 'ppt/media/image1.png', base64: b64(PNG_ONE) },
        { path: 'ppt/media/image2.png', base64: b64(PNG_TWO) },
      ],
      ops: [
        { op: 'insert', slide_id: 1, media_path: 'ppt/media/image1.png', transform: { x: 1000000, y: 500000, cx: 3000000, cy: 2000000 }, alt_text: '示意图' },
        { op: 'insert', slide_id: 2, media_path: 'ppt/media/image2.png', transform: { x: 200000, y: 200000, cx: 2000000, cy: 1500000 } },
        // 替换成第三张（字节随请求带上）⇒ 旧路径成孤儿并被清理。
        { op: 'replace', slide_id: 1, shape_id: 2, media_path: 'ppt/media/image3.png', base64: b64(PNG_THREE), alt_text: '换过的图' },
        { op: 'delete', slide_id: 2, shape_id: 2 },
      ],
    });
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    const body = response.json;
    expect(body['ok']).toBe(true);
    expect((body['steps'] as readonly { op: string; ok: boolean }[]).map((step) => `${step.op}:${String(step.ok)}`)).toEqual([
      'insert:true',
      'insert:true',
      'replace:true',
      'delete:true',
    ]);

    const bytes = pptxBytes(body['pptx']);
    const media = rec(body['media']);
    expect(num(media['media_part_count'])).toBe(1);

    // --- 独立读回（不 import src 的任何 verify*）---
    const pairing = pairMedia(bytes);
    expect(pairing.problems).toEqual([]);
    expect(pairing.media_parts).toEqual(['ppt/media/image3.png']);
    expect(pairing.references).toHaveLength(1);
    expect(pairing.references[0]?.slide_part).toBe('ppt/slides/slide1.xml');
    // rId 与 _rels 的关系**对得上**：把关系目标解出来应指向那份部件。
    const slide1 = textOf(bytes, 'ppt/slides/slide1.xml');
    const relId = pairing.references[0]?.rel_id ?? '';
    expect(slide1).toContain(`r:embed="${relId}"`);
    const rels = textOf(bytes, 'ppt/slides/_rels/slide1.xml.rels');
    expect(rels).toContain('Target="../media/image3.png"');
    // 第 2 页的图被删了：该页不得留下图片关系。
    expect(textOf(bytes, 'ppt/slides/_rels/slide2.xml.rels')).not.toContain('/image');
  });

  it('反向对照：抽掉媒体部件 ⇒ 独立判据与 POST /verify 都报 unpaired_media_relationship', async () => {
    const good = await harnessPost(`${PPT_MEDIA_ROOT}/pictures`, {
      deck: PAGE1DECK,
      parts: [{ path: 'ppt/media/image1.png', base64: b64(PNG_ONE) }],
      ops: [{ op: 'insert', slide_id: 1, media_path: 'ppt/media/image1.png', transform: { x: 0, y: 0, cx: 1000000, cy: 1000000 } }],
    });
    expect(good.status).toBe(200);
    const bytes = pptxBytes(good.json['pptx']);
    expect(pairMedia(bytes).problems).toEqual([]);

    const stripped = stripPart(bytes, 'ppt/media/image1.png');
    // 独立判据：rId 还在、部件没了 ⇒ 抓到。
    const problems = pairMedia(stripped).problems;
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('|')).toContain('有 rId 没部件');

    // 走 HTTP 的读回校验：422 且具名。
    const verified = await harnessPost(`${PPT_MEDIA_ROOT}/verify`, { kind: 'media', pptx_base64: stripped.toString('base64') });
    expect(verified.status).toBe(422);
    expect(verified.json['reason']).toBe('unpaired_media_relationship');
    expect(verified.json['bytes_emitted']).toBe(0);
    // 未篡改的原件仍然通过（证明报错来自那处篡改，不是"永远报错"）。
    const original = await harnessPost(`${PPT_MEDIA_ROOT}/verify`, { kind: 'media', pptx_base64: bytes.toString('base64') });
    expect(original.status).toBe(200);
    expect(rec(original.json['report'])['media_part_paths']).toEqual(['ppt/media/image1.png']);
  });
});

// ---------------------------------------------------------------------------
// PPT-07：形状 / 流程仍是可编辑对象
// ---------------------------------------------------------------------------

describe('PPT-07 形状/流程：仍是可编辑对象（页内没有整页位图）', () => {
  it('3 盒 + 2 连线 + 1 自选图形：导出成 p:sp / p:cxnSp，一个 p:pic 都没有', async () => {
    const response = await harnessPost(`${PPT_MEDIA_ROOT}/shapes`, {
      deck: PAGE1DECK,
      flow: { texts: ['收集', '处理', '交付'] },
      ops: [
        { op: 'add_auto_shape', preset: 'ellipse', text: '备注', transform: { x: 100000, y: 4000000, cx: 1500000, cy: 800000 } },
      ],
    });
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    const bytes = pptxBytes(response.json['pptx']);
    const slide = textOf(bytes, 'ppt/slides/slide1.xml');

    const count = (needle: string): number => slide.split(needle).length - 1;
    expect(count('<p:sp>')).toBe(4);
    expect(count('<p:cxnSp>')).toBe(2);
    expect(slide).not.toContain('<p:pic>');
    expect(slide).toContain('<a:t>收集</a:t>');
    expect(slide).toContain('<a:t>备注</a:t>');

    // **独立**整页位图判据：模型侧说没有，字节侧再核一遍。
    expect(fullPageBitmaps(slide, PAGE_SIZE)).toEqual([]);
    const inventory = rec(response.json)['inventory'];
    expect(inventory).toBeDefined();
    const first = rec((inventory as readonly unknown[])[0]);
    expect(first['by_kind']).toEqual({ auto_shape: 4, connector: 2 });

    // HTTP 读回校验也对同一页给 200。
    const verified = await harnessPost(`${PPT_MEDIA_ROOT}/verify`, { kind: 'slide_bitmap', slide_xml: slide, size: PAGE_SIZE });
    expect(verified.status).toBe(200);
    expect(verified.json['page_screenshot']).toBe(false);
  });

  it('反向对照：整页截图的页 XML ⇒ POST /verify 与独立判据都抓到 page_screenshot_detected', async () => {
    const screenshot = [
      '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
      ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">',
      '<p:cSld><p:spTree>',
      '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>',
      '<p:pic><p:nvPicPr><p:cNvPr id="2" name="整页截图"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>',
      '<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>',
      '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9144000" cy="6858000"/></a:xfrm>',
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>',
      '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>',
    ].join('');

    expect(fullPageBitmaps(screenshot, PAGE_SIZE).length).toBeGreaterThan(0);

    const verified = await harnessPost(`${PPT_MEDIA_ROOT}/verify`, {
      kind: 'slide_bitmap',
      slide_xml: screenshot,
      size: PAGE_SIZE,
    });
    expect(verified.status).toBe(422);
    expect(verified.json['reason']).toBe('page_screenshot_detected');
  });
});

// ---------------------------------------------------------------------------
// PPT-08：表格增删行列 / 合并 / 改格
// ---------------------------------------------------------------------------

describe('PPT-08 表格：建表 / 改格 / 插行 / 合并，结构可读回', () => {
  it('3×3 + set_cell_text + insert_row + merge ⇒ 4 行、合并落到 gridSpan/hMerge', async () => {
    const response = await harnessPost(`${PPT_MEDIA_ROOT}/tables`, {
      deck: PAGE1DECK,
      table: {
        rows: 3,
        columns: 3,
        texts: [['季度', '收入', '支出'], ['Q1', '1', '2'], ['Q2', '3', '4']],
      },
      ops: [
        { op: 'set_cell_text', row: 0, col: 0, text: '财年' },
        { op: 'merge', row: 0, col: 1, row_span: 1, col_span: 2 },
        { op: 'insert_row', row: 1 },
      ],
    });
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    expect(response.json['ok']).toBe(true);
    const bytes = pptxBytes(response.json['pptx']);
    const slide = textOf(bytes, 'ppt/slides/slide1.xml');

    expect(slide).toContain('<a:tbl>');
    expect(slide.split('<a:tr').length - 1).toBe(4);
    expect(slide).toContain('<a:t>财年</a:t>');
    // 合并落成 gridSpan="2" + 一个 hMerge 延续格。
    expect(slide).toContain('gridSpan="2"');
    expect(slide).toContain('hMerge="1"');

    const table = rec(response.json['table']);
    const grid = table['grid'] as readonly (readonly string[])[];
    expect(grid).toHaveLength(4);
    expect(grid[0]?.[0]).toBe('财年');
    // 合并源格（row0,col1）保留自己的文本；右侧延续格是**空的**（不属于它的内容不得硬塞）。
    expect(grid[0]?.[1]).toBe('收入');
    expect(grid[0]?.[2]).toBe('');
  });

  it('反向对照：删到只剩一行的合并行 ⇒ 422（不静默拆掉合并）', async () => {
    const response = await harnessPost(`${PPT_MEDIA_ROOT}/tables`, {
      deck: PAGE1DECK,
      table: { rows: 2, columns: 2 },
      ops: [{ op: 'merge', row: 0, col: 0, row_span: 2, col_span: 1 }, { op: 'remove_row', row: 0 }],
    });
    expect(response.status).toBe(422);
    expect(response.json['code']).toBe('ppt_media_op_failed');
    expect(response.json['stage']).toBe('tables.ops[1]');
    expect(response.json['reason']).toBe('merge_conflict');
    expect(response.json['bytes_emitted']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PPT-09：图表嵌入数据与图形一致且可编辑
// ---------------------------------------------------------------------------

const CHART = {
  chart_type: 'bar',
  categories: ['一月', '二月', '三月'],
  series: [
    { name: '收入', values: [1.5, 2.25, 3] },
    { name: '支出', values: [0.5, 1.25, 2] },
  ],
  title: '季度对比',
};

describe('PPT-09 图表：c:f 指向的嵌入工作簿与缓存逐点一致', () => {
  it('插图表 + 改数据 ⇒ 图表部件与嵌入工作簿成对；独立判据逐点比对全部命中', async () => {
    const response = await harnessPost(`${PPT_MEDIA_ROOT}/charts`, {
      deck: PAGE1DECK,
      chart: CHART,
      ops: [{ op: 'set_data', categories: ['Q1', 'Q2'], series: [{ name: '净利', values: [10, 20] }] }],
    });
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    const bytes = pptxBytes(response.json['pptx']);

    const names = listZip(bytes).map((entry) => entry.name);
    expect(names).toContain('ppt/charts/chart1.xml');
    expect(names).toContain('ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx');

    // 嵌入的是**真 XLSX**：本文件自己再解一层，能读出 workbook 与 sheet。
    const workbook = readPart(bytes, 'ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx');
    const inner = listZip(workbook).map((entry) => entry.name);
    expect(inner).toContain('xl/workbook.xml');
    expect(inner).toContain('xl/worksheets/sheet1.xml');

    const comparison = compareChart(bytes);
    expect(comparison.problems).toEqual([]);
    // 真比过点：类别 2 + 数值 2 ⇒ 4 个点（改数据后是 1 系列 × (2 类别 + 2 数值)）。
    expect(comparison.points).toHaveLength(4);
    expect(comparison.mismatches).toEqual([]);
    expect(comparison.points.map((point) => point.workbook)).toEqual(['Q1', 'Q2', '10', '20']);

    // 幻灯片引用图表部件（p:graphicFrame + c:chart@r:id）。
    const slide = textOf(bytes, 'ppt/slides/slide1.xml');
    expect(slide).toContain('p:graphicFrame');
    expect(slide).toContain('<c:chart r:id=');

    // HTTP 读回校验：通过。
    const verified = await harnessPost(`${PPT_MEDIA_ROOT}/verify`, { kind: 'chart', pptx_base64: bytes.toString('base64') });
    expect(verified.status).toBe(200);
    expect(num(rec(verified.json['report'])['series'])).toBe(1);
  });

  it('反向对照①：偷改图表缓存 ⇒ 独立判据报不一致，POST /verify 报 chart_data_desync', async () => {
    const response = await harnessPost(`${PPT_MEDIA_ROOT}/charts`, { deck: PAGE1DECK, chart: CHART });
    expect(response.status).toBe(200);
    const bytes = pptxBytes(response.json['pptx']);
    expect(compareChart(bytes).mismatches).toEqual([]);

    const chartXml = textOf(bytes, 'ppt/charts/chart1.xml');
    expect(chartXml).toContain('<c:v>1.5</c:v>');
    const tampered = replacePart(bytes, 'ppt/charts/chart1.xml', Buffer.from(chartXml.replace('<c:v>1.5</c:v>', '<c:v>7.5</c:v>'), 'utf8'));

    const comparison = compareChart(tampered);
    expect(comparison.mismatches.length).toBeGreaterThan(0);
    expect(comparison.mismatches.join('|')).toContain('7.5');

    const verified = await harnessPost(`${PPT_MEDIA_ROOT}/verify`, { kind: 'chart', pptx_base64: tampered.toString('base64') });
    expect(verified.status).toBe(422);
    expect(verified.json['reason']).toBe('chart_data_desync');
  });

  it('反向对照②：抽掉嵌入工作簿（c:externalData 还在）⇒ POST /verify 报 chart_part_unpaired', async () => {
    const response = await harnessPost(`${PPT_MEDIA_ROOT}/charts`, { deck: PAGE1DECK, chart: CHART });
    expect(response.status).toBe(200);
    const bytes = pptxBytes(response.json['pptx']);
    const stripped = stripPart(bytes, 'ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx');

    expect(compareChart(stripped).problems.join('|')).toContain('不在包内');

    const verified = await harnessPost(`${PPT_MEDIA_ROOT}/verify`, { kind: 'chart', pptx_base64: stripped.toString('base64') });
    expect(verified.status).toBe(422);
    expect(verified.json['reason']).toBe('chart_part_unpaired');
  });
});

// ---------------------------------------------------------------------------
// PPT-12：音视频受控引用（不假称已嵌入 / 权限与失效有明确结果）
// ---------------------------------------------------------------------------

describe('PPT-12 音视频：不假称已嵌入；权限与链接失效都有明确结果', () => {
  it('声明嵌入 + 真有部件 ⇒ embedded:true；只有链接 ⇒ embedded:false 且可达性未验证', async () => {
    const response = await harnessPost(`${PPT_MEDIA_ROOT}/av`, {
      items: [
        { media_id: 'm-embed', media_path: 'ppt/media/clip1.mp4', base64: b64(MP4_BYTES), slide_id: 1, shape_id: 10 },
        { media_id: 'm-link', media_path: 'https://example.com/clip.mp4', external: true, slide_id: 1, shape_id: 11 },
      ],
    });
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    const audit = rec(response.json['audit']);
    const resolutions = audit['resolutions'] as readonly Record<string, unknown>[];
    const byId = new Map(resolutions.map((entry) => [String(entry['media_id']), entry]));

    expect(byId.get('m-embed')?.['embedded']).toBe(true);
    expect(byId.get('m-embed')?.['link_status']).toBe('embedded');
    // **只有链接 ⇒ embedded 恒为 false**，且"地址看着对"不得说成"链接有效"。
    expect(byId.get('m-link')?.['embedded']).toBe(false);
    expect(byId.get('m-link')?.['link_status']).toBe('linked');
    expect(byId.get('m-link')?.['link_liveness_verified']).toBe(false);

    expect(audit['false_embed_claims']).toEqual([]);
    // 本层**不渲染**音视频：响应必须如实说"不产出 PPTX"。
    expect(response.json['render_supported']).toBe(false);
    expect(String(response.json['render_refusal'])).toContain('unsupported_shape_kind');
  });

  it('反向对照①：声明嵌入却没有部件 ⇒ 落在 false_embed_claims（不假称已嵌入）', async () => {
    const response = await harnessPost(`${PPT_MEDIA_ROOT}/av`, {
      items: [{ media_id: 'm-ghost', media_path: 'ppt/media/ghost.mp4', declared: 'embedded', slide_id: 1, shape_id: 12 }],
    });
    expect(response.status).toBe(200);
    const audit = rec(response.json['audit']);
    expect(audit['false_embed_claims']).toEqual(['m-ghost']);
    const resolution = rec((audit['resolutions'] as readonly unknown[])[0]);
    expect(resolution['declared']).toBe('embedded');
    expect(resolution['embedded']).toBe(false);
    expect(resolution['link_status']).toBe('broken');
    expect(String(rec(resolution['problem'])['reason'])).toBe('missing_media_part');
  });

  it('反向对照②：媒体权限不足 ⇒ 409 具名拒绝，不静默降级成另一种处理', async () => {
    const deniedEmbed = await harnessPost(`${PPT_MEDIA_ROOT}/av`, {
      permissions: { allow_embed: false, allow_link: true, allow_autoplay: true },
      items: [{ media_id: 'm1', media_path: 'ppt/media/clip1.mp4', base64: b64(MP4_BYTES) }],
    });
    expect(deniedEmbed.status).toBe(409);
    expect(deniedEmbed.json['code']).toBe('av_permission_denied');
    expect(deniedEmbed.json['reason']).toBe('embed_not_permitted');

    const deniedLink = await harnessPost(`${PPT_MEDIA_ROOT}/av`, {
      permissions: { allow_embed: true, allow_link: false, allow_autoplay: true },
      items: [{ media_id: 'm2', media_path: 'https://example.com/clip.mp4', external: true }],
    });
    expect(deniedLink.status).toBe(409);
    expect(deniedLink.json['reason']).toBe('link_not_permitted');
  });

  it('链接失效有明确结果：空目标 / 包内路径指向不存在的部件 ⇒ broken，且带具名原因', async () => {
    const empty = await harnessPost(`${PPT_MEDIA_ROOT}/av`, {
      items: [{ media_id: 'm-empty', media_path: '', external: true }],
    });
    expect(empty.status).toBe(200);
    const emptyResolution = rec((rec(empty.json['audit'])['resolutions'] as readonly unknown[])[0]);
    expect(emptyResolution['link_status']).toBe('broken');
    expect(String(rec(emptyResolution['problem'])['reason'])).toBe('external_target_required');

    const missing = await harnessPost(`${PPT_MEDIA_ROOT}/av`, {
      items: [{ media_id: 'm-missing', media_path: 'ppt/media/nope.mp3', declared: 'linked' }],
    });
    expect(missing.status).toBe(200);
    const missingResolution = rec((rec(missing.json['audit'])['resolutions'] as readonly unknown[])[0]);
    expect(missingResolution['link_status']).toBe('broken');
    expect(String(rec(missingResolution['problem'])['reason'])).toBe('missing_media_part');
  });
});

// ---------------------------------------------------------------------------
// 产品入口可达性：真产品服务（createDemoServer，真落盘内核）
// ---------------------------------------------------------------------------

let productDir = '';
let product: RunningProduct | undefined;

function productOf(): RunningProduct {
  if (product === undefined) throw new Error('产品服务还没起来（前一节失败了）');
  return product;
}

describe('产品入口可达性：/api/ppt-facts 够得着表格与图表；/api/ppt-media 已挂载', () => {
  it('起真产品服务（createDemoServer），/health ⇒ 200', async () => {
    productDir = mkdtempSync(join(tmpdir(), 'potbot-ppt-media-'));
    product = await startProduct(join(productDir, 'run'));
    const health = await getJson(productOf().baseUrl, '/health');
    expect(health.status).toBe(200);
  }, 60_000);

  it('**产品入口**够得着 PPT-08 表格：/api/ppt-facts/deliver ⇒ 200，产物里有真表格', async () => {
    const facts = {
      target: {
        version: { task_id: 'task-ppt-media', task_revision: 2 },
        entries: [
          { fact_key: 'headcount', fact_ref: 'task-ppt-media-headcount-r2', value: { type: 'number', amount: 10, unit: '人', currency: null } },
        ],
      },
      history: [],
    };
    const template = {
      presentation_id: 'deck-ppt-facts-media',
      title: '季度经营汇报',
      slides: [
        { kind: 'literal', title: '封面', text: '2026 年第三季度' },
        { kind: 'fact_text', title: '本季人数', fact_key: 'headcount' },
        {
          kind: 'table',
          title: '人数明细',
          shape_id: 20,
          columns: [{ heading: '人数', fact_key: 'headcount' }],
        },
      ],
    };
    const delivered = await postJson(productOf().baseUrl, '/api/ppt-facts/deliver', { template, facts });
    expect(delivered.status, JSON.stringify(delivered.json)).toBe(200);
    const delivery = rec(delivered.json['delivery']);
    expect(delivery['status']).toBe('delivered');
    const editable = rec(delivery['editable_pptx']);
    expect(num(editable['slide_count'])).toBe(3);

    // **独立**读回：产品面产出的字节里确实有表格结构（不是"自报有表"）。
    const bytes = Buffer.from(String(editable['base64']), 'base64');
    const slide1 = textOf(bytes, 'ppt/slides/slide1.xml');
    const slide3 = textOf(bytes, 'ppt/slides/slide3.xml');
    expect(slide1).toContain('2026 年第三季度');
    expect(slide3).toContain('<a:tbl>');
    expect(slide3).toContain('<a:t>人数</a:t>');
    // 第 3 页是表格页（shape_id=20 的 p:graphicFrame），第 1 页不是。
    expect(slide3).toContain('p:graphicFrame');
    expect(slide1).not.toContain('p:graphicFrame');
  });

  it('**产品入口**够得着 PPT-09 图表数据同版改写：/api/ppt-facts/apply-facts ⇒ 200 且图表页被重写', async () => {
    const snapshot = (revision: number, headcount: number): Record<string, unknown> => ({
      version: { task_id: 'task-ppt-media', task_revision: revision },
      entries: [
        { fact_key: 'headcount', fact_ref: `task-ppt-media-headcount-r${String(revision)}`, value: { type: 'number', amount: headcount, unit: '人', currency: null } },
      ],
    });
    const template = {
      presentation_id: 'deck-ppt-facts-media',
      title: '季度经营汇报',
      slides: [
        { kind: 'literal', title: '封面', text: '2026 年第三季度' },
        { kind: 'fact_text', title: '本季人数', fact_key: 'headcount' },
        { kind: 'table', title: '人数明细', shape_id: 20, columns: [{ heading: '人数', fact_key: 'headcount' }] },
        {
          kind: 'chart',
          title: '人数趋势',
          shape_id: 30,
          chart_type: 'bar',
          categories: ['本季'],
          series: [{ name: '人数', fact_keys: ['headcount'] }],
        },
      ],
    };
    const applied = await postJson(productOf().baseUrl, '/api/ppt-facts/apply-facts', {
      template,
      from: snapshot(1, 8),
      to: snapshot(2, 10),
    });
    expect(applied.status, JSON.stringify(applied.json)).toBe(200);
    expect(applied.json['ok']).toBe(true);
    const audit = rec(applied.json['audit']);
    expect(audit['ok']).toBe(true);
    // 表格页（3）与图表页（4）确实被重写；封面（1）纹丝不动。
    expect(audit['rewritten_slide_ids']).toEqual([3, 4]);
    expect(audit['unrelated_slide_ids']).toEqual([1]);
  });

  it('**挂载后可达**：harness 前缀在真产品服务上是 200（改前是 404；FA-PPT-MEDIA-MOUNT 已挂进 http.ts）', async () => {
    const status = await getJson(productOf().baseUrl, `${PPT_MEDIA_ROOT}/status`);
    expect(status.status, JSON.stringify(status.json)).toBe(200);
    expect(status.json['ok']).toBe(true);
    // `/status` 如实登记已挂载（而不是"看着通了就默认挂了"）。
    expect(status.json['mounted_in_product_host']).toBe(true);
    // 对照组①：同一台服务上 /api/ppt-facts /status 也是通的。
    const pptFacts = await getJson(productOf().baseUrl, '/api/ppt-facts/status');
    expect(pptFacts.status).toBe(200);
    expect(pptFacts.json['ok']).toBe(true);
    // 对照组②（反向）：**未挂载**的兄弟前缀仍落 `/api/**` 兜底 404——
    // 证明"ppt-media 是 200"是因为真挂载，而不是兜底 404 被拆掉了（兜底没变）。
    const ghost = await getJson(productOf().baseUrl, '/api/ppt-media-ghost/status');
    expect(ghost.status).toBe(404);
    expect(ghost.json['code']).toBe('not_found');
  });

  it('产品入口的下载面**返回字节**（对照：交付会话链本身是通的）', async () => {
    const opened = await postJson(productOf().baseUrl, '/api/deliverables', {
      sessionId: 'ppt-media-deliverable',
      deliverableId: 'deck-1',
      filename: '演示.pptx',
      format: 'pptx',
    });
    expect(opened.status, JSON.stringify(opened.json)).toBe(201);
    const published = await postJson(productOf().baseUrl, '/api/deliverables/ppt-media-deliverable/edits', {
      idempotencyKey: 'k1',
      baseRevision: 0,
      baseDigest: String(opened.json['contentDigest']),
      edit: { op: 'add_slide', title: '第一页' },
    });
    expect(published.status, JSON.stringify(published.json)).toBe(200);
    const version = rec(published.json['version']);
    const downloaded = await getBytes(
      productOf().baseUrl,
      `/api/deliverables/ppt-media-deliverable/versions/${String(num(version['editRevision']))}/download`,
    );
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(downloaded.bytes).subarray(0, 2).toString('latin1')).toBe('PK');
    // 但这条链**够不着** PPT-06/07/12：适配器的封闭枚举里没有插图/形状/媒体的 op。
    const rejected = await postJson(productOf().baseUrl, '/api/deliverables/ppt-media-deliverable/edits', {
      idempotencyKey: 'k2',
      baseRevision: num(version['editRevision']),
      baseDigest: String(version['contentDigest']),
      edit: { op: 'insert_picture', slide_id: 1, media_path: 'ppt/media/a.png' },
    });
    expect(rejected.status).toBeGreaterThanOrEqual(400);
    // 封闭枚举**具名拒绝**：插入图片这个 op 在产品交付链上根本不存在。
    expect(rejected.json['code']).toBe('unsupported');
    expect(String(rejected.json['message'])).toContain('封闭枚举');
    expect(String(rejected.json['message'])).toContain('insert_picture');
  });
});

// ---------------------------------------------------------------------------
// 未验证（显式 skip：本机没有消费端）
// ---------------------------------------------------------------------------

describe('未验证：真机 / 消费端', () => {
  it.skip('音视频在安卓 / PowerPoint 上真的能播放：未验证（无消费端，且本层不产出含媒体的包）', () => {});
  it.skip('产物在第三方软件里打开无修复提示：未验证（无 PowerPoint / WPS / 安卓真机）', () => {});
});

// ===========================================================================
// 收尾
// ===========================================================================

afterAll(async () => {
  const server = harness;
  if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (product !== undefined) await product.close();
  if (productDir !== '') rmSync(productDir, { recursive: true, force: true });
});

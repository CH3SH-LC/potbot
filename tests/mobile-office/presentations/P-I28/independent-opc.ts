/**
 * P-I28 · **从零实现的 ZIP 容器 + OPC 关系图校验器**（不复用仓库任何生产解析器）。
 *
 * ## 为什么另写一份
 *
 * 生产侧写包走 `src/artifacts/ooxml/zip.ts`（`writeZip`），读包走 `zip-read.ts`（`readZip`），
 * 关系图在 `roundtrip.ts` / `slide-ops.ts` 内部各自解析。用生产读端去验生产写端是**同源自证**：
 * 共用 CRC 多项式、共用结构假设、共用 `xml-parse.ts`，一方错另一方跟着错。
 *
 * 本文件用**另一条技术路径**独立回答同一个问题，专门咬这类同源盲点：
 *
 * - CRC-32 用**逐位**算法（无查表、不 import `crc32.ts` 的多项式常量）；
 * - ZIP 结构用**手写游标**逐字段读，不 import `zip.ts` / `zip-read.ts` 的任何导出；
 * - `[Content_Types].xml` 与 `_rels` 用**自带的标签扫描**（正则级、不 import `xml-parse.ts`），
 *   相对目标用**自带**的路径求解。
 *
 * ## 本单元回答的三个问题（对应 P-R04 在 slide-ops 路径上的真实发现）
 *
 * 1. **每个部件恰好一个有效内容类型**——部件不得同时被「扩展名 Default」与「部件 Override」
 *    双重登记（`ppt/media/**` 的媒体双重登记就是 P-R04 报出的真实事实）；
 * 2. **每个内部关系目标都能落地**到真实存在的部件（悬挂关系检测）；
 * 3. **没有孤儿媒体部件**——`ppt/media/**` 下每个部件都至少被一条内部关系指向。
 *
 * 本模块**只读**：`validateOpcPackage` 从不抛异常，把所有问题收进结构化 `problems` 里返回，
 * 这样「损坏输入被检出」本身就是可断言的返回值。`writeStoredZip` 只是测试侧造**反向对照**用的
 * 最小重打包器（STORE、无压缩），同样从零实现。
 */

import { TextDecoder, TextEncoder } from 'node:util';

// ---------------------------------------------------------------------------
// 结果 schema
// ---------------------------------------------------------------------------

export interface ZipEntry {
  /** ZIP 内部路径（正斜杠分隔）。 */
  readonly path: string;
  readonly method: number;
  readonly flags: number;
  readonly recorded_crc: number;
  /** 本模块逐位重算的 CRC-32。 */
  readonly recomputed_crc: number;
  readonly compressed_size: number;
  readonly uncompressed_size: number;
  readonly local_header_offset: number;
  readonly data: Uint8Array;
}

export type ZipProblemKind =
  | 'eocd_missing'
  | 'bad_central_signature'
  | 'bad_local_signature'
  | 'name_length_out_of_range'
  | 'local_header_flags_mismatch'
  | 'local_header_method_mismatch'
  | 'unsupported_compression'
  | 'store_size_mismatch'
  | 'crc_mismatch'
  | 'duplicate_path'
  | 'truncated';

export interface ZipProblem {
  readonly kind: ZipProblemKind;
  readonly detail: string;
  readonly path?: string;
}

export interface ZipReadResult {
  readonly entries: readonly ZipEntry[];
  readonly by_path: ReadonlyMap<string, ZipEntry>;
  readonly problems: readonly ZipProblem[];
  /** 结构可枚举且逐条校验通过时为 true。 */
  readonly ok: boolean;
}

export type OpcProblemKind =
  | 'zip_structure'
  | 'content_types_missing'
  | 'content_types_parse_error'
  | 'duplicate_content_type_default'
  | 'duplicate_content_type_override'
  | 'content_type_dual_registration'
  | 'content_type_missing'
  | 'rels_parse_error'
  | 'duplicate_rel_id'
  | 'escape_relationship'
  | 'dangling_relationship'
  | 'orphan_media_part';

export interface OpcProblem {
  readonly kind: OpcProblemKind;
  readonly detail: string;
  /** 相关部件路径（能定位时给出）。 */
  readonly part?: string;
  readonly rel_id?: string;
}

export interface OpcRelationship {
  /** 持有关系的部件路径；包级 `_rels/.rels` 用 `''`。 */
  readonly owner: string;
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly external: boolean;
  /** 非外部且能解析时的包内路径，否则 `null`。 */
  readonly resolved: string | null;
}

export interface OpcReport {
  readonly problems: readonly OpcProblem[];
  /** 包内全部部件路径（不含 `[Content_Types].xml` 自身）。 */
  readonly part_paths: readonly string[];
  /** 部件路径 → 有效内容类型。 */
  readonly effective_content_types: ReadonlyMap<string, string>;
  readonly relationships: readonly OpcRelationship[];
  /** `ppt/media/**` 下的媒体部件路径。 */
  readonly media_parts: readonly string[];
  /** 被至少一条内部关系指向的部件路径集合。 */
  readonly referenced_parts: ReadonlySet<string>;
  /** 全部问题为空时为 true。 */
  readonly ok: boolean;
}

// ---------------------------------------------------------------------------
// 独立 CRC-32（逐位，非查表）
// ---------------------------------------------------------------------------

/** 反射多项式 `0xEDB88320`（ZIP / IEEE 802.3），字面写出，不 import `crc32.ts`。 */
const REFLECTED_POLY = 0xedb88320;

export function crc32Independent(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index] as number;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? REFLECTED_POLY ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// ZIP 常量（独立写出）
// ---------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;

/** 数据视图 + 字节流的一层薄封装，顺手做边界检查。 */
class Cursor {
  private readonly view: DataView;
  constructor(
    private readonly bytes: Uint8Array,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  u16(offset: number): number {
    this.require(offset, 2);
    return this.view.getUint16(offset, true);
  }

  u32(offset: number): number {
    this.require(offset, 4);
    return this.view.getUint32(offset, true);
  }

  slice(start: number, end: number): Uint8Array {
    this.require(start, end - start);
    return this.bytes.subarray(start, end);
  }

  private require(offset: number, size: number): void {
    if (offset < 0 || size < 0 || offset + size > this.bytes.byteLength) {
      throw new RangeError(
        `读越界：offset=${String(offset)} size=${String(size)} len=${String(this.bytes.byteLength)}`,
      );
    }
  }
}

function decodeAsciiName(raw: Uint8Array): { name: string | null; nonAscii: boolean } {
  let out = '';
  for (const byte of raw) {
    if (byte > 0x7f) return { name: null, nonAscii: true };
    out += String.fromCharCode(byte);
  }
  return { name: out, nonAscii: false };
}

/** 从尾部往前找 EOCD：签名 + 注释长度正好把文件收尾。 */
function findEocd(cursor: Cursor): number | null {
  const start = Math.max(0, cursor.length - EOCD_SIZE - MAX_COMMENT);
  for (let offset = cursor.length - EOCD_SIZE; offset >= start; offset -= 1) {
    if (cursor.u32(offset) !== SIG_EOCD) continue;
    const commentLength = cursor.u16(offset + 20);
    if (offset + EOCD_SIZE + commentLength === cursor.length) return offset;
  }
  return null;
}

/**
 * 扫描一份 ZIP（纯函数，从不抛异常）。
 *
 * `ok` 为 true 表示结构可枚举且每条 CRC / 尺寸都自洽；此时 `entries` 可放心用于上层 OPC 校验。
 * 结构损坏时 `ok=false`，`problems` 里给出原因。
 */
export function readZipIndependent(bytes: Uint8Array): ZipReadResult {
  const problems: ZipProblem[] = [];
  const cursor = new Cursor(bytes);

  const fail = (kind: ZipProblemKind, detail: string): ZipReadResult => ({
    entries: [],
    by_path: new Map(),
    problems: [...problems, { kind, detail }],
    ok: false,
  });

  if (cursor.length < EOCD_SIZE) return fail('truncated', `文件不足 ${String(EOCD_SIZE)} 字节`);

  const eocd = findEocd(cursor);
  if (eocd === null) return fail('eocd_missing', '找不到收尾的 EOCD 记录');

  const declaredCount = cursor.u16(eocd + 10);
  const cdOffset = cursor.u32(eocd + 16);
  const cdSize = cursor.u32(eocd + 12);

  const entries: ZipEntry[] = [];
  const byPath = new Map<string, ZipEntry>();

  let offset = cdOffset;
  for (let index = 0; index < declaredCount; index += 1) {
    if (offset + CENTRAL_HEADER_SIZE > cursor.length) {
      problems.push({ kind: 'truncated', detail: `中央目录第 ${String(index)} 项越界` });
      return { entries, by_path: byPath, problems, ok: false };
    }
    if (cursor.u32(offset) !== SIG_CENTRAL) {
      return fail('bad_central_signature', `中央目录第 ${String(index)} 项签名不符`);
    }

    const flags = cursor.u16(offset + 8);
    const method = cursor.u16(offset + 10);
    const recordedCrc = cursor.u32(offset + 16);
    const compressedSize = cursor.u32(offset + 20);
    const uncompressedSize = cursor.u32(offset + 24);
    const nameLength = cursor.u16(offset + 28);
    const extraLength = cursor.u16(offset + 30);
    const commentLength = cursor.u16(offset + 32);
    const localOffset = cursor.u32(offset + 42);

    const nameStart = offset + CENTRAL_HEADER_SIZE;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > cursor.length) {
      return fail('name_length_out_of_range', `中央目录第 ${String(index)} 项文件名越界`);
    }
    const decoded = decodeAsciiName(cursor.slice(nameStart, nameEnd));
    if (decoded.name === null) {
      problems.push({ kind: 'name_length_out_of_range', detail: `第 ${String(index)} 项文件名非 ASCII` });
      return { entries, by_path: byPath, problems, ok: false };
    }
    const path = decoded.name;

    // 本地头校验。
    if (localOffset + LOCAL_HEADER_SIZE > cursor.length || cursor.u32(localOffset) !== SIG_LOCAL) {
      return fail('bad_local_signature', `条目 ${path} 的本地头签名不符`);
    }
    const localFlags = cursor.u16(localOffset + 6);
    const localMethod = cursor.u16(localOffset + 8);
    const localNameLength = cursor.u16(localOffset + 26);
    const localExtraLength = cursor.u16(localOffset + 28);
    if (localFlags !== flags) {
      problems.push({ kind: 'local_header_flags_mismatch', detail: `条目 ${path} 本地/中央 flags 不一致`, path });
    }
    if (localMethod !== method) {
      problems.push({ kind: 'local_header_method_mismatch', detail: `条目 ${path} 本地/中央压缩方法不一致`, path });
    }

    const dataStart = localOffset + LOCAL_HEADER_SIZE + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > cursor.length) {
      return fail('truncated', `条目 ${path} 的数据区越界`);
    }
    if (method !== 0) {
      problems.push({ kind: 'unsupported_compression', detail: `条目 ${path} 压缩方法 ${String(method)}（本校验器只读 STORE）`, path });
      return { entries, by_path: byPath, problems, ok: false };
    }
    if (compressedSize !== uncompressedSize) {
      problems.push({ kind: 'store_size_mismatch', detail: `条目 ${path} STORE 的 csize≠usize`, path });
    }

    const data = cursor.slice(dataStart, dataEnd);
    const recomputed = crc32Independent(data);
    if (recomputed !== recordedCrc) {
      problems.push({
        kind: 'crc_mismatch',
        detail: `条目 ${path} CRC 不符：记录 0x${recordedCrc.toString(16)} 重算 0x${recomputed.toString(16)}`,
        path,
      });
    }
    if (byPath.has(path)) {
      problems.push({ kind: 'duplicate_path', detail: `路径重复：${path}`, path });
    }

    const entry: ZipEntry = {
      path,
      method,
      flags,
      recorded_crc: recordedCrc,
      recomputed_crc: recomputed,
      compressed_size: compressedSize,
      uncompressed_size: uncompressedSize,
      local_header_offset: localOffset,
      data,
    };
    entries.push(entry);
    byPath.set(path, entry);

    offset = nameEnd + extraLength + commentLength;
  }

  return { entries, by_path: byPath, problems, ok: problems.length === 0 };
}

// ---------------------------------------------------------------------------
// 最小 STORE ZIP 重打包器（测试侧造反向对照用；从零实现）
// ---------------------------------------------------------------------------

/** 把一组 `{path, data}` 打成 STORE-only ZIP（无压缩、无时间戳）。 */
export function writeStoredZip(entries: readonly { readonly path: string; readonly data: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const crc = crc32Independent(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(LOCAL_HEADER_SIZE + nameBytes.length + size);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, SIG_LOCAL, true);
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(6, 0, true); // flags
    localView.setUint16(8, 0, true); // method STORE
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, size, true);
    localView.setUint32(22, size, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, LOCAL_HEADER_SIZE);
    local.set(entry.data, LOCAL_HEADER_SIZE + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(CENTRAL_HEADER_SIZE + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, SIG_CENTRAL, true);
    centralView.setUint16(4, 20, true); // version made by
    centralView.setUint16(6, 20, true); // version needed
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, size, true);
    centralView.setUint32(24, size, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, CENTRAL_HEADER_SIZE);
    centrals.push(central);

    offset += local.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const central of centrals) cdSize += central.length;

  const eocd = new Uint8Array(EOCD_SIZE);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, SIG_EOCD, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, cdSize, true);
  eocdView.setUint32(16, cdOffset, true);
  eocdView.setUint16(20, 0, true);

  const total = cdOffset + cdSize + EOCD_SIZE;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const local of locals) {
    out.set(local, cursor);
    cursor += local.length;
  }
  for (const central of centrals) {
    out.set(central, cursor);
    cursor += central.length;
  }
  out.set(eocd, cursor);
  return out;
}

// ---------------------------------------------------------------------------
// 自带极简 XML 标签扫描（不复用 xml-parse.ts）
// ---------------------------------------------------------------------------

interface ScannedTag {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
}

/** 只扫开始 / 自闭合标签（跳过声明、注释、结束标签）。 */
function scanTags(xml: string): ScannedTag[] {
  const tags: ScannedTag[] = [];
  const tagPattern = /<([A-Za-z_][\w:.-]*)((?:[^>"]|"[^"]*")*?)(\/?)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(xml)) !== null) {
    const name = match[1] as string;
    const attributeText = match[2] as string;
    const attributes = new Map<string, string>();
    const attributePattern = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g;
    let attribute: RegExpExecArray | null;
    while ((attribute = attributePattern.exec(attributeText)) !== null) {
      attributes.set(attribute[1] as string, unescapeXml(attribute[2] as string));
    }
    tags.push({ name, attributes });
  }
  return tags;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const decoder = new TextDecoder('utf-8');
function entryText(entry: ZipEntry | undefined): string | null {
  return entry === undefined ? null : decoder.decode(entry.data);
}

// ---------------------------------------------------------------------------
// 关系目标解析（自带，不复用 opc.ts 的 resolveRelationshipTarget）
// ---------------------------------------------------------------------------

/** 由 `_rels` 部件路径推出其**持有者**部件路径；包级 `_rels/.rels` 返回 `''`。 */
function ownerOfRelsPart(relsPath: string): string | null {
  if (relsPath === '_rels/.rels') return '';
  const marker = '/_rels/';
  const index = relsPath.indexOf(marker);
  if (index < 0) return null;
  const dir = relsPath.slice(0, index + 1); // 含尾部斜杠
  const fileName = relsPath.slice(index + marker.length); // 形如 xxx.xml.rels
  if (!fileName.endsWith('.rels')) return null;
  return `${dir}${fileName.slice(0, -'.rels'.length)}`;
}

/**
 * 把相对目标解析成包内路径。`owner` 为 `''`（包级）或部件路径。
 * 逃出包根或解析为空时返回 `null`。
 */
function resolveTarget(owner: string, target: string): string | null {
  const relativeToRoot = target.startsWith('/') || owner === '';
  const base = relativeToRoot ? '' : owner.slice(0, owner.lastIndexOf('/') + 1);
  const combined = relativeToRoot ? target.replace(/^\/+/, '') : `${base}${target}`;
  const stack: string[] = [];
  for (const segment of combined.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.length === 0 ? null : stack.join('/');
}

function extensionOf(path: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  if (dot <= slash) return '';
  return path.slice(dot + 1).toLowerCase();
}

function isMediaPart(path: string): boolean {
  return path.startsWith('ppt/media/');
}

// ---------------------------------------------------------------------------
// OPC 校验
// ---------------------------------------------------------------------------

const CONTENT_TYPES_PATH = '[Content_Types].xml';

/**
 * 对一份 OPC 包（ZIP 字节）做独立校验（纯函数，从不抛异常）。
 *
 * 三个问题域都会收进 `problems`：
 * - 内容类型双重登记 / 缺失；
 * - 悬挂关系 / 逃出包根的关系；
 * - 孤儿媒体部件。
 */
export function validateOpcPackage(bytes: Uint8Array): OpcReport {
  const problems: OpcProblem[] = [];
  const zip = readZipIndependent(bytes);
  for (const problem of zip.problems) {
    problems.push({
      kind: 'zip_structure',
      detail: `${problem.kind}: ${problem.detail}`,
      ...(problem.path === undefined ? {} : { part: problem.path }),
    });
  }

  const partPaths = zip.entries.map((entry) => entry.path).filter((path) => path !== CONTENT_TYPES_PATH);

  // --- 内容类型 ---
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  const contentTypesText = entryText(zip.by_path.get(CONTENT_TYPES_PATH));
  if (contentTypesText === null) {
    problems.push({ kind: 'content_types_missing', detail: '包内没有 [Content_Types].xml', part: CONTENT_TYPES_PATH });
  } else {
    const tags = scanTags(contentTypesText);
    if (!tags.some((tag) => tag.name === 'Types')) {
      problems.push({ kind: 'content_types_parse_error', detail: '未找到 Types 根元素', part: CONTENT_TYPES_PATH });
    }
    for (const tag of tags) {
      const contentTypes = tag.attributes.get('ContentType');
      if (tag.name === 'Default') {
        const ext = tag.attributes.get('Extension')?.toLowerCase();
        if (ext === undefined || contentTypes === undefined) continue;
        if (defaults.has(ext)) {
          problems.push({ kind: 'duplicate_content_type_default', detail: `扩展名 .${ext} 有重复 Default`, part: CONTENT_TYPES_PATH });
        }
        defaults.set(ext, contentTypes);
      } else if (tag.name === 'Override') {
        const partName = tag.attributes.get('PartName')?.replace(/^\/+/, '');
        if (partName === undefined || contentTypes === undefined) continue;
        if (overrides.has(partName)) {
          problems.push({ kind: 'duplicate_content_type_override', detail: `部件 ${partName} 有重复 Override`, part: partName });
        }
        overrides.set(partName, contentTypes);
      }
    }
  }

  const effective = new Map<string, string>();
  for (const path of partPaths) {
    const override = overrides.get(path);
    const byExtension = defaults.get(extensionOf(path));
    const registrations = (override === undefined ? 0 : 1) + (byExtension === undefined ? 0 : 1);
    if (registrations === 2) {
      problems.push({
        kind: 'content_type_dual_registration',
        detail: `部件 ${path} 同时被扩展名 Default(.${extensionOf(path)}) 与部件 Override 双重登记`,
        part: path,
      });
    } else if (registrations === 0) {
      problems.push({
        kind: 'content_type_missing',
        detail: `部件 ${path} 没有任何内容类型（无 Override、扩展名 .${extensionOf(path)} 也无 Default）`,
        part: path,
      });
      continue;
    }
    const resolved = override ?? byExtension;
    if (resolved !== undefined) effective.set(path, resolved);
  }

  // --- 关系 ---
  const relationships: OpcRelationship[] = [];
  const referencedParts = new Set<string>();
  const relsParts = zip.entries.filter((entry) => entry.path.endsWith('.rels'));

  for (const relsPart of relsParts) {
    const owner = ownerOfRelsPart(relsPart.path);
    if (owner === null) continue;
    const text = entryText(relsPart);
    if (text === null) continue;
    if (!scanTags(text).some((tag) => tag.name === 'Relationships')) {
      problems.push({ kind: 'rels_parse_error', detail: '未找到 Relationships 根元素', part: relsPart.path });
      continue;
    }
    const seenIds = new Set<string>();
    for (const tag of scanTags(text)) {
      if (tag.name !== 'Relationship') continue;
      const id = tag.attributes.get('Id');
      const type = tag.attributes.get('Type') ?? '';
      const target = tag.attributes.get('Target');
      if (id === undefined || target === undefined) {
        problems.push({ kind: 'rels_parse_error', detail: `关系缺少 Id/Target`, part: relsPart.path });
        continue;
      }
      if (seenIds.has(id)) {
        problems.push({ kind: 'duplicate_rel_id', detail: `持有者 ${owner || '(包级)'} 内重复 rel id ${id}`, part: relsPart.path, rel_id: id });
      }
      seenIds.add(id);
      const external = (tag.attributes.get('TargetMode') ?? 'Internal') === 'External';

      let resolved: string | null = null;
      if (!external) {
        resolved = resolveTarget(owner, target);
        if (resolved === null) {
          problems.push({
            kind: 'escape_relationship',
            detail: `关系目标 ${target} 逃出包根或解析为空（owner=${owner || '(包级)'}）`,
            part: relsPart.path,
            rel_id: id,
          });
        } else if (!zip.by_path.has(resolved)) {
          problems.push({
            kind: 'dangling_relationship',
            detail: `关系目标 ${target} 解析为 ${resolved}，但包内没有该部件`,
            part: relsPart.path,
            rel_id: id,
          });
        } else {
          referencedParts.add(resolved);
        }
      }

      relationships.push({ owner, id, type, target, external, resolved });
    }
  }

  // --- 孤儿媒体 ---
  const mediaParts = zip.entries.map((entry) => entry.path).filter(isMediaPart);
  for (const media of mediaParts) {
    if (!referencedParts.has(media)) {
      problems.push({ kind: 'orphan_media_part', detail: `媒体部件 ${media} 没有被任何内部关系指向`, part: media });
    }
  }

  return {
    problems,
    part_paths: partPaths,
    effective_content_types: effective,
    relationships,
    media_parts: mediaParts,
    referenced_parts: referencedParts,
    ok: problems.length === 0,
  };
}

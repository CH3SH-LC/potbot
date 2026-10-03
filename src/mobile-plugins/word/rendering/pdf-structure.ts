/**
 * **PDF 结构读回（纯 TS，零依赖）**——W09 的「真实 PDF 读回」在手机运行时里的可执行着一层。
 *
 * ## 为什么还需要一个 TS 读回器（Java 已有 `PotbotPdfReadback.java`）
 *
 * 手机有**两条** PDF 路线：
 *
 * 1. Android 原生 `android.graphics.pdf.PdfDocument` 写、`PdfRenderer` 读（见
 *    `PotbotPdfLayout.java` / `PotbotPdfReadback.java`）；
 * 2. 手机 JS 运行时（K01）里跑的纯 TS 引擎。
 *
 * Java 读回器只能在**真机**上执行；本模块让同一批判据在**无设备**时也能被机器化测试，
 * 且它是**第二份独立实现**——两份实现同时能过，比"写的人自己说没问题"强。
 *
 * 本模块**不调用**任何外部工具、不联网、不读文件系统；输入就是字节。
 *
 * ## 判据（与 Java 端逐条对应，缺一不可）
 *
 * | 判据 | 本模块 | Java 端 |
 * |---|---|---|
 * | 非空 | `byteLength > 0` | `file_non_empty` |
 * | 是 PDF 魔数 | 头 5 字节 `%PDF-` | `pdf_magic`（抓改扩展名伪造） |
 * | 能结构化解析 | startxref 指向经典 `xref` 表**或** PDF 1.5+ `/Type /XRef` 交叉引用流、有 `/Size` | `pdf_parses`（系统解析器） |
 * | 页数可交叉核对 | 页树 `/Count` 或对象扫描 | `page_count` |
 * | 未加密 | 无 `/Encrypt` | （系统解析器报加密即失败） |
 *
 * ## 诚实的边界
 *
 * - **页数来源有两档**：优先**页树 `/Count`**（跟着 `/Root` 走），取不到才退回
 *   `/Type /Page` **对象扫描**。`pageCountSource` 字段把用的是哪一档如实标出——扫描档
 *   面对畸形/不可信 PDF 可能数错，调用方据此决定要不要采信。
 * - **不做**内容流解码、"首页有没有墨迹"的门槛（那是 Java 端 `inkPixels` 的活，需要真实
 *   光栅化）。本模块只回答**结构**问题，`hasContentStreams` 只表示存在 `/Contents` 引用。
 * - **PDF 1.5+ 交叉引用流**（`/Type /XRef`）已支持；同时沿 `/Prev` 链读取增量更新
 *   （多个 `startxref`）：新的段覆盖旧的段，页树按**最新偏移**定位对象，不会把被替换的
 *   旧页对象也算进去。链长如实记在 `prevChainLength`。
 * - **仍不做**：`/ObjStm` 对象流内的对象解压，以及**压缩**（`/Filter` 非 `/Identity`）的
 *   交叉引用流/对象流解码——本模块零依赖、无 zlib。这类 PDF 会退回字符串扫描档取页数，
 *   `xrefEntriesDecoded` 如实标 false，`pageCountSource` 继续标 `page-tree` / `object-scan`，
 *   由调用方决定是否采信。
 */

/** 读回失败分类（封闭枚举）。 */
export type PdfReadbackFailureKind =
  /** 0 字节。 */
  | 'empty'
  /** 非空但不是 `%PDF-` 开头（改扩展名伪造会落这里）。 */
  | 'magic_mismatch'
  /** 没有 `%%EOF`（截断 / 未写完）。 */
  | 'no_eof'
  /** 找不到 `startxref` 偏移。 */
  | 'no_startxref'
  /** `startxref` 偏移处既不是 `xref` 关键字，也不是 `/Type /XRef` 交叉引用流对象。 */
  | 'xref_offset_invalid'
  /** 交叉引用流结构不完整 / 被截断（缺 `/W`、`/Size`，或 `/Length` 与实到字节不符）。 */
  | 'xref_stream_malformed'
  /** 有 `/Encrypt`：加密 PDF 本模块不解密。 */
  | 'encrypted'
  /** 声明页数与结构解析出的页数不符。 */
  | 'page_count_mismatch';

export interface PdfReadbackFailure {
  readonly kind: PdfReadbackFailureKind;
  readonly message: string;
  readonly detail?: string;
}

/** 结构读回到的**事实**（不含结论）。 */
export interface PdfStructureFacts {
  readonly byteLength: number;
  /** 文件头原始 5 字节（形如 `%PDF-`）。 */
  readonly magic: string;
  /** 版本串，如 `1.7`；取不到为 null。 */
  readonly version: string | null;
  readonly hasEof: boolean;
  /** `startxref` 给出的交叉引用表偏移；取不到为 null。 */
  readonly xrefOffset: number | null;
  /** startxref 偏移处是不是经典 `xref` 关键字。 */
  readonly xrefAtOffset: boolean;
  /** startxref 偏移处是不是 `/Type /XRef` 交叉引用流（PDF 1.5+）。 */
  readonly xrefStream: boolean;
  /** 沿 `/Prev` 跟随的段数（0 = 单段，无增量更新）。 */
  readonly prevChainLength: number;
  /** 交叉引用条目是否已解出（压缩 `/Filter` 的流本模块不解码，为 false）。 */
  readonly xrefEntriesDecoded: boolean;
  /** trailer `/Size`；取不到为 null。 */
  readonly trailerSize: number | null;
  /** trailer `/Root` 的对象引用，如 `1 0 R`；取不到为 null。 */
  readonly rootRef: string | null;
  /** 解析出的页数。 */
  readonly pageCount: number;
  /** 页数来自哪一档（诚实标记）。 */
  readonly pageCountSource: 'page-tree' | 'object-scan';
  readonly encrypted: boolean;
  /** 是否存在 `/Contents` 引用（仅表示存在内容流引用，不代表非空白）。 */
  readonly hasContentStreams: boolean;
}

export type PdfInspection =
  | { readonly ok: true; readonly facts: PdfStructureFacts }
  | { readonly ok: false; readonly failure: PdfReadbackFailure };

/** 独立读回结果（含与调用方自报页数的交叉核对）。 */
export type PdfReadbackOutcome =
  | {
      readonly ok: true;
      readonly facts: PdfStructureFacts;
      readonly declaredPageCount: number;
      readonly pageCountMatches: boolean;
    }
  | { readonly ok: false; readonly failure: PdfReadbackFailure };

// ---------------------------------------------------------------------------
// 字节 → latin1 字符串（PDF 的语法层是字节级 ASCII；高位字节按 1:1 映射，
// 不解释为 UTF-8 码点，避免破坏对象偏移的字符索引与字节偏移一致）
// ---------------------------------------------------------------------------

function toLatin1(bytes: Uint8Array): string {
  let out = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    out += String.fromCharCode(...slice);
  }
  return out;
}

function asciiFromBytes(bytes: Uint8Array, from: number, len: number): string {
  let out = '';
  for (let i = from; i < from + len && i < bytes.length; i += 1) {
    const b = bytes[i] as number;
    out += b >= 32 && b < 127 ? String.fromCharCode(b) : '?';
  }
  return out;
}

function parseXrefOffset(str: string): number | null {
  const at = str.lastIndexOf('startxref');
  if (at < 0) return null;
  const tail = str.slice(at + 'startxref'.length);
  const m = /^\s*(\d+)/.exec(tail);
  if (m === null) return null;
  const n = Number.parseInt(m[1] as string, 10);
  return Number.isFinite(n) ? n : null;
}

function parseTrailerFacts(str: string): { size: number | null; root: string | null } {
  const at = str.lastIndexOf('trailer');
  const region = at >= 0 ? str.slice(at) : str;
  const sizeMatch = /\/Size\s+(\d+)/.exec(region);
  const rootMatch = /\/Root\s+(\d+\s+\d+\s+R)/.exec(region) ?? /\/Root\s+(\d+\s+\d+\s+R)/.exec(str);
  return {
    size: sizeMatch === null ? null : Number.parseInt(sizeMatch[1] as string, 10),
    root: rootMatch === null ? null : (rootMatch[1] as string).replace(/\s+/g, ' '),
  };
}

/** 取某编号对象的正文（`N G obj` 到 `endobj` 之间）。 */
function objectBody(str: string, objNum: string): string | null {
  const objAt = new RegExp(`(?:^|[^0-9])${objNum}\\s+\\d+\\s+obj`).exec(str);
  if (objAt === null) return null;
  const start = objAt.index + objAt[0].length;
  const end = str.indexOf('endobj', start);
  return str.slice(start, end < 0 ? str.length : end);
}

/**
 * 走页树：`/Root`（通常是 Catalog）→ `/Pages` 引用 → 该对象的 `/Count`。
 * 若 `/Root` 自己就是 Pages（少见但合法），直接读它的 `/Count`。
 */
function pageCountFromTree(str: string, rootRef: string | null): number | null {
  if (rootRef === null) return null;
  const rootNum = rootRef.split(' ')[0];
  if (rootNum === undefined) return null;
  const rootBody = objectBody(str, rootNum);
  if (rootBody === null) return null;

  const pagesRef = /\/Pages\s+(\d+)\s+\d+\s+R/.exec(rootBody);
  if (pagesRef !== null) {
    const pagesBody = objectBody(str, pagesRef[1] as string);
    if (pagesBody !== null) {
      const c = /\/Count\s+(\d+)/.exec(pagesBody);
      if (c !== null) return Number.parseInt(c[1] as string, 10);
    }
  }
  const own = /\/Count\s+(\d+)/.exec(rootBody);
  return own === null ? null : Number.parseInt(own[1] as string, 10);
}

/** 退回对象扫描：数 `/Type /Page`，排除 `/Pages`。 */
function pageCountByScan(str: string): number {
  const re = /\/Type\s*\/Page(?![A-Za-z])/g;
  let n = 0;
  while (re.exec(str) !== null) n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// 交叉引用（xref）
//
// 两档来源：经典 `xref` 表（PDF 1.4 及以前）与交叉引用流 `/Type /XRef`
// （PDF 1.5+）。两者都可能有 `/Prev`，串成增量更新的链；新段覆盖旧段。
// 本模块零依赖，**不解码** `/Filter`（zlib 等）的流，也不解压 `/ObjStm` 内的对象：
// 这类输入退回字符串扫描档，`xrefEntriesDecoded` 如实标 false。
// ---------------------------------------------------------------------------

/** 一条交叉引用条目（type 与两个整数字段，含义随 type 而定）。 */
interface XrefEntry {
  /** 0 = 空闲，1 = 未压缩（偏移在 `a`），2 = 在对象流内（流号在 `a`）。 */
  readonly type: 0 | 1 | 2;
  readonly a: number;
  readonly b: number;
}

/** 一段交叉引用（一个 `startxref` 目标）的解析结果。 */
interface XrefSection {
  readonly kind: 'table' | 'stream';
  readonly offset: number;
  readonly root: string | null;
  readonly size: number | null;
  readonly prevOffset: number | null;
  readonly encrypted: boolean;
  readonly entries: Map<number, XrefEntry>;
  /** 条目是否解出（经典表恒 true；压缩的交叉引用流为 false）。 */
  readonly entriesDecoded: boolean;
}

type ChainRead =
  | { readonly ok: true; readonly sections: readonly XrefSection[] }
  | { readonly ok: false; readonly reason: 'xref_offset_invalid' | 'xref_stream_malformed' };

/** `/Prev` 链上限，防环 / 防御性 PDF。 */
const MAX_XREF_CHAIN = 64;

/** 取 `<< ... >>` 字典文本（按 `<<`/`>>` 配对，忽略字典内嵌套）。 */
function extractDict(region: string): string | null {
  const start = region.indexOf('<<');
  if (start < 0) return null;
  let depth = 0;
  let i = start;
  while (i < region.length) {
    if (region.startsWith('<<', i)) {
      depth += 1;
      i += 2;
      continue;
    }
    if (region.startsWith('>>', i)) {
      depth -= 1;
      i += 2;
      if (depth === 0) return region.slice(start, i);
      continue;
    }
    i += 1;
  }
  return region.slice(start);
}

/** 字典里某个键的整数标量值。 */
function intKey(dict: string, key: string): number | null {
  const m = new RegExp(`/${key}\\s+(\\d+)`).exec(dict);
  return m === null ? null : Number.parseInt(m[1] as string, 10);
}

/** 字典里某个键的对象引用（形如 `1 0 R`），空白归一。 */
function refKey(dict: string, key: string): string | null {
  const m = new RegExp(`/${key}\\s+(\\d+\\s+\\d+\\s+R)`).exec(dict);
  return m === null ? null : (m[1] as string).replace(/\s+/g, ' ');
}

/** 字典里某个键的整数数组（`/W [1 2 1]`、`/Index [0 1 2 1]`）。 */
function intArrayKey(dict: string, key: string): number[] | null {
  const m = new RegExp(`/${key}\\s*\\[([^\\]]*)\\]`).exec(dict);
  if (m === null) return null;
  const nums = (m[1] as string).match(/-?\d+/g);
  return nums === null ? null : nums.map((n) => Number.parseInt(n, 10));
}

/** 交叉引用流 `/Filter` 名字（数组取首项）。 */
function filterKey(dict: string): string | null {
  const arr = /\/Filter\s*\[([^\]]*)\]/.exec(dict);
  if (arr !== null) {
    const first = /([A-Za-z0-9]+)/.exec(arr[1] as string);
    return first === null ? null : (first[1] as string);
  }
  const one = /\/Filter\s*\/?([A-Za-z0-9]+)/.exec(dict);
  return one === null ? null : (one[1] as string);
}

/** `from` 处起读 `len` 个大端字节整数（用于交叉引用流的定宽字段）。 */
function readUint(s: string, from: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i += 1) {
    const at = from + i;
    v = v * 256 + (at < s.length ? (s.charCodeAt(at) & 0xff) : 0);
  }
  return v;
}

/** 若 `offset` 处是 `N G obj`，返回对象正文（到 `endobj` 之间）。 */
function objectBodyAtOffset(str: string, offset: number): string | null {
  const m = /^\s*(\d+)\s+(\d+)\s+obj/.exec(str.slice(offset, offset + 64));
  if (m === null) return null;
  const start = offset + m[0].length;
  const end = str.indexOf('endobj', start);
  return str.slice(start, end < 0 ? str.length : end);
}

/** 解析经典 `xref` 表 + 紧随的 `trailer`。 */
function readClassicXref(str: string, offset: number): XrefSection {
  const lines = str.slice(offset).split('\n');
  const entries = new Map<number, XrefEntry>();
  let cursor = 0;
  let i = 1; // 跳过 'xref' 行
  while (i < lines.length) {
    const ln = (lines[i] as string).replace(/\r$/, '').trim();
    i += 1;
    if (ln === '') continue;
    if (ln === 'trailer') break;
    const sub = /^(\d+)\s+(\d+)$/.exec(ln);
    if (sub !== null) {
      cursor = Number.parseInt(sub[1] as string, 10);
      continue;
    }
    const e = /^(\d+)\s+(\d+)\s+([nf])$/.exec(ln);
    if (e !== null) {
      const a = Number.parseInt(e[1] as string, 10);
      const b = Number.parseInt(e[2] as string, 10);
      const type: 0 | 1 = e[3] === 'n' ? 1 : 0;
      entries.set(cursor, { type, a, b });
      cursor += 1;
    }
  }
  const tAt = str.indexOf('trailer', offset);
  const dict = tAt < 0 ? null : extractDict(str.slice(tAt));
  return {
    kind: 'table',
    offset,
    root: dict === null ? null : refKey(dict, 'Root'),
    size: dict === null ? null : intKey(dict, 'Size'),
    prevOffset: dict === null ? null : intKey(dict, 'Prev'),
    encrypted: dict !== null && /\/Encrypt\b/.test(dict),
    entries,
    entriesDecoded: true,
  };
}

/**
 * 解析交叉引用流对象（`/Type /XRef`）。结构不完整 / 被截断返回 `'malformed'`，
 * 让调用方**失败关闭**而不是当作好 PDF 采信页数。
 */
function readXrefStream(str: string, offset: number, body: string): XrefSection | 'malformed' {
  const dict = extractDict(body);
  if (dict === null) return 'malformed';
  const size = intKey(dict, 'Size');
  const root = refKey(dict, 'Root');
  const prevOffset = intKey(dict, 'Prev');
  const encrypted = /\/Encrypt\b/.test(dict);
  const declaredLength = intKey(dict, 'Length');
  const w = intArrayKey(dict, 'W');

  const sIdx = body.indexOf('stream');
  if (sIdx < 0) return 'malformed';
  let dataStart = sIdx + 'stream'.length;
  if (body[dataStart] === '\r') dataStart += 1;
  if (body[dataStart] === '\n') dataStart += 1;
  const eIdx = body.indexOf('endstream', dataStart);
  if (eIdx < 0) return 'malformed';
  if (declaredLength === null) return 'malformed';
  const available = eIdx - dataStart;
  // 截断：声明的 /Length 超过实到字节（写盘方少写了一段）。
  if (declaredLength > available) return 'malformed';

  if (w === null || w.length < 1) return 'malformed';
  const w0 = w[0] as number;
  const w1 = w.length > 1 ? (w[1] as number) : 0;
  const w2 = w.length > 2 ? (w[2] as number) : 0;
  const width = w0 + w1 + w2;
  if (width <= 0) return 'malformed';

  const indexArr = intArrayKey(dict, 'Index');
  let ranges: number[];
  if (indexArr !== null && indexArr.length >= 2) ranges = indexArr;
  else if (size !== null) ranges = [0, size];
  else return 'malformed';

  let expected = 0;
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    expected += (ranges[i + 1] as number) * width;
  }
  // 截断：数据不足一整组条目。
  if (declaredLength < expected) return 'malformed';

  const filter = filterKey(dict);
  const decodable = filter === null || filter === 'Identity';
  const entries = new Map<number, XrefEntry>();
  if (decodable) {
    const data = body.slice(dataStart, dataStart + declaredLength);
    let pos = 0;
    for (let i = 0; i + 1 < ranges.length; i += 2) {
      let objNum = ranges[i] as number;
      const count = ranges[i + 1] as number;
      for (let k = 0; k < count; k += 1) {
        const rawType = w0 === 0 ? 1 : readUint(data, pos, w0);
        pos += w0;
        const f2 = readUint(data, pos, w1);
        pos += w1;
        const f3 = readUint(data, pos, w2);
        pos += w2;
        if (rawType === 0 || rawType === 1 || rawType === 2) {
          entries.set(objNum, { type: rawType, a: f2, b: f3 });
        }
        objNum += 1;
      }
    }
  }
  return {
    kind: 'stream',
    offset,
    root,
    size,
    prevOffset,
    encrypted,
    entries,
    entriesDecoded: decodable,
  };
}

/** 读 `offset` 处的一段交叉引用：经典表 / 交叉引用流 / 都不是。 */
function readXrefSectionAt(str: string, offset: number): XrefSection | 'malformed' | null {
  if (offset < 0 || offset >= str.length) return null;
  if (str.slice(offset, offset + 4) === 'xref') return readClassicXref(str, offset);
  const body = objectBodyAtOffset(str, offset);
  if (body === null) return null;
  if (!/\/Type\s*\/XRef\b/.test(body)) return null;
  return readXrefStream(str, offset, body);
}

/** 从 `startOffset` 起沿 `/Prev` 串起交叉引用段（新→旧）。 */
function readXrefChain(str: string, startOffset: number): ChainRead {
  const sections: XrefSection[] = [];
  const visited = new Set<number>();
  let offset: number | null = startOffset;
  while (offset !== null && offset >= 0 && sections.length < MAX_XREF_CHAIN) {
    if (visited.has(offset)) break; // 环
    visited.add(offset);
    const section = readXrefSectionAt(str, offset);
    if (section === 'malformed') return { ok: false, reason: 'xref_stream_malformed' };
    if (section === null) {
      // 首个都不是交叉引用 ⇒ 硬失败；链中途断掉则保留已读到的段。
      if (sections.length === 0) return { ok: false, reason: 'xref_offset_invalid' };
      break;
    }
    sections.push(section);
    offset = section.prevOffset;
  }
  if (sections.length === 0) return { ok: false, reason: 'xref_offset_invalid' };
  return { ok: true, sections };
}

/**
 * 按交叉引用对象表定位对象正文：type 1 用偏移直读（增量更新下取到**最新**那份），
 * type 2（对象流内）本模块解不了返回 null，退回编号字符串扫描。
 */
function resolveObjectBody(
  str: string,
  entries: Map<number, XrefEntry>,
  objNum: number,
): string | null {
  const e = entries.get(objNum);
  if (e !== undefined) {
    if (e.type === 1) {
      const body = objectBodyAtOffset(str, e.a);
      if (body !== null) return body;
    }
    if (e.type === 2) return null;
  }
  return objectBody(str, String(objNum));
}

/** 走交叉引用对象表取页树 `/Count`（只对**完整解出**的交叉引用调用）。 */
function pageCountViaXref(
  str: string,
  entries: Map<number, XrefEntry>,
  rootRef: string | null,
): number | null {
  if (rootRef === null) return null;
  const rootNum = Number.parseInt(rootRef.split(' ')[0] as string, 10);
  if (!Number.isFinite(rootNum)) return null;
  const rootBody = resolveObjectBody(str, entries, rootNum);
  if (rootBody === null) return null;
  const pagesRef = /\/Pages\s+(\d+)\s+\d+\s+R/.exec(rootBody);
  if (pagesRef !== null) {
    const pagesBody = resolveObjectBody(str, entries, Number.parseInt(pagesRef[1] as string, 10));
    if (pagesBody !== null) {
      const c = /\/Count\s+(\d+)/.exec(pagesBody);
      if (c !== null) return Number.parseInt(c[1] as string, 10);
    }
  }
  const own = /\/Count\s+(\d+)/.exec(rootBody);
  return own === null ? null : Number.parseInt(own[1] as string, 10);
}

/** 结构读回（不做页数交叉核对）。 */
export function inspectPdf(bytes: Uint8Array): PdfInspection {
  if (bytes.length === 0) {
    return { ok: false, failure: { kind: 'empty', message: '读回未通过：产物是 0 字节。' } };
  }
  const magic = asciiFromBytes(bytes, 0, 5);
  if (magic !== '%PDF-') {
    return {
      ok: false,
      failure: {
        kind: 'magic_mismatch',
        message: `读回未通过：不是 PDF（文件头 "${magic}"，要求 %PDF-）。改扩展名伪造会落在这里。`,
        detail: `byteLength=${bytes.length}`,
      },
    };
  }

  const str = toLatin1(bytes);
  const versionMatch = /^%PDF-(\d+\.\d+)/.exec(str);
  const version = versionMatch === null ? null : (versionMatch[1] as string);

  const hasEof = str.indexOf('%%EOF') >= 0;
  if (!hasEof) {
    return { ok: false, failure: { kind: 'no_eof', message: '读回未通过：缺少 %%EOF（截断 / 未写完）。' } };
  }

  const xrefOffset = parseXrefOffset(str);
  if (xrefOffset === null) {
    return { ok: false, failure: { kind: 'no_startxref', message: '读回未通过：找不到 startxref 偏移。' } };
  }

  const chain = readXrefChain(str, xrefOffset);
  if (!chain.ok) {
    if (chain.reason === 'xref_stream_malformed') {
      return {
        ok: false,
        failure: {
          kind: 'xref_stream_malformed',
          message: `读回未通过：startxref 偏移 ${xrefOffset} 处的交叉引用流不完整或被截断（/Length 与实到字节不符，或缺 /W、/Size、/Length）。`,
        },
      };
    }
    return {
      ok: false,
      failure: {
        kind: 'xref_offset_invalid',
        message: `读回未通过：startxref 偏移 ${xrefOffset} 处既不是 xref 关键字，也不是 /Type /XRef 交叉引用流对象。`,
      },
    };
  }

  const sections = chain.sections;
  const newest = sections[0] as XrefSection;
  const xrefAtOffset = newest.kind === 'table';
  const xrefStream = newest.kind === 'stream';
  const prevChainLength = sections.length - 1;

  // /Root 与 /Size：沿 /Prev 链从最新一段往前取首个有值者；都没有再退回老解析。
  let rootRef: string | null = null;
  let trailerSize: number | null = null;
  for (const s of sections) {
    if (rootRef === null && s.root !== null) rootRef = s.root;
    if (trailerSize === null && s.size !== null) trailerSize = s.size;
  }
  if (rootRef === null || trailerSize === null) {
    const fallback = parseTrailerFacts(str);
    if (rootRef === null) rootRef = fallback.root;
    if (trailerSize === null) trailerSize = fallback.size;
  }

  const encrypted = /\/Encrypt\b/.test(str) || sections.some((s) => s.encrypted);
  if (encrypted) {
    return {
      ok: false,
      failure: { kind: 'encrypted', message: '读回未通过：PDF 带 /Encrypt，本模块不解密。' },
    };
  }

  // 合并 /Prev 链：新段覆盖旧段（增量更新里旧对象可能被新对象替换）。
  const entries = new Map<number, XrefEntry>();
  let xrefEntriesDecoded = true;
  for (const s of sections) {
    if (!s.entriesDecoded) {
      xrefEntriesDecoded = false;
      continue;
    }
    for (const [num, entry] of s.entries) {
      if (!entries.has(num)) entries.set(num, entry);
    }
  }

  // 只有完整解出交叉引用、按最新偏移定位对象时才敢走对象表页树：
  // 增量更新下字符串扫描会数到被替换的旧页对象。
  const fromXref = xrefEntriesDecoded ? pageCountViaXref(str, entries, rootRef) : null;
  const fromTree = fromXref ?? pageCountFromTree(str, rootRef);
  const pageCount = fromTree ?? pageCountByScan(str);
  const pageCountSource: 'page-tree' | 'object-scan' = fromTree === null ? 'object-scan' : 'page-tree';
  const hasContentStreams = /\/Contents\b/.test(str);

  return {
    ok: true,
    facts: {
      byteLength: bytes.length,
      magic,
      version,
      hasEof,
      xrefOffset,
      xrefAtOffset,
      xrefStream,
      prevChainLength,
      xrefEntriesDecoded,
      trailerSize,
      rootRef,
      pageCount,
      pageCountSource,
      encrypted,
      hasContentStreams,
    },
  };
}

/**
 * 独立读回并**交叉核对**页数——`declaredPageCount >= 0` 时不符即
 * `page_count_mismatch`（写盘方自报只是核对对象，不是结论）。
 */
export function readbackPdf(bytes: Uint8Array, declaredPageCount: number): PdfReadbackOutcome {
  const inspection = inspectPdf(bytes);
  if (!inspection.ok) return inspection;
  const matches = declaredPageCount < 0 || inspection.facts.pageCount === declaredPageCount;
  if (!matches) {
    return {
      ok: false,
      failure: {
        kind: 'page_count_mismatch',
        message: `读回未通过：写盘方自报 ${declaredPageCount} 页，结构解析出 ${inspection.facts.pageCount} 页（来源 ${inspection.facts.pageCountSource}）。`,
      },
    };
  }
  return {
    ok: true,
    facts: inspection.facts,
    declaredPageCount,
    pageCountMatches: matches,
  };
}

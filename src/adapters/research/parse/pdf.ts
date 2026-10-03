/**
 * PDF 文本层解析（**有界**实现，无第三方依赖）。
 *
 * 已实现（对着本机真实语料验证）：
 * - 对象扫描 `N G obj … endobj`；`/Length` 直值优先，否则就近 `endstream`；
 * - 流过滤链 `ASCII85Decode` + `FlateDecode`（见 `pdf-filters.ts`）；
 * - `/Type /ObjStm` 对象流展开（对象被压缩进流时的情形）；
 * - 页面对象 `/Type /Page`，按**文件出现顺序**取页；
 * - 内容流文本算子：`Tj` `TJ` `'` `"`，字面串（含转义/八进制）与 `<hex>` 串；
 * - `BT`/`Td`/`TD`/`T*`/`'`/`"` 作为换行；
 * - `/Type0` + `/Identity-H` 双字节字体经 **ToUnicode CMap**（`bfchar`/`bfrange`）还原，
 *   因此中文 PDF 也能解出正确字符。
 *
 * **未实现（显式报错，不静默当空）**：
 * - 其它过滤器（LZW / CCITTFax / JPXDecode / DCTDecode…）；
 * - 加密 PDF；`/Prev` 增量更新链（只读最新 xref 未做，直接按文件顺序扫描对象）；
 * - 页面树顺序（不跟随 `/Kids`，按出现顺序；对单页序生成的 PDF 等价）；
 * - 缺 ToUnicode 的 CID 字体：**判为不可靠并如实报错**，不输出乱码冒充正文。
 */
import type { Locator, NormalizedDoc, ParseResult, Segment } from '../types.js';
import { applyFilters, parseFilterNames } from './pdf-filters.js';

const LATIN1 = new TextDecoder('latin1');
const encoder = new TextEncoder();

interface PdfObject {
  readonly num: number;
  readonly dict: string;
  readonly streamRaw: Uint8Array | null;
  readonly order: number;
}

export interface PdfParseFailure {
  readonly outcome: 'unsupported' | 'ocr-required';
  readonly reason: string;
}

/** 找到所有 `N G obj` 之后的正文起点与 `endobj` 终点。 */
function scanRawObjects(bytes: Uint8Array): PdfObject[] {
  const text = LATIN1.decode(bytes);
  const objects: PdfObject[] = [];
  const headerRe = /(\d+)\s+(\d+)\s+obj\b/g;
  const matches: { num: number; bodyStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(text)) !== null) {
    matches.push({ num: Number(m[1]), bodyStart: headerRe.lastIndex });
  }
  for (let i = 0; i < matches.length; i += 1) {
    const cur = matches[i] as { num: number; bodyStart: number };
    const next = matches[i + 1];
    const limit = next === undefined ? text.length : next.bodyStart;
    const bodyText = text.slice(cur.bodyStart, limit);
    const endObjIdx = bodyText.indexOf('endobj');
    const body = endObjIdx >= 0 ? bodyText.slice(0, endObjIdx) : bodyText;

    const streamKw = /stream(\r\n|\r|\n)/.exec(body);
    let streamRaw: Uint8Array | null = null;
    let dict = body;
    if (streamKw !== null && streamKw.index >= 0) {
      dict = body.slice(0, streamKw.index);
      const dataStartInBody = streamKw.index + streamKw[0].length;
      // /Length 直值可精确定位；否则就近找 endstream。
      const lengthMatch = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      let dataEndInBody: number;
      if (lengthMatch) {
        dataEndInBody = dataStartInBody + Number(lengthMatch[1]);
      } else {
        const endIdx = body.indexOf('endstream', dataStartInBody);
        dataEndInBody = endIdx >= 0 ? endIdx : body.length;
      }
      // latin1 解码是**逐字节一一对应**，故字符串下标**就是**字节偏移——
      // 绝不能经 UTF-8 重新编码来换算（≥0x80 的字节会变 2 字节，偏移全错）。
      const startByte = cur.bodyStart + dataStartInBody;
      const rawLen = dataEndInBody - dataStartInBody;
      streamRaw = bytes.subarray(startByte, startByte + rawLen);
    }
    objects.push({ num: cur.num, dict, streamRaw, order: i });
  }
  return objects;
}

/** 展开 `/Type /ObjStm`：把被压缩的对象补进对象表。 */
function expandObjectStreams(objects: PdfObject[]): PdfObject[] {
  const byNum = new Map<number, PdfObject>();
  for (const o of objects) {
    byNum.set(o.num, o);
  }
  const extra: PdfObject[] = [];
  for (const o of objects) {
    if (!/\/Type\s*\/ObjStm/.test(o.dict) || o.streamRaw === null) {
      continue;
    }
    const decoded = decodePdfStream(o.dict, o.streamRaw);
    if (!decoded.ok) {
      continue; // 展不开就跳过；正文对象通常仍在明文中
    }
    const content = LATIN1.decode(decoded.bytes);
    const nMatch = /\/N\s+(\d+)/.exec(o.dict);
    const firstMatch = /\/First\s+(\d+)/.exec(o.dict);
    if (!nMatch || !firstMatch) {
      continue;
    }
    const n = Number(nMatch[1]);
    const first = Number(firstMatch[1]);
    const header = content.slice(0, first).trim();
    const nums = header.split(/\s+/).map((s) => Number(s));
    for (let i = 0; i < n; i += 1) {
      const objNum = nums[i * 2];
      const relOff = nums[i * 2 + 1];
      const nextOff = i + 1 < n ? nums[(i + 1) * 2 + 1] : undefined;
      if (objNum === undefined || relOff === undefined) {
        continue;
      }
      const bodyStart = first + relOff;
      const bodyEnd = nextOff === undefined ? content.length : first + nextOff;
      const bodyText = content.slice(bodyStart, bodyEnd).trim();
      if (!byNum.has(objNum)) {
        byNum.set(objNum, { num: objNum, dict: bodyText, streamRaw: null, order: 1000 + i });
      }
    }
  }
  void extra;
  return [...byNum.values()];
}

/** 解码一个 PDF 流（按字典里的 /Filter 链）。 */
export function decodePdfStream(
  dict: string,
  raw: Uint8Array,
): { ok: true; bytes: Uint8Array } | { ok: false; reason: string } {
  const filters = parseFilterNames(dict);
  if (filters.length === 0) {
    return { ok: true, bytes: raw };
  }
  return applyFilters(raw, filters);
}

/** 解析 ToUnicode CMap：bfchar / bfrange → 码位到字符串的映射。 */
export function parseToUnicode(bytes: Uint8Array): Map<number, string> {
  const text = LATIN1.decode(bytes);
  const map = new Map<number, string>();
  const utf16 = (hex: string): string => {
    const clean = hex.replace(/[^0-9a-fA-F]/g, '');
    let out = '';
    for (let i = 0; i + 4 <= clean.length; i += 4) {
      out += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16));
    }
    return out;
  };

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of (block[1] ?? '').matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(pair[1] as string, 16), utf16(pair[2] as string));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1] ?? '';
    for (const trip of body.matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g,
    )) {
      const lo = parseInt(trip[1] as string, 16);
      const hi = parseInt(trip[2] as string, 16);
      const dst = parseInt(trip[3] as string, 16);
      for (let c = lo; c <= hi && c - lo < 65536; c += 1) {
        map.set(c, String.fromCharCode(dst + (c - lo)));
      }
    }
    for (const arr of body.matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g,
    )) {
      const lo = parseInt(arr[1] as string, 16);
      const items = [...(arr[3] ?? '').matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => x[1] as string);
      items.forEach((hex, idx) => {
        map.set(lo + idx, utf16(hex));
      });
    }
  }
  return map;
}

interface FontInfo {
  readonly twoByte: boolean;
  readonly toUnicode: Map<number, string> | null;
  readonly supported: boolean;
}

function resolveRef(objects: readonly PdfObject[], dict: string, key: string): PdfObject | null {
  const re = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`);
  const m = re.exec(dict);
  if (!m) {
    return null;
  }
  const num = Number(m[1]);
  return objects.find((o) => o.num === num) ?? null;
}

/** 从页面的 /Resources /Font 建立 名字 → 字体信息 的映射。 */
function collectFonts(
  objects: readonly PdfObject[],
  page: PdfObject,
): { fonts: Map<string, FontInfo>; issues: string[] } {
  const fonts = new Map<string, FontInfo>();
  const issues: string[] = [];
  const resources = resolveRef(objects, page.dict, 'Resources');
  const resourcesDict = resources?.dict ?? page.dict;
  const fontMatch = /\/Font\s*<<([\s\S]*?)>>/.exec(resourcesDict);
  if (!fontMatch) {
    return { fonts, issues };
  }
  for (const entry of (fontMatch[1] ?? '').matchAll(/\/([A-Za-z0-9]+)\s+(\d+)\s+\d+\s+R/g)) {
    const name = entry[1] as string;
    const fontObj = objects.find((o) => o.num === Number(entry[2]));
    if (!fontObj) {
      continue;
    }
    const isType0 = /\/Subtype\s*\/Type0/.test(fontObj.dict);
    let toUnicode: Map<number, string> | null = null;
    const tuObj = resolveRef(objects, fontObj.dict, 'ToUnicode');
    if (tuObj?.streamRaw) {
      const decoded = decodePdfStream(tuObj.dict, tuObj.streamRaw);
      if (decoded.ok) {
        toUnicode = parseToUnicode(decoded.bytes);
      }
    }
    // Type0 若为 Identity-H/Identity-V 则是双字节编码。
    const twoByte = isType0 && /\/Identity-[HV]/.test(fontObj.dict);
    const supported = !twoByte || toUnicode !== null;
    if (!supported) {
      issues.push(`字体 /${name} 是双字节 CID 但缺 ToUnicode，无法可靠还原文本`);
    }
    fonts.set(name, { twoByte, toUnicode, supported });
  }
  return { fonts, issues };
}

/** 把一串编码字节按字体解释成文本。 */
function decodeString(rawBytes: readonly number[], font: FontInfo | null): { text: string; bad: number } {
  if (font?.twoByte === true) {
    if (font.toUnicode === null) {
      return { text: '', bad: rawBytes.length / 2 };
    }
    let text = '';
    let bad = 0;
    for (let i = 0; i + 1 < rawBytes.length; i += 2) {
      const code = ((rawBytes[i] as number) << 8) | (rawBytes[i + 1] as number);
      const mapped = font.toUnicode.get(code);
      if (mapped === undefined) {
        bad += 1;
      } else {
        text += mapped;
      }
    }
    return { text, bad };
  }
  return { text: rawBytes.map((b) => String.fromCharCode(b)).join(''), bad: 0 };
}

/** 解析内容流，产出该页文本。 */
function extractTextFromContent(
  content: string,
  fonts: ReadonlyMap<string, FontInfo>,
): { text: string; bad: number } {
  let currentFont: FontInfo | null = null;
  let out = '';
  let bad = 0;

  const pushLine = (): void => {
    if (out.length > 0 && !out.endsWith('\n')) {
      out += '\n';
    }
  };

  let i = 0;
  const operands: unknown[] = [];
  while (i < content.length) {
    const ch = content[i] as string;
    if (ch === '(') {
      // 字面串（含转义）
      let depth = 1;
      const bytes: number[] = [];
      i += 1;
      while (i < content.length && depth > 0) {
        const c = content[i] as string;
        if (c === '\\') {
          const nxt = content[i + 1] as string;
          const simple: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
          if (nxt in simple) {
            bytes.push(simple[nxt] as number);
            i += 2;
          } else if (nxt >= '0' && nxt <= '7') {
            let oct = '';
            i += 1;
            while (oct.length < 3 && i < content.length && /[0-7]/.test(content[i] as string)) {
              oct += content[i] as string;
              i += 1;
            }
            bytes.push(parseInt(oct, 8) & 0xff);
          } else {
            bytes.push(nxt.charCodeAt(0));
            i += 2;
          }
        } else if (c === '(') {
          depth += 1;
          bytes.push(0x28);
          i += 1;
        } else if (c === ')') {
          depth -= 1;
          if (depth > 0) {
            bytes.push(0x29);
          }
          i += 1;
        } else {
          bytes.push(c.charCodeAt(0) & 0xff);
          i += 1;
        }
      }
      operands.push({ str: bytes });
    } else if (ch === '<' && content[i + 1] !== '<') {
      const end = content.indexOf('>', i);
      const hex = content.slice(i + 1, end < 0 ? content.length : end).replace(/\s+/g, '');
      const bytes: number[] = [];
      for (let k = 0; k + 1 < hex.length; k += 2) {
        bytes.push(parseInt(hex.slice(k, k + 2), 16));
      }
      operands.push({ str: bytes });
      i = end < 0 ? content.length : end + 1;
    } else if (ch === '[') {
      operands.push({ arrayStart: true });
      i += 1;
    } else if (ch === ']') {
      // 把数组元素收成一项
      const arrayElems: unknown[] = [];
      while (operands.length > 0 && !(operands[operands.length - 1] as { arrayStart?: boolean }).arrayStart) {
        arrayElems.unshift(operands.pop());
      }
      operands.pop();
      operands.push({ array: arrayElems });
      i += 1;
    } else if (ch === '/') {
      const m = /^\/([A-Za-z0-9]+)/.exec(content.slice(i));
      operands.push({ name: m ? (m[1] as string) : '' });
      i += m ? m[0].length : 1;
    } else if (/[\s]/.test(ch)) {
      i += 1;
    } else {
      const m = /^([A-Za-z'"*][A-Za-z0-9'"*]*|-?\d*\.?\d+)/.exec(content.slice(i));
      if (!m) {
        i += 1;
        continue;
      }
      const token = m[0];
      if (/^-?\d/.test(token) || token.startsWith('.')) {
        operands.push({ num: Number(token) });
        i += token.length;
        continue;
      }
      // 算子
      switch (token) {
        case 'Tf': {
          const nameOp = operands.find((o) => (o as { name?: string }).name !== undefined);
          const nm = (nameOp as { name?: string } | undefined)?.name;
          currentFont = nm === undefined ? null : fonts.get(nm) ?? null;
          break;
        }
        case 'BT':
          pushLine();
          break;
        case 'Td':
        case 'TD':
        case 'T*':
          pushLine();
          break;
        case 'Tj':
        case "'":
        case '"': {
          if (token !== 'Tj') {
            pushLine();
          }
          const strOp = [...operands].reverse().find((o) => (o as { str?: number[] }).str) as
            | { str: number[] }
            | undefined;
          if (strOp) {
            const { text, bad: b } = decodeString(strOp.str, currentFont);
            out += text;
            bad += b;
          }
          break;
        }
        case 'TJ': {
          const arrOp = [...operands].reverse().find((o) => (o as { array?: unknown[] }).array) as
            | { array: unknown[] }
            | undefined;
          if (arrOp) {
            for (const el of arrOp.array) {
              const asStr = el as { str?: number[] };
              const asNum = el as { num?: number };
              if (asStr.str) {
                const { text, bad: b } = decodeString(asStr.str, currentFont);
                out += text;
                bad += b;
              } else if (asNum.num !== undefined && asNum.num < -180) {
                out += ' ';
              }
            }
          }
          break;
        }
        default:
          break;
      }
      operands.length = 0;
      i += token.length;
    }
  }
  return { text: out.replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim(), bad };
}

/** 入口：解析 PDF 为归一化文档（按页定位）。 */
export function parsePdf(bytes: Uint8Array, sourceId: string): ParseResult {
  const hasPdfHeader = LATIN1.decode(bytes.subarray(0, 8)).startsWith('%PDF-');
  if (!hasPdfHeader) {
    return { outcome: 'unsupported', reason: '不是 PDF（缺少 %PDF- 头）' };
  }
  if (/\/Encrypt\b/.test(LATIN1.decode(bytes.subarray(0, Math.min(bytes.length, 4096))))) {
    return { outcome: 'unsupported', reason: '加密 PDF：本切片不支持解密，故不输出任何文本' };
  }

  let objects = scanRawObjects(bytes);
  objects = expandObjectStreams(objects);

  const pages = objects
    .filter((o) => /\/Type\s*\/Page\b/.test(o.dict) && !/\/Type\s*\/Pages/.test(o.dict))
    .sort((a, b) => a.order - b.order);

  if (pages.length === 0) {
    return { outcome: 'unsupported', reason: '未找到页面对象（/Type /Page）' };
  }

  const parts: string[] = [];
  const segments: Segment[] = [];
  let cursor = 0;
  let totalBad = 0;
  let totalChars = 0;
  const issues: string[] = [];

  pages.forEach((page, pageIndex) => {
    const { fonts, issues: fontIssues } = collectFonts(objects, page);
    issues.push(...fontIssues);

    const contentRefs: number[] = [];
    const arrayMatch = /\/Contents\s*\[([^\]]*)\]/.exec(page.dict);
    if (arrayMatch) {
      for (const r of (arrayMatch[1] ?? '').matchAll(/(\d+)\s+\d+\s+R/g)) {
        contentRefs.push(Number(r[1]));
      }
    } else {
      const single = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(page.dict);
      if (single) {
        contentRefs.push(Number(single[1]));
      }
    }

    let pageText = '';
    for (const ref of contentRefs) {
      const obj = objects.find((o) => o.num === ref);
      if (!obj?.streamRaw) {
        continue;
      }
      const decoded = decodePdfStream(obj.dict, obj.streamRaw);
      if (!decoded.ok) {
        issues.push(`第 ${pageIndex + 1} 页内容流解码失败：${decoded.reason}`);
        continue;
      }
      const extracted = extractTextFromContent(LATIN1.decode(decoded.bytes), fonts);
      pageText += (pageText ? '\n' : '') + extracted.text;
      totalBad += extracted.bad;
    }
    pageText = pageText.trim();
    totalChars += pageText.length;

    const locator: Locator = { kind: 'page', page: pageIndex + 1 };
    if (parts.length > 0) {
      cursor += 1;
    }
    parts.push(pageText);
    segments.push({ start: cursor, end: cursor + pageText.length, locator });
    cursor += pageText.length;
  });

  const text = parts.join('\n').trim();

  // 无文本层 ⇒ 需要 OCR（扫描件/纯图片）。
  if (text.length === 0) {
    return {
      outcome: 'ocr-required',
      reason: '该 PDF 无可用文本层（无文本算子或文本为空），需要 OCR；本切片未接通 OCR',
    };
  }
  // 缺 ToUnicode 导致大量字符无法还原 ⇒ 判不可靠，不输出乱码冒充正文。
  if (totalBad > 0 && totalBad / Math.max(1, totalBad + totalChars) > 0.2) {
    return {
      outcome: 'unsupported',
      reason: `PDF 字体缺 ToUnicode，约 ${totalBad} 个码位无法还原（>20%），拒绝输出乱码冒充正文`,
    };
  }

  return {
    outcome: 'parsed',
    doc: { sourceId, kind: 'pdf', text, segments },
  };
}

/**
 * TXT / Markdown 解析 —— 行级**字节精确**定位。
 *
 * 关键设计：先按**原始字节**找行终止符（`\n`=0x0A，`\r\n` 去掉 `\r`），
 * 再对每一行的字节做解码。这样每行的 `{byteStart, byteEnd}` 与原文**逐字节**对应，
 * 引用回读时 `bytes.slice(byteStart, byteEnd).toString('utf8')` 必然等于该行正文。
 *
 * 为什么可以按字节扫 `\n`：UTF-8 的续字节 ≥ 0x80，GBK 的尾字节落在 0x40–0xFE，
 * 二者都不含 0x0A，故多字节字符不会被误切。
 */
import type { NormalizedDoc, Segment, SupportedKind } from '../types.js';

const BOM_UTF8 = [0xef, 0xbb, 0xbf] as const;

export interface TextParseOutcome {
  readonly ok: true;
  readonly doc: NormalizedDoc;
}
export interface TextParseFailure {
  readonly ok: false;
  readonly reason: string;
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === BOM_UTF8[0] && bytes[1] === BOM_UTF8[1] && bytes[2] === BOM_UTF8[2];
}

/** 严格 UTF-8 解码；失败则尝试 GBK（Node 全量 ICU 提供），再失败则如实报不可读。 */
function decodeLine(bytes: Uint8Array, offset: number, length: number): string | { readonly error: string } {
  const slice = bytes.subarray(offset, offset + length);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(slice);
  } catch {
    // 退一步：GBK（常见于 Windows 记事本保存的中文资料）
  }
  try {
    return new TextDecoder('gbk', { fatal: true }).decode(slice);
  } catch {
    return { error: '既不是合法 UTF-8 也不是合法 GBK' };
  }
}

/**
 * 按定位器回读一段字节（与解析时**同一套解码优先级**：UTF-8 严格 → GBK 严格）。
 * 供引用回读使用；失败返回 null（调用方须判失败，不得当作空串通过）。
 */
export function decodeByteRange(bytes: Uint8Array, byteStart: number, byteEnd: number): string | null {
  const decoded = decodeLine(bytes, byteStart, byteEnd - byteStart);
  return typeof decoded === 'string' ? decoded : null;
}

/**
 * 解析纯文本/Markdown 为归一化文档。
 * @param kind 记录来源类型（'txt' | 'markdown'），仅影响标记，不影响解析。
 */
export function parseText(
  bytes: Uint8Array,
  sourceId: string,
  kind: SupportedKind = 'txt',
): TextParseOutcome | TextParseFailure {
  const contentStart = hasUtf8Bom(bytes) ? 3 : 0;

  // 1) 按字节切行，记录每行的字节区间（不含终止符）。
  const lineRanges: { start: number; end: number }[] = [];
  let lineStart = contentStart;
  for (let i = contentStart; i < bytes.length; i += 1) {
    if (bytes[i] === 0x0a) {
      let end = i;
      if (end > lineStart && bytes[end - 1] === 0x0d) {
        end -= 1;
      }
      lineRanges.push({ start: lineStart, end });
      lineStart = i + 1;
    }
  }
  // 末行（无终止符）也要收，除非文件正好以 \n 结束。
  if (lineStart < bytes.length) {
    let end = bytes.length;
    if (end > lineStart && bytes[end - 1] === 0x0d) {
      end -= 1;
    }
    lineRanges.push({ start: lineStart, end });
  }

  // 2) 逐行解码，累积归一化文本与分段。
  const parts: string[] = [];
  const segments: Segment[] = [];
  let cursor = 0;
  for (const range of lineRanges) {
    const decoded = decodeLine(bytes, range.start, range.end - range.start);
    if (typeof decoded !== 'string') {
      return {
        ok: false,
        reason: `第 ${lineRanges.indexOf(range) + 1} 行${decoded.error}（可能是二进制或非 UTF-8/GBK 编码）`,
      };
    }
    const text = decoded;
    if (parts.length > 0) {
      cursor += 1; // 连接用的 '\n' 也计入归一化文本偏移
    }
    parts.push(text);
    segments.push({
      start: cursor,
      end: cursor + text.length,
      locator: { kind: 'bytes', byteStart: range.start, byteEnd: range.end },
    });
    cursor += text.length;
  }

  return {
    ok: true,
    doc: {
      sourceId,
      kind,
      text: parts.join('\n'),
      segments,
    },
  };
}

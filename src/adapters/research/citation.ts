/**
 * 引用构造与**回读核对** —— RES-05 的落点。
 *
 * 回读的定义（每种定位器语义不同，但都**精确**）：
 * - `bytes`（TXT/Markdown 行）：`decode(原文[byteStart,byteEnd)) === quote`；
 * - `paragraph`（DOCX 段落）: `documentParagraphTexts(importDocx(原文))[index] === quote`；
 * - `page`（PDF 页）：重新解析出的该页文本 `=== quote`。
 *
 * 关键：回读**重新从原始字节出发**，不信任内存里的文本；因此
 * 「引用指向不存在的片段」必然失败——这正是反例用例要钉死的。
 */
import { documentParagraphTexts } from '../../documents/model/index.js';
import { importDocx } from '../../documents/docx/index.js';
import { parsePdf } from './parse/pdf.js';
import { decodeByteRange } from './parse/text.js';
import type { Citation, CitationPart, CitationReadback, Locator, NormalizedDoc } from './types.js';

/** 从原文区间取部件（块边界与单元边界对齐，故不会切出半个单元）。 */
export function partsForRange(doc: NormalizedDoc, start: number, end: number): CitationPart[] {
  const parts: CitationPart[] = [];
  for (const segment of doc.segments) {
    if (segment.end <= start || segment.start >= end) {
      continue;
    }
    parts.push({
      locator: segment.locator,
      quote: doc.text.slice(segment.start, segment.end),
    });
  }
  return parts;
}

/** 构造一条引用。 */
export function buildCitation(doc: NormalizedDoc, sourceName: string, start: number, end: number): Citation {
  return {
    sourceId: doc.sourceId,
    sourceName,
    parts: partsForRange(doc, start, end),
  };
}

/** 回读单个部件。 */
export function readbackPart(part: CitationPart, bytes: Uint8Array): CitationReadback {
  const locator: Locator = part.locator;
  switch (locator.kind) {
    case 'bytes': {
      const fromOriginal = decodeByteRange(bytes, locator.byteStart, locator.byteEnd);
      if (fromOriginal === null) {
        return { ok: false, reason: '原文该字节区间无法解码', failingPart: part };
      }
      if (fromOriginal !== part.quote) {
        return {
          ok: false,
          reason: `原文该字节区间为 ${JSON.stringify(fromOriginal)}，与引用 ${JSON.stringify(part.quote)} 不符`,
          failingPart: part,
        };
      }
      return { ok: true, citation: { sourceId: '', sourceName: '', parts: [part] } };
    }
    case 'paragraph': {
      let paragraphs: readonly string[];
      try {
        paragraphs = documentParagraphTexts(importDocx(bytes));
      } catch (error) {
        return { ok: false, reason: `回读 DOCX 失败：${(error as Error).message}`, failingPart: part };
      }
      const actual = paragraphs[locator.index];
      if (actual === undefined) {
        return { ok: false, reason: `DOCX 不存在第 ${locator.index} 段`, failingPart: part };
      }
      if (actual !== part.quote) {
        return {
          ok: false,
          reason: `第 ${locator.index} 段为 ${JSON.stringify(actual)}，与引用 ${JSON.stringify(part.quote)} 不符`,
          failingPart: part,
        };
      }
      return { ok: true, citation: { sourceId: '', sourceName: '', parts: [part] } };
    }
    case 'page': {
      const parsed = parsePdf(bytes, 'readback');
      if (parsed.outcome !== 'parsed') {
        return { ok: false, reason: `回读 PDF 失败：${parsed.reason}`, failingPart: part };
      }
      const segment = parsed.doc.segments.find(
        (s) => s.locator.kind === 'page' && s.locator.page === locator.page,
      );
      if (!segment) {
        return { ok: false, reason: `PDF 不存在第 ${locator.page} 页`, failingPart: part };
      }
      const actual = parsed.doc.text.slice(segment.start, segment.end);
      if (actual !== part.quote) {
        return {
          ok: false,
          reason: `第 ${locator.page} 页文本与引用不符（引用 ${part.quote.length} 字符，原文 ${actual.length} 字符）`,
          failingPart: part,
        };
      }
      return { ok: true, citation: { sourceId: '', sourceName: '', parts: [part] } };
    }
    default:
      return { ok: false, reason: '未知定位器类型', failingPart: part };
  }
}

/** 逐部件回读一条引用；任一部件失败即整条失败。 */
export function verifyCitation(citation: Citation, bytes: Uint8Array): CitationReadback {
  if (citation.parts.length === 0) {
    return {
      ok: false,
      reason: '引用没有任何部件（空引用不得通过）',
      failingPart: { locator: { kind: 'paragraph', index: -1 }, quote: '' },
    };
  }
  for (const part of citation.parts) {
    const result = readbackPart(part, bytes);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true, citation };
}

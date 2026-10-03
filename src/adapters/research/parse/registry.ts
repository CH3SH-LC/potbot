/**
 * 格式分派 —— 按扩展名/媒体类型选择解析器。
 *
 * 铁律（RES-03 / R233）：**不把文件名当内容**。
 * 无法解析时返回 `ocr-required` 或 `unsupported` 与**具体原因**，
 * 绝不返回空文档让上层误以为"读到了但没有内容"。
 */
import type { ParseResult, SupportedKind } from '../types.js';
import { parseDocx } from './docx.js';
import { parsePdf } from './pdf.js';
import { parseText } from './text.js';

/** 由文件名与媒体类型判定格式。未知返回 null。 */
export function detectKind(name: string, mediaType: string): SupportedKind | 'image' | 'xlsx' | 'pptx' | null {
  const lower = name.toLowerCase();
  const mt = mediaType.toLowerCase();

  if (lower.endsWith('.txt') || mt === 'text/plain') {
    return 'txt';
  }
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || mt === 'text/markdown') {
    return 'markdown';
  }
  if (lower.endsWith('.pdf') || mt === 'application/pdf') {
    return 'pdf';
  }
  if (
    lower.endsWith('.docx') ||
    mt === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'docx';
  }
  if (
    lower.endsWith('.xlsx') ||
    mt === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    return 'xlsx';
  }
  if (
    lower.endsWith('.pptx') ||
    mt === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    return 'pptx';
  }
  if (/\.(png|jpe?g|webp|bmp|tiff?)$/.test(lower) || mt.startsWith('image/')) {
    return 'image';
  }
  return null;
}

/** 解析入口：按格式分派，未接通格式给显式原因。 */
export function parseSource(name: string, mediaType: string, bytes: Uint8Array, sourceId: string): ParseResult {
  const kind = detectKind(name, mediaType);
  switch (kind) {
    case 'txt':
      return toResult(parseText(bytes, sourceId, 'txt'));
    case 'markdown':
      return toResult(parseText(bytes, sourceId, 'markdown'));
    case 'pdf':
      return parsePdf(bytes, sourceId);
    case 'docx':
      return parseDocx(bytes, sourceId);
    case 'xlsx':
      return {
        outcome: 'unsupported',
        reason: 'XLSX 解析未在本次增量接通（本增量范围为 TXT/Markdown/PDF/DOCX）；见 not-ready-reasons.md',
      };
    case 'pptx':
      return {
        outcome: 'unsupported',
        reason: 'PPTX 解析未在本次增量接通（本增量范围为 TXT/Markdown/PDF/DOCX）；见 not-ready-reasons.md',
      };
    case 'image':
      return {
        outcome: 'ocr-required',
        reason: '图片/扫描件需要 OCR；本机无 OCR 引擎（tesseract 不在 PATH），本切片未接通 OCR',
      };
    default:
      return { outcome: 'unsupported', reason: `未识别的格式：name=${name} mediaType=${mediaType}` };
  }
}

function toResult(parsed: { ok: true; doc: import('../types.js').NormalizedDoc } | { ok: false; reason: string }): ParseResult {
  if (parsed.ok) {
    if (parsed.doc.text.trim().length === 0) {
      return { outcome: 'unsupported', reason: '文本层为空（文件没有可读正文）' };
    }
    return { outcome: 'parsed', doc: parsed.doc };
  }
  return { outcome: 'unsupported', reason: parsed.reason };
}

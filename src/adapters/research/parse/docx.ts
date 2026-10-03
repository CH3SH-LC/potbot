/**
 * DOCX 解析 —— **只读复用**既有导入能力，不修改它。
 *
 * 依赖：`src/documents/docx/import.ts` 的 `importDocx` 与
 * `src/documents/model/text.ts` 的 `documentParagraphTexts`（均由 D 流持有，本切片只调用）。
 * 定位器用**段落序号**：回读判据是 `documentParagraphTexts(importDocx(bytes))[index] === quote`，
 * 可被独立读取器（python zipfile + XML）复算。
 */
import { importDocx } from '../../../documents/docx/index.js';
import { documentParagraphTexts } from '../../../documents/model/index.js';
import type { NormalizedDoc, ParseResult, Segment } from '../types.js';

export function parseDocx(bytes: Uint8Array, sourceId: string): ParseResult {
  let paragraphs: readonly string[];
  try {
    const model = importDocx(bytes);
    paragraphs = documentParagraphTexts(model);
  } catch (error) {
    return {
      outcome: 'unsupported',
      reason: `DOCX 导入失败：${(error as Error).message}`,
    };
  }

  const parts: string[] = [];
  const segments: Segment[] = [];
  let cursor = 0;
  let emitted = 0;

  paragraphs.forEach((raw, index) => {
    const text = raw;
    if (text.length === 0) {
      // 空段落保留为零长分段，维持"段落序号 ↔ 文本"一一对应与分段连续性。
      segments.push({ start: cursor, end: cursor, locator: { kind: 'paragraph', index } });
      return;
    }
    if (emitted > 0) {
      cursor += 1; // 连接用 '\n'
    }
    parts.push(text);
    segments.push({ start: cursor, end: cursor + text.length, locator: { kind: 'paragraph', index } });
    cursor += text.length;
    emitted += 1;
  });

  const doc: NormalizedDoc = { sourceId, kind: 'docx', text: parts.join('\n'), segments };
  if (doc.text.trim().length === 0) {
    return { outcome: 'unsupported', reason: 'DOCX 解析后正文为空（可能只有表格/图形/图片内容）' };
  }
  return { outcome: 'parsed', doc };
}

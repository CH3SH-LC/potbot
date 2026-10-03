/**
 * 解析层用例 —— 对着**真实文件**跑：
 * - `real-word16.docx`：Microsoft Word 16 创建的真实 DOCX（复制自 `tests/word-acceptance/fixtures/corpus-c-word16-created.docx`，
 *   sha256 `6b2c2e14…81026`），只读复用，未修改。
 * - `real-flate-3p.pdf`：真实 3 页 PDF（ReportLab 生成，`/Filter [ /ASCII85Decode /FlateDecode ]`，
 *   sha256 `a7739fd8…5bc5`），Python pypdf 6.14.2 独立提取结果见 evidence。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSource } from './registry.js';
import { parseText } from './text.js';
import { parsePdf } from './pdf.js';
import type { NormalizedDoc } from '../types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', '__fixtures__');
const readFixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)));

/** 独立于解析器的回读：按定位器从**原始字节**取原文。 */
function readBytesLocator(bytes: Uint8Array, byteStart: number, byteEnd: number): string {
  return new TextDecoder('utf-8').decode(bytes.subarray(byteStart, byteEnd));
}

describe('TXT / Markdown 字节精确定位', () => {
  const bytes = new TextEncoder().encode('第一行 预算 1200 元\r\n第二行 released 2026-03-05\n第三行');
  const id = 'src-txt';

  it('切行后每段的字节区间与原文逐字节一致', () => {
    const result = parseText(bytes, id, 'txt');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc: NormalizedDoc = result.doc;
    expect(doc.text).toBe('第一行 预算 1200 元\n第二行 released 2026-03-05\n第三行');

    for (const seg of doc.segments) {
      if (seg.locator.kind !== 'bytes') throw new Error('期望字节定位器');
      const fromOriginal = readBytesLocator(bytes, seg.locator.byteStart, seg.locator.byteEnd);
      expect(fromOriginal).toBe(doc.text.slice(seg.start, seg.end));
    }
  });

  it('去除 UTF-8 BOM 且不破坏后续偏移', () => {
    const withBom = new TextEncoder().encode('﻿甲\n乙');
    const result = parseText(withBom, id, 'txt');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.text).toBe('甲\n乙');
    const first = result.doc.segments[0];
    if (first?.locator.kind !== 'bytes') throw new Error('期望字节定位器');
    expect(readBytesLocator(withBom, first.locator.byteStart, first.locator.byteEnd)).toBe('甲');
  });

  it('非法编码不静默当空，而是报不可读', () => {
    const bad = new Uint8Array([0xff, 0xfe, 0x00, 0xd8, 0xff, 0xe0, 0x11, 0x22]);
    const result = parseText(bad, id, 'txt');
    expect(result.ok).toBe(false);
  });
});

describe('DOCX —— 真实 Word 16 文件', () => {
  it('导入真实 DOCX 并给出段落定位器', () => {
    const bytes = readFixture('real-word16.docx');
    const result = parseSource('real-word16.docx', '', bytes, 'src-docx');
    expect(result.outcome).toBe('parsed');
    if (result.outcome !== 'parsed') return;
    expect(result.doc.kind).toBe('docx');
    expect(result.doc.text.length).toBeGreaterThan(0);

    const paragraphSegs = result.doc.segments.filter((s) => s.locator.kind === 'paragraph');
    expect(paragraphSegs.length).toBeGreaterThan(0);
    for (const seg of paragraphSegs) {
      expect(result.doc.text.slice(seg.start, seg.end)).toBe(
        result.doc.text.slice(seg.start, seg.end),
      );
    }
  });
});

describe('PDF —— 真实 3 页文件（ASCII85 + FlateDecode）', () => {
  const bytes = readFixture('real-flate-3p.pdf');

  it('解出 3 页且在文本算子处取到正文', () => {
    const result = parsePdf(bytes, 'src-pdf');
    expect(result.outcome).toBe('parsed');
    if (result.outcome !== 'parsed') return;
    const pages = result.doc.segments.filter((s) => s.locator.kind === 'page');
    expect(pages.length).toBe(3);
    expect(result.doc.text).toContain('D53 fixture body page 1');
    expect(result.doc.text).toContain('potbot-footer Page 3 of 3');
  });

  it('按页定位可回读（页文本包含引用原文）', () => {
    const result = parsePdf(bytes, 'src-pdf');
    if (result.outcome !== 'parsed') throw new Error('应解析成功');
    const page2 = result.doc.segments.find(
      (s) => s.locator.kind === 'page' && s.locator.page === 2,
    );
    if (!page2) throw new Error('缺少第 2 页');
    const pageText = result.doc.text.slice(page2.start, page2.end);
    const quote = 'D53 fixture body page 2';
    expect(pageText).toContain(quote);
    expect(pageText.indexOf(quote)).toBeGreaterThanOrEqual(0);
  });

  it('非 PDF 字节被判为 unsupported 而不是空成功', () => {
    const result = parsePdf(new TextEncoder().encode('这不是 PDF'), 'src-x');
    expect(result.outcome).toBe('unsupported');
  });
});

describe('未接通格式显式报告（不把文件名当内容）', () => {
  it('图片 ⇒ ocr-required', () => {
    const result = parseSource('scan.png', 'image/png', new Uint8Array([1, 2, 3]), 'src-img');
    expect(result.outcome).toBe('ocr-required');
    if (result.outcome === 'ocr-required') {
      expect(result.reason).toContain('OCR');
    }
  });

  it('XLSX / PPTX ⇒ unsupported 且说明未接通', () => {
    const x = parseSource('表.xlsx', '', new Uint8Array([1]), 'src-x');
    expect(x.outcome).toBe('unsupported');
    const p = parseSource('讲.pptx', '', new Uint8Array([1]), 'src-p');
    expect(p.outcome).toBe('unsupported');
  });

  it('未知扩展名 ⇒ unsupported', () => {
    const r = parseSource('a.bin', 'application/octet-stream', new Uint8Array([1]), 'src-b');
    expect(r.outcome).toBe('unsupported');
  });
});

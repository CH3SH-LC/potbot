/**
 * **W09 独立验证 §PDF**：纯 TS 结构读回器（`pdf-structure.ts`）对着**真实 PDF 字节**作答。
 *
 * 夹具是 `fixtures/pdf-builder.ts` 造的**语法合法、xref 偏移逐字节正确**的 PDF——
 * 不是"看起来像 PDF"的字符串。每条失败分支都由一个**可控坏**的构造命中。
 *
 * 未验证层：这不等于 Android `PdfRenderer` 的真机读回（那需要设备）；本层只回答**结构**问题。
 */

import { describe, expect, it } from 'vitest';

import { inspectPdf, readbackPdf } from '../../../../src/mobile-plugins/word/rendering/index.js';
import { buildPdf, emptyBytes, pngBytes, truncate, xrefOffsetOf } from './fixtures/pdf-builder.js';

const pdf1 = buildPdf({ pageCount: 1 });
const pdf3 = buildPdf({ pageCount: 3 });

// ---------------------------------------------------------------------------
// §A 正例：真实 PDF 被正确解析
// ---------------------------------------------------------------------------

describe('§A 真实 PDF 结构读回', () => {
  it('1 页 PDF：魔数 / 版本 / 页数 / 来源 / xref 全部正确', () => {
    const r = inspectPdf(pdf1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts.magic).toBe('%PDF-');
    expect(r.facts.version).toBe('1.4');
    expect(r.facts.hasEof).toBe(true);
    expect(r.facts.xrefAtOffset).toBe(true);
    expect(r.facts.rootRef).toBe('1 0 R');
    expect(r.facts.pageCount).toBe(1);
    expect(r.facts.pageCountSource).toBe('page-tree');
    expect(r.facts.encrypted).toBe(false);
    expect(r.facts.hasContentStreams).toBe(true);
    // startxref 与夹具自算一致
    expect(r.facts.xrefOffset).toBe(xrefOffsetOf(pdf1));
  });

  it('3 页 PDF：页树 /Count 报 3', () => {
    const r = inspectPdf(pdf3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts.pageCount).toBe(3);
    expect(r.facts.pageCountSource).toBe('page-tree');
    // trailer /Size 随之增大（对象数 = 3 页 ×2 + 3 固定）
    expect(r.facts.trailerSize).toBe(3 * 2 + 3 + 1);
  });

  it('trailer 无 /Root ⇒ 退回对象扫描档，页数来源如实标 object-scan', () => {
    const r = inspectPdf(buildPdf({ pageCount: 2, omitRootInTrailer: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts.rootRef).toBeNull();
    expect(r.facts.pageCountSource).toBe('object-scan');
    expect(r.facts.pageCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// §B 负例：每条失败分支
// ---------------------------------------------------------------------------

describe('§B 失败分支（改扩展名伪造 / 截断 / 指错 / 加密）', () => {
  it('PNG 改名 .pdf ⇒ magic_mismatch', () => {
    const r = inspectPdf(pngBytes());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.kind).toBe('magic_mismatch');
    expect(r.failure.message).toContain('%PDF-');
  });

  it('0 字节 ⇒ empty', () => {
    const r = inspectPdf(emptyBytes());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.kind).toBe('empty');
  });

  it('截断（无 %%EOF）⇒ no_eof', () => {
    const r = inspectPdf(truncate(pdf1, 60));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.kind).toBe('no_eof');
  });

  it('startxref 指错 ⇒ xref_offset_invalid', () => {
    const r = inspectPdf(buildPdf({ badXrefOffset: 17 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.kind).toBe('xref_offset_invalid');
  });

  it('带 /Encrypt ⇒ encrypted（本模块不解密）', () => {
    const r = inspectPdf(buildPdf({ encrypted: true }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.kind).toBe('encrypted');
  });
});

// ---------------------------------------------------------------------------
// §C 页数交叉核对
// ---------------------------------------------------------------------------

describe('§C 页数交叉核对（自报只是核对对象）', () => {
  it('自报 1 页、结构 1 页 ⇒ ok', () => {
    const r = readbackPdf(pdf1, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pageCountMatches).toBe(true);
    expect(r.declaredPageCount).toBe(1);
  });

  it('自报 2 页、结构 1 页 ⇒ page_count_mismatch（不采信自报）', () => {
    const r = readbackPdf(pdf1, 2);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.kind).toBe('page_count_mismatch');
  });

  it('自报 -1（不核对）⇒ ok 且 pageCountMatches=true', () => {
    const r = readbackPdf(pdf1, -1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pageCountMatches).toBe(true);
  });

  it('结构层就失败时，跨核对不再掩盖：readback 直接透传失败', () => {
    const r = readbackPdf(pngBytes(), 1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.kind).toBe('magic_mismatch');
  });
});

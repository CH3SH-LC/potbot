/**
 * **W09 独立验证 §PDF-xref 流**：`pdf-structure.ts` 对 PDF 1.5+ 交叉引用流
 * （`/Type /XRef`）与 `/Prev` 增量更新链的解析。
 *
 * 夹具在本文件内**逐字节**构造：对象表偏移、`/W` 定宽字段、`/Length`、`startxref`
 * 全部真实。它不是"看起来像 PDF"的字符串——把 startxref 指到别处、把 `/Length`
 * 写大、把 `/Encrypt` 加进字典，都会精确命中读回器的一条分支。
 *
 * 未验证层：这不等于 Android `PdfRenderer` 的读回（需设备）；也不覆盖**压缩**
 * （`/Filter`）交叉引用流/`/ObjStm` 的解码——本模块零依赖、无 zlib，那类输入退回
 * 扫描档（`xrefEntriesDecoded=false`，`pageCountSource` 如实标注）。
 */

import { describe, expect, it } from 'vitest';

import { inspectPdf, readbackPdf } from '../../../../src/mobile-plugins/word/rendering/index.js';
import { xrefOffsetOf } from './fixtures/pdf-builder.js';

// ---------------------------------------------------------------------------
// 夹具构造器（本文件私有；含 xref 流 / /Prev 增量更新 / 可控坏）
// ---------------------------------------------------------------------------

interface XrefOpts {
  readonly pageCount?: number;
  /** 'none' 造未压缩（可解）的流；'FlateDecode' 造压缩（本模块不解码）的流。 */
  readonly filter?: 'none' | 'FlateDecode';
  /** 省 `/Root`（逼读回器退回对象扫描 / 字符串扫描页树）。 */
  readonly omitRoot?: boolean;
  /** 给 `/Length` 加值（声明长度大于实到字节 ⇒ 截断）。 */
  readonly lengthDelta?: number;
  /** 物理裁掉流数据尾部 n 字节但保持 `/Length`（也是一种截断）。 */
  readonly dataCut?: number;
  /** 往 xref 流字典加 `/Encrypt`。 */
  readonly encrypt?: boolean;
}

function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** 单段 xref 流 PDF（PDF 1.5+，无经典 xref 表）。 */
function xrefStreamPdf(opts: XrefOpts = {}): Uint8Array {
  const pageCount = opts.pageCount ?? 1;
  const filter = opts.filter ?? 'none';
  const parts: string[] = [];
  let len = 0;
  const push = (s: string): void => {
    parts.push(s);
    len += s.length;
  };
  const off = new Map<number, number>();
  const stream = 'BT /F1 24 Tf 72 720 Td (Hi) Tj ET';

  push('%PDF-1.5\n');
  const pageObjs: number[] = [];
  const contentObjs: number[] = [];
  let next = 4; // 1 catalog, 2 pages, 3 font
  for (let i = 0; i < pageCount; i += 1) pageObjs.push(next++);
  for (let i = 0; i < pageCount; i += 1) contentObjs.push(next++);
  const xrefObjNum = next;
  const size = next + 1; // 对象 0..xrefObjNum

  off.set(1, len);
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  off.set(2, len);
  push(
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjs
      .map((p) => `${p} 0 R`)
      .join(' ')}] /Count ${pageCount} >>\nendobj\n`,
  );
  off.set(3, len);
  push('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  for (let i = 0; i < pageCount; i += 1) {
    const p = pageObjs[i] as number;
    const c = contentObjs[i] as number;
    off.set(p, len);
    push(`${p} 0 obj\n<< /Type /Page /Parent 2 0 R /Contents ${c} 0 R >>\nendobj\n`);
    off.set(c, len);
    push(`${c} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  }

  off.set(xrefObjNum, len);
  const raw: number[] = [];
  for (let i = 0; i < size; i += 1) {
    const o = off.get(i);
    if (i === 0 || o === undefined) raw.push(0, 0, 0, 0); // 空闲头
    else raw.push(1, (o >> 8) & 0xff, o & 0xff, 0); // type 1, 偏移, gen 0
  }
  const cut = opts.dataCut ?? 0;
  const data = raw.slice(0, raw.length - cut);
  const declared = raw.length + (opts.lengthDelta ?? 0);
  const rootPart = opts.omitRoot === true ? '' : ' /Root 1 0 R';
  const encPart = opts.encrypt === true ? ' /Encrypt 3 0 R' : '';
  const filterPart = filter === 'FlateDecode' ? ' /Filter /FlateDecode' : '';

  push(
    `${xrefObjNum} 0 obj\n<< /Type /XRef /Size ${size}${rootPart}${encPart}${filterPart} /W [1 2 1] /Length ${declared} >>\nstream\n`,
  );
  push(String.fromCharCode(...data));
  push('\nendstream\nendobj\n');
  push(`startxref\n${off.get(xrefObjNum) as number}\n%%EOF\n`);
  return asciiBytes(parts.join(''));
}

/**
 * 两段式增量更新 PDF：第一段 2 页（对象 1..7，xref 流在对象 8）；第二段把对象 2
 * 替换成「1 页」，并新增对象 9 = 新 xref 流，其 `/Prev` 指向第一段的 xref 流。
 * `startxref` → 对象 9。旧的对象 4/5（两页）**物理仍在文件里**。
 */
function incrementalXrefStreamPdf(): Uint8Array {
  const parts: string[] = [];
  let len = 0;
  const push = (s: string): void => {
    parts.push(s);
    len += s.length;
  };
  const off = new Map<number, number>();
  const stream = 'BT /F1 24 Tf 72 720 Td (Hi) Tj ET';
  const mk = (list: ReadonlyArray<readonly [number, number | null]>): number[] => {
    const out: number[] = [];
    for (const [, o] of list) {
      if (o === null) out.push(0, 0, 0, 0);
      else out.push(1, (o >> 8) & 0xff, o & 0xff, 0);
    }
    return out;
  };

  push('%PDF-1.5\n');
  off.set(1, len);
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  off.set(2, len);
  push('2 0 obj\n<< /Type /Pages /Kids [4 0 R 5 0 R] /Count 2 >>\nendobj\n');
  off.set(3, len);
  push('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  off.set(4, len);
  push('4 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>\nendobj\n');
  off.set(5, len);
  push('5 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>\nendobj\n');
  off.set(6, len);
  push(`6 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  off.set(7, len);
  push(`7 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);

  // 第一段 xref 流：对象 8，描述 0..8
  off.set(8, len);
  const size1 = 9;
  const list1: Array<[number, number | null]> = [];
  for (let i = 0; i < size1; i += 1) list1.push([i, i === 0 ? null : (off.get(i) ?? null)]);
  const data1 = mk(list1);
  push(`8 0 obj\n<< /Type /XRef /Size ${size1} /Root 1 0 R /W [1 2 1] /Length ${data1.length} >>\nstream\n`);
  push(String.fromCharCode(...data1));
  push('\nendstream\nendobj\n');
  const prevOffset = off.get(8) as number;

  // 第二段（增量更新）：替换对象 2 为「1 页」，新增对象 9 = 新 xref 流
  const offTwoNew = len;
  push('2 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n');
  const offNine = len;
  const data2 = mk([
    [0, null],
    [2, offTwoNew],
    [9, offNine],
  ]);
  push(
    `9 0 obj\n<< /Type /XRef /Size 10 /Root 1 0 R /Prev ${prevOffset} /W [1 2 1] /Index [0 1 2 1 9 1] /Length ${data2.length} >>\nstream\n`,
  );
  push(String.fromCharCode(...data2));
  push('\nendstream\nendobj\n');
  push(`startxref\n${offNine}\n%%EOF\n`);
  return asciiBytes(parts.join(''));
}

function latin1(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => String.fromCharCode(b)).join('');
}

// ---------------------------------------------------------------------------
// §A 正例：单段 xref 流被正确解析
// ---------------------------------------------------------------------------

describe('§A 交叉引用流（PDF 1.5+）正例', () => {
  it('1 页 xref 流：识别为流（非经典 xref）、页树取页、条目已解出', () => {
    const bytes = xrefStreamPdf({ pageCount: 1 });
    const r = inspectPdf(bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts.version).toBe('1.5');
    expect(r.facts.hasEof).toBe(true);
    expect(r.facts.xrefAtOffset).toBe(false); // startxref 处不是 'xref' 关键字
    expect(r.facts.xrefStream).toBe(true);
    expect(r.facts.prevChainLength).toBe(0);
    expect(r.facts.xrefEntriesDecoded).toBe(true);
    expect(r.facts.rootRef).toBe('1 0 R');
    expect(r.facts.pageCount).toBe(1);
    expect(r.facts.pageCountSource).toBe('page-tree');
    expect(r.facts.encrypted).toBe(false);
    expect(r.facts.hasContentStreams).toBe(true);
    expect(r.facts.xrefOffset).toBe(xrefOffsetOf(bytes));
  });

  it('3 页 xref 流：页树 /Count 报 3', () => {
    const r = inspectPdf(xrefStreamPdf({ pageCount: 3 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts.xrefStream).toBe(true);
    expect(r.facts.pageCount).toBe(3);
    expect(r.facts.pageCountSource).toBe('page-tree');
    // /Size = 对象 0..10：3 页 + 3 内容对象 + catalog/pages/font 3 个 + xref 流自身 1 个 + 对象 0
    expect(r.facts.trailerSize).toBe(3 + 3 + 3 + 1 + 1);
  });

  it('页数交叉核对：xref 流 PDF 自报 1 页 ⇒ ok；自报 2 页 ⇒ page_count_mismatch', () => {
    const bytes = xrefStreamPdf({ pageCount: 1 });
    const ok = readbackPdf(bytes, 1);
    expect(ok.ok).toBe(true);
    const bad = readbackPdf(bytes, 2);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.failure.kind).toBe('page_count_mismatch');
  });
});

// ---------------------------------------------------------------------------
// §B /Prev 链：增量更新按最新偏移取对象，不数被替换的旧页
// ---------------------------------------------------------------------------

describe('§B /Prev 增量更新链', () => {
  const bytes = incrementalXrefStreamPdf();

  it('沿 /Prev 跟到第一段，prevChainLength=1、条目全解出', () => {
    const r = inspectPdf(bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts.xrefStream).toBe(true);
    expect(r.facts.prevChainLength).toBe(1);
    expect(r.facts.xrefEntriesDecoded).toBe(true);
    expect(r.facts.rootRef).toBe('1 0 R');
  });

  it('页数取更新后的对象 2（/Count 1），而不是被替换的旧 /Count 2', () => {
    const r = inspectPdf(bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts.pageCount).toBe(1);
    expect(r.facts.pageCountSource).toBe('page-tree');
  });

  it('反向对照：文件里物理仍有 2 个 /Type /Page，字符串扫描会数成 2', () => {
    // 证明 §B 的 1 不是"扫描碰巧也对"——是交叉引用最新偏移路径在起作用。
    const text = latin1(bytes);
    const scanCount = (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
    expect(scanCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// §C 压缩（/Filter）xref 流：本模块不解码 ⇒ 退回扫描档，来源如实标注
// ---------------------------------------------------------------------------

describe('§C 压缩 xref 流退回扫描档（pageCountSource 诚实）', () => {
  it('FlateDecode 流 + 有 /Root：条目未解出，页树靠字符串扫描仍报 page-tree', () => {
    const r = inspectPdf(xrefStreamPdf({ pageCount: 2, filter: 'FlateDecode' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts.xrefStream).toBe(true);
    expect(r.facts.xrefEntriesDecoded).toBe(false);
    expect(r.facts.pageCount).toBe(2);
    expect(r.facts.pageCountSource).toBe('page-tree');
  });

  it('FlateDecode 流 + 无 /Root：只能对象扫描，来源标 object-scan', () => {
    const r = inspectPdf(xrefStreamPdf({ pageCount: 2, filter: 'FlateDecode', omitRoot: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts.rootRef).toBeNull();
    expect(r.facts.xrefEntriesDecoded).toBe(false);
    expect(r.facts.pageCountSource).toBe('object-scan');
    expect(r.facts.pageCount).toBe(2);
  });

  it('未压缩流但省 /Root：也如实退回对象扫描档', () => {
    const r = inspectPdf(xrefStreamPdf({ pageCount: 2, omitRoot: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts.rootRef).toBeNull();
    expect(r.facts.pageCountSource).toBe('object-scan');
    expect(r.facts.pageCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// §D 负例：截断 / 加密的 xref 流必须失败关闭（不假装解析成功）
// ---------------------------------------------------------------------------

describe('§D 坏 xref 流失败关闭', () => {
  it('/Length 声明大于实到字节（写盘少写一段）⇒ xref_stream_malformed', () => {
    const r = inspectPdf(xrefStreamPdf({ pageCount: 1, lengthDelta: 50 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.kind).toBe('xref_stream_malformed');
  });

  it('流数据物理被裁短但 /Length 未改 ⇒ 数据不足一整组条目，xref_stream_malformed', () => {
    const r = inspectPdf(xrefStreamPdf({ pageCount: 1, dataCut: 2 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.kind).toBe('xref_stream_malformed');
  });

  it('xref 流字典带 /Encrypt ⇒ encrypted（本模块不解密）', () => {
    const r = inspectPdf(xrefStreamPdf({ pageCount: 1, encrypt: true }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.kind).toBe('encrypted');
  });

  it('startxref 指向 xref 流对象头之后（字典处，非对象头也不是 xref 关键字）⇒ xref_offset_invalid', () => {
    const bytes = xrefStreamPdf({ pageCount: 1 });
    const text = latin1(bytes);
    const at = text.lastIndexOf('startxref');
    const m = /startxref\s+(\d+)/.exec(text.slice(at));
    const good = m === null ? 0 : Number.parseInt(m[1] as string, 10);
    // 对象头 'N 0 obj\n' 之后 8 字节处是字典 `<< /Type /XRef ...`，既非 'xref' 也非对象头。
    const shifted = text.slice(0, at) + `startxref\n${good + 8}\n%%EOF\n`;
    const r = inspectPdf(asciiBytes(shifted));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.kind).toBe('xref_offset_invalid');
  });
});

/**
 * **最小真实 PDF 构造器**（W09 测试夹具）。
 *
 * 产出的是**语法合法、可被真实阅读器打开**的 PDF：对象表 + `xref` 交叉引用表（偏移逐字节
 * 正确）+ `trailer` + `startxref` + `%%EOF`。它的用途是给 `pdf-structure.ts` 的读回器喂
 * **真字节**，而不是喂一段"看起来像 PDF"的字符串。
 *
 * 刻意做成"可控坏"：可省 `%%EOF`、可写错 `startxref` 偏移、可加 `/Encrypt`、可省
 * trailer 的 `/Root`——每条都可以精确命中读回器的一个失败分支。
 */

export interface PdfBuildOptions {
  readonly pageCount?: number;
  readonly version?: string;
  readonly streamPerPage?: string;
  /** 省略 `%%EOF`（造"截断"）。 */
  readonly omitEof?: boolean;
  /** 给 `startxref` 值加上一个偏移（造"xref 指错"）。 */
  readonly badXrefOffset?: number;
  /** trailer 加 `/Encrypt`（造"加密 PDF"）。 */
  readonly encrypted?: boolean;
  /** trailer 省略 `/Root`（逼读回器退回对象扫描档）。 */
  readonly omitRootInTrailer?: boolean;
}

function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** 构造一份真实 PDF 的字节。 */
export function buildPdf(options: PdfBuildOptions = {}): Uint8Array {
  const pageCount = options.pageCount ?? 1;
  const version = options.version ?? '1.4';
  const stream = options.streamPerPage ?? 'BT /F1 24 Tf 72 720 Td (Hello Potbot) Tj ET';

  const pageObjs: number[] = [];
  const contentObjs: number[] = [];
  let next = 4; // 1 catalog, 2 pages, 3 font
  for (let i = 0; i < pageCount; i += 1) pageObjs.push(next++);
  for (let i = 0; i < pageCount; i += 1) contentObjs.push(next++);
  const maxObj = next - 1;

  const bodies = new Map<number, string>();
  bodies.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pageObjs.map((p) => `${p} 0 R`).join(' ');
  bodies.set(2, `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);
  bodies.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let i = 0; i < pageCount; i += 1) {
    const p = pageObjs[i] as number;
    const c = contentObjs[i] as number;
    bodies.set(
      p,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${c} 0 R >>`,
    );
    bodies.set(c, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }

  let out = `%PDF-${version}\n`;
  const offsets = new Map<number, number>();
  for (let i = 1; i <= maxObj; i += 1) {
    offsets.set(i, out.length);
    out += `${i} 0 obj\n${bodies.get(i) ?? ''}\nendobj\n`;
  }

  const xrefOffset = out.length;
  const count = maxObj + 1;
  out += `xref\n0 ${count}\n`;
  out += '0000000000 65535 f \n';
  for (let i = 1; i <= maxObj; i += 1) {
    out += `${String(offsets.get(i) ?? 0).padStart(10, '0')} 00000 n \n`;
  }

  const rootPart = options.omitRootInTrailer ? '' : ' /Root 1 0 R';
  const encPart = options.encrypted ? ' /Encrypt 3 0 R' : '';
  out += `trailer\n<< /Size ${count}${rootPart}${encPart} >>\n`;
  out += `startxref\n${xrefOffset + (options.badXrefOffset ?? 0)}\n`;
  if (!options.omitEof) out += '%%EOF\n';

  return asciiBytes(out);
}

/** 一个真实的 PNG 头（用于"改扩展名伪造"负例）。 */
export function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
}

export function emptyBytes(): Uint8Array {
  return new Uint8Array(0);
}

/** 截断到前 n 字节。 */
export function truncate(bytes: Uint8Array, n: number): Uint8Array {
  return bytes.subarray(0, n);
}

/** 返回对象偏移表（测试可用来断言 startxref 指向的对象编号）。 */
export function xrefOffsetOf(bytes: Uint8Array): number {
  const s = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  const at = s.lastIndexOf('startxref');
  const m = /startxref\s+(\d+)/.exec(s.slice(at));
  return m === null ? -1 : Number.parseInt(m[1] as string, 10);
}

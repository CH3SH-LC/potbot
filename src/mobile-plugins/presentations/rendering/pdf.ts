/**
 * **视觉 PDF 写入器**：把每页的**真实栅格位图**（本渲染器产出的 RGB）嵌进 PDF 的图像 XObject。
 *
 * 与 `src/presentations/export-handoff.ts` 的 `writeTextOutlinePdf`（每页只有文字）不同：
 * 这里的每张 PDF 页**画的是同一份像素缓冲**，因此图形 / 版式 / 图片 / 图表 / 叠层都随像素一起进 PDF。
 *
 * 图像经 `FlateDecode` 压缩（`zlib-store.ts` 的 stored 块 zlib 流——不依赖宿主 zlib，
 * 合同 R50.4 要求内核在手机的 JS 运行时里可跑）；页面用 `cm` 把单位方框缩放到页宽 × 页高。
 * 结构部分全为 ASCII；图像数据是二进制（位于 `stream`/`endstream` 之间，不影响 xref 偏移，
 * 因为偏移按**字节**累计）。
 */

import { zlibStoreCompress } from './zlib-store.js';

/** 一页的栅格（RGB，行优先，长度 = widthPx × heightPx × 3）。 */
export interface RasterPdfPage {
  readonly rgb: Uint8Array;
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface PdfPageSizePt {
  readonly width: number;
  readonly height: number;
}

/** 视觉 PDF 写入错误。 */
export class PdfRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfRenderError';
  }
}

function formatPt(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** 把若干栅格页写成一份视觉 PDF（每页一张嵌图）。 */
export function writeRasterPdf(pages: readonly RasterPdfPage[], sizePt: PdfPageSizePt): Buffer {
  if (pages.length === 0) {
    throw new PdfRenderError('视觉 PDF 需要至少一页栅格：不产出一个没有内容的 PDF 冒充产物');
  }
  const W = formatPt(sizePt.width);
  const H = formatPt(sizePt.height);

  // 对象编号：1 Catalog，2 Pages；第 i 页：3+3i Page，4+3i Contents，5+3i Image。
  const kids = pages.map((_unused, i) => `${String(3 + 3 * i)} 0 R`).join(' ');

  const buffers: Buffer[] = [];
  const offsets: number[] = [];
  let position = 0;

  const push = (text: string): void => {
    const buf = Buffer.from(text, 'latin1');
    buffers.push(buf);
    position += buf.length;
  };
  const pushBuffer = (buf: Buffer): void => {
    buffers.push(buf);
    position += buf.length;
  };

  push('%PDF-1.4\n');

  const addObject = (body: Buffer | string): void => {
    offsets.push(position);
    push(`${String(offsets.length)} 0 obj\n`);
    if (typeof body === 'string') push(body);
    else pushBuffer(body);
    push('\nendobj\n');
  };

  addObject('<< /Type /Catalog /Pages 2 0 R >>');
  addObject(`<< /Type /Pages /Kids [${kids}] /Count ${String(pages.length)} >>`);

  pages.forEach((page, i) => {
    const contentId = 4 + 3 * i;
    const imageId = 5 + 3 * i;
    if (page.rgb.length !== page.widthPx * page.heightPx * 3) {
      throw new PdfRenderError(`第 ${String(i + 1)} 页栅格长度与 ${String(page.widthPx)}×${String(page.heightPx)} 不符`);
    }
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    addObject(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] ` +
        `/Resources << /XObject << /Im0 ${String(imageId)} 0 R >> >> ` +
        `/Contents ${String(contentId)} 0 R >>`,
    );
    addObject(`<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`);

    const compressed = Buffer.from(zlibStoreCompress(page.rgb));
    const header =
      `<< /Type /XObject /Subtype /Image /Width ${String(page.widthPx)} /Height ${String(page.heightPx)} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${String(compressed.length)} >>\nstream\n`;
    offsets.push(position);
    push(`${String(offsets.length)} 0 obj\n`);
    push(header);
    pushBuffer(compressed);
    push('\nendstream\nendobj\n');
  });

  const xrefOffset = position;
  push(`xref\n0 ${String(offsets.length + 1)}\n0000000000 65535 f\r\n`);
  for (const offset of offsets) push(`${String(offset).padStart(10, '0')} 00000 n\r\n`);
  push(`trailer\n<< /Size ${String(offsets.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`);

  return Buffer.concat(buffers);
}

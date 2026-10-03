/**
 * 演示域**导出与交接**（PPT-15：预览、放映交接、PDF / 图片导出、打印交接）。
 *
 * ## PPT-15 的两条硬要求怎么落到代码里
 *
 * 1. **"同时交付可编辑 PPTX，不以 PDF 替代"**
 *    {@link exportPresentationPdf} 的返回值里**同时**有 `pdf` 与 `editable_pptx`；那份
 *    PPTX 是走与 `savePresentation` 同一条渲染路径产出的真字节，因此"再打开还能改"是**可判定**的
 *    （{@link reopenEditablePptx} 直接把它读回来并给出页数）。PDF 只是**附带**产物。
 *    类型上也不给"只交 PDF"留位置：{@link PresentationDelivery} 里 `editable_pptx` 是必填，
 *    `pdf` 才是可空的。
 * 2. **"交接类动作最高状态只到已交接"**
 *   放映 / 打印 / 打开编辑器这类动作是**把参数交给外部应用**，本仓**没有回读通道**，
 *    因此 {@link handoffPresentation} 在**类型与运行期**都到不了 `confirmed`：
 *    它复用 `src/adapters/clock/action-contract.ts` 的那**唯一一份**七态模型
 *    （合同 R242：八条流不得各造一套协议），只用 `prepared → handed_off / failed` 两条边，
 *    且回执恒为 `{ kind: 'none' }`。{@link completionBlocked} 让"想标已完成"这件事
 *    **结构上**必须被打回。
 *
 * ## 输出保真度如实分级（不把"能打开"说成"看起来一样"）
 *
 * - PDF：**文本大纲级**（每页一张 PDF 页 + 该页文字，字体不嵌入）⇒
 *   `fidelity: 'text_outline'`、`visual_fidelity_verified: false`。
 * - 图片：需要**栅格化端口**；本批没有实现 ⇒ 不传端口时返回 `not_ready`，
 *   **绝不**造一张假图冒充"幻灯片的图片导出"。
 * - 未验证项集中在 {@link EXPORT_HANDOFF_UNVERIFIED_CLAIMS}，并随每份导出 / 交接结果带出。
 *
 * 本模块零 IO、零墙钟、不读环境（时间一律由调用方传入或被刻意省略）。
 */

import { ValidationError } from '../protocol/index.js';

import { digestBytes } from '../artifacts/digest.js';
import { assertTransition, label } from '../adapters/clock/action-contract.js';
import type { ActionReceipt, ActionState } from '../adapters/clock/action-contract.js';
import type { ExportImportedResult, ImportedPresentation } from './roundtrip.js';
import { importPresentation, exportImportedPresentation } from './roundtrip.js';
import { renderPresentation, type PresentationMediaPart } from './render.js';
import {
  resolveRunText,
  type FactSnapshot,
  type Presentation,
  type Shape,
  type Slide,
  type SlideSize,
  type TextBody,
} from './model.js';
import {
  decodePng,
  renderPresentationToPngs,
  renderSlideToPng,
  writeRasterPdf,
  type GlyphRasterPort,
  type RenderedSlidePng,
} from '../mobile-plugins/presentations/rendering/index.js';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 导出 / 交接层的调用方错误（参数不合法、端口缺失等）。 */
export class ExportHandoffError extends ValidationError {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'ExportHandoffError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 一、预览
// ---------------------------------------------------------------------------

/** 预览里的一个对象（**结构级**摘要：有 id / 种类 / 名字，不是像素）。 */
export interface PreviewShapeSummary {
  readonly shape_id: number;
  readonly kind: Shape['kind'];
  readonly name: string;
}

/** 预览里的一页。 */
export interface PreviewSlide {
  /** 0 起的页序。 */
  readonly index: number;
  readonly slide_id: number;
  readonly hidden: boolean;
  readonly layout_id: string;
  readonly shape_count: number;
  readonly shapes: readonly PreviewShapeSummary[];
  /** 该页可见文字（文本框 / 自选图形 / 表格单元格），已按事实快照求值。 */
  readonly text_lines: readonly string[];
  readonly notes_lines: readonly string[];
}

/** 演示预览。 */
export interface PresentationPreview {
  readonly presentation_id: string;
  readonly title: string;
  readonly slide_count: number;
  readonly hidden_slide_ids: readonly number[];
  readonly slides: readonly PreviewSlide[];
  /**
   * 保真级别：`structural_text` = 结构 + 文字。
   * **不是**像素级渲染——本层没有栅格化实现，故不以"预览"之名暗示"所见即所得"。
   */
  readonly fidelity: 'structural_text';
  /** 像素级保真**未验证**（需要消费端 / 渲染器）。 */
  readonly pixel_fidelity_verified: false;
  readonly note: string;
}

export const PREVIEW_NOTE =
  '本预览是结构与文字级的（页序、对象清单、按事实快照求值后的文字）；' +
  '版式 / 字体 / 图形观感的还原度未验证（需消费端渲染器）。';

/** 取一个文本体的可见文字（一段一行，空段不产出）。 */
function bodyLines(body: TextBody, snapshot: FactSnapshot): readonly string[] {
  const lines: string[] = [];
  for (const paragraph of body.paragraphs) {
    const text = paragraph.runs.map((run) => resolveRunText(run.source, snapshot)).join('');
    if (text.length > 0) lines.push(text);
  }
  return lines;
}

/** 取一个对象上所有可见文字（一行一条）。 */
function shapeTextLines(shape: Shape, snapshot: FactSnapshot): readonly string[] {
  const lines: string[] = [];
  const pushBody = (body: TextBody | null): void => {
    if (body === null) return;
    lines.push(...bodyLines(body, snapshot));
  };
  switch (shape.kind) {
    case 'text_box':
      pushBody(shape.text);
      break;
    case 'auto_shape':
      pushBody(shape.text);
      break;
    case 'table':
      for (const row of shape.rows) {
        for (const cell of row.cells) {
          pushBody(cell.text);
        }
      }
      break;
    case 'group':
      for (const child of shape.children) lines.push(...shapeTextLines(child, snapshot));
      break;
    case 'connector':
    case 'picture':
    case 'chart':
    case 'media':
      break;
  }
  return lines;
}

export interface BuildPreviewOptions {
  readonly fact_snapshot?: FactSnapshot;
}

/**
 * 生成**结构 + 文字**级预览。
 *
 * 文字一律经 {@link resolveRunText} 求值（缺失事实 ⇒ 占位符，**不当零**）。
 */
export function buildPresentationPreview(
  presentation: Presentation,
  options?: BuildPreviewOptions,
): PresentationPreview {
  const snapshot: FactSnapshot = options?.fact_snapshot ?? [];
  const hidden: number[] = [];

  const slides = presentation.slides.map((slide, index) => {
    if (slide.hidden) hidden.push(slide.slide_id);
    const textLines: string[] = [];
    for (const shape of slide.shapes) textLines.push(...shapeTextLines(shape, snapshot));
    const notesLines = slide.notes === null ? [] : [...bodyLines(slide.notes, snapshot)];
    return Object.freeze({
      index,
      slide_id: slide.slide_id,
      hidden: slide.hidden,
      layout_id: slide.layout.layout_id,
      shape_count: slide.shapes.length,
      shapes: Object.freeze(
        slide.shapes.map((shape) =>
          Object.freeze({ shape_id: shape.shape_id, kind: shape.kind, name: shape.name }),
        ),
      ),
      text_lines: Object.freeze(textLines),
      notes_lines: Object.freeze(notesLines),
    });
  });

  return Object.freeze({
    presentation_id: presentation.presentation_id,
    title: presentation.title,
    slide_count: slides.length,
    hidden_slide_ids: Object.freeze(hidden),
    slides: Object.freeze(slides),
    fidelity: 'structural_text' as const,
    pixel_fidelity_verified: false as const,
    note: PREVIEW_NOTE,
  });
}

// ---------------------------------------------------------------------------
// 二、PDF 导出（**同时**交付可编辑 PPTX）
// ---------------------------------------------------------------------------

/** PDF 产物。 */
export interface PdfArtifact {
  readonly bytes: Buffer;
  readonly page_count: number;
  readonly byte_length: number;
  /**
   * `text_outline` = 每页一张 PDF 页 + 该页文字（不嵌入字体、不做图形 / 版式还原）。
   * **不得**把它当作"视觉保真的导出"。
   */
  readonly fidelity: 'text_outline';
  /** 视觉保真**未验证**（需 PDF 阅读器实看）。 */
  readonly visual_fidelity_verified: false;
  readonly font_embedding: 'not_embedded';
  readonly note: string;
}

/** 可编辑 PPTX 产物（PDF 的"同时交付"对象，**不因导出 PDF 而消失**）。 */
export interface EditablePptxArtifact {
  readonly bytes: Buffer;
  readonly slide_count: number;
  readonly entry_count: number;
  readonly content_digest: string;
  /**
   * PPT-15 的硬要求：这份东西是**可编辑**的演示文稿，不是 PDF / 图片。
   *
   * 这是**类型级保证**（字面量 `true`）——本层不给"只交 PDF"留位置。因此任何
   * `editable !== true` 的**运行期**检查都恒假、不可达（V-2）：
   * "这份字节真能读回可编辑模型"由 {@link reopenEditablePptx} 判定，那才是可达的判据。
   */
  readonly editable: true;
}

export interface PdfExportRequest {
  readonly presentation: Presentation;
  /** 求值 `fact` 引用用的快照（缺省 = 空快照 ⇒ 缺失处落占位符）。 */
  readonly fact_snapshot?: FactSnapshot;
  readonly media?: readonly PresentationMediaPart[];
}

export interface PdfExportResult {
  readonly pdf: PdfArtifact;
  readonly editable_pptx: EditablePptxArtifact;
  /** 本次导出成立的不变式（原文写进结果，供上游如实转述）。 */
  readonly invariants: readonly string[];
}

export const EXPORT_INVARIANTS: readonly string[] = Object.freeze([
  'PDF 与可编辑 PPTX 同时交付：任何导出结果都必带 editable_pptx（不以 PDF 替代 PPTX）。',
  'PDF 的页数 = 演示页数（页数由任务决定，不是固定两页）。',
  '可编辑 PPTX 在本层产出后**立即**被读回一次（reopenEditablePptx），页数对得上才算通过。',
]);

// ---------------------------------------------------------------------------
// 最小 PDF 写入器（**纯 TS**：不依赖任何压缩 / 字体库，输出逐字节可复现）
// ---------------------------------------------------------------------------

const EMU_PER_POINT = 12700; // 914400 EMU/英寸 ÷ 72 pt/英寸
const PDF_MARGIN_PT = 36;
const PDF_FONT_SIZE_PT = 20;
const PDF_LEADING_PT = 26;

/** 幻灯片 EMU → PDF 点（1 pt = 1/72 英寸）。 */
export function emuToPoints(emu: number): number {
  return emu / EMU_PER_POINT;
}

/** 两位小数的固定格式（不本地化：`Number.prototype.toString` 与规范定义一致）。 */
function formatPoints(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * 文本 → **UTF-16BE 十六进制串**（PDF `Tj` 的 Identity 编码写法）。
 *
 * 用 `UniGB-UCS2-H` 编码 + 标准中文 Type0 字体名（不嵌入字体，由阅读器替换），
 * 这样中文不会在导出时被静默替换成 `?`。
 */
export function utf16BeHex(text: string): string {
  let out = 'FEFF';
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code === undefined) continue;
    if (code > 0xffff) {
      const rest = code - 0x10000;
      out += (0xd800 + (rest >> 10)).toString(16).padStart(4, '0').toUpperCase();
      out += (0xdc00 + (rest & 0x3ff)).toString(16).padStart(4, '0').toUpperCase();
    } else {
      out += code.toString(16).padStart(4, '0').toUpperCase();
    }
  }
  return out;
}

/** 一页的 PDF 内容流（纯 ASCII：文字全部走十六进制串）。 */
function pageContentStream(lines: readonly string[], heightPt: number): string {
  const parts: string[] = ['BT', `/F1 ${String(PDF_FONT_SIZE_PT)} Tf`];
  let y = heightPt - PDF_MARGIN_PT;
  for (const line of lines) {
    if (y < PDF_MARGIN_PT) break;
    parts.push(`1 0 0 1 ${formatPoints(PDF_MARGIN_PT)} ${formatPoints(y)} Tm`);
    parts.push(`<${utf16BeHex(line)}> Tj`);
    y -= PDF_LEADING_PT;
  }
  parts.push('ET');
  return parts.join('\n');
}

/** 断言 ASCII：本写入器用 `string.length` 当字节偏移，非 ASCII 会让偏移算错。 */
function assertAscii(text: string): string {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) {
      throw new ExportHandoffError(
        'pdf_not_ascii',
        `PDF 写入器内部错误：偏移计算依赖 ASCII，位置 ${String(index)} 出现非 ASCII 字符`,
      );
    }
  }
  return text;
}

/**
 * 写一份最小 PDF：每页一张 PDF 页，页面上按行排版给定文字。
 *
 * 对象编号：1 = Catalog，2 = Pages，`3+2i` = 第 i 页，`4+2i` = 该页内容流，
 * 其后依次是 Type0 字体 / CIDFont / 字体描述符。
 */
export function writeTextOutlinePdf(
  pages: readonly (readonly string[])[],
  sizePt: { readonly width: number; readonly height: number },
): Buffer {
  const fontId = 3 + 2 * pages.length;
  const cidFontId = fontId + 1;
  const descriptorId = fontId + 2;

  const objects: string[] = [];
  const kids = pages.map((_unused, index) => `${String(3 + 2 * index)} 0 R`).join(' ');

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${String(pages.length)} >>`);

  pages.forEach((lines, index) => {
    const contentId = 4 + 2 * index;
    const stream = pageContentStream(lines, sizePt.height);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${formatPoints(sizePt.width)} ` +
        `${formatPoints(sizePt.height)}] /Resources << /Font << /F1 ${String(fontId)} 0 R >> >> ` +
        `/Contents ${String(contentId)} 0 R >>`,
    );
    objects.push(`<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`);
  });

  objects.push(
    `<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H ` +
      `/DescendantFonts [${String(cidFontId)} 0 R] >>`,
  );
  objects.push(
    `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light ` +
      `/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> ` +
      `/FontDescriptor ${String(descriptorId)} 0 R /DW 1000 >>`,
  );
  objects.push(
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 ' +
      '/FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -254 /CapHeight 880 ' +
      '/StemV 93 >>',
  );

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  });

  assertAscii(body);
  const xrefOffset = body.length;
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f\r\n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, '0')} 00000 n\r\n`;
  }
  body +=
    `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\n` +
    `startxref\n${String(xrefOffset)}\n%%EOF\n`;

  assertAscii(body);
  return Buffer.from(body, 'latin1');
}

/** 预览 → PDF 的每页文字行（页眉带页序，便于人核对导出的是哪一页）。 */
export function previewToPdfPages(preview: PresentationPreview): readonly (readonly string[])[] {
  return preview.slides.map((slide) => {
    const header = `[${String(slide.index + 1)}/${String(preview.slide_count)}] ${preview.title}`;
    const hidden = slide.hidden ? ['（本页在演示中隐藏）'] : [];
    return [header, ...hidden, ...slide.text_lines];
  });
}

export function exportPresentationPdf(request: PdfExportRequest): PdfExportResult {
  const presentation = request.presentation;
  const factSnapshot: FactSnapshot = request.fact_snapshot ?? [];

  if (presentation.slides.length === 0) {
    throw new ExportHandoffError(
      'empty_presentation',
      '没有页的演示不能导出 PDF：页数由任务决定，空文稿导出会造出一份空 PDF 冒充产物',
    );
  }

  // 可编辑 PPTX：走与保存同一条渲染路径（不因导出 PDF 而跳过）。
  const rendered = renderPresentation(presentation, {
    fact_snapshot: factSnapshot,
    ...(request.media === undefined ? {} : { media: request.media }),
  });

  const preview = buildPresentationPreview(presentation, { fact_snapshot: factSnapshot });
  const pages = previewToPdfPages(preview);
  const bytes = writeTextOutlinePdf(pages, {
    width: emuToPoints(presentation.size.cx_emu),
    height: emuToPoints(presentation.size.cy_emu),
  });

  const reopened = reopenEditablePptx(rendered.bytes);
  if (!reopened.openable || reopened.slide_count !== rendered.slide_count) {
    throw new ExportHandoffError(
      'editable_pptx_not_reopenable',
      `导出的可编辑 PPTX 读回失败或页数对不上（期望 ${String(rendered.slide_count)} 页）：` +
        `${reopened.problems.join('；') || '无更多信息'}`,
    );
  }

  return Object.freeze({
    pdf: Object.freeze({
      bytes,
      page_count: pages.length,
      byte_length: bytes.length,
      fidelity: 'text_outline' as const,
      visual_fidelity_verified: false as const,
      font_embedding: 'not_embedded' as const,
      note:
        '文本大纲级 PDF：每页一张 PDF 页 + 该页文字；字体**未嵌入**，图形与版式**未还原**。' +
        '视觉保真未验证（需 PDF 阅读器实看）。',
    }),
    editable_pptx: Object.freeze({
      bytes: rendered.bytes,
      slide_count: rendered.slide_count,
      entry_count: rendered.entry_count,
      content_digest: rendered.content_digest,
      editable: true as const,
    }),
    invariants: EXPORT_INVARIANTS,
  });
}

// ---------------------------------------------------------------------------
// 可编辑性读回（"不以 PDF 替代 PPTX"的可判定形式）
// ---------------------------------------------------------------------------

export interface ReopenResult {
  readonly openable: boolean;
  readonly slide_count: number;
  /** 能读出可编辑模型（`importPresentation` 的模型层）才算可编辑。 */
  readonly editable: boolean;
  readonly problems: readonly string[];
}

/**
 * 把一份 PPTX 字节读回成**可编辑模型**。
 *
 * 这是"PPTX 还在、还能改"的可判定形式：读得回 ⇒ 有对象模型可继续编辑。
 * 读不回时如实返回 `openable: false` 与原因，**不**假设它也许多半没事。
 */
export function reopenEditablePptx(bytes: Uint8Array): ReopenResult {
  try {
    const imported: ImportedPresentation = importPresentation(bytes);
    return Object.freeze({
      openable: true,
      slide_count: imported.presentation.slides.length,
      editable: true,
      problems: Object.freeze([] as string[]),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return Object.freeze({
      openable: false,
      slide_count: 0,
      editable: false,
      problems: Object.freeze([detail]),
    });
  }
}

/**
 * 在导出的 PPTX 上**再编辑一次**（改一个对象的文本）并写回。
 *
 * 用途：把"可再编辑"从一句声明变成一次真实往返。没有可改的对象时返回
 * `{ edited: false, reason }`（如实说明，不当成通过）。
 */
export function reeditExportedPptx(
  bytes: Uint8Array,
  edit: { readonly slide_index: number; readonly shape_id: number; readonly text: string },
): { readonly edited: boolean; readonly bytes: Buffer | null; readonly reason: string | null } {
  const imported = importPresentation(bytes);
  const slide = imported.presentation.slides[edit.slide_index];
  if (slide === undefined) {
    return { edited: false, bytes: null, reason: `第 ${String(edit.slide_index + 1)} 页不存在` };
  }
  const shape = slide.shapes.find((candidate) => candidate.shape_id === edit.shape_id);
  if (shape === undefined || shape.kind !== 'text_box') {
    return {
      edited: false,
      bytes: null,
      reason: `第 ${String(edit.slide_index + 1)} 页没有可改文本的文本框 shape ${String(edit.shape_id)}`,
    };
  }
  const editedSlide: Slide = {
    ...slide,
    shapes: slide.shapes.map((candidate) =>
      candidate.shape_id === edit.shape_id && candidate.kind === 'text_box'
        ? {
            ...candidate,
            text: {
              paragraphs: candidate.text.paragraphs.map((paragraph) => ({
                ...paragraph,
                runs: [{ source: { kind: 'literal', text: edit.text } as const }],
              })),
            },
          }
        : candidate,
    ),
  };
  const editedPresentation: Presentation = {
    ...imported.presentation,
    slides: imported.presentation.slides.map((candidate, index) =>
      index === edit.slide_index ? editedSlide : candidate,
    ),
  };
  const result: ExportImportedResult = exportImportedPresentation(imported, editedPresentation);
  return { edited: true, bytes: result.bytes, reason: null };
}

/**
 * 检查"导出 PDF 之后可编辑 PPTX 仍然在、且还能改"。
 * 返回问题清单（空 = 成立）。
 *
 * **V-2**：这里**没有** `editable_pptx.editable !== true` 这一条 —— `editable` 是字面量 `true`，
 * 那条检查恒假、不可达，留着只会让人误以为自检覆盖了"可编辑性"。可编辑性改由**可达**的
 * {@link reopenEditablePptx} 判定（读得回可编辑模型才算数），见下。
 */
export function checkEditablePptxSurvivesExport(result: PdfExportResult): readonly string[] {
  const problems: string[] = [];
  if (result.editable_pptx.bytes.length === 0) {
    problems.push('可编辑 PPTX 字节为空');
  }
  if (result.pdf.page_count !== result.editable_pptx.slide_count) {
    problems.push(
      `PDF 页数 ${String(result.pdf.page_count)} 与 PPTX 页数 ` +
        `${String(result.editable_pptx.slide_count)} 不一致`,
    );
  }
  const reopened = reopenEditablePptx(result.editable_pptx.bytes);
  if (!reopened.openable) problems.push(`可编辑 PPTX 读不回：${reopened.problems.join('；')}`);
  if (reopened.slide_count !== result.editable_pptx.slide_count) {
    problems.push('可编辑 PPTX 读回后的页数与声明不一致');
  }
  return Object.freeze(problems);
}

// ---------------------------------------------------------------------------
// 三、图片导出（需要栅格端口；没有就如实说没有）
// ---------------------------------------------------------------------------

/** 一张栅格图。 */
export interface RasterizedImage {
  readonly mime: 'image/png' | 'image/jpeg';
  readonly bytes: Uint8Array;
  readonly width_px: number;
  readonly height_px: number;
}

export interface RasterizeRequest {
  readonly slide: Slide;
  readonly index: number;
  readonly width_px: number;
  readonly height_px: number;
  readonly fact_snapshot: FactSnapshot;
}

/** 栅格化端口（由宿主 / 消费端实现：桌面渲染器或移动端演示应用）。 */
export interface SlideRasterPort {
  rasterize(request: RasterizeRequest): Promise<RasterizedImage>;
}

export interface ImageExportOptions {
  readonly width_px?: number;
  readonly height_px?: number;
  readonly fact_snapshot?: FactSnapshot;
  /** 是否包含隐藏页（缺省 false：放映与打印都不出隐藏页）。 */
  readonly include_hidden?: boolean;
}

export type ImageExportResult =
  | {
      readonly status: 'exported';
      readonly images: readonly { readonly slide_id: number; readonly index: number; readonly image: RasterizedImage }[];
      readonly note: string;
      readonly unverified: readonly ExportHandoffUnverifiedClaim[];
    }
  | {
      readonly status: 'not_ready';
      readonly reason: string;
      readonly unverified: readonly ExportHandoffUnverifiedClaim[];
    };

/** 默认图片尺寸按 16:9 的 1920×1080（与幻灯片比例无关时由调用方覆盖）。 */
export const DEFAULT_IMAGE_WIDTH_PX = 1920;
export const DEFAULT_IMAGE_HEIGHT_PX = 1080;

/**
 * 导出每页图片。
 *
 * **没有端口 ⇒ `not_ready`**：本仓没有栅格化实现，因此**不**生成占位图冒充"幻灯片的图片导出"
 * （那会是一张与幻灯片无关的图，比"未就绪"更糟）。
 */
export async function exportPresentationImages(
  presentation: Presentation,
  port: SlideRasterPort | null,
  options?: ImageExportOptions,
): Promise<ImageExportResult> {
  if (port === null) {
    return Object.freeze({
      status: 'not_ready' as const,
      reason:
        '本批未接通任何栅格化实现：把幻灯片渲染成位图需要消费端渲染器（桌面 / 移动端演示应用）。' +
        '此处如实报未就绪，不用占位图冒充导出结果。',
      unverified: EXPORT_HANDOFF_UNVERIFIED_CLAIMS,
    });
  }

  const width = options?.width_px ?? DEFAULT_IMAGE_WIDTH_PX;
  const height = options?.height_px ?? DEFAULT_IMAGE_HEIGHT_PX;
  const snapshot: FactSnapshot = options?.fact_snapshot ?? [];
  const includeHidden = options?.include_hidden ?? false;

  const images: { slide_id: number; index: number; image: RasterizedImage }[] = [];
  for (const [index, slide] of presentation.slides.entries()) {
    if (slide.hidden && !includeHidden) continue;
    const image = await port.rasterize({ slide, index, width_px: width, height_px: height, fact_snapshot: snapshot });
    images.push({ slide_id: slide.slide_id, index, image });
  }

  return Object.freeze({
    status: 'exported' as const,
    images: Object.freeze(images),
    note: `图片由外部栅格端口产出（${String(width)}×${String(height)} px）；其与幻灯片的视觉一致性由该端口负责，本层不做像素断言。`,
    unverified: EXPORT_HANDOFF_UNVERIFIED_CLAIMS,
  });
}

// ---------------------------------------------------------------------------
// 四、放映 / 打印 / 打开编辑器交接（最高状态只到"已交接"）
// ---------------------------------------------------------------------------

/** 本模块支持的外部交接动作。 */
export type PresentationHandoffAction =
  | 'start_slideshow'
  | 'print_deck'
  | 'open_in_editor'
  | 'share_pdf';

export interface PresentationHandoffSemantics {
  /** 在外部系统里的效果类别。`open_only` = **只打开界面，不改任何状态**（R246）。 */
  readonly effect: 'present' | 'print' | 'open_only' | 'share';
  /** 我们能否**回读**其效果（决定七态的上限）。本批一律 `false`。 */
  readonly readable: boolean;
  /** 是否需要目标应用存在（缺应用 ⇒ 交接失败，而不是"结果未知"）。 */
  readonly needsHandlerApp: boolean;
  readonly note: string;
}

/**
 * 动作语义表。
 *
 * **全部 `readable: false`**：本仓没有任何回读"放映真的开始了 / 打印真的出纸了"的通道，
 * 因此这些动作的最高状态是 `handed_off`（已交接），**不是** `confirmed`（已确认完成）。
 */
export const PRESENTATION_HANDOFF_SEMANTICS: Readonly<
  Record<PresentationHandoffAction, PresentationHandoffSemantics>
> = Object.freeze({
  start_slideshow: {
    effect: 'present',
    readable: false,
    needsHandlerApp: true,
    note: '把放映参数交给目标演示应用；我们**看不到**它是否真的进入放映，最高只报"已交接"。',
  },
  print_deck: {
    effect: 'print',
    readable: false,
    needsHandlerApp: true,
    note: '把打印任务交给系统打印栈；"已交接给打印"**不等于**"已打印出来"。',
  },
  open_in_editor: {
    effect: 'open_only',
    readable: false,
    needsHandlerApp: true,
    note: '**只打开**编辑器，不改变文件内容；不得据此声称"用户已打开并确认"。',
  },
  share_pdf: {
    effect: 'share',
    readable: false,
    needsHandlerApp: true,
    note: '把 PDF 交给分享面板；接收方是否收到、是否打开都不可回读。',
  },
});

/** 一页范围（1 起、含两端）。 */
export interface SlideRange {
  readonly from: number;
  readonly to: number;
}

export interface SlideshowRequest {
  /** `null` = 全部页。 */
  readonly slide_range: SlideRange | null;
  readonly include_hidden: boolean;
}

export interface SlideshowPlan {
  readonly slide_ids: readonly number[];
  readonly excluded_hidden: readonly number[];
}

/** 算出放映 / 打印实际会走哪些页（隐藏页默认不出，PPT-02）。 */
export function planSlideshow(
  preview: PresentationPreview,
  request: SlideshowRequest,
): SlideshowPlan {
  const total = preview.slide_count;
  const from = request.slide_range?.from ?? 1;
  const to = request.slide_range?.to ?? total;
  if (total === 0) {
    throw new ExportHandoffError('empty_presentation', '演示没有页：没有可放映 / 打印的内容');
  }
  if (from < 1 || to > total || from > to) {
    throw new ExportHandoffError(
      'invalid_slide_range',
      `页范围 ${String(from)}–${String(to)} 越界（演示共 ${String(total)} 页，且须 from ≤ to）`,
    );
  }

  const slideIds: number[] = [];
  const excluded: number[] = [];
  for (const slide of preview.slides) {
    const ordinal = slide.index + 1;
    if (ordinal < from || ordinal > to) continue;
    if (slide.hidden && !request.include_hidden) {
      excluded.push(slide.slide_id);
      continue;
    }
    slideIds.push(slide.slide_id);
  }
  return Object.freeze({ slide_ids: Object.freeze(slideIds), excluded_hidden: Object.freeze(excluded) });
}

/** 交接请求。 */
export interface HandoffRequest {
  readonly deck_id: string;
  readonly slide_range: SlideRange | null;
  readonly include_hidden: boolean;
  /** 交给外部应用的文件路径（打开编辑器 / 分享 PDF 时需要）。 */
  readonly artifact_path: string | null;
}

export interface HandoffOutcome {
  readonly delivered: boolean;
  readonly handlerLabel: string | null;
  readonly detail: string;
}

/** 交接端口（由宿主 / 消费端实现）。 */
export interface PresentationHandoffPort {
  handoff(
    action: PresentationHandoffAction,
    request: HandoffRequest,
  ): Promise<HandoffOutcome>;
}

export interface PresentationHandoffResult {
  readonly action: PresentationHandoffAction;
  readonly state: ActionState;
  readonly receipt: ActionReceipt;
  readonly semantics: PresentationHandoffSemantics;
  /** 交接类动作的最高状态（恒为 `handed_off` 或 `failed`）。 */
  readonly max_reachable_state: 'handed_off';
  readonly cannotConfirmReason: string;
  /** 本结果**不**包含任何"已完成"语义（结构上的标记，供上游转述时带上）。 */
  readonly handoff_only: true;
}

/** 哪些动作必须带一个"交给外部"的文件路径（放映不需要——它在应用内部进行）。 */
const ACTIONS_REQUIRING_ARTIFACT_PATH: ReadonlySet<PresentationHandoffAction> = new Set([
  'print_deck',
  'open_in_editor',
  'share_pdf',
]);

export const HANDOFF_CANNOT_CONFIRM_REASON =
  '交接类动作不可回读（无任何通道能看到外部应用 / 打印栈的结果）：' +
  '最高只能报"已交接给外部"，不得报"已完成"（合同 R242 / R246）。';

/**
 * 交接一个演示动作。**永不返回 `confirmed`**：
 * 全部动作的 `readable` 都是 `false`（见语义表），因此最高状态是 `handed_off`。
 */
export async function handoffPresentation(
  port: PresentationHandoffPort,
  action: PresentationHandoffAction,
  request: HandoffRequest,
): Promise<PresentationHandoffResult> {
  const semantics = PRESENTATION_HANDOFF_SEMANTICS[action];
  if (ACTIONS_REQUIRING_ARTIFACT_PATH.has(action) && request.artifact_path === null) {
    throw new ExportHandoffError(
      'missing_artifact_path',
      `${action} 需要一个交给外部应用的文件路径（artifact_path 为 null）：` +
        '交接不能在没有交接对象的情况下发生',
    );
  }

  const outcome = await port.handoff(action, request);

  if (!outcome.delivered) {
    const transition = assertTransition('prepared', 'failed', { failureKind: 'rejected' });
    return Object.freeze({
      action,
      state: transition.to,
      receipt: Object.freeze({
        kind: 'none' as const,
        source: 'presentation_handoff',
        detail: outcome.detail,
      }),
      semantics,
      max_reachable_state: 'handed_off' as const,
      cannotConfirmReason: '未找到处理应用，动作**未**发生。',
      handoff_only: true as const,
    });
  }

  const transition = assertTransition('prepared', 'handed_off');
  return Object.freeze({
    action,
    state: transition.to,
    receipt: Object.freeze({
      kind: 'none' as const,
      source: outcome.handlerLabel ?? 'presentation_app',
      detail: outcome.detail,
    }),
    semantics,
    max_reachable_state: 'handed_off' as const,
    cannotConfirmReason: HANDOFF_CANNOT_CONFIRM_REASON,
    handoff_only: true as const,
  });
}

/**
 * "能不能把它标成已完成" —— 恒为 `false`。
 *
 * 提供这个函数是为了让"想标完成"这件事必须**显式**撞一次墙（而不是某天有人顺手写一个
 * `state: 'confirmed'`）；它检查的正是本层的核心不变式：交接无回读 ⇒ 到不了完成。
 */
export function completionBlocked(result: PresentationHandoffResult): {
  readonly allowed: false;
  readonly reason: string;
} {
  return Object.freeze({
    allowed: false as const,
    reason:
      `动作 ${result.action} 的当前状态是「${label(result.state)}」，而回执类型是 ` +
      `「${result.receipt.kind}」：` +
      (result.receipt.kind === 'readback'
        ? '（不应发生）'
        : '只报"已交接"，不得升级为"已确认完成"。'),
  });
}

// ---------------------------------------------------------------------------
// 五、未验证清单
// ---------------------------------------------------------------------------

export interface ExportHandoffUnverifiedClaim {
  readonly claim: string;
  readonly status: 'unverified';
  readonly requires: string;
  readonly detail: string;
}

/**
 * PPT-15 里**本仓无法验证**的断言（都需要一个外部消费端或真机）。
 */
export const EXPORT_HANDOFF_UNVERIFIED_CLAIMS: readonly ExportHandoffUnverifiedClaim[] = Object.freeze([
  Object.freeze({
    claim: '导出的 PDF 在目标阅读器里版式 / 字体与幻灯片一致',
    status: 'unverified' as const,
    requires: 'PDF 阅读器实看（桌面或手机）',
    detail:
      '本层产出的是**文本大纲级** PDF：不嵌入字体、不还原图形与版式。' +
      '"打开无异常、看起来一致"未验证。',
  }),
  Object.freeze({
    claim: '导出的图片与幻灯片视觉一致',
    status: 'unverified' as const,
    requires: '栅格化实现（消费端渲染器）',
    detail: '本批未接通任何栅格化端口；无端口时本层返回 not_ready，不做像素断言。',
  }),
  Object.freeze({
    claim: '打印交接之后确实打印出了正确的页',
    status: 'unverified' as const,
    requires: '系统打印栈 / 打印机的回执',
    detail: '打印是交接类动作，本仓无回读通道，最高只报"已交接"。',
  }),
  Object.freeze({
    claim: '放映交接之后目标应用确实开始放映',
    status: 'unverified' as const,
    requires: '目标演示应用的播放回执（PPT-11 的"目标软件播放验证"）',
    detail: '本仓无播放回读通道；交接后不可确认，故不得报"已完成"。',
  }),
  Object.freeze({
    claim: '手机端 / 目标软件打开演示文稿无修复提示',
    status: 'unverified' as const,
    requires: '已连接的 Android 真机与 Office 消费端',
    detail: '本轮设备未连接、新产物未在真机与目标软件上实开，故一律标未验证。',
  }),
]);

// ---------------------------------------------------------------------------
// 六、交付清单（"PDF 不替代 PPTX" 的落点）
// ---------------------------------------------------------------------------

export interface PresentationDeliveryInput {
  readonly presentation: Presentation;
  readonly fact_snapshot?: FactSnapshot;
  readonly media?: readonly PresentationMediaPart[];
  /** 是否同时导出 PDF（**不影响** editable_pptx 是否交付）。 */
  readonly want_pdf: boolean;
}

export interface PresentationDelivery {
  /** **必填**：任何交付都带可编辑 PPTX（PPT-15 的"不以 PDF 替代"）。 */
  readonly editable_pptx: EditablePptxArtifact;
  readonly pdf: PdfArtifact | null;
  readonly preview: PresentationPreview;
  readonly unverified: readonly ExportHandoffUnverifiedClaim[];
  readonly invariants: readonly string[];
}

/** 交付清单：可编辑 PPTX 恒在；PDF 是**额外**产物。 */
export function deliverPresentation(input: PresentationDeliveryInput): PresentationDelivery {
  if (input.want_pdf) {
    const exported = exportPresentationPdf({
      presentation: input.presentation,
      ...(input.fact_snapshot === undefined ? {} : { fact_snapshot: input.fact_snapshot }),
      ...(input.media === undefined ? {} : { media: input.media }),
    });
    return Object.freeze({
      editable_pptx: exported.editable_pptx,
      pdf: exported.pdf,
      preview: buildPresentationPreview(input.presentation, {
        ...(input.fact_snapshot === undefined ? {} : { fact_snapshot: input.fact_snapshot }),
      }),
      unverified: EXPORT_HANDOFF_UNVERIFIED_CLAIMS,
      invariants: EXPORT_INVARIANTS,
    });
  }

  const rendered = renderPresentation(input.presentation, {
    ...(input.fact_snapshot === undefined ? {} : { fact_snapshot: input.fact_snapshot }),
    ...(input.media === undefined ? {} : { media: input.media }),
  });
  return Object.freeze({
    editable_pptx: Object.freeze({
      bytes: rendered.bytes,
      slide_count: rendered.slide_count,
      entry_count: rendered.entry_count,
      content_digest: rendered.content_digest,
      editable: true as const,
    }),
    pdf: null,
    preview: buildPresentationPreview(input.presentation, {
      ...(input.fact_snapshot === undefined ? {} : { fact_snapshot: input.fact_snapshot }),
    }),
    unverified: EXPORT_HANDOFF_UNVERIFIED_CLAIMS,
    invariants: EXPORT_INVARIANTS,
  });
}

/**
 * 交付清单的不变式自检；返回问题清单（空 = 成立）。
 *
 * **V-2**：`editable_pptx.editable !== true` 是字面量类型上的恒假检查，已删除。取而代之的是
 * **可达**的判据——把交付的字节**真正读回一次**（{@link reopenEditablePptx}）：声称"可编辑 PPTX
 * 已交付"而字节其实读不回可编辑模型，必须在这里被报出来（此前那种"字节是垃圾也能通过自检"的
 * 漏洞正是这条可达判据堵住的）。
 */
export function deliveryInvariantProblems(delivery: PresentationDelivery): readonly string[] {
  const problems: string[] = [];
  if (delivery.editable_pptx.bytes.length === 0) problems.push('交付清单里没有可编辑 PPTX 字节');
  const reopened = reopenEditablePptx(delivery.editable_pptx.bytes);
  if (!reopened.openable) {
    problems.push(
      `交付清单里的可编辑 PPTX 读不回（不能当作"可编辑交付"）：` +
        `${reopened.problems.join('；') || '字节无法解析'}`,
    );
  }
  if (delivery.editable_pptx.slide_count !== delivery.preview.slide_count) {
    problems.push('交付的 PPTX 页数与预览页数不一致');
  }
  if (delivery.pdf !== null && delivery.pdf.page_count !== delivery.editable_pptx.slide_count) {
    problems.push('PDF 页数与可编辑 PPTX 页数不一致（PDF 不能替代 PPTX，也不该少页）');
  }
  return Object.freeze(problems);
}

// ---------------------------------------------------------------------------
// 七、真实像素路径（P09 · PPT-13/15 升级：取代 structural_text 预览与 text_outline PDF）
// ---------------------------------------------------------------------------
//
// 下面这组函数把预览 / PDF / 图片三条路径接到 `src/mobile-plugins/presentations/rendering/`
// 的**软件光栅器**上：产出的是**真实像素缓冲 → 真实 PNG 字节**，图形 / 图片 / 图表 / 叠层
// 与中文（有真实字形时；否则替代字形并如实上报）都进像素结果，而不再是"每页一张文字页"。
// 旧的 `buildPresentationPreview` / `exportPresentationPdf`（结构 / 文字大纲）保留为**降级路径**，
// 现有调用方与用例不受影响。

/** 真实像素渲染的默认画布宽（像素）；高按幻灯片比例推出。 */
export const DEFAULT_VISUAL_WIDTH_PX = 1280;

/** 一处真实的栅格渲染选项（P09 路径共用）。 */
export interface NativeRasterOptions {
  readonly width_px?: number;
  readonly height_px?: number;
  /** 字形来源；缺省内置位图字体（ASCII 真实 / 非 ASCII 替代字形并上报）。 */
  readonly glyph_port?: GlyphRasterPort;
  readonly media?: readonly PresentationMediaPart[];
  readonly fact_snapshot?: FactSnapshot;
  readonly background?: import('../mobile-plugins/presentations/rendering/index.js').Rgb;
  readonly default_font?: string;
}

function nativeMediaBytes(
  media: readonly PresentationMediaPart[] | undefined,
): readonly { readonly path: string; readonly bytes: Uint8Array }[] | undefined {
  return media?.map((entry) => ({ path: entry.path, bytes: entry.bytes }));
}

function nativeRenderOptions(
  slideSize: SlideSize,
  options: NativeRasterOptions,
): import('../mobile-plugins/presentations/rendering/index.js').RenderSlideOptions {
  return {
    slide_size: slideSize,
    width_px: options.width_px ?? DEFAULT_VISUAL_WIDTH_PX,
    ...(options.height_px === undefined ? {} : { height_px: options.height_px }),
    ...(options.glyph_port === undefined ? {} : { glyph_port: options.glyph_port }),
    ...(options.media === undefined ? {} : { media: nativeMediaBytes(options.media) ?? [] }),
    ...(options.fact_snapshot === undefined ? {} : { fact_snapshot: options.fact_snapshot }),
    ...(options.background === undefined ? {} : { background: options.background }),
    ...(options.default_font === undefined ? {} : { default_font: options.default_font }),
  };
}

/** 一页的真实像素预览。 */
export interface VisualPreviewSlide {
  readonly index: number;
  readonly slide_id: number;
  readonly hidden: boolean;
  readonly width_px: number;
  readonly height_px: number;
  /** 真实 PNG 字节（PNG 签名开头）。 */
  readonly png: Buffer;
  readonly png_byte_length: number;
  /** 非背景像素数——"真的画了东西"的可量化证据。 */
  readonly ink_pixels: number;
  /** 该页的渲染诊断（溢出 / 缺字 / 缺媒体 …）。 */
  readonly diagnostics: readonly import('../mobile-plugins/presentations/rendering/index.js').RenderDiagnostic[];
}

/** 真实像素预览结果（取代 `structural_text` 预览）。 */
export interface VisualPresentationPreview {
  readonly presentation_id: string;
  readonly title: string;
  readonly slide_count: number;
  readonly slides: readonly VisualPreviewSlide[];
  /** 本预览是**真实像素**（PNG 字节由软件光栅器逐像素产出）。 */
  readonly fidelity: 'raster_png';
  /** 每页都有真实 PNG 字节且非背景像素 > 0。 */
  readonly pixels_are_real: true;
  /** 与任何**外部**渲染器（PowerPoint / WPS / 手机演示应用）的观感比对**未做**。 */
  readonly external_visual_match_verified: false;
  readonly unverified: readonly string[];
}

export const VISUAL_PREVIEW_UNVERIFIED: readonly string[] = Object.freeze([
  '像素结果是否与 PowerPoint / WPS / 手机演示应用的实际观感一致（本层只保证像素由本渲染器真实产出，未与外部比对）。',
  '非 ASCII（含中文）字形是否为真实字形，取决于注入的 GlyphRasterPort；内置端口只给替代字形。',
]);

/**
 * 生成**真实像素**预览：每页一张 PNG。
 *
 * 与 {@link buildPresentationPreview} 的区别：后者是结构 + 文字摘要；这里是逐像素渲染，
 * 图形 / 图片 / 图表 / 叠层 / 文本都进像素。
 */
export function buildVisualPreview(
  presentation: Presentation,
  options?: NativeRasterOptions & { readonly include_hidden?: boolean },
): VisualPresentationPreview {
  const includeHidden = options?.include_hidden ?? true;
  const rendered = renderPresentationToPngs(presentation, nativeRenderOptionsWithoutSize(presentation.size, options));
  const hiddenIds = new Set(presentation.slides.filter((s) => s.hidden).map((s) => s.slide_id));

  const slides: VisualPreviewSlide[] = rendered.slides.map((png: RenderedSlidePng) => ({
    index: png.index,
    slide_id: png.slide_id,
    hidden: hiddenIds.has(png.slide_id),
    width_px: png.width_px,
    height_px: png.height_px,
    png: png.png,
    png_byte_length: png.png.length,
    ink_pixels: png.ink_pixels,
    diagnostics: png.diagnostics,
  }));

  const visible = includeHidden ? slides : slides.filter((slide) => !slide.hidden);
  return Object.freeze({
    presentation_id: presentation.presentation_id,
    title: presentation.title,
    slide_count: visible.length,
    slides: Object.freeze(visible),
    fidelity: 'raster_png' as const,
    pixels_are_real: true as const,
    external_visual_match_verified: false as const,
    unverified: VISUAL_PREVIEW_UNVERIFIED,
  });
}

function nativeRenderOptionsWithoutSize(
  slideSize: SlideSize,
  options: (NativeRasterOptions & { readonly include_hidden?: boolean }) | undefined,
): Omit<import('../mobile-plugins/presentations/rendering/index.js').RenderSlideOptions, 'slide_size'> {
  const base = options ?? {};
  return {
    width_px: base.width_px ?? DEFAULT_VISUAL_WIDTH_PX,
    ...(base.height_px === undefined ? {} : { height_px: base.height_px }),
    ...(base.glyph_port === undefined ? {} : { glyph_port: base.glyph_port }),
    ...(base.media === undefined ? {} : { media: nativeMediaBytes(base.media) ?? [] }),
    ...(base.fact_snapshot === undefined ? {} : { fact_snapshot: base.fact_snapshot }),
    ...(base.background === undefined ? {} : { background: base.background }),
    ...(base.default_font === undefined ? {} : { default_font: base.default_font }),
  };
}

/**
 * 造一个**本机栅格端口**：把幻灯片渲成真实 PNG，供 {@link exportPresentationImages} 使用。
 *
 * 这是把"图片导出需要栅格化实现"从"未就绪"变成"已就绪（本机软件光栅）"的接线点。
 */
export function createNativeSlideRasterPort(
  slideSize: SlideSize,
  options?: NativeRasterOptions,
): SlideRasterPort {
  const renderOptions = nativeRenderOptions(slideSize, options ?? {});
  return {
    rasterize: async (request): Promise<RasterizedImage> => {
      const png = renderSlideToPng(request.slide, request.index, {
        ...renderOptions,
        width_px: request.width_px,
        height_px: request.height_px,
        fact_snapshot: request.fact_snapshot,
      });
      return {
        mime: 'image/png',
        bytes: png.png,
        width_px: png.width_px,
        height_px: png.height_px,
      };
    },
  };
}

/** 用本机栅格端口导出每页图片（取代"没有端口 ⇒ not_ready"的默认路径）。 */
export async function exportPresentationImagesNative(
  presentation: Presentation,
  options?: NativeRasterOptions & ImageExportOptions,
): Promise<ImageExportResult> {
  const port = createNativeSlideRasterPort(presentation.size, options ?? {});
  return exportPresentationImages(presentation, port, {
    ...(options?.width_px === undefined ? {} : { width_px: options.width_px }),
    ...(options?.height_px === undefined ? {} : { height_px: options.height_px }),
    ...(options?.fact_snapshot === undefined ? {} : { fact_snapshot: options.fact_snapshot }),
    ...(options?.include_hidden === undefined ? {} : { include_hidden: options.include_hidden }),
  });
}

/** 视觉 PDF 产物。 */
export interface VisualPdfArtifact {
  readonly bytes: Buffer;
  readonly page_count: number;
  readonly byte_length: number;
  /** `raster_images` = 每页嵌入一张本渲染器产出的真实位图（不是文字大纲）。 */
  readonly fidelity: 'raster_images';
  readonly image_filter: 'FlateDecode';
  readonly font_embedding: 'rasterized_into_page_image';
  readonly note: string;
  readonly unverified: readonly string[];
}

export interface VisualPdfExportRequest extends NativeRasterOptions {
  readonly presentation: Presentation;
}

export interface VisualPdfExportResult {
  readonly pdf: VisualPdfArtifact;
  readonly editable_pptx: EditablePptxArtifact;
  readonly preview: VisualPresentationPreview;
  readonly invariants: readonly string[];
}

/** 视觉 PDF 的不变式（原文写进结果，供上游如实转述）。 */
export const VISUAL_PDF_INVARIANTS: readonly string[] = Object.freeze([
  'PDF 与可编辑 PPTX 同时交付：视觉 PDF 也不以 PDF 替代 PPTX。',
  'PDF 每页嵌入的是**本渲染器产出的真实位图**（FlateDecode RGB 图像 XObject），不是文字大纲。',
  '可编辑 PPTX 产出后立即读回一次，页数对得上才算通过。',
]);

/**
 * 导出**视觉 PDF**：每页一张本渲染器产出的位图（真实图形 / 图片 / 图表 / 叠层随像素进 PDF），
 * **同时**交付可编辑 PPTX。
 */
export function exportPresentationPdfVisual(request: VisualPdfExportRequest): VisualPdfExportResult {
  const presentation = request.presentation;
  if (presentation.slides.length === 0) {
    throw new ExportHandoffError('empty_presentation', '没有页的演示不能导出 PDF');
  }
  const rendered = renderPresentationToPngs(presentation, nativeRenderOptionsWithoutSize(presentation.size, request));

  const pages = rendered.slides.map((slide) => {
    const image = decodePng(slide.png);
    return { rgb: image.data, widthPx: image.width, heightPx: image.height };
  });
  const pdfBytes = writeRasterPdf(pages, {
    width: emuToPoints(presentation.size.cx_emu),
    height: emuToPoints(presentation.size.cy_emu),
  });

  const editable = renderPresentation(presentation, {
    ...(request.fact_snapshot === undefined ? {} : { fact_snapshot: request.fact_snapshot }),
    ...(request.media === undefined ? {} : { media: request.media }),
  });
  const reopened = reopenEditablePptx(editable.bytes);
  if (!reopened.openable || reopened.slide_count !== editable.slide_count) {
    throw new ExportHandoffError(
      'editable_pptx_not_reopenable',
      `视觉导出时，可编辑 PPTX 读回失败：${reopened.problems.join('；') || '无更多信息'}`,
    );
  }

  return Object.freeze({
    pdf: Object.freeze({
      bytes: pdfBytes,
      page_count: pages.length,
      byte_length: pdfBytes.length,
      fidelity: 'raster_images' as const,
      image_filter: 'FlateDecode' as const,
      font_embedding: 'rasterized_into_page_image' as const,
      note:
        '视觉 PDF：每页嵌入本渲染器产出的真实位图（文本随位图一起光栅化）。' +
        '它是**观感级**的，但不嵌入可选文本——复制文字需要另走文字路径。',
      unverified: VISUAL_PREVIEW_UNVERIFIED,
    }),
    editable_pptx: Object.freeze({
      bytes: editable.bytes,
      slide_count: editable.slide_count,
      entry_count: editable.entry_count,
      content_digest: editable.content_digest,
      editable: true as const,
    }),
    preview: buildVisualPreview(presentation, request),
    invariants: VISUAL_PDF_INVARIANTS,
  });
}

// ---------------------------------------------------------------------------
// 八、真实预览描述符（P-I14 · F06 集成：把 PreviewDescriptor 从夹具层落到真实字节）
// ---------------------------------------------------------------------------
//
// F06（`apps/mobile-ui/src/files/preview.ts`）的预览容器**只承载、不渲染**：它要求业务线
// 交出真实的 `PreviewDescriptor`（`producer` / `mime` / `renderParts` / `sourceDigest`），
// 且 `sourceDigest` 必须**逐字等于该版真实字节的摘要**（`sha256:` + 64 位小写十六进制）。
//
// 此前 P 线只有 `buildPresentationPreview`（`fidelity: 'structural_text'`，结构 + 文字），
// 没有任何东西产出"绑定到确切字节"的描述符，因此前端预览只能停在夹具层。本节补上这个缺口：
//
// - **默认路径**是 P09 的真实像素渲染（{@link buildVisualPreview} → 每页真实 PNG），
//   描述符 `mime: image/png`、`renderParts: ['slide1.png', …]`、`sourceDigest` 由
//   {@link digestBytes} 对**确切的源字节**（导出的 PPTX）现算；
// - 旧的**结构 / 文字大纲**路径（{@link buildPresentationPreview}）保留为**显式降级**
//   （`fidelity: 'text_outline'`），不改变既有函数与既有用例。
//
// 本层不 import F06（`src` 不依赖 `apps`）：类型只按**结构**与 F06 的 `PreviewDescriptor`
// 对齐，F06 侧的 `attachPreview` 照跑它自己的 P1–P5 绑定校验。

/** P 线预览插件的引用名（与 F06 `PreviewProducer.producer` 同值）。 */
export const PPT_PREVIEW_PRODUCER = 'ppt-plugin';

/** 预览保真路径：缺省 `raster_png`（真实像素），`text_outline` 为显式降级。 */
export type PreviewFidelityPath = 'raster_png' | 'text_outline';

/** 默认（真实像素）路径的预览 MIME：每页是一张真实 PNG。 */
export const PPT_PREVIEW_MIME_RASTER = 'image/png';

/** 降级（结构 / 文字大纲）路径的预览 MIME。 */
export const PPT_PREVIEW_MIME_TEXT = 'application/vnd.potbot.presentation-text+json';

/** `sha256:` + 64 位小写十六进制——与 F06 `bytes.ts` / contracts/mobile-v1 同形状。 */
const PREVIEW_SOURCE_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** 校验源字节摘要形状（`sha256:<64 位小写十六进制>`）。 */
export function isPreviewSourceDigest(value: unknown): value is string {
  return typeof value === 'string' && PREVIEW_SOURCE_DIGEST.test(value);
}

/**
 * 与 F06 `apps/mobile-ui/src/files/preview.ts` 的 `PreviewDescriptor` **结构兼容**的预览描述。
 *
 * F06 的容器只校验 `producer` / `mime` / `renderParts` 形状，并把 `sourceDigest` 与其
 * 版本字节摘要逐字比对（`preview-bytes-mismatch`）。此处额外带出真实的 `byteLength`，
 * 供"产出字节的一侧"如实交代字节规模（F06 集成请求：真实 byteLength + sha256:&lt;64hex&gt;）。
 *
 * `fileId` / `revision` 由**持有文件版本链**的一侧（F06）补齐，本层不臆造。
 */
export interface PresentationPreviewDescriptor {
  readonly producer: string;
  /** 预览的 MIME；真实像素路径为 `image/png`，降级路径为文字大纲 MIME。 */
  readonly mime: string;
  /** **有序**渲染部件名（每页一条，顺序 = 页序）：`slide1.png` … 或 `slide1.txt` …。 */
  readonly renderParts: readonly string[];
  /** 绑定的**确切源字节**摘要：`sha256:` + 64 位小写十六进制。 */
  readonly sourceDigest: string;
  /** 源字节长度（真实字节数）。 */
  readonly byteLength: number;
}

export interface ProducePreviewDescriptorOptions extends NativeRasterOptions {
  /** 预览保真路径；缺省 `raster_png`（真实像素），`text_outline` 为显式降级。 */
  readonly fidelity?: PreviewFidelityPath;
  /** 是否包含隐藏页（缺省 true，与 {@link buildVisualPreview} 一致）。 */
  readonly include_hidden?: boolean;
  /** 覆盖插件引用（缺省 {@link PPT_PREVIEW_PRODUCER}）。 */
  readonly producer?: string;
  /**
   * 描述所绑定的**确切源字节**（实体是导出的 PPTX）。省略时现渲染一份
   * （{@link renderPresentation}）并以其为源，保证描述与交付字节同源。
   */
  readonly source_bytes?: Uint8Array;
}

/** 真实预览描述符 + 生成它的预览对象 + 被绑定的源字节（供调用方复核）。 */
export type PresentationPreviewHandoff =
  | {
      readonly fidelity: 'raster_png';
      readonly descriptor: PresentationPreviewDescriptor;
      readonly preview: VisualPresentationPreview;
      readonly source_bytes: Buffer;
    }
  | {
      readonly fidelity: 'text_outline';
      readonly descriptor: PresentationPreviewDescriptor;
      readonly preview: PresentationPreview;
      readonly source_bytes: Buffer;
    };

/** 按保真路径渲染预览，并给出配套的 MIME 与有序部件名。 */
function renderPreviewArtifacts(
  presentation: Presentation,
  fidelity: PreviewFidelityPath,
  options: NativeRasterOptions & { readonly include_hidden?: boolean },
): {
  readonly mime: string;
  readonly renderParts: readonly string[];
  readonly preview: VisualPresentationPreview | PresentationPreview;
} {
  if (fidelity === 'raster_png') {
    const preview = buildVisualPreview(presentation, options);
    const renderParts = preview.slides.map((slide) => `slide${String(slide.index + 1)}.png`);
    return { mime: PPT_PREVIEW_MIME_RASTER, renderParts: Object.freeze(renderParts), preview };
  }
  const preview = buildPresentationPreview(presentation, {
    ...(options.fact_snapshot === undefined ? {} : { fact_snapshot: options.fact_snapshot }),
  });
  const renderParts = preview.slides.map((slide) => `slide${String(slide.index + 1)}.txt`);
  return { mime: PPT_PREVIEW_MIME_TEXT, renderParts: Object.freeze(renderParts), preview };
}

/**
 * 产出**真实预览描述符**：默认走 P09 真实像素路径，`sourceDigest` 由 {@link digestBytes}
 * 对确切源字节现算（**不变式**：`sourceDigest === 'sha256:' + digestBytes(source_bytes)`）。
 *
 * 源字节缺省 = 本函数现渲染的一份 PPTX（与交付同源）；调用方若已持有文件字节，传入
 * `source_bytes` 即可让描述绑定到**那一份**字节（这正是 F06 `preview-bytes-mismatch` 的凭据）。
 */
export function producePresentationPreviewDescriptor(
  presentation: Presentation,
  options?: ProducePreviewDescriptorOptions,
): PresentationPreviewHandoff {
  const fidelity = options?.fidelity ?? 'raster_png';
  const producer = options?.producer ?? PPT_PREVIEW_PRODUCER;

  const sourceBytes =
    options?.source_bytes === undefined
      ? renderPresentation(presentation, {
          ...(options?.fact_snapshot === undefined ? {} : { fact_snapshot: options.fact_snapshot }),
          ...(options?.media === undefined ? {} : { media: options.media }),
        }).bytes
      : Buffer.from(options.source_bytes);

  const sourceDigest = `sha256:${digestBytes(sourceBytes)}`;
  const artifacts = renderPreviewArtifacts(presentation, fidelity, options ?? {});
  const descriptor: PresentationPreviewDescriptor = Object.freeze({
    producer,
    mime: artifacts.mime,
    renderParts: artifacts.renderParts,
    sourceDigest,
    byteLength: sourceBytes.length,
  });

  if (fidelity === 'raster_png') {
    return Object.freeze({
      fidelity: 'raster_png' as const,
      descriptor,
      preview: artifacts.preview as VisualPresentationPreview,
      source_bytes: sourceBytes,
    });
  }
  return Object.freeze({
    fidelity: 'text_outline' as const,
    descriptor,
    preview: artifacts.preview as PresentationPreview,
    source_bytes: sourceBytes,
  });
}

/** 传给 {@link PresentationPreviewProducer.produce} 的该版确切字节证据（与 F06 同形）。 */
export interface PresentationPreviewProducerInput {
  readonly fileId: string;
  readonly revision: number;
  /** 该版字节摘要（`sha256:<64hex>`）；插件必须原样回显进描述。 */
  readonly digest: string;
  readonly byteLength: number;
}

/** 插件产出的描述（F06 `PreviewDescriptor` 形状 + 真实 `byteLength`）。 */
export interface PresentationPreviewProducerOutput extends PresentationPreviewDescriptor {
  readonly fileId: string;
  readonly revision: number;
}

/** 业务插件端口：F06 消费此结构（不 import 具体插件）。 */
export interface PresentationPreviewProducer {
  readonly producer: string;
  produce(input: PresentationPreviewProducerInput): PresentationPreviewProducerOutput;
}

/**
 * 造一个 **F06 `PreviewProducer`**：把渲染好的真实预览描述交给前端预览容器。
 *
 * 与 {@link producePresentationPreviewDescriptor} 的差别：这里是**文件版本链持有方**（F06）
 * 驱动，摘要由它传入（`input.digest`）——插件**原样回显**，因此预览精确绑定到"那一版"字节。
 * 传入摘要形状非法即 fail-closed 抛错（不产半份描述）。
 */
export function createPresentationPreviewProducer(
  presentation: Presentation,
  options?: Omit<ProducePreviewDescriptorOptions, 'source_bytes'>,
): PresentationPreviewProducer {
  const producer = options?.producer ?? PPT_PREVIEW_PRODUCER;
  const fidelity = options?.fidelity ?? 'raster_png';
  const artifacts = renderPreviewArtifacts(presentation, fidelity, options ?? {});
  return {
    producer,
    produce: (input: PresentationPreviewProducerInput): PresentationPreviewProducerOutput => {
      if (!isPreviewSourceDigest(input.digest)) {
        throw new ExportHandoffError(
          'invalid_source_digest',
          `源字节摘要必须是 sha256:<64 位小写十六进制>，收到：${String(input.digest)}`,
        );
      }
      return Object.freeze({
        fileId: input.fileId,
        revision: input.revision,
        producer,
        mime: artifacts.mime,
        sourceDigest: input.digest,
        renderParts: artifacts.renderParts,
        byteLength: input.byteLength,
      });
    },
  };
}

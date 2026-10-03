/**
 * 演示域**导入—编辑—写回**用例（design-06 P9；PPT-01 / PPT-03 / PPT-04 / PPT-14）。
 *
 * 本文件是「真实字节往返」的判据所在，四类断言各自挡住一种造假方式：
 *
 * 1. **页数可变**：20 页模型 ⇒ 20 个 `ppt/slides/slideN.xml`（不是固定两页）；
 * 2. **部件级保留**：导入 → 只改一处文本 → 导出 ⇒ **除被改的那一页外，其余部件逐字节不变**
 *    （挡住"每次扁平化重造"）；不改动时**零替换**；
 * 3. **精确选区**：改一个 run 的 `[start,end)` ⇒ **未选中的字符与样式、以及其余对象保持引用相等**
 *    （挡住"整段重写"）；
 * 4. **显式具名错误**：图表 / 合并单元格 / 多母版 / 页集合变化 / 切到不存在的版式 ⇒ 报具名错误，
 *    不静默降级（挡住"读不懂就当空"）。
 */

import { describe, expect, it } from 'vitest';

import { readZip, utf8Bytes, writeZip, type ReadZipArchive } from '../artifacts/ooxml/index.js';
import { literalText, transform, type Presentation, type RunStyle, type Shape, type TextRun } from './model.js';
import {
  PresentationOperationError,
  addShape,
  addSlide,
  setRunStyle,
  setRunText,
  setSlideNotes,
  replaceTextSelection,
} from './operations.js';
import { speakerNotesText } from './notes.js';
import { emptyPresentation, renderPresentation } from './render.js';
import {
  PresentationRoundTripError,
  exportImportedPresentation,
  importPresentation,
  type PresentationRoundTripErrorReason,
} from './roundtrip.js';
import { parseXmlDocument, XmlParseError } from './xml-parse.js';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

function textOf(archive: ReadZipArchive, path: string): string {
  const entry = archive.by_path.get(path);
  if (entry === undefined) {
    throw new Error(`包内没有部件 ${path}`);
  }
  return Buffer.from(entry.data).toString('utf8');
}

function bytesOf(archive: ReadZipArchive, path: string): Uint8Array {
  const entry = archive.by_path.get(path);
  if (entry === undefined) {
    throw new Error(`包内没有部件 ${path}`);
  }
  return entry.data;
}

function titleRun(text: string): TextRun {
  return { source: { kind: 'literal', text }, style: { size_pt: 32, bold: true, color: '1F3864' } };
}

/** 造一份"有真实结构"的文稿：每页一个居中标 + 一个两段正文（含粗斜体/字号/颜色/缩进/项目符号）。 */
function richDeck(slideCount: number): Presentation {
  let deck = emptyPresentation('p1', '往返测试');
  for (let index = 0; index < slideCount; index += 1) {
    const added = addSlide(deck);
    deck = added.presentation;
    const title: Shape = {
      kind: 'text_box',
      shape_id: 2,
      name: 'Title',
      transform: transform(838200, 457200, 7772400, 1470025),
      text: {
        paragraphs: [{ runs: [titleRun(`第 ${String(index + 1)} 页`)], level: 0, alignment: 'center', bullet: false }],
      },
    };
    const body: Shape = {
      kind: 'text_box',
      shape_id: 3,
      name: 'Body',
      transform: transform(838200, 2057400, 7772400, 3076575),
      text: {
        paragraphs: [
          {
            runs: [
              {
                source: { kind: 'literal', text: 'ABC-DEF-GHI' },
                style: { size_pt: 18, italic: true, color: '333333' },
              },
            ],
            level: 0,
            alignment: 'justify',
            bullet: false,
          },
          { runs: [{ source: { kind: 'literal', text: '要点' } }], level: 1, alignment: 'left', bullet: true },
        ],
      },
    };
    deck = addShape(deck, added.slide_id, title);
    deck = addShape(deck, added.slide_id, body);
  }
  return deck;
}

/** 在一份已渲染的包里替换某个部件的字节（模拟"别人的、我们不能重造的文件"）。 */
function patchPart(
  bytes: Buffer,
  partPath: string,
  patch: (xml: string) => string,
): Buffer {
  const archive = readZip(bytes);
  const entries = archive.entries.map((entry) =>
    entry.path === partPath
      ? { path: entry.path, data: utf8Bytes(patch(Buffer.from(entry.data).toString('utf8'))) }
      : { path: entry.path, data: entry.data },
  );
  return writeZip(entries);
}

/** 往包里塞一个本域不认识的自定义部件（R249「既有文件的未知部件保留」）。 */
function withCustomPart(bytes: Buffer): Buffer {
  const archive = readZip(bytes);
  const entries = archive.entries.map((entry) => ({ path: entry.path, data: entry.data }));
  entries.push({ path: 'customXml/vendor.xml', data: utf8Bytes('<vendor>重要</vendor>') });
  return writeZip(entries);
}

/** 断言除 `exempt` 之外的所有部件都与 `before` 逐字节相同。 */
function expectAllPartsPreservedExcept(before: ReadZipArchive, after: ReadZipArchive, exempt: readonly string[]): void {
  const exemptSet = new Set(exempt);
  let compared = 0;
  for (const entry of before.entries) {
    if (exemptSet.has(entry.path)) continue;
    expect(Buffer.compare(bytesOf(after, entry.path), entry.data)).toBe(0);
    compared += 1;
  }
  // 防"什么都没比"的假绿：至少要真的比过绝大多数部件。
  expect(compared).toBeGreaterThanOrEqual(before.entries.length - exempt.length);
  expect(compared).toBeGreaterThan(0);
}

function expectRoundTripError(run: () => unknown, reason: PresentationRoundTripErrorReason): void {
  try {
    run();
    throw new Error('应当抛出 PresentationRoundTripError');
  } catch (error) {
    expect(error).toBeInstanceOf(PresentationRoundTripError);
    expect((error as PresentationRoundTripError).reason).toBe(reason);
  }
}

// ---------------------------------------------------------------------------
// 1. 多页真实 PPTX
// ---------------------------------------------------------------------------

describe('PPT-01：真实部件的页数 = 模型页数（含 20 页，不是固定两页）', () => {
  it('20 页模型 ⇒ 20 个 slide 部件，导入回来仍是 20 页且顺序一致', () => {
    const rendered = renderPresentation(richDeck(20));
    const archive = readZip(rendered.bytes);

    for (let index = 1; index <= 20; index += 1) {
      expect(archive.by_path.has(`ppt/slides/slide${String(index)}.xml`)).toBe(true);
    }
    // 反面：没有第 21 页（页数不是常数）。
    expect(archive.by_path.has('ppt/slides/slide21.xml')).toBe(false);
    expect(renderPresentation(richDeck(20)).slide_count).toBe(20);

    const imported = importPresentation(rendered.bytes);
    expect(imported.presentation.slides.length).toBe(20);
    expect(imported.bindings.length).toBe(20);
    expect(imported.bindings.map((binding) => binding.part_path)).toEqual(
      Array.from({ length: 20 }, (_unused, index) => `ppt/slides/slide${String(index + 1)}.xml`),
    );
    expect(imported.opened.slide_part_paths.length).toBe(20);
  });

  it('页数随模型增减：3 页与 20 页的部件集合按页号一一对应', () => {
    const three = readZip(renderPresentation(richDeck(3)).bytes);
    expect(three.by_path.has('ppt/slides/slide3.xml')).toBe(true);
    expect(three.by_path.has('ppt/slides/slide4.xml')).toBe(false);
    expect(importPresentation(renderPresentation(richDeck(3)).bytes).presentation.slides.length).toBe(3);
  });

  it('PPT-04 最小集：字号/粗斜体/颜色/对齐写进被导入的模型（往返不丢）', () => {
    const imported = importPresentation(renderPresentation(richDeck(1)).bytes);
    const slide = imported.presentation.slides[0];
    expect(slide).toBeDefined();
    const title = slide?.shapes[0];
    expect(title?.kind).toBe('text_box');
    if (title?.kind !== 'text_box') throw new Error('第一页第一个对象应当是文本框');

    const run = title.text.paragraphs[0]?.runs[0];
    expect(run?.source).toEqual({ kind: 'literal', text: '第 1 页' });
    expect(run?.style?.size_pt).toBe(32);
    expect(run?.style?.bold).toBe(true);
    expect(run?.style?.color).toBe('1F3864');
    expect(title.text.paragraphs[0]?.alignment).toBe('center');

    const body = slide?.shapes[1];
    if (body?.kind !== 'text_box') throw new Error('第一页第二个对象应当是文本框');
    expect(body.text.paragraphs[0]?.runs[0]?.style?.italic).toBe(true);
    expect(body.text.paragraphs[0]?.alignment).toBe('justify');
    expect(body.text.paragraphs[1]?.level).toBe(1);
    expect(body.text.paragraphs[1]?.bullet).toBe(true);
    // 位置关系在保存重开后保持（PPT-05 的往返面）。
    expect(title.transform).toEqual({ x_emu: 838200, y_emu: 457200, cx_emu: 7772400, cy_emu: 1470025, rotation_deg: 0, flip_h: false, flip_v: false });
  });

  it('导入的页仍是可编辑对象，不是整页截图', () => {
    const imported = importPresentation(renderPresentation(richDeck(2)).bytes);
    const archive = readZip(renderPresentation(imported.presentation).bytes);
    const slide1 = textOf(archive, 'ppt/slides/slide1.xml');
    expect(slide1).toContain('<p:sp>');
    expect(slide1).toContain('<a:t>第 1 页</a:t>');
    expect(slide1).not.toContain('<a:blip');
    expect(slide1).not.toContain('<p:pic');
  });
});

// ---------------------------------------------------------------------------
// 2. 导入往返：部件级保留
// ---------------------------------------------------------------------------

describe('PPT-03 / R249：导入后不改动 ⇒ 零替换、每个部件逐字节保留', () => {
  it('走完整的"导入成模型 → 原样导出"也一个字节都不换（模型路径没有偷偷重造）', () => {
    const bytes = withCustomPart(renderPresentation(richDeck(5)).bytes);
    const imported = importPresentation(bytes);
    const exported = exportImportedPresentation(imported, imported.presentation);

    expect(exported.replaced_part_count).toBe(0);
    expect(exported.changed_part_paths).toEqual([]);
    expect(exported.preserved_part_count).toBe(imported.opened.entries.length);

    const before = readZip(bytes);
    const after = readZip(exported.bytes);
    expectAllPartsPreservedExcept(before, after, []);
    expect(after.by_path.has('customXml/vendor.xml')).toBe(true);
  });

  it('源文件带厂商私有标记时，未改动的页仍原样保留该标记', () => {
    const bytes = patchPart(
      renderPresentation(richDeck(2)).bytes,
      'ppt/slides/slide1.xml',
      (xml) => xml.replace('<p:sld ', '<p:sld data-vendor-marker="keep" '),
    );
    const exported = exportImportedPresentation(importPresentation(bytes), importPresentation(bytes).presentation);
    expect(textOf(readZip(exported.bytes), 'ppt/slides/slide1.xml')).toContain('data-vendor-marker="keep"');
  });
});

describe('PPT-14：导入 → 改一处文本 → 导出 ⇒ 只有被改的部件变', () => {
  it('改第 2 页的一处文本 ⇒ 只有 ppt/slides/slide2.xml 变，其余部件逐字节不变', () => {
    const bytes = withCustomPart(
      patchPart(renderPresentation(richDeck(5)).bytes, 'ppt/slides/slide3.xml', (xml) =>
        xml.replace('<p:sld ', '<p:sld data-vendor-marker="keep" '),
      ),
    );
    const imported = importPresentation(bytes);

    const edited = replaceTextSelection(
      imported.presentation,
      { slide_id: imported.presentation.slides[1]?.slide_id ?? 0, shape_id: 3, paragraph_index: 0, run_index: 0 },
      4,
      7,
      'XYZ',
    );

    const exported = exportImportedPresentation(imported, edited);
    expect(exported.changed_part_paths).toEqual(['ppt/slides/slide2.xml']);
    expect(exported.replaced_part_count).toBe(1);
    expect(exported.preserved_part_count).toBe(imported.opened.entries.length - 1);

    const before = readZip(bytes);
    const after = readZip(exported.bytes);
    // 其余部件（含第 3 页的私有标记、母版、版式、主题、自定义部件、[Content_Types].xml、各 _rels）逐字节不变。
    expectAllPartsPreservedExcept(before, after, ['ppt/slides/slide2.xml']);
    expect(textOf(after, 'ppt/slides/slide3.xml')).toContain('data-vendor-marker="keep"');

    // 被改的那一页确实变成了新文本，且仍是可编辑文本（不是截图）。
    const slide2 = textOf(after, 'ppt/slides/slide2.xml');
    expect(slide2).toContain('<a:t>ABC-XYZ-GHI</a:t>');
    expect(slide2).not.toContain('<a:blip');
  });

  it('导出结果可再次导入：改动能被读回（往返闭合）', () => {
    const imported = importPresentation(renderPresentation(richDeck(2)).bytes);
    const edited = setRunText(
      imported.presentation,
      { slide_id: imported.presentation.slides[1]?.slide_id ?? 0, shape_id: 2, paragraph_index: 0, run_index: 0 },
      '改过的标题',
    );
    const exported = exportImportedPresentation(imported, edited);
    const reopened = importPresentation(exported.bytes);
    const slide2 = reopened.presentation.slides[1];
    const title = slide2?.shapes[0];
    if (title?.kind !== 'text_box') throw new Error('第二页第一个对象应当是文本框');
    expect(title.text.paragraphs[0]?.runs[0]?.source).toEqual({ kind: 'literal', text: '改过的标题' });
  });

  it('带图片的页被改文本后，媒体关系仍是原关系 id，媒体部件未被碰过', () => {
    let deck = richDeck(2);
    const slideId = deck.slides[0]?.slide_id ?? 0;
    const picture: Shape = {
      kind: 'picture',
      shape_id: 9,
      name: 'Pic 1',
      transform: transform(0, 0, 1000000, 1000000),
      media_path: 'ppt/media/image1.png',
      alt_text: '示意',
      crop: null,
    };
    deck = addShape(deck, slideId, picture);
    const bytes = renderPresentation(deck, {
      media: [{ path: 'ppt/media/image1.png', bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) }],
    }).bytes;

    const imported = importPresentation(bytes);
    const importedPicture = imported.presentation.slides[0]?.shapes[2];
    expect(importedPicture?.kind).toBe('picture');
    if (importedPicture?.kind !== 'picture') throw new Error('第三个对象应当是图片');
    expect(importedPicture.media_path).toBe('ppt/media/image1.png');

    const importedSlideId = imported.presentation.slides[0]?.slide_id ?? 0;
    // 导入后的 slide_id 来自产物里的 `p:sldId`（256 起），与源模型的 1 不同——这里用导入后的 id。
    expect(importedSlideId).not.toBe(slideId);
    const edited = replaceTextSelection(
      imported.presentation,
      { slide_id: importedSlideId, shape_id: 2, paragraph_index: 0, run_index: 0 },
      0,
      1,
      '首',
    );
    const exported = exportImportedPresentation(imported, edited);
    const after = readZip(exported.bytes);

    expect(textOf(after, 'ppt/slides/slide1.xml')).toContain('r:embed="rId2"');
    expect(Buffer.compare(bytesOf(after, 'ppt/media/image1.png'), bytesOf(readZip(bytes), 'ppt/media/image1.png'))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. 精确选区（PPT-04）
// ---------------------------------------------------------------------------

describe('PPT-04：精确选区保留未选内容（模型层结构性保证）', () => {
  it('只改选中字符：前缀后缀与样式原样，其余对象 / 段落 / run 引用相等', () => {
    const imported = importPresentation(renderPresentation(richDeck(3)).bytes);
    const before = imported.presentation;
    const slide1 = before.slides[0];
    if (slide1 === undefined) throw new Error('应有第 1 页');

    const after = replaceTextSelection(
      before,
      { slide_id: slide1.slide_id, shape_id: 3, paragraph_index: 0, run_index: 0 },
      4,
      7,
      'XYZ',
    );

    // 未被编辑的页、对象、段落、run：**引用相等**（没有被动过，不是"重新赋了同样的值"）。
    expect(after.slides[1]).toBe(before.slides[1]);
    expect(after.slides[2]).toBe(before.slides[2]);
    const afterSlide1 = after.slides[0];
    if (afterSlide1 === undefined) throw new Error('应有第 1 页');
    expect(afterSlide1.shapes[0]).toBe(slide1.shapes[0]); // 标题对象没被碰
    const afterBody = afterSlide1.shapes[1];
    const beforeBody = slide1.shapes[1];
    if (afterBody?.kind !== 'text_box' || beforeBody?.kind !== 'text_box') throw new Error('正文应当是文本框');
    expect(afterBody.text.paragraphs[1]).toBe(beforeBody.text.paragraphs[1]); // 第二段没被碰
    expect(afterBody.transform).toBe(beforeBody.transform);

    // 被改的 run：前后缀保留，样式原样（同一个 style 对象）。
    const beforeRun = beforeBody.text.paragraphs[0]?.runs[0];
    const afterRun = afterBody.text.paragraphs[0]?.runs[0];
    expect(afterRun?.source).toEqual({ kind: 'literal', text: 'ABC-XYZ-GHI' });
    expect(afterRun?.style).toBe(beforeRun?.style);
    // 原模型没被就地改动（不可变操作）。
    expect(beforeRun?.source).toEqual({ kind: 'literal', text: 'ABC-DEF-GHI' });
  });

  it('精确选区写进真实字节：产物里只有那一个 a:t 变了', () => {
    const imported = importPresentation(renderPresentation(richDeck(1)).bytes);
    const slideId = imported.presentation.slides[0]?.slide_id ?? 0;
    const edited = replaceTextSelection(
      imported.presentation,
      { slide_id: slideId, shape_id: 3, paragraph_index: 0, run_index: 0 },
      0,
      3,
      '甲乙丙',
    );
    const exported = exportImportedPresentation(imported, edited);
    const slide = textOf(readZip(exported.bytes), 'ppt/slides/slide1.xml');

    expect(slide).toContain('<a:t>甲乙丙-DEF-GHI</a:t>');
    expect(slide).toContain('<a:t>第 1 页</a:t>'); // 同一页的另一个对象没被碰
    expect(slide).toContain('<a:t>要点</a:t>');
    expect(slide).not.toContain('ABC-DEF-GHI');
  });

  it('选区越界 / 事实引用 run / 段落不存在 ⇒ 具名报错，不改模型', () => {
    const imported = importPresentation(renderPresentation(richDeck(1)).bytes);
    const presentation = imported.presentation;
    const slideId = presentation.slides[0]?.slide_id ?? 0;
    const target = { slide_id: slideId, shape_id: 3, paragraph_index: 0, run_index: 0 };

    expect(() => replaceTextSelection(presentation, target, 0, 999, 'x')).toThrow(PresentationOperationError);
    expect(() => replaceTextSelection(presentation, target, 5, 2, 'x')).toThrow(PresentationOperationError);
    expect(() => setRunText(presentation, { ...target, paragraph_index: 7 }, 'x')).toThrow(
      PresentationOperationError,
    );

    try {
      replaceTextSelection(presentation, target, 0, 999, 'x');
    } catch (error) {
      expect((error as PresentationOperationError).reason).toBe('selection_out_of_range');
    }

    const factRun: TextRun = { source: { kind: 'fact', fact_key: 'headcount' } };
    const withFact = setRunText(presentation, target, '占位');
    const factSlide = withFact.slides[0];
    if (factSlide === undefined) throw new Error('应有第 1 页');
    const body = factSlide.shapes[1];
    if (body?.kind !== 'text_box') throw new Error('正文应当是文本框');
    const paragraph = body.text.paragraphs[0];
    if (paragraph === undefined) throw new Error('应有第一段');
    const factPresentation: Presentation = {
      ...withFact,
      slides: withFact.slides.map((slide, index) =>
        index === 0 ? { ...slide, shapes: [{ ...body, text: { paragraphs: [{ ...paragraph, runs: [factRun] }] } }] } : slide,
      ),
    };
    try {
      replaceTextSelection(factPresentation, target, 0, 1, 'x');
      throw new Error('应当抛出 PresentationOperationError');
    } catch (error) {
      expect((error as PresentationOperationError).reason).toBe('run_is_not_literal');
    }
  });

  it('setRunStyle 只动样式，文本与其余对象不动', () => {
    const imported = importPresentation(renderPresentation(richDeck(1)).bytes);
    const slideId = imported.presentation.slides[0]?.slide_id ?? 0;
    const style: RunStyle = { size_pt: 44, bold: true, color: 'FF0000' };
    const edited = setRunStyle(
      imported.presentation,
      { slide_id: slideId, shape_id: 3, paragraph_index: 0, run_index: 0 },
      style,
    );
    const slide = textOf(readZip(exportImportedPresentation(imported, edited).bytes), 'ppt/slides/slide1.xml');
    expect(slide).toContain('sz="4400"');
    expect(slide).toContain('b="1"');
    expect(slide).toContain('val="FF0000"');
    expect(slide).toContain('<a:t>ABC-DEF-GHI</a:t>'); // 文本没变
    expect(slide).toContain('<a:t>第 1 页</a:t>');
  });
});

// ---------------------------------------------------------------------------
// 4. 备注（PPT-10）
// ---------------------------------------------------------------------------

describe('PPT-10：备注的原地编辑走同一条保留路径', () => {
  it('改第 2 页备注 ⇒ 只换该页与它的备注部件', () => {
    let deck = richDeck(2);
    const first = deck.slides[0];
    if (first === undefined) throw new Error('应有第 1 页');
    deck = setSlideNotes(deck, first.slide_id, literalText('原备注'));
    const bytes = renderPresentation(deck).bytes;

    const imported = importPresentation(bytes);
    expect(imported.bindings[0]?.notes_part_path).toBe('ppt/notesSlides/notesSlide1.xml');
    const importedSlideId = imported.presentation.slides[0]?.slide_id ?? 0;
    const edited = setSlideNotes(imported.presentation, importedSlideId, literalText('新备注'));

    const exported = exportImportedPresentation(imported, edited);
    expect(exported.changed_part_paths).toEqual(['ppt/notesSlides/notesSlide1.xml']);

    const after = readZip(exported.bytes);
    expect(textOf(after, 'ppt/notesSlides/notesSlide1.xml')).toContain('新备注');
    expectAllPartsPreservedExcept(readZip(bytes), after, ['ppt/notesSlides/notesSlide1.xml']);
  });
});

// ---------------------------------------------------------------------------
// 5. 显式具名错误（不静默降级）
// ---------------------------------------------------------------------------

describe('显式具名错误：读不懂 / 表达不了 ⇒ 报错，不静默降级', () => {
  it('页上有图表（p:graphicFrame 非表格）⇒ unsupported_slide_content', () => {
    const chartFrame =
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Chart 1"/><p:cNvGraphicFramePr/>' +
      '<p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
      '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId9"/>' +
      '</a:graphicData></a:graphic></p:graphicFrame>';
    const bytes = patchPart(renderPresentation(richDeck(1)).bytes, 'ppt/slides/slide1.xml', (xml) =>
      xml.replace('</p:spTree>', `${chartFrame}</p:spTree>`),
    );
    expectRoundTripError(() => importPresentation(bytes), 'unsupported_slide_content');
  });

  it('页上有本域未建模的元素 ⇒ unsupported_slide_content（不是"当空跳过"）', () => {
    const bytes = patchPart(renderPresentation(richDeck(1)).bytes, 'ppt/slides/slide1.xml', (xml) =>
      xml.replace('</p:spTree>', '<p:contentPart r:id="rId9"/></p:spTree>'),
    );
    expectRoundTripError(() => importPresentation(bytes), 'unsupported_slide_content');
  });

  it('表格合并单元格（gridSpan）⇒ unsupported_merge_span', () => {
    let deck = richDeck(1);
    const slideId = deck.slides[0]?.slide_id ?? 0;
    const table: Shape = {
      kind: 'table',
      shape_id: 7,
      name: 'Table 1',
      transform: transform(0, 0, 5000000, 2000000),
      column_widths_emu: [1000000, 1000000],
      rows: [{ cells: [{ text: null, col_span: 1, row_span: 1 }, { text: null, col_span: 1, row_span: 1 }] }],
    };
    deck = addShape(deck, slideId, table);
    const bytes = patchPart(renderPresentation(deck).bytes, 'ppt/slides/slide1.xml', (xml) =>
      xml.replace('<a:tc>', '<a:tc gridSpan="2">'),
    );
    expectRoundTripError(() => importPresentation(bytes), 'unsupported_merge_span');
  });

  it('多套母版 ⇒ multi_master_unsupported', () => {
    const bytes = patchPart(renderPresentation(richDeck(1)).bytes, 'ppt/presentation.xml', (xml) =>
      xml.replace('</p:sldMasterIdLst>', '<p:sldMasterId id="2147483649" r:id="rId9"/></p:sldMasterIdLst>'),
    );
    expectRoundTripError(() => importPresentation(bytes), 'multi_master_unsupported');
  });

  it('导出时页集合被改（增页）⇒ slide_set_changed，不假装成功', () => {
    const imported = importPresentation(renderPresentation(richDeck(2)).bytes);
    const grown = addSlide(imported.presentation).presentation;
    expectRoundTripError(
      () => exportImportedPresentation(imported, grown),
      'slide_set_changed',
    );
  });

  it('给原本没有备注的页加备注 ⇒ 走 note-parts 登记，往返闭合', () => {
    const imported = importPresentation(renderPresentation(richDeck(1)).bytes);
    expect(imported.bindings[0]?.notes_part_path).toBeNull();
    const slideId = imported.presentation.slides[0]?.slide_id ?? 0;
    const edited = setSlideNotes(imported.presentation, slideId, literalText('新备注'));

    const exported = exportImportedPresentation(imported, edited);
    // 真的新增了备注部件（在差异清单里看得见），不是静默无效。
    expect(exported.changed_part_paths.some((path) => /notesSlides\/notesSlide\d+\.xml$/.test(path))).toBe(true);
    // 未改动的幻灯片正文仍逐字节保留。
    expect(
      Buffer.compare(
        bytesOf(readZip(exported.bytes), 'ppt/slides/slide1.xml'),
        bytesOf(readZip(renderPresentation(richDeck(1)).bytes), 'ppt/slides/slide1.xml'),
      ),
    ).toBe(0);

    const reopened = importPresentation(exported.bytes);
    const notes = reopened.presentation.slides[0]?.notes;
    expect(notes).not.toBeNull();
    expect(speakerNotesText(notes ?? null)).toContain('新备注');
  });

  it('删掉原本存在的备注 ⇒ 走 note-parts 撤销，往返闭合', () => {
    let deck = richDeck(1);
    const slideId = deck.slides[0]?.slide_id ?? 0;
    deck = setSlideNotes(deck, slideId, literalText('备注'));
    const bytes = renderPresentation(deck).bytes;
    const imported = importPresentation(bytes);
    expect(imported.bindings[0]?.notes_part_path).toBe('ppt/notesSlides/notesSlide1.xml');

    const importedSlideId = imported.presentation.slides[0]?.slide_id ?? 0;
    const edited = setSlideNotes(imported.presentation, importedSlideId, null);
    const exported = exportImportedPresentation(imported, edited);

    expect(readZip(exported.bytes).by_path.has('ppt/notesSlides/notesSlide1.xml')).toBe(false);
    const reopened = importPresentation(exported.bytes);
    expect(reopened.presentation.slides[0]?.notes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. XML 读取器（往返路径的"读"的一侧）
// ---------------------------------------------------------------------------

describe('XML 读取器：解析不了就抛错，不返回半个树', () => {
  it('读回属性、文本、字符引用与自闭合标签', () => {
    const root = parseXmlDocument('<?xml version="1.0"?>\n<a:x p="1" q="&amp;&lt;&quot;">文&#65;本<b:y/></a:x>');
    expect(root.name).toBe('a:x');
    expect(root.attributes.get('p')).toBe('1');
    expect(root.attributes.get('q')).toBe('&<"');
    const inner = root.children.find((child) => child.kind === 'element');
    expect(inner?.kind === 'element' ? inner.name : null).toBe('b:y');
  });

  it('标签不配对 / 没闭合 ⇒ 抛 XmlParseError（不静默截断）', () => {
    expect(() => parseXmlDocument('<a><b></a>')).toThrow(XmlParseError);
    expect(() => parseXmlDocument('<a><b></b>')).toThrow(XmlParseError);
    expect(() => parseXmlDocument('<a')).toThrow(XmlParseError);
  });

  it('与 OOXML 序列化器互为逆运算（转义往返闭合）', () => {
    const root = parseXmlDocument('<a:t>a&amp;b&lt;c&gt;d&quot;e&apos;f</a:t>');
    const text = root.children.find((child) => child.kind === 'text');
    expect(text?.kind === 'text' ? text.text : null).toBe('a&b<c>d"e\'f');
  });
});

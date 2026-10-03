/**
 * 演示域**渲染层**用例（design-06 P9）。
 *
 * 重点：
 * - PPT-01「页数由任务决定」——渲染出的页数**等于模型页数**，不是固定两页；
 * - PPT-07「形状 / 文本是可编辑对象，不整页截图」——文本落在 `a:t` 里，不是位图；
 * - R248「缺失不当零」——查不到事实时产物里是占位文本，不是 `0`；
 * - 未渲染的对象种类**显式报错**，不静默丢弃。
 */

import { describe, expect, it } from 'vitest';

import { readZip, type ReadZipArchive } from '../artifacts/ooxml/index.js';
import { literalText, transform, type FactSnapshot, type Presentation, type Shape } from './model.js';
import { addShape, addSlide } from './operations.js';
import {
  PresentationRenderError,
  emptyPresentation,
  renderPresentation,
} from './render.js';

function textOf(archive: ReadZipArchive, path: string): string {
  const entry = archive.by_path.get(path);
  if (entry === undefined) {
    throw new Error(`包内没有部件 ${path}`);
  }
  return Buffer.from(entry.data).toString('utf8');
}

function deckWithSlides(count: number): Presentation {
  let deck = emptyPresentation('p1', '测试文稿');
  for (let i = 0; i < count; i += 1) {
    deck = addSlide(deck).presentation;
  }
  return deck;
}

function textBox(id: number, x: number, y: number, text: string): Shape {
  return {
    kind: 'text_box',
    shape_id: id,
    name: `Box ${String(id)}`,
    transform: transform(x, y, 4000000, 1000000),
    text: literalText(text),
  };
}

describe('PPT-01：渲染出的页数 = 模型页数（不是固定两页）', () => {
  it('1 / 2 / 3 / 8 页都能渲染，且 slide_count 与模型一致', () => {
    for (const count of [1, 2, 3, 8]) {
      const deck = deckWithSlides(count);
      const result = renderPresentation(deck);
      expect(result.slide_count).toBe(count);

      const archive = readZip(result.bytes);
      for (let i = 1; i <= count; i += 1) {
        expect(archive.by_path.has(`ppt/slides/slide${String(i)}.xml`)).toBe(true);
      }
      // 反面：第 count+1 页**不应**存在——页数不是常数，也不是"多写几页"。
      expect(archive.by_path.has(`ppt/slides/slide${String(count + 1)}.xml`)).toBe(false);
      expect(textOf(archive, 'ppt/presentation.xml')).toContain(
        `id="${String(256 + count - 1)}"`,
      );
    }
  });

  it('页数增加 ⇒ 条目数随之增加（幻灯片与其关系各 +1）', () => {
    const one = renderPresentation(deckWithSlides(1));
    const three = renderPresentation(deckWithSlides(3));
    expect(three.entry_count).toBe(one.entry_count + 4);
  });

  it('20 页模型 ⇒ 恰好 20 个 slide 部件（页数不是常数，也不是"多写几页"）', () => {
    const deck = deckWithSlides(20);
    const result = renderPresentation(deck);
    expect(result.slide_count).toBe(20);

    const archive = readZip(result.bytes);
    for (let index = 1; index <= 20; index += 1) {
      expect(archive.by_path.has(`ppt/slides/slide${String(index)}.xml`)).toBe(true);
    }
    expect(archive.by_path.has('ppt/slides/slide21.xml')).toBe(false);
    expect(textOf(archive, 'ppt/presentation.xml')).toContain('id="275"'); // 256 + 20 - 1
  });

  it('页面尺寸来自模型（16:9 与 4:3 写进 sldSz）', () => {
    const deck = { ...deckWithSlides(1), size: { cx_emu: 12192000, cy_emu: 6858000 } };
    const archive = readZip(renderPresentation(deck).bytes);
    const presentation = textOf(archive, 'ppt/presentation.xml');
    expect(presentation).toContain('cx="12192000"');
    expect(presentation).toContain('cy="6858000"');
  });
});

describe('PPT-07：形状与文本是可编辑对象，不整页截图', () => {
  it('文本框落在 a:t 里（可编辑文本），且整页**没有**位图填充', () => {
    let deck = deckWithSlides(1);
    deck = addShape(deck, 1, textBox(2, 838200, 457200, '可编辑标题'));

    const archive = readZip(renderPresentation(deck).bytes);
    const slide = textOf(archive, 'ppt/slides/slide1.xml');

    expect(slide).toContain('<p:sp>');
    expect(slide).toContain('<a:t>可编辑标题</a:t>');
    // 反面：整页截图会以 blipFill/p:pic 出现——本产物**不得**有。
    expect(slide).not.toContain('<a:blip');
    expect(slide).not.toContain('<p:pic');
  });

  it('连接符渲染成 p:cxnSp（仍是可编辑对象）', () => {
    let deck = deckWithSlides(1);
    const connector: Shape = {
      kind: 'connector',
      shape_id: 2,
      name: 'Flow 1',
      transform: transform(0, 0, 1000000, 0),
      preset: 'line',
      outline: { color: 'FF0000', width_emu: 12700 },
      start_shape_id: null,
      end_shape_id: null,
    };
    deck = addShape(deck, 1, connector);
    const archive = readZip(renderPresentation(deck).bytes);
    const slide = textOf(archive, 'ppt/slides/slide1.xml');
    expect(slide).toContain('<p:cxnSp>');
    expect(slide).toContain('prst="line"');
    expect(slide).toContain('val="FF0000"');
  });

  it('旋转与翻转写进 a:xfrm（PPT-05 的位置关系保存）', () => {
    let deck = deckWithSlides(1);
    const shape: Shape = {
      kind: 'text_box',
      shape_id: 2,
      name: 'Rotated',
      transform: transform(0, 0, 1000000, 1000000, { rotation_deg: 90, flip_h: true }),
      text: literalText('旋转'),
    };
    deck = addShape(deck, 1, shape);
    const slide = textOf(readZip(renderPresentation(deck).bytes), 'ppt/slides/slide1.xml');
    expect(slide).toContain('rot="5400000"'); // 90° × 60000
    expect(slide).toContain('flipH="1"');
  });

  it('表格渲染成 a:tbl，列数与模型一致', () => {
    let deck = deckWithSlides(1);
    const table: Shape = {
      kind: 'table',
      shape_id: 2,
      name: 'Table 1',
      transform: transform(0, 0, 5000000, 2000000),
      column_widths_emu: [1000000, 1000000, 1000000],
      rows: [
        { cells: [nullCell(), nullCell(), nullCell()] },
        { cells: [nullCell(), nullCell(), nullCell()] },
      ],
    };
    deck = addShape(deck, 1, table);
    const slide = textOf(readZip(renderPresentation(deck).bytes), 'ppt/slides/slide1.xml');
    expect(slide).toContain('<a:tbl>');
    expect((slide.match(/<a:gridCol/g) ?? []).length).toBe(3);
    expect((slide.match(/<a:tr /g) ?? []).length).toBe(2);
  });

  it('合并单元格（span>1）本增量未渲染 ⇒ 显式报错，不静默出图', () => {
    let deck = deckWithSlides(1);
    const table: Shape = {
      kind: 'table',
      shape_id: 2,
      name: 'Merged',
      transform: transform(0, 0, 5000000, 2000000),
      column_widths_emu: [1000000, 1000000],
      rows: [{ cells: [{ text: null, col_span: 2, row_span: 1 }] }],
    };
    deck = addShape(deck, 1, table);
    try {
      renderPresentation(deck);
      throw new Error('应当抛出 PresentationRenderError');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationRenderError);
      expect((error as PresentationRenderError).reason).toBe('unsupported_merge_span');
    }
  });

  it('多套母版（页引用别的母版）⇒ 具名 multi_master_unsupported，不静默只读一套', () => {
    let deck = deckWithSlides(2);
    const first = deck.slides[0];
    if (first === undefined) throw new Error('应有第 1 页');
    deck = {
      ...deck,
      slides: deck.slides.map((slide, index) =>
        index === 0 ? { ...slide, layout: { master_id: 'master2', layout_id: 'blank' } } : slide,
      ),
    };
    try {
      renderPresentation(deck);
      throw new Error('应当抛出 PresentationRenderError');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationRenderError);
      expect((error as PresentationRenderError).reason).toBe('multi_master_unsupported');
    }
  });

  it('未知媒体扩展名 ⇒ 具名 unknown_media_type，不猜内容类型', () => {
    let deck = deckWithSlides(1);
    const picture: Shape = {
      kind: 'picture',
      shape_id: 2,
      name: 'Pic',
      transform: transform(0, 0, 1000000, 1000000),
      media_path: 'ppt/media/image1.psd',
      alt_text: '示意',
      crop: null,
    };
    deck = addShape(deck, 1, picture);
    try {
      renderPresentation(deck, { media: [{ path: 'ppt/media/image1.psd', bytes: new Uint8Array([1, 2, 3]) }] });
      throw new Error('应当抛出 PresentationRenderError');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationRenderError);
      expect((error as PresentationRenderError).reason).toBe('unknown_media_type');
    }
  });

  it('音视频对象未渲染 ⇒ 具名 unsupported_shape_kind（不假称已嵌入）', () => {
    let deck = deckWithSlides(1);
    const media: Shape = {
      kind: 'media',
      shape_id: 2,
      name: 'Video 1',
      transform: transform(0, 0, 1000000, 1000000),
      media_type: 'video',
      media_path: 'ppt/media/media1.mp4',
    };
    deck = addShape(deck, 1, media);
    try {
      renderPresentation(deck, { media: [{ path: 'ppt/media/media1.mp4', bytes: new Uint8Array([1]) }] });
      throw new Error('应当抛出 PresentationRenderError');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationRenderError);
      expect((error as PresentationRenderError).reason).toBe('unsupported_shape_kind');
    }
  });
});

function nullCell(): { text: null; col_span: number; row_span: number } {
  return { text: null, col_span: 1, row_span: 1 };
}

describe('R248：缺失不当零（渲染进产物）', () => {
  const snapshot: FactSnapshot = [
    { fact_key: 'headcount', value: { type: 'number', amount: 8, unit: '人', currency: null } },
  ];

  it('正例：事实命中 ⇒ 产物里是值', () => {
    let deck = deckWithSlides(1);
    const shape: Shape = {
      kind: 'text_box',
      shape_id: 2,
      name: 'Fact',
      transform: transform(0, 0, 1000000, 1000000),
      text: { paragraphs: [{ runs: [{ source: { kind: 'fact', fact_key: 'headcount' } }], level: 0, alignment: 'left', bullet: false }] },
    };
    deck = addShape(deck, 1, shape);
    const slide = textOf(readZip(renderPresentation(deck, { fact_snapshot: snapshot }).bytes), 'ppt/slides/slide1.xml');
    expect(slide).toContain('<a:t>8 人</a:t>');
  });

  it('反例：事实缺失 ⇒ 产物里是占位文本，**不是** 0', () => {
    let deck = deckWithSlides(1);
    const shape: Shape = {
      kind: 'text_box',
      shape_id: 2,
      name: 'Fact',
      transform: transform(0, 0, 1000000, 1000000),
      text: { paragraphs: [{ runs: [{ source: { kind: 'fact', fact_key: '预算' } }], level: 0, alignment: 'left', bullet: false }] },
    };
    deck = addShape(deck, 1, shape);
    const slide = textOf(readZip(renderPresentation(deck, { fact_snapshot: snapshot }).bytes), 'ppt/slides/slide1.xml');
    expect(slide).toContain('<a:t>（未提供）</a:t>');
    expect(slide).not.toContain('<a:t>0</a:t>');
    expect(slide).not.toContain('<a:t>0 ');
  });

  it('没有快照时同样不编造数字', () => {
    let deck = deckWithSlides(1);
    const shape: Shape = {
      kind: 'text_box',
      shape_id: 2,
      name: 'Fact',
      transform: transform(0, 0, 1000000, 1000000),
      text: { paragraphs: [{ runs: [{ source: { kind: 'fact', fact_key: 'x' } }], level: 0, alignment: 'left', bullet: false }] },
    };
    deck = addShape(deck, 1, shape);
    const slide = textOf(readZip(renderPresentation(deck).bytes), 'ppt/slides/slide1.xml');
    expect(slide).toContain('（未提供）');
    expect(/<a:t>[0-9]/.test(slide)).toBe(false);
  });
});

describe('确定性与未实现对象的显式报错', () => {
  it('同一模型连跑两次 ⇒ 逐字节相等、摘要相等', () => {
    let deck = deckWithSlides(3);
    deck = addShape(deck, 1, textBox(2, 0, 0, '稳定'));
    const first = renderPresentation(deck);
    const second = renderPresentation(deck);
    expect(Buffer.compare(first.bytes, second.bytes)).toBe(0);
    expect(first.content_digest).toBe(second.content_digest);
  });

  // **2026-10-03 更新**：图表对象**已被接到渲染**（FA-PPT-WIRE，`render.ts` 现建
  // slide → chart → embedded workbook 完整部件图）。本用例原先断言"图表未渲染 ⇒ 报
  // `unsupported_shape_kind`"，那描述的是**接线前**的旧边界，接线后自然变红。
  // 现改为断言**新边界**：图表真的产出部件，而不是只活在模型里。
  it('图表对象已接到渲染 ⇒ 真的产出 chart 部件（不再报 unsupported_shape_kind）', () => {
    const plain = renderPresentation(deckWithSlides(1));

    let deck = deckWithSlides(1);
    const chart: Shape = {
      kind: 'chart',
      shape_id: 2,
      name: 'Chart',
      transform: transform(0, 0, 1000000, 1000000),
      chart: { chart_type: 'bar', categories: ['A'], series: [{ name: 's', values: [1] }], title: null },
    };
    deck = addShape(deck, 1, chart);
    const rendered = renderPresentation(deck);

    // 正向：包里真的有图表部件与嵌入工作簿（不是"渲染成功但没有图表"）。
    const paths = [...readZip(rendered.bytes).by_path.keys()];
    expect(paths.filter((p) => p.startsWith('ppt/charts/chart'))).toHaveLength(1);
    expect(paths.some((p) => p.startsWith('ppt/embeddings/'))).toBe(true);
    // 反向对照：同一模型不加图表时**不得**出现图表部件（证明上面不是恒真）。
    const plainPaths = [...readZip(plain.bytes).by_path.keys()];
    expect(plainPaths.some((p) => p.startsWith('ppt/charts/'))).toBe(false);
    expect(Buffer.compare(rendered.bytes, plain.bytes)).not.toBe(0);
  });

  it('引用了未提供的媒体 ⇒ 报 missing_media（不假称已嵌入）', () => {
    let deck = deckWithSlides(1);
    const picture: Shape = {
      kind: 'picture',
      shape_id: 2,
      name: 'Pic',
      transform: transform(0, 0, 1000000, 1000000),
      media_path: 'ppt/media/image1.png',
      alt_text: '示意',
      crop: null,
    };
    deck = addShape(deck, 1, picture);
    try {
      renderPresentation(deck);
      throw new Error('应当抛出 PresentationRenderError');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationRenderError);
      expect((error as PresentationRenderError).reason).toBe('missing_media');
    }
  });

  it('shape_id < 2 非法 ⇒ 报 unsupported_shape_id（1 保留给形状树前导）', () => {
    let deck = deckWithSlides(1);
    deck = addShape(deck, 1, textBox(1, 0, 0, '非法 id'));
    try {
      renderPresentation(deck);
      throw new Error('应当抛出 PresentationRenderError');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationRenderError);
      expect((error as PresentationRenderError).reason).toBe('unsupported_shape_id');
    }
  });

  it('提供媒体后图片正常渲染，并带 alt 文本', () => {
    let deck = deckWithSlides(1);
    const picture: Shape = {
      kind: 'picture',
      shape_id: 2,
      name: 'Pic',
      transform: transform(0, 0, 1000000, 1000000),
      media_path: 'ppt/media/image1.png',
      alt_text: '示意',
      crop: null,
    };
    deck = addShape(deck, 1, picture);
    const result = renderPresentation(deck, {
      media: [{ path: 'ppt/media/image1.png', bytes: new Uint8Array([137, 80, 78, 71]) }],
    });
    const archive = readZip(result.bytes);
    expect(archive.by_path.has('ppt/media/image1.png')).toBe(true);
    const slide = textOf(archive, 'ppt/slides/slide1.xml');
    expect(slide).toContain('<p:pic>');
    expect(slide).toContain('descr="示意"');
    expect(slide).toContain('r:embed="rId2"'); // rId1 = 版式
  });
});

describe('备注（PPT-10）', () => {
  it('有备注的页产出 notesSlide 部件；没有备注意味的页不产出', () => {
    let deck = deckWithSlides(2);
    deck = {
      ...deck,
      slides: deck.slides.map((slide, index) =>
        index === 0 ? { ...slide, notes: literalText('演讲备注') } : slide,
      ),
    };
    const archive = readZip(renderPresentation(deck).bytes);
    expect(archive.by_path.has('ppt/notesSlides/notesSlide1.xml')).toBe(true);
    expect(archive.by_path.has('ppt/notesSlides/notesSlide2.xml')).toBe(false);
    expect(textOf(archive, 'ppt/notesSlides/notesSlide1.xml')).toContain('演讲备注');
  });
});

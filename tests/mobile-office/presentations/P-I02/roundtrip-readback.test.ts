/**
 * P-I02 · `roundtrip.ts` **读回接线**定向验收（PPT-01 / PPT-03 / PPT-10 / PPT-11 / PPT-02 的往返面）。
 *
 * ## 本单元补的四件事（都在 `src/presentations/roundtrip.ts` 内）
 *
 * 1. **对象动画读回**：原先 `importPresentation` 把每页 `animations` 硬编码成 `[]`——导入既有文件后
 *    可见动画永远无从谈起，且"改一页再存"会静默丢掉整块 `p:timing`（P-R01 section D 已确认）。
 *    现改为把页里的 `p:timing` 经 P08 `parseTimingXml` 读回模型动画。
 * 2. **连接符端点读回**：`p:cNvCxnSpPr` 下的 `a:stCxn` / `a:endCxn` `@id` → `start_shape_id` / `end_shape_id`
 *    （原先恒为 `null`；P04 测试 E 已确认）。
 * 3. **备注部件增 / 删**：交给 `annotations/note-parts.ts` 登记（连 notesMaster 一起），不再拒绝；
 *    增 → 导出 → 再导入能看到备注；删 → 导出 → 再导入备注为空且部件已撤。
 * 4. **切版式**：改写该页 `_rels` 的 slideLayout Target，而不是静默无效（P02 请求）。
 *
 * ## 判据来源（不复用待测代码自证）
 *
 * - 动画：对**源幻灯片 XML 里的 `p:timing`** 独立跑 `parseTimingXml`，再与经 `importPresentation`
 *   读回的模型动画对照（一条"文档级"、一条"模型级"，两条独立路径）；
 * - 连接符：先证明"渲染器没写端点时读回是 null"（反向对照），再把端点写进 `p:cNvCxnSpPr` 证明能读回；
 * - 备注：`renderPresentation` 造真包 → `importPresentation` → 编辑 → `exportImportedPresentation`
 *   → 再 `importPresentation`，全程真实字节。
 *
 * ## 边界（如实登记）
 *
 * - **渲染侧**（`render.ts` 写 `p:timing` / `a:stCxn` / `a:endCxn`）由同批 P-I01 落地（不属本单元写区）：
 *   本用例直接 `renderPresentation → importPresentation` 走真实渲染侧产出；若 P-I01 未接线，动画与
 *   连接符两条会红，这是**有意**的组合断言（本单元只负责"读回"一侧）。
 * - 真机 PowerPoint / WPS 打开播放**未验证**（本工作包不触设备）。
 */

import { describe, expect, it } from 'vitest';

import { readZip, utf8Bytes, writeZip } from '../../../../src/artifacts/ooxml/index.js';
import { applyAnimations, type AnimationSpec } from '../../../../src/presentations/animation.js';
import { parseTimingXml } from '../../../../src/presentations/timing-parts/index.js';
import { literalText, transform, type Presentation, type Shape } from '../../../../src/presentations/model.js';
import { speakerNotesText } from '../../../../src/presentations/notes.js';
import { addShape, addSlide, setSlideNotes } from '../../../../src/presentations/operations.js';
import { emptyPresentation, renderPresentation } from '../../../../src/presentations/render.js';
import {
  PresentationRoundTripError,
  exportImportedPresentation,
  importPresentation,
} from '../../../../src/presentations/roundtrip.js';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

function textBox(id: number, text: string): Shape {
  return {
    kind: 'text_box',
    shape_id: id,
    name: `T${String(id)}`,
    transform: transform(838200, 457200, 7772400, 1470025),
    text: { paragraphs: [{ runs: [literalText(text).paragraphs[0]!.runs[0]!], level: 0, alignment: 'left', bullet: false }] },
  };
}

function autoShape(id: number, name: string): Shape {
  return {
    kind: 'auto_shape',
    shape_id: id,
    name,
    transform: transform(0, 0, 1000000, 1000000),
    preset: 'rect',
    text: null,
    fill: { kind: 'none' },
    outline: null,
  };
}

/** 单页空稿（一个文本框）。 */
function singleSlideDeck(): Presentation {
  let deck = emptyPresentation('p1', '读回测试');
  const added = addSlide(deck);
  deck = added.presentation;
  return addShape(deck, added.slide_id, textBox(2, '标题'));
}

/** 替换包内某部件文本（造出反向对照 / 畸形输入）。 */
function patchPart(bytes: Uint8Array, partPath: string, patch: (xml: string) => string): Uint8Array {
  const archive = readZip(bytes);
  return writeZip(
    archive.entries.map((entry) =>
      entry.path === partPath
        ? { path: entry.path, data: utf8Bytes(patch(Buffer.from(entry.data).toString('utf8'))) }
        : { path: entry.path, data: entry.data },
    ),
  );
}

function partText(bytes: Uint8Array, partPath: string): string {
  const entry = readZip(bytes).by_path.get(partPath);
  if (entry === undefined) throw new Error(`包内没有部件 ${partPath}`);
  return Buffer.from(entry.data).toString('utf8');
}

// ---------------------------------------------------------------------------
// 1. 对象动画读回（动画规格闭合）
// ---------------------------------------------------------------------------

describe('P-I02 · 对象动画读回', () => {
  it('render → import 恢复同一批动画：文档级 p:timing 与模型级 ShapeAnimation 双路径一致', () => {
    let deck = emptyPresentation('p1', '动画');
    const added = addSlide(deck);
    deck = added.presentation;
    deck = addShape(deck, added.slide_id, textBox(2, '标题'));
    deck = addShape(deck, added.slide_id, autoShape(3, '盒'));

    const specs: AnimationSpec[] = [
      { shape_id: 2, effect: 'fade', kind: 'entrance', trigger: 'on_click', duration_ms: 500, delay_ms: 0 },
      { shape_id: 3, effect: 'appear', kind: 'entrance', trigger: 'on_click', duration_ms: 1, delay_ms: 0 },
    ];
    deck = applyAnimations(deck, added.slide_id, specs);

    // 真实 render → import：render.ts（P-I01 已接线）把动画写成页内 p:timing。
    const bytes = renderPresentation(deck).bytes;

    // 独立路径 A：直接解析源部件里的 p:timing 块，得到 AnimationSpec[]。
    const slideXml = partText(bytes, 'ppt/slides/slide1.xml');
    const timingBlock = /<p:timing\b[\s\S]*<\/p:timing>/.exec(slideXml)?.[0] ?? '';
    expect(timingBlock).not.toBe('');
    expect([...parseTimingXml(timingBlock)]).toEqual(specs);

    // 独立路径 B：经 importPresentation 读回模型动画（AnimationSpec → ShapeAnimation，order 按触发组重算）。
    const imported = importPresentation(bytes);
    expect(imported.presentation.slides[0]?.animations).toEqual([
      { shape_id: 2, effect: 'fade', trigger: 'on_click', duration_ms: 500, order: 0 },
      { shape_id: 3, effect: 'appear', trigger: 'on_click', duration_ms: 1, order: 1 },
    ]);
  });

  it('无 p:timing 的页 ⇒ animations 为空（不是凭空的默认动画）', () => {
    const imported = importPresentation(renderPresentation(singleSlideDeck()).bytes);
    expect(imported.presentation.slides[0]?.animations).toEqual([]);
    expect(imported.bindings[0]?.timing_xml).toBeNull();
  });

  it('改一页文本再导出：p:timing 不被静默丢弃（P-R01 section D 的反例）', () => {
    let deck = emptyPresentation('p1', '保动画');
    const added = addSlide(deck);
    deck = added.presentation;
    deck = addShape(deck, added.slide_id, textBox(2, '原标题'));
    deck = applyAnimations(deck, added.slide_id, [
      { shape_id: 2, effect: 'fade', kind: 'entrance', trigger: 'on_click', duration_ms: 400, delay_ms: 0 },
    ]);

    const imported = importPresentation(renderPresentation(deck).bytes);
    expect(imported.presentation.slides[0]?.animations.length).toBe(1);

    // 只改文本框文字（不动动画）。
    const source = imported.presentation.slides[0]!;
    const shape = source.shapes[0]!;
    if (shape.kind !== 'text_box') throw new Error('应是文本框');
    const paragraph = shape.text.paragraphs[0]!;
    const edited: Presentation = {
      ...imported.presentation,
      slides: imported.presentation.slides.map((slide, index) =>
        index === 0
          ? {
              ...slide,
              shapes: [
                { ...shape, text: { paragraphs: [{ ...paragraph, runs: [literalText('改后标题').paragraphs[0]!.runs[0]!] }] } },
              ],
            }
          : slide,
      ),
    };

    const exported = exportImportedPresentation(imported, edited);
    const after = partText(exported.bytes, 'ppt/slides/slide1.xml');
    expect(after).toContain('改后标题');
    // 关键：动画块仍在，且 p:timing 排在 p:transition 之后（schema 位置）。
    expect(/<p:timing\b/.test(after)).toBe(true);
    expect(importPresentation(exported.bytes).presentation.slides[0]?.animations.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. 连接符端点读回
// ---------------------------------------------------------------------------

describe('P-I02 · 连接符端点读回', () => {
  function deckWithConnector(start: number | null, end: number | null): Presentation {
    let deck = emptyPresentation('p1', '连接');
    const added = addSlide(deck);
    deck = added.presentation;
    deck = addShape(deck, added.slide_id, autoShape(2, 'A'));
    deck = addShape(deck, added.slide_id, autoShape(3, 'B'));
    const connector: Shape = {
      kind: 'connector',
      shape_id: 4,
      name: 'Cxn 1',
      transform: transform(0, 0, 1000000, 0),
      preset: 'line',
      outline: null,
      start_shape_id: start,
      end_shape_id: end,
    };
    return addShape(deck, added.slide_id, connector);
  }

  it('反向对照：未绑定的连接符读回 null（证明判据非空壳）', () => {
    const imported = importPresentation(renderPresentation(deckWithConnector(null, null)).bytes);
    const connector = imported.presentation.slides[0]?.shapes.find((shape) => shape.kind === 'connector');
    if (connector?.kind !== 'connector') throw new Error('应有连接符');
    expect(connector.start_shape_id).toBeNull();
    expect(connector.end_shape_id).toBeNull();
  });

  it('render → import 恢复连接符起止形状 id', () => {
    const imported = importPresentation(renderPresentation(deckWithConnector(2, 3)).bytes);
    const connector = imported.presentation.slides[0]?.shapes.find((shape) => shape.kind === 'connector');
    if (connector?.kind !== 'connector') throw new Error('应有连接符');
    expect(connector.start_shape_id).toBe(2);
    expect(connector.end_shape_id).toBe(3);
  });

  it('端点属性不是整数 ⇒ 具名报错，不静默当 null', () => {
    const bytes = patchPart(renderPresentation(deckWithConnector(2, 3)).bytes, 'ppt/slides/slide1.xml', (xml) =>
      xml.replace(/<a:stCxn id="2"/, '<a:stCxn id="abc"'),
    );
    try {
      importPresentation(bytes);
      throw new Error('应当抛出 PresentationRoundTripError');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationRoundTripError);
      expect((error as PresentationRoundTripError).reason).toBe('malformed_slide_xml');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. 备注部件增 / 删（经 annotations/note-parts.ts）
// ---------------------------------------------------------------------------

describe('P-I02 · 备注部件增 / 删往返', () => {
  it('无备注的页加备注 ⇒ 导出 → 再导入能看到备注', () => {
    const imported = importPresentation(renderPresentation(singleSlideDeck()).bytes);
    expect(imported.bindings[0]?.notes_part_path).toBeNull();

    const slideId = imported.presentation.slides[0]?.slide_id ?? 0;
    const exported = exportImportedPresentation(imported, setSlideNotes(imported.presentation, slideId, literalText('P-I02 备注')));

    expect(exported.changed_part_paths.some((path) => /notesSlides\/notesSlide\d+\.xml$/.test(path))).toBe(true);

    const reopened = importPresentation(exported.bytes);
    expect(reopened.bindings[0]?.notes_part_path).not.toBeNull();
    expect(speakerNotesText(reopened.presentation.slides[0]?.notes ?? null)).toBe('P-I02 备注');
  });

  it('有备注的页删备注 ⇒ 导出 → 再导入备注为空且部件已撤', () => {
    let deck = singleSlideDeck();
    const slideId = deck.slides[0]?.slide_id ?? 0;
    deck = setSlideNotes(deck, slideId, literalText('原备注'));
    const bytes = renderPresentation(deck).bytes;

    const imported = importPresentation(bytes);
    expect(imported.bindings[0]?.notes_part_path).toBe('ppt/notesSlides/notesSlide1.xml');

    const importedSlideId = imported.presentation.slides[0]?.slide_id ?? 0;
    const exported = exportImportedPresentation(imported, setSlideNotes(imported.presentation, importedSlideId, null));

    expect(readZip(exported.bytes).by_path.has('ppt/notesSlides/notesSlide1.xml')).toBe(false);
    const reopened = importPresentation(exported.bytes);
    expect(reopened.presentation.slides[0]?.notes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. 切版式落到 _rels（不再静默无效）
// ---------------------------------------------------------------------------

describe('P-I02 · 切版式', () => {
  it('改某页 layout_id ⇒ 只重写该页 _rels 的 slideLayout Target，其余页不动', () => {
    let deck = emptyPresentation('p1', '版式');
    deck = addSlide(deck).presentation;
    deck = addSlide(deck).presentation;
    // 两页用两个不同版式，让 render 产出 slideLayout1 / slideLayout2。
    deck = {
      ...deck,
      slides: deck.slides.map((slide, index) => ({
        ...slide,
        layout: { ...slide.layout, layout_id: index === 0 ? 'L1' : 'L2' },
      })),
    };
    const bytes = renderPresentation(deck).bytes;
    const imported = importPresentation(bytes);
    const first = imported.presentation.slides[0];
    const second = imported.presentation.slides[1];
    if (first === undefined || second === undefined) throw new Error('应有第 1、2 页');
    expect(first.layout.layout_id).not.toBe(second.layout.layout_id);

    const targetLayout = second.layout.layout_id;
    const edited: Presentation = {
      ...imported.presentation,
      slides: imported.presentation.slides.map((slide, index) =>
        index === 0 ? { ...slide, layout: { ...slide.layout, layout_id: targetLayout } } : slide,
      ),
    };

    const exported = exportImportedPresentation(imported, edited);
    // 只有第 1 页的 _rels 变，第 2 页的 _rels 逐字节不变。
    expect(exported.changed_part_paths).toEqual(['ppt/slides/_rels/slide1.xml.rels']);
    expect(partText(exported.bytes, 'ppt/slides/_rels/slide2.xml.rels')).toBe(
      partText(bytes, 'ppt/slides/_rels/slide2.xml.rels'),
    );
    // 重开读回版式确已切换。
    expect(importPresentation(exported.bytes).presentation.slides[0]?.layout.layout_id).toBe(targetLayout);
  });

  it('切到包内不存在的版式 ⇒ unknown_layout，不静默无效', () => {
    const imported = importPresentation(renderPresentation(singleSlideDeck()).bytes);
    const slide = imported.presentation.slides[0];
    if (slide === undefined) throw new Error('应有第 1 页');
    const edited: Presentation = {
      ...imported.presentation,
      slides: [{ ...slide, layout: { ...slide.layout, layout_id: 'slideLayout999' } }],
    };
    try {
      exportImportedPresentation(imported, edited);
      throw new Error('应当抛出 PresentationRoundTripError');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationRoundTripError);
      expect((error as PresentationRoundTripError).reason).toBe('unknown_layout');
    }
  });
});

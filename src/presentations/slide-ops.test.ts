/**
 * 幻灯片操作用例（PPT-02：新增 / 删除 / 复制 / 移动 / 隐藏、分节、版式切换；对象引用与页码正确）。
 *
 * ## 反向对照（本文件的核心）
 *
 * 「删除后 rId 与页码不得错位」的反面是**拿 `slide_id` 当页码**。用例特意同时打印/断言
 * 两个量：删掉第 2 页后，原 `slide_id=3` 的页**页码变成 2**，但它的 `slide_id` 仍是 3。
 * 任何"用 slide_id 当页码"或"复制后把副本扔到末尾"的实现都会在下面被断言挡住。
 *
 * ## 真实字节侧
 *
 * `renderPresentation` → `openPresentation` 读回 `p:sldIdLst` 解析出的部件顺序：删页后
 * 包内**恰好剩 2 个**幻灯片部件、且第 1/2 页分别指到 `slide1.xml` / `slide2.xml`
 * （rId 与页序一致，不指向已删页）。
 */

import { describe, expect, it } from 'vitest';

import { literalText, transform, type Presentation, type Shape } from './model.js';
import { addSlide, setSlideLayout } from './operations.js';
import { openPresentation } from './import.js';
import { emptyPresentation, renderPresentation } from './render.js';
import { importPresentation } from './roundtrip.js';
import { readZip } from '../artifacts/ooxml/index.js';
import {
  SlideOperationError,
  assignSlideToSection,
  assignSlidesToSection,
  copySlide,
  createSection,
  deleteSection,
  deleteSlide,
  hideSlide,
  insertSlide,
  locateSlide,
  pageIndexOf,
  pageNumberOf,
  pageNumbersById,
  relocateSlide,
  renameSection,
  reorderSections,
  sectionOfSlide,
  slideIdAtPage,
  slideOrder,
  slidesInSection,
  switchSlideLayout,
  toggleSlideHidden,
} from './slide-ops.js';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

function marker(text: string): Shape {
  return {
    kind: 'text_box',
    shape_id: 2,
    name: 'Marker',
    transform: transform(0, 0, 1000000, 500000),
    text: literalText(text),
  };
}

/** 造 n 页，每页一个写着 `M<slide_id>` 的文本框。 */
function deckWithMarkedSlides(count: number): Presentation {
  let deck = emptyPresentation('p1', '页码测试');
  for (let i = 0; i < count; i += 1) {
    const added = addSlide(deck);
    deck = added.presentation;
    const withShape = {
      ...deck,
      slides: deck.slides.map((slide) =>
        slide.slide_id === added.slide_id ? { ...slide, shapes: [marker(`M${String(added.slide_id)}`)] } : slide,
      ),
    };
    deck = withShape;
  }
  return deck;
}

function textOfFirstBox(presentation: Presentation, pageIndex: number): string {
  const shape = presentation.slides[pageIndex]?.shapes[0];
  if (shape?.kind !== 'text_box') throw new Error('第一页第一个对象应当是文本框');
  const run = shape.text.paragraphs[0]?.runs[0];
  if (run === undefined) throw new Error('文本框应当至少有一个 run');
  return run.source.kind === 'literal' ? run.source.text : '';
}

// ---------------------------------------------------------------------------
// 页码 vs. 对象引用
// ---------------------------------------------------------------------------

describe('PPT-02：页码是不随删除漂移的"位置"，slide_id 是不随页序漂移的"引用"', () => {
  it('删中间页：其余页 slide_id 不变，页码收紧（反向对照：拿 slide_id 当页码就会错位）', () => {
    const deck = deckWithMarkedSlides(3); // slide_id = [1, 2, 3]
    const afterDelete = deleteSlide(deck, 2);

    // 对象引用没变（页 3 的 slide_id 仍是 3，不是 2）。
    expect(slideOrder(afterDelete)).toEqual([1, 3]);
    // 页码按位置现算：slide_id=3 现在在第 2 页。
    expect(pageNumberOf(afterDelete, 3)).toBe(2);
    expect(pageIndexOf(afterDelete, 3)).toBe(1);
    expect(slideIdAtPage(afterDelete, 2)).toBe(3);

    // —— 反向对照：把 slide_id 当页码会得到 3，与真实页码 2 不符 ——
    expect(pageNumberOf(afterDelete, 3)).not.toBe(3);
    expect(afterDelete.slides[1]?.slide_id).toBe(3);
    // 第 3 页已不存在 ⇒ 拿它当页码必须报错，而不是静默返回空。
    expect(() => slideIdAtPage(afterDelete, 3)).toThrow(SlideOperationError);
  });

  it('复制插在原页之后：副本是新 id 且占据正确页码（反向对照：扔到末尾会被挡）', () => {
    const deck = deckWithMarkedSlides(3); // [1,2,3]
    const copied = copySlide(deck, 1); // 复制第 1 页 ⇒ 默认紧跟其后
    expect(copied.page_number).toBe(2);
    expect(slideOrder(copied.presentation)).toEqual([1, copied.slide_id, 2, 3]);
    expect(pageNumbersById(copied.presentation).get(copied.slide_id)).toBe(2);
    // 副本内容与源一致，但 id 不同。
    expect(textOfFirstBox(copied.presentation, 1)).toBe('M1');
    expect(copied.slide_id).not.toBe(1);

    // 指定落点：复制到最后一页。
    const atEnd = copySlide(deck, 1, { at: 4 });
    expect(atEnd.page_number).toBe(4);
    expect(pageNumberOf(atEnd.presentation, atEnd.slide_id)).toBe(4);
  });

  it('locateSlide 一次给出 slide_id / 页码 / 索引 三者', () => {
    const deck = deckWithMarkedSlides(3);
    expect(locateSlide(deck, 2)).toEqual({ slide_id: 2, page_number: 2, page_index: 1 });
    expect(() => locateSlide(deck, 99)).toThrow(SlideOperationError);
  });

  it('insertSlide 返回的页码正确；移动后页码随之更新', () => {
    const deck = deckWithMarkedSlides(2);
    const inserted = insertSlide(deck, { at: 1 });
    expect(inserted.page_number).toBe(1);
    expect(slideOrder(inserted.presentation)[0]).toBe(inserted.slide_id);

    const moved = relocateSlide(deck, 1, 2);
    expect(slideOrder(moved)).toEqual([2, 1]);
    expect(pageNumberOf(moved, 1)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 分节
// ---------------------------------------------------------------------------

describe('PPT-02：分节', () => {
  it('建节 / 归位 / 按页序 / 改名 / 删节（页保留）', () => {
    let deck = deckWithMarkedSlides(4);
    const created = createSection(deck, '第一部分');
    deck = created.presentation;
    const sectionId = created.section_id;
    expect(deck.sections.map((s) => s.section_id)).toEqual([sectionId]);

    // 先归 3 再归 1 ⇒ 内部仍按页序 [1, 3]。
    deck = assignSlideToSection(deck, 3, sectionId);
    deck = assignSlideToSection(deck, 1, sectionId);
    expect(slidesInSection(deck, sectionId)).toEqual([1, 3]);
    expect(sectionOfSlide(deck, 1)).toBe(sectionId);
    expect(sectionOfSlide(deck, 2)).toBeNull();

    // 一页至多属于一个分节：再归到另一个分节会从原分节摘出。
    const second = createSection(deck, '第二部分');
    deck = second.presentation;
    deck = assignSlideToSection(deck, 1, second.section_id);
    expect(slidesInSection(deck, sectionId)).toEqual([3]);
    expect(slidesInSection(deck, second.section_id)).toEqual([1]);

    deck = renameSection(deck, sectionId, '改过名的节');
    expect(deck.sections.find((s) => s.section_id === sectionId)?.name).toBe('改过名的节');

    // 删节：页还在，只是不再属于任何分节。
    const before = deck.slides.length;
    deck = deleteSection(deck, sectionId);
    expect(deck.sections.map((s) => s.section_id)).toEqual([second.section_id]);
    expect(deck.slides).toHaveLength(before);
    expect(sectionOfSlide(deck, 3)).toBeNull();
  });

  it('删除幻灯片会把该页从所有分节里摘掉（反向对照：残留已删 id 会被挡）', () => {
    let deck = deckWithMarkedSlides(4);
    const a = createSection(deck, 'A');
    deck = a.presentation;
    const b = createSection(deck, 'B');
    deck = b.presentation;
    deck = assignSlidesToSection(deck, [1, 2, 3], a.section_id);
    deck = assignSlidesToSection(deck, [2, 4], b.section_id); // 2 应从 A 摘出

    expect(slidesInSection(deck, a.section_id)).toEqual([1, 3]);
    expect(slidesInSection(deck, b.section_id)).toEqual([2, 4]);

    const after = deleteSlide(deck, 2);
    // 反向对照：若某分节仍留着 slide_id=2，这里会失败。
    for (const section of after.sections) {
      expect(section.slide_ids).not.toContain(2);
    }
    expect(slidesInSection(after, a.section_id)).toEqual([1, 3]);
    expect(slidesInSection(after, b.section_id)).toEqual([4]);
  });

  it('分节顺序重排必须恰好覆盖现有分节，否则报错', () => {
    let deck = deckWithMarkedSlides(1);
    deck = createSection(deck, 'A', { section_id: 'sa' }).presentation;
    deck = createSection(deck, 'B', { section_id: 'sb' }).presentation;

    const reordered = reorderSections(deck, ['sb', 'sa']);
    expect(reordered.sections.map((s) => s.section_id)).toEqual(['sb', 'sa']);

    expect(() => reorderSections(deck, ['sa'])).toThrow(SlideOperationError);
    expect(() => reorderSections(deck, ['sa', 'sc'])).toThrow(SlideOperationError);
    expect(() => createSection(deck, 'dup', { section_id: 'sa' })).toThrow(SlideOperationError);
    expect(() => createSection(deck, '   ')).toThrow(SlideOperationError);
  });
});

// ---------------------------------------------------------------------------
// 隐藏 / 版式
// ---------------------------------------------------------------------------

describe('PPT-02：隐藏与版式切换', () => {
  it('隐藏 / 显示 / 反转在模型层生效', () => {
    let deck = deckWithMarkedSlides(1);
    expect(deck.slides[0]?.hidden).toBe(false);
    deck = hideSlide(deck, 1);
    expect(deck.slides[0]?.hidden).toBe(true);
    deck = toggleSlideHidden(deck, 1);
    expect(deck.slides[0]?.hidden).toBe(false);
  });

  it('版式切换只改目标页的 layout 引用', () => {
    let deck = deckWithMarkedSlides(2);
    const layout = { master_id: 'master1', layout_id: 'title_and_content' };
    deck = switchSlideLayout(deck, 2, layout);
    expect(deck.slides[0]?.layout.layout_id).toBe('blank');
    expect(deck.slides[1]?.layout.layout_id).toBe('title_and_content');
    // 与原语一致。
    expect(setSlideLayout(deck, 1, layout).slides[0]?.layout.layout_id).toBe('title_and_content');
  });
});

// ---------------------------------------------------------------------------
// 真实字节：删页后 rId / 部件顺序不错位
// ---------------------------------------------------------------------------

describe('PPT-02：删页后包内 rId 与页序一致（真实字节读回）', () => {
  it('删中间页 ⇒ 恰好剩 2 个幻灯片部件，且页序指向 slide1/slide2（不指向已删页）', () => {
    const deck = deckWithMarkedSlides(3);
    const afterDelete = deleteSlide(deck, 2); // 剩 slide_id = [1, 3]
    const rendered = renderPresentation(afterDelete);

    const opened = openPresentation(rendered.bytes);
    expect(opened.slide_part_paths).toEqual(['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml']);

    // 读回模型：第 2 页承载的是**原第 3 页**的内容（内容随页序搬，不随 slide_id 留在旧位置）。
    const reread = importPresentation(rendered.bytes);
    expect(reread.presentation.slides).toHaveLength(2);
    expect(textOfFirstBox(reread.presentation, 0)).toBe('M1');
    expect(textOfFirstBox(reread.presentation, 1)).toBe('M3');
  });

  it('复制页后再渲染：部件数 = 页数，副本内容出现在副本页的位置上', () => {
    const deck = deckWithMarkedSlides(2);
    const copied = copySlide(deck, 2); // 复制第 2 页并紧跟其后
    const rendered = renderPresentation(copied.presentation);
    const opened = openPresentation(rendered.bytes);
    expect(opened.slide_part_paths).toHaveLength(3);
    const reread = importPresentation(rendered.bytes);
    expect(textOfFirstBox(reread.presentation, 2)).toBe('M2');
  });
});

// ---------------------------------------------------------------------------
// 已知缺口（如实记录，标"未接线"）
// ---------------------------------------------------------------------------

describe('PPT-02：隐藏态的导出接线（2026-10-03 已接线）', () => {
  it('隐藏页写进 p:sld@show="0"，导出读回后隐藏态保持（接线前是丢的）', () => {
    const deck = hideSlide(deckWithMarkedSlides(1), 1);
    expect(deck.slides[0]?.hidden).toBe(true); // 模型层确实置位

    const rendered = renderPresentation(deck);
    // 正向：导出侧真的发射了 `show="0"`（FA-PPT-WIRE 接线）。
    const archive = readZip(rendered.bytes);
    const slideXml = Buffer.from(archive.by_path.get('ppt/slides/slide1.xml')!.data).toString('utf8');
    expect(slideXml).toContain('show="0"');
    // 且导入读回为真（模型级往返闭合）。
    const reread = importPresentation(rendered.bytes);
    expect(reread.presentation.slides[0]?.hidden).toBe(true);
    // 反向对照：未隐藏的同一模型不得出现 show="0"（证明上面不是恒真）。
    const visible = renderPresentation(deckWithMarkedSlides(1));
    const visibleXml = Buffer.from(
      readZip(visible.bytes).by_path.get('ppt/slides/slide1.xml')!.data,
    ).toString('utf8');
    expect(visibleXml).not.toContain('show="0"');
  });
});

/**
 * P-I01 · `render.ts` 最终产物接线（集成波）定向验收。
 *
 * 本包把 P04/P05/P08 三个模块接进**真实渲染产物**，逐条钉住：
 *
 * - A. **对象动画 → `p:timing`**：模型有 `Slide.animations` 时，幻灯片部件里出现内联
 *      `p:timing`（P08 造块），且按 `CT_Slide` 顺序排在 `p:transition` 之后、`</p:sld>` 之前；
 *      无动画 ⇒ 不写（旧字节不变）。判据用 `readZip` 读**真实字节** + `parseXmlDocument` 独立解析。
 * - B. **连接符端点 → `a:stCxn` / `a:endCxn`**：绑定了始末形状的连接符，在 `p:cNvCxnSpPr`
 *      里写出端点（`id` = 被连形状 id）；未绑定 ⇒ 不写。
 * - C. **音视频整包**：含 `media` 形状的文稿经 `assembleAvMediaPackage` 产出，产物字节独立过
 *      `verifyAvMediaInPackage`（媒体部件 / 关系 / 放映时间 / 内容类型 Default 全对）。
 * - D. **媒体内容类型 Default-only**：媒体部件的扩展名有 `Default`，但**不再**有重复的部件 `Override`。
 * - E. **反向对照**：未提供旁表的 `media` 形状仍具名报 `unsupported_shape_kind`（不静默）。
 *
 * 边界：只做**字节级 + 解析级**校验；真机 PowerPoint / WPS 打开播放**未验证**（不触设备）。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/index.js';
import { applyAnimations, applyTransition } from '../../../../src/presentations/animation.js';
import { emptyAvMediaBoard, insertAvMedia } from '../../../../src/presentations/av-media.js';
import { mediaCatalog } from '../../../../src/presentations/media.js';
import {
  avPackageDeck,
  verifyAvMediaInPackage,
} from '../../../../src/presentations/media-parts/index.js';
import { literalText, transform, type Presentation, type Shape } from '../../../../src/presentations/model.js';
import { addShape, addSlide } from '../../../../src/presentations/operations.js';
import {
  PresentationRenderError,
  emptyPresentation,
  renderPresentation,
  renderSlidePartXml,
} from '../../../../src/presentations/render.js';
import { attributeOf, childElements, parseXmlDocument, type XmlElementNode } from '../../../../src/presentations/xml-parse.js';

// ---------------------------------------------------------------------------
// 独立工具（不复用被测渲染器的内部判断）
// ---------------------------------------------------------------------------

/** 从真实字节里取某部件的文本。 */
function entryText(bytes: Uint8Array, path: string): string {
  const archive = readZip(bytes);
  const entry = archive.by_path.get(path);
  if (entry === undefined) throw new Error(`包内没有部件 ${path}`);
  return Buffer.from(entry.data).toString('utf8');
}

/** 递归收集某限定名的元素（文档顺序）。 */
function collect(node: XmlElementNode, name: string, out: XmlElementNode[] = []): XmlElementNode[] {
  if (node.name === name) out.push(node);
  for (const child of childElements(node)) collect(child, name, out);
  return out;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const BOX = transform(100000, 200000, 3000000, 2000000);

function oneSlideDeck(id: string, title: string): Presentation {
  let deck = emptyPresentation(id, title);
  deck = addSlide(deck).presentation;
  return deck;
}

/** 一页 + 一个 id=2 的文本框（供动画 / 连接符用）。 */
function deckWithBox(): { deck: Presentation; slideId: number } {
  let deck = oneSlideDeck('p-i01', '接线');
  const slideId = deck.slides[0]?.slide_id ?? 0;
  const box: Shape = {
    kind: 'text_box',
    shape_id: 2,
    name: '标题',
    transform: transform(838200, 457200, 4000000, 1000000),
    text: literalText('标题'),
  };
  return { deck: addShape(deck, slideId, box), slideId };
}

// ---------------------------------------------------------------------------
// A. 对象动画 → p:timing
// ---------------------------------------------------------------------------

describe('P-I01 §A 动画接线：模型动画真的写进幻灯片 p:timing', () => {
  it('有动画 ⇒ slideN.xml 含内联 p:timing（tmRoot + spTgt 指向形状），且 XML 可解析', () => {
    const { deck, slideId } = deckWithBox();
    const animated = applyAnimations(deck, slideId, [
      { shape_id: 2, effect: 'fade', kind: 'entrance', trigger: 'on_click', duration_ms: 500, delay_ms: 0, direction: null },
    ]);

    const result = renderPresentation(animated);
    const slideXml = entryText(result.bytes, 'ppt/slides/slide1.xml');

    expect(slideXml).toContain('<p:timing>');
    // 独立解析：整页 XML 合法，且恰好一块 p:timing。
    const root = parseXmlDocument(slideXml);
    const timings = collect(root, 'p:timing');
    expect(timings.length).toBe(1);
    const cTns = collect(timings[0] as XmlElementNode, 'p:cTn');
    expect(cTns.some((node) => attributeOf(node, 'nodeType') === 'tmRoot')).toBe(true);
    expect(cTns.some((node) => attributeOf(node, 'nodeType') === 'mainSeq')).toBe(true);
    // 目标形状 id=2 出现在 p:spTgt/@spid。
    const targets = collect(timings[0] as XmlElementNode, 'p:spTgt');
    expect(targets.map((node) => attributeOf(node, 'spid'))).toContain('2');
    // 进入类 fade ⇒ 有可见性 p:set 与 p:animEffect。
    expect(collect(timings[0] as XmlElementNode, 'p:set').length).toBeGreaterThan(0);
    expect(collect(timings[0] as XmlElementNode, 'p:animEffect').length).toBeGreaterThan(0);
  });

  it('schema 顺序：有切换时 p:timing 排在 p:transition 之后、</p:sld> 之前', () => {
    const { deck, slideId } = deckWithBox();
    let timed = applyTransition(deck, slideId, { kind: 'fade', duration_ms: 1000 });
    timed = applyAnimations(timed, slideId, [
      { shape_id: 2, effect: 'appear', kind: 'entrance', trigger: 'on_click', duration_ms: 1, delay_ms: 0, direction: null },
    ]);

    const slideXml = entryText(renderPresentation(timed).bytes, 'ppt/slides/slide1.xml');
    const transitionAt = slideXml.indexOf('<p:transition');
    const timingAt = slideXml.indexOf('<p:timing>');
    const closeAt = slideXml.indexOf('</p:sld>');
    expect(transitionAt).toBeGreaterThanOrEqual(0);
    expect(timingAt).toBeGreaterThan(transitionAt);
    expect(timingAt).toBeLessThan(closeAt);
  });

  it('无动画 ⇒ 不写 p:timing（旧产物字节不变）', () => {
    const { deck } = deckWithBox();
    const slideXml = entryText(renderPresentation(deck).bytes, 'ppt/slides/slide1.xml');
    expect(slideXml).not.toContain('<p:timing');
  });

  it('renderSlidePartXml（roundtrip 复用的同一口径）同样带 p:timing', () => {
    const { deck, slideId } = deckWithBox();
    const animated = applyAnimations(deck, slideId, [
      { shape_id: 2, effect: 'fade', kind: 'entrance', trigger: 'on_click', duration_ms: 300, delay_ms: 0, direction: null },
    ]);
    const slide = animated.slides[0] as Presentation['slides'][number];
    const xml = renderSlidePartXml(slide, { snapshot: [], media_rel: () => 'rId1' });
    expect(xml).toContain('<p:timing>');
    expect(xml).not.toContain('<p:timing><p:timing>');
  });
});

// ---------------------------------------------------------------------------
// B. 连接符端点绑定 → a:stCxn / a:endCxn
// ---------------------------------------------------------------------------

describe('P-I01 §B 连接符接线：端点绑定写进 p:cNvCxnSpPr', () => {
  function connectorDeck(startId: number | null, endId: number | null): Presentation {
    let deck = oneSlideDeck('p-i01-c', '连接符');
    const slideId = deck.slides[0]?.slide_id ?? 0;
    const a: Shape = {
      kind: 'text_box', shape_id: 2, name: 'A',
      transform: transform(0, 0, 1000000, 1000000), text: literalText('A'),
    };
    const b: Shape = {
      kind: 'text_box', shape_id: 3, name: 'B',
      transform: transform(2000000, 0, 1000000, 1000000), text: literalText('B'),
    };
    const link: Shape = {
      kind: 'connector', shape_id: 4, name: 'Link',
      transform: transform(1000000, 500000, 1000000, 0),
      preset: 'line', outline: null, start_shape_id: startId, end_shape_id: endId,
    };
    deck = addShape(deck, slideId, a);
    deck = addShape(deck, slideId, b);
    return addShape(deck, slideId, link);
  }

  it('两端绑定 ⇒ a:stCxn/a:endCxn 带上被连形状 id（r:id-free spid 端点）', () => {
    const slideXml = entryText(renderPresentation(connectorDeck(2, 3)).bytes, 'ppt/slides/slide1.xml');
    expect(slideXml).toContain('<a:stCxn id="2" idx="0"/>');
    expect(slideXml).toContain('<a:endCxn id="3" idx="0"/>');

    // 结构化定位：端点在 p:cxnSp > p:nvCxnSpPr > p:cNvCxnSpPr 下（不是 p:spPr）。
    const root = parseXmlDocument(slideXml);
    const cxn = collect(root, 'p:cxnSp')[0] as XmlElementNode;
    const nv = collect(cxn, 'p:cNvCxnSpPr')[0] as XmlElementNode;
    const stCxn = collect(nv, 'a:stCxn')[0];
    const endCxn = collect(nv, 'a:endCxn')[0];
    expect(stCxn).toBeDefined();
    expect(endCxn).toBeDefined();
    expect(attributeOf(stCxn, 'id')).toBe('2');
    expect(attributeOf(endCxn, 'id')).toBe('3');
    // 端点里不得出现关系 id（a:stCxn 用形状 id，不是 r:id）。
    expect(attributeOf(stCxn, 'r:id')).toBeUndefined();
  });

  it('未绑定 ⇒ 不写 a:stCxn/a:endCxn（旧字节不变）', () => {
    const slideXml = entryText(renderPresentation(connectorDeck(null, null)).bytes, 'ppt/slides/slide1.xml');
    expect(slideXml).toContain('<p:cxnSp>');
    expect(slideXml).not.toContain('<a:stCxn');
    expect(slideXml).not.toContain('<a:endCxn');
  });
});

// ---------------------------------------------------------------------------
// C. 音视频整包装配 → 独立读回校验
// ---------------------------------------------------------------------------

describe('P-I01 §C 音视频：含 media 形状的文稿经整包装配器产出', () => {
  it('renderPresentation + av_board ⇒ 产物字节独立过 verifyAvMediaInPackage', () => {
    const deck = avPackageDeck(1, 'p-i01-av', '音视频');
    const inserted = insertAvMedia(deck, emptyAvMediaBoard(), mediaCatalog(), 1, {
      transform: BOX,
      media_path: 'ppt/media/clip1.mp4',
      bytes: MP4,
    });

    const result = renderPresentation(inserted.presentation, {
      media: inserted.catalog.parts,
      av_board: inserted.board,
    });

    // 独立读回校验（P05 的包级校验器，不抛即通过）。
    const report = verifyAvMediaInPackage(result.bytes);
    expect(report.problems).toEqual([]);
    expect(report.media_part_paths).toContain('ppt/media/clip1.mp4');
    expect(report.timing_slides).toContain('ppt/slides/slide1.xml');

    // 媒体真的在包里（字节逐字节相同），幻灯片里是真实音视频片段。
    const slide1 = entryText(result.bytes, 'ppt/slides/slide1.xml');
    expect(slide1).toContain('<a:videoFile');
    expect(slide1).toContain('<p14:media');
    expect(result.slide_count).toBe(1);
  });

  it('反向对照：有 media 形状但不给 av_board ⇒ 仍具名 unsupported_shape_kind', () => {
    const deck = avPackageDeck(1, 'p-i01-av2', '音视频');
    const inserted = insertAvMedia(deck, emptyAvMediaBoard(), mediaCatalog(), 1, {
      transform: BOX,
      media_path: 'ppt/media/clip1.mp4',
      bytes: MP4,
    });
    try {
      renderPresentation(inserted.presentation, { media: inserted.catalog.parts });
      throw new Error('应当抛出 PresentationRenderError');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationRenderError);
      expect((error as PresentationRenderError).reason).toBe('unsupported_shape_kind');
    }
  });
});

// ---------------------------------------------------------------------------
// D. 媒体内容类型 Default-only
// ---------------------------------------------------------------------------

describe('P-I01 §D 媒体内容类型：扩展名 Default 有、部件 Override 无', () => {
  function pictureDeck(): Presentation {
    let deck = oneSlideDeck('p-i01-img', '图片');
    const slideId = deck.slides[0]?.slide_id ?? 0;
    const pic: Shape = {
      kind: 'picture',
      shape_id: 2,
      name: 'Pic',
      transform: transform(0, 0, 1000000, 1000000),
      media_path: 'ppt/media/image1.png',
      alt_text: '',
      crop: null,
    };
    return addShape(deck, slideId, pic);
  }

  it('png 有 Default、无 Override；业务部件 Override 仍在', () => {
    const result = renderPresentation(pictureDeck(), {
      media: [{ path: 'ppt/media/image1.png', bytes: PNG }],
    });
    const contentTypes = entryText(result.bytes, '[Content_Types].xml');
    expect(contentTypes).toContain('<Default Extension="png"');
    expect(contentTypes).not.toContain('PartName="/ppt/media/image1.png"');
    // 非媒体部件不受影响：幻灯片仍以 Override 声明。
    expect(contentTypes).toContain('<Override PartName="/ppt/slides/slide1.xml"');
    // 结构合法：Default 全在 Override 之前。
    expect(contentTypes.indexOf('<Default')).toBeLessThan(contentTypes.indexOf('<Override'));
  });

  it('无媒体 ⇒ 内容类型里既无 png Default 也无媒体 Override（旧字节不变）', () => {
    const result = renderPresentation(oneSlideDeck('p-i01-plain', '纯文本'));
    const contentTypes = entryText(result.bytes, '[Content_Types].xml');
    expect(contentTypes).not.toContain('Extension="png"');
    expect(contentTypes).toContain('<Override PartName="/ppt/slides/slide1.xml"');
  });
});

/**
 * P-I05 · 时序块（`p:timing`）**无损**定向验收（PPT-11 集成波）。
 *
 * ## 本单元修的缺陷（P08 如实钉住的两种有损）
 *
 * 1. `appear` 的时长写侧恒 `dur=1` ⇒ 读回丢原始时长；
 * 2. `after_previous` 写侧落**组内绝对延迟** ⇒ 读回得到绝对值而非原始相对延迟。
 *
 * 本套件把这两类**原先有损**的情况纳入 `render → inject（真幻灯片 XML）→ parse` 闭合：读回必须与
 * 源规格**逐字段相等**（含 `duration_ms` / `delay_ms`）。同时保留 P08 既有的幂等、schema 顺序、
 * 清空反向对照与具名报错负例。
 *
 * ## 判据不靠"看起来像"
 *
 * - 注入发生在 `render.renderSlidePartXml` 产出的**真**幻灯片上（P01 装配同款函数），不是手写样例串；
 * - 写侧产物里 `appear` 的 `p:set@p:cTn@dur` 是**真实时长**，`after_previous` 的 `p:cond@delay` 是
 *   **组内绝对值**——两条都直接对原始 XML 断言，证明"写的是真值/绝对、读的是相对"是设计而非巧合；
 * - 媒体自动播放 seam（`p:video` / `p:audio`）单独闭合，并验证与形状效果合成同一棵树。
 *
 * ## 未验证
 *
 * 真机 PowerPoint / WPS 打开并**播放**未验证（无消费端、无设备）——本套件只到 XML 结构 / 字符串字节级。
 */

import { describe, expect, it } from 'vitest';

import {
  applyAnimations,
  type AnimationEffectName,
  type AnimationKind,
  type AnimationSpec,
  type AnimationTrigger,
} from '../../../../src/presentations/animation.js';
import {
  DEFAULT_AV_PLAYBACK,
  renderAvMediaTimingXml,
  type AvMediaItem,
} from '../../../../src/presentations/av-media.js';
import { addSlide, setSlideTransition } from '../../../../src/presentations/operations.js';
import {
  emptyPresentation,
  renderSlidePartXml,
  type SlideRenderContext,
} from '../../../../src/presentations/render.js';
import {
  attributeOf,
  childElements,
  firstElement,
  parseXmlDocument,
  type XmlElementNode,
} from '../../../../src/presentations/xml-parse.js';
import {
  TimingPartsError,
  addTiming,
  applyTimingDescriptor,
  clearAllTiming,
  clearTiming,
  countTimingEffects,
  findTiming,
  hasTiming,
  injectTiming,
  makeTimingTarget,
  parseMediaTimingXml,
  parseTimingTreeXml,
  parseTimingXml,
  removeTiming,
  renderMediaAutoplayTimingXml,
  renderSlideTimingXmlLossless,
  renderTimingTreeXml,
  renderTimingXmlLossless,
  setTiming,
  stripTiming,
  timingDescriptorFor,
  timingPaths,
  validateTimingRegistry,
  type MediaTimingSpec,
  type TimingDescriptor,
} from '../../../../src/presentations/timing-parts/index.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const SLIDE_PATH = 'ppt/slides/slide1.xml';

function ctx(): SlideRenderContext {
  return { snapshot: [], media_rel: (path) => path };
}

/** 一页真幻灯片（P01 装配同款函数产出）。 */
function deck(): { readonly xml: string; readonly slideId: number } {
  const added = addSlide(emptyPresentation('p1', '测试文稿'));
  const slide = added.presentation.slides[0]!;
  return { xml: renderSlidePartXml(slide, ctx()), slideId: slide.slide_id };
}

/** 带切换的一页。 */
function deckWithTransition(kind = 'push', durationMs = 800): string {
  const added = addSlide(emptyPresentation('p1', '测试文稿'));
  const withT = setSlideTransition(added.presentation, 1, { kind, duration_ms: durationMs });
  return renderSlidePartXml(withT.slides[0]!, ctx());
}

/** 造一条规格（不填 `direction`；读回不产 `direction`，避免引入非闭合字段）。 */
function spec(
  shape_id: number,
  effect: AnimationEffectName,
  kind: AnimationKind,
  trigger: AnimationTrigger,
  duration_ms: number,
  delay_ms = 0,
): AnimationSpec {
  return { shape_id, effect, kind, trigger, duration_ms, delay_ms };
}

/** 从幻灯片 XML 里取出 `p:timing` 片段（首个开始标签到其结束标签）。 */
function timingBlockOf(slideXml: string): string {
  const open = slideXml.indexOf('<p:timing');
  expect(open).toBeGreaterThanOrEqual(0);
  const close = slideXml.indexOf('</p:timing>', open);
  expect(close).toBeGreaterThanOrEqual(0);
  return slideXml.slice(open, close + '</p:timing>'.length);
}

/** 收集后代元素。 */
function descendants(node: XmlElementNode, name: string): XmlElementNode[] {
  const out: XmlElementNode[] = [];
  const walk = (current: XmlElementNode): void => {
    for (const child of current.children) {
      if (child.kind !== 'element') continue;
      if (child.name === name) out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

function mediaSpec(overrides: Partial<MediaTimingSpec> = {}): MediaTimingSpec {
  return {
    shape_id: 7,
    media_kind: 'video',
    autoplay: true,
    loop: false,
    volume: 80000,
    muted: false,
    show_controls: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. appear 时长无损
// ---------------------------------------------------------------------------

describe('P-I05 无损闭合：appear 的真时长', () => {
  it('appear 进入 500ms：写侧 p:set 落真值，render→inject→parse 逐字段相等', () => {
    const { xml: slideXml } = deck();
    const specs = [spec(2, 'appear', 'entrance', 'on_click', 500)];

    const injected = applyTimingDescriptor(slideXml, timingDescriptorFor(SLIDE_PATH, 1, specs));
    const block = timingBlockOf(injected);

    // 写侧确实把真时长写进可见性 p:set 的 cTn@dur（不是旧的恒 1）。
    const setNode = descendants(parseXmlDocument(block), 'p:set')[0]!;
    const dur = attributeOf(firstElement(firstElement(setNode, 'p:cBhvr'), 'p:cTn'), 'dur');
    expect(dur).toBe('500');

    // 读回与源规格相等（含 duration_ms，这是原先有损的一档）。
    expect([...parseTimingXml(block)]).toEqual(specs);
  });

  it('appear 退出 250ms 也无损', () => {
    const { xml: slideXml } = deck();
    const specs = [spec(3, 'appear', 'exit', 'on_click', 250)];
    const injected = applyTimingDescriptor(slideXml, timingDescriptorFor(SLIDE_PATH, 1, specs));
    expect([...parseTimingXml(timingBlockOf(injected))]).toEqual(specs);
  });

  it('appear 时长 0 也如实读回 0（不是默认 1）', () => {
    const specs = [spec(4, 'appear', 'entrance', 'on_click', 0)];
    expect([...parseTimingXml(renderTimingXmlLossless(specs))]).toEqual(specs);
  });

  it('模型页桥 renderSlideTimingXmlLossless：appear 时长经模型往返仍无损', () => {
    const added = addSlide(emptyPresentation('p1', 't'));
    const withAnim = applyAnimations(added.presentation, 1, [
      spec(2, 'appear', 'entrance', 'on_click', 550),
      spec(3, 'flyIn', 'entrance', 'after_previous', 300, 0),
    ]);

    const readBack = parseTimingXml(renderSlideTimingXmlLossless(withAnim.slides[0]!));
    expect(readBack.map((s) => s.shape_id)).toEqual([2, 3]);
    expect(readBack.map((s) => s.effect)).toEqual(['appear', 'flyIn']);
    expect(readBack[0]!.duration_ms).toBe(550);
  });
});

// ---------------------------------------------------------------------------
// 2. after_previous 相对延迟无损
// ---------------------------------------------------------------------------

describe('P-I05 无损闭合：after_previous 的相对延迟', () => {
  it('组内绝对：写侧 p:cond@delay 是前序累计 600，读回却是源相对值 0', () => {
    const { xml: slideXml } = deck();
    const specs = [spec(2, 'fade', 'entrance', 'on_click', 600), spec(3, 'flyIn', 'entrance', 'after_previous', 300, 0)];

    const injected = applyTimingDescriptor(slideXml, timingDescriptorFor(SLIDE_PATH, 1, specs));
    const block = timingBlockOf(injected);

    // 写侧：afterEffect 起点落组内绝对延迟 600（放映语义：兄弟 par 按父组起点绝对偏移）。
    expect(block).toContain('delay="600"');
    // 读侧：反推回源相对延迟 0 —— 这才叫无损。
    expect([...parseTimingXml(block)]).toEqual(specs);
  });

  it('非零相对延迟：源 delay 150 在绝对 750 之后被还原', () => {
    const { xml: slideXml } = deck();
    const specs = [spec(2, 'fade', 'entrance', 'on_click', 600), spec(3, 'spin', 'emphasis', 'after_previous', 400, 150)];

    const injected = applyTimingDescriptor(slideXml, timingDescriptorFor(SLIDE_PATH, 1, specs));
    const block = timingBlockOf(injected);

    expect(block).toContain('delay="750"');
    const readBack = parseTimingXml(block);
    expect(readBack[1]!.delay_ms).toBe(150);
    expect([...readBack]).toEqual(specs);
  });

  it('with_previous 夹在中间时游标仍同步（多效果一组）', () => {
    const { xml: slideXml } = deck();
    const specs = [
      spec(2, 'fade', 'entrance', 'on_click', 600, 0),
      spec(3, 'grow', 'emphasis', 'with_previous', 400, 0),
      spec(4, 'spin', 'emphasis', 'after_previous', 200, 120),
      spec(5, 'wipe', 'entrance', 'after_previous', 300, 0),
    ];

    const injected = applyTimingDescriptor(slideXml, timingDescriptorFor(SLIDE_PATH, 1, specs));
    expect([...parseTimingXml(timingBlockOf(injected))]).toEqual(specs);
  });

  it('多点击组 + 全效果名混合：整段闭合逐字段相等', () => {
    const { xml: slideXml } = deck();
    const specs = [
      spec(2, 'appear', 'entrance', 'on_click', 450),
      spec(3, 'fade', 'entrance', 'with_previous', 300),
      spec(4, 'flyIn', 'entrance', 'after_previous', 500, 100),
      spec(5, 'spin', 'emphasis', 'on_click', 700),
      spec(6, 'grow', 'emphasis', 'with_previous', 250, 50),
      spec(7, 'pulse', 'emphasis', 'after_previous', 350, 200),
      spec(8, 'zoom', 'entrance', 'on_click', 600),
      spec(9, 'wipe', 'exit', 'after_previous', 400, 0),
    ];

    const injected = applyTimingDescriptor(slideXml, timingDescriptorFor(SLIDE_PATH, 1, specs));
    expect([...parseTimingXml(timingBlockOf(injected))]).toEqual(specs);
  });
});

// ---------------------------------------------------------------------------
// 3. 媒体自动播放 seam（P05 media-parts）
// ---------------------------------------------------------------------------

describe('P-I05 媒体 seam：p:video / p:audio 自动播放时序', () => {
  it('视频自动播放 + 循环 + 音量/静音/控件 往返无损', () => {
    const spec = mediaSpec({ media_kind: 'video', autoplay: true, loop: true, volume: 65000, muted: true, show_controls: false });
    const xml = renderMediaAutoplayTimingXml(spec);

    expect(xml).toContain('<p:video>');
    expect(xml).toContain('repeatCount="indefinite"');
    expect([...parseMediaTimingXml(xml)]).toEqual([spec]);
  });

  it('音频点击播放（非自动）：delay=indefinite 读回 autoplay=false', () => {
    const spec = mediaSpec({ shape_id: 11, media_kind: 'audio', autoplay: false, loop: false });
    const xml = renderMediaAutoplayTimingXml(spec);

    expect(xml).toContain('<p:audio>');
    expect(xml).toContain('delay="indefinite"');
    expect([...parseMediaTimingXml(xml)]).toEqual([spec]);
  });

  it('媒体时序注入真幻灯片 → 从注入块读回一致', () => {
    const { xml: slideXml } = deck();
    const spec = mediaSpec({ shape_id: 6, autoplay: true, loop: true, volume: 100000 });
    const injected = applyTimingDescriptor(slideXml, { xml: renderMediaAutoplayTimingXml(spec) });

    expect(hasTiming(injected)).toBe(true);
    // 形状读回为空（这页没有形状动画），媒体读回一条。
    const tree = parseTimingTreeXml(timingBlockOf(injected));
    expect(tree.shapes).toEqual([]);
    expect([...tree.media]).toEqual([spec]);
  });

  it('形状效果与媒体条目合成同一棵 p:timing，两类都读回', () => {
    const shapeSpecs = [spec(2, 'fade', 'entrance', 'on_click', 600), spec(3, 'flyIn', 'entrance', 'after_previous', 300, 0)];
    const media = [mediaSpec({ shape_id: 9, media_kind: 'video', autoplay: true })];
    const xml = renderTimingTreeXml(shapeSpecs, media);

    const tree = parseTimingTreeXml(xml);
    expect([...tree.shapes]).toEqual(shapeSpecs);
    expect([...tree.media]).toEqual(media);

    // 合成树里形状点击组仍在（mainSeq 保留），媒体节点也在。
    expect(xml).toContain('nodeType="mainSeq"');
    expect(xml).toContain('<p:video>');
  });

  it('seam 能读回 P05 av-media 的真实产物（跨模块）', () => {
    const item: AvMediaItem = {
      media_id: 'm1',
      slide_id: 1,
      shape_id: 12,
      media_path: 'ppt/media/movie.mp4',
      kind: 'video',
      declared: 'embedded',
      cover: null,
      playback: { ...DEFAULT_AV_PLAYBACK, autoplay: true, loop: true, volume: 42000, muted: true, show_controls: false },
      alt_text: '',
    };
    const parsed = parseMediaTimingXml(renderAvMediaTimingXml(item, item.shape_id));
    expect([...parsed]).toEqual([
      { shape_id: 12, media_kind: 'video', autoplay: true, loop: true, volume: 42000, muted: true, show_controls: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. 既有对照保留：幂等 / schema 顺序 / 清空
// ---------------------------------------------------------------------------

describe('P-I05 保留对照：幂等 / schema 顺序 / 清空', () => {
  it('幂等：反复注入不堆叠多块 p:timing', () => {
    const { xml: slideXml } = deck();
    const desc = timingDescriptorFor(SLIDE_PATH, 1, [spec(2, 'appear', 'entrance', 'on_click', 500)]);
    const once = applyTimingDescriptor(slideXml, desc);
    const twice = applyTimingDescriptor(once, desc);
    expect(twice).toBe(once);
    expect(twice.split('<p:timing').length - 1).toBe(1);
  });

  it('schema 顺序：有切换时 p:clrMapOvr < p:transition < p:timing < </p:sld>', () => {
    const slideXml = deckWithTransition('push');
    const injected = applyTimingDescriptor(slideXml, timingDescriptorFor(SLIDE_PATH, 1, [spec(2, 'fade', 'entrance', 'on_click', 400)]));
    const iClr = injected.indexOf('<p:clrMapOvr');
    const iTrans = injected.indexOf('<p:transition');
    const iTiming = injected.indexOf('<p:timing');
    const iClose = injected.lastIndexOf('</p:sld>');

    expect(iClr).toBeGreaterThanOrEqual(0);
    expect(iTrans).toBeGreaterThan(iClr);
    expect(iTiming).toBeGreaterThan(iTrans);
    expect(iClose).toBeGreaterThan(iTiming);

    const direct = childElements(parseXmlDocument(injected)).map((child) => child.name);
    expect(direct).toContain('p:timing');
    expect(direct.indexOf('p:timing')).toBeGreaterThan(direct.indexOf('p:transition'));
  });

  it('清空反向对照：时序树无 spTgt/animEffect，但 mainSeq 仍在、仍是合法 p:timing', () => {
    const { xml: slideXml } = deck();
    const empty = timingDescriptorFor(SLIDE_PATH, 1, []);
    expect(empty.empty).toBe(true);
    expect(empty.effect_count).toBe(0);

    const block = timingBlockOf(applyTimingDescriptor(slideXml, empty));
    const root = parseXmlDocument(block);
    expect(root.name).toBe('p:timing');
    expect(descendants(root, 'p:spTgt')).toHaveLength(0);
    expect(descendants(root, 'p:animEffect')).toHaveLength(0);
    expect(countTimingEffects(block)).toBe(0);
    expect(descendants(root, 'p:cTn').some((n) => attributeOf(n, 'nodeType') === 'mainSeq')).toBe(true);
  });

  it('登记表：add 重复抛 duplicate；set 覆盖；clear 变空块；remove 删条目；clearAll', () => {
    const desc = timingDescriptorFor(SLIDE_PATH, 1, [spec(2, 'fade', 'entrance', 'on_click', 400)]);
    let reg = addTiming({ entries: [] }, desc);
    expect(timingPaths(reg)).toEqual([SLIDE_PATH]);

    try {
      addTiming(reg, desc);
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as TimingPartsError).reason).toBe('duplicate_timing_entry');
    }

    reg = setTiming(reg, timingDescriptorFor(SLIDE_PATH, 1, [spec(2, 'fade', 'entrance', 'on_click', 400), spec(3, 'spin', 'emphasis', 'with_previous', 300)]));
    expect(findTiming(reg, SLIDE_PATH)?.effect_count).toBe(2);

    reg = clearTiming(reg, SLIDE_PATH);
    const cleared = findTiming(reg, SLIDE_PATH)!;
    expect(cleared.empty).toBe(true);
    expect(countTimingEffects(cleared.xml)).toBe(0);

    reg = removeTiming(reg, SLIDE_PATH);
    expect(timingPaths(reg)).toEqual([]);
    try {
      removeTiming(reg, SLIDE_PATH);
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as TimingPartsError).reason).toBe('unknown_timing_entry');
    }
  });

  it('clearAllTiming：每页都变空块', () => {
    let reg = addTiming({ entries: [] }, timingDescriptorFor('ppt/slides/slide1.xml', 1, [spec(2, 'fade', 'entrance', 'on_click', 400)]));
    reg = addTiming(reg, timingDescriptorFor('ppt/slides/slide2.xml', 2, [spec(3, 'fade', 'entrance', 'on_click', 400)]));
    const cleared = clearAllTiming(reg);
    expect(cleared.entries.every((entry) => entry.empty && entry.effect_count === 0)).toBe(true);
    expect(timingPaths(cleared)).toEqual(['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml']);
  });
});

// ---------------------------------------------------------------------------
// 5. 具名报错负例（不静默降级）
// ---------------------------------------------------------------------------

describe('P-I05 负例：具名报错（不静默降级）', () => {
  it('注入不是 p:timing 的片段 ⇒ invalid_timing_xml', () => {
    const { xml: slideXml } = deck();
    try {
      injectTiming(slideXml, '<p:transition spd="med"/>');
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as TimingPartsError).reason).toBe('invalid_timing_xml');
    }
  });

  it('注入非法 XML ⇒ invalid_timing_xml（不产出半块）', () => {
    const { xml: slideXml } = deck();
    try {
      injectTiming(slideXml, '<p:timing><p:tnLst>');
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as TimingPartsError).reason).toBe('invalid_timing_xml');
    }
  });

  it('目标页不是 p:sld ⇒ missing_slide_root', () => {
    try {
      injectTiming('<not-slide><a/></not-slide>', renderTimingXmlLossless([]));
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as TimingPartsError).reason).toBe('missing_slide_root');
    }
  });

  it('非法页路径 / id ⇒ invalid_slide_path', () => {
    expect(() => makeTimingTarget('../etc', 1)).toThrowError(TimingPartsError);
    expect(() => makeTimingTarget('/abs/slide1.xml', 1)).toThrowError(TimingPartsError);
    expect(() => makeTimingTarget(SLIDE_PATH, 0)).toThrowError(TimingPartsError);
  });

  it('stripTiming 对没有时序的页恒等；清除未登记页 ⇒ unknown_timing_entry', () => {
    const { xml: slideXml } = deck();
    expect(stripTiming(slideXml)).toBe(slideXml);
    try {
      clearTiming({ entries: [] }, SLIDE_PATH);
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as TimingPartsError).reason).toBe('unknown_timing_entry');
    }
  });

  it('validateTimingRegistry：描述符自报条数与独立读回打架 ⇒ invalid_timing_xml', () => {
    const honest = timingDescriptorFor(SLIDE_PATH, 1, [spec(2, 'fade', 'entrance', 'on_click', 400)]);
    expect(validateTimingRegistry({ entries: [honest] }, parseTimingXml)).toBe(1);

    const lying: TimingDescriptor = { ...honest, effect_count: 99 };
    try {
      validateTimingRegistry({ entries: [lying] }, parseTimingXml);
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as TimingPartsError).reason).toBe('invalid_timing_xml');
    }
  });

  it('写侧非法规格 ⇒ invalid_animation_spec / invalid_media_spec', () => {
    // 未知效果名（绕过类型：运行时才暴露）。
    expect(() => renderTimingXmlLossless([{ shape_id: 2, effect: 'nope' as AnimationEffectName, kind: 'entrance', trigger: 'on_click', duration_ms: 100, delay_ms: 0 }])).toThrowError(TimingPartsError);
    // 负时长
    expect(() => renderTimingXmlLossless([spec(2, 'fade', 'entrance', 'on_click', -1)])).toThrowError(TimingPartsError);

    // 媒体类型非法
    expect(() => renderMediaAutoplayTimingXml(mediaSpec({ media_kind: 'gif' as 'video' }))).toThrowError(TimingPartsError);
    // 音量越界
    expect(() => renderMediaAutoplayTimingXml(mediaSpec({ volume: 200000 }))).toThrowError(TimingPartsError);
    try {
      renderMediaAutoplayTimingXml(mediaSpec({ volume: 200000 }));
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as TimingPartsError).reason).toBe('invalid_media_spec');
    }
  });
});

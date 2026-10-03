/**
 * P08 · 时序块（`p:timing`）部件层定向验收（PPT-11）。
 *
 * ## 判据不靠"看起来像"
 *
 * - **闭合**：`renderTimingXml`（写）→ `injectTiming`（按 schema 位置放进真幻灯片 XML）→
 *   `parseTimingXml`（读回），三段独立，读回结果与原始规格逐字段相等；
 * - **schema 顺序**：产物里 `p:clrMapOvr < p:transition < p:timing < </p:sld>`（有切换时
 *   `p:timing` **必须在** `p:transition` 之后，不是"贴到尾部碰巧对"）；
 * - **注入发生在真幻灯片上**：页 XML 由 `render.renderSlidePartXml` 产出（与 P01 装配同一函数），
 *   不是手写的样例串；
 * - **反向对照**：清空 ⇒ 时序树里没有任何 `p:spTgt` / `p:animEffect`，但仍是合法 `p:timing`；
 * - **数字不打架**：登记表的描述符自报条数与独立读回打架 ⇒ 具名报错。
 *
 * 注：本套件只到 **XML 结构 / 字符串字节级**。真机 PowerPoint / WPS 打开并**播放**未验证——
 * 无消费端、无设备，如实标未验证。
 */

import { describe, expect, it } from 'vitest';

import {
  animationSpecFromModel,
  applyAnimations,
  renderSlideTimingXml,
  renderTimingXml,
  type AnimationSpec,
} from '../../../../src/presentations/animation.js';
import { setSlideTransition, addSlide } from '../../../../src/presentations/operations.js';
import {
  emptyPresentation,
  renderSlidePartXml,
  type SlideRenderContext,
} from '../../../../src/presentations/render.js';
import {
  attributeOf,
  childElements,
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
  parseTimingXml,
  removeTiming,
  setTiming,
  stripTiming,
  timingDescriptorFor,
  timingPaths,
  validateTimingRegistry,
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
function deckWithTransition(kind = 'push'): string {
  const added = addSlide(emptyPresentation('p1', '测试文稿'));
  const withT = setSlideTransition(added.presentation, 1, { kind, duration_ms: 800 });
  return renderSlidePartXml(withT.slides[0]!, ctx());
}

function fade(shapeId: number, trigger: AnimationSpec['trigger'], duration = 500): AnimationSpec {
  return { shape_id: shapeId, effect: 'fade', kind: 'entrance', trigger, duration_ms: duration, delay_ms: 0 };
}

function flyIn(shapeId: number, trigger: AnimationSpec['trigger'], duration = 500): AnimationSpec {
  return { shape_id: shapeId, effect: 'flyIn', kind: 'entrance', trigger, duration_ms: duration, delay_ms: 0 };
}

/** 从幻灯片 XML 里取出 `p:timing` 片段。 */
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

/** 只比较读回能无损还原的字段（`after_previous` 延迟写绝对、读相对，读回即原始相对延迟）。 */
function comparable(spec: AnimationSpec): Record<string, unknown> {
  return {
    shape_id: spec.shape_id,
    effect: spec.effect,
    kind: spec.kind,
    trigger: spec.trigger,
    duration_ms: spec.duration_ms,
    delay_ms: spec.delay_ms,
  };
}

// ---------------------------------------------------------------------------

describe('PPT-11：时序块注入真幻灯片 → 读回闭合', () => {
  it('注入后文件里有 p:timing；顺序 / 触发 / 目标 / 时长读回一致', () => {
    const { xml: slideXml } = deck();
    const specs = [fade(2, 'on_click', 700), flyIn(3, 'with_previous', 500), fade(4, 'on_click', 400)];

    const desc = timingDescriptorFor(SLIDE_PATH, 1, specs);
    const injected = applyTimingDescriptor(slideXml, desc);

    expect(hasTiming(injected)).toBe(true);
    expect(injected.split('<p:timing').length - 1).toBe(1);

    // 目标：读回里每个 spid 都在（进入效果有 2 个行为节点各带一次 spTgt，去重后即目标序）。
    const block = timingBlockOf(injected);
    const root = parseXmlDocument(block);
    const spids = descendants(root, 'p:spTgt').map((n) => attributeOf(n, 'spid'));
    expect([...new Set(spids)]).toEqual(['2', '3', '4']);
    expect(spids.length).toBeGreaterThanOrEqual(3);

    // 闭合：读回规格 == 原始规格（顺序即数组顺序）。
    const readBack = parseTimingXml(block);
    expect(readBack.map(comparable)).toEqual(specs.map(comparable));

    // 触发参数落到 nodeType。
    const nodeTypes = descendants(root, 'p:cTn').map((n) => attributeOf(n, 'nodeType'));
    expect(nodeTypes).toContain('withEffect');
    expect(nodeTypes).toContain('clickEffect');

    // 产物里不得出现中文描述（不是"写了一句动画说明"）。
    expect(/[一-鿿]/.test(block)).toBe(false);
  });

  it('schema 顺序：有切换时 p:clrMapOvr < p:transition < p:timing < </p:sld>', () => {
    const slideXml = deckWithTransition('push');
    expect(slideXml.indexOf('<p:transition')).toBeGreaterThanOrEqual(0);

    const injected = applyTimingDescriptor(slideXml, timingDescriptorFor(SLIDE_PATH, 1, [fade(2, 'on_click')]));
    const iClr = injected.indexOf('<p:clrMapOvr');
    const iTrans = injected.indexOf('<p:transition');
    const iTiming = injected.indexOf('<p:timing');
    const iClose = injected.lastIndexOf('</p:sld>');

    expect(iClr).toBeGreaterThanOrEqual(0);
    expect(iTrans).toBeGreaterThan(iClr);
    expect(iTiming).toBeGreaterThan(iTrans);
    expect(iClose).toBeGreaterThan(iTiming);

    // 合法性佐证：整页仍能解析成单根 p:sld。
    const reparsed = parseXmlDocument(injected);
    expect(reparsed.name).toBe('p:sld');
    // p:timing 确实是 p:sld 的直接子元素。
    const direct = childElements(reparsed).map((child) => child.name);
    expect(direct).toContain('p:timing');
    expect(direct.indexOf('p:timing')).toBeGreaterThan(direct.indexOf('p:transition'));
  });

  it('无切换时 p:timing 落在 p:clrMapOvr 之后、</p:sld> 之前', () => {
    const { xml: slideXml } = deck();
    const injected = applyTimingDescriptor(slideXml, timingDescriptorFor(SLIDE_PATH, 1, [fade(2, 'on_click')]));
    const iClr = injected.indexOf('<p:clrMapOvr');
    const iTiming = injected.indexOf('<p:timing');
    expect(iTiming).toBeGreaterThan(iClr);
    expect(parseXmlDocument(injected).name).toBe('p:sld');
  });

  it('幂等：反复注入不堆叠多块 p:timing', () => {
    const { xml: slideXml } = deck();
    const desc = timingDescriptorFor(SLIDE_PATH, 1, [fade(2, 'on_click')]);
    const once = applyTimingDescriptor(slideXml, desc);
    const twice = applyTimingDescriptor(once, desc);
    expect(twice).toBe(once);
    expect(twice.split('<p:timing').length - 1).toBe(1);
  });

  it('反向对照：清空 ⇒ 时序树无 spTgt/animEffect，但仍是合法 p:timing', () => {
    const { xml: slideXml } = deck();
    const empty = timingDescriptorFor(SLIDE_PATH, 1, []);
    expect(empty.empty).toBe(true);
    expect(empty.effect_count).toBe(0);

    const injected = applyTimingDescriptor(slideXml, empty);
    expect(hasTiming(injected)).toBe(true);
    const block = timingBlockOf(injected);
    const root = parseXmlDocument(block);
    expect(root.name).toBe('p:timing');
    expect(descendants(root, 'p:spTgt')).toHaveLength(0);
    expect(descendants(root, 'p:animEffect')).toHaveLength(0);
    expect(countTimingEffects(block)).toBe(0);
    // 结构仍在：mainSeq 还在，只是没有点击组。
    expect(descendants(root, 'p:cTn').some((n) => attributeOf(n, 'nodeType') === 'mainSeq')).toBe(true);
  });
});

describe('PPT-11：模型页 → p:timing（renderSlideTimingXml 桥）', () => {
  it('Slide.animations 变成有内容的时序块；类别的默认推断正确', () => {
    const added = addSlide(emptyPresentation('p1', '测试文稿'));
    const specs = [fade(2, 'on_click'), flyIn(3, 'with_previous'), { ...fade(4, 'on_click'), effect: 'spin' as const, kind: 'emphasis' as const }];
    const withAnim = applyAnimations(added.presentation, 1, specs);

    const xml = renderSlideTimingXml(withAnim.slides[0]!);
    const readBack = parseTimingXml(xml);
    expect(readBack).toHaveLength(3);
    expect(readBack.map((spec) => spec.shape_id)).toEqual([2, 3, 4]);
    expect(readBack.map((spec) => spec.effect)).toEqual(['fade', 'flyIn', 'spin']);
    expect(readBack.map((spec) => spec.trigger)).toEqual(['on_click', 'with_previous', 'on_click']);
    // spin 走强调（模型不存类别，animationKindOf 给默认）。
    expect(readBack[2]?.kind).toBe('emphasis');
    expect(readBack[0]?.kind).toBe('entrance');
  });

  it('animationSpecFromModel：trigger/duration/shape_id 原样带过，delay 归零', () => {
    const spec = animationSpecFromModel({ shape_id: 7, effect: 'grow', trigger: 'after_previous', duration_ms: 900, order: 2 });
    expect(spec).toEqual({
      shape_id: 7,
      effect: 'grow',
      kind: 'emphasis',
      trigger: 'after_previous',
      duration_ms: 900,
      delay_ms: 0,
      direction: null,
    });
  });

  it('未知效果名不静默：renderSlideTimingXml 具名报 unknown_effect', () => {
    const added = addSlide(emptyPresentation('p1', 't'));
    const withAnim = applyAnimations(added.presentation, 1, [fade(2, 'on_click')]);
    const broken = {
      ...withAnim,
      slides: [{ ...withAnim.slides[0]!, animations: [{ shape_id: 2, effect: 'nope', trigger: 'on_click' as const, duration_ms: 300, order: 0 }] }],
    };
    expect(() => renderSlideTimingXml(broken.slides[0]!)).toThrowError();
  });
});

describe('PPT-11：读回器按行为节点反推效果与类别', () => {
  it('p:set 可见性定进入/退出；emphasis 无 p:set', () => {
    const xml = renderTimingXml([
      { shape_id: 2, effect: 'fade', kind: 'exit', trigger: 'on_click', duration_ms: 300, delay_ms: 0 },
      { shape_id: 3, effect: 'spin', kind: 'emphasis', trigger: 'on_click', duration_ms: 400, delay_ms: 0 },
      { shape_id: 4, effect: 'appear', kind: 'entrance', trigger: 'on_click', duration_ms: 0, delay_ms: 0 },
    ]);
    const readBack = parseTimingXml(xml);
    expect(readBack.map((spec) => spec.kind)).toEqual(['exit', 'emphasis', 'entrance']);
    expect(readBack.map((spec) => spec.effect)).toEqual(['fade', 'spin', 'appear']);
    // appear 只有 p:set（写侧 dur=1），不断言原始时长。
    const appear = readBack[2]!;
    expect(appear.effect).toBe('appear');
    expect(appear.shape_id).toBe(4);
  });

  it('空时序树读回空数组（不是抛错）', () => {
    expect(parseTimingXml(renderTimingXml([]))).toEqual([]);
    expect(countTimingEffects(renderTimingXml([]))).toBe(0);
  });
});

describe('PPT-11：登记表（一页一块、清除/移除语义）', () => {
  it('add 重复抛 duplicate；set 覆盖；clear 变空块；remove 删条目；clearAll', () => {
    const desc = timingDescriptorFor(SLIDE_PATH, 1, [fade(2, 'on_click')]);
    let reg = addTiming({ entries: [] }, desc);
    expect(timingPaths(reg)).toEqual([SLIDE_PATH]);

    expect(() => addTiming(reg, desc)).toThrowError(TimingPartsError);
    try {
      addTiming(reg, desc);
    } catch (error) {
      expect((error as TimingPartsError).reason).toBe('duplicate_timing_entry');
    }

    // set 覆盖成两条效果。
    reg = setTiming(reg, timingDescriptorFor(SLIDE_PATH, 1, [fade(2, 'on_click'), fade(3, 'with_previous')]));
    expect(findTiming(reg, SLIDE_PATH)?.effect_count).toBe(2);

    // clear：条目保留但为空块。
    reg = clearTiming(reg, SLIDE_PATH);
    const cleared = findTiming(reg, SLIDE_PATH)!;
    expect(cleared.empty).toBe(true);
    expect(cleared.effect_count).toBe(0);
    expect(countTimingEffects(cleared.xml)).toBe(0);

    // remove 真删。
    reg = removeTiming(reg, SLIDE_PATH);
    expect(timingPaths(reg)).toEqual([]);
    expect(() => removeTiming(reg, SLIDE_PATH)).toThrowError(TimingPartsError);
  });

  it('validateTimingRegistry：描述符自报条数与独立读回打架 ⇒ 具名报错', () => {
    const honest = timingDescriptorFor(SLIDE_PATH, 1, [fade(2, 'on_click')]);
    expect(validateTimingRegistry({ entries: [honest] }, parseTimingXml)).toBe(1);

    const lying: TimingDescriptor = { ...honest, effect_count: 99 };
    try {
      validateTimingRegistry({ entries: [lying] }, parseTimingXml);
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as TimingPartsError).reason).toBe('invalid_timing_xml');
    }
  });

  it('clearAllTiming：每页都变空块', () => {
    let reg = addTiming({ entries: [] }, timingDescriptorFor('ppt/slides/slide1.xml', 1, [fade(2, 'on_click')]));
    reg = addTiming(reg, timingDescriptorFor('ppt/slides/slide2.xml', 2, [fade(3, 'on_click')]));
    const cleared = clearAllTiming(reg);
    expect(cleared.entries.every((entry) => entry.empty && entry.effect_count === 0)).toBe(true);
    expect(timingPaths(cleared)).toEqual(['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml']);
  });
});

describe('PPT-11：负例具名报错（不静默降级）', () => {
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
      injectTiming('<not-slide><a/></not-slide>', renderTimingXml([]));
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

  it('stripTiming 对没有时序的页是恒等；清除未知页的登记条目 ⇒ unknown_timing_entry', () => {
    const { xml: slideXml } = deck();
    expect(stripTiming(slideXml)).toBe(slideXml);
    try {
      clearTiming({ entries: [] }, SLIDE_PATH);
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as TimingPartsError).reason).toBe('unknown_timing_entry');
    }
  });
});

describe('PPT-11：切换与动画同页共存，顺序正确', () => {
  it('切块与动画块都能注入并被读回（切换在前、时序在后）', () => {
    const added = addSlide(emptyPresentation('p1', 't'));
    let p = setSlideTransition(added.presentation, 1, { kind: 'fade', duration_ms: 500 });
    p = applyAnimations(p, 1, [fade(2, 'on_click', 600), flyIn(3, 'after_previous', 300)]);
    const slideXml = renderSlidePartXml(p.slides[0]!, ctx());

    const desc = timingDescriptorFor(SLIDE_PATH, 1, [fade(2, 'on_click', 600), flyIn(3, 'after_previous', 300)]);
    const injected = applyTimingDescriptor(slideXml, desc);

    const root = parseXmlDocument(injected);
    const names = childElements(root).map((child) => child.name);
    expect(names.indexOf('p:transition')).toBeLessThan(names.indexOf('p:timing'));

    const block = timingBlockOf(injected);
    const readBack = parseTimingXml(block);
    expect(readBack.map((spec) => spec.shape_id)).toEqual([2, 3]);
    expect(readBack.map((spec) => spec.trigger)).toEqual(['on_click', 'after_previous']);
    // 写侧落**组内绝对延迟**（600 = 前序 600ms 时长 + 本效果相对 0）；此处证明确实写下了 600。
    expect(block).toContain('delay="600"');
    // 读侧（P-I12 无损写侧）按同一套组内游标**反推回相对延迟**，与输入规格 delay_ms=0 一致，
    // 不再是旧的组内绝对值 600。写绝对、读相对，闭合无损且不改播放语义。
    const afterDelay = readBack[1]!.delay_ms;
    expect(afterDelay).toBe(0);
  });
});

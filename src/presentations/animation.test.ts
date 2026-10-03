/**
 * 演示域**切换与对象动画**用例（design-06 P9；PPT-11）。
 *
 * 重点：
 * - 产物是**真实 `p:timing` XML**（用 `xml-parse.ts` 解析回读：`p:seq` / `p:animEffect` / `p:spTgt` /
 *   `p:animMotion` …），**不是**一句中文描述——反向对照即"清空后没有任何效果节点"；
 * - 触发参数：`on_click` 起新点击组，`with_previous` 并入当前组，`after_previous` 的延迟由前序时长累计；
 * - 切换：`p:transition` 的方向 / 速度 / 提前方式（`advClick` / `advTm`）落到属性上；
 * - 与模型的桥接复用 `operations.addShapeAnimation` / `clearAnimations` / `setSlideTransition`。
 *
 * 注：本套件只验证**产出的 XML 结构**；"在目标软件里真的按此播放"**未验证（需消费端）**。
 */

import { describe, expect, it } from 'vitest';

import type { Presentation } from './model.js';
import { addSlide } from './operations.js';
import { emptyPresentation } from './render.js';
import { parseXmlDocument, childElements, firstElement, attributeOf, type XmlElementNode } from './xml-parse.js';
import { parseTimingXml } from './timing-parts/parse.js';
import {
  AnimationError,
  addAnimationSpec,
  animationSpecFromModel,
  applyAnimations,
  applyTransition,
  buildClickGroups,
  clearAnimationList,
  moveAnimationSpec,
  normalizeOrder,
  renderSlideTimingXml,
  renderTimingXml,
  renderTransitionXml,
  updateAnimationSpec,
  type AnimationSpec,
} from './animation.js';

function deck(): Presentation {
  return addSlide(emptyPresentation('p1', '测试文稿')).presentation;
}

/** 收集所有后代元素（按名字）。 */
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

function fade(shapeId: number, trigger: AnimationSpec['trigger'], duration = 500): AnimationSpec {
  return { shape_id: shapeId, effect: 'fade', kind: 'entrance', trigger, duration_ms: duration, delay_ms: 0 };
}

describe('PPT-11：时序树是真实 XML（不是描述文字）', () => {
  it('p:timing → p:seq → 效果节点 / 目标 spid / 时长都在', () => {
    const xml = renderTimingXml([
      fade(2, 'on_click', 700),
      { shape_id: 3, effect: 'flyIn', kind: 'entrance', trigger: 'on_click', duration_ms: 500, delay_ms: 0, direction: 'left' },
    ]);
    expect(xml.startsWith('<p:timing')).toBe(true);

    const root = parseXmlDocument(xml);
    expect(root.name).toBe('p:timing');
    expect(descendants(root, 'p:seq')).toHaveLength(1);

    const effects = descendants(root, 'p:animEffect');
    expect(effects).toHaveLength(1);
    expect(attributeOf(effects[0], 'filter')).toBe('fade');
    expect(attributeOf(effects[0], 'transition')).toBe('in');

    const targets = descendants(root, 'p:spTgt').map((target) => attributeOf(target, 'spid'));
    expect(targets).toContain('2');
    expect(targets).toContain('3');

    const motion = descendants(root, 'p:animMotion');
    expect(motion).toHaveLength(1);
    expect(attributeOf(motion[0], 'path')).toBe('M -0.25 0 L 0 0 E');

    // 时长落在 cBhvr 的 p:cTn 上。
    const durations = descendants(root, 'p:cTn').map((cTn) => attributeOf(cTn, 'dur'));
    expect(durations).toContain('700');
    expect(durations).toContain('500');

    // 所有 cTn 的 id 唯一（时序树的硬性要求）。
    const ids = descendants(root, 'p:cTn').map((cTn) => attributeOf(cTn, 'id'));
    expect(new Set(ids).size).toBe(ids.length);
    // 产物里**不得**出现中文描述（不是"写了一句动画说明"）。
    expect(/[一-鿿]/.test(xml)).toBe(false);
  });

  it('触发参数：on_click 起新点击组，with_previous / after_previous 并入当前组', () => {
    const specs = [fade(2, 'on_click'), fade(3, 'with_previous'), fade(4, 'after_previous', 300), fade(5, 'on_click')];
    const groups = buildClickGroups(specs);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.effects).toHaveLength(3);
    expect(groups[1]?.effects).toHaveLength(1);

    const root = parseXmlDocument(renderTimingXml(specs));
    const mainSeq = descendants(root, 'p:cTn').find((cTn) => attributeOf(cTn, 'nodeType') === 'mainSeq')!;
    const clickGroups = childElements(firstElement(mainSeq, 'p:childTnLst'), 'p:par');
    expect(clickGroups).toHaveLength(2);
    const effectsOf = (group: XmlElementNode): readonly XmlElementNode[] =>
      childElements(firstElement(firstElement(group, 'p:cTn'), 'p:childTnLst'), 'p:par');
    expect(effectsOf(clickGroups[0]!)).toHaveLength(3);
    expect(effectsOf(clickGroups[1]!)).toHaveLength(1);

    const nodeTypes = descendants(root, 'p:cTn').map((cTn) => attributeOf(cTn, 'nodeType'));
    expect(nodeTypes).toContain('withEffect');
    expect(nodeTypes).toContain('afterEffect');
  });

  it('after_previous 的起始延迟 = 组内前序效果时长累计 + 自身延迟', () => {
    const specs = [fade(2, 'on_click', 500), { ...fade(3, 'after_previous', 300), delay_ms: 100 }];
    const root = parseXmlDocument(renderTimingXml(specs));
    const delays = descendants(root, 'p:cond').map((cond) => attributeOf(cond, 'delay'));
    expect(delays).toContain('600'); // 500（前序时长）+ 100（自身延迟）
    expect(delays).toContain('indefinite'); // on_click 组的起始条件
  });

  it('反向对照：清空动画 ⇒ 时序树里没有任何效果节点，但仍是合法的 p:timing', () => {
    const cleared = clearAnimationList();
    const xml = renderTimingXml(cleared);
    const root = parseXmlDocument(xml);
    expect(root.name).toBe('p:timing');
    expect(descendants(root, 'p:animEffect')).toHaveLength(0);
    expect(descendants(root, 'p:spTgt')).toHaveLength(0);
    const mainSeq = descendants(root, 'p:cTn').find((cTn) => attributeOf(cTn, 'nodeType') === 'mainSeq')!;
    expect(childElements(firstElement(mainSeq, 'p:childTnLst'), 'p:par')).toHaveLength(0);
  });
});

describe('PPT-11：切换参数落到 p:transition 属性与子元素', () => {
  it('push 带方向 + 自动推进；spd / dur / advClick / advTm 都在', () => {
    const xml = renderTransitionXml({
      kind: 'push',
      duration_ms: 800,
      direction: 'r',
      advance_on_click: false,
      advance_after_ms: 3000,
    });
    const root = parseXmlDocument(xml);
    expect(root.name).toBe('p:transition');
    expect(attributeOf(root, 'spd')).toBe('med');
    expect(attributeOf(root, 'dur')).toBe('800');
    expect(attributeOf(root, 'advClick')).toBe('0');
    expect(attributeOf(root, 'advTm')).toBe('3000');
    const effect = childElements(root)[0]!;
    expect(effect.name).toBe('p:push');
    expect(attributeOf(effect, 'dir')).toBe('r');
  });

  it('反面：fade 没有方向属性，默认点击推进，且不写 advTm', () => {
    const root = parseXmlDocument(renderTransitionXml({ kind: 'fade', duration_ms: 400 }));
    const effect = childElements(root)[0]!;
    expect(effect.name).toBe('p:fade');
    expect(attributeOf(effect, 'dir')).toBeUndefined();
    expect(attributeOf(root, 'advClick')).toBe('1');
    expect(attributeOf(root, 'advTm')).toBeUndefined();
  });
});

describe('PPT-11：与模型桥接（复用 operations）', () => {
  it('applyAnimations 写入模型并重算 order；applyTransition 写入切换', () => {
    const specs = [fade(2, 'on_click'), fade(3, 'with_previous'), fade(4, 'on_click')];
    expect(normalizeOrder(specs).map((spec) => spec.order)).toEqual([0, 0, 1]);

    const withAnimations = applyAnimations(deck(), 1, specs);
    const slide = withAnimations.slides[0]!;
    expect(slide.animations).toHaveLength(3);
    expect(slide.animations.map((animation) => animation.order)).toEqual([0, 0, 1]);
    expect(slide.animations.map((animation) => animation.trigger)).toEqual([
      'on_click',
      'with_previous',
      'on_click',
    ]);

    const withTransition = applyTransition(withAnimations, 1, { kind: 'push', duration_ms: 800, direction: 'r' });
    expect(withTransition.slides[0]?.transition).toEqual({ kind: 'push', duration_ms: 800 });
  });

  it('编辑：追加 / 修改 / 移动；越界与未知效果**具名报错**', () => {
    const base = addAnimationSpec([], fade(2, 'on_click'));
    const two = addAnimationSpec(base, fade(3, 'on_click'));
    const moved = moveAnimationSpec(two, 1, 0);
    expect(moved.map((spec) => spec.shape_id)).toEqual([3, 2]);

    const updated = updateAnimationSpec(two, 0, { duration_ms: 1200 });
    expect(updated[0]?.duration_ms).toBe(1200);
    expect(updated[1]).toEqual(two[1]);

    expect(() => updateAnimationSpec(two, 5, {})).toThrowError(AnimationError);
    try {
      addAnimationSpec([], { ...fade(2, 'on_click'), effect: 'nope' as never });
    } catch (error) {
      expect((error as AnimationError).reason).toBe('unknown_effect');
    }
  });
});

describe('P-I12：模型 → p:timing 桥无损（appear 时长 + after_previous 偏移）', () => {
  it('renderSlideTimingXml 的产物经 timing-parts 读回与模型投影逐字段相等', () => {
    const specs: AnimationSpec[] = [
      { shape_id: 2, effect: 'appear', kind: 'entrance', trigger: 'on_click', duration_ms: 550, delay_ms: 0 },
      { shape_id: 3, effect: 'flyIn', kind: 'entrance', trigger: 'after_previous', duration_ms: 300, delay_ms: 0 },
    ];
    const withAnim = applyAnimations(deck(), 1, specs);
    const slide = withAnim.slides[0]!;

    expect([...parseTimingXml(renderSlideTimingXml(slide))]).toEqual([
      { shape_id: 2, effect: 'appear', kind: 'entrance', trigger: 'on_click', duration_ms: 550, delay_ms: 0 },
      { shape_id: 3, effect: 'flyIn', kind: 'entrance', trigger: 'after_previous', duration_ms: 300, delay_ms: 0 },
    ]);
    // animationSpecFromModel 原样带过模型时长（appear 550 不被 legacy 的 1 吞掉）。
    expect(slide.animations.map((animation) => animationSpecFromModel(animation).duration_ms)).toEqual([550, 300]);
  });

  it('legacy renderTimingXml（不传选项）对 appear 仍写 dur=1；无损选项写真值', () => {
    const specs: AnimationSpec[] = [
      { shape_id: 2, effect: 'appear', kind: 'entrance', trigger: 'on_click', duration_ms: 550, delay_ms: 0 },
    ];
    expect(parseTimingXml(renderTimingXml(specs))[0]?.duration_ms).toBe(1);
    expect(parseTimingXml(renderTimingXml(specs, { losslessAppearDuration: true }))[0]?.duration_ms).toBe(550);
  });
});

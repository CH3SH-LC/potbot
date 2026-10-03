/**
 * P-I12 · `animation.ts` 模型→文件 `p:timing` 桥的**无损闭合**（appear 时长 + after_previous 偏移）。
 *
 * 覆盖三件事：
 * 1. **legacy 不变**：`renderTimingXml(specs)`（不传选项）与历史产物逐字节一致——`appear` 的可见性
 *    `p:set` 仍写 `dur=1`；既有消费端（P08/P-I02）不受影响。
 * 2. **无损闭合**：`renderTimingXml(specs, { losslessAppearDuration: true })` 的产物经
 *    `timing-parts.parseTimingXml` 读回，与源 `AnimationSpec[]` **逐字段相等**（含 appear 时长与
 *    after_previous 相对延迟）。
 * 3. **模型桥**：`renderSlideTimingXml(slide)` 走无损写侧，模型里的 appear 真实时长与
 *    `animationSpecFromModel` 投影能无损往返。
 *
 * 反向对照：legacy 写侧读回时 appear 时长塌成 `1`、after_previous 相对偏移被游标错位污染——
 * 证明无损选项不是空转。
 *
 * 读回器是**被测模块之外**的独立实现（`timing-parts/parse.ts`），断言不依赖 `animation.ts` 自己。
 */

import { describe, expect, it } from 'vitest';

import {
  applyAnimations,
  animationSpecFromModel,
  renderSlideTimingXml,
  renderTimingXml,
  type AnimationSpec,
} from '../../../../src/presentations/animation.js';
import { addSlide } from '../../../../src/presentations/operations.js';
import { emptyPresentation } from '../../../../src/presentations/render.js';
import { parseTimingXml } from '../../../../src/presentations/timing-parts/parse.js';
import {
  attributeOf,
  childElements,
  firstElement,
  parseXmlDocument,
  type XmlElementNode,
} from '../../../../src/presentations/xml-parse.js';

/** 收集某元素下所有后代里名字为 `name` 的元素。 */
function descendants(node: XmlElementNode, name: string): readonly XmlElementNode[] {
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

/** 读产物里第一个可见性 `p:set` 的 `p:cBhvr/p:cTn@dur`。 */
function visibilitySetDur(xml: string): string | undefined {
  const set = descendants(parseXmlDocument(xml), 'p:set')[0];
  if (set === undefined) return undefined;
  return attributeOf(firstElement(firstElement(set, 'p:cBhvr'), 'p:cTn'), 'dur');
}

/** 一个规格里参与写读闭合的字段（读回器不产出 `direction`，故断言时按此投影）。 */
function project(spec: AnimationSpec): {
  shape_id: number;
  effect: string;
  kind: string;
  trigger: string;
  duration_ms: number;
  delay_ms: number;
} {
  return {
    shape_id: spec.shape_id,
    effect: spec.effect,
    kind: spec.kind,
    trigger: spec.trigger,
    duration_ms: spec.duration_ms,
    delay_ms: spec.delay_ms,
  };
}

/** 一页空稿。 */
function emptySlide(): ReturnType<typeof addSlide> {
  return addSlide(emptyPresentation('p1', 'P-I12'));
}

// ---------------------------------------------------------------------------
// 1. legacy 输出不变
// ---------------------------------------------------------------------------

describe('P-I12：legacy renderTimingXml 输出不变', () => {
  const specs: AnimationSpec[] = [
    { shape_id: 2, effect: 'appear', kind: 'entrance', trigger: 'on_click', duration_ms: 500, delay_ms: 0 },
  ];

  it('不传选项与显式 lossless=false 逐字节相同；appear 仍写 dur=1', () => {
    const legacy = renderTimingXml(specs);
    expect(legacy).toBe(renderTimingXml(specs, { losslessAppearDuration: false }));
    expect(legacy).toBe(renderTimingXml(specs, {}));
    // 历史写侧：appear 的可见性 p:set 恒为瞬时 1（无损模式才写真实时长）。
    expect(visibilitySetDur(legacy)).toBe('1');
  });

  it('反向对照：legacy 读回把 appear 真实时长塌成 1', () => {
    const readBack = parseTimingXml(renderTimingXml(specs));
    expect(readBack).toHaveLength(1);
    expect(readBack[0]!.effect).toBe('appear');
    expect(readBack[0]!.duration_ms).toBe(1); // 源是 500 —— legacy 有损
    expect(readBack[0]!.duration_ms).not.toBe(specs[0]!.duration_ms);
  });

  it('反向对照：legacy 读回的 after_previous 相对偏移被游标错位污染', () => {
    const source: AnimationSpec[] = [
      { shape_id: 2, effect: 'appear', kind: 'entrance', trigger: 'on_click', duration_ms: 500, delay_ms: 0 },
      { shape_id: 3, effect: 'flyIn', kind: 'entrance', trigger: 'after_previous', duration_ms: 300, delay_ms: 40 },
    ];
    const readBack = parseTimingXml(renderTimingXml(source));
    // 写侧用真实 500 累计组内绝对延迟（500+40=540），读侧却用被塌成 1 的 appear 时长做游标。
    expect(readBack[1]!.delay_ms).not.toBe(source[1]!.delay_ms);
    expect(readBack[1]!.delay_ms).toBe(500 + 40 - 1);
  });
});

// ---------------------------------------------------------------------------
// 2. 无损闭合（specs 层）
// ---------------------------------------------------------------------------

describe('P-I12：无损写侧 render → timing-parts parse 逐字段相等', () => {
  it('appear 进入 / 退出真时长 + after_previous 相对延迟都无损', () => {
    const source: AnimationSpec[] = [
      { shape_id: 2, effect: 'appear', kind: 'entrance', trigger: 'on_click', duration_ms: 500, delay_ms: 0 },
      { shape_id: 3, effect: 'appear', kind: 'exit', trigger: 'after_previous', duration_ms: 250, delay_ms: 40 },
      { shape_id: 4, effect: 'fade', kind: 'entrance', trigger: 'after_previous', duration_ms: 300, delay_ms: 60 },
    ];
    const xml = renderTimingXml(source, { losslessAppearDuration: true });
    expect([...parseTimingXml(xml)]).toEqual(source);
  });

  it('appear 时长 0 与首条 after_previous 也如实读回', () => {
    const source: AnimationSpec[] = [
      { shape_id: 7, effect: 'appear', kind: 'entrance', trigger: 'after_previous', duration_ms: 0, delay_ms: 25 },
      { shape_id: 8, effect: 'appear', kind: 'entrance', trigger: 'with_previous', duration_ms: 0, delay_ms: 0 },
    ];
    expect([...parseTimingXml(renderTimingXml(source, { losslessAppearDuration: true }))]).toEqual(source);
  });

  it('无损只改 appear 的 p:set dur（节点结构与 legacy 同形）', () => {
    const specs: AnimationSpec[] = [
      { shape_id: 2, effect: 'appear', kind: 'entrance', trigger: 'on_click', duration_ms: 500, delay_ms: 0 },
      { shape_id: 3, effect: 'flyIn', kind: 'entrance', trigger: 'on_click', duration_ms: 300, delay_ms: 0 },
    ];
    const legacy = renderTimingXml(specs);
    const lossless = renderTimingXml(specs, { losslessAppearDuration: true });
    expect(lossless).not.toBe(legacy);
    expect(visibilitySetDur(legacy)).toBe('1');
    expect(visibilitySetDur(lossless)).toBe('500');
    // 把无损产物里的 500 换回 1 应与 legacy 完全一致（唯一差异就是该属性值）。
    expect(lossless.replace('dur="500"', 'dur="1"')).toBe(legacy);
  });

  it('空列表两种模式都产出合法空时序树', () => {
    for (const options of [{}, { losslessAppearDuration: true }] as const) {
      const root = parseXmlDocument(renderTimingXml([], options));
      expect(root.name).toBe('p:timing');
      const mainSeq = descendants(root, 'p:cTn').find((cTn) => attributeOf(cTn, 'nodeType') === 'mainSeq')!;
      expect(childElements(firstElement(mainSeq, 'p:childTnLst'), 'p:par')).toHaveLength(0);
      expect(parseTimingXml(renderTimingXml([], options))).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. 模型桥 renderSlideTimingXml + animationSpecFromModel 往返
// ---------------------------------------------------------------------------

describe('P-I12：模型页桥 renderSlideTimingXml 无损', () => {
  it('animationSpecFromModel 原样带过 shape_id/effect/trigger/duration，类别与延迟补默认', () => {
    const spec = animationSpecFromModel({ shape_id: 9, effect: 'appear', trigger: 'after_previous', duration_ms: 640, order: 0 });
    expect(spec).toEqual({
      shape_id: 9,
      effect: 'appear',
      kind: 'entrance',
      trigger: 'after_previous',
      duration_ms: 640,
      delay_ms: 0,
      direction: null,
    });
  });

  it('appear 的真实时长经模型往返仍无损', () => {
    const added = emptySlide();
    const source: AnimationSpec[] = [
      { shape_id: 2, effect: 'appear', kind: 'entrance', trigger: 'on_click', duration_ms: 550, delay_ms: 0 },
      { shape_id: 3, effect: 'flyIn', kind: 'entrance', trigger: 'after_previous', duration_ms: 300, delay_ms: 0 },
    ];
    const withAnim = applyAnimations(added.presentation, added.slide_id, source);
    const slide = withAnim.slides[0]!;

    const readBack = parseTimingXml(renderSlideTimingXml(slide));

    // 读回器产出的 `AnimationSpec[]` 与"模型投影"逐字段相等（含 appear 真时长）。
    expect(readBack.map(project)).toEqual(slide.animations.map((animation) => project(animationSpecFromModel(animation))));
    // 显式硬钉：appear 读到 550 而不是 legacy 的 1；after_previous 是模型的相对偏移 0。
    expect(readBack).toEqual([
      { shape_id: 2, effect: 'appear', kind: 'entrance', trigger: 'on_click', duration_ms: 550, delay_ms: 0 },
      { shape_id: 3, effect: 'flyIn', kind: 'entrance', trigger: 'after_previous', duration_ms: 300, delay_ms: 0 },
    ]);
  });

  it('无动画的页 ⇒ 结构合法的空时序树（读回空数组）', () => {
    const added = emptySlide();
    expect(parseTimingXml(renderSlideTimingXml(added.presentation.slides[0]!))).toEqual([]);
  });
});

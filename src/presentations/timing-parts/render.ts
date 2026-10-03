/**
 * P-I05 · 时序块**无损写侧**（`AnimationSpec[]` → `p:timing`）+ 媒体自动播放时序 seam。
 *
 * ## 为什么另起一份写侧而不是复用 `animation.renderTimingXml`
 *
 * `animation.renderTimingXml` 是**唯一**的时序 XML 生产者，但它对两种情况**有损**（P08 已如实标注）：
 *
 * 1. `appear` 不写真时长：`p:set`（可见性切换）的 `p:cTn@dur` 恒写作 `1`，读回 `duration_ms` 只能是 `1`，
 *    原始时长丢失；
 * 2. `after_previous` 写侧落的是**组内绝对延迟**（前序效果累计），读回得到绝对值而非原始相对延迟。
 *
 * `animation.ts` 不在本单元写区（改它会与 P01 的装配路径打架），因此本模块提供**自己的写侧**
 * `renderTimingXmlLossless`，在结构上与 `animation.renderTimingXml` **逐节点同形**（仍是真实、合法的
 * 放映时序树，消费端语义不变），只做两处修正：
 *
 * - `appear` 的可见性 `p:set` 的 `dur` 写**真实时长**（`spec.duration_ms`）；
 * - `after_previous` 仍写**组内绝对延迟**（放映语义要求如此：兄弟 `p:par` 是按父组起点的绝对偏移并发启动的），
 *   读侧（`parse.ts`）按**同一套游标算术**反推回**相对延迟**——写绝对、读相对，闭合无损且不改播放语义。
 *
 * ## 媒体自动播放 seam（P05 `media-parts` 需要）
 *
 * 此前 timing-parts 只覆盖**形状效果**，音视频自动播放（`p:video` / `p:audio` 挂在 `p:timing` 里，
 * 承载 autoplay / loop / volume / mute / 控件）无处落。本模块补上这条 seam：
 *
 * - `renderMediaAutoplayTimingXml` 单独产出一棵**与 `av-media.renderAvMediaTimingXml` 同骨架**的
 *   `p:timing`（自动播放 = `delay="0"`、点击播放 = `delay="indefinite"`、循环 = `repeatCount="indefinite"`），
 *   P05 可直接用它替换 / 校验自产片段；
 * - `renderTimingTreeXml` 把**形状效果**与**媒体条目**合成**一棵** `p:timing`（同一页既有动画又有音视频时用）。
 *
 * ## 未验证
 *
 * 真机 PowerPoint / WPS **播放**未验证（无设备、无 Office 授权）：本层只保证 XML 结构正确、写读闭合。
 */

import {
  attr,
  el,
  formatInteger,
  serializeXmlNode,
  type XmlElement,
  type XmlNode,
} from '../../artifacts/ooxml/index.js';
import {
  animationSpecFromModel,
  buildClickGroups,
  type AnimationEffectName,
  type AnimationSpec,
} from '../animation.js';
import type { Slide } from '../model.js';

import { TimingPartsError } from './errors.js';

const EFFECT_NAMES: ReadonlySet<string> = new Set<AnimationEffectName>([
  'appear',
  'fade',
  'wipe',
  'zoom',
  'flyIn',
  'spin',
  'grow',
  'pulse',
]);

function requireNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TimingPartsError('invalid_animation_spec', `${field} 必须是 ≥ 0 的整数，收到 ${String(value)}`);
  }
}

/** 写侧规格校验：未知效果 / 负时长 / 非整型 id 一律具名报错，不静默降级。 */
function validateAnimationSpec(spec: AnimationSpec): void {
  if (!EFFECT_NAMES.has(spec.effect)) {
    throw new TimingPartsError('invalid_animation_spec', `不支持的效果名 ${String(spec.effect)}`);
  }
  requireNonNegativeInteger(spec.duration_ms, 'duration_ms');
  requireNonNegativeInteger(spec.delay_ms, 'delay_ms');
  if (!Number.isSafeInteger(spec.shape_id)) {
    throw new TimingPartsError('invalid_animation_spec', `shape_id 必须是整数，收到 ${String(spec.shape_id)}`);
  }
}

// ---------------------------------------------------------------------------
// 形状效果（结构同 animation.renderTimingXml；仅 appear 的 p:set 写真实时长）
// ---------------------------------------------------------------------------

function behaviorCommon(id: number, shapeId: number, dur: number, fill?: 'hold'): XmlElement {
  const cTnChildren: readonly XmlNode[] =
    fill === 'hold' ? [el('p:stCondLst', [], [el('p:cond', [attr('delay', '0')])])] : [];
  return el('p:cBhvr', [], [
    el(
      'p:cTn',
      [attr('id', formatInteger(id)), attr('dur', formatInteger(dur)), ...(fill === 'hold' ? [attr('fill', 'hold')] : [])],
      cTnChildren,
    ),
    el('p:tgtEl', [], [el('p:spTgt', [attr('spid', formatInteger(shapeId))])]),
  ]);
}

/** 可见性切换（进入=visible / 退出=hidden）。`dur` 对 `appear` 写真实时长，其余瞬时（1）。 */
function setVisibilityXml(id: number, shapeId: number, value: 'visible' | 'hidden', dur: number): XmlElement {
  return el('p:set', [], [
    behaviorCommon(id, shapeId, dur, 'hold'),
    el('p:to', [], [el('p:strVal', [attr('val', value)])]),
    el('p:attrNameLst', [], [el('p:attrName', [], ['style.visibility'])]),
  ]);
}

/** 效果 → `p:animEffect` 的 filter（进入 / 退出用）。`appear` 没有 filter（只切可见性）。 */
function effectFilter(
  effect: AnimationEffectName,
): { readonly filter: string; readonly transition: 'in' | 'out' | 'none' } | null {
  switch (effect) {
    case 'appear':
      return null;
    case 'fade':
      return { filter: 'fade', transition: 'in' };
    case 'wipe':
      return { filter: 'wipe(up)', transition: 'in' };
    case 'zoom':
      return { filter: 'zoom(in)', transition: 'in' };
    default:
      return null; // flyIn / spin / grow / pulse 走别的行为节点
  }
}

/** 方向 → `p:animMotion` 相对路径（进入运动）。 */
function flyInPath(direction: 'left' | 'right' | 'up' | 'down' | null | undefined): string {
  switch (direction) {
    case 'left':
      return 'M -0.25 0 L 0 0 E';
    case 'up':
      return 'M 0 -0.25 L 0 0 E';
    case 'down':
      return 'M 0 0.25 L 0 0 E';
    case 'right':
    default:
      return 'M 0.25 0 L 0 0 E';
  }
}

function effectBehaviors(spec: AnimationSpec, alloc: () => number): readonly XmlElement[] {
  const nodes: XmlElement[] = [];
  // P-I05 修正点 1：appear 的可见性 p:set 写真实时长（其余进入 / 退出仍是瞬时切换 dur=1）。
  const visibilityDur = spec.effect === 'appear' ? spec.duration_ms : 1;
  if (spec.kind === 'entrance') {
    nodes.push(setVisibilityXml(alloc(), spec.shape_id, 'visible', visibilityDur));
  } else if (spec.kind === 'exit') {
    nodes.push(setVisibilityXml(alloc(), spec.shape_id, 'hidden', visibilityDur));
  }

  const filter = effectFilter(spec.effect);
  if (filter !== null) {
    nodes.push(
      el('p:animEffect', [attr('transition', filter.transition), attr('filter', filter.filter)], [
        behaviorCommon(alloc(), spec.shape_id, spec.duration_ms),
      ]),
    );
    return nodes;
  }

  switch (spec.effect) {
    case 'appear':
      return nodes;
    case 'flyIn':
      nodes.push(
        el(
          'p:animMotion',
          [attr('origin', 'layout'), attr('path', flyInPath(spec.direction ?? null)), attr('pathEditMode', 'relative')],
          [behaviorCommon(alloc(), spec.shape_id, spec.duration_ms)],
        ),
      );
      return nodes;
    case 'spin':
      nodes.push(el('p:animRot', [attr('by', '21600000')], [behaviorCommon(alloc(), spec.shape_id, spec.duration_ms)]));
      return nodes;
    case 'grow':
      nodes.push(
        el('p:animScale', [], [
          behaviorCommon(alloc(), spec.shape_id, spec.duration_ms),
          el('p:from', [attr('x', '100000'), attr('y', '100000')]),
          el('p:to', [attr('x', '150000'), attr('y', '150000')]),
        ]),
      );
      return nodes;
    case 'pulse':
      nodes.push(
        el('p:animScale', [], [
          behaviorCommon(alloc(), spec.shape_id, spec.duration_ms),
          el('p:by', [attr('x', '105000'), attr('y', '105000')]),
        ]),
      );
      return nodes;
    default:
      throw new TimingPartsError('invalid_animation_spec', `未实现的效果名 ${String(spec.effect)}`);
  }
}

function effectParXml(spec: AnimationSpec, delay: number, alloc: () => number): XmlElement {
  const nodeType =
    spec.trigger === 'on_click' ? 'clickEffect' : spec.trigger === 'with_previous' ? 'withEffect' : 'afterEffect';
  return el('p:par', [], [
    el('p:cTn', [attr('id', formatInteger(alloc())), attr('fill', 'hold'), attr('nodeType', nodeType)], [
      el('p:stCondLst', [], [el('p:cond', [attr('delay', formatInteger(delay))])]),
      el('p:childTnLst', [], [...effectBehaviors(spec, alloc)]),
    ]),
  ]);
}

/** `mainSeq` 的 `p:seq`（形状效果的点击组都挂在这里）。空数组 ⇒ 合法但无点击组。 */
function buildShapeSeqXml(specs: readonly AnimationSpec[], alloc: () => number, mainSeqId: number): XmlElement {
  const groups = buildClickGroups(specs);
  const groupXml = groups.map((group) => {
    let delayCursor = 0;
    const effectXml = group.effects.map((effect) => {
      const delay = effect.trigger === 'after_previous' ? delayCursor + effect.delay_ms : effect.delay_ms;
      delayCursor = delay + effect.duration_ms;
      return effectParXml(effect, delay, alloc);
    });
    return el('p:par', [], [
      el('p:cTn', [attr('id', formatInteger(alloc())), attr('fill', 'hold'), attr('nodeType', 'clickEffect')], [
        el('p:stCondLst', [], [el('p:cond', [attr('delay', group.trigger === 'on_click' ? 'indefinite' : '0')])]),
        el('p:childTnLst', [], effectXml),
      ]),
    ]);
  });

  return el('p:seq', [attr('concurrent', '1'), attr('nextAc', 'seek')], [
    el('p:cTn', [attr('id', formatInteger(mainSeqId)), attr('dur', 'indefinite'), attr('nodeType', 'mainSeq')], [
      el('p:childTnLst', [], groupXml),
    ]),
    el('p:prevCondLst', [], [
      el('p:cond', [attr('evt', 'onPrev'), attr('delay', '0')], [el('p:tgtEl', [], [el('p:sldTgt')])]),
    ]),
    el('p:nextCondLst', [], [
      el('p:cond', [attr('evt', 'onNext'), attr('delay', '0')], [el('p:tgtEl', [], [el('p:sldTgt')])]),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// 媒体自动播放（P05 media-parts 的 seam）
// ---------------------------------------------------------------------------

/**
 * 一条音视频**自动播放时序**规格（P05 `av-media.playback` 的同口径投影）。
 *
 * - `autoplay === true` ⇒ `p:stCondLst/p:cond@delay="0"`；否则 `delay="indefinite"`（点击播放）；
 * - `loop === true` ⇒ afterEffect par 的 `p:cTn@repeatCount="indefinite"`；
 * - `volume` 是 OOXML 的 `vol`（0…100000）；`muted` / `show_controls` 落 `mute` / `showWhenStopped`。
 */
export interface MediaTimingSpec {
  readonly shape_id: number;
  readonly media_kind: 'video' | 'audio';
  readonly autoplay: boolean;
  readonly loop: boolean;
  readonly volume: number;
  readonly muted: boolean;
  readonly show_controls: boolean;
}

function validateMediaSpec(spec: MediaTimingSpec): void {
  if (!Number.isSafeInteger(spec.shape_id) || spec.shape_id <= 0) {
    throw new TimingPartsError('invalid_media_spec', `媒体 shape_id 必须是正整数，收到 ${String(spec.shape_id)}`);
  }
  if (spec.media_kind !== 'video' && spec.media_kind !== 'audio') {
    throw new TimingPartsError('invalid_media_spec', `媒体类型必须是 video / audio，收到 ${String(spec.media_kind)}`);
  }
  if (!Number.isSafeInteger(spec.volume) || spec.volume < 0 || spec.volume > 100000) {
    throw new TimingPartsError('invalid_media_spec', `音量 vol 必须是 0…100000 的整数，收到 ${String(spec.volume)}`);
  }
}

/** 一个媒体条目的 `p:cTn`/`p:par` 片段（骨架与 av-media.renderAvMediaTimingXml 一致）。 */
function mediaParXml(spec: MediaTimingSpec, alloc: () => number): XmlElement {
  const delay = spec.autoplay ? '0' : 'indefinite';

  // 先按文档自然顺序分配 4 个 id（afterEffect / clickEffect / inner / media），保证互不相同。
  const afterId = alloc();
  const clickId = alloc();
  const innerId = alloc();
  const mediaId = alloc();

  const cMediaNode = el(spec.media_kind === 'video' ? 'p:video' : 'p:audio', [], [
    el(
      'p:cMediaNode',
      [
        attr('vol', formatInteger(spec.volume)),
        attr('mute', spec.muted ? '1' : '0'),
        attr('numSld', '0'),
        attr('showWhenStopped', spec.show_controls ? '1' : '0'),
      ],
      [
        el('p:cTn', [attr('id', formatInteger(mediaId)), attr('fill', 'hold')], [
          el('p:stCondLst', [], [el('p:cond', [attr('delay', 'indefinite')])]),
          el('p:endCondLst', [], [
            el('p:cond', [attr('evt', 'onStopAudio'), attr('delay', '0')], [el('p:tgtEl', [], [el('p:sldTgt')])]),
          ]),
        ]),
        el('p:tgtEl', [], [el('p:spTgt', [attr('spid', formatInteger(spec.shape_id))])]),
      ],
    ),
  ]);

  const afterAttrs = [
    attr('id', formatInteger(afterId)),
    attr('fill', 'hold'),
    attr('nodeType', 'afterEffect'),
    ...(spec.loop ? [attr('repeatCount', 'indefinite')] : []),
  ];

  return el('p:par', [], [
    el('p:cTn', afterAttrs, [
      el('p:stCondLst', [], [el('p:cond', [attr('delay', delay)])]),
      el('p:childTnLst', [], [
        el('p:par', [], [
          el('p:cTn', [attr('id', formatInteger(clickId)), attr('fill', 'hold'), attr('nodeType', 'clickEffect')], [
            el('p:stCondLst', [], [el('p:cond', [attr('delay', '0')])]),
            el('p:childTnLst', [], [
              el('p:par', [], [
                el('p:cTn', [attr('id', formatInteger(innerId)), attr('fill', 'hold')], [
                  el('p:stCondLst', [], [el('p:cond', [attr('delay', '0')])]),
                  el('p:childTnLst', [], [el('p:seq', [], [cMediaNode])]),
                ]),
              ]),
            ]),
          ]),
        ]),
      ]),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// 公开写侧
// ---------------------------------------------------------------------------

/** 把 tmRoot（id 由调用方分配）与其子节点包成一棵 `p:timing`。 */
function wrapTimingRoot(rootId: number, children: readonly XmlNode[]): string {
  const timing = el('p:timing', [], [
    el('p:tnLst', [], [
      el('p:par', [], [
        el(
          'p:cTn',
          [attr('id', formatInteger(rootId)), attr('dur', 'indefinite'), attr('restart', 'never'), attr('nodeType', 'tmRoot')],
          [el('p:childTnLst', [], children)],
        ),
      ]),
    ]),
  ]);
  return serializeXmlNode(timing);
}

/**
 * 渲染**整棵 `p:timing`**：形状效果（`mainSeq` 下的点击组）**加上**媒体自动播放条目。
 *
 * 形状部分与 `animation.renderTimingXml` 逐节点同形（空数组仍是合法空时序树，`mainSeq` 保留）；
 * 媒体条目追加在 tmRoot 的 `p:childTnLst` 里，与 `mainSeq` 的 `p:seq` 并列。
 */
export function renderTimingTreeXml(
  shapeSpecs: readonly AnimationSpec[],
  mediaSpecs: readonly MediaTimingSpec[] = [],
): string {
  for (const spec of shapeSpecs) validateAnimationSpec(spec);
  for (const spec of mediaSpecs) validateMediaSpec(spec);

  let counter = 0;
  const alloc = (): number => {
    counter += 1;
    return counter;
  };

  const rootId = alloc();
  const mainSeqId = alloc();

  const children: XmlNode[] = [buildShapeSeqXml(shapeSpecs, alloc, mainSeqId)];
  for (const spec of mediaSpecs) children.push(mediaParXml(spec, alloc));

  return wrapTimingRoot(rootId, children);
}

/**
 * 形状效果的**无损** `p:timing`（`appear` 写真实时长；`after_previous` 写组内绝对延迟，读侧反推相对）。
 *
 * 与 `animation.renderTimingXml` 同骨架，是 P01 装配 `Slide` 时该用的写侧。
 */
export function renderTimingXmlLossless(specs: readonly AnimationSpec[]): string {
  return renderTimingTreeXml(specs, []);
}

/**
 * **模型页 → 无损 `p:timing`**：与 `animation.renderSlideTimingXml` 同桥，但走无损写侧。
 *
 * P01 的 `render.ts` / `roundtrip.ts` 目前调的是 `animation.renderSlideTimingXml`（有损：
 * appear 的 `p:set` 恒 `dur=1`）。把那一处换成本函数即可让**整份文件**的 appear 时长无损——
 * 那两处不在本单元写区，见 residuals。
 */
export function renderSlideTimingXmlLossless(slide: Slide): string {
  return renderTimingXmlLossless(slide.animations.map(animationSpecFromModel));
}

/**
 * 单个媒体自动播放条目的独立 `p:timing`（**骨架与 `av-media.renderAvMediaTimingXml` 一致**：
 * 根 id=1，媒体条目 id=2…5；**不含**空的 `mainSeq` 形状 seq）。
 */
export function renderMediaAutoplayTimingXml(spec: MediaTimingSpec): string {
  validateMediaSpec(spec);
  let counter = 0;
  const alloc = (): number => {
    counter += 1;
    return counter;
  };
  const rootId = alloc();
  return wrapTimingRoot(rootId, [mediaParXml(spec, alloc)]);
}

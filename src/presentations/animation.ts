/**
 * 演示域**切换与对象动画**层（design-06 P9；PPT-11）。
 *
 * ## 这一层解决什么
 *
 * `model.ts` 已能表达 `Slide.transition`（切换）与 `Slide.animations`（对象动画），
 * `operations.ts` 能增删它们，`render.ts` 会把切换写成 `p:transition`——但**对象动画没有产物**：
 * `Slide.animations` 目前只是数据，谁也不把它渲染成 `p:timing`。PPT-11 要求"不能只写描述文字"，
 * 因此本模块补上**真实的 `p:timing` XML**（PowerPoint 认得的放映时序树），并给出动画的
 * 添加 / 修改 / 清除、**顺序**与**触发参数**（点击 / 与上一同 / 接上一之后）的处理。
 *
 * ## 时序树长什么样（本模块产出的形状）
 *
 * ```
 * p:timing
 *  └ p:tnLst → p:par → p:cTn(id=1,nodeType=tmRoot,dur=indefinite)
 *      └ p:childTnLst → p:seq(concurrent=1)
 *          └ p:cTn(id=2,nodeType=mainSeq,dur=indefinite)
 *              └ p:childTnLst → 每个"点击组"一个 p:par(nodeType=clickEffect)
 *                  └ p:childTnLst → 每个效果一个 p:par(nodeType=withEffect/afterEffect/clickEffect)
 *                      └ p:childTnLst → p:set / p:animEffect / p:animMotion / p:animRot / p:animScale
 * ```
 *
 * **顺序**（PPT-11）就是数组顺序：数组第 0 项先播；`order` 字段由 `normalizeOrder` 按数组顺序
 * 重算，不信任调用方手填的数字（手填的 order 与数组顺序打架会让"顺序"变成薛定谔的）。
 *
 * ## 触发参数（PPT-11）
 *
 * - `on_click`：新开一个点击组（`stCondLst/cond delay="indefinite"`，由用户点击推进）；
 * - `with_previous`：并入当前点击组，`delay` = 0；
 * - `after_previous`：并入当前点击组，`delay` = 组内前序效果的时长累计。
 *
 * ## P-I12 无损写侧（`appear` 时长 + `after_previous` 相对延迟）
 *
 * `renderTimingXml(specs)` 默认与历史产物**逐字节一致**（`appear` 的可见性 `p:set` 恒 `dur=1`）；
 * `renderTimingXml(specs, { losslessAppearDuration: true })` 则对 `appear` 写真实时长，使
 * 组内游标与 `timing-parts/parse.ts` 的读侧游标对齐——`appear` 时长与 `after_previous` 的
 * 相对偏移都能写读闭合。**模型→文件**的桥 `renderSlideTimingXml` 走这条无损路径。
 * 无损只改 `p:set` 的 `dur` 属性值，节点结构与 legacy 相同，不改放映语义。
 *
 * ## 未验证（需消费端）
 *
 * 本模块**只保证产出的 XML 结构与 OOXML 放映时序一致**（可用 `xml-parse.ts` 解析回读断言）；
 * "在 PowerPoint / WPS 里真的按此播放"**本轮未验证**——无设备、无 Office 授权，
 * 须由消费端（装有 PowerPoint 的机器）实测。**不得**据本条宣称"播放验证通过"。
 */

import {
  attr,
  el,
  formatInteger,
  serializeXmlNode,
  type XmlElement,
} from '../artifacts/ooxml/index.js';
import { ValidationError } from '../protocol/index.js';

import type { Presentation, ShapeAnimation, Slide, SlideTransition } from './model.js';
import { addShapeAnimation, clearAnimations, setSlideTransition } from './operations.js';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 动画层失败原因（具名）。 */
export type AnimationErrorReason = 'unknown_effect' | 'invalid_duration' | 'empty_animation_list';

/** 动画层错误：语义不成立时抛出，**不静默**。 */
export class AnimationError extends ValidationError {
  readonly reason: AnimationErrorReason;

  constructor(reason: AnimationErrorReason, message: string) {
    super(message);
    this.name = 'AnimationError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 切换（PPT-11）
// ---------------------------------------------------------------------------

/**
 * 切换预设名（对应 `p:transition` 的子元素名）。
 *
 * `cut`（无切换）在 OOXML 里是合法的 `p:cut`；清空切换请用 `clearTransition`。
 */
export type TransitionKind =
  | 'cut'
  | 'fade'
  | 'push'
  | 'wipe'
  | 'split'
  | 'cover'
  | 'uncover'
  | 'dissolve'
  | 'circle'
  | 'diamond'
  | 'wedge'
  | 'wheel'
  | 'zoom';

/** 需要方向的切换（写 `dir` 属性）。 */
const DIRECTIONAL_TRANSITIONS: ReadonlySet<string> = new Set(['push', 'wipe', 'cover', 'uncover']);

/** 切换规格（比模型的 `SlideTransition` 多出提前方式与方向）。 */
export interface TransitionSpec {
  readonly kind: TransitionKind;
  readonly duration_ms: number;
  /** 播放速度档位；缺省 `med`。 */
  readonly speed?: 'slow' | 'med' | 'fast';
  /** 点击推进；缺省 `true`。 */
  readonly advance_on_click?: boolean;
  /** 自动推进的毫秒数；`null`/缺省 = 不自动推进。 */
  readonly advance_after_ms?: number | null;
  /** 方向（`push` / `wipe` / `cover` / `uncover` / `split` 用）。 */
  readonly direction?: 'l' | 'r' | 'u' | 'd' | null;
  /** 仅 `split` 用：`horz` / `vert`。 */
  readonly orient?: 'horz' | 'vert' | null;
}

function requireNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AnimationError('invalid_duration', `${field} 必须是 ≥ 0 的整数，收到 ${String(value)}`);
  }
}

/** 渲染 `p:transition`（**真实 XML 片段**，单根，可被 `parseXmlDocument` 回读）。 */
export function renderTransitionXml(spec: TransitionSpec): string {
  requireNonNegativeInteger(spec.duration_ms, 'duration_ms');
  const advanceOnClick = spec.advance_on_click ?? true;
  const advanceAfter = spec.advance_after_ms ?? null;
  if (advanceAfter !== null) requireNonNegativeInteger(advanceAfter, 'advance_after_ms');

  const attrs = [
    attr('spd', spec.speed ?? 'med'),
    attr('dur', formatInteger(spec.duration_ms)),
    attr('advClick', advanceOnClick ? '1' : '0'),
    ...(advanceAfter === null ? [] : [attr('advTm', formatInteger(advanceAfter))]),
  ];

  const direction = spec.direction ?? null;
  const childAttrs = [
    ...(direction !== null && DIRECTIONAL_TRANSITIONS.has(spec.kind) ? [attr('dir', direction)] : []),
    ...(spec.kind === 'split' && spec.orient != null ? [attr('orient', spec.orient)] : []),
    ...(spec.kind === 'split' && direction !== null ? [attr('dir', direction)] : []),
  ];
  return serializeXmlNode(el('p:transition', attrs, [el(`p:${spec.kind}`, childAttrs)]));
}

/** 由模型切换（`SlideTransition`）补齐默认后渲染。 */
export function renderModelTransitionXml(transition: SlideTransition): string {
  return renderTransitionXml({ kind: transition.kind as TransitionKind, duration_ms: transition.duration_ms });
}

/** 把切换写进模型（复用 `operations.setSlideTransition`）。 */
export function applyTransition(presentation: Presentation, slideId: number, spec: TransitionSpec): Presentation {
  return setSlideTransition(presentation, slideId, { kind: spec.kind, duration_ms: spec.duration_ms });
}

/** 清除某页切换（复用 `operations.setSlideTransition(..., null)`）。 */
export function clearTransition(presentation: Presentation, slideId: number): Presentation {
  return setSlideTransition(presentation, slideId, null);
}

// ---------------------------------------------------------------------------
// 对象动画（PPT-11）
// ---------------------------------------------------------------------------

/** 效果类别：进入 / 强调 / 退出。 */
export type AnimationKind = 'entrance' | 'emphasis' | 'exit';

/** 效果名（本模块支持集；未知名显式报错，不静默降级）。 */
export type AnimationEffectName = 'appear' | 'fade' | 'wipe' | 'zoom' | 'flyIn' | 'spin' | 'grow' | 'pulse';

/** 触发方式（与模型 `ShapeAnimation.trigger` 同口径）。 */
export type AnimationTrigger = 'on_click' | 'with_previous' | 'after_previous';

/** 一条动画规格（比模型字段多出类别、延迟与方向）。 */
export interface AnimationSpec {
  readonly shape_id: number;
  readonly effect: AnimationEffectName;
  readonly kind: AnimationKind;
  readonly trigger: AnimationTrigger;
  readonly duration_ms: number;
  readonly delay_ms: number;
  readonly direction?: 'left' | 'right' | 'up' | 'down' | null;
}

/**
 * `renderTimingXml` 的渲染选项（P-I12）。
 *
 * 不传时为 **legacy 行为**（与历史产物逐字节一致），保证既有消费端不受影响。
 */
export interface RenderTimingOptions {
  /**
   * 无损模式：`appear` 的可见性 `p:set` 写 `spec.duration_ms` 作为 `p:cTn@dur`（默认 `false` ⇒ 仍写 `1`）。
   *
   * 打开后，组内游标（`after_previous` 的组内绝对延迟）用**真实** appear 时长累计，与
   * `timing-parts/parse.ts` 的读侧游标一致，从而 `appear` 时长与 `after_previous` 相对延迟都能无损读回。
   */
  readonly losslessAppearDuration?: boolean;
}

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

function validateSpec(spec: AnimationSpec): void {
  if (!EFFECT_NAMES.has(spec.effect)) {
    throw new AnimationError('unknown_effect', `不支持的效果名 ${String(spec.effect)}`);
  }
  requireNonNegativeInteger(spec.duration_ms, 'duration_ms');
  requireNonNegativeInteger(spec.delay_ms, 'delay_ms');
  if (!Number.isSafeInteger(spec.shape_id)) {
    throw new AnimationError('unknown_effect', `shape_id 必须是整数，收到 ${String(spec.shape_id)}`);
  }
}

/** 往动画列表追加一条；返回新数组（不改入参）。 */
export function addAnimationSpec(specs: readonly AnimationSpec[], spec: AnimationSpec): readonly AnimationSpec[] {
  validateSpec(spec);
  return Object.freeze([...specs, spec]);
}

/**
 * 改一条动画（按数组下标）：只覆盖传入的字段，其余原样保留。
 *
 * @throws {AnimationError} 下标越界。
 */
export function updateAnimationSpec(
  specs: readonly AnimationSpec[],
  index: number,
  patch: Partial<AnimationSpec>,
): readonly AnimationSpec[] {
  if (!Number.isSafeInteger(index) || index < 0 || index >= specs.length) {
    throw new AnimationError('empty_animation_list', `动画下标 ${String(index)} 越界（共 ${String(specs.length)} 条）`);
  }
  const next = { ...specs[index]!, ...patch };
  validateSpec(next);
  return Object.freeze(specs.map((spec, i) => (i === index ? next : spec)));
}

/** 清除全部动画。 */
export function clearAnimationList(): readonly AnimationSpec[] {
  return Object.freeze([]);
}

/** 把某条动画移到新位置（`to` 为移动后的目标下标，闭区间语义与"拖到第几格"一致）。 */
export function moveAnimationSpec(
  specs: readonly AnimationSpec[],
  from: number,
  to: number,
): readonly AnimationSpec[] {
  if (!Number.isSafeInteger(from) || from < 0 || from >= specs.length) {
    throw new AnimationError('empty_animation_list', `源下标 ${String(from)} 越界`);
  }
  if (!Number.isSafeInteger(to) || to < 0 || to >= specs.length) {
    throw new AnimationError('empty_animation_list', `目标下标 ${String(to)} 越界`);
  }
  const copy = [...specs];
  const [moved] = copy.splice(from, 1);
  copy.splice(to, 0, moved!);
  return Object.freeze(copy);
}

/** 按**数组顺序**重算每条动画的顺序（同触发组内 0 起）；返回带 `order` 的视图。 */
export function normalizeOrder(specs: readonly AnimationSpec[]): readonly (AnimationSpec & { order: number })[] {
  const counter = new Map<AnimationTrigger, number>();
  return Object.freeze(
    specs.map((spec) => {
      const order = counter.get(spec.trigger) ?? 0;
      counter.set(spec.trigger, order + 1);
      return Object.freeze({ ...spec, order });
    }),
  );
}

// ---------------------------------------------------------------------------
// 时序树构造
// ---------------------------------------------------------------------------

interface ClickGroup {
  readonly trigger: AnimationTrigger;
  readonly effects: readonly AnimationSpec[];
}

/** 按触发方式切"点击组"：`on_click` 起新组，`with_previous` / `after_previous` 并入当前组。 */
export function buildClickGroups(specs: readonly AnimationSpec[]): readonly ClickGroup[] {
  const groups: { trigger: AnimationTrigger; effects: AnimationSpec[] }[] = [];
  for (const spec of specs) {
    const current = groups[groups.length - 1];
    if (spec.trigger === 'on_click' || current === undefined) {
      groups.push({ trigger: spec.trigger, effects: [spec] });
    } else {
      current.effects.push(spec);
    }
  }
  return groups.map((group) => Object.freeze({ trigger: group.trigger, effects: Object.freeze(group.effects) }));
}

/** 效果 → `p:animEffect` 的 filter（进入 / 退出用）。`appear` 没有 filter（只切可见性）。 */
function effectFilter(effect: AnimationEffectName): { readonly filter: string; readonly transition: 'in' | 'out' | 'none' } | null {
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
function flyInPath(direction: 'left' | 'right' | 'up' | 'down' | null): string {
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

function behaviorCommon(id: number, shapeId: number, dur: number, fill?: 'hold'): XmlElement {
  const cTnChildren =
    fill === 'hold'
      ? [el('p:stCondLst', [], [el('p:cond', [attr('delay', '0')])])]
      : [];
  return el('p:cBhvr', [], [
    el('p:cTn', [attr('id', formatInteger(id)), attr('dur', formatInteger(dur)), ...(fill === 'hold' ? [attr('fill', 'hold')] : [])], cTnChildren),
    el('p:tgtEl', [], [el('p:spTgt', [attr('spid', formatInteger(shapeId))])]),
  ]);
}

/**
 * 可见性切换（进入=visible / 退出=hidden）。
 *
 * `dur` 是 `p:cTn@dur`：历史写侧对可见性切换恒写 `1`（瞬时）；P-I12 无损模式对 `appear` 写真实时长。
 */
function setVisibilityXml(id: number, shapeId: number, value: 'visible' | 'hidden', dur: number): XmlElement {
  return el('p:set', [], [
    behaviorCommon(id, shapeId, dur, 'hold'),
    el('p:to', [], [el('p:strVal', [attr('val', value)])]),
    el('p:attrNameLst', [], [el('p:attrName', [], ['style.visibility'])]),
  ]);
}

/**
 * 一个效果的**行为节点**（`p:set` / `p:animEffect` / `p:animMotion` / `p:animRot` / `p:animScale`）。
 *
 * 进入 / 退出先切可见性，再挂效果；强调没有可见性切换。返回的是**若干**节点，按放映语义排序。
 */
function effectBehaviors(spec: AnimationSpec, alloc: () => number, losslessAppearDuration: boolean): readonly XmlElement[] {
  const nodes: XmlElement[] = [];
  // P-I12：无损模式下 `appear` 的可见性 p:set 写真实时长（否则读侧只能读回恒 1 的旧值）。
  // 其余进入 / 退出效果本就有独立行为节点承载时长，可见性切换仍是瞬时 1。
  const visibilityDur = losslessAppearDuration && spec.effect === 'appear' ? spec.duration_ms : 1;
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
        el('p:animMotion', [
          attr('origin', 'layout'),
          attr('path', flyInPath(spec.direction ?? null)),
          attr('pathEditMode', 'relative'),
        ], [
          behaviorCommon(alloc(), spec.shape_id, spec.duration_ms),
        ]),
      );
      return nodes;
    case 'spin':
      nodes.push(
        el('p:animRot', [attr('by', '21600000')], [behaviorCommon(alloc(), spec.shape_id, spec.duration_ms)]),
      );
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
      // 到不了：validateSpec 已挡住未知效果名。
      throw new AnimationError('unknown_effect', `未实现的效果名 ${String(spec.effect)}`);
  }
}

/** 一个效果的 `p:par` 包裹（带起始延迟与 nodeType）。 */
function effectParXml(spec: AnimationSpec, delay: number, alloc: () => number, losslessAppearDuration: boolean): XmlElement {
  const nodeType =
    spec.trigger === 'on_click' ? 'clickEffect' : spec.trigger === 'with_previous' ? 'withEffect' : 'afterEffect';
  return el('p:par', [], [
    el('p:cTn', [attr('id', formatInteger(alloc())), attr('fill', 'hold'), attr('nodeType', nodeType)], [
      el('p:stCondLst', [], [el('p:cond', [attr('delay', formatInteger(delay))])]),
      el('p:childTnLst', [], [...effectBehaviors(spec, alloc, losslessAppearDuration)]),
    ]),
  ]);
}

/**
 * 渲染**整棵 `p:timing`**（**真实 XML**，单根片段）。
 *
 * 空动画列表 ⇒ 仍然产出结构合法的 `p:timing`（`mainSeq` 下没有点击组），
 * 而不是空串——"这一页没有动画"在产物里是"时序树为空"，不是"没写"。
 *
 * 默认（不传 `options`）产出与历史写侧**逐字节一致**的 legacy 时序树：`appear` 的可见性 `p:set`
 * 恒写 `dur=1`。传 `options.losslessAppearDuration = true` 走 **P-I12 无损写侧**：`appear` 写真实
 * 时长，使组内游标（`after_previous` 的组内绝对延迟）与读侧游标对齐——`renderSlideTimingXml`
 * 用的就是这条无损路径（写绝对、读相对，见 `timing-parts/parse.ts`）。
 */
export function renderTimingXml(specs: readonly AnimationSpec[], options?: RenderTimingOptions): string {
  const losslessAppearDuration = options?.losslessAppearDuration ?? false;
  for (const spec of specs) validateSpec(spec);
  let counter = 0;
  const alloc = (): number => {
    counter += 1;
    return counter;
  };

  const rootId = alloc(); // 1
  const mainSeqId = alloc(); // 2

  const groups = buildClickGroups(specs);
  const groupXml = groups.map((group) => {
    let delayCursor = 0;
    const effectXml = group.effects.map((effect) => {
      const delay = effect.trigger === 'after_previous' ? delayCursor + effect.delay_ms : effect.delay_ms;
      delayCursor = delay + effect.duration_ms;
      return effectParXml(effect, delay, alloc, losslessAppearDuration);
    });
    return el('p:par', [], [
      el('p:cTn', [attr('id', formatInteger(alloc())), attr('fill', 'hold'), attr('nodeType', 'clickEffect')], [
        el('p:stCondLst', [], [
          el('p:cond', [attr('delay', group.trigger === 'on_click' ? 'indefinite' : '0')]),
        ]),
        el('p:childTnLst', [], effectXml),
      ]),
    ]);
  });

  const seq = el('p:seq', [attr('concurrent', '1'), attr('nextAc', 'seek')], [
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

  const timing = el('p:timing', [], [
    el('p:tnLst', [], [
      el('p:par', [], [
        el('p:cTn', [attr('id', formatInteger(rootId)), attr('dur', 'indefinite'), attr('restart', 'never'), attr('nodeType', 'tmRoot')], [
          el('p:childTnLst', [], [seq]),
        ]),
      ]),
    ]),
  ]);

  return serializeXmlNode(timing);
}

// ---------------------------------------------------------------------------
// 与模型的桥接（复用 operations 的既有语义）
// ---------------------------------------------------------------------------

/**
 * 把动画规格写进模型：先清空该页动画，再按顺序逐条 `addShapeAnimation`。
 *
 * 写进模型的是 `ShapeAnimation`（`shape_id` / `effect` / `trigger` / `duration_ms` / `order`），
 * 顺序由 `normalizeOrder` 定，**不**沿用调用方可能手填的 order。
 */
export function applyAnimations(
  presentation: Presentation,
  slideId: number,
  specs: readonly AnimationSpec[],
): Presentation {
  let next = clearAnimations(presentation, slideId);
  for (const spec of normalizeOrder(specs)) {
    const animation: ShapeAnimation = {
      shape_id: spec.shape_id,
      effect: spec.effect,
      trigger: spec.trigger,
      duration_ms: spec.duration_ms,
      order: spec.order,
    };
    next = addShapeAnimation(next, slideId, animation);
  }
  return next;
}

/**
 * 效果名 → 类别（模型的 `ShapeAnimation` 不存类别，按本模块支持集补默认）。
 *
 * `spin` / `grow` / `pulse` 是**强调**类，其余（进入类显现效果）按**进入**处理。
 */
export function animationKindOf(effect: string): AnimationKind {
  return effect === 'spin' || effect === 'grow' || effect === 'pulse' ? 'emphasis' : 'entrance';
}

/**
 * 由模型的一条 `ShapeAnimation` 还原成渲染规格。
 *
 * 模型没有类别 / 延迟 / 方向字段，故 `kind` 由 `animationKindOf(effect)` 推默认、
 * `delay_ms = 0`、`direction = null`；`trigger` / `duration_ms` / `shape_id` 原样带过。
 * 未知效果名不在此处吞掉——`renderTimingXml` 的 `validateSpec` 会具名报 `unknown_effect`。
 */
export function animationSpecFromModel(animation: ShapeAnimation): AnimationSpec {
  return {
    shape_id: animation.shape_id,
    effect: animation.effect as AnimationEffectName,
    kind: animationKindOf(animation.effect),
    trigger: animation.trigger,
    duration_ms: animation.duration_ms,
    delay_ms: 0,
    direction: null,
  };
}

/**
 * **模型页 → `p:timing` XML**：把 `Slide.animations`（数组顺序即播放顺序）渲染成时序块。
 *
 * 这是模型层到文件层的**唯一**桥（`applyAnimations` 是反方向的写入模型）。P01 装配者
 * 对每一页调用它，再用 `timing-parts` 的 `injectTiming` 按 schema 位置放进幻灯片部件。
 * 无动画的页 ⇒ 结构合法的空时序树（"这页没有动画"在产物里是"时序树为空"，不是"没写"）。
 *
 * P-I12：本桥走**无损写侧**（`losslessAppearDuration: true`）——模型里 `appear` 的真实时长与
 * `after_previous` 的组内偏移都能被 `timing-parts.parseTimingXml` 无损读回；legacy 的
 * `renderTimingXml`（不传选项）保持原样，供仍按旧产物断言的消费端使用。
 */
export function renderSlideTimingXml(slide: Slide): string {
  return renderTimingXml(slide.animations.map(animationSpecFromModel), { losslessAppearDuration: true });
}

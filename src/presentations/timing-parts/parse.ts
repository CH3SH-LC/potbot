/**
 * P08 · **时序块读回**（`p:timing` → `AnimationSpec[]`）。
 *
 * ## 为什么需要它
 *
 * `animation.ts` 只会**写** `p:timing`（`renderTimingXml`）：从规格到 XML。导入既有 PPTX 时
 * 需要**反向**——把页里的 `p:timing` 读回成对象层的动画规格，否则"导入后可见动画"永远无从谈起
 * （`roundtrip.ts` 现在把 `animations` 直接置空，正是缺这一侧）。本模块补上"读"的一侧，
 * 且与 `renderTimingXml` 的产物**互为逆运算**（用例做 render → parse → 相等的闭合断言）。
 *
 * ## 读回口径（写侧怎么写，这里就怎么读）
 *
 * - **触发**：效果 `p:par/p:cTn/@nodeType` = `clickEffect` / `withEffect` / `afterEffect`
 *   ⇒ `on_click` / `with_previous` / `after_previous`；
 * - **目标**：行为节点里的 `p:spTgt/@spid`；
 * - **时长**：行为 `p:cBhvr/p:cTn/@dur`；
 * - **延迟**：效果 `p:par` 下 `p:cond/@delay`（**原始属性值**，int 或 `indefinite`）；
 * - **效果名与类别**：按行为节点反推——`p:set` 的可见性值定进入 / 退出，`p:animEffect`
 *   的 `filter`、`p:animMotion`、`p:animRot`、`p:animScale`（`p:to` / `p:by`）分别定名。
 *
 * ## P-I05 无损修正
 *
 * - `appear` 的时长：写侧（`timing-parts/render.ts`）把可见性 `p:set` 的 `dur` 写成**真实时长**，
 *   读回时对"只有 `p:set`、没有别的行为节点"的效果取该 `dur`（不再恒 `1`）。
 *   `animation.renderTimingXml` 的 `p:set` 仍是 `dur=1`，读回该写侧产物即 `1`——那是那个写侧的性质，
 *   本层如实读它写下的值。
 * - `after_previous`：写侧仍落**组内绝对延迟**（放映语义要求兄弟 `p:par` 按父组起点的绝对偏移启动），
 *   但读回按**与写侧同一套游标算术**反推回**相对延迟**——写绝对、读相对，闭合无损且不改播放语义。
 * - 只认本层写侧会产出的行为节点；遇到无法归类的行为节点 ⇒ `missing_timing_root` 之外的
 *   静默忽略**不允许**——本函数对"整棵树没有 `p:timing` 根"抛错，对未知行为节点**跳过但不猜名**。
 *
 * ## 媒体自动播放（P05 media-parts seam）
 *
 * `p:video` / `p:audio`（`p:cMediaNode`）挂在 `p:timing` 里承载 autoplay / loop / volume / mute / 控件。
 * `parseMediaTimingXml` 把 afterEffect par 上的 `p:cond@delay`（`0`=自动播放 / `indefinite`=点击）与
 * `p:cTn@repeatCount`（`indefinite`=循环）读回成 `MediaTimingSpec`；`parseTimingTreeXml` 一次拿回
 * 形状效果与媒体条目。**这些是结构读回，不等于消费端真会播放**。
 */

import {
  attributeOf,
  childElements,
  firstElement,
  parseXmlDocument,
  type XmlElementNode,
} from '../xml-parse.js';
import type { AnimationEffectName, AnimationKind, AnimationSpec, AnimationTrigger } from '../animation.js';

import { TimingPartsError } from './errors.js';
import type { MediaTimingSpec } from './render.js';

/** 收集某元素下**所有后代**（含自身以外的任意深度）里名字为 `name` 的元素。 */
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

/** 解析失败原因中"根本没有 `p:timing`"用不上这里（那返回空数组）；这里仅做结构断言。 */
function requireTimingRoot(xml: string): XmlElementNode {
  const root = parseXmlDocument(xml);
  if (root.name !== 'p:timing') {
    throw new TimingPartsError('missing_timing_root', `时序块根元素是 ${root.name}，不是 p:timing`);
  }
  return root;
}

const TRIGGER_BY_NODE_TYPE: ReadonlyMap<string, AnimationTrigger> = new Map([
  ['clickEffect', 'on_click'],
  ['withEffect', 'with_previous'],
  ['afterEffect', 'after_previous'],
]);

/** 从行为节点反推（效果名, 类别）。识别不出 ⇒ `null`。 */
function classifyBehavior(behavior: XmlElementNode, entranceExit: AnimationKind | null): {
  readonly effect: AnimationEffectName;
  readonly kind: AnimationKind;
} | null {
  switch (behavior.name) {
    case 'p:animEffect': {
      const filter = attributeOf(behavior, 'filter') ?? '';
      if (filter === 'fade') return { effect: 'fade', kind: entranceExit ?? 'emphasis' };
      if (filter.startsWith('wipe')) return { effect: 'wipe', kind: entranceExit ?? 'emphasis' };
      if (filter.startsWith('zoom')) return { effect: 'zoom', kind: entranceExit ?? 'emphasis' };
      return null;
    }
    case 'p:animMotion':
      return { effect: 'flyIn', kind: entranceExit ?? 'emphasis' };
    case 'p:animRot':
      return { effect: 'spin', kind: entranceExit ?? 'emphasis' };
    case 'p:animScale': {
      // grow 写 `p:to`，pulse 写 `p:by`（见 animation.ts effectBehaviors）。
      if (firstElement(behavior, 'p:to') !== undefined) return { effect: 'grow', kind: entranceExit ?? 'emphasis' };
      if (firstElement(behavior, 'p:by') !== undefined) return { effect: 'pulse', kind: entranceExit ?? 'emphasis' };
      return null;
    }
    default:
      return null;
  }
}

/** 从行为节点的 `p:cBhvr/p:cTn/@dur` 读时长；无 ⇒ `null`。 */
function behaviorDuration(behavior: XmlElementNode): number | null {
  const dur = attributeOf(firstElement(firstElement(behavior, 'p:cBhvr'), 'p:cTn'), 'dur');
  return dur !== undefined && /^\d+$/.test(dur) ? Number.parseInt(dur, 10) : null;
}

/**
 * 读一个效果 `p:par`；无法归类 ⇒ `null`（跳过，不猜名）。
 *
 * 返回 `written_delay`（XML 里写下的原始延迟，`after_previous` 是组内绝对值）与效果规格；
 * 相对延迟的还原由 `parseTimingXml` 按**组内游标**统一做（与写侧同一套算术）。
 */
function readEffectPar(par: XmlElementNode): { readonly spec: AnimationSpec; readonly written_delay: number } | null {
  const cTn = firstElement(par, 'p:cTn');
  const nodeType = attributeOf(cTn, 'nodeType') ?? '';
  const trigger = TRIGGER_BY_NODE_TYPE.get(nodeType);
  if (trigger === undefined) return null;

  const delayRaw = attributeOf(firstElement(firstElement(cTn, 'p:stCondLst'), 'p:cond'), 'delay') ?? '0';
  // `indefinite` 只会出现在点击组的组级条件上，效果级不应出现；保底按 0。
  const writtenDelay = /^\d+$/.test(delayRaw) ? Number.parseInt(delayRaw, 10) : 0;

  const childTnLst = firstElement(cTn, 'p:childTnLst');
  if (childTnLst === undefined) return null;

  // 可见性 `p:set`（进入 / 退出）决定类别；appear 只靠它就成一条动画。
  let kindFromSet: AnimationKind | null = null;
  const setNode = firstElement(childTnLst, 'p:set');
  if (setNode !== undefined) {
    // 可见性值在 `p:to/p:strVal/@val`（不是 `p:to` 自身），见 animation.ts `setVisibilityXml`。
    const value = attributeOf(firstElement(firstElement(setNode, 'p:to'), 'p:strVal'), 'val');
    if (value === 'visible') kindFromSet = 'entrance';
    else if (value === 'hidden') kindFromSet = 'exit';
  }

  const shapeIdRaw = attributeOf(descendants(childTnLst, 'p:spTgt')[0], 'spid');
  const shapeId = shapeIdRaw !== undefined && /^\d+$/.test(shapeIdRaw) ? Number.parseInt(shapeIdRaw, 10) : null;
  if (shapeId === null) return null;

  // 行为节点：除去 p:set 以外的第一个可识别行为。
  const behaviors = childElements(childTnLst);
  let classified: { effect: AnimationEffectName; kind: AnimationKind } | null = null;
  let durationMs: number | null = null;
  for (const behavior of behaviors) {
    if (behavior.name === 'p:set') continue;
    const candidate = classifyBehavior(behavior, kindFromSet);
    if (candidate !== null) {
      classified = candidate;
      durationMs = behaviorDuration(behavior);
      break;
    }
  }

  const effect: AnimationEffectName = classified?.effect ?? 'appear';
  const kind: AnimationKind = classified?.kind ?? kindFromSet ?? 'entrance';

  // P-I05：appear（无别的行为节点）取可见性 p:set 的 dur；缺省仍是 1。
  const resolvedDuration =
    classified === null && setNode !== undefined ? (behaviorDuration(setNode) ?? 1) : (durationMs ?? 1);

  return {
    spec: Object.freeze({ shape_id: shapeId, effect, kind, trigger, duration_ms: resolvedDuration, delay_ms: writtenDelay }),
    written_delay: writtenDelay,
  };
}

/**
 * 把 `p:timing` 文本读回成动画规格（按文档顺序）。
 *
 * 结构里 `mainSeq` 下的每个点击组是 `p:par`，组内每个效果又是 `p:par`；
 * 本函数只从**效果级** `p:par`（带 `nodeType=clickEffect/withEffect/afterEffect`）取值，
 * 因此组级 `p:par`（无这些 nodeType）会被 `readEffectPar` 自然跳过。
 * **空时序树**（`mainSeq` 下没有点击组）⇒ 返回空数组，而不是抛错。
 *
 * `after_previous` 的延迟还原：写侧落的是组内绝对延迟 `delay = 游标 + spec.delay_ms`，
 * 游标随后更新为 `delay + duration`。读侧用**同一套更新**（`cursor = written_delay + duration`）
 * 沿组反推，`spec.delay_ms = written_delay - cursor`，从而无损恢复相对延迟。
 */
export function parseTimingXml(xml: string): readonly AnimationSpec[] {
  const root = requireTimingRoot(xml);
  const mainSeq = descendants(root, 'p:cTn').find((cTn) => attributeOf(cTn, 'nodeType') === 'mainSeq');
  if (mainSeq === undefined) return Object.freeze([]);
  const mainChildTnLst = firstElement(mainSeq, 'p:childTnLst');
  if (mainChildTnLst === undefined) return Object.freeze([]);

  const specs: AnimationSpec[] = [];
  for (const groupPar of childElements(mainChildTnLst, 'p:par')) {
    const groupChildTnLst = firstElement(firstElement(groupPar, 'p:cTn'), 'p:childTnLst');
    if (groupChildTnLst === undefined) continue;
    let delayCursor = 0;
    for (const effectPar of childElements(groupChildTnLst, 'p:par')) {
      const read = readEffectPar(effectPar);
      if (read === null) continue;
      const relativeDelay =
        read.spec.trigger === 'after_previous' ? Math.max(0, read.written_delay - delayCursor) : read.written_delay;
      delayCursor = read.written_delay + read.spec.duration_ms;
      specs.push(Object.freeze({ ...read.spec, delay_ms: relativeDelay }));
    }
  }
  return Object.freeze(specs);
}

/**
 * 读回媒体自动播放条目（`p:video` / `p:audio`）。
 *
 * 只看带 `nodeType="afterEffect"` 且含媒体节点的 `p:par`：
 * `p:cond@delay`（`0`=自动播放 / `indefinite`=点击）、`p:cTn@repeatCount`（`indefinite`=循环）、
 * `p:cMediaNode` 的 `vol` / `mute` / `showWhenStopped`、以及 `p:spTgt@spid`。空 ⇒ 空数组。
 */
export function parseMediaTimingXml(xml: string): readonly MediaTimingSpec[] {
  const root = requireTimingRoot(xml);
  const specs: MediaTimingSpec[] = [];
  for (const par of descendants(root, 'p:par')) {
    const spec = readMediaPar(par);
    if (spec !== null) specs.push(spec);
  }
  return Object.freeze(specs);
}

function readMediaPar(par: XmlElementNode): MediaTimingSpec | null {
  const cTn = firstElement(par, 'p:cTn');
  if (attributeOf(cTn, 'nodeType') !== 'afterEffect') return null;

  const mediaNode = descendants(par, 'p:video')[0] ?? descendants(par, 'p:audio')[0];
  if (mediaNode === undefined) return null;

  const spidRaw = attributeOf(descendants(mediaNode, 'p:spTgt')[0], 'spid');
  if (spidRaw === undefined || !/^\d+$/.test(spidRaw)) return null;

  const cMediaNode = firstElement(mediaNode, 'p:cMediaNode');
  const volRaw = attributeOf(cMediaNode, 'vol') ?? '0';
  const volume = /^\d+$/.test(volRaw) ? Number.parseInt(volRaw, 10) : 0;
  const delayRaw = attributeOf(firstElement(firstElement(cTn, 'p:stCondLst'), 'p:cond'), 'delay') ?? '0';

  return Object.freeze({
    shape_id: Number.parseInt(spidRaw, 10),
    media_kind: mediaNode.name === 'p:video' ? 'video' : 'audio',
    autoplay: delayRaw === '0',
    loop: attributeOf(cTn, 'repeatCount') === 'indefinite',
    volume,
    muted: attributeOf(cMediaNode, 'mute') === '1',
    show_controls: attributeOf(cMediaNode, 'showWhenStopped') === '1',
  });
}

/** 一次读回一棵 `p:timing` 里的**形状效果**与**媒体条目**。 */
export function parseTimingTreeXml(xml: string): {
  readonly shapes: readonly AnimationSpec[];
  readonly media: readonly MediaTimingSpec[];
} {
  return Object.freeze({ shapes: parseTimingXml(xml), media: parseMediaTimingXml(xml) });
}

/** 时序块里**效果节点**（效果级 `p:par`）的条数；用于"空 vs 有内容"的判据。 */
export function countTimingEffects(xml: string): number {
  return parseTimingXml(xml).length;
}

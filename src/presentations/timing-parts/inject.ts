/**
 * P08 · **时序块的 schema 位置注入 / 剥离**（幻灯片 XML ↔ `p:timing`）。
 *
 * ## 为什么不是"往字符串尾部一贴"
 *
 * `p:sld` 的子元素在 ECMA-376 的 `CT_Slide` 里是**有序序列**：
 *
 * ```
 * p:cSld → p:clrMapOvr → p:transition → p:timing → p:extLst
 * ```
 *
 * `p:timing` 必须排在 `p:transition` **之后**。随手追加到 `</p:sld>` 之前，在无 `p:transition`
 * 时恰好对；一旦这一页有切换，就会写出 `p:timing` 在 `p:transition` 之前的**非法顺序**——
 * 文件能解压，但严格消费者会拒绝或忽略时序。本模块把插入点收敛成**唯一实现**：
 * 有 `p:transition` 就插在其后，否则插在 `p:clrMapOvr` 之后，再否则插在 `</p:sld>` 之前。
 *
 * ## 幂等
 *
 * `injectTiming` 先 `stripTiming` 再插入：同一页反复注入**不会堆叠**多块 `p:timing`
 * （重复注入是 P01 装配多次调用时的常见误用，必须安全）。
 *
 * ## 边界
 *
 * - 只做**字符串级**定位，不重排既有子元素、不动空白；
 * - 定位失败（没有 `p:sld` 根 / 找不到闭合）⇒ 具名抛错，不产出半个文件；
 * - `p:timing` 只可能是 `p:sld` 的**直接子元素**（本层只注入这一处，不处理 notesSlide 的时序）。
 */

import { parseXmlDocument } from '../xml-parse.js';

import { TimingPartsError } from './errors.js';

/** 取开始标签 `idx`（指向 `<`）之后第一个 `>` 的下标，跳过引号内的 `>`。 */
function findTagClose(xml: string, idx: number): number {
  let quote: string | null = null;
  for (let i = idx; i < xml.length; i += 1) {
    const ch = xml.charAt(i);
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

/** 从 `from` 起找下一个名字为 `name` 的开始标签位置（边界字符校验，避免 `p:timingFoo`）。 */
function nextOpenStart(xml: string, name: string, from: number): number {
  const marker = `<${name}`;
  let idx = xml.indexOf(marker, from);
  while (idx >= 0) {
    const after = xml.charAt(idx + marker.length);
    if (after === '' || after === ' ' || after === '>' || after === '/' || after === '\t' || after === '\n' || after === '\r') {
      return idx;
    }
    idx = xml.indexOf(marker, idx + 1);
  }
  return -1;
}

/** 元素在文本里的闭区间 `[start, end)`（含开始与结束标签）；找不到 ⇒ `null`。 */
export function findElementRange(xml: string, name: string): { readonly start: number; readonly end: number } | null {
  const start = nextOpenStart(xml, name, 0);
  if (start < 0) return null;
  const tagEnd = findTagClose(xml, start);
  if (tagEnd < 0) return null;
  if (xml.charAt(tagEnd - 1) === '/') return { start, end: tagEnd + 1 };

  const closeMarker = `</${name}>`;
  let depth = 1;
  let cursor = tagEnd + 1;
  for (;;) {
    const nextClose = xml.indexOf(closeMarker, cursor);
    if (nextClose < 0) return null;
    const nextOpen = nextOpenStart(xml, name, cursor);
    if (nextOpen >= 0 && nextOpen < nextClose) {
      const oe = findTagClose(xml, nextOpen);
      if (oe < 0) return null;
      if (xml.charAt(oe - 1) !== '/') depth += 1;
      cursor = oe + 1;
      continue;
    }
    depth -= 1;
    if (depth === 0) return { start, end: nextClose + closeMarker.length };
    cursor = nextClose + closeMarker.length;
  }
}

/** 这一页是否已经有 `p:timing`。 */
export function hasTiming(slideXml: string): boolean {
  return findElementRange(slideXml, 'p:timing') !== null;
}

/** 去掉 `p:timing`（没有则原样返回）。用于幂等注入与"清除"。 */
export function stripTiming(slideXml: string): string {
  const range = findElementRange(slideXml, 'p:timing');
  if (range === null) return slideXml;
  return `${slideXml.slice(0, range.start)}${slideXml.slice(range.end)}`;
}

/** 断言 `timingXml` 是单根 `p:timing`。 */
function assertTimingXml(timingXml: string): void {
  let rootName: string;
  try {
    rootName = parseXmlDocument(timingXml).name;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TimingPartsError('invalid_timing_xml', `时序 XML 解析失败：${detail}`);
  }
  if (rootName !== 'p:timing') {
    throw new TimingPartsError('invalid_timing_xml', `时序块根元素是 ${rootName}，不是 p:timing`);
  }
}

/** 幻灯片根闭合位置（`</p:sld>` 的下标）；找不到 ⇒ 抛错。 */
function slideCloseIndex(slideXml: string): number {
  if (nextOpenStart(slideXml, 'p:sld', 0) < 0) {
    throw new TimingPartsError('missing_slide_root', '幻灯片 XML 里没有 p:sld 根元素');
  }
  const range = findElementRange(slideXml, 'p:sld');
  if (range === null) {
    throw new TimingPartsError('missing_slide_close', '幻灯片 XML 里 p:sld 没有正确闭合');
  }
  return range.end - '</p:sld>'.length;
}

/**
 * 把 `p:timing` 按 schema 顺序**注入**幻灯片 XML（幂等：先剥离旧的再插）。
 *
 * 插入点：`p:transition` 之后 → 无则 `p:clrMapOvr` 之后 → 无则 `</p:sld>` 之前。
 */
export function injectTiming(slideXml: string, timingXml: string): string {
  assertTimingXml(timingXml);
  const base = stripTiming(slideXml);
  const transition = findElementRange(base, 'p:transition');
  if (transition !== null) {
    return `${base.slice(0, transition.end)}${timingXml}${base.slice(transition.end)}`;
  }
  const clrMapOvr = findElementRange(base, 'p:clrMapOvr');
  if (clrMapOvr !== null) {
    return `${base.slice(0, clrMapOvr.end)}${timingXml}${base.slice(clrMapOvr.end)}`;
  }
  const closeAt = slideCloseIndex(base);
  return `${base.slice(0, closeAt)}${timingXml}${base.slice(closeAt)}`;
}

/** 注入一个时序描述符的 XML。 */
export function applyTimingDescriptor(slideXml: string, descriptor: { readonly xml: string }): string {
  return injectTiming(slideXml, descriptor.xml);
}

/** 清除幻灯片里的时序块（等价于"这页没有动画"——直接移除，不写空块）。 */
export function clearTimingFromSlide(slideXml: string): string {
  return stripTiming(slideXml);
}

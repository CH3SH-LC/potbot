/**
 * 事实抽取：**日期**与**带单位的量**（RES-04）。纯正则、确定性、不调用模型。
 *
 * 三条纪律：
 * 1. 抽出的每个值都带 `part`（定位器 + **整单元原文**），因此可回读核对；
 *    `value.raw` 给匹配到的精确子串，`localIndex` 给它在块内的位置（用于取标签）；
 * 2. **不猜**：单位无法归一化就不给 `normalized`；
 * 3. 来源之间数值不一致时由 `detectConflicts` **显式列出冲突**，不替用户裁决谁对。
 */
import type { Chunk, CitationPart, ExtractedDatum, ExtractedValue, NormalizedDoc } from './types.js';

/** 单位 → 基准换算（只在同类可比时才给 normalized）。 */
const UNIT_SCALE: Record<string, { base: string; factor: number }> = {
  万元: { base: '元', factor: 10000 },
  万: { base: '元', factor: 10000 },
  元: { base: '元', factor: 1 },
  MB: { base: 'MB', factor: 1 },
  GB: { base: 'MB', factor: 1024 },
  KB: { base: 'MB', factor: 1 / 1024 },
  小时: { base: '分钟', factor: 60 },
  分钟: { base: '分钟', factor: 1 },
  天: { base: '天', factor: 1 },
  人: { base: '人', factor: 1 },
  '%': { base: '%', factor: 1 },
};

const UNIT_PATTERN = Object.keys(UNIT_SCALE)
  .sort((a, b) => b.length - a.length)
  .map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

/** 找到块内偏移所属的**单元**分段，返回其引用部件。 */
export function resolverForChunk(
  doc: NormalizedDoc,
  chunk: Chunk,
): (localStart: number, localEnd: number) => CitationPart {
  return (localStart, localEnd) => {
    const docStart = chunk.start + localStart;
    const docEnd = chunk.start + localEnd;
    for (const segment of doc.segments) {
      if (docEnd <= segment.start || docStart >= segment.end) {
        continue;
      }
      // 单元必须完整包含匹配；否则说明块边界切开了单元（不应发生）。
      if (segment.start > docStart || segment.end < docEnd) {
        throw new Error(
          `抽取范围 [${docStart},${docEnd}) 未被单个单元包含——块边界切开了定位单元，引用无法精确回读`,
        );
      }
      return { locator: segment.locator, quote: doc.text.slice(segment.start, segment.end) };
    }
    throw new Error(`抽取范围 [${docStart},${docEnd}) 不在任何单元内`);
  };
}

/** 从一段文本抽日期与带单位量；`unitPart` 负责把偏移映射成可回读的部件。 */
export function extractFromText(
  text: string,
  chunkId: string,
  sourceId: string,
  unitPart: (localStart: number, localEnd: number) => CitationPart,
): ExtractedValue[] {
  const values: ExtractedValue[] = [];
  const dateRanges: { start: number; end: number }[] = [];
  let m: RegExpExecArray | null;

  const dateRe = /(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/g;
  while ((m = dateRe.exec(text)) !== null) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      continue;
    }
    const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    dateRanges.push({ start: m.index, end: m.index + m[0].length });
    values.push({
      chunkId,
      sourceId,
      part: unitPart(m.index, m.index + m[0].length),
      localIndex: m.index,
      value: { type: 'date', iso, raw: m[0] },
    });
  }

  const measureRe = new RegExp(`(¥|￥|\\$)?\\s*(\\d+(?:\\.\\d+)?)\\s*(${UNIT_PATTERN})`, 'g');
  while ((m = measureRe.exec(text)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (dateRanges.some((r) => start < r.end && r.start < end)) {
      continue;
    }
    const amount = Number(m[2]);
    const unit = m[3] as string;
    const scale = UNIT_SCALE[unit];
    values.push({
      chunkId,
      sourceId,
      part: unitPart(start, end),
      localIndex: start,
      value: {
        type: 'measure',
        value: amount,
        unit,
        raw: m[0],
        ...(scale ? { normalized: { value: amount * scale.factor, unit: scale.base } } : {}),
      },
    });
  }

  return values;
}

/** 从块抽值。 */
export function extractFromChunk(doc: NormalizedDoc, chunk: Chunk): ExtractedValue[] {
  return extractFromText(chunk.text, chunk.chunkId, chunk.sourceId, resolverForChunk(doc, chunk));
}

export interface ConflictEntry {
  readonly sourceId: string;
  readonly chunkId: string;
  readonly value: string;
  readonly part: CitationPart;
}

export interface Conflict {
  /** 相同"标签"（数值之前的短文本），用于判断两值在说同一件事。 */
  readonly label: string;
  readonly entries: readonly ConflictEntry[];
}

/**
 * 取数值前的"标签"。**刻意剔除数字与日期标点**：
 * 否则 "2026-03-05 预算 1200 元" 与 "2026-04-01 预算 1500 元" 会因日期不同
 * 被判成不同标签，从而漏报冲突。剔除后两者标签同为 "预算"，冲突得以暴露。
 */
function labelBefore(text: string, index: number): string {
  const window = text.slice(Math.max(0, index - 16), index);
  return window
    .replace(/[0-9]/g, '')
    .replace(/[-/年月日:：.]+/g, '')
    .replace(/[\s,，。;；、()（）]+/g, '')
    .slice(-6);
}

function describe(datum: ExtractedDatum): string {
  if (datum.type === 'date') {
    return datum.iso;
  }
  if (datum.type === 'number') {
    return String(datum.value);
  }
  return `${datum.value}${datum.unit}`;
}

function normKey(datum: ExtractedDatum): string {
  if (datum.type !== 'measure') {
    return describe(datum);
  }
  return datum.normalized
    ? `${datum.normalized.value}${datum.normalized.unit}`
    : `${datum.value}${datum.unit}`;
}

/**
 * 来源冲突检测：同一标签下、来自**不同来源**的量值不一致 ⇒ 记为冲突。
 * 只报冲突，不裁决——裁决需要用户或更权威来源（RES-04「来源冲突可见」）。
 */
export function detectConflicts(
  values: readonly ExtractedValue[],
  textOfChunk: (chunkId: string) => string,
): Conflict[] {
  const byLabel = new Map<string, ExtractedValue[]>();
  for (const v of values) {
    if (v.value.type !== 'measure') {
      continue;
    }
    const label = labelBefore(textOfChunk(v.chunkId), v.localIndex);
    if (label.length === 0) {
      continue;
    }
    const list = byLabel.get(label) ?? [];
    list.push(v);
    byLabel.set(label, list);
  }

  const conflicts: Conflict[] = [];
  for (const [label, list] of byLabel) {
    const distinct = new Set(list.map((v) => normKey(v.value)));
    const sources = new Set(list.map((v) => v.sourceId));
    if (distinct.size > 1 && sources.size > 1) {
      conflicts.push({
        label,
        entries: list.map((v) => ({
          sourceId: v.sourceId,
          chunkId: v.chunkId,
          value: describe(v.value),
          part: v.part,
        })),
      });
    }
  }
  return conflicts;
}

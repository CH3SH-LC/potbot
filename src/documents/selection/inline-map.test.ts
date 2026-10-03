/**
 * 跨 run 拼接与再切分单测（合同 R102、R104、R147/R151）。
 *
 * 核心不变式：**切分不改字**——`before + selected + after` 的文本必须逐码位等于原文。
 */

import { describe, expect, it } from 'vitest';

import type { InlineNode } from '../model/types.js';
import { deepEqual } from './equals.js';
import {
  BREAK_TEXT,
  FIELD_PLACEHOLDER,
  buildInlineTextMap,
  derivePieceId,
  inlineText,
  mapSelectedRuns,
  replaceRangeInInlines,
  segmentText,
  splitInlinesAtRange,
} from './inline-map.js';
import {
  boldOn,
  breakNode,
  field,
  paragraphOfRuns,
  run,
  unspecifiedRunProperties,
  ZWJ_FAMILY,
} from './testing.js';

function textsOf(inlines: readonly InlineNode[]): string[] {
  return inlines.map((node) => segmentText(node));
}

function propertiesOf(inlines: readonly InlineNode[], index: number) {
  const node = inlines[index]!;
  return node.kind === 'run' ? node.properties : null;
}

describe('buildInlineTextMap —— 偏移空间', () => {
  it('run 贡献文本、软换行占一个 \\n、域占其缓存值或占位符', () => {
    const paragraph = paragraphOfRuns('p1', [
      ['r1', '你好'],
      ['r2', '世界'],
    ]);

    const map = buildInlineTextMap([
      ...paragraph.inlines,
      breakNode('b1'),
      field('f1', 'PAGE', '3'),
      field('f2', 'DATE', null),
    ]);

    expect(map.text).toBe(`你好世界${BREAK_TEXT}3${FIELD_PLACEHOLDER}`);
    expect(map.total).toBe(7);
    expect(map.segments.map((segment) => [segment.kind, segment.start, segment.end, segment.editable])).toEqual([
      ['run', 0, 2, true],
      ['run', 2, 4, true],
      ['break', 4, 5, false],
      ['field', 5, 6, false],
      ['field', 6, 7, false],
    ]);
  });

  it('emoji 段按码位计数（不是 UTF-16）', () => {
    const paragraph = paragraphOfRuns('p1', [
      ['r1', ZWJ_FAMILY],
      ['r2', 'ab'],
    ]);
    const map = buildInlineTextMap(paragraph.inlines);
    expect(map.total).toBe(7);
    expect(map.segments[0]).toMatchObject({ start: 0, end: 5 });
    expect(map.segments[1]).toMatchObject({ start: 5, end: 7 });
  });
});

describe('splitInlinesAtRange —— 只切被穿过的 run', () => {
  it('词跨 3 个 run：两端各切一刀，中间整段被选', () => {
    // 文本：他(0) 天(1) 气(2) 很(3) 好(4) 啊(5)；词"天气很好" = [1, 5)
    const paragraph = paragraphOfRuns('p1', [
      ['r1', '他天'],
      ['r2', '气很'],
      ['r3', '好啊'],
    ]);
    const originalText = inlineText(paragraph.inlines);

    const split = splitInlinesAtRange(paragraph.inlines, 1, 5);
    expect(split.ok).toBe(true);
    if (!split.ok) return;

    expect(textsOf(split.value.before)).toEqual(['他']);
    expect(textsOf(split.value.selected)).toEqual(['天', '气很', '好']);
    expect(textsOf(split.value.after)).toEqual(['啊']);
    expect(split.value.selectedRunCount).toBe(3);
    expect(split.value.containedNonEditable).toBe(false);

    // 切分不改字（R147/R151）
    const rejoined = inlineText([...split.value.before, ...split.value.selected, ...split.value.after]);
    expect(Array.from(rejoined)).toEqual(Array.from(originalText));
  });

  it('片段 id：未切开的保留原 id，切开的后缀用确定性派生 id', () => {
    const paragraph = paragraphOfRuns('p1', [
      ['r1', '他天'],
      ['r2', '气很'],
      ['r3', '好啊'],
    ]);
    const split = splitInlinesAtRange(paragraph.inlines, 1, 5);
    expect(split.ok).toBe(true);
    if (!split.ok) return;

    const ids = [...split.value.before, ...split.value.selected, ...split.value.after].map((node) => node.id);
    // 头部片段保留原 id（原 run 以"头部"的身份存活），其余片段用确定性派生 id。
    expect(ids).toEqual(['r1', derivePieceId('r1', 'm'), 'r2', derivePieceId('r3', 'm'), derivePieceId('r3', 's')]);
    expect(derivePieceId('r1', 'm')).toBe('r1~m');
  });

  it('完全落在范围外的 run 按引用原样保留（不做无谓重建）', () => {
    const paragraph = paragraphOfRuns('p1', [
      ['r1', '甲'],
      ['r2', '乙丙'],
      ['r3', '丁'],
    ]);
    const split = splitInlinesAtRange(paragraph.inlines, 1, 3);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.value.before[0]).toBe(paragraph.inlines[0]);
    expect(split.value.after[0]).toBe(paragraph.inlines[2]);
  });

  it('范围完整包含软换行：标记 containedNonEditable，格式化时原样带过', () => {
    const inlines = [run('r1', '前'), breakNode('b1'), run('r2', '后')];
    const split = splitInlinesAtRange(inlines, 1, 3);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.value.containedNonEditable).toBe(true);

    const mapped = mapSelectedRuns(split.value, (node) => ({ ...node, properties: boldOn() }));
    expect(textsOf(mapped)).toEqual(['前', '\n', '后']);
    expect(mapped[1]).toBe(inlines[1]);
  });

  it('边界落在多码位域的内部 → unsupported（拒绝把域切一半）', () => {
    const inlines = [run('r1', '前'), field('f1', 'PAGE', '123'), run('r2', '后')];
    const split = splitInlinesAtRange(inlines, 1, 3);
    expect(split.ok).toBe(false);
    if (split.ok) return;
    expect(split.code).toBe('unsupported');
  });

  it('越界范围 → invalid_range', () => {
    const paragraph = paragraphOfRuns('p1', [['r1', 'abc']]);
    const split = splitInlinesAtRange(paragraph.inlines, 0, 4);
    expect(split.ok).toBe(false);
    if (split.ok) return;
    expect(split.code).toBe('invalid_range');
  });

  it('空范围是合法的插入点：不改动任何 run', () => {
    const paragraph = paragraphOfRuns('p1', [
      ['r1', '甲'],
      ['r2', '乙'],
    ]);
    const split = splitInlinesAtRange(paragraph.inlines, 1, 1);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.value.selectedRunCount).toBe(0);
    expect(inlineText([...split.value.before, ...split.value.selected, ...split.value.after])).toBe('甲乙');
  });
});

describe('replaceRangeInInlines —— 保格式替换', () => {
  it('词跨 3 个 run 替换后：文本正确、替换文本沿用起始 run 的属性', () => {
    const bold = boldOn();
    const paragraph = paragraphOfRuns('p1', [
      ['r1', '他天', bold],
      ['r2', '气很'],
      ['r3', '好啊'],
    ]);
    const replaced = replaceRangeInInlines(paragraph.inlines, 1, 5, '气候不错');
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;

    expect(inlineText(replaced.value)).toBe('他气候不错啊');
    const insertedIndex = replaced.value.findIndex((node) => node.kind === 'run' && node.text === '气候不错');
    expect(insertedIndex).toBeGreaterThanOrEqual(0);
    expect(propertiesOf(replaced.value, insertedIndex)?.bold).toEqual({ state: 'on' });
  });

  it('范围包含软换行 → unsupported（替换会删结构）', () => {
    const inlines = [run('r1', '前'), breakNode('b1'), run('r2', '后')];
    const replaced = replaceRangeInInlines(inlines, 0, 3, 'X');
    expect(replaced.ok).toBe(false);
    if (replaced.ok) return;
    expect(replaced.code).toBe('unsupported');
  });

  it('空范围 + 空替换是纯 no-op，返回原数组', () => {
    const inlines = [run('r1', '甲乙')];
    const replaced = replaceRangeInInlines(inlines, 1, 1, '');
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(replaced.value).toBe(inlines);
  });

  it('删除命中后：文本正确、其余 run 属性逐字段不变', () => {
    const untouched = boldOn();
    const paragraph = paragraphOfRuns('p1', [
      ['r1', 'keep-', untouched],
      ['r2', '删除我'],
      ['r3', '-tail'],
    ]);
    const replaced = replaceRangeInInlines(paragraph.inlines, 5, 8, '');
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(inlineText(replaced.value)).toBe('keep--tail');
    expect(deepEqual(propertiesOf(replaced.value, 0), untouched)).toBe(true);
    expect(deepEqual(propertiesOf(replaced.value, replaced.value.length - 1), unspecifiedRunProperties())).toBe(true);
  });
});

/**
 * 查找替换单测（WF-085；R112/R113/R136/R151）。
 *
 * 判据："同一词出现两处，**只改第二处**，第一处不变"——这里既用 `nth` 表达，
 * 也用"不显式要求全部就不许全改"这条规矩从反面钉住。
 */

import { describe, expect, it } from 'vitest';

import { deepEqual } from '../../selection/equals.js';
import { inlineText } from '../../selection/inline-map.js';
import { collectParagraphs, paragraphText, requireParagraph } from '../../selection/structure.js';
import {
  boldOn,
  document,
  paragraphOfRuns,
  unspecifiedRunProperties,
} from '../../selection/testing.js';
import {
  REPLACE_ALL,
  REPLACE_FIRST,
  replaceText,
  replaceTextInSelection,
} from './replace.js';

const twoOccurrences = document([
  paragraphOfRuns('p1', [['r1', '天气很好']]),
  paragraphOfRuns('p2', [['r2', '天气不错']]),
]);

function textsOf(model: ReturnType<typeof document>): string[] {
  return collectParagraphs(model.blocks).map(paragraphText);
}

describe('判据：同一词出现两处，只改第二处', () => {
  it('scope = nth(2) ⇒ 只改第二处，第一处文本与属性都不变', () => {
    const replaced = replaceText(twoOccurrences, '天气', '气候', { kind: 'nth', index: 2 });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;

    expect(replaced.value.report.replaced).toBe(1);
    expect(replaced.value.report.totalMatches).toBe(2);
    expect(textsOf(replaced.value.model)).toEqual(['天气很好', '气候不错']);
    // 第一段整块对象未变（未命中路径原引用返回）
    expect(replaced.value.model.blocks[0]).toBe(twoOccurrences.blocks[0]);
  });

  it('scope = first ⇒ 只改第一处', () => {
    const replaced = replaceText(twoOccurrences, '天气', '气候', REPLACE_FIRST);
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(textsOf(replaced.value.model)).toEqual(['气候很好', '天气不错']);
  });

  it('scope = all 但没显式确认 ⇒ ambiguous + 候选，一个字都不改（R113）', () => {
    const replaced = replaceText(twoOccurrences, '天气', '气候', REPLACE_ALL);
    expect(replaced.ok).toBe(false);
    if (replaced.ok) return;
    expect(replaced.code).toBe('ambiguous');
    expect(replaced.detail.hitCount).toBe(2);
    expect(replaced.detail.candidates).toEqual([
      { node_id: 'p1', start: 0, end: 2 },
      { node_id: 'p2', start: 0, end: 2 },
    ]);
    // 源文档未被改动
    expect(textsOf(twoOccurrences)).toEqual(['天气很好', '天气不错']);
  });

  it('scope = all 且 confirmAll ⇒ 两处都改', () => {
    const replaced = replaceText(twoOccurrences, '天气', '气候', REPLACE_ALL, { confirmAll: true });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(replaced.value.report.replaced).toBe(2);
    expect(textsOf(replaced.value.model)).toEqual(['气候很好', '气候不错']);
  });

  it('scope = all 且只有一处命中 ⇒ 不强制要求 confirmAll', () => {
    const once = document([paragraphOfRuns('p1', [['r1', '天气很好']])]);
    const replaced = replaceText(once, '天气', '气候', REPLACE_ALL);
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(replaced.value.report.replaced).toBe(1);
  });

  it('nth 越界 ⇒ not_found，且带候选列表', () => {
    const replaced = replaceText(twoOccurrences, '天气', '气候', { kind: 'nth', index: 5 });
    expect(replaced.ok).toBe(false);
    if (replaced.ok) return;
    expect(replaced.code).toBe('not_found');
    expect(replaced.detail.hitCount).toBe(2);
    expect(replaced.detail.candidates).toHaveLength(2);
  });
});

describe('R112：命中零项 / 非法查询都要可解释', () => {
  it('查不到 ⇒ not_found，带查找词', () => {
    const replaced = replaceText(twoOccurrences, '不存在', 'X', REPLACE_FIRST);
    expect(replaced.ok).toBe(false);
    if (replaced.ok) return;
    expect(replaced.code).toBe('not_found');
    expect(replaced.detail.expression).toBe('不存在');
    expect(replaced.detail.hitCount).toBe(0);
  });

  it('空查询 ⇒ invalid_query', () => {
    const replaced = replaceText(twoOccurrences, '', 'X', REPLACE_FIRST);
    expect(replaced.ok).toBe(false);
    if (replaced.ok) return;
    expect(replaced.code).toBe('invalid_query');
  });

  it('限定的 range 内没有命中 ⇒ not_found（不是"改了别处"）', () => {
    const replaced = replaceText(twoOccurrences, '天气', '气候', {
      kind: 'range',
      range: { node_id: 'p2', start: 2, end: 4 },
    });
    expect(replaced.ok).toBe(false);
    if (replaced.ok) return;
    expect(replaced.code).toBe('not_found');
    expect(textsOf(twoOccurrences)).toEqual(['天气很好', '天气不错']);
  });

  it('限定的 range 作用域只在该范围内替换', () => {
    const replaced = replaceText(twoOccurrences, '天气', '气候', {
      kind: 'range',
      range: { node_id: 'p2', start: 0, end: 4 },
    });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(textsOf(replaced.value.model)).toEqual(['天气很好', '气候不错']);
  });
});

describe('跨 run 替换 + 保格式', () => {
  const doc = document([
    paragraphOfRuns('p1', [
      ['r1', '他天', boldOn()],
      ['r2', '气很'],
      ['r3', '好啊'],
    ]),
  ]);

  it('词跨 3 个 run：替换成功，替换文本沿用起始 run 的格式', () => {
    const replaced = replaceText(doc, '天气很好', '气候不错', REPLACE_FIRST);
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;

    const paragraph = requireParagraph(replaced.value.model, 'p1');
    expect(paragraph.ok).toBe(true);
    if (!paragraph.ok) return;
    expect(inlineText(paragraph.value.inlines)).toBe('他气候不错啊');

    const inserted = paragraph.value.inlines.find((node) => node.kind === 'run' && node.text === '气候不错');
    expect(inserted?.kind === 'run' && inserted.properties.bold).toEqual({ state: 'on' });

    // 未受影响的 run 属性不变
    const first = paragraph.value.inlines[0];
    expect(first?.kind === 'run' && deepEqual(first.properties, boldOn())).toBe(true);
    const last = paragraph.value.inlines[paragraph.value.inlines.length - 1];
    expect(last?.kind === 'run' && deepEqual(last.properties, unspecifiedRunProperties())).toBe(true);
  });

  it('目标是空串 ⇒ 纯删除，其余文本次序不变', () => {
    const replaced = replaceText(doc, '天气很好', '', REPLACE_FIRST);
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    const paragraph = requireParagraph(replaced.value.model, 'p1');
    expect(paragraph.ok && inlineText(paragraph.value.inlines)).toBe('他啊');
  });
});

describe('选区范围内替换 + R114', () => {
  const doc = document([paragraphOfRuns('p1', [['r1', '天气天气']])]);

  it('只替换选区内的那一次', () => {
    const replaced = replaceTextInSelection(
      doc,
      { document_id: 'doc-1', base_revision: 1, ranges: [{ node_id: 'p1', start: 2, end: 4 }] },
      '天气',
      '气候',
      REPLACE_FIRST,
    );
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    const paragraph = requireParagraph(replaced.value.model, 'p1');
    expect(paragraph.ok && inlineText(paragraph.value.inlines)).toBe('天气气候');
  });

  it('选区 revision 过期 ⇒ stale_revision，模型不变', () => {
    const replaced = replaceTextInSelection(
      doc,
      { document_id: 'doc-1', base_revision: 0, ranges: [{ node_id: 'p1', start: 2, end: 4 }] },
      '天气',
      '气候',
      REPLACE_FIRST,
    );
    expect(replaced.ok).toBe(false);
    if (replaced.ok) return;
    expect(replaced.code).toBe('stale_revision');
    expect(textsOf(doc)).toEqual(['天气天气']);
  });
});

/**
 * 标题与大纲级别测试（WF-036，R115/R125）。
 *
 * 判据：
 * - 标题 1–9 与 `outlineLevel` 0–8 **正确关联**；
 * - 应用标题写的是 `pStyle` 引用（WF-035），不是外观硬写；
 * - 判"是不是标题"只看样式/大纲级别，**不看字号**（R115 的反例）。
 */

import { describe, expect, it } from 'vitest';
import type { ParagraphNode, StyleDefinition, StyleTable } from '../model/types.js';
import {
  applyHeading,
  effectiveHeadingLevel,
  ensureHeadingStyles,
  headingLevelFromOutlineLevel,
  headingLevelFromStyleId,
  headingLevelOfStyle,
  headingStyleId,
  headingStyleChainProblems,
  isHeadingParagraph,
  isHeadingStyle,
  outlineLevelFromHeadingLevel,
  outlineLevelOfParagraph,
} from './outline.js';
import { findStyle, resolveStyleChain } from './chain.js';
import { createDefaultParagraphProperties } from '../operations/paragraph/defaults.js';
import { defaultRunProperties } from '../model/nodes.js';
import { setAlignment } from '../operations/paragraph/alignment.js';

function style(style_id: string, extra: Partial<StyleDefinition> = {}): StyleDefinition {
  return {
    style_id,
    name: style_id,
    type: 'paragraph',
    based_on: null,
    run_properties: {},
    paragraph_properties: {},
    is_default: false,
    ...extra,
  };
}

function para(id: string, styleRef: string | null = null, runSizePt?: number): ParagraphNode {
  return {
    kind: 'paragraph',
    id,
    source: 'user_request',
    opaque: [],
    properties: createDefaultParagraphProperties(),
    inlines:
      runSizePt === undefined
        ? []
        : [
            {
              kind: 'run',
              id: `${id}-r`,
              source: 'user_request',
              opaque: [],
              properties: {
                ...defaultRunProperties(),
                size: { state: 'set', value: { kind: 'pt', value: runSizePt } },
              },
              text: '看起来很大的字',
            },
          ],
    style_ref: styleRef,
    numbering: null,
  };
}

describe('级别映射（唯一实现）', () => {
  it('标题 1–9 ↔ outlineLevel 0–8', () => {
    expect(outlineLevelFromHeadingLevel(1)).toBe(0);
    expect(outlineLevelFromHeadingLevel(9)).toBe(8);
    expect(headingLevelFromOutlineLevel(0)).toBe(1);
    expect(headingLevelFromOutlineLevel(8)).toBe(9);
  });

  it('越界返回 null（不夹紧成边界值）', () => {
    expect(outlineLevelFromHeadingLevel(0)).toBeNull();
    expect(outlineLevelFromHeadingLevel(10)).toBeNull();
    expect(headingLevelFromOutlineLevel(-1)).toBeNull();
    expect(headingLevelFromOutlineLevel(9)).toBeNull();
    expect(headingStyleId(0)).toBeNull();
    expect(headingStyleId(3)).toBe('Heading3');
  });

  it('从 id 或名字识别标题级别', () => {
    expect(headingLevelFromStyleId('Heading4')).toBe(4);
    expect(headingLevelFromStyleId('标题 2')).toBe(2);
    expect(headingLevelFromStyleId('Normal')).toBeNull();
    expect(isHeadingStyle(style('Heading1'))).toBe(true);
    expect(isHeadingStyle(style('Quote', { name: '引用' }))).toBe(false);
    expect(headingLevelOfStyle(style('X', { name: '标题 5' }))).toBe(5);
  });
});

describe('ensureHeadingStyles（WF-036 的关联）', () => {
  it('空样式表 → 建出 9 个标题样式，各自 outlineLevel 正确', () => {
    const result = ensureHeadingStyles({ styles: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toHaveLength(9);
    for (let level = 1; level <= 9; level += 1) {
      const created = findStyle(result.table, `Heading${String(level)}`);
      expect(created?.paragraph_properties.outlineLevel).toEqual({ state: 'set', value: level - 1 });
    }
  });

  it('幂等：再调一次不新建、不改动', () => {
    const first = ensureHeadingStyles({ styles: [] });
    if (!first.ok) throw new Error('失败');
    const second = ensureHeadingStyles(first.table, { levels: [1] });
    if (!second.ok) throw new Error('失败');
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.table).toBe(first.table);
  });

  it('既有标题样式缺 outlineLevel 时补齐（不覆盖已显式设置的级别）', () => {
    const table: StyleTable = {
      styles: [
        style('Heading1'),
        style('Heading2', { paragraph_properties: { outlineLevel: { state: 'set', value: 7 } } }),
      ],
    };
    const result = ensureHeadingStyles(table, { levels: [1, 2] });
    if (!result.ok) throw new Error('失败');
    expect(result.updated).toEqual(['Heading1']);
    expect(findStyle(result.table, 'Heading1')?.paragraph_properties.outlineLevel).toEqual({ state: 'set', value: 0 });
    // 用户显式设的 7 保持不动。
    expect(findStyle(result.table, 'Heading2')?.paragraph_properties.outlineLevel).toEqual({ state: 'set', value: 7 });
  });
});

describe('应用标题（WF-035/R125：写引用不写外观）', () => {
  it('只写 pStyle，外观交给级联', () => {
    const result = applyHeading({ styles: [] }, para('p1'), 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.paragraph.style_ref).toBe('Heading2');
    // 没有把 outlineLevel / 字号硬写进段落直接格式。
    expect(result.paragraph.properties.outlineLevel).toEqual({ state: 'inherit' });
    // 但读回的有效 outlineLevel 来自命名样式。
    const resolved = outlineLevelOfParagraph(result.table, result.paragraph);
    expect(resolved.specified).toBe(true);
    if (resolved.specified) {
      expect(resolved.value).toBe(1);
      expect(resolved.origin?.layer).toBe('named_style');
    }
  });

  it('应用标题会清除旧的直接格式（否则旧格式压住样式）', () => {
    const dirty = { ...para('p1'), properties: setAlignment(createDefaultParagraphProperties(), 'justify') };
    const result = applyHeading({ styles: [] }, dirty, 1);
    if (!result.ok) throw new Error('失败');
    expect(result.paragraph.properties.alignment).toEqual({ state: 'inherit' });
  });

  it('反面：级别越界 → 拒绝', () => {
    const result = applyHeading({ styles: [] }, para('p1'), 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_definition');
  });
});

describe('标题判定（R115：不看字号）', () => {
  it('按样式引用判定', () => {
    const info = isHeadingParagraph({ styles: [] }, para('p1', 'Heading3'));
    expect(info).toEqual({ is_heading: true, level: 3, source: 'style' });
  });

  it('按大纲级别判定（直接格式给了 outlineLevel）', () => {
    const item: ParagraphNode = {
      ...para('p1'),
      properties: { ...createDefaultParagraphProperties(), outlineLevel: { state: 'set', value: 2 } },
    };
    const info = isHeadingParagraph({ styles: [] }, item);
    expect(info).toEqual({ is_heading: true, level: 3, source: 'outline_level' });
  });

  it('反面：字号很大但没样式/大纲级别 → **不是**标题（R115 的关键反例）', () => {
    const item = para('p1', null, 24);
    expect(isHeadingParagraph({ styles: [] }, item).is_heading).toBe(false);
    expect(effectiveHeadingLevel({ styles: [] }, item)).toEqual({ level: null, origin: null, outline_level: null });
  });

  it('反面：普通段落不是标题', () => {
    expect(isHeadingParagraph({ styles: [] }, para('p1')).is_heading).toBe(false);
  });

  it('effectiveHeadingLevel 汇总级别与大纲级别', () => {
    const applied = applyHeading({ styles: [] }, para('p1'), 4);
    if (!applied.ok) throw new Error('失败');
    expect(effectiveHeadingLevel(applied.table, applied.paragraph)).toEqual({
      level: 4,
      origin: 'style',
      outline_level: 3,
    });
  });
});

describe('标题样式链健康检查', () => {
  it('坏 basedOn 的标题样式被报出（且不无限递归）', () => {
    const table: StyleTable = { styles: [style('Heading1', { based_on: 'Ghost' })] };
    const problems = headingStyleChainProblems(table);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.style_id).toBe('Heading1');
    expect(resolveStyleChain(table, 'Heading1').ok).toBe(false);
  });

  it('健全的标题样式无问题', () => {
    const result = ensureHeadingStyles({ styles: [] }, { levels: [1, 2, 3] });
    if (!result.ok) throw new Error('失败');
    expect(headingStyleChainProblems(result.table)).toEqual([]);
  });
});

/**
 * 应用样式（R125）与修改样式（R126）测试。
 *
 * 核心判据（R125）：应用"标题 1"**只写样式引用**，不把外观硬写进 `rPr`/`pPr`。
 */

import { describe, expect, it } from 'vitest';
import type { ParagraphNode, StyleDefinition, StyleTable } from '../model/types.js';
import { TOGGLE_ON } from '../model/types.js';
import {
  applyParagraphStyle,
  countParagraphsUsingStyle,
  listStyles,
  updateNamedStyle,
} from './apply.js';
import { resolveParagraphCascade } from './cascade.js';
import { createDefaultParagraphProperties } from '../operations/paragraph/defaults.js';
import { setAlignment } from '../operations/paragraph/alignment.js';

function style(
  style_id: string,
  paragraph_properties: StyleDefinition['paragraph_properties'] = {},
  extra: Partial<StyleDefinition> = {},
): StyleDefinition {
  return {
    style_id,
    name: style_id,
    type: 'paragraph',
    based_on: null,
    run_properties: {},
    paragraph_properties,
    is_default: false,
    ...extra,
  };
}

function paragraph(id: string, styleRef: string | null = null): ParagraphNode {
  return {
    kind: 'paragraph',
    id,
    source: 'user_request',
    opaque: [],
    properties: createDefaultParagraphProperties(),
    inlines: [],
    style_ref: styleRef,
    numbering: null,
  };
}

describe('应用命名样式（R125）', () => {
  it('只写 style_ref，不把外观写进直接格式', () => {
    const applied = applyParagraphStyle(paragraph('p1'), 'Heading1');
    expect(applied.style_ref).toBe('Heading1');
    // 没有任何直接格式被"硬化"：属性一律落"清除覆盖"，由样式决定实际外观。
    expect(applied.properties.alignment).toEqual({ state: 'inherit' });
    expect(applied.properties.lineSpacing).toEqual({ state: 'inherit' });
  });

  it('式样应用后外观由 cascade 算出，而不是写进段落', () => {
    const heading = style('Heading1', { alignment: { state: 'set', value: 'center' } });
    const applied = applyParagraphStyle(paragraph('p1'), 'Heading1');
    const resolved = resolveParagraphCascade({
      styles: { styles: [heading] } as StyleTable,
      style_ref: applied.style_ref,
      direct: applied.properties,
    });
    expect(resolved.properties.alignment.value).toBe('center');
    // 来源是**命名样式**，不是直接格式——正是 R125 要的结果。
    expect(resolved.properties.alignment.origin?.layer).toBe('named_style');
  });

  it('默认清除已有的直接格式，避免旧格式压住新样式', () => {
    const dirty = { ...paragraph('p1'), properties: setAlignment(createDefaultParagraphProperties(), 'justify') };
    const applied = applyParagraphStyle(dirty, 'Heading1');
    // 清除落 `inherit`：写码层动作是**删除**该段已有的 `<w:jc/>`，
    // 而不是"不写"（后者会让旧元素留在文档里，用户看到格式没变）。
    expect(applied.properties.alignment.state).toBe('inherit');
    expect(applied.properties.alignment).not.toEqual({ state: 'set', value: 'justify' });
  });

  it('clearDirectFormat: false 时保留原直接格式', () => {
    const dirty = { ...paragraph('p1'), properties: setAlignment(createDefaultParagraphProperties(), 'justify') };
    const applied = applyParagraphStyle(dirty, 'Heading1', { clearDirectFormat: false });
    expect(applied.properties.alignment).toEqual({ state: 'set', value: 'justify' });
  });

  it('改文体内容与 run 属性：应用样式不碰它们', () => {
    const original = paragraph('p1');
    const applied = applyParagraphStyle(original, 'Heading1');
    expect(applied.inlines).toBe(original.inlines);
    expect(applied.id).toBe('p1');
    expect(applied.numbering).toBe(original.numbering);
  });

  it('是纯函数：不改原段落', () => {
    const original = paragraph('p1');
    applyParagraphStyle(original, 'Heading1');
    expect(original.style_ref).toBeNull();
  });
});

describe('修改命名样式 → 引用段落一致更新（R126）', () => {
  const heading = style('Heading1', { alignment: { state: 'set', value: 'center' }, keepNext: TOGGLE_ON });

  it('改样式后，引用段落解析出的值随之变化', () => {
    const applied = applyParagraphStyle(paragraph('p1'), 'Heading1');
    const before = resolveParagraphCascade({ styles: { styles: [heading] }, style_ref: applied.style_ref, direct: applied.properties });
    expect(before.properties.alignment.value).toBe('center');

    const updated = updateNamedStyle({ styles: [heading] }, 'Heading1', {
      paragraph_properties: { alignment: { state: 'set', value: 'left' } },
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;

    const after = resolveParagraphCascade({ styles: updated.table, style_ref: applied.style_ref, direct: applied.properties });
    expect(after.properties.alignment.value).toBe('left');
  });

  it('直接格式覆盖仍生效（改样式不动直接格式）', () => {
    let props = createDefaultParagraphProperties();
    props = setAlignment(props, 'right');
    const applied = { ...paragraph('p1'), style_ref: 'Heading1', properties: props };
    const updated = updateNamedStyle({ styles: [heading] }, 'Heading1', {
      paragraph_properties: { alignment: { state: 'set', value: 'left' } },
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const resolved = resolveParagraphCascade({ styles: updated.table, style_ref: applied.style_ref, direct: applied.properties });
    expect(resolved.properties.alignment.value).toBe('right');
    expect(resolved.properties.alignment.origin?.layer).toBe('direct');
  });

  it('修改不存在的样式 → 明确失败，不静默', () => {
    const result = updateNamedStyle({ styles: [heading] }, 'Nope', { name: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Nope');
  });

  it('修改返回新样式表，原表不变，且不产生第二个同 id 样式', () => {
    const original: StyleTable = { styles: [heading] };
    const result = updateNamedStyle(original, 'Heading1', { name: '一级标题' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(original.styles[0]?.name).toBe('Heading1');
    expect(result.table.styles).toHaveLength(1);
    expect(result.table.styles[0]?.name).toBe('一级标题');
    expect(result.table.styles[0]?.style_id).toBe('Heading1');
  });

  it('patch 里的 style_id 不能改（防止改名导致引用断裂）', () => {
    const result = updateNamedStyle({ styles: [heading] }, 'Heading1', { style_id: 'Hacked' } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.styles[0]?.style_id).toBe('Heading1');
  });
});

describe('查询辅助', () => {
  it('listStyles 按类型过滤，保持原序', () => {
    const t: StyleTable = { styles: [style('A'), style('B', {}, { type: 'character' }), style('C')] };
    expect(listStyles(t).map((s) => s.style_id)).toEqual(['A', 'B', 'C']);
    expect(listStyles(t, 'paragraph').map((s) => s.style_id)).toEqual(['A', 'C']);
    expect(listStyles(t, 'character').map((s) => s.style_id)).toEqual(['B']);
  });

  it('countParagraphsUsingStyle 按 style_ref 统计，不看外观', () => {
    const blocks = [paragraph('p1', 'Heading1'), paragraph('p2', 'Heading1'), paragraph('p3', null)];
    expect(countParagraphsUsingStyle(blocks, 'Heading1')).toBe(2);
    expect(countParagraphsUsingStyle(blocks, 'Nope')).toBe(0);
  });
});

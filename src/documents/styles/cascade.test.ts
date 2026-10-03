/**
 * 样式级联解析测试（R122/R124）。
 *
 * 核心判据：
 * - 顺序 **文档默认 → 命名样式（含 basedOn 链）→ 直接格式**，后层覆盖前层；
 * - 读回每个属性都**标出来源层**（R124）；
 * - 链出问题时 `status = 'conflict'` 但仍给出可用结果。
 */

import { describe, expect, it } from 'vitest';
import type { ParagraphProperties, StyleDefinition, StyleTable } from '../model/types.js';
import { TOGGLE_OFF, TOGGLE_ON } from '../model/types.js';
import { resolveParagraphCascade } from './cascade.js';
import { createDefaultParagraphProperties } from '../operations/paragraph/defaults.js';
import { setAlignment } from '../operations/paragraph/alignment.js';
import { setLineSpacing } from '../operations/paragraph/line-spacing.js';

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

function table(...styles: StyleDefinition[]): StyleTable {
  return { styles };
}

describe('级联顺序：默认 → 命名样式 → 直接格式（R122）', () => {
  const defaultStyle = style(
    'Normal',
    { alignment: { state: 'set', value: 'left' }, lineSpacing: { state: 'set', value: { kind: 'single' } } },
    { is_default: true, name: '正文' },
  );
  const heading = style(
    'Heading1',
    { alignment: { state: 'set', value: 'center' }, lineSpacing: { state: 'set', value: { kind: 'double' } } },
    { name: '标题 1' },
  );

  it('无样式、无直接格式时回落到文档默认', () => {
    const result = resolveParagraphCascade({ styles: table(defaultStyle), style_ref: null, direct: null });
    expect(result.properties.alignment.value).toBe('left');
    expect(result.properties.alignment.origin?.layer).toBe('document_default');
    expect(result.properties.lineSpacing.value).toEqual({ kind: 'single' });
  });

  it('命名样式覆盖文档默认', () => {
    const result = resolveParagraphCascade({
      styles: table(defaultStyle, heading),
      style_ref: 'Heading1',
      direct: null,
    });
    expect(result.properties.alignment.value).toBe('center');
    expect(result.properties.alignment.origin).toEqual({
      layer: 'named_style',
      style_id: 'Heading1',
      style_name: '标题 1',
    });
  });

  it('直接格式覆盖命名样式', () => {
    let direct: ParagraphProperties = createDefaultParagraphProperties();
    direct = setAlignment(direct, 'right');
    const result = resolveParagraphCascade({
      styles: table(defaultStyle, heading),
      style_ref: 'Heading1',
      direct,
    });
    expect(result.properties.alignment.value).toBe('right');
    expect(result.properties.alignment.origin).toEqual({ layer: 'direct', style_id: null, style_name: null });
    // 未直接覆盖的属性仍来自命名样式。
    expect(result.properties.lineSpacing.origin?.layer).toBe('named_style');
  });

  it('三层各管各的属性，来源层分别标出（R124）', () => {
    let direct: ParagraphProperties = createDefaultParagraphProperties();
    direct = setAlignment(direct, 'right');
    const result = resolveParagraphCascade({
      styles: table(defaultStyle, heading),
      style_ref: 'Heading1',
      direct,
    });
    expect(result.properties.alignment.origin?.layer).toBe('direct');
    expect(result.properties.lineSpacing.origin?.layer).toBe('named_style');
  });
});

describe('basedOn 继承链参与级联（R122）', () => {
  it('子样式覆盖祖先，未覆盖的继承祖先', () => {
    const base = style('Base', {
      alignment: { state: 'set', value: 'left' },
      lineSpacing: { state: 'set', value: { kind: 'single' } },
    });
    const derived = style('Derived', { lineSpacing: { state: 'set', value: { kind: 'double' } } }, { based_on: 'Base' });
    const result = resolveParagraphCascade({ styles: table(base, derived), style_ref: 'Derived', direct: null });
    // 对齐来自祖先，行距来自子样式，两者来源层都是命名样式、但 style_id 不同。
    expect(result.properties.alignment.value).toBe('left');
    expect(result.properties.alignment.origin?.style_id).toBe('Base');
    expect(result.properties.lineSpacing.value).toEqual({ kind: 'double' });
    expect(result.properties.lineSpacing.origin?.style_id).toBe('Derived');
  });

  it('applied_chain 按应用顺序（根在前）列出参与样式', () => {
    const base = style('Base', {});
    const derived = style('Derived', {}, { based_on: 'Base' });
    const result = resolveParagraphCascade({ styles: table(base, derived), style_ref: 'Derived', direct: null });
    expect(result.applied_chain.map((s) => s.style_id)).toEqual(['Base', 'Derived']);
  });

  it('直接格式压倒整条样式链', () => {
    const base = style('Base', { alignment: { state: 'set', value: 'left' } });
    const derived = style('Derived', { alignment: { state: 'set', value: 'center' } }, { based_on: 'Base' });
    let direct = createDefaultParagraphProperties();
    direct = setAlignment(direct, 'justify');
    const result = resolveParagraphCascade({ styles: table(base, derived), style_ref: 'Derived', direct });
    expect(result.properties.alignment.value).toBe('justify');
  });
});

describe('未指定 vs 显式 null（outlineLevel）', () => {
  it('没有任何层设置时 specified=false', () => {
    const result = resolveParagraphCascade({ styles: table(style('A', {})), style_ref: 'A', direct: null });
    expect(result.properties.outlineLevel.specified).toBe(false);
    expect(result.properties.outlineLevel.value).toBeNull();
    expect(result.properties.outlineLevel.origin).toBeNull();
  });

  it('显式设成 null（正文）时 specified=true 且来源可查', () => {
    const s = style('A', { outlineLevel: { state: 'set', value: null } });
    const result = resolveParagraphCascade({ styles: table(s), style_ref: 'A', direct: null });
    expect(result.properties.outlineLevel.specified).toBe(true);
    expect(result.properties.outlineLevel.value).toBeNull();
    expect(result.properties.outlineLevel.origin?.style_id).toBe('A');
  });

  it('显式设成 0（标题 1）', () => {
    const s = style('A', { outlineLevel: { state: 'set', value: 0 } });
    const result = resolveParagraphCascade({ styles: table(s), style_ref: 'A', direct: null });
    expect(result.properties.outlineLevel.value).toBe(0);
  });
});

describe('开关型属性（ToggleState）', () => {
  it('on / off 都被解析成布尔并带来源', () => {
    const s = style('A', { keepNext: TOGGLE_ON, widowControl: TOGGLE_OFF });
    const result = resolveParagraphCascade({ styles: table(s), style_ref: 'A', direct: null });
    expect(result.properties.keepNext).toEqual({
      specified: true,
      value: true,
      origin: { layer: 'named_style', style_id: 'A', style_name: 'A' },
    });
    expect(result.properties.widowControl.value).toBe(false);
  });

  it('unspecified 不贡献（保持未指定）', () => {
    const s = style('A', { keepNext: { state: 'unspecified' } });
    const result = resolveParagraphCascade({ styles: table(s), style_ref: 'A', direct: null });
    expect(result.properties.keepNext.specified).toBe(false);
  });

  it('显式 off 覆盖样式链上游的 on', () => {
    const base = style('Base', { keepNext: TOGGLE_ON });
    const derived = style('Derived', { keepNext: TOGGLE_OFF }, { based_on: 'Base' });
    const result = resolveParagraphCascade({ styles: table(base, derived), style_ref: 'Derived', direct: null });
    expect(result.properties.keepNext.value).toBe(false);
    expect(result.properties.keepNext.origin?.style_id).toBe('Derived');
  });
});

describe('缩进的分槽位解析', () => {
  it('四个槽位分别解析、分别标来源', () => {
    const base = style('Base', {
      indent: {
        left: { state: 'set', value: { unit: 'chars', value: 2 } },
        right: { state: 'unspecified' },
        firstLine: { state: 'set', value: { unit: 'chars', value: 2 } },
        hanging: { state: 'unspecified' },
      },
    });
    const derived = style(
      'Derived',
      {
        indent: {
          left: { state: 'unspecified' },
          right: { state: 'set', value: { unit: 'cm', value: 1 } },
          firstLine: { state: 'unspecified' },
          hanging: { state: 'unspecified' },
        },
      },
      { based_on: 'Base' },
    );
    const result = resolveParagraphCascade({ styles: table(base, derived), style_ref: 'Derived', direct: null });
    expect(result.properties.indent.left.value).toEqual({ unit: 'chars', value: 2 });
    expect(result.properties.indent.left.origin?.style_id).toBe('Base');
    expect(result.properties.indent.right.value).toEqual({ unit: 'cm', value: 1 });
    expect(result.properties.indent.right.origin?.style_id).toBe('Derived');
    expect(result.properties.indent.firstLine.value).toEqual({ unit: 'chars', value: 2 });
    expect(result.properties.indent.hanging.specified).toBe(false);
  });
});

describe('链出问题时（R123）', () => {
  it('成环不抛异常，status=conflict，仍给出已解析部分', () => {
    const a = style('A', { alignment: { state: 'set', value: 'center' } }, { based_on: 'B' });
    const b = style('B', { lineSpacing: { state: 'set', value: { kind: 'single' } } }, { based_on: 'A' });
    let direct = createDefaultParagraphProperties();
    direct = setLineSpacing(direct, { kind: 'double' });

    const result = resolveParagraphCascade({ styles: table(a, b), style_ref: 'A', direct });
    expect(result.status).toBe('conflict');
    expect(result.problems[0]?.kind).toBe('cycle');
    // 直接格式依然生效（不因样式坏掉而让用户什么都改不了）。
    expect(result.properties.lineSpacing.value).toEqual({ kind: 'double' });
    expect(result.properties.lineSpacing.origin?.layer).toBe('direct');
  });

  it('style_ref 指向不存在的样式 → conflict，但文档默认仍生效', () => {
    const normal = style('Normal', { alignment: { state: 'set', value: 'left' } }, { is_default: true });
    const result = resolveParagraphCascade({ styles: table(normal), style_ref: 'Ghost', direct: null });
    expect(result.status).toBe('conflict');
    expect(result.problems[0]?.kind).toBe('dangling_reference');
    expect(result.properties.alignment.value).toBe('left');
    expect(result.properties.alignment.origin?.layer).toBe('document_default');
  });

  it('全部正常时 status=ok 且 problems 为空', () => {
    const result = resolveParagraphCascade({ styles: table(style('A', {})), style_ref: 'A', direct: null });
    expect(result.status).toBe('ok');
    expect(result.problems).toEqual([]);
  });
});

describe('读回结果与源头解耦', () => {
  it('对象型属性是深拷贝，改样式表不影响已读回的结果', () => {
    const border = { top: { style: 'single', size: { unit: 'pt', value: 1 }, color_hex: 'FF0000' } } as const;
    const s = style('A', { borders: { state: 'set', value: border } });
    const result = resolveParagraphCascade({ styles: table(s), style_ref: 'A', direct: null });
    expect(result.properties.borders.value).toEqual(border);
    expect(result.properties.borders.value).not.toBe(border);
  });
});

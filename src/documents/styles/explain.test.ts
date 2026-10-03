/**
 * "有效属性可解释"测试（WF-038，R117–R124）。
 *
 * 判据：四种来源（文档默认 / 命名样式 / 直接格式 / 未设置）都能被逐条指出；
 * **清除直接格式之后**仍可解释（值交还给样式），这正是"清除 = 回继承"的证据。
 */

import { describe, expect, it } from 'vitest';
import type { ParagraphNode, StyleDefinition, StyleTable } from '../model/types.js';
import { TOGGLE_ON } from '../model/types.js';
import {
  describeOrigin,
  directOverrides,
  explainParagraphAfterClearing,
  explainParagraphProperties,
  explainRunProperties,
  findEntry,
  isCleared,
  specifiedValues,
  styleDrivenProperties,
} from './explain.js';
import { createDefaultParagraphProperties } from '../operations/paragraph/defaults.js';
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

function para(styleRef: string | null, extra: Partial<ParagraphNode> = {}): ParagraphNode {
  return {
    kind: 'paragraph',
    id: 'p1',
    source: 'user_request',
    opaque: [],
    properties: createDefaultParagraphProperties(),
    inlines: [],
    style_ref: styleRef,
    numbering: null,
    ...extra,
  };
}

describe('段落有效属性解释', () => {
  const table: StyleTable = {
    styles: [
      style('Normal', { is_default: true, paragraph_properties: { keepLines: TOGGLE_ON } }),
      style('Heading1', {
        paragraph_properties: {
          alignment: { state: 'set', value: 'center' },
          outlineLevel: { state: 'set', value: 0 },
        },
      }),
    ],
  };

  it('逐属性标出来源层（R124）', () => {
    const explanation = explainParagraphProperties(table, para('Heading1'));
    expect(explanation.status).toBe('ok');
    const alignment = findEntry(explanation, 'alignment');
    expect(alignment?.specified).toBe(true);
    expect(alignment?.value).toBe('center');
    expect(alignment?.origin?.layer).toBe('named_style');
    expect(alignment?.origin?.style_name).toBe('Heading1');
    expect(alignment?.description).toContain('Heading1');

    // 来自文档默认样式的那一条。
    const keepLines = findEntry(explanation, 'keepLines');
    expect(keepLines?.origin?.layer).toBe('document_default');

    // 谁都没设的那一条：specified=false，如实说明"由消费端默认决定"。
    const lineSpacing = findEntry(explanation, 'lineSpacing');
    expect(lineSpacing?.specified).toBe(false);
    expect(lineSpacing?.origin).toBeNull();
  });

  it('直接格式覆盖显示为 direct 层，并可与样式层区分', () => {
    const dirty = para('Heading1', {
      properties: setAlignment(createDefaultParagraphProperties(), 'right'),
    });
    const explanation = explainParagraphProperties(table, dirty);
    expect(findEntry(explanation, 'alignment')?.origin?.layer).toBe('direct');
    expect(directOverrides(explanation)).toEqual(['alignment']);
    // outlineLevel 仍来自命名样式。
    expect(styleDrivenProperties(explanation)).toEqual(['outlineLevel']);
  });

  it('多级样式链在 applied_chain 里根在前', () => {
    const chained: StyleTable = {
      styles: [
        style('Base', { paragraph_properties: { alignment: { state: 'set', value: 'left' } } }),
        style('Child', { based_on: 'Base', paragraph_properties: { keepNext: TOGGLE_ON } }),
      ],
    };
    const explanation = explainParagraphProperties(chained, para('Child'));
    expect(explanation.applied_chain.map((item) => item.style_id)).toEqual(['Base', 'Child']);
  });

  it('坏链给出 conflict 与 problems，而不是抛错', () => {
    const broken: StyleTable = { styles: [style('A', { based_on: 'B' }), style('B', { based_on: 'A' })] };
    const explanation = explainParagraphProperties(broken, para('A'));
    expect(explanation.status).toBe('conflict');
    expect(explanation.problems).toHaveLength(1);
  });
});

describe('清除直接格式之后仍可解释（WF-038）', () => {
  it('清除后值回落到命名样式，来源层随之改变', () => {
    const table: StyleTable = {
      styles: [style('Quote', { paragraph_properties: { alignment: { state: 'set', value: 'justify' } } })],
    };
    const dirty = para('Quote', { properties: setAlignment(createDefaultParagraphProperties(), 'right') });

    const before = explainParagraphProperties(table, dirty);
    expect(findEntry(before, 'alignment')?.origin?.layer).toBe('direct');

    const after = explainParagraphAfterClearing(table, dirty);
    expect(findEntry(after, 'alignment')?.value).toBe('justify');
    expect(findEntry(after, 'alignment')?.origin?.layer).toBe('named_style');

    // 清除状态可被机械判定（全 inherit/unspecified）。
    expect(isCleared({ ...dirty.properties })).toBe(false);
    const cleared = explainParagraphAfterClearing(table, dirty);
    // 清除后的解释里不再有任何 direct 来源。
    expect(directOverrides(cleared)).toEqual([]);
  });

  it('specifiedValues 只列有值的属性', () => {
    const table: StyleTable = { styles: [style('Quote', { paragraph_properties: { alignment: { state: 'set', value: 'left' } } })] };
    const values = specifiedValues(explainParagraphProperties(table, para('Quote')));
    expect(values.get('alignment')).toBe('left');
    expect(values.has('lineSpacing')).toBe(false);
  });
});

describe('字符属性解释', () => {
  it('字符样式 + 直接格式逐条标来源', () => {
    const table: StyleTable = {
      styles: [
        style('Emph', {
          type: 'character',
          run_properties: { bold: TOGGLE_ON, color: { state: 'set', value: { kind: 'rgb', hex: '0000ff' } } },
        }),
      ],
    };
    const explanation = explainRunProperties(table, 'Emph', { italic: TOGGLE_ON });
    expect(findEntry(explanation, 'bold')?.origin?.layer).toBe('named_style');
    expect(findEntry(explanation, 'color')?.value).toEqual({ kind: 'rgb', hex: '0000ff' });
    expect(findEntry(explanation, 'italic')?.origin?.layer).toBe('direct');
    expect(findEntry(explanation, 'underline')?.specified).toBe(false);
  });
});

describe('describeOrigin', () => {
  it('四种来源各自成句', () => {
    expect(describeOrigin(null)).toContain('未在任何层设置');
    expect(describeOrigin({ layer: 'direct', style_id: null, style_name: null })).toContain('直接格式');
    expect(describeOrigin({ layer: 'named_style', style_id: 'H1', style_name: '标题 1' })).toContain('标题 1');
    expect(describeOrigin({ layer: 'document_default', style_id: 'Normal', style_name: '正文' })).toContain('文档默认');
  });
});

/**
 * 清除 / 复制段落格式测试（WF-034，R120）。
 *
 * 三条必须站住的判据：
 * 1. 清除段落格式**不删正文**、**不误清字符局部强调**（run 数组引用不变）；
 * 2. 清除后回落到**命名样式**（`style_ref` 保留）；
 * 3. 复制是**深拷贝**，复制后两段互不影响。
 */

import { describe, expect, it } from 'vitest';
import type { ParagraphNode, RunNode } from '../../model/types.js';
import { TOGGLE_ON } from '../../model/types.js';
import { createDefaultParagraphProperties } from './defaults.js';
import { setAlignment } from './alignment.js';
import { setLineSpacing } from './line-spacing.js';
import { setLeftIndent, indentChars } from './indent.js';
import {
  clearParagraphFormat,
  copyDirectParagraphFormat,
  copyParagraphFormat,
  hasNoDirectParagraphFormat,
} from './clear-copy.js';
import { indentToOoxml } from '../../units/indent.js';

function run(id: string, text: string): RunNode {
  return {
    kind: 'run',
    id,
    source: 'user_request',
    opaque: [],
    properties: {
      bold: TOGGLE_ON,
      italic: { state: 'unspecified' },
      underline: { state: 'unspecified' },
      strike: { state: 'unspecified' },
      doubleStrike: { state: 'unspecified' },
      vertAlign: { state: 'unspecified' },
      fonts: { state: 'unspecified' },
      size: { state: 'unspecified' },
      scale: { state: 'unspecified' },
      position: { state: 'unspecified' },
      color: { state: 'unspecified' },
      highlight: { state: 'unspecified' },
      shading: { state: 'unspecified' },
      spacing: { state: 'unspecified' },
      caps: { state: 'unspecified' },
      smallCaps: { state: 'unspecified' },
    },
    text,
  };
}

function styledParagraph(): ParagraphNode {
  let props = createDefaultParagraphProperties();
  props = setAlignment(props, 'center');
  props = setLineSpacing(props, { kind: 'oneAndHalf' });
  props = setLeftIndent(props, indentChars(2));
  return {
    kind: 'paragraph',
    id: 'p1',
    source: 'user_request',
    opaque: [],
    properties: props,
    inlines: [run('r1', '加粗的正文')],
    style_ref: 'Heading1',
    numbering: { num_id: 'n1', level: 0 },
  };
}

describe('清除段落格式（WF-034）', () => {
  it('段落属性回到"清除覆盖"态', () => {
    const cleared = clearParagraphFormat(styledParagraph());
    expect(cleared.properties.alignment).toEqual({ state: 'inherit' });
    expect(cleared.properties.lineSpacing).toEqual({ state: 'inherit' });
    expect(indentToOoxml(cleared.properties.indent)).toEqual({
      left: null,
      leftChars: null,
      right: null,
      rightChars: null,
      firstLine: null,
      firstLineChars: null,
      hanging: null,
      hangingChars: null,
    });
    expect(hasNoDirectParagraphFormat(cleared.properties)).toBe(true);
  });

  it('**不删正文**，也不误清字符局部强调（R120/WF-034）', () => {
    const original = styledParagraph();
    const cleared = clearParagraphFormat(original);
    // 正文 run 数组与其中的加粗属性都原样保留。
    expect(cleared.inlines).toBe(original.inlines);
    const firstRun = cleared.inlines[0];
    expect(firstRun?.kind).toBe('run');
    if (firstRun?.kind === 'run') {
      expect(firstRun.properties.bold).toEqual(TOGGLE_ON);
      expect(firstRun.text).toBe('加粗的正文');
    }
  });

  it('保留命名样式引用（清除直接格式 ≠ 变成正文）', () => {
    const cleared = clearParagraphFormat(styledParagraph());
    expect(cleared.style_ref).toBe('Heading1');
  });

  it('列表上下文保留，不丢编号（WF-028 同类要求）', () => {
    const cleared = clearParagraphFormat(styledParagraph());
    expect(cleared.numbering).toEqual({ num_id: 'n1', level: 0 });
  });

  it('幂等：清除两次结果稳定（R137）', () => {
    const once = clearParagraphFormat(styledParagraph());
    const twice = clearParagraphFormat(once);
    expect(twice.properties).toEqual(once.properties);
  });

  it('不清除无直接格式的段落也无副作用', () => {
    const plain: ParagraphNode = { ...styledParagraph(), properties: createDefaultParagraphProperties() };
    expect(hasNoDirectParagraphFormat(plain.properties)).toBe(true);
    expect(hasNoDirectParagraphFormat(clearParagraphFormat(plain).properties)).toBe(true);
  });
});

describe('复制段落格式（WF-034）', () => {
  it('目标段落获得源的段落格式，正文不变', () => {
    const source = styledParagraph();
    const target: ParagraphNode = {
      ...styledParagraph(),
      id: 'p2',
      properties: createDefaultParagraphProperties(),
      inlines: [run('r9', '目标正文')],
      style_ref: null,
    };
    const result = copyParagraphFormat(source, target);
    expect(result.properties.alignment).toEqual({ state: 'set', value: 'center' });
    expect(result.properties.lineSpacing).toEqual({ state: 'set', value: { kind: 'oneAndHalf' } });
    expect(result.inlines).toBe(target.inlines);
    expect(result.id).toBe('p2');
  });

  it('默认连命名样式一起复制（对齐 Word 格式刷）', () => {
    const source = styledParagraph();
    const target: ParagraphNode = { ...styledParagraph(), id: 'p2', style_ref: null };
    expect(copyParagraphFormat(source, target).style_ref).toBe('Heading1');
  });

  it('includeStyleRef: false 时只复制直接格式', () => {
    const source = styledParagraph();
    const target: ParagraphNode = { ...styledParagraph(), id: 'p2', style_ref: 'BodyText' };
    const result = copyParagraphFormat(source, target, { includeStyleRef: false });
    expect(result.style_ref).toBe('BodyText');
    expect(result.properties.alignment).toEqual({ state: 'set', value: 'center' });
  });

  it('copyDirectParagraphFormat 是上面选项的简写', () => {
    const source = styledParagraph();
    const target: ParagraphNode = { ...styledParagraph(), id: 'p2', style_ref: 'BodyText' };
    expect(copyDirectParagraphFormat(source, target).style_ref).toBe('BodyText');
  });

  it('默认不复制列表上下文（避免把正文刷成列表项）', () => {
    const source = styledParagraph();
    const target: ParagraphNode = { ...styledParagraph(), id: 'p2', numbering: null };
    expect(copyParagraphFormat(source, target).numbering).toBeNull();
  });

  it('includeNumbering: true 时复制列表上下文', () => {
    const source = styledParagraph();
    const target: ParagraphNode = { ...styledParagraph(), id: 'p2', numbering: null };
    expect(copyParagraphFormat(source, target, { includeNumbering: true }).numbering).toEqual({
      num_id: 'n1',
      level: 0,
    });
  });

  it('**深拷贝**：复制后改源不影响目标', () => {
    const source = styledParagraph();
    const target: ParagraphNode = { ...styledParagraph(), id: 'p2', properties: createDefaultParagraphProperties() };
    const result = copyParagraphFormat(source, target);
    expect(result.properties).not.toBe(source.properties);
    expect(result.properties.indent).not.toBe(source.properties.indent);
    // 源被替换后，结果仍是复制时的快照。
    const mutatedSource = { ...source, properties: setAlignment(source.properties, 'right') };
    expect(result.properties.alignment).toEqual({ state: 'set', value: 'center' });
    expect(mutatedSource.properties.alignment).toEqual({ state: 'set', value: 'right' });
  });
});

/**
 * 换行与段落拆合测试（WF-031，R102 码位偏移）。
 *
 * 重点用例：
 * - **代理对安全**：在 emoji 中间切分必须抛错或落在合法码位边界，绝不产出半个 emoji；
 * - **组合字符**：`e` + 组合尖音符是两个码位，按码位切分不会破坏附加符号；
 * - **格式保留**：拆开后两半都保留各自的 run 格式（不是"读出来重建"）。
 */

import { describe, expect, it } from 'vitest';
import type { InlineNode, ParagraphNode, RunNode } from '../../model/types.js';
import { createDefaultParagraphProperties } from './defaults.js';
import { setAlignment } from './alignment.js';
import {
  appendEmptyParagraph,
  createColumnBreak,
  createLineBreak,
  createPageBreak,
  mergeParagraphs,
  paragraphCodePointLength,
  paragraphText,
  splitParagraph,
  substringByCodePoints,
} from './breaks.js';
import { TOGGLE_ON } from '../../model/types.js';

/** 简单的递增 id 分配器（D01 的分配器在集成层接入；本包只依赖回调）。 */
function idAllocator(prefix = 'n'): () => string {
  let seq = 0;
  return () => `${prefix}${(seq += 1)}`;
}

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

function paragraph(id: string, inlines: readonly InlineNode[]): ParagraphNode {
  return {
    kind: 'paragraph',
    id,
    source: 'user_request',
    opaque: [],
    properties: createDefaultParagraphProperties(),
    inlines,
    style_ref: null,
    numbering: null,
  };
}

describe('软换行与分页（WF-031 / BreakNode）', () => {
  it('软换行是 break 节点，不是段落边界（R104）', () => {
    const br = createLineBreak('b1');
    expect(br.kind).toBe('break');
    expect(br.breakType).toBe('line');
  });

  it('分页换行单独表示', () => {
    expect(createPageBreak('b2').breakType).toBe('page');
  });

  it('分栏换行单独表示（三种 breakType 互不相同）', () => {
    const kinds = [createLineBreak('b1').breakType, createPageBreak('b2').breakType, createColumnBreak('b3').breakType];
    expect(kinds).toEqual(['line', 'page', 'column']);
    expect(new Set(kinds).size).toBe(3);
  });

  it('三种换行都是合法行内节点（可放进段落）', () => {
    const p = paragraph('p1', [run('r1', 'A'), createLineBreak('b1'), run('r2', 'B')]);
    expect(p.inlines.map((i) => i.kind)).toEqual(['run', 'break', 'run']);
    expect(paragraphText(p)).toBe('AB');
  });
});

describe('码位偏移（R102）', () => {
  it('text.length（UTF-16 码元）与码位长度的差别被正确计算', () => {
    const p = paragraph('p1', [run('r1', '😀😀')]);
    expect('😀😀'.length).toBe(4); // UTF-16 码元
    expect(paragraphCodePointLength(p)).toBe(2); // 码位
    expect(paragraphText(p)).toBe('😀😀');
  });

  it('substringByCodePoints 不切出半个 emoji', () => {
    expect(substringByCodePoints('😀😀', 0, 1)).toBe('😀');
    expect(substringByCodePoints('😀😀', 1, 2)).toBe('😀');
    expect(substringByCodePoints('a😀b', 1, 2)).toBe('😀');
  });

  it('组合字符按码位计数（é 是两个码位）', () => {
    const combined = 'é';
    expect(combined.length).toBe(2);
    expect(Array.from(combined).length).toBe(2);
  });
});

describe('拆段（WF-031）', () => {
  it('在中间拆开：前半保留原 id，后半拿新 id，文本正确', () => {
    const p = paragraph('p1', [run('r1', 'ABCDEF')]);
    const [head, tail] = splitParagraph(p, 3, idAllocator());
    expect(head.id).toBe('p1');
    expect(tail.id).not.toBe('p1');
    expect(paragraphText(head)).toBe('ABC');
    expect(paragraphText(tail)).toBe('DEF');
  });

  it('拆开后两半都保留原有 run 格式（不是重建）', () => {
    const p = paragraph('p1', [run('r1', 'ABCDEF')]);
    const [head, tail] = splitParagraph(p, 2, idAllocator());
    const headRun = head.inlines[0];
    const tailRun = tail.inlines[0];
    expect(headRun?.kind).toBe('run');
    expect(tailRun?.kind).toBe('run');
    if (headRun?.kind === 'run' && tailRun?.kind === 'run') {
      expect(headRun.properties.bold).toEqual(TOGGLE_ON);
      expect(tailRun.properties.bold).toEqual(TOGGLE_ON);
      // 属性是深拷贝：不是同一个对象。
      expect(headRun.properties).not.toBe(tailRun.properties);
    }
  });

  it('拆段不共享属性和缩进对象（深拷贝）', () => {
    const p = paragraph('p1', [run('r1', 'ABCDEF')]);
    const [head, tail] = splitParagraph(p, 2, idAllocator());
    expect(tail.properties).not.toBe(head.properties);
    expect(tail.properties.indent).not.toBe(head.properties.indent);
  });

  it('拆段保留段落对齐与样式引用', () => {
    const base = paragraph('p1', [run('r1', 'AB')]);
    const styled: ParagraphNode = { ...base, properties: setAlignment(base.properties, 'center'), style_ref: 'Heading1' };
    const [head, tail] = splitParagraph(styled, 1, idAllocator());
    expect(head.properties.alignment).toEqual({ state: 'set', value: 'center' });
    expect(tail.properties.alignment).toEqual({ state: 'set', value: 'center' });
    expect(tail.style_ref).toBe('Heading1');
  });

  it('偏移 0：前半为空段落，后半承接全部内容', () => {
    const p = paragraph('p1', [run('r1', 'ABC')]);
    const [head, tail] = splitParagraph(p, 0, idAllocator());
    expect(paragraphText(head)).toBe('');
    expect(paragraphText(tail)).toBe('ABC');
  });

  it('偏移 = 长度：等价"段尾回车新建一段"', () => {
    const p = paragraph('p1', [run('r1', 'ABC')]);
    const [head, tail] = appendEmptyParagraph(p, idAllocator());
    expect(paragraphText(head)).toBe('ABC');
    expect(paragraphText(tail)).toBe('');
    expect(tail.id).not.toBe('p1');
  });

  it('在 emoji 边界拆开不产生乱码', () => {
    const p = paragraph('p1', [run('r1', 'A😀B')]);
    const [head, tail] = splitParagraph(p, 2, idAllocator());
    expect(paragraphText(head)).toBe('A😀');
    expect(paragraphText(tail)).toBe('B');
  });

  it('跨多个 run 拆分：格式各自保留', () => {
    const p = paragraph('p1', [run('r1', 'AB'), run('r2', 'CD')]);
    const [head, tail] = splitParagraph(p, 3, idAllocator());
    expect(paragraphText(head)).toBe('ABC');
    expect(paragraphText(tail)).toBe('D');
    expect(head.inlines).toHaveLength(2);
    expect(tail.inlines).toHaveLength(1);
  });

  it('跨 run 且在 run 内部拆分', () => {
    const p = paragraph('p1', [run('r1', 'AB'), run('r2', 'CD')]);
    const [head, tail] = splitParagraph(p, 1, idAllocator());
    expect(paragraphText(head)).toBe('A');
    expect(paragraphText(tail)).toBe('BCD');
  });

  it('越界偏移抛 RangeError，不静默夹取（R136）', () => {
    const p = paragraph('p1', [run('r1', 'ABC')]);
    expect(() => splitParagraph(p, -1, idAllocator())).toThrow(RangeError);
    expect(() => splitParagraph(p, 4, idAllocator())).toThrow(RangeError);
    expect(() => splitParagraph(p, 1.5, idAllocator())).toThrow(RangeError);
  });

  it('拆段不修改原段落（不可变）', () => {
    const p = paragraph('p1', [run('r1', 'ABCDEF')]);
    splitParagraph(p, 3, idAllocator());
    expect(paragraphText(p)).toBe('ABCDEF');
    expect(p.inlines).toHaveLength(1);
  });

  it('零宽节点（软换行）不参与码位计数，且随前半段走', () => {
    const p = paragraph('p1', [run('r1', 'AB'), createLineBreak('b1'), run('r2', 'CD')]);
    expect(paragraphCodePointLength(p)).toBe(4);
    const [head, tail] = splitParagraph(p, 2, idAllocator());
    expect(head.inlines.map((i) => i.kind)).toEqual(['run', 'break']);
    expect(paragraphText(tail)).toBe('CD');
  });
});

describe('合段（WF-031）', () => {
  it('第二个段落的内容接到第一个之后，格式沿用第一段', () => {
    const a: ParagraphNode = { ...paragraph('p1', [run('r1', 'AB')]), properties: setAlignment(createDefaultParagraphProperties(), 'center') };
    const b = paragraph('p2', [run('r2', 'CD')]);
    const merged = mergeParagraphs(a, b);
    expect(merged.id).toBe('p1');
    expect(paragraphText(merged)).toBe('ABCD');
    expect(merged.properties.alignment).toEqual({ state: 'set', value: 'center' });
  });

  it('合段后两段的本 run 格式都在', () => {
    const a = paragraph('p1', [run('r1', 'AB')]);
    const b = paragraph('p2', [run('r2', 'CD')]);
    const merged = mergeParagraphs(a, b);
    expect(merged.inlines).toHaveLength(2);
    expect(merged.inlines.map((i) => i.id)).toEqual(['r1', 'r2']);
  });

  it('拆后再合并回到等价文本', () => {
    const p = paragraph('p1', [run('r1', 'ABCDEF')]);
    const [head, tail] = splitParagraph(p, 3, idAllocator());
    const merged = mergeParagraphs(head, tail);
    expect(paragraphText(merged)).toBe('ABCDEF');
    expect(merged.id).toBe('p1');
  });
});

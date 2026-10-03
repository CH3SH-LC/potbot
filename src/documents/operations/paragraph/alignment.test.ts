/**
 * 五种对齐测试（WF-017–021）。
 */

import { describe, expect, it } from 'vitest';
import { createDefaultParagraphProperties } from './defaults.js';
import { ALIGNMENTS, setAlignment, unsetAlignment } from './alignment.js';

describe('五种对齐（WF-017–021）', () => {
  it('五种对齐都能设置并读回，彼此不同', () => {
    for (const alignment of ALIGNMENTS) {
      const props = setAlignment(createDefaultParagraphProperties(), alignment);
      expect(props.alignment).toEqual({ state: 'set', value: alignment });
    }
    expect(new Set(ALIGNMENTS).size).toBe(5);
  });

  it('居中只作用于被设置的段落对象，不影响原对象（不可变）', () => {
    const before = createDefaultParagraphProperties();
    const after = setAlignment(before, 'center');
    expect(before.alignment).toEqual({ state: 'unspecified' });
    expect(after.alignment).toEqual({ state: 'set', value: 'center' });
    expect(after).not.toBe(before);
  });

  it('两端对齐与分散对齐分别表示，不被压成同一个值（WF-020/021）', () => {
    const justify = setAlignment(createDefaultParagraphProperties(), 'justify');
    const distribute = setAlignment(createDefaultParagraphProperties(), 'distribute');
    expect(justify.alignment).not.toEqual(distribute.alignment);
  });

  it('对齐设置不触碰其他段落属性', () => {
    const base = createDefaultParagraphProperties();
    const centered = setAlignment(base, 'center');
    expect(centered.lineSpacing).toBe(base.lineSpacing);
    expect(centered.indent).toBe(base.indent);
    expect(centered.spacingBefore).toBe(base.spacingBefore);
  });

  it('unsetAlignment 是"清除覆盖"而非"设为左对齐"（R117/R118）', () => {
    const cleared = unsetAlignment(setAlignment(createDefaultParagraphProperties(), 'center'));
    expect(cleared.alignment).toEqual({ state: 'inherit' });
    // 与显式左对齐**不同**——这两个必须能分别产出。
    expect(cleared.alignment).not.toEqual(setAlignment(createDefaultParagraphProperties(), 'left').alignment);
  });
});

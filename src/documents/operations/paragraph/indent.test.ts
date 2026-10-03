/**
 * 缩进操作测试（WF-027–029）。核心：**首行与悬挂互斥**，且互斥在**操作层**就完成。
 */

import { describe, expect, it } from 'vitest';
import { createDefaultParagraphProperties } from './defaults.js';
import {
  clearIndent,
  clearLeftIndent,
  clearRightIndent,
  hasConflictingIndent,
  indentChars,
  indentLength,
  setFirstLineIndent,
  setHangingIndent,
  setLeftIndent,
  setRightIndent,
} from './indent.js';
import { indentToOoxml } from '../../units/indent.js';

describe('首行缩进（WF-027）', () => {
  it('2 字 → firstLineChars=200，不通过空格实现', () => {
    const props = setFirstLineIndent(createDefaultParagraphProperties(), indentChars(2));
    const attrs = indentToOoxml(props.indent);
    expect(attrs.firstLineChars).toBe(200);
    expect(attrs.firstLine).toBeNull();
    expect(attrs.hangingChars).toBeNull();
    expect(attrs.hanging).toBeNull();
  });

  it('2 cm → firstLine=1134（与 2 字是不同属性）', () => {
    const props = setFirstLineIndent(createDefaultParagraphProperties(), indentLength(2, 'cm'));
    const attrs = indentToOoxml(props.indent);
    expect(attrs.firstLine).toBe(1134);
    expect(attrs.firstLineChars).toBeNull();
  });
});

describe('首行与悬挂互斥切换（WF-028）', () => {
  it('设首行会取消悬挂', () => {
    let props = setHangingIndent(createDefaultParagraphProperties(), indentChars(2));
    expect(props.indent.hanging).toEqual({ state: 'set', value: { unit: 'chars', value: 2 } });
    props = setFirstLineIndent(props, indentChars(2));
    expect(props.indent.hanging).toEqual({ state: 'inherit' });
    expect(hasConflictingIndent(props.indent)).toBe(false);
    const attrs = indentToOoxml(props.indent);
    expect(attrs.firstLineChars).toBe(200);
    expect(attrs.hangingChars).toBeNull();
  });

  it('设悬挂会取消首行（包括长度域留下的旧首行属性）', () => {
    let props = setFirstLineIndent(createDefaultParagraphProperties(), indentLength(2, 'cm'));
    props = setHangingIndent(props, indentChars(2));
    expect(props.indent.firstLine).toEqual({ state: 'inherit' });
    expect(hasConflictingIndent(props.indent)).toBe(false);
    const attrs = indentToOoxml(props.indent);
    expect(attrs.hangingChars).toBe(200);
    expect(attrs.firstLine).toBeNull();
  });

  it('反复切换后始终只有一边生效', () => {
    let props = createDefaultParagraphProperties();
    for (let i = 0; i < 5; i += 1) {
      props = setFirstLineIndent(props, indentChars(2));
      expect(hasConflictingIndent(props.indent)).toBe(false);
      props = setHangingIndent(props, indentChars(2));
      expect(hasConflictingIndent(props.indent)).toBe(false);
    }
    const attrs = indentToOoxml(props.indent);
    expect(attrs.hangingChars).toBe(200);
    expect(attrs.firstLineChars).toBeNull();
    expect(attrs.firstLine).toBeNull();
  });
});

describe('左右缩进（WF-029）', () => {
  it('左右分别设置，互不影响', () => {
    let props = setLeftIndent(createDefaultParagraphProperties(), indentChars(2));
    props = setRightIndent(props, indentLength(3, 'cm'));
    const attrs = indentToOoxml(props.indent);
    expect(attrs.leftChars).toBe(200);
    expect(attrs.right).toBe(1701);
  });

  it('改左缩进不动右缩进的引用', () => {
    const base = setRightIndent(createDefaultParagraphProperties(), indentChars(1));
    const after = setLeftIndent(base, indentChars(2));
    expect(after.indent.right).toBe(base.indent.right);
  });

  it('清除左缩进只清左边', () => {
    let props = setLeftIndent(createDefaultParagraphProperties(), indentChars(2));
    props = setRightIndent(props, indentChars(2));
    const cleared = clearLeftIndent(props);
    expect(cleared.indent.left).toEqual({ state: 'inherit' });
    expect(cleared.indent.right).toEqual({ state: 'set', value: { unit: 'chars', value: 2 } });
  });

  it('清除右缩进只清右边', () => {
    let props = setLeftIndent(createDefaultParagraphProperties(), indentChars(2));
    props = setRightIndent(props, indentChars(2));
    const cleared = clearRightIndent(props);
    expect(cleared.indent.right).toEqual({ state: 'inherit' });
    expect(cleared.indent.left).toEqual({ state: 'set', value: { unit: 'chars', value: 2 } });
  });

  it('clearIndent 四槽位一次清干净（字符域残留也被清）', () => {
    let props = setFirstLineIndent(createDefaultParagraphProperties(), indentChars(2));
    props = setLeftIndent(props, indentLength(1, 'cm'));
    props = setRightIndent(props, indentChars(1));
    const cleared = clearIndent(props);
    expect(indentToOoxml(cleared.indent)).toEqual({
      left: null,
      leftChars: null,
      right: null,
      rightChars: null,
      firstLine: null,
      firstLineChars: null,
      hanging: null,
      hangingChars: null,
    });
  });

  it('缩进操作不触碰对齐与行距', () => {
    const base = createDefaultParagraphProperties();
    const props = setLeftIndent(base, indentChars(2));
    expect(props.alignment).toBe(base.alignment);
    expect(props.lineSpacing).toBe(base.lineSpacing);
  });
});

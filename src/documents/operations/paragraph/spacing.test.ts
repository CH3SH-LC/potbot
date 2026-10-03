/**
 * 段前 / 段后间距测试（WF-025/026）。
 *
 * 核心判据：**段前与段后独立**。本文件用"引用相等"来证明——改段前时，段后字段
 * 连**引用**都没换过，不只是值相等。
 */

import { describe, expect, it } from 'vitest';
import { createDefaultParagraphProperties } from './defaults.js';
import {
  setSpacingAfter,
  setSpacingBefore,
  spacingAuto,
  spacingLines,
  spacingPt,
  unsetSpacingAfter,
  unsetSpacingBefore,
} from './spacing.js';
import { paragraphSpacingToOoxml } from '../../units/paragraph-spacing.js';
import type { ParagraphSpacing, ValuedState } from '../../model/types.js';

/** 测试辅助：从三态里取出已设置的间距值（未设置时抛错，避免静默通过）。 */
function sideValue(state: ValuedState<ParagraphSpacing>): ParagraphSpacing {
  if (state.state !== 'set') throw new Error(`期望 spacing 已设置，实际为 ${state.state}`);
  return state.value;
}

describe('段前（WF-025）', () => {
  it('pt / 行 / 自动三种写法都能落值', () => {
    const base = createDefaultParagraphProperties();
    expect(setSpacingBefore(base, spacingPt(12)).spacingBefore).toEqual({
      state: 'set',
      value: { kind: 'pt', value: 12 },
    });
    expect(setSpacingBefore(base, spacingLines(1.5)).spacingBefore).toEqual({
      state: 'set',
      value: { kind: 'lines', value: 1.5 },
    });
    expect(setSpacingBefore(base, spacingAuto()).spacingBefore).toEqual({
      state: 'set',
      value: { kind: 'auto' },
    });
  });

  it('12 磅段前 → line=240（与 12pt 字号是两回事，R131）', () => {
    const attrs = paragraphSpacingToOoxml(spacingPt(12));
    expect(attrs.line).toBe(240);
    expect(attrs.lines).toBeNull();
    expect(attrs.autospacing).toBe(false);
  });
});

describe('段前与段后**独立**（WF-026）', () => {
  it('改段前时，段后字段连引用都没变', () => {
    const base = createDefaultParagraphProperties();
    const before = setSpacingBefore(base, spacingPt(6));
    expect(before.spacingAfter).toBe(base.spacingAfter);
    expect(before.spacingAfter).toEqual({ state: 'unspecified' });
  });

  it('改段后时，段前字段连引用都没变', () => {
    const base = setSpacingBefore(createDefaultParagraphProperties(), spacingPt(6));
    const beforeRef = base.spacingBefore;
    const after = setSpacingAfter(base, spacingPt(18));
    expect(after.spacingBefore).toBe(beforeRef);
    expect(after.spacingAfter).toEqual({ state: 'set', value: { kind: 'pt', value: 18 } });
  });

  it('段前 6 磅 + 段后 18 磅可以并存且各自成立', () => {
    let props = createDefaultParagraphProperties();
    props = setSpacingBefore(props, spacingPt(6));
    props = setSpacingAfter(props, spacingPt(18));
    expect(paragraphSpacingToOoxml(sideValue(props.spacingBefore)).line).toBe(120);
    expect(paragraphSpacingToOoxml(sideValue(props.spacingAfter)).line).toBe(360);
  });

  it('段前设为自动不影响段后的 pt 值', () => {
    let props = setSpacingAfter(createDefaultParagraphProperties(), spacingPt(12));
    props = setSpacingBefore(props, spacingAuto());
    expect(props.spacingAfter).toEqual({ state: 'set', value: { kind: 'pt', value: 12 } });
    expect(props.spacingBefore).toEqual({ state: 'set', value: { kind: 'auto' } });
  });

  it('取消自动（WF-026）：段后从 auto 改回 pt 0，不留自动属性', () => {
    let props = setSpacingAfter(createDefaultParagraphProperties(), spacingAuto());
    props = setSpacingAfter(props, spacingPt(0));
    const attrs = paragraphSpacingToOoxml(sideValue(props.spacingAfter));
    expect(attrs).toEqual({ line: 0, lines: null, autospacing: false });
  });

  it('unset 只清对应一侧', () => {
    let props = setSpacingBefore(createDefaultParagraphProperties(), spacingPt(6));
    props = setSpacingAfter(props, spacingPt(6));
    const cleared = unsetSpacingBefore(props);
    expect(cleared.spacingBefore).toEqual({ state: 'inherit' });
    expect(cleared.spacingAfter).toEqual({ state: 'set', value: { kind: 'pt', value: 6 } });
  });

  it('unsetSpacingAfter 不触碰段前', () => {
    let props = setSpacingBefore(createDefaultParagraphProperties(), spacingPt(6));
    props = setSpacingAfter(props, spacingPt(6));
    const cleared = unsetSpacingAfter(props);
    expect(cleared.spacingAfter).toEqual({ state: 'inherit' });
    expect(cleared.spacingBefore).toEqual({ state: 'set', value: { kind: 'pt', value: 6 } });
  });
});

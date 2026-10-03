/**
 * 分页控制测试（WF-032）。四项开关各自独立，且"关"与"未指定"必须不同（R118）。
 */

import { describe, expect, it } from 'vitest';
import { createDefaultParagraphProperties } from './defaults.js';
import {
  PAGINATION_FIELDS,
  setKeepLines,
  setKeepNext,
  setPageBreakBefore,
  setPaginationEnabled,
  setPaginationState,
  setWidowControl,
  unsetPagination,
} from './pagination.js';
import { TOGGLE_OFF, TOGGLE_ON } from '../../model/types.js';
import { toggleWriteIntent } from '../../model/attributes.js';
import type { ParagraphProperties } from '../../model/types.js';

describe('四项分页控制（WF-032）', () => {
  it('四个开关都能分别打开', () => {
    const base = createDefaultParagraphProperties();
    expect(setPageBreakBefore(base, true).pageBreakBefore).toEqual(TOGGLE_ON);
    expect(setKeepNext(base, true).keepNext).toEqual(TOGGLE_ON);
    expect(setKeepLines(base, true).keepLines).toEqual(TOGGLE_ON);
    expect(setWidowControl(base, true).widowControl).toEqual(TOGGLE_ON);
  });

  it('四个开关的字段名与句柄一一对应（无遗漏）', () => {
    let props: ParagraphProperties = createDefaultParagraphProperties();
    for (const field of PAGINATION_FIELDS) {
      props = setPaginationEnabled(props, field, true);
    }
    for (const field of PAGINATION_FIELDS) {
      expect(props[field], field).toEqual(TOGGLE_ON);
    }
  });

  it('打开一个开关不影响其他三个', () => {
    const base = createDefaultParagraphProperties();
    const kept = setKeepNext(base, true);
    expect(kept.pageBreakBefore).toBe(base.pageBreakBefore);
    expect(kept.keepLines).toBe(base.keepLines);
    expect(kept.widowControl).toBe(base.widowControl);
  });
});

describe('"关" ≠ "未指定"（R118）', () => {
  it('false 落显式关（off），不是 unspecified', () => {
    const props = setKeepNext(createDefaultParagraphProperties(), false);
    expect(props.keepNext).toEqual(TOGGLE_OFF);
    expect(props.keepNext).not.toEqual({ state: 'unspecified' });
  });

  it('显式关与未指定是两种不同的状态', () => {
    const off = setKeepNext(createDefaultParagraphProperties(), false);
    const unspecified = createDefaultParagraphProperties();
    expect(off.keepNext).not.toEqual(unspecified.keepNext);
  });

  it('unsetPagination 落"清除覆盖"（inherit），写意图是 remove 而非 omit', () => {
    const props = unsetPagination(setKeepNext(createDefaultParagraphProperties(), false), 'keepNext');
    // inherit（不是 unspecified）：写码层要**删掉**此前写出的 <w:keepNext/> 元素。
    expect(props.keepNext).toEqual({ state: 'inherit' });
    expect(props.keepNext).not.toEqual({ state: 'unspecified' });
    expect(toggleWriteIntent(props.keepNext)).toBe('remove');
  });

  it('未指定的开关写意图是 omit（与 inherit 的 remove 分得开）', () => {
    const fresh = createDefaultParagraphProperties();
    expect(toggleWriteIntent(fresh.keepNext)).toBe('omit');
    expect(toggleWriteIntent(unsetPagination(fresh, 'keepNext').keepNext)).toBe('remove');
  });

  it('setPaginationState 可用来表达"清除覆盖"（inherit）', () => {
    const props = setPaginationState(createDefaultParagraphProperties(), 'keepLines', { state: 'inherit' });
    expect(props.keepLines).toEqual({ state: 'inherit' });
  });
});

describe('分页控制与其他属性互不干扰', () => {
  it('设分页开关不动对齐与行距引用', () => {
    const base = createDefaultParagraphProperties();
    const props = setKeepLines(base, true);
    expect(props.alignment).toBe(base.alignment);
    expect(props.lineSpacing).toBe(base.lineSpacing);
    expect(props.indent).toBe(base.indent);
  });
});

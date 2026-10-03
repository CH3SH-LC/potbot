/**
 * 制表位换算测试（WF-030）。
 */

import { describe, expect, it } from 'vitest';
import type { TabStop } from '../model/types.js';
import { tabStopToOoxml, tabStopsToOoxml } from './tab-stop.js';

describe('单个制表位（WF-030）', () => {
  it('位置走 twips 换算，对齐与前导符原样保留', () => {
    expect(
      tabStopToOoxml({ position: { unit: 'cm', value: 2 }, alignment: 'center', leader: 'dot' }),
    ).toEqual({ pos: 1134, val: 'center', leader: 'dot' });
  });

  it('五种对齐全部支持', () => {
    for (const alignment of ['left', 'center', 'right', 'decimal', 'bar'] as const) {
      expect(tabStopToOoxml({ position: { unit: 'pt', value: 10 }, alignment, leader: 'none' }).val).toBe(alignment);
    }
  });

  it('五种前导符全部支持', () => {
    for (const leader of ['none', 'dot', 'hyphen', 'underscore', 'middleDot'] as const) {
      expect(tabStopToOoxml({ position: { unit: 'pt', value: 10 }, alignment: 'left', leader }).leader).toBe(leader);
    }
  });
});

describe('一组制表位的规范化', () => {
  const mk = (pt: number, alignment: TabStop['alignment'] = 'left'): TabStop => ({
    position: { unit: 'pt', value: pt },
    alignment,
    leader: 'none',
  });

  it('按位置升序排列', () => {
    const result = tabStopsToOoxml([mk(30), mk(10), mk(20)]);
    expect(result.map((t) => t.pos)).toEqual([200, 400, 600]);
  });

  it('同位置去重，后写覆盖先写', () => {
    const result = tabStopsToOoxml([mk(10, 'left'), mk(10, 'right')]);
    expect(result).toHaveLength(1);
    expect(result[0]?.val).toBe('right');
  });

  it('空列表 → 空结果', () => {
    expect(tabStopsToOoxml([])).toEqual([]);
  });
});

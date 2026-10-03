/**
 * `basedOn` 链解析测试（R123）。
 *
 * 核心判据：**成环不无限递归**，坏引用明确检出。
 * "不无限递归"的验证方式是——测试**能跑完**。如果实现是朴素的递归，成环用例会栈溢出，
 * 于是整个测试进程挂掉（而不是"断言失败"）——这本身就是判据。
 * 为让失败可读，另加一个显式的深度计数器断言。
 */

import { describe, expect, it } from 'vitest';
import type { StyleDefinition, StyleTable } from '../model/types.js';
import { DEFAULT_MAX_STYLE_DEPTH, findDefaultStyle, findStyle, resolveStyleChain } from './chain.js';

function style(
  style_id: string,
  based_on: string | null,
  extra: Partial<StyleDefinition> = {},
): StyleDefinition {
  return {
    style_id,
    name: style_id,
    type: 'paragraph',
    based_on,
    run_properties: {},
    paragraph_properties: {},
    is_default: false,
    ...extra,
  };
}

function table(styles: readonly StyleDefinition[]): StyleTable {
  return { styles };
}

describe('正常链（R122）', () => {
  it('单样式：链就是它自己', () => {
    const result = resolveStyleChain(table([style('A', null)]), 'A');
    expect(result.ok).toBe(true);
    expect(result.chain.map((s) => s.style_id)).toEqual(['A']);
  });

  it('两级链返回**根在前**', () => {
    const result = resolveStyleChain(table([style('A', null), style('B', 'A')]), 'B');
    expect(result.ok).toBe(true);
    expect(result.chain.map((s) => s.style_id)).toEqual(['A', 'B']);
  });

  it('四级链顺序正确（祖 → 父 → 子 → 目标）', () => {
    const result = resolveStyleChain(
      table([style('A', null), style('B', 'A'), style('C', 'B'), style('D', 'C')]),
      'D',
    );
    expect(result.ok).toBe(true);
    expect(result.chain.map((s) => s.style_id)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('链中的样式定义可被上层读到', () => {
    const result = resolveStyleChain(table([style('A', null, { name: '正文' }), style('B', 'A')]), 'B');
    expect(result.chain[0]?.name).toBe('正文');
  });
});

describe('成环必须有限终止（R123）', () => {
  it('两样式互指：检出 cycle，且测试能跑完（= 未无限递归）', () => {
    const result = resolveStyleChain(table([style('A', 'B'), style('B', 'A')]), 'A');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem.kind).toBe('cycle');
      expect(result.problem.path.length).toBeLessThanOrEqual(3);
    }
  });

  it('自指（A.basedOn = A）也检出', () => {
    const result = resolveStyleChain(table([style('A', 'A')]), 'A');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.kind).toBe('cycle');
  });

  it('三样式成环 A→B→C→A', () => {
    const result = resolveStyleChain(
      table([style('A', 'B'), style('B', 'C'), style('C', 'A')]),
      'A',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem.kind).toBe('cycle');
      expect(result.problem.path).toEqual(['A', 'B', 'C', 'A']);
    }
  });

  it('环之外的合法前缀仍返回（尽力应用而非整页丢格式）', () => {
    const result = resolveStyleChain(
      table([style('A', 'B'), style('B', 'C'), style('C', 'B')]),
      'A',
    );
    expect(result.ok).toBe(false);
    expect(result.chain.map((s) => s.style_id)).toEqual(['C', 'B', 'A']);
  });

  it('无环但极长的链在深度上限内正常返回', () => {
    const styles: StyleDefinition[] = [style('S0', null)];
    for (let i = 1; i < 30; i += 1) styles.push(style(`S${i}`, `S${i - 1}`));
    const result = resolveStyleChain(table(styles), 'S29');
    expect(result.ok).toBe(true);
    expect(result.chain).toHaveLength(30);
  });

  it('超过深度上限时按无法有限终止检出，不栈溢出', () => {
    const styles: StyleDefinition[] = [style('S0', null)];
    for (let i = 1; i <= DEFAULT_MAX_STYLE_DEPTH + 5; i += 1) {
      styles.push(style(`S${i}`, `S${i - 1}`));
    }
    const result = resolveStyleChain(table(styles), `S${DEFAULT_MAX_STYLE_DEPTH + 5}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.kind).toBe('cycle');
  });
});

describe('坏引用（R123）', () => {
  it('起始样式不存在 → dangling_reference', () => {
    const result = resolveStyleChain(table([style('A', null)]), 'Missing');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem.kind).toBe('dangling_reference');
      expect(result.problem.style_id).toBe('Missing');
    }
  });

  it('basedOn 指向不存在的样式 → dangling_reference', () => {
    const result = resolveStyleChain(table([style('A', 'Ghost')]), 'A');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem.kind).toBe('dangling_reference');
      expect(result.problem.style_id).toBe('Ghost');
      expect(result.problem.detail).toContain('Ghost');
    }
  });

  it('空样式表 → dangling_reference（不抛异常）', () => {
    expect(() => resolveStyleChain(table([]), 'X')).not.toThrow();
    expect(resolveStyleChain(table([]), 'X').ok).toBe(false);
  });

  it('链中类型不一致 → wrong_type', () => {
    const result = resolveStyleChain(
      table([style('A', null, { type: 'character' }), style('B', 'A', { type: 'paragraph' })]),
      'B',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.kind).toBe('wrong_type');
  });
});

describe('查询辅助', () => {
  it('findStyle 命中与未命中', () => {
    const t = table([style('A', null)]);
    expect(findStyle(t, 'A')?.style_id).toBe('A');
    expect(findStyle(t, 'B')).toBeNull();
  });

  it('findDefaultStyle 只认对应类型且 is_default 的样式', () => {
    const t = table([
      style('Body', null, { is_default: true }),
      style('CharDefault', null, { is_default: true, type: 'character' }),
    ]);
    expect(findDefaultStyle(t, 'paragraph')?.style_id).toBe('Body');
    expect(findDefaultStyle(t, 'character')?.style_id).toBe('CharDefault');
    expect(findDefaultStyle(t, 'table')).toBeNull();
  });
});

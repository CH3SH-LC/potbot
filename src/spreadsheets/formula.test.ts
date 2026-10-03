import { describe, expect, it } from 'vitest';

import { extractFormulaReferences, mapFormulaColumns, mapFormulaRows } from './formula.js';

describe('XLS-06：公式文本里的引用随行列增删迁移', () => {
  it('行插入：插入点下方的引用下移，上方的引用不动', () => {
    const result = mapFormulaRows('SUM(A1:A3)', 2, 1, 'insert');
    expect(result).toEqual({ ok: true, text: 'SUM(A1:A4)' });
  });

  it('绝对引用也随插入下移（$ 固定的是复制语义，不是插入语义）', () => {
    expect(mapFormulaRows('$A$3*2', 2, 5, 'insert')).toEqual({ ok: true, text: '$A$8*2' });
  });

  it('列插入：只在列轴上迁移', () => {
    expect(mapFormulaColumns('A1+B2', 2, 1, 'insert')).toEqual({ ok: true, text: 'A1+C2' });
  });

  it('无引用的公式原样通过', () => {
    expect(mapFormulaRows('1+2', 3, 4, 'insert')).toEqual({ ok: true, text: '1+2' });
  });
});

describe('XLS-08：不能安全改写 ⇒ 阻塞，不返回伪造结果', () => {
  it('函数名 LOG10( 会被朴素正则误判成引用——必须整体阻塞', () => {
    const result = mapFormulaRows('LOG10(100)', 1, 1, 'insert');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('ambiguous_token');
      expect(result.detail).toContain('LOG10');
    }
  });

  it('字符串字面量里的 A1 不是引用 ⇒ 阻塞', () => {
    const result = mapFormulaRows('IF(A1>0,"A1",B1)', 2, 1, 'insert');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('string_literal');
    }
  });

  it('删除命中被引用的行 ⇒ 阻塞（不伪造成别的新引用）', () => {
    const result = mapFormulaRows('A4+B1', 3, 2, 'delete');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('reference_deleted');
      expect(result.detail).toContain('A4');
    }
    // 对照：区间之后的行是**上移**而不是阻塞（证明 reference_deleted 不是恒触发）
    expect(mapFormulaRows('A5+B1', 3, 2, 'delete')).toEqual({ ok: true, text: 'A3+B1' });
  });

  it('超出 Excel 行列上限的候选 token ⇒ 阻塞而非猜', () => {
    const result = mapFormulaRows('ZZZ9+1', 1, 1, 'insert');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('ambiguous_token');
    }
  });

  it('参数非法显式抛', () => {
    expect(() => mapFormulaRows('A1', 0, 1, 'insert')).toThrow(/at/);
    expect(() => mapFormulaRows('A1', 1, 0, 'delete')).toThrow(/count/);
  });
});

describe('引用抽取：读不懂与"确实没有"是两回事', () => {
  it('正常公式抽出全部引用（含区域两端）', () => {
    const refs = extractFormulaReferences('SUM(A1:B2)+$C$3');
    expect(refs).not.toBeNull();
    expect(refs?.map((item) => `${item.column},${item.row}`)).toEqual(['1,1', '2,2', '3,3']);
  });

  it('无法安全解析 ⇒ null（不是空数组）', () => {
    expect(extractFormulaReferences('IF(A1>0,"x",B1)')).toBeNull();
    expect(extractFormulaReferences('1+2')).toEqual([]);
  });
});

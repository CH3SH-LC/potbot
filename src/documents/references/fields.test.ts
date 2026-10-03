/**
 * 常用域单测（WF-076；R150/R158）。
 *
 * 判据：**域指令 / 缓存值 / 刷新状态三者分开**；改指令不冒充"已刷新"。
 */

import { describe, expect, it } from 'vitest';

import { document, field, paragraphOfRuns } from '../selection/testing.js';
import {
  dateField,
  describeField,
  fieldIsStale,
  insertFieldIntoParagraph,
  numPagesField,
  pageNumberField,
  setFieldCache,
  setFieldInstruction,
} from './fields.js';

describe('域的三要素分开（R158）', () => {
  it('新建页码域：有指令、无缓存、状态 unknown', () => {
    const f = pageNumberField('fld');
    expect(f.instruction).toBe('PAGE');
    expect(f.cached_result).toBeNull();
    expect(f.refresh_state).toBe('unknown');
    expect(fieldIsStale(f)).toBe(true);
  });

  it('改指令 ⇒ 缓存作废为 stale，绝不置 refreshed', () => {
    const withCache = field('fld', 'PAGE', '7'); // 带旧缓存
    expect(withCache.refresh_state).toBe('unknown');
    const changed = setFieldInstruction(withCache, 'NUMPAGES');
    expect(changed.instruction).toBe('NUMPAGES');
    expect(changed.cached_result).toBe('7'); // 值暂留
    expect(changed.refresh_state).toBe('stale'); // 但状态明确作废
    expect(changed.refresh_state).not.toBe('refreshed');
  });

  it('改指令且原本无缓存 ⇒ unknown', () => {
    const changed = setFieldInstruction(pageNumberField('fld'), 'DATE \\@ "yyyy"');
    expect(changed.refresh_state).toBe('unknown');
  });

  it('写缓存：无证据只写值不冒充已刷新；有证据才 refreshed', () => {
    const f = pageNumberField('fld');
    const noEvidence = setFieldCache(f, '5', false);
    expect(noEvidence.cached_result).toBe('5');
    expect(noEvidence.refresh_state).toBe('unknown');

    const withEvidence = setFieldCache(f, '5', true);
    expect(withEvidence.refresh_state).toBe('refreshed');
    expect(fieldIsStale(withEvidence)).toBe(false);
  });

  it('describeField 三样分开返回，display 只取缓存', () => {
    const described = describeField(field('fld', 'PAGE', '3'));
    expect(described).toEqual({
      instruction: 'PAGE',
      cached_result: '3',
      refresh_state: 'unknown',
      display: '3',
    });
  });

  it('空指令被拒绝（空域就是坏域）', () => {
    expect(() => setFieldInstruction(pageNumberField('fld'), '   ')).toThrow(RangeError);
  });

  it('构造器：NUMPAGES / DATE', () => {
    expect(numPagesField('a').instruction).toBe('NUMPAGES');
    expect(dateField('b', 'yyyy-MM-dd').instruction).toBe('DATE \\@ "yyyy-MM-dd"');
  });
});

describe('insertFieldIntoParagraph', () => {
  it('在段落偏移处插入域，其余文字不变', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '共 页']])]);
    // '共 页' 共 4 个码位（共 / 空格 / 页），在偏移 2 处插入
    const inserted = insertFieldIntoParagraph(doc, 'p1', 2, pageNumberField('fld1'));
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    const paragraph = inserted.value.blocks[0];
    if (paragraph?.kind !== 'paragraph') throw new Error('setup');
    expect(paragraph.inlines.map((inline) => inline.kind)).toEqual(['run', 'field', 'run']);
  });

  it('段落不存在 ⇒ unknown_node', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', 'x']])]);
    const inserted = insertFieldIntoParagraph(doc, 'ghost', 0, pageNumberField('fld1'));
    expect(inserted.ok).toBe(false);
    if (!inserted.ok) expect(inserted.code).toBe('unknown_node');
  });
});

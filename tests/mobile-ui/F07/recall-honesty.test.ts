/**
 * F07 验收：检索结论的诚实映射（I1）——「查不到 / 不确定 / 失败 / 有结果」四态不可合并。
 *
 * 判据必须真能咬：
 *   1) `uncertain` / `failed` **绝不**能被当成空态，也不得产出任何行；
 *   2) `not_found` 才是可信的空态；
 *   3) 截断时如实标注，且 `totalMatched` 来自内核而非行数；
 *   4) 结论非法（未知字符串）直接拒。
 */

import { describe, expect, it } from 'vitest';

import {
  MemoryViewModelError,
  describeRecall,
  isEmptyIsTrustworthy,
  type MemoryRecallView,
} from '../../../apps/mobile-ui/src/memory/index.js';

import { entry } from './fixtures.js';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof MemoryViewModelError ? error.code : `non-vm-error:${String(error)}`;
  }
  throw new Error('期望抛错，但没有抛');
}

describe('F07 / I1 四种检索结论映射到四种不同视图态', () => {
  it('found 且有结果 → results，产出列表行', () => {
    const view: MemoryRecallView = {
      status: 'found',
      entries: [entry({ memoryId: 'a' }), entry({ memoryId: 'b', updatedAt: 30 })],
      totalMatched: 2,
    };
    const p = describeRecall(view);
    expect(p.state).toBe('results');
    expect(p.rows.map((r) => r.memoryId).sort()).toEqual(['a', 'b']);
    expect(isEmptyIsTrustworthy(p)).toBe(false);
  });

  it('found 但 0 条 → empty（真实空态）', () => {
    const p = describeRecall({ status: 'found', entries: [], totalMatched: 0 });
    expect(p.state).toBe('empty');
    expect(p.rows).toEqual([]);
    expect(isEmptyIsTrustworthy(p)).toBe(true);
  });

  it('not_found → empty（唯一可信的空态）', () => {
    const p = describeRecall({ status: 'not_found', entries: [] });
    expect(p.state).toBe('empty');
    expect(isEmptyIsTrustworthy(p)).toBe(true);
    expect(p.notice).toContain('没有匹配的记忆');
  });

  it('uncertain → unknown，绝不当成空态，也不产出行', () => {
    const p = describeRecall({
      status: 'uncertain',
      entries: [entry({ memoryId: 'should-not-show' })],
      detail: '完整性探针返回 uncertain',
    });
    expect(p.state).toBe('unknown');
    expect(p.state).not.toBe('empty');
    expect(p.rows).toEqual([]); // 结论不可信时，随附条目一并不可信
    expect(isEmptyIsTrustworthy(p)).toBe(false);
    expect(p.notice).toContain('不可当作');
  });

  it('failed → failed，绝不当成空态，也不产出行', () => {
    const p = describeRecall({ status: 'failed', entries: [], detail: '磁盘读失败' });
    expect(p.state).toBe('failed');
    expect(p.rows).toEqual([]);
    expect(isEmptyIsTrustworthy(p)).toBe(false);
    expect(p.notice).toContain('这不代表');
    expect(p.notice).toContain('磁盘读失败');
  });

  it('四态两两不同（防止未来把状态合并）', () => {
    const states = [
      describeRecall({ status: 'found', entries: [entry()], totalMatched: 1 }).state,
      describeRecall({ status: 'not_found', entries: [] }).state,
      describeRecall({ status: 'uncertain', entries: [] }).state,
      describeRecall({ status: 'failed', entries: [] }).state,
    ];
    expect(new Set(states).size).toBe(4);
  });

  it('截断如实标注，totalMatched 取自内核', () => {
    const p = describeRecall({
      status: 'found',
      entries: [entry({ memoryId: 'a' })],
      totalMatched: 50,
      truncated: true,
    });
    expect(p.truncated).toBe(true);
    expect(p.totalMatched).toBe(50);
    expect(p.notice).toContain('共 50 条');
  });

  it('非法结论字符串被拒（invalid-query）', () => {
    expect(codeOf(() => describeRecall({ status: 'maybe' as never, entries: [] }))).toBe(
      'invalid-query',
    );
  });
});

/**
 * K05 独立验证 ③：**依赖调度**（拓扑分层 + 每波并发上限）。
 *
 * 不变量：① 任一子任务恰好出现在一个波次；② 每波内 ≤ max_parallel；
 * ③ 任一子任务的依赖都在**更早**的波里（拓扑序）；④ 同输入恒同波次（可重放）。
 */

import { describe, expect, it } from 'vitest';

import { planOf, spec, split } from './fixtures.js';

/** 建立"子任务 → 其所在波次号"的映射，供拓扑序断言。 */
function waveOf(plan: ReturnType<typeof planOf>): Map<string, number> {
  const map = new Map<string, number>();
  for (const wave of plan.schedule.waves) {
    for (const id of wave.subtask_ids) {
      map.set(id, wave.wave);
    }
  }
  return map;
}

describe('K05 依赖调度 · 波次结构', () => {
  it('纯链 a→b→c：三个串行波次（依赖强制先后）', () => {
    const plan = planOf(
      split('链', [spec('a', 'word.edit'), spec('b', 'sheet.edit', ['a']), spec('c', 'slide.edit', ['b'])]),
      { max_parallel: 3 },
    );
    expect(plan.schedule.waves.map((wave) => wave.subtask_ids)).toEqual([['a'], ['b'], ['c']]);
  });

  it('无依赖的 a,b,c + max_parallel=2 ⇒ 两波 [a,b] 与 [c]', () => {
    const plan = planOf(
      split('平铺', [spec('a', 'word.edit'), spec('b', 'sheet.edit'), spec('c', 'slide.edit')]),
      { max_parallel: 2 },
    );
    expect(plan.schedule.waves.map((wave) => wave.subtask_ids)).toEqual([['a', 'b'], ['c']]);
  });

  it('宽依赖：a,b 独立；c 依赖 a；d 依赖 b ⇒ 两波', () => {
    const plan = planOf(
      split('菱形', [
        spec('a', 'word.edit'),
        spec('b', 'sheet.edit'),
        spec('c', 'slide.edit', ['a']),
        spec('d', 'slide.edit', ['b']),
      ]),
      { max_parallel: 4 },
    );
    expect(plan.schedule.waves.map((wave) => wave.subtask_ids)).toEqual([['a', 'b'], ['c', 'd']]);
  });
});

describe('K05 依赖调度 · 不变量', () => {
  const plan = planOf(
    split('混合', [
      spec('a', 'word.edit'),
      spec('b', 'sheet.edit', ['a']),
      spec('c', 'slide.edit'),
      spec('d', 'slide.edit', ['b', 'c']),
      spec('e', 'word.edit'),
    ]),
    { max_parallel: 2 },
  );

  it('每条可调度子任务恰好出现一次', () => {
    const flat = plan.schedule.waves.flatMap((wave) => wave.subtask_ids);
    expect(new Set(flat).size).toBe(flat.length);
    expect([...flat].sort()).toEqual([...plan.schedule.scheduled_ids].sort());
  });

  it('每波 ≤ max_parallel', () => {
    for (const wave of plan.schedule.waves) {
      expect(wave.subtask_ids.length).toBeLessThanOrEqual(plan.schedule.max_parallel);
    }
  });

  it('依赖都落在更早的波里（拓扑序）', () => {
    const position = waveOf(plan);
    for (const task of plan.subtasks) {
      for (const dependency of task.depends_on) {
        expect(position.get(dependency)!).toBeLessThan(position.get(task.id)!);
      }
    }
  });

  it('波次编号从 1 连续递增', () => {
    expect(plan.schedule.waves.map((wave) => wave.wave)).toEqual(
      plan.schedule.waves.map((_wave, index) => index + 1),
    );
  });

  it('同输入恒同波次（可重放）', () => {
    const again = planOf(
      split('混合', [
        spec('a', 'word.edit'),
        spec('b', 'sheet.edit', ['a']),
        spec('c', 'slide.edit'),
        spec('d', 'slide.edit', ['b', 'c']),
        spec('e', 'word.edit'),
      ]),
      { max_parallel: 2 },
    );
    expect(again.schedule.waves).toEqual(plan.schedule.waves);
    expect(again.digest).toBe(plan.digest);
  });
});

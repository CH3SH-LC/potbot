/**
 * K05 独立验证 ④：**运行期并发上限**。
 *
 * 不变量：`snapshot().running_ids.length ≤ max_parallel` 恒成立；`launchReady()` 永不超发；
 * 一个子任务完成后空出的位立即被下一个就绪子任务填上。
 */

import { describe, expect, it } from 'vitest';

import {
  createDispatchRuntime,
  createManualClock,
} from '../../../apps/mobile-kernel/dispatch/index.js';
import { expectDispatchError, planOf, spec, split } from './fixtures.js';

function runtimeOf(input: ReturnType<typeof split>, maxParallel: number) {
  const plan = planOf(input, { max_parallel: maxParallel });
  return createDispatchRuntime(plan, { clock: createManualClock(0) });
}

describe('K05 并发 · 上限约束', () => {
  it('3 条就绪 + max_parallel=2 ⇒ 首批只启动 2 条', () => {
    const runtime = runtimeOf(
      split('平铺', [spec('a', 'word.edit'), spec('b', 'sheet.edit'), spec('c', 'slide.edit')]),
      2,
    );
    const launched = runtime.launchReady();
    expect(launched).toEqual(['a', 'b']);
    expect(runtime.snapshot().running_ids).toEqual(['a', 'b']);
    expect(runtime.snapshot().running_ids.length).toBeLessThanOrEqual(2);
  });

  it('完成一条后空出的位被下一条就绪子任务填上', () => {
    const runtime = runtimeOf(
      split('平铺', [spec('a', 'word.edit'), spec('b', 'sheet.edit'), spec('c', 'slide.edit')]),
      2,
    );
    runtime.launchReady();
    runtime.applyResult('a', 'succeeded');
    const second = runtime.launchReady();
    expect(second).toEqual(['c']);
    expect(runtime.snapshot().running_ids).toEqual(['b', 'c']);
    expect(runtime.snapshot().running_ids.length).toBeLessThanOrEqual(2);
  });

  it('依赖未满足的 pending 子任务不会被启动（且不占并发位）', () => {
    const runtime = runtimeOf(
      split('链', [spec('a', 'word.edit'), spec('b', 'sheet.edit', ['a']), spec('c', 'slide.edit')]),
      3,
    );
    const first = runtime.launchReady();
    expect(first).toEqual(['a', 'c']); // b 依赖 a，未就绪
    runtime.applyResult('a', 'succeeded');
    const second = runtime.launchReady();
    expect(second).toEqual(['b']); // a 成功后 b 才就绪
  });

  it('max_parallel=1 时严格串行', () => {
    const runtime = runtimeOf(
      split('平铺', [spec('a', 'word.edit'), spec('b', 'sheet.edit')]),
      1,
    );
    expect(runtime.launchReady()).toEqual(['a']);
    expect(runtime.launchReady()).toEqual([]); // 已满
    runtime.applyResult('a', 'succeeded');
    expect(runtime.launchReady()).toEqual(['b']);
  });
});

describe('K05 并发 · 非法并发上限必须被拒（不是静默取默认）', () => {
  it('0 / -1 / 1.5 / NaN ⇒ invalid_concurrency', () => {
    const input = split('目标', [spec('a', 'word.edit')]);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expectDispatchError(() => planOf(input, { max_parallel: bad }), 'invalid_concurrency');
    }
  });

  it('正向对照：max_parallel=1 合法', () => {
    const plan = planOf(split('目标', [spec('a', 'word.edit')]), { max_parallel: 1 });
    expect(plan.schedule.max_parallel).toBe(1);
  });
});

describe('K05 并发 · 快照只读且可复现', () => {
  it('snapshot() 返回冻结对象，revision 随迁移递增', () => {
    const runtime = runtimeOf(split('目标', [spec('a', 'word.edit')]), 1);
    const before = runtime.snapshot();
    expect(before.revision).toBe(0);
    runtime.launchReady();
    const after = runtime.snapshot();
    expect(after.revision).toBe(1);
    expect(Object.isFrozen(after)).toBe(true);
    expect(Object.isFrozen(after.subtasks)).toBe(true);
  });
});

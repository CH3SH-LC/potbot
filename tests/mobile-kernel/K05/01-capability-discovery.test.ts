/**
 * K05 独立验证 ①：**能力发现 → 可调度 / 阻塞** 的投影。
 *
 * 最吃重的负例是"**不得调未授权模板**"：能力被发现了，但模板未授权 ⇒ 该子任务被阻塞、
 * **不进任何调度波次**、**不占群组席位**。第二种是"根本没发现到" ⇒ `missing_capability"。
 * 每条负例都配正向对照，证明筛选器不是"恒阻塞"的空壳。
 */

import { describe, expect, it } from 'vitest';

import { createStaticDiscovery } from '../../../apps/mobile-kernel/dispatch/index.js';
import { CAP_WORD, planOf, spec, split } from './fixtures.js';

describe('K05 能力发现 · 正例（筛选器不是恒阻塞）', () => {
  it('已发现 + 已授权 + 可执行 ⇒ 进波次、进群组、带模板 id', () => {
    const plan = planOf(split('做一份周报', [spec('a', 'word.edit'), spec('b', 'sheet.edit')]));
    expect(plan.schedule.scheduled_ids).toEqual(['a', 'b']);
    expect(plan.schedule.blocked_ids).toEqual([]);
    expect(plan.blocked).toEqual([]);
    expect(plan.subtasks.map((entry) => entry.template_id)).toEqual(['word', 'excel']);
    // 群组成员 = 可调度子任务，一名成员一个席位
    expect(plan.group.members.map((member) => member.subtask_id)).toEqual(['a', 'b']);
    expect(plan.group.members.every((member) => member.role === 'worker')).toBe(true);
  });
});

describe('K05 能力发现 · 负例①：未发现到的能力 ⇒ missing_capability，不进调度', () => {
  it('cap 不在目录里：阻塞 + 不占席位 + 不在波次', () => {
    const plan = planOf(split('目标', [spec('a', 'word.edit'), spec('z', 'nonexistent.cap')]));
    expect(plan.schedule.blocked_ids).toEqual(['z']);
    expect(plan.schedule.scheduled_ids).toEqual(['a']);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]?.block_reason).toBe('missing_capability');
    expect(plan.blocked[0]?.blocked_by).toEqual(['nonexistent.cap']);
    expect(plan.group.members.map((member) => member.subtask_id)).toEqual(['a']);
    // 阻塞项不得出现在任何波次里
    const flat = plan.schedule.waves.flatMap((wave) => wave.subtask_ids);
    expect(flat).not.toContain('z');
  });
});

describe('K05 能力发现 · 负例②：模板未授权 ⇒ capability_not_authorized（不得调未授权模板）', () => {
  it('"order.submit"（meituan 未授权）被阻塞，绝不进调度', () => {
    const plan = planOf(split('帮我点外卖', [spec('order', 'order.submit')]));
    expect(plan.schedule.scheduled_ids).toEqual([]);
    expect(plan.schedule.blocked_ids).toEqual(['order']);
    expect(plan.blocked[0]?.block_reason).toBe('capability_not_authorized');
    expect(plan.blocked[0]?.block_detail).toContain('未授权');
    // 反向对照：同一次派发里已授权能力照常可调度
    const mixed = planOf(split('混合', [spec('order', 'order.submit'), spec('doc', 'word.edit')]));
    expect(mixed.schedule.scheduled_ids).toEqual(['doc']);
    expect(mixed.schedule.blocked_ids).toEqual(['order']);
  });

  it('已发现但 executable=false ⇒ capability_not_executable', () => {
    const plan = planOf(split('加日程', [spec('cal', 'calendar.write')]));
    expect(plan.blocked[0]?.block_reason).toBe('capability_not_executable');
    expect(plan.schedule.scheduled_ids).toEqual([]);
  });
});

describe('K05 能力发现 · 负例③：阻塞沿依赖链传播', () => {
  it('上游阻塞 ⇒ 下游 dependency_blocked，且链式传染', () => {
    const plan = planOf(
      split('链', [
        spec('a', 'word.edit'),
        spec('b', 'order.submit', ['a']), // a 可调度，b 未授权
        spec('c', 'sheet.edit', ['b']), // c 依赖被阻塞的 b
      ]),
      { max_parallel: 2 },
    );
    expect(plan.schedule.scheduled_ids).toEqual(['a']);
    expect(plan.schedule.blocked_ids).toEqual(['b', 'c']);
    const c = plan.blocked.find((entry) => entry.id === 'c');
    expect(c?.block_reason).toBe('dependency_blocked');
    expect(c?.blocked_by).toEqual(['b']);
  });
});

describe('K05 能力发现 · 摘要确定性 + 目录可替换', () => {
  it('同输入恒同摘要（可重放）', () => {
    const input = split('目标', [spec('a', 'word.edit'), spec('b', 'sheet.edit', ['a'])]);
    const first = planOf(input, { max_parallel: 2 });
    const second = planOf(input, { max_parallel: 2 });
    expect(first.digest).toBe(second.digest);
    expect(first.schedule.digest).toBe(second.schedule.digest);
  });

  it('换一份只含 word 的目录 ⇒ sheet 子任务转为 missing_capability', () => {
    const plan = planOf(split('目标', [spec('a', 'word.edit'), spec('b', 'sheet.edit')]), {
      discovery: createStaticDiscovery([CAP_WORD]),
    });
    expect(plan.schedule.scheduled_ids).toEqual(['a']);
    expect(plan.blocked.map((entry) => entry.id)).toEqual(['b']);
    expect(plan.blocked[0]?.block_reason).toBe('missing_capability');
    // 对照：默认目录（含 sheet）里 b 是可调度的
    expect(planOf(split('目标', [spec('b', 'sheet.edit')])).schedule.scheduled_ids).toEqual(['b']);
  });
});

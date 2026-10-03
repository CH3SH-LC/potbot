/**
 * F04 验收：群组列表（T01）——聚合、筛选桶、搜索、计数、排序、下一步。
 *
 * 定向运行：`npx vitest run tests/mobile-ui/F04/group-list.test.ts --reporter=basic`
 */

import { describe, expect, it } from 'vitest';

import {
  countGroupsByBucket,
  createTask,
  listGroups,
  searchGroups,
  type GroupsState,
} from '../../../apps/mobile-ui/src/groups/index.js';
import { IDS, seed } from './fixtures.js';

describe('F04 / 群组列表：聚合与桶', () => {
  it('按最近活跃降序，且聚合桶取自组内任务', () => {
    const rows = listGroups(seed());
    expect(rows.map((r) => r.groupId)).toEqual([IDS.tripGroup, IDS.weeklyGroup]);
    const weekly = rows.find((r) => r.groupId === IDS.weeklyGroup);
    const trip = rows.find((r) => r.groupId === IDS.tripGroup);
    expect(weekly?.bucket).toBe('in-progress');
    expect(weekly?.taskCount).toBe(1);
    expect(trip?.bucket).toBe('needs-action');
    expect(trip?.needsActionCount).toBe(1);
    expect(trip?.waitReason).toBe('等待你的授权');
    expect(trip?.conversationId).toBe(IDS.convTrip);
  });

  it('needs-action 桶优先于 in-progress（组内混态）', () => {
    let state: GroupsState = seed();
    state = createTask(state, {
      taskId: 'task-weekly-2',
      groupId: IDS.weeklyGroup,
      conversationId: IDS.convWeekly,
      title: '补充图表',
      goal: '给周报补一张图表',
      state: 'awaiting-input',
      waitReason: '等待补充资料',
      updatedAt: '2026-10-03T09:45:00Z',
    });
    const weekly = listGroups(state).find((r) => r.groupId === IDS.weeklyGroup);
    expect(weekly?.bucket).toBe('needs-action');
    expect(weekly?.needsActionCount).toBe(1);
  });

  it('按桶筛选只返回该桶群组', () => {
    const rows = listGroups(seed(), { bucket: 'needs-action' });
    expect(rows.map((r) => r.groupId)).toEqual([IDS.tripGroup]);
    const ended = listGroups(seed(), { bucket: 'ended' });
    expect(ended).toHaveLength(0);
  });

  it('搜索群组名与任务标题/目标', () => {
    expect(searchGroups(seed(), '周报').map((r) => r.groupId)).toEqual([IDS.weeklyGroup]);
    expect(searchGroups(seed(), '高铁').map((r) => r.groupId)).toEqual([IDS.tripGroup]);
    expect(searchGroups(seed(), '不存在').length).toBe(0);
  });

  it('计数与列表一致', () => {
    const counts = countGroupsByBucket(seed());
    expect(counts['needs-action']).toBe(1);
    expect(counts['in-progress']).toBe(1);
    expect(counts.ended).toBe(0);
    expect(counts.total).toBe(2);
  });
});

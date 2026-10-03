/**
 * **假成功复现**（外部监督记录 S-1026-01，2026-10-03）。
 *
 * ## 问题
 *
 * `TaskCompletionHost`/`DeliverableHost` **不注册任何 WorkItem / Run / Action**，而
 * `completionInSnapshot` 三个谓词里有两个是**集合的 `every()` / `length`**——在**空集上
 * `every()` 恒为 `true`**。于是「空工作项 + 空轮次 + 空动作 + **任一历史产物**」会推出
 * `completed_and_successful`，**哪怕最近一次编辑其实失败了**。
 *
 * 这是本项目自己警戒过的「**空断言 / 平凡命题**」（`info-021`：改了被测行为它会不会红？）。
 *
 * ## 本文件钉住什么
 *
 * 1. **空集不得当作"全部终态"**——完成必须有**证据表明真的发生过工作**；
 * 2. **产物必须绑当前版本**——旧 revision 的产物不能代表当前 revision 已交付；
 * 3. **有失败/被拒编辑时不得报成功**。
 *
 * 这三条在 `R261–R263` 的原始文字里已隐含（"全部工作项都处于终态"、"没有未决的动作"），
 * 但没有被实现成**对空集的显式拒绝**，也没有**版本绑定**。本文件把它们补成可判定的断言。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime } from '../../../src/protocol/index.js';
import { completionInSnapshot } from './task-completion.js';

/** 最小化的介质快照：只有 `tasks` 与 `artifacts` 两个集合非空。 */
function snapshotWith(overrides: {
  workItems?: readonly unknown[];
  runs?: readonly unknown[];
  actions?: readonly unknown[];
  artifacts?: readonly unknown[];
  taskRevision?: number;
}): Parameters<typeof completionInSnapshot>[0] {
  return {
    tasks: [{ task_id: 'T1', revision: overrides.taskRevision ?? 2 }],
    work_items: overrides.workItems ?? [],
    runs: overrides.runs ?? [],
    actions: overrides.actions ?? [],
    artifacts: overrides.artifacts ?? [],
  } as unknown as Parameters<typeof completionInSnapshot>[0];
}

/** 一条"已发布"的产物行（形状按任务完成视图读取 `status` 即可）。 */
function publishedArtifact(taskRevision: number): unknown {
  return {
    artifact_id: 'A1',
    task_id: 'T1',
    status: 'published',
    task_revision: taskRevision,
  };
}

const NOW = asLogicalTime(0);

describe('S-1026-01：空集不得推出"已完成且成功"', () => {
  it('**空工作集 + 一条历史产物 ⇒ 目前会误报 `completed_and_successful`**（修复后必须不再如此）', () => {
    const view = completionInSnapshot(snapshotWith({ artifacts: [publishedArtifact(2)] }), 'T1', NOW);
    expect(view).toBeDefined();
    // 修复目标：没有任何工作记录 ⇒ **不得**报成功（也不得报"完成"）。
    expect(view?.label, '空工作集不得推出成功').not.toBe('completed_and_successful');
  });

  it('旧 revision 的产物不代表当前 revision 已交付', () => {
    const view = completionInSnapshot(
      snapshotWith({
        // 工作项全部终态，但只有**旧版本**的产物
        workItems: [{ task_id: 'T1', status: 'completed', task_revision: 2 }],
        taskRevision: 2,
        artifacts: [publishedArtifact(1)],
      }),
      'T1',
      NOW,
    );
    expect(view?.label, '旧版本产物不得当作当前版本已交付').not.toBe('completed_and_successful');
  });

  it('对照：有真实工作记录且产物是当前版本 ⇒ 成功', () => {
    const view = completionInSnapshot(
      snapshotWith({
        workItems: [{ task_id: 'T1', status: 'completed', task_revision: 2 }],
        taskRevision: 2,
        artifacts: [publishedArtifact(2)],
      }),
      'T1',
      NOW,
    );
    expect(view?.label).toBe('completed_and_successful');
  });
});

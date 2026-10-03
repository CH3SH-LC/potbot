/**
 * KRN-01 任务 / 群组 / 实例 / 轮次分离的正反例测试。
 *
 * 每条不变量都配**反向对照**（反向断言必须真的能变红）：
 * ① 身份空间冒充 → 检出并抛错；
 * ② 归属链断裂（手工构造畸形登记表）→ `assertScopeSeparation()` 抛错；
 * ③ 任务跨群续接 → 任务身份不变、版本不倒退；
 * ④ 完成后释放 → 临时实例释放、任务记录与必要记录**仍在**；非 completed 释放被拒；
 * ⑤ 跨进程续接（**进程内模拟**）→ 身份与高水位续接，临时运行态不恢复。
 */

import { describe, expect, it } from 'vitest';
import {
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asRunId,
  asTaskId,
  type GroupId,
  type LogicalTime,
} from '../protocol/index.js';
import {
  ScopeIsolationError,
  assertScopeSeparation,
  completeTask,
  continueTaskInNewGroup,
  createEmptyScopeRegistry,
  identityNamespaceCollisions,
  liveInstanceIdsOf,
  registerGroup,
  registerInstance,
  registerRun,
  registerTask,
  releaseAfterCompletion,
  resumeFromContinuation,
  summarizeScopeSeparation,
  toContinuationPayload,
  type ScopeRegistry,
} from './task-group-isolation.js';

const L = (n: number): LogicalTime => asLogicalTime(n);
const TASK = asTaskId('task-1');
const GROUP_A = asGroupId('group-a');
const GROUP_B = asGroupId('group-b');
const INST_1 = asInstanceId('inst-1');
const INST_2 = asInstanceId('inst-2');
const RUN_1 = asRunId('run-1');

/** 一个"完整"的登记表：任务 → 群组 → 两实例 → 一轮次。 */
function seeded(): ScopeRegistry {
  let registry = createEmptyScopeRegistry();
  registry = registerTask(registry, { task_id: TASK, revision: asRevision(3), process_id: 'proc-1', at: L(0) });
  registry = registerGroup(registry, { group_id: GROUP_A, task_id: TASK, at: L(1) });
  registry = registerInstance(registry, { instance_id: INST_1, group_id: GROUP_A, at: L(2) });
  registry = registerInstance(registry, { instance_id: INST_2, group_id: GROUP_A, at: L(3) });
  registry = registerRun(registry, { run_id: RUN_1, instance_id: INST_1, at: L(4) });
  return registry;
}

describe('KRN-01 归属链（正向）', () => {
  it('四层各自在册，实例/轮次的任务与群组由归属链推导', () => {
    const registry = seeded();
    expect(registry.tasks[TASK]?.current_group_id).toBe(GROUP_A);
    expect(registry.groups[GROUP_A]?.task_id).toBe(TASK);
    expect(registry.instances[INST_1]?.task_id).toBe(TASK);
    expect(registry.instances[INST_1]?.group_id).toBe(GROUP_A);
    expect(registry.runs[RUN_1]?.task_id).toBe(TASK);
    expect(registry.runs[RUN_1]?.group_id).toBe(GROUP_A);
    expect(registry.runs[RUN_1]?.instance_id).toBe(INST_1);
    expect(() => assertScopeSeparation(registry)).not.toThrow();
    expect(identityNamespaceCollisions(registry)).toHaveLength(0);
  });
});

describe('KRN-01 反例①：身份空间不得互相冒充', () => {
  it('群组 id 与任务 id 同名 → 检出冲突，且自检抛错', () => {
    // 反向对照：把任务 id 原样当成群组 id 使用（这正是"用群组身份冒充任务身份"的前身）。
    const collisionTask = asTaskId('collide') as unknown as GroupId;
    let registry = createEmptyScopeRegistry();
    registry = registerTask(registry, { task_id: TASK, revision: asRevision(0), process_id: 'p', at: L(0) });
    registry = registerTask(registry, {
      task_id: asTaskId('collide'),
      revision: asRevision(0),
      process_id: 'p',
      at: L(0),
    });
    registry = registerGroup(registry, { group_id: collisionTask, task_id: TASK, at: L(1) });

    expect(identityNamespaceCollisions(registry).length).toBeGreaterThan(0);
    expect(() => assertScopeSeparation(registry)).toThrowError(ScopeIsolationError);
  });

  it('正向对照：不同名的四层身份不产生冲突', () => {
    expect(identityNamespaceCollisions(seeded())).toHaveLength(0);
  });
});

describe('KRN-01 反例②：归属链断裂必须抛错，不做静默修正', () => {
  it('实例挂着不属于它的群组 → 自检抛 instance_group_mismatch', () => {
    const registry = seeded();
    const malformed: ScopeRegistry = Object.freeze({
      ...registry,
      instances: Object.freeze({
        ...registry.instances,
        [INST_2]: Object.freeze({
          ...registry.instances[INST_2]!,
          task_id: asTaskId('other-task'),
        }),
      }),
    });
    try {
      assertScopeSeparation(malformed);
      throw new Error('自检本应抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ScopeIsolationError);
      expect((error as ScopeIsolationError).reason).toBe('instance_group_mismatch');
    }
  });

  it('轮次归属与实例不一致 → 自检抛 run_group_mismatch', () => {
    const registry = seeded();
    const malformed: ScopeRegistry = Object.freeze({
      ...registry,
      runs: Object.freeze({
        ...registry.runs,
        [RUN_1]: Object.freeze({ ...registry.runs[RUN_1]!, group_id: GROUP_B }),
      }),
    });
    expect(() => assertScopeSeparation(malformed)).toThrowError(/不一致/);
  });

  it('群组指向未登记任务 / 实例指向未登记群组 → 抛错', () => {
    const empty = createEmptyScopeRegistry();
    expect(() => registerGroup(empty, { group_id: GROUP_A, task_id: TASK, at: L(0) })).toThrowError(
      /未登记的任务/,
    );
    expect(() => registerInstance(empty, { instance_id: INST_1, group_id: GROUP_A, at: L(0) })).toThrowError(
      /未登记的群组/,
    );
  });

  it('轮次不得挂在已释放的实例上', () => {
    let registry = seeded();
    registry = completeTask(registry, { task_id: TASK, at: L(9) });
    const report = releaseAfterCompletion(registry, { task_id: TASK, at: L(10), reason: '任务已完成' });
    expect(() =>
      registerRun(report.registry, { run_id: asRunId('run-2'), instance_id: INST_1, at: L(11) }),
    ).toThrowError(/已释放/);
  });
});

describe('KRN-01 不变量③：任务跨群组续接，任务身份不变', () => {
  it('换群后 task_id 不变、版本不倒退、群组历史累积', () => {
    const registry = seeded();
    const report = continueTaskInNewGroup(registry, {
      task_id: TASK,
      new_group_id: GROUP_B,
      at: L(20),
      reason: '原群组已完成阶段目标',
    });
    expect(report.task.task_id).toBe(TASK);
    expect(report.task.revision).toBe(asRevision(3));
    expect(report.previous_group_id).toBe(GROUP_A);
    expect(report.task.current_group_id).toBe(GROUP_B);
    expect(report.task.group_history).toEqual([GROUP_A, GROUP_B]);
    // 旧群组记录仍在（历史不因换群而抹去）
    expect(report.registry.groups[GROUP_A]?.task_id).toBe(TASK);
  });

  it('反向对照：终态任务不得续接新群组', () => {
    let registry = seeded();
    registry = completeTask(registry, { task_id: TASK, at: L(9) });
    expect(() =>
      continueTaskInNewGroup(registry, { task_id: TASK, new_group_id: GROUP_B, at: L(10), reason: 'x' }),
    ).toThrowError(/终态任务不得续接/);
  });
});

describe('KRN-01 不变量④：完成后释放临时实例、保留必要记录', () => {
  function completedWithEvidence(): ScopeRegistry {
    let registry = seeded();
    registry = completeTask(registry, {
      task_id: TASK,
      at: L(30),
      evidence_refs: ['artifact://deliverable.docx', 'evidence://run-1-log'],
    });
    return registry;
  }

  it('释放后：live 实例归零、群组 released，但任务/轮次/证据/群组历史仍在', () => {
    const before = completedWithEvidence();
    expect(liveInstanceIdsOf(before, TASK)).toHaveLength(2);
    const report = releaseAfterCompletion(before, { task_id: TASK, at: L(31), reason: '任务完成，回收临时实例' });

    expect(report.released_instance_ids).toEqual([INST_1, INST_2]);
    expect(report.released_group_ids).toEqual([GROUP_A]);
    expect(liveInstanceIdsOf(report.registry, TASK)).toHaveLength(0);
    expect(report.registry.groups[GROUP_A]?.state).toBe('released');
    expect(report.registry.instances[INST_1]?.state).toBe('released');
    expect(report.registry.instances[INST_1]?.release_reason).toBe('任务完成，回收临时实例');

    // 必要记录保留
    expect(report.retained_run_ids).toEqual([RUN_1]);
    expect(report.retained_evidence_refs).toContain('artifact://deliverable.docx');
    expect(report.retained_group_history).toEqual([GROUP_A]);
    expect(report.registry.runs[RUN_1]?.status).toBe('running');

    const summary = summarizeScopeSeparation(report.registry, TASK);
    expect(summary.task_state).toBe('completed');
    expect(summary.live_instance_count).toBe(0);
    expect(summary.instance_count).toBe(2);
    expect(summary.run_count).toBe(1);
    expect(summary.task_record_present).toBe(true);
  });

  it('反向对照：任务记录绝不被释放删除（task_record_present 恒 true）', () => {
    const report = releaseAfterCompletion(completedWithEvidence(), {
      task_id: TASK,
      at: L(31),
      reason: '回收',
    });
    expect(report.registry.tasks[TASK]).toBeDefined();
    expect(report.retained_task.task_id).toBe(TASK);
    expect(summarizeScopeSeparation(report.registry, TASK).task_record_present).toBe(true);
  });

  it('反向对照：未完成的任务不允许释放临时实例', () => {
    const running = seeded();
    try {
      releaseAfterCompletion(running, { task_id: TASK, at: L(31), reason: '想提前释放' });
      throw new Error('本应抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ScopeIsolationError);
      expect((error as ScopeIsolationError).reason).toBe('task_not_completed');
    }
    // 抛错后原登记表未被改动
    expect(liveInstanceIdsOf(running, TASK)).toHaveLength(2);
  });

  it('释放不会重置任务版本（历史不可改写）', () => {
    const report = releaseAfterCompletion(completedWithEvidence(), { task_id: TASK, at: L(31), reason: 'r' });
    expect(report.retained_task.revision).toBe(asRevision(3));
  });
});

describe('KRN-01 不变量⑤：跨进程续接（进程内模拟，非真实第二进程）', () => {
  it('续接保留任务身份/版本/证据/群组历史/轮次历史与 id 高水位', () => {
    const registry = completedWithEvidenceRegistry();
    const payload = toContinuationPayload(registry, {
      task_id: TASK,
      id_high_water_marks: { msg: 7, run: 2 },
    });
    expect(payload.task_id).toBe(TASK);
    expect(payload.revision).toBe(asRevision(3));
    expect(payload.completed_run_ids).toEqual([RUN_1]);
    expect(payload.id_high_water_marks).toEqual({ msg: 7, run: 2 });

    const resumed = resumeFromContinuation(payload, {
      process_id: 'proc-2',
      at: L(40),
      new_group_id: GROUP_B,
    });
    expect(resumed.task.task_id).toBe(TASK);
    expect(resumed.task.revision).toBe(asRevision(3));
    expect(resumed.task.opened_in_process).toBe('proc-2');
    expect(resumed.task.retained_evidence_refs).toContain('evidence://run-1-log');
    // 群组历史跨进程累积：旧进程挂过 A，新进程挂上 B
    expect(resumed.task.group_history).toEqual([GROUP_A, GROUP_B]);
    // 续接后再挂的群组：GROUP_B 是新进程里唯一的 active 群组
    expect(resumed.registry.groups[GROUP_B]?.state).toBe('active');
    expect(resumed.registry.groups[GROUP_A]).toBeUndefined();
  });

  it('反向对照：进程标识为空 → 拒绝续接（拒绝"无进程归属的恢复"）', () => {
    const registry = completedWithEvidenceRegistry();
    const payload = toContinuationPayload(registry, { task_id: TASK, id_high_water_marks: {} });
    expect(() => resumeFromContinuation(payload, { process_id: '', at: L(40) })).toThrowError(/非空 process_id/);
  });

  it('反向对照：同一登记表内重复登记同一任务被拒（不得用重复登记冒充续接）', () => {
    const registry = seeded();
    expect(() =>
      registerTask(registry, { task_id: TASK, revision: asRevision(3), process_id: 'proc-1', at: L(50) }),
    ).toThrowError(ScopeIsolationError);
  });
});

function completedWithEvidenceRegistry(): ScopeRegistry {
  let registry = seeded();
  registry = completeTask(registry, {
    task_id: TASK,
    at: L(30),
    evidence_refs: ['artifact://deliverable.docx', 'evidence://run-1-log'],
  });
  return registry;
}

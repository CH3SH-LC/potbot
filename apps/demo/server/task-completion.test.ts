/**
 * **任务级完成口径**的判据测试（contract 附五 R261–R263；design-06-P5 的 I-2）。
 *
 * 这一组测的是**纯派生**：输入一组工作项 / 轮次 / 动作 / 产物，输出一个完成结论。
 * 因此不接模型、不接 HTTP、不碰磁盘——**除了最后一组**，它读真实源码，做的是
 * "把某个谓词从判据里摘掉 ⇒ 对应断言必须变红"的**反向对照**与"没有写入口"的静态判据。
 *
 * 桩的形状纪律：本派生只读 `WorkItem.status` / `RunRecord.{status,lease_deadline}` /
 * `ArtifactRecord.{status,receipt}` / 动作行的 `{state,action_id,task_id}`。工作项与轮次用
 * **真实构造器**（它们的必填校验本身就是判据的一部分）；产物记录用只填这几项的结构桩并注明。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asRevision,
  asRunId,
  asTaskId,
  createRunRecord,
  createWorkItem,
  type ArtifactRecord,
  type LogicalTime,
  type RunRecord,
  type WorkItem,
} from '../../../src/protocol/index.js';
import {
  TASK_COMPLETION_LABELS,
  UNRESOLVED_ACTION_STATES,
  completionInSnapshot,
  deriveTaskCompletion,
  isUnresolvedActionState,
  noUnresolvedActions,
  type TaskCompletionActionRow,
  type TaskCompletionInput,
} from './task-completion.js';

const SOURCE_PATH = fileURLToPath(new URL('./task-completion.ts', import.meta.url));
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');

const TASK = asTaskId('T-u-1');
const OTHER_TASK = asTaskId('T-u-other');
const NOW = asLogicalTime(100);

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const TERMINAL_WORK_ITEM_STATUSES = ['completed', 'failed', 'cancelled'] as const;

function workItem(status: WorkItem['status'], taskId = TASK, requestId = 'R-1'): WorkItem {
  const terminal = (TERMINAL_WORK_ITEM_STATUSES as readonly string[]).includes(status);
  return createWorkItem({
    request_id: asRequestId(requestId),
    task_id: taskId,
    owner_instance_id: asInstanceId('I-1'),
    created_at: asLogicalTime(0),
    status,
    // 构造器自己就是一道判据：非终态必须有 blocker_reason，waiting_dependency 还必须有依赖项。
    blocker_reason: terminal ? null : { kind: 'waiting_dependency', detail: 'x' },
    dependency_refs: status === 'waiting_dependency' ? [{ instance_id: asInstanceId('I-2') }] : [],
    failure_reason: status === 'failed' ? 'boom' : null,
  });
}

function run(
  status: RunRecord['status'],
  leaseDeadline: number,
  taskId = TASK,
  runId = 'RUN-1',
): RunRecord {
  return createRunRecord({
    run_id: asRunId(runId),
    task_id: taskId,
    group_id: asGroupId('G-1'),
    instance_id: asInstanceId('I-1'),
    task_revision: asRevision(1),
    started_at: asLogicalTime(0),
    lease_deadline: asLogicalTime(leaseDeadline),
    status,
  });
}

/** 产物记录的结构桩：只填派生真正读的四个字段（是"形状最小"而非"真实构造"）。 */
function artifact(
  status: ArtifactRecord['status'],
  options: { readonly taskId?: string; readonly artifactId?: string; readonly delivered?: boolean } = {},
): ArtifactRecord {
  return {
    artifact_id: options.artifactId ?? 'A-1',
    task_id: options.taskId ?? TASK,
    status,
    // 真实记录带 task_revision；"产物必须绑当前版本"这条判据要用它（S-1026-01）。
    task_revision: 1,
    receipt: options.delivered === false ? null : { readback_digest: 'd', final_path: '/p' },
  } as unknown as ArtifactRecord;
}

function input(patch: Partial<TaskCompletionInput> = {}): TaskCompletionInput {
  return {
    task_id: String(TASK),
    now: NOW,
    // **默认给一条已完成的工作项**（外部监督 S-1026-01 之后）：空集的 `every()` 恒真，
    // 会让"完成"变成平凡命题。给一条真实工作项后，`completed` 才回答有意义的问题。
    work_items: [workItem('completed')],
    runs: [],
    actions: [],
    artifacts: [],
    ...patch,
  };
}

const action = (state: string, actionId = 'ACT-1'): TaskCompletionActionRow => ({
  action_id: actionId,
  task_id: String(TASK),
  state,
});

// ---------------------------------------------------------------------------
// 谓词 ①：全部工作项终态
// ---------------------------------------------------------------------------

describe('R261 谓词①：全部工作项处于终态', () => {
  it('正例：completed / failed / cancelled 三种终态都算终态 ⇒ 谓词成立', () => {
    const view = deriveTaskCompletion(
      input({
        work_items: [workItem('completed', TASK, 'R-1'), workItem('failed', TASK, 'R-2'), workItem('cancelled', TASK, 'R-3')],
      }),
    );
    expect(view.predicates.all_work_items_terminal).toBe(true);
    expect(view.counts.work_items).toBe(3);
    expect(view.counts.work_items_terminal).toBe(3);
  });

  it('反例：只要有一个 pending ⇒ 谓词不成立', () => {
    const view = deriveTaskCompletion(
      input({ work_items: [workItem('completed', TASK, 'R-1'), workItem('pending', TASK, 'R-2')] }),
    );
    expect(view.predicates.all_work_items_terminal).toBe(false);
    expect(view.counts.work_items_terminal).toBe(1);
  });

  it('反例：processing / waiting_dependency 都不是终态', () => {
    for (const status of ['processing', 'waiting_dependency'] as const) {
      expect(deriveTaskCompletion(input({ work_items: [workItem(status)] })).predicates.all_work_items_terminal).toBe(
        false,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 谓词 ②：没有在途轮次
// ---------------------------------------------------------------------------

describe('R261 谓词②：没有在途轮次（含未过期的租约）', () => {
  it('正例：finished / aborted 的轮次都不算在途', () => {
    const view = deriveTaskCompletion(
      input({ runs: [run('finished', 50, TASK, 'RUN-1'), run('aborted', 50, TASK, 'RUN-2')] }),
    );
    expect(view.predicates.no_in_flight_runs).toBe(true);
    expect(view.counts.runs_in_flight).toBe(0);
  });

  it('反例：running 且租约**未**过期 ⇒ 在途（`now=100`，deadline=120）', () => {
    const view = deriveTaskCompletion(input({ runs: [run('running', 120, TASK, 'RUN-LIVE')] }));
    expect(view.predicates.no_in_flight_runs).toBe(false);
    expect(view.in_flight_run_ids).toEqual(['RUN-LIVE']);
  });

  it('边界：`now === lease_deadline` 即过期（区间是 [start, deadline)）⇒ 不算在途，但如实列出', () => {
    const view = deriveTaskCompletion(input({ runs: [run('running', 100, TASK, 'RUN-EXPIRED')] }));
    expect(view.predicates.no_in_flight_runs).toBe(true);
    expect(view.in_flight_run_ids).toEqual([]);
    expect(view.expired_running_run_ids).toEqual(['RUN-EXPIRED']);
  });
});

// ---------------------------------------------------------------------------
// 谓词 ③：没有未决动作
// ---------------------------------------------------------------------------

describe('R261 谓词③：没有未决的动作', () => {
  it('未决集合就是 R261 字面列出的三个状态', () => {
    expect([...UNRESOLVED_ACTION_STATES]).toEqual(['prepared', 'handed_off', 'submitted']);
  });

  it('正例：没有动作；以及只有已到终态 / 已定局的动作 ⇒ 谓词成立', () => {
    expect(deriveTaskCompletion(input({ actions: [] })).predicates.no_unresolved_actions).toBe(true);
    for (const state of ['confirmed_complete', 'invalidated_or_failed', 'result_unknown', 'user_reported_complete']) {
      const view = deriveTaskCompletion(input({ actions: [action(state)] }));
      expect(view.predicates.no_unresolved_actions, `state=${state}`).toBe(true);
    }
  });

  it('反例：prepared / handed_off / submitted 各一条 ⇒ 谓词不成立，且 id 被列出', () => {
    for (const state of UNRESOLVED_ACTION_STATES) {
      const view = deriveTaskCompletion(input({ actions: [action(state, `ACT-${state}`)] }));
      expect(view.predicates.no_unresolved_actions, `state=${state}`).toBe(false);
      expect(view.unresolved_action_ids).toEqual([`ACT-${state}`]);
    }
  });

  it('fail-closed：七态之外的 state 也算未决，且必须被看见', () => {
    expect(isUnresolvedActionState('weird_state')).toBe(true);
    const view = deriveTaskCompletion(input({ actions: [action('not_a_state', 'ACT-X')] }));
    expect(view.predicates.no_unresolved_actions).toBe(false);
    expect(view.unknown_action_states).toEqual(['not_a_state']);
    expect(view.flags.any_unknown_action_state).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 合取：completed 是三谓词的派生结论
// ---------------------------------------------------------------------------

describe('R261 合取：completed = ① && ② && ③', () => {
  it('三个谓词全真才判完成', () => {
    const view = deriveTaskCompletion(
      input({
        work_items: [workItem('completed')],
        runs: [run('finished', 10)],
        actions: [action('confirmed_complete')],
        artifacts: [artifact('published')],
      }),
    );
    expect(view.predicates).toEqual({
      all_work_items_terminal: true,
      no_in_flight_runs: true,
      no_unresolved_actions: true,
    });
    expect(view.completed).toBe(true);
  });

  it('任一谓词为假 ⇒ 不判完成', () => {
    expect(deriveTaskCompletion(input({ work_items: [workItem('pending')] })).completed).toBe(false);
    expect(deriveTaskCompletion(input({ runs: [run('running', 999)] })).completed).toBe(false);
    expect(deriveTaskCompletion(input({ actions: [action('prepared')] })).completed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R262：单轮结束 ≠ 任务完成
// ---------------------------------------------------------------------------

describe('R262：单轮结束不构成任务完成', () => {
  it('"最后一轮已结束"但仍有一个非终态工作项 ⇒ **不得**判完成', () => {
    const view = deriveTaskCompletion(
      input({
        runs: [run('finished', 10, TASK, 'RUN-LAST')],
        work_items: [workItem('pending', TASK, 'R-OPEN')],
        artifacts: [artifact('published')],
      }),
    );
    // 轮次这一项本身是干净的（没有在途）——所以"没完成"只能来自工作项，而不是"轮次没跑完"。
    expect(view.predicates.no_in_flight_runs).toBe(true);
    expect(view.predicates.all_work_items_terminal).toBe(false);
    expect(view.completed).toBe(false);
    expect(view.label).toBe('not_completed');
  });

  it('反向也成立：没有在途轮次 + 没有产物，任务**可以**完成（R262 后半句）', () => {
    const view = deriveTaskCompletion(input({ work_items: [workItem('cancelled')] }));
    expect(view.completed).toBe(true);
    // 但"完成"必须区别于"成功交付"：
    expect(view.label).toBe('completed_and_cancelled');
  });
});

// ---------------------------------------------------------------------------
// R263：完成与成功分开
// ---------------------------------------------------------------------------

describe('R263：完成与成功的三个呈现口径', () => {
  it('全部工作项 completed + 产物已发布并回读 ⇒ 已完成且成功', () => {
    const view = deriveTaskCompletion(
      input({ work_items: [workItem('completed')], artifacts: [artifact('published', { artifactId: 'A-OK' })] }),
    );
    expect(view.completed).toBe(true);
    expect(view.label).toBe('completed_and_successful');
    expect(view.label_text).toBe(TASK_COMPLETION_LABELS.completed_and_successful);
    expect(view.delivered_artifact_ids).toEqual(['A-OK']);
  });

  it('有工作项 failed ⇒ 已完成但有未成之事', () => {
    const view = deriveTaskCompletion(
      input({ work_items: [workItem('failed')], artifacts: [artifact('published')] }),
    );
    expect(view.completed).toBe(true);
    expect(view.label).toBe('completed_with_unfinished_business');
  });

  it('有动作结果未知 ⇒ 已完成但有未成之事', () => {
    const view = deriveTaskCompletion(
      input({
        work_items: [workItem('completed')],
        artifacts: [artifact('published')],
        actions: [action('result_unknown')],
      }),
    );
    expect(view.label).toBe('completed_with_unfinished_business');
    // 区分两件不同的事：`result_unknown` 是**七态之内**的已知取值（R263 的"未成之事"），
    // 而 `any_unknown_action_state` 说的是"取值根本不在七态里"（数据异常）。
    expect(view.flags.any_result_unknown_action).toBe(true);
    expect(view.flags.any_unknown_action_state).toBe(false);
  });

  it('全部 completed 但没有已交付产物 ⇒ **不得**称成功（R262：如实区分于成功交付）', () => {
    const view = deriveTaskCompletion(input({ work_items: [workItem('completed')] }));
    expect(view.completed).toBe(true);
    expect(view.label).toBe('completed_with_unfinished_business');
    expect(view.flags.has_delivered_artifact).toBe(false);
  });

  it('产物只是 staged（未发布/未回读）不算已交付', () => {
    const view = deriveTaskCompletion(
      input({ work_items: [workItem('completed')], artifacts: [artifact('staged')] }),
    );
    expect(view.label).toBe('completed_with_unfinished_business');
  });

  it('有工作项 cancelled ⇒ 已完成且被取消（且优先于"有未成之事"）', () => {
    const view = deriveTaskCompletion(
      input({ work_items: [workItem('cancelled'), workItem('failed', TASK, 'R-2')] }),
    );
    expect(view.label).toBe('completed_and_cancelled');
    // 取舍只在**标签**上；失败这件事本身不能被藏起来：
    expect(view.flags.any_work_item_cancelled).toBe(true);
    expect(view.flags.any_work_item_failed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 判据：重复求值同一结论；跨任务不串味；任务不存在
// ---------------------------------------------------------------------------

describe('R261 判据：重复求值必须得到同一结论', () => {
  it('同一组状态求值两次深相等（纯函数、无隐藏状态）', () => {
    const value = input({
      work_items: [workItem('completed'), workItem('pending', TASK, 'R-2')],
      runs: [run('running', 120, TASK, 'RUN-LIVE'), run('finished', 5, TASK, 'RUN-2')],
      actions: [action('prepared', 'A1'), action('result_unknown', 'A2')],
      artifacts: [artifact('published', { artifactId: 'P1' }), artifact('staged', { artifactId: 'S1' })],
    });
    expect(deriveTaskCompletion(value)).toEqual(deriveTaskCompletion(value));
  });

  it('另一任务的记录不参与本任务求值（R201 跨对象归属）', () => {
    const view = completionInSnapshot(
      {
        tasks: [{ task_id: String(TASK), revision: 1 }, { task_id: String(OTHER_TASK) }],
        work_items: [
          workItem('completed', TASK, 'R-MINE'), // 本任务自己的
          workItem('pending', OTHER_TASK, 'R-OTHER'), // 别的任务的，不得计入
        ],
        runs: [run('running', 999, OTHER_TASK, 'RUN-OTHER')],
        artifacts: [
          artifact('published', { taskId: String(TASK) }),
          artifact('published', { taskId: String(OTHER_TASK), artifactId: 'A-OTHER' }),
        ],
        actions: [{ action_id: 'ACT-OTHER', task_id: String(OTHER_TASK), state: 'prepared' }],
      },
      String(TASK),
      NOW,
    );
    // 归属：**只有本任务的记录**参与求值——别的任务那条 pending 工作项与在途轮次都不得算进来，
    // 否则"别的任务在跑"会被误读成"本任务还在途"。
    expect(view?.completed).toBe(true);
    expect(view?.counts.work_items).toBe(1);
    expect(view?.counts.runs).toBe(0);
    expect(view?.counts.actions).toBe(0);
    expect(view?.delivered_artifact_ids).toEqual(['A-1']);
  });

  it('任务不存在 ⇒ undefined（不编造）', () => {
    expect(completionInSnapshot({ tasks: [], work_items: [], runs: [], artifacts: [], actions: [] }, 'nope', NOW)).toBe(
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// 反向对照：摘掉"未决动作"这一项，断言必须变红
// ---------------------------------------------------------------------------

describe('反向对照：合取里的每一项都是**荷载**的', () => {
  /** 从源码里取"completed = …"那一行的文本。 */
  function conjunctionLineOf(source: string): string {
    const match = /const completed =\n?\s*([^;]+);/.exec(source);
    return match?.[1] ?? '';
  }

  /** 这一行的合取里**缺**了哪些谓词（空数组 = 三个都在）。 */
  function missingFrom(conjunction: string): string[] {
    return ['all_work_items_terminal', 'no_in_flight_runs', 'no_unresolved_actions'].filter(
      (name) => !conjunction.includes(`predicates.${name}`),
    );
  }

  it('尺子有刻度：真实源码的合取含全部三个谓词', () => {
    expect(missingFrom(conjunctionLineOf(SOURCE))).toEqual([]);
  });

  it('摘掉任一谓词，这个检查都会变红（三个都试）', () => {
    for (const name of ['all_work_items_terminal', 'no_in_flight_runs', 'no_unresolved_actions']) {
      const original = conjunctionLineOf(SOURCE);
      // 合取项可能在首（`X && …`）也可能在尾/中（`… && X`）——两种位置都要能摘干净。
      const mutated = original
        .replace(new RegExp(`predicates\\.${name}\\s*&&\\s*`), '')
        .replace(new RegExp(`\\s*&&\\s*predicates\\.${name}`), '');
      expect(missingFrom(mutated), `摘掉 ${name} 后本应被发现`).toEqual([name]);
      // 反向再核一次：没动过的原文不缺任何东西（避免"尺子把什么都判成缺"）。
      expect(missingFrom(original)).toEqual([]);
    }
  });

  it('行为层反向对照：未决动作是"不判完成"的**唯一**理由', () => {
    const value = input({
      work_items: [workItem('completed')],
      runs: [run('finished', 10)],
      artifacts: [artifact('published')],
      actions: [action('prepared', 'ACT-BLOCK')],
    });
    const view = deriveTaskCompletion(value);

    // 谓词①②都成立、只有③不成立 ⇒ 结论为假**完全**由③承担。
    expect(view.predicates.all_work_items_terminal).toBe(true);
    expect(view.predicates.no_in_flight_runs).toBe(true);
    expect(view.predicates.no_unresolved_actions).toBe(false);
    expect(view.completed).toBe(false);
    expect(view.unresolved_action_ids).toEqual(['ACT-BLOCK']);

    // 用**真实导出的谓词**拼一个"摘掉③"的变异结论：它翻转成 true。
    const mutated =
      view.predicates.all_work_items_terminal && view.predicates.no_in_flight_runs; // 刻意不含 no_unresolved_actions
    expect(mutated).toBe(true);
    expect(view.completed).not.toBe(mutated);
  });

  it('谓词函数本身可单独调用（反向对照用的是真实现，不是另抄一份）', () => {
    expect(noUnresolvedActions([action('prepared')])).toBe(false);
    expect(noUnresolvedActions([action('confirmed_complete')])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 静态判据：没有"把任务置为完成"的写入口
// ---------------------------------------------------------------------------

describe('R261 静态判据：完成是派生结论，没有写入口', () => {
  /**
   * 扫描**代码**而不是注释：本模块的头部注释**故意**列出"不存在 setCompleted / putTask 之类"
   * 这些名字。若连注释一起扫，那把尺子量的是文档措辞而不是代码——所以先把注释剥掉。
   * （自证：stripComments 之后仍能在合成样本里抓到写口，见下一条用例。）
   */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  const CODE = stripComments(SOURCE);

  it('尺子有刻度：注释剥掉之后，合成出来的写口仍然会被抓到', () => {
    const forged = `${CODE}\nexport function setCompleted(): void { void 0; }\n`;
    expect(stripComments(forged)).toMatch(/\b(setCompleted|markCompleted|completeTask|markTaskCompleted)\b/);
  });

  it('源码（剥离注释后）里没有置完成 / 写状态的 API', () => {
    expect(CODE).not.toMatch(/\b(setCompleted|markCompleted|completeTask|markTaskCompleted)\b/);
    expect(CODE).not.toMatch(/\b(putTask|putWorkItem|putRun|putActionRecord|putTaskLifecycle)\b/);
    expect(CODE).not.toMatch(/\btransact\s*\(/);
  });

  it('派生模块不做文件 IO、不读墙钟（与 `src/**` 同一条纪律）', () => {
    expect(SOURCE).not.toMatch(/from 'node:fs/);
    expect(SOURCE).not.toMatch(/Date\.now\(\)/);
    expect(SOURCE).not.toMatch(/Math\.random\(\)/);
  });

  it('`now` 是**参数**而不是内部取的：同一输入可复算（同一 now ⇒ 同一结论）', () => {
    const runs = [run('running', 100)];
    // deadline=100：now=99 时在途，now=100 时不算在途——结论随**传入**的时间变化，而非隐藏状态。
    expect(deriveTaskCompletion(input({ runs, now: asLogicalTime(99) })).completed).toBe(false);
    expect(deriveTaskCompletion(input({ runs, now: asLogicalTime(100) })).completed).toBe(true);
  });
});

/**
 * KRN-10：在途轮次的**检查点**（哪些已提交 / 在途 / 未知；重启从检查点恢复；未知副作用不盲重放）。
 *
 * ## 判据表
 *
 * | # | 用例 | 性质 |
 * |---|---|---|
 * | 1 | 七态 → 三档穷尽映射（`prepared` 在途；四态未知；两态已提交） | 正例 |
 * | 2 | 同任务存在未知动作 ⇒ `running` 轮次**升级为未知**，不得进 `replay_allowed` | **反例** |
 * | 3 | 检查点成对落盘、读回一致 | 正例 |
 * | 4 | 提交前故障 ⇒ **两条都不落盘**（成对提交或不动） | **反向对照（原子性）** |
 * | 5 | 只有 header 的**半份**检查点 ⇒ `torn` 拒用；内容被改 ⇒ `corrupt` 拒用 | **反例** |
 * | 6 | 恢复计划：`replayed` 只含在途；`withheld` 只含未知；`blind_replay_allowed=false` | 正例 |
 * | 7 | 恢复时过期租约作废、未过期续接（复用既有租约语义） | 正例 + **反例** |
 *
 * ## 介质说明
 *
 * 全部用例在**同进程**内构造与读回（含"关掉 store 再开一个"的同进程模拟）。
 * **真实双进程**的崩溃/并发实测**未做**，本文件不据此宣称跨进程结论。
 */

import { describe, expect, it } from 'vitest';

import {
  asEventId,
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRequestId,
  asRevision,
  asRunId,
  asTaskId,
  createIdSource,
  createKernelEvent,
  createRunRecord,
  type EventIdSource,
  type InstanceId,
  type KernelEvent,
  type StoreSnapshot,
  type TaskId,
} from '../protocol/index.js';
import { createMemoryStore } from '../storage/index.js';
import {
  applyActionTransition,
  prepareAction,
  type ActionRecord,
  type ActionState,
} from '../workledger/index.js';
import { createSideEffect } from '../workledger/index.js';
import { CLOCK_ACTION_STATES, WORKLEDGER_ACTION_STATES } from '../workledger/index.js';
import {
  CHECKPOINT_CLASSES,
  actionStateAlignmentGateInvocations,
  applyCheckpointRestore,
  buildCheckpoint,
  classifyActionState,
  classifyActionStateDetailed,
  classifyRunStatus,
  commitCheckpoint,
  ensureActionStateAlignment,
  loadCheckpoint,
  planCheckpointRestore,
} from './checkpoint.js';

const TASK: TaskId = asTaskId('T1');
const OTHER_TASK: TaskId = asTaskId('T2');
const INSTANCE: InstanceId = asInstanceId('C');

function emptyBase(): StoreSnapshot {
  return createMemoryStore().snapshot();
}

function snap(over: Partial<StoreSnapshot>): StoreSnapshot {
  return { ...emptyBase(), ...over };
}

/** 造一条处于指定状态的动作记录（走真实的 `prepareAction` / `applyActionTransition`）。 */
function actionIn(actionId: string, state: ActionState, task: TaskId = TASK): ActionRecord {
  const prepared = prepareAction({
    action_id: actionId,
    task_id: task,
    task_revision: asRevision(1),
    action_kind: 'open_page',
    params: { url: 'https://example.com', actionId },
    authorization: {
      source: 'app.foreground',
      user_approved: true,
      task_revision: asRevision(1),
      revoked: false,
      subject_instance_id: null,
      granted_at: asLogicalTime(1),
    },
    at: asLogicalTime(1),
  });
  if (state === 'prepared') return prepared;
  const submitted = applyActionTransition({
    action: prepared,
    to: 'submitted',
    at: asLogicalTime(2),
    side_effect: createSideEffect({ effect_id: `e-${actionId}`, description: '发出请求', at: asLogicalTime(2) }),
  });
  if (state === 'submitted') return submitted;
  if (state === 'confirmed_complete') {
    return applyActionTransition({
      action: submitted,
      to: 'confirmed_complete',
      at: asLogicalTime(3),
      receipt: { trusted: true, source: 'browser', detail: '完成', at: asLogicalTime(3) },
    });
  }
  if (state === 'user_reported_complete') {
    return applyActionTransition({
      action: submitted,
      to: 'user_reported_complete',
      at: asLogicalTime(3),
      user_report: { message_id: asMessageId('m-r'), note: '用户报告' },
    });
  }
  if (state === 'result_unknown') {
    return applyActionTransition({ action: submitted, to: 'result_unknown', at: asLogicalTime(3) });
  }
  if (state === 'invalidated_or_failed') {
    return applyActionTransition({
      action: submitted,
      to: 'invalidated_or_failed',
      at: asLogicalTime(3),
      invalidated_reason: '任务版本已变',
    });
  }
  // handed_off：submitted 之前的一态，用 prepared 直接转。
  return applyActionTransition({ action: prepared, to: 'handed_off', at: asLogicalTime(2) });
}

function run(id: string, status: 'running' | 'finished' | 'aborted', task: TaskId = TASK) {
  return createRunRecord({
    run_id: asRunId(id),
    task_id: task,
    group_id: asGroupId('G1'),
    instance_id: INSTANCE,
    task_revision: asRevision(1),
    started_at: asLogicalTime(1),
    lease_deadline: asLogicalTime(1001),
    status,
    finished_at: status === 'running' ? null : asLogicalTime(50),
  });
}

describe('KRN-10 检查点：七态 → 三档（穷尽映射）', () => {
  it('① `prepared` 在途；四态未知；两个终结态已提交', () => {
    expect(classifyActionState('prepared')).toBe('in_flight');
    for (const state of ['handed_off', 'submitted', 'result_unknown', 'user_reported_complete'] as const) {
      expect(classifyActionState(state)).toBe('unknown');
    }
    for (const state of ['confirmed_complete', 'invalidated_or_failed'] as const) {
      expect(classifyActionState(state)).toBe('committed');
    }
    expect(classifyRunStatus('running')).toBe('in_flight');
    expect(classifyRunStatus('finished')).toBe('committed');
    expect(classifyRunStatus('aborted')).toBe('committed');
    // 三档集合本身是封闭的。
    expect([...CHECKPOINT_CLASSES]).toEqual(['committed', 'in_flight', 'unknown']);
  });
});

// ---------------------------------------------------------------------------
// N-3 / N-4：分类器经**映射表**接受两侧七态词汇；对齐自检进入归约门禁
// ---------------------------------------------------------------------------

describe('N-4：检查点分类器经映射表接受**两侧**七态词汇（不再拒 clock 词表）', () => {
  it('本侧（workledger）逐态归类正确', () => {
    expect(classifyActionState('prepared')).toBe('in_flight');
    for (const state of ['handed_off', 'submitted', 'result_unknown', 'user_reported_complete'] as const) {
      expect(classifyActionState(state)).toBe('unknown');
    }
    for (const state of ['confirmed_complete', 'invalidated_or_failed'] as const) {
      expect(classifyActionState(state)).toBe('committed');
    }
  });

  it('对面（clock）逐态被正确归类，**不抛**（N-4 缺口闭合）', () => {
    expect(classifyActionState('prepared')).toBe('in_flight');
    expect(classifyActionState('handed_off')).toBe('unknown');
    expect(classifyActionState('submitted')).toBe('unknown');
    expect(classifyActionState('user_reported')).toBe('unknown');
    expect(classifyActionState('unknown')).toBe('unknown');
    expect(classifyActionState('failed')).toBe('committed');
    // 非等价项走**显式裁决** ⇒ committed（不再运行期抛错）。
    expect(classifyActionState('confirmed')).toBe('committed');
  });

  it('**两侧词表的每一个**键名都能分类（无例外，不抛）', () => {
    for (const state of CLOCK_ACTION_STATES) {
      expect(() => classifyActionState(state), `clock:${state}`).not.toThrow();
    }
    for (const state of WORKLEDGER_ACTION_STATES) {
      expect(() => classifyActionState(state), `workledger:${state}`).not.toThrow();
    }
    // 两侧并集一共 11 个不同键名（prepared / handed_off / submitted 三个同名）。
    expect(new Set([...CLOCK_ACTION_STATES, ...WORKLEDGER_ACTION_STATES]).size).toBe(11);
  });

  it('三个键名两侧同名；四个异名键经映射表归口后与对面**同档**', () => {
    // N-5-2：这里原先是 `expect(f(x)).toBe(f(x))` —— 纯函数自比，**恒真**、零判别力。
    // 改为对同一输入断言**具体档位**（漏映射 / 档位漂移即红）。
    const sharedExpected: Readonly<Record<'prepared' | 'handed_off' | 'submitted', 'in_flight' | 'unknown'>> =
      Object.freeze({ prepared: 'in_flight', handed_off: 'unknown', submitted: 'unknown' });
    for (const shared of ['prepared', 'handed_off', 'submitted'] as const) {
      expect(CLOCK_ACTION_STATES).toContain(shared);
      expect(WORKLEDGER_ACTION_STATES).toContain(shared);
      expect(classifyActionState(shared), `两侧同名键 ${shared} 的具体档位`).toBe(sharedExpected[shared]);
    }
    // 反向对照：**不同输入 ⇒ 不同档**（`prepared` 未接触外部世界 ⇒ 在途；`handed_off` 已交出去 ⇒ 未知）。
    // 若分类器退化成"无论输入都返回同一档"，上面三条会红；若退化成"自比恒真"，这一条会红。
    expect(classifyActionState('prepared')).not.toBe(classifyActionState('handed_off'));
    for (const [clockState, workledgerState] of [
      ['unknown', 'result_unknown'],
      ['user_reported', 'user_reported_complete'],
      ['failed', 'invalidated_or_failed'],
      ['confirmed', 'confirmed_complete'],
    ] as const) {
      expect(classifyActionState(clockState), clockState).toBe(classifyActionState(workledgerState));
    }
  });

  it('不等价项**显式报出**（equivalent=false + 裁决理由），不是静默等价', () => {
    const clockConfirmed = classifyActionStateDetailed('confirmed');
    expect(clockConfirmed.side).toBe('clock');
    expect(clockConfirmed.classification).toBe('committed');
    expect(clockConfirmed.equivalent).toBe(false);
    expect(clockConfirmed.adjudication ?? '').toContain('不等价');
    expect(clockConfirmed.adjudication ?? '').toContain('expired');

    const workledgerConfirmed = classifyActionStateDetailed('confirmed_complete');
    expect(workledgerConfirmed.side).toBe('workledger');
    expect(workledgerConfirmed.equivalent).toBe(true);
    expect(workledgerConfirmed.adjudication).toBeNull();
  });

  it('等价项如实报等价（判据不恒真：既有 false 也有 true）', () => {
    expect(classifyActionStateDetailed('unknown')).toMatchObject({
      side: 'clock',
      equivalent: true,
      canonical: 'result_unknown',
      adjudication: null,
    });
    expect(classifyActionStateDetailed('failed')).toMatchObject({
      side: 'clock',
      equivalent: true,
      canonical: 'invalidated_or_failed',
    });
    expect(classifyActionStateDetailed('submitted')).toMatchObject({ side: 'workledger', equivalent: true });
  });

  it('两表都不认的字符串 ⇒ **具名报错**（列出两侧词表），不静默归类', () => {
    for (const bogus of ['paused', 'result_unknown_complete', '']) {
      expect(() => classifyActionState(bogus), bogus).toThrow(/未分类的动作状态/);
      expect(() => classifyActionState(bogus), bogus).toThrow(/既不在 workledger 七态/);
      expect(() => classifyActionState(bogus), bogus).toThrow(/也不在 clock 七态/);
    }
    expect(() => classifyActionState('paused')).toThrow(/拒绝静默归并/);
  });
});

describe('N-3：对齐自检进入归约门禁（映射表真的承重）', () => {
  it('归约路径（buildCheckpoint）确实过对齐闸', () => {
    const before = actionStateAlignmentGateInvocations();
    buildCheckpoint({ snapshot: snap({}), actions: [actionIn('act-gate', 'prepared')], at: asLogicalTime(1) });
    expect(actionStateAlignmentGateInvocations()).toBeGreaterThan(before);
  });

  it('**新增状态即失败**：任一侧凭空多一个状态 ⇒ 归约门禁抛错', () => {
    const before = actionStateAlignmentGateInvocations();
    expect(() => ensureActionStateAlignment([...CLOCK_ACTION_STATES, 'paused'], WORKLEDGER_ACTION_STATES)).toThrow(
      /新增即失败/,
    );
    expect(() =>
      ensureActionStateAlignment(CLOCK_ACTION_STATES, [...WORKLEDGER_ACTION_STATES, 'partially_done']),
    ).toThrow(/新增即失败/);
    // 闸确实被调用过（不是被短路跳过）。
    expect(actionStateAlignmentGateInvocations()).toBeGreaterThan(before);
  });

  it('真实词表下闸门放行（不误报）', () => {
    expect(() => ensureActionStateAlignment()).not.toThrow();
    expect(() => classifyActionState('prepared')).not.toThrow();
  });
});

describe('KRN-10 检查点：构造', () => {
  it('② 反向对照：同任务存在未知动作 ⇒ `running` 轮次**升级为未知**，不进 `replay_allowed`', () => {
    const checkpoint = buildCheckpoint({
      snapshot: snap({ runs: [run('run-1', 'running')] }),
      actions: [actionIn('act-unknown', 'submitted')],
      at: asLogicalTime(10),
    });
    expect(checkpoint.in_flight).toEqual([]);
    expect(checkpoint.unknown).toEqual(['run-1', 'act-unknown']);
    expect(checkpoint.replay_allowed).toEqual([]);
    expect(checkpoint.no_replay).toEqual(['run-1', 'act-unknown']);
    expect(checkpoint.blind_replay_allowed).toBe(false);
  });

  it('③ 正例：无未知动作 ⇒ `running` 在途、`prepared` 在途、已终结者已提交', () => {
    const checkpoint = buildCheckpoint({
      snapshot: snap({ runs: [run('run-1', 'running'), run('run-2', 'finished')] }),
      actions: [actionIn('act-prepared', 'prepared'), actionIn('act-done', 'confirmed_complete')],
      at: asLogicalTime(10),
    });
    expect([...checkpoint.in_flight].sort()).toEqual(['act-prepared', 'run-1']);
    expect([...checkpoint.replay_allowed].sort()).toEqual(['act-prepared', 'run-1']);
    expect([...checkpoint.committed].sort()).toEqual(['act-done', 'run-2']);
    expect(checkpoint.unknown).toEqual([]);
  });

  it('④ 未知动作**属于别的任务** ⇒ 不影响本任务的在途轮次（归属判据不误伤）', () => {
    const checkpoint = buildCheckpoint({
      snapshot: snap({ runs: [run('run-1', 'running', TASK)] }),
      actions: [actionIn('act-other', 'submitted', OTHER_TASK)],
      at: asLogicalTime(10),
    });
    expect(checkpoint.in_flight).toEqual(['run-1']);
    expect(checkpoint.unknown).toEqual(['act-other']);
  });
});

describe('KRN-10 检查点：成对提交或不动', () => {
  function sampleCheckpoint() {
    return buildCheckpoint({
      snapshot: snap({ runs: [run('run-1', 'running')] }),
      actions: [actionIn('act-prepared', 'prepared'), actionIn('act-unknown', 'submitted')],
      at: asLogicalTime(10),
    });
  }

  it('⑤ 正例：成对落盘，读回一致（状态 / 条目 / 名单）', () => {
    const store = createMemoryStore();
    const checkpoint = sampleCheckpoint();
    const id = commitCheckpoint({ store, checkpoint });
    const loaded = loadCheckpoint(store);
    expect(loaded.status).toBe('ok');
    expect(loaded.checkpoint_id).toBe(id);
    expect(loaded.checkpoint?.entries).toEqual(checkpoint.entries);
    expect(loaded.checkpoint?.replay_allowed).toEqual(checkpoint.replay_allowed);
    expect(loaded.checkpoint?.no_replay).toEqual(checkpoint.no_replay);
    // 只写了一对事件（header + body）。
    expect(store.snapshot().kernel_events).toHaveLength(2);
  });

  it('⑥ 反向对照（原子性）：提交前故障 ⇒ 两条都不落盘，读回 `absent`', () => {
    const store = createMemoryStore({
      faults: {
        beforeCommit: () => {
          throw new Error('注入的提交前故障');
        },
      },
    });
    expect(() => commitCheckpoint({ store, checkpoint: sampleCheckpoint() })).toThrow();
    expect(store.snapshot().kernel_events).toHaveLength(0);
    expect(loadCheckpoint(store).status).toBe('absent');
  });

  it('⑦ 反例：只有 header 的**半份**检查点 ⇒ `torn`，拒用且 `checkpoint=null`', () => {
    const ids: EventIdSource = createIdSource();
    const store = createMemoryStore();
    const header = createKernelEvent(
      {
        kind: 'recovery_performed',
        at: asLogicalTime(10),
        data: { checkpoint_part: 'checkpoint_header', checkpoint_id: 'ckpt-x', taken_at: 10, entry_count: 0, digest: 'deadbeef' },
      },
      ids,
    );
    store.transact((tx) => tx.appendKernelEvent(header));
    const loaded = loadCheckpoint(store);
    expect(loaded.status).toBe('torn');
    expect(loaded.checkpoint).toBeNull();
    expect(loaded.detail).toContain('半份');
  });

  it('⑧ 反例：body 内容被改（摘要不符）⇒ `corrupt`，拒用', () => {
    const store = createMemoryStore();
    const checkpoint = sampleCheckpoint();
    commitCheckpoint({ store, checkpoint });
    const header = store.snapshot().kernel_events.find(
      (e) => e.data['checkpoint_part'] === 'checkpoint_header',
    ) as KernelEvent;

    const tampered = createMemoryStore();
    tampered.transact((tx) => {
      tx.appendKernelEvent(header);
      tx.appendKernelEvent(
        createKernelEvent(
          {
            kind: 'recovery_performed',
            at: asLogicalTime(10),
            event_id: asEventId('evt-ckpt-tampered-body'),
            data: {
              checkpoint_part: 'checkpoint_body',
              checkpoint_id: header.data['checkpoint_id'],
              entries: [
                { subject: 'run-1', kind: 'run', state: 'running', classification: 'in_flight', detail: '被改过' },
              ],
            },
          },
          createIdSource(),
        ),
      );
    });
    const loaded = loadCheckpoint(tampered);
    expect(loaded.status).toBe('corrupt');
    expect(loaded.checkpoint).toBeNull();
  });
});

describe('KRN-10 检查点：从检查点恢复（未知副作用不盲重放）', () => {
  it('⑨ 恢复计划：`replayed` 只含在途，`withheld` 只含未知，恒无盲重放', () => {
    const checkpoint = buildCheckpoint({
      snapshot: snap({ runs: [run('run-1', 'running'), run('run-2', 'aborted')] }),
      actions: [
        actionIn('act-prepared', 'prepared'),
        actionIn('act-unknown', 'handed_off'),
        actionIn('act-done', 'confirmed_complete'),
      ],
      at: asLogicalTime(10),
    });
    const plan = planCheckpointRestore(checkpoint);
    expect(plan.replayed).toEqual(['act-prepared']);
    expect([...plan.withheld].sort()).toEqual(['act-unknown', 'run-1']);
    expect([...plan.already_committed].sort()).toEqual(['act-done', 'run-2']);
    expect(plan.blind_replay_allowed).toBe(false);
    // 未知者**绝不**出现在可重排名单里（这是本模块的核心不变量）。
    for (const subject of plan.withheld) {
      expect(plan.replayed).not.toContain(subject);
    }
  });

  it('⑩ 恢复：过期租约作废并落盘；未过期续接（复用既有租约语义）', () => {
    const store = createMemoryStore();
    store.transact((tx) => {
      tx.putRun(
        createRunRecord({
          run_id: asRunId('run-expired'),
          task_id: TASK,
          group_id: asGroupId('G1'),
          instance_id: INSTANCE,
          task_revision: asRevision(1),
          started_at: asLogicalTime(1),
          lease_deadline: asLogicalTime(5),
          status: 'running',
        }),
      );
      tx.putRun(
        createRunRecord({
          run_id: asRunId('run-live'),
          task_id: TASK,
          group_id: asGroupId('G1'),
          instance_id: INSTANCE,
          task_revision: asRevision(1),
          started_at: asLogicalTime(1),
          lease_deadline: asLogicalTime(1000),
          status: 'running',
        }),
      );
    });
    const checkpoint = buildCheckpoint({ snapshot: store.snapshot(), actions: [], at: asLogicalTime(10) });
    const report = applyCheckpointRestore({ store, checkpoint, now: asLogicalTime(10) });
    expect(report.leases.expired).toEqual(['run-expired']);
    expect(report.leases.continuing).toEqual(['run-live']);
    // 落盘：过期者真的变成 aborted（不是只在返回值里说说）。
    const runs = store.snapshot().runs;
    expect(runs.find((r) => String(r.run_id) === 'run-expired')?.status).toBe('aborted');
    expect(runs.find((r) => String(r.run_id) === 'run-live')?.status).toBe('running');
  });

  it('⑪ 恢复不给未知副作用开任何后门：`blocked_tasks` 只收录未知者所属任务', () => {
    const store = createMemoryStore();
    const checkpoint = buildCheckpoint({
      snapshot: snap({ runs: [run('run-1', 'running')] }),
      actions: [actionIn('act-unknown', 'submitted', OTHER_TASK)],
      at: asLogicalTime(10),
    });
    const report = applyCheckpointRestore({
      store,
      checkpoint,
      now: asLogicalTime(10),
      tasksOfSubjects: { 'act-unknown': String(OTHER_TASK), 'run-1': String(TASK) },
    });
    expect(report.blocked_tasks).toEqual([String(OTHER_TASK)]);
    expect(report.blind_replay_allowed).toBe(false);
  });
});

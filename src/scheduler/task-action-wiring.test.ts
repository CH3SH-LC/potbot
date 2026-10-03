/**
 * KRN-07 / KRN-09 **接线**的验收用例（FA-S）。
 *
 * 与 `action-ledger.test.ts` / `task-lifecycle.test.ts` 的分工：
 * - 那两个文件证明**语义层**（纯函数）正确；
 * - 本文件证明这些语义**接到了真实入口上**——`Scheduler.onMessage` / `startRun` / `finishRun` /
 *   `pauseTask` / `clickAction`，不是"可调用的纯函数"。FA-O 登记的原缺口正是"未接线"。
 *
 * ## 介质说明
 *
 * `Store` 接缝（`src/storage/store-core.ts` 的六个方法）落地后，**两个介质都实现了它**
 * （内存版与文件版共用 `TransactionView`），因此接线状态是 `'store'`——
 * `finishRun` / `startRun` / `clickAction` 的 `task_wiring` 字段会如实回报。
 *
 * 跨重启那一条用**真 `createFileStore`**：第一代写入 → 第二代（同文件、全新 store 与
 * scheduler）读回台账与运行态。**不是**用进程内存"证明"持久性（R220）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  asLogicalTime,
  asRevision,
  asRunId,
  createGroupMember,
  createIdSource,
  createInstanceState,
  createTaskRecord,
  PersistenceError,
  type LogicalTime,
  type Revision,
  type StorageTransaction,
  type TaskId,
} from '../protocol/index.js';
import type { ActionRecord } from '../workledger/index.js';
import { createFileStore, __deleteStoreFiles } from '../storage/index.js';
import { createScheduler } from './scheduler.js';
import {
  TaskActionSeamMissingError,
  taskActionPortOf,
  type TaskActionStorePort,
} from './task-action-store.js';
import { isActionRecordExecutable } from './task-action-wiring.js';
import type { TaskLifecycleState } from './task-lifecycle.js';
import {
  BASELINE_REVISION,
  DEFAULT_SENDER_IDS,
  GROUP_ID,
  INSTANCE_C,
  TASK_ID,
  buildScheduler,
  buildStore,
  readTx,
  registerInstance,
  registerTask,
  requestId,
  resultRef,
  workRequest,
} from './test-support.js';

// ---------------------------------------------------------------------------
// 测试用端口（**进程内存**；非持久，不冒充持久介质）
// ---------------------------------------------------------------------------

/**
 * 内存端口：只实现 `TaskActionStorePort` 的六个方法。
 *
 * 两条如实声明的限制：
 * 1. **不参与事务回滚**——事务体抛错时本端口已写入的内容不会撤销。
 *    （Store 接缝落地后由写时复制事务解决；那正是"必须落到 Store"的理由之一。）
 * 2. **不跨重启**——它是进程内 Map。
 */
function createFakeTaskActionPort(): TaskActionStorePort & {
  readonly actions: Map<string, ActionRecord>;
  readonly lifecycles: Map<string, TaskLifecycleState>;
} {
  const actions = new Map<string, ActionRecord>();
  const lifecycles = new Map<string, TaskLifecycleState>();
  return {
    actions,
    lifecycles,
    putActionRecord(record: ActionRecord): void {
      actions.set(record.action_id, record);
    },
    getActionRecord(actionId): ActionRecord | undefined {
      return actions.get(actionId);
    },
    listActionRecords(): readonly ActionRecord[] {
      return Object.freeze([...actions.values()]);
    },
    putTaskLifecycle(state: TaskLifecycleState): void {
      lifecycles.set(state.task_id, state);
    },
    getTaskLifecycle(taskId): TaskLifecycleState | undefined {
      return lifecycles.get(taskId);
    },
    listTaskLifecycles(): readonly TaskLifecycleState[] {
      return Object.freeze([...lifecycles.values()]);
    },
  };
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

interface Bench {
  readonly store: ReturnType<typeof buildStore>;
  readonly scheduler: ReturnType<typeof buildScheduler>;
  readonly at: (n: number) => LogicalTime;
}

/** 起一个"任务已注册 + 一条工作请求已投递 + 一轮已启动"的场景。 */
function bench(options: { readonly startRun?: boolean } = {}): Bench {
  const store = buildStore();
  const scheduler = buildScheduler(store);
  registerInstance(store, INSTANCE_C);
  registerTask(store);
  scheduler.onMessage(workRequest(1));
  if (options.startRun !== false) {
    const started = scheduler.startRun({ instance_id: INSTANCE_C, task_id: TASK_ID });
    expect(started.started).toBe(true);
  }
  return { store, scheduler, at: (n: number) => asLogicalTime(n) };
}

/** 经**事务**读该任务的生命周期（不窥探端口内部）。 */
function lifecycleStateOf(store: Bench['store']): TaskLifecycleState | undefined {
  return readTx(store, (tx) => taskActionPortOf(tx)?.getTaskLifecycle(TASK_ID));
}

/** 经**事务**数该任务的动作记录条数。 */
function actionCountOf(store: Bench['store']): number {
  return readTx(store, (tx) => taskActionPortOf(tx)?.listActionRecords().length ?? 0);
}

const R1 = requestId('r-1');
const RUN_1 = asRunId('run-1');

function completedPublication() {
  return { kind: 'completed' as const, request_id: R1, result_refs: [resultRef(R1)] };
}

function workItemStatusOf(bench: Bench): string | undefined {
  return readTx(bench.store, (tx) => tx.getWorkItem(R1)?.status);
}

function lifecycleOf(bench: Bench): TaskLifecycleState | undefined {
  return lifecycleStateOf(bench.store);
}

function bumpTaskRevision(bench: Bench, revision: number): void {
  readTx(bench.store, (tx: StorageTransaction) => {
    const task = tx.getTask(TASK_ID);
    if (task === undefined) {
      throw new Error('夹具错误：任务未注册');
    }
    tx.putTask(
      createTaskRecord({
        ...task,
        revision: asRevision(revision),
        updated_at: asLogicalTime(99),
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// 对照：不暂停时，同样的完成发布**被接受**（证明后面的红灯来自闸门，不是别的原因）
// ---------------------------------------------------------------------------

describe('对照：任务运行中，完成发布被接受', () => {
  it('运行中收到 completed 发布 → accepted，工作项置 completed，任务运行态仍是 running', () => {
    const b = bench();
    const outcome = b.scheduler.finishRun({
      run_id: RUN_1,
      publications: [completedPublication()],
      at: b.at(10),
    });

    expect(outcome.accepted).toBe(true);
    expect(outcome.applied_request_ids).toEqual([R1]);
    expect(outcome.late_result_reason).toBeNull();
    expect(outcome.task_wiring).toBe('store');
    expect(workItemStatusOf(b)).toBe('completed');

    // 任务完成是**任务级**判定：单轮发布不得自动把任务置 completed。
    expect(lifecycleOf(b)?.status).toBe('running');
    expect(lifecycleOf(b)?.late_results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 反例①：取消后到达的迟到结果 ⇒ 经真实入口不得变成当前成功
// ---------------------------------------------------------------------------

describe('反例①：取消后到达的迟到结果（经 finish_run 真实入口）', () => {
  it('cancel 消息 → 迟到 completed 发布被拒，任务保持 cancelled，留痕 honored_as_success=false', () => {
    const b = bench();

    // 真实入口取消：经 onMessage 投一条 cancel 消息（与协议层控制状态同一事务）。
    b.scheduler.onMessage(
      workRequest(2, { type: 'cancel', request_id: undefined, requires_wakeup: false, content: '停止' }),
    );
    expect(lifecycleOf(b)?.status).toBe('cancelled');
    expect(lifecycleOf(b)?.cancelled_by_message_id).toBeTruthy();

    // 迟到的"完成"结果在取消之后到达。
    const outcome = b.scheduler.finishRun({
      run_id: RUN_1,
      publications: [completedPublication()],
      at: b.at(20),
    });

    expect(outcome.accepted).toBe(false);
    expect(outcome.rejection_reason).toBe('task_cancelled');
    expect(outcome.late_result_reason).toBe('task_cancelled');

    // 工作项**没有**变成完成（"不得变成当前成功"）。
    expect(workItemStatusOf(b)).not.toBe('completed');

    // 迟到结果**照实留痕**，且 honored_as_success 是字面量 false。
    const life = lifecycleOf(b);
    expect(life?.status).toBe('cancelled');
    expect(life?.late_results).toHaveLength(1);
    expect(life?.late_results[0]?.honored_as_success).toBe(false);
    expect(life?.late_results[0]?.reason).toBe('task_cancelled');
    expect(life?.completed_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 反例①-b（**承重**）：暂停后到达的迟到结果——只有任务生命周期能拦
// ---------------------------------------------------------------------------

describe('反例①-b（承重）：暂停后到达的迟到结果', () => {
  it('paused 任务的在途轮次发布 completed → 被拒，工作项不完成', () => {
    const b = bench();

    b.scheduler.pauseTask({
      task_id: TASK_ID,
      revision: BASELINE_REVISION,
      at: b.at(15),
      reason: '用户暂停',
    });
    expect(lifecycleOf(b)?.status).toBe('paused');

    const outcome = b.scheduler.finishRun({
      run_id: RUN_1,
      publications: [completedPublication()],
      at: b.at(20),
    });

    // 这三条只有**任务级生命周期**能给出：协议层 `TaskControlState` 表达不了 paused。
    expect(outcome.accepted).toBe(false);
    expect(outcome.rejection_reason).toBe('task_not_accepting_result');
    expect(outcome.late_result_reason).toBe('task_paused');

    expect(workItemStatusOf(b)).not.toBe('completed');
    const life = lifecycleOf(b);
    expect(life?.status).toBe('paused');
    expect(life?.late_results[0]?.honored_as_success).toBe(false);
    expect(life?.late_results[0]?.reason).toBe('task_paused');
  });

  it('继续运行后，同样的发布重新被接受（暂停不是终态，可恢复）', () => {
    const b = bench();
    b.scheduler.pauseTask({ task_id: TASK_ID, revision: BASELINE_REVISION, at: b.at(15), reason: '暂停' });
    b.scheduler.unpauseTask({ task_id: TASK_ID, revision: BASELINE_REVISION, at: b.at(16), reason: '继续' });

    const outcome = b.scheduler.finishRun({
      run_id: RUN_1,
      publications: [completedPublication()],
      at: b.at(20),
    });

    expect(lifecycleOf(b)?.status).toBe('running');
    expect(outcome.accepted).toBe(true);
    expect(workItemStatusOf(b)).toBe('completed');
    // 迟到留痕保留历史（**不因后续恢复而抹掉**）。
    expect(lifecycleOf(b)?.late_results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 反例②：任务版本升级后，旧动作不得仍可执行
// ---------------------------------------------------------------------------

describe('反例②：旧版本 / 旧参数的动作不得仍可执行（R213）', () => {
  it('版本升级后，携带旧版本自报的点击被拒（stale_task_revision）', () => {
    const b = bench();
    const first = b.scheduler.clickAction({
      task_id: TASK_ID,
      action_kind: 'send_email',
      params: { to: 'a@example.com' },
      authorization: { source: 'user-bubble', user_approved: true },
      at: b.at(1),
    });
    expect(first.accepted).toBe(true);
    expect(first.duplicate).toBe(false);
    expect(first.current_task_revision).toBe(Number(BASELINE_REVISION));

    bumpTaskRevision(b, 2);

    const staleClick = b.scheduler.clickAction({
      task_id: TASK_ID,
      task_revision: asRevision(1),
      action_kind: 'send_email',
      params: { to: 'a@example.com' },
      authorization: { source: 'user-bubble', user_approved: true },
      at: b.at(2),
    });
    expect(staleClick.accepted).toBe(false);
    expect(staleClick.rejection?.reason).toBe('stale_task_revision');
    expect(staleClick.action).toBeNull();
    // 台账里仍然只有那一条旧记录，没有因为越权点击而新增。
    expect(actionCountOf(b.store)).toBe(1);
  });

  it('版本升级 ⇒ 旧版本的非终态动作被批量置失效，且不可再执行', () => {
    const b = bench();
    b.scheduler.clickAction({
      task_id: TASK_ID,
      action_kind: 'send_email',
      params: { to: 'a@example.com' },
      authorization: { source: 'user-bubble', user_approved: true },
      at: b.at(1),
    });
    const before = readTx(b.store, (tx) => taskActionPortOf(tx)?.listActionRecords()[0]);
    expect(before).toBeDefined();
    expect(isActionRecordExecutable(before as ActionRecord, BASELINE_REVISION)).toBe(true);

    bumpTaskRevision(b, 2);
    const swept = b.scheduler.invalidateStaleActions({
      task_id: TASK_ID,
      current_revision: asRevision(2),
      at: b.at(3),
    });

    expect(swept.invalidated).toBe(1);
    const after = swept.actions[0];
    expect(after?.state).toBe('invalidated_or_failed');
    expect(after?.invalidated_reason).toContain('R213');
    expect(isActionRecordExecutable(after as ActionRecord, asRevision(2))).toBe(false);
    // 绑定的任务版本**没有被改写**（历史版本保留）。
    expect(after?.task_revision).toBe(Number(BASELINE_REVISION));
  });

  it('同版本改参数却沿用旧幂等键 ⇒ 拒 idempotency_key_mismatch', () => {
    const b = bench();
    const first = b.scheduler.clickAction({
      task_id: TASK_ID,
      action_kind: 'send_email',
      params: { to: 'a@example.com' },
      authorization: { source: 'user-bubble', user_approved: true },
      at: b.at(1),
    });
    const key = first.action?.idempotency_key;
    expect(key).toBeTruthy();

    const mismatched = b.scheduler.clickAction({
      task_id: TASK_ID,
      action_kind: 'send_email',
      params: { to: 'b@example.com' },
      authorization: { source: 'user-bubble', user_approved: true },
      idempotency_key: key as string,
      at: b.at(2),
    });
    expect(mismatched.accepted).toBe(false);
    expect(mismatched.rejection?.reason).toBe('idempotency_key_mismatch');
    expect(actionCountOf(b.store)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 正例：重复点击幂等（R243）
// ---------------------------------------------------------------------------

describe('正例：重复点击同一动作 ⇒ 幂等', () => {
  it('两次同样点击 → 第二次 duplicate，零重复副作用，且是台账里同一个对象', () => {
    const b = bench();
    const click = {
      task_id: TASK_ID,
      action_kind: 'send_email',
      params: { to: 'a@example.com', subject: 'hi' },
      authorization: { source: 'user-bubble', user_approved: true },
      at: b.at(1),
    } as const;

    const first = b.scheduler.clickAction(click);
    const second = b.scheduler.clickAction(click);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.side_effects_applied).toBe(0);
    expect(first.side_effects_applied).toBe(0);
    // "气泡与执行读同一对象"：就是台账里那**一个**引用。
    expect(second.action).toBe(first.action);
    expect(actionCountOf(b.store)).toBe(1);

    const observed = b.scheduler.observeTaskActions(TASK_ID);
    expect(observed.wiring).toBe('store');
    expect(observed.action_count).toBe(1);
  });

  it('参数不同 ⇒ 是另一个动作（各自一条记录）', () => {
    const b = bench();
    const base = {
      task_id: TASK_ID,
      action_kind: 'send_email',
      authorization: { source: 'user-bubble', user_approved: true },
      at: b.at(1),
    } as const;
    b.scheduler.clickAction({ ...base, params: { to: 'a@example.com' } });
    b.scheduler.clickAction({ ...base, params: { to: 'b@example.com' } });
    expect(actionCountOf(b.store)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 未接线（外来介质）：必须**如实回报**，不得静默降级
// ---------------------------------------------------------------------------

/**
 * 造一个"**没有实现接缝**"的介质：真内存存储，但事务句柄上把那六个方法**藏掉**。
 *
 * 为什么需要它：`Store` 接缝落地后，**仓内两个介质都有接缝** ⇒ `'unwired'` / `'injected'`
 * 这两条分支在本仓内不再自然可达。但它们是**对外来 `Store` 实现**的防御面
 * （有人按 protocol 的 `Store` 接口自己实现一个介质，里面当然没有 FA-S 的六个方法），
 * 所以仍然要有断言守着——否则"如实回报"的承诺就没有证据。
 */
function storeWithoutSeam(store: Bench['store']): Bench['store'] {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'transact') {
        return (work: (tx: StorageTransaction) => unknown): unknown =>
          target.transact((tx) =>
            work(
              new Proxy(tx, {
                get(inner, key, innerReceiver) {
                  if (SEAM_METHODS.includes(key as string)) {
                    return undefined;
                  }
                  return Reflect.get(inner, key, innerReceiver) as unknown;
                },
              }),
            ),
          );
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  }) as Bench['store'];
}

const SEAM_METHODS: readonly string[] = Object.freeze([
  'putActionRecord',
  'getActionRecord',
  'listActionRecords',
  'putTaskLifecycle',
  'getTaskLifecycle',
  'listTaskLifecycles',
]);

describe('未接线（外来介质）：如实回报，不静默用内存兜底（R220）', () => {
  it('介质没有接缝 ⇒ startRun/finishRun 回报 unwired，业务路径照常', () => {
    const store = storeWithoutSeam(buildStore());
    const scheduler = buildScheduler(store);
    registerInstance(store, INSTANCE_C);
    registerTask(store);
    scheduler.onMessage(workRequest(1));
    const started = scheduler.startRun({ instance_id: INSTANCE_C, task_id: TASK_ID });
    expect(started.started).toBe(true);
    expect(started.task_wiring).toBe('unwired');

    const outcome = scheduler.finishRun({
      run_id: RUN_1,
      publications: [completedPublication()],
      at: asLogicalTime(10),
    });
    expect(outcome.task_wiring).toBe('unwired');
    expect(outcome.accepted).toBe(true); // 业务照跑：未接线只是台账不参与
    expect(scheduler.observeTaskActions(TASK_ID).wiring).toBe('unwired');
  });

  it('介质没有接缝且未注入端口 ⇒ clickAction 返回结构化拒因 unwired', () => {
    const store = storeWithoutSeam(buildStore());
    const scheduler = buildScheduler(store);
    registerInstance(store, INSTANCE_C);
    registerTask(store);
    const result = scheduler.clickAction({
      task_id: TASK_ID,
      action_kind: 'send_email',
      params: { to: 'a@example.com' },
      authorization: { source: 'user-bubble', user_approved: true },
    });
    expect(result.accepted).toBe(false);
    expect(result.rejection?.reason).toBe('unwired');
    expect(result.action).toBeNull();
    expect(result.side_effects_applied).toBe(0);
  });

  it('介质没有接缝时 pauseTask / cancelTaskLifecycle **抛错**：静默返回裸状态就是"看不见的成功"', () => {
    const store = storeWithoutSeam(buildStore());
    const scheduler = buildScheduler(store);
    registerInstance(store, INSTANCE_C);
    registerTask(store);
    // 事务内抛错被 Store 包成 `PersistenceError`（accepted=false），根因在 `cause` 上——
    // 断言两层都看：外层证明"事务未接受"，内层证明**是接缝缺失**而不是别的失败。
    const capture = (work: () => unknown): unknown => {
      try {
        work();
        return null;
      } catch (error) {
        return error;
      }
    };

    const paused = capture(() =>
      scheduler.pauseTask({
        task_id: TASK_ID,
        revision: BASELINE_REVISION,
        at: asLogicalTime(5),
        reason: '暂停',
      }),
    );
    expect(paused).toBeInstanceOf(PersistenceError);
    expect((paused as { accepted?: boolean }).accepted).toBe(false);
    expect((paused as { cause?: unknown }).cause).toBeInstanceOf(TaskActionSeamMissingError);

    const cancelled = capture(() =>
      scheduler.cancelTaskLifecycle({
        task_id: TASK_ID,
        revision: BASELINE_REVISION,
        at: asLogicalTime(5),
        reason: '取消',
      }),
    );
    expect(cancelled).toBeInstanceOf(PersistenceError);
    expect((cancelled as { cause?: unknown }).cause).toBeInstanceOf(TaskActionSeamMissingError);

    // 未接线 ⇒ 什么也没写（不是"写了一半"）。
    expect(actionCountOf(store)).toBe(0);
    expect(readTx(store, (tx) => tx.listRuns())).toEqual([]);
  });

  it('没有接缝但**显式注入**端口 ⇒ 走 injected（跨介质兜底路径仍然工作）', () => {
    const store = storeWithoutSeam(buildStore());
    const port = createFakeTaskActionPort();
    const scheduler = buildScheduler(store, { taskActions: port });
    registerInstance(store, INSTANCE_C);
    registerTask(store);
    const result = scheduler.clickAction({
      task_id: TASK_ID,
      action_kind: 'send_email',
      params: { to: 'a@example.com' },
      authorization: { source: 'user-bubble', user_approved: true },
      at: asLogicalTime(1),
    });
    expect(result.accepted).toBe(true);
    expect(result.wiring).toBe('injected');
    expect(port.actions.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 持久化：**真跑**的跨重启恢复（真 file store，两代 store 实例）
// ---------------------------------------------------------------------------

describe('正例：重启后动作台账与任务生命周期从**持久**状态恢复（真 file store）', () => {
  it('第一代写入 → 第二代（同文件、全新 store/scheduler）读回台账与运行态，且幂等键仍然有效', () => {
    const dir = mkdtempSync(join(tmpdir(), 'potbot-fas-restart-'));
    const filePath = join(dir, 'store.json');
    const click = {
      task_id: TASK_ID,
      action_kind: 'send_email',
      params: { to: 'a@example.com' },
      authorization: { source: 'user-bubble', user_approved: true },
      at: asLogicalTime(1),
    } as const;

    try {
      // ——— 第一代：真 file store，全部经**真实入口** ———
      const store1 = createFileStore({ filePath, now: () => 0, lockOwner: 'fas-restart-1' });
      const scheduler1 = createScheduler(store1, {
        idSource: createIdSource(),
        clock: () => asLogicalTime(0),
      });
      store1.transact((tx) => {
        tx.putInstance(createInstanceState({ instance_id: INSTANCE_C, group_id: GROUP_ID, updated_at: asLogicalTime(0) }));
        tx.putGroupMember(createGroupMember({ group_id: GROUP_ID, instance_id: INSTANCE_C, registered_at: asLogicalTime(0) }));
        for (const sender of DEFAULT_SENDER_IDS) {
          tx.putGroupMember(
            createGroupMember({ group_id: GROUP_ID, instance_id: sender, registered_at: asLogicalTime(0) }),
          );
        }
        tx.putTask(
          createTaskRecord({
            task_id: TASK_ID,
            goal: 'FA-S 重启恢复',
            current_group_id: GROUP_ID,
            revision: BASELINE_REVISION,
            created_at: asLogicalTime(0),
            updated_at: asLogicalTime(0),
          }),
        );
      });

      // 真实入口投一条工作请求 ⇒ 有可运行输入（否则 start_run 会以 no_runnable_input 空推进）。
      scheduler1.onMessage(workRequest(1));

      // 接缝**自动接上**（介质自己实现了六个方法）——不靠注入。
      const started = scheduler1.startRun({ instance_id: INSTANCE_C, task_id: TASK_ID });
      expect(started.started).toBe(true);
      expect(started.task_wiring).toBe('store');

      const actionId = scheduler1.clickAction(click).action?.action_id;
      expect(actionId).toBeTruthy();
      scheduler1.pauseTask({
        task_id: TASK_ID,
        revision: BASELINE_REVISION,
        at: asLogicalTime(2),
        reason: '重启前暂停',
      });
      const before = scheduler1.observeTaskActions(TASK_ID);
      expect(before.wiring).toBe('store');
      expect(before.action_count).toBe(1);
      expect(before.lifecycle?.status).toBe('paused');

      // ——— 重启：同一文件、**全新的 store 与 scheduler**（等价于进程重启后的加载路径）———
      const store2 = createFileStore({ filePath, now: () => 0, lockOwner: 'fas-restart-2' });
      const scheduler2 = createScheduler(store2, {
        idSource: createIdSource(),
        clock: () => asLogicalTime(0),
      });

      const after = scheduler2.observeTaskActions(TASK_ID);
      expect(after.wiring).toBe('store');
      expect(after.action_count).toBe(1);
      expect(after.lifecycle?.status).toBe('paused');
      expect(after.lifecycle?.pause_count).toBe(1);

      // 跨重启的**幂等**：同一动作（同参数、同任务版本）再次点击 ⇒ 命中同一幂等键。
      // 若台账没有从持久状态恢复，这里会是 `duplicate: false` 并新建第二条记录。
      const again = scheduler2.clickAction(click);
      expect(again.duplicate).toBe(true);
      expect(again.side_effects_applied).toBe(0);
      expect(again.action?.action_id).toBe(actionId);
      expect(scheduler2.observeTaskActions(TASK_ID).action_count).toBe(1);

      // 跨重启的**迟到语义**同样成立：暂停状态是持久的，所以重启后的「完成」发布仍被拒。
      const late = scheduler2.finishRun({
        run_id: asRunId('run-1'),
        publications: [completedPublication()],
        at: asLogicalTime(3),
      });
      expect(late.accepted).toBe(false);
      expect(late.rejection_reason).toBe('task_not_accepting_result');
      expect(late.late_result_reason).toBe('task_paused');
      expect(scheduler2.observeTaskActions(TASK_ID).lifecycle?.late_result_count).toBe(1);
      expect(scheduler2.observeTaskActions(TASK_ID).lifecycle?.any_late_honored).toBe(false);
    } finally {
      __deleteStoreFiles(filePath);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 观测不变量
// ---------------------------------------------------------------------------

describe('观测不变量', () => {
  it('任何路径下 any_late_honored 恒为 false（迟到结果绝不被当成功）', () => {
    const b = bench();
    b.scheduler.timeoutTask({
      task_id: TASK_ID,
      revision: BASELINE_REVISION,
      at: b.at(5),
      reason: '超时',
    });
    b.scheduler.finishRun({ run_id: RUN_1, publications: [completedPublication()], at: b.at(6) });
    const observed = b.scheduler.observeTaskActions(TASK_ID);
    expect(observed.lifecycle?.status).toBe('timed_out');
    expect(observed.lifecycle?.late_result_count).toBe(1);
    expect(observed.lifecycle?.any_late_honored).toBe(false);
  });
});

/** 未注册的任务：点击按 R213 的"宁可拒绝不放行"处理。 */
describe('未注册任务', () => {
  it('任务不存在 ⇒ 拒 unknown_task（无法判 stale 时宁可拒绝）', () => {
    const store = buildStore();
    const port = createFakeTaskActionPort();
    const scheduler = buildScheduler(store, { taskActions: port });
    registerInstance(store, INSTANCE_C);
    const result = scheduler.clickAction({
      task_id: TASK_ID,
      action_kind: 'send_email',
      params: { to: 'a@example.com' },
      authorization: { source: 'user-bubble', user_approved: true },
    });
    expect(result.accepted).toBe(false);
    expect(result.rejection?.reason).toBe('unknown_task');
  });
});

// 供类型检查器确认 `TaskId` / `Revision` 的用法未被误删。
export type __Types = { readonly task: TaskId; readonly revision: Revision };

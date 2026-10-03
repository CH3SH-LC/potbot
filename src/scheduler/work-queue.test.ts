/**
 * KRN-10：持久队列与后台工作进程的领取 / 续租 / 完成；崩溃后恢复消息、任务、动作与预算；
 * **未知副作用不盲重放**；交付语义是**至少一次**（不宣称恰好一次）。
 *
 * ## 这个文件要钉死的五类判据
 *
 * | # | 用例 | 性质 |
 * |---|---|---|
 * | 1 | 领取 → 续租 → 完成，每一步都落在 Store 里 | 正例 |
 * | 2 | 过期租约不得续命；非持有者不得完成；未领取不得完成 | **反例** |
 * | 3 | 崩溃后过期租约作废、条目回到可领取；未过期租约原样续接 | 正例 + **反例** |
 * | 4 | 同输入换**易失**介质 ⇒ 第 3 条的结论必须相反 | **反向对照** |
 * | 5 | 已交接 / 已提交 / 结果未知的动作 ⇒ **禁止盲重放**，其任务条目被扣留 | **反例** |
 * | 6 | 只 `prepared` 的动作 ⇒ 条目正常回到可领取 | **对照** |
 *
 * 第 4 / 第 6 条是关键：没有它们，"恢复成功"可能只是"根本没崩"或"什么都不恢复"。
 *
 * ## 介质的如实说明
 *
 * 第 3 条的"崩溃"= **同一台机器上、关掉 store 再开一个新的**（同进程模拟）：
 * `createFileStore` 重新构造、从同一份磁盘读回。**不是**真实多进程并发写的实测——
 * 跨进程实测**未做**，本文件不据此宣称跨进程结论。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRevision,
  asTaskId,
  createIdSource,
  createTaskRecord,
  type LogicalTime,
  type Store,
  type TaskId,
} from '../protocol/index.js';
import {
  applyActionTransition,
  prepareAction,
  type ActionAuthorization,
  type ActionRecord,
  type ActionState,
} from '../workledger/index.js';
import { createFileStore, createMemoryStore, __deleteStoreFiles } from '../storage/index.js';
import { taskActionPortOf } from './task-action-store.js';
import {
  ACTION_RECOVERY_DISPOSITIONS,
  QUEUE_DELIVERY_SEMANTICS,
  createWorkQueue,
  deliveryGuarantee,
  describeQueueItem,
  planActionRecovery,
} from './work-queue.js';

const TASK_A = asTaskId('T-A');
const TASK_B = asTaskId('T-B');
const WORKER_1 = asInstanceId('W-1');
const WORKER_2 = asInstanceId('W-2');
const REV = asRevision(1);

let workDir: string;
let storePath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'potbot-wq-'));
  storePath = join(workDir, 'queue-store.json');
});

afterEach(() => {
  __deleteStoreFiles(storePath);
  rmSync(workDir, { recursive: true, force: true });
});

/** `file` = 落盘；`memory` = 易失（模拟"没落盘"的对照）。 */
function openStore(kind: 'file' | 'memory'): Store {
  if (kind === 'memory') {
    return createMemoryStore({ clock: () => asLogicalTime(0) });
  }
  return createFileStore({
    filePath: storePath,
    clock: () => asLogicalTime(0),
    now: () => 0,
    lockOwner: 'wq-test',
    lockStaleMs: 1,
  });
}

function registerTask(store: Store, taskId: TaskId): void {
  store.transact((tx) => {
    tx.putTask(
      createTaskRecord({
        task_id: taskId,
        goal: `目标 ${String(taskId)}`,
        revision: REV,
        created_at: asLogicalTime(0),
      }),
    );
  });
}

/** 造一个授权（绑定任务版本）。 */
function authFor(taskId: TaskId): ActionAuthorization {
  return {
    source: 'test/session',
    user_approved: true,
    task_revision: REV,
    revoked: false,
    subject_instance_id: null,
    granted_at: asLogicalTime(0),
  };
}

/** 把一个动作推进到目标状态并写进动作台账接缝（持久）。 */
function persistAction(store: Store, taskId: TaskId, actionId: string, to: ActionState): ActionRecord {
  let prepared = prepareAction({
    action_id: actionId,
    task_id: taskId,
    task_revision: REV,
    action_kind: 'send_message',
    params: { text: `参数 ${actionId}` },
    authorization: authFor(taskId),
    at: asLogicalTime(0),
  });
  // 沿合法转换表走到目标状态（`prepared → result_unknown` 不是合法边，必须先 `submitted`）。
  const needsSubmitFirst: readonly ActionState[] = [
    'result_unknown',
    'user_reported_complete',
    'confirmed_complete',
  ];
  const hops: readonly ActionState[] =
    to === 'prepared'
      ? []
      : needsSubmitFirst.includes(to)
        ? ['submitted', to]
        : [to];
  for (const hop of hops) {
    prepared = applyActionTransition({
      action: prepared,
      to: hop,
      at: asLogicalTime(1),
      // 部分目标状态要求配套证据（与转换表同源，不得省略）。
      ...(hop === 'confirmed_complete'
        ? { receipt: { trusted: true, source: 'test/receipt', detail: '可信回执', at: asLogicalTime(1) } }
        : {}),
      ...(hop === 'user_reported_complete'
        ? { user_report: { message_id: asMessageId('m-user-report'), note: '用户说完成了' } }
        : {}),
      ...(hop === 'invalidated_or_failed' ? { failure_reason: '测试置为失效' } : {}),
    });
  }
  const record = prepared;
  store.transact((tx) => {
    const port = taskActionPortOf(tx);
    if (port === null) {
      throw new Error('测试夹具要求动作台账接缝可用');
    }
    port.putActionRecord(record);
  });
  return record;
}

// ---------------------------------------------------------------------------
// 1 / 2：领取、续租、完成与它们的反例
// ---------------------------------------------------------------------------

describe('KRN-10 队列：领取 / 续租 / 完成（落盘）', () => {
  it('正例：入队 → 领取 → 续租 → 完成，每一步都落进 Store', () => {
    const store = openStore('file');
    registerTask(store, TASK_A);
    const queue = createWorkQueue(store, { lease_ttl: 100 });

    const first = queue.enqueue({ task_id: TASK_A, at: asLogicalTime(0), description: '活一' });
    const second = queue.enqueue({ task_id: TASK_A, at: asLogicalTime(0), description: '活二' });
    expect(queue.listClaimable()).toHaveLength(2);

    const claimed = queue.claim(WORKER_1, asLogicalTime(0));
    expect(claimed.claimed).toBe(true);
    expect(claimed.claim?.request_id).toBe(first.request_id);
    expect(claimed.item?.status).toBe('processing');
    expect(claimed.item?.owner_instance_id).toBe(WORKER_1);
    expect(queue.listClaimable().map((item) => item.request_id)).toEqual([second.request_id]);

    // 续租：显式续，不是自动续。
    const renewed = queue.renew(claimed.claim!, asLogicalTime(50));
    expect(renewed.renewed).toBe(true);
    expect(renewed.lease_deadline).toBe(asLogicalTime(150));

    // 完成后条目终局、worker 释放执行槽。
    const done = queue.complete(claimed.claim!, asLogicalTime(60), ['artifact://a']);
    expect(done.completed).toBe(true);
    expect(done.item?.status).toBe('completed');

    const snapshot = store.snapshot();
    const worker = snapshot.instances.find((instance) => String(instance.instance_id) === 'W-1');
    expect(worker?.activity).toBe('idle');
    expect(worker?.active_run_id).toBeNull();
    expect(worker?.lease_deadline).toBeNull();
    const lease = snapshot.runs.find((run) => run.run_id === claimed.claim!.lease_id);
    expect(lease?.status).toBe('finished');

    // 第二个条目仍可被领取（第一条终局不影响它）。
    expect(queue.claim(WORKER_2, asLogicalTime(61)).claim?.request_id).toBe(second.request_id);
  });

  it('反例：租约过期不得续命；非持有者 / 未知租约不得完成', () => {
    const store = openStore('file');
    registerTask(store, TASK_A);
    const queue = createWorkQueue(store, { lease_ttl: 100 });
    queue.enqueue({ task_id: TASK_A, at: asLogicalTime(0) });
    const claimed = queue.claim(WORKER_1, asLogicalTime(0));
    const claim = claimed.claim!;

    // 恰好到期（区间右开：now >= deadline 即过期）⇒ 拒。
    expect(queue.renew(claim, asLogicalTime(100)).reason).toBe('lease_expired');
    // 未到期 ⇒ 允（对照：上一条不是"永远拒绝"）。
    expect(queue.renew(claim, asLogicalTime(99)).renewed).toBe(true);

    // 非持有者：换一个 worker id 去完成 ⇒ 拒（所有权校验）。
    const stolen = queue.complete({ ...claim, worker_id: WORKER_2 }, asLogicalTime(120));
    expect(stolen.completed).toBe(false);
    expect(stolen.reason).toBe('not_owner');

    // 未知租约 ⇒ 拒。
    const ghost = queue.complete(
      { ...claim, lease_id: (claim.lease_id + '-x') as typeof claim.lease_id },
      asLogicalTime(120),
    );
    expect(ghost.reason).toBe('unknown_lease');

    // 到这儿条目仍是 processing（没有任何一次非法操作把它改成终局）。
    expect(queue.listItems()[0]?.status).toBe('processing');
  });
});

// ---------------------------------------------------------------------------
// 3 / 4：崩溃恢复与它的反向对照
// ---------------------------------------------------------------------------

interface CrashOutcome {
  readonly expired: readonly string[];
  readonly continuing: readonly string[];
  readonly reclaimed: readonly string[];
  readonly withheld: readonly string[];
  readonly itemStatus: string | undefined;
  readonly claimable: number;
}

function runCrashScenario(kind: 'file' | 'memory'): CrashOutcome {
  // 第一个"进程"：入队两条，只领走第一条（租约 100）。
  const first = openStore(kind);
  const queueA = createWorkQueue(first, { lease_ttl: 100 });
  const itemOne = queueA.enqueue({ task_id: TASK_A, at: asLogicalTime(0), description: '活一' });
  queueA.enqueue({ task_id: TASK_A, at: asLogicalTime(0), description: '活二' });
  queueA.claim(WORKER_1, asLogicalTime(0));
  expect(queueA.listItems()).toHaveLength(2);

  // 崩溃 + 重启：同一条路径（新进程读同一份磁盘；易失介质则读回空）。
  const second = openStore(kind);
  const report = createWorkQueue(second, { lease_ttl: 100 }).recoverAfterCrash(asLogicalTime(500));
  const items = createWorkQueue(second, { lease_ttl: 100 }).listItems();

  return {
    expired: report.expired_lease_ids.map(String),
    continuing: report.continuing_lease_ids.map(String),
    reclaimed: report.reclaimed_request_ids.map(String),
    withheld: report.withheld_request_ids.map(String),
    itemStatus: items.find((item) => item.request_id === itemOne.request_id)?.status,
    claimable: createWorkQueue(second, { lease_ttl: 100 }).listClaimable().length,
  };
}

describe('KRN-10 崩溃恢复：过期租约作废、未过期续接', () => {
  it('反例：租约已过期 ⇒ 崩溃后作废，条目回到可领取（落盘介质）', () => {
    const outcome = runCrashScenario('file');
    expect(outcome.expired).toHaveLength(1);
    expect(outcome.continuing).toHaveLength(0);
    expect(outcome.reclaimed).toHaveLength(1);
    expect(outcome.itemStatus).toBe('pending');
    // 两条都可领取：一条被恢复回来，一条本来就没被领过。
    expect(outcome.claimable).toBe(2);
  });

  it('反向对照：同输入换**易失**介质 ⇒ 结论相反（证明上一条真的依赖落盘）', () => {
    const outcome = runCrashScenario('memory');
    // 易失：崩溃后什么都读不回来 —— 没有租约、没有条目、没有恢复。
    expect(outcome.expired).toHaveLength(0);
    expect(outcome.reclaimed).toHaveLength(0);
    expect(outcome.itemStatus).toBeUndefined();
    expect(outcome.claimable).toBe(0);
  });

  it('正例：租约未过期 ⇒ 崩溃后原样续接，条目**不被重领**', () => {
    const first = openStore('file');
    const queueA = createWorkQueue(first, { lease_ttl: 1000 });
    const item = queueA.enqueue({ task_id: TASK_A, at: asLogicalTime(0) });
    const claimed = queueA.claim(WORKER_1, asLogicalTime(0));

    const second = openStore('file');
    const queueB = createWorkQueue(second, { lease_ttl: 1000 });
    const report = queueB.recoverAfterCrash(asLogicalTime(500));

    expect(report.expired_lease_ids).toHaveLength(0);
    expect(report.continuing_lease_ids.map(String)).toEqual([String(claimed.claim!.lease_id)]);
    expect(report.reclaimed_request_ids).toHaveLength(0);
    expect(queueB.listClaimable()).toHaveLength(0);
    expect(queueB.listItems()[0]?.status).toBe('processing');
    // 未过期 ⇒ 仍可续租（不是"重启就一律作废"）。
    expect(queueB.renew(claimed.claim!, asLogicalTime(500)).renewed).toBe(true);
    void item;
  });

  it('正例：恢复报告如实带回消息 / 任务 / id 高水位，且 id 跨重启不重号', () => {
    const first = openStore('file');
    registerTask(first, TASK_A);
    const queueA = createWorkQueue(first, { lease_ttl: 100 });
    const item = queueA.enqueue({ task_id: TASK_A, at: asLogicalTime(0) });
    queueA.claim(WORKER_1, asLogicalTime(0));

    const second = openStore('file');
    const report = createWorkQueue(second, { lease_ttl: 100 }).recoverAfterCrash(asLogicalTime(500));
    expect(report.tasks.task_records).toBe(1);
    expect(report.messages.pending_delivery_events).toBe(0);
    expect(report.id_high_water['wq']).toBe(1);
    expect(report.worker_ids.map(String)).toContain('W-1');

    // 用落盘高水位续发 id：新条目不得与既有 id 重号（R202）。
    const queueB = createWorkQueue(second, {
      lease_ttl: 100,
      id_source: createIdSource({ resume: report.id_high_water }),
    });
    const fresh = queueB.enqueue({ task_id: TASK_A, at: asLogicalTime(600) });
    expect(String(fresh.request_id)).not.toBe(String(item.request_id));
    expect(String(fresh.request_id)).toBe('wq-2');
  });
});

// ---------------------------------------------------------------------------
// 5 / 6：未知副作用不盲重放 + 对照
// ---------------------------------------------------------------------------

describe('KRN-10 未知副作用：不盲重放', () => {
  it('反例：已交接 / 已提交 / 结果未知的动作禁止重放，其任务条目被扣留', () => {
    const store = openStore('file');
    registerTask(store, TASK_A);
    registerTask(store, TASK_B);

    persistAction(store, TASK_A, 'a-prepared', 'prepared');
    persistAction(store, TASK_A, 'a-handed-off', 'handed_off');
    persistAction(store, TASK_A, 'a-submitted', 'submitted');
    persistAction(store, TASK_B, 'b-result-unknown', 'submitted');
    persistAction(store, TASK_B, 'b-result-unknown-2', 'result_unknown');

    const plan = planActionRecovery(store);
    expect(plan.wired).toBe(true);
    expect(plan.blind_replay_allowed).toBe(false);
    expect(plan.requeue_action_ids).toEqual(['a-prepared']);
    expect(plan.unknown_effect_action_ids).toEqual([
      'a-handed-off',
      'a-submitted',
      'b-result-unknown',
      'b-result-unknown-2',
    ]);
    expect(plan.blocked_task_ids.map(String)).toEqual(['T-A', 'T-B']);

    // 崩溃场景：两个任务各有一个在途条目，租约过期后**不得**回到可领取。
    const queue = createWorkQueue(store, { lease_ttl: 100 });
    queue.enqueue({ task_id: TASK_A, at: asLogicalTime(0) });
    queue.enqueue({ task_id: TASK_B, at: asLogicalTime(0) });
    queue.claim(WORKER_1, asLogicalTime(0));
    queue.claim(WORKER_2, asLogicalTime(0));

    const second = openStore('file');
    const report = createWorkQueue(second, { lease_ttl: 100 }).recoverAfterCrash(asLogicalTime(500));
    expect(report.withheld_request_ids).toHaveLength(2);
    expect(report.reclaimed_request_ids).toHaveLength(0);
    expect(createWorkQueue(second, { lease_ttl: 100 }).listClaimable()).toHaveLength(0);
    expect(report.actions.blocked_task_ids.map(String)).toEqual(['T-A', 'T-B']);
  });

  it('对照：只有 prepared 动作 ⇒ 条目正常回到可领取（分类判据，而非"一律不恢复"）', () => {
    const store = openStore('file');
    registerTask(store, TASK_B);
    persistAction(store, TASK_B, 'only-prepared', 'prepared');

    const queue = createWorkQueue(store, { lease_ttl: 100 });
    queue.enqueue({ task_id: TASK_B, at: asLogicalTime(0) });
    queue.claim(WORKER_1, asLogicalTime(0));

    const second = openStore('file');
    const report = createWorkQueue(second, { lease_ttl: 100 }).recoverAfterCrash(asLogicalTime(500));
    expect(report.reclaimed_request_ids).toHaveLength(1);
    expect(report.withheld_request_ids).toHaveLength(0);
    expect(createWorkQueue(second, { lease_ttl: 100 }).listClaimable()).toHaveLength(1);
    // 同一批动作里，"可安全重排"的那一条仍被如实标出。
    expect(planActionRecovery(second).requeue_action_ids).toEqual(['only-prepared']);
  });

  it('状态分类是**封闭**的且四种处置各有归属（七态不漏）', () => {
    const store = openStore('file');
    registerTask(store, TASK_A);
    const states: readonly ActionState[] = [
      'prepared',
      'handed_off',
      'submitted',
      'result_unknown',
      'user_reported_complete',
      'confirmed_complete',
      'invalidated_or_failed',
    ];
    const actionIds = states.map((state, index) => {
      const id = `s-${String(index)}`;
      persistAction(store, TASK_A, id, state);
      return id;
    });
    const plan = planActionRecovery(store);
    const byDisposition = new Map<string, string[]>();
    for (const decision of plan.decisions) {
      const bucket = byDisposition.get(decision.disposition) ?? [];
      bucket.push(decision.action_id);
      byDisposition.set(decision.disposition, bucket);
    }
    for (const decision of plan.decisions) {
      expect(ACTION_RECOVERY_DISPOSITIONS).toContain(decision.disposition);
    }
    expect(byDisposition.get('requeue_safe')).toEqual(['s-0']);
    expect(byDisposition.get('no_replay_unknown_effect')).toEqual(['s-1', 's-2', 's-3']);
    expect(byDisposition.get('resolve_required')).toEqual(['s-4']);
    expect(byDisposition.get('terminal')).toEqual(['s-5', 's-6']);
    expect(actionIds).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// 交付语义
// ---------------------------------------------------------------------------

describe('KRN-10 交付语义：至少一次', () => {
  it('如实声明 at_least_once，并明确**不宣称**恰好一次', () => {
    const guarantee = deliveryGuarantee();
    expect(guarantee.guarantee).toBe('at_least_once');
    expect(guarantee.exactly_once_claimed).toBe(false);
    // 类型与常量层就**没有**"恰好一次"这个取值。
    expect(QUEUE_DELIVERY_SEMANTICS).toBe('at_least_once');
    expect(['at_least_once']).toContain(QUEUE_DELIVERY_SEMANTICS);
  });

  it('崩溃恢复报告自带同一条声明（不靠调用方自觉）', () => {
    const store = openStore('file');
    registerTask(store, TASK_A);
    const report = createWorkQueue(store, { lease_ttl: 100 }).recoverAfterCrash(asLogicalTime(0));
    expect(report.delivery.guarantee).toBe('at_least_once');
    expect(report.delivery.exactly_once_claimed).toBe(false);
  });

  it('描述函数如实输出条目的领取次数与租约（证据可读性）', () => {
    const store = openStore('file');
    registerTask(store, TASK_A);
    const queue = createWorkQueue(store, { lease_ttl: 100 });
    queue.enqueue({ task_id: TASK_A, at: asLogicalTime(0) });
    queue.claim(WORKER_1, asLogicalTime(0));
    const view = queue.listItems()[0]!;
    expect(view.attempts).toBe(1);
    expect(describeQueueItem(view)).toContain('尝试 1 次');
  });
});

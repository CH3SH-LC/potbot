/**
 * P4 — 工作承诺表（每项请求有明确结局与等待原因）【归属 D09】
 *
 * 冻结点标识：取自**单一来源** `tests/acceptance/freeze-identity.ts`，值在
 * `docs/other/evidence/D11/freeze-identity.json`（R24 / R32.1）。
 *
 * 对应：任务书 §7.3、§19 A05 行「等待与依赖解除」；验收规格 §5（P4 三条子路径）；
 * 合同 v1.2（R14 #3 / R17 / R19 / R22 / R26.4 + **R33 取消 / R37.4 依赖解除接入正常链路**）。
 *
 * ## 本次重写（v1.2 修复批）新增/翻转了什么
 *
 * - **F03**：子路径 1 原先由夹具自己 `planDependencyResolution()` → `tx.putWorkItem()` →
 *   `wakeOnDependencyResolved()` 代办依赖解除。现已全部移除：`r-p4-x` 由**另一个工作项**承载，
 *   轮次 2 完成它时，`finish_run` 的事务内段落自行解除对 `r-p4-01` 的等待（`waiting_dependency
 *   → processing`）并唤醒实例；夹具只投递与推进。
 * - **F01**：取消目标越权（跨任务 / 跨群 / 同任务错误接收者 / 旧版本目标）必须让**整个入口失败**，
 *   且工作项、任务控制状态、有效收件箱、调度事件**零业务变更**；合法取消仍被接受；
 *   重复同一 `message_id` 不重复写控制意图。
 * - **F02**：在途轮次遇任务取消后，`completed` / `failed` / `waiting_dependency` 等新发布**一律被拒**
 *   （拒因 `task_cancelled`），结果引用不写入、取消状态不回退；取消前的终态历史原样保留；
 *   其他任务继续正常工作；未开始的取消任务不产生有效业务执行、排队状态被正确收尾。
 * - **F05**：诊断与依赖解除按 task+revision 隔离——两任务不同版本并存时 T1 正常收尾、T2 不变；
 *   同任务旧版/当前版并存时也可收尾且旧项保留；另一任务或旧版本的 `completed` **不会**误满足当前依赖。
 *
 * 断言纪律：
 * - R17：计数/分布用**等号**；R22：先断言夹具确实产生了数据；
 * - R14 #3：依赖解除后的正确路径是 `waiting_dependency → processing`，终态由下一轮产出；
 * - R26.4：P4-12「取消优先写入任务状态」= **同一事务内同步生效**（采样点 Q4 立即可见）；
 * - P4-09 的机器判据用 D04 的 `describeWorkItemOutcome(...).violations`（不另写一套）。
 */

import { describe, expect, it } from 'vitest';

import {
  WORK_ITEM_STATUSES,
  asInstanceId,
  asLogicalTime,
  asRevision,
  createWorkItem,
  summarizeSnapshotCounters,
  type BlockerKind,
  type EventCounters,
  type InstanceId,
  type RequestId,
  type SchedulingCounters,
  type SnapshotCounters,
  type WorkItem,
  type WorkItemStatus,
} from '../../../src/protocol/index.js';
import { fingerprintOfBlockedItems, resolutionInputRefId } from '../../../src/dependency/index.js';
import {
  describeWorkItemOutcome,
  evaluateWorkItemTransition,
  findRequestsMissingWorkItem,
  findRequestsWithoutOutcome,
} from '../../../src/workledger/index.js';
import { ActivitySnapshotSampler } from '../../../src/fake/index.js';
import { writeEvidenceArtifacts } from '../freeze-identity.js';
import {
  FREEZE_1_SOURCE_DIGEST,
  GROUP_ID,
  GROUP_ID_2,
  INSTANCE_C,
  INSTANCE_C2,
  INSTANCE_D,
  R_1,
  R_3,
  R_4,
  R_X,
  REVISION,
  SENDER_S1,
  SENDER_S2,
  SENDER_S3,
  SENDER_S4,
  SENDER_S5,
  TASK_ID,
  TASK_ID_2,
  activeRunOf,
  artifactRefFor,
  budgetUsageOf,
  buildP4Harness,
  countKernelEvents,
  deliver,
  deliverCancel,
  deliverWorkRequest,
  maybeWorkItemOf,
  registerInstance,
  registerInstanceC,
  registerTask,
  registerTaskRecord,
  seedWorkItem,
  taskControlOf,
  type P4Budget,
  type P4Harness,
} from './scenario-support.js';


const P4_BUDGET: P4Budget = Object.freeze({ runs: 8, diagnoses: 4, time: 10_000 });

interface ItemRow {
  readonly request_id: string;
  readonly status: WorkItemStatus;
  readonly owner: string;
  readonly failure_reason: string | null;
  readonly blocker_kind: BlockerKind | null;
  readonly dependency_request_ids: readonly string[];
  readonly result_refs: readonly string[];
  readonly read_in_snapshot: boolean;
  readonly snapshot_run_ids: readonly string[];
}

function itemRow(item: WorkItem): ItemRow {
  return {
    request_id: String(item.request_id),
    status: item.status,
    owner: String(item.owner_instance_id),
    failure_reason: item.failure_reason,
    blocker_kind: item.blocker_reason === null ? null : item.blocker_reason.kind,
    dependency_request_ids: item.dependency_refs
      .map((ref) => ref.request_id)
      .filter((id): id is NonNullable<typeof id> => id !== undefined)
      .map(String),
    result_refs: item.result_refs.map(String),
    read_in_snapshot: item.included_in_snapshot,
    snapshot_run_ids: item.snapshot_run_ids.map(String),
  };
}

/**
 * R7 的**可执行**形式：把"关键断言的朴素写法"跑一遍，必须抛错。
 *
 * 这样"缺陷真能击穿断言"不是靠人读注释相信，而是由测试执行证明：
 * 若某条注入实际是空操作（恒真），本函数会红。
 */
function expectAssertionFails(naiveAssertion: () => void): void {
  expect(naiveAssertion).toThrow();
}

function getItem(h: P4Harness, requestId: RequestId): WorkItem {
  const item = maybeWorkItemOf(h, requestId);
  if (item === null) throw new Error(`工作承诺表里没有 ${requestId}`);
  return item;
}

/** 收件箱里全部 `work_request` 消息携带的 request_id（P4-11 的输入）。 */
function inboxWorkRequestIds(h: P4Harness): readonly RequestId[] {
  const snapshot = h.scheduler.snapshot();
  const ids: RequestId[] = [];
  for (const entry of snapshot.inbox_entries) {
    const message = snapshot.messages.find((row) => row.message_id === entry.message_id);
    if (message === undefined || message.type !== 'work_request') continue;
    if (message.request_id !== undefined) ids.push(message.request_id);
  }
  return ids;
}

interface Sub1Observation {
  readonly deliveries: readonly string[];
  readonly defect_applied: string | null;
  readonly first_run_frozen_request_ids: readonly string[];
  readonly q1_item: ItemRow;
  /** 轮次 2（完成依赖目标）之后立刻采样：**内核**是否已自动解除等待（F03 的核心证据）。 */
  readonly kernel_resolution: {
    readonly la_status: string;
    readonly dependency_resolved_events: number;
    readonly runnable: boolean;
  } | null;
  /** 消费解除输入的那一轮读入的可运行输入引用（Q5-c）。 */
  readonly resolution_run_frozen_actionable_refs: readonly string[];
  readonly q2_item: ItemRow;
  readonly finish1_accepted: boolean;
  readonly finish2_accepted: boolean;
  readonly finish3_accepted: boolean;
}

/**
 * 子路径 1：读取后转等待 → 依赖目标完成 → 内核自动解除等待 → 完成。
 *
 * **夹具不代办任何内核步骤**（指导 F03）：这里的每一步都只经投递、`start/finish` 与推进；
 * 依赖解除由 `finish_run` 的事务内段落完成。
 */
async function subPath1(
  h: P4Harness,
  options: { readonly read_completes_defect?: boolean; readonly fold_wait_defect?: boolean } = {},
): Promise<Sub1Observation> {
  const deliveries: string[] = [];
  const d1 = deliverWorkRequest(h, {
    message_id: 'm-p4-01',
    request_id: R_1,
    sender: SENDER_S1,
    content: '工作 j1：需要 jx 的结果才能继续',
  });
  deliveries.push(d1.result);
  if (d1.work_item_created !== true) {
    throw new Error('m-p4-01 应新建工作项 r-p4-01');
  }

  h.clock.advance(1, 'P4-P1');
  await h.seam.advanceOnce('P4-P1');
  const run1 = activeRunOf(h, 'P4 子路径 1 第 1 次推进');

  // 放行点 P1 的三种产出（假 Agent 脚本决策 decision ∈ {report_dependency, produce_result, ...} 的等价物）
  let publication: NonNullable<Parameters<typeof h.scheduler.finishRun>[0]['publications']>[number];
  let defectApplied: string | null = null;
  if (options.read_completes_defect === true) {
    // I-P4-1「读即完成」：轮次读入后直接置为已完成
    defectApplied = 'I-P4-1 读即完成';
    publication = { kind: 'completed', request_id: R_1, result_refs: [artifactRefFor(R_1)] };
  } else if (options.fold_wait_defect === true) {
    // I-P4-2「折叠等待态」：把等待依赖折叠进"处理中"，不登记依赖项
    defectApplied = 'I-P4-2 折叠等待态';
    publication = {
      kind: 'processing',
      request_id: R_1,
      blocker_reason: { kind: 'waiting_external', detail: '等 jx（已折叠进处理中，未登记依赖项）' },
    };
  } else {
    publication = {
      kind: 'waiting_dependency',
      request_id: R_1,
      dependency_refs: [{ request_id: R_X }],
      blocker_reason: { kind: 'waiting_dependency', detail: '需要 r-p4-x 的结果才能继续（在等 r-p4-x）' },
    };
  }
  const finish1 = h.scheduler.finishRun({ run_id: run1.run_id, publications: [publication] });

  // ── 采样点 Q1 ──
  const q1Item = itemRow(getItem(h, R_1));

  if (defectApplied !== null) {
    return {
      deliveries,
      defect_applied: defectApplied,
      first_run_frozen_request_ids: run1.frozen_request_ids.map(String),
      q1_item: q1Item,
      kernel_resolution: null,
      resolution_run_frozen_actionable_refs: [],
      q2_item: q1Item,
      finish1_accepted: finish1.accepted,
      finish2_accepted: false,
      finish3_accepted: false,
    };
  }

  // ── 放行点 P2：依赖目标工作项 r-p4-x 被投递并由另一个轮次产出结果 ──
  // 说明（F03）：`r-p4-x` 是**普通工作项**，不是"外部请求"——只有工作项的完成才会让
  // `finish_run` 的解除段落算出"依赖已满足"。夹具不再自己算计划/写库/唤醒。
  const d2 = deliverWorkRequest(h, {
    message_id: 'm-p4-02',
    request_id: R_X,
    sender: SENDER_S2,
    content: 'jx 的结果（由另一项工作产出）',
  });
  deliveries.push(d2.result);

  h.clock.advance(1, 'P4-P2');
  await h.seam.advanceOnce('P4-P2');
  const run2 = activeRunOf(h, 'P4 子路径 1 第 2 次推进');
  const finish2 = h.scheduler.finishRun({
    run_id: run2.run_id,
    publications: [{ kind: 'completed', request_id: R_X, result_refs: [artifactRefFor(R_X)] }],
  });

  // **内核自动衔接的采样点**：依赖目标一完成，等待项就该已经转回可运行（不需要夹具动手）。
  const kernelResolution = {
    la_status: String(getItem(h, R_1).status),
    dependency_resolved_events: h.scheduler
      .snapshot()
      .delivery_events.filter((event) => event.kind === 'dependency_resolved').length,
    runnable: h.scheduler.hasRunnableInput(INSTANCE_C),
  };

  h.clock.advance(1, 'P4-P3');
  await h.seam.advanceOnce('P4-P3');
  const run3 = activeRunOf(h, 'P4 子路径 1 第 3 次推进');
  const finish3 = h.scheduler.finishRun({
    run_id: run3.run_id,
    publications: [{ kind: 'completed', request_id: R_1, result_refs: [artifactRefFor(R_1)] }],
  });

  return {
    deliveries,
    defect_applied: null,
    first_run_frozen_request_ids: run1.frozen_request_ids.map(String),
    q1_item: q1Item,
    kernel_resolution: kernelResolution,
    resolution_run_frozen_actionable_refs: [...run3.frozen_actionable_input_refs],
    q2_item: itemRow(getItem(h, R_1)),
    finish1_accepted: finish1.accepted,
    finish2_accepted: finish2.accepted,
    finish3_accepted: finish3.accepted,
  };
}

interface Sub2Observation {
  readonly delivery_result: string;
  readonly defect_applied: string | null;
  readonly q3_item: ItemRow;
  readonly rejected_publications: readonly { readonly reason: string; readonly message: string }[];
  readonly finish_accepted: boolean;
}

/** 子路径 2：失败（假 Agent 报告工具失败）。 */
async function subPath2(
  h: P4Harness,
  options: { readonly silent_failure_defect?: boolean } = {},
): Promise<Sub2Observation> {
  const d3 = deliverWorkRequest(h, {
    message_id: 'm-p4-03',
    request_id: R_3,
    sender: SENDER_S3,
    content: '工作 j3：假 Agent 在本轮注入一次工具失败',
  });
  h.clock.advance(1, 'P4-P3b');
  await h.seam.advanceOnce('P4-P3b');
  const run3 = activeRunOf(h, 'P4 子路径 2 推进');

  let defectApplied: string | null = null;
  let publication: NonNullable<Parameters<typeof h.scheduler.finishRun>[0]['publications']>[number];
  if (options.silent_failure_defect === true) {
    // I-P4-3「静默失败」：失败路径置为已完成并留空结果引用
    defectApplied = 'I-P4-3 静默失败';
    publication = { kind: 'completed', request_id: R_3, result_refs: [] };
  } else {
    publication = {
      kind: 'failed',
      request_id: R_3,
      failure_reason: '工具调用失败：抓取 jx 时超时（第 3 次重试后放弃）',
      blocker_reason: { kind: 'unknown_tool_state', detail: '工具状态未知：超时未返回' },
    };
  }

  const finish = h.scheduler.finishRun({ run_id: run3.run_id, publications: [publication] });

  return {
    delivery_result: d3.result,
    defect_applied: defectApplied,
    q3_item: itemRow(getItem(h, R_3)),
    rejected_publications: finish.rejected_publications.map((row) => ({
      reason: row.ledger_reason,
      message: row.message,
    })),
    finish_accepted: finish.accepted,
  };
}

interface Sub3Observation {
  readonly delivery_results: readonly string[];
  readonly cancel_inbox_requires_wakeup: boolean | null;
  readonly q4_item_status: WorkItemStatus;
  readonly q4_control_cancelled: boolean;
  readonly q4_control_epoch: number;
  readonly q4_control_cancelled_by: string | null;
  readonly q4_same_call_visible: boolean;
  readonly q4_run_still_active: boolean;
  readonly finish_accepted: boolean;
  readonly finish_rejection_reason: string | null;
  readonly q5_item_status: WorkItemStatus;
  readonly q5_empty_advances: readonly number[];
  readonly q5_has_runnable_input: boolean;
}

/** 子路径 3：取消（§9.3 / R26.4：取消在同一事务内同步生效；F02：取消阻止后续发布）。 */
async function subPath3(h: P4Harness): Promise<Sub3Observation> {
  const d4 = deliverWorkRequest(h, {
    message_id: 'm-p4-04',
    request_id: R_4,
    sender: SENDER_S4,
    content: '工作 j4：需要一段时间才能完成',
  });
  h.clock.advance(1, 'P4-P4');
  await h.seam.advanceOnce('P4-P4');
  const run4 = activeRunOf(h, 'P4 子路径 3 推进');

  // 采样点 Q4：取消消息投递（同一事务内应同步生效）
  h.clock.advance(1, 'P4-P4-cancel');
  const d5 = deliverCancel(h, {
    message_id: 'm-p4-05',
    reply_to: R_4,
    sender: SENDER_S4,
    reason: '用户取消 r-p4-04',
  });
  // 立即读取（**不推进调度**）：R26.4 要求此时就能看到 cancelled + control state 已更新
  const afterCancel = getItem(h, R_4);
  const control = taskControlOf(h);
  const runStillActive = h.scheduler
    .snapshot()
    .runs.some((run) => run.run_id === run4.run_id && run.status === 'running');

  // 结束在途轮次。**F02 的行为翻转**：任务已取消 ⇒ 本轮的新发布（此处为空集）一律被拒，
  // 拒因 `task_cancelled`；但轮次仍然收尾（实例回 idle、排空执行槽），否则执行槽会永久泄漏。
  const finish = h.scheduler.finishRun({ run_id: run4.run_id, publications: [] });

  // 采样点 Q5：空推进若干次不得产生新轮次
  const emptyRecords = await h.seam.advanceTimes(3, 'P4-Q5');
  const afterEmpty = getItem(h, R_4);

  return {
    delivery_results: [d4.result, d5.result],
    cancel_inbox_requires_wakeup: d5.inbox_requires_wakeup,
    q4_item_status: afterCancel.status,
    q4_control_cancelled: control === null ? false : control.cancelled,
    q4_control_epoch: control === null ? -1 : control.control_epoch,
    q4_control_cancelled_by: control === null ? null : String(control.cancelled_by_message_id),
    q4_same_call_visible: afterCancel.status === 'cancelled' && control !== null && control.cancelled,
    q4_run_still_active: runStillActive,
    finish_accepted: finish.accepted,
    finish_rejection_reason: finish.rejection_reason,
    q5_item_status: afterEmpty.status,
    q5_empty_advances: emptyRecords.map((row) => row.startedRuns),
    q5_has_runnable_input: h.scheduler.hasRunnableInput(INSTANCE_C),
  };
}

interface P4FullObservation {
  readonly sub1: Sub1Observation;
  readonly sub2: Sub2Observation;
  readonly sub3: Sub3Observation;
  readonly inbox_entries: number;
  readonly inbox_work_request_ids: readonly string[];
  readonly produced_items: number;
  readonly distribution: Readonly<Record<WorkItemStatus, number>>;
  readonly items: readonly ItemRow[];
  readonly outcome_violations: readonly { readonly request_id: string; readonly kinds: readonly string[] }[];
  readonly requests_without_outcome: readonly string[];
  readonly requests_missing_work_item: readonly string[];
  readonly run_count: number;
  readonly run_started_events: number;
  readonly diagnosis_events: number;
  readonly event_counters: EventCounters;
  readonly snapshot_counters: SnapshotCounters;
  readonly merged_counters: SchedulingCounters;
  readonly budget_usage: { readonly runs: number; readonly diagnoses: number; readonly time: number };
  readonly clock_total_advanced: number;
  readonly all_owners: readonly string[];
  readonly waiting_window_active_runs: readonly number[];
  readonly waiting_window_flat: boolean;
}

/** 三条子路径顺序执行（共用同一任务与实例；每一步都有明确放行点）。 */
async function runP4Full(): Promise<P4FullObservation> {
  const h = buildP4Harness({ budget: P4_BUDGET });
  registerTask(h);
  registerInstanceC(h);
  const sampler = new ActivitySnapshotSampler();

  const sub1 = await subPath1(h);
  const sub2 = await subPath2(h);
  const sub3 = await subPath3(h);

  // 等待窗口采样（全部子路径结束后 I-C 空闲；空推进不得起新轮次）
  const windowOpen = sampler.sampleStates(h.scheduler.snapshot().instances, h.clock.now());
  const emptyRecords = await h.seam.advanceTimes(1, 'P4-waiting-window');
  const windowClose = sampler.sampleStates(h.scheduler.snapshot().instances, h.clock.now());

  h.ledger.chargeTimeFrom(h.clock);

  const snapshot = h.scheduler.snapshot();
  const eventCounters = h.scheduler.eventCounters();
  const items = snapshot.work_items;
  const requestIds = inboxWorkRequestIds(h);

  return {
    sub1,
    sub2,
    sub3,
    inbox_entries: snapshot.inbox_entries.length,
    inbox_work_request_ids: requestIds.map(String),
    produced_items: items.length,
    distribution: summarizeSnapshotCounters(snapshot).work_item_status_distribution,
    items: items.map(itemRow),
    outcome_violations: items.map((item) => ({
      request_id: String(item.request_id),
      kinds: describeWorkItemOutcome(item).violations.map((row) => row.kind),
    })),
    requests_without_outcome: findRequestsWithoutOutcome(items).map(String),
    requests_missing_work_item: findRequestsMissingWorkItem(requestIds, items).map(String),
    run_count: eventCounters.run_count,
    run_started_events: snapshot.kernel_events.filter((event) => event.kind === 'run_started').length,
    diagnosis_events: eventCounters.diagnosis_count,
    event_counters: eventCounters,
    snapshot_counters: summarizeSnapshotCounters(snapshot),
    merged_counters: h.scheduler.summarize(),
    // R34.3 / R34.5：预算用量 = 已提交事件的幂等投影（夹具不补账）
    budget_usage: budgetUsageOf(h),
    clock_total_advanced: h.clock.totalAdvanced,
    all_owners: items.map((item) => String(item.owner_instance_id)),
    waiting_window_active_runs: [windowOpen.active_runs, windowClose.active_runs],
    waiting_window_flat:
      sampler.isFlatBetween(windowOpen.index, windowClose.index) &&
      emptyRecords.every((row) => row.startedRuns === 0),
  };
}

// ---------------------------------------------------------------------------
// F01：取消目标的范围限制（合同 v1.2 R33.2–R33.4）
// ---------------------------------------------------------------------------

interface ZeroChangeRow {
  readonly label: string;
  readonly result: string;
  readonly failure_reason: string | null;
  readonly work_items_unchanged: boolean;
  readonly task_control_unchanged: boolean;
  readonly inbox_unchanged: boolean;
  readonly messages_unchanged: boolean;
  readonly events_unchanged: boolean;
  readonly delivery_events_unchanged: boolean;
  readonly runs_unchanged: boolean;
  readonly seam_deliveries_unchanged: boolean;
}

/** 投递一次**必须整个失败**的入口调用，并逐项证明"零业务变更"。 */
function attemptZeroChange(h: P4Harness, label: string, attempt: () => { result: string; failure_reason: string | null }): ZeroChangeRow {
  const before = h.scheduler.snapshot();
  const deliveriesBefore = h.seam.deliveries.length;
  const receipt = attempt();
  const after = h.scheduler.snapshot();
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  return {
    label,
    result: receipt.result,
    failure_reason: receipt.failure_reason,
    work_items_unchanged: same(after.work_items, before.work_items),
    task_control_unchanged: same(after.task_control_states, before.task_control_states),
    inbox_unchanged: same(after.inbox_entries, before.inbox_entries),
    messages_unchanged: same(after.messages, before.messages),
    events_unchanged: same(after.kernel_events, before.kernel_events),
    delivery_events_unchanged: same(after.delivery_events, before.delivery_events),
    runs_unchanged: same(after.runs, before.runs),
    seam_deliveries_unchanged: h.seam.deliveries.length === deliveriesBefore,
  };
}

interface F01Result {
  readonly cross_task: ZeroChangeRow;
  readonly cross_group: ZeroChangeRow;
  readonly wrong_recipient: ZeroChangeRow;
  readonly old_revision: ZeroChangeRow;
  readonly legal_cancel: {
    readonly result: string;
    readonly item_status: string;
    readonly control_cancelled: boolean;
    readonly control_epoch: number;
    readonly control_cancelled_by: string | null;
  };
  readonly duplicate_cancel: {
    readonly second_result: string;
    readonly epoch_after_first: number;
    readonly epoch_after_duplicate: number;
    readonly cancelled_control_events: number;
  };
}

/**
 * F01：取消目标必须**同任务 + 同群 + 接收者即负责人 + 非旧版本**，任一不中整个入口失败。
 *
 * 单夹具内顺序构造四种非法目标（每种都有独立的"零变更"快照对比）与一个合法取消。
 */
async function runF01(): Promise<F01Result> {
  const h = buildP4Harness({ budget: P4_BUDGET });
  registerTask(h); // T1 / G1 / r1
  registerTaskRecord(h, { task_id: TASK_ID_2, group_id: GROUP_ID_2, revision: asRevision(1) });
  registerInstanceC(h);
  registerInstance(h, { instance_id: INSTANCE_C2, group_id: GROUP_ID });
  registerInstance(h, { instance_id: INSTANCE_D, group_id: GROUP_ID_2 });

  // ① 跨任务目标：先在 T2/G2 里**经正常入口**造出一项属于 T2 的工作
  const t2Delivery = deliver(h, {
    message_id: 'm-f01-t2',
    type: 'work_request',
    sender: SENDER_S5,
    recipient: INSTANCE_D,
    request_id: 'r-f01-t2' as RequestId,
    content: '工作：属于 T2 的另一项工作',
    task_id: TASK_ID_2,
    group_id: GROUP_ID_2,
  });
  expect(t2Delivery.result).toBe('accepted');
  // ② 跨群目标：T1 的工作，但负责人属于 G2（初始状态预置，见 `seedWorkItem` 的说明）
  seedWorkItem(h, {
    request_id: 'r-f01-cross-group' as RequestId,
    task_id: TASK_ID,
    task_revision: REVISION,
    owner_instance_id: INSTANCE_D,
    status: 'pending',
  });
  // ③ 同任务错误接收者：T1 的工作，负责人是 C，但取消消息发给 C2
  seedWorkItem(h, {
    request_id: 'r-f01-wrong-recipient' as RequestId,
    task_id: TASK_ID,
    task_revision: REVISION,
    owner_instance_id: INSTANCE_C,
    status: 'pending',
  });
  // ④ 旧版本目标：任务当前是 r1，目标项停在 r0
  seedWorkItem(h, {
    request_id: 'r-f01-old-revision' as RequestId,
    task_id: TASK_ID,
    task_revision: asRevision(0),
    owner_instance_id: INSTANCE_C,
    status: 'pending',
  });

  const crossTask = attemptZeroChange(h, '跨任务', () =>
    deliver(h, {
      message_id: 'm-f01-1',
      type: 'cancel',
      sender: SENDER_S1,
      reply_to: 'r-f01-t2' as RequestId,
      content: '取消 T2 的工作（越权）',
    }),
  );
  const crossGroup = attemptZeroChange(h, '跨群', () =>
    deliver(h, {
      message_id: 'm-f01-2',
      type: 'cancel',
      sender: SENDER_S1,
      reply_to: 'r-f01-cross-group' as RequestId,
      content: '取消 G2 里的工作（越权）',
    }),
  );
  const wrongRecipient = attemptZeroChange(h, '同任务错误接收者', () =>
    deliver(h, {
      message_id: 'm-f01-3',
      type: 'cancel',
      sender: SENDER_S1,
      recipient: INSTANCE_C2,
      reply_to: 'r-f01-wrong-recipient' as RequestId,
      content: '取消不是自己负责的工作（越权）',
    }),
  );
  const oldRevision = attemptZeroChange(h, '旧版本目标', () =>
    deliver(h, {
      message_id: 'm-f01-4',
      type: 'cancel',
      sender: SENDER_S1,
      reply_to: 'r-f01-old-revision' as RequestId,
      content: '取消旧版本的工作（越权）',
    }),
  );

  // 合法取消：当前任务 + 当前版本 + 接收者即负责人
  const legalDelivery = deliverWorkRequest(h, {
    message_id: 'm-f01-ok',
    request_id: 'r-f01-ok' as RequestId,
    sender: SENDER_S1,
    content: '工作：稍后由合法取消终止',
  });
  expect(legalDelivery.result).toBe('accepted');
  const legalCancelReceipt = deliverCancel(h, {
    message_id: 'm-f01-ok-cancel',
    reply_to: 'r-f01-ok' as RequestId,
    sender: SENDER_S1,
    reason: '用户取消 r-f01-ok',
  });
  const controlAfterLegal = taskControlOf(h);
  const legalCancel = {
    result: legalCancelReceipt.result,
    item_status: String(getItem(h, 'r-f01-ok' as RequestId).status),
    control_cancelled: controlAfterLegal === null ? false : controlAfterLegal.cancelled,
    control_epoch: controlAfterLegal === null ? -1 : controlAfterLegal.control_epoch,
    control_cancelled_by:
      controlAfterLegal === null ? null : String(controlAfterLegal.cancelled_by_message_id),
  };

  // 重复同一 message_id：不得重复写控制意图
  const epochAfterFirst = legalCancel.control_epoch;
  const duplicate = deliverCancel(h, {
    message_id: 'm-f01-ok-cancel',
    reply_to: 'r-f01-ok' as RequestId,
    sender: SENDER_S1,
    reason: '用户取消 r-f01-ok',
  });
  const controlAfterDuplicate = taskControlOf(h);

  return {
    cross_task: crossTask,
    cross_group: crossGroup,
    wrong_recipient: wrongRecipient,
    old_revision: oldRevision,
    legal_cancel: legalCancel,
    duplicate_cancel: {
      second_result: duplicate.result,
      epoch_after_first: epochAfterFirst,
      epoch_after_duplicate: controlAfterDuplicate === null ? -1 : controlAfterDuplicate.control_epoch,
      cancelled_control_events: countKernelEvents(h, 'task_control_state_updated'),
    },
  };
}

// ---------------------------------------------------------------------------
// F02：取消阻止在途轮次发布（合同 v1.2 R33.5 / R33.6）
// ---------------------------------------------------------------------------

type PublicationKind = 'completed' | 'failed' | 'waiting_dependency';

interface F02RejectionResult {
  readonly kind: PublicationKind;
  readonly pre_cancel_item_status: string;
  readonly pre_cancel_result_refs: readonly string[];
  readonly finish_accepted: boolean;
  readonly rejection_reason: string | null;
  readonly applied_request_ids: readonly string[];
  readonly item_status_after: string;
  readonly item_result_refs: readonly string[];
  readonly item_failure_reason: string | null;
  readonly item_dependency_refs: readonly string[];
  readonly pre_cancel_inflight_item_status: string;
  readonly control_cancelled: boolean;
  readonly control_epoch_before: number;
  readonly control_epoch_after: number;
  readonly control_cancel_reason: string | null;
  readonly rejected_events_with_task_cancelled: number;
  readonly run_status: string;
  readonly instance_idle: boolean;
  readonly other_task_finish_accepted: boolean;
  readonly other_task_item_status: string;
  /** 反作弊（F03 反向约束）：取消任务不得因别的任务收尾而被"假解除"或唤醒。 */
  readonly dependency_resolved_events_total: number;
  readonly cancelled_owner_runnable_after_other_task: boolean;
}

function publicationOf(kind: PublicationKind, requestId: RequestId) {
  switch (kind) {
    case 'completed':
      return { kind, request_id: requestId, result_refs: [artifactRefFor(requestId)] } as const;
    case 'failed':
      return {
        kind,
        request_id: requestId,
        failure_reason: '工具失败：取消后的发布不得落地',
        blocker_reason: { kind: 'unknown_tool_state' as const, detail: '工具状态未知' },
      } as const;
    case 'waiting_dependency':
      return {
        kind,
        request_id: requestId,
        dependency_refs: [{ request_id: R_X }],
        blocker_reason: { kind: 'waiting_dependency' as const, detail: '等待 r-p4-x' },
      } as const;
  }
}

/**
 * 跑一次「取消前的终态历史保持原样 → 在途轮次遇取消 → 新发布被拒 → 其他任务继续工作」。
 *
 * 每次用 `kind` 决定在途轮次要发布什么结局；三种都必须被同一拒因拦住。
 */
async function runF02Rejection(kind: PublicationKind): Promise<F02RejectionResult> {
  const h = buildP4Harness({ budget: P4_BUDGET });
  registerTask(h);
  registerTaskRecord(h, { task_id: TASK_ID_2, group_id: GROUP_ID_2, revision: asRevision(1) });
  registerInstanceC(h);
  registerInstance(h, { instance_id: INSTANCE_D, group_id: GROUP_ID_2 });

  const beforeRequest = 'r-f02-done' as RequestId;
  const inFlightRequest = 'r-f02-inflight' as RequestId;

  // 取消**之前**的终态历史：先正常完成一项
  deliverWorkRequest(h, {
    message_id: 'm-f02-1',
    request_id: beforeRequest,
    sender: SENDER_S1,
    content: '工作：取消前已正常完成',
  });
  h.clock.advance(1, 'F02-R1');
  await h.seam.advanceOnce('F02-R1');
  const run1 = activeRunOf(h, 'F02 第 1 次推进');
  const finishBefore = h.scheduler.finishRun({
    run_id: run1.run_id,
    publications: [
      { kind: 'completed', request_id: beforeRequest, result_refs: [artifactRefFor(beforeRequest)] },
    ],
  });
  if (finishBefore.accepted !== true) {
    throw new Error(`取消前的完成发布应被接受，实际 ${String(finishBefore.rejection_reason)}`);
  }
  const beforeItem = getItem(h, beforeRequest);

  // 在途轮次
  deliverWorkRequest(h, {
    message_id: 'm-f02-2',
    request_id: inFlightRequest,
    sender: SENDER_S1,
    content: '工作：在途时将被任务级取消',
  });
  h.clock.advance(1, 'F02-R2');
  await h.seam.advanceOnce('F02-R2');
  const run2 = activeRunOf(h, 'F02 第 2 次推进');
  const preCancelItem = itemRow(getItem(h, inFlightRequest));

  // 任务级取消（无 reply_to / request_id ⇒ 只置任务控制状态）
  h.clock.advance(1, 'F02-R2-cancel');
  const cancelReceipt = deliver(h, {
    message_id: 'm-f02-cancel',
    type: 'cancel',
    sender: SENDER_S1,
    content: '用户取消整个任务',
    payload: { reason: '用户取消整个任务（在途轮次的发布一律拒绝）' },
  });
  if (cancelReceipt.result !== 'accepted') {
    throw new Error(`任务级取消应被接受，实际 ${cancelReceipt.result}`);
  }
  const controlBefore = taskControlOf(h);
  const epochBefore = controlBefore === null ? -1 : controlBefore.control_epoch;

  const finish = h.scheduler.finishRun({
    run_id: run2.run_id,
    publications: [publicationOf(kind, inFlightRequest)],
  });

  const afterItem = getItem(h, inFlightRequest);
  const controlAfter = taskControlOf(h);
  const runStatus =
    h.scheduler.snapshot().runs.find((run) => run.run_id === run2.run_id)?.status ?? 'missing';
  const instanceState = h.scheduler.snapshot().instances.find((row) => row.instance_id === INSTANCE_C);

  // 其他任务继续正常工作（T2 / G2 的实例 D）
  deliver(h, {
    message_id: 'm-f02-other',
    type: 'work_request',
    sender: SENDER_S5,
    recipient: INSTANCE_D,
    request_id: 'r-f02-other' as RequestId,
    content: 'T2 的工作：不受 T1 取消影响',
    task_id: TASK_ID_2,
    group_id: GROUP_ID_2,
  });
  h.clock.advance(1, 'F02-other');
  await h.seam.advanceOnce('F02-other');
  const otherRun = activeRunOf(h, 'F02 其他任务');
  const otherFinish = h.scheduler.finishRun({
    run_id: otherRun.run_id,
    publications: [
      {
        kind: 'completed',
        request_id: 'r-f02-other' as RequestId,
        result_refs: [artifactRefFor('r-f02-other' as RequestId)],
      },
    ],
  });

  return {
    kind,
    pre_cancel_item_status: String(beforeItem.status),
    pre_cancel_result_refs: beforeItem.result_refs.map(String),
    finish_accepted: finish.accepted,
    rejection_reason: finish.rejection_reason,
    applied_request_ids: finish.applied_request_ids.map(String),
    item_status_after: String(afterItem.status),
    item_result_refs: afterItem.result_refs.map(String),
    item_failure_reason: afterItem.failure_reason,
    item_dependency_refs: afterItem.dependency_refs.map((ref) => String(ref.request_id)),
    pre_cancel_inflight_item_status: preCancelItem.status,
    control_cancelled: controlAfter === null ? false : controlAfter.cancelled,
    control_epoch_before: epochBefore,
    control_epoch_after: controlAfter === null ? -1 : controlAfter.control_epoch,
    control_cancel_reason: controlAfter === null ? null : controlAfter.cancel_reason,
    rejected_events_with_task_cancelled: h.scheduler
      .snapshot()
      .kernel_events.filter(
        (event) => event.kind === 'publication_rejected' && event.rejection_reason === 'task_cancelled',
      ).length,
    run_status: runStatus,
    instance_idle: instanceState?.activity === 'idle' && instanceState.active_run_id === null,
    other_task_finish_accepted: otherFinish.accepted,
    other_task_item_status: String(getItem(h, 'r-f02-other' as RequestId).status),
    dependency_resolved_events_total: h.scheduler
      .snapshot()
      .delivery_events.filter((event) => event.kind === 'dependency_resolved').length,
    cancelled_owner_runnable_after_other_task: h.scheduler.hasRunnableInput(INSTANCE_C),
  };
}

interface F02NotStartedResult {
  readonly cancel_result: string;
  readonly control_cancelled: boolean;
  readonly advance_started: number;
  readonly advance_detail: string | null;
  readonly run_count: number;
  readonly item_status: string;
  readonly item_read_in_snapshot: boolean;
  readonly read_receipts_for_instance: number;
  readonly queued_flag_after: boolean;
  readonly runnable_input_after: boolean;
  readonly queue_cleared_events: number;
}

/**
 * F02 的"未开始"分支（R33.6）：任务取消后，尚未开始的轮次不得启动；
 * 不写已读、不认领工作、不消费输入，**但排队标记要被正确收尾（清除）**。
 */
async function runF02NotStarted(): Promise<F02NotStartedResult> {
  const h = buildP4Harness({ budget: P4_BUDGET });
  registerTask(h);
  registerInstanceC(h);

  deliverWorkRequest(h, {
    message_id: 'm-f02-ns1',
    request_id: 'r-f02-ns' as RequestId,
    sender: SENDER_S1,
    content: '工作：在开始之前任务就被取消',
  });
  const cancelReceipt = deliver(h, {
    message_id: 'm-f02-ns2',
    type: 'cancel',
    sender: SENDER_S1,
    content: '用户取消整个任务（尚未开始任何轮次）',
  });

  const control = taskControlOf(h);
  const queuedBefore = h.scheduler
    .snapshot()
    .instances.find((row) => row.instance_id === INSTANCE_C)?.queued_flag;

  h.clock.advance(1, 'F02-NS');
  const step = await h.seam.advanceOnce('F02-NS');

  const instance = h.scheduler.snapshot().instances.find((row) => row.instance_id === INSTANCE_C);
  const item = getItem(h, 'r-f02-ns' as RequestId);
  return {
    cancel_result: cancelReceipt.result,
    control_cancelled: control === null ? false : control.cancelled,
    advance_started: step.startedRuns,
    advance_detail: step.detail ?? null,
    run_count: h.scheduler.eventCounters().run_count,
    item_status: String(item.status),
    item_read_in_snapshot: item.included_in_snapshot,
    read_receipts_for_instance: h.scheduler
      .snapshot()
      .read_receipts.filter((row) => row.instance_id === INSTANCE_C).length,
    queued_flag_after: instance?.queued_flag ?? true,
    runnable_input_after: h.scheduler.hasRunnableInput(INSTANCE_C),
    queue_cleared_events: countKernelEvents(h, 'delegation_queue_cleared'),
  };
}

// ---------------------------------------------------------------------------
// F05：诊断与依赖解除按 task + revision 隔离（合同 v1.2 R37.2 / R37.4）
// ---------------------------------------------------------------------------

interface CrossTaskIsolationResult {
  readonly finish_accepted: boolean;
  readonly t1_item_status: string;
  readonly t2_item_status_before: string;
  readonly t2_item_status_after: string;
  readonly t2_item_revision: number;
  readonly run_count: number;
  /** 反空跑证据：把**整库**工作项送进指纹（旧实现的做法）确实会因跨版本而抛错。 */
  readonly whole_store_fingerprint_throws: boolean;
}

/**
 * F05-1：T1(r1) 与 T2(r2) 各有一个**非终态阻塞项**并存 —— T1 必须能正常收尾，T2 状态不变。
 *
 * 修复前：诊断把整库工作项送进去，阻塞项跨任务版本 ⇒ `FingerprintError` ⇒
 * 整个 `finish_run` 事务回滚，run 永远停在 running。
 */
async function runF05CrossTaskIsolation(): Promise<CrossTaskIsolationResult> {
  const h = buildP4Harness({ budget: P4_BUDGET });
  registerTask(h); // T1 / G1 / r1
  registerTaskRecord(h, { task_id: TASK_ID_2, group_id: GROUP_ID_2, revision: asRevision(2) });
  registerInstanceC(h);
  registerInstance(h, { instance_id: INSTANCE_D, group_id: GROUP_ID_2 });

  // T1 当前版本的阻塞项（在 scope 内）
  seedWorkItem(h, {
    request_id: 'r-f05-t1-blocked' as RequestId,
    task_id: TASK_ID,
    task_revision: REVISION,
    owner_instance_id: INSTANCE_C,
    status: 'waiting_dependency',
    dependency_refs: [{ request_id: 'r-f05-external' as RequestId }],
    blocker_reason: { kind: 'waiting_dependency', detail: '等待尚未产出的依赖' },
  });
  // T2 另一版本的阻塞项（**必须在诊断中被排除**，否则指纹跨版本抛错）
  seedWorkItem(h, {
    request_id: 'r-f05-t2-blocked' as RequestId,
    task_id: TASK_ID_2,
    task_revision: asRevision(2),
    owner_instance_id: INSTANCE_D,
    status: 'waiting_dependency',
    dependency_refs: [{ request_id: 'r-f05-external-2' as RequestId }],
    blocker_reason: { kind: 'waiting_dependency', detail: '另一任务的等待' },
  });

  deliverWorkRequest(h, {
    message_id: 'm-f05-1',
    request_id: 'r-f05-trigger' as RequestId,
    sender: SENDER_S1,
    content: '工作：T1 的正常收尾触发点',
  });
  h.clock.advance(1, 'F05-R1');
  await h.seam.advanceOnce('F05-R1');
  const run1 = activeRunOf(h, 'F05 跨任务隔离');
  const finish = h.scheduler.finishRun({
    run_id: run1.run_id,
    publications: [
      {
        kind: 'completed',
        request_id: 'r-f05-trigger' as RequestId,
        result_refs: [artifactRefFor('r-f05-trigger' as RequestId)],
      },
    ],
  });

  const t2Item = getItem(h, 'r-f05-t2-blocked' as RequestId);
  return {
    finish_accepted: finish.accepted,
    t1_item_status: String(getItem(h, 'r-f05-trigger' as RequestId).status),
    t2_item_status_before: 'waiting_dependency',
    t2_item_status_after: String(t2Item.status),
    t2_item_revision: Number(t2Item.task_revision),
    run_count: h.scheduler.eventCounters().run_count,
    whole_store_fingerprint_throws: fingerprintThrowsOnWholeStore(h),
  };
}

/** 反空跑：**整库**阻塞指纹是否因跨任务版本而抛错（旧实现的失败模式）。 */
function fingerprintThrowsOnWholeStore(h: P4Harness): boolean {
  try {
    fingerprintOfBlockedItems(h.scheduler.snapshot().work_items);
    return false;
  } catch {
    return true;
  }
}

interface OldRevisionIsolationResult {
  readonly finish_accepted: boolean;
  readonly old_item_status_after: string;
  readonly old_item_revision: number;
  readonly current_item_status: string;
  /** 反空跑证据：整库指纹确实会因"同任务旧版 + 当前版"而抛错。 */
  readonly whole_store_fingerprint_throws: boolean;
}

/**
 * F05-2：**同一任务**的旧版本项与当前版本项并存 —— 当前版本可以正常收尾，旧项原样保留。
 */
async function runF05OldRevisionIsolation(): Promise<OldRevisionIsolationResult> {
  const h = buildP4Harness({ budget: P4_BUDGET });
  registerTaskRecord(h, { task_id: TASK_ID, group_id: GROUP_ID, revision: asRevision(2) });
  registerInstanceC(h);

  seedWorkItem(h, {
    request_id: 'r-f05-old-rev1' as RequestId,
    task_id: TASK_ID,
    task_revision: asRevision(1),
    owner_instance_id: INSTANCE_C,
    status: 'waiting_dependency',
    dependency_refs: [{ request_id: 'r-f05-old-dep' as RequestId }],
    blocker_reason: { kind: 'waiting_dependency', detail: '旧版本的历史等待项' },
  });
  seedWorkItem(h, {
    request_id: 'r-f05-cur-rev2' as RequestId,
    task_id: TASK_ID,
    task_revision: asRevision(2),
    owner_instance_id: INSTANCE_C,
    status: 'waiting_dependency',
    dependency_refs: [{ request_id: 'r-f05-cur-dep' as RequestId }],
    blocker_reason: { kind: 'waiting_dependency', detail: '当前版本的等待项' },
  });

  deliver(h, {
    message_id: 'm-f05-2',
    type: 'work_request',
    sender: SENDER_S1,
    request_id: 'r-f05-cur-trigger' as RequestId,
    task_revision: asRevision(2),
    content: '工作：当前版本（r2）的正常收尾触发点',
  });
  h.clock.advance(1, 'F05-R2');
  await h.seam.advanceOnce('F05-R2');
  const run = activeRunOf(h, 'F05 旧版本隔离');
  const finish = h.scheduler.finishRun({
    run_id: run.run_id,
    publications: [
      {
        kind: 'completed',
        request_id: 'r-f05-cur-trigger' as RequestId,
        result_refs: [artifactRefFor('r-f05-cur-trigger' as RequestId)],
      },
    ],
  });

  const oldItem = getItem(h, 'r-f05-old-rev1' as RequestId);
  return {
    finish_accepted: finish.accepted,
    old_item_status_after: String(oldItem.status),
    old_item_revision: Number(oldItem.task_revision),
    current_item_status: String(getItem(h, 'r-f05-cur-trigger' as RequestId).status),
    whole_store_fingerprint_throws: fingerprintThrowsOnWholeStore(h),
  };
}

interface FalseSatisfactionResult {
  readonly out_of_scope: {
    readonly finish_accepted: boolean;
    readonly waiting_status_after: string;
  };
  readonly in_scope: {
    readonly finish_accepted: boolean;
    readonly waiting_status_after: string;
    readonly dependency_resolved_events: number;
  };
}

/**
 * F05-3：**另一任务的 `completed` 不得误满足当前任务的依赖**；
 * 同任务同版本的 `completed` 才可以（正向对照）。
 */
async function runF05FalseSatisfaction(): Promise<FalseSatisfactionResult> {
  const outOfScope = await (async () => {
    const h = buildP4Harness({ budget: P4_BUDGET });
    registerTask(h); // T1 / G1 / r1
    registerTaskRecord(h, { task_id: TASK_ID_2, group_id: GROUP_ID_2, revision: REVISION });
    registerInstanceC(h);
    registerInstance(h, { instance_id: INSTANCE_D, group_id: GROUP_ID_2 });

    // 依赖目标存在、且已 completed —— 但它属于**另一个任务**
    seedWorkItem(h, {
      request_id: 'r-f05-dep' as RequestId,
      task_id: TASK_ID_2,
      task_revision: REVISION,
      owner_instance_id: INSTANCE_D,
      status: 'completed',
      result_refs: [artifactRefFor('r-f05-dep' as RequestId)],
    });
    seedWorkItem(h, {
      request_id: 'r-f05-waiter' as RequestId,
      task_id: TASK_ID,
      task_revision: REVISION,
      owner_instance_id: INSTANCE_C,
      status: 'waiting_dependency',
      dependency_refs: [{ request_id: 'r-f05-dep' as RequestId }],
      blocker_reason: { kind: 'waiting_dependency', detail: '等待 r-f05-dep 的结果' },
    });

    deliverWorkRequest(h, {
      message_id: 'm-f05-3',
      request_id: 'r-f05-trigger-3' as RequestId,
      sender: SENDER_S1,
      content: '工作：T1 的收尾触发点',
    });
    h.clock.advance(1, 'F05-R3');
    await h.seam.advanceOnce('F05-R3');
    const run = activeRunOf(h, 'F05 误满足检查（跨任务）');
    const finish = h.scheduler.finishRun({
      run_id: run.run_id,
      publications: [
        {
          kind: 'completed',
          request_id: 'r-f05-trigger-3' as RequestId,
          result_refs: [artifactRefFor('r-f05-trigger-3' as RequestId)],
        },
      ],
    });
    return {
      finish_accepted: finish.accepted,
      waiting_status_after: String(getItem(h, 'r-f05-waiter' as RequestId).status),
    };
  })();

  const inScope = await (async () => {
    const h = buildP4Harness({ budget: P4_BUDGET });
    registerTask(h);
    registerInstanceC(h);
    registerInstance(h, { instance_id: INSTANCE_C2, group_id: GROUP_ID });

    // 正向对照：依赖目标与本项**同任务同版本**，且已 completed ⇒ 必须被解除
    seedWorkItem(h, {
      request_id: 'r-f05-dep-ok' as RequestId,
      task_id: TASK_ID,
      task_revision: REVISION,
      owner_instance_id: INSTANCE_C2,
      status: 'completed',
      result_refs: [artifactRefFor('r-f05-dep-ok' as RequestId)],
    });
    seedWorkItem(h, {
      request_id: 'r-f05-waiter-ok' as RequestId,
      task_id: TASK_ID,
      task_revision: REVISION,
      owner_instance_id: INSTANCE_C,
      status: 'waiting_dependency',
      dependency_refs: [{ request_id: 'r-f05-dep-ok' as RequestId }],
      blocker_reason: { kind: 'waiting_dependency', detail: '等待 r-f05-dep-ok 的结果' },
    });

    deliverWorkRequest(h, {
      message_id: 'm-f05-4',
      request_id: 'r-f05-trigger-4' as RequestId,
      sender: SENDER_S1,
      content: '工作：T1 的收尾触发点（正向对照）',
    });
    h.clock.advance(1, 'F05-R4');
    await h.seam.advanceOnce('F05-R4');
    const run = activeRunOf(h, 'F05 正向对照');
    const finish = h.scheduler.finishRun({
      run_id: run.run_id,
      publications: [
        {
          kind: 'completed',
          request_id: 'r-f05-trigger-4' as RequestId,
          result_refs: [artifactRefFor('r-f05-trigger-4' as RequestId)],
        },
      ],
    });
    return {
      finish_accepted: finish.accepted,
      waiting_status_after: String(getItem(h, 'r-f05-waiter-ok' as RequestId).status),
      dependency_resolved_events: h.scheduler
        .snapshot()
        .delivery_events.filter((event) => event.kind === 'dependency_resolved').length,
    };
  })();

  return { out_of_scope: outOfScope, in_scope: inScope };
}

const observations: Record<string, unknown> = {};

describe('P4 — 工作承诺表：明确结局与等待原因（D09）', () => {
  it('P4-01…12 主场景：读取后转等待 → 依赖目标完成 → 内核自动解除 → 完成；失败与取消各走一条路径', async () => {
    const obs = await runP4Full();
    observations.p4_main = obs;

    // ── R22：先证明夹具确实产生了数据 ──
    expect(obs.inbox_entries).toBe(5); // 5 条消息全部可靠入箱（含被取消的 m-p4-05）
    expect(obs.inbox_work_request_ids).toEqual(['r-p4-01', 'r-p4-x', 'r-p4-03', 'r-p4-04']);
    expect(obs.produced_items).toBe(4); // 四个工作请求各一项工作
    expect(obs.sub1.deliveries).toEqual(['accepted', 'accepted']);
    expect(obs.sub2.delivery_result).toBe('accepted');
    expect(obs.sub3.delivery_results).toEqual(['accepted', 'accepted']);

    // ── P4-01（主判据，反作弊）：「已读」不等于「完成」 ──
    expect(obs.sub1.first_run_frozen_request_ids).toEqual(['r-p4-01']); // 已被某轮读取
    expect(obs.sub1.q1_item.read_in_snapshot).toBe(true);
    expect(obs.sub1.q1_item.snapshot_run_ids.length).toBeGreaterThan(0);
    expect(obs.sub1.q1_item.status).not.toBe('completed');

    // ── P4-02（主判据）：等待原因可指认到具体等待对象 ──
    expect(obs.sub1.q1_item.status).toBe('waiting_dependency');
    expect(obs.sub1.q1_item.dependency_request_ids).toEqual(['r-p4-x']);
    expect(obs.sub1.q1_item.blocker_kind).toBe('waiting_dependency');
    expect(obs.sub1.q1_item.failure_reason).toBeNull();

    // ── **F03（本次重写的核心证据）**：依赖目标由**另一个轮次**完成后，
    //    内核在 `finish_run` 的事务内自行把等待项转回可运行并发出解除通知；
    //    夹具**没有**调用 planDependencyResolution / putWorkItem / wakeOnDependencyResolved。──
    expect(obs.sub1.kernel_resolution?.la_status).toBe('processing');
    expect(obs.sub1.kernel_resolution?.dependency_resolved_events).toBe(1);
    expect(obs.sub1.kernel_resolution?.runnable).toBe(true);

    // ── P4-05（主判据）：依赖结果到达后（Q2）在有限轮次内推进到「已完成」，且带结果引用 ──
    expect(obs.sub1.q2_item.status).toBe('completed');
    expect(obs.sub1.q2_item.result_refs).toEqual(['r-p4-01#result']);
    expect(obs.sub1.finish1_accepted).toBe(true);
    expect(obs.sub1.finish2_accepted).toBe(true);
    expect(obs.sub1.finish3_accepted).toBe(true);
    // Q5-c / R14 #3：依赖解除产生的是"新的可运行输入"（不是新消息入箱），
    // 且正确路径是 waiting_dependency → processing，终态由下一轮产出。
    // 该输入的身份含 task + revision + 解除对象（R37.3）。
    expect(obs.sub1.resolution_run_frozen_actionable_refs).toEqual([
      resolutionInputRefId({
        task_id: TASK_ID,
        task_revision: REVISION,
        request_id: R_1,
        resolved_dependency_ids: [`req:${String(R_X)}`],
      }),
    ]);

    // ── P4-10（主判据，反作弊）：结果引用与工作项自身 request_id 一致 ──
    // 内核在**转换入口**用 `CompletionEvidence.request_id` 强制（D04 R14-8：ArtifactRef 无结构，
    // 无法从已存项反推，故本轮能保证的是"声明的 request_id 与工作项一致"）。
    expect(obs.sub1.q2_item.result_refs).toEqual(['r-p4-01#result']);
    const completionGuard = evaluateWorkItemTransition({
      item: workItemSeedOk(R_3, 'processing'),
      to: 'completed',
      at: asLogicalTime(1),
      origin: { kind: 'kernel' },
      completion: { request_id: R_1, result_refs: [artifactRefFor(R_1)] },
    });
    expect(completionGuard.ok).toBe(false);
    expect(completionGuard.rejection?.reason).toBe('result_request_mismatch');

    // ── P4-06（主判据）：失败路径结局为「失败」并带可指认原因；不停留在处理中、也不静默完成 ──
    expect(obs.sub2.q3_item.status).toBe('failed');
    expect((obs.sub2.q3_item.failure_reason ?? '').length).toBeGreaterThan(0);
    expect(obs.sub2.q3_item.blocker_kind).toBe('unknown_tool_state');
    expect(obs.sub2.finish_accepted).toBe(true);
    expect(obs.sub2.rejected_publications).toEqual([]);

    // ── P4-07（主判据）：取消路径结局为「取消」 ──
    expect(obs.sub3.q4_item_status).toBe('cancelled');

    // ── **翻转的旧断言（F02 / 合同 R33.5）**：旧实现在任务已取消后仍把在途轮次的收尾
    //    当作 `accepted === true`。新口径是：取消后本轮的新发布**一律被拒**（拒因
    //    `task_cancelled`），结果引用不写入；轮次仍收尾以释放执行槽。
    //    该断言描述的是 F02 修复前的行为，现已翻转。 ──
    expect(obs.sub3.finish_accepted).toBe(false);
    expect(obs.sub3.finish_rejection_reason).toBe('task_cancelled');

    // ── P4-12（主判据，R26.4）：取消优先写入任务状态 —— **同一事务内同步生效** ──
    // 采样点 Q4（on_message 返回后立即读，未推进调度）：已是 cancelled + control state 已更新
    expect(obs.sub3.q4_same_call_visible).toBe(true);
    expect(obs.sub3.q4_control_cancelled).toBe(true);
    expect(obs.sub3.q4_control_cancelled_by).toBe('m-p4-05');
    expect(obs.sub3.q4_control_epoch).toBe(1);
    // Q4-c：不强行中止在途轮次（取消靠"拒绝新发布"与 stale 规则生效，而不是打断轮次）
    expect(obs.sub3.q4_run_still_active).toBe(true);
    // 取消的收件箱条目是**安静条目**（§9.3：不靠"普通群消息排队"生效）
    expect(obs.sub3.cancel_inbox_requires_wakeup).toBe(false);

    // ── P4-08（主判据，反作弊）：取消后不再为 r-p4-04 产生新的可运行输入 ──
    expect(obs.sub3.q5_empty_advances).toEqual([0, 0, 0]);
    expect(obs.sub3.q5_item_status).toBe('cancelled');
    expect(obs.sub3.q5_has_runnable_input).toBe(false);

    // ── P4-09（主判据，守恒）：不存在"既无结局也无原因"的项 ──
    expect(obs.requests_without_outcome).toEqual([]);
    expect(obs.outcome_violations).toEqual([
      { request_id: 'r-p4-01', kinds: [] },
      { request_id: 'r-p4-x', kinds: [] },
      { request_id: 'r-p4-03', kinds: [] },
      { request_id: 'r-p4-04', kinds: [] },
    ]);

    // ── P4-03（主判据）：每项工作都有负责人（被解析到的实例标识），不得为空 ──
    expect(obs.all_owners).toEqual(['C', 'C', 'C', 'C']);
    expect(obs.all_owners.every((owner) => owner.length > 0)).toBe(true);

    // ── P4-04（主判据）：状态取值 ∈ 六态枚举，不得出现枚举外取值 ──
    expect(obs.items.map((row) => row.status).every((status) => WORK_ITEM_STATUSES.includes(status))).toBe(true);
    expect(Object.keys(obs.distribution).sort()).toEqual([...WORK_ITEM_STATUSES].sort());
    // 等号分布（R17）：2 完成 + 1 失败 + 1 取消，其余 0；且 Σ = 4（R22）
    expect(obs.distribution).toEqual({
      pending: 0,
      processing: 0,
      waiting_dependency: 0,
      completed: 2,
      failed: 1,
      cancelled: 1,
    });
    expect(Object.values(obs.distribution).reduce((a, b) => a + b, 0)).toBe(obs.produced_items);

    // ── P4-11（主判据，守恒）：不存在"读过但未登记"的工作请求 ──
    expect(obs.inbox_work_request_ids).toHaveLength(4);
    expect(obs.requests_missing_work_item).toEqual([]);

    // ── 观测（R19 两组来源 + R34.3/R34.5 的三个预算维度）──
    expect(obs.run_count).toBe(5); // 等待 + 完成依赖目标 + 完成 + 失败 + 取消前那一轮
    // R17：计数断言同时证明事件流含预期事件种类
    expect(obs.run_started_events).toBe(obs.run_count);
    expect(obs.event_counters.inbox_message_count).toBe(5);
    expect(obs.diagnosis_events).toBe(0); // 本场景无停滞/死锁报告
    // R34.3 / R34.5：账目 = 已提交事件的幂等投影（夹具不补账）⇒ 台账口径 = 观测口径
    expect(obs.budget_usage.runs).toBe(5);
    expect(obs.budget_usage.runs).toBe(obs.run_count);
    expect(obs.budget_usage.time).toBe(obs.clock_total_advanced);
    expect(obs.merged_counters.work_item_status_distribution.completed).toBe(2);
    // 等待窗口内 I-C 的活动轮次 = 0
    expect(obs.waiting_window_active_runs).toEqual([0, 0]);
    expect(obs.waiting_window_flat).toBe(true);
  });

  it('F01：取消目标越权（跨任务/跨群/错误接收者/旧版本）⇒ 整个入口失败且零业务变更', async () => {
    const obs = await runF01();
    observations.p4_f01 = obs;

    // ── 四种非法目标：入口返回 `failed`，且工作项 / 任务控制状态 / 有效收件箱 / 消息 /
    //    调度事件 / 轮次 **逐项零变更**（事务回滚，不留任何业务痕迹）──
    for (const row of [obs.cross_task, obs.cross_group, obs.wrong_recipient, obs.old_revision]) {
      expect(`${row.label}:${row.result}`).toBe(`${row.label}:failed`);
      expect(row.failure_reason ?? '').not.toBe('');
      expect(row.work_items_unchanged).toBe(true);
      expect(row.task_control_unchanged).toBe(true);
      expect(row.inbox_unchanged).toBe(true);
      expect(row.messages_unchanged).toBe(true);
      expect(row.events_unchanged).toBe(true);
      expect(row.delivery_events_unchanged).toBe(true);
      expect(row.runs_unchanged).toBe(true);
      expect(row.seam_deliveries_unchanged).toBe(true);
    }

    // 拒因可读（取证）
    expect(obs.cross_task.failure_reason).toContain('取消不得跨任务');
    expect(obs.cross_group.failure_reason).toContain('取消不得跨群');
    expect(obs.wrong_recipient.failure_reason).toContain('不是目标工作项');
    expect(obs.old_revision.failure_reason).toContain('旧任务版本');

    // ── 合法取消仍被接受 ──
    expect(obs.legal_cancel.result).toBe('accepted');
    expect(obs.legal_cancel.item_status).toBe('cancelled');
    expect(obs.legal_cancel.control_cancelled).toBe(true);
    expect(obs.legal_cancel.control_cancelled_by).toBe('m-f01-ok-cancel');
    expect(obs.legal_cancel.control_epoch).toBe(1);

    // ── 重复同一 message_id：不重复写控制意图 ──
    expect(obs.duplicate_cancel.second_result).toBe('duplicate_not_created');
    expect(obs.duplicate_cancel.epoch_after_first).toBe(1);
    expect(obs.duplicate_cancel.epoch_after_duplicate).toBe(1);
    // 控制状态事件恰一次（合法取消那次）；重复投递不得再写一条
    expect(obs.duplicate_cancel.cancelled_control_events).toBe(1);
  });

  it('F02：在途轮次遇任务取消 ⇒ completed/failed/waiting_dependency 发布全被拒（task_cancelled）', async () => {
    const kinds: readonly PublicationKind[] = ['completed', 'failed', 'waiting_dependency'];
    const results: Record<string, F02RejectionResult> = {};
    for (const kind of kinds) {
      results[kind] = await runF02Rejection(kind);
    }
    observations.p4_f02 = results;

    for (const kind of kinds) {
      const row = results[kind];
      if (row === undefined) throw new Error(`缺少 ${kind} 的结果`);
      // 取消前的终态历史保持原样（未被取消/未被改写）
      expect(row.pre_cancel_item_status).toBe('completed');
      expect(row.pre_cancel_result_refs).toEqual(['r-f02-done#result']);

      // 新发布被拒，拒因 = task_cancelled，结果引用不写入
      expect(`${kind}:${String(row.finish_accepted)}`).toBe(`${kind}:false`);
      expect(row.rejection_reason).toBe('task_cancelled');
      expect(row.applied_request_ids).toEqual([]);
      expect(row.item_status_after).toBe('processing'); // 既没完成也没失败，等待原因也没被改写
      expect(row.item_result_refs).toEqual([]);
      expect(row.item_failure_reason).toBeNull();
      expect(row.item_dependency_refs).toEqual([]);
      expect(row.rejected_events_with_task_cancelled).toBe(1);

      // 取消状态不回退
      expect(row.control_cancelled).toBe(true);
      expect(row.control_epoch_after).toBe(row.control_epoch_before);
      expect(row.control_cancel_reason ?? '').toContain('取消整个任务');

      // 轮次仍然收尾（否则执行槽永久泄漏），实例回 idle
      expect(row.run_status).toBe('finished');
      expect(row.instance_idle).toBe(true);

      // 其他任务继续正常工作
      expect(row.other_task_finish_accepted).toBe(true);
      expect(row.other_task_item_status).toBe('completed');

      // 取消任务不会被别的任务收尾连带"假解除"/唤醒
      expect(row.dependency_resolved_events_total).toBe(0);
      expect(row.cancelled_owner_runnable_after_other_task).toBe(false);
    }
  });

  it('F02（未开始分支 / R33.6）：取消后不得启动新轮次；不写已读、不认领、不消费，排队标记被收尾', async () => {
    const obs = await runF02NotStarted();
    observations.p4_f02_not_started = obs;

    expect(obs.cancel_result).toBe('accepted');
    expect(obs.control_cancelled).toBe(true);

    // 推进被拒（拒因 task_cancelled），一轮都没起来
    expect(obs.advance_started).toBe(0);
    expect(obs.advance_detail ?? '').toContain('task_cancelled');
    expect(obs.run_count).toBe(0);

    // 不产生有效业务执行、不消费输入
    expect(obs.item_status).toBe('pending');
    expect(obs.item_read_in_snapshot).toBe(false);
    expect(obs.read_receipts_for_instance).toBe(0);
    expect(obs.runnable_input_after).toBe(true); // 输入仍在（未被消费）

    // 排队状态被正确收尾（清除），而不是"为了不残留排队标记而继续跑一轮"
    expect(obs.queued_flag_after).toBe(false);
    expect(obs.queue_cleared_events).toBeGreaterThan(0);
  });

  it('F05：诊断按 task+revision 隔离 —— 跨任务清理不误伤，旧版本项保留', async () => {
    const crossTask = await runF05CrossTaskIsolation();
    const oldRevision = await runF05OldRevisionIsolation();
    const falseSatisfaction = await runF05FalseSatisfaction();
    observations.p4_f05 = { crossTask, oldRevision, falseSatisfaction };

    // 跨任务：T1 正常收尾，T2 的项状态与版本**不变**
    expect(crossTask.finish_accepted).toBe(true);
    expect(crossTask.t1_item_status).toBe('completed');
    expect(crossTask.t2_item_status_before).toBe('waiting_dependency');
    expect(crossTask.t2_item_status_after).toBe('waiting_dependency');
    expect(crossTask.t2_item_revision).toBe(2);
    // 反空跑：本场景**确实**含有"跨任务版本并存"的阻塞项——整库指纹会抛错，
    // 因此 T1 能收尾只可能来自作用域限定（而不是碰巧没有跨版本项）。
    expect(crossTask.whole_store_fingerprint_throws).toBe(true);

    // 同任务旧版/当前版并存：可收尾，旧项保留
    expect(oldRevision.finish_accepted).toBe(true);
    expect(oldRevision.current_item_status).toBe('completed');
    expect(oldRevision.old_item_status_after).toBe('waiting_dependency');
    expect(oldRevision.old_item_revision).toBe(1);
    expect(oldRevision.whole_store_fingerprint_throws).toBe(true);

    // 另一任务的 completed 不会误满足当前依赖；同任务同版本的 completed 才会
    expect(falseSatisfaction.out_of_scope.finish_accepted).toBe(true);
    expect(falseSatisfaction.out_of_scope.waiting_status_after).toBe('waiting_dependency');
    expect(falseSatisfaction.in_scope.finish_accepted).toBe(true);
    expect(falseSatisfaction.in_scope.waiting_status_after).toBe('processing');
    expect(falseSatisfaction.in_scope.dependency_resolved_events).toBe(1);
  });

  it('受控缺陷注入（R7）：I-P4-1/2/3/4 各击穿一条关键断言', async () => {
    const injection: Record<string, unknown> = {};

    // ── I-P4-1「读即完成」：轮次读入后直接置为已完成 ⇒ P4-01 失效 ──
    const h1 = buildP4Harness({ budget: P4_BUDGET });
    registerTask(h1);
    registerInstanceC(h1);
    const defect1 = await subPath1(h1, { read_completes_defect: true });
    const holdsReadNotDone = (row: ItemRow): boolean => row.status !== 'completed';
    expect(holdsReadNotDone(defect1.q1_item)).toBe(false); // ← 缺陷下 P4-01 的断言失败
    expect(defect1.q1_item.status).toBe('completed');
    expectAssertionFails(() => expect(holdsReadNotDone(defect1.q1_item)).toBe(true));
    injection['I-P4-1'] = {
      injection: '轮次读入消息后直接发布 completed（读即完成）',
      broken_assertion: 'P4-01：Q1 时 r-p4-01 已被读取但状态**不是**已完成',
      correct_value: 'waiting_dependency（非 completed）',
      defective_value: defect1.q1_item.status,
      assertion_fails_under_defect: true,
    };

    // ── I-P4-2「折叠等待态」：把等待依赖折叠进"处理中"，不记录依赖项 ⇒ P4-02 失效 ──
    const h2 = buildP4Harness({ budget: P4_BUDGET });
    registerTask(h2);
    registerInstanceC(h2);
    const defect2 = await subPath1(h2, { fold_wait_defect: true });
    const waitReasonAttributable = (row: ItemRow): boolean =>
      row.status === 'waiting_dependency' && row.dependency_request_ids.length > 0;
    expect(waitReasonAttributable(defect2.q1_item)).toBe(false); // ← 缺陷下 P4-02 的断言失败
    expect(defect2.q1_item.status).toBe('processing');
    expectAssertionFails(() => expect(waitReasonAttributable(defect2.q1_item)).toBe(true));
    expect(defect2.q1_item.dependency_request_ids).toEqual([]);
    injection['I-P4-2'] = {
      injection: '把「等待依赖」折叠进 processing（发布 processing + waiting_external，不登记依赖项）',
      broken_assertion: 'P4-02：等待原因可指认到具体等待对象（dependency_refs 非空）',
      correct_value: 'waiting_dependency + [r-p4-x]',
      defective_value: 'processing + []',
      assertion_fails_under_defect: true,
    };

    // ── I-P4-3「静默失败」：失败路径置为已完成并留空结果引用 ⇒ P4-06 失效 ──
    const h3 = buildP4Harness({ budget: P4_BUDGET });
    registerTask(h3);
    registerInstanceC(h3);
    const defect3 = await subPath2(h3, { silent_failure_defect: true });
    const failurePathTerminal = (row: ItemRow): boolean => row.status === 'failed';
    expect(failurePathTerminal(defect3.q3_item)).toBe(false); // ← 缺陷下 P4-06 的断言失败
    expect(defect3.q3_item.status).toBe('processing'); // 空结果引用的 completed 被转换入口拒绝
    expectAssertionFails(() => expect(failurePathTerminal(defect3.q3_item)).toBe(true));
    expect(defect3.rejected_publications[0]?.reason).toBe('missing_result_ref');
    injection['I-P4-3'] = {
      injection: '失败路径发布 completed 且 result_refs=[]（静默失败 + 空结果引用）',
      broken_assertion: 'P4-06：失败路径结局为「失败」并带可指认原因（不得静默置为完成 / 停在处理中）',
      correct_value: 'failed',
      defective_value: defect3.q3_item.status,
      detected_by: `转换入口拒因 ${String(defect3.rejected_publications[0]?.reason)}`,
      assertion_fails_under_defect: true,
    };

    // ── I-P4-3b：张冠李戴的「完成声明」⇒ P4-10 的转换入口守卫可见 ──
    // 说明：经 `finish_run` 的路径上，`CompletionEvidence.request_id` 取自 `publication.request_id`，
    // 结构性恒等于工作项自身 ⇒ 该守卫在场景路径上不可达。故此处直接经转换入口取证。
    const mismatched = evaluateWorkItemTransition({
      item: workItemSeedOk(R_3, 'processing'),
      to: 'completed',
      at: asLogicalTime(1),
      origin: { kind: 'kernel' },
      completion: { request_id: R_1, result_refs: [artifactRefFor(R_1)] },
    });
    expect(mismatched.ok).toBe(false);
    expect(mismatched.rejection?.reason).toBe('result_request_mismatch');
    expectAssertionFails(() => expect(mismatched.ok).toBe(true));
    injection['I-P4-3b'] = {
      injection: '完成声明里 request_id 与工作项不一致（答复的是 r-p4-01，却要完成 r-p4-03）',
      broken_assertion: 'P4-10：结果引用的 request_id 必须与工作项自身一致（不得张冠李戴）',
      rejected_reason: mismatched.rejection?.reason ?? null,
      reachable_via_finish_run: false,
      note: 'ArtifactRef 是无结构品牌化字符串 ⇒ 引用**文字内容**与请求的对应关系本轮无法反推（D04 R14-8）',
      assertion_fails_under_defect: true,
    };

    // ── I-P4-4「无主工作项」：创建工作时不解析负责人 ⇒ P4-03 失效 ──
    // 取证一（这是本次验收的一处**如实发现**）：经 D01 的公开边界**无法**注入空实例标识
    // —— `asInstanceId('')` 在构造期即抛 RangeError。故该缺陷不能经正常路径注入，
    //      P4-03 的保证有一半由 D01 的名义化类型提供。
    let emptyIdRejected = false;
    try {
      asInstanceId('');
    } catch (error) {
      emptyIdRejected = error instanceof RangeError;
    }
    expect(emptyIdRejected).toBe(true);

    // 取证二：D04 的结局完整性判据对"损坏记录"仍可检出（仅隔离夹具内用强制造型绕过 D01 的边界）
    const ownerless = createWorkItem({
      request_id: R_3,
      owner_instance_id: '' as unknown as InstanceId,
      created_at: asLogicalTime(0),
      task_id: 'T1' as never,
      description: '无主工作项（受控缺陷素材）',
      status: 'pending',
      blocker_reason: { kind: 'other', detail: '已受理：等待运行轮次处理' },
    });
    const ownerViolations = describeWorkItemOutcome(ownerless).violations.map((row) => row.kind);
    const holdsOwner = (violations: readonly string[]): boolean => !violations.includes('missing_owner');
    expect(holdsOwner(ownerViolations)).toBe(false); // ← 缺陷下 P4-03 的断言失败
    expectAssertionFails(() => expect(holdsOwner(ownerViolations)).toBe(true));
    injection['I-P4-4'] = {
      injection: '构造 owner_instance_id 为空的工作项（不解析负责人）',
      broken_assertion: 'P4-03：每项工作都有负责人，不得为空',
      violated_kinds: ownerViolations,
      correct_value: '(无 missing_owner 违例)',
      defective_value: 'missing_owner',
      injectable_via_public_api: false,
      note: 'D01 的 `asInstanceId("")` 在构造期抛 RangeError ⇒ 经公开路径不可能造出无主工作项；' +
        'D04 的 `missing_owner` 违例在此意义上属防御性判据',
      assertion_fails_under_defect: true,
    };

    injection['falsifiability_executed'] = {
      method: 'expectAssertionFails(朴素断言)：把关键断言的"正确写法"在缺陷配置下执行，必须抛错',
      covered: ['I-P4-1', 'I-P4-2', 'I-P4-3', 'I-P4-3b', 'I-P4-4'],
      all_threw: true,
    };
    observations.p4_injections = injection;
  });

  it('落盘 D09 的 P4 证据 JSON（确定性：无时间戳、无随机）', () => {
    const payload = {
      schema: 'd09-p4-observation.v1',
      owner: 'D09',
      // R38.4 / F11 + G04/G05：身份戳**经复算**，且由发布器在**同一次计算**里填入
      // （见 `writeEvidenceArtifacts`）——复算与登记冻结点不符时写出
      // frozen:false / id:'DEV-UNFROZEN'，产物落 `.dev-evidence/`，不触碰正式证据目录。
      freeze: null as unknown,
      contract_versions: [
        '接口合同-冻结v1',
        '接口合同-冻结v1.1',
        '接口合同-冻结v1.2（修复批）',
        '接口合同-冻结v1.3（G01-G05修复批）',
      ],
      design_points: ['design-01-P4'],
      budget_registration: {
        limits: P4_BUDGET,
        note: 'P4 场景同样执行前登记预算（停滞检查点在 finish_run 收尾运行）',
      },
      r19_observability_sources: {
        event_side: 'summarizeKernelEvents(scheduler.kernelEvents())',
        snapshot_side: 'summarizeSnapshotCounters(只读快照)',
        merged: 'mergeSchedulingCounters（scheduler.summarize()）',
      },
      r26_4_cancel_priority: {
        strength: '同一事务内同步生效（比"下一次工作轮次之前"更强）',
        sampling_point: 'Q4 = on_message 返回后立即读快照，未推进调度',
        asserted: [
          'item.status === cancelled',
          'TaskControlState.cancelled === true',
          'cancelled_by_message_id === m-p4-05',
          '在途轮次的新发布被拒（task_cancelled），轮次仍收尾释放执行槽（F02）',
        ],
      },
      r37_4_dependency_resolution: {
        path: 'waiting_dependency → processing（由 finish_run 事务内段落自动落地；夹具不代办）',
        evidence: 'Q5-c 的可运行输入出现在下一轮的 frozen_actionable_input_refs（身份含 task + revision + 解除对象）',
      },
      scenarios: observations,
    };
    // R46.1：落盘目录由**身份**决定（frozen ⇒ docs/other/evidence/{freeze_id}/，
    // 否则 .dev-evidence/{freeze_id}/）；目录与身份在**同一次计算**里确定。
    const outcome = writeEvidenceArtifacts((identity) => [
      {
        file_name: 'p4-observation.json',
        content: `${JSON.stringify({ ...payload, freeze: identity }, null, 2)}\n`,
      },
    ]);
    expect(outcome.written).toHaveLength(1);
    expect(payload.scenarios.p4_main).toBeDefined();
  });
});

/** 造一个形状合法的工作项（受控缺陷注入的取证素材；不落库）。 */
function workItemSeedOk(requestId: RequestId, status: WorkItemStatus): WorkItem {
  return createWorkItem({
    request_id: requestId,
    owner_instance_id: INSTANCE_C,
    created_at: asLogicalTime(0),
    task_id: 'T1' as never,
    description: '注入取证素材',
    status,
    blocker_reason: { kind: 'other', detail: '处理中：已由运行轮次认领' },
  });
}

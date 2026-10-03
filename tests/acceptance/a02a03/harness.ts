/**
 * A02 / A03 验收夹具（归属 **D07**；合同 R10 / R17 / R19 / R20 / R21 / R22 / R26）。
 *
 * ## 这个文件是什么 / 不是什么
 *
 * - **是**：把 D01（协议 + 存储）、D02（收件箱/去重）、D03（调度内核）、D06（可控时钟 + 驱动器）
 *   按 `SchedulerAdvanceSeam` 接缝**只经公开接口**装配起来的验收夹具；
 * - **不是**：任何被测逻辑的复制品。夹具**不模拟内核**（不写工作项状态、不置排队标记、
 *   不启动轮次）——那些一律经被测代码走（验收规格 0.2 / 0.3）。
 *
 * ## 时序纪律（guide:98 / 验收规格 0.5）
 *
 * 全部时序由「**屏障 / 可控时钟 / 明确事件序列**」构成：
 * - 夹具持有调度推进权（`SchedulerAdvanceSeam`，R10）——投递**绝不**触发推进；
 * - 并发投递用 `Barrier`（B-deliver）表达「同一逻辑步同时起跑」；
 * - 轮内阻塞点用 `BlockPoint`（携带 `run_id`，A03 的归属证据）；
 * - 延迟用 `LogicalClock`（虚拟时间）。**本文件不含任何真实 sleep / 定时器。**
 *
 * ## 三个缺陷注入器（R7，仅隔离配置）
 *
 * `injectDuplicateRunStarted` / `injectUnauthorizedQueueEnqueue` / `injectReadEqualsDone`
 * 各自**只在一个被显式标记的测试用例里**生效，用来证明关键断言**真会失败**。
 * 它们不修改 `src/**`（冻结点纪律 R24.4），但**如实声明**：前两个是**构造事件流里的
 * 病态观测量**（D06 的 `reproducibility.test.ts` 用过同一手法），第三个是经公开存储接口
 * **绕过状态机**写入病态工作项（同 R25.2 的口径）。三者的注入内容与击穿断言在证据里逐条标明。
 */

import {
  WORK_ITEM_STATUSES,
  asRunId,
  createGroupMember,
  createIdSource,
  createKernelEvent,
  createTaskRecord,
  createWorkItem,
  mergeSchedulingCounters,
  summarizeKernelEvents,
  summarizeSnapshotCounters,
  type EventCounters,
  type EventIdSource,
  type GroupId,
  type InboxEntry,
  type InstanceId,
  type InstanceState,
  type KernelEvent,
  type KernelEventKind,
  type LogicalTime,
  type MessageId,
  type MessageType,
  type RequestId,
  type Revision,
  type RunRecord,
  type SchedulingCounters,
  type SnapshotCounters,
  type Store,
  type StoreSnapshot,
  type TaskId,
  type WorkItem,
  type WorkItemStatus,
} from '../../../src/protocol/index.js';
import { createMemoryStore } from '../../../src/storage/index.js';
import {
  createScheduler,
  type FinishRunOutcome,
  type RunPublication,
  type Scheduler,
  type StagnationOptions,
} from '../../../src/scheduler/index.js';
import { LogicalClock } from '../../../src/clock/index.js';
import {
  BASELINE_GROUP_ID,
  BASELINE_INSTANCE_C,
  BASELINE_SENDER_IDS,
  BASELINE_TASK_ID,
  BASELINE_TASK_REVISION,
  DeliveryLog,
  FakeAgentScript,
  SchedulerAdvanceSeam,
  ConservationViolationError,
  artifactRefFor,
  createDeliveryRequest,
  createScenarioBaseline,
  findCompletedWithoutResult,
  instanceId,
  makeDeliveryReceipt,
  messageId,
  requestId,
  type DeliveryLogSnapshot,
  type DeliveryReceipt,
  type DeliveryRequest,
} from '../../../src/fake/index.js';
import type { AdvanceRecord } from '../../../src/fake/index.js';
import { freezePointEvidence, writeEvidenceArtifacts } from '../freeze-identity.js';

/**
 * 冻结点标识（D11 收尾：**单一来源**，本文件不再硬编码）。
 *
 * 值来自 `tests/acceptance/freeze-identity.ts` 的 `freezePointEvidence()`，其背后的
 * 记录在 `docs/other/evidence/D11/freeze-identity.json`。原先把 FREEZE-1 的摘要硬编码
 * 在本文件里，导致 D03 修复之后重跑生成的证据**自称 FREEZE-1、实际被测的是 FREEZE-2 源码**
 * （D10 复核发现；R24「更早冻结点记录不能替代当前集成结果」）。
 *
 * 保留旧导出名只是为了不动本目录外的既有引用；取值一律来自单一来源。
 */
const FREEZE_POINT = freezePointEvidence();

/** 全量（src + tests）源码树摘要——全部证据必须引用它（R24 / guide:111）。 */
export const FREEZE_1_SOURCE_TREE_DIGEST = FREEZE_POINT.source_tree_sha256;

/** 该冻结点的人读证据文档。 */
export const FREEZE_1_EVIDENCE_FILE = FREEZE_POINT.file;

/** 场景基线（验收规格 0.2）。 */
export const T1: TaskId = BASELINE_TASK_ID;
export const G1: GroupId = BASELINE_GROUP_ID;
export const C: InstanceId = BASELINE_INSTANCE_C;
export const REVISION: Revision = BASELINE_TASK_REVISION;
export const SENDERS = BASELINE_SENDER_IDS;

/**
 * 标准发送成员（合同 v1.2 R35.5；修复 F07）。
 *
 * 入口默认鉴权器的第 4 项判据要求发送者是**本群已登记成员**。这些身份登记进**独立的成员表**
 * （`putGroupMember`），**不是** `putInstance`——成员资格不参与调度判定，把它写成实例会让
 * `instances` 计数与调度观测凭空多出若干项（见 `src/protocol/membership.ts`）。
 * A03 的场景另用 `S0` 作触发者，故一并登记。
 */
export const STANDARD_MEMBER_IDS: readonly InstanceId[] = Object.freeze([
  instanceId('S0'),
  ...SENDERS,
]);

/** 场景固定调度顺序（执行前登记，Q8-c；本批为确定性顺序，无随机种子）。 */
export const FIXED_SCHEDULE = 'deterministic:instances-in-insertion-order;advance-explicit-only';

/**
 * 落一份 JSON 证据（验收规格 0.7：证据只存 JSON / JSONL）。
 *
 * **身份与落盘目录同一处决定**（G05 / R46.1）：本函数**不再自选目录**，一律经
 * `writeEvidenceArtifacts()`——
 * - 复算与登记冻结点（含 R45.1 的配置摘要）匹配 ⇒ `frozen: true`，写
 *   `docs/other/evidence/{登记冻结点}/`；
 * - **不匹配 ⇒ `frozen: false` / `id: 'DEV-UNFROZEN'`**，写 `.dev-evidence/{登记冻结点}/`，
 *   **不触碰** `docs/other/evidence/**`（R46.3 / R46.4）。
 *
 * 为什么必须这样：夹具若直接抄登记记录的旧摘要、或自己写死 `D07/` 目录，源码 / 配置改动后
 * 仍会写出"自称通过"的旧身份证据并覆盖已冻结产物——那正是 F11 与 G05 要消灭的失效模式。
 */
export function writeEvidence(fileName: string, payload: Record<string, unknown>): string {
  const outcome = writeEvidenceArtifacts((identity) => [
    {
      file_name: fileName,
      content: `${JSON.stringify(
        {
          schema: 'd07-acceptance-evidence.v1',
          task: 'D07',
          freeze_point: {
            file: FREEZE_1_EVIDENCE_FILE,
            source_tree_sha256: FREEZE_1_SOURCE_TREE_DIGEST,
          },
          identity,
          schedule: FIXED_SCHEDULE,
          ...payload,
        },
        null,
        2,
      )}\n`,
    },
  ]);
  const written = outcome.written[0];
  if (written === undefined) {
    throw new Error('证据落盘回执缺失（D07 写入器脚本错误）');
  }
  return written.absolute_path;
}

// ---------------------------------------------------------------------------
// 投递脚本
// ---------------------------------------------------------------------------

export interface DeliverySpec {
  readonly message_id: string;
  readonly request_id?: string;
  readonly sender: string;
  readonly recipient?: string;
  readonly type?: MessageType;
  readonly content: string;
  readonly requires_wakeup?: boolean;
  readonly at?: LogicalTime;
  /** 覆盖消息声明的任务版本（F09 的"旧版本消息"构造；省略时取场景版本）。 */
  readonly revision?: Revision;
}

/** 一次调度推进的取证记录。 */
export interface FinishRecord {
  readonly run_id: string;
  readonly accepted: boolean;
  readonly applied_request_ids: readonly RequestId[];
  readonly rejected_request_ids: readonly RequestId[];
  readonly queued_next_run: boolean;
  readonly note?: string;
}

/** 投递步骤记录（观测字段表「每条投递后」的 message_id / request_id / 返回值）。 */
export interface DeliveryStep {
  readonly index: number;
  readonly label: string;
  readonly message_id: MessageId;
  readonly request_id: RequestId | null;
  readonly result: string;
  readonly step: LogicalTime;
  readonly advance_seq: number;
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/**
 * A02 / A03 共用夹具。
 *
 * 装配（D03 报告给出的接线，一行不改）：
 * ```ts
 * const seam = new SchedulerAdvanceSeam(clock);
 * const scheduler = createScheduler(store, {
 *   clock: () => clock.now(),
 *   onDeliveryCommitted: (note) => seam.noteDeliveryCommit({ ...note, label: note.result }),
 *   default_task_id: T1,
 * });
 * seam.bind(() => scheduler.advanceOnce());   // 一个决策点 = 至多启动一个轮次
 * ```
 */
export class ScenarioHarness {
  readonly clock: LogicalClock;
  readonly store: Store;
  readonly scheduler: Scheduler;
  readonly seam: SchedulerAdvanceSeam;
  readonly log = new DeliveryLog();
  readonly delivery_steps: DeliveryStep[] = [];
  readonly finishes: FinishRecord[] = [];
  /** 场景内推进的逻辑步（步号是证据里唯一的"时刻"，绝不用墙钟）。 */
  readonly marks: { readonly label: string; readonly step: LogicalTime }[] = [];

  readonly task_id: TaskId;
  readonly group_id: GroupId;
  readonly instance_id: InstanceId;
  readonly revision: Revision;

  readonly #injectionIds: EventIdSource = createIdSource({ seed: 'inject' });

  constructor(options: { instance_id?: InstanceId; stagnation?: StagnationOptions } = {}) {
    this.task_id = T1;
    this.group_id = G1;
    this.instance_id = options.instance_id ?? C;
    this.revision = REVISION;

    this.clock = new LogicalClock();
    this.store = createMemoryStore({ clock: () => this.clock.now() });
    // 验收规格 0.2 的基线：C 空闲、无活动轮次、无排队标记、收件箱空、工作承诺表空。
    const baseline = createScenarioBaseline({ at: this.clock.now(), instance_c_id: this.instance_id });
    // 另把 TaskRecord 注册进存储：`resolveTaskId()` 的路径 3 与 `validateRouting()` 的版本判定都需要它。
    this.store.transact((tx) => {
      tx.putInstance(baseline.instance_c);
      tx.putTask(
        createTaskRecord({
          task_id: baseline.task_id,
          goal: 'D07 验收场景：多成员请求空闲实例 / 运行中连续唤醒',
          current_group_id: baseline.group_id,
          revision: baseline.task_revision,
          created_at: this.clock.now(),
          updated_at: this.clock.now(),
        }),
      );
      // R35.5：注册标准发送成员（入口鉴权的第 4 项判据读它）。
      for (const member of STANDARD_MEMBER_IDS) {
        tx.putGroupMember(
          createGroupMember({
            group_id: baseline.group_id,
            instance_id: member,
            registered_at: this.clock.now(),
          }),
        );
      }
    });

    this.seam = new SchedulerAdvanceSeam(this.clock);
    this.scheduler = createScheduler(this.store, {
      idSource: createIdSource(),
      clock: () => this.clock.now(),
      default_task_id: this.task_id,
      ...(options.stagnation === undefined ? {} : { stagnation: options.stagnation }),
      onDeliveryCommitted: (note) => {
        // 投递**只登记、不推进**（D06 的结构性保证，A02 的前提）。
        this.seam.noteDeliveryCommit({ ...note, label: note.result });
      },
    });
    this.seam.bind(() => this.scheduler.advanceOnce());
  }

  // --- 前置状态（夹具脚本用；不代办内核步骤） ---------------------------------

  /** R35.5：登记一个合法发送成员（成员表独立于 `instances`，只被入口鉴权读取）。 */
  registerMember(memberId: InstanceId, groupId: GroupId = this.group_id): void {
    this.store.transact((tx) => {
      tx.putGroupMember(
        createGroupMember({ group_id: groupId, instance_id: memberId, registered_at: this.clock.now() }),
      );
    });
  }

  /**
   * 夹具前置：改写已注册任务的版本（F09 的"当前版本"构造）。
   *
   * 这是**前置状态**而非内核步骤：只写 `TaskRecord`，不碰收件箱 / 工作项 / 轮次。
   */
  setTaskRevision(revision: Revision): void {
    this.store.transact((tx) => {
      const existing = tx.getTask(this.task_id);
      if (existing === undefined) {
        throw new Error(`任务 ${this.task_id} 未注册，无法改写版本（夹具脚本错误）`);
      }
      tx.putTask(createTaskRecord({ ...existing, revision, updated_at: this.clock.now() }));
    });
  }

  // --- 只读观测（断言只能经快照 / 事件流，不窥探内核内部内存） ---------------------

  snapshot(): StoreSnapshot {
    return this.scheduler.snapshot();
  }

  kernelEvents(): readonly KernelEvent[] {
    return this.snapshot().kernel_events;
  }

  countEvents(kind: KernelEventKind): number {
    return this.kernelEvents().filter((event) => event.kind === kind).length;
  }

  /**
   * **R19 的两组来源**：事件侧 6 项（`summarizeKernelEvents`）与快照侧 2 项
   * （`summarizeSnapshotCounters`）分别产出、再合并。缺任一组即观测不完整。
   */
  observe(): {
    readonly event: EventCounters;
    readonly snapshot: SnapshotCounters;
    readonly merged: SchedulingCounters;
    readonly event_source: string;
    readonly snapshot_source: string;
  } {
    const snapshot = this.store.snapshot();
    const event = summarizeKernelEvents(snapshot.kernel_events);
    const snapshotCounters = summarizeSnapshotCounters(snapshot);
    return {
      event,
      snapshot: snapshotCounters,
      merged: mergeSchedulingCounters(event, snapshotCounters),
      event_source: 'summarizeKernelEvents(store.snapshot().kernel_events)',
      snapshot_source: 'summarizeSnapshotCounters(store.snapshot())',
    };
  }

  instance(): InstanceState {
    const found = this.snapshot().instances.find((i) => i.instance_id === this.instance_id);
    if (found === undefined) throw new Error(`实例 ${this.instance_id} 未注册`);
    return found;
  }

  runs(): readonly RunRecord[] {
    return this.snapshot().runs;
  }

  activeRun(): RunRecord | null {
    const active = this.instance().active_run_id;
    if (active === null) return null;
    return this.snapshot().runs.find((run) => run.run_id === active) ?? null;
  }

  inboxEntries(): readonly InboxEntry[] {
    return this.snapshot().inbox_entries.filter((entry) => entry.instance_id === this.instance_id);
  }

  uniqueInboxMessageIds(): readonly MessageId[] {
    return [...new Set(this.inboxEntries().map((entry) => entry.message_id))];
  }

  workItems(): readonly WorkItem[] {
    return this.snapshot().work_items;
  }

  distribution(): Readonly<Record<WorkItemStatus, number>> {
    return this.observe().snapshot.work_item_status_distribution;
  }

  /** 场景内的逻辑步（记录 + 推进可控时钟一次）。 */
  mark(label: string): LogicalTime {
    const step = this.clock.advance(1, label);
    this.marks.push({ label, step });
    return step;
  }

  // --- 写入入口（全部经被测内核） ----------------------------------------------

  /** 按脚本构造一条待投递消息（发送者经 `SenderBinding` 绑定，草稿里没有 sender 字段）。 */
  buildDelivery(spec: DeliverySpec): DeliveryRequest {
    return createDeliveryRequest({
      task_id: this.task_id,
      group_id: this.group_id,
      task_revision: spec.revision ?? this.revision,
      message_id: messageId(spec.message_id),
      sender_instance_id: instanceId(spec.sender),
      recipient_instance_id: instanceId(spec.recipient ?? this.instance_id),
      type: spec.type ?? 'work_request',
      content: spec.content,
      ...(spec.requires_wakeup === undefined ? {} : { requires_wakeup: spec.requires_wakeup }),
      ...(spec.request_id === undefined ? {} : { request_id: requestId(spec.request_id) }),
      at: spec.at ?? this.clock.now(),
    });
  }

  /** 经内核入口提交一条投递（落库 + 去重 + 排队 + 发布），并记录三值回执。 */
  submit(request: DeliveryRequest, label?: string): DeliveryReceipt {
    const outcome = this.scheduler.onMessage(request.message);
    const commit = this.seam.deliveries[this.seam.deliveries.length - 1];
    const receipt = makeDeliveryReceipt(request, outcome.result, {
      step: this.clock.now(),
      advance_seq: commit?.advanceSeq ?? this.seam.advanceSeq,
      ...(label === undefined ? {} : { note: label }),
    });
    this.log.record(receipt);
    this.delivery_steps.push({
      index: this.delivery_steps.length + 1,
      label: label ?? '',
      message_id: receipt.message_id,
      request_id: receipt.request_id,
      result: receipt.result,
      step: receipt.step,
      advance_seq: receipt.advance_seq,
    });
    return receipt;
  }

  /** 便捷：构造 + 提交。 */
  deliver(spec: DeliverySpec, label?: string): DeliveryReceipt {
    return this.submit(this.buildDelivery(spec), label);
  }

  /**
   * **受控缺陷专用**（I-A02-2「入口丢消息」）：不调用内核、**谎报** `accepted`，
   * 从而在 `accepted` 面上伪装成正常，只在守恒面上露馅。仅缺陷用例调用。
   */
  recordDroppedDelivery(request: DeliveryRequest, note: string): DeliveryReceipt {
    const receipt = makeDeliveryReceipt(request, 'accepted', {
      step: this.clock.now(),
      advance_seq: this.seam.advanceSeq,
      note,
    });
    this.log.record(receipt);
    this.delivery_steps.push({
      index: this.delivery_steps.length + 1,
      label: note,
      message_id: receipt.message_id,
      request_id: receipt.request_id,
      result: `${receipt.result}(dropped)`,
      step: receipt.step,
      advance_seq: receipt.advance_seq,
    });
    return receipt;
  }

  /** 显式放行一次调度决策点（夹具持有推进权）。 */
  advance(label: string): Promise<AdvanceRecord> {
    return this.seam.advanceOnce(label);
  }

  /** 显式放行 `count` 次（A02 的 R2…R6 空推进）。 */
  advanceTimes(count: number, label: string): Promise<readonly AdvanceRecord[]> {
    return this.seam.advanceTimes(count, label);
  }

  /** 结束当前活动轮次并声明本轮结局（这是"轮次执行"的收尾，由夹具逐点放行）。 */
  finishActiveRun(publications: readonly RunPublication[], note?: string): FinishRunOutcome {
    const run = this.activeRun();
    if (run === null) throw new Error('当前没有活动轮次可结束（夹具脚本错误）');
    const outcome = this.scheduler.finishRun({ run_id: run.run_id, publications });
    this.finishes.push({
      run_id: run.run_id,
      accepted: outcome.accepted,
      applied_request_ids: [...outcome.applied_request_ids],
      rejected_request_ids: outcome.rejected_publications.map((entry) => entry.request_id),
      queued_next_run: outcome.queued_next_run,
      ...(note === undefined ? {} : { note }),
    });
    return outcome;
  }

  // --- 受控缺陷注入器（R7；仅隔离用例调用，绝不修改 src/**） --------------------

  /**
   * I-A02-1 / I-A03-2 的**运行侧**注入：往事件流里补一条 `run_started`（伪造第二个并发轮次）。
   *
   * **如实声明**：真实内核的 `start_run` 把「认领 + 冻结 + 置活动」放在**同一个事务**里
   * （`src/scheduler/runs.ts` 的 §九-3），所以"先查后置"的重复启动**无法经公开接口构造**
   * ——这本身就是 P1 的结论。本注入构造的是**该缺陷会产生的观测量**，用来证明
   * `run_count === 1 && peak_active_runs === 1` 这些断言**真会失败**（R7 的用途）。
   */
  injectDuplicateRunStarted(runId: string, label: string): KernelEvent {
    return this.store.transact((tx) => {
      const event = createKernelEvent(
        {
          kind: 'run_started',
          at: this.clock.now(),
          task_id: this.task_id,
          group_id: this.group_id,
          instance_id: this.instance_id,
          run_id: asRunId(runId),
          data: { injected_defect: label, shape: 'duplicate_run_start' },
        },
        this.#injectionIds,
      );
      tx.appendKernelEvent(event);
      return event;
    });
  }

  /**
   * I-A03-2 的**入队侧**注入：往事件流里补一条 `delegation_queue_enqueued`
   * （模拟"去掉『已有排队标记则不再入队』的保护后，每条到达各自入队一次"）。
   *
   * **如实声明**：合并保护活在 `markQueueFlagged()` 的**单个事务**里，去掉它必须改 `src/**`
   * （冻结点纪律禁止）。本注入构造该缺陷会产生的观测量，证明 A03-03 的入队计数断言可证伪。
   */
  injectUnauthorizedQueueEnqueue(label: string): KernelEvent {
    return this.store.transact((tx) => {
      const event = createKernelEvent(
        {
          kind: 'delegation_queue_enqueued',
          at: this.clock.now(),
          task_id: this.task_id,
          group_id: this.group_id,
          instance_id: this.instance_id,
          data: { injected_defect: label, shape: 'no_merge_protection' },
        },
        this.#injectionIds,
      );
      tx.appendKernelEvent(event);
      return event;
    });
  }

  /**
   * I-A03-3「读即完成」注入：经**公开存储接口**把工作项改写成 `completed` 且**无结果引用**
   * （"轮次读过消息就当成完成了"）。
   *
   * 口径同 R25.2：**正常转换路径不可能产出该结果**（D04 的转换入口强制
   * `completed` 必须带结果引用，R14-2），因此本断言防守的是"绕过状态机的实现回归"。
   */
  injectReadEqualsDone(target: RequestId, label: string): WorkItem {
    return this.store.transact((tx) => {
      const item = tx.getWorkItem(target);
      if (item === undefined) throw new Error(`注入失败：工作项 ${target} 不存在`);
      const defective = createWorkItem({
        request_id: item.request_id,
        task_id: item.task_id,
        task_revision: item.task_revision,
        owner_instance_id: item.owner_instance_id,
        description: item.description,
        expected_output: item.expected_output,
        status: 'completed',
        result_refs: [],
        blocker_reason: null,
        triggering_message_ids: item.triggering_message_ids,
        snapshot_run_ids: item.snapshot_run_ids,
        included_in_snapshot: item.included_in_snapshot,
        created_at: item.created_at,
        updated_at: this.clock.now(),
      });
      tx.putWorkItem(defective);
      void label;
      return defective;
    });
  }

  /** 证据快照（场景结束时的确定性汇总材料）。 */
  evidence(): Record<string, unknown> {
    const obs = this.observe();
    return {
      logical_steps: this.marks.map((entry) => ({ label: entry.label, step: entry.step })),
      delivery_log: {
        total: this.log.snapshot().total,
        accepted: this.log.snapshot().accepted,
        duplicate_not_created: this.log.snapshot().duplicate_not_created,
        failed: this.log.snapshot().failed,
        message_ids_in_order: this.log.messageIdsInOrder().map(String),
        request_ids_in_order: this.log.requestIdsInOrder().map(String),
      },
      delivery_steps: this.delivery_steps,
      seam_deliveries: this.seam.deliveries.map((note) => ({
        index: note.index,
        message_id: String(note.message_id),
        request_id: note.request_id === null ? null : String(note.request_id),
        advance_seq: note.advanceSeq,
        step: note.step,
        label: note.label ?? null,
      })),
      advance_records: this.seam.records.map((record) => ({
        seq: record.seq,
        kind: record.kind,
        started_runs: record.startedRuns,
        step: record.step,
        label: record.label ?? null,
      })),
      runs: this.runs().map((run) => ({
        run_id: String(run.run_id),
        status: run.status,
        frozen_input_message_ids: run.frozen_input_message_ids.map(String),
        frozen_request_ids: run.frozen_request_ids.map(String),
      })),
      finishes: this.finishes,
      instance: {
        activity: this.instance().activity,
        active_run_id: this.instance().active_run_id === null ? null : String(this.instance().active_run_id),
        queued_flag: this.instance().queued_flag,
      },
      inbox: {
        entries: this.inboxEntries().length,
        unique_message_ids: this.uniqueInboxMessageIds().map(String),
      },
      work_items: this.workItems().map((item) => ({
        request_id: String(item.request_id),
        status: item.status,
        result_refs: item.result_refs.map(String),
        blocker_kind: item.blocker_reason === null ? null : item.blocker_reason.kind,
        triggering_message_ids: item.triggering_message_ids.map(String),
      })),
      counters: {
        event_side_source: obs.event_source,
        snapshot_side_source: obs.snapshot_source,
        event_side: obs.event,
        snapshot_side: obs.snapshot,
        merged: obs.merged,
        status_distribution_total: sumDistribution(obs.snapshot.work_item_status_distribution),
      },
      kernel_event_kinds: countByKind(this.kernelEvents()),
    };
  }
}

/** 六态分布求和（R22 的"夹具确实产生了数据"判据）。 */
export function sumDistribution(distribution: Readonly<Record<WorkItemStatus, number>>): number {
  let total = 0;
  for (const status of WORK_ITEM_STATUSES) total += distribution[status];
  return total;
}

/** 事件流按种类的计数（事件侧非空 + 含预期种类的判据材料）。 */
export function countByKind(events: readonly KernelEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const event of events) out[event.kind] = (out[event.kind] ?? 0) + 1;
  return out;
}

// ---------------------------------------------------------------------------
// 假 Agent 的结局声明
// ---------------------------------------------------------------------------

/**
 * 按假 Agent 脚本把本轮各请求的决策翻译为内核的**结局声明**（`RunPublication`）。
 *
 * 边界（Q10-b）：假 Agent **不写内核状态**——它只表达"本轮我打算产出什么"，
 * 工作项的终态由内核（D04 的转换入口 + 所有权核验）落定。
 * 结果引用一律用 `artifactRefFor(requestId)`，因此 A03-10「引用的 request_id 与工作项一致」
 * 天然成立；若实现张冠李戴，断言会红。
 */
export function publicationsFromScript(
  script: FakeAgentScript,
  requestIds: readonly RequestId[],
): readonly RunPublication[] {
  return requestIds.map((rid) => {
    const decision = script.decisionFor(rid);
    switch (decision) {
      case 'produce_result':
        return { kind: 'completed', request_id: rid, result_refs: [artifactRefFor(rid)] };
      case 'report_tool_failure':
        return {
          kind: 'failed',
          request_id: rid,
          failure_reason: script.require(rid).failure_reason ?? '工具调用失败',
        };
      case 'report_dependency':
        return {
          kind: 'waiting_dependency',
          request_id: rid,
          dependency_refs: [
            { request_id: script.require(rid).depends_on_request_id as RequestId },
          ],
          blocker_reason: { kind: 'waiting_external', detail: '等待依赖结果' },
        };
      case 'report_stage_result':
        return {
          kind: 'processing',
          request_id: rid,
          blocker_reason: { kind: 'other', detail: '仅发布公共进度，本轮无结局' },
        };
      case 'stay_blocked':
        return {
          kind: 'processing',
          request_id: rid,
          blocker_reason: { kind: 'other', detail: '本轮无输出（仍在处理）' },
        };
      default: {
        const unexpected: never = decision;
        throw new Error(`未处理的假 Agent 决策：${String(unexpected)}`);
      }
    }
  });
}

/** 全部请求「产出结果」的脚本（A02 / A03 的正常路径）。 */
export function allProduceResultScript(requestIds: readonly string[]): FakeAgentScript {
  return new FakeAgentScript(
    requestIds.map((rid) => ({ request_id: requestId(rid), decision: 'produce_result' as const })),
  );
}

// ---------------------------------------------------------------------------
// 可复用的**关键断言**（故意写成会抛错的函数：缺陷注入用它们证明"真会失败"）
// ---------------------------------------------------------------------------

/** A02-04 / A03-05：收件箱唯一 message_id 集合**恰好**是期望集合（等号，不用存在性）。 */
export function assertInboxExactly(
  entries: readonly InboxEntry[],
  expected: readonly MessageId[],
): void {
  const actual = [...new Set(entries.map((entry) => entry.message_id))];
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((id) => !actualSet.has(id));
  const extra = [...actualSet].filter((id) => !expectedSet.has(id));
  if (missing.length > 0 || extra.length > 0 || actual.length !== expectedSet.size) {
    throw new ConservationViolationError(
      `收件箱唯一 message_id 数应为 ${expectedSet.size}，实际 ${actual.length}（少了请求 = 丢消息）`,
      [
        ...missing.map((id) => `缺失:${String(id)}`),
        ...extra.map((id) => `多余:${String(id)}`),
      ],
    );
  }
}

/** A03-10：任何 `completed` 项都必须带**与自身 request_id 匹配**的结果引用。 */
export function assertCompletedHaveMatchingResults(items: readonly WorkItem[]): void {
  const offenders = findCompletedWithoutResult(items);
  if (offenders.length > 0) {
    throw new ConservationViolationError(
      '存在已完成但无结果引用的工作项（"读取即完成"缺陷）',
      offenders.map((item) => String(item.request_id)),
    );
  }
  const mismatched = items
    .filter((item) => item.status === 'completed')
    .filter((item) => {
      const refs = item.result_refs.map(String);
      return refs.length !== 1 || refs[0] !== `${String(item.request_id)}#result`;
    });
  if (mismatched.length > 0) {
    throw new ConservationViolationError(
      '已完成项的结果引用与自身 request_id 不匹配（张冠李戴）',
      mismatched.map((item) => `${String(item.request_id)}→[${item.result_refs.join(',')}]`),
    );
  }
}

/** A03-03：首轮活动期间的入队事件数**恰好为 0**（合并唤醒：三条后到只产生至多一次机会）。 */
export function assertNoEnqueueWhileActive(duringRunEnqueues: number): void {
  if (duringRunEnqueues !== 0) {
    throw new ConservationViolationError(
      `首轮活动期间出现了 ${duringRunEnqueues} 次入队事件（合并唤醒被破坏）`,
      [`during_run_enqueues=${duringRunEnqueues}`],
    );
  }
}

/**
 * A02-09：**没有任何一次投递因「已有活动轮次或已有排队标记」而被拒绝 / 丢弃**。
 * 次数全部为 `accepted` 才算成立（等号，不用上界）。
 */
export function assertAllDeliveriesAccepted(log: DeliveryLogSnapshot): void {
  if (log.failed !== 0 || log.accepted !== log.total) {
    throw new ConservationViolationError(
      `投递未被全部接受：accepted=${log.accepted} / failed=${log.failed} / total=${log.total}` +
        '（A02-09：不得因"已有活动轮次或已有排队标记"拒绝或丢弃请求）',
      [`failed=${log.failed}`, `duplicate_not_created=${log.duplicate_not_created}`],
    );
  }
}

/** 便捷：把字符串字面量折成品牌化的 `MessageId`（断言可读性）。 */
export function asMessageIds(values: readonly string[]): readonly MessageId[] {
  return values.map((value) => messageId(value));
}

/** 便捷：把字符串字面量折成品牌化的 `RequestId`。 */
export function asRequestIds(values: readonly string[]): readonly RequestId[] {
  return values.map((value) => requestId(value));
}

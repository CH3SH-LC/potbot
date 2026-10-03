/**
 * P7 / P8 验收场景的公共接线与断言（归属 D11；`design-01-P7` / `design-01-P8`）。
 *
 * ## 本文件是什么 / 不是什么
 *
 * - **是**：把 D01 协议与存储、D02 收件箱去重、D03 调度内核、D06 可控时钟与推进接缝，
 *   按 D03 报告给出的接线（`createScheduler(...)` + `seam.bind(() => scheduler.advanceOnce())`）
 *   只用**公开接口**装配起来的验收夹具；
 * - **不是**：被测逻辑的复制品。夹具**不写工作项状态、不置排队标记、不启动轮次**
 *   ——那些一律经被测代码走。唯一的例外是**受控缺陷注入器**（见下），它们只在隔离夹具内
 *   生效，且不修改 `src/**`（冻结点纪律 R24.4）。
 *
 * ## 规格来源
 *
 * `docs/design/design-01-内核骨架与假Agent验证.md` 的验收标准原文：
 * - **P7**：「结束轮次时核对身份与租约所有权；构造一个"租约已过期"或"任务版本已变更"的
 *   迟到发布，必须被拒绝且不写入任何结果。」
 * - **P8**：「伪造发送者身份、或路由与目标不符的消息，不得进入有效收件箱，
 *   也不得产生业务工作。」
 *
 * ## 断言纪律
 *
 * - **R17**：计数类断言一律用**等号**（禁止 `toBeLessThanOrEqual`——0 也会通过）。
 * - **R19**：观测**同时**含事件侧（`summarizeKernelEvents`）与快照侧（`summarizeSnapshotCounters`），
 *   合并用 `mergeSchedulingCounters`；证据标明两组来源。
 * - **R22**：断言前先断言夹具**确实产生了数据**（不用 `in` / 存在性判断蒙混）。
 * - **R29.2**：投递归属断言**一律取自存储侧**（收件箱 / outbox），不拿接缝登记充数。
 * - **R7 / R28.1**：每条场景至少一次受控缺陷注入，且核 `fired`（注入未真正发生即判该场景无效）。
 */

import {
  asGroupId,
  asInstanceId,
  asRevision,
  asTaskId,
  createGroupMember,
  createIdSource,
  createInstanceState,
  createTaskRecord,
  mergeSchedulingCounters,
  summarizeKernelEvents,
  summarizeSnapshotCounters,
  type DeliveryResult,
  type EventCounters,
  type GroupId,
  type GroupMessage,
  type InboxEntry,
  type InstanceId,
  type InstanceState,
  type KernelEvent,
  type LogicalTime,
  type MessageId,
  type MessageType,
  type PublicationRejectionReason,
  type RequestId,
  type Revision,
  type RunRecord,
  type SchedulingCounters,
  type SnapshotCounters,
  type Store,
  type StoreSnapshot,
  type StorageTransaction,
  type TaskId,
  type WorkItem,
} from '../../../src/protocol/index.js';
import { createMemoryStore } from '../../../src/storage/index.js';
import { LogicalClock } from '../../../src/clock/index.js';
import {
  createScheduler,
  type FinishRunOutcome,
  type OnMessageOutcome,
  type RunPublication,
  type Scheduler,
  type SenderAuthenticator,
} from '../../../src/scheduler/index.js';
import {
  ConservationViolationError,
  SchedulerAdvanceSeam,
  artifactRefFor,
  createDeliveryRequest,
  type DeliveryRequest,
} from '../../../src/fake/index.js';
import { applyWorkItemTransition } from '../../../src/workledger/index.js';
import { freezePointEvidence, writeEvidenceArtifacts } from '../freeze-identity.js';

// ---------------------------------------------------------------------------
// 场景基线（验收规格 0.2 / 4.1 的口径，就地声明；本文件不复制内核逻辑）
// ---------------------------------------------------------------------------

export const TASK_ID: TaskId = asTaskId('T1');
export const GROUP_ID: GroupId = asGroupId('G1');
/** 第二个群组：P8「路由与目标不符」的跨群子场景用。 */
export const OTHER_GROUP_ID: GroupId = asGroupId('G2');
export const INSTANCE_C: InstanceId = asInstanceId('C');
export const SENDER_S1: InstanceId = asInstanceId('S1');
/** 从未注册的接收实例（P8「未注册实例」子场景）。 */
export const UNREGISTERED_INSTANCE: InstanceId = asInstanceId('I-UNKNOWN');

/**
 * 标准发送成员（合同 v1.2 R35.5；修复 F07）。
 *
 * 入口默认鉴权器的第 4 项判据要求发送者是本群**已登记成员**；这些身份登记在
 * **独立的成员表**（`putGroupMember`），而不是 `putInstance`——后者会把"只是来发消息的
 * 同群成员"算进 `instances` 计数与调度观测（见 `src/protocol/membership.ts` 的说明）。
 *
 * `S-EVIL` 之类的伪造身份**故意不在**这里：它是"未登记成员"负向用例的目标。
 */
export const STANDARD_MEMBER_IDS: readonly InstanceId[] = [
  SENDER_S1,
  asInstanceId('S2'),
  asInstanceId('S3'),
  asInstanceId('S4'),
];

/** 场景固定调度顺序（执行前登记，Q8-c；本批为确定性顺序，无随机种子）。 */
export const FIXED_SCHEDULE = 'deterministic:instances-in-insertion-order;advance-explicit-only';

const FREEZE_POINT = freezePointEvidence();

/**
 * 落一份 JSON 证据（验收规格 0.7：证据只存 JSON / JSONL）。
 *
 * 冻结点标识**取自单一来源** `tests/acceptance/freeze-identity.ts`（D11 收尾，R24）；
 * **身份戳经复算**（R38.4 / F11）且**落盘目录由身份决定**（G05 / R46.1）：
 * 复算（含 R45.1 的配置摘要）与登记冻结点匹配 ⇒ 写 `docs/other/evidence/{登记冻结点}/`；
 * 不匹配 ⇒ 写 `.dev-evidence/{登记冻结点}/`，`frozen: false` / `DEV-UNFROZEN`，
 * **不触碰** `docs/other/evidence/**`（R46.3 / R46.4）。
 */
export function writeEvidence(fileName: string, payload: Record<string, unknown>): string {
  const outcome = writeEvidenceArtifacts((identity) => [
    {
      file_name: fileName,
      content: `${JSON.stringify(
        {
          schema: 'd11-acceptance-evidence.v1',
          task: 'D11',
          design_points: ['design-01-P7', 'design-01-P8'],
          freeze_point: {
            id: FREEZE_POINT.id,
            file: FREEZE_POINT.file,
            source_tree_sha256: FREEZE_POINT.source_tree_sha256,
            src_only_sha256: FREEZE_POINT.src_only_sha256,
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
    throw new Error('证据落盘回执缺失（D11 写入器脚本错误）');
  }
  return written.absolute_path;
}

// ---------------------------------------------------------------------------
// 观测（R19：两组来源分别留证后合并）
// ---------------------------------------------------------------------------

export interface Observation {
  readonly event: EventCounters;
  readonly snapshot: SnapshotCounters;
  readonly merged: SchedulingCounters;
  readonly event_source: string;
  readonly snapshot_source: string;
}

/** 事件侧 6 项 + 快照侧 2 项 + 合并（两组来源都取，缺一即观测不完整）。 */
export function observe(snapshot: StoreSnapshot): Observation {
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

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

export interface DeliverySpec {
  readonly message_id: string;
  readonly request_id?: string;
  readonly sender?: InstanceId;
  readonly recipient?: InstanceId;
  readonly group_id?: GroupId;
  readonly type?: MessageType;
  readonly content?: string;
  readonly requires_wakeup?: boolean;
  readonly revision?: Revision;
}

/** 一次入口投递的取证记录（三值 + 原样失败原因）。 */
export interface EntryRecord {
  readonly index: number;
  readonly message_id: MessageId;
  readonly request_id: RequestId | null;
  readonly result: DeliveryResult;
  readonly failure_reason: string | null;
  readonly work_item_created: boolean;
  readonly step: LogicalTime;
}

/**
 * P7 / P8 共用夹具（隔离：一个存储 + 一个调度器 + 一个推进接缝）。
 *
 * 接线（D03 报告原文，一行不改）：
 * ```ts
 * const seam = new SchedulerAdvanceSeam(clock);
 * const scheduler = createScheduler(store, {
 *   clock: () => clock.now(),
 *   onDeliveryCommitted: (note) => seam.noteDeliveryCommit({ ...note, label: note.result }),
 *   default_task_id: T1,
 * });
 * seam.bind(() => scheduler.advanceOnce());
 * ```
 *
 * `decorateStore` 只在**受控缺陷注入**隔离夹具里给出（包裹 `Store`，生产源码一字未改）。
 */
export class P7P8Harness {
  readonly clock = new LogicalClock();
  readonly store: Store;
  readonly seam: SchedulerAdvanceSeam;
  readonly scheduler: Scheduler;
  readonly entries: EntryRecord[] = [];
  readonly task_id: TaskId;
  readonly group_id: GroupId;
  readonly instance_id: InstanceId;
  readonly revision: Revision;

  constructor(
    options: {
      readonly lease_ttl?: number;
      readonly group_id?: GroupId;
      readonly instance_id?: InstanceId;
      readonly task_id?: TaskId;
      readonly revision?: Revision;
      /** 受控缺陷注入：包裹存储（仅隔离夹具；默认原样返回）。 */
      readonly decorateStore?: (store: Store) => Store;
    } = {},
  ) {
    this.task_id = options.task_id ?? TASK_ID;
    this.group_id = options.group_id ?? GROUP_ID;
    this.instance_id = options.instance_id ?? INSTANCE_C;
    this.revision = options.revision ?? asRevision(1);

    const raw = createMemoryStore({ clock: () => this.clock.now() });
    this.store = options.decorateStore === undefined ? raw : options.decorateStore(raw);

    this.seam = new SchedulerAdvanceSeam(this.clock);
    this.scheduler = createScheduler(this.store, {
      idSource: createIdSource({ seed: 'p7p8' }),
      clock: () => this.clock.now(),
      default_task_id: this.task_id,
      ...(options.lease_ttl === undefined ? {} : { lease_ttl: options.lease_ttl }),
      // 投递只登记、不推进（D06 的结构性保证）。
      onDeliveryCommitted: (note) => {
        this.seam.noteDeliveryCommit({ ...note, label: note.result });
      },
    });
    this.seam.bind(() => this.scheduler.advanceOnce());

    // R35.5（F07）：注册标准发送成员。**必须**在构造时就登记——入口默认鉴权器的
    // 第 4 项判据（成员资格）读它；不登记会让全部合法投递被拒（旧夹具正是这样失效的）。
    // 用独立成员表而不是 `putInstance`：成员资格不参与调度判定。
    for (const member of STANDARD_MEMBER_IDS) {
      this.registerMember(member, this.group_id);
    }
  }

  // --- 前置状态 -------------------------------------------------------------

  /**
   * R35.5：登记一个合法发送成员（`groupId` 缺省为本场景群）。
   *
   * 与 `registerInstance` 的区别（**不可互相替代**）：成员表只被入口鉴权读取，
   * 不进入 `instances`、不参与任何调度判定。
   */
  registerMember(instanceId: InstanceId, groupId: GroupId = this.group_id): void {
    this.store.transact((tx) => {
      tx.putGroupMember(
        createGroupMember({ group_id: groupId, instance_id: instanceId, registered_at: this.clock.now() }),
      );
    });
  }

  /** 注册任务（`resolveTaskId` / stale 判定需要它）。 */
  registerTask(revision: Revision = this.revision): void {
    this.store.transact((tx) => {
      tx.putTask(
        createTaskRecord({
          task_id: this.task_id,
          goal: 'D11 验收场景：P7 轮次所有权 / P8 来源与路由',
          current_group_id: this.group_id,
          revision,
          created_at: this.clock.now(),
          updated_at: this.clock.now(),
        }),
      );
    });
  }

  /** 注册一个空闲实例。 */
  registerInstance(instanceId: InstanceId = this.instance_id, groupId: GroupId = this.group_id): void {
    this.store.transact((tx) => {
      tx.putInstance(
        createInstanceState({
          instance_id: instanceId,
          group_id: groupId,
          updated_at: this.clock.now(),
        }),
      );
    });
  }

  /** 改写任务版本（P7「任务版本已变更」的**真实**构造：直改已注册任务，非仅传参覆盖）。 */
  setTaskRevision(revision: Revision): void {
    const existing = this.store.snapshot().tasks.find((task) => task.task_id === this.task_id);
    if (existing === undefined) {
      throw new Error(`任务 ${this.task_id} 未注册，无法改写版本（夹具脚本错误）`);
    }
    this.store.transact((tx) => {
      tx.putTask(
        createTaskRecord({
          ...existing,
          revision,
          updated_at: this.clock.now(),
        }),
      );
    });
  }

  // --- 只读观测 -------------------------------------------------------------

  snapshot(): StoreSnapshot {
    return this.scheduler.snapshot();
  }

  observe(): Observation {
    return observe(this.snapshot());
  }

  kernelEvents(): readonly KernelEvent[] {
    return this.snapshot().kernel_events;
  }

  countEvents(kind: KernelEvent['kind']): number {
    return this.kernelEvents().filter((event) => event.kind === kind).length;
  }

  inboxEntries(instanceId: InstanceId = this.instance_id): readonly InboxEntry[] {
    return this.snapshot().inbox_entries.filter((entry) => entry.instance_id === instanceId);
  }

  workItems(): readonly WorkItem[] {
    return this.snapshot().work_items;
  }

  /** 取某个 request_id 的工作项；不存在即抛错（不静默跳过）。 */
  requireWorkItem(requestId: RequestId): WorkItem {
    const item = this.snapshot().work_items.find((work) => work.request_id === requestId);
    if (item === undefined) {
      throw new Error(`工作承诺表里没有 ${requestId}（夹具/内核接线错误）`);
    }
    return item;
  }

  /** 取某个 request_id 的工作项；不存在返回 null（负向场景用）。 */
  maybeWorkItem(requestId: RequestId): WorkItem | null {
    return this.snapshot().work_items.find((work) => work.request_id === requestId) ?? null;
  }

  instance(): InstanceState {
    const found = this.snapshot().instances.find((state) => state.instance_id === this.instance_id);
    if (found === undefined) throw new Error(`实例 ${this.instance_id} 未注册`);
    return found;
  }

  runningRun(): RunRecord {
    const running = this.snapshot().runs.filter((run) => run.status === 'running');
    const first = running[0];
    if (running.length !== 1 || first === undefined) {
      throw new Error(`期望恰有 1 个活动轮次，实际 ${String(running.length)} 个（夹具脚本错误）`);
    }
    return first;
  }

  /** R29.2：投递归属取自**存储侧**（outbox 未投递事件），不拿接缝登记充数。 */
  pendingDeliveryEvents() {
    return this.store.pendingDeliveryEvents();
  }

  // --- 写入入口（全部经被测内核） --------------------------------------------

  buildDelivery(spec: DeliverySpec): DeliveryRequest {
    return createDeliveryRequest({
      task_id: this.task_id,
      group_id: spec.group_id ?? this.group_id,
      task_revision: spec.revision ?? this.revision,
      message_id: spec.message_id as MessageId,
      sender_instance_id: spec.sender ?? SENDER_S1,
      recipient_instance_id: spec.recipient ?? this.instance_id,
      type: spec.type ?? 'work_request',
      content: spec.content ?? `工作请求 ${spec.request_id ?? spec.message_id}`,
      ...(spec.requires_wakeup === undefined ? {} : { requires_wakeup: spec.requires_wakeup }),
      ...(spec.request_id === undefined ? {} : { request_id: spec.request_id as RequestId }),
      at: this.clock.now(),
    });
  }

  /** 经内核入口投递一条**任意**消息（P8 的伪造消息只能这样送进来）并留三值回执。 */
  submitMessage(
    message: GroupMessage,
    options: { readonly authenticator?: SenderAuthenticator } = {},
  ): OnMessageOutcome {
    const outcome = this.scheduler.onMessage(
      message,
      options.authenticator === undefined ? {} : { authenticator: options.authenticator },
    );
    this.entries.push({
      index: this.entries.length + 1,
      message_id: outcome.message_id,
      request_id: outcome.request_id,
      result: outcome.result,
      failure_reason: outcome.failure_reason,
      work_item_created: outcome.work_item_created,
      step: this.clock.now(),
    });
    return outcome;
  }

  /** 经内核入口投递（可注入鉴权器）并留下三值回执。 */
  deliver(
    spec: DeliverySpec,
    options: { readonly authenticator?: SenderAuthenticator } = {},
  ): { readonly request: DeliveryRequest; readonly outcome: OnMessageOutcome } {
    const request = this.buildDelivery(spec);
    const outcome = this.submitMessage(request.message, options);
    return { request, outcome };
  }

  /** 显式放行一次调度决策点（夹具持有推进权）。 */
  advanceOnce(label: string): Promise<unknown> {
    return this.seam.advanceOnce(label);
  }

  /** 结束当前活动轮次并声明本轮结局（经被测内核的 `finishRun`）。 */
  finishRun(
    input: {
      readonly publications?: readonly RunPublication[];
      readonly at?: LogicalTime;
    } = {},
  ): FinishRunOutcome {
    const run = this.runningRun();
    return this.scheduler.finishRun({
      run_id: run.run_id,
      ...(input.publications === undefined ? {} : { publications: input.publications }),
      ...(input.at === undefined ? {} : { at: input.at }),
    });
  }

  /** 便捷：一条"本轮产出结果"的结局声明。 */
  completedPublication(requestId: RequestId): RunPublication {
    return {
      kind: 'completed',
      request_id: requestId,
      result_refs: [artifactRefFor(requestId)],
    };
  }

  /** 证据快照（场景结束时的确定性汇总材料）。 */
  evidence(): Record<string, unknown> {
    const obs = this.observe();
    return {
      logical_time: this.clock.time,
      clock_advances: this.clock.advances.map((entry) => ({
        index: entry.index,
        from: entry.from,
        to: entry.to,
        delta: entry.delta,
        label: entry.label ?? null,
      })),
      deliveries: this.entries,
      inbox: {
        instances: [...new Set(this.snapshot().inbox_entries.map((entry) => entry.instance_id))].map(
          (id) => ({
            instance_id: String(id),
            entries: this.snapshot().inbox_entries.filter((entry) => entry.instance_id === id).length,
            message_ids: this.inboxEntries(id).map((entry) => String(entry.message_id)),
          }),
        ),
        total_entries: this.snapshot().inbox_entries.length,
      },
      runs: this.snapshot().runs.map((run) => ({
        run_id: String(run.run_id),
        status: run.status,
        task_revision: run.task_revision,
        lease_deadline: run.lease_deadline,
        frozen_request_ids: run.frozen_request_ids.map(String),
      })),
      instances: this.snapshot().instances.map((state) => ({
        instance_id: String(state.instance_id),
        group_id: String(state.group_id),
        activity: state.activity,
        active_run_id: state.active_run_id === null ? null : String(state.active_run_id),
        queued_flag: state.queued_flag,
      })),
      work_items: this.snapshot().work_items.map((item) => ({
        request_id: String(item.request_id),
        status: item.status,
        result_refs: item.result_refs.map(String),
        triggering_message_ids: item.triggering_message_ids.map(String),
      })),
      counters: {
        event_side_source: obs.event_source,
        snapshot_side_source: obs.snapshot_source,
        event_side: obs.event,
        snapshot_side: obs.snapshot,
        merged: obs.merged,
      },
      kernel_event_kinds: countByKind(this.kernelEvents()),
      seam_delivery_registrations: this.seam.deliveries.map((note) => ({
        index: note.index,
        message_id: String(note.message_id),
        request_id: note.request_id === null ? null : String(note.request_id),
        advance_seq: note.advanceSeq,
        label: note.label ?? null,
      })),
      pending_delivery_events: this.pendingDeliveryEvents().map((event) => String(event.kind)),
    };
  }
}

/** 事件流按种类计数（事件侧非空 + 含预期种类的判据材料）。 */
export function countByKind(events: readonly KernelEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const event of events) out[event.kind] = (out[event.kind] ?? 0) + 1;
  return out;
}

// ---------------------------------------------------------------------------
// 关键断言（故意写成会抛错的函数：受控缺陷注入用它们证明"真会失败"，R7）
// ---------------------------------------------------------------------------

/** ★ P7 主判据：迟到发布被拒，且拒因**恰好**是期望的那一个。 */
export function assertPublicationRejected(
  outcome: FinishRunOutcome,
  expected: PublicationRejectionReason,
): void {
  if (outcome.accepted !== false) {
    throw new ConservationViolationError(
      `迟到发布被接受了（accepted=${String(outcome.accepted)}）：P7 要求失去所有权 / 版本已变的轮次必须被拒绝`,
      [`accepted=${String(outcome.accepted)}`, `rejection_reason=${String(outcome.rejection_reason)}`],
    );
  }
  if (outcome.rejection_reason !== expected) {
    throw new ConservationViolationError(
      `迟到发布的拒因应为 ${expected}，实际 ${String(outcome.rejection_reason)}`,
      [`rejection_reason=${String(outcome.rejection_reason)}`],
    );
  }
}

/** ★ P7 主判据：**零结果写入**——工作项状态未变、无结果引用、无 `completed` 项。 */
export function assertZeroResultWrite(input: {
  readonly before: WorkItem;
  readonly after: WorkItem;
  readonly observation: Observation;
}): void {
  const problems: string[] = [];
  if (input.after.status !== input.before.status) {
    problems.push(`状态被改写：${input.before.status} → ${input.after.status}`);
  }
  if (input.after.result_refs.length !== 0) {
    problems.push(`工作项出现了结果引用：[${input.after.result_refs.join(',')}]`);
  }
  if (input.before.result_refs.length !== 0) {
    problems.push(
      `前置状态就不干净：被拒前已有结果引用 [${input.before.result_refs.join(',')}]（夹具脚本错误）`,
    );
  }
  const completed = input.observation.snapshot.work_item_status_distribution.completed;
  if (completed !== 0) {
    problems.push(`快照侧 completed 计数为 ${String(completed)}（应为 0）`);
  }
  if (problems.length > 0) {
    throw new ConservationViolationError('迟到发布被拒后仍写入了结果（P7：零结果写入）', problems);
  }
}

/** ★ P7 主判据：`rejected_publication_count` 单列且**不计入** `run_count`。 */
export function assertRejectedPublicationCountedSeparately(
  observation: Observation,
  input: { readonly expected_run_count: number; readonly expected_rejected: number },
): void {
  const { merged, event } = observation;
  if (event.rejected_publication_count !== input.expected_rejected) {
    throw new ConservationViolationError(
      `事件侧 rejected_publication_count 应为 ${input.expected_rejected}，实际 ${event.rejected_publication_count}`,
      [`rejected_publication_count=${event.rejected_publication_count}`],
    );
  }
  if (merged.run_count !== input.expected_run_count) {
    throw new ConservationViolationError(
      `run_count 应为 ${input.expected_run_count}（被拒的发布不得计入），实际 ${merged.run_count}`,
      [`run_count=${merged.run_count}`, `rejected_publication_count=${event.rejected_publication_count}`],
    );
  }
}

/** ★ P7 主判据（D03 缺口 4 的**现状**）：被拒的迟到发布**不结束轮次**、不释放实例。 */
export function assertRoundNotEndedByRejection(input: {
  readonly run: RunRecord;
  readonly instance: InstanceState;
}): void {
  const problems: string[] = [];
  if (input.run.status !== 'running') {
    problems.push(`轮次状态应保持 running，实际 ${input.run.status}`);
  }
  if (input.instance.active_run_id !== input.run.run_id) {
    problems.push(
      `实例的活动轮次应保持 ${input.run.run_id}，实际 ${String(input.instance.active_run_id)}`,
    );
  }
  if (input.instance.activity !== 'active') {
    problems.push(`实例活动态应保持 active，实际 ${input.instance.activity}`);
  }
  if (problems.length > 0) {
    throw new ConservationViolationError(
      '被拒的迟到发布结束了轮次 / 释放了实例（按 D03 缺口 4 的现状，它只记 publication_rejected）',
      problems,
    );
  }
}

/** ★ P8 主判据：入口投递未被接受（`failed`），且带非空失败原因。 */
export function assertEntryRejected(outcome: OnMessageOutcome): void {
  if (outcome.result !== 'failed') {
    throw new ConservationViolationError(
      `非法来源 / 非法路由的消息被接受了（result=${outcome.result}）：P8 要求它不得进入有效收件箱`,
      [`result=${outcome.result}`],
    );
  }
  if (outcome.failure_reason === null || outcome.failure_reason.length === 0) {
    throw new ConservationViolationError(
      '入口拒绝了消息但未给出失败原因（验收要看得见失败原因，不得静默吞掉）',
      ['failure_reason=null|empty'],
    );
  }
}

/** ★ P8 主判据：**事务回滚**——收件箱空、业务工作为空、消息与事件一条未落。 */
export function assertTransactionRolledBack(snapshot: StoreSnapshot): void {
  const problems: string[] = [];
  if (snapshot.inbox_entries.length !== 0) {
    problems.push(`收件箱条目 ${snapshot.inbox_entries.length} 条（应为 0）`);
  }
  if (snapshot.messages.length !== 0) {
    problems.push(`落库消息 ${snapshot.messages.length} 条（应为 0）`);
  }
  if (snapshot.work_items.length !== 0) {
    problems.push(`业务工作项 ${snapshot.work_items.length} 项（应为 0）`);
  }
  if (snapshot.kernel_events.length !== 0) {
    problems.push(`观测事件 ${snapshot.kernel_events.length} 条（应为 0）`);
  }
  if (snapshot.delivery_events.length !== 0) {
    problems.push(`待投递调度事件 ${snapshot.delivery_events.length} 条（应为 0）`);
  }
  if (problems.length > 0) {
    throw new ConservationViolationError(
      '非法消息产生了落库副作用（P8：不得进入有效收件箱、不得产生业务工作，事务必须整体回滚）',
      problems,
    );
  }
}

/** R22：断言前先证明**夹具确实产生了数据**（合法投递的正向对照）。 */
export function assertFixtureProducedData(snapshot: StoreSnapshot): void {
  const problems: string[] = [];
  if (snapshot.inbox_entries.length < 1) {
    problems.push(`收件箱条目 ${snapshot.inbox_entries.length} 条（合法投递应至少 1 条）`);
  }
  if (snapshot.messages.length < 1) {
    problems.push(`落库消息 ${snapshot.messages.length} 条（合法投递应至少 1 条）`);
  }
  if (snapshot.work_items.length < 1) {
    problems.push(`业务工作项 ${snapshot.work_items.length} 项（work_request 应至少建 1 项）`);
  }
  if (snapshot.kernel_events.length < 1) {
    problems.push(`观测事件 ${snapshot.kernel_events.length} 条（合法投递应至少 1 条）`);
  }
  if (problems.length > 0) {
    throw new ConservationViolationError(
      '正向对照没有产生数据：负向场景的"零"因此不可信（R22）',
      problems,
    );
  }
}

/** R29.2：归属断言取自**存储侧**——收件箱里确实有这条消息。 */
export function assertInboxHasMessage(
  entries: readonly InboxEntry[],
  messageId: MessageId,
): void {
  const count = entries.filter((entry) => entry.message_id === messageId).length;
  if (count !== 1) {
    throw new ConservationViolationError(
      `收件箱中 message_id=${messageId} 的条目应为 1 条（存储侧归属判据，R29.2），实际 ${count} 条`,
      [`count=${count}`],
    );
  }
}

// ---------------------------------------------------------------------------
// 受控缺陷注入（R7 / R28.1）——只在隔离夹具内，不修改 src/**
// ---------------------------------------------------------------------------

/**
 * **I-P7-1：所有权闸门被跳过**。
 *
 * 构造的是"内核忘了核对轮次身份 / 租约所有权，直接把发布写进工作承诺表"会产生的观测量：
 * 经**公开存储接口**（`applyWorkItemTransition` + `tx.putWorkItem`）以 `kernel` 发起方
 * （`evaluateOrigin` 对 kernel 恒放行）写入 `completed`。
 *
 * **如实声明**：真实内核的 `finishRun` 把所有权核验放在写入之前
 * （`src/scheduler/runs.ts` 的 `finishRunInTransaction`），所以"跳过闸门后照样写"**无法经公开
 * 被测接口构造**——这本身就是 P7 的结论。本注入证明的是：`assertZeroResultWrite` 的关键断言
 * **真会失败**（R7 的用途），与 D07 的 `injectReadEqualsDone` 同一口径（构造级可证伪）。
 */
export class OwnershipGateBypassDefect {
  #fired = 0;

  /** 注入实际发生的次数（R28.1：为 0 即判该场景无效）。 */
  get firedCount(): number {
    return this.#fired;
  }

  readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** 以 `kernel` 发起方直接落一条 `completed`（"跳过闸门"的缺陷观测量）。 */
  publishBypassingOwnership(requestId: RequestId, at: LogicalTime): WorkItem {
    const next = this.store.transact((tx) => {
      const item = tx.getWorkItem(requestId);
      if (item === undefined) {
        throw new Error(`注入失败：工作项 ${requestId} 不存在`);
      }
      const defective = applyWorkItemTransition({
        item,
        to: 'completed',
        at,
        origin: { kind: 'kernel', note: 'I-P7-1：跳过所有权核验的缺陷写' },
        completion: { request_id: requestId, result_refs: [artifactRefFor(requestId)] },
      });
      tx.putWorkItem(defective);
      return defective;
    });
    this.#fired += 1;
    return next;
  }
}

/** 允许一切的鉴权器（**仅负向缺陷注入**：模拟"入口鉴权层被去掉"）。 */
export function createAllowingAuthenticator(): {
  readonly authenticator: SenderAuthenticator;
  readonly firedCount: () => number;
} {
  let fired = 0;
  return {
    authenticator: () => {
      fired += 1;
    },
    firedCount: () => fired,
  };
}

/**
 * **I-P8-2：路由校验被绕过**（跨群子场景）。
 *
 * 包裹 `Store.transact`，把事务句柄的 `getInstance` 包装成"读到的是一个**群组已被改写**的
 * 实例"——模拟"路由校验读到了不该被解析到的实例，于是跨群消息被当成本群消息收下"。
 * 除该读口外一律原样透传；`src/**` 一个字节未改。
 */
export function createRoutingBypass(
  store: Store,
  target: InstanceId,
  presentedGroup: GroupId,
): { readonly store: Store; readonly firedCount: () => number } {
  let fired = 0;

  const wrapTx = (tx: StorageTransaction): StorageTransaction =>
    new Proxy(tx, {
      get(inner, prop) {
        if (prop === 'getInstance') {
          return (id: InstanceId): InstanceState | undefined => {
            const state = (inner as StorageTransaction).getInstance(id);
            if (state === undefined || id !== target || state.group_id === presentedGroup) {
              return state;
            }
            fired += 1;
            return { ...state, group_id: presentedGroup } as InstanceState;
          };
        }
        const value = Reflect.get(inner, prop, inner) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(inner)
          : value;
      },
    });

  const wrapped = new Proxy(store, {
    get(inner, prop) {
      if (prop === 'transact') {
        return <T>(work: (tx: StorageTransaction) => T): T =>
          (inner as Store).transact((tx) => work(wrapTx(tx)));
      }
      const value = Reflect.get(inner, prop, inner) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(inner)
        : value;
    },
  });

  return { store: wrapped, firedCount: () => fired };
}

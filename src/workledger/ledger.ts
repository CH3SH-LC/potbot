/**
 * 工作承诺表的**策略与转换**（P4；`design-01-P4`）。
 *
 * 本模块只做"给定额与目标状态，判定是否允许并产出**新的**工作项"，**不做**：
 * - 持久化（归 `src/storage`，D01 已落地）——转换结果是新的不可变 `WorkItem`，由调用方在同一事务内 `putWorkItem`；
 * - 轮次编排 / 快照冻结（归 D03）；
 * - 依赖解除与循环诊断（归 D05）——本模块只保证"等待态必须带可指认的依赖项与原因"。
 *
 * 三条不可绕过的保证：
 * 1. **合法性**：不在 `WORK_ITEM_TRANSITIONS` 表内的转换一律拒绝（`illegal_transition`）。
 * 2. **终态冻结**：终态项的任何转换（含自环）一律拒绝（`terminal_locked`，Q4-b、§九-9）。
 * 3. **形状不变量不被绕过**：候选新项在返回前必须通过 protocol 的 `assertWorkItemInvariants()`；
 *    任何绕过都会以 `invariant_violation` 暴露在判定路径上，而不是悄悄写库。
 */

import {
  assertWorkItemInvariants,
  createWorkItem,
  isTerminalStatus,
  type ArtifactRef,
  type BlockerKind,
  type BlockerReason,
  type DependencyRef,
  type InstanceId,
  type LogicalTime,
  type MessageId,
  type PublicationRejectionReason,
  type RequestId,
  type Revision,
  type RunId,
  type RunRecord,
  type WorkItem,
  type WorkItemStatus,
  WORK_ITEM_STATUSES,
} from '../protocol/index.js';
import { evaluateOrigin, type TransitionOrigin } from './origin.js';
import { WorkLedgerError, type WorkLedgerRejectionReason } from './rejections.js';
import {
  cancellationReasonOf,
  evaluateOutcomeCompleteness,
  hasExplicitOutcome,
  hasWaitReason,
  isValidBlockerKind,
  type OutcomeViolation,
} from './outcome.js';
import { canTransition, isReopenableStatus, isWorkItemStatus } from './transitions.js';

// ---------------------------------------------------------------------------
// 转换请求 / 判定结果
// ---------------------------------------------------------------------------

/**
 * 转到 `completed` 的**证据**。
 *
 * `request_id` 必须等于工作项自身的 request_id（P4-10：结果引用不得张冠李戴）。
 * 说明：protocol 的 `ArtifactRef` 是无结构的品牌化字符串，无法从引用本身读出它答复了哪个请求；
 * 因此"引用 ↔ 请求"的绑定在**转换入口**强制，而不是事后从存储里推断。
 */
export interface CompletionEvidence {
  readonly request_id: RequestId;
  readonly result_refs: readonly ArtifactRef[];
}

export interface WorkItemTransitionRequest {
  readonly item: WorkItem;
  readonly to: WorkItemStatus;
  /** 本次转换的逻辑时刻（写入 `updated_at`）。 */
  readonly at: LogicalTime;
  /** 发起方：省略 = 内核自身（入口事务 / 取消命令 / 依赖解除）。 */
  readonly origin?: TransitionOrigin;

  /**
   * 转到非终态时的等待/阻塞原因。
   * 省略 = 沿用工作项已有的原因；**显式传 `null` = 清空**（会被守卫拒绝，据此保证原因不被绕过）。
   */
  readonly blocker_reason?: BlockerReason | null;
  /**
   * 依赖项集合。省略 = 沿用已有的；**显式传 `[]` = 清空**。
   * `waiting_dependency` 要求至少一项**可指认**的依赖（P4-02）。
   */
  readonly dependency_refs?: readonly DependencyRef[] | null;
  /** 转到 `failed` 时**必须**给出。 */
  readonly failure_reason?: string;
  /** 转到 `cancelled` 时**必须**给出（落 `blocker_reason.detail`，见 `outcome.ts` 偏差说明）。 */
  readonly cancellation_reason?: string;
  /** 取消原因的类别，默认 `other`。 */
  readonly cancellation_blocker_kind?: BlockerKind;
  /** 转到 `completed` 时**必须**给出。 */
  readonly completion?: CompletionEvidence;

  /** 追加的触发消息（Q4-a：只记录"哪些消息触发了本项"，不等于完成）。 */
  readonly add_triggering_message_ids?: readonly MessageId[];
  /** 若本次转换由某轮快照读入触发，登记该 run_id（读入 ≠ 完成）。 */
  readonly snapshot_run_id?: RunId;
}

export interface TransitionRejection {
  readonly reason: WorkLedgerRejectionReason;
  /** 归属/版本类拒因透出的 protocol 原因；其它为 null。 */
  readonly ownership_reason: PublicationRejectionReason | null;
  readonly message: string;
}

export interface TransitionVerdict {
  readonly ok: boolean;
  readonly from: WorkItemStatus;
  readonly to: WorkItemStatus;
  readonly rejection: TransitionRejection | null;
  /** 允许时的新工作项（不可变）；拒绝时为 null。 */
  readonly next: WorkItem | null;
}

function reject(
  item: WorkItem,
  to: WorkItemStatus,
  reason: WorkLedgerRejectionReason,
  message: string,
  ownershipReason: PublicationRejectionReason | null = null,
): TransitionVerdict {
  return {
    ok: false,
    from: item.status,
    to,
    rejection: { reason, ownership_reason: ownershipReason, message },
    next: null,
  };
}

function hasOwn<T extends object, K extends string>(value: T, key: K): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * 依赖项是否"可指认"（P4-02：等待原因必须能指到具体对象）。
 * 三项引用全空的 `DependencyRef` 等于没写依赖，不算可指认。
 */
export function isAttributableDependencyRef(ref: DependencyRef): boolean {
  const fields = [ref.request_id, ref.instance_id, ref.artifact_ref];
  return fields.some((field) => typeof field === 'string' && field.length > 0);
}

function dedupe<T extends string>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 判定（纯函数，不抛错）
// ---------------------------------------------------------------------------

/**
 * 判定一次状态转换。**纯函数**：不修改入参，不抛错；拒绝时 `next === null` 并给出结构化拒因。
 *
 * 判定顺序（顺序即优先级，测试依赖它给出确定性拒因）：
 * 1. 目标状态必须是六态之一 → `unknown_status`
 * 2. 发起方核对（复用 `evaluateOrigin` → protocol 的 `evaluateRunOwnership`）
 *    → `ownership_rejected` / `stale_task_revision`(轮次级) / `task_scope_mismatch`(范围) /
 *    `stale_task_revision`(工作项版本) / `owner_mismatch`
 * 3. 当前项是终态 → `terminal_locked`（终态不可被任何发起方回退）
 * 4. 转换表 → `illegal_transition`
 * 5. 目标状态的结局证据（原因/依赖/结果引用）→ `missing_*`
 * 6. 候选新项通过 `assertWorkItemInvariants()` → 否则 `invariant_violation`
 */
export function evaluateWorkItemTransition(request: WorkItemTransitionRequest): TransitionVerdict {
  const { item, to } = request;

  if (!isWorkItemStatus(to)) {
    return reject(item, to, 'unknown_status', `目标状态取值非法：${String(to)}`);
  }

  const originVerdict = evaluateOrigin(request.origin, item);
  if (!originVerdict.allowed) {
    return reject(
      item,
      to,
      originVerdict.reason ?? 'ownership_rejected',
      originVerdict.detail,
      originVerdict.ownership_reason,
    );
  }

  if (isTerminalStatus(item.status)) {
    return reject(
      item,
      to,
      'terminal_locked',
      `工作项 ${item.request_id} 已是终态 ${item.status}，不得被改写或回退` +
        `（重开须新建工作项，Q4-b）`,
    );
  }

  if (!canTransition(item.status, to)) {
    return reject(item, to, 'illegal_transition', `非法的状态转换：${item.status} → ${to}`);
  }

  // --- 目标状态的结局证据 ---
  // 省略 = 沿用旧项；显式传 null/[] = 清空（清空必须被守卫拦住，故这里不做 `??` 兜底）。
  const blocker: BlockerReason | null = hasOwn(request, 'blocker_reason')
    ? (request.blocker_reason ?? null)
    : (item.blocker_reason ?? null);
  const dependencyRefs: readonly DependencyRef[] = hasOwn(request, 'dependency_refs')
    ? (request.dependency_refs ?? [])
    : item.dependency_refs;
  const failureReason = request.failure_reason ?? null;
  const cancellationReason = request.cancellation_reason ?? null;

  if (!isTerminalStatus(to)) {
    if (blocker === null || !isValidBlockerKind(blocker.kind) || blocker.detail.trim().length === 0) {
      return reject(
        item,
        to,
        'missing_blocker_reason',
        `转到非终态 ${to} 必须给出合法的 blocker_reason（含非空 detail）`,
      );
    }
    if (
      to === 'waiting_dependency' &&
      !dependencyRefs.some(isAttributableDependencyRef)
    ) {
      return reject(
        item,
        to,
        'missing_dependency_ref',
        '转到 waiting_dependency 必须登记至少一个可指认的依赖对象（P4-02）',
      );
    }
  }

  if (to === 'failed' && (failureReason === null || failureReason.trim().length === 0)) {
    return reject(item, to, 'missing_failure_reason', '转到 failed 必须给出非空的 failure_reason');
  }

  if (to === 'cancelled') {
    if (cancellationReason === null || cancellationReason.trim().length === 0) {
      return reject(
        item,
        to,
        'missing_cancellation_reason',
        '转到 cancelled 必须给出非空的 cancellation_reason（P4-09）',
      );
    }
    if (
      request.cancellation_blocker_kind !== undefined &&
      !isValidBlockerKind(request.cancellation_blocker_kind)
    ) {
      return reject(
        item,
        to,
        'invalid_blocker_kind',
        `取消原因的类别非法：${String(request.cancellation_blocker_kind)}`,
      );
    }
  }

  if (to === 'completed') {
    const completion = request.completion;
    if (completion === undefined || completion.result_refs.length === 0) {
      return reject(
        item,
        to,
        'missing_result_ref',
        '转到 completed 必须给出至少一个结果引用（P4-10 / A03-10）',
      );
    }
    if (completion.request_id !== item.request_id) {
      return reject(
        item,
        to,
        'result_request_mismatch',
        `结果引用答复的是 ${completion.request_id}，但本工作项是 ${item.request_id}`,
      );
    }
  }

  // --- 构造候选新项（终态原因归位）---
  const nextBlocker: BlockerReason | null = !isTerminalStatus(to)
    ? blocker
    : to === 'cancelled'
      ? { kind: request.cancellation_blocker_kind ?? 'other', detail: cancellationReason ?? '' }
      : // failed 允许保留 blocker_reason（如 capability_missing，Q2-c 要求可观测）；completed 清空。
        to === 'failed'
        ? (request.blocker_reason ?? null)
        : null;

  const nextFailure = to === 'failed' ? failureReason : null;

  const nextResultRefs: readonly ArtifactRef[] =
    to === 'completed' && request.completion !== undefined
      ? dedupe([...item.result_refs, ...request.completion.result_refs])
      : item.result_refs;

  let next: WorkItem;
  try {
    next = createWorkItem({
      request_id: item.request_id,
      task_id: item.task_id,
      task_revision: item.task_revision,
      owner_instance_id: item.owner_instance_id,
      description: item.description,
      expected_output: item.expected_output,
      status: to,
      dependency_refs: dependencyRefs,
      result_refs: nextResultRefs,
      blocker_reason: nextBlocker,
      failure_reason: nextFailure,
      triggering_message_ids: dedupe([
        ...item.triggering_message_ids,
        ...(request.add_triggering_message_ids ?? []),
      ]),
      included_in_snapshot: item.included_in_snapshot || request.snapshot_run_id !== undefined,
      snapshot_run_ids:
        request.snapshot_run_id === undefined
          ? item.snapshot_run_ids
          : dedupe([...item.snapshot_run_ids, request.snapshot_run_id]),
      supersedes_request_id: item.supersedes_request_id,
      created_at: item.created_at,
      updated_at: request.at,
    });
    // 形状不变量不可绕过：这一步是"转换路径上保证 assertWorkItemInvariants 不被绕过"的落点。
    assertWorkItemInvariants(next);
  } catch (error) {
    // 防御分支：正常路径下守卫已覆盖，这里兜住"输入记录损坏 / 实现回归"两种情况。
    return reject(
      item,
      to,
      'invariant_violation',
      `候选工作项构造或不变量校验失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { ok: true, from: item.status, to, rejection: null, next };
}

/**
 * 应用一次转换：允许则返回新工作项，拒绝则抛 `WorkLedgerError`（`accepted === false`）。
 *
 * **不修改入参**：`item` 是不可变对象，调用方拿到的是全新对象；被拒时没有任何状态变更。
 */
export function applyWorkItemTransition(request: WorkItemTransitionRequest): WorkItem {
  const verdict = evaluateWorkItemTransition(request);
  if (!verdict.ok || verdict.next === null) {
    const rejection = verdict.rejection;
    throw new WorkLedgerError(
      rejection?.reason ?? 'invariant_violation',
      rejection?.message ?? '转换被拒绝',
      rejection?.ownership_reason ?? null,
    );
  }
  return verdict.next;
}

// ---------------------------------------------------------------------------
// Q4-a："已读" ≠ "已完成"
// ---------------------------------------------------------------------------

/**
 * 登记"本工作项已被轮次 `runId` 的输入快照读入"。
 *
 * **硬约束：绝不改变 `status`**（合同 §九-5、P4-01）。
 * 读入只是"这轮看过它"，结局一律由显式转换写入——这正是本模块要能被正向观测的那一点。
 */
export function markWorkItemReadBySnapshot(
  item: WorkItem,
  runId: RunId,
  at: LogicalTime,
): WorkItem {
  return createWorkItem({
    request_id: item.request_id,
    task_id: item.task_id,
    task_revision: item.task_revision,
    owner_instance_id: item.owner_instance_id,
    description: item.description,
    expected_output: item.expected_output,
    status: item.status, // 显式保持不变
    dependency_refs: item.dependency_refs,
    result_refs: item.result_refs,
    blocker_reason: item.blocker_reason,
    failure_reason: item.failure_reason,
    triggering_message_ids: item.triggering_message_ids,
    included_in_snapshot: true,
    snapshot_run_ids: dedupe([...item.snapshot_run_ids, runId]),
    supersedes_request_id: item.supersedes_request_id,
    created_at: item.created_at,
    updated_at: at,
  });
}

/**
 * 按某一轮的冻结快照批量登记"读入"。
 * 只影响 `run.frozen_request_ids` 中包含的工作项；其余原样返回（同一顺序、同一引用）。
 */
export function markWorkItemsReadBySnapshot(
  items: readonly WorkItem[],
  run: RunRecord,
  at: LogicalTime,
): readonly WorkItem[] {
  const frozen = new Set<RequestId>(run.frozen_request_ids);
  return items.map((item) =>
    frozen.has(item.request_id) ? markWorkItemReadBySnapshot(item, run.run_id, at) : item,
  );
}

/** 读过但未完成的工作项（P4-01 的正面观测：`included_in_snapshot` 且状态不是 completed）。 */
export function findReadButNotCompleted(items: readonly WorkItem[]): readonly WorkItem[] {
  return items.filter((item) => item.included_in_snapshot && item.status !== 'completed');
}

// ---------------------------------------------------------------------------
// Q4-b：失败/取消后重开 = 新建工作项
// ---------------------------------------------------------------------------

export interface ReopenWorkItemInput {
  /** 被接续的旧项（必须是 `failed` 或 `cancelled` 的终态项）。 */
  readonly previous: WorkItem;
  /** 新工作项的 request_id（必须与旧项不同）。 */
  readonly new_request_id: RequestId;
  readonly at: LogicalTime;
  /** 新项的等待/阻塞原因（新建即非终态，必须有原因）。 */
  readonly blocker_reason: BlockerReason;
  /** 负责人；省略时沿用旧项负责人。 */
  readonly owner_instance_id?: InstanceId;
  readonly description?: string;
  readonly expected_output?: string;
  readonly dependency_refs?: readonly DependencyRef[];
  readonly add_triggering_message_ids?: readonly MessageId[];
  readonly task_revision?: Revision;
}

/**
 * 由失败/取消的旧项**新建**一个工作项（Q4-b）。
 *
 * 硬约束：
 * - 旧项必须是终态 `failed` / `cancelled`，否则拒绝（`reopen_requires_terminal`）；
 * - `new_request_id` 必须与旧项不同（`reopen_same_request_id`）；
 * - 新项 `supersedes_request_id = previous.request_id`，状态 `pending`；
 * - **返回的只有新项**：旧项对象不被触及，其状态保持终态（不回退）。
 */
export function createReopenedWorkItem(input: ReopenWorkItemInput): WorkItem {
  const { previous } = input;

  if (!isReopenableStatus(previous.status)) {
    throw new WorkLedgerError(
      'reopen_requires_terminal',
      `只有 failed / cancelled 的旧项可以重开，当前状态是 ${previous.status}`,
    );
  }
  if (input.new_request_id === previous.request_id) {
    throw new WorkLedgerError(
      'reopen_same_request_id',
      `重开必须新建工作项：new_request_id 不得等于旧项 ${previous.request_id}`,
    );
  }
  if (!isValidBlockerKind(input.blocker_reason.kind) || input.blocker_reason.detail.trim().length === 0) {
    throw new WorkLedgerError('missing_blocker_reason', '重开的新项必须带合法的 blocker_reason');
  }

  const reopened = createWorkItem({
    request_id: input.new_request_id,
    task_id: previous.task_id,
    task_revision: input.task_revision ?? previous.task_revision,
    owner_instance_id: input.owner_instance_id ?? previous.owner_instance_id,
    description: input.description ?? previous.description,
    expected_output: input.expected_output ?? previous.expected_output,
    status: 'pending',
    dependency_refs: input.dependency_refs ?? [],
    blocker_reason: input.blocker_reason,
    triggering_message_ids: input.add_triggering_message_ids ?? [],
    supersedes_request_id: previous.request_id,
    created_at: input.at,
    updated_at: input.at,
  });
  assertWorkItemInvariants(reopened);
  return reopened;
}

/** 判定 `successor` 是否是 `predecessor` 的重开项。 */
export function isReopenOf(predecessor: WorkItem, successor: WorkItem): boolean {
  return successor.supersedes_request_id === predecessor.request_id;
}

// ---------------------------------------------------------------------------
// 结局汇总（P4-03 / P4-04 / P4-09 / P4-11；证据输出用）
// ---------------------------------------------------------------------------

export interface WorkItemOutcome {
  readonly request_id: RequestId;
  readonly owner_instance_id: InstanceId;
  readonly status: WorkItemStatus;
  readonly terminal: boolean;
  /** 终态且有对应结局证据（完成→结果引用；失败→失败原因；取消→取消原因）。 */
  readonly has_outcome: boolean;
  /** 非终态且有可指认的等待/阻塞原因。 */
  readonly has_wait_reason: boolean;
  /** Q4-a：是否已被至少一轮快照读入（读入 ≠ 完成）。 */
  readonly read_in_snapshot: boolean;
  readonly snapshot_run_ids: readonly RunId[];
  readonly blocker_reason: BlockerReason | null;
  readonly failure_reason: string | null;
  readonly cancellation_reason: string | null;
  readonly result_refs: readonly ArtifactRef[];
  readonly dependency_refs: readonly DependencyRef[];
  readonly supersedes_request_id: RequestId | null;
  readonly violations: readonly OutcomeViolation[];
}

/** 单项工作的结局摘要（P4-03 负责人、P4-09 结局完整性、Q4-a 读入状态）。 */
export function describeWorkItemOutcome(item: WorkItem): WorkItemOutcome {
  return {
    request_id: item.request_id,
    owner_instance_id: item.owner_instance_id,
    status: item.status,
    terminal: isTerminalStatus(item.status),
    has_outcome: hasExplicitOutcome(item),
    has_wait_reason: hasWaitReason(item),
    read_in_snapshot: item.included_in_snapshot,
    snapshot_run_ids: item.snapshot_run_ids,
    blocker_reason: item.blocker_reason,
    failure_reason: item.failure_reason,
    cancellation_reason: cancellationReasonOf(item),
    result_refs: item.result_refs,
    dependency_refs: item.dependency_refs,
    supersedes_request_id: item.supersedes_request_id,
    violations: evaluateOutcomeCompleteness(item),
  };
}

export interface WorkLedgerSummary {
  readonly total: number;
  /** P4-04：六态各自的项数（枚举外取值不出现时，各键之和 = total）。 */
  readonly status_distribution: Readonly<Record<WorkItemStatus, number>>;
  readonly terminal_count: number;
  readonly non_terminal_count: number;
  /** 非终态项的等待/阻塞原因（逐项，P4-02 的"在等哪一项"）。 */
  readonly wait_reasons: readonly {
    readonly request_id: RequestId;
    readonly status: WorkItemStatus;
    readonly blocker: BlockerReason | null;
    readonly dependency_refs: readonly DependencyRef[];
  }[];
  /**
   * R3 观测量：**阻塞原因分布**——按 `BlockerKind` 统计项数（逐项原因见 `wait_reasons`）。
   * 覆盖终态项携带的 blocker（如 `failed` + `capability_missing`，Q2-c，见合同 R9）。
   */
  readonly blocker_kind_distribution: Readonly<Partial<Record<BlockerKind, number>>>;
  /** 守恒违例：正常应为空数组（P4-09：不存在"既无结局也无原因"的项）。 */
  readonly violations: readonly OutcomeViolation[];
  /** 每项工作的结局摘要。 */
  readonly outcomes: readonly WorkItemOutcome[];
}

/** 汇总工作承诺表（状态分布、等待原因、结局完整性违例）。 */
export function summarizeWorkLedger(items: readonly WorkItem[]): WorkLedgerSummary {
  const distribution = {} as Record<WorkItemStatus, number>;
  for (const status of WORK_ITEM_STATUSES) {
    distribution[status] = 0;
  }

  const outcomes = items.map(describeWorkItemOutcome);
  const violations: OutcomeViolation[] = [];
  const waitReasons: {
    request_id: RequestId;
    status: WorkItemStatus;
    blocker: BlockerReason | null;
    dependency_refs: readonly DependencyRef[];
  }[] = [];

  const blockerKinds: Partial<Record<BlockerKind, number>> = {};

  let terminalCount = 0;
  let nonTerminalCount = 0;

  for (const outcome of outcomes) {
    if (isWorkItemStatus(outcome.status)) {
      distribution[outcome.status] += 1;
    }
    if (outcome.terminal) {
      terminalCount += 1;
    } else {
      nonTerminalCount += 1;
      waitReasons.push({
        request_id: outcome.request_id,
        status: outcome.status,
        blocker: outcome.blocker_reason,
        dependency_refs: outcome.dependency_refs,
      });
    }
    // 阻塞原因分布对**终态与非终态一视同仁**：`failed` + `capability_missing` 也是阻塞原因（合同 R9）。
    const blocker = outcome.blocker_reason;
    if (blocker !== null && isValidBlockerKind(blocker.kind)) {
      blockerKinds[blocker.kind] = (blockerKinds[blocker.kind] ?? 0) + 1;
    }
    violations.push(...outcome.violations);
  }

  return {
    total: items.length,
    status_distribution: distribution,
    terminal_count: terminalCount,
    non_terminal_count: nonTerminalCount,
    wait_reasons: waitReasons,
    blocker_kind_distribution: blockerKinds,
    violations,
    outcomes,
  };
}

/**
 * 守恒判据（P4-09）：既不是终态（无结局）、又没有可指认等待原因的工作项。
 * 正常应为空数组。
 */
export function findRequestsWithoutOutcome(items: readonly WorkItem[]): readonly RequestId[] {
  return items
    .filter((item) => !isTerminalStatus(item.status) && !hasWaitReason(item))
    .map((item) => item.request_id);
}

/**
 * 守恒判据（P4-11）：收件箱中的工作请求在承诺表里没有对应项。
 * 本函数**不依赖收件箱模块**（D02）：调用方传入它看到的 request_id 集合即可。
 */
export function findRequestsMissingWorkItem(
  requestIds: readonly RequestId[],
  items: readonly WorkItem[],
): readonly RequestId[] {
  const known = new Set<RequestId>(items.map((item) => item.request_id));
  return dedupe(requestIds).filter((requestId) => !known.has(requestId));
}

/** 按负责人分组（P4-03：每项都归属到具体实例）。 */
export function groupWorkItemsByOwner(
  items: readonly WorkItem[],
): ReadonlyMap<InstanceId, readonly WorkItem[]> {
  const grouped = new Map<InstanceId, WorkItem[]>();
  for (const item of items) {
    const bucket = grouped.get(item.owner_instance_id);
    if (bucket === undefined) {
      grouped.set(item.owner_instance_id, [item]);
    } else {
      bucket.push(item);
    }
  }
  return grouped;
}

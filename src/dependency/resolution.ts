/**
 * **依赖解除**与**循环停止**的转换计划（D05；P5；合同 Q5-c、§九-6；R14 #3）。
 *
 * 本文件**不实现状态机**（那是 D04 的 `src/workledger`）：它只是把诊断结论翻译成
 * **D04 的转换请求**（`evaluateWorkItemTransition`），并把"新的可运行输入"通过
 * **注入端口**交给调用方（见 `ports.ts`）。
 *
 * ## R14 #3（D04 的裁决，必须遵守）
 * 依赖解除后的正确路径是 **`waiting_dependency → processing`**，由**下一轮运行**再出终态。
 * `waiting_dependency → completed` 是**非法转换**（D04 的转换表里出边为 `[]`）。
 * 本文件的 `planDependencyResolution()` 生成的就是 `→ processing`。
 *
 * ## 循环停止（A05-12）
 * 循环依赖按合同 Q9-c **报告**处理。两种落地形态（可配，默认 `report_failed`）：
 * - `report_failed`：环上各项 → `failed`（`failure_reason` 说明环路径，`blocker_reason.kind = cycle_detected`）；
 * - `pause_marker`：环上各项 → 保持 `waiting_dependency`，仅把 `blocker_reason.kind` 改为 `cycle_detected`
 *   （非终态自环，D04 允许"只更新元数据"）。
 *
 * **两种形态都不得是 `completed`**：`completed` 只能由 `processing` 到达（D04 转换表），
 * 而环上的项停在等待态、没有产出任何结果引用。
 */

import {
  asArtifactRef,
  createWorkItem,
  isTerminalStatus,
  type BlockerKind,
  type BlockerReason,
  type DependencyRef,
  type GroupId,
  type LogicalTime,
  type RequestId,
  type Revision,
  type TaskId,
  type WorkItem,
} from '../protocol/index.js';
import { evaluateWorkItemTransition, type TransitionVerdict } from '../workledger/index.js';
import { DependencyError } from './errors.js';
import {
  compareStrings,
  dependencyIdTags,
  evaluateDependenciesWithIndex,
  findDependencyCycles,
  indexWorkItems,
  isDependencyBlocked,
  uniqueSorted,
  type DependencyEvaluationOptions,
} from './graph.js';
import type { DependencyResolutionNotice, DependencyResolutionPort } from './ports.js';
import { scopeWorkItems, type DependencyScope } from './scope.js';

// ---------------------------------------------------------------------------
// 依赖解除
// ---------------------------------------------------------------------------

export interface DependencyResolutionOptions extends DependencyEvaluationOptions {
  /** 本次解除的逻辑时刻（写入 `updated_at`）。 */
  readonly at: LogicalTime;
  /** 组别（透传到通知里；`WorkItem` 本身不带组别）。 */
  readonly group_id?: GroupId | null;
  /** 转入 `processing` 时携带的阻塞原因类别（protocol 要求非终态必须有 blocker_reason），默认 `other`。 */
  readonly resolved_blocker_kind?: BlockerKind;
  /**
   * **作用域限定**（合同 v1.2 R37.4 / F03）：只对"当前任务 + 当前版本"的项计算解除计划。
   *
   * 语义同 `scope.ts`；未给时与旧行为逐位一致。
   * 收窄后的集合同时用于依赖图、环检测与通知——**不得**让别的任务 / 旧版本的 `completed`
   * 误满足当前依赖（R37.2）。
   */
  readonly scope?: DependencyScope | null;
}

export interface DependencyResolutionPlan {
  /** 因依赖解除而**新产生的可运行输入**（逐实例、逐工作项一条）。 */
  readonly notices: readonly DependencyResolutionNotice[];
  /** 对应的转换判定（`waiting_dependency → processing`）；调用方据此 `tx.putWorkItem(verdict.next)`。 */
  readonly transitions: readonly TransitionVerdict[];
  readonly resolvable_request_ids: readonly RequestId[];
  /** 仍缺依赖、继续等待的项（**不得**产生唤醒，避免无新输入的空转）。 */
  readonly still_waiting_request_ids: readonly RequestId[];
  /** 处于环上的项：**不得**产生唤醒（环要停止而不是继续互唤）。 */
  readonly cycle_request_ids: readonly RequestId[];
}

/**
 * **依赖解除输入身份**的唯一构造处（合同 v1.2 R37.3 / R37.4；修复批 F03 / F09 / F10）。
 *
 * 构造规则（**确定性**，本模块单测固定它）：
 * ```
 * input_ref_id = 'dep-resolved:' + JSON.stringify([
 *   String(task_id),
 *   Number(task_revision),
 *   String(request_id),
 *   uniqueSorted(resolved_dependency_ids),   // 升序去重 ⇒ 与入参顺序无关
 * ])
 * ```
 * 例：`dep-resolved:["T1",1,"req-LA",["req:req-LB"]]`
 *
 * 用 JSON 数组编码（与阻塞指纹同一手法）：无歧义（id 里出现分隔符也不会撞）、无控制字符。
 *
 * ## 为什么要含这四项
 * - `task_id` + `task_revision`：区分**同一 request 在不同任务 / 版本**下的解除
 *   ——历史通知（旧版本）重放不得重置消费状态（F09 / F10）；
 * - `request_id`：区分**同一批解除**唤醒的是哪个工作项（两个等待者不应共用一个身份）；
 * - `resolved_dependency_ids`（解除对象）：区分**同一请求的两次不同解除**
 *   ——因此**不是**"永久禁止同请求的未来解除"；只有"同一请求 + 同版本 + 同一解除对象集合"
 *   的重放才会得到同一身份（那正是应当幂等去重的"旧通知重试"）。
 */
export function resolutionInputRefId(params: {
  readonly task_id: TaskId;
  readonly task_revision: Revision;
  readonly request_id: RequestId;
  readonly resolved_dependency_ids: readonly string[];
}): string {
  const resolved = uniqueSorted(params.resolved_dependency_ids);
  return `dep-resolved:${JSON.stringify([
    String(params.task_id),
    Number(params.task_revision),
    String(params.request_id),
    resolved,
  ])}`;
}

/**
 * 计算依赖解除计划。**纯函数**：不写存储、不调用端口。
 * 调用方（D03 / 夹具）拿到计划后：`tx.putWorkItem(next)` + `deliverResolutionNotices(port, plan.notices)`。
 *
 * 传 `scope` 时只对"当前任务 + 当前版本"的项计算（R37.4 / F03）；未传时与旧实现逐位一致。
 */
export function planDependencyResolution(
  items: readonly WorkItem[],
  options: DependencyResolutionOptions,
): DependencyResolutionPlan {
  // 作用域限定（R37.2 / R37.4）：依赖图、环检测、通知与转换使用**同一范围**。
  // 未给 scope ⇒ 原样返回入参（既有调用方语义不变）。
  const scopedItems = scopeWorkItems(items, options.scope ?? null);
  const byId = indexWorkItems(scopedItems);
  const cyclicIds = new Set<string>(findDependencyCycles(scopedItems).flatMap((c) => c.request_ids));
  const blockerKind: BlockerKind = options.resolved_blocker_kind ?? 'other';

  const notices: DependencyResolutionNotice[] = [];
  const transitions: TransitionVerdict[] = [];
  const resolvableIds: RequestId[] = [];
  const stillWaiting: RequestId[] = [];

  for (const item of scopedItems) {
    if (!isDependencyBlocked(item)) {
      continue;
    }
    if (cyclicIds.has(item.request_id)) {
      continue; // 环上的项交给 planCycleStop，不允许在此被"唤醒"
    }
    const evaluation = evaluateDependenciesWithIndex(item, byId, options);
    if (!evaluation.resolvable) {
      stillWaiting.push(item.request_id);
      continue;
    }

    const resolvedTags = uniqueSorted(
      evaluation.refs.filter((r) => r.state === 'satisfied').flatMap((r) => dependencyIdTags([r.ref])),
    );
    if (resolvedTags.length === 0) {
      // 防御：resolvable 蕴含至少一项依赖，此处不应到达。
      throw new DependencyError(
        `工作项 ${item.request_id} 被判为可解除，但解除的依赖标识为空——依赖判定自相矛盾`,
      );
    }

    const verdict = evaluateWorkItemTransition({
      item,
      to: 'processing',
      at: options.at,
      origin: { kind: 'kernel', note: '依赖解除：产生新的可运行输入（Q5-c）' },
      blocker_reason: {
        kind: blockerKind,
        detail:
          `依赖已解除（${resolvedTags.join(',')}），进入处理；` +
          `终态由下一轮运行产出（R14 #3：waiting_dependency → processing）`,
      },
    });

    if (!verdict.ok || verdict.next === null) {
      throw new DependencyError(
        `依赖解除的转换被拒绝：${item.request_id} waiting_dependency → processing，` +
          `拒因 ${verdict.rejection?.reason ?? 'unknown'}（${verdict.rejection?.message ?? ''}）`,
      );
    }

    resolvableIds.push(item.request_id);
    transitions.push(verdict);
    const frozenTags = Object.freeze(resolvedTags);
    notices.push(
      Object.freeze({
        instance_id: item.owner_instance_id,
        request_id: item.request_id,
        task_id: item.task_id,
        task_revision: item.task_revision,
        resolved_dependency_ids: frozenTags,
        input_ref_id: resolutionInputRefId({
          task_id: item.task_id,
          task_revision: item.task_revision,
          request_id: item.request_id,
          resolved_dependency_ids: frozenTags,
        }),
        remaining_dependency_count: 0,
        resolved_at: options.at,
        group_id: options.group_id ?? null,
      }),
    );
  }

  return {
    notices: Object.freeze(notices),
    transitions: Object.freeze(transitions),
    resolvable_request_ids: Object.freeze(resolvableIds.sort(compareStrings)),
    still_waiting_request_ids: Object.freeze(stillWaiting.sort(compareStrings)),
    cycle_request_ids: Object.freeze(uniqueSorted([...cyclicIds]) as RequestId[]),
  };
}

/**
 * 把计划里的通知交付给**注入端口**。
 * 返回交付条数；`port` 为空时原样返回 0（夹具可只要计划、不起端口）。
 */
export function deliverResolutionNotices(
  port: DependencyResolutionPort | null | undefined,
  notices: readonly DependencyResolutionNotice[],
): number {
  if (port === null || port === undefined) {
    return 0;
  }
  for (const notice of notices) {
    port.onDependencyResolved(notice);
  }
  return notices.length;
}

/**
 * 计划把某项转为**等待依赖**（D03 的轮次发现"要先拿到别人的结果"时调用）。
 *
 * 硬约束（D04 会在此拒绝）：至少一项**可指认**的依赖引用，否则 `missing_dependency_ref`。
 * 该转换**不写任何状态**——调用方拿 `verdict.next` 自行入库。
 */
export function planBlockOnDependency(
  item: WorkItem,
  dependencyRefs: readonly DependencyRef[],
  options: { readonly at: LogicalTime; readonly reason?: string },
): TransitionVerdict {
  const detail =
    options.reason ??
    `等待依赖结果：${dependencyIdTags(dependencyRefs).join(',') || '（未登记依赖对象）'}`;
  return evaluateWorkItemTransition({
    item,
    to: 'waiting_dependency',
    at: options.at,
    origin: { kind: 'kernel', note: '轮次发现需先获得依赖结果（§九-6：保留原因、释放运行资源）' },
    blocker_reason: { kind: 'waiting_dependency', detail },
    dependency_refs: dependencyRefs,
  });
}

// ---------------------------------------------------------------------------
// 循环停止
// ---------------------------------------------------------------------------

export const CYCLE_STOP_MODES = ['report_failed', 'pause_marker'] as const;
export type CycleStopMode = (typeof CYCLE_STOP_MODES)[number];

export interface CycleStopOptions {
  readonly at: LogicalTime;
  /** 停止形态；默认 `report_failed`（对应 Q9-c 的"报告"）。 */
  readonly mode?: CycleStopMode;
  /**
   * **受控缺陷注入（R7 / Q9-c，默认关闭）**：把环上的项**绕过状态机**直接造成 `completed`。
   *
   * 用途：证明 A05-12「循环停止后不得被标为已完成」这条断言**真会失败**。
   * 注意：诚实路径其实**做不到**这件事——`waiting_dependency → completed` 在 D04 的转换表里
   * 出边为空（非法），这正是"循环即完成"不可能通过正常路径发生的结构性原因。
   */
  readonly complete_cycles_defect?: boolean;
}

export interface CycleStopPlan {
  readonly mode: CycleStopMode;
  /** 环上各项的停止转换（`failed` 或 `cycle_detected` 等待标记）。 */
  readonly transitions: readonly TransitionVerdict[];
  readonly cycle_request_ids: readonly RequestId[];
  readonly blocked_request_ids: readonly RequestId[];
  /** 受控缺陷打开时被"直接造成已完成"的项（正常为空数组）。 */
  readonly fabricated_completed: readonly WorkItem[];
}

function cyclePathsOf(items: readonly WorkItem[]): ReturnType<typeof findDependencyCycles> {
  return findDependencyCycles(items);
}

/**
 * 计划**循环停止**：把环上各项转为暂停或报告，并释放执行槽（由调用方落库 / 让实例空闲）。
 *
 * 返回的转换**只针对环上的项**；其余阻塞项（正常等待、可解除）不受影响。
 */
export function planCycleStop(
  items: readonly WorkItem[],
  options: CycleStopOptions,
): CycleStopPlan {
  const byId = indexWorkItems(items);
  const cycles = cyclePathsOf(items);
  const mode: CycleStopMode = options.mode ?? 'report_failed';
  const cyclicIds = uniqueSorted(cycles.flatMap((cycle) => cycle.request_ids)) as RequestId[];

  const cycleText = cycles
    .map((cycle) => {
      const path = [...cycle.request_ids];
      const first = path[0];
      if (first !== undefined) {
        path.push(first);
      }
      return path.join(' → ');
    })
    .join('；');

  const transitions: TransitionVerdict[] = [];
  const fabricated: WorkItem[] = [];

  for (const requestId of cyclicIds) {
    const item = byId.get(requestId);
    if (item === undefined) {
      continue;
    }
    if (isTerminalStatus(item.status)) {
      continue; // 已有终态结局的项不再改写（终态锁定，D04）
    }

    const blocker: BlockerReason = {
      kind: 'cycle_detected',
      detail: `循环依赖已判停：${cycleText}（Q9-c：按报告处理，不继续互相唤醒）`,
    };

    if (options.complete_cycles_defect === true) {
      fabricated.push(fabricateCompleted(item, blocker));
      continue;
    }

    if (mode === 'pause_marker') {
      transitions.push(
        evaluateWorkItemTransition({
          item,
          to: 'waiting_dependency',
          at: options.at,
          origin: { kind: 'kernel', note: '循环依赖：暂停并保留等待原因' },
          blocker_reason: blocker,
        }),
      );
      continue;
    }

    transitions.push(
      evaluateWorkItemTransition({
        item,
        to: 'failed',
        at: options.at,
        origin: { kind: 'kernel', note: '循环依赖：按报告处理' },
        blocker_reason: blocker,
        failure_reason: `循环依赖：${cycleText}`,
      }),
    );
  }

  return {
    mode,
    transitions: Object.freeze(transitions),
    cycle_request_ids: Object.freeze(cyclicIds),
    blocked_request_ids: Object.freeze(
      items.filter(isDependencyBlocked).map((item) => item.request_id).sort(compareStrings),
    ),
    fabricated_completed: Object.freeze(fabricated),
  };
}

/** **仅供受控缺陷注入**：绕过转换表直接造一个 `completed` 项（证明 A05-12 可被检测）。 */
function fabricateCompleted(item: WorkItem, blocker: BlockerReason): WorkItem {
  return createWorkItem({
    request_id: item.request_id,
    task_id: item.task_id,
    task_revision: item.task_revision,
    owner_instance_id: item.owner_instance_id,
    description: item.description,
    expected_output: item.expected_output,
    status: 'completed',
    dependency_refs: item.dependency_refs,
    result_refs: [asArtifactRef(`fabricated-cycle-result:${item.request_id}`)],
    blocker_reason: blocker,
    triggering_message_ids: item.triggering_message_ids,
    included_in_snapshot: item.included_in_snapshot,
    snapshot_run_ids: item.snapshot_run_ids,
    supersedes_request_id: item.supersedes_request_id,
    created_at: item.created_at,
    updated_at: item.updated_at,
  });
}

/**
 * 判据（A05-12）：找出**被错误标为已完成**的环上项。正常应为空数组。
 *
 * 同时覆盖两条路径：
 * - 计划里的转换结果（`verdict.next`）若把环上项转成 `completed`；
 * - 受控缺陷路径直接造出来的 `completed` 项。
 */
export function findFalselyCompletedByCycle(
  plan: CycleStopPlan,
  items: readonly WorkItem[],
): readonly RequestId[] {
  const byId = indexWorkItems(items);
  const offenders: RequestId[] = [];

  for (const requestId of plan.cycle_request_ids) {
    const fromItem = byId.get(requestId);
    if (fromItem !== undefined && fromItem.status === 'completed') {
      offenders.push(requestId);
    }
  }
  for (const verdict of plan.transitions) {
    if (verdict.next !== null && verdict.next.status === 'completed') {
      offenders.push(verdict.next.request_id);
    }
  }
  for (const fabricated of plan.fabricated_completed) {
    if (fabricated.status === 'completed') {
      offenders.push(fabricated.request_id);
    }
  }
  return Object.freeze(uniqueSorted([...offenders]) as RequestId[]);
}

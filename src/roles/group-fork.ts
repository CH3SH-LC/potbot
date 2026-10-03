/**
 * ROLE-02：**群内分身**（能力目录 §3；design-06 P3）。
 *
 * > 每个群组的分身负责必要的上下行、问题汇总和**有限停滞恢复**；
 * > **只得本任务必要信息**（不得拿到全部个人历史）；
 * > **不得变成所有业务的串行转发点**。
 *
 * ## 三条约束各自的可断言形态
 *
 * 1. **必要上下行**：`FORK_CHANNELS` 只有 `uplink`（群 → 前台/用户）与 `downlink`
 *    （前台/内核 → 群）两条；没有第三条"业务转发"通道。
 * 2. **只得本任务必要信息**：`buildForkContext` 是**白名单过滤**——只有
 *    `scope.visible_refs` 里且 `scope === 'task'` 的条目进得来；`personal_history`
 *    一律剔除（断言：注入 `personal_history` 条目后上下文里仍不含它们）。
 * 3. **有限停滞恢复**：`recoverStagnation` 带**事前上限** `max_attempts`；用途耗尽即
 *    `gave_up` 并`escalated: true`（交给内核/前台做诊断）。**绝不无限重试、绝不静默通过**。
 * 4. **不是串行转发点**：分身在拓扑里是**可选**边。`forkIsMandatory` 只在该拓扑**确实**
 *    把某条必需投递变成"没有分身就送不到"时才为真；只要有成员直连边，它就必须为 `false`
 *    （断言：直连拓扑下 `false` + `deliverWithoutFork` 为真）。
 *
 * ## 未接真实执行器（如实标注）
 *
 * 本模块**纯函数、零 IO**：不 import `src/inbox/**` / `src/scheduler/**`，不投递任何消息。
 * 上下行的实际投递、停滞诊断的实际执行由宿主经内核完成；本层只做**上下文裁剪**、
 * **问题汇总**、**有界恢复判定**与**拓扑判定**——**未接真实执行器**。
 */

import type { GroupId, InstanceId, LogicalTime, TaskId } from '../protocol/index.js';
import {
  requireNonEmptyString,
  type ScopedInfoItem,
  type TaskScope,
} from './types.js';

// ---------------------------------------------------------------------------
// 上下行
// ---------------------------------------------------------------------------

/** 分身仅有的两条通道（没有"业务转发"这条）。 */
export const FORK_CHANNELS = ['uplink', 'downlink'] as const;
export type ForkChannel = (typeof FORK_CHANNELS)[number];

/** 上行 / 下行的语义种类（问题、答复、状态、阻塞、恢复）。 */
export const FORK_SIGNAL_KINDS = ['question', 'answer', 'status', 'blocked', 'recovered'] as const;
export type ForkSignalKind = (typeof FORK_SIGNAL_KINDS)[number];

export interface ForkSignal {
  readonly channel: ForkChannel;
  readonly kind: ForkSignalKind;
  readonly from_instance_id: InstanceId;
  readonly task_id: TaskId;
  readonly at: LogicalTime;
  /**
   * 问题的**去重键**：同一件事被多个成员分别提出时，分身汇总成一条。
   * `kind === 'question'` 时必填；其余种类为 `null`。
   */
  readonly question_key: string | null;
  readonly text: string;
}

export function makeForkSignal(
  raw: Omit<ForkSignal, 'question_key'> & { readonly question_key?: string | null },
): ForkSignal {
  if (raw.kind === 'question') {
    requireNonEmptyString(raw.question_key, 'ForkSignal.question_key（问题汇总的去重键）');
  }
  if (!(FORK_CHANNELS as readonly string[]).includes(raw.channel)) {
    throw new RangeError(`ForkSignal.channel 必须是 ${FORK_CHANNELS.join(' | ')} 之一`);
  }
  return Object.freeze({
    channel: raw.channel,
    kind: raw.kind,
    from_instance_id: raw.from_instance_id,
    task_id: raw.task_id,
    at: raw.at,
    question_key: raw.kind === 'question' ? (raw.question_key ?? null) : null,
    text: raw.text,
  });
}

// ---------------------------------------------------------------------------
// 上下文裁剪：只得本任务必要信息
// ---------------------------------------------------------------------------

/** 一次上下文裁剪的结果（可审计：剔除了什么、为什么）。 */
export interface ForkContext {
  readonly task_id: TaskId;
  readonly group_id: GroupId;
  readonly items: readonly ScopedInfoItem[];
  /** 被剔除的条目 ref（含跨任务个人历史）——**如实记录**，不静默丢弃。 */
  readonly excluded_refs: readonly string[];
}

/**
 * 构造分身的可见上下文（**白名单 + 任务范围**双重过滤）。
 *
 * 判定顺序：
 * 1. `item.scope !== 'task'` ⇒ 剔除（**个人历史一律不可见**）；
 * 2. `item.ref` 不在 `scope.visible_refs` ⇒ 剔除（不在本任务必要范围）；
 * 3. 其余保留。
 */
export function buildForkContext(
  items: readonly ScopedInfoItem[],
  scope: TaskScope,
): ForkContext {
  const visible = new Set(scope.visible_refs);
  const kept: ScopedInfoItem[] = [];
  const excluded: string[] = [];
  for (const item of items) {
    if (item.scope !== 'task' || !visible.has(item.ref)) {
      excluded.push(item.ref);
      continue;
    }
    kept.push(item);
  }
  return Object.freeze({
    task_id: scope.task_id,
    group_id: scope.group_id,
    items: Object.freeze(kept),
    excluded_refs: Object.freeze(excluded),
  });
}

// ---------------------------------------------------------------------------
// 问题汇总
// ---------------------------------------------------------------------------

export interface AggregatedQuestion {
  readonly question_key: string;
  /** 提出该问题的成员（升序去重）。 */
  readonly asked_by: readonly InstanceId[];
  /** 最新一次提问的文本（按 `at` 取最大）。 */
  readonly latest_text: string;
  readonly latest_at: LogicalTime;
  /** 被汇总掉的重复提问次数（= 提出者数 − 1；0 表示只有一家提）。 */
  readonly merged_count: number;
}

/** 只挑出问题类信号（其余种类不参与汇总）。 */
function onlyQuestions(signals: readonly ForkSignal[]): readonly ForkSignal[] {
  return signals.filter((signal) => signal.kind === 'question');
}

/**
 * 汇总问题：**同一 `question_key` 归并成一条**，记录提出者集合与最新文本。
 * 输出按 `question_key` 升序，保证确定性（无墙钟、无随机）。
 */
export function aggregateQuestions(signals: readonly ForkSignal[]): readonly AggregatedQuestion[] {
  const byKey = new Map<string, { asked: Set<InstanceId>; text: string; at: LogicalTime }>();
  for (const signal of onlyQuestions(signals)) {
    const key = signal.question_key;
    if (key === null) {
      continue;
    }
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, { asked: new Set([signal.from_instance_id]), text: signal.text, at: signal.at });
      continue;
    }
    existing.asked.add(signal.from_instance_id);
    if (signal.at >= existing.at) {
      existing.text = signal.text;
      existing.at = signal.at;
    }
  }
  const keys = [...byKey.keys()].sort();
  return Object.freeze(
    keys.map((key) => {
      const entry = byKey.get(key) as { asked: Set<InstanceId>; text: string; at: LogicalTime };
      const asked = Object.freeze([...entry.asked].sort());
      return Object.freeze({
        question_key: key,
        asked_by: asked,
        latest_text: entry.text,
        latest_at: entry.at,
        merged_count: asked.length - 1,
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// 有限停滞恢复
// ---------------------------------------------------------------------------

/** **事前上限**：分身最多做几次恢复尝试（不设上限 = 无限重试，本层不允许）。 */
export interface ForkRecoveryBudget {
  readonly max_attempts: number;
}

export function requireForkRecoveryBudget(raw: ForkRecoveryBudget): ForkRecoveryBudget {
  if (!Number.isInteger(raw.max_attempts) || raw.max_attempts <= 0) {
    throw new RangeError('ForkRecoveryBudget.max_attempts 必须是正整数（"无上限"不是本层的选项）');
  }
  return Object.freeze({ max_attempts: raw.max_attempts });
}

export interface ForkRecoveryRequest {
  readonly budget: ForkRecoveryBudget;
  /** 已做过的恢复尝试次数（由调用方在事务里维护；本层只读）。 */
  readonly attempts_used: number;
  /** 是否观察到停滞信号（无信号 ⇒ 不动，正常等待）。 */
  readonly stagnant: boolean;
  /** 本次恢复动作的说明（如"重发下行的缺失输入请求"）。 */
  readonly action: string;
}

export const FORK_RECOVERY_OUTCOMES = ['no_signal', 'recovered', 'gave_up'] as const;
export type ForkRecoveryOutcomeKind = (typeof FORK_RECOVERY_OUTCOMES)[number];

export interface ForkRecoveryOutcome {
  readonly outcome: ForkRecoveryOutcomeKind;
  /** 本次之后的累计尝试次数（`no_signal` 不消耗额度）。 */
  readonly attempts: number;
  /** 是否**上报**给内核 / 前台（`gave_up` 必为真——有限恢复失败不能静默）。 */
  readonly escalated: boolean;
  readonly reason: string;
}

/**
 * 有界恢复判定。
 *
 * | 条件 | 结论 |
 * |---|---|
 * | 无停滞信号 | `no_signal`（正常等待，不动作、不消耗额度） |
 * | 有信号且 `attempts_used < max_attempts` | `recovered`（再做一次恢复尝试） |
 * | 有信号且额度已耗尽 | `gave_up` + `escalated: true`（交内核/前台诊断） |
 */
export function recoverStagnation(request: ForkRecoveryRequest): ForkRecoveryOutcome {
  const budget = requireForkRecoveryBudget(request.budget);
  if (!request.stagnant) {
    return Object.freeze({
      outcome: 'no_signal' as const,
      attempts: request.attempts_used,
      escalated: false,
      reason: '未观察到停滞信号：正常等待（等用户 / 等外部 / 等依赖），不做恢复动作',
    });
  }
  if (request.attempts_used >= budget.max_attempts) {
    return Object.freeze({
      outcome: 'gave_up' as const,
      attempts: request.attempts_used,
      escalated: true,
      reason:
        `有限停滞恢复已用尽（${String(request.attempts_used)}/${String(budget.max_attempts)}）：` +
        `不再重试，上报内核 / 前台做诊断（ROLE-02"有限"的含义）`,
    });
  }
  return Object.freeze({
    outcome: 'recovered' as const,
    attempts: request.attempts_used + 1,
    escalated: false,
    reason: `第 ${String(request.attempts_used + 1)} 次恢复尝试：${request.action}`,
  });
}

// ---------------------------------------------------------------------------
// 拓扑：分身**不是**串行转发点
// ---------------------------------------------------------------------------

/** 一条投递边。`via: 'fork'` 表示经分身中转；`'direct'` 表示成员/内核直连。 */
export interface DeliveryEdge {
  readonly from: InstanceId;
  readonly to: InstanceId;
  readonly via: 'fork' | 'direct';
}

export interface DeliveryTopology {
  readonly edges: readonly DeliveryEdge[];
  readonly fork_instance_id: InstanceId;
}

/** 一条必需投递（拓扑必须能送达的 from → to）。 */
export interface RequiredDelivery {
  readonly from: InstanceId;
  readonly to: InstanceId;
}

/** 只走某类边的可达性（BFS；`viaFilter` 为 null 表示不限）。 */
function reachable(
  topology: DeliveryTopology,
  from: InstanceId,
  to: InstanceId,
  viaFilter: 'fork' | 'direct' | null,
): boolean {
  if (from === to) {
    return true;
  }
  const adjacency = new Map<string, InstanceId[]>();
  for (const edge of topology.edges) {
    if (viaFilter !== null && edge.via !== viaFilter) {
      continue;
    }
    const bucket = adjacency.get(edge.from as string);
    if (bucket === undefined) {
      adjacency.set(edge.from as string, [edge.to]);
    } else {
      bucket.push(edge.to);
    }
  }
  const seen = new Set<string>([from as string]);
  const queue: InstanceId[] = [from];
  while (queue.length > 0) {
    const current = queue.shift() as InstanceId;
    for (const next of adjacency.get(current as string) ?? []) {
      if (next === to) {
        return true;
      }
      if (!seen.has(next as string)) {
        seen.add(next as string);
        queue.push(next);
      }
    }
  }
  return false;
}

/**
 * 是否存在**不经分身**的直达路径（"分身可被旁路"的判据）。
 * 只走 `via: 'direct'` 的边——把分身整条拿掉仍然能送到的，才叫旁路成立。
 */
export function deliverWithoutFork(
  topology: DeliveryTopology,
  from: InstanceId,
  to: InstanceId,
): boolean {
  return reachable(topology, from, to, 'direct');
}

/**
 * 分身是否**被迫**成为这些必需投递的唯一通道。
 *
 * 判据：存在某条必需投递，**移除全部分身边后送不到**（`deliverWithoutFork` 为假），
 * 同时**在含分身的拓扑里送得到**。只要有直连边覆盖全部必需投递，结论就是 `false`
 * ——这正是"不得变成所有业务的串行转发点"要的结构。
 *
 * 注意本函数**不是恒假**：星形拓扑（所有成员只连分身）下它会返回 `true`，
 * 那是真实的设计缺陷，应被暴露而不是被本函数掩盖。
 */
export function forkIsMandatory(
  topology: DeliveryTopology,
  required: readonly RequiredDelivery[],
): boolean {
  return required.some(
    (delivery) =>
      !deliverWithoutFork(topology, delivery.from, delivery.to) &&
      reachable(topology, delivery.from, delivery.to, null),
  );
}

/** 一条投递的路由选择结果。 */
export interface ForkRouteDecision {
  readonly route: 'direct' | 'via_fork' | 'unreachable';
  readonly from: InstanceId;
  readonly to: InstanceId;
  /** 本次投递是否**必须**经分身（`route === 'via_fork'` 且无直连旁路时为真）。 */
  readonly fork_required: boolean;
}

/**
 * 为一条投递选路：**优先直连**，直连不可达才用分身。
 *
 * 这条优先级本身就是"分身不是串行转发点"的实现——正常业务不会无谓地穿过它。
 */
export function routeForkMessage(
  topology: DeliveryTopology,
  from: InstanceId,
  to: InstanceId,
): ForkRouteDecision {
  if (deliverWithoutFork(topology, from, to)) {
    return Object.freeze({ route: 'direct' as const, from, to, fork_required: false });
  }
  if (reachable(topology, from, to, null)) {
    return Object.freeze({ route: 'via_fork' as const, from, to, fork_required: true });
  }
  return Object.freeze({ route: 'unreachable' as const, from, to, fork_required: false });
}

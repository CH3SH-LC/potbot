/**
 * 工作项依赖图：**谁在等谁**、**是否存在环**、**哪些依赖已可解除**（D05；P5）。
 *
 * 本文件是**纯函数、无状态、无 I/O**：输入是工作项集合（`readonly WorkItem[]`），
 * 输出是依赖图 / 环 / 依赖满足度。它**不**读存储、**不**碰调度器、**不**改工作项状态。
 *
 * ## 环边（cycle-forming edge）的定义——本模块区分"死锁"与"正常等待"的关键
 *
 * 只有当工作项 **正在等待依赖结果**（非终态 且 `blocker_reason.kind === 'waiting_dependency'`）
 * 且它依赖的目标**仍是未终止的工作项**时，才连一条边 `我 → 我等的那一项`。
 * 由此：
 * - 等用户 / 等外部条件（`waiting_user` / `waiting_external`）**不产生出边** ⇒ 它是一条
 *   "等待链的终点"，**不可能构成环**。这正是任务书 §10「正常等待外部条件不等于死锁」的机器形式。
 * - 依赖已终止（`completed`）的项 ⇒ 依赖已满足，不产生出边 ⇒ 等待可被解除。
 * - 依赖不在给定集合内（外部依赖 / 仅 instance / artifact 引用）⇒ 不产生出边 ⇒ 正常等待。
 *
 * 因此 A05（A 等 B、B 等 A）会得到一个二元强连通分量 ⇒ 判为环；
 * 而 A05-L（A 等 B、B 无依赖）得到一条无环链 ⇒ **判不出环**（A05-L-03 的反向约束）。
 */

import {
  isTerminalStatus,
  type BlockerKind,
  type DependencyRef,
  type InstanceId,
  type RequestId,
  type WorkItem,
  type WorkItemStatus,
} from '../protocol/index.js';
import { DependencyError } from './errors.js';

/** 稳定的字符串序（不依赖 locale，保证 Q8-c 重现性）。 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 去重并按 `compareStrings` 排序。 */
export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

// ---------------------------------------------------------------------------
// 等待类别
// ---------------------------------------------------------------------------

/**
 * 等待类别：由 `BlockerKind` 归并出的"在等什么"（比 kind 粗一档，供诊断分类使用）。
 * `terminal` / `unblocked` 不是等待。
 */
export const WAIT_CLASSES = [
  'dependency', // 等某个依赖的结果
  'user', // 等用户输入 / 确认（正常等待）
  'external', // 等外部条件（正常等待）
  'capability', // 无匹配能力
  'authorization', // 缺权限
  'budget', // 预算耗尽
  'tool_state', // 工具状态未知
  'other', // 其它阻塞
  'terminal', // 已有终态结局，不在等待
  'unblocked', // 非终态但无阻塞原因（损坏记录才会出现）
] as const;

export type WaitClass = (typeof WAIT_CLASSES)[number];

const BLOCKER_TO_WAIT_CLASS: Readonly<Record<BlockerKind, WaitClass>> = Object.freeze({
  waiting_dependency: 'dependency',
  waiting_user: 'user',
  waiting_external: 'external',
  capability_missing: 'capability',
  authorization_missing: 'authorization',
  budget_exhausted: 'budget',
  unknown_tool_state: 'tool_state',
  cycle_detected: 'other',
  other: 'other',
});

/** **正常等待**（不是死锁、也不是停滞）：等用户或外部条件（任务书 §10、Q9-c）。 */
export const NORMAL_WAIT_CLASSES: readonly WaitClass[] = Object.freeze(['user', 'external']);

/** 该项处于哪个等待类别。 */
export function waitClassOf(item: WorkItem): WaitClass {
  if (isTerminalStatus(item.status)) {
    return 'terminal';
  }
  const blocker = item.blocker_reason;
  if (blocker === null) {
    return 'unblocked';
  }
  return BLOCKER_TO_WAIT_CLASS[blocker.kind] ?? 'other';
}

/** 是否"正在等待依赖结果"（唯一会构成环边的等待）。 */
export function isDependencyBlocked(item: WorkItem): boolean {
  return waitClassOf(item) === 'dependency';
}

/** 是否"正常等待"（等用户 / 等外部条件）——A05 必须与循环区分开的另一类。 */
export function isNormalWait(item: WorkItem): boolean {
  return NORMAL_WAIT_CLASSES.includes(waitClassOf(item));
}

/** 是否"有阻塞原因的未终态项"（阻塞工作项集合的成员判据，Q9-b）。 */
export function isBlocked(item: WorkItem): boolean {
  return !isTerminalStatus(item.status) && item.blocker_reason !== null;
}

/** 该项当前是否已有终态结局。 */
export function isSettled(item: WorkItem): boolean {
  return isTerminalStatus(item.status);
}

// ---------------------------------------------------------------------------
// 依赖引用的读取
// ---------------------------------------------------------------------------

/** 依赖引用里指向的**请求 id**（去重、保序）。 */
export function dependencyRequestIds(refs: readonly DependencyRef[]): readonly RequestId[] {
  const out: RequestId[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const id = ref.request_id;
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return Object.freeze(out);
}

/**
 * 依赖引用的**带命名空间标识**（`req:` / `ins:` / `art:` 前缀）。
 * 阻塞指纹里的"依赖项 id 集合"用它：三种命名空间都算"等的是哪个标识"，
 * 前缀避免 `req:x` 与 `ins:x` 撞成同一个字符串。
 */
export function dependencyIdTags(refs: readonly DependencyRef[]): readonly string[] {
  const out: string[] = [];
  for (const ref of refs) {
    if (typeof ref.request_id === 'string' && ref.request_id.length > 0) {
      out.push(`req:${ref.request_id}`);
    }
    if (typeof ref.instance_id === 'string' && ref.instance_id.length > 0) {
      out.push(`ins:${ref.instance_id}`);
    }
    if (typeof ref.artifact_ref === 'string' && ref.artifact_ref.length > 0) {
      out.push(`art:${ref.artifact_ref}`);
    }
  }
  return Object.freeze(out);
}

/** 建立 request_id → 工作项索引；重复 id 即抛错（无法可靠算图）。 */
export function indexWorkItems(items: readonly WorkItem[]): ReadonlyMap<RequestId, WorkItem> {
  const map = new Map<RequestId, WorkItem>();
  for (const item of items) {
    if (map.has(item.request_id)) {
      throw new DependencyError(
        `重复的 request_id：${item.request_id}——同一集合内工作项身份必须唯一，否则依赖图无法可靠计算`,
      );
    }
    map.set(item.request_id, item);
  }
  return map;
}

// ---------------------------------------------------------------------------
// 依赖图与环检测
// ---------------------------------------------------------------------------

export interface DependencyEdge {
  /** 等待方（正在等依赖的那个工作项）。 */
  readonly from: RequestId;
  /** 被等待方（仍未终止的依赖项）。 */
  readonly to: RequestId;
  readonly ref: DependencyRef;
}

export interface DependencyGraph {
  /** 全部工作项 id（升序）。 */
  readonly nodes: readonly RequestId[];
  readonly edges: readonly DependencyEdge[];
  /** from → to 邻接表（去重、升序）。 */
  readonly adjacency: ReadonlyMap<RequestId, readonly RequestId[]>;
  /**
   * 等待依赖但**未构成图内边**的引用：依赖已终止、依赖不在集合内、或仅含 instance/artifact。
   * 这些是"正常等待 / 可解除"的来源，不是环边。
   */
  readonly non_edge_refs: ReadonlyMap<RequestId, readonly DependencyRef[]>;
  readonly items: ReadonlyMap<RequestId, WorkItem>;
}

/** 构造依赖图（纯函数）。重复 `request_id` 即抛 `DependencyError`。 */
export function buildDependencyGraph(items: readonly WorkItem[]): DependencyGraph {
  const byId = indexWorkItems(items);
  const nodes = [...byId.keys()].sort(compareStrings);

  const edges: DependencyEdge[] = [];
  const nonEdge = new Map<RequestId, DependencyRef[]>();

  for (const node of nodes) {
    const item = byId.get(node);
    if (item === undefined || !isDependencyBlocked(item)) {
      continue;
    }
    for (const ref of item.dependency_refs) {
      const target = ref.request_id;
      const targetItem = typeof target === 'string' ? byId.get(target) : undefined;
      if (typeof target === 'string' && targetItem !== undefined && !isTerminalStatus(targetItem.status)) {
        edges.push({ from: item.request_id, to: target, ref });
      } else {
        const bucket = nonEdge.get(item.request_id);
        if (bucket === undefined) {
          nonEdge.set(item.request_id, [ref]);
        } else {
          bucket.push(ref);
        }
      }
    }
  }

  const adjacency = new Map<RequestId, RequestId[]>();
  for (const node of nodes) {
    adjacency.set(node, []);
  }
  for (const edge of edges) {
    const bucket = adjacency.get(edge.from);
    if (bucket !== undefined && !bucket.includes(edge.to)) {
      bucket.push(edge.to);
    }
  }
  for (const bucket of adjacency.values()) {
    bucket.sort(compareStrings);
  }

  return {
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    adjacency,
    non_edge_refs: nonEdge,
    items: byId,
  };
}

export interface DependencyCycle {
  /** 环上的工作项 id（升序、去重）。 */
  readonly request_ids: readonly RequestId[];
  readonly kind: 'self_loop' | 'mutual';
}

/**
 * 迭代式 Tarjan 强连通分量（确定性：节点与邻接均按 `compareStrings` 排序）。
 * 不用递归，避免长依赖链下爆栈。返回值内部用裸字符串，调用方再品牌化。
 */
function stronglyConnectedComponents(
  nodes: readonly RequestId[],
  adjacency: ReadonlyMap<RequestId, readonly RequestId[]>,
): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  const work: { v: string; i: number }[] = [];

  for (const root of nodes) {
    if (indices.has(root)) {
      continue;
    }
    indices.set(root, index);
    lowlink.set(root, index);
    index += 1;
    stack.push(root);
    onStack.add(root);
    work.push({ v: root, i: 0 });

    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame === undefined) {
        break;
      }
      const neighbours = adjacency.get(frame.v as RequestId) ?? [];
      if (frame.i < neighbours.length) {
        const w = neighbours[frame.i] as RequestId;
        frame.i += 1;
        if (!indices.has(w)) {
          indices.set(w, index);
          lowlink.set(w, index);
          index += 1;
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          lowlink.set(frame.v, Math.min(lowlink.get(frame.v) ?? 0, indices.get(w) ?? 0));
        }
        continue;
      }

      work.pop();
      if (lowlink.get(frame.v) === indices.get(frame.v)) {
        const component: string[] = [];
        for (;;) {
          const w = stack.pop();
          if (w === undefined) {
            break;
          }
          onStack.delete(w);
          component.push(w);
          if (w === frame.v) {
            break;
          }
        }
        components.push(component);
      }
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        lowlink.set(parent.v, Math.min(lowlink.get(parent.v) ?? 0, lowlink.get(frame.v) ?? 0));
      }
    }
  }
  return components;
}

/** 找出依赖环（强连通分量 ≥2 个节点，或自环）。顺序确定，供 Q8-c 重现性使用。 */
export function findDependencyCycles(items: readonly WorkItem[]): readonly DependencyCycle[] {
  const graph = buildDependencyGraph(items);
  const components = stronglyConnectedComponents(graph.nodes, graph.adjacency);
  const cycles: DependencyCycle[] = [];

  for (const component of components) {
    if (component.length > 1) {
      cycles.push({
        request_ids: Object.freeze(component.map((id) => id as RequestId).sort(compareStrings)),
        kind: 'mutual',
      });
      continue;
    }
    const only = component[0];
    if (only !== undefined && (graph.adjacency.get(only as RequestId) ?? []).includes(only as RequestId)) {
      cycles.push({ request_ids: Object.freeze([only as RequestId]), kind: 'self_loop' });
    }
  }

  cycles.sort((a, b) => compareStrings(a.request_ids[0] ?? '', b.request_ids[0] ?? ''));
  return Object.freeze(cycles);
}

/** 环上全部工作项 id（升序去重）。 */
export function findCyclicRequestIds(items: readonly WorkItem[]): readonly RequestId[] {
  const ids = findDependencyCycles(items).flatMap((cycle) => cycle.request_ids);
  return Object.freeze(uniqueSorted(ids) as RequestId[]);
}

/** 谁在等 `requestId`（正在等待依赖 且 依赖引用里含该请求）。 */
export function dependentsOf(items: readonly WorkItem[], requestId: RequestId): readonly RequestId[] {
  return Object.freeze(
    items
      .filter(
        (item) =>
          isDependencyBlocked(item) && dependencyRequestIds(item.dependency_refs).includes(requestId),
      )
      .map((item) => item.request_id)
      .sort(compareStrings),
  );
}

// ---------------------------------------------------------------------------
// 依赖满足度
// ---------------------------------------------------------------------------

/** 单条依赖引用的状态。 */
export type DependencyRefState = 'satisfied' | 'pending' | 'failed' | 'external';

export interface DependencyRefEvaluation {
  readonly ref: DependencyRef;
  readonly state: DependencyRefState;
  /** 依赖指向的请求 id（仅 request_id 型引用非空）。 */
  readonly target: RequestId | null;
}

export interface DependencyEvaluation {
  readonly refs: readonly DependencyRefEvaluation[];
  /** 仍未满足的引用（`pending` / `failed` / `external`）。 */
  readonly unsatisfied: readonly DependencyRef[];
  /** **永不可能满足**的引用（目标已以 failed/cancelled 收场）⇒ 等待变成停滞。 */
  readonly unsatisfiable: readonly DependencyRef[];
  /** 全部依赖已满足且至少登记了一项依赖。 */
  readonly resolvable: boolean;
}

export interface DependencyEvaluationOptions {
  /** 已产出结果的请求 id（省略 = 只按集合内的 `completed` 项判定）。 */
  readonly completed_request_ids?: readonly RequestId[];
  /**
   * 已被判定满足的**依赖标识**（带或不带命名空间前缀均可）：
   * 用于判 instance / artifact 型引用，或集合外依赖的满足。
   */
  readonly satisfied_dependency_ids?: readonly string[];
}

function isMarkedSatisfied(
  ids: ReadonlySet<string>,
  candidates: readonly string[],
): boolean {
  return candidates.some((candidate) => ids.has(candidate));
}

function refStateOf(
  ref: DependencyRef,
  byId: ReadonlyMap<RequestId, WorkItem>,
  completedIds: ReadonlySet<string>,
  satisfiedIds: ReadonlySet<string>,
): DependencyRefState {
  const target = ref.request_id;
  if (typeof target === 'string' && target.length > 0) {
    const item = byId.get(target);
    if (item !== undefined) {
      if (item.status === 'completed') {
        return 'satisfied';
      }
      if (isTerminalStatus(item.status)) {
        return 'failed';
      }
      return 'pending';
    }
    if (completedIds.has(target) || isMarkedSatisfied(satisfiedIds, [target, `req:${target}`])) {
      return 'satisfied';
    }
    return 'external';
  }
  // 仅 instance / artifact 引用：只能由调用方标记满足。
  if (isMarkedSatisfied(satisfiedIds, dependencyIdTags([ref]))) {
    return 'satisfied';
  }
  return 'external';
}

/** 评估一项工作的全部依赖引用（纯函数）。 */
export function evaluateDependencies(
  item: WorkItem,
  items: readonly WorkItem[],
  options: DependencyEvaluationOptions = {},
): DependencyEvaluation {
  const byId = indexWorkItems(items);
  return evaluateDependenciesWithIndex(item, byId, options);
}

/** 已建索引的版本（批量评估时避免重复建索引）。 */
export function evaluateDependenciesWithIndex(
  item: WorkItem,
  byId: ReadonlyMap<RequestId, WorkItem>,
  options: DependencyEvaluationOptions = {},
): DependencyEvaluation {
  const completedIds = new Set<string>((options.completed_request_ids ?? []).map((id) => String(id)));
  const satisfiedIds = new Set<string>(options.satisfied_dependency_ids ?? []);

  const refs: DependencyRefEvaluation[] = item.dependency_refs.map((ref) => ({
    ref,
    state: refStateOf(ref, byId, completedIds, satisfiedIds),
    target: typeof ref.request_id === 'string' && ref.request_id.length > 0 ? ref.request_id : null,
  }));

  const unsatisfied = refs.filter((r) => r.state !== 'satisfied').map((r) => r.ref);
  const unsatisfiable = refs.filter((r) => r.state === 'failed').map((r) => r.ref);

  return {
    refs: Object.freeze(refs),
    unsatisfied: Object.freeze(unsatisfied),
    unsatisfiable: Object.freeze(unsatisfiable),
    resolvable: refs.length > 0 && unsatisfied.length === 0,
  };
}

/** 全部依赖已满足、可被解除等待（转回 `processing`）的工作项 id（升序）。 */
export function findResolvableItems(
  items: readonly WorkItem[],
  options: DependencyEvaluationOptions = {},
): readonly RequestId[] {
  const byId = indexWorkItems(items);
  return Object.freeze(
    items
      .filter(
        (item) =>
          isDependencyBlocked(item) && evaluateDependenciesWithIndex(item, byId, options).resolvable,
      )
      .map((item) => item.request_id)
      .sort(compareStrings),
  );
}

/** 依赖**永远无法满足**（目标以 failed/cancelled 收场）的工作项 id（升序）⇒ 等待已成停滞。 */
export function findUnsatisfiableItems(
  items: readonly WorkItem[],
  options: DependencyEvaluationOptions = {},
): readonly RequestId[] {
  const byId = indexWorkItems(items);
  return Object.freeze(
    items
      .filter(
        (item) =>
          isDependencyBlocked(item) &&
          evaluateDependenciesWithIndex(item, byId, options).unsatisfiable.length > 0,
      )
      .map((item) => item.request_id)
      .sort(compareStrings),
  );
}

/** 全部"正在等待依赖结果"的工作项 id（升序）。 */
export function findDependencyBlockedItems(items: readonly WorkItem[]): readonly RequestId[] {
  return Object.freeze(
    items.filter(isDependencyBlocked).map((item) => item.request_id).sort(compareStrings),
  );
}

/** 全部"有阻塞原因"的未终态工作项 id（升序）——阻塞指纹的成员判据。 */
export function findBlockedItems(items: readonly WorkItem[]): readonly RequestId[] {
  return Object.freeze(items.filter(isBlocked).map((item) => item.request_id).sort(compareStrings));
}

/** 工作项状态 → 人可读摘要（诊断原因文本用）。 */
export function describeWorkItemStatus(item: WorkItem): string {
  const status: WorkItemStatus = item.status;
  const blocker = item.blocker_reason;
  return blocker === null ? `${status}` : `${status}（${blocker.kind}: ${blocker.detail}）`;
}

/** 该实例是否是某些工作项的负责人（供诊断列出"需释放执行槽的实例"）。 */
export function ownersOf(items: readonly WorkItem[]): readonly InstanceId[] {
  const owners = new Set<InstanceId>();
  for (const item of items) {
    owners.add(item.owner_instance_id);
  }
  return Object.freeze([...owners].sort(compareStrings));
}

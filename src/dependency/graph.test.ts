/**
 * 依赖图与环检测单测（D05；P5 的一半：**谁在等谁**、**是否存在环**）。
 *
 * 本文件锁定 A05 与 A05-L 的**结构性差异**：
 * - A 等 B、B 等 A ⇒ 有环；
 * - A 等 B、B 无依赖 ⇒ 无环（正常等待，A05-L-03 的反向约束）；
 * - 阻塞原因是 `waiting_user` / `waiting_external` ⇒ **不产生出边** ⇒ 永不构成环（任务书 §10）。
 */

import { describe, expect, it } from 'vitest';

import {
  asArtifactRef,
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asRevision,
  asTaskId,
  createWorkItem,
  type BlockerReason,
  type DependencyRef,
  type WorkItem,
  type WorkItemStatus,
} from '../protocol/index.js';
import {
  buildDependencyGraph,
  dependentsOf,
  dependencyIdTags,
  dependencyRequestIds,
  findBlockedItems,
  findCyclicRequestIds,
  findDependencyBlockedItems,
  findDependencyCycles,
  findResolvableItems,
  findUnsatisfiableItems,
  indexWorkItems,
  isBlocked,
  isDependencyBlocked,
  isNormalWait,
  waitClassOf,
} from './index.js';
import { DependencyError } from './errors.js';

const TASK = asTaskId('T1');
const AT = asLogicalTime(0);

interface ItemSpec {
  readonly id: string;
  readonly owner?: string;
  readonly status?: WorkItemStatus;
  readonly revision?: number;
  readonly blocker?: BlockerReason | null;
  readonly deps?: readonly DependencyRef[];
}

/** 构造一个测试工作项（终态默认无阻塞原因；非终态默认带 `other` 阻塞原因）。 */
function wi(spec: ItemSpec): WorkItem {
  const status = spec.status ?? 'pending';
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  const blocker = spec.blocker === undefined ? (terminal ? null : { kind: 'other' as const, detail: '待调度' }) : spec.blocker;
  return createWorkItem({
    request_id: asRequestId(spec.id),
    task_id: TASK,
    task_revision: asRevision(spec.revision ?? 1),
    owner_instance_id: asInstanceId(spec.owner ?? 'I-A'),
    status,
    blocker_reason: blocker,
    dependency_refs: spec.deps ?? [],
    result_refs: status === 'completed' ? [asArtifactRef(`art-${spec.id}`)] : [],
    failure_reason: status === 'failed' ? '测试失败' : null,
    created_at: AT,
    updated_at: AT,
  });
}

const waitDep = (on: string): BlockerReason => ({ kind: 'waiting_dependency', detail: `等待 ${on} 的结果` });

/**
 * 造一个**损坏记录**（非终态却无阻塞原因）。
 * 正常构造路径（`createWorkItem`）会拒绝它，所以这里显式绕过——用于证明诊断能识别损坏输入。
 */
function malformed(base: WorkItem): WorkItem {
  return { ...base, blocker_reason: null };
}

describe('等待类别（正常等待 vs 死锁的分界线）', () => {
  it('waiting_dependency 归为 dependency；waiting_user / waiting_external 归为正常等待', () => {
    const a = wi({ id: 'A', status: 'waiting_dependency', blocker: waitDep('B'), deps: [{ request_id: asRequestId('B') }] });
    const u = wi({ id: 'U', status: 'processing', blocker: { kind: 'waiting_user', detail: '等用户确认' } });
    const e = wi({ id: 'E', status: 'processing', blocker: { kind: 'waiting_external', detail: '等外部接口' } });

    expect(waitClassOf(a)).toBe('dependency');
    expect(waitClassOf(u)).toBe('user');
    expect(waitClassOf(e)).toBe('external');
    expect(isDependencyBlocked(a)).toBe(true);
    expect(isDependencyBlocked(u)).toBe(false);
    expect(isNormalWait(u)).toBe(true);
    expect(isNormalWait(e)).toBe(true);
    expect(isNormalWait(a)).toBe(false);
  });

  it('终态不是等待；非终态无阻塞原因是损坏记录', () => {
    expect(waitClassOf(wi({ id: 'C', status: 'completed' }))).toBe('terminal');
    expect(waitClassOf(wi({ id: 'F', status: 'failed' }))).toBe('terminal');
    const broken = malformed(wi({ id: 'X', status: 'processing' }));
    expect(waitClassOf(broken)).toBe('unblocked');
    expect(isBlocked(broken)).toBe(false);
  });

  it('阻塞原因类别 → 等待类别的映射覆盖全部 9 种 BlockerKind', () => {
    const kinds = [
      'waiting_dependency',
      'waiting_user',
      'waiting_external',
      'capability_missing',
      'authorization_missing',
      'budget_exhausted',
      'unknown_tool_state',
      'cycle_detected',
      'other',
    ] as const;
    const expected = ['dependency', 'user', 'external', 'capability', 'authorization', 'budget', 'tool_state', 'other', 'other'];
    const actual = kinds.map((kind) =>
      waitClassOf(wi({ id: `k-${kind}`, status: 'processing', blocker: { kind, detail: kind } })),
    );
    expect(actual).toEqual(expected);
  });
});

describe('依赖图：谁在等谁', () => {
  it('等待未终止的依赖 ⇒ 一条边；依赖已终止 / 集合外 ⇒ 不是边', () => {
    const items = [
      wi({ id: 'A', status: 'waiting_dependency', blocker: waitDep('B'), deps: [{ request_id: asRequestId('B') }, { request_id: asRequestId('C') }, { request_id: asRequestId('OUT') }] }),
      wi({ id: 'B', status: 'processing', blocker: { kind: 'other', detail: '跑着' } }),
      wi({ id: 'C', status: 'completed' }),
    ];
    const graph = buildDependencyGraph(items);
    expect(graph.nodes).toEqual(['A', 'B', 'C']);
    expect(graph.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['A->B']);
    expect([...(graph.non_edge_refs.get(asRequestId('A')) ?? [])].map((r) => r.request_id)).toEqual(['C', 'OUT']);
    expect([...(graph.adjacency.get(asRequestId('A')) ?? [])]).toEqual([asRequestId('B')]);
  });

  it('等待用户 / 外部条件不产生出边（正常等待不是环边）', () => {
    const items = [
      // 状态是 waiting_dependency，但阻塞原因是 waiting_user ⇒ 不算"在等依赖结果"
      wi({ id: 'A', status: 'waiting_dependency', blocker: { kind: 'waiting_user', detail: '等用户' }, deps: [{ request_id: asRequestId('B') }] }),
      wi({ id: 'B', status: 'processing', blocker: { kind: 'other', detail: '跑着' } }),
    ];
    const graph = buildDependencyGraph(items);
    expect(graph.edges).toEqual([]);
    expect(findDependencyCycles(items)).toEqual([]);
  });

  it('dependentsOf 列出等待某请求的项', () => {
    const items = [
      wi({ id: 'A', status: 'waiting_dependency', blocker: waitDep('C'), deps: [{ request_id: asRequestId('C') }] }),
      wi({ id: 'B', status: 'waiting_dependency', blocker: waitDep('C'), deps: [{ request_id: asRequestId('C') }] }),
      wi({ id: 'C', status: 'processing', blocker: { kind: 'other', detail: '跑着' } }),
    ];
    expect(dependentsOf(items, asRequestId('C'))).toEqual([asRequestId('A'), asRequestId('B')]);
  });

  it('重复 request_id ⇒ 抛 DependencyError（图不可靠时不静默给结果）', () => {
    const items = [wi({ id: 'A' }), wi({ id: 'A' })];
    expect(() => buildDependencyGraph(items)).toThrow(DependencyError);
    expect(() => indexWorkItems(items)).toThrow(/重复的 request_id/);
  });

  it('dependencyRequestIds / dependencyIdTags 去重并带命名空间前缀', () => {
    const refs: readonly DependencyRef[] = [
      { request_id: asRequestId('A') },
      { request_id: asRequestId('A') },
      { instance_id: asInstanceId('I-C') },
      { artifact_ref: asArtifactRef('art-1') },
      { request_id: asRequestId('A'), artifact_ref: asArtifactRef('art-2') },
    ];
    expect(dependencyRequestIds(refs)).toEqual([asRequestId('A')]);
    expect(dependencyIdTags(refs)).toEqual([
      'req:A',
      'req:A',
      'ins:I-C',
      'art:art-1',
      'req:A',
      'art:art-2',
    ]);
  });
});

describe('环检测', () => {
  it('A05 主场景：A 等 B、B 等 A ⇒ 一个二元环', () => {
    const items = [
      wi({ id: 'A', status: 'waiting_dependency', blocker: waitDep('B'), deps: [{ request_id: asRequestId('B') }] }),
      wi({ id: 'B', status: 'waiting_dependency', blocker: waitDep('A'), deps: [{ request_id: asRequestId('A') }] }),
    ];
    const cycles = findDependencyCycles(items);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.kind).toBe('mutual');
    expect(cycles[0]?.request_ids).toEqual([asRequestId('A'), asRequestId('B')]);
    expect(findCyclicRequestIds(items)).toEqual([asRequestId('A'), asRequestId('B')]);
  });

  it('A05-L 对照：A 等 B、B 无依赖 ⇒ 无环', () => {
    const items = [
      wi({ id: 'A', status: 'waiting_dependency', blocker: waitDep('B'), deps: [{ request_id: asRequestId('B') }] }),
      wi({ id: 'B', status: 'processing', blocker: { kind: 'other', detail: '跑着' } }),
    ];
    expect(findDependencyCycles(items)).toEqual([]);
    expect(findCyclicRequestIds(items)).toEqual([]);
  });

  it('三元环与自环都能检出', () => {
    const three = [
      wi({ id: 'A', status: 'waiting_dependency', blocker: waitDep('B'), deps: [{ request_id: asRequestId('B') }] }),
      wi({ id: 'B', status: 'waiting_dependency', blocker: waitDep('C'), deps: [{ request_id: asRequestId('C') }] }),
      wi({ id: 'C', status: 'waiting_dependency', blocker: waitDep('A'), deps: [{ request_id: asRequestId('A') }] }),
    ];
    const cycles = findDependencyCycles(three);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.request_ids).toEqual([asRequestId('A'), asRequestId('B'), asRequestId('C')]);

    const selfLoop = [
      wi({ id: 'S', status: 'waiting_dependency', blocker: waitDep('S'), deps: [{ request_id: asRequestId('S') }] }),
    ];
    expect(findDependencyCycles(selfLoop)).toHaveLength(1);
    expect(findDependencyCycles(selfLoop)[0]?.kind).toBe('self_loop');
  });

  it('无环长链（A→B→C）不产生环', () => {
    const items = [
      wi({ id: 'A', status: 'waiting_dependency', blocker: waitDep('B'), deps: [{ request_id: asRequestId('B') }] }),
      wi({ id: 'B', status: 'waiting_dependency', blocker: waitDep('C'), deps: [{ request_id: asRequestId('C') }] }),
      wi({ id: 'C', status: 'processing', blocker: { kind: 'other', detail: '跑着' } }),
    ];
    expect(findDependencyCycles(items)).toEqual([]);
  });

  it('环检测结果确定（顺序与输入顺序无关）', () => {
    const mk = (order: readonly string[]): WorkItem[] =>
      order.map((id) =>
        id === 'A'
          ? wi({ id: 'A', status: 'waiting_dependency', blocker: waitDep('B'), deps: [{ request_id: asRequestId('B') }] })
          : wi({ id: 'B', status: 'waiting_dependency', blocker: waitDep('A'), deps: [{ request_id: asRequestId('A') }] }),
      );
    expect(findDependencyCycles(mk(['A', 'B']))).toEqual(findDependencyCycles(mk(['B', 'A'])));
  });

  it('环外的正常等待不被牵连', () => {
    const items = [
      wi({ id: 'A', status: 'waiting_dependency', blocker: waitDep('B'), deps: [{ request_id: asRequestId('B') }] }),
      wi({ id: 'B', status: 'waiting_dependency', blocker: waitDep('A'), deps: [{ request_id: asRequestId('A') }] }),
      wi({ id: 'U', status: 'processing', blocker: { kind: 'waiting_user', detail: '等用户' } }),
    ];
    const cycles = findDependencyCycles(items);
    expect(cycles).toHaveLength(1);
    expect(findCyclicRequestIds(items)).not.toContain(asRequestId('U'));
  });
});

describe('依赖满足度', () => {
  it('依赖已完成 ⇒ 可解除；依赖仍在跑 ⇒ 不可解除', () => {
    const done: WorkItem[] = [
      wi({ id: 'A', status: 'waiting_dependency', blocker: waitDep('B'), deps: [{ request_id: asRequestId('B') }] }),
      wi({ id: 'B', status: 'completed' }),
    ];
    const pending: WorkItem[] = [
      wi({ id: 'A', status: 'waiting_dependency', blocker: waitDep('B'), deps: [{ request_id: asRequestId('B') }] }),
      wi({ id: 'B', status: 'processing', blocker: { kind: 'other', detail: '跑着' } }),
    ];
    expect(findResolvableItems(done)).toEqual([asRequestId('A')]);
    expect(findResolvableItems(pending)).toEqual([]);
  });

  it('依赖以 failed / cancelled 收场 ⇒ 永不可能满足 ⇒ 判为 unsatisfiable', () => {
    const items: WorkItem[] = [
      wi({ id: 'A', status: 'waiting_dependency', blocker: waitDep('B'), deps: [{ request_id: asRequestId('B') }] }),
      wi({ id: 'B', status: 'failed' }),
    ];
    expect(findUnsatisfiableItems(items)).toEqual([asRequestId('A')]);
    expect(findResolvableItems(items)).toEqual([]);
  });

  it('集合外依赖可由调用方标记满足（completed_request_ids / satisfied_dependency_ids）', () => {
    const items: WorkItem[] = [
      wi({ id: 'A', status: 'waiting_dependency', blocker: waitDep('OUT'), deps: [{ request_id: asRequestId('OUT') }] }),
    ];
    expect(findResolvableItems(items)).toEqual([]);
    expect(findResolvableItems(items, { completed_request_ids: [asRequestId('OUT')] })).toEqual([asRequestId('A')]);

    const artifactDeps: WorkItem[] = [
      wi({ id: 'A', status: 'waiting_dependency', blocker: waitDep('art-1'), deps: [{ artifact_ref: asArtifactRef('art-1') }] }),
    ];
    expect(findResolvableItems(artifactDeps)).toEqual([]);
    expect(findResolvableItems(artifactDeps, { satisfied_dependency_ids: ['art:art-1'] })).toEqual([asRequestId('A')]);
  });

  it('多项依赖：全部满足才算可解除', () => {
    const items: WorkItem[] = [
      wi({
        id: 'A',
        status: 'waiting_dependency',
        blocker: waitDep('B/C'),
        deps: [{ request_id: asRequestId('B') }, { request_id: asRequestId('C') }],
      }),
      wi({ id: 'B', status: 'completed' }),
      wi({ id: 'C', status: 'processing', blocker: { kind: 'other', detail: '跑着' } }),
    ];
    expect(findResolvableItems(items)).toEqual([]);
    const resolved: WorkItem[] = [items[0]!, items[1]!, wi({ id: 'C', status: 'completed' })];
    expect(findResolvableItems(resolved)).toEqual([asRequestId('A')]);
  });

  it('findBlockedItems / findDependencyBlockedItems 的成员判据', () => {
    const items = [
      wi({ id: 'A', status: 'waiting_dependency', blocker: waitDep('B'), deps: [{ request_id: asRequestId('B') }] }),
      wi({ id: 'U', status: 'processing', blocker: { kind: 'waiting_user', detail: '等用户' } }),
      wi({ id: 'C', status: 'completed' }),
      malformed(wi({ id: 'X', status: 'processing' })),
    ];
    expect(findBlockedItems(items)).toEqual([asRequestId('A'), asRequestId('U')]);
    expect(findDependencyBlockedItems(items)).toEqual([asRequestId('A')]);
  });
});

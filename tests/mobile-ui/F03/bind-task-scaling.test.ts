/**
 * F03 验收：`bindTask` 连续绑定的**增长行为**（性能修复回归）。
 *
 * 背景：F-R04 实测 `bindTask` 连续绑定 k 个任务整体 O(k^2)（比值 21–25，线性期望 5）。
 * 两个独立的二次来源，本包已同时消除（见 `actions.ts` 顶部注释）：
 *   (a) 归属唯一检查（I4）全量扫描「全部会话 × 全部任务」⇒ 改为 taskId→conversationId 索引；
 *   (b) 任务追加 `[...view.tasks, binding]` 整拷任务数组 ⇒ 改为「基数组 + 追加链」结构共享 + 惰性物化。
 *
 * 本文件两类断言：
 *   1) **确定性**（与计时无关，最可靠）：结构共享后 `tasks` 仍按插入顺序物化；历史状态的 `tasks`
 *      不被后续绑定污染；惰性物化结果稳定；规模下重复绑定仍被拒（I4 未失守）；删除后索引被
 *      正确丢弃（被删任务的 taskId 可重新绑定，不误拒）。
 *   2) **增长守卫**（计时，交错的成对比值中位数估计器，抵消共享机器漂移）：
 *      - 「背景任务量无关」：绑定 400 个任务，背景已存在 1k vs 20k 个任务，耗时比值须 ≤5。
 *        老实现按背景扫描 ⇒ 比值约 20×；新实现 O(1) 检查 ⇒ 比值约 1×。这条**直接隔离**了
 *        被修复的扫描缺陷，且两侧绑定工作量相同，噪声影响小、门限稳。
 *      - 「整体近线性」：连续绑定 10k vs 50k（放大 5 倍）整体耗时比值须 ≤15（线性≈5、二次≈25）。
 *
 * 诚实边界：本机为六线共用的共享机器，计时仅作**同机相对比较**，不构成跨设备/真机性能承诺；
 * 计时比值本身含内存/GC 引起的轻微超线性（新实现实测约 6–11，远低于二次的约 25），
 * 故门限留有余量。Android WebView / QuickJS 的帧时间与内存峰值未测；绝对值测量见 F-R04 证据。
 */

import { describe, expect, it } from 'vitest';

import {
  ConversationError,
  bindTask,
  createConversation,
  createConversationsState,
  deleteConversation,
  getConversation,
  taskOwnership,
  tasksOf,
  type ConversationView,
  type ConversationsState,
  type DeleteScope,
  type TaskBinding,
} from '../../../apps/mobile-ui/src/conversations/index.js';

const T0 = '2026-10-03T00:00:00Z';
const FULL_SCOPE: DeleteScope = { tasks: 'retain', files: 'retain', memory: 'retain', externalActions: 'keep' };

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 构造 1 个会话、预置 k 个任务（普通数组，非结构共享视图）的列表状态。 */
function seedOneConversationWithTasks(k: number, conversationId = 'conv-0'): ConversationsState {
  const tasks: TaskBinding[] = [];
  for (let i = 0; i < k; i += 1) {
    tasks.push({ taskId: `t-${i}`, title: `任务 ${i}`, status: 'running', conversationId });
  }
  const view: ConversationView = {
    id: conversationId,
    title: '会话',
    snippet: '',
    revision: 1,
    lifecycle: 'active',
    lastActiveAt: T0,
    seq: 1,
    tasks,
  };
  return { conversations: [view], indexById: { [conversationId]: 0 }, selectedId: null, counter: 1 };
}

/**
 * 构造「1 个空目标会话 conv-target + BACKGROUND_CONVS 个背景会话」的状态，
 * 背景会话共持有 `backgroundTasks` 个任务（平均分摊）。会话数固定，使绑定目标会话时
 * `replaceConversation` 的会话数组拷贝为常数，从而让本夹具**只**放大「背景任务总量」这一个变量。
 */
const BACKGROUND_CONVS = 10;
function seedBackground(backgroundTasks: number): ConversationsState {
  const conversations: ConversationView[] = [];
  const indexById: Record<string, number> = {};
  const push = (view: ConversationView): void => {
    indexById[view.id] = conversations.length;
    conversations.push(view);
  };
  push({
    id: 'conv-target',
    title: '目标',
    snippet: '',
    revision: 1,
    lifecycle: 'active',
    lastActiveAt: T0,
    seq: 1,
    tasks: [],
  });
  const perConv = Math.ceil(backgroundTasks / BACKGROUND_CONVS);
  for (let c = 0; c < BACKGROUND_CONVS; c += 1) {
    const id = `bg-${c}`;
    const tasks: TaskBinding[] = [];
    for (let i = 0; i < perConv; i += 1) {
      tasks.push({ taskId: `bg-${c}-${i}`, title: `背景 ${c}-${i}`, status: 'running', conversationId: id });
    }
    push({ id, title: `背景会话 ${c}`, snippet: '', revision: 1, lifecycle: 'active', lastActiveAt: T0, seq: c + 2, tasks });
  }
  return { conversations, indexById, selectedId: null, counter: conversations.length };
}

/** 从给定状态起，向 conv-target 连续绑定 k 个新任务。 */
function bindInto(state0: ConversationsState, k: number, tag = 'num'): ConversationsState {
  let state = state0;
  for (let i = 0; i < k; i += 1) {
    const view = state.conversations[0];
    if (view === undefined) throw new Error('夹具异常：缺少目标会话');
    state = bindTask(state, {
      conversationId: 'conv-target',
      expectedRevision: view.revision,
      task: { taskId: `${tag}-${i}`, title: '新任务', status: 'running' },
    });
  }
  return state;
}

/** 预置 k 个任务后再连续绑定 k 个新任务（与 F-R04 `bindManyTasks` 同形，供整体增长测量）。 */
function bindManyTasks(k: number): void {
  let state = seedOneConversationWithTasks(k);
  for (let i = 0; i < k; i += 1) {
    const view = state.conversations[0];
    if (view === undefined) throw new Error('夹具异常：缺少会话');
    state = bindTask(state, {
      conversationId: view.id,
      expectedRevision: view.revision,
      task: { taskId: `t-new-${i}`, title: '新任务', status: 'running' },
    });
  }
}

// ---------------------------------------------------------------------------
// 计时工具（交错配对 + 成对比值中位数）
// ---------------------------------------------------------------------------

function timeOnce(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid] ?? 0;
  return ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/**
 * 交错配对 + **成对比值的中位数**：每轮交替跑 base/scaled 得一对并计算比值，最后取中位数。
 * 对偶发快/慢样本稳健（不是比值的最小/最大值），共享机器上比最小值/单值比更可靠。
 */
function pairedMedianRatio(
  baseFn: () => void,
  scaledFn: () => void,
  reps = 11,
): { ratio: number; medBase: number; medScaled: number } {
  baseFn();
  scaledFn(); // 预热
  const base: number[] = [];
  const scaled: number[] = [];
  const pairRatios: number[] = [];
  for (let i = 0; i < reps; i += 1) {
    const b = timeOnce(baseFn);
    const s = timeOnce(scaledFn);
    base.push(b);
    scaled.push(s);
    if (b > 0) pairRatios.push(s / b);
  }
  return { ratio: median(pairRatios), medBase: median(base), medScaled: median(scaled) };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConversationError) return error.code;
    throw error;
  }
  throw new Error('预期抛 ConversationError，但没有抛');
}

// ---------------------------------------------------------------------------
// 增长守卫
// ---------------------------------------------------------------------------

describe('F03 / bindTask 增长守卫', () => {
  it(
    '归属检查不再随背景任务量增长：背景 1k→20k（20 倍），绑定 400 个任务耗时比值 ≤5（老实现约 20×）',
    () => {
      // 预热一步以构建归属索引（O(背景任务数) 只一次），再测量「索引已就绪」后的 400 次绑定，
      // 从而隔离出「每次绑定是否仍扫描全部任务」这一个变量。
      const smallWarm = bindInto(seedBackground(1_000), 1, 'warm');
      const largeWarm = bindInto(seedBackground(20_000), 1, 'warm');
      const m = pairedMedianRatio(() => bindInto(smallWarm, 400), () => bindInto(largeWarm, 400), 11);
      console.log(
        `[F03] 背景无关性 1k=${m.medBase.toFixed(2)}ms 20k=${m.medScaled.toFixed(2)}ms 比值=${m.ratio.toFixed(2)}（老实现≈20，新实现≈1，ceiling=5）`,
      );
      expect(m.ratio).toBeLessThanOrEqual(5);
      expect(m.ratio).toBeGreaterThan(0);
    },
    120_000,
  );

  it(
    '连续绑定 k 个任务整体近线性：4k→20k（放大 5 倍）耗时比值 ≤12（线性≈5、二次≈25）',
    () => {
      const m = pairedMedianRatio(() => bindManyTasks(4_000), () => bindManyTasks(20_000), 11);
      console.log(
        `[F03] bindTask 4k=${m.medBase.toFixed(2)}ms 20k=${m.medScaled.toFixed(2)}ms 比值=${m.ratio.toFixed(2)}（放大5倍：线性≈5，二次≈25，ceiling=12）`,
      );
      expect(m.ratio).toBeLessThanOrEqual(12);
      expect(m.ratio).toBeGreaterThan(0);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// 结构共享不改语义（确定性）
// ---------------------------------------------------------------------------

describe('F03 / 结构共享不改语义（确定性断言）', () => {
  it('绑定后 tasks 仍按插入顺序物化（基数组在前、追加按序在后）', () => {
    let state = seedOneConversationWithTasks(3);
    for (const id of ['t-new-0', 't-new-1']) {
      const view = state.conversations[0];
      if (view === undefined) throw new Error('夹具异常');
      state = bindTask(state, {
        conversationId: view.id,
        expectedRevision: view.revision,
        task: { taskId: id, title: id, status: 'running' },
      });
    }
    expect(tasksOf(state, 'conv-0').map((t) => t.taskId)).toEqual([
      't-0',
      't-1',
      't-2',
      't-new-0',
      't-new-1',
    ]);
  });

  it('历史状态的 tasks 不被后续绑定污染（结构共享，非原地修改）', () => {
    const base = seedOneConversationWithTasks(2);
    const before = tasksOf(base, 'conv-0');
    const after = bindTask(base, {
      conversationId: 'conv-0',
      expectedRevision: 1,
      task: { taskId: 't-added', title: '追加', status: 'running' },
    });
    expect(tasksOf(base, 'conv-0').map((t) => t.taskId)).toEqual(['t-0', 't-1']);
    expect(tasksOf(base, 'conv-0')).toBe(before);
    expect(tasksOf(after, 'conv-0').map((t) => t.taskId)).toEqual(['t-0', 't-1', 't-added']);
    expect(tasksOf(after, 'conv-0')).not.toBe(before);
  });

  it('惰性物化结果稳定：多次读取 tasks 返回同一数组引用', () => {
    const after = bindTask(seedOneConversationWithTasks(1), {
      conversationId: 'conv-0',
      expectedRevision: 1,
      task: { taskId: 't-x', title: 'x', status: 'running' },
    });
    expect(tasksOf(after, 'conv-0')).toBe(tasksOf(after, 'conv-0'));
  });

  it('结构共享视图可被对象展开（tasks 以数据字段形式物化，不丢失）', () => {
    const after = bindTask(seedOneConversationWithTasks(1), {
      conversationId: 'conv-0',
      expectedRevision: 1,
      task: { taskId: 't-x', title: 'x', status: 'running' },
    });
    const view = getConversation(after, 'conv-0');
    if (view === null) throw new Error('夹具异常');
    const spread = { ...view };
    expect(Array.isArray(spread.tasks)).toBe(true);
    expect(spread.tasks.map((t) => t.taskId)).toEqual(['t-0', 't-x']);
  });
});

// ---------------------------------------------------------------------------
// 规模下归属唯一（I4）与索引失效处理（确定性）
// ---------------------------------------------------------------------------

describe('F03 / 规模下归属唯一（I4）与索引失效处理', () => {
  it('大规模下重复 taskId 仍被拒（I4 未因性能修复失守）', () => {
    const state = seedOneConversationWithTasks(2_000);
    expect(
      codeOf(() =>
        bindTask(state, {
          conversationId: 'conv-0',
          expectedRevision: 1,
          task: { taskId: 't-1500', title: '抢占', status: 'running' },
        }),
      ),
    ).toBe('duplicate-task-binding');
    const ok = bindTask(state, {
      conversationId: 'conv-0',
      expectedRevision: 1,
      task: { taskId: 't-fresh', title: '新', status: 'running' },
    });
    expect(getConversation(ok, 'conv-0')?.revision).toBe(2);
    expect(taskOwnership(ok, 't-fresh')?.conversationId).toBe('conv-0');
  });

  it('跨会话抢占同一 taskId 仍被拒（背景会话持有 → 目标会话绑定被拒）', () => {
    const state = bindInto(seedBackground(100), 0); // 仅用于构造状态；不新增任务
    // bg-0-0 属于背景会话 bg-0，绑定到目标会话必须被拒。
    expect(
      codeOf(() =>
        bindTask(state, {
          conversationId: 'conv-target',
          expectedRevision: 1,
          task: { taskId: 'bg-0-0', title: '抢占', status: 'running' },
        }),
      ),
    ).toBe('duplicate-task-binding');
  });

  it('同一基状态可安全分叉重复绑定（索引不可变，不跨分支泄漏）', () => {
    const base = seedOneConversationWithTasks(0, 'conv-target');
    // 从同一基状态出发两次独立绑定（同一 taskId 前缀），互不影响——可变共享索引会在此误拒。
    const a = bindInto(base, 3, 'a');
    const b = bindInto(base, 3, 'b');
    expect(tasksOf(a, 'conv-target').map((t) => t.taskId)).toEqual(['a-0', 'a-1', 'a-2']);
    expect(tasksOf(b, 'conv-target').map((t) => t.taskId)).toEqual(['b-0', 'b-1', 'b-2']);
    // 再从 a 分支绑定 b 的 taskId：a 并不含它，必须成功。
    const aExt = bindInto(a, 1, 'b');
    expect(tasksOf(aExt, 'conv-target').map((t) => t.taskId)).toEqual(['a-0', 'a-1', 'a-2', 'b-0']);
    // 同名 taskId 在同一分支内重复仍被拒。
    expect(
      codeOf(() =>
        bindTask(aExt, {
          conversationId: 'conv-target',
          expectedRevision: getConversation(aExt, 'conv-target')?.revision ?? 4,
          task: { taskId: 'a-0', title: '重复', status: 'running' },
        }),
      ),
    ).toBe('duplicate-task-binding');
  });

  it('删除会话后索引被丢弃：被删任务的 taskId 可在新会话重新绑定（无过期索引误拒）', () => {
    let state = bindTask(seedOneConversationWithTasks(0, 'conv-a'), {
      conversationId: 'conv-a',
      expectedRevision: 1,
      task: { taskId: 't-reuse', title: '可复用', status: 'running' },
    });
    expect(taskOwnership(state, 't-reuse')?.conversationId).toBe('conv-a');

    state = deleteConversation(state, {
      conversationId: 'conv-a',
      expectedRevision: getConversation(state, 'conv-a')?.revision ?? 2,
      scope: FULL_SCOPE,
    });
    expect(getConversation(state, 'conv-a')).toBeNull();

    state = createConversation(state, { id: 'conv-b', title: '新会话', select: false });
    state = bindTask(state, {
      conversationId: 'conv-b',
      expectedRevision: getConversation(state, 'conv-b')?.revision ?? 1,
      task: { taskId: 't-reuse', title: '复用', status: 'running' },
    });
    expect(taskOwnership(state, 't-reuse')?.conversationId).toBe('conv-b');
  });
});

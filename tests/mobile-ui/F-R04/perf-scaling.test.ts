/**
 * F-R04 验收（计时部分）—— 长列表 / 长流式消息 / 大文件预览的**增长行为**守卫。
 *
 * 口径（见 perf-harness.ts 顶部）：
 *   - 规模放大 **4 倍**；线性算法耗时比值 ≈ 4，二次算法 ≈ 16。判据 `ceiling = 8`
 *     落在两者正中（各留 2 倍余量）。
 *   - 用**交错配对测量**（base/scaled 交替跑）抵消共享机器上的后台负载漂移。
 *   - 「必须通过」的守卫用 **min** 估计器（最小的那一次最接近无干扰）；
 *     「已知缺陷」用 **median** 估计器（缺陷很大，中位数稳定高于阈值）。
 *   - 绝对预算（ms）对噪声不敏感，作为硬门兜底，防止灾难性退化。
 *
 * 诚实说明：
 *   - 本机为六线共用的共享机器，计时结果仅供**同机相对比较**，不构成跨设备性能承诺。
 *   - 三个曾用 `it.fails` 标记的超线性缺陷，已由集成波修复：
 *       · FR04-LIST-03 → F-I07（bindTask 归属索引 + 任务追加结构共享）；
 *       · FR04-FILE-01/02 → F-I10（版本链结构共享 + revision→下标索引）。
 *     现改为真实 `it()` 硬门，证明这些操作已回到近线性；若回归二次，比值会越过上限转红。
 *   - 订阅型监听器泄漏（F-I01 `KernelClient` 的 subscribe/unsubscribe）在本文件用
 *     **确定性脚本传输**断言（无计时、不受负载影响）；`perf-harness.ts` 本身仍不依赖它。
 *   - 真机（Android WebView / QJS）帧时间、内存峰值、真实 GC 未测。
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';

import {
  evaluateProbe,
  formatProbeResult,
  measure,
  measurePaired,
  resultFromVerdict,
  verifyScaling,
  type ProbeResult,
} from './perf-harness.js';
import {
  buildConversationsState,
  buildFileEntries,
  buildFileEntry,
  buildStreamableChatState,
  isoTimestampAt,
  withTasks,
} from './fixtures.js';
import { listConversations, pageConversations } from '../../../apps/mobile-ui/src/conversations/state.js';
import { bindTask } from '../../../apps/mobile-ui/src/conversations/actions.js';
import { reduce } from '../../../apps/mobile-ui/src/chat/index.js';
import { appendRevision, revisionAt } from '../../../apps/mobile-ui/src/files/versions.js';
import { listFiles } from '../../../apps/mobile-ui/src/files/list.js';
import type { ConversationsState } from '../../../apps/mobile-ui/src/conversations/types.js';
import type { FileEntry } from '../../../apps/mobile-ui/src/files/types.js';
import {
  createKernelClient,
  type CallerIdentity,
  type Event,
  type KernelTransport,
  type KernelTransportBreakNotice,
} from '../../../apps/mobile-ui/src/platform/index.js';

const REPS = 7;
const results: ProbeResult[] = [];

function record(result: ProbeResult): ProbeResult {
  results.push(result);
  // 证据同时打到 stdout；测试结束另写 evidence/last-run.json。
  console.log(formatProbeResult(result));
  return result;
}

/** 交错配对 + min 估计器（用于必须通过的守卫）。 */
function pairedMin(
  baseFn: () => void,
  scaledFn: () => void,
  bl: string,
  sl: string,
  sizeFactor = 4,
  ceiling = 8,
) {
  const p = measurePaired(baseFn, scaledFn, { reps: REPS, warmup: 1, baseLabel: bl, scaledLabel: sl });
  return verifyScaling(p.base, p.scaled, sizeFactor, ceiling, 'min');
}

/**
 * 交错配对 + median 估计器（用于标记缺陷）。
 * 缺陷探测用 **5 倍**规模（线性=5、二次=25），使二次实现与 `ceiling = 8` 拉开 3 倍以上，
 * 即使有噪声也不会把二次误判成通过（`it.fails` 的稳定性关键）。
 */
function pairedMedian(
  baseFn: () => void,
  scaledFn: () => void,
  bl: string,
  sl: string,
  sizeFactor = 4,
  ceiling = 8,
) {
  const p = measurePaired(baseFn, scaledFn, { reps: REPS, warmup: 1, baseLabel: bl, scaledLabel: sl });
  return verifyScaling(p.base, p.scaled, sizeFactor, ceiling, 'median');
}

afterAll(() => {
  try {
    const dir = new URL('./evidence/', import.meta.url);
    mkdirSync(dir, { recursive: true });
    const payload = {
      package: 'F-R04',
      area: 'long-list / long-stream / large-file — performance & resource retention',
      machineNote: 'shared machine (six lanes); timings are same-machine relative, not absolute',
      reps: REPS,
      sizeFactor: 4,
      ceiling: 8,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      results,
    };
    writeFileSync(new URL('./evidence/last-run.json', import.meta.url), `${JSON.stringify(payload, null, 2)}\n`);
  } catch (error) {
    console.log(`[F-R04] 证据写入失败（非致命）：${String(error)}`);
  }
});

// ---------------------------------------------------------------------------
// 长流式消息
// ---------------------------------------------------------------------------

function streamChunks(chunkCount: number, existingMessages: number): void {
  let state = buildStreamableChatState(existingMessages);
  for (let seq = 1; seq <= chunkCount; seq += 1) {
    state = reduce(state, {
      type: 'streamChunk',
      delivery: {
        messageId: 'a-target',
        attemptId: 'attempt-target-1',
        seq,
        chunk: { type: 'text', text: '字字', done: seq === chunkCount },
      },
    });
  }
}

// ---------------------------------------------------------------------------
// 长列表 / 会话
// ---------------------------------------------------------------------------

/**
 * 预构建并缓存规模夹具：使计时样本只包含**被测操作本身**，不混入夹具构造成本
 * （否则夹具的 O(k) 也会被计进去，加大方差）。夹具是不可变的，跨调用复用安全。
 */
const BIND_BASE_CACHE = new Map<number, ConversationsState>();

function bindBaseFor(k: number): ConversationsState {
  let base = BIND_BASE_CACHE.get(k);
  if (base === undefined) {
    base = withTasks(buildConversationsState(1, 3), 'conv-0000000', k);
    BIND_BASE_CACHE.set(k, base);
  }
  return base;
}

function bindManyTasks(k: number): void {
  let state = bindBaseFor(k);
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
// 大文件版本链
// ---------------------------------------------------------------------------

function appendManyRevisions(k: number): void {
  let entry = buildFileEntry(1);
  for (let i = 0; i < k; i += 1) {
    entry = appendRevision(entry, {
      expectedRevision: entry.currentRevision,
      createdAt: isoTimestampAt(entry.currentRevision),
    });
  }
}

const LOOKUP_ENTRY_CACHE = new Map<number, FileEntry>();

function lookupEntryFor(k: number): FileEntry {
  let entry = LOOKUP_ENTRY_CACHE.get(k);
  if (entry === undefined) {
    entry = buildFileEntry(k);
    LOOKUP_ENTRY_CACHE.set(k, entry);
  }
  return entry;
}

function lookupAllRevisions(k: number): void {
  // 入口固定：相同 entry 复用，revision→下标索引在预热阶段已建好，
  // 计时区间只含 k 次取版（这正是 FR04-FILE-02 的口径）。
  const entry = lookupEntryFor(k);
  let acc = 0;
  for (let i = 0; i < k; i += 1) acc += revisionAt(entry, 1 + (i % k)).revision;
  if (acc < 0) throw new Error('不可达');
}

// ---------------------------------------------------------------------------
// 必须通过的守卫
// ---------------------------------------------------------------------------

describe('F-R04 / 增长守卫（必须通过）', () => {
  it(
    'FR04-STREAM-01 单条长流式消息：分片数 4 倍，耗时近线性',
    () => {
      const verdict = pairedMin(() => streamChunks(20_000, 3), () => streamChunks(80_000, 3), 'stream-20k', 'stream-80k', 4, 10);
      record(resultFromVerdict('FR04-STREAM-01', verdict, '单条消息累积分片数 4 倍（含 8 万个状态的 GC 开销，上限放宽到 10）'));
      expect(verdict.ratio).toBeLessThanOrEqual(verdict.ceiling);
    },
    60_000,
  );

  it(
    'FR04-STREAM-02 每片成本随会话消息数 4 倍增长，近线性',
    () => {
      const verdict = pairedMin(
        () => streamChunks(5_000, 1_000),
        () => streamChunks(5_000, 4_000),
        'msgs-1k',
        'msgs-4k',
        4,
        10,
      );
      record(resultFromVerdict('FR04-STREAM-02', verdict, '固定 5000 片，会话消息数 1k→4k'));
      expect(verdict.ratio).toBeLessThanOrEqual(verdict.ceiling);
    },
    60_000,
  );

  it(
    'FR04-STREAM-10 80000 片绝对预算',
    () => {
      const t = measure(() => streamChunks(80_000, 3), { reps: REPS, warmup: 1, label: 'stream-80k' });
      const budget = 3_000;
      const result = record(evaluateProbe('FR04-STREAM-10', t.medianMs, budget, `中位 ${t.medianMs.toFixed(2)}ms`));
      expect(result.pass).toBe(true);
    },
    60_000,
  );
});

describe('F-R04 / 长列表绝对预算（必须通过）', () => {
  it(
    'FR04-LIST-10 listConversations @16000 绝对预算',
    () => {
      const state = buildConversationsState(16_000);
      const t = measure(() => { listConversations(state); }, { reps: REPS, warmup: 1, label: 'list-16k' });
      const result = record(evaluateProbe('FR04-LIST-10', t.medianMs, 300, `中位 ${t.medianMs.toFixed(2)}ms`));
      expect(result.pass).toBe(true);
    },
    60_000,
  );

  it(
    'FR04-LIST-11 pageConversations @16000 绝对预算',
    () => {
      const state = buildConversationsState(16_000);
      const t = measure(
        () => { pageConversations(state, { offset: 0, limit: 30 }); },
        { reps: REPS, warmup: 1, label: 'page-16k' },
      );
      const result = record(evaluateProbe('FR04-LIST-11', t.medianMs, 300, `中位 ${t.medianMs.toFixed(2)}ms`));
      expect(result.pass).toBe(true);
    },
    60_000,
  );

  it(
    'FR04-FILE-10 listFiles @16000 绝对预算',
    () => {
      const entries = buildFileEntries(16_000);
      const t = measure(() => { listFiles(entries); }, { reps: REPS, warmup: 1, label: 'files-16k' });
      const result = record(evaluateProbe('FR04-FILE-10', t.medianMs, 500, `中位 ${t.medianMs.toFixed(2)}ms`));
      expect(result.pass).toBe(true);
    },
    60_000,
  );
});

describe('F-R04 / 增长报告（记录到证据，不设硬门：噪声较大）', () => {
  it(
    'FR04-LIST-01 listConversations 4k→16k 增长比值（记录）',
    () => {
      const s1 = buildConversationsState(4_000);
      const s4 = buildConversationsState(16_000);
      const verdict = pairedMedian(() => { listConversations(s1); }, () => { listConversations(s4); }, 'list-4k', 'list-16k');
      const result = record(resultFromVerdict('FR04-LIST-01', verdict, `中位比值 ${verdict.ratio.toFixed(2)}（噪声大，详见 RUNBOOK）`, false));
      // 不设硬门：共享机器上排序类操作方差大；用上面的绝对预算兜底。
      expect(result.value).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    'FR04-LIST-02 pageConversations 4k→16k 增长比值（记录）',
    () => {
      const s1 = buildConversationsState(4_000);
      const s4 = buildConversationsState(16_000);
      const verdict = pairedMedian(
        () => { pageConversations(s1, { offset: 0, limit: 30 }); },
        () => { pageConversations(s4, { offset: 0, limit: 30 }); },
        'page-4k',
        'page-16k',
      );
      const result = record(resultFromVerdict('FR04-LIST-02', verdict, `中位比值 ${verdict.ratio.toFixed(2)}（噪声大，详见 RUNBOOK）`, false));
      expect(result.value).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    'FR04-FILE-03 listFiles 4k→16k 增长比值（记录）',
    () => {
      const f1 = buildFileEntries(4_000);
      const f4 = buildFileEntries(16_000);
      const verdict = pairedMedian(() => { listFiles(f1); }, () => { listFiles(f4); }, 'files-4k', 'files-16k');
      const result = record(resultFromVerdict('FR04-FILE-03', verdict, `中位比值 ${verdict.ratio.toFixed(2)}（噪声大，详见 RUNBOOK）`, false));
      expect(result.value).toBeGreaterThan(0);
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
// 线性增长守卫（F-I07 / F-I10 修复后，由 it.fails 转为真实 it() 硬门）
// ---------------------------------------------------------------------------

// 口径：规模放大 5 倍（线性期望 5，二次 25）。上限 12 位于两者之间（线性侧 2.4 倍余量、
// 二次侧 2 倍余量），在六线共用的共享机器上给 GC/后台负载留下足够波动空间。
const GUARD_SIZE_FACTOR = 5;
const GUARD_CEILING = 12;
const GUARD_BASE = 4_000;
const GUARD_SCALED = 20_000;

describe('F-R04 / 线性增长守卫（修复后必须通过）', () => {
  it(
    'FR04-LIST-03 bindTask 连续绑定 k 个任务为线性（F-I07 修复）',
    () => {
      const verdict = pairedMin(
        () => { bindManyTasks(GUARD_BASE); },
        () => { bindManyTasks(GUARD_SCALED); },
        'bind-4k',
        'bind-20k',
        GUARD_SIZE_FACTOR,
        GUARD_CEILING,
      );
      const result = record(resultFromVerdict('FR04-LIST-03', verdict, '连续绑定 k 个任务；归属唯一走不可变前缀树索引 + 任务追加结构共享（O(1)/次）'));
      expect(verdict.ratio).toBeLessThanOrEqual(verdict.ceiling);
      expect(result.pass).toBe(true);
    },
    120_000,
  );

  it(
    'FR04-FILE-01 appendRevision 连续追加 k 版为线性（F-I10 修复）',
    () => {
      const verdict = pairedMin(
        () => { appendManyRevisions(GUARD_BASE); },
        () => { appendManyRevisions(GUARD_SCALED); },
        'append-4k',
        'append-20k',
        GUARD_SIZE_FACTOR,
        GUARD_CEILING,
      );
      const result = record(resultFromVerdict('FR04-FILE-01', verdict, '连续追加 k 版；结构共享单链 O(1) 追加，不再整拷版本数组'));
      expect(verdict.ratio).toBeLessThanOrEqual(verdict.ceiling);
      expect(result.pass).toBe(true);
    },
    120_000,
  );

  it(
    'FR04-FILE-02 revisionAt 在 k 版链上取 k 次为线性（F-I10 修复）',
    () => {
      const verdict = pairedMin(
        () => { lookupAllRevisions(GUARD_BASE); },
        () => { lookupAllRevisions(GUARD_SCALED); },
        'lookup-4k',
        'lookup-20k',
        GUARD_SIZE_FACTOR,
        GUARD_CEILING,
      );
      const result = record(resultFromVerdict('FR04-FILE-02', verdict, '在 k 版链上取 k 次；revision→下标索引 O(1)，不再线性 find'));
      expect(verdict.ratio).toBeLessThanOrEqual(verdict.ceiling);
      expect(result.pass).toBe(true);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// 订阅型监听器泄漏（F-I01 KernelClient subscribe/unsubscribe）：确定性、无计时
// ---------------------------------------------------------------------------

const CALLER: CallerIdentity = { origin: 'app://local', kind: 'ui-webview', packageName: 'com.potbot.demo' };

function makeEvent(seq: number, commandId: string): Event {
  return { eventId: `evt-${seq}`, commandId, status: 'running', seq, revision: 0, verificationMode: 'fixture' };
}

/** 确定性脚本传输：手动 emit 事件，并暴露监听器计数以观测泄漏。 */
function makeTransport(): {
  transport: KernelTransport;
  emit(event: Event): void;
  eventListenerCount(): number;
  breakListenerCount(): number;
} {
  const listeners = new Set<(event: Event) => void>();
  const breakListeners = new Set<(notice: KernelTransportBreakNotice) => void>();
  const transport: KernelTransport = {
    submit: () => Promise.reject(new Error('本探测不提交命令')),
    subscribe(listener) {
      listeners.add(listener);
      return { unsubscribe: () => { listeners.delete(listener); } };
    },
    cancel() {
      return true;
    },
    onBreak(listener) {
      breakListeners.add(listener);
      return { unsubscribe: () => { breakListeners.delete(listener); } };
    },
  };
  return {
    transport,
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    eventListenerCount() {
      return listeners.size;
    },
    breakListenerCount() {
      return breakListeners.size;
    },
  };
}

describe('F-R04 / 订阅型监听器泄漏（KernelClient 退订）', () => {
  it('1000 个连订连退后零残余：退订后的订阅者不再收到事件', () => {
    const t = makeTransport();
    const client = createKernelClient({ transport: t.transport, caller: CALLER });

    // 客户端对传输层只订阅一次（全局事件流 + 断流），与命令数无关。
    expect(t.eventListenerCount()).toBe(1);
    expect(t.breakListenerCount()).toBe(1);

    const counters: number[] = [];
    const offs: Array<() => void> = [];
    for (let i = 0; i < 1000; i += 1) {
      counters.push(0);
      // 本槽位刚 push(0)，必已存在；`?? 0` 仅为满足 noUncheckedIndexedAccess，不改变自增语义。
      offs.push(client.subscribe(`cmd-${i}`, () => { counters[i] = (counters[i] ?? 0) + 1; }, () => {}));
    }
    // 订阅 1000 个命令不增加传输层监听器：没有泄漏进传输层。
    expect(t.eventListenerCount()).toBe(1);

    // 各命令互不串台：只有 cmd-0 的订阅者被投递。
    t.emit(makeEvent(1, 'cmd-0'));
    expect(counters[0]).toBe(1);
    let deliveredBefore = 0;
    for (const c of counters) deliveredBefore += c;
    expect(deliveredBefore).toBe(1);

    // 全部退订：再投递不得触达任何已退订的订阅者。
    for (const off of offs) off();
    t.emit(makeEvent(2, 'cmd-0'));
    let deliveredAfter = 0;
    for (const c of counters) deliveredAfter += c;
    const residual = deliveredAfter - deliveredBefore;
    expect(residual).toBe(0); // 退订后零新增投递

    const result: ProbeResult = {
      probeId: 'FR04-RET-05',
      metric: 'retention-count',
      value: residual,
      threshold: 0,
      unit: 'count',
      pass: residual <= 0,
      enforced: true,
      note: '1000 个订阅者全部退订后，事件零投递（无监听器泄漏）',
    };
    record(result);
    expect(result.pass).toBe(true);

    client.stop();
    expect(t.eventListenerCount()).toBe(0);
    expect(t.breakListenerCount()).toBe(0);
  });

  it('关闭客户端即向传输层退订：无悬挂监听器，关闭后 emit 不投递不抛错', () => {
    const t = makeTransport();
    const client = createKernelClient({ transport: t.transport, caller: CALLER });
    let calls = 0;
    const off = client.subscribe('cmd-x', () => { calls += 1; }, () => {});
    expect(t.eventListenerCount()).toBe(1);
    expect(t.breakListenerCount()).toBe(1);

    client.signalStreamBreak('transport-closed', 'WebView 卸载');

    // 关闭路径必须释放传输层订阅，否则每次卸载都泄漏一对监听器。
    expect(client.state).toBe('closed');
    expect(t.eventListenerCount()).toBe(0);
    expect(t.breakListenerCount()).toBe(0);

    t.emit(makeEvent(1, 'cmd-x'));
    expect(calls).toBe(0);
    off(); // 幂等：关闭后再调退订不应抛错
  });
});

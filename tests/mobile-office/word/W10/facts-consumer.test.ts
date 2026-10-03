/**
 * **W10 — 事实订阅 / 版本校验 / 实际消费回执的独立验收**（WF-087 消费侧；FactsPort v1）。
 *
 * 判据来自 `docs/other/ds-six-lanes-2026-10-03/WORD.md` 的 W10 行：
 * "事实订阅/版本校验/实际消费回执"。本文件测的是
 * `src/mobile-plugins/word/session/{facts-consumer,word-session-plugin}.ts`。
 *
 * ## 三条纪律各自被哪些用例钉住
 *
 * | 纪律 | 用例 |
 * |---|---|
 * | **绑定 ≠ 消费**：订阅只记"我依赖哪一版"，真正的校验发生在消费那一刻 | §G 1–3、§H 5 |
 * | **版本校验**：`snapshot_id` 与 `task_revision` **两个都要**对得上，只改一个也拒 | §H 6–8 |
 * | **没有回执 = 没消费成**：拒绝时不产生任何 receipt（不能被记成"消费过了"） | §H 4、6、9、12 |
 * | **回执是"实际取到的"**：摘要来自这一次真正读到的快照，可与端口数据独立复算 | §H 5、11、13 |
 *
 * ## 关于"独立复算"的诚实说明
 *
 * 复算用的是**端口里那份快照的原始数据**（不是回执自己的 `consumed_keys`），因此它能抓住
 * "回执写的是一份、实际取的是另一份"这类分叉。它**共用**仓库唯一的规范化指纹函数
 * `fingerprint()`（`documents/session/canonical.ts`）——那是全仓的摘要口径，
 * 另写一个会让"对得上"变成两套实现的巧合。§H 13 用**同一 id/版本、值被换掉**的快照
 * 作为负向对照，证明回执确实跟着实际值走。
 *
 * 证据层级：**unit/contract**。不联网、不读盘、不持密钥；`FactsPort` 由测试注入。
 */

import { describe, expect, it } from 'vitest';

import { fingerprint } from '../../../../src/documents/session/canonical.js';
import type {
  FactsSnapshotEntry,
  FactsSnapshotView,
  WordFactsReceipt,
  WordFactsResult,
} from '../../../../src/mobile-plugins/word/session/types.js';
import { WordSessionPlugin } from '../../../../src/mobile-plugins/word/session/word-session-plugin.js';
import type { W10Harness } from './harness.js';
import { FACT_SOURCE, factSnapshot, makeHarness, sampleDocx } from './harness.js';

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

const SESSION = 'W10-FS1';
const TASK = 'T-doc-w10';

function expectOk<T>(result: WordFactsResult<T>): T {
  if (!result.ok) throw new Error(`期望成功，实得失败：${result.scope}/${result.code} ${result.message}`);
  return result.value;
}

function expectFail<T>(result: WordFactsResult<T>): {
  readonly scope: 'session' | 'facts';
  readonly code: string;
  readonly message: string;
} {
  if (result.ok) throw new Error('期望失败，实得成功');
  return result;
}

/** 带一份文档与一个已绑定快照的夹具。 */
function withSession(values: readonly FactsSnapshotEntry[] = FACTS): W10Harness {
  const harness = makeHarness();
  const opened = harness.plugin.create({ id: SESSION, filename: '事实文档.docx', template: sampleDocx() });
  if (!opened.ok) throw new Error(`新建失败：${opened.code} ${opened.message}`);
  harness.facts.put(factSnapshot(TASK, { values }));
  return harness;
}

const NUMBER_VALUE = {
  fact_key: 'headcount',
  fact_ref: 'fact-headcount',
  value: { type: 'number', amount: 8, unit: '人', currency: null },
  unit: '人',
  source: FACT_SOURCE,
} as const satisfies FactsSnapshotEntry;

const DATE_VALUE = {
  fact_key: 'event_date',
  fact_ref: 'fact-event-date',
  value: { type: 'date', iso_date: '2026-10-02', time_zone: 'Asia/Shanghai' },
  unit: null,
  source: FACT_SOURCE,
} as const satisfies FactsSnapshotEntry;

const TEXT_VALUE = {
  fact_key: 'venue',
  fact_ref: 'fact-venue',
  value: { type: 'text', text: '某某馆', source: '用户确认单' },
  unit: null,
  source: FACT_SOURCE,
} as const satisfies FactsSnapshotEntry;

const FACTS: readonly FactsSnapshotEntry[] = Object.freeze([NUMBER_VALUE, DATE_VALUE, TEXT_VALUE]);

/** 让文档前进一版用的最小计划（把第一段居中）。 */
const CENTER_FIRST = {
  steps: [
    {
      range: '第1段',
      operation: { domain: 'paragraph' as const, operation: { kind: 'setAlignment' as const, alignment: 'center' as const } },
    },
  ],
};

/**
 * 独立复算 `values_digest`：输入**取自端口那份快照的原始条目**，而不是回执自己的字段。
 * 任何"回执写一套、实际取另一套"的分叉都会在这里对不上。
 */
function recomputeDigest(values: readonly FactsSnapshotEntry[]): string {
  return fingerprint(
    values.map((entry) => ({
      fact_key: entry.fact_key,
      fact_ref: entry.fact_ref,
      value: entry.value,
      unit: entry.unit,
      source: entry.source,
    })),
  );
}

function receiptCount(harness: W10Harness): number {
  const inspected = harness.plugin.inspect(SESSION);
  if (!inspected.ok) throw new Error(`inspect 失败：${inspected.code}`);
  return inspected.value.facts.receipt_count;
}

function consumedReceipt(harness: W10Harness, documentRevision?: number): WordFactsReceipt {
  return expectOk(
    harness.plugin.consumeFacts({
      session_id: SESSION,
      ...(documentRevision === undefined ? {} : { document_revision: documentRevision }),
    }),
  );
}

// ---------------------------------------------------------------------------
// §G 绑定（订阅）
// ---------------------------------------------------------------------------

describe('W10 §G 绑定（订阅）：只记"我依赖哪一版"（WF-087）', () => {
  it('1. 未配置事实端口 ⇒ 绑定与消费都结构化失败，且**没有回执**', () => {
    const harness = makeHarness();
    // 刻意**不**给 facts_port：这正是"插件没配事实端口"的真实形态。
    const plugin = new WordSessionPlugin({
      publish_port: harness.publish,
      persistence_for: (sessionId: string) => harness.store.persistenceFor(sessionId),
      now: () => new Date(Date.UTC(2026, 9, 3)),
    });
    if (!plugin.create({ id: SESSION, filename: '无端口.docx', template: sampleDocx() }).ok) {
      throw new Error('新建失败');
    }
    const bound = expectFail(plugin.bindFacts({ session_id: SESSION, task_id: TASK }));
    expect(bound.scope).toBe('facts');
    expect(bound.code).toBe('facts_not_configured');

    const consumed = expectOk(plugin.consumeFacts({ session_id: SESSION }));
    expect(consumed.consumption.ok).toBe(false);
    if (consumed.consumption.ok) throw new Error('不可能');
    expect(consumed.consumption.code).toBe('facts_not_configured');
    expect(consumed.warnings.join('|')).toContain('facts_not_configured');
    const inspected = plugin.inspect(SESSION);
    expect(inspected.ok && inspected.value.facts.receipt_count).toBe(0);
  });

  it('2. 端口里没有该任务的快照 ⇒ 拒绝绑定（不得把缺失当成空快照）', () => {
    const harness = withSession();
    harness.facts.remove(TASK);
    const bound = expectFail(harness.plugin.bindFacts({ session_id: SESSION, task_id: TASK }));
    expect(bound.scope).toBe('facts');
    expect(bound.code).toBe('facts_snapshot_missing');
    expect(receiptCount(harness)).toBe(0);

    const consumed = expectOk(harness.plugin.consumeFacts({ session_id: SESSION }));
    expect(consumed.consumption.ok).toBe(false);
    if (consumed.consumption.ok) throw new Error('不可能');
    expect(consumed.consumption.code).toBe('facts_not_bound');
  });

  it('3. 绑定成功：回执钉住 snapshot_id@task_revision；未知会话 ⇒ scope=session', () => {
    const harness = withSession();
    const receipt = expectOk(harness.plugin.bindFacts({ session_id: SESSION, task_id: TASK }));
    expect(receipt.tool).toBe('bindFacts');
    expect(receipt.binding.snapshot_id).toBe('T-doc-w10-snap-1');
    expect(receipt.binding.task_revision).toBe(1);
    expect(receipt.binding.task_id).toBe(TASK);
    expect(receipt.published).toBe(false);
    expect(receipt.changed_objects).toEqual(['facts:T-doc-w10-snap-1@r1']);

    const missing = expectFail(harness.plugin.bindFacts({ session_id: 'NOPE', task_id: TASK }));
    expect(missing.scope).toBe('session');
    expect(missing.code).toBe('session_not_found');
  });
});

// ---------------------------------------------------------------------------
// §H 消费
// ---------------------------------------------------------------------------

describe('W10 §H 消费：先校验版本，再出**实际**回执（WF-087）', () => {
  it('4. 未绑定就消费 ⇒ facts_not_bound，不产生回执', () => {
    const harness = withSession();
    const consumed = expectOk(harness.plugin.consumeFacts({ session_id: SESSION }));
    expect(consumed.consumption.ok).toBe(false);
    if (consumed.consumption.ok) throw new Error('不可能');
    expect(consumed.consumption.code).toBe('facts_not_bound');
    expect(consumed.warnings.join('|')).toContain('尚未绑定');
    expect(receiptCount(harness)).toBe(0);
  });

  it('5. 版本一致 ⇒ 出实际消费回执；摘要可由端口数据独立复算', () => {
    const harness = withSession();
    expectOk(harness.plugin.bindFacts({ session_id: SESSION, task_id: TASK }));
    const consumed = consumedReceipt(harness);

    expect(consumed.tool).toBe('consumeFacts');
    expect(consumed.published).toBe(false);
    expect(consumed.version).toBeNull();
    const consumption = consumed.consumption;
    expect(consumption.ok).toBe(true);
    if (!consumption.ok) throw new Error('不可能');

    const receipt = consumption.receipt;
    expect(receipt.snapshot_id).toBe('T-doc-w10-snap-1');
    expect(receipt.task_id).toBe(TASK);
    expect(receipt.consumer).toBe(`word-session:${SESSION}`);
    expect(receipt.document_revision).toBe(0); // 文档编辑版本（新建后为 0）
    expect(receipt.bound_revision).toBe(1);
    expect(receipt.consumed_revision).toBe(1);
    expect(receipt.snapshot_id_match).toBe(true);
    expect(receipt.consumed_fact_refs).toEqual(['fact-headcount', 'fact-event-date', 'fact-venue']);
    expect(receipt.consumed_keys).toEqual(['headcount', 'event_date', 'venue']);
    expect(receipt.warnings).toEqual([]);
    expect(Number.isNaN(Date.parse(receipt.consumed_at))).toBe(false);

    // --- 独立复算：输入来自**端口那份快照**，不是回执自己的字段 ---
    const portSnapshot = harness.facts.snapshot(TASK) as FactsSnapshotView;
    expect(receipt.values_digest).toBe(recomputeDigest(portSnapshot.values));
    // 负向对照：值被改一个 ⇒ 摘要必须跟着变（否则它就不是在描述值）。
    const mutated = portSnapshot.values.map((entry, index) =>
      index === 0 ? { ...entry, value: { type: 'number' as const, amount: 9, unit: '人', currency: null } } : entry,
    );
    expect(recomputeDigest(mutated)).not.toBe(receipt.values_digest);
    // 再一条负向对照：摘要**不是**"绑定那一刻的声明清单"的摘要（把清单顺序换掉，摘要不同）。
    const reordered = [...portSnapshot.values].reverse();
    expect(recomputeDigest(reordered)).not.toBe(receipt.values_digest);

    expect(receiptCount(harness)).toBe(1);
    expect(consumed.warnings).toEqual([]);
  });

  it('6. 版本升版（revision+1 且 id 换新）⇒ facts_version_changed，**不产生**新回执', () => {
    const harness = withSession();
    expectOk(harness.plugin.bindFacts({ session_id: SESSION, task_id: TASK }));
    consumedReceipt(harness);
    expect(receiptCount(harness)).toBe(1);

    harness.facts.put(factSnapshot(TASK, { snapshotId: 'T-doc-w10-snap-2', revision: 2, values: FACTS }));
    const consumed = consumedReceipt(harness);
    expect(consumed.consumption.ok).toBe(false);
    if (consumed.consumption.ok) throw new Error('不可能');
    expect(consumed.consumption.code).toBe('facts_version_changed');
    // 两个版本号都要能在消息里读出来（人不必去翻代码就知道绑的是哪一版）。
    expect(consumed.consumption.message).toContain('T-doc-w10-snap-1@r1');
    expect(consumed.consumption.message).toContain('T-doc-w10-snap-2@r2');
    // 旧文档不得套用新事实：回执数量**没有**增加。
    expect(receiptCount(harness)).toBe(1);
  });

  it('7. 只换 snapshot_id（revision 不变）⇒ 仍然拒绝（两个号都要对得上）', () => {
    const harness = withSession();
    expectOk(harness.plugin.bindFacts({ session_id: SESSION, task_id: TASK }));
    harness.facts.put(factSnapshot(TASK, { snapshotId: 'T-doc-w10-别的快照', revision: 1, values: FACTS }));
    const consumed = consumedReceipt(harness);
    expect(consumed.consumption.ok).toBe(false);
    if (consumed.consumption.ok) throw new Error('不可能');
    expect(consumed.consumption.code).toBe('facts_version_changed');
    expect(receiptCount(harness)).toBe(0);
  });

  it('8. 只升 task_revision（snapshot_id 不变）⇒ 同样拒绝', () => {
    const harness = withSession();
    expectOk(harness.plugin.bindFacts({ session_id: SESSION, task_id: TASK }));
    harness.facts.put(factSnapshot(TASK, { snapshotId: 'T-doc-w10-snap-1', revision: 2, values: FACTS }));
    const consumed = consumedReceipt(harness);
    expect(consumed.consumption.ok).toBe(false);
    if (consumed.consumption.ok) throw new Error('不可能');
    expect(consumed.consumption.code).toBe('facts_version_changed');
    expect(receiptCount(harness)).toBe(0);
  });

  it('9. 绑定后快照消失 ⇒ facts_snapshot_missing（缺失不是空快照）', () => {
    const harness = withSession();
    expectOk(harness.plugin.bindFacts({ session_id: SESSION, task_id: TASK }));
    harness.facts.remove(TASK);
    const consumed = consumedReceipt(harness);
    expect(consumed.consumption.ok).toBe(false);
    if (consumed.consumption.ok) throw new Error('不可能');
    expect(consumed.consumption.code).toBe('facts_snapshot_missing');
    expect(receiptCount(harness)).toBe(0);
  });

  it('10. 重新绑定新快照后消费成功：历史回执保留，旧绑定可追', async () => {
    const harness = withSession();
    expectOk(harness.plugin.bindFacts({ session_id: SESSION, task_id: TASK }));
    consumedReceipt(harness);

    // 先让文档真的前进一版（这样"回执钉在哪个文档版本上"才是可判定的）。
    const edited = await harness.plugin.apply({
      session_id: SESSION,
      idempotency_key: 'fs-edit-1',
      base_revision: 0,
      base_digest: harness.plugin.handle(SESSION)?.currentDigest() ?? '',
      plan: CENTER_FIRST,
    });
    if (!edited.ok) throw new Error(`编辑失败：${edited.code} ${edited.message}`);
    expect(edited.value.revision).toBe(1);

    harness.facts.put(
      factSnapshot(TASK, { snapshotId: 'T-doc-w10-snap-2', revision: 2, values: [...FACTS, {
        fact_key: 'owner',
        fact_ref: 'fact-owner',
        value: { type: 'text', text: '诚哥', source: '用户确认单' },
        unit: null,
        source: FACT_SOURCE,
      }] }),
    );
    // 升版之后**必须显式重新绑定**（这正是"版本变更后重新确认受影响的事实"的落地）。
    const rebound = expectOk(harness.plugin.bindFacts({ session_id: SESSION, task_id: TASK }));
    expect(rebound.binding.snapshot_id).toBe('T-doc-w10-snap-2');
    expect(rebound.binding.task_revision).toBe(2);

    const consumed = consumedReceipt(harness, 1);
    const consumption = consumed.consumption;
    expect(consumption.ok).toBe(true);
    if (!consumption.ok) throw new Error('不可能');
    expect(consumption.receipt.consumed_revision).toBe(2);
    expect(consumption.receipt.bound_revision).toBe(2);
    expect(consumption.receipt.document_revision).toBe(1);
    expect(consumption.receipt.consumed_keys).toEqual(['headcount', 'event_date', 'venue', 'owner']);
    expect(receiptCount(harness)).toBe(2); // 第 1 张回执没被挤掉（历史可追）
  });

  it('11. 空快照（没有可用事实）⇒ 消费成立但**如实告警**，不发假成功', () => {
    const harness = withSession([]);
    expectOk(harness.plugin.bindFacts({ session_id: SESSION, task_id: TASK }));
    const consumed = consumedReceipt(harness);
    expect(consumed.consumption.ok).toBe(true);
    if (!consumed.consumption.ok) throw new Error('不可能');
    expect(consumed.consumption.receipt.consumed_fact_refs).toEqual([]);
    expect(consumed.consumption.receipt.warnings).toHaveLength(1);
    expect(consumed.consumption.receipt.warnings[0]).toContain('没有任何可用事实');
    expect(consumed.consumption.receipt.values_digest).toBe(recomputeDigest([]));
    expect(consumed.warnings).toEqual(consumed.consumption.receipt.warnings);
  });

  it('12. 消费钉住的文档版本与当前不符 ⇒ 拒绝（老文档 + 新事实的组合不可采信）', () => {
    const harness = withSession();
    expectOk(harness.plugin.bindFacts({ session_id: SESSION, task_id: TASK }));
    const failed = expectFail(harness.plugin.consumeFacts({ session_id: SESSION, document_revision: -1 }));
    expect(failed.scope).toBe('session');
    expect(failed.code).toBe('stale_revision');
    expect(receiptCount(harness)).toBe(0);
  });

  it('13. 端口在同一 id/版本下换了值 ⇒ 回执跟着**实际值**走（回执描述取到的，不是声明的）', () => {
    const harness = withSession();
    expectOk(harness.plugin.bindFacts({ session_id: SESSION, task_id: TASK }));
    const first = consumedReceipt(harness);
    if (!first.consumption.ok) throw new Error('不可能');
    const firstDigest = first.consumption.receipt.values_digest;

    // 同一 snapshot_id / 同一 task_revision，但值被换掉（端口侧的单来源纪律不归本层管）。
    harness.facts.put(
      factSnapshot(TASK, {
        snapshotId: 'T-doc-w10-snap-1',
        revision: 1,
        values: [{ ...NUMBER_VALUE, value: { type: 'number', amount: 99, unit: '人', currency: null } }],
      }),
    );
    const second = consumedReceipt(harness);
    expect(second.consumption.ok).toBe(true);
    if (!second.consumption.ok) throw new Error('不可能');
    const portSnapshot = harness.facts.snapshot(TASK) as FactsSnapshotView;
    expect(second.consumption.receipt.values_digest).toBe(recomputeDigest(portSnapshot.values));
    expect(second.consumption.receipt.values_digest).not.toBe(firstDigest);
    expect(second.consumption.receipt.consumed_keys).toEqual(['headcount']);
    // 两张回执并存：第 1 张记的是当时实际取到的 8 人，第 2 张记的是 99 人——
    // 版本校验只能保证"绑定与当前一致"，保证不了"同一版本的值没被换过"（那是端口/K08 的责任）。
    expect(receiptCount(harness)).toBe(2);
  });

  it('14. 消费是只读动作：文档版本、摘要、交付物一个都没动', () => {
    const harness = withSession();
    const before = harness.plugin.inspect(SESSION);
    if (!before.ok) throw new Error('inspect 失败');
    expectOk(harness.plugin.bindFacts({ session_id: SESSION, task_id: TASK }));
    consumedReceipt(harness);
    const after = harness.plugin.inspect(SESSION);
    if (!after.ok) throw new Error('inspect 失败');
    expect(after.value.revision).toBe(before.value.revision);
    expect(after.value.digest).toBe(before.value.digest);
    expect(after.value.status.published).toHaveLength(0);
    expect(harness.publish.requests).toHaveLength(0);
  });

  it('15. 事实绑定**不落盘**（内存态）：杀进程重开后必须重新订阅', () => {
    const harness = withSession();
    expectOk(harness.plugin.bindFacts({ session_id: SESSION, task_id: TASK }));
    consumedReceipt(harness);
    const stateText = harness.store.text(SESSION) ?? '';
    expect(stateText).not.toContain('T-doc-w10-snap-1');

    const restarted = harness.reopen();
    const restored = restarted.plugin.restoreSession({ id: SESSION });
    expect(restored.loaded).toBe(true);
    const inspected = restarted.plugin.inspect(SESSION);
    if (!inspected.ok) throw new Error('inspect 失败');
    expect(inspected.value.facts.binding).toBeNull();
    expect(inspected.value.facts.receipt_count).toBe(0);
    // 重开后直接消费 ⇒ 如实地"未绑定"，而不是拿着上次的绑定继续用。
    const consumed = expectOk(restarted.plugin.consumeFacts({ session_id: SESSION }));
    expect(consumed.consumption.ok).toBe(false);
    if (consumed.consumption.ok) throw new Error('不可能');
    expect(consumed.consumption.code).toBe('facts_not_bound');
  });
});

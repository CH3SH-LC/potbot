/**
 * W06 集成测试：**重定基的接受 / 拒绝作为默认部分批处理入口**（WF-079）。
 *
 * ## 本用例对准的集成缺口
 *
 * W06 先交付了 `acceptRevisionsRebased` / `rejectRevisionsRebased`，但"陈旧区间"仍然可达：
 * 只要调用方把这一步返回的剩余记录与**原始**记录混用，或继续用原偏移，就会套用一个已经失效的区间
 * （W06 用例⑩的反向对照：接受第一条删除后，未处理第二条的原区间 [5,7) 落到 "EE"）。
 *
 * 本用例证明收成**单一入口** `applyRevisionDecisions` 之后：
 * 1. 每一步都从**上一步重定基后的剩余**里重新选择，因此"接受一条、再拒绝第二条"不会删错字
 *    （陈旧 [5,7) 会删 "EE"，重定基 [3,5) 才删 "DD"）；
 * 2. 与更早移除**重叠**、偏移无法保证有效的记录**具名**进 `damaged`（不静默沿用）；
 * 3. 跨段落的未处理记录**原样不动**（偏移与文字都不受影响）。
 *
 * ## 边界声明
 *
 * 本层是**模型层**判决：模型/记录是我们自造的（不经真实 OOXML），证明的是引擎在码位区间上的自洽，
 * **不是**消费端（Word / WPS）如何渲染，也**不是**真实语料的字节往返——那两层的证据在
 * `read-revisions.test.ts` 与本批其他包，**未**在本用例内复现。
 */

import { describe, expect, it } from 'vitest';

import type { DocumentModel } from '../../../../src/documents/model/types.js';
import { document, paragraphOfRuns } from '../../../../src/documents/selection/testing.js';
import { collectParagraphs, paragraphText } from '../../../../src/documents/selection/structure.js';
import {
  acceptRevisionsRebased,
  applyRevisionDecisions,
  type RebasingBatchOutcome,
} from '../../../../src/documents/review/accept.js';
import type { RevisionRecord } from '../../../../src/documents/review/types.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function record(partial: Partial<RevisionRecord> & Pick<RevisionRecord, 'id' | 'kind'>): RevisionRecord {
  return {
    author: '诚哥',
    date: '2026-10-03T00:00:00Z',
    range: { node_id: 'p1', start: 0, end: 0 },
    text: null,
    format: null,
    ...partial,
  };
}

function requireOk<T>(result: { ok: true; value: T } | { ok: false; code: string; message: string }): T {
  if (!result.ok) throw new Error(`期望成功，实际失败：${result.code} — ${result.message}`);
  return result.value;
}

function paraTextAt(model: DocumentModel, index = 0): string {
  return paragraphText(collectParagraphs(model.blocks)[index]!);
}

/** 一段里的混合修订：A[BB]CC[DD]EE，其中 "BB" 是待删、"DD" 是已插入。 */
const MIXED = document([paragraphOfRuns('p1', [['r1', 'ABBCCDDEE']])]);
const DELETE_BB = record({ id: 'delBB', kind: 'delete', range: { node_id: 'p1', start: 1, end: 3 }, text: 'BB' });
const INSERT_DD = record({ id: 'insDD', kind: 'insert', range: { node_id: 'p1', start: 5, end: 7 }, text: 'DD' });

function inserts(model: DocumentModel): RebasingBatchOutcome {
  return requireOk(applyRevisionDecisions(model, [DELETE_BB, INSERT_DD], [
    { decision: 'accept', selector: { kind: 'ids', ids: ['delBB'] } },
    { decision: 'reject', selector: { kind: 'ids', ids: ['insDD'] } },
  ]));
}

// ---------------------------------------------------------------------------

describe('单一入口：接受一条后拒绝第二条，自动从重定基剩余里重选', () => {
  it('接受删除 BB 后，拒绝插入 DD 作用在重定基 [3,5) 上 ⇒ 删的是 DD（得到 ACCEE）', () => {
    const outcome = inserts(MIXED);
    // 接受删除 "BB"（A[BB]CC[DD]EE ⇒ ACCDDEE）；拒绝插入 "DD"（重定基 [3,5)）⇒ ACCEE。
    expect(paraTextAt(outcome.model)).toBe('ACCEE');
    expect(outcome.processed).toEqual(['delBB', 'insDD']);
    expect(outcome.remaining).toEqual([]);
    expect(outcome.damaged).toEqual([]);
  });

  it('反向对照：中间模型 "ACCDDEE" 上，陈旧 [5,7) 落在 "EE"，重定基 [3,5) 才落在 "DD"', () => {
    // 只做第一步，拿到中间模型与重定基后的第二条记录。
    const step1 = requireOk(acceptRevisionsRebased(MIXED, [DELETE_BB, INSERT_DD], { kind: 'ids', ids: ['delBB'] }));
    const mid = paraTextAt(step1.model);
    expect(mid).toBe('ACCDDEE');

    const rebased = step1.remaining[0]!;
    expect(rebased.id).toBe('insDD');
    // 重定基后的区间恰好切到 "DD"。
    expect({ start: rebased.range.start, end: rebased.range.end }).toEqual({ start: 3, end: 5 });
    expect(mid.slice(rebased.range.start, rebased.range.end)).toBe('DD');
    // 陈旧的原区间 [5,7) 在中间模型上落到 "EE" —— 若套用就删错字。
    expect(mid.slice(5, 7)).toBe('EE');
  });

  it('整批原子：第二步命中不了记录 ⇒ 整体失败且不产出模型', () => {
    const result = applyRevisionDecisions(MIXED, [DELETE_BB, INSERT_DD], [
      { decision: 'accept', selector: { kind: 'ids', ids: ['delBB'] } },
      { decision: 'reject', selector: { kind: 'ids', ids: ['不存在'] } },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_found');
    // 调用方手上的原文一个字节没动。
    expect(paraTextAt(MIXED)).toBe('ABBCCDDEE');
  });
});

// ---------------------------------------------------------------------------

describe('重叠 ⇒ 具名进 damaged，不静默沿用', () => {
  it('剩余记录与本次移除区间重叠 ⇒ damaged 具名该记录，且它仍留在 remaining 里', () => {
    const overlapping = record({
      id: 'overlap',
      kind: 'delete',
      range: { node_id: 'p1', start: 2, end: 4 },
      text: 'BC',
    });
    const outcome = requireOk(applyRevisionDecisions(MIXED, [DELETE_BB, overlapping], [
      { decision: 'accept', selector: { kind: 'ids', ids: ['delBB'] } },
    ]));
    expect(outcome.damaged).toEqual(['overlap']);
    // 未被静默丢弃：它仍以原名留在剩余里（偏移无法安全重定基，故不改）。
    expect(outcome.remaining.map((r) => r.id)).toEqual(['overlap']);
    const named = outcome.remaining[0]!;
    expect({ start: named.range.start, end: named.range.end }).toEqual({ start: 2, end: 4 });
  });

  it('已损坏的记录被后续判决选中 ⇒ precondition 失败（拒绝套用陈旧区间）', () => {
    const overlapping = record({
      id: 'overlap',
      kind: 'delete',
      range: { node_id: 'p1', start: 2, end: 4 },
      text: 'BC',
    });
    const result = applyRevisionDecisions(MIXED, [DELETE_BB, overlapping], [
      { decision: 'accept', selector: { kind: 'ids', ids: ['delBB'] } },
      { decision: 'accept', selector: { kind: 'ids', ids: ['overlap'] } },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('precondition');
    expect(result.detail.extra?.damaged).toBe('overlap');
  });
});

// ---------------------------------------------------------------------------

describe('跨段落：未处理记录原样不动', () => {
  const TWO_PARA = document([
    paragraphOfRuns('p1', [['r1', 'HELLO']]),
    paragraphOfRuns('p2', [['r2', 'WORLD']]),
  ]);
  const DEL_H = record({ id: 'd1', kind: 'delete', range: { node_id: 'p1', start: 0, end: 1 }, text: 'H' });
  const DEL_W = record({ id: 'd2', kind: 'delete', range: { node_id: 'p2', start: 0, end: 1 }, text: 'W' });

  it('接受 p1 的删除不影响 p2 的文字与记录偏移', () => {
    const outcome = requireOk(applyRevisionDecisions(TWO_PARA, [DEL_H, DEL_W], [
      { decision: 'accept', selector: { kind: 'ids', ids: ['d1'] } },
    ]));
    expect(paraTextAt(outcome.model, 0)).toBe('ELLO');
    // p2 完全未被触及。
    expect(paraTextAt(outcome.model, 1)).toBe('WORLD');
    expect(outcome.remaining.map((r) => r.id)).toEqual(['d2']);
    const d2 = outcome.remaining[0]!;
    expect({ start: d2.range.start, end: d2.range.end }).toEqual({ start: 0, end: 1 });
    expect(outcome.damaged).toEqual([]);
  });

  it('接着接受 p2 的删除仍切到 "W"（跨段之间互不重定基）', () => {
    const outcome = requireOk(applyRevisionDecisions(TWO_PARA, [DEL_H, DEL_W], [
      { decision: 'accept', selector: { kind: 'ids', ids: ['d1'] } },
      { decision: 'accept', selector: { kind: 'ids', ids: ['d2'] } },
    ]));
    expect(paraTextAt(outcome.model, 0)).toBe('ELLO');
    expect(paraTextAt(outcome.model, 1)).toBe('ORLD');
    expect(outcome.processed).toEqual(['d1', 'd2']);
    expect(outcome.remaining).toEqual([]);
  });
});

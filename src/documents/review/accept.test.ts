/**
 * 接受 / 拒绝修订单测（WF-079）。
 *
 * 判据：**保留未处理记录**——接受/拒绝一条后，其余记录**仍在**；且批次原子（失败即整批不改）。
 */

import { describe, expect, it } from 'vitest';

import { TOGGLE_UNSPECIFIED, type DocumentModel } from '../model/types.js';
import { document, paragraphOfRuns } from '../selection/testing.js';
import { acceptRevision, acceptRevisions, rejectRevision, rejectRevisions } from './accept.js';
import type { RevisionRecord } from './types.js';

function paraText(model: DocumentModel): string {
  const block = model.blocks[0];
  if (block?.kind !== 'paragraph') throw new Error('setup');
  return block.inlines.map((inline) => (inline.kind === 'run' ? inline.text : '')).join('');
}

const doc = document([paragraphOfRuns('p1', [['r1', 'ABCDEF']])]);

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

describe('单条：删除', () => {
  it('接受删除 ⇒ 文字真的被删', () => {
    const del = record({ id: 'd1', kind: 'delete', range: { node_id: 'p1', start: 2, end: 5 }, text: 'CDE' });
    const accepted = acceptRevision(doc, del);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(paraText(accepted.value)).toBe('ABF');
  });

  it('拒绝删除 ⇒ 文字保留', () => {
    const del = record({ id: 'd1', kind: 'delete', range: { node_id: 'p1', start: 2, end: 5 }, text: 'CDE' });
    const rejected = rejectRevision(doc, del);
    expect(rejected.ok && paraText(rejected.value)).toBe('ABCDEF');
  });
});

describe('单条：插入', () => {
  const inserted = document([paragraphOfRuns('p1', [['r1', 'XYABCDEF']])]);

  it('接受插入 ⇒ 文字保留', () => {
    const ins = record({ id: 'i1', kind: 'insert', range: { node_id: 'p1', start: 0, end: 2 }, text: 'XY' });
    const accepted = acceptRevision(inserted, ins);
    expect(accepted.ok && paraText(accepted.value)).toBe('XYABCDEF');
  });

  it('拒绝插入 ⇒ 删掉插入的文字', () => {
    const ins = record({ id: 'i1', kind: 'insert', range: { node_id: 'p1', start: 0, end: 2 }, text: 'XY' });
    const rejected = rejectRevision(inserted, ins);
    expect(rejected.ok && paraText(rejected.value)).toBe('ABCDEF');
  });
});

describe('单条：格式', () => {
  const formatRecord = record({
    id: 'f1',
    kind: 'format',
    range: { node_id: 'p1', start: 0, end: 0 },
    format: {
      target: 'run',
      node_id: 'p1',
      run_index: 0,
      property: 'bold',
      before: TOGGLE_UNSPECIFIED,
      after: { state: 'on' },
    },
  });

  function boldState(model: DocumentModel): string {
    const block = model.blocks[0];
    if (block?.kind !== 'paragraph') throw new Error('setup');
    const run = block.inlines[0];
    if (run?.kind !== 'run') throw new Error('setup');
    return run.properties.bold.state;
  }

  it('接受格式 ⇒ 用 after', () => {
    const accepted = acceptRevision(doc, formatRecord);
    expect(accepted.ok && boldState(accepted.value)).toBe('on');
  });

  it('拒绝格式 ⇒ 回到 before', () => {
    const rejected = rejectRevision(doc, formatRecord);
    expect(rejected.ok && boldState(rejected.value)).toBe('unspecified');
  });
});

describe('批量：保留未处理记录', () => {
  const d1 = record({ id: 'd1', kind: 'delete', range: { node_id: 'p1', start: 1, end: 2 }, text: 'B' });
  const d2 = record({ id: 'd2', kind: 'delete', range: { node_id: 'p1', start: 4, end: 5 }, text: 'E' });

  it('只接受 d1 ⇒ 模型只删 B，d2 仍在剩余里', () => {
    const outcome = acceptRevisions(doc, [d1, d2], { kind: 'ids', ids: ['d1'] });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(paraText(outcome.value.model)).toBe('ACDEF');
    expect(outcome.value.processed).toEqual(['d1']);
    expect(outcome.value.remaining.map((r) => r.id)).toEqual(['d2']);
  });

  it('全部接受 ⇒ 剩余为空', () => {
    const outcome = acceptRevisions(doc, [d1, d2], { kind: 'all' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(paraText(outcome.value.model)).toBe('ACDF');
    expect(outcome.value.remaining).toHaveLength(0);
  });

  it('按选区选择：只命中重叠的记录', () => {
    const outcome = acceptRevisions(doc, [d1, d2], { kind: 'range', range: { node_id: 'p1', start: 0, end: 3 } });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.processed).toEqual(['d1']);
    expect(outcome.value.remaining.map((r) => r.id)).toEqual(['d2']);
  });

  it('拒绝 d2 ⇒ 保留 E 且 d1 仍在剩余里', () => {
    const outcome = rejectRevisions(doc, [d1, d2], { kind: 'ids', ids: ['d2'] });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(paraText(outcome.value.model)).toBe('ABCDEF');
    expect(outcome.value.remaining.map((r) => r.id)).toEqual(['d1']);
  });

  it('原子性：批次里有一条非法 ⇒ 整批不改', () => {
    const bad = record({ id: 'bad', kind: 'delete', range: { node_id: 'p1', start: 10, end: 12 }, text: '??' });
    const outcome = acceptRevisions(doc, [d1, bad], { kind: 'all' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('invalid_range');
    // 调用方手上的 doc 未变
    expect(paraText(doc)).toBe('ABCDEF');
  });
});

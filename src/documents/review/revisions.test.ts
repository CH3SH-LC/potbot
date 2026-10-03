/**
 * 修订开关与记录单测（WF-078；R137/R141）。
 */

import { describe, expect, it } from 'vitest';

import {
  disableTrackChanges,
  enableTrackChanges,
  revisionSummary,
  trackDelete,
  trackFormat,
  trackInsert,
} from './revisions.js';
import type { RevisionRecord, TrackChangesState } from './types.js';

const range = { node_id: 'p1', start: 2, end: 4 };
const off: TrackChangesState = { enabled: false, author: '诚哥' };

describe('修订开关', () => {
  it('关闭时 track* 不产生记录', () => {
    const outcome = trackInsert(off, [], { id: 'i1', date: '2026-10-03T00:00:00Z', range, text: '新字' });
    expect(outcome.tracked).toBe(false);
    expect(outcome.records).toHaveLength(0);
  });

  it('打开后记录插入/删除/格式', () => {
    const on = enableTrackChanges(off, '浅雪');
    const i = trackInsert(on, [], { id: 'i1', date: 'd1', range, text: '新字' });
    const d = trackDelete(on, i.records, { id: 'd1', date: 'd2', range, text: '旧字' });
    const f = trackFormat(on, d.records, {
      id: 'f1',
      date: 'd3',
      range,
      change: { target: 'run', node_id: 'p1', run_index: 0, property: 'bold', before: { state: 'unspecified' }, after: { state: 'on' } },
    });
    expect(f.tracked).toBe(true);
    expect(f.records).toHaveLength(3);
    expect(f.records[0]?.author).toBe('浅雪');
    expect(f.records[0]?.kind).toBe('insert');
    expect(f.records[0]?.text).toBe('新字');
    expect(f.records[1]?.kind).toBe('delete');
    expect(f.records[1]?.text).toBe('旧字');
    expect(f.records[2]?.kind).toBe('format');
    expect(f.records[2]?.format?.property).toBe('bold');
  });

  it('幂等：同 id 重复提交不产生第二条（R137）', () => {
    const on = enableTrackChanges(off);
    const first = trackInsert(on, [], { id: 'dup', date: 'd', range, text: 'a' });
    const again = trackInsert(on, first.records, { id: 'dup', date: 'd', range, text: 'a' });
    expect(again.tracked).toBe(true);
    expect(again.records).toHaveLength(1);
  });

  it('关闭开关后不再记录', () => {
    const on = enableTrackChanges(off);
    const stopped = disableTrackChanges(on);
    const outcome = trackInsert(stopped, [] as readonly RevisionRecord[], { id: 'x', date: 'd', range, text: 'a' });
    expect(outcome.tracked).toBe(false);
  });

  it('revisionSummary 统计三类', () => {
    const on = enableTrackChanges(off);
    let records: readonly RevisionRecord[] = [];
    const i = trackInsert(on, records, { id: 'i', date: 'd', range, text: 'a' });
    records = i.records;
    const d = trackDelete(on, records, { id: 'd', date: 'd', range, text: 'b' });
    records = d.records;
    expect(revisionSummary(records)).toEqual({ insert: 1, delete: 1, format: 0 });
  });
});

/**
 * 脚注 / 尾注单测（WF-075）：编号与引用一致（编号按文档顺序**派生**）。
 */

import { describe, expect, it } from 'vitest';

import { document, paragraphOfRuns } from '../selection/testing.js';
import { addNote, checkNoteNumbering, editNoteText, numberNotes, removeNote } from './notes.js';
import type { Note } from './types.js';

const doc = document([paragraphOfRuns('p1', [['r1', '第一段文字。']]), paragraphOfRuns('p2', [['r2', '第二段文字。']])]);

function seed(): readonly Note[] {
  let notes: readonly Note[] = [];
  // 故意**乱序**插入，验证编号是按文档顺序算的，不是按插入顺序。
  const b = addNote(notes, { id: 'n2', kind: 'footnote', marker: { node_id: 'p2', start: 3, end: 3 }, text: '注二' });
  if (!b.ok) throw new Error('setup');
  notes = b.value;
  const a = addNote(notes, { id: 'n1', kind: 'footnote', marker: { node_id: 'p1', start: 2, end: 2 }, text: '注一' });
  if (!a.ok) throw new Error('setup');
  return a.value;
}

describe('脚注编号（WF-075）', () => {
  it('编号按文档顺序，而非插入顺序', () => {
    const numbered = numberNotes(doc, seed());
    expect(numbered.map((note) => [note.id, note.number])).toEqual([
      ['n1', 1],
      ['n2', 2],
    ]);
  });

  it('删除一条后其余自动重排（引用始终连续）', () => {
    const removed = removeNote(seed(), 'n1');
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    const numbered = numberNotes(doc, removed.value);
    expect(numbered.map((note) => [note.id, note.number])).toEqual([['n2', 1]]);
    expect(checkNoteNumbering(doc, removed.value).ok).toBe(true);
  });

  it('脚注与尾注各自独立编号', () => {
    let notes: readonly Note[] = [];
    const fn = addNote(notes, { id: 'f1', kind: 'footnote', marker: { node_id: 'p1', start: 1, end: 1 }, text: '脚注' });
    if (!fn.ok) throw new Error('setup');
    const en = addNote(fn.value, { id: 'e1', kind: 'endnote', marker: { node_id: 'p2', start: 1, end: 1 }, text: '尾注' });
    if (!en.ok) throw new Error('setup');
    notes = en.value;
    const numbered = numberNotes(doc, notes);
    expect(numbered.find((note) => note.id === 'f1')?.number).toBe(1);
    expect(numbered.find((note) => note.id === 'e1')?.number).toBe(1);
  });

  it('编辑注文', () => {
    const edited = editNoteText(seed(), 'n2', '改过的注文');
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.find((note) => note.id === 'n2')?.text).toBe('改过的注文');
  });

  it('删除不存在的注 ⇒ not_found；重复 id ⇒ 拒绝', () => {
    expect(removeNote(seed(), 'nope').ok).toBe(false);
    const dup = addNote(seed(), { id: 'n1', kind: 'footnote', marker: { node_id: 'p1', start: 0, end: 0 }, text: 'x' });
    expect(dup.ok).toBe(false);
  });

  it('标记落在不存在的段落 ⇒ 自检报出问题', () => {
    const orphan = addNote(seed(), { id: 'bad', kind: 'footnote', marker: { node_id: 'ghost', start: 0, end: 0 }, text: '漂了' });
    if (!orphan.ok) throw new Error('setup');
    const check = checkNoteNumbering(doc, orphan.value);
    expect(check.ok).toBe(false);
    expect(check.problems.join('')).toContain('ghost');
  });
});

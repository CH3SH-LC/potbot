/**
 * 脚注 / 尾注（WF-075）。
 *
 * ## 编号是**派生的**，不是存储的
 *
 * 若每个注自己存一个 `number`，那么"中间插一个注"就要靠代码去遍历后续所有注各改一遍；
 * 漏改一处，正文引用标记的号就和注文对不上。这里把 `number` **从存储里去掉**，
 * 只按**文档顺序**派生（`numberNotes`）——于是"编号与引用一致"是结构上成立的，
 * 而不是靠每处都记得同步。
 *
 * 脚注与尾注**各自独立编号**（Word 语义），所以编号时按 `kind` 分组。
 */

import type { DocumentModel } from '../model/types.js';
import { collectParagraphs } from '../selection/structure.js';
import { fail, succeed, type DocumentRange, type Result } from '../selection/types.js';
import type { Note, NoteKind, NumberedNote } from './types.js';

function assertMarker(marker: DocumentRange): Result<DocumentRange> {
  if (
    !Number.isInteger(marker.start) ||
    !Number.isInteger(marker.end) ||
    marker.start < 0 ||
    marker.end < marker.start
  ) {
    return fail('invalid_range', `注记位置非法：[${marker.start}, ${marker.end})。`, {
      extra: { start: marker.start, end: marker.end },
    });
  }
  return succeed(marker);
}

/** 新增脚注 / 尾注。 */
export function addNote(
  notes: readonly Note[],
  input: { readonly id: string; readonly kind: NoteKind; readonly marker: DocumentRange; readonly text: string },
): Result<readonly Note[]> {
  if (input.kind !== 'footnote' && input.kind !== 'endnote') {
    return fail('precondition', `注类型非法：${String(input.kind)}。`, { extra: { kind: String(input.kind) } });
  }
  if (notes.some((note) => note.id === input.id)) {
    return fail('precondition', `注 id 重复："${input.id}"。`, { extra: { id: input.id } });
  }
  const marker = assertMarker(input.marker);
  if (!marker.ok) return marker;
  const note: Note = { id: input.id, kind: input.kind, marker: marker.value, text: input.text, intact: true };
  return succeed([...notes, note]);
}

/** 编辑注文（按 id）。 */
export function editNoteText(notes: readonly Note[], id: string, text: string): Result<readonly Note[]> {
  if (!notes.some((note) => note.id === id)) {
    return fail('not_found', `不存在 id 为 "${id}" 的注。`, { extra: { id } });
  }
  return succeed(notes.map((note) => (note.id === id ? { ...note, text } : note)));
}

/** 删除注（按 id）。 */
export function removeNote(notes: readonly Note[], id: string): Result<readonly Note[]> {
  if (!notes.some((note) => note.id === id)) {
    return fail('not_found', `不存在 id 为 "${id}" 的注。`, { extra: { id } });
  }
  return succeed(notes.filter((note) => note.id !== id));
}

/** 段落 id → 文档顺序下标（0 起）；不在文档里的返回 `null`。 */
function documentOrder(model: DocumentModel): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  const paragraphs = collectParagraphs(model.blocks);
  for (let index = 0; index < paragraphs.length; index += 1) {
    map.set((paragraphs[index] as { id: string }).id, index);
  }
  return map;
}

/**
 * 按文档顺序给注编号（脚注与尾注各自 1 起）。
 * 位置解析不到的注排到末尾并保持原顺序（确定性），由 `checkNoteNumbering` 报出问题。
 */
export function numberNotes(model: DocumentModel, notes: readonly Note[]): readonly NumberedNote[] {
  const order = documentOrder(model);
  const indexed = notes.map((note, originalIndex) => {
    const paragraphIndex = order.get(note.marker.node_id);
    return { note, originalIndex, paragraphIndex: paragraphIndex ?? Number.MAX_SAFE_INTEGER };
  });
  indexed.sort((a, b) => {
    if (a.paragraphIndex !== b.paragraphIndex) return a.paragraphIndex - b.paragraphIndex;
    if (a.note.marker.start !== b.note.marker.start) return a.note.marker.start - b.note.marker.start;
    return a.originalIndex - b.originalIndex;
  });

  const counters: Record<NoteKind, number> = { footnote: 0, endnote: 0 };
  return indexed.map(({ note }) => {
    counters[note.kind] += 1;
    return { ...note, number: counters[note.kind] };
  });
}

/** 编号与引用一致性自检：编号连续、位置可解析、kind 合法。 */
export function checkNoteNumbering(
  model: DocumentModel,
  notes: readonly Note[],
): { readonly ok: boolean; readonly problems: readonly string[] } {
  const problems: string[] = [];
  const order = documentOrder(model);
  for (const note of notes) {
    if (order.get(note.marker.node_id) === undefined) {
      problems.push(`注 "${note.id}" 的标记落在不存在的段落 "${note.marker.node_id}" 上。`);
    }
  }
  const numbered = numberNotes(model, notes);
  for (const kind of ['footnote', 'endnote'] as const) {
    const group = numbered.filter((note) => note.kind === kind);
    for (let index = 0; index < group.length; index += 1) {
      const expected = index + 1;
      if ((group[index] as NumberedNote).number !== expected) {
        problems.push(`${kind} 编号不连续：第 ${index + 1} 个应为 ${expected}。`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

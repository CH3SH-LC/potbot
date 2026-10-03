/**
 * 修订（WF-078；合同 R137/R141）。
 *
 * ## "真实修订语义"是什么
 *
 * 开着修订时，编辑**不是**直接改正文了事，而是**记下意图**：
 * - 插入 → 文字进正文，同时留一条"这里插入过"的记录；
 * - 删除 → 文字**暂时留在正文里**（显示为删除线），留一条"待删"的记录，**接受后才真删**；
 * - 格式 → 记下属性 `before`/`after`，接受保留新值、拒绝回到旧值。
 *
 * 因此本模块产出的是 `RevisionRecord[]`（意图），由 `accept.ts` 负责按意图算结果模型。
 * 记录本身就是"待处理队列"——这为"接受一条后其余**仍在**"提供了结构基础。
 *
 * ## 关闭修订时**不产生记录**
 *
 * `enabled === false` 时 `track*` 原样返回（`tracked:false`）——**不**记一条"没被跟踪的改动"，
 * 那样会让开关失去意义。
 *
 * ## 幂等（R137）
 *
 * 同一条记录（同 `id`）重复提交**不产生第二条**——重试不重复落账。
 */

import type { RevisionRecord, RevisionKind, TrackChangesState } from './types.js';

export function enableTrackChanges(state: TrackChangesState, author?: string): TrackChangesState {
  return { enabled: true, author: author ?? state.author };
}

export function disableTrackChanges(state: TrackChangesState): TrackChangesState {
  return { ...state, enabled: false };
}

interface TrackInputBase {
  readonly id: string;
  readonly date: string;
  readonly author?: string;
  readonly range: RevisionRecord['range'];
}

export interface TrackInsertInput extends TrackInputBase {
  readonly text: string;
}

export interface TrackDeleteInput extends TrackInputBase {
  readonly text: string;
}

export interface TrackFormatInput extends TrackInputBase {
  readonly change: NonNullable<RevisionRecord['format']>;
}

export interface TrackOutcome {
  readonly tracked: boolean;
  readonly records: readonly RevisionRecord[];
}

function append(
  state: TrackChangesState,
  records: readonly RevisionRecord[],
  input: TrackInputBase,
  make: (author: string) => RevisionRecord,
): TrackOutcome {
  if (!state.enabled) {
    return { tracked: false, records };
  }
  if (records.some((record) => record.id === input.id)) {
    // 幂等：同 id 不重复落账（R137）。
    return { tracked: true, records };
  }
  return { tracked: true, records: [...records, make(input.author ?? state.author)] };
}

/** 记一条插入修订。 */
export function trackInsert(
  state: TrackChangesState,
  records: readonly RevisionRecord[],
  input: TrackInsertInput,
): TrackOutcome {
  return append(state, records, input, (author) => ({
    id: input.id,
    kind: 'insert',
    author,
    date: input.date,
    range: input.range,
    text: input.text,
    format: null,
  }));
}

/** 记一条删除修订（文字**仍在**正文里，接受后才删）。 */
export function trackDelete(
  state: TrackChangesState,
  records: readonly RevisionRecord[],
  input: TrackDeleteInput,
): TrackOutcome {
  return append(state, records, input, (author) => ({
    id: input.id,
    kind: 'delete',
    author,
    date: input.date,
    range: input.range,
    text: input.text,
    format: null,
  }));
}

/** 记一条格式修订。 */
export function trackFormat(
  state: TrackChangesState,
  records: readonly RevisionRecord[],
  input: TrackFormatInput,
): TrackOutcome {
  return append(state, records, input, (author) => ({
    id: input.id,
    kind: 'format',
    author,
    date: input.date,
    range: input.range,
    text: null,
    format: input.change,
  }));
}

/** 修订统计（读取/核对用）。 */
export function revisionSummary(records: readonly RevisionRecord[]): Readonly<Record<RevisionKind, number>> {
  const summary: Record<RevisionKind, number> = { insert: 0, delete: 0, format: 0 };
  for (const record of records) {
    summary[record.kind] += 1;
  }
  return summary;
}

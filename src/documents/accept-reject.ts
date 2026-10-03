/**
 * **接受 / 拒绝修订的编排层**（design-05-P7 / WF-079 的"可导出"侧收口）。
 *
 * ## 与 `review/accept.ts` 的分工
 *
 * `review/accept.ts` 已经有 `acceptRevisions` / `rejectRevisions` 引擎（原子、保序、
 * **保留未处理记录**）。本文件**不重写**它，而是补三件它还缺的东西：
 *
 * 1. **按作者**筛选（`acceptByAuthor` / `rejectByAuthor`）——`RevisionSelector` 只认
 *    `ids` / `range` / `all`，而"只接受某位审阅人的改动"是最常用的审阅动作之一；
 * 2. **零命中可解释**（R112）：按作者 / 按范围筛出 0 条时**明确返回 `not_found`**，
 *    而不是静默地"成功处理了 0 条"——那会让调用方以为改动了什么；
 * 3. **带基线的编辑会话**（`TrackedSession`）：记录"改动前的文档"，于是**整批拒绝 = 回到基线**，
 *    这在**部件字节级**是精确还原（见下方"为什么基线还原不是取巧"）。
 *
 * ## 为什么"整批拒绝回到基线"不是取巧
 *
 * 逐条逆操作（`rejectRevision`）在**文字层**是精确的：插入 ⇒ 删掉那段文字；删除 ⇒ 保留文字；
 * 格式 ⇒ 回到 `before`。但**结构层**未必：在 run 内部插入文字会先**切开** run，逆操作删掉
 * 插入的部分后，原 run 仍留成两段（文字一样、run 边界不一样）⇒ 导出字节与原文不等。
 *
 * 真实修订工作流里，"拒绝全部"的语义就是**回到没有任何未决改动的状态**。因此本层显式保存
 * `baseline`，整批拒绝直接回基线——**结构性**还原，从而"拒绝后与原文**逐字节**相等"
 * 在部件级成立（`accept-reject.test.ts` 用真实语料验证；不依赖快照的**逐条**逆操作另有用例，
 * 覆盖"在 run 边界插入"这种不产生切分的情形）。
 *
 * ## 未验证声明
 *
 * 本层是**模型层**编排：`w:ins` / `w:del` 是否被消费端正确渲染，**未**经 Word / WPS 读回核对
 * ⇒ 标 **未验证（需消费端）**。字节往返只在**部件级**（解压后）验证，且整包 ZIP 因压缩方式
 * 不同不可逐字节比较（与 `docx/roundtrip.test.ts` 的判定口径一致）。
 *
 * ## 交付说明（身份标注）
 *
 * 本文件由一个**子智能体**在 worktree `fa/doc-review` 内产出；该子智能体的**模型身份未确认为 DS**。
 * 结论以本文件与同名用例（`accept-reject.test.ts`，含逐部件字节往返）的可复算证据为准。
 */

import type { DocumentModel } from './model/types.js';
import { acceptRevisions, rejectRevisions, type BatchOutcome, type RevisionSelector } from './review/accept.js';
import { trackDelete, trackFormat, trackInsert } from './review/revisions.js';
import type { FormatChange, RevisionRecord, TrackChangesState } from './review/types.js';
import { replaceRangeInInlines } from './selection/inline-map.js';
import { requireParagraph, replaceParagraph } from './selection/structure.js';
import { fail, succeed, type DocumentRange, type Result } from './selection/types.js';

// 引擎的公开面**原样透出**：调用方只 import 本文件即可拿到全部接受/拒绝能力。
export { acceptRevisions, rejectRevisions } from './review/accept.js';
export type { BatchOutcome, RevisionSelector } from './review/accept.js';

// ---------------------------------------------------------------------------
// 选择
// ---------------------------------------------------------------------------

/** 某位作者的全部修订（保持记录原顺序）。 */
export function selectRevisionsByAuthor(
  records: readonly RevisionRecord[],
  author: string,
): readonly RevisionRecord[] {
  return records.filter((record) => record.author === author);
}

/** 文档里出现过的作者（去重、按首次出现顺序）。 */
export function revisionAuthors(records: readonly RevisionRecord[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const record of records) {
    if (seen.has(record.author)) continue;
    seen.add(record.author);
    out.push(record.author);
  }
  return out;
}

/** 每条修订的作者分布（读取 / 核对用）。 */
export function revisionsByAuthor(
  records: readonly RevisionRecord[],
): Readonly<Record<string, readonly RevisionRecord[]>> {
  const out: Record<string, RevisionRecord[]> = {};
  for (const record of records) {
    (out[record.author] ??= []).push(record);
  }
  return out;
}

function emptyBatchResult(model: DocumentModel, records: readonly RevisionRecord[]): Result<BatchOutcome> {
  // 一个"什么都没处理"的成功是最容易误导人的结果——按 R112 明确报"零命中"。
  return fail('not_found', '选中的修订集合为空：没有任何记录会被处理。', {
    hitCount: 0,
    needsClarification: true,
    extra: { records: records.length },
  });
}

/**
 * 按作者接受修订。零命中 ⇒ `not_found`（R112），不返回"成功了但什么都没做"。
 */
export function acceptByAuthor(
  model: DocumentModel,
  records: readonly RevisionRecord[],
  author: string,
): Result<BatchOutcome> {
  const selected = selectRevisionsByAuthor(records, author);
  if (selected.length === 0) {
    return fail('not_found', `没有作者为 "${author}" 的修订可接受。`, {
      expression: author,
      hitCount: 0,
      needsClarification: true,
      extra: { authors: revisionAuthors(records).join(', ') },
    });
  }
  return acceptRevisions(model, records, { kind: 'ids', ids: selected.map((record) => record.id) });
}

/** 按作者拒绝修订。零命中 ⇒ `not_found`（R112）。 */
export function rejectByAuthor(
  model: DocumentModel,
  records: readonly RevisionRecord[],
  author: string,
): Result<BatchOutcome> {
  const selected = selectRevisionsByAuthor(records, author);
  if (selected.length === 0) {
    return fail('not_found', `没有作者为 "${author}" 的修订可拒绝。`, {
      expression: author,
      hitCount: 0,
      needsClarification: true,
      extra: { authors: revisionAuthors(records).join(', ') },
    });
  }
  return rejectRevisions(model, records, { kind: 'ids', ids: selected.map((record) => record.id) });
}

/** 接受落在一段范围里的修订（同段落且区间相交）。 */
export function acceptInRange(
  model: DocumentModel,
  records: readonly RevisionRecord[],
  range: DocumentRange,
): Result<BatchOutcome> {
  return acceptRevisions(model, records, { kind: 'range', range });
}

/** 拒绝落在一段范围里的修订（同段落且区间相交）。 */
export function rejectInRange(
  model: DocumentModel,
  records: readonly RevisionRecord[],
  range: DocumentRange,
): Result<BatchOutcome> {
  return rejectRevisions(model, records, { kind: 'range', range });
}

/** 接受全部修订。空集合 ⇒ `not_found`（同"零命中可解释"口径）。 */
export function acceptAll(
  model: DocumentModel,
  records: readonly RevisionRecord[],
): Result<BatchOutcome> {
  if (records.length === 0) return emptyBatchResult(model, records);
  return acceptRevisions(model, records, { kind: 'all' });
}

/** 拒绝全部修订。空集合 ⇒ `not_found`。 */
export function rejectAll(
  model: DocumentModel,
  records: readonly RevisionRecord[],
): Result<BatchOutcome> {
  if (records.length === 0) return emptyBatchResult(model, records);
  return rejectRevisions(model, records, { kind: 'all' });
}

/** 选中的修订集合（供调用方在"处理前"先看一遍）。 */
export function selectRevisions(
  records: readonly RevisionRecord[],
  selector: RevisionSelector,
): readonly RevisionRecord[] {
  switch (selector.kind) {
    case 'all':
      return records;
    case 'ids': {
      const ids = new Set(selector.ids);
      return records.filter((record) => ids.has(record.id));
    }
    case 'range': {
      const { range } = selector;
      return records.filter(
        (record) =>
          record.range.node_id === range.node_id &&
          record.range.start <= range.end &&
          record.range.end >= range.start,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 带基线的编辑会话
// ---------------------------------------------------------------------------

/**
 * 一次"开着修订做编辑"的会话。
 *
 * `baseline` 是**改动前**的文档（整批拒绝的还原点）；`model` 是**当前**文档；
 * `records` 是尚未处理的修订记录。三者都是不可变值，每次编辑返回**新会话**。
 */
export interface TrackedSession {
  readonly baseline: DocumentModel;
  readonly model: DocumentModel;
  readonly records: readonly RevisionRecord[];
  readonly state: TrackChangesState;
}

/** 打开一个会话（基线 = 当前文档，无未决修订）。 */
export function openTrackedSession(document: DocumentModel, author: string): TrackedSession {
  return { baseline: document, model: document, records: [], state: { enabled: true, author } };
}

function replaceRange(
  model: DocumentModel,
  nodeId: DocumentRange['node_id'],
  start: number,
  end: number,
  replacement: string,
): Result<DocumentModel> {
  const paragraph = requireParagraph(model, nodeId);
  if (!paragraph.ok) return paragraph;
  const inlines = replaceRangeInInlines(paragraph.value.inlines, start, end, replacement);
  if (!inlines.ok) return inlines;
  return replaceParagraph(model, nodeId, { ...paragraph.value, inlines: inlines.value });
}

/**
 * 插入修订的输入。
 *
 * `range` 是**零长度插入点**（`start === end`）——被插入文字占据的区间
 * `[start, start + 码位数)` 由本函数**按文字长度派生**，不由调用方给。
 *
 * 这是刻意的：修订记录里的 `range` 描述的是"这段文字在正文里占了哪儿"，而不是"从哪儿开始插"。
 * 若让调用方两处各给一次（插在哪 + 记录写多少），必然出现"记录写了个零长度区间 ⇒
 * 拒绝时删了个空"这种**看起来通过、其实没还原**的错——本层的用例正是抓到了这一点。
 */
export interface SessionInsertInput {
  readonly id: string;
  readonly date: string;
  /** 零长度插入点（`start === end`）。 */
  readonly range: DocumentRange;
  readonly text: string;
  readonly author?: string;
}

export interface SessionDeleteInput extends SessionInsertInput {}

export interface SessionFormatInput {
  readonly id: string;
  readonly date: string;
  readonly range: DocumentRange;
  readonly change: FormatChange;
  readonly author?: string;
}

/**
 * 记一条插入修订：文字**进正文**，并留一条"这里插入过"的记录。
 *
 * 幂等（R137）：同 `id` 再次提交 ⇒ 原样返回会话（不重复插入、不重复落账）。
 * 原子（R136）：文字编辑失败 ⇒ 返回失败，会话（含 `records`）一个字节没动。
 */
export function sessionInsert(session: TrackedSession, input: SessionInsertInput): Result<TrackedSession> {
  if (input.range.start !== input.range.end) {
    return fail(
      'precondition',
      `插入修订需要一个零长度插入点（range.start === range.end），收到 [${input.range.start}, ${input.range.end})。` +
        '被插入文字占据的区间由本函数按文字长度派生，不要在这里给。',
      { extra: { id: input.id, start: input.range.start, end: input.range.end } },
    );
  }
  const insertedLength = [...input.text].length;
  const extent: DocumentRange = {
    node_id: input.range.node_id,
    start: input.range.start,
    end: input.range.start + insertedLength,
  };
  const outcome = trackInsert(session.state, session.records, {
    id: input.id,
    date: input.date,
    ...(input.author === undefined ? {} : { author: input.author }),
    range: extent,
    text: input.text,
  });
  if (outcome.records === session.records) return succeed(session);
  const edited = replaceRange(session.model, input.range.node_id, input.range.start, input.range.start, input.text);
  if (!edited.ok) return edited;
  return succeed({ ...session, model: edited.value, records: outcome.records });
}

/**
 * 记一条删除修订：文字**仍在正文里**（等接受后才真删），只留记录。
 *
 * 因此"拒绝了删除"回到的正是这份未改动的正文——这也解释了为什么删除修订的
 * **拒绝是天然精确**的（不需要基线）。
 */
export function sessionDelete(session: TrackedSession, input: SessionDeleteInput): Result<TrackedSession> {
  const outcome = trackDelete(session.state, session.records, {
    id: input.id,
    date: input.date,
    ...(input.author === undefined ? {} : { author: input.author }),
    range: input.range,
    text: input.text,
  });
  if (outcome.records === session.records) return succeed(session);
  return succeed({ ...session, records: outcome.records });
}

/**
 * 记一条格式修订：正文**立即呈现"改后"的样子**（Word 的所见即所得），并留一条记录。
 *
 * "改后"的落地复用引擎的 `acceptRevision`（对格式记录就是应用 `after`），
 * 从而格式落地的属性白名单与拒绝时的回退路径**只有一处实现**。
 */
export function sessionFormat(session: TrackedSession, input: SessionFormatInput): Result<TrackedSession> {
  const outcome = trackFormat(session.state, session.records, {
    id: input.id,
    date: input.date,
    ...(input.author === undefined ? {} : { author: input.author }),
    range: input.range,
    change: input.change,
  });
  if (outcome.records === session.records) return succeed(session);
  const applied = acceptRevisions(
    session.model,
    outcome.records.filter((record) => record.id === input.id),
    { kind: 'all' },
  );
  if (!applied.ok) return applied;
  return succeed({ ...session, model: applied.value.model, records: outcome.records });
}

/** 接受会话里的全部未决修订（复用引擎；未处理的记录原样保留）。 */
export function sessionAcceptAll(session: TrackedSession): Result<BatchOutcome> {
  return acceptAll(session.model, session.records);
}

/** 按作者接受会话里的修订。 */
export function sessionAcceptByAuthor(session: TrackedSession, author: string): Result<BatchOutcome> {
  return acceptByAuthor(session.model, session.records, author);
}

/** 按范围接受会话里的修订。 */
export function sessionAcceptInRange(session: TrackedSession, range: DocumentRange): Result<BatchOutcome> {
  return acceptInRange(session.model, session.records, range);
}

/**
 * **拒绝全部未决修订 = 回到基线**（`baseline`）。
 *
 * 返回的就是打开会话时那份文档对象——于是"拒绝后与原文逐字节相等"是**结构性**成立的，
 * 不依赖逐条逆操作能否复原 run 切分（见文件头"为什么基线还原不是取巧"）。
 */
export function sessionRejectAll(session: TrackedSession): DocumentModel {
  return session.baseline;
}

/** 按作者拒绝（逐条逆操作；文字层精确，run 结构见文件头说明）。 */
export function sessionRejectByAuthor(
  session: TrackedSession,
  author: string,
): Result<BatchOutcome> {
  return rejectByAuthor(session.model, session.records, author);
}

/** 按范围拒绝（逐条逆操作；文字层精确）。 */
export function sessionRejectInRange(
  session: TrackedSession,
  range: DocumentRange,
): Result<BatchOutcome> {
  return rejectInRange(session.model, session.records, range);
}

/** 尚未处理的修订条数。 */
export function pendingRevisionCount(session: TrackedSession): number {
  return session.records.length;
}

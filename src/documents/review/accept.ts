/**
 * 接受 / 拒绝修订（WF-079；合同 R136/R110）。
 *
 * ## 单条 / 选区 / 全部，且**保留未处理记录**
 *
 * `acceptRevisions` / `rejectRevisions` 只对**被选中**的记录生效，返回结果里带 `remaining`
 * ——没被选中的记录**原样还在**。这不是"顺手把其余也清了"，那正是修订工作流最不该做的事。
 *
 * ## 原子性（R136）
 *
 * 一个批次在**局部变量**上累积；任一条失败即整批返回失败、**不产出半成品模型**，
 * 调用方手上的原模型一个字节没动。同段落内按 `start` **降序**落地，避免前面的编辑让后面的偏移失效。
 *
 * ## 接受/拒绝的语义
 *
 * - 插入：接受 = 保留文字（已插入），拒绝 = 删掉插入的文字；
 * - 删除：接受 = 真正删掉，拒绝 = 保留文字（当作没删过）；
 * - 格式：接受 = 用 `after`，拒绝 = 回到 `before`。
 *
 * 格式只落地**有限属性集**（run 的 bold/italic/strike/doubleStrike/underline、段落的 alignment/style_ref）；
 * 其余属性名返回 `unsupported`，**不静默忽略**（R110）。
 */

import type {
  Alignment,
  DocumentModel,
  ParagraphNode,
  RunNode,
  ToggleState,
  UnderlineStyle,
  ValuedState,
} from '../model/types.js';
import { replaceRangeInInlines } from '../selection/inline-map.js';
import { requireParagraph, replaceParagraph } from '../selection/structure.js';
import { fail, succeed, type DocumentRange, type Result } from '../selection/types.js';
import type { FormatChange, RevisionRecord } from './types.js';

// ---------------------------------------------------------------------------
// 文本落地
// ---------------------------------------------------------------------------

/** 从段落里删掉一个码位区间（零长度 = 无操作）。 */
function deleteRange(model: DocumentModel, range: DocumentRange): Result<DocumentModel> {
  if (range.start === range.end) {
    return succeed(model);
  }
  const paragraph = requireParagraph(model, range.node_id);
  if (!paragraph.ok) return paragraph;
  const inlines = replaceRangeInInlines(paragraph.value.inlines, range.start, range.end, '');
  if (!inlines.ok) return inlines;
  return replaceParagraph(model, range.node_id, { ...paragraph.value, inlines: inlines.value });
}

// ---------------------------------------------------------------------------
// 格式落地
// ---------------------------------------------------------------------------

function setRunProperty(run: RunNode, property: string, value: unknown): Result<RunNode> {
  switch (property) {
    case 'bold':
      return succeed({ ...run, properties: { ...run.properties, bold: value as ToggleState } });
    case 'italic':
      return succeed({ ...run, properties: { ...run.properties, italic: value as ToggleState } });
    case 'strike':
      return succeed({ ...run, properties: { ...run.properties, strike: value as ToggleState } });
    case 'doubleStrike':
      return succeed({ ...run, properties: { ...run.properties, doubleStrike: value as ToggleState } });
    case 'underline':
      return succeed({
        ...run,
        properties: { ...run.properties, underline: value as ValuedState<UnderlineStyle> },
      });
    default:
      return fail('unsupported', `本层不支持落地 run 属性 "${property}"（只覆盖 bold/italic/strike/doubleStrike/underline）。`, {
        extra: { property },
      });
  }
}

function setParagraphProperty(
  paragraph: ParagraphNode,
  property: string,
  value: unknown,
): Result<ParagraphNode> {
  switch (property) {
    case 'alignment':
      return succeed({
        ...paragraph,
        properties: { ...paragraph.properties, alignment: value as ValuedState<Alignment> },
      });
    case 'style_ref':
      return succeed({ ...paragraph, style_ref: (value as string | null) });
    default:
      return fail('unsupported', `本层不支持落地段落属性 "${property}"（只覆盖 alignment/style_ref）。`, {
        extra: { property },
      });
  }
}

function applyFormatChange(
  model: DocumentModel,
  change: FormatChange,
  direction: 'before' | 'after',
): Result<DocumentModel> {
  const value = direction === 'before' ? change.before : change.after;
  const paragraph = requireParagraph(model, change.node_id);
  if (!paragraph.ok) return paragraph;

  if (change.target === 'paragraph') {
    const updated = setParagraphProperty(paragraph.value, change.property, value);
    if (!updated.ok) return updated;
    return replaceParagraph(model, change.node_id, updated.value);
  }

  if (change.run_index === null) {
    return fail('precondition', 'run 级格式修订缺少 run_index。', { extra: { id: change.node_id } });
  }
  const inlines = [...paragraph.value.inlines];
  let runSeen = -1;
  let replaced = false;
  for (let index = 0; index < inlines.length; index += 1) {
    const inline = inlines[index]!;
    if (inline.kind !== 'run') continue;
    runSeen += 1;
    if (runSeen !== change.run_index) continue;
    const updated = setRunProperty(inline, change.property, value);
    if (!updated.ok) return updated;
    inlines[index] = updated.value;
    replaced = true;
    break;
  }
  if (!replaced) {
    return fail('not_found', `段落 "${change.node_id}" 里没有第 ${change.run_index} 个 run。`, {
      extra: { node_id: change.node_id, run_index: change.run_index },
    });
  }
  return replaceParagraph(model, change.node_id, { ...paragraph.value, inlines });
}

// ---------------------------------------------------------------------------
// 单条
// ---------------------------------------------------------------------------

/** 接受一条修订。 */
export function acceptRevision(model: DocumentModel, record: RevisionRecord): Result<DocumentModel> {
  switch (record.kind) {
    case 'insert':
      // 插入的文字已经在正文里；接受 = 保留。
      return succeed(model);
    case 'delete':
      return deleteRange(model, record.range);
    case 'format':
      if (record.format === null) {
        return fail('precondition', `格式修订 "${record.id}" 缺少格式变更内容。`, { extra: { id: record.id } });
      }
      return applyFormatChange(model, record.format, 'after');
  }
}

/** 拒绝一条修订。 */
export function rejectRevision(model: DocumentModel, record: RevisionRecord): Result<DocumentModel> {
  switch (record.kind) {
    case 'insert':
      return deleteRange(model, record.range);
    case 'delete':
      // 拒绝删除 = 保留文字（当作没删过）。
      return succeed(model);
    case 'format':
      if (record.format === null) {
        return fail('precondition', `格式修订 "${record.id}" 缺少格式变更内容。`, { extra: { id: record.id } });
      }
      return applyFormatChange(model, record.format, 'before');
  }
}

// ---------------------------------------------------------------------------
// 批量
// ---------------------------------------------------------------------------

export type RevisionSelector =
  | { readonly kind: 'ids'; readonly ids: readonly string[] }
  | { readonly kind: 'range'; readonly range: DocumentRange }
  | { readonly kind: 'all' };

function selectRecords(
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

/** 批内落地顺序：同段落按 `start` 降序，跨段落按 node_id 稳定排序。 */
function applyOrder(records: readonly RevisionRecord[]): readonly RevisionRecord[] {
  return [...records].sort((a, b) => {
    if (a.range.node_id !== b.range.node_id) return a.range.node_id < b.range.node_id ? -1 : 1;
    return b.range.start - a.range.start;
  });
}

export interface BatchOutcome {
  readonly model: DocumentModel;
  /** 本次实际处理的记录 id。 */
  readonly processed: readonly string[];
  /** **未处理**的记录（原样保留）。 */
  readonly remaining: readonly RevisionRecord[];
}

function applyBatch(
  model: DocumentModel,
  records: readonly RevisionRecord[],
  selector: RevisionSelector,
  applyOne: (model: DocumentModel, record: RevisionRecord) => Result<DocumentModel>,
): Result<BatchOutcome> {
  const chosen = applyOrder(selectRecords(records, selector));
  let current = model;
  const processed: string[] = [];
  for (const record of chosen) {
    const applied = applyOne(current, record);
    if (!applied.ok) {
      // 原子：整批失败，调用方手上仍是原模型。
      return applied;
    }
    current = applied.value;
    processed.push(record.id);
  }
  const processedSet = new Set(processed);
  return succeed({
    model: current,
    processed,
    remaining: records.filter((record) => !processedSet.has(record.id)),
  });
}

/** 接受选中的修订（单条 / 选区 / 全部），**保留未处理记录**。 */
export function acceptRevisions(
  model: DocumentModel,
  records: readonly RevisionRecord[],
  selector: RevisionSelector,
): Result<BatchOutcome> {
  return applyBatch(model, records, selector, acceptRevision);
}

/** 拒绝选中的修订，**保留未处理记录**。 */
export function rejectRevisions(
  model: DocumentModel,
  records: readonly RevisionRecord[],
  selector: RevisionSelector,
): Result<BatchOutcome> {
  return applyBatch(model, records, selector, rejectRevision);
}

// ---------------------------------------------------------------------------
// 部分批处理后的**剩余记录偏移重定基**（"未处理范围不损坏"）
// ---------------------------------------------------------------------------

/**
 * 一次批处理里**真正从正文删掉**的文字范围（码位，按段落）。
 *
 * 只有会删字的修订才产生它：接受删除（删被标记删除的文字）、拒绝插入（删掉插入的文字）。
 * 接受插入 / 拒绝删除 / 格式修订**都不改文字**，因此不产生移除。
 */
export interface RemovedRange {
  readonly node_id: DocumentRange['node_id'];
  readonly start: number;
  readonly end: number;
}

export interface RebasingBatchOutcome extends BatchOutcome {
  /**
   * **重定基后的未处理记录**——同段落里、落在本次移除之后的部分，其 `range` 已同步左移，
   * 于是它们仍指向**自身那段文字**，不会被前面的删除"拽偏"。
   */
  readonly remaining: readonly RevisionRecord[];
  /** 本次移除的文字范围（供审计 / 复算）。 */
  readonly removed: readonly RemovedRange[];
  /**
   * 与本次移除的文字**区间重叠**、因而偏移无法保证仍有效的剩余记录 id——**具名**，
   * 不静默（R110）。调用方应对这些记录重新解析或丢弃，不能假装它们还有效。
   */
  readonly damaged: readonly string[];
}

function removalsFor(
  chosen: readonly RevisionRecord[],
  decision: 'accept' | 'reject',
): readonly RemovedRange[] {
  const removed: RemovedRange[] = [];
  for (const record of chosen) {
    const deletes = decision === 'accept' ? record.kind === 'delete' : record.kind === 'insert';
    if (!deletes) continue;
    if (record.range.end <= record.range.start) continue;
    removed.push({ node_id: record.range.node_id, start: record.range.start, end: record.range.end });
  }
  return removed;
}

function rebaseRemaining(
  remaining: readonly RevisionRecord[],
  removed: readonly RemovedRange[],
): { readonly records: readonly RevisionRecord[]; readonly damaged: readonly string[] } {
  const damaged: string[] = [];
  const records = remaining.map((record) => {
    let shift = 0;
    let overlap = false;
    for (const removal of removed) {
      if (removal.node_id !== record.range.node_id) continue;
      if (removal.end <= record.range.start) shift += removal.end - removal.start;
      else if (removal.start < record.range.end) overlap = true;
    }
    if (overlap) {
      damaged.push(record.id);
      return record;
    }
    if (shift === 0) return record;
    return {
      ...record,
      range: { ...record.range, start: record.range.start - shift, end: record.range.end - shift },
    };
  });
  return { records, damaged };
}

function rebasedBatch(
  model: DocumentModel,
  records: readonly RevisionRecord[],
  selector: RevisionSelector,
  decision: 'accept' | 'reject',
): Result<RebasingBatchOutcome> {
  const engine = decision === 'accept' ? acceptRevisions : rejectRevisions;
  const outcome = engine(model, records, selector);
  if (!outcome.ok) return outcome;
  const chosen = selectRecords(records, selector);
  const removed = removalsFor(chosen, decision);
  const { records: remaining, damaged } = rebaseRemaining(outcome.value.remaining, removed);
  return succeed({
    model: outcome.value.model,
    processed: outcome.value.processed,
    remaining,
    removed,
    damaged,
  });
}

/**
 * 接受选中的修订，并**重定基未处理记录的偏移**（"未处理范围不损坏"）。
 *
 * 与 `acceptRevisions` 的差别只在返回值：当被接受的**删除**从某段中间移除了文字时，同一段里
 * 落在其后的剩余记录的 `range` 会左移相同的码位数，从而**仍指向自己那段文字**；与移除区间
 * 重叠、无法安全重定基的记录**具名**进 `damaged`。模型与 `processed` 与引擎完全一致。
 */
export function acceptRevisionsRebased(
  model: DocumentModel,
  records: readonly RevisionRecord[],
  selector: RevisionSelector,
): Result<RebasingBatchOutcome> {
  return rebasedBatch(model, records, selector, 'accept');
}

/** 拒绝选中的修订，并**重定基未处理记录的偏移**（"未处理范围不损坏"）。 */
export function rejectRevisionsRebased(
  model: DocumentModel,
  records: readonly RevisionRecord[],
  selector: RevisionSelector,
): Result<RebasingBatchOutcome> {
  return rebasedBatch(model, records, selector, 'reject');
}

// ---------------------------------------------------------------------------
// 单一入口：一串判决，每步自动从**重定基后的剩余**里重新选择
// ---------------------------------------------------------------------------

/**
 * 部分批处理里的一步判决：接受（`accept`）或拒绝（`reject`）某组记录，配一个选择器
 * （`ids` / `range` / `all`）。
 */
export interface RevisionDecision {
  readonly decision: 'accept' | 'reject';
  readonly selector: RevisionSelector;
}

/**
 * **默认的部分批处理入口**：按顺序施加一串接受 / 拒绝判决，**每一步都从重定基后的剩余里重新选择**。
 *
 * ## 为什么必须收成单一入口
 *
 * `acceptRevisionsRebased` / `rejectRevisionsRebased` 只保证"这一步之后返回的剩余记录偏移是新的"。
 * 调用方若把**上一步**返回的剩余与**原始**记录混用（或干脆继续用原选择器），陈旧区间仍然可达——
 * W06 用例⑩正是这个反向对照：接受第一条删除后，未处理的第二条其原区间 [5,7) 在新文字上已落到 "EE"。
 * 把"接受一步、再拒绝一步"这种多步部分批处理收成**单一入口**后，每一步的选择都作用在**上一步重定基
 * 后的剩余**上，于是**部分批处理永远不会套用一个陈旧区间**。
 *
 * ## 语义
 *
 * - 每步按 `decision` 由引擎 `acceptRevision` / `rejectRevision` 落地；整批**原子**（任一步失败即整体
 *   失败，不产出半成品模型）；
 * - 与更早步骤的移除**区间重叠**、偏移无法保证仍有效的记录**具名**进 `damaged`（R110）；
 * - 已损坏的记录**不再**能被后续判决选中并套用——命中即 `precondition` 失败（不静默），因为套用它
 *   正是"陈旧区间"本身；其余未被选中的记录原样保留在 `remaining` 里。
 *
 * 注意：`removed` 按步骤顺序累积，每一项的 `range` 是它**发生当步**坐标系下的移除区间
 * （多步之间由 `remaining` 的重定基承担偏移推进）；单步时它与 `acceptRevisionsRebased` 完全一致。
 */
export function applyRevisionDecisions(
  model: DocumentModel,
  records: readonly RevisionRecord[],
  decisions: readonly RevisionDecision[],
): Result<RebasingBatchOutcome> {
  let current = model;
  let remaining: readonly RevisionRecord[] = records;
  const processed: string[] = [];
  const removed: RemovedRange[] = [];
  const damaged: string[] = [];

  for (let index = 0; index < decisions.length; index += 1) {
    const decision = decisions[index]!;
    // 选择发生在**当前剩余**（已按更早步骤的移除重定基）上——这就是"重新选择"。
    const chosen = selectRecords(remaining, decision.selector);
    if (chosen.length === 0) {
      return fail('not_found', `第 ${index + 1} 步判决没有命中任何未处理记录。`, {
        hitCount: 0,
        needsClarification: true,
        extra: { step: index + 1, decision: decision.decision },
      });
    }
    const stale = chosen.filter((record) => damaged.includes(record.id));
    if (stale.length > 0) {
      return fail(
        'precondition',
        `第 ${index + 1} 步判决选中的记录与更早的移除重叠，其偏移已损坏，拒绝套用（避免陈旧区间）。`,
        { extra: { step: index + 1, damaged: stale.map((record) => record.id).join(', ') } },
      );
    }
    const step = rebasedBatch(current, remaining, decision.selector, decision.decision);
    if (!step.ok) return step;
    current = step.value.model;
    remaining = step.value.remaining;
    processed.push(...step.value.processed);
    removed.push(...step.value.removed);
    damaged.push(...step.value.damaged);
  }

  return succeed({ model: current, processed, remaining, removed, damaged });
}

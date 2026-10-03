/**
 * 选区翻译（WF-096 后半句）。
 *
 * ## 判据逐条落地
 *
 * | 判据 | 实现 |
 * |---|---|
 * | **只翻选区** | `TranslationProposal.segments` 的每一项都带一个 `DocumentRange`；`commitTranslation` 只应用这些范围 |
 * | **绑定原 revision** | 提案携带 `base_revision`；提交时与当前 `model.revision` 比对（R142） |
 * | **迟到结果必须拒绝** | 不符即 `stale_revision` + 当前 revision（R143），**不覆盖、不降级** |
 * | **不改范围外内容** | 逐范围替换，其余段落对象**按引用保留**（测试断言范围外文本一字不动） |
 * | **明确翻译来源** | 每个片段带 `TranslationSource`（`model` / `deterministic_stub` + 说明） |
 * | **走模型预算** | 每翻一个范围算 **1 次模型调用**；预算不足**在调用之前**拒绝（不先花掉再报错） |
 *
 * ## 翻译端口：本轮**不接真实模型**
 *
 * `TranslatorPort` 是一个接口，真实模型接入留后续波次（D07）。本包自带的是
 * **确定性执行器**：它的 `source.kind` 恒为 `deterministic_stub`，并在 `detail` 里
 * 写清"这不是真实翻译"。**任何**来源都会原样落到提案里，所以"用桩冒充模型翻译"
 * 在回执上是可见的——这正是"明确翻译来源"的可判定形式。
 *
 * ## 端口抛错怎么办
 *
 * 端口抛出的异常**原样冒泡**：此刻模型一个字节都没改（翻译阶段只读不写），
 * 吞掉异常并把失败码伪造成 `precondition`/`unsupported` 只会掩盖真实原因。
 */

import type { DocumentId, DocumentModel, Revision } from '../model/types.js';
import { replaceRangeInInlines } from '../selection/inline-map.js';
import { requireCurrentSelection } from '../selection/selection.js';
import { collectParagraphs, paragraphText, replaceParagraph } from '../selection/structure.js';
import { fail, succeed, type DocumentRange, type Result, type Selection } from '../selection/types.js';
import { isValidLanguageTag } from './language.js';
import { codePointsToText, readCodePoints } from './symbols.js';

/** 翻译来源（**必须能说清是谁翻的**）。 */
export interface TranslationSource {
  /** `model` = 真实模型；`deterministic_stub` = 确定性桩（**不是**真实翻译）。 */
  readonly kind: 'model' | 'deterministic_stub';
  readonly detail: string;
}

/** 翻译端口（真实模型接入由后续波次实现，见 D07）。 */
export interface TranslatorPort {
  readonly source: TranslationSource;
  translate(input: {
    readonly text: string;
    readonly target_language: string;
    readonly source_language: string | null;
  }): string;
}

/** 模型预算：本次操作允许花掉的模型调用次数上限。 */
export interface TranslationBudget {
  readonly max_model_calls: number;
}

/** 一个被翻译的片段（**范围 + 原文 + 译文 + 来源**，四项缺一不可）。 */
export interface TranslationSegment {
  readonly range: DocumentRange;
  readonly source_text: string;
  readonly translated_text: string;
  readonly source: TranslationSource;
}

/** 翻译提案（**只读建议**：在 `commitTranslation` 之前，文档没有任何改动）。 */
export interface TranslationProposal {
  readonly document_id: DocumentId;
  readonly base_revision: Revision;
  readonly target_language: string;
  readonly source_language: string | null;
  readonly segments: readonly TranslationSegment[];
  /** 实际消耗的模型调用次数（每个范围 1 次）。 */
  readonly model_calls: number;
  readonly budget: TranslationBudget;
}

export interface TranslateSelectionOptions {
  readonly target_language: string;
  readonly translator: TranslatorPort;
  readonly budget: TranslationBudget;
  readonly source_language?: string | null;
}

function rangesOverlap(left: DocumentRange, right: DocumentRange): boolean {
  return left.node_id === right.node_id && left.start < right.end && right.start < left.end;
}

/** 计划中的一个范围：绑定好的范围 + 从**文档实读**的原文（不来自端口）。 */
export interface PlannedTranslationRange {
  readonly range: DocumentRange;
  readonly source_text: string;
}

/**
 * 翻译**计划**：全部校验通过后，每个范围对应的原文。
 *
 * 抽出它，是为了让"同步桩路径"（`translateSelection`）与"K02 模型路径"
 * （`model-port.ts` 的 `translateSelectionWithModel`）**共用同一套拒绝顺序与消息**，
 * 不产生第二份会漂移的校验实现。
 */
export interface TranslationPlan {
  readonly document_id: DocumentId;
  readonly base_revision: Revision;
  readonly target_language: string;
  readonly source_language: string | null;
  readonly items: readonly PlannedTranslationRange[];
}

export interface TranslationPlanOptions {
  readonly target_language: string;
  readonly max_model_calls: number;
  readonly source_language?: string | null;
}

/**
 * 校验一次选区翻译并产出计划（**只读，不改文档，不调用任何端口**）。
 *
 * 拒绝顺序（**先花冤枉钱的检查优先**）：目标语言 → 预算形状 → 选区有效性 → 空选区
 * → 预算够不够 → 重叠范围 → 逐范围内容。预算不足时调用方**一次都不该调用端口**。
 */
export function planTranslationRanges(
  model: DocumentModel,
  selection: Selection,
  options: TranslationPlanOptions,
): Result<TranslationPlan> {
  if (!isValidLanguageTag(options.target_language)) {
    return fail('invalid_query', `目标语言不是合法的 BCP-47 标签：${String(options.target_language)}`, {
      extra: { targetLanguage: String(options.target_language) },
    });
  }
  const maxCalls = options.max_model_calls;
  if (!Number.isInteger(maxCalls) || maxCalls < 0) {
    return fail('invalid_query', `模型预算必须是 ≥0 的整数，收到 ${String(maxCalls)}`, {
      extra: { maxModelCalls: String(maxCalls) },
    });
  }

  const current = requireCurrentSelection(selection, model);
  if (!current.ok) return current;
  if (selection.ranges.length === 0) {
    return fail('empty_range', '选区没有任何范围，无法翻译。', { extra: { ranges: 0 } });
  }

  // 预算：每个范围 1 次模型调用。**先判断再调用**——不足时不花任何预算。
  if (selection.ranges.length > maxCalls) {
    return fail(
      'precondition',
      `本次翻译需要 ${String(selection.ranges.length)} 次模型调用，预算上限为 ${String(maxCalls)}；` +
        '预算不足时不发起任何调用（模型调用必须走预算）。',
      { extra: { requiredModelCalls: selection.ranges.length, maxModelCalls: maxCalls } },
    );
  }

  for (const [index, range] of selection.ranges.entries()) {
    for (const other of selection.ranges.slice(index + 1)) {
      if (rangesOverlap(range, other)) {
        return fail(
          'precondition',
          `选区内存在重叠范围（${range.node_id} @${String(range.start)}-${String(range.end)} 与 @${String(other.start)}-${String(other.end)}）：重叠会让同一段文字被翻两次。`,
          { extra: { node_id: range.node_id } },
        );
      }
    }
  }

  const items: PlannedTranslationRange[] = [];
  for (const range of selection.ranges) {
    const paragraph = collectParagraphs(model.blocks).find((item) => item.id === range.node_id);
    if (paragraph === undefined) {
      return fail('unknown_node', `文档中不存在 id 为 "${range.node_id}" 的段落。`, { extra: { node_id: range.node_id } });
    }
    const points = readCodePoints(paragraphText(paragraph));
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.start < 0 ||
      range.end < range.start ||
      range.end > points.length
    ) {
      return fail(
        'invalid_range',
        `范围 [${String(range.start)}, ${String(range.end)}) 超出段落 "${range.node_id}" 的码位长度 ${String(points.length)}。`,
        { extra: { node_id: range.node_id, start: range.start, end: range.end, total: points.length } },
      );
    }
    items.push({
      range: { node_id: range.node_id, start: range.start, end: range.end },
      source_text: codePointsToText(points.slice(range.start, range.end)),
    });
  }

  return succeed({
    document_id: model.document_id,
    base_revision: model.revision,
    target_language: options.target_language,
    source_language: options.source_language ?? null,
    items,
  });
}

/**
 * 翻译选区，产出**提案**（不改文档）。
 *
 * 拒绝顺序与消息全部来自 `planTranslationRanges`（**唯一**的校验实现）。
 * 预算不足时**端口一次都不会被调用**。
 */
export function translateSelection(
  model: DocumentModel,
  selection: Selection,
  options: TranslateSelectionOptions,
): Result<TranslationProposal> {
  const plan = planTranslationRanges(model, selection, {
    target_language: options.target_language,
    max_model_calls: options.budget.max_model_calls,
    source_language: options.source_language ?? null,
  });
  if (!plan.ok) return plan;

  const segments: TranslationSegment[] = [];
  for (const item of plan.value.items) {
    const translated = options.translator.translate({
      text: item.source_text,
      target_language: plan.value.target_language,
      source_language: plan.value.source_language,
    });
    segments.push({
      range: item.range,
      source_text: item.source_text,
      translated_text: translated,
      source: options.translator.source,
    });
  }

  return succeed({
    document_id: plan.value.document_id,
    base_revision: plan.value.base_revision,
    target_language: plan.value.target_language,
    source_language: plan.value.source_language,
    segments,
    model_calls: plan.value.items.length,
    budget: options.budget,
  });
}

/**
 * 提交翻译提案（**唯一**会改文档的一步）。
 *
 * - 提案的 `base_revision` 必须等于当前 `model.revision`，否则 `stale_revision`（R142/R143）；
 * - 逐片段替换，替换前核对"该处原文仍是提案记录的原文"（防按旧坐标改新文本）；
 * - 范围含软换行/域 ⇒ `unsupported`（不破坏结构）；
 * - 成功一次 ⇒ revision **+1**（一次操作 = 一次事务，R138）。
 */
export function commitTranslation(model: DocumentModel, proposal: TranslationProposal): Result<DocumentModel> {
  if (proposal.document_id !== model.document_id) {
    return fail(
      'mismatched_document',
      `提案属于文档 "${proposal.document_id}"，当前文档是 "${model.document_id}"。`,
      { extra: { proposalDocument: proposal.document_id, modelDocument: model.document_id } },
    );
  }
  if (proposal.base_revision !== model.revision) {
    return fail(
      'stale_revision',
      `翻译结果基于 revision ${String(proposal.base_revision)}，当前已是 ${String(model.revision)}；` +
        '文档在翻译期间被改过，迟到的翻译结果必须拒绝（不得把旧译文盖到新文本上）。',
      { currentRevision: model.revision, requestedRevision: proposal.base_revision },
    );
  }
  if (proposal.segments.length === 0) {
    return fail('empty_range', '翻译提案里没有任何片段。', { extra: { segments: 0 } });
  }

  // **同一段落内的片段按起点从右往左应用**：译文长度通常与原文不同，先改左边会让右边
  // 的偏移整体平移，"按旧坐标改新文本"就会改错位置。从右往左时，尚未应用的范围都在
  // 已改位置的左边，偏移天然保持有效。不同段落互不影响，这里用一个确定的次序遍历。
  const ordered = [...proposal.segments].sort((left, right) => {
    if (left.range.node_id === right.range.node_id) return right.range.start - left.range.start;
    return left.range.node_id.localeCompare(right.range.node_id);
  });

  let next = model;
  for (const segment of ordered) {
    const paragraph = collectParagraphs(next.blocks).find((item) => item.id === segment.range.node_id);
    if (paragraph === undefined) {
      return fail('unknown_node', `文档中不存在 id 为 "${segment.range.node_id}" 的段落。`, {
        extra: { node_id: segment.range.node_id },
      });
    }
    const actual = codePointsToText(
      readCodePoints(paragraphText(paragraph)).slice(segment.range.start, segment.range.end),
    );
    if (actual !== segment.source_text) {
      return fail(
        'precondition',
        `范围（${segment.range.node_id} @${String(segment.range.start)}-${String(segment.range.end)}）的原文已变：` +
          `提案记录为 "${segment.source_text}"，实际为 "${actual}"。`,
        { extra: { expected: segment.source_text, actual } },
      );
    }

    const replaced = replaceRangeInInlines(paragraph.inlines, segment.range.start, segment.range.end, segment.translated_text);
    if (!replaced.ok) return replaced;

    const updated = replaceParagraph(next, paragraph.id, { ...paragraph, inlines: replaced.value });
    if (!updated.ok) return updated;
    next = updated.value;
  }

  return succeed({ ...next, revision: model.revision + 1 });
}

/**
 * 翻译提案的可读摘要：**来源必须出现在回执里**，让"只翻选区""花了多少次调用""谁翻的"
 * 三件事都能被核对。
 */
export function describeTranslation(proposal: TranslationProposal): string {
  const kinds = [...new Set(proposal.segments.map((segment) => segment.source.kind))];
  const sources = [...new Set(proposal.segments.map((segment) => segment.source.detail))];
  return (
    `翻译 ${proposal.source_language ?? '未指定'} → ${proposal.target_language}：` +
    `${String(proposal.segments.length)} 个片段，模型调用 ${String(proposal.model_calls)}/${String(proposal.budget.max_model_calls)}，` +
    `来源 ${kinds.join('/')}（${sources.join('；')}），基于 revision ${String(proposal.base_revision)}`
  );
}

/**
 * 文本语言设置（WF-096 前半句："设置校对语言"）。
 *
 * ## 诚实的前提：这是一条**声明**，不是一次已经落盘的格式修改
 *
 * 模型冻结骨架的 `RunProperties` 里**没有** `w:lang` 字段（它属于"校对语言"，
 * 与字体/字号那组属性不是一类）。因此本包不去偷偷往 `RunNode.opaque` 里塞一段 XML
 * 冒充"已经设置好了"——那正是 R151/R166 反对的"看起来做了"。
 *
 * 本文件产出的是**一条规范化的语言设置声明**：它绑定
 * `documentId + baseRevision + 范围`（R103 的三要素），可以被导出器消费成 `w:lang`。
 * 导出器接线之前，这条能力的状态是"模型层已完成、**未接线**"（登记在交付说明里）。
 *
 * ## 为什么校验 BCP-47 的形状
 *
 * `"中文"` / `"zh CN"` / `"zh_CN"` 都不是合法的 BCP-47 标签。若照单全收，
 * 它们会一路走到导出器再变成写不进文件的字节。此处按 R140 的取向**操作前拒绝**。
 */

import type { DocumentId, DocumentModel, Revision } from '../model/types.js';
import { requireCurrentSelection } from '../selection/selection.js';
import { fail, succeed, type DocumentRange, type Result, type Selection } from '../selection/types.js';

/** BCP-47 的**形状**校验（`zh` / `zh-CN` / `en-US` / `sr-Latn-RS`）：语言-脚本-地区，2–8 字符段。 */
const BCP47 = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * 语言设置声明。
 *
 * `apply_to_selection_only` 恒为 `true`：本入口**只**处理选区。要设置全文语言，
 * 调用方须显式地把"全文"做成选区再调——这样"改了整篇语言"永远是一个**显式**动作。
 */
export interface ProofingLanguageSetting {
  readonly document_id: DocumentId;
  readonly base_revision: Revision;
  readonly ranges: readonly DocumentRange[];
  readonly language_tag: string;
  readonly apply_to_selection_only: true;
  /** 声明尚未接线到导出的说明（**如实标出**，不冒充已完成）。 */
  readonly wiring: 'declared_not_exported';
}

/** 语言标签是否合法（形状级）。 */
export function isValidLanguageTag(tag: unknown): tag is string {
  return typeof tag === 'string' && BCP47.test(tag);
}

/**
 * 为选区声明校对语言。
 *
 * 选区过期 / 文档不符即拒绝（R114/R143）；标签非法即 `invalid_query`；空选区即 `empty_range`。
 */
export function setProofingLanguage(
  model: DocumentModel,
  selection: Selection,
  languageTag: string,
): Result<ProofingLanguageSetting> {
  if (!isValidLanguageTag(languageTag)) {
    return fail('invalid_query', `不是合法的 BCP-47 语言标签：${String(languageTag)}（如 "zh-CN"、"en-US"）`, {
      extra: { languageTag: String(languageTag) },
    });
  }
  const current = requireCurrentSelection(selection, model);
  if (!current.ok) return current;
  if (selection.ranges.length === 0) {
    return fail('empty_range', '选区没有任何范围，无法设置语言。', { extra: { ranges: 0 } });
  }
  return succeed({
    document_id: model.document_id,
    base_revision: model.revision,
    ranges: [...selection.ranges],
    language_tag: languageTag,
    apply_to_selection_only: true,
    wiring: 'declared_not_exported',
  });
}

/** 声明的可读描述。 */
export function describeLanguageSetting(setting: ProofingLanguageSetting): string {
  return (
    `校对语言 ${setting.language_tag}：${String(setting.ranges.length)} 个范围，` +
    `基于 revision ${String(setting.base_revision)}（${setting.wiring === 'declared_not_exported' ? '尚未接线到导出器' : '已接线'}）`
  );
}

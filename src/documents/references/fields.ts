/**
 * 常用域（WF-076；合同 R150/R158）。
 *
 * ## 三样东西必须分开（这是本模块存在的理由）
 *
 * 一个 Word 域在 OOXML 里有三份**不同**的信息：
 * 1. **域指令** `instruction`（`PAGE` / `NUMPAGES` / `DATE \@ "yyyy-MM-dd"`）——"要算什么"；
 * 2. **缓存值** `cached_result`——上次刷新时**写死在文件里的显示文字**，可能已经是旧的；
 * 3. **刷新状态** `refresh_state`——它到底是"没算过/不知道"(unknown)、"过期"(stale) 还是"已刷新"(refreshed)。
 *
 * 把这三样压成一个 `string` 是最常见的坑：于是"写入了 PAGE 指令"被当成"页码已经算好了"。
 * R158 明令禁止这种冒充。本模块的每个写入口都遵守：
 * **改指令 ⇒ 缓存作废（清成 stale 或 unknown），绝不顺手置 `refreshed`。**
 *
 * ## 什么时候才算 `refreshed`
 *
 * 只有 `setFieldCache(field, value, evidence)` 显式带"有证据"标记才置 `refreshed`。
 * 这个 `evidence` 由调用方在**真的让排版引擎/消费端刷新过**之后传入；本层不制造它。
 */

import type { DocumentModel, FieldNode, ParagraphNode, SourceKind } from '../model/types.js';
import { splitInlinesAtRange } from '../selection/inline-map.js';
import { requireParagraph, replaceParagraph } from '../selection/structure.js';
import { fail, succeed, type Result } from '../selection/types.js';

function makeField(
  id: string,
  instruction: string,
  cached: string | null,
  refresh: FieldNode['refresh_state'],
  source: SourceKind,
): FieldNode {
  return {
    kind: 'field',
    id,
    source,
    opaque: [],
    instruction,
    cached_result: cached,
    refresh_state: refresh,
  };
}

/** 页码域（`PAGE`）。缓存值默认 `null`、状态 `unknown`——**没有算过就不假称算过**。 */
export function pageNumberField(id: string, source: SourceKind = 'user_request'): FieldNode {
  return makeField(id, 'PAGE', null, 'unknown', source);
}

/** 总页数域（`NUMPAGES`）。 */
export function numPagesField(id: string, source: SourceKind = 'user_request'): FieldNode {
  return makeField(id, 'NUMPAGES', null, 'unknown', source);
}

/** 日期域（`DATE`）。`pattern` 是 OOXML 日期格式（如 `yyyy-MM-dd`）。 */
export function dateField(id: string, pattern: string, source: SourceKind = 'user_request'): FieldNode {
  return makeField(id, `DATE \\@ "${pattern}"`, null, 'unknown', source);
}

/**
 * 改域指令：**缓存作废**。
 *
 * 指令变了，旧缓存对应的就是另一个量——必须清成 `stale`（有旧缓存）或 `unknown`（本来就没缓存）。
 * 绝不置 `refreshed`（R158）。
 */
export function setFieldInstruction(field: FieldNode, instruction: string): FieldNode {
  const trimmed = instruction.trim();
  if (trimmed.length === 0) {
    throw new RangeError('域指令不能为空（空域就是坏域）。');
  }
  return {
    ...field,
    instruction: trimmed,
    refresh_state: field.cached_result === null ? 'unknown' : 'stale',
  };
}

/**
 * 写缓存值。
 *
 * `hasEvidence` 表示"这次缓存来自真实刷新（排版引擎/消费端算过）"。
 * 无证据时只写值、状态置 `unknown`——**值可以暂存，状态不许冒充已刷新**（R158）。
 */
export function setFieldCache(field: FieldNode, value: string, hasEvidence: boolean): FieldNode {
  return {
    ...field,
    cached_result: value,
    refresh_state: hasEvidence ? 'refreshed' : 'unknown',
  };
}

/** 域是否需要刷新。 */
export function fieldIsStale(field: FieldNode): boolean {
  return field.refresh_state !== 'refreshed';
}

/** 读域的三要素（**分开返回**，调用方不会误把缓存当指令或反过来）。 */
export function describeField(field: FieldNode): {
  readonly instruction: string;
  readonly cached_result: string | null;
  readonly refresh_state: FieldNode['refresh_state'];
  readonly display: string;
} {
  return {
    instruction: field.instruction,
    cached_result: field.cached_result,
    refresh_state: field.refresh_state,
    display: field.cached_result ?? '',
  };
}

/**
 * 把域插入段落某偏移处。
 *
 * 边界落在**已有域内部**时 `splitInlinesAtRange` 会返回 `unsupported`（不能把一个域切一半），
 * 此处原样透传，**不静默夹紧**。
 */
export function insertFieldIntoParagraph(
  model: DocumentModel,
  nodeId: string,
  offset: number,
  field: FieldNode,
): Result<DocumentModel> {
  const paragraph = requireParagraph(model, nodeId);
  if (!paragraph.ok) return paragraph;
  const split = splitInlinesAtRange(paragraph.value.inlines, offset, offset);
  if (!split.ok) return split;
  const parts = split.value;
  const next: ParagraphNode = {
    ...paragraph.value,
    inlines: [...parts.before, field, ...parts.after],
  };
  return replaceParagraph(model, nodeId, next);
}

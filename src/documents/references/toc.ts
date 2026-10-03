/**
 * 目录（WF-074；合同 R115/R158）。
 *
 * ## R158：只生成**结构**，不编造页码
 *
 * 目录的层级与条目来自标题结构（样式/大纲级别判定，R115——**不**按"字体大"猜），
 * 这是模型能确定的。而**页码取决于真实排版**：分页在哪、页边距多少、字体替代后行高怎么变。
 * 因此：
 * - `buildToc` 产出的条目**没有页码**（`TocEntry` 里就没有这个字段）；
 * - `tocCache` 的 `refresh_state` 默认 `'unknown'`、`page_numbers` 为空表；
 * - 想拿到页码，**只能**调 `applyPageNumbers` 并交出一份 `LayoutEvidence`（真实排版引擎 + 时间 + 页码表）；
 *   没有证据一律 `precondition` 拒绝。**本模块不存在"猜一个页码"的入口**。
 *
 * ## 层级从哪来
 *
 * 优先级：显式大纲级别（`outlineLevel`）→ 标题样式名（`Heading N` / `标题 N`）。
 * 与选区包的 `isHeadingParagraph` 共用同一判据，避免"能识别是标题但算不出层级"的分叉。
 */

import type { DocumentModel, NodeId, ParagraphNode, StyleTable } from '../model/types.js';
import { collectParagraphs, paragraphText } from '../selection/structure.js';
import { isHeadingParagraph } from '../selection/resolve.js';
import { fail, succeed, type Result } from '../selection/types.js';
import type { LayoutEvidence, TocCache, TocEntry } from './types.js';

const HEADING_STYLE = /^(?:Heading\s*([1-9])|标题\s*([1-9]))/i;

/** 段落的标题层级（1 起）；不是标题返回 `null`。 */
export function headingLevelOf(paragraph: ParagraphNode, styles: StyleTable): number | null {
  const outline = paragraph.properties.outlineLevel;
  if (outline.state === 'set' && outline.value !== null) {
    return outline.value + 1;
  }
  const styleRef = paragraph.style_ref;
  if (styleRef === null) return null;
  const seen = new Set<string>();
  let current: string | null = styleRef;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const definition = styles.styles.find((style) => style.style_id === current);
    if (definition === undefined) break;
    const matched = HEADING_STYLE.exec(definition.name);
    if (matched !== null) {
      const digits = matched[1] ?? matched[2];
      if (digits !== undefined) return Number(digits);
    }
    current = definition.based_on;
  }
  return null;
}

interface DraftEntry {
  readonly level: number;
  readonly text: string;
  readonly node_id: string;
  readonly paragraph_index: number;
}

function nest(drafts: readonly DraftEntry[]): readonly TocEntry[] {
  const roots: TocEntry[] = [];
  const stack: { level: number; entry: TocEntry }[] = [];
  for (const draft of drafts) {
    const children: TocEntry[] = [];
    const entry: TocEntry = {
      level: draft.level,
      text: draft.text,
      node_id: draft.node_id,
      paragraph_index: draft.paragraph_index,
      children,
    };
    while (stack.length > 0 && (stack[stack.length - 1] as { level: number }).level >= entry.level) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      roots.push(entry);
    } else {
      (parent.entry.children as TocEntry[]).push(entry);
    }
    stack.push({ level: entry.level, entry });
  }
  return roots;
}

/**
 * 按标题层级生成目录**结构**。没有可识别标题 ⇒ `not_found`（R112）。
 * 条目**不含页码**（R158）——要页码请走 `applyPageNumbers` + 排版证据。
 */
export function buildToc(model: DocumentModel): Result<readonly TocEntry[]> {
  const drafts: DraftEntry[] = [];
  const paragraphs = collectParagraphs(model.blocks);
  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index] as ParagraphNode;
    if (!isHeadingParagraph(paragraph, model.styles)) continue;
    const level = headingLevelOf(paragraph, model.styles) ?? 1;
    drafts.push({
      level,
      text: paragraphText(paragraph),
      node_id: paragraph.id,
      paragraph_index: index + 1,
    });
  }
  if (drafts.length === 0) {
    return fail('not_found', '文档里没有可识别的标题（无大纲级别、也无标题样式），无法生成目录。', {
      hitCount: 0,
      needsClarification: true,
    });
  }
  return succeed(nest(drafts));
}

/** 由条目生成目录缓存：**默认未刷新**、无页码（R158）。 */
export function tocCache(entries: readonly TocEntry[]): TocCache {
  return { entries, page_numbers: {}, refresh_state: 'unknown', evidence: null };
}

/**
 * 条目集合是否与缓存一致（决定重建后旧页码还能不能用）。
 * 用 `node_id` 序列比较，而不是整表深比较——页码只挂在标题身份上。
 */
function sameEntryIdentity(a: readonly TocEntry[], b: readonly TocEntry[]): boolean {
  const flatA: string[] = [];
  const flatB: string[] = [];
  const walk = (entries: readonly TocEntry[], out: string[]): void => {
    for (const entry of entries) {
      out.push(entry.node_id);
      walk(entry.children, out);
    }
  };
  walk(a, flatA);
  walk(b, flatB);
  return flatA.length === flatB.length && flatA.every((id, index) => id === flatB[index]);
}

/**
 * 更新目录：重算条目结构。
 *
 * - 标题身份集合**没变** ⇒ 保留已有页码与刷新状态（排版没道理因此失效）；
 * - 变了 ⇒ 旧页码**丢掉**、状态回 `'unknown'`（必须重新排版测量，**不续用旧数字**）。
 */
export function updateToc(model: DocumentModel, previous: TocCache): Result<TocCache> {
  const entries = buildToc(model);
  if (!entries.ok) return entries;
  if (sameEntryIdentity(entries.value, previous.entries)) {
    return succeed({ ...previous, entries: entries.value });
  }
  return succeed({ entries: entries.value, page_numbers: {}, refresh_state: 'unknown', evidence: null });
}

/**
 * 用**真实排版证据**填页码（R158）。
 *
 * `evidence === null`（或页码表为空且文档有标题）⇒ `precondition` 拒绝：
 * 写域指令 ≠ 已算出页码；没有排版证据就不给页码。
 *
 * ## 缓存只携带**它自己的条目**（与 `resolveTocPages` 的收敛口径一致）
 *
 * `evidence.page_of` 通常覆盖**整篇**（每个正文段都有页），而目录只拥有若干标题。
 * 若把它原样存进 `TocCache.page_numbers`，缓存里就会出现一堆**不属于它**的键，
 * 于是直接调本函数与走 `resolveTocPages`（后者先把表收拢到条目再委派）会得到**不同的表**。
 * 这里按构造把表收拢到 `cache.entries` 的 `node_id` 集合上：条目缺席就不写（**不编造**），
 * 非条目键一律不落。两条路径因此**由构造一致**，`resolveTocPages` 的前置校验（缺条目即拒）
 * 仍在它自己那边执行。
 */
export function applyPageNumbers(cache: TocCache, evidence: LayoutEvidence | null): Result<TocCache> {
  if (evidence === null) {
    return fail('precondition', '缺少排版证据：页码必须来自真实排版引擎的测量结果，不能凭空生成（R158）。', {
      extra: { entries: String(countEntries(cache.entries)) },
    });
  }
  if (evidence.engine.trim().length === 0 || evidence.measured_at.trim().length === 0) {
    return fail('precondition', '排版证据不完整：必须标明引擎与测量时间（R158/R167）。', {
      extra: { engine: evidence.engine, measuredAt: evidence.measured_at },
    });
  }
  // 只保留缓存**自己**拥有的条目：evidence 覆盖整篇，多余的键不属于目录。
  const scoped: Record<NodeId, number> = {};
  for (const id of entryNodeIds(cache.entries)) {
    const page = evidence.page_of[id];
    if (page !== undefined) scoped[id] = page;
  }
  return succeed({
    entries: cache.entries,
    page_numbers: scoped,
    refresh_state: 'refreshed',
    evidence: { ...evidence, page_of: scoped },
  });
}

/** 展平取出条目自身拥有的 `node_id`（按文档顺序），供页码收敛使用。 */
function entryNodeIds(entries: readonly TocEntry[]): readonly NodeId[] {
  const out: NodeId[] = [];
  const walk = (list: readonly TocEntry[]): void => {
    for (const entry of list) {
      out.push(entry.node_id);
      walk(entry.children);
    }
  };
  walk(entries);
  return out;
}

function countEntries(entries: readonly TocEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    count += 1 + countEntries(entry.children);
  }
  return count;
}

/** 展平目录条目（读取/核对用）。 */
export function flattenToc(entries: readonly TocEntry[]): readonly TocEntry[] {
  const out: TocEntry[] = [];
  const walk = (list: readonly TocEntry[]): void => {
    for (const entry of list) {
      out.push(entry);
      walk(entry.children);
    }
  };
  walk(entries);
  return out;
}

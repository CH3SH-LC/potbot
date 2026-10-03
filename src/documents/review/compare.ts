/**
 * 版本比较（WF-080）。
 *
 * ## 为什么**不能只比整文件 hash**
 *
 * hash 只能回答"变没变"，回答不了"**哪一段的哪几个字**变了"。用户要的是后者。
 * 因此这里按**稳定节点 id** 对齐两份文档的段落，逐段做：
 * - **文字**：用公共前缀/后缀求出"变化段"（`start`/`end` + 前后子串）——定位到字；
 * - **格式**：**单独一类**，落到"第几个 run 的哪个属性从什么变成什么"。
 *
 * 于是"把某段第三个字加粗"和"把某段的字改了"是两种**可区分**的结果，而不是同一条"变了"。
 *
 * ## 对齐口径
 *
 * 段落按**稳定 id** 对齐（R101）——同 id 即同一段，与它挪到第几位无关。
 * 输出顺序：先按**后一份文档**的段落序（修改/新增），再补**只在旧文档里**的段落（删除）。
 * 这是确定性的，便于对照。
 *
 * ## 已知边界
 *
 * run 级格式比较按**run 下标**对齐；若文字变化改变了 run 切分，run 下标的意义会偏移，
 * 此时仍会报格式差异（可能含由切分造成的噪声）。这是刻意如实登记的限制，不是隐藏行为。
 */

import type {
  DocumentModel,
  ParagraphNode,
  ParagraphProperties,
  RunNode,
  RunProperties,
} from '../model/types.js';
import { collectParagraphs, paragraphText } from '../selection/structure.js';
import type {
  DocumentComparison,
  FormatDiff,
  ParagraphDiff,
  ParagraphTextDiff,
} from './types.js';

const RUN_PROPERTIES: readonly (keyof RunProperties)[] = [
  'bold',
  'italic',
  'underline',
  'strike',
  'doubleStrike',
  'size',
  'scale',
  'position',
  'color',
  'highlight',
  'fonts',
  'spacing',
  'caps',
  'smallCaps',
];

const PARAGRAPH_PROPERTIES: readonly (keyof ParagraphProperties)[] = [
  'alignment',
  'lineSpacing',
  'spacingBefore',
  'spacingAfter',
  'outlineLevel',
];

function serialize(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function changed(before: unknown, after: unknown): boolean {
  return serialize(before) !== serialize(after);
}

/** 求"变化段"：`[start, end)` 是**变更前**文本里的变化区间，`after` 是替换后的文字。 */
export function textDiff(before: string, after: string): ParagraphTextDiff | null {
  if (before === after) return null;
  const a = Array.from(before);
  const b = Array.from(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let tail = 0;
  while (tail < a.length - start && tail < b.length - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail += 1;
  }
  const end = a.length - tail;
  return {
    start,
    end,
    before: a.slice(start, end).join(''),
    after: b.slice(start, b.length - tail).join(''),
  };
}

function isRun(inline: ParagraphNode['inlines'][number]): inline is RunNode {
  return inline.kind === 'run';
}

function paragraphFormatDiffs(before: ParagraphNode, after: ParagraphNode): readonly FormatDiff[] {
  const diffs: FormatDiff[] = [];
  for (const property of PARAGRAPH_PROPERTIES) {
    if (changed(before.properties[property], after.properties[property])) {
      diffs.push({
        scope: 'paragraph',
        run_index: null,
        property,
        before: before.properties[property],
        after: after.properties[property],
      });
    }
  }
  if (changed(before.style_ref, after.style_ref)) {
    diffs.push({ scope: 'paragraph', run_index: null, property: 'style_ref', before: before.style_ref, after: after.style_ref });
  }
  return diffs;
}

function runFormatDiffs(before: ParagraphNode, after: ParagraphNode): readonly FormatDiff[] {
  const beforeRuns = before.inlines.filter(isRun);
  const afterRuns = after.inlines.filter(isRun);
  const diffs: FormatDiff[] = [];
  const count = Math.max(beforeRuns.length, afterRuns.length);
  for (let index = 0; index < count; index += 1) {
    const left = beforeRuns[index];
    const right = afterRuns[index];
    if (left === undefined || right === undefined) {
      diffs.push({
        scope: 'run',
        run_index: index,
        property: 'run_count',
        before: beforeRuns.length,
        after: afterRuns.length,
      });
      break;
    }
    for (const property of RUN_PROPERTIES) {
      if (changed(left.properties[property], right.properties[property])) {
        diffs.push({
          scope: 'run',
          run_index: index,
          property,
          before: left.properties[property],
          after: right.properties[property],
        });
      }
    }
  }
  return diffs;
}

function diffOne(before: ParagraphNode, after: ParagraphNode): ParagraphDiff {
  const beforeText = paragraphText(before);
  const afterText = paragraphText(after);
  const text = textDiff(beforeText, afterText);
  const formatChanges = [...paragraphFormatDiffs(before, after), ...runFormatDiffs(before, after)];
  const kind = text === null && formatChanges.length === 0 ? 'unchanged' : 'modified';
  return {
    node_id: after.id,
    kind,
    before_text: beforeText,
    after_text: afterText,
    text_diff: text,
    format_changes: formatChanges,
  };
}

/** 比较两份文档：文字变化与格式变化**分别**列出并定位。 */
export function compareDocuments(before: DocumentModel, after: DocumentModel): DocumentComparison {
  const beforeParagraphs = collectParagraphs(before.blocks);
  const afterParagraphs = collectParagraphs(after.blocks);
  const beforeById = new Map(beforeParagraphs.map((paragraph) => [paragraph.id, paragraph]));
  const afterById = new Map(afterParagraphs.map((paragraph) => [paragraph.id, paragraph]));

  const paragraphs: ParagraphDiff[] = [];
  for (const paragraph of afterParagraphs) {
    const original = beforeById.get(paragraph.id);
    if (original === undefined) {
      paragraphs.push({
        node_id: paragraph.id,
        kind: 'inserted',
        before_text: '',
        after_text: paragraphText(paragraph),
        text_diff: null,
        format_changes: [],
      });
      continue;
    }
    paragraphs.push(diffOne(original, paragraph));
  }
  for (const paragraph of beforeParagraphs) {
    if (!afterById.has(paragraph.id)) {
      paragraphs.push({
        node_id: paragraph.id,
        kind: 'removed',
        before_text: paragraphText(paragraph),
        after_text: '',
        text_diff: null,
        format_changes: [],
      });
    }
  }

  let unchanged = 0;
  let modified = 0;
  let inserted = 0;
  let removed = 0;
  let textChanges = 0;
  let formatChanges = 0;
  for (const paragraph of paragraphs) {
    switch (paragraph.kind) {
      case 'unchanged':
        unchanged += 1;
        break;
      case 'modified':
        modified += 1;
        break;
      case 'inserted':
        inserted += 1;
        break;
      case 'removed':
        removed += 1;
        break;
    }
    if (paragraph.text_diff !== null) textChanges += 1;
    formatChanges += paragraph.format_changes.length;
  }

  return {
    document_id: after.document_id,
    paragraphs,
    summary: { unchanged, modified, inserted, removed, text_changes: textChanges, format_changes: formatChanges },
  };
}

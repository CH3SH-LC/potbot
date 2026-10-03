/**
 * 列表的**读**侧：把段落上的结构性引用算成"这一段显示成几"（WF-040/042）。
 *
 * ## 为什么要"读"这一侧（R150 的推论）
 *
 * 因为段落里**没有** `1.` 这两个字符（WF-039：不伪造前缀），所以"文档上看到 1. 2. 3."
 * 这个事实**只存在于编号表 + 遍历顺序里**。于是：
 *
 * - "删除中间项后编号续接正确"只能靠**重新走一遍**来验证，不能靠读文本；
 * - "重启一个列表不影响另一个列表"也只能靠比较两份计数来验证。
 *
 * 本文件提供这个"走一遍"，它是上面两条判据的**唯一判据来源**——测试不写第二套算法，
 * 否则"实现对了但测试算了另一套"会互相掩护。
 *
 * ## 计数规则（与 OOXML/Word 一致）
 *
 * - 每个 `numId` 一份**独立**的 9 槽计数器（这正是"隔离"在数据上的样子）；
 * - 某级首次出现 ⇒ 取该级**有效起始值**（实例 `lvlOverride` 优先，否则抽象 `w:start`）；
 * - 再次出现 ⇒ 计数 +1；
 * - 出现第 n 级 ⇒ **比它深的级（n+1…8）归零**（子级重新开始，即 `1.` → `1.1` 后
 *   下一个 `2.` 的子级从 `2.1` 而不是 `2.2`）。
 */

import type { FontSet, NodeId, ParagraphNode } from '../model/types.js';
import { renderListText } from './format.js';
import { effectiveLevelDefinition, effectiveStart, findInstance } from './table.js';
import type { NumberingProblemCode } from './table.js';
import {
  MAX_LIST_LEVEL,
  type ListLevelDefinition,
  type ListReference,
  type NumberingPartShape,
  type NumberingTable,
} from './types.js';

/** 一段的列表标签（算出来的序号文本与它用到的那一级计数）。 */
export interface ListLabel {
  readonly paragraph_id: NodeId;
  readonly reference: ListReference;
  readonly level_definition: ListLevelDefinition;
  /** 引用该段显示时各槽位的计数（下标 = 级别）。已拷贝，调用方改它不影响内部状态。 */
  readonly counters: readonly number[];
  /** 显示文本，如 `'1.'` / `'a)'` / `'•'`。 */
  readonly text: string;
}

/** 某段算不出标签的原因（坏引用 / 级未定义）。 */
export interface ListLabelFailure {
  readonly paragraph_id: NodeId;
  readonly reference: ListReference;
  readonly code: NumberingProblemCode;
  readonly detail: string;
}

export interface ListLabelResult {
  /** 按**文档顺序**排列、只含"在列表里且算得出"的段落。 */
  readonly labels: readonly ListLabel[];
  readonly failures: readonly ListLabelFailure[];
}

function emptyCounters(): number[] {
  return new Array<number>(MAX_LIST_LEVEL + 1).fill(0);
}

/**
 * 按文档顺序把每个列表项算成显示文本。
 *
 * 非列表段落（`numbering === null`）**不参与计数也不产出标签**——它们既不推进计数器，
 * 也不出现在结果里（R150：正文段落不是自动内容）。
 */
export function computeListLabels(
  table: NumberingTable,
  paragraphs: readonly ParagraphNode[],
): ListLabelResult {
  const counters = new Map<string, number[]>();
  const labels: ListLabel[] = [];
  const failures: ListLabelFailure[] = [];

  for (const paragraph of paragraphs) {
    const numbering = paragraph.numbering;
    if (numbering === null) {
      continue;
    }
    const reference: ListReference = { num_id: numbering.num_id, level: numbering.level };

    if (findInstance(table, reference.num_id) === null) {
      failures.push({
        paragraph_id: paragraph.id,
        reference,
        code: 'unknown_instance',
        detail: `编号实例 ${JSON.stringify(reference.num_id)} 不存在`,
      });
      continue;
    }
    const definition = effectiveLevelDefinition(table, reference.num_id, reference.level);
    if (definition === null) {
      failures.push({
        paragraph_id: paragraph.id,
        reference,
        code: 'level_not_defined',
        detail: `实例 ${JSON.stringify(reference.num_id)} 的第 ${String(reference.level)} 级没有定义`,
      });
      continue;
    }

    let slots = counters.get(reference.num_id);
    if (slots === undefined) {
      slots = emptyCounters();
      counters.set(reference.num_id, slots);
    }

    const level = reference.level;
    const current = slots[level] ?? 0;
    if (current === 0) {
      slots[level] = effectiveStart(table, reference.num_id, level) ?? definition.start;
    } else {
      slots[level] = current + 1;
    }
    for (let deeper = level + 1; deeper <= MAX_LIST_LEVEL; deeper += 1) {
      slots[deeper] = 0;
    }

    labels.push({
      paragraph_id: paragraph.id,
      reference,
      level_definition: definition,
      counters: [...slots],
      text: renderListText(definition, slots),
    });
  }

  return { labels, failures };
}

/** 单段的显示文本（不算计数，用该级起始值兜底）；不在列表或坏引用返回 `null`。 */
export function paragraphListText(table: NumberingTable, paragraph: ParagraphNode): string | null {
  const numbering = paragraph.numbering;
  if (numbering === null) {
    return null;
  }
  return paragraphListTextFor(table, { num_id: numbering.num_id, level: numbering.level });
}

/**
 * 单引用的显示文本（**把该级当作该列表的首项**时它会长什么样）；坏引用返回 `null`。
 *
 * 下级各级用各自的起始值填充（例如"第 2 级的第一项"= `3.1.`），而不是留 0——
 * 留 0 会渲染出 `3.` 或 `.3.` 这种残缺串，把"读取失败"伪装成"格式怪异"。
 */
export function paragraphListTextFor(table: NumberingTable, reference: ListReference): string | null {
  const definition = effectiveLevelDefinition(table, reference.num_id, reference.level);
  if (definition === null) {
    return null;
  }
  const slots = emptyCounters();
  for (let level = 0; level <= reference.level; level += 1) {
    slots[level] = effectiveStart(table, reference.num_id, level) ?? 1;
  }
  return renderListText(definition, slots);
}

/** 便捷索引：`paragraph_id` → 标签文本。便于"文档顺序 → 显示序号"的断言。 */
export function labelTextsByParagraph(result: ListLabelResult): ReadonlyMap<NodeId, string> {
  const map = new Map<NodeId, string>();
  for (const label of result.labels) {
    map.set(label.paragraph_id, label.text);
  }
  return map;
}

/** 只取"某一份列表"的标签（按 numId 过滤），用于隔离性断言。 */
export function labelsForList(result: ListLabelResult, numId: string): readonly ListLabel[] {
  return result.labels.filter((label) => label.reference.num_id === numId);
}

// ---------------------------------------------------------------------------
// 给导出器的形状（不含 XML；`src/documents/docx` 独占写出）
// ---------------------------------------------------------------------------

function fontSetOf(name: string | null): FontSet | null {
  if (name === null) {
    return null;
  }
  return { ascii: name, hAnsi: name, eastAsia: name, cs: name };
}

/**
 * 把编号表摊成**导出器可消费的纯数据**（`numbering.xml` 的 `w:abstractNum` / `w:num`）。
 *
 * 刻意**不含**任何 XML 字符串、不含换算结果（缩进仍是 `IndentAmount`）——转 XML 与单位
 * 折算分别是 `src/documents/docx`（R107）与 `src/documents/units`（R128）的职责，
 * 本包不越界。字段名贴近 OOXML（`ilvl` / `numFmt` / `lvlText` / `startOverride`）以便一对一映射。
 */
export function toNumberingPartShape(table: NumberingTable): NumberingPartShape {
  const toLevelShape = (level: ListLevelDefinition) => ({
    ilvl: level.level,
    numFmt: level.format,
    lvlText: level.text_template,
    start: level.start,
    pStyle: level.style_ref,
    lvlJc: level.alignment,
    indent_left: level.indent_left,
    indent_hanging: level.indent_hanging,
    rFonts: fontSetOf(level.bullet_font),
    lvlRestart: level.restart_after_level,
  });

  return {
    abstractNums: table.abstract.map((abstract) => ({
      abstractNumId: abstract.abstract_num_id,
      multiLevelType: abstract.multi_level_type,
      levels: abstract.levels.map(toLevelShape),
    })),
    nums: table.instances.map((instance) => ({
      numId: instance.num_id,
      abstractNumId: instance.abstract_num_id,
      overrides: instance.overrides.map((override) => ({
        ilvl: override.level,
        startOverride: override.start_override,
        levelDefinition: override.level_definition === null ? null : toLevelShape(override.level_definition),
      })),
    })),
  };
}

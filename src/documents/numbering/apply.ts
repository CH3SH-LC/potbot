/**
 * 段落层的列表操作（WF-039–042）。
 *
 * ## WF-039 的核心纪律：**不伪造普通文本前缀**
 *
 * "应用项目符号"最常见的错法是往段落文本前面塞一个 `• `，把列表做成**长相**列表。
 * 后果是三条一起坏：
 *
 * - 排不了版——悬挂缩进、续行对齐靠的是编号定义，文本前缀做不到；
 * - 改不了——用户想换符号得逐个段落找那个字符，重编号得手改数字；
 * - 读不出——`paragraph.text` 里凭空多出一个 `•`，它既不是用户打的字，也不是自动内容，
 *   而 R150 明确把"列表序号"划为**自动内容**，不该出现在正文文本里。
 *
 * 所以本模块的操作**只有一个出口**：写 `paragraph.numbering`（结构性的 `numPr` 引用）。
 * 函数签名里根本没有"往文本里插字符"的路径——`inlines` 只在 `removeList` 的注释里出现，
 * 而且是"原样保留、不删不加"。测试用"应用前后 `text` 逐字符相等"把这条钉死。
 *
 * ## 为什么这些函数要收 `table`
 *
 * 因为"这个引用指得对不对"必须当场判：`numId` 不存在、级别没定义、`格式` 与操作不匹配
 * （拿项目符号列表当编号列表用）都要**明确拒绝**（R154/R140），而不是写进去等导出时才发现。
 * 校验失败的返回**不带 `paragraph`**——"改了一半的段落"在类型上不可表示（R136）。
 */

import type { NodeId, ParagraphNode } from '../model/types.js';
import { findInstance, effectiveLevelDefinition, restartList, type NumberingFailure } from './table.js';
import { isCounterFormat } from './format.js';
import type { ListReference, NumberingTable } from './types.js';
import { MAX_LIST_LEVEL } from './types.js';

/** 段落列表操作的结果：失败分支**没有 `paragraph`**（R136 的原子性形态）。 */
export type ParagraphListResult =
  | { readonly ok: true; readonly paragraph: ParagraphNode }
  | NumberingFailure;

function refOf(paragraph: ParagraphNode): ListReference | null {
  const numbering = paragraph.numbering;
  return numbering === null ? null : { num_id: numbering.num_id, level: numbering.level };
}

function withReference(paragraph: ParagraphNode, ref: ListReference | null): ParagraphNode {
  // **只换引用**：`inlines` / `style_ref` / `properties` 全部原样（同一个引用）。
  return { ...paragraph, numbering: ref };
}

/**
 * 校验一个列表引用：实例存在、级有定义，且（可选）格式符合期望。
 *
 * `expected` = `'bullet'` 要求该级是项目符号；`'counter'` 要求该级参与计数；
 * `undefined` = 不限。
 */
function checkReference(
  table: NumberingTable,
  ref: ListReference,
  expected: 'bullet' | 'counter' | undefined,
  what: string,
): NumberingFailure | null {
  if (!Number.isInteger(ref.level) || ref.level < 0 || ref.level > MAX_LIST_LEVEL) {
    return {
      ok: false,
      code: 'invalid_level',
      detail: `${what}：级别必须是 0–${String(MAX_LIST_LEVEL)} 的整数，收到 ${JSON.stringify(ref.level)}`,
    };
  }
  if (findInstance(table, ref.num_id) === null) {
    return { ok: false, code: 'unknown_instance', detail: `${what}：编号实例 ${JSON.stringify(ref.num_id)} 不存在` };
  }
  const definition = effectiveLevelDefinition(table, ref.num_id, ref.level);
  if (definition === null) {
    return {
      ok: false,
      code: 'level_not_defined',
      detail: `${what}：实例 ${JSON.stringify(ref.num_id)} 的第 ${String(ref.level)} 级没有定义`,
    };
  }
  if (expected === 'bullet' && definition.format !== 'bullet') {
    return {
      ok: false,
      code: 'invalid_definition',
      detail: `${what}：第 ${String(ref.level)} 级的格式是 ${definition.format}，不是项目符号`,
    };
  }
  if (expected === 'counter' && !isCounterFormat(definition.format)) {
    return {
      ok: false,
      code: 'invalid_definition',
      detail: `${what}：第 ${String(ref.level)} 级的格式是 ${definition.format}，不参与计数`,
    };
  }
  return null;
}

/**
 * 把段落设为列表项（通用入口）。**只写引用**，正文一字不动。
 */
export function applyList(
  paragraph: ParagraphNode,
  table: NumberingTable,
  ref: ListReference,
): ParagraphListResult {
  const problem = checkReference(table, ref, undefined, '应用列表');
  if (problem !== null) {
    return problem;
  }
  return { ok: true, paragraph: withReference(paragraph, { num_id: ref.num_id, level: ref.level }) };
}

/** 应用**项目符号**（WF-039）：该级必须是 bullet 格式，否则明确拒绝。 */
export function applyBullet(
  paragraph: ParagraphNode,
  table: NumberingTable,
  ref: ListReference,
): ParagraphListResult {
  const problem = checkReference(table, ref, 'bullet', '应用项目符号');
  if (problem !== null) {
    return problem;
  }
  return { ok: true, paragraph: withReference(paragraph, { num_id: ref.num_id, level: ref.level }) };
}

/** 应用**编号列表**（WF-040：十进制 / 字母 / 罗马数字）：该级必须参与计数。 */
export function applyNumbered(
  paragraph: ParagraphNode,
  table: NumberingTable,
  ref: ListReference,
): ParagraphListResult {
  const problem = checkReference(table, ref, 'counter', '应用编号列表');
  if (problem !== null) {
    return problem;
  }
  return { ok: true, paragraph: withReference(paragraph, { num_id: ref.num_id, level: ref.level }) };
}

/** 取段的当前列表引用；不在列表里返回 `null`。 */
export function listReferenceOf(paragraph: ParagraphNode): ListReference | null {
  return refOf(paragraph);
}

/** 是否在列表里。 */
export function isListItem(paragraph: ParagraphNode): boolean {
  return paragraph.numbering !== null;
}

/**
 * 取消列表（WF-039 的"取消项目符号"）。
 *
 * 断的是**引用**（`numbering = null`），正文**原样保留**——正因为当初没往文本里塞 `• `，
 * 这里才不需要"再把 `• ` 抠掉"这一步。因为从来没有伪造前缀，所以取消后不存在残留。
 */
export function removeList(paragraph: ParagraphNode): ParagraphNode {
  return withReference(paragraph, null);
}

/** 换级（WF-041 的升级降级基础）：只改级别下标。 */
export function setListLevel(paragraph: ParagraphNode, level: number): ParagraphListResult {
  const ref = refOf(paragraph);
  if (ref === null) {
    return { ok: false, code: 'unknown_instance', detail: '该段落不在任何列表里，无法设置级别' };
  }
  if (!Number.isInteger(level) || level < 0 || level > MAX_LIST_LEVEL) {
    return { ok: false, code: 'invalid_level', detail: `级别必须是 0–${String(MAX_LIST_LEVEL)} 的整数，收到 ${JSON.stringify(level)}` };
  }
  return { ok: true, paragraph: withReference(paragraph, { num_id: ref.num_id, level }) };
}

/**
 * 升降级结果。多两个字段：
 * - `changed`：级别下标是否真的变了；
 * - `at_limit`：结果**落在边界上**（0 或 8，即再往该方向走不动了）。
 *
 * 抵到边界**不报错**（用户的"再降一级"在最低级上是合理请求），但必须如实报告没动，
 * 免得上层以为操作生效了（R154 的"各带实际原因"）。
 */
export interface LevelShiftResult {
  readonly ok: true;
  readonly paragraph: ParagraphNode;
  readonly changed: boolean;
  readonly at_limit: boolean;
}

/** 降一级（升级降级，WF-041）。最低级时 `changed: false, at_limit: true`，**不抛错**。 */
export function demoteListLevel(paragraph: ParagraphNode, steps = 1): LevelShiftResult | NumberingFailure {
  const ref = refOf(paragraph);
  if (ref === null) {
    return { ok: false, code: 'unknown_instance', detail: '该段落不在任何列表里，无法降级' };
  }
  const target = Math.min(MAX_LIST_LEVEL, ref.level + Math.max(1, steps));
  return {
    ok: true,
    paragraph: withReference(paragraph, { num_id: ref.num_id, level: target }),
    changed: target !== ref.level,
    at_limit: target === MAX_LIST_LEVEL,
  };
}

/** 升一级（WF-041）。已是最高级时 `changed: false, at_limit: true`。 */
export function promoteListLevel(paragraph: ParagraphNode, steps = 1): LevelShiftResult | NumberingFailure {
  const ref = refOf(paragraph);
  if (ref === null) {
    return { ok: false, code: 'unknown_instance', detail: '该段落不在任何列表里，无法升级' };
  }
  const target = Math.max(0, ref.level - Math.max(1, steps));
  return {
    ok: true,
    paragraph: withReference(paragraph, { num_id: ref.num_id, level: target }),
    changed: target !== ref.level,
    at_limit: target === 0,
  };
}

/** 连续升/降多级；`delta > 0` 为降级。一并返回新的级别。 */
export function shiftListLevel(
  paragraph: ParagraphNode,
  delta: number,
): (LevelShiftResult & { readonly level: number }) | NumberingFailure {
  const ref = refOf(paragraph);
  if (ref === null) {
    return { ok: false, code: 'unknown_instance', detail: '该段落不在任何列表里' };
  }
  const target = Math.min(MAX_LIST_LEVEL, Math.max(0, ref.level + delta));
  return {
    ok: true,
    paragraph: withReference(paragraph, { num_id: ref.num_id, level: target }),
    changed: target !== ref.level,
    at_limit: target === 0 || target === MAX_LIST_LEVEL,
    level: target,
  };
}

/**
 * 开头是否带**手写的**列表前缀（`•` / `1.` / `(a)` …）。
 *
 * 这是 WF-039 的**反例探测器**：真正的列表项不应该命中它。测试用它证明
 * "应用项目符号后没有伪造前缀"，也用它给存量脏数据报警（只报告，不自动删——
 * 删用户手打的字符是另一种操作，见 `removeList` 的注释）。
 */
export function manualListPrefixOf(paragraph: ParagraphNode): string | null {
  const first = paragraph.inlines.find(
    (inline): inline is Extract<ParagraphNode['inlines'][number], { kind: 'run' }> => inline.kind === 'run',
  );
  if (first === undefined) {
    return null;
  }
  const text = first.text;
  const bullet = /^[\s　]*([•·◦▪‣∙※*\-–])\s/u.exec(text);
  if (bullet !== null) {
    return bullet[1] ?? null;
  }
  const numeric = /^[\s　]*\(?(\d{1,3})[.)、]\s*/u.exec(text);
  if (numeric !== null) {
    return numeric[0] ?? null;
  }
  const alpha = /^[\s　]*\(?([a-zA-Z])[.)]\s+/u.exec(text);
  return alpha === null ? null : (alpha[0] ?? null);
}

// ---------------------------------------------------------------------------
// 批量 / 范围操作
// ---------------------------------------------------------------------------

/** 给一组段落套同一个列表引用；返回新数组与真正被改的 id（已是该引用者不计入）。 */
export function applyListToRange(
  paragraphs: readonly ParagraphNode[],
  table: NumberingTable,
  ref: ListReference,
): { readonly ok: true; readonly paragraphs: readonly ParagraphNode[]; readonly changed: readonly NodeId[] } | NumberingFailure {
  const check = checkReference(table, ref, undefined, '批量应用列表');
  if (check !== null) {
    return check;
  }
  const changed: NodeId[] = [];
  const next = paragraphs.map((paragraph) => {
    const current = refOf(paragraph);
    if (current !== null && current.num_id === ref.num_id && current.level === ref.level) {
      return paragraph;
    }
    changed.push(paragraph.id);
    return withReference(paragraph, { num_id: ref.num_id, level: ref.level });
  });
  return { ok: true, paragraphs: next, changed };
}

/** 取消一组段落的列表；返回新数组与被改的 id。 */
export function removeListFromRange(
  paragraphs: readonly ParagraphNode[],
): { readonly ok: true; readonly paragraphs: readonly ParagraphNode[]; readonly changed: readonly NodeId[] } {
  const changed: NodeId[] = [];
  const next = paragraphs.map((paragraph) => {
    if (paragraph.numbering === null) {
      return paragraph;
    }
    changed.push(paragraph.id);
    return removeList(paragraph);
  });
  return { ok: true, paragraphs: next, changed };
}

/**
 * **重启**：把指定段落从 `sourceNumId` 换到一个**新建实例**上，起始值由新实例的
 * `lvlOverride` 决定（WF-042）。
 *
 * 关键性质（对应"列表隔离"判据）：
 * - 新实例是新 `num_id`，**原实例一字未改**；
 * - 只有 `id ∈ targetIds` 的段落被改引用；其余段落（哪怕同属原列表）保持原引用，
 *   因此它们的计数不受影响。
 */
export function restartListForParagraphs(
  table: NumberingTable,
  paragraphs: readonly ParagraphNode[],
  targetIds: readonly NodeId[],
  sourceNumId: string,
  options: { readonly overrides?: readonly { readonly level: number; readonly start: number }[] } = {},
):
  | {
      readonly ok: true;
      readonly table: NumberingTable;
      readonly num_id: string;
      readonly paragraphs: readonly ParagraphNode[];
      readonly changed: readonly NodeId[];
    }
  | NumberingFailure {
  const restarted = restartList(table, sourceNumId, options);
  if (!restarted.ok) {
    return restarted;
  }
  const targets = new Set(targetIds);
  const changed: NodeId[] = [];
  const next = paragraphs.map((paragraph) => {
    const ref = refOf(paragraph);
    if (ref === null || ref.num_id !== sourceNumId || !targets.has(paragraph.id)) {
      return paragraph;
    }
    changed.push(paragraph.id);
    return withReference(paragraph, { num_id: restarted.num_id, level: ref.level });
  });
  return { ok: true, table: restarted.table, num_id: restarted.num_id, paragraphs: next, changed };
}

/**
 * **续编**：把指定段落指回一个既有实例（同一个 `num_id`），计数沿它继续（WF-042）。
 *
 * 与"重启"的区别只在起始值语义：续编不新建实例，因此不会重置计数器。
 */
export function continueListForParagraphs(
  table: NumberingTable,
  paragraphs: readonly ParagraphNode[],
  targetIds: readonly NodeId[],
  numId: string,
): { readonly ok: true; readonly paragraphs: readonly ParagraphNode[]; readonly changed: readonly NodeId[] } | NumberingFailure {
  if (findInstance(table, numId) === null) {
    return { ok: false, code: 'unknown_instance', detail: `编号实例 ${JSON.stringify(numId)} 不存在，无法续编` };
  }
  const targets = new Set(targetIds);
  const changed: NodeId[] = [];
  const next = paragraphs.map((paragraph) => {
    if (!targets.has(paragraph.id)) {
      return paragraph;
    }
    const ref = refOf(paragraph);
    if (ref !== null && ref.num_id === numId) {
      return paragraph;
    }
    changed.push(paragraph.id);
    return withReference(paragraph, { num_id: numId, level: ref?.level ?? 0 });
  });
  return { ok: true, paragraphs: next, changed };
}

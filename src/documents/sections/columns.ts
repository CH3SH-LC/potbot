/**
 * 分栏（WF-050）：单栏 / 双栏 / 自定义栏宽与间距。
 *
 * ## 两种分栏走两条路（必须说清楚）
 *
 * - **等宽 N 栏**：由模型字段 `SectionProperties.columns`（栏数）表达，**今天就能导出**
 *   （`serializeSectionProperties` 会写 `w:cols/@w:num`）。
 * - **自定义栏宽/间距**：模型**没有**这个字段，只能走 `extras.ts` 的附加项通道
 *   （`SectionExtras.columns`）。**导出侧已接线**：`docx/export.ts` 的 `sectionColumnOverrides()`
 *   把附加项换算成 twips 交给 `serializeSectionProperties`，写成
 *   `w:cols@w:equalWidth="0"` + 逐栏 `w:col`（换算全经 `units/**`，R128；本层不重算第二份）。
 *   本模块把**该落成什么**算清楚：`columnWidthsInTwips` 给出的就是 `w:col/@w:w` 与
 *   `@w:space` 要填的 twips 值。
 *
 * ## 缺口 **GAP-WF050-IMPORT-COL-WIDTH**（导入侧读不回自定义栏宽）——**已闭合**
 *
 * **原缺口**：`docx/word-xml.ts` 的 `parseSectionProperties()` 只读 `w:cols/@w:num`（栏数），
 * **不读 `w:col` 子元素**，而冻结骨架 `SectionProperties` 也没有承载逐栏宽度的字段 ⇒
 * **导出 → 重新导入**把自定义栏宽丢掉（只剩栏数），"往返闭合"不成立。
 *
 * **闭合方式**（FA-DOC-IMPORT-COLWIDTH）：
 *   1. `SectionProperties` **纯加法**新增可选字段 `columnWidths`（`SectionColumnWidth[]`，
 *      逐栏宽 + 间距，单位经 `units/**`）；
 *   2. 导入侧 `parseSectionProperties` 经 `parseColumnWidths` 解出 `w:col@w:w/@w:space`
 *      （非法值**拒绝**，不猜）；
 *   3. 导出侧 `serializeSectionProperties` 在无附加项覆盖时按该字段写回 `w:cols` + `w:col`；
 *   4. 本模块的 `columnLayoutOf` 读它、清自定义栏宽时也清它。
 * 于是 `columnLayoutOf(importDocx(exportDocx(m)))` 与导出前的版式**逐项相等**
 * （存在性证明见 `docx/import-column-width.test.ts`）。
 *
 * ## 为什么自定义栏要顺带写栏数
 *
 * `w:cols` 的 `@w:num` 与 `@w:equalWidth="0"` + N 个 `w:col` 是**一份**声明：
 * 栏数不写在 `@w:num` 里而只在子元素里出现，消费端就可能按默认 1 栏解释。
 * 所以设置自定义栏时，**栏数字段一并写**（等于 specs 的长度）。
 *
 * ## 校验
 *
 * - 栏数必须是整数且落在 `[1, MAX_COLUMNS]`（Word 界面上限 45）；
 * - 自定义栏的每栏宽高（宽 + 间距）走 `values.ts` 的长度校验；
 * - 若该节的纸张与页边距**都已指定**，还要求"各栏宽 + 栏间距之和"不超过正文区宽度——
 *   栏宽加起来比纸还宽是要在**操作前**拒绝的输入（R140），而不是等消费端排版才发现。
 */

import { DocumentModelError } from '../model/errors.js';
import { UNSPECIFIED_VALUE, specified } from '../model/attributes.js';
import { lengthToTwips } from '../units/length.js';
import type { DocumentModel, SectionProperties } from '../model/types.js';
import { readSectionExtras, writeSectionExtras } from './extras.js';
import { marginsOf, pageSizeOf, requireLength, textAreaOf } from './values.js';
import { replaceSection, requireSectionIndex, resolveSectionIndices, updateSections } from './targets.js';
import {
  MAX_COLUMNS,
  type ColumnLayout,
  type ColumnSpec,
  type SectionScope,
} from './types.js';

// ---------------------------------------------------------------------------
// 构造与读
// ---------------------------------------------------------------------------

/** 等宽 N 栏。 */
export function equalColumns(count: number): ColumnLayout {
  requireColumnCount(count);
  return { kind: 'equal', count };
}

/** 自定义栏宽与间距。 */
export function customColumns(columns: readonly ColumnSpec[]): ColumnLayout {
  requireColumnCount(columns.length);
  for (const [index, column] of columns.entries()) {
    requireLength(column.width, `第 ${String(index + 1)} 栏的宽度`);
    requireLength(column.space, `第 ${String(index + 1)} 栏的间距`);
    if (lengthToTwips(column.width) <= 0) {
      throw new DocumentModelError('invalid_node', `第 ${String(index + 1)} 栏的宽度必须为正`);
    }
  }
  return { kind: 'custom', columns: [...columns] };
}

/** 栏数（`ColumnLayout` 的两个分支都能数）。 */
export function columnCountOf(layout: ColumnLayout): number {
  return layout.kind === 'equal' ? layout.count : layout.columns.length;
}

/** 栏数合法性（`[1, MAX_COLUMNS]` 的整数）。 */
export function requireColumnCount(count: number): number {
  if (!Number.isInteger(count) || count < 1 || count > MAX_COLUMNS) {
    throw new DocumentModelError(
      'invalid_node',
      `栏数必须是 1–${String(MAX_COLUMNS)} 的整数，收到 ${String(count)}（WF-050）`,
    );
  }
  return count;
}

/**
 * 某一节当前的分栏版式。
 *
 * 三个来源，**优先级从高到低**：
 *   ① 附加项里的自定义版式（`setColumnLayout` 写的模型外通道）；
 *   ② **模型字段** `SectionProperties.columnWidths`（**导入侧**从 `w:col` 解析出来的，WF-050）；
 *   ③ 模型字段里的栏数（`SectionProperties.columns`）。
 * 三者都没有 → `null`（=该节没有指定栏数，**不是**"单栏"：R118 的同一条纪律）。
 *
 * ② 是关键：没有它，"导出 → 重新导入"就只能读回栏数、丢掉逐栏宽度
 * （**GAP-WF050-IMPORT-COL-WIDTH**）。有了它，`columnLayoutOf(importDocx(exportDocx(m)))` 与
 * 导出前的版式逐项相等。
 */
export function columnLayoutOf(model: DocumentModel, sectionIndex: number): ColumnLayout | null {
  const extras = readSectionExtras(model, sectionIndex);
  if (extras.columns !== undefined) {
    return extras.columns;
  }
  const section = model.sections[sectionIndex];
  if (section === undefined) {
    return null;
  }
  if (section.columnWidths !== undefined && section.columnWidths.length > 0) {
    return { kind: 'custom', columns: section.columnWidths };
  }
  if (section.columns.state !== 'set') {
    return null;
  }
  return { kind: 'equal', count: section.columns.value };
}

// ---------------------------------------------------------------------------
// 节级操作
// ---------------------------------------------------------------------------

/** 设置栏数（等宽栏）。清掉可能残留的自定义栏版式（两者不能并存）。 */
export function setColumnCount(section: SectionProperties, count: number): SectionProperties {
  requireColumnCount(count);
  // 等宽栏与自定义栏宽不能并存：把可能残留的逐栏宽度一并清掉，否则导出器会按 `columnWidths`
  // 写回自定义栏（与刚设的栏数矛盾）。
  return { ...section, columns: specified(count), columnWidths: undefined };
}

/** 清除栏数设置（回落到"未指定"）。 */
export function unsetColumns(section: SectionProperties): SectionProperties {
  return { ...section, columns: UNSPECIFIED_VALUE, columnWidths: undefined };
}

/**
 * 计算各栏宽与间距的 **twips 值**——将来 `w:col/@w:w` 与 `@w:space` 要填的就是它们。
 *
 * 本函数是"自定义栏宽尚未接线"这一缺口的**接口面**：接线波次拿到这张表即可落成元素，
 * 不需要再算一次（也不该在导出器里重算，否则又出现第二份换算，R128）。
 */
export function columnWidthsInTwips(
  layout: ColumnLayout,
): readonly { readonly width: number; readonly space: number }[] {
  if (layout.kind === 'equal') {
    // 等宽栏的**具体宽度**由消费端按正文区均分，这里不猜（猜了就是第二份排版实现）。
    return [];
  }
  return layout.columns.map((column) => ({
    width: lengthToTwips(column.width),
    space: lengthToTwips(column.space),
  }));
}

/** 自定义栏加起来的宽度（各栏宽 + 各栏间距）。 */
export function totalColumnWidth(layout: ColumnLayout): number {
  return columnWidthsInTwips(layout).reduce((sum, column) => sum + column.width + column.space, 0);
}

// ---------------------------------------------------------------------------
// 模型级入口
// ---------------------------------------------------------------------------

/** 给范围内的节设置等宽 N 栏（同时清掉这些节可能残留的自定义版式——两种版式不能并存）。 */
export function applyColumnCount(
  model: DocumentModel,
  scope: SectionScope,
  count: number,
): DocumentModel {
  requireColumnCount(count);
  // 先把范围内的自定义版式清掉（附加项通道），再统一改栏数字段（模型字段）。
  let next = model;
  for (const index of resolveSectionIndices(model, scope)) {
    next = clearCustomColumns(next, index);
  }
  return updateSections(next, scope, (section) => setColumnCount(section, count));
}

/**
 * 给**某一节**设置分栏版式（等宽或自定义）。
 *
 * 自定义版式需要挂附加项，所以这条入口是**按节索引**的，不接受 `SectionScope`：
 * "全文每节各自的栏宽都不同"这种要求得逐节给，不能用一个范围糊过去。
 */
export function setColumnLayout(
  model: DocumentModel,
  sectionIndex: number,
  layout: ColumnLayout,
): DocumentModel {
  requireSectionIndex(model, sectionIndex);
  const section = model.sections[sectionIndex] as SectionProperties;
  if (layout.kind === 'custom') {
    customColumns(layout.columns);
    assertColumnsFit(section, layout);
    // 先写栏数字段（两种版式都需要），再挂自定义版式到附加项通道。
    const withCount = replaceSection(model, sectionIndex, setColumnCount(section, layout.columns.length));
    return writeSectionExtras(withCount, sectionIndex, {
      ...readSectionExtras(model, sectionIndex),
      columns: layout,
    });
  }
  requireColumnCount(layout.count);
  const withCount = replaceSection(model, sectionIndex, setColumnCount(section, layout.count));
  return clearCustomColumns(withCount, sectionIndex);
}

/**
 * 清掉某一节的自定义栏版式（保留栏数字段）。
 *
 * 两个来源都要清：附加项通道（`setColumnLayout` 写的）**与**模型字段 `columnWidths`
 * （导入侧从 `w:col` 解析出来的）——只清一个，另一个就会在导出时把自定义栏宽又写回去。
 */
export function clearCustomColumns(model: DocumentModel, sectionIndex: number): DocumentModel {
  const extras = readSectionExtras(model, sectionIndex);
  const hadExtras = extras.columns !== undefined;
  const hadWidths = model.sections[sectionIndex]?.columnWidths !== undefined;
  if (!hadExtras && !hadWidths) {
    return model;
  }
  let next = model;
  if (hadExtras) {
    const { columns: _dropped, ...rest } = extras;
    void _dropped;
    next = writeSectionExtras(next, sectionIndex, rest);
  }
  if (hadWidths) {
    const target = next.sections[sectionIndex] as SectionProperties;
    next = replaceSection(next, sectionIndex, { ...target, columnWidths: undefined });
  }
  return next;
}

/** 自定义栏总宽是否放得下（纸张与页边距都指定时才检查）。 */
function assertColumnsFit(section: SectionProperties, layout: ColumnLayout): void {
  const size = pageSizeOf(section);
  const margins = marginsOf(section);
  if (size === null || margins === null) return;
  const available = lengthToTwips(textAreaOf(size, margins).width);
  const used = totalColumnWidth(layout);
  if (used > available) {
    throw new DocumentModelError(
      'invalid_node',
      `自定义栏宽放不下：各栏宽 + 栏间距合计 ${String(used)} twips，正文区宽度只有 ${String(available)} twips（WF-050）`,
    );
  }
}

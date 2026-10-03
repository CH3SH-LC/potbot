/**
 * 节级"模型未建模"属性的**唯一承载通道**——分节符类型（WF-049）与自定义栏宽（WF-050）。
 *
 * ## 为什么需要它（以及为什么要说清楚代价）
 *
 * `SectionProperties` 由主协调者**冻结**，本任务只读。它没有 `w:type`（分节符类型），
 * 也没有 `w:col` 的自定义栏宽 / 栏间距——而 WF-049 要求"连续/下页/奇/偶页各一例"、
 * WF-050 要求"自定义栏宽间距"。既然不能改模型，本包只能使用模型**本来就有的**扩展通道：
 * `NodeBase.opaque`。`docx/layout.ts` 已经用同一条通道承载 `section_index`、
 * `raw_before_block` 这类"未建模但必须活下来"的项，本包沿用同样的做法：
 *
 * ```ts
 * { kind: 'section_extras', index: <节索引>, start_type?: 'oddPage', columns?: {...} }
 * ```
 *
 * ## 代价（必须如实登记，不许含糊）
 *
 * `serializeSectionProperties(section)` 本身**只读 `SectionProperties` 的字段**，
 * 附加项要看导出器有没有显式去读这个通道。当前状态：
 *
 * | 附加项 | 导出侧 | 说明 |
 * |---|---|---|
 * | `columns`（自定义栏宽，WF-050） | **已接线** | `docx/export.ts` 的 `sectionColumnOverrides()` → `columnsOverride` |
 * | `start_type`（WF-049） | **未接线** | 导出只认模型字段 `section.sectionType`；先前的缺口在 `.task-manifest/outputs/WCF-D51/completion.md` 登记 |
 *
 * 干净的解法仍是**应有的模型扩展**（`SectionProperties` 追加 `sectionType?`）。`sectionType`
 * 已经这么做了（见 `model/types.ts`）；`start_type` 附加项**保留**为兼容通道。
 * 与自定义栏宽有关的往返缺口 **GAP-WF050-IMPORT-COL-WIDTH**（导入侧不读 `w:col`）**已闭合**：
 * 逐栏宽度落进模型字段 `SectionProperties.columnWidths`（见 `sections/columns.ts` 头部）。
 *
 * ## 挂在哪里
 *
 * 文档级（不属于任何节的）附加项没有文档级容器（`DocumentModel` 没有该字段），
 * 沿用 `layout.ts` 对 body 级片段的既有约定：挂在**块**的 `opaque` 上。
 * 本包的约定更窄、更确定：
 *
 * - **写**：一律写进**文档第一个块**的 `opaque`（位置固定 ⇒ 同样的输入产出同样的模型，R137）；
 * - **读**：按**文档顺序扫全部块**并合并（这样即使块被结构编辑挪动过，项也不会丢）；
 * - 节索引是**键**，因此插入/删除分节符时只需按映射重排索引，与块的位置无关。
 *
 * 文档**没有任何块**时无处挂载 → 明确拒绝（`unsupported`），不静默丢弃。
 */

import { DocumentModelError } from '../model/errors.js';
import type { BlockNode, DocumentModel } from '../model/types.js';
import type { ColumnLayout, SectionStartType } from './types.js';

/** 附加项在 `opaque` 里的判别标签（与 `layout.ts` 的既有标签风格一致）。 */
export const SECTION_EXTRAS_KIND = 'section_extras';

/** 一个节的附加项。字段全部可选——没有附加项就是"没写"。 */
export interface SectionExtras {
  /** 分节符类型（WF-049）：本节**相对上一节**怎么开始。 */
  readonly start_type?: SectionStartType;
  /** 自定义栏宽与间距（WF-050）；`undefined` = 等宽栏（由 `columns` 栏数表达）。 */
  readonly columns?: ColumnLayout;
}

/** 落在 `opaque` 里的形状：附加项 + 它属于哪一节。 */
export interface SectionExtrasItem extends SectionExtras {
  readonly kind: typeof SECTION_EXTRAS_KIND;
  readonly index: number;
}

function isExtrasItem(value: unknown): value is SectionExtrasItem {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { kind?: unknown; index?: unknown };
  return candidate.kind === SECTION_EXTRAS_KIND && typeof candidate.index === 'number';
}

/** 文档级全部附加项（按块顺序收集；同索引重复时**先出现的生效**，并可通过 `duplicates` 发现）。 */
export function collectSectionExtras(model: DocumentModel): {
  readonly bySection: ReadonlyMap<number, SectionExtras>;
  readonly duplicates: readonly number[];
} {
  const bySection = new Map<number, SectionExtras>();
  const duplicates: number[] = [];
  for (const block of model.blocks) {
    for (const item of block.opaque) {
      if (!isExtrasItem(item)) continue;
      if (bySection.has(item.index)) {
        duplicates.push(item.index);
        continue;
      }
      bySection.set(item.index, extrasOf(item));
    }
  }
  return { bySection, duplicates };
}

function extrasOf(item: SectionExtrasItem): SectionExtras {
  const extras: { start_type?: SectionStartType; columns?: ColumnLayout } = {};
  if (item.start_type !== undefined) extras.start_type = item.start_type;
  if (item.columns !== undefined) extras.columns = item.columns;
  return extras;
}

/** 取某一节的附加项；没有则返回空对象（`{}` = 两项都没设，**不是** `null`）。 */
export function readSectionExtras(model: DocumentModel, index: number): SectionExtras {
  return collectSectionExtras(model).bySection.get(index) ?? {};
}

/** 该块是否承载本通道的项（供测试断言"挂在哪里"）。 */
export function carriesSectionExtras(block: BlockNode): boolean {
  return block.opaque.some((item) => isExtrasItem(item));
}

/**
 * 写入某一节的附加项。
 *
 * - 只允许挂到**文档第一个块**；文档没有块时拒绝（不静默丢弃，R140）；
 * - 同索引的旧项（若被挪到别的块上）一并清除，保证"一个节一份"；
 * - 其余块的 `opaque` **原样保留**（不改无关块）。
 */
export function writeSectionExtras(
  model: DocumentModel,
  index: number,
  extras: SectionExtras,
): DocumentModel {
  if (model.blocks.length === 0) {
    throw new DocumentModelError(
      'unsupported',
      '文档没有任何块，节附加项（分节符类型 / 自定义栏宽）无处挂载。' +
        '节级附加项按约定挂在块的 opaque 上（模型没有文档级 opaque 字段）——' +
        '请先让文档至少有一个块，或改用本包外的模型扩展。',
    );
  }
  const item: SectionExtrasItem = { kind: SECTION_EXTRAS_KIND, index, ...extras };
  const blocks = model.blocks.map((block, blockIndex) => {
    const kept = block.opaque.filter((value) => !(isExtrasItem(value) && value.index === index));
    const nextOpaque = blockIndex === 0 ? [...kept, item] : kept;
    if (nextOpaque.length === block.opaque.length && blockIndex !== 0) {
      return block;
    }
    return nextOpaque === block.opaque ? block : { ...block, opaque: nextOpaque };
  });
  return { ...model, blocks };
}

/** 删除某一节的附加项（该节此后按其"未指定"参与导出）。 */
export function removeSectionExtras(model: DocumentModel, index: number): DocumentModel {
  const blocks = model.blocks.map((block) => {
    const kept = block.opaque.filter((value) => !(isExtrasItem(value) && value.index === index));
    return kept.length === block.opaque.length ? block : { ...block, opaque: kept };
  });
  return blocks.some((block, at) => block !== model.blocks[at]) ? { ...model, blocks } : model;
}

/**
 * 按映射**重排**全部附加项的节索引（插入/删除分节符时用）。
 *
 * `remap` 返回 `null` = 丢弃该项。这是"节索引是键"的代价与好处：重排只需一处实现，
 * 不必逐个容器去找。未被 `remap` 改变的项**原对象保留**（引用不变 ⇒ 字节不变）。
 */
export function remapSectionExtras(
  model: DocumentModel,
  remap: (index: number) => number | null,
): DocumentModel {
  let changed = false;
  const blocks = model.blocks.map((block) => {
    let moved = false;
    const opaque: unknown[] = [];
    for (const value of block.opaque) {
      if (!isExtrasItem(value)) {
        opaque.push(value);
        continue;
      }
      const next = remap(value.index);
      if (next === null) {
        moved = true;
        continue;
      }
      if (next === value.index) {
        opaque.push(value);
        continue;
      }
      moved = true;
      opaque.push({ ...value, index: next });
    }
    if (!moved) return block;
    changed = true;
    return { ...block, opaque };
  });
  return changed ? { ...model, blocks } : model;
}

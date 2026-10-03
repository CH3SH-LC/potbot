/**
 * 分节符（WF-049）与**节隔离**（R108）——本包最容易做错的地方，实现与理由都写在这里。
 *
 * ## 模型里"节"是怎么摆的
 *
 * `DocumentModel.sections` 是**有序数组**，而"哪一段属于哪一节"由**标记**决定：
 * 段落 `opaque` 里的 `{ kind: 'section_index', index }` 表示"**这一节**（`sections[index]`）
 * 到这一段为止结束"（OOXML：`w:p/w:pPr/w:sectPr` 承载的是**前一节**的属性，
 * 最后一节的属性在 `w:body` 末尾的 `sectPr` 上）。因此不变量是：
 *
 * > 第 i 个标记（按文档顺序）的 `index` 必须是 `i`；`sections.length` = 标记数 + 1。
 *
 * 这个不变量是"节索引 ↔ 文档位置"的**唯一**桥梁。它一旦被破坏（例如插入新节时忘了
 * 给后面的标记 +1），后果就是**节互相污染**：第 3 节的文字显示第 2 节的页面设置，
 * 而 `sections` 数组本身看起来还是"对的"。R108 的判据（"给第 2 节设横向，
 * 第 1、3 节逐字节不变"）抓的就是这一类错。
 *
 * ## 插入分节符到底发生了什么
 *
 * 设块 `B` 落在第 `m` 节里（`m` = 文档中 `B` **之前**的标记个数）。在 `B` 处插入分节符：
 *
 * | | 插入前 | 插入后 |
 * |---|---|---|
 * | 节数组 | `[S0 … S_m … S_{n-1}]` | `[S0 … S_m, N, S_{m+1} … S_{n-1}]` |
 * | `B` 之前的标记 | 索引 `0 … m-1` | **不变** |
 * | `B` | 无标记 | 新标记，`index = m` |
 * | `B` 之后的标记 | 索引 `m, m+1, …` | **全部 +1**（变 `m+1, m+2, …`） |
 *
 * 于是：`B` 之前的正文仍归 `S_m`（**对象原样保留**，`B` 之前的内容一个字节没变），
 * `B` 之后的正文归新节 `N`（`S_m` 的属性副本 ⇒ **外观不变**，只是被切开）。
 * "插入分节符不该改变排版"这条直觉，正是靠"新节 = 旧属性副本 + 新的分节符类型"实现的。
 *
 * ## `w:type` 属于**它开始的那一节**（这一条决定 `insertSectionBreak` 的写法）
 *
 * `w:type` 的语义是"**本节**相对**上一节**怎么开始"（ECMA-376 §17.6.22 / `ST_SectionMark`
 * §17.18.77），所以它写在**它所描述的那一节自己的 `sectPr`** 上：
 * 在 `B` 处插入"奇数页分节符"，`w:type="oddPage"` 落在**新节 `N`**（`B` 之后那一节）上，
 * 而不是 `S_m` 上。python-docx 的文档给了 Word 的实际行为作证：在 P1 后插入奇数页分节符后，
 * **前**一节的 `sectPr` 副本**不带** `w:type`，`w:type="oddPage"` 出现在承载 P2 的那一节上。
 * 这一点若写反，效果是"分节符往后错一节"——文件能打开，但分页行为是错的。
 *
 * ## 删除分节符
 *
 * 删掉 `B` 上的标记 = 把 `B` 之前的正文并进**后面**那一节，采用后节的页面设置
 * （Word 的行为）。所以实现是"移除 `sections[m]`"，而不是"移除 `sections[m+1]`"。
 *
 * 注意由此得到的一个**正确**结果：先插入再删除**不保证**回到逐字段完全相同的节数组
 * （插入会新增一个属性副本）。本包不假装它是恒等操作——`section-breaks.test.ts` 用
 * "逐字段等价"而不是"引用相等"钉住这一对往返。
 */

import { DocumentModelError } from '../model/errors.js';
import { insertAt, removeAt } from '../model/immutable.js';
import { findBlockLocation } from '../model/walk.js';
import { layoutItems } from '../docx/layout.js';
import type { BlockNode, DocumentModel, NodeId, ParagraphNode, SectionProperties } from '../model/types.js';
import {
  readSectionExtras,
  remapSectionExtras,
  removeSectionExtras,
  writeSectionExtras,
  type SectionExtras,
} from './extras.js';
import { requireSectionIndex, withSections } from './targets.js';
import { SECTION_START_TYPES, ST_SECTION_MARK, type SectionStartType } from './types.js';

// ---------------------------------------------------------------------------
// 标记的读
// ---------------------------------------------------------------------------

/** 一个分节标记：落在哪个块上、在正文里的第几个块、指向第几节。 */
export interface SectionMarker {
  readonly block_id: NodeId;
  readonly body_index: number;
  readonly section_index: number;
}

function markerIndexOf(block: BlockNode): number | null {
  for (const item of layoutItems(block, 'section_index')) {
    if (typeof item.index === 'number') return item.index;
  }
  return null;
}

/** 按文档顺序列出全部分节标记。 */
export function sectionMarkers(model: DocumentModel): readonly SectionMarker[] {
  const markers: SectionMarker[] = [];
  model.blocks.forEach((block, bodyIndex) => {
    const index = markerIndexOf(block);
    if (index !== null) {
      markers.push({ block_id: block.id, body_index: bodyIndex, section_index: index });
    }
  });
  return markers;
}

/** 某个块自己是不是分节边界的**末端**（即它上面有标记）；不是返回 `null`。 */
export function sectionMarkerOfBlock(model: DocumentModel, blockId: NodeId): number | null {
  const location = findBlockLocation(model, blockId);
  if (location === null || location.container.kind !== 'body') return null;
  return markerIndexOf(location.block);
}

/**
 * 某个块**所属**的节索引。
 *
 * 取"该块**之前**的标记个数"——注意是严格之前：一个带标记的段落本身属于**它结束的**
 * 那一节（这正是 OOXML 的语义：标记段落的内容在它前面那一节里）。
 * 不在正文里（表格单元格内）或找不到块时返回 `null`。
 */
export function sectionIndexOfBlock(model: DocumentModel, blockId: NodeId): number | null {
  const location = findBlockLocation(model, blockId);
  if (location === null || location.container.kind !== 'body') return null;
  let count = 0;
  for (let index = 0; index < location.index; index += 1) {
    const block = model.blocks[index];
    if (block !== undefined && markerIndexOf(block) !== null) count += 1;
  }
  return count;
}

/**
 * 自检：分节标记与 `sections` 是否自洽。
 *
 * 返回问题清单（空数组 = 自洽）。实现者自己用它在每次插入/删除后对账，
 * 测试也用它把"不变量确实保住了"变成断言，而不是靠人眼盯。
 */
export function checkSectionMarkers(model: DocumentModel): readonly string[] {
  const problems: string[] = [];
  const markers = sectionMarkers(model);
  markers.forEach((marker, order) => {
    if (marker.section_index !== order) {
      problems.push(
        `第 ${String(order)} 个标记（块 ${marker.block_id}）指向第 ${String(marker.section_index)} 节，` +
          `按不变量应为第 ${String(order)} 节`,
      );
    }
  });
  if (model.sections.length !== markers.length + 1) {
    problems.push(
      `节数 ${String(model.sections.length)} 与标记数 ${String(markers.length)} 不自洽（应满足 节数 = 标记数 + 1）`,
    );
  }
  return problems;
}

/** 断言自洽；不自洽即抛（用于插入/删除之后的自我对账）。 */
function assertSectionMarkers(model: DocumentModel): void {
  const problems = checkSectionMarkers(model);
  if (problems.length > 0) {
    throw new DocumentModelError('invalid_document', `分节标记不自洽：${problems.join('；')}`);
  }
}

// ---------------------------------------------------------------------------
// 标记的重排
// ---------------------------------------------------------------------------

/**
 * 按映射重排所有标记的 `index`。
 *
 * 只碰带标记的块；**不带标记的块原对象保留**（引用不变 ⇒ 字节不变）。
 * 返回新模型与重排个数。`remap` 返 `null` 表示删掉该标记。
 */
function remapSectionMarkers(
  model: DocumentModel,
  remap: (index: number) => number | null,
): DocumentModel {
  let changed = false;
  const blocks = model.blocks.map((block) => {
    const current = markerIndexOf(block);
    if (current === null) return block;
    const next = remap(current);
    changed = true;
    const kept = block.opaque.filter((item) => {
      const candidate = item as { kind?: unknown };
      return candidate.kind !== 'section_index';
    });
    if (next === null) {
      return { ...block, opaque: kept };
    }
    return { ...block, opaque: [...kept, { kind: 'section_index', index: next }] };
  });
  return changed ? { ...model, blocks } : model;
}

// ---------------------------------------------------------------------------
// 插入 / 删除
// ---------------------------------------------------------------------------

function requireBodyParagraph(
  model: DocumentModel,
  blockId: NodeId,
  what: string,
): { readonly block: ParagraphNode; readonly bodyIndex: number; readonly markersBefore: number } {
  const location = findBlockLocation(model, blockId);
  if (location === null) {
    throw new DocumentModelError('unknown_node', `找不到块 ${JSON.stringify(blockId)}`);
  }
  if (location.container.kind !== 'body') {
    throw new DocumentModelError(
      'unsupported',
      `${what}只能落在正文段落上：${JSON.stringify(blockId)} 在表格单元格里。` +
        'OOXML 的节属性由正文里的段落承载，单元格段落上的 w:sectPr 是非法结构（R108）。',
    );
  }
  if (location.block.kind !== 'paragraph') {
    throw new DocumentModelError(
      'unsupported',
      `${what}只能落在段落上：${JSON.stringify(blockId)} 是表格。` +
        '要在一张表之后分节，请把分节符加在它前后的段落上。',
    );
  }
  let markersBefore = 0;
  for (let index = 0; index < location.index; index += 1) {
    const block = model.blocks[index];
    if (block !== undefined && markerIndexOf(block) !== null) markersBefore += 1;
  }
  return { block: location.block, bodyIndex: location.index, markersBefore };
}

/**
 * 在某个正文段落之后插入分节符（WF-049）：`B` 之后的正文进入**新节**，
 * 新节的属性是 `B` 所在节的**副本**（外观不变），其分节符类型为 `startType`。
 *
 * 局部页面设置**不污染其他节**（R108）：`B` 之前的所有节对象**引用原样保留**；
 * `B` 之后的节只是索引 +1，属性对象一个字节没动。
 *
 * 拒绝的情形（都在改动之前抛出，故文档不变，R140）：
 * - 该块已经是分节边界（再插一次会切出一个空节）；
 * - 该块不是正文段落（表格 / 单元格内）。
 */
export function insertSectionBreak(
  model: DocumentModel,
  blockId: NodeId,
  startType: SectionStartType,
): DocumentModel {
  if (!SECTION_START_TYPES.includes(startType)) {
    throw new DocumentModelError(
      'unsupported',
      `未知的分节符类型：${JSON.stringify(startType)}（可用：${SECTION_START_TYPES.join(' / ')}）`,
    );
  }
  const { markersBefore, bodyIndex } = requireBodyParagraph(model, blockId, '分节符');
  const block = model.blocks[bodyIndex];
  if (block !== undefined && markerIndexOf(block) !== null) {
    throw new DocumentModelError(
      'unsupported',
      `块 ${JSON.stringify(blockId)} 已经是分节边界：在它之后再插分节符会切出一个空节（R140）。`,
    );
  }
  assertSectionMarkers(model);

  const m = markersBefore;
  const head = model.sections[m] as SectionProperties;
  // 新节：属性与"被切开的这一节"完全相同（插入分节符不改变外观），
  // 只有它的**分节符类型**是本次请求的类型（w:type 属于它开始的那一节）。
  const created: SectionProperties = { ...head };
  const headExtras = readSectionExtras(model, m);

  let next = withSections(model, insertAt(model.sections, m + 1, created));
  // 标记：`B` 之前的不动；`B` 之后（索引 ≥ m）的全部 +1；`B` 上新增 index = m。
  next = remapSectionMarkers(next, (index) => (index < m ? index : index + 1));
  next = addMarker(next, bodyIndex, m);
  // 附加项：索引 > m 的 +1；新节 m+1 承接旧 m 的附加项，并把分节符类型设为请求值。
  next = remapSectionExtras(next, (index) => (index <= m ? index : index + 1));
  next = writeSectionExtras(next, m + 1, { ...headExtras, start_type: startType });

  assertSectionMarkers(next);
  return next;
}

/** 给正文第 `bodyIndex` 个块加上分节标记。 */
function addMarker(model: DocumentModel, bodyIndex: number, sectionIndex: number): DocumentModel {
  const blocks = model.blocks.map((block, index) =>
    index === bodyIndex
      ? { ...block, opaque: [...block.opaque, { kind: 'section_index', index: sectionIndex }] }
      : block,
  );
  return { ...model, blocks };
}

/**
 * 删除某个段落上的分节符：它前面的正文并入**后面**那一节，采用后节的页面设置
 * （Word 的行为）。删掉 `sections[m]`，并且 `B` 之后的标记索引 −1。
 *
 * 该块不是分节边界时**拒绝**（不静默无操作，R112）。
 */
export function removeSectionBreak(model: DocumentModel, blockId: NodeId): DocumentModel {
  const { markersBefore } = requireBodyParagraph(model, blockId, '分节符');
  const marker = sectionMarkerOfBlock(model, blockId);
  if (marker === null) {
    throw new DocumentModelError(
      'unknown_node',
      `块 ${JSON.stringify(blockId)} 不是分节边界，没有分节符可删（R112：不静默无操作）。`,
    );
  }
  assertSectionMarkers(model);
  if (marker !== markersBefore) {
    throw new DocumentModelError(
      'invalid_document',
      `分节标记不自洽：块上的标记指向第 ${String(marker)} 节，按文档顺序应为第 ${String(markersBefore)} 节`,
    );
  }
  let next = withSections(model, removeAt(model.sections, marker));
  next = remapSectionMarkers(next, (index) => (index < marker ? index : index === marker ? null : index - 1));
  next = remapSectionExtras(next, (index) => (index < marker ? index : index === marker ? null : index - 1));
  assertSectionMarkers(next);
  return next;
}

// ---------------------------------------------------------------------------
// 分节符类型（WF-049 的四个变体）
// ---------------------------------------------------------------------------

/** `w:type/@w:val` 的记号（本包不拼 XML，只给记号；R107）。 */
export function sectionBreakToken(type: SectionStartType): string {
  return ST_SECTION_MARK[type];
}

/** 某节的分节符类型；没设过返回 `null`（**不是**默认的 `nextPage`——"没设过"与"设成默认值"是两回事，R118）。 */
export function sectionStartTypeOf(model: DocumentModel, sectionIndex: number): SectionStartType | null {
  requireSectionIndex(model, sectionIndex);
  return readSectionExtras(model, sectionIndex).start_type ?? null;
}

/** 设置某节的分节符类型（该节相对前一节怎么开始）。 */
export function setSectionStartType(
  model: DocumentModel,
  sectionIndex: number,
  type: SectionStartType,
): DocumentModel {
  requireSectionIndex(model, sectionIndex);
  if (!SECTION_START_TYPES.includes(type)) {
    throw new DocumentModelError(
      'unsupported',
      `未知的分节符类型：${JSON.stringify(type)}（可用：${SECTION_START_TYPES.join(' / ')}）`,
    );
  }
  const extras = readSectionExtras(model, sectionIndex);
  return writeSectionExtras(model, sectionIndex, withStartType(extras, type));
}

/** 清除某节的分节符类型设置（回落到"没设过"）。 */
export function clearSectionStartType(model: DocumentModel, sectionIndex: number): DocumentModel {
  requireSectionIndex(model, sectionIndex);
  const extras = readSectionExtras(model, sectionIndex);
  const { start_type: _dropped, ...rest } = extras;
  void _dropped;
  if (Object.keys(rest).length === 0) {
    return removeSectionExtras(model, sectionIndex);
  }
  return writeSectionExtras(model, sectionIndex, rest);
}

function withStartType(extras: SectionExtras, type: SectionStartType): SectionExtras {
  return { ...extras, start_type: type };
}

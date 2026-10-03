/**
 * 分页符与分栏符（WF-048/050 的"分栏符"部分）。
 *
 * ## 一条必须分清的事：分页符 ≠ "段前分页"（WF-048 明确要求语义分开）
 *
 * 两者都能让内容翻到下一页，但**结构完全不同**，混同会直接产出错误的文件：
 *
 * | | 分页符（本模块） | 段前分页（WF-032，已在 `operations/paragraph/pagination.ts`） |
 * |---|---|---|
 * | 落在哪里 | **段内**：一个行内节点 `w:r/w:br[@w:type="page"]` | **段属性**：`w:pPr/w:pageBreakBefore` |
 * | 能不能"插在段落中间" | 能（它就在文字流里那一点） | 不能（它整段生效） |
 * | 删掉一段文字会不会带走它 | 会——它就在那段里 | 不会——它是那段的属性 |
 * | 模型表示 | `BreakNode{breakType:'page'}`（`InlineNode`） | `ParagraphProperties.pageBreakBefore`（四态开关） |
 *
 * 所以本模块**不重新实现**段前分页（那是 D04 的地盘），而是提供
 * `paragraphBreakSources()` 把两种机制**分别指认**出来——测试与上层用它区分，
 * 也是"这两件事没被实现成一个"的可执行证据。构造行内换行节点一律复用
 * `operations/paragraph/breaks.ts` 的 `createPageBreak` / `createColumnBreak`
 * （已有实现，不在这里再造一套）。
 *
 * ## 偏移是 Unicode 码位（R102）
 *
 * 与拆段同口径：`'😀'` 是一个码位、两个 UTF-16 码元。偏移落在代理对中间会切出半个
 * emoji。因此插入位置的合法性判定与 run 切分都走
 * `operations/paragraph/breaks.ts` 里已有的码位工具（`inlineCodePointLength` /
 * `paragraphCodePointLength` / `substringByCodePoints`），本文件不自己数长度。
 *
 * ## 切 run 时的 id 纪律（R101）
 *
 * 前半段保留原 run 的 id 与属性对象；后半段是新节点，取 `allocateId()` 的 id，
 * 并**深拷贝**一份属性（`cloneRunProperties`）——两个 run 此后各改各的，
 * 不会因为共享属性对象而被后续某次"改字符格式"连带改掉。
 */

import { DocumentModelError } from '../model/errors.js';
import { findBlockLocation, replaceBlockInModel } from '../model/walk.js';
import { cloneRunProperties } from '../operations/paragraph/clone.js';
import {
  createColumnBreak,
  createLineBreak,
  createPageBreak,
  inlineCodePointLength,
  paragraphCodePointLength,
  substringByCodePoints,
} from '../operations/paragraph/breaks.js';
import type {
  BreakNode,
  DocumentModel,
  InlineNode,
  NodeId,
  ParagraphNode,
  RunNode,
  ToggleState,
} from '../model/types.js';
import { sectionIndexOfBlock } from './section-breaks.js';
import { columnCountOf, columnLayoutOf } from './columns.js';

/** 行内换行节点的三种类型（`line` 是软换行，`page` 是分页符，`column` 是分栏符）。 */
export type BreakType = BreakNode['breakType'];

const PAGE_BREAK: BreakType = 'page';
const COLUMN_BREAK: BreakType = 'column';

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

/** 段落里所有行内换行节点（按文档顺序）。 */
export function breaksOf(paragraph: ParagraphNode): readonly BreakNode[] {
  return paragraph.inlines.filter((inline): inline is BreakNode => inline.kind === 'break');
}

/** 段落里指定类型的换行节点。 */
export function breaksOfType(paragraph: ParagraphNode, breakType: BreakType): readonly BreakNode[] {
  return breaksOf(paragraph).filter((node) => node.breakType === breakType);
}

/** 按 id 找行内换行节点；没有返回 `null`。 */
export function findBreak(paragraph: ParagraphNode, breakId: NodeId): BreakNode | null {
  for (const inline of paragraph.inlines) {
    if (inline.kind === 'break' && inline.id === breakId) {
      return inline;
    }
  }
  return null;
}

/**
 * 一个段落里的"分页机制"分别是什么——**分页符与段前分页分开列**（WF-048 的判据）。
 *
 * 两个字段是两种不同的结构，调用方（与测试）据此指认：
 * - `inline_page_breaks`：段内的分页符节点（本模块管的）；
 * - `page_break_before`：段落属性里的段前分页四态（D04 管的，`unspecified` = 没设过）。
 */
export interface ParagraphBreakSources {
  readonly inline_page_breaks: readonly NodeId[];
  readonly inline_column_breaks: readonly NodeId[];
  readonly page_break_before: ToggleState;
}

export function paragraphBreakSources(paragraph: ParagraphNode): ParagraphBreakSources {
  return {
    inline_page_breaks: breaksOfType(paragraph, PAGE_BREAK).map((node) => node.id),
    inline_column_breaks: breaksOfType(paragraph, COLUMN_BREAK).map((node) => node.id),
    page_break_before: paragraph.properties.pageBreakBefore,
  };
}

// ---------------------------------------------------------------------------
// 插入
// ---------------------------------------------------------------------------

/**
 * 在段落的**码位偏移**处插入一个行内换行节点。
 *
 * 偏移合法范围 `[0, 段落码位长度]`：`0` = 段首、`长度` = 段尾。越界即抛，
 * **不夹紧**（R136：非法范围不得"前半段成功、后半段悄悄失败"）。
 *
 * 切点恰好落在两个节点之间时，**零宽节点归前半段**（软换行留在换行之前）——
 * 与 `splitParagraph` 的同一约定，避免"拆段"与"插换行"在同一位置上给出不同结果。
 */
export function insertBreakAt(
  paragraph: ParagraphNode,
  offset: number,
  breakType: BreakType,
  allocateId: () => NodeId,
): ParagraphNode {
  const total = paragraphCodePointLength(paragraph);
  if (!Number.isInteger(offset) || offset < 0 || offset > total) {
    throw new DocumentModelError(
      'invalid_index',
      `插入换行的偏移越界：${String(offset)}（合法范围 0–${String(total)} 码位）`,
    );
  }
  const created =
    breakType === PAGE_BREAK
      ? createPageBreak(allocateId())
      : breakType === COLUMN_BREAK
        ? createColumnBreak(allocateId())
        : createLineBreak(allocateId());

  const inlines: InlineNode[] = [];
  let consumed = 0;
  let placed = false;
  for (const inline of paragraph.inlines) {
    const width = inlineCodePointLength(inline);
    if (!placed && width > 0 && consumed >= offset) {
      // 切点在本节点**之前**（含正好落在节点起点）：插在它前面，本节点整体留在后面。
      // 这里必须 `continue`——否则同一个切点会先"插在前面"、再走下面的"切开本节点"，
      // 于是换行被插两次（本包曾在 `insertBreakAt(…, 0, …)` 上踩到过这个坑）。
      inlines.push(created);
      inlines.push(inline);
      consumed += width;
      placed = true;
      continue;
    }
    if (width === 0 || consumed + width <= offset) {
      // 零宽节点（软换行 / 域）：在切点处的归前半段——与 `splitParagraph` 同一约定。
      inlines.push(inline);
      consumed += width;
      continue;
    }
    // 切点落在本 run 内部（只可能是文本 run）。
    const local = offset - consumed;
    if (inline.kind !== 'run') {
      inlines.push(inline);
      consumed += width;
      continue;
    }
    const [head, tail] = splitRun(inline, local, allocateId);
    if (head.text !== '') inlines.push(head);
    inlines.push(created);
    placed = true;
    if (tail.text !== '') inlines.push(tail);
    consumed += width;
  }
  if (!placed) {
    inlines.push(created);
  }
  return { ...paragraph, inlines };
}

/** 在码位偏移处插入分页符（`w:br w:type="page"`）。 */
export function insertPageBreak(
  paragraph: ParagraphNode,
  offset: number,
  allocateId: () => NodeId,
): ParagraphNode {
  return insertBreakAt(paragraph, offset, PAGE_BREAK, allocateId);
}

/** 在码位偏移处插入分栏符（`w:br w:type="column"`）。 */
export function insertColumnBreak(
  paragraph: ParagraphNode,
  offset: number,
  allocateId: () => NodeId,
): ParagraphNode {
  return insertBreakAt(paragraph, offset, COLUMN_BREAK, allocateId);
}

/** 把 run 按码位切成两半；前半保 id 与属性，后半取新 id 与属性副本（R101）。 */
function splitRun(run: RunNode, offset: number, allocateId: () => NodeId): readonly [RunNode, RunNode] {
  const head: RunNode = { ...run, text: substringByCodePoints(run.text, 0, offset) };
  const tail: RunNode = {
    kind: 'run',
    id: allocateId(),
    source: run.source,
    opaque: [],
    properties: cloneRunProperties(run.properties),
    text: substringByCodePoints(run.text, offset, Array.from(run.text).length),
  };
  return [head, tail];
}

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

/** 按 id 删除一个行内换行节点。找不到即抛（不静默无操作，R112）。 */
export function removeInlineBreak(paragraph: ParagraphNode, breakId: NodeId): ParagraphNode {
  const found = findBreak(paragraph, breakId);
  if (found === null) {
    throw new DocumentModelError(
      'unknown_node',
      `段落 ${JSON.stringify(paragraph.id)} 里没有换行节点 ${JSON.stringify(breakId)}`,
    );
  }
  return { ...paragraph, inlines: paragraph.inlines.filter((inline) => inline.id !== breakId) };
}

/** 删除段落里所有指定类型的换行节点（"清掉这一段里的分页符"）。返回新段落与删除个数。 */
export function removeBreaksOfType(
  paragraph: ParagraphNode,
  breakType: BreakType,
): { readonly paragraph: ParagraphNode; readonly removed: number } {
  const before = paragraph.inlines.length;
  const inlines = paragraph.inlines.filter(
    (inline) => !(inline.kind === 'break' && inline.breakType === breakType),
  );
  return { paragraph: { ...paragraph, inlines }, removed: before - inlines.length };
}

// ---------------------------------------------------------------------------
// 模型级入口（按块 id 定位）
// ---------------------------------------------------------------------------

function requireParagraph(model: DocumentModel, blockId: NodeId): { readonly paragraph: ParagraphNode; readonly index: number } {
  const location = findBlockLocation(model, blockId);
  if (location === null) {
    throw new DocumentModelError('unknown_node', `找不到块 ${JSON.stringify(blockId)}`);
  }
  if (location.block.kind !== 'paragraph') {
    throw new DocumentModelError(
      'unsupported',
      `${JSON.stringify(blockId)} 是表格，不是段落——分页符/分栏符只能插在段落里（WF-048）`,
    );
  }
  return { paragraph: location.block, index: location.index };
}

/** 在段落块内插入分页符。 */
export function insertPageBreakInBlock(
  model: DocumentModel,
  blockId: NodeId,
  offset: number,
  allocateId: () => NodeId,
): DocumentModel {
  const { paragraph } = requireParagraph(model, blockId);
  return replaceBlockInModel(model, blockId, insertPageBreak(paragraph, offset, allocateId));
}

/**
 * 在段落块内插入分栏符。
 *
 * **作用范围检查**：分栏符只在**多栏节**里才有意义。若该块所属的节**已明确**设置为
 * 单栏（`columns = 1`）则拒绝（R140：不支持的能力操作前拒绝，被拒时文档不变）。
 * 节里栏数**未指定**时不拒绝——"没设过"不等于"一定是单栏"，此时无法证明用户错了。
 */
export function insertColumnBreakInBlock(
  model: DocumentModel,
  blockId: NodeId,
  offset: number,
  allocateId: () => NodeId,
): DocumentModel {
  const { paragraph } = requireParagraph(model, blockId);
  const sectionIndex = sectionIndexOfBlock(model, blockId);
  if (sectionIndex !== null) {
    const layout = columnLayoutOf(model, sectionIndex);
    if (layout !== null && columnCountOf(layout) < 2) {
      throw new DocumentModelError(
        'unsupported',
        `分栏符只在多栏节里有意义：第 ${String(sectionIndex)} 节是单栏` +
          '（WF-050）。要分栏请先设置栏数；本次操作未改动文档。',
      );
    }
  }
  return replaceBlockInModel(model, blockId, insertColumnBreak(paragraph, offset, allocateId));
}

/** 删除段落块内的一个换行节点。 */
export function removeBreakInBlock(
  model: DocumentModel,
  blockId: NodeId,
  breakId: NodeId,
): DocumentModel {
  const { paragraph } = requireParagraph(model, blockId);
  return replaceBlockInModel(model, blockId, removeInlineBreak(paragraph, breakId));
}

/** 清掉段落块里某一类换行节点。 */
export function removeBreaksInBlock(
  model: DocumentModel,
  blockId: NodeId,
  breakType: BreakType,
): DocumentModel {
  const { paragraph } = requireParagraph(model, blockId);
  return replaceBlockInModel(model, blockId, removeBreaksOfType(paragraph, breakType).paragraph);
}


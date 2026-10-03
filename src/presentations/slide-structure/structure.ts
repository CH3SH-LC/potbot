/**
 * 幻灯片**结构快照与差异**（PPT-02：「页序 / 节 / 引用不乱」的可复核判据）。
 *
 * ## 为什么单列一个模块
 *
 * `slide-ops.ts` 提供"改"（增/删/复制/移动/隐藏/分节/版式），本模块提供"看改了什么"：
 * 把一份演示稿（对象模型或导入包）的**结构事实**——页序、节成员、每页引用的版式、
 * 页→部件绑定——抽成纯数据快照，并给出两次快照之间的**具名差异**。
 *
 * 这是 OfficePlugin 契约里 `inspect` 与 `receipt.changedObjects` 的落点：
 * 变更前后各取一次快照，`compareStructure` 直接回答"页序动了吗""哪个节改了""引用了哪页"，
 * 而不是让消费者去比对整包字节。
 *
 * ## 两套入口，一套形状
 *
 * - `snapshotPresentationStructure`：对象模型（`Presentation`）。
 * - `snapshotDeckStructure`：导入包（`EditableDeck`）。
 *
 * 两者返回同一个 `SlideStructureSnapshot`，因此 `compareStructure` 只写一次。
 * `page_number` 一律从**当前顺序现算**（模型层根本没有页码字段）。
 *
 * ## 集成批（P-I09）补的三件
 *
 * 1. **整组套版式**（`applyDeckLayoutForSlides` / `applyDeckLayoutForPageRange`）：把对象模型层
 *    早就有的 `setLayoutForSlides` 补到**导入包**层——一次给一批页 / 一个页范围套同一版式，
 *    只改这些页 `_rels` 里的 slideLayout 关系，其余页与部件**逐字节不变**。
 * 2. **连页移节**（`relocateDeckSectionWithPages`）：不仅移动分节声明顺序，还把该节成员页
 *    作为一个**连续块**搬到目标位置；非成员页的相对顺序不受扰动（`page_order_changed` /
 *    `pages_moved` 均按稳定 `slide_id` 记账）。为此 `SectionDelta` 新增 `order_changed` / `moved`。
 * 3. **可序列化的变更投影**（`slideStructureJson` / `structureChangedObjects` /
 *    `inspectSlideStructure`）：把快照与差异折成**纯数据**形状，直接喂给 OfficePlugin 的
 *    `inspect` 与 `receipt.changedObjects`（P10 的落地请求）。
 *
 * > 命名说明：`../slide-ops.js` 也提供同主题的 `setDeckLayoutForSlides`（按页号列表套版式）
 * > 与 `moveDeckSectionWithPages(deck, sectionId, toPage)`（把页块搬到某页码、**不改**分节声明
 * > 顺序）。本模块的两个操作名刻意不同（`applyDeckLayoutFor*` / `relocateDeckSectionWithPages`），
 * > 一是避免整个 `src/presentations` 桶里出现同名导出，二是本模块的连页移节是**按分节序号**
 * > 落位的变体（同时改分节声明顺序）。两者语义相邻，最终归并到哪一处由线协调者裁决。
 */

import type { Presentation } from '../model.js';
import {
  DeckEditError,
  deckSections,
  deckSlideLayoutPath,
  deckSlides,
  moveDeckSection,
  moveDeckSlide,
  setDeckSlideLayout,
  type EditableDeck,
} from '../slide-ops.js';

// ---------------------------------------------------------------------------
// 快照
// ---------------------------------------------------------------------------

/** 一页的结构事实。 */
export interface SlideStructureEntry {
  /** 对象引用，不随页序漂移。 */
  readonly slide_id: number;
  /** 1 起页码（由当前顺序现算）。 */
  readonly page_number: number;
  /** 页部件路径（模型层用 `slide<page_number>` 约定命名；导入包用真实部件路径）。 */
  readonly part_path: string;
  /** 该页引用的版式：模型层是 `master_id/layout_id`，导入包是版式部件路径。 */
  readonly layout_ref: string;
}

/** 一节的结构事实（成员已按页序）。 */
export interface SectionStructureEntry {
  readonly section_id: string;
  readonly name: string;
  readonly slide_ids: readonly number[];
}

/**
 * 一份演示稿的**结构快照**（纯数据，可比较、可序列化）。
 *
 * `pages` 按页序排列；`sections` 按声明顺序排列。
 */
export interface SlideStructureSnapshot {
  /** `pages[i].page_number === i + 1` 恒成立——快照自带这条不变量。 */
  readonly pages: readonly SlideStructureEntry[];
  readonly sections: readonly SectionStructureEntry[];
}

/** 对象模型的页部件路径约定（与 `render.ts` 的 `ppt/slides/slideN.xml` 一致）。 */
function modelSlidePartPath(pageNumber: number): string {
  return `ppt/slides/slide${String(pageNumber)}.xml`;
}

/** 取对象模型的结构快照。 */
export function snapshotPresentationStructure(presentation: Presentation): SlideStructureSnapshot {
  const pages: SlideStructureEntry[] = presentation.slides.map((slide, index) => ({
    slide_id: slide.slide_id,
    page_number: index + 1,
    part_path: modelSlidePartPath(index + 1),
    layout_ref: `${slide.layout.master_id}/${slide.layout.layout_id}`,
  }));
  const sections: SectionStructureEntry[] = presentation.sections.map((section) => ({
    section_id: section.section_id,
    name: section.name,
    slide_ids: [...section.slide_ids],
  }));
  return { pages, sections };
}

/** 取导入包的结构快照。 */
export function snapshotDeckStructure(deck: EditableDeck): SlideStructureSnapshot {
  const slides = deckSlides(deck);
  const pages: SlideStructureEntry[] = slides.map((slide, index) => {
    const layout = deckSlideLayoutPath(deck, index + 1);
    return {
      slide_id: slide.slide_id,
      page_number: index + 1,
      part_path: slide.part_path,
      layout_ref: layout ?? '',
    };
  });
  const sections: SectionStructureEntry[] = deckSections(deck).map((section) => ({
    section_id: section.section_id,
    name: section.name,
    slide_ids: [...section.slide_ids],
  }));
  return { pages, sections };
}

// ---------------------------------------------------------------------------
// 差异
// ---------------------------------------------------------------------------

/** 页序变化：某页从 `from_page` 到了 `to_page`（两页都在，只是位置变了）。 */
export interface PageMove {
  readonly slide_id: number;
  readonly from_page: number;
  readonly to_page: number;
}

/** 引用变化：某页的某个引用字段从 `from` 变成 `to`。 */
export interface ReferenceChange {
  readonly slide_id: number;
  readonly field: 'layout';
  readonly from: string;
  readonly to: string;
}

/** 分节在声明序列里的位置变化（`move_section` / `move_section_with_pages` 的判据）。 */
export interface SectionMove {
  readonly section_id: string;
  readonly from_index: number;
  readonly to_index: number;
}

/** 分节差异。 */
export interface SectionDelta {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly renamed: readonly { readonly section_id: string; readonly from: string; readonly to: string }[];
  readonly membership_changed: readonly {
    readonly section_id: string;
    readonly from: readonly number[];
    readonly to: readonly number[];
  }[];
  /** 分节**声明顺序**是否变化（只看现有分节的相对次序，不看增删）。 */
  readonly order_changed: boolean;
  /** 位置变化的分节（按 `after` 顺序）。 */
  readonly moved: readonly SectionMove[];
}

/** 两份结构快照之间的差异（**只报差异**，全等即全部为空/`false`）。 */
export interface StructureDelta {
  readonly page_order_changed: boolean;
  readonly pages_inserted: readonly number[];
  readonly pages_deleted: readonly number[];
  readonly pages_moved: readonly PageMove[];
  readonly references_changed: readonly ReferenceChange[];
  readonly sections: SectionDelta;
}

function indexBySlideId(snapshot: SlideStructureSnapshot): Map<number, SlideStructureEntry> {
  return new Map(snapshot.pages.map((page) => [page.slide_id, page] as const));
}

function sectionsEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * 比较两份结构快照。
 *
 * 页序变化 = 两边的 `slide_id` 序列**不完全相同**（插入/删除/移动都算）。
 * 移动 = 一页在两边都存在，但页码不同——**按 `slide_id` 对齐**，所以删掉中间页导致
 * 后面的页"页码变了"会被正确报成移动，而不会被误算成"内容变了"。
 */
export function compareStructure(
  before: SlideStructureSnapshot,
  after: SlideStructureSnapshot,
): StructureDelta {
  const beforeIds = before.pages.map((page) => page.slide_id);
  const afterIds = after.pages.map((page) => page.slide_id);
  const orderChanged =
    beforeIds.length !== afterIds.length || beforeIds.some((id, index) => id !== afterIds[index]);

  const beforeSet = new Set(beforeIds);
  const afterSet = new Set(afterIds);
  const pagesDeleted = beforeIds.filter((id) => !afterSet.has(id));
  const pagesInserted = afterIds.filter((id) => !beforeSet.has(id));

  const beforeBySlide = indexBySlideId(before);
  const pagesMoved: PageMove[] = [];
  for (const page of after.pages) {
    const previous = beforeBySlide.get(page.slide_id);
    if (previous !== undefined && previous.page_number !== page.page_number) {
      pagesMoved.push({ slide_id: page.slide_id, from_page: previous.page_number, to_page: page.page_number });
    }
  }

  const referencesChanged: ReferenceChange[] = [];
  for (const page of after.pages) {
    const previous = beforeBySlide.get(page.slide_id);
    if (previous !== undefined && previous.layout_ref !== page.layout_ref) {
      referencesChanged.push({
        slide_id: page.slide_id,
        field: 'layout',
        from: previous.layout_ref,
        to: page.layout_ref,
      });
    }
  }

  return {
    page_order_changed: orderChanged,
    pages_inserted: pagesInserted,
    pages_deleted: pagesDeleted,
    pages_moved: pagesMoved,
    references_changed: referencesChanged,
    sections: compareSections(before.sections, after.sections),
  };
}

function compareSections(
  before: readonly SectionStructureEntry[],
  after: readonly SectionStructureEntry[],
): SectionDelta {
  const beforeById = new Map(before.map((section) => [section.section_id, section] as const));
  const afterById = new Map(after.map((section) => [section.section_id, section] as const));

  const added = after.filter((section) => !beforeById.has(section.section_id)).map((section) => section.section_id);
  const removed = before.filter((section) => !afterById.has(section.section_id)).map((section) => section.section_id);

  const renamed: SectionDelta['renamed'][number][] = [];
  const membershipChanged: SectionDelta['membership_changed'][number][] = [];
  for (const section of after) {
    const previous = beforeById.get(section.section_id);
    if (previous === undefined) continue;
    if (previous.name !== section.name) {
      renamed.push({ section_id: section.section_id, from: previous.name, to: section.name });
    }
    if (!sectionsEqual(previous.slide_ids, section.slide_ids)) {
      membershipChanged.push({
        section_id: section.section_id,
        from: previous.slide_ids,
        to: section.slide_ids,
      });
    }
  }

  // 顺序变化只看**两边都存在**的分节的相对次序：这样"新增/删除一个分节"不会把
  // 其余分节误报成移动，只有真正的重排才会。
  const beforeCommon = before.filter((section) => afterById.has(section.section_id)).map((section) => section.section_id);
  const afterCommon = after.filter((section) => beforeById.has(section.section_id)).map((section) => section.section_id);
  const orderChanged =
    beforeCommon.length !== afterCommon.length ||
    beforeCommon.some((id, index) => id !== afterCommon[index]);

  const moved: SectionMove[] = [];
  afterCommon.forEach((id, toIndex) => {
    const fromIndex = beforeCommon.indexOf(id);
    if (fromIndex >= 0 && fromIndex !== toIndex) {
      moved.push({ section_id: id, from_index: fromIndex, to_index: toIndex });
    }
  });

  return { added, removed, renamed, membership_changed: membershipChanged, order_changed: orderChanged, moved };
}

/** `delta` 是否**什么都没变**（页序/引用/分节全等）。 */
export function isStructureUnchanged(delta: StructureDelta): boolean {
  return (
    !delta.page_order_changed &&
    delta.pages_inserted.length === 0 &&
    delta.pages_deleted.length === 0 &&
    delta.pages_moved.length === 0 &&
    delta.references_changed.length === 0 &&
    delta.sections.added.length === 0 &&
    delta.sections.removed.length === 0 &&
    delta.sections.renamed.length === 0 &&
    delta.sections.membership_changed.length === 0 &&
    !delta.sections.order_changed &&
    delta.sections.moved.length === 0
  );
}

// ---------------------------------------------------------------------------
// 整组套版式（对象模型 `setLayoutForSlides` 在导入包上的对应实现）
// ---------------------------------------------------------------------------

/**
 * 给**一批页**套同一个版式（一次调用 = 一个"整组套版式"操作）。
 *
 * 逐页走 `setDeckSlideLayout`，因此只改**这些页** `_rels` 里的 slideLayout 关系 Target：
 * 页序 / 分节 / 其它页 / 其它部件一律不动（`withDeckPart` 只替换目标部件，未触发的部件
 * 按引用保留，序列化后逐字节相同）。
 *
 * 页码先**去重再升序**，重复传入同一页不会重复改写、也不依赖调用方给的次序。
 * 空集合 = 原样返回。目标版式不在包内或页码越界 ⇒ 具名报错（原包不被改动）。
 */
export function applyDeckLayoutForSlides(
  deck: EditableDeck,
  pageNumbers: readonly number[],
  layoutPartPath: string,
): EditableDeck {
  const count = deckSlides(deck).length;
  const pages = [...new Set(pageNumbers)].sort((a, b) => a - b);
  for (const page of pages) {
    if (!Number.isInteger(page) || page < 1 || page > count) {
      throw new DeckEditError('invalid_page_number', `页码 ${String(page)} 超出 1..${String(count)}`);
    }
  }
  let next = deck;
  for (const page of pages) {
    next = setDeckSlideLayout(next, page, layoutPartPath);
  }
  return next;
}

/** 给一个**闭区间**页码 `from..to`（含两端）套同一版式。 */
export function applyDeckLayoutForPageRange(
  deck: EditableDeck,
  fromPage: number,
  toPage: number,
  layoutPartPath: string,
): EditableDeck {
  const count = deckSlides(deck).length;
  if (
    !Number.isInteger(fromPage) ||
    !Number.isInteger(toPage) ||
    fromPage < 1 ||
    toPage > count ||
    fromPage > toPage
  ) {
    throw new DeckEditError(
      'invalid_page_number',
      `页范围 ${String(fromPage)}..${String(toPage)} 非法（有效 1..${String(count)} 且起点不晚于终点）`,
    );
  }
  const pages: number[] = [];
  for (let page = fromPage; page <= toPage; page += 1) pages.push(page);
  return applyDeckLayoutForSlides(deck, pages, layoutPartPath);
}

// ---------------------------------------------------------------------------
// 连页移节（"move section with its pages"）
// ---------------------------------------------------------------------------

/**
 * 把分节移到分节序列的 `toIndex`，并**把该节成员页作为连续块一并搬过去**。
 *
 * 语义（可复核，见 `tests/.../P-I09`）：
 * - 成员页之间的**相对顺序不变**（原样"end 到 end"搬运）；
 * - **非成员页的相对顺序不受扰动**（先按原页序取出非成员页，块插回它的目标空档 G）；
 * - 空档 G = 目标位置**之前最近的、非空的那个分节**的最后一页之后（没有则为最前）；
 * - 分节**声明顺序**同时改为 `toIndex`。
 *
 * 因为两侧的相对顺序都保留，块整体落位后 `compareStructure` 会如实报出
 * `page_order_changed=true` 与按稳定 `slide_id` 记账的 `pages_moved`。
 * 空分节没有页可搬，退化为纯 `moveDeckSection`。
 */
export function relocateDeckSectionWithPages(deck: EditableDeck, sectionId: string, toIndex: number): EditableDeck {
  const sections = deckSections(deck);
  const fromIndex = sections.findIndex((section) => section.section_id === sectionId);
  if (fromIndex < 0) {
    throw new DeckEditError('unknown_section', `找不到分节 section_id=${sectionId}`);
  }
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= sections.length) {
    throw new DeckEditError(
      'invalid_section_order',
      `分节目标位置 ${String(toIndex)} 超出 0..${String(sections.length - 1)}`,
    );
  }

  const memberIds = sections[fromIndex]!.slide_ids;
  if (memberIds.length === 0) {
    return moveDeckSection(deck, sectionId, toIndex);
  }

  // 目标分节序列（仅声明顺序变化）。
  const reordered = [...sections];
  const [moved] = reordered.splice(fromIndex, 1);
  if (moved === undefined) {
    throw new DeckEditError('unknown_section', `找不到分节 section_id=${sectionId}`);
  }
  reordered.splice(toIndex, 0, moved);

  // 目标空档 G：目标位置之前最近的非空分节的最后一页。
  const pageOrder = deckSlides(deck).map((ref) => ref.slide_id);
  const pageIndex = new Map(pageOrder.map((id, index) => [id, index] as const));
  const memberSet = new Set(memberIds);
  const rest = pageOrder.filter((id) => !memberSet.has(id));

  let anchorId: number | null = null;
  for (let i = toIndex - 1; i >= 0; i -= 1) {
    const predecessor = reordered[i];
    if (predecessor === undefined) continue;
    const members = predecessor.slide_ids.filter((id) => !memberSet.has(id) && pageIndex.has(id));
    if (members.length > 0) {
      anchorId = members.reduce((best, id) =>
        (pageIndex.get(id) ?? -1) > (pageIndex.get(best) ?? -1) ? id : best,
      );
      break;
    }
  }

  let gap = 0;
  if (anchorId !== null) {
    const anchorIndex = pageIndex.get(anchorId) ?? -1;
    gap = rest.filter((id) => (pageIndex.get(id) ?? -1) <= anchorIndex).length;
  }

  const finalOrder = [...rest.slice(0, gap), ...memberIds, ...rest.slice(gap)];

  // 从左到右把目标序列摆好：每步把 `finalOrder[i]` 移到位置 i。位置 < i 已就位，
  // 移动只会影响 >= i 的项，故不破坏已确定的左前缀。用本地 `order` 模拟 splice，
  // 避免每次都重新解析包（只在真正需要移动时才调用 `moveDeckSlide`）。
  let next = deck;
  const order = [...pageOrder];
  for (let finalIndex = 0; finalIndex < finalOrder.length; finalIndex += 1) {
    const id = finalOrder[finalIndex];
    if (id === undefined) continue;
    const currentIndex = order.indexOf(id);
    if (currentIndex < 0 || currentIndex === finalIndex) continue;
    order.splice(currentIndex, 1);
    order.splice(finalIndex, 0, id);
    next = moveDeckSlide(next, currentIndex + 1, finalIndex + 1);
  }

  // 声明顺序最后调（`moveDeckSlide` 只按页序重排各节成员，不改分节顺序）。
  return moveDeckSection(next, sectionId, toIndex);
}

// ---------------------------------------------------------------------------
// 可序列化投影（OfficePlugin inspect / receipt.changedObjects 的落点）
// ---------------------------------------------------------------------------

/** 快照的 JSON 稳定形状（纯数据，可直接 `JSON.stringify`；与 `SlideStructureSnapshot` 同构）。 */
export interface SlideStructureJson {
  readonly pages: readonly {
    readonly slide_id: number;
    readonly page_number: number;
    readonly part_path: string;
    readonly layout_ref: string;
  }[];
  readonly sections: readonly {
    readonly section_id: string;
    readonly name: string;
    readonly slide_ids: readonly number[];
  }[];
}

/** 把结构快照折成普通（可序列化）对象——**新对象**，不共享内部引用。 */
export function slideStructureJson(snapshot: SlideStructureSnapshot): SlideStructureJson {
  return {
    pages: snapshot.pages.map((page) => ({
      slide_id: page.slide_id,
      page_number: page.page_number,
      part_path: page.part_path,
      layout_ref: page.layout_ref,
    })),
    sections: snapshot.sections.map((section) => ({
      section_id: section.section_id,
      name: section.name,
      slide_ids: [...section.slide_ids],
    })),
  };
}

/** 变更对象类型（对应契约 `ChangedObject.objectType` 里本模块能产出的子集）。 */
export type StructureObjectType = 'slide' | 'section';

/** 变更类型（对应契约 `ChangedObject.changeType`）。 */
export type StructureChangeType = 'insert' | 'update' | 'delete' | 'move';

/**
 * 一个**已变更对象**的普通投影（对应契约 `ChangedObject`：`objectId` / `objectType` / `changeType`）。
 *
 * `objectId` 用**稳定对象引用**（`slide:<slide_id>` / `section:<section_id>`），不随页序漂移；
 * `fields` 列出这次变动涉及的结构字段，供上层展示"哪里变了"。
 */
export interface StructureChangedObject {
  readonly objectId: string;
  readonly objectType: StructureObjectType;
  readonly changeType: StructureChangeType;
  readonly fields: readonly string[];
}

function slideChangeObject(
  slideId: number,
  changeType: StructureChangeType,
  fields: readonly string[],
): StructureChangedObject {
  return Object.freeze({
    objectId: `slide:${String(slideId)}`,
    objectType: 'slide',
    changeType,
    fields: Object.freeze([...fields]),
  });
}

function sectionChangeObject(
  sectionId: string,
  changeType: StructureChangeType,
  fields: readonly string[],
): StructureChangedObject {
  return Object.freeze({
    objectId: `section:${sectionId}`,
    objectType: 'section',
    changeType,
    fields: Object.freeze([...fields]),
  });
}

/**
 * 把 `compareStructure` 的差异折成**可序列化的变更对象清单**（`receipt.changedObjects` 的落点）。
 *
 * 页的插/删/移/换版式分别记 `insert` / `delete` / `move` / `update`，分节的增删改名、
 * 成员变化、顺序变化同样记账。顺序**稳定**：先页后节。无改动 ⇒ 空数组。
 */
export function structureChangedObjects(delta: StructureDelta): readonly StructureChangedObject[] {
  const changed: StructureChangedObject[] = [];
  for (const slideId of delta.pages_inserted) changed.push(slideChangeObject(slideId, 'insert', ['page_order']));
  for (const slideId of delta.pages_deleted) changed.push(slideChangeObject(slideId, 'delete', ['page_order']));
  for (const move of delta.pages_moved) changed.push(slideChangeObject(move.slide_id, 'move', ['page_number']));
  for (const reference of delta.references_changed) changed.push(slideChangeObject(reference.slide_id, 'update', [reference.field]));
  for (const sectionId of delta.sections.added) changed.push(sectionChangeObject(sectionId, 'insert', ['members']));
  for (const sectionId of delta.sections.removed) changed.push(sectionChangeObject(sectionId, 'delete', ['members']));
  for (const rename of delta.sections.renamed) changed.push(sectionChangeObject(rename.section_id, 'update', ['name']));
  for (const change of delta.sections.membership_changed) {
    changed.push(sectionChangeObject(change.section_id, 'update', ['slide_ids']));
  }
  for (const move of delta.sections.moved) changed.push(sectionChangeObject(move.section_id, 'move', ['order']));
  return Object.freeze(changed);
}

/**
 * `inspect` 的落点：变更后快照（普通形状）+ 差异 + 变更对象清单 + 是否无改动。
 *
 * 全部字段都是纯数据，可直接回给 OfficePlugin / 内核，无需再加工。
 */
export interface SlideStructureInspection {
  readonly snapshot: SlideStructureJson;
  readonly delta: StructureDelta;
  readonly changedObjects: readonly StructureChangedObject[];
  readonly unchanged: boolean;
}

/** 取两次快照之间的 `inspect` 结果（`before` → `after`）。 */
export function inspectSlideStructure(
  before: SlideStructureSnapshot,
  after: SlideStructureSnapshot,
): SlideStructureInspection {
  const delta = compareStructure(before, after);
  return {
    snapshot: slideStructureJson(after),
    delta,
    changedObjects: structureChangedObjects(delta),
    unchanged: isStructureUnchanged(delta),
  };
}

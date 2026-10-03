/**
 * 演示域**幻灯片操作**（PPT-02：新增 / 删除 / 复制 / 移动 / 隐藏、分节、版式切换）。
 *
 * ## 与 `operations.ts` 的分工
 *
 * `operations.ts` 给的是**最小原语**（`addSlide` / `removeSlide` / `duplicateSlide` /
 * `moveSlide` / `setSlideHidden` / `setSlideLayout`）。本模块在**不改动**那些原语的前提下，
 * 补上 PPT-02 真正需要、而原语里没有的两类语义：
 *
 * 1. **分节**（`Section`）——模型里有 `Presentation.sections`，但原语里**没有**任何创建 / 改名 /
 *    删除 / 归位 / 排序分节的操作；本模块补齐，并保证分节内的 `slide_ids` **始终按页序**。
 * 2. **页码 vs. 对象引用**——这是 PPT-02「对象引用与页码正确」的落点：
 *    `slide_id` 是**不随页序变化**的对象引用，页码是**位置**。删掉第 2 页之后，
 *    原 `slide_id=3` 的那页**变成第 2 页**，但它的 `slide_id` 仍然是 3。
 *    把两者混为一谈（拿 `slide_id` 当页码，或拿页码当 `slide_id`）就会错位——见 `pageNumberOf`。
 *
 * ## 页码是**算出来的**，不是存的
 *
 * 模型里**没有** `page_number` 字段（那会立刻和 `slides` 数组顺序失同步）。页码一律由
 * `pageNumberOf` / `pageNumbersById` 从**当前数组顺序**现算，所以「删除后页码错位」在结构上
 * 不可能发生：根本不存在一个会过期的页码副本。
 *
 * ## 不可变
 *
 * 全部操作是纯函数（原语本身就是纯函数，本模块只做组合），返回新模型，不污染入参。
 *
 * ## 第二层：**导入文稿**的包级页结构操作（P02「导入文稿同样适用」）
 *
 * 本文件下半部分（`EditableDeck` 一族）处理的是另一件事：**对一份导入的 PPTX 文件**
 * 做增 / 删 / 复制 / 移动 / 隐藏与分节，并写回一份**结构合法**的可再打开文件。
 * 上面那套模型层操作解决不了这一层——`roundtrip.exportImportedPresentation` 一旦发现
 * 页集合变了就报 `slide_set_changed`（`import.ts` / `roundtrip.ts` 如实登记的"未封装"项）。
 * 包级层就是补上这一截，详见该节开头的说明。
 */

import { escapeAttribute, readZip, utf8Bytes, writeZip, type ContentTypeDefault } from '../artifacts/ooxml/index.js';
import { ValidationError } from '../protocol/index.js';

import {
  addSlide,
  duplicateSlide,
  moveSlide,
  removeSlide,
  setSlideHidden,
  setSlideLayout,
} from './operations.js';
// P-I03：包级页结构操作**不再**各自手写关系图 / 内容类型——写回交给唯一的装配器
// （P01 `assemblePresentationPackage`），本模块只负责算出"要增 / 删 / 改哪些部件"。
import { assemblePresentationPackage, openPresentationPackage, type PresentationPackage } from './import.js';
import type { LayoutRef, Presentation, Section, Slide } from './model.js';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 本模块的具名失败面（**不静默**：语义不成立一律抛错）。 */
export type SlideOperationErrorReason =
  | 'unknown_slide'
  | 'unknown_section'
  | 'duplicate_section_id'
  | 'empty_section_name'
  | 'invalid_page_number'
  | 'invalid_section_order';

/** 幻灯片操作在语义不成立时抛出的错误。 */
export class SlideOperationError extends ValidationError {
  readonly reason: SlideOperationErrorReason;

  constructor(reason: SlideOperationErrorReason, message: string) {
    super(message);
    this.name = 'SlideOperationError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 页码 / 对象引用（PPT-02「对象引用与页码正确」）
// ---------------------------------------------------------------------------

/** 定位结果：幻灯片引用（`slide_id`）、**1 起**页码、**0 起**索引。 */
export interface SlideLocation {
  readonly slide_id: number;
  readonly page_number: number;
  readonly page_index: number;
}

/** 一次解析出幻灯片的位置（`slide_id` 与页码是**两个不同的量**）。 */
export function locateSlide(presentation: Presentation, slideId: number): SlideLocation {
  const page_index = presentation.slides.findIndex((slide) => slide.slide_id === slideId);
  if (page_index < 0) {
    throw new SlideOperationError('unknown_slide', `找不到幻灯片 slide_id=${String(slideId)}`);
  }
  return { slide_id: slideId, page_number: page_index + 1, page_index };
}

/** 某页的**1 起页码**（PPT-10 页码用）。 */
export function pageNumberOf(presentation: Presentation, slideId: number): number {
  return locateSlide(presentation, slideId).page_number;
}

/** 某页的 **0 起索引**。 */
export function pageIndexOf(presentation: Presentation, slideId: number): number {
  return locateSlide(presentation, slideId).page_index;
}

/** 把 1 起页码解析成 `slide_id`。越界 ⇒ 报 `invalid_page_number`（不返回 `undefined`）。 */
export function slideIdAtPage(presentation: Presentation, pageNumber: number): number {
  const slide = presentation.slides[pageNumber - 1];
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || slide === undefined) {
    throw new SlideOperationError(
      'invalid_page_number',
      `页码 ${String(pageNumber)} 超出 1..${String(presentation.slides.length)}`,
    );
  }
  return slide.slide_id;
}

/** 全部页的「`slide_id` → 1 起页码」映射（按当前页序现算）。 */
export function pageNumbersById(presentation: Presentation): ReadonlyMap<number, number> {
  return new Map(presentation.slides.map((slide, index) => [slide.slide_id, index + 1] as const));
}

/** 当前页序（`slide_id` 数组，索引即页序）。 */
export function slideOrder(presentation: Presentation): readonly number[] {
  return presentation.slides.map((slide) => slide.slide_id);
}

// ---------------------------------------------------------------------------
// 增删复移（对 `operations.ts` 原语的薄封装，统一返回页码）
// ---------------------------------------------------------------------------

/** 在 `at`（1 起页码，缺省 = 追加到末尾）插入新页；返回新页的 `slide_id` 与页码。 */
export function insertSlide(
  presentation: Presentation,
  options?: { readonly at?: number; readonly layout?: LayoutRef; readonly slide_id?: number },
): { readonly presentation: Presentation; readonly slide_id: number; readonly page_number: number } {
  const at = options?.at;
  const index =
    at === undefined
      ? undefined
      : (() => {
          if (!Number.isInteger(at) || at < 1 || at > presentation.slides.length + 1) {
            throw new SlideOperationError(
              'invalid_page_number',
              `插入页码 ${String(at)} 超出 1..${String(presentation.slides.length + 1)}`,
            );
          }
          return at - 1;
        })();
  const result = addSlide(presentation, {
    ...(index === undefined ? {} : { at: index }),
    ...(options?.layout === undefined ? {} : { layout: options.layout }),
    ...(options?.slide_id === undefined ? {} : { slide_id: options.slide_id }),
  });
  return {
    presentation: result.presentation,
    slide_id: result.slide_id,
    page_number: pageNumberOf(result.presentation, result.slide_id),
  };
}

/**
 * 删除一页（PPT-02）。
 *
 * 除删掉这一页外，还会：① 把该页从**所有分节**里摘掉（原语已做，本函数再断言一次）；
 * ② 其余页的 `slide_id` **原样保留**（对象引用不因删除而漂移）。页码由数组位置现算，随之收紧。
 */
export function deleteSlide(presentation: Presentation, slideId: number): Presentation {
  locateSlide(presentation, slideId); // 不存在 ⇒ 具名报错
  const next = removeSlide(presentation, slideId);
  for (const section of next.sections) {
    if (section.slide_ids.includes(slideId)) {
      // removeSlide 理应对所有分节做过滤；万一没做，这里**不静默放过**。
      throw new SlideOperationError(
        'unknown_slide',
        `删除后分节 ${section.section_id} 仍残留已删页 slide_id=${String(slideId)}`,
      );
    }
  }
  return next;
}

/** 复制一页；`at`（1 起页码）缺省 = 紧跟原页之后。副本带**新的** `slide_id`。 */
export function copySlide(
  presentation: Presentation,
  slideId: number,
  options?: { readonly at?: number },
): { readonly presentation: Presentation; readonly slide_id: number; readonly page_number: number } {
  const duplicated = duplicateSlide(presentation, slideId);
  const newId = duplicated.slide_id;
  const at = options?.at;
  if (at === undefined) {
    return {
      presentation: duplicated.presentation,
      slide_id: newId,
      page_number: pageNumberOf(duplicated.presentation, newId),
    };
  }
  if (!Number.isInteger(at) || at < 1 || at > duplicated.presentation.slides.length) {
    throw new SlideOperationError(
      'invalid_page_number',
      `目标页码 ${String(at)} 超出 1..${String(duplicated.presentation.slides.length)}`,
    );
  }
  return { presentation: moveSlide(duplicated.presentation, newId, at - 1), slide_id: newId, page_number: at };
}

/** 把一页移动到 `toPage`（1 起页码）。 */
export function relocateSlide(presentation: Presentation, slideId: number, toPage: number): Presentation {
  const total = presentation.slides.length;
  if (!Number.isInteger(toPage) || toPage < 1 || toPage > total) {
    throw new SlideOperationError('invalid_page_number', `目标页码 ${String(toPage)} 超出 1..${String(total)}`);
  }
  return moveSlide(presentation, slideId, toPage - 1);
}

/** 隐藏一页（PPT-02）。 */
export function hideSlide(presentation: Presentation, slideId: number): Presentation {
  return setSlideHidden(presentation, slideId, true);
}

/** 取消隐藏一页（PPT-02）。 */
export function showSlide(presentation: Presentation, slideId: number): Presentation {
  return setSlideHidden(presentation, slideId, false);
}

/** 反转隐藏态（PPT-02）。 */
export function toggleSlideHidden(presentation: Presentation, slideId: number): Presentation {
  const slide = presentation.slides[locateSlide(presentation, slideId).page_index];
  if (slide === undefined) {
    throw new SlideOperationError('unknown_slide', `找不到幻灯片 slide_id=${String(slideId)}`);
  }
  return setSlideHidden(presentation, slideId, !slide.hidden);
}

/** 切换一页的版式（PPT-02 / PPT-03）。 */
export function switchSlideLayout(presentation: Presentation, slideId: number, layout: LayoutRef): Presentation {
  return setSlideLayout(presentation, slideId, layout);
}

/** 一批页的统一版式（PPT-02：整节套用同一版式）。 */
export function setLayoutForSlides(
  presentation: Presentation,
  slideIds: readonly number[],
  layout: LayoutRef,
): Presentation {
  let next = presentation;
  for (const slideId of slideIds) {
    next = setSlideLayout(next, slideId, layout);
  }
  return next;
}

// ---------------------------------------------------------------------------
// 分节（PPT-02）
// ---------------------------------------------------------------------------

function nextSectionId(presentation: Presentation): string {
  const used = new Set(presentation.sections.map((section) => section.section_id));
  let n = presentation.sections.length + 1;
  while (used.has(`section${String(n)}`)) {
    n += 1;
  }
  return `section${String(n)}`;
}

function requireSection(presentation: Presentation, sectionId: string): number {
  const index = presentation.sections.findIndex((section) => section.section_id === sectionId);
  if (index < 0) {
    throw new SlideOperationError('unknown_section', `找不到分节 section_id=${sectionId}`);
  }
  return index;
}

/** 按**当前页序**给一组 `slide_id` 排序（分节的 `slide_ids` 永远保持页序）。 */
function orderByPage(presentation: Presentation, slideIds: readonly number[]): readonly number[] {
  const rank = new Map(presentation.slides.map((slide, index) => [slide.slide_id, index] as const));
  return [...slideIds].sort((a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER));
}

/** 新建一个空分节；`at` 缺省 = 追加到末尾。 */
export function createSection(
  presentation: Presentation,
  name: string,
  options?: { readonly section_id?: string; readonly at?: number },
): { readonly presentation: Presentation; readonly section_id: string } {
  if (name.trim() === '') {
    throw new SlideOperationError('empty_section_name', '分节名不能为空');
  }
  const sectionId = options?.section_id ?? nextSectionId(presentation);
  if (presentation.sections.some((section) => section.section_id === sectionId)) {
    throw new SlideOperationError('duplicate_section_id', `section_id=${sectionId} 已存在`);
  }
  const at = options?.at ?? presentation.sections.length;
  if (!Number.isInteger(at) || at < 0 || at > presentation.sections.length) {
    throw new SlideOperationError('invalid_section_order', `分节插入位置 ${String(at)} 越界`);
  }
  const section: Section = { section_id: sectionId, name, slide_ids: [] };
  const sections = [...presentation.sections.slice(0, at), section, ...presentation.sections.slice(at)];
  return { presentation: { ...presentation, sections }, section_id: sectionId };
}

/** 分节改名。 */
export function renameSection(presentation: Presentation, sectionId: string, name: string): Presentation {
  if (name.trim() === '') {
    throw new SlideOperationError('empty_section_name', '分节名不能为空');
  }
  const index = requireSection(presentation, sectionId);
  const sections = presentation.sections.map((section, i) => (i === index ? { ...section, name } : section));
  return { ...presentation, sections };
}

/** 删除分节；**页保留**（只是不再属于任何分节）。 */
export function deleteSection(presentation: Presentation, sectionId: string): Presentation {
  requireSection(presentation, sectionId);
  return { ...presentation, sections: presentation.sections.filter((section) => section.section_id !== sectionId) };
}

/**
 * 把一页归入某分节（`sectionId = null` ⇒ 从所有分节里摘出）。
 *
 * 一页**至多**属于一个分节：先把它从全部分节里摘掉，再并入目标分节，并保持页序。
 */
export function assignSlideToSection(
  presentation: Presentation,
  slideId: number,
  sectionId: string | null,
): Presentation {
  locateSlide(presentation, slideId);
  if (sectionId !== null) {
    requireSection(presentation, sectionId);
  }
  const detached = presentation.sections.map((section) => ({
    ...section,
    slide_ids: section.slide_ids.filter((id) => id !== slideId),
  }));
  if (sectionId === null) {
    return { ...presentation, sections: detached };
  }
  const sections = detached.map((section) =>
    section.section_id === sectionId
      ? { ...section, slide_ids: orderByPage(presentation, [...section.slide_ids, slideId]) }
      : section,
  );
  return { ...presentation, sections };
}

/** 一次把多页归入同一分节（按页序落位）。 */
export function assignSlidesToSection(
  presentation: Presentation,
  slideIds: readonly number[],
  sectionId: string | null,
): Presentation {
  let next = presentation;
  for (const slideId of slideIds) {
    next = assignSlideToSection(next, slideId, sectionId);
  }
  return next;
}

/** 重排分节顺序；`sectionIds` 必须**恰好**是现有分节的一个排列（否则具名报错）。 */
export function reorderSections(presentation: Presentation, sectionIds: readonly string[]): Presentation {
  const current = presentation.sections.map((section) => section.section_id);
  if (sectionIds.length !== current.length || new Set(sectionIds).size !== sectionIds.length) {
    throw new SlideOperationError('invalid_section_order', '分节顺序必须恰好覆盖现有分节且不重复');
  }
  const byId = new Map(presentation.sections.map((section) => [section.section_id, section] as const));
  const sections: Section[] = [];
  for (const id of sectionIds) {
    const section = byId.get(id);
    if (section === undefined) {
      throw new SlideOperationError('invalid_section_order', `分节顺序里出现了不存在的 section_id=${id}`);
    }
    sections.push(section);
  }
  return { ...presentation, sections };
}

/** 某分节的页（按页序，已剔除已删页）。 */
export function slidesInSection(presentation: Presentation, sectionId: string): readonly number[] {
  const index = requireSection(presentation, sectionId);
  const section = presentation.sections[index];
  if (section === undefined) {
    throw new SlideOperationError('unknown_section', `找不到分节 section_id=${sectionId}`);
  }
  return orderByPage(presentation, section.slide_ids);
}

/** 某页所属分节；不属于任何分节 ⇒ `null`。 */
export function sectionOfSlide(presentation: Presentation, slideId: number): string | null {
  const section = presentation.sections.find((candidate) => candidate.slide_ids.includes(slideId));
  return section === undefined ? null : section.section_id;
}

/** 复述全部页（含隐藏态）与其页码——供上层/用例核对「页码不因删除/移动错位」。 */
export function outline(presentation: Presentation): readonly { readonly page_number: number; readonly slide: Slide }[] {
  return presentation.slides.map((slide, index) => ({ page_number: index + 1, slide }));
}

// ===========================================================================
// 导入文稿的**包级**页结构操作（P02：「导入文稿同样适用，页序 / 节 / 引用不乱」）
// ===========================================================================

/**
 * ## 本层与上面「模型层」的分工
 *
 * 上面的 `insertSlide` / `deleteSlide` / … 操作的是**对象模型**；模型层早就支持增删页，
 * 渲染层（`renderPresentation`）也支持——但**导入既有 PPTX 之后再动页结构**此前是断的：
 * `roundtrip.exportImportedPresentation` 一旦发现页集合变了就报 `slide_set_changed`
 * （见 `import.ts` / `roundtrip.ts` 里如实登记的"未封装该流程"）。
 *
 * 本层把那一截补上：直接在**包**上做页结构编辑——重写 `ppt/presentation.xml` 的
 * `p:sldIdLst` 与分节扩展、`ppt/_rels/presentation.xml.rels`、`[Content_Types].xml`，
 * 以及增删幻灯片 / 备注部件本身。未被操作触及的部件（母版、版式、主题、媒体、自定义 XML、
 * 厂商私有部件）**逐字节保留**——与 `import.ts` 的保留语义同一条线。
 *
 * 三条硬约束（本层存在的理由）：
 *
 * 1. **页序 = `p:sldIdLst` 顺序**：增 / 删 / 复制 / 移动只改这个列表的顺序与成员，
 *    每个 `p:sldId@r:id` 始终指向**内容正确**的那个幻灯片部件（不是"rId 整体顺移"）。
 * 2. **无悬挂关系**：删页连带删掉该页部件、它的 `_rels`、以及仅供它使用的备注部件；
 *    改完可用 `validateEditableDeck` 复核（每个内部关系目标都在包内）。
 * 3. **不静默丢弃既有节点**：备注 / 自定义放映 / 分节 / 其它扩展一律保留；若某次删除会让
 *    **自定义放映**悬空，本层**明确报错**（不偷偷改放映内容），而不是装作成功。
 *
 * 本层按**文本级扫描**读写那几个部件（与 `import.ts` 同一手法）：命名空间前缀被改写、
 * 或出现本层读不懂的结构时**报错**，不静默返回错页序。
 */

/** 包级页结构操作的失败原因（**具名**，供用例断言与上层分类）。 */
export type DeckEditErrorReason =
  | 'missing_presentation_part'
  | 'missing_presentation_rels'
  | 'missing_content_types'
  | 'missing_layout_part'
  | 'unresolved_slide_target'
  | 'dangling_relationship'
  | 'invalid_page_number'
  | 'unknown_slide'
  | 'unknown_section'
  | 'unknown_layout'
  | 'duplicate_section_id'
  | 'empty_section_name'
  | 'invalid_section_order'
  | 'custom_show_reference'
  | 'malformed_presentation_xml';

/** 包级页结构操作在语义不成立时抛出的错误（**不静默**）。 */
export class DeckEditError extends ValidationError {
  readonly reason: DeckEditErrorReason;

  constructor(reason: DeckEditErrorReason, message: string) {
    super(message);
    this.name = 'DeckEditError';
    this.reason = reason;
  }
}

const DECK_PRESENTATION_PART = 'ppt/presentation.xml';
const DECK_PRESENTATION_RELS_PART = 'ppt/_rels/presentation.xml.rels';
const DECK_CONTENT_TYPES_PART = '[Content_Types].xml';

const DECK_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DECK_REL_TYPE_SLIDE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const DECK_REL_TYPE_NOTES_SLIDE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';
const DECK_REL_TYPE_SLIDE_LAYOUT =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout';
const DECK_CT_SLIDE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const DECK_CT_NOTES_SLIDE =
  'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';

const DECK_NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const DECK_NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const DECK_NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** 分节扩展的固定 `p:ext@uri`（PowerPoint 2010 起的分节扩展）。 */
const DECK_SECTION_EXT_URI = '{521415D9-36F7-43E2-AB2F-B90AF26B5E84}';
const DECK_P14_NS = 'http://schemas.microsoft.com/office/powerpoint/2010/main';

const DECK_SLD_ID_LST_RE = /<p:sldIdLst\b[^>]*>[\s\S]*?<\/p:sldIdLst>/;
const DECK_SLD_ID_LST_EMPTY_RE = /<p:sldIdLst\b[^>]*\/>/;
const DECK_SECTION_LST_RE = /<([A-Za-z_][\w.-]*):sectionLst\b([^>]*)>([\s\S]*?)<\/\1:sectionLst>/;

// ---------------------------------------------------------------------------
// 包值对象与部件读写
// ---------------------------------------------------------------------------

/** 一个包内部件（路径 + 字节）。 */
export interface DeckPart {
  /** 包内路径（正斜杠分隔，无前导斜杠）。 */
  readonly path: string;
  readonly data: Uint8Array;
}

/**
 * 一份可做页结构编辑的导入文稿包。
 *
 * `parts` 的顺序 = 写回顺序；**未出现的新部件追加在末尾**（ZIP 条目顺序不承载语义）。
 * 除"本层显式重写的那几个部件"外，其余部件字节**原样**。
 */
export interface EditableDeck {
  readonly parts: readonly DeckPart[];
}

/** 一页在包里的引用三元组：`slide_id`（对象引用）、`r:id`（关系）、部件路径。 */
export interface DeckSlideRef {
  readonly page_number: number;
  readonly slide_id: number;
  readonly rel_id: string;
  readonly part_path: string;
}

/** 分节：`section_id` = `p14:section@id`；`slide_ids` 按**页序**。 */
export interface DeckSection {
  readonly section_id: string;
  readonly name: string;
  readonly slide_ids: readonly number[];
}

/** 打开一份既有 PPTX 供页结构编辑（不修改任何字节）。 */
export function openEditableDeck(bytes: Uint8Array): EditableDeck {
  const archive = readZip(bytes);
  if (!archive.by_path.has(DECK_PRESENTATION_PART)) {
    throw new DeckEditError('missing_presentation_part', '既有 PPTX 缺少部件 ppt/presentation.xml');
  }
  if (!archive.by_path.has(DECK_PRESENTATION_RELS_PART)) {
    throw new DeckEditError('missing_presentation_rels', '既有 PPTX 缺少部件 ppt/_rels/presentation.xml.rels');
  }
  return Object.freeze({
    parts: Object.freeze(
      archive.entries.map((entry) => Object.freeze({ path: entry.path, data: entry.data })),
    ),
  });
}

/** 把包写回成 ZIP 字节。 */
export function serializeEditableDeck(deck: EditableDeck): Buffer {
  return writeZip(deck.parts.map((part) => ({ path: part.path, data: part.data })));
}

function deckPartData(deck: EditableDeck, path: string): Uint8Array | undefined {
  for (const part of deck.parts) {
    if (part.path === path) return part.data;
  }
  return undefined;
}

function deckPartText(deck: EditableDeck, path: string): string | undefined {
  const data = deckPartData(deck, path);
  return data === undefined ? undefined : Buffer.from(data).toString('utf8');
}

function requireDeckPartText(deck: EditableDeck, path: string, reason: DeckEditErrorReason): string {
  const text = deckPartText(deck, path);
  if (text === undefined) {
    throw new DeckEditError(reason, `包内缺少部件 ${path}`);
  }
  return text;
}

/** 替换（就地保序）或追加一个部件。 */
function withDeckPart(deck: EditableDeck, path: string, data: Uint8Array): EditableDeck {
  let found = false;
  const parts = deck.parts.map((part) => {
    if (part.path !== path) return part;
    found = true;
    return { path, data };
  });
  if (!found) parts.push({ path, data });
  return Object.freeze({ parts: Object.freeze(parts) });
}

// ---------------------------------------------------------------------------
// 包内路径 / 关系小工具
// ---------------------------------------------------------------------------

function cutLastSlash(path: string): { readonly dir: string; readonly base: string } {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? { dir: '', base: path } : { dir: path.slice(0, cut), base: path.slice(cut + 1) };
}

/** 部件路径 → 其关系部件路径（`ppt/slides/slide1.xml` → `ppt/slides/_rels/slide1.xml.rels`）。 */
function relsPathOf(partPath: string): string {
  const { dir, base } = cutLastSlash(partPath);
  return dir === '' ? `_rels/${base}.rels` : `${dir}/_rels/${base}.rels`;
}

/** 部件路径 → 其所在目录。 */
function directoryOf(partPath: string): string {
  return cutLastSlash(partPath).dir;
}

/** 关系部件路径 → 其基目录（把相对 `Target` 解析成包内路径时的基准）。 */
function relsBaseDir(relsPath: string): string {
  if (relsPath === '_rels/.rels') return '';
  const cut = relsPath.lastIndexOf('/_rels/');
  return cut < 0 ? '' : relsPath.slice(0, cut);
}

/** 把相对 `Target` 规范化成包内路径。 */
function resolveDeckTargetFrom(baseDir: string, target: string): string {
  const combined = target.startsWith('/')
    ? target.replace(/^\/+/, '')
    : `${baseDir === '' ? '' : `${baseDir}/`}${target}`;
  const stack: string[] = [];
  for (const segment of combined.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join('/');
}

/** 求 `fromDir` 到 `toPath` 的相对路径（用于新部件之间的关系 Target）。 */
function relativeDeckTarget(fromDir: string, toPath: string): string {
  const fromParts = fromDir.split('/').filter((segment) => segment !== '');
  const toParts = toPath.split('/');
  let common = 0;
  while (common < fromParts.length && common < toParts.length - 1 && fromParts[common] === toParts[common]) {
    common += 1;
  }
  const up = fromParts.length - common;
  return `${'../'.repeat(up)}${toParts.slice(common).join('/')}`;
}

/** 一条关系（`raw` 保留源标签文本，重写清单时原样复用）。 */
interface DeckRel {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly external: boolean;
  readonly raw: string;
}

function readDeckRels(xml: string): readonly DeckRel[] {
  const rels: DeckRel[] = [];
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const raw = match[0] ?? '';
    const id = /\bId\s*=\s*"([^"]*)"/.exec(raw)?.[1];
    const type = /\bType\s*=\s*"([^"]*)"/.exec(raw)?.[1];
    const target = /\bTarget\s*=\s*"([^"]*)"/.exec(raw)?.[1];
    if (id === undefined || type === undefined || target === undefined) continue;
    rels.push({ id, type, target, external: /TargetMode\s*=\s*"External"/.test(raw), raw });
  }
  return rels;
}

function makeDeckRel(id: string, type: string, target: string): DeckRel {
  return {
    id,
    type,
    target,
    external: false,
    raw: `<Relationship Id="${id}" Type="${type}" Target="${escapeAttribute(target)}"/>`,
  };
}

/** 重写关系部件的清单（保留原根元素的命名空间声明与 XML 声明）。 */
function writeDeckRels(xml: string, rels: readonly DeckRel[]): string {
  const rootMatch = /<Relationships\b([^>]*)>/.exec(xml);
  if (rootMatch === null) {
    throw new DeckEditError('malformed_presentation_xml', '关系部件里没有 <Relationships> 根元素');
  }
  const attrs = rootMatch[1] ?? '';
  const body = rels.map((rel) => rel.raw).join('');
  return xml.replace(/<Relationships\b[\s\S]*?<\/Relationships>/, () => `<Relationships${attrs}>${body}</Relationships>`);
}

function nextDeckRelId(rels: readonly DeckRel[]): string {
  let max = 0;
  for (const rel of rels) {
    const match = /^rId(\d+)$/.exec(rel.id);
    if (match !== null) {
      max = Math.max(max, Number(match[1] ?? '0'));
    }
  }
  return `rId${String(max + 1)}`;
}

// ---------------------------------------------------------------------------
// `p:sldIdLst`（页序真相源）
// ---------------------------------------------------------------------------

interface DeckSldId {
  readonly id: number;
  readonly rel_id: string;
}

function readDeckSldIds(xml: string): readonly DeckSldId[] {
  const block = /<p:sldIdLst\b[^>]*>([\s\S]*?)<\/p:sldIdLst>/.exec(xml);
  if (block === null) return [];
  const entries: DeckSldId[] = [];
  for (const match of (block[1] ?? '').matchAll(/<p:sldId\b[^>]*\/?>/g)) {
    const tag = match[0] ?? '';
    const idRaw = /(?<![\w:])id\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    const relId = /\br:id\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    if (idRaw === undefined || relId === undefined || !/^[0-9]+$/.test(idRaw)) {
      throw new DeckEditError(
        'malformed_presentation_xml',
        `p:sldId 缺少 id / r:id，或 id 不是整数：${tag}`,
      );
    }
    entries.push({ id: Number(idRaw), rel_id: relId });
  }
  return entries;
}

function writeDeckSldIds(xml: string, entries: readonly DeckSldId[]): string {
  const inner = entries.map((entry) => `<p:sldId id="${String(entry.id)}" r:id="${entry.rel_id}"/>`).join('');
  const block = `<p:sldIdLst>${inner}</p:sldIdLst>`;
  if (DECK_SLD_ID_LST_RE.test(xml)) return xml.replace(DECK_SLD_ID_LST_RE, () => block);
  if (DECK_SLD_ID_LST_EMPTY_RE.test(xml)) return xml.replace(DECK_SLD_ID_LST_EMPTY_RE, () => block);
  throw new DeckEditError('malformed_presentation_xml', 'ppt/presentation.xml 里没有 p:sldIdLst');
}

// ---------------------------------------------------------------------------
// 分节（`p14:sectionLst`）
// ---------------------------------------------------------------------------

const DECK_XML_ENTITY_BY_NAME: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  amp: '&',
};

function decodeXmlEntities(text: string): string {
  return text.replace(/&(lt|gt|quot|apos|amp);/g, (match, name: string) => DECK_XML_ENTITY_BY_NAME[name] ?? match);
}

function readDeckSections(deck: EditableDeck): readonly DeckSection[] {
  const xml = requireDeckPartText(deck, DECK_PRESENTATION_PART, 'missing_presentation_part');
  const lst = DECK_SECTION_LST_RE.exec(xml);
  if (lst === null) return [];
  const prefix = lst[1] ?? 'p14';
  const body = lst[3] ?? '';
  const sectionRe = new RegExp(`<${prefix}:section\\b([^>]*)>([\\s\\S]*?)</${prefix}:section>`, 'g');
  const sections: DeckSection[] = [];
  for (const match of body.matchAll(sectionRe)) {
    const attrs = match[1] ?? '';
    const inner = match[2] ?? '';
    const name = /\bname\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
    const id = /(?<![\w:])id\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
    if (name === undefined || id === undefined) {
      throw new DeckEditError(
        'malformed_presentation_xml',
        `p14:section 缺少 name / id 属性：${(match[0] ?? '').slice(0, 120)}`,
      );
    }
    const slideIds: number[] = [];
    for (const sld of inner.matchAll(/<[A-Za-z_][\w.-]*:sldId\b[^>]*\/?>/g)) {
      const sldTag = sld[0] ?? '';
      const sid = /(?<![\w:])id\s*=\s*"([^"]*)"/.exec(sldTag)?.[1];
      if (sid === undefined || !/^[0-9]+$/.test(sid)) {
        throw new DeckEditError('malformed_presentation_xml', `分节内的 p14:sldId 缺少整数 id：${sldTag}`);
      }
      slideIds.push(Number(sid));
    }
    sections.push({ section_id: id, name: decodeXmlEntities(name), slide_ids: slideIds });
  }
  return sections;
}

function deckSectionLstXml(prefix: string, sections: readonly DeckSection[]): string {
  const body = sections
    .map(
      (section) =>
        `<${prefix}:section name="${escapeAttribute(section.name)}" id="${escapeAttribute(section.section_id)}">` +
        `<${prefix}:sldIdLst>${section.slide_ids.map((id) => `<${prefix}:sldId id="${String(id)}"/>`).join('')}</${prefix}:sldIdLst>` +
        `</${prefix}:section>`,
    )
    .join('');
  return `<${prefix}:sectionLst xmlns:${prefix}="${DECK_P14_NS}">${body}</${prefix}:sectionLst>`;
}

/**
 * 把分节写进 `ppt/presentation.xml` 的文本（纯文本变换，供装配器路径复用；
 * 既有扩展列表照旧保留，只**追加**我们的那一条，不覆盖别人的扩展）。
 */
function applyDeckSections(xml: string, sections: readonly DeckSection[]): string {
  const lst = DECK_SECTION_LST_RE.exec(xml);
  if (lst !== null) {
    const prefix = lst[1] ?? 'p14';
    const block = deckSectionLstXml(prefix, sections);
    return xml.replace(
      new RegExp(`<${prefix}:sectionLst\\b[^>]*>[\\s\\S]*?</${prefix}:sectionLst>`),
      () => block,
    );
  }
  if (sections.length === 0) return xml;
  const ext = `<p:ext uri="${DECK_SECTION_EXT_URI}">${deckSectionLstXml('p14', sections)}</p:ext>`;
  if (/<p:extLst\b[^>]*>[\s\S]*?<\/p:extLst>/.test(xml)) {
    return xml.replace(/<\/p:extLst>/, () => `${ext}</p:extLst>`);
  }
  if (!/<\/p:presentation>/.test(xml)) {
    throw new DeckEditError('malformed_presentation_xml', 'ppt/presentation.xml 没有 </p:presentation> 收尾');
  }
  return xml.replace(/<\/p:presentation>/, () => `<p:extLst>${ext}</p:extLst></p:presentation>`);
}

function writeDeckSections(deck: EditableDeck, sections: readonly DeckSection[]): EditableDeck {
  const xml = requireDeckPartText(deck, DECK_PRESENTATION_PART, 'missing_presentation_part');
  return withDeckPart(deck, DECK_PRESENTATION_PART, utf8Bytes(applyDeckSections(xml, sections)));
}

// ---------------------------------------------------------------------------
// `[Content_Types].xml`（新增 / 删除部件登记）
// ---------------------------------------------------------------------------

function addDeckContentTypeOverride(deck: EditableDeck, partPath: string, contentType: string): EditableDeck {
  const text = deckPartText(deck, DECK_CONTENT_TYPES_PART);
  if (text === undefined) {
    throw new DeckEditError('missing_content_types', '包内没有 [Content_Types].xml，无法登记新部件的内容类型');
  }
  if (text.includes(`PartName="/${partPath}"`)) return deck;
  const next = text.replace(/<\/Types>/, () => `<Override PartName="/${partPath}" ContentType="${contentType}"/></Types>`);
  return withDeckPart(deck, DECK_CONTENT_TYPES_PART, utf8Bytes(next));
}

// ---------------------------------------------------------------------------
// 页 / 分节的现状读取
// ---------------------------------------------------------------------------

/** 当前页序与「页 → 部件」绑定（按 `p:sldIdLst` 顺序现算）。 */
export function deckSlides(deck: EditableDeck): readonly DeckSlideRef[] {
  const xml = requireDeckPartText(deck, DECK_PRESENTATION_PART, 'missing_presentation_part');
  const rels = readDeckRels(requireDeckPartText(deck, DECK_PRESENTATION_RELS_PART, 'missing_presentation_rels'));
  const byId = new Map(rels.map((rel) => [rel.id, rel] as const));
  const refs = readDeckSldIds(xml).map((entry, index) => {
    const rel = byId.get(entry.rel_id);
    if (rel === undefined || rel.external) {
      throw new DeckEditError(
        'unresolved_slide_target',
        `p:sldId@r:id=${entry.rel_id} 在 ppt/_rels/presentation.xml.rels 里没有内部关系`,
      );
    }
    const path = resolveDeckTargetFrom('ppt', rel.target);
    if (deckPartData(deck, path) === undefined) {
      throw new DeckEditError('unresolved_slide_target', `关系 ${entry.rel_id} 指向的部件 ${path} 不在包内`);
    }
    return Object.freeze({ page_number: index + 1, slide_id: entry.id, rel_id: entry.rel_id, part_path: path });
  });
  if (new Set(refs.map((ref) => ref.slide_id)).size !== refs.length) {
    throw new DeckEditError('malformed_presentation_xml', 'p:sldIdLst 里有重复的 slide_id');
  }
  return Object.freeze(refs);
}

/** 当前分节（按 `p14:sectionLst` 声明顺序）。 */
export function deckSections(deck: EditableDeck): readonly DeckSection[] {
  return Object.freeze(
    readDeckSections(deck).map((section) =>
      Object.freeze({ section_id: section.section_id, name: section.name, slide_ids: Object.freeze([...section.slide_ids]) }),
    ),
  );
}

function orderDeckSlideIds(deck: EditableDeck, slideIds: readonly number[]): readonly number[] {
  const rank = new Map(deckSlides(deck).map((ref) => [ref.slide_id, ref.page_number] as const));
  return [...slideIds].sort(
    (a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER),
  );
}

function assertDeckSlideIdsExist(deck: EditableDeck, slideIds: readonly number[], context: string): void {
  const known = new Set(deckSlides(deck).map((ref) => ref.slide_id));
  for (const id of slideIds) {
    if (!known.has(id)) {
      throw new DeckEditError('unknown_slide', `${context} 引用了不存在的 slide_id=${String(id)}`);
    }
  }
}

/** 自定义放映引用的幻灯片 `r:id`（无 `p:custShowLst` ⇒ 空）。 */
function customShowRelIds(xml: string): readonly string[] {
  const list = /<p:custShowLst\b[^>]*>([\s\S]*?)<\/p:custShowLst>/.exec(xml);
  if (list === null) return [];
  const ids: string[] = [];
  for (const match of (list[1] ?? '').matchAll(/<p:sld\b[^>]*\/?>/g)) {
    const relId = /\br:id\s*=\s*"([^"]*)"/.exec(match[0] ?? '')?.[1];
    if (relId !== undefined) ids.push(relId);
  }
  return ids;
}

/** 某页的备注部件路径；该页没有备注关系 ⇒ `null`。 */
function deckNotesPartOf(deck: EditableDeck, slidePartPath: string): string | null {
  const relsText = deckPartText(deck, relsPathOf(slidePartPath));
  if (relsText === undefined) return null;
  const baseDir = directoryOf(slidePartPath);
  for (const rel of readDeckRels(relsText)) {
    if (rel.external) continue;
    const path = resolveDeckTargetFrom(baseDir, rel.target);
    if (/\/notesSlides\/notesSlide[^/]*\.xml$/.test(path) && deckPartData(deck, path) !== undefined) {
      return path;
    }
  }
  return null;
}

/** 找一份可用作新页版式的部件路径（优先"既有页引用的版式"，退化到扫描 `ppt/slideLayouts/**`）。 */
function findDeckLayoutPart(deck: EditableDeck): string | undefined {
  for (const ref of deckSlides(deck)) {
    const relsText = deckPartText(deck, relsPathOf(ref.part_path));
    if (relsText === undefined) continue;
    const baseDir = directoryOf(ref.part_path);
    for (const rel of readDeckRels(relsText)) {
      if (rel.external) continue;
      const path = resolveDeckTargetFrom(baseDir, rel.target);
      if (/\/slideLayouts\/slideLayout[^/]*\.xml$/.test(path) && deckPartData(deck, path) !== undefined) {
        return path;
      }
    }
  }
  for (const part of deck.parts) {
    if (/^ppt\/slideLayouts\/slideLayout[^/]*\.xml$/.test(part.path)) return part.path;
  }
  return undefined;
}

function nextDeckSlidePath(deck: EditableDeck): string {
  let max = 0;
  for (const part of deck.parts) {
    const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(part.path);
    if (match !== null) max = Math.max(max, Number(match[1] ?? '0'));
  }
  return `ppt/slides/slide${String(max + 1)}.xml`;
}

function nextDeckNotesPath(deck: EditableDeck): string {
  let max = 0;
  for (const part of deck.parts) {
    const match = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/.exec(part.path);
    if (match !== null) max = Math.max(max, Number(match[1] ?? '0'));
  }
  return `ppt/notesSlides/notesSlide${String(max + 1)}.xml`;
}

function nextDeckSlideId(slides: readonly DeckSlideRef[]): number {
  let max = 255;
  for (const slide of slides) {
    if (slide.slide_id > max) max = slide.slide_id;
  }
  return max + 1;
}

/** 新建空白页的部件 XML（与 `render.ts` 同一命名空间口径的最小合法形态）。 */
function blankDeckSlideXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<p:sld xmlns:a="${DECK_NS_A}" xmlns:r="${DECK_NS_R}" xmlns:p="${DECK_NS_P}">` +
    `<p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    `</p:spTree></p:cSld>` +
    `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
    `</p:sld>`
  );
}

function buildDeckRelsXml(rels: readonly DeckRel[]): string {
  const body = rels.map((rel) => rel.raw).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${DECK_REL_NS}">${body}</Relationships>`;
}

function requireDeckPage(slides: readonly DeckSlideRef[], pageNumber: number, what: string): DeckSlideRef {
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > slides.length) {
    throw new DeckEditError(
      'invalid_page_number',
      `${what} ${String(pageNumber)} 超出 1..${String(slides.length)}`,
    );
  }
  const target = slides[pageNumber - 1];
  if (target === undefined) {
    throw new DeckEditError('invalid_page_number', `${what} ${String(pageNumber)} 超出 1..${String(slides.length)}`);
  }
  return target;
}

/** 把一页挂进 `p:sldIdLst`（在 `at` 处，1 起）；同时登记 `presentation.xml.rels` 里的页关系。 */
function attachDeckSlide(
  deck: EditableDeck,
  at: number,
  slideId: number,
  relId: string,
  slidePath: string,
): EditableDeck {
  const presXml = requireDeckPartText(deck, DECK_PRESENTATION_PART, 'missing_presentation_part');
  const sldIds = [...readDeckSldIds(presXml)];
  sldIds.splice(at - 1, 0, { id: slideId, rel_id: relId });
  let next = withDeckPart(deck, DECK_PRESENTATION_PART, utf8Bytes(writeDeckSldIds(presXml, sldIds)));

  const relsText = requireDeckPartText(next, DECK_PRESENTATION_RELS_PART, 'missing_presentation_rels');
  const rels = readDeckRels(relsText);
  next = withDeckPart(
    next,
    DECK_PRESENTATION_RELS_PART,
    utf8Bytes(writeDeckRels(relsText, [...rels, makeDeckRel(relId, DECK_REL_TYPE_SLIDE, relativeDeckTarget('ppt', slidePath))])),
  );
  return next;
}

// ---------------------------------------------------------------------------
// 交给包装配器写回（P-I03：关系图 / 内容类型只此一个写者）
// ---------------------------------------------------------------------------

/** 包内媒体部件路径（`ppt/media/**`）——删页回收**孤儿媒体**时的判定范围。 */
const DECK_MEDIA_PART_RE = /^ppt\/media\/[^/]+$/;

/** 既有没有内容类型覆盖时，按扩展名兜底的通用内容类型（仅列可安全默认的）。 */
const DECK_GENERIC_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  xml: 'application/xml',
});

/** 部件路径的扩展名（小写，不含点）；没有扩展名 ⇒ `null`。 */
function deckExtensionOf(partPath: string): string | null {
  const base = cutLastSlash(partPath).base;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : null;
}

/**
 * 装配器要求**每个**业务部件都有内容类型；既有包里的厂商部件可能没有覆盖项
 * （本模块的文本级层原本不校验这一点）。这里**只**为"确实没有任何内容类型覆盖、且扩展名可安全兜底"
 * 的部件补一条 `Default`（不改动任何既有覆盖项）；无法兜底的部件仍交由装配器具名报错。
 */
function deckFallbackContentTypes(pkg: PresentationPackage): readonly ContentTypeDefault[] {
  const covered = new Set(pkg.content_types.defaults.map((entry) => entry.extension.toLowerCase()));
  const out: ContentTypeDefault[] = [];
  for (const entry of pkg.entries) {
    if (entry.path === DECK_CONTENT_TYPES_PART || entry.path.endsWith('.rels')) continue;
    if (pkg.content_types.overrides.has(entry.path)) continue;
    const extension = deckExtensionOf(entry.path);
    if (extension === null || covered.has(extension)) continue;
    const contentType = DECK_GENERIC_CONTENT_TYPES[extension];
    if (contentType === undefined) continue;
    covered.add(extension);
    out.push({ extension, content_type: contentType });
  }
  return out;
}

/** 某页 `_rels` 里全部**内部**关系的目标部件路径（解析后的包内路径）。 */
function deckInternalTargetsOf(deck: EditableDeck, slidePartPath: string): readonly string[] {
  const relsText = deckPartText(deck, relsPathOf(slidePartPath));
  if (relsText === undefined) return [];
  const baseDir = directoryOf(slidePartPath);
  const out: string[] = [];
  for (const rel of readDeckRels(relsText)) {
    if (rel.external) continue;
    out.push(resolveDeckTargetFrom(baseDir, rel.target));
  }
  return out;
}

/** 除 `excludedRels` 外，包内**所有** `_rels` 内部关系引用到的部件路径集合。 */
function deckReferencedParts(deck: EditableDeck, excludedRels: ReadonlySet<string>): ReadonlySet<string> {
  const referenced = new Set<string>();
  for (const part of deck.parts) {
    if (!part.path.endsWith('.rels') || excludedRels.has(part.path)) continue;
    const baseDir = relsBaseDir(part.path);
    for (const rel of readDeckRels(Buffer.from(part.data).toString('utf8'))) {
      if (rel.external) continue;
      referenced.add(resolveDeckTargetFrom(baseDir, rel.target));
    }
  }
  return referenced;
}

/**
 * 删这一页时**可一并回收的孤儿媒体**：被该页 `_rels` 引用、且在丢掉该页（含其备注）后
 * **没有任何**剩余 `_rels` 再引用的媒体部件。仍被任何存活页 / 关系引用的媒体**一律不动**。
 */
function orphanedMediaOfDeletedSlide(
  deck: EditableDeck,
  slidePartPath: string,
  drop: ReadonlySet<string>,
): readonly string[] {
  const droppedRels = new Set<string>();
  for (const path of drop) {
    if (path.endsWith('.rels')) droppedRels.add(path);
  }
  const referenced = deckReferencedParts(deck, droppedRels);
  const out: string[] = [];
  for (const path of deckInternalTargetsOf(deck, slidePartPath)) {
    if (!DECK_MEDIA_PART_RE.test(path)) continue;
    if (drop.has(path) || referenced.has(path)) continue;
    if (deckPartData(deck, path) === undefined) continue;
    out.push(path);
  }
  return out;
}

/** 把 `EditableDeck` 交给包视图，供装配器按增量计划写回。 */
function deckToPackage(deck: EditableDeck): PresentationPackage {
  return openPresentationPackage(Uint8Array.from(serializeEditableDeck(deck)));
}

// ---------------------------------------------------------------------------
// 增 / 删 / 复制 / 移动 / 隐藏
// ---------------------------------------------------------------------------

/** 页结构操作的结果（新包 + 新页的 `slide_id` 与页码）。 */
export interface DeckSlideResult {
  readonly deck: EditableDeck;
  readonly slide_id: number;
  readonly page_number: number;
}

/** 插入一张空白页（`at` 1 起，缺省 = 追加到末尾）。 */
export function insertDeckSlide(deck: EditableDeck, options?: { readonly at?: number }): DeckSlideResult {
  const slides = deckSlides(deck);
  const at = options?.at ?? slides.length + 1;
  if (!Number.isInteger(at) || at < 1 || at > slides.length + 1) {
    throw new DeckEditError('invalid_page_number', `插入页码 ${String(at)} 超出 1..${String(slides.length + 1)}`);
  }
  const layoutPath = findDeckLayoutPart(deck);
  if (layoutPath === undefined) {
    throw new DeckEditError('missing_layout_part', '包内找不到任何 slideLayout 部件，无法新建页');
  }

  const slideId = nextDeckSlideId(slides);
  const slidePath = nextDeckSlidePath(deck);
  const relsText = requireDeckPartText(deck, DECK_PRESENTATION_RELS_PART, 'missing_presentation_rels');
  const relId = nextDeckRelId(readDeckRels(relsText));

  let next = withDeckPart(deck, slidePath, utf8Bytes(blankDeckSlideXml()));
  next = withDeckPart(
    next,
    relsPathOf(slidePath),
    utf8Bytes(buildDeckRelsXml([makeDeckRel('rId1', DECK_REL_TYPE_SLIDE_LAYOUT, relativeDeckTarget(directoryOf(slidePath), layoutPath))])),
  );
  next = addDeckContentTypeOverride(next, slidePath, DECK_CT_SLIDE);
  next = attachDeckSlide(next, at, slideId, relId, slidePath);

  return { deck: next, slide_id: slideId, page_number: at };
}

/**
 * 删除一页：从 `p:sldIdLst` 摘掉、删掉该页部件与其 `_rels`、删掉**仅供它使用**的备注部件、
 * **回收仅供它使用的媒体部件**（孤儿媒体，P-R04 确认的缺陷），并从所有分节里摘掉。
 * 被自定义放映引用的页 ⇒ **明确报错**（不静默改放映内容）。
 *
 * 关系图 / 内容类型的写回**交给包装配器**（`assemblePresentationPackage`）——本层只算出
 * "替换 / 删除哪些部件 + 摘掉哪条页关系"，不自己手写 `presentation.xml.rels` 与
 * `[Content_Types].xml`（唯一写者）。
 *
 * **回收判据（保守）**：只回收"**媒体部件**里、被该页 `_rels` 引用、且丢页后**没有任何**
 * 剩余 `_rels` 再引用"的那些；仍被任何存活页 / 关系引用的部件**一律不动**（反向对照）。
 */
export function deleteDeckSlide(deck: EditableDeck, pageNumber: number): EditableDeck {
  const slides = deckSlides(deck);
  const target = requireDeckPage(slides, pageNumber, '删除页码');

  const presXml = requireDeckPartText(deck, DECK_PRESENTATION_PART, 'missing_presentation_part');
  if (customShowRelIds(presXml).includes(target.rel_id)) {
    throw new DeckEditError(
      'custom_show_reference',
      `第 ${String(pageNumber)} 页被自定义放映引用（${target.rel_id}）；删除会让放映悬挂，` +
        '故明确拒绝而不是偷偷改放映内容',
    );
  }

  const notesPath = deckNotesPartOf(deck, target.part_path);
  const notesShared =
    notesPath !== null &&
    slides.some((ref) => ref.part_path !== target.part_path && deckNotesPartOf(deck, ref.part_path) === notesPath);

  const drop = new Set<string>([target.part_path, relsPathOf(target.part_path)]);
  if (notesPath !== null && !notesShared) {
    drop.add(notesPath);
    drop.add(relsPathOf(notesPath));
  }
  for (const mediaPath of orphanedMediaOfDeletedSlide(deck, target.part_path, drop)) {
    drop.add(mediaPath);
    drop.add(relsPathOf(mediaPath));
  }

  const remaining = readDeckSldIds(presXml).filter((entry) => entry.id !== target.slide_id);
  const sections = readDeckSections(deck).map((section) => ({
    ...section,
    slide_ids: section.slide_ids.filter((id) => id !== target.slide_id),
  }));
  const nextPresentation = applyDeckSections(writeDeckSldIds(presXml, remaining), sections);

  const pkg = deckToPackage(deck);
  const assembly = assemblePresentationPackage(pkg, {
    replace_parts: new Map([[DECK_PRESENTATION_PART, utf8Bytes(nextPresentation)]]),
    remove_parts: [...drop].filter((path) => pkg.by_path.has(path)),
    relationship_edits: [{ owner_part_path: DECK_PRESENTATION_PART, remove_ids: [target.rel_id] }],
    content_type_defaults: deckFallbackContentTypes(pkg),
  });
  return openEditableDeck(Uint8Array.from(assembly.bytes));
}

/** 复制一页（部件字节照抄；备注部件另开一份，因为备注部件与页是"一对一"的）。 */
export function duplicateDeckSlide(
  deck: EditableDeck,
  pageNumber: number,
  options?: { readonly at?: number },
): DeckSlideResult {
  const slides = deckSlides(deck);
  const source = requireDeckPage(slides, pageNumber, '复制页码');
  const at = options?.at ?? pageNumber + 1;
  if (!Number.isInteger(at) || at < 1 || at > slides.length + 1) {
    throw new DeckEditError('invalid_page_number', `目标页码 ${String(at)} 超出 1..${String(slides.length + 1)}`);
  }
  const sourceBytes = deckPartData(deck, source.part_path);
  if (sourceBytes === undefined) {
    throw new DeckEditError('unresolved_slide_target', `包内没有部件 ${source.part_path}`);
  }

  const slideId = nextDeckSlideId(slides);
  const slidePath = nextDeckSlidePath(deck);
  const relId = nextDeckRelId(readDeckRels(requireDeckPartText(deck, DECK_PRESENTATION_RELS_PART, 'missing_presentation_rels')));

  let next = withDeckPart(deck, slidePath, sourceBytes);
  next = addDeckContentTypeOverride(next, slidePath, DECK_CT_SLIDE);

  const sourceRelsText = deckPartText(deck, relsPathOf(source.part_path));
  const notesPath = deckNotesPartOf(deck, source.part_path);
  const newNotesPath = notesPath === null ? null : nextDeckNotesPath(deck);

  if (sourceRelsText !== undefined) {
    const sourceBase = directoryOf(source.part_path);
    const rewritten = readDeckRels(sourceRelsText).map((rel) => {
      if (rel.external || notesPath === null || newNotesPath === null) return rel;
      const resolved = resolveDeckTargetFrom(sourceBase, rel.target);
      return resolved === notesPath
        ? makeDeckRel(rel.id, rel.type, relativeDeckTarget(directoryOf(slidePath), newNotesPath))
        : rel;
    });
    next = withDeckPart(next, relsPathOf(slidePath), utf8Bytes(writeDeckRels(sourceRelsText, rewritten)));
  }

  if (notesPath !== null && newNotesPath !== null) {
    const notesBytes = deckPartData(deck, notesPath);
    if (notesBytes !== undefined) {
      next = withDeckPart(next, newNotesPath, notesBytes);
      next = addDeckContentTypeOverride(next, newNotesPath, DECK_CT_NOTES_SLIDE);
      const notesRelsText = deckPartText(deck, relsPathOf(notesPath));
      if (notesRelsText !== undefined) {
        const notesBase = directoryOf(notesPath);
        const rewritten = readDeckRels(notesRelsText).map((rel) => {
          if (rel.external) return rel;
          return resolveDeckTargetFrom(notesBase, rel.target) === source.part_path
            ? makeDeckRel(rel.id, rel.type, relativeDeckTarget(directoryOf(newNotesPath), slidePath))
            : rel;
        });
        next = withDeckPart(next, relsPathOf(newNotesPath), utf8Bytes(writeDeckRels(notesRelsText, rewritten)));
      }
    }
  }

  next = attachDeckSlide(next, at, slideId, relId, slidePath);

  const sections = readDeckSections(next).map((section) =>
    section.slide_ids.includes(source.slide_id)
      ? { ...section, slide_ids: [...section.slide_ids, slideId] }
      : section,
  );
  next = writeDeckSections(
    next,
    sections.map((section) => ({ ...section, slide_ids: orderDeckSlideIds(next, section.slide_ids) })),
  );

  return { deck: next, slide_id: slideId, page_number: at };
}

/** 移动一页（`fromPage` → `toPage`，均 1 起）；分节成员不变，节内页序按新页序重排。 */
export function moveDeckSlide(deck: EditableDeck, fromPage: number, toPage: number): EditableDeck {
  const slides = deckSlides(deck);
  requireDeckPage(slides, fromPage, '起始页码');
  requireDeckPage(slides, toPage, '目标页码');
  const presXml = requireDeckPartText(deck, DECK_PRESENTATION_PART, 'missing_presentation_part');
  const entries = [...readDeckSldIds(presXml)];
  const [moved] = entries.splice(fromPage - 1, 1);
  if (moved === undefined) {
    throw new DeckEditError('invalid_page_number', `起始页码 ${String(fromPage)} 超出 1..${String(slides.length)}`);
  }
  entries.splice(toPage - 1, 0, moved);
  let next = withDeckPart(deck, DECK_PRESENTATION_PART, utf8Bytes(writeDeckSldIds(presXml, entries)));
  const sections = readDeckSections(next).map((section) => ({
    ...section,
    slide_ids: orderDeckSlideIds(next, section.slide_ids),
  }));
  return writeDeckSections(next, sections);
}

/** 显示 / 隐藏一页（在幻灯片部件的 `p:sld@show` 上落地）。 */
export function setDeckSlideHidden(deck: EditableDeck, pageNumber: number, hidden: boolean): EditableDeck {
  const slides = deckSlides(deck);
  const target = requireDeckPage(slides, pageNumber, '隐藏页码');
  const xml = requireDeckPartText(deck, target.part_path, 'unresolved_slide_target');
  return withDeckPart(deck, target.part_path, utf8Bytes(writeDeckSlideShow(xml, hidden)));
}

function writeDeckSlideShow(xml: string, hidden: boolean): string {
  const root = /<p:sld\b([^>]*?)(\/?)>/.exec(xml);
  const rootTag = root?.[0];
  if (root === null || rootTag === undefined) {
    throw new DeckEditError('malformed_presentation_xml', '幻灯片部件里没有 <p:sld> 根元素');
  }
  const attrs = root[1] ?? '';
  const selfClosing = root[2] === '/';
  const showAttr = /(?<![\w:])show\s*=\s*"[^"]*"/;
  const nextAttrs = hidden
    ? showAttr.test(attrs)
      ? attrs.replace(showAttr, 'show="0"')
      : `${attrs} show="0"`
    : attrs.replace(new RegExp(`\\s*${showAttr.source}`), '');
  return xml.replace(rootTag, () => `<p:sld${nextAttrs}${selfClosing ? '/' : ''}>`);
}

// ---------------------------------------------------------------------------
// 版式切换（PPT-02「版式」在导入文稿上的落地）
// ---------------------------------------------------------------------------

/**
 * 一页在包内引用哪个版式，靠的是该页 `_rels` 里 `Type=.../slideLayout` 的那条关系
 * （`Target` = `../slideLayouts/slideLayoutN.xml`）——页部件正文**不**写版式路径。
 * 所以"切换版式"= 改这条关系的 Target，页序 / 分节 / 其它关系一律不动。
 */
export interface DeckLayout {
  /** 版式部件路径（`ppt/slideLayouts/slideLayoutN.xml`）。 */
  readonly part_path: string;
  /** 版式名（`p:sldLayout/p:cSld@name`；退化到 `p:sldLayout@type`，再退化到部件名）。 */
  readonly name: string;
  /** 该版式挂靠的母版部件路径（其 `_rels` 里 slideMaster 关系解析结果）；无 ⇒ `null`。 */
  readonly master_path: string | null;
}

/** 部件路径 → 去目录去扩展名的部件名（`ppt/slideLayouts/slideLayout1.xml` → `slideLayout1`）。 */
function deckPartName(partPath: string): string {
  return cutLastSlash(partPath).base.replace(/\.xml$/, '');
}

const DECK_LAYOUT_PART_RE = /^ppt\/slideLayouts\/slideLayout[^/]*\.xml$/;

/** 读一份版式的名字：`p:cSld@name` > `p:sldLayout@type` > 部件名。 */
function readDeckLayoutName(deck: EditableDeck, partPath: string): string {
  const xml = deckPartText(deck, partPath);
  if (xml === undefined) return deckPartName(partPath);
  const cSldAttrs = /<p:cSld\b([^>]*)>/.exec(xml)?.[1];
  const name = cSldAttrs === undefined ? undefined : /\bname\s*=\s*"([^"]*)"/.exec(cSldAttrs)?.[1];
  if (name !== undefined && name !== '') return decodeXmlEntities(name);
  const layoutAttrs = /<p:sldLayout\b([^>]*)>/.exec(xml)?.[1];
  const type = layoutAttrs === undefined ? undefined : /\btype\s*=\s*"([^"]*)"/.exec(layoutAttrs)?.[1];
  return type !== undefined && type !== '' ? type : deckPartName(partPath);
}

/** 一份版式挂靠的母版部件路径（其 `_rels` 里的 slideMaster 关系）；无 ⇒ `null`。 */
function readDeckLayoutMaster(deck: EditableDeck, layoutPartPath: string): string | null {
  const relsText = deckPartText(deck, relsPathOf(layoutPartPath));
  if (relsText === undefined) return null;
  const baseDir = directoryOf(layoutPartPath);
  for (const rel of readDeckRels(relsText)) {
    if (rel.external) continue;
    const path = resolveDeckTargetFrom(baseDir, rel.target);
    if (/\/slideMasters\/slideMaster[^/]*\.xml$/.test(path)) return path;
  }
  return null;
}

/** 列出包内全部可用版式（按部件路径排序，稳定且便于用例断言）。 */
export function listDeckLayouts(deck: EditableDeck): readonly DeckLayout[] {
  const paths = deck.parts
    .map((part) => part.path)
    .filter((path) => DECK_LAYOUT_PART_RE.test(path))
    .sort();
  return Object.freeze(
    paths.map((path) =>
      Object.freeze({
        part_path: path,
        name: readDeckLayoutName(deck, path),
        master_path: readDeckLayoutMaster(deck, path),
      }),
    ),
  );
}

/** 某页当前引用的版式部件路径；该页没有版式关系 ⇒ `null`。 */
export function deckSlideLayoutPath(deck: EditableDeck, pageNumber: number): string | null {
  const target = requireDeckPage(deckSlides(deck), pageNumber, '页码');
  const relsText = deckPartText(deck, relsPathOf(target.part_path));
  if (relsText === undefined) return null;
  const baseDir = directoryOf(target.part_path);
  for (const rel of readDeckRels(relsText)) {
    if (rel.external) continue;
    const path = resolveDeckTargetFrom(baseDir, rel.target);
    if (DECK_LAYOUT_PART_RE.test(path) && deckPartData(deck, path) !== undefined) return path;
  }
  return null;
}

function requireDeckLayout(deck: EditableDeck, layoutPartPath: string): void {
  if (!DECK_LAYOUT_PART_RE.test(layoutPartPath) || deckPartData(deck, layoutPartPath) === undefined) {
    throw new DeckEditError('unknown_layout', `包内没有版式部件 ${layoutPartPath}`);
  }
}

/**
 * 切换一页的版式：把该页 `_rels` 里 slideLayout 关系的 Target 指向 `layoutPartPath`。
 *
 * 页序 / 分节 / 该页其它关系（媒体、备注、图表…）**一律不动**；目标版式必须已在包内
 * （否则报 `unknown_layout`，而不是写出一个指向不存在部件的悬挂关系）。该页原本没有
 * `_rels` 时新建一份，只含这条版式关系。
 */
export function setDeckSlideLayout(
  deck: EditableDeck,
  pageNumber: number,
  layoutPartPath: string,
): EditableDeck {
  const slides = deckSlides(deck);
  const target = requireDeckPage(slides, pageNumber, '页码');
  requireDeckLayout(deck, layoutPartPath);

  const relsPath = relsPathOf(target.part_path);
  const baseDir = directoryOf(target.part_path);
  const targetRelative = relativeDeckTarget(baseDir, layoutPartPath);
  const relsText = deckPartText(deck, relsPath);

  if (relsText === undefined) {
    const created = buildDeckRelsXml([makeDeckRel('rId1', DECK_REL_TYPE_SLIDE_LAYOUT, targetRelative)]);
    return withDeckPart(deck, relsPath, utf8Bytes(created));
  }

  const rels = readDeckRels(relsText);
  const index = rels.findIndex(
    (rel) => !rel.external && DECK_LAYOUT_PART_RE.test(resolveDeckTargetFrom(baseDir, rel.target)),
  );
  const next =
    index < 0
      ? [...rels, makeDeckRel(nextDeckRelId(rels), DECK_REL_TYPE_SLIDE_LAYOUT, targetRelative)]
      : rels.map((rel, i) => (i === index ? makeDeckRel(rel.id, rel.type, targetRelative) : rel));
  return withDeckPart(deck, relsPath, utf8Bytes(writeDeckRels(relsText, next)));
}

/** 按版式名切换（同名取**第一个**；找不到 ⇒ 报 `unknown_layout`）。 */
export function setDeckSlideLayoutByName(
  deck: EditableDeck,
  pageNumber: number,
  name: string,
): EditableDeck {
  const layout = listDeckLayouts(deck).find((candidate) => candidate.name === name);
  if (layout === undefined) {
    throw new DeckEditError('unknown_layout', `包内没有名为 ${name} 的版式`);
  }
  return setDeckSlideLayout(deck, pageNumber, layout.part_path);
}

/**
 * **分组**应用同一版式到多页（包级 `setLayoutForSlides`）：把 `pageNumbers` 里每一页的
 * slideLayout 关系 Target 都指向 `layoutPartPath`。页序 / 分节 / 各页其它关系一律不动。
 * （模型层的同名操作是 `setLayoutForSlides(Presentation, slideIds, layout)`；本函数是它在
 * **导入包**上的对应物。）
 *
 * 先**整体校验**（每页都在范围内、目标版式存在）再落地，不做半套；某一页失败时入参不被改动
 * （本模块全部是纯函数）。重复页码是幂等的，不报错。
 */
export function setDeckLayoutForSlides(
  deck: EditableDeck,
  pageNumbers: readonly number[],
  layoutPartPath: string,
): EditableDeck {
  const slides = deckSlides(deck);
  requireDeckLayout(deck, layoutPartPath);
  for (const pageNumber of pageNumbers) requireDeckPage(slides, pageNumber, '页码');
  let next = deck;
  for (const pageNumber of pageNumbers) next = setDeckSlideLayout(next, pageNumber, layoutPartPath);
  return next;
}

/** 按版式名**分组**应用到多页（同名取第一个；找不到 ⇒ `unknown_layout`）。 */
export function setDeckLayoutForSlidesByName(
  deck: EditableDeck,
  pageNumbers: readonly number[],
  name: string,
): EditableDeck {
  const layout = listDeckLayouts(deck).find((candidate) => candidate.name === name);
  if (layout === undefined) {
    throw new DeckEditError('unknown_layout', `包内没有名为 ${name} 的版式`);
  }
  return setDeckLayoutForSlides(deck, pageNumbers, layout.part_path);
}

// ---------------------------------------------------------------------------
// 分节操作
// ---------------------------------------------------------------------------

function nextDeckSectionId(sections: readonly DeckSection[]): string {
  const used = new Set(sections.map((section) => section.section_id));
  let n = sections.length + 1;
  for (;;) {
    const candidate = `{${String(n).padStart(8, '0')}-0000-0000-0000-000000000000}`;
    if (!used.has(candidate)) return candidate;
    n += 1;
  }
}

function requireDeckSectionIndex(sections: readonly DeckSection[], sectionId: string): number {
  const index = sections.findIndex((section) => section.section_id === sectionId);
  if (index < 0) {
    throw new DeckEditError('unknown_section', `找不到分节 section_id=${sectionId}`);
  }
  return index;
}

/** 分节操作结果（新包 + 分节 id）。 */
export interface DeckSectionResult {
  readonly deck: EditableDeck;
  readonly section_id: string;
}

/** 新建分节（可同时归入若干页，`slide_ids` 会按页序排好）。 */
export function createDeckSection(
  deck: EditableDeck,
  name: string,
  options?: { readonly section_id?: string; readonly slide_ids?: readonly number[]; readonly at?: number },
): DeckSectionResult {
  if (name.trim() === '') {
    throw new DeckEditError('empty_section_name', '分节名不能为空');
  }
  const sections = readDeckSections(deck);
  const sectionId = options?.section_id ?? nextDeckSectionId(sections);
  if (sections.some((section) => section.section_id === sectionId)) {
    throw new DeckEditError('duplicate_section_id', `section_id=${sectionId} 已存在`);
  }
  const at = options?.at ?? sections.length;
  if (!Number.isInteger(at) || at < 0 || at > sections.length) {
    throw new DeckEditError('invalid_section_order', `分节插入位置 ${String(at)} 越界`);
  }
  const slideIds = orderDeckSlideIds(deck, options?.slide_ids ?? []);
  assertDeckSlideIdsExist(deck, slideIds, `分节 ${sectionId}`);
  const section: DeckSection = { section_id: sectionId, name, slide_ids: slideIds };
  return {
    deck: writeDeckSections(deck, [...sections.slice(0, at), section, ...sections.slice(at)]),
    section_id: sectionId,
  };
}

/** 分节改名。 */
export function renameDeckSection(deck: EditableDeck, sectionId: string, name: string): EditableDeck {
  if (name.trim() === '') {
    throw new DeckEditError('empty_section_name', '分节名不能为空');
  }
  const sections = readDeckSections(deck);
  const index = requireDeckSectionIndex(sections, sectionId);
  return writeDeckSections(
    deck,
    sections.map((section, i) => (i === index ? { ...section, name } : section)),
  );
}

/** 移动分节到 `toIndex`（0 起，分节序列内的位置）。 */
export function moveDeckSection(deck: EditableDeck, sectionId: string, toIndex: number): EditableDeck {
  const sections = [...readDeckSections(deck)];
  const from = requireDeckSectionIndex(sections, sectionId);
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= sections.length) {
    throw new DeckEditError('invalid_section_order', `分节目标位置 ${String(toIndex)} 超出 0..${String(sections.length - 1)}`);
  }
  const [moved] = sections.splice(from, 1);
  if (moved === undefined) {
    throw new DeckEditError('unknown_section', `找不到分节 section_id=${sectionId}`);
  }
  sections.splice(toIndex, 0, moved);
  return writeDeckSections(deck, sections);
}

/**
 * **连同页**移动分节：把该分节的**全部页**作为一个**连续块**搬到新页序里——搬完后该块的第一页
 * 恰是第 `toPage` 页（1 起）。分节成员与块内相对顺序不变；其它分节的成员不受影响，
 * 但节内页序会按新页序重排（`slide_ids` 始终升序）。`toPage` 允许范围 = `1..(总页数 − 块长 + 1)`。
 */
export function moveDeckSectionWithPages(deck: EditableDeck, sectionId: string, toPage: number): EditableDeck {
  const slides = deckSlides(deck);
  const sections = readDeckSections(deck);
  const index = requireDeckSectionIndex(sections, sectionId);
  const section = sections[index];
  if (section === undefined) {
    throw new DeckEditError('unknown_section', `找不到分节 section_id=${sectionId}`);
  }

  const blockSet = new Set(section.slide_ids);
  const block = slides.filter((ref) => blockSet.has(ref.slide_id)).map((ref) => ref.slide_id);
  const others = slides.filter((ref) => !blockSet.has(ref.slide_id)).map((ref) => ref.slide_id);
  const maxStart = others.length + 1;
  if (!Number.isInteger(toPage) || toPage < 1 || toPage > maxStart) {
    throw new DeckEditError(
      'invalid_page_number',
      `分节落点页码 ${String(toPage)} 超出 1..${String(maxStart)}（总 ${String(slides.length)} 页 − 块内 ${String(block.length)} 页）`,
    );
  }

  const order = [...others];
  order.splice(toPage - 1, 0, ...block);

  const presXml = requireDeckPartText(deck, DECK_PRESENTATION_PART, 'missing_presentation_part');
  const byId = new Map(readDeckSldIds(presXml).map((entry) => [entry.id, entry] as const));
  const reordered = order.map((id) => {
    const entry = byId.get(id);
    if (entry === undefined) {
      throw new DeckEditError('unknown_slide', `分节 ${sectionId} 引用了不存在的 slide_id=${String(id)}`);
    }
    return entry;
  });
  let next = withDeckPart(deck, DECK_PRESENTATION_PART, utf8Bytes(writeDeckSldIds(presXml, reordered)));
  next = writeDeckSections(
    next,
    readDeckSections(next).map((candidate) => ({
      ...candidate,
      slide_ids: orderDeckSlideIds(next, candidate.slide_ids),
    })),
  );
  return next;
}

/** 删除分节；**页保留**（只是不再属于任何分节）。 */
export function deleteDeckSection(deck: EditableDeck, sectionId: string): EditableDeck {
  const sections = readDeckSections(deck);
  requireDeckSectionIndex(sections, sectionId);
  return writeDeckSections(
    deck,
    sections.filter((section) => section.section_id !== sectionId),
  );
}

/** 把一页归入某分节（`sectionId = null` ⇒ 从所有分节里摘出）。一页至多属于一个分节。 */
export function assignDeckSlideToSection(
  deck: EditableDeck,
  pageNumber: number,
  sectionId: string | null,
): EditableDeck {
  const slides = deckSlides(deck);
  const target = requireDeckPage(slides, pageNumber, '页码');
  const sections = readDeckSections(deck);
  if (sectionId !== null) requireDeckSectionIndex(sections, sectionId);
  const detached = sections.map((section) => ({
    ...section,
    slide_ids: section.slide_ids.filter((id) => id !== target.slide_id),
  }));
  if (sectionId === null) {
    return writeDeckSections(deck, detached);
  }
  const withTarget = detached.map((section) =>
    section.section_id === sectionId
      ? { ...section, slide_ids: [...section.slide_ids, target.slide_id] }
      : section,
  );
  return writeDeckSections(
    deck,
    withTarget.map((section) => ({ ...section, slide_ids: orderDeckSlideIds(deck, section.slide_ids) })),
  );
}

// ---------------------------------------------------------------------------
// 一致性复核（"页序 / 节 / 引用不乱"的可复核判据）
// ---------------------------------------------------------------------------

/**
 * 复核一份包的结构一致性：页序→部件一一对应、**没有悬挂关系**、分节引用存在且按页序。
 * 不满足即抛具名错误。
 */
export function validateEditableDeck(deck: EditableDeck): void {
  const slides = deckSlides(deck);
  const knownIds = new Set(slides.map((slide) => slide.slide_id));

  for (const part of deck.parts) {
    if (!part.path.endsWith('.rels')) continue;
    const baseDir = relsBaseDir(part.path);
    for (const rel of readDeckRels(Buffer.from(part.data).toString('utf8'))) {
      if (rel.external) continue;
      const resolved = resolveDeckTargetFrom(baseDir, rel.target);
      if (deckPartData(deck, resolved) === undefined) {
        throw new DeckEditError(
          'dangling_relationship',
          `${part.path} 的关系 ${rel.id} 指向不存在的部件 ${resolved}`,
        );
      }
    }
  }

  const seenSections = new Set<string>();
  const pageOf = new Map(slides.map((slide) => [slide.slide_id, slide.page_number] as const));
  for (const section of readDeckSections(deck)) {
    if (seenSections.has(section.section_id)) {
      throw new DeckEditError('duplicate_section_id', `分节 ${section.section_id} 重复`);
    }
    seenSections.add(section.section_id);
    let last = 0;
    const localSeen = new Set<number>();
    for (const slideId of section.slide_ids) {
      const page = pageOf.get(slideId);
      if (page === undefined || !knownIds.has(slideId)) {
        throw new DeckEditError('unknown_slide', `分节 ${section.section_id} 引用了不存在的 slide_id=${String(slideId)}`);
      }
      if (localSeen.has(slideId)) {
        throw new DeckEditError('malformed_presentation_xml', `分节 ${section.section_id} 里 slide_id=${String(slideId)} 重复`);
      }
      localSeen.add(slideId);
      if (page <= last) {
        throw new DeckEditError('invalid_section_order', `分节 ${section.section_id} 的页序不是升序`);
      }
      last = page;
    }
  }
}

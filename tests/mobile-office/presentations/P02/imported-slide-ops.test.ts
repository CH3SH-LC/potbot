/**
 * P02-slide-ops：**导入的** PPTX 文稿的页结构操作（增 / 删 / 复制 / 移动 / 隐藏 / 分节）。
 *
 * ## 这一批要钉死的是"导入路径"这一截
 *
 * 模型层（`src/presentations/slide-ops.ts` 上半部分）与渲染层早就支持增删页；
 * 但"导入既有 PPTX 之后再动页结构"此前是断的——`roundtrip.exportImportedPresentation`
 * 发现页集合变了就报 `slide_set_changed`。本批补的是**包级**那一层
 * （`EditableDeck` 一族）：直接改 `p:sldIdLst` / `p:presentation.xml.rels` / 部件本身。
 *
 * ## 判据一律走**独立解析**，不复用待测代码自证
 *
 * 本文件自己实现了：
 * - `readRawPages`：从 ZIP 里直接读 `ppt/presentation.xml` 的 `p:sldIdLst` 顺序 +
 *   `ppt/_rels/presentation.xml.rels` 的 `rId → Target`，解析出「页 → 部件」；
 * - `danglingRelationships`：遍历包里**每一个** `.rels`，把内部 `Target` 解析成包内路径，
 *   凡指向不存在的部件即为悬挂；
 * - `pageMarkers`：直接读幻灯片部件文本里的 `<a:t>P<n></a:t>` 标记——用来断言
 *   "第几页装的是哪一页的内容"，而不是只看页数。
 *
 * 待测的 `deckSlides` / `validateEditableDeck` 只作为**额外**断言，不作为唯一证据。
 *
 * ## 反向对照
 *
 * 越界页号 / 越界移动一律**具名报错**（`DeckEditError`），不静默夹取；
 * 删除会被自定义放映引用的页 ⇒ **明确报错**（不偷偷改放映内容）。
 */

import { describe, expect, it } from 'vitest';

import { readZip, utf8Bytes, writeZip } from '../../../../src/artifacts/ooxml/index.js';
import { literalText, transform, type Presentation, type Shape } from '../../../../src/presentations/model.js';
import { addShape, addSlide, setSlideNotes } from '../../../../src/presentations/operations.js';
import { emptyPresentation, renderPresentation } from '../../../../src/presentations/render.js';
import { importPresentation } from '../../../../src/presentations/roundtrip.js';
import {
  DeckEditError,
  assignDeckSlideToSection,
  createDeckSection,
  deckSections,
  deckSlides,
  deleteDeckSlide,
  deleteDeckSection,
  duplicateDeckSlide,
  insertDeckSlide,
  moveDeckSection,
  moveDeckSlide,
  openEditableDeck,
  renameDeckSection,
  serializeEditableDeck,
  setDeckSlideHidden,
  validateEditableDeck,
} from '../../../../src/presentations/slide-ops.js';
import type { DeckEditErrorReason } from '../../../../src/presentations/slide-ops.js';

// ---------------------------------------------------------------------------
// 独立解析器（**不复用**待测模块）
// ---------------------------------------------------------------------------

interface ZipLikeEntry {
  readonly path: string;
  readonly data: Uint8Array;
}

function textOfEntries(entries: readonly ZipLikeEntry[], path: string): string {
  const entry = entries.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`包内没有部件 ${path}`);
  return Buffer.from(entry.data).toString('utf8');
}

function textOf(bytes: Uint8Array, path: string): string {
  return textOfEntries(readZip(bytes).entries, path);
}

/** 把相对 `Target` 解析成包内路径（自己实现，不用待测代码）。 */
function resolveTarget(baseDir: string, target: string): string {
  const combined = target.startsWith('/') ? target.replace(/^\/+/, '') : `${baseDir}/${target}`;
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

/** 关系部件路径 → 相对 Target 的基准目录。 */
function relsBaseDirOf(relsPath: string): string {
  if (relsPath === '_rels/.rels') return '';
  const cut = relsPath.lastIndexOf('/_rels/');
  return cut < 0 ? '' : relsPath.slice(0, cut);
}

interface RawRel {
  readonly id: string;
  readonly target: string;
  readonly external: boolean;
  readonly raw: string;
}

function readRelsOf(text: string): readonly RawRel[] {
  const rels: RawRel[] = [];
  for (const match of text.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const tag = match[0] ?? '';
    const id = /\bId\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    const target = /\bTarget\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    if (id === undefined || target === undefined) continue;
    rels.push({ id, target, external: /TargetMode\s*=\s*"External"/.test(tag), raw: tag });
  }
  return rels;
}

interface RawPage {
  readonly slide_id: number;
  readonly rel_id: string;
  readonly part_path: string;
}

/** 从 `p:sldIdLst` 顺序 + `presentation.xml.rels` 解析「页 → 部件」。 */
function readPagesFromEntries(entries: readonly ZipLikeEntry[]): readonly RawPage[] {
  const presXml = textOfEntries(entries, 'ppt/presentation.xml');
  const rels = readRelsOf(textOfEntries(entries, 'ppt/_rels/presentation.xml.rels'));
  const targetById = new Map(rels.map((rel) => [rel.id, rel] as const));
  const block = /<p:sldIdLst\b[^>]*>([\s\S]*?)<\/p:sldIdLst>/.exec(presXml);
  const pages: RawPage[] = [];
  for (const match of (block?.[1] ?? '').matchAll(/<p:sldId\b[^>]*\/?>/g)) {
    const tag = match[0] ?? '';
    const slideId = /(?<![\w:])id\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    const relId = /\br:id\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    if (slideId === undefined || relId === undefined) throw new Error(`解析 p:sldId 失败：${tag}`);
    const rel = targetById.get(relId);
    if (rel === undefined) throw new Error(`p:sldId@r:id=${relId} 没有对应关系`);
    pages.push({ slide_id: Number(slideId), rel_id: relId, part_path: resolveTarget('ppt', rel.target) });
  }
  return pages;
}

function readRawPages(bytes: Uint8Array): readonly RawPage[] {
  return readPagesFromEntries(readZip(bytes).entries);
}

/** 遍历包里每个 `.rels`，返回指向不存在部件的内部关系的描述（空 = 没有悬挂）。 */
function danglingRelationships(bytes: Uint8Array): readonly string[] {
  const entries = readZip(bytes).entries;
  const present = new Set(entries.map((entry) => entry.path));
  const bad: string[] = [];
  for (const entry of entries) {
    if (!entry.path.endsWith('.rels')) continue;
    const baseDir = relsBaseDirOf(entry.path);
    for (const rel of readRelsOf(Buffer.from(entry.data).toString('utf8'))) {
      if (rel.external) continue;
      const resolved = resolveTarget(baseDir, rel.target);
      if (!present.has(resolved)) bad.push(`${entry.path} 的关系 ${rel.id} → ${resolved}`);
    }
  }
  return bad;
}

/** 页序上每页装的标记（`<a:t>P<n></a:t>`）；空白新页为 `null`。 */
function pageMarkers(bytes: Uint8Array): readonly (number | null)[] {
  return readRawPages(bytes).map((page) => {
    const match = /<a:t>P(\d+)<\/a:t>/.exec(textOf(bytes, page.part_path));
    return match === null ? null : Number(match[1]);
  });
}

/** 页 → 部件是一一对应且**没有孤儿幻灯片部件**（部件数 == 页数）。 */
function assertPagePartBijection(bytes: Uint8Array): void {
  const pages = readRawPages(bytes);
  const seen = new Set<string>();
  for (const page of pages) {
    expect(seen.has(page.part_path)).toBe(false);
    seen.add(page.part_path);
  }
  const slideParts = readZip(bytes).entries.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.path));
  expect(slideParts.length).toBe(pages.length);
}

// ---------------------------------------------------------------------------
// 装置：造一份"别人的"多页 PPTX（含备注 / 分节 / 自定义部件）
// ---------------------------------------------------------------------------

function marker(pageIndex: number): Shape {
  return {
    kind: 'text_box',
    shape_id: 2,
    name: `M${String(pageIndex + 1)}`,
    transform: transform(0, 0, 1000000, 500000),
    text: literalText(`P${String(pageIndex + 1)}`),
  };
}

interface BuildOptions {
  /** 让自定义放映引用这一页（1 起）。 */
  readonly customShowPage?: number;
}

/**
 * 造一份导入源：3 页（标记 P1/P2/P3，slide_id = 256/257/258）、第 2 页带备注、
 * 两个分节（第一节 = 页 1-2，第二节 = 页 3）、一个厂商自定义部件。
 *
 * 分节与自定义放映是**字符串手术**注入的（不经待测的写函数），因此读侧是被真正考到的。
 */
function buildImportedDeck(options?: BuildOptions): Uint8Array {
  let deck: Presentation = emptyPresentation('src', '导入源');
  for (let i = 0; i < 3; i += 1) {
    const added = addSlide(deck);
    deck = added.presentation;
    deck = addShape(deck, added.slide_id, marker(i));
  }
  // 模型层 slide_id 是 1/2/3（由 addSlide 分配）；写进文件后由 render 映射成 256/257/258。
  deck = setSlideNotes(deck, 2, literalText('备注二'));

  const rendered = renderPresentation(deck);
  const archive = readZip(rendered.bytes);
  const entries: ZipLikeEntry[] = archive.entries.map((entry) => ({ path: entry.path, data: entry.data }));

  let customShow = '';
  if (options?.customShowPage !== undefined) {
    const page = readPagesFromEntries(entries)[options.customShowPage - 1];
    if (page === undefined) throw new Error(`源里没有第 ${String(options.customShowPage)} 页`);
    customShow =
      `<p:custShowLst><p:custShow name="放映一"><p:sldLst>` +
      `<p:sld r:id="${page.rel_id}"/></p:sldLst></p:custShow></p:custShowLst>`;
  }

  const sections =
    '<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}">' +
    `<p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">` +
    `<p14:section name="第一节" id="{11111111-1111-1111-1111-111111111111}">` +
    `<p14:sldIdLst><p14:sldId id="256"/><p14:sldId id="257"/></p14:sldIdLst></p14:section>` +
    `<p14:section name="第二节" id="{22222222-2222-2222-2222-222222222222}">` +
    `<p14:sldIdLst><p14:sldId id="258"/></p14:sldIdLst></p14:section>` +
    `</p14:sectionLst></p:ext></p:extLst>`;

  const presIndex = entries.findIndex((entry) => entry.path === 'ppt/presentation.xml');
  const presXml = Buffer.from(entries[presIndex]!.data)
    .toString('utf8')
    .replace('</p:presentation>', `${customShow}${sections}</p:presentation>`);
  entries[presIndex] = { path: 'ppt/presentation.xml', data: utf8Bytes(presXml) };
  entries.push({ path: 'customXml/vendor.xml', data: utf8Bytes('<vendor>保留我</vendor>') });
  return writeZip(entries);
}

function expectDeckError(run: () => unknown, reason: DeckEditErrorReason): void {
  try {
    run();
    throw new Error('应当抛出 DeckEditError');
  } catch (error) {
    expect(error).toBeInstanceOf(DeckEditError);
    expect((error as DeckEditError).reason).toBe(reason);
  }
}

// ---------------------------------------------------------------------------
// 0. 源本身是干净的（后面所有"没有悬挂"的断言都以它为基准）
// ---------------------------------------------------------------------------

describe('P02：导入源装置自检', () => {
  it('源包页序 = slide1/slide2/slide3，本身没有悬挂关系，且带备注与分节', () => {
    const source = buildImportedDeck();
    expect(readRawPages(source).map((page) => page.part_path)).toEqual([
      'ppt/slides/slide1.xml',
      'ppt/slides/slide2.xml',
      'ppt/slides/slide3.xml',
    ]);
    expect(pageMarkers(source)).toEqual([1, 2, 3]);
    expect(danglingRelationships(source)).toEqual([]);
    expect(readZip(source).by_path.has('ppt/notesSlides/notesSlide2.xml')).toBe(true);
    expect(readZip(source).by_path.has('customXml/vendor.xml')).toBe(true);

    // 待测模块读出的分节与源一致。
    const deck = openEditableDeck(source);
    expect(deckSections(deck).map((section) => [section.name, section.slide_ids])).toEqual([
      ['第一节', [256, 257]],
      ['第二节', [258]],
    ]);
    expect(deckSlides(deck).map((slide) => slide.slide_id)).toEqual([256, 257, 258]);
  });
});

// ---------------------------------------------------------------------------
// 1. 增 / 删 / 复制 / 移动：页序与「页 → 部件」一一对应
// ---------------------------------------------------------------------------

describe('P02：导入文稿的增删复制移动（页序与页→部件一一对应）', () => {
  it('插入页：新页插在指定位置，其余页内容与部件绑定不变', () => {
    const deck = openEditableDeck(buildImportedDeck());
    const inserted = insertDeckSlide(deck, { at: 2 });
    expect(inserted.page_number).toBe(2);

    const bytes = serializeEditableDeck(inserted.deck);
    expect(pageMarkers(bytes)).toEqual([1, null, 2, 3]); // 第 2 页是新的空白页
    assertPagePartBijection(bytes);
    expect(danglingRelationships(bytes)).toEqual([]);

    // 待测读侧与独立读侧一致。
    expect(deckSlides(inserted.deck).map((slide) => slide.part_path)).toEqual(readRawPages(bytes).map((page) => page.part_path));
    // 新页确实是新部件，且旧页部件没被复用。
    expect(readRawPages(bytes)[1]?.part_path).toBe('ppt/slides/slide4.xml');
  });

  it('删除页：页序收紧，剩余页的 r:id 仍指向**内容正确**的部件（不是 rId 顺移）', () => {
    const deck = openEditableDeck(buildImportedDeck());
    const next = deleteDeckSlide(deck, 2); // 删掉标记 P2 的页（slide_id=257）

    const bytes = serializeEditableDeck(next);
    expect(pageMarkers(bytes)).toEqual([1, 3]);
    assertPagePartBijection(bytes);
    // 部件数 == 2：被删页的部件**真的**被移出包，不是只从页序里摘掉。
    expect(readZip(bytes).by_path.has('ppt/slides/slide2.xml')).toBe(false);
    // 第 2 页（原 slide_id=258）承载内容 P3 —— 内容随页序，不随 slide_id 留在原位。
    expect(deckSlides(next).map((slide) => slide.slide_id)).toEqual([256, 258]);
    expect(deckSlides(next)[1]?.part_path).toBe('ppt/slides/slide3.xml');
  });

  it('复制页：副本是新部件 + 新 slide_id，落在源页之后，源页不受影响', () => {
    const deck = openEditableDeck(buildImportedDeck());
    const copied = duplicateDeckSlide(deck, 1);
    expect(copied.page_number).toBe(2);

    const bytes = serializeEditableDeck(copied.deck);
    expect(pageMarkers(bytes)).toEqual([1, 1, 2, 3]);
    assertPagePartBijection(bytes);
    expect(danglingRelationships(bytes)).toEqual([]);

    const pages = readRawPages(bytes);
    expect(pages[0]?.part_path).not.toBe(pages[1]?.part_path); // 副本是独立部件
    expect(pages[0]?.slide_id).not.toBe(pages[1]?.slide_id); // 副本是新对象引用
    expect(deckSlides(copied.deck).map((slide) => slide.part_path)).toEqual(pages.map((page) => page.part_path));
  });

  it('移动页：p:sldIdLst 顺序变化，页→部件的绑定随之更新', () => {
    const deck = openEditableDeck(buildImportedDeck());
    const moved = moveDeckSlide(deck, 1, 3); // 第 1 页移到第 3 页

    const bytes = serializeEditableDeck(moved);
    expect(pageMarkers(bytes)).toEqual([2, 3, 1]);
    assertPagePartBijection(bytes);
    // slide_id 是**对象引用**：它不随页序变，所以顺序变成 [257, 258, 256]。
    expect(readRawPages(bytes).map((page) => page.slide_id)).toEqual([257, 258, 256]);
    expect(readRawPages(bytes).map((page) => page.part_path)).toEqual([
      'ppt/slides/slide2.xml',
      'ppt/slides/slide3.xml',
      'ppt/slides/slide1.xml',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. 删除后不留悬挂关系（独立解析读回）
// ---------------------------------------------------------------------------

describe('P02：删除后的关系图完整性（独立解析，不复用待测代码自证）', () => {
  it('删中间页后：包里没有任何内部关系指向不存在的部件', () => {
    const source = buildImportedDeck();
    expect(danglingRelationships(source)).toEqual([]); // 对照：源是干净的

    const next = deleteDeckSlide(openEditableDeck(source), 2);
    const bytes = serializeEditableDeck(next);
    expect(danglingRelationships(bytes)).toEqual([]);
    // 页关系也真的少了：剩下的 rId 都能解析到真实部件。
    expect(readRawPages(bytes)).toHaveLength(2);
    expect(() => validateEditableDeck(next)).not.toThrow();
  });

  it('删带备注的页：备注部件与其 _rels 一并清掉（不留孤儿、不留悬挂）', () => {
    const source = buildImportedDeck();
    expect(readZip(source).by_path.has('ppt/notesSlides/notesSlide2.xml')).toBe(true);
    expect(readZip(source).by_path.has('ppt/notesSlides/_rels/notesSlide2.xml.rels')).toBe(true);

    const bytes = serializeEditableDeck(deleteDeckSlide(openEditableDeck(source), 2));

    expect(readZip(bytes).by_path.has('ppt/notesSlides/notesSlide2.xml')).toBe(false);
    expect(readZip(bytes).by_path.has('ppt/notesSlides/_rels/notesSlide2.xml.rels')).toBe(false);
    expect(danglingRelationships(bytes)).toEqual([]);
  });

  it('删除后仍能被往返层的导入读回（结构合法、可再打开）', () => {
    const next = deleteDeckSlide(openEditableDeck(buildImportedDeck()), 3);
    const reread = importPresentation(serializeEditableDeck(next));
    expect(reread.presentation.slides).toHaveLength(2);
    const texts = reread.presentation.slides.map((slide) => {
      const shape = slide.shapes[0];
      if (shape?.kind !== 'text_box') return '';
      const run = shape.text.paragraphs[0]?.runs[0];
      return run?.source.kind === 'literal' ? run.source.text : '';
    });
    expect(texts).toEqual(['P1', 'P2']);
  });
});

// ---------------------------------------------------------------------------
// 3. 反向对照：越界 / 不存在一律具名报错
// ---------------------------------------------------------------------------

describe('P02：反向对照——越界与不存在一律报错（不静默夹取）', () => {
  it('删除 / 复制 / 移动 / 隐藏越界页号 ⇒ invalid_page_number', () => {
    const deck = openEditableDeck(buildImportedDeck());
    expectDeckError(() => deleteDeckSlide(deck, 0), 'invalid_page_number');
    expectDeckError(() => deleteDeckSlide(deck, 4), 'invalid_page_number');
    expectDeckError(() => deleteDeckSlide(deck, 2.5), 'invalid_page_number');
    expectDeckError(() => duplicateDeckSlide(deck, 9), 'invalid_page_number');
    expectDeckError(() => moveDeckSlide(deck, 1, 4), 'invalid_page_number');
    expectDeckError(() => moveDeckSlide(deck, 0, 1), 'invalid_page_number');
    expectDeckError(() => setDeckSlideHidden(deck, 99, true), 'invalid_page_number');
  });

  it('插入位置越界 ⇒ invalid_page_number（1..页数+1 之外都拒）', () => {
    const deck = openEditableDeck(buildImportedDeck());
    expectDeckError(() => insertDeckSlide(deck, { at: 0 }), 'invalid_page_number');
    expectDeckError(() => insertDeckSlide(deck, { at: 5 }), 'invalid_page_number');
    expect(() => insertDeckSlide(deck, { at: 4 })).not.toThrow(); // 4 = 页数(3)+1，合法追加
  });

  it('未知分节 / 重复分节 / 空名 / 越界分节顺序 ⇒ 具名报错', () => {
    const deck = openEditableDeck(buildImportedDeck());
    expectDeckError(() => renameDeckSection(deck, '{不存在}', 'x'), 'unknown_section');
    expectDeckError(() => deleteDeckSection(deck, '{不存在}'), 'unknown_section');
    expectDeckError(() => createDeckSection(deck, '重复', { section_id: '{11111111-1111-1111-1111-111111111111}' }), 'duplicate_section_id');
    expectDeckError(() => createDeckSection(deck, '   '), 'empty_section_name');
    expectDeckError(() => createDeckSection(deck, 'x', { at: 5 }), 'invalid_section_order');
    expectDeckError(() => moveDeckSection(deck, '{11111111-1111-1111-1111-111111111111}', 9), 'invalid_section_order');
    expectDeckError(() => assignDeckSlideToSection(deck, 1, '{不存在}'), 'unknown_section');
  });

  it('分节里引用不存在的 slide_id ⇒ unknown_slide（不静默留下坏引用）', () => {
    const deck = openEditableDeck(buildImportedDeck());
    expectDeckError(() => createDeckSection(deck, '坏节', { slide_ids: [999] }), 'unknown_slide');
  });
});

// ---------------------------------------------------------------------------
// 4. 隐藏 / 显示
// ---------------------------------------------------------------------------

describe('P02：导入文稿的隐藏与显示', () => {
  it('隐藏写进 p:sld@show="0"，独立读回可见；取消后属性被移除（反向对照：未隐藏页不含该属性）', () => {
    const deck = openEditableDeck(buildImportedDeck());
    const hidden = setDeckSlideHidden(deck, 2, true);

    const hiddenBytes = serializeEditableDeck(hidden);
    const partPath = readRawPages(hiddenBytes)[1]!.part_path;
    expect(textOf(hiddenBytes, partPath)).toContain('show="0"');
    // 其它页不受影响。
    expect(textOf(hiddenBytes, 'ppt/slides/slide1.xml')).not.toContain('show="0"');
    // 往返层读回为"已隐藏"。
    expect(importPresentation(hiddenBytes).presentation.slides[1]?.hidden).toBe(true);

    const shown = setDeckSlideHidden(hidden, 2, false);
    const shownBytes = serializeEditableDeck(shown);
    expect(textOf(shownBytes, partPath)).not.toContain('show="0"');
    expect(importPresentation(shownBytes).presentation.slides[1]?.hidden).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. 分节：新增 / 改名 / 移动；与页序一致
// ---------------------------------------------------------------------------

describe('P02：导入文稿的分节（新增 / 改名 / 移动，且与页序一致）', () => {
  it('新建分节并归页：分节内页序升序，且包能被独立解析出同样的节', () => {
    let deck = openEditableDeck(buildImportedDeck());
    // 先归 3 再归 1 ⇒ 分节内仍按页序 [256, 258]。
    const created = createDeckSection(deck, '新节', { section_id: '{33333333-3333-3333-3333-333333333333}' });
    deck = created.deck;
    deck = assignDeckSlideToSection(deck, 3, created.section_id);
    deck = assignDeckSlideToSection(deck, 1, created.section_id);

    const section = deckSections(deck).find((candidate) => candidate.section_id === created.section_id);
    expect(section?.slide_ids).toEqual([256, 258]); // 先归 3 再归 1 ⇒ 仍按页序
    // 一页至多属于一个分节：页 1 已从"第一节"摘出。
    expect(deckSections(deck).find((candidate) => candidate.section_id === '{11111111-1111-1111-1111-111111111111}')?.slide_ids).toEqual([257]);

    const bytes = serializeEditableDeck(deck);
    expect(() => validateEditableDeck(deck)).not.toThrow();
    // 独立解析：文本里确实出现了新节名与它的两个页 id。
    const presXml = textOf(bytes, 'ppt/presentation.xml');
    expect(presXml).toContain('name="新节"');
    expect(presXml).toContain('<p14:sldId id="256"/><p14:sldId id="258"/>');
  });

  it('改名与移动分节：名称与节顺序都变，且读回一致', () => {
    let deck = openEditableDeck(buildImportedDeck());
    const first = '{11111111-1111-1111-1111-111111111111}';
    const second = '{22222222-2222-2222-2222-222222222222}';

    deck = renameDeckSection(deck, first, '改过名的节');
    expect(deckSections(deck).map((section) => section.name)).toEqual(['改过名的节', '第二节']);

    deck = moveDeckSection(deck, first, 1); // 移到第二个位置
    expect(deckSections(deck).map((section) => section.section_id)).toEqual([second, first]);
    expect(() => validateEditableDeck(deck)).not.toThrow();
  });

  it('删页后：分节不再引用已删页，节内页序仍升序（反向对照：残留已删 id 会被复核挡下）', () => {
    const deck = openEditableDeck(buildImportedDeck());
    const first = '{11111111-1111-1111-1111-111111111111}';
    const next = deleteDeckSlide(deck, 2); // 删掉 257（原属"第一节"）

    expect(deckSections(next).find((section) => section.section_id === first)?.slide_ids).toEqual([256]);
    expect(() => validateEditableDeck(next)).not.toThrow();

    // 反向对照：人工把已删页的 slide_id 塞回分节 ⇒ 复核必须报 unknown_slide（不是恒真）。
    const archive = readZip(serializeEditableDeck(next));
    const entries: ZipLikeEntry[] = archive.entries.map((entry) => ({ path: entry.path, data: entry.data }));
    const presIndex = entries.findIndex((entry) => entry.path === 'ppt/presentation.xml');
    const patched = Buffer.from(entries[presIndex]!.data)
      .toString('utf8')
      .replace('<p14:sldId id="256"/>', '<p14:sldId id="256"/><p14:sldId id="257"/>');
    entries[presIndex] = { path: 'ppt/presentation.xml', data: utf8Bytes(patched) };
    expectDeckError(() => validateEditableDeck(openEditableDeck(writeZip(entries))), 'unknown_slide');
  });

  it('移动页后：分节成员不变，但节内页序按新页序重排', () => {
    const deck = openEditableDeck(buildImportedDeck());
    const first = '{11111111-1111-1111-1111-111111111111}';
    // 把第 3 页（258，属第二节）移到第 1 页；第一节成员 [256,257] 不变但仍是升序。
    const moved = moveDeckSlide(deck, 3, 1);
    expect(deckSections(moved).find((section) => section.section_id === first)?.slide_ids).toEqual([256, 257]);
    expect(() => validateEditableDeck(moved)).not.toThrow();
  });

  it('删除分节：分节消失，页保留', () => {
    const deck = openEditableDeck(buildImportedDeck());
    const next = deleteDeckSection(deck, '{22222222-2222-2222-2222-222222222222}');
    expect(deckSections(next).map((section) => section.section_id)).toEqual(['{11111111-1111-1111-1111-111111111111}']);
    expect(deckSlides(next)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 6. 不静默丢弃既有节点
// ---------------------------------------------------------------------------

describe('P02：不静默丢弃既有节点（保留，或明确报错）', () => {
  it('厂商自定义部件与母版 / 主题 / 版式在增删页后逐字节保留', () => {
    const source = buildImportedDeck();
    const sourceArchive = readZip(source);
    const next = duplicateDeckSlide(openEditableDeck(source), 1).deck;
    const bytes = serializeEditableDeck(next);
    const after = readZip(bytes);

    for (const path of ['customXml/vendor.xml', 'ppt/slideMasters/slideMaster1.xml', 'ppt/theme/theme1.xml', 'ppt/notesMasters/notesMaster1.xml']) {
      const before = sourceArchive.by_path.get(path);
      const now = after.by_path.get(path);
      expect(before).toBeDefined();
      expect(now).toBeDefined();
      expect(Buffer.compare(Buffer.from(now!.data), Buffer.from(before!.data))).toBe(0);
    }
    expect(danglingRelationships(bytes)).toEqual([]);
  });

  it('复制带备注的页：副本有**自己的**备注部件（备注与页是一对一，不共用）', () => {
    const deck = openEditableDeck(buildImportedDeck());
    const copied = duplicateDeckSlide(deck, 2); // 第 2 页带 notesSlide2.xml
    const bytes = serializeEditableDeck(copied.deck);
    const after = readZip(bytes);

    expect(after.by_path.has('ppt/notesSlides/notesSlide2.xml')).toBe(true);
    // 新备注部件确实被建出来（编号大于源）。
    const notesParts = [...after.by_path.keys()].filter((path) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(path));
    expect(notesParts.length).toBe(2);
    expect(danglingRelationships(bytes)).toEqual([]);
    expect(() => validateEditableDeck(copied.deck)).not.toThrow();

    // 独立核对：副本（第 3 页）的 _rels 指向的是**新**备注部件，不是源页的那一份。
    const newPart = readRawPages(bytes)[2]!.part_path;
    const slideRelsPath = newPart.replace(/([^/]+)$/, '_rels/$1.rels');
    const notesTarget = readRelsOf(textOf(bytes, slideRelsPath)).find((rel) => rel.target.includes('notesSlides/'));
    expect(notesTarget?.target).not.toContain('notesSlide2.xml');
  });

  it('删除被自定义放映引用的页 ⇒ 明确报错 custom_show_reference（不偷偷改放映内容）', () => {
    const source = buildImportedDeck({ customShowPage: 2 });
    expect(textOf(source, 'ppt/presentation.xml')).toContain('<p:custShowLst>');

    const deck = openEditableDeck(source);
    expectDeckError(() => deleteDeckSlide(deck, 2), 'custom_show_reference');
    // 反向对照：删**没有**被放映引用的页是允许的，且放映节点原样保留。
    const next = deleteDeckSlide(deck, 1);
    const bytes = serializeEditableDeck(next);
    expect(textOf(bytes, 'ppt/presentation.xml')).toContain('<p:custShowLst>');
    expect(danglingRelationships(bytes)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. 复核器本身
// ---------------------------------------------------------------------------

describe('P02：validateEditableDeck 能真的发现坏结构', () => {
  it('人工造一个"关系指向不存在部件"的包 ⇒ dangling_relationship', () => {
    const source = buildImportedDeck();
    const archive = readZip(source);
    const entries: ZipLikeEntry[] = archive.entries.map((entry) => ({ path: entry.path, data: entry.data }));
    const relsIndex = entries.findIndex((entry) => entry.path === 'ppt/_rels/presentation.xml.rels');
    const relsXml = Buffer.from(entries[relsIndex]!.data)
      .toString('utf8')
      .replace('</Relationships>', '<Relationship Id="rId999" Type="x/slide" Target="slides/slide99.xml"/></Relationships>');
    entries[relsIndex] = { path: 'ppt/_rels/presentation.xml.rels', data: utf8Bytes(relsXml) };

    const broken = openEditableDeck(writeZip(entries));
    // 独立解析器与复核器都应当发现它（前者是本文件自己的实现，不是待测代码）。
    expect(danglingRelationships(writeZip(entries))).toEqual([
      'ppt/_rels/presentation.xml.rels 的关系 rId999 → ppt/slides/slide99.xml',
    ]);
    expectDeckError(() => validateEditableDeck(broken), 'dangling_relationship');
  });
});

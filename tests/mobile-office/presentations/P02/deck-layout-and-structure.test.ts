/**
 * P02-slide-ops：**导入文稿上的版式切换** + 结构快照/差异 + 操作清单。
 *
 * ## 这一批补的缺口
 *
 * `imported-slide-ops.test.ts` 已覆盖导入包的增 / 删 / 复制 / 移动 / 隐藏 / 分节，
 * 但**没有版式切换**——包级层（`EditableDeck`）此前根本没有这个操作，尽管 PPT-02 的
 * 独立验收写明"增删复制移动、隐藏/分节/版式；导入文稿同样适用"。本批补上：
 *
 * - `setDeckSlideLayout` / `setDeckSlideLayoutByName`：改该页 `_rels` 里 slideLayout
 *   关系的 Target（页部件正文不写版式路径，所以只能改关系）。
 * - `listDeckLayouts` / `deckSlideLayoutPath`：枚举包内版式、读某页当前版式。
 *
 * ## 判据一律走**独立解析**，不复用待测代码自证
 *
 * 本文件自实现 `slideLayoutTargetOfPage`（直接读幻灯片 `_rels` 的 slideLayout Target）、
 * `rawPageIds`（直接读 `p:sldIdLst`）、`danglingRelationships`（遍历所有 `.rels`）。
 * 待测的 `deckSlideLayoutPath` / `validateEditableDeck` 只作**额外**断言。
 *
 * ## 反向对照
 *
 * 换版式**不得**动页序 / 分节 / 其它页字节；指向不存在的版式一律 `unknown_layout`。
 */

import { describe, expect, it } from 'vitest';

import { readZip, utf8Bytes, writeZip } from '../../../../src/artifacts/ooxml/index.js';
import { literalText, transform, type Presentation, type Shape } from '../../../../src/presentations/model.js';
import { addShape, addSlide, setSlideLayout, setSlideNotes } from '../../../../src/presentations/operations.js';
import { emptyPresentation, renderPresentation } from '../../../../src/presentations/render.js';
import { importPresentation } from '../../../../src/presentations/roundtrip.js';
import {
  DeckEditError,
  assignDeckSlideToSection,
  createDeckSection,
  deckSections,
  deckSlideLayoutPath,
  deckSlides,
  deleteDeckSlide,
  insertDeckSlide,
  listDeckLayouts,
  moveDeckSlide,
  openEditableDeck,
  renameDeckSection,
  serializeEditableDeck,
  setDeckSlideLayout,
  setDeckSlideLayoutByName,
  validateEditableDeck,
  type DeckEditErrorReason,
} from '../../../../src/presentations/slide-ops.js';
import {
  compareStructure,
  isStructureUnchanged,
  operationSchema,
  slideOperationKinds,
  snapshotDeckStructure,
  snapshotPresentationStructure,
  SLIDE_OPERATION_SCHEMAS,
} from '../../../../src/presentations/slide-structure/index.js';

// ---------------------------------------------------------------------------
// 独立解析器（**不复用**待测模块）
// ---------------------------------------------------------------------------

interface Entry {
  readonly path: string;
  readonly data: Uint8Array;
}

function entriesOf(bytes: Uint8Array): readonly Entry[] {
  return readZip(bytes).entries.map((entry) => ({ path: entry.path, data: entry.data }));
}

function textOf(bytes: Uint8Array, path: string): string {
  const entry = entriesOf(bytes).find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`包内没有部件 ${path}`);
  return Buffer.from(entry.data).toString('utf8');
}

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

function relsBaseDirOf(relsPath: string): string {
  if (relsPath === '_rels/.rels') return '';
  const cut = relsPath.lastIndexOf('/_rels/');
  return cut < 0 ? '' : relsPath.slice(0, cut);
}

function relsOf(text: string): readonly { id: string; type: string; target: string; external: boolean }[] {
  const out: { id: string; type: string; target: string; external: boolean }[] = [];
  for (const match of text.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const tag = match[0] ?? '';
    const id = /\bId\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    const type = /\bType\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    const target = /\bTarget\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    if (id === undefined || type === undefined || target === undefined) continue;
    out.push({ id, type, target, external: /TargetMode\s*=\s*"External"/.test(tag) });
  }
  return out;
}

/** 页部件路径 → 其 `_rels` 路径。 */
function relsPathOfPart(partPath: string): string {
  const cut = partPath.lastIndexOf('/');
  const dir = cut < 0 ? '' : partPath.slice(0, cut);
  const base = cut < 0 ? partPath : partPath.slice(cut + 1);
  return dir === '' ? `_rels/${base}.rels` : `${dir}/_rels/${base}.rels`;
}

/** 直接读页序（`p:sldIdLst` 的 slide_id 列表）。 */
function rawPageIds(bytes: Uint8Array): readonly number[] {
  const block = /<p:sldIdLst\b[^>]*>([\s\S]*?)<\/p:sldIdLst>/.exec(textOf(bytes, 'ppt/presentation.xml'));
  const ids: number[] = [];
  for (const match of (block?.[1] ?? '').matchAll(/<p:sldId\b[^>]*\/?>/g)) {
    const id = /(?<![\w:])id\s*=\s*"([^"]*)"/.exec(match[0] ?? '')?.[1];
    if (id !== undefined) ids.push(Number(id));
  }
  return ids;
}

/** 页序 → 页部件路径（读 sldIdLst + presentation.xml.rels，独立解析）。 */
function rawPageParts(bytes: Uint8Array): readonly string[] {
  const rels = relsOf(textOf(bytes, 'ppt/_rels/presentation.xml.rels'));
  const byId = new Map(rels.map((rel) => [rel.id, rel] as const));
  const block = /<p:sldIdLst\b[^>]*>([\s\S]*?)<\/p:sldIdLst>/.exec(textOf(bytes, 'ppt/presentation.xml'));
  const parts: string[] = [];
  for (const match of (block?.[1] ?? '').matchAll(/<p:sldId\b[^>]*\/?>/g)) {
    const relId = /\br:id\s*=\s*"([^"]*)"/.exec(match[0] ?? '')?.[1];
    const rel = relId === undefined ? undefined : byId.get(relId);
    if (rel === undefined) throw new Error(`p:sldId@r:id=${String(relId)} 无对应关系`);
    parts.push(resolveTarget('ppt', rel.target));
  }
  return parts;
}

/** 某页 `_rels` 里 slideLayout 关系指向的部件（缺 ⇒ `null`）。独立解析。 */
function slideLayoutTargetOfPage(bytes: Uint8Array, pagePartPath: string): string | null {
  const relsText = textOf(bytes, relsPathOfPart(pagePartPath));
  const baseDir = pagePartPath.slice(0, pagePartPath.lastIndexOf('/'));
  for (const rel of relsOf(relsText)) {
    if (rel.external) continue;
    const resolved = resolveTarget(baseDir, rel.target);
    if (/\/slideLayouts\/slideLayout[^/]*\.xml$/.test(resolved)) return resolved;
  }
  return null;
}

/** 遍历所有 `.rels`，返回指向不存在部件的内部关系（空 = 无悬挂）。 */
function danglingRelationships(bytes: Uint8Array): readonly string[] {
  const entries = entriesOf(bytes);
  const present = new Set(entries.map((entry) => entry.path));
  const bad: string[] = [];
  for (const entry of entries) {
    if (!entry.path.endsWith('.rels')) continue;
    const baseDir = relsBaseDirOf(entry.path);
    for (const rel of relsOf(Buffer.from(entry.data).toString('utf8'))) {
      if (rel.external) continue;
      const resolved = resolveTarget(baseDir, rel.target);
      if (!present.has(resolved)) bad.push(`${entry.path} ${rel.id} → ${resolved}`);
    }
  }
  return bad;
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
// 装置：造一份**含两种版式**的导入源（页 1/3 = blank，页 2 = title_and_content）
// ---------------------------------------------------------------------------

function marker(text: string): Shape {
  return {
    kind: 'text_box',
    shape_id: 2,
    name: text,
    transform: transform(0, 0, 1000000, 500000),
    text: literalText(text),
  };
}

const SECTION_A = '{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa}';
const SECTION_B = '{bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb}';

/**
 * 造导入源：3 页（页 1/3 用 blank 版式、页 2 用 title_and_content），页 2 带备注，
 * 两个分节（A = 页 1-2，B = 页 3）由**字符串手术**注入（不经待测写函数）。
 */
function buildSourceWithLayouts(): Uint8Array {
  let deck: Presentation = emptyPresentation('src', '版式源');
  const layouts = [
    { master_id: 'master1', layout_id: 'blank' },
    { master_id: 'master1', layout_id: 'title_and_content' },
    { master_id: 'master1', layout_id: 'blank' },
  ];
  for (let i = 0; i < 3; i += 1) {
    const added = addSlide(deck);
    deck = added.presentation;
    deck = setSlideLayout(deck, added.slide_id, layouts[i]!);
    deck = addShape(deck, added.slide_id, marker(`P${String(i + 1)}`));
  }
  deck = setSlideNotes(deck, 2, literalText('备注二'));

  const rendered = renderPresentation(deck);
  const entries = entriesOf(rendered.bytes);

  const pages = rawPageParts(rendered.bytes);
  const ids = rawPageIds(rendered.bytes);
  const sections =
    '<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}">' +
    `<p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">` +
    `<p14:section name="第一节" id="${SECTION_A}"><p14:sldIdLst>` +
    `<p14:sldId id="${String(ids[0])}"/><p14:sldId id="${String(ids[1])}"/></p14:sldIdLst></p14:section>` +
    `<p14:section name="第二节" id="${SECTION_B}"><p14:sldIdLst>` +
    `<p14:sldId id="${String(ids[2])}"/></p14:sldIdLst></p14:section>` +
    `</p14:sectionLst></p:ext></p:extLst>`;
  void pages;

  const index = entries.findIndex((entry) => entry.path === 'ppt/presentation.xml');
  const patched = Buffer.from(entries[index]!.data)
    .toString('utf8')
    .replace('</p:presentation>', `${sections}</p:presentation>`);
  const next = entries.map((entry, i) => (i === index ? { path: entry.path, data: utf8Bytes(patched) } : entry));
  return writeZip(next);
}

function partOfPage(bytes: Uint8Array, pageNumber: number): string {
  const part = rawPageParts(bytes)[pageNumber - 1];
  if (part === undefined) throw new Error(`没有第 ${String(pageNumber)} 页`);
  return part;
}

// ---------------------------------------------------------------------------
// 0. 源装置自检
// ---------------------------------------------------------------------------

describe('P02-版式：导入源含两种版式且干净', () => {
  it('页 1/3 引用 slideLayout1，页 2 引用 slideLayout2；无悬挂关系', () => {
    const source = buildSourceWithLayouts();
    const parts = rawPageParts(source);
    expect(slideLayoutTargetOfPage(source, parts[0]!)).toBe('ppt/slideLayouts/slideLayout1.xml');
    expect(slideLayoutTargetOfPage(source, parts[1]!)).toBe('ppt/slideLayouts/slideLayout2.xml');
    expect(slideLayoutTargetOfPage(source, parts[2]!)).toBe('ppt/slideLayouts/slideLayout1.xml');
    expect(danglingRelationships(source)).toEqual([]);
    expect(readZip(source).by_path.has('ppt/slideLayouts/slideLayout2.xml')).toBe(true);
  });

  it('listDeckLayouts 枚举出两个版式，名字与母版正确', () => {
    const layouts = listDeckLayouts(openEditableDeck(buildSourceWithLayouts()));
    expect(layouts.map((layout) => layout.part_path)).toEqual([
      'ppt/slideLayouts/slideLayout1.xml',
      'ppt/slideLayouts/slideLayout2.xml',
    ]);
    expect(layouts.map((layout) => layout.name)).toEqual(['Blank', 'title_and_content']);
    expect(layouts.every((layout) => layout.master_path === 'ppt/slideMasters/slideMaster1.xml')).toBe(true);
  });

  it('deckSlideLayoutPath 逐页读出当前版式（与独立解析一致）', () => {
    const source = buildSourceWithLayouts();
    const deck = openEditableDeck(source);
    const parts = rawPageParts(source);
    for (let page = 1; page <= 3; page += 1) {
      expect(deckSlideLayoutPath(deck, page)).toBe(slideLayoutTargetOfPage(source, parts[page - 1]!));
    }
  });
});

// ---------------------------------------------------------------------------
// 1. 换版式：只动目标页的 _rels，页序 / 分节 / 其它页一律不动
// ---------------------------------------------------------------------------

describe('P02-版式：导入文稿上的版式切换', () => {
  it('换版式改的正是该页 _rels 的 slideLayout Target，其它页字节不变', () => {
    const source = buildSourceWithLayouts();
    const deck = openEditableDeck(source);
    const target = partOfPage(source, 1);

    const switched = setDeckSlideLayout(deck, 1, 'ppt/slideLayouts/slideLayout2.xml');
    const bytes = serializeEditableDeck(switched);

    // 独立解析：第 1 页现在真的指向 slideLayout2。
    expect(slideLayoutTargetOfPage(bytes, partOfPage(bytes, 1))).toBe('ppt/slideLayouts/slideLayout2.xml');
    // 第 2/3 页的 _rels 未被触碰（逐字节不变）。
    for (const page of [2, 3]) {
      const part = partOfPage(source, page);
      expect(readZip(bytes).by_path.get(relsPathOfPart(part))!.data).toEqual(
        readZip(source).by_path.get(relsPathOfPart(part))!.data,
      );
    }
    expect(danglingRelationships(bytes)).toEqual([]);
    expect(() => validateEditableDeck(switched)).not.toThrow();
  });

  it('换版式后：页序与分节成员完全不变（反向对照：拿版式当页序会露馅）', () => {
    const source = buildSourceWithLayouts();
    const deck = openEditableDeck(source);
    const beforeIds = rawPageIds(source);
    const beforeSections = deckSections(deck).map((section) => [section.section_id, section.name, [...section.slide_ids]]);

    const switched = setDeckSlideLayout(deck, 2, 'ppt/slideLayouts/slideLayout1.xml');
    const bytes = serializeEditableDeck(switched);

    expect(rawPageIds(bytes)).toEqual(beforeIds);
    expect(deckSections(switched).map((section) => [section.section_id, section.name, [...section.slide_ids]])).toEqual(
      beforeSections,
    );
    // 只有第 2 页的版式引用变了。
    expect(slideLayoutTargetOfPage(bytes, partOfPage(bytes, 2))).toBe('ppt/slideLayouts/slideLayout1.xml');
    expect(slideLayoutTargetOfPage(bytes, partOfPage(bytes, 3))).toBe('ppt/slideLayouts/slideLayout1.xml');
  });

  it('换版式后能被往返层读回：importPresentation 的 layout_id 随关系更新', () => {
    const deck = openEditableDeck(buildSourceWithLayouts());
    const switched = setDeckSlideLayout(deck, 1, 'ppt/slideLayouts/slideLayout2.xml');
    const reread = importPresentation(serializeEditableDeck(switched));
    expect(reread.presentation.slides[0]?.layout.layout_id).toBe('slideLayout2');
    // 反向对照：第 2 页本来就是 slideLayout2，未受第 1 页切换影响。
    expect(reread.presentation.slides[1]?.layout.layout_id).toBe('slideLayout2');
    expect(reread.presentation.slides[2]?.layout.layout_id).toBe('slideLayout1');
  });

  it('按名字切换：命中就换，未知名具名报错 unknown_layout', () => {
    const deck = openEditableDeck(buildSourceWithLayouts());
    const bytes = serializeEditableDeck(setDeckSlideLayoutByName(deck, 3, 'title_and_content'));
    expect(slideLayoutTargetOfPage(bytes, partOfPage(bytes, 3))).toBe('ppt/slideLayouts/slideLayout2.xml');
    expectDeckError(() => setDeckSlideLayoutByName(deck, 1, '不存在的版式'), 'unknown_layout');
  });

  it('指向不存在的版式部件 ⇒ unknown_layout（不写出悬挂关系）', () => {
    const deck = openEditableDeck(buildSourceWithLayouts());
    expectDeckError(() => setDeckSlideLayout(deck, 1, 'ppt/slideLayouts/slideLayout99.xml'), 'unknown_layout');
    expectDeckError(() => setDeckSlideLayout(deck, 1, 'ppt/notALayout.xml'), 'unknown_layout');
  });

  it('对同一页重复切到同一个版式是幂等的（_rels 不重复堆关系）', () => {
    const deck = openEditableDeck(buildSourceWithLayouts());
    const once = setDeckSlideLayout(deck, 1, 'ppt/slideLayouts/slideLayout2.xml');
    const twice = setDeckSlideLayout(once, 1, 'ppt/slideLayouts/slideLayout2.xml');
    const bytes = serializeEditableDeck(twice);
    const relsText = textOf(bytes, relsPathOfPart(partOfPage(bytes, 1)));
    const layoutRels = relsOf(relsText).filter((rel) => rel.target.includes('slideLayout'));
    expect(layoutRels).toHaveLength(1);
    expect(() => validateEditableDeck(twice)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. 结构快照 / 差异
// ---------------------------------------------------------------------------

describe('P02-结构：快照与差异如实反映"页序/节/引用"', () => {
  it('换版式 ⇒ 差异只在 references_changed，页序与分节都不动', () => {
    const deck = openEditableDeck(buildSourceWithLayouts());
    const before = snapshotDeckStructure(deck);
    const after = snapshotDeckStructure(setDeckSlideLayout(deck, 1, 'ppt/slideLayouts/slideLayout2.xml'));

    const delta = compareStructure(before, after);
    expect(delta.page_order_changed).toBe(false);
    expect(delta.pages_inserted).toEqual([]);
    expect(delta.pages_deleted).toEqual([]);
    expect(delta.pages_moved).toEqual([]);
    expect(delta.references_changed).toHaveLength(1);
    expect(delta.references_changed[0]).toMatchObject({
      field: 'layout',
      from: 'ppt/slideLayouts/slideLayout1.xml',
      to: 'ppt/slideLayouts/slideLayout2.xml',
    });
    expect(isStructureUnchanged(delta)).toBe(false);
  });

  it('增 / 删 / 移页 ⇒ 差异分别报 inserted / deleted / moved（按 slide_id 对齐）', () => {
    const deck = openEditableDeck(buildSourceWithLayouts());
    const base = snapshotDeckStructure(deck);

    const inserted = snapshotDeckStructure(insertDeckSlide(deck, { at: 2 }).deck);
    const insDelta = compareStructure(base, inserted);
    expect(insDelta.pages_inserted).toHaveLength(1);
    expect(insDelta.pages_deleted).toEqual([]);
    expect(insDelta.page_order_changed).toBe(true);

    const removedId = deckSlides(deck)[1]!.slide_id;
    const deleted = snapshotDeckStructure(deleteDeckSlide(deck, 2));
    const delDelta = compareStructure(base, deleted);
    expect(delDelta.pages_deleted).toEqual([removedId]);
    // 删中间页会让后面的页页码前移 —— 应报成 moved（不是内容变化）。
    expect(delDelta.pages_moved.length).toBeGreaterThanOrEqual(1);

    const moved = snapshotDeckStructure(moveDeckSlide(deck, 1, 3));
    const movDelta = compareStructure(base, moved);
    expect(movDelta.pages_inserted).toEqual([]);
    expect(movDelta.pages_deleted).toEqual([]);
    // [256,257,258] → 把页 1 移到页 3 → [257,258,256]：三页页码全变，故三页都报 moved。
    expect(movDelta.pages_moved).toHaveLength(3);
    expect(movDelta.page_order_changed).toBe(true);
  });

  it('分节差异：改名 / 成员变化 / 增删节分开报', () => {
    const deck = openEditableDeck(buildSourceWithLayouts());
    const base = snapshotDeckStructure(deck);

    const renamed = compareStructure(base, snapshotDeckStructure(renameDeckSection(deck, SECTION_A, '新名字')));
    expect(renamed.sections.renamed).toEqual([{ section_id: SECTION_A, from: '第一节', to: '新名字' }]);
    expect(renamed.page_order_changed).toBe(false);

    const reassigned = compareStructure(base, snapshotDeckStructure(assignDeckSlideToSection(deck, 3, SECTION_A)));
    expect(reassigned.sections.membership_changed.some((change) => change.section_id === SECTION_A)).toBe(true);

    const created = compareStructure(base, snapshotDeckStructure(createDeckSection(deck, '第三节').deck));
    expect(created.sections.added).toHaveLength(1);
  });

  it('无改动快照 ⇒ isStructureUnchanged 为真（证明上面不是恒假）', () => {
    const deck = openEditableDeck(buildSourceWithLayouts());
    const delta = compareStructure(snapshotDeckStructure(deck), snapshotDeckStructure(deck));
    expect(isStructureUnchanged(delta)).toBe(true);
  });

  it('对象模型快照：page_number 恒等于索引 +1，引用形状为 master/layout', () => {
    const presentation = addSlide(emptyPresentation('m', '模型')).presentation;
    const snapshot = snapshotPresentationStructure(presentation);
    expect(snapshot.pages.length).toBeGreaterThan(0);
    snapshot.pages.forEach((page, index) => {
      expect(page.page_number).toBe(index + 1);
    });
    expect(snapshot.pages[0]?.layout_ref).toContain('/');
  });
});

// ---------------------------------------------------------------------------
// 3. 操作清单（schemas）
// ---------------------------------------------------------------------------

describe('P02-结构：操作清单是自洽的单一真相源', () => {
  it('每个 model 操作都有对应 deck 操作（"导入文稿同样适用"的机器可核判据）', () => {
    const kinds = slideOperationKinds();
    for (const kind of kinds) {
      const tiers = SLIDE_OPERATION_SCHEMAS.filter((schema) => schema.kind === kind).map((schema) => schema.tier);
      const hasModel = tiers.includes('model');
      const hasDeck = tiers.includes('deck');
      if (hasModel) expect(hasDeck).toBe(true);
      // 作用层内的 kind 不重复。
      expect(tiers.length).toBe(new Set(tiers).size);
    }
  });

  it('每个规格都有非空字段描述；set_slide_layout 的 deck 层要求版式部件路径', () => {
    for (const schema of SLIDE_OPERATION_SCHEMAS) {
      expect(schema.summary.length).toBeGreaterThan(0);
      for (const field of schema.payload) {
        expect(field.description.length).toBeGreaterThan(0);
      }
    }
    const deckLayout = operationSchema('set_slide_layout', 'deck');
    expect(deckLayout.payload.map((field) => field.type)).toContain('layout_part_path');
    expect(deckLayout.payload.find((field) => field.type === 'layout_part_path')?.required).toBe(true);
  });

  it('未知 kind+tier 组合抛错（清单是唯一来源）', () => {
    expect(() => operationSchema('move_section', 'model')).toThrow();
  });
});

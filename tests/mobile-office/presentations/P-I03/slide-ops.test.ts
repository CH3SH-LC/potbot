/**
 * P-I03 · `slide-ops.ts` 集成切片：**删页回收孤儿媒体** + **分组版式应用** + **连同页移动分节**。
 *
 * ## 这一批钉死的真实缺陷（P-R04 CONFIRMED）
 *
 * `deleteDeckSlide` 原本只摘 `p:sldIdLst` / 删页部件与其 `_rels` / 删仅供该页的备注部件，
 * **不回收仅供该页使用的媒体部件**——删完页后包内留下 `orphan_media_part` 字节
 * （`tests/mobile-office/presentations/P-R04/opc-graph.ts` 的独立检出即为此而写）。
 * 本批把"孤立媒体"回收补上：删页时丢弃**被该页 `_rels` 引用、且丢页后没有任何剩余 `_rels`
 * 再引用**的媒体部件。
 *
 * ## 判据独立于实现（本文件的核心）
 *
 * 断言不调用待测代码去"自证"：本文件自带一套极简 ZIP 条目读取 + 关系扫描 + 相对路径求解，
 * 直接回答"包里还有哪些媒体部件 / 谁在引用它 / 有无悬挂关系 / blip 的 r:embed 落到哪"。
 * `validateEditableDeck` 只作为**额外**断言。
 *
 * ## 反向对照（每条都能咬）
 *
 * - 只回收**孤儿**媒体：仍被任何存活页引用的媒体**一张都不许删**（否则某条断言变红）；
 * - 删的页若其图仍被别页引用 ⇒ 一张都不回收；
 * - 分组版式应用只改目标页的 slideLayout 关系，页序 / 分节 / 其它页不动；
 * - 连同页移动分节后，块成为连续段、块内相对顺序与分节成员不变。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/index.js';
import { literalText, transform, type Presentation, type Shape } from '../../../../src/presentations/model.js';
import { addShape, addSlide, setSlideLayout } from '../../../../src/presentations/operations.js';
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
  listDeckLayouts,
  moveDeckSectionWithPages,
  openEditableDeck,
  serializeEditableDeck,
  setDeckLayoutForSlides,
  setDeckLayoutForSlidesByName,
  validateEditableDeck,
  type DeckEditErrorReason,
} from '../../../../src/presentations/slide-ops.js';

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

function dirOf(partPath: string): string {
  const cut = partPath.lastIndexOf('/');
  return cut < 0 ? '' : partPath.slice(0, cut);
}

function relsPathOfPart(partPath: string): string {
  return `${dirOf(partPath) === '' ? '' : `${dirOf(partPath)}/`}_rels/${partPath.slice(partPath.lastIndexOf('/') + 1)}.rels`;
}

function relsBaseDirOf(relsPath: string): string {
  if (relsPath === '_rels/.rels') return '';
  const cut = relsPath.lastIndexOf('/_rels/');
  return cut < 0 ? '' : relsPath.slice(0, cut);
}

/** 相对 `Target` → 包内路径（自己实现，不用待测代码）。 */
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

interface RawRel {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly external: boolean;
}

function relsOf(text: string): readonly RawRel[] {
  const out: RawRel[] = [];
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

/** 页序真相源：`p:sldIdLst` 的 slide_id 列表。 */
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
  const byId = new Map(relsOf(textOf(bytes, 'ppt/_rels/presentation.xml.rels')).map((rel) => [rel.id, rel] as const));
  const block = /<p:sldIdLst\b[^>]*>([\s\S]*?)<\/p:sldIdLst>/.exec(textOf(bytes, 'ppt/presentation.xml'));
  const parts: string[] = [];
  for (const match of (block?.[1] ?? '').matchAll(/<p:sldId\b[^>]*\/?>/g)) {
    const relId = /\br:id\s*=\s*"([^"]*)"/.exec(match[0] ?? '')?.[1];
    const rel = relId === undefined ? undefined : byId.get(relId);
    if (rel === undefined) throw new Error(`p:sldId@r:id=${String(relId)} 没有对应关系`);
    parts.push(resolveTarget('ppt', rel.target));
  }
  return parts;
}

/** 每页部件里的 `<a:t>P<n></a:t>` 标记（用来断言"第几页装的是哪页内容"）。 */
function pageMarkers(bytes: Uint8Array): readonly (number | null)[] {
  return rawPageParts(bytes).map((part) => {
    const marker = /<a:t>P(\d+)<\/a:t>/.exec(textOf(bytes, part));
    return marker === null ? null : Number(marker[1]);
  });
}

/** 全包内的悬挂关系（内部 Target 解析后不在包里）。 */
function danglingRelationships(bytes: Uint8Array): readonly string[] {
  const present = new Set(entriesOf(bytes).map((entry) => entry.path));
  const out: string[] = [];
  for (const entry of entriesOf(bytes)) {
    if (!entry.path.endsWith('.rels')) continue;
    const baseDir = relsBaseDirOf(entry.path);
    for (const rel of relsOf(Buffer.from(entry.data).toString('utf8'))) {
      if (rel.external) continue;
      const resolved = resolveTarget(baseDir, rel.target);
      if (!present.has(resolved)) out.push(`${entry.path} 的关系 ${rel.id} → ${resolved}`);
    }
  }
  return out;
}

/** 包内全部 `ppt/media/**` 部件路径。 */
function mediaPartsIn(bytes: Uint8Array): readonly string[] {
  return entriesOf(bytes)
    .map((entry) => entry.path)
    .filter((path) => path.startsWith('ppt/media/'))
    .sort();
}

/** 独立判定的**孤儿媒体**：包里有、但没有任何非外部关系指向它。 */
function orphanMediaParts(bytes: Uint8Array): readonly string[] {
  const referenced = new Set<string>();
  for (const entry of entriesOf(bytes)) {
    if (!entry.path.endsWith('.rels')) continue;
    const baseDir = relsBaseDirOf(entry.path);
    for (const rel of relsOf(Buffer.from(entry.data).toString('utf8'))) {
      if (!rel.external) referenced.add(resolveTarget(baseDir, rel.target));
    }
  }
  return mediaPartsIn(bytes).filter((path) => !referenced.has(path));
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
// 夹具
// ---------------------------------------------------------------------------

const SHARED = 'ppt/media/shared.png';
const ONLY = 'ppt/media/only.png';
const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

function pngBytes(seed: string): Uint8Array {
  // 内容不是真 PNG——渲染层只按扩展名登记内容类型，不解析字节。
  return new TextEncoder().encode(`PNG:${seed}`);
}

function picture(shapeId: number, mediaPath: string): Shape {
  return {
    kind: 'picture',
    shape_id: shapeId,
    name: `Pic ${String(shapeId)}`,
    transform: transform(0, 0, 1000000, 1000000),
    media_path: mediaPath,
    alt_text: '示意',
    crop: null,
  };
}

function marker(shapeId: number, text: string): Shape {
  return {
    kind: 'text_box',
    shape_id: shapeId,
    name: `Marker${String(shapeId)}`,
    transform: transform(0, 0, 1000000, 500000),
    text: literalText(text),
  };
}

/**
 * 2 页：第 1 页 = 共享图 + 独享图，第 2 页 = 共享图。
 * ⇒ 删第 1 页时 `shared.png` 仍被第 2 页引用（**不得**回收），`only.png` 成孤儿（**应当**回收）。
 */
function deckSharedPlusOnly(): Uint8Array {
  let deck: Presentation = emptyPresentation('p-i03', 'P-I03 媒体');
  const first = addSlide(deck);
  deck = first.presentation;
  deck = addShape(deck, first.slide_id, picture(2, SHARED));
  deck = addShape(deck, first.slide_id, picture(3, ONLY));
  const second = addSlide(deck);
  deck = second.presentation;
  deck = addShape(deck, second.slide_id, picture(2, SHARED));

  const rendered = renderPresentation(deck, {
    media: [
      { path: SHARED, bytes: pngBytes('shared') },
      { path: ONLY, bytes: pngBytes('only') },
    ],
  });
  return Uint8Array.from(rendered.bytes);
}

/** 3 页，页 1/3 用 `blank`、页 2 用 `title_and_content`（两个版式）。 */
function deckTwoLayouts(): Uint8Array {
  let deck: Presentation = emptyPresentation('p-i03', 'P-I03 版式');
  const layouts = [
    { master_id: 'master1', layout_id: 'Blank' },
    { master_id: 'master1', layout_id: 'title_and_content' },
    { master_id: 'master1', layout_id: 'Blank' },
  ];
  for (let i = 0; i < 3; i += 1) {
    const added = addSlide(deck);
    deck = added.presentation;
    deck = setSlideLayout(deck, added.slide_id, layouts[i]!);
    deck = addShape(deck, added.slide_id, marker(2, `P${String(i + 1)}`));
  }
  return Uint8Array.from(renderPresentation(deck).bytes);
}

/** 4 页，每页一个 `P<n>` 标记。 */
function deckFourPages(): Uint8Array {
  let deck: Presentation = emptyPresentation('p-i03', 'P-I03 分节');
  for (let i = 0; i < 4; i += 1) {
    const added = addSlide(deck);
    deck = added.presentation;
    deck = addShape(deck, added.slide_id, marker(2, `P${String(i + 1)}`));
  }
  return Uint8Array.from(renderPresentation(deck).bytes);
}

// ---------------------------------------------------------------------------
// §1 删页回收孤儿媒体（P-R04 确认的缺陷）
// ---------------------------------------------------------------------------

describe('P-I03 §1 删页回收孤儿媒体', () => {
  it('基线：两张媒体都在、无悬挂（源本身干净）', () => {
    const source = deckSharedPlusOnly();
    expect(mediaPartsIn(source)).toEqual([ONLY, SHARED].sort());
    expect(danglingRelationships(source)).toEqual([]);
    expect(orphanMediaParts(source)).toEqual([]);
  });

  it('删掉唯一引用 only.png 的页 ⇒ only.png 部件被回收，不再是孤儿', () => {
    const next = deleteDeckSlide(openEditableDeck(deckSharedPlusOnly()), 1);
    const out = serializeEditableDeck(next);

    // 缺陷回归点：删页前 only.png 在包里，删页后**必须**消失。
    expect(mediaPartsIn(out)).toEqual([SHARED]);
    // 独立检出：没有任何媒体成了孤儿（回收真的发生了，而不是只改了页序）。
    expect(orphanMediaParts(out)).toEqual([]);
    expect(danglingRelationships(out)).toEqual([]);
    expect(() => validateEditableDeck(next)).not.toThrow();
  });

  it('反向对照：仍被第 2 页引用的共享图**不得**被删，且其 r:embed 仍能落地', () => {
    const out = serializeEditableDeck(deleteDeckSlide(openEditableDeck(deckSharedPlusOnly()), 1));

    expect(mediaPartsIn(out)).toContain(SHARED);
    const survivor = rawPageParts(out)[0]!;
    const slideXml = textOf(out, survivor);
    const embed = /<a:blip\b[^>]*\br:embed="([^"]*)"/.exec(slideXml)?.[1];
    expect(embed).toBeDefined();
    const rel = relsOf(textOf(out, relsPathOfPart(survivor))).find((candidate) => candidate.id === embed);
    expect(rel?.type).toBe(REL_IMAGE);
    expect(resolveTarget(dirOf(survivor), rel!.target)).toBe(SHARED);
    expect(entriesOf(out).some((entry) => entry.path === SHARED)).toBe(true);
  });

  it('反向对照：删的页若其图仍被别页引用 ⇒ 一张都不回收（only.png 也保留）', () => {
    // 删第 2 页：仅剩的第 1 页同时引用 shared.png 与 only.png ⇒ 两张都仍被引用。
    const out = serializeEditableDeck(deleteDeckSlide(openEditableDeck(deckSharedPlusOnly()), 2));
    expect(mediaPartsIn(out)).toEqual([ONLY, SHARED].sort());
    expect(orphanMediaParts(out)).toEqual([]);
  });

  it('删页后仍能被往返层导入读回（结构合法、可再打开）', () => {
    const out = serializeEditableDeck(deleteDeckSlide(openEditableDeck(deckSharedPlusOnly()), 1));
    const reread = importPresentation(out);
    expect(reread.presentation.slides).toHaveLength(1);
  });

  it('删空所有页：两张图都成孤儿 ⇒ 都被回收（不再留下任何媒体字节）', () => {
    let deck = openEditableDeck(deckSharedPlusOnly());
    deck = deleteDeckSlide(deck, 1);
    deck = deleteDeckSlide(deck, 1); // 删掉剩下的那页（第 1 页现在是原第 2 页）
    const out = serializeEditableDeck(deck);
    expect(rawPageIds(out)).toEqual([]);
    expect(mediaPartsIn(out)).toEqual([]);
    expect(orphanMediaParts(out)).toEqual([]);
    expect(danglingRelationships(out)).toEqual([]);
  });

  it('保留既有守卫：被自定义放映引用的页仍明确报错（不因回收逻辑被绕过）', () => {
    // 这里只验证错误面未被改坏（自定义放映页的构造见 P02 用例）。
    const deck = openEditableDeck(deckSharedPlusOnly());
    expectDeckError(() => deleteDeckSlide(deck, 0), 'invalid_page_number');
    expectDeckError(() => deleteDeckSlide(deck, 3), 'invalid_page_number');
  });
});

// ---------------------------------------------------------------------------
// §2 分组版式应用（setDeckLayoutForSlides）
// ---------------------------------------------------------------------------

describe('P-I03 §2 分组版式应用', () => {
  function layoutPathOfName(bytes: Uint8Array, name: string): string {
    const layout = listDeckLayouts(openEditableDeck(bytes)).find((candidate) => candidate.name === name);
    if (layout === undefined) throw new Error(`夹具里没有名为 ${name} 的版式`);
    return layout.part_path;
  }

  it('一次把页 1、3 切到另一版式：目标页改了，未列出的页与页序不动', () => {
    const source = deckTwoLayouts();
    const deck = openEditableDeck(source);
    const target = layoutPathOfName(source, 'title_and_content');
    const original = layoutPathOfName(source, 'Blank');

    // 夹具自检：页 1 原用 blank，页 2 用 title_and_content。
    expect(deckSlideLayoutPath(deck, 1)).toBe(original);
    expect(deckSlideLayoutPath(deck, 2)).toBe(target);

    const next = setDeckLayoutForSlides(deck, [1, 3], target);
    expect(deckSlideLayoutPath(next, 1)).toBe(target);
    expect(deckSlideLayoutPath(next, 3)).toBe(target);
    expect(deckSlideLayoutPath(next, 2)).toBe(target); // 本来就是

    // 页序 / 内容不动，且没有写出悬挂关系。
    const out = serializeEditableDeck(next);
    expect(rawPageIds(out)).toEqual(rawPageIds(source));
    expect(pageMarkers(out)).toEqual([1, 2, 3]);
    expect(danglingRelationships(out)).toEqual([]);
  });

  it('按版式名分组应用；未知版式 / 越界页号一律具名报错（先全校验再落地）', () => {
    const deck = openEditableDeck(deckTwoLayouts());
    const byName = setDeckLayoutForSlidesByName(deck, [3], 'Blank');
    expect(deckSlideLayoutPath(byName, 3)).toBe(layoutPathOfName(deckTwoLayouts(), 'Blank'));

    expectDeckError(() => setDeckLayoutForSlides(deck, [1, 4], layoutPathOfName(deckTwoLayouts(), 'Blank')), 'invalid_page_number');
    expectDeckError(
      () => setDeckLayoutForSlides(deck, [1], 'ppt/slideLayouts/slideLayout99.xml'),
      'unknown_layout',
    );
    expectDeckError(() => setDeckLayoutForSlidesByName(deck, [1], '不存在的版式'), 'unknown_layout');

    // 反向对照：报错路径不改动入参（纯函数），页 1 的版式仍是原值。
    expect(deckSlideLayoutPath(deck, 1)).toBe(layoutPathOfName(deckTwoLayouts(), 'Blank'));
  });
});

// ---------------------------------------------------------------------------
// §3 连同页移动分节（moveDeckSectionWithPages）
// ---------------------------------------------------------------------------

describe('P-I03 §3 连同页移动分节', () => {
  function deckWithSection(): { readonly deck: ReturnType<typeof openEditableDeck>; readonly sectionId: string } {
    let deck = openEditableDeck(deckFourPages());
    const created = createDeckSection(deck, '第一节');
    deck = created.deck;
    deck = assignDeckSlideToSection(deck, 1, created.section_id);
    deck = assignDeckSlideToSection(deck, 2, created.section_id);
    return { deck, sectionId: created.section_id };
  }

  it('把页 1-2 的分节整体搬到页 3 起：块成为连续段，内容顺序随之搬移', () => {
    const { deck, sectionId } = deckWithSection();
    const ids = deckSlides(deck).map((slide) => slide.slide_id); // [256,257,258,259]

    const next = moveDeckSectionWithPages(deck, sectionId, 3);
    const out = serializeEditableDeck(next);

    // 页序：others=[3,4] 插入块 [1,2] 于页 3 ⇒ [3,4,1,2]
    expect(rawPageIds(out)).toEqual([ids[2], ids[3], ids[0], ids[1]]);
    expect(pageMarkers(out)).toEqual([3, 4, 1, 2]);

    // 分节成员不变、块内相对顺序不变、节内页序升序。
    expect(deckSections(next).find((section) => section.section_id === sectionId)?.slide_ids).toEqual([ids[0], ids[1]]);
    expect(danglingRelationships(out)).toEqual([]);
    expect(() => validateEditableDeck(next)).not.toThrow();
  });

  it('反向对照：其它分节成员不受影响；落点越界具名报错', () => {
    let deck = openEditableDeck(deckFourPages());
    const a = createDeckSection(deck, 'A');
    deck = a.deck;
    const b = createDeckSection(deck, 'B');
    deck = b.deck;
    deck = assignDeckSlideToSection(deck, 3, b.section_id);
    deck = assignDeckSlideToSection(deck, 4, b.section_id);

    const next = moveDeckSectionWithPages(deck, a.section_id, 2);
    const out = serializeEditableDeck(next);
    // A 无成员（空块）⇒ 页序不变。
    expect(pageMarkers(out)).toEqual([1, 2, 3, 4]);
    // B 成员 [3,4] 不受影响。
    expect(deckSections(next).find((section) => section.section_id === b.section_id)?.slide_ids).toEqual(
      deckSlides(deck)
        .filter((slide) => [3, 4].includes(slide.page_number))
        .map((slide) => slide.slide_id),
    );

    // 越界落点：others=4（空块）⇒ 合法范围 1..5。
    expectDeckError(() => moveDeckSectionWithPages(deck, a.section_id, 0), 'invalid_page_number');
    expectDeckError(() => moveDeckSectionWithPages(deck, a.section_id, 9), 'invalid_page_number');
    expectDeckError(() => moveDeckSectionWithPages(deck, '{不存在}', 1), 'unknown_section');
  });
});

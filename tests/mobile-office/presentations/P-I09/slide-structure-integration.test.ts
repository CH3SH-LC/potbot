/**
 * P-I09（P02 集成批）：**整组套版式** + **连页移节** + **可序列化变更投影**。
 *
 * 这一批把 P02 的 `nextIncrement` 里两个明确的增量落进 `src/presentations/slide-structure/`：
 *
 * 1. `applyDeckLayoutForSlides` / `applyDeckLayoutForPageRange`：对象模型层早有的
 *    `setLayoutForSlides` 在**导入包**上的对应实现——一次给一批页 / 一个页范围套同一版式，
 *    只改这些页 `_rels` 的 slideLayout Target，**其余部件逐字节不变**。
 * 2. `relocateDeckSectionWithPages`：移动分节声明顺序，并把该节成员页作为**连续块**一并搬走；
 *    非成员页的相对顺序不受扰动。为此 `compareStructure` 的分节差异新增
 *    `order_changed` / `moved`。
 * 3. `slideStructureJson` / `structureChangedObjects` / `inspectSlideStructure`：
 *    把快照与差异折成**纯数据**，直接喂 OfficePlugin 的 `inspect` / `receipt.changedObjects`。
 *
 * ## 判据一律走**独立解析**（不复用待测模块自证）
 *
 * 本文件自实现：`rawPageIds`（直接读 `p:sldIdLst`）、`rawPageParts`（sldIdLst + rels 解析）、
 * `rawSections`（直接读 `p14:sectionLst`）、`slideLayoutTargetOfPage`（直接读幻灯片 `_rels`）、
 * `danglingRelationships`（遍历所有 `.rels`）。待测的 `snapshotDeckStructure` /
 * `compareStructure` / 各操作只作**额外**对照。
 */

import { describe, expect, it } from 'vitest';

import { readZip, utf8Bytes, writeZip } from '../../../../src/artifacts/ooxml/index.js';
import { literalText, transform, type Presentation, type Shape } from '../../../../src/presentations/model.js';
import { addShape, addSlide, setSlideLayout } from '../../../../src/presentations/operations.js';
import { emptyPresentation, renderPresentation } from '../../../../src/presentations/render.js';
import { importPresentation } from '../../../../src/presentations/roundtrip.js';
import {
  DeckEditError,
  createDeckSection,
  deckSlideLayoutPath,
  deckSlides,
  moveDeckSection,
  openEditableDeck,
  serializeEditableDeck,
  validateEditableDeck,
  type DeckEditErrorReason,
} from '../../../../src/presentations/slide-ops.js';
import {
  compareStructure,
  inspectSlideStructure,
  isStructureUnchanged,
  relocateDeckSectionWithPages,
  applyDeckLayoutForPageRange,
  applyDeckLayoutForSlides,
  slideStructureJson,
  snapshotDeckStructure,
  structureChangedObjects,
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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
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

function relsPathOfPart(partPath: string): string {
  const cut = partPath.lastIndexOf('/');
  const dir = cut < 0 ? '' : partPath.slice(0, cut);
  const base = cut < 0 ? partPath : partPath.slice(cut + 1);
  return dir === '' ? `_rels/${base}.rels` : `${dir}/_rels/${base}.rels`;
}

/** 直接读全局页序（`p:sldIdLst` 的 slide_id 列表）。 */
function rawPageIds(bytes: Uint8Array): readonly number[] {
  const block = /<p:sldIdLst\b[^>]*>([\s\S]*?)<\/p:sldIdLst>/.exec(textOf(bytes, 'ppt/presentation.xml'));
  const ids: number[] = [];
  for (const match of (block?.[1] ?? '').matchAll(/<p:sldId\b[^>]*\/?>/g)) {
    const id = /(?<![\w:])id\s*=\s*"([^"]*)"/.exec(match[0] ?? '')?.[1];
    if (id !== undefined) ids.push(Number(id));
  }
  return ids;
}

/** 页序 → 页部件路径（独立解析 sldIdLst + presentation.xml.rels）。 */
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

interface RawSection {
  readonly id: string;
  readonly name: string;
  readonly slideIds: readonly number[];
}

/** 独立读分节（直接解析 `p14:sectionLst`，不复用 deckSections）。 */
function rawSections(bytes: Uint8Array): readonly RawSection[] {
  const xml = textOf(bytes, 'ppt/presentation.xml');
  const list = /<([A-Za-z_][\w.-]*):sectionLst\b[^>]*>([\s\S]*?)<\/\1:sectionLst>/.exec(xml);
  const out: RawSection[] = [];
  for (const match of (list?.[2] ?? '').matchAll(/<([A-Za-z_][\w.-]*):section\b([^>]*)>([\s\S]*?)<\/\1:section>/g)) {
    const attrs = match[2] ?? '';
    const body = match[3] ?? '';
    const id = /\bid\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
    const name = /\bname\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
    if (id === undefined || name === undefined) continue;
    const slideIds: number[] = [];
    for (const sld of body.matchAll(/<([A-Za-z_][\w.-]*):sldId\b[^>]*\/?>/g)) {
      const sid = /\bid\s*=\s*"([^"]*)"/.exec(sld[0] ?? '')?.[1];
      if (sid !== undefined) slideIds.push(Number(sid));
    }
    out.push({ id, name, slideIds });
  }
  return out;
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

/** 断言：两份字节之间，**除允许改动的部件外**一律逐字节相同。 */
function expectOnlyChanged(original: Uint8Array, changed: Uint8Array, allowedPaths: readonly string[]): void {
  const allowed = new Set(allowedPaths);
  const after = new Map(entriesOf(changed).map((entry) => [entry.path, entry.data] as const));
  for (const entry of entriesOf(original)) {
    if (allowed.has(entry.path)) continue;
    const other = after.get(entry.path);
    expect(other, `部件 ${entry.path} 在改动后消失了`).toBeDefined();
    expect(bytesEqual(entry.data, other!), `部件 ${entry.path} 不应被改动`).toBe(true);
  }
}

function partOfPage(bytes: Uint8Array, pageNumber: number): string {
  const part = rawPageParts(bytes)[pageNumber - 1];
  if (part === undefined) throw new Error(`没有第 ${String(pageNumber)} 页`);
  return part;
}

/** `ids` 里保留出现在 `keep` 集合中的元素（保序）。 */
function subsequence(ids: readonly number[], keep: ReadonlySet<number>): readonly number[] {
  return ids.filter((id) => keep.has(id));
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
// 装置：4 页 / 3 分节的导入源
//   版式：页 1 = slideLayout1(blank)，页 2 = slideLayout2(title_and_content)，页 3/4 = slideLayout1
//   分节：A = 页 1-2，B = 页 3，C = 页 4（由字符串手术注入，不经待测写函数）
// ---------------------------------------------------------------------------

const SECTION_A = '{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa}';
const SECTION_B = '{bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb}';
const SECTION_C = '{cccccccc-cccc-cccc-cccc-cccccccccccc}';

function marker(text: string): Shape {
  return {
    kind: 'text_box',
    shape_id: 2,
    name: text,
    transform: transform(0, 0, 1000000, 500000),
    text: literalText(text),
  };
}

function sectionXml(name: string, id: string, sldIds: readonly number[]): string {
  const members = sldIds.map((sldId) => `<p14:sldId id="${String(sldId)}"/>`).join('');
  return `<p14:section name="${name}" id="${id}"><p14:sldIdLst>${members}</p14:sldIdLst></p14:section>`;
}

function buildSource(): Uint8Array {
  let deck: Presentation = emptyPresentation('src', '结构集成源');
  const layouts = [
    { master_id: 'master1', layout_id: 'blank' },
    { master_id: 'master1', layout_id: 'title_and_content' },
    { master_id: 'master1', layout_id: 'blank' },
    { master_id: 'master1', layout_id: 'blank' },
  ];
  for (let i = 0; i < 4; i += 1) {
    const added = addSlide(deck);
    deck = added.presentation;
    deck = setSlideLayout(deck, added.slide_id, layouts[i]!);
    deck = addShape(deck, added.slide_id, marker(`P${String(i + 1)}`));
  }

  const rendered = renderPresentation(deck);
  const entries = entriesOf(rendered.bytes);
  const ids = rawPageIds(rendered.bytes);

  const sections =
    '<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}">' +
    '<p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">' +
    sectionXml('第一节', SECTION_A, [ids[0]!, ids[1]!]) +
    sectionXml('第二节', SECTION_B, [ids[2]!]) +
    sectionXml('第三节', SECTION_C, [ids[3]!]) +
    '</p14:sectionLst></p:ext></p:extLst>';

  const index = entries.findIndex((entry) => entry.path === 'ppt/presentation.xml');
  const patched = Buffer.from(entries[index]!.data)
    .toString('utf8')
    .replace('</p:presentation>', `${sections}</p:presentation>`);
  const next = entries.map((entry, i) => (i === index ? { path: entry.path, data: utf8Bytes(patched) } : entry));
  return writeZip(next);
}

function slideIdAtPage(bytes: Uint8Array, pageNumber: number): number {
  const id = rawPageIds(bytes)[pageNumber - 1];
  if (id === undefined) throw new Error(`没有第 ${String(pageNumber)} 页`);
  return id;
}

// ---------------------------------------------------------------------------
// 0. 源装置自检
// ---------------------------------------------------------------------------

describe('P-I09-源装置：4 页 / 3 分节 / 两种版式且干净', () => {
  it('页 1/3/4 引用 slideLayout1，页 2 引用 slideLayout2；无悬挂关系', () => {
    const source = buildSource();
    const parts = rawPageParts(source);
    expect(parts).toHaveLength(4);
    expect(slideLayoutTargetOfPage(source, parts[0]!)).toBe('ppt/slideLayouts/slideLayout1.xml');
    expect(slideLayoutTargetOfPage(source, parts[1]!)).toBe('ppt/slideLayouts/slideLayout2.xml');
    expect(slideLayoutTargetOfPage(source, parts[2]!)).toBe('ppt/slideLayouts/slideLayout1.xml');
    expect(slideLayoutTargetOfPage(source, parts[3]!)).toBe('ppt/slideLayouts/slideLayout1.xml');
    expect(danglingRelationships(source)).toEqual([]);
  });

  it('独立解析出三分节 A/B/C，成员与页序一致', () => {
    const source = buildSource();
    const sections = rawSections(source);
    expect(sections.map((section) => section.id)).toEqual([SECTION_A, SECTION_B, SECTION_C]);
    expect(sections.map((section) => section.name)).toEqual(['第一节', '第二节', '第三节']);
    expect(sections[0]!.slideIds).toEqual([slideIdAtPage(source, 1), slideIdAtPage(source, 2)]);
    expect(sections[1]!.slideIds).toEqual([slideIdAtPage(source, 3)]);
    expect(sections[2]!.slideIds).toEqual([slideIdAtPage(source, 4)]);
  });
});

// ---------------------------------------------------------------------------
// 1. 整组套版式：只动目标页的 _rels，其余部件逐字节不变
// ---------------------------------------------------------------------------

describe('P-I09-整组套版式：applyDeckLayoutForSlides', () => {
  it('给 {1,3} 套 slideLayout2：只改这两页 _rels 的 slideLayout Target，其余部件逐字节不变', () => {
    const source = buildSource();
    const deck = openEditableDeck(source);

    const applied = applyDeckLayoutForSlides(deck, [1, 3], 'ppt/slideLayouts/slideLayout2.xml');
    const bytes = serializeEditableDeck(applied);

    // 独立解析：目标页真的换到 slideLayout2。
    expect(slideLayoutTargetOfPage(bytes, partOfPage(bytes, 1))).toBe('ppt/slideLayouts/slideLayout2.xml');
    expect(slideLayoutTargetOfPage(bytes, partOfPage(bytes, 3))).toBe('ppt/slideLayouts/slideLayout2.xml');
    // 未在集合里的页 2/4 保持原版式。
    expect(slideLayoutTargetOfPage(bytes, partOfPage(bytes, 2))).toBe('ppt/slideLayouts/slideLayout2.xml');
    expect(slideLayoutTargetOfPage(bytes, partOfPage(bytes, 4))).toBe('ppt/slideLayouts/slideLayout1.xml');

    // **逐字节**：除第 1/3 页的 _rels 外，全包（含页正文、页 2/4 的 _rels、母版、版式、主题）不变。
    expectOnlyChanged(source, bytes, [
      relsPathOfPart(partOfPage(source, 1)),
      relsPathOfPart(partOfPage(source, 3)),
    ]);

    expect(danglingRelationships(bytes)).toEqual([]);
    expect(() => validateEditableDeck(applied)).not.toThrow();
  });

  it('套版式不动页序、不动分节、不动页正文（正文里不写版式路径）', () => {
    const source = buildSource();
    const deck = openEditableDeck(source);
    const beforeIds = rawPageIds(source);
    const beforeSections = rawSections(source).map((section) => [section.id, [...section.slideIds]]);

    const bytes = serializeEditableDeck(applyDeckLayoutForSlides(deck, [1, 3], 'ppt/slideLayouts/slideLayout2.xml'));

    expect(rawPageIds(bytes)).toEqual(beforeIds);
    expect(rawSections(bytes).map((section) => [section.id, [...section.slideIds]])).toEqual(beforeSections);
    // 四页正文逐字节不变。
    for (let page = 1; page <= 4; page += 1) {
      const part = partOfPage(source, page);
      expect(bytesEqual(
        readZip(source).by_path.get(part)!.data,
        readZip(bytes).by_path.get(part)!.data,
      )).toBe(true);
    }
  });

  it('页范围 helper 2..4：包含已是目标版式的页也不破坏"集合外不动"', () => {
    const source = buildSource();
    const deck = openEditableDeck(source);
    const bytes = serializeEditableDeck(applyDeckLayoutForPageRange(deck, 2, 4, 'ppt/slideLayouts/slideLayout1.xml'));

    // 页 2 由 slideLayout2 → slideLayout1；页 3/4 本就是 slideLayout1。
    expect(slideLayoutTargetOfPage(bytes, partOfPage(bytes, 2))).toBe('ppt/slideLayouts/slideLayout1.xml');
    expect(slideLayoutTargetOfPage(bytes, partOfPage(bytes, 3))).toBe('ppt/slideLayouts/slideLayout1.xml');
    expect(slideLayoutTargetOfPage(bytes, partOfPage(bytes, 4))).toBe('ppt/slideLayouts/slideLayout1.xml');
    // 集合外只有第 1 页 → 它的 _rels 与正文必须逐字节不变。
    expectOnlyChanged(source, bytes, [
      relsPathOfPart(partOfPage(source, 2)),
      relsPathOfPart(partOfPage(source, 3)),
      relsPathOfPart(partOfPage(source, 4)),
    ]);
  });

  it('去重 + 乱序页码对结果无影响（同一集合结果一致）', () => {
    const source = buildSource();
    const deck = openEditableDeck(source);
    const a = serializeEditableDeck(applyDeckLayoutForSlides(deck, [3, 1, 1, 3], 'ppt/slideLayouts/slideLayout2.xml'));
    const b = serializeEditableDeck(applyDeckLayoutForSlides(deck, [1, 3], 'ppt/slideLayouts/slideLayout2.xml'));
    expect(rawPageIds(a)).toEqual(rawPageIds(b));
    expect(bytesEqual(a, b)).toBe(true);
  });

  it('空集合 = 原样（不产生任何部件改动）', () => {
    const source = buildSource();
    const deck = openEditableDeck(source);
    const bytes = serializeEditableDeck(applyDeckLayoutForSlides(deck, [], 'ppt/slideLayouts/slideLayout2.xml'));
    expect(bytesEqual(source, bytes)).toBe(true);
  });

  it('未知版式 / 越界页码 / 非法范围 ⇒ 具名报错，且原包不被改动', () => {
    const source = buildSource();
    const deck = openEditableDeck(source);
    expectDeckError(() => applyDeckLayoutForSlides(deck, [1], 'ppt/slideLayouts/slideLayout99.xml'), 'unknown_layout');
    expectDeckError(() => applyDeckLayoutForSlides(deck, [0, 1], 'ppt/slideLayouts/slideLayout2.xml'), 'invalid_page_number');
    expectDeckError(() => applyDeckLayoutForSlides(deck, [5], 'ppt/slideLayouts/slideLayout2.xml'), 'invalid_page_number');
    expectDeckError(() => applyDeckLayoutForPageRange(deck, 3, 2, 'ppt/slideLayouts/slideLayout2.xml'), 'invalid_page_number');
    // 失败后原包序列化仍与源逐字节相同（纯函数、无副作用）。
    expect(bytesEqual(source, serializeEditableDeck(deck))).toBe(true);
  });

  it('整组套版式后能被往返层读回：importPresentation 逐页 layout_id 随关系更新', () => {
    const source = buildSource();
    const deck = openEditableDeck(source);
    const applied = applyDeckLayoutForSlides(deck, [1, 4], 'ppt/slideLayouts/slideLayout2.xml');

    // 真实往返读回：用仓库自带的 importPresentation 重新打开产出的字节，读每页 layout_id。
    const reread = importPresentation(serializeEditableDeck(applied));
    expect(reread.presentation.slides.map((slide) => slide.layout.layout_id)).toEqual([
      'slideLayout2',
      'slideLayout2',
      'slideLayout1',
      'slideLayout2',
    ]);

    // 额外用待测读口对照（独立解析已在上一组用例断言）。
    expect(deckSlideLayoutPath(applied, 1)).toBe('ppt/slideLayouts/slideLayout2.xml');
    expect(deckSlideLayoutPath(applied, 4)).toBe('ppt/slideLayouts/slideLayout2.xml');
    expect(deckSlideLayoutPath(applied, 2)).toBe('ppt/slideLayouts/slideLayout2.xml');
    expect(deckSlideLayoutPath(applied, 3)).toBe('ppt/slideLayouts/slideLayout1.xml');
  });

  it('整组套版式的差异：references_changed 逐页、按 slide_id，其余差异为空', () => {
    const source = buildSource();
    const deck = openEditableDeck(source);
    const before = snapshotDeckStructure(deck);
    const after = snapshotDeckStructure(applyDeckLayoutForSlides(deck, [1, 3], 'ppt/slideLayouts/slideLayout2.xml'));

    const delta = compareStructure(before, after);
    expect(delta.page_order_changed).toBe(false);
    expect(delta.pages_moved).toEqual([]);
    expect(delta.pages_inserted).toEqual([]);
    expect(delta.pages_deleted).toEqual([]);
    expect(delta.references_changed.map((change) => change.slide_id).sort()).toEqual(
      [slideIdAtPage(source, 1), slideIdAtPage(source, 3)].sort(),
    );
    expect(delta.references_changed.every((change) => change.field === 'layout')).toBe(true);
    expect(isStructureUnchanged(delta)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. 连页移节：relocateDeckSectionWithPages
// ---------------------------------------------------------------------------

describe('P-I09-连页移节：成员页随节搬运，非成员页相对顺序不变', () => {
  it('把第二节（页 3）移到最前：页 3 随之前移，非成员页 1/2/4 相对顺序不变', () => {
    const source = buildSource();
    const deck = openEditableDeck(source);
    const nonMembers = new Set([slideIdAtPage(source, 1), slideIdAtPage(source, 2), slideIdAtPage(source, 4)]);

    const moved = relocateDeckSectionWithPages(deck, SECTION_B, 0);
    const bytes = serializeEditableDeck(moved);

    // 独立页序：[p3, p1, p2, p4]
    expect(rawPageIds(bytes)).toEqual([
      slideIdAtPage(source, 3),
      slideIdAtPage(source, 1),
      slideIdAtPage(source, 2),
      slideIdAtPage(source, 4),
    ]);
    // 非成员页相对顺序 = 原非成员相对顺序（"不扰动全局页序"）。
    expect(subsequence(rawPageIds(bytes), nonMembers)).toEqual(subsequence(rawPageIds(source), nonMembers));
    // 分节声明顺序改为 [B, A, C]。
    expect(rawSections(bytes).map((section) => section.id)).toEqual([SECTION_B, SECTION_A, SECTION_C]);
    // 成员由节携带：第二节仍只含页 3。
    expect(rawSections(bytes)[0]!.slideIds).toEqual([slideIdAtPage(source, 3)]);
    // 页面部件本身逐字节不变（搬的是 p:sldIdLst 的顺序，不是页部件内容）。
    expect([...rawPageParts(bytes)].sort()).toEqual([...rawPageParts(source)].sort());
    for (const part of rawPageParts(source)) {
      expect(bytesEqual(readZip(source).by_path.get(part)!.data, readZip(bytes).by_path.get(part)!.data)).toBe(true);
    }
    expect(danglingRelationships(bytes)).toEqual([]);
    expect(() => validateEditableDeck(moved)).not.toThrow();
  });

  it('把第一节（页 1-2）移到第三节之后：块整体落到页 4 之后，块内相对顺序不变', () => {
    const source = buildSource();
    const deck = openEditableDeck(source);
    const membersA = new Set([slideIdAtPage(source, 1), slideIdAtPage(source, 2)]);
    const nonMembers = new Set([slideIdAtPage(source, 3), slideIdAtPage(source, 4)]);

    const moved = relocateDeckSectionWithPages(deck, SECTION_A, 2);
    const bytes = serializeEditableDeck(moved);

    // 目标空档 = 第三节（页 4）之后 ⇒ [p3, p4, p1, p2]
    expect(rawPageIds(bytes)).toEqual([
      slideIdAtPage(source, 3),
      slideIdAtPage(source, 4),
      slideIdAtPage(source, 1),
      slideIdAtPage(source, 2),
    ]);
    // 成员块连续、块内顺序 = 原顺序。
    const order = rawPageIds(bytes);
    const memberPositions = order
      .map((id, index) => (membersA.has(id) ? index : -1))
      .filter((index) => index >= 0);
    expect(memberPositions).toEqual([2, 3]);
    expect(subsequence(order, membersA)).toEqual([slideIdAtPage(source, 1), slideIdAtPage(source, 2)]);
    // 非成员页相对顺序不变。
    expect(subsequence(order, nonMembers)).toEqual(subsequence(rawPageIds(source), nonMembers));
    expect(rawSections(bytes).map((section) => section.id)).toEqual([SECTION_B, SECTION_C, SECTION_A]);
  });

  it('连页移节的差异：page_order_changed + pages_moved 按 slide_id + 分节 order_changed/moved', () => {
    const source = buildSource();
    const deck = openEditableDeck(source);
    const before = snapshotDeckStructure(deck);
    const after = snapshotDeckStructure(relocateDeckSectionWithPages(deck, SECTION_B, 0));

    const delta = compareStructure(before, after);
    expect(delta.page_order_changed).toBe(true);
    expect(delta.pages_inserted).toEqual([]);
    expect(delta.pages_deleted).toEqual([]);
    // 三页都挪了位置（页 3 前移，页 1/2 后移），按 slide_id 记账。
    expect(delta.pages_moved.map((move) => move.slide_id).sort()).toEqual(
      [slideIdAtPage(source, 1), slideIdAtPage(source, 2), slideIdAtPage(source, 3)].sort(),
    );
    const movedPage3 = delta.pages_moved.find((move) => move.slide_id === slideIdAtPage(source, 3));
    expect(movedPage3).toMatchObject({ from_page: 3, to_page: 1 });
    expect(delta.sections.order_changed).toBe(true);
    expect(delta.sections.moved.map((move) => move.section_id).sort()).toEqual([SECTION_A, SECTION_B].sort());
    expect(delta.sections.removed).toEqual([]);
    expect(delta.sections.added).toEqual([]);
    expect(delta.references_changed).toEqual([]);
  });

  it('移到自身位置 = 无改动（isStructureUnchanged 为真）', () => {
    const source = buildSource();
    const deck = openEditableDeck(source);
    const before = snapshotDeckStructure(deck);
    const after = snapshotDeckStructure(relocateDeckSectionWithPages(deck, SECTION_B, 1));
    expect(isStructureUnchanged(compareStructure(before, after))).toBe(true);
    expect(bytesEqual(source, serializeEditableDeck(relocateDeckSectionWithPages(deck, SECTION_B, 1)))).toBe(true);
  });

  it('空分节连着移 = 退化为纯移节（页序完全不动）', () => {
    const source = buildSource();
    const deck = openEditableDeck(source);
    const withD = createDeckSection(deck, '第四节').deck;
    const pageIdsBefore = rawPageIds(serializeEditableDeck(withD));

    const moved = relocateDeckSectionWithPages(withD, rawSections(serializeEditableDeck(withD))[3]!.id, 0);
    const bytes = serializeEditableDeck(moved);

    expect(rawPageIds(bytes)).toEqual(pageIdsBefore); // 页序不动
    expect(rawSections(bytes).map((section) => section.name)).toEqual(['第四节', '第一节', '第二节', '第三节']);
    expect(() => validateEditableDeck(moved)).not.toThrow();
  });

  it('未知分节 / 越界位置 ⇒ 具名报错，且原包不被改动', () => {
    const source = buildSource();
    const deck = openEditableDeck(source);
    expectDeckError(() => relocateDeckSectionWithPages(deck, '{nosuch}', 0), 'unknown_section');
    expectDeckError(() => relocateDeckSectionWithPages(deck, SECTION_A, 3), 'invalid_section_order');
    expectDeckError(() => relocateDeckSectionWithPages(deck, SECTION_A, -1), 'invalid_section_order');
    expect(bytesEqual(source, serializeEditableDeck(deck))).toBe(true);
  });

  it('与纯移节（moveDeckSection）对照：纯移节不动页序，本函数才搬页', () => {
    const source = buildSource();
    const deck = openEditableDeck(source);
    const pureBytes = serializeEditableDeck(moveDeckSection(deck, SECTION_B, 0));
    const withPagesBytes = serializeEditableDeck(relocateDeckSectionWithPages(deck, SECTION_B, 0));
    // 纯移节：页序不变。
    expect(rawPageIds(pureBytes)).toEqual(rawPageIds(source));
    // 连页移节：页序变了。
    expect(rawPageIds(withPagesBytes)).not.toEqual(rawPageIds(source));
    // 两者的分节声明顺序一致。
    expect(rawSections(pureBytes).map((section) => section.id)).toEqual(
      rawSections(withPagesBytes).map((section) => section.id),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. 可序列化投影（OfficePlugin inspect / receipt.changedObjects 的落点）
// ---------------------------------------------------------------------------

describe('P-I09-变更投影：纯数据、可 JSON 往返、稳定对象引用', () => {
  it('slideStructureJson 与快照同构，且能 JSON 往返', () => {
    const deck = openEditableDeck(buildSource());
    const snapshot = snapshotDeckStructure(deck);
    const json = slideStructureJson(snapshot);

    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(json.pages).toHaveLength(4);
    expect(json.pages.map((page) => page.page_number)).toEqual([1, 2, 3, 4]);
    expect(json.sections.map((section) => section.section_id)).toEqual([SECTION_A, SECTION_B, SECTION_C]);
    // 是**新对象**：不共享内部数组引用。
    expect(json.pages).not.toBe(snapshot.pages);
    expect(json.sections[0]!.slide_ids).not.toBe(snapshot.sections[0]!.slide_ids);
  });

  it('整组套版式的变更对象：两条 update（objectType=slide，fields=[layout]），JSON 往返', () => {
    const source = buildSource();
    const deck = openEditableDeck(source);
    const before = snapshotDeckStructure(deck);
    const after = snapshotDeckStructure(applyDeckLayoutForSlides(deck, [1, 3], 'ppt/slideLayouts/slideLayout2.xml'));

    const objects = structureChangedObjects(compareStructure(before, after));
    expect(objects).toHaveLength(2);
    for (const object of objects) {
      expect(object.objectType).toBe('slide');
      expect(object.changeType).toBe('update');
      expect(object.fields).toEqual(['layout']);
    }
    expect(objects.map((object) => object.objectId).sort()).toEqual([
      `slide:${String(slideIdAtPage(source, 1))}`,
      `slide:${String(slideIdAtPage(source, 3))}`,
    ]);
    expect(JSON.parse(JSON.stringify(objects))).toEqual(objects);
  });

  it('连页移节的变更对象：页 move + 分节 move，objectId 用稳定引用', () => {
    const source = buildSource();
    const deck = openEditableDeck(source);
    const before = snapshotDeckStructure(deck);
    const after = snapshotDeckStructure(relocateDeckSectionWithPages(deck, SECTION_B, 0));

    const objects = structureChangedObjects(compareStructure(before, after));
    const slideMoves = objects.filter((object) => object.objectType === 'slide' && object.changeType === 'move');
    const sectionMoves = objects.filter((object) => object.objectType === 'section' && object.changeType === 'move');
    expect(slideMoves.map((object) => object.objectId).sort()).toEqual([
      `slide:${String(slideIdAtPage(source, 1))}`,
      `slide:${String(slideIdAtPage(source, 2))}`,
      `slide:${String(slideIdAtPage(source, 3))}`,
    ]);
    expect(sectionMoves.map((object) => object.objectId).sort()).toEqual([
      `section:${SECTION_A}`,
      `section:${SECTION_B}`,
    ]);
    expect(JSON.parse(JSON.stringify(objects))).toEqual(objects);
  });

  it('inspectSlideStructure 打包快照 + 差异 + 变更对象；无改动时 unchanged=true 且清单为空', () => {
    const source = buildSource();
    const deck = openEditableDeck(source);

    const changed = inspectSlideStructure(
      snapshotDeckStructure(deck),
      snapshotDeckStructure(applyDeckLayoutForSlides(deck, [1], 'ppt/slideLayouts/slideLayout2.xml')),
    );
    expect(changed.unchanged).toBe(false);
    expect(changed.changedObjects).toHaveLength(1);
    expect(changed.snapshot.pages).toHaveLength(4);
    expect(changed.delta.page_order_changed).toBe(false);

    const same = inspectSlideStructure(snapshotDeckStructure(deck), snapshotDeckStructure(deck));
    expect(same.unchanged).toBe(true);
    expect(same.changedObjects).toEqual([]);
    expect(JSON.parse(JSON.stringify(same))).toEqual(same);
  });

  it('deckSlides 的稳定引用与投影 objectId 一致（页码可以变，slide_id 不变）', () => {
    const source = buildSource();
    const deck = openEditableDeck(source);
    const beforeIds = deckSlides(deck).map((ref) => ref.slide_id);
    const moved = relocateDeckSectionWithPages(deck, SECTION_B, 0);
    const afterIds = new Set(deckSlides(moved).map((ref) => ref.slide_id));
    // 页集合不变（只是顺序变了）。
    expect([...afterIds].sort()).toEqual([...beforeIds].sort());
  });
});

/**
 * P01 · 最终包装配器（容器 / 内容类型 / 关系图 / 多母版主题 / 增删部件与关系）。
 *
 * ## 判据一律走**独立解析**，不复用待测模块自证
 *
 * 本文件自己实现了：
 * - `slidePartsInOrder`：直接从 ZIP 里读 `ppt/presentation.xml` 的 `p:sldIdLst` 顺序 +
 *   `ppt/_rels/presentation.xml.rels` 的 `rId → Target`，解析出「页 → 部件」；
 * - `danglingRelationships`：遍历包里**每一个** `.rels`，把内部 `Target` 解析成包内路径，
 *   凡指向不存在的部件即为悬挂；
 * - `byteOf` / `textOf`：直接读条目字节，用于"未改部件逐字节不变"的断言。
 *
 * 待测的 `openPresentationPackage` / `assemblePresentationPackage` / `addSlideToPackage` 等
 * 只作为**额外**断言，不作为唯一证据。
 *
 * ## 反向对照（具名失败，不静默）
 *
 * 替换不存在的部件 / 新增重复部件 / 摘除不存在的关系 id / 无 notesMaster 时挂备注 ⇒
 * 一律抛 `PresentationAssemblyError` 且 reason 可断言。
 */

import { describe, expect, it } from 'vitest';

import { readZip, utf8Bytes, writeZip } from '../../../../src/artifacts/ooxml/index.js';
import { emptyPresentation, renderPresentation } from '../../../../src/presentations/render.js';
import { addShape, addSlide, setSlideNotes } from '../../../../src/presentations/operations.js';
import { literalText, transform, type Shape } from '../../../../src/presentations/model.js';
import {
  PresentationAssemblyError,
  addSlideToPackage,
  assemblePresentationPackage,
  linkSlideMedia,
  linkSlideNotes,
  openPresentationPackage,
  removeSlideFromPackage,
  unlinkSlideMedia,
  unlinkSlideNotes,
} from '../../../../src/presentations/import.js';

// ---------------------------------------------------------------------------
// 独立解析器（**不复用**待测模块）
// ---------------------------------------------------------------------------

interface ZipLikeEntry {
  readonly path: string;
  readonly data: Uint8Array;
}

function entriesOf(bytes: Uint8Array): readonly ZipLikeEntry[] {
  return readZip(bytes).entries.map((entry) => ({ path: entry.path, data: entry.data }));
}

function textOf(entries: readonly ZipLikeEntry[], path: string): string {
  const entry = entries.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`包内没有部件 ${path}`);
  return Buffer.from(entry.data).toString('utf8');
}

function byteOf(entries: readonly ZipLikeEntry[], path: string): Uint8Array {
  const entry = entries.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`包内没有部件 ${path}`);
  return entry.data;
}

function ownerDirOfRels(relsPath: string): string {
  if (relsPath === '_rels/.rels') return '';
  const cut = relsPath.indexOf('/_rels/');
  return cut < 0 ? '' : relsPath.slice(0, cut);
}

function resolveTarget(dir: string, target: string): string {
  const combined = target.startsWith('/')
    ? target.replace(/^\/+/, '')
    : dir === ''
      ? target
      : `${dir}/${target}`;
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

/** 内部关系 `rId → 解析后的包内路径`（跳过 External）。 */
function relationshipTargets(relsXml: string, ownerDir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const tag = match[0];
    if (/TargetMode\s*=\s*"External"/.test(tag)) continue;
    const id = /\bId\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    const target = /\bTarget\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    if (id === undefined || target === undefined) continue;
    map.set(id, resolveTarget(ownerDir, target));
  }
  return map;
}

/** 独立解析的页序（`p:sldIdLst` 顺序 → 幻灯片部件路径）。 */
function slidePartsInOrder(entries: readonly ZipLikeEntry[]): readonly string[] {
  const presentation = textOf(entries, 'ppt/presentation.xml');
  const targets = relationshipTargets(textOf(entries, 'ppt/_rels/presentation.xml.rels'), 'ppt');
  const parts: string[] = [];
  for (const match of presentation.matchAll(/<p:sldId\b[^>]*\/?>/g)) {
    const relId = /\br:id\s*=\s*"([^"]*)"/.exec(match[0])?.[1];
    if (relId === undefined) throw new Error(`p:sldId 缺 r:id：${match[0]}`);
    const part = targets.get(relId);
    if (part === undefined) throw new Error(`p:sldId@r:id=${relId} 没有内部关系`);
    parts.push(part);
  }
  return parts;
}

/** 遍历全部 `.rels`，返回悬空内部目标清单（空 = 无悬挂）。 */
function danglingRelationships(entries: readonly ZipLikeEntry[]): readonly string[] {
  const present = new Set(entries.map((entry) => entry.path));
  const dangling: string[] = [];
  for (const entry of entries) {
    if (!entry.path.endsWith('.rels')) continue;
    const ownerDir = ownerDirOfRels(entry.path);
    for (const [id, resolved] of relationshipTargets(
      Buffer.from(entry.data).toString('utf8'),
      ownerDir,
    )) {
      if (!present.has(resolved)) dangling.push(`${entry.path}:${id}->${resolved}`);
    }
  }
  return dangling;
}

/** 每个业务部件的内容类型（Override 优先，其次按扩展名查 Default）。 */
function contentTypesOf(bytes: Uint8Array): Map<string, string> {
  const entries = entriesOf(bytes);
  const xml = textOf(entries, '[Content_Types].xml');
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const match of xml.matchAll(/<Default\b[^>]*\/>/g)) {
    const extension = /\bExtension\s*=\s*"([^"]*)"/.exec(match[0])?.[1];
    const contentType = /\bContentType\s*=\s*"([^"]*)"/.exec(match[0])?.[1];
    if (extension !== undefined && contentType !== undefined) defaults.set(extension.toLowerCase(), contentType);
  }
  for (const match of xml.matchAll(/<Override\b[^>]*\/>/g)) {
    const partName = /\bPartName\s*=\s*"([^"]*)"/.exec(match[0])?.[1];
    const contentType = /\bContentType\s*=\s*"([^"]*)"/.exec(match[0])?.[1];
    if (partName !== undefined && contentType !== undefined) {
      overrides.set(partName.replace(/^\/+/, ''), contentType);
    }
  }
  const result = new Map<string, string>();
  for (const entry of entries) {
    if (entry.path === '[Content_Types].xml' || entry.path.endsWith('.rels')) continue;
    const override = overrides.get(entry.path);
    if (override !== undefined) {
      result.set(entry.path, override);
      continue;
    }
    const dot = entry.path.lastIndexOf('.');
    const extension = dot > entry.path.lastIndexOf('/') + 1 ? entry.path.slice(dot + 1).toLowerCase() : '';
    result.set(entry.path, defaults.get(extension) ?? '');
  }
  return result;
}

/** 断言：`paths` 里的部件在 `after` 与 `before` 中逐字节相同。 */
function expectPartsUnchanged(
  before: readonly ZipLikeEntry[],
  after: readonly ZipLikeEntry[],
  paths: readonly string[],
): void {
  for (const path of paths) {
    const a = Buffer.from(byteOf(after, path));
    const b = Buffer.from(byteOf(before, path));
    expect(a.compare(b), `部件 ${path} 应当逐字节不变`).toBe(0);
  }
}

// ---------------------------------------------------------------------------
// 语料：3 页 + 图片 + 备注 + 第二套母版/主题 + 厂商自定义部件
// ---------------------------------------------------------------------------

/** 一个最小 1×1 PNG（只用于"媒体字节真实存在"；装配器不解析像素）。 */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

const REL_SLIDE_MASTER =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster';
const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const REL_NOTES_SLIDE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';
const REL_NOTES_MASTER =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster';
const CT_SLIDE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const CT_NOTES_SLIDE = 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';

interface Fixture {
  readonly bytes: Uint8Array;
  readonly slidePartPaths: readonly string[];
  readonly slideIds: readonly number[];
}

/**
 * 造一份"别人的"既有 PPTX：3 页（首页文本、第二页图片、第一页带备注）、第二套母版与主题、
 * 一个厂商自定义部件。用来验证容器层对多母版/主题与未知部件的保留。
 */
function buildFixture(): Fixture {
  let deck = emptyPresentation('p01', 'P01 装配器语料');
  const first = addSlide(deck);
  deck = first.presentation;
  const second = addSlide(deck);
  deck = second.presentation;
  const third = addSlide(deck);
  deck = third.presentation;

  const textShape: Shape = {
    kind: 'text_box',
    shape_id: 2,
    name: '标题',
    transform: transform(0, 0, 3000000, 1000000),
    text: literalText('第一页'),
  };
  deck = addShape(deck, first.slide_id, textShape);

  const picture: Shape = {
    kind: 'picture',
    shape_id: 2,
    name: '图',
    transform: transform(100000, 100000, 1000000, 1000000),
    media_path: 'ppt/media/image1.png',
    alt_text: '',
    crop: null,
  };
  deck = addShape(deck, second.slide_id, picture);

  deck = setSlideNotes(deck, first.slide_id, literalText('备注一'));

  const rendered = renderPresentation(deck, { media: [{ path: 'ppt/media/image1.png', bytes: PNG_BYTES }] });
  const entries = readZip(rendered.bytes).entries.map((entry) => ({
    path: entry.path,
    data: entry.data,
  }));

  // 第二套母版 + 主题 + 厂商自定义部件（真实文件里可能有，本域"不认识"，必须原样保留）。
  entries.push({ path: 'ppt/slideMasters/slideMaster2.xml', data: utf8Bytes('<p:sldMaster xmlns:p="x"/>') });
  entries.push({ path: 'ppt/theme/theme2.xml', data: utf8Bytes('<a:theme xmlns:a="x"/>') });
  entries.push({ path: 'customXml/vendor.xml', data: utf8Bytes('<vendor>重要</vendor>') });

  const patched = entries.map((entry) => {
    if (entry.path === 'ppt/presentation.xml') {
      const next = Buffer.from(entry.data)
        .toString('utf8')
        .replace(
          '</p:sldMasterIdLst>',
          '<p:sldMasterId id="2147483649" r:id="rId6"/></p:sldMasterIdLst>',
        );
      return { path: entry.path, data: utf8Bytes(next) };
    }
    if (entry.path === 'ppt/_rels/presentation.xml.rels') {
      const next = Buffer.from(entry.data)
        .toString('utf8')
        .replace(
          '</Relationships>',
          `<Relationship Id="rId6" Type="${REL_SLIDE_MASTER}" Target="slideMasters/slideMaster2.xml"/></Relationships>`,
        );
      return { path: entry.path, data: utf8Bytes(next) };
    }
    if (entry.path === '[Content_Types].xml') {
      const next = Buffer.from(entry.data)
        .toString('utf8')
        .replace(
          '</Types>',
          '<Override PartName="/ppt/slideMasters/slideMaster2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
            '<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
            '<Override PartName="/customXml/vendor.xml" ContentType="application/xml"/></Types>',
        );
      return { path: entry.path, data: utf8Bytes(next) };
    }
    return entry;
  });

  const bytes = writeZip(patched);
  return {
    bytes,
    slidePartPaths: slidePartsInOrder(patched),
    slideIds: [first.slide_id, second.slide_id, third.slide_id],
  };
}

// ---------------------------------------------------------------------------
// 容器 + 多母版 / 主题
// ---------------------------------------------------------------------------

describe('P01 容器：内容类型 + 关系图 + 外部多母版 / 主题', () => {
  it('openPresentationPackage 列举两套母版与主题、按页序给出幻灯片、读出内容类型', () => {
    const fixture = buildFixture();
    const pkg = openPresentationPackage(fixture.bytes);

    expect(pkg.slide_part_paths).toEqual(fixture.slidePartPaths);
    expect(fixture.slidePartPaths).toEqual([
      'ppt/slides/slide1.xml',
      'ppt/slides/slide2.xml',
      'ppt/slides/slide3.xml',
    ]);

    // 多母版 / 多主题**不拒绝**，两个都在清单里。
    expect([...pkg.master_part_paths].sort()).toEqual([
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideMasters/slideMaster2.xml',
    ]);
    expect([...pkg.theme_part_paths].sort()).toEqual(['ppt/theme/theme1.xml', 'ppt/theme/theme2.xml']);

    // 备注页与媒体部件被识别。
    expect(pkg.notes_part_paths).toEqual(['ppt/notesSlides/notesSlide1.xml']);
    expect(pkg.media_part_paths).toEqual(['ppt/media/image1.png']);

    // 内容类型：母版 / 主题 / 厂商部件都有覆盖项；png 走 Default。
    const types = contentTypesOf(fixture.bytes);
    expect(types.get('ppt/slideMasters/slideMaster2.xml')).toContain('slideMaster');
    expect(types.get('ppt/theme/theme2.xml')).toContain('theme');
    expect(types.get('customXml/vendor.xml')).toBe('application/xml');
    expect(types.get('ppt/media/image1.png')).toBe('image/png');

    // 关系图把包级 + 演示 + 各页都读出来了。
    const owners = pkg.relationship_groups.map((group) => group.owner_part_path);
    expect(owners).toContain(null);
    expect(owners).toContain('ppt/presentation.xml');
    expect(owners).toContain('ppt/slides/slide2.xml');

    expect(danglingRelationships(entriesOf(fixture.bytes))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 改指定页：未改内容逐字节保留
// ---------------------------------------------------------------------------

describe('P01 装配器：改指定页，其余部件逐字节不变', () => {
  it('replace_parts 只换被列出的页；关系与内容类型不重建', () => {
    const fixture = buildFixture();
    const pkg = openPresentationPackage(fixture.bytes);
    const before = entriesOf(fixture.bytes);

    const target = 'ppt/slides/slide1.xml';
    const newSlide = utf8Bytes(
      textOf(before, target).replace('<a:t>第一页</a:t>', '<a:t>改过了</a:t>'),
    );
    const result = assemblePresentationPackage(pkg, {
      replace_parts: new Map([[target, newSlide]]),
    });

    const after = entriesOf(result.bytes);
    expect(result.replaced_part_paths).toEqual([target]);
    expect(result.added_part_paths).toEqual([]);
    expect(result.removed_part_paths).toEqual([]);
    expect(result.content_types_rebuilt).toBe(false);

    // 被改的页确实是新字节。
    expect(Buffer.from(byteOf(after, target)).toString('utf8')).toContain('改过了');

    // 其余**每一个**部件逐字节不变（含第二套母版 / 主题 / 厂商部件 / 其它页 / 关系 / 内容类型）。
    const unchangedPaths = before
      .map((entry) => entry.path)
      .filter((path) => path !== target);
    expectPartsUnchanged(before, after, unchangedPaths);
    expect(danglingRelationships(after)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 增 / 删页
// ---------------------------------------------------------------------------

describe('P01 装配器：增删页（页部件 + sldIdLst + 关系 + 内容类型）', () => {
  it('增页：新部件 + 新关系 + sldIdLst 末位 + 内容类型覆盖；其余不变', () => {
    const fixture = buildFixture();
    const pkg = openPresentationPackage(fixture.bytes);
    const before = entriesOf(fixture.bytes);

    const slideXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:sld xmlns:a="x" xmlns:r="y" xmlns:p="z"><p:cSld><p:spTree/></p:cSld></p:sld>';
    const result = addSlideToPackage(pkg, {
      slide_xml: slideXml,
      layout_part_path: 'ppt/slideLayouts/slideLayout1.xml',
    });

    expect(result.slide_part_path).toBe('ppt/slides/slide4.xml');
    expect(result.relationship_id).toBe('rId7'); // 既有最大 rId6 + 1

    const after = entriesOf(result.assembly.bytes);
    // 独立解析：页序多了一个末位部件。
    expect(slidePartsInOrder(after)).toEqual([
      'ppt/slides/slide1.xml',
      'ppt/slides/slide2.xml',
      'ppt/slides/slide3.xml',
      'ppt/slides/slide4.xml',
    ]);
    // 新页有内容类型，且它自己的 _rels 指向版式。
    expect(contentTypesOf(result.assembly.bytes).get('ppt/slides/slide4.xml')).toBe(CT_SLIDE);
    expect(
      [...relationshipTargets(textOf(after, 'ppt/slides/_rels/slide4.xml.rels'), 'ppt/slides').values()],
    ).toEqual(['ppt/slideLayouts/slideLayout1.xml']);

    // 除新增的两个部件 + 演示部件 + 演示关系 + 内容类型外，其余逐字节不变。
    expectPartsUnchanged(
      before,
      after,
      before
        .map((entry) => entry.path)
        .filter(
          (path) =>
            path !== 'ppt/presentation.xml' &&
            path !== 'ppt/_rels/presentation.xml.rels' &&
            path !== '[Content_Types].xml',
        ),
    );
    expect(danglingRelationships(after)).toEqual([]);
  });

  it('删页：摘关系 + 摘 sldId + 删部件 + 注销内容类型；其余不变', () => {
    const fixture = buildFixture();
    const pkg = openPresentationPackage(fixture.bytes);
    const before = entriesOf(fixture.bytes);

    const result = removeSlideFromPackage(pkg, 'ppt/slides/slide2.xml');
    const after = entriesOf(result.assembly.bytes);

    expect(slidePartsInOrder(after)).toEqual(['ppt/slides/slide1.xml', 'ppt/slides/slide3.xml']);
    expect(after.some((entry) => entry.path === 'ppt/slides/slide2.xml')).toBe(false);
    expect(after.some((entry) => entry.path === 'ppt/slides/_rels/slide2.xml.rels')).toBe(false);
    // 内容类型里不再有它。
    expect(
      [...after].some((entry) => entry.path === '[Content_Types].xml' && Buffer.from(entry.data).toString('utf8').includes('slide2.xml')),
    ).toBe(false);

    // 首页（带备注）与第三页、两套母版/主题都没被碰。
    expectPartsUnchanged(before, after, [
      'ppt/slides/slide1.xml',
      'ppt/slides/_rels/slide1.xml.rels',
      'ppt/slides/slide3.xml',
      'ppt/notesSlides/notesSlide1.xml',
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideMasters/slideMaster2.xml',
      'ppt/theme/theme2.xml',
      'customXml/vendor.xml',
    ]);
    expect(danglingRelationships(after)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 媒体关系
// ---------------------------------------------------------------------------

describe('P01 装配器：增 / 删媒体关系', () => {
  it('挂媒体：媒体部件 + png 默认项 + 该页 image 关系；返回可引用的关系 id', () => {
    const fixture = buildFixture();
    const pkg = openPresentationPackage(fixture.bytes);
    const before = entriesOf(fixture.bytes);

    const result = linkSlideMedia(pkg, {
      slide_part_path: 'ppt/slides/slide1.xml',
      media_part_path: 'ppt/media/image9.png',
      media_bytes: PNG_BYTES,
      content_type: 'image/png',
    });
    const after = entriesOf(result.assembly.bytes);

    expect(result.media_part_path).toBe('ppt/media/image9.png');
    expect(contentTypesOf(result.assembly.bytes).get('ppt/media/image9.png')).toBe('image/png');

    const slideRels = relationshipTargets(textOf(after, 'ppt/slides/_rels/slide1.xml.rels'), 'ppt/slides');
    expect(slideRels.get(result.relationship_id)).toBe('ppt/media/image9.png');
    // 关系 id 是既有最大 id + 1（既有 id 不重编号）。
    expect(result.relationship_id).toBe('rId3'); // slide1 既有 rId1=版式, rId2=备注

    // 既有媒体与其它部件不变。
    expectPartsUnchanged(before, after, [
      'ppt/media/image1.png',
      'ppt/slides/slide2.xml',
      'ppt/theme/theme1.xml',
      'customXml/vendor.xml',
    ]);
    expect(danglingRelationships(after)).toEqual([]);
  });

  it('摘媒体：删关系（可选删部件）；其余不变', () => {
    const fixture = buildFixture();
    const pkg = openPresentationPackage(fixture.bytes);

    // 第二页原本挂了一条 image 关系（rId2）。
    const slide2Rels = packageRelsOf(pkg, 'ppt/slides/slide2.xml');
    const imageRel = slide2Rels.find((rel) => rel.endsWith(`|${REL_IMAGE}`));
    expect(imageRel).toBeDefined();
    const imageRelId = imageRel?.split('|')[0] as string;

    const result = unlinkSlideMedia(pkg, {
      slide_part_path: 'ppt/slides/slide2.xml',
      relationship_id: imageRelId,
      remove_media_part: true,
    });
    const after = entriesOf(result.assembly.bytes);

    expect(result.removed_media_part_path).toBe('ppt/media/image1.png');
    expect(after.some((entry) => entry.path === 'ppt/media/image1.png')).toBe(false);
    expect(
      [
        ...relationshipTargets(textOf(after, 'ppt/slides/_rels/slide2.xml.rels'), 'ppt/slides').values(),
      ].some((target) => target.startsWith('ppt/media/')),
    ).toBe(false);
    expect(danglingRelationships(after)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 备注关系
// ---------------------------------------------------------------------------

describe('P01 装配器：增 / 删备注关系', () => {
  it('挂备注：备注部件 + 该页 notesSlide 关系 + 备注 _rels 指向该页与 notesMaster', () => {
    const fixture = buildFixture();
    const pkg = openPresentationPackage(fixture.bytes);

    const notesXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:notes xmlns:a="x" xmlns:r="y" xmlns:p="z"><p:cSld><p:spTree/></p:cSld></p:notes>';
    const result = linkSlideNotes(pkg, {
      slide_part_path: 'ppt/slides/slide3.xml',
      notes_xml: notesXml,
    });
    const after = entriesOf(result.assembly.bytes);

    // 语料已有 notesMaster（首页有备注），故不再造一份。
    const notesMaster = packageRelsOf(pkg, 'ppt/presentation.xml').find((rel) => rel.endsWith(`|${REL_NOTES_MASTER}`));
    expect(notesMaster).toBeDefined();

    expect(result.notes_part_path).toBe('ppt/notesSlides/notesSlide2.xml');
    expect(contentTypesOf(result.assembly.bytes).get(result.notes_part_path)).toBe(CT_NOTES_SLIDE);

    const slideRels = relationshipTargets(textOf(after, 'ppt/slides/_rels/slide3.xml.rels'), 'ppt/slides');
    expect(slideRels.get(result.relationship_id)).toBe(result.notes_part_path);

    const notesRels = [...relationshipTargets(textOf(after, 'ppt/notesSlides/_rels/notesSlide2.xml.rels'), 'ppt/notesSlides').values()];
    expect(notesRels.sort()).toEqual(['ppt/notesMasters/notesMaster1.xml', 'ppt/slides/slide3.xml']);

    // 首页原有备注部件未被碰。
    expectPartsUnchanged(entriesOf(fixture.bytes), after, ['ppt/notesSlides/notesSlide1.xml']);
    expect(danglingRelationships(after)).toEqual([]);
  });

  it('摘备注：删关系 + 删备注部件；其余不变', () => {
    const fixture = buildFixture();
    const pkg = openPresentationPackage(fixture.bytes);

    const result = unlinkSlideNotes(pkg, { slide_part_path: 'ppt/slides/slide1.xml' });
    const after = entriesOf(result.assembly.bytes);

    expect(result.removed_notes_part_path).toBe('ppt/notesSlides/notesSlide1.xml');
    expect(after.some((entry) => entry.path === 'ppt/notesSlides/notesSlide1.xml')).toBe(false);
    expect(
      [...relationshipTargets(textOf(after, 'ppt/slides/_rels/slide1.xml.rels'), 'ppt/slides').values()].some(
        (target) => target.includes('notesSlides'),
      ),
    ).toBe(false);
    expectPartsUnchanged(entriesOf(fixture.bytes), after, [
      'ppt/slides/slide2.xml',
      'ppt/slideMasters/slideMaster2.xml',
      'customXml/vendor.xml',
    ]);
    expect(danglingRelationships(after)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 消费端重开（另一条真实读回路径，独立于装配器）
// ---------------------------------------------------------------------------

describe('P01 装配器：产物可被真实导入器 roundtrip 重新读回（消费端重开）', () => {
  function simpleDeck(): Uint8Array {
    let deck = emptyPresentation('p01-simple', '简单多页');
    deck = addSlide(deck).presentation;
    deck = addSlide(deck).presentation;
    return renderPresentation(deck).bytes;
  }

  it('增页后 roundtrip.importPresentation 读回 3 页；删页后读回 1 页', async () => {
    const { importPresentation } = await import('../../../../src/presentations/roundtrip.js');
    const pkg = openPresentationPackage(simpleDeck());

    const added = addSlideToPackage(pkg, {
      slide_xml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<p:sld xmlns:a="x" xmlns:r="y" xmlns:p="z"><p:cSld><p:spTree/></p:cSld></p:sld>',
      layout_part_path: 'ppt/slideLayouts/slideLayout1.xml',
    });
    const reopened = importPresentation(added.assembly.bytes);
    expect(reopened.presentation.slides.length).toBe(3);
    expect(reopened.bindings.map((binding) => binding.part_path)).toEqual([
      'ppt/slides/slide1.xml',
      'ppt/slides/slide2.xml',
      'ppt/slides/slide3.xml',
    ]);

    const removed = removeSlideFromPackage(pkg, 'ppt/slides/slide2.xml');
    const reopenedAfterRemove = importPresentation(removed.assembly.bytes);
    expect(reopenedAfterRemove.presentation.slides.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 失败面（具名报错，不静默）
// ---------------------------------------------------------------------------

describe('P01 装配器：失败面不静默降级', () => {
  function expectAssemblyError(run: () => unknown, reason: string): void {
    try {
      run();
      throw new Error('应当抛出 PresentationAssemblyError');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationAssemblyError);
      expect((error as PresentationAssemblyError).reason).toBe(reason);
    }
  }

  it('替换不存在的部件 ⇒ unknown_part', () => {
    const pkg = openPresentationPackage(buildFixture().bytes);
    expectAssemblyError(
      () => assemblePresentationPackage(pkg, { replace_parts: new Map([['ppt/slides/slide9.xml', utf8Bytes('x')]]) }),
      'unknown_part',
    );
  });

  it('新增重复部件 ⇒ duplicate_part', () => {
    const pkg = openPresentationPackage(buildFixture().bytes);
    expectAssemblyError(
      () =>
        assemblePresentationPackage(pkg, {
          add_parts: [{ path: 'ppt/slides/slide1.xml', content_type: CT_SLIDE, data: 'x' }],
        }),
      'duplicate_part',
    );
  });

  it('摘除不存在的关系 id ⇒ unknown_relationship_id', () => {
    const pkg = openPresentationPackage(buildFixture().bytes);
    expectAssemblyError(
      () =>
        assemblePresentationPackage(pkg, {
          relationship_edits: [{ owner_part_path: 'ppt/slides/slide1.xml', remove_ids: ['rId999'] }],
        }),
      'unknown_relationship_id',
    );
  });

  it('无 notesMaster 时挂备注 ⇒ unknown_notes_master（不凭空造母版）', () => {
    // 一份**没有**备注的文稿 ⇒ 渲染结果里没有 notesMaster 关系。
    let deck = emptyPresentation('p01-nonotes', '无备注');
    deck = addSlide(deck).presentation;
    const bytes = renderPresentation(deck).bytes;
    const pkg = openPresentationPackage(bytes);
    expect(packageRelsOf(pkg, 'ppt/presentation.xml').some((rel) => rel.endsWith(`|${REL_NOTES_MASTER}`))).toBe(false);

    expectAssemblyError(
      () =>
        linkSlideNotes(pkg, {
          slide_part_path: 'ppt/slides/slide1.xml',
          notes_xml: '<p:notes xmlns:p="z"/>',
        }),
      'unknown_notes_master',
    );
  });
});

// ---------------------------------------------------------------------------
// 关系 id 提取小工具（读侧，供用例定位既有关系）
// ---------------------------------------------------------------------------

/** `"${id}|${type}"` 列表（供用例挑出某类既有关系）。 */
function packageRelsOf(
  pkg: ReturnType<typeof openPresentationPackage>,
  owner: string | null,
): readonly string[] {
  const group = pkg.relationship_groups.find((candidate) => candidate.owner_part_path === owner);
  if (group === undefined) return [];
  return group.relationships.map((relationship) => `${relationship.id}|${relationship.type}`);
}

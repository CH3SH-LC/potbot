/**
 * 图片与媒体用例（design-06 P9 / PPT-06）。
 *
 * 判据分三层，缺一层就挡不住一种造假：
 *
 * 1. **成对**：渲染出的包里，每个 `r:embed` 都有 `_rels` 关系，且关系指向**真实存在**的
 *    `ppt/media/**` 部件；包内每个媒体部件都**至少被引用一次**；
 * 2. **反向对照**：删掉部件字节 / 加一条指向幽灵部件的 `…/image` 关系 / 放一个没人引用的
 *    部件 —— 三种都必须被**具名错误**捕获（不是"大概没校验"）；
 * 3. **透明度**：`render.ts` 的 `p:pic` 不含 `a:alphaModFix`，本模块的 `renderPictureXml`
 *    必须真的把它写出来，且产物可被 XML 解析。
 */

import { describe, expect, it } from 'vitest';

import { readZip, utf8Bytes, writeZip } from '../artifacts/ooxml/index.js';
import { literalText, transform, type Shape } from './model.js';
import {
  type MediaCatalog,
  PresentationMediaError,
  addMediaPart,
  buildMediaDeck,
  clearPictureCrop,
  deletePicture,
  insertPicture,
  isImagePath,
  mediaCatalog,
  pictureShape,
  pruneUnreferencedMedia,
  readPictureMediaInPackage,
  referencedMediaPaths,
  removeMediaPart,
  renderPictureXml,
  replacePicture,
  replaceMediaPart,
  replacePictureBytesInPackage,
  scalePicture,
  setPictureAspectRatio,
  setPictureCrop,
  setPictureTransparency,
  verifyMediaPairingInPackage,
  wrapPictureInSlideDocument,
  type PictureAdjustments,
} from './media.js';
import { addShape, addSlide } from './operations.js';
import { emptyPresentation } from './render.js';
import { attributeOf, childElements, parseXmlDocument, type XmlElementNode } from './xml-parse.js';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG2_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);

function deckWithSlides(count: number) {
  let deck = emptyPresentation('p1', '图片测试');
  for (let i = 0; i < count; i += 1) {
    deck = addSlide(deck).presentation;
  }
  return deck;
}

function textOf(bytes: Uint8Array, path: string): string {
  const archive = readZip(bytes);
  const entry = archive.by_path.get(path);
  if (entry === undefined) throw new Error(`包内没有 ${path}`);
  return Buffer.from(entry.data).toString('utf8');
}

function findElements(node: XmlElementNode, name: string, out: XmlElementNode[] = []): XmlElementNode[] {
  if (node.name === name) out.push(node);
  for (const child of childElements(node)) findElements(child, name, out);
  return out;
}

/** 一份"两页 + 第一页一张图"的模型与目录。 */
function pictureDeck() {
  const inserted = insertPicture(deckWithSlides(2), 1, {
    transform: transform(1000000, 500000, 3000000, 2000000),
    media_path: 'ppt/media/image1.png',
    alt_text: '示意图',
  });
  return { presentation: inserted.presentation, catalog: mediaCatalog([{ path: 'ppt/media/image1.png', bytes: PNG_BYTES }]) };
}

describe('PPT-06：图片插入（媒体部件 + rId 必须成对）', () => {
  it('插入图片后打包：rId 有 _rels 关系、关系指向真实 media 部件、包内部件被引用', () => {
    const { presentation, catalog } = pictureDeck();
    const result = buildMediaDeck(presentation, catalog);

    expect(result.slide_count).toBe(2);
    expect(result.media_part_count).toBe(1);

    const report = verifyMediaPairingInPackage(result.bytes);
    expect(report.references).toHaveLength(1);
    const reference = report.references[0];
    expect(reference?.slide_part).toBe('ppt/slides/slide1.xml');
    expect(reference?.media_path).toBe('ppt/media/image1.png');
    // rId 不是"随便一个字符串"：关系 id 由 _rels 的顺序分配（0 留给版式）。
    expect(reference?.rel_id).toBe('rId2');

    // 真实字节读回：页里的 a:blip 与 _rels 里的关系**互相对上**。
    const slide = textOf(result.bytes, 'ppt/slides/slide1.xml');
    expect(slide).toContain('<a:blip r:embed="rId2"');
    const rels = textOf(result.bytes, 'ppt/slides/_rels/slide1.xml.rels');
    expect(rels).toContain('Target="../media/image1.png"');

    // 另一页没有图片：不得凭空多出一条图片关系。
    expect(textOf(result.bytes, 'ppt/slides/_rels/slide2.xml.rels')).not.toContain('/image');
  });

  it('媒体部件的内容类型来自受支持表（与 render.ts 同表）', () => {
    const { presentation, catalog } = pictureDeck();
    const bytes = buildMediaDeck(presentation, catalog).bytes;
    const contentTypes = textOf(bytes, '[Content_Types].xml');
    expect(contentTypes).toContain('Extension="png"');
    expect(contentTypes).toContain('ContentType="image/png"');
  });

  it('插入时若媒体目录里没有该路径 ⇒ 立即报错（插进去就一定成对）', () => {
    expect(() =>
      insertPicture(deckWithSlides(1), 1, {
        transform: transform(0, 0, 100, 100),
        media_path: 'ppt/media/none.png',
      }, mediaCatalog([])),
    ).toThrow(PresentationMediaError);
  });
});

describe('PPT-06 反向对照：三种"不成对"都必须被具名捕获', () => {
  it('「有关系没部件」：删掉媒体部件字节后，读回校验必须报 unpaired_media_relationship', () => {
    const { presentation, catalog } = pictureDeck();
    const good = buildMediaDeck(presentation, catalog).bytes;

    // 把 ppt/media/image1.png 从包里摘掉——rId 还在，部件没了。
    const archive = readZip(good);
    const stripped = writeZip(
      archive.entries
        .filter((entry) => entry.path !== 'ppt/media/image1.png')
        .map((entry) => ({ path: entry.path, data: entry.data })),
    );

    expect(() => verifyMediaPairingInPackage(stripped)).toThrow(PresentationMediaError);
    try {
      verifyMediaPairingInPackage(stripped);
    } catch (error) {
      expect((error as PresentationMediaError).reason).toBe('unpaired_media_relationship');
    }
  });

  it('「有 rId 没部件」：_rels 里加一条指向幽灵部件的 image 关系，必须被捕获', () => {
    const { presentation, catalog } = pictureDeck();
    const good = buildMediaDeck(presentation, catalog).bytes;

    const archive = readZip(good);
    const patched = writeZip(
      archive.entries.map((entry) =>
        entry.path === 'ppt/slides/_rels/slide1.xml.rels'
          ? {
              path: entry.path,
              data: utf8Bytes(
                Buffer.from(entry.data)
                  .toString('utf8')
                  .replace(
                    '</Relationships>',
                    '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/ghost.png"/></Relationships>',
                  ),
              ),
            }
          : { path: entry.path, data: entry.data },
      ),
    );

    try {
      verifyMediaPairingInPackage(patched);
      throw new Error('应当报错：幽灵 rId 未被捕获');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationMediaError);
      expect((error as PresentationMediaError).reason).toBe('unpaired_media_relationship');
    }
  });

  it('「有部件没 rId」：目录里有孤儿媒体 ⇒ buildMediaDeck 必须拒绝打包', () => {
    const { presentation } = pictureDeck();
    const withOrphan: MediaCatalog = addMediaPart(
      mediaCatalog([{ path: 'ppt/media/image1.png', bytes: PNG_BYTES }]),
      'ppt/media/orphan.png',
      PNG2_BYTES,
    );
    try {
      buildMediaDeck(presentation, withOrphan);
      throw new Error('应当报错：孤儿媒体部件未被捕获');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationMediaError);
      expect((error as PresentationMediaError).reason).toBe('unreferenced_media_part');
    }
  });
});

describe('PPT-06：替换 / 删除图片', () => {
  it('替换媒体：新部件与原字节都在，旧路径成孤儿后被清理，模型指向新路径', () => {
    const { presentation, catalog } = pictureDeck();
    const replaced = replacePicture(
      presentation,
      catalog,
      { slide_id: 1, shape_id: 2 },
      { media_path: 'ppt/media/image2.png', bytes: PNG2_BYTES, alt_text: '新示意图' },
    );

    expect(referencedMediaPaths(replaced.presentation)).toEqual(['ppt/media/image2.png']);
    expect(replaced.catalog.parts.map((part) => part.path)).toEqual(['ppt/media/image2.png']);
    const picture = replaced.presentation.slides[0]?.shapes[0];
    expect(picture?.kind === 'picture' && picture.media_path).toBe('ppt/media/image2.png');
    expect(picture?.kind === 'picture' && picture.alt_text).toBe('新示意图');

    const result = buildMediaDeck(replaced.presentation, replaced.catalog);
    expect(result.media_part_count).toBe(1);
    expect(textOf(result.bytes, 'ppt/slides/_rels/slide1.xml.rels')).toContain('../media/image2.png');
  });

  it('替换时不给新字节且目录里也没有 ⇒ 报错（不假称换上了）', () => {
    const { presentation, catalog } = pictureDeck();
    expect(() =>
      replacePicture(presentation, catalog, { slide_id: 1, shape_id: 2 }, { media_path: 'ppt/media/other.png' }),
    ).toThrow(PresentationMediaError);
  });

  it('删除图片：对象消失、孤儿部件被清理、其余页不受影响', () => {
    const { presentation, catalog } = pictureDeck();
    const deleted = deletePicture(presentation, catalog, { slide_id: 1, shape_id: 2 });
    expect(deleted.presentation.slides[0]?.shapes).toHaveLength(0);
    expect(deleted.catalog.parts).toHaveLength(0);
    expect(deleted.presentation.slides[1]).toBe(presentation.slides[1]);
    // 删完之后打包仍成立（没有媒体部件，也没有引用）。
    expect(buildMediaDeck(deleted.presentation, deleted.catalog).media_part_count).toBe(0);
  });

  it('对非图片对象做图片操作 ⇒ 报 not_a_picture；对不存在的对象 ⇒ 报 unknown_shape', () => {
    const textBox: Shape = {
      kind: 'text_box',
      shape_id: 5,
      name: 'Box',
      transform: transform(0, 0, 100, 100),
      text: literalText('不是图片'),
    };
    const deck = addShape(deckWithSlides(1), 1, textBox);

    for (const call of [
      () => setPictureCrop(deck, { slide_id: 1, shape_id: 5 }, { l: 0, t: 0, r: 0, b: 0 }),
      () => clearPictureCrop(deck, { slide_id: 1, shape_id: 5 }),
      () => scalePicture(deck, { slide_id: 1, shape_id: 5 }, 2),
    ]) {
      try {
        call();
        throw new Error('应当报错');
      } catch (error) {
        expect(error).toBeInstanceOf(PresentationMediaError);
        expect((error as PresentationMediaError).reason).toBe('not_a_picture');
      }
    }

    try {
      setPictureCrop(deck, { slide_id: 1, shape_id: 404 }, { l: 0, t: 0, r: 0, b: 0 });
      throw new Error('应当报错');
    } catch (error) {
      expect((error as PresentationMediaError).reason).toBe('unknown_shape');
    }
  });
});

describe('PPT-06：裁剪、透明度、比例', () => {
  it('裁剪落到 a:srcRect，清除后不再出现', () => {
    const { presentation } = pictureDeck();
    const cropped = setPictureCrop(presentation, { slide_id: 1, shape_id: 2 }, { l: 10000, t: 20000, r: 0, b: 0 });
    const picture = cropped.slides[0]?.shapes[0];
    if (picture?.kind !== 'picture') throw new Error('应当是图片');

    const xml = renderPictureXml(picture, 'rId2');
    expect(xml).toContain('<a:srcRect l="10000" t="20000" r="0" b="0"/>');

    const cleared = clearPictureCrop(cropped, { slide_id: 1, shape_id: 2 });
    const clearedPicture = cleared.slides[0]?.shapes[0];
    if (clearedPicture?.kind !== 'picture') throw new Error('应当是图片');
    expect(renderPictureXml(clearedPicture, 'rId2')).not.toContain('srcRect');
  });

  it('非法裁剪（裁没 / 越界）⇒ 报 invalid_crop', () => {
    const { presentation } = pictureDeck();
    for (const crop of [
      { l: 0, t: 0, r: 100000, b: 0 },
      { l: -1, t: 0, r: 0, b: 0 },
      { l: 60000, t: 0, r: 60000, b: 0 },
    ]) {
      try {
        setPictureCrop(presentation, { slide_id: 1, shape_id: 2 }, crop);
        throw new Error('应当报错');
      } catch (error) {
        expect((error as PresentationMediaError).reason).toBe('invalid_crop');
      }
    }
  });

  it('透明度落到 a:alphaModFix（100 时不写），且片段可被 XML 解析', () => {
    const { presentation } = pictureDeck();
    const picture = presentation.slides[0]?.shapes[0];
    if (picture?.kind !== 'picture') throw new Error('应当是图片');

    let adjustments: PictureAdjustments = { opacity_percent_by_shape: new Map() };
    adjustments = setPictureTransparency(adjustments, 2, 40);
    const xml = renderPictureXml(picture, 'rId2', { opacity_percent: adjustments.opacity_percent_by_shape.get(2) });

    expect(xml).toContain('<a:alphaModFix amt="40000"/>');
    expect(renderPictureXml(picture, 'rId2', { opacity_percent: 100 })).not.toContain('alphaModFix');

    // 产物是**真 XML**：能被解析器读成树，而不是"看着像"。
    const document = wrapPictureInSlideDocument(xml);
    const root = parseXmlDocument(document);
    expect(root.name).toBe('p:sld');
    const blips = findElements(root, 'a:blip');
    expect(blips).toHaveLength(1);
    expect(attributeOf(blips[0], 'r:embed')).toBe('rId2');
    expect(findElements(root, 'a:alphaModFix')).toHaveLength(1);
  });

  it('不透明度越界 ⇒ invalid_opacity', () => {
    expect(() => setPictureTransparency({ opacity_percent_by_shape: new Map() }, 2, 101)).toThrow(
      PresentationMediaError,
    );
    const { presentation } = pictureDeck();
    const picture = presentation.slides[0]?.shapes[0];
    if (picture?.kind !== 'picture') throw new Error('应当是图片');
    expect(() => renderPictureXml(picture, 'rId2', { opacity_percent: -1 })).toThrow(PresentationMediaError);
  });

  it('比例：按宽高比设高 / 等比缩放；非法比例报错', () => {
    const { presentation } = pictureDeck();
    const ratio = setPictureAspectRatio(presentation, { slide_id: 1, shape_id: 2 }, 1.5);
    const picture = ratio.slides[0]?.shapes[0];
    if (picture?.kind !== 'picture') throw new Error('应当是图片');
    expect(picture.transform.cy_emu).toBe(Math.round(3000000 / 1.5));

    const scaled = scalePicture(ratio, { slide_id: 1, shape_id: 2 }, 2);
    const scaledPicture = scaled.slides[0]?.shapes[0];
    if (scaledPicture?.kind !== 'picture') throw new Error('应当是图片');
    expect(scaledPicture.transform.cx_emu).toBe(6000000);
    expect(scaledPicture.transform.cy_emu).toBe(picture.transform.cy_emu * 2);

    expect(() => setPictureAspectRatio(presentation, { slide_id: 1, shape_id: 2 }, 0)).toThrow(
      PresentationMediaError,
    );
    expect(() => scalePicture(presentation, { slide_id: 1, shape_id: 2 }, -1)).toThrow(PresentationMediaError);
  });
});

describe('媒体目录与扩展名（不猜）', () => {
  it('未知扩展名 ⇒ unknown_media_type；重复路径 ⇒ duplicate_media_path', () => {
    expect(() => isImagePath('ppt/media/clip.xyz')).toThrow(PresentationMediaError);
    try {
      isImagePath('ppt/media/clip.xyz');
    } catch (error) {
      expect((error as PresentationMediaError).reason).toBe('unknown_media_type');
    }
    expect(() => mediaCatalog([
      { path: 'ppt/media/a.png', bytes: PNG_BYTES },
      { path: 'ppt/media/a.png', bytes: PNG2_BYTES },
    ])).toThrow(PresentationMediaError);
  });

  it('替换 / 删除目录里的不存在的部件 ⇒ 报错；prune 保留仍被引用的', () => {
    const { presentation, catalog } = pictureDeck();
    expect(() => replaceMediaPart(catalog, 'ppt/media/none.png', PNG_BYTES)).toThrow(PresentationMediaError);
    expect(() => removeMediaPart(catalog, 'ppt/media/none.png')).toThrow(PresentationMediaError);
    expect(pruneUnreferencedMedia(presentation, catalog).parts).toHaveLength(1);
  });

  it('pictureShape 便捷构造会先校验扩展名', () => {
    expect(() => pictureShape(2, 'ppt/media/x.tiff')).toThrow(PresentationMediaError);
    const shape = pictureShape(2, 'ppt/media/x.png', { alt_text: '图' });
    expect(shape.kind).toBe('picture');
    expect(shape.alt_text).toBe('图');
    expect(literalText('x').paragraphs).toHaveLength(1);
  });
});

describe('PPT-06：对真实字节的图片读回与就地换字节', () => {
  const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

  it('readPictureMediaInPackage：读回关系 / 媒体路径 / 裁剪 / 真实字节', () => {
    const { presentation, catalog } = pictureDeck();
    const bytes = buildMediaDeck(presentation, catalog).bytes;

    const records = readPictureMediaInPackage(bytes);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record?.slide_part).toBe('ppt/slides/slide1.xml');
    expect(record?.shape_id).toBe(2);
    expect(record?.rel_id).toBe('rId2');
    expect(record?.media_path).toBe('ppt/media/image1.png');
    expect(record?.crop).toBeNull();
    // 读回的是**包里那份字节**，与目录里给的源逐字节相同。
    expect(sameBytes(record!.bytes, PNG_BYTES)).toBe(true);
  });

  it('readPictureMediaInPackage：裁剪读成模型字段，与整图区分', () => {
    const { presentation, catalog } = pictureDeck();
    const cropped = setPictureCrop(presentation, { slide_id: 1, shape_id: 2 }, { l: 10000, t: 20000, r: 0, b: 0 });
    const bytes = buildMediaDeck(cropped, catalog).bytes;

    const record = readPictureMediaInPackage(bytes)[0];
    expect(record?.crop).toEqual({ l: 10000, t: 20000, r: 0, b: 0 });
    // 裁剪不改底层字节。
    expect(sameBytes(record!.bytes, PNG_BYTES)).toBe(true);
  });

  it('readPictureMediaInPackage：媒体部件被摘掉 ⇒ unpaired_media_relationship（不静默）', () => {
    const { presentation, catalog } = pictureDeck();
    const good = buildMediaDeck(presentation, catalog).bytes;
    const archive = readZip(good);
    const stripped = writeZip(
      archive.entries
        .filter((entry) => entry.path !== 'ppt/media/image1.png')
        .map((entry) => ({ path: entry.path, data: entry.data })),
    );
    try {
      readPictureMediaInPackage(stripped);
      throw new Error('应当报错：媒体部件缺失未被捕获');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationMediaError);
      expect((error as PresentationMediaError).reason).toBe('unpaired_media_relationship');
    }
  });

  it('replacePictureBytesInPackage：换字节保关系（幻灯片 XML 与 _rels 逐字节不变）', () => {
    const { presentation, catalog } = pictureDeck();
    const before = buildMediaDeck(presentation, catalog).bytes;
    const beforeArchive = readZip(before);

    const result = replacePictureBytesInPackage(before, { slide_part: 'ppt/slides/slide1.xml', shape_id: 2 }, PNG2_BYTES);
    expect(result.rel_id).toBe('rId2');
    expect(result.media_path).toBe('ppt/media/image1.png');

    const afterArchive = readZip(result.bytes);
    const slideBytes = (archive: ReturnType<typeof readZip>, path: string): Uint8Array => {
      const entry = archive.by_path.get(path);
      if (entry === undefined) throw new Error(`包内没有 ${path}`);
      return entry.data;
    };
    expect(sameBytes(slideBytes(afterArchive, 'ppt/slides/slide1.xml'), slideBytes(beforeArchive, 'ppt/slides/slide1.xml'))).toBe(true);
    expect(
      sameBytes(
        slideBytes(afterArchive, 'ppt/slides/_rels/slide1.xml.rels'),
        slideBytes(beforeArchive, 'ppt/slides/_rels/slide1.xml.rels'),
      ),
    ).toBe(true);
    // 媒体字节确为新源。
    expect(sameBytes(slideBytes(afterArchive, 'ppt/media/image1.png'), PNG2_BYTES)).toBe(true);
    expect(() => verifyMediaPairingInPackage(result.bytes)).not.toThrow();
  });

  it('replacePictureBytesInPackage：目标不存在 ⇒ unknown_shape', () => {
    const { presentation, catalog } = pictureDeck();
    const bytes = buildMediaDeck(presentation, catalog).bytes;
    try {
      replacePictureBytesInPackage(bytes, { slide_part: 'ppt/slides/slide1.xml', shape_id: 999 }, PNG2_BYTES);
      throw new Error('应当报错：目标图片不存在');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationMediaError);
      expect((error as PresentationMediaError).reason).toBe('unknown_shape');
    }
  });
});

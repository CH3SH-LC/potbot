/**
 * P-I18 · media.ts 换图 + `a:srcRect` 裁剪的真实字节往返（PPT-06 / P05）。
 *
 * 判据（都对着**渲染出来的真实 ZIP 字节**，不靠模型自证）：
 *
 * 1. **换字节保关系**：把某张图片的媒体字节换成新源后，重开包读回的 `ppt/media/**`
 *    字节**逐字节等于新源**，且 `a:blip@r:embed` **仍指向同一条关系**（rId 不变、关系仍闭合）；
 * 2. **裁剪往返**：`setPictureCrop` → 渲染 → `importPresentation` 重开后，形状报出**同样的
 *    `a:srcRect`**（l/t/r/b 四个模型字段），且**底层图片字节一个字节没动**；
 * 3. **与整图区分**：未裁剪图片的 `crop === null`，裁剪图片 `crop !== null`，两者不相等。
 *
 * 本用例的解析器（rId→关系→部件、`<a:srcRect>` 属性）由用例**自己**实现，不复用被测模块的
 * 判断，避免"模块说自己对"。
 */

import { describe, expect, it } from 'vitest';

import { readZip, type ReadZipArchive } from '../../../../src/artifacts/ooxml/index.js';
import { transform, type Shape } from '../../../../src/presentations/model.js';
import {
  buildMediaDeck,
  clearPictureCrop,
  insertPicture,
  mediaCatalog,
  PresentationMediaError,
  readPictureMediaInPackage,
  replacePicture,
  replacePictureBytesInPackage,
  setPictureCrop,
  verifyMediaPairingInPackage,
} from '../../../../src/presentations/media.js';
import { addSlide } from '../../../../src/presentations/operations.js';
import { emptyPresentation } from '../../../../src/presentations/render.js';
import { importPresentation } from '../../../../src/presentations/roundtrip.js';

/** 三份"可区分"的 PNG 字节（本例只需要字节不同，不要求是合法 PNG 解码）。 */
const PNG_SRC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 11, 11, 11]);
const PNG_NEW = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 22, 22, 22, 22]);
const PNG_THIRD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 33, 33, 33, 33, 33]);

const MEDIA_PATH = 'ppt/media/image1.png';
const SLIDE1 = 'ppt/slides/slide1.xml';

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

function bytesAt(archive: ReadZipArchive, path: string): Uint8Array {
  const entry = archive.by_path.get(path);
  if (entry === undefined) throw new Error(`包内没有 ${path}`);
  return entry.data;
}

/** 一份"两页 + 第一页一张图"的模型与目录（图片 shape_id 由用例持住）。 */
function pictureDeck() {
  let deck = emptyPresentation('p1', 'P-I18 图片往返');
  deck = addSlide(deck).presentation;
  deck = addSlide(deck).presentation;
  const inserted = insertPicture(deck, 1, {
    transform: transform(1000000, 500000, 3000000, 2000000),
    media_path: MEDIA_PATH,
    alt_text: '原图',
  });
  const catalog = mediaCatalog([{ path: MEDIA_PATH, bytes: PNG_SRC }]);
  return { presentation: inserted.presentation, catalog, shape_id: inserted.shape_id };
}

/** 用例自有的 `<a:srcRect>` 抽取：直接读幻灯片 XML 的属性串，不经过被测模块。 */
function rawSrcRect(slideXml: string): string | null {
  const match = /<a:srcRect\b[^>]*\/>/.exec(slideXml);
  return match === null ? null : match[0];
}

function slideXmlOf(bytes: Uint8Array, path = SLIDE1): string {
  return Buffer.from(bytesAt(readZip(bytes), path)).toString('utf8');
}

describe('P-I18 换图：换掉部件字节、保住关系', () => {
  it('模型路径换同路径新字节：重开包字节等于新源，r:embed 仍解析', () => {
    const { presentation, catalog, shape_id } = pictureDeck();
    const before = buildMediaDeck(presentation, catalog).bytes;
    const relBefore = readPictureMediaInPackage(before)[0]?.rel_id;
    expect(relBefore).toBe('rId2');

    const replaced = replacePicture(
      presentation,
      catalog,
      { slide_id: 1, shape_id },
      { media_path: MEDIA_PATH, bytes: PNG_NEW },
    );
    const after = buildMediaDeck(replaced.presentation, replaced.catalog).bytes;

    // 读回：包里那份媒体部件的字节 == 新源（逐字节）。
    const record = readPictureMediaInPackage(after)[0];
    expect(record?.media_path).toBe(MEDIA_PATH);
    expect(sameBytes(record!.bytes, PNG_NEW)).toBe(true);
    expect(sameBytes(record!.bytes, PNG_SRC)).toBe(false);
    // 关系没被换掉：rId 不变，且成对校验仍通过（r:embed 仍解析）。
    expect(record?.rel_id).toBe(relBefore);
    expect(() => verifyMediaPairingInPackage(after)).not.toThrow();

    // 独立读一遍幻灯片 XML：a:blip 的 r:embed 仍是 rId2。
    expect(slideXmlOf(after)).toContain(`<a:blip r:embed="${relBefore}"`);
  });

  it('字节级就地换图：幻灯片 XML 与 _rels 逐字节不变，rId 不变，媒体字节为新源', () => {
    const { presentation, catalog, shape_id } = pictureDeck();
    const before = buildMediaDeck(presentation, catalog).bytes;
    const beforeArchive = readZip(before);

    const result = replacePictureBytesInPackage(before, { slide_part: SLIDE1, shape_id }, PNG_THIRD);

    // 关系 id / 部件路径照旧；换的只是那一份部件的字节。
    expect(result.rel_id).toBe('rId2');
    expect(result.media_path).toBe(MEDIA_PATH);

    const afterArchive = readZip(result.bytes);
    // 幻灯片 XML 与该页 _rels **逐字节不变** ⇒ 关系拓扑没动。
    expect(sameBytes(bytesAt(afterArchive, SLIDE1), bytesAt(beforeArchive, SLIDE1))).toBe(true);
    const relsPath = 'ppt/slides/_rels/slide1.xml.rels';
    expect(sameBytes(bytesAt(afterArchive, relsPath), bytesAt(beforeArchive, relsPath))).toBe(true);
    // 媒体字节换成了新源。
    expect(sameBytes(bytesAt(afterArchive, MEDIA_PATH), PNG_THIRD)).toBe(true);
    // 读回：仍闭合、仍是同一 rId、字节为新源。
    const record = readPictureMediaInPackage(result.bytes)[0];
    expect(record?.rel_id).toBe('rId2');
    expect(sameBytes(record!.bytes, PNG_THIRD)).toBe(true);
    expect(() => verifyMediaPairingInPackage(result.bytes)).not.toThrow();
  });

  it('替换不存在的图片 ⇒ unknown_shape（不静默）', () => {
    const { presentation, catalog } = pictureDeck();
    const bytes = buildMediaDeck(presentation, catalog).bytes;
    try {
      replacePictureBytesInPackage(bytes, { slide_part: SLIDE1, shape_id: 4242 }, PNG_NEW);
      throw new Error('应当报错：目标图片不存在');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationMediaError);
      expect((error as PresentationMediaError).reason).toBe('unknown_shape');
    }
  });
});

describe('P-I18 裁剪 a:srcRect：往返成模型字段、与整图区分、字节不动', () => {
  it('setPictureCrop → 渲染 → 重开：形状报同样的 srcRect，底层图片字节不变', () => {
    const { presentation, catalog, shape_id } = pictureDeck();
    const crop = { l: 111, t: 222, r: 0, b: 0 };
    const cropped = setPictureCrop(presentation, { slide_id: 1, shape_id }, crop);
    const bytes = buildMediaDeck(cropped, catalog).bytes;

    // 独立读原始幻灯片 XML：a:srcRect 的四条属性确实写出来了。
    expect(rawSrcRect(slideXmlOf(bytes))).toBe('<a:srcRect l="111" t="222" r="0" b="0"/>');

    // 消费者重开（roundtrip 导入层）：crop 作为模型字段原样读回。
    const imported = importPresentation(bytes);
    const shape = imported.presentation.slides[0]?.shapes.find((s: Shape) => s.shape_id === shape_id);
    if (shape?.kind !== 'picture') throw new Error('重开后应当是图片');
    expect(shape.crop).toEqual(crop);
    expect(shape.media_path).toBe(MEDIA_PATH);

    // 底层图片字节一个字节没动：仍等于最初的源字节。
    const record = readPictureMediaInPackage(bytes)[0];
    expect(sameBytes(record!.bytes, PNG_SRC)).toBe(true);
    expect(record?.crop).toEqual(crop);
  });

  it('裁剪与整图**明确区分**：未裁剪 crop=null，裁剪 crop 非 null 且两者不等', () => {
    const { presentation, catalog, shape_id } = pictureDeck();
    const fullBytes = buildMediaDeck(presentation, catalog).bytes;
    const croppedBytes = buildMediaDeck(
      setPictureCrop(presentation, { slide_id: 1, shape_id }, { l: 20000, t: 0, r: 20000, b: 0 }),
      catalog,
    ).bytes;

    const fullRecord = readPictureMediaInPackage(fullBytes)[0];
    const croppedRecord = readPictureMediaInPackage(croppedBytes)[0];
    // 整图没有 srcRect；裁剪有。
    expect(rawSrcRect(slideXmlOf(fullBytes))).toBeNull();
    expect(fullRecord?.crop).toBeNull();
    expect(croppedRecord?.crop).toEqual({ l: 20000, t: 0, r: 20000, b: 0 });
    expect(croppedRecord?.crop).not.toEqual(fullRecord?.crop ?? null);

    // 两者底层字节都还是同一份源（裁剪不改字节）。
    expect(sameBytes(fullRecord!.bytes, PNG_SRC)).toBe(true);
    expect(sameBytes(croppedRecord!.bytes, PNG_SRC)).toBe(true);

    // 重开后：整图 null、裁剪非 null。
    const fullImported = importPresentation(fullBytes).presentation.slides[0]?.shapes[0];
    const croppedImported = importPresentation(croppedBytes).presentation.slides[0]?.shapes[0];
    if (fullImported?.kind !== 'picture' || croppedImported?.kind !== 'picture') throw new Error('应当是图片');
    expect(fullImported.crop).toBeNull();
    expect(croppedImported.crop).toEqual({ l: 20000, t: 0, r: 20000, b: 0 });
  });

  it('clearPictureCrop → 渲染 → 重开：srcRect 消失，crop 回到 null', () => {
    const { presentation, catalog, shape_id } = pictureDeck();
    const cropped = setPictureCrop(presentation, { slide_id: 1, shape_id }, { l: 9000, t: 8000, r: 0, b: 0 });
    const cleared = clearPictureCrop(cropped, { slide_id: 1, shape_id });
    const bytes = buildMediaDeck(cleared, catalog).bytes;

    expect(rawSrcRect(slideXmlOf(bytes))).toBeNull();
    const imported = importPresentation(bytes);
    const shape = imported.presentation.slides[0]?.shapes.find((s: Shape) => s.shape_id === shape_id);
    if (shape?.kind !== 'picture') throw new Error('重开后应当是图片');
    expect(shape.crop).toBeNull();
    // 清除裁剪后图片字节依旧是源（清除只动 srcRect，不动媒体部件）。
    expect(sameBytes(readPictureMediaInPackage(bytes)[0]!.bytes, PNG_SRC)).toBe(true);
  });
});

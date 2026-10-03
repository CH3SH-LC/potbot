/**
 * P05 · PPTX **音视频整包装配与读回校验** 定向验收（PPT-12，兼 PPT-06 混排）。
 *
 * ## 判据独立于实现
 *
 * 本文件**不复用** `av-package.ts` 的解析器与校验器来"自证"：它用 `readZip` 打开产物后
 * 用**自己的正则**解析 `_rels`、用**自己的字节比较**核对媒体部件、用**自己的 IHDR 检查**
 * 证明占位 PNG 是真 PNG。末段才调用被侧模块的 `verifyAvMediaInPackage` 交叉一次。
 *
 * ## 反向对照（每条都能咬）
 *
 * - 声明嵌入却没字节 ⇒ 必须具名报错（不假称已嵌入）；
 * - 外链指向包内路径 ⇒ 必须具名报错（写不出合法外链）；
 * - 封面无字节 ⇒ 必须具名报错（不写幽灵封面关系）；
 * - 产物里**删掉**媒体部件后读回 ⇒ 必须报悬挂（判据真的在看字节）；
 * - 占位部件**不得**泄漏进最终包。
 */

import { describe, expect, it } from 'vitest';

import { readZip, writeZip } from '../../../../src/artifacts/ooxml/index.js';
import {
  AvMediaError,
  avMediaBoard,
  emptyAvMediaBoard,
  insertAvMedia,
  REL_AUDIO,
  REL_IMAGE,
  REL_P14_MEDIA,
  REL_VIDEO,
  type AvMediaItem,
} from '../../../../src/presentations/av-media.js';
import { addMediaPart, insertPicture, mediaCatalog, setPictureCrop } from '../../../../src/presentations/media.js';
import { transform } from '../../../../src/presentations/model.js';
import {
  AV_PLACEHOLDER_PREFIX,
  AvPackageError,
  avPackageDeck,
  assembleAvMediaPackage,
  inspectAvMediaPackage,
  TRANSPARENT_PIXEL_PNG,
  verifyAvMediaInPackage,
} from '../../../../src/presentations/media-parts/index.js';

// ---------------------------------------------------------------------------
// 字节素材（真实长度，非空）
// ---------------------------------------------------------------------------

const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]); // ftyp/isom 头
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00]); // ID3 头
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const BOX = transform(100000, 200000, 3000000, 2000000);

// ---------------------------------------------------------------------------
// 独立工具（不用被测模块）
// ---------------------------------------------------------------------------

interface RawRel {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly mode: string | null;
}

/** 独立正则解析 `_rels`。 */
function parseRels(xml: string): readonly RawRel[] {
  const out: RawRel[] = [];
  const el = /<Relationship\s+([^>]*?)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = el.exec(xml)) !== null) {
    const attrs = m[1] ?? '';
    const pick = (name: string): string | undefined => {
      const found = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
      return found === null ? undefined : found[1];
    };
    out.push({
      id: pick('Id') ?? '',
      type: pick('Type') ?? '',
      target: pick('Target') ?? '',
      mode: pick('TargetMode') ?? null,
    });
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function entryText(bytes: Uint8Array, path: string): string {
  const archive = readZip(bytes);
  const entry = archive.by_path.get(path);
  if (entry === undefined) throw new Error(`缺少部件 ${path}`);
  return Buffer.from(entry.data).toString('utf8');
}

function entryData(bytes: Uint8Array, path: string): Uint8Array {
  const archive = readZip(bytes);
  const entry = archive.by_path.get(path);
  if (entry === undefined) throw new Error(`缺少部件 ${path}`);
  return entry.data;
}

/** 把一个"嵌入视频"插到指定页（含封面 poster）。 */
function insertEmbeddedVideo(
  deck: ReturnType<typeof avPackageDeck>,
  slideId: number,
  catalog: ReturnType<typeof mediaCatalog>,
  options?: { cover?: boolean; path?: string; bytes?: Uint8Array },
): ReturnType<typeof insertAvMedia> {
  const path = options?.path ?? 'ppt/media/clip1.mp4';
  return insertAvMedia(deck, emptyAvMediaBoard(), catalog, slideId, {
    transform: BOX,
    media_path: path,
    bytes: options?.bytes ?? MP4,
    cover:
      options?.cover === true
        ? { cover_path: 'ppt/media/poster1.png', cover_bytes: PNG }
        : null,
  });
}

// ---------------------------------------------------------------------------
// §A 嵌入音视频：真实字节 + 真实关系 + 放映时间
// ---------------------------------------------------------------------------

describe('P05 §A 嵌入音视频整包装配', () => {
  it('视频（带封面）+ 音频：媒体部件字节逐字节为真、关系类型/目标正确、含 p:timing', () => {
    const deck = avPackageDeck(2);
    const withVideo = insertEmbeddedVideo(deck, 1, mediaCatalog(), { cover: true });
    const withAudio = insertAvMedia(
      withVideo.presentation,
      withVideo.board,
      withVideo.catalog,
      2,
      { shape_id: 3, transform: BOX, media_path: 'ppt/media/song1.mp3', bytes: MP3 },
    );

    const result = assembleAvMediaPackage(withAudio.presentation, withAudio.board, withAudio.catalog);

    // 媒体部件确实在包里，且字节**逐字节相同**。
    expect(bytesEqual(entryData(result.bytes, 'ppt/media/clip1.mp4'), MP4)).toBe(true);
    expect(bytesEqual(entryData(result.bytes, 'ppt/media/song1.mp3'), MP3)).toBe(true);
    expect(bytesEqual(entryData(result.bytes, 'ppt/media/poster1.png'), PNG)).toBe(true);

    // slide1 的 XML：videoFile / p14:media / 封面 blip / timing 都在。
    const slide1 = entryText(result.bytes, 'ppt/slides/slide1.xml');
    expect(slide1).toContain('<a:videoFile');
    expect(slide1).toContain('<p14:media');
    expect(slide1).toContain('<p:timing');
    expect(slide1).not.toContain('<a:audioFile');

    // slide1 的 _rels：video 关系 + p14:media 关系 + 封面 image 关系，目标正确。
    const rels1 = parseRels(entryText(result.bytes, 'ppt/slides/_rels/slide1.xml.rels'));
    const videoRel = rels1.find((r) => r.type === REL_VIDEO);
    expect(videoRel).toBeDefined();
    expect(videoRel?.target).toBe('../media/clip1.mp4');
    expect(videoRel?.mode).toBeNull();
    const mediaRel = rels1.find((r) => r.type === REL_P14_MEDIA);
    expect(mediaRel).toBeDefined();
    expect(mediaRel?.target).toBe('../media/clip1.mp4');
    expect(mediaRel?.id).not.toBe(videoRel?.id); // 分关系口径：两条不同 id
    expect(rels1.some((r) => r.type === REL_IMAGE && r.target === '../media/poster1.png')).toBe(true);

    // slide2 音频：audioFile，不是 videoFile。
    const slide2 = entryText(result.bytes, 'ppt/slides/slide2.xml');
    expect(slide2).toContain('<a:audioFile');
    expect(slide2).not.toContain('<a:videoFile');
    const rels2 = parseRels(entryText(result.bytes, 'ppt/slides/_rels/slide2.xml.rels'));
    expect(rels2.some((r) => r.type === REL_AUDIO && r.target === '../media/song1.mp3')).toBe(true);
    expect(rels2.some((r) => r.type === REL_P14_MEDIA && r.target === '../media/song1.mp3')).toBe(true);

    // 内容类型默认项覆盖 mp4 / mp3 / png。
    const contentTypes = entryText(result.bytes, '[Content_Types].xml');
    expect(contentTypes).toContain('Extension="mp4"');
    expect(contentTypes).toContain('Extension="mp3"');
    expect(contentTypes).toContain('Extension="png"');

    // 占位部件不泄漏。
    for (const entry of readZip(result.bytes).entries) {
      expect(entry.path.startsWith(AV_PLACEHOLDER_PREFIX)).toBe(false);
    }

    // 逐项摘要反映事实。
    const byId = new Map(result.items.map((item) => [item.media_id, item]));
    expect([...byId.values()].every((item) => item.embedded && item.link_status === 'embedded')).toBe(true);
    expect(result.media_part_count).toBe(3);

    // 读回校验通过。
    const report = verifyAvMediaInPackage(result.bytes);
    expect(report.problems).toEqual([]);
    expect([...report.media_part_paths].sort()).toEqual([
      'ppt/media/clip1.mp4',
      'ppt/media/poster1.png',
      'ppt/media/song1.mp3',
    ]);
  });

  it('嵌入视频（无封面）：不写 blipFill，但 videoFile/p14:media/timing 仍在', () => {
    const deck = avPackageDeck(1);
    const inserted = insertEmbeddedVideo(deck, 1, mediaCatalog(), { cover: false });
    const result = assembleAvMediaPackage(inserted.presentation, inserted.board, inserted.catalog);

    const slide1 = entryText(result.bytes, 'ppt/slides/slide1.xml');
    expect(slide1).toContain('<a:videoFile');
    expect(slide1).toContain('<p14:media');
    expect(slide1).toContain('<p:timing');
    // 无封面 ⇒ 该 media pic 里没有 blipFill 引用的封面关系（仍可能有其他图片）。
    const rels1 = parseRels(entryText(result.bytes, 'ppt/slides/_rels/slide1.xml.rels'));
    expect(rels1.some((r) => r.type === REL_IMAGE)).toBe(false);
    expect(bytesEqual(entryData(result.bytes, 'ppt/media/clip1.mp4'), MP4)).toBe(true);
  });

  it('外链视频（无字节）：关系是 External，包内**没有**该媒体部件，状态为 linked', () => {
    const deck = avPackageDeck(1);
    const inserted = insertAvMedia(deck, emptyAvMediaBoard(), mediaCatalog(), 1, {
      transform: BOX,
      media_path: 'https://cdn.example.com/demo.mp4',
      external: true,
    });
    const result = assembleAvMediaPackage(inserted.presentation, inserted.board, inserted.catalog);

    const rels1 = parseRels(entryText(result.bytes, 'ppt/slides/_rels/slide1.xml.rels'));
    const videoRel = rels1.find((r) => r.type === REL_VIDEO);
    expect(videoRel?.target).toBe('https://cdn.example.com/demo.mp4');
    expect(videoRel?.mode).toBe('External');

    const archive = readZip(result.bytes);
    for (const entry of archive.entries) {
      expect(entry.path.endsWith('.mp4')).toBe(false); // 外链不落字节
    }
    const item = result.items[0];
    if (item === undefined) throw new Error('应当有一项摘要');
    expect(item.declared).toBe('linked');
    expect(item.embedded).toBe(false);
    expect(item.link_status).toBe('linked');
    expect(item.media_part_written).toBe(false);
    expect(verifyAvMediaInPackage(result.bytes).problems).toEqual([]);
  });

  it('一页两个媒体：timing 合并，两个 cTn@id 不冲突，两条视频关系都在', () => {
    const deck = avPackageDeck(1);
    const first = insertEmbeddedVideo(deck, 1, mediaCatalog(), { path: 'ppt/media/a.mp4', bytes: MP4 });
    const second = insertAvMedia(first.presentation, first.board, first.catalog, 1, {
      transform: BOX,
      media_path: 'ppt/media/b.mp4',
      bytes: new Uint8Array([...MP4, 0xff]),
    });
    const result = assembleAvMediaPackage(second.presentation, second.board, second.catalog);

    const slide1 = entryText(result.bytes, 'ppt/slides/slide1.xml');
    // 两个 videoFile、单个 p:timing。
    expect((slide1.match(/<a:videoFile/g) ?? []).length).toBe(2);
    expect((slide1.match(/<p:timing>/g) ?? []).length).toBe(1);
    // 合并后 cTn id 不复用：第二个对象的 id 被偏移到 6…10。
    expect(slide1).toContain('id="6"');
    expect(slide1).toContain('id="10"');
    const rels1 = parseRels(entryText(result.bytes, 'ppt/slides/_rels/slide1.xml.rels'));
    expect(rels1.filter((r) => r.type === REL_VIDEO).length).toBe(2);
    expect(verifyAvMediaInPackage(result.bytes).problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §B 反向对照：不成立的输入必须具名失败
// ---------------------------------------------------------------------------

describe('P05 §B 反向对照（每条都被具名拒绝）', () => {
  it('反向对照：声明嵌入但目录里没有该字节 ⇒ 具名报错（不假称已嵌入）', () => {
    const deck = avPackageDeck(1);
    const inserted = insertEmbeddedVideo(deck, 1, mediaCatalog());
    // 去掉媒体部件的字节，保留"声明嵌入"的旁表项。
    const emptyCatalog = mediaCatalog(inserted.catalog.parts.filter((part) => !part.path.endsWith('.mp4')));
    expect(() =>
      assembleAvMediaPackage(inserted.presentation, inserted.board, emptyCatalog),
    ).toThrow(AvMediaError);
  });

  it('反向对照：外链目标为空 ⇒ 具名报错', () => {
    const deck = avPackageDeck(1);
    const inserted = insertEmbeddedVideo(deck, 1, mediaCatalog());
    const brokenItem: AvMediaItem = {
      ...inserted.item,
      declared: 'linked',
      media_path: '',
    };
    const board = avMediaBoard([brokenItem]);
    expect(() =>
      assembleAvMediaPackage(inserted.presentation, board, inserted.catalog),
    ).toThrow(AvMediaError);
  });

  it('反向对照：声明外链却指向包内路径 ⇒ linked_target_must_be_external', () => {
    const deck = avPackageDeck(1);
    // 用 av-media 造一个"声明外链、目标却是包内路径"的项（旁表手工构造）。
    const inserted = insertEmbeddedVideo(deck, 1, mediaCatalog());
    const linkedPkg: AvMediaItem = {
      ...inserted.item,
      declared: 'linked',
      media_path: 'ppt/media/clip1.mp4',
    };
    // 目录里保留该部件，避免先被"损坏链接"判据截胡；本用例只咬"外链必须是外部地址"。
    expect(() =>
      assembleAvMediaPackage(inserted.presentation, avMediaBoard([linkedPkg]), inserted.catalog),
    ).toThrow(AvPackageError);
    try {
      assembleAvMediaPackage(inserted.presentation, avMediaBoard([linkedPkg]), inserted.catalog);
    } catch (error) {
      expect((error as AvPackageError).reason).toBe('linked_target_must_be_external');
    }
  });

  it('反向对照：封面没有字节 ⇒ missing_cover_part', () => {
    const deck = avPackageDeck(1);
    const inserted = insertAvMedia(deck, emptyAvMediaBoard(), mediaCatalog(), 1, {
      transform: BOX,
      media_path: 'ppt/media/v.mp4',
      bytes: MP4,
      // 声明封面路径，但**不给**封面字节。
      cover: { cover_path: 'ppt/media/poster1.png' },
    });
    try {
      assembleAvMediaPackage(inserted.presentation, inserted.board, inserted.catalog);
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AvPackageError).reason).toBe('missing_cover_part');
    }
  });

  it('反向对照：旁表项在文稿里没有对应对象 ⇒ unplaced_board_item', () => {
    const deck = avPackageDeck(1);
    const ghost: AvMediaItem = {
      media_id: 'ghost',
      slide_id: 1,
      shape_id: 999,
      media_path: 'ppt/media/ghost.mp4',
      kind: 'video',
      declared: 'embedded',
      cover: null,
      playback: {
        autoplay: false,
        loop: false,
        muted: false,
        volume: 100000,
        show_controls: true,
        trim_start_ms: 0,
        trim_end_ms: null,
      },
      alt_text: '',
    };
    // 目录里放上它的字节，否则会先被"假称嵌入"判据挡下——本用例只咬"没有对应对象"。
    const catalog = addMediaPart(mediaCatalog(), 'ppt/media/ghost.mp4', MP4);
    try {
      assembleAvMediaPackage(deck, avMediaBoard([ghost]), catalog);
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AvPackageError).reason).toBe('unplaced_board_item');
    }
  });
});

// ---------------------------------------------------------------------------
// §C 读回校验真的在看字节（破坏产物 ⇒ 必须报出）
// ---------------------------------------------------------------------------

describe('P05 §C 读回校验对真实字节敏感', () => {
  function goodDeck(): Uint8Array {
    const deck = avPackageDeck(1);
    const inserted = insertEmbeddedVideo(deck, 1, mediaCatalog(), { cover: true });
    return assembleAvMediaPackage(inserted.presentation, inserted.board, inserted.catalog).bytes;
  }

  it('产物校验通过（非抛出式检视问题列表为空）', () => {
    const report = inspectAvMediaPackage(goodDeck());
    expect(report.problems).toEqual([]);
    expect(report.media_part_paths).toContain('ppt/media/clip1.mp4');
    expect(report.timing_slides).toContain('ppt/slides/slide1.xml');
  });

  it('反向对照：从产物里**删掉**视频部件后读回 ⇒ 报悬挂媒体引用', () => {
    const archive = readZip(goodDeck());
    const damaged = writeZip(
      archive.entries
        .filter((entry) => entry.path !== 'ppt/media/clip1.mp4')
        .map((entry) => ({ path: entry.path, data: entry.data })),
    );
    try {
      verifyAvMediaInPackage(damaged);
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(AvPackageError);
      expect((error as AvPackageError).reason).toBe('dangling_media_reference');
    }
  });

  it('反向对照：从产物里**删掉整页 _rels** 后读回 ⇒ 报未解析的媒体关系', () => {
    const archive = readZip(goodDeck());
    const damaged = writeZip(
      archive.entries
        .filter((entry) => entry.path !== 'ppt/slides/_rels/slide1.xml.rels')
        .map((entry) => ({ path: entry.path, data: entry.data })),
    );
    try {
      verifyAvMediaInPackage(damaged);
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AvPackageError).reason).toBe('unresolved_media_relationship');
    }
  });
});

// ---------------------------------------------------------------------------
// §D 占位 PNG 是真 PNG（合成素材本身可解码性）
// ---------------------------------------------------------------------------

describe('P05 §D 占位 PNG 的品牌（真 PNG，不是任意字节）', () => {
  it('签名正确，IHDR 声明 1×1、8bit、RGBA', () => {
    const png = TRANSPARENT_PIXEL_PNG;
    const b = (index: number): number => png[index] ?? 0;
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // 第一个块是 IHDR（长度 13）。
    const ihdrLength = (b(8) << 24) | (b(9) << 16) | (b(10) << 8) | b(11);
    expect(ihdrLength).toBe(13);
    const type = String.fromCharCode(b(12), b(13), b(14), b(15));
    expect(type).toBe('IHDR');
    const width = (b(16) << 24) | (b(17) << 16) | (b(18) << 8) | b(19);
    const height = (b(20) << 24) | (b(21) << 16) | (b(22) << 8) | b(23);
    expect(width).toBe(1);
    expect(height).toBe(1);
    expect(b(24)).toBe(8); // bit depth
    expect(b(25)).toBe(6); // color type 6 = RGBA
    // 末尾 12 字节是 IEND 块。
    expect(
      String.fromCharCode(b(png.length - 8), b(png.length - 7), b(png.length - 6), b(png.length - 5)),
    ).toBe('IEND');
  });
});

// ---------------------------------------------------------------------------
// §E 与 PPT-06 图片（裁剪 + 替换）同包混排
// ---------------------------------------------------------------------------

describe('P05 §E PPT-06 图片与 PPT-12 音视频同包', () => {
  it('图片（带裁剪）+ 嵌入视频：两者都在同一份真实包里且各自关系正确', () => {
    let deck = avPackageDeck(1);
    let catalog = addMediaPart(mediaCatalog(), 'ppt/media/photo1.png', PNG);
    const pic = insertPicture(deck, 1, { transform: BOX, media_path: 'ppt/media/photo1.png' }, catalog);
    deck = setPictureCrop(pic.presentation, { slide_id: 1, shape_id: pic.shape_id }, { l: 1000, t: 0, r: 0, b: 0 });
    const withVideo = insertEmbeddedVideo(deck, 1, catalog, { path: 'ppt/media/clip1.mp4' });

    const result = assembleAvMediaPackage(withVideo.presentation, withVideo.board, withVideo.catalog);

    const slide1 = entryText(result.bytes, 'ppt/slides/slide1.xml');
    expect(slide1).toContain('<a:srcRect'); // 裁剪保留
    expect(slide1).toContain('<a:videoFile'); // 音视频在
    expect(slide1).toContain('<p:timing');

    const rels1 = parseRels(entryText(result.bytes, 'ppt/slides/_rels/slide1.xml.rels'));
    expect(rels1.some((r) => r.type === REL_IMAGE && r.target === '../media/photo1.png')).toBe(true);
    expect(rels1.some((r) => r.type === REL_VIDEO)).toBe(true);

    expect(bytesEqual(entryData(result.bytes, 'ppt/media/photo1.png'), PNG)).toBe(true);
    expect(bytesEqual(entryData(result.bytes, 'ppt/media/clip1.mp4'), MP4)).toBe(true);
    expect(verifyAvMediaInPackage(result.bytes).problems).toEqual([]);
  });
});

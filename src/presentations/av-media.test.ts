/**
 * 演示域**音视频（受控引用）**用例（design-06 P9；PPT-12）。
 *
 * 重点：
 * - **不假称已嵌入**：`embedded` 是读回媒体目录真字节的**事实**，只有"声明嵌入 + 真有个部件"
 *   才为 `true`；只有链接时**恒为 `false`**（含反向对照：声明嵌入但无部件 ⇒ 仍然 false + 抛错）；
 * - 类型按**真实扩展名**判定，未知扩展名 / 图片都**具名报错不猜**；
 * - **媒体权限**与**链接失效**都有明确结果（非抛出的判定 + 具名抛错）；
 * - 产物是**真实 XML**（解析回读断言 `a:videoFile` / `p14:media` / `a:blip`），
 *   `embedded` 决定 `p14:media` 写 `r:embed` 还是 `r:link`——这条正是"不假称嵌入"在产物上的落点。
 *
 * **未验证**：真机 PowerPoint 播放未验证（需消费端）；本套件只做片段级读回。
 */

import { describe, expect, it } from 'vitest';

import { addMediaPart, mediaCatalog, type MediaCatalog } from './media.js';
import { transform, type Presentation } from './model.js';
import { addSlide } from './operations.js';
import { emptyPresentation, PresentationRenderError, renderPresentation } from './render.js';
import { attributeOf, childElements, firstElement, parseXmlDocument } from './xml-parse.js';
import {
  ACTION_MEDIA,
  assertAvMediaConsistent,
  auditAvMedia,
  avContentTypeFor,
  AvMediaError,
  avMediaBoard,
  avMediaItemForShape,
  avMediaItemOf,
  avMediaKindFor,
  avMediaRelationships,
  avMediaShape,
  avPlayback,
  checkAvMediaPermission,
  DEFAULT_AV_MEDIA_PERMISSIONS,
  deleteAvMedia,
  emptyAvMediaBoard,
  insertAvMedia,
  isAvMediaPath,
  NO_AV_MEDIA_PERMISSIONS,
  pruneUnreferencedAvParts,
  REL_AUDIO,
  REL_IMAGE,
  REL_P14_MEDIA,
  REL_VIDEO,
  replaceAvMedia,
  renderAvMediaTimingXml,
  renderAvMediaXml,
  resolveAvMedia,
  setAvCover,
  setAvPlayback,
  wrapAvMediaInSlideDocument,
  type AvMediaItem,
} from './av-media.js';

const BOX = transform(100000, 200000, 3000000, 2000000);
const MP4 = new Uint8Array([1, 2, 3, 4, 5]);
const MP3 = new Uint8Array([9, 8, 7]);
const PNG = new Uint8Array([137, 80, 78, 71]);

function deck(count: number): Presentation {
  let presentation = emptyPresentation('p1', '测试文稿');
  for (let i = 0; i < count; i += 1) {
    presentation = addSlide(presentation).presentation;
  }
  return presentation;
}

/** 造一个"声明嵌入"的项（不代表包里真有部件——事实由 resolve 读回判定）。 */
function embeddedItem(overrides: Partial<AvMediaItem> = {}): AvMediaItem {
  return Object.freeze({
    media_id: 'm1',
    slide_id: 1,
    shape_id: 50,
    media_path: 'ppt/media/clip1.mp4',
    kind: 'video',
    declared: 'embedded',
    cover: null,
    playback: avPlayback(),
    alt_text: '',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------

describe('PPT-12：类型按真实扩展名判定，未知扩展名具名报错不猜', () => {
  it('mp4 / m4v 是 video，mp3 / m4a / wav 是 audio', () => {
    expect(avMediaKindFor('ppt/media/clip.mp4')).toBe('video');
    expect(avMediaKindFor('ppt/media/clip.M4V')).toBe('video');
    expect(avMediaKindFor('ppt/media/song.mp3')).toBe('audio');
    expect(avMediaKindFor('ppt/media/song.m4a')).toBe('audio');
    expect(avMediaKindFor('ppt/media/song.wav')).toBe('audio');
    expect(avContentTypeFor('ppt/media/clip.webm')).toBe('video/webm');
  });

  it('未知扩展名 ⇒ 具名 unknown_media_type（不猜、不嗅探）', () => {
    try {
      avMediaKindFor('ppt/media/clip.xyz');
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(AvMediaError);
      expect((error as AvMediaError).reason).toBe('unknown_media_type');
    }
    // 连"没有扩展名"也一样报错，不默认成 video。
    expect(() => avMediaKindFor('ppt/media/clip')).toThrowError(AvMediaError);
  });

  it('已知但是图片 ⇒ 具名 not_av_media（图片走 media.ts）', () => {
    try {
      avMediaKindFor('ppt/media/photo.png');
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AvMediaError).reason).toBe('not_av_media');
    }
  });

  it('反向对照：isAvMediaPath 对图片与未知扩展名都返回 false，对 mp4 返回 true', () => {
    expect(isAvMediaPath('ppt/media/clip.mp4')).toBe(true);
    expect(isAvMediaPath('ppt/media/photo.png')).toBe(false);
    expect(isAvMediaPath('ppt/media/clip.xyz')).toBe(false);
    // 反向：video 的扩展名**不得**被判成 audio。
    expect(avMediaKindFor('ppt/media/clip.mp4')).not.toBe('audio');
  });
});

describe('PPT-12：embedded 是读回的事实，不是声明（不假称已嵌入）', () => {
  const empty = mediaCatalog();

  it('只有链接、没有媒体部件 ⇒ embedded 恒为 false，状态是 linked（且可达性未验证）', () => {
    const resolution = resolveAvMedia(
      embeddedItem({ declared: 'linked', media_path: 'https://cdn.example.com/a.mp4' }),
      empty,
    );
    expect(resolution.embedded).toBe(false);
    expect(resolution.link_status).toBe('linked');
    // 无消费端 / 无网络：可达性**未验证**，不得假称已验证。
    expect(resolution.link_liveness_verified).toBe(false);
    expect(resolution.problem).toBeNull();
  });

  it('真的有媒体部件 + 声明嵌入 ⇒ embedded 为 true，状态是 embedded', () => {
    const catalog = addMediaPart(mediaCatalog(), 'ppt/media/clip1.mp4', MP4);
    const resolution = resolveAvMedia(embeddedItem(), catalog);
    expect(resolution.embedded).toBe(true);
    expect(resolution.link_status).toBe('embedded');
    expect(resolution.problem).toBeNull();
  });

  it('反向对照（核心）：声明嵌入但包内**没有**部件 ⇒ embedded 仍是 false，且具名报错', () => {
    const resolution = resolveAvMedia(embeddedItem(), empty);
    // 声明了不算数——事实是 false。
    expect(resolution.embedded).toBe(false);
    expect(resolution.link_status).toBe('broken');
    expect(resolution.problem?.reason).toBe('missing_media_part');

    const presentation = deck(1);
    const board = avMediaBoard([embeddedItem()]);
    const audit = auditAvMedia(presentation, board, empty);
    expect(audit.false_embed_claims).toHaveLength(1);
    try {
      assertAvMediaConsistent(presentation, board, empty);
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(AvMediaError);
      expect((error as AvMediaError).reason).toBe('missing_media_part');
    }
  });

  it('反向对照二：声明外链时，即使库里恰有同路径部件，embedded 仍恒为 false', () => {
    const catalog = addMediaPart(mediaCatalog(), 'ppt/media/clip1.mp4', MP4);
    const resolution = resolveAvMedia(embeddedItem({ declared: 'linked' }), catalog);
    // 事实由"声明 + 部件"共同决定；声明外链 ⇒ 永远不是 embedded。
    expect(resolution.embedded).toBe(false);
    expect(resolution.link_status).toBe('linked');
  });

  it('声明外链却指向包内不存在路径 ⇒ broken（有引用没部件）', () => {
    const resolution = resolveAvMedia(embeddedItem({ declared: 'linked' }), empty);
    expect(resolution.embedded).toBe(false);
    expect(resolution.link_status).toBe('broken');
    expect(resolution.problem?.reason).toBe('missing_media_part');
  });

  it('外链目标为空 ⇒ broken / external_target_required', () => {
    const resolution = resolveAvMedia(embeddedItem({ declared: 'linked', media_path: '   ' }), empty);
    expect(resolution.link_status).toBe('broken');
    expect(resolution.problem?.reason).toBe('external_target_required');
  });
});

describe('PPT-12：媒体权限有明确结果（不静默降级）', () => {
  it('禁止嵌入时：判定被拒 + 插入具名抛错', () => {
    const decision = checkAvMediaPermission({ bytes: MP4 }, NO_AV_MEDIA_PERMISSIONS);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('embed_not_permitted');

    try {
      insertAvMedia(deck(1), emptyAvMediaBoard(), mediaCatalog(), 1, {
        transform: BOX,
        media_path: 'ppt/media/clip1.mp4',
        bytes: MP4,
      }, NO_AV_MEDIA_PERMISSIONS);
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(AvMediaError);
      expect((error as AvMediaError).reason).toBe('embed_not_permitted');
    }
  });

  it('禁止外链时：无字节的插入被拒（link_not_permitted）', () => {
    const decision = checkAvMediaPermission({}, NO_AV_MEDIA_PERMISSIONS);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('link_not_permitted');
  });

  it('禁止自动播放时：autoplay 请求被拒，其余设置不受影响', () => {
    const decision = checkAvMediaPermission(
      { bytes: MP4, playback: { autoplay: true } },
      { allow_embed: true, allow_link: true, allow_autoplay: false },
    );
    expect(decision.reason).toBe('autoplay_not_permitted');
    expect(
      checkAvMediaPermission({ bytes: MP4 }, { allow_embed: true, allow_link: true, allow_autoplay: false }).allowed,
    ).toBe(true);
  });

  it('既给字节又声明外链 ⇒ embed_link_conflict（不猜按哪种处理）', () => {
    const decision = checkAvMediaPermission({ bytes: MP4, external: true }, DEFAULT_AV_MEDIA_PERMISSIONS);
    expect(decision.reason).toBe('embed_link_conflict');
  });

  it('反向对照：默认权限下同一请求被允许（reason 为 null）', () => {
    const decision = checkAvMediaPermission({ bytes: MP4, playback: { autoplay: true } }, DEFAULT_AV_MEDIA_PERMISSIONS);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeNull();
  });
});

describe('PPT-12：插入 / 替换 / 删除', () => {
  it('插入嵌入音视频：模型 + 旁表 + 目录同步更新，且事实嵌入成立', () => {
    const result = insertAvMedia(deck(2), emptyAvMediaBoard(), mediaCatalog(), 1, {
      shape_id: 7,
      transform: BOX,
      media_path: 'ppt/media/clip1.mp4',
      bytes: MP4,
      alt_text: '演示片',
    });
    const shape = result.presentation.slides[0]!.shapes.at(-1)!;
    expect(shape.kind).toBe('media');
    expect(result.catalog.parts.map((part) => part.path)).toEqual(['ppt/media/clip1.mp4']);
    expect(result.item.declared).toBe('embedded');
    const resolution = resolveAvMedia(result.item, result.catalog);
    expect(resolution.embedded).toBe(true);
    expect(resolution.kind).toBe('video');
    expect(() => assertAvMediaConsistent(result.presentation, result.board, result.catalog)).not.toThrow();
  });

  it('插入外链音视频：目录不动，事实是"链接"且未验证可达性', () => {
    const result = insertAvMedia(deck(1), emptyAvMediaBoard(), mediaCatalog(), 1, {
      transform: BOX,
      media_path: 'https://cdn.example.com/song.mp3',
      external: true,
    });
    expect(result.catalog.parts).toHaveLength(0);
    const resolution = resolveAvMedia(result.item, result.catalog);
    expect(resolution.kind).toBe('audio');
    expect(resolution.embedded).toBe(false);
    expect(resolution.link_status).toBe('linked');
    expect(resolution.link_liveness_verified).toBe(false);
  });

  it('反向对照：零字节 / 未知扩展名 / 图片路径都具名拒绝', () => {
    const base = { transform: BOX, slide_id: 1 } as const;
    const cases: readonly { readonly spec: Parameters<typeof insertAvMedia>[4]; readonly reason: string }[] = [
      { spec: { ...base, media_path: 'ppt/media/clip.mp4', bytes: new Uint8Array() }, reason: 'empty_media_bytes' },
      { spec: { ...base, media_path: 'ppt/media/clip.xyz', bytes: MP4 }, reason: 'unknown_media_type' },
      { spec: { ...base, media_path: 'ppt/media/photo.png', bytes: PNG }, reason: 'not_av_media' },
    ];
    for (const testCase of cases) {
      try {
        insertAvMedia(deck(1), emptyAvMediaBoard(), mediaCatalog(), 1, testCase.spec);
        throw new Error('应当抛错');
      } catch (error) {
        expect((error as AvMediaError).reason).toBe(testCase.reason);
      }
    }
  });

  it('替换：换路径与字节后，旧部件被收尾清掉，新事实仍是嵌入', () => {
    const inserted = insertAvMedia(deck(1), emptyAvMediaBoard(), mediaCatalog(), 1, {
      shape_id: 3,
      transform: BOX,
      media_path: 'ppt/media/clip1.mp4',
      bytes: MP4,
    });
    const replaced = replaceAvMedia(
      inserted.presentation,
      inserted.board,
      inserted.catalog,
      { slide_id: 1, shape_id: 3 },
      { media_path: 'ppt/media/clip2.mp4', bytes: new Uint8Array([7, 7, 7]) },
    );
    expect(replaced.catalog.parts.map((part) => part.path)).toEqual(['ppt/media/clip2.mp4']);
    const item = avMediaItemForShape(replaced.board, 1, 3)!;
    expect(item.media_path).toBe('ppt/media/clip2.mp4');
    expect(resolveAvMedia(item, replaced.catalog).embedded).toBe(true);
    const shape = replaced.presentation.slides[0]!.shapes.find((entry) => entry.shape_id === 3)!;
    expect(shape.kind === 'media' && shape.media_path).toBe('ppt/media/clip2.mp4');
  });

  it('反向对照：替换目标不是音视频 / 找不到对象 / 找不到登记项都具名报错', () => {
    const inserted = insertAvMedia(deck(1), emptyAvMediaBoard(), mediaCatalog(), 1, {
      shape_id: 3,
      transform: BOX,
      media_path: 'ppt/media/clip1.mp4',
      bytes: MP4,
    });
    // 先塞一个文本框进去当"不是音视频"的对象。
    const withTextBox: Presentation = {
      ...inserted.presentation,
      slides: inserted.presentation.slides.map((slide) =>
        slide.slide_id !== 1
          ? slide
          : {
              ...slide,
              shapes: [
                ...slide.shapes,
                {
                  kind: 'text_box' as const,
                  shape_id: 99,
                  name: 'Text 99',
                  transform: BOX,
                  text: { paragraphs: [] },
                },
              ],
            },
      ),
    };
    const expectReason = (fn: () => unknown, reason: string): void => {
      try {
        fn();
        throw new Error('应当抛错');
      } catch (error) {
        expect((error as AvMediaError).reason).toBe(reason);
      }
    };
    expectReason(
      () => replaceAvMedia(withTextBox, inserted.board, inserted.catalog, { slide_id: 1, shape_id: 99 }, { media_path: 'ppt/media/x.mp4', bytes: MP4 }),
      'not_a_media_shape',
    );
    expectReason(
      () => replaceAvMedia(withTextBox, inserted.board, inserted.catalog, { slide_id: 1, shape_id: 404 }, { media_path: 'ppt/media/x.mp4', bytes: MP4 }),
      'unknown_shape',
    );
    expectReason(
      () => replaceAvMedia(withTextBox, emptyAvMediaBoard(), mediaCatalog(), { slide_id: 1, shape_id: 3 }, { media_path: 'ppt/media/x.mp4', bytes: MP4 }),
      'unknown_media_id',
    );
  });

  it('删除：默认收尾清掉已无引用的音视频部件', () => {
    const inserted = insertAvMedia(deck(1), emptyAvMediaBoard(), mediaCatalog(), 1, {
      shape_id: 3,
      transform: BOX,
      media_path: 'ppt/media/clip1.mp4',
      bytes: MP4,
    });
    const removed = deleteAvMedia(inserted.presentation, inserted.board, inserted.catalog, {
      slide_id: 1,
      shape_id: 3,
    });
    expect(removed.board.items).toHaveLength(0);
    expect(removed.catalog.parts).toHaveLength(0);
    expect(removed.presentation.slides[0]!.shapes).toHaveLength(0);
    expect(avMediaItemForShape(removed.board, 1, 3)).toBeUndefined();
  });

  it('反向对照：删除时 prune=false 保留部件（此时它就是显式登记的孤儿），审计会点出来', () => {
    const inserted = insertAvMedia(deck(1), emptyAvMediaBoard(), mediaCatalog(), 1, {
      shape_id: 3,
      transform: BOX,
      media_path: 'ppt/media/clip1.mp4',
      bytes: MP4,
    });
    const removed = deleteAvMedia(
      inserted.presentation,
      inserted.board,
      inserted.catalog,
      { slide_id: 1, shape_id: 3 },
      { prune: false },
    );
    expect(removed.catalog.parts).toHaveLength(1);
    const audit = auditAvMedia(removed.presentation, removed.board, removed.catalog);
    expect(audit.orphan_media_paths).toEqual(['ppt/media/clip1.mp4']);
    // 同一次调用里断言仍是"不静默"的：显式要求保留孤儿就不把它当错误抛，但必须能被审计看见。
    expect(pruneUnreferencedAvParts(removed.board, removed.catalog).parts).toHaveLength(0);
  });

  it('反向对照：删除非音视频对象 / 未登记项都具名报错', () => {
    const inserted = insertAvMedia(deck(1), emptyAvMediaBoard(), mediaCatalog(), 1, {
      shape_id: 3,
      transform: BOX,
      media_path: 'ppt/media/clip1.mp4',
      bytes: MP4,
    });
    try {
      deleteAvMedia(inserted.presentation, emptyAvMediaBoard(), inserted.catalog, { slide_id: 1, shape_id: 3 });
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AvMediaError).reason).toBe('unknown_media_id');
    }
    try {
      deleteAvMedia(inserted.presentation, inserted.board, inserted.catalog, { slide_id: 1, shape_id: 404 });
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AvMediaError).reason).toBe('unknown_shape');
    }
  });
});

describe('PPT-12：播放设置与封面', () => {
  it('播放设置校验：音量越界 / 裁剪终点不大于起点都具名报错', () => {
    expect(avPlayback().volume).toBe(100000);
    expect(() => avPlayback({ volume: 100001 })).toThrowError(AvMediaError);
    expect(() => avPlayback({ trim_start_ms: 100, trim_end_ms: 100 })).toThrowError(AvMediaError);
    expect(avPlayback({ loop: true, muted: true, trim_start_ms: 500, trim_end_ms: 1500 }).trim_end_ms).toBe(1500);
  });

  it('改播放设置是纯函数：原旁表不动，新旁表带新值', () => {
    const board = avMediaBoard([embeddedItem()]);
    const next = setAvPlayback(board, 'm1', { loop: true, volume: 50000 });
    expect(next.item.playback.loop).toBe(true);
    expect(next.item.playback.volume).toBe(50000);
    // 反向：原旁表那一条没被就地改。
    expect(avMediaItemOf(board, 'm1')!.playback.loop).toBe(false);
  });

  it('反向对照：未登记的 media_id 改设置 / 改封面都具名报错', () => {
    const board = avMediaBoard([embeddedItem()]);
    try {
      setAvPlayback(board, 'nope', { loop: true });
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AvMediaError).reason).toBe('unknown_media_id');
    }
    try {
      setAvCover(board, 'nope', null);
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AvMediaError).reason).toBe('unknown_media_id');
    }
  });

  it('封面必须是图片：非图片与未知扩展名都具名 invalid_cover', () => {
    const board = avMediaBoard([embeddedItem()]);
    try {
      setAvCover(board, 'm1', { cover_path: 'ppt/media/clip.mp4' });
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AvMediaError).reason).toBe('invalid_cover');
    }
    try {
      setAvCover(board, 'm1', { cover_path: 'ppt/media/poster.xyz' });
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AvMediaError).reason).toBe('invalid_cover');
    }
    // 反向：图片封面通过。
    expect(setAvCover(board, 'm1', { cover_path: 'ppt/media/poster.png' }).item.cover?.cover_path).toBe(
      'ppt/media/poster.png',
    );
  });
});

describe('PPT-12：产物是真实 XML，embedded 决定 r:embed / r:link', () => {
  const catalogWithPart = addMediaPart(mediaCatalog(), 'ppt/media/clip1.mp4', MP4);

  function render(video: boolean, declared: 'embedded' | 'linked', options?: { cover?: boolean }): string {
    const item: AvMediaItem = embeddedItem({
      kind: video ? 'video' : 'audio',
      declared,
      media_path: video ? 'ppt/media/clip1.mp4' : 'ppt/media/song.mp3',
      cover: options?.cover === true ? { cover_path: 'ppt/media/poster.png' } : null,
    });
    const shape = avMediaShape(
      video ? 5 : 6,
      item.media_path,
      { name: video ? 'Video 5' : 'Audio 6', transform: BOX },
    );
    const catalog = video ? catalogWithPart : mediaCatalog();
    const resolution = resolveAvMedia(item, catalog);
    return renderAvMediaXml(shape, item, resolution, { media_rel_id: 'rId2', cover_rel_id: 'rId4' });
  }

  it('嵌入视频：p:pic + a:videoFile(r:link) + p14:media(r:embed) + 点击动作 + 封面 blip', () => {
    const xml = render(true, 'embedded', { cover: true });
    const root = parseXmlDocument(xml);
    expect(root.name).toBe('p:pic');
    const click = firstElement(firstElement(firstElement(root, 'p:nvPicPr'), 'p:cNvPr'), 'a:hlinkClick');
    expect(attributeOf(click, 'action')).toBe(ACTION_MEDIA);

    const nvPr = firstElement(firstElement(root, 'p:nvPicPr'), 'p:nvPr');
    expect(attributeOf(firstElement(nvPr, 'a:videoFile'), 'r:link')).toBe('rId2');
    expect(firstElement(nvPr, 'a:audioFile')).toBeUndefined();
    const media = firstElement(nvPr, 'p14:media');
    expect(attributeOf(media, 'r:embed')).toBe('rId2');
    expect(attributeOf(media, 'r:link')).toBeUndefined();
    expect(attributeOf(media, 'xmlns:p14')).toBe('http://schemas.microsoft.com/office/powerpoint/2010/main');

    expect(attributeOf(firstElement(firstElement(root, 'p:blipFill'), 'a:blip'), 'r:embed')).toBe('rId4');
  });

  it('反向对照（核心）：链接时 p14:media 写 r:link 且**没有** r:embed（不假称已嵌入）', () => {
    const xml = render(true, 'linked');
    const nvPr = firstElement(firstElement(parseXmlDocument(xml), 'p:nvPicPr'), 'p:nvPr');
    const media = firstElement(nvPr, 'p14:media');
    expect(attributeOf(media, 'r:link')).toBe('rId2');
    expect(attributeOf(media, 'r:embed')).toBeUndefined();
    // 没给封面 ⇒ 不产出 blipFill（不是写一个空封面）。
    expect(firstElement(parseXmlDocument(xml), 'p:blipFill')).toBeUndefined();
  });

  it('反向对照：音频用 a:audioFile 而不是 a:videoFile', () => {
    const nvPr = firstElement(
      firstElement(parseXmlDocument(render(false, 'linked')), 'p:nvPicPr'),
      'p:nvPr',
    );
    expect(firstElement(nvPr, 'a:audioFile')).toBeDefined();
    expect(firstElement(nvPr, 'a:videoFile')).toBeUndefined();
  });

  it('裁剪：默认不写 p14:trim，非默认才写 st/end', () => {
    const item = embeddedItem();
    const shape = avMediaShape(5, item.media_path, { transform: BOX });
    const plain = renderAvMediaXml(shape, item, resolveAvMedia(item, catalogWithPart), { media_rel_id: 'rId2' });
    expect(plain).not.toContain('p14:trim');

    const trimmed: AvMediaItem = { ...item, playback: avPlayback({ trim_start_ms: 250, trim_end_ms: 1750 }) };
    const xml = renderAvMediaXml(shape, trimmed, resolveAvMedia(trimmed, catalogWithPart), { media_rel_id: 'rId2' });
    const trim = firstElement(firstElement(parseXmlDocument(xml), 'p:nvPicPr'), 'p:nvPr');
    const trimEl = firstElement(firstElement(trim, 'p14:media'), 'p14:trim');
    expect(attributeOf(trimEl, 'st')).toBe('250');
    expect(attributeOf(trimEl, 'end')).toBe('1750');
  });

  it('片段可包进可解析的最小幻灯片文档', () => {
    const document = wrapAvMediaInSlideDocument(render(true, 'embedded'));
    expect(parseXmlDocument(document).name).toBe('p:sld');
  });

  it('放映时间：autoplay ⇒ delay=0，否则 indefinite；loop ⇒ repeatCount=indefinite', () => {
    const item = embeddedItem();
    const click = renderAvMediaTimingXml(item, 5);
    expect(click).toContain('delay="indefinite"');
    expect(click).not.toContain('repeatCount="indefinite"');
    expect(click).toContain('showWhenStopped="1"');

    const auto = renderAvMediaTimingXml({ ...item, playback: avPlayback({ autoplay: true, loop: true, muted: true, volume: 20000 }) }, 5);
    expect(auto).toContain('delay="0"');
    expect(auto).toContain('repeatCount="indefinite"');
    expect(auto).toContain('vol="20000"');
    expect(auto).toContain('mute="1"');
    const mediaNode = firstElement(parseXmlDocument(auto), 'p:tnLst');
    expect(mediaNode).toBeDefined();
  });

  it('反向对照：含 media 形状的整份文稿**不能**走 renderPresentation（本层不假装能整份渲染）', () => {
    const inserted = insertAvMedia(deck(1), emptyAvMediaBoard(), mediaCatalog(), 1, {
      shape_id: 3,
      transform: BOX,
      media_path: 'ppt/media/clip1.mp4',
      bytes: MP4,
    });
    try {
      renderPresentation(inserted.presentation, { media: inserted.catalog.parts });
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationRenderError);
      expect((error as PresentationRenderError).reason).toBe('unsupported_shape_kind');
    }
  });
});

describe('PPT-12：关系声明与审计', () => {
  it('嵌入视频：fallback 是 video 关系、target_mode 为 Internal；封面走图片关系', () => {
    const item = embeddedItem({ cover: { cover_path: 'ppt/media/poster.png' } });
    const catalog = addMediaPart(mediaCatalog(), 'ppt/media/clip1.mp4', MP4);
    const relations = avMediaRelationships(item, resolveAvMedia(item, catalog));
    expect(relations.map((entry) => entry.purpose)).toEqual(['media_fallback', 'media_embed', 'cover']);
    expect(relations[0]!.type).toBe(REL_VIDEO);
    expect(relations[0]!.target_mode).toBe('Internal');
    expect(relations[1]!.type).toBe(REL_P14_MEDIA);
    expect(relations[2]!.type).toBe(REL_IMAGE);
  });

  it('反向对照：外链时 target_mode 是 External；音频用 audio 关系而不是 video', () => {
    const item = embeddedItem({ declared: 'linked', media_path: 'https://x/a.mp3', kind: 'audio' });
    const relations = avMediaRelationships(item, resolveAvMedia(item, mediaCatalog()));
    expect(relations[0]!.type).toBe(REL_AUDIO);
    expect(relations[0]!.target_mode).toBe('External');
  });

  it('审计：目录里没有任何引用的音视频部件被点名为孤儿，严格断言抛错', () => {
    const catalog: MediaCatalog = addMediaPart(mediaCatalog(), 'ppt/media/orphan.mp4', MP4);
    const audit = auditAvMedia(deck(1), emptyAvMediaBoard(), catalog);
    expect(audit.orphan_media_paths).toEqual(['ppt/media/orphan.mp4']);
    try {
      assertAvMediaConsistent(deck(1), emptyAvMediaBoard(), catalog);
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AvMediaError).reason).toBe('unreferenced_media_part');
    }
  });

  it('审计：模型里有 media 形状但旁表没登记 ⇒ unlisted_shapes 点名，严格断言抛错', () => {
    const presentation = addShapeVia(deck(1));
    const audit = auditAvMedia(presentation, emptyAvMediaBoard(), mediaCatalog());
    expect(audit.unlisted_shapes).toHaveLength(1);
    try {
      assertAvMediaConsistent(presentation, emptyAvMediaBoard(), mediaCatalog());
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AvMediaError).reason).toBe('not_a_media_shape');
    }
  });

  it('反向对照：一致的文稿 + 旁表 + 目录 ⇒ 审计全空', () => {
    const inserted = insertAvMedia(deck(1), emptyAvMediaBoard(), mediaCatalog(), 1, {
      shape_id: 3,
      transform: BOX,
      media_path: 'ppt/media/clip1.mp4',
      bytes: MP4,
    });
    const audit = auditAvMedia(inserted.presentation, inserted.board, inserted.catalog);
    expect(audit.broken).toHaveLength(0);
    expect(audit.false_embed_claims).toHaveLength(0);
    expect(audit.orphan_media_paths).toHaveLength(0);
    expect(audit.unlisted_shapes).toHaveLength(0);
  });
});

/** 把一段幻灯片文档片段塞进第 1 页（给 unlisted_shapes 用例造"模型有、旁表没有"的对象）。 */
function addShapeVia(presentation: Presentation): Presentation {
  const shape = avMediaShape(77, 'ppt/media/clip9.mp4', { transform: BOX });
  return {
    ...presentation,
    slides: presentation.slides.map((slide) =>
      slide.slide_id !== 1 ? slide : { ...slide, shapes: [...slide.shapes, shape] },
    ),
  };
}

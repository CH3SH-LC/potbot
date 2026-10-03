/**
 * P-I13 · `p14:trim` 归属契约定向验收（PPT-12 / P-R05 契约缺口）。
 *
 * ## 契约（P-R05 提出的缺口，本单元钉住）
 *
 * `p14:trim` 的落点是**对象片段**（`p:pic` → `p:nvPr` → `p14:media` → `p14:trim`），
 * **不是**放映时间片段——这与 PowerPoint 写受控引用音视频的真实结构一致（`p:cMediaNode`
 * 只承载 vol / mute / showWhenStopped / delay / repeatCount）。`AV_MEDIA_TRIM_PLACEMENT`
 * 就是这个决定的单一事实来源；`renderAvMediaTimingXml` 因此不产出 trim。
 *
 * ## 判据
 *
 * 从 `assembleAvMediaPackage` 产出的**真实 PPTX 字节**里取出 slide XML，用
 * `readAvMediaTrimFromPicXml` 端到端读回 trim 起点/终点；并证明 timing 片段里**没有** trim。
 * 反向对照：默认不裁剪的项读回 `found:false` 且产物里根本没有 `p14:trim`。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/index.js';
import {
  AV_MEDIA_TRIM_PLACEMENT,
  avMediaBoard,
  avMediaShape,
  avPlayback,
  emptyAvMediaBoard,
  insertAvMedia,
  readAvMediaPlaybackFromFragments,
  readAvMediaTrimFromPicXml,
  readAvMediaTrimFromTimingXml,
  renderAvMediaPicXml,
  renderAvMediaTimingXml,
  resolveAvMedia,
  type AvMediaItem,
} from '../../../../src/presentations/av-media.js';
import { mediaCatalog } from '../../../../src/presentations/media.js';
import { avPackageDeck, assembleAvMediaPackage } from '../../../../src/presentations/media-parts/index.js';
import { transform } from '../../../../src/presentations/model.js';

// 真实长度的 mp4 头（ftyp/isom），非空。
const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const BOX = transform(100000, 200000, 3000000, 2000000);

/** 从真实包字节里取幻灯片的 UTF-8 文本。 */
function slideText(bytes: Uint8Array, path = 'ppt/slides/slide1.xml'): string {
  const entry = readZip(bytes).by_path.get(path);
  if (entry === undefined) throw new Error(`缺少部件 ${path}`);
  return Buffer.from(entry.data).toString('utf8');
}

/** 截出 `p:timing` 片段（幻灯片 XML 末尾），用于单独扫描"timing 里有没有 trim"。 */
function timingSlice(xml: string): string {
  const at = xml.indexOf('<p:timing>');
  if (at < 0) throw new Error('幻灯片 XML 里没有 <p:timing>');
  const end = xml.indexOf('</p:timing>');
  return xml.slice(at, end + '</p:timing>'.length);
}

describe('P-I13：p14:trim 契约钉在对象片段（timing 片段不含 trim）', () => {
  it('契约常量与两个渲染函数的产出位置一致：trim 只在对象片段', () => {
    expect(AV_MEDIA_TRIM_PLACEMENT).toBe('object_fragment');

    const item: AvMediaItem = Object.freeze({
      media_id: 'm1',
      slide_id: 1,
      shape_id: 5,
      media_path: 'ppt/media/clip1.mp4',
      kind: 'video',
      declared: 'embedded',
      cover: null,
      playback: avPlayback({ trim_start_ms: 250, trim_end_ms: 1750 }),
      alt_text: '',
    });
    const shape = avMediaShape(5, item.media_path, { transform: BOX });
    const catalog = mediaCatalog();
    const pic = renderAvMediaPicXml(shape, item, resolveAvMedia(item, catalog), {
      fallback_rel_id: 'rId2',
      media_rel_id: 'rId3',
    });
    const timing = renderAvMediaTimingXml(item, 5);

    // 对象片段有 p14:trim；放映时间片段没有。
    expect(pic).toContain('<p14:trim');
    expect(timing).not.toContain('p14:trim');

    expect(readAvMediaTrimFromPicXml(pic)).toEqual({
      found: true,
      trim_start_ms: 250,
      trim_end_ms: 1750,
      source: 'object_fragment',
    });
    // timing 侧是真实扫描 ⇒ 如实返回 found:false（source 标 timing_fragment）。
    expect(readAvMediaTrimFromTimingXml(timing)).toEqual({
      found: false,
      trim_start_ms: 0,
      trim_end_ms: null,
      source: 'timing_fragment',
    });
  });
});

describe('P-I13：从真实 PPTX 产出的字节端到端读回 trim', () => {
  function trimmedPackage(trim: { trim_start_ms: number; trim_end_ms: number | null }): Uint8Array {
    const deck = avPackageDeck(1);
    const inserted = insertAvMedia(deck, emptyAvMediaBoard(), mediaCatalog(), 1, {
      transform: BOX,
      media_path: 'ppt/media/clip1.mp4',
      bytes: MP4,
      playback: trim,
    });
    return assembleAvMediaPackage(inserted.presentation, inserted.board, inserted.catalog).bytes;
  }

  it('裁剪被写进对象片段并可端到端读回；timing 片段里读不到（契约落点）', () => {
    const bytes = trimmedPackage({ trim_start_ms: 250, trim_end_ms: 1750 });
    const slide = slideText(bytes);

    // 结构落点：p14:trim 在 <p:timing> 之前（即对象片段里），且 p14:media 先于它。
    const trimAt = slide.indexOf('<p14:trim');
    const mediaAt = slide.indexOf('<p14:media');
    const timingAt = slide.indexOf('<p:timing>');
    expect(trimAt).toBeGreaterThanOrEqual(0);
    expect(mediaAt).toBeGreaterThanOrEqual(0);
    expect(mediaAt).toBeLessThan(trimAt);
    expect(timingAt).toBeGreaterThan(trimAt);

    // 端到端读回：从产出的字节里取出对象片段所在的幻灯片 XML，读回起点/终点。
    // （契约命名的载体是对象片段 ⇒ 用对象片段读回器。）
    const readback = readAvMediaTrimFromPicXml(slide);
    expect(readback.found).toBe(true);
    expect(readback.trim_start_ms).toBe(250);
    expect(readback.trim_end_ms).toBe(1750);
    expect(readback.source).toBe('object_fragment');

    // timing 片段单独扫描：确实不含 trim。
    const timing = timingSlice(slide);
    expect(timing).not.toContain('p14:trim');
    expect(readAvMediaTrimFromTimingXml(timing)).toEqual({
      found: false,
      trim_start_ms: 0,
      trim_end_ms: null,
      source: 'timing_fragment',
    });
  });

  it('反向对照：默认不裁剪的项在产物里根本不写 p14:trim，读回 found:false', () => {
    const bytes = trimmedPackage({ trim_start_ms: 0, trim_end_ms: null });
    const slide = slideText(bytes);
    expect(slide).not.toContain('p14:trim');
    const readback = readAvMediaTrimFromPicXml(slide);
    expect(readback.found).toBe(false);
    expect(readback.trim_start_ms).toBe(0);
    expect(readback.trim_end_ms).toBeNull();
  });

  it('只给起点不给终点：写 st 不写 end，读回 end 为 null（播到片尾）', () => {
    const bytes = trimmedPackage({ trim_start_ms: 400, trim_end_ms: null });
    const readback = readAvMediaTrimFromPicXml(slideText(bytes));
    expect(readback.found).toBe(true);
    expect(readback.trim_start_ms).toBe(400);
    expect(readback.trim_end_ms).toBeNull();
  });
});

describe('P-I13：一次性读回完整播放事实（对象片段出裁剪，timing 出其余）', () => {
  it('裁剪走对象片段、autoplay/loop/音量/静音/控件走 timing，读回与写入一致', () => {
    const item: AvMediaItem = Object.freeze({
      media_id: 'm1',
      slide_id: 1,
      shape_id: 5,
      media_path: 'ppt/media/clip1.mp4',
      kind: 'video',
      declared: 'embedded',
      cover: null,
      playback: avPlayback({
        autoplay: true,
        loop: true,
        muted: true,
        volume: 20000,
        show_controls: false,
        trim_start_ms: 250,
        trim_end_ms: 1750,
      }),
      alt_text: '',
    });
    const shape = avMediaShape(5, item.media_path, { transform: BOX });
    const pic = renderAvMediaPicXml(shape, item, resolveAvMedia(item, mediaCatalog()), {
      fallback_rel_id: 'rId2',
      media_rel_id: 'rId3',
    });
    const timing = renderAvMediaTimingXml(item, 5);

    const readback = readAvMediaPlaybackFromFragments(pic, timing);
    expect(readback).toEqual(item.playback);
    expect(readback.trim_start_ms).toBe(250);
    expect(readback.trim_end_ms).toBe(1750);
    expect(readback.autoplay).toBe(true);
    expect(readback.loop).toBe(true);
    expect(readback.muted).toBe(true);
    expect(readback.volume).toBe(20000);
    expect(readback.show_controls).toBe(false);
  });

  it('反向对照：默认播放设置的读回等于默认（不假报 autoplay/loop）', () => {
    const item: AvMediaItem = Object.freeze({
      media_id: 'm2',
      slide_id: 1,
      shape_id: 6,
      media_path: 'ppt/media/song.mp3',
      kind: 'audio',
      declared: 'linked',
      cover: null,
      playback: avPlayback(),
      alt_text: '',
    });
    const shape = avMediaShape(6, item.media_path, { transform: BOX });
    const pic = renderAvMediaPicXml(shape, item, resolveAvMedia(item, mediaCatalog()), {
      fallback_rel_id: 'rId4',
      media_rel_id: 'rId5',
    });
    const timing = renderAvMediaTimingXml(item, 6);
    const readback = readAvMediaPlaybackFromFragments(pic, timing);
    expect(readback.autoplay).toBe(false);
    expect(readback.loop).toBe(false);
    expect(readback.trim_start_ms).toBe(0);
    expect(readback.trim_end_ms).toBeNull();
    // 反例：不得把"点击播放"读成自动播放。
    expect(timing).toContain('delay="indefinite"');
  });
});

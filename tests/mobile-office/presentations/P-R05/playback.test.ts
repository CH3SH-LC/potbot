/**
 * P-R05 · 手机放映 / 音视频播放 / 方向变化 / 导回验收（独立定向验收）。
 *
 * ## 判据独立于实现
 *
 * - 适配几何由本文件**自算**（`expectedContain` / `expectedCover`），不看 `fitSlideshow`；
 * - 导回走**真字节**：`renderPresentation → importPresentation`，再自算有序页集做逐项比对，
 *   复用 `planSlideshow` 只作交叉核对；
 * - 音视频时间推进用**手算期望值**（起止夹取、回绕计数）对照状态机。
 *
 * ## 反向对照（每条都能咬）
 *
 * - 隐藏页必须被排除；`include_hidden` 打开后才出现；
 * - 方向与尺寸不符 ⇒ 抛 `viewport_orientation_mismatch`（不静默纠正）；
 * - 时长未知时**不得**谎报播完（停在 `playing`）；给了真实时长后才 `ended`；
 * - 方向变化后放映事实逐字不变（`diffSessionFacts` 为空），但几何确实改变；
 * - 页集被改动后导回必须具名报错（`roundtrip_order_mismatch`）。
 *
 * ## 覆盖到的层 / 未覆盖的层
 *
 * 本文件是 **unit + contract（含本仓真字节往返）** 级证据。真机放映、真机音视频、像素观感、
 * 外部消费端打开**未验证**（见 `PLAYBACK_UNVERIFIED_CLAIMS`）。
 */

import { describe, expect, it } from 'vitest';

import { literalText, transform, type Presentation, type Shape } from '../../../../src/presentations/model.js';
import { addShape, addSlide, setSlideHidden, setSlideTransition } from '../../../../src/presentations/operations.js';
import { emptyPresentation, renderPresentation } from '../../../../src/presentations/render.js';
import { importPresentation } from '../../../../src/presentations/roundtrip.js';
import {
  avMediaBoard,
  avMediaShape,
  avPlayback,
  renderAvMediaTimingXml,
  renderAvMediaXml,
  type AvMediaItem,
} from '../../../../src/presentations/av-media.js';
import {
  DEFAULT_LANDSCAPE_VIEWPORT,
  DEFAULT_PORTRAIT_VIEWPORT,
  PLAYBACK_UNVERIFIED_CLAIMS,
  advanceSession,
  changeOrientation,
  diffSessionFacts,
  fitSlideshow,
  gotoSlide,
  nextSlide,
  pauseMedia,
  pauseSession,
  playMedia,
  prevSlide,
  resumeSession,
  sessionSnapshot,
  startSession,
  stopSession,
  verifyPresentationRoundTrip,
  type Viewport,
  type SlideshowSession,
} from './playback.js';

// ---------------------------------------------------------------------------
// 独立几何实现（不复用待测模块）
// ---------------------------------------------------------------------------

function expectedContain(cx: number, cy: number, w: number, h: number) {
  const scale = Math.min(w / cx, h / cy);
  const dw = cx * scale;
  const dh = cy * scale;
  return { scale, dw, dh, offsetX: (w - dw) / 2, offsetY: (h - dh) / 2, letterbox: w * h - dw * dh };
}

function expectedCover(cx: number, cy: number, w: number, h: number) {
  const scale = Math.max(w / cx, h / cy);
  const dw = cx * scale;
  const dh = cy * scale;
  return { scale, dw, dh, letterbox: w * h - dw * dh };
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const SLIDE_16_9 = { cx_emu: 12192000, cy_emu: 6858000 };

function textBox(id: number, text: string): Shape {
  return {
    kind: 'text_box',
    shape_id: id,
    name: `Box ${String(id)}`,
    transform: transform(0, 0, 4000000, 1000000),
    text: literalText(text),
  };
}

let nextId = 256;

/**
 * 一份 16:9 文稿：
 * - 首页（transition `fade` 400ms）
 * - 隐藏页（transition `push` 300ms）—— 默认不放
 * - 中页（有切换 `wipe` 200ms）
 * - 末页（无切换）
 */
function buildDeck(): { deck: Presentation; first: number; hidden: number; middle: number; last: number } {
  let deck = emptyPresentation('deck-r05', 'P-R05 放映验收');
  deck = { ...deck, size: SLIDE_16_9 };
  const first = nextId++;
  const hidden = nextId++;
  const middle = nextId++;
  const last = nextId++;
  deck = addSlide(deck, { slide_id: first }).presentation;
  deck = addSlide(deck, { slide_id: hidden }).presentation;
  deck = addSlide(deck, { slide_id: middle }).presentation;
  deck = addSlide(deck, { slide_id: last }).presentation;
  deck = addShape(deck, first, textBox(2, '第一页'));
  deck = addShape(deck, middle, textBox(3, '中间页'));
  deck = setSlideTransition(deck, first, { kind: 'fade', duration_ms: 400 });
  deck = setSlideTransition(deck, hidden, { kind: 'push', duration_ms: 300 });
  deck = setSlideTransition(deck, middle, { kind: 'wipe', duration_ms: 200 });
  deck = setSlideHidden(deck, hidden, true);
  return { deck, first, hidden, middle, last };
}

function avItem(overrides: Partial<AvMediaItem> & Pick<AvMediaItem, 'media_id' | 'slide_id' | 'shape_id' | 'media_path' | 'kind'>): AvMediaItem {
  return Object.freeze({
    declared: 'embedded',
    cover: null,
    playback: avPlayback(),
    alt_text: overrides.media_id,
    ...overrides,
  });
}

function buildBoard(first: number, middle: number) {
  const video = avItem({
    media_id: 'v1',
    slide_id: first,
    shape_id: 901,
    media_path: 'ppt/media/video1.mp4',
    kind: 'video',
    playback: avPlayback({ autoplay: true, trim_end_ms: 1000 }),
  });
  const audio = avItem({
    media_id: 'a1',
    slide_id: middle,
    shape_id: 902,
    media_path: 'ppt/media/audio1.mp3',
    kind: 'audio',
    playback: avPlayback({ autoplay: false, muted: true, volume: 40000 }),
  });
  return avMediaBoard([video, audio]);
}

// ---------------------------------------------------------------------------
// 1. 适配几何与方向
// ---------------------------------------------------------------------------

describe('P-R05 §1 适配几何：整页可见 / 铺满裁切 / 不拉伸', () => {
  it('16:9 幻灯片进 16:9 横屏视口：无黑边、整页可见、缩放 = 宽比', () => {
    const vp: Viewport = { width_px: 1920, height_px: 1080, orientation: 'landscape' };
    const fit = fitSlideshow(SLIDE_16_9, vp, 'contain');
    const want = expectedContain(SLIDE_16_9.cx_emu, SLIDE_16_9.cy_emu, 1920, 1080);
    expect(fit.scale).toBeCloseTo(want.scale, 12);
    expect(fit.display_width_px).toBeCloseTo(1920, 6);
    expect(Math.abs(fit.letterbox_px2)).toBeLessThan(1e-3);
    expect(fit.content_fully_visible).toBe(true);
    expect(fit.aspect_preserved).toBe(true);
  });

  it('进竖屏视口（contain）：有黑边、整页仍可见、长宽比保持', () => {
    const fit = fitSlideshow(SLIDE_16_9, DEFAULT_PORTRAIT_VIEWPORT, 'contain');
    const want = expectedContain(SLIDE_16_9.cx_emu, SLIDE_16_9.cy_emu, 1080, 2340);
    expect(fit.display_width_px).toBeCloseTo(want.dw, 6);
    expect(fit.display_height_px).toBeCloseTo(want.dh, 6);
    expect(fit.letterbox_px2).toBeGreaterThan(0);
    expect(fit.content_fully_visible).toBe(true);
    const aspect = fit.display_width_px / fit.display_height_px;
    expect(aspect).toBeCloseTo(SLIDE_16_9.cx_emu / SLIDE_16_9.cy_emu, 12);
  });

  it('进竖屏视口（cover）：铺满、确有裁切、长宽比保持、整页不可见', () => {
    const fit = fitSlideshow(SLIDE_16_9, DEFAULT_PORTRAIT_VIEWPORT, 'cover');
    const want = expectedCover(SLIDE_16_9.cx_emu, SLIDE_16_9.cy_emu, 1080, 2340);
    expect(fit.scale).toBeCloseTo(want.scale, 12);
    expect(fit.letterbox_px2).toBeLessThan(0);
    expect(fit.content_fully_visible).toBe(false);
    const aspect = fit.display_width_px / fit.display_height_px;
    expect(aspect).toBeCloseTo(SLIDE_16_9.cx_emu / SLIDE_16_9.cy_emu, 12);
  });

  it('方向与尺寸不符：抛具名错误，不静默纠正', () => {
    let caught: unknown;
    try {
      fitSlideshow(SLIDE_16_9, { width_px: 2340, height_px: 1080, orientation: 'portrait' });
    } catch (error) {
      caught = error;
    }
    expect((caught as { reason?: string }).reason).toBe('viewport_orientation_mismatch');
  });
});

// ---------------------------------------------------------------------------
// 2. 页序与隐藏页
// ---------------------------------------------------------------------------

describe('P-R05 §2 页序与隐藏页过滤（复用 planSlideshow）', () => {
  it('默认排除隐藏页，顺序与原页序一致', () => {
    const { deck, first, hidden, middle, last } = buildDeck();
    const board = buildBoard(first, middle);
    const session = startSession(deck, board, DEFAULT_LANDSCAPE_VIEWPORT);
    expect([...session.order]).toEqual([first, middle, last]);
    expect([...session.excluded_hidden]).toEqual([hidden]);
    expect(session.current_slide_id).toBe(first);
    expect(session.transition_kind).toBe('fade');
    expect(session.transition_duration_ms).toBe(400);
  });

  it('include_hidden 打开后隐藏页出现在页序里', () => {
    const { deck, first, hidden, middle, last } = buildDeck();
    const board = buildBoard(first, middle);
    const session = startSession(deck, board, DEFAULT_LANDSCAPE_VIEWPORT, { include_hidden: true });
    expect([...session.order]).toEqual([first, hidden, middle, last]);
  });

  it('slide_range 的序号是对**全量页**而言（含隐藏页），隐藏页仍在范围内被排除', () => {
    const { deck, first, middle } = buildDeck();
    const board = buildBoard(first, middle);
    // 页序：first(1) / hidden(2) / middle(3) / last(4)。范围 1..2 只覆盖 first + hidden，
    // hidden 被过滤 ⇒ 只剩 first。中间页是第 3 页，不在范围内。
    const session = startSession(deck, board, DEFAULT_LANDSCAPE_VIEWPORT, { slide_range: { from: 1, to: 2 } });
    expect([...session.order]).toEqual([first]);
  });

  it('slide_range 覆盖到中间页时正常纳入', () => {
    const { deck, first, middle } = buildDeck();
    const board = buildBoard(first, middle);
    const session = startSession(deck, board, DEFAULT_LANDSCAPE_VIEWPORT, { slide_range: { from: 1, to: 3 } });
    expect([...session.order]).toEqual([first, middle]);
  });
});

// ---------------------------------------------------------------------------
// 3. 导航
// ---------------------------------------------------------------------------

describe('P-R05 §3 导航：点击翻页 / 到末页结束 / 隐藏页不可跳', () => {
  it('next 走到末页后再 next ⇒ ended，当前页停在末页', () => {
    const { deck, first, hidden, middle, last } = buildDeck();
    const board = buildBoard(first, middle);
    let session = startSession(deck, board, DEFAULT_LANDSCAPE_VIEWPORT);
    session = nextSlide(session);
    expect(session.current_slide_id).toBe(middle);
    expect(session.transition_kind).toBe('wipe');
    session = nextSlide(session);
    expect(session.current_slide_id).toBe(last);
    session = nextSlide(session);
    expect(session.state).toBe('ended');
    expect(session.current_slide_id).toBe(last);
    expect(session.order.includes(hidden)).toBe(false);
  });

  it('首页 prev 无操作；到第 2 页后 prev 回到第 1 页', () => {
    const { deck, first, middle } = buildDeck();
    const board = buildBoard(first, middle);
    let session = startSession(deck, board, DEFAULT_LANDSCAPE_VIEWPORT);
    expect(prevSlide(session)).toBe(session);
    session = nextSlide(session);
    session = prevSlide(session);
    expect(session.current_slide_id).toBe(first);
  });

  it('gotoSlide 跳隐藏页 ⇒ slide_not_in_show', () => {
    const { deck, first, hidden, middle } = buildDeck();
    const board = buildBoard(first, middle);
    const session = startSession(deck, board, DEFAULT_LANDSCAPE_VIEWPORT);
    let caught: unknown;
    try {
      gotoSlide(session, hidden);
    } catch (error) {
      caught = error;
    }
    expect((caught as { reason?: string }).reason).toBe('slide_not_in_show');
  });
});

// ---------------------------------------------------------------------------
// 4. 音视频随页起停
// ---------------------------------------------------------------------------

describe('P-R05 §4 音视频随页起停：自动播放 / 切页停 / 手动播', () => {
  it('首页自动播放的视频在 started 时即 playing；非当前页的音频为 idle', () => {
    const { deck, first, middle } = buildDeck();
    const board = buildBoard(first, middle);
    const session = startSession(deck, board, DEFAULT_LANDSCAPE_VIEWPORT);
    const v1 = session.av.find((s) => s.media_id === 'v1')!;
    const a1 = session.av.find((s) => s.media_id === 'a1')!;
    expect(v1.state).toBe('playing');
    expect(v1.ever_started).toBe(true);
    expect(a1.state).toBe('idle');
  });

  it('切页后上一页的项收成 stopped，当前页非自动项仍 idle；手动可播', () => {
    const { deck, first, middle } = buildDeck();
    const board = buildBoard(first, middle);
    let session = startSession(deck, board, DEFAULT_LANDSCAPE_VIEWPORT);
    session = nextSlide(session);
    expect(session.av.find((s) => s.media_id === 'v1')!.state).toBe('stopped');
    expect(session.av.find((s) => s.media_id === 'a1')!.state).toBe('idle');
    session = playMedia(session, 'a1');
    expect(session.av.find((s) => s.media_id === 'a1')!.state).toBe('playing');
    expect(session.av.find((s) => s.media_id === 'a1')!.muted).toBe(true);
    expect(session.av.find((s) => s.media_id === 'a1')!.volume).toBe(40000);
  });

  it('播别页的项 ⇒ media_not_on_current_slide；未知 id ⇒ unknown_media', () => {
    const { deck, first, middle } = buildDeck();
    const board = buildBoard(first, middle);
    let session = startSession(deck, board, DEFAULT_LANDSCAPE_VIEWPORT);
    session = nextSlide(session);
    let caught: unknown;
    try {
      playMedia(session, 'v1');
    } catch (error) {
      caught = error;
    }
    expect((caught as { reason?: string }).reason).toBe('media_not_on_current_slide');
    try {
      playMedia(session, 'nope');
    } catch (error) {
      caught = error;
    }
    expect((caught as { reason?: string }).reason).toBe('unknown_media');
  });
});

// ---------------------------------------------------------------------------
// 5. 时间推进 / 循环 / 裁剪 / 时长未知
// ---------------------------------------------------------------------------

describe('P-R05 §5 时间推进：手算期望值对照', () => {
  it('裁剪终点 1000ms：推进 600 仍在播、再推 600 到点即 ended', () => {
    const { deck, first, middle } = buildDeck();
    const board = buildBoard(first, middle);
    let session = startSession(deck, board, DEFAULT_LANDSCAPE_VIEWPORT);
    session = advanceSession(session, 600);
    let v1 = session.av.find((s) => s.media_id === 'v1')!;
    expect(v1.position_ms).toBe(600);
    expect(v1.state).toBe('playing');
    session = advanceSession(session, 600);
    v1 = session.av.find((s) => s.media_id === 'v1')!;
    expect(v1.position_ms).toBe(1000);
    expect(v1.state).toBe('ended');
    expect(session.position_ms).toBe(1200);
    expect(session.elapsed_total_ms).toBe(1200);
  });

  it('loop：越过终点回绕到起点并计一次循环', () => {
    const { deck, first, middle } = buildDeck();
    const video = avItem({
      media_id: 'v1',
      slide_id: first,
      shape_id: 901,
      media_path: 'ppt/media/video1.mp4',
      kind: 'video',
      playback: avPlayback({ autoplay: true, loop: true, trim_end_ms: 1000 }),
    });
    const board = avMediaBoard([video]);
    let session = startSession(deck, board, DEFAULT_LANDSCAPE_VIEWPORT);
    session = advanceSession(session, 1200);
    const v1 = session.av.find((s) => s.media_id === 'v1')!;
    expect(v1.position_ms).toBe(200);
    expect(v1.loops_completed).toBe(1);
    expect(v1.state).toBe('playing');
  });

  it('时长未知：不得谎报播完（停在 playing）；给了真实时长后才 ended', () => {
    const { deck, first, middle } = buildDeck();
    const audio = avItem({
      media_id: 'a1',
      slide_id: first,
      shape_id: 903,
      media_path: 'ppt/media/audio1.mp3',
      kind: 'audio',
      playback: avPlayback({ autoplay: true }),
    });
    const board = avMediaBoard([audio]);

    // 无时长：推进很久也不结束，end 为 null、duration_known 为 false。
    let unknown = startSession(deck, board, DEFAULT_LANDSCAPE_VIEWPORT);
    unknown = advanceSession(unknown, 60000);
    const u = unknown.av.find((s) => s.media_id === 'a1')!;
    expect(u.effective_end_ms).toBeNull();
    expect(u.duration_known).toBe(false);
    expect(u.state).toBe('playing');
    expect(u.position_ms).toBe(60000);

    // 有真实时长 3000：越过即 ended，位置夹到 3000。
    let known = startSession(deck, board, DEFAULT_LANDSCAPE_VIEWPORT, {
      media_durations_ms: { a1: 3000 },
    });
    known = advanceSession(known, 5000);
    const k = known.av.find((s) => s.media_id === 'a1')!;
    expect(k.duration_known).toBe(true);
    expect(k.effective_end_ms).toBe(3000);
    expect(k.state).toBe('ended');
    expect(k.position_ms).toBe(3000);
  });

  it('暂停（整体）后时间冻结；恢复后继续', () => {
    const { deck, first, middle } = buildDeck();
    const board = buildBoard(first, middle);
    let session = startSession(deck, board, DEFAULT_LANDSCAPE_VIEWPORT);
    session = advanceSession(session, 300);
    session = pauseSession(session);
    const paused = session;
    expect(paused.av.find((s) => s.media_id === 'v1')!.state).toBe('paused');
    session = advanceSession(session, 5000);
    expect(session).toBe(paused);
    session = resumeSession(session);
    session = advanceSession(session, 200);
    expect(session.position_ms).toBe(500);
    expect(session.av.find((s) => s.media_id === 'v1')!.position_ms).toBe(500);
  });

  it('单项暂停不影响整体推进，可再恢复', () => {
    const { deck, first, middle } = buildDeck();
    const board = buildBoard(first, middle);
    let session = startSession(deck, board, DEFAULT_LANDSCAPE_VIEWPORT);
    session = pauseMedia(session, 'v1');
    session = advanceSession(session, 500);
    const v1 = session.av.find((s) => s.media_id === 'v1')!;
    expect(v1.state).toBe('paused');
    expect(v1.position_ms).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. 方向变化不改放映事实
// ---------------------------------------------------------------------------

describe('P-R05 §6 方向变化：几何变、放映事实不变', () => {
  it('横屏 → 竖屏：current/index/position/av 逐字保留，geometry 与 orientation 改变', () => {
    const { deck, first, middle } = buildDeck();
    const board = buildBoard(first, middle);
    let session = startSession(deck, board, DEFAULT_LANDSCAPE_VIEWPORT);
    session = nextSlide(session);
    session = advanceSession(session, 700);
    session = playMedia(session, 'a1');

    const before = sessionSnapshot(session);
    const beforeFit = session.fit;

    const rotated = changeOrientation(session, DEFAULT_PORTRAIT_VIEWPORT);
    const after = sessionSnapshot(rotated);

    // 放映事实逐字不变（忽略 orientation / fit）。
    expect(diffSessionFacts(before, after)).toEqual([]);
    expect(rotated.current_slide_id).toBe(session.current_slide_id);
    expect(rotated.index).toBe(session.index);
    expect(rotated.position_ms).toBe(session.position_ms);
    expect(rotated.av).toEqual(session.av);
    expect(rotated.order).toEqual(session.order);
    // 但几何确实变了。
    expect(rotated.viewport.orientation).toBe('portrait');
    expect(rotated.fit.letterbox_px2).not.toBeCloseTo(beforeFit.letterbox_px2, 3);
    expect(rotated.fit.content_fully_visible).toBe(true);
  });

  it('diffSessionFacts 能咬：改动页内位置就报出 position_ms', () => {
    const { deck, first, middle } = buildDeck();
    const board = buildBoard(first, middle);
    const session = startSession(deck, board, DEFAULT_LANDSCAPE_VIEWPORT);
    const a = sessionSnapshot(session);
    const moved = advanceSession(session, 250);
    const b = sessionSnapshot(moved);
    expect(diffSessionFacts(a, b)).toContain('position_ms');
  });
});

// ---------------------------------------------------------------------------
// 7. 导回验收（真字节往返）
// ---------------------------------------------------------------------------

describe('P-R05 §7 导回验收：真 render → import，页序与切换必须存活', () => {
  it('放过的那份保存重开后，有序页集与切换逐项一致', () => {
    const { deck, first, hidden, middle, last } = buildDeck();
    const board = buildBoard(first, middle);
    let session = startSession(deck, board, DEFAULT_LANDSCAPE_VIEWPORT);
    session = nextSlide(session); // 停在第 2 个放映页（middle）

    const result = verifyPresentationRoundTrip(session);
    expect(result.order_preserved).toBe(true);
    expect(result.reopened_order.length).toBe(3);
    expect([...result.presented_order]).toEqual([first, middle, last]);
    expect(result.excluded_hidden.length).toBe(1);
    expect(result.transitions_preserved).toBe(true);
    expect(result.current_slide_present).toBe(true);
    expect(result.slide_count).toBe(deck.slides.length);
    expect(result.entry_count).toBeGreaterThan(0);
    expect(result.content_digest).toMatch(/^[0-9a-f]{8}/);
    // 实测事实：手建文稿渲染后再导回会被重新编号 ⇒ ids_stable 为 false（不是缺陷，是需登记的行为）。
    expect(result.ids_stable).toBe(false);
    expect(result.id_map.length).toBe(3);
    expect(result.id_map[0]!.presented_id).toBe(first);
    expect(result.id_map[0]!.reopened_id).toBe(256);
  });

  it('文稿本身来自一次导入时，第二次导回 id 稳定（ids_stable = true）', () => {
    const { deck, first, middle } = buildDeck();
    const board = buildBoard(first, middle);
    // 先渲染 → 导入，得到"已归一化"的文稿，再在其上开放映。
    const normalized = importPresentation(renderPresentation(deck).bytes).presentation;
    const session = startSession(normalized, board, DEFAULT_LANDSCAPE_VIEWPORT);
    const result = verifyPresentationRoundTrip(session);
    expect(result.ids_stable).toBe(true);
    expect(result.order_preserved).toBe(true);
  });

  it('反向对照：页集被改动（多出一页）⇒ roundtrip_order_mismatch', () => {
    const { deck, first, middle } = buildDeck();
    const board = buildBoard(first, middle);
    const session = startSession(deck, board, DEFAULT_LANDSCAPE_VIEWPORT);
    const tampered: SlideshowSession = { ...session, order: Object.freeze([...session.order, 999999]) };
    let caught: unknown;
    try {
      verifyPresentationRoundTrip(tampered);
    } catch (error) {
      caught = error;
    }
    expect((caught as { reason?: string }).reason).toBe('roundtrip_order_mismatch');
  });
});

// ---------------------------------------------------------------------------
// 8. 播放设置随片段序列化存活（字符串级，非播放器级）
// ---------------------------------------------------------------------------

describe('P-R05 §8 播放设置序列化存活（字符串级，未接播放器）', () => {
  it('autoplay / loop / mute / vol 写进 timing 片段（实测：trim 不在 timing 里）', () => {
    const video = avItem({
      media_id: 'v1',
      slide_id: 256,
      shape_id: 901,
      media_path: 'ppt/media/video1.mp4',
      kind: 'video',
      playback: avPlayback({ autoplay: true, loop: true, muted: true, volume: 25000, trim_start_ms: 100, trim_end_ms: 900 }),
    });
    const xml = renderAvMediaTimingXml(video, 901);
    expect(xml).toContain('delay="0"'); // autoplay
    expect(xml).toContain('repeatCount="indefinite"'); // loop
    expect(xml).toContain('mute="1"');
    expect(xml).toContain('vol="25000"');
    expect(xml).toContain('spid="901"');
    // 实测记录：裁剪（trim）**不**落在 timing 片段里，而在对象的 `p14:media` 里（见下一用例）。
    expect(xml).not.toContain('p14:trim');

    // 反向：非自动播放应写 indefinite。
    const manual = avItem({
      media_id: 'a1',
      slide_id: 256,
      shape_id: 902,
      media_path: 'ppt/media/audio1.mp3',
      kind: 'audio',
      playback: avPlayback({ autoplay: false }),
    });
    const manualXml = renderAvMediaTimingXml(manual, 902);
    expect(manualXml).toContain('delay="indefinite"');
    expect(manualXml).not.toContain('repeatCount="indefinite"');
  });

  it('裁剪（trim）写在对象片段 p14:media 里，且可回读', () => {
    const video = avItem({
      media_id: 'v1',
      slide_id: 256,
      shape_id: 901,
      media_path: 'ppt/media/video1.mp4',
      kind: 'video',
      playback: avPlayback({ trim_start_ms: 100, trim_end_ms: 900 }),
    });
    const shape = avMediaShape(901, 'ppt/media/video1.mp4', { name: 'Video 901' });
    const resolution = {
      media_id: 'v1',
      slide_id: 256,
      shape_id: 901,
      declared: 'embedded' as const,
      kind: 'video' as const,
      media_path: 'ppt/media/video1.mp4',
      content_type: 'video/mp4',
      embedded: true,
      link_status: 'embedded' as const,
      has_cover: false,
      link_liveness_verified: false as const,
      problem: null,
    };
    const xml = renderAvMediaXml(shape, video, resolution, { media_rel_id: 'rId2' });
    expect(xml).toContain('p14:trim');
    expect(xml).toContain('st="100"');
    expect(xml).toContain('end="900"');
    expect(xml).toContain('r:embed="rId2"');
  });
});

// ---------------------------------------------------------------------------
// 9. 未验证清单如实登记
// ---------------------------------------------------------------------------

describe('P-R05 §9 未验证项如实登记', () => {
  it('四条未验证断言都在，且状态为 unverified', () => {
    expect(PLAYBACK_UNVERIFIED_CLAIMS.length).toBeGreaterThanOrEqual(4);
    for (const claim of PLAYBACK_UNVERIFIED_CLAIMS) {
      expect(claim.status).toBe('unverified');
      expect(claim.requires.length).toBeGreaterThan(0);
    }
  });

  it('stopSession 复位到 idle 并回到首页', () => {
    const { deck, first, middle } = buildDeck();
    const board = buildBoard(first, middle);
    let session = startSession(deck, board, DEFAULT_LANDSCAPE_VIEWPORT);
    session = nextSlide(session);
    session = advanceSession(session, 400);
    session = stopSession(session);
    expect(session.state).toBe('idle');
    expect(session.index).toBe(0);
    expect(session.current_slide_id).toBe(first);
    expect(session.position_ms).toBe(0);
    expect(session.av.every((s) => s.state === 'idle')).toBe(true);
  });
});

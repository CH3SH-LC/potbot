/**
 * P-I22 · **跨保存稳定页键 + 放映游标 + 自注册描述符**（集成波定向验收）。
 *
 * ## 本包把什么落地
 *
 * 1. **稳定页键**：P-R05 实测"`renderPresentation` 把页号写成 `256+index`，`importPresentation`
 *    原样读回" ⇒ `slide_id` **不是**跨保存的稳定键。本包用**序号稳定键**（页在 `slides` 里的位置）
 *    持久化"当前页"，重开后按序号解析；沿用旧 `slide_id` 则具名落空。判据：
 *    **保存 → 重开 → 再编辑**后，改动落在**同一逻辑页**（用独立解包的真实字节核对页文本）。
 * 2. **放映游标**：`tracks` P-R05 `tests/mobile-office/presentations/P-R05/playback.ts` 的
 *    `SlideshowSession`——用其 `startSession` / `nextSlide` / `verifyPresentationRoundTrip`
 *    **真实产物**驱动本层，钉住 `ordinal`（稳定）与 `show_index`（随隐藏页漂移）的区分。
 * 3. **自注册描述符**：一个入口清单同时解析 `session` 与 `rendering` 两个入口，`api` 是**真实导出
 *    的恒等引用**（不是拷贝），消费端无需深路径。
 *
 * ## 判据独立于实现
 *
 * 页文本用 `readZip` **独立解包**后按 `slideN.xml` 抓 `<a:t>`，不经会话自报；序号由数组下标独立
 * 计算；描述符恒等性用 `===` 比对测试自己 import 的真函数。反向对照：旧 `slide_id` 在重开的文稿里
 * **找不到**（`findSlideOrdinal === null`），且用它编辑被拒。
 *
 * ## 如实登记（本文件**不**验证）
 *
 * 真机放映、外部消费端（PowerPoint/WPS/手机放映端）打开与本层游标一致——**均未验证**（无真机、
 * 无消费端）。本文件只到"模型层 + 字节层 + 逻辑层"。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/index.js';
import {
  PRESENTATIONS_PLUGIN_ID,
  PRESENTATIONS_PLUGIN_REGISTRATION,
  PRESENTATIONS_PLUGIN_VERSION,
  PresentationRegistryError,
  applySessionEdit,
  captureCurrentSlideRef,
  createPresentationSession,
  findSlideOrdinal,
  makeSurfaceDescriptor,
  openSessionFromBytes,
  playheadFromShow,
  playheadToSlideRef,
  registerSurface,
  resolveCurrentSlideRef,
  resolvePlayhead,
  resolveSurface,
  saveSession,
  sessionPresentation,
  slideIdAtOrdinal,
  type PresentationPluginRegistry,
  type PresentationSurfaceName,
  type SessionEditOutcome,
  type SlideCursorError,
} from '../../../../src/mobile-plugins/presentations/session/index.js';
import {
  renderPresentationToPngs,
  renderSlideToPng,
} from '../../../../src/mobile-plugins/presentations/rendering/index.js';

import { emptyAvMediaBoard } from '../../../../src/presentations/av-media.js';
import { literalText, transform, type Presentation, type Shape } from '../../../../src/presentations/model.js';
import { addShape, addSlide, setSlideHidden } from '../../../../src/presentations/operations.js';
import { emptyPresentation, renderPresentation } from '../../../../src/presentations/render.js';
import { importPresentation } from '../../../../src/presentations/roundtrip.js';

import {
  DEFAULT_LANDSCAPE_VIEWPORT,
  nextSlide,
  startSession,
  verifyPresentationRoundTrip,
} from '../P-R05/playback.js';

// ---------------------------------------------------------------------------
// 独立工具（不复用被测模块的判定）
// ---------------------------------------------------------------------------

/** 按 `slideN` 数值升序返回真实解包后的每页 (路径, 文本)。 */
function slidePages(bytes: Uint8Array): readonly { readonly path: string; readonly text: string }[] {
  const archive = readZip(bytes);
  const paths = [...archive.by_path.keys()].filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path));
  paths.sort((a, b) => slideOrdinalOfPath(a) - slideOrdinalOfPath(b));
  return paths.map((path) => {
    const entry = archive.by_path.get(path);
    if (entry === undefined) throw new Error(`包内没有部件 ${path}`);
    const xml = Buffer.from(entry.data).toString('utf8');
    return { path, text: runText(xml) };
  });
}

function slideOrdinalOfPath(path: string): number {
  const match = /slide(\d+)\.xml$/.exec(path);
  if (match === null) throw new Error(`非法幻灯片部件名 ${path}`);
  return Number(match[1]) - 1;
}

/** 抓一段 slide XML 里所有 `<a:t>` 的文本（顺序拼接）。 */
function runText(xml: string): string {
  const out: string[] = [];
  for (const match of xml.matchAll(/<a:t>(.*?)<\/a:t>/gs)) out.push(match[1] ?? '');
  return out.join('');
}

function expectOk(outcome: SessionEditOutcome): Extract<SessionEditOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error(`期望成功，实得 ${JSON.stringify(outcome)}`);
  return outcome;
}

/** 一页一个文本框（shape_id=2，渲染要求 ≥2）。 */
function textBox(id: number, text: string): Shape {
  return {
    kind: 'text_box',
    shape_id: id,
    name: `Box ${String(id)}`,
    transform: transform(914400, 914400, 5486400, 914400),
    text: literalText(text),
  };
}

/** 三页演示，每页一段可辨识文字。返回文稿与三页 id（页序）。 */
function buildDeck(): { readonly deck: Presentation; readonly ids: readonly number[] } {
  let deck = emptyPresentation('deck1', '放映演示');
  const ids: number[] = [];
  for (const text of ['第一页', '第二页', '第三页']) {
    const added = addSlide(deck);
    deck = added.presentation;
    deck = addShape(deck, added.slide_id, textBox(2, text));
    ids.push(added.slide_id);
  }
  return { deck, ids };
}

/** 用会话建一份三页文稿（文字可辨识）。 */
function sessionWithThreeSlides(): {
  readonly session: ReturnType<typeof createPresentationSession>;
  readonly ids: readonly number[];
} {
  let session = createPresentationSession({ presentationId: 'p1', title: '汇报' });
  for (const title of ['第一页', '第二页', '第三页']) {
    session = expectOk(applySessionEdit(session, { op: 'add_slide', title }, session.revision)).session;
  }
  return { session, ids: sessionPresentation(session).slides.map((slide) => slide.slide_id) };
}

// ===========================================================================
// 一、稳定页键：保存 → 重开 → 再编辑落在同一逻辑页
// ===========================================================================

describe('P-I22 稳定页键：save→reopen 会重新编号，序号键仍落在同一逻辑页', () => {
  it('★ 重开把页号从 1/2/3 重新编号为 256/257/258（陷阱复现）', () => {
    const { session, ids } = sessionWithThreeSlides();
    expect(ids).toEqual([1, 2, 3]);

    const saved = saveSession(session);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const reopened = openSessionFromBytes(saved.record.bytes);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.session.source.imported).not.toBeNull();

    const reopenedIds = sessionPresentation(reopened.session).slides.map((slide) => slide.slide_id);
    expect(reopenedIds).toEqual([256, 257, 258]);
    // 保存前的 id 在重开的文稿里**一个都不存在** ⇒ 沿用旧 id 必然落空。
    for (const oldId of ids) {
      expect(reopenedIds).not.toContain(oldId);
      expect(findSlideOrdinal(sessionPresentation(reopened.session), oldId)).toBeNull();
    }
  });

  it('★ 序号稳定键：capture→save→reopen→resolve 命中同一逻辑页，并如实报告 id 漂移', () => {
    const { session, ids } = sessionWithThreeSlides();
    const before = sessionPresentation(session);

    // 当前页 = 第 2 页（保存前 id=2，序号=1）。
    expect(ids[1]).toBe(2);
    const ref = captureCurrentSlideRef(before, 2);
    expect(ref).toEqual({ ordinal: 1, persisted_slide_id: 2, slide_count: 3 });

    const saved = saveSession(session);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const reopened = openSessionFromBytes(saved.record.bytes);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;

    const resolved = resolveCurrentSlideRef(ref, sessionPresentation(reopened.session));
    expect(resolved.ordinal).toBe(1);
    expect(resolved.slide_id).toBe(257);
    expect(resolved.slide_id).toBe(slideIdAtOrdinal(sessionPresentation(reopened.session), 1));
    expect(resolved.persisted_slide_id).toBe(2);
    expect(resolved.id_changed).toBe(true);

    // 独立核对：保存字节的第 2 页确实是「第二页」。
    const beforePages = slidePages(saved.record.bytes);
    expect(beforePages).toHaveLength(3);
    expect(beforePages[1]!.text).toContain('第二页');
    expect(beforePages[0]!.text).toContain('第一页');
    expect(beforePages[2]!.text).toContain('第三页');
  });

  it('★ 再编辑落在同一逻辑页：改 resolved 页 → 再存 → 独立解包第 2 页变了、1/3 页未变', () => {
    const { session } = sessionWithThreeSlides();
    const ref = captureCurrentSlideRef(sessionPresentation(session), 2);
    const saved = saveSession(session);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const reopened = openSessionFromBytes(saved.record.bytes);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;

    const resolved = resolveCurrentSlideRef(ref, sessionPresentation(reopened.session));
    const edited = expectOk(
      applySessionEdit(
        reopened.session,
        { op: 'set_slide_title', slide_id: resolved.slide_id, text: '第二页（重开后改）' },
        reopened.session.revision,
      ),
    );
    const again = saveSession(edited.session);
    expect(again.ok).toBe(true);
    if (!again.ok) return;

    const pages = slidePages(again.record.bytes);
    expect(pages).toHaveLength(3);
    expect(pages[0]!.text).toContain('第一页');
    expect(pages[1]!.text).toContain('第二页（重开后改）');
    expect(pages[2]!.text).toContain('第三页');
    // 第 2 页的旧文字不再单独存在（确实是"改了这一页"，不是别页）。
    expect(pages[1]!.text.includes('第二页（重开后改）')).toBe(true);
    expect(pages[0]!.text.includes('重开后改')).toBe(false);
    expect(pages[2]!.text.includes('重开后改')).toBe(false);
  });

  it('★ 反向对照：沿用保存前的 slide_id 当键 ⇒ 重开后编辑被具名拒绝', () => {
    const { session } = sessionWithThreeSlides();
    const saved = saveSession(session);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const reopened = openSessionFromBytes(saved.record.bytes);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;

    const staleEdit = applySessionEdit(
      reopened.session,
      { op: 'set_slide_title', slide_id: 2, text: '用旧 id 改' },
      reopened.session.revision,
    );
    expect(staleEdit.ok).toBe(false);
    if (!staleEdit.ok) expect(staleEdit.status).toBe('rejected');
  });

  it('★ 反向对照：解析时页数变了 ⇒ 具名拒绝，不静默落到错页', () => {
    const { session } = sessionWithThreeSlides();
    const ref = captureCurrentSlideRef(sessionPresentation(session), 2);

    // 人为造一份 2 页文稿（与 ref 的 3 页不符）。
    const base = emptyPresentation('deck2', '两页');
    const one = addSlide(base).presentation;
    const two = addSlide(one).presentation;

    let caught: SlideCursorError | null = null;
    try {
      resolveCurrentSlideRef(ref, two);
    } catch (error) {
      caught = error as SlideCursorError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.name).toBe('SlideCursorError');
    expect(caught?.reason).toBe('slide_count_changed');
  });
});

// ===========================================================================
// 二、放映游标：消费 P-R05 playback.ts
// ===========================================================================

describe('P-I22 放映游标：消费 P-R05 放映会话，区分稳定序号与放映下标', () => {
  it('★ 隐藏页被过滤 ⇒ show_index 漂移，ordinal 仍是整份文稿的稳定页号', () => {
    const { deck, ids } = buildDeck();
    const withHidden = setSlideHidden(deck, ids[1]!, true);
    const show = startSession(withHidden, emptyAvMediaBoard(), DEFAULT_LANDSCAPE_VIEWPORT);

    // 页序 = 第 1、3 页（第 2 页隐藏被排除）。
    expect(show.order).toEqual([ids[0], ids[2]]);

    const head = playheadFromShow(show);
    expect(head.ordinal).toBe(0);
    expect(head.show_index).toBe(0);
    expect(head.showed_slide_id).toBe(ids[0]);
    expect(head.slide_count).toBe(3);

    const moved = nextSlide(show);
    expect(moved.current_slide_id).toBe(ids[2]);
    const head2 = playheadFromShow(moved);
    // 放映下标是 1（第 2 个被放的页），稳定序号是 2（整份文稿第 3 页）——两者不同。
    expect(head2.show_index).toBe(1);
    expect(head2.ordinal).toBe(2);
    expect(head2.showed_slide_id).toBe(ids[2]);
  });

  it('★ 游标跨 save→reopen：解析到重开后的 id（id 漂移，序号不变）', () => {
    const { deck, ids } = buildDeck();
    const show = startSession(deck, emptyAvMediaBoard(), DEFAULT_LANDSCAPE_VIEWPORT);
    const head = playheadFromShow(nextSlide(nextSlide(show))); // 第 3 页
    expect(head.ordinal).toBe(2);
    expect(head.showed_slide_id).toBe(ids[2]);

    // 真字节往返：render → import（P-R05 的导回验收，独立于本层）。
    const roundTrip = verifyPresentationRoundTrip(show);
    expect(roundTrip.ids_stable).toBe(false);
    expect(roundTrip.reopened_order).toEqual([256, 257, 258]);

    const ref = playheadToSlideRef(head);
    expect(ref).toEqual({ ordinal: 2, persisted_slide_id: ids[2], slide_count: 3 });

    const entry = roundTrip.id_map[2]!;
    expect(entry.presented_id).toBe(ids[2]);
    expect(entry.reopened_id).toBe(258);
  });

  it('★ 消费链闭合：resolvePlayhead 在真往返重开文稿上命中同一逻辑页', () => {
    const { deck, ids } = buildDeck();
    const show = startSession(deck, emptyAvMediaBoard(), DEFAULT_LANDSCAPE_VIEWPORT);
    const head = playheadFromShow(nextSlide(show)); // 第 2 页
    expect(head.ordinal).toBe(1);

    // render → import：独立重开一份文稿（真字节）。
    const bytes = renderPresentation(deck).bytes;
    const reopened = importPresentation(bytes).presentation;
    const resolved = resolvePlayhead(head, reopened);
    expect(resolved.ordinal).toBe(1);
    expect(resolved.slide_id).toBe(257);
    expect(resolved.persisted_slide_id).toBe(ids[1]);
    expect(resolved.id_changed).toBe(true);
  });

  it('★ 反向对照：放映会话没有当前页 ⇒ 具名 no_current_slide', () => {
    const { deck } = buildDeck();
    let caught: SlideCursorError | null = null;
    try {
      playheadFromShow({ deck, order: [], index: 0, current_slide_id: null });
    } catch (error) {
      caught = error as SlideCursorError;
    }
    expect(caught?.reason).toBe('no_current_slide');
  });

  it('★ 反向对照：当前页不在文稿里 ⇒ 具名 current_slide_not_in_deck', () => {
    const { deck } = buildDeck();
    let caught: SlideCursorError | null = null;
    try {
      playheadFromShow({ deck, order: [999], index: 0, current_slide_id: 999 });
    } catch (error) {
      caught = error as SlideCursorError;
    }
    expect(caught?.reason).toBe('current_slide_not_in_deck');
  });
});

// ===========================================================================
// 三、自注册描述符：一个清单解析 session 与 rendering 两个入口
// ===========================================================================

describe('P-I22 自注册描述符：无需深路径即可取到 session 与 rendering 入口', () => {
  it('★ 描述符同时解析 session 与 rendering，且 api 是真实导出（恒等 ===）', () => {
    const registry = PRESENTATIONS_PLUGIN_REGISTRATION;
    expect(registry.plugin_id).toBe(PRESENTATIONS_PLUGIN_ID);
    expect(registry.version).toBe(PRESENTATIONS_PLUGIN_VERSION);

    const sessionSurface = resolveSurface('session', registry);
    const renderingSurface = resolveSurface('rendering', registry);

    expect(Object.keys(sessionSurface.api).length).toBeGreaterThan(0);
    expect(Object.isFrozen(sessionSurface.api)).toBe(true);
    expect(sessionSurface.module_specifier).toBe('src/mobile-plugins/presentations/session/index.js');
    expect(sessionSurface.capabilities).toContain('stable_slide_cursor');

    // 恒等：描述符指向的就是测试自己 import 的真入口，不是拷贝品。
    expect(sessionSurface.api['createPresentationSession']).toBe(createPresentationSession);
    expect(sessionSurface.api['saveSession']).toBe(saveSession);
    expect(sessionSurface.api['openSessionFromBytes']).toBe(openSessionFromBytes);
    expect(sessionSurface.api['captureCurrentSlideRef']).toBe(captureCurrentSlideRef);
    expect(sessionSurface.api['resolvePlayhead']).toBe(resolvePlayhead);
    expect(sessionSurface.api['playheadFromShow']).toBe(playheadFromShow);

    expect(typeof renderingSurface.api['renderSlideToPng']).toBe('function');
    expect(renderingSurface.api['renderSlideToPng']).toBe(renderSlideToPng);
    expect(renderingSurface.api['renderPresentationToPngs']).toBe(renderPresentationToPngs);
    expect(renderingSurface.module_specifier).toBe('src/mobile-plugins/presentations/rendering/index.js');
    expect(renderingSurface.capabilities).toContain('raster_png');
  });

  it('★ 反向对照：未知入口 ⇒ 具名 unknown_surface（不返回 undefined）', () => {
    let caught: PresentationRegistryError | null = null;
    try {
      resolveSurface('nope' as PresentationSurfaceName);
    } catch (error) {
      caught = error as PresentationRegistryError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.name).toBe('PresentationRegistryError');
    expect(caught?.reason).toBe('unknown_surface');

    let emptyName: PresentationRegistryError | null = null;
    try {
      resolveSurface('' as PresentationSurfaceName);
    } catch (error) {
      emptyName = error as PresentationRegistryError;
    }
    expect(emptyName?.reason).toBe('unknown_surface');
  });

  it('★ 反向对照：重复登记被拒；空 api 的描述符被拒', () => {
    const registry = PRESENTATIONS_PLUGIN_REGISTRATION;
    let dup: PresentationRegistryError | null = null;
    try {
      registerSurface(registry, resolveSurface('session', registry));
    } catch (error) {
      dup = error as PresentationRegistryError;
    }
    expect(dup?.reason).toBe('duplicate_surface');

    let bad: PresentationRegistryError | null = null;
    try {
      makeSurfaceDescriptor({ name: 'session', module_specifier: 'x.js', capabilities: ['a'], api: {} });
    } catch (error) {
      bad = error as PresentationRegistryError;
    }
    expect(bad?.reason).toBe('invalid_surface_name');
  });

  it('★ 注册表不可变：追加登记返回新表，原表一字不动', () => {
    const base: PresentationPluginRegistry = { plugin_id: 'probe', version: '0', surfaces: [] };
    const sessionDescriptor = makeSurfaceDescriptor({
      name: 'session',
      module_specifier: 'probe/session.js',
      capabilities: ['probe'],
      api: { noop: () => undefined },
    });
    const extended = registerSurface(base, sessionDescriptor);
    expect(extended.surfaces).toHaveLength(1);
    expect(base.surfaces).toHaveLength(0); // 原表未变
    expect(extended.surfaces[0]!.name).toBe('session');

    // 默认注册表也保持两个具名入口、冻结。
    expect(PRESENTATIONS_PLUGIN_REGISTRATION.surfaces.map((s) => s.name)).toEqual(['session', 'rendering']);
    expect(Object.isFrozen(PRESENTATIONS_PLUGIN_REGISTRATION.surfaces)).toBe(true);
  });
});

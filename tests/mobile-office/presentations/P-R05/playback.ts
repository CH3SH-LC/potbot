/**
 * P-R05 · 手机**放映 / 音视频播放 / 方向变化 / 导回验收**（备用包，独立模块）。
 *
 * ## 这一层解决什么
 *
 * `src/presentations/` 已能建模型、渲染 PPTX、交接放映、产出音视频受控引用。但"在**手机上真的放
 * 一次**"这条消费链没有宿主：谁按页序走、隐藏页跳不跳、切页时音视频何时起停、手机横竖屏翻转后
 * 版面怎么摆、翻完还能不能接着放。本模块把这条链做成一个**纯函数、零墙钟、零 IO** 的会话状态机，
 * 供 P09 的放映宿主 / 手机放映端接线。
 *
 * 本模块**只消费**既有模块的公开出口，不复制它们的判定：
 * - 页序与隐藏页过滤复用 `planSlideshow`（`export-handoff.ts`）；
 * - 音视频项目录复用 `AvMediaBoard` / `AvMediaItem` / `avMediaItemsForSlide`（`av-media.ts`）；
 * - 导回（保存 → 重开）复用 `renderPresentation` + `importPresentation`（`render.ts` / `roundtrip.ts`）。
 *
 * ## 三条纪律（本模块的核心）
 *
 * 1. **不虚构时长**。播放位置只有在调用方给出**真实时长**（`media_durations_ms`）或**裁剪终点**
 *    （`trim_end_ms`）时才能判定"播完"。两者都没有时，本层**绝不**把"放了一会儿"说成"已播完"：
 *    `AvPlaybackState.effective_end_ms === null` 且 `duration_known === false`，状态停在 `playing`。
 * 2. **方向变化不改放映事实**。{@link changeOrientation} 只重算视口与 `FitResult`（含黑边 / 裁切），
 *    **当前页、页内位置、已播时长、全部音视频状态逐字保留**——翻转屏幕不是"重新开始放映"。
 * 3. **导回验的是"放过的那份"**。{@link verifyPresentationRoundTrip} 走**真字节**：
 *    `renderPresentation → importPresentation`，再断言重开后 {@link planSlideshow} 的**有序页集**
 *    与放映时的页集**按页序位置**一致、每页切换（transition）也还在。不等就具名报错，不静默。
 * 4. **`slide_id` 不是跨保存的稳定键（实测）**。渲染后重新导入会把页面**重新编号**（256 起），
 *    因此 {@link verifyPresentationRoundTrip} **按页序位置**比对，并把编号是否变化如实写进
 *    `ids_stable` / `id_map`；手机端要持久化"当前页"必须存重开后的 id，不能沿用旧 id。
 *
 * ## 未验证 / 边界（如实登记，见 {@link PLAYBACK_UNVERIFIED_CLAIMS}）
 *
 * - **真机播放未验证**：本层是确定性的逻辑状态机，没有接任何 `SurfaceView` / `MediaPlayer` /
 *   `ExoPlayer`，也没有真机 `MediaPlayer` 回执。`renderAvMediaTimingXml` 产出的 `p:timing` 只在
 *   用例里被字符串断言，**未在任何播放器实测**。
 * - **栅格化 / 像素未验证**：`FitResult` 是**几何**（缩放、黑边、裁切），不是像素。本层不渲染，
 *   不声称"看起来对"。
 * - **自动换页未建模**：`SlideTransition` 只有 `kind` + `duration_ms`，没有"停留 N 毫秒自动翻页"
 *   的字段，故本层放映是**点击驱动**的；`advance_session` 只推进页内时间与音视频，不自动换页。
 * - **音频时长未知**：无解码器，`media_durations_ms` 一律由消费端注入，本层不猜。
 */

import { ValidationError } from '../../../../src/protocol/index.js';

import {
  buildPresentationPreview,
  planSlideshow,
  type SlideRange,
  type SlideshowPlan,
} from '../../../../src/presentations/export-handoff.js';
import {
  avMediaItemsForSlide,
  type AvMediaBoard,
  type AvMediaItem,
  type AvMediaKind,
} from '../../../../src/presentations/av-media.js';
import {
  SLIDE_SIZE_16_9,
  type Presentation,
  type Slide,
  type SlideSize,
} from '../../../../src/presentations/model.js';
import { renderPresentation } from '../../../../src/presentations/render.js';
import { importPresentation } from '../../../../src/presentations/roundtrip.js';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 放映 / 播放层失败原因（具名，供用例断言与上层分类）。 */
export type PlaybackErrorReason =
  | 'empty_order'
  | 'invalid_viewport'
  | 'viewport_orientation_mismatch'
  | 'invalid_orientation'
  | 'wrong_state'
  | 'slide_not_in_show'
  | 'index_out_of_range'
  | 'unknown_media'
  | 'media_not_on_current_slide'
  | 'invalid_position'
  | 'roundtrip_order_mismatch'
  | 'roundtrip_transition_mismatch';

/** 放映层错误：语义不成立时抛出，**不静默降级**。 */
export class PlaybackError extends ValidationError {
  readonly reason: PlaybackErrorReason;

  constructor(reason: PlaybackErrorReason, message: string) {
    super(message);
    this.name = 'PlaybackError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 一、方向与适配（几何级，不是像素级）
// ---------------------------------------------------------------------------

/** 手机表面方向。 */
export type SurfaceOrientation = 'portrait' | 'landscape';

/** 适配策略：`contain` = 整页可见、有黑边；`cover` = 铺满、裁切。 */
export type FitPolicy = 'contain' | 'cover';

/** 一个手机视口（像素 + 方向）。 */
export interface Viewport {
  readonly width_px: number;
  readonly height_px: number;
  readonly orientation: SurfaceOrientation;
}

/** 由视口尺寸推出方向（宽 < 高 ⇒ 竖屏）。 */
export function orientationOfViewport(viewport: Viewport): SurfaceOrientation {
  return viewport.height_px >= viewport.width_px ? 'portrait' : 'landscape';
}

/** 幻灯片本身的方向（横版 16:9 / 4:3 都是 `landscape`）。 */
export function orientationOfSlideSize(size: SlideSize): SurfaceOrientation {
  return size.cx_emu >= size.cy_emu ? 'landscape' : 'portrait';
}

/** 适配结果（几何）。`aspect_preserved` 恒为 `true`——绝不拉伸。 */
export interface FitResult {
  readonly policy: FitPolicy;
  /** 每 EMU 折合多少像素（> 0）。 */
  readonly scale: number;
  readonly display_width_px: number;
  readonly display_height_px: number;
  /** 内容左上角在视口里的偏移（`cover` 时为负 = 被裁掉的部分）。 */
  readonly offset_x_px: number;
  readonly offset_y_px: number;
  /** 未覆盖面积（px²）：`contain` ≥ 0（黑边），`cover` ≤ 0（裁切量）。 */
  readonly letterbox_px2: number;
  /** 整页是否完全可见：`contain` 恒 `true`；`cover` 仅当长宽比相同。 */
  readonly content_fully_visible: boolean;
  /** 不拉伸：内容长宽比与幻灯片长宽比一致。 */
  readonly aspect_preserved: true;
  readonly slide_orientation: SurfaceOrientation;
}

function assertViewport(viewport: Viewport): void {
  if (
    !Number.isFinite(viewport.width_px) ||
    !Number.isFinite(viewport.height_px) ||
    viewport.width_px <= 0 ||
    viewport.height_px <= 0
  ) {
    throw new PlaybackError('invalid_viewport', `视口尺寸必须是正数，收到 ${viewport.width_px}×${viewport.height_px}`);
  }
  if (viewport.orientation !== 'portrait' && viewport.orientation !== 'landscape') {
    throw new PlaybackError('invalid_orientation', `未知方向 ${String(viewport.orientation)}`);
  }
  if (viewport.orientation !== orientationOfViewport(viewport)) {
    throw new PlaybackError(
      'viewport_orientation_mismatch',
      `方向 ${viewport.orientation} 与尺寸 ${viewport.width_px}×${viewport.height_px} 不符（宽 < 高应为 portrait）`,
    );
  }
}

/**
 * 把一页幻灯片适配进手机视口（`contain` 默认）。**只算几何，不栅格化**。
 *
 * 缩放比例 = 视口 / 幻灯片（EMU），`contain` 取两轴较小者、`cover` 取较大者；
 * 长宽比由单一 `scale` 保证不变。
 */
export function fitSlideshow(
  slideSize: SlideSize,
  viewport: Viewport,
  policy: FitPolicy = 'contain',
): FitResult {
  assertViewport(viewport);
  if (!(slideSize.cx_emu > 0) || !(slideSize.cy_emu > 0)) {
    throw new PlaybackError('invalid_viewport', `幻灯片尺寸必须是正数`);
  }
  if (policy !== 'contain' && policy !== 'cover') {
    throw new PlaybackError('invalid_viewport', `未知适配策略 ${String(policy)}`);
  }
  const scaleX = viewport.width_px / slideSize.cx_emu;
  const scaleY = viewport.height_px / slideSize.cy_emu;
  const scale = policy === 'contain' ? Math.min(scaleX, scaleY) : Math.max(scaleX, scaleY);
  const displayWidth = slideSize.cx_emu * scale;
  const displayHeight = slideSize.cy_emu * scale;
  const viewportArea = viewport.width_px * viewport.height_px;
  const contentArea = displayWidth * displayHeight;
  const ratioEqual = Math.abs(scaleX - scaleY) <= Math.max(scaleX, scaleY) * 1e-12;
  return Object.freeze({
    policy,
    scale,
    display_width_px: displayWidth,
    display_height_px: displayHeight,
    offset_x_px: (viewport.width_px - displayWidth) / 2,
    offset_y_px: (viewport.height_px - displayHeight) / 2,
    letterbox_px2: viewportArea - contentArea,
    content_fully_visible: policy === 'contain' || ratioEqual,
    aspect_preserved: true as const,
    slide_orientation: orientationOfSlideSize(slideSize),
  });
}

// ---------------------------------------------------------------------------
// 二、音视频播放状态机（每项一个）
// ---------------------------------------------------------------------------

/** 单个音视频项的播放状态。 */
export type AvPlayState = 'idle' | 'playing' | 'paused' | 'stopped' | 'ended';

/** 一项音视频的播放状态（确定性快照，无墙钟）。 */
export interface AvPlaybackState {
  readonly media_id: string;
  readonly kind: AvMediaKind;
  readonly state: AvPlayState;
  /** 当前播放位置（毫秒，已按裁剪区间夹取）。 */
  readonly position_ms: number;
  /** 完整播完的次数（循环计数）。 */
  readonly loops_completed: number;
  readonly muted: boolean;
  readonly volume: number;
  /** 有效起点 = 裁剪起点。 */
  readonly effective_start_ms: number;
  /** 有效终点：裁剪终点；或真实时长；两者都无 ⇒ `null`（**不知道何时完**）。 */
  readonly effective_end_ms: number | null;
  /** 是否知道时长（决定能否判定"已播完"）。 */
  readonly duration_known: boolean;
  /** 是否曾经开始播放过（用于区分 `idle` 与 `stopped`）。 */
  readonly ever_started: boolean;
}

/** 有效终点：优先裁剪终点，其次真实时长（由消费端注入）；都没有 ⇒ `null`。 */
function effectiveEndOf(item: AvMediaItem, durations: Readonly<Record<string, number>>): number | null {
  if (item.playback.trim_end_ms !== null) return item.playback.trim_end_ms;
  const duration = durations[item.media_id];
  return typeof duration === 'number' && Number.isFinite(duration) ? duration : null;
}

/** 一项的初始（`idle`）播放状态。 */
export function initialAvState(
  item: AvMediaItem,
  durations: Readonly<Record<string, number>> = {},
): AvPlaybackState {
  const end = effectiveEndOf(item, durations);
  return Object.freeze({
    media_id: item.media_id,
    kind: item.kind,
    state: 'idle' as const,
    position_ms: item.playback.trim_start_ms,
    loops_completed: 0,
    muted: item.playback.muted,
    volume: item.playback.volume,
    effective_start_ms: item.playback.trim_start_ms,
    effective_end_ms: end,
    duration_known: end !== null,
    ever_started: false,
  });
}

/** 位置夹取到 `[start, end]`（`end` 为 `null` 时只保下界）。 */
function clampPosition(state: AvPlaybackState, positionMs: number): number {
  const lower = state.effective_start_ms;
  if (positionMs < lower) return lower;
  if (state.effective_end_ms !== null && positionMs > state.effective_end_ms) return state.effective_end_ms;
  return positionMs;
}

/** 暂停：仅 `playing` 可暂停。 */
export function pauseAv(state: AvPlaybackState): AvPlaybackState {
  if (state.state !== 'playing') return state;
  return Object.freeze({ ...state, state: 'paused' as const });
}

/** 恢复：仅 `paused` 可恢复。 */
export function resumeAv(state: AvPlaybackState): AvPlaybackState {
  if (state.state !== 'paused') return state;
  return Object.freeze({ ...state, state: 'playing' as const });
}

/**
 * 推进一项的时间 `deltaMs`（毫秒，≥ 0）。只在 `playing` 且 `deltaMs > 0` 时变化。
 *
 * 到有效终点时：`loop` ⇒ 回绕到起点并 +1 次循环；否则 ⇒ `ended`（且**仅当** `duration_known`）。
 * 时长未知（`effective_end_ms === null`）⇒ 位置继续增长、状态停在 `playing`，**不谎报播完**。
 */
export function advanceAv(
  state: AvPlaybackState,
  item: AvMediaItem,
  deltaMs: number,
): AvPlaybackState {
  if (state.state !== 'playing' || deltaMs <= 0) return state;
  const end = state.effective_end_ms;
  let position = state.position_ms + deltaMs;
  if (end === null) {
    return Object.freeze({ ...state, position_ms: position });
  }
  if (position < end) {
    return Object.freeze({ ...state, position_ms: position });
  }
  if (item.playback.loop) {
    const span = end - state.effective_start_ms;
    if (span <= 0) {
      return Object.freeze({ ...state, position_ms: state.effective_start_ms, loops_completed: state.loops_completed + 1 });
    }
    const overshoot = (position - state.effective_start_ms) % span;
    return Object.freeze({
      ...state,
      state: 'playing' as const,
      position_ms: state.effective_start_ms + overshoot,
      loops_completed: state.loops_completed + 1,
    });
  }
  return Object.freeze({ ...state, state: 'ended' as const, position_ms: end });
}

// ---------------------------------------------------------------------------
// 三、放映会话
// ---------------------------------------------------------------------------

/** 放映会话状态。 */
export type PlaybackState = 'idle' | 'running' | 'paused' | 'ended';

/** 会话选项。 */
export interface PlaybackOptions {
  readonly fit_policy?: FitPolicy;
  readonly include_hidden?: boolean;
  readonly slide_range?: SlideRange | null;
  /** 真实时长表（消费端注入）。缺项 = 时长未知。 */
  readonly media_durations_ms?: Readonly<Record<string, number>>;
  /** 起步即暂停（默认从第 1 页开始播放）。 */
  readonly start_paused?: boolean;
}

/** 一次放映会话（不可变值对象；持有 deck / board 引用以便取切换与音视频）。 */
export interface SlideshowSession {
  readonly deck: Presentation;
  readonly board: AvMediaBoard;
  readonly state: PlaybackState;
  /** 实际会放的页（**有序**，已按范围与隐藏页过滤）。 */
  readonly order: readonly number[];
  readonly excluded_hidden: readonly number[];
  readonly index: number;
  readonly current_slide_id: number | null;
  /** 当前页内的位置（毫秒）。 */
  readonly position_ms: number;
  /** 本次会话累计已放时长（毫秒）。 */
  readonly elapsed_total_ms: number;
  readonly transition_kind: string | null;
  readonly transition_duration_ms: number;
  readonly av: readonly AvPlaybackState[];
  readonly viewport: Viewport;
  readonly fit: FitResult;
  readonly durations: Readonly<Record<string, number>>;
  readonly fit_policy: FitPolicy;
  readonly include_hidden: boolean;
  readonly slide_range: SlideRange | null;
}

function requireSlide(session: SlideshowSession, slideId: number): Slide {
  const slide = session.deck.slides.find((candidate) => candidate.slide_id === slideId);
  if (slide === undefined) {
    throw new PlaybackError('slide_not_in_show', `文稿里没有 slide_id=${String(slideId)}`);
  }
  return slide;
}

function transitionOf(deck: Presentation, slideId: number): {
  kind: string | null;
  duration_ms: number;
} {
  const slide = deck.slides.find((candidate) => candidate.slide_id === slideId);
  if (slide === undefined) {
    throw new PlaybackError('slide_not_in_show', `文稿里没有 slide_id=${String(slideId)}`);
  }
  return slide.transition === null
    ? { kind: null, duration_ms: 0 }
    : { kind: slide.transition.kind, duration_ms: slide.transition.duration_ms };
}

/**
 * 把音视频状态对齐到"当前页"：当前页的项按 `autoplay` 起播（或待命），**其它页的项一律停**。
 * 这是切页的唯一入口，也是"切页不串音"的判据。
 */
function syncAvToSlide(
  board: AvMediaBoard,
  durations: Readonly<Record<string, number>>,
  av: readonly AvPlaybackState[],
  slideId: number,
): readonly AvPlaybackState[] {
  const onSlide = new Map(
    avMediaItemsForSlide(board, slideId).map((item) => [item.media_id, item] as const),
  );
  return Object.freeze(
    board.items.map((item) => {
      const current = av.find((state) => state.media_id === item.media_id) ?? initialAvState(item, durations);
      const target = onSlide.get(item.media_id);
      if (target === undefined) {
        // 不在当前页：已起播过的收成 stopped，没起播的保持 idle；位置归零。
        return Object.freeze({
          ...current,
          state: current.ever_started ? ('stopped' as const) : ('idle' as const),
          position_ms: item.playback.trim_start_ms,
        });
      }
      if (item.playback.autoplay) {
        return Object.freeze({
          ...current,
          state: 'playing' as const,
          position_ms: current.ever_started ? current.position_ms : item.playback.trim_start_ms,
          ever_started: true,
        });
      }
      return Object.freeze({
        ...current,
        state: current.state === 'playing' || current.state === 'paused' ? current.state : ('idle' as const),
      });
    }),
  );
}

/**
 * 开一次放映。页序/隐藏页过滤走 `planSlideshow`（真实现，不重造）。
 *
 * @throws {PlaybackError} 无页可放（`empty_order`）。
 */
export function startSession(
  deck: Presentation,
  board: AvMediaBoard,
  viewport: Viewport,
  options: PlaybackOptions = {},
): SlideshowSession {
  const fitPolicy = options.fit_policy ?? 'contain';
  const includeHidden = options.include_hidden ?? false;
  const slideRange = options.slide_range ?? null;
  const durations = Object.freeze({ ...(options.media_durations_ms ?? {}) });

  const preview = buildPresentationPreview(deck);
  const plan: SlideshowPlan = planSlideshow(preview, {
    slide_range: slideRange,
    include_hidden: includeHidden,
  });
  if (plan.slide_ids.length === 0) {
    throw new PlaybackError('empty_order', '放映计划为空：没有可放的页（全部被过滤或文稿无页）');
  }
  const fit = fitSlideshow(deck.size, viewport, fitPolicy);
  const currentSlideId = plan.slide_ids[0]!;
  const transition = transitionOf(deck, currentSlideId);

  const base = {
    deck,
    board,
    state: (options.start_paused === true ? 'paused' : 'running') as PlaybackState,
    order: Object.freeze([...plan.slide_ids]),
    excluded_hidden: Object.freeze([...plan.excluded_hidden]),
    index: 0,
    current_slide_id: currentSlideId,
    position_ms: 0,
    elapsed_total_ms: 0,
    av: Object.freeze(
      board.items.map((item) => initialAvState(item, durations)),
    ),
    viewport,
    fit,
    durations,
    fit_policy: fitPolicy,
    include_hidden: includeHidden,
    slide_range: slideRange,
  } satisfies Omit<SlideshowSession, 'transition_kind' | 'transition_duration_ms'>;

  const av = syncAvToSlide(board, durations, base.av, currentSlideId);
  return Object.freeze({
    ...base,
    transition_kind: transition.kind,
    transition_duration_ms: transition.duration_ms,
    av,
  });
}

/** 切到 `order` 的下标 `index`（内部用；不校验，调用方先校验）。 */
function withOrderIndex(session: SlideshowSession, index: number, state: PlaybackState): SlideshowSession {
  const slideId = session.order[index];
  if (slideId === undefined) {
    throw new PlaybackError('index_out_of_range', `页序下标 ${String(index)} 越界（共 ${String(session.order.length)} 页）`);
  }
  const transition = transitionOf(session.deck, slideId);
  const av = syncAvToSlide(session.board, session.durations, session.av, slideId);
  return Object.freeze({
    ...session,
    state,
    index,
    current_slide_id: slideId,
    position_ms: 0,
    transition_kind: transition.kind,
    transition_duration_ms: transition.duration_ms,
    av,
  });
}

/** 下一页（到末页后再 next ⇒ `ended`，当前页保持在末页）。 */
export function nextSlide(session: SlideshowSession): SlideshowSession {
  if (session.state === 'ended') return session;
  if (session.index >= session.order.length - 1) {
    return Object.freeze({ ...session, state: 'ended' as const });
  }
  return withOrderIndex(session, session.index + 1, session.state === 'paused' ? 'paused' : 'running');
}

/** 上一页（首页再 prev ⇒ 无操作）。 */
export function prevSlide(session: SlideshowSession): SlideshowSession {
  if (session.index <= 0) return session;
  return withOrderIndex(session, session.index - 1, session.state === 'paused' ? 'paused' : 'running');
}

/** 按页序下标跳转。 */
export function gotoIndex(session: SlideshowSession, index: number): SlideshowSession {
  if (!Number.isInteger(index) || index < 0 || index >= session.order.length) {
    throw new PlaybackError('index_out_of_range', `页序下标 ${String(index)} 越界（共 ${String(session.order.length)} 页）`);
  }
  return withOrderIndex(session, index, session.state === 'ended' ? 'running' : session.state);
}

/** 按 slide_id 跳转；不在放映页集里 ⇒ `slide_not_in_show`（隐藏页默认不在）。 */
export function gotoSlide(session: SlideshowSession, slideId: number): SlideshowSession {
  const index = session.order.indexOf(slideId);
  if (index < 0) {
    throw new PlaybackError(
      'slide_not_in_show',
      `slide_id=${String(slideId)} 不在本次放映页集里（可能被隐藏或超出范围）`,
    );
  }
  return gotoIndex(session, index);
}

/** 暂停放映（`running` → `paused`）；非运行态 ⇒ `wrong_state`。 */
export function pauseSession(session: SlideshowSession): SlideshowSession {
  if (session.state !== 'running') {
    throw new PlaybackError('wrong_state', `只有 running 能暂停，当前是 ${session.state}`);
  }
  return Object.freeze({
    ...session,
    state: 'paused' as const,
    av: Object.freeze(session.av.map((state) => pauseAv(state))),
  });
}

/** 恢复放映（`paused` → `running`）。 */
export function resumeSession(session: SlideshowSession): SlideshowSession {
  if (session.state !== 'paused') {
    throw new PlaybackError('wrong_state', `只有 paused 能恢复，当前是 ${session.state}`);
  }
  return Object.freeze({
    ...session,
    state: 'running' as const,
    av: Object.freeze(session.av.map((state) => resumeAv(state))),
  });
}

/** 停止并复位到第 1 页（`idle`）。 */
export function stopSession(session: SlideshowSession): SlideshowSession {
  const slideId = session.order[0]!;
  const transition = transitionOf(session.deck, slideId);
  const reset = {
    ...session,
    state: 'idle' as const,
    index: 0,
    current_slide_id: slideId,
    position_ms: 0,
    elapsed_total_ms: 0,
    transition_kind: transition.kind,
    transition_duration_ms: transition.duration_ms,
    av: Object.freeze(session.board.items.map((item) => initialAvState(item, session.durations))),
  } satisfies SlideshowSession;
  return Object.freeze(reset);
}

/**
 * 推进会话 `deltaMs`。**暂停 / 空闲 / 已结束时时间冻结**（返回同一对象）。
 * 只推进页内时间与音视频位置，**不自动换页**（切换无 auto-advance 字段）。
 */
export function advanceSession(session: SlideshowSession, deltaMs: number): SlideshowSession {
  if (session.state !== 'running' || deltaMs <= 0) return session;
  const itemsById = new Map(session.board.items.map((item) => [item.media_id, item] as const));
  const av = session.av.map((state) => {
    const item = itemsById.get(state.media_id);
    return item === undefined ? state : advanceAv(state, item, deltaMs);
  });
  return Object.freeze({
    ...session,
    position_ms: session.position_ms + deltaMs,
    elapsed_total_ms: session.elapsed_total_ms + deltaMs,
    av: Object.freeze(av),
  });
}

/** 手动起播当前页的一项音视频（`autoplay=false` 的项）。 */
export function playMedia(session: SlideshowSession, mediaId: string): SlideshowSession {
  const item = session.board.items.find((candidate) => candidate.media_id === mediaId);
  if (item === undefined) {
    throw new PlaybackError('unknown_media', `旁表里没有 media_id=${mediaId}`);
  }
  if (item.slide_id !== session.current_slide_id) {
    throw new PlaybackError(
      'media_not_on_current_slide',
      `media_id=${mediaId} 属于 slide_id=${String(item.slide_id)}，不是当前页 ${String(session.current_slide_id)}`,
    );
  }
  return Object.freeze({
    ...session,
    av: Object.freeze(
      session.av.map((state) =>
        state.media_id === mediaId
          ? Object.freeze({ ...state, state: 'playing' as const, ever_started: true })
          : state,
      ),
    ),
  });
}

/** 暂停当前页的一项音视频（`playing` → `paused`）。 */
export function pauseMedia(session: SlideshowSession, mediaId: string): SlideshowSession {
  return Object.freeze({
    ...session,
    av: Object.freeze(
      session.av.map((state) => (state.media_id === mediaId ? pauseAv(state) : state)),
    ),
  });
}

/** 恢复当前页的一项音视频（`paused` → `playing`）。 */
export function resumeMedia(session: SlideshowSession, mediaId: string): SlideshowSession {
  return Object.freeze({
    ...session,
    av: Object.freeze(
      session.av.map((state) => (state.media_id === mediaId ? resumeAv(state) : state)),
    ),
  });
}

/** 跳转到一项的某个位置（夹取到裁剪区间）；位置非法 ⇒ `invalid_position`。 */
export function seekMedia(session: SlideshowSession, mediaId: string, positionMs: number): SlideshowSession {
  if (!Number.isFinite(positionMs) || positionMs < 0) {
    throw new PlaybackError('invalid_position', `位置必须是非负有限数，收到 ${String(positionMs)}`);
  }
  return Object.freeze({
    ...session,
    av: Object.freeze(
      session.av.map((state) =>
        state.media_id === mediaId ? Object.freeze({ ...state, position_ms: clampPosition(state, positionMs) }) : state,
      ),
    ),
  });
}

// ---------------------------------------------------------------------------
// 四、方向变化（不改放映事实）
// ---------------------------------------------------------------------------

/**
 * 换视口 / 转屏：**只**重算 `viewport` 与 `fit`。
 *
 * 显式不变式（用例逐条断言）：`order / index / current_slide_id / position_ms /
 * elapsed_total_ms / state / av` **逐字保留**。翻转屏幕不是重新开始。
 *
 * @throws {PlaybackError} 视口非法（尺寸非正、方向与尺寸不符）。
 */
export function changeOrientation(session: SlideshowSession, viewport: Viewport): SlideshowSession {
  const fit = fitSlideshow(session.deck.size, viewport, session.fit_policy);
  return Object.freeze({ ...session, viewport, fit });
}

// ---------------------------------------------------------------------------
// 五、导回验收（真字节往返）
// ---------------------------------------------------------------------------

/** 会话快照（可序列化，用于"方向变化前后 / 导回前后"的逐项比对）。 */
export interface SessionSnapshot {
  readonly deck_id: string;
  readonly state: PlaybackState;
  readonly order: readonly number[];
  readonly index: number;
  readonly current_slide_id: number | null;
  readonly position_ms: number;
  readonly elapsed_total_ms: number;
  readonly orientation: SurfaceOrientation;
  readonly fit_policy: FitPolicy;
  readonly av: readonly {
    readonly media_id: string;
    readonly state: AvPlayState;
    readonly position_ms: number;
    readonly loops_completed: number;
    readonly muted: boolean;
    readonly volume: number;
    readonly effective_start_ms: number;
    readonly effective_end_ms: number | null;
  }[];
}

/** 取一份只含"放映事实"的快照（**不含**几何：方向变化会改几何，但事实必须不变）。 */
export function sessionSnapshot(session: SlideshowSession): SessionSnapshot {
  return Object.freeze({
    deck_id: session.deck.presentation_id,
    state: session.state,
    order: Object.freeze([...session.order]),
    index: session.index,
    current_slide_id: session.current_slide_id,
    position_ms: session.position_ms,
    elapsed_total_ms: session.elapsed_total_ms,
    orientation: session.viewport.orientation,
    fit_policy: session.fit_policy,
    av: Object.freeze(
      session.av.map((state) =>
        Object.freeze({
          media_id: state.media_id,
          state: state.state,
          position_ms: state.position_ms,
          loops_completed: state.loops_completed,
          muted: state.muted,
          volume: state.volume,
          effective_start_ms: state.effective_start_ms,
          effective_end_ms: state.effective_end_ms,
        }),
      ),
    ),
  });
}

/** 忽略方向 / 几何的"放映事实"比对：返回不一致字段名（空数组 = 一致）。 */
export function diffSessionFacts(a: SessionSnapshot, b: SessionSnapshot): readonly string[] {
  const changes: string[] = [];
  if (a.deck_id !== b.deck_id) changes.push('deck_id');
  if (a.state !== b.state) changes.push('state');
  if (a.index !== b.index) changes.push('index');
  if (a.current_slide_id !== b.current_slide_id) changes.push('current_slide_id');
  if (a.position_ms !== b.position_ms) changes.push('position_ms');
  if (a.elapsed_total_ms !== b.elapsed_total_ms) changes.push('elapsed_total_ms');
  if (a.order.length !== b.order.length || a.order.some((id, i) => id !== b.order[i])) changes.push('order');
  if (a.av.length !== b.av.length) {
    changes.push('av#length');
  } else {
    for (let i = 0; i < a.av.length; i += 1) {
      const x = a.av[i]!;
      const y = b.av[i]!;
      if (
        x.media_id !== y.media_id ||
        x.state !== y.state ||
        x.position_ms !== y.position_ms ||
        x.loops_completed !== y.loops_completed ||
        x.muted !== y.muted ||
        x.volume !== y.volume ||
        x.effective_start_ms !== y.effective_start_ms ||
        x.effective_end_ms !== y.effective_end_ms
      ) {
        changes.push(`av[${String(i)}]`);
      }
    }
  }
  return Object.freeze(changes);
}

/** 一页的页序 id 映射（p:presented_id = 放映时的 id，p:reopened_id = 导回后的 id）。 */
export interface SlideIdMapEntry {
  readonly ordinal: number;
  readonly presented_id: number;
  readonly reopened_id: number;
}

/** 导回结果。 */
export interface RoundTripResult {
  readonly entry_count: number;
  readonly content_digest: string;
  readonly slide_count: number;
  /** 放映时的有序页集。 */
  readonly presented_order: readonly number[];
  /** 保存 → 重开后 `planSlideshow` 得到的有序页集。 */
  readonly reopened_order: readonly number[];
  readonly excluded_hidden: readonly number[];
  /**
   * 有序页集是否"结构上保住"：页数相同，且隐藏页排除的**数量**相同。
   * **按页序位置比对，不按 slide_id**——见 {@link ids_stable} 的说明。
   */
  readonly order_preserved: boolean;
  /** 当前页（按放映页序下标）在重开后仍落在页集里。 */
  readonly current_slide_present: boolean;
  /** 每页切换类型随文件存活（按页序位置逐页比对）。 */
  readonly transitions_preserved: boolean;
  /**
   * `slide_id` 是否逐项不变。**实测：手建文稿渲染后再导入会被重新编号（256 起），
   * 故此处常为 `false`**；只有"文稿本身就来自一次导入"时才会 `true`。
   * 手机端若要跨保存持久化"当前页 id"，必须用重开后的 `reopened_order`，不能用旧 id。
   */
  readonly ids_stable: boolean;
  readonly id_map: readonly SlideIdMapEntry[];
}

/**
 * 导回验收：把**放过的那份**渲染成真字节 → 重新导入 → 断言有序页集与切换仍在。
 *
 * 这是**真往返**（`renderPresentation` 出 ZIP/XML 字节，`importPresentation` 再读回），不是模拟。
 *
 * **按页序位置比对，不按 slide_id**：实测导入会把页面重新编号（256 起），因此 `slide_id`
 * 本身**不可作为跨保存的稳定键**。有序页集结构不符 ⇒ `roundtrip_order_mismatch`；
 * 切换类型丢失 ⇒ `roundtrip_transition_mismatch`。`ids_stable` 与 `id_map` 如实报告编号是否变化。
 */
export function verifyPresentationRoundTrip(
  session: SlideshowSession,
): RoundTripResult {
  const rendered = renderPresentation(session.deck);
  const reimported = importPresentation(rendered.bytes);
  const reopenedPreview = buildPresentationPreview(reimported.presentation);
  const reopenedPlan = planSlideshow(reopenedPreview, {
    slide_range: session.slide_range,
    include_hidden: session.include_hidden,
  });

  const sameLength = reopenedPlan.slide_ids.length === session.order.length;
  const sameHiddenCount = reopenedPlan.excluded_hidden.length === session.excluded_hidden.length;
  const orderPreserved = sameLength && sameHiddenCount;
  if (!orderPreserved) {
    throw new PlaybackError(
      'roundtrip_order_mismatch',
      `导回后有序页集长度 ${String(reopenedPlan.slide_ids.length)}（隐藏 ${String(reopenedPlan.excluded_hidden.length)}）` +
        ` ≠ 放映页集长度 ${String(session.order.length)}（隐藏 ${String(session.excluded_hidden.length)}）`,
    );
  }

  // 切换按**页序位置**逐页比对（不按 id）。
  const reopenedById = new Map(reimported.presentation.slides.map((slide) => [slide.slide_id, slide] as const));
  let transitionsPreserved = true;
  for (let i = 0; i < session.order.length; i += 1) {
    const original = requireSlide(session, session.order[i]!).transition;
    const reopened = reopenedById.get(reopenedPlan.slide_ids[i]!)?.transition ?? null;
    const originalKind = original === null ? null : original.kind;
    const reopenedKind = reopened === null ? null : reopened.kind;
    if (originalKind !== reopenedKind) {
      transitionsPreserved = false;
      break;
    }
  }
  if (!transitionsPreserved) {
    throw new PlaybackError(
      'roundtrip_transition_mismatch',
      '导回后有页的切换类型与放映时不一致（切换必须随文件一起存活）',
    );
  }

  const currentIndex = session.current_slide_id === null ? -1 : session.order.indexOf(session.current_slide_id);
  const currentSlidePresent = currentIndex < 0 || currentIndex < reopenedPlan.slide_ids.length;

  const idMap: SlideIdMapEntry[] = session.order.map((presentedId, ordinal) =>
    Object.freeze({ ordinal, presented_id: presentedId, reopened_id: reopenedPlan.slide_ids[ordinal]! }),
  );
  const idsStable = idMap.every((entry) => entry.presented_id === entry.reopened_id);

  return Object.freeze({
    entry_count: rendered.entry_count,
    content_digest: rendered.content_digest,
    slide_count: rendered.slide_count,
    presented_order: Object.freeze([...session.order]),
    reopened_order: Object.freeze([...reopenedPlan.slide_ids]),
    excluded_hidden: Object.freeze([...reopenedPlan.excluded_hidden]),
    order_preserved: orderPreserved,
    current_slide_present: currentSlidePresent,
    transitions_preserved: transitionsPreserved,
    ids_stable: idsStable,
    id_map: Object.freeze(idMap),
  });
}

// ---------------------------------------------------------------------------
// 六、未验证清单
// ---------------------------------------------------------------------------

/** 本包**无法**在本仓验证的断言（都需要真机 / 解码器 / 播放器）。 */
export interface PlaybackUnverifiedClaim {
  readonly claim: string;
  readonly status: 'unverified';
  readonly requires: string;
  readonly detail: string;
}

export const PLAYBACK_UNVERIFIED_CLAIMS: readonly PlaybackUnverifiedClaim[] = Object.freeze([
  Object.freeze({
    claim: '手机真的按页序放映（点击换页、隐藏页不出现）',
    status: 'unverified' as const,
    requires: '真机放映宿主（Android SurfaceView / 幻灯片控件）',
    detail: '本层只判定有序页集与状态迁移；没有接入任何手机放映控件，未回读真机放映。',
  }),
  Object.freeze({
    claim: '音视频在手机上真的发声 / 出画、且自动播放生效',
    status: 'unverified' as const,
    requires: '真机 MediaPlayer / ExoPlayer 与真实媒体字节',
    detail: '本层是确定性时间状态机；无解码器，不验证播放、音画同步、音量。',
  }),
  Object.freeze({
    claim: '方向变化后版面观感正确（黑边 / 裁切在像素上如预期）',
    status: 'unverified' as const,
    requires: '真机渲染 + 截图比对',
    detail: 'FitResult 是几何推算（缩放 / 偏移 / 面积），不是像素；未做栅格化比对。',
  }),
  Object.freeze({
    claim: '导回后由真实消费者（PowerPoint / WPS / 手机放映端）打开并放映',
    status: 'unverified' as const,
    requires: '外部消费端',
    detail: '本层导回只走本仓 render→import 往返；外部打开与放映无回读通道。',
  }),
]);

/** 默认视口（横屏 16:9 手机），供调用方起步用。 */
export const DEFAULT_LANDSCAPE_VIEWPORT: Viewport = Object.freeze({
  width_px: 2340,
  height_px: 1080,
  orientation: 'landscape' as const,
});

/** 默认竖屏视口。 */
export const DEFAULT_PORTRAIT_VIEWPORT: Viewport = Object.freeze({
  width_px: 1080,
  height_px: 2340,
  orientation: 'portrait' as const,
});

/** 便利：16:9 幻灯片尺寸（复用模型常量，不另造）。 */
export const WIDESCREEN_SLIDE_SIZE: SlideSize = SLIDE_SIZE_16_9;

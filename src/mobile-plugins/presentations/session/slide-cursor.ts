/**
 * P-I22 · **跨保存稳定的"当前页"引用与放映游标**（手机侧演示会话面）。
 *
 * ## 缺口（P-R05 实测钉住）
 *
 * `renderPresentation` 写 `p:sldIdLst` 时把页号固定成 `256 + index`
 * （`render.ts` 的 `FIRST_SLIDE_ID = 256`），而 `importPresentation` 读回时
 * **原样采信 `p:sldId@id`**。于是同一份演示"保存前 slide_id=2"、"重开后 slide_id=257"——
 * `slide_id` **不是**跨保存的稳定键。任何"上次看到第几页"的持久化引用若沿用旧 `slide_id`，
 * 重开后必然落空（要么解析失败，要么落到别的页）。
 *
 * 本模块给出**序号稳定键**：页在 `presentation.slides` 里的**位置**（`ordinal`，0 起）跨
 * 保存不变（页数与页序被渲染 / 导入逐页保持）。持久化时同时记下当时的 `slide_id` 与页数，
 * 重开后**按序号解析**，并如实报告 id 是否漂移（`id_changed`）。页数变了 ⇒ 具名拒绝，
 * **不静默落到可能错误的页**。
 *
 * ## 放映游标（消费 P-R05 的放映层）
 *
 * {@link SlideshowPlayhead} 从 `tests/mobile-office/presentations/P-R05/playback.ts` 的
 * `SlideshowSession`（结构子集 {@link SlideshowPlayheadSource}，由调用方注入真实放映会话）
 * 取"当前正在放的是整份文稿里的第几页"，并把隐藏页过滤后的**放映页序下标**与**稳定页序号**
 * 分开记：`show_index` 会随隐藏页漂移，`ordinal` 不会。
 *
 * 本层**纯**：零 IO、零墙钟；解析只读传入的 `Presentation`，不改它。
 */

import { ValidationError } from '../../../protocol/index.js';

import type { Presentation } from '../../../presentations/model.js';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 稳定页引用 / 放映游标的具名失败原因（封闭枚举，供上层分类）。 */
export type SlideCursorErrorReason =
  /** 传入的文稿里没有这个 slide_id。 */
  | 'unknown_slide'
  /** 序号越界或不是非负整数。 */
  | 'ordinal_out_of_range'
  /** 解析时文稿页数与持久化时不一致（结构变了，拒绝猜）。 */
  | 'slide_count_changed'
  /** 放映会话当前没有页（`current_slide_id === null`）。 */
  | 'no_current_slide'
  /** 放映会话的当前页不在其文稿里（会话与文稿对不上）。 */
  | 'current_slide_not_in_deck';

/** 稳定页引用 / 放映游标错误。`reason` 是判定用的稳定标识；`message` 只给人看。 */
export class SlideCursorError extends ValidationError {
  readonly reason: SlideCursorErrorReason;

  constructor(reason: SlideCursorErrorReason, message: string) {
    super(message);
    this.name = 'SlideCursorError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 一、稳定页序号
// ---------------------------------------------------------------------------

/** 某 `slide_id` 在文稿里的序号（0 起）；不在文稿里 ⇒ `null`（不抛，供反向对照用）。 */
export function findSlideOrdinal(presentation: Presentation, slideId: number): number | null {
  const index = presentation.slides.findIndex((slide) => slide.slide_id === slideId);
  return index < 0 ? null : index;
}

/**
 * 取某序号对应的 `slide_id`。
 *
 * @throws {SlideCursorError} 序号越界（`ordinal_out_of_range`）。
 */
export function slideIdAtOrdinal(presentation: Presentation, ordinal: number): number {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= presentation.slides.length) {
    throw new SlideCursorError(
      'ordinal_out_of_range',
      `页序号 ${String(ordinal)} 越界（文稿共 ${String(presentation.slides.length)} 页）`,
    );
  }
  return presentation.slides[ordinal]!.slide_id;
}

// ---------------------------------------------------------------------------
// 二、持久化"当前页"引用（序号稳定键 + 当时 id）
// ---------------------------------------------------------------------------

/**
 * 一个可持久化的"当前页"引用。
 *
 * `ordinal` 是**权威稳定键**；`persisted_slide_id` 只记录"保存那一刻的 id"（诊断 / 对账用），
 * 跨保存会变，**不得**拿它当解析键。`slide_count` 用于解析前校验结构没变。
 */
export interface CurrentSlideRef {
  readonly ordinal: number;
  readonly persisted_slide_id: number;
  readonly slide_count: number;
  /** 可选：保存字节的摘要（`sha256:...`），把引用绑到"那一份"文件。 */
  readonly digest?: string;
}

/** 解析结果：稳定序号 → 当前（可能是重开后）的 `slide_id`。 */
export interface ResolvedSlide {
  readonly ordinal: number;
  /** 在当前传入的文稿里解析出的 id（重开后即新编号）。 */
  readonly slide_id: number;
  /** 持久化时记录的 id，供调用方对账。 */
  readonly persisted_slide_id: number;
  /** id 是否漂移（`slide_id !== persisted_slide_id`，即"发生了重新编号"）。 */
  readonly id_changed: boolean;
}

/**
 * 由"当前文稿 + 当前页 id"造一个可持久化引用。
 *
 * @throws {SlideCursorError} 文稿里没有这个 slide_id（`unknown_slide`）。
 */
export function captureCurrentSlideRef(
  presentation: Presentation,
  slideId: number,
  digest?: string,
): CurrentSlideRef {
  const ordinal = findSlideOrdinal(presentation, slideId);
  if (ordinal === null) {
    throw new SlideCursorError('unknown_slide', `文稿里没有 slide_id=${String(slideId)}，无法记录当前页`);
  }
  return Object.freeze({
    ordinal,
    persisted_slide_id: slideId,
    slide_count: presentation.slides.length,
    ...(digest === undefined ? {} : { digest }),
  });
}

/** 由序号直接造引用（不要求提供旧 id；`persisted_slide_id` 取当前文稿该序号的 id）。 */
export function slideRefAtOrdinal(
  presentation: Presentation,
  ordinal: number,
  digest?: string,
): CurrentSlideRef {
  const slideId = slideIdAtOrdinal(presentation, ordinal);
  return captureCurrentSlideRef(presentation, slideId, digest);
}

/**
 * 把引用解析到一份（可能已重新编号的）文稿上。
 *
 * **按序号解析**：页数不一致 ⇒ `slide_count_changed`（拒绝猜）；序号越界 ⇒
 * `ordinal_out_of_range`。解析成功时如实报告 id 是否漂移。
 *
 * @throws {SlideCursorError} 结构变了或序号越界。
 */
export function resolveCurrentSlideRef(ref: CurrentSlideRef, presentation: Presentation): ResolvedSlide {
  if (presentation.slides.length !== ref.slide_count) {
    throw new SlideCursorError(
      'slide_count_changed',
      `引用记录 ${String(ref.slide_count)} 页，当前文稿 ${String(presentation.slides.length)} 页：结构已变，序号不再可信`,
    );
  }
  const slideId = slideIdAtOrdinal(presentation, ref.ordinal);
  return Object.freeze({
    ordinal: ref.ordinal,
    slide_id: slideId,
    persisted_slide_id: ref.persisted_slide_id,
    id_changed: slideId !== ref.persisted_slide_id,
  });
}

// ---------------------------------------------------------------------------
// 三、放映游标（消费 P-R05 的放映会话）
// ---------------------------------------------------------------------------

/**
 * P-R05 `SlideshowSession` 里本层用到的**结构子集**。
 *
 * 不 `import` 放映模块（它位于测试树 `tests/**`，生产源码不应依赖测试树）；调用方把**真实**
 * 放映会话传进来即可——`SlideshowSession` 结构上满足本接口。P-I22 用例用 P-R05 的
 * `startSession` 产物直接驱动本层，钉住这条消费链。
 */
export interface SlideshowPlayheadSource {
  readonly deck: Presentation;
  /** 实际会放的页（有序，已过滤隐藏页 / 范围）。 */
  readonly order: readonly number[];
  /** 当前页在 `order` 里的下标。 */
  readonly index: number;
  readonly current_slide_id: number | null;
}

/**
 * 放映游标：把"放映到哪了"拆成两个坐标。
 *
 * - `ordinal`：当前页在**整份文稿**里的稳定序号（跨保存不变）——**持久化用这个**；
 * - `show_index`：当前页在**放映页序**里的下标（隐藏页 / 范围会挪动它）——放映内导航用这个。
 */
export interface SlideshowPlayhead {
  readonly ordinal: number;
  readonly show_index: number;
  /** 放映那一刻的 id（跨保存会变），诊断用。 */
  readonly showed_slide_id: number;
  /** 放映页序快照（当时的有序页集）。 */
  readonly order: readonly number[];
  /** 放映那一刻的文稿页数。 */
  readonly slide_count: number;
}

/**
 * 从一份放映会话取游标。
 *
 * @throws {SlideCursorError} 没有当前页（`no_current_slide`）或当前页不在文稿里
 *   （`current_slide_not_in_deck`）。
 */
export function playheadFromShow(show: SlideshowPlayheadSource): SlideshowPlayhead {
  const current = show.current_slide_id;
  if (current === null) {
    throw new SlideCursorError('no_current_slide', '放映会话当前没有页（current_slide_id === null）');
  }
  const ordinal = findSlideOrdinal(show.deck, current);
  if (ordinal === null) {
    throw new SlideCursorError(
      'current_slide_not_in_deck',
      `放映会话当前页 slide_id=${String(current)} 不在其文稿里（共 ${String(show.deck.slides.length)} 页）`,
    );
  }
  return Object.freeze({
    ordinal,
    show_index: show.index,
    showed_slide_id: current,
    order: Object.freeze([...show.order]),
    slide_count: show.deck.slides.length,
  });
}

/** 把放映游标转成可持久化的"当前页"引用（序号稳定键）。 */
export function playheadToSlideRef(playhead: SlideshowPlayhead, digest?: string): CurrentSlideRef {
  return Object.freeze({
    ordinal: playhead.ordinal,
    persisted_slide_id: playhead.showed_slide_id,
    slide_count: playhead.slide_count,
    ...(digest === undefined ? {} : { digest }),
  });
}

/** 把放映游标解析到一份（可能已重新编号的）文稿上（同 {@link resolveCurrentSlideRef}）。 */
export function resolvePlayhead(playhead: SlideshowPlayhead, presentation: Presentation): ResolvedSlide {
  return resolveCurrentSlideRef(playheadToSlideRef(playhead), presentation);
}

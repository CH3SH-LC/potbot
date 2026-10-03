/**
 * P08 · 时序部件层（`timing-parts`）的**具名错误**。
 *
 * 与 `animation.ts` 的 `AnimationError` 同风格：每个失败面有名字，供用例断言，
 * 不出现"随便抛个 Error"的静默降级。
 */

import { ValidationError } from '../../protocol/index.js';

/** 时序部件层失败原因。 */
export type TimingPartsErrorReason =
  | 'invalid_slide_path'
  | 'invalid_timing_xml'
  | 'missing_timing_root'
  | 'duplicate_timing_entry'
  | 'unknown_timing_entry'
  | 'missing_slide_root'
  | 'missing_slide_close'
  /** P-I05：写侧收到的动画规格不合法（未知效果 / 负时长 / 非整型 id）。 */
  | 'invalid_animation_spec'
  /** P-I05：写侧收到的媒体自动播放规格不合法（类型 / 负音量 / 非整型 id）。 */
  | 'invalid_media_spec';

/** 时序部件层错误：语义不成立时抛出，**不静默**。 */
export class TimingPartsError extends ValidationError {
  readonly reason: TimingPartsErrorReason;

  constructor(reason: TimingPartsErrorReason, message: string) {
    super(message);
    this.name = 'TimingPartsError';
    this.reason = reason;
  }
}

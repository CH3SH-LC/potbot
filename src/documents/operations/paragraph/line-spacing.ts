/**
 * 行距（WF-022–024）。六类行距在模型里是**六种互斥形态**，操作层只负责整块替换。
 *
 * 为什么不提供"把 1.5 倍改成双倍"这种增量操作：六类行距不是同一条数轴上的点。
 * "单倍 → 1.5 倍"是改倍数刻度，"固定 20pt → 最小 18pt"是改长度刻度，
 * "1.5 倍 → 固定 20pt"是**换刻度**。做成增量就会被迫在操作层算"当前是多少倍"，
 * 而当前值可能就是长度——于是又要在操作层写换算，违反 R128。
 * 所以：一次设置即整块替换，值由调用方按用户意图给出。
 */

import type { LineSpacing, ParagraphProperties } from '../../model/types.js';
import { VALUED_INHERIT, valuedSet } from './states.js';

/** 设置行距（WF-022–024）。整块替换，不在操作层做任何换算。 */
export function setLineSpacing(props: ParagraphProperties, spacing: LineSpacing): ParagraphProperties {
  return { ...props, lineSpacing: valuedSet(spacing) };
}

/** 清除行距的直接格式，回落到样式。 */
export function unsetLineSpacing(props: ParagraphProperties): ParagraphProperties {
  return { ...props, lineSpacing: VALUED_INHERIT };
}

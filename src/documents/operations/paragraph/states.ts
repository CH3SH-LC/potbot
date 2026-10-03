/**
 * 三态 / 四态构造 helper（本包私有）。
 *
 * `ToggleState` 的四个常量（`TOGGLE_SPECIFIED` 等）由 `model/types.ts` 提供，直接复用。
 * `ValuedState<T>` 的构造在 types.ts 里没有给常量（泛型常量表达不了），所以在这里补上：
 * 调用方写 `valuedSet('center')` 而不是手搓 `{state:'set', value:'center'}`——
 * 少一处手搓，就少一处把 `state` 拼错成 `'set '` 的机会。
 *
 * **本文件不写进 model/types.ts**：那里是冻结文件，且属 D01 写权。这里是纯 helper，
 * 与模型类型无冲突。
 */

import type { ValuedState } from '../../model/types.js';

/**
 * `ValuedState<T>` 的"未指定"态。
 *
 * 类型标为 `ValuedState<never>`：`never` 是所有类型的子类型，因此这个常量可以赋给任意
 * `ValuedState<T>`（`{state:'unspecified'}` 本来就没有 `value` 字段，与 T 无关）。
 */
export const VALUED_UNSPECIFIED: ValuedState<never> = Object.freeze({ state: 'unspecified' });

/** `ValuedState<T>` 的"清除覆盖、回落到样式级联"态（R117/R120）。 */
export const VALUED_INHERIT: ValuedState<never> = Object.freeze({ state: 'inherit' });

/** 构造 `ValuedState<T>` 的"显式设置"态。 */
export function valuedSet<T>(value: T): ValuedState<T> {
  return { state: 'set', value };
}

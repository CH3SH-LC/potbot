/**
 * 选区/多 run 的**读回**状态（合同 R117、R119、R124 的读侧）。
 *
 * `mixed` 只能从这里产出：它是"选区内各 run 取值不一致"的**观察结果**，不是一个可以写回去的值。
 * R119 明确禁止把 `mixed` 当写入值——所以本模块提供 `toWritableToggle` / `toWritableValued`
 * 作为**唯一出口**：想拿读回结果去写，必须先过这道闸，`mixed` 在这里被拒绝。
 */

import type { ReadState, ReadToggleState, RunProperties, ToggleState, ValuedState } from '../../model/types.js';
import { deepEqual } from '../../selection/equals.js';
import { fail, succeed, type Result } from '../../selection/types.js';
import type { TogglePropertyKey, ValuedPropertyKey, ValuedPropertyValueMap } from './types.js';

/** 读回一组 run 的某个开关属性：全同 ⇒ 该值；不一致 ⇒ `mixed`。 */
export function readToggleState(
  properties: readonly RunProperties[],
  key: TogglePropertyKey,
): ReadToggleState {
  if (properties.length === 0) return { state: 'unspecified' };
  const first = properties[0]![key];
  const uniform = properties.every((item) => deepEqual(item[key], first));
  return uniform ? first : { state: 'mixed' };
}

/** 取出各 run 某个带值属性的状态（读回用，保留每个 run 的原始状态）。 */
export function valuedStatesOf<K extends ValuedPropertyKey>(
  properties: readonly RunProperties[],
  key: K,
): readonly ValuedState<ValuedPropertyValueMap[K]>[] {
  return properties.map((item) => item[key] as ValuedState<ValuedPropertyValueMap[K]>);
}

/** 由一串带值状态归纳出读回结果：全同 ⇒ 该值；不一致 ⇒ `mixed`。 */
export function readValuedState<T>(states: readonly ValuedState<T>[]): ReadState<T> {
  if (states.length === 0) return { state: 'unspecified' };
  const first = states[0]!;
  const uniform = states.every((item) => deepEqual(item, first));
  return uniform ? first : { state: 'mixed' };
}

/** 便捷：直接读回一组 run 的某个带值属性。 */
export function readValuedProperty<K extends ValuedPropertyKey>(
  properties: readonly RunProperties[],
  key: K,
): ReadState<ValuedPropertyValueMap[K]> {
  return readValuedState(valuedStatesOf(properties, key));
}

/** 读回结果 → 可写入状态；`mixed` 一律拒绝（R119）。 */
export function toWritableToggle(state: ReadToggleState): Result<ToggleState> {
  if (state.state === 'mixed') {
    return fail('precondition', 'mixed 只是读回结果，不能作为写入值（R119）。', {
      extra: { state: 'mixed' },
    });
  }
  return succeed(state);
}

/** 读回结果 → 可写入状态；`mixed` 一律拒绝（R119）。 */
export function toWritableValued<T>(state: ReadState<T>): Result<ValuedState<T>> {
  if (state.state === 'mixed') {
    return fail('precondition', 'mixed 只是读回结果，不能作为写入值（R119）。', {
      extra: { state: 'mixed' },
    });
  }
  return succeed(state);
}

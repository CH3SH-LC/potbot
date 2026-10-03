/**
 * 属性状态的构造与**写入意图**（合同 R117–R119）。
 *
 * ## 本模块存在的唯一理由
 *
 * R118：`<w:b/>`（显式开）、`<w:b w:val="false"/>`（显式关）、**没有** `<w:b/>`（未指定）
 * 是三份不同的字节。模型层面它们已经是三个不同的 `state`，但只要有一个地方把
 * "未指定" 和 "显式关" 都映射成同一个 `undefined/false`，这个区别就在**写出去之前**丢了。
 *
 * 因此这里把"这四种状态各自对应 OOXML 的什么动作"固化成 `ToggleWriteIntent`：
 *
 * | 模型状态 | 写意图 | 对 OOXML 的动作 |
 * |---|---|---|
 * | `unspecified` | `omit` | **不写**该元素 |
 * | `on` | `write_true` | 写 `<w:b/>`（或 `w:val="true"`） |
 * | `off` | `write_false` | 写 `<w:b w:val="false"/>` |
 * | `inherit` | `remove` | **删除**已存在的该元素（清除直接格式，R120/R122） |
 *
 * `omit` 与 `write_false` 必须能分别产出——这正是 R118 的判据，`attributes.test.ts` 有对照用例。
 *
 * ## `mixed` 只出不进（R119）
 *
 * `mixed` 是**读回**结果（选区里部分加粗），不是可写入的状态。`toWritable*` 系列把它挡在写入侧：
 * 传进来即抛 `non_writable_state`（R140 的"操作前拒绝"，不发生部分写入）。
 */

import { DocumentModelError, assertModel, kindLabel, valueLabel } from './errors.js';
import type { ReadState, ReadToggleState, ToggleState, ValuedState } from './types.js';

/** R117 的五态词汇表（对读取结果与写入态统一命名）。 */
export type AttributeStateKind = 'unspecified' | 'set' | 'off' | 'inherit' | 'mixed';

/** 开关型属性对应的 OOXML 写意图。`omit` ≠ `write_false`（R118）。 */
export type ToggleWriteIntent = 'omit' | 'write_true' | 'write_false' | 'remove';

/** 带值属性对应的 OOXML 写意图。 */
export type ValuedWriteIntent = 'omit' | 'write_value' | 'remove';

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

/** 未指定：对应"不写元素"。可赋给任意 `ValuedState<T>`（`set` 分支要求 `never`，实际不可达）。 */
export const UNSPECIFIED_VALUE: ValuedState<never> = Object.freeze({ state: 'unspecified' });

/** 清除覆盖、回落到样式级联（R120/R122）。 */
export const INHERIT_VALUE: ValuedState<never> = Object.freeze({ state: 'inherit' });

/** 显式设置一个值。注意 `specified(false)` **不是**"关闭"——`false` 是值，`off` 是状态（R118）。 */
export function specified<T>(value: T): ValuedState<T> {
  return { state: 'set', value };
}

/** 取带值状态里的值；`unspecified` / `inherit` 返回 `undefined`（**不是** `null` 也不是 `false`）。 */
export function stateValue<T>(state: ValuedState<T>): T | undefined {
  return state.state === 'set' ? state.value : undefined;
}

// ---------------------------------------------------------------------------
// 判别
// ---------------------------------------------------------------------------

const TOGGLE_STATES: readonly string[] = ['unspecified', 'on', 'off', 'inherit'];

/** 是否是四态开关（**不含** `mixed`）。 */
export function isWritableToggleState(value: unknown): value is ToggleState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'state' in value &&
    typeof (value as { state: unknown }).state === 'string' &&
    TOGGLE_STATES.includes((value as { state: string }).state)
  );
}

/** 是否是可写入的带值状态（**不含** `mixed`）。 */
export function isWritableValuedState<T = unknown>(value: unknown): value is ValuedState<T> {
  if (typeof value !== 'object' || value === null || !('state' in value)) {
    return false;
  }
  const state: unknown = (value as { state: unknown }).state;
  if (state === 'unspecified' || state === 'inherit') {
    return true;
  }
  return state === 'set' && 'value' in value;
}

/** 是否是读取结果里多出来的 `mixed`（R119 的禁区）。 */
export function isMixedState(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'state' in value &&
    (value as { state: unknown }).state === 'mixed'
  );
}

/** R117 的五态归类。无法识别即抛（不猜）。 */
export function attributeStateKind(
  value: ToggleState | ReadToggleState | ValuedState<unknown> | ReadState<unknown>,
): AttributeStateKind {
  const state: unknown = (value as { state?: unknown }).state;
  switch (state) {
    case 'unspecified':
      return 'unspecified';
    case 'set':
    case 'on':
      return 'set';
    case 'off':
      return 'off';
    case 'inherit':
      return 'inherit';
    case 'mixed':
      return 'mixed';
    default:
      throw new DocumentModelError(
        'invalid_node',
        `不是属性状态：${kindLabel(value)} / ${valueLabel(state)}`,
      );
  }
}

// ---------------------------------------------------------------------------
// 写意图（R118 的可判定形态）
// ---------------------------------------------------------------------------

/** 开关态 ⇒ 写意图。`unspecified → omit`，`off → write_false`（**必须可分别产出**）。 */
export function toggleWriteIntent(state: ToggleState): ToggleWriteIntent {
  switch (state.state) {
    case 'unspecified':
      return 'omit';
    case 'on':
      return 'write_true';
    case 'off':
      return 'write_false';
    case 'inherit':
      return 'remove';
    default: {
      const unreachable: never = state;
      throw new DocumentModelError('invalid_node', `未知开关态：${kindLabel(unreachable)}`);
    }
  }
}

/** 带值态 ⇒ 写意图。注意 `set` 即使值是 `false` / `0` / `null` 也是 `write_value`。 */
export function valuedWriteIntent<T>(state: ValuedState<T>): ValuedWriteIntent {
  switch (state.state) {
    case 'unspecified':
      return 'omit';
    case 'set':
      return 'write_value';
    case 'inherit':
      return 'remove';
    default: {
      const unreachable: never = state;
      throw new DocumentModelError('invalid_node', `未知带值态：${kindLabel(unreachable)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 写入侧闸门（R119：`mixed` 一律拒绝）
// ---------------------------------------------------------------------------

/**
 * 把读回值收窄成可写入值；`mixed` ⇒ 抛 `non_writable_state`。
 *
 * 这是写入路径的统一入口：任何"把读到的状态原样写回"的代码路径都必须经过它，
 * 否则 `mixed` 就会渗进模型（R119）。
 */
export function toWritableToggleState(value: ReadToggleState): ToggleState {
  if (isMixedState(value)) {
    throw new DocumentModelError(
      'non_writable_state',
      'mixed 只能出现在读取结果里，不得作为写入值（R119）',
    );
  }
  assertModel(isWritableToggleState(value), 'non_writable_state', `不是合法四态开关：${valueLabel(value)}`);
  return value;
}

/** `toWritableToggleState` 的带值版本。 */
export function toWritableValuedState<T>(value: ReadState<T>): ValuedState<T> {
  if (isMixedState(value)) {
    throw new DocumentModelError(
      'non_writable_state',
      'mixed 只能出现在读取结果里，不得作为写入值（R119）',
    );
  }
  assertModel(
    isWritableValuedState<T>(value),
    'non_writable_state',
    `不是合法带值状态：${valueLabel(value)}`,
  );
  return value;
}

/** 判定两个开关态是否**语义等价**（逐字段比较，不看对象身份）。 */
export function toggleStatesEqual(a: ToggleState, b: ToggleState): boolean {
  return a.state === b.state;
}

/** 判定两个带值状态是否**逐值等价**（用 `Object.is`，故 `0` 与 `-0`、`NaN` 与 `NaN` 行为确定）。 */
export function valuedStatesEqual<T>(a: ValuedState<T>, b: ValuedState<T>): boolean {
  if (a.state !== b.state) {
    return false;
  }
  if (a.state === 'set' && b.state === 'set') {
    return Object.is(a.value, b.value);
  }
  return true;
}

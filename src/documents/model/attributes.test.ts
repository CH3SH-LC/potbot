/**
 * R117–R119 属性状态。
 *
 * 本组最关键的两条对照：
 *
 * - **R118**：`unspecified`（不写元素）与 `off`（写 `w:val="false"`）必须**可分别产出**；
 *   同时 `false` / `0` / `null` 是**值**，不是"关闭"——`specified(false)` 的写意图是
 *   `write_value`，不是 `omit`，也不是 `write_false`。
 * - **R119**：`mixed` 只出现在读取结果里，写入侧一律拒绝（抛 `non_writable_state`）。
 */

import { describe, expect, it } from 'vitest';

import {
  attributeStateKind,
  INHERIT_VALUE,
  isMixedState,
  isWritableToggleState,
  isWritableValuedState,
  specified,
  stateValue,
  toggleStatesEqual,
  toggleWriteIntent,
  toWritableToggleState,
  toWritableValuedState,
  UNSPECIFIED_VALUE,
  valuedStatesEqual,
  valuedWriteIntent,
} from './attributes.js';
import { DocumentModelError } from './errors.js';
import {
  TOGGLE_INHERIT,
  TOGGLE_OFF,
  TOGGLE_ON,
  TOGGLE_UNSPECIFIED,
} from './types.js';

describe('R118 开关型四态 → 写意图（"不写元素"与"写 w:val=false"可分别产出）', () => {
  it('四态各对应一个互不相同的写意图', () => {
    expect(toggleWriteIntent(TOGGLE_UNSPECIFIED)).toBe('omit');
    expect(toggleWriteIntent(TOGGLE_ON)).toBe('write_true');
    expect(toggleWriteIntent(TOGGLE_OFF)).toBe('write_false');
    expect(toggleWriteIntent(TOGGLE_INHERIT)).toBe('remove');
  });

  it('未指定 ≠ 显式关闭：一个是"不写元素"，一个是"写 w:val=false"', () => {
    expect(toggleWriteIntent(TOGGLE_UNSPECIFIED)).not.toBe(toggleWriteIntent(TOGGLE_OFF));
    expect(toggleWriteIntent(TOGGLE_UNSPECIFIED)).toBe('omit');
    expect(toggleWriteIntent(TOGGLE_OFF)).toBe('write_false');
  });

  it('显式关闭 ≠ 清除覆盖：一个是写 false，一个是删掉元素回落到样式', () => {
    expect(toggleWriteIntent(TOGGLE_OFF)).not.toBe(toggleWriteIntent(TOGGLE_INHERIT));
    expect(toggleWriteIntent(TOGGLE_INHERIT)).toBe('remove');
  });

  it('四种状态两两不同（不存在被压成同一种的组合）', () => {
    const intents = [TOGGLE_UNSPECIFIED, TOGGLE_ON, TOGGLE_OFF, TOGGLE_INHERIT].map(
      toggleWriteIntent,
    );
    expect(new Set(intents).size).toBe(4);
  });
});

describe('R118 带值状态：false/0/null 是"值"不是"关闭"', () => {
  it('三态写意图', () => {
    expect(valuedWriteIntent(UNSPECIFIED_VALUE)).toBe('omit');
    expect(valuedWriteIntent(specified('center'))).toBe('write_value');
    expect(valuedWriteIntent(INHERIT_VALUE)).toBe('remove');
  });

  it('显式写入 false / 0 / null 都是 write_value，绝不是 omit', () => {
    expect(valuedWriteIntent(specified(false))).toBe('write_value');
    expect(valuedWriteIntent(specified(0))).toBe('write_value');
    expect(valuedWriteIntent(specified(null))).toBe('write_value');
    expect(valuedWriteIntent(specified(false))).not.toBe(valuedWriteIntent(UNSPECIFIED_VALUE));
  });

  it('stateValue 只在 set 时返回值；未指定返回 undefined 而不是 false/null', () => {
    expect(stateValue(specified(false))).toBe(false);
    expect(stateValue(specified(0))).toBe(0);
    expect(stateValue(UNSPECIFIED_VALUE)).toBeUndefined();
    expect(stateValue(INHERIT_VALUE)).toBeUndefined();
  });

  it('状态比较按语义而非对象身份', () => {
    expect(toggleStatesEqual(TOGGLE_OFF, { state: 'off' })).toBe(true);
    expect(toggleStatesEqual(TOGGLE_OFF, TOGGLE_UNSPECIFIED)).toBe(false);
    expect(valuedStatesEqual(specified(0), specified(0))).toBe(true);
    expect(valuedStatesEqual(specified(0), specified(-0))).toBe(false);
    expect(valuedStatesEqual(specified(Number.NaN), specified(Number.NaN))).toBe(true);
    expect(valuedStatesEqual(specified(false), UNSPECIFIED_VALUE)).toBe(false);
  });
});

describe('R117 五态词汇表', () => {
  it('五种状态各自归类，不混淆', () => {
    expect(attributeStateKind(TOGGLE_UNSPECIFIED)).toBe('unspecified');
    expect(attributeStateKind(TOGGLE_ON)).toBe('set');
    expect(attributeStateKind(specified('x'))).toBe('set');
    expect(attributeStateKind(TOGGLE_OFF)).toBe('off');
    expect(attributeStateKind(TOGGLE_INHERIT)).toBe('inherit');
    expect(attributeStateKind({ state: 'mixed' })).toBe('mixed');
  });

  it('不是属性状态即抛（不猜）', () => {
    expect(() => attributeStateKind({ state: '差不多' } as never)).toThrow(DocumentModelError);
  });
});

describe('R119 mixed 只出不进', () => {
  it('mixed 可被识别，但**不是**可写入状态', () => {
    expect(isMixedState({ state: 'mixed' })).toBe(true);
    expect(isWritableToggleState({ state: 'mixed' })).toBe(false);
    expect(isWritableValuedState({ state: 'mixed' })).toBe(false);
    expect(isWritableToggleState(TOGGLE_OFF)).toBe(true);
  });

  it('把 mixed 当写入值 ⇒ 抛 non_writable_state（操作前拒绝，R140）', () => {
    let code: string | null = null;
    try {
      toWritableToggleState({ state: 'mixed' });
    } catch (error) {
      code = error instanceof DocumentModelError ? error.code : 'not-model-error';
    }
    expect(code).toBe('non_writable_state');

    expect(() => toWritableValuedState({ state: 'mixed' })).toThrow(DocumentModelError);
    expect(() => toWritableValuedState({ state: 'mixed' })).toThrow(/mixed/);
  });

  it('四种合法状态原样通过写入闸门（值不变）', () => {
    expect(toWritableToggleState(TOGGLE_UNSPECIFIED)).toBe(TOGGLE_UNSPECIFIED);
    expect(toWritableToggleState(TOGGLE_OFF)).toBe(TOGGLE_OFF);
    const valued = specified('justify');
    expect(toWritableValuedState(valued)).toBe(valued);
  });
});

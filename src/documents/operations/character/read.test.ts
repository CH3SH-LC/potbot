/**
 * 读回状态单测（R117/R119）：`mixed` 只能出现在读回结果里，不能作为写入值。
 */

import { describe, expect, it } from 'vitest';

import { boldOff, boldOn, runProperties, unspecifiedRunProperties } from '../../selection/testing.js';
import {
  readToggleState,
  readValuedProperty,
  readValuedState,
  toWritableToggle,
  toWritableValued,
  valuedStatesOf,
} from './read.js';

describe('readToggleState —— 选区/多 run 的混合态', () => {
  it('全同 ⇒ 该值', () => {
    expect(readToggleState([boldOn(), boldOn()], 'bold')).toEqual({ state: 'on' });
    expect(readToggleState([boldOff(), boldOff()], 'bold')).toEqual({ state: 'off' });
    expect(readToggleState([unspecifiedRunProperties()], 'bold')).toEqual({ state: 'unspecified' });
  });

  it('不一致 ⇒ mixed', () => {
    expect(readToggleState([boldOn(), unspecifiedRunProperties()], 'bold')).toEqual({ state: 'mixed' });
  });

  it('空集合 ⇒ unspecified（没有可读的 run）', () => {
    expect(readToggleState([], 'bold')).toEqual({ state: 'unspecified' });
  });

  it('只比较所读的那一个属性，别的不影响', () => {
    const a = runProperties({ bold: { state: 'on' }, italic: { state: 'on' } });
    const b = runProperties({ bold: { state: 'on' }, italic: { state: 'off' } });
    expect(readToggleState([a, b], 'bold')).toEqual({ state: 'on' });
    expect(readToggleState([a, b], 'italic')).toEqual({ state: 'mixed' });
  });
});

describe('readValuedState / readValuedProperty', () => {
  it('全同 ⇒ 该值；不一致 ⇒ mixed', () => {
    const a = runProperties({ underline: { state: 'set', value: 'single' } });
    const b = runProperties({ underline: { state: 'set', value: 'double' } });
    expect(readValuedProperty([a, a], 'underline')).toEqual({ state: 'set', value: 'single' });
    expect(readValuedProperty([a, b], 'underline')).toEqual({ state: 'mixed' });
  });

  it('嵌套对象按结构比较（字体集逐槽位）', () => {
    const a = runProperties({ fonts: { state: 'set', value: { ascii: 'Arial', hAnsi: null, eastAsia: '宋体', cs: null } } });
    const same = runProperties({ fonts: { state: 'set', value: { ascii: 'Arial', hAnsi: null, eastAsia: '宋体', cs: null } } });
    const different = runProperties({ fonts: { state: 'set', value: { ascii: 'Arial', hAnsi: null, eastAsia: '黑体', cs: null } } });
    expect(readValuedProperty([a, same], 'fonts')).toEqual(a.fonts);
    expect(readValuedProperty([a, different], 'fonts')).toEqual({ state: 'mixed' });
  });

  it('valuedStatesOf 保留每个 run 的原始状态', () => {
    const states = valuedStatesOf([boldOn(), unspecifiedRunProperties()], 'underline');
    expect(states).toEqual([{ state: 'unspecified' }, { state: 'unspecified' }]);
    expect(readValuedState(states)).toEqual({ state: 'unspecified' });
  });
});

describe('R119 —— mixed 不得作为写入值', () => {
  it('toWritableToggle 拒绝 mixed', () => {
    const rejected = toWritableToggle({ state: 'mixed' });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.code).toBe('precondition');
  });

  it('toWritableValued 拒绝 mixed', () => {
    const rejected = toWritableValued({ state: 'mixed' });
    expect(rejected.ok).toBe(false);
  });

  it('非 mixed 的读回结果可以转成写入值', () => {
    expect(toWritableToggle({ state: 'on' })).toEqual({ ok: true, value: { state: 'on' } });
    expect(toWritableValued({ state: 'inherit' })).toEqual({ ok: true, value: { state: 'inherit' } });
  });
});

/**
 * 计数渲染测试（WF-040）。
 *
 * 判据：十进制 / 字母 / 罗马数字三种格式各自"进位正确"，`%N` 模板替换按 1 基。
 * 反面用例：越界值 **不**静默当成 1（宁可为空，也不产出一个看似合理的错号）。
 */

import { describe, expect, it } from 'vitest';
import {
  alphaCounter,
  formatListCounter,
  isCounterFormat,
  renderListText,
  romanNumeral,
  templateLevelReferences,
} from './format.js';
import { levelDefinition } from './table.js';

describe('罗马数字', () => {
  it('用减法组合而不是贪心加法', () => {
    expect(romanNumeral(4)).toBe('iv');
    expect(romanNumeral(9)).toBe('ix');
    expect(romanNumeral(40)).toBe('xl');
    expect(romanNumeral(90)).toBe('xc');
    expect(romanNumeral(400)).toBe('cd');
    expect(romanNumeral(900)).toBe('cm');
  });

  it('常见值与大小写', () => {
    expect(romanNumeral(1)).toBe('i');
    expect(romanNumeral(3)).toBe('iii');
    expect(romanNumeral(14)).toBe('xiv');
    expect(romanNumeral(1990)).toBe('mcmxc');
    expect(romanNumeral(14, true)).toBe('XIV');
  });

  it('边角值：0 / 负数 / 非整数 → 空串（不伪装成 1）', () => {
    expect(romanNumeral(0)).toBe('');
    expect(romanNumeral(-3)).toBe('');
    expect(romanNumeral(2.5)).toBe('');
  });
});

describe('字母序号', () => {
  it('26 处进位是 Excel 列名式，不是 ASCII 溢出', () => {
    expect(alphaCounter(1)).toBe('a');
    expect(alphaCounter(26)).toBe('z');
    expect(alphaCounter(27)).toBe('aa');
    expect(alphaCounter(52)).toBe('az');
    expect(alphaCounter(53)).toBe('ba');
    expect(alphaCounter(702)).toBe('zz');
    expect(alphaCounter(703)).toBe('aaa');
  });

  it('大写', () => {
    expect(alphaCounter(28, true)).toBe('AB');
  });
});

describe('formatListCounter', () => {
  it('十进制', () => {
    expect(formatListCounter('decimal', 1)).toBe('1');
    expect(formatListCounter('decimal', 128)).toBe('128');
  });

  it('非计数格式不能当计数用（明确抛出，不返回假值）', () => {
    expect(() => formatListCounter('bullet' as never, 1)).toThrow();
  });

  it('isCounterFormat 把 bullet / none 排除在外', () => {
    expect(isCounterFormat('decimal')).toBe(true);
    expect(isCounterFormat('upperRoman')).toBe(true);
    expect(isCounterFormat('bullet')).toBe(false);
    expect(isCounterFormat('none')).toBe(false);
  });
});

describe('renderListText（w:lvlText 语义）', () => {
  it('计数模板：%N 是 1 基，替换成对应级计数', () => {
    const level2 = levelDefinition(1, 'decimal', { text_template: '%1.%2.' });
    expect(renderListText(level2, [3, 4])).toBe('3.4.');
  });

  it('单级模板', () => {
    const level1 = levelDefinition(0, 'lowerRoman', { text_template: '(%1)' });
    expect(renderListText(level1, [4])).toBe('(iv)');
  });

  it('项目符号：模板即符号本体，不替换 %N', () => {
    const bullet = levelDefinition(0, 'bullet', { text_template: '•' });
    expect(renderListText(bullet, [7])).toBe('•');
  });

  it('none 级渲染为空串', () => {
    const none = levelDefinition(0, 'none');
    expect(renderListText(none, [1])).toBe('');
  });

  it('该级计数缺失时用本级 start 兜底（不会漏出光秃秃的 %1.）', () => {
    const level1 = levelDefinition(0, 'decimal', { text_template: '%1.', start: 1 });
    expect(renderListText(level1, [])).toBe('1.');
    const startAt5 = levelDefinition(0, 'decimal', { text_template: '%1.', start: 5 });
    expect(renderListText(startAt5, [])).toBe('5.');
  });

  it('templateLevelReferences 找出模板引用的级（1 基 → 0 基）', () => {
    expect(templateLevelReferences('%1.%2.')).toEqual([0, 1]);
    expect(templateLevelReferences('•')).toEqual([]);
  });
});

/**
 * 编号计数与文本模板渲染（WF-040：十进制 / 字母 / 罗马数字；WF-039：符号）。
 *
 * ## 为什么"渲染序号"要单独成模块
 *
 * R150 把"列表序号"划为**自动内容**：段落里没有 `1.` 这两个字符，序号是**算**出来的。
 * 那么"这段显示成几"就必须有一个**唯一的算法**，否则"文档里看到的"和"程序算出的"
 * 会用到两套规则（一个用 1 基、一个用 0 基；字母表在 26 处进位还是 27 处进位……）。
 * 本文件是那个唯一算法，也是测试"编号续接正确"时的判据来源。
 *
 * ## 三个容易写错的地方，这里都钉死
 *
 * 1. **字母序号是"excel 列名"式进位**：1→a … 26→z，27→aa，52→az，53→ba。
 *    写成 `String.fromCharCode(96 + n)` 会在 26 之后溢出成 `{`。
 * 2. **罗马数字用减法组合**：4→iv、9→ix、40→xl、90→xc、400→cd、900→cm。
 *    用"贪心加法表"写成 iiii / viiii 是常见错法。
 * 3. **`%N` 是 1 基**：`%1` 指第 1 级（下标 0）。差一位会让"标题 1.1"错成"1.0"。
 */

import type {
  CounterFormat,
  ListLevelDefinition,
  ListLevelFormat,
} from './types.js';

/** 该格式是否参与计数（`bullet` / `none` 不参与）。 */
export function isCounterFormat(format: ListLevelFormat): format is CounterFormat {
  return format !== 'bullet' && format !== 'none';
}

const ROMAN_STEPS: readonly (readonly [number, string])[] = Object.freeze([
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
]);

/**
 * 罗马数字。`value < 1` 返回空串（列表计数从 1 起；0 或负数不产出字符，
 * 而**不是**静默当成 1——那会把一个坏起始值伪装成正常输出）。
 */
export function romanNumeral(value: number, upper = false): string {
  if (!Number.isInteger(value) || value < 1) {
    return '';
  }
  let remaining = value;
  let text = '';
  for (const [amount, numeral] of ROMAN_STEPS) {
    while (remaining >= amount) {
      text += numeral;
      remaining -= amount;
    }
  }
  return upper ? text.toUpperCase() : text;
}

/**
 * 字母序号（Excel 列名式进位）。`value < 1` 返回空串。
 *
 * 1→a、26→z、27→aa、52→az、53→ba、702→zz、703→aaa。
 */
export function alphaCounter(value: number, upper = false): string {
  if (!Number.isInteger(value) || value < 1) {
    return '';
  }
  let remaining = value;
  let text = '';
  while (remaining > 0) {
    remaining -= 1;
    text = String.fromCharCode(97 + (remaining % 26)) + text;
    remaining = Math.floor(remaining / 26);
  }
  return upper ? text.toUpperCase() : text;
}

/**
 * 按格式把计数渲染成字符。`bullet` / `none` 不是计数格式——调用即抛，
 * 因为这些格式的"文本"必须走 `renderListText` 的模板分支（R118 的精神：
 * 两种含义不混作一种，宁可明确拒绝也不返回一个看似合理的结果）。
 */
export function formatListCounter(format: CounterFormat, value: number): string {
  switch (format) {
    case 'decimal':
      return Number.isInteger(value) && value >= 1 ? String(value) : '';
    case 'lowerLetter':
      return alphaCounter(value, false);
    case 'upperLetter':
      return alphaCounter(value, true);
    case 'lowerRoman':
      return romanNumeral(value, false);
    case 'upperRoman':
      return romanNumeral(value, true);
    default: {
      const unreachable: never = format;
      throw new Error(`formatListCounter 不支持非计数格式：${String(unreachable)}`);
    }
  }
}

/**
 * 渲染一级列表的显示文本（OOXML `w:lvlText` 的语义）。
 *
 * - `bullet`：**模板即符号本体**，原样返回（不替换 `%N`）；
 * - `none`：空串；
 * - 计数格式：把 `%N`（1 基）替换成第 N 级的当前计数。
 *
 * `counters[level]` 缺失（该级还没出现过）时用该级 `start` 兜底，因此
 * 只渲染第一级也能得到 `1.`，不会漏出一个光秃秃的 `%1.`。
 */
export function renderListText(
  definition: ListLevelDefinition,
  counters: readonly number[],
): string {
  if (definition.format === 'bullet') {
    return definition.text_template;
  }
  if (definition.format === 'none') {
    return '';
  }
  const format = definition.format;
  return definition.text_template.replace(/%(\d)/g, (_match, digits: string) => {
    const levelIndex = Number(digits) - 1;
    if (levelIndex < 0) {
      return '';
    }
    const counter = counters[levelIndex] ?? definition.start;
    return formatListCounter(format, counter);
  });
}

/** 模板里引用到的级别下标（1 基 `%N` → 0 基），去重后升序。用于判断"哪些级影响本级显示"。 */
export function templateLevelReferences(template: string): readonly number[] {
  const found = new Set<number>();
  for (const match of template.matchAll(/%(\d)/g)) {
    const levelIndex = Number(match[1]) - 1;
    if (levelIndex >= 0) {
      found.add(levelIndex);
    }
  }
  return [...found].sort((a, b) => a - b);
}

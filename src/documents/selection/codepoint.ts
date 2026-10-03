/**
 * Unicode 码位工具（合同 R102）。
 *
 * ## 为什么需要这一层
 *
 * JavaScript 字符串的 `.length` 与 `.slice()` 数的是 **UTF-16 码元**。`'👨‍👩‍👧'.length === 11`
 * （5 个码位摊成 11 个 UTF-16 码元），`'café'.length === 5` 而码位只有 4 个。
 * 直接用 `.slice()` 做"第 3 到第 5 个字"的定位，会在 emoji 与分解形字符上**把代理对或组合标记
 * 拦腰切断**——产出的不是"偏移差一点"，而是**非法字符串**。合同 R102 要求码位偏移，
 * 因此本包所有偏移运算都走这里，**不直接对 string 用 `.slice`**。
 *
 * 实现用 `Array.from`（按**码位**迭代，代理对自动合并；孤立代理项按 1 个码位计）。
 */

/** 把字符串拆成码位数组。代理对合并为一个元素；孤立代理项各自为一个元素。 */
export function toCodePoints(text: string): readonly string[] {
  return Array.from(text);
}

/** 码位数（**不是** UTF-16 `.length`）。 */
export function codePointLength(text: string): number {
  let count = 0;
  // for...of 按码位迭代，比 Array.from 少一次数组分配。
  for (const _ of text) {
    void _;
    count += 1;
  }
  return count;
}

/**
 * 按码位切片，`[start, end)` 开区间。越界部分按空处理（**不抛**），
 * 需要严格校验的调用方请先用 `isValidCodePointRange`。
 */
export function codePointSlice(text: string, start: number, end: number): string {
  const points = Array.from(text);
  const from = Math.max(0, Math.trunc(start));
  const to = Math.min(points.length, Math.trunc(end));
  if (to <= from) return '';
  return points.slice(from, to).join('');
}

/** 码位区间是否落在 `[0, length]` 内且起止不倒置、且都是整数。 */
export function isValidCodePointRange(text: string, start: number, end: number): boolean {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  if (start < 0 || end < start) return false;
  return end <= codePointLength(text);
}

/** UTF-16 下标 → 码位下标。越界时收敛到边界。 */
export function utf16IndexToCodePointIndex(text: string, utf16Index: number): number {
  const target = Math.max(0, Math.trunc(utf16Index));
  let utf16 = 0;
  let codePoints = 0;
  for (const point of text) {
    if (utf16 >= target) return codePoints;
    utf16 += point.length;
    codePoints += 1;
  }
  return codePoints;
}

/** 码位下标 → UTF-16 下标。用于与宿主 API（DOM、正则）对接时换算，**内部一律用码位**。 */
export function codePointIndexToUtf16Index(text: string, codePointIndex: number): number {
  const target = Math.max(0, Math.trunc(codePointIndex));
  let utf16 = 0;
  let codePoints = 0;
  for (const point of text) {
    if (codePoints >= target) return utf16;
    utf16 += point.length;
    codePoints += 1;
  }
  return utf16;
}

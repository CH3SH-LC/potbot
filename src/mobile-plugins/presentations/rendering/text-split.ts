/**
 * 字符分类（本渲染包自带的**独立**小工具，不依赖 Word 线的同名文件）。
 *
 * 口径与断行规则一致：CJK / 表意 / 全角形逐字可断；空格（含全角空格、制表符）为空白。
 */

/** 判定一个码点是否属于「逐字可断」的表意文字 / CJK 标点 / 全角形区段。 */
export function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x2eff) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x2ffff)
  );
}

/** 空白：普通空格、制表符、全角空格。 */
export function isSpaceCodePoint(cp: number): boolean {
  return cp === 0x20 || cp === 0x09 || cp === 0x3000;
}

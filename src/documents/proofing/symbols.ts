/**
 * 符号与特殊字符（WF-093）。
 *
 * ## 判据："实际字符**可读回**，不被规范化"
 *
 * 最容易被"顺手修好"的是**不间断空格 `U+00A0`**：很多文本管线会把 NBSP 归一化成普通空格
 * （`U+0020`），用户在 Word 里看到的"这段不会在中间断行"就悄悄失效了。
 * 因此本包做了两件事：
 *
 * 1. 插入用的是**码位**（不是"名字"），写进模型的就是那个字符本身；
 * 2. 提供 `readCodePoints` 与 `isNoBreakSpace`，让"读回来还是不是 U+00A0"成为**可断言的事实**，
 *    而不是"我插的时候看着像对"。测试对 NBSP 同时断言"存在 0xA0"与"普通空格数量没增加"。
 *
 * ## 为什么符号表里写的是**码位**而不是字符字面量
 *
 * 源码文件本身也是一种编码产物：把 NBSP 直接写进字符串字面量，就多了一个"文件存盘/编辑器/
 * 复制粘贴有没有动过它"的不确定环节。所以本表只写**码位**，`char` 一律由
 * `String.fromCodePoint(code_point)` 派生——两者不可能不一致，编码风险归零。
 */

import type { DocumentModel } from '../model/types.js';
import { buildInlineTextMap, replaceRangeInInlines } from '../selection/inline-map.js';
import { requireCurrentSelection } from '../selection/selection.js';
import { replaceParagraph, requireParagraph } from '../selection/structure.js';
import { fail, succeed, type Result, type Selection } from '../selection/types.js';

export const SYMBOL_CATEGORIES = ['space', 'punctuation', 'legal', 'unit', 'math', 'currency', 'arrow'] as const;
export type SymbolCategory = (typeof SYMBOL_CATEGORIES)[number];

/** 一个特殊字符的规格。`char` 由 `code_point` 派生，二者不可能不一致。 */
export interface SymbolSpec {
  readonly name: string;
  readonly char: string;
  readonly code_point: number;
  readonly category: SymbolCategory;
  readonly note: string;
}

interface SymbolDefinition {
  readonly name: string;
  readonly code_point: number;
  readonly category: SymbolCategory;
  readonly note: string;
}

/** NBSP（不间断空格）——WF-093 点名的那个字符。 */
export const NO_BREAK_SPACE = 0x00a0;

const SYMBOL_DEFINITIONS: readonly SymbolDefinition[] = [
  // 空白类
  { name: '不间断空格', code_point: NO_BREAK_SPACE, category: 'space', note: '不回折行的空格：防止"8 人"被拆成两行' },
  { name: '窄不换行空格', code_point: 0x202f, category: 'space', note: '窄版不换行空格' },
  { name: '全角空格', code_point: 0x3000, category: 'space', note: '中文排版用的全宽空格' },
  { name: '零宽空格', code_point: 0x200b, category: 'space', note: '可见宽度为 0，给长串提供断点' },
  // 标点
  { name: '左双引号', code_point: 0x201c, category: 'punctuation', note: '中文弯引号' },
  { name: '右双引号', code_point: 0x201d, category: 'punctuation', note: '中文弯引号' },
  { name: '左单引号', code_point: 0x2018, category: 'punctuation', note: '中文弯引号' },
  { name: '右单引号', code_point: 0x2019, category: 'punctuation', note: '中文弯引号' },
  { name: '破折号', code_point: 0x2014, category: 'punctuation', note: '中文破折号' },
  { name: '省略号', code_point: 0x2026, category: 'punctuation', note: '中文省略号' },
  { name: '顿号', code_point: 0x3001, category: 'punctuation', note: '中文并列停顿' },
  { name: '全角逗号', code_point: 0xff0c, category: 'punctuation', note: '中文逗号' },
  { name: '全角句号', code_point: 0x3002, category: 'punctuation', note: '中文句号' },
  { name: '间隔号', code_point: 0x00b7, category: 'punctuation', note: '人名分隔' },
  { name: '项目符号', code_point: 0x2022, category: 'punctuation', note: '圆点项目符号' },
  // 法务
  { name: '版权', code_point: 0x00a9, category: 'legal', note: '版权标记' },
  { name: '注册商标', code_point: 0x00ae, category: 'legal', note: '注册商标标记' },
  { name: '商标', code_point: 0x2122, category: 'legal', note: '未注册商标标记' },
  { name: '章节号', code_point: 0x00a7, category: 'legal', note: '法条章节号' },
  // 单位
  { name: '度数', code_point: 0x00b0, category: 'unit', note: '角度/温度符号' },
  { name: '摄氏度', code_point: 0x2103, category: 'unit', note: '摄氏温标单字符形式' },
  { name: '千分号', code_point: 0x2030, category: 'unit', note: '千分之几' },
  // 数学
  { name: '正负号', code_point: 0x00b1, category: 'math', note: '加减并用' },
  { name: '乘号', code_point: 0x00d7, category: 'math', note: '乘号' },
  { name: '除号', code_point: 0x00f7, category: 'math', note: '除号' },
  { name: '不等号', code_point: 0x2260, category: 'math', note: '不相等' },
  { name: '约等于', code_point: 0x2248, category: 'math', note: '约等于' },
  { name: '小于等于', code_point: 0x2264, category: 'math', note: '小于等于' },
  { name: '大于等于', code_point: 0x2265, category: 'math', note: '大于等于' },
  { name: '无穷', code_point: 0x221e, category: 'math', note: '无穷大' },
  { name: '求和', code_point: 0x2211, category: 'math', note: 'N 元求和符号' },
  // 货币
  { name: '欧元', code_point: 0x20ac, category: 'currency', note: '欧元' },
  { name: '英镑', code_point: 0x00a3, category: 'currency', note: '英镑' },
  { name: '日元', code_point: 0x00a5, category: 'currency', note: '日元/人民币符号' },
  // 箭头
  { name: '左箭头', code_point: 0x2190, category: 'arrow', note: '←' },
  { name: '右箭头', code_point: 0x2192, category: 'arrow', note: '→' },
  { name: '左右箭头', code_point: 0x2194, category: 'arrow', note: '↔' },
  { name: '上下箭头', code_point: 0x2195, category: 'arrow', note: '↕' },
];

/** 常用符号表（**码位即真值**；`char` 由码位派生）。 */
export const SPECIAL_SYMBOLS: readonly SymbolSpec[] = Object.freeze(
  SYMBOL_DEFINITIONS.map((definition) =>
    Object.freeze({
      name: definition.name,
      char: String.fromCodePoint(definition.code_point),
      code_point: definition.code_point,
      category: definition.category,
      note: definition.note,
    }),
  ),
);

/** 按码位查符号；表外返回 `null`（**不猜**）。 */
export function symbolByCodePoint(codePoint: number): SymbolSpec | null {
  return SPECIAL_SYMBOLS.find((spec) => spec.code_point === codePoint) ?? null;
}

/** 按中文名查符号；查不到返回 `null`（**不做模糊匹配**）。 */
export function symbolByName(name: string): SymbolSpec | null {
  return SPECIAL_SYMBOLS.find((spec) => spec.name === name) ?? null;
}

/** 某个类别的全部符号。 */
export function symbolsByCategory(category: SymbolCategory): readonly SymbolSpec[] {
  return SPECIAL_SYMBOLS.filter((spec) => spec.category === category);
}

/** 该码位是否为不换行空格族（NBSP / 窄 NBSP）。 */
export function isNoBreakSpace(codePoint: number): boolean {
  return codePoint === 0x00a0 || codePoint === 0x202f;
}

/** 文本 → 码位序列（**按 Unicode 码点**，代理对算一个）。 */
export function readCodePoints(text: string): readonly number[] {
  return Array.from(text, (char) => char.codePointAt(0) ?? 0);
}

/**
 * 码位序列 → 文本。
 *
 * **必须**用本函数而不是 `points.join('')`：`join` 会把每个数字转成十进制字符串，
 * 于是 `[20013, 65]` 变成 `"20013,65"` 而不是 `"中A"`。这类错误不会抛异常，
 * 只会让统计数字悄悄变成 0——所以有一个"码位与文本互为逆运算"的用例钉住它。
 */
export function codePointsToText(points: readonly number[]): string {
  let out = '';
  for (const codePoint of points) out += String.fromCodePoint(codePoint);
  return out;
}

/** 文本里某码位出现次数。 */
export function countCodePoint(text: string, codePoint: number): number {
  return readCodePoints(text).filter((value) => value === codePoint).length;
}

/** 码位 → 人类可读记法（`U+00A0`）。 */
export function formatCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

function isValidCodePoint(codePoint: number): boolean {
  return (
    Number.isInteger(codePoint) &&
    codePoint >= 0 &&
    codePoint <= 0x10ffff &&
    // 代理区不是合法码位：单写一个代理码元会产出无效 UTF-16 串
    !(codePoint >= 0xd800 && codePoint <= 0xdfff)
  );
}

export interface SymbolInsertion {
  readonly model: DocumentModel;
  readonly char: string;
  readonly code_point: number;
  /** 实际插入的位置（每个范围一处，`start..end` 为插入后的码位区间）。 */
  readonly positions: readonly { readonly node_id: string; readonly start: number; readonly end: number }[];
}

/**
 * 在选区范围内插入一个特殊字符。
 *
 * - 选区必须**当前有效**（R114/R143）：过期 / revision 不符一律拒绝，绝不把旧偏移硬套到新文本；
 * - 插入点沿用所在 run 的字符格式（与选区包的替换语义一致，R147/R151）；
 * - 范围完整包含软换行或域时 `unsupported`（目标不可切分，绝不破坏结构）；
 * - 成功时 revision +1（一次操作 = 一次事务，R138）。
 */
export function insertSymbol(model: DocumentModel, selection: Selection, codePoint: number): Result<SymbolInsertion> {
  if (typeof codePoint !== 'number' || !isValidCodePoint(codePoint)) {
    return fail('invalid_query', `非法码位：${String(codePoint)}（必须是 0–0x10FFFF 的整数，且不含代理区）`, {
      extra: { codePoint: String(codePoint) },
    });
  }
  const spec = symbolByCodePoint(codePoint);
  if (spec === null) {
    return fail(
      'unsupported',
      `码位 ${formatCodePoint(codePoint)} 不在常用符号表内：本操作只插入表内符号。`,
      { extra: { codePoint: formatCodePoint(codePoint) } },
    );
  }

  const current = requireCurrentSelection(selection, model);
  if (!current.ok) return current;
  if (selection.ranges.length === 0) {
    return fail('empty_range', '选区没有任何范围，无法插入符号。', { extra: { ranges: 0 } });
  }

  let next = model;
  const positions: { node_id: string; start: number; end: number }[] = [];

  for (const range of selection.ranges) {
    const paragraph = requireParagraph(next, range.node_id);
    if (!paragraph.ok) return paragraph;
    const total = buildInlineTextMap(paragraph.value.inlines).total;
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.start < 0 ||
      range.end < range.start ||
      range.end > total
    ) {
      return fail(
        'invalid_range',
        `范围 [${String(range.start)}, ${String(range.end)}) 超出段落码位长度 ${String(total)}。`,
        { extra: { node_id: range.node_id, start: range.start, end: range.end, total } },
      );
    }

    const replaced = replaceRangeInInlines(paragraph.value.inlines, range.start, range.end, spec.char);
    if (!replaced.ok) return replaced;

    const updated = replaceParagraph(next, range.node_id, { ...paragraph.value, inlines: replaced.value });
    if (!updated.ok) return updated;
    next = updated.value;
    positions.push({ node_id: range.node_id, start: range.start, end: range.start + 1 });
  }

  return succeed({
    model: { ...next, revision: model.revision + 1 },
    char: spec.char,
    code_point: codePoint,
    positions,
  });
}

/** 按名字插入（查不到名字即 `not_found`）。 */
export function insertSymbolByName(model: DocumentModel, selection: Selection, name: string): Result<SymbolInsertion> {
  const spec = symbolByName(name);
  if (spec === null) {
    return fail('not_found', `符号表里没有名为 "${name}" 的符号。`, { expression: name });
  }
  return insertSymbol(model, selection, spec.code_point);
}

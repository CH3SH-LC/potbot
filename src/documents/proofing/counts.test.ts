/**
 * 字数与统计单测（WF-094）。
 *
 * ## 这些期望值是**按口径手推**的，不是从实现里抄的
 *
 * 判据要求"口径写死在测试里且复算一致"。因此下面每一条期望值都先按 `counts.ts` 文件头的
 * 口径表逐字符数一遍，再写成断言；如果实现与口径打架，**先查口径与实现谁错**，
 * 而不是把实现输出回填成期望值（那样测试就只是把实现抄了一遍）。
 *
 * 混排样例（15 个码位）：
 * ```text
 * 中 A 文 1 2 ␠ a b - c ␠ 好 😀 NBSP x
 * └中文字 3┘ └数字 2┘ └西文词 4（A / 12 / ab-c / x）┘ └emoji 1┘ └空白 3┘ └ASCII 字母 5┘ └标点 1┘
 * ```
 * 注意 `12` 也算**一个西文词**（ASCII 数字属于词字符）——这正是"口径必须写死"的例子。
 */

import { describe, expect, it } from 'vitest';

import { cell, document, paragraphOfRuns, row, table } from '../selection/testing.js';
import type { Result, Selection } from '../selection/types.js';
import {
  PAGE_COUNT_UNVERIFIED_REASON,
  addCounts,
  classifyCodePoint,
  countDocument,
  countLatinWords,
  countSelection,
  countText,
  isEmojiCodePoint,
  isWhitespaceCodePoint,
  pageCountFromEngine,
  pageCountUnverified,
} from './counts.js';
import { codePointsToText, readCodePoints } from './symbols.js';

const NBSP = String.fromCodePoint(0x00a0);
const PICTOGRAPH = String.fromCodePoint(0x1f600); // 😀
const FAMILY = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467); // 人+ZWJ+人+ZWJ+人
const FLAG = String.fromCodePoint(0x1f1e8, 0x1f1f3); // 区域指示符对
const HEART = String.fromCodePoint(0x2764, 0xfe0f); // 心 + 变体选择符

/** 中英混排 + emoji + 不间断空格。 */
const MIXED = `中A文12 ab-c 好${PICTOGRAPH}${NBSP}x`;

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`期望成功，实际失败：${result.code} / ${result.message}`);
  return result.value;
}

describe('口径写死：中英混排 + emoji 的复算', () => {
  it('样例文本逐项计数与手推一致', () => {
    // 15 个码位，但 😀 占 2 个 UTF-16 码元 ⇒ `length` 是 16（R102 要求区分这两件事）
    expect(MIXED.length).toBe(16);
    expect(countText(MIXED)).toEqual({
      code_points: 15,
      cjk_chars: 3, // 中、文、好
      latin_words: 4, // A、12、ab-c、x（数字也是词字符）
      latin_letters: 5, // A、a、b、c、x
      digits: 2, // 1、2
      emoji: 1, // 😀
      punctuation: 1, // 连字符 `-`
      whitespace: 3, // 两个 ASCII 空格 + 一个 NBSP
      other: 0,
    });
  });

  it('各分类互不重叠地划分全部码位（复算自洽）', () => {
    const counts = countText(MIXED);
    const partition =
      counts.cjk_chars +
      counts.emoji +
      counts.whitespace +
      counts.latin_letters +
      counts.digits +
      counts.punctuation +
      counts.other;
    expect(partition).toBe(counts.code_points);
    expect(counts.code_points).toBe(readCodePoints(MIXED).length);
  });

  it('emoji 口径：ZWJ 家庭按图形码位计 3、连接符归 other，不聚合成一个字素簇', () => {
    expect(countText(FAMILY)).toEqual({
      code_points: 5,
      cjk_chars: 0,
      latin_words: 0,
      latin_letters: 0,
      digits: 0,
      emoji: 3,
      punctuation: 0,
      whitespace: 0,
      other: 2, // 两个 ZWJ（U+200D）
    });
  });

  it('emoji 口径：区域指示符国旗计 2；变体选择符归 other', () => {
    expect(countText(FLAG).emoji).toBe(2);
    expect(countText(HEART).emoji).toBe(1);
    expect(countText(HEART).other).toBe(1);
    expect(countText(FAMILY + FLAG + HEART)).toEqual({
      code_points: 9,
      cjk_chars: 0,
      latin_words: 0,
      latin_letters: 0,
      digits: 0,
      emoji: 6,
      punctuation: 0,
      whitespace: 0,
      other: 3,
    });
  });

  it('西文词口径：连接符只在字母数字之间才并进同一个词', () => {
    expect(countLatinWords(readCodePoints('ab-c'))).toBe(1);
    expect(countLatinWords(readCodePoints('a - b'))).toBe(2); // 孤立的 `-` 不是词
    expect(countLatinWords(readCodePoints('ab-cd-ef'))).toBe(1);
    expect(countLatinWords(readCodePoints("don't"))).toBe(1);
    expect(countLatinWords(readCodePoints('2026-10-02'))).toBe(1);
    expect(countLatinWords(readCodePoints('a1b2'))).toBe(1);
    expect(countLatinWords(readCodePoints('中文'))).toBe(0);
    expect(countLatinWords(readCodePoints('alpha beta'))).toBe(2);
  });

  it('空白口径：NBSP 是空白但不是普通空格；全角空格也是空白', () => {
    expect(isWhitespaceCodePoint(0x00a0)).toBe(true);
    expect(isWhitespaceCodePoint(0x0020)).toBe(true);
    expect(isWhitespaceCodePoint(0x3000)).toBe(true);
    expect(isWhitespaceCodePoint(0x200d)).toBe(false); // ZWJ 不是空白
    expect(classifyCodePoint(0x00a0)).toBe('whitespace');
    expect(classifyCodePoint(0x200d)).toBe('other');
    expect(classifyCodePoint(0xff0c)).toBe('punctuation'); // 全角逗号
    expect(classifyCodePoint(0x3001)).toBe('punctuation'); // 顿号
    expect(classifyCodePoint(0x4e2d)).toBe('cjk');
    expect(classifyCodePoint(0x1f600)).toBe('emoji');
    expect(isEmojiCodePoint(0x1f1e8)).toBe(true);
    expect(isEmojiCodePoint(0x2600)).toBe(true);
    expect(isEmojiCodePoint(0x4e2d)).toBe(false);
  });

  it('码位与文本互为逆运算（挡住 `join("")` 那类"数字变字符串"的坑）', () => {
    for (const sample of [MIXED, FAMILY + FLAG + HEART, '', 'ascii only']) {
      expect(codePointsToText(readCodePoints(sample))).toBe(sample);
    }
    // 反例说明：直接 join 会把码位数字连成十进制串，读出来完全不是原文
    expect([0x4e2d, 0x41].join('')).not.toBe('中A');
    expect(codePointsToText([0x4e2d, 0x41])).toBe('中A');
  });

  it('空串全零；addCounts 逐字段相加', () => {
    expect(countText('')).toEqual({
      code_points: 0,
      cjk_chars: 0,
      latin_words: 0,
      latin_letters: 0,
      digits: 0,
      emoji: 0,
      punctuation: 0,
      whitespace: 0,
      other: 0,
    });
    const sum = addCounts([countText('中A'), countText('文B')]);
    expect(sum.cjk_chars).toBe(2);
    expect(sum.latin_letters).toBe(2);
    expect(sum.code_points).toBe(4);
  });
});

describe('选区与整篇统计', () => {
  it('选区统计按范围切片计数，范围外不算进来', () => {
    const model = document([paragraphOfRuns('p1', [['r1', '中A文12']])]);
    const selection: Selection = {
      document_id: 'doc-1',
      base_revision: 1,
      ranges: [{ node_id: 'p1', start: 0, end: 3 }], // 中A文
    };
    const stats = unwrap(countSelection(model, selection));
    expect(stats.per_range).toHaveLength(1);
    expect(stats.total.cjk_chars).toBe(2);
    expect(stats.total.latin_letters).toBe(1);
    expect(stats.total.digits).toBe(0); // "12" 在范围外
  });

  it('选区过期 ⇒ stale_revision；范围越界 ⇒ invalid_range', () => {
    const model = document([paragraphOfRuns('p1', [['r1', '中A']])], { revision: 3 });
    const stale = countSelection(model, { document_id: 'doc-1', base_revision: 2, ranges: [{ node_id: 'p1', start: 0, end: 1 }] });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('stale_revision');

    const outOfRange = countSelection(model, {
      document_id: 'doc-1',
      base_revision: 3,
      ranges: [{ node_id: 'p1', start: 0, end: 9 }],
    });
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) expect(outOfRange.code).toBe('invalid_range');
  });

  it('整篇统计：段落数含表格内段落，表格数只算顶层', () => {
    const model = document([
      paragraphOfRuns('p1', [['r1', '中A']]),
      paragraphOfRuns('p2', [['r2', '文']]),
      table('t1', [
        row('row1', [cell('c11', [paragraphOfRuns('c11p', [['r', '甲']])]), cell('c12', [paragraphOfRuns('c12p', [['r', '乙']])])]),
        row('row2', [cell('c21', [paragraphOfRuns('c21p', [['r', '丙']])]), cell('c22', [paragraphOfRuns('c22p', [['r', '丁']])])]),
      ]),
    ]);

    const stats = countDocument(model);
    expect(stats.paragraphs).toBe(6); // 2 个正文段 + 4 个单元格段
    expect(stats.tables).toBe(1);
    expect(stats.text.cjk_chars).toBe(6); // 中 + 文 + 甲 + 乙 + 丙 + 丁
  });
});

describe('页数：没有排版引擎就标"未验证"（R158）', () => {
  it('整篇统计的页数恒为 unverified，且带原因', () => {
    const model = document([paragraphOfRuns('p1', [['r1', '正文']])]);
    const stats = countDocument(model);
    expect(stats.page_count.status).toBe('unverified');
    if (stats.page_count.status === 'unverified') {
      expect(stats.page_count.reason).toBe(PAGE_COUNT_UNVERIFIED_REASON);
      expect(stats.page_count.reason).toContain('R158');
    }
    // 类型上就没有"编一个页数"的出路
    expect(Object.keys(stats.page_count)).not.toContain('pages');
  });

  it('pageCountUnverified 可自定义原因，但仍是 unverified', () => {
    const result = pageCountUnverified('本机未安装排版引擎');
    expect(result).toEqual({ status: 'unverified', reason: '本机未安装排版引擎' });
  });

  it('只有带引擎名与证据的读数才能进 verified', () => {
    const verified = unwrap(
      pageCountFromEngine({ engine: 'Microsoft Word 16.0.20430', pages: 3, evidence: 'D:/evidence/E1/page-count.txt' }),
    );
    expect(verified).toEqual({
      status: 'verified',
      pages: 3,
      engine: 'Microsoft Word 16.0.20430',
      evidence: 'D:/evidence/E1/page-count.txt',
    });
  });

  it('反例：缺引擎名 / 缺证据 / 页数非正整数，一律拒绝', () => {
    expect(pageCountFromEngine({ engine: '', pages: 3, evidence: 'x' }).ok).toBe(false);
    expect(pageCountFromEngine({ engine: 'Word', pages: 3, evidence: '' }).ok).toBe(false);
    expect(pageCountFromEngine({ engine: 'Word', pages: 0, evidence: 'x' }).ok).toBe(false);
    expect(pageCountFromEngine({ engine: 'Word', pages: 2.5, evidence: 'x' }).ok).toBe(false);
  });
});

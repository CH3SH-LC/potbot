/**
 * 文本与段落编辑用例（PPT-04）。
 *
 * ## 反向对照（本文件的核心）
 *
 * 「精确选区保留未选内容」的反面是**整段重写**。用例对选中 `[4,7)` 之后的前缀 run 断言两件事：
 * ① 字符内容一字不差；② 它的 `style` **是原样式对象本身**（`toBe`）。任何"把整段重新造一遍 style"
 * 的实现都会在 `toBe` 上翻车。
 *
 * ## 行距 / 缩进的接线状态（如实标注）
 *
 * - `level`（缩进层级 / 多级列表）与 `bullet`（列表）是**已有通道**，经渲染 / 导入往返保持 —— 真字节用例覆盖；
 * - `line_spacing` / `indent_emu` 是本模块挂在 `Paragraph` 上的**扩展字段**，`render.ts` 不发射
 *   `a:lnSpc` / `a:marL` ⇒ **导出未接线**，用例如实断言"往返后丢失"，标 **未验证**。
 */

import { describe, expect, it } from 'vitest';

import { addShape, addSlide } from './operations.js';
import type { ParagraphTarget, RunTarget } from './operations.js';
import { literalText, transform, type Paragraph, type Presentation, type RunStyle, type Shape, type TextBody } from './model.js';
import { emptyPresentation, renderPresentation } from './render.js';
import { importPresentation } from './roundtrip.js';
import {
  TextEditError,
  appendRuns,
  assertQueryValid,
  deleteParagraph,
  duplicateParagraph,
  findText,
  indentEmuOf,
  indentParagraph,
  insertParagraph,
  lineSpacingOf,
  mergeSelectionStyle,
  paragraphPlainText,
  replaceText,
  setAlignment,
  setBullet,
  setIndentEmu,
  setLineSpacing,
  setParagraphLevel,
  setSelectionBold,
  setSelectionColor,
  setSelectionFont,
  setSelectionFontSize,
  setSelectionItalic,
  setShapeBullets,
  splitRunForSelection,
  styleParagraph,
  styleSelection,
  styleShape,
  toggleBullet,
} from './text.js';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

const ORIGINAL_STYLE: RunStyle = Object.freeze({ size_pt: 18, bold: true, color: '112233' });

/** 两段文本框：段 0 = [带样式的 'ABCDEFGHI'][无样式 '尾巴']；段 1 = level 1 列表项。 */
function richBody(): TextBody {
  return {
    paragraphs: [
      {
        runs: [
          { source: { kind: 'literal', text: 'ABCDEFGHI' }, style: ORIGINAL_STYLE },
          { source: { kind: 'literal', text: '尾巴' } },
        ],
        level: 0,
        alignment: 'left',
        bullet: false,
      },
      { runs: [{ source: { kind: 'literal', text: '第二段' } }], level: 1, alignment: 'left', bullet: true },
    ],
  };
}

function deckWith(text: TextBody): { readonly deck: Presentation; readonly ref: { slide_id: number; shape_id: number } } {
  const added = addSlide(emptyPresentation('p1', '文本测试'));
  const shape: Shape = {
    kind: 'text_box',
    shape_id: 2,
    name: 'Body',
    transform: transform(0, 0, 3000000, 1000000),
    text,
  };
  const deck = addShape(added.presentation, added.slide_id, shape);
  return { deck, ref: { slide_id: added.slide_id, shape_id: 2 } };
}

function bodyOf(presentation: Presentation): TextBody {
  const shape = presentation.slides[0]?.shapes[0];
  if (shape?.kind !== 'text_box') throw new Error('应当是文本框');
  return shape.text;
}

function textOfRun(presentation: Presentation, paragraphIndex: number, runIndex: number): string {
  const run = bodyOf(presentation).paragraphs[paragraphIndex]?.runs[runIndex];
  if (run === undefined) throw new Error('run 不存在');
  return run.source.kind === 'literal' ? run.source.text : '（事实引用）';
}

const R0: RunTarget = { slide_id: 1, shape_id: 2, paragraph_index: 0, run_index: 0 };
const P0: ParagraphTarget = { slide_id: 1, shape_id: 2, paragraph_index: 0 };
const P1: ParagraphTarget = { slide_id: 1, shape_id: 2, paragraph_index: 1 };

// ---------------------------------------------------------------------------
// 精确选区
// ---------------------------------------------------------------------------

describe('PPT-04：精确选区只改选中字符（反向对照：整段重写会被挡）', () => {
  it('选中 [3,6) 加粗：前缀/后缀字符与样式（对象引用）原样保留', () => {
    const { deck } = deckWith(richBody());
    const before = bodyOf(deck);
    const edited = setSelectionBold(deck, R0, 3, 6, true);
    const after = bodyOf(edited);

    // 拆成 [ABC][DEF][GHI] + 原第二个 run。
    expect(after.paragraphs[0]?.runs.map((run) => (run.source.kind === 'literal' ? run.source.text : ''))).toEqual([
      'ABC',
      'DEF',
      'GHI',
      '尾巴',
    ]);
    // 前缀 / 后缀：字符没动，样式**是原对象本身**（反向对照点：整段重写会造新样式对象）。
    expect(after.paragraphs[0]?.runs[0]?.style).toBe(ORIGINAL_STYLE);
    expect(after.paragraphs[0]?.runs[2]?.style).toBe(ORIGINAL_STYLE);
    expect(after.paragraphs[0]?.runs[0]?.style).not.toEqual(expect.objectContaining({ bold: true, italic: true }));
    // 只有选中段加了粗（其余字段继承）。
    expect(after.paragraphs[0]?.runs[1]?.style).toEqual({ size_pt: 18, bold: true, color: '112233' });

    // 同段另一个 run、第二段、整个对象/页结构引用相等。
    expect(after.paragraphs[0]?.runs[3]).toBe(before.paragraphs[0]?.runs[1]);
    expect(after.paragraphs[1]).toBe(before.paragraphs[1]);
    expect(edited.slides[0]?.shapes).toHaveLength(1);
    // 原模型没被污染。
    expect(bodyOf(deck).paragraphs[0]?.runs).toHaveLength(2);
  });

  it('斜体 / 颜色 / 字号 / 字体各自只作用于选中段；合并样式继承未给字段', () => {
    const { deck } = deckWith(richBody());

    const italic = setSelectionItalic(deck, R0, 3, 6, true);
    expect(bodyOf(italic).paragraphs[0]?.runs[1]?.style).toEqual({ size_pt: 18, bold: true, color: '112233', italic: true });

    const colored = setSelectionColor(deck, R0, 0, 3, 'FF0000');
    expect(bodyOf(colored).paragraphs[0]?.runs[0]?.style).toEqual({ size_pt: 18, bold: true, color: 'FF0000' });

    const sized = setSelectionFontSize(deck, R0, 6, 9, 40);
    expect(bodyOf(sized).paragraphs[0]?.runs[1]?.style).toEqual({ size_pt: 40, bold: true, color: '112233' });

    const fonted = setSelectionFont(deck, R0, 0, 9, '思源黑体');
    expect(bodyOf(fonted).paragraphs[0]?.runs[0]?.style).toEqual({ size_pt: 18, bold: true, color: '112233', font: '思源黑体' });
  });

  it('整段选中不产生多余拆分；mergeSelectionStyle 保留其他字段', () => {
    const { deck } = deckWith(richBody());
    const whole = styleSelection(deck, R0, 0, 9, { bold: false });
    const runs = bodyOf(whole).paragraphs[0]?.runs ?? [];
    expect(runs).toHaveLength(2); // 未拆分
    expect(runs[0]?.style).toEqual({ bold: false });
    expect(runs[1]).toBe(bodyOf(deck).paragraphs[0]?.runs[1]);

    const merged = mergeSelectionStyle(deck, R0, 3, 6, { italic: true });
    expect(bodyOf(merged).paragraphs[0]?.runs[1]?.style).toEqual({ size_pt: 18, bold: true, color: '112233', italic: true });
  });

  it('splitRunForSelection：边界 / 空选区 / 越界', () => {
    const paragraph = richBody().paragraphs[0] as Paragraph;
    const head = splitRunForSelection(paragraph, 0, 0, 3);
    expect(head.paragraph.runs.map((r) => (r.source.kind === 'literal' ? r.source.text : ''))).toEqual(['ABC', 'DEFGHI', '尾巴']);
    expect(head.selected_run_index).toBe(0);

    const empty = splitRunForSelection(paragraph, 0, 5, 5);
    expect(empty.selected_length).toBe(0);
    expect(empty.paragraph.runs[empty.selected_run_index]?.source).toEqual({ kind: 'literal', text: '' });

    expect(() => splitRunForSelection(paragraph, 0, 9, 20)).toThrow(TextEditError);
    expect(() => splitRunForSelection(paragraph, 5, 0, 1)).toThrow(TextEditError);
  });

  it('事实引用 run 不能按字符选区编辑（具名报错，不静默当字面量）', () => {
    const body: TextBody = {
      paragraphs: [
        { runs: [{ source: { kind: 'fact', fact_key: 'k1' }, style: { bold: true } }], level: 0, alignment: 'left', bullet: false },
      ],
    };
    const { deck } = deckWith(body);
    expect(() => styleSelection(deck, R0, 0, 1, { bold: false })).toThrow(TextEditError);
    try {
      styleSelection(deck, R0, 0, 1, { bold: false });
    } catch (error) {
      expect((error as TextEditError).reason).toBe('run_is_not_literal');
    }
  });
});

// ---------------------------------------------------------------------------
// 整段落 / 整形状样式
// ---------------------------------------------------------------------------

describe('PPT-04：整段与整框样式', () => {
  it('styleParagraph 换掉该段全部 run 的样式，其余段落引用不变', () => {
    const { deck } = deckWith(richBody());
    const styled = styleParagraph(deck, P0, { bold: true, size_pt: 12 });
    expect(bodyOf(styled).paragraphs[0]?.runs.map((run) => run.style)).toEqual([
      { bold: true, size_pt: 12 },
      { bold: true, size_pt: 12 },
    ]);
    expect(bodyOf(styled).paragraphs[1]).toBe(bodyOf(deck).paragraphs[1]);
  });

  it('styleShape 传 null 清空全框样式', () => {
    const { deck } = deckWith(richBody());
    const cleared = styleShape(deck, { slide_id: 1, shape_id: 2 }, null);
    for (const paragraph of bodyOf(cleared).paragraphs) {
      for (const run of paragraph.runs) {
        expect(run.style).toBeUndefined();
      }
    }
  });

  it('对不支持文本的对象做文本编辑 ⇒ 具名报错', () => {
    const added = addSlide(emptyPresentation('p1', 'x'));
    const picture: Shape = {
      kind: 'picture',
      shape_id: 5,
      name: 'Pic',
      transform: transform(0, 0, 100, 100),
      media_path: 'ppt/media/image1.png',
      alt_text: '',
      crop: null,
    };
    const deck = addShape(added.presentation, added.slide_id, picture);
    try {
      styleShape(deck, { slide_id: added.slide_id, shape_id: 5 }, { bold: true });
      throw new Error('应当报错');
    } catch (error) {
      expect(error).toBeInstanceOf(TextEditError);
      expect((error as TextEditError).reason).toBe('shape_has_no_text');
    }
  });
});

// ---------------------------------------------------------------------------
// 段落结构：对齐 / 缩进 / 列表 / 多级列表
// ---------------------------------------------------------------------------

describe('PPT-04：段落结构（对齐 / 缩进层级 / 列表 / 多级列表）', () => {
  it('setAlignment 只动该段；setParagraphLevel 越界报错；indentParagraph 钳制在 [0,8]', () => {
    const { deck } = deckWith(richBody());
    const aligned = setAlignment(deck, P0, 'justify');
    expect(bodyOf(aligned).paragraphs[0]?.alignment).toBe('justify');
    expect(bodyOf(aligned).paragraphs[1]).toBe(bodyOf(deck).paragraphs[1]);

    const levelled = setParagraphLevel(deck, P0, 3);
    expect(bodyOf(levelled).paragraphs[0]?.level).toBe(3);
    expect(() => setParagraphLevel(deck, P0, 9)).toThrow(TextEditError);

    expect(bodyOf(indentParagraph(deck, P0, 1)).paragraphs[0]?.level).toBe(1);
    // 已在最外层再"减少缩进" ⇒ 钳到 0（不报错）。
    expect(bodyOf(indentParagraph(deck, P0, -5)).paragraphs[0]?.level).toBe(0);
    expect(bodyOf(indentParagraph(deck, P1, 20)).paragraphs[1]?.level).toBe(8);
  });

  it('setBullet / toggleBullet / setShapeBullets 控制列表', () => {
    const { deck } = deckWith(richBody());
    expect(bodyOf(setBullet(deck, P0, true)).paragraphs[0]?.bullet).toBe(true);
    expect(bodyOf(toggleBullet(deck, P1)).paragraphs[1]?.bullet).toBe(false);

    const all = setShapeBullets(deck, { slide_id: 1, shape_id: 2 }, true);
    expect(bodyOf(all).paragraphs.map((paragraph) => paragraph.bullet)).toEqual([true, true]);
  });

  it('插入 / 删除 / 复制段落与追加 run', () => {
    const { deck } = deckWith(richBody());
    const paragraph: Paragraph = { runs: [{ source: { kind: 'literal', text: '新段' } }], level: 2, alignment: 'right', bullet: true };

    const inserted = insertParagraph(deck, { slide_id: 1, shape_id: 2 }, paragraph, { at: 1 });
    expect(bodyOf(inserted).paragraphs.map((p) => (p.runs[0]?.source.kind === 'literal' ? p.runs[0].source.text : ''))).toEqual([
      'ABCDEFGHI',
      '新段',
      '第二段',
    ]);
    expect(bodyOf(inserted).paragraphs[0]).toBe(bodyOf(deck).paragraphs[0]);

    expect(() => insertParagraph(deck, { slide_id: 1, shape_id: 2 }, paragraph, { at: 9 })).toThrow(TextEditError);

    const deleted = deleteParagraph(deck, P0);
    expect(bodyOf(deleted).paragraphs).toHaveLength(1);
    expect(bodyOf(deleted).paragraphs[0]).toBe(bodyOf(deck).paragraphs[1]);

    const duplicated = duplicateParagraph(deck, P1);
    expect(bodyOf(duplicated).paragraphs).toHaveLength(3);
    expect(bodyOf(duplicated).paragraphs[2]).toEqual(bodyOf(deck).paragraphs[1]);

    const appended = appendRuns(deck, P1, [{ source: { kind: 'literal', text: '＋尾巴' }, style: { italic: true } }]);
    expect(bodyOf(appended).paragraphs[1]?.runs).toHaveLength(2);
    expect(bodyOf(appended).paragraphs[0]).toBe(bodyOf(deck).paragraphs[0]);
  });
});

// ---------------------------------------------------------------------------
// 行距 / 显式缩进（模型层扩展，未接线到渲染）
// ---------------------------------------------------------------------------

describe('PPT-04：行距 / 显式缩进（模型层扩展，导出未接线，未验证）', () => {
  it('模型层可读写 / 可清除', () => {
    const { deck } = deckWith(richBody());
    const spaced = setLineSpacing(deck, P0, { kind: 'percent', value: 150 });
    expect(lineSpacingOf(bodyOf(spaced).paragraphs[0] as Paragraph)).toEqual({ kind: 'percent', value: 150 });
    expect(lineSpacingOf(bodyOf(spaced).paragraphs[1] as Paragraph)).toBeNull(); // 只动该段

    const indented = setIndentEmu(deck, P0, 457200);
    expect(indentEmuOf(bodyOf(indented).paragraphs[0] as Paragraph)).toBe(457200);

    const cleared = setLineSpacing(deck, P0, null);
    expect(lineSpacingOf(bodyOf(cleared).paragraphs[0] as Paragraph)).toBeNull();
    expect(() => setLineSpacing(deck, P0, { kind: 'points', value: 0 })).toThrow(TextEditError);
    expect(() => setIndentEmu(deck, P0, -1)).toThrow(TextEditError);
  });

  it('渲染 → 导入后行距/显式缩进丢失（render.ts 未发射 a:lnSpc / a:marL ⇒ 导出未接线）', () => {
    const { deck } = deckWith(richBody());
    const edited = setLineSpacing(setIndentEmu(deck, P0, 457200), P0, { kind: 'percent', value: 150 });
    const reread = importPresentation(renderPresentation(edited).bytes);
    // 如实断言当前事实：这两个扩展字段**不落 PPTX**。
    expect(lineSpacingOf(bodyOf(reread.presentation).paragraphs[0] as Paragraph)).toBeNull();
    expect(indentEmuOf(bodyOf(reread.presentation).paragraphs[0] as Paragraph)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 真实字节：已有通道（样式 / 层级 / 列表）往返保持
// ---------------------------------------------------------------------------

describe('PPT-04：已接线的样式与段落属性经真实字节往返保持', () => {
  it('加粗斜体 / 字号 / 颜色 / 字体 / 缩进层级 / 居中 / 列表 渲染后读回一致', () => {
    const body: TextBody = {
      paragraphs: [
        {
          runs: [{ source: { kind: 'literal', text: '往返' }, style: { bold: true, italic: true, size_pt: 22, color: 'AABBCC', font: '宋体' } }],
          level: 2,
          alignment: 'center',
          bullet: true,
        },
        { runs: [{ source: { kind: 'literal', text: '非列表' } }], level: 0, alignment: 'left', bullet: false },
      ],
    };
    const { deck } = deckWith(body);
    const reread = importPresentation(renderPresentation(deck).bytes);
    const paragraphs = bodyOf(reread.presentation).paragraphs;

    expect(paragraphs[0]?.runs[0]?.style).toEqual({ bold: true, italic: true, size_pt: 22, color: 'AABBCC', font: '宋体' });
    expect(paragraphs[0]?.level).toBe(2);
    expect(paragraphs[0]?.alignment).toBe('center');
    expect(paragraphs[0]?.bullet).toBe(true);
    expect(paragraphs[1]?.bullet).toBe(false);
    expect(paragraphs[1]?.alignment).toBe('left');
  });

  it('精确选区改样式后导出，只影响选中字符（字节读回）', () => {
    const { deck } = deckWith(richBody());
    const edited = setSelectionColor(deck, R0, 3, 6, 'FF0000');
    const reread = importPresentation(renderPresentation(edited).bytes);
    const runs = bodyOf(reread.presentation).paragraphs[0]?.runs ?? [];
    expect(runs.map((run) => run.source.kind === 'literal' ? run.source.text : '')).toEqual(['ABC', 'DEF', 'GHI', '尾巴']);
    expect(runs[0]?.style).toEqual({ size_pt: 18, bold: true, color: '112233' });
    expect(runs[1]?.style).toEqual({ size_pt: 18, bold: true, color: 'FF0000' });
    expect(runs[2]?.style).toEqual({ size_pt: 18, bold: true, color: '112233' });
  });
});

// ---------------------------------------------------------------------------
// P-I10：查找模式（正则 / 通配符）—— 在字面量之外补查询模式
// ---------------------------------------------------------------------------

/** 单字面量 run 的段落（模式用例只关心文本坐标）。 */
function plainParagraph(text: string): Paragraph {
  return { runs: [{ source: { kind: 'literal', text } }], level: 0, alignment: 'left', bullet: false };
}

describe('P-I10：正则 / 通配符查找模式（大小写 / 全词在三种模式口径一致）', () => {
  it('regex 模式按正则匹配，命中位置与文本对得上', () => {
    const paragraph = plainParagraph('abc123ABC');
    expect(findText(paragraph, '\\d+', { mode: 'regex' })).toEqual([{ start: 3, end: 6, text: '123' }]);
    expect(findText(paragraph, '[a-c]+', { mode: 'regex' })).toEqual([{ start: 0, end: 3, text: 'abc' }]);
    // 默认大小写敏感：'abc' 不匹配 'ABC'。
    expect(findText(paragraph, 'abc', { mode: 'regex' })).toEqual([{ start: 0, end: 3, text: 'abc' }]);
    expect(findText(paragraph, 'abc', { mode: 'regex', case_sensitive: false })).toEqual([
      { start: 0, end: 3, text: 'abc' },
      { start: 6, end: 9, text: 'ABC' },
    ]);
  });

  it('regex 模式下 whole_word 仍按 [A-Za-z0-9_] 词边界二次过滤', () => {
    const paragraph = plainParagraph('foo foobar');
    expect(findText(paragraph, 'foo', { mode: 'regex' })).toHaveLength(2);
    expect(findText(paragraph, 'foo', { mode: 'regex', whole_word: true })).toEqual([
      { start: 0, end: 3, text: 'foo' },
    ]);
  });

  it('wildcard 模式：* 任意串、? 单字符，其余字符按字面量', () => {
    const paragraph = plainParagraph('axc ayc');
    expect(findText(paragraph, 'a?c', { mode: 'wildcard' })).toEqual([
      { start: 0, end: 3, text: 'axc' },
      { start: 4, end: 7, text: 'ayc' },
    ]);
    // '*' 贪婪：一路吃到最右的 'c'。
    expect(findText(paragraph, 'a*c', { mode: 'wildcard' })).toEqual([{ start: 0, end: 7, text: 'axc ayc' }]);
    // '.' 在通配符模式是字面量，不是正则元字符。
    expect(findText(plainParagraph('abc'), 'a.c', { mode: 'wildcard' })).toHaveLength(0);
    expect(findText(plainParagraph('a.c'), 'a.c', { mode: 'wildcard' })).toEqual([{ start: 0, end: 3, text: 'a.c' }]);
  });

  it('零长正则命中不计入结果（不空匹配、不死循环）', () => {
    expect(findText(plainParagraph('abc'), 'x*', { mode: 'regex' })).toEqual([]);
    expect(findText(plainParagraph('abc'), 'z?', { mode: 'wildcard' })).toEqual([]);
  });

  it('畸形正则具名报 invalid_pattern（不静默按字面量、不吞成零命中）', () => {
    expect(() => findText(plainParagraph('abc'), '(', { mode: 'regex' })).toThrow(TextEditError);
    try {
      findText(plainParagraph('abc'), '(', { mode: 'regex' });
      throw new Error('应当报错');
    } catch (error) {
      expect(error).toBeInstanceOf(TextEditError);
      expect((error as TextEditError).reason).toBe('invalid_pattern');
    }
  });

  it('assertQueryValid：空串 / 畸形正则失败；字面量模式下的元字符不报错', () => {
    expect(() => assertQueryValid('')).toThrow(TextEditError);
    expect(() => assertQueryValid('(')).not.toThrow(); // 字面量模式：'(' 就是普通字符
    expect(() => assertQueryValid('(', { mode: 'regex' })).toThrow(TextEditError);
    expect(() => assertQueryValid('[', { mode: 'wildcard' })).not.toThrow(); // 通配符里 '[' 按字面量
    try {
      assertQueryValid('');
    } catch (error) {
      expect((error as TextEditError).reason).toBe('empty_query');
    }
  });

  it('replaceText 在 regex 模式下替换全部命中', () => {
    const result = replaceText(plainParagraph('a1b2c3'), '\\d', '#', { mode: 'regex' });
    expect(result.replaced).toBe(3);
    expect(paragraphPlainText(result.paragraph)).toBe('a#b#c#');
    expect(result.matches.map((match) => match.text)).toEqual(['1', '2', '3']);
  });
});

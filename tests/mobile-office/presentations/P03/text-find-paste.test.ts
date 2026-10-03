/**
 * P03：跨 run 精确选区 / 查找替换 / 粘贴 / 多级列表（PPT-04 + PPT-14）。
 *
 * ## 这一批补的是"选区只能落在一个 run 内"这一截
 *
 * 既有 `text.ts` 的 `splitRunForSelection` / `operations.ts` 的 `replaceTextSelection`
 * 只接受**单个 run** 的字符区间。真实选区常横跨多个 run（"Hello **World**!" 里选 "o Wor"）。
 * 本批把坐标升到**段落级**（`paragraphTextMap`），查找替换 / 粘贴 / 跨 run 套样式都建在它上面。
 *
 * ## 判据一：结构性「不损其他对象格式」——用 `toBe`，不是 `toEqual`
 *
 * 跨 run 改一小段之后，用例对**未落在选区内的 run** 断言 `toBe`（引用相等）：
 * 前缀 / 后缀 run 的 `style` 也必须是**同一个对象**。任何"整段重造一遍"的实现都会在 `toBe` 翻车。
 *
 * ## 判据二：真实字节往返（独立解析，不复用待测代码自证）
 *
 * 编辑后走 `renderPresentation` 生成**真 ZIP 字节**，再用 `readZip` 直接读幻灯片 XML 断言
 * `<a:t>` 文本与 `a:pPr@lvl` —— 不只依赖 `importPresentation` 这一条读侧。
 *
 * ## 如实标注边界
 *
 * - 含**事实引用 run**的段落：字符下标在渲染期才算得出 ⇒ 按字符编辑一律**具名拒绝**（不猜、不静默跳过）；
 * - 查找范围是文本框 / 自选图形文本（组合递归），**不含**表格单元格与备注 —— 见 `findInPresentation` 文档。
 */

import { describe, expect, it } from 'vitest';

import { readZip, utf8Bytes } from '../../../../src/artifacts/ooxml/index.js';
import {
  literalText,
  transform,
  type Paragraph,
  type Presentation,
  type RunStyle,
  type Shape,
  type TextBody,
} from '../../../../src/presentations/model.js';
import {
  findInPresentation,
  findInShape,
  replaceInPresentation,
  replaceInShape,
  replaceSelectionAcrossRuns,
  pasteIntoPresentation,
  PresentationOperationError,
  addShape,
  addSlide,
} from '../../../../src/presentations/operations.js';
import { emptyPresentation, renderPresentation } from '../../../../src/presentations/render.js';
import { importPresentation } from '../../../../src/presentations/roundtrip.js';
import {
  TextEditError,
  deleteParagraphRange,
  findText,
  multilevelList,
  paragraphTextMap,
  pasteIntoBody,
  replaceParagraphRange,
  replaceText,
  selectionText,
  styleParagraphRange,
} from '../../../../src/presentations/text.js';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

const STYLE_A: RunStyle = Object.freeze({ size_pt: 18, bold: true });
const STYLE_B: RunStyle = Object.freeze({ italic: true, color: 'FF0000' });

/** 段 0 = ['Hello '][bold,18pt 'World']['!'] ；段 1 = 含事实引用的段。 */
function threePartBody(): TextBody {
  return {
    paragraphs: [
      {
        runs: [
          { source: { kind: 'literal', text: 'Hello ' }, style: STYLE_A },
          { source: { kind: 'literal', text: 'World' }, style: STYLE_B },
          { source: { kind: 'literal', text: '!' } },
        ],
        level: 0,
        alignment: 'left',
        bullet: false,
      },
      {
        runs: [{ source: { kind: 'literal', text: '第二段' } }],
        level: 0,
        alignment: 'left',
        bullet: false,
      },
    ],
  };
}

function deckWith(text: TextBody, shapeId = 2): Presentation {
  const added = addSlide(emptyPresentation('p1', 'P03'));
  const shape: Shape = {
    kind: 'text_box',
    shape_id: shapeId,
    name: 'Body',
    transform: transform(0, 0, 3000000, 1000000),
    text,
  };
  return addShape(added.presentation, added.slide_id, shape);
}

function bodyOf(presentation: Presentation): TextBody {
  const shape = presentation.slides[0]?.shapes[0];
  if (shape?.kind !== 'text_box') throw new Error('应当是文本框');
  return shape.text;
}

function paragraphAt(presentation: Presentation, index: number): Paragraph {
  const paragraph = bodyOf(presentation).paragraphs[index];
  if (paragraph === undefined) throw new Error('段落不存在');
  return paragraph;
}

function textsOf(paragraph: Paragraph): readonly string[] {
  return paragraph.runs.map((run) => (run.source.kind === 'literal' ? run.source.text : '（fact）'));
}

function slideXml(bytes: Uint8Array, path = 'ppt/slides/slide1.xml'): string {
  const entry = readZip(bytes).entries.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`包内没有 ${path}`);
  return Buffer.from(entry.data).toString('utf8');
}

const P0 = { slide_id: 1, shape_id: 2, paragraph_index: 0 };

// ---------------------------------------------------------------------------
// 1. 字符坐标模型
// ---------------------------------------------------------------------------

describe('P03：段落字符坐标（跨 run 的地基）', () => {
  it('paragraphTextMap 拼接字面量 run 并给出区间；selectionText 取跨 run 子串', () => {
    const paragraph = threePartBody().paragraphs[0] as Paragraph;
    const map = paragraphTextMap(paragraph);
    expect(map.text).toBe('Hello World!');
    expect(map.has_fact_run).toBe(false);
    expect(map.spans.map((span) => [span.start, span.end])).toEqual([
      [0, 6],
      [6, 11],
      [11, 12],
    ]);
    expect(selectionText(paragraph, 4, 12)).toBe('o World!');
  });

  it('含事实引用 run 的段落：has_fact_run=true，且按字符读取被具名拒绝', () => {
    const paragraph: Paragraph = {
      runs: [{ source: { kind: 'fact', fact_key: 'k' } }],
      level: 0,
      alignment: 'left',
      bullet: false,
    };
    expect(paragraphTextMap(paragraph).has_fact_run).toBe(true);
    expect(() => selectionText(paragraph, 0, 0)).not.toThrow(); // 空区间也能读
    expect(() => replaceParagraphRange(paragraph, 0, 0, 'x')).toThrow(TextEditError);
  });
});

// ---------------------------------------------------------------------------
// 2. 跨 run 精确选区替换：未选中 run 引用相等（反向对照：整段重写会翻车）
// ---------------------------------------------------------------------------

describe('P03：跨 run 替换只动选区（未选中 run 与样式对象引用不变）', () => {
  it('选区完全落在单个 run 内：前缀/后缀 run 与样式对象引用不变', () => {
    const body = threePartBody();
    const before = body.paragraphs[0] as Paragraph;
    const after = replaceParagraphRange(before, 6, 11, 'Earth');
    expect(textsOf(after)).toEqual(['Hello ', 'Earth', '!']);
    // run0 完全在选区前 ⇒ 原对象；run2 完全在后 ⇒ 原对象。
    expect(after.runs[0]).toBe(before.runs[0]);
    expect(after.runs[2]).toBe(before.runs[2]);
    // 替换文本继承选区起点所属 run（run1）的样式对象本身。
    expect(after.runs[1]?.style).toBe(STYLE_B);
  });

  it('选区横跨两个 run：前缀保留字符与样式对象引用，整段被删的 run 移除', () => {
    const body = threePartBody();
    const before = body.paragraphs[0] as Paragraph;
    // 'Hello World!' 的 [4,12) = 'o World!'
    const after = replaceParagraphRange(before, 4, 12, 'X');
    expect(textsOf(after)).toEqual(['Hell', 'X']);
    // 前缀 'Hell' 是新 run，但样式是 run0 的对象本身。
    expect(after.runs[0]?.style).toBe(STYLE_A);
    // 替换文本继承选区起点（offset 4 在 run0 内）⇒ 也是 STYLE_A。
    expect(after.runs[1]?.style).toBe(STYLE_A);
    expect((after.runs[0]?.source as { text: string }).text).toBe('Hell');
  });

  it('纯插入点（空选区）落在 run 边界：注入位置正确，三个原始 run 全部引用不变', () => {
    const body = threePartBody();
    const before = body.paragraphs[0] as Paragraph;
    const after = replaceParagraphRange(before, 6, 6, 'Y');
    expect(textsOf(after)).toEqual(['Hello ', 'Y', 'World', '!']);
    expect(after.runs[0]).toBe(before.runs[0]);
    expect(after.runs[2]).toBe(before.runs[1]); // 原 'World' run 顺移
    expect(after.runs[3]).toBe(before.runs[2]); // 原 '!' run 顺移
    // 插入文本继承右边 run（run1）的样式对象。
    expect(after.runs[1]?.style).toBe(STYLE_B);
  });

  it('空操作（空选区 + 空替换）返回原对象本身', () => {
    const before = threePartBody().paragraphs[0] as Paragraph;
    expect(replaceParagraphRange(before, 3, 3, '')).toBe(before);
  });

  it('段落末尾追加：注入点在段落尾（无右侧 run）也能落位', () => {
    const before = threePartBody().paragraphs[0] as Paragraph;
    const after = replaceParagraphRange(before, 12, 12, '?');
    expect(textsOf(after)).toEqual(['Hello ', 'World', '!', '?']);
    expect(after.runs[3]?.style).toBeUndefined(); // 末尾无 run ⇒ 无样式可继承
  });

  it('越界选区与事实引用段一律具名报错', () => {
    const before = threePartBody().paragraphs[0] as Paragraph;
    expect(() => replaceParagraphRange(before, 0, 99, 'x')).toThrow(TextEditError);
    try {
      replaceParagraphRange(before, 0, 99, 'x');
    } catch (error) {
      expect((error as TextEditError).reason).toBe('selection_out_of_range');
    }
    const factParagraph: Paragraph = {
      runs: [{ source: { kind: 'literal', text: 'ab' } }, { source: { kind: 'fact', fact_key: 'k' } }],
      level: 0,
      alignment: 'left',
      bullet: false,
    };
    try {
      replaceParagraphRange(factParagraph, 0, 1, 'z');
      throw new Error('应当报错');
    } catch (error) {
      expect(error).toBeInstanceOf(TextEditError);
      expect((error as TextEditError).reason).toBe('paragraph_has_fact_run');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. 跨 run 套样式 / 删除
// ---------------------------------------------------------------------------

describe('P03：跨 run 套样式与删除', () => {
  it('styleParagraphRange 只给选区字符合并样式；未重叠 run 引用不变', () => {
    const before = threePartBody().paragraphs[0] as Paragraph;
    const after = styleParagraphRange(before, 3, 8, { bold: false });
    // 'Hello World!'（'Hello ' 含尾空格）的 [3,8) = 'lo Wo'
    expect(textsOf(after)).toEqual(['Hel', 'lo ', 'Wo', 'rld', '!']);
    expect(after.runs[0]?.style).toBe(STYLE_A); // 前缀：原样式对象
    expect(after.runs[1]?.style).toEqual({ size_pt: 18, bold: false }); // 合并补丁
    expect(after.runs[2]?.style).toEqual({ italic: true, color: 'FF0000', bold: false });
    expect(after.runs[3]?.style).toBe(STYLE_B); // 后缀：原样式对象
    expect(after.runs[4]).toBe(before.runs[2]); // 完全未重叠：原 run
  });

  it('空选区的 styleParagraphRange 返回原对象；deleteParagraphRange 删除跨 run 区间', () => {
    const before = threePartBody().paragraphs[0] as Paragraph;
    expect(styleParagraphRange(before, 5, 5, { bold: true })).toBe(before);
    const deleted = deleteParagraphRange(before, 5, 11); // 删 ' World'
    expect(textsOf(deleted)).toEqual(['Hello', '!']);
    // 前缀是被重建的新 run，但样式对象不变；完全在选区后的 '!' run 引用不变。
    expect(deleted.runs[0]?.style).toBe(STYLE_A);
    expect(deleted.runs[1]).toBe(before.runs[2]);
  });

  it('段落之外的一切保持引用相等（整份文稿层面）', () => {
    const deck = deckWith(threePartBody());
    const edited = replaceSelectionAcrossRuns(deck, P0, 6, 11, 'Earth');
    expect(edited.slides[0]?.shapes).toHaveLength(1); // 未增删对象
    // 段 1 未动 ⇒ 引用相等。
    expect(bodyOf(edited).paragraphs[1]).toBe(bodyOf(deck).paragraphs[1]);
    // 原模型未被就地修改。
    expect(textsOf(paragraphAt(deck, 0))).toEqual(['Hello ', 'World', '!']);
  });
});

// ---------------------------------------------------------------------------
// 4. 查找（PPT-14）
// ---------------------------------------------------------------------------

describe('P03：查找命中语义', () => {
  it('大小写敏感 / 不敏感、不重叠、从左到右', () => {
    const paragraph = threePartBody().paragraphs[0] as Paragraph;
    expect(findText(paragraph, 'o')).toEqual([
      { start: 4, end: 5, text: 'o' },
      { start: 7, end: 8, text: 'o' },
    ]);
    expect(findText(paragraph, 'O', { case_sensitive: false })).toHaveLength(2);
    expect(findText(paragraph, 'O')).toHaveLength(0); // 默认大小写敏感
    expect(findText(paragraph, 'l')).toEqual([
      { start: 2, end: 3, text: 'l' },
      { start: 3, end: 4, text: 'l' },
      { start: 9, end: 10, text: 'l' },
    ]);
  });

  it('全词匹配以 [A-Za-z0-9_] 为词边界', () => {
    const paragraph = threePartBody().paragraphs[0] as Paragraph;
    expect(findText(paragraph, 'o', { whole_word: true })).toHaveLength(0); // Hello/World 里的 o 都贴词字符
    expect(findText(paragraph, 'World', { whole_word: true })).toEqual([{ start: 6, end: 11, text: 'World' }]);
  });

  it('空查找串具名报错；事实引用段返回空（不猜位置）', () => {
    const paragraph = threePartBody().paragraphs[0] as Paragraph;
    expect(() => findText(paragraph, '')).toThrow(TextEditError);
    try {
      findText(paragraph, '');
    } catch (error) {
      expect((error as TextEditError).reason).toBe('empty_query');
    }
    const factParagraph: Paragraph = {
      runs: [{ source: { kind: 'fact', fact_key: 'k' } }],
      level: 0,
      alignment: 'left',
      bullet: false,
    };
    expect(findText(factParagraph, 'x')).toEqual([]);
  });

  it('replaceText 替换全部命中，未命中 run 引用不变', () => {
    const before = threePartBody().paragraphs[0] as Paragraph;
    const result = replaceText(before, 'o', '0');
    expect(result.replaced).toBe(2);
    expect(textsOf(result.paragraph).join('')).toBe('Hell0 W0rld!');
    // run0 形状变了（内部含命中）但它是新对象；关键是未含命中的 run2（'!'）被透传。
    expect(result.paragraph.runs[result.paragraph.runs.length - 1]).toBe(before.runs[2]);

    const one = replaceText(before, 'World', '地球', { case_sensitive: true });
    expect(one.replaced).toBe(1);
    expect(textsOf(one.paragraph)).toEqual(['Hello ', '地球', '!']);
    expect(one.paragraph.runs[0]).toBe(before.runs[0]);
    expect(one.paragraph.runs[2]).toBe(before.runs[2]);
    expect(one.paragraph.runs[1]?.style).toBe(STYLE_B); // 替换文本继承命中处样式
  });
});

// ---------------------------------------------------------------------------
// 5. 粘贴（PPT-14）
// ---------------------------------------------------------------------------

describe('P03：粘贴', () => {
  it('纯文本多行粘贴：首行并入选区，其余成新段落；前后段落引用不变', () => {
    const body = threePartBody();
    const before = body.paragraphs[0] as Paragraph;
    const pasted = pasteIntoBody(body, 0, 2, 4, { kind: 'plain', text: 'X\r\nY\r\nZ' });

    expect(pasted.paragraphs).toHaveLength(4); // 原 2 段 + 新增 2 段
    // 首行并入：'Hello World!' 的 [2,4)='ll' → 'HeXo World!'
    expect(textsOf(pasted.paragraphs[0] as Paragraph)).toEqual(['He', 'X', 'o ', 'World', '!']);
    // run0 与选区部分重叠 ⇒ 前缀/后缀被重建为新 run，但样式对象引用不变。
    expect((pasted.paragraphs[0] as Paragraph).runs[0]?.style).toBe(STYLE_A);
    expect((pasted.paragraphs[0] as Paragraph).runs[2]?.style).toBe(STYLE_A);
    // 完全在选区后的 'World' 与原段第二 run 引用相等。
    expect((pasted.paragraphs[0] as Paragraph).runs[3]).toBe(before.runs[1]);

    const newParagraph = pasted.paragraphs[1] as Paragraph;
    expect(newParagraph.runs[0]?.source).toEqual({ kind: 'literal', text: 'Y' });
    expect(newParagraph.level).toBe(0);
    expect(newParagraph.alignment).toBe('left');
    expect(newParagraph.bullet).toBe(false);
    expect((pasted.paragraphs[2] as Paragraph).runs[0]?.source).toEqual({ kind: 'literal', text: 'Z' });
    expect((pasted.paragraphs[3] as Paragraph).runs[0]?.source).toEqual({ kind: 'literal', text: '第二段' });

    // 目标段之后的原第二段引用不变。
    expect(pasted.paragraphs.find((p) => textsOf(p).join('') === '第二段')).toBe(body.paragraphs[1]);

    // 原体未被就地修改。
    expect(textsOf(body.paragraphs[0] as Paragraph)).toEqual(['Hello ', 'World', '!']);
  });

  it('单行粘贴替换跨 run 选区：不新增段落', () => {
    const body = threePartBody();
    const before = body.paragraphs[0] as Paragraph;
    const pasted = pasteIntoBody(body, 0, 4, 11, { kind: 'plain', text: 'Z' }); // 'o World' → 'Z'
    expect(pasted.paragraphs).toHaveLength(2);
    expect(textsOf(pasted.paragraphs[0] as Paragraph)).toEqual(['Hell', 'Z', '!']);
    expect((pasted.paragraphs[0] as Paragraph).runs[2]).toBe(before.runs[2]);
  });

  it('富粘贴：首段的 run 与其样式原样进入，整段覆盖时采用剪贴板段落属性', () => {
    const body = threePartBody();
    const clipRun = { source: { kind: 'literal', text: '粗体' } as const, style: { bold: true, font: '黑体' } };
    const richBody: TextBody = {
      paragraphs: body.paragraphs.map((p) => ({ ...p })),
    };
    const pasted = pasteIntoBody(richBody, 0, 0, 12, {
      kind: 'rich',
      paragraphs: [
        { runs: [clipRun], level: 2, alignment: 'center', bullet: true },
        { runs: [{ source: { kind: 'literal', text: '次段' } }] },
      ],
    });
    const first = pasted.paragraphs[0] as Paragraph;
    expect(first.runs).toEqual([clipRun]);
    expect(first.level).toBe(2);
    expect(first.alignment).toBe('center');
    expect(first.bullet).toBe(true);
    expect((pasted.paragraphs[1] as Paragraph).runs[0]?.source).toEqual({ kind: 'literal', text: '次段' });
    expect((pasted.paragraphs[1] as Paragraph).level).toBe(0);
  });

  it('部分选区的富粘贴不夺走整段段落属性（避免"贴一句变列表"）', () => {
    const body = threePartBody();
    const pasted = pasteIntoBody(body, 0, 0, 5, {
      kind: 'rich',
      paragraphs: [{ runs: [{ source: { kind: 'literal', text: 'Z' }, style: { bold: true } }], level: 4, bullet: true }],
    });
    const first = pasted.paragraphs[0] as Paragraph;
    expect(first.level).toBe(0); // 原段 level 保留
    expect(first.bullet).toBe(false); // 原段 bullet 保留
    expect(first.runs[0]?.style).toEqual({ bold: true }); // 贴进来的 run 样式保留
  });

  it('空剪贴板 = 无操作（不静默删除选区）', () => {
    const body = threePartBody();
    expect(pasteIntoBody(body, 0, 0, 5, { kind: 'plain', text: '' })).not.toBe(body); // 单空行会插入一个空段
    const empty = pasteIntoBody(body, 0, 0, 5, { kind: 'rich', paragraphs: [] });
    expect(empty).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// 6. 多级列表（PPT-04）
// ---------------------------------------------------------------------------

describe('P03：多级列表', () => {
  it('multilevelList 落 level/bullet，run 样式原样保留', () => {
    const paragraphs = multilevelList([
      { text: '一级', level: 0 },
      { text: '二级', level: 1 },
      { runs: [{ source: { kind: 'literal', text: '三级' }, style: STYLE_A }], level: 2, bullet: true },
    ]);
    expect(paragraphs.map((p) => p.level)).toEqual([0, 1, 2]);
    expect(paragraphs.map((p) => p.bullet)).toEqual([true, true, true]); // 大纲项默认是列表项
    expect(paragraphs[2]?.runs[0]?.style).toBe(STYLE_A);
  });

  it('越界 level 与空大纲项具名报错', () => {
    expect(() => multilevelList([{ text: 'x', level: 9 }])).toThrow(TextEditError);
    try {
      multilevelList([{ level: 0 }]);
      throw new Error('应当报错');
    } catch (error) {
      expect((error as TextEditError).reason).toBe('invalid_outline_item');
    }
  });
});

// ---------------------------------------------------------------------------
// 7. 文稿级查找替换（PPT-14）
// ---------------------------------------------------------------------------

function twoSlideDeck(): Presentation {
  let deck: Presentation = emptyPresentation('p1', 'P03 查找替换');
  const first = addSlide(deck);
  deck = addShape(first.presentation, first.slide_id, {
    kind: 'text_box',
    shape_id: 2,
    name: 'A',
    transform: transform(0, 0, 100, 100),
    text: literalText('foo bar foo'),
  });
  deck = addShape(deck, first.slide_id, {
    kind: 'picture',
    shape_id: 3,
    name: 'Pic',
    transform: transform(0, 0, 100, 100),
    media_path: 'ppt/media/image1.png',
    alt_text: 'foo',
    crop: null,
  });
  const second = addSlide(deck);
  deck = addShape(second.presentation, second.slide_id, {
    kind: 'text_box',
    shape_id: 2,
    name: 'B',
    transform: transform(0, 0, 100, 100),
    text: literalText('foo 也在第二页'),
  });
  return deck;
}

describe('P03：文稿级查找替换（文本对象内，跨页）', () => {
  it('findInPresentation 跨页命中，坐标含页与对象', () => {
    const deck = twoSlideDeck();
    const matches = findInPresentation(deck, 'foo');
    expect(matches.map((m) => [m.slide_id, m.shape_id, m.paragraph_index, m.start])).toEqual([
      [1, 2, 0, 0],
      [1, 2, 0, 8],
      [2, 2, 0, 0],
    ]);
    expect(findInShape(deck, { slide_id: 2, shape_id: 2 }, 'foo')).toHaveLength(1);
  });

  it('replaceInShape 只改指定对象：另一对象与非文本对象引用相等', () => {
    const deck = twoSlideDeck();
    const result = replaceInShape(deck, { slide_id: 1, shape_id: 2 }, 'foo', 'BAR');
    expect(result.replaced).toBe(2);
    expect(result.matches).toHaveLength(2);
    const shapes = result.presentation.slides[0]?.shapes ?? [];
    // 图片对象（shape 3）未被触碰 ⇒ 引用相等。
    expect(shapes[1]).toBe(deck.slides[0]?.shapes[1]);
    // 第二页页对象未被触碰 ⇒ 引用相等。
    expect(result.presentation.slides[1]).toBe(deck.slides[1]);
    const editedText = (shapes[0] as { text: TextBody }).text.paragraphs[0]?.runs
      .map((run) => (run.source.kind === 'literal' ? run.source.text : ''))
      .join('');
    expect(editedText).toBe('BAR bar BAR');
  });

  it('replaceInPresentation 全改；零命中返回原文稿对象（失败保旧）', () => {
    const deck = twoSlideDeck();
    const all = replaceInPresentation(deck, 'foo', 'X');
    expect(all.replaced).toBe(3);
    const firstText = (all.presentation.slides[0]?.shapes[0] as { text: TextBody }).text.paragraphs[0]?.runs
      .map((run) => (run.source.kind === 'literal' ? run.source.text : ''))
      .join('');
    expect(firstText).toBe('X bar X');
    const none = replaceInPresentation(deck, '不存在', 'X');
    expect(none.replaced).toBe(0);
    expect(none.presentation).toBe(deck);
  });

  it('空查找串在文稿层具名报错', () => {
    const deck = twoSlideDeck();
    try {
      findInPresentation(deck, '');
      throw new Error('应当报错');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationOperationError);
      expect((error as PresentationOperationError).reason).toBe('empty_query');
    }
  });
});

// ---------------------------------------------------------------------------
// 8. 真实字节往返（独立解析，不复用待测读写自证）
// ---------------------------------------------------------------------------

describe('P03：编辑后经真实 PPTX 字节往返（独立读 XML）', () => {
  it('跨 run 替换 → render：幻灯片 XML 里新文本在、旧文本不在，片段格式写在同段不同 run', () => {
    const deck = deckWith(threePartBody());
    const edited = replaceSelectionAcrossRuns(deck, P0, 6, 11, 'Earth');
    const bytes = renderPresentation(edited).bytes;
    const xml = slideXml(bytes);

    expect(xml).toContain('<a:t>Hello </a:t>');
    expect(xml).toContain('<a:t>Earth</a:t>');
    expect(xml).not.toContain('World');
    // 三个片段各自成 run ⇒ 同段并存。
    expect((xml.match(/<a:t>/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('跨 run 替换后 importPresentation 读回：run 文本分段与样式一致（真实字节往返）', () => {
    const deck = deckWith(threePartBody());
    const edited = replaceSelectionAcrossRuns(deck, P0, 6, 11, 'Earth');
    const reread = importPresentation(renderPresentation(edited).bytes);
    const runs = bodyOf(reread.presentation).paragraphs[0]?.runs ?? [];
    expect(runs.map((run) => (run.source.kind === 'literal' ? run.source.text : ''))).toEqual(['Hello ', 'Earth', '!']);
    // 前缀仍是 18pt 加粗，替换段继承 'World' 的斜体红字。
    expect(runs[0]?.style).toEqual({ bold: true, size_pt: 18 });
    expect(runs[1]?.style).toEqual({ italic: true, color: 'FF0000' });
    expect(runs[2]?.style).toBeUndefined();
  });

  it('多级列表 → render：a:pPr@lvl 与 a:buNone 写入，读回层级一致', () => {
    const body: TextBody = {
      paragraphs: multilevelList([
        { text: '一级项', level: 0 },
        { text: '二级项', level: 1 },
        { text: '三级项', level: 2 },
      ]),
    };
    const bytes = renderPresentation(deckWith(body)).bytes;
    const xml = slideXml(bytes);
    expect(xml).toContain('lvl="1"');
    expect(xml).toContain('lvl="2"');

    const reread = importPresentation(bytes);
    const paragraphs = bodyOf(reread.presentation).paragraphs;
    expect(paragraphs.map((p) => p.level)).toEqual([0, 1, 2]);
    expect(paragraphs.map((p) => p.bullet)).toEqual([true, true, true]);
    expect(paragraphs.map((p) => (p.runs[0]?.source.kind === 'literal' ? p.runs[0].source.text : ''))).toEqual([
      '一级项',
      '二级项',
      '三级项',
    ]);
  });

  it('粘贴新段落 → render → import：新段落在文件里真实存在', () => {
    const deck = deckWith(threePartBody());
    const pasted = pasteIntoPresentation(deck, P0, 12, 12, { kind: 'plain', text: '\n新增行' });
    const reread = importPresentation(renderPresentation(pasted).bytes);
    const texts = bodyOf(reread.presentation).paragraphs.map((p) =>
      p.runs.map((run) => (run.source.kind === 'literal' ? run.source.text : '')).join(''),
    );
    expect(texts).toContain('新增行');
    expect(texts).toContain('Hello World!');
  });
});

// ---------------------------------------------------------------------------
// 9. 失败保旧：事实引用段拒绝 + 原模型不被污染（PPT-14）
// ---------------------------------------------------------------------------

describe('P03：按字符编辑事实引用段被拒，且原模型不被污染', () => {
  it('replaceSelectionAcrossRuns 对事实段报 paragraph_has_fact_run，原稿不变', () => {
    const factBody: TextBody = {
      paragraphs: [
        { runs: [{ source: { kind: 'literal', text: 'ab' } }, { source: { kind: 'fact', fact_key: 'k' } }], level: 0, alignment: 'left', bullet: false },
      ],
    };
    const deck = deckWith(factBody);
    try {
      replaceSelectionAcrossRuns(deck, P0, 0, 1, 'z');
      throw new Error('应当报错');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationOperationError);
      expect((error as PresentationOperationError).reason).toBe('paragraph_has_fact_run');
    }
    // 失败保旧：原稿仍是两段 run、内容未动。
    expect(bodyOf(deck).paragraphs[0]?.runs).toHaveLength(2);
    expect(textsOf(paragraphAt(deck, 0))).toEqual(['ab', '（fact）']);
  });

  it('粘贴越界选区在文稿层具名报错，且不改原稿', () => {
    const deck = deckWith(threePartBody());
    try {
      pasteIntoPresentation(deck, P0, 0, 99, { kind: 'plain', text: 'x' });
      throw new Error('应当报错');
    } catch (error) {
      expect((error as PresentationOperationError).reason).toBe('selection_out_of_range');
    }
    expect(textsOf(paragraphAt(deck, 0))).toEqual(['Hello ', 'World', '!']);
  });
});

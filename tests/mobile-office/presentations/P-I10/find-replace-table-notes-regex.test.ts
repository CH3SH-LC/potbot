/**
 * P-I10：查找 / 替换扩到**表格单元格 + 演讲备注**，并新增**正则 / 通配符**查询模式。
 *
 * ## 补的是哪一截（P03 遗留的具名边界）
 *
 * P03 的 `findInPresentation` 注释写明「**不含**表格单元格与备注」，且查找只有字面量一种模式。
 * 本包把查找 / 替换的范围递归进 `TableShape.rows[].cells[].text` 与 `Slide.notes`，
 * 并加 `FindOptions.mode = 'regex' | 'wildcard'`（畸形模式**具名报错**，不静默按字面量）。
 *
 * ## 判据一：位置显式携带（不再靠形状猜）
 *
 * 一处命中现在带 `location`：`{kind:'shape'}` / `{kind:'table_cell',row_index,column_index}` /
 * `{kind:'notes'}`；备注命中 `shape_id` 为 `null`（**不用 0 冒充**——"缺失不当零"）。
 *
 * ## 判据二：对象身份不变（用 `toBe`，不是 `toEqual`）
 *
 * 未命中的表格格 / 行、备注段、正文形状一律**引用相等**；被改的格里，未落在命中处的 run
 * 也**原对象透传**。任何"整表 / 整备注重造一遍"的实现都会在 `toBe` 上翻车。
 *
 * ## 判据三：真实字节（独立读侧，不复用待测读写自证）
 *
 * 替换后走 `renderPresentation` 生成**真 ZIP 字节**，再用 `readZip` 直接读 `slide1.xml` 与
 * `notesSlides/notesSlide1.xml` 的 `<a:t>` 文本（不经过 `importPresentation`）。
 *
 * ## 如实标注边界
 *
 * - 含**事实引用 run**的表格单元格 / 备注段：替换**具名拒绝**（`paragraph_has_fact_run`）且模型不变；
 * - 只读查找对事实段返回零命中（与 `findText` 同口径，不猜位置）；
 * - 正则零长命中（如 `a*` 的空匹配）**不计入结果**；通配符 `*` 贪婪。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/index.js';
import {
  literalText,
  transform,
  type TableCell,
  type TextBody,
} from '../../../../src/presentations/model.js';
import {
  PresentationOperationError,
  addShape,
  addSlide,
  findInPresentation,
  replaceInPresentation,
  replaceInShape,
} from '../../../../src/presentations/operations.js';
import { setSpeakerNotes, speakerNotesText } from '../../../../src/presentations/notes.js';
import { emptyPresentation, renderPresentation } from '../../../../src/presentations/render.js';
import { addTable } from '../../../../src/presentations/tables.js';
import {
  TextEditError,
  findText,
  paragraphPlainText,
  replaceText,
  type FindOptions,
} from '../../../../src/presentations/text.js';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

function literalCell(text: string): TableCell {
  return {
    text: { paragraphs: [{ runs: [{ source: { kind: 'literal', text } }], level: 0, alignment: 'left', bullet: false }] },
    col_span: 1,
    row_span: 1,
  };
}

function joinRuns(body: TextBody): string {
  return body.paragraphs
    .map((paragraph) => paragraph.runs.map((run) => (run.source.kind === 'literal' ? run.source.text : '（fact）')).join(''))
    .join('\n');
}

function tableOf(presentation: ReturnType<typeof emptyPresentation>): Extract<import('../../../../src/presentations/model.js').Shape, { kind: 'table' }> {
  const shape = presentation.slides[0]?.shapes.find((candidate) => candidate.kind === 'table');
  if (shape?.kind !== 'table') throw new Error('应当是表格');
  return shape;
}

/**
 * 一页：正文文本框（shape 2，'正文 foo'）+ 2×2 表格（shape 3，两格含 'foo'）+ 备注两行（第二行含 'foo'）。
 */
function deck(): ReturnType<typeof emptyPresentation> {
  const first = addSlide(emptyPresentation('p1', 'P-I10'));
  let deck = addShape(first.presentation, first.slide_id, {
    kind: 'text_box',
    shape_id: 2,
    name: 'Body',
    transform: transform(0, 0, 3000000, 1000000),
    text: literalText('正文 foo'),
  });
  deck = addShape(deck, first.slide_id, {
    kind: 'table',
    shape_id: 3,
    name: 'T',
    transform: transform(0, 2000000, 3000000, 1000000),
    rows: [
      { cells: [literalCell('表内 foo'), literalCell('保持')] },
      { cells: [literalCell('不动'), literalCell('foo 结尾')] },
    ],
    column_widths_emu: [1500000, 1500000],
  });
  return setSpeakerNotes(deck, first.slide_id, '备注第一行\n备注 foo');
}

/** 1×1 表格：唯一单元格含一段「字面量 run + 事实引用 run」。 */
function factCellDeck(): ReturnType<typeof emptyPresentation> {
  const first = addSlide(emptyPresentation('p2', 'P-I10 fact'));
  return addShape(first.presentation, first.slide_id, {
    kind: 'table',
    shape_id: 2,
    name: 'FT',
    transform: transform(0, 0, 1000000, 1000000),
    rows: [
      {
        cells: [
          {
            text: {
              paragraphs: [
                {
                  runs: [
                    { source: { kind: 'literal', text: 'ab' } },
                    { source: { kind: 'fact', fact_key: 'k' } },
                  ],
                  level: 0,
                  alignment: 'left',
                  bullet: false,
                },
              ],
            },
            col_span: 1,
            row_span: 1,
          },
        ],
      },
    ],
    column_widths_emu: [1000000],
  });
}

function partText(bytes: Uint8Array, path: string): string {
  const entry = readZip(bytes).entries.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`包内没有 ${path}`);
  return Buffer.from(entry.data).toString('utf8');
}

/**
 * 把一个部件 XML 里全部 `<a:t>` 文本**按顺序拼起来**（不插分隔符）。
 *
 * 替换会按命中把一段拆成多个 run（`'表内 foo'` → `'表内 '` + `'BAR'`），所以不能断言
 * 单个 `<a:t>表内 BAR</a:t>`；拼接后跨 run 的可见文本才是"用户看到的字符串"。
 */
function allText(xml: string): string {
  return [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => match[1] ?? '').join('');
}

// ---------------------------------------------------------------------------
// 1. 查找：命中位置显式携带
// ---------------------------------------------------------------------------

describe('P-I10：查找递归进表格与备注，命中带 location', () => {
  it('findInPresentation 同时命中正文形状 / 表格单元格 / 备注', () => {
    const matches = findInPresentation(deck(), 'foo');
    expect(matches).toHaveLength(4);
    expect(matches.map((match) => match.location)).toEqual([
      { kind: 'shape' },
      { kind: 'table_cell', row_index: 0, column_index: 0 },
      { kind: 'table_cell', row_index: 1, column_index: 1 },
      { kind: 'notes' },
    ]);
    expect(matches.map((match) => match.shape_id)).toEqual([2, 3, 3, null]);
    expect(matches[2]).toMatchObject({ paragraph_index: 0, text: 'foo' });
    expect(matches[3]).toMatchObject({ paragraph_index: 1, text: 'foo' });
  });

  it('replaceInPresentation 落在表格单元格与备注：文本更新 + 未命中格/段引用相等', () => {
    const before = deck();
    const beforeTable = tableOf(before);
    const result = replaceInPresentation(before, 'foo', 'BAR');
    expect(result.replaced).toBe(4);

    const table = tableOf(result.presentation);
    expect(joinRuns(table.rows[0]?.cells[0]?.text as TextBody)).toBe('表内 BAR');
    expect(joinRuns(table.rows[1]?.cells[1]?.text as TextBody)).toBe('BAR 结尾');
    // 未命中的格 / 行对象引用不变（结构性"不损其他格"）。
    expect(table.rows[0]?.cells[1]).toBe(beforeTable.rows[0]?.cells[1]);
    expect(table.rows[1]?.cells[0]).toBe(beforeTable.rows[1]?.cells[0]);
    expect(table.rows[0]?.cells[1]?.text).toBe(beforeTable.rows[0]?.cells[1]?.text);

    // 备注：第一行未命中 ⇒ 段落引用相等。
    const notes = result.presentation.slides[0]?.notes as TextBody;
    expect(speakerNotesText(notes)).toBe('备注第一行\n备注 BAR');
    expect(notes.paragraphs[0]).toBe(before.slides[0]?.notes?.paragraphs[0]);
  });

  it('replaceInShape 只改指定表格：正文形状与备注引用相等', () => {
    const before = deck();
    const result = replaceInShape(before, { slide_id: 1, shape_id: 3 }, 'foo', 'X');
    expect(result.replaced).toBe(2);
    expect(result.presentation.slides[0]?.shapes.find((shape) => shape.shape_id === 2)).toBe(
      before.slides[0]?.shapes.find((shape) => shape.shape_id === 2),
    );
    expect(result.presentation.slides[0]?.notes).toBe(before.slides[0]?.notes);
  });

  it('表格格里未命中的 run 原对象透传（对象身份不变）', () => {
    const first = addSlide(emptyPresentation('p3', 'P-I10 identity'));
    const keep = { source: { kind: 'literal', text: '守 ' } as const, style: { bold: true } as const };
    const hit = { source: { kind: 'literal', text: 'foo' } as const };
    let deck = addShape(first.presentation, first.slide_id, {
      kind: 'table',
      shape_id: 2,
      name: 'T',
      transform: transform(0, 0, 1000000, 1000000),
      rows: [{ cells: [{ text: { paragraphs: [{ runs: [keep, hit], level: 0, alignment: 'left', bullet: false }] }, col_span: 1, row_span: 1 }] }],
      column_widths_emu: [1000000],
    });
    deck = setSpeakerNotes(deck, first.slide_id, 'note foo');
    const beforeRuns = tableOf(deck).rows[0]?.cells[0]?.text?.paragraphs[0]?.runs;
    const after = replaceInPresentation(deck, 'foo', 'BAR');
    const afterRuns = tableOf(after.presentation).rows[0]?.cells[0]?.text?.paragraphs[0]?.runs;
    expect(afterRuns?.[0]).toBe(beforeRuns?.[0]); // 未命中的 run 是同一对象
    expect(joinRuns({ paragraphs: [{ runs: afterRuns ?? [], level: 0, alignment: 'left', bullet: false }] })).toBe('守 BAR');
  });
});

// ---------------------------------------------------------------------------
// 2. 事实引用单元格：替换具名拒绝，模型不变
// ---------------------------------------------------------------------------

describe('P-I10：含事实引用 run 的单元格替换被拒', () => {
  it('replaceInPresentation 对事实单元格报 paragraph_has_fact_run，原模型不变', () => {
    const before = factCellDeck();
    try {
      replaceInPresentation(before, 'ab', 'X');
      throw new Error('应当报错');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationOperationError);
      expect((error as PresentationOperationError).reason).toBe('paragraph_has_fact_run');
    }
    // 失败保旧：仍是「字面量 + 事实」两 run。
    const runs = tableOf(before).rows[0]?.cells[0]?.text?.paragraphs[0]?.runs;
    expect(runs).toHaveLength(2);
    expect(runs?.[0]?.source).toEqual({ kind: 'literal', text: 'ab' });
    // 只读查找对事实段返回零命中（不猜位置、不抛错）。
    expect(findInPresentation(before, 'ab')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. 正则 / 通配符：命名错误 + 零命中保旧
// ---------------------------------------------------------------------------

describe('P-I10：正则 / 通配符查询模式', () => {
  it('regex 模式：查找与替换生效（跨表格与备注）', () => {
    const result = replaceInPresentation(deck(), 'f.o', 'Z', { mode: 'regex' });
    expect(result.replaced).toBe(4);
    expect(joinRuns(tableOf(result.presentation).rows[1]?.cells[1]?.text as TextBody)).toBe('Z 结尾');
  });

  it('wildcard 模式：* / ? 生效', () => {
    const result = replaceInPresentation(deck(), 'f?o', 'W', { mode: 'wildcard' });
    expect(result.replaced).toBe(4);
    expect(speakerNotesText(result.presentation.slides[0]?.notes as TextBody)).toBe('备注第一行\n备注 W');
  });

  it('零命中正则替换返回同一文稿对象（失败保旧）', () => {
    const before = deck();
    const none = replaceInPresentation(before, 'zzz-\\d+', 'X', { mode: 'regex' });
    expect(none.replaced).toBe(0);
    expect(none.presentation).toBe(before);
  });

  it('畸形正则在文稿层 / 段落层都具名报 invalid_pattern（不静默按字面量）', () => {
    const before = deck();
    expect(() => replaceInPresentation(before, '(', 'X', { mode: 'regex' })).toThrow(PresentationOperationError);
    try {
      replaceInPresentation(before, '(', 'X', { mode: 'regex' });
      throw new Error('应当报错');
    } catch (error) {
      expect((error as PresentationOperationError).reason).toBe('invalid_pattern');
    }
    // 报错后原文稿未动。
    expect(speakerNotesText(before.slides[0]?.notes as TextBody)).toBe('备注第一行\n备注 foo');

    const paragraph = { runs: [{ source: { kind: 'literal', text: 'abc' } as const }], level: 0, alignment: 'left' as const, bullet: false };
    try {
      findText(paragraph, '(', { mode: 'regex' });
      throw new Error('应当报错');
    } catch (error) {
      expect(error).toBeInstanceOf(TextEditError);
      expect((error as TextEditError).reason).toBe('invalid_pattern');
    }
  });

  it('大小写 / 全词在 regex 模式口径一致；零长命中不计入', () => {
    const paragraph = { runs: [{ source: { kind: 'literal', text: 'Foo foo foobar' } as const }], level: 0, alignment: 'left' as const, bullet: false };
    expect(findText(paragraph, 'foo', { mode: 'regex' })).toHaveLength(2); // 独立 'foo' + 'foobar' 内的 'foo'
    expect(findText(paragraph, 'foo', { mode: 'regex', case_sensitive: false })).toHaveLength(3); // 再加 'Foo'
    expect(findText(paragraph, 'foo', { mode: 'regex', whole_word: true })).toHaveLength(1); // 只有独立的
    expect(findText(paragraph, 'x*', { mode: 'regex' })).toEqual([]);
    const replaced = replaceText(paragraph, '\\d*', '#', { mode: 'regex' } as FindOptions);
    expect(replaced.replaced).toBe(0); // 零长命中不替换
    expect(paragraphPlainText(replaced.paragraph)).toBe('Foo foo foobar');
  });
});

// ---------------------------------------------------------------------------
// 4. 真实字节：替换后写在表格 XML 与备注部件里
// ---------------------------------------------------------------------------

describe('P-I10：替换经真实 PPTX 字节落进表格与备注部件（独立读 XML）', () => {
  it('表格单元格与备注的新文本出现在对应部件里，旧文本消失', () => {
    const edited = replaceInPresentation(deck(), 'foo', 'BAR').presentation;
    const bytes = renderPresentation(edited).bytes;

    const slide = partText(bytes, 'ppt/slides/slide1.xml');
    expect(allText(slide)).toContain('表内 BAR');
    expect(allText(slide)).toContain('BAR 结尾');
    expect(allText(slide)).not.toContain('foo');

    const notes = partText(bytes, 'ppt/notesSlides/notesSlide1.xml');
    expect(allText(notes)).toContain('备注 BAR');
    expect(allText(notes)).not.toContain('foo');
  });

  it('表格文本经真实字节与模型一致（同一份包内两处都读到新值）', () => {
    const edited = replaceInPresentation(deck(), 'foo', 'BAR').presentation;
    const bytes = renderPresentation(edited).bytes;
    const slide = partText(bytes, 'ppt/slides/slide1.xml');
    expect(allText(slide)).toContain('正文 BAR');
    expect(joinRuns(tableOf(edited).rows[0]?.cells[0]?.text as TextBody)).toBe('表内 BAR');
  });
});

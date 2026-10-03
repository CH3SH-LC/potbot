/**
 * 字符格式施加单测（R102/R120/R121/R136/R147/R151）。
 *
 * 这里是判据的主战场：
 * 1. 一个词被拆在 **3 个 run** 里，只加粗这个词，**其余 run 属性不变**；
 * 2. emoji 与组合字符的偏移正确；
 * 3. 同一词出现两处，**只改第二处**，第一处不变；
 * 4. 只改格式后，**正文文本逐字不变**；
 * 5. 失败时整批不改（R136）。
 */

import { describe, expect, it } from 'vitest';

import type { InlineNode } from '../../model/types.js';
import { deepEqual } from '../../selection/equals.js';
import { inlineText } from '../../selection/inline-map.js';
import { collectParagraphs, paragraphText, requireParagraph } from '../../selection/structure.js';
import {
  boldOn,
  document,
  E_ACUTE_DECOMPOSED,
  paragraphOfRuns,
  run,
  unspecifiedParagraphProperties,
  unspecifiedRunProperties,
  ZWJ_FAMILY,
} from '../../selection/testing.js';
import {
  applyCharacterFormatToDocumentRange,
  applyCharacterFormatToInlines,
  applyCharacterFormatToParagraph,
  applyCharacterFormatToRanges,
  applyCharacterFormatToSelection,
} from './apply.js';
import { readToggleState } from './read.js';
import { CLEAR_DIRECT_FORMAT, setToggle, setValue, toggleProperty } from './types.js';

function propsOf(inlines: readonly InlineNode[], index: number) {
  const node = inlines[index]!;
  return node.kind === 'run' ? node.properties : null;
}

function allTextOf(model: ReturnType<typeof document>): string[] {
  return collectParagraphs(model.blocks).map(paragraphText);
}

describe('判据①：词跨 3 个 run，只加粗该词，其余 run 属性不变', () => {
  // 文本：他(0) 天(1) 气(2) 很(3) 好(4) 啊(5)；词"天气很好" = [1, 5)
  const paragraph = paragraphOfRuns('p1', [
    ['r1', '他天'],
    ['r2', '气很'],
    ['r3', '好啊'],
  ]);

  it('被选中的部分加粗，未选中的前后片段属性原封不动', () => {
    const before = inlineText(paragraph.inlines);
    const applied = applyCharacterFormatToInlines(paragraph.inlines, { start: 1, end: 5 }, setToggle('bold', true));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const inlines = applied.value.inlines;
    expect(applied.value.changed).toBe(true);
    expect(applied.value.selectedRunCount).toBe(3);

    // 片段：他 | 天 | 气很 | 好 | 啊
    expect(inlines.map((node) => (node.kind === 'run' ? node.text : '?'))).toEqual(['他', '天', '气很', '好', '啊']);
    for (const index of [1, 2, 3]) {
      expect(propsOf(inlines, index)?.bold).toEqual({ state: 'on' });
    }
    // 判据：其余 run 属性不变（逐字段比较，不是只看加粗位）
    expect(deepEqual(propsOf(inlines, 0), unspecifiedRunProperties())).toBe(true);
    expect(deepEqual(propsOf(inlines, 4), unspecifiedRunProperties())).toBe(true);
    expect(inlines[0]).not.toBe(paragraph.inlines[0]); // 片段是新的，但属性一致

    // 判据④：正文文本逐字不变
    expect(Array.from(inlineText(inlines))).toEqual(Array.from(before));
  });

  it('只加粗时不影响其它属性（斜体/字号等保持 unspecified）', () => {
    const applied = applyCharacterFormatToInlines(paragraph.inlines, { start: 2, end: 4 }, setToggle('bold', true));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const boldPiece = applied.value.inlines.find((node) => node.kind === 'run' && node.text === '气很');
    expect(boldPiece).toBeDefined();
    if (boldPiece === undefined || boldPiece.kind !== 'run') return;
    expect(boldPiece.properties.bold).toEqual({ state: 'on' });
    expect(boldPiece.properties.italic.state).toBe('unspecified');
    expect(boldPiece.properties.size.state).toBe('unspecified');
  });

  it('已带其它格式的 run：加粗后原有属性逐字段保留', () => {
    const styled = paragraphOfRuns('p2', [
      ['r1', '他天', { ...unspecifiedRunProperties(), italic: { state: 'on' as const } }],
      ['r2', '气很', { ...unspecifiedRunProperties(), size: { state: 'set' as const, value: { kind: 'pt' as const, value: 16 } } }],
    ]);
    const applied = applyCharacterFormatToInlines(styled.inlines, { start: 1, end: 4 }, setToggle('bold', true));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const pieces = applied.value.inlines.filter((node) => node.kind === 'run');
    const italicPiece = pieces.find((node) => node.kind === 'run' && node.text === '天');
    expect(italicPiece?.kind === 'run' && italicPiece.properties.italic).toEqual({ state: 'on' });
    const sizedPiece = pieces.find((node) => node.kind === 'run' && node.text === '气很');
    expect(sizedPiece?.kind === 'run' && sizedPiece.properties.size).toEqual({ state: 'set', value: { kind: 'pt', value: 16 } });
  });
});

describe('判据②：emoji 与组合字符的偏移正确', () => {
  it('ZWJ 家庭 emoji 占 5 个码位：只加粗它，后面的文字不受影响', () => {
    const paragraph = paragraphOfRuns('p1', [
      ['r1', `甲${ZWJ_FAMILY}`],
      ['r2', '乙'],
    ]);
    const applied = applyCharacterFormatToInlines(paragraph.inlines, { start: 1, end: 6 }, setToggle('bold', true));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(propsOf(applied.value.inlines, 0)?.bold.state).toBe('unspecified'); // '甲'
    expect(propsOf(applied.value.inlines, 1)?.bold.state).toBe('on'); // 整个 emoji
    expect(inlineText(applied.value.inlines)).toBe(`甲${ZWJ_FAMILY}乙`);
  });

  it('分解形 é（e + U+0301）占 2 个码位：整簇一起被选中', () => {
    const paragraph = paragraphOfRuns('p1', [['r1', `caf${E_ACUTE_DECOMPOSED}`]]);
    const applied = applyCharacterFormatToInlines(paragraph.inlines, { start: 3, end: 5 }, setToggle('bold', true));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const bold = applied.value.inlines.filter((node) => node.kind === 'run' && node.properties.bold.state === 'on');
    expect(bold).toHaveLength(1);
    expect(bold[0]!.kind === 'run' && bold[0]!.text).toBe(E_ACUTE_DECOMPOSED);
    expect(inlineText(applied.value.inlines)).toBe(`caf${E_ACUTE_DECOMPOSED}`);
  });

  it('emoji 与中文混合时偏移不串位', () => {
    const paragraph = paragraphOfRuns('p1', [['r1', `${ZWJ_FAMILY}天气`]]);
    const applied = applyCharacterFormatToInlines(paragraph.inlines, { start: 5, end: 7 }, setToggle('bold', true));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const bold = applied.value.inlines.filter((node) => node.kind === 'run' && node.properties.bold.state === 'on');
    expect(bold[0]!.kind === 'run' && bold[0]!.text).toBe('天气');
  });
});

describe('判据④：只改格式后正文文本逐字不变', () => {
  const doc = document([
    paragraphOfRuns('p1', [['r1', '今天天气很好'], ['r2', '。继续']]),
    paragraphOfRuns('p2', [['r3', '　带全角空格　']]),
  ]);

  it('加粗 / 斜体 / 下划线 / 高亮 / 字号 / 清除格式都不改字', () => {
    const before = allTextOf(doc);
    const operations = [
      setToggle('bold', true),
      setToggle('italic', true),
      setValue('underline', 'double'),
      setValue('highlight', 'yellow'),
      setValue('size', { kind: 'pt', value: 18 }),
      setValue('color', { kind: 'rgb', hex: 'ff0000' }),
      CLEAR_DIRECT_FORMAT,
    ];
    for (const operation of operations) {
      const applied = applyCharacterFormatToDocumentRange(doc, { node_id: 'p1', start: 0, end: 4 }, operation);
      expect(applied.ok, JSON.stringify(operation)).toBe(true);
      if (!applied.ok) continue;
      expect(allTextOf(applied.value)).toEqual(before);
    }
  });

  it('空白与全角空格不被折叠（R104）', () => {
    // '　带全角空格　' = 7 个码位（首尾各一个全角空格）
    const applied = applyCharacterFormatToDocumentRange(doc, { node_id: 'p2', start: 0, end: 7 }, CLEAR_DIRECT_FORMAT);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(allTextOf(applied.value)[1]).toBe('　带全角空格　');
  });
});

describe('判据③：同一词出现两处，只改第二处', () => {
  const doc = document([
    paragraphOfRuns('p1', [['r1', '天气很好']]),
    paragraphOfRuns('p2', [['r2', '天气不错']]),
  ]);

  it('只对第二段的范围施加 ⇒ 第一段整块对象都不变（同一引用）', () => {
    const applied = applyCharacterFormatToDocumentRange(doc, { node_id: 'p2', start: 0, end: 2 }, setToggle('bold', true));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    expect(applied.value.blocks[0]).toBe(doc.blocks[0]); // 未命中路径原引用返回
    expect(allTextOf(applied.value)).toEqual(['天气很好', '天气不错']);

    const first = requireParagraph(applied.value, 'p1');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.inlines).toBe((doc.blocks[0] as { inlines: unknown }).inlines);

    const second = requireParagraph(applied.value, 'p2');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const boldTexts = second.value.inlines
      .filter((node) => node.kind === 'run' && node.properties.bold.state === 'on')
      .map((node) => (node.kind === 'run' ? node.text : ''));
    expect(boldTexts).toEqual(['天气']);
  });
});

describe('R121 + 段落级/选区级入口', () => {
  it('段落级 toggle：全开 ⇒ 关，混合 ⇒ 开', () => {
    const allOn = paragraphOfRuns('p1', [
      ['r1', '甲乙', boldOn()],
      ['r2', '丙丁', boldOn()],
    ]);
    const off = applyCharacterFormatToParagraph(allOn, { start: 0, end: 4 }, toggleProperty('bold'));
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.value.inlines.every((node) => node.kind === 'run' && node.properties.bold.state === 'off')).toBe(true);

    const mixed = paragraphOfRuns('p2', [
      ['r1', '甲乙', boldOn()],
      ['r2', '丙丁'],
    ]);
    const on = applyCharacterFormatToParagraph(mixed, { start: 0, end: 4 }, toggleProperty('bold'));
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    expect(on.value.inlines.every((node) => node.kind === 'run' && node.properties.bold.state === 'on')).toBe(true);
  });

  it('跨段选区的 toggle 只取一个目标态（不会前半段变粗、后半段变细）', () => {
    const doc = document([
      paragraphOfRuns('p1', [['r1', '甲乙', boldOn()]]),
      paragraphOfRuns('p2', [['r2', '丙丁']]),
    ]);
    const applied = applyCharacterFormatToRanges(
      doc,
      [
        { node_id: 'p1', start: 0, end: 2 },
        { node_id: 'p2', start: 0, end: 2 },
      ],
      toggleProperty('bold'),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    for (const paragraph of collectParagraphs(applied.value.blocks)) {
      for (const node of paragraph.inlines) {
        if (node.kind === 'run') expect(node.properties.bold.state).toBe('on');
      }
    }
  });

  it('选区入口先过 R114：旧 revision ⇒ stale_revision，模型不变', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙']])]);
    const applied = applyCharacterFormatToSelection(
      doc,
      { document_id: doc.document_id, base_revision: doc.revision - 1, ranges: [{ node_id: 'p1', start: 0, end: 1 }] },
      setToggle('bold', true),
    );
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.code).toBe('stale_revision');
  });

  it('选区入口：版本一致时按选区施加', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙']])]);
    const applied = applyCharacterFormatToSelection(
      doc,
      { document_id: doc.document_id, base_revision: doc.revision, ranges: [{ node_id: 'p1', start: 1, end: 2 }] },
      setToggle('bold', true),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const paragraph = requireParagraph(applied.value, 'p1');
    expect(paragraph.ok).toBe(true);
    if (!paragraph.ok) return;
    expect(inlineText(paragraph.value.inlines)).toBe('甲乙丙');
    const boldTexts = paragraph.value.inlines
      .filter((node) => node.kind === 'run' && node.properties.bold.state === 'on')
      .map((node) => (node.kind === 'run' ? node.text : ''));
    expect(boldTexts).toEqual(['乙']);
  });
});

describe('R136 原子性：任一范围非法 ⇒ 整批不改', () => {
  it('第二个范围越界 ⇒ 失败，且返回的不是"改了一半"的模型', () => {
    const doc = document([
      paragraphOfRuns('p1', [['r1', '甲乙']]),
      paragraphOfRuns('p2', [['r2', '丙丁']]),
    ]);
    const applied = applyCharacterFormatToRanges(
      doc,
      [
        { node_id: 'p1', start: 0, end: 2 },
        { node_id: 'p2', start: 0, end: 99 },
      ],
      setToggle('bold', true),
    );
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.code).toBe('invalid_range');
    // 源模型未被触碰，也没有"部分结果"被返回
    expect(allTextOf(doc)).toEqual(['甲乙', '丙丁']);
  });

  it('未知节点 id ⇒ unknown_node', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙']])]);
    const applied = applyCharacterFormatToRanges(doc, [{ node_id: 'nope', start: 0, end: 1 }], setToggle('bold', true));
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.code).toBe('unknown_node');
  });

  it('空范围集合 ⇒ empty_range（不假装成功）', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙']])]);
    const applied = applyCharacterFormatToRanges(doc, [], setToggle('bold', true));
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.code).toBe('empty_range');
  });
});

describe('R120：清除字符格式不动段落属性', () => {
  it('只换 inlines，段落 properties / style_ref / numbering 原样', () => {
    const paragraph = paragraphOfRuns(
      'p1',
      [['r1', '甲乙', boldOn()]],
      {
        properties: unspecifiedParagraphProperties({ outlineLevel: { state: 'set', value: 0 } }),
        style_ref: 'Heading1',
        numbering: { num_id: 'n1', level: 0 },
      },
    );
    const doc = document([paragraph]);
    const applied = applyCharacterFormatToDocumentRange(doc, { node_id: 'p1', start: 0, end: 2 }, CLEAR_DIRECT_FORMAT);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const after = collectParagraphs(applied.value.blocks)[0]!;
    expect(deepEqual(after.properties, paragraph.properties)).toBe(true);
    expect(after.style_ref).toBe('Heading1');
    expect(after.numbering).toEqual({ num_id: 'n1', level: 0 });
    expect(after.inlines.every((node) => node.kind === 'run' && node.properties.bold.state === 'inherit')).toBe(true);
  });
});

describe('读回：部分加粗后选区状态为 mixed（R117/R119）', () => {
  it('加粗一半后读回 bold 为 mixed', () => {
    const paragraph = paragraphOfRuns('p1', [['r1', '甲乙丙丁']]);
    const applied = applyCharacterFormatToParagraph(paragraph, { start: 0, end: 2 }, setToggle('bold', true));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const props = applied.value.inlines.filter((node) => node.kind === 'run').map((node) => (node.kind === 'run' ? node.properties : null)!);
    expect(readToggleState(props, 'bold')).toEqual({ state: 'mixed' });
    // mixed 只在读回侧出现，写回侧由 toWritableToggle 拦（见 read.test.ts）
  });

  it('未加粗的 run 与刚创建的 run 都保持 unspecified', () => {
    expect(run('r1', 'x').properties.bold.state).toBe('unspecified');
  });
});

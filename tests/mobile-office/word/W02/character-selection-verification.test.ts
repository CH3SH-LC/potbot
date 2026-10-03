/**
 * **W02 — 字符/选区操作的独立验证**（`tests/mobile-office/word/W02/`）。
 *
 * 对 `src/documents/operations/character/**` + `src/documents/selection/**`（WF-001–016 的字符与
 * 选区相关项）做**独立取证**，不重复 `apply.test.ts` / `replace.test.ts` / `read.test.ts`
 * 已经钉住的判据。本文件只测**未被覆盖**的行为面：
 *
 * | 行为面 | 既有覆盖 | 本文件新增的独立判据 |
 * |---|---|---|
 * | 中英混排（CJK 与拉丁同 run/跨 run） | 仅"emoji + 中文"一例 | 跨 run 边界切拉丁词；范围外 run **对象引用**不变 |
 * | emoji / 代理对 | ZWJ 家庭、分解形 é 整体选中 | `😀A😀B` 按码位切分；**逐 run 断言无孤立代理项**；非整数偏移拒收 |
 * | 跨 run 结构自洽 | 文本不变 | 无零长 run / id 唯一 / 软换行原样带过且可复算 |
 * | **选区反转** | 无 | `start>end` fail-closed（不是静默交换）；同范围正序成功作反向对照 |
 * | **同段多范围（不连续选区）** | 无（**本次修复前会静默丢编辑**） | 不连续/重叠/重复范围逐一取证 |
 * | 原子性 | 跨段越界 | 段内第二范围越界 ⇒ 第一范围也不落地 |
 *
 * ## 反向对照（防"判据是空壳"）
 *
 * - §A/§E 的每条关键断言都配一条**边界邻位**用例（如 `[4,6)` 与 `[3,5)` 必须产出**不同**文本）；
 *   选区边界算错一码位，这些用例立即变红。
 * - §D 反转用例配**正序对照**：同一区间正序必须成功 ⇒ 拒收针对的是"顺序倒置"而非"整类范围"。
 * - §E 配**跨段对照**：修复前就正确的跨段路径必须仍然正确（防"分组引入新回归"）。
 *
 * 断言全部追溯到合同语义（R102 码位偏移、R104 不折叠空白、R117 四态、R121 toggle、
 * R136 原子性、R147/R151 范围外不变），不照抄实现内部量。
 */

import { describe, expect, it } from 'vitest';

import type { DocumentModel, InlineNode, ParagraphNode, RunNode } from '../../../../src/documents/model/types.js';
import {
  applyCharacterFormatToInlines,
  applyCharacterFormatToRanges,
  applyCharacterFormatToSelection,
} from '../../../../src/documents/operations/character/apply.js';
import { setToggle, toggleProperty } from '../../../../src/documents/operations/character/types.js';
import { deepEqual } from '../../../../src/documents/selection/equals.js';
import { inlineText } from '../../../../src/documents/selection/inline-map.js';
import { collectParagraphs, paragraphText, requireParagraph } from '../../../../src/documents/selection/structure.js';
import {
  boldOn,
  breakNode,
  document,
  E_ACUTE_DECOMPOSED,
  field,
  paragraph,
  paragraphOfRuns,
  run,
  runProperties,
  unspecifiedRunProperties,
  ZWJ,
  ZWJ_FAMILY,
} from '../../../../src/documents/selection/testing.js';

// ---------------------------------------------------------------------------
// 独立工具（不 import 生产实现的判定逻辑，避免自证）
// ---------------------------------------------------------------------------

/** 按码位切分（用 `Array.from`，与实现无关的独立写法）。 */
function points(text: string): string[] {
  return Array.from(text);
}

/** 孤立代理项（成对的代理项会一起匹配掉，不会残留）。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function hasLoneSurrogate(text: string): boolean {
  return LONE_SURROGATE.test(text);
}

function runsOf(inlines: readonly InlineNode[]): RunNode[] {
  return inlines.filter((node): node is RunNode => node.kind === 'run');
}

function boldTexts(inlines: readonly InlineNode[]): string[] {
  return runsOf(inlines).filter((node) => node.properties.bold.state === 'on').map((node) => node.text);
}

/** 只把 run 的文本拼起来（不含软换行/域占位）——用于独立复算"切 run 不改字"。 */
function concatenatedRunText(inlines: readonly InlineNode[]): string {
  return runsOf(inlines).map((node) => node.text).join('');
}

function textOf(model: DocumentModel): string[] {
  return collectParagraphs(model.blocks).map(paragraphText);
}

function paragraphById(model: DocumentModel, id: string): ParagraphNode {
  const found = requireParagraph(model, id);
  if (!found.ok) throw new Error(`测试夹具缺少段落 ${id}`);
  return found.value;
}

/** 施加到单段范围，断言成功，返回结果段落。 */
function applyOk(paragraphNode: ParagraphNode, start: number, end: number, operation: Parameters<typeof applyCharacterFormatToInlines>[2]): ParagraphNode {
  const applied = applyCharacterFormatToInlines(paragraphNode.inlines, { start, end }, operation);
  expect(applied.ok).toBe(true);
  if (!applied.ok) throw new Error('施加失败');
  return { ...paragraphNode, inlines: applied.value.inlines };
}

// ---------------------------------------------------------------------------
// §A 中英混排与跨 run 边界
// ---------------------------------------------------------------------------

describe('§A 中英混排：跨 run 边界切拉丁词，范围外原对象引用不变', () => {
  // 'Hello世界' + 'wide中'：码位 0..11；'o'=4 '世'=5 '界'=6 'w'=7
  const paragraphNode = paragraphOfRuns('p1', [
    ['r1', 'Hello世界'],
    ['r2', 'wide中'],
  ]);

  it('选 [4,6) ⇒ 恰好加粗 "o世"，其余文本与属性原样', () => {
    const applied = applyCharacterFormatToInlines(paragraphNode.inlines, { start: 4, end: 6 }, setToggle('bold', true));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    expect(applied.value.changed).toBe(true);
    expect(boldTexts(applied.value.inlines)).toEqual(['o世']);

    // 范围**之前**的片段保留原 run id、且属性仍是"未指定"
    const pieces = applied.value.inlines;
    expect(pieces.map((n) => (n.kind === 'run' ? n.text : '?')).join('')).toBe('Hello世界wide中');
    expect(deepEqual(runsOf(pieces)[0]!.properties, unspecifiedRunProperties())).toBe(true);
    // 范围**之后**的整个 run（r2 未被穿过）必须是**同一对象引用**——范围外逐字节不变的 JS 侧证据
    expect(pieces[pieces.length - 1]).toBe(paragraphNode.inlines[1]);
  });

  it('反向对照：边界邻位 [3,5) 产出不同文本（"lo" ≠ "o世"）——边界算错即红', () => {
    const shifted = applyCharacterFormatToInlines(paragraphNode.inlines, { start: 3, end: 5 }, setToggle('bold', true));
    expect(shifted.ok).toBe(true);
    if (!shifted.ok) return;
    expect(boldTexts(shifted.value.inlines)).toEqual(['lo']);
    expect(boldTexts(shifted.value.inlines)).not.toEqual(['o世']);
  });

  it('反向对照：整段 [0,12) ⇒ 两 run 全选中，文本逐码位不变', () => {
    const before = points(paragraphText(paragraphNode)).join('');
    const applied = applyCharacterFormatToInlines(paragraphNode.inlines, { start: 0, end: 12 }, setToggle('bold', true));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(boldTexts(applied.value.inlines)).toEqual(['Hello世界', 'wide中']);
    expect(points(inlineText(applied.value.inlines)).join('')).toBe(before);
  });

  it('已有其它格式的 run：加粗不覆盖斜体/字号（逐字段）', () => {
    const styled = paragraphOfRuns('p2', [
      ['r1', 'αβ', runProperties({ italic: { state: 'on' } })],
      ['r2', '中文', runProperties({ size: { state: 'set', value: { kind: 'pt', value: 16 } } })],
      ['r3', 'γδ'],
    ]);
    const applied = applyCharacterFormatToInlines(styled.inlines, { start: 1, end: 4 }, setToggle('bold', true));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(boldTexts(applied.value.inlines)).toEqual(['β', '中文']);
    const beta = runsOf(applied.value.inlines).find((n) => n.text === 'β');
    const cjk = runsOf(applied.value.inlines).find((n) => n.text === '中文');
    expect(beta?.properties.italic).toEqual({ state: 'on' });
    expect(cjk?.properties.size).toEqual({ state: 'set', value: { kind: 'pt', value: 16 } });
    expect(runsOf(applied.value.inlines).find((n) => n.text === 'α')?.properties.bold.state).toBe('unspecified');
  });
});

// ---------------------------------------------------------------------------
// §B emoji / 代理对
// ---------------------------------------------------------------------------

describe('§B emoji 与代理对：绝不按 UTF-16 码元切断', () => {
  const GRIN = '\u{1F600}';

  it('"😀A😀B" 是 4 个码位 / 6 个 UTF-16 码元；选 [1,3) ⇒ 加粗 "A😀" 且无孤立代理项', () => {
    const text = `${GRIN}A${GRIN}B`;
    expect(text.length).toBe(6); // UTF-16 码元
    expect(points(text).length).toBe(4); // 码位（独立复算）

    const p = paragraphOfRuns('p1', [['r1', text]]);
    const applied = applyCharacterFormatToInlines(p.inlines, { start: 1, end: 3 }, setToggle('bold', true));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    expect(boldTexts(applied.value.inlines)).toEqual([`A${GRIN}`]);
    // 还原的文本逐码位等于原文；且没有任何 run 含半个代理对
    expect(points(inlineText(applied.value.inlines)).join('')).toBe(text);
    expect(runsOf(applied.value.inlines).every((n) => !hasLoneSurrogate(n.text))).toBe(true);
    // 未选中的前后片段各自是完整码位串（'😀' 与 'B'）
    expect(runsOf(applied.value.inlines).map((n) => n.text)).toEqual([GRIN, `A${GRIN}`, 'B']);
  });

  it('两个 run 各含一个增补平面字符：选 [0,1) 只动第一个', () => {
    const p = paragraphOfRuns('p1', [
      ['r1', GRIN],
      ['r2', GRIN],
    ]);
    const applied = applyCharacterFormatToInlines(p.inlines, { start: 0, end: 1 }, setToggle('bold', true));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(boldTexts(applied.value.inlines)).toEqual([GRIN]);
    expect(points(inlineText(applied.value.inlines)).join('')).toBe(`${GRIN}${GRIN}`);
    expect(applied.value.inlines.every((n) => n.kind !== 'run' || !hasLoneSurrogate(n.text))).toBe(true);
  });

  it('整数码位区间无法表达"半个代理对"：非整数偏移一律 invalid_range（fail-closed）', () => {
    const p = paragraphOfRuns('p1', [['r1', `${GRIN}A`]]);
    const half = applyCharacterFormatToInlines(p.inlines, { start: 1.5, end: 2 }, setToggle('bold', true));
    expect(half.ok).toBe(false);
    if (half.ok) return;
    expect(half.code).toBe('invalid_range');
    // 源头未改
    expect(inlineText(p.inlines)).toBe(`${GRIN}A`);
  });

  it('ZWJ 家庭 emoji 内部按码位边界选中：无孤立代理项，整段文本可还原', () => {
    const text = `甲${ZWJ_FAMILY}乙`;
    const p = paragraphOfRuns('p1', [['r1', text]]);
    // [1,3) = 第一个小人 + ZWJ（码位粒度，可表达且不产生孤立代理项）
    const applied = applyCharacterFormatToInlines(p.inlines, { start: 1, end: 3 }, setToggle('bold', true));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(runsOf(applied.value.inlines).every((n) => !hasLoneSurrogate(n.text))).toBe(true);
    expect(points(inlineText(applied.value.inlines)).join('')).toBe(text);
    // 选中的是两个完整码位（人 + ZWJ）
    expect(boldTexts(applied.value.inlines)).toEqual([`\u{1F468}${ZWJ}`]);
  });

  it('分解形 é：整体选中与只选基字符都不产生非法串', () => {
    const text = `caf${E_ACUTE_DECOMPOSED}`;
    const whole = paragraphOfRuns('p1', [['r1', text]]);
    const a = applyCharacterFormatToInlines(whole.inlines, { start: 3, end: 5 }, setToggle('bold', true));
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(boldTexts(a.value.inlines)).toEqual([E_ACUTE_DECOMPOSED]);

    const base = applyCharacterFormatToInlines(whole.inlines, { start: 3, end: 4 }, setToggle('bold', true));
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    expect(boldTexts(base.value.inlines)).toEqual(['e']);
    expect(points(inlineText(base.value.inlines)).join('')).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// §C 跨 run 编辑后的结构自洽
// ---------------------------------------------------------------------------

describe('§C 切 run 后结构与文本自洽', () => {
  it('软换行不被切碎、原样带过；范围外文本可逐码位还原', () => {
    const p = paragraph('p1', [run('r1', '甲😀乙'), breakNode('b1'), run('r2', '丙丁')]);
    // 码位：甲(0) 😀(1) 乙(2) \n(3) 丙(4) 丁(5)，共 6
    const applied = applyCharacterFormatToInlines(p.inlines, { start: 0, end: 4 }, setToggle('bold', true));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    // 软换行节点按引用原样保留
    const brk = applied.value.inlines.find((n) => n.kind === 'break');
    expect(brk).toBe(p.inlines[1]);
    expect(boldTexts(applied.value.inlines)).toEqual(['甲😀乙']);
    // 带 '\n' 的整段文本可还原（R104：软换行占一位）
    expect(inlineText(applied.value.inlines)).toBe('甲😀乙\n丙丁');
    // 独立复算：run 文本拼接 + 软换行 = run 文本 + '\n'
    expect(concatenatedRunText(applied.value.inlines)).toBe('甲😀乙丙丁');
  });

  it('切分不产生零长 run，派生 id 唯一', () => {
    const p = paragraphOfRuns('p1', [
      ['r1', 'Hello世界'],
      ['r2', 'wide中'],
    ]);
    const applied = applyCharacterFormatToInlines(p.inlines, { start: 4, end: 6 }, setToggle('bold', true));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const pieces = runsOf(applied.value.inlines);
    expect(pieces.every((n) => n.text.length > 0)).toBe(true);
    const ids = pieces.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('幂等：对已加粗结果再施加同一操作 ⇒ changed=false，文本不变', () => {
    const p = paragraphOfRuns('p1', [['r1', '甲乙丙丁']]);
    const once = applyOk(p, 0, 2, setToggle('bold', true));
    const twice = applyCharacterFormatToInlines(once.inlines, { start: 0, end: 2 }, setToggle('bold', true));
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(twice.value.changed).toBe(false);
    expect(points(inlineText(twice.value.inlines)).join('')).toBe('甲乙丙丁');
  });
});

// ---------------------------------------------------------------------------
// §D 选区反转
// ---------------------------------------------------------------------------

describe('§D 选区反转：fail-closed（不静默交换起止）', () => {
  it('反转范围 [3,1) ⇒ invalid_range，且不修改源文档', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const applied = applyCharacterFormatToRanges(doc, [{ node_id: 'p1', start: 3, end: 1 }], setToggle('bold', true));
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.code).toBe('invalid_range');
    expect(textOf(doc)).toEqual(['甲乙丙丁']);
  });

  it('正序对照：同一区间 [1,3) 成功，且恰好加粗 "乙丙" —— 拒收针对顺序而非整类', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const applied = applyCharacterFormatToRanges(doc, [{ node_id: 'p1', start: 1, end: 3 }], setToggle('bold', true));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(boldTexts(paragraphById(applied.value, 'p1').inlines)).toEqual(['乙丙']);
  });

  it('原子性：第二范围反转 ⇒ 第一范围也不落地（源文档零改动）', () => {
    const doc = document([
      paragraphOfRuns('p1', [['r1', '甲乙']]),
      paragraphOfRuns('p2', [['r2', '丙丁']]),
    ]);
    const applied = applyCharacterFormatToRanges(
      doc,
      [
        { node_id: 'p1', start: 0, end: 2 },
        { node_id: 'p2', start: 2, end: 0 },
      ],
      setToggle('bold', true),
    );
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.code).toBe('invalid_range');
    expect(textOf(doc)).toEqual(['甲乙', '丙丁']);
    expect(runsOf(paragraphById(doc, 'p1').inlines).every((n) => n.properties.bold.state === 'unspecified')).toBe(true);
  });

  it('选区入口（revision 一致）遇到反转范围同样拒收', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const applied = applyCharacterFormatToSelection(
      doc,
      { document_id: 'doc-1', base_revision: 1, ranges: [{ node_id: 'p1', start: 3, end: 1 }] },
      setToggle('bold', true),
    );
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.code).toBe('invalid_range');
  });

  it('零宽范围（start=end）是"光标"，合法且无改动（与反转区分开）', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const applied = applyCharacterFormatToRanges(doc, [{ node_id: 'p1', start: 2, end: 2 }], setToggle('bold', true));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(boldTexts(paragraphById(applied.value, 'p1').inlines)).toEqual([]);
    expect(textOf(applied.value)).toEqual(['甲乙丙丁']);
  });
});

// ---------------------------------------------------------------------------
// §E 同段多范围（不连续选区）—— 本次修复的核心
// ---------------------------------------------------------------------------

describe('§E 同一段落的多个范围：累加而非互相覆盖', () => {
  it('两个不相交范围 ⇒ 两段都加粗（修复前第二个会盖掉第一个）', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const applied = applyCharacterFormatToRanges(
      doc,
      [
        { node_id: 'p1', start: 0, end: 2 },
        { node_id: 'p1', start: 2, end: 4 },
      ],
      setToggle('bold', true),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(boldTexts(paragraphById(applied.value, 'p1').inlines)).toEqual(['甲乙', '丙丁']);
    expect(textOf(applied.value)).toEqual(['甲乙丙丁']);
  });

  it('三个不相交范围（含非连续选区语义）⇒ 三处都加粗', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', 'ABCDEF']])]);
    const applied = applyCharacterFormatToRanges(
      doc,
      [
        { node_id: 'p1', start: 0, end: 1 },
        { node_id: 'p1', start: 2, end: 4 },
        { node_id: 'p1', start: 5, end: 6 },
      ],
      setToggle('bold', true),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(boldTexts(paragraphById(applied.value, 'p1').inlines)).toEqual(['A', 'CD', 'F']);
  });

  it('重叠范围 ⇒ 取并集，先做的改动不被后做的盖回', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const applied = applyCharacterFormatToRanges(
      doc,
      [
        { node_id: 'p1', start: 0, end: 3 },
        { node_id: 'p1', start: 2, end: 4 },
      ],
      setToggle('bold', true),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    // 并集 = 整段 4 个码位
    expect(boldTexts(paragraphById(applied.value, 'p1').inlines).join('')).toBe('甲乙丙丁');
  });

  it('重复范围（同一区间两次）⇒ 幂等，文本不重复、只加粗一次', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const applied = applyCharacterFormatToRanges(
      doc,
      [
        { node_id: 'p1', start: 1, end: 3 },
        { node_id: 'p1', start: 1, end: 3 },
      ],
      setToggle('bold', true),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const p = paragraphById(applied.value, 'p1');
    expect(boldTexts(p.inlines)).toEqual(['乙丙']);
    expect(inlineText(p.inlines)).toBe('甲乙丙丁');
  });

  it('toggle 跨同段多范围只取一个目标态（R121）', () => {
    const doc = document([
      paragraphOfRuns('p1', [
        ['r1', '甲乙', boldOn()],
        ['r2', '丙丁'],
      ]),
    ]);
    const applied = applyCharacterFormatToRanges(
      doc,
      [
        { node_id: 'p1', start: 0, end: 2 },
        { node_id: 'p1', start: 2, end: 4 },
      ],
      toggleProperty('bold'),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    // 混合 ⇒ 统一取 on，两个范围一致
    expect(runsOf(paragraphById(applied.value, 'p1').inlines).every((n) => n.properties.bold.state === 'on')).toBe(true);
  });

  it('正序对照：跨段（不同段落）多范围仍然都生效——分组不引入新回归', () => {
    const doc = document([
      paragraphOfRuns('p1', [['r1', '甲乙']]),
      paragraphOfRuns('p2', [['r2', '丙丁']]),
    ]);
    const applied = applyCharacterFormatToRanges(
      doc,
      [
        { node_id: 'p1', start: 0, end: 2 },
        { node_id: 'p2', start: 0, end: 2 },
      ],
      setToggle('bold', true),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(boldTexts(paragraphById(applied.value, 'p1').inlines)).toEqual(['甲乙']);
    expect(boldTexts(paragraphById(applied.value, 'p2').inlines)).toEqual(['丙丁']);
  });

  it('范围顺序与文档顺序不一致时仍都生效', () => {
    const doc = document([
      paragraphOfRuns('p1', [['r1', '甲乙']]),
      paragraphOfRuns('p2', [['r2', '丙丁']]),
    ]);
    const applied = applyCharacterFormatToRanges(
      doc,
      [
        { node_id: 'p2', start: 0, end: 2 },
        { node_id: 'p1', start: 0, end: 2 },
      ],
      setToggle('bold', true),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(boldTexts(paragraphById(applied.value, 'p1').inlines)).toEqual(['甲乙']);
    expect(boldTexts(paragraphById(applied.value, 'p2').inlines)).toEqual(['丙丁']);
  });
});

// ---------------------------------------------------------------------------
// §F 原子性与不可编辑边界
// ---------------------------------------------------------------------------

describe('§F 原子性与不可切分节点', () => {
  it('段内第二范围越界 ⇒ 第一范围也不落地', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '甲乙丙丁']])]);
    const applied = applyCharacterFormatToRanges(
      doc,
      [
        { node_id: 'p1', start: 0, end: 2 },
        { node_id: 'p1', start: 0, end: 99 },
      ],
      setToggle('bold', true),
    );
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.code).toBe('invalid_range');
    expect(boldTexts(paragraphById(doc, 'p1').inlines)).toEqual([]);
  });

  it('范围边界落在多码位域内部 ⇒ unsupported（拒绝切域），源文档零改动', () => {
    // 'abc' + 域缓存 '12345' + 'xyz'：码位 0..10；域占 [3,8)
    const p = paragraph('p1', [run('r1', 'abc'), field('f1', 'PAGE', '12345'), run('r3', 'xyz')]);
    const doc = document([p]);
    const applied = applyCharacterFormatToRanges(doc, [{ node_id: 'p1', start: 4, end: 6 }], setToggle('bold', true));
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.code).toBe('unsupported');
    expect(textOf(doc)).toEqual(['abc12345xyz']);
  });

  it('范围只覆盖域/非 run ⇒ 合法但 changed=false（不崩、不改）', () => {
    const p = paragraph('p1', [run('r1', 'abc'), field('f1', 'PAGE', '12345'), run('r3', 'xyz')]);
    const applied = applyCharacterFormatToInlines(p.inlines, { start: 3, end: 8 }, setToggle('bold', true));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.changed).toBe(false);
    expect(applied.value.selectedRunCount).toBe(0);
    expect(inlineText(applied.value.inlines)).toBe('abc12345xyz');
  });
});

// ---------------------------------------------------------------------------
// §G 范围外不变（逐字段 / 逐对象）
// ---------------------------------------------------------------------------

describe('§G 范围外文字与格式不变', () => {
  it('只动 p1 ⇒ p2 的整块对象是同一引用', () => {
    const doc = document([
      paragraphOfRuns('p1', [['r1', '甲乙']]),
      paragraphOfRuns('p2', [['r2', '丙丁']]),
    ]);
    const applied = applyCharacterFormatToRanges(doc, [{ node_id: 'p1', start: 0, end: 1 }], setToggle('bold', true));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.blocks[1]).toBe(doc.blocks[1]);
    expect(paragraphById(applied.value, 'p2').inlines).toBe(paragraphById(doc, 'p2').inlines);
  });

  it('加粗不改动同一 run 上的其它 16 个字段中的任何一个（逐字段）', () => {
    const rich = runProperties({
      italic: { state: 'on' },
      underline: { state: 'set', value: 'double' },
      size: { state: 'set', value: { kind: 'pt', value: 20 } },
      color: { state: 'set', value: { kind: 'rgb', hex: '00ff00' } },
      spacing: { state: 'set', value: { kind: 'expanded', value: { unit: 'pt', value: 1 } } },
    });
    const p = paragraphOfRuns('p1', [['r1', '甲乙丙丁', rich]]);
    const applied = applyCharacterFormatToInlines(p.inlines, { start: 0, end: 2 }, setToggle('bold', true));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const bold = runsOf(applied.value.inlines).find((n) => n.text === '甲乙')!;
    expect(bold.properties.bold).toEqual({ state: 'on' });
    // 除 bold 外逐字段一致
    const { bold: _ignored, ...rest } = bold.properties;
    const { bold: _origBold, ...origRest } = rich;
    expect(deepEqual(rest, origRest)).toBe(true);
  });
});

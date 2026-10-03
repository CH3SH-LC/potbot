/**
 * 撤销/重做 · 失败保旧 · 复制粘贴 · 查找替换 · 版本比较 · 乐观并发（PPT-14）用例。
 *
 * ## 反向对照（每条能力至少一条）
 *
 * - **撤销再重做必须回到原态**：撤销后 `redo` 同步数，版本号与模型摘要都要回到撤销前那一版；
 * - **失败改写后历史摘要必须不变**：抛错与"返回半个演示"两条路径都断言 `outcome.history === history`
 *   （引用相等，比"看着没变"强）且 `presentationHistorySummary` 一字不变；
 * - **并发必须拒绝而不是最后写入者赢**：A 先提交、B 仍基于旧版本提交 ⇒ B 被拒，最终模型是 A 的，
 *   B 的改动**不在**里面；
 * - **精确选区保留未选内容**：前缀 / 后缀的字符与**样式对象引用**、同段其余 run 的**对象引用**
 *   都要原样（`toBe`），任何"整段重造"的实现都会在这里翻车；
 * - **粘贴永远不重号**：`findDuplicateShapeIds` 为空的正面 + "带重号的页上一律具名拒绝"的负面。
 *
 * ## 未验证边界（如实标注）
 *
 * - 真机 / Office 打开**未验证（需消费端）**——本文件只到"模型 + 字节"这一层；
 * - 匹配是 **run 内**的（与 `text.ts` 选区语义同边界）；跨 run 短语不命中，用例不做假的期待。
 */

import { describe, expect, it } from 'vitest';

import { addShape, addSlide } from './operations.js';
import type {
  Paragraph,
  Presentation,
  RunStyle,
  Shape,
  TextBody,
  TextRun,
} from './model.js';
import { transform } from './model.js';
import { emptyPresentation, renderPresentation } from './render.js';
import { exportImportedPresentation, importPresentation } from './roundtrip.js';
import {
  PresentationHistoryError,
  clonePresentation,
  commitPresentationEdit,
  commitPresentationEditGuarded,
  comparePresentationBytes,
  comparePresentationSnapshots,
  copyShapes,
  createPresentationHistory,
  currentPresentation,
  currentPresentationDataVersion,
  currentPresentationRevision,
  detectPresentationStaleWrite,
  findDuplicateShapeIds,
  findPlaceholders,
  findText,
  pasteShapes,
  presentationDigest,
  presentationHistoryLabels,
  presentationHistorySummary,
  redoPresentationHistory,
  redoPresentationSteps,
  replaceAllText,
  replacePlaceholder,
  undoPresentationHistory,
  undoPresentationSteps,
  type PresentationHistoryErrorReason,
  type PresentationHistoryState,
} from './undo-history.js';

// ---------------------------------------------------------------------------
// 夹具与断言助手
// ---------------------------------------------------------------------------

function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) {
    throw new Error(`夹具错误：下标 ${String(index)} 越界`);
  }
  return value;
}

function literal(text: string, style?: RunStyle): TextRun {
  return style === undefined ? { source: { kind: 'literal', text } } : { source: { kind: 'literal', text }, style };
}

function para(runs: readonly TextRun[], overrides?: Partial<Paragraph>): Paragraph {
  return { runs, level: 0, alignment: 'left', bullet: false, ...overrides };
}

function textBox(shapeId: number, name: string, paragraphs: readonly Paragraph[]): Shape {
  return {
    kind: 'text_box',
    shape_id: shapeId,
    name,
    transform: transform(0, 0, 914400, 914400),
    text: { paragraphs },
  };
}

/** 两页演示：第 1 页形状 2「Hello World」/ 3「Hello again」+「abc-abc」；第 2 页形状 2「Second page」。 */
function twoSlideDeck(): Presentation {
  let deck = emptyPresentation('deck-1', '演示');
  const first = addSlide(deck);
  deck = first.presentation;
  deck = addShape(deck, first.slide_id, textBox(2, 'Title', [para([literal('Hello World')])]));
  deck = addShape(
    deck,
    first.slide_id,
    textBox(3, 'Body', [para([literal('Hello again')]), para([literal('abc-abc')])]),
  );
  const second = addSlide(deck);
  deck = second.presentation;
  deck = addShape(deck, second.slide_id, textBox(2, 'Title2', [para([literal('Second page')])]));
  return deck;
}

function shapeText(deck: Presentation, slideIndex: number, shapeIndex: number): TextBody {
  const slide = at(deck.slides, slideIndex);
  const shape = at(slide.shapes, shapeIndex);
  if (shape.kind !== 'text_box') {
    throw new Error('夹具错误：期望一个文本框');
  }
  return shape.text;
}

function paragraphText(deck: Presentation, slideIndex: number, shapeIndex: number, paragraphIndex: number): string {
  const paragraph = at(shapeText(deck, slideIndex, shapeIndex).paragraphs, paragraphIndex);
  return paragraph.runs.map((run) => (run.source.kind === 'literal' ? run.source.text : '')).join('');
}

function expectReason(run: () => unknown, reason: PresentationHistoryErrorReason): void {
  try {
    run();
    throw new Error('应当抛出 PresentationHistoryError');
  } catch (error) {
    expect(error).toBeInstanceOf(PresentationHistoryError);
    expect((error as PresentationHistoryError).reason).toBe(reason);
  }
}

function commitOrThrow(history: PresentationHistoryState, label: string, mutate: (draft: Presentation) => Presentation): PresentationHistoryState {
  const outcome = commitPresentationEdit(history, label, mutate);
  if (!outcome.ok) {
    throw new Error(`夹具错误：提交 ${label} 失败：${outcome.error.message}`);
  }
  return outcome.history;
}

// ---------------------------------------------------------------------------
// 1. 撤销 / 重做（多步 + 分支清空 + 反向对照）
// ---------------------------------------------------------------------------

describe('PPT-14：撤销 / 重做', () => {
  it('反向对照：撤销后再重做，版本号与模型摘要都回到原态', () => {
    const history = createPresentationHistory(twoSlideDeck());
    const initialDigest = presentationDigest(currentPresentation(history));

    const committed = commitOrThrow(history, 'e1', (draft) => replaceAllText(draft, 'Hello', 'Hi').presentation);
    const afterDigest = presentationHistorySummary(committed).digest;
    expect(currentPresentationRevision(committed)).toBe(1);

    const undone = undoPresentationHistory(committed);
    expect(currentPresentationRevision(undone)).toBe(0);
    expect(presentationDigest(currentPresentation(undone))).toBe(initialDigest);

    const redone = redoPresentationHistory(undone);
    expect(currentPresentationRevision(redone)).toBe(1);
    expect(presentationHistorySummary(redone)).toEqual(presentationHistorySummary(committed));
    expect(presentationDigest(currentPresentation(redone))).toBe(afterDigest);
  });

  it('多步：三次提交 → 三步撤销回初始 → 三步重做回最新', () => {
    const history = createPresentationHistory(twoSlideDeck());
    const initialDigest = presentationDigest(currentPresentation(history));

    let state = history;
    state = commitOrThrow(state, 'e1', (d) => replaceAllText(d, 'Hello', 'H1').presentation);
    state = commitOrThrow(state, 'e2', (d) => replaceAllText(d, 'again', 'AGAIN').presentation);
    state = commitOrThrow(state, 'e3', (d) => replaceAllText(d, 'abc', 'XYZ').presentation);
    const latestDigest = presentationDigest(currentPresentation(state));
    expect(currentPresentationRevision(state)).toBe(3);

    const back = undoPresentationSteps(state, 3);
    expect(currentPresentationRevision(back)).toBe(0);
    expect(presentationDigest(currentPresentation(back))).toBe(initialDigest);

    const forward = redoPresentationSteps(back, 3);
    expect(currentPresentationRevision(forward)).toBe(3);
    expect(presentationDigest(currentPresentation(forward))).toBe(latestDigest);
  });

  it('分支清空：撤销后提交新改写，旧的重做链作废', () => {
    let state = createPresentationHistory(twoSlideDeck());
    state = commitOrThrow(state, 'e1', (d) => replaceAllText(d, 'Hello', 'H1').presentation);
    state = commitOrThrow(state, 'e2', (d) => replaceAllText(d, 'again', 'AGAIN').presentation);

    const undone = undoPresentationHistory(state);
    expect(presentationHistoryLabels(undone)).toEqual(['initial', 'e1', 'e2']);
    // 撤销后 future 里有 e2 ⇒ 可重做
    expect(undone.future.length).toBe(1);

    const branched = commitOrThrow(undone, 'e1b', (d) => replaceAllText(d, 'World', 'W1').presentation);
    expect(presentationHistoryLabels(branched)).toEqual(['initial', 'e1', 'e1b']);
    expect(branched.future.length).toBe(0); // 分支清空
    // 反面：旧的 e2 分支已不在历史里
    expect(presentationHistoryLabels(branched)).not.toContain('e2');
  });

  it('无可撤销 / 无可重做时具名报错（不静默成功）', () => {
    const history = createPresentationHistory(twoSlideDeck());
    expectReason(() => undoPresentationHistory(history), 'nothing_to_undo');
    expectReason(() => redoPresentationHistory(history), 'nothing_to_redo');
    expectReason(() => undoPresentationSteps(history, -1), 'invalid_steps');
  });
});

// ---------------------------------------------------------------------------
// 2. 失败保旧
// ---------------------------------------------------------------------------

describe('PPT-14：失败保旧（失败不得留下半个演示）', () => {
  it('反向对照：改写抛错 ⇒ 历史原样返回且摘要一字不变', () => {
    const history = createPresentationHistory(twoSlideDeck());
    const before = presentationHistorySummary(history);

    const outcome = commitPresentationEdit(history, 'boom', () => {
      throw new Error('改写中途失败');
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.history).toBe(history); // 引用相等 = 结构性失败保旧
    expect(presentationHistorySummary(outcome.history)).toEqual(before);
    expect(currentPresentationRevision(outcome.history)).toBe(0);
  });

  it('改写返回半个演示（缺 slides）⇒ 拒绝并失败保旧', () => {
    const history = createPresentationHistory(twoSlideDeck());
    const before = presentationHistorySummary(history);
    const outcome = commitPresentationEdit(history, 'half', (draft) => {
      return { ...draft, slides: undefined } as unknown as Presentation;
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error).toBeInstanceOf(PresentationHistoryError);
    expect((outcome.error as PresentationHistoryError).reason).toBe('half_presentation');
    expect(outcome.history).toBe(history);
    expect(presentationHistorySummary(outcome.history)).toEqual(before);
  });

  it('草稿与历史不共享对象：改写就地改草稿再抛错，历史一字不动', () => {
    const history = createPresentationHistory(twoSlideDeck());
    const before = presentationHistorySummary(history);
    const outcome = commitPresentationEdit(history, 'partial', (draft) => {
      const slide = at(draft.slides, 0);
      (slide.shapes as Shape[]).push(textBox(99, 'Injected', [para([literal('INJECTED')])]));
      throw new Error('改到一半抛错');
    });
    expect(outcome.ok).toBe(false);
    expect(presentationHistorySummary(outcome.history)).toEqual(before);
    // 被就地塞进去的对象没有渗进历史
    expect(findText(currentPresentation(history), 'INJECTED').length).toBe(0);
    expect(at(currentPresentation(history).slides, 0).shapes.length).toBe(2);
  });

  it('反面：改写成功时版本号与摘要都会变', () => {
    const history = createPresentationHistory(twoSlideDeck());
    const before = presentationHistorySummary(history);
    const outcome = commitPresentationEdit(history, 'ok', (d) => replaceAllText(d, 'Hello', 'Hi').presentation);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(currentPresentationRevision(outcome.history)).toBe(1);
    expect(presentationHistorySummary(outcome.history).digest).not.toBe(before.digest);
  });

  it('clonePresentation 深拷贝：结构等价但不共享引用', () => {
    const deck = twoSlideDeck();
    const copy = clonePresentation(deck);
    expect(copy).toEqual(deck);
    expect(copy).not.toBe(deck);
    expect(at(copy.slides, 0)).not.toBe(at(deck.slides, 0));
    expect(at(at(copy.slides, 0).shapes, 0)).not.toBe(at(at(deck.slides, 0).shapes, 0));
  });
});

// ---------------------------------------------------------------------------
// 3. 并发控制（乐观并发）
// ---------------------------------------------------------------------------

describe('PPT-14：并发控制（乐观并发）', () => {
  it('detectPresentationStaleWrite：期望 = 当前 ⇒ ok；不等 ⇒ stale_write', () => {
    expect(detectPresentationStaleWrite(2, 2).ok).toBe(true);
    const verdict = detectPresentationStaleWrite(2, 3);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.reason).toBe('stale_write');
    expect(verdict.expected).toBe(2);
    expect(verdict.current).toBe(3);
    expect(verdict.message).toContain('拒绝静默覆盖');
  });

  it('反向对照：并发冲突必须拒绝，而不是最后写入者赢', () => {
    const history = createPresentationHistory(twoSlideDeck());
    const base = currentPresentationRevision(history); // 0

    const a = commitPresentationEditGuarded(history, base, 'A', (d) => replaceAllText(d, 'Hello', 'AAA').presentation);
    expect(a.ok).toBe(true);
    if (!a.ok) throw new Error('unreachable');

    const digestAfterA = presentationHistorySummary(a.history).digest;

    // B 仍基于旧版本 base 提交 ⇒ 必须被拒
    const b = commitPresentationEditGuarded(a.history, base, 'B', (d) => replaceAllText(d, 'Hello', 'BBB').presentation);
    expect(b.ok).toBe(false);
    if (b.ok) throw new Error('unreachable');
    if (b.reason !== 'stale_write') throw new Error('unreachable：应当是并发冲突');
    expect(b.reason).toBe('stale_write');
    expect(b.expected).toBe(base);
    expect(b.current).toBe(1);
    expect(b.history).toBe(a.history); // 不改任何东西

    // 最终模型是 A 的：AAA 在、BBB 不在、Hello 已被全部替换
    const model = currentPresentation(a.history);
    expect(findText(model, 'AAA').length).toBeGreaterThan(0);
    expect(findText(model, 'BBB').length).toBe(0);
    expect(findText(model, 'Hello').length).toBe(0);
    expect(presentationHistorySummary(a.history).digest).toBe(digestAfterA);
  });

  it('版本一致时守卫提交正常成功', () => {
    const history = createPresentationHistory(twoSlideDeck());
    const outcome = commitPresentationEditGuarded(history, 0, 'sync', (d) => replaceAllText(d, 'Hello', 'Hi').presentation);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(currentPresentationRevision(outcome.history)).toBe(1);
  });

  it('守卫提交里改写抛错 ⇒ mutation_failed，历史原样返回', () => {
    const history = createPresentationHistory(twoSlideDeck());
    const outcome = commitPresentationEditGuarded(history, 0, 'boom', () => {
      throw new Error('炸了');
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.reason).toBe('mutation_failed');
    expect(outcome.history).toBe(history);
  });
});

// ---------------------------------------------------------------------------
// 4. 复制粘贴（跨页 / 页内；优先级与 id 重号必须可判）
// ---------------------------------------------------------------------------

describe('PPT-14：复制粘贴', () => {
  it('复制按源页 z 序排序，并给出可判的优先级下标', () => {
    const deck = twoSlideDeck();
    const slideId = at(deck.slides, 0).slide_id;
    const clipboard = copyShapes(deck, slideId, [3, 2]); // 乱序传入
    expect([...clipboard.source_shape_ids]).toEqual([2, 3]); // 按 z 序
    expect([...clipboard.source_indexes]).toEqual([0, 1]);
    expect(clipboard.source_slide_id).toBe(slideId);
  });

  it('跨页粘贴：id 全新、相对优先级保持、无重号，且源页引用不变', () => {
    const deck = twoSlideDeck();
    const sourceSlide = at(deck.slides, 0);
    const targetSlide = at(deck.slides, 1);
    const clipboard = copyShapes(deck, sourceSlide.slide_id, [2, 3]);

    const pasted = pasteShapes(deck, clipboard, { slide_id: targetSlide.slide_id });

    // 目标页原有 id=2 ⇒ 新 id 从 3 起；相对优先级 [2,3] → [3,4]
    expect([...pasted.pasted_shape_ids]).toEqual([3, 4]);
    expect(at(pasted.presentation.slides, 1).shapes.map((shape) => shape.shape_id)).toEqual([2, 3, 4]);
    expect([...pasted.id_map]).toEqual([
      { from: 2, to: 3 },
      { from: 3, to: 4 },
    ]);
    // 无重号 = 可判
    expect([...findDuplicateShapeIds(pasted.presentation)]).toEqual([]);
    // 源页对象引用不变（粘贴只动目标页）
    expect(at(pasted.presentation.slides, 0)).toBe(sourceSlide);
  });

  it('页内粘贴：新 id 与原件不重号，插入位置即优先级', () => {
    const deck = twoSlideDeck();
    const slideId = at(deck.slides, 0).slide_id;
    const clipboard = copyShapes(deck, slideId, [2, 3]);
    const pasted = pasteShapes(deck, clipboard, { slide_id: slideId, index: 0 });

    expect([...pasted.pasted_shape_ids]).toEqual([4, 5]);
    expect(at(pasted.presentation.slides, 0).shapes.map((shape) => shape.shape_id)).toEqual([4, 5, 2, 3]);
    expect([...findDuplicateShapeIds(pasted.presentation)]).toEqual([]);
  });

  it('重号可判：findDuplicateShapeIds 报告；复制与粘贴在带重号的页上都具名拒绝', () => {
    const corrupted = (() => {
      const deck = twoSlideDeck();
      const slide = at(deck.slides, 0);
      const duplicate = textBox(2, 'Duplicate', [para([literal('dup')])]); // 与 Title 同 id
      const slides = deck.slides.map((current) =>
        current.slide_id === slide.slide_id ? { ...current, shapes: [...current.shapes, duplicate] } : current,
      );
      return { ...deck, slides } as Presentation;
    })();

    expect([...findDuplicateShapeIds(corrupted)]).toEqual([{ slide_id: 1, shape_id: 2, count: 2 }]);
    expectReason(() => copyShapes(corrupted, 1, [2]), 'duplicate_shape_id');

    const healthyClipboard = copyShapes(twoSlideDeck(), 2, [2]);
    expectReason(() => pasteShapes(corrupted, healthyClipboard, { slide_id: 1 }), 'duplicate_shape_id');
  });

  it('复制空选择 / 不存在对象 / 越界粘贴位置都具名报错', () => {
    const deck = twoSlideDeck();
    expectReason(() => copyShapes(deck, 1, []), 'empty_selection');
    expectReason(() => copyShapes(deck, 1, [42]), 'unknown_shape');
    const clipboard = copyShapes(deck, 1, [2]);
    expectReason(() => pasteShapes(deck, clipboard, { slide_id: 1, index: 99 }), 'invalid_index');
    expectReason(() => pasteShapes(deck, clipboard, { slide_id: 99 }), 'unknown_slide');
  });
});

// ---------------------------------------------------------------------------
// 5. 查找替换（按文本 / 按占位符；精确选区保留未选内容）
// ---------------------------------------------------------------------------

describe('PPT-14：查找替换', () => {
  it('findText：跨页 run 内命中、非重叠、大小写可选', () => {
    const deck = twoSlideDeck();
    const matches = findText(deck, 'Hello');
    expect(matches.length).toBe(2);
    expect(matches.map((match) => match.slide_id)).toEqual([1, 1]);
    expect(matches.map((match) => match.shape_id)).toEqual([2, 3]);

    // 非重叠：'abc-abc' 里 'abc' 命中 2 次
    const abc = findText(deck, 'abc');
    expect(abc.length).toBe(2);
    expect(abc.map((match) => match.start)).toEqual([0, 4]);
    expect(abc.map((match) => match.text)).toEqual(['abc', 'abc']);

    expect(findText(deck, 'hello').length).toBe(0);
    expect(findText(deck, 'hello', { match_case: false }).length).toBe(2);
    expectReason(() => findText(deck, ''), 'invalid_query');
  });

  it('反向对照：精确选区保留未选内容（前缀/后缀字符与样式对象、其余 run 引用都原样）', () => {
    const style: RunStyle = { size_pt: 18, bold: true };
    const otherStyle: RunStyle = { italic: true };
    let deck = emptyPresentation('p', 'x');
    const slide = addSlide(deck);
    deck = slide.presentation;
    deck = addShape(
      deck,
      slide.slide_id,
      textBox(2, 'T', [para([literal('ABCDEF', style), literal('XYZ', otherStyle)]), para([literal('尾段落')])]),
    );
    const originalOtherRun = at(at(shapeText(deck, 0, 0).paragraphs, 0).runs, 1);
    const originalSecondParagraph = at(shapeText(deck, 0, 0).paragraphs, 1);

    const result = replaceAllText(deck, 'CD', '!!');
    expect(result.replaced).toBe(1);

    const runs = at(shapeText(result.presentation, 0, 0).paragraphs, 0).runs;
    expect(runs.map((run) => (run.source.kind === 'literal' ? run.source.text : ''))).toEqual(['AB', '!!', 'EF', 'XYZ']);
    // 未选中的前缀 / 后缀样式对象引用不变
    expect(at(runs, 0).style).toBe(style);
    expect(at(runs, 2).style).toBe(style);
    // 选中段的样式继承原 run（换文本不换样式）
    expect(at(runs, 1).style).toBe(style);
    // 同段其余 run 引用相等
    expect(at(runs, 3)).toBe(originalOtherRun);
    // 其余段落、其余页引用相等
    expect(at(shapeText(result.presentation, 0, 0).paragraphs, 1)).toBe(originalSecondParagraph);
    expect(at(result.presentation.slides, 0)).not.toBe(at(deck.slides, 0)); // 被改的页是新对象
  });

  it('反向对照：替换后再查同一个词 ⇒ 已无命中', () => {
    const deck = twoSlideDeck();
    const result = replaceAllText(deck, 'Hello', 'Hi');
    expect(result.replaced).toBe(2);
    expect(findText(result.presentation, 'Hello').length).toBe(0);
    expect(findText(result.presentation, 'Hi').length).toBe(2);
  });

  it('同一 run 内多处命中都被替换（abc-abc → X-X）', () => {
    const deck = twoSlideDeck();
    const result = replaceAllText(deck, 'abc', 'X');
    expect(result.replaced).toBe(2);
    expect(paragraphText(result.presentation, 0, 1, 1)).toBe('X-X');
    expect(findText(result.presentation, 'abc').length).toBe(0);
  });

  it('其余页 / 未命中对象引用相等（只动被改的那一页）', () => {
    const deck = twoSlideDeck();
    const secondSlide = at(deck.slides, 1);
    const result = replaceAllText(deck, 'Hello', 'Hi');
    expect(at(result.presentation.slides, 1)).toBe(secondSlide);
  });

  it('按占位符：findPlaceholders 列出 fact run，replacePlaceholder 只改命中的引用', () => {
    const factRun: TextRun = { source: { kind: 'fact', fact_key: 'revenue' } };
    const keepRun: TextRun = { source: { kind: 'literal', text: '总计' } };
    let deck = emptyPresentation('p', 'x');
    const slide = addSlide(deck);
    deck = slide.presentation;
    deck = addShape(deck, slide.slide_id, textBox(2, 'T', [para([keepRun, factRun])]));

    const refs = findPlaceholders(deck);
    expect(refs.length).toBe(1);
    expect(at(refs, 0).fact_key).toBe('revenue');
    expect(findPlaceholders(deck, 'missing').length).toBe(0);

    const result = replacePlaceholder(deck, 'revenue', 'profit');
    expect(result.replaced).toBe(1);
    const runs = at(shapeText(result.presentation, 0, 0).paragraphs, 0).runs;
    expect(at(runs, 0)).toBe(keepRun); // 字面量 run 引用相等
    expect(at(runs, 1).source).toEqual({ kind: 'fact', fact_key: 'profit' });

    // 未命中 ⇒ 不改任何东西
    const noop = replacePlaceholder(deck, 'nope', 'x');
    expect(noop.replaced).toBe(0);
    expect(at(noop.presentation.slides, 0)).toBe(at(deck.slides, 0));
  });
});

// ---------------------------------------------------------------------------
// 6. 版本比较（复用 comparePresentationFiles）
// ---------------------------------------------------------------------------

describe('PPT-14：版本比较（按部件字节）', () => {
  it('相同字节 ⇒ identical，added/removed/changed 皆空', () => {
    const bytes = renderPresentation(twoSlideDeck()).bytes;
    const diff = comparePresentationBytes(bytes, bytes);
    expect(diff.identical).toBe(true);
    expect([...diff.added]).toEqual([]);
    expect([...diff.removed]).toEqual([]);
    expect([...diff.changed]).toEqual([]);
    expect(diff.unchanged).toBeGreaterThan(0);
    expect(diff.before_digest).toBe(diff.after_digest);
  });

  it('改一页 ⇒ 只有那一页部件变，unchanged 计数如实', () => {
    const deck = twoSlideDeck();
    const before = renderPresentation(deck).bytes;
    const edited = replaceAllText(deck, 'Hello', 'Hi').presentation;
    const after = renderPresentation(edited).bytes;

    const diff = comparePresentationBytes(before, after);
    expect(diff.identical).toBe(false);
    expect([...diff.added]).toEqual([]);
    expect([...diff.removed]).toEqual([]);
    expect([...diff.changed]).toEqual(['ppt/slides/slide1.xml']);
    expect(diff.unchanged).toBeGreaterThan(0);
    expect(diff.before_slide_count).toBe(2);
    expect(diff.after_slide_count).toBe(2);
    expect(diff.before_digest).not.toBe(diff.after_digest);
  });

  it('快照版本比较：提交后能定位到哪一页变了', () => {
    const history = createPresentationHistory(twoSlideDeck());
    const outcome = commitPresentationEdit(history, 'e', (d) => replaceAllText(d, 'Hello', 'Hi').presentation);
    if (!outcome.ok) throw new Error('夹具错误：提交易失败');
    const diff = comparePresentationSnapshots(history.present, outcome.snapshot);
    expect([...diff.changed]).toEqual(['ppt/slides/slide1.xml']);
  });
});

// ---------------------------------------------------------------------------
// 7. 端到端：导入既有文件后仍能改指定对象
// ---------------------------------------------------------------------------

describe('PPT-14：导入既有文件后仍能改指定对象', () => {
  it('导入 → 改第 2 页指定对象 → 导出：只有第 2 页部件换字节，其余逐字节保留', () => {
    const source = renderPresentation(twoSlideDeck()).bytes;
    const imported = importPresentation(source);

    const edited = replaceAllText(imported.presentation, 'Second', 'Edited').presentation;
    const exported = exportImportedPresentation(imported, edited);
    expect([...exported.changed_part_paths]).toEqual(['ppt/slides/slide2.xml']);

    const diff = comparePresentationBytes(source, exported.bytes);
    expect(diff.identical).toBe(false);
    expect([...diff.added]).toEqual([]);
    expect([...diff.removed]).toEqual([]);
    expect([...diff.changed]).toEqual(['ppt/slides/slide2.xml']);

    // 读回确认：第 2 页改到了，第 1 页一个字没动
    const reopened = importPresentation(exported.bytes);
    expect(paragraphText(reopened.presentation, 1, 0, 0)).toBe('Edited page');
    expect(paragraphText(reopened.presentation, 0, 0, 0)).toBe('Hello World');
  });

  it('导入件上的编辑历史可撤销回导入时原态', () => {
    const imported = importPresentation(renderPresentation(twoSlideDeck()).bytes);
    const history = createPresentationHistory(imported.presentation);
    const originalDigest = presentationDigest(currentPresentation(history));

    const outcome = commitPresentationEdit(history, 'edit', (d) => replaceAllText(d, 'Hello', 'Hi').presentation);
    if (!outcome.ok) throw new Error('夹具错误：提交易失败');
    expect(presentationDigest(currentPresentation(outcome.history))).not.toBe(originalDigest);

    const undone = undoPresentationHistory(outcome.history);
    expect(presentationDigest(currentPresentation(undone))).toBe(originalDigest);
  });

  it('撤销后的导入件可再次导出为原字节（未改动 ⇒ 逐字节不变）', () => {
    const source = renderPresentation(twoSlideDeck()).bytes;
    const imported = importPresentation(source);
    const history = createPresentationHistory(imported.presentation);

    const outcome = commitPresentationEdit(history, 'edit', (d) => replaceAllText(d, 'Hello', 'Hi').presentation);
    if (!outcome.ok) throw new Error('夹具错误：提交易失败');
    const undone = undoPresentationHistory(outcome.history);

    const exported = exportImportedPresentation(imported, currentPresentation(undone));
    expect([...exported.changed_part_paths]).toEqual([]);
    expect(comparePresentationBytes(source, exported.bytes).identical).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 事实坐标（dc1-*）随快照存档：undo / redo 逐字还原
// ---------------------------------------------------------------------------

describe('PPT-14：历史快照携带事实指纹 dc1-*，撤销 / 重做逐字还原', () => {
  const DC1_A = 'dc1-00000001';
  const DC1_B = 'dc1-00000002';

  it('初始坐标 + 提交带回新坐标 + 撤销回旧坐标 + 重做回新坐标', () => {
    const history = createPresentationHistory(twoSlideDeck(), 'init', DC1_A);
    expect(currentPresentationDataVersion(history)).toBe(DC1_A);

    const outcome = commitPresentationEdit(
      history,
      'set_fact_value',
      (d) => replaceAllText(d, 'Hello', 'Hello2').presentation,
      { data_version: DC1_B },
    );
    if (!outcome.ok) throw new Error('夹具错误：提交易失败');
    expect(currentPresentationDataVersion(outcome.history)).toBe(DC1_B);

    const undone = undoPresentationHistory(outcome.history);
    expect(currentPresentationDataVersion(undone)).toBe(DC1_A);
    // 摘要也随快照还原：撤销后摘要中的坐标 = 初始坐标。
    expect(presentationHistorySummary(undone).data_version).toBe(DC1_A);

    const redone = redoPresentationHistory(undone);
    expect(currentPresentationDataVersion(redone)).toBe(DC1_B);
  });

  it('不传坐标 = 未接入事实，读到 null；带守卫提交同样转发坐标', () => {
    const bare = createPresentationHistory(twoSlideDeck());
    expect(currentPresentationDataVersion(bare)).toBeNull();
    expect(presentationHistorySummary(bare).data_version).toBeNull();

    const guarded = commitPresentationEditGuarded(
      bare,
      0,
      'set_fact_value',
      (d) => replaceAllText(d, 'Hello', 'Hi').presentation,
      { data_version: DC1_A },
    );
    expect(guarded.ok).toBe(true);
    if (!guarded.ok) return;
    expect(currentPresentationDataVersion(guarded.history)).toBe(DC1_A);
  });

  it('失败保旧：改写抛错时坐标一字不动（历史引用相等）', () => {
    const history = createPresentationHistory(twoSlideDeck(), 'init', DC1_A);
    const failed = commitPresentationEdit(history, 'boom', () => {
      throw new Error('改写失败');
    }, { data_version: DC1_B });

    expect(failed.ok).toBe(false);
    expect(failed.history).toBe(history);
    expect(currentPresentationDataVersion(failed.history)).toBe(DC1_A);
  });

  it('撤销 / 重做同步数后坐标回到同一枚（正反对照）', () => {
    let state = createPresentationHistory(twoSlideDeck(), 'init', DC1_A);
    const first = commitPresentationEdit(state, 'a', (d) => replaceAllText(d, 'Hello', 'A').presentation, { data_version: DC1_B });
    if (!first.ok) throw new Error('夹具错误');
    const second = commitPresentationEdit(first.history, 'b', (d) => replaceAllText(d, 'A', 'B').presentation, { data_version: DC1_A });
    if (!second.ok) throw new Error('夹具错误');
    state = second.history;

    const back = undoPresentationSteps(state, 2);
    expect(currentPresentationDataVersion(back)).toBe(DC1_A);
    const forward = redoPresentationSteps(back, 2);
    expect(currentPresentationDataVersion(forward)).toBe(DC1_A);
    expect(presentationHistorySummary(forward)).toEqual(presentationHistorySummary(state));
  });
});

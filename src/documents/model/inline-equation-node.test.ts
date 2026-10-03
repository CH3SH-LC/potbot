/**
 * 行内公式节点（design-05-P9 的未通子项）——**模型 / 选区 / 校验 / 码位**四条判据。
 *
 * | 判据（用户口径） | 本节用例 |
 * |---|---|
 * | 含公式的段落，按码位**选中**公式所在位置 ⇒ 命中公式 | ②③ |
 * | 公式的**码位长度 = 1**（不是 0，也不是公式源码长度） | ①②④ |
 * | 公式**不可编辑**（光标不落在它内部） | ②③ |
 * | `InlineNode` 真的多了一个 `equation` 分支 | ⑤ |
 * | `model/types.ts` 的**既有字段一字未改** | ⑥（字段名清单对照） |
 *
 * 本文件**新增**，不修改任何既有测试断言。
 * 相关（且互不重复）：`equations/inline-selection.test.ts`（投影契约本身）、
 * `docx/inline-equation-export.test.ts`（文件层端到端）、
 * `docx/section-extras-export.test.ts`（P4 的分页符/自定义栏宽，基线已有）。
 */

import { describe, expect, it } from 'vitest';

import { fraction, mathRun, superscript } from '../equations/build.js';
import type { EquationContent } from '../equations/types.js';
import { splitParagraph, inlineCodePointLength, paragraphCodePointLength } from '../operations/paragraph/breaks.js';
import { createDocumentModel } from './document.js';
import { bodyPath, equationNode, inlineKindOf, materializeBlockNode } from './nodes.js';
import { createNodeIdAllocator, withSegment } from './ids.js';
import { paragraphPlainText } from './text.js';
import {
  TOGGLE_UNSPECIFIED,
  type BreakNode,
  type DrawingNode,
  type EquationNode,
  type FieldNode,
  type InlineNode,
  type ParagraphNode,
  type RunNode,
  type SourceKind,
} from './types.js';
import { validateDocument } from './validation.js';
import { buildInlineTextMap, splitInlinesAtRange } from '../selection/inline-map.js';

const EDITABLE: EquationContent = {
  kind: 'editable',
  equation: fraction(mathRun('1'), mathRun('2')),
};
const EDITABLE_SIMPLE: EquationContent = { kind: 'editable', equation: superscript(mathRun('x'), mathRun('2')) };
const PRESERVED: EquationContent = {
  kind: 'preserved',
  reason: '矩阵未建模（本批无 OMML→结构树解析器）',
  omml: '<m:oMath><m:m/></m:oMath>',
};

/** 一个成品的行内公式节点（不经过工厂，直接按 `EquationNode` 形状构造）。 */
function equationInline(id: string, content: EquationContent, equationId = `eq-${id}`): EquationNode {
  return { kind: 'equation', id, source: 'imported', opaque: [], equation_id: equationId, content };
}

function runInline(id: string, text: string): RunNode {
  return {
    kind: 'run',
    id,
    source: 'imported',
    opaque: [],
    text,
    properties: {
      bold: TOGGLE_UNSPECIFIED,
      italic: TOGGLE_UNSPECIFIED,
      underline: { state: 'unspecified' },
      strike: TOGGLE_UNSPECIFIED,
      doubleStrike: TOGGLE_UNSPECIFIED,
      vertAlign: { state: 'unspecified' },
      fonts: { state: 'unspecified' },
      size: { state: 'unspecified' },
      scale: { state: 'unspecified' },
      position: { state: 'unspecified' },
      color: { state: 'unspecified' },
      highlight: { state: 'unspecified' },
      shading: { state: 'unspecified' },
      spacing: { state: 'unspecified' },
      caps: TOGGLE_UNSPECIFIED,
      smallCaps: TOGGLE_UNSPECIFIED,
    },
  };
}

/**
 * 一段：`ab` + 公式 + `cd`。
 *
 * 选区偏移空间（`buildInlineTextMap`）：`ab` = [0,2)、公式 = [2,3)、`cd` = [3,5)。
 */
function sampleParagraph(): ParagraphNode {
  return {
    kind: 'paragraph',
    id: 'p1',
    source: 'imported',
    opaque: [],
    properties: {
      alignment: { state: 'unspecified' },
      lineSpacing: { state: 'unspecified' },
      spacingBefore: { state: 'unspecified' },
      spacingAfter: { state: 'unspecified' },
      indent: {
        left: { state: 'unspecified' },
        right: { state: 'unspecified' },
        firstLine: { state: 'unspecified' },
        hanging: { state: 'unspecified' },
      },
      tabStops: { state: 'unspecified' },
      pageBreakBefore: TOGGLE_UNSPECIFIED,
      keepNext: TOGGLE_UNSPECIFIED,
      keepLines: TOGGLE_UNSPECIFIED,
      widowControl: TOGGLE_UNSPECIFIED,
      borders: { state: 'unspecified' },
      shading: { state: 'unspecified' },
      outlineLevel: { state: 'unspecified' },
    },
    inlines: [runInline('r1', 'ab'), equationInline('q1', EDITABLE), runInline('r3', 'cd')],
    style_ref: null,
    numbering: null,
  };
}

// ---------------------------------------------------------------------------
// ① 码位长度 = 1（两个"码位长度"口径都必须如此）
// ---------------------------------------------------------------------------

describe('① 公式在偏移空间里占 1 个码位', () => {
  it('`inlineCodePointLength` / `paragraphCodePointLength` 都把公式算成 1（**不是 0**）', () => {
    const equation = equationInline('q1', EDITABLE);
    expect(inlineCodePointLength(equation)).toBe(1);

    const para = sampleParagraph();
    // `ab`(2) + 公式(1) + `cd`(2) = 5。若公式被算成 0，这里会是 4——那正是登记的最危险静默项 S1。
    expect(paragraphCodePointLength(para)).toBe(5);
  });

  it('码位长度与**公式源码长度无关**（分式 1/2 与单字符公式都是 1）', () => {
    expect(inlineCodePointLength(equationInline('q1', EDITABLE))).toBe(1);
    expect(inlineCodePointLength(equationInline('q2', EDITABLE_SIMPLE))).toBe(1);
    expect(inlineCodePointLength(equationInline('q3', PRESERVED))).toBe(1);
  });

  it('对拍：`paragraphCodePointLength` 与选区偏移空间 `buildInlineTextMap().total` 一致（含公式段落）', () => {
    const para = sampleParagraph();
    expect(paragraphCodePointLength(para)).toBe(buildInlineTextMap(para.inlines).total);
  });
});

// ---------------------------------------------------------------------------
// ② 可选中：偏移区间精确命中公式，且不可编辑
// ---------------------------------------------------------------------------

describe('② 按码位选中 ⇒ 命中公式（且不可编辑）', () => {
  it('`buildInlineTextMap` 给出 kind/区间/可编辑性', () => {
    const para = sampleParagraph();
    const map = buildInlineTextMap(para.inlines);

    expect(map.segments.map((segment) => segment.kind)).toEqual(['run', 'equation', 'run']);
    expect(map.segments[1]).toEqual({
      inlineIndex: 1,
      kind: 'equation',
      start: 2,
      end: 3,
      editable: false,
    });
    // 文本投影是一个对象替换字符（U+FFFC），与 `model/text.ts` 同源。
    expect(map.text).toBe('ab￼cd');
    expect(map.total).toBe(5);
    expect(paragraphPlainText(para)).toBe('ab￼cd');
  });

  it('选区 [2,3) **完整**覆盖公式 ⇒ `containedNonEditable`（"选中这个公式"的语义）', () => {
    const para = sampleParagraph();
    const split = splitInlinesAtRange(para.inlines, 2, 3);
    expect(split.ok).toBe(true);
    if (!split.ok) throw new Error(split.message);

    expect(split.value.containedNonEditable).toBe(true);
    expect(split.value.selected).toHaveLength(1);
    expect(split.value.selected[0]?.kind).toBe('equation');
    // 三段拼回去**逐字等于**原文（切分不改字，R147/R151）。
    expect(split.value.before.map((node) => (node.kind === 'run' ? node.text : '')).join('')).toBe('ab');
    expect(split.value.after.map((node) => (node.kind === 'run' ? node.text : '')).join('')).toBe('cd');
  });

  it('1 码位宽 ⇒ "把公式切一半"在整数偏移下**不可能发生**', () => {
    const para = sampleParagraph();
    // 结束在公式左边 / 起始在公式右边：都不把公式纳入被选。
    const left = splitInlinesAtRange(para.inlines, 0, 2);
    const right = splitInlinesAtRange(para.inlines, 3, 5);
    expect(left.ok && left.value.containedNonEditable).toBe(false);
    expect(right.ok && right.value.containedNonEditable).toBe(false);
    // 而"边界落在公式内部"根本构造不出来：整数区间只有 [2,3) 这一种覆盖它的方式。
    expect(left.ok && left.value.selected.some((node) => node.kind === 'equation')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ③ 拆段偏移与选区空间一致（S1 的判别性对照）
// ---------------------------------------------------------------------------

describe('③ 拆段：公式算 1 码位时切点与选区一致（S1 反向对照）', () => {
  it('在偏移 3 拆开 ⇒ 前半段 `ab`+公式，后半段 `cd`', () => {
    const para = sampleParagraph();
    let counter = 0;
    const [head, tail] = splitParagraph(para, 3, () => `new-${String((counter += 1))}`);

    expect(head.inlines.map((node) => node.kind)).toEqual(['run', 'equation']);
    expect(tail.inlines.map((node) => node.kind)).toEqual(['run']);
    expect(tail.inlines[0]?.kind === 'run' ? tail.inlines[0].text : null).toBe('cd');
  });

  it('反向对照：把公式按 0 码位算（旧算法）会与选区偏移空间**相差一位**', () => {
    const para = sampleParagraph();
    // 旧算法（本件修改前）：只把 run 计入长度，公式宽 0。
    const legacyWidths = para.inlines.map((node) =>
      node.kind === 'run' ? Array.from(node.text).length : 0,
    );
    expect(legacyWidths).toEqual([2, 0, 2]);
    const legacyTotal = legacyWidths.reduce((total, width) => total + width, 0);
    expect(legacyTotal).toBe(4);

    // 新口径（公式 = 1）与**选区偏移空间**一致；旧口径相差恰好一位。
    const selectionTotal = buildInlineTextMap(para.inlines).total;
    expect(selectionTotal).toBe(5);
    expect(paragraphCodePointLength(para)).toBe(selectionTotal);
    expect(legacyTotal).not.toBe(selectionTotal);
  });
});

// ---------------------------------------------------------------------------
// ④ 工厂与物化
// ---------------------------------------------------------------------------

describe('④ 工厂与物化：稳定 id、equation_id 非空、路径段可用', () => {
  it('`equationNode` 产出草稿；物化后拿到确定性 id 与 kind', () => {
    const draft = equationNode({ equation_id: 'eq-1', content: EDITABLE, source: 'model_generated' });
    expect(draft.kind).toBe('equation');

    const allocator = createNodeIdAllocator();
    const materialized = materializeBlockNode(
      {
        kind: 'paragraph',
        source: 'model_generated',
        properties: sampleParagraph().properties,
        inlines: [draft],
        style_ref: null,
        numbering: null,
      },
      withSegment(bodyPath(), 'paragraph', 0),
      allocator,
    );
    expect(materialized.kind).toBe('paragraph');
    if (materialized.kind !== 'paragraph') throw new Error('应当是段落');
    const inline = materialized.inlines[0];
    expect(inline?.kind).toBe('equation');
    if (inline?.kind !== 'equation') throw new Error('应当是公式');
    expect(inline.equation_id).toBe('eq-1');
    expect(typeof inline.id).toBe('string');
    expect(inline.id.length).toBeGreaterThan(0);
  });

  it('空 `equation_id` 被工厂拒绝（无法被稳定定位）', () => {
    expect(() => equationNode({ equation_id: '', content: EDITABLE, source: 'imported' })).toThrow();
  });

  it('`inlineKindOf` 放行 `equation`，其它未知 kind 仍抛', () => {
    expect(inlineKindOf(equationInline('q1', EDITABLE))).toBe('equation');
    expect(() => inlineKindOf({ kind: 'nope', id: 'x', source: 'imported', opaque: [] } as unknown as InlineNode)).toThrow();
  });

  it('`createDocumentModel` 能吃掉含公式的草稿（校验不误判合法公式）', () => {
    const model = createDocumentModel({
      document_id: 'eq-doc',
      blocks: [
        {
          kind: 'paragraph',
          source: 'model_generated',
          properties: sampleParagraph().properties,
          inlines: [equationNode({ equation_id: 'eq-1', content: EDITABLE, source: 'model_generated' })],
          style_ref: null,
          numbering: null,
        },
      ],
    });
    expect(model.blocks[0]?.kind).toBe('paragraph');
  });
});

// ---------------------------------------------------------------------------
// ⑤ 校验：三处"静默出错"里的 validation 一处
// ---------------------------------------------------------------------------

describe('⑤ 校验：合法公式通过；畸形公式被显式报错（不是被 default 当未知种类）', () => {
  function validateOne(inline: unknown): ReturnType<typeof validateDocument> {
    const model = createDocumentModel({ document_id: 'eq-doc', blocks: [] });
    return validateDocument({
      ...model,
      blocks: [{ ...sampleParagraph(), inlines: [inline as InlineNode] }],
    });
  }

  it('合法公式：0 error', () => {
    const report = validateOne(equationInline('q1', EDITABLE));
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('空 `equation_id` ⇒ 明确 error（不是被当成未知种类）', () => {
    const report = validateOne(equationInline('q1', EDITABLE, ''));
    expect(report.ok).toBe(false);
    expect(report.errors.some((problem) => problem.detail.includes('equation_id'))).toBe(true);
  });

  it('`content.kind` 非法 ⇒ 明确 error', () => {
    const bad = { ...equationInline('q1', EDITABLE), content: { kind: 'nonsense' } };
    const report = validateOne(bad);
    expect(report.ok).toBe(false);
    expect(report.errors.some((problem) => problem.detail.includes('content.kind'))).toBe(true);
  });

  it('preserved 缺 `reason` ⇒ error（未解析不得冒充已解析，R155）', () => {
    const bad = { ...equationInline('q1', PRESERVED), content: { kind: 'preserved', omml: '<m:oMath/>' } };
    const report = validateOne(bad);
    expect(report.ok).toBe(false);
    expect(report.errors.some((problem) => problem.detail.includes('reason'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ⑥ R151 红线：`model/types.ts` 的既有字段**一字未改**
// ---------------------------------------------------------------------------

describe('⑥ 冻结骨架：既有字段名清单不变，且 `InlineNode` 恰好多出 `equation`', () => {
  it('run / break / field / drawing 的字段名与冻结时逐字相同', () => {
    const run: RunNode = runInline('r', 'x');
    const brk: BreakNode = { kind: 'break', id: 'b', source: 'imported', opaque: [], breakType: 'line' };
    const field: FieldNode = {
      kind: 'field',
      id: 'f',
      source: 'imported',
      opaque: [],
      instruction: 'PAGE',
      cached_result: null,
      refresh_state: 'unknown',
    };
    const drawing: DrawingNode = {
      kind: 'drawing',
      id: 'd',
      source: 'imported',
      opaque: [],
      drawing_type: 'shape',
      relationship_id: null,
      extent: null,
      rotation_deg: 0,
      wrap: null,
      alt_text: null,
    };

    expect(Object.keys(run).sort()).toEqual(
      ['id', 'kind', 'opaque', 'properties', 'source', 'text'].sort(),
    );
    expect(Object.keys(brk).sort()).toEqual(['breakType', 'id', 'kind', 'opaque', 'source'].sort());
    expect(Object.keys(field).sort()).toEqual(
      ['cached_result', 'id', 'instruction', 'kind', 'opaque', 'refresh_state', 'source'].sort(),
    );
    expect(Object.keys(drawing).sort()).toEqual(
      [
        'alt_text', 'drawing_type', 'extent', 'id', 'kind', 'opaque',
        'relationship_id', 'rotation_deg', 'source', 'wrap',
      ].sort(),
    );
  });

  it('`NodeBase` 的三个公共字段仍在（id / source / opaque）', () => {
    const equation = equationInline('q1', EDITABLE);
    expect(Object.keys(equation).sort()).toEqual(
      ['content', 'equation_id', 'id', 'kind', 'opaque', 'source'].sort(),
    );
  });

  it('公式节点是**纯追加**：既有四种行内节点的判别式仍各有其分支', () => {
    const kindsOfInline = ['run', 'break', 'field', 'drawing', 'equation'] as const satisfies readonly InlineNode['kind'][];
    expect(kindsOfInline).toEqual(['run', 'break', 'field', 'drawing', 'equation']);
    // 反例守卫：新分支的存在**不**改变旧分支的判别式字符串。
    expect(kindsOfInline.slice(0, 4)).toEqual(['run', 'break', 'field', 'drawing']);
  });

  /** 编译期断言（`satisfies` 已覆盖）：`equation` 确实进了联合。 */
  it('`EquationNode` 可赋给 `InlineNode`（类型级证据）', () => {
    const inline: InlineNode = equationInline('q1', EDITABLE);
    expect(inline.kind).toBe('equation');
    const source: SourceKind = inline.source;
    expect(source).toBe('imported');
  });
});

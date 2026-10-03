/**
 * **公式作为行内可选节点**的投影契约（design-05-P9 的缺口；合同 R102/R104/R105/R140）。
 *
 * ## 缺口的准确形状（**不越权、如实声明**）
 *
 * 冻结骨架（`model/types.ts`，主协调者独占）里 `InlineNode` 只有四个分支：
 * `run` / `break` / `field` / `drawing`——**没有公式**。后果不是"公式导出不了"
 * （D70 的 OMML 导出已能写 `m:oMath`），而是**公式不能被"选中"**：
 * 选区（R102）建立在"段落的码位偏移空间"上，而这个空间由 `inlines` 拼出
 * （`selection/inline-map.ts`）。公式不是 `inlines` 的一员，就落不进任何偏移区间，
 * 于是"选中这个公式并删除/复制/换格式"这类操作在模型层**无址可寻**。
 *
 * 补上它需要**扩展冻结骨架**——本包（`equations/**`）**不**改 `model/types.ts`，
 * 只把"扩展之后必须成立的语义"**先写成可执行的契约**（本文件），把风险前移到纯函数与测试里。
 * 精确的改动清单见 `.task-manifest/outputs/FA-D/inline-equation-plan.md`。
 *
 * ## 契约只有一条，但它决定了全部行为
 *
 * **一个公式在段落偏移空间里占且仅占一个码位**（U+FFFC，对象替换字符）。
 *
 * 为什么不是 0 位：占 0 位会让"在公式后面插入文字"的偏移与用户看到的对不上——
 * 光标在公式右边却在文本坐标里落在公式左边的字上。
 *
 * 为什么不是按公式内部结构展开成多个码位：那等于把公式"降级成文本"（design-05 §3.9 明确禁止），
 * 而且会让"范围边界落在公式内部"变成一条**无法回答**的问题——公式内部的位置不是一个
 * 可以插光标的地方，切一半会毁掉 `m:f` / `m:rad` 的结构。
 *
 * 1 码位 + **不可编辑** 的组合，正好复现 `DrawingNode`（内联图形）与"无缓存域"在
 * `inline-map.ts` 里的既有语义：整体可被选区**完整**覆盖（`containedNonEditable`），
 * 而任何"部分覆盖"在整数偏移下**不可能发生**，因此天然满足"边界不得落在不可切分节点内部"。
 *
 * ## 本文件**不**做什么
 *
 * - **不**产出 DOCX 字节（`docx/**`）；
 * - **不**解析 OMML（`parse.ts` / `preserve.ts`）；
 * - ~~**不**改冻结骨架，**不**加入 `InlineNode` 联合~~ —— **2026-10-03 更新（FA-W）**：
 *   主协调者已授权落地，`InlineNode` 现在**确有** `EquationNode` 分支
 *   （`model/types.ts`，纯加法），`selection/inline-map.ts` 的 `SegmentKind` 也加上了
 *   `'equation'`。上文的缺口描述按**落地前**状态阅读；投影契约本身（恒 1 码位、不可编辑、
 *   U+FFFC 同源）**未改**，正是落地时被接上的那一条。真实 `EquationNode` 走
 *   `buildInlineTextMap` 的用例见 `model/inline-equation-node.test.ts`②。
 */

import type { NodeId, ParagraphNode } from '../model/types.js';
import { buildInlineTextMap } from '../selection/inline-map.js';
import type { DocumentRange } from '../selection/types.js';
import type { EquationContent } from './types.js';

/**
 * 公式在段落文本里的占位符——对象替换字符（U+FFFC）。
 *
 * 与 `model/text.ts` 的 `inlinePlainText`、`selection/inline-map.ts` 的 `segmentText`
 * 对 `drawing` / 无缓存 `field` 的处理**逐字相同**：三方必须同源，否则
 * "文本投影"与"偏移空间"会算出两个不同的段落长度（那条 bug 极难查）。
 */
export const EQUATION_PLACEHOLDER = '￼';

/** 公式在偏移空间里占的码位数。**恒为 1**（契约，不是可配置项）。 */
export const EQUATION_INLINE_LENGTH = 1;

/**
 * 公式段落在 `InlineSegment.kind` / `SegmentKind` 里应取的判别式值。
 *
 * 扩展落地时 `selection/inline-map.ts` 的 `SegmentKind` 联合要加上它，
 * `segmentText` 要加一条 `case 'equation': return EQUATION_PLACEHOLDER;`。
 */
export const EQUATION_SEGMENT_KIND = 'equation';

/**
 * 公式的**文本投影**：恒为一个 U+FFFC，与 `EquationContent` 的哪个分支无关。
 *
 * 可编辑与保留（`preserved`）**宽度相同**——它们占的"位置"是同一件事，
 * 区别在"能不能被改写"，不在"占几个字"。把两者投影成不同宽度会让同一份文档
 * 在"公式被降级为保留"前后**段落长度发生变化**，所有既有偏移当场失效。
 */
export function equationTextProjection(content: EquationContent): string {
  void content;
  return EQUATION_PLACEHOLDER;
}

/** 公式是否可被编辑（`editable` 结构 vs `preserved` 原样保留，R105）。 */
export function equationIsEditable(content: EquationContent): boolean {
  return content.kind === 'editable';
}

/** 一个公式在偏移空间里贡献的码位数（恒为 1）。 */
export function equationInlineLength(content: EquationContent): number {
  return Array.from(equationTextProjection(content)).length;
}

/**
 * 扩展落地后，`EquationNode` 必须挂的**结构契约**（供测试与接线核对，不导出类型本身）。
 *
 * 这不是"建议"，是"冻结分支若要成立必须满足的四条"——它把 `DrawingNode` 已经满足的
 * 同一组性质在公式上重新钉一遍，免得扩展时漏掉其中一条。
 */
export interface EquationInlineContract {
  /** 判别式值：`InlineNode` 新分支的 `kind`。 */
  readonly kind: typeof EQUATION_SEGMENT_KIND;
  /** 段落偏移空间里的宽度。 */
  readonly inlineLength: typeof EQUATION_INLINE_LENGTH;
  /** 是否可编辑（**恒为 false**：公式整体可选中，但光标不落在它内部）。 */
  readonly editable: false;
  /** 文本投影。 */
  readonly placeholder: typeof EQUATION_PLACEHOLDER;
}

/** 契约的**单一声明处**：扩展落地时把它接进 `inline-map.ts`，别在别处重写一份。 */
export const EQUATION_INLINE_CONTRACT: EquationInlineContract = Object.freeze({
  kind: EQUATION_SEGMENT_KIND,
  inlineLength: EQUATION_INLINE_LENGTH,
  editable: false,
  placeholder: EQUATION_PLACEHOLDER,
});

/**
 * 段落里第 `inlineIndex` 个行内节点所覆盖的 `DocumentRange`（码位，止偏移开区间）。
 *
 * **今天就能用**：它对任意 `InlineNode` 都成立（走既有的 `buildInlineTextMap`），
 * 因此公式分支一旦落地，`documentRangeForInline(paragraph, i)` 无需改动即可给出
 * "选中这个公式"的选区——这正是 `selection/**` 消费侧的接线点。
 *
 * @returns 越界或段落里没有该行内节点时为 `null`（**不猜**、不返回空范围）。
 */
export function documentRangeForInline(paragraph: ParagraphNode, inlineIndex: number): DocumentRange | null {
  const map = buildInlineTextMap(paragraph.inlines);
  const segment = map.segments[inlineIndex];
  if (segment === undefined) return null;
  return { node_id: paragraph.id, start: segment.start, end: segment.end };
}

/** 同上，但按行内节点的**稳定 id** 定位（供"按 equation_id 找到选区"的调用方）。 */
export function documentRangeForInlineId(paragraph: ParagraphNode, inlineId: NodeId): DocumentRange | null {
  const index = paragraph.inlines.findIndex((inline) => inline.id === inlineId);
  return index < 0 ? null : documentRangeForInline(paragraph, index);
}

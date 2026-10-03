/**
 * 公式的**结构化表示**（WF-091；合同 R105、R107、R151）。
 *
 * ## 为什么公式必须是结构，不能是一张图片
 *
 * "以截图代替结构"（design-05 §3.9 明确禁止）在模型层有可判定的含义：**结构里能读出
 * 分子 / 分母 / 被开方数 / 指数 / 底数**，而图片只能读出像素。所以本包的核心是
 * 一个**判别联合的数学结构树**（`MathNode`），四个常见形态各有独立分支：
 *
 * | 结构 | 分支 | 可读出 |
 * |---|---|---|
 * | 分式 | `fraction` | `numeratorOf` / `denominatorOf` |
 * | 上下标 | `script` | `baseOf` / `superscriptOf` / `subscriptOf` |
 * | 根式 | `radical` | `radicandOf` / `degreeOf` |
 * | 文本 run | `math_run` | `text` |
 *
 * ## 与 OOXML 的关系：先给**语义形状**，不拼 XML
 *
 * R107 禁止 docx 子模块之外的地方拼 XML 字符串。本包因此只产出 `OmmlShape`——
 * 一棵用 OMML **元素名做数据字段**的语义树（`m:f` / `m:num` / `m:den` / `m:rad` …）。
 * 把它变成 `<m:f>…</m:frac>` 字节是导出器的事（本轮**未接线**，见
 * `.task-manifest/outputs/WCF-D33/interface-declaration.md` 的已知缺口）。
 *
 * ## 既有复杂公式：保留而不解析（R105）
 *
 * 导入文档里已有的公式可能用到本包没有建模的构造（矩阵、积分号限、自定义 OMML）。
 * R105 的取向是**原样保留、绝不改写**，因此 `EquationContent` 是
 * `editable`（本包建模的结构）与 `preserved`（原样字节/树，拒绝编辑）的联合——
 * "看不懂就保留"在类型上就无法被误当成"看懂了可以改"。
 */

import type { NodeId, SourceKind } from '../model/types.js';

/** 数学文本 run 的样式（OMML 的 `m:rPr`/`m:sty`）。 */
export type MathRunStyle = 'italic' | 'bold' | 'normal' | 'double-struck' | 'script';

/** 数学文本 run：结构树里的叶子。**空串 run 非法**（见 `build.ts` 的校验）。 */
export interface MathRunNode {
  readonly kind: 'math_run';
  readonly text: string;
  readonly style: MathRunStyle;
}

/** 分式：`numerator / denominator`。 */
export interface MathFractionNode {
  readonly kind: 'fraction';
  readonly numerator: MathNode;
  readonly denominator: MathNode;
}

/**
 * 根式：`degree √ radicand`。`degree === null` 为平方根（OMML 里 `m:deg` 缺省）。
 */
export interface MathRadicalNode {
  readonly kind: 'radical';
  readonly radicand: MathNode;
  readonly degree: MathNode | null;
}

/**
 * 上下标：`base` 带 `sup` / `sub`。至少有一个非空（否则应直接写 `base`）。
 * `sub` 与 `sup` 都为 `null` 的节点非法（见 `build.ts`）。
 */
export interface MathScriptNode {
  readonly kind: 'script';
  readonly base: MathNode;
  readonly sub: MathNode | null;
  readonly sup: MathNode | null;
}

/** 序列：多个结构并排（如 `x + 1`）。**空序列非法**。 */
export interface MathSequenceNode {
  readonly kind: 'sequence';
  readonly items: readonly MathNode[];
}

/** 数学结构树（判别联合）。 */
export type MathNode = MathRunNode | MathFractionNode | MathRadicalNode | MathScriptNode | MathSequenceNode;

/** 数学结构的种类名（供回执与测试断言，避免散落的字符串字面量）。 */
export const MATH_NODE_KINDS = ['math_run', 'fraction', 'radical', 'script', 'sequence'] as const;
export type MathNodeKind = (typeof MATH_NODE_KINDS)[number];

// ---------------------------------------------------------------------------
// OMML 语义形状（**数据，不是 XML 字符串**）
// ---------------------------------------------------------------------------

/**
 * OMML 语义形状。
 *
 * `omml` 字段用的是 OMML 元素名（`m:f` 分式 / `m:rad` 根式 / `m:sSup` 上标 /
 * `m:sSub` 下标 / `m:sSubSup` 上下标 / `m:r` run / `m:oMath` 序列）。
 * 它是**可序列化的普通对象**：导出器据此写 XML，测试据此断言"结构确实被映射到了
 * 对应的 OMML 语义"，而本包**一个尖括号都不产出**（R107）。
 */
export type OmmlShape =
  | { readonly omml: 'm:f'; readonly num: OmmlShape; readonly den: OmmlShape }
  | { readonly omml: 'm:rad'; readonly deg: OmmlShape | null; readonly e: OmmlShape }
  | { readonly omml: 'm:sSup'; readonly e: OmmlShape; readonly sup: OmmlShape }
  | { readonly omml: 'm:sSub'; readonly e: OmmlShape; readonly sub: OmmlShape }
  | { readonly omml: 'm:sSubSup'; readonly e: OmmlShape; readonly sub: OmmlShape; readonly sup: OmmlShape }
  | { readonly omml: 'm:r'; readonly text: string; readonly style: MathRunStyle }
  | { readonly omml: 'm:oMath'; readonly children: readonly OmmlShape[] };

// ---------------------------------------------------------------------------
// 文档中的公式条目
// ---------------------------------------------------------------------------

/**
 * 公式内容：**可编辑结构** 或 **原样保留**（二选一，R105）。
 *
 * `preserved` 分支刻意不给"部分解析结果"字段：一旦留了，调用方就会开始读它，
 * "保留不解析"就名存实亡。
 */
export type EquationContent =
  | { readonly kind: 'editable'; readonly equation: MathNode }
  | { readonly kind: 'preserved'; readonly reason: string; readonly omml: unknown };

/**
 * 文档里的一条公式。
 *
 * `anchor` 是它在段落里的**插入点**（段落 id + 码位偏移，R102）。`null` = 尚未锚定
 * （例如由解析器刚产出、还没插入文档）。
 *
 * ~~**已知缺口**：模型冻结骨架（`model/types.ts`）的 `InlineNode` 四分支里
 * 没有"公式"节点，因此 `equation_id` 目前只在本包内部唯一，
 * 还无法成为文档模型中可被选中的行内节点（见 interface-declaration）。~~
 *
 * **2026-10-03 更新（FA-W）**：该缺口**已闭合**——`model/types.ts` 的 `InlineNode` 现在是
 * 五分支（追加 `EquationNode`，纯加法；主协调者授权），`equation_id` 与
 * `EquationNode.equation_id` 是**同一条**标识：`EquationNode.content` 直接复用本文件的
 * `EquationContent`。上文的缺口描述按**落地前**状态阅读。
 */
export interface InlineEquation {
  readonly equation_id: string;
  readonly source: SourceKind;
  readonly content: EquationContent;
  readonly anchor: { readonly paragraph_id: NodeId; readonly offset: number } | null;
}

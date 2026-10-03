/**
 * 轻公式 → 行内 run 的**受限**桥（WF-091）。
 *
 * ## 为什么只桥"轻"的那一半
 *
 * **2026-10-03 更新（FA-W）**：模型现在**已有** `EquationNode` 行内分支
 * （`model/types.ts`，纯加法；主协调者授权），公式不再只能靠"桥成 run"进模型。
 * 本桥仍然有用——它产出的是**可编辑 run**（能改上标文字），而 `EquationNode` 是
 * "整体可选中、不可编辑"的对象；两者用途不同，**本桥不因新分支而废弃**。
 * 下文按**落地前**状态阅读：当时 `InlineNode` 只有 run / break / field / drawing 四种。
 *
 * 对**只用到上下标**的公式（`x^2`、`a_1`、`H_2O`），
 * run 的 `vertAlign` 属性足以忠实表达：上标 `superscript`、下标 `subscript`。
 * 于是这里给出一座**窄桥**，让最常见的一类公式今天就能进文档模型。
 *
 * 分式、根式**没有**对应的 run 属性（它们需要真正的 `m:f`/`m:rad` 部件），
 * 因此一律 `unsupported` 并说明原因——**不**退化成"分子分母用斜杠连起来"，
 * 那正是"把结构降级成文本"的偷懒做法，与设计点相悖。
 *
 * ## 为什么只支持一层上下标
 *
 * `x^{2^3}` 这种嵌套上下标在 run 层无法表达（一个 run 只有一档 `vertAlign`）。
 * 与其悄悄丢掉一层，不如明确拒绝——**宁可拒绝，不可静默降级**（R140/R151）。
 */

import { defaultRunProperties } from '../model/nodes.js';
import type { RunNode } from '../model/types.js';
import { fail, succeed, type Result } from '../selection/types.js';
import { validateMathNode } from './build.js';
import type { MathNode } from './types.js';

interface FlatPiece {
  readonly text: string;
  readonly level: 'baseline' | 'superscript' | 'subscript';
}

function flatten(node: MathNode, level: 'baseline' | 'superscript' | 'subscript', out: FlatPiece[]): string | null {
  switch (node.kind) {
    case 'math_run':
      out.push({ text: node.text, level });
      return null;
    case 'sequence':
      for (const item of node.items) {
        const error = flatten(item, level, out);
        if (error !== null) return error;
      }
      return null;
    case 'script': {
      const error = flatten(node.base, level, out);
      if (error !== null) return error;
      if (node.sub !== null) {
        if (node.sub.kind === 'script') return '嵌套上下标（下标里再带上下标）无法用 run 属性表达';
        if (node.sub.kind === 'fraction' || node.sub.kind === 'radical') {
          return '下标位置含分式/根式，无法用 run 属性表达';
        }
        const subError = flatten(node.sub, 'subscript', out);
        if (subError !== null) return subError;
      }
      if (node.sup !== null) {
        if (node.sup.kind === 'script') return '嵌套上下标（上标里再带上下标）无法用 run 属性表达';
        if (node.sup.kind === 'fraction' || node.sup.kind === 'radical') {
          return '上标位置含分式/根式，无法用 run 属性表达';
        }
        const supError = flatten(node.sup, 'superscript', out);
        if (supError !== null) return supError;
      }
      return null;
    }
    case 'fraction':
      return '分式需要 m:f 部件，run 层无法表达（模型暂无公式行内节点）';
    case 'radical':
      return '根式需要 m:rad 部件，run 层无法表达（模型暂无公式行内节点）';
  }
}

/**
 * 把轻公式桥接成行内 run 序列。
 *
 * - 仅支持 run / 序列 / **一层**上下标；其余形态返回 `unsupported` 并给出原因；
 * - run 的 id 是确定性的（`<equation_id>#r<i>`），同一公式重复桥接得到同一串 id；
 * - 未设置 `vertAlign` 的 run 属性与 `defaultRunProperties()` 一致（**不臆造格式**）。
 *
 * **本函数不改文档**：它只产出 run 值，插入由调用方（或后续接线）负责。
 */
export function equationToInlineRuns(
  equationId: string,
  equation: MathNode,
): Result<readonly RunNode[]> {
  if (typeof equationId !== 'string' || equationId.length === 0) {
    return fail('invalid_query', '桥接公式需要非空的 equation_id（run 的派生 id 以它为准）。', {
      extra: { equationId: String(equationId) },
    });
  }

  const checked = validateMathNode(equation);
  if (!checked.ok) return checked;

  const pieces: FlatPiece[] = [];
  const error = flatten(equation, 'baseline', pieces);
  if (error !== null) {
    return fail('unsupported', error, { extra: { equationId, rootKind: equation.kind } });
  }
  if (pieces.length === 0) {
    return fail('unsupported', '公式桥接后没有任何文本 run。', { extra: { equationId } });
  }

  const runs: RunNode[] = pieces.map((piece, index) => ({
    kind: 'run',
    id: `${equationId}#r${String(index)}`,
    source: 'model_generated',
    opaque: [],
    properties:
      piece.level === 'baseline'
        ? defaultRunProperties()
        : { ...defaultRunProperties(), vertAlign: { state: 'set', value: piece.level } },
    text: piece.text,
  }));

  return succeed(runs);
}

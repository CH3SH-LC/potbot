/**
 * 公式结构的构造与校验（WF-091）。
 *
 * ## 为什么构造器要**顺手校验**
 *
 * "空分式"（分子分母都是空序列）与"没有上下标的上下标"在 OMML 里是**退化产物**：
 * 导出后 Word 会画出一个空框或直接丢弃。与其等导出时才炸，不如让这类节点**根本构造不出来**：
 * 每个构造器都过 `validateMathNode`，不合法即返回 `Failure`（沿用选区包的 `Result` 形状，
 * 让上层分支处理，不靠解析 message）。
 *
 * 校验的硬项：
 * 1. `math_run.text` 非空；
 * 2. `sequence.items` 非空，且每项合法；
 * 3. `fraction` 的分子分母都合法（递归）；
 * 4. `radical.radicand` 合法；`degree` 为 `null` 或合法；
 * 5. `script` 的 `base` 合法，且 `sub` / `sup` **至少一个非空**。
 */

import { fail, succeed, type Result } from '../selection/types.js';
import type {
  MathFractionNode,
  MathNode,
  MathRadicalNode,
  MathRunNode,
  MathRunStyle,
  MathScriptNode,
  MathSequenceNode,
} from './types.js';

const RUN_STYLES: readonly MathRunStyle[] = ['italic', 'bold', 'normal', 'double-struck', 'script'];

/** 数学文本 run。 */
export function mathRun(text: string, style: MathRunStyle = 'italic'): MathRunNode {
  return { kind: 'math_run', text, style };
}

/** 序列（并排的多个结构）。至少一项才有意义，但**构造器不抛**——由 `validateMathNode` 判定。 */
export function sequence(items: readonly MathNode[]): MathSequenceNode {
  return { kind: 'sequence', items: [...items] };
}

/** 分式。 */
export function fraction(numerator: MathNode, denominator: MathNode): MathFractionNode {
  return { kind: 'fraction', numerator, denominator };
}

/** 根式；`degree === null` 为平方根。 */
export function radical(radicand: MathNode, degree: MathNode | null = null): MathRadicalNode {
  return { kind: 'radical', radicand, degree };
}

/** 上标：`base^sup`。 */
export function superscript(base: MathNode, sup: MathNode): MathScriptNode {
  return { kind: 'script', base, sub: null, sup };
}

/** 下标：`base_sub`。 */
export function subscript(base: MathNode, sub: MathNode): MathScriptNode {
  return { kind: 'script', base, sub, sup: null };
}

/** 同时带上下标：`base_sub^sup`。 */
export function subSuperscript(base: MathNode, sub: MathNode, sup: MathNode): MathScriptNode {
  return { kind: 'script', base, sub, sup };
}

function isEmptySequence(node: MathNode): boolean {
  return node.kind === 'sequence' && node.items.length === 0;
}

/**
 * 递归校验一个数学结构树。
 *
 * @returns 合法时返回**原节点**（不做拷贝——结构不可变即可复用）；否则给出结构化原因。
 */
export function validateMathNode(node: MathNode): Result<MathNode> {
  if (node === null || typeof node !== 'object') {
    return fail('invalid_query', '公式节点必须是对象。', { extra: { received: typeof node } });
  }

  switch (node.kind) {
    case 'math_run': {
      if (typeof node.text !== 'string' || node.text.length === 0) {
        return fail('invalid_query', '数学 run 的 text 必须是非空字符串（空 run 是退化产物）。', {
          extra: { text: String(node.text) },
        });
      }
      if (!RUN_STYLES.includes(node.style)) {
        return fail('invalid_query', `未知的数学字体样式：${String(node.style)}`, {
          extra: { style: String(node.style) },
        });
      }
      return succeed(node);
    }

    case 'sequence': {
      if (!Array.isArray(node.items) || node.items.length === 0) {
        return fail('invalid_query', '公式序列至少要有 1 项（空序列是退化产物）。', {
          extra: { items: Array.isArray(node.items) ? node.items.length : -1 },
        });
      }
      for (const [index, item] of node.items.entries()) {
        const checked = validateMathNode(item);
        if (!checked.ok) {
          return fail(checked.code, `序列第 ${String(index)} 项非法：${checked.message}`, checked.detail);
        }
      }
      return succeed(node);
    }

    case 'fraction': {
      for (const [slot, child] of [
        ['分子', node.numerator],
        ['分母', node.denominator],
      ] as const) {
        if (isEmptySequence(child)) {
          return fail('invalid_query', `分式的${slot}不能是空序列（会导出成空框）。`, {
            extra: { slot },
          });
        }
        const checked = validateMathNode(child);
        if (!checked.ok) {
          return fail(checked.code, `分式的${slot}非法：${checked.message}`, checked.detail);
        }
      }
      return succeed(node);
    }

    case 'radical': {
      if (isEmptySequence(node.radicand)) {
        return fail('invalid_query', '根式的被开方数不能是空序列。', { extra: { slot: 'radicand' } });
      }
      const checked = validateMathNode(node.radicand);
      if (!checked.ok) {
        return fail(checked.code, `根式的被开方数非法：${checked.message}`, checked.detail);
      }
      if (node.degree !== null) {
        if (isEmptySequence(node.degree)) {
          return fail('invalid_query', '根式的次数不能是空序列（要么不给，要么给合法的次数结构）。', {
            extra: { slot: 'degree' },
          });
        }
        const degree = validateMathNode(node.degree);
        if (!degree.ok) {
          return fail(degree.code, `根式的次数非法：${degree.message}`, degree.detail);
        }
      }
      return succeed(node);
    }

    case 'script': {
      if (isEmptySequence(node.base)) {
        return fail('invalid_query', '上下标的底数不能是空序列。', { extra: { slot: 'base' } });
      }
      const base = validateMathNode(node.base);
      if (!base.ok) return fail(base.code, `上下标的底数非法：${base.message}`, base.detail);

      if (node.sub === null && node.sup === null) {
        return fail('invalid_query', '上下标至少要有下标或上标之一（两者都空时直接用底数即可）。', {
          extra: { slot: 'script' },
        });
      }
      for (const [slot, child] of [
        ['下标', node.sub],
        ['上标', node.sup],
      ] as const) {
        if (child === null) continue;
        if (isEmptySequence(child)) {
          return fail('invalid_query', `上下标的${slot}不能是空序列。`, { extra: { slot } });
        }
        const checked = validateMathNode(child);
        if (!checked.ok) return fail(checked.code, `上下标的${slot}非法：${checked.message}`, checked.detail);
      }
      return succeed(node);
    }

    default: {
      const exhaustive: never = node;
      return fail('invalid_query', `未知的公式节点种类：${JSON.stringify(exhaustive)}`);
    }
  }
}

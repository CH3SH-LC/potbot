/**
 * 线性记法 → 数学结构（WF-091 的"可编辑"入口）。
 *
 * ## 为什么语法**故意**小
 *
 * 一个"什么都吃"的公式解析器会把不认识的构造**猜**成某种结构，而猜错的结构一旦写回
 * 就是静默损坏（R105/R151 都禁止）。所以这里的语法是**封闭**的，只覆盖设计点点名的
 * 常见形态；遇到宏、环境、矩阵一律 `invalid_expression`，把"看不懂"如实说出来：
 *
 * ```
 * \frac{1}{2}          分式
 * \sqrt{x+1}           平方根
 * \sqrt[3]{x}          带次数的根式
 * x^{2}  x_{1}  x_{1}^{2}  上下标（{} 可省为单字符）
 * {a+b}                分组（仅用于限定范围，不产生结构）
 * ```
 *
 * 说明：`{}` 分组**不产生节点**（返回值里看不到它），它只决定上下标/根式的作用范围。
 * 这与 OMML 的 `m:e`（"被作用对象"）语义一致，不是"丢掉了一层结构"。
 */

import { fraction, mathRun, radical, sequence, subscript, superscript, validateMathNode } from './build.js';
import { fail, succeed, type Result } from '../selection/types.js';
import type { EquationContent, MathNode } from './types.js';
import { editableEquation } from './preserve.js';

const MACROS: readonly string[] = ['\\frac', '\\sqrt'];

class Parser {
  private index = 0;

  constructor(private readonly source: string) {}

  parseAll(): Result<MathNode> {
    const items = this.parseElements();
    if (!items.ok) return items;
    if (this.index !== this.source.length) {
      return fail('invalid_expression', `线性公式在第 ${String(this.index)} 个字符处无法继续解析。`, {
        expression: this.source,
        extra: { index: this.index, char: this.source[this.index] ?? '' },
      });
    }
    if (items.value.length === 0) {
      return fail('invalid_expression', '线性公式是空的，没有可解析的结构。', { expression: this.source });
    }
    const node = items.value.length === 1 ? items.value[0]! : sequence(items.value);
    const checked = validateMathNode(node);
    if (!checked.ok) return checked;
    return succeed(node);
  }

  private parseElements(): Result<MathNode[]> {
    const out: MathNode[] = [];
    while (this.index < this.source.length) {
      const char = this.source[this.index]!;
      if (char === '}') break; // 交给上层（分组/参数）处理
      const element = this.parseElement();
      if (!element.ok) return element;
      if (element.value === null) break;
      out.push(element.value);
    }
    return succeed(out);
  }

  /** 解析一个"原子 + 可选上下标"。返回 `null` 表示到达边界（`}` 或字符串尾）。 */
  private parseElement(): Result<MathNode | null> {
    const atom = this.parseAtom();
    if (!atom.ok) return atom;
    if (atom.value === null) return succeed(null);

    let node = atom.value;
    for (;;) {
      const char = this.source[this.index];
      if (char !== '^' && char !== '_') break;
      this.index += 1;
      const argument = this.parseArgument();
      if (!argument.ok) return argument;
      // 同一底数上重复的 `^` / `_` 是嵌套上下标（run 层与常见排版都表达不了）——明确拒绝，不猜。
      if (node.kind === 'script' && (char === '^' ? node.sup !== null : node.sub !== null)) {
        return fail('invalid_expression', `同一个底数上出现了重复的 "${char}"：嵌套上下标不在本语法内。`, {
          expression: this.source,
          extra: { index: this.index },
        });
      }
      if (char === '^') {
        node = node.kind === 'script' ? { ...node, sup: argument.value } : superscript(node, argument.value);
      } else {
        node = node.kind === 'script' ? { ...node, sub: argument.value } : subscript(node, argument.value);
      }
    }
    return succeed(node);
  }

  private parseAtom(): Result<MathNode | null> {
    const char = this.source[this.index];
    if (char === undefined) return succeed(null);

    if (char === '\\') {
      const macro = MACROS.find((name) => this.source.startsWith(name, this.index));
      if (macro === undefined) {
        const match = /^\\[A-Za-z]+/.exec(this.source.slice(this.index));
        return fail(
          'invalid_expression',
          `未支持的公式宏 "${match?.[0] ?? this.source.slice(this.index, this.index + 1)}"：本语法是封闭的，无法解析的宏一律拒绝（不得猜结构）。`,
          { expression: this.source, extra: { index: this.index, macro: match?.[0] ?? '\\' } },
        );
      }
      this.index += macro.length;
      return macro === '\\frac' ? this.parseFraction() : this.parseRadical();
    }

    if (char === '{') {
      this.index += 1;
      const inner = this.parseElements();
      if (!inner.ok) return inner;
      if (this.source[this.index] !== '}') {
        return fail('invalid_expression', '分组 `{` 没有对应的 `}`。', {
          expression: this.source,
          extra: { index: this.index },
        });
      }
      this.index += 1;
      if (inner.value.length === 0) {
        return fail('invalid_expression', '空分组 `{}` 不构成任何结构。', {
          expression: this.source,
          extra: { index: this.index },
        });
      }
      return succeed(inner.value.length === 1 ? inner.value[0]! : sequence(inner.value));
    }

    if (char === '}' || char === '^' || char === '_') return succeed(null); // 边界：交给上层报错

    return this.parsePlainText();
  }

  /** 连续的非保留字符构成一个 run（保留字符：`\ { } ^ _`）。 */
  private parsePlainText(): Result<MathNode> {
    const start = this.index;
    while (this.index < this.source.length) {
      const char = this.source[this.index]!;
      if (char === '\\' || char === '{' || char === '}' || char === '^' || char === '_') break;
      this.index += 1;
    }
    const text = this.source.slice(start, this.index);
    if (text.length === 0) {
      return fail('invalid_expression', `第 ${String(start)} 个字符处没有任何可解析内容。`, {
        expression: this.source,
        extra: { index: start },
      });
    }
    return succeed(mathRun(text));
  }

  private parseFraction(): Result<MathNode> {
    const numerator = this.parseArgument();
    if (!numerator.ok) return numerator;
    const denominator = this.parseArgument();
    if (!denominator.ok) return denominator;
    return succeed(fraction(numerator.value, denominator.value));
  }

  private parseRadical(): Result<MathNode> {
    let degree: MathNode | null = null;
    if (this.source[this.index] === '[') {
      const close = this.source.indexOf(']', this.index + 1);
      if (close < 0) {
        return fail('invalid_expression', '根式次数 `[` 没有对应的 `]`。', {
          expression: this.source,
          extra: { index: this.index },
        });
      }
      const inner = this.source.slice(this.index + 1, close);
      const parsed = parseMath(inner);
      if (!parsed.ok) return parsed;
      degree = parsed.value;
      this.index = close + 1;
    }
    const radicand = this.parseArgument();
    if (!radicand.ok) return radicand;
    return succeed(radical(radicand.value, degree));
  }

  /** 一个参数：`{...}` 或**单个字符**（`x^2` 里的 `2`）。 */
  private parseArgument(): Result<MathNode> {
    const char = this.source[this.index];
    if (char === undefined) {
      return fail('invalid_expression', '公式在需要参数的位置结束了。', {
        expression: this.source,
        extra: { index: this.index },
      });
    }
    if (char === '{') {
      this.index += 1;
      const inner = this.parseElements();
      if (!inner.ok) return inner;
      if (this.source[this.index] !== '}') {
        return fail('invalid_expression', '参数 `{` 没有对应的 `}`。', {
          expression: this.source,
          extra: { index: this.index },
        });
      }
      this.index += 1;
      if (inner.value.length === 0) {
        return fail('invalid_expression', '参数 `{}` 为空，公式结构不完整。', {
          expression: this.source,
          extra: { index: this.index },
        });
      }
      return succeed(inner.value.length === 1 ? inner.value[0]! : sequence(inner.value));
    }
    return this.parsePlainText();
  }
}

/**
 * 解析线性公式记法。
 *
 * @returns 成功给出 `MathNode`（单元素直接返回该元素；多元素包成 `sequence`）；
 *          语法不合法 / 用到未支持的宏一律 `invalid_expression`，**绝不猜结构**。
 */
export function parseMath(source: string): Result<MathNode> {
  if (typeof source !== 'string') {
    return fail('invalid_expression', '公式源必须是字符串。', { extra: { received: typeof source } });
  }
  return new Parser(source).parseAll();
}

/** 便捷：线性记法 → **可编辑**公式内容。 */
export function equationFromLinear(source: string): Result<EquationContent> {
  const parsed = parseMath(source);
  if (!parsed.ok) return parsed;
  return succeed(editableEquation(parsed.value));
}

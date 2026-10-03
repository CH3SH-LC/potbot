/**
 * 既有复杂公式的**保留而不解析**（WF-091；R105）。
 *
 * 判据里的两半是绑在一起的：既要"常见分式/上下标/根式**可编辑**"，也要
 * "既有复杂公式**保留**"（不得为了编辑一句就去重写别人的公式）。本文件实现后半句：
 *
 * - `preserveExistingEquation` 把原样的 OMML（或任何不透明结构）**原封不动**装进
 *   `preserved` 分支，并**冻结**（外部改不到内部）；
 * - `assertEditable` 是给"要改结构"的调用方用的闸门——遇到 `preserved` 一律
 *   `unsupported` 并把原因说清楚，**绝不**"解不动就当空的重新拼一个"；
 * - `describeEquationContent` 给回执一句人话，让"这条公式只是保留、不能改"能被用户看到。
 */

import { fail, succeed, type Result } from '../selection/types.js';
import type { EquationContent, MathNode } from './types.js';

/** 不可编辑时的默认原因（R105 的原话改成可读版）。 */
export const PRESERVED_EQUATION_REASON =
  '既有公式含本批未建模的构造，按 R105 原样保留、不解析；要编辑请先在目标软件里简化或另存为受支持结构。';

/**
 * 把既有公式装进**保留**分支。传入对象会被冻结（含数组与一层嵌套容器），
 * 避免调用方事后改到"原样"的那份数据。
 */
export function preserveExistingEquation(input: { readonly omml: unknown; readonly reason?: string }): EquationContent {
  return Object.freeze({
    kind: 'preserved' as const,
    reason: input.reason ?? PRESERVED_EQUATION_REASON,
    omml: deepFreeze(input.omml),
  });
}

/** 用结构造一条**可编辑**公式内容。 */
export function editableEquation(equation: MathNode): EquationContent {
  return Object.freeze({ kind: 'editable' as const, equation });
}

/** 是否为保留分支。 */
export function isPreserved(content: EquationContent): boolean {
  return content.kind === 'preserved';
}

/** 可编辑结构；保留分支返回 `null`（**不抛**，让调用方自己决定怎么反馈）。 */
export function editableOf(content: EquationContent): MathNode | null {
  return content.kind === 'editable' ? content.equation : null;
}

/**
 * 闸门：要求内容可编辑。
 *
 * 保留分支返回 `unsupported`（不是 `failed`）——因为这不是"出错了"，而是
 * **明确不支持的形态**（R140/R154：未支持能力操作前拒绝，且拒绝后文档不变）。
 */
export function assertEditable(content: EquationContent): Result<EquationContent> {
  if (content.kind === 'preserved') {
    return fail('unsupported', content.reason, {
      extra: { equationContent: 'preserved' },
    });
  }
  return succeed(content);
}

/** 给回执的一句话描述。 */
export function describeEquationContent(content: EquationContent): string {
  if (content.kind === 'preserved') {
    return `公式[保留]：${content.reason}`;
  }
  return `公式[可编辑]：${content.equation.kind}`;
}

function deepFreeze(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth > 8) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item, depth + 1);
    return Object.freeze(value);
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    deepFreeze(item, depth + 1);
  }
  return Object.freeze(value);
}

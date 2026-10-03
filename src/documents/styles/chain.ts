/**
 * `basedOn` 继承链解析（R122 的一部分 + R123 全部）。
 *
 * ## 为什么"有限终止"要专门做（R123）
 *
 * 真实文档里的 `basedOn` 是用户手工维护的，会出两种坏情况：
 *
 * 1. **成环**：`A.basedOn = B`、`B.basedOn = A`。朴素递归会栈溢出——不是"结果不对"，
 *    是**整个进程挂掉**。对一个要处理用户上传文件的系统，这是可用性级别的缺陷。
 * 2. **坏引用**：`basedOn` 指向一个不存在的 `style_id`。朴素实现会得到 `undefined`，
 *    后续取 `.run_properties` 抛 `TypeError`——变成"崩"而不是"明确拒绝"。
 *
 * 本实现用**已访问集合**（visited set）保证每个 style_id 最多展开一次，因此**结构上不可能**
 * 无限递归，与链长无关；再加一层 `maxDepth` 上限做兜底（防御被构造出来的超长链）。
 * 检出问题不是抛异常，而是返回 `conflict` 结果——因为 R154 要求能力反馈明确，
 * 而且一份文档里有一个坏样式不该让整次编辑失败。
 *
 * ## 返回顺序：**根在前**
 *
 * 级联应用必须"祖先先、后代后"（后代覆盖祖先）。本函数返回 `[根, …, 目标样式]`，
 * 于是消费方 `for (const s of chain) apply(s)` 天然得到正确的覆盖方向。
 * 反过来（目标在前）会让祖先覆盖后代，是这类代码最常见的错误。
 */

import type { StyleDefinition, StyleTable } from '../model/types.js';

/** 样式链问题的种类。 */
export type StyleProblemKind =
  /** `basedOn` 成环（R123）。 */
  | 'cycle'
  /** `basedOn` 或起始 `style_id` 指向不存在的样式（R123 的"坏引用"）。 */
  | 'dangling_reference'
  /** 引用的样式类型不对（如段落样式基于字符样式）。 */
  | 'wrong_type';

/** 一个样式链问题。带足复现信息，便于上层给出可解释反馈（R116 的精神）。 */
export interface StyleProblem {
  readonly kind: StyleProblemKind;
  readonly style_id: string;
  readonly detail: string;
  /** 检出问题时的遍历路径（便于用户定位是哪几个样式互相引用）。 */
  readonly path: readonly string[];
}

/** 链解析结果。 */
export type StyleChainResult =
  | { readonly ok: true; readonly chain: readonly StyleDefinition[] }
  | {
      readonly ok: false;
      readonly chain: readonly StyleDefinition[];
      readonly problem: StyleProblem;
    };

/** 默认深度上限（防御性兜底；正常文档远小于此）。 */
export const DEFAULT_MAX_STYLE_DEPTH = 64;

/** 在样式表里按 id 找样式；找不到返回 `null`。 */
export function findStyle(table: StyleTable, styleId: string): StyleDefinition | null {
  return table.styles.find((style) => style.style_id === styleId) ?? null;
}

/** 找某类型的默认样式（`is_default`）。用于"文档默认"层（R122）。 */
export function findDefaultStyle(table: StyleTable, type: StyleDefinition['type']): StyleDefinition | null {
  return table.styles.find((style) => style.is_default && style.type === type) ?? null;
}

/**
 * 解析 `styleId` 的完整继承链，**根在前**（R122/R123）。
 *
 * - 起始 id 不存在 → `dangling_reference`；
 * - 链中某个 `basedOn` 指向不存在 → `dangling_reference`；
 * - 成环 → `cycle`（`path` 里能看到环）；
 * - 超过 `maxDepth` → `cycle`（按"无法在有限深度内终止"归类，如实报告）；
 * - 链中样式类型与起始样式不同 → `wrong_type`。
 *
 * 失败时 `chain` 仍返回**已经成功解析的前缀**——上层可以"尽力应用"再报告冲突，
 * 这比"整页格式全丢"更好，也比"静默忽略"更诚实。
 */
export function resolveStyleChain(
  table: StyleTable,
  styleId: string,
  maxDepth: number = DEFAULT_MAX_STYLE_DEPTH,
): StyleChainResult {
  const start = findStyle(table, styleId);
  if (start === null) {
    return {
      ok: false,
      chain: [],
      problem: {
        kind: 'dangling_reference',
        style_id: styleId,
        detail: `起始样式 '${styleId}' 在样式表中不存在`,
        path: [styleId],
      },
    };
  }

  const rootFirst: StyleDefinition[] = [];
  const visited = new Set<string>();
  const path: string[] = [];
  let current: StyleDefinition | null = start;

  while (current !== null) {
    if (visited.has(current.style_id)) {
      // 成环：当前样式在本链上已经展开过。visited 保证循环必然在这里停止。
      path.push(current.style_id);
      return {
        ok: false,
        chain: [...rootFirst].reverse(),
        problem: {
          kind: 'cycle',
          style_id: current.style_id,
          detail: `basedOn 继承链成环：${path.join(' → ')}`,
          path,
        },
      };
    }
    if (path.length >= maxDepth) {
      path.push(current.style_id);
      return {
        ok: false,
        chain: [...rootFirst].reverse(),
        problem: {
          kind: 'cycle',
          style_id: current.style_id,
          detail: `basedOn 继承链超过深度上限 ${maxDepth}（按无法有限终止处理）`,
          path,
        },
      };
    }
    if (current.type !== start.type) {
      path.push(current.style_id);
      return {
        ok: false,
        chain: [...rootFirst].reverse(),
        problem: {
          kind: 'wrong_type',
          style_id: current.style_id,
          detail: `样式 '${current.style_id}' 的类型是 ${current.type}，与起始样式 '${start.style_id}' 的 ${start.type} 不一致`,
          path,
        },
      };
    }

    visited.add(current.style_id);
    path.push(current.style_id);
    rootFirst.push(current);

    if (current.based_on === null) break;
    const parent = findStyle(table, current.based_on);
    if (parent === null) {
      path.push(current.based_on);
      return {
        ok: false,
        chain: [...rootFirst].reverse(),
        problem: {
          kind: 'dangling_reference',
          style_id: current.based_on,
          detail: `样式 '${current.style_id}' 的 basedOn 指向不存在的样式 '${current.based_on}'`,
          path,
        },
      };
    }
    current = parent;
  }

  // rootFirst 是"目标在前、根在后"，反转成"根在前"。
  return { ok: true, chain: [...rootFirst].reverse() };
}

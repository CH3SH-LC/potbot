/**
 * 命名样式的**可修改**层（WF-037/038，合同 R122/R123/R126）。
 *
 * ## 从"只读级联"到"可修改"到底改了什么
 *
 * D04 交出来的 `cascade.ts` / `chain.ts` 已经能**解释**一份样式表，`apply.ts` 能
 * **应用**样式（只写 `pStyle` 引用）与改一个样式。本文件补的是这条链的**写侧完整性**：
 * 新建 / 删除 / 重置 / 改 `basedOn`，且每次都让"引用完整性"当场成立。缺了它，
 * "改一个命名样式后所有引用段落一致更新"（R126/WF-037）只能靠手工在数组里换对象。
 *
 * ## 三条不变量（每次写操作后都成立）
 *
 * 1. **`basedOn` 不成环**：改 `basedOn` 前先用 `resolveStyleChain` 在**假想的表**上试算，
 *    成环即拒绝（R123）。这样"改完才发现成环"不可能发生。
 * 2. **不产生第二个同 id 样式**：改名走 patch，`style_id` 在实现里被钉死不可改
 *    （`apply.ts` 的 `updateNamedStyle` 已如此，本层同样）。
 * 3. **删除不留悬空引用**：仍有样式基于它、或仍有段落引用它时，删除必须显式给出
 *    `reassign_to`，否则拒绝（R154：明确拒绝而不是留个坏引用）。
 *
 * ## 为什么"重置"要单独出一个动词（WF-038）
 *
 * "把样式改回继承"与"把样式改成一个空值"是两回事：
 * - 重置 = 该样式**自己不再表达任何属性**（`run_properties` / `paragraph_properties` 清空），
 *   有效属性完全由 `basedOn` 链与文档默认决定——这才是"清除覆盖回继承"（R117 的 `inherit`）；
 * - 若只是把某个属性设成 `false`/`0`，那是"显式关闭"，外观完全不同（R118）。
 *
 * 所以本文件提供 `resetNamedStyle`（清空本层覆盖），而不是让调用方写一堆 `inherit`。
 */

import type { NodeId, ParagraphNode, StyleDefinition, StyleTable, BlockNode, TableNode } from '../model/types.js';
import { findStyle, resolveStyleChain, type StyleProblemKind } from './chain.js';
import { updateNamedStyle } from './apply.js';

/** 样式写操作的失败码。 */
export type StyleProblemCode =
  | 'duplicate_style_id'
  | 'unknown_style'
  | 'dangling_based_on'
  | 'cycle_based_on'
  | 'wrong_type'
  | 'style_in_use'
  | 'invalid_definition';

export interface StyleFailure {
  readonly ok: false;
  readonly code: StyleProblemCode;
  readonly detail: string;
}

export interface StyleTableOutcome {
  readonly ok: true;
  readonly table: StyleTable;
}

const STYLE_TYPES: ReadonlySet<StyleDefinition['type']> = new Set([
  'paragraph',
  'character',
  'table',
  'numbering',
]);

function fail(code: StyleProblemCode, detail: string): StyleFailure {
  return { ok: false, code, detail };
}

/** 把 `resolveStyleChain` 的问题种类映射成写侧的失败码。 */
function mapChainProblem(kind: StyleProblemKind): StyleProblemCode {
  switch (kind) {
    case 'cycle':
      return 'cycle_based_on';
    case 'dangling_reference':
      return 'dangling_based_on';
    case 'wrong_type':
      return 'wrong_type';
    default:
      return 'invalid_definition';
  }
}

/** 校验一份**候选表**里 `styleId` 的继承链是否健康（成环 / 坏引用 / 类型不符）。 */
function chainFailure(candidate: StyleTable, styleId: string): StyleFailure | null {
  const result = resolveStyleChain(candidate, styleId);
  if (result.ok) {
    return null;
  }
  return fail(mapChainProblem(result.problem.kind), result.problem.detail);
}

/** 校验定义的基本形态。 */
function validateDefinition(definition: StyleDefinition): StyleFailure | null {
  if (typeof definition.style_id !== 'string' || definition.style_id.length === 0) {
    return fail('invalid_definition', 'style_id 必须是非空字符串');
  }
  if (!STYLE_TYPES.has(definition.type)) {
    return fail('invalid_definition', `样式类型非法：${JSON.stringify(definition.type)}`);
  }
  if (typeof definition.name !== 'string' || definition.name.length === 0) {
    return fail('invalid_definition', '样式名必须是非空字符串');
  }
  return null;
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/** 直接以 `styleId` 为 `basedOn` 的样式（一级后代）。 */
export function stylesBasedOn(table: StyleTable, styleId: string): readonly StyleDefinition[] {
  return table.styles.filter((style) => style.based_on === styleId);
}

/** 传递闭包：所有（直接或间接）基于 `styleId` 的样式 id。 */
export function styleDescendants(table: StyleTable, styleId: string): readonly string[] {
  const found = new Set<string>();
  const queue = [styleId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const style of table.styles) {
      if (style.based_on === current && !found.has(style.style_id)) {
        found.add(style.style_id);
        queue.push(style.style_id);
      }
    }
  }
  return [...found];
}

/** 深度遍历块（含表格单元格内）收集所有引用某样式的段落。 */
export function paragraphsUsingStyle(
  blocks: readonly BlockNode[],
  styleId: string,
): readonly ParagraphNode[] {
  const found: ParagraphNode[] = [];
  const visit = (list: readonly BlockNode[]): void => {
    for (const block of list) {
      if (block.kind === 'paragraph') {
        if (block.style_ref === styleId) {
          found.push(block);
        }
        continue;
      }
      if (block.kind !== 'table') {
        continue;
      }
      for (const row of (block as TableNode).rows) {
        for (const cell of row.cells) {
          visit(cell.blocks);
        }
      }
    }
  };
  visit(blocks);
  return found;
}

// ---------------------------------------------------------------------------
// 新建
// ---------------------------------------------------------------------------

/**
 * 新建命名样式（WF-037）。
 *
 * 拒绝条件：id 重复、`basedOn` 指向不存在的样式、`basedOn` 类型不符、链成环。
 * 成功返回新表；**原表不变**（纯函数，R136）。
 */
export function createNamedStyle(table: StyleTable, definition: StyleDefinition): StyleTableOutcome | StyleFailure {
  const invalid = validateDefinition(definition);
  if (invalid !== null) {
    return invalid;
  }
  if (findStyle(table, definition.style_id) !== null) {
    return fail('duplicate_style_id', `样式 id ${JSON.stringify(definition.style_id)} 已存在`);
  }
  if (definition.based_on !== null) {
    const base = findStyle(table, definition.based_on);
    if (base === null) {
      return fail('dangling_based_on', `基于的样式 ${JSON.stringify(definition.based_on)} 不存在`);
    }
    if (base.type !== definition.type) {
      return fail(
        'wrong_type',
        `样式 ${JSON.stringify(definition.style_id)} 的类型 ${definition.type} 与所基于的 ${JSON.stringify(base.style_id)} 的 ${base.type} 不一致`,
      );
    }
  }
  const candidate: StyleTable = { ...table, styles: [...table.styles, definition] };
  // 单个新样式本身不可能成环（它只是一个新节点）；仍跑一次以统一出口。
  const problem = chainFailure(candidate, definition.style_id);
  if (problem !== null) {
    return problem;
  }
  return { ok: true, table: candidate };
}

// ---------------------------------------------------------------------------
// 修改 / 重置
// ---------------------------------------------------------------------------

/**
 * 修改命名样式（WF-037 的"一致更新"入口）。
 *
 * 与 `apply.ts` 的 `updateNamedStyle` 同语义，但**结构化校验** `basedOn`：
 * 改完若成环 / 指向不存在 / 类型不符，直接拒绝，绝不落地一份坏表。
 *
 * 注意：改完之后**引用它的段落读回自然变化**（R126）——因为段落只存 `style_ref`，
 * 有效属性由 `cascade.ts` 现算。本函数不（也无法）去"刷新"任何段落。
 */
export function modifyNamedStyle(
  table: StyleTable,
  styleId: string,
  patch: Partial<Omit<StyleDefinition, 'style_id'>>,
): StyleTableOutcome | StyleFailure {
  const target = findStyle(table, styleId);
  if (target === null) {
    return fail('unknown_style', `样式 ${JSON.stringify(styleId)} 不存在，无法修改`);
  }
  const updated: StyleDefinition = { ...target, ...patch, style_id: styleId };
  const invalid = validateDefinition(updated);
  if (invalid !== null) {
    return invalid;
  }
  if (updated.based_on !== null && updated.based_on !== target.based_on) {
    const base = findStyle(table, updated.based_on);
    if (base === null) {
      return fail('dangling_based_on', `基于的样式 ${JSON.stringify(updated.based_on)} 不存在`);
    }
    if (base.type !== updated.type) {
      return fail(
        'wrong_type',
        `样式 ${JSON.stringify(styleId)} 的类型 ${updated.type} 与所基于的 ${JSON.stringify(base.style_id)} 的 ${base.type} 不一致`,
      );
    }
  }
  const candidate: StyleTable = {
    ...table,
    styles: table.styles.map((style) => (style.style_id === styleId ? updated : style)),
  };
  const problem = chainFailure(candidate, styleId);
  if (problem !== null) {
    return problem;
  }
  return { ok: true, table: candidate };
}

/** 改 `basedOn`（WF-038 的继承调整）。成环 / 坏引用 / 类型不符即拒绝。 */
export function setStyleBasedOn(
  table: StyleTable,
  styleId: string,
  baseId: string | null,
): StyleTableOutcome | StyleFailure {
  return modifyNamedStyle(table, styleId, { based_on: baseId });
}

/**
 * 重置样式：清空该样式**自己**的表达（`run_properties` / `paragraph_properties` → `{}`），
 * 让它完全按 `basedOn` 链与文档默认算（WF-038：清除覆盖回继承）。
 *
 * `keepBase`（默认 `true`）为 `false` 时连 `basedOn` 一起清掉（彻底回到文档默认）。
 */
export function resetNamedStyle(
  table: StyleTable,
  styleId: string,
  options: { readonly keepBase?: boolean } = {},
): StyleTableOutcome | StyleFailure {
  if (findStyle(table, styleId) === null) {
    return fail('unknown_style', `样式 ${JSON.stringify(styleId)} 不存在，无法重置`);
  }
  const keepBase = options.keepBase ?? true;
  return modifyNamedStyle(table, styleId, {
    run_properties: {},
    paragraph_properties: {},
    ...(keepBase ? {} : { based_on: null }),
  });
}

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

/** 删除命名样式的选项。 */
export interface DeleteStyleOptions {
  /** 把基于它的样式与引用它的段落改指到这个样式 id。不给且存在引用 ⇒ 拒绝。 */
  readonly reassign_to?: string;
}

/** 删除命名样式；有引用时必须显式 `reassign_to`，否则明确拒绝（不留悬空引用）。 */
export function deleteNamedStyle(
  table: StyleTable,
  styleId: string,
  options: DeleteStyleOptions = {},
): StyleTableOutcome | StyleFailure {
  const target = findStyle(table, styleId);
  if (target === null) {
    return fail('unknown_style', `样式 ${JSON.stringify(styleId)} 不存在，无法删除`);
  }
  const dependents = stylesBasedOn(table, styleId);
  const reassignTo = options.reassign_to;
  if (dependents.length > 0 && reassignTo === undefined) {
    return fail(
      'style_in_use',
      `${String(dependents.length)} 个样式基于 ${JSON.stringify(styleId)}（${dependents
        .map((style) => style.style_id)
        .join(', ')}）；请先用 reassign_to 指定替代样式`,
    );
  }
  if (reassignTo !== undefined) {
    if (reassignTo === styleId) {
      return fail('invalid_definition', 'reassign_to 不能是被删除的样式自身');
    }
    const replacement = findStyle(table, reassignTo);
    if (replacement === null) {
      return fail('unknown_style', `替代样式 ${JSON.stringify(reassignTo)} 不存在`);
    }
    if (replacement.type !== target.type) {
      return fail(
        'wrong_type',
        `替代样式 ${JSON.stringify(reassignTo)} 的类型 ${replacement.type} 与被删样式 ${JSON.stringify(styleId)} 的 ${target.type} 不一致`,
      );
    }
  }

  const retarget = (style: StyleDefinition): StyleDefinition =>
    reassignTo !== undefined && style.based_on === styleId ? { ...style, based_on: reassignTo } : style;

  const candidate: StyleTable = {
    ...table,
    styles: table.styles.filter((style) => style.style_id !== styleId).map(retarget),
  };

  // 改指之后仍要保证继承链健康（例如把 basedOn 接到自己原来的一条后代上会成环）。
  if (reassignTo !== undefined) {
    for (const style of candidate.styles) {
      const problem = chainFailure(candidate, style.style_id);
      if (problem !== null) {
        return problem;
      }
    }
  }
  return { ok: true, table: candidate };
}

/**
 * 把块里所有引用 `fromId` 的段落改指 `toId`（配合删除样式的重指向）。
 *
 * 返回 `null` 表示**一个都没命中**——调用方据此区分"改指完成"与"根本没有引用"，
 * 而不是靠比较前后对象（沿用 `walk.ts` 的取向）。表格单元格内的段落一并处理。
 */
export function retargetStyleReferences(
  blocks: readonly BlockNode[],
  fromId: string,
  toId: string,
): { readonly blocks: readonly BlockNode[]; readonly changed: readonly NodeId[] } | null {
  const changed: NodeId[] = [];
  const visit = (list: readonly BlockNode[]): readonly BlockNode[] =>
    list.map((block) => {
      if (block.kind === 'paragraph') {
        if (block.style_ref !== fromId) {
          return block;
        }
        changed.push(block.id);
        return { ...block, style_ref: toId };
      }
      if (block.kind !== 'table') {
        return block;
      }
      const table = block as TableNode;
      let tableChanged = false;
      const rows = table.rows.map((row) => {
        let rowChanged = false;
        const cells = row.cells.map((cell) => {
          const next = visit(cell.blocks);
          if (next === cell.blocks) {
            return cell;
          }
          rowChanged = true;
          return { ...cell, blocks: next };
        });
        if (!rowChanged) {
          return row;
        }
        tableChanged = true;
        return { ...row, cells };
      });
      return tableChanged ? { ...table, rows } : table;
    });
  const next = visit(blocks);
  // 命中数是判据：一个都没命中即返回 `null`（"改指完成"与"根本没有引用"必须能区分）。
  // 不能靠 `next === blocks` 判断——`map` 天生返回新数组，那个比较恒为假。
  if (changed.length === 0) {
    return null;
  }
  return { blocks: next, changed };
}

/** 便捷：直接用 `updateNamedStyle` 的薄封装，便于与既有代码共用一条路径。 */
export function patchNamedStyle(
  table: StyleTable,
  styleId: string,
  patch: Partial<Omit<StyleDefinition, 'style_id'>>,
): StyleTableOutcome | StyleFailure {
  const result = updateNamedStyle(table, styleId, patch);
  return result.ok ? { ok: true, table: result.table } : fail('unknown_style', result.reason);
}

/**
 * M-R02 —— 规格必选 / 多选校验。
 *
 * 规则（全部显式报错，绝不「顺手修正」）：
 * - 引用的 `groupId` / `optionId` 必须非空且真实存在于该 SKU（`invalid_id` / `unknown_group` / `unknown_option`）；
 * - 同组同选项不允许出现两次（`duplicate_option`）；
 * - 单选组最多 1 个（`single_group_multi_selected`）；必选组不能为空（`required_group_missing`）；
 * - 多选组数量必须落在 `[minSelections, maxSelections]`（`too_few_selections` / `too_many_selections`）；
 * - 选中的选项必须 `available`（`option_unavailable`）。
 *
 * 输出顺序固定（先按 `groupId`，再按 `code`，再按 `optionId`），保证同一输入永远得到同一结果。
 */

import { CatalogValidationError } from './errors.js';
import type { CatalogIssue, DishSku, SpecSelection, SpecValidationResult, SkuSpecGroup } from './types.js';

interface GroupIndex {
  readonly group: SkuSpecGroup;
  readonly optionIds: ReadonlySet<string>;
  readonly optionAvailable: ReadonlyMap<string, boolean>;
}

function indexGroups(sku: DishSku): ReadonlyMap<string, GroupIndex> {
  const map = new Map<string, GroupIndex>();
  for (const group of sku.specGroups) {
    if (typeof group.groupId !== 'string' || group.groupId.length === 0) {
      throw new CatalogValidationError(`SKU ${sku.skuId} 存在空 groupId 的规格组`);
    }
    if (map.has(group.groupId)) {
      throw new CatalogValidationError(`SKU ${sku.skuId} 的规格组 ${group.groupId} 重复定义`);
    }
    const optionIds = new Set<string>();
    const optionAvailable = new Map<string, boolean>();
    for (const option of group.options) {
      if (typeof option.optionId !== 'string' || option.optionId.length === 0) {
        throw new CatalogValidationError(`规格组 ${group.groupId} 存在空 optionId`);
      }
      if (optionIds.has(option.optionId)) {
        throw new CatalogValidationError(`规格组 ${group.groupId} 的选项 ${option.optionId} 重复定义`);
      }
      optionIds.add(option.optionId);
      optionAvailable.set(option.optionId, option.available);
    }
    map.set(group.groupId, { group, optionIds, optionAvailable });
  }
  return map;
}

function issue(code: CatalogIssue['code'], message: string, extra: Partial<CatalogIssue> = {}): CatalogIssue {
  return { code, message, ...extra };
}

function orderIssues(issues: readonly CatalogIssue[]): readonly CatalogIssue[] {
  return Object.freeze(
    [...issues].sort((a, b) => {
      const aG = a.groupId ?? '';
      const bG = b.groupId ?? '';
      if (aG !== bG) return aG < bG ? -1 : 1;
      if (a.code !== b.code) return a.code < b.code ? -1 : 1;
      const aO = a.optionId ?? '';
      const bO = b.optionId ?? '';
      return aO < bO ? -1 : aO > bO ? 1 : 0;
    }),
  );
}

/**
 * 校验一组规格选择是否符合该 SKU 的规则。
 *
 * 重复的「同组同选项」只报一次；计数时也只计一次。
 */
export function validateSpecSelection(
  sku: DishSku,
  selections: readonly SpecSelection[] = [],
): SpecValidationResult {
  const groups = indexGroups(sku);
  const issues: CatalogIssue[] = [];
  const countByGroup = new Map<string, number>();
  const seenPairs = new Set<string>();
  const unknownGroups = new Set<string>();

  for (const selection of selections) {
    const groupId = selection.groupId;
    const optionId = selection.optionId;
    if (typeof groupId !== 'string' || groupId.length === 0 || typeof optionId !== 'string' || optionId.length === 0) {
      issues.push(issue('invalid_id', '规格选择的 groupId / optionId 不能为空', { groupId, optionId }));
      continue;
    }
    const entry = groups.get(groupId);
    if (entry === undefined) {
      if (!unknownGroups.has(groupId)) {
        unknownGroups.add(groupId);
        issues.push(issue('unknown_group', `SKU ${sku.skuId} 没有规格组 ${groupId}`, { groupId }));
      }
      continue;
    }
    if (!entry.optionIds.has(optionId)) {
      issues.push(issue('unknown_option', `规格组 ${groupId} 没有选项 ${optionId}`, { groupId, optionId }));
      continue;
    }
    const pair = `${groupId}\u0000${optionId}`;
    if (seenPairs.has(pair)) {
      issues.push(issue('duplicate_option', `规格组 ${groupId} 的选项 ${optionId} 重复选择`, { groupId, optionId }));
    } else {
      seenPairs.add(pair);
      countByGroup.set(groupId, (countByGroup.get(groupId) ?? 0) + 1);
      if (entry.optionAvailable.get(optionId) === false) {
        issues.push(issue('option_unavailable', `规格组 ${groupId} 的选项 ${optionId} 当前不可选`, { groupId, optionId }));
      }
    }
  }

  // 逐组检查必选 / 数量上下限。按 groupId 排序保证稳定。
  const groupIds = [...groups.keys()].sort();
  for (const groupId of groupIds) {
    const entry = groups.get(groupId);
    if (entry === undefined) continue;
    const count = countByGroup.get(groupId) ?? 0;
    const { group } = entry;
    if (count === 0) {
      if (group.required) {
        issues.push(issue('required_group_missing', `必选规格组 ${groupId} 未选择`, { groupId }));
      }
      continue;
    }
    if (group.selectionMode === 'single') {
      if (count > 1) {
        issues.push(
          issue('single_group_multi_selected', `单选规格组 ${groupId} 只能选 1 个，实际选了 ${count} 个`, {
            groupId,
            limit: 1,
            actual: count,
          }),
        );
      }
      continue;
    }
    // multi
    if (count < group.minSelections) {
      issues.push(
        issue('too_few_selections', `规格组 ${groupId} 至少选 ${group.minSelections} 个，实际 ${count} 个`, {
          groupId,
          limit: group.minSelections,
          actual: count,
        }),
      );
    }
    if (count > group.maxSelections) {
      issues.push(
        issue('too_many_selections', `规格组 ${groupId} 最多选 ${group.maxSelections} 个，实际 ${count} 个`, {
          groupId,
          limit: group.maxSelections,
          actual: count,
        }),
      );
    }
  }

  const ordered = orderIssues(issues);
  return Object.freeze({ ok: ordered.length === 0, issues: ordered });
}

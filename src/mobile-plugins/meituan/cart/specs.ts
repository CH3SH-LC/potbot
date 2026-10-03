/**
 * 规格选择（`CartSpecSelection`）的规范化、比较与**必选 / 单选 / 多选**校验。
 *
 * 「同规格合并」必须与书写顺序无关：`[辣度=微辣, 份量=大份]` 与
 * `[份量=大份, 辣度=微辣]` 是同一份规格。因此所有规格一律先规范化
 * （按 `(groupId, optionId)` 排序、校验）再比较。
 *
 * ## 本次修复的真实缺陷（M-R02 请求 #3）
 *
 * 旧实现 `normalizeSpecs` 对**任何重复的 `groupId` 一律抛错**
 * （`同一组只能选一个选项`），既无法表达「多选规格组」（如「加料」可多选），
 * 也把「同一选项被选两次」与「同组两个不同选项（多选合法）」混为一谈。
 *
 * 现在：
 * - `validateSpecSelection(selections, groups)` 按**规格组定义**做完整校验，
 *   产出稳定的问题码：`required_group_missing`、`single_group_multi_selected`、
 *   `too_few_selections`、`too_many_selections`、`duplicate_option`、
 *   `unknown_group`、`unknown_option`（并可另报 `invalid_id` / `option_unavailable`）；
 * - `normalizeSpecs(specs, groups?)` 在**提供规格组定义**时走上述校验（支持多选），
 *   在**未提供定义**时保留向后兼容的保守默认：同组只能选一个（按单选处理）。
 *   单选的调用方（历史 M04 用例）不受影响。
 *
 * 输出顺序固定（先 `groupId`、再 `code`、再 `optionId`），保证同一输入永远得到同一结果。
 * 本模块是纯函数：不读时钟、不读随机数、不读环境。
 */

import { CartValidationError } from './errors.js';
import type { CartSpecSelection } from './types.js';

/** 规格组的选择方式。 */
export type SpecSelectionMode = 'single' | 'multi';

/** 规格组内的一个可选项定义（`available === false` 表示当前不可选）。 */
export interface SpecOptionDef {
  readonly optionId: string;
  readonly available?: boolean;
}

/**
 * 规格组定义（校验 `CartSpecSelection` 的规则来源）。
 *
 * 该类型与 M-R02 目录（`catalog/`，工作书 M-R02）的 SKU 规格组同构，
 * 但只保留校验所需的字段——本包不保存菜品目录，定义由调用方注入。
 */
export interface SpecGroupDef {
  readonly groupId: string;
  /** 是否必选；缺省视为非必选。 */
  readonly required?: boolean;
  /** 选择方式；缺省视为 `single`。 */
  readonly selectionMode?: SpecSelectionMode;
  /** 多选组最少选几个；缺省 0（仅 `multi` 生效）。 */
  readonly minSelections?: number;
  /** 多选组最多选几个；缺省不限（仅 `multi` 生效）。 */
  readonly maxSelections?: number;
  /** 该组的选项清单；**省略则不校验** `unknown_option` / `option_unavailable`。 */
  readonly options?: readonly SpecOptionDef[];
}

/** 规格校验问题码（稳定字符串，供上层映射到 UI/日志）。 */
export type SpecIssueCode =
  | 'invalid_id'
  | 'unknown_group'
  | 'unknown_option'
  | 'duplicate_option'
  | 'option_unavailable'
  | 'required_group_missing'
  | 'single_group_multi_selected'
  | 'too_few_selections'
  | 'too_many_selections';

/** 一条规格校验问题。`limit` / `actual` 仅在数量类问题上出现。 */
export interface SpecIssue {
  readonly code: SpecIssueCode;
  readonly message: string;
  readonly groupId?: string;
  readonly optionId?: string;
  readonly limit?: number;
  readonly actual?: number;
}

/** 规格校验结果。`ok === true` ⇔ `issues` 为空。 */
export interface SpecValidationResult {
  readonly ok: boolean;
  readonly issues: readonly SpecIssue[];
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CartValidationError(`${label} 不能为空`);
  }
  return value;
}

function issue(code: SpecIssueCode, message: string, extra: Partial<SpecIssue> = {}): SpecIssue {
  return { code, message, ...extra };
}

/** 问题排序的固定口径：`groupId` → `code` → `optionId`（缺省按空串参与比较）。 */
function orderIssues(issues: readonly SpecIssue[]): readonly SpecIssue[] {
  return Object.freeze(
    [...issues].sort((a, b) => {
      const aGroup = a.groupId ?? '';
      const bGroup = b.groupId ?? '';
      if (aGroup !== bGroup) return aGroup < bGroup ? -1 : 1;
      if (a.code !== b.code) return a.code < b.code ? -1 : 1;
      const aOption = a.optionId ?? '';
      const bOption = b.optionId ?? '';
      return aOption < bOption ? -1 : aOption > bOption ? 1 : 0;
    }),
  );
}

interface GroupIndex {
  readonly group: SpecGroupDef;
  readonly optionIds: ReadonlySet<string> | null;
  readonly optionAvailable: ReadonlyMap<string, boolean> | null;
}

function indexGroups(groups: readonly SpecGroupDef[]): ReadonlyMap<string, GroupIndex> {
  const map = new Map<string, GroupIndex>();
  for (const group of groups) {
    const groupId = requireNonEmpty(group.groupId, 'specGroup.groupId');
    if (map.has(groupId)) {
      throw new CartValidationError(`规格组 ${groupId} 重复定义`);
    }
    let optionIds: Set<string> | null = null;
    let optionAvailable: Map<string, boolean> | null = null;
    if (group.options !== undefined) {
      optionIds = new Set<string>();
      optionAvailable = new Map<string, boolean>();
      for (const option of group.options) {
        const optionId = requireNonEmpty(option.optionId, `规格组 ${groupId} 的 optionId`);
        if (optionIds.has(optionId)) {
          throw new CartValidationError(`规格组 ${groupId} 的选项 ${optionId} 重复定义`);
        }
        optionIds.add(optionId);
        optionAvailable.set(optionId, option.available !== false);
      }
    }
    map.set(groupId, { group, optionIds, optionAvailable });
  }
  return map;
}

/**
 * 校验一组规格选择是否符合给定的规格组定义。
 *
 * - 空 `groupId` / `optionId` ⇒ `invalid_id`；
 * - 引用了未定义的组 ⇒ `unknown_group`；组内有选项清单但选项不在其中 ⇒ `unknown_option`；
 * - 同组同选项出现两次 ⇒ `duplicate_option`（**只报一次、只计一次**）；
 * - 必选组为空 ⇒ `required_group_missing`；`single` 组选中 >1 ⇒ `single_group_multi_selected`；
 * - `multi` 组数量不在 `[minSelections, maxSelections]` ⇒ `too_few_selections` / `too_many_selections`；
 * - 选项 `available === false` ⇒ `option_unavailable`。
 *
 * 结果按固定口径排序（`groupId` → `code` → `optionId`）。本函数**不抛业务错误**：
 * 全部问题以 `issues` 返回；只有规格组**定义本身**非法（空/重复 id）才抛
 * `CartValidationError`（那是调用方的编程错误，不是用户选择的问题）。
 */
export function validateSpecSelection(
  selections: readonly CartSpecSelection[],
  groups: readonly SpecGroupDef[],
): SpecValidationResult {
  const indexed = indexGroups(groups);
  const issues: SpecIssue[] = [];
  const countByGroup = new Map<string, number>();
  const seenPairs = new Set<string>();
  const reportedUnknownGroups = new Set<string>();

  for (const selection of selections) {
    const groupId = selection.groupId;
    const optionId = selection.optionId;
    if (
      typeof groupId !== 'string' ||
      groupId.length === 0 ||
      typeof optionId !== 'string' ||
      optionId.length === 0
    ) {
      issues.push(issue('invalid_id', '规格选择的 groupId / optionId 不能为空', { groupId, optionId }));
      continue;
    }
    const entry = indexed.get(groupId);
    if (entry === undefined) {
      if (!reportedUnknownGroups.has(groupId)) {
        reportedUnknownGroups.add(groupId);
        issues.push(issue('unknown_group', `没有规格组 ${groupId}`, { groupId }));
      }
      continue;
    }
    if (entry.optionIds !== null && !entry.optionIds.has(optionId)) {
      issues.push(issue('unknown_option', `规格组 ${groupId} 没有选项 ${optionId}`, { groupId, optionId }));
      continue;
    }
    const pair = JSON.stringify([groupId, optionId]);
    if (seenPairs.has(pair)) {
      issues.push(issue('duplicate_option', `规格组 ${groupId} 的选项 ${optionId} 重复选择`, { groupId, optionId }));
      continue;
    }
    seenPairs.add(pair);
    countByGroup.set(groupId, (countByGroup.get(groupId) ?? 0) + 1);
    if (entry.optionAvailable !== null && entry.optionAvailable.get(optionId) === false) {
      issues.push(issue('option_unavailable', `规格组 ${groupId} 的选项 ${optionId} 当前不可选`, { groupId, optionId }));
    }
  }

  // 逐组检查必选 / 数量上下限。按 groupId 排序保证稳定。
  const groupIds = [...indexed.keys()].sort();
  for (const groupId of groupIds) {
    const entry = indexed.get(groupId);
    if (entry === undefined) continue;
    const count = countByGroup.get(groupId) ?? 0;
    const { group } = entry;
    if (count === 0) {
      if (group.required === true) {
        issues.push(issue('required_group_missing', `必选规格组 ${groupId} 未选择`, { groupId }));
      }
      continue;
    }
    if ((group.selectionMode ?? 'single') === 'single') {
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
    const minSelections = group.minSelections ?? 0;
    const maxSelections = group.maxSelections ?? Number.POSITIVE_INFINITY;
    if (count < minSelections) {
      issues.push(
        issue('too_few_selections', `规格组 ${groupId} 至少选 ${minSelections} 个，实际 ${count} 个`, {
          groupId,
          limit: minSelections,
          actual: count,
        }),
      );
    }
    if (count > maxSelections) {
      issues.push(
        issue('too_many_selections', `规格组 ${groupId} 最多选 ${maxSelections} 个，实际 ${count} 个`, {
          groupId,
          limit: maxSelections,
          actual: count,
        }),
      );
    }
  }

  const ordered = orderIssues(issues);
  return Object.freeze({ ok: ordered.length === 0, issues: ordered });
}

/** 规格排序口径：先 `groupId`，再 `optionId`（与书写顺序无关）。 */
function compareSpecSelections(a: CartSpecSelection, b: CartSpecSelection): number {
  if (a.groupId !== b.groupId) return a.groupId < b.groupId ? -1 : 1;
  if (a.optionId !== b.optionId) return a.optionId < b.optionId ? -1 : 1;
  return 0;
}

/**
 * 规范化规格：校验 + 排序。
 *
 * - `groupId` / `optionId` 必须是非空字符串（否则抛 `CartValidationError`）；
 * - **提供 `groups`** 时：走 `validateSpecSelection` 完整校验（支持 `multi` 多选组）；
 *   任一条不合法即抛 `CartValidationError`（附全部问题说明），**不静默修正**；
 * - **未提供 `groups`** 时：无法知道各组的 `selectionMode`，按保守默认处理——
 *   同一 `groupId` 不允许出现两次（按单选），这与历史的单选行为一致。
 *
 * 返回数组按 `(groupId, optionId)` 排序并冻结，因此「规范化后规格相同 ⇔ 规格相同」。
 */
export function normalizeSpecs(
  specs: readonly CartSpecSelection[] | undefined,
  groups?: readonly SpecGroupDef[],
): readonly CartSpecSelection[] {
  if (specs === undefined) return Object.freeze([]);
  const checked: CartSpecSelection[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    const groupId = requireNonEmpty(spec.groupId, 'spec.groupId');
    const optionId = requireNonEmpty(spec.optionId, 'spec.optionId');
    if (groups === undefined) {
      if (seen.has(groupId)) {
        throw new CartValidationError(
          `规格组 ${groupId} 重复出现；未提供规格组定义时按单选处理，同一组只能选一个选项`,
        );
      }
      seen.add(groupId);
    }
    checked.push({ groupId, optionId });
  }
  if (groups !== undefined) {
    const result = validateSpecSelection(checked, groups);
    if (!result.ok) {
      throw new CartValidationError(
        `规格选择不合法：${result.issues.map((entry) => entry.message).join('；')}`,
      );
    }
  }
  const normalized = [...checked].sort(compareSpecSelections);
  return Object.freeze(normalized);
}

/**
 * 规格的规范字符串（`groupId=optionId` 以 `&` 连接，已排序）。
 * 规范化后的规格，其规范字符串相同 ⇔ 规格相同。
 */
export function specsKey(specs: readonly CartSpecSelection[]): string {
  return specs.map((spec) => `${spec.groupId}=${spec.optionId}`).join('&');
}

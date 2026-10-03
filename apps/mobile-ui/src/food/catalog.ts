/**
 * F10 food / 选店卡、菜单卡、规格卡 —— **选项一律来自注入目录，绝不硬编码**。
 *
 * ## 为什么把目录单独建模
 *
 * M03（`catalog/`）尚未落地（`src/mobile-plugins/meituan/` 现只有 cart / address-delivery /
 * order-submit / order-lifecycle）。因此本模块**不**依赖 M03 的类型，而是定义一个
 * 最小的、与供应商无关的**目录视图入参**（`FoodStore` / `FoodMenuItem` / `FoodSpecGroup`），
 * 由接线者从 M03（或 fixture）映射填入。
 *
 * 关键纪律：**规格组与选项只存在于入参目录数据里**。本文件没有任何
 * 「辣度 = [微辣, 中辣, 特辣]」之类的常量表。因此「选项不硬编码」不是靠自觉，
 * 而是本模块**没有**那条代码路径——测试通过改写目录数据来断言卡片输出随之变化。
 *
 * 规格选择沿用 M04 的 `CartSpecSelection`（`{groupId, optionId}`），
 * 保证购物车（M04）与规格卡（F10）用同一套选择形状，不需要二次转换。
 */

import type { CartSpecSelection } from '../../../../src/mobile-plugins/meituan/cart/index.js';

import { toFoodMoneyView, type FoodMoneyView } from './money.js';
import type { FoodCardBase } from './types.js';

// ---------------------------------------------------------------------------
// 目录入参（供应商无关；由接线者从 M03 / fixture 填入）
// ---------------------------------------------------------------------------

/** 规格选项。`available` 由目录给出：不可用选项**显示为不可选**，而不是被隐藏。 */
export interface FoodSpecOption {
  readonly optionId: string;
  readonly label: string;
  readonly available: boolean;
}

/** 规格组。`required` 为真时该组必须选择，否则规格卡判为未完成。 */
export interface FoodSpecGroup {
  readonly groupId: string;
  readonly label: string;
  readonly required: boolean;
  /** **选项来自目录数据**；本模块不内置任何选项表。 */
  readonly options: readonly FoodSpecOption[];
}

/** 菜单菜品（一个可加入购物车的 SKU）。 */
export interface FoodMenuItem {
  readonly dishId: string;
  readonly skuId: string;
  readonly name: string;
  readonly description: string | null;
  readonly available: boolean;
  readonly specGroups: readonly FoodSpecGroup[];
}

/** 店铺及其菜单。金额为整数最小单位（分），与 M04 一致。 */
export interface FoodStore {
  readonly storeId: string;
  readonly name: string;
  readonly open: boolean;
  readonly minOrderMinor: number | null;
  readonly deliveryFeeMinor: number | null;
  readonly menu: readonly FoodMenuItem[];
}

// ---------------------------------------------------------------------------
// 规格选择校验
// ---------------------------------------------------------------------------

export type SpecViolationKind =
  | 'missing_required'
  | 'unknown_group'
  | 'unknown_option'
  | 'unavailable_option'
  | 'duplicate_group';

export interface SpecViolation {
  readonly groupId: string;
  readonly kind: SpecViolationKind;
  readonly detail: string;
}

export interface SpecValidation {
  readonly valid: boolean;
  readonly violations: readonly SpecViolation[];
  readonly detail: string;
}

function findGroup(item: FoodMenuItem, groupId: string): FoodSpecGroup | undefined {
  return item.specGroups.find((group) => group.groupId === groupId);
}

function findOption(group: FoodSpecGroup, optionId: string): FoodSpecOption | undefined {
  return group.options.find((option) => option.optionId === optionId);
}

/**
 * 校验一组规格选择是否满足菜品要求。
 *
 * 规则（全部显式，不静默修正）：
 * - 必选组缺失 ⇒ `missing_required`；
 * - 选择里的组不在菜品上 ⇒ `unknown_group`；
 * - 选择里的选项不在该组 ⇒ `unknown_option`；
 * - 选项存在但目录标为不可用 ⇒ `unavailable_option`；
 * - 同一组被选两次 ⇒ `duplicate_group`。
 */
export function validateSpecSelection(
  item: FoodMenuItem,
  selection: readonly CartSpecSelection[],
): SpecValidation {
  const violations: SpecViolation[] = [];
  const seenGroups = new Set<string>();

  for (const spec of selection) {
    if (seenGroups.has(spec.groupId)) {
      violations.push({
        groupId: spec.groupId,
        kind: 'duplicate_group',
        detail: `规格组 ${spec.groupId} 被选择多次；一组只能选一个选项`,
      });
      continue;
    }
    seenGroups.add(spec.groupId);
    const group = findGroup(item, spec.groupId);
    if (group === undefined) {
      violations.push({
        groupId: spec.groupId,
        kind: 'unknown_group',
        detail: `菜品 ${item.dishId} 没有规格组 ${spec.groupId}`,
      });
      continue;
    }
    const option = findOption(group, spec.optionId);
    if (option === undefined) {
      violations.push({
        groupId: spec.groupId,
        kind: 'unknown_option',
        detail: `规格组 ${spec.groupId} 没有选项 ${spec.optionId}`,
      });
      continue;
    }
    if (!option.available) {
      violations.push({
        groupId: spec.groupId,
        kind: 'unavailable_option',
        detail: `规格选项 ${spec.groupId}=${spec.optionId} 当前不可用`,
      });
    }
  }

  for (const group of item.specGroups) {
    if (group.required && !seenGroups.has(group.groupId)) {
      violations.push({
        groupId: group.groupId,
        kind: 'missing_required',
        detail: `必选规格组 ${group.label}（${group.groupId}）尚未选择`,
      });
    }
  }

  const valid = violations.length === 0;
  return Object.freeze({
    valid,
    violations: Object.freeze(violations),
    detail: valid
      ? '规格选择满足菜品要求'
      : `规格选择不完整（${violations.length} 处）：${violations.map((v) => v.detail).join('；')}`,
  });
}

// ---------------------------------------------------------------------------
// 规格卡
// ---------------------------------------------------------------------------

export interface SpecOptionView {
  readonly optionId: string;
  readonly label: string;
  readonly available: boolean;
  readonly selected: boolean;
}

export interface SpecGroupView {
  readonly groupId: string;
  readonly label: string;
  readonly required: boolean;
  readonly selectedOptionId: string | null;
  readonly options: readonly SpecOptionView[];
}

export interface SpecCardView extends FoodCardBase {
  readonly kind: 'spec';
  readonly dishId: string;
  readonly skuId: string;
  readonly dishName: string;
  readonly groups: readonly SpecGroupView[];
  /** 规格是否已满足要求（== `validation.valid`）。 */
  readonly complete: boolean;
  readonly validation: SpecValidation;
  /**
   * 建议初始选择：每个**必选**组取**目录里第一个可用的**选项；无可选项的必选组留空。
   *
   * 这是纯粹的展示便利（确定性、只从目录推导），**不是**替用户拍板：
   * 它随目录变化而变化（测试用改写目录来证明），且可选项为零时不会凭空造一个。
   */
  readonly suggestedSelection: readonly CartSpecSelection[];
}

/**
 * 构造规格卡。选项与必选性**全部**来自 `item.specGroups`。
 */
export function buildSpecCard(item: FoodMenuItem, selection: readonly CartSpecSelection[] = []): SpecCardView {
  const selectedByGroup = new Map<string, string>();
  for (const spec of selection) {
    if (!selectedByGroup.has(spec.groupId)) {
      selectedByGroup.set(spec.groupId, spec.optionId);
    }
  }

  const groups: SpecGroupView[] = item.specGroups.map((group) =>
    Object.freeze({
      groupId: group.groupId,
      label: group.label,
      required: group.required,
      selectedOptionId: selectedByGroup.get(group.groupId) ?? null,
      options: Object.freeze(
        group.options.map((option) =>
          Object.freeze({
            optionId: option.optionId,
            label: option.label,
            available: option.available,
            selected: selectedByGroup.get(group.groupId) === option.optionId,
          }),
        ),
      ),
    }),
  );

  const validation = validateSpecSelection(item, selection);

  const suggested: CartSpecSelection[] = [];
  for (const group of item.specGroups) {
    if (!group.required) continue;
    const firstAvailable = group.options.find((option) => option.available);
    if (firstAvailable !== undefined) {
      suggested.push(Object.freeze({ groupId: group.groupId, optionId: firstAvailable.optionId }));
    }
  }

  return Object.freeze({
    kind: 'spec',
    title: `规格：${item.name}`,
    dishId: item.dishId,
    skuId: item.skuId,
    dishName: item.name,
    groups: Object.freeze(groups),
    complete: validation.valid,
    validation,
    suggestedSelection: Object.freeze(suggested),
  });
}

// ---------------------------------------------------------------------------
// 选店卡 / 菜单卡
// ---------------------------------------------------------------------------

export interface StoreCardView extends FoodCardBase {
  readonly kind: 'store';
  readonly storeId: string;
  readonly name: string;
  readonly open: boolean;
  readonly minOrder: FoodMoneyView | null;
  readonly deliveryFee: FoodMoneyView | null;
  readonly itemCount: number;
  readonly availableItemCount: number;
}

/** 构造选店卡。金额（起送价 / 配送费）为 `null` 时**不补零**，显式缺失。 */
export function buildStoreCard(store: FoodStore, currency: string): StoreCardView {
  const availableItemCount = store.menu.filter((item) => item.available).length;
  return Object.freeze({
    kind: 'store',
    title: store.name,
    storeId: store.storeId,
    name: store.name,
    open: store.open,
    minOrder: store.minOrderMinor === null ? null : toFoodMoneyView(store.minOrderMinor, currency),
    deliveryFee: store.deliveryFeeMinor === null ? null : toFoodMoneyView(store.deliveryFeeMinor, currency),
    itemCount: store.menu.length,
    availableItemCount,
  });
}

export interface MenuItemView {
  readonly dishId: string;
  readonly skuId: string;
  readonly name: string;
  readonly description: string | null;
  readonly available: boolean;
  /** 是否有必选规格（有则需要先过规格卡）。 */
  readonly requiresSpecSelection: boolean;
  readonly specGroupCount: number;
}

export interface MenuCardView extends FoodCardBase {
  readonly kind: 'menu';
  readonly storeId: string;
  readonly storeName: string;
  readonly items: readonly MenuItemView[];
}

export function buildMenuCard(store: FoodStore): MenuCardView {
  return Object.freeze({
    kind: 'menu',
    title: `菜单：${store.name}`,
    storeId: store.storeId,
    storeName: store.name,
    items: Object.freeze(
      store.menu.map((item) =>
        Object.freeze({
          dishId: item.dishId,
          skuId: item.skuId,
          name: item.name,
          description: item.description,
          available: item.available,
          requiresSpecSelection: item.specGroups.some((group) => group.required),
          specGroupCount: item.specGroups.length,
        }),
      ),
    ),
  });
}

/** 按 `dishId` 取菜品；不存在返回 `null`（不猜、不造）。 */
export function menuItemById(store: FoodStore, dishId: string): FoodMenuItem | null {
  return store.menu.find((item) => item.dishId === dishId) ?? null;
}

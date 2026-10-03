/**
 * F10 food / 购物车卡 —— 消费 M04 `CartState`，并**显式声明本地没有价格**。
 *
 * 购物车在 M04 里刻意不保存任何金额（价格只能来自 `QuotePort`）。本卡因此
 * 也只呈现「选了什么、几件、地址是否已定」，`hasLocalPrice` 恒为字面量 `false`，
 * 从类型层面挡住「在购物车卡上顺手算个总价」的写法。
 *
 * 菜名 / 规格名是**目录展示信息**，由调用方以标签表注入（F10 不持有目录本体）；
 * 标签缺失时显式留空串，不伪造名称。
 */

import type { CartState } from '../../../../src/mobile-plugins/meituan/cart/index.js';

import type { FoodCardBase } from './types.js';

export interface CartSpecView {
  readonly groupId: string;
  readonly optionId: string;
  /** 展示名；未提供标签表时为空串（不猜测、不编造）。 */
  readonly label: string;
}

export interface CartLineView {
  readonly lineId: string;
  readonly dishId: string;
  /** 菜品展示名；未提供标签表时为空串。 */
  readonly dishLabel: string;
  readonly skuId: string;
  readonly specs: readonly CartSpecView[];
  readonly quantity: number;
}

export interface CartCardView extends FoodCardBase {
  readonly kind: 'cart';
  readonly merchantId: string;
  readonly currency: string;
  /** M04 购物车的实质变更计数（无操作不计）。 */
  readonly revision: number;
  readonly items: readonly CartLineView[];
  /** 条目数（不同规格各算一条）。 */
  readonly itemCount: number;
  /** 总件数（数量求和）。 */
  readonly totalQuantity: number;
  readonly hasDeliveryAddress: boolean;
  readonly addressRef: string | null;
  readonly isEmpty: boolean;
  /** 恒为 `false`：本地购物车**不产生**任何价格。 */
  readonly hasLocalPrice: false;
  readonly note: string;
}

export interface BuildCartCardInput {
  readonly cart: CartState;
  /** `dishId` → 展示名。 */
  readonly dishLabels?: Readonly<Record<string, string>>;
  /** `` `${groupId}=${optionId}` `` → 展示名。 */
  readonly specLabels?: Readonly<Record<string, string>>;
}

/** 构造购物车卡。金额一律**不出现**在卡上。 */
export function buildCartCard(input: BuildCartCardInput): CartCardView {
  const { cart } = input;
  const dishLabels = input.dishLabels ?? {};
  const specLabels = input.specLabels ?? {};
  const lines = cart.lines;

  const items: CartLineView[] = lines.map((line) =>
    Object.freeze({
      lineId: line.lineId,
      dishId: line.dishId,
      dishLabel: dishLabels[line.dishId] ?? '',
      skuId: line.skuId,
      specs: Object.freeze(
        line.specs.map((spec) =>
          Object.freeze({
            groupId: spec.groupId,
            optionId: spec.optionId,
            label: specLabels[`${spec.groupId}=${spec.optionId}`] ?? '',
          }),
        ),
      ),
      quantity: line.quantity,
    }),
  );

  const totalQuantity = lines.reduce((total, line) => total + line.quantity, 0);
  const delivery = cart.delivery;

  return Object.freeze({
    kind: 'cart',
    title: '购物车',
    merchantId: cart.merchantId,
    currency: cart.currency,
    revision: cart.revision,
    items: Object.freeze(items),
    itemCount: items.length,
    totalQuantity,
    hasDeliveryAddress: delivery !== null,
    addressRef: delivery === null ? null : delivery.addressRef,
    isEmpty: items.length === 0,
    hasLocalPrice: false,
    note: '本地购物车只保存规格与数量；价格与优惠只能来自报价（M04 QuotePort）。',
  });
}

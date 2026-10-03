/**
 * M-R03 报价差异计算：给定「旧报价 / 新报价」，产出结构化、可重现的差异。
 *
 * ## 为什么不逐字段 `===` 比较
 *
 * 逐字段比较容易漏：费用/优惠是**数组**，同码可能多条；条目顺序可能不同；
 * 缺失的一侧该记 0 还是 `null`？因此这里统一按**语义键**聚合：
 * - 条目按 `lineId`；
 * - 费用/优惠按 `code`（同码先求和再比较）。
 *
 * ## 本地只比对，不重算
 *
 * 本模块**从不**根据 `unitAmountMinor × quantity` 生成「正确的总价」去覆盖端口的
 * `amount`。它只报告「`amount` 变了多少」「哪笔费用变了多少」。任何金额不是整数
 * 最小单位时直接抛 {@link PriceDiffError}，不四舍五入。
 *
 * 纯函数：不读时钟、不读随机数、不读环境。
 */

import { isValidMinorUnits } from '../cart/index.js';
import type { Quote } from '../cart/index.js';
import { PriceDiffError } from './errors.js';
import { QUOTE_CHANGE_KIND_ORDER } from './types.js';
import type {
  DiscountDelta,
  FeeDelta,
  ItemPriceDelta,
  QuoteChangeKind,
  QuotePriceDiff,
} from './types.js';

/** 一条费用/优惠的原始形状（`QuoteFee` 与 `QuoteDiscount` 结构相同）。 */
interface CodeEntry {
  readonly code: string;
  readonly label: string;
  readonly amountMinor: number;
}

interface CodeTotal {
  label: string;
  total: number;
}

function requireMinor(value: number, label: string): number {
  if (!isValidMinorUnits(value)) {
    throw new PriceDiffError(`${label} 不是合法的整数最小单位：${String(value)}`);
  }
  return value;
}

function collectByCode(entries: readonly CodeEntry[], kind: string): Map<string, CodeTotal> {
  const totals = new Map<string, CodeTotal>();
  for (const entry of entries) {
    requireMinor(entry.amountMinor, `${kind}[${entry.code}]`);
    const existing = totals.get(entry.code);
    if (existing === undefined) {
      totals.set(entry.code, { label: entry.label, total: entry.amountMinor });
    } else {
      existing.total += entry.amountMinor;
    }
  }
  return totals;
}

/** 按 `code` 求并集后逐码求差。缺失码用 `null` 标记（不补 0）。 */
function buildCodeDeltas(previous: readonly CodeEntry[], next: readonly CodeEntry[], kind: string): readonly FeeDelta[] {
  const prevTotals = collectByCode(previous, `${kind}.previous`);
  const nextTotals = collectByCode(next, `${kind}.next`);
  const codes = [...new Set([...prevTotals.keys(), ...nextTotals.keys()])].sort();
  const deltas: FeeDelta[] = [];
  for (const code of codes) {
    const prev = prevTotals.get(code);
    const nxt = nextTotals.get(code);
    const previousAmountMinor = prev === undefined ? null : prev.total;
    const nextAmountMinor = nxt === undefined ? null : nxt.total;
    deltas.push(
      Object.freeze({
        code,
        label: (nxt ?? prev)?.label ?? code,
        previousAmountMinor,
        nextAmountMinor,
        deltaMinor: (nextAmountMinor ?? 0) - (previousAmountMinor ?? 0),
      }),
    );
  }
  return Object.freeze(deltas);
}

/**
 * 计算 `next - previous` 的结构化差异。
 *
 * @throws {PriceDiffError} 任一侧的关键金额不是整数最小单位时。
 */
export function diffQuotes(previous: Quote, next: Quote): QuotePriceDiff {
  requireMinor(previous.amount, `previous[${previous.quoteRef}].amount`);
  requireMinor(next.amount, `next[${next.quoteRef}].amount`);
  requireMinor(previous.subtotalMinor, `previous[${previous.quoteRef}].subtotalMinor`);
  requireMinor(next.subtotalMinor, `next[${next.quoteRef}].subtotalMinor`);

  const rawKinds: QuoteChangeKind[] = [];

  if (previous.currency !== next.currency) rawKinds.push('currency_changed');

  const prevItems = new Map(previous.items.map((item) => [item.lineId, item]));
  const nextItems = new Map(next.items.map((item) => [item.lineId, item]));
  const lineIds = [...new Set([...prevItems.keys(), ...nextItems.keys()])].sort();

  const items: ItemPriceDelta[] = [];
  let itemSetChanged = false;
  let quantityChanged = false;
  let unitPriceChanged = false;

  for (const lineId of lineIds) {
    const prev = prevItems.get(lineId);
    const nxt = nextItems.get(lineId);
    if (prev === undefined || nxt === undefined) itemSetChanged = true;
    if (prev !== undefined && nxt !== undefined) {
      requireMinor(prev.unitAmountMinor, `previous item ${lineId}.unitAmountMinor`);
      requireMinor(nxt.unitAmountMinor, `next item ${lineId}.unitAmountMinor`);
      if (prev.quantity !== nxt.quantity) quantityChanged = true;
      if (prev.unitAmountMinor !== nxt.unitAmountMinor) unitPriceChanged = true;
    }
    const previousLineAmountMinor =
      prev === undefined ? 0 : requireMinor(prev.lineAmountMinor, `previous item ${lineId}.lineAmountMinor`);
    const nextLineAmountMinor =
      nxt === undefined ? 0 : requireMinor(nxt.lineAmountMinor, `next item ${lineId}.lineAmountMinor`);
    items.push(
      Object.freeze({
        lineId,
        dishId: (nxt ?? prev)?.dishId ?? null,
        skuId: (nxt ?? prev)?.skuId ?? null,
        previousQuantity: prev?.quantity ?? null,
        nextQuantity: nxt?.quantity ?? null,
        previousUnitAmountMinor: prev?.unitAmountMinor ?? null,
        nextUnitAmountMinor: nxt?.unitAmountMinor ?? null,
        previousLineAmountMinor,
        nextLineAmountMinor,
        deltaMinor: nextLineAmountMinor - previousLineAmountMinor,
      }),
    );
  }

  if (itemSetChanged) rawKinds.push('item_set_changed');
  if (quantityChanged) rawKinds.push('quantity_changed');
  if (unitPriceChanged) rawKinds.push('unit_price_changed');

  const fees = buildCodeDeltas(previous.fees, next.fees, 'fee');
  if (fees.some((fee) => fee.deltaMinor !== 0)) rawKinds.push('fee_changed');

  const discounts = buildCodeDeltas(previous.discounts, next.discounts, 'discount');
  if (discounts.some((discount) => discount.deltaMinor !== 0)) rawKinds.push('discount_changed');

  const amountDeltaMinor = next.amount - previous.amount;
  if (amountDeltaMinor !== 0) rawKinds.push('amount_changed');

  const changedKinds = QUOTE_CHANGE_KIND_ORDER.filter((kind) => rawKinds.includes(kind));

  return Object.freeze({
    previousQuoteRef: previous.quoteRef,
    nextQuoteRef: next.quoteRef,
    sameParamsDigest: previous.paramsDigest === next.paramsDigest,
    sameMerchant: previous.merchantId === next.merchantId,
    currency: next.currency,
    changed: changedKinds.length > 0,
    changedKinds: Object.freeze(changedKinds),
    previousAmountMinor: previous.amount,
    nextAmountMinor: next.amount,
    amountDeltaMinor,
    subtotalDeltaMinor: next.subtotalMinor - previous.subtotalMinor,
    items: Object.freeze(items),
    fees,
    discounts: Object.freeze(discounts),
  });
}

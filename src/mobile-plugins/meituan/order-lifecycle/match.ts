/**
 * externalId / 账号 / 金额 / 币种与本地下单意图的**匹配校验**。
 *
 * ## 为什么必须逐项对
 *
 * 查询接口本身不知道「我方要跟踪的是哪一单」：给它一个 externalId，它就会
 * 如实返回那一单。因此**本地必须自己核对**，否则会出现：
 * - 拿 A 账号的单去核验 B 账号的意图；
 * - 平台回执金额与我方确认金额不同（改价、优惠变化、甚至错单），
 *   却被当成「就是这一单」继续跟踪。
 *
 * 任一项不符 ⇒ 返回 `matched: false` 并列出全部不符字段；
 * 跟踪器（`./lifecycle.ts`）在此之上**停止跟踪**，绝不「大概就是它」。
 *
 * ## 关于金额
 *
 * 金额比较是**整数最小单位的严格相等**，不做容差、不做四舍五入。
 * 差一分就是不匹配。
 */

import type { OrderIntent, OrderMatch, OrderMismatchField, OrderQueryResult } from './types.js';

/** 匹配字段的固定顺序（便于验收逐条比对）。 */
export const ORDER_MATCH_FIELD_ORDER: readonly OrderMismatchField[] = Object.freeze([
  'external_id',
  'account',
  'amount',
  'currency',
]);

const FIELD_DETAIL: Readonly<Record<OrderMismatchField, (result: OrderQueryResult, intent: OrderIntent) => string>> =
  Object.freeze({
    external_id: (result, intent) =>
      intent.externalId === null
        ? `本地意图没有 externalId（本地还没有可核验的下单回执），查询返回 ${result.externalId}：不得凭猜测跟踪`
        : `externalId 不符：意图 ${intent.externalId}，查询结果 ${result.externalId}`,
    account: (result, intent) => `账号引用不符：意图 ${intent.accountRef}，查询结果 ${result.accountRef}`,
    amount: (result, intent) =>
      `金额不符：意图 ${intent.amountMinor}（最小单位），查询结果 ${result.amountMinor}（最小单位）；不做容差`,
    currency: (result, intent) => `币种不符：意图 ${intent.currency}，查询结果 ${result.currency}`,
  });

/**
 * 判定查询结果是否与本地下单意图一致。
 *
 * @returns `matched === true` 当且仅当四个字段全部相符（`fields` 为空数组）。
 */
export function matchOrderToIntent(result: OrderQueryResult, intent: OrderIntent): OrderMatch {
  const mismatched: OrderMismatchField[] = [];
  if (intent.externalId === null || intent.externalId !== result.externalId) {
    mismatched.push('external_id');
  }
  if (intent.accountRef !== result.accountRef) {
    mismatched.push('account');
  }
  if (intent.amountMinor !== result.amountMinor) {
    mismatched.push('amount');
  }
  if (intent.currency !== result.currency) {
    mismatched.push('currency');
  }
  const fields = ORDER_MATCH_FIELD_ORDER.filter((field) => mismatched.includes(field));
  const detail =
    fields.length === 0
      ? 'externalId / 账号 / 金额 / 币种四项与本地意图全部相符'
      : fields.map((field) => FIELD_DETAIL[field](result, intent)).join('；');
  return Object.freeze({ matched: fields.length === 0, fields: Object.freeze(fields), detail });
}

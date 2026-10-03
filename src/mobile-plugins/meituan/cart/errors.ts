/**
 * M04 购物车与报价模型 —— 错误类型。
 *
 * 纪律：所有失败都**显式抛出**，绝不静默吞掉或「顺手修正」。
 * 尤其是计价端口返回的数字对不上时，本地只允许报错（`QuoteIntegrityError`），
 * 不允许替端口重算一个「正确的」金额——那等于本地算价。
 */

import type { QuoteStaleReason } from './types.js';

/** 本包全部错误的基类。 */
export class CartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CartError';
  }
}

/** 入参/状态不合法（空 id、非法数量、缺少配送地址等）。 */
export class CartValidationError extends CartError {
  constructor(message: string) {
    super(message);
    this.name = 'CartValidationError';
  }
}

/** 端口无法给出报价（fixture 里的未知 SKU、故障注入等）。 */
export class QuotePortError extends CartError {
  constructor(message: string) {
    super(message);
    this.name = 'QuotePortError';
  }
}

/**
 * 报价与请求/条目不一致。**这不是本地要修的东西，而是必须上报的证据**：
 * 币种不符、条目不对应、金额非整数、`amount ≠ subtotal - 折扣 + 费用`、指纹未回显等。
 */
export class QuoteIntegrityError extends CartError {
  /** 逐条违规说明（便于验收看到具体哪里不符）。 */
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(`报价与请求不一致（${violations.length} 处）：${violations.join('；')}`);
    this.name = 'QuoteIntegrityError';
    this.violations = Object.freeze([...violations]);
  }
}

/** 旧报价已失效（参数变化 / 过期 / 被取代 / 被显式作废）。 */
export class QuoteStaleError extends CartError {
  readonly quoteRef: string;
  readonly reasons: readonly QuoteStaleReason[];

  constructor(quoteRef: string, reasons: readonly QuoteStaleReason[], detail: string) {
    super(`报价 ${quoteRef} 已失效（${reasons.join(' / ')}）：${detail}`);
    this.name = 'QuoteStaleError';
    this.quoteRef = quoteRef;
    this.reasons = Object.freeze([...reasons]);
  }
}

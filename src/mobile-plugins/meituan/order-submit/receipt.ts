/**
 * M07 可信回执签发（零依赖）。
 *
 * 回执是"外部世界对我们说的话"。与 K07 一致，它**只能**由本模块的受控签发器产生：
 * 客户端 / 模型自造一个 `{ observedState: 'confirmed' }` 对象无效
 * （`untrusted_order_receipt`）——否则"查原单确认"就退化成一个可被冒充的布尔值。
 *
 * 契约不变量照抄：`verificationMode: 'fixture'` 的回执**不得**报 `confirmed`。
 * 本包内没有真实平台，`real` 模式仅用于在判定链路上验证"可信回执可确认"这一分支；
 * 它**不代表**任何真实平台已接通。
 */

import { OrderSubmitError } from './errors.js';
import type { OrderReceipt } from './types.js';

const TRUSTED_ORDER_RECEIPTS = new WeakSet<object>();

export const ORDER_RECEIPT_STATES = ['confirmed', 'rejected', 'unknown'] as const;

export type OrderReceiptState = (typeof ORDER_RECEIPT_STATES)[number];

export const ORDER_VERIFICATION_MODES = ['fixture', 'real'] as const;

/**
 * 受控签发一张回执。**可信的唯一入口**。
 *
 * - 未登记的 `observedState` / `verificationMode` ⇒ `untrusted_order_receipt`；
 * - `fixture` + `confirmed` ⇒ `fixture_receipt_cannot_confirm`（契约不变量）。
 */
export function createOrderReceipt(input: {
  readonly idempotencyKey: string;
  readonly providerOrderRef: string;
  readonly observedState: OrderReceiptState;
  readonly observedAt: number;
  readonly verificationMode: 'fixture' | 'real';
  readonly detail?: string;
}): OrderReceipt {
  if (input === null || typeof input !== 'object') {
    throw new OrderSubmitError('untrusted_order_receipt', '回执必须是对象');
  }
  if (!(ORDER_RECEIPT_STATES as readonly string[]).includes(input.observedState)) {
    throw new OrderSubmitError(
      'untrusted_order_receipt',
      `回执回报的状态必须是 ${ORDER_RECEIPT_STATES.join(' / ')} 之一，收到 ${String(input.observedState)}`,
    );
  }
  if (!(ORDER_VERIFICATION_MODES as readonly string[]).includes(input.verificationMode)) {
    throw new OrderSubmitError(
      'untrusted_order_receipt',
      `回执必须标明 verificationMode（${ORDER_VERIFICATION_MODES.join(' / ')}），收到 ${String(input.verificationMode)}`,
    );
  }
  if (input.verificationMode === 'fixture' && input.observedState === 'confirmed') {
    throw new OrderSubmitError(
      'fixture_receipt_cannot_confirm',
      'verificationMode=fixture 的回执不得回报 confirmed：假端口不得签发"真实下单完成"' +
        '（契约 external-receipt.schema.json 的不变量）',
    );
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    throw new OrderSubmitError('untrusted_order_receipt', '回执必须携带非空 idempotencyKey');
  }
  if (typeof input.providerOrderRef !== 'string' || input.providerOrderRef.length === 0) {
    throw new OrderSubmitError('untrusted_order_receipt', '回执必须携带非空 providerOrderRef');
  }
  if (!Number.isSafeInteger(input.observedAt)) {
    throw new OrderSubmitError('untrusted_order_receipt', `observedAt 必须是安全整数，收到 ${JSON.stringify(input.observedAt)}`);
  }
  const receipt: OrderReceipt = Object.freeze({
    idempotencyKey: input.idempotencyKey,
    providerOrderRef: input.providerOrderRef,
    observedState: input.observedState,
    observedAt: input.observedAt,
    verificationMode: input.verificationMode,
    detail: input.detail ?? '',
  });
  TRUSTED_ORDER_RECEIPTS.add(receipt);
  return receipt;
}

/** 该回执是否由受控签发器产生。 */
export function isTrustedOrderReceipt(value: unknown): value is OrderReceipt {
  return typeof value === 'object' && value !== null && TRUSTED_ORDER_RECEIPTS.has(value);
}

/**
 * M05 → M04 桥接：把地址版本引用喂给购物车/报价模型的配送参数。
 *
 * 这里**只读复用** M04 的类型 `QuoteRequestDelivery`（`../cart/types.js`）。
 * 桥接的要点：M04 的 `paramsDigest` 覆盖 `delivery.addressRef`，而 M05 的
 * `AddressRecord.ref` 含版本 ⇒ 地址一改，引用就变，M04 的指纹随之变化，
 * 旧报价与旧确认**必然**被判失效。M05 与 M04 的失效判定因此互相印证。
 */

import type { QuoteRequestDelivery } from '../cart/types.js';

import type { AddressBinding, AddressRecord } from './types.js';

/** 由地址记录构造 M04 的配送参数（只带引用，不带明文）。 */
export function toQuoteRequestDelivery(record: AddressRecord): QuoteRequestDelivery {
  return Object.freeze({ addressRef: record.ref });
}

/** 由地址绑定构造 M04 的配送参数（用于「按绑定状态重放请求」的对照）。 */
export function bindingToQuoteRequestDelivery(binding: AddressBinding): QuoteRequestDelivery {
  return Object.freeze({ addressRef: binding.addressRef });
}

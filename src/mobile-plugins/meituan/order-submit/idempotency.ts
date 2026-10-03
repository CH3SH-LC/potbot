/**
 * M07 幂等键与提交请求构造（零依赖、纯函数、确定性）。
 *
 * ## 幂等键为什么必须是**绑定**的确定性函数
 *
 * "双击 / 超时重试 / 进程重启不得重复下单"要成立，前提是**两次提交算出同一个键**。
 * 若键由调用方随手给（时间戳、随机数、自增计数器），重启后必然不同，
 * 幂等就退化成一纸空谈。因此这里把键定义为**九项绑定的结构指纹**：
 * 只要授权绑定不变，任何时刻、任何进程算出的键都相同。
 *
 * 键的载荷**不含** `issuedAt` / `expiresAt` / `consumedAt` 等与"何时"有关的字段——
 * 它们不影响"这是哪一单"，放进键里反而会让同一单在不同时刻得到不同的键。
 *
 * > 指纹是**结构指纹**（FNV-1a 32 位，口径与 M04 `digest.ts` 一致），
 * > 用于一致性与幂等判定，**不是**密码学摘要，不用于任何安全用途。
 */

import { fnv1a32Hex } from '../cart/digest.js';
import { OrderSubmitError } from './errors.js';
import { assertTrustedAuthorizationRef, bindingOf } from './authorization.js';
import type { AuthorizationRef, OrderBinding, OrderSubmitRequest } from './types.js';

/** 幂等键前缀（便于将来换算法时区分）。 */
export const IDEMPOTENCY_KEY_PREFIX = 'idem-v1';

/** 键的规范载荷（纯文本、可重现、与对象键序无关）。 */
export function canonicalIdempotencyPayload(binding: OrderBinding): string {
  return JSON.stringify([
    binding.actionId,
    binding.merchantId,
    binding.accountRef,
    binding.taskRevision,
    binding.paramsDigest,
    binding.quoteRef,
    binding.amount,
    binding.currency,
    binding.scope,
  ]);
}

/** 由绑定确定性导出幂等键。同一绑定 ⇒ 同一键（重启 / 双击 / 重试都一致）。 */
export function computeIdempotencyKey(binding: OrderBinding): string {
  return `${IDEMPOTENCY_KEY_PREFIX}-${fnv1a32Hex(canonicalIdempotencyPayload(binding))}`;
}

/**
 * 构造提交请求。
 *
 * 请求**必须**同时携带三样东西，缺一不可：
 * - `idempotencyKey`：由绑定导出（本函数直接写入，不接受外部覆盖）；
 * - `authorizationRef`：K07 语义的一次性授权引用（**必须可信**，否则本函数即抛）；
 * - `paramsDigest`：参数摘要（来自绑定）。
 *
 * 不接受"事后补一个键"：`at` 只作为 `requestedAt` 记录，不参与键。
 */
export function buildOrderSubmitRequest(
  authorization: AuthorizationRef,
  at: number,
  attempt = 1,
): OrderSubmitRequest {
  const ref = assertTrustedAuthorizationRef(authorization);
  if (!Number.isSafeInteger(at)) {
    throw new OrderSubmitError('invalid_submit_request', `requestedAt 必须是安全整数，收到 ${JSON.stringify(at)}`);
  }
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new OrderSubmitError('invalid_submit_request', `attempt 必须是正整数，收到 ${JSON.stringify(attempt)}`);
  }
  const binding = bindingOf(ref);
  return Object.freeze({
    ...binding,
    grantId: ref.grantId,
    idempotencyKey: computeIdempotencyKey(binding),
    authorizationRef: ref,
    attempt,
    requestedAt: at,
  });
}

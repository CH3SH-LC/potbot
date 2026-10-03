/**
 * **运行中撤权**（KRN-08；能力目录 KRN-08、R244「运行中撤权」）。
 *
 * 三条被冻结的语义（原文口径）：
 * 1. **撤权前已发出的调用不追回**——`revocationEffectOnCall()` 对"调用早于撤权"返回
 *    `predates`，且 `isCallRecalled()` **恒为字面量 `false`**：内核**无法表达**"已发出的调用被追回"。
 * 2. **撤回后第一步即被拒**——调用发起时刻 `>=` 撤权时刻的那条调用，在**第一次**权限判定就被拒
 *    （判据在 `./permission-check.js` 里落地，本文件只给"是否受影响"与"受影响的方式"）。
 * 3. **撤权是权威状态**——`resolveAuthorizationValidity()` **先看撤权**：只要存在一条权威撤权记录
 *    且已生效，即便缓存写着 `cached_valid: true`、令牌 `token_expires_at` 还没到，也**一律判为失效**。
 *    过期令牌 / 陈旧缓存**不能掩盖**撤权（反过来也一样：撤权与否只看撤权台账，不受缓存影响）。
 *
 * 什么是**权威**撤权：`authority ∈ {kernel, user}`。外部页面/文件里写的"授权已撤销"是 `external`，
 * 与"外部假批准"对称——它**改变不了**授权状态（`revokeAuthorization()` 直接大声拒绝）。
 */

import { ValidationError, type LogicalTime, type TrustLabel } from '../protocol/index.js';
import { isTrustedAuthorizationSource } from './authorization-provenance.js';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export const REVOCATION_REJECTION_REASONS = [
  /** 撤权记录没有 id——撤权必须可指名追溯。 */
  'empty_revocation_id',
  /** 撤权没有指明针对哪份授权（`grant_id` 为空）。 */
  'empty_grant_id',
  /**
   * 撤权权威不是可信来源——外部页面/实例**无权**撤权；
   * 把它当撤权处理就是让"外部声明"改写了权威状态（与"假批准无效"对称）。
   */
  'untrusted_revocation_authority',
] as const;
export type RevocationRejectionReason = (typeof REVOCATION_REJECTION_REASONS)[number];

export class AuthorizationRevocationError extends ValidationError {
  readonly reason: RevocationRejectionReason;

  constructor(reason: RevocationRejectionReason, message: string) {
    super(message);
    this.name = 'AuthorizationRevocationError';
    this.reason = reason;
  }
}

export function isAuthorizationRevocationError(error: unknown): error is AuthorizationRevocationError {
  return error instanceof AuthorizationRevocationError;
}

// ---------------------------------------------------------------------------
// 撤权台账
// ---------------------------------------------------------------------------

export interface RevokeAuthorizationInput {
  readonly revocation_id: string;
  /** 针对哪份授权（授权身份 grant_id，跨 revision）。 */
  readonly grant_id: string;
  /** 撤权生效时刻。 */
  readonly revoked_at: LogicalTime;
  /** 撤权权威（必须是可信来源：`kernel` / `user`）。 */
  readonly authority: TrustLabel;
  /** 权威的稳定标识（谁撤的）。 */
  readonly authority_ref: string;
  readonly reason?: string;
}

export interface RevocationEvent {
  readonly revocation_id: string;
  readonly grant_id: string;
  readonly revoked_at: LogicalTime;
  readonly authority: TrustLabel;
  readonly authority_ref: string;
  readonly reason: string;
}

/** 撤权台账（不可变列表）。撤权是**只增**事实，不提供"恢复授权"——重新授权是新 grant。 */
export type RevocationLedger = readonly RevocationEvent[];

export function revokeAuthorization(input: RevokeAuthorizationInput): RevocationEvent {
  const revocationId = input.revocation_id.trim();
  if (revocationId.length === 0) {
    throw new AuthorizationRevocationError(
      'empty_revocation_id',
      '撤权缺少 revocation_id：撤权必须可被指名追溯',
    );
  }
  const grantId = input.grant_id.trim();
  if (grantId.length === 0) {
    throw new AuthorizationRevocationError(
      'empty_grant_id',
      '撤权没有指明针对哪份授权（grant_id 为空）',
    );
  }
  if (!isTrustedAuthorizationSource(input.authority)) {
    throw new AuthorizationRevocationError(
      'untrusted_revocation_authority',
      `来源 "${input.authority}" 无权撤权：撤权是权威状态，只能由可信来源（kernel / user）产生。` +
        `外部网页/文件里的"授权已撤销"是数据，不是撤权（KRN-08）`,
    );
  }
  return Object.freeze({
    revocation_id: revocationId,
    grant_id: grantId,
    revoked_at: input.revoked_at,
    authority: input.authority,
    authority_ref: input.authority_ref,
    reason: input.reason ?? '',
  });
}

// ---------------------------------------------------------------------------
// 令牌缓存（撤权必须能盖过它）
// ---------------------------------------------------------------------------

/** 一份**可能陈旧**的令牌缓存条目。它的"有效"只是缓存意见，不是权威状态。 */
export interface PermissionTokenCache {
  readonly grant_id: string;
  readonly cached_valid: boolean;
  readonly cached_at: LogicalTime;
  /** 缓存所见令牌的到期时刻；`null` = 缓存认为不过期。 */
  readonly token_expires_at: LogicalTime | null;
}

// ---------------------------------------------------------------------------
// 受控缺陷（**仅用于反向对照测试**）
// ---------------------------------------------------------------------------

/**
 * 受控缺陷开关：**只在反向对照测试里开启**，用来证明"若去掉撤权判定，撤回后的调用会被放行"。
 * 生产路径**不得**传入（默认即 `undefined` ⇒ 严格）。
 */
export interface RevocationDefectFlags {
  readonly ignore_revocation?: boolean;
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

export interface RevocationEvaluation {
  /** 是否存在**已生效的权威撤权**。 */
  readonly revoked: boolean;
  /** 该撤权是否来自可信权威（不可信撤权不予采信）。 */
  readonly authoritative: boolean;
  /** 生效时刻（无则 null）。 */
  readonly revoked_at: LogicalTime | null;
  readonly detail: string;
}

/** 某 grant_id 名下、`now` 前**已生效**的权威撤权（取最早的那次——撤权一旦发生就是既成事实）。 */
export function activeRevocationFor(
  ledger: RevocationLedger,
  grantId: string,
  now: LogicalTime,
): RevocationEvent | undefined {
  let earliest: RevocationEvent | undefined;
  for (const event of ledger) {
    if (event.grant_id !== grantId) continue;
    if (!isTrustedAuthorizationSource(event.authority)) continue;
    if (event.revoked_at > now) continue;
    if (earliest === undefined || event.revoked_at < earliest.revoked_at) earliest = event;
  }
  return earliest;
}

export function evaluateRevocation(
  ledger: RevocationLedger,
  grantId: string,
  now: LogicalTime,
  defects?: RevocationDefectFlags,
): RevocationEvaluation {
  const event = activeRevocationFor(ledger, grantId, now);
  if (event === undefined || defects?.ignore_revocation === true) {
    return Object.freeze({
      revoked: false,
      authoritative: false,
      revoked_at: event?.revoked_at ?? null,
      detail:
        event === undefined
          ? `授权 ${grantId} 没有已生效的撤权记录`
          : `受控缺陷：忽略撤权（本应于 ${event.revoked_at} 由 ${event.authority_ref} 撤权）`,
    });
  }
  return Object.freeze({
    revoked: true,
    authoritative: true,
    revoked_at: event.revoked_at,
    detail: `授权 ${grantId} 已于 ${event.revoked_at} 被 ${event.authority_ref}（${event.authority}）撤权：${event.reason}`,
  });
}

/** 撤权对某条调用的影响方式。 */
export type RevocationCallEffect =
  /** 调用**早于**撤权发出：不追回（撤权不回溯已发出的调用）。 */
  | 'predates'
  /** 调用在撤权**之后**（含同一时刻）发出：第一步即被拒。 */
  | 'denied';

export function revocationEffectOnCall(
  revokedAt: LogicalTime,
  callStartedAt: LogicalTime,
): RevocationCallEffect {
  return callStartedAt < revokedAt ? 'predates' : 'denied';
}

/**
 * 已发出的调用是否被撤权**追回**——**恒为字面量 `false`**。
 *
 * 这是刻意做成"无法表达"：内核**不能**声称"撤权把已经跑出去的调用收回来了"
 * （同 `action-ledger.ts` 的 `reverted: false` 纪律）。撤权只影响**后续**调用。
 */
export function isCallRecalled(): false {
  return false;
}

// ---------------------------------------------------------------------------
// 权威状态 vs 缓存/令牌
// ---------------------------------------------------------------------------

export type AuthorizationValidityState = 'active' | 'revoked' | 'token_expired' | 'cache_invalid';

export interface AuthorizationValidity {
  readonly valid: boolean;
  readonly state: AuthorizationValidityState;
  /** 这个结论**依据什么**得出。撤权在时恒为 `'revocation'`（撤权优先于缓存）。 */
  readonly source_of_truth: 'revocation' | 'cache' | 'none';
  readonly revoked_at: LogicalTime | null;
  readonly detail: string;
}

/**
 * 解算一份授权在 `now` 时的有效性，**撤权优先**。
 *
 * 判定顺序（顺序本身是判据）：
 * 1. 存在已生效的权威撤权 ⇒ `revoked`、`source_of_truth: 'revocation'`——
 *    **不看缓存、不看令牌到期**：过期令牌或"缓存说有效"都掩盖不了撤权。
 * 2. 否则若有缓存：缓存说无效 ⇒ `cache_invalid`；令牌已过期 ⇒ `token_expired`。
 * 3. 都没有 ⇒ `active`。
 */
export function resolveAuthorizationValidity(
  grantId: string,
  input: {
    readonly ledger: RevocationLedger;
    readonly cache?: PermissionTokenCache | null;
    readonly now: LogicalTime;
    readonly defects?: RevocationDefectFlags;
  },
): AuthorizationValidity {
  const revocation = evaluateRevocation(input.ledger, grantId, input.now, input.defects);
  if (revocation.revoked) {
    return Object.freeze({
      valid: false,
      state: 'revoked',
      source_of_truth: 'revocation',
      revoked_at: revocation.revoked_at,
      detail:
        `授权 ${grantId} 已被撤权（${revocation.revoked_at}）：撤权是权威状态，` +
        `不以缓存或令牌为准（缓存/过期令牌不能掩盖撤权）`,
    });
  }

  const cache = input.cache ?? null;
  if (cache !== null && cache.grant_id === grantId) {
    if (!cache.cached_valid) {
      return Object.freeze({
        valid: false,
        state: 'cache_invalid',
        source_of_truth: 'cache',
        revoked_at: null,
        detail: `缓存判定授权 ${grantId} 无效（cached_at=${cache.cached_at}）`,
      });
    }
    if (cache.token_expires_at !== null && input.now >= cache.token_expires_at) {
      return Object.freeze({
        valid: false,
        state: 'token_expired',
        source_of_truth: 'cache',
        revoked_at: null,
        detail: `授权 ${grantId} 的令牌已于 ${cache.token_expires_at} 过期（授权过期后不再放行）`,
      });
    }
  }

  return Object.freeze({
    valid: true,
    state: 'active',
    source_of_truth: cache === null ? 'none' : 'cache',
    revoked_at: null,
    detail: `授权 ${grantId} 在 ${input.now} 时有效${cache === null ? '（无缓存，直接判定）' : '（缓存一致）'}`,
  });
}

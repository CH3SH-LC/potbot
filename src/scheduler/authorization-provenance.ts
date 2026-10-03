/**
 * **授权来源可追溯**（KRN-08；能力目录 KRN-08、合同 §九、R245「授权来源」）。
 *
 * 本文件只回答三件事，且都不替调用方猜：
 * 1. **谁、何时、以什么范围**授予了这份授权（`describeProvenance` / `traceProvenance`）；
 * 2. 一份授权**当前是否过期**（`authorizationState`，"授权过期后不再放行"的唯一判据）；
 * 3. **范围收窄**如何产生新版本（`narrowAuthorization`：只许收窄、不许放宽，且不得延长期限）。
 *
 * 纪律（与 `src/workledger/action-ledger.ts` 的 `ActionAuthorization` 同源）：
 * - `source` 是可读且**稳定**的渠道标识，**不得用自然语言冒充**——"网页里写着已获批准"不是来源。
 * - **撤回**不在本文件：撤回是运行期事件，归 `./revocation.js`（那是权威状态，覆盖这里的 `active`）。
 *   本文件的"过期"与那里的"撤回"是两个正交事实，`./permission-check.js` 才把两者合起来判定。
 * - 判定只用**可信来源**：`kernel` / `user` 是可信来源，`agent` / `external` 的"批准"只是数据
 *   （附录 A4 trust_label；§16：群消息自称"用户已批准"不构成授权）。
 */

import { ValidationError, type LogicalTime, type TrustLabel } from '../protocol/index.js';

// ---------------------------------------------------------------------------
// 可信来源
// ---------------------------------------------------------------------------

/**
 * **唯一**被信任的授权来源：内核自身与用户前台输入。
 *
 * 为什么不是"看内容像不像批准"：外部网页/文件里的"已获用户批准"是**外部文本**，
 * 它的 `trust_label` 是 `external`；群内实例的自我声明是 `agent`。两者都**改变不了授权状态**——
 * 这正是 KRN-08「外部网页/文件中的假批准无效」的落点。
 */
export const TRUSTED_AUTHORIZATION_SOURCES = ['kernel', 'user'] as const;
export type TrustedAuthorizationSource = (typeof TRUSTED_AUTHORIZATION_SOURCES)[number];

export function isTrustedAuthorizationSource(
  source: TrustLabel,
): source is TrustedAuthorizationSource {
  return source === 'kernel' || source === 'user';
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export const AUTHORIZATION_PROVENANCE_REJECTION_REASONS = [
  /** `grant_id` 为空——授权必须能被指名追溯。 */
  'empty_grant_id',
  /** 权限范围里有空 token——范围必须机器可读、可比较。 */
  'empty_scope',
  /** 收窄调用**试图放宽**范围（含新增本不在范围内的权限）——只许收窄。 */
  'scope_widening_forbidden',
  /** 收窄时间早于授予时间——逻辑时间不得倒流。 */
  'time_regression',
  /** `expires_at` 早于 `granted_at`——有效期不可能是负的。 */
  'invalid_expiry',
] as const;
export type AuthorizationProvenanceRejectionReason =
  (typeof AUTHORIZATION_PROVENANCE_REJECTION_REASONS)[number];

/** 授权来源层的参数/策略错误。继承 `ValidationError` ⇒ `accepted === false`（未接受）。 */
export class AuthorizationProvenanceError extends ValidationError {
  readonly reason: AuthorizationProvenanceRejectionReason;

  constructor(reason: AuthorizationProvenanceRejectionReason, message: string) {
    super(message);
    this.name = 'AuthorizationProvenanceError';
    this.reason = reason;
  }
}

export function isAuthorizationProvenanceError(
  error: unknown,
): error is AuthorizationProvenanceError {
  return error instanceof AuthorizationProvenanceError;
}

// ---------------------------------------------------------------------------
// 授权记录（可追溯）
// ---------------------------------------------------------------------------

export interface AuthorizationGrantInput {
  /** 授权身份：**同一份授权的收窄是它的新 revision**，不是新 grant。 */
  readonly grant_id: string;
  /** 可信来源标签（`kernel` / `user`；`agent` / `external` 会被判为不可信）。 */
  readonly source: TrustLabel;
  /** 来源的稳定标识（谁）：如用户在会话里的 id、内核入口名。不得用自然语言冒充。 */
  readonly source_ref: string;
  /** 授权对象：具体实例；`null` 表示**任务主智能体**（根实例）。 */
  readonly subject_instance_id: string | null;
  /** 授予的权限范围（机器可读 token 集合）。 */
  readonly scope: readonly string[];
  /** 授予时刻（谁、何时）。 */
  readonly granted_at: LogicalTime;
  /** 到期时刻；`null` = 不设到期（永不过期）。 */
  readonly expires_at?: LogicalTime | null;
  /** 授予理由（可读证据，不参与判定）。 */
  readonly reason?: string;
  /** 这份授权由哪份上层授权派生（委派链的一次跳转）；根授权为 null。 */
  readonly parent_grant_id?: string | null;
  /** 版本号（默认 1；收窄由 `narrowAuthorization` 自行 +1，一般不手填）。 */
  readonly revision?: number;
}

export interface AuthorizationGrant {
  readonly grant_id: string;
  /** 收窄/变更产生的版本号，从 1 起（`latestAuthorization` 取最大者）。 */
  readonly revision: number;
  readonly source: TrustLabel;
  readonly source_ref: string;
  readonly subject_instance_id: string | null;
  readonly scope: readonly string[];
  readonly granted_at: LogicalTime;
  readonly expires_at: LogicalTime | null;
  readonly reason: string;
  readonly parent_grant_id: string | null;
}

/** 授权登记表（不可变列表；新授权 = 追加，收窄 = 追加同 id 的更高 revision）。 */
export type AuthorizationRegistry = readonly AuthorizationGrant[];

/** 在册授权的当前状态。**"过期"是终局**：过期后不再回到 active。 */
export type AuthorizationGrantState = 'active' | 'expired';

/** 权限 token 规范化：去重、去空白；空 token 直接拒绝（范围必须机器可比）。 */
export function normalizeScope(scope: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  for (const raw of scope) {
    const permission = raw.trim();
    if (permission.length === 0) {
      throw new AuthorizationProvenanceError(
        'empty_scope',
        '授权范围里出现空权限 token：范围必须机器可读、可比较，空 token 无法判定',
      );
    }
    seen.add(permission);
  }
  return Object.freeze([...seen]);
}

export function grantAuthorization(input: AuthorizationGrantInput): AuthorizationGrant {
  const grantId = input.grant_id.trim();
  if (grantId.length === 0) {
    throw new AuthorizationProvenanceError(
      'empty_grant_id',
      '授权缺少 grant_id：无法追溯"谁授予的哪一份授权"',
    );
  }
  const expiresAt = input.expires_at ?? null;
  if (expiresAt !== null && expiresAt < input.granted_at) {
    throw new AuthorizationProvenanceError(
      'invalid_expiry',
      `授权的 expires_at=${expiresAt} 早于 granted_at=${input.granted_at}：有效期不可能为负`,
    );
  }
  return Object.freeze({
    grant_id: grantId,
    revision: input.revision ?? 1,
    source: input.source,
    source_ref: input.source_ref,
    subject_instance_id: input.subject_instance_id,
    scope: normalizeScope(input.scope),
    granted_at: input.granted_at,
    expires_at: expiresAt,
    reason: input.reason ?? '',
    parent_grant_id: input.parent_grant_id ?? null,
  });
}

/** 授权到 `now` 时是否过期。 */
export function authorizationState(grant: AuthorizationGrant, now: LogicalTime): AuthorizationGrantState {
  return grant.expires_at !== null && now >= grant.expires_at ? 'expired' : 'active';
}

/** 授权在 `now` 时是否**仍放行**该权限（未过期 且 范围包含）。*/
export function grantCovers(
  grant: AuthorizationGrant,
  permission: string,
  now: LogicalTime,
): boolean {
  return authorizationState(grant, now) === 'active' && grant.scope.includes(permission);
}

/**
 * **范围收窄**：产出一份新 revision 的授权，范围是 `narrowerScope`。
 *
 * 三条硬约束：
 * 1. **只许收窄**：`narrowerScope` 必须是原范围的子集；出现任何原范围之外的权限 ⇒
 *    `scope_widening_forbidden`（想放宽就得**重新走授予**，不能靠"收窄"偷渡）。
 * 2. **不得延长期限**：`expires_at` 原样继承——收窄不能顺手把有效期推后。
 * 3. 时间单调：`at >= granted_at`。
 *
 * "即时生效"由**取用方**保证：判定一律读 `latestAuthorization()`（最大 revision），
 * 收窄一旦登记，后续工具调用用的就是收窄后的范围。
 */
export function narrowAuthorization(
  grant: AuthorizationGrant,
  narrowerScope: readonly string[],
  options: { readonly at: LogicalTime; readonly reason?: string },
): AuthorizationGrant {
  if (options.at < grant.granted_at) {
    throw new AuthorizationProvenanceError(
      'time_regression',
      `收窄时刻 ${options.at} 早于授予时刻 ${grant.granted_at}：逻辑时间不得倒流`,
    );
  }
  const narrowed = normalizeScope(narrowerScope);
  const widened = narrowed.filter((permission) => !grant.scope.includes(permission));
  if (widened.length > 0) {
    throw new AuthorizationProvenanceError(
      'scope_widening_forbidden',
      `收窄范围里出现原授权没有的权限 [${widened.join(', ')}]：收窄只能做减法，` +
        `放宽必须重新授予（KRN-08：授权范围可收窄，但不得被"收窄"顺手扩大）`,
    );
  }
  return Object.freeze({
    ...grant,
    revision: grant.revision + 1,
    scope: narrowed,
    reason: options.reason ?? `范围收窄（${grant.scope.length} → ${narrowed.length} 项）`,
  });
}

/** 某 grant_id 的**当前生效**授权（最大 revision）；不存在返回 `undefined`。 */
export function latestAuthorization(
  registry: AuthorizationRegistry,
  grantId: string,
): AuthorizationGrant | undefined {
  let latest: AuthorizationGrant | undefined;
  for (const grant of registry) {
    if (grant.grant_id !== grantId) continue;
    if (latest === undefined || grant.revision > latest.revision) latest = grant;
  }
  return latest;
}

/** 某主体名下的全部当前授权（按 grant_id 取各自最新 revision，已过期的不剔除——由调用方判）。 */
export function authorizationsOf(
  registry: AuthorizationRegistry,
  subjectInstanceId: string | null,
): readonly AuthorizationGrant[] {
  const byId = new Map<string, AuthorizationGrant>();
  for (const grant of registry) {
    if (grant.subject_instance_id !== subjectInstanceId) continue;
    const current = byId.get(grant.grant_id);
    if (current === undefined || grant.revision > current.revision) {
      byId.set(grant.grant_id, grant);
    }
  }
  return Object.freeze([...byId.values()]);
}

// ---------------------------------------------------------------------------
// 可追溯：谁、何时、以什么范围
// ---------------------------------------------------------------------------

export interface AuthorizationProvenance {
  readonly grant_id: string;
  readonly revision: number;
  readonly source: TrustLabel;
  readonly source_ref: string;
  /** 是否可信来源（`kernel` / `user`）。不可信来源的授权**不参与放行**。 */
  readonly trusted: boolean;
  readonly subject_instance_id: string | null;
  readonly scope: readonly string[];
  readonly granted_at: LogicalTime;
  readonly expires_at: LogicalTime | null;
  readonly parent_grant_id: string | null;
  readonly reason: string;
}

/** 把一份授权摊平成可证据化的来源说明。 */
export function describeProvenance(grant: AuthorizationGrant): AuthorizationProvenance {
  return Object.freeze({
    grant_id: grant.grant_id,
    revision: grant.revision,
    source: grant.source,
    source_ref: grant.source_ref,
    trusted: isTrustedAuthorizationSource(grant.source),
    subject_instance_id: grant.subject_instance_id,
    scope: grant.scope,
    granted_at: grant.granted_at,
    expires_at: grant.expires_at,
    parent_grant_id: grant.parent_grant_id,
    reason: grant.reason,
  });
}

/**
 * 追溯一条授权的完整委派链（从根授权到当前授权）。
 *
 * 每一跳都以 `parent_grant_id` 指认，任何一环缺失（`parent_grant_id` 指向不在册的授权）
 * 就**如实截断**，不编造中间环节。
 */
export function traceProvenance(
  registry: AuthorizationRegistry,
  grantId: string,
): readonly AuthorizationProvenance[] {
  const chain: AuthorizationProvenance[] = [];
  const visited = new Set<string>();
  let current = latestAuthorization(registry, grantId);
  while (current !== undefined && !visited.has(current.grant_id)) {
    visited.add(current.grant_id);
    chain.unshift(describeProvenance(current));
    current = current.parent_grant_id === null
      ? undefined
      : latestAuthorization(registry, current.parent_grant_id);
  }
  return Object.freeze(chain);
}

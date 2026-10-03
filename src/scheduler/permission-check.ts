/**
 * **每次工具调用的权限与授权来源检查**（KRN-08；能力目录 KRN-08、R244/R245）。
 *
 * 一次工具体调用能不能发出去，由 `checkToolCall()` 单点回答。判定顺序（顺序本身就是判据）：
 *
 * 1. **来源可信**：授权只有来自 `kernel` / `user` 才算数；`agent` / `external` 的"批准"是数据
 *    （附录 A4 trust_label；§16）。外部网页/文件里注入的"已获用户批准"文本**不进判定路径**——
 *    verdict 会如实回报 `ignored_approval_claims` 条数，但结论不因它变化。
 * 2. **委派不提高权限**：子智能体/分身的可用权限 = 委派范围 ∩ **父方实际有效权限**（递归到根）。
 *    任何越过父方能力、或父方根本没持有的权限，都被标成 `escalated` 并在严格模式下剔除
 *    （`./permission-check.js` 的 `detectDelegationEscalation()` 另提供独立探针）。
 * 3. **撤权即时生效**：授权被撤后，发起时刻 `>=` 撤权时刻的调用在**第一步**就被拒；
 *    早于撤权发出的调用**不追回**（`recalled` 恒为 `false`，见 `./revocation.js`）。
 * 4. **过期不放行**：授权到 `now` 已过期即拒（`expired`）。
 *
 * 反向对照（本模块的每个安全性质都有对照臂）：
 * `PermissionContext.defects` 是**受控缺陷开关，仅限反向对照测试**使用——开启后的行为就是
 * "去掉这条判定"，据此断言"若没有这道闸门，越权/假批准/撤权后调用会被放行"，从而证明闸门是承重的。
 * 生产路径不得传 `defects`（默认 `undefined` ⇒ 全严格）。
 */

import { ValidationError, type LogicalTime, type TrustLabel } from '../protocol/index.js';
import {
  authorizationState,
  authorizationsOf,
  describeProvenance,
  isTrustedAuthorizationSource,
  type AuthorizationGrant,
  type AuthorizationProvenance,
  type AuthorizationRegistry,
} from './authorization-provenance.js';
import {
  activeRevocationFor,
  isCallRecalled,
  revocationEffectOnCall,
  type RevocationCallEffect,
  type RevocationDefectFlags,
  type RevocationLedger,
} from './revocation.js';

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------

/** 一条工具体调用（**每次**调用都过一次闸门，不存在"本轮已放过、后续免检"）。 */
export interface ToolCallRequest {
  readonly call_id: string;
  readonly tool: string;
  /** 本工具要求的权限 token（机器可读，与授权范围内的 token 同一命名空间）。 */
  readonly permission: string;
  readonly caller_instance_id: string;
  /** 本条调用的发起时刻——撤权"不追回已发出调用 / 后续第一步即拒"的对照基准。 */
  readonly started_at: LogicalTime;
}

/**
 * 一次**委派**（主智能体 → 子智能体/分身）。
 * `delegated_scope` 是**想授予**的权限；实际能不能到手由父方实际有效权限决定。
 */
export interface Delegation {
  readonly delegation_id: string;
  readonly delegator_instance_id: string;
  readonly delegate_instance_id: string;
  readonly delegated_scope: readonly string[];
  readonly created_at: LogicalTime;
}

/**
 * 外部网页 / 文件 / 工具返回里的"批准声明"。
 * **它不产生任何授权**：本模块**从不**读它来放行，只用它统计"忽略了几条假批准"。
 * `trust_label` 只能是 `external` / `agent`（可信来源的批准走 `grantAuthorization()`，不是这里）。
 */
export interface UntrustedApprovalClaim {
  readonly claim_id: string;
  readonly permission: string;
  readonly subject_instance_id: string;
  readonly trust_label: TrustLabel;
  readonly text: string;
  readonly at: LogicalTime;
}

/** 受控缺陷开关：**仅用于反向对照测试**，生产不得传入。 */
export interface PermissionDefectFlags extends RevocationDefectFlags {
  /** 忽略"只认可信来源"过滤（反向对照：假批准会被当真）。 */
  readonly ignore_source_trust?: boolean;
  /** 忽略委派上限（反向对照：子分身会拿到超集权限）。 */
  readonly ignore_delegation_ceiling?: boolean;
}

export interface PermissionContext {
  readonly now: LogicalTime;
  /** 授权登记表（`./authorization-provenance.js`）。 */
  readonly grants: AuthorizationRegistry;
  readonly delegations?: readonly Delegation[];
  readonly revocations?: RevocationLedger;
  readonly approval_claims?: readonly UntrustedApprovalClaim[];
  /** 受控缺陷（**仅反向对照测试**）。 */
  readonly defects?: PermissionDefectFlags;
}

// ---------------------------------------------------------------------------
// 错误与拒因
// ---------------------------------------------------------------------------

export const PERMISSION_REJECTION_REASONS = [
  /** 调用方名下**没有任何**覆盖该权限的可信授权（含"未获委派"的子方）。 */
  'no_grant',
  /** 覆盖该权限的授权**只来自不可信来源**（`agent` / `external`）——假批准不算授权。 */
  'untrusted_source',
  /** 该权限**越过了委派上限**：子方拿不到父方没有的权限（委派不提高权限）。 */
  'delegation_escalation',
  /** 授权已被撤权，且本条调用在撤权之后发出（第一步即被拒）。 */
  'revoked',
  /** 授权已过期（授权过期后不再放行）。 */
  'expired',
] as const;
export type PermissionRejectionReason = (typeof PERMISSION_REJECTION_REASONS)[number];

export const PERMISSION_REJECTION_LABELS: Readonly<Record<PermissionRejectionReason, string>> = {
  no_grant: '没有覆盖该权限的可信授权',
  untrusted_source: '授权仅来自不可信来源（假批准无效）',
  delegation_escalation: '越过委派上限（委派不提高权限）',
  revoked: '授权已被撤权（撤权后第一步即拒）',
  expired: '授权已过期',
};

export const PERMISSION_INPUT_REJECTION_REASONS = [
  'empty_permission',
  'empty_caller',
  'invalid_approval_claim_trust',
] as const;
export type PermissionInputRejectionReason = (typeof PERMISSION_INPUT_REJECTION_REASONS)[number];

export class PermissionCheckError extends ValidationError {
  readonly reason: PermissionInputRejectionReason;

  constructor(reason: PermissionInputRejectionReason, message: string) {
    super(message);
    this.name = 'PermissionCheckError';
    this.reason = reason;
  }
}

export function isPermissionCheckError(error: unknown): error is PermissionCheckError {
  return error instanceof PermissionCheckError;
}

export function permissionRejectionLabel(reason: PermissionRejectionReason): string {
  return PERMISSION_REJECTION_LABELS[reason];
}

// ---------------------------------------------------------------------------
// 判定结果
// ---------------------------------------------------------------------------

export interface PermissionVerdict {
  readonly allowed: boolean;
  /** 不允许时的拒因；允许时为 null。 */
  readonly reason: PermissionRejectionReason | null;
  readonly detail: string;
  /** 放行时：生效授权的来源（谁、何时、以什么范围）。 */
  readonly provenance: AuthorizationProvenance | null;
  /** 这条调用是否早于撤权（撤权前已发出的调用不追回）。 */
  readonly predates_revocation: boolean;
  /** 是否被撤权追回：**恒为 `false`**（内核无法表达"追回已发出的调用"）。 */
  readonly recalled: false;
  /** **被刻意忽略**的外部"批准声明"条数（它们不参与放行）。 */
  readonly ignored_approval_claims: number;
}

// ---------------------------------------------------------------------------
// 内部：授权条目
// ---------------------------------------------------------------------------

interface AuthorityEntry {
  readonly permission: string;
  readonly grant_id: string | null;
  /** `null` 仅出现在"委派合成项"（父方没有、被委派强行带出的越权项）。 */
  readonly source: TrustLabel | null;
  readonly source_ref: string;
  readonly trusted: boolean;
  readonly state: 'active' | 'expired';
  readonly via: 'grant' | 'delegation';
  /** 只有在忽略委派上限时该项才成立（即它越过了父方能力）。 */
  readonly escalated: boolean;
  readonly provenance: AuthorizationProvenance | null;
}

function entriesOfGrant(
  grant: AuthorizationGrant,
  now: LogicalTime,
  via: 'grant' | 'delegation',
): readonly AuthorityEntry[] {
  const state = authorizationState(grant, now);
  const trusted = isTrustedAuthorizationSource(grant.source);
  const provenance = describeProvenance(grant);
  return grant.scope.map((permission) =>
    Object.freeze({
      permission,
      grant_id: grant.grant_id,
      source: grant.source,
      source_ref: grant.source_ref,
      trusted,
      state,
      via,
      escalated: false,
      provenance,
    }),
  );
}

function delegationFor(caller: string, ctx: PermissionContext): Delegation | undefined {
  return (ctx.delegations ?? []).find((d) => d.delegate_instance_id === caller);
}

/** 某实例名下**自有**授权（不含委派）：根实例额外包含 `subject = null` 的任务级授权。 */
function ownEntries(caller: string, ctx: PermissionContext, isRoot: boolean): readonly AuthorityEntry[] {
  const grants = [
    ...authorizationsOf(ctx.grants, caller),
    ...(isRoot ? authorizationsOf(ctx.grants, null) : []),
  ];
  return grants.flatMap((grant) => entriesOfGrant(grant, ctx.now, 'grant'));
}

/**
 * 汇总调用方沿**委派链**可用的授权条目。
 *
 * 子方的可用权限 = （自有授权 ∪ 委派范围）∩ **父方实际有效权限**。
 * 越出父方的项被标 `escalated`（严格模式下剔除）；委派项**继承父方的来源与有效性**——
 * 父方靠什么拿到的权限，子方就靠什么拿（父方只有外部假批准 ⇒ 子方同样没有）。
 */
function collectAuthority(
  caller: string,
  ctx: PermissionContext,
  seen: Set<string>,
): readonly AuthorityEntry[] {
  if (seen.has(caller)) return Object.freeze([]);
  seen.add(caller);

  const delegation = delegationFor(caller, ctx);
  const own = ownEntries(caller, ctx, delegation === undefined);
  if (delegation === undefined) {
    return own;
  }

  const parentEntries = collectAuthority(delegation.delegator_instance_id, ctx, seen);
  const parentByPermission = new Map<string, AuthorityEntry[]>();
  for (const entry of parentEntries) {
    const bucket = parentByPermission.get(entry.permission);
    if (bucket === undefined) parentByPermission.set(entry.permission, [entry]);
    else bucket.push(entry);
  }
  const parentActive = new Set(
    parentEntries
      .filter((entry) => !entry.escalated && entry.trusted && entry.state === 'active')
      .map((entry) => entry.permission),
  );

  const out: AuthorityEntry[] = [];
  // 1. 子方自有授权：同样受父方上限约束（用户直授也不能让子方超过父方）。
  for (const entry of own) {
    out.push(parentActive.has(entry.permission) ? entry : { ...entry, escalated: true });
  }
  // 2. 委派授予：来源/有效性继承父方；父方没有的权限 = 越权（记合成项，严格模式剔除）。
  for (const permission of delegation.delegated_scope) {
    const inherited = parentByPermission.get(permission);
    if (inherited !== undefined) {
      // 父方有此权限的条目（无论可信/过期）：**原样继承**其来源与有效性。
      // 父方只靠外部假批准拿到 ⇒ 子方也只继承到"不可信"，不会凭空变成可信。
      for (const entry of inherited) out.push({ ...entry, via: 'delegation' });
    } else {
      out.push({
        permission,
        grant_id: null,
        source: null,
        source_ref: `delegation:${delegation.delegation_id}`,
        trusted: true,
        state: 'active',
        via: 'delegation',
        escalated: true,
        provenance: null,
      });
    }
  }
  return out;
}

/** 调用方**实际有效**的权限集（严格口径：可信 + 未过期 + 未越权 + 未撤权）。 */
export function callerEffectivePermissions(
  callerInstanceId: string,
  ctx: PermissionContext,
): readonly string[] {
  const defects = ctx.defects;
  const entries = collectAuthority(callerInstanceId, ctx, new Set<string>());
  const ledger = ctx.revocations ?? [];
  const effective = new Set<string>();
  for (const entry of entries) {
    if (entry.escalated && defects?.ignore_delegation_ceiling !== true) continue;
    if (!entry.trusted && defects?.ignore_source_trust !== true) continue;
    if (entry.state !== 'active') continue;
    if (
      entry.grant_id !== null &&
      defects?.ignore_revocation !== true &&
      activeRevocationFor(ledger, entry.grant_id, ctx.now) !== undefined
    ) {
      continue;
    }
    effective.add(entry.permission);
  }
  return Object.freeze([...effective]);
}

// ---------------------------------------------------------------------------
// 委派越权探针（独立于 checkToolCall）
// ---------------------------------------------------------------------------

export interface DelegationEscalation {
  readonly delegation_id: string;
  readonly delegator_instance_id: string;
  readonly delegate_instance_id: string;
  /** 越过父方实际能力的权限。 */
  readonly permissions: readonly string[];
  readonly detail: string;
}

/**
 * 扫描全部委派，找出"越权授予"（委派了父方实际不持有、或已过期/已撤权的权限）。
 *
 * 这是"委派不提高权限"的**独立探针**：它不依赖某一条工具调用是否恰好命中该权限，
 * 因而即使越权权限暂未被调用也能被发现并上报。
 */
export function detectDelegationEscalation(ctx: PermissionContext): readonly DelegationEscalation[] {
  const found: DelegationEscalation[] = [];
  for (const delegation of ctx.delegations ?? []) {
    const parentEntries = collectAuthority(delegation.delegator_instance_id, ctx, new Set<string>());
    const parentActive = new Set(
      parentEntries
        .filter((entry) => !entry.escalated && entry.trusted && entry.state === 'active')
        .map((entry) => entry.permission),
    );
    const escalating = delegation.delegated_scope.filter((permission) => !parentActive.has(permission));
    if (escalating.length === 0) continue;
    found.push(
      Object.freeze({
        delegation_id: delegation.delegation_id,
        delegator_instance_id: delegation.delegator_instance_id,
        delegate_instance_id: delegation.delegate_instance_id,
        permissions: Object.freeze([...escalating]),
        detail:
          `委派 ${delegation.delegation_id} 把 [${escalating.join(', ')}] 授予 ${delegation.delegate_instance_id}，` +
          `但委派方 ${delegation.delegator_instance_id} 并不实际持有这些权限：委派不得提高权限（KRN-08）`,
      }),
    );
  }
  return Object.freeze(found);
}

// ---------------------------------------------------------------------------
// 假批准声明（记录，但**从不**参与放行）
// ---------------------------------------------------------------------------

export function recordUntrustedApprovalClaim(input: UntrustedApprovalClaim): UntrustedApprovalClaim {
  if (isTrustedAuthorizationSource(input.trust_label)) {
    throw new PermissionCheckError(
      'invalid_approval_claim_trust',
      `可信来源（${input.trust_label}）的批准不是"不可信声明"，请走 grantAuthorization()：` +
        `本类型只用来记录外部网页/文件/实例里的"假批准"文本`,
    );
  }
  return Object.freeze({ ...input });
}

// ---------------------------------------------------------------------------
// 主判定
// ---------------------------------------------------------------------------

const INPUT_REASONS: Readonly<Record<PermissionInputRejectionReason, string>> = {
  empty_permission: '工具调用没有声明所需权限（permission 为空）',
  empty_caller: '工具调用没有指明调用方实例（caller_instance_id 为空）',
  invalid_approval_claim_trust: '不可信批准声明的来源标签非法',
};

export function checkToolCall(call: ToolCallRequest, ctx: PermissionContext): PermissionVerdict {
  const permission = call.permission.trim();
  if (permission.length === 0) {
    throw new PermissionCheckError('empty_permission', INPUT_REASONS.empty_permission);
  }
  const caller = call.caller_instance_id.trim();
  if (caller.length === 0) {
    throw new PermissionCheckError('empty_caller', INPUT_REASONS.empty_caller);
  }

  const defects = ctx.defects;
  const ledger = ctx.revocations ?? [];
  const ignoredApprovalClaims = (ctx.approval_claims ?? []).filter(
    (claim) => claim.subject_instance_id === caller && claim.permission === permission,
  ).length;

  const allEntries = collectAuthority(caller, ctx, new Set<string>());
  const ceilinged = allEntries.filter(
    (entry) => entry.permission === permission && (entry.escalated !== true || defects?.ignore_delegation_ceiling === true),
  );
  const trustworthy = ceilinged.filter(
    (entry) => entry.trusted || defects?.ignore_source_trust === true,
  );

  const deny = (reason: PermissionRejectionReason, detail: string): PermissionVerdict =>
    Object.freeze({
      allowed: false,
      reason,
      detail,
      provenance: null,
      predates_revocation: false,
      recalled: isCallRecalled(),
      ignored_approval_claims: ignoredApprovalClaims,
    });

  if (trustworthy.length === 0) {
    if (ceilinged.length > 0) {
      const sources = [...new Set(ceilinged.map((entry) => entry.source ?? 'delegation'))].join(', ');
      return deny(
        'untrusted_source',
        `权限 "${permission}" 的授权只来自不可信来源 [${sources}]：` +
          `外部网页/文件里的"已获用户批准"不构成授权（KRN-08）` +
          (ignoredApprovalClaims > 0 ? `；本次另忽略 ${ignoredApprovalClaims} 条假批准声明` : ''),
      );
    }
    if (allEntries.some((entry) => entry.permission === permission)) {
      return deny(
        'delegation_escalation',
        `权限 "${permission}" 只能靠越过委派上限成立：调用方 ${caller} 拿不到委派方没有的权限（KRN-08）`,
      );
    }
    return deny(
      'no_grant',
      `调用方 ${caller} 名下没有覆盖权限 "${permission}" 的可信授权` +
        (ignoredApprovalClaims > 0 ? `（已忽略 ${ignoredApprovalClaims} 条外部假批准声明）` : ''),
    );
  }

  // 撤权 / 过期：逐条判定，任一 survive 即放行。
  let sawRevocation = false;
  let sawExpiry = false;
  let predatesRevocation = false;
  for (const entry of trustworthy) {
    if (entry.state !== 'active') {
      sawExpiry = true;
      continue;
    }
    if (entry.grant_id !== null) {
      const revocation = activeRevocationFor(ledger, entry.grant_id, ctx.now);
      if (revocation !== undefined && defects?.ignore_revocation !== true) {
        const effect: RevocationCallEffect = revocationEffectOnCall(revocation.revoked_at, call.started_at);
        if (effect === 'denied') {
          sawRevocation = true;
          continue;
        }
        predatesRevocation = true;
      }
    }
    return Object.freeze({
      allowed: true,
      reason: null,
      detail:
        `权限 "${permission}" 由 ${entry.source_ref}（${entry.source ?? 'delegation'}）授予${entry.via === 'delegation' ? '，来源继承自委派链' : ''}` +
        (predatesRevocation ? '；本条调用早于撤权发出，不追回（撤权只影响后续调用）' : ''),
      provenance: entry.provenance,
      predates_revocation: predatesRevocation,
      recalled: isCallRecalled(),
      ignored_approval_claims: ignoredApprovalClaims,
    });
  }

  if (sawRevocation) {
    return deny(
      'revoked',
      `权限 "${permission}" 的授权已被撤权，且本条调用在撤权之后发出：第一步即被拒（KRN-08）` +
        `；撤权是权威状态，不受缓存/未过期令牌影响`,
    );
  }
  if (sawExpiry) {
    return deny('expired', `权限 "${permission}" 的授权已过期：授权过期后不再放行（KRN-08）`);
  }
  return deny('no_grant', `调用方 ${caller} 没有覆盖权限 "${permission}" 的有效授权`);
}

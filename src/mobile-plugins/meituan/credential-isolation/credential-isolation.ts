/**
 * M-R05 —— 凭证生命周期与隔离（key 撤销/过期、换账号、手机重装、凭证隔离）。
 *
 * ## 本包关掉的那一类洞
 *
 * M 线（美团）正式路径要求「凭证只以 `keyRef` 引用传递、明文不进 JS/UI/模型/日志」。
 * 以下四类失误会让这条纪律名存实亡，本包在**结构层面**把它们表达不出来：
 *
 * 1. **明文入库**：`importCredential` 只接收元数据（`keyRef`/`accountRef`/scopes/期限），
 *    **没有**、也**不接收**密钥明文参数；任何不符合 `keyref:` 形状的字符串（例如一段
 *    真实 token）会被拒绝，且**错误消息与审计日志都不回显该值**。
 * 2. **撤销/过期后仍可用**：`authorize` 每次都按当前逻辑时钟与撤销位重新判定，
 *    `revoked` / `expired` / `not_yet_valid` 一律拒绝，**不缓存**"曾经通过"的结论。
 * 3. **换账号串用**：凭证与 `accountRef` 逐项绑定；拿 A 账号的 keyRef 去执行 B 账号的
 *    动作必然 `account_mismatch`。切换账号会**失效**旧账号的待执行动作。
 * 4. **重装后旧凭证复活**：重装（`reinstall`）清空凭证库并换 `installId`，旧引用一律
 *    `unknown_key`；即便有人把旧记录从备份里塞回来，入库口的 `stale_install` 也会先拒绝
 *    （凭证与安装实例绑定），旧安装的待执行动作一并失效。
 *
 * ## 与 K03 / K07 的关系（不 import，只对齐语义）
 *
 * - `keyRef` 形状对齐 `contracts/mobile-v1` 的 `^keyref:[A-Za-z0-9._:-]+$`；
 *   纯引用，绝不是密钥。
 * - `accountRef` 形状对齐 M07 `order-submit/authorization.ts` 的 `^acct:...`。
 * - K07 的一次性授权由 K07 独占签发；本包只裁决"**这份 keyRef 此刻能不能给这个账号的
 *   这个 scope 用**"，不签发、不消费 `AuthorizationGrant`。真机接线上本模块输入
 *   `keyRef` + `accountRef`，输出 `AccessGrant`；明文密钥由手机原生密钥库在请求期间
 *   解密使用，**从不进入本模块**。
 *
 * ## 明确未做（不得当成已完成）
 *
 * - **不接真实密钥库 / Android Keystore / 手机 DB**：本模块是进程内状态机，供 fixture
 *   独立驱动；持久化与原生解密由 K03 端口注入。
 * - **不校验真实平台协议**：`provider` 只是本模块的用途标签，不构成任何真实权限结论。
 * - 未在真机验证；`verificationMode` 恒为 `fixture`。
 */

// ---------------------------------------------------------------------------
// 形状常量
// ---------------------------------------------------------------------------

/** `keyRef`：纯引用，形状对齐 mobile-v1 契约。 */
export const KEY_REF_PATTERN = /^keyref:[A-Za-z0-9._:-]+$/;

/** `accountRef`：账号引用（非凭据），对齐 M07。 */
export const ACCOUNT_REF_PATTERN = /^acct:[A-Za-z0-9._:-]+$/;

/** `installId`：安装实例引用（重装后必须变化）。 */
export const INSTALL_ID_PATTERN = /^install:[A-Za-z0-9._:-]+$/;

/** 本模块认识的用途标签（不构成任何真实平台权限结论）。 */
export const CREDENTIAL_PROVIDERS = ['meituan', 'deepseek'] as const;
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];

/** 凭证状态词表（**严格用这五个词**）。 */
export const CREDENTIAL_STATUSES = ['active', 'revoked', 'expired', 'not_yet_valid', 'unknown'] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

/** 拒绝原因词表（`authorize` 的唯一否定出口）。 */
export const DENY_REASONS = [
  'invalid_key_ref',
  'invalid_account_ref',
  'unknown_key',
  'revoked',
  'expired',
  'not_yet_valid',
  'account_mismatch',
  'provider_mismatch',
  'scope_missing',
] as const;
export type DenyReason = (typeof DENY_REASONS)[number];

/** 本模块自证的隔离边界（结构性声明，不是运行开关）。 */
export const CREDENTIAL_BOUNDARY = Object.freeze({
  /** 本模块接收或保存密钥明文的参数/字段数（必须恒为 0）。 */
  acceptsPlaintextSecret: false,
  /** 实际产生的网络调用数（恒为 0）。 */
  hasRealNetworkCall: false,
  /** 是否接通真实密钥库/平台（恒为 false）。 */
  connectsRealKeystore: false,
  verificationMode: 'fixture' as const,
  note:
    'M-R05 只实现凭证生命周期与隔离的判定纪律：明文密钥从不进入本模块，' +
    '所有结论为 fixture，未接通任何真实密钥库或平台。',
} as const);

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 凭证操作错误。**消息中绝不回显被拒的原始值**（防止把疑似密钥写进日志）。 */
export class CredentialError extends Error {
  readonly code: string;
  readonly field: string | null;
  constructor(code: string, message: string, field: string | null = null) {
    super(message);
    this.name = 'CredentialError';
    this.code = code;
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 入库请求（**没有**密钥字段）。 */
export interface ImportCredentialRequest {
  readonly keyRef: string;
  readonly accountRef: string;
  readonly provider: CredentialProvider;
  readonly scopes: readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** 缺省取当前安装实例。显式填入旧安装实例会被拒（恢复备份场景）。 */
  readonly installId?: string;
}

/** 对外可见的凭证视图 —— **只有引用与状态，没有任何秘密字段**。 */
export interface CredentialView {
  readonly keyRef: string;
  readonly accountRef: string;
  readonly provider: CredentialProvider;
  readonly scopes: readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
  readonly installId: string;
}

/** 授权判定请求：这份 keyRef 此刻能否为这个账号的这个 scope 使用。 */
export interface AuthorizeRequest {
  readonly keyRef: string;
  readonly accountRef: string;
  readonly provider: CredentialProvider;
  readonly requiredScope: string;
  readonly now: number;
}

/** 通过时的用途授权（只带引用，不带来明文）。 */
export interface AccessGrant {
  readonly keyRef: string;
  readonly accountRef: string;
  readonly provider: CredentialProvider;
  readonly scope: string;
  readonly installId: string;
  readonly grantedAt: number;
  readonly expiresAt: number;
}

/** 判定结果：通过（带 grant）或拒绝（带原因）。 **不存在"既通过又报错"的第三态**。 */
export type AuthzDecision =
  | { readonly allowed: true; readonly grant: AccessGrant }
  | { readonly allowed: false; readonly reason: DenyReason; readonly keyRef: string };

/** 审计条目：只记引用与判定，**结构上没有明文落点**。 */
export interface AuditEntry {
  readonly seq: number;
  readonly keyRef: string;
  readonly accountRef: string | null;
  readonly allowed: boolean;
  readonly reason: DenyReason | null;
  readonly at: number;
}

/** 待执行动作登记请求。 */
export interface PendingActionRequest {
  readonly actionRef: string;
  readonly keyRef: string;
  readonly scope: string;
  readonly expiresAt: number;
}

export const PENDING_ACTION_STATES = ['pending', 'invalidated', 'consumed'] as const;
export type PendingActionState = (typeof PENDING_ACTION_STATES)[number];

export interface PendingActionView {
  readonly actionRef: string;
  readonly accountRef: string;
  readonly keyRef: string;
  readonly scope: string;
  readonly expiresAt: number;
  readonly state: PendingActionState;
  readonly invalidationReason: string | null;
}

export type ConsumeDecision =
  | { readonly consumed: true; readonly action: PendingActionView }
  | { readonly consumed: false; readonly reason: 'unknown_action' | 'invalidated' | 'expired' | 'consumed' };

export interface SwitchAccountResult {
  readonly previousAccountRef: string | null;
  readonly activeAccountRef: string;
  readonly invalidatedActionRefs: readonly string[];
}

export interface ReinstallResult {
  readonly previousInstallId: string;
  readonly installId: string;
  readonly wipedKeyRefs: readonly string[];
  readonly invalidatedActionRefs: readonly string[];
}

// ---------------------------------------------------------------------------
// 校验（严格：未知键拒绝，不回显原值）
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKnownKeys(value: unknown, allowed: readonly string[], operation: string): void {
  if (!isPlainObject(value)) {
    throw new CredentialError('invalid_request', `${operation} 入参必须是对象`, null);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      // 只回显**键名**（键名不是密钥值）；不回显键值。
      throw new CredentialError('unknown_field', `${operation} 拒绝未知字段 ${JSON.stringify(key)}`, key);
    }
  }
}

function requireRef(value: unknown, pattern: RegExp, field: string, kind: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    // **刻意不回显 value**：若调用方误把明文当引用传入，明文不得进入错误消息/日志。
    throw new CredentialError('invalid_ref', `${field} 必须是${kind}引用（形状不符即拒；此处不回显原值）`, field);
  }
  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new CredentialError('invalid_request', `${field} 必须是安全整数，收到 ${typeof value}`, field);
  }
  return value;
}

function requireProvider(value: unknown): CredentialProvider {
  if (typeof value !== 'string' || !(CREDENTIAL_PROVIDERS as readonly string[]).includes(value)) {
    throw new CredentialError('invalid_request', `provider 必须是 ${CREDENTIAL_PROVIDERS.join(' / ')}`, 'provider');
  }
  return value as CredentialProvider;
}

function requireScopes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CredentialError('invalid_request', 'scopes 必须是非空数组', 'scopes');
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new CredentialError('invalid_request', 'scopes 每一项必须是非空字符串', 'scopes');
    }
    if (out.includes(item)) {
      throw new CredentialError('invalid_request', `scopes 不允许重复项 ${JSON.stringify(item)}`, 'scopes');
    }
    out.push(item);
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// 凭证库
// ---------------------------------------------------------------------------

function toView(record: MutableRecord): CredentialView {
  return Object.freeze({ ...record, scopes: Object.freeze([...record.scopes]) });
}

/** 内部记录（与 CredentialView 同形；`revokedAt` 就地更新）。 */
interface MutableRecord {
  keyRef: string;
  accountRef: string;
  provider: CredentialProvider;
  scopes: readonly string[];
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  installId: string;
}

interface PendingRecord {
  actionRef: string;
  accountRef: string;
  keyRef: string;
  scope: string;
  expiresAt: number;
  state: PendingActionState;
  invalidationReason: string | null;
}

/**
 * 凭证生命周期与隔离的状态机。
 *
 * 只保存**引用与元数据**；没有任何保存明文密钥的方法或字段。
 */
export class CredentialVault {
  #installId: string;
  #activeAccountRef: string | null = null;
  readonly #records = new Map<string, MutableRecord>();
  readonly #pending = new Map<string, PendingRecord>();
  readonly #audit: AuditEntry[] = [];

  constructor(options: { readonly installId: string }) {
    assertKnownKeys(options, ['installId'], 'CredentialVault');
    this.#installId = requireRef(options?.installId, INSTALL_ID_PATTERN, 'installId', '安装实例');
  }

  get installId(): string {
    return this.#installId;
  }

  get activeAccountRef(): string | null {
    return this.#activeAccountRef;
  }

  /** 入库（幂等：同 keyRef 重复入库视为冲突，必须显式先撤销/轮换）。 */
  importCredential(input: ImportCredentialRequest): CredentialView {
    assertKnownKeys(
      input,
      ['keyRef', 'accountRef', 'provider', 'scopes', 'issuedAt', 'expiresAt', 'installId'],
      'importCredential',
    );
    const keyRef = requireRef(input?.keyRef, KEY_REF_PATTERN, 'keyRef', 'key');
    const accountRef = requireRef(input?.accountRef, ACCOUNT_REF_PATTERN, 'accountRef', '账号');
    const provider = requireProvider(input?.provider);
    const scopes = requireScopes(input?.scopes);
    const issuedAt = requireInteger(input?.issuedAt, 'issuedAt');
    const expiresAt = requireInteger(input?.expiresAt, 'expiresAt');
    if (expiresAt <= issuedAt) {
      throw new CredentialError('invalid_request', `有效期必须为正：issuedAt ${issuedAt} ≥ expiresAt ${expiresAt}`, 'expiresAt');
    }
    const installId =
      input?.installId === undefined ? this.#installId : requireRef(input.installId, INSTALL_ID_PATTERN, 'installId', '安装实例');
    if (installId !== this.#installId) {
      // 从备份恢复的旧安装凭证：拒绝，不得静默采纳。
      throw new CredentialError('stale_install', '凭证属于其它安装实例（疑似从备份恢复），拒绝入库', 'installId');
    }
    if (this.#records.has(keyRef)) {
      throw new CredentialError('duplicate_key_ref', '该 keyRef 已存在：请先撤销或轮换，不得覆盖', 'keyRef');
    }
    const record: MutableRecord = {
      keyRef,
      accountRef,
      provider,
      scopes,
      issuedAt,
      expiresAt,
      revokedAt: null,
      installId,
    };
    this.#records.set(keyRef, record);
    return toView(record);
  }

  /** 轮换：旧 keyRef 立即撤销，新 keyRef 承接同一账号/用途/范围。 */
  rotate(
    oldKeyRef: string,
    next: { readonly newKeyRef: string; readonly issuedAt: number; readonly expiresAt: number },
    now: number,
  ): { readonly old: CredentialView; readonly next: CredentialView } {
    const old = this.#records.get(oldKeyRef);
    if (old === undefined) {
      throw new CredentialError('unknown_key', '待轮换的 keyRef 不存在', 'keyRef');
    }
    this.revoke(oldKeyRef, now);
    const fresh = this.importCredential({
      keyRef: next?.newKeyRef,
      accountRef: old.accountRef,
      provider: old.provider,
      scopes: old.scopes,
      issuedAt: next?.issuedAt,
      expiresAt: next?.expiresAt,
    });
    return { old: toView(old), next: fresh };
  }

  /** 撤销（幂等：重复撤销不改变首次撤销时刻）。 */
  revoke(keyRef: string, now: number): CredentialView {
    const at = requireInteger(now, 'now');
    const record = this.#records.get(keyRef);
    if (record === undefined) {
      throw new CredentialError('unknown_key', '待撤销的 keyRef 不存在', 'keyRef');
    }
    if (record.revokedAt === null) {
      record.revokedAt = at;
    }
    return toView(record);
  }

  /** 当前状态（按 `now` 判定；`unknown` 表示从未登记或已被重装清空）。 */
  statusOf(keyRef: string, now: number): CredentialStatus {
    const record = this.#records.get(keyRef);
    if (record === undefined) {
      return 'unknown';
    }
    if (record.revokedAt !== null) {
      return 'revoked';
    }
    if (now < record.issuedAt) {
      return 'not_yet_valid';
    }
    if (now >= record.expiresAt) {
      return 'expired';
    }
    return 'active';
  }

  /** 只列出引用（**没有**导出任何秘密的方法）。 */
  listKeyRefs(): readonly string[] {
    return Object.freeze([...this.#records.keys()]);
  }

  /** 授权判定入口：**永不抛错**，所有否定都编码进 `reason`。 */
  authorize(request: AuthorizeRequest): AuthzDecision {
    const rawKeyRef = (request as { keyRef?: unknown })?.keyRef;
    const rawAccountRef = (request as { accountRef?: unknown })?.accountRef;
    const at = typeof (request as { now?: unknown })?.now === 'number' ? (request.now as number) : 0;

    if (typeof rawKeyRef !== 'string' || !KEY_REF_PATTERN.test(rawKeyRef)) {
      // 记录时用占位符：即便调用方误把明文当 keyRef，也不落进审计。
      this.#record('<invalid-key-ref>', null, false, 'invalid_key_ref', at);
      return { allowed: false, reason: 'invalid_key_ref', keyRef: '<invalid-key-ref>' };
    }
    const keyRef = rawKeyRef;
    if (typeof rawAccountRef !== 'string' || !ACCOUNT_REF_PATTERN.test(rawAccountRef)) {
      this.#record(keyRef, null, false, 'invalid_account_ref', at);
      return { allowed: false, reason: 'invalid_account_ref', keyRef };
    }
    const accountRef = rawAccountRef;

    const record = this.#records.get(keyRef);
    if (record === undefined) {
      this.#record(keyRef, accountRef, false, 'unknown_key', at);
      return { allowed: false, reason: 'unknown_key', keyRef };
    }
    if (record.revokedAt !== null) {
      this.#record(keyRef, accountRef, false, 'revoked', at);
      return { allowed: false, reason: 'revoked', keyRef };
    }
    if (at < record.issuedAt) {
      this.#record(keyRef, accountRef, false, 'not_yet_valid', at);
      return { allowed: false, reason: 'not_yet_valid', keyRef };
    }
    if (at >= record.expiresAt) {
      this.#record(keyRef, accountRef, false, 'expired', at);
      return { allowed: false, reason: 'expired', keyRef };
    }
    if (record.accountRef !== accountRef) {
      this.#record(keyRef, accountRef, false, 'account_mismatch', at);
      return { allowed: false, reason: 'account_mismatch', keyRef };
    }
    if (record.provider !== request.provider) {
      this.#record(keyRef, accountRef, false, 'provider_mismatch', at);
      return { allowed: false, reason: 'provider_mismatch', keyRef };
    }
    if (!record.scopes.includes(request.requiredScope)) {
      this.#record(keyRef, accountRef, false, 'scope_missing', at);
      return { allowed: false, reason: 'scope_missing', keyRef };
    }
    this.#record(keyRef, accountRef, true, null, at);
    const grant: AccessGrant = Object.freeze({
      keyRef,
      accountRef,
      provider: record.provider,
      scope: request.requiredScope,
      installId: record.installId,
      grantedAt: at,
      expiresAt: record.expiresAt,
    });
    return { allowed: true, grant };
  }

  /** 登记一个待执行动作（绑定当前活跃账号）。 */
  registerPendingAction(input: PendingActionRequest): PendingActionView {
    assertKnownKeys(input, ['actionRef', 'keyRef', 'scope', 'expiresAt'], 'registerPendingAction');
    if (this.#activeAccountRef === null) {
      throw new CredentialError('no_active_account', '尚未选择账号，不能登记待执行动作', 'accountRef');
    }
    const actionRef = requireRef(input?.actionRef, /^action:[A-Za-z0-9._:-]+$/, 'actionRef', '动作');
    const keyRef = requireRef(input?.keyRef, KEY_REF_PATTERN, 'keyRef', 'key');
    if (typeof input?.scope !== 'string' || input.scope.trim().length === 0) {
      throw new CredentialError('invalid_request', 'scope 必须是非空字符串', 'scope');
    }
    const expiresAt = requireInteger(input?.expiresAt, 'expiresAt');
    if (this.#pending.has(actionRef)) {
      throw new CredentialError('duplicate_action_ref', '该 actionRef 已登记', 'actionRef');
    }
    const record: PendingRecord = {
      actionRef,
      accountRef: this.#activeAccountRef,
      keyRef,
      scope: input.scope,
      expiresAt,
      state: 'pending',
      invalidationReason: null,
    };
    this.#pending.set(actionRef, record);
    return Object.freeze({ ...record });
  }

  /** 消费待执行动作（只有 `pending` 且未过期可消费）。 */
  consumePendingAction(actionRef: string, now: number): ConsumeDecision {
    const record = this.#pending.get(actionRef);
    if (record === undefined) {
      return { consumed: false, reason: 'unknown_action' };
    }
    if (record.state === 'consumed') {
      return { consumed: false, reason: 'consumed' };
    }
    if (record.state === 'invalidated') {
      return { consumed: false, reason: 'invalidated' };
    }
    if (now >= record.expiresAt) {
      record.state = 'invalidated';
      record.invalidationReason = 'expired';
      return { consumed: false, reason: 'expired' };
    }
    record.state = 'consumed';
    return { consumed: true, action: Object.freeze({ ...record }) };
  }

  getPendingAction(actionRef: string): PendingActionView | null {
    const record = this.#pending.get(actionRef);
    return record === undefined ? null : Object.freeze({ ...record });
  }

  /** 切换账号：**失效所有不属于新账号的待执行动作**。 */
  switchAccount(nextAccountRef: string, _now: number): SwitchAccountResult {
    const accountRef = requireRef(nextAccountRef, ACCOUNT_REF_PATTERN, 'accountRef', '账号');
    const previous = this.#activeAccountRef;
    const invalidated: string[] = [];
    for (const record of this.#pending.values()) {
      if (record.state === 'pending' && record.accountRef !== accountRef) {
        record.state = 'invalidated';
        record.invalidationReason = 'account_switched';
        invalidated.push(record.actionRef);
      }
    }
    this.#activeAccountRef = accountRef;
    return Object.freeze({
      previousAccountRef: previous,
      activeAccountRef: accountRef,
      invalidatedActionRefs: Object.freeze(invalidated),
    });
  }

  /**
   * 手机重装：清空全部凭证、换 `installId`、失效全部待执行动作。
   * 返回被清掉的引用清单（只含引用，便于交接与复核）。
   */
  reinstall(nextInstallId: string, _now: number): ReinstallResult {
    const installId = requireRef(nextInstallId, INSTALL_ID_PATTERN, 'installId', '安装实例');
    if (installId === this.#installId) {
      throw new CredentialError('invalid_request', '重装后的 installId 必须变化', 'installId');
    }
    const wipedKeyRefs = Object.freeze([...this.#records.keys()]);
    this.#records.clear();
    const invalidated: string[] = [];
    for (const record of this.#pending.values()) {
      if (record.state === 'pending') {
        record.state = 'invalidated';
        record.invalidationReason = 'reinstalled';
        invalidated.push(record.actionRef);
      }
    }
    const previousInstallId = this.#installId;
    this.#installId = installId;
    this.#activeAccountRef = null;
    return Object.freeze({
      previousInstallId,
      installId,
      wipedKeyRefs,
      invalidatedActionRefs: Object.freeze(invalidated),
    });
  }

  /** 审计日志（只读副本；只含引用与判定）。 */
  auditLog(): readonly AuditEntry[] {
    return Object.freeze(this.#audit.map((entry) => Object.freeze({ ...entry })));
  }

  #record(keyRef: string, accountRef: string | null, allowed: boolean, reason: DenyReason | null, at: number): void {
    this.#audit.push({ seq: this.#audit.length + 1, keyRef, accountRef, allowed, reason, at });
  }
}

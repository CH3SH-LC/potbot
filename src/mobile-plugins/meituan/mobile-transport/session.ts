/**
 * M02 —— 会话 / 刷新 / 撤销状态机。
 *
 * ## 洞：撤销或过期之后还能继续用
 *
 * 常见失误是把"曾经换到过令牌"缓存成一次结论。若 `ensureActive()` 只看 cached
 * flag，撤销与过期就形同虚设。本状态机**每次都用调用方给的逻辑时钟重新判定**，
 * 从不缓存"曾经通过"。
 *
 * ## 洞：刷新变成隐式重登
 *
 * 平台可能只允许刷新有限次、或明确只允许刷新不能重铸。`refresh()` 只在会话
 * `active` 且 `refreshable` 时推进；`revoked` 之后**任何**刷新请求都被拒
 * （`session_unavailable(reason='revoked')`），不会静默回到 `active`。
 *
 * ## 洞：令牌泄漏
 *
 * 秘密令牌只存于私有字段，{@link SessionManager.snapshot} **结构上没有令牌字段**；
 * 日志 / 证据只出现 `tokenRef`（`sessref:...`）。取明文令牌的唯一出口
 * {@link SessionManager.ensureActive} 只供 `client.ts` 构造 Authorization 头。
 *
 * 本模块是**进程内**状态机，供 fixture 独立驱动；持久化与原生密钥库由 K03 注入。
 */

import { isSessionRef } from './keyref.js';
import type {
  ActiveSession,
  MintedSession,
  SessionMinterPort,
  SessionSnapshot,
  SessionState,
  TransportCredential,
} from './types.js';
import { SessionUnavailableError } from './errors.js';

/** `open()` 入参。 */
export interface OpenSessionInput {
  readonly keyRef: string;
  readonly accountRef: string;
  readonly credential: TransportCredential;
  readonly now: number;
}

/** `refresh()` 入参（凭证需重新解析，明文只在请求期存在）。 */
export interface RefreshSessionInput {
  readonly credential: TransportCredential;
  readonly now: number;
}

function assertMinted(minted: MintedSession): void {
  if (minted === null || typeof minted !== 'object') {
    throw new SessionUnavailableError('absent', '会话铸造端口未返回可解释的会话对象');
  }
  if (!isSessionRef(minted.tokenRef)) {
    throw new SessionUnavailableError('absent', '铸造端口返回的 tokenRef 形状非法（须为 sessref:...）');
  }
  if (typeof minted.token !== 'string' || minted.token.length === 0) {
    throw new SessionUnavailableError('absent', '铸造端口未返回令牌材料');
  }
  if (!Number.isSafeInteger(minted.expiresAt)) {
    throw new SessionUnavailableError('absent', '铸造端口未返回整数过期时刻');
  }
  if (!Array.isArray(minted.scopes)) {
    throw new SessionUnavailableError('absent', '铸造端口未返回 scope 列表');
  }
}

/**
 * 会话状态机。线程 / 并发由单进程串行 `await` 保证：`open`/`refresh` 期间状态置为
 * `refreshing`，重入的刷新请求被拒。
 */
export class SessionManager {
  readonly #minter: SessionMinterPort;
  #state: SessionState = 'idle';
  #token: string | null = null;
  #tokenRef: string | null = null;
  #keyRef: string | null = null;
  #accountRef: string | null = null;
  #scopes: readonly string[] = Object.freeze([]);
  #issuedAt: number | null = null;
  #expiresAt: number | null = null;
  #revokedAt: number | null = null;
  #refreshable = false;
  #refreshCount = 0;

  constructor(minter: SessionMinterPort) {
    if (minter === null || typeof minter !== 'object' || typeof minter.mint !== 'function') {
      throw new TypeError('SessionManager 需要注入 SessionMinterPort');
    }
    this.#minter = minter;
  }

  get state(): SessionState {
    return this.#state;
  }

  /** 建立会话（从 `idle` / `expired` / `revoked` 起步；已在 `active` 时抛错）。 */
  async open(input: OpenSessionInput): Promise<SessionSnapshot> {
    if (this.#state === 'active' || this.#state === 'refreshing') {
      throw new SessionUnavailableError('absent', `会话已处于 ${this.#state}，不能重复 open`);
    }
    const minted = await this.#minter.mint({
      keyRef: input.keyRef,
      accountRef: input.accountRef,
      credential: input.credential,
      now: input.now,
      previousTokenRef: this.#tokenRef,
    });
    assertMinted(minted);
    this.#token = minted.token;
    this.#tokenRef = minted.tokenRef;
    this.#keyRef = input.keyRef;
    this.#accountRef = input.accountRef;
    this.#scopes = Object.freeze([...minted.scopes]);
    this.#issuedAt = input.now;
    this.#expiresAt = minted.expiresAt;
    this.#revokedAt = null;
    this.#refreshable = minted.refreshable === true;
    this.#state = 'active';
    return this.snapshot();
  }

  /**
   * 取活跃会话用于发请求。**每次重新判定**：
   * - `revoked` ⇒ 抛 `session_unavailable(revoked)`（永不自动重登）；
   * - `expired` / 已过 `expiresAt` ⇒ 抛 `expired`；
   * - `idle` / `refreshing` ⇒ 抛 `absent` / `refreshing`；
   * - 传入 `requiredScope` 而会话不含 ⇒ 抛 `scope_missing`。
   */
  ensureActive(now: number, requiredScope?: string): ActiveSession {
    if (this.#state === 'revoked') {
      throw new SessionUnavailableError('revoked', '会话已撤销：拒绝发出业务请求（不自动重登）');
    }
    if (this.#state === 'refreshing') {
      throw new SessionUnavailableError('refreshing', '会话正在刷新：拒绝并发请求');
    }
    if (this.#state !== 'active') {
      throw new SessionUnavailableError('absent', `会话未建立（state=${this.#state}）`);
    }
    if (this.#expiresAt !== null && now >= this.#expiresAt) {
      // 就地落到 expired，且**不**清掉 tokenRef（便于证据记录）；但下次 ensureActive 必拒。
      this.#state = 'expired';
      throw new SessionUnavailableError('expired', '会话已过期：须显式 refresh / open，不静默重铸');
    }
    if (requiredScope !== undefined && !this.#scopes.includes(requiredScope)) {
      throw new SessionUnavailableError('scope_missing', `会话 scope 不含所需 "${requiredScope}"`);
    }
    if (this.#token === null || this.#tokenRef === null || this.#accountRef === null || this.#expiresAt === null) {
      throw new SessionUnavailableError('absent', '会话内部状态不完整');
    }
    return Object.freeze({
      tokenRef: this.#tokenRef,
      token: this.#token,
      accountRef: this.#accountRef,
      scopes: this.#scopes,
      expiresAt: this.#expiresAt,
    });
  }

  /**
   * 刷新会话（轮换令牌）。仅 `active` 且可刷新时成功；`revoked` 一律拒绝。
   * 刷新期间状态为 `refreshing`，失败则落到 `expired`（不静默重铸）。
   */
  async refresh(input: RefreshSessionInput): Promise<SessionSnapshot> {
    if (this.#state === 'revoked') {
      throw new SessionUnavailableError('revoked', '会话已撤销：刷新被拒（不自动重登）');
    }
    if (this.#state === 'refreshing') {
      throw new SessionUnavailableError('refreshing', '会话正在刷新：拒绝并发刷新');
    }
    if (this.#state !== 'active') {
      throw new SessionUnavailableError('absent', `会话未建立（state=${this.#state}）`);
    }
    if (!this.#refreshable) {
      this.#state = 'expired';
      throw new SessionUnavailableError('not_refreshable', '会话不支持刷新：到期即过期，不静默重铸');
    }
    if (this.#keyRef === null || this.#accountRef === null) {
      throw new SessionUnavailableError('absent', '会话缺少 keyRef / accountRef，无法刷新');
    }
    const previousTokenRef = this.#tokenRef;
    this.#state = 'refreshing';
    let minted: MintedSession;
    try {
      minted = await this.#minter.mint({
        keyRef: this.#keyRef,
        accountRef: this.#accountRef,
        credential: input.credential,
        now: input.now,
        previousTokenRef,
      });
      assertMinted(minted);
    } catch (error) {
      this.#state = 'expired';
      this.#token = null;
      throw error;
    }
    this.#token = minted.token;
    this.#tokenRef = minted.tokenRef;
    this.#scopes = Object.freeze([...minted.scopes]);
    this.#issuedAt = input.now;
    this.#expiresAt = minted.expiresAt;
    this.#refreshable = minted.refreshable === true;
    this.#refreshCount += 1;
    this.#state = 'active';
    return this.snapshot();
  }

  /**
   * 撤销会话（幂等：重复撤销不改变首次撤销时刻）。撤销后 `ensureActive` 必拒，
   * 且**不提供**自动恢复路径——恢复只能由调用方显式重新 `open()` 并重新解析凭证。
   */
  revoke(now: number): SessionSnapshot {
    if (this.#revokedAt === null) {
      this.#revokedAt = now;
    }
    this.#state = 'revoked';
    this.#token = null;
    return this.snapshot();
  }

  /** 对外快照（**无令牌字段**）。 */
  snapshot(): SessionSnapshot {
    return Object.freeze({
      state: this.#state,
      tokenRef: this.#tokenRef,
      keyRef: this.#keyRef,
      accountRef: this.#accountRef,
      scopes: this.#scopes,
      issuedAt: this.#issuedAt,
      expiresAt: this.#expiresAt,
      revokedAt: this.#revokedAt,
      refreshCount: this.#refreshCount,
    });
  }
}

/**
 * K-I08 账本持久化适配层 —— **K07 授权 / 提交账本的落盘与冷启动恢复**。
 *
 * ## 问题：K07 的账本是"单进程内存结构"，没有快照出口
 *
 * `AuthorizationLedger`（`apps/mobile-kernel/actions/ledger.ts`）的全部状态都在模块私有的
 * `Map` 里，且**可信根**（确认凭证 / 回执）是模块私有的 `WeakSet` 成员——调用方**无法**
 * 凭形状相同的对象重建一张授权（`untrusted_attestation`）或回执（`untrusted_receipt`）。
 * 这是它最要紧的安全属性，也意味着**不存在**"把记录塞回账本"的后门。
 *
 * 因此本适配器**不**去伪造内部状态，而是采取一条与 K07 同构的路线：**只追加操作日志 +
 * 用公开方法重放**。每次调用都记一条事件，冷启动时用注入时钟 + 受控执行器把这些事件
 * **按序重放**到一个全新的 `AuthorizationLedger` 上，让账本自己的状态机重建状态。
 * 组装的凭证走它自己的 `attest()`，回执走它自己的 `createTrustedReceipt()`——可信根
 * 依旧是账本签的，本层一个字节都没伪造。
 *
 * ## "不得重发 / 不得另发授权"是怎么被机器化保证的
 *
 * 崩溃恢复最危险的一件事，是把"已经发出去、结果未知"的提交当成"还没发"，于是重发一次下单。
 * 本层用一条**写前日志（write-ahead）**堵住它：
 *
 * - `send()` 先在日志里落一条 `send-attempt` **并 flush**，**之后**才调用账本真正发出；
 * - 于是任何**真的调用了执行器**的发送，磁盘上必有一条 `send-attempt`；
 * - 冷启动重放时：有配对 `send-outcome` 的按记录结果复原；**没有配对结果的**（崩在发出途中）
 *   按"已发出未知"复原（重放屏障让 `sendIntentAt` 落定、执行器**不会被真正调用**）。
 *
 * 复原后，`recover()` 只会给出"查原单"（`query_original_order`），
 * `mayIssueNewGrant` / `mayCreateNewSubmission` 恒为 `false`；`send()` 再调会抛
 * `already_sent_query_only`，`consume()` 会抛 `grant_already_consumed`，`issueGrant()` 会抛
 * `grant_already_issued`——**重发与另发授权在 API 层不可表达**。
 *
 * 其余操作（确认 / 发行 / 占用 / 回执 / 撤权）采用**写后日志**：崩溃丢掉一条只会让恢复出的
 * 状态**更保守**（少一张授权、少一条占用），不会导致任何对外副作用被重做——因此是 fail-closed。
 *
 * ## 明确的保真度边界（如实登记，不当成已完成）
 *
 * - 重放用**注入时钟**把各时点钉到记录值，因此 `issuedAt` / `consumedAt` / `sendIntentAt`
 *   等复原一致；`sentAt` 在"发出且受理"的记录里会与 `sendIntentAt` 相等（原实现两次读钟，
 *   重放只钉一个值）——这是刻意的取整，判据（`sendIntentAt !== null`）不受影响。
 * - 现场用**真实** `ExternalExecutorPort`；重放用受控执行器，**永不**触碰真实端口。
 */

import { AuthorizationError } from '../../actions/errors.js';
import { AuthorizationLedger, createTrustedReceipt } from '../../actions/ledger.js';
import { bindingOf } from '../../actions/types.js';
import type {
  ActionBinding,
  AuthorizationGrant,
  ConfirmAction,
  ConfirmationAttestation,
  ConsumeInput,
  ConsumeOutcome,
  ExternalExecutorPort,
  ExternalOutcomeDescription,
  ExternalReceipt,
  ExternalSubmitRequest,
  OrderQueryPort,
  ReconciliationOutcome,
  RecoveryVerdict,
  SubmissionRecord,
  SubmissionState,
} from '../../actions/types.js';
import type { Clock } from '../../actions/clock.js';
import { isLedgerStoreError, invalidSnapshot, LedgerStoreError } from './errors.js';
import { LedgerBlobStore } from './blob-port.js';
import { decodeEnvelope, encodeEnvelope } from './snapshot-envelope.js';

/** 授权账本在持久化介质上的相对路径。 */
export const AUTHORIZATION_LEDGER_KEY = 'ledgers/authorization-ledger.v1.json';

// ---------------------------------------------------------------------------
// 事件词表
// ---------------------------------------------------------------------------

/** 一次 `send` 完成后记录的可观测结果（用于冷启动重放）。 */
export interface SendOutcomeEvent {
  readonly kind: 'send-outcome';
  readonly submissionId: string;
  readonly sendIntentAt: number;
  readonly state: SubmissionState;
  readonly sentAt: number | null;
  readonly failureReason: string | null;
}

/** 授权 / 提交账本的只追加操作日志。 */
export type AuthJournalEvent =
  | { readonly kind: 'confirm-recorded'; readonly confirm: ConfirmAction }
  | {
      readonly kind: 'confirm-amended';
      readonly taskId: string;
      readonly actionId: string;
      readonly confirm: ConfirmAction;
    }
  | {
      readonly kind: 'grant-issued';
      readonly taskId: string;
      readonly actionId: string;
      readonly surface: string;
      readonly grantId: string;
      readonly at: number;
    }
  | {
      readonly kind: 'grant-consumed';
      readonly grantId: string;
      readonly submissionId: string;
      readonly actual: ActionBinding;
      readonly at: number;
    }
  | { readonly kind: 'send-attempt'; readonly submissionId: string; readonly at: number }
  | SendOutcomeEvent
  | { readonly kind: 'send-aborted'; readonly submissionId: string }
  | { readonly kind: 'receipt-observed'; readonly submissionId: string; readonly receipt: ExternalReceipt; readonly at: number }
  | { readonly kind: 'revoked'; readonly taskId: string; readonly actionId: string; readonly reason: string; readonly at: number };

const EVENT_KINDS = [
  'confirm-recorded',
  'confirm-amended',
  'grant-issued',
  'grant-consumed',
  'send-attempt',
  'send-outcome',
  'send-aborted',
  'receipt-observed',
  'revoked',
] as const;

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

/** 授权账本日志的持久化。 */
export class AuthorizationLedgerStore {
  readonly #blob: LedgerBlobStore;

  constructor(blob: LedgerBlobStore) {
    this.#blob = blob;
  }

  get key(): string {
    return this.#blob.key;
  }

  async load(): Promise<readonly AuthJournalEvent[] | null> {
    const text = await this.#blob.load();
    if (text === null) {
      return null;
    }
    const payload = decodeEnvelope(text, 'authorization');
    return parseJournal(payload);
  }

  async save(events: readonly AuthJournalEvent[]): Promise<void> {
    await this.#blob.save(encodeEnvelope('authorization', events));
  }

  async clear(): Promise<void> {
    await this.#blob.clear();
  }
}

/** 工厂：一个 K09 `StoragePort` 之上的授权账本存储。 */
export function createAuthorizationLedgerStore(blob: LedgerBlobStore): AuthorizationLedgerStore {
  return new AuthorizationLedgerStore(blob);
}

/** 校验日志形状（**只做结构核对**；内容由账本重放时自行拒绝）。 */
export function parseJournal(payload: unknown): readonly AuthJournalEvent[] {
  if (!Array.isArray(payload)) {
    throw invalidSnapshot('partial', '授权账本日志 payload 必须是数组（典型是截断的 partial 快照）');
  }
  return payload.map((raw, index) => validateEvent(raw, index));
}

function validateEvent(raw: unknown, index: number): AuthJournalEvent {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidSnapshot('unreadable-event', `授权账本日志第 ${String(index)} 条不是对象`, String(index));
  }
  const kind = (raw as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !(EVENT_KINDS as readonly string[]).includes(kind)) {
    throw invalidSnapshot('unreadable-event', `授权账本日志第 ${String(index)} 条 kind 非法：${String(kind)}`, String(index));
  }
  return raw as AuthJournalEvent;
}

// ---------------------------------------------------------------------------
// 受控执行器（重放屏障 + 现场转发）
// ---------------------------------------------------------------------------

type ReplayScript = { readonly kind: 'outcome'; readonly value: ExternalExecutorOutcome } | { readonly kind: 'died' };
type ExternalExecutorOutcome =
  | { readonly outcome: 'accepted' }
  | { readonly outcome: 'failed'; readonly reason: string }
  | { readonly outcome: 'unknown'; readonly detail: string };

/**
 * 受控执行器：重放期按脚本作答（**绝不触碰网络**），重放结束后转发给真实端口。
 *
 * 重放期若收到**未编排**的调用，说明重放与记录对不上，立即抛 `invalid_snapshot(divergence)`。
 */
class ControlledExecutor implements ExternalExecutorPort {
  readonly identity = 'ledger-store.controlled';
  #script: ReplayScript | null = null;
  #live = false;
  #real: ExternalExecutorPort | null = null;

  arm(script: ReplayScript): void {
    this.#script = script;
  }

  disarm(): void {
    this.#script = null;
  }

  attachLive(real: ExternalExecutorPort | null): void {
    this.#real = real;
    this.#live = true;
    this.#script = null;
  }

  send(request: ExternalSubmitRequest): ExternalExecutorOutcome {
    if (this.#live) {
      const real = this.#real;
      if (real === null) {
        // 现场未装配执行器：与 K07 同码（在任何"发出意图"落账**之前**就该被上层的门禁拦下）。
        throw new AuthorizationError('missing_executor', '受控执行器已切到现场模式，但未接真实端口');
      }
      return real.send(request) as ExternalExecutorOutcome;
    }
    const script = this.#script;
    if (script === null) {
      throw invalidSnapshot('divergence', `重放期收到未编排的执行器调用（提交 ${request.submissionId}）`);
    }
    if (script.kind === 'died') {
      throw new LedgerStoreError('replay_barrier', '重放屏障：按记录模拟"发出途中死亡"', {
        subject: request.submissionId,
      });
    }
    return script.value;
  }
}

// ---------------------------------------------------------------------------
// 重放
// ---------------------------------------------------------------------------

interface ReplayResult {
  readonly ledger: AuthorizationLedger;
  readonly executor: ControlledExecutor;
}

async function replayJournal(
  events: readonly AuthJournalEvent[],
  options: DurableAuthorizationLedgerOptions,
): Promise<ReplayResult> {
  const state = { now: 0 };
  const clock: Clock = { now: () => state.now };
  const executor = new ControlledExecutor();
  const ledger = new AuthorizationLedger({
    clock,
    executor,
    orderQuery: options.orderQuery ?? null,
    nextGrantId: options.nextGrantId,
    nextSubmissionId: options.nextSubmissionId,
  });

  try {
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i]!;
      switch (event.kind) {
        case 'confirm-recorded':
          ledger.recordConfirmAction(event.confirm);
          break;
        case 'confirm-amended':
          ledger.amendConfirmAction(event.taskId, event.actionId, event.confirm);
          break;
        case 'grant-issued': {
          state.now = event.at;
          const attestation = ledger.attest(event.taskId, event.actionId, { surface: event.surface });
          const grant = ledger.issueGrant(attestation);
          if (grant.grantId !== event.grantId) {
            throw invalidSnapshot('divergence', `重放出的 grantId=${grant.grantId} 与记录的 ${event.grantId} 不符`);
          }
          break;
        }
        case 'grant-consumed': {
          state.now = event.at;
          const outcome = ledger.consume({ grantId: event.grantId, actual: event.actual });
          if (outcome.submission.submissionId !== event.submissionId) {
            throw invalidSnapshot(
              'divergence',
              `重放出的 submissionId=${outcome.submission.submissionId} 与记录的 ${event.submissionId} 不符`,
            );
          }
          break;
        }
        case 'send-attempt': {
          const next = events[i + 1];
          if (next !== undefined && next.kind === 'send-outcome' && next.submissionId === event.submissionId) {
            i += 1;
            await replaySend(ledger, executor, state, event.submissionId, next);
          } else if (next !== undefined && next.kind === 'send-aborted' && next.submissionId === event.submissionId) {
            i += 1;
            await replaySendAborted(ledger, executor, state, event.submissionId, event.at);
          } else {
            // 只有 send-attempt、没有配对结果 = 崩在发出途中：保守复原为"已发出未知"。
            await replaySendDied(ledger, executor, state, event.submissionId, event.at);
          }
          break;
        }
        case 'receipt-observed': {
          state.now = event.at;
          ledger.observe(event.submissionId, createTrustedReceipt(event.receipt));
          break;
        }
        case 'revoked': {
          state.now = event.at;
          ledger.revoke(event.taskId, event.actionId, event.reason);
          break;
        }
        case 'send-outcome':
        case 'send-aborted':
          throw invalidSnapshot('divergence', `孤立的 ${event.kind} 事件（缺配对的 send-attempt）`);
        default:
          throw invalidSnapshot('unreadable-event', `无法解读的事件：${JSON.stringify(event)}`);
      }
    }
  } catch (error) {
    if (isLedgerStoreError(error)) {
      throw error;
    }
    throw invalidSnapshot('divergence', `授权账本快照重放失败：${describe(error)}`);
  }

  return { ledger, executor };
}

async function replaySend(
  ledger: AuthorizationLedger,
  executor: ControlledExecutor,
  state: { now: number },
  submissionId: string,
  outcome: SendOutcomeEvent,
): Promise<void> {
  const script = scriptFor(outcome);
  state.now = outcome.sendIntentAt;
  executor.arm(script);
  try {
    await ledger.send(submissionId);
    if (script.kind === 'died') {
      throw invalidSnapshot('divergence', `记录为"死亡"的发送却成功返回（提交 ${submissionId}）`);
    }
  } catch (error) {
    if (script.kind !== 'died' || !isReplayBarrier(error)) {
      throw error;
    }
  } finally {
    executor.disarm();
  }
  const restored = ledger.getSubmission(submissionId);
  if (restored === undefined || restored.sendIntentAt !== outcome.sendIntentAt) {
    throw invalidSnapshot(
      'divergence',
      `重放后的发送意图 ${String(restored?.sendIntentAt)} 与记录的 ${outcome.sendIntentAt} 不符（提交 ${submissionId}）`,
    );
  }
}

async function replaySendAborted(
  ledger: AuthorizationLedger,
  executor: ControlledExecutor,
  state: { now: number },
  submissionId: string,
  at: number,
): Promise<void> {
  state.now = at;
  // 记录为"在触达执行器之前就被拒"：不应留下发出意图。若账本竟走到执行器，屏障会抛错。
  executor.arm({ kind: 'died' });
  try {
    await ledger.send(submissionId);
    throw invalidSnapshot('divergence', `记录为"发送被拒"的调用却成功返回（提交 ${submissionId}）`);
  } catch (error) {
    if (!isReplayBarrier(error) && !isExpectedRejection(error)) {
      throw error;
    }
  } finally {
    executor.disarm();
  }
  const restored = ledger.getSubmission(submissionId);
  if (restored !== undefined && restored.sendIntentAt !== null) {
    throw invalidSnapshot('divergence', `"被拒"的发送竟留下了发出意图（提交 ${submissionId}）：拒绝复原`);
  }
}

async function replaySendDied(
  ledger: AuthorizationLedger,
  executor: ControlledExecutor,
  state: { now: number },
  submissionId: string,
  at: number,
): Promise<void> {
  state.now = at;
  executor.arm({ kind: 'died' });
  try {
    await ledger.send(submissionId);
    throw invalidSnapshot('divergence', `无配对结果的发送却成功返回（提交 ${submissionId}）`);
  } catch (error) {
    if (!isReplayBarrier(error) && !isExpectedRejection(error)) {
      throw error;
    }
  } finally {
    executor.disarm();
  }
  const restored = ledger.getSubmission(submissionId);
  if (restored === undefined || restored.sendIntentAt === null) {
    throw invalidSnapshot('divergence', `无配对结果的发送没有留下发出意图（提交 ${submissionId}）：拒绝复原`);
  }
}

function scriptFor(outcome: SendOutcomeEvent): ReplayScript {
  if (outcome.state === 'submitted') {
    return { kind: 'outcome', value: { outcome: 'accepted' } };
  }
  if (outcome.state === 'unknown') {
    return { kind: 'outcome', value: { outcome: 'unknown', detail: outcome.failureReason ?? '' } };
  }
  if (outcome.state === 'failed') {
    return { kind: 'outcome', value: { outcome: 'failed', reason: outcome.failureReason ?? 'failed' } };
  }
  if (outcome.state === 'submitting') {
    return { kind: 'died' };
  }
  throw invalidSnapshot('divergence', `不支持的已记录发送状态：${outcome.state}`);
}

function isReplayBarrier(error: unknown): boolean {
  return isLedgerStoreError(error) && error.code === 'replay_barrier';
}

/** K07 在执行器之前就拒绝时抛的码（撤销 / 过期 / 状态机 / 缺执行器）。 */
function isExpectedRejection(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ['grant_revoked', 'grant_expired', 'illegal_submission_transition', 'already_sent_query_only', 'missing_executor', 'submission_not_found', 'grant_not_found'].includes(
      String((error as { code: unknown }).code),
    )
  );
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

// ---------------------------------------------------------------------------
// 门面
// ---------------------------------------------------------------------------

export interface DurableAuthorizationLedgerOptions {
  /** **必须注入**：现场与重放共用（重放时用作各事件的钉位值来源）。 */
  readonly clock: Clock;
  /** 真实执行器端口。缺省 / `null` ⇒ `send()` 抛 `missing_executor`（且不写任何"发出意图"）。 */
  readonly executor?: ExternalExecutorPort | null;
  /** 原单查询端口。缺省 / `null` ⇒ 结果未知时抛 `missing_order_query_port`（如实报缺）。 */
  readonly orderQuery?: OrderQueryPort | null;
  /** 授权 id 生成器（**恢复时必须与现场一致**，否则重放对不上）。 */
  readonly nextGrantId?: (taskId: string, actionId: string) => string;
  /** 提交 id 生成器（**恢复时必须与现场一致**）。 */
  readonly nextSubmissionId?: (taskId: string, actionId: string) => string;
  /** 持久化存储。 */
  readonly store: AuthorizationLedgerStore;
}

/**
 * 可持久化的授权 / 提交账本门面：内部持有一个真实 `AuthorizationLedger`，
 * 每次变更追加一条事件并落盘；`open()` 从盘上日志重放复原。
 *
 * 调用方应把本门面当作账本本身使用（读方法直接转发）。
 */
export class DurableAuthorizationLedger {
  readonly #ledger: AuthorizationLedger;
  readonly #store: AuthorizationLedgerStore;
  readonly #clock: Clock;
  readonly #executor: ExternalExecutorPort | null;
  #events: AuthJournalEvent[];

  private constructor(
    ledger: AuthorizationLedger,
    store: AuthorizationLedgerStore,
    events: AuthJournalEvent[],
    options: DurableAuthorizationLedgerOptions,
  ) {
    this.#ledger = ledger;
    this.#store = store;
    this.#events = events;
    this.#clock = options.clock;
    this.#executor = options.executor ?? null;
  }

  /** 全新账本（盘上无日志或调用方选择从头开始）。会落一份空日志以建立基线。 */
  static async create(options: DurableAuthorizationLedgerOptions): Promise<DurableAuthorizationLedger> {
    const ledger = new AuthorizationLedger({
      clock: options.clock,
      executor: options.executor ?? null,
      orderQuery: options.orderQuery ?? null,
      nextGrantId: options.nextGrantId,
      nextSubmissionId: options.nextSubmissionId,
    });
    const durable = new DurableAuthorizationLedger(ledger, options.store, [], options);
    await durable.#store.save(durable.#events);
    return durable;
  }

  /**
   * 冷启动恢复：盘上**无日志** ⇒ `null`（干净起点）；有日志 ⇒ 重放复原。
   * 日志任何一处损坏 / 重放对不上 ⇒ `invalid_snapshot`，**绝不返回空账本**。
   */
  static async open(options: DurableAuthorizationLedgerOptions): Promise<DurableAuthorizationLedger | null> {
    const events = await options.store.load();
    if (events === null) {
      return null;
    }
    const replay = await replayJournal(events, options);
    replay.executor.attachLive(options.executor ?? null);
    return new DurableAuthorizationLedger(replay.ledger, options.store, [...events], options);
  }

  /** 恢复或新建（集成入口常用）。 */
  static async openOrCreate(options: DurableAuthorizationLedgerOptions): Promise<DurableAuthorizationLedger> {
    return (await DurableAuthorizationLedger.open(options)) ?? DurableAuthorizationLedger.create(options);
  }

  /** 当前只追加日志（只读副本）。 */
  journal(): readonly AuthJournalEvent[] {
    return Object.freeze([...this.#events]);
  }

  // -------------------------------------------------------------------------
  // 变更（写日志；send 额外走写前日志）
  // -------------------------------------------------------------------------

  async recordConfirmAction(input: ConfirmAction): Promise<ConfirmAction> {
    const confirm = this.#ledger.recordConfirmAction(input);
    await this.#append({ kind: 'confirm-recorded', confirm });
    return confirm;
  }

  async amendConfirmAction(taskId: string, actionId: string, next: ConfirmAction): Promise<ConfirmAction> {
    const amended = this.#ledger.amendConfirmAction(taskId, actionId, next);
    await this.#append({ kind: 'confirm-amended', taskId, actionId, confirm: amended });
    return amended;
  }

  /** 签发确认凭证（**瞬态、不落盘**）：其效果由随后的 `issueGrant` 落成 `grant-issued`。 */
  attest(
    taskId: string,
    actionId: string,
    options: { readonly surface: string; readonly claim?: Partial<ActionBinding> },
  ): ConfirmationAttestation {
    return this.#ledger.attest(taskId, actionId, options);
  }

  async issueGrant(attestation: ConfirmationAttestation): Promise<AuthorizationGrant> {
    const grant = this.#ledger.issueGrant(attestation);
    await this.#append({
      kind: 'grant-issued',
      taskId: grant.taskId,
      actionId: grant.actionId,
      surface: grant.grantedBy,
      grantId: grant.grantId,
      at: grant.issuedAt,
    });
    return grant;
  }

  async consume(input: ConsumeInput): Promise<ConsumeOutcome> {
    const outcome = this.#ledger.consume(input);
    const consumedAt = outcome.grant.consumedAt;
    await this.#append({
      kind: 'grant-consumed',
      grantId: outcome.grant.grantId,
      submissionId: outcome.submission.submissionId,
      actual: bindingOf(outcome.grant),
      at: consumedAt ?? this.#clock.now(),
    });
    return outcome;
  }

  /**
   * 发出：**先落写前意图再发出**（见文件头）。任何一次真的调用执行器的发送，磁盘上必先有
   * `send-attempt`；完成后再落 `send-outcome`；若在触达执行器之前被拒，落 `send-aborted`。
   */
  async send(submissionId: string): Promise<SubmissionRecord> {
    if (this.#executor === null) {
      // 与 K07 同码：缺执行器时**不**留下任何"发出意图"。
      throw new AuthorizationError(
        'missing_executor',
        `未装配执行器：提交 ${submissionId} 保持未发出（缺执行器不能签完成令牌）`,
      );
    }
    const before = this.#ledger.getSubmission(submissionId);
    // 写前日志：只在"确实还没有发出意图、且提交存在"时才落意图，避免留下假意图。
    const willAttempt = before !== undefined && before.sendIntentAt === null;
    if (willAttempt) {
      await this.#append({ kind: 'send-attempt', submissionId, at: this.#clock.now() });
    }
    try {
      const record = await this.#ledger.send(submissionId);
      if (willAttempt) {
        await this.#append(outcomeEvent(record));
      }
      return record;
    } catch (error) {
      if (willAttempt) {
        const after = this.#ledger.getSubmission(submissionId);
        if (after !== undefined && after.sendIntentAt !== null) {
          await this.#append(outcomeEvent(after));
        } else {
          await this.#append({ kind: 'send-aborted', submissionId });
        }
      }
      throw error;
    }
  }

  async observe(submissionId: string, receipt: ExternalReceipt): Promise<SubmissionRecord> {
    const record = this.#ledger.observe(submissionId, receipt);
    if (record.receipt !== null) {
      await this.#append({ kind: 'receipt-observed', submissionId, receipt: record.receipt, at: record.updatedAt });
    }
    return record;
  }

  async queryOriginalOrder(submissionId: string): Promise<{ readonly queried: boolean; readonly submission: SubmissionRecord }> {
    const before = this.#ledger.getSubmission(submissionId);
    const result = await this.#ledger.queryOriginalOrder(submissionId);
    const after = result.submission;
    if (after.receipt !== null && (before === undefined || before.state !== after.state || before.receipt !== after.receipt)) {
      await this.#append({ kind: 'receipt-observed', submissionId, receipt: after.receipt, at: after.updatedAt });
    }
    return result;
  }

  async revoke(
    taskId: string,
    actionId: string,
    reason: string,
  ): Promise<{
    readonly taskId: string;
    readonly actionId: string;
    readonly grant: AuthorizationGrant | null;
    readonly submission: SubmissionRecord | null;
  }> {
    const outcome = this.#ledger.revoke(taskId, actionId, reason);
    await this.#append({
      kind: 'revoked',
      taskId,
      actionId,
      reason,
      at: outcome.grant?.revokedAt ?? outcome.submission?.updatedAt ?? this.#clock.now(),
    });
    return outcome;
  }

  // -------------------------------------------------------------------------
  // 只读转发
  // -------------------------------------------------------------------------

  getConfirmAction(taskId: string, actionId: string): ConfirmAction | undefined {
    return this.#ledger.getConfirmAction(taskId, actionId);
  }

  getDisplay(
    taskId: string,
    actionId: string,
    claim?: Partial<ActionBinding>,
  ): ReturnType<AuthorizationLedger['getDisplay']> {
    return this.#ledger.getDisplay(taskId, actionId, claim);
  }

  getGrant(grantId: string): AuthorizationGrant | undefined {
    return this.#ledger.getGrant(grantId);
  }

  grantForAction(taskId: string, actionId: string): AuthorizationGrant | undefined {
    return this.#ledger.grantForAction(taskId, actionId);
  }

  getSubmission(submissionId: string): SubmissionRecord | undefined {
    return this.#ledger.getSubmission(submissionId);
  }

  submissionForAction(taskId: string, actionId: string): SubmissionRecord | undefined {
    return this.#ledger.submissionForAction(taskId, actionId);
  }

  recover(submissionId: string): RecoveryVerdict {
    return this.#ledger.recover(submissionId);
  }

  reconcileUnknown(submissionId: string): Promise<ReconciliationOutcome> {
    return this.#ledger.reconcileUnknown(submissionId);
  }

  observedStateOf(taskId: string, actionId: string): SubmissionState | null {
    return this.#ledger.observedStateOf(taskId, actionId);
  }

  describeExternalOutcome(submissionId: string): ExternalOutcomeDescription {
    return this.#ledger.describeExternalOutcome(submissionId);
  }

  assertCompletionClaimable(submissionId: string): void {
    this.#ledger.assertCompletionClaimable(submissionId);
  }

  isRevoked(taskId: string, actionId: string): boolean {
    return this.#ledger.isRevoked(taskId, actionId);
  }

  counts(): { readonly confirms: number; readonly grants: number; readonly submissions: number; readonly revoked: number } {
    return this.#ledger.counts();
  }

  allConfirmActions(): readonly ConfirmAction[] {
    return this.#ledger.allConfirmActions();
  }

  allGrants(): readonly AuthorizationGrant[] {
    return this.#ledger.allGrants();
  }

  allSubmissions(): readonly SubmissionRecord[] {
    return this.#ledger.allSubmissions();
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  async #append(event: AuthJournalEvent): Promise<void> {
    this.#events.push(event);
    await this.#store.save(this.#events);
  }
}

function outcomeEvent(record: SubmissionRecord): SendOutcomeEvent {
  return {
    kind: 'send-outcome',
    submissionId: record.submissionId,
    sendIntentAt: record.sendIntentAt ?? record.updatedAt,
    state: record.state,
    sentAt: record.sentAt,
    failureReason: record.failureReason,
  };
}

/**
 * 适配器**持久动作台账**入口（FA-X 第二件）—— 时钟 / 日历 / 美团三类动作统一进 `Store.actions`。
 *
 * ## 为什么要有这个文件（外部监督 S-1026-02 的问题）
 *
 * 第一件的 `adapters-host.ts` **自建了一个进程内内存账本**（`createActionLedger()`）：
 * 动作创建接受客户端自称的 `revision` 而不校验；`settle` 接受状态而无可信回执校验；
 * 这些动作**从不进入 `Store.actions`**——而任务完成视图（`task-completion.ts`）读的**正是**
 * `Store.actions`。于是"七态"只在 HTTP 边缘被 assert，**没有绑到内核的持久动作账本**。
 *
 * 本文件把动作统一到内核既有的一份账本上：`src/workledger/action-ledger.ts` 的
 * `ActionRecord`（绑任务 + 版本 + 参数摘要 + 幂等键 + 授权 + 可信回执），
 * 经 `src/scheduler/task-action-store.ts` 的接缝写进 `TransactionView.putActionRecord`。
 *
 * ## 四道闸门（全部**离线**可验，不需要设备 / 账号）
 *
 * | 闸门 | 拒绝理由（内核既有词汇） | 触发方式 |
 * |---|---|---|
 * | **授权** | `authorization_revoked` / `authorization_revision_mismatch` | 已撤权的动作不得转执行态 |
 * | **版本** | `stale_task_revision` | 动作绑的版本 ≠ 任务当前版本；且**不接受客户端自称的版本** |
 * | **幂等** | `idempotency_key_mismatch` | 同任务版本改参数却想沿用旧幂等键 |
 * | **回执** | `missing_trusted_receipt` | `confirmed_complete` 必须有可信回执；不可信回执即拒 |
 *
 * 本文件**不**自己实现七态、不自己算摘要、不自己推导幂等键——一律调用 `src/workledger`，
 * 因此入口表现与内核语义**不可能分叉**。
 *
 * ## 可信回执**只能**由服务端受控执行器建立（FA-TRUSTED-RECEIPT，P0 监督点名）
 *
 * 修复前的缺陷：HTTP 层把**客户端送来的** `receipt.trusted` 直接当成可信依据
 * （`receipt = { trusted: receiptRaw['trusted'] === true, ... }`）——于是客户端只要在
 * 请求体里写一个 `trusted: true`，就能让任意动作转 `confirmed_complete`。
 * 写进共享 `Store`、版本匹配、幂等键**都不能**证明回执来自真实执行。
 *
 * 修法（信任从客户端输入搬到服务端执行）：
 * 1. 宿主持有**受控执行器**（`ControlledActionExecutor`，**必须显式注入**；缺省=未装配=不可信）。
 *    它执行动作并产出回执，回执**绑定** `任务 / 修订 / 工具 / 参数摘要 / 执行身份 / 时刻`。
 * 2. `POST /api/adapters/actions/:id/execute` 触发执行器；执行成功则签发一枚
 *    **服务端随机 nonce**（`receiptToken`，进程内一次性）。它只是"这次执行发生过"的凭证，
 *    **本身不改变动作状态**。
 * 3. `POST …/transition { to: 'confirmed_complete', receiptToken }`：
 *    HTTP 层**只**认该执行器签发、且与当前记录逐项绑定一致、未被使用过的令牌；
 *    令牌合法才构造 `trusted: true` 的回执交给内核判定。
 * 4. 客户端送来的 `receipt.trusted` **一律不读**：带 `receipt` 对象但没有合法令牌 ⇒
 *    降级为 `trusted: false`（内核据此以 R245 语义拒），伪造的 `trusted:true` 不生效。
 *
 * ## 缺省执行器**必须 fail-closed**（FA-FIX-DEFAULT-EXECUTOR，P0 监督点名）
 *
 * 修复前的缺陷（`fa/verify-wave-13` 的 M5）：`main.ts` 用 `createAdaptersHost({ store })`
 * 建宿主，**没有注入执行器** ⇒ 走缺省 `createLocalAdapterExecutor()`，而后者对**非交接类**
 * 动作**直接返回 `succeeded`**（**没有任何实际执行、`params: null`、没有读回**）。后果是
 * 客户端**不必伪造 `trusted`**，只要调用产品自己的 `/execute` 就能拿到服务端签发的
 * 一次性 `receiptToken`，于是 `transition → confirmed_complete` 被**真持久化**进
 * `Store.actions`——这架空了刚修好的 P0（FA-TRUSTED-RECEIPT）。`detail` 里写
 * "真实外部执行未验证"**不改变机器状态已被假成功写入**的事实。
 *
 * 修法（对齐 `krn-orphans` 的 worker-loop 口径：没装真执行器就**如实报未装配**）：
 * **缺省执行器不得声称成功** —— 未注入时用 {@link createUnwiredAdapterExecutor}
 * （对**一切**动作返回 `unknown`、身份 `server.executor.unwired`）⇒ `/execute` **不签发令牌**
 *（409 `receipt_unavailable`）⇒ `confirmed_complete` 被内核以 R245 语义拒。
 * 能"确认完成"的执行器**只能显式注入**（`options.executor`，见
 * {@link createLocalAdapterExecutor}）：既有测试 / 真实装配凭此保留正向能力，**能力未被砍掉**。
 *
 * ## 边界（如实登记）
 *
 * - `src/workledger` / `src/scheduler` / `src/storage` 均为**只读**依赖，本文件一行未改；
 *   内核 `evaluateActionTransition` 的判据**一个字都没放宽**（本文件只是不再替它伪造证据）。
 * - **外部真实执行仍未验证**：显式注入的 {@link createLocalAdapterExecutor} 是
 *   **本机适配器存根**（无设备 / 无账号），它产出的是"本机适配器确认"，不代表外部世界真的改变。
 *   真实执行器由宿主注入（`options.executor`），注入前一律标"未验证"。
 * - 回执令牌是**进程内**、一次性；跨进程重启不保留（已确认的回执本身随动作记录持久）。
 * - 介质没实现接缝（`taskActionPortOf(tx) === null`）⇒ **503 `action_ledger_unwired`**，
 *   **不**回退到进程内存冒充持久（R220 明令禁止）。
 */

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  ACTION_STATES as KERNEL_ACTION_STATES,
  ACTION_STATE_LABELS as KERNEL_ACTION_LABELS,
  ACTION_TERMINAL_STATES,
  ActionLedgerError,
  assertIdempotencyKeyConsistent,
  canTransitionAction,
  computeActionParamDigest,
  deriveIdempotencyKey,
  evaluateActionTransition,
  evaluateBubbleExecution,
  isActionExpired,
  isActionExecutable,
  isTerminalActionState,
  prepareAction,
  type ActionAuthorization,
  type ActionLedgerRejectionReason,
  type ActionReceipt,
  type ActionRecord,
  type DecisionBubble,
} from '../../../src/workledger/index.js';
import {
  asActionRef,
  asInstanceId,
  asLogicalTime,
  asMessageId,
  type Store,
} from '../../../src/protocol/index.js';
import {
  TaskActionSeamMissingError,
  taskActionPortOf,
  type TaskActionStorePort,
} from '../../../src/scheduler/task-action-store.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const ACTIONS_ROOT = '/api/adapters/actions';

/** 三类适配器工具：**它们的动作一律进持久账本**。 */
export const ADAPTER_TOOLS: readonly {
  readonly tool: 'clock' | 'calendar' | 'meituan';
  readonly template: string;
  readonly actionKinds: readonly string[];
  readonly sideEffect: 'none' | 'read' | 'handoff' | 'write';
}[] = Object.freeze([
  {
    tool: 'clock',
    template: 'template.clock',
    actionKinds: ['alarm.create', 'alarm.update', 'alarm.delete', 'timer.create', 'system.handoff'],
    sideEffect: 'handoff',
  },
  {
    tool: 'calendar',
    template: 'template.calendar',
    actionKinds: ['event.create', 'event.update', 'event.delete', 'event.open_editor'],
    sideEffect: 'write',
  },
  {
    tool: 'meituan',
    template: 'template.meituan',
    actionKinds: ['search', 'detail', 'handoff'],
    sideEffect: 'handoff',
  },
]);

/**
 * 适配器包内部七态 → 内核持久账本七态 的**逐字对应**。
 *
 * 两者是同一套合同语义的两种拼写；产品入口**只用内核那一套**（因为它才是持久账本的形状）。
 * 这张表存在的意义是把差异**摆到明面上**，而不是让两套词汇各自漂移。
 */
const VOCAB_MAPPING: readonly { readonly adapter: string; readonly kernel: string }[] = Object.freeze([
  { adapter: 'prepared', kernel: 'prepared' },
  { adapter: 'handed_off', kernel: 'handed_off' },
  { adapter: 'submitted', kernel: 'submitted' },
  { adapter: 'confirmed', kernel: 'confirmed_complete' },
  { adapter: 'unknown', kernel: 'result_unknown' },
  { adapter: 'user_reported', kernel: 'user_reported_complete' },
  { adapter: 'failed', kernel: 'invalidated_or_failed' },
]);

const MAX_BODY_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// 服务端受控执行器（可信回执的**唯一**来源）
// ---------------------------------------------------------------------------

/**
 * 交接 / 打开编辑器类动作：适配器合同**明说没有可回读的可信回执**
 * （`src/adapters/meituan/contract.ts`：目标页交接没有可信回执；
 * `clock.system.handoff` / `calendar.event.open_editor` 同理）。
 * 这类动作执行器只能报"结果未知"，**不得**产出可信回执——
 * 否则就是把"打开了页面"当成"外部世界已改变"（R246）。
 */
const NO_TRUSTED_RECEIPT_KINDS: readonly string[] = Object.freeze([
  'meituan.handoff',
  'meituan.search',
  'meituan.detail',
  'clock.system.handoff',
  'calendar.event.open_editor',
]);

/** 一次受控执行的输入：把"动作身份"完整交给执行器（任务 / 修订 / 工具 / 参数摘要 / 时刻）。 */
export interface ControlledActionExecutionInput {
  readonly action_id: string;
  readonly task_id: string;
  readonly task_revision: number;
  readonly tool: string;
  readonly action_kind: string;
  /** 参数摘要（`computeActionParamDigest`）——回执要与之绑定。 */
  readonly param_digest: string;
  readonly params: unknown;
  readonly at: number;
}

/** 执行结果：`succeeded` 才可能产出可信回执；`unknown` / `failed` 一律不得确认完成。 */
export type ControlledActionExecutionOutcome = 'succeeded' | 'unknown' | 'failed';

export interface ControlledActionExecutionResult {
  readonly outcome: ControlledActionExecutionOutcome;
  readonly detail: string;
}

/**
 * **受控执行器**：服务端唯一被允许"声称外部动作已完成"的组件。
 *
 * 关键纪律：它**不是**把客户端的声明转述一遍，而是**自己执行**（或自己确认无法执行）后
 * 产出结论。产品侧真实执行器（设备 / 账号）由宿主经 `executor` 注入；
 * **未注入时缺省是 fail-closed 的 {@link createUnwiredAdapterExecutor}**（不声称成功）；
 * 能"确认完成"的本机存根见 {@link createLocalAdapterExecutor}（**须显式注入**才生效）。
 */
export interface ControlledActionExecutor {
  /** 执行身份（机器可读、稳定）：写进回执 `source`，可审计"是谁确认的"。 */
  readonly identity: string;
  execute(input: ControlledActionExecutionInput): ControlledActionExecutionResult;
}

/** 未装配真实执行器时的缺省执行器身份（机器可读，可审计"产品确实没装执行器"）。 */
export const UNWIRED_EXECUTOR_IDENTITY = 'server.executor.unwired';

/**
 * **缺省执行器：未装配真实执行器的 fail-closed 存根**（`options.executor` 省略时使用）。
 *
 * 它**不做任何实际执行**，因此对**一切**动作（含非交接类）一律返回 `unknown`——
 * 没有实际执行 ⇒ 无可信回执 ⇒ `/execute` 不签发令牌 ⇒ 不得 `confirmed_complete`。
 *
 * 这正是与 `krn-orphans` 的 worker-loop 同一口径：没装真执行器就**如实报"未装配"**，
 * 而**不是**为了让下游"看起来做成了"而返回 `succeeded`（FA-FIX-DEFAULT-EXECUTOR，P0）。
 *
 * 缺点是没有正向能力（永远无法确认完成）——这是**刻意的**：要确认完成就必须由一个
 * **显式装配**的受控执行器负责（见 {@link createLocalAdapterExecutor} / 真实设备执行器）。
 */
export function createUnwiredAdapterExecutor(
  identity = UNWIRED_EXECUTOR_IDENTITY,
): ControlledActionExecutor {
  return Object.freeze({
    identity,
    execute(input: ControlledActionExecutionInput): ControlledActionExecutionResult {
      return {
        outcome: 'unknown',
        detail:
          `产品未装配真实执行器（executor_unwired）：${input.action_kind} 没有任何实际外部执行，` +
          `因此**无可信回执**，不得推进到 confirmed_complete。` +
          `请由宿主经 options.executor 显式注入受控执行器后再执行。`,
      };
    },
  });
}

/**
 * **显式注入**用的本机适配器存根执行器（测试 / 真实装配）。
 *
 * **它不再是缺省**（缺省见 {@link createUnwiredAdapterExecutor}）——只有宿主**主动注入**
 * 它（`createAdaptersHost({ executor })`）才会启用，因此产品路径默认拿不到可信回执。
 *
 * 它做的是"本轮 Demo 里能诚实做到的事"——把动作交给本机适配器层确认，
 * 因此它的 `identity` 与 `detail` 都**如实声明**这是本机确认、外部真实执行未验证。
 * 不可回读的交接类动作一律 `unknown`（见 `NO_TRUSTED_RECEIPT_KINDS`）。
 */
export function createLocalAdapterExecutor(identity = 'server.executor.local-adapter'): ControlledActionExecutor {
  return Object.freeze({
    identity,
    execute(input: ControlledActionExecutionInput): ControlledActionExecutionResult {
      if (NO_TRUSTED_RECEIPT_KINDS.includes(input.action_kind)) {
        return {
          outcome: 'unknown',
          detail:
            `${input.action_kind} 属交接 / 打开编辑器类：适配器合同明说**没有可回读的可信回执**，` +
            `打开页面不等于写入（R246），外部结果不可读时保留未知`,
        };
      }
      return {
        outcome: 'succeeded',
        detail:
          `本机适配器回读 ${input.action_kind} 完成（param_digest=${input.param_digest.slice(0, 12)}…）；` +
          `本机存根确认，**真实外部执行未验证**`,
      };
    },
  });
}

/** 服务端签发的一枚回执令牌：把"这次执行"逐项绑定到具体动作。 */
interface IssuedReceiptToken {
  readonly token: string;
  readonly action_id: string;
  readonly task_id: string;
  readonly task_revision: number;
  readonly tool: string;
  readonly action_kind: string;
  readonly param_digest: string;
  readonly executor_identity: string;
  readonly detail: string;
  readonly issued_at: number;
  /** 一次性：成功用于一次状态推进后置真（重放保护）。 */
  consumed: boolean;
}

/** 令牌核验结论。`ok=false` 时 `detail` 说明为什么不能作为可信依据（一律不可信）。 */
type ReceiptTokenVerdict =
  | { readonly ok: true; readonly identity: string; readonly detail: string }
  | { readonly ok: false; readonly detail: string };

/** 服务端随机 nonce：不可预测、不可由客户端构造。 */
function newReceiptToken(): string {
  return `rt1.${randomBytes(18).toString('base64url')}`;
}

// ---------------------------------------------------------------------------
// HTTP 工具（自足）
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { code, message, retryable: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

type ParsedBody = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

async function readJson(req: IncomingMessage): Promise<ParsedBody> {
  const raw = await readBody(req);
  if (raw === null) return { ok: false };
  if (raw.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

/** 拒因 → HTTP 状态码。默认 409（"冲突/前置不满足"），少数几种语义更窄。 */
function statusForReason(reason: ActionLedgerRejectionReason): number {
  switch (reason) {
    case 'unknown_action':
      return 404;
    case 'non_canonicalizable_param':
      return 400;
    default:
      return 409;
  }
}

/**
 * 把事务里抛出的领域错误**取回来**。
 *
 * `Store.transact` 会把事务体内任何非 `PersistenceError` 的抛错统一包成
 * `PersistenceError('事务回滚…', { cause })`（内存与落盘实现一致）。因此入口必须
 * **沿 cause 链**找回原本的 `ActionLedgerError` / `TaskActionSeamMissingError`，
 * 否则"版本过期/授权撤销/无可信回执"这些**有意义的拒因**会被降级成一个笼统的 400。
 */
function unwrapCause(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof ActionLedgerError) {
      return current;
    }
    if (typeof current !== 'object' || current === null) {
      break;
    }
    const cause = (current as { readonly cause?: unknown }).cause;
    if (cause === undefined) {
      break;
    }
    current = cause;
  }
  return error;
}

function sendLedgerError(res: ServerResponse, rawError: unknown): void {
  const error = unwrapCause(rawError);
  // 顺序要紧：`TaskActionSeamMissingError` 是 `ActionLedgerError` 的子类，
  // 必须先判它，否则"介质没实现接缝"会被当成普通的 409 动作冲突。
  if (error instanceof TaskActionSeamMissingError) {
    sendJson(res, 503, {
      code: 'action_ledger_unwired',
      message: error.message,
      retryable: false,
      status: 'not_ready',
      stub: true,
      realExecutor: false,
    });
    return;
  }
  if (error instanceof ActionLedgerError) {
    sendJson(res, statusForReason(error.reason), {
      code: error.reason,
      message: error.message,
      retryable: false,
    });
    return;
  }
  sendJson(res, 400, {
    code: 'invalid_action_request',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  });
}

// ---------------------------------------------------------------------------
// 宿主
// ---------------------------------------------------------------------------

export interface AdapterActionLedgerOptions {
  /** 内核持久存储（`KernelHost.store`）。动作写进它的 `actions` 集合。 */
  readonly store: Store;
  /** 逻辑时刻来源（毫秒）。测试注入固定值。 */
  readonly now?: () => number;
  /** 动作 id 来源（跨重启唯一，R202）。 */
  readonly idSource?: () => string;
  /**
   * **受控执行器**：唯一被允许产出可信回执的组件。**必须显式注入**才有正向能力。
   * 省略时用 {@link createUnwiredAdapterExecutor}（fail-closed：一律 `unknown`，
   * `/execute` 不签发令牌）——**不再**退回"对非交接类动作直接返回 succeeded"的存根。
   * 要保留"注入执行器 ⇒ 可确认完成"的能力，显式注入 {@link createLocalAdapterExecutor}
   * （或真实设备执行器）。
   */
  readonly executor?: ControlledActionExecutor;
}

export interface AdapterActionLedgerHost {
  /** 返回 `true` = 已处理该请求。 */
  handle(request: {
    readonly method: string;
    readonly pathname: string;
    readonly url: URL;
    readonly req: IncomingMessage;
    readonly res: ServerResponse;
  }): Promise<boolean>;
}

export function createAdapterActionLedgerHost(
  options: AdapterActionLedgerOptions,
): AdapterActionLedgerHost {
  const { store } = options;
  const now = options.now ?? ((): number => Date.now());
  let counter = 0;
  const bootToken = `${now().toString(36)}-${Math.trunc(Math.random() * 0xffffffff).toString(36)}`;
  const idSource = options.idSource ?? ((): string => {
    counter += 1;
    return `act-${bootToken}-${String(counter)}`;
  });

  /** 在事务内取持久接缝；介质没实现接缝 ⇒ 大声失败（**不**退回内存）。 */
  const portOf = (tx: Parameters<Parameters<Store['transact']>[0]>[0]): TaskActionStorePort => {
    const port = taskActionPortOf(tx);
    if (port === null) {
      throw new TaskActionSeamMissingError('Store 介质未实现 putActionRecord/listActionRecords 等六个方法');
    }
    return port;
  };

  // -------------------------------------------------------------------------
  // 回执令牌台账（进程内、一次性；可信回执的**唯一**来源）
  // -------------------------------------------------------------------------

  // **fail-closed 缺省**：未显式注入执行器 ⇒ 不声称成功（FA-FIX-DEFAULT-EXECUTOR，P0）。
  const executor = options.executor ?? createUnwiredAdapterExecutor();
  const receiptTokens = new Map<string, IssuedReceiptToken>();

  /**
   * 核验一枚回执令牌能否作为**可信依据**。
   *
   * 逐项比对"这次执行"与"本次要确认的动作"：动作 id / 任务 / 修订 / 工具 / 参数摘要。
   * **任一不符即不可信**——参数变了就是另一个动作（KERN-07），旧版本动作不得复用旧回执。
   * 注意：这里刻意**不**拿令牌去比"任务当前版本"——旧版本要留给内核判
   * `stale_task_revision`（判据顺序由内核决定，入口不越权改判）。
   */
  const verifyReceiptToken = (token: string, record: ActionRecord): ReceiptTokenVerdict => {
    const entry = receiptTokens.get(token);
    if (entry === undefined) {
      return { ok: false, detail: '不是服务端执行器签发的令牌（未知 / 已失效）' };
    }
    if (entry.consumed) {
      return { ok: false, detail: '该回执令牌已被使用过（重放）' };
    }
    if (entry.action_id !== String(record.action_id)) {
      return { ok: false, detail: '令牌绑定的动作与本次动作不一致' };
    }
    if (entry.task_id !== String(record.task_id)) {
      return { ok: false, detail: '令牌绑定的任务与本次动作不一致' };
    }
    if (entry.task_revision !== Number(record.task_revision)) {
      return { ok: false, detail: '令牌绑定的任务修订与本次动作不一致' };
    }
    if (entry.action_kind !== record.action_kind) {
      return { ok: false, detail: '令牌绑定的动作种类与本次动作不一致' };
    }
    if (entry.param_digest !== record.param_digest) {
      return { ok: false, detail: '令牌绑定的参数摘要与本次动作不一致（参数变了就是另一个动作）' };
    }
    return { ok: true, identity: entry.executor_identity, detail: entry.detail };
  };

  const consumeReceiptToken = (token: string): void => {
    const entry = receiptTokens.get(token);
    if (entry !== undefined) {
      entry.consumed = true;
    }
  };

  // -------------------------------------------------------------------------
  // 只读视图（快照，不写）
  // -------------------------------------------------------------------------

  const listActions = (taskId: string | null): readonly ActionRecord[] => {
    const rows = (store.snapshot() as unknown as { readonly actions?: readonly ActionRecord[] }).actions ?? [];
    return taskId === null ? rows : rows.filter((row) => String(row.task_id) === taskId);
  };

  const getAction = (actionId: string): ActionRecord | null => {
    const rows = (store.snapshot() as unknown as { readonly actions?: readonly ActionRecord[] }).actions ?? [];
    return rows.find((row) => String(row.action_id) === actionId) ?? null;
  };

  const handleVocabulary = (res: ServerResponse): void => {
    sendJson(res, 200, {
      ok: true,
      // 产品入口用**这一套**（内核持久账本的形状）。
      kernelVocabulary: KERNEL_ACTION_STATES.map((state) => ({
        id: state,
        label: KERNEL_ACTION_LABELS[state],
        terminal: (ACTION_TERMINAL_STATES as readonly string[]).includes(state),
        allowedNext: KERNEL_ACTION_STATES.filter((to) => canTransitionAction(state, to)),
      })),
      adapterVocabulary: VOCAB_MAPPING.map((row) => row.adapter),
      mapping: VOCAB_MAPPING,
      note:
        '适配器包（src/adapters）内部的七态与内核持久账本的七态是同一套语义的两种拼写；' +
        '**产品入口一律用内核那一套**，因为它才是 Store.actions 的形状。',
    });
  };

  const handleTools = (res: ServerResponse): void => {
    sendJson(res, 200, {
      ok: true,
      tools: ADAPTER_TOOLS,
      note: '三类工具的动作**一律**经 POST /api/adapters/actions 进 Store.actions；本入口不接受"只在 HTTP 边缘记一笔"。',
    });
  };

  // -------------------------------------------------------------------------
  // 创建（四道闸门里的：授权绑定 + 版本 + 幂等）
  // -------------------------------------------------------------------------

  const handleCreate = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const parsed = await readJson(req);
    if (!parsed.ok) {
      sendError(res, 400, 'invalid_json', '请求体不是合法 JSON');
      return;
    }
    if (!isRecord(parsed.value)) {
      sendError(res, 400, 'invalid_body', '请求体必须是对象');
      return;
    }
    const body = parsed.value;

    const tool = asString(body['tool']);
    const toolSpec = ADAPTER_TOOLS.find((entry) => entry.tool === tool);
    if (toolSpec === undefined) {
      sendError(res, 400, 'unknown_tool', `tool 必须是 ${ADAPTER_TOOLS.map((e) => e.tool).join(' | ')} 之一`);
      return;
    }
    const actionKind = asString(body['actionKind']);
    if (actionKind === null || actionKind.trim() === '') {
      sendError(res, 400, 'invalid_action_kind', '缺少 actionKind（非空字符串）');
      return;
    }
    const taskId = asString(body['taskId']);
    if (taskId === null) {
      sendError(res, 400, 'invalid_task_id', '缺少 taskId');
      return;
    }
    if (body['params'] === undefined) {
      sendError(res, 400, 'invalid_params', '缺少 params（动作参数，用于计算摘要）');
      return;
    }
    const authorization = body['authorization'];
    if (!isRecord(authorization)) {
      sendError(res, 400, 'invalid_authorization', '缺少 authorization{source, userApproved}（R241/R244 要求显式权限来源）');
      return;
    }
    const authSource = asString(authorization['source']);
    if (authSource === null || authSource.trim() === '') {
      sendError(res, 400, 'invalid_authorization', 'authorization.source 不得为空（授权来源必须可审计）');
      return;
    }
    const claimedRevision = asNumber(body['taskRevision']);
    // 客户端可自称幂等键；别名 requestId（"同 requestId 不同参数不得沿用旧幂等键"）。
    const clientKey = asString(body['idempotencyKey']) ?? asString(body['requestId']);
    const fullKind = `${toolSpec.tool}.${actionKind}`;
    const subjectRaw = asString(authorization['subjectInstanceId']);
    const at = asLogicalTime(now());

    try {
      const outcome = store.transact((tx) => {
        const port = portOf(tx);
        const task = tx.getTask(taskId as never);
        if (task === undefined) {
          throw new ActionLedgerError('unknown_action', `没有这个任务：${taskId}`);
        }

        // 闸门①（版本）：**不接受客户端自称的 revision**——必须与存储里的当前版本一致。
        if (claimedRevision !== null && claimedRevision !== Number(task.revision)) {
          throw new ActionLedgerError(
            'stale_task_revision',
            `客户端自称任务版本 ${String(claimedRevision)}，但存储里当前是 ${String(task.revision)}：` +
              `不得按旧版本创建动作（R213）`,
          );
        }
        const taskRevision = task.revision;

        // 闸门③（幂等）：客户端若自称键，必须与 (task, revision, kind, params) 推导的一致。
        if (clientKey !== null) {
          assertIdempotencyKeyConsistent({
            idempotency_key: clientKey,
            task_id: task.task_id,
            task_revision: taskRevision,
            action_kind: fullKind,
            params: body['params'],
          });
        }
        const paramDigest = computeActionParamDigest(fullKind, body['params']);
        const idempotencyKey = deriveIdempotencyKey({
          task_id: task.task_id,
          task_revision: taskRevision,
          action_kind: fullKind,
          param_digest: paramDigest,
        });

        const existing = port
          .listActionRecords()
          .find(
            (record) =>
              record.idempotency_key === idempotencyKey && String(record.task_id) === String(task.task_id),
          );
        if (existing !== undefined) {
          return { duplicate: true as const, record: existing };
        }

        const authz: ActionAuthorization = {
          source: authSource,
          user_approved: authorization['userApproved'] === true,
          // 闸门②（授权绑版本）：授权版本必须与动作版本一致，否则 prepareAction 会拒。
          task_revision: taskRevision,
          revoked: false,
          subject_instance_id: subjectRaw === null ? null : asInstanceId(subjectRaw),
          granted_at: at,
        };

        const record = prepareAction({
          action_id: idSource(),
          task_id: task.task_id,
          task_revision: taskRevision,
          action_kind: fullKind,
          params: body['params'],
          authorization: authz,
          at,
        });
        port.putActionRecord(record);

        // 绑到任务身份上（"动作创建必须绑 task"的落点；不改任务版本）。
        const currentRefs = task.action_refs ?? [];
        tx.putTask({ ...task, action_refs: [...currentRefs, record.action_id] });

        return { duplicate: false as const, record };
      });

      sendJson(res, outcome.duplicate ? 200 : 201, {
        ok: true,
        duplicate: outcome.duplicate,
        action: outcome.record,
        note: outcome.duplicate
          ? '幂等命中：返回既有动作，**未**新建（同参数 + 同任务版本）。'
          : '已创建并写入 Store.actions（持久账本）。',
      });
    } catch (error) {
      sendLedgerError(res, error);
    }
  };

  // -------------------------------------------------------------------------
  // 状态推进（闸门：回执 / 撤权 / 过期 / 终态）
  // -------------------------------------------------------------------------

  const handleTransition = async (
    actionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const parsed = await readJson(req);
    if (!parsed.ok || !isRecord(parsed.value)) {
      sendError(res, 400, 'invalid_body', '请求体必须是 JSON 对象');
      return;
    }
    const body = parsed.value;
    const to = asString(body['to']);
    if (to === null) {
      sendError(res, 400, 'invalid_body', '缺少 to（目标状态）');
      return;
    }
    const at = asLogicalTime(now());
    const receiptRaw = body['receipt'];
    // 令牌可由顶层 `receiptToken` 或 `receipt.token` 给出；其余一律不认。
    const tokenRaw =
      asString(body['receiptToken']) ??
      (isRecord(receiptRaw) ? asString(receiptRaw['token']) : null);

    /** 本次成功推进后要置为"已用"的令牌（重放保护）。 */
    let tokenToConsume: string | null = null;

    try {
      const next = store.transact((tx) => {
        const port = portOf(tx);
        const record = port.getActionRecord(asActionRef(actionId));
        if (record === undefined) {
          throw new ActionLedgerError('unknown_action', `台账里没有动作：${actionId}`);
        }
        const task = tx.getTask(record.task_id);
        if (task === undefined) {
          throw new ActionLedgerError('unknown_action', `动作引用的任务不存在：${String(record.task_id)}`);
        }

        // **可信只来自服务端受控执行器**：客户端送来的 `receipt.trusted` 一律不读。
        const tokenVerdict = tokenRaw === null ? null : verifyReceiptToken(tokenRaw, record);
        let receipt: ActionReceipt | undefined;
        if (tokenVerdict !== null && tokenVerdict.ok) {
          receipt = {
            trusted: true,
            source: tokenVerdict.identity,
            detail: tokenVerdict.detail,
            at,
          };
          tokenToConsume = tokenRaw;
        } else if (isRecord(receiptRaw)) {
          // 客户端自称 receipt（含 `trusted: true`）——**降级为不可信**，由内核以 R245 语义拒。
          receipt = {
            trusted: false,
            source: asString(receiptRaw['source']) ?? '(未命名来源)',
            detail:
              tokenVerdict === null
                ? (asString(receiptRaw['detail']) ?? '')
                : `客户端回执不生效：${tokenVerdict.detail}`,
            at,
          };
        } else if (tokenVerdict !== null) {
          // 带令牌但不可用，且没有 receipt 对象：给出不可信回执，让内核以 R245 语义拒。
          receipt = {
            trusted: false,
            source: 'receipt_token',
            detail: `回执令牌不可用：${tokenVerdict.detail}`,
            at,
          };
        }
        const userReportRaw = body['userReport'];
        const userReport =
          isRecord(userReportRaw) && asString(userReportRaw['messageId']) !== null
            ? {
                message_id: asMessageId(String(userReportRaw['messageId'])),
                note: asString(userReportRaw['note']) ?? '',
              }
            : undefined;

        const verdict = evaluateActionTransition({
          action: record,
          to: to as never,
          at,
          current_task_revision: task.revision,
          ...(receipt === undefined ? {} : { receipt }),
          ...(userReport === undefined ? {} : { user_report: userReport }),
          ...(asString(body['failureReason']) === null ? {} : { failure_reason: String(body['failureReason']) }),
          ...(asString(body['invalidatedReason']) === null
            ? {}
            : { invalidated_reason: String(body['invalidatedReason']) }),
          ...(asString(body['supersedeWith']) === null
            ? {}
            : { superseded_by_action_id: String(body['supersedeWith']) }),
        });

        if (!verdict.ok || verdict.next === null) {
          throw new ActionLedgerError(
            verdict.reason ?? 'illegal_action_transition',
            verdict.message,
          );
        }
        port.putActionRecord(verdict.next);
        return verdict.next;
      });

      // 事务已提交：令牌置为"已用"（重放保护）。拒因路径不消费令牌。
      if (tokenToConsume !== null) {
        consumeReceiptToken(tokenToConsume);
      }

      sendJson(res, 200, { ok: true, action: next });
    } catch (error) {
      sendLedgerError(res, error);
    }
  };

  // -------------------------------------------------------------------------
  // 受控执行（可信回执的**唯一**来源；触发执行器并签发一次性回执令牌）
  // -------------------------------------------------------------------------

  const handleExecute = async (
    actionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const parsed = await readJson(req);
    if (!parsed.ok) {
      sendError(res, 400, 'invalid_json', '请求体不是合法 JSON');
      return;
    }
    const at = asLogicalTime(now());

    const record = getAction(actionId);
    if (record === null) {
      sendError(res, 404, 'unknown_action', `台账里没有动作：${actionId}`);
      return;
    }
    const snapshot = store.snapshot() as unknown as {
      readonly tasks?: readonly { readonly task_id: string; readonly revision: number }[];
    };
    const task = snapshot.tasks?.find((row) => String(row.task_id) === String(record.task_id));
    if (task === undefined) {
      sendError(res, 404, 'unknown_action', `动作引用的任务不存在：${String(record.task_id)}`);
      return;
    }

    // 前置：终态 / 过期 / 撤权 / 转换表——**执行器不得替内核绕过判据**。
    if (isTerminalActionState(record.state)) {
      sendError(res, 409, 'terminal_locked', `动作已是终态 ${record.state}，不得再执行`);
      return;
    }
    if (isActionExpired(record, task.revision as never)) {
      sendError(
        res,
        409,
        'stale_task_revision',
        `动作绑定的任务版本 ${Number(record.task_revision)} 已过期（当前 ${task.revision}）：旧版本动作不得执行（R213）`,
      );
      return;
    }
    if (record.authorization.revoked) {
      sendError(res, 409, 'authorization_revoked', `授权已撤销（来源 ${record.authorization.source}）：运行中撤权即时生效（R244）`);
      return;
    }
    if (!canTransitionAction(record.state, 'confirmed_complete')) {
      sendError(
        res,
        409,
        'illegal_action_transition',
        `当前状态 ${record.state} 无法到达 confirmed_complete：非法的动作状态转换`,
      );
      return;
    }

    const tool = ADAPTER_TOOLS.find((entry) => record.action_kind.startsWith(`${entry.tool}.`))?.tool ?? '(unknown)';
    const result = executor.execute({
      action_id: String(record.action_id),
      task_id: String(record.task_id),
      task_revision: Number(record.task_revision),
      tool,
      action_kind: record.action_kind,
      param_digest: record.param_digest,
      params: null,
      at,
    });

    if (result.outcome !== 'succeeded') {
      // 不签发令牌。**明确登记**是哪个执行器、为什么没有可信回执：
      // 缺省（未装配）时 `executor === 'server.executor.unwired'` ⇒ 消费方可机读区分
      // "产品没装执行器"与"装了但这次执行没成"。
      sendJson(res, 409, {
        code: 'receipt_unavailable',
        message: `受控执行器未产出可信回执（outcome=${result.outcome}）：${result.detail}`,
        retryable: false,
        executor: executor.identity,
        outcome: result.outcome,
        executorWired: executor.identity !== UNWIRED_EXECUTOR_IDENTITY,
      });
      return;
    }

    const token = newReceiptToken();
    receiptTokens.set(token, {
      token,
      action_id: String(record.action_id),
      task_id: String(record.task_id),
      task_revision: Number(record.task_revision),
      tool,
      action_kind: record.action_kind,
      param_digest: record.param_digest,
      executor_identity: executor.identity,
      detail: result.detail,
      issued_at: at,
      consumed: false,
    });

    sendJson(res, 200, {
      ok: true,
      // **只**返回令牌；不返回任何"trusted"字段——可信性由服务端持有，不由客户端声明。
      receiptToken: token,
      executor: executor.identity,
      outcome: result.outcome,
      detail: result.detail,
      boundTo: {
        actionId: String(record.action_id),
        taskId: String(record.task_id),
        taskRevision: Number(record.task_revision),
        actionKind: record.action_kind,
        paramDigest: record.param_digest,
      },
      note:
        '本令牌由服务端受控执行器签发，一次性、绑定 任务/修订/工具/参数摘要/执行身份；' +
        '把它交给 POST …/transition { to: "confirmed_complete", receiptToken } 才会推进状态。' +
        '本机存根执行器，**真实外部执行未验证**。',
    });
  };

  // -------------------------------------------------------------------------
  // 可执行性（旧版本动作不得可执行 / 气泡与执行读同一对象）
  // -------------------------------------------------------------------------

  const handleExecutable = async (
    actionId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const parsed = await readJson(req);
    const body: Record<string, unknown> = parsed.ok && isRecord(parsed.value) ? parsed.value : {};

    const record = getAction(actionId);
    if (record === null) {
      sendError(res, 404, 'unknown_action', `台账里没有动作：${actionId}`);
      return;
    }
    const snapshot = store.snapshot() as unknown as { readonly tasks?: readonly { task_id: string; revision: number }[] };
    const task = snapshot.tasks?.find((row) => String(row.task_id) === String(record.task_id));
    if (task === undefined) {
      sendError(res, 404, 'unknown_action', `动作引用的任务不存在：${String(record.task_id)}`);
      return;
    }

    const currentRevision = task.revision as never;
    const expired = isActionExpired(record, currentRevision);
    const executable = isActionExecutable(record, { current_task_revision: currentRevision });

    let bubbleCheck: { ok: boolean; reason: string | null; message: string } | null = null;
    const bubbleRaw = body['bubble'];
    if (isRecord(bubbleRaw)) {
      const bubble: DecisionBubble = {
        bubble_id: asString(bubbleRaw['bubbleId']) ?? 'bubble',
        action_id: record.action_id,
        task_id: record.task_id,
        task_revision: (asNumber(bubbleRaw['taskRevision']) ?? NaN) as never,
        param_digest: asString(bubbleRaw['paramDigest']) ?? '',
        shown_at: asLogicalTime(0),
      };
      bubbleCheck = evaluateBubbleExecution(bubble, record, { current_task_revision: currentRevision });
    }

    sendJson(res, 200, {
      ok: true,
      actionId: String(record.action_id),
      state: record.state,
      currentTaskRevision: Number(currentRevision),
      actionTaskRevision: Number(record.task_revision),
      expired,
      terminal: (ACTION_TERMINAL_STATES as readonly string[]).includes(record.state),
      authorizationRevoked: record.authorization.revoked,
      executable,
      bubbleCheck,
    });
  };

  // -------------------------------------------------------------------------
  // 分发
  // -------------------------------------------------------------------------

  const handle: AdapterActionLedgerHost['handle'] = async ({ method, pathname, url, req, res }) => {
    if (pathname !== ACTIONS_ROOT && !pathname.startsWith(`${ACTIONS_ROOT}/`)) {
      return false;
    }
    const readOnly = method === 'GET' || method === 'HEAD';

    if (pathname === ACTIONS_ROOT) {
      if (readOnly) {
        const taskId = url.searchParams.get('taskId');
        sendJson(res, 200, { ok: true, actions: listActions(taskId) });
        return true;
      }
      if (method === 'POST') {
        await handleCreate(req, res);
        return true;
      }
      sendError(res, 405, 'method_not_allowed', '该接口只接受 GET / POST');
      return true;
    }

    if (pathname === `${ACTIONS_ROOT}/vocabulary`) {
      if (!readOnly) {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
        return true;
      }
      handleVocabulary(res);
      return true;
    }

    if (pathname === `${ACTIONS_ROOT}/tools`) {
      if (!readOnly) {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
        return true;
      }
      handleTools(res);
      return true;
    }

    const transitionMatch = /^\/api\/adapters\/actions\/([^/]+)\/transition$/.exec(pathname);
    if (transitionMatch !== null) {
      if (method !== 'POST') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
        return true;
      }
      await handleTransition(decodeURIComponent(transitionMatch[1] ?? ''), req, res);
      return true;
    }

    const execRunMatch = /^\/api\/adapters\/actions\/([^/]+)\/execute$/.exec(pathname);
    if (execRunMatch !== null) {
      if (method !== 'POST') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
        return true;
      }
      await handleExecute(decodeURIComponent(execRunMatch[1] ?? ''), req, res);
      return true;
    }

    const execMatch = /^\/api\/adapters\/actions\/([^/]+)\/executable$/.exec(pathname);
    if (execMatch !== null) {
      if (method !== 'POST') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
        return true;
      }
      await handleExecutable(decodeURIComponent(execMatch[1] ?? ''), req, res);
      return true;
    }

    const oneMatch = /^\/api\/adapters\/actions\/([^/]+)$/.exec(pathname);
    if (oneMatch !== null) {
      if (!readOnly) {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
        return true;
      }
      const record = getAction(decodeURIComponent(oneMatch[1] ?? ''));
      if (record === null) {
        sendError(res, 404, 'unknown_action', '台账里没有这个动作');
        return true;
      }
      sendJson(res, 200, { ok: true, action: record });
      return true;
    }

    sendError(res, 404, 'not_found', '没有这个动作台账接口');
    return true;
  };

  return { handle };
}

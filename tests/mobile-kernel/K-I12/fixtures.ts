/**
 * K-I12 夹具 —— 把手动时钟 + K10 任务台账 + K07 授权/提交账本 + 记录型端口装配成
 * 一条**可独立驱动**的链路，并封装"走到提交"的最小前置。
 *
 * 反例纪律：`expectBridgeError` / `expectAsyncBridgeError` 在**没有抛错时主动失败**——
 * 实现若悄悄改成返回 `false`，用例必须变红，而不是静默通过。
 *
 * 夹具**不复用** `tests/mobile-kernel/K07/fixtures.ts`：那份夹具的 `baseConfirm` 早于
 * K-R06 的 taskId 绑定，形状已与当前 `ActionBinding` 不符；本夹具按当前九项绑定自建。
 */

// 直接 import 定义模块（不经 actions/index.js barrel）——barrel 会拉进 `wire-codec.ts`，
// 其 taskId 缺失是 K-I02 之后遗留的**别人文件**的编译错误；本夹具不依赖它。
import { createAuthorizationLedger, createTrustedReceipt } from '../../../apps/mobile-kernel/actions/ledger.js';
import { createManualClock } from '../../../apps/mobile-kernel/actions/clock.js';
import { isAuthorizationError } from '../../../apps/mobile-kernel/actions/errors.js';
import type { AuthorizationLedger } from '../../../apps/mobile-kernel/actions/ledger.js';
import type {
  ActionBinding,
  ConfirmAction,
  ExecutorOutcome,
  ExternalReceipt,
  ExternalSubmitRequest,
  OrderQueryPort,
  OrderQueryRequest,
  SubmissionRecord,
} from '../../../apps/mobile-kernel/actions/types.js';
import type { AuthorizationError } from '../../../apps/mobile-kernel/actions/errors.js';
import type { ManualClock } from '../../../apps/mobile-kernel/actions/clock.js';
import { TaskLedger } from '../../../apps/mobile-kernel/lifecycle/ledger.js';
import {
  isTaskExternalBridgeError,
  TaskExternalBridge,
  type TaskExternalBridgeError,
} from '../../../apps/mobile-kernel/adapters/task-external/index.js';

export const T0 = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

export interface RecordingExecutor {
  readonly identity: string;
  readonly calls: ExternalSubmitRequest[];
  send(request: ExternalSubmitRequest): ExecutorOutcome | Promise<ExecutorOutcome>;
}

export function recordingExecutor(
  handler: (request: ExternalSubmitRequest, callIndex: number) => ExecutorOutcome | Promise<ExecutorOutcome>,
): RecordingExecutor {
  const calls: ExternalSubmitRequest[] = [];
  return {
    identity: 'fixture.executor',
    calls,
    send(request: ExternalSubmitRequest): ExecutorOutcome | Promise<ExecutorOutcome> {
      calls.push(request);
      return handler(request, calls.length - 1);
    },
  };
}

export function acceptingExecutor(): RecordingExecutor {
  return recordingExecutor(() => ({ outcome: 'accepted' as const }));
}

export function unknownExecutor(): RecordingExecutor {
  return recordingExecutor(() => ({ outcome: 'unknown' as const, detail: 'no receipt' }));
}

export interface RecordingOrderQuery extends OrderQueryPort {
  readonly identity: string;
  readonly calls: OrderQueryRequest[];
}

export function recordingOrderQuery(
  handler: (request: OrderQueryRequest, callIndex: number) => ExternalReceipt | null,
): RecordingOrderQuery {
  const calls: OrderQueryRequest[] = [];
  return {
    identity: 'fixture.order-query',
    calls,
    query(request: OrderQueryRequest): ExternalReceipt | null {
      calls.push(request);
      return handler(request, calls.length - 1);
    },
  };
}

/** 查不到任何东西（默认）：调用方必须如实保持"结果未知"。 */
export function emptyOrderQuery(): RecordingOrderQuery {
  return recordingOrderQuery(() => null);
}

/** 原单能查到、且返回受控真实 confirmed 回执：用于证明"有证据才结清"。 */
export function confirmingOrderQuery(): RecordingOrderQuery {
  return recordingOrderQuery((request) =>
    createTrustedReceipt({
      actionId: request.actionId,
      provider: 'meituan',
      requestRef: request.requestRef,
      externalId: 'ext-1',
      observedState: 'confirmed',
      observedAt: T0 + 1_000,
      evidenceRef: 'evid:fixture-1',
      verificationMode: 'real',
      detail: 'fixture 原单已存在的真实回执',
    }),
  );
}

// ---------------------------------------------------------------------------
// 标准确认请求（九项绑定 + 期限）
// ---------------------------------------------------------------------------

export function baseConfirm(overrides: Partial<ConfirmAction> = {}): ConfirmAction {
  return {
    taskId: 'task-1',
    actionId: 'act-1',
    accountRef: 'acct:meituan:7788',
    taskRevision: 7,
    paramsDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    quoteRef: 'quote:mt-001',
    amount: 3980,
    currency: 'CNY',
    scope: 'purchase',
    expiresAt: T0 + 60_000,
    ...overrides,
  };
}

export function bindingOf(confirm: ConfirmAction): ActionBinding {
  return Object.freeze({
    taskId: confirm.taskId,
    actionId: confirm.actionId,
    accountRef: confirm.accountRef,
    taskRevision: confirm.taskRevision,
    paramsDigest: confirm.paramsDigest,
    quoteRef: confirm.quoteRef,
    amount: confirm.amount,
    currency: confirm.currency,
    scope: confirm.scope,
  });
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

export interface BridgeFixture {
  readonly clock: ManualClock;
  readonly tasks: TaskLedger;
  readonly actions: AuthorizationLedger;
  readonly bridge: TaskExternalBridge;
  readonly executor: RecordingExecutor;
  readonly orderQuery: RecordingOrderQuery;
}

export function setupFixture(
  options: {
    readonly executor?: RecordingExecutor;
    readonly orderQuery?: RecordingOrderQuery | null;
    readonly clock?: number;
  } = {},
): BridgeFixture {
  const clock = createManualClock(options.clock ?? T0);
  const executor = options.executor ?? acceptingExecutor();
  // 显式传 `null` ⇒ 账本没有原单查询端口（用于 `missing_order_query_port` 负例）。
  const orderQuery = options.orderQuery === undefined ? emptyOrderQuery() : options.orderQuery;
  const actions = createAuthorizationLedger({
    clock,
    executor,
    orderQuery: orderQuery === null ? null : orderQuery,
  });
  const tasks = new TaskLedger({ clock });
  const bridge = new TaskExternalBridge({ tasks, actions });
  return { clock, tasks, actions, bridge, executor, orderQuery: orderQuery ?? emptyOrderQuery() };
}

/** 登记一个任务（步骤表非空；K10 要求）。 */
export function registerTask(fixture: BridgeFixture, taskId = 'task-1', stepIds: readonly string[] = ['s1', 's2']) {
  return fixture.tasks.registerTask({ taskId, stepIds });
}

/**
 * 走到"已占用"的最小前置：入账 → 确认 → 发行 → 占用。
 * 返回提交记录（state=`submitting`、sendIntentAt=null）。
 */
export function driveToConsumed(fixture: BridgeFixture, confirm: ConfirmAction = baseConfirm()): SubmissionRecord {
  fixture.actions.recordConfirmAction(confirm);
  const attestation = fixture.actions.attest(confirm.taskId, confirm.actionId, { surface: 'native.confirm' });
  const grant = fixture.actions.issueGrant(attestation);
  const outcome = fixture.actions.consume({ grantId: grant.grantId, actual: bindingOf(confirm) });
  return outcome.submission;
}

/** 走到"已发出未取回"：占用 + send()。executor 决定 landed 状态（accepted → submitted；unknown → unknown）。 */
export async function driveToSent(
  fixture: BridgeFixture,
  confirm: ConfirmAction = baseConfirm(),
): Promise<SubmissionRecord> {
  const submission = driveToConsumed(fixture, confirm);
  return fixture.actions.send(submission.submissionId);
}

/** 一张受控真实回执（`verificationMode: 'real'`，故 `confirmed` 合法）。 */
export function realConfirmedReceipt(submission: SubmissionRecord): ExternalReceipt {
  return createTrustedReceipt({
    actionId: submission.actionId,
    provider: 'meituan',
    requestRef: submission.submissionId,
    externalId: 'ext-1',
    observedState: 'confirmed',
    observedAt: T0 + 1_000,
    evidenceRef: 'evid:fixture-1',
    verificationMode: 'real',
    detail: 'fixture 原单已存在的真实回执',
  });
}

// ---------------------------------------------------------------------------
// 反例断言：没有抛错就是失败
// ---------------------------------------------------------------------------

export function expectBridgeError(fn: () => unknown, code: string): TaskExternalBridgeError {
  let caught: unknown;
  let threw = false;
  try {
    fn();
  } catch (error) {
    caught = error;
    threw = true;
  }
  if (!threw) {
    throw new Error(`期望抛出桥错误码 ${code}，但调用没有抛错（判据是空壳：该拒的没拒）`);
  }
  if (!isTaskExternalBridgeError(caught)) {
    throw new Error(`期望抛出 TaskExternalBridgeError(${code})，实际收到 ${String(caught)}`);
  }
  const error = caught as TaskExternalBridgeError;
  if (error.code !== code) {
    throw new Error(`期望桥错误码 ${code}，实际是 ${error.code}：${error.message}`);
  }
  return error;
}

export async function expectAsyncBridgeError(
  fn: () => Promise<unknown>,
  code: string,
): Promise<TaskExternalBridgeError> {
  let caught: unknown;
  let threw = false;
  try {
    await fn();
  } catch (error) {
    caught = error;
    threw = true;
  }
  if (!threw) {
    throw new Error(`期望抛出桥错误码 ${code}，但调用没有抛错（判据是空壳：该拒的没拒）`);
  }
  if (!isTaskExternalBridgeError(caught)) {
    throw new Error(`期望抛出 TaskExternalBridgeError(${code})，实际收到 ${String(caught)}`);
  }
  const error = caught as TaskExternalBridgeError;
  if (error.code !== code) {
    throw new Error(`期望桥错误码 ${code}，实际是 ${error.code}：${error.message}`);
  }
  return error;
}

/** 期望一个 K07 域内拒因（原样上抛，不被桥重包）。 */
export function expectAuthorizationError(fn: () => unknown, code: string): AuthorizationError {
  let caught: unknown;
  let threw = false;
  try {
    fn();
  } catch (error) {
    caught = error;
    threw = true;
  }
  if (!threw) {
    throw new Error(`期望抛出 K07 错误码 ${code}，但调用没有抛错`);
  }
  if (!isAuthorizationError(caught)) {
    throw new Error(`期望抛出 AuthorizationError(${code})，实际收到 ${String(caught)}`);
  }
  const error = caught as AuthorizationError;
  if (error.code !== code) {
    throw new Error(`期望 K07 错误码 ${code}，实际是 ${error.code}：${error.message}`);
  }
  return error;
}

export async function expectAsyncAuthorizationError(
  fn: () => Promise<unknown>,
  code: string,
): Promise<AuthorizationError> {
  let caught: unknown;
  let threw = false;
  try {
    await fn();
  } catch (error) {
    caught = error;
    threw = true;
  }
  if (!threw) {
    throw new Error(`期望抛出 K07 错误码 ${code}，但调用没有抛错`);
  }
  if (!isAuthorizationError(caught)) {
    throw new Error(`期望抛出 AuthorizationError(${code})，实际收到 ${String(caught)}`);
  }
  const error = caught as AuthorizationError;
  if (error.code !== code) {
    throw new Error(`期望 K07 错误码 ${code}，实际是 ${error.code}：${error.message}`);
  }
  return error;
}

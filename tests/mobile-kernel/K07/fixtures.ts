/**
 * K07 夹具：把授权链路的三个端口（时钟 / 执行器 / 原单查询）与一条标准确认请求装配好，
 * 让每条用例都能**独立驱动**模块，不依赖真实网络、不依赖真实时间。
 *
 * 反例纪律：`expectError` / `expectErrorAsync` 在**没有抛错时主动失败**。
 * 若只用 `expect(fn).toThrow()` 而实现悄悄改成返回 `false`（不抛），
 * 判据就会退化成空壳——这里宁可让用例红，也不让"没拒绝"悄悄溜过。
 */

import {
  createAuthorizationLedger,
  createManualClock,
  isAuthorizationError,
  type ActionBinding,
  type AuthorizationError,
  type AuthorizationLedger,
  type ConfirmAction,
  type ExecutorOutcome,
  type ExternalReceipt,
  type ExternalSubmitRequest,
  type ManualClock,
  type OrderQueryPort,
  type OrderQueryRequest,
} from '../../../apps/mobile-kernel/actions/index.js';

/** 夹具时间原点（任意常数，与真实时间无关，只用于过期判据）。 */
export const T0 = 1_700_000_000_000;

/**
 * 标准确认请求：金额 3980 分（¥39.80），人民币，60 秒有效期。
 *
 * 取值形状与 `contracts/mobile-v1/schemas/confirm-action.schema.json` 对齐：
 * `accountRef` 形如 `acct:...`、`paramsDigest` 形如 `sha256:<64 hex>`、
 * `scope` 取契约 enum 值 `purchase`。
 *
 * `taskId`（2026-10-03 集成加入）是**任务身份**：它是绑定的一项，且账本以
 * `(taskId, actionId)` 为键——因此换一个 taskId 即换一个动作。
 */
export function baseConfirm(overrides: Partial<ConfirmAction> = {}): ConfirmAction {
  return {
    taskId: 'task:demo-1',
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

// ---------------------------------------------------------------------------
// 执行器端口（记录每一次对外发出）
// ---------------------------------------------------------------------------

export interface RecordingExecutor {
  readonly identity: string;
  /** 真实被调用的次数与请求内容——"只发出一次"的判据就靠它。 */
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

/** 永远受理（正例默认）。 */
export function acceptingExecutor(): RecordingExecutor {
  return recordingExecutor(() => ({ outcome: 'accepted' as const }));
}

// ---------------------------------------------------------------------------
// 原单查询端口
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

export interface K07Fixture {
  readonly ledger: AuthorizationLedger;
  readonly clock: ManualClock;
  /** 与账本自身的端口一致：显式传 `null` 表示"没有执行器"（用于 `missing_executor` 负例）。 */
  readonly executor: RecordingExecutor | null;
  readonly orderQuery: RecordingOrderQuery | null;
  readonly confirm: ConfirmAction;
}

export function setupFixture(
  options: {
    readonly executor?: RecordingExecutor | null;
    readonly orderQuery?: RecordingOrderQuery | null;
    readonly confirm?: Partial<ConfirmAction>;
    readonly clock?: number;
  } = {},
): K07Fixture {
  const clock = createManualClock(options.clock ?? T0);
  const executor = options.executor === undefined ? acceptingExecutor() : options.executor;
  const orderQuery = options.orderQuery === undefined ? emptyOrderQuery() : options.orderQuery;
  const ledger = createAuthorizationLedger({ clock, executor, orderQuery });
  const confirm = baseConfirm(options.confirm);
  ledger.recordConfirmAction(confirm);
  return { ledger, clock, executor, orderQuery, confirm };
}

/** 走完"入账 → 确认 → 发行"的最小前置。 */
export function issuedGrant(fixture: K07Fixture) {
  const attestation = fixture.ledger.attest(fixture.confirm.taskId, fixture.confirm.actionId, {
    surface: 'native.confirm',
  });
  return { attestation, grant: fixture.ledger.issueGrant(attestation) };
}

/** 九项绑定的浅拷贝（用于构造"只改了一项"的提交实际值）。 */
export function binding(overrides: Partial<ActionBinding> = {}): ActionBinding {
  const source = baseConfirm();
  return Object.freeze({
    taskId: source.taskId,
    actionId: source.actionId,
    accountRef: source.accountRef,
    taskRevision: source.taskRevision,
    paramsDigest: source.paramsDigest,
    quoteRef: source.quoteRef,
    amount: source.amount,
    currency: source.currency,
    scope: source.scope,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 反例断言：**没有抛错就是失败**
// ---------------------------------------------------------------------------

export function expectError(fn: () => unknown, code: string, field?: string): AuthorizationError {
  let caught: unknown;
  let threw = false;
  try {
    fn();
  } catch (error) {
    caught = error;
    threw = true;
  }
  if (!threw) {
    throw new Error(`期望抛出错误码 ${code}，但调用没有抛错（判据是空壳：该拒的没拒）`);
  }
  if (!isAuthorizationError(caught)) {
    throw new Error(`期望抛出 AuthorizationError(${code})，实际收到 ${String(caught)}`);
  }
  const error = caught as AuthorizationError;
  if (error.code !== code) {
    throw new Error(`期望错误码 ${code}，实际是 ${error.code}：${error.message}`);
  }
  if (field !== undefined && error.field !== field) {
    throw new Error(`期望拒因字段 ${field}，实际是 ${String(error.field)}：${error.message}`);
  }
  return error;
}

export async function expectErrorAsync(
  fn: () => Promise<unknown>,
  code: string,
  field?: string,
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
    throw new Error(`期望抛出错误码 ${code}，但调用没有抛错（判据是空壳：该拒的没拒）`);
  }
  if (!isAuthorizationError(caught)) {
    throw new Error(`期望抛出 AuthorizationError(${code})，实际收到 ${String(caught)}`);
  }
  const error = caught as AuthorizationError;
  if (error.code !== code) {
    throw new Error(`期望错误码 ${code}，实际是 ${error.code}：${error.message}`);
  }
  if (field !== undefined && error.field !== field) {
    throw new Error(`期望拒因字段 ${field}，实际是 ${String(error.field)}：${error.message}`);
  }
  return error;
}

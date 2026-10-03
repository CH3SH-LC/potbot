/**
 * K-I08 夹具：手动时钟 + 标准确认请求 + 记录用的执行器 / 原单查询端口。
 *
 * 与 K07 的夹具同源，但**自持一份**：K-I08 验证的是"落盘/冷启动"，不该被 K07 夹具的
 * 措辞变化牵动。所有端口都是纯内存夹具，不碰网络、不碰真实时间。
 */

import { createManualClock, type ManualClock } from '../../../apps/mobile-kernel/actions/clock.js';
import type {
  ActionBinding,
  ConfirmAction,
  ExecutorOutcome,
  ExternalReceipt,
  ExternalSubmitRequest,
  OrderQueryPort,
  OrderQueryRequest,
} from '../../../apps/mobile-kernel/actions/types.js';
import { createTrustedReceipt } from '../../../apps/mobile-kernel/actions/ledger.js';

/** 夹具时间原点（任意常数，与真实时间无关）。 */
export const T0 = 1_700_000_000_000;

export function manualClock(start: number = T0): ManualClock {
  return createManualClock(start);
}

/** 标准确认请求：¥39.80 / CNY / 60s 有效期，九项绑定齐备（含 taskId）。 */
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
    expiresAt: T0 + 10_000_000,
    ...overrides,
  };
}

/** 九项绑定的浅拷贝（用于构造占用时的 `actual`）。 */
export function bindingOf(source: ActionBinding): ActionBinding {
  return {
    taskId: source.taskId,
    actionId: source.actionId,
    accountRef: source.accountRef,
    taskRevision: source.taskRevision,
    paramsDigest: source.paramsDigest,
    quoteRef: source.quoteRef,
    amount: source.amount,
    currency: source.currency,
    scope: source.scope,
  };
}

// ---------------------------------------------------------------------------
// 执行器 / 原单查询端口（记录每一次对外调用）
// ---------------------------------------------------------------------------

export interface RecordingExecutor {
  readonly identity: string;
  /** 真实被调用的次数与请求——"恢复期绝不重发"的判据就靠它。 */
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

/** 永远受理。 */
export function acceptingExecutor(): RecordingExecutor {
  return recordingExecutor(() => ({ outcome: 'accepted' as const }));
}

/** 一发出就抛错：模拟"发出途中进程死亡"（账本停在 submitting + sendIntentAt）。 */
export function dyingExecutor(): RecordingExecutor {
  return recordingExecutor(() => {
    throw new Error('模拟：发出途中进程死亡（无网络回执）');
  });
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

export function emptyOrderQuery(): RecordingOrderQuery {
  return recordingOrderQuery(() => null);
}

/** 造一张**受控**回执（本包唯一被账本接受的来源）。 */
export function trustedReceipt(overrides: Partial<Parameters<typeof createTrustedReceipt>[0]> = {}): ExternalReceipt {
  return createTrustedReceipt({
    actionId: 'act-1',
    provider: 'meituan',
    requestRef: 'sub:task-1:act-1',
    externalId: 'mt-order-9001',
    observedState: 'confirmed',
    observedAt: T0 + 5000,
    evidenceRef: 'evidence:mt-9001',
    verificationMode: 'real',
    detail: '商户已接单',
    ...overrides,
  });
}

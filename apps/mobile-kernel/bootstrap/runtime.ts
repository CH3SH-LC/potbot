/**
 * K01 —— 可嵌入的业务运行时（引导层核心）。
 *
 * 这是手机内核在 Android Service 内**承载业务模块**的最小宿主：只管
 * 启动/关闭、命令路由、事件扇出、idempotency、revision 守卫、取消。
 * 业务语义（对话、派发、模板、Word/XLS/PPT、美团）由**注册进来的模块**实现；
 * 引导层不 import 任何业务代码（同一份 TS 可在 QuickJS / V8 / Node 里加载）。
 *
 * 硬口径（逐条由 tests/mobile-kernel/K01 机器化断言）：
 *   I1 fail-closed：`succeeded` 必须携带 `resultRef`；缺执行器只能 `failed` +
 *      `EXECUTOR_UNAVAILABLE`，绝不上报 succeeded（契约不变量 3）。
 *   I2 幂等：同一 `idempotencyKey` 重复提交返回**原事件**（同 eventId/seq/status），
 *      带 `idempotentReplay:true`，且**不**再调用处理器、**不**再扇出给订阅者。
 *   I3 revision 守卫：mutation 的 `expectedRevision` 与当前不符 ⇒ `conflict`，
 *      **不**调用处理器（契约不变量：旧修订明确冲突，不是 succeeded）。
 *   I4 取消：`cancelInFlight` 置 AbortSignal；处理器 settle 后状态以 signal 为准，
 *      强制为 `cancelled`（迟到的 succeeded 不得覆盖取消）。
 *   I5 seq 单调：事件流 `seq` 从 1 起严格递增，无空洞。
 *   I6 订阅隔离：单个订阅者抛错不影响其他订阅者与本次 dispatch。
 *   I7 未启动/边界非法：`RUNTIME_NOT_RUNNING` / `COMMAND_INVALID` / `PAYLOAD_FORBIDDEN`
 *      一律**抛**（见 errors.ts 分层口径）。
 */

import type { Command, CommandOperation, Event, EventError, EventStatus } from '../../../contracts/mobile-v1/types.js';
import { bootstrapError, type BootstrapIssue } from './errors.js';
import { scanPayload } from './guard.js';
import type {
  BootstrapModule,
  BootstrapRuntime,
  BootstrapRuntimeOptions,
  Clock,
  EventListener,
  OperationContext,
  OperationHandler,
  OperationOutcome,
  RuntimeState,
  Subscription,
} from './types.js';
import { validateCommand } from './validate.js';

export type { BootstrapRuntime } from './types.js';

interface InFlight {
  readonly controller: AbortController;
}

const CANCELLED_ERROR: EventError = { code: 'CANCELLED_BY_USER', message: '用户取消了该命令' };
const EXECUTOR_UNAVAILABLE: EventError = {
  code: 'EXECUTOR_UNAVAILABLE',
  message: '缺少可用执行器，未执行任何外部动作',
  retryable: true,
};

const MUTATION_OPERATIONS = new Set<CommandOperation>(['mutate', 'apply', 'export', 'undo', 'redo']);
const WRITE_OPERATIONS = new Set<CommandOperation>(['create', 'import', 'mutate', 'apply', 'export', 'undo', 'redo']);

export function createBootstrapRuntime(options: BootstrapRuntimeOptions): BootstrapRuntime {
  const clock: Clock = options.clock;
  const verificationMode = options.verificationMode ?? 'fixture';

  let state: RuntimeState = 'stopped';
  let seq = 0;
  let subscriptionSeq = 0;

  const modulesByOperation = new Map<CommandOperation, { moduleId: string; handler: OperationHandler }>();
  const subscribers = new Map<string, EventListener>();
  const revisions = new Map<string, number>();
  const idempotency = new Map<string, Event>();
  const inFlight = new Map<string, InFlight>();

  function nextSeq(): number {
    seq += 1;
    return seq;
  }

  function targetKey(command: Command): string {
    const payload = command.payload as Record<string, unknown>;
    const explicit = payload.targetId ?? payload.id ?? payload.taskId ?? payload.conversationId;
    if (typeof explicit === 'string' && explicit.length > 0) return explicit;
    // create 未给目标：以 commandId 作为新对象身份（内核生成）。
    return `gen:${command.commandId}`;
  }

  function currentRevision(key: string): number {
    return revisions.get(key) ?? 0;
  }

  function publish(event: Event): void {
    for (const listener of [...subscribers.values()]) {
      try {
        listener(event);
      } catch {
        // I6：单个订阅者抛错不影响其他订阅者与调用方。
      }
    }
  }

  function buildEvent(
    command: Command,
    fields: { status: EventStatus; revision: number; resultRef?: string; error?: EventError },
  ): Event {
    const next = seq + 1;
    seq = next;
    return {
      eventId: `evt-${next}`,
      seq: next,
      commandId: command.commandId,
      revision: fields.revision,
      status: fields.status,
      verificationMode,
      idempotentReplay: false,
      metadata: { emittedAt: clock.now() },
      ...(fields.resultRef === undefined ? {} : { resultRef: fields.resultRef }),
      ...(fields.error === undefined ? {} : { error: fields.error }),
    };
  }

  function commit(command: Command, event: Event): Event {
    idempotency.set(command.idempotencyKey, event);
    publish(event);
    return event;
  }

  async function runHandler(
    command: Command,
    entry: { moduleId: string; handler: OperationHandler },
    key: string,
  ): Promise<{ outcome: OperationOutcome; aborted: boolean }> {
    const controller = new AbortController();
    inFlight.set(command.commandId, { controller });
    const ctx: OperationContext = {
      command,
      signal: controller.signal,
      now: clock.now(),
      emit: (emit) => {
        const event = buildEvent(command, {
          status: emit.status,
          revision: emit.revision ?? currentRevision(key),
          ...(emit.error === undefined ? {} : { error: emit.error }),
        });
        publish(event);
      },
    };
    try {
      const outcome = await entry.handler(command, ctx);
      return { outcome, aborted: controller.signal.aborted };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { outcome: { status: 'cancelled', error: CANCELLED_ERROR }, aborted: true };
      }
      throw error;
    } finally {
      inFlight.delete(command.commandId);
    }
  }

  async function dispatch(command: unknown): Promise<Event> {
    if (state !== 'running') {
      throw bootstrapError('RUNTIME_NOT_RUNNING', `运行时未启动（当前 ${state}）`);
    }

    const validation = validateCommand(command);
    if (!validation.ok) {
      throw bootstrapError('COMMAND_INVALID', `命令形状非法（${validation.issues.length} 处）`, validation.issues);
    }
    const cmd = command as Command;

    const forbidden = scanPayload(cmd.payload);
    if (forbidden.length > 0) {
      throw bootstrapError('PAYLOAD_FORBIDDEN', `载荷夹带禁止内容（${forbidden.length} 处）`, forbidden);
    }

    // I2：幂等命中——返回原事件，不重跑、不重扇出。
    const prior = idempotency.get(cmd.idempotencyKey);
    if (prior !== undefined) {
      return { ...prior, idempotentReplay: true };
    }

    const key = targetKey(cmd);

    // 取消命令由引导层内建处理（不路由给业务模块）。
    if (cmd.operation === 'cancel') {
      const event = buildEvent(cmd, { status: 'cancelled', revision: currentRevision(key), error: CANCELLED_ERROR });
      return commit(cmd, event);
    }

    const entry = modulesByOperation.get(cmd.operation);
    if (entry === undefined) {
      // I1：缺执行器 ⇒ fail-closed，绝不 succeeded。
      const event = buildEvent(cmd, { status: 'failed', revision: currentRevision(key), error: EXECUTOR_UNAVAILABLE });
      return commit(cmd, event);
    }

    // I3：mutation 的 revision 守卫（在调用处理器之前判定）。
    if (MUTATION_OPERATIONS.has(cmd.operation)) {
      const payload = cmd.payload as Record<string, unknown>;
      const expected = payload.expectedRevision;
      const current = currentRevision(key);
      if (typeof expected === 'number' && expected !== current) {
        const conflictError: EventError = {
          code: 'REVISION_CONFLICT',
          message: `expectedRevision=${expected} 与当前 ${current} 不符`,
          details: { expectedRevision: expected, currentRevision: current },
        };
        const event = buildEvent(cmd, { status: 'conflict', revision: current, error: conflictError });
        return commit(cmd, event);
      }
    }

    let outcome: OperationOutcome;
    let aborted: boolean;
    try {
      const ran = await runHandler(cmd, entry, key);
      outcome = ran.outcome;
      aborted = ran.aborted;
    } catch (error) {
      const failedEvent = buildEvent(cmd, {
        status: 'failed',
        revision: currentRevision(key),
        error: {
          code: 'HANDLER_ERROR',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      });
      return commit(cmd, failedEvent);
    }

    // I4：settle 时以 signal 为准——取消优先于处理器声称的终局。
    let status: EventStatus = aborted ? 'cancelled' : outcome.status;
    let error: EventError | undefined = aborted ? CANCELLED_ERROR : outcome.error;

    if (status === 'succeeded' && (outcome.resultRef === undefined || outcome.resultRef.length === 0)) {
      // I1 fail-closed：没有结果引用不得 succeeded。
      status = 'failed';
      error = { code: 'RESULT_REF_REQUIRED', message: 'succeeded 必须携带 resultRef（fail-closed）' };
    }

    let revision = currentRevision(key);
    if (outcome.revision !== undefined) {
      revision = outcome.revision;
      if (status === 'succeeded') revisions.set(key, revision);
    } else if (status === 'succeeded' && WRITE_OPERATIONS.has(cmd.operation)) {
      revision = currentRevision(key) + 1;
      revisions.set(key, revision);
    }

    const event = buildEvent(cmd, {
      status,
      revision,
      ...(status === 'succeeded' && outcome.resultRef !== undefined ? { resultRef: outcome.resultRef } : {}),
      ...(error === undefined ? {} : { error }),
    });
    return commit(cmd, event);
  }

  function start(): void {
    if (state === 'running') throw bootstrapError('RUNTIME_ALREADY_RUNNING', '运行时已在运行');
    if (state === 'starting') throw bootstrapError('RUNTIME_ALREADY_RUNNING', '运行时正在启动');
    state = 'starting';
    state = 'running';
  }

  function stop(): void {
    if (state === 'stopped') return;
    state = 'stopping';
    for (const { controller } of inFlight.values()) controller.abort();
    inFlight.clear();
    state = 'stopped';
  }

  function registerModule(module: BootstrapModule): void {
    for (const operation of module.operations) {
      const existing = modulesByOperation.get(operation);
      if (existing !== undefined) {
        const issues: BootstrapIssue[] = [
          { path: operation, code: 'MODULE_CONFLICT', message: `operation ${operation} 已被模块 ${existing.moduleId} 认领` },
        ];
        throw bootstrapError('MODULE_CONFLICT', `operation ${operation} 重复认领`, issues);
      }
    }
    for (const operation of module.operations) {
      modulesByOperation.set(operation, { moduleId: module.id, handler: module.handle });
    }
  }

  function subscribe(listener: EventListener): Subscription {
    subscriptionSeq += 1;
    const id = `sub-${subscriptionSeq}`;
    subscribers.set(id, listener);
    return {
      id,
      unsubscribe: () => {
        subscribers.delete(id);
      },
    };
  }

  function cancelInFlight(commandId: string): boolean {
    const entry = inFlight.get(commandId);
    if (entry === undefined) return false;
    entry.controller.abort();
    return true;
  }

  return {
    get state() {
      return state;
    },
    start,
    stop,
    registerModule,
    dispatch,
    subscribe,
    cancelInFlight,
    inFlight: () => [...inFlight.keys()],
  } satisfies BootstrapRuntime;
}

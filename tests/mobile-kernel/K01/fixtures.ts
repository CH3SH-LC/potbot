/**
 * K01 测试夹具：构造合法命令、记录型业务模块、调用方、延迟器。
 *
 * 命令一律用 `mobile-v1` 冻结形状（与 `contracts/mobile-v1/schemas/command.schema.json`
 * 一致），不自己另造字段。
 */

import type {
  BootstrapModule,
  CallerIdentity,
  Command,
  CommandOperation,
  OperationContext,
  OperationOutcome,
} from '../../../apps/mobile-kernel/bootstrap/index.js';

export const CALLER_APP: CallerIdentity = { origin: 'app://local', kind: 'ui-webview', packageName: 'com.potbot.demo' };

export function makeCaller(overrides: Partial<CallerIdentity> = {}): CallerIdentity {
  return { ...CALLER_APP, ...overrides };
}

export function makeCommand(overrides: Partial<Command> = {}): Command {
  return {
    schemaVersion: 'mobile-v1',
    commandId: 'cmd-0001',
    operation: 'create',
    idempotencyKey: 'idem-0001',
    payload: { goal: '把这份周报改成一页', templateId: 'word-doc' },
    ...overrides,
  };
}

export interface Recording {
  readonly calls: Array<{ readonly command: Command; readonly aborted: boolean }>;
}

/** 记录处理器调用；`behavior` 决定返回什么（缺省即成功并带 resultRef）。 */
export function recordingModule(
  id: string,
  operations: readonly CommandOperation[],
  behavior?: (command: Command, ctx: OperationContext) => OperationOutcome | Promise<OperationOutcome>,
): { module: BootstrapModule; recording: Recording } {
  const recording: Recording = { calls: [] };
  const module: BootstrapModule = {
    id,
    operations,
    handle: async (command, ctx) => {
      recording.calls.push({ command, aborted: ctx.signal.aborted });
      if (behavior !== undefined) return behavior(command, ctx);
      return { status: 'succeeded', resultRef: `artifact:${id}@1` };
    },
  };
  return { module, recording };
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 让微任务队列跑空，便于断言 subscribe 的异步扇出。 */
export async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

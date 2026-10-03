/**
 * K-I26：把 K-R03 的幂等账本**提升为产品模块**（`apps/mobile-kernel/toolguard/`）并接线到
 * `model/tools.ts` 的 `runToolLoop` 作为**执行器侧护栏**。
 *
 * ## 本文件要钉死的一件事
 *
 * `runToolLoop` 自己的 `ToolActionLedger` 以 `toolCallId` 为键。它在**同一 ID**的重试下能挡住
 * 重复执行；但产品级重试里，供应商完全可能**换一个 `toolCallId`** 再发同一个动作。只看 ID
 * 会漏判，同一个 `order.submit` 被真执行两次——用户被下两次单。
 *
 * 因此这里用**朴素重试对照**证明：
 *   ① 不接护栏、每次运行新建 ledger ⇒ 换 ID 后执行器被调用 **2 次**（错误路径存在）；
 *   ② 复用共享 `ToolActionLedger`、仍不接护栏 ⇒ 换 ID 后仍 **2 次**（ID 键的盲区）；
 *   ③ 接 `ToolLoopOptions.guard`（提升后的 `ToolIdempotencyLedger`）⇒ 换 ID 后只 **1 次**，
 *      第二次复用**第一次的返回值**（不是"碰巧没重试"）。
 *
 * 全部走真实 `ModelPort` + 脚本化假 transport + 真实 `runToolLoop`，是对产品模块的端到端行为断言。
 */

import { describe, expect, it } from 'vitest';

import {
  createModelPort,
  createScriptedTransport,
  mayClaimModelSuccess,
  runToolLoop,
  ToolActionLedger,
  buildModelRequest,
  type ModelPortRequest,
  type RawStreamEvent,
  type ScriptedTransportStep,
} from '../../../apps/mobile-kernel/model/index.js';
import {
  ToolIdempotencyLedger,
  deriveToolKey,
  runWithRetry,
} from '../../../apps/mobile-kernel/toolguard/index.js';

// --- 小工具 -------------------------------------------------------------------

const done = (): RawStreamEvent => ({ kind: 'done' });
const text = (value: string): RawStreamEvent => ({ kind: 'text', text: value });
const toolCall = (toolCallId: string, toolName: string, args: Record<string, unknown>): RawStreamEvent => ({
  kind: 'tool-call',
  toolCallId,
  toolName,
  arguments: args,
});

function request(): ModelPortRequest {
  return buildModelRequest({
    messages: [{ role: 'user', content: 'hi' }],
    keyRef: 'keyref:test',
    budget: { maxTokens: 1000 },
  });
}

const SUBMIT_ARGS = { sku: 'A', qty: 1 };

/** 一次"工具轮 + 断流(429)"的失败运行脚本。 */
function failingScript(id: string): ScriptedTransportStep[] {
  return [
    { events: [toolCall(id, 'order.submit', SUBMIT_ARGS), done()] },
    { status: 429 },
  ];
}

/** 一次"工具轮 + 收束"的成功运行脚本。 */
function successScript(id: string): ScriptedTransportStep[] {
  return [
    { events: [toolCall(id, 'order.submit', SUBMIT_ARGS), done()] },
    { events: [text('下单完成'), done()] },
  ];
}

// -----------------------------------------------------------------------------

describe('K-I26 ① 朴素对照：不接护栏，换 ID 的跨运行重试确实重复执行（证明护栏承重）', () => {
  it('每次运行新建 ledger、无 guard：两次运行让 order.submit 执行 2 次', async () => {
    let invocations = 0;
    const executor = () => {
      invocations += 1;
      return { orderId: `o-${invocations}` };
    };

    // 第一次：执行工具后第 2 轮 429 → 整体失败。
    const first = await runToolLoop(createModelPort({ transport: createScriptedTransport(failingScript('call_1')) }), request(), {
      executor,
    });
    expect(first.status).toBe('failed');
    expect(invocations).toBe(1);

    // 重试：供应商换了 ID（call_2），但动作同名同参。无共享护栏 ⇒ 再执行一次。
    const second = await runToolLoop(createModelPort({ transport: createScriptedTransport(successScript('call_2')) }), request(), {
      executor,
    });
    expect(second.status).toBe('succeeded');
    expect(invocations).toBe(2); // 用户被下两次单
    expect(second.toolExecutions[0]?.result).toEqual({ orderId: 'o-2' });
  });

  it('复用共享 ToolActionLedger 但无 guard：换 ID 后仍执行 2 次（toolCallId 键的盲区）', async () => {
    let invocations = 0;
    const executor = () => {
      invocations += 1;
      return { orderId: `o-${invocations}` };
    };
    const sharedLedger = new ToolActionLedger();

    await runToolLoop(createModelPort({ transport: createScriptedTransport(failingScript('call_1')) }), request(), {
      executor,
      ledger: sharedLedger,
    });
    await runToolLoop(createModelPort({ transport: createScriptedTransport(successScript('call_2')) }), request(), {
      executor,
      ledger: sharedLedger,
    });

    // call_2 对 ledger 是新 ID ⇒ 不命中回放 ⇒ 执行器再跑一次。
    expect(invocations).toBe(2);
  });
});

describe('K-I26 ② 护栏路径：接提升后的 ToolIdempotencyLedger，换 ID 也只执行一次', () => {
  it('共享 guard、每次新建 ledger、换 ID：order.submit 只执行 1 次并复用首次返回值', async () => {
    let invocations = 0;
    const executor = () => {
      invocations += 1;
      return { orderId: `o-${invocations}` };
    };
    const guard = new ToolIdempotencyLedger();

    const first = await runToolLoop(createModelPort({ transport: createScriptedTransport(failingScript('call_1')) }), request(), {
      executor,
      guard,
      guardScope: 'task-1',
    });
    expect(first.status).toBe('failed');
    expect(invocations).toBe(1);
    expect(first.guard).toBe(guard); // 结果带出护栏，便于上层跨批复用

    const second = await runToolLoop(createModelPort({ transport: createScriptedTransport(successScript('call_2')) }), request(), {
      executor,
      guard,
      guardScope: 'task-1',
    });

    expect(second.status).toBe('succeeded');
    expect(invocations).toBe(1); // 关键判据：换 ID 也没第二次执行
    expect(second.toolExecutions).toHaveLength(1);
    // 回灌给模型的是**第一次**的结果（o-1），不是重新计算出来的 o-2。
    expect(second.toolExecutions[0]?.result).toEqual({ orderId: 'o-1' });
    expect(guard.size).toBe(1);
    expect(guard.get(deriveToolKey('task-1', { toolName: 'order.submit', arguments: SUBMIT_ARGS }))?.state).toBe('executed');
  });

  it('同一 ID 的跨运行重试同样只执行 1 次', async () => {
    let invocations = 0;
    const executor = () => {
      invocations += 1;
      return { orderId: `o-${invocations}` };
    };
    const guard = new ToolIdempotencyLedger();

    await runToolLoop(createModelPort({ transport: createScriptedTransport(failingScript('call_1')) }), request(), {
      executor,
      guard,
      guardScope: 'task-1',
    });
    await runToolLoop(createModelPort({ transport: createScriptedTransport(successScript('call_1')) }), request(), {
      executor,
      guard,
      guardScope: 'task-1',
    });

    expect(invocations).toBe(1);
  });

  it('guardScope 隔离：不同任务里同名同参的动作各自执行（不误判成重试）', async () => {
    let invocations = 0;
    const executor = () => {
      invocations += 1;
      return { orderId: `o-${invocations}` };
    };
    const guard = new ToolIdempotencyLedger();

    await runToolLoop(createModelPort({ transport: createScriptedTransport(successScript('call_1')) }), request(), {
      executor,
      guard,
      guardScope: 'task-1',
    });
    await runToolLoop(createModelPort({ transport: createScriptedTransport(successScript('call_2')) }), request(), {
      executor,
      guard,
      guardScope: 'task-2',
    });

    expect(invocations).toBe(2); // 两个任务各一次
    expect(guard.size).toBe(2);
  });

  it('失败动作不被护栏重跑：执行器抛错后，跨运行重试执行器总调用数仍为 1，模型收到 isError 结果', async () => {
    let invocations = 0;
    const executor = () => {
      invocations += 1;
      throw new Error('order gateway boom');
    };
    const guard = new ToolIdempotencyLedger();

    const first = await runToolLoop(createModelPort({ transport: createScriptedTransport(failingScript('call_1')) }), request(), {
      executor,
      guard,
      guardScope: 'task-1',
    });
    expect(first.status).toBe('failed');
    expect(invocations).toBe(1);
    expect(first.toolExecutions[0]?.isError).toBe(true);

    const second = await runToolLoop(createModelPort({ transport: createScriptedTransport(successScript('call_2')) }), request(), {
      executor,
      guard,
      guardScope: 'task-1',
    });

    expect(invocations).toBe(1); // 副作用未知 ⇒ 绝不重跑
    expect(second.toolExecutions[0]?.isError).toBe(true); // 以错误结果回灌，模型可改道
    expect(guard.get(deriveToolKey('task-1', { toolName: 'order.submit', arguments: SUBMIT_ARGS }))?.state).toBe('failed');
  });
});

describe('K-I26 ③ 提升后的 runWithRetry 走产品模块路径（真实 429 → 重试 → 幂等）', () => {
  it('429 后成功；工具执行跨重试只 1 次；成功判据为真', async () => {
    const transport = createScriptedTransport([
      { events: [toolCall('call_1', 'order.submit', SUBMIT_ARGS)] }, // 断流：无 done
      { events: [toolCall('call_2', 'order.submit', SUBMIT_ARGS), done()] },
    ]);
    const ledger = new ToolIdempotencyLedger();
    let invocations = 0;

    const result = await runWithRetry(createModelPort({ transport }), request(), {
      policy: { maxAttempts: 2 },
      tools: {
        ledger,
        executors: {
          'order.submit': () => {
            invocations += 1;
            return { orderId: 'o-1' };
          },
        },
        scope: 'task-1',
      },
    });

    expect(result.attempts).toBe(2);
    expect(mayClaimModelSuccess(result.final)).toBe(true);
    expect(invocations).toBe(1); // 换 ID 仍只执行一次
    expect(result.log[0]?.errorCode).toBe('stream_truncated');
    expect(result.log[0]?.retryable).toBe(true);
  });
});

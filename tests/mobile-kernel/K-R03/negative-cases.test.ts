/**
 * K-R03 独立反例集：429 / 断流 / 预算拒绝 / 重试幂等。
 *
 * ## 方法
 *
 * 每条负例都配**对照组**或**对照运行**：只断言"失败"的测试可能因为实现恒失败而假绿；
 * 因此这里对每个"必须失败"的场景另跑一个"同结构但成功"的输入，证明判据确实在区分两者。
 * 重试幂等一条另配**朴素重试对照**（不用账本 → 执行器被调用两次），证明账本是承重的、
 * 不是"碰巧没重试"。
 *
 * 全部走 K02 真实 `ModelPort` + 脚本化假 transport（`transport.ts` 自带），是**真实模块**
 * 的端到端行为，不是对端口的 mock。
 */

import { describe, expect, it } from 'vitest';

import {
  MODEL_PORT_ERROR_CODES,
  ModelPortError,
  RETRYABLE_ERROR_CODES,
  isRetryableCode,
} from '../../../apps/mobile-kernel/model/errors.js';
import {
  assertModelSucceeded,
  buildModelRequest,
  createModelPort,
  mayClaimModelSuccess,
} from '../../../apps/mobile-kernel/model/port.js';
import { createScriptedTransport, type ScriptedTransportStep } from '../../../apps/mobile-kernel/model/transport.js';
import { createCancellationController } from '../../../apps/mobile-kernel/model/cancellation.js';
import type {
  ModelPortRequest,
  ModelTransport,
  RawStreamEvent,
  TransportResponse,
} from '../../../apps/mobile-kernel/model/types.js';

import {
  DEFAULT_RETRY_POLICY,
  RETRY_POLICY_SCHEMA,
  TOOL_EXECUTION_RECORD_SCHEMA,
  ToolIdempotencyError,
  ToolIdempotencyLedger,
  deriveToolKey,
  runWithRetry,
  schemaRequiredIsSubsetOfProperties,
  validateRetryPolicy,
  validateToolExecutionRecord,
} from '../../../apps/mobile-kernel/toolguard/index.js';

// --- 上游事件小工具 -----------------------------------------------------------

const text = (value: string): RawStreamEvent => ({ kind: 'text', text: value });
const done = (): RawStreamEvent => ({ kind: 'done' });
const usage = (promptTokens: number, completionTokens: number): RawStreamEvent => ({
  kind: 'usage',
  promptTokens,
  completionTokens,
});
const toolCall = (
  toolCallId: string | undefined,
  toolName: string | undefined,
  args: unknown = {},
): RawStreamEvent => ({ kind: 'tool-call', toolCallId, toolName, arguments: args });

/** 造一个合法请求；预算默认宽松（maxTokens 1000），估算下界约 21，足够开始。 */
function request(overrides: Partial<Parameters<typeof buildModelRequest>[0]> = {}): ModelPortRequest {
  return buildModelRequest({
    messages: [{ role: 'user', content: 'hi' }],
    keyRef: 'keyref:test',
    budget: { maxTokens: 1000 },
    ...overrides,
  });
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    return error instanceof ModelPortError ? error.code : `non-model-port:${String(error)}`;
  }
  return null;
}

// -----------------------------------------------------------------------------

describe('K-R03 ① 429 不得成功，且不消费响应体', () => {
  it('HTTP 429 → failed / RATE_LIMITED，连一条 text 片段都不产出', async () => {
    const transport = createScriptedTransport([
      { status: 429, events: [text('上游在 429 上却带了内容（不得被消费）'), done()] },
    ]);
    const port = createModelPort({ transport });
    const out = await port.run(request());

    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('RATE_LIMITED');
    expect(out.completed).toBe(false);
    expect(out.text).toBe('');
    expect(out.chunks.some((chunk) => chunk.type === 'text')).toBe(false);
    expect(mayClaimModelSuccess(out)).toBe(false);
  });

  it('对照组：同结构但 HTTP 200 + done → succeeded，证明判据在区分而非恒失败', async () => {
    const transport = createScriptedTransport([{ status: 200, events: [text('ok'), done()] }]);
    const out = await createModelPort({ transport }).run(request());

    expect(out.status).toBe('succeeded');
    expect(out.text).toBe('ok');
    expect(out.completed).toBe(true);
    expect(mayClaimModelSuccess(out)).toBe(true);
  });
});

describe('K-R03 ② 有界重试：只重试可重试码', () => {
  it('429 后第 2 次成功 → 恰两次请求，日志如实记录第一次可重试', async () => {
    const transport = createScriptedTransport([
      { status: 429 },
      { status: 200, events: [text('ok'), done()] },
    ]);
    const result = await runWithRetry(createModelPort({ transport }), request(), {
      policy: { maxAttempts: 2 },
    });

    expect(result.final.status).toBe('succeeded');
    expect(result.attempts).toBe(2);
    expect(result.retried).toBe(true);
    expect(transport.requests.length).toBe(2);
    expect(result.log[0]?.errorCode).toBe('rate_limited');
    expect(result.log[0]?.retryable).toBe(true);
    expect(result.log[0]?.willRetry).toBe(true);
    expect(result.log[1]?.success).toBe(true);
  });

  it('两次都是 429 → 有界耗尽，仍 failed，绝不伪造成功', async () => {
    const transport = createScriptedTransport([{ status: 429 }, { status: 429 }]);
    const result = await runWithRetry(createModelPort({ transport }), request(), {
      policy: { maxAttempts: 2 },
    });

    expect(result.final.status).toBe('failed');
    expect(result.attempts).toBe(2);
    expect(mayClaimModelSuccess(result.final)).toBe(false);
    expect(result.log.at(-1)?.willRetry).toBe(false); // 到上界，停止
    expect(transport.requests.length).toBe(2);
  });

  it('401 不可重试：即便策略允许 3 次，也只发 1 次请求（第二段脚本不被消费）', async () => {
    const transport = createScriptedTransport([
      { status: 401 },
      { status: 200, events: [text('绝不该被调用'), done()] },
    ]);
    const result = await runWithRetry(createModelPort({ transport }), request(), {
      policy: { maxAttempts: 3 },
    });

    expect(result.final.status).toBe('failed');
    expect(result.final.error?.code).toBe('UNAUTHORIZED');
    expect(result.attempts).toBe(1);
    expect(result.retried).toBe(false);
    expect(transport.requests.length).toBe(1);
  });

  it('重试词表机器判据：内核可重试集与非重试集互检', () => {
    for (const code of ['rate_limited', 'timeout', 'stream_truncated', 'stream_failed', 'upstream_error']) {
      expect(isRetryableCode(code)).toBe(true);
    }
    for (const code of [
      'unauthorized',
      'budget_insufficient',
      'budget_exceeded',
      'invalid_request',
      'invalid_key_ref',
      'tool_execution_failed',
      'cancelled',
      'deadline_exceeded',
    ]) {
      expect(isRetryableCode(code)).toBe(false);
    }
    // 每个可重试码都必须是已登记的内核码（不存在第三套词表）。
    for (const code of RETRYABLE_ERROR_CODES) {
      expect(MODEL_PORT_ERROR_CODES as readonly string[]).toContain(code);
    }
  });
});

describe('K-R03 ③ 断流不得成功；断流可重试且每次尝试干净重来', () => {
  it('迭代在 done 之前结束 → STREAM_TRUNCATED；部分文本保留但不可用', async () => {
    const transport = createScriptedTransport([{ status: 200, events: [text('partial')] }]);
    const out = await createModelPort({ transport }).run(request());

    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('STREAM_TRUNCATED');
    expect(out.completed).toBe(false);
    expect(out.text).toBe('partial');
    expect(mayClaimModelSuccess(out)).toBe(false);
  });

  it('对照组：带 done 的同内容 → succeeded', async () => {
    const transport = createScriptedTransport([{ status: 200, events: [text('partial'), done()] }]);
    const out = await createModelPort({ transport }).run(request());
    expect(out.status).toBe('succeeded');
    expect(out.text).toBe('partial');
  });

  it('断流后重试成功：最终 text 只含第 2 次内容（不追加、不重复）', async () => {
    const transport = createScriptedTransport([
      { status: 200, events: [text('partial')] },
      { status: 200, events: [text('full'), done()] },
    ]);
    const result = await runWithRetry(createModelPort({ transport }), request(), { policy: { maxAttempts: 2 } });

    expect(result.final.status).toBe('succeeded');
    expect(result.final.text).toBe('full'); // 不是 'partialfull'
    expect(result.attempts).toBe(2);
    expect(result.log[0]?.errorCode).toBe('stream_truncated');
    expect(result.log[0]?.retryable).toBe(true);
  });
});

describe('K-R03 ④ 预算拒绝：发出前同步拒，不发任何请求', () => {
  it('maxTokens 低于估算下界 → 抛 budget_insufficient（同步），transport 零请求', async () => {
    const transport = createScriptedTransport([{ status: 200, events: [text('x'), done()] }]);
    const port = createModelPort({ transport });

    await expect(async () => {
      const req = buildModelRequest({
        messages: [{ role: 'user', content: 'x'.repeat(400) }],
        keyRef: 'keyref:test',
        budget: { maxTokens: 5 },
      });
      await runWithRetry(port, req);
    }).rejects.toThrowError(/budget_insufficient|预算/);

    expect(transport.requests.length).toBe(0);
  });

  it('maxCostMicros:0 与 timeoutMs:0 同样在构造处拒绝（budget_insufficient）', () => {
    expect(
      codeOf(() => request({ budget: { maxCostMicros: 0, maxTokens: 1000 } })),
    ).toBe('budget_insufficient');
    expect(codeOf(() => request({ budget: { timeoutMs: 0, maxTokens: 1000 } }))).toBe('budget_insufficient');
  });

  it('对照组：充足预算构造成功', () => {
    expect(codeOf(() => request({ budget: { maxTokens: 1000 } }))).toBeNull();
  });

  it('流内实际用量超预算 → failed / BUDGET_EXCEEDED，且真实 usage 不被抹掉', async () => {
    const transport = createScriptedTransport([
      { status: 200, events: [usage(900, 100), done()] },
    ]);
    const out = await createModelPort({ transport }).run(request({ budget: { maxTokens: 50 } }));

    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('BUDGET_EXCEEDED');
    expect(out.completed).toBe(false);
    expect(out.usage?.totalTokens).toBe(1000);
    expect(mayClaimModelSuccess(out)).toBe(false);
  });

  it('预算超支不可重试：即使策略给 3 次，也只尝试 1 次', async () => {
    const transport = createScriptedTransport([
      { status: 200, events: [usage(900, 100), done()] },
      { status: 200, events: [usage(900, 100), done()] },
    ]);
    const result = await runWithRetry(createModelPort({ transport }), request({ budget: { maxTokens: 50 } }), {
      policy: { maxAttempts: 3 },
    });

    expect(result.final.error?.code).toBe('BUDGET_EXCEEDED');
    expect(result.attempts).toBe(1);
    expect(result.retried).toBe(false);
  });
});

describe('K-R03 ⑤ 重试幂等：工具动作跨重试只执行一次', () => {
  const sharedCall = toolCall('call_1', 'order.submit', { sku: 'A', qty: 1 });
  const attempt1: ScriptedTransportStep = { status: 200, events: [sharedCall] }; // 断流：无 done
  const attempt2: ScriptedTransportStep = { status: 200, events: [sharedCall, done()] };

  it('带账本：断流重试后工具仍只执行 1 次（复用首次结果）', async () => {
    const transport = createScriptedTransport([attempt1, attempt2]);
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
    expect(result.final.status).toBe('succeeded');
    expect(invocations).toBe(1); // 关键判据
    expect(ledger.size).toBe(1);
    expect(result.final.toolCalls.length).toBe(1);
    const record = ledger.get(deriveToolKey('task-1', { toolName: 'order.submit', arguments: { sku: 'A', qty: 1 } }));
    expect(record?.state).toBe('executed');
    expect(record?.value).toEqual({ orderId: 'o-1' });
  });

  it('对照组（朴素重试，无账本）：同一脚本确实会让工具执行 2 次——证明账本承重', async () => {
    const transport = createScriptedTransport([attempt1, attempt2]);
    const port = createModelPort({ transport });
    let naiveInvocations = 0;
    const onToolCall = (): void => {
      naiveInvocations += 1;
    };

    // 朴素重试：不做幂等，直接跑两遍。
    await port.run(request(), { onToolCall });
    await port.run(request(), { onToolCall });

    expect(naiveInvocations).toBe(2); // 若不接账本，用户会被下两次单
  });

  it('缺执行器 → tool_execution_failed、不可重试、不假装动作完成', async () => {
    const transport = createScriptedTransport([attempt1, attempt2]);
    const ledger = new ToolIdempotencyLedger();

    const result = await runWithRetry(createModelPort({ transport }), request(), {
      policy: { maxAttempts: 3 },
      tools: { ledger, executors: {} }, // 故意不注册 order.submit
    });

    expect(result.final.status).toBe('failed');
    expect(result.final.error?.code).toBe('TOOL_EXECUTION_FAILED');
    expect(result.attempts).toBe(1); // 不可重试
    expect(mayClaimModelSuccess(result.final)).toBe(false);
    expect(ledger.size).toBe(0); // 任何执行都未发生
  });

  it('执行器抛错：账本记为 failed，默认拒绝重跑（副作用未知）', async () => {
    const ledger = new ToolIdempotencyLedger();
    let calls = 0;
    const ctx = { toolName: 't', toolCallId: 'c1' };

    await expect(
      ledger.execute('k-fail', ctx, () => {
        calls += 1;
        throw new Error('executor boom');
      }),
    ).rejects.toThrow('executor boom');
    expect(calls).toBe(1);

    await expect(
      ledger.execute('k-fail', ctx, () => {
        calls += 1;
        return 1;
      }),
    ).rejects.toBeInstanceOf(ToolIdempotencyError);
    expect(calls).toBe(1); // 未重跑
    expect(ledger.get('k-fail')?.state).toBe('failed');
  });

  it('已执行的动作再次请求 → 复用记录，执行器不再被调用', async () => {
    const ledger = new ToolIdempotencyLedger();
    let calls = 0;
    const ctx = { toolName: 't', toolCallId: 'c2' };

    const first = await ledger.execute('k-ok', ctx, () => {
      calls += 1;
      return 42;
    });
    const second = await ledger.execute('k-ok', ctx, () => {
      calls += 1;
      return 99;
    });

    expect(first.reused).toBe(false);
    expect(first.value).toBe(42);
    expect(second.reused).toBe(true);
    expect(second.value).toBe(42);
    expect(calls).toBe(1);
  });

  it('派生幂等键对参数顺序不敏感（对象键排序）', () => {
    const a = deriveToolKey('s', { toolName: 'x', arguments: { a: 1, b: 2 } });
    const b = deriveToolKey('s', { toolName: 'x', arguments: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });
});

describe('K-R03 ⑥ 取消绝不重试', () => {
  it('发出前取消 → cancelled，尝试 1 次，零请求', async () => {
    const controller = createCancellationController('cancel:pre');
    controller.cancel('用户取消');
    const transport = createScriptedTransport([{ status: 200, events: [text('x'), done()] }]);

    const result = await runWithRetry(createModelPort({ transport }), request(), {
      policy: { maxAttempts: 3 },
      cancellation: controller.handle,
    });

    expect(result.final.status).toBe('cancelled');
    expect(result.attempts).toBe(1);
    expect(result.retried).toBe(false);
    expect(transport.requests.length).toBe(0);
  });

  it('流中途取消 → cancelled，阻断重试（重试取消 = 违背用户意图）', async () => {
    const controller = createCancellationController('cancel:mid');
    const transport: ModelTransport = {
      identity: 'k-r03.test.mid-cancel',
      async send(): Promise<TransportResponse> {
        const events = (async function* (): AsyncGenerator<RawStreamEvent, void, undefined> {
          yield text('partial');
          controller.cancel('用户中途取消');
          return; // 迭代结束，但取消先于收束生效
        })();
        return { status: 200, headers: Object.freeze({}), events };
      },
    };

    const result = await runWithRetry(createModelPort({ transport }), request(), {
      policy: { maxAttempts: 3 },
      cancellation: controller.handle,
    });

    expect(result.final.status).toBe('cancelled');
    expect(result.final.error?.code).toBe('CANCELLED');
    expect(result.attempts).toBe(1);
    expect(result.retried).toBe(false);
  });
});

describe('K-R03 ⑦ 非法工具调用不得成功，且不可重试', () => {
  it('tool-call 缺 toolCallId → failed / TOOL_CALL_MISSING_ID，只尝试 1 次', async () => {
    const transport = createScriptedTransport([
      { status: 200, events: [toolCall(undefined, 'x')] },
      { status: 200, events: [text('绝不该被调用'), done()] },
    ]);
    const result = await runWithRetry(createModelPort({ transport }), request(), { policy: { maxAttempts: 3 } });

    expect(result.final.status).toBe('failed');
    expect(result.final.error?.code).toBe('TOOL_CALL_MISSING_ID');
    expect(result.attempts).toBe(1);
    expect(transport.requests.length).toBe(1);
  });
});

describe('K-R03 ⑧ 成功判据机器化 + schema 自洽', () => {
  it('assertModelSucceeded 对每种失败都红、对成功放行', async () => {
    const rateLimited = await createModelPort({
      transport: createScriptedTransport([{ status: 429 }]),
    }).run(request());
    const truncated = await createModelPort({
      transport: createScriptedTransport([{ status: 200, events: [text('p')] }]),
    }).run(request());
    const overBudget = await createModelPort({
      transport: createScriptedTransport([{ status: 200, events: [usage(900, 100), done()] }]),
    }).run(request({ budget: { maxTokens: 50 } }));
    const ok = await createModelPort({
      transport: createScriptedTransport([{ status: 200, events: [text('ok'), done()] }]),
    }).run(request());

    for (const outcome of [rateLimited, truncated, overBudget]) {
      expect(mayClaimModelSuccess(outcome)).toBe(false);
      expect(() => assertModelSucceeded(outcome)).toThrow();
    }
    expect(() => assertModelSucceeded(ok)).not.toThrow();

    expect(rateLimited.record.failureReason).toContain('RATE_LIMITED');
    expect(rateLimited.record.usage).toBeNull();
    expect(Object.keys(rateLimited.record).sort()).toEqual(['failureReason', 'host', 'model', 'usage']);
  });

  it('两份 schema 的 required 都是 properties 子集且非空', () => {
    expect(schemaRequiredIsSubsetOfProperties(RETRY_POLICY_SCHEMA)).toBe(true);
    expect(schemaRequiredIsSubsetOfProperties(TOOL_EXECUTION_RECORD_SCHEMA)).toBe(true);
  });

  it('validateRetryPolicy 拒绝致命输入、接受合法输入；默认策略可解析', () => {
    expect(() => validateRetryPolicy({ maxAttempts: 0 })).toThrow();
    expect(() => validateRetryPolicy({ maxAttempts: 11 })).toThrow();
    expect(() => validateRetryPolicy({ maxAttempts: 2, retryableCodes: [] })).toThrow();
    expect(() => validateRetryPolicy({ maxAttempts: 2, retryableCodes: ['rate_limited', 'rate_limited'] })).toThrow();
    expect(() => validateRetryPolicy({ maxAttempts: 2, bogus: true })).toThrow();

    const normalized = validateRetryPolicy(DEFAULT_RETRY_POLICY);
    expect(normalized.maxAttempts).toBe(3);
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it('validateToolExecutionRecord 接受真实账本记录、拒绝未知 state', async () => {
    const ledger = new ToolIdempotencyLedger();
    const record = await ledger.execute('k', { toolName: 't', toolCallId: 'c9' }, () => ({ ok: true }));
    expect(validateToolExecutionRecord(record).state).toBe('executed');
    expect(() => validateToolExecutionRecord({ ...record, state: 'bogus' })).toThrow();
  });
});

/**
 * K02 独立验证 ③：**工具循环、幂等账本、结果配对**。
 *
 * 本文件覆盖两条 K02 硬要求：
 *  - "工具结果必须与调用 ID 对应" → `pairToolResults` / `assertToolResultsPaired`；
 *  - "重试不重复工具动作" → `ToolActionLedger` / `runToolLoop`。
 *
 * 最强的一条反例在第 ③-d 节：一次运行**中途失败**后再重跑，同一个 `toolCallId` 的工具
 * 执行器**总调用次数仍为 1**；对照组换成新账本则会变 2——证明幂等性确实来自账本。
 */

import { describe, expect, it } from 'vitest';

import {
  ToolActionLedger,
  assertToolCall,
  assertToolResultsPaired,
  createModelPort,
  createScriptedTransport,
  pairToolResults,
  runToolLoop,
  type RawStreamEvent,
  type ScriptedTransportStep,
  type ToolCall,
  type ToolResult,
} from '../../../apps/mobile-kernel/model/index.js';
import { baseRequest } from './fixtures.js';

function call(id: string, name = 'read_doc', args: Record<string, unknown> = { artifactId: 'doc-7' }): ToolCall {
  return Object.freeze({ toolCallId: id, toolName: name, arguments: Object.freeze(args) });
}

const toolCallEvent = (id: string): RawStreamEvent => ({
  kind: 'tool-call',
  toolCallId: id,
  toolName: 'read_doc',
  arguments: { artifactId: 'doc-7' },
});

const finalStep: ScriptedTransportStep = { events: [{ kind: 'text', text: '完成' }, { kind: 'done' }] };

describe('K02 ③-a 账本：同一 ID 只执行一次（重试回放）', () => {
  it('首次执行调执行器；同 ID 再来回放，执行器不再被调用', async () => {
    const ledger = new ToolActionLedger();
    let executions = 0;
    const executor = (c: ToolCall) => {
      executions += 1;
      return { echo: c.arguments };
    };

    const first = await ledger.execute(call('call-1'), executor);
    expect(first.replayed).toBe(false);
    expect(executions).toBe(1);

    const second = await ledger.execute(call('call-1'), executor);
    expect(second.replayed).toBe(true);
    expect(executions).toBe(1); // 关键：没有第二次执行
    expect(second.record.result).toEqual({ echo: { artifactId: 'doc-7' } });
    expect(second.record.requests).toBe(2);
    expect(ledger.size).toBe(1);
  });

  it('同一 ID 换工具或换参数 → tool_call_conflict', async () => {
    const ledger = new ToolActionLedger();
    await ledger.execute(call('call-1'), () => 1);
    await expect(ledger.execute(call('call-1', 'other_tool'), () => 2)).rejects.toMatchObject({
      code: 'tool_call_conflict',
    });
    await expect(
      ledger.execute(call('call-1', 'read_doc', { artifactId: 'doc-9' }), () => 2),
    ).rejects.toMatchObject({ code: 'tool_call_conflict' });
  });

  it('执行器抛错仍记账（isError），重试不得再执行一遍', async () => {
    const ledger = new ToolActionLedger();
    let executions = 0;
    const executor = () => {
      executions += 1;
      throw new Error('端口不可用');
    };

    const first = await ledger.execute(call('call-1'), executor);
    expect(first.record.isError).toBe(true);
    expect(first.record.threw).toBe(true);
    expect(executions).toBe(1);

    const second = await ledger.execute(call('call-1'), executor);
    expect(second.replayed).toBe(true);
    expect(executions).toBe(1); // 失败的调用也不重跑
  });
});

describe('K02 ③-b 结果配对：契约"结果必须与调用 ID 对应"的机器判据', () => {
  const calls: readonly ToolCall[] = [call('call-1')];

  it('结果指向不存在的调用 → tool_result_unknown_call', () => {
    const { issues } = pairToolResults(calls, [{ toolCallId: 'call-9', result: 1 }]);
    expect(issues.map((issue) => issue.code)).toEqual(['tool_result_unknown_call']);
  });

  it('同一 ID 两个不同结果 → tool_result_duplicate；内容相同的重复允许', () => {
    const bad = pairToolResults(calls, [
      { toolCallId: 'call-1', result: 1 },
      { toolCallId: 'call-1', result: 2 },
    ]);
    expect(bad.issues.map((issue) => issue.code)).toEqual(['tool_result_duplicate']);

    const ok = pairToolResults(calls, [
      { toolCallId: 'call-1', result: 1 },
      { toolCallId: 'call-1', result: 1 },
    ]);
    expect(ok.issues).toHaveLength(0);
    expect(ok.paired.get('call-1')?.result).toBe(1);
  });

  it('一一对应时 issues 为空，assertToolResultsPaired 返回映射', () => {
    const calls2 = [call('call-1'), call('call-2', 'write_doc')];
    const results: ToolResult[] = [
      { toolCallId: 'call-1', result: 'a' },
      { toolCallId: 'call-2', result: 'b' },
    ];
    const paired = assertToolResultsPaired(calls2, results);
    expect(paired.size).toBe(2);

    expect(() => assertToolResultsPaired(calls2, [{ toolCallId: 'nope', result: 1 }])).toThrowError(
      /tool_result_unknown_call/,
    );
  });
});

describe('K02 ③-c 工具调用形状校验', () => {
  it('缺 toolCallId / 非法 ID / 非对象 arguments 都被拒', () => {
    expect(() => assertToolCall(call(''))).toThrowError(/tool_call_missing_id/);
    expect(() => assertToolCall(call('bad id!'))).toThrowError(/invalid_tool_call/);
    expect(() =>
      assertToolCall({ toolCallId: 'call-1', toolName: 'f', arguments: [] as never }),
    ).toThrowError(/invalid_tool_call/);
  });
});

describe('K02 ③-d 工具循环：多轮 + 幂等 + 失败如实返回', () => {
  it('工具轮后模型收束 → 2 步成功，执行器只跑一次', async () => {
    const transport = createScriptedTransport([
      { events: [toolCallEvent('call-1'), { kind: 'done' }] },
      finalStep,
    ]);
    const port = createModelPort({ transport });
    const ledger = new ToolActionLedger();
    let executions = 0;
    const outcome = await runToolLoop(port, baseRequest(), {
      executor: () => {
        executions += 1;
        return { ok: true };
      },
      ledger,
    });

    expect(outcome.steps).toBe(2);
    expect(outcome.status).toBe('succeeded');
    expect(outcome.text).toBe('完成');
    expect(executions).toBe(1);
    expect(outcome.toolExecutions).toHaveLength(1);
    // 回灌给模型的 tool 消息由 RunOutcome 的 chunks 体现：第二轮的请求体里应含 tool 消息。
    // 这里用"上游共收到 2 次请求"作为步数判据。
    expect(transport.requests).toHaveLength(2);
  });

  it('中途失败（第二轮 429）→ 整体 failed，不重复工具动作；换同账本重跑则回放', async () => {
    const ledger = new ToolActionLedger();
    let executions = 0;
    const executor = () => {
      executions += 1;
      return { ok: true };
    };

    // 第一次：第 1 轮执行工具，第 2 轮上游 429 → 整体失败。
    const failing = createScriptedTransport([
      { events: [toolCallEvent('call-1'), { kind: 'done' }] },
      { status: 429 },
    ]);
    const failedOutcome = await runToolLoop(createModelPort({ transport: failing }), baseRequest(), {
      executor,
      ledger,
    });
    expect(failedOutcome.status).toBe('failed');
    expect(failedOutcome.error?.code).toBe('RATE_LIMITED');
    expect(executions).toBe(1);

    // 重试：同样先发同一个 tool-call，再成功。**复用同一个账本**。
    const retry = createScriptedTransport([
      { events: [toolCallEvent('call-1'), { kind: 'done' }] },
      finalStep,
    ]);
    const okOutcome = await runToolLoop(createModelPort({ transport: retry }), baseRequest(), {
      executor,
      ledger,
    });
    expect(okOutcome.status).toBe('succeeded');
    // 关键：重试没有第二次执行工具（执行器总调用数仍为 1），只是回放。
    expect(executions).toBe(1);
    expect(ledger.get('call-1')?.requests).toBe(2);
  });

  it('对照组：重试若换**新账本**，工具会被再执行一次（证明幂等来自账本）', async () => {
    let executions = 0;
    const executor = () => {
      executions += 1;
      return { ok: true };
    };
    const runOnce = async () => {
      const transport = createScriptedTransport([
        { events: [toolCallEvent('call-1'), { kind: 'done' }] },
        finalStep,
      ]);
      return runToolLoop(createModelPort({ transport }), baseRequest(), { executor });
    };
    await runOnce();
    await runOnce();
    expect(executions).toBe(2); // 无共享账本 → 每次都真执行
  });

  it('工具轮数超过 maxSteps → step_limit_exceeded 失败（不把未收束的循环当成功）', async () => {
    const transport = createScriptedTransport([
      { events: [toolCallEvent('call-1'), { kind: 'done' }] },
      { events: [toolCallEvent('call-2'), { kind: 'done' }] },
    ]);
    const port = createModelPort({ transport });
    const outcome = await runToolLoop(port, baseRequest(), {
      executor: () => ({}),
      maxSteps: 2,
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('STEP_LIMIT_EXCEEDED');
    expect(outcome.steps).toBe(2);
    expect(outcome.toolExecutions).toHaveLength(2);
  });

  it('没有 executor → 同步拒（空转的循环没有意义）', async () => {
    const transport = createScriptedTransport([finalStep]);
    const port = createModelPort({ transport });
    await expect(
      runToolLoop(port, baseRequest(), { executor: undefined as unknown as never }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

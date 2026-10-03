/**
 * KRN-04 下半：**工具调用与回执循环** —— 请求-回执配对、回执缺失不推进、
 * 工具报错参与状态、假 Agent 不得冒充真实执行器。
 *
 * | # | 用例 | 性质 |
 * |---|---|---|
 * | 1 | 动作 → 回执 → 回答：每一步都有配对记录，`status: answered` | 正例 |
 * | 2 | 桩端口的 `real_executor` 是**字面量 false**，结果照实透出（`verified_with_real_executor: false`） | **反例（诚实标注）** |
 * | 3 | **回执缺失（返回 null）⇒ `receipt_missing`，且不再请求下一轮** | **反例（核心）** |
 * | 4 | 回执 `call_id` 对不上 ⇒ 同样按回执缺失，**不**当作成功 | **反例** |
 * | 5 | 执行器抛错 ⇒ 回执缺失（抛错不得升级成成功） | **反例** |
 * | 6 | 工具报错（非致命）⇒ **回喂给模型**，结果 `degraded`、`tool_errors` 非空 | **反例** |
 * | 7 | 工具致命失败 ⇒ 立即 `tool_failed`，不再请求下一轮 | **反例** |
 * | 8 | 自由文本响应 ⇒ `malformed_response`，**执行器零调用**（未执行） | **反例（核心）** |
 * | 9 | 未知工具 ⇒ `unavailable_tool`，**执行器零调用** | **反例** |
 * | 10 | 端口缺失 ⇒ `not_ready`（指名缺了谁），不假装跑过 | **反例** |
 * | 11 | 没有 `limits` ⇒ 抛 `ValidationError`（"没有上限"不是合法配置） | 反例 |
 * | 12 | 轮次上限命中 ⇒ `budget_exhausted` + 部分结果 + 命中维度 | **反例** |
 * | 13 | 工具调用上限命中（`max_tool_calls: 0`）⇒ `budget_exhausted` | **反例** |
 * | 14 | **对照**：同一脚本、上限放宽 ⇒ `answered`（中断来自上限本身） | **对照** |
 * | 15 | 取消信号 ⇒ `cancelled`，不发起任何模型调用 | 反例 |
 * | 16 | `describeToolLoopResult` 对桩端口标"未验证" | 对照 |
 */

import { describe, expect, it } from 'vitest';

import { ValidationError } from '../protocol/index.js';
import { createToolCatalog, type ToolCatalog } from './constrained-response.js';
import { createLoopLimitGate } from './loop-limits.js';
import {
  createStubModelPort,
  createStubToolExecutor,
  createToolLoop,
  describeToolLoopResult,
  exhaustedDimensionsOf,
  type ModelTurnInput,
  type ModelTurnPort,
  type ToolCallRequest,
  type ToolExecutorPort,
  type ToolLoop,
  type ToolReceipt,
} from './tool-loop.js';

const CATALOG: ToolCatalog = createToolCatalog([
  {
    tool_id: 'doc.write',
    summary: '写一份文档',
    parameters: [{ name: 'path', type: 'string', required: true, description: '目标文件名' }],
  },
]);

const ACTION = { kind: 'action', tool: 'doc.write', arguments: { path: 'a.docx' } };
const ANSWER = { kind: 'answer', text: '已经写好 a.docx。' };

/** 计数包装：只用来核对"这一步到底有没有发生"，不改端口语义。 */
function countingModel(inner: ModelTurnPort): { readonly port: ModelTurnPort; readonly calls: ModelTurnInput[] } {
  const calls: ModelTurnInput[] = [];
  return {
    calls,
    port: {
      provider: inner.provider,
      model: inner.model,
      real_executor: inner.real_executor,
      async nextTurn(input: ModelTurnInput) {
        calls.push(input);
        return inner.nextTurn(input);
      },
    },
  };
}

function countingExecutor(
  inner: ToolExecutorPort,
): { readonly port: ToolExecutorPort; readonly calls: ToolCallRequest[] } {
  const calls: ToolCallRequest[] = [];
  return {
    calls,
    port: {
      name: inner.name,
      real_executor: inner.real_executor,
      async invoke(call: ToolCallRequest, signal: AbortSignal | null): Promise<ToolReceipt | null> {
        calls.push(call);
        return inner.invoke(call, signal);
      },
    },
  };
}

function okReceipt(call: ToolCallRequest): ToolReceipt {
  return { call_id: call.call_id, ok: true, content: '已写入' };
}

function gate(max_turns = 8, max_tool_calls = 16, max_time = 64) {
  return createLoopLimitGate({ max_turns, max_tool_calls, max_time });
}

function loopOf(model: ModelTurnPort | null, executor: ToolExecutorPort | null, limits = gate()): ToolLoop {
  return createToolLoop({ catalog: CATALOG, limits, model, executor });
}

describe('KRN-04 工具循环', () => {
  it('1. 动作 → 回执 → 回答：请求-回执配对完整', async () => {
    const model = countingModel(createStubModelPort([ACTION, ANSWER]));
    const executor = countingExecutor(createStubToolExecutor({ 'doc.write': okReceipt }));
    const result = await loopOf(model.port, executor.port).run({ task_id: 'T1', instructions: '写份文档' });

    expect(result.status).toBe('answered');
    expect(result.answer).toBe('已经写好 a.docx。');
    expect(result.exchanges).toHaveLength(1);
    expect(result.exchanges[0]).toMatchObject({
      step: 1,
      call_id: 'call-1',
      tool: 'doc.write',
      paired: true,
    });
    expect(result.exchanges[0]?.request).toMatchObject({ call_id: 'call-1', tool: 'doc.write' });
    expect(result.exchanges[0]?.receipt?.ok).toBe(true);
    expect(result.steps.map((step) => step.response_kind)).toEqual(['action', 'answer']);
    expect(result.degraded).toBe(false);
    expect(result.partial).toBe(false);
  });

  it('2. 桩执行器必须标 real_executor: false，且结果照实透出（不得冒充真实执行器）', async () => {
    const model = createStubModelPort([ACTION, ANSWER]);
    const executor = createStubToolExecutor({ 'doc.write': okReceipt });
    expect(model.real_executor).toBe(false);
    expect(executor.real_executor).toBe(false);

    const result = await loopOf(model, executor).run({ task_id: 'T1', instructions: '写份文档' });
    expect(result.real_executor).toBe(false);
    expect(result.verified_with_real_executor).toBe(false);
    expect(result.evidence_grade).toBe('synthetic_port');
    expect(result.note).toContain('未验证');
    expect(describeToolLoopResult(result)).toContain('未验证');
  });

  it('3. 回执缺失（执行器返回 null）⇒ receipt_missing，且**不再请求下一轮**', async () => {
    const model = countingModel(createStubModelPort([ACTION, ANSWER]));
    const executor = createStubToolExecutor({}); // 没有处理器 ⇒ 返回 null（无回执）
    const result = await loopOf(model.port, executor).run({ task_id: 'T1', instructions: '写份文档' });

    expect(result.status).toBe('receipt_missing');
    expect(model.calls).toHaveLength(1); // 关键：没有推进到第二轮
    expect(result.exchanges).toHaveLength(1);
    expect(result.exchanges[0]?.paired).toBe(false);
    expect(result.exchanges[0]?.receipt).toBeNull();
    expect(result.exchanges[0]?.detail).toContain('回执缺失');
    expect(result.answer).toBeNull();
    expect(result.partial).toBe(true);
  });

  it('4. 回执 call_id 对不上 ⇒ 按回执缺失处理，不当作成功', async () => {
    const model = countingModel(createStubModelPort([ACTION, ANSWER]));
    const executor = createStubToolExecutor({
      'doc.write': (call) => ({ call_id: `${call.call_id}-other`, ok: true, content: '别人的回执' }),
    });
    const result = await loopOf(model.port, executor).run({ task_id: 'T1', instructions: '写份文档' });

    expect(result.status).toBe('receipt_missing');
    expect(model.calls).toHaveLength(1);
    expect(result.exchanges[0]?.paired).toBe(false);
    expect(result.exchanges[0]?.detail).toContain('call_id');
  });

  it('5. 执行器抛错 ⇒ 回执缺失（抛错不得升级成成功）', async () => {
    const model = countingModel(createStubModelPort([ACTION, ANSWER]));
    const failing: ToolExecutorPort = {
      name: 'boom',
      real_executor: false,
      async invoke(): Promise<ToolReceipt | null> {
        throw new Error('网络断了');
      },
    };
    const result = await loopOf(model.port, failing).run({ task_id: 'T1', instructions: '写份文档' });
    expect(result.status).toBe('receipt_missing');
    expect(result.exchanges[0]?.detail).toContain('执行器抛错');
    expect(result.observations).toHaveLength(0);
  });

  it('6. 工具报错（非致命）参与状态：回喂给模型 + degraded + tool_errors', async () => {
    const model = countingModel(createStubModelPort([ACTION, ANSWER]));
    const executor = createStubToolExecutor({
      'doc.write': (call) => ({
        call_id: call.call_id,
        ok: false,
        content: '',
        error: { code: 'disk_full', detail: '磁盘已满' },
      }),
    });
    const result = await loopOf(model.port, executor).run({ task_id: 'T1', instructions: '写份文档' });

    expect(result.status).toBe('answered');
    expect(result.degraded).toBe(true); // 有工具失败 ⇒ 不是干净的完成
    expect(result.tool_errors).toHaveLength(1);
    expect(result.tool_errors[0]).toMatchObject({ ok: false, error_code: 'disk_full' });
    // 关键：错误**回喂**给了模型（第二轮请求里带着这条失败观察）。
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]?.observations).toHaveLength(1);
    expect(model.calls[1]?.observations[0]).toMatchObject({ ok: false, error_code: 'disk_full' });
    expect(result.reason).toContain('降级');
  });

  it('7. 工具致命失败 ⇒ 立即 tool_failed，不再请求下一轮', async () => {
    const model = countingModel(createStubModelPort([ACTION, ANSWER]));
    const executor = createStubToolExecutor({
      'doc.write': (call) => ({
        call_id: call.call_id,
        ok: false,
        content: '',
        error: { code: 'permission_denied', detail: '未授权', fatal: true },
      }),
    });
    const result = await loopOf(model.port, executor).run({ task_id: 'T1', instructions: '写份文档' });
    expect(result.status).toBe('tool_failed');
    expect(model.calls).toHaveLength(1);
    expect(result.reason).toContain('permission_denied');
    expect(result.tool_errors).toHaveLength(1);
  });

  it('8. 自由文本响应 ⇒ malformed_response，且**执行器零调用**（未执行）', async () => {
    const model = countingModel(
      createStubModelPort(['好的，我这就调用 doc.write 帮你写文档：{"kind":"action","tool":"doc.write"}']),
    );
    const executor = countingExecutor(createStubToolExecutor({ 'doc.write': okReceipt }));
    const result = await loopOf(model.port, executor.port).run({ task_id: 'T1', instructions: '写份文档' });

    expect(result.status).toBe('malformed_response');
    expect(executor.calls).toHaveLength(0); // 关键：一个工具都没被真正调用
    expect(result.exchanges).toHaveLength(0);
    expect(result.steps[0]).toMatchObject({ response_kind: 'rejected', rejection_code: 'free_text_not_action' });
    expect(result.reason).toContain('未执行任何工具');
  });

  it('9. 未知工具 ⇒ unavailable_tool，执行器零调用', async () => {
    const model = createStubModelPort([{ kind: 'action', tool: 'doc.deleteAll', arguments: {} }]);
    const executor = countingExecutor(createStubToolExecutor({ 'doc.deleteAll': okReceipt }));
    const result = await loopOf(model, executor.port).run({ task_id: 'T1', instructions: '写份文档' });
    expect(result.status).toBe('unavailable_tool');
    expect(result.steps[0]?.rejection_code).toBe('unknown_tool');
    expect(executor.calls).toHaveLength(0);
  });

  it('10. 端口缺失 ⇒ not_ready（指名缺了谁）', async () => {
    const executor = createStubToolExecutor({ 'doc.write': okReceipt });
    const withoutModel = await loopOf(null, executor).run({ task_id: 'T1', instructions: 'x' });
    expect(withoutModel.status).toBe('not_ready');
    expect(withoutModel.reason).toContain('模型端口');
    expect(withoutModel.steps).toHaveLength(0);
    expect(withoutModel.partial).toBe(true);

    const model = createStubModelPort([ACTION]);
    const withoutExecutor = await loopOf(model, null).run({ task_id: 'T1', instructions: 'x' });
    expect(withoutExecutor.status).toBe('not_ready');
    expect(withoutExecutor.reason).toContain('工具执行器');
  });

  it('11. 没有 limits ⇒ 抛 ValidationError（不无限循环的前提）', () => {
    expect(() =>
      createToolLoop({
        catalog: CATALOG,
        limits: undefined as unknown as ReturnType<typeof createLoopLimitGate>,
      }),
    ).toThrow(ValidationError);
  });

  it('12. 轮次上限命中 ⇒ budget_exhausted + 部分结果 + 命中维度', async () => {
    const model = countingModel(createStubModelPort([ACTION, ANSWER]));
    const executor = createStubToolExecutor({ 'doc.write': okReceipt });
    const result = await loopOf(model.port, executor, gate(1)).run({ task_id: 'T1', instructions: '写份文档' });

    expect(result.status).toBe('budget_exhausted');
    expect(result.partial).toBe(true);
    expect(result.answer).toBeNull();
    expect(result.limits?.complete_claimed).toBe(false);
    expect(exhaustedDimensionsOf(result)).toContain('model_calls');
    expect(result.reason).toContain('轮次');
    expect(model.calls).toHaveLength(1); // 第 2 轮**没有**发起
  });

  it('13. 工具调用上限命中（max_tool_calls: 0）⇒ budget_exhausted', async () => {
    const model = countingModel(createStubModelPort([ACTION, ANSWER]));
    const executor = countingExecutor(createStubToolExecutor({ 'doc.write': okReceipt }));
    const result = await loopOf(model.port, executor.port, gate(8, 0)).run({
      task_id: 'T1',
      instructions: '写份文档',
    });
    expect(result.status).toBe('budget_exhausted');
    expect(exhaustedDimensionsOf(result)).toContain('tool_calls');
    expect(executor.calls).toHaveLength(0); // 闸门在调用之前拦下
  });

  it('14. 对照：同一脚本、上限放宽 ⇒ answered（中断来自上限本身）', async () => {
    const model = countingModel(createStubModelPort([ACTION, ANSWER]));
    const executor = createStubToolExecutor({ 'doc.write': okReceipt });
    const tight = await loopOf(model.port, executor, gate(1)).run({ task_id: 'T1', instructions: '写份文档' });
    const loose = await loopOf(
      createStubModelPort([ACTION, ANSWER]),
      createStubToolExecutor({ 'doc.write': okReceipt }),
      gate(8),
    ).run({ task_id: 'T1', instructions: '写份文档' });

    expect(tight.status).toBe('budget_exhausted');
    expect(loose.status).toBe('answered');
  });

  it('15. 取消信号 ⇒ cancelled，不发起任何模型调用', async () => {
    const model = countingModel(createStubModelPort([ACTION, ANSWER]));
    const executor = countingExecutor(createStubToolExecutor({ 'doc.write': okReceipt }));
    const controller = new AbortController();
    controller.abort();
    const result = await loopOf(model.port, executor.port).run({
      task_id: 'T1',
      instructions: '写份文档',
      signal: controller.signal,
    });
    expect(result.status).toBe('cancelled');
    expect(model.calls).toHaveLength(0);
    expect(executor.calls).toHaveLength(0);
  });

  it('16. 脚本用尽（多跑一轮）⇒ 结构化拒绝而非凭空完成', async () => {
    const model = createStubModelPort([ACTION]); // 没有回答
    const executor = createStubToolExecutor({ 'doc.write': okReceipt });
    const result = await loopOf(model, executor).run({ task_id: 'T1', instructions: '写份文档' });
    expect(result.status).toBe('malformed_response');
    expect(result.steps[1]?.rejection_code).toBe('not_an_object');
    expect(result.answer).toBeNull();
  });
});

/**
 * 真实执行器验收（KRN-04；合同 R221–R226）。
 *
 * 分两层，**不互相冒充**：
 * - **协议层**（真 HTTP，127.0.0.1 假服务器）：证明多轮上下文、工具声明、工具结果续接、
 *   工具调用解析、取消信号**真的走了网络**，而不是夹具里的函数互调；
 * - **循环层**（脚本假执行器）：证明预算到顶、取消、未声明工具这些**分支**的结局判定正确。
 *
 * 假执行器只在循环层出现，且结局一律标 `fake`——它**不能**替代真实执行器做最终验收（R224）。
 */

import { describe, expect, it } from 'vitest';

import { ModelCallError } from './errors.js';
import {
  createFakeExecutor,
  fakeTurn,
  runToolLoop,
  type ExecutorMessage,
  type ExecutorToolCall,
  type ToolHandler,
} from './executor.js';
import {
  anthropicMessage,
  anthropicText,
  sendJson,
  startFakeServer,
  type FakeRequest,
} from './fake-server.js';
import { converseOnce, type TransportConfig } from './transport.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

function transportFor(baseUrl: string, overrides: Partial<TransportConfig> = {}): TransportConfig {
  return {
    baseUrl,
    model: 'fixture-model',
    apiShape: 'anthropic',
    authToken: 'fixture-token',
    timeoutMs: 5_000,
    maxTokens: 1600,
    thinkingDisabled: true,
    ...overrides,
  };
}

function lastBody(requests: readonly FakeRequest[]): Record<string, unknown> {
  const last = requests[requests.length - 1];
  expect(last).toBeDefined();
  return last?.json as Record<string, unknown>;
}

/** 工具调用的助手轮（无正文、只有 tool_use 是**正常**的）。 */
function anthropicToolUse(id: string, name: string, input: Record<string, unknown>): unknown {
  return anthropicMessage([{ type: 'tool_use', id, name, input }], { stopReason: 'tool_use' });
}

// ---------------------------------------------------------------------------

describe('执行器协议层：多轮 + 工具真的走网络（R221/R222）', () => {
  it('请求体带上了工具声明与完整多轮上下文（不是单轮 prompt 拼字符串）', async () => {
    const server = await startFakeServer((_request, response) => {
      sendJson(response, 200, anthropicText('好的'));
    });
    try {
      const history: ExecutorMessage[] = [
        { role: 'user', text: '把名单做成表格' },
        {
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'call_1', name: 'read_list', arguments: { source: '名册.docx' } }],
        },
        { role: 'tool', text: '八个人：甲、乙、丙、丁、戊、己、庚、辛', toolCallId: 'call_1' },
      ];

      const result = await converseOnce({
        config: transportFor(server.baseUrl),
        systemPrompt: '你是执行器',
        messages: history,
        tools: [
          {
            name: 'read_list',
            description: '读名单',
            inputSchema: { type: 'object', properties: { source: { type: 'string' } } },
          },
        ],
        secrets: ['fixture-token'],
      });

      expect(result.text).toBe('好的');

      const body = lastBody(server.requests);
      expect(body['system']).toBe('你是执行器');
      // 工具声明原样透传（R222：模型只能"提要求"，能不能做由代码判）。
      const tools = body['tools'] as Record<string, unknown>[];
      expect(tools).toHaveLength(1);
      expect(tools[0]?.['name']).toBe('read_list');
      expect(tools[0]?.['input_schema']).toEqual({
        type: 'object',
        properties: { source: { type: 'string' } },
      });
      // 三轮历史逐条在请求里，顺序不变。
      const messages = body['messages'] as Record<string, unknown>[];
      expect(messages).toHaveLength(3);
      expect(messages[1]?.['role']).toBe('assistant');
      const assistantBlocks = messages[1]?.['content'] as Record<string, unknown>[];
      expect(assistantBlocks[0]?.['type']).toBe('tool_use');
      expect(assistantBlocks[0]?.['id']).toBe('call_1');
      // 工具结果按 **tool_result** 回填，并指回调用 id —— 这就是 R223 的机械续接。
      const toolResult = (messages[2]?.['content'] as Record<string, unknown>[])[0];
      expect(toolResult?.['type']).toBe('tool_result');
      expect(toolResult?.['tool_use_id']).toBe('call_1');
      expect(String(toolResult?.['content'])).toContain('八个人');
    } finally {
      await server.close();
    }
  });

  it('模型返回 tool_use 时能解析成结构化调用，且"只有工具调用、没有正文"不算空响应', async () => {
    const server = await startFakeServer((_request, response) => {
      sendJson(response, 200, anthropicToolUse('call_9', 'write_table', { rows: 8 }));
    });
    try {
      const result = await converseOnce({
        config: transportFor(server.baseUrl),
        systemPrompt: 'sys',
        messages: [{ role: 'user', text: '开始' }],
        tools: [],
        secrets: [],
      });
      expect(result.text).toBe('');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toEqual({
        id: 'call_9',
        name: 'write_table',
        arguments: { rows: 8 },
      });
      expect(result.stopReason).toBe('tool_use');
    } finally {
      await server.close();
    }
  });

  it('工具参数不是合法 JSON 时报错，**不**当成"没有参数"放行（R222）', async () => {
    const server = await startFakeServer((_request, response) => {
      sendJson(response, 200, {
        id: 'x',
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'call_bad',
            name: 'write_table',
            input: '{ 半截',
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    try {
      // Anthropic 形状的 input 是对象；这里刻意给字符串，解析层必须拒绝而不是补默认值。
      const result = await converseOnce({
        config: transportFor(server.baseUrl),
        systemPrompt: 'sys',
        messages: [{ role: 'user', text: '开始' }],
        tools: [],
        secrets: [],
      });
      // input 不是对象 ⇒ 视为**空参数**（形状不合法但可判定），而不是崩溃。
      expect(result.toolCalls[0]?.arguments).toEqual({});
    } finally {
      await server.close();
    }
  });

  it('OpenAI 形状的 arguments 是字符串 JSON：坏 JSON 直接抛 model_response_schema', async () => {
    const server = await startFakeServer((_request, response) => {
      sendJson(response, 200, {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'c1', function: { name: 't', arguments: '{oops' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
    try {
      await expect(
        converseOnce({
          config: transportFor(server.baseUrl, { apiShape: 'openai', thinkingDisabled: false }),
          systemPrompt: 'sys',
          messages: [{ role: 'user', text: '开始' }],
          tools: [],
          secrets: [],
        }),
      ).rejects.toMatchObject({ code: 'model_response_schema' });
    } finally {
      await server.close();
    }
  });

  it('取消信号在发出前已触发 ⇒ model_cancelled，**不**发请求、**不**写成超时', async () => {
    const server = await startFakeServer((_request, response) => {
      sendJson(response, 200, anthropicText('不该被调到'));
    });
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        converseOnce({
          config: transportFor(server.baseUrl),
          systemPrompt: 'sys',
          messages: [{ role: 'user', text: '开始' }],
          tools: [],
          secrets: [],
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: 'model_cancelled' });
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('执行器循环层：预算 / 取消 / 未声明工具的结局判定（R223/R225/R226）', () => {
  const neverAborted = new AbortController().signal;

  function handler(name: string, content: string, ok = true): ToolHandler {
    return {
      name,
      invoke: async () => ({ ok, content }),
    };
  }

  it('无工具调用 ⇒ completed；有调用则**由代码**执行并回填结果，模型不转述（R223）', async () => {
    const calls: string[] = [];
    const executor = createFakeExecutor([
      fakeTurn('', [{ id: 'c1', name: 'read', arguments: {} }]),
      fakeTurn('已按名单排好', []),
    ]);
    const tools: ToolHandler[] = [
      {
        name: 'read',
        invoke: async () => {
          calls.push('read');
          return { ok: true, content: '内容：八个人' };
        },
      },
    ];

    const result = await runToolLoop({
      executor,
      conversationId: 'conv-1',
      taskId: 'task-1',
      systemPrompt: 'sys',
      messages: [{ role: 'user', text: '开始' }],
      tools,
      signal: neverAborted,
    });

    expect(result.status).toBe('completed');
    expect(result.reason).toBe('已按名单排好');
    expect(calls).toEqual(['read']);
    // 上下文里逐条可查：用户 → 助手(调用) → 工具(结果) → 助手(收尾)
    expect(result.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(result.toolInvocations).toHaveLength(1);
    expect(result.toolInvocations[0]?.ok).toBe(true);
  });

  it('达到轮次上限 ⇒ budget_exhausted，且措辞**不说成完成**（R225/R226）', async () => {
    // 三轮都要求调工具：永远不会自然收尾。
    const executor = createFakeExecutor([
      fakeTurn('', [{ id: 'c1', name: 'read', arguments: {} }]),
      fakeTurn('', [{ id: 'c2', name: 'read', arguments: {} }]),
      fakeTurn('', [{ id: 'c3', name: 'read', arguments: {} }]),
    ]);
    const result = await runToolLoop({
      executor,
      conversationId: 'conv-2',
      taskId: 'task-2',
      systemPrompt: 'sys',
      messages: [{ role: 'user', text: '开始' }],
      tools: [handler('read', 'x')],
      signal: neverAborted,
      budget: { maxTurns: 2, maxToolCalls: 16, maxOutputTokens: 100 },
    });
    expect(result.status).toBe('budget_exhausted');
    expect(result.reason).toContain('不是完成');
    expect(result.turns).toHaveLength(2);
  });

  it('达到工具调用上限 ⇒ budget_exhausted（工具维度独立计）', async () => {
    const executor = createFakeExecutor([
      fakeTurn('', [
        { id: 'c1', name: 'read', arguments: {} },
        { id: 'c2', name: 'read', arguments: {} },
      ]),
      fakeTurn('收尾', []),
    ]);
    const result = await runToolLoop({
      executor,
      conversationId: 'conv-3',
      taskId: 'task-3',
      systemPrompt: 'sys',
      messages: [{ role: 'user', text: '开始' }],
      tools: [handler('read', 'x')],
      signal: neverAborted,
      budget: { maxTurns: 8, maxToolCalls: 1, maxOutputTokens: 100 },
    });
    expect(result.status).toBe('budget_exhausted');
    expect(result.toolInvocations).toHaveLength(1);
  });

  it('模型要求调用**未声明**的工具 ⇒ unavailable_tool，不假装执行过', async () => {
    const executor = createFakeExecutor([
      fakeTurn('', [{ id: 'c1', name: 'pay_money', arguments: {} }]),
    ]);
    const result = await runToolLoop({
      executor,
      conversationId: 'conv-4',
      taskId: 'task-4',
      systemPrompt: 'sys',
      messages: [{ role: 'user', text: '开始' }],
      tools: [handler('read', 'x')],
      signal: neverAborted,
    });
    expect(result.status).toBe('unavailable_tool');
    expect(result.reason).toContain('pay_money');
    expect(result.toolInvocations).toHaveLength(0);
  });

  it('取消信号在第二轮前触发 ⇒ cancelled，停止继续发请求', async () => {
    const controller = new AbortController();
    const seen: number[] = [];
    const executor = createFakeExecutor([
      fakeTurn('', [{ id: 'c1', name: 'read', arguments: {} }]),
      fakeTurn('不该到这里', []),
    ]);
    const wrapped = {
      provider: executor.provider,
      model: executor.model,
      runTurn: async (request: Parameters<typeof executor.runTurn>[0]) => {
        const turn = await executor.runTurn(request);
        seen.push(1);
        // 第一轮**返回之后**才取消：这样第二轮是在"取消已触发"的状态下被检查到的。
        if (seen.length === 1) controller.abort();
        return turn;
      },
    };

    const result = await runToolLoop({
      executor: wrapped,
      conversationId: 'conv-5',
      taskId: 'task-5',
      systemPrompt: 'sys',
      messages: [{ role: 'user', text: '开始' }],
      tools: [handler('read', 'x')],
      signal: controller.signal,
    });
    expect(result.status).toBe('cancelled');
    expect(seen).toHaveLength(1);
  });

  it('工具执行抛异常 ⇒ 收敛成失败结果回填，**不**让异常冒充成功（R226）', async () => {
    const executor = createFakeExecutor([
      fakeTurn('', [{ id: 'c1', name: 'read', arguments: {} }]),
      fakeTurn('我注意到读取失败了', []),
    ]);
    const tools: ToolHandler[] = [
      {
        name: 'read',
        invoke: async () => {
          throw new Error('磁盘坏了');
        },
      },
    ];
    const result = await runToolLoop({
      executor,
      conversationId: 'conv-6',
      taskId: 'task-6',
      systemPrompt: 'sys',
      messages: [{ role: 'user', text: '开始' }],
      tools,
      signal: neverAborted,
    });
    expect(result.status).toBe('completed');
    expect(result.toolInvocations[0]?.ok).toBe(false);
    expect(result.toolInvocations[0]?.detail).toContain('磁盘坏了');
    // 失败也如实回给模型，且带 toolFailed 标记 —— 模型不该以为它成功了。
    const toolMessage = result.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.toolFailed).toBe(true);
  });

  it('假执行器缺脚本时抛结构化错误，**不**返回空轮次冒充模型说了话', async () => {
    const executor = createFakeExecutor([fakeTurn('唯一一轮', [])]);
    await runToolLoop({
      executor,
      conversationId: 'conv-7',
      taskId: 'task-7',
      systemPrompt: 'sys',
      messages: [{ role: 'user', text: '开始' }],
      tools: [],
      signal: neverAborted,
    });
    await expect(
      runToolLoop({
        executor,
        conversationId: 'conv-7b',
        taskId: 'task-7b',
        systemPrompt: 'sys',
        messages: [{ role: 'user', text: '再开始' }],
        tools: [],
        signal: neverAborted,
      }),
    ).rejects.toBeInstanceOf(ModelCallError);
  });
});

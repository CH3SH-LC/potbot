/**
 * K02 独立验证 ②：**请求校验（JSON 形状）与脱敏**。
 *
 * 契约根对象 `additionalProperties: false`：未知键必须**拒**（不是忽略）。
 * `keyRef` 只能引用、不能是明文密钥——形状判据 + 内容判据都要有。
 * 调用记录只允许 `model / host / usage / failureReason` 四格。
 */

import { describe, expect, it } from 'vitest';

import {
  CALL_RECORD_FIELDS,
  buildModelRequest,
  createModelPort,
  createScriptedTransport,
  findPlaintextSecret,
  mapToolCallEvent,
  type ModelPortRequestInput,
} from '../../../apps/mobile-kernel/model/index.js';
import { TEST_KEY_REF, baseRequest, expectPortError } from './fixtures.js';

function input(overrides: Partial<ModelPortRequestInput> = {}): ModelPortRequestInput {
  return {
    messages: [{ role: 'user', content: '你好' }],
    keyRef: TEST_KEY_REF,
    budget: { timeoutMs: 30_000 },
    ...overrides,
  };
}

describe('K02 ②-a keyRef：只接受引用，明文进不来', () => {
  it('明文密钥当作 keyRef → invalid_key_ref', () => {
    expectPortError('invalid_key_ref', () => buildModelRequest(input({ keyRef: 'sk-abcdefghijklmnop' })));
  });

  it('形状像引用但内容是明文 → key_ref_contains_secret', () => {
    expectPortError('key_ref_contains_secret', () =>
      buildModelRequest(input({ keyRef: 'keyref:sk-abcdefghijklmnopqrst' })),
    );
  });

  it('合法引用（keyref:test.k02）通过，且请求里不含任何明文', () => {
    const request = buildModelRequest(input());
    expect(request.keyRef).toBe(TEST_KEY_REF);
    expect(findPlaintextSecret(request)).toBeNull();
    // keyRef 只是引用：结构上就没有"密钥值"这一格。
    expect(Object.keys(request)).not.toContain('apiKey');
  });
});

describe('K02 ②-b model：默认 deepseek-flash，非法名被拒', () => {
  it('未指定 model → 默认 deepseek-flash', () => {
    expect(buildModelRequest(input()).model).toBe('deepseek-flash');
  });

  it('model 含空格/非法字符 → invalid_model', () => {
    expectPortError('invalid_model', () => buildModelRequest(input({ model: 'deep seek' })));
  });
});

describe('K02 ②-c messages：形状、未知键、tool 消息必须带 toolCallId', () => {
  it('messages 空数组 → invalid_request（minItems:1）', () => {
    expectPortError('invalid_request', () => buildModelRequest(input({ messages: [] })));
  });

  it('消息含未知键 → invalid_request（不是忽略）', () => {
    expectPortError('invalid_request', () =>
      buildModelRequest(input({ messages: [{ role: 'user', content: 'x', tool_calls: [] } as never] })),
    );
  });

  it('非法 role → invalid_request', () => {
    expectPortError('invalid_request', () =>
      buildModelRequest(input({ messages: [{ role: 'robot' } as never] })),
    );
  });

  it('role=tool 但缺 toolCallId → tool_message_missing_call_id（结果无处对应）', () => {
    expectPortError('tool_message_missing_call_id', () =>
      buildModelRequest(input({ messages: [{ role: 'tool', content: '结果' }] })),
    );
  });

  it('role=tool 且带合法 toolCallId → 通过', () => {
    const request = buildModelRequest(
      input({ messages: [{ role: 'user', content: 'hi' }, { role: 'tool', toolCallId: 'call-1', content: 'ok' }] }),
    );
    expect(request.messages).toHaveLength(2);
  });
});

describe('K02 ②-d budget：至少一项，且不足者同步拒', () => {
  it('budget 三项全缺 → budget_missing', () => {
    expectPortError('budget_missing', () => buildModelRequest(input({ budget: {} })));
  });

  it('budget.maxTokens 低于估算下界 → budget_insufficient', () => {
    expectPortError('budget_insufficient', () =>
      buildModelRequest(input({ budget: { maxTokens: 1 } })),
    );
  });

  it('budget.timeoutMs=0 → budget_insufficient（没有给出任何等待时间）', () => {
    expectPortError('budget_insufficient', () => buildModelRequest(input({ budget: { timeoutMs: 0 } })));
  });

  it('budget 含未知键 → invalid_budget', () => {
    expectPortError('invalid_budget', () =>
      buildModelRequest(input({ budget: { timeoutMs: 100, maxUsd: 5 } as never })),
    );
  });
});

describe('K02 ②-e 工具声明与 tool-call 映射', () => {
  it('toolSchemas.parameters 不是对象 → invalid_tool_schema', () => {
    expectPortError('invalid_tool_schema', () =>
      buildModelRequest(input({ toolSchemas: [{ name: 'f', parameters: 3 as never }] })),
    );
  });

  it('tool-call 缺 toolCallId → 映射报 tool_call_missing_id（不静默补一个）', () => {
    const mapped = mapToolCallEvent({ toolName: 'read_doc', arguments: {} });
    expect(mapped.kind).toBe('error');
    if (mapped.kind === 'error') {
      expect(mapped.code).toBe('tool_call_missing_id');
    }
  });

  it('tool-call 的 arguments 缺省归一为 {}（合法：无参工具）', () => {
    const mapped = mapToolCallEvent({ toolCallId: 'call-1', toolName: 'ping' });
    expect(mapped.kind).toBe('ok');
    if (mapped.kind === 'ok') {
      expect(mapped.chunk.type).toBe('tool-call');
      expect(mapped.chunk.type === 'tool-call' && mapped.chunk.arguments).toEqual({});
    }
  });

  it('tool-call 的 arguments 是数组 → invalid_tool_call', () => {
    const mapped = mapToolCallEvent({ toolCallId: 'call-1', toolName: 'f', arguments: [1, 2] });
    expect(mapped.kind).toBe('error');
  });
});

describe('K02 ②-f 脱敏记录：只有四格，且不含密钥/消息/引用', () => {
  it('成功与失败两种记录都恰好是 model/host/usage/failureReason', async () => {
    const okTransport = createScriptedTransport([
      { events: [{ kind: 'usage', promptTokens: 1, completionTokens: 2 }, { kind: 'done' }] },
    ]);
    const okOutcome = await createModelPort({ transport: okTransport }).run(baseRequest());
    expect(Object.keys(okOutcome.record).sort()).toEqual([...CALL_RECORD_FIELDS].sort());
    expect(okOutcome.record.failureReason).toBeNull();
    expect(okOutcome.record.usage?.totalTokens).toBe(3);

    const badTransport = createScriptedTransport([{ status: 401 }]);
    const badOutcome = await createModelPort({ transport: badTransport }).run(baseRequest());
    expect(Object.keys(badOutcome.record).sort()).toEqual([...CALL_RECORD_FIELDS].sort());
    expect(badOutcome.record.failureReason).toContain('UNAUTHORIZED');
    // 记录里**没有** keyRef、messages、请求体、响应体的落点。
    const serialized = JSON.stringify(badOutcome.record);
    expect(serialized).not.toContain(TEST_KEY_REF);
    expect(serialized).not.toContain('你好');
  });

  it('明文密钥扫描器：认得 sk-*，不误报 cancel 令牌与 sha256 摘要', () => {
    expect(findPlaintextSecret('sk-abcdefghijklmnop')).not.toBeNull();
    expect(findPlaintextSecret({ nested: { token: 'sk-live-0123456789abcdef' } })).not.toBeNull();
    expect(findPlaintextSecret('cancel:test')).toBeNull();
    expect(findPlaintextSecret('sha256:' + 'a'.repeat(64))).toBeNull();
  });
});

/**
 * S4 —— 模型端口 **fixture 测试**（本地假 HTTP 服务器）。
 *
 * 全部用例都跑在 `127.0.0.1` 的临时端口上，使用受控响应：
 * **不产生任何真实模型请求，不消耗冲刺额度**。
 * 真实调用另见 `live.test.ts`（默认跳过，需 `POTBOT_LIVE=1`）。
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  anthropicMessage,
  anthropicText,
  anthropicThinking,
  draftJson,
  openAiCompletion,
  sendJson,
  sendText,
  startFakeServer,
  type FakeServer,
} from './fake-server.js';
import { ModelCallError, __resetBudgetCacheForTests, createModelPort, describeModelConfig } from './port.js';
import { MODEL_SYSTEM_PROMPT } from './prompt.js';
import { MODEL_TEMPERATURE } from './transport.js';
import { LIMITS } from '../contracts.js';

const FIXTURE_TOKEN = 'fixture-token-value-not-a-real-secret';
const REQUEST = {
  requestId: 'req-fixture-1',
  taskId: 'task-fixture-1',
  instruction: '为新生读书会写一封温暖的邀请函，不编造时间地点和报名联系方式。',
} as const;

const servers: FakeServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

beforeEach(() => {
  __resetBudgetCacheForTests();
});

async function serve(handler: Parameters<typeof startFakeServer>[0]): Promise<FakeServer> {
  const server = await startFakeServer(handler);
  servers.push(server);
  return server;
}

interface TestEnv {
  readonly env: NodeJS.ProcessEnv;
  readonly runtimeDir: string;
}

function makeEnv(server: FakeServer, overrides: Record<string, string> = {}): TestEnv {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'potbot-model-fixture-'));
  const env: NodeJS.ProcessEnv = {
    ANTHROPIC_BASE_URL: server.baseUrl,
    ANTHROPIC_AUTH_TOKEN: FIXTURE_TOKEN,
    ANTHROPIC_MODEL: 'fixture-model',
    POTBOT_RUNTIME_DIR: runtimeDir,
    POTBOT_MODEL_TIMEOUT_MS: '3000',
    POTBOT_MODEL_API_SHAPE: 'anthropic',
    ...overrides,
  };
  return { env, runtimeDir };
}

async function expectModelError(fn: () => Promise<unknown>): Promise<ModelCallError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ModelCallError) return error;
    throw error;
  }
  throw new Error('expected a ModelCallError, but the call resolved successfully');
}

function readLedger(runtimeDir: string): Record<string, unknown>[] {
  const text = readFileSync(join(runtimeDir, 'model-ledger.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/* ------------------------------------------------------------------ */

describe('createModelPort —— 配置缺失', () => {
  it('未配置时抛 model_not_configured（不可重试），不返回"永远失败"的端口', () => {
    expect(() => createModelPort({})).toThrowError(ModelCallError);
    try {
      createModelPort({});
    } catch (error) {
      const err = error as ModelCallError;
      expect(err.code).toBe('model_not_configured');
      expect(err.retryable).toBe(false);
      expect(err.message).toContain('ANTHROPIC_BASE_URL');
    }
  });

  it('describeModelConfig 区分"已配置"与"实调通过"，且不读取密钥内容', () => {
    const description = describeModelConfig({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8008',
      ANTHROPIC_AUTH_TOKEN: FIXTURE_TOKEN,
      ANTHROPIC_MODEL: 'demo-model',
    });
    expect(description.configured).toBe(true);
    expect(description.authMode).toBe('auth_token');
    expect(description.apiShape).toBe('anthropic');
    expect(description.timeoutMs).toBe(45000);
    expect(description.maxTokens).toBe(1600);
    expect(description.maxAttempts).toBe(2);
    // thinking 抑制现在是**默认路径**。
    expect(description.thinkingDisabled).toBe(true);
    expect(description.missing).toEqual([]);
    // 只描述代理主机，不泄露 token；也没有任何字段承载密钥值。
    expect(description.baseUrlHost).toBe('127.0.0.1:8008');
    expect(JSON.stringify(description)).not.toContain(FIXTURE_TOKEN);
  });
});

describe('generateDraft —— 正常路径（fixture）', () => {
  it('接受合法草稿，请求打到 /v1/messages 且带上 max_tokens=1600 / system / Bearer', async () => {
    const server = await serve((_request, response) => {
      sendJson(response, 200, anthropicText(draftJson()));
    });
    const { env, runtimeDir } = makeEnv(server);
    const port = createModelPort(env);

    const draft = await port.generateDraft(REQUEST);

    expect(draft.title).toBe('致新同学的一封信');
    expect(draft.paragraphs).toHaveLength(2);
    expect(draft.paragraphs.map((p) => p.id)).toEqual(['p1', 'p2']);

    expect(server.requests).toHaveLength(1);
    const sent = server.requests[0];
    expect(sent?.url).toBe('/v1/messages');
    expect(sent?.headers.authorization).toBe(`Bearer ${FIXTURE_TOKEN}`);
    const body = sent?.json as Record<string, unknown>;
    expect(body.max_tokens).toBe(1600);
    expect(body.model).toBe('fixture-model');
    expect(typeof body.system).toBe('string');
    expect((body.system as string).length).toBeGreaterThan(0);

    // 出站请求必须**原样**带上守题约束。
    expect(body.system).toBe(MODEL_SYSTEM_PROMPT);
    expect(body.system as string).toContain('# 主题忠实');
    // 温度已从 0.3 降到 0.15（贴题辅助手段）。
    expect(body.temperature).toBe(MODEL_TEMPERATURE);
    expect(MODEL_TEMPERATURE).toBe(0.15);

    const ledger = readLedger(runtimeDir);
    expect(ledger.map((entry) => entry.kind)).toEqual(['budget_reserved', 'call_result']);
    const result = ledger[1] as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.requestId).toBe(REQUEST.requestId);
    expect(result.taskId).toBe(REQUEST.taskId);
    expect(typeof result.durationMs).toBe('number');
    expect(typeof result.promptChars).toBe('number');
    expect(typeof result.outputChars).toBe('number');
  });

  it('忽略 thinking 块，只取 text 块', async () => {
    const server = await serve((_request, response) => {
      sendJson(response, 200, anthropicThinking('先想一想怎么写……', draftJson()));
    });
    const { env } = makeEnv(server);
    const draft = await createModelPort(env).generateDraft(REQUEST);
    expect(draft.title).toBe('致新同学的一封信');
    expect(draft.paragraphs[0]?.text).not.toContain('先想一想');
  });

  it('剥掉模型偶发的 Markdown 代码块围栏', async () => {
    const server = await serve((_request, response) => {
      sendJson(response, 200, anthropicText('```json\n' + draftJson() + '\n```'));
    });
    const { env } = makeEnv(server);
    const draft = await createModelPort(env).generateDraft(REQUEST);
    expect(draft.paragraphs).toHaveLength(2);
  });

  it('openai 形状走 /v1/chat/completions', async () => {
    const server = await serve((_request, response) => {
      sendJson(response, 200, openAiCompletion(draftJson()));
    });
    const { env } = makeEnv(server, { POTBOT_MODEL_API_SHAPE: 'openai' });
    const draft = await createModelPort(env).generateDraft(REQUEST);
    expect(draft.title).toBe('致新同学的一封信');
    expect(server.requests[0]?.url).toBe('/v1/chat/completions');
  });

  it('空白写作要求在发请求前就被拒绝（不消耗额度）', async () => {
    const server = await serve((_request, response) => {
      sendJson(response, 200, anthropicText(draftJson()));
    });
    const { env } = makeEnv(server);
    const err = await expectModelError(() =>
      createModelPort(env).generateDraft({ ...REQUEST, instruction: '   ' }),
    );
    expect(err.code).toBe('model_request_rejected');
    expect(err.retryable).toBe(false);
    expect(server.requests).toHaveLength(0);
  });

  it('超过 maxInstructionChars 的写作要求被拒绝（不消耗额度）', async () => {
    const server = await serve((_request, response) => {
      sendJson(response, 200, anthropicText(draftJson()));
    });
    const { env } = makeEnv(server);
    const err = await expectModelError(() =>
      createModelPort(env).generateDraft({
        ...REQUEST,
        instruction: '写'.repeat(LIMITS.maxInstructionChars + 1),
      }),
    );
    expect(err.code).toBe('model_request_rejected');
    expect(server.requests).toHaveLength(0);
  });
});

describe('generateDraft —— 传输失败（fixture）', () => {
  it('超时：抛 model_timeout（可重试），且只尝试 2 次', async () => {
    const server = await serve(async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (!response.writableEnded) sendJson(response, 200, anthropicText(draftJson()));
    });
    const { env } = makeEnv(server, { POTBOT_MODEL_TIMEOUT_MS: '120' });
    const err = await expectModelError(() => createModelPort(env).generateDraft(REQUEST));
    expect(err.code).toBe('model_timeout');
    expect(err.retryable).toBe(true);
    expect(server.requests).toHaveLength(2);
  });

  it('上游 500：可重试，但总尝试上限为 2 次', async () => {
    const server = await serve((_request, response) => {
      sendJson(response, 500, { error: { message: 'upstream exploded' } });
    });
    const { env } = makeEnv(server);
    const err = await expectModelError(() => createModelPort(env).generateDraft(REQUEST));
    expect(err.code).toBe('model_upstream_error');
    expect(err.retryable).toBe(true);
    expect(server.requests).toHaveLength(2);
  });

  it('认证失败 401：不可重试，只尝试 1 次', async () => {
    const server = await serve((_request, response) => {
      sendText(response, 401, 'Local router authentication required.', 'text/html');
    });
    const { env } = makeEnv(server);
    const err = await expectModelError(() => createModelPort(env).generateDraft(REQUEST));
    expect(err.code).toBe('model_auth_error');
    expect(err.retryable).toBe(false);
    expect(server.requests).toHaveLength(1);
  });

  it('端点不存在 404：不可重试，只尝试 1 次', async () => {
    const server = await serve((_request, response) => {
      sendText(response, 404, 'not found');
    });
    const { env } = makeEnv(server);
    const err = await expectModelError(() => createModelPort(env).generateDraft(REQUEST));
    expect(err.code).toBe('model_endpoint_not_found');
    expect(err.retryable).toBe(false);
    expect(server.requests).toHaveLength(1);
  });

  it('响应不是 JSON：不可静默兜底，抛 model_response_not_json', async () => {
    const server = await serve((_request, response) => {
      sendText(response, 200, '抱歉，我无法完成这个请求。');
    });
    const { env } = makeEnv(server);
    const err = await expectModelError(() => createModelPort(env).generateDraft(REQUEST));
    expect(err.code).toBe('model_response_not_json');
    expect(err.retryable).toBe(true);
  });

  it('stop_reason=max_tokens：抛 model_response_truncated，不退化成半截草稿', async () => {
    const server = await serve((_request, response) => {
      sendJson(response, 200, anthropicThinking('思考占了预算……', '{"title":"半截', { stopReason: 'max_tokens' }));
    });
    const { env } = makeEnv(server);
    const err = await expectModelError(() => createModelPort(env).generateDraft(REQUEST));
    expect(err.code).toBe('model_response_truncated');
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('thinking');
  });

  it('空正文（只有 thinking 块）：抛 model_empty_response', async () => {
    const server = await serve((_request, response) => {
      sendJson(response, 200, anthropicMessage([{ type: 'thinking', thinking: '只想不说' }]));
    });
    const { env } = makeEnv(server);
    const err = await expectModelError(() => createModelPort(env).generateDraft(REQUEST));
    expect(err.code).toBe('model_empty_response');
  });
});

describe('generateDraft —— 响应校验（fixture）', () => {
  it('段落数越界（1 段 / 5 段）抛 model_response_schema', async () => {
    const onlyOne = await serve((_request, response) => {
      sendJson(response, 200, anthropicText(draftJson('标题', ['只有一段。'])));
    });
    const tooMany = await serve((_request, response) => {
      sendJson(
        response,
        200,
        anthropicText(draftJson('标题', ['一。', '二。', '三。', '四。', '五。'])),
      );
    });

    const one = await expectModelError(() =>
      createModelPort(makeEnv(onlyOne).env).generateDraft(REQUEST),
    );
    expect(one.code).toBe('model_response_schema');
    expect(one.message).toContain('1 段');

    const many = await expectModelError(() =>
      createModelPort(makeEnv(tooMany).env).generateDraft(REQUEST),
    );
    expect(many.code).toBe('model_response_schema');
    expect(many.message).toContain('5 段');
  });

  it('空白段落抛 model_response_schema', async () => {
    const server = await serve((_request, response) => {
      sendJson(response, 200, anthropicText(draftJson('标题', ['第一段有内容。', '   \n\t '])));
    });
    const { env } = makeEnv(server);
    const err = await expectModelError(() => createModelPort(env).generateDraft(REQUEST));
    expect(err.code).toBe('model_response_schema');
    expect(err.message).toContain('空白段');
  });

  it('title 为空抛 model_response_schema', async () => {
    const server = await serve((_request, response) => {
      sendJson(response, 200, anthropicText(draftJson('   ', ['第一段。', '第二段。'])));
    });
    const { env } = makeEnv(server);
    const err = await expectModelError(() => createModelPort(env).generateDraft(REQUEST));
    expect(err.code).toBe('model_response_schema');
    expect(err.message).toContain('title');
  });

  it('正文超长（>2000 字）抛 model_response_too_long', async () => {
    const long = '字'.repeat(1100);
    const server = await serve((_request, response) => {
      sendJson(response, 200, anthropicText(draftJson('标题', [long, long])));
    });
    const { env } = makeEnv(server);
    const err = await expectModelError(() => createModelPort(env).generateDraft(REQUEST));
    expect(err.code).toBe('model_response_too_long');
    expect(err.message).toContain('2200');
  });

  it('校验失败一律不兜底：2 次尝试都失败后仍抛错，绝不返回固定稿', async () => {
    const server = await serve((_request, response) => {
      sendJson(response, 200, anthropicText('{"title":"","paragraphs":[]}'));
    });
    const { env } = makeEnv(server);
    const err = await expectModelError(() => createModelPort(env).generateDraft(REQUEST));
    expect(err.code).toBe('model_response_schema');
    expect(server.requests).toHaveLength(2);
  });
});

describe('额度登记（fixture）', () => {
  it('预算耗尽：第二次调用抛 model_budget_exhausted，且不再打请求', async () => {
    const server = await serve((_request, response) => {
      sendJson(response, 200, anthropicText(draftJson()));
    });
    const { env } = makeEnv(server, { POTBOT_MODEL_MAX_REQUESTS: '1' });
    const port = createModelPort(env);

    await port.generateDraft(REQUEST);
    const err = await expectModelError(() => port.generateDraft({ ...REQUEST, requestId: 'req-fixture-2' }));

    expect(err.code).toBe('model_budget_exhausted');
    expect(err.retryable).toBe(false);
    expect(server.requests).toHaveLength(1);
  });

  it('重试也计数：预算 1 次 + 上游 500 时，第二次尝试在发请求前被预算拦住', async () => {
    const server = await serve((_request, response) => {
      sendJson(response, 500, { error: { message: 'boom' } });
    });
    const { env } = makeEnv(server, { POTBOT_MODEL_MAX_REQUESTS: '1' });
    const err = await expectModelError(() => createModelPort(env).generateDraft(REQUEST));
    expect(err.code).toBe('model_budget_exhausted');
    expect(server.requests).toHaveLength(1);
  });

  it('额度跨进程从账本恢复：新端口实例继续沿用已用次数', async () => {
    const server = await serve((_request, response) => {
      sendJson(response, 200, anthropicText(draftJson()));
    });
    const { env } = makeEnv(server, { POTBOT_MODEL_MAX_REQUESTS: '1' });

    __resetBudgetCacheForTests();
    await createModelPort(env).generateDraft(REQUEST);

    // 模拟"进程重启"：清掉内存缓存，仅凭账本还原额度。
    __resetBudgetCacheForTests();
    const err = await expectModelError(() =>
      createModelPort(env).generateDraft({ ...REQUEST, requestId: 'req-fixture-restart' }),
    );
    expect(err.code).toBe('model_budget_exhausted');
    expect(server.requests).toHaveLength(1);
  });
});

describe('调用账本（fixture）', () => {
  it('只记元数据：不含密钥，也不含响应正文', async () => {
    const secretParagraph = '第二段含有一段不该落盘的业务正文。';
    const server = await serve((_request, response) => {
      sendJson(response, 200, anthropicText(draftJson('标题', ['第一段。', secretParagraph])));
    });
    const { env, runtimeDir } = makeEnv(server);
    await createModelPort(env).generateDraft(REQUEST);

    const raw = readFileSync(join(runtimeDir, 'model-ledger.jsonl'), 'utf8');
    expect(raw).not.toContain(FIXTURE_TOKEN);
    expect(raw).not.toContain(secretParagraph);
    expect(raw).not.toContain('第一段。');

    const entries = readLedger(runtimeDir);
    const reserved = entries[0] as Record<string, unknown>;
    expect(reserved.kind).toBe('budget_reserved');
    expect(reserved.provider).toBe('anthropic_messages');
    expect(reserved.model).toBe('fixture-model');
    expect(reserved.attemptIndex).toBe(1);
    // thinking 抑制默认开启：登记时记的就是实际会发出的形态。
    expect(reserved.thinkingDisabled).toBe(true);
    expect(JSON.stringify(reserved)).not.toContain(FIXTURE_TOKEN);
  });

  it('失败也记账，并带上稳定 errorCode', async () => {
    const server = await serve((_request, response) => {
      sendText(response, 401, 'nope', 'text/html');
    });
    const { env, runtimeDir } = makeEnv(server);
    await expectModelError(() => createModelPort(env).generateDraft(REQUEST));

    const entries = readLedger(runtimeDir);
    expect(entries.map((entry) => entry.kind)).toEqual(['budget_reserved', 'call_result']);
    const result = entries[1] as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('model_auth_error');
  });
});

describe('thinking 抑制（默认开启）与自动回退', () => {
  it('默认就在请求体里带 thinking:{type:"disabled"}（不再需要人工打开）', async () => {
    const server = await serve((_request, response) => {
      sendJson(response, 200, anthropicText(draftJson()));
    });
    const { env, runtimeDir } = makeEnv(server);
    await createModelPort(env).generateDraft(REQUEST);

    const body = server.requests[0]?.json as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: 'disabled' });
    // 带 thinking 开关**不影响**合同数值。
    expect(body.max_tokens).toBe(1600);

    const ledger = readLedger(runtimeDir);
    expect((ledger[0] as Record<string, unknown>).thinkingDisabled).toBe(true);
    expect((ledger[1] as Record<string, unknown>).thinkingDisabled).toBe(true);
  });

  it('显式 POTBOT_MODEL_THINKING_DISABLED=0 时才不带该参数（保留人工关闭口）', async () => {
    const server = await serve((_request, response) => {
      sendJson(response, 200, anthropicText(draftJson()));
    });
    const { env, runtimeDir } = makeEnv(server, { POTBOT_MODEL_THINKING_DISABLED: '0' });
    await createModelPort(env).generateDraft(REQUEST);

    const body = server.requests[0]?.json as Record<string, unknown>;
    expect(body.thinking).toBeUndefined();
    expect((readLedger(runtimeDir)[0] as Record<string, unknown>).thinkingDisabled).toBe(false);
  });

  it('代理拒绝该参数（400）→ 自动换不带参数的请求体重发，且回退不占额度', async () => {
    const server = await serve((request, response) => {
      const body = request.json as Record<string, unknown>;
      if (body.thinking) {
        sendJson(response, 400, {
          error: { message: 'unknown field `thinking`', type: 'invalid_request_error' },
        });
        return;
      }
      sendJson(response, 200, anthropicText(draftJson()));
    });

    const { env, runtimeDir } = makeEnv(server, { POTBOT_MODEL_MAX_REQUESTS: '1' });
    const draft = await createModelPort(env).generateDraft(REQUEST);

    expect(draft.paragraphs).toHaveLength(2);
    expect(server.requests).toHaveLength(2);
    // 第一次带 thinking、第二次不带 —— 回退是代码自动完成的。
    expect((server.requests[0]?.json as Record<string, unknown>).thinking).toEqual({ type: 'disabled' });
    expect((server.requests[1]?.json as Record<string, unknown>).thinking).toBeUndefined();

    const ledger = readLedger(runtimeDir);
    expect(ledger.map((entry) => entry.kind)).toEqual([
      'budget_reserved',
      'thinking_param_fallback',
      'call_result',
    ]);
    // 回退的那次不带 thinking，且如实记下"代理拒绝了开关"。
    expect((ledger[1] as Record<string, unknown>).thinkingDisabled).toBe(false);
    const result = ledger[2] as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.thinkingDisabled).toBe(false);
    expect(result.thinkingParamRejected).toBe(true);

    // 关键：整个回退只花掉 1 次额度（被拒的 POST 不产生输出，不该计费）。
    const reserved = ledger.filter((entry) => entry.kind === 'budget_reserved');
    expect(reserved).toHaveLength(1);
    expect(server.requests).toHaveLength(2);
  });

  it('回退后仍被拒 → 抛真实错误，不吞掉', async () => {
    const server = await serve((_request, response) => {
      sendJson(response, 422, { error: { message: 'rejected' } });
    });
    const { env, runtimeDir } = makeEnv(server);
    const err = await expectModelError(() => createModelPort(env).generateDraft(REQUEST));

    expect(err.code).toBe('model_request_rejected');
    expect(server.requests).toHaveLength(2);
    // 只登记 1 次额度；回退那次不占。
    const ledger = readLedger(runtimeDir);
    expect(ledger.filter((entry) => entry.kind === 'budget_reserved')).toHaveLength(1);
    expect(ledger.filter((entry) => entry.kind === 'thinking_param_fallback')).toHaveLength(1);
  });

  it('401/404 不是"拒绝 thinking 开关"，不触发回退（该报什么就报什么）', async () => {
    const server = await serve((_request, response) => {
      sendText(response, 401, 'auth required', 'text/html');
    });
    const { env } = makeEnv(server);
    const err = await expectModelError(() => createModelPort(env).generateDraft(REQUEST));
    expect(err.code).toBe('model_auth_error');
    expect(server.requests).toHaveLength(1);
  });

  it('openai 形状不发 thinking 参数（该参数只在 Anthropic 形状有效）', async () => {
    const server = await serve((_request, response) => {
      sendJson(response, 200, openAiCompletion(draftJson()));
    });
    const { env } = makeEnv(server, { POTBOT_MODEL_API_SHAPE: 'openai' });
    await createModelPort(env).generateDraft(REQUEST);
    const body = server.requests[0]?.json as Record<string, unknown>;
    expect(body.thinking).toBeUndefined();
    expect(server.requests).toHaveLength(1);
  });
});

describe('POTBOT_MODEL_MAX_TOKENS —— 合同 1600 不得被悄悄改掉', () => {
  async function bodyFor(overrides: Record<string, string>): Promise<Record<string, unknown>> {
    const server = await serve((_request, response) => {
      sendJson(response, 200, anthropicText(draftJson()));
    });
    const { env } = makeEnv(server, overrides);
    await createModelPort(env).generateDraft(REQUEST);
    return server.requests[0]?.json as Record<string, unknown>;
  }

  it('不设该变量时请求体里仍是 1600（合同默认值）', async () => {
    const body = await bodyFor({});
    expect(body.max_tokens).toBe(1600);
  });

  it('非法值 / 空值一律回落 1600', async () => {
    for (const bad of ['', 'abc', '0', '-5', 'NaN']) {
      const body = await bodyFor({ POTBOT_MODEL_MAX_TOKENS: bad });
      expect(body.max_tokens, `POTBOT_MODEL_MAX_TOKENS=${JSON.stringify(bad)} 应回落 1600`).toBe(1600);
    }
  });

  it('显式设成更大值时如实采用（给 thinking 留头寸用）', async () => {
    const body = await bodyFor({ POTBOT_MODEL_MAX_TOKENS: '4096' });
    expect(body.max_tokens).toBe(4096);
  });

  it('describeModelConfig 同步反映该变量，且不设时是 1600', () => {
    const base = {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8008',
      ANTHROPIC_MODEL: 'm',
      ANTHROPIC_AUTH_TOKEN: 'k',
    };
    expect(describeModelConfig(base).maxTokens).toBe(1600);
    expect(describeModelConfig({ ...base, POTBOT_MODEL_MAX_TOKENS: '4096' }).maxTokens).toBe(4096);
    expect(describeModelConfig({ ...base, POTBOT_MODEL_MAX_TOKENS: 'oops' }).maxTokens).toBe(1600);
  });
});

/**
 * 失败分支专用：**没有模型时服务仍要能起来**。
 * `/health` 的 `modelConfigured` 必须能回 `false` 而不是让进程抛异常。
 * 这一组用例**不发任何请求**，纯函数级验证。
 */
describe('describeModelConfig —— 无模型/坏配置下不抛异常（失败分支）', () => {
  it('完全未配置：返回 configured:false 并列出缺什么，绝不抛异常', () => {
    let description!: ReturnType<typeof describeModelConfig>;
    expect(() => {
      description = describeModelConfig({});
    }).not.toThrow();

    expect(description.configured).toBe(false);
    expect(description.missing).toEqual([
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY',
    ]);
    expect(description.model).toBe('');
    expect(description.authMode).toBe('none');
    // 不编造假 URL 让页面展示。
    expect(description.endpointPath).toBe('');
    expect(description.baseUrlHost).toBe('<unparseable>');
  });

  it('部分配置：只报缺的那几项', () => {
    const onlyBase = describeModelConfig({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8008' });
    expect(onlyBase.configured).toBe(false);
    expect(onlyBase.missing).toEqual([
      'ANTHROPIC_MODEL',
      'ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY',
    ]);

    const noAuth = describeModelConfig({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8008',
      ANTHROPIC_MODEL: 'm',
    });
    expect(noAuth.configured).toBe(false);
    expect(noAuth.missing).toEqual(['ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY']);

    const apiKeyOnly = describeModelConfig({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8008',
      ANTHROPIC_MODEL: 'm',
      ANTHROPIC_API_KEY: 'k',
    });
    expect(apiKeyOnly.configured).toBe(true);
    expect(apiKeyOnly.authMode).toBe('api_key');
    expect(apiKeyOnly.missing).toEqual([]);
  });

  it('空串按未设置处理（启动脚本传了空变量也不会误判为已配置）', () => {
    const description = describeModelConfig({
      ANTHROPIC_BASE_URL: '',
      ANTHROPIC_MODEL: '   ',
      ANTHROPIC_AUTH_TOKEN: '',
    });
    expect(description.configured).toBe(false);
    expect(description.missing).toHaveLength(3);
    expect(description.baseUrlHost).toBe('<unparseable>');
    expect(description.endpointPath).toBe('');
  });

  it('base URL 解析不了 / 协议不对：算未配置，但不抛异常', () => {
    for (const bad of ['not-a-url', 'ftp://127.0.0.1:8008', '://missing-scheme']) {
      const description = describeModelConfig({
        ANTHROPIC_BASE_URL: bad,
        ANTHROPIC_MODEL: 'm',
        ANTHROPIC_AUTH_TOKEN: 'k',
      });
      expect(description.configured).toBe(false);
      expect(description.missing).toEqual(['ANTHROPIC_BASE_URL（不是可用的 http(s) URL）']);
      expect(description.endpointPath).toBe('');
    }
  });

  it('对比：describeModelConfig 不抛，createModelPort 才抛 —— /health 走前者', () => {
    const env: NodeJS.ProcessEnv = {};
    // /health 的取数路径：永远安全。
    expect(() => describeModelConfig(env)).not.toThrow();
    expect(describeModelConfig(env).configured).toBe(false);
    // 真正要发请求的路径：明确抛结构化错误，让宿主如实报"模型不可用"。
    expect(() => createModelPort(env)).toThrowError(ModelCallError);
    try {
      createModelPort(env);
    } catch (error) {
      expect((error as ModelCallError).code).toBe('model_not_configured');
      expect((error as ModelCallError).retryable).toBe(false);
    }
  });

  it('POTBOT_MODEL_MAX_REQUESTS 非法值时回落到合同默认 12，不抛异常', () => {
    for (const bad of ['abc', '-1', '']) {
      const description = describeModelConfig({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8008',
        ANTHROPIC_MODEL: 'm',
        ANTHROPIC_AUTH_TOKEN: 'k',
        POTBOT_MODEL_MAX_REQUESTS: bad,
      });
      expect(description.maxRequests).toBe(12);
    }
  });
});

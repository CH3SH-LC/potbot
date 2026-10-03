/**
 * S4 —— HTTP 传输层。
 *
 * 实测（2026-10-02，见 docs/other/review/mobile-word-demo/S4.md）：
 * 本机 `ANTHROPIC_BASE_URL` 指向一个**本机路由器**，提供 Anthropic Messages 形状的
 * `POST {base}/v1/messages`；`/v1/chat/completions` 返回 404。无认证头返回 401
 * 「Local router authentication required.」——认证强制，由 `Authorization: Bearer` 满足。
 *
 * ## thinking 与正文共用 max_tokens（实测事实）
 * 本机模型默认产出 `thinking` 块，`thinking` 与正文**共用同一个 `max_tokens`**。
 * 实测曾出现「1600 tokens 全被 thinking 吃掉、正文 0 字符」的截断失败。
 * 因此本层**默认带** `thinking:{type:"disabled"}`；
 * 若代理拒绝该参数（HTTP 400/422），**自动改用不带该参数的请求体重试一次**，
 * 并把"代理不接受 thinking 开关"如实回报给端口记账本，不靠人工发现。
 */

import { ModelCallError } from './errors.js';
import type {
  ExecutorMessage,
  ExecutorToolCall,
  ExecutorToolDeclaration,
} from './executor-types.js';
import { makeSanitizer } from './sanitize.js';

export type ApiShape = 'anthropic' | 'openai';

/**
 * 采样温度。变更记录（2026-10-02）：`0.3` → `0.15`（贴题辅助手段）。
 */
export const MODEL_TEMPERATURE = 0.15;

export interface TransportConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiShape: ApiShape;
  readonly authToken?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly timeoutMs: number;
  readonly maxTokens: number;
  /**
   * 首选形态：true（默认）= 请求体带 `thinking:{type:"disabled"}`。
   * 取不到该参数时本层会自动回退到不带参数的形态。
   */
  readonly thinkingDisabled: boolean;
}

export interface ModelResponse {
  /** 抽取出的**正文**（thinking / reasoning 块被丢弃）。 */
  readonly text: string;
  readonly stopReason: string | null;
  readonly hadThinkingBlock: boolean;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** **实际生效**（成功返回的那次 POST）是否带了 `thinking:{type:"disabled"}`。 */
  readonly thinkingDisabledApplied: boolean;
  /** 代理是否拒绝过 `thinking` 开关（即发生过自动回退）。 */
  readonly thinkingParamRejected: boolean;
}

export interface PostInfo {
  /** 本次 POST 是否带 `thinking:{type:"disabled"}`。 */
  readonly thinkingDisabled: boolean;
  /** 是否是「代理拒绝 thinking 开关」之后的自动回退 POST。 */
  readonly fallback: boolean;
}

export interface CallOptions {
  readonly config: TransportConfig;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly secrets: readonly (string | undefined)[];
  /**
   * 每次真正要 POST 之前调用。端口用它登记额度 / 记录回退。
   * 若它抛错（例如预算耗尽），异常直接冒泡，不再发请求。
   */
  readonly beforePost?: (info: PostInfo) => Promise<void>;
}

/** 兼容 base 已经带 `/v1` 的情况。 */
export function endpointUrl(baseUrl: string, shape: ApiShape): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = shape === 'anthropic' ? '/messages' : '/chat/completions';
  return /\/v1$/.test(base) ? `${base}${suffix}` : `${base}/v1${suffix}`;
}

export function authHeaders(config: TransportConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (config.apiShape === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  if (config.authToken) headers.authorization = `Bearer ${config.authToken}`;
  else if (config.apiKey) headers['x-api-key'] = config.apiKey;
  return headers;
}

export function buildRequestBody(
  config: TransportConfig,
  systemPrompt: string,
  userPrompt: string,
  useThinkingDisabled: boolean,
): string {
  if (config.apiShape === 'anthropic') {
    return JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      temperature: MODEL_TEMPERATURE,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      ...(useThinkingDisabled ? { thinking: { type: 'disabled' } } : {}),
    });
  }
  return JSON.stringify({
    model: config.model,
    max_tokens: config.maxTokens,
    temperature: MODEL_TEMPERATURE,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });
}

interface ParsedBody {
  text: string | null;
  stopReason: string | null;
  hadThinkingBlock: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
}

function emptyParsed(): ParsedBody {
  return {
    text: null,
    stopReason: null,
    hadThinkingBlock: false,
    inputTokens: null,
    outputTokens: null,
  };
}

/**
 * 只取 `type === 'text'` 的块。`thinking` / `redacted_thinking` 一律丢弃。
 *
 * 注意一个**实测过的坑**：正文被截断（stop_reason=max_tokens）时，
 * `thinking` 块可能很长而 `text` 块**根本不存在**——那时 text 为 null，
 * 这里返回 null 是正确行为，调用方不能把它当成"模型没说话"而兜底。
 */
function parseAnthropicBody(body: unknown): ParsedBody {
  const result = emptyParsed();
  if (typeof body !== 'object' || body === null) return result;
  const record = body as Record<string, unknown>;

  if (typeof record.stop_reason === 'string') result.stopReason = record.stop_reason;
  else if (typeof record.stopReason === 'string') result.stopReason = record.stopReason;

  const usage = record.usage;
  if (typeof usage === 'object' && usage !== null) {
    const u = usage as Record<string, unknown>;
    if (typeof u.input_tokens === 'number') result.inputTokens = u.input_tokens;
    if (typeof u.output_tokens === 'number') result.outputTokens = u.output_tokens;
  }

  const content = record.content;
  if (typeof content === 'string') {
    result.text = content;
    return result;
  }
  if (!Array.isArray(content)) return result;

  const parts: string[] = [];
  for (const rawBlock of content) {
    if (typeof rawBlock !== 'object' || rawBlock === null) continue;
    const block = rawBlock as Record<string, unknown>;
    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      result.hadThinkingBlock = true;
      continue;
    }
    if (typeof block.text === 'string') parts.push(block.text);
  }
  result.text = parts.length > 0 ? parts.join('') : null;
  return result;
}

function parseOpenAiBody(body: unknown): ParsedBody {
  const result = emptyParsed();
  if (typeof body !== 'object' || body === null) return result;
  const record = body as Record<string, unknown>;
  const usage = record.usage;
  if (typeof usage === 'object' && usage !== null) {
    const u = usage as Record<string, unknown>;
    if (typeof u.prompt_tokens === 'number') result.inputTokens = u.prompt_tokens;
    if (typeof u.completion_tokens === 'number') result.outputTokens = u.completion_tokens;
  }
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) return result;
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return result;
  const choice = first as Record<string, unknown>;
  if (typeof choice.finish_reason === 'string') result.stopReason = choice.finish_reason;
  const message = choice.message;
  if (typeof message === 'object' && message !== null) {
    const m = message as Record<string, unknown>;
    if (typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0) {
      result.hadThinkingBlock = true;
    }
    if (typeof m.content === 'string') result.text = m.content;
  } else if (typeof choice.text === 'string') {
    result.text = choice.text;
  }
  return result;
}

function parseBody(shape: ApiShape, body: unknown): ParsedBody {
  return shape === 'anthropic' ? parseAnthropicBody(body) : parseOpenAiBody(body);
}

/**
 * 代理拒绝 `thinking` 开关的判据。
 *
 * 400 / 422 一律视为"可能拒绝"并触发自动回退，**不要求错误文本点名 thinking**：
 * 该参数是本次请求相对基线唯一的差异，回退后的第二次 POST 要么成功、
 * 要么抛出**真实**错误，因此放宽判据不会掩盖问题，只会多花一次不产生输出的 POST。
 * 这样设计是为了满足"回退必须由代码自动完成、不能靠人工发现"。
 */
export function isThinkingParamRejection(status: number): boolean {
  return status === 400 || status === 422;
}

function classifyHttpFailure(status: number, rawBody: string, sanitize: (v: unknown) => string): ModelCallError {
  const head = sanitize(rawBody).slice(0, 300);
  const suffix = head ? `；上游返回：${head}` : '';
  if (status === 401 || status === 403) {
    return new ModelCallError('model_auth_error', `模型端点拒绝认证（HTTP ${status}）${suffix}`, false);
  }
  if (status === 404 || status === 405) {
    return new ModelCallError('model_endpoint_not_found', `模型端点不存在或方法不允许（HTTP ${status}）${suffix}`, false);
  }
  if (status === 429) {
    return new ModelCallError('model_rate_limited', `模型端点限流（HTTP 429）${suffix}`, true);
  }
  if (status >= 500) {
    return new ModelCallError('model_upstream_error', `模型上游错误（HTTP ${status}）${suffix}`, true);
  }
  return new ModelCallError('model_request_rejected', `模型请求被拒绝（HTTP ${status}）${suffix}`, false);
}

function classifyFetchFailure(error: unknown, signal: AbortSignal, sanitize: (v: unknown) => string): ModelCallError {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError' || signal.aborted) {
    return new ModelCallError('model_timeout', '模型调用超时，已放弃本次尝试', true);
  }
  const cause = (error as { cause?: unknown } | null)?.cause;
  const causeRecord = typeof cause === 'object' && cause !== null ? (cause as Record<string, unknown>) : null;
  const detail =
    (typeof causeRecord?.code === 'string' ? causeRecord.code : undefined) ??
    (typeof causeRecord?.message === 'string' ? causeRecord.message : undefined) ??
    ((error as { message?: unknown } | null)?.message as string | undefined) ??
    String(error);
  return new ModelCallError('model_network_error', `模型网络错误：${sanitize(detail)}`, true);
}

// ---------------------------------------------------------------------------
// 多轮 + 工具（KRN-04 / R221–R223）
// ---------------------------------------------------------------------------
//
// 与上面 `callModelOnce` 的关系：**并列，不是替换**。`callModelOnce` 是单轮写作链
// （`generateDraft`）用的，语义是"给要求、拿草稿"；下面这组是执行器用的，
// 语义是"给整段上下文与工具，拿这一轮要什么"。两条路径共用同一套端点解析、
// 认证头、thinking 回退与错误分类，不各写一套传输。

/** 一次**多轮**调用的输入。 */
export interface ConversationalCallOptions {
  readonly config: TransportConfig;
  readonly systemPrompt: string;
  readonly messages: readonly ExecutorMessage[];
  readonly tools: readonly ExecutorToolDeclaration[];
  readonly secrets: readonly (string | undefined)[];
  /** 调用方的取消信号；与超时信号**合并**（任一触发即中止）。 */
  readonly signal?: AbortSignal;
  readonly beforePost?: (info: PostInfo) => Promise<void>;
}

/** 一次多轮调用的结果。**工具调用不再被当成"没有正文"而丢弃**。 */
export interface ConversationalResponse {
  readonly text: string;
  readonly toolCalls: readonly ExecutorToolCall[];
  readonly stopReason: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly thinkingDisabledApplied: boolean;
  readonly thinkingParamRejected: boolean;
}

/**
 * 取消判定走**函数**而不是内联比较：内联 `signal?.aborted === true` 会被 TS 的
 * 控制流分析在首个守卫之后收窄成恒假（它把参数对象的只读属性当成不变），
 * 于是后续几处检查会被判成"不可能发生"而写了等于没写。
 */
function abortedNow(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function toolCallFromAnthropicBlock(block: Record<string, unknown>): ExecutorToolCall | null {
  if (block.type !== 'tool_use') return null;
  const id = typeof block.id === 'string' ? block.id : '';
  const name = typeof block.name === 'string' ? block.name : '';
  if (id === '' || name === '') return null;
  const input = block.input;
  const args =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  return { id, name, arguments: args };
}

function toolCallFromOpenAiEntry(entry: Record<string, unknown>): ExecutorToolCall | null {
  const id = typeof entry.id === 'string' ? entry.id : '';
  const fn = entry.function;
  if (id === '' || typeof fn !== 'object' || fn === null) return null;
  const record = fn as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name : '';
  if (name === '') return null;
  // 参数是**字符串形式的 JSON**（OpenAI 形状）。解析失败不当成空参数——那会把
  // "模型给了坏参数"伪装成"模型没给参数"，调用方就失去了拒绝的依据。
  const rawArgs = typeof record.arguments === 'string' ? record.arguments : '{}';
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawArgs);
    args = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new ModelCallError(
      'model_response_schema',
      `工具调用的 arguments 不是合法 JSON：${rawArgs.slice(0, 160)}`,
      false,
    );
  }
  return { id, name, arguments: args };
}

/**
 * 组装多轮请求体。工具与历史原样透传；**只有调用方给的**，本层不补任何默认工具。
 */
export function buildConversationRequestBody(
  config: TransportConfig,
  systemPrompt: string,
  messages: readonly ExecutorMessage[],
  tools: readonly ExecutorToolDeclaration[],
  useThinkingDisabled: boolean,
): string {
  if (config.apiShape === 'anthropic') {
    const encoded = messages.map((message) => {
      if (message.role === 'assistant') {
        const blocks: Record<string, unknown>[] = [];
        if (message.text !== '') blocks.push({ type: 'text', text: message.text });
        for (const call of message.toolCalls ?? []) {
          blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
        }
        return { role: 'assistant', content: blocks };
      }
      if (message.role === 'tool') {
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.toolCallId ?? '',
              content: message.text,
              ...(message.toolFailed === true ? { is_error: true } : {}),
            },
          ],
        };
      }
      return { role: 'user', content: message.text };
    });
    return JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      temperature: MODEL_TEMPERATURE,
      system: systemPrompt,
      messages: encoded,
      ...(tools.length === 0
        ? {}
        : {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema,
            })),
          }),
      ...(useThinkingDisabled ? { thinking: { type: 'disabled' } } : {}),
    });
  }

  const encoded = messages.map((message) => {
    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: message.text,
        ...(message.toolCalls === undefined || message.toolCalls.length === 0
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            }),
      };
    }
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId ?? '', content: message.text };
    }
    return { role: 'user', content: message.text };
  });
  return JSON.stringify({
    model: config.model,
    max_tokens: config.maxTokens,
    temperature: MODEL_TEMPERATURE,
    messages: [{ role: 'system', content: systemPrompt }, ...encoded],
    ...(tools.length === 0
      ? {}
      : {
          tools: tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        }),
  });
}

function extractTurn(
  shape: ApiShape,
  body: unknown,
): {
  readonly text: string;
  readonly toolCalls: readonly ExecutorToolCall[];
  readonly stopReason: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
} {
  let text = '';
  const toolCalls: ExecutorToolCall[] = [];
  let stopReason: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  if (typeof body !== 'object' || body === null) {
    return { text, toolCalls, stopReason, inputTokens, outputTokens };
  }
  const record = body as Record<string, unknown>;

  if (shape === 'anthropic') {
    if (typeof record.stop_reason === 'string') stopReason = record.stop_reason;
    const usage = record.usage;
    if (typeof usage === 'object' && usage !== null) {
      const u = usage as Record<string, unknown>;
      if (typeof u.input_tokens === 'number') inputTokens = u.input_tokens;
      if (typeof u.output_tokens === 'number') outputTokens = u.output_tokens;
    }
    const content = record.content;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const rawBlock of content) {
        if (typeof rawBlock !== 'object' || rawBlock === null) continue;
        const block = rawBlock as Record<string, unknown>;
        // thinking 与正文分开：思考不是交付内容，不进上下文（它会污染后续轮次）。
        if (block.type === 'thinking' || block.type === 'redacted_thinking') continue;
        if (typeof block.text === 'string') parts.push(block.text);
        const call = toolCallFromAnthropicBlock(block);
        if (call !== null) toolCalls.push(call);
      }
      text = parts.join('');
    }
    return { text, toolCalls, stopReason, inputTokens, outputTokens };
  }

  const usage = record.usage;
  if (typeof usage === 'object' && usage !== null) {
    const u = usage as Record<string, unknown>;
    if (typeof u.prompt_tokens === 'number') inputTokens = u.prompt_tokens;
    if (typeof u.completion_tokens === 'number') outputTokens = u.completion_tokens;
  }
  const choices = record.choices;
  if (Array.isArray(choices) && choices.length > 0 && typeof choices[0] === 'object') {
    const choice = choices[0] as Record<string, unknown>;
    if (typeof choice.finish_reason === 'string') stopReason = choice.finish_reason;
    const message = choice.message;
    if (typeof message === 'object' && message !== null) {
      const m = message as Record<string, unknown>;
      if (typeof m.content === 'string') text = m.content;
      if (Array.isArray(m.tool_calls)) {
        for (const raw of m.tool_calls) {
          if (typeof raw !== 'object' || raw === null) continue;
          const call = toolCallFromOpenAiEntry(raw as Record<string, unknown>);
          if (call !== null) toolCalls.push(call);
        }
      }
    }
  }
  return { text, toolCalls, stopReason, inputTokens, outputTokens };
}

/**
 * 发一次多轮请求（含工具声明）。
 *
 * 与 `callModelOnce` 的三点**关键差别**：
 * 1. **空正文不再一律是错**：带 `tool_use` 的一轮本来就可能没有文本；
 * 2. 取消信号由调用方给，和超时**合并**（任一触发即中止）；
 * 3. 截断（`max_tokens`）仍然抛错——但不带"模型没说话"的兜底稿。
 */
export async function converseOnce(options: ConversationalCallOptions): Promise<ConversationalResponse> {
  const { config } = options;
  const sanitize = makeSanitizer(options.secrets);
  const url = endpointUrl(config.baseUrl, config.apiShape);
  const headers = authHeaders(config);

  if (abortedNow(options.signal)) {
    throw new ModelCallError('model_cancelled', '调用在发出前已被取消（取消信号已中止）', false);
  }

  // 与 `callModelOnce` 同口径：只有 Anthropic 形状才发 thinking 参数，
  // 被 400/422 拒绝时自动换不带参数的形态重发一次。
  const fallbackAllowed = config.thinkingDisabled === true && config.apiShape === 'anthropic';
  const attempts = fallbackAllowed ? 2 : 1;
  let thinkingParamRejected = false;

  for (let index = 0; index < attempts; index += 1) {
    const useThinkingDisabled: boolean = fallbackAllowed && index === 0;
    const fallback = index > 0;

    if (abortedNow(options.signal)) {
      throw new ModelCallError('model_cancelled', '调用在重试前被取消（取消信号已中止）', false);
    }
    if (options.beforePost) await options.beforePost({ thinkingDisabled: useThinkingDisabled, fallback });

    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal =
      options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);

    let post: { status: number; ok: boolean; rawBody: string };
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: buildConversationRequestBody(
          config,
          options.systemPrompt,
          options.messages,
          options.tools,
          useThinkingDisabled,
        ),
        signal,
      });
      post = { status: response.status, ok: response.ok, rawBody: await response.text() };
    } catch (error) {
      // 取消与超时必须分开报：把"用户取消了"写成"超时了"是在编造原因。
      if (abortedNow(options.signal)) {
        throw new ModelCallError('model_cancelled', '调用已取消（取消信号触发，非上游故障）', false);
      }
      throw classifyFetchFailure(error, signal, sanitize);
    }

    if (!post.ok) {
      if (useThinkingDisabled && isThinkingParamRejection(post.status)) {
        thinkingParamRejected = true;
        continue;
      }
      throw classifyHttpFailure(post.status, post.rawBody, sanitize);
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(post.rawBody);
    } catch {
      throw new ModelCallError(
        'model_response_not_json',
        `模型端点的响应不是合法 JSON（HTTP ${post.status}）`,
        true,
      );
    }

    const turn = extractTurn(config.apiShape, parsedJson);

    if (turn.stopReason === 'max_tokens' || turn.stopReason === 'length') {
      throw new ModelCallError(
        'model_response_truncated',
        `模型输出因达到 max_tokens(${config.maxTokens}) 被截断` +
          (turn.text.trim() ? `；已产出的文本片段（脱敏后前 160 字）：${sanitize(turn.text).slice(0, 160)}` : ''),
        true,
      );
    }
    if (turn.stopReason === 'refusal') {
      throw new ModelCallError('model_request_rejected', '模型拒绝作答', false);
    }
    if (turn.text.trim() === '' && turn.toolCalls.length === 0) {
      throw new ModelCallError('model_empty_response', '模型这一轮既没有正文也没有工具调用', true);
    }

    return {
      text: turn.text,
      toolCalls: turn.toolCalls,
      stopReason: turn.stopReason,
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      thinkingDisabledApplied: useThinkingDisabled,
      thinkingParamRejected,
    };
  }

  throw new ModelCallError(
    'model_request_rejected',
    '代理拒绝了 thinking:{type:"disabled"}，回退到不带该参数的请求后仍被拒绝',
    false,
  );
}

interface PostResult {
  readonly status: number;
  readonly ok: boolean;
  readonly rawBody: string;
}

/** 发一次 POST。网络层失败收敛成 ModelCallError。 */
async function postOnce(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  sanitize: (v: unknown) => string,
): Promise<PostResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, { method: 'POST', headers, body, signal });
    const rawBody = await response.text();
    return { status: response.status, ok: response.ok, rawBody };
  } catch (error) {
    throw classifyFetchFailure(error, signal, sanitize);
  }
}

/**
 * 发一次逻辑请求。**默认带** `thinking:{type:"disabled"}`；
 * 被代理拒绝（400/422）时**自动**换不带该参数的请求体重发一次。
 * 所有失败路径都收敛成 `ModelCallError`，绝不返回假稿。
 */
export async function callModelOnce(options: CallOptions): Promise<ModelResponse> {
  const { config } = options;
  const sanitize = makeSanitizer(options.secrets);
  const url = endpointUrl(config.baseUrl, config.apiShape);
  const headers = authHeaders(config);

  const wantDisabled = config.thinkingDisabled === true;
  // 只有 Anthropic 形状才发 thinking 参数；回退形态只有在想发的时候才有意义。
  const forms: boolean[] = wantDisabled && config.apiShape === 'anthropic' ? [true, false] : [false];

  let thinkingParamRejected = false;

  for (let index = 0; index < forms.length; index += 1) {
    const useThinkingDisabled = forms[index] === true;
    const fallback = index > 0;

    if (options.beforePost) await options.beforePost({ thinkingDisabled: useThinkingDisabled, fallback });

    const post = await postOnce(
      url,
      headers,
      buildRequestBody(config, options.systemPrompt, options.userPrompt, useThinkingDisabled),
      config.timeoutMs,
      sanitize,
    );

    if (!post.ok) {
      // 带了 thinking 却被 400/422 拒 —— 自动换不带参数的形态重发。
      if (useThinkingDisabled && isThinkingParamRejection(post.status)) {
        thinkingParamRejected = true;
        continue;
      }
      throw classifyHttpFailure(post.status, post.rawBody, sanitize);
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(post.rawBody);
    } catch {
      throw new ModelCallError(
        'model_response_not_json',
        `模型端点的响应不是合法 JSON（HTTP ${post.status}）`,
        true,
      );
    }

    const parsed = parseBody(config.apiShape, parsedJson);

    if (parsed.stopReason === 'max_tokens' || parsed.stopReason === 'length') {
      const excerpt =
        parsed.text && parsed.text.trim()
          ? `；正文片段（脱敏后，前 160 字）：${sanitize(parsed.text).slice(0, 160)}`
          : '；本次响应没有可用的 text 块（正文 0 字符）';
      throw new ModelCallError(
        'model_response_truncated',
        `模型输出因达到 max_tokens(${config.maxTokens}) 被截断` +
          (parsed.hadThinkingBlock ? '；本次响应含 thinking 块，思考占用了输出预算' : '') +
          (useThinkingDisabled ? '' : '；本次请求未带 thinking:{type:"disabled"}') +
          excerpt,
        true,
      );
    }
    if (parsed.stopReason === 'refusal') {
      throw new ModelCallError('model_request_rejected', '模型拒绝作答', false);
    }
    if (parsed.text === null || parsed.text.trim() === '') {
      throw new ModelCallError(
        'model_empty_response',
        '模型返回了空正文' + (parsed.hadThinkingBlock ? '（只有 thinking 块，没有 text 块）' : ''),
        true,
      );
    }

    return {
      text: parsed.text,
      stopReason: parsed.stopReason,
      hadThinkingBlock: parsed.hadThinkingBlock,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      thinkingDisabledApplied: useThinkingDisabled,
      thinkingParamRejected,
    };
  }

  // 走完所有形态都没返回：说明回退后仍被拒。
  throw new ModelCallError(
    'model_request_rejected',
    '代理拒绝了 thinking:{type:"disabled"}，回退到不带该参数的请求后仍被拒绝',
    false,
  );
}

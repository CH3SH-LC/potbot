/**
 * K02 模型端口 —— **请求构造 + 流式事件映射 + 取消/超时 + 用量记账**（零依赖）。
 *
 * ## 一句话口径
 *
 * **只有"见到上游 `done` 且没有任何错误"才算成功。** 401 / 429 / 断流 / 超时 /
 * 预算超支一律 `failed`，取消是 `cancelled`；两者都不会把任何片段当作可用结果。
 *
 * ## 四条不让步的设计
 *
 * 1. **失败先落 error 片段**：流式通道上，任何失败都在收束前先产出一条
 *    `{type:'error'}` 片段。只看片段流的消费者也不会把断流读成"正常结束"。
 * 2. **`run()` 有兜底**：即便 `streamModel` 因为未来的改动提前返回而没有产出终结标记，
 *    `run()` 也会把它判成 `stream_truncated` 失败（见负例"断流不得成功"）。
 *    双保险是有意的：这条判据一旦退化，失败会被写进用户文档。
 * 3. **非 2xx 不消费响应体**：401/429 直接以 error 收束，连一条 text 片段都不会产出。
 * 4. **记账在预算之后**：`usage` 片段先如实产出（它是真实用量），再判是否超预算；
 *    超了就以 `budget_exceeded` 失败收尾——用量不被抹掉，但结果不被冒充成功。
 *
 * ## 未做（如实标注）
 *
 * - **真实 HTTPS**：本模块只调注入的 `ModelTransport`。真实网络、SSE 解析、证书校验未实现。
 * - **真实分词**：`estimateMinTokens()` 是字符数启发式，不是 tokenizer。
 */

import {
  ModelPortError,
  isModelPortError,
  streamCodeFor,
  type ModelPortErrorCode,
} from './errors.js';
import {
  toCancellationHandle,
  type CancellationHandle,
  type CancellationSource,
  type Unsubscribe,
} from './cancellation.js';
import { redactCallRecord } from './redact.js';
import { systemClock, systemTimers, type Clock, type TimerPort, type TimerHandle } from './transport.js';
import {
  CHAT_ROLES,
  DEFAULT_MODEL,
  KEY_REF_PATTERN,
  MODEL_NAME_PATTERN,
  TOOL_CALL_ID_PATTERN,
  type Budget,
  type Cancellation,
  type ChatMessage,
  type ChatRole,
  type ModelCallRecord,
  type ModelOutcomeStatus,
  type ModelPortRequest,
  type ModelPortRequestInput,
  type ModelTransport,
  type ModelWireBody,
  type RawStreamEvent,
  type StreamChunk,
  type StreamError,
  type ToolCall,
  type ToolResult,
  type ToolSchema,
  type TransportRequest,
  type Usage,
} from './types.js';
// ★ 跨包接线（K03 集成请求）：模型端口的 `keyRef` **不再由本文件写死**，而是向 K03 安全包
// 索取默认引用。`security/keyref.ts` 自身只依赖 `security/errors.ts`，不反向依赖 model/，
// 因此不构成循环。
import { DEFAULT_KEY_REFS, isKeyKind, type KeyKind } from '../security/keyref.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 默认上游主机。**只是字符串**：本包没有实现到它的任何连接。 */
export const DEFAULT_HOST = 'api.deepseek.com';

/** 调用方未指定 `cancellation` 时使用（永不取消）。 */
export const DEFAULT_CANCELLATION: Cancellation = Object.freeze({
  token: 'cancel:default',
  cancelled: false,
});

/** 状态判定用的确认码（`streamCodeFor('cancelled')` 的缓存，避免热路径重复大写化）。 */
const CANCELLED_STREAM_CODE = streamCodeFor('cancelled');
const TRUNCATED_STREAM_CODE = streamCodeFor('stream_truncated');

/** 每条消息在估算里额外算的固定开销（角色标记 / 分隔符的粗估）。 */
const PER_MESSAGE_OVERHEAD = 16;
/** 字符→token 的粗估比例。**这是启发式，不是分词**。 */
const CHARS_PER_TOKEN = 4;

const MESSAGE_KEYS = ['role', 'content', 'name', 'toolCallId'] as const;
const TOOL_SCHEMA_KEYS = ['name', 'description', 'parameters'] as const;
const CANCELLATION_KEYS = ['token', 'cancelled', 'deadlineMs'] as const;
const BUDGET_KEYS = ['maxTokens', 'maxCostMicros', 'timeoutMs'] as const;
const REQUEST_KEYS = ['messages', 'toolSchemas', 'cancellation', 'budget', 'keyRef', 'model', 'stream', 'metadata'] as const;

// ---------------------------------------------------------------------------
// 形状校验（契约 additionalProperties: false ⇒ 未知键一律拒，不"忽略"）
// ---------------------------------------------------------------------------

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ModelPortError('invalid_request', `${what} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
  code: ModelPortErrorCode = 'invalid_request',
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ModelPortError(
        code,
        `${what} 含未知字段 "${key}"（契约 additionalProperties: false：本模块拒绝而不是忽略）`,
      );
    }
  }
}

function requireNonEmptyString(value: unknown, what: string, code: ModelPortErrorCode = 'invalid_request'): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ModelPortError(code, `${what} 必须是非空字符串，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, what: string, code: ModelPortErrorCode): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ModelPortError(code, `${what} 必须是非负整数，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

function normalizeMessages(input: unknown): readonly ChatMessage[] {
  if (!Array.isArray(input)) {
    throw new ModelPortError('invalid_request', 'messages 必须是数组');
  }
  if (input.length === 0) {
    throw new ModelPortError('invalid_request', 'messages 至少一条（契约 minItems: 1）');
  }
  const out: ChatMessage[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const obj = asRecord(input[i], `messages[${i}]`);
    rejectUnknownKeys(obj, MESSAGE_KEYS, `messages[${i}]`);
    const role = obj['role'];
    if (typeof role !== 'string' || !(CHAT_ROLES as readonly string[]).includes(role)) {
      throw new ModelPortError('invalid_request', `messages[${i}].role 非法：${JSON.stringify(role)}`);
    }
    const message: { role: ChatRole; content?: string; name?: string; toolCallId?: string } = { role: role as ChatRole };
    if (obj['content'] !== undefined) {
      if (typeof obj['content'] !== 'string') {
        throw new ModelPortError('invalid_request', `messages[${i}].content 必须是字符串`);
      }
      message.content = obj['content'];
    }
    if (obj['name'] !== undefined) {
      message.name = requireNonEmptyString(obj['name'], `messages[${i}].name`);
    }
    if (obj['toolCallId'] !== undefined) {
      const id = obj['toolCallId'];
      if (typeof id !== 'string' || !TOOL_CALL_ID_PATTERN.test(id)) {
        throw new ModelPortError(
          'invalid_request',
          `messages[${i}].toolCallId 不符合契约 pattern ^[A-Za-z0-9_.:-]+$`,
        );
      }
      message.toolCallId = id;
    }
    if (role === 'tool' && message.toolCallId === undefined) {
      throw new ModelPortError(
        'tool_message_missing_call_id',
        `messages[${i}] 是 tool 消息但没有 toolCallId：工具结果无处与调用对应（契约 $defs.toolResult 说明）`,
      );
    }
    out.push(Object.freeze(message));
  }
  return Object.freeze(out);
}

function normalizeToolSchemas(input: unknown): readonly ToolSchema[] {
  if (!Array.isArray(input)) {
    throw new ModelPortError('invalid_tool_schema', 'toolSchemas 必须是数组');
  }
  const out: ToolSchema[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const obj = asRecord(input[i], `toolSchemas[${i}]`);
    rejectUnknownKeys(obj, TOOL_SCHEMA_KEYS, `toolSchemas[${i}]`, 'invalid_tool_schema');
    const name = requireNonEmptyString(obj['name'], `toolSchemas[${i}].name`, 'invalid_tool_schema');
    const parameters = obj['parameters'];
    if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
      throw new ModelPortError('invalid_tool_schema', `toolSchemas[${i}].parameters 必须是对象`);
    }
    const schema: { name: string; description?: string; parameters: Readonly<Record<string, unknown>> } = {
      name,
      parameters: Object.freeze({ ...(parameters as Record<string, unknown>) }),
    };
    if (obj['description'] !== undefined) {
      if (typeof obj['description'] !== 'string') {
        throw new ModelPortError('invalid_tool_schema', `toolSchemas[${i}].description 必须是字符串`);
      }
      schema.description = obj['description'];
    }
    out.push(Object.freeze(schema));
  }
  return Object.freeze(out);
}

function normalizeCancellation(input: unknown): Cancellation {
  const obj = asRecord(input, 'cancellation');
  rejectUnknownKeys(obj, CANCELLATION_KEYS, 'cancellation');
  const token = requireNonEmptyString(obj['token'], 'cancellation.token');
  const out: { token: string; cancelled?: boolean; deadlineMs?: number } = { token };
  if (obj['cancelled'] !== undefined) {
    if (typeof obj['cancelled'] !== 'boolean') {
      throw new ModelPortError('invalid_request', 'cancellation.cancelled 必须是布尔');
    }
    out.cancelled = obj['cancelled'];
  }
  if (obj['deadlineMs'] !== undefined) {
    out.deadlineMs = requireNonNegativeInteger(obj['deadlineMs'], 'cancellation.deadlineMs', 'invalid_request');
  }
  return Object.freeze(out);
}

function normalizeBudget(input: unknown): Budget {
  const obj = asRecord(input, 'budget');
  rejectUnknownKeys(obj, BUDGET_KEYS, 'budget', 'invalid_budget');
  const out: { maxTokens?: number; maxCostMicros?: number; timeoutMs?: number } = {};
  if (obj['maxTokens'] !== undefined) {
    out.maxTokens = requireNonNegativeInteger(obj['maxTokens'], 'budget.maxTokens', 'invalid_budget');
  }
  if (obj['maxCostMicros'] !== undefined) {
    out.maxCostMicros = requireNonNegativeInteger(obj['maxCostMicros'], 'budget.maxCostMicros', 'invalid_budget');
  }
  if (obj['timeoutMs'] !== undefined) {
    out.timeoutMs = requireNonNegativeInteger(obj['timeoutMs'], 'budget.timeoutMs', 'invalid_budget');
  }
  if (out.maxTokens === undefined && out.maxCostMicros === undefined && out.timeoutMs === undefined) {
    throw new ModelPortError('budget_missing', 'budget 三项（maxTokens/maxCostMicros/timeoutMs）全缺：契约 anyOf 要求至少一项');
  }
  return Object.freeze(out);
}

/**
 * `keyRef` 的**双重**判据：形状是引用，且内容不含明文密钥特征。
 *
 * 只做前者会漏掉 `keyref:sk-live-xxxxxxxx`（形状合法、内容是明文）；
 * 只做后者会漏掉任何自造形状的密钥。两条都要。
 */
function normalizeKeyRef(input: unknown): string {
  const keyRef = requireNonEmptyString(input, 'keyRef', 'invalid_key_ref');
  if (!KEY_REF_PATTERN.test(keyRef)) {
    throw new ModelPortError(
      'invalid_key_ref',
      'keyRef 必须是 keyref: 前缀的引用（契约 pattern ^keyref:[A-Za-z0-9._:-]+$）；明文密钥不是合法 keyRef',
    );
  }
  // 引用形状下再查内容：`keyref:sk-...` 这类"引用里裹明文"必须被抓。
  const hit = keyRef.replace(/^keyref:/, '');
  if (/sk-[A-Za-z0-9_-]{10,}/.test(hit) || /AIza[0-9A-Za-z_-]{20,}/.test(hit)) {
    throw new ModelPortError('key_ref_contains_secret', 'keyRef 形状像引用但内容带明文密钥特征（原文不落盘）');
  }
  return keyRef;
}

// ---------------------------------------------------------------------------
// keyRef 来源：注入 provider（默认委托 K03 安全包）
// ---------------------------------------------------------------------------

/**
 * 给定密钥种类，返回一个 `keyref:` **引用**（**不是**密钥本身）的函数。
 *
 * K03 的 `KeyManager` 可直接满足此形状：`(kind) => manager.status(kind).keyRef`——它取
 * "当前活跃密钥的引用"，且在密钥缺失时回退到 `DEFAULT_KEY_REFS[kind]`。宿主也可直接
 * 包一层 `DEFAULT_KEY_REFS`。**无论 provider 返回什么，出口一律过 `normalizeKeyRef`**：
 * 形状（`KEY_REF_PATTERN`）+ 明文内容双重判据都不让步，所以 provider 是"引用来源"，
 * 不是"明文的旁路"。
 */
export type KeyRefProvider = (kind: KeyKind) => string;

/**
 * 默认 provider：**委托 K03 安全包**的 `DEFAULT_KEY_REFS`——本文件不再写死任何引用字符串。
 * 未注入 provider 且调用方未显式给 `keyRef` 时使用。
 */
export const DEFAULT_KEY_REF_PROVIDER: KeyRefProvider = (kind: KeyKind): string => DEFAULT_KEY_REFS[kind];

/** `buildModelRequest` 的第二参：可注入的 keyRef 来源。 */
export interface BuildModelRequestOptions {
  /** 缺省 `DEFAULT_KEY_REF_PROVIDER`（即 K03 `DEFAULT_KEY_REFS`）。 */
  readonly keyRefProvider?: KeyRefProvider;
}

/** 归一 `keyKind`：缺省 `model`；非法值按 `invalid_key_ref` 拒。 */
function resolveKeyKind(value: unknown): KeyKind {
  if (value === undefined) {
    return 'model';
  }
  if (!isKeyKind(value)) {
    throw new ModelPortError(
      'invalid_key_ref',
      `keyKind 只允许 model / meituan，收到 ${JSON.stringify(value)}（密钥种类词表由 K03 定义）`,
    );
  }
  return value;
}

/**
 * 解析本次请求要用的 `keyRef`：
 * - 调用方**显式**给了 `keyRef` ⇒ 原样走双重判据；
 * - 否则向注入的 `provider` 索取（默认 K03 `DEFAULT_KEY_REFS`），**再**走同一双重判据。
 *
 * 两条路径共用 `normalizeKeyRef`，所以"引用里裹明文"或任意自造字符串在任何来源下都会被拒。
 */
function resolveKeyRef(explicit: unknown, kindValue: unknown, provider: KeyRefProvider): string {
  if (explicit !== undefined) {
    return normalizeKeyRef(explicit);
  }
  const kind = resolveKeyKind(kindValue);
  let ref: string;
  try {
    ref = provider(kind);
  } catch (error) {
    // provider 抛错（例如 KeyManager 清单不可读）⇒ 如实拒，绝不用兜底引用"顶上"。
    throw new ModelPortError('invalid_key_ref', `keyRef provider 未能给出 ${kind} 的引用：${describeError(error)}`);
  }
  return normalizeKeyRef(ref);
}

function normalizeModel(input: unknown): string {
  if (input === undefined) {
    return DEFAULT_MODEL;
  }
  const model = requireNonEmptyString(input, 'model', 'invalid_model');
  if (!MODEL_NAME_PATTERN.test(model)) {
    throw new ModelPortError('invalid_model', `model 不符合契约 pattern ^[A-Za-z0-9][A-Za-z0-9._:-]*$：${JSON.stringify(model)}`);
  }
  return model;
}

// ---------------------------------------------------------------------------
// 预算：估算与准入
// ---------------------------------------------------------------------------

/**
 * **粗略**估算本次请求的最小 token 下界（prompt 粗估 + 至少 1 个 completion）。
 *
 * 字符数 / 4 + 每条消息固定开销 + 工具声明序列化长度 / 4。
 * 这是**启发式**，不是分词器（见文件头"未做"）；它只服务于"预算明显不够就别发"这一条，
 * 不作为计费或截断依据。
 */
export function estimateMinTokens(request: Pick<ModelPortRequest, 'messages' | 'toolSchemas'>): number {
  let chars = 0;
  for (const message of request.messages) {
    chars += (message.content?.length ?? 0) + (message.name?.length ?? 0) + 12;
  }
  for (const tool of request.toolSchemas) {
    chars += tool.name.length + (tool.description?.length ?? 0) + JSON.stringify(tool.parameters).length;
  }
  const prompt = Math.ceil(chars / CHARS_PER_TOKEN) + request.messages.length * PER_MESSAGE_OVERHEAD;
  return prompt + 1;
}

/**
 * 预算是否够**开始**这次调用。不够就抛 `budget_insufficient`（同步拒，不发请求）。
 *
 * 三条判定：
 * - `timeoutMs === 0` ⇒ 一点时间都不给，拒绝（诚实：这种调用必然立刻超时）；
 * - `maxCostMicros === 0` ⇒ 一分钱都不给，拒绝；
 * - `maxTokens < estimateMinTokens()` ⇒ 预算低于估算下界，拒绝。
 */
export function assertBudgetAdmissible(budget: Budget, minTokens: number): void {
  if (budget.timeoutMs === 0) {
    throw new ModelPortError('budget_insufficient', 'budget.timeoutMs 为 0：没有等待上游的时间');
  }
  if (budget.maxCostMicros === 0) {
    throw new ModelPortError('budget_insufficient', 'budget.maxCostMicros 为 0：没有可用成本额度');
  }
  if (budget.maxTokens !== undefined && budget.maxTokens < minTokens) {
    throw new ModelPortError(
      'budget_insufficient',
      `budget.maxTokens=${budget.maxTokens} 低于本次请求的估算下界 ${minTokens}（粗估，非分词）：拒绝发出`,
    );
  }
}

// ---------------------------------------------------------------------------
// 请求构造
// ---------------------------------------------------------------------------

/**
 * `buildModelRequest` 的入参：相对契约输入，**`keyRef` 可省**——省略时向注入的
 * `keyRefProvider` 索取（默认 K03 `DEFAULT_KEY_REFS`），并可指定 `keyKind`。
 *
 * 这是 K03 集成请求的落点：宿主注入 `(kind) => keyManager.status(kind).keyRef`，调用方就
 * 不必再手写 `keyref:...`。显式给 `keyRef` 仍被支持（优先级最高），且两条路径共用同一双重判据。
 */
export interface ModelPortBuildInput extends Omit<ModelPortRequestInput, 'keyRef'> {
  /** 显式引用；省略时向 `keyRefProvider` 索取。 */
  readonly keyRef?: string;
  /** 缺省 `model`。仅在未显式给 `keyRef` 时用于向 provider 索取。 */
  readonly keyKind?: KeyKind;
}

/**
 * 由调用方输入构造**完整**契约请求。
 *
 * 默认值：`model` → `deepseek-flash`；`toolSchemas` → `[]`；`stream` → `true`；
 * `cancellation` → `DEFAULT_CANCELLATION`；`keyRef` → provider（默认 K03 `DEFAULT_KEY_REFS`）。
 * **`budget` 没有默认值**——见 README。
 */
export function buildModelRequest(
  input: ModelPortBuildInput,
  options: BuildModelRequestOptions = {},
): ModelPortRequest {
  const messages = normalizeMessages(input.messages);
  const toolSchemas = normalizeToolSchemas(input.toolSchemas ?? []);
  const cancellation = normalizeCancellation(input.cancellation ?? DEFAULT_CANCELLATION);
  const budget = normalizeBudget(input.budget);
  const keyRef = resolveKeyRef(input.keyRef, input.keyKind, options.keyRefProvider ?? DEFAULT_KEY_REF_PROVIDER);
  const model = normalizeModel(input.model);
  assertBudgetAdmissible(budget, estimateMinTokens({ messages, toolSchemas }));

  let metadata: Readonly<Record<string, unknown>> | undefined;
  if (input.metadata !== undefined) {
    metadata = Object.freeze({ ...asRecord(input.metadata, 'metadata') });
  }
  if (input.stream !== undefined && typeof input.stream !== 'boolean') {
    throw new ModelPortError('invalid_request', 'stream 必须是布尔');
  }

  return Object.freeze({
    messages,
    toolSchemas,
    cancellation,
    budget,
    keyRef,
    model,
    stream: input.stream ?? true,
    ...(metadata === undefined ? {} : { metadata }),
  });
}

/** 对**已是契约形状**的请求做同一套校验（防御式：端口不假设调用方用了 `buildModelRequest`）。 */
export function validateModelRequest(request: unknown): ModelPortRequest {
  const obj = asRecord(request, 'request');
  rejectUnknownKeys(obj, REQUEST_KEYS, 'request');
  const messages = normalizeMessages(obj['messages']);
  const toolSchemas = normalizeToolSchemas(obj['toolSchemas'] ?? []);
  const cancellation = normalizeCancellation(obj['cancellation']);
  const budget = normalizeBudget(obj['budget']);
  const keyRef = normalizeKeyRef(obj['keyRef']);
  const model = normalizeModel(obj['model']);
  assertBudgetAdmissible(budget, estimateMinTokens({ messages, toolSchemas }));
  if (obj['stream'] !== undefined && typeof obj['stream'] !== 'boolean') {
    throw new ModelPortError('invalid_request', 'stream 必须是布尔');
  }
  let metadata: Readonly<Record<string, unknown>> | undefined;
  if (obj['metadata'] !== undefined) {
    metadata = Object.freeze({ ...asRecord(obj['metadata'], 'metadata') });
  }
  return Object.freeze({
    messages,
    toolSchemas,
    cancellation,
    budget,
    keyRef,
    model,
    stream: typeof obj['stream'] === 'boolean' ? obj['stream'] : true,
    ...(metadata === undefined ? {} : { metadata }),
  });
}

/** 线格式请求体。**没有密钥字段**：密钥以 `keyRef` 引用传递。 */
export function buildWireBody(request: ModelPortRequest): ModelWireBody {
  return Object.freeze({
    model: request.model,
    stream: request.stream ?? true,
    messages: request.messages,
    tools: request.toolSchemas,
    ...(request.budget.maxTokens === undefined ? {} : { max_tokens: request.budget.maxTokens }),
  });
}

// ---------------------------------------------------------------------------
// 竞速：值 / 超时 / 取消 / 抛错
// ---------------------------------------------------------------------------

type RaceStep<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'throw'; readonly error: unknown };

function raceWait<T>(
  timers: TimerPort,
  timeoutMs: number | null,
  handle: CancellationHandle,
  promise: Promise<T>,
): Promise<RaceStep<T>> {
  return new Promise<RaceStep<T>>((resolve) => {
    let settled = false;
    let timer: TimerHandle | null = null;
    let unsubscribe: Unsubscribe | null = null;
    const finish = (step: RaceStep<T>): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        timers.clearTimeout(timer);
      }
      if (unsubscribe !== null) {
        unsubscribe();
      }
      resolve(step);
    };
    if (handle.isCancelled()) {
      finish({ kind: 'cancelled' });
      return;
    }
    if (timeoutMs !== null) {
      timer = timers.setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    }
    unsubscribe = handle.onCancel(() => finish({ kind: 'cancelled' }));
    promise.then(
      (value) => finish({ kind: 'value', value }),
      (error: unknown) => finish({ kind: 'throw', error }),
    );
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function errorChunk(code: ModelPortErrorCode, message: string): StreamChunk {
  return Object.freeze({ type: 'error', error: Object.freeze({ code: streamCodeFor(code), message }), done: true });
}

// ---------------------------------------------------------------------------
// usage 归一
// ---------------------------------------------------------------------------

function normalizeUsage(raw: { promptTokens: number; completionTokens: number; totalTokens?: number }): Usage {
  const promptTokens = requireNonNegativeInteger(raw.promptTokens, 'usage.promptTokens', 'usage_inconsistent');
  const completionTokens = requireNonNegativeInteger(raw.completionTokens, 'usage.completionTokens', 'usage_inconsistent');
  const sum = promptTokens + completionTokens;
  if (raw.totalTokens !== undefined) {
    const totalTokens = requireNonNegativeInteger(raw.totalTokens, 'usage.totalTokens', 'usage_inconsistent');
    if (totalTokens !== sum) {
      throw new ModelPortError(
        'usage_inconsistent',
        `usage.totalTokens=${totalTokens} 与 promptTokens+completionTokens=${sum} 不一致：记账不接受自相矛盾的数字`,
      );
    }
    return Object.freeze({ promptTokens, completionTokens, totalTokens });
  }
  return Object.freeze({ promptTokens, completionTokens, totalTokens: sum });
}

// ---------------------------------------------------------------------------
// tool-call 映射
// ---------------------------------------------------------------------------

type ToolCallMapping =
  | { readonly kind: 'ok'; readonly chunk: StreamChunk }
  | { readonly kind: 'error'; readonly code: ModelPortErrorCode; readonly message: string };

/**
 * 把上游 `tool-call` 映射成契约片段。
 *
 * **缺 `toolCallId` 一律拒**——契约 `$defs.toolResult` 的说明是"工具结果必须带与调用 ID
 * 对应的 toolCallId"；没有 ID 的调用，其结果无处对应，只能拒。
 * `arguments` 缺省（合法：无参工具）归一为 `{}`；**出现但不是对象**则拒。
 */
export function mapToolCallEvent(raw: {
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly arguments?: unknown;
}): ToolCallMapping {
  const id = raw.toolCallId;
  if (typeof id !== 'string' || id.length === 0) {
    return {
      kind: 'error',
      code: 'tool_call_missing_id',
      message: 'tool-call 片段缺 toolCallId：工具结果无法与调用对应，拒绝该次运行',
    };
  }
  if (!TOOL_CALL_ID_PATTERN.test(id)) {
    return {
      kind: 'error',
      code: 'invalid_tool_call',
      message: `toolCallId 不符合契约 pattern ^[A-Za-z0-9_.:-]+$：${JSON.stringify(id)}`,
    };
  }
  const toolName = raw.toolName;
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return { kind: 'error', code: 'invalid_tool_call', message: 'tool-call 片段缺 toolName（或为空）' };
  }
  let args: Readonly<Record<string, unknown>>;
  if (raw.arguments === undefined) {
    args = Object.freeze({});
  } else if (typeof raw.arguments === 'object' && raw.arguments !== null && !Array.isArray(raw.arguments)) {
    args = Object.freeze({ ...(raw.arguments as Record<string, unknown>) });
  } else {
    return { kind: 'error', code: 'invalid_tool_call', message: 'tool-call 片段的 arguments 必须是对象' };
  }
  return {
    kind: 'ok',
    chunk: Object.freeze({ type: 'tool-call', toolCallId: id, toolName, arguments: args, done: false }),
  };
}

// ---------------------------------------------------------------------------
// 流式映射
// ---------------------------------------------------------------------------

/** 端口内部依赖。 */
export interface ModelPortContext {
  readonly transport: ModelTransport;
  readonly host: string;
  readonly clock: Clock;
  readonly timers: TimerPort;
}

export interface ModelStreamOptions {
  readonly cancellation?: CancellationSource;
  /**
   * 每收到一个 `tool-call` 片段就调用一次（工具循环在这里执行工具）。
   * 抛错 ⇒ 本次运行以 `tool_execution_failed` 失败（**该次执行仍已记账**，
   * 重试不得再执行一遍——见 `tools.ts`）。
   */
  readonly onToolCall?: (call: ToolCall) => unknown | Promise<unknown>;
}

/**
 * 流式映射：把上游原始事件翻译成契约片段，并在终止处给出**如实的**终结片段。
 *
 * 收束语义：
 * - 上游 `done` ⇒ 最后一个内容片段带 `done: true`；若整条流没有任何内容片段，
 *   产出一条 `{type:'text', text:'', done:true}` 作为**终止标记**（空增量，不是内容）。
 * - 上游 `error` / 非 2xx / 断流 / 超时 / 取消 / 期限到 / 预算超支 ⇒ **先产出一条
 *   `{type:'error', done:true}` 再收束**。
 */
export async function* streamModel(
  ctx: ModelPortContext,
  request: ModelPortRequest,
  options: ModelStreamOptions = {},
): AsyncGenerator<StreamChunk, void, undefined> {
  // ⓪ 请求形状（防御式重校验；端口不假设调用方一定用了 buildModelRequest）
  let validated: ModelPortRequest;
  try {
    validated = validateModelRequest(request);
  } catch (error) {
    const code = isModelPortError(error) ? error.code : 'invalid_request';
    yield errorChunk(code, describeError(error));
    return;
  }

  const handle = toCancellationHandle(options.cancellation ?? validated.cancellation);
  const timeoutMs = validated.budget.timeoutMs ?? null;
  const deadlineMs = validated.cancellation.deadlineMs ?? null;
  const startedAt = ctx.clock.now();

  let pending: StreamChunk | null = null;
  let index = 0;

  /** 收束：先冲掉挂起片段，再产出一条 error 终结片段。 */
  const terminate = (code: ModelPortErrorCode, message: string): StreamChunk[] => {
    const out: StreamChunk[] = [];
    if (pending !== null) {
      out.push(pending);
      pending = null;
    }
    out.push(errorChunk(code, message));
    return out;
  };

  // ① 发出前的取消 / 期限检查
  if (handle.isCancelled()) {
    for (const chunk of terminate('cancelled', `取消令牌 ${handle.token} 在发出前已置位`)) {
      yield chunk;
    }
    return;
  }
  if (deadlineMs !== null && ctx.clock.now() - startedAt >= deadlineMs) {
    for (const chunk of terminate('deadline_exceeded', `cancellation.deadlineMs=${deadlineMs} 已到`)) {
      yield chunk;
    }
    return;
  }

  // ② 发送（同样受超时与取消约束）
  const wire: TransportRequest = Object.freeze({
    host: ctx.host,
    model: validated.model,
    keyRef: validated.keyRef,
    body: buildWireBody(validated),
    timeoutMs,
  });
  const sendStep = await raceWait(ctx.timers, timeoutMs, handle, ctx.transport.send(wire));
  if (sendStep.kind === 'cancelled') {
    for (const chunk of terminate('cancelled', '发送期间被取消')) {
      yield chunk;
    }
    return;
  }
  if (sendStep.kind === 'timeout') {
    for (const chunk of terminate('timeout', `等待上游响应超过 budget.timeoutMs=${String(timeoutMs)}`)) {
      yield chunk;
    }
    return;
  }
  if (sendStep.kind === 'throw') {
    for (const chunk of terminate('stream_failed', `transport 发送失败：${describeError(sendStep.error)}`)) {
      yield chunk;
    }
    return;
  }

  // ③ 非 2xx：**不消费响应体**，保证 401/429 连一条内容片段都不产出
  const response = sendStep.value;
  if (response.status < 200 || response.status >= 300) {
    const code: ModelPortErrorCode =
      response.status === 401 ? 'unauthorized' : response.status === 429 ? 'rate_limited' : 'upstream_error';
    for (const chunk of terminate(code, `上游返回 HTTP ${response.status}（未消费响应体）`)) {
      yield chunk;
    }
    return;
  }

  // ④ 事件循环
  const iterator = response.events[Symbol.asyncIterator]();
  const flushPending = (): StreamChunk | null => {
    const held = pending;
    pending = null;
    return held;
  };

  try {
    for (;;) {
      if (handle.isCancelled()) {
        for (const chunk of terminate('cancelled', '流中途被取消')) {
          yield chunk;
        }
        return;
      }
      if (deadlineMs !== null && ctx.clock.now() - startedAt >= deadlineMs) {
        for (const chunk of terminate('deadline_exceeded', `cancellation.deadlineMs=${deadlineMs} 已到`)) {
          yield chunk;
        }
        return;
      }

      const step = await raceWait(ctx.timers, timeoutMs, handle, iterator.next());
      if (step.kind === 'cancelled') {
        for (const chunk of terminate('cancelled', '等待上游事件时被取消')) {
          yield chunk;
        }
        return;
      }
      if (step.kind === 'timeout') {
        for (const chunk of terminate('timeout', `上游静默超过 budget.timeoutMs=${String(timeoutMs)}`)) {
          yield chunk;
        }
        return;
      }
      if (step.kind === 'throw') {
        for (const chunk of terminate('stream_failed', `上游事件流出错：${describeError(step.error)}`)) {
          yield chunk;
        }
        return;
      }
      const next = step.value;
      if (next.done === true) {
        // 迭代结束但**从未收到 `done` 事件** = 断流：内容不完整，绝不判成功。
        for (const chunk of terminate('stream_truncated', '上游事件流在收到 done 之前结束（断流）')) {
          yield chunk;
        }
        return;
      }

      const raw: RawStreamEvent = next.value;
      if (raw.kind === 'done') {
        const held = flushPending();
        yield held === null ? Object.freeze({ type: 'text', text: '', done: true }) : Object.freeze({ ...held, done: true });
        return;
      }
      if (raw.kind === 'error') {
        const held = flushPending();
        if (held !== null) {
          yield held;
        }
        yield Object.freeze({ type: 'error', error: Object.freeze({ code: raw.code, message: raw.message }), done: true });
        return;
      }
      if (raw.kind === 'text') {
        const held = flushPending();
        if (held !== null) {
          yield held;
        }
        pending = Object.freeze({ type: 'text', text: raw.text, index, done: false });
        index += 1;
        continue;
      }
      if (raw.kind === 'tool-call') {
        const mapping = mapToolCallEvent(raw);
        if (mapping.kind === 'error') {
          for (const chunk of terminate(mapping.code, mapping.message)) {
            yield chunk;
          }
          return;
        }
        const held = flushPending();
        if (held !== null) {
          yield held;
        }
        pending = mapping.chunk;
        index += 1;
        continue;
      }
      // raw.kind === 'usage'
      let usage: Usage;
      try {
        usage = normalizeUsage(raw);
      } catch (error) {
        const code = isModelPortError(error) ? error.code : 'usage_inconsistent';
        for (const chunk of terminate(code, describeError(error))) {
          yield chunk;
        }
        return;
      }
      const held = flushPending();
      if (held !== null) {
        yield held;
      }
      // usage 是**真实用量**，先如实产出；超预算再以失败收束（用量不被抹掉）
      yield Object.freeze({ type: 'usage', usage, done: false });
      const total = usage.totalTokens ?? usage.promptTokens + usage.completionTokens;
      if (validated.budget.maxTokens !== undefined && total > validated.budget.maxTokens) {
        for (const chunk of terminate(
          'budget_exceeded',
          `实际用量 ${total} token 超过 budget.maxTokens=${validated.budget.maxTokens}`,
        )) {
          yield chunk;
        }
        return;
      }
    }
  } finally {
    // 关闭上游是**尽力而为**，绝不能 await 它：
    // 上游若卡在一个永不 settle 的 await 上（典型：SSE 连接半死），
    // `iterator.return()` 会一直挂着不返回。若这里 `await`，超时/取消虽然已经产出了
    // error 片段，`run()` 却永远回不到调用方——"超时不得成功"就退化成"超时也回不来"。
    // 所以只发起关闭、挂一个 catch 防止 unhandled rejection，不等它。
    const close = iterator.return;
    if (typeof close === 'function') {
      try {
        const maybe = close.call(iterator, undefined) as unknown;
        if (maybe !== undefined && maybe !== null && typeof (maybe as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(maybe).catch(() => undefined);
        }
      } catch {
        // 同步抛错同样不影响已经给出的结论。
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 一次运行的结果
// ---------------------------------------------------------------------------

/**
 * 一次模型调用的如实结局。
 *
 * `status === 'succeeded'` **当且仅当** `completed === true && error === null`。
 * `completed` 表示**上游正常收束**（收到 `done` 且无错），断流/超时/取消一律 false。
 */
export interface ModelRunOutcome {
  readonly status: ModelOutcomeStatus;
  readonly model: string;
  readonly host: string;
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: Usage | null;
  readonly error: StreamError | null;
  readonly completed: boolean;
  readonly chunks: readonly StreamChunk[];
  /** 脱敏记录：只有 model / host / usage / failureReason。 */
  readonly record: ModelCallRecord;
}

/** 机器判据：只有**正常收束且无错**才能声称成功。 */
export function mayClaimModelSuccess(outcome: ModelRunOutcome): boolean {
  return outcome.status === 'succeeded' && outcome.completed && outcome.error === null;
}

/** 想声称成功却没成功 ⇒ 抛。上层"拿不到结果就当成功"的写法会在这里红。 */
export function assertModelSucceeded(outcome: ModelRunOutcome): void {
  if (!mayClaimModelSuccess(outcome)) {
    throw new ModelPortError(
      'invalid_request',
      `本次模型调用未成功（status=${outcome.status}，completed=${String(outcome.completed)}，error=${outcome.error?.code ?? 'null'}）：不得当作成功使用`,
    );
  }
}

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

export interface ModelPortConfig {
  readonly transport: ModelTransport;
  /** 上游主机名（只用于线格式与脱敏记录；本包不连接它）。缺省 `DEFAULT_HOST`。 */
  readonly host?: string;
  readonly clock?: Clock;
  readonly timers?: TimerPort;
  /**
   * `keyRef` 来源。缺省 `DEFAULT_KEY_REF_PROVIDER`（K03 `DEFAULT_KEY_REFS`）。
   * 宿主可注入 `(kind) => keyManager.status(kind).keyRef` 以取活跃密钥的引用。
   */
  readonly keyRefProvider?: KeyRefProvider;
}

export interface ModelPort {
  readonly host: string;
  readonly transportIdentity: string;
  buildRequest(input: ModelPortBuildInput): ModelPortRequest;
  stream(request: ModelPortRequest, options?: ModelStreamOptions): AsyncGenerator<StreamChunk, void, undefined>;
  run(request: ModelPortRequest, options?: ModelStreamOptions): Promise<ModelRunOutcome>;
}

export function createModelPort(config: ModelPortConfig): ModelPort {
  if (config.transport === undefined || config.transport === null) {
    throw new ModelPortError('missing_transport', '没有装配 transport：缺上游时不得产出任何"成功"');
  }
  const ctx: ModelPortContext = Object.freeze({
    transport: config.transport,
    host: config.host ?? DEFAULT_HOST,
    clock: config.clock ?? systemClock,
    timers: config.timers ?? systemTimers,
  });

  const stream = (
    request: ModelPortRequest,
    options: ModelStreamOptions = {},
  ): AsyncGenerator<StreamChunk, void, undefined> => streamModel(ctx, request, options);

  async function run(request: ModelPortRequest, options: ModelStreamOptions = {}): Promise<ModelRunOutcome> {
    const chunks: StreamChunk[] = [];
    const toolCalls: ToolCall[] = [];
    let text = '';
    let usage: Usage | null = null;
    let error: StreamError | null = null;
    let completed = false;
    let toolFailure: StreamError | null = null;

    for await (const chunk of streamModel(ctx, request, options)) {
      chunks.push(chunk);
      if (chunk.type === 'text') {
        text += chunk.text;
      } else if (chunk.type === 'tool-call') {
        const call: ToolCall = Object.freeze({
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          arguments: chunk.arguments,
        });
        toolCalls.push(call);
        if (options.onToolCall !== undefined) {
          try {
            await options.onToolCall(call);
          } catch (toolError) {
            toolFailure = Object.freeze({
              code: streamCodeFor('tool_execution_failed'),
              message: describeError(toolError),
            });
          }
        }
      } else if (chunk.type === 'usage') {
        usage = chunk.usage;
      } else {
        error = chunk.error;
      }
      // 只有**非 error** 的 `done` 才算正常收束（error 片段也带 done:true，不能算）。
      if (chunk.type !== 'error' && chunk.done === true) {
        completed = true;
      }
      if (toolFailure !== null) {
        break;
      }
    }

    if (toolFailure !== null) {
      error = toolFailure;
      completed = false;
      chunks.push(Object.freeze({ type: 'error', error: toolFailure, done: true }));
    }
    if (error === null && !completed) {
      // 兜底：流没有以终结标记收束（例如未来改动让生成器提前返回）。
      error = Object.freeze({
        code: TRUNCATED_STREAM_CODE,
        message: '事件流未以终结标记收束（防御性兜底）：不得当作成功',
      });
    }

    const status: ModelOutcomeStatus = error === null ? 'succeeded' : error.code === CANCELLED_STREAM_CODE ? 'cancelled' : 'failed';
    const model = typeof request?.model === 'string' ? request.model : DEFAULT_MODEL;

    return Object.freeze({
      status,
      model,
      host: ctx.host,
      text,
      toolCalls: Object.freeze(toolCalls),
      usage,
      error,
      completed: completed && error === null,
      chunks: Object.freeze(chunks),
      record: redactCallRecord({ model, host: ctx.host, usage, error }),
    });
  }

  // 端口绑定的请求构造：把本端口的 keyRef 来源（缺省委托 K03 安全包）注入进去，
  // 于是 `port.buildRequest({ messages, budget })` 就能在没有手写 keyRef 的情况下拿到引用。
  const buildRequest = (input: ModelPortBuildInput): ModelPortRequest =>
    buildModelRequest(input, { keyRefProvider: config.keyRefProvider ?? DEFAULT_KEY_REF_PROVIDER });

  return Object.freeze({
    host: ctx.host,
    transportIdentity: ctx.transport.identity,
    buildRequest,
    stream,
    run,
  });
}

/** 便捷：工具结果 → 契约 `$defs.toolResult`（只做形状，不做配对；配对见 `tools.ts`）。 */
export function toToolResult(toolCallId: string, result: unknown, isError = false): ToolResult {
  return Object.freeze({ toolCallId, result, isError });
}

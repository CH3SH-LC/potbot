/**
 * K02 模型端口 —— **契约形状类型与常量**（零依赖、纯类型）。
 *
 * 契约来源：`contracts/mobile-v1/schemas/model-port.schema.json` 与
 * `contracts/mobile-v1/types.ts`（手工同步镜像）。本文件的类型名与 schema 字段名**逐字对齐**，
 * 但**不是**从 schema 生成的：schema 才是权威，本文件是给六线实现用的编译期提示。
 *
 * ## 契约里被本模块当成硬约束读到的四条
 *
 * 1. 根对象 `additionalProperties: false` ⇒ 本模块对每一层都拒绝未知键（不是"忽略"）。
 * 2. `keyRef` 的 pattern 是 `^keyref:[A-Za-z0-9._:-]+$` ⇒ 明文密钥在结构上就进不来。
 * 3. `$defs.toolResult` 的说明是"工具结果必须带与调用 ID 对应的 toolCallId" ⇒
 *    本模块的 `ToolActionLedger` 把"对应"做成机器判据，不靠约定。
 * 4. `$defs.streamChunk` 的 `allOf/oneOf` ⇒ 每种 `type` 有各自的必需载荷；本模块的映射
 *    逐类型构造，绝不用"凑一个满足 required 的形状"的方式绕过。
 */

// ---------------------------------------------------------------------------
// 契约常量（逐字取自 schema）
// ---------------------------------------------------------------------------

/** `$defs.role.enum`。 */
export const CHAT_ROLES = ['system', 'user', 'assistant', 'tool'] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

/** `$defs.streamChunk.properties.type.enum`。 */
export const STREAM_CHUNK_TYPES = ['text', 'tool-call', 'usage', 'error'] as const;
export type StreamChunkType = (typeof STREAM_CHUNK_TYPES)[number];

/**
 * **本 App 固定使用的模型**（用户 2026-10-03 要求：App 使用 `deepseek-flash`）。
 * `buildModelRequest()` 在调用方未指定 `model` 时填入它；调用方**可以**显式覆盖，
 * 但必须满足契约 `$defs.modelName` 的 pattern。
 */
export const DEFAULT_MODEL = 'deepseek-flash';

/** `$defs.keyRef.pattern`。 */
export const KEY_REF_PATTERN = /^keyref:[A-Za-z0-9._:-]+$/;

/** `$defs.toolCallId.pattern`。 */
export const TOOL_CALL_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/** `$defs.modelName.pattern`。 */
export const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

// ---------------------------------------------------------------------------
// 契约类型
// ---------------------------------------------------------------------------

/** `$defs.message`。 */
export interface ChatMessage {
  readonly role: ChatRole;
  readonly content?: string;
  readonly name?: string;
  readonly toolCallId?: string;
}

/** `$defs.toolSchema`。 */
export interface ToolSchema {
  readonly name: string;
  readonly description?: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** `$defs.cancellation`。 */
export interface Cancellation {
  readonly token: string;
  readonly cancelled?: boolean;
  /** 相对期限：自本次流开始起允许的最长毫秒数（0 = 立即到期）。 */
  readonly deadlineMs?: number;
}

/** `$defs.budget`。`anyOf` 要求三项至少出现一项。 */
export interface Budget {
  /**
   * 本次调用允许的 **prompt + completion** 总 token 上限。
   * 调用前的估算下界与流内实际用量都按这个口径比较（见 `estimateMinTokens`）。
   */
  readonly maxTokens?: number;
  /** 本次调用允许的**最高**成本（微元）。本模块只做"够不够开始"的静态判定，不做汇率换算。 */
  readonly maxCostMicros?: number;
  /** 等待上游事件的**静默上限**（毫秒）。0 = 不给任何时间 ⇒ 直接拒。 */
  readonly timeoutMs?: number;
}

/** `$defs.usage`。 */
export interface Usage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens?: number;
}

/** `$defs.toolCall`。 */
export interface ToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** `$defs.toolResult`。`toolCallId` 必须与某次调用对应。 */
export interface ToolResult {
  readonly toolCallId: string;
  readonly result: unknown;
  readonly isError?: boolean;
}

/** `$defs.streamError`。 */
export interface StreamError {
  readonly code: string;
  readonly message: string;
}

/** `$defs.streamChunk` 的四个分支。 */
export type StreamChunk =
  | { readonly type: 'text'; readonly text: string; readonly index?: number; readonly done?: boolean }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly done?: boolean;
    }
  | { readonly type: 'usage'; readonly usage: Usage; readonly done?: boolean }
  | { readonly type: 'error'; readonly error: StreamError; readonly done?: boolean };

/**
 * 端口请求（契约根对象）。
 *
 * 与 `contracts/mobile-v1/types.ts` 的 `ModelPortRequest` 同形；`stream` 默认 true
 * （本 App 全程走流式，非流式只是契约允许的退化形态，本包不额外实现第二条路径）。
 */
export interface ModelPortRequest {
  readonly messages: readonly ChatMessage[];
  readonly toolSchemas: readonly ToolSchema[];
  readonly cancellation: Cancellation;
  readonly budget: Budget;
  /** **只是引用**，绝不携带密钥明文（schema pattern 强制）。 */
  readonly keyRef: string;
  readonly model: string;
  readonly stream?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** `buildModelRequest()` 的入参：契约根对象里由端口补默认值的部分可以缺省。 */
export interface ModelPortRequestInput {
  readonly messages: readonly ChatMessage[];
  readonly keyRef: string;
  /** 缺省 `[]`。 */
  readonly toolSchemas?: readonly ToolSchema[];
  /** 缺省 `{ token: 'cancel:default', cancelled: false }`。 */
  readonly cancellation?: Cancellation;
  /** **必需**：不给预算就不发请求（见 README「为什么 budget 没有默认值」）。 */
  readonly budget: Budget;
  /** 缺省 `deepseek-flash`（`DEFAULT_MODEL`）。 */
  readonly model?: string;
  /** 缺省 `true`。 */
  readonly stream?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// 传输层（本模块自有的、**不是**契约的一部分）
// ---------------------------------------------------------------------------

/**
 * 上游流上的一条**原始事件**。
 *
 * 它是"供应商形状"，与契约的 `streamChunk` **不是**同一个东西：映射（`streamModel`）才负责
 * 把前者翻译成后者，并在翻译中做校验。`toolCallId` 刻意是可选的——真实供应商确实会漏发它，
 * 而"缺 ID 必须拒"正是本包的一条反例。
 */
export type RawStreamEvent =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'tool-call';
      readonly toolCallId?: string;
      readonly toolName?: string;
      readonly arguments?: unknown;
    }
  | {
      readonly kind: 'usage';
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly totalTokens?: number;
    }
  | { readonly kind: 'error'; readonly code: string; readonly message: string }
  /** 上游正常收束。**缺了它 = 断流**。 */
  | { readonly kind: 'done' };

/** 发给 transport 的线格式请求体。**不含任何密钥字段**——密钥以 `keyRef` 引用传递。 */
export interface ModelWireBody {
  readonly model: string;
  readonly stream: boolean;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolSchema[];
  readonly max_tokens?: number;
}

/** transport 层的一次调用参数。 */
export interface TransportRequest {
  readonly host: string;
  readonly model: string;
  /** 只是引用（`keyref:...`）。真实 HTTPS 实现应据此向密钥库取用，**不得**回写进日志。 */
  readonly keyRef: string;
  readonly body: ModelWireBody;
  readonly timeoutMs: number | null;
}

/** transport 层的响应：HTTP 状态 + 上游事件流。 */
export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly events: AsyncIterable<RawStreamEvent>;
}

/**
 * 可注入的传输端口。
 *
 * **真实 HTTPS 留给后续包**（见 README「未做」）：本包只定义端口，并提供一个脚本化假
 * transport 用于测试。任何"已接通 deepseek"的说法都必须另有真机/真实网络证据。
 */
export interface ModelTransport {
  readonly identity: string;
  send(request: TransportRequest): Promise<TransportResponse>;
}

// ---------------------------------------------------------------------------
// 运行结果（本模块自有）
// ---------------------------------------------------------------------------

/** 一次模型调用的**如实**结局。`succeeded` 是唯一可以往下传递内容的取值。 */
export type ModelOutcomeStatus = 'succeeded' | 'failed' | 'cancelled';

/** 与 `apps/mobile-kernel/actions/errors.ts` 同名的纪律：只有 `succeeded` 能声称成功。 */
export const SUCCESS_STATUSES = ['succeeded'] as const;

/**
 * 脱敏后的调用记录。
 *
 * **只有四个字段**：`model` / `host` / `usage` / `failureReason`。
 * 没有 messages、没有 keyRef、没有请求体、没有响应体 —— 结构上就没有密钥或用户内容的落点。
 */
export interface ModelCallRecord {
  readonly model: string;
  readonly host: string;
  readonly usage: Usage | null;
  readonly failureReason: string | null;
}

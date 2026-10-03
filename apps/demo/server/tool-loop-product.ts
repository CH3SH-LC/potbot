/**
 * **工具循环的产品运行路径**（KRN-04 接线；工作包 FA-KRN-TOOL-LOOP-PRODUCT）。
 *
 * ## 这一件修的是什么
 *
 * `src/scheduler/{constrained-response,tool-loop,loop-limits,member-collab}.ts`（KRN-04）
 * 已在 main，但**只有自己的测试引用**——典型"仅测试可达"：内核里写好的受约束解析、
 * 请求-回执配对、循环硬上限，产品运行路径上一次都走不到。本模块把它接到
 * `/api/tool-loop/**` 上，**只调用 KRN-04 的既有函数**，不在这里重写任何判定口径
 * （解析、上限、结局、`real_executor` 判定全部来自内核，产品层不可能与内核分叉）。
 *
 * ## 端点
 *
 * | 端点 | 语义 |
 * |---|---|
 * | `GET  /api/tool-loop/status` | 就绪视图：模型端口 / 工具执行器 / 工具目录 / 上限 / 状态码映射 |
 * | `POST /api/tool-loop/parse`  | 受约束解析（**无副作用**）：喂一段模型输出，得到"接受"或**结构化拒绝** |
 * | `POST /api/tool-loop/run`    | 真跑一次工具循环：真实模型端口 + 真实工具执行器 + 硬上限闸门 |
 *
 * ## 六条纪律（都落在代码路径上；反向对照见同名 `.test.ts`）
 *
 * 1. **真实模型端口**：`/run` 的模型端口由装配处用 `createRealExecutor()`（`apps/demo/model/executor.ts`）
 *    注入，经 {@link createModelTurnPortFromExecutor} 适配成 KRN-04 的 `ModelTurnPort`。
 *    **本模块不含任何"内置假执行器"**：端口缺失 ⇒ 循环 `not_ready`（503），不用桩顶替。
 * 2. **受约束解析、不猜**：模型输出一律经 `parseConstrainedResponse()`。散文夹 JSON ⇒
 *    `free_text_not_action`；以 `{` 开头但 JSON 非法 ⇒ `malformed_json`；未知工具 ⇒
 *    `unknown_tool`。**都返回结构化拒绝**（`accepted:false` / `executed:false`），
 *    **不执行任何工具、不把自由文本当工具调用**。
 * 3. **回执闸门**：工具回执缺失（`null` / 抛错 / `call_id` 对不上）⇒ 循环 `receipt_missing`，
 *    **不再请求下一轮**；工具报错则**如实回喂**给模型并计入 `tool_errors`（结局 `degraded: true`）。
 * 4. **循环上限**：三项上限必须显式给全（`validateLoopLimitSpec`，缺项抛错），
 *    并有**硬顶** `TOOL_LOOP_LIMIT_CAPS` 防止这个端点变成烧额度的入口。到顶 ⇒
 *    `budget_exhausted` + **部分结果 + 原因**，`limits.complete_claimed` 是**字面量 `false`**。
 * 5. **假执行器不得冒充**：`real_executor` 由 KRN-04 按两个端口的自述判定；
 *    `/run` 的响应原样透出 `real_executor` / `evidence_grade` / `verified_with_real_executor`，
 *    并额外附上**本轮真实模型调用的次数与逐次结果**（`model_calls`）。
 * 6. **真实调用如实记账**：模型端口逐次记录"是否发出真实请求、结果、错误码"，
 *    不把失败写成成功，也不把没调的写成调过。
 *
 * ## 工具（真实动作，不是桩）
 *
 * 两个工具都落在**真实 `DocumentPort`**（`apps/demo/documents/port.ts`）上：写盘 → **回读核对**
 * 摘要 → 才回执。因此工具执行器的 `real_executor` 为 `true` 是**可核对**的：
 * 响应里的 `sha256` / `byteLength` 来自盘上字节，产物文件确实存在于产物根目录。
 *
 * > ⚠️ 诚实边界：本模块证明"循环在产品路径上真跑、工具真写盘、闸门真拦"。它**不**证明
 * > 模型端一定给出合规 JSON——那由模型端口逐次的 `model_calls` 记录如实呈现。
 * > 客户端取消（HTTP 断开 → abort）**未接线**：`cancelled` 结局在产品路径上当前不可达。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { ValidationError } from '../../../src/protocol/index.js';
import {
  DOCX_MAX_BODY_CHARS,
  DOCX_MAX_BODY_PARAGRAPHS,
  DOCX_MIN_BODY_PARAGRAPHS,
  DOCX_TITLE_BODY_PRESENTATION,
  buildDocxTemplate,
} from '../../../src/artifacts/templates/docx.js';
import {
  DEFAULT_EXECUTOR_BUDGET,
  type ExecutorBudget,
  type ExecutorMessage,
  type RealExecutor,
} from '../model/executor.js';
import { isModelCallError } from '../model/errors.js';
import {
  DocumentPortError,
  normalizeDocxFilename,
  sha256Hex,
  type DocumentPort,
} from '../documents/port.js';
import {
  createToolCatalog,
  describeResponseRejection,
  parseConstrainedResponse,
  type ConstrainedResponseOutcome,
  type ToolCatalog,
  type ToolSpec,
} from '../../../src/scheduler/constrained-response.js';
import {
  createToolLoop,
  type ModelTurnInput,
  type ModelTurnOutput,
  type ModelTurnPort,
  type ToolCallRequest,
  type ToolExecutorPort,
  type ToolLoopResult,
  type ToolLoopStatus,
  type ToolReceipt,
} from '../../../src/scheduler/tool-loop.js';
import {
  DEFAULT_LOOP_LIMIT_SPEC,
  createLoopLimitGate,
  validateLoopLimitSpec,
  type LoopLimitSpec,
} from '../../../src/scheduler/loop-limits.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const TOOL_LOOP_ROOT = '/api/tool-loop';

/** 工具名（**声明与执行同一处定义**，不会分叉）。 */
export const TOOL_WRITE_DOCUMENT = 'doc.write';
export const TOOL_READ_DOCUMENT = 'doc.read';

/** 默认上限：**显式常量**，不静默套（KRN-04 的纪律：没有上限的循环不是合法配置）。 */
export const TOOL_LOOP_DEFAULT_LIMITS: LoopLimitSpec = DEFAULT_LOOP_LIMIT_SPEC;

/**
 * 上限**硬顶**：这个端点是给"一次有界的工具循环"用的，不是无限烧额度的入口。
 * 请求里给的上限超过它 ⇒ 400 `limit_exceeds_cap`（**不静默夹到硬顶**——静默夹会让调用方
 * 以为自己拿到的是自己申请的那个上限）。
 */
export const TOOL_LOOP_LIMIT_CAPS: LoopLimitSpec = Object.freeze({
  max_turns: 8,
  max_tool_calls: 16,
  max_time: 64,
});

/** 工具执行器的名字（出现在 `/run` 响应的 `executor` 字段）。 */
export const DOCUMENT_TOOL_EXECUTOR_NAME = 'document-port-executor';

/** 请求体上限（与 `http.ts` 同口径：64 KiB）。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 工具循环的结局 → HTTP 状态（**在 `/status` 里如实公布**，不藏在代码里）。 */
export const TOOL_LOOP_RUN_HTTP: Readonly<Record<ToolLoopStatus, number>> = Object.freeze({
  answered: 200,
  malformed_response: 422,
  unavailable_tool: 422,
  receipt_missing: 409,
  tool_failed: 502,
  budget_exhausted: 429,
  cancelled: 409,
  not_ready: 503,
});

// ---------------------------------------------------------------------------
// 工具目录
// ---------------------------------------------------------------------------

/** 参数名白名单（`artifact_id` 要当路径段用，先在工具层收窄一次，端口是第二道）。 */
const SAFE_ARTIFACT_ID = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;

/**
 * 本产品路径上可用的工具集合（**封闭**：目录之外的工具名一律 `unknown_tool`）。
 *
 * 与 `conversation-host.ts` 的 `create_word_document` 是**不同的一件东西**：
 * 那条链是"对话 → 完整文档（标题 + 2–4 段 + 来源登记）"，这条链是"工具循环 → 产物文件"。
 * 二者都落在同一个真实产物根上，互不覆盖（artifact id 由各自命名空间决定）。
 */
export function createDocumentToolCatalog(): ToolCatalog {
  const tools: readonly ToolSpec[] = [
    {
      tool_id: TOOL_WRITE_DOCUMENT,
      summary: '把标题与正文写成一份真实的 Word 文档并落盘（写盘后回读核对摘要才回执）',
      parameters: [
        {
          name: 'artifact_id',
          type: 'string',
          required: true,
          description: '产物标识；同一标识重复写入且内容不同会被端口拒绝（不覆盖已交付字节）',
        },
        { name: 'title', type: 'string', required: true, description: '文档标题' },
        {
          name: 'body',
          type: 'string',
          required: true,
          description: `正文；用换行分隔段落，${String(DOCX_MIN_BODY_PARAGRAPHS)}–${String(DOCX_MAX_BODY_PARAGRAPHS)} 段、共不超过 ${String(DOCX_MAX_BODY_CHARS)} 字，正文里不要出现阿拉伯数字`,
        },
      ],
    },
    {
      tool_id: TOOL_READ_DOCUMENT,
      summary: '读回一份已交付文档的盘上字节与摘要（**反映磁盘现状**，不是记忆里的字节）',
      parameters: [
        { name: 'artifact_id', type: 'string', required: true, description: '要读回的产物标识' },
      ],
    },
  ];
  return createToolCatalog(tools);
}

// ---------------------------------------------------------------------------
// 真实工具执行器（落在 DocumentPort 上）
// ---------------------------------------------------------------------------

export interface DocumentToolExecutorOptions {
  /** 真实 DOCX 物化端口（写盘 + 回读核对）。**没有它就不构造执行器**（不假装配）。 */
  readonly documents: DocumentPort;
  /** 回执里的时间戳来源（默认墙钟；只在 `apps/**` 用）。 */
  readonly now?: (() => Date) | undefined;
}

function toolFailure(call: ToolCallRequest, code: string, detail: string): ToolReceipt {
  return Object.freeze({
    call_id: call.call_id,
    ok: false as const,
    content: `工具 ${call.tool} 执行失败（${code}）：${detail}`,
    error: Object.freeze({ code, detail, fatal: false }),
  });
}

function stringArgument(call: ToolCallRequest, name: string): string | null {
  const value = call.arguments[name];
  return typeof value === 'string' ? value : null;
}

/**
 * 真实工具执行器：**真的写盘、真的回读**。
 *
 * 三类失败都收敛成**结构化回执**（`ok:false` + 具名 `code`），因而会被工具循环
 * **回喂给模型**（不吞、不推进）：
 * - `invalid_artifact_id` —— 标识不在白名单（含路径穿越企图）；
 * - `invalid_body` —— 段数 / 字数不在合同范围内；
 * - `document_build_rejected` —— 模板链拒绝（例如正文出现无来源的阿拉伯数字）；
 * - `document_port_*` —— 端口的结构化失败（`existing_mismatch` / `write_failed` …）。
 *
 * 未知工具名 ⇒ 返回 `null` = **回执缺失**（循环据此停止推进，不当作成功）。
 */
export function createDocumentToolExecutor(options: DocumentToolExecutorOptions): ToolExecutorPort {
  const documents = options.documents;
  const now = options.now ?? (() => new Date());

  return {
    name: DOCUMENT_TOOL_EXECUTOR_NAME,
    // 自述为真实执行器：它真的落在文件系统上，且回执里的摘要来自**回读的盘上字节**。
    real_executor: true,

    async invoke(call: ToolCallRequest): Promise<ToolReceipt | null> {
      if (call.tool !== TOOL_WRITE_DOCUMENT && call.tool !== TOOL_READ_DOCUMENT) {
        // 没有这个工具的处理能力 ⇒ 无回执（**不**编一个"大概成功"）。
        return null;
      }

      const artifactId = stringArgument(call, 'artifact_id');
      if (artifactId === null || artifactId.length > 64 || !SAFE_ARTIFACT_ID.test(artifactId)) {
        return toolFailure(
          call,
          'invalid_artifact_id',
          `artifact_id 必须是字母/数字/. _ - 组成且不超过 64 个字符（收到 ${JSON.stringify(artifactId)}）`,
        );
      }

      if (call.tool === TOOL_READ_DOCUMENT) {
        return readDocument(call, artifactId);
      }
      return writeDocument(call, artifactId);
    },
  };

  async function readDocument(call: ToolCallRequest, artifactId: string): Promise<ToolReceipt> {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await documents.readBack(artifactId, 'docx');
    } catch (error) {
      const failure = describePortFailure(error);
      return toolFailure(call, failure.code, failure.detail);
    }
    if (bytes === undefined) {
      // "盘上没有这份产物" —— 是**如实结果**，不是错误：回执成功 + 内容说明 not_found。
      return Object.freeze({
        call_id: call.call_id,
        ok: true as const,
        content: JSON.stringify({ ok: true, artifact_id: artifactId, found: false, note: '盘上没有这份产物' }),
      });
    }
    return Object.freeze({
      call_id: call.call_id,
      ok: true as const,
      content: JSON.stringify({
        ok: true,
        artifact_id: artifactId,
        found: true,
        sha256: sha256Hex(bytes),
        byteLength: bytes.byteLength,
        read_at: now().toISOString(),
        note: '摘要来自**本次回读的盘上字节**，不是进程内记忆。',
      }),
    });
  }

  async function writeDocument(call: ToolCallRequest, artifactId: string): Promise<ToolReceipt> {
    const title = stringArgument(call, 'title')?.trim() ?? '';
    const body = stringArgument(call, 'body') ?? '';
    if (title.length === 0) {
      return toolFailure(call, 'invalid_title', '标题不能为空');
    }
    const paragraphs = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (paragraphs.length < DOCX_MIN_BODY_PARAGRAPHS || paragraphs.length > DOCX_MAX_BODY_PARAGRAPHS) {
      return toolFailure(
        call,
        'invalid_body',
        `正文必须是 ${String(DOCX_MIN_BODY_PARAGRAPHS)}–${String(DOCX_MAX_BODY_PARAGRAPHS)} 段（按换行分段），收到 ${String(paragraphs.length)} 段`,
      );
    }

    let bytes: Uint8Array;
    try {
      const built = buildDocxTemplate({
        requirement: {
          title,
          description: paragraphs.join('\n'),
          paragraphs,
          presentation: DOCX_TITLE_BODY_PRESENTATION,
        },
        // 本链**不登记来源事实**：模板的"无来源数字"约束因此照常生效——
        // 模型写了阿拉伯数字就会被拒（真实的失败，如实回喂）。
        fact_snapshot: [],
        references: [],
      });
      bytes = built.bytes;
    } catch (error) {
      return toolFailure(call, 'document_build_rejected', describeError(error));
    }

    const expectedSha256 = sha256Hex(bytes);
    const filename = normalizeDocxFilename(title, artifactId);
    let receipt: { readonly path: string; readonly sha256: string; readonly byteLength: number };
    try {
      receipt = await documents.materialize({
        artifactId,
        filename,
        bytes,
        expectedSha256,
        format: 'docx',
      });
    } catch (error) {
      const failure = describePortFailure(error);
      return toolFailure(call, failure.code, failure.detail);
    }

    // 回读复核：回执里的摘要必须是**盘上现在这一份**——端口已经核对过一次，
    // 这里再核一次，是为了让"工具回执"与"盘上字节"在产品层也钉在一起。
    let readBack: Uint8Array | undefined;
    try {
      readBack = await documents.readBack(artifactId, 'docx');
    } catch (error) {
      const failure = describePortFailure(error);
      return toolFailure(call, failure.code, failure.detail);
    }
    if (readBack === undefined) {
      return toolFailure(call, 'readback_missing', '写盘回执拿到了，但回读不到字节：不得据此宣称交付');
    }
    const actual = sha256Hex(readBack);
    if (actual !== receipt.sha256) {
      return toolFailure(
        call,
        'readback_digest_mismatch',
        `回读摘要 ${actual.slice(0, 12)}… 与回执 ${receipt.sha256.slice(0, 12)}… 不符：盘上字节可能已被换过`,
      );
    }

    return Object.freeze({
      call_id: call.call_id,
      ok: true as const,
      content: JSON.stringify({
        ok: true,
        artifact_id: artifactId,
        filename,
        path: receipt.path,
        sha256: actual,
        byteLength: readBack.byteLength,
        written_at: now().toISOString(),
        note: '已真实写盘并回读核对；用户可在产物目录取回这一份字节。',
      }),
    });
  }
}

function describePortFailure(error: unknown): { readonly code: string; readonly detail: string } {
  if (error instanceof DocumentPortError) {
    return { code: `document_port_${error.code}`, detail: error.message };
  }
  return { code: 'document_port_error', detail: describeError(error) };
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// ---------------------------------------------------------------------------
// 模型端口（真实执行器的适配器）
// ---------------------------------------------------------------------------

/** 逐次模型调用的**如实记录**（成功与失败都记；不含密钥，只有元数据与结果）。 */
export interface ModelCallRecord {
  readonly step: number;
  readonly at: string;
  /** 底层执行器这一轮**是否返回了结果**（不是"回答是否合规"）。 */
  readonly ok: boolean;
  /** 返回的正文长度（失败时为 0）。 */
  readonly raw_chars: number;
  readonly error_code: string | null;
  readonly error_detail: string | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
}

/**
 * **一次运行**的模型调用视图。
 *
 * 为什么不是"读一个累计数组"：装配处的端口活在整个进程里，累计数组会把**上几次请求**的
 * 调用也算进这一次，于是"本轮发出了几次真实请求"就成了一句不准确的话。这里用
 * **游标**切出本次运行的那一段（`mark()` 在跑之前取，`since(mark)` 在跑之后取）。
 */
export interface ModelCallLog {
  mark(): number;
  since(mark: number): readonly ModelCallRecord[];
}

export interface InstrumentedModelPort {
  readonly port: ModelTurnPort;
  /** 本次运行的调用记录视图（游标式）。 */
  readonly log: ModelCallLog;
  /** 到目前为止的**全部**调用记录（供本进程内的核对，不用于"本轮"口径）。 */
  snapshot(): readonly ModelCallRecord[];
}

export interface ModelTurnPortOptions {
  /**
   * **如实声明**底层执行器是不是真实执行器。
   *
   * 只有 `createRealExecutor()` 的产物才可以传 `true`；`createFakeExecutor()` 的产物
   * 必须传 `false`（传 `true` 会被本函数**拒绝**，见下）。
   */
  readonly real_executor: boolean;
  /** 传给 KRN-04 的模型端口要声明自己是哪一家（默认取底层执行器的 provider）。 */
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly taskId?: string | undefined;
  readonly conversationId?: string | undefined;
  /** 单次请求的输出 token 上限（默认 `DEFAULT_EXECUTOR_BUDGET.maxOutputTokens`）。 */
  readonly maxOutputTokens?: number | undefined;
  /** 每次请求可用的输出上限不得低于它要跑的循环上限（由调用方按 run 传入）。 */
  readonly now?: (() => Date) | undefined;
}

/**
 * 把 `apps/demo/model/executor.ts` 的 `RealExecutor` 适配成 KRN-04 的 `ModelTurnPort`。
 *
 * **为什么在文本信封上走受约束解析，而不是用原生 tool-calling**：R222 要求"模型输出
 * 绝不直接执行"，而原生 tool-calling 的结构由上游代理给出、绕过了 B 端的策略校验；
 * 文本信封经 `parseConstrainedResponse()` 之后，工具名、参数、多余字段全部过一遍
 * 封闭目录的校验，判据只有一份。因此这里传 `tools: []`，把目录写进系统提示。
 */
export function createModelTurnPortFromExecutor(
  executor: RealExecutor,
  catalog: ToolCatalog,
  options: ModelTurnPortOptions,
): InstrumentedModelPort {
  if (options.real_executor && executor.provider === 'fake-scripted') {
    throw new ValidationError(
      '`createFakeExecutor()` 的产物不得声明 real_executor: true：假 Agent 不得冒充真实执行器（R224）',
    );
  }
  const now = options.now ?? (() => new Date());
  const taskId = options.taskId ?? 'T-tool-loop';
  const conversationId = options.conversationId ?? 'tool-loop';
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_EXECUTOR_BUDGET.maxOutputTokens;
  const systemPrompt = buildToolLoopSystemPrompt(catalog);
  const records: ModelCallRecord[] = [];

  const port: ModelTurnPort = {
    provider: options.provider ?? executor.provider,
    model: options.model ?? executor.model,
    // **不自作主张**：逐字采用装配处的声明。
    real_executor: options.real_executor,

    async nextTurn(input: ModelTurnInput): Promise<ModelTurnOutput> {
      // 记录里的 `step` 用**循环给的**步号（每次运行从 1 起），不是端口自己的累计计数：
      // 后者会把不同运行混在一个序列里。
      const step = input.step;
      // 取消信号：KRN-04 允许 `null`（= 不取消），而执行器要求一个真 AbortSignal。
      // 桥接是**单向**的：外层取消 ⇒ 内层取消；本适配器自己从不主动 abort。
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      if (input.signal !== null) {
        if (input.signal.aborted) controller.abort();
        else input.signal.addEventListener('abort', onAbort, { once: true });
      }
      const messages: readonly ExecutorMessage[] = Object.freeze([
        Object.freeze({ role: 'user' as const, text: buildTurnPrompt(input) }),
      ]);
      // 每次只发**一轮**请求：循环的轮次/工具次数由 KRN-04 的闸门管，执行器这边只关心
      // 单次请求的输出上限（`max_tokens` 是硬上限的一部分）。
      const budget: ExecutorBudget = Object.freeze({
        maxTurns: 1,
        maxToolCalls: 0,
        maxOutputTokens,
      });

      try {
        const turn = await executor.runTurn({
          conversationId,
          taskId,
          systemPrompt,
          messages,
          // 空声明：工具目录经系统提示交给模型，执行权始终在受约束解析之后。
          tools: [],
          signal: controller.signal,
          budget,
        });
        records.push(
          Object.freeze({
            step,
            at: now().toISOString(),
            ok: true,
            raw_chars: turn.text.length,
            error_code: null,
            error_detail: null,
            input_tokens: turn.usage.inputTokens,
            output_tokens: turn.usage.outputTokens,
          }),
        );
        return Object.freeze({
          raw: turn.text,
          usage: Object.freeze({
            input_tokens: turn.usage.inputTokens,
            output_tokens: turn.usage.outputTokens,
          }),
        });
      } catch (error) {
        const code = isModelCallError(error) ? error.code : 'model_unclassified_error';
        records.push(
          Object.freeze({
            step,
            at: now().toISOString(),
            ok: false,
            raw_chars: 0,
            error_code: code,
            error_detail: describeError(error),
            input_tokens: null,
            output_tokens: null,
          }),
        );
        // 原样上抛：工具循环把它记成 `malformed_response`（"模型端口抛错"），
        // **不**把它降级成一次"合规回答"。真实原因在 `model_calls.records` 里。
        throw error;
      } finally {
        if (input.signal !== null) input.signal.removeEventListener('abort', onAbort);
      }
    },
  };

  return {
    port,
    log: Object.freeze({
      mark: (): number => records.length,
      since: (mark: number): readonly ModelCallRecord[] =>
        Object.freeze(records.slice(Math.max(0, mark))),
    }),
    snapshot: (): readonly ModelCallRecord[] => Object.freeze([...records]),
  };
}

/** 系统提示：把**封闭目录**与信封格式说清楚，让模型有一次合规的机会。 */
export function buildToolLoopSystemPrompt(catalog: ToolCatalog): string {
  const lines: string[] = [
    '你在一个**受约束的工具循环**里工作。',
    '',
    '输出纪律（违反即被结构化拒绝，本轮什么都不会执行）：',
    '1. 每一轮**只能**输出**一个 JSON 对象**，前后不得有任何其它文字、不得用 Markdown 代码块。',
    '2. 要么是动作：{"kind":"action","tool":"<工具名>","arguments":{...}}',
    '3. 要么是收尾回答：{"kind":"answer","text":"<给用户的说明>"}',
    '4. 工具名必须来自下面的目录；参数名必须与声明一致，不得多、不得少。',
    '',
    '可用工具：',
  ];
  for (const tool of catalog.tools) {
    const parameters = tool.parameters
      .map(
        (parameter) =>
          `    - ${parameter.name}（${parameter.type}${parameter.required ? '，必填' : '，可选'}）：${parameter.description}`,
      )
      .join('\n');
    lines.push(`- ${tool.tool_id}：${tool.summary}`);
    lines.push(parameters);
  }
  lines.push('');
  lines.push('工具的执行由宿主完成，你只负责"提出请求"或"给出收尾回答"。');
  lines.push('工具失败会以结构化结果回喂给你，请据此修正后重试，不要把失败说成成功。');
  return lines.join('\n');
}

/** 每一轮发给模型的那一条用户消息（含**回喂的工具回执**）。导出是为了让测试直接盯住回喂内容。 */
export function buildTurnPrompt(input: ModelTurnInput): string {
  const lines: string[] = [`任务：${input.instructions}`, '', `这是第 ${String(input.step)} 轮。`];
  if (input.observations.length === 0) {
    lines.push('还没有任何工具回执。请给出下一步：调用工具，或直接用 answer 收尾。');
  } else {
    lines.push('上一轮的工具回执如下（成功与失败都在内）：');
    for (const observation of input.observations) {
      const status = observation.ok ? 'ok' : `失败(${observation.error_code ?? 'unknown_error'})`;
      const detail = observation.ok ? observation.content : (observation.error_detail ?? observation.content);
      lines.push(`- ${observation.call_id} ${observation.tool} ${status}：${detail}`);
    }
    lines.push('请据此决定下一步：继续调用工具修正，或直接用 answer 收尾。');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 宿主
// ---------------------------------------------------------------------------

export interface ToolLoopHostOptions {
  /** 模型端口；`null` ⇒ 循环 `not_ready`（**不**用桩顶替）。 */
  readonly modelPort?: ModelTurnPort | null | undefined;
  /** 工具执行器；`null` ⇒ 循环 `not_ready`。 */
  readonly toolExecutor?: ToolExecutorPort | null | undefined;
  /** 工具目录（默认 {@link createDocumentToolCatalog}）。 */
  readonly catalog?: ToolCatalog | undefined;
  /** 默认上限（省略 ⇒ `TOOL_LOOP_DEFAULT_LIMITS`）。 */
  readonly defaultLimits?: LoopLimitSpec | undefined;
  /** 上限硬顶（默认 `TOOL_LOOP_LIMIT_CAPS`）。 */
  readonly limitCaps?: LoopLimitSpec | undefined;
  /** 模型配置的就绪描述（供 `/status` 如实说明"为什么没有模型端口"）。 */
  readonly modelReadiness?: ModelReadiness | null | undefined;
  /**
   * 逐次模型调用记录（由 {@link createModelTurnPortFromExecutor} 的 `log` 提供）。
   *
   * **游标式**：`/run` 只报**本次运行**的调用次数与结果（见 {@link ModelCallLog}）。
   */
  readonly modelCallLog?: ModelCallLog | null | undefined;
  readonly now?: (() => Date) | undefined;
}

/** 模型配置的就绪描述（来自 `apps/demo/model/port.ts` 的 `describeModelConfig`）。 */
export interface ModelReadiness {
  readonly configured: boolean;
  readonly provider: string;
  readonly model: string;
  readonly missing: readonly string[];
}

export interface ToolLoopRunInput {
  readonly instructions: string;
  readonly limits?: unknown;
}

export interface ToolLoopWireResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface ToolLoopRunView extends ToolLoopWireResponse {
  readonly ok: boolean;
}

export interface ToolLoopHost {
  readonly catalog: ToolCatalog;
  readonly modelPort: ModelTurnPort | null;
  readonly toolExecutor: ToolExecutorPort | null;
  status(): Record<string, unknown>;
  /** 受约束解析（无副作用）。 */
  parse(raw: unknown): ToolLoopWireResponse;
  /** 跑一次工具循环。**不抛**（校验失败也返回结构化 400）。 */
  run(input: ToolLoopRunInput): Promise<ToolLoopRunView>;
}

function errorBody(code: string, message: string, retryable = false): Record<string, unknown> {
  return Object.freeze({ code, message, retryable });
}

function describeLimits(limits: LoopLimitSpec): Record<string, unknown> {
  return Object.freeze({
    max_turns: limits.max_turns,
    max_tool_calls: limits.max_tool_calls,
    max_time: limits.max_time,
  });
}

/** 逐字段给"缺哪一项"，**不**把非法上限静默套成默认值。 */
function limitFieldProblems(raw: unknown): readonly string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return Object.freeze([`limits 必须是对象，收到 ${raw === null ? 'null' : typeof raw}`]);
  }
  const record = raw as Record<string, unknown>;
  const problems: string[] = [];
  for (const field of ['max_turns', 'max_tool_calls', 'max_time'] as const) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      problems.push(`缺少 ${field}`);
    }
  }
  return Object.freeze(problems);
}

export function createToolLoopHost(options: ToolLoopHostOptions = {}): ToolLoopHost {
  const catalog = options.catalog ?? createDocumentToolCatalog();
  const modelPort = options.modelPort ?? null;
  const toolExecutor = options.toolExecutor ?? null;
  const defaultLimits = validateLoopLimitSpec(options.defaultLimits ?? TOOL_LOOP_DEFAULT_LIMITS);
  const limitCaps = validateLoopLimitSpec(options.limitCaps ?? TOOL_LOOP_LIMIT_CAPS);
  const modelReadiness = options.modelReadiness ?? null;
  const modelCallLog = options.modelCallLog ?? null;

  const missingPorts = (): readonly string[] =>
    Object.freeze([
      ...(modelPort === null ? ['模型端口（ModelTurnPort）'] : []),
      ...(toolExecutor === null ? ['工具执行器（ToolExecutorPort）'] : []),
    ]);

  return {
    catalog,
    modelPort,
    toolExecutor,

    status(): Record<string, unknown> {
      const missing = missingPorts();
      const notes: string[] = [];
      if (missing.length > 0) {
        notes.push(
          `未就绪：缺少 ${missing.join('、')}——不注入端口就不跑，也不用内置桩顶替`,
        );
      }
      if (modelReadiness !== null && !modelReadiness.configured) {
        notes.push(`模型未配置，缺少：${modelReadiness.missing.join('、')}`);
      }
      const bothReal =
        modelPort !== null && toolExecutor !== null && modelPort.real_executor && toolExecutor.real_executor;
      if (!bothReal) {
        notes.push('**未验证**：至少一个端口自述为非真实执行器，`/run` 的结果不得当作真实执行器证据。');
      }
      return Object.freeze({
        prefix: TOOL_LOOP_ROOT,
        ready: missing.length === 0,
        not_ready_reason: missing.length === 0 ? null : `缺少 ${missing.join('、')}`,
        model:
          modelPort === null
            ? null
            : Object.freeze({
                provider: modelPort.provider,
                model: modelPort.model,
                real_executor: modelPort.real_executor,
                configured: modelReadiness === null ? null : modelReadiness.configured,
                missing: modelReadiness === null ? [] : [...modelReadiness.missing],
              }),
        executor:
          toolExecutor === null
            ? null
            : Object.freeze({ name: toolExecutor.name, real_executor: toolExecutor.real_executor }),
        real_executor: bothReal,
        tools: catalog.tools.map((tool) =>
          Object.freeze({
            tool_id: tool.tool_id,
            summary: tool.summary,
            parameters: tool.parameters.map((parameter) =>
              Object.freeze({
                name: parameter.name,
                type: parameter.type,
                required: parameter.required,
                description: parameter.description,
              }),
            ),
          }),
        ),
        limits: Object.freeze({
          default: describeLimits(defaultLimits),
          caps: describeLimits(limitCaps),
          note: '三项上限必须显式给全；超过硬顶的上限一律 400，不静默夹到硬顶。',
        }),
        endpoints: Object.freeze([
          Object.freeze({ method: 'GET', path: `${TOOL_LOOP_ROOT}/status`, purpose: '就绪视图' }),
          Object.freeze({
            method: 'POST',
            path: `${TOOL_LOOP_ROOT}/parse`,
            purpose: '受约束解析（无副作用；被拒时 422 + 结构化拒绝码）',
          }),
          Object.freeze({
            method: 'POST',
            path: `${TOOL_LOOP_ROOT}/run`,
            purpose: '真跑一次工具循环（真实模型端口 + 真实工具执行器 + 硬上限闸门）',
          }),
        ]),
        run_http_status: Object.freeze({ ...TOOL_LOOP_RUN_HTTP }),
        notes: Object.freeze(notes),
      });
    },

    parse(raw: unknown): ToolLoopWireResponse {
      const outcome: ConstrainedResponseOutcome = parseConstrainedResponse(raw, catalog);
      if (!outcome.ok) {
        return Object.freeze({
          status: 422,
          body: Object.freeze({
            ok: false,
            accepted: false,
            executed: false,
            code: outcome.code,
            rejection: outcome.rejection,
            violation: outcome.violation,
            path: outcome.path,
            detail: outcome.detail,
            label: describeResponseRejection(outcome.code),
            note:
              '结构化拒绝：**未执行任何工具、未猜测意图**，调用方不得把它当作一次成功的解析' +
              '（更不得据此执行自由文本）。',
          }),
        });
      }
      return Object.freeze({
        status: 200,
        body: Object.freeze({
          ok: true,
          accepted: true,
          // 解析成功也**从不**执行：动作只是待执行请求。
          executed: false,
          rejection: null,
          response: outcome.response,
          note: '解析通过（`executed` 恒为 false）：动作仍需由工具循环按"请求-回执"推进。',
        }),
      });
    },

    async run(input: ToolLoopRunInput): Promise<ToolLoopRunView> {
      const instructions = typeof input.instructions === 'string' ? input.instructions.trim() : '';
      if (instructions.length === 0) {
        return Object.freeze({
          ok: false,
          status: 400,
          body: errorBody('invalid_instructions', 'instructions 必须是非空字符串'),
        });
      }

      let limits = defaultLimits;
      if (input.limits !== undefined && input.limits !== null) {
        const missingFields = limitFieldProblems(input.limits);
        if (missingFields.length > 0) {
          return Object.freeze({
            ok: false,
            status: 400,
            body: errorBody(
              'invalid_limits',
              `上限必须显式给全三项（${missingFields.join('；')}）："没有上限"不是合法配置`,
            ),
          });
        }
        try {
          limits = validateLoopLimitSpec(input.limits as LoopLimitSpec);
        } catch (error) {
          return Object.freeze({
            ok: false,
            status: 400,
            body: errorBody('invalid_limits', describeError(error)),
          });
        }
      }
      const overCap: string[] = [];
      for (const field of ['max_turns', 'max_tool_calls', 'max_time'] as const) {
        if (limits[field] > limitCaps[field]) {
          overCap.push(`${field}=${String(limits[field])} > 硬顶 ${String(limitCaps[field])}`);
        }
      }
      if (overCap.length > 0) {
        return Object.freeze({
          ok: false,
          status: 400,
          body: errorBody(
            'limit_exceeds_cap',
            `上限超过硬顶：${overCap.join('、')}。不静默夹到硬顶——请显式给一个不超过硬顶的上限。`,
          ),
        });
      }

      // 本次运行的模型调用游标（跑之前取，跑之后切）。
      const callMark = modelCallLog === null ? 0 : modelCallLog.mark();
      const gate = createLoopLimitGate(limits);
      const loop = createToolLoop({
        catalog,
        limits: gate,
        model: modelPort,
        executor: toolExecutor,
        time_per_step: 1,
      });

      let result: ToolLoopResult;
      try {
        result = await loop.run({
          task_id: 'T-tool-loop-http',
          instructions,
          // 客户端取消**未接线**（见文件头）：不给信号 = 不取消，而不是假装可取消。
          signal: null,
        });
      } catch (error) {
        return Object.freeze({
          ok: false,
          status: 500,
          body: errorBody('tool_loop_internal_error', describeError(error), true),
        });
      }

      const calls = modelCallLog === null ? Object.freeze([] as ModelCallRecord[]) : modelCallLog.since(callMark);
      const failedCalls = calls.filter((record) => !record.ok).length;
      const limitsReport = result.limits;
      const body = Object.freeze({
        status: result.status,
        reason: result.reason,
        answer: result.answer,
        steps: result.steps,
        exchanges: result.exchanges,
        observations: result.observations,
        tool_errors: result.tool_errors,
        degraded: result.degraded,
        partial: result.partial,
        model: result.model,
        executor: result.executor,
        real_executor: result.real_executor,
        evidence_grade: result.evidence_grade,
        verified_with_real_executor: result.verified_with_real_executor,
        limits: limitsReport,
        // 与 `limits.complete_claimed` 同源（KRN-04 的**字面量 false**）：
        // 撞上限 ≠ 完成，任何结局都不得据此宣称交付完整。
        complete_claimed: limitsReport === null ? false : limitsReport.complete_claimed,
        note: result.note,
        model_calls: Object.freeze({
          attempted: calls.length,
          succeeded: calls.length - failedCalls,
          failed: failedCalls,
          records: calls,
          note:
            calls.length === 0
              ? '本轮**未发出任何真实模型请求**（例如端口缺失或首轮闸门未放行）——如实记录，不虚报。'
              : `本轮共发出 ${String(calls.length)} 次模型请求（成功 ${String(calls.length - failedCalls)} 次、失败 ${String(failedCalls)} 次）。`,
        }),
        tool_calls_attempted: result.exchanges.length,
        limits_usage: limitsReport === null ? Object.freeze([]) : limitsReport.usage,
      });

      return Object.freeze({
        ok: result.status === 'answered' && !result.degraded,
        status: TOOL_LOOP_RUN_HTTP[result.status],
        body,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

export type ToolLoopRoute =
  | { readonly kind: 'status' }
  | { readonly kind: 'parse' }
  | { readonly kind: 'run' };

/**
 * 认领 `/api/tool-loop` 命名空间下的三条路径；**其它一律 `null`**
 * （因此 `http.ts` 的 `/api/**` 兜底 404 仍然生效）。
 */
export function matchToolLoopRoute(pathname: string): ToolLoopRoute | null {
  if (pathname === TOOL_LOOP_ROOT || pathname === `${TOOL_LOOP_ROOT}/status`) {
    return { kind: 'status' };
  }
  if (pathname === `${TOOL_LOOP_ROOT}/parse`) {
    return { kind: 'parse' };
  }
  if (pathname === `${TOOL_LOOP_ROOT}/run`) {
    return { kind: 'run' };
  }
  return null;
}

export interface ToolLoopWireRequest {
  readonly method: string;
  readonly pathname: string;
  readonly body: unknown;
}

/**
 * 路由（不碰 `req` / `res`），便于直测。
 *
 * 异步是因为 `/run` 真跑一次循环（含持久化工具调用）；`/status` 与 `/parse` 是同步计算，
 * 但统一在一个入口返回，调用方（含测试）不必记两套形状。
 */
export async function routeToolLoopRequest(
  request: ToolLoopWireRequest,
  host: ToolLoopHost,
): Promise<ToolLoopWireResponse | null> {
  const route = matchToolLoopRoute(request.pathname);
  if (route === null) {
    return null;
  }
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') {
    return null;
  }
  if (route.kind === 'status') {
    if (method !== 'GET' && method !== 'HEAD') {
      return Object.freeze({
        status: 405,
        body: errorBody('method_not_allowed', `${request.pathname} 只接受 GET`),
      });
    }
    return Object.freeze({ status: 200, body: host.status() });
  }
  if (method !== 'POST') {
    return Object.freeze({
      status: 405,
      body: errorBody('method_not_allowed', `${request.pathname} 只接受 POST`),
    });
  }
  const body = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return Object.freeze({
      status: 400,
      body: errorBody('invalid_body', '请求体必须是 JSON 对象，形如 {"instructions": "..."}'),
    });
  }
  const record = body as Record<string, unknown>;

  if (route.kind === 'parse') {
    const raw = record['raw'];
    if (raw === undefined) {
      return Object.freeze({
        status: 400,
        body: errorBody(
          'missing_raw',
          '缺少 raw：请把待解析的**模型原样输出**放进 {"raw": ...}（字符串或对象）',
        ),
      });
    }
    return host.parse(raw);
  }

  const view = await host.run({
    instructions: typeof record['instructions'] === 'string' ? record['instructions'] : '',
    ...(record['limits'] === undefined ? {} : { limits: record['limits'] }),
  });
  return Object.freeze({ status: view.status, body: view.body });
}

export interface ToolLoopHttpInput {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  /** 省略 / `null` ⇒ 用一个"无端口"宿主作答（`/status` 如实未就绪、`/run` 503）。 */
  readonly host?: ToolLoopHost | null;
}

async function readRawBody(req: IncomingMessage): Promise<{ ok: true; raw: string } | { ok: false }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) {
      // 排空剩余数据，让 413 有机会送达（与 `http.ts` 同口径）。
      try {
        for await (const _ of req) void _;
      } catch {
        // 对端提前关闭：不影响我们的拒绝结果。
      }
      return { ok: false };
    }
    chunks.push(buffer);
  }
  return { ok: true, raw: Buffer.concat(chunks).toString('utf8') };
}

function sendJson(res: ServerResponse, status: number, body: unknown, headOnly: boolean): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  if (headOnly) {
    res.end();
    return;
  }
  res.end(text);
}

/**
 * 挂载点（`http.ts` 里**只加一行**）：
 *
 * ```ts
 * if (await handleToolLoopRequest({ req, res, url, host: toolLoopHost })) return;
 * ```
 *
 * 命中即返回 `true`；未命中返回 `false`（请求继续走后面的分支，最终落 `/api/**` 404）。
 */
export async function handleToolLoopRequest(input: ToolLoopHttpInput): Promise<boolean> {
  const pathname = input.url.pathname;
  const route = matchToolLoopRoute(pathname);
  if (route === null) {
    return false;
  }
  const method = (input.req.method ?? 'GET').toUpperCase();
  const headOnly = method === 'HEAD';
  const host = input.host ?? createToolLoopHost({});

  let body: unknown = null;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const raw = await readRawBody(input.req);
    if (!raw.ok) {
      sendJson(
        input.res,
        413,
        errorBody('body_too_large', `请求体超过 ${String(MAX_BODY_BYTES)} 字节上限`),
        headOnly,
      );
      return true;
    }
    if (raw.raw.trim() !== '') {
      try {
        body = JSON.parse(raw.raw);
      } catch {
        sendJson(input.res, 400, errorBody('invalid_json', '请求体不是合法 JSON'), headOnly);
        return true;
      }
    }
  }

  const response = await routeToolLoopRequest({ method, pathname, body }, host);
  if (response === null) {
    return false;
  }
  sendJson(input.res, response.status, response.body, headOnly);
  return true;
}

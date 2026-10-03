/**
 * K02 `ModelPort` 消费层（WF-093–096 的**模型接线**；打包 W08 首个可验证增量）。
 *
 * ## 为什么需要这一层
 *
 * `spelling.ts` / `translation.ts` / `port.ts` 是**模型层**：它们定义"检查/翻译该产出什么、
 * 该挡什么"，但把"谁来做"留给调用方。`port.ts` 把"谁来做"变成一个可注入端口并给出就绪状态——
 * 但它接的是**同步**的 `ProofingChecker` / `TranslatorPort`。真正做检查/翻译的是 K02 的
 * `ModelPort`（异步、流式、带 `cancellation` / `budget` / `keyRef` / `model`）。本模块就是
 * 这两者之间的适配器：**把 K02 的请求/流式片段，接成校对与翻译能力**。
 *
 * ## 契约形状（结构对齐 `contracts/mobile-v1/schemas/model-port.schema.json`）
 *
 * 本文件**本地声明** `ModelPort*` 类型，字段与 K02 契约逐一对齐（`messages` / `toolSchemas` /
 * `cancellation` / `budget` / `keyRef` / `model`；片段 `type ∈ text|tool-call|usage|error`）。
 * 不 import `contracts/` 是有意的（避免把契约目录拖进本包编译范围）；对齐由**编译期结构**保证：
 * 见测试里对 `ModelPortRequest` 的 `satisfies` 断言。
 *
 * ## 三条硬规矩，以及它们在**类型/结构**上的落点
 *
 * | 规矩 | 落点 |
 * |---|---|
 * | **取消/过期不改稿** | `check` 与 `translate…` **都不返回模型**（`check` 返回提示、翻译返回提案）；取消/过期一律 `fail`，调用方手里那份 `DocumentModel` 一个码位都没动 |
 * | **缺模型不得报通过** | `createUnavailableModelProofingPort` 的 `checkWithModel` **结构上产不出** `succeed([])`；模型流里**没有** `report_proofing_issues` 工具调用 ⇒ `no_output` 失败，**不是**"没问题" |
 * | **输出绑选区/revision/预算** | 翻译走 `planTranslationRanges`（同一套校验）；提案带 `base_revision`；模型调用次数 ≤ 预算，token 用量超限即 `budget_exceeded` |
 *
 * ## 时间基准
 *
 * 过期判定**不读墙钟**：`clock` 由调用方注入（K02 契约裁决第 4 条：领域层经注入时钟，
 * 禁止直接读系统时间）。测试由此可确定性地触发"过期"。
 *
 * ## 本轮边界（如实声明）
 *
 * 本模块**不发起真实 HTTPS 请求**，也不实现 K02 端口的宿主（那是 K 线的活）。
 * 它只定义端口形状并落定适配逻辑；测试用**确定性内存端口**驱动，验证层为 `contract`
 * （端口契约层面），**不是** `real-api`。
 */

import type { DocumentModel, Revision } from '../model/types.js';
import { collectParagraphs, paragraphText } from '../selection/structure.js';
import { fail, succeed, type Result, type Selection } from '../selection/types.js';
import { codePointsToText, readCodePoints } from './symbols.js';
import type { IssueKind, ProofingIssue } from './spelling.js';
import type { ProofingReadiness } from './port.js';
import {
  planTranslationRanges,
  type TranslationBudget,
  type TranslationProposal,
  type TranslationSegment,
  type TranslationSource,
} from './translation.js';

// ---------------------------------------------------------------------------
// K02 ModelPort 形状（本地声明；结构对齐 contracts/mobile-v1）
// ---------------------------------------------------------------------------

export type ModelPortChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ModelPortChatMessage {
  readonly role: ModelPortChatRole;
  readonly content?: string;
  readonly name?: string;
  readonly toolCallId?: string;
}

export interface ModelPortToolSchema {
  readonly name: string;
  readonly description?: string;
  readonly parameters: Record<string, unknown>;
}

/** 取消/期限（K02 契约 `$defs.cancellation`）：`cancelled` 或 `deadlineMs` 到期都算失效。 */
export interface ModelPortCancellation {
  readonly token: string;
  readonly cancelled?: boolean;
  /** 绝对期限（注入时钟同一时间基准）；`clock() >= deadlineMs` 视为过期。 */
  readonly deadlineMs?: number;
}

/** 预算（K02 契约 `$defs.budget`）。 */
export interface ModelPortBudget {
  readonly maxTokens?: number;
  readonly maxCostMicros?: number;
  readonly timeoutMs?: number;
}

export interface ModelPortUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens?: number;
}

/** 流式片段（K02 契约 `$defs.streamChunk`）。 */
export type ModelPortStreamChunk =
  | { readonly type: 'text'; readonly text: string; readonly index?: number; readonly done?: boolean }
  | {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly arguments: Record<string, unknown>;
      readonly done?: boolean;
    }
  | { readonly type: 'usage'; readonly usage: ModelPortUsage; readonly done?: boolean }
  | { readonly type: 'error'; readonly error: { readonly code: string; readonly message: string }; readonly done?: boolean };

/** 模型请求（K02 契约 `model-port.schema.json` 的必需字段全在）。 */
export interface ModelPortRequest {
  readonly messages: readonly ModelPortChatMessage[];
  readonly toolSchemas: readonly ModelPortToolSchema[];
  readonly cancellation: ModelPortCancellation;
  readonly budget: ModelPortBudget;
  /** 只能是引用，禁止明文密钥（K02 契约：所有 `*Ref` 都是引用）。 */
  readonly keyRef: `keyref:${string}`;
  readonly model: string;
  readonly stream?: boolean;
  readonly metadata?: Record<string, unknown>;
}

/**
 * 模型端口（K02 由内核实现；本包只消费）。
 *
 * `stream` 返回**完整片段数组**而非异步迭代器——本包只需要"一次调用的全部片段"，
 * 数组在测试里是确定性的、无时序依赖。真实流式聚合由 K02 宿主负责；本层不假设传输方式。
 * 端口抛错由本层捕获并转成 fail-closed 的 `model_error`，**不**冒泡（冒泡会让"模型挂了"
 * 与"文档坏了"在下游难以区分）。
 */
export interface ModelPort {
  /** 提供者身份（非空）——回执要能说清"是谁做的"。 */
  readonly provider: string;
  stream(request: ModelPortRequest): Promise<readonly ModelPortStreamChunk[]>;
}

// ---------------------------------------------------------------------------
// 失败状态（可编程读取，不靠解析 message）
// ---------------------------------------------------------------------------

/**
 * 本次校对/翻译的**结果状态**。落在 `Failure.detail.extra.proofingStatus` 上，
 * 让上层能区分"没做成"的六种原因——尤其 `no_output`（模型没给结果）与"检查过、没问题"。
 */
export type ProofingOutcomeStatus =
  | 'not_ready'
  | 'cancelled'
  | 'expired'
  | 'model_error'
  | 'no_output'
  | 'invalid_model_output'
  | 'budget_exceeded';

function failWith(status: ProofingOutcomeStatus, message: string, extra: Record<string, number | string> = {}) {
  return fail('precondition', message, { extra: { proofingStatus: status, ...extra } });
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

export interface ModelPortProofingConfig {
  readonly port: ModelPort;
  /** 密钥引用（**只能是** `keyref:` 引用；本层绝不接触明文密钥）。 */
  readonly keyRef: string;
  /** 模型名（**非空**；如 `deepseek-flash`）。 */
  readonly model: string;
  /** 注入时钟（毫秒）；缺省 `() => 0`——**不读墙钟**。 */
  readonly clock?: () => number;
}

export interface ModelProofingCheckInput {
  readonly model: DocumentModel;
  /** 只检查这些段落（省略 = 全文）。 */
  readonly paragraph_ids?: readonly string[];
  readonly cancellation: ModelPortCancellation;
  readonly budget?: ModelPortBudget;
}

export interface ModelTranslationBudget extends TranslationBudget {
  readonly maxTokens?: number;
  readonly maxCostMicros?: number;
  readonly timeoutMs?: number;
}

export interface ModelTranslationOptions {
  readonly target_language: string;
  readonly source_language?: string | null;
  readonly cancellation: ModelPortCancellation;
  readonly budget: ModelTranslationBudget;
}

/** K02 接线后的校对/翻译端口（**异步**——与 `port.ts` 的同步 `ProofingPort` 并列，不替换它）。 */
export interface ModelPortProofingPort {
  readonly readiness: ProofingReadiness;
  readonly rule_ids: readonly string[];
  /**
   * 拼写/语法检查。**只读**：返回提示，不返回模型。
   * 取消/过期/模型错误/模型无输出 ⇒ `fail`，**绝不** `succeed([])`。
   */
  checkWithModel(input: ModelProofingCheckInput): Promise<Result<readonly ProofingIssue[]>>;
  /**
   * 选区翻译，产出**提案**（不改文档）。取消/过期/预算不足 ⇒ `fail`，
   * 文档一个码位都没动。提交仍走 `commitTranslation`（绑 revision）。
   */
  translateSelectionWithModel(
    model: DocumentModel,
    selection: Selection,
    options: ModelTranslationOptions,
  ): Promise<Result<TranslationProposal>>;
}

const KEYREF_PATTERN = /^keyref:/;

/** 工具名：模型**必须**用这个工具名回报检查结果，否则视作"没有输出"。 */
export const PROOFING_TOOL_NAME = 'report_proofing_issues';

const CHECK_SYSTEM_PROMPT =
  '你是文档校对器。逐段检查拼写与语法，**只**通过工具 ' +
  PROOFING_TOOL_NAME +
  ' 回报你确实发现的问题（paragraph_id 必须来自输入，start/end 是该段文本的 Unicode 码位偏移）。' +
  '没有任何问题时也要调用该工具并给出空数组 issues——不要用自然语言代替工具调用。';

/** 过期/取消的判定结果（`kind: null` = 仍然有效）。 */
function gateFailure(
  cancellation: ModelPortCancellation,
  clock: () => number,
): { readonly kind: 'cancelled' | 'expired' | null } {
  if (cancellation.cancelled === true) return { kind: 'cancelled' };
  if (cancellation.deadlineMs !== undefined && clock() >= cancellation.deadlineMs) {
    return { kind: 'expired' };
  }
  return { kind: null };
}

function cancellationFailure(
  kind: 'cancelled' | 'expired',
  cancellation: ModelPortCancellation,
  clock: () => number,
  what: string,
) {
  if (kind === 'cancelled') {
    return failWith(
      'cancelled',
      `${what}已取消（token=${cancellation.token}）：取消的模型工作**不得**改动文档，也不得产出结果。`,
      { token: cancellation.token },
    );
  }
  return failWith(
    'expired',
    `${what}已过期（deadlineMs=${String(cancellation.deadlineMs)}，clock=${String(clock())}）：过期结果不得使用。`,
    { token: cancellation.token },
  );
}

function buildRequest(
  config: { readonly keyRef: `keyref:${string}`; readonly model: string; readonly port: ModelPort },
  input: {
    readonly messages: readonly ModelPortChatMessage[];
    readonly toolSchemas: readonly ModelPortToolSchema[];
    readonly cancellation: ModelPortCancellation;
    readonly budget: ModelPortBudget;
    readonly metadata?: Record<string, unknown>;
  },
): ModelPortRequest {
  return {
    messages: input.messages,
    toolSchemas: input.toolSchemas,
    cancellation: input.cancellation,
    budget: input.budget,
    keyRef: config.keyRef,
    model: config.model,
    stream: false,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  };
}

function firstError(chunks: readonly ModelPortStreamChunk[]): { code: string; message: string } | null {
  for (const chunk of chunks) {
    if (chunk.type === 'error') return chunk.error;
  }
  return null;
}

function joinedText(chunks: readonly ModelPortStreamChunk[]): string {
  let text = '';
  for (const chunk of chunks) {
    if (chunk.type === 'text') text += chunk.text;
  }
  return text;
}

function usageTokens(chunks: readonly ModelPortStreamChunk[]): ModelPortUsage | null {
  for (const chunk of chunks) {
    if (chunk.type === 'usage') return chunk.usage;
  }
  return null;
}

function totalOf(usage: ModelPortUsage): number {
  return usage.totalTokens ?? usage.promptTokens + usage.completionTokens;
}

/** 从工具调用参数里解析并**校验**提示；任何一条不可信即整体拒绝。 */
function parseIssues(
  args: Record<string, unknown>,
  allowed: readonly { readonly id: string; readonly text: string; readonly codePointLength: number }[],
  revision: Revision,
): Result<readonly ProofingIssue[]> {
  const raw = args['issues'];
  if (!Array.isArray(raw)) {
    return failWith(
      'invalid_model_output',
      '模型工具调用的 arguments.issues 不是数组；无法把它当作可信的检查结果。',
    );
  }
  const byId = new Map(allowed.map((item) => [item.id, item]));
  const issues: ProofingIssue[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    if (entry === null || typeof entry !== 'object') {
      return failWith('invalid_model_output', `模型结果第 ${String(index)} 条不是对象。`, { index });
    }
    const record = entry as Record<string, unknown>;
    const paragraphId = record['paragraph_id'];
    if (typeof paragraphId !== 'string' || !byId.has(paragraphId)) {
      return failWith(
        'invalid_model_output',
        `模型结果第 ${String(index)} 条的 paragraph_id 不是本次检查的段落：${String(paragraphId)}。`,
        { index },
      );
    }
    const target = byId.get(paragraphId)!;
    const start = record['start'];
    const end = record['end'];
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      (start as number) < 0 ||
      (end as number) < (start as number) ||
      (end as number) > target.codePointLength
    ) {
      return failWith(
        'invalid_model_output',
        `模型结果第 ${String(index)} 条的偏移越界（段 "${paragraphId}" 码位长 ${String(target.codePointLength)}）。`,
        { index },
      );
    }
    const kind = record['kind'];
    if (kind !== 'spelling' && kind !== 'grammar') {
      return failWith('invalid_model_output', `模型结果第 ${String(index)} 条的 kind 非法：${String(kind)}。`, { index });
    }
    const message = record['message'];
    if (typeof message !== 'string' || message.length === 0) {
      return failWith('invalid_model_output', `模型结果第 ${String(index)} 条缺少非空 message。`, { index });
    }
    const suggestionsRaw = record['suggestions'];
    const suggestions: string[] = [];
    if (suggestionsRaw !== undefined) {
      if (!Array.isArray(suggestionsRaw) || !suggestionsRaw.every((item) => typeof item === 'string')) {
        return failWith('invalid_model_output', `模型结果第 ${String(index)} 条的 suggestions 不是字符串数组。`, { index });
      }
      suggestions.push(...(suggestionsRaw as string[]));
    }
    const ruleId = typeof record['rule_id'] === 'string' && record['rule_id'].length > 0 ? (record['rule_id'] as string) : 'model-reported';
    // 定位文本**由文档实读**，不采信模型自报的 text——回执里的 text 必须是真的。
    const located = codePointsToText(readCodePoints(target.text).slice(start as number, end as number));
    issues.push({
      issue_id: `${paragraphId}:${String(start)}:${ruleId}:${String(index)}`,
      rule_id: ruleId,
      kind: kind as IssueKind,
      message,
      suggestions,
      location: { paragraph_id: paragraphId, start: start as number, end: end as number, text: located },
      base_revision: revision,
    });
  }
  return succeed(issues);
}

/**
 * 造一个 **K02 ModelPort 驱动**的校对/翻译端口。
 *
 * 构造期拒绝（**产出任何结果之前**）：
 * 1. `port` 必须存在且 `provider` 非空——说不清是谁做的就不算接了模型；
 * 2. `keyRef` 必须匹配 `^keyref:`——本层**只**接引用，绝不接明文密钥；
 * 3. `model` 必须非空——请求要能说清用哪个模型。
 */
export function createModelPortBackedProofingPort(
  config: ModelPortProofingConfig,
): Result<ModelPortProofingPort> {
  if (config.port === null || config.port === undefined) {
    return fail('precondition', '必须给出 ModelPort 才能构造模型校对端口。');
  }
  const provider = typeof config.port.provider === 'string' ? config.port.provider.trim() : '';
  if (provider.length === 0) {
    return fail('invalid_query', 'ModelPort 的 provider 必须是非空字符串（回执要能说清是谁做的）。');
  }
  if (typeof config.keyRef !== 'string' || !KEYREF_PATTERN.test(config.keyRef)) {
    return fail('invalid_query', 'keyRef 必须形如 "keyref:…"（本层只接引用，绝不接明文密钥）。', {
      extra: { keyRefPrefix: typeof config.keyRef === 'string' ? config.keyRef.slice(0, 7) : String(config.keyRef) },
    });
  }
  if (typeof config.model !== 'string' || config.model.trim().length === 0) {
    return fail('invalid_query', 'model 必须是非空字符串（如 "deepseek-flash"）。');
  }

  const port = config.port;
  const clock = config.clock ?? (() => 0);
  const keyRef = config.keyRef as `keyref:${string}`;
  const model = config.model.trim();
  const bound = { keyRef, model, port };

  const readiness: ProofingReadiness = { status: 'ready', provider, kind: 'model' };

  return succeed({
    readiness,
    rule_ids: [],
    async checkWithModel(input: ModelProofingCheckInput): Promise<Result<readonly ProofingIssue[]>> {
      const pre = gateFailure(input.cancellation, clock);
      if (pre.kind !== null) return cancellationFailure(pre.kind, input.cancellation, clock, '校对');

      const paragraphs = collectParagraphs(input.model.blocks);
      const allowed = paragraphs.map((paragraph) => {
        const points = readCodePoints(paragraphText(paragraph));
        return { id: paragraph.id, text: codePointsToText(points), codePointLength: points.length };
      });
      let selected = allowed;
      if (input.paragraph_ids !== undefined) {
        const wanted = new Set(input.paragraph_ids);
        selected = allowed.filter((item) => wanted.has(item.id));
        const found = new Set(selected.map((item) => item.id));
        const missing = [...wanted].filter((id) => !found.has(id));
        if (missing.length > 0) {
          return fail('unknown_node', `以下段落不存在：${missing.join('、')}`, { extra: { missing: missing.join('、') } });
        }
      }

      const request = buildRequest(bound, {
        messages: [
          { role: 'system', content: CHECK_SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({ paragraphs: selected.map((item) => ({ paragraph_id: item.id, text: item.text })) }),
          },
        ],
        toolSchemas: [
          {
            name: PROOFING_TOOL_NAME,
            description: '回报确实发现的拼写/语法问题；没有问题也要调用并给空数组。',
            parameters: {
              type: 'object',
              required: ['issues'],
              properties: { issues: { type: 'array', items: { type: 'object' } } },
            },
          },
        ],
        cancellation: input.cancellation,
        budget: input.budget ?? {},
        metadata: { document_id: input.model.document_id, revision: input.model.revision },
      });

      let chunks: readonly ModelPortStreamChunk[];
      try {
        chunks = await port.stream(request);
      } catch (error) {
        return failWith('model_error', `模型端口抛错（${provider}）：${String(error)}——不得当作"检查通过"。`, {
          provider,
        });
      }

      const err = firstError(chunks);
      if (err !== null) {
        const status: ProofingOutcomeStatus = err.code === 'cancelled' || err.code === 'aborted' ? 'cancelled' : 'model_error';
        return failWith(status, `模型流返回错误（code=${err.code}）：${err.message}——不得当作"检查通过"。`, {
          provider,
          modelErrorCode: err.code,
        });
      }

      // 取消可能发生在请求在途期间：看到结果前再判一次，取消的结果一律弃用。
      const mid = gateFailure(input.cancellation, clock);
      if (mid.kind !== null) return cancellationFailure(mid.kind, input.cancellation, clock, '校对');

      const usage = usageTokens(chunks);
      const budget = input.budget ?? {};
      if (budget.maxTokens !== undefined && usage !== null && totalOf(usage) > budget.maxTokens) {
        return failWith(
          'budget_exceeded',
          `本次检查 token 用量 ${String(totalOf(usage))} 超过预算 ${String(budget.maxTokens)}。`,
          { tokensUsed: totalOf(usage), maxTokens: budget.maxTokens },
        );
      }

      let toolCall: Extract<ModelPortStreamChunk, { type: 'tool-call' }> | null = null;
      for (const chunk of chunks) {
        if (chunk.type === 'tool-call' && chunk.toolName === PROOFING_TOOL_NAME) toolCall = chunk;
      }
      if (toolCall === null) {
        // 关键反例：模型**没有**给出结构化检查结果 ⇒ 这是"没做成"，**不是**"检查过、没问题"。
        return failWith(
          'no_output',
          `模型流里没有 ${PROOFING_TOOL_NAME} 工具调用（只有 ${joinedText(chunks).length} 个文本码位）：` +
            '缺少结构化结果必须报"未产出"，**不得**当作"0 条提示 = 通过"。',
          { provider, textLength: joinedText(chunks).length },
        );
      }

      const parsed = parseIssues(toolCall.arguments, selected, input.model.revision);
      if (!parsed.ok) return parsed;
      return parsed;
    },

    async translateSelectionWithModel(
      model_: DocumentModel,
      selection: Selection,
      options: ModelTranslationOptions,
    ): Promise<Result<TranslationProposal>> {
      const pre = gateFailure(options.cancellation, clock);
      if (pre.kind !== null) return cancellationFailure(pre.kind, options.cancellation, clock, '翻译');

      const plan = planTranslationRanges(model_, selection, {
        target_language: options.target_language,
        max_model_calls: options.budget.max_model_calls,
        source_language: options.source_language ?? null,
      });
      if (!plan.ok) return plan;

      const segments: TranslationSegment[] = [];
      let calls = 0;
      let tokensUsed = 0;
      for (const item of plan.value.items) {
        const gate = gateFailure(options.cancellation, clock);
        if (gate.kind !== null) return cancellationFailure(gate.kind, options.cancellation, clock, '翻译');
        if (options.budget.maxTokens !== undefined && tokensUsed >= options.budget.maxTokens) {
          return failWith(
            'budget_exceeded',
            `续翻前 token 预算已耗尽（已用 ${String(tokensUsed)}，上限 ${String(options.budget.maxTokens)}）。`,
            { tokensUsed, maxTokens: options.budget.maxTokens },
          );
        }

        const request = buildRequest(bound, {
          messages: [
            { role: 'system', content: `把用户给出的文本翻译成 ${options.target_language}，只输出译文文本本身。` },
            { role: 'user', content: item.source_text },
          ],
          toolSchemas: [],
          cancellation: options.cancellation,
          budget: options.budget,
          metadata: { document_id: model_.document_id, revision: model_.revision, node_id: item.range.node_id },
        });

        let chunks: readonly ModelPortStreamChunk[];
        try {
          chunks = await port.stream(request);
        } catch (error) {
          return failWith('model_error', `模型端口抛错（${provider}）：${String(error)}——翻译未完成，文档未改动。`, {
            provider,
          });
        }
        calls += 1;

        const err = firstError(chunks);
        if (err !== null) {
          const status: ProofingOutcomeStatus = err.code === 'cancelled' || err.code === 'aborted' ? 'cancelled' : 'model_error';
          return failWith(status, `模型流返回错误（code=${err.code}）：${err.message}——翻译未完成，文档未改动。`, {
            provider,
            modelErrorCode: err.code,
          });
        }

        const mid = gateFailure(options.cancellation, clock);
        if (mid.kind !== null) return cancellationFailure(mid.kind, options.cancellation, clock, '翻译');

        const usage = usageTokens(chunks);
        if (usage !== null) tokensUsed += totalOf(usage);
        if (options.budget.maxTokens !== undefined && tokensUsed > options.budget.maxTokens) {
          return failWith(
            'budget_exceeded',
            `本次翻译 token 用量 ${String(tokensUsed)} 超过预算 ${String(options.budget.maxTokens)}。`,
            { tokensUsed, maxTokens: options.budget.maxTokens },
          );
        }

        const translated = joinedText(chunks);
        if (translated.length === 0) {
          return failWith(
            'no_output',
            `模型对范围（${item.range.node_id} @${String(item.range.start)}-${String(item.range.end)}）没有返回任何译文文本；` +
              '不得用原文冒充译文。',
            { node_id: item.range.node_id },
          );
        }
        const source: TranslationSource = {
          kind: 'model',
          detail: `K02 ModelPort：${provider}（model=${model}）`,
        };
        segments.push({
          range: item.range,
          source_text: item.source_text,
          translated_text: translated,
          source,
        });
      }

      return succeed({
        document_id: plan.value.document_id,
        base_revision: plan.value.base_revision,
        target_language: plan.value.target_language,
        source_language: plan.value.source_language,
        segments,
        model_calls: calls,
        budget: { max_model_calls: options.budget.max_model_calls },
      });
    },
  });
}

/**
 * 未接模型时的**默认答案**：一个 `not_ready` 的 K02 端口，两个能力都 `fail`。
 *
 * 它存在的意义与 `createUnavailableProofingPort` 相同，但用于**异步**路径：与其让上层
 * "手里还没模型就先初始化一个空壳"，不如显式拿到一个结构上产不出 `succeed([])` 的端口。
 */
export function createUnavailableModelProofingPort(reason: string): ModelPortProofingPort {
  const why = reason.length > 0 ? reason : '未就绪原因未被说明（原因不明也必须说"原因不明"，不编造）。';
  const unavailable = (what: string) =>
    failWith(
      'not_ready',
      `模型校对/翻译未就绪：${why}（能力：${what}）——不得产出"0 条提示"或原文回显冒充结果。`,
      { capability: what },
    );
  return {
    readiness: { status: 'not_ready', reason: why },
    rule_ids: [],
    checkWithModel: async () => unavailable('spelling'),
    translateSelectionWithModel: async () => unavailable('translation'),
  };
}

/** 一句话回执（就绪状态 / 来源）。 */
export function describeModelPortProofingReadiness(port: ModelPortProofingPort): string {
  if (port.readiness.status === 'not_ready') {
    return `校对/翻译（K02 ModelPort）：未就绪（${port.readiness.reason}）`;
  }
  return `校对/翻译（K02 ModelPort）：就绪，来源 ${port.readiness.provider}`;
}


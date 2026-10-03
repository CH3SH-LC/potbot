/**
 * S4 —— 真实模型端口。
 *
 * 这是 S3（应用宿主）唯一需要依赖的模块。形状**严格**按执行方案给定，
 * 不得擅自加必填字段；额外能力（配置描述、账本）走独立导出。
 *
 * 行为纪律（合同 v1）：
 *  - 超时 45 秒；每任务总尝试至多 2 次；每次输出上限 1600 tokens。
 *  - 响应必须通过结构化校验；不合规抛 `ModelCallError`，**绝不**替换成固定稿。
 *  - 每次发出请求前登记额度，失败与重试均计数；超预算抛结构化错误。
 *  - mock/live 分离：本模块只做 live 调用；fixture 测试走本地假 HTTP 服务器。
 */

import { LIMITS } from '../contracts.js';
import { ModelCallError, isModelCallError, type ModelErrorCode } from './errors.js';
import { LEDGER_FILENAME, ModelBudget, resolveLedgerPath, resolveMaxRequests } from './ledger.js';
import { MODEL_SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';
import { makeSanitizer } from './sanitize.js';
import { callModelOnce, endpointUrl, type ApiShape, type TransportConfig } from './transport.js';
import { validateDraftText } from './validate.js';

export type { ModelErrorCode };
export { ModelCallError, isModelCallError };
export type { ApiShape };
export { endpointUrl };

/**
 * 合同默认输出上限：**1600，不得被静默改掉**。
 * 仅当显式设置 `POTBOT_MODEL_MAX_TOKENS` 为合法正整数时才覆盖（给 thinking 留头寸用）；
 * 空值 / 非法值 / <1 一律回落 1600。
 */
export const MODEL_MAX_TOKENS = 1600;
/** 合同固定值：每任务总尝试次数上限。 */
export const MODEL_MAX_ATTEMPTS = 2;
/** 合同固定值：单次请求超时。 */
export const MODEL_TIMEOUT_MS = 45_000;

export interface DraftParagraphInput {
  readonly id: string;
  readonly text: string;
}

export interface DraftInput {
  readonly title: string;
  readonly paragraphs: readonly DraftParagraphInput[];
}

export interface ModelCallRequest {
  readonly requestId: string;
  readonly taskId: string;
  readonly instruction: string;
}

export interface ModelPort {
  readonly provider: string;
  readonly model: string;
  generateDraft(req: ModelCallRequest): Promise<DraftInput>;
}

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

export interface ModelConfig {
  readonly configured: boolean;
  readonly provider: string;
  readonly model: string;
  readonly baseUrlHost: string;
  readonly authMode: 'auth_token' | 'api_key' | 'none';
  readonly apiShape: ApiShape;
  readonly endpointPath: string;
  readonly timeoutMs: number;
  readonly maxTokens: number;
  /** 传输参数：本进程是否已降级为关闭模型思考。 */
  readonly thinkingDisabled: boolean;
  readonly maxAttempts: number;
  readonly maxRequests: number;
  readonly ledgerPath: string;
  /** 缺什么，就直接说缺什么；用于给用户一条可执行的动作。 */
  readonly missing: readonly string[];
}

interface ParsedBase {
  readonly host: string;
  readonly scheme: string;
}

/**
 * 解析 base URL。**不抛异常**：解析不出来就返回 null，
 * 让调用方把它记成"配置有问题"，而不是让服务起不来。
 */
function parseBaseUrl(baseUrl: string): ParsedBase | null {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.host) return null;
    return { host: url.host, scheme: url.protocol.replace(':', '') };
  } catch {
    return null;
  }
}

function readApiShape(env: NodeJS.ProcessEnv): ApiShape {
  const raw = env.POTBOT_MODEL_API_SHAPE?.trim().toLowerCase();
  return raw === 'openai' ? 'openai' : 'anthropic';
}

function readTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.POTBOT_MODEL_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : MODEL_TIMEOUT_MS;
}

/**
 * 输出上限。合同默认 1600；只有显式给出合法正整数才覆盖。
 */
function readMaxTokens(env: NodeJS.ProcessEnv): number {
  const raw = env.POTBOT_MODEL_MAX_TOKENS?.trim();
  if (!raw) return MODEL_MAX_TOKENS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return MODEL_MAX_TOKENS;
  return Math.floor(parsed);
}

/**
 * `thinking:{type:"disabled"}` 现在是**默认路径**。
 *
 * 理由（实测）：本机模型 `thinking` 与正文**共用 `max_tokens`**，
 * 曾出现「1600 tokens 全被 thinking 吃掉、正文 0 字符」的截断失败。
 * 关掉 thinking 是当前唯一能**确定性**把预算留给正文的手段。
 *
 * 只有显式设 `POTBOT_MODEL_THINKING_DISABLED=0/false/off/no` 才关闭它。
 * 代理若拒绝该参数，传输层会自动回退到不带参数的形态，无需人工干预。
 */
function readThinkingDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.POTBOT_MODEL_THINKING_DISABLED?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false;
  return true;
}

/**
 * 描述当前模型配置。**不读密钥内容**，只判断是否存在。
 * 给 `/health` 的 `modelConfigured` 用；注意它**不等于**实调通过（实调通过看 modelVerified）。
 */
export function describeModelConfig(env: NodeJS.ProcessEnv): ModelConfig {
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim() ?? '';
  const authToken = env.ANTHROPIC_AUTH_TOKEN?.trim() ?? '';
  const apiKey = env.ANTHROPIC_API_KEY?.trim() ?? '';
  const model = env.ANTHROPIC_MODEL?.trim() ?? '';
  const apiShape = readApiShape(env);

  const parsedBase = parseBaseUrl(baseUrl);

  const missing: string[] = [];
  if (!baseUrl) missing.push('ANTHROPIC_BASE_URL');
  else if (!parsedBase) missing.push('ANTHROPIC_BASE_URL（不是可用的 http(s) URL）');
  if (!model) missing.push('ANTHROPIC_MODEL');
  if (!authToken && !apiKey) missing.push('ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY');

  const providerOverride = env.POTBOT_MODEL_PROVIDER?.trim();
  const provider =
    providerOverride && providerOverride.length > 0
      ? providerOverride
      : apiShape === 'anthropic'
        ? 'anthropic_messages'
        : 'openai_chat_completions';

  return {
    configured: missing.length === 0,
    provider,
    model,
    baseUrlHost: parsedBase ? parsedBase.host : '<unparseable>',
    authMode: authToken ? 'auth_token' : apiKey ? 'api_key' : 'none',
    apiShape,
    // 配置不可用时返回空串，而不是编一个假 URL 让 S3 展示出去。
    endpointPath: parsedBase ? endpointUrl(baseUrl, apiShape) : '',
    timeoutMs: readTimeoutMs(env),
    maxTokens: readMaxTokens(env),
    thinkingDisabled: readThinkingDisabled(env),
    maxAttempts: MODEL_MAX_ATTEMPTS,
    maxRequests: resolveMaxRequests(env),
    ledgerPath: resolveLedgerPath(env),
    missing,
  };
}

/* ------------------------------------------------------------------ *
 * 端口实现
 * ------------------------------------------------------------------ */

/** 同一账本的额度在同一进程内共享，避免一个进程建多个端口各开一份预算。 */
const budgetCache = new Map<string, ModelBudget>();

function budgetFor(env: NodeJS.ProcessEnv): ModelBudget {
  const ledgerPath = resolveLedgerPath(env);
  const cached = budgetCache.get(ledgerPath);
  if (cached) return cached;
  const budget = new ModelBudget({ ledgerPath, maxRequests: resolveMaxRequests(env) });
  budgetCache.set(ledgerPath, budget);
  return budget;
}

/** 仅供测试：清空进程内额度缓存（不清账本文件）。 */
export function __resetBudgetCacheForTests(): void {
  budgetCache.clear();
}

/**
 * 建立模型端口。**未配置时抛出**（`model_not_configured`，不可重试），
 * 由宿主决定如何向用户呈现，而不是返回一个"永远失败"的端口。
 */
export function createModelPort(env: NodeJS.ProcessEnv): ModelPort {
  const description = describeModelConfig(env);
  if (!description.configured) {
    throw new ModelCallError(
      'model_not_configured',
      `模型未配置，缺少：${description.missing.join('、')}`,
      false,
    );
  }

  const authToken = env.ANTHROPIC_AUTH_TOKEN?.trim() ?? '';
  const apiKey = env.ANTHROPIC_API_KEY?.trim() ?? '';
  const transport: TransportConfig = {
    baseUrl: env.ANTHROPIC_BASE_URL?.trim() ?? '',
    model: description.model,
    apiShape: description.apiShape,
    authToken: authToken || undefined,
    apiKey: apiKey || undefined,
    timeoutMs: description.timeoutMs,
    maxTokens: description.maxTokens,
    thinkingDisabled: description.thinkingDisabled,
  };
  const secrets = [authToken, apiKey];
  const sanitize = makeSanitizer(secrets);
  const budget = budgetFor(env);
  const endpoint = endpointUrl(transport.baseUrl, transport.apiShape);

  return {
    provider: description.provider,
    model: description.model,

    async generateDraft(req: ModelCallRequest): Promise<DraftInput> {
      const instruction = typeof req.instruction === 'string' ? req.instruction.trim() : '';
      if (!instruction) {
        throw new ModelCallError('model_request_rejected', '写作要求为空，未调用模型', false);
      }
      if (instruction.length > LIMITS.maxInstructionChars) {
        throw new ModelCallError(
          'model_request_rejected',
          `写作要求 ${instruction.length} 字，超过合同上限 ${LIMITS.maxInstructionChars} 字`,
          false,
        );
      }

      const systemPrompt = MODEL_SYSTEM_PROMPT;
      const userPrompt = buildUserPrompt(instruction);
      const promptChars = systemPrompt.length + userPrompt.length;

      let lastRetryable: ModelCallError | null = null;

      for (let attempt = 1; attempt <= MODEL_MAX_ATTEMPTS; attempt += 1) {
        const startedAt = new Date().toISOString();
        const startedMs = Date.now();

        let outputChars = 0;
        let recorded = false;
        // 实际生效的形态由传输层回报（默认带 thinking 关闭；被拒则自动回退）。
        let appliedThinkingDisabled = description.thinkingDisabled;
        let thinkingParamRejected = false;

        const recordOutcome = async (ok: boolean, errorCode?: ModelErrorCode): Promise<void> => {
          if (recorded) return;
          recorded = true;
          await budget.record({
            requestId: req.requestId,
            taskId: req.taskId,
            provider: description.provider,
            model: description.model,
            attemptIndex: attempt,
            startedAt,
            thinkingDisabled: appliedThinkingDisabled,
            durationMs: Date.now() - startedMs,
            ok,
            promptChars,
            outputChars,
            ...(thinkingParamRejected ? { thinkingParamRejected: true } : {}),
            ...(errorCode ? { errorCode } : {}),
          });
        };

        try {
          const response = await callModelOnce({
            config: transport,
            systemPrompt,
            userPrompt,
            secrets,
            // 每次真正 POST 之前登记：额度按"会产生输出的请求"计一次；
            // 「代理拒绝 thinking 开关」的自动回退 POST 只记录、不占额度。
            beforePost: async ({ thinkingDisabled: formThinkingDisabled, fallback }) => {
              const entry = {
                requestId: req.requestId,
                taskId: req.taskId,
                provider: description.provider,
                model: description.model,
                attemptIndex: attempt,
                startedAt: new Date().toISOString(),
                thinkingDisabled: formThinkingDisabled,
              };
              if (fallback) await budget.noteFallback(entry);
              else await budget.reserve(entry);
            },
          });
          appliedThinkingDisabled = response.thinkingDisabledApplied;
          thinkingParamRejected = response.thinkingParamRejected;
          outputChars = response.text.length;

          let draft;
          try {
            draft = validateDraftText(response.text);
          } catch (validationError) {
            if (!isModelCallError(validationError)) throw validationError;
            // 保留**脱敏后**的响应片段：失败分支也需要可复核的证据，
            // 但不记录完整正文，也绝不因此放宽校验或兜底成固定稿。
            throw new ModelCallError(
              validationError.code,
              `${validationError.message}（响应片段，脱敏后前 160 字：${sanitize(response.text).slice(0, 160)}）`,
              validationError.retryable,
            );
          }

          await recordOutcome(true);
          return { title: draft.title, paragraphs: draft.paragraphs };
        } catch (error) {
          const failure = isModelCallError(error)
            ? error
            : new ModelCallError(
                'model_upstream_error',
                `模型调用出现未分类错误：${sanitize((error as Error | null)?.message ?? error)}`,
                true,
              );
          await recordOutcome(false, failure.code);

          if (failure.retryable && attempt < MODEL_MAX_ATTEMPTS) {
            lastRetryable = failure;
            continue;
          }
          throw failure;
        }
      }

      throw (
        lastRetryable ??
        new ModelCallError('model_upstream_error', `模型调用在 ${MODEL_MAX_ATTEMPTS} 次尝试后仍未成功`, false)
      );
    },
  };
}

export { LEDGER_FILENAME };
export type { ModelBudget };

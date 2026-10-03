/** S4 —— 模型模块入口。S3 从这里取端口即可。 */

export {
  createModelPort,
  describeModelConfig,
  endpointUrl,
  isModelCallError,
  ModelCallError,
  LEDGER_FILENAME,
  MODEL_MAX_ATTEMPTS,
  MODEL_MAX_TOKENS,
  MODEL_TIMEOUT_MS,
  __resetBudgetCacheForTests,
} from './port.js';
export type {
  ApiShape,
  DraftInput,
  DraftParagraphInput,
  ModelCallRequest,
  ModelConfig,
  ModelErrorCode,
  ModelPort,
} from './port.js';
export { validateDraftText, stripCodeFences, toParagraphTexts } from './validate.js';
export type { ValidatedDraft } from './validate.js';
export { MODEL_SYSTEM_PROMPT, DELIBERATION_TRIGGERS, buildUserPrompt } from './prompt.js';
export { MODEL_TEMPERATURE, isThinkingParamRejection } from './transport.js';
export type { ModelResponse, PostInfo, TransportConfig } from './transport.js';

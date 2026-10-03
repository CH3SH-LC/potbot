/**
 * S4 —— 模型响应校验。
 *
 * 不合规即抛 `ModelCallError`，**绝不**兜底成固定稿。
 * 段落数与总字数上限直接取共享合同 `LIMITS`，不另立一份数字。
 */

import { LIMITS } from '../contracts.js';
import { ModelCallError, type ModelErrorCode } from './errors.js';

export interface DraftParagraphInput {
  readonly id: string;
  readonly text: string;
}

export interface DraftInput {
  readonly title: string;
  readonly paragraphs: readonly DraftParagraphInput[];
}

export interface ValidatedDraft extends DraftInput {
  /** 正文总字数（各段 trim 后长度之和），与 `LIMITS.maxDraftChars` 同口径。 */
  readonly totalChars: number;
}

/** 剥掉模型偶发加上的 Markdown 代码块围栏。只剥一层，不做其它"猜心思"的修复。 */
export function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```$/.exec(trimmed);
  if (fenced && typeof fenced[1] === 'string') return fenced[1].trim();
  return trimmed;
}

function fail(code: ModelErrorCode, message: string, retryable: boolean): never {
  throw new ModelCallError(code, message, retryable);
}

/**
 * 校验并规范化模型返回的草稿文本。
 *
 * 段落 id 由本端口规范化为 `p1..pn`（稳定、可预测；S3 若再规范化，二者取先即可）。
 */
export function validateDraftText(raw: string): ValidatedDraft {
  const body = stripCodeFences(raw);
  if (!body) fail('model_empty_response', '模型返回了空白内容', true);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    fail('model_response_not_json', '模型返回的不是合法 JSON，已拒绝（不套用固定稿）', true);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('model_response_schema', '模型返回的 JSON 根不是对象', true);
  }
  const root = parsed as Record<string, unknown>;

  const title = typeof root.title === 'string' ? root.title.trim() : '';
  if (!title) fail('model_response_schema', '模型返回的 title 为空或不是字符串', true);

  const rawParagraphs = root.paragraphs;
  if (!Array.isArray(rawParagraphs)) {
    fail('model_response_schema', '模型返回的 paragraphs 不是数组', true);
  }
  if (
    rawParagraphs.length < LIMITS.minParagraphs ||
    rawParagraphs.length > LIMITS.maxParagraphs
  ) {
    fail(
      'model_response_schema',
      `模型返回 ${rawParagraphs.length} 段，超出合同允许的 ${LIMITS.minParagraphs}–${LIMITS.maxParagraphs} 段`,
      true,
    );
  }

  const paragraphs: DraftParagraphInput[] = [];
  let totalChars = 0;

  for (let index = 0; index < rawParagraphs.length; index += 1) {
    const item: unknown = rawParagraphs[index];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      fail('model_response_schema', `第 ${index + 1} 段不是对象`, true);
    }
    const textValue = (item as Record<string, unknown>).text;
    if (typeof textValue !== 'string') {
      fail('model_response_schema', `第 ${index + 1} 段缺少字符串 text`, true);
    }
    const text = textValue.trim();
    if (!text) {
      fail('model_response_schema', `第 ${index + 1} 段是空白段，已拒绝`, true);
    }
    totalChars += text.length;
    paragraphs.push({ id: `p${index + 1}`, text });
  }

  if (totalChars > LIMITS.maxDraftChars) {
    fail(
      'model_response_too_long',
      `正文合计 ${totalChars} 字，超过合同上限 ${LIMITS.maxDraftChars} 字`,
      true,
    );
  }

  return { title, paragraphs, totalChars };
}

/** 纯文本 `paragraphs: string[]` 视图，供 S5 的 DOCX 模板直接消费。 */
export function toParagraphTexts(draft: DraftInput): readonly string[] {
  return draft.paragraphs.map((p) => p.text);
}

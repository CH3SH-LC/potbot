/**
 * 脱敏闸：凭证引用里不得出现明文敏感信息。
 *
 * 与 M10 `evidence.ts` 的脱敏闸同源：手机号形态 / `sk-` / `Bearer` / `api_key=` /
 * `token=` 一律拒。**注意**：此处两个正则**不带 `g` 标志**——带 `g` 的 `RegExp.test`
 * 会记忆 `lastIndex`，跨调用漏判（M-R01 曾因这个真实缺陷让自由文本漏扫）。本包从源头规避。
 */

import { TransportAttestationError } from './errors.js';

/** 疑似手机号（中国大陆手机号形态）。 */
const PHONE_LIKE = /(?<!\d)1[3-9]\d{9}(?!\d)/;
/** 疑似密钥 / 令牌字样。 */
const SECRET_LIKE = /(bearer\s+[a-z0-9._-]{8,}|sk-[a-z0-9]{8,}|api[_-]?key\s*[:=]|token\s*[:=]\s*[a-z0-9._-]{8,})/i;

/** 文本是否疑似含未脱敏敏感信息（供测试与调用方预检）。 */
export function containsSecretLikeText(text: string): boolean {
  return PHONE_LIKE.test(text) || SECRET_LIKE.test(text);
}

/** 断言文本已脱敏；命中即抛 `secret_like_text_rejected`（不回显命中内容）。 */
export function assertRedactedText(text: string, label: string): void {
  if (containsSecretLikeText(text)) {
    throw new TransportAttestationError(
      'secret_like_text_rejected',
      `${label} 疑似含未脱敏敏感信息（手机号/密钥/令牌）：凭证引用必须脱敏`,
    );
  }
}

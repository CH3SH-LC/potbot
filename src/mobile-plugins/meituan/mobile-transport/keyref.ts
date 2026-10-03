/**
 * M02 —— keyRef 形状与校验。
 *
 * 工作书 MEITUAN.md / M02 的硬约束：**本包「只拿 K03 keyRef」**，凭证只发官方授权
 * host。要让这条纪律在**结构层面**成立，第一件事就是让明文永远进不来：
 * {@link KEY_REF_PATTERN} 与 `contracts/mobile-v1/schemas/model-port.schema.json`
 * 的 `keyRef` 完全一致（`^keyref:[A-Za-z0-9._:-]+$`），任何不符合该形状的字符串
 * ——尤其是一段真实 token ——**立即被拒**，且**拒绝时不回显原值**（否则疑似密钥会
 * 被写进错误消息、日志或证据）。
 *
 * 与 M-R05 的关系：M-R05 裁决「这份 keyRef 此刻能不能给这个账号的这个 scope 用」；
 * 本包只用它的形状，不复制凭证库。真机上 K03 提供 `CredentialResolverPort`，
 * 明文仅在请求期间由手机原生密钥库解密，经 {@link TransportCredential} 直达原生
 * 网络端口，**从不进入描述符、日志或证据**。
 */

/** keyRef 引用形状，对齐 `contracts/mobile-v1`（与 model-port.schema.json 逐字一致）。 */
export const KEY_REF_PATTERN = /^keyref:[A-Za-z0-9._:-]+$/;

/** 会话引用形状：跨日志/证据只出现引用，绝不出现会话令牌本身。 */
export const SESSION_REF_PATTERN = /^sessref:[A-Za-z0-9._:-]+$/;

/** 账号引用形状，对齐 M07 / M-R05 的 `^acct:...`。 */
export const ACCOUNT_REF_PATTERN = /^acct:[A-Za-z0-9._:-]+$/;

/** 是否为合法 keyRef（纯引用，绝非密钥）。 */
export function isKeyRef(value: unknown): value is string {
  return typeof value === 'string' && KEY_REF_PATTERN.test(value);
}

/** 是否为合法会话引用。 */
export function isSessionRef(value: unknown): value is string {
  return typeof value === 'string' && SESSION_REF_PATTERN.test(value);
}

/** 是否为合法账号引用。 */
export function isAccountRef(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_REF_PATTERN.test(value);
}

/**
 * 断言是合法 keyRef，否则抛错。
 *
 * **刻意不回显 `value`**：若调用方误把明文当引用传入，明文不得进入错误消息。
 * 只报告字段名与形状要求。
 */
export function assertKeyRef(value: unknown, field = 'keyRef'): string {
  if (!isKeyRef(value)) {
    throw new TypeError(`${field} 必须是 keyRef 引用（形状 keyref:...，形状不符即拒；此处不回显原值）`);
  }
  return value;
}

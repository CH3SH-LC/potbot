/**
 * M08 支付凭据隔离 —— **不代填银行卡 / 验证码 / PIN** 的结构化落地。
 *
 * ## 工作书原文
 *
 * 「不代填银行卡/验证码/PIN」。这不是一句给模型的提示词，而是一条
 * **本地硬闸门**：任何要交给支付链路的载荷，只要出现支付凭据字段，
 * 本模块**在进入任何处理之前**就抛 {@link PaymentError}（`forbidden_payment_credential_input`）。
 *
 * ## 为什么不能只靠「不要填」
 *
 * 提示词可以被子任务忽略，字段却骗不过校验。若某条上层链路将来接入了
 * 「把用户卡号塞进支付参数」的写法，只有本地这一层能拦住它。因此本模块对
 * **键名**做归一化匹配（大小写 / 下划线 / 连字符无关），并在命中时**立即拒绝整个载荷**，
 * 绝不「顺手删掉敏感字段再继续」——后者会把一次本应失败的调用伪装成成功。
 *
 * ## 边界
 *
 * - 本模块**不存储、不传输、不脱敏后放行**任何凭据，只做拒绝；
 * - 匹配对象是**键名**（结构性），不做值内容识别（值识别容易漏且会误伤）；
 * - 「护照/身份证」等非支付凭据不在本模块范围，但 `pin`/`password` 等会被命中。
 */

import { PaymentError } from './errors.js';

/**
 * 归一化后**命中即拒**的键名 token（小写、去除非字母数字与 CJK 之外字符后比较）。
 *
 * 说明：
 * - `cardnumber` / `cardno` / `pan` / `cvv` / `cvc` / `expirydate` 属银行卡要素；
 * - `otp` / `smscode` / `verificationcode` / `securitycode` 属验证码/动态码；
 * - `pin` / `password` / `paypassword` 属支付口令。
 *
 * 注意刻意**不含** `expiresat`（那是本包合法的交接期限字段），避免误伤。
 */
export const PAYMENT_CREDENTIAL_KEY_TOKENS: readonly string[] = Object.freeze([
  'cardnumber',
  'cardno',
  'cardnum',
  'bankcard',
  'cardholder',
  'pan',
  'cvv',
  'cvc',
  'cvn',
  'track2',
  'expirydate',
  'expirationdate',
  'otp',
  'smscode',
  'dynamiccode',
  'verificationcode',
  'securitycode',
  'pin',
  'paypin',
  'paypassword',
  'paymentpassword',
  'password',
  '密码',
  '卡号',
  '验证码',
  '口令',
]);

/** 归一化一个键名：小写、仅保留字母数字与 CJK。 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
}

/** 该键名是否命中支付凭据 token。 */
export function isCredentialKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (normalized.length === 0) {
    return false;
  }
  return PAYMENT_CREDENTIAL_KEY_TOKENS.some((token) => normalized === token || normalized.startsWith(token));
}

/**
 * 递归扫描载荷：返回**第一个**命中凭据键的路径（`$`-根）。无命中返回 `null`。
 *
 * 只遍历普通对象与数组；`Date` / `Map` / 函数等不被视为结构载荷。
 */
export function findCredentialField(payload: unknown, path = '$'): string | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  if (Array.isArray(payload)) {
    for (let index = 0; index < payload.length; index += 1) {
      const found = findCredentialField(payload[index], `${path}[${index}]`);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (isCredentialKey(key)) {
      return `${path}.${key}`;
    }
    const found = findCredentialField(value, `${path}.${key}`);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/** 载荷里是否含支付凭据字段。 */
export function containsCredentialField(payload: unknown): boolean {
  return findCredentialField(payload) !== null;
}

/**
 * **硬闸门**：载荷含支付凭据字段即抛错。
 *
 * @throws {PaymentError} `forbidden_payment_credential_input`
 */
export function assertNoCredentialFields(payload: unknown): void {
  const path = findCredentialField(payload);
  if (path !== null) {
    throw new PaymentError(
      'forbidden_payment_credential_input',
      `载荷在 ${path} 含支付凭据字段：本模块不代填银行卡/验证码/PIN，拒绝处理（不脱敏放行，也不静默删除）`,
      path,
    );
  }
}

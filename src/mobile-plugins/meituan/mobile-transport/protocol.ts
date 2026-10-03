/**
 * M02 —— 协议解码与业务分类。
 *
 * ## 洞：把"能解析"当成"业务成功"
 *
 * 只要有人写 `if (JSON.parse(body).code) return 'ok'`，一个 `code:"error"` 的响应
 * 就会被当成成功。本模块把解码（协议层）与分类（业务层）**分开且都有明确否定出口**：
 *
 * - {@link decodeEnvelope} 只回答"这段 body 是不是合法的业务信封"。收空 body、
 *   非 JSON、非对象、缺 `code` ⇒ **协议错误**（`delivered:false` 一侧），
 *   绝不产出一个"看起来像成功"的对象。
 * - {@link classifyBusiness} 只回答"登记表怎么判这个业务码"。**未登记的码一律
 *   `unknown`**——这是全包最要害的一条：不认识的码不猜、尤其不猜成功。
 *
 * 真实美团信封与码表**尚未核实**（M01 负责）。此处只固定最小必需字段 `code`，
 * 其余字段不臆造；码表由调用方注入。
 */

import type { BusinessCodeTable, BusinessEnvelope, BusinessKind, ProtocolErrorKind } from './types.js';

/** 解码结果：合法信封，或协议错误（无第三态）。 */
export type EnvelopeDecode =
  | { readonly ok: true; readonly envelope: BusinessEnvelope }
  | { readonly ok: false; readonly protocolErrorKind: ProtocolErrorKind; readonly reason: string };

const BUSINESS_KINDS: readonly BusinessKind[] = Object.freeze(['success', 'business_failure', 'unknown']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 解码业务信封。**纯函数**，不读时钟、不读网络。
 *
 * 规则（顺序即优先级）：
 * 1. 空 / 全空白 body ⇒ `empty_body`；
 * 2. `JSON.parse` 抛错 ⇒ `malformed_json`；
 * 3. 顶层不是普通对象（数组 / null / 标量）⇒ `invalid_envelope`；
 * 4. 缺 `code` 或 `code` 非非空字符串 ⇒ `invalid_envelope`。
 */
export function decodeEnvelope(bodyText: unknown): EnvelopeDecode {
  if (typeof bodyText !== 'string') {
    return Object.freeze({ ok: false, protocolErrorKind: 'empty_body', reason: '响应体不是字符串' });
  }
  if (bodyText.trim().length === 0) {
    return Object.freeze({ ok: false, protocolErrorKind: 'empty_body', reason: '响应体为空' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return Object.freeze({ ok: false, protocolErrorKind: 'malformed_json', reason: '响应体不是合法 JSON' });
  }
  if (!isPlainObject(parsed)) {
    return Object.freeze({ ok: false, protocolErrorKind: 'invalid_envelope', reason: '信封顶层不是对象' });
  }
  const code = parsed['code'];
  if (typeof code !== 'string' || code.trim().length === 0) {
    return Object.freeze({ ok: false, protocolErrorKind: 'invalid_envelope', reason: '信封缺少非空 code' });
  }
  const message = typeof parsed['message'] === 'string' ? parsed['message'] : null;
  const data = 'data' in parsed ? parsed['data'] : null;
  const envelope: BusinessEnvelope = Object.freeze({ code, message, data });
  return Object.freeze({ ok: true, envelope });
}

/**
 * 业务码 → 分类。**未登记 / 空串一律 `unknown`**；登记表异常也回落到 `unknown`
 * （宁可不判，绝不误判成功）。
 */
export function classifyBusiness(envelope: BusinessEnvelope, table: BusinessCodeTable): BusinessKind {
  const code = envelope?.code;
  if (typeof code !== 'string' || code.length === 0) {
    return 'unknown';
  }
  let kind: BusinessKind;
  try {
    kind = table.lookup(code);
  } catch {
    return 'unknown';
  }
  return BUSINESS_KINDS.includes(kind) ? kind : 'unknown';
}

/** 业务码登记项。 */
export interface BusinessCodeEntry {
  readonly code: string;
  readonly kind: BusinessKind;
}

/**
 * 由登记项构造业务码表。**未登记的码返回 `unknown`**（唯一否定出口）。
 */
export function createBusinessCodeTable(entries: readonly BusinessCodeEntry[]): BusinessCodeTable {
  if (!Array.isArray(entries)) {
    throw new TypeError('createBusinessCodeTable 需要登记项数组');
  }
  const map = new Map<string, BusinessKind>();
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || typeof entry.code !== 'string' || entry.code.length === 0) {
      throw new TypeError('登记项需要非空 code');
    }
    if (!BUSINESS_KINDS.includes(entry.kind)) {
      throw new TypeError(`登记项 ${JSON.stringify(entry.code)} 的 kind 非法`);
    }
    if (map.has(entry.code)) {
      throw new TypeError(`业务码 ${JSON.stringify(entry.code)} 重复登记`);
    }
    map.set(entry.code, entry.kind);
  }
  return Object.freeze({
    lookup(code: string): BusinessKind {
      return map.get(code) ?? 'unknown';
    },
  });
}

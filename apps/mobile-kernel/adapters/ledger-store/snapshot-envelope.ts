/**
 * K-I08 账本持久化适配层 —— **快照信封**（零依赖）。
 *
 * 两个账本共用同一层信封，读起来才知道"这是谁的、什么版本、负载是什么"：
 *
 * ```json
 * { "schema": "potbot.ledger-store", "ledger": "task" | "authorization", "version": 1, "payload": <...> }
 * ```
 *
 * ## 为什么信封校验不能省
 *
 * 信封校验是"**partial 快照**必须报错"的第一道闸：被截断的字节先撞 `JSON.parse`，
 * 完整但缺字段的（`payload` 缺失、`version` 缺失、`ledger` 写错）在这里撞形状校验，
 * 都抛 `invalid_snapshot`——**绝不**当成"没有账本"。把任务账本当授权账本读
 * （`ledger` 类别不符）同样当场拒。
 */

import { invalidSnapshot } from './errors.js';

export const LEDGER_STORE_SCHEMA = 'potbot.ledger-store';
export const LEDGER_STORE_VERSION = 1;

/** 本层支持的账本类别。 */
export type LedgerKind = 'task' | 'authorization';

interface Envelope {
  schema: string;
  ledger: LedgerKind;
  version: number;
  payload: unknown;
}

/** 打包：只做输出，不做校验（负载由各账本自行提供）。 */
export function encodeEnvelope(ledger: LedgerKind, payload: unknown): string {
  const envelope: Envelope = {
    schema: LEDGER_STORE_SCHEMA,
    ledger,
    version: LEDGER_STORE_VERSION,
    payload,
  };
  return JSON.stringify(envelope);
}

/**
 * 解包并校验信封，返回负载。
 *
 * - 非法 JSON / 顶层非对象 ⇒ `invalid_snapshot('malformed')`；
 * - `schema` 不符 ⇒ `'wrong-schema'`；
 * - `ledger` 不符 ⇒ `'wrong-ledger-kind'`；
 * - `version` 不符 ⇒ `'wrong-version'`；
 * - `payload` 缺失 ⇒ `'partial'`。
 */
export function decodeEnvelope(text: string, expected: LedgerKind): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    throw invalidSnapshot('malformed', '账本快照不是合法 JSON：拒绝当空账本继续（读失败不当空库）');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidSnapshot('malformed', '账本快照顶层必须是对象');
  }
  const env = parsed as Partial<Record<keyof Envelope, unknown>>;
  if (env.schema !== LEDGER_STORE_SCHEMA) {
    throw invalidSnapshot('wrong-schema', `快照 schema 标记非法：${String(env.schema)}（期望 ${LEDGER_STORE_SCHEMA}）`);
  }
  if (env.ledger !== expected) {
    throw invalidSnapshot(
      'wrong-ledger-kind',
      `快照 ledger 类别不符：${String(env.ledger)}（期望 ${expected}）——不得跨账本误读`,
    );
  }
  if (env.version !== LEDGER_STORE_VERSION) {
    throw invalidSnapshot('wrong-version', `快照版本 ${String(env.version)} 不受支持（本层支持 ${LEDGER_STORE_VERSION}）`);
  }
  if (!('payload' in env) || env.payload === undefined) {
    throw invalidSnapshot('partial', '快照缺少 payload 字段（典型是截断 / 半写入的 partial 快照）');
  }
  return env.payload;
}

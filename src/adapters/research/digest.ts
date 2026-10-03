/**
 * 内容寻址摘要 —— 来源 ID 的基础。
 *
 * 合同 R202：ID 必须跨进程唯一。本切片**不使用** `src/protocol/ids.ts` 的进程内计数器
 * （其计数重置不满足 R202），而用**内容摘要**：同一份字节在任何进程/任何时间都得到同一 ID，
 * 天然跨进程稳定。摘要算法用 `node:crypto`（本项目 `src/**` 已允许的既有内建依赖之一）。
 */
import { createHash } from 'node:crypto';

/** 计算字节的 sha256 十六进制摘要。 */
export function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 计算字符串（按 UTF-8 字节）的 sha256 十六进制摘要。 */
export function digestText(text: string): string {
  return digestBytes(new TextEncoder().encode(text));
}

/** 取前 n 位作为短 ID（仅用于展示/日志；**不**用于寻址）。 */
export function shortId(digest: string, n = 12): string {
  return digest.slice(0, n);
}

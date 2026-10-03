/**
 * 手机内核日志库 —— **库错误类型与可机读拒因**（独立文件，避免 `journal-store` 与
 * `migration` 相互 import 形成环）。
 *
 * 边界口径：
 * - **形状 / 用法违规**（迁移步骤缺失、版本过新、截断长度非法、put 载荷非法）⇒ 抛
 *   `KernelJournalError`，代码必须显式 catch，**不得**被上层当成一次普通失败结果吞掉。
 * - **领域分支**（删不存在的键 = `not-found`）⇒ 用 schema 里的 status 返回，不抛。
 */

import { KERNEL_DB_ERROR_CODES, type KernelDbErrorCode } from './schemas.js';

export class KernelJournalError extends Error {
  readonly code: KernelDbErrorCode;
  readonly subject: string | null;

  constructor(code: KernelDbErrorCode, detail: string, subject: string | null = null) {
    super(`[${code}]${subject === null ? '' : `[${subject}]`} ${detail}`);
    this.name = 'KernelJournalError';
    this.code = code;
    this.subject = subject;
  }
}

/** 类型守卫：打包后 `instanceof` 可能失效，故同时看 `code` 是否在词表内。 */
export function isKernelJournalError(value: unknown): value is KernelJournalError {
  return (
    value instanceof KernelJournalError ||
    (typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      typeof (value as { code: unknown }).code === 'string' &&
      (KERNEL_DB_ERROR_CODES as readonly string[]).includes((value as { code: string }).code))
  );
}

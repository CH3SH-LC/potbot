/**
 * K09 存储端口 —— **错误类型与拒因词表**（零依赖，不 import 任何 node 内建）。
 *
 * ## 为什么形状违规要"抛"，而领域结果要"返回 status"
 *
 * 两类事情必须分开：
 *
 * 1. **调用方用法错误 / 形状违规**（传了电脑绝对路径、往不存在的长事务提交、重复提交）——
 *    这是**不该发生**的事，静默返回一个 `status: 'failed'` 会让上层把它当成"一次正常的
 *    失败结果"处理掉。因此一律抛 `StorageError`，代码必须显式 catch。
 * 2. **领域结果**（CAS 版本不符 = `conflict`、blob 不存在 = `not-found`、读回摘要不符 =
 *    `failed`）——这些是**正常业务分支**，用 schema 里的 status 枚举返回，不抛。
 *
 * 这条分界线是"不得静默覆盖"的实现基础：CAS 冲突不是异常，但**绝不允许**被实现悄悄吞掉
 * 后改成"那就覆盖吧"。
 */

/** 存储端口**全部**可机读拒因。新增必须在此登记（测试逐条对照）。 */
export const STORAGE_ERROR_CODES = [
  // --- 路径 / URI 形状（核心红线：不得返回电脑绝对路径） ---
  /** 传入了 Windows 盘符路径（`C:\…` / `C:/…`）或 POSIX 绝对路径（`/…`）。 */
  'desktop_path_rejected',
  /** 既不是 `content:/`、`blob:/`、`app:/` 开头的手机内容 URI，也不是可解释的相对路径。 */
  'invalid_content_uri',
  /** 相对路径里含 `..`、反斜杠或非法字符。 */
  'invalid_relative_path',

  // --- 事务 ---
  /** 事务 ID 不存在（未 begin 或已回收）。 */
  'transaction_not_found',
  /** 事务已提交或已回滚，不得二次结算。 */
  'transaction_already_settled',

  // --- 写入 ---
  /** 流式写入未提供任何分片来源（`chunks` 缺失）。 */
  'missing_stream_source',
  /** 分片不是字节或字符串。 */
  'invalid_stream_chunk',

  // --- 摘要 ---
  /** 传入了形状非法的期望摘要（不是 `sha256:<64 hex>`）。 */
  'invalid_digest',

  // --- 读回 ---
  /** 读回时目标 blob 不存在。 */
  'blob_not_found',
] as const;

export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];

/** 存储端口唯一的错误类型。所有"用法错误 / 形状违规"都抛它，测试按 `code` 断言。 */
export class StorageError extends Error {
  readonly code: StorageErrorCode;

  /** 触发拒因的输入（URI / 路径 / 事务 ID），便于定位；无则为 null。 */
  readonly subject: string | null;

  constructor(code: StorageErrorCode, detail: string, subject: string | null = null) {
    super(`[${code}]${subject === null ? '' : `[${subject}]`} ${detail}`);
    this.name = 'StorageError';
    this.code = code;
    this.subject = subject;
  }
}

/** 类型守卫：跨模块 `instanceof` 在打包后可能失效，故同时看 `code`。 */
export function isStorageError(value: unknown): value is StorageError {
  return (
    value instanceof StorageError ||
    (typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      typeof (value as { code: unknown }).code === 'string' &&
      (STORAGE_ERROR_CODES as readonly string[]).includes((value as { code: string }).code))
  );
}

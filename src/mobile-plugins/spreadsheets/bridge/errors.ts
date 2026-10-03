/**
 * 表格存储桥接层 —— 结构化错误（零依赖，纯类型 + 纯函数）。
 *
 * ## 为什么单独一个错误类型
 *
 * 本层是**宿主实现契约**：安卓宿主（SAF / 应用私有目录）实现
 * {@link ./types.js} 的 `SpreadsheetHostStoragePort`，本层只负责"把会话状态编成字节 / 从字节
 * 恢复"。因此错误必须能**区分两类**：
 *
 * | 类别 | 例子 | 处理 |
 * |---|---|---|
 * | 调用方形状错误 | 空 key、电脑绝对路径、版本号非整数 | 抛 `SpreadsheetBridgeError`（`code` 可机读） |
 * | 领域分支 | 目标不存在、介质读不动 | **返回值**（`not_found` / `failed`），不抛 |
 *
 * 这条边界与 K09 `StoragePort` 一致：不给"顺手把失败当空库"留缝。
 */

/** 桥接层的可机读拒因词表（封闭枚举，供测试与安卓端对表）。 */
export const SPREADSHEET_BRIDGE_ERROR_CODES = [
  /** blob key 为空 / 纯空白。 */
  'empty_key',
  /** blob key 是电脑绝对路径（`^[A-Za-z]:` 或前导 `/`）——本层红线。 */
  'desktop_path_rejected',
  /** 记录引用形状非法（会话 id 空、revision 非整数等）。 */
  'invalid_record_ref',
  /** 注入的写失败（介质满 / 权限）在内存后端被模拟。 */
  'write_failed',
  /** 注入的删除失败。 */
  'remove_failed',
  /** 端口读取返回 `failed`，而调用方要求必须成功。 */
  'read_failed',
  /** 有日志记录却没有快照记录（保存中途断）。 */
  'incomplete_persistence',
] as const;

export type SpreadsheetBridgeErrorCode = (typeof SPREADSHEET_BRIDGE_ERROR_CODES)[number];

/** 桥接层错误。`code` 是封闭词表值，`subject` 是出错的 key / 会话 id（可为空串）。 */
export class SpreadsheetBridgeError extends Error {
  readonly code: SpreadsheetBridgeErrorCode;
  readonly subject: string;

  constructor(code: SpreadsheetBridgeErrorCode, message: string, subject = '') {
    super(message);
    this.name = 'SpreadsheetBridgeError';
    this.code = code;
    this.subject = subject;
  }
}

/** 类型守卫：任意错误对象是否是本层错误。 */
export function isSpreadsheetBridgeError(error: unknown): error is SpreadsheetBridgeError {
  return error instanceof SpreadsheetBridgeError;
}

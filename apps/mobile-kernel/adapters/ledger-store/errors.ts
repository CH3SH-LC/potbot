/**
 * K-I08 账本持久化适配层 —— **错误类型与拒因词表**（零依赖）。
 *
 * ## 为什么"坏快照"与"读不动"合并成一个错误码 `invalid_snapshot`
 *
 * K10 的 `TaskLedger.replay()` 已经为"空串 / 非 JSON / 版本不符 / 序号乱序"统一抛
 * `invalid_snapshot`；K10 的集成请求也明确要求存储端口把**读失败**当成错误交回
 * （"treat a read failure as an error (invalid_snapshot …)"）。本适配层沿用同一条纪律：
 *
 * - **快照不存在**（介质上确实没写过）⇒ 干净的首次运行，返回 `null`——**这是唯一的"空"**；
 * - **快照存在但读不动 / 解不成 / 结构不对 / 版本不符 / 重放对不上** ⇒ 一律抛
 *   {@link LedgerStoreError}，`code === 'invalid_snapshot'`，**绝不**退化成空账本。
 *
 * 把"读不动 / 读坏了"折叠成"没有账本"，正是 crash-recovery 断言最容易变成空壳的地方：
 * 未结清的授权与外部提交会被静默丢掉，恢复入口会以为"什么都没发生过"。因此本层把
 * 除 `not_found` 之外的**任何**读取异常都上抛，`reason` 只用于定位，不用于放宽判据。
 *
 * ## 与 K08 / K09 词表的关系
 *
 * - K09 的 `StorageError` 是通用字节层拒因（`desktop_path_rejected` / `invalid_content_uri` …），
 *   本层把它**如实**折进 `invalid_snapshot(reason='read-failed')`，不当空库。
 * - K08 的 `MemoryPersistencePort.read()` 三值（`ok | not_found | failed`）是本层
 *   `BlobStorePort` 的直接范本；本层只是把"键值字符串"换成账本 blob。
 */

/** 本层**全部**可机读拒因。 */
export const LEDGER_STORE_ERROR_CODES = [
  /**
   * 快照存在但不可用（非法 JSON / 结构或版本不符 / 读出口袋报错 / 重放与记录对不上）。
   * **这是本层唯一对"读侧失败"暴露的码**，语义即"拒绝当空账本继续"。
   */
  'invalid_snapshot',
  /** 写入端口报错：**未确认落盘，不得宣称已保存**。 */
  'blob_write_failed',
  /**
   * 重放屏障（**仅内部**）：受控执行器在重放期按记录模拟"发出途中死亡"。它由重放引擎
   * 就地捕获，**不得**逃逸到调用方；若逃逸，说明重放编排本身出了差错。
   */
  'replay_barrier',
] as const;

export type LedgerStoreErrorCode = (typeof LEDGER_STORE_ERROR_CODES)[number];

/** `invalid_snapshot` 的细分原因（**只用于定位**，不放宽判据）。 */
export type InvalidSnapshotReason =
  /** 字节不是合法 JSON，或顶层不是对象。 */
  | 'malformed'
  /** 顶层形状/字段缺失——典型是**被截断的 partial 快照**。 */
  | 'partial'
  /** `schema` 标记不符（不是本层的快照）。 */
  | 'wrong-schema'
  /** `version` 不受支持。 */
  | 'wrong-version'
  /** `ledger` 类别不符（把任务账本当授权账本读）。 */
  | 'wrong-ledger-kind'
  /** 读端口报错（介质不可达 / 摘要不符 / 形状违规）——**不是空库**。 */
  | 'read-failed'
  /** 重放后与记录对不上（id 不一致、发送尝试没留下意图…）。 */
  | 'divergence'
  /** 事件流里出现无法解读的事件。 */
  | 'unreadable-event';

export class LedgerStoreError extends Error {
  readonly code: LedgerStoreErrorCode;
  /** 仅 `invalid_snapshot` 时有值。 */
  readonly reason: InvalidSnapshotReason | null;
  /** 出错对象（key / URI / 事件序号），便于定位；无则 null。 */
  readonly subject: string | null;

  constructor(
    code: LedgerStoreErrorCode,
    detail: string,
    options: { readonly reason?: InvalidSnapshotReason; readonly subject?: string | null } = {},
  ) {
    super(`[${code}]${options.subject == null ? '' : `[${options.subject}]`} ${detail}`);
    this.name = 'LedgerStoreError';
    this.code = code;
    this.reason = options.reason ?? null;
    this.subject = options.subject ?? null;
  }
}

/** 便捷构造：一律产出 `invalid_snapshot`。 */
export function invalidSnapshot(
  reason: InvalidSnapshotReason,
  detail: string,
  subject: string | null = null,
): LedgerStoreError {
  return new LedgerStoreError('invalid_snapshot', detail, { reason, subject });
}

/** 类型守卫：跨模块 `instanceof` 在打包后可能失效，故同时看 `code`。 */
export function isLedgerStoreError(value: unknown): value is LedgerStoreError {
  return (
    value instanceof LedgerStoreError ||
    (typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      typeof (value as { code: unknown }).code === 'string' &&
      (LEDGER_STORE_ERROR_CODES as readonly string[]).includes((value as { code: string }).code))
  );
}

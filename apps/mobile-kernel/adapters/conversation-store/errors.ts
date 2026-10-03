/**
 * K-I05 会话持久化适配层 —— **拒因词表与错误类型**（零依赖，纯数据）。
 *
 * ## 与 K09 `StorageError` 的分工
 *
 * `StorageError`（`apps/mobile-kernel/storage/errors.ts`）描述的是**存储端口自身的用法 /
 * 形状违规**（传了电脑绝对路径、向不存在的事务提交……）。本文件描述的是**适配层在把
 * K04 会话语义压到存储端口上时**遇到的语义问题：快照字节坏了、快照不是数组因而无法安全
 * 合并、CAS 版本反复冲突等。两类错误分开，验收才能区分"存储端口拒绝了它"与"适配层不敢写"。
 *
 * ## 为什么这些是"抛"而不是"返回值"
 *
 * K04 的端口（`MobileConversationPersistencePort` / `CurrentDocumentFactPort`）签名里
 * **没有错误通道**（`save(...): void`、`loadAll(): unknown`）。因此"快照不可信"只能
 * 通过抛错表达：K04 的 `#restore()` / `resolve()` 都把 `loadAll()` 包在 try 里，抛错即
 * 记为 `state_unreadable`——**这正是 fail-closed 的落点**（读不回来不算空，绝不静默当
 * "一条都没有"）。反之，若适配层"好心"返回 `null`，坏快照会被当成首次运行，红线失守。
 */

/** 适配层**全部**可机读拒因。新增必须在此登记（测试逐条对照）。 */
export const CONVERSATION_ADAPTER_ERROR_CODES = [
  /** 快照字节被篡改 / 介质损坏：读回重算的摘要与写入时记录的摘要不符。 */
  'snapshot_integrity_failed',
  /** 快照字节不是合法 UTF-8 或不是合法 JSON。 */
  'snapshot_malformed',
  /** 快照 JSON 的顶层不是数组（无法安全地按 key 合并，拒绝覆盖以免销毁数据）。 */
  'snapshot_shape_invalid',
  /** CAS 连续冲突超过上限，放弃写入（不盲写、不降级为覆盖）。 */
  'write_conflict',
  /** 存储端口对写入返回了非 ok / 非 conflict 的状态。 */
  'write_failed',
] as const;

export type ConversationAdapterErrorCode = (typeof CONVERSATION_ADAPTER_ERROR_CODES)[number];

/** 适配层唯一的错误类型。测试按 `code` 断言。 */
export class ConversationAdapterError extends Error {
  readonly code: ConversationAdapterErrorCode;
  /** 触发拒因的快照 URI（无则为 null），便于定位。 */
  readonly subject: string | null;

  constructor(code: ConversationAdapterErrorCode, detail: string, subject: string | null = null) {
    super(`[${code}]${subject === null ? '' : `[${subject}]`} ${detail}`);
    this.name = 'ConversationAdapterError';
    this.code = code;
    this.subject = subject;
  }
}

/** 类型守卫：跨模块 `instanceof` 在打包后可能失效，故同时看 `code`。 */
export function isConversationAdapterError(value: unknown): value is ConversationAdapterError {
  return (
    value instanceof ConversationAdapterError ||
    (typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      typeof (value as { code: unknown }).code === 'string' &&
      (CONVERSATION_ADAPTER_ERROR_CODES as readonly string[]).includes((value as { code: string }).code))
  );
}

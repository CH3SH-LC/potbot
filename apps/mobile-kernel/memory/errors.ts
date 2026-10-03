/**
 * K08 手机记忆线 —— **错误类型与可机读拒因词表**（零依赖，不 import 任何 node 内建）。
 *
 * 与 K09 存储端口同一取舍：把「调用方用法错误 / 形状违规」与「领域结果」分开。
 *
 * - **抛 `MemoryPersistenceError`**：形状违规、非法操作封套、持久化**底层不可用**
 *   （读失败 / 写失败）等**不该被当成一次正常业务分支吞掉**的情形。上层必须显式 catch。
 * - **返回判别联合**：`openPhoneMemory()` 的 `loaded | empty | failed`、
 *   `saveMemory()` 的 `{ok:true}` / `{ok:false, reason}`——这些是**正常业务分支**。
 *
 * ## 本线最核心的一条：**读失败 ≠ 空库**
 *
 * `read_failed` 是**读失败**，`store_unavailable` 是**完整性未知**。二者都**不得**
 * 被降级为「没有记忆，按空库继续」。因此本模块的 load 在失败时**不交出任何仓库对象**，
 * 只交出 `reason + detail`；想拿到仓库必须走 `openPhoneMemoryOrThrow()`，
 * 它在失败时抛 `store_unavailable`——空库与读失败在类型与运行时都可区分。
 */

/** 记忆持久化端口**全部**可机读拒因。新增必须在此登记（测试逐条对照）。 */
export const MEMORY_PERSISTENCE_ERROR_CODES = [
  /** 打开记忆库时读失败（底层端口报 failed）：**不得**当成空库。 */
  'load_failed',
  /** 保存记忆库失败（底层端口写入失败）。 */
  'save_failed',
  /** 库完整性未知（读成功但无法确认内容可信）：**不得**当成空库，也不得据此宣称"已记住"。 */
  'store_unavailable',
  /** 操作封套非法（缺字段 / 版本不符 / 操作不在词表）。 */
  'invalid_operation',
  /** 操作负载非法（缺字段 / 类型不符 / 空串）。 */
  'invalid_payload',
  /** 跨主体操作被拒（R237 隔离）。 */
  'owner_mismatch',
  /** 目标不存在。 */
  'not_found',
  /** 同一 idempotencyKey 已用不同负载提交（重复命令必须返回原结果，不得换语义）。 */
  'idempotency_conflict',
] as const;

export type MemoryPersistenceErrorCode = (typeof MEMORY_PERSISTENCE_ERROR_CODES)[number];

/** 记忆线唯一的错误类型。所有"用法错误 / 形状违规 / 底层不可用"都抛它，测试按 `code` 断言。 */
export class MemoryPersistenceError extends Error {
  readonly code: MemoryPersistenceErrorCode;

  /** 触发拒因的主体（命令 id / operation / memory id / owner id）；无则为 null。 */
  readonly subject: string | null;

  constructor(code: MemoryPersistenceErrorCode, detail: string, subject: string | null = null) {
    super(`[${code}]${subject === null ? '' : `[${subject}]`} ${detail}`);
    this.name = 'MemoryPersistenceError';
    this.code = code;
    this.subject = subject;
  }
}

/** 类型守卫：跨模块 `instanceof` 在打包后可能失效，故同时看 `code`。 */
export function isMemoryPersistenceError(value: unknown): value is MemoryPersistenceError {
  return (
    value instanceof MemoryPersistenceError ||
    (typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      typeof (value as { code: unknown }).code === 'string' &&
      (MEMORY_PERSISTENCE_ERROR_CODES as readonly string[]).includes(
        (value as { code: string }).code,
      ))
  );
}

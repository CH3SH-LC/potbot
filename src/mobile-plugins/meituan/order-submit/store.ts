/**
 * M07 提交记录存储端口、内存实现与**可序列化快照**（零依赖）。
 *
 * 幂等的主键是**幂等键**，所以存储只需支持"按键读 / 按键写 / 全量列举"。
 * 之所以把它做成**可注入端口**而不是模块内部 Map：`重启不得重复下单` 这条要求
 * 只有在"记录能在两次进程间共享"时才可验证。
 *
 * ## 内存实现 vs 可序列化快照
 *
 * `createInMemoryOrderStore()` 只保证**同一进程内**的幂等。要证明"重启不重复下单"，
 * 需要让记录**跨进程/跨实例**存活。本模块因此提供一对纯数据 API：
 *
 * - {@link serializeOrderSubmissionStore}：把账本导出为 JSON 字符串（快照 v1）；
 * - {@link restoreOrderSubmissionStore}：由快照重建一个 store（严格校验，非法即拒）。
 *
 * 这样"进程 A 提交 → 导出 → （模拟重启）→ 进程 B 由同一快照恢复 → 同键再次提交
 * 不再调执行器"可以在**单进程测试里**被真实证明——不依赖手机 DB。
 *
 * 真机上仍应由 K09/StoragePort 注入真存储（手机 DB）；本模块的 JSON 快照是它的
 * **可测试替身**，**不是**真机持久化。
 *
 * ## 安全边界（如实说明）
 *
 * JSON 快照**不是防篡改的**：能写快照就能写账本。{@link restoreOrderSubmissionStore}
 * 只做**形状校验**（版本、字段类型、词表），不做完整性/来源证明。恢复出的 `receipt`
 * 是普通对象，**不在**受控签发器的可信 `WeakSet` 里——因此它**不能**被用来当作
 * "已确认下单"的新证据（`queryOriginalOrder` 只信新签发/新查回的回执）。
 */

import { OrderSubmitError } from './errors.js';
import {
  ORDER_SUBMISSION_STATES,
  isOrderOutcomeKind,
  isOrderSubmissionState,
  type OrderReceipt,
  type OrderSubmissionRecord,
  type OrderSubmissionStore,
} from './types.js';

/** 内存实现。返回的记录保持冻结（调用方无法就地改写账本）。 */
export function createInMemoryOrderStore(): OrderSubmissionStore {
  const byKey = new Map<string, OrderSubmissionRecord>();
  return {
    getByKey(idempotencyKey: string): OrderSubmissionRecord | undefined {
      return byKey.get(idempotencyKey);
    },
    put(record: OrderSubmissionRecord): void {
      byKey.set(record.idempotencyKey, Object.freeze({ ...record }));
    },
    all(): readonly OrderSubmissionRecord[] {
      return Object.freeze([...byKey.values()]);
    },
  };
}

// ---------------------------------------------------------------------------
// 可序列化快照（v1）
// ---------------------------------------------------------------------------

/** 快照版本。结构变更必须升版本（恢复时按版本拒未知格式）。 */
export const ORDER_STORE_SNAPSHOT_VERSION = 1 as const;

/** 提交账本快照（纯数据、JSON 可序列化）。 */
export interface OrderSubmissionStoreSnapshot {
  readonly version: typeof ORDER_STORE_SNAPSHOT_VERSION;
  readonly records: readonly OrderSubmissionRecord[];
}

function cloneReceipt(receipt: OrderReceipt | null): OrderReceipt | null {
  if (receipt === null) {
    return null;
  }
  return Object.freeze({ ...receipt });
}

function cloneRecord(record: OrderSubmissionRecord): OrderSubmissionRecord {
  return Object.freeze({ ...record, receipt: cloneReceipt(record.receipt) });
}

/** 导出账本快照（深拷贝，快照与 store 后续变更解耦）。 */
export function exportOrderSubmissionStore(store: OrderSubmissionStore): OrderSubmissionStoreSnapshot {
  return Object.freeze({
    version: ORDER_STORE_SNAPSHOT_VERSION,
    records: Object.freeze(store.all().map(cloneRecord)),
  });
}

/** 导出为 JSON 字符串（持久化 / 跨实例传递）。 */
export function serializeOrderSubmissionStore(store: OrderSubmissionStore): string {
  return JSON.stringify(exportOrderSubmissionStore(store));
}

// ---- 校验（严格：形状不符即拒，绝不猜）----

function fail(detail: string): never {
  throw new OrderSubmitError('invalid_submission_snapshot', `提交记录快照不合法：${detail}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableInt(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value));
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${field} 必须是非空字符串，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

function requireNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${field} 必须是非负安全整数，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

function requireNullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    fail(`${field} 必须是字符串或 null，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

function parseReceipt(value: unknown, field: string): OrderReceipt | null {
  if (value === null) {
    return null;
  }
  if (!isPlainObject(value)) {
    fail(`${field} 必须是对象或 null`);
  }
  const observedState = value.observedState;
  if (observedState !== 'confirmed' && observedState !== 'rejected' && observedState !== 'unknown') {
    fail(`${field}.observedState 非法：${JSON.stringify(observedState)}`);
  }
  const verificationMode = value.verificationMode;
  if (verificationMode !== 'fixture' && verificationMode !== 'real') {
    fail(`${field}.verificationMode 非法：${JSON.stringify(verificationMode)}`);
  }
  return Object.freeze({
    idempotencyKey: requireNonEmptyString(value.idempotencyKey, `${field}.idempotencyKey`),
    providerOrderRef: requireNonEmptyString(value.providerOrderRef, `${field}.providerOrderRef`),
    observedState,
    observedAt: requireNonNegativeInt(value.observedAt, `${field}.observedAt`),
    verificationMode,
    detail: requireNullableString(value.detail ?? '', `${field}.detail`) ?? '',
  });
}

function parseRecord(raw: unknown, index: number): OrderSubmissionRecord {
  const at = `records[${index}]`;
  if (!isPlainObject(raw)) {
    fail(`${at} 必须是对象`);
  }
  const state = raw.state;
  if (!isOrderSubmissionState(state)) {
    fail(`${at}.state 不在词表（${ORDER_SUBMISSION_STATES.join(' / ')}）：${JSON.stringify(state)}`);
  }
  const outcomeKind = raw.outcomeKind;
  if (outcomeKind !== null && !isOrderOutcomeKind(outcomeKind)) {
    fail(`${at}.outcomeKind 非法：${JSON.stringify(outcomeKind)}`);
  }
  if (raw.scope !== 'submit-order') {
    fail(`${at}.scope 必须是 'submit-order'，收到 ${JSON.stringify(raw.scope)}`);
  }
  return Object.freeze({
    actionId: requireNonEmptyString(raw.actionId, `${at}.actionId`),
    merchantId: requireNonEmptyString(raw.merchantId, `${at}.merchantId`),
    accountRef: requireNonEmptyString(raw.accountRef, `${at}.accountRef`),
    taskRevision: requireNonNegativeInt(raw.taskRevision, `${at}.taskRevision`),
    paramsDigest: requireNonEmptyString(raw.paramsDigest, `${at}.paramsDigest`),
    quoteRef: requireNonEmptyString(raw.quoteRef, `${at}.quoteRef`),
    amount: requireNonNegativeInt(raw.amount, `${at}.amount`),
    currency: requireNonEmptyString(raw.currency, `${at}.currency`),
    scope: 'submit-order' as const,
    grantId: requireNonEmptyString(raw.grantId, `${at}.grantId`),
    idempotencyKey: requireNonEmptyString(raw.idempotencyKey, `${at}.idempotencyKey`),
    state,
    attempt: requireNonNegativeInt(raw.attempt, `${at}.attempt`),
    sendIntentAt: isNullableInt(raw.sendIntentAt) ? raw.sendIntentAt : fail(`${at}.sendIntentAt 必须是整数或 null`),
    respondedAt: isNullableInt(raw.respondedAt) ? raw.respondedAt : fail(`${at}.respondedAt 必须是整数或 null`),
    httpStatus: isNullableInt(raw.httpStatus) ? raw.httpStatus : fail(`${at}.httpStatus 必须是整数或 null`),
    businessCode: requireNullableString(raw.businessCode, `${at}.businessCode`),
    outcomeKind: outcomeKind as OrderSubmissionRecord['outcomeKind'],
    providerOrderRef: requireNullableString(raw.providerOrderRef, `${at}.providerOrderRef`),
    receipt: parseReceipt(raw.receipt ?? null, `${at}.receipt`),
    failureReason: requireNullableString(raw.failureReason, `${at}.failureReason`),
    createdAt: requireNonNegativeInt(raw.createdAt, `${at}.createdAt`),
    updatedAt: requireNonNegativeInt(raw.updatedAt, `${at}.updatedAt`),
  });
}

/**
 * 解析（并严格校验）一份快照。接受已解析的对象或 JSON 字符串。
 * 版本不符 / 形状不合法 ⇒ 抛 `invalid_submission_snapshot`（**不猜、不静默降级**）。
 */
export function parseOrderSubmissionStoreSnapshot(input: unknown): OrderSubmissionStoreSnapshot {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (error) {
      fail(`不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!isPlainObject(raw)) {
    fail('快照必须是对象');
  }
  if (raw.version !== ORDER_STORE_SNAPSHOT_VERSION) {
    fail(`快照版本必须是 ${ORDER_STORE_SNAPSHOT_VERSION}，收到 ${JSON.stringify(raw.version)}`);
  }
  if (!Array.isArray(raw.records)) {
    fail('records 必须是数组');
  }
  const records = raw.records.map((entry, index) => parseRecord(entry, index));
  // 幂等键唯一性：重复键会让"哪条是真记录"变得不确定。
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.idempotencyKey)) {
      fail(`records 中出现重复幂等键：${record.idempotencyKey}`);
    }
    seen.add(record.idempotencyKey);
  }
  return Object.freeze({ version: ORDER_STORE_SNAPSHOT_VERSION, records: Object.freeze(records) });
}

/**
 * 由快照（对象或 JSON 字符串）重建一个提交记录 store。
 * 严格校验后再落盘，非法快照直接抛错。
 */
export function restoreOrderSubmissionStore(input: unknown): OrderSubmissionStore {
  const snapshot = parseOrderSubmissionStoreSnapshot(input);
  const store = createInMemoryOrderStore();
  for (const record of snapshot.records) {
    store.put(record);
  }
  return store;
}

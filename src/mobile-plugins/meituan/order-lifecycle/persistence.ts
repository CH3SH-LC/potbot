/**
 * M09 落盘 / 恢复（持久化）。
 *
 * ## 为什么这是本包的责任，而不是宿主随手做的事
 *
 * 工作书 M09 的行动清单里明确有「落盘/恢复」，配套备用包 M-R09 要求
 * 「后台 / 杀进程 / 重启后订单恢复及**不重复提交**」。所以恢复**不能**只是
 * `JSON.parse` 一把对象——它必须把「重启前这一刻的本地真相」原样带回来：
 * - 本地下单意图（含原 externalId）；
 * - 到这一刻为止**已通过校验**的观测序列；
 * - **是否处于阻断**（不匹配 / 异常流转）。
 *
 * ## 三条纪律
 *
 * 1. **只存事实，不存结论**：快照存的是原始的 `OrderQueryResult` 观测，
 *    不是阶段报告。`stages` / `refund` / `statusRecognized` 这些派生字段在恢复时
 *    **重新算一遍**，所以无法靠改 `stages[].state = 'confirmed'` 来伪造一个「已完成」。
 * 2. **恢复即重校验**：`restoreOrderLifecycleTracker` 把每条观测重新过一遍
 *    完整性 / 匹配 / 流转闸门（见 `OrderLifecycleTracker.hydrate`）；
 *    被篡改或换单的快照在恢复时**直接抛错**。
 * 3. **恢复不发请求、不下单**：恢复只重建本地状态。要继续跟踪必须由调用方
 *    显式 `resumeAfterDisconnect(port)`——先查原单，绝不重下。
 *
 * ## 序列化边界
 *
 * 快照是**纯数据、可 JSON 化**的；本模块只做「对象 ⇄ JSON 文本」的搬运，
 * **不决定介质**（文件 / SQLite / KeyValue 由宿主提供）。任何长期凭据、
 * 账号明文、地址都**不属于**本快照——这里只有脱敏引用。
 */

import { OrderSnapshotError } from './errors.js';
import { OrderLifecycleTracker, reviveOrderIntent } from './lifecycle.js';
import type { OrderStatusRegistry } from './status-map.js';
import type { OrderIntent, OrderLifecycleView, OrderQueryResult } from './types.js';

/**
 * 快照格式版本。
 *
 * 恢复时**严格等于**本值才接受；不做「向前兼容」的静默迁移——一份
 * 结构不同的旧快照宁可拒绝，也不能被猜着读成一份「差不多」的订单状态。
 */
export const ORDER_LIFECYCLE_SNAPSHOT_VERSION = 1;

/**
 * 可序列化的跟踪器快照。
 *
 * `observations` 是**原始查询结果**（事实），不是阶段报告（结论）；
 * 派生视图在恢复时重算。
 */
export interface OrderLifecycleSnapshot {
  readonly version: number;
  /** 本地下单意图（含原 externalId；`null` 表示本地还没有可核验的下单回执）。 */
  readonly intent: OrderIntent;
  /** 已通过校验的查询结果序列（按时间顺序）。 */
  readonly observations: readonly OrderQueryResult[];
  /** 重启前的阻断原因；未阻断为 `null`。 */
  readonly blockedReason: string | null;
}

/**
 * 由一张**已通过校验的视图**还原出它对应的原始查询结果。
 *
 * 视图里的派生字段（`stages` / `statusRecognized`）**刻意不读**：
 * 它们会由恢复时的 `buildOrderLifecycleView` 重新计算，避免把结论当事实搬运。
 */
function viewToQueryResult(view: OrderLifecycleView): OrderQueryResult {
  return Object.freeze({
    externalId: view.externalId,
    accountRef: view.accountRef,
    amountMinor: view.amountMinor,
    currency: view.currency,
    rawStatusCode: view.rawStatusCode,
    refundStatusCode: view.refund.sourceCode,
    refundAmountMinor: view.refund.amountMinor,
    observedAt: view.observedAt,
    evidenceRef: view.evidenceRef,
  });
}

/**
 * 把一个跟踪器当前状态打成快照（纯数据、JSON 可化、冻结副本）。
 *
 * 传入 `blockedReason` 会把阻断状态一并带上——重启后不会「因为杀进程而解除阻断」。
 */
export function snapshotOrderLifecycleTracker(tracker: OrderLifecycleTracker): OrderLifecycleSnapshot {
  return Object.freeze({
    version: ORDER_LIFECYCLE_SNAPSHOT_VERSION,
    intent: tracker.intent,
    observations: Object.freeze(tracker.history.map(viewToQueryResult)),
    blockedReason: tracker.blockedReason,
  });
}

/** 把快照对象序列化成 JSON 文本（介质由宿主决定）。 */
export function serializeOrderLifecycleSnapshot(snapshot: OrderLifecycleSnapshot): string {
  return JSON.stringify(snapshot);
}

/**
 * 由一份**已落地的下单意图**打出「尚未观测」的初始快照。
 *
 * 这是本包与上游（下单）之间的落盘缝：下单回执确认后，上游把
 * `{orderIntentRef, externalId, accountRef, amountMinor, currency}` 交给本函数，
 * 得到的快照**立即可序列化落盘**。后台 / 杀进程 / 重启后：
 *
 * ```text
 * snapshotForPersistedIntent(persisted) → serialize → (介质) → parse → restore
 *   → tracker.trackable === true，intent 与原单逐项一致
 *   → tracker.resumeAfterDisconnect(port)（只查原 externalId，不重下）
 * ```
 *
 * 入参接受 `unknown`（它来自持久化介质，不能信任类型标注），并在入口处
 * {@link reviveOrderIntent} fail-closed 校验；空观测 + `blockedReason: null` 是
 * 「事实为零」的诚实快照——本函数**不预测**任何订单状态，也不凭证「已下单成功」。
 *
 * 与携带更多字段的上游记录（如提交记录）**结构兼容**：只取五个字段，多出来的忽略。
 *
 * @throws {OrderValidationError} 持久化意图结构或取值不合法。
 */
export function snapshotForPersistedIntent(value: unknown): OrderLifecycleSnapshot {
  return Object.freeze({
    version: ORDER_LIFECYCLE_SNAPSHOT_VERSION,
    intent: reviveOrderIntent(value),
    observations: Object.freeze([] as OrderQueryResult[]),
    blockedReason: null,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 校验一份**未知**值是不是结构合法的快照。
 *
 * 只做**结构 / 版本**级校验；意图与观测量的**语义**（金额、匹配、流转）
 * 由 `restoreOrderLifecycleTracker` → `hydrate` 在恢复时把关。
 *
 * @throws {OrderSnapshotError} 版本不符或结构缺失。
 */
export function assertOrderLifecycleSnapshot(value: unknown): OrderLifecycleSnapshot {
  if (!isRecord(value)) {
    throw new OrderSnapshotError(`快照必须是一个对象，收到 ${Array.isArray(value) ? '数组' : typeof value}`);
  }
  const version = value.version;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new OrderSnapshotError(`快照版本字段必须是整数，收到 ${String(version)}`);
  }
  if (version !== ORDER_LIFECYCLE_SNAPSHOT_VERSION) {
    throw new OrderSnapshotError(
      `快照版本不符：快照为 ${version}，本实现只接受 ${ORDER_LIFECYCLE_SNAPSHOT_VERSION}；不得跨版本静默迁移`,
    );
  }
  if (!isRecord(value.intent)) {
    throw new OrderSnapshotError('快照缺少 intent 对象');
  }
  // 意图在持久化边界就校验，而不是拖到 hydrate：一份「intent 缺字段 / 金额是小数 /
  // 币种小写」的快照是**坏快照**，不能等恢复半程才炸。这里统一成 OrderSnapshotError。
  let intent: OrderIntent;
  try {
    intent = reviveOrderIntent(value.intent);
  } catch (error) {
    throw new OrderSnapshotError(
      `快照 intent 不合法：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(value.observations)) {
    throw new OrderSnapshotError('快照缺少 observations 数组');
  }
  for (const [index, entry] of value.observations.entries()) {
    if (!isRecord(entry)) {
      throw new OrderSnapshotError(`快照 observations[${index}] 不是对象`);
    }
  }
  const blockedReason = value.blockedReason;
  if (blockedReason !== null && typeof blockedReason !== 'string') {
    throw new OrderSnapshotError('快照 blockedReason 既不是 null 也不是字符串');
  }
  return Object.freeze({
    version,
    intent,
    observations: Object.freeze(value.observations as unknown as OrderQueryResult[]),
    blockedReason,
  });
}

/**
 * 从 JSON 文本解析出快照（结构校验）。
 *
 * @throws {OrderSnapshotError} 不是合法 JSON 或结构不符。
 */
export function parseOrderLifecycleSnapshot(text: string): OrderLifecycleSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new OrderSnapshotError(`快照不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  return assertOrderLifecycleSnapshot(parsed);
}

/**
 * 从快照恢复一个跟踪器（**落盘/恢复的落地入口**）。
 *
 * 恢复会把每条观测重新过一次在线闸门；被篡改/换单的快照会抛领域错误
 * （`OrderMismatchError` / `IllegalTransitionError` / `OrderResultIntegrityError`），
 * 版本或结构问题抛 `OrderSnapshotError`。恢复**不发任何网络请求**。
 *
 * `registry` 是重放快照里原始状态码所用的注册表；**必须与打快照时同一份**，
 * 否则同一批事实会被另一套词汇重新解释（缺省为 fixture 本地词汇表）。
 *
 * @throws {OrderSnapshotError} 结构 / 版本 / 意图不合法。
 * @throws {OrderMismatchError} 快照里的观测与意图不匹配。
 * @throws {IllegalTransitionError} 快照里的观测序列非法。
 * @throws {OrderResultIntegrityError} 快照里的观测形状不合法。
 */
export function restoreOrderLifecycleTracker(
  snapshot: unknown,
  registry?: OrderStatusRegistry,
): OrderLifecycleTracker {
  const validated = assertOrderLifecycleSnapshot(snapshot);
  return OrderLifecycleTracker.hydrate({
    intent: validated.intent,
    observations: validated.observations,
    blockedReason: validated.blockedReason,
    registry,
  });
}

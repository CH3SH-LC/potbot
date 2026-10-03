/**
 * M-I18 落盘下单意图 —— 生成 / 序列化 / 解析 / 恢复，以及 M07 → M09 的两条桥。
 *
 * ## 落盘/恢复的落地缝（对照 M09 集成请求 #2）
 *
 * ```text
 * M07 提交记录（state=confirmed, providerOrderRef=平台单号）
 *   └─ persistedOrderIntentFromSubmission(record)
 *        └─ PersistedOrderIntent（可 serialize 落盘）
 *             ├─ serializePersistedOrderIntent → (磁盘 / KeyValue / SQLite，由宿主决定)
 *             ├─ parsePersistedOrderIntent      ← 读回，逐字段 + 指纹校验（篡改即拒）
 *             ├─ restorePersistedOrderIntent    ← 恢复入口：纯本地，不发任何请求
 *             └─ restoreLifecycleTrackerFromIntent → M09 跟踪器
 *                   └─ resumeAfterDisconnect(port) ← 先查原 externalId，绝不重下
 * ```
 *
 * ## 三条硬约束（本文件逐条落地）
 *
 * 1. **是事实，不是授权**：入口 {@link createPersistedOrderIntent} 与恢复
 *    {@link assertPersistedOrderIntent} 都会拒绝携带授权标记字段的对象
 *    （`grantId` / `consumed` / `expiresAt` …），见 `./types.js` 的标记表。
 * 2. **篡改即拒**：恢复重算指纹，`amountMinor` +1 或 `externalId` 被换都在恢复期
 *    抛 {@link import('./errors.js').OrderIntentIntegrityError}，绝不「按改后的值继续」。
 * 3. **恢复不发网络**：{@link restorePersistedOrderIntent} 与
 *    {@link restoreLifecycleTrackerFromIntent} 都是**同步**、**不接端口**的纯本地函数；
 *    要联网只能由调用方另行显式 `resumeAfterDisconnect(port)`。
 */

import {
  OrderIntentGrantShapeError,
  OrderIntentIntegrityError,
  PersistedOrderIntentError,
} from './errors.js';
import { computeOrderIntentIntegrityRef } from './fingerprint.js';
import {
  ORDER_INTENT_AUTHORIZATION_MARKERS,
  PERSISTED_ORDER_INTENT_KIND,
  PERSISTED_ORDER_INTENT_VERSION,
} from './types.js';
import type { PersistedOrderIntent } from './types.js';

import { restoreOrderLifecycleTracker } from '../order-lifecycle/index.js';
import { reviveOrderIntent } from '../order-lifecycle/index.js';
import type {
  OrderIntent,
  OrderLifecycleSnapshot,
  OrderLifecycleTracker,
  OrderQueryResult,
  OrderStatusRegistry,
} from '../order-lifecycle/index.js';

import { isOrderSubmissionState, mayClaimOrderPlaced } from '../order-submit/index.js';
import type { OrderSubmissionRecord } from '../order-submit/index.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 输入对象（含其 `intent` 内层）里出现的授权标记字段（去重排序）。 */
function grantMarkersIn(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }
  const markers = new Set<string>();
  for (const key of Object.keys(value)) {
    if ((ORDER_INTENT_AUTHORIZATION_MARKERS as readonly string[]).includes(key)) {
      markers.add(key);
    }
  }
  return [...markers].sort();
}

/**
 * 拒绝任何**看起来像授权**的对象（顶层或 `intent` 内层带授权标记字段）。
 *
 * @throws {OrderIntentGrantShapeError} 输入携带授权标记字段。
 */
function assertNotAuthorizationGrantLike(value: unknown): void {
  const markers = new Set<string>([...grantMarkersIn(value)]);
  if (isRecord(value)) {
    for (const marker of grantMarkersIn(value.intent)) {
      markers.add(marker);
    }
  }
  if (markers.size > 0) {
    throw new OrderIntentGrantShapeError([...markers].sort());
  }
}

function asOpaqueRef(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PersistedOrderIntentError(`${label} 必须是非空字符串（不透明引用，不是凭据）`);
  }
  return value;
}

/** 把 M09 的意图校验错误统一成本包错误词汇（保留原始说明）。 */
function reviveIntent(value: unknown): OrderIntent {
  try {
    return reviveOrderIntent(value);
  } catch (error) {
    throw new PersistedOrderIntentError(
      `意图五字段不合法：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 构造 `PersistedOrderIntent` 的输入（五字段 + 溯源引用）。 */
export interface CreatePersistedOrderIntentInput {
  readonly orderIntentRef: string;
  readonly externalId: string | null;
  readonly accountRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** 上游事实的溯源引用（例如 M07 幂等键）；不透明引用，不是凭据。 */
  readonly subjectRef: string;
}

/**
 * 构造一份落盘下单意图（fact record，**不是授权**）。
 *
 * 五字段的合法性与 M09 完全同源（`amountMinor` 为整数最小单位、`currency` 为三个
 * 大写字母）：本函数委托 M09 的 `reviveOrderIntent` 校验，避免两套口径漂移。
 * `subjectRef` 只做非空校验；带授权标记字段者在此被拒。
 *
 * @throws {OrderIntentGrantShapeError} 输入携带授权标记字段。
 * @throws {PersistedOrderIntentError} 五字段 / `subjectRef` 不合法。
 */
export function createPersistedOrderIntent(input: unknown): PersistedOrderIntent {
  if (!isRecord(input)) {
    throw new PersistedOrderIntentError(
      `意图输入必须是对象，收到 ${Array.isArray(input) ? '数组' : input === null ? 'null' : typeof input}`,
    );
  }
  assertNotAuthorizationGrantLike(input);
  const intent = reviveIntent(input);
  const subjectRef = asOpaqueRef(input.subjectRef, 'subjectRef');
  return Object.freeze({
    version: PERSISTED_ORDER_INTENT_VERSION,
    kind: PERSISTED_ORDER_INTENT_KIND,
    intent,
    subjectRef,
    integrityRef: computeOrderIntentIntegrityRef({ intent, subjectRef }),
    observations: Object.freeze([] as OrderQueryResult[]),
    blockedReason: null,
  });
}

/**
 * 校验一份**未知**值是不是结构合法的落盘意图记录。
 *
 * 校验顺序：判别值（kind）→ 版本 → 「不是授权」→ 五字段 → 溯源引用 →
 * 「只存事实」（观测必须为空、未阻断）→ 指纹比对。任一不通过都抛错，
 * **绝不「尽力修复」出一份看似正常的意图**。
 *
 * @throws {OrderIntentGrantShapeError} 记录携带授权标记字段。
 * @throws {PersistedOrderIntentError} 结构 / 版本 / kind / 事实约束不合法。
 * @throws {OrderIntentIntegrityError} 指纹对不上（内容被改动）。
 */
export function assertPersistedOrderIntent(value: unknown): PersistedOrderIntent {
  if (!isRecord(value)) {
    throw new PersistedOrderIntentError(
      `落盘意图必须是对象，收到 ${Array.isArray(value) ? '数组' : value === null ? 'null' : typeof value}`,
    );
  }
  if (value.kind !== PERSISTED_ORDER_INTENT_KIND) {
    throw new PersistedOrderIntentError(
      `落盘意图 kind 必须是 '${PERSISTED_ORDER_INTENT_KIND}'，收到 ${JSON.stringify(value.kind)}；` +
        '本记录是事实、不是授权，也不是其它任何形状的快照',
    );
  }
  if (value.version !== PERSISTED_ORDER_INTENT_VERSION) {
    throw new PersistedOrderIntentError(
      `落盘意图版本必须是 ${PERSISTED_ORDER_INTENT_VERSION}，收到 ${JSON.stringify(value.version)}；` +
        '不得跨版本静默迁移',
    );
  }
  assertNotAuthorizationGrantLike(value);
  const intent = reviveIntent(value.intent);
  const subjectRef = asOpaqueRef(value.subjectRef, 'subjectRef');

  if (!Array.isArray(value.observations)) {
    throw new PersistedOrderIntentError('落盘意图的 observations 必须是数组（且为空）');
  }
  if (value.observations.length > 0) {
    throw new PersistedOrderIntentError(
      '落盘意图只记事实、不记结论：observations 必须为空；阶段结论由 M09 恢复后重新查原单得出',
    );
  }
  if (value.blockedReason !== null) {
    throw new PersistedOrderIntentError(
      '落盘意图是「尚未开始观测」的初始事实：blockedReason 必须为 null（阻断属于 M09 跟踪期）',
    );
  }
  if (typeof value.integrityRef !== 'string' || value.integrityRef.length === 0) {
    throw new PersistedOrderIntentError('落盘意图缺少 integrityRef（完整性指纹）');
  }
  const expected = computeOrderIntentIntegrityRef({ intent, subjectRef });
  if (value.integrityRef !== expected) {
    throw new OrderIntentIntegrityError(
      expected,
      value.integrityRef,
      '落盘字节可能被改动（金额 / 单号 / 溯源引用与指纹不一致），恢复整体拒绝',
    );
  }
  return Object.freeze({
    version: PERSISTED_ORDER_INTENT_VERSION,
    kind: PERSISTED_ORDER_INTENT_KIND,
    intent,
    subjectRef,
    integrityRef: expected,
    observations: Object.freeze([] as OrderQueryResult[]),
    blockedReason: null,
  });
}

/** 把落盘意图序列化为 JSON 文本（介质由宿主决定）。 */
export function serializePersistedOrderIntent(intent: PersistedOrderIntent): string {
  const validated = assertPersistedOrderIntent(intent);
  return JSON.stringify({
    version: validated.version,
    kind: validated.kind,
    intent: validated.intent,
    subjectRef: validated.subjectRef,
    integrityRef: validated.integrityRef,
    observations: [],
    blockedReason: null,
  });
}

/**
 * 从 JSON 文本或已解析对象解析出一份落盘意图（严格校验 + 指纹比对）。
 *
 * @throws {PersistedOrderIntentError} 不是合法 JSON 或结构不符。
 * @throws {OrderIntentGrantShapeError} 记录携带授权标记字段。
 * @throws {OrderIntentIntegrityError} 指纹对不上。
 */
export function parsePersistedOrderIntent(input: unknown): PersistedOrderIntent {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (error) {
      throw new PersistedOrderIntentError(
        `落盘意图不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return assertPersistedOrderIntent(raw);
}

/**
 * 恢复入口（落盘/恢复的落地调用点）：解析 + 全量校验，**纯本地、同步、不发网络**。
 *
 * 恢复**只**重建本地意图；要继续跟踪必须由调用方对 M09 显式
 * `resumeAfterDisconnect(port)`（先查原单、绝不重下）。本函数没有端口参数，
 * 结构上不可能发起任何请求。
 */
export function restorePersistedOrderIntent(input: unknown): PersistedOrderIntent {
  return parsePersistedOrderIntent(input);
}

/**
 * M07 → M09 桥（一）：由一条 M07 提交记录派生出可跟踪的落盘意图。
 *
 * 只有**已确认下单**（`state === 'confirmed'`，即 `mayClaimOrderPlaced` 为真）且
 * 携带非空 `providerOrderRef`（平台订单号）的提交记录才能派生：这两条是
 * 「本地有可核验的 externalId」的判据；没有它，重启后就没有原单可查，
 * 派生一份意图只会得到一个无法跟踪的空壳（`resumeAfterDisconnect` 会直接拒绝）。
 *
 * 派生映射（`providerOrderRef` 即 M09 的 `externalId`）：
 * - `orderIntentRef` ← 由幂等键确定性派生（同一条提交恒得同一意图引用）；
 * - `externalId`     ← `providerOrderRef`；
 * - `amountMinor`    ← M07 `amount`（同为整数最小单位）；
 * - `subjectRef`     ← 幂等键（溯源，不是凭据）。
 *
 * @throws {PersistedOrderIntentError} 记录未确认、缺 providerOrderRef 或字段不合法。
 */
export function persistedOrderIntentFromSubmission(record: OrderSubmissionRecord): PersistedOrderIntent {
  if (!isRecord(record)) {
    throw new PersistedOrderIntentError(`提交记录必须是对象，收到 ${typeof record}`);
  }
  const state = (record as { readonly state?: unknown }).state;
  if (!isOrderSubmissionState(state) || !mayClaimOrderPlaced(state)) {
    throw new PersistedOrderIntentError(
      `只有已确认下单（confirmed）的提交记录才能派生可跟踪的落盘意图；收到 state=${JSON.stringify(state)}。` +
        '未确认的结果没有可核验的平台单号，重启后无法跟踪',
    );
  }
  const providerOrderRef = (record as { readonly providerOrderRef?: unknown }).providerOrderRef;
  if (typeof providerOrderRef !== 'string' || providerOrderRef.length === 0) {
    throw new PersistedOrderIntentError(
      '已确认下单的提交记录必须携带非空 providerOrderRef（平台订单号），否则没有可核验的 externalId',
    );
  }
  const idempotencyKey = asOpaqueRef(
    (record as { readonly idempotencyKey?: unknown }).idempotencyKey,
    'idempotencyKey',
  );
  return createPersistedOrderIntent({
    orderIntentRef: `oi:${idempotencyKey}`,
    externalId: providerOrderRef,
    accountRef: record.accountRef,
    amountMinor: record.amount,
    currency: record.currency,
    subjectRef: idempotencyKey,
  });
}

/**
 * M07 → M09 桥（二）：把落盘意图投影成 M09 生命周期快照（结构兼容）。
 *
 * 只产出 M09 `OrderLifecycleSnapshot` 的四个必需字段；因为
 * {@link PersistedOrderIntent} 本就是该快照的超集，这一步同时是
 * 「本记录可被 M09 原生恢复入口接受」的显式证明。
 */
export function toLifecycleSnapshot(intent: PersistedOrderIntent): OrderLifecycleSnapshot {
  const validated = assertPersistedOrderIntent(intent);
  return Object.freeze({
    version: validated.version,
    intent: validated.intent,
    observations: Object.freeze([] as OrderQueryResult[]),
    blockedReason: validated.blockedReason,
  });
}

/**
 * M07 → M09 桥（三）：由落盘意图恢复出一个 M09 跟踪器（**纯本地、不发网络**）。
 *
 * 恢复后跟踪器 `trackable === true`、历史为空、意图与原单逐项一致；
 * 要继续跟踪必须由调用方 `resumeAfterDisconnect(port)`。`registry` 透传给 M09，
 * 与在线路径用同一套状态码词表。
 */
export function restoreLifecycleTrackerFromIntent(
  input: unknown,
  registry?: OrderStatusRegistry,
): OrderLifecycleTracker {
  const persisted = restorePersistedOrderIntent(input);
  return restoreOrderLifecycleTracker(toLifecycleSnapshot(persisted), registry);
}

/** 该值是否是一份结构合法且未被改动的落盘意图（不抛异常的便捷判定）。 */
export function isPersistedOrderIntent(value: unknown): value is PersistedOrderIntent {
  try {
    assertPersistedOrderIntent(value);
    return true;
  } catch {
    return false;
  }
}

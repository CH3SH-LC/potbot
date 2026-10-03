/**
 * M-I18 落盘下单意图 —— 类型与边界常量（零依赖、纯数据）。
 *
 * ## 这条缝要解决什么（M09 集成请求 #2：M07 → M09）
 *
 * M07（下单提交）确认下单后手里有平台订单号（`providerOrderRef`）与九项绑定；
 * M09（订单生命周期）需要一个**已落地的下单意图**
 * `{orderIntentRef, externalId, accountRef, amountMinor, currency}` 才能
 * 「重启后仍跟踪原单、绝不重下」。中间缺一份**可序列化、可恢复、可被篡改时拒绝**
 * 的落盘记录——本模块补上这一份。
 *
 * ## 一、这是「事实」，不是「授权」（本包最重要的命名约束）
 *
 * 本包产出的类型刻意**不叫** `AuthorizationGrant` / `AuthorizationRef`，也不带
 * `grantId` / `consumed` / `expiresAt` 之类的授权字段：它是**已发生事实**的记录
 * （「我们确曾下过这一单」），**不能**被用来授权一次新提交、不能被占用、不能重放。
 * 看到名字就应明白它不是凭证。载入时若发现授权标记字段，直接
 * {@link import('./errors.js').OrderIntentGrantShapeError} 拒绝。
 *
 * ## 二、与 M09 快照**结构兼容**
 *
 * {@link PersistedOrderIntent} 含有 M09 `OrderLifecycleSnapshot` 的全部必需字段
 * （`version` / `intent` / `observations` / `blockedReason`），另加三个本模块自持的
 * 字段（`kind` / `subjectRef` / `integrityRef`）。因此本模块的记录可以**原样**交给
 * M09 的 `restoreOrderLifecycleTracker`（它只读那四个字段，多余字段忽略）。
 * 而本模块在恢复时会额外校验那三个字段，补上 M09 裸意图快照（无观测、无可比对项）
 * 时无法察觉的**意图字段被改动**。
 *
 * ## 三、只存意图、不存结论
 *
 * `observations` 恒为空数组、`blockedReason` 恒为 `null`：本记录是「尚未开始观测的
 * 初始意图」。阶段结论永远由 M09 在恢复后**重新查原单**得出，不在这里落盘。
 */

import type { OrderIntent, OrderLifecycleSnapshot, OrderQueryResult } from '../order-lifecycle/index.js';

/**
 * 落盘意图快照版本。
 *
 * 恢复时**严格等于**本值才接受；不做「向前兼容」的静默迁移——一份结构不同的旧记录
 * 宁可拒绝，也不能被猜着读成一份「差不多」的下单意图。
 *
 * 与 M09 `ORDER_LIFECYCLE_SNAPSHOT_VERSION` 取值相同（同为 1），因为本记录**就是**
 * 一份合法的 M09 生命周期快照（见文件头「结构兼容」）。
 */
export const PERSISTED_ORDER_INTENT_VERSION = 1 as const;

/**
 * 落盘意图记录的判别字段。
 *
 * 它是一个**事实记录**判别值（不是授权）。恢复时严格相等才接受；一个写着
 * `authorization-grant` 或其它值的对象永远读不成一份下单意图。
 */
export const PERSISTED_ORDER_INTENT_KIND = 'order-intent-fact' as const;

/**
 * 落盘下单意图记录（纯数据、JSON 可序列化、冻结）。
 *
 * `intent` 就是 M09 的五字段意图，因此本记录**扩展**了 `OrderLifecycleSnapshot`：
 * 它满足该快照的全部必需字段，可直接喂给 M09 的恢复入口。
 */
export interface PersistedOrderIntent extends OrderLifecycleSnapshot {
  readonly version: typeof PERSISTED_ORDER_INTENT_VERSION;
  /** 事实记录判别值；不是授权。 */
  readonly kind: typeof PERSISTED_ORDER_INTENT_KIND;
  /** M09 五字段下单意图（含原 externalId；`null` 表示尚无可核验的下单回执）。 */
  readonly intent: OrderIntent;
  /**
   * 溯源引用：这份意图由哪条上游事实派生而来（本模块用 M07 的幂等键）。
   * **不透明引用，不是凭据**，也不授权任何事情；仅用于把意图与上游提交对上账。
   */
  readonly subjectRef: string;
  /**
   * 五字段 + `subjectRef` 的确定性指纹（非密钥；见 `./fingerprint.js`）。
   * 恢复时重算比对，发现**意外损坏 / 朴素编辑**（金额 +1、externalId 被换）。
   */
  readonly integrityRef: string;
  /** **恒为空**：落盘意图只记事实，阶段结论由 M09 恢复后重查得出。 */
  readonly observations: readonly OrderQueryResult[];
  /** **恒为 null** 的初始值；阻断状态属于 M09 跟踪期，不属于一条初始意图。 */
  readonly blockedReason: string | null;
}

/**
 * 被视为「授权」的标记字段名。
 *
 * 任一出现在输入对象顶层或 `intent` 内层，输入即被判定为**授权形状**而拒绝：
 * 本模块记录的是事实，不该与凭证字段同处一份落盘记录。
 */
export const ORDER_INTENT_AUTHORIZATION_MARKERS = [
  'grantId',
  'grantedBy',
  'expiresAt',
  'consumed',
  'consumedAt',
  'consumedByKey',
  'authorizationRef',
  'authorizationGrant',
] as const;

export type OrderIntentAuthorizationMarker = (typeof ORDER_INTENT_AUTHORIZATION_MARKERS)[number];

/**
 * 落盘意图边界常量（**结构性声明，不是开关**）。
 *
 * 让下游接线者一眼看到：本包产出的对象是**事实记录**，不是凭证——
 * 它不授权、不可重放、不发网络请求、也不合并出任何结论。
 */
export const ORDER_INTENT_BOUNDARY = Object.freeze({
  /** 本记录是授权凭证（`AuthorizationGrant` / `AuthorizationRef`）。 */
  isAuthorizationGrant: false,
  /** 本记录可被用来授权一次新的下单提交。 */
  canAuthorizeSubmit: false,
  /** 本记录可被占用（consumed）。 */
  consumable: false,
  /** 本记录可被重放以重新下单。 */
  replayable: false,
  /** 恢复本记录的过程会发起网络请求。 */
  performsNetwork: false,
  /** 本记录携带任何阶段结论（观测 / 阻断）。 */
  carriesConclusions: false,
  note:
    'M-I18 落盘下单意图只是「我们确曾下过这一单」的事实记录：无授权语义、不可消费、不可重放、' +
    '恢复纯本地。要继续跟踪必须由调用方对 M09 显式 resumeAfterDisconnect（先查原单，绝不重下）。',
} as const);

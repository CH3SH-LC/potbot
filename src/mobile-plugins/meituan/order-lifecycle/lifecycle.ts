/**
 * 订单生命周期跟踪器：查询 → 匹配校验 → 流转合法性 → 记录。
 *
 * ## 断线后先查询原单
 *
 * {@link OrderLifecycleTracker.resumeAfterDisconnect} **只**做一件事：
 * 用本地已核验的**原 externalId** 去查那一单，然后走同一条匹配/流转闸门。
 * 它**没有**任何「重新下单」或「按金额/时间猜一单」的路径：
 * - 本地没有 externalId ⇒ 直接拒绝（不许猜）；
 * - 查回来的 externalId 与原单不符 ⇒ 报不匹配并阻断跟踪。
 *
 * ## 不匹配不得继续跟踪
 *
 * 四个字段（externalId / 账号 / 金额 / 币种）任一不符 ⇒ 抛
 * {@link OrderMismatchError}，跟踪器进入 **blocked**：之后的 observe / poll /
 * resume 一律抛 {@link OrderTrackingBlockedError}，直到调用方显式
 * `acknowledge()`。这是「不得继续跟踪」的结构化落地，而不是一句注释。
 *
 * ## 流转异常同样阻断
 *
 * 观测之间出现状态回退或终态反复 ⇒ 抛 {@link IllegalTransitionError} 并同样阻断：
 * 一个会倒退的订单，继续跟下去只会得到更假的结论。
 */

import {
  IllegalTransitionError,
  OrderMismatchError,
  OrderTrackingBlockedError,
  OrderValidationError,
  UnknownOrderStatusError,
} from './errors.js';
import { asCurrencyCode, asMinorUnits, asNonEmptyString } from './money.js';
import { matchOrderToIntent } from './match.js';
import { FIXTURE_ORDER_STATUS_REGISTRY, buildOrderLifecycleView } from './status-map.js';
import type { OrderStatusRegistry } from './status-map.js';
import { checkProgression } from './transitions.js';
import type {
  OrderIntent,
  OrderLifecycleView,
  OrderQueryPort,
  OrderQueryReason,
  OrderQueryRequest,
  OrderQueryResult,
} from './types.js';

/** 跟踪器构造参数。 */
export interface OrderLifecycleTrackerOptions {
  /** 本地下单意图：查询结果必须与它逐项对上。 */
  readonly intent: OrderIntent;
  /**
   * 解释平台状态码的注册表（登记缝）。缺省为 fixture 本地词汇表；
   * 宿主核验出真实码表后注入即可，跟踪器的匹配/流转/落盘纪律不变。
   */
  readonly registry?: OrderStatusRegistry;
}

/**
 * 校验并冻结一个本地意图。
 *
 * 接受 `unknown`——因为意图可能来自**持久化介质**（JSON / KeyValue / SQLite，
 * 由宿主读写），恢复时不能信任磁盘字节。任何字段缺失、类型不符、金额非整数最小单位、
 * 币种不是三个大写字母都**立即抛错**（fail-closed），绝不「尽力补一个默认值」。
 *
 * 这是「已落地的下单意图」与本包之间的**唯一登记口**：它只读取
 * `orderIntentRef / externalId / accountRef / amountMinor / currency` 五个字段，
 * 因而与携带更多字段的上游记录（如 M07 的提交记录）**结构兼容**——多出来的字段被忽略，
 * 而不是让整条意图被判非法。
 *
 * `externalId` 允许为 `null`：表示本地还没有可核验的下单回执；此时断线后不得凭猜测跟踪。
 *
 * @throws {OrderValidationError} 意图结构或取值不合法。
 */
export function reviveOrderIntent(value: unknown): OrderIntent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OrderValidationError(
      `本地意图必须是一个对象，收到 ${value === null ? 'null' : Array.isArray(value) ? '数组' : typeof value}`,
    );
  }
  const record = value as Record<string, unknown>;
  return Object.freeze({
    orderIntentRef: asNonEmptyString(record.orderIntentRef, 'orderIntentRef'),
    externalId: record.externalId === null ? null : asNonEmptyString(record.externalId, 'externalId'),
    accountRef: asNonEmptyString(record.accountRef, 'accountRef'),
    amountMinor: asMinorUnits(record.amountMinor, 'intent.amountMinor'),
    currency: asCurrencyCode(record.currency, 'intent.currency'),
  });
}

/** 规范化并冻结一个意图（复用登记口，非法输入立即抛错）。 */
function normalizeIntent(intent: OrderIntent): OrderIntent {
  return reviveOrderIntent(intent);
}

/**
 * 订单生命周期跟踪器。
 *
 * 本类**没有**下单 / 支付 / 提交类方法，也不会有；`boundary.test.ts`
 * 会断言本包导出的符号里不存在这类能力。
 */
export class OrderLifecycleTracker {
  readonly #intent: OrderIntent;
  readonly #registry: OrderStatusRegistry;
  readonly #history: OrderLifecycleView[] = [];
  #view: OrderLifecycleView | null = null;
  #blockedReason: string | null = null;

  constructor(options: OrderLifecycleTrackerOptions) {
    this.#intent = normalizeIntent(options.intent);
    this.#registry = options.registry ?? FIXTURE_ORDER_STATUS_REGISTRY;
  }

  /**
   * 从**已持久化**的状态恢复一个跟踪器（落盘/恢复的落地入口）。
   *
   * 恢复**不是**信任磁盘字节：每条观测量都会**重新过一次**和在线时完全相同的
   * 三道闸门——形状完整性、与本地意图的匹配、观测之间的流转合法性。
   * 因此被篡改的快照（改了金额 / externalId / 状态码顺序）会在这里**直接抛错**，
   * 而不是被静默当成一份「看起来正常」的跟踪状态。
   *
   * 参数 `blockedReason` 用于把**重启前的阻断**一并恢复：这保证「杀进程躲过阻断」
   * 不成立——恢复回来的跟踪器仍然不可继续跟踪，直到显式 `acknowledge()`。
   *
   * 本方法**不发任何网络请求**：恢复只重建本地状态；要继续跟踪必须由调用方
   * 走 `resumeAfterDisconnect(port)`（先查原单）。
   *
   * @throws {OrderValidationError} 快照里的意图不合法。
   * @throws {OrderResultIntegrityError} 快照里的某条观测量形状不合法。
   * @throws {OrderMismatchError} 快照里的观测量与意图不匹配（被换单/改额）。
   * @throws {IllegalTransitionError} 快照里的观测序列违反流转规则。
   */
  static hydrate(input: {
    readonly intent: OrderIntent;
    readonly observations: readonly OrderQueryResult[];
    readonly blockedReason: string | null;
    /**
     * 解释快照里原始状态码的注册表。必须与**打快照时**用的是同一份，
     * 否则恢复出来的视图会用另一套词汇重算——`rawStatusCode` 是事实、没被篡改，
     * 但「这个码认不认识」会跟着注册表变。缺省为 fixture 本地词汇表。
     */
    readonly registry?: OrderStatusRegistry;
  }): OrderLifecycleTracker {
    const tracker = new OrderLifecycleTracker({ intent: input.intent, registry: input.registry });
    for (const observation of input.observations) {
      // 重放观测：任何与在线路径不同的地方都会在这里咬出来。
      tracker.observe(observation);
    }
    tracker.#blockedReason = input.blockedReason;
    return tracker;
  }

  get intent(): OrderIntent {
    return this.#intent;
  }

  /** 本跟踪器解释平台状态码所用的注册表（登记缝的当前生效值）。 */
  get registry(): OrderStatusRegistry {
    return this.#registry;
  }

  /** 最近一次**通过校验**的观测；从未成功观测过为 `null`。 */
  get view(): OrderLifecycleView | null {
    return this.#view;
  }

  /** 全部通过校验的观测（按时间顺序）。 */
  get history(): readonly OrderLifecycleView[] {
    return Object.freeze([...this.#history]);
  }

  /** 是否仍可继续跟踪（未被不匹配/异常流转阻断）。 */
  get trackable(): boolean {
    return this.#blockedReason === null;
  }

  /** 阻断原因；未阻断为 `null`。 */
  get blockedReason(): string | null {
    return this.#blockedReason;
  }

  /**
   * 观测一次查询结果：形状校验 → 匹配校验 → 推进合法性 → 记录。
   *
   * @throws {OrderResultIntegrityError} 结果形状不合法。
   * @throws {OrderMismatchError} 与本地意图不匹配（并**阻断**跟踪）。
   * @throws {IllegalTransitionError} 相对上次观测出现回退/终态反复（并**阻断**跟踪）。
   * @throws {OrderTrackingBlockedError} 已处于阻断状态。
   */
  observe(result: OrderQueryResult): OrderLifecycleView {
    this.#requireTrackable();
    const view = buildOrderLifecycleView(result, this.#registry);

    const match = matchOrderToIntent(result, this.#intent);
    if (!match.matched) {
      this.#blockedReason = match.detail;
      throw new OrderMismatchError(match.fields, match.detail);
    }

    if (this.#view !== null) {
      const check = checkProgression(this.#view, view);
      if (!check.legal) {
        this.#blockedReason = check.detail;
        // 以状态码原文作为两端标识，便于定位是哪两次观测对不上。
        throw new IllegalTransitionError(check.kind, this.#view.rawStatusCode, view.rawStatusCode, check.detail);
      }
    }

    this.#view = view;
    this.#history.push(view);
    return view;
  }

  /**
   * 断线后**先查询原单**：用原 externalId 向端口查询，再走 observe 的全部闸门。
   *
   * @throws {OrderValidationError} 本地意图没有 externalId（不许凭猜测跟踪）。
   * @throws {OrderMismatchError} 查回来的单与本地意图不符（并阻断）。
   */
  async resumeAfterDisconnect(port: OrderQueryPort): Promise<OrderLifecycleView> {
    return this.#query(port, 'resume_after_disconnect');
  }

  /** 常规轮询查询（同样只查原单）。 */
  async poll(port: OrderQueryPort): Promise<OrderLifecycleView> {
    return this.#query(port, 'poll');
  }

  /** 以「退款核对」为目的的查询（同样只查原单）。 */
  async refreshRefund(port: OrderQueryPort): Promise<OrderLifecycleView> {
    return this.#query(port, 'refund_check');
  }

  /**
   * 要求「状态已被识别」的结论。
   *
   * @throws {UnknownOrderStatusError} 尚未观测，或最近一次观测的状态码本地不认识。
   */
  requireRecognizedView(): OrderLifecycleView {
    const view = this.#view;
    if (view === null) {
      throw new OrderValidationError('尚无任何通过校验的观测，不能得出任何结论');
    }
    if (!view.statusRecognized) {
      throw new UnknownOrderStatusError(view.rawStatusCode);
    }
    return view;
  }

  /**
   * 处置一次不匹配/异常流转，解除阻断。
   *
   * 必须由调用方**显式**调用（通常是在用户/运维确认「这不是我们那一单」之后）。
   * 解除之后 `trackable` 恢复，但**历史观测保留**——不追溯修改既有证据。
   */
  acknowledge(): void {
    this.#blockedReason = null;
  }

  #requireTrackable(): void {
    if (this.#blockedReason !== null) {
      throw new OrderTrackingBlockedError(this.#blockedReason);
    }
  }

  async #query(port: OrderQueryPort, reason: OrderQueryReason): Promise<OrderLifecycleView> {
    this.#requireTrackable();
    const externalId = this.#intent.externalId;
    if (externalId === null) {
      throw new OrderValidationError(
        '本地意图没有 externalId（本地还没有可核验的下单回执）：断线后不得凭猜测跟踪，必须先重新确认订单',
      );
    }
    const request: OrderQueryRequest = Object.freeze({
      externalId,
      accountRef: this.#intent.accountRef,
      reason,
    });
    const result = await port.query(request);
    return this.observe(result);
  }
}

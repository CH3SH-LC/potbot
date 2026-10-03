/**
 * M07 下单提交状态机与幂等语义（零依赖、纯本地、执行器注入）。
 *
 * ## 三条不变量，各自有明确的落点
 *
 * 1. **没有可信授权引用不得提交**：`submit()` 第一步就是
 *    `assertTrustedAuthorizationRef`（`missing_authorization_ref` /
 *    `untrusted_authorization_ref`）。
 * 2. **同一幂等键只产生一单**：记录以幂等键为主键落在注入的
 *    {@link OrderSubmissionStore} 里。同键再次 `submit()`：
 *    - 已"落定"（`submitted`/`rejected`/`confirmed`/`cancelled`）⇒ **返回同一条记录**，
 *      不再调执行器（`deduplicated: true`，`executorCalled: false`）；
 *    - 已留下发出意图（在途 / `unknown`）⇒ **拒**（`already_sent_query_only`）；
 *    - 占用后未发出（崩在发出前）⇒ **续发同一条**记录（复用同一键，不新建）。
 * 3. **结果未知不得重放**：`unknown` 是非终态，但唯一合法动作是
 *    `queryOriginalOrder()`；再次 `submit()` 命中第 2 条的第二种分支。
 *
 * ## 发出记账的两个时刻（与 K07 同构）
 *
 * `sendIntentAt` 在**调用执行器之前**落账。因此并发第二次 `submit()` 必然看见它，
 * 从而被拒（而不是发出第二单）。执行器端口抛异常 = 发出途中进程死亡：异常**原样上抛**，
 * 记录停在 `submitting` + `sendIntentAt !== null`，交由 `recover()` 判为"已发出未知"。
 */

import { classifySubmitResponse, stateForOutcome } from './codes.js';
import { OrderSubmitError } from './errors.js';
import { assertTrustedAuthorizationRef, bindingOf } from './authorization.js';
import { buildOrderSubmitRequest, computeIdempotencyKey } from './idempotency.js';
import { isTrustedOrderReceipt } from './receipt.js';
import { createInMemoryOrderStore } from './store.js';
import type { QuoteClock } from '../cart/types.js';
import {
  ORDER_STATE_LABELS,
  canTransitionOrder,
  isTerminalOrderState,
  mayClaimOrderPlaced,
  type AuthorizationRef,
  type OrderExecutorPort,
  type OrderNetworkStatePort,
  type OrderOutcomeDescription,
  type OrderQueryPort,
  type OrderReceipt,
  type OrderRecoveryVerdict,
  type OrderSubmissionRecord,
  type OrderSubmissionStore,
  type OrderTransportResult,
} from './types.js';

export interface OrderSubmitterOptions {
  /** **必须注入**：本模块不持有任何时间源（过期判据全靠它）。 */
  readonly clock: QuoteClock;
  /** 真实提交执行器。缺省 / `null` ⇒ `submit()` 抛 `missing_executor`，且不留下发出痕迹。 */
  readonly executor?: OrderExecutorPort | null;
  /** 原单查询端口。缺省 / `null` ⇒ 结果未知时抛 `missing_order_query_port`（如实报缺）。 */
  readonly orderQuery?: OrderQueryPort | null;
  /** 提交记录存储。缺省用内存实现；注入共享存储即可模拟"重启后仍读到同一份记录"。 */
  readonly store?: OrderSubmissionStore;
  /**
   * 提交前的网络状态端口（与 M-R04 `NetworkMonitor` 结构兼容）。
   * 缺省 / `null` ⇒ 不做网络前置检查（旧行为）。注入后：离线时提交**拒绝发出**
   * （记录保持 not-sent 可续发），绝不记成"已发出未知"。
   */
  readonly network?: OrderNetworkStatePort | null;
}

export interface SubmitOrderInput {
  readonly authorization: AuthorizationRef;
  /** 幂等键。必须等于由授权确定性导出的键，否则 `idempotency_key_mismatch`。 */
  readonly idempotencyKey: string;
}

export interface SubmitOrderOutcome {
  readonly record: OrderSubmissionRecord;
  /** 是否命中既有记录（同键未再调执行器）。 */
  readonly deduplicated: boolean;
  /** 本次调用是否调用了执行器（幂等保证的核心观测量）。 */
  readonly executorCalled: boolean;
}

/** 如实描述一条提交的外部结果（`unknown` 就是"结果未知"，绝不美化）。 */
export function describeOrderOutcome(record: OrderSubmissionRecord): OrderOutcomeDescription {
  return Object.freeze({
    idempotencyKey: record.idempotencyKey,
    state: record.state,
    summary: ORDER_STATE_LABELS[record.state],
    placedClaimable: mayClaimOrderPlaced(record.state),
  });
}

export class OrderSubmitter {
  readonly #clock: QuoteClock;
  readonly #executor: OrderExecutorPort | null;
  readonly #orderQuery: OrderQueryPort | null;
  readonly #store: OrderSubmissionStore;
  readonly #network: OrderNetworkStatePort | null;

  constructor(options: OrderSubmitterOptions) {
    if (options === null || typeof options !== 'object' || options.clock === undefined) {
      throw new OrderSubmitError('invalid_submit_request', '构造提交器必须注入 clock');
    }
    this.#clock = options.clock;
    this.#executor = options.executor ?? null;
    this.#orderQuery = options.orderQuery ?? null;
    this.#store = options.store ?? createInMemoryOrderStore();
    this.#network = options.network ?? null;
  }

  // -------------------------------------------------------------------------
  // 提交
  // -------------------------------------------------------------------------

  /**
   * 提交下单。**同键最多产生一单**；未知态再次提交一律被拒。
   */
  async submit(input: SubmitOrderInput): Promise<SubmitOrderOutcome> {
    const ref = assertTrustedAuthorizationRef(input?.authorization);
    const binding = bindingOf(ref);
    const derivedKey = computeIdempotencyKey(binding);
    if (input?.idempotencyKey !== derivedKey) {
      throw new OrderSubmitError(
        'idempotency_key_mismatch',
        `幂等键必须由授权绑定确定性导出：期望 ${derivedKey}，收到 ${JSON.stringify(input?.idempotencyKey)}` +
          '（幂等键不可由调用方随手给，否则重启/双击会算出不同的键）',
      );
    }

    // 2) 同键已有记录 ⇒ 幂等分支（**绝不**再调执行器）。
    const existing = this.#store.getByKey(derivedKey);
    if (existing !== undefined) {
      return this.#resolveExisting(existing, ref);
    }

    // 3) 全新提交：一次性授权与期限先复核。
    if (ref.consumed) {
      throw new OrderSubmitError(
        'authorization_already_consumed',
        `授权 ${ref.grantId} 已被占用（${ref.consumedByKey ?? ''}）：一次性授权不得第二次占用`,
      );
    }
    const now = this.#clock.now();
    if (now >= ref.expiresAt) {
      throw new OrderSubmitError(
        'authorization_expired',
        `授权 ${ref.grantId} 已过期：当前 ${now} ≥ expiresAt ${ref.expiresAt}，不得提交`,
        'expiresAt',
      );
    }

    const record = this.#createRecord(ref, derivedKey, now);
    this.#store.put(record);
    return this.#send(record, ref);
  }

  /** 同键已有记录时的分支。 */
  #resolveExisting(existing: OrderSubmissionRecord, ref: AuthorizationRef): Promise<SubmitOrderOutcome> {
    // 已落定：返回同一条记录，绝不再下单。
    if (existing.state === 'submitted' || isTerminalOrderState(existing.state)) {
      return Promise.resolve({ record: existing, deduplicated: true, executorCalled: false });
    }
    // 已留下发出意图（在途 / unknown）：只能查原单，不得重放。
    if (existing.sendIntentAt !== null) {
      throw new OrderSubmitError(
        'already_sent_query_only',
        `幂等键 ${existing.idempotencyKey} 已在 ${existing.sendIntentAt} 留下发出意图（当前 ${existing.state}）：` +
          '结果未知时只能查原单（queryOriginalOrder），不得再次提交',
      );
    }
    // 占用后未发出（崩在发出前）：续发**同一条**记录（复用同一键，不新建）。
    // 但续发前**必须**复核期限：崩溃可能发生在授权到期之后，过期授权不得再发出。
    const now = this.#clock.now();
    if (now >= ref.expiresAt) {
      throw new OrderSubmitError(
        'authorization_expired',
        `续发时授权 ${ref.grantId} 已过期：当前 ${now} ≥ expiresAt ${ref.expiresAt}，不得续发`,
        'expiresAt',
      );
    }
    return this.#send(existing, ref);
  }

  /** 调用执行器一次，并落账结果。 */
  async #send(record: OrderSubmissionRecord, ref: AuthorizationRef): Promise<SubmitOrderOutcome> {
    const executor = this.#executor;
    if (executor === null) {
      // 缺执行器时**不写发出意图**：否则会把"没发出去"误记成"已发出未知"。
      throw new OrderSubmitError(
        'missing_executor',
        `未装配执行器：提交 ${record.idempotencyKey} 保持未发出，更不得判成功`,
      );
    }

    // ---- 网络前置：离线时拒绝发出 ----
    // 掉线的"发送"必须是"**没发出**"（记录保持 sendIntentAt=null，可续发同一条），
    // 绝不能记成"发出后未知"——那会凭空制造一次"可能已下单"。
    if (this.#network !== null && this.#network.isOnline() === false) {
      throw new OrderSubmitError(
        'submit_offline_not_sent',
        `设备离线：提交 ${record.idempotencyKey} 未发出（不是"已发出未知"）。` +
          '等网络恢复后续发同一条（recover() 判 not_sent → resume_same_submission），不得另建订单、不得另发授权',
      );
    }

    const attempt = record.attempt + 1;
    const request = buildOrderSubmitRequest(ref, this.#clock.now(), attempt);

    // ---- 意图先落账（在任何 await 之前）----
    const withIntent: OrderSubmissionRecord = Object.freeze({
      ...record,
      attempt,
      sendIntentAt: request.requestedAt,
      updatedAt: request.requestedAt,
    });
    this.#store.put(withIntent);

    // 端口抛错 = 发出途中死亡：异常继续上抛，记录停在"已发出意图"。
    const result: OrderTransportResult = await executor.send(request);

    const respondedAt = this.#clock.now();
    const classification = classifySubmitResponse(result, { nowMs: respondedAt });
    const httpStatus = result.transport === 'response' ? result.httpStatus : null;
    const businessCode = result.transport === 'response' ? result.businessCode : null;
    const providerOrderRef =
      result.transport === 'response' ? (result.providerOrderRef ?? null) : null;

    // ---- 可判定"从未发出"：回退为 not-sent（**绝不**记成 sent-unknown）----
    // 执行器回报 offline / 发出前失败 ⇒ 请求从未离开设备，不可能已在平台下单。
    // 因此把发出意图撤回到 null：recover() 判 not_sent → resume_same_submission（可续发同一条）。
    if (classification.notSent) {
      const notSentRecord: OrderSubmissionRecord = Object.freeze({
        ...withIntent,
        state: 'submitting' as const,
        sendIntentAt: null,
        outcomeKind: 'not_sent' as const,
        respondedAt,
        httpStatus,
        businessCode,
        providerOrderRef,
        failureReason: classification.reason,
        updatedAt: respondedAt,
      });
      this.#store.put(notSentRecord);
      return { record: notSentRecord, deduplicated: false, executorCalled: true };
    }

    const next: OrderSubmissionRecord = Object.freeze({
      ...withIntent,
      state: stateForOutcome(classification.kind),
      respondedAt,
      httpStatus,
      businessCode,
      outcomeKind: classification.kind,
      providerOrderRef,
      failureReason: classification.kind === 'success' ? null : classification.reason,
      updatedAt: respondedAt,
    });
    this.#store.put(next);
    return { record: next, deduplicated: false, executorCalled: true };
  }

  #createRecord(ref: AuthorizationRef, idempotencyKey: string, now: number): OrderSubmissionRecord {
    return Object.freeze({
      ...bindingOf(ref),
      grantId: ref.grantId,
      idempotencyKey,
      state: 'submitting' as const,
      attempt: 0,
      sendIntentAt: null,
      respondedAt: null,
      httpStatus: null,
      businessCode: null,
      outcomeKind: null,
      providerOrderRef: null,
      receipt: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  // -------------------------------------------------------------------------
  // 查原单 / 恢复
  // -------------------------------------------------------------------------

  /**
   * **查原单**：结果未知时的唯一合法动作。
   *
   * 端口返回 `null` ⇒ 状态不变（仍是未知，不猜、不改写成失败）。
   * 返回回执 ⇒ 校验可信后按状态机收口。
   */
  async queryOriginalOrder(
    idempotencyKey: string,
  ): Promise<{ readonly queried: boolean; readonly record: OrderSubmissionRecord }> {
    const record = this.#requireKey(idempotencyKey);
    if (isTerminalOrderState(record.state)) {
      return { queried: false, record };
    }
    const port = this.#orderQuery;
    if (port === null) {
      throw new OrderSubmitError(
        'missing_order_query_port',
        `未装配原单查询端口：提交 ${record.idempotencyKey} 状态未定时无法查原单（缺端口只能如实报未知，不得重下）`,
      );
    }
    const receipt = await port.query({
      idempotencyKey: record.idempotencyKey,
      actionId: record.actionId,
      grantId: record.grantId,
    });
    const current = this.#requireKey(idempotencyKey);
    if (receipt === null || receipt === undefined) {
      return { queried: true, record: current };
    }
    return { queried: true, record: this.#applyReceipt(current, receipt, this.#clock.now()) };
  }

  #applyReceipt(record: OrderSubmissionRecord, receipt: OrderReceipt, at: number): OrderSubmissionRecord {
    if (!isTrustedOrderReceipt(receipt)) {
      throw new OrderSubmitError(
        'untrusted_order_receipt',
        '该回执不是受控签发器产生的：客户端/模型自称 "observedState: confirmed" 无效' +
          '（假冒下单完成与 R245 的假批准同类）',
      );
    }
    if (receipt.idempotencyKey !== record.idempotencyKey) {
      throw new OrderSubmitError(
        'receipt_key_mismatch',
        `回执指向幂等键 ${receipt.idempotencyKey}，但提交记录是 ${record.idempotencyKey}`,
      );
    }
    const observed = receipt.observedState;
    if (!canTransitionOrder(record.state, observed)) {
      throw new OrderSubmitError(
        'illegal_order_transition',
        `非法的提交状态转换：${record.state} → ${observed}`,
      );
    }
    const next: OrderSubmissionRecord = Object.freeze({
      ...record,
      state: observed,
      receipt,
      providerOrderRef: receipt.providerOrderRef || record.providerOrderRef,
      outcomeKind:
        observed === 'confirmed' ? 'success' : observed === 'rejected' ? 'business_failure' : record.outcomeKind,
      failureReason:
        observed === 'rejected' ? (receipt.detail || 'rejected') : record.failureReason,
      respondedAt: at,
      updatedAt: at,
    });
    this.#store.put(next);
    return next;
  }

  /**
   * **崩溃后恢复**：只辨明状态并给出唯一合法动作，**不**新建订单、**不**新建授权、**不**发出调用。
   */
  recover(idempotencyKey: string): OrderRecoveryVerdict {
    const record = this.#requireKey(idempotencyKey);
    const base = {
      idempotencyKey: record.idempotencyKey,
      state: record.state,
      mayCreateNewOrder: false as const,
      mayIssueNewAuthorizationRef: false as const,
    };

    if (record.state === 'submitted') {
      return Object.freeze({
        ...base,
        kind: 'awaiting_receipt' as const,
        allowedAction: 'query_original_order' as const,
        detail: '平台业务码已受理，尚无独立确认：查原单取回执后收口',
      });
    }
    if (record.state === 'unknown') {
      return Object.freeze({
        ...base,
        kind: 'sent_unknown' as const,
        allowedAction: 'query_original_order' as const,
        detail: '结果未知：只能查原单；不得重下、不得另发授权',
      });
    }
    if (isTerminalOrderState(record.state)) {
      return Object.freeze({
        ...base,
        kind: 'settled' as const,
        allowedAction: 'none' as const,
        detail: `提交已到终态 ${record.state}（${ORDER_STATE_LABELS[record.state]}）：无需恢复动作`,
      });
    }
    // state === 'submitting'
    if (record.sendIntentAt === null) {
      return Object.freeze({
        ...base,
        kind: 'not_sent' as const,
        allowedAction: 'resume_same_submission' as const,
        detail:
          '占用已完成、尚未留下发出意图：判定为**未发出**。可对同一条记录再次 submit() 续发' +
          '（复用同一幂等键，不新建订单、不另发授权）',
      });
    }
    return Object.freeze({
      ...base,
      kind: 'sent_unknown' as const,
      allowedAction: 'query_original_order' as const,
      detail: `已于 ${record.sendIntentAt} 留下发出意图但未取回结果：判定为**已发出未知**，只能查原单`,
    });
  }

  // -------------------------------------------------------------------------
  // 观测
  // -------------------------------------------------------------------------

  getRecord(idempotencyKey: string): OrderSubmissionRecord | undefined {
    return this.#store.getByKey(idempotencyKey);
  }

  describeExternalOutcome(idempotencyKey: string): OrderOutcomeDescription {
    return describeOrderOutcome(this.#requireKey(idempotencyKey));
  }

  /** 非 `confirmed` 一律抛 `order_not_placed`（只有确认过的订单可声称"已下单"）。 */
  assertOrderPlacedClaimable(idempotencyKey: string): void {
    const record = this.#requireKey(idempotencyKey);
    if (!mayClaimOrderPlaced(record.state)) {
      throw new OrderSubmitError(
        'order_not_placed',
        `提交 ${record.idempotencyKey} 的状态是 ${record.state}（${ORDER_STATE_LABELS[record.state]}）：` +
          '只有 confirmed 才能声称订单已下达；submitted / unknown / rejected 一律不得冒充成功',
      );
    }
  }

  /** 计数（证据用；重启/双击前后比对可证明"没有重复下单"）。 */
  counts(): { readonly records: number; readonly sent: number; readonly unknown: number; readonly confirmed: number } {
    const all = this.#store.all();
    return Object.freeze({
      records: all.length,
      sent: all.filter((entry) => entry.sendIntentAt !== null).length,
      unknown: all.filter((entry) => entry.state === 'unknown').length,
      confirmed: all.filter((entry) => entry.state === 'confirmed').length,
    });
  }

  allRecords(): readonly OrderSubmissionRecord[] {
    return this.#store.all();
  }

  #requireKey(idempotencyKey: string): OrderSubmissionRecord {
    const record = this.#store.getByKey(String(idempotencyKey));
    if (record === undefined) {
      throw new OrderSubmitError(
        'submission_not_found',
        `台账里没有幂等键 ${String(idempotencyKey)} 的提交记录`,
      );
    }
    return record;
  }
}

/** 便捷构造。 */
export function createOrderSubmitter(options: OrderSubmitterOptions): OrderSubmitter {
  return new OrderSubmitter(options);
}

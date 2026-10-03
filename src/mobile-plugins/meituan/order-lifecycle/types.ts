/**
 * M09 订单生命周期视图 —— 类型定义（零依赖、纯数据）。
 *
 * ## 本包边界（美团线工作书 MEITUAN.md / M09）
 *
 * 「查询、配送、取消/退款请求、落盘/恢复」：
 * - 订单状态查询结果建模：**下单 / 支付 / 商家接单 / 配送 / 完成 / 取消 / 退款
 *   分别报告**，不得合并成一个 `ok`；
 * - externalId / 账号 / 金额 / 币种与本地下单意图的**匹配校验**；
 * - 断线后**先查询原单**（用原 externalId，不新建、不猜单）；
 * - 状态流转的合法性检查（阶段不得回退、退款不得跳级）。
 *
 * 美团**真实平台能力尚未核实**（未登录、无 token、无工具清单，见 M01）。
 * 本包**不接任何真实接口、不提交订单、不发起支付、不发起真实退款**；
 * 查询结果只能来自注入的 `OrderQueryPort`（fixture 随包提供）。
 *
 * ## 四条结构性纪律（写在类型里，不靠约定）
 *
 * 1. **没有单一的「成功」字段**：视图把七个阶段拆成七条 `StageReport`，
 *    另加一条独立的 `RefundReport`。任何「整单成功」都必须由调用方**逐阶段**
 *    自行归纳；本包不提供、也不可能提供一句 `ok: true`。
 * 2. **未知状态不是成功**：平台状态码本地不认识时，`statusRecognized === false`
 *    且七个阶段全部落 `'unknown'`；`StageState` 里 `'confirmed'` 只可能来自
 *    已知状态码的映射表。
 * 3. **「已申请」与「已到账」不同字面量**：`RefundReport.state` 是
 *    `'not_requested' | 'applied' | 'settled' | 'rejected' | 'unknown'`，
 *    `settled` 布尔量**只**在 `state === 'settled'` 时为真。
 * 4. **不匹配不得继续跟踪**：`external_id` / `account` / `amount` / `currency`
 *    任一不符，跟踪器进入 blocked，后续 observe / resume 一律拒绝，
 *    直到调用方显式 `acknowledge()`。
 */

/**
 * 订单生命周期的七个阶段。
 *
 * 顺序固定，`buildOrderLifecycleView` 产出数组时按此顺序排列，
 * 便于验收逐条比对；**它们不是一位布尔量**。
 */
export const ORDER_STAGES = [
  'placed',
  'paid',
  'merchant_accepted',
  'delivering',
  'completed',
  'cancelled',
  'refund',
] as const;

/** 生命周期阶段名。 */
export type OrderStage = (typeof ORDER_STAGES)[number];

/** 线性推进（不改出取消/退款分支）的阶段，用于流转合法性判定。 */
export const LINEAR_STAGES = ['placed', 'paid', 'merchant_accepted', 'delivering', 'completed'] as const;

/** 线性阶段名。 */
export type LinearStage = (typeof LINEAR_STAGES)[number];

/**
 * 单个阶段的状态。**没有「ok」这种笼统值**：
 * - `confirmed` — 平台明确报告该阶段已发生；
 * - `pending`   — 平台明确报告该阶段已发起但尚未完成（如退款已申请未到账）；
 * - `absent`    — 平台明确报告该阶段尚未/未发生；
 * - `failed`    — 平台明确报告该阶段失败（支付失败、退款被拒）；
 * - `unknown`   — 平台状态码本地不认识 ⇒ **不得计为任何成功**。
 */
export type StageState = 'confirmed' | 'pending' | 'absent' | 'failed' | 'unknown';

/** 某一阶段的独立报告。 */
export interface StageReport {
  readonly stage: OrderStage;
  readonly state: StageState;
  /** 判据来源：平台返回的状态码原文；`unknown` 时同样是该原文（便于追责）。 */
  readonly sourceCode: string;
  /** 人类可读说明；**不得**把 `pending`/`unknown` 描述成已完成。 */
  readonly note: string;
}

/**
 * 退款状态。**「已申请」与「已到账」是两个不同的值**，
 * 任何把 `applied` 渲染成 `settled` 的写法都会让测试变红。
 */
export type RefundState = 'not_requested' | 'applied' | 'settled' | 'rejected' | 'unknown';

/** 退款报告（与订单阶段报告并列，独立成型）。 */
export interface RefundReport {
  readonly state: RefundState;
  /** 退款金额（整数最小单位）；未发起/未知时为 `null`。 */
  readonly amountMinor: number | null;
  readonly currency: string | null;
  /** 平台退款状态码原文；平台未给该字段时为 `null`。 */
  readonly sourceCode: string | null;
  readonly note: string;
  /** **只有** `state === 'settled'` 才为真。 */
  readonly settled: boolean;
}

/**
 * 平台订单查询的原始结果（注入端口返回）。
 *
 * 字段名与工作书验收口径对齐：externalId、账号引用、金额/币种、状态、查询时间、证据引用。
 */
export interface OrderQueryResult {
  readonly externalId: string;
  /** 账号引用（脱敏引用，不是账号明文/凭据）。 */
  readonly accountRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** 平台订单状态码原文。本地不认识的码 ⇒ 全部阶段 `unknown`。 */
  readonly rawStatusCode: string;
  /** 平台退款状态码原文；`null` 表示平台本次未给出退款字段 ⇒ 视为未发起。 */
  readonly refundStatusCode: string | null;
  readonly refundAmountMinor: number | null;
  /** 采集时刻（调用方给出的逻辑时间，本包不读系统时钟）。 */
  readonly observedAt: number;
  /** 脱敏后的回执/查询证据引用。 */
  readonly evidenceRef: string;
}

/**
 * 订单生命周期视图：**七个阶段各自报告** + 独立退款报告。
 * 这里**没有** `ok` / `success` / `status` 之类的合并字段。
 */
export interface OrderLifecycleView {
  readonly externalId: string;
  readonly accountRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly rawStatusCode: string;
  /** 固定顺序 == `ORDER_STAGES`，长度恒为 7。 */
  readonly stages: readonly StageReport[];
  readonly refund: RefundReport;
  readonly observedAt: number;
  readonly evidenceRef: string;
  /**
   * 订单状态码是否为本地已知码。
   * 为 `false` 时七个阶段全为 `'unknown'`，**任何阶段都不得显示为成功**。
   */
  readonly statusRecognized: boolean;
}

/**
 * 本地下单意图：查询结果必须与它逐项对上，否则不得继续跟踪。
 *
 * `externalId` 为 `null` 表示「本地还没有可核验的下单回执」——此时
 * 断线后**不得**凭猜测去跟踪任意订单（`resumeAfterDisconnect` 会直接拒绝）。
 */
export interface OrderIntent {
  readonly orderIntentRef: string;
  readonly externalId: string | null;
  readonly accountRef: string;
  readonly amountMinor: number;
  readonly currency: string;
}

/** 匹配失败的具体字段。 */
export type OrderMismatchField = 'external_id' | 'account' | 'amount' | 'currency';

/** 匹配判定结果。 */
export interface OrderMatch {
  readonly matched: boolean;
  /** 顺序固定：external_id → account → amount → currency。 */
  readonly fields: readonly OrderMismatchField[];
  readonly detail: string;
}

/** 发起查询的原因。 */
export type OrderQueryReason = 'resume_after_disconnect' | 'poll' | 'refund_check';

/** 查询请求（**只查询**，不含任何下单/支付参数）。 */
export interface OrderQueryRequest {
  /** 必须是本地已核验的原单 externalId。 */
  readonly externalId: string;
  readonly accountRef: string;
  readonly reason: OrderQueryReason;
}

/**
 * 订单查询端口。**查询结果的唯一来源**。
 *
 * 真实实现（美团侧订单查询接口）由 M01/M02 核验后提供；本包只提供 fixture
 * （见 `./fixture.ts`）。端口**不知道**本地意图，因此本地必须自己校验匹配。
 */
export interface OrderQueryPort {
  query(request: OrderQueryRequest): Promise<OrderQueryResult>;
}

/** 阶段流转检查的种类。 */
export type TransitionKind =
  /** 同阶段重报：幂等，合法。 */
  | 'no_op'
  /** 线性前进一格：合法。 */
  | 'forward'
  /** 回退：非法（状态不得倒退）。 */
  | 'backward'
  /** 跨越中间阶段：非法（如 下单 → 配送，中间态缺失）。 */
  | 'skip'
  /** 终态（完成/取消）之后不得再变。 */
  | 'terminal'
  /** 两次观测指向不同的 externalId：非法。 */
  | 'different_order'
  /** 退款不是线性阶段流转，走 `checkRefundTransition`。 */
  | 'refund_separate'
  /** 不是已知阶段名。 */
  | 'unknown_stage';

/** 阶段流转判定结果。 */
export interface TransitionCheck {
  readonly legal: boolean;
  readonly kind: TransitionKind;
  readonly detail: string;
}

/** 退款流转判定结果（与阶段流转同构，种类更少）。 */
export interface RefundTransitionCheck {
  readonly legal: boolean;
  readonly kind: 'no_op' | 'legal' | 'illegal';
  readonly detail: string;
}

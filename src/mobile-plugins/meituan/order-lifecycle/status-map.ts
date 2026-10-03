/**
 * 平台状态码 → 七阶段报告的映射（**本包的核心判据**）。
 *
 * ## 为什么要显式表驱动
 *
 * 工作书要求「下单、支付、商家接单、配送、取消、退款到账**分别报告**，
 * 不能只填一个 ok」。表驱动有两层好处：
 * 1. 每个阶段的状态**各自可查**，不会出现「整体成功」把未发生的阶段捎带成成功；
 * 2. 未知状态码在表里**查不到** ⇒ 只能落 `'unknown'`，
 *    从结构上杜绝「不认识就当好结果」。
 *
 * ## 口径声明（重要）
 *
 * 下表的码值是**本包 fixture 的本地词汇**，**不是**已核验的美团真实状态码。
 * 真实码值需 M01 从已登录官方指南核验后替换；替换前本包对真实平台的
 * 任何「成功」都不成立。
 */

import { OrderResultIntegrityError, StatusRegistryError } from './errors.js';
import { CURRENCY_PATTERN, isValidMinorUnits } from './money.js';
import { ORDER_STAGES } from './types.js';
import type {
  OrderLifecycleView,
  OrderQueryResult,
  OrderStage,
  RefundReport,
  RefundState,
  StageReport,
  StageState,
} from './types.js';

/** 阶段的中文标签（只用于说明文字，不参与判定）。 */
const STAGE_LABEL: Readonly<Record<OrderStage, string>> = Object.freeze({
  placed: '下单',
  paid: '支付',
  merchant_accepted: '商家接单',
  delivering: '配送',
  completed: '完成',
  cancelled: '取消',
  refund: '退款',
});

/**
 * 一行阶段状态表：七个阶段各自的显式状态。
 *
 * 公开导出，因为**注入的状态码注册表**（见下方 `OrderStatusRegistry`）由调用方构造，
 * 需要能命名这一行；注册表里每个订单码都必须完整覆盖七个阶段（缺一个都算没读懂）。
 */
export type OrderStageRow = Readonly<Record<OrderStage, StageState>>;

/** 内部别名（保持既有实现可读）。 */
type StageRow = OrderStageRow;

/** 全部阶段的默认状态：「平台未报告该阶段发生」。 */
const ABSENT_ROW: StageRow = Object.freeze({
  placed: 'absent',
  paid: 'absent',
  merchant_accepted: 'absent',
  delivering: 'absent',
  completed: 'absent',
  cancelled: 'absent',
  refund: 'absent',
});

/** 由部分覆盖构造一整行（未列出的阶段 = `absent`）。 */
function row(overrides: Partial<Record<OrderStage, StageState>>): StageRow {
  return Object.freeze({ ...ABSENT_ROW, ...overrides });
}

/**
 * 订单状态码表（**fixture 本地词汇**，未经平台核验）。
 *
 * 每个码把「到这一刻为止已经真实发生/失败」的阶段显式写出来。
 */
export const ORDER_STATUS_TABLE: Readonly<Record<string, StageRow>> = Object.freeze({
  /** 已创建、待支付。 */
  W_CREATED: row({ placed: 'confirmed' }),
  /** 支付失败：支付阶段**失败**，不是「尚未支付」，也不是成功。 */
  W_PAY_FAILED: row({ placed: 'confirmed', paid: 'failed' }),
  /** 已支付、等商家接单。 */
  W_PAID_WAIT_ACCEPT: row({ placed: 'confirmed', paid: 'confirmed' }),
  /** 商家已接单。 */
  W_MERCHANT_ACCEPTED: row({ placed: 'confirmed', paid: 'confirmed', merchant_accepted: 'confirmed' }),
  /** 配送中（含已到店取货）。 */
  W_DELIVERING: row({
    placed: 'confirmed',
    paid: 'confirmed',
    merchant_accepted: 'confirmed',
    delivering: 'confirmed',
  }),
  /** 已完成（送达/确认收货）。 */
  W_COMPLETED: row({
    placed: 'confirmed',
    paid: 'confirmed',
    merchant_accepted: 'confirmed',
    delivering: 'confirmed',
    completed: 'confirmed',
  }),
  /** 支付前取消。 */
  W_CANCELLED_BEFORE_PAY: row({ placed: 'confirmed', cancelled: 'confirmed' }),
  /** 支付后取消（未进入接单/配送）。 */
  W_CANCELLED_AFTER_PAY: row({ placed: 'confirmed', paid: 'confirmed', cancelled: 'confirmed' }),
});

/**
 * 退款状态码表（**fixture 本地词汇**）。
 *
 * `R_APPLIED` 与 `R_SETTLED` 是两个不同的值——这正是「已申请 ≠ 已到账」的载体。
 */
export const REFUND_STATUS_TABLE: Readonly<Record<string, RefundState>> = Object.freeze({
  R_NONE: 'not_requested',
  R_APPLIED: 'applied',
  R_SETTLED: 'settled',
  R_REJECTED: 'rejected',
});

// ---------------------------------------------------------------------------
// 可注入的状态码注册表（登记缝）
// ---------------------------------------------------------------------------

/**
 * 阶段状态的全部合法取值（顺序固定：先「已发生」，再「待定/未发生/失败/未知」）。
 * 与 `types.ts` 的 `StageState` 联合类型指向同一组值，供覆盖度报告与登记校验使用。
 */
export const STAGE_STATES: readonly StageState[] = Object.freeze([
  'confirmed',
  'pending',
  'absent',
  'failed',
  'unknown',
]);

/** 退款状态的全部合法取值（顺序固定）。 */
export const REFUND_STATES: readonly RefundState[] = Object.freeze([
  'not_requested',
  'applied',
  'settled',
  'rejected',
  'unknown',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOrderStage(value: unknown): value is OrderStage {
  return (ORDER_STAGES as readonly unknown[]).includes(value);
}

function isStageState(value: unknown): value is StageState {
  return (STAGE_STATES as readonly unknown[]).includes(value);
}

function isRefundState(value: unknown): value is RefundState {
  return (REFUND_STATES as readonly unknown[]).includes(value);
}

/**
 * 平台状态码映射注册表：本包对平台应答的**全部解释依据**。
 *
 * 这是一条**登记缝**：`fixture` 的本地码表（`ORDER_STATUS_TABLE` / `REFUND_STATUS_TABLE`）
 * 只是它的一份实现。M01 从已登录官方指南核验出真实美团码值后，用
 * {@link createOrderStatusRegistry} 造一份新注册表注入即可，无需改动本包任何判定逻辑——
 * 也正因为如此，「本地不认识的码 ⇒ 七阶段全 unknown」这条纪律在新码表下**自动成立**
 * （只有注册过的码才会被当作已识别）。
 */
export interface OrderStatusRegistry {
  /** 该码表的来源标识（审计用：fixture 本地词汇，还是已核验的真实码表）。 */
  readonly registryRef: string;
  /** 订单状态码 → 七阶段显式状态行。 */
  readonly orderStatusTable: Readonly<Record<string, OrderStageRow>>;
  /** 退款状态码 → 退款状态。 */
  readonly refundStatusTable: Readonly<Record<string, RefundState>>;
}

/**
 * 注册入参：订单码允许**省略**阶段（省略者按 `absent` 补齐，与 fixture 的 `row()` 同口径），
 * 但**至少要声明一个非 `absent` 的阶段**——一个「什么事实都没陈述」的码不是被读懂了，
 * 登记它只会把「未知」偷换成「已识别」。
 */
export interface OrderStatusRegistryInput {
  readonly registryRef: string;
  readonly orderStatusTable: Readonly<Record<string, Partial<Record<OrderStage, StageState>>>>;
  readonly refundStatusTable: Readonly<Record<string, RefundState>>;
}

/**
 * 登记并冻结一份状态码表。**fail-closed**：任何一处不合法都抛
 * {@link StatusRegistryError}（收集全部违规后再抛），绝不「忽略看不懂的条目」。
 *
 * @throws {StatusRegistryError} 注册表结构 / 取值不合法。
 */
export function createOrderStatusRegistry(input: unknown): OrderStatusRegistry {
  if (!isPlainRecord(input)) {
    throw new StatusRegistryError([
      `状态码注册表必须是对象，收到 ${input === null ? 'null' : Array.isArray(input) ? '数组' : typeof input}`,
    ]);
  }
  const registryRef = input.registryRef;
  if (typeof registryRef !== 'string' || registryRef.length === 0) {
    throw new StatusRegistryError(['registryRef 必须是非空字符串（用于审计这份码表从哪来）']);
  }

  const violations: string[] = [];
  const orderTable: Record<string, OrderStageRow> = {};
  const orderInput = input.orderStatusTable;
  if (!isPlainRecord(orderInput)) {
    violations.push('orderStatusTable 必须是对象');
  } else {
    for (const [code, rowValue] of Object.entries(orderInput)) {
      if (code.length === 0) {
        violations.push('orderStatusTable 出现了空字符串状态码');
        continue;
      }
      if (!isPlainRecord(rowValue)) {
        violations.push(`orderStatusTable[${code}] 必须是一个对象`);
        continue;
      }
      const overrides: Partial<Record<OrderStage, StageState>> = {};
      let statesFact = false;
      for (const [key, stateValue] of Object.entries(rowValue)) {
        if (!isOrderStage(key)) {
          violations.push(`orderStatusTable[${code}] 登记了未知阶段名 ${JSON.stringify(key)}`);
          continue;
        }
        if (!isStageState(stateValue)) {
          violations.push(`orderStatusTable[${code}].${key} 不是合法阶段状态：${JSON.stringify(stateValue)}`);
          continue;
        }
        overrides[key] = stateValue;
        if (stateValue !== 'absent') statesFact = true;
      }
      if (!statesFact) {
        violations.push(
          `orderStatusTable[${code}] 没有任何非 absent 阶段：一个被标为「已识别」的码至少要陈述一件事实，否则等于把未知当已知`,
        );
        continue;
      }
      orderTable[code] = row(overrides);
    }
  }

  const refundTable: Record<string, RefundState> = {};
  const refundInput = input.refundStatusTable;
  if (!isPlainRecord(refundInput)) {
    violations.push('refundStatusTable 必须是对象');
  } else {
    for (const [code, stateValue] of Object.entries(refundInput)) {
      if (code.length === 0) {
        violations.push('refundStatusTable 出现了空字符串状态码');
        continue;
      }
      if (!isRefundState(stateValue)) {
        violations.push(`refundStatusTable[${code}] 不是合法退款状态：${JSON.stringify(stateValue)}`);
        continue;
      }
      refundTable[code] = stateValue;
    }
  }

  if (violations.length > 0) {
    throw new StatusRegistryError(violations);
  }
  return Object.freeze({
    registryRef,
    orderStatusTable: Object.freeze(orderTable),
    refundStatusTable: Object.freeze(refundTable),
  });
}

/**
 * fixture 注册表：本包自带的**本地词汇**码表（未经平台核验）。
 *
 * 它是 {@link buildOrderLifecycleView} / {@link OrderLifecycleTracker} 的默认值，
 * 因此既有行为不变；宿主注入真实码表时，本默认值不再参与判定。
 */
export const FIXTURE_ORDER_STATUS_REGISTRY: OrderStatusRegistry = Object.freeze({
  registryRef: 'fixture-local-vocab',
  orderStatusTable: ORDER_STATUS_TABLE,
  refundStatusTable: REFUND_STATUS_TABLE,
});

/** 某订单状态码是否**已登记**（只有登记过的码才可能被当作已识别）。 */
export function isRecognizedOrderStatus(registry: OrderStatusRegistry, code: string): boolean {
  return Object.prototype.hasOwnProperty.call(registry.orderStatusTable, code);
}

/**
 * 已知码覆盖一致性检查：注册表里每个订单码都必须**完整覆盖七个阶段**且取值为合法阶段状态，
 * 每个退款码都必须映射到合法退款状态，且不出现本地不认识的阶段名。
 *
 * 这是「码表覆盖率」的机器化前置条件：覆盖不全的码表会让某些阶段在视图里落成
 * `undefined`，被静默当成「未报告」——本检查在注册阶段就把它拦下。
 *
 * @throws {StatusRegistryError} 覆盖不全；一次性列出全部缺口（不是遇到第一条就停）。
 */
export function assertOrderStatusRegistryConformance(registry: unknown): void {
  if (!isPlainRecord(registry)) {
    throw new StatusRegistryError([
      `状态码注册表必须是对象，收到 ${registry === null ? 'null' : Array.isArray(registry) ? '数组' : typeof registry}`,
    ]);
  }
  const violations: string[] = [];

  const orderTable = registry.orderStatusTable;
  if (!isPlainRecord(orderTable)) {
    violations.push('orderStatusTable 必须是对象');
  } else {
    for (const [code, rowValue] of Object.entries(orderTable)) {
      if (code.length === 0) {
        violations.push('orderStatusTable 出现了空字符串状态码');
        continue;
      }
      if (!isPlainRecord(rowValue)) {
        violations.push(`orderStatusTable[${code}] 必须是一个对象`);
        continue;
      }
      for (const stage of ORDER_STAGES) {
        if (!Object.prototype.hasOwnProperty.call(rowValue, stage)) {
          violations.push(`orderStatusTable[${code}] 缺少阶段 ${stage}`);
          continue;
        }
        if (!isStageState(rowValue[stage])) {
          violations.push(`orderStatusTable[${code}].${stage} 不是合法阶段状态`);
        }
      }
      const extra = Object.keys(rowValue).filter((key) => !isOrderStage(key));
      if (extra.length > 0) {
        violations.push(`orderStatusTable[${code}] 出现未知阶段名 ${extra.join(', ')}`);
      }
    }
  }

  const refundTable = registry.refundStatusTable;
  if (!isPlainRecord(refundTable)) {
    violations.push('refundStatusTable 必须是对象');
  } else {
    for (const [code, stateValue] of Object.entries(refundTable)) {
      if (code.length === 0) {
        violations.push('refundStatusTable 出现了空字符串状态码');
        continue;
      }
      if (!isRefundState(stateValue)) {
        violations.push(`refundStatusTable[${code}] 不是合法退款状态`);
      }
    }
  }

  if (violations.length > 0) {
    throw new StatusRegistryError(violations);
  }
}

/** 注册表覆盖度报告（供验收一眼看清「这份码表到底认识哪些码/哪些状态」）。 */
export interface OrderStatusRegistryCoverage {
  readonly registryRef: string;
  readonly orderCodeCount: number;
  readonly refundCodeCount: number;
  /** 订单码表里出现过的阶段状态（按 `STAGE_STATES` 顺序）。 */
  readonly stageStates: readonly StageState[];
  /** 退款码表里出现过的退款状态（按 `REFUND_STATES` 顺序）。 */
  readonly refundStates: readonly RefundState[];
  /** 至少在一个订单码里被陈述为非 absent 的阶段。 */
  readonly factualStages: readonly OrderStage[];
}

/** 统计一份注册表的覆盖度（只读报告，不改变注册表）。 */
export function orderStatusRegistryCoverage(registry: OrderStatusRegistry): OrderStatusRegistryCoverage {
  const stageStates = new Set<StageState>();
  const factualStages = new Set<OrderStage>();
  for (const rowValue of Object.values(registry.orderStatusTable)) {
    for (const stage of ORDER_STAGES) {
      const state = rowValue[stage];
      stageStates.add(state);
      if (state !== 'absent') factualStages.add(stage);
    }
  }
  const refundStates = new Set<RefundState>(Object.values(registry.refundStatusTable));
  return Object.freeze({
    registryRef: registry.registryRef,
    orderCodeCount: Object.keys(registry.orderStatusTable).length,
    refundCodeCount: Object.keys(registry.refundStatusTable).length,
    stageStates: Object.freeze(STAGE_STATES.filter((state) => stageStates.has(state))),
    refundStates: Object.freeze(REFUND_STATES.filter((state) => refundStates.has(state))),
    factualStages: Object.freeze(ORDER_STAGES.filter((stage) => factualStages.has(stage))),
  });
}

/** 退款状态 → 该阶段在七阶段报告里的状态。 */
const REFUND_STATE_TO_STAGE_STATE: Readonly<Record<RefundState, StageState>> = Object.freeze({
  not_requested: 'absent',
  /** 已申请但未到账 ⇒ **pending，不是 confirmed**。 */
  applied: 'pending',
  settled: 'confirmed',
  rejected: 'failed',
  unknown: 'unknown',
});

/** 由状态与判据码生成阶段说明；`pending`/`unknown` 一律不得描述成已完成。 */
function stageNote(stage: OrderStage, state: StageState, code: string): string {
  const label = STAGE_LABEL[stage];
  switch (state) {
    case 'confirmed':
      return stage === 'refund'
        ? `退款已到账（平台状态 ${code}）`
        : `${label}已确认（平台状态 ${code}）`;
    case 'pending':
      return `${label}已申请，尚未到账（平台状态 ${code}）`;
    case 'absent':
      return stage === 'refund'
        ? `未发起退款（平台状态 ${code}）`
        : `${label}未发生（平台状态 ${code}）`;
    case 'failed':
      return stage === 'refund'
        ? `退款被拒（平台状态 ${code}）`
        : `${label}失败（平台状态 ${code}）`;
    case 'unknown':
      return `${label}状态未知（平台状态 ${code} 本地不认识）⇒ 不得计为成功`;
  }
}

/** 由退款状态生成说明。 */
function refundNote(state: RefundState, code: string | null): string {
  const shown = code ?? '(平台未给退款字段)';
  switch (state) {
    case 'not_requested':
      return '未发起退款';
    case 'applied':
      return `退款已申请，尚未到账（平台状态 ${shown}）`;
    case 'settled':
      return `退款已到账（平台状态 ${shown}）`;
    case 'rejected':
      return `退款被拒（平台状态 ${shown}）`;
    case 'unknown':
      return `退款状态未知（平台状态 ${shown} 本地不认识）⇒ 不得计为已到账`;
  }
}

/** 结果形状校验：收集全部违规，而不是遇到第一条就停。 */
function collectViolations(result: OrderQueryResult): string[] {
  const violations: string[] = [];
  if (typeof result.externalId !== 'string' || result.externalId.length === 0) {
    violations.push('externalId 为空');
  }
  if (typeof result.accountRef !== 'string' || result.accountRef.length === 0) {
    violations.push('accountRef 为空');
  }
  if (!isValidMinorUnits(result.amountMinor)) {
    violations.push(`amountMinor 不是整数最小单位：${String(result.amountMinor)}`);
  }
  if (typeof result.currency !== 'string' || !CURRENCY_PATTERN.test(result.currency)) {
    violations.push(`currency 不是三个大写字母：${JSON.stringify(result.currency)}`);
  }
  if (typeof result.rawStatusCode !== 'string' || result.rawStatusCode.length === 0) {
    violations.push('rawStatusCode 为空');
  }
  if (result.refundStatusCode !== null) {
    if (typeof result.refundStatusCode !== 'string' || result.refundStatusCode.length === 0) {
      violations.push('refundStatusCode 既不是 null 也不是非空字符串');
    }
  }
  if (result.refundAmountMinor !== null && !isValidMinorUnits(result.refundAmountMinor)) {
    violations.push(`refundAmountMinor 不是整数最小单位：${String(result.refundAmountMinor)}`);
  }
  if (typeof result.observedAt !== 'number' || !Number.isFinite(result.observedAt) || result.observedAt < 0) {
    violations.push(`observedAt 非法：${String(result.observedAt)}`);
  }
  if (typeof result.evidenceRef !== 'string' || result.evidenceRef.length === 0) {
    violations.push('evidenceRef 为空');
  }
  return violations;
}

/**
 * 由平台退款码得出退款状态；`null`（平台未给字段）视为未发起。
 *
 * `registry` 决定「哪些退款码是本地认识的」；缺省为 fixture 本地词汇表。
 * 不在注册表里的码一律 `unknown`（绝不回落到「未发起」）。
 */
export function deriveRefundState(
  refundStatusCode: string | null,
  registry: OrderStatusRegistry = FIXTURE_ORDER_STATUS_REGISTRY,
): RefundState {
  if (refundStatusCode === null) return 'not_requested';
  return registry.refundStatusTable[refundStatusCode] ?? 'unknown';
}

/** 构造退款报告。 */
export function buildRefundReport(result: OrderQueryResult, state: RefundState): RefundReport {
  const currency = typeof result.currency === 'string' && CURRENCY_PATTERN.test(result.currency) ? result.currency : null;
  return Object.freeze({
    state,
    amountMinor: state === 'not_requested' ? null : result.refundAmountMinor,
    currency: state === 'not_requested' ? null : currency,
    sourceCode: result.refundStatusCode,
    note: refundNote(state, result.refundStatusCode),
    settled: state === 'settled',
  });
}

/**
 * 把平台查询结果构造成**七阶段分别报告**的视图。
 *
 * 规则：
 * - 形状不合法 ⇒ 抛 {@link OrderResultIntegrityError}（本地不替平台补字段）；
 * - 状态码不在**注册表**内 ⇒ 七个阶段全部 `'unknown'`、`statusRecognized === false`；
 * - 退款「已到账」但平台没给金额 ⇒ 视为结果不合法（到账金额不可缺）。
 *
 * `registry` 是解释平台码的**唯一依据**（登记缝）：缺省为 fixture 本地词汇表；
 * 注入 `createOrderStatusRegistry(...)` 造的新表后，只有登记过的码才会被当作已识别，
 * 「不认识的码 ⇒ 全 unknown」这条纪律因此对新表自动成立。
 *
 * @throws {OrderResultIntegrityError}
 */
export function buildOrderLifecycleView(
  result: OrderQueryResult,
  registry: OrderStatusRegistry = FIXTURE_ORDER_STATUS_REGISTRY,
): OrderLifecycleView {
  const refundState = deriveRefundState(result.refundStatusCode, registry);
  const violations = collectViolations(result);
  if (refundState === 'settled' && result.refundAmountMinor === null) {
    violations.push('退款已到账（R_SETTLED）却没有给出 refundAmountMinor：到账必须有金额');
  }
  if (violations.length > 0) {
    throw new OrderResultIntegrityError(violations);
  }

  const statusRecognized = isRecognizedOrderStatus(registry, result.rawStatusCode);
  const unknownRow: StageRow = Object.freeze({
    placed: 'unknown',
    paid: 'unknown',
    merchant_accepted: 'unknown',
    delivering: 'unknown',
    completed: 'unknown',
    cancelled: 'unknown',
    refund: 'unknown',
  });
  const stageRow = statusRecognized ? (registry.orderStatusTable[result.rawStatusCode] ?? unknownRow) : unknownRow;

  // 订单状态码本地不认识时，整份平台应答都不可解释：退款字段一并落 `unknown`。
  // 否则会出现「订单码未知、却报告退款已到账」这种自相矛盾的视图，也违反
  // `types.ts` 的明文契约（`statusRecognized === false` ⇒ 七个阶段全 `'unknown'`）。
  const effectiveRefundState: RefundState = statusRecognized ? refundState : 'unknown';
  const refund = buildRefundReport(result, effectiveRefundState);
  const refundStageState = REFUND_STATE_TO_STAGE_STATE[effectiveRefundState];

  const stages: StageReport[] = ORDER_STAGES.map((stage) => {
    if (stage === 'refund') {
      return Object.freeze({
        stage,
        state: refundStageState,
        sourceCode: result.refundStatusCode ?? result.rawStatusCode,
        note: refundNote(effectiveRefundState, result.refundStatusCode),
      });
    }
    const state = statusRecognized ? stageRow[stage] : 'unknown';
    return Object.freeze({
      stage,
      state,
      sourceCode: result.rawStatusCode,
      note: stageNote(stage, state, result.rawStatusCode),
    });
  });

  return Object.freeze({
    externalId: result.externalId,
    accountRef: result.accountRef,
    amountMinor: result.amountMinor,
    currency: result.currency,
    rawStatusCode: result.rawStatusCode,
    stages: Object.freeze(stages),
    refund,
    observedAt: result.observedAt,
    evidenceRef: result.evidenceRef,
    statusRecognized,
  });
}

/** 取某阶段的报告（阶段名已知，恒能取到）。 */
export function stageReport(view: OrderLifecycleView, stage: OrderStage): StageReport {
  const found = view.stages.find((entry) => entry.stage === stage);
  if (found === undefined) {
    // 结构上不可能：stages 由 ORDER_STAGES 生成。此处仅作类型收窄。
    throw new OrderResultIntegrityError([`视图缺少阶段 ${stage}`]);
  }
  return found;
}

/** 该阶段是否被平台**明确确认已发生**（`pending` / `unknown` / `absent` 都不算）。 */
export function isStageConfirmed(view: OrderLifecycleView, stage: OrderStage): boolean {
  return stageReport(view, stage).state === 'confirmed';
}

/** 被明确确认的阶段列表（按 `ORDER_STAGES` 顺序）。 */
export function confirmedStages(view: OrderLifecycleView): readonly OrderStage[] {
  return Object.freeze(view.stages.filter((entry) => entry.state === 'confirmed').map((entry) => entry.stage));
}

/** 逐阶段的可读摘要。**没有**「整体 ok」这一行——合并语义由调用方负责。 */
export function describeStages(view: OrderLifecycleView): readonly string[] {
  return Object.freeze(view.stages.map((entry) => `${entry.stage}(${entry.state})：${entry.note}`));
}

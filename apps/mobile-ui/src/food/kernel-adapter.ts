/**
 * F10 food / 内核接线适配层 —— 把外卖卡片接到 F 线唯一的原生调用面 `KernelClient`，
 * 并把报价卡绑定到 **F05 的公共确认卡**（F10 只提供外卖字段，确认归 F05）。
 *
 * ## 这一层解决什么、不解决什么
 *
 * 之前的 F10 只产出可断言的卡片视图模型，标注了两条未接的缺口（见 `index.ts`）：
 *   1. store / menu 查询、cart 变更**未**下发到内核命令面；
 *   2. 报价卡的「可确认」只是本地视图态，**未**绑定到 F05 的确认卡 / 授权路径。
 * 本模块把这两条接上，且**不重造**已有能力：
 *
 *   - **命令构造 + 回执分类**：`buildStoreQueryCommand` / `buildMenuQueryCommand` /
 *     `buildCartMutationCommand` 产出 v1 `Command`，经注入的 {@link FoodKernelPort}
 *     （真实实现是 `src/platform/KernelClient`）下发；`classifyReceipt` 把回执投影成
 *     fail-closed 的 {@link FoodCommandOutcome}（`succeeded` 缺 `resultRef` **绝不算成功**）。
 *   - **购物车 payload 复用 M04 描述符**：`buildCartMutationCommand` 用 M04 的
 *     `validateCartOperationPayload` 校验 `args`，**不**另立一套字段规格——工具 schema 与
 *     实现不漂移的前提就是复用同一份描述符（`cart/contract/operations.ts`）。
 *   - **报价 → F05 确认卡**：`buildQuoteConfirmCard` 先跑 F10 的
 *     `evaluateQuoteConfirmation` 闸门；**只有可用报价**才会经 F05 `createConfirmCard`
 *     产出确认卡。过期 / 被取代 / 参数变化 / 旧引用**一律拒绝且不产卡**——
 *     「过期报价强制重新确认」因此在集成边界上仍然机器可检。
 *   - **确认走原生信任路径**：`confirmQuote` 把 F05 确认卡交给 F05 的
 *     `submitThroughNativeTrust` 与注入的 K07 `NativeTrustPort` 签发；**未注入账本时拒绝**，
 *     绝不在本地自签一枚授权冒充「用户已批准」（与 `decisions/trust.ts` 的 P0 纪律同源）。
 *   - **进程重启后重新取价**：`planQuoteResume` 表达「重启后内存里的报价已不是当前报价，
 *     旧报价必须重新取」——见下。
 *
 * ## 进程重启后的报价处理（`planQuoteResume`）
 *
 * M04 `CartSession` 的报价只在**内存**里（`#quotes` / `#currentQuoteRef`）。进程被杀后
 * 内存态消失，冷启动的新会话 `currentQuoteRef === null`：任何**重启前**的报价对它都是
 * `not_current`，因此 `buildQuoteCard` 判为 `superseded` 且不可确认。
 * `planQuoteResume` 把这条写成一个可断言的结果：除非重新 `requestQuote()` 取到新报价，
 * 否则 `requiresReQuote === true`。**不**尝试把旧报价「恢复」成当前报价——那等于
 * 让一个参数可能已变的报价复活，正是 M04/F10 共同要挡的事。
 *
 * ## 明确未做（如实标注，不得当成已完成）
 *
 * - **无真实内核运行时**：本轮证据只到单元 + 契约层；{@link FoodKernelPort} 的真实实现
 *   `platform/KernelClient` 正在由 F 线协调者改写（当前版本已去掉 `confirmThroughNativeTrust`，
 *   改为暴露 `nativeTrust`），本层因此只依赖**稳定的** `sendCommand` 结构面与 F05 端口；
 *   真机 WebView 通道未验证。
 * - **无真实 M03 目录 / M06 确认 ViewModel**：store / menu 的解析靠调用方注入
 *   {@link FoodCatalogResolver}（fixture 或未来的 M03）；`paramsDigest` 由调用方按
 *   `sha256:` 形状注入（F05 卡要求，**不是** M04 的 `v1-<hex8>` 结构指纹——两者口径不同，
 *   类型上不可互换）。
 * - **无真实下单 / 支付 / 美团接口**：本层不提交订单、不支付；命令面只有 query 与 mutate。
 */

import type { Command, EventStatus } from '../../../../contracts/mobile-v1/types.js';

import {
  validateCartOperationPayload,
  epochToIso8601,
  minorUnitsToWireAmount,
  type CartOperationId,
  type CartSession,
  type Quote,
} from '../../../../src/mobile-plugins/meituan/cart/index.js';

import {
  createConfirmCard,
  submitThroughNativeTrust,
  type ConfirmCardView,
  type ConfirmRequest,
  type ConfirmScope,
  type NativeTrustPort,
  type OptionView,
  type TrustFailureReason,
  type TrustOptions,
  type TrustSubmitResult,
} from '../decisions/index.js';

import { buildMenuCard, buildStoreCard, type FoodStore, type MenuCardView, type StoreCardView } from './catalog.js';
import { buildQuoteCard, evaluateQuoteConfirmation, type QuoteCardView, type QuoteConfirmOutcome, type QuoteConfirmRejection } from './quote-card.js';

// ---------------------------------------------------------------------------
// 端口（由 `src/platform/KernelClient` 结构满足）
// ---------------------------------------------------------------------------

/** 内核回执里的错误体（只取展示/判定所需字段；真实 `EventError` 结构兼容）。 */
export interface FoodCommandError {
  readonly code: string;
  readonly message: string;
}

/**
 * 命令回执的**最小结构面**。真实 `platform/CommandReceipt` 含更多字段
 * （`event` / `verificationMode` / `idempotentReplay`），结构上满足本接口，
 * 因此 `KernelClient` 可直接作为 {@link FoodKernelPort} 使用。
 */
export interface FoodCommandReceipt {
  readonly commandId: string;
  readonly status: EventStatus;
  readonly resultRef: string | null;
  readonly error: FoodCommandError | null;
  readonly revision: number;
}

/**
 * 食物命令面。真实实现：`apps/mobile-ui/src/platform/KernelClient`
 * （`sendCommand(command) => Promise<CommandReceipt>`，结构满足）。
 *
 * 只声明 `sendCommand`：本层**只**下发命令并读回执，不订阅事件流（事件归 F02/F04）。
 */
export interface FoodKernelPort {
  sendCommand(command: Command): Promise<FoodCommandReceipt>;
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export type FoodAdapterErrorCode = 'invalid-command-input' | 'invalid-cart-payload';

/** 本层在**下发前**发现调用方输入不合法时抛出（不把坏命令送进内核）。 */
export class FoodAdapterError extends Error {
  readonly code: FoodAdapterErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(code: FoodAdapterErrorCode, message: string, detail: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'FoodAdapterError';
    this.code = code;
    this.detail = detail;
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FoodAdapterError('invalid-command-input', `${label} 必须是非空字符串`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 命令构造（store / menu query；cart mutate）
// ---------------------------------------------------------------------------

/** 命令身份：命令 id / 幂等键必填；会话与任务引用可选。 */
export interface FoodCommandIdentity {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly conversationId?: string;
  readonly taskId?: string;
}

export interface StoreQueryCommandInput extends FoodCommandIdentity {
  readonly storeId: string;
}

function identityPayload(input: FoodCommandIdentity): { conversationId?: string; taskId?: string } {
  return {
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
  };
}

/**
 * 构造「查店铺」命令（`operation: 'query'`）。`targetId` 与 `filters.storeId` 同指该店，
 * 便于内核按引用定位；`filters.resource` 区分是店铺还是菜单。
 */
export function buildStoreQueryCommand(input: StoreQueryCommandInput): Command {
  const storeId = requireText(input.storeId, 'storeId');
  requireText(input.commandId, 'commandId');
  requireText(input.idempotencyKey, 'idempotencyKey');
  return Object.freeze({
    schemaVersion: 'mobile-v1',
    commandId: input.commandId,
    operation: 'query',
    idempotencyKey: input.idempotencyKey,
    payload: Object.freeze({
      targetId: storeId,
      ...identityPayload(input),
      filters: Object.freeze({ resource: 'food.store', storeId }),
    }),
  });
}

/** 构造「查菜单」命令（`operation: 'query'`）。 */
export function buildMenuQueryCommand(input: StoreQueryCommandInput): Command {
  const storeId = requireText(input.storeId, 'storeId');
  requireText(input.commandId, 'commandId');
  requireText(input.idempotencyKey, 'idempotencyKey');
  return Object.freeze({
    schemaVersion: 'mobile-v1',
    commandId: input.commandId,
    operation: 'query',
    idempotencyKey: input.idempotencyKey,
    payload: Object.freeze({
      targetId: storeId,
      ...identityPayload(input),
      filters: Object.freeze({ resource: 'food.menu', storeId }),
    }),
  });
}

export interface CartMutationCommandInput extends FoodCommandIdentity {
  readonly operation: CartOperationId;
  readonly args: Readonly<Record<string, unknown>>;
  readonly expectedRevision: number;
}

/**
 * 构造「变更购物车」命令（`operation: 'mutate'`）。
 *
 * 购物车操作（`cart.add_line` 等）**不是** v1 顶层 `operation`（v1 只认 create/mutate/…），
 * 而是放在 `payload.args.operation`；`args` 的字段规格由 M04 描述符校验，本层不重复实现。
 *
 * @throws {FoodAdapterError} `invalid-cart-payload`（描述符校验不过）或
 *   `invalid-command-input`（`expectedRevision` 非法）。
 */
export function buildCartMutationCommand(input: CartMutationCommandInput): Command {
  requireText(input.commandId, 'commandId');
  requireText(input.idempotencyKey, 'idempotencyKey');
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new FoodAdapterError('invalid-command-input', `expectedRevision 必须是非负安全整数，收到 ${String(input.expectedRevision)}`);
  }
  const validation = validateCartOperationPayload(input.operation, input.args);
  if (!validation.ok) {
    throw new FoodAdapterError('invalid-cart-payload', `购物车操作 ${input.operation} 的 payload 不合法`, {
      operation: input.operation,
      violations: validation.violations,
    });
  }
  return Object.freeze({
    schemaVersion: 'mobile-v1',
    commandId: input.commandId,
    operation: 'mutate',
    idempotencyKey: input.idempotencyKey,
    payload: Object.freeze({
      expectedRevision: input.expectedRevision,
      ...identityPayload(input),
      args: Object.freeze({ operation: input.operation, ...input.args }),
    }),
  });
}

// ---------------------------------------------------------------------------
// 回执分类（fail-closed）
// ---------------------------------------------------------------------------

export type FoodCommandFailureReason =
  /** 内核终局 `failed`。 */
  | 'failed'
  /** 内核终局 `cancelled`。 */
  | 'cancelled'
  /** 内核终局 `conflict`。 */
  | 'conflict'
  /** `succeeded` 却缺 `resultRef`：按 fail-closed 视为失败，绝不当成功。 */
  | 'missing-result-ref'
  /** 收到非终局态（`pending` / `running`）：不该出现在终局回执里，按失败处理。 */
  | 'non-terminal';

export interface FoodCommandSuccess {
  readonly ok: true;
  readonly commandId: string;
  readonly resultRef: string;
  readonly receipt: FoodCommandReceipt;
}

export interface FoodCommandFailure {
  readonly ok: false;
  readonly commandId: string;
  readonly reason: FoodCommandFailureReason;
  readonly detail: string;
  readonly receipt: FoodCommandReceipt;
}

export type FoodCommandOutcome = FoodCommandSuccess | FoodCommandFailure;

/** 把一条内核回执投影成结果。**只有** `succeeded` 且带非空 `resultRef` 才是成功。 */
export function classifyReceipt(receipt: FoodCommandReceipt): FoodCommandOutcome {
  const commandId = receipt.commandId;
  if (receipt.status === 'succeeded') {
    const ref = receipt.resultRef;
    if (ref === null || ref.length === 0) {
      return Object.freeze({
        ok: false,
        commandId,
        reason: 'missing-result-ref',
        detail: '内核返回 succeeded 但缺 resultRef：fail-closed，不算成功',
        receipt,
      });
    }
    return Object.freeze({ ok: true, commandId, resultRef: ref, receipt });
  }
  const reason: FoodCommandFailureReason =
    receipt.status === 'failed' || receipt.status === 'cancelled' || receipt.status === 'conflict'
      ? receipt.status
      : 'non-terminal';
  const detail =
    receipt.error === null
      ? `内核终局状态 ${receipt.status}`
      : `内核终局状态 ${receipt.status}：${receipt.error.code} ${receipt.error.message}`;
  return Object.freeze({ ok: false, commandId, reason, detail, receipt });
}

/**
 * 下发一条食物命令并分类回执。
 *
 * 注意：端口在**提交被内核边界拒绝**时 reject（`KernelClientError`），本函数**不吞**该异常，
 * 让它原样冒泡——「命令从未进入执行层」与「执行后失败」是两种不同事实，不得混为一谈。
 */
export async function submitFoodCommand(port: FoodKernelPort, command: Command): Promise<FoodCommandOutcome> {
  const receipt = await port.sendCommand(command);
  return classifyReceipt(receipt);
}

// ---------------------------------------------------------------------------
// store / menu 查询 → 卡片
// ---------------------------------------------------------------------------

/** 把内核 `resultRef` 解析为目录数据。真实实现来自 M03（未落地）；本轮为 fixture。 */
export interface FoodCatalogResolver {
  /** 无法解析时返回 `null`（不猜、不造）。 */
  resolveStore(resultRef: string): FoodStore | null;
}

export interface StoreQueryCommandInputWithCurrency extends StoreQueryCommandInput {
  readonly currency: string;
}

export interface StoreCardsOutcome {
  readonly outcome: FoodCommandOutcome;
  /** 成功时为内核 `resultRef`；失败为 `null`。 */
  readonly resultRef: string | null;
  /** 是否从 `resultRef` 解析出了目录。 */
  readonly resolved: boolean;
  /** 解析出目录且带币种时为选店卡，否则 `null`。 */
  readonly storeCard: StoreCardView | null;
  readonly menuCard: MenuCardView | null;
}

/**
 * 查询店铺并把结果接到选店卡 / 菜单卡。
 *
 * `resolver` 可选：不提供（或解析不到）时卡片为 `null`——**不**用空目录伪造一张卡。
 */
export async function queryStoreCards(
  port: FoodKernelPort,
  input: StoreQueryCommandInputWithCurrency,
  resolver?: FoodCatalogResolver,
): Promise<StoreCardsOutcome> {
  const outcome = await submitFoodCommand(port, buildStoreQueryCommand(input));
  if (!outcome.ok) {
    return Object.freeze({ outcome, resultRef: null, resolved: false, storeCard: null, menuCard: null });
  }
  const store = resolver === undefined ? null : resolver.resolveStore(outcome.resultRef);
  if (store === null) {
    return Object.freeze({ outcome, resultRef: outcome.resultRef, resolved: false, storeCard: null, menuCard: null });
  }
  return Object.freeze({
    outcome,
    resultRef: outcome.resultRef,
    resolved: true,
    storeCard: buildStoreCard(store, input.currency),
    menuCard: buildMenuCard(store),
  });
}

// ---------------------------------------------------------------------------
// 报价卡 → F05 公共确认卡
// ---------------------------------------------------------------------------

/**
 * 报价 → F05 确认卡的输入。F10 只负责**外卖字段**（金额 / 期限 / 报价引用 / 对象 / 范围），
 * 确认卡结构与闸门归 F05。
 */
export interface QuoteConfirmCardInput {
  readonly quoteCard: QuoteCardView;
  readonly cardId: string;
  readonly actionId: string;
  readonly accountRef: `acct:${string}`;
  /**
   * F05 卡要求的关键条件指纹（`sha256:<64hex>`）。**不是** M04 结构指纹
   * （`computeParamsDigest` 产出 `v1-<hex8>`，用于报价一致性判定）；两者口径不同，
   * 类型上不可互换，必须由调用方按 K07/F05 口径提供。
   */
  readonly paramsDigest: `sha256:${string}`;
  /** 被确认对象展示名（如店铺名）。 */
  readonly objectLabel: string;
  /** 被确认对象引用；缺省用 `quoteCard.merchantId`（店铺）。 */
  readonly objectRef?: string;
  /** 任务修订号；缺省 1。修改即 +1 由 F05 负责。 */
  readonly taskRevision?: number;
  /** 确认范围；缺省 `'submit-order'`（外卖场景是提交订单，不是直接支付）。 */
  readonly scope?: ConfirmScope;
  readonly options?: readonly OptionView[];
  readonly selectedOptionId?: string | null;
}

export type QuoteConfirmCardResult =
  | { readonly ok: true; readonly card: ConfirmCardView }
  | {
      readonly ok: false;
      readonly rejection: QuoteConfirmRejection;
      /** 恒为 `true`：被拒即必须重新确认（重新取价）。 */
      readonly requiresReconfirmation: true;
      readonly message: string;
      /** F10 报价闸门的完整结果，便于验收/调试原样透出。 */
      readonly quoteOutcome: QuoteConfirmOutcome;
    };

/**
 * 用 F05 `createConfirmCard` 把一张**可用**报价卡绑成确认卡。
 *
 * 闸门在前：先跑 F10 `evaluateQuoteConfirmation(quoteCard, quoteCard.quoteRef)`。
 * 报价过期 / 被取代 / 参数变化 / 引用不一致时**直接拒绝且不构造任何确认卡**——
 * 这样「过期报价不得进入确认流程」在结构与运行时同时成立（不是靠渲染层自觉）。
 *
 * 时间口径：F05 卡的 `expiresAt` 由报价 `expiresAt`（注入时钟毫秒）经
 * `epochToIso8601` 转出，因此 F10 的过期判据与 F05 `evaluateConfirmGate` 的过期判据
 * 同源，不会出现「F10 说过期、F05 说还可确认」的分歧。
 */
export function buildQuoteConfirmCard(input: QuoteConfirmCardInput): QuoteConfirmCardResult {
  const { quoteCard } = input;
  const quoteOutcome = evaluateQuoteConfirmation(quoteCard, quoteCard.quoteRef);
  if (!quoteOutcome.ok) {
    return Object.freeze({
      ok: false,
      rejection: quoteOutcome.rejection ?? 'quote_not_usable',
      requiresReconfirmation: true,
      message: quoteOutcome.message,
      quoteOutcome,
    });
  }
  const card = createConfirmCard({
    cardId: input.cardId,
    actionId: input.actionId,
    taskRevision: input.taskRevision ?? 1,
    subject: { objectRef: input.objectRef ?? quoteCard.merchantId, objectLabel: input.objectLabel },
    scope: input.scope ?? 'submit-order',
    price: {
      amount: minorUnitsToWireAmount(quoteCard.total.amountMinor, quoteCard.currency),
      currency: quoteCard.currency,
    },
    expiresAt: epochToIso8601(quoteCard.expiresAt),
    paramsDigest: input.paramsDigest,
    accountRef: input.accountRef,
    quoteRef: quoteCard.quoteRef,
    ...(input.options === undefined ? {} : { options: input.options }),
    ...(input.selectedOptionId === undefined ? {} : { selectedOptionId: input.selectedOptionId }),
  });
  return Object.freeze({ ok: true, card });
}

/** 确认提交的输入：报价卡字段 + 原生信任端口 + 注入的当前时间。 */
export interface ConfirmQuoteInput extends QuoteConfirmCardInput {
  /** 真实 K07 账本（= `KernelClient.nativeTrust`）。未注入（`null`）时拒绝，绝不自签。 */
  readonly nativeTrust: NativeTrustPort | null;
  /** 当前时间（UTC ISO），由调用方注入（F05 不读系统时钟）。 */
  readonly now: string;
  /**
   * 原生信任路径参数（**实际确认时必须提供**）。
   *
   * K-I02 之后 K07 的 `ActionBinding.taskId` 是**必需**项、账本键是 `(taskId, actionId)`，
   * 因此 `TrustOptions.taskId`（F05 侧同样必填）由调用方从**真实任务 / 会话上下文**如实注入
   * （如命令面的 `FoodCommandIdentity.taskId`），F10 **绝不自造**任务身份。
   *
   * 字段保持可选只为兼容"未接账本"的拒绝路径（`nativeTrust === null` 时根本到不了账本）；
   * 一旦真的要经账本签发，就必须提供：缺省时 `confirmQuote` **fail-closed** 返回
   * {@link ConfirmQuoteResult} 的 `task-identity-missing`，绝不用占位 id 兜底。
   */
  readonly trustOptions?: TrustOptions;
}

export type ConfirmQuoteResult =
  | { readonly ok: true; readonly card: ConfirmCardView; readonly trust: TrustSubmitResult }
  | {
      readonly ok: false;
      readonly reason: 'quote-not-usable';
      readonly rejection: QuoteConfirmRejection;
      readonly requiresReconfirmation: true;
      readonly message: string;
    }
  | { readonly ok: false; readonly reason: 'native-trust-unavailable'; readonly message: string }
  | {
      /** 账本在场，但调用方未注入任务身份（`TrustOptions.taskId`）：fail-closed，不猜任务 id。 */
      readonly ok: false;
      readonly reason: 'task-identity-missing';
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'confirm-rejected';
      readonly trustReason: TrustFailureReason;
      readonly code: string | null;
      readonly field: string | null;
      readonly detail: string;
      readonly card: ConfirmCardView;
    };

export const FOOD_ADAPTER_BOUNDARY = Object.freeze({
  /** 本层不本地自签授权（真实运行必须走 K07 原生信任路径）。 */
  selfSignsAuthorization: false,
  /** 本层不下单、不支付。 */
  submitsOrder: false,
  connectsRealPlatform: false,
  note: 'F10 接线层只下发 query/mutate 命令并把报价绑到 F05 确认卡；确认与授权由 F05/K07 持有。',
} as const);

/**
 * 报价 → F05 确认、经 K07 原生信任路径签发一次性授权。
 *
 * 顺序（任一步不过即停，绝不降级）：
 *   1. F10 报价闸门（`buildQuoteConfirmCard`）——不可用报价**不产卡**，返回 `quote-not-usable`；
 *   2. 原生信任端口必须在场，否则 `native-trust-unavailable`（**不**在本地自签）；
 *   3. 任务身份必须由调用方注入（`trustOptions.taskId`），否则 `task-identity-missing`——
 *      K-I02 之后账本键是 `(taskId, actionId)`，F10 **不**自造任务 id 冒充（fail-closed）；
 *   4. F05 `submitThroughNativeTrust`：F05 闸门 → 桥接 → 账本 `recordConfirmAction` /
 *      `attest` / `issueGrant`。被拒按 F05 拒因如实返回。
 */
export function confirmQuote(input: ConfirmQuoteInput): ConfirmQuoteResult {
  const built = buildQuoteConfirmCard(input);
  if (!built.ok) {
    return Object.freeze({
      ok: false,
      reason: 'quote-not-usable',
      rejection: built.rejection,
      requiresReconfirmation: true,
      message: built.message,
    });
  }
  if (input.nativeTrust === null) {
    return Object.freeze({
      ok: false,
      reason: 'native-trust-unavailable',
      message: '未注入 K07 原生信任端口（KernelClient.nativeTrust 为 null）：拒绝在本地自签授权冒充用户已批准。',
    });
  }
  const request: ConfirmRequest = {
    actionId: built.card.actionId,
    taskRevision: built.card.taskRevision,
    now: input.now,
  };
  // K-I02 之后账本键是 (taskId, actionId)：任务身份只能由调用方如实注入，F10 不猜。
  // 账本在场却没有任务身份 ⇒ fail-closed（不退回占位 id，也不降级为本地自签）。
  const trustOptions = input.trustOptions;
  if (trustOptions === undefined) {
    return Object.freeze({
      ok: false,
      reason: 'task-identity-missing',
      message:
        '未注入任务身份（TrustOptions.taskId 必填）：K07 账本键是 (taskId, actionId)，拒绝自造任务身份冒充用户已批准。',
    });
  }
  const trust = submitThroughNativeTrust(built.card, request, input.nativeTrust, trustOptions);
  if (!trust.ok) {
    return Object.freeze({
      ok: false,
      reason: 'confirm-rejected',
      trustReason: trust.reason,
      code: trust.code,
      field: trust.field,
      detail: trust.detail,
      card: trust.card,
    });
  }
  return Object.freeze({ ok: true, card: trust.card, trust });
}

// ---------------------------------------------------------------------------
// 进程重启后的报价（重新取价）
// ---------------------------------------------------------------------------

export type QuoteResumeReason =
  /** 重启后没有可用的报价对象（内存态丢失）：必须重新取价。 */
  | 'session-reset'
  /** 报价对象在，但对新会话已不是当前报价（`not_current`）：必须重新取价。 */
  | 'quote-stale'
  /** 报价仍可确认（同一会话内未重启时才会出现）。 */
  | 'reusable';

export interface QuoteResumeInput {
  /** 冷启动后重建的会话（`currentQuoteRef` 从 `null` 起）。 */
  readonly session: CartSession;
  /** 重启前持久下来的报价对象；只有引用、没有对象时传 `null`。 */
  readonly quote: Quote | null;
}

export interface QuoteResumePlan {
  readonly requiresReQuote: boolean;
  readonly reason: QuoteResumeReason;
  readonly detail: string;
  /** 有用报价对象时为对应卡；无对象（`session-reset`）时为 `null`。 */
  readonly quoteCard: QuoteCardView | null;
}

/**
 * 规划「进程重启后」如何处置重启前的报价。
 *
 * 关键事实：M04 报价只活在内存里，冷启动的新会话 `currentQuoteRef === null`，
 * 于是**任何**重启前的报价都被判 `not_current`、卡变 `superseded` 且不可确认。
 * 因此除非有可用报价，一律 `requiresReQuote: true`——**不**把旧报价「恢复」成当前报价。
 */
export function planQuoteResume(input: QuoteResumeInput): QuoteResumePlan {
  if (input.quote === null) {
    return Object.freeze({
      requiresReQuote: true,
      reason: 'session-reset',
      detail: '进程重启后报价对象未随内存恢复（只有引用不够）：必须重新向计价端口取价。',
      quoteCard: null,
    });
  }
  const card = buildQuoteCard(input.session, input.quote);
  if (!card.confirmable) {
    return Object.freeze({
      requiresReQuote: true,
      reason: 'quote-stale',
      detail: `重启前的报价对新会话已不可用（${card.state}）：${card.detail}`,
      quoteCard: card,
    });
  }
  return Object.freeze({
    requiresReQuote: false,
    reason: 'reusable',
    detail: card.detail,
    quoteCard: card,
  });
}

/** 便捷判据：该恢复计划是否要求先重新取价。 */
export function resumeRequiresReQuote(plan: QuoteResumePlan): boolean {
  return plan.requiresReQuote;
}

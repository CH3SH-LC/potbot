/**
 * F05 decisions —— 确认/决策气泡视图模型的类型与不变量（零依赖、纯 TS、框架无关）。
 *
 * 本包只产出**可断言的视图状态与纯函数**：不渲染、不引框架、不发网络请求、不读文件、
 * 不触碰时钟（所有「现在」由调用方以 ISO 字符串显式传入）、不用随机数（id 确定性推导）。
 * 因此同一输入必得同一结果，测试可逐字节比较。
 *
 * 只读消费（不修改）：
 *   - `contracts/mobile-v1/types.ts`：v1 契约类型
 *     （`ConfirmAction` / `AuthorizationGrant` / `ConfirmScope` / `ExternalReceipt` …）。
 *
 * 核心不变量（由 `tests/mobile-ui/F05/` 机器化断言）：
 *   I1 卡面可见：确认卡必须**可见**价格、对象、范围三项；任一缺失即不可提交
 *      （`assessVisibility`），且 `renderCardLines` 必须把它显式标为「缺失」而不是留白。
 *   I2 一次性授权：最终确认产出契约形状的 `ConfirmAction`，其 `authorizationGrant.consumed`
 *      起步为 false；同一授权**只能消费一次**（重复消费 ⇒ `already-consumed`）。
 *   I3 旧卡不得再提交：确认请求携带的 `taskRevision` 必须等于当前卡的 revision；
 *      修改/换方案会升 revision，旧 revision 的提交 ⇒ `revision-mismatch`。
 *   I4 拒绝即终态：已确认/已拒绝/已失效的卡不再接受提交（⇒ `not-pending`），
 *      这正是「重复点击第二次必须失败」的卡级闸门。
 *   I5 未知≠成功：回执 `observedState === 'unknown'` 必须显式展示为未知，
 *      `done` 恒为 false；只有 `verificationMode === 'real'` 且 `observedState === 'confirmed'`
 *      才可被判为完成。
 */

import type {
  AuthorizationGrant,
  ConfirmAction,
  ConfirmScope,
  ExternalReceipt,
  ExternalReceiptState,
  VerificationMode,
} from '../../../../contracts/mobile-v1/types.js';

export type {
  AuthorizationGrant,
  ConfirmAction,
  ConfirmScope,
  ExternalReceipt,
  ExternalReceiptState,
  VerificationMode,
};

// ---------------------------------------------------------------------------
// 卡状态
// ---------------------------------------------------------------------------

/**
 * 确认卡状态机取值。
 *
 *   pending      —— 待确认（唯一可提交的态）
 *   confirmed    —— 已确认（一次性授权已签发）
 *   rejected     —— 已拒绝（用户明确拒绝，终态）
 *   invalidated  —— 已失效（被新 revision 取代 / 过期 / 主动作废，终态）
 */
export type ConfirmCardStatus = 'pending' | 'confirmed' | 'rejected' | 'invalidated';

/** 终态集合：进入其一后不再接受任何提交（I4）。 */
export const TERMINAL_CARD_STATUSES: readonly ConfirmCardStatus[] = [
  'confirmed',
  'rejected',
  'invalidated',
];

/** 是否是终态（不再接受提交）。 */
export function isTerminalCardStatus(status: ConfirmCardStatus): boolean {
  return TERMINAL_CARD_STATUSES.includes(status);
}

/** 唯一可被提交的状态。 */
export function isActionableCardStatus(status: ConfirmCardStatus): boolean {
  return status === 'pending';
}

// ---------------------------------------------------------------------------
// 卡面可见字段（I1）
// ---------------------------------------------------------------------------

/** 卡上必须**可见**的三项：价格 / 对象 / 范围。 */
export type CardVisibleField = 'price' | 'object' | 'scope';

export const CARD_VISIBLE_FIELDS: readonly CardVisibleField[] = ['price', 'object', 'scope'];

/** 可见性评估结果：缺失字段列表即「不可提交」的机器可读证据。 */
export interface CardVisibility {
  readonly visible: boolean;
  readonly missing: readonly CardVisibleField[];
}

/** 金额：十进制字符串 + ISO 4217 三字母币种（与契约 `amount` / `currency` 同形）。 */
export interface MoneyView {
  /** 十进制字符串，禁止用浮点数承载金额。 */
  readonly amount: string;
  /** 三字母大写币种。 */
  readonly currency: string;
}

/** 被确认的对象（可见性要求 objectRef 与 objectLabel 同时非空）。 */
export interface CardSubject {
  readonly objectRef: string;
  readonly objectLabel: string;
}

/** 金额十进制字符串形状（与 confirm-action.schema.json 的 amount 逐字一致）。 */
export function isValidAmount(amount: string): boolean {
  return /^[0-9]+(\.[0-9]{1,4})?$/.test(amount);
}

/** 币种形状（与 confirm-action.schema.json 的 currency 逐字一致）。 */
export function isValidCurrency(currency: string): boolean {
  return /^[A-Z]{3}$/.test(currency);
}

/** 范围中文标签（仅用于展示，不参与判定）。 */
export const SCOPE_LABELS: Readonly<Record<ConfirmScope, string>> = {
  purchase: '购买',
  payment: '支付',
  'submit-order': '提交订单',
  'write-file': '写入文件',
  'external-mutation': '外部变更',
};

// ---------------------------------------------------------------------------
// 多方案比较
// ---------------------------------------------------------------------------

/** 一个可选方案（含自身价格/对象/范围，保证「比价」时每案都可见）。 */
export interface OptionView {
  readonly optionId: string;
  readonly label: string;
  readonly price: MoneyView;
  readonly subject: CardSubject;
  readonly scope: ConfirmScope;
  readonly recommended?: boolean;
}

/** 多方案比较结果。不可比时 `cheapestOptionId` 恒为 null 并给出原因。 */
export interface OptionComparison {
  readonly options: readonly OptionView[];
  /** 只有同币种且同范围才可比价。 */
  readonly comparable: boolean;
  /** 不可比 / 不可排序的原因（可比且可排序时为说明性文案）。 */
  readonly note: string;
  readonly selectedOptionId: string | null;
  readonly cheapestOptionId: string | null;
  /** 最便宜是否并列（并列时并列者不止一个）。 */
  readonly cheapestIsTied: boolean;
  /** 排名后的 optionId；不可排序时为原序。 */
  readonly rankedOptionIds: readonly string[];
}

// ---------------------------------------------------------------------------
// 修改（修改即升 revision，旧 revision 作废 —— I3）
// ---------------------------------------------------------------------------

export type ModificationKind =
  | 'set-amount'
  | 'set-currency'
  | 'set-object'
  | 'set-scope'
  | 'select-option'
  | 'set-expiry'
  | 'set-params-digest';

/** 对卡的一次修改。`select-option` 必须给出 `optionId`，未知 option 视为无改动。 */
export interface Modification {
  readonly kind: ModificationKind;
  readonly amount?: string;
  readonly currency?: string;
  readonly objectRef?: string;
  readonly objectLabel?: string;
  readonly scope?: ConfirmScope;
  readonly optionId?: string;
  readonly expiresAt?: string;
  readonly paramsDigest?: `sha256:${string}`;
  /** 修改原因（展示用）。 */
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// 确认卡
// ---------------------------------------------------------------------------

export interface ConfirmCardView {
  /** 稳定卡 id：同一张卡在任何重渲染下不变。 */
  readonly cardId: string;
  /** 与契约 `ConfirmAction.actionId` 对应。 */
  readonly actionId: string;
  /** 任务修订号：修改即 +1，旧 revision 的提交必须失败。 */
  readonly taskRevision: number;
  readonly status: ConfirmCardStatus;
  readonly subject: CardSubject;
  /** null ⇒ 范围不可见（不可提交）。 */
  readonly scope: ConfirmScope | null;
  /** null ⇒ 价格不可见（不可提交）。 */
  readonly price: MoneyView | null;
  readonly expiresAt: string;
  readonly paramsDigest: `sha256:${string}`;
  readonly accountRef: `acct:${string}`;
  readonly quoteRef: string;
  readonly options: readonly OptionView[];
  readonly selectedOptionId: string | null;
  readonly modifications: readonly Modification[];
  /** 已签发的一次性授权；未确认前为 null。 */
  readonly grant: AuthorizationGrant | null;
  /** 失效原因（status === 'invalidated' 时有值）。 */
  readonly invalidReason: string | null;
}

export interface CreateCardInput {
  readonly cardId: string;
  readonly actionId: string;
  readonly taskRevision: number;
  readonly subject: CardSubject;
  readonly scope: ConfirmScope | null;
  readonly price: MoneyView | null;
  readonly expiresAt: string;
  readonly paramsDigest: `sha256:${string}`;
  readonly accountRef: `acct:${string}`;
  readonly quoteRef: string;
  readonly options?: readonly OptionView[];
  readonly selectedOptionId?: string | null;
}

// ---------------------------------------------------------------------------
// 提交与一次性授权
// ---------------------------------------------------------------------------

/**
 * 提交请求。`taskRevision` 是**提交者所引用的卡 revision**——必须与当前卡一致，
 * 否则视为「旧卡」拒绝（I3）。
 */
export interface ConfirmRequest {
  readonly actionId: string;
  readonly taskRevision: number;
  /** 当前时间（UTC ISO），由调用方注入，避免读取系统时钟。 */
  readonly now: string;
}

export type ConfirmFailureReason =
  /** 卡不是待确认（已确认/已拒绝/已失效）——重复点击落在这里。 */
  | 'not-pending'
  /** actionId 不匹配。 */
  | 'action-mismatch'
  /** 提交引用的 revision 与当前卡不一致——旧卡落在这里。 */
  | 'revision-mismatch'
  /** 价格/对象/范围任一不可见。 */
  | 'missing-visible-field'
  /** 多方案但未选择。 */
  | 'no-selection'
  /** 多方案但选中的方案不在候选内。 */
  | 'unknown-option'
  /** 已过期。 */
  | 'expired';

export type ConfirmResult =
  | { readonly ok: true; readonly action: ConfirmAction; readonly card: ConfirmCardView }
  | { readonly ok: false; readonly reason: ConfirmFailureReason; readonly card: ConfirmCardView };

/**
 * 闸门通过后产出的**九字段确认请求**（契约 `ConfirmAction` 去掉 `authorizationGrant`）。
 * 授权由谁签发取决于走哪条路径：`confirmCard` 本地 fixture 签发，`submitThroughNativeTrust`
 * 交给 K07 原生信任路径签发。
 */
export type ConfirmActionBase = Omit<ConfirmAction, 'authorizationGrant'>;

/** 确认闸门结果：通过则给出 base，不通过则给出机读拒因。 */
export type ConfirmGateResult =
  | { readonly ok: true; readonly base: ConfirmActionBase }
  | { readonly ok: false; readonly reason: ConfirmFailureReason; readonly card: ConfirmCardView };

export type ConsumeFailureReason = 'action-mismatch' | 'already-consumed';

export type ConsumeResult =
  | { readonly ok: true; readonly grant: AuthorizationGrant }
  | { readonly ok: false; readonly reason: ConsumeFailureReason };

// ---------------------------------------------------------------------------
// 动作回执展示（I5）
// ---------------------------------------------------------------------------

/**
 * 回执状态全集（与 `contracts/mobile-v1/vocab/status.json` 的 externalReceiptStates
 * 逐字一致；顺序亦一致，便于按序渲染与计数初始化）。
 */
export const EXTERNAL_RECEIPT_STATES: readonly ExternalReceiptState[] = [
  'prepared',
  'authorized',
  'submitting',
  'submitted',
  'unknown',
  'confirmed',
  'failed',
  'cancelled',
];

/** 回执视图模型：把契约 `ExternalReceipt` 翻译成可展示、可断言的形态。 */
export interface ReceiptView {
  readonly actionId: string;
  readonly provider: string;
  readonly observedState: ExternalReceiptState;
  readonly verificationMode: VerificationMode;
  /** 是否处于「未知」——未知必须显式展示，不得渲染成成功。 */
  readonly isUnknown: boolean;
  /** 是否可声称外部动作已完成。**仅** real + confirmed 为 true。 */
  readonly done: boolean;
  /** 展示文案。 */
  readonly label: string;
  readonly evidenceRef: string;
  readonly observedAt: string;
}

export interface ReceiptRollup {
  readonly total: number;
  readonly done: number;
  readonly unknown: number;
  readonly failed: number;
  /** prepared / authorized / submitting / submitted / cancelled 合并计数（未完成且非未知/失败）。 */
  readonly inFlight: number;
  readonly byState: Readonly<Record<ExternalReceiptState, number>>;
  /** 全部完成：total > 0 且 done === total。 */
  readonly allDone: boolean;
  readonly anyUnknown: boolean;
  readonly summary: string;
}

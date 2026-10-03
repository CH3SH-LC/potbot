/**
 * F05 decisions / 确认卡 —— 状态机、可见性、修改与**一次性授权**提交。
 *
 * 全部为纯函数：接收卡 + 请求，返回新卡与结果；不修改入参，不读取时钟/随机数。
 */

import type { AuthorizationGrant, ConfirmAction } from '../../../../contracts/mobile-v1/types.js';

import {
  CARD_VISIBLE_FIELDS,
  SCOPE_LABELS,
  isValidAmount,
  isValidCurrency,
  type CardSubject,
  type CardVisibility,
  type CardVisibleField,
  type ConfirmActionBase,
  type ConfirmCardStatus,
  type ConfirmCardView,
  type ConfirmFailureReason,
  type ConfirmGateResult,
  type ConfirmRequest,
  type ConfirmResult,
  type ConsumeResult,
  type CreateCardInput,
  type Modification,
  type MoneyView,
  type OptionView,
} from './types.js';

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

/** 新建一张待确认卡。任何状态字段都为初始值，唯一的可提交态即 `pending`。 */
export function createConfirmCard(input: CreateCardInput): ConfirmCardView {
  const options = input.options ?? [];
  return {
    cardId: input.cardId,
    actionId: input.actionId,
    taskRevision: input.taskRevision,
    status: 'pending',
    subject: { objectRef: input.subject.objectRef, objectLabel: input.subject.objectLabel },
    scope: input.scope,
    price: input.price === null ? null : { amount: input.price.amount, currency: input.price.currency },
    expiresAt: input.expiresAt,
    paramsDigest: input.paramsDigest,
    accountRef: input.accountRef,
    quoteRef: input.quoteRef,
    options,
    selectedOptionId: input.selectedOptionId ?? null,
    modifications: [],
    grant: null,
    invalidReason: null,
  };
}

// ---------------------------------------------------------------------------
// 卡面可见性（I1）
// ---------------------------------------------------------------------------

/** 价格是否真正可见（存在、金额与币种形状合法）。 */
export function isPriceVisible(price: MoneyView | null): boolean {
  return price !== null && isValidAmount(price.amount) && isValidCurrency(price.currency);
}

/** 对象是否真正可见（引用与展示名同时非空，且引用不是空白）。 */
export function isObjectVisible(subject: CardSubject): boolean {
  return subject.objectRef.trim().length > 0 && subject.objectLabel.trim().length > 0;
}

/**
 * 评估卡面可见性。**缺一项即不可提交**——这是「卡上必须可见价格/对象/范围」的机器判据，
 * 而不是渲染层的自觉。
 */
export function assessVisibility(card: ConfirmCardView): CardVisibility {
  const missing: CardVisibleField[] = [];
  if (!isPriceVisible(card.price)) missing.push('price');
  if (!isObjectVisible(card.subject)) missing.push('object');
  if (card.scope === null) missing.push('scope');
  return { visible: missing.length === 0, missing };
}

/** 卡面一行文本：既给出展示文本，也给出该字段是否**真的**可见。 */
export interface CardLine {
  readonly field: CardVisibleField;
  readonly text: string;
  readonly present: boolean;
}

/**
 * 把三项必见字段渲染成文本行。缺失项必须显式写「缺失」，不得留白或省略——
 * 否则「看不见的价格」会被静默当成可见。
 */
export function renderCardLines(card: ConfirmCardView): readonly CardLine[] {
  return CARD_VISIBLE_FIELDS.map((field): CardLine => {
    if (field === 'price') {
      const visible = isPriceVisible(card.price);
      const price = card.price;
      return {
        field,
        present: visible,
        text: visible && price !== null ? `${price.amount} ${price.currency}` : '价格：缺失',
      };
    }
    if (field === 'object') {
      const visible = isObjectVisible(card.subject);
      return {
        field,
        present: visible,
        text: visible ? `${card.subject.objectLabel}（${card.subject.objectRef}）` : '对象：缺失',
      };
    }
    const scope = card.scope;
    return {
      field,
      present: scope !== null,
      text: scope !== null ? `${SCOPE_LABELS[scope]}` : '范围：缺失',
    };
  });
}

// ---------------------------------------------------------------------------
// 修改（升 revision，旧卡作废 —— I3）
// ---------------------------------------------------------------------------

function findOption(options: readonly OptionView[], optionId: string): OptionView | null {
  for (const option of options) {
    if (option.optionId === optionId) return option;
  }
  return null;
}

/**
 * 应用一次修改，返回**新卡**：
 *   - `taskRevision` + 1（旧 revision 从此不可提交）；
 *   - `status` 回到 `pending`（即使此前已确认，修改等于重新决策）；
 *   - `grant` 清空（旧授权随 revision 作废）；
 *   - 修改记录追加。
 *
 * 未知 optionId 的 `select-option` 是**无改动**：原样返回同一对象（调用方可据引用相等检测）。
 */
export function applyModification(card: ConfirmCardView, mod: Modification): ConfirmCardView {
  let subject: CardSubject = card.subject;
  let scope = card.scope;
  let price = card.price;
  let selectedOptionId = card.selectedOptionId;

  switch (mod.kind) {
    case 'set-amount':
      if (mod.amount === undefined || price === null) return card;
      price = { amount: mod.amount, currency: price.currency };
      break;
    case 'set-currency':
      if (mod.currency === undefined || price === null) return card;
      price = { amount: price.amount, currency: mod.currency };
      break;
    case 'set-object':
      if (mod.objectRef === undefined || mod.objectLabel === undefined) return card;
      subject = { objectRef: mod.objectRef, objectLabel: mod.objectLabel };
      break;
    case 'set-scope':
      if (mod.scope === undefined) return card;
      scope = mod.scope;
      break;
    case 'set-expiry':
      if (mod.expiresAt === undefined) return card;
      break;
    case 'set-params-digest':
      if (mod.paramsDigest === undefined) return card;
      break;
    case 'select-option': {
      if (mod.optionId === undefined) return card;
      const option = findOption(card.options, mod.optionId);
      if (option === null) return card;
      selectedOptionId = option.optionId;
      // 选中方案后，卡面三项随方案同步为可见值。
      price = { amount: option.price.amount, currency: option.price.currency };
      subject = option.subject;
      scope = option.scope;
      break;
    }
  }

  return {
    ...card,
    taskRevision: card.taskRevision + 1,
    status: 'pending',
    subject,
    scope,
    price,
    selectedOptionId,
    expiresAt: mod.kind === 'set-expiry' && mod.expiresAt !== undefined ? mod.expiresAt : card.expiresAt,
    paramsDigest:
      mod.kind === 'set-params-digest' && mod.paramsDigest !== undefined ? mod.paramsDigest : card.paramsDigest,
    grant: null,
    invalidReason: null,
    modifications: [...card.modifications, mod],
  };
}

/** 拒绝：终态。已拒绝的卡不再接受提交。 */
export function rejectCard(card: ConfirmCardView, reason?: string): ConfirmCardView {
  return { ...card, status: 'rejected', invalidReason: reason ?? null, grant: null };
}

/** 作废（含被新 revision 取代 / 主动作废）：终态。 */
export function invalidateCard(card: ConfirmCardView, reason: string): ConfirmCardView {
  return { ...card, status: 'invalidated', invalidReason: reason, grant: null };
}

// ---------------------------------------------------------------------------
// 过期
// ---------------------------------------------------------------------------

/**
 * 是否已过期。**边界取「到点即失效」**：`now >= expiresAt` 即过期——
 * 与 K07 原生信任路径的 `now >= confirm.expiresAt` 判据一致，避免「F05 认为还可确认、
 * 原生路径却已拒发」的 UI/权威分歧。时间解析失败时保守判为未过期，交由其他闸门拦截。
 */
export function isExpired(card: ConfirmCardView, nowIso: string): boolean {
  const now = Date.parse(nowIso);
  const exp = Date.parse(card.expiresAt);
  if (Number.isNaN(now) || Number.isNaN(exp)) return false;
  return now >= exp;
}

/** 有效状态：pending 但已过期 ⇒ 视为 invalidated。 */
export function effectiveStatus(card: ConfirmCardView, nowIso: string): ConfirmCardStatus {
  if (card.status === 'pending' && isExpired(card, nowIso)) return 'invalidated';
  return card.status;
}

/** 当前是否可提交（状态为 pending 且未过期）。 */
export function isCardActionable(card: ConfirmCardView, nowIso: string): boolean {
  return effectiveStatus(card, nowIso) === 'pending';
}

// ---------------------------------------------------------------------------
// 提交（一次性授权 —— I2/I3/I4）
// ---------------------------------------------------------------------------

function fail(reason: ConfirmFailureReason, card: ConfirmCardView): ConfirmResult {
  return { ok: false, reason, card };
}

/**
 * 确认提交。闸门顺序（每道都对应一条不变量）：
 *   1. 状态必须 pending            → 否则 `not-pending`（重复点击 / 已拒绝 / 已失效）
 *   2. actionId 必须匹配           → 否则 `action-mismatch`
 *   3. revision 必须等于当前卡      → 否则 `revision-mismatch`（旧卡不得再提交）
 *   4. 不得过期                    → 否则 `expired`
 *   5. 价格/对象/范围必须可见       → 否则 `missing-visible-field`
 *   6. 有多方案必须已选且选项存在   → 否则 `no-selection` / `unknown-option`
 *
 * 通过后签发**一次性授权**（`consumed === false`），并把卡置为 `confirmed`。
 */
export function confirmCard(card: ConfirmCardView, request: ConfirmRequest): ConfirmResult {
  const gate = evaluateConfirmGate(card, request);
  if (!gate.ok) return fail(gate.reason, gate.card);

  const grant: AuthorizationGrant = {
    grantId: `grant:${card.actionId}:r${card.taskRevision}`,
    actionId: card.actionId,
    issuedAt: request.now,
    consumed: false,
  };

  const action: ConfirmAction = { ...gate.base, authorizationGrant: grant };

  return { ok: true, action, card: { ...card, status: 'confirmed', grant } };
}

/**
 * 确认闸门（**纯判据，不签发任何东西**）。
 *
 * 把「能不能提交」与「提交后由谁签发授权」拆开：
 *   - `confirmCard` 通过闸门后在**本地**签发一枚 fixture 授权（仅用于无内核的独立驱动）；
 *   - `submitThroughNativeTrust`（见 `trust.ts`）通过同一道闸门后，把签发交给
 *     **K07 原生信任路径**——真实运行只走后者，本地签发不得作为真机授权。
 *
 * 闸门顺序（每道对应一条不变量，顺序即拒因优先级：
 *   1. 状态必须 pending            → 否则 `not-pending`（重复点击 / 已拒绝 / 已失效）
 *   2. actionId 必须匹配           → 否则 `action-mismatch`
 *   3. revision 必须等于当前卡      → 否则 `revision-mismatch`（旧卡不得再提交）
 *   4. 不得过期                    → 否则 `expired`
 *   5. 价格/对象/范围必须可见       → 否则 `missing-visible-field`
 *   6. 有多方案必须已选且选项存在   → 否则 `no-selection` / `unknown-option`
 */
export function evaluateConfirmGate(card: ConfirmCardView, request: ConfirmRequest): ConfirmGateResult {
  if (card.status !== 'pending') return { ok: false, reason: 'not-pending', card };
  if (request.actionId !== card.actionId) return { ok: false, reason: 'action-mismatch', card };
  if (request.taskRevision !== card.taskRevision) return { ok: false, reason: 'revision-mismatch', card };
  if (isExpired(card, request.now)) return { ok: false, reason: 'expired', card };

  const visibility = assessVisibility(card);
  if (!visibility.visible) return { ok: false, reason: 'missing-visible-field', card };

  if (card.options.length > 0) {
    if (card.selectedOptionId === null) return { ok: false, reason: 'no-selection', card };
    if (findOption(card.options, card.selectedOptionId) === null) return { ok: false, reason: 'unknown-option', card };
  }

  const price = card.price;
  const scope = card.scope;
  if (price === null || scope === null) return { ok: false, reason: 'missing-visible-field', card };

  const base: ConfirmActionBase = {
    actionId: card.actionId,
    accountRef: card.accountRef,
    taskRevision: card.taskRevision,
    paramsDigest: card.paramsDigest,
    quoteRef: card.quoteRef,
    amount: price.amount,
    currency: price.currency,
    expiresAt: card.expiresAt,
    scope,
  };
  return { ok: true, base };
}

/**
 * 消费一次性授权。**这是「重复点击」的第二道闸门**：即便卡对象被旧引用重复提交，
 * 同一授权第二次消费也必须失败（`already-consumed`）。
 */
export function consumeAuthorization(
  grant: AuthorizationGrant,
  actionId: string,
  nowIso: string,
): ConsumeResult {
  if (grant.actionId !== actionId) return { ok: false, reason: 'action-mismatch' };
  if (grant.consumed) return { ok: false, reason: 'already-consumed' };
  return { ok: true, grant: { ...grant, consumed: true, consumedAt: nowIso } };
}

/** 授权当前是否可用（未消费）。 */
export function isGrantUsable(grant: AuthorizationGrant | null): boolean {
  return grant !== null && !grant.consumed;
}

/**
 * 授权账本：一次性授权的**唯一**权威记录。
 *
 * `consumeAuthorization` 是纯变换——它无法阻止有人拿着**同一个未消费的授权副本**重放
 * （不变的对象重复传进去每次都「成功」）。真正的「只能一次」必须由一个记录
 * `grantId` 的账本兜底，与契约描述一致（授权由持久账本签发/消费，本包只是内存版）。
 *
 * 账本只增不减；`consume` 对已记录的 `grantId`（或已置 `consumed` 的授权）一律拒绝。
 */
export interface GrantLedger {
  /** 已消费的 grantId（升序快照，只读）。 */
  readonly consumedGrantIds: readonly string[];
  consume(grant: AuthorizationGrant, actionId: string, nowIso: string): ConsumeResult;
}

export function createGrantLedger(): GrantLedger {
  const consumed = new Set<string>();
  return {
    get consumedGrantIds(): readonly string[] {
      return [...consumed].sort();
    },
    consume(grant: AuthorizationGrant, actionId: string, nowIso: string): ConsumeResult {
      if (grant.actionId !== actionId) return { ok: false, reason: 'action-mismatch' };
      if (grant.consumed || consumed.has(grant.grantId)) return { ok: false, reason: 'already-consumed' };
      consumed.add(grant.grantId);
      return { ok: true, grant: { ...grant, consumed: true, consumedAt: nowIso } };
    },
  };
}

/** 提交后把卡上的一次性授权标记为已消费（记录 consumedAt）。 */
export function commitCard(card: ConfirmCardView, nowIso: string): ConfirmCardView {
  if (card.grant === null) return card;
  if (card.grant.consumed) return card;
  return { ...card, grant: { ...card.grant, consumed: true, consumedAt: nowIso } };
}

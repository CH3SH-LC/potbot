/**
 * F05 验收：确认卡状态机 / 卡面可见性 / 修改 / 一次性授权。
 *
 * 反向对照（必须变红才说明判据不是空壳）：
 *   - 重复点击第二次必须失败（`not-pending`，以及授权层 `already-consumed`）；
 *   - 旧 revision 的卡提交必须失败（`revision-mismatch`）；
 *   - 缺价格/对象/范围的卡提交必须失败（`missing-visible-field`）。
 */

import { describe, expect, it } from 'vitest';

import {
  applyModification,
  assessVisibility,
  commitCard,
  confirmCard,
  consumeAuthorization,
  createConfirmCard,
  createGrantLedger,
  effectiveStatus,
  invalidateCard,
  isCardActionable,
  isExpired,
  isGrantUsable,
  rejectCard,
  renderCardLines,
  type ConfirmCardView,
  type ConfirmScope,
  type OptionView,
} from '../../../apps/mobile-ui/src/decisions/index.js';

/** 生成形状合法的 sha256 digest 字面量。 */
function digest(ch: string): `sha256:${string}` {
  return `sha256:${ch.repeat(64)}`;
}

const NOW = '2026-10-03T10:00:00Z';
const EXPIRES = '2026-10-03T10:10:00Z';

interface CardOverrides {
  readonly scope?: ConfirmScope | null;
  readonly amount?: string | null;
  readonly currency?: string;
  readonly objectRef?: string;
  readonly objectLabel?: string;
  readonly taskRevision?: number;
  readonly options?: readonly OptionView[];
  readonly selectedOptionId?: string | null;
}

function makeCard(overrides: CardOverrides = {}): ConfirmCardView {
  const amount = overrides.amount === undefined ? '29.90' : overrides.amount;
  return createConfirmCard({
    cardId: 'card-1',
    actionId: 'act-1',
    taskRevision: overrides.taskRevision ?? 3,
    subject: {
      objectRef: overrides.objectRef ?? 'sku:coffee-1',
      objectLabel: overrides.objectLabel ?? '拿铁（大杯）',
    },
    scope: overrides.scope === undefined ? 'purchase' : overrides.scope,
    price: amount === null ? null : { amount, currency: overrides.currency ?? 'CNY' },
    expiresAt: EXPIRES,
    paramsDigest: digest('a'),
    accountRef: 'acct:demo-0001',
    quoteRef: 'quote:2026-10-03-1',
    options: overrides.options,
    selectedOptionId: overrides.selectedOptionId,
  });
}

const OPTIONS: readonly OptionView[] = [
  {
    optionId: 'opt-a',
    label: '中杯拿铁',
    price: { amount: '22.00', currency: 'CNY' },
    subject: { objectRef: 'sku:coffee-m', objectLabel: '拿铁（中杯）' },
    scope: 'purchase',
  },
  {
    optionId: 'opt-b',
    label: '大杯拿铁',
    price: { amount: '29.90', currency: 'CNY' },
    subject: { objectRef: 'sku:coffee-l', objectLabel: '拿铁（大杯）' },
    scope: 'purchase',
  },
];

describe('F05 / 卡面可见：价格 / 对象 / 范围', () => {
  it('完整卡三项均可见，渲染行同时给出文本与 present', () => {
    const card = makeCard();
    const visibility = assessVisibility(card);
    expect(visibility.visible).toBe(true);
    expect(visibility.missing).toEqual([]);

    const lines = renderCardLines(card);
    expect(lines.map((l) => l.field)).toEqual(['price', 'object', 'scope']);
    expect(lines.every((l) => l.present)).toBe(true);
    expect(lines.every((l) => l.text.trim().length > 0)).toBe(true);

    const price = lines.find((l) => l.field === 'price');
    expect(price?.text).toContain('29.90');
    expect(price?.text).toContain('CNY');
    const object = lines.find((l) => l.field === 'object');
    expect(object?.text).toContain('拿铁（大杯）');
    expect(object?.text).toContain('sku:coffee-1');
    const scope = lines.find((l) => l.field === 'scope');
    expect(scope?.text).toContain('购买');
  });

  it('价格缺失：可见性判缺、提交被拦、渲染行显式写「缺失」而非留白', () => {
    const card = makeCard({ amount: null });
    expect(assessVisibility(card)).toEqual({ visible: false, missing: ['price'] });

    const price = renderCardLines(card).find((l) => l.field === 'price');
    expect(price?.present).toBe(false);
    expect(price?.text).toBe('价格：缺失');

    const result = confirmCard(card, { actionId: 'act-1', taskRevision: 3, now: NOW });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('missing-visible-field');
  });

  it('对象展示名为空白 ⇒ 判缺', () => {
    const card = makeCard({ objectLabel: '   ' });
    expect(assessVisibility(card).missing).toEqual(['object']);
  });

  it('范围缺失 ⇒ 判缺且不可提交', () => {
    const card = makeCard({ scope: null });
    expect(assessVisibility(card).missing).toEqual(['scope']);
    const result = confirmCard(card, { actionId: 'act-1', taskRevision: 3, now: NOW });
    expect(result.ok === false && result.reason).toBe('missing-visible-field');
  });

  it('币种非法（非三字母大写）视为价格不可见', () => {
    const card = makeCard({ currency: 'cny' });
    expect(assessVisibility(card).missing).toEqual(['price']);
  });
});

describe('F05 / 提交：一次性授权语义', () => {
  it('待确认卡提交成功，产出契约形状 ConfirmAction 且授权未消费', () => {
    const card = makeCard();
    const result = confirmCard(card, { actionId: 'act-1', taskRevision: 3, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.action.actionId).toBe('act-1');
    expect(result.action.taskRevision).toBe(3);
    expect(result.action.amount).toBe('29.90');
    expect(result.action.currency).toBe('CNY');
    expect(result.action.scope).toBe('purchase');
    expect(result.action.accountRef).toBe('acct:demo-0001');
    expect(result.action.paramsDigest).toBe(digest('a'));
    expect(result.action.expiresAt).toBe(EXPIRES);
    expect(result.action.authorizationGrant).toBeDefined();
    expect(result.action.authorizationGrant?.consumed).toBe(false);

    // 卡被置为已确认并挂上授权；入参卡未被修改（纯函数）。
    expect(result.card.status).toBe('confirmed');
    expect(isGrantUsable(result.card.grant)).toBe(true);
    expect(card.status).toBe('pending');
    expect(card.grant).toBeNull();
  });

  it('同输入两次提交得到 deep-equal 的授权（确定性，无时钟/随机）', () => {
    const card = makeCard();
    const a = confirmCard(card, { actionId: 'act-1', taskRevision: 3, now: NOW });
    const b = confirmCard(card, { actionId: 'act-1', taskRevision: 3, now: NOW });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.action.authorizationGrant).toEqual(b.action.authorizationGrant);
    expect(a.action).toEqual(b.action);
  });

  it('反向对照：重复点击第二次必须失败（卡级 not-pending）', () => {
    const first = confirmCard(makeCard(), { actionId: 'act-1', taskRevision: 3, now: NOW });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = confirmCard(first.card, { actionId: 'act-1', taskRevision: 3, now: NOW });
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toBe('not-pending');
  });

  it('反向对照：同一授权第二次消费必须失败（授权级 already-consumed）', () => {
    const card = makeCard();
    // 即便 UI 忘记串联新卡、拿旧引用双击，两枚 action 的 grant 相同，消费也只能成功一次。
    const a = confirmCard(card, { actionId: 'act-1', taskRevision: 3, now: NOW });
    const b = confirmCard(card, { actionId: 'act-1', taskRevision: 3, now: NOW });
    if (!a.ok || !b.ok) throw new Error('两次提交都应通过卡级闸门');
    expect(a.action.authorizationGrant).toEqual(b.action.authorizationGrant);

    const grant = a.action.authorizationGrant;
    if (grant === undefined) throw new Error('应有授权');

    const ledger = createGrantLedger();
    const first = ledger.consume(grant, 'act-1', NOW);
    expect(first.ok).toBe(true);
    expect(first.ok && first.grant.consumed).toBe(true);
    expect(ledger.consumedGrantIds).toEqual([grant.grantId]);

    // 拿同一枚授权重放 ⇒ 拒绝（纯函数做不到这点，账本兜底）。
    const replay = ledger.consume(grant, 'act-1', NOW);
    expect(replay.ok).toBe(false);
    expect(replay.ok === false && replay.reason).toBe('already-consumed');

    // 更强的反向对照：把 consumed 标志抹掉、伪造一枚「看起来没消费」的副本，账本仍拒绝。
    const forged: typeof grant = { ...grant, consumed: false };
    const forgedReplay = ledger.consume(forged, 'act-1', NOW);
    expect(forgedReplay.ok).toBe(false);
    expect(forgedReplay.ok === false && forgedReplay.reason).toBe('already-consumed');

    // b 的授权与 a 是同一 grantId（同卡同 revision），同样被拒。
    const bGrant = b.action.authorizationGrant;
    if (bGrant === undefined) throw new Error('b 应有授权');
    expect(ledger.consume(bGrant, 'act-1', NOW).ok).toBe(false);
  });

  it('纯变换 consumeAuthorization：串联消费后的授权再消费即失败', () => {
    const result = confirmCard(makeCard(), { actionId: 'act-1', taskRevision: 3, now: NOW });
    if (!result.ok) throw new Error('应提交成功');
    const grant = result.action.authorizationGrant;
    if (grant === undefined) throw new Error('应有授权');

    const first = consumeAuthorization(grant, 'act-1', NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.grant.consumed).toBe(true);
    expect(first.grant.consumedAt).toBe(NOW);

    const second = consumeAuthorization(first.grant, 'act-1', NOW);
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toBe('already-consumed');
  });

  it('授权 actionId 不匹配时拒绝消费', () => {
    const result = confirmCard(makeCard(), { actionId: 'act-1', taskRevision: 3, now: NOW });
    if (!result.ok) throw new Error('应提交成功');
    const grant = result.action.authorizationGrant;
    if (grant === undefined) throw new Error('应有授权');
    const consumed = consumeAuthorization(grant, 'act-2', NOW);
    expect(consumed.ok === false && consumed.reason).toBe('action-mismatch');
  });

  it('commitCard 记录 consumedAt，二次 commit 幂等', () => {
    const result = confirmCard(makeCard(), { actionId: 'act-1', taskRevision: 3, now: NOW });
    if (!result.ok) throw new Error('应提交成功');
    const committed = commitCard(result.card, '2026-10-03T10:00:05Z');
    expect(committed.grant?.consumed).toBe(true);
    expect(committed.grant?.consumedAt).toBe('2026-10-03T10:00:05Z');
    expect(isGrantUsable(committed.grant)).toBe(false);
    // 再 commit 不改变已消费状态（不覆盖 consumedAt）。
    expect(commitCard(committed, '2026-10-03T11:00:00Z')).toEqual(committed);
  });

  it('actionId / 过期 / 未选方案的提交分别被各自闸门拦下', () => {
    const card = makeCard();
    const wrongAction = confirmCard(card, { actionId: 'act-9', taskRevision: 3, now: NOW });
    expect(wrongAction.ok === false && wrongAction.reason).toBe('action-mismatch');

    const expired = confirmCard(card, { actionId: 'act-1', taskRevision: 3, now: '2026-10-03T10:00:01Z' });
    expect(expired.ok).toBe(true);

    const tooLate = confirmCard(card, { actionId: 'act-1', taskRevision: 3, now: '2026-10-03T10:10:00.001Z' });
    expect(tooLate.ok === false && tooLate.reason).toBe('expired');
  });
});

describe('F05 / 修改与旧 revision', () => {
  it('修改升 revision、回 pending、清授权，并记录修改', () => {
    const confirmed = confirmCard(makeCard(), { actionId: 'act-1', taskRevision: 3, now: NOW });
    if (!confirmed.ok) throw new Error('应提交成功');

    const modified = applyModification(confirmed.card, {
      kind: 'set-amount',
      amount: '31.50',
      reason: '用户加料',
    });

    expect(modified.taskRevision).toBe(4);
    expect(modified.status).toBe('pending');
    expect(modified.grant).toBeNull();
    expect(modified.price?.amount).toBe('31.50');
    expect(modified.modifications).toHaveLength(1);
    expect(modified.modifications[0]?.reason).toBe('用户加料');
    // 原卡未被就地修改。
    expect(confirmed.card.taskRevision).toBe(3);
  });

  it('反向对照：旧 revision 的卡提交必须失败（revision-mismatch）', () => {
    const modified = applyModification(makeCard(), { kind: 'set-amount', amount: '31.50' });
    expect(modified.taskRevision).toBe(4);

    const stale = confirmCard(modified, { actionId: 'act-1', taskRevision: 3, now: NOW });
    expect(stale.ok).toBe(false);
    expect(stale.ok === false && stale.reason).toBe('revision-mismatch');

    const fresh = confirmCard(modified, { actionId: 'act-1', taskRevision: 4, now: NOW });
    expect(fresh.ok).toBe(true);
    if (fresh.ok) expect(fresh.action.amount).toBe('31.50');
  });

  it('未知 optionId 的 select-option 是无改动（返回同一引用）', () => {
    const card = makeCard({ options: OPTIONS, selectedOptionId: null });
    const noop = applyModification(card, { kind: 'select-option', optionId: 'opt-x' });
    expect(noop).toBe(card);
  });

  it('select-option 同步卡面三项为方案值并升 revision', () => {
    const card = makeCard({ options: OPTIONS, selectedOptionId: null });
    const selected = applyModification(card, { kind: 'select-option', optionId: 'opt-a' });
    expect(selected.taskRevision).toBe(4);
    expect(selected.selectedOptionId).toBe('opt-a');
    expect(selected.price).toEqual({ amount: '22.00', currency: 'CNY' });
    expect(selected.subject.objectRef).toBe('sku:coffee-m');
    expect(assessVisibility(selected).visible).toBe(true);
  });
});

describe('F05 / 多方案提交闸门', () => {
  it('有多方案但未选择 ⇒ no-selection', () => {
    const card = makeCard({ options: OPTIONS, selectedOptionId: null });
    const result = confirmCard(card, { actionId: 'act-1', taskRevision: 3, now: NOW });
    expect(result.ok === false && result.reason).toBe('no-selection');
  });

  it('选中方案后提交通过，金额取方案价', () => {
    const card = makeCard({ options: OPTIONS, selectedOptionId: null });
    const selected = applyModification(card, { kind: 'select-option', optionId: 'opt-b' });
    const result = confirmCard(selected, { actionId: 'act-1', taskRevision: 4, now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action.amount).toBe('29.90');
  });
});

describe('F05 / 终态', () => {
  it('反向对照：已拒绝 / 已失效的卡提交都被 not-pending 拦下', () => {
    const rejected = rejectCard(makeCard(), '用户不买了');
    expect(rejected.status).toBe('rejected');
    const r1 = confirmCard(rejected, { actionId: 'act-1', taskRevision: 3, now: NOW });
    expect(r1.ok === false && r1.reason).toBe('not-pending');

    const invalidated = invalidateCard(makeCard(), '被更高 revision 取代');
    expect(invalidated.status).toBe('invalidated');
    expect(invalidated.invalidReason).toBe('被更高 revision 取代');
    const r2 = confirmCard(invalidated, { actionId: 'act-1', taskRevision: 3, now: NOW });
    expect(r2.ok === false && r2.reason).toBe('not-pending');
  });

  it('过期的 pending 卡：有效状态视为失效且不可提交', () => {
    const card = makeCard();
    const later = '2026-10-03T10:20:00Z';
    expect(effectiveStatus(card, later)).toBe('invalidated');
    expect(isCardActionable(card, later)).toBe(false);
    expect(isCardActionable(card, NOW)).toBe(true);
  });

  it('过期边界「到点即失效」：now === expiresAt 即过期，与 K07 判据一致', () => {
    const card = makeCard();
    // 边界值恰好等于 expiresAt（EXPIRES = 10:10:00Z）⇒ 过期。
    expect(isExpired(card, EXPIRES)).toBe(true);
    const atBoundary = confirmCard(card, { actionId: 'act-1', taskRevision: 3, now: EXPIRES });
    expect(atBoundary.ok === false && atBoundary.reason).toBe('expired');
    // 边界前一毫秒仍可提交。
    const justBefore = confirmCard(card, { actionId: 'act-1', taskRevision: 3, now: '2026-10-03T10:09:59.999Z' });
    expect(justBefore.ok).toBe(true);
  });

  it('revision 闸门双向：同 revision 通过，不同 revision 一律 revision-mismatch', () => {
    const card = makeCard({ taskRevision: 5 });
    expect(confirmCard(card, { actionId: 'act-1', taskRevision: 5, now: NOW }).ok).toBe(true);
    expect(confirmCard(card, { actionId: 'act-1', taskRevision: 4, now: NOW }).ok === false).toBe(true);
    expect(confirmCard(card, { actionId: 'act-1', taskRevision: 6, now: NOW }).ok === false).toBe(true);
  });
});

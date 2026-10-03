/**
 * F10 集成验收：外卖卡片 → `KernelClient`（store/menu query、cart mutate）+ 报价卡 → F05 确认卡。
 *
 * 用**真实**实现驱动，不是自造替身：
 *   - `createKernelClient`（`src/platform/KernelClient`）+ 脚本化 `KernelTransport`：
 *     命令真的走内核客户端的提交/回执规范化路径；
 *   - M04 `CartSession` + `FixtureClock` + `FixtureQuotePort`：报价是真的；
 *   - F05 `createConfirmCard` / `evaluateConfirmGate` / `submitThroughNativeTrust`：
 *     确认卡与闸门是真的（`NativeTrustPort` 只在测试里用最小内存实现，因为真实账本是 K07）。
 *
 * 机器化断言的核心不变量：
 *   I1 命令接线：store/menu 走 `operation:'query'`、cart 走 `operation:'mutate'`，
 *      且 `args` 复用 M04 描述符（非法 payload 在**下发前**被拒）。
 *   I2 回执 fail-closed：`succeeded` 缺 `resultRef` **绝不算成功**。
 *   I3 过期报价强制重新确认：过期报价**产不出** F05 确认卡，`confirmQuote` 返回
 *      `quote-not-usable` 且**从未触碰**原生信任端口。
 *   I4 确认口径同源：F05 卡的 `expiresAt` 来自报价 `expiresAt`，F05 闸门与 F10 报价格
 *      在 `now === expiresAt` 时一致判过期。
 *   I5 未注入账本即拒：绝不在本地自签授权冒充「用户已批准」。
 *   I6 进程重启后必须重新取价：重启前报价对新会话是 `not_current`（`superseded`）。
 *   I7 任务身份必须由调用方注入（K-I02 后账本键是 `(taskId, actionId)`）：缺省即
 *      `task-identity-missing` 且**从未触碰账本**——绝不硬编码 placeholder 冒充任务身份。
 */

import { describe, expect, it } from 'vitest';

import {
  buildCartMutationCommand,
  buildMenuQueryCommand,
  buildQuoteCard,
  buildQuoteConfirmCard,
  buildStoreQueryCommand,
  classifyReceipt,
  confirmQuote,
  FoodAdapterError,
  planQuoteResume,
  queryStoreCards,
  resumeRequiresReQuote,
  submitFoodCommand,
  type FoodCatalogResolver,
  type FoodKernelPort,
  type FoodStore,
} from '../../../apps/mobile-ui/src/food/index.js';
import {
  createKernelClient,
  type CallerIdentity,
  type Command,
  type Event,
  type KernelTransport,
  type KernelTransportBreakNotice,
} from '../../../apps/mobile-ui/src/platform/index.js';
import {
  assessVisibility,
  evaluateConfirmGate,
  type NativeActionBinding,
  type NativeAttestation,
  type NativeConfirmAction,
  type NativeGrant,
  type NativeTrustPort,
  type TrustOptions,
} from '../../../apps/mobile-ui/src/decisions/index.js';
import {
  CartSession,
  DEFAULT_QUOTE_TTL_MS,
  FixtureClock,
  createFixtureQuotePort,
  epochToIso8601,
  minorUnitsToWireAmount,
} from '../../../src/mobile-plugins/meituan/cart/index.js';

const CALLER: CallerIdentity = { origin: 'app://local', kind: 'ui-webview', packageName: 'com.potbot.demo' };
const SHA = `sha256:${'a'.repeat(64)}` as const;
const MERCHANT = 'store-1';
const CURRENCY = 'CNY';
const ADDRESS_REF = 'addr-1#v1';
const T0 = 1000;
/** K-I02 之后账本键是 (taskId, actionId)：确认必须携带真实任务身份。 */
const TASK_ID = 'task-f10-confirm';

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/** 脚本化传输：记录提交的命令，按脚本返回终局事件。无订阅投递（本层不订阅事件流）。 */
function makeTransport(submit?: (command: Command) => Promise<Event>): {
  transport: KernelTransport;
  submitted: Command[];
} {
  const submitted: Command[] = [];
  const listeners = new Set<(event: Event) => void>();
  const breakListeners = new Set<(notice: KernelTransportBreakNotice) => void>();
  const transport: KernelTransport = {
    submit(command: unknown): Promise<Event> {
      submitted.push(command as Command);
      if (submit !== undefined) return submit(command as Command);
      return Promise.resolve(terminal(command as Command));
    },
    subscribe(listener) {
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
    cancel() {
      return true;
    },
    onBreak(listener) {
      breakListeners.add(listener);
      return { unsubscribe: () => breakListeners.delete(listener) };
    },
  };
  return { transport, submitted };
}

function terminal(command: Command, overrides: Partial<Event> = {}): Event {
  return {
    eventId: `evt-${command.commandId}`,
    seq: 1,
    commandId: command.commandId,
    revision: 0,
    status: 'succeeded',
    resultRef: `ref:${command.commandId}`,
    verificationMode: 'fixture',
    ...overrides,
  };
}

function realClient(
  submit: (command: Command) => Promise<Event>,
  nativeTrust: NativeTrustPort | null = null,
): { client: ReturnType<typeof createKernelClient<NativeTrustPort>>; submitted: Command[] } {
  const s = makeTransport(submit);
  const client = createKernelClient<NativeTrustPort>({ transport: s.transport, caller: CALLER, nativeTrust });
  return { client, submitted: s.submitted };
}

const STORE: FoodStore = {
  storeId: MERCHANT,
  name: 'fixture 火锅店',
  open: true,
  minOrderMinor: null,
  deliveryFeeMinor: 300,
  menu: [
    {
      dishId: 'dish-a',
      skuId: 'sku-a',
      name: '麻辣锅底',
      description: null,
      available: true,
      specGroups: [],
    },
  ],
};

function makeSession(quoteRefPrefix = 'fixture'): { session: CartSession; clock: FixtureClock } {
  const clock = new FixtureClock(T0);
  const port = createFixtureQuotePort({
    unitAmountsMinor: { 'sku-a': 2500 },
    deliveryFeeMinor: 300,
    quoteRefPrefix,
  });
  const session = new CartSession({ merchantId: MERCHANT, currency: CURRENCY, port, clock });
  session.cart.addLine({ dishId: 'dish-a', skuId: 'sku-a', specs: [{ groupId: 'spiciness', optionId: 'mild' }], quantity: 2 });
  session.cart.setDeliveryAddress(ADDRESS_REF);
  return { session, clock };
}

/**
 * 最小内存 `NativeTrustPort`（真实账本是 K07；这里只记录调用序并签发一次性授权）。
 *
 * 对齐 K-I02：账本键是 `(taskId, actionId)`，`getConfirmAction` / `attest` 均带 `taskId` 首参。
 * 替身**携带**期望的任务身份 `expectedTaskId`，凡传入的 `taskId` 与之不符即抛错——
 * 这样"F10 有没有把真实任务身份一路透传到账本"是被机器化断言的，而不是靠人眼。
 */
function makeFakeTrust(expectedTaskId: string): { port: NativeTrustPort; calls: string[] } {
  const calls: string[] = [];
  const confirms = new Map<string, NativeConfirmAction>();
  let grantSeq = 0;
  const keyOf = (taskId: string, actionId: string): string => `${taskId}\u0000${actionId}`;
  const assertTaskId = (taskId: string): void => {
    if (taskId !== expectedTaskId) {
      throw new Error(`测试替身：任务身份不符（期望 ${expectedTaskId}，收到 ${taskId}）`);
    }
  };
  const port: NativeTrustPort = {
    recordConfirmAction(action: NativeConfirmAction): NativeConfirmAction {
      calls.push('recordConfirmAction');
      assertTaskId(action.taskId);
      confirms.set(keyOf(action.taskId, action.actionId), action);
      return action;
    },
    getConfirmAction(taskId: string, actionId: string): NativeConfirmAction | undefined {
      assertTaskId(taskId);
      return confirms.get(keyOf(taskId, actionId));
    },
    attest(
      taskId: string,
      actionId: string,
      options: { surface: string; claim?: Partial<NativeActionBinding> },
    ): NativeAttestation {
      calls.push('attest');
      assertTaskId(taskId);
      const binding = confirms.get(keyOf(taskId, actionId));
      if (binding === undefined) throw new Error('测试替身：attest 前未登记确认请求');
      return { actionId, binding, surface: options.surface, confirmedAt: 0 };
    },
    issueGrant(attestation: NativeAttestation): NativeGrant {
      calls.push('issueGrant');
      grantSeq += 1;
      return {
        ...attestation.binding,
        grantId: `grant-${grantSeq}`,
        issuedAt: 0,
        grantedBy: attestation.surface,
        state: 'authorized',
        consumed: false,
        consumedAt: null,
        consumedBySubmissionId: null,
        revokedAt: null,
        revokedReason: null,
      };
    },
    consume() {
      throw new Error('测试替身：本用例不消费授权');
    },
  };
  return { port, calls };
}

// ===========================================================================
// I1 命令接线：store / menu query
// ===========================================================================

describe('F10 接线 · store/menu 查询经真实 KernelClient', () => {
  it('queryStoreCards 下发 operation=query 并接到选店/菜单卡', async () => {
    const { client, submitted } = realClient((c) => Promise.resolve(terminal(c)));
    const port: FoodKernelPort = client; // 结构兼容证明：真实 KernelClient 即 FoodKernelPort
    const resolver: FoodCatalogResolver = { resolveStore: (ref) => (ref.endsWith(':cmd-store') ? STORE : null) };

    const out = await queryStoreCards(
      port,
      { commandId: 'cmd-store', idempotencyKey: 'idem-store', storeId: MERCHANT, currency: CURRENCY },
      resolver,
    );

    expect(submitted).toHaveLength(1);
    const cmd = submitted[0]!;
    expect(cmd.schemaVersion).toBe('mobile-v1');
    expect(cmd.operation).toBe('query');
    expect(cmd.idempotencyKey).toBe('idem-store');
    expect((cmd.payload as { filters: { storeId: string } }).filters.storeId).toBe(MERCHANT);

    expect(out.outcome.ok).toBe(true);
    expect(out.resultRef).toBe('ref:cmd-store');
    expect(out.resolved).toBe(true);
    expect(out.storeCard?.storeId).toBe(MERCHANT);
    expect(out.storeCard?.deliveryFee?.display).toBe('3.00');
    expect(out.menuCard?.items[0]?.dishId).toBe('dish-a');
  });

  it('buildMenuQueryCommand 标记 resource=food.menu，且带上会话引用', () => {
    const cmd = buildMenuQueryCommand({
      commandId: 'cmd-menu',
      idempotencyKey: 'idem-menu',
      storeId: MERCHANT,
      conversationId: 'conv-1',
    });
    expect(cmd.operation).toBe('query');
    expect((cmd.payload as { filters: { resource: string } }).filters.resource).toBe('food.menu');
    expect((cmd.payload as { conversationId: string }).conversationId).toBe('conv-1');
  });

  it('解析不到目录时不伪造卡片（resolved=false，卡为 null）', async () => {
    const { client } = realClient((c) => Promise.resolve(terminal(c)));
    const out = await queryStoreCards(
      client,
      { commandId: 'cmd-store', idempotencyKey: 'idem-store', storeId: MERCHANT, currency: CURRENCY },
      { resolveStore: () => null },
    );
    expect(out.outcome.ok).toBe(true);
    expect(out.resolved).toBe(false);
    expect(out.storeCard).toBeNull();
    expect(out.menuCard).toBeNull();
  });

  it('buildStoreQueryCommand 拒绝空 storeId（不把坏命令送进内核）', () => {
    expect(() => buildStoreQueryCommand({ commandId: 'c', idempotencyKey: 'i', storeId: '' })).toThrowError(FoodAdapterError);
  });
});

// ===========================================================================
// I1/I2 命令接线：cart mutate + 回执 fail-closed
// ===========================================================================

describe('F10 接线 · 购物车变更与回执分类', () => {
  it('buildCartMutationCommand 产出 operation=mutate，args.operation 为购物车操作', async () => {
    const { client, submitted } = realClient((c) => Promise.resolve(terminal(c)));

    const cmd = buildCartMutationCommand({
      commandId: 'cmd-add',
      idempotencyKey: 'idem-add',
      operation: 'cart.add_line',
      args: { dishId: 'dish-a', skuId: 'sku-a', specs: [{ groupId: 'spiciness', optionId: 'mild' }], quantity: 2 },
      expectedRevision: 3,
    });

    expect(cmd.operation).toBe('mutate');
    expect((cmd.payload as { expectedRevision: number }).expectedRevision).toBe(3);
    const args = (cmd.payload as { args: { operation: string; dishId: string } }).args;
    expect(args.operation).toBe('cart.add_line');
    expect(args.dishId).toBe('dish-a');

    const out = await submitFoodCommand(client, cmd);
    expect(out.ok).toBe(true);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.commandId).toBe('cmd-add');
  });

  it('购物车 payload 不合法 ⇒ FoodAdapterError(invalid-cart-payload)，复用 M04 描述符', () => {
    let caught: unknown = null;
    try {
      // cart.add_line 描述符要求 dishId + skuId，且 additionalProperties:false。
      buildCartMutationCommand({
        commandId: 'c',
        idempotencyKey: 'i',
        operation: 'cart.add_line',
        args: { skuId: 'sku-a', extra: 1 },
        expectedRevision: 0,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FoodAdapterError);
    expect((caught as FoodAdapterError).code).toBe('invalid-cart-payload');
  });

  it('expectedRevision 非法 ⇒ FoodAdapterError(invalid-command-input)', () => {
    let caught: unknown = null;
    try {
      buildCartMutationCommand({
        commandId: 'c',
        idempotencyKey: 'i',
        operation: 'cart.set_quantity',
        args: { lineId: 'line-1', quantity: 2 },
        expectedRevision: -1,
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as FoodAdapterError).code).toBe('invalid-command-input');
  });

  it('I2 fail-closed：succeeded 缺 resultRef ⇒ 不算成功', async () => {
    const receipt = await createKernelClient<NativeTrustPort>({
      transport: makeTransport((c) => Promise.resolve(terminal(c, { resultRef: undefined, status: 'succeeded' }))).transport,
      caller: CALLER,
    }).sendCommand(buildCartMutationCommand({
      commandId: 'cmd-x',
      idempotencyKey: 'idem-x',
      operation: 'cart.set_quantity',
      args: { lineId: 'line-1', quantity: 3 },
      expectedRevision: 1,
    }));
    const out = classifyReceipt(receipt);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('missing-result-ref');
  });

  it('I2 failed 终局带错误码 ⇒ 如实给出 reason=failed', async () => {
    const { client } = realClient((c) =>
      Promise.resolve(terminal(c, { status: 'failed', resultRef: undefined, error: { code: 'E_BAD', message: '内核失败' } })),
    );
    const out = await submitFoodCommand(
      client,
      buildCartMutationCommand({
        commandId: 'cmd-f',
        idempotencyKey: 'idem-f',
        operation: 'cart.set_quantity',
        args: { lineId: 'line-1', quantity: 3 },
        expectedRevision: 1,
      }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('failed');
      expect(out.detail).toContain('E_BAD');
    }
  });
});

// ===========================================================================
// I3/I4 报价 → F05 确认卡
// ===========================================================================

describe('F10 接线 · 报价绑定 F05 确认卡', () => {
  it('可用报价 ⇒ 产 F05 卡，金额/期限/引用与报价一致，三项可见', async () => {
    const { session } = makeSession();
    const quote = await session.requestQuote();
    const card = buildQuoteCard(session, quote);

    const built = buildQuoteConfirmCard({
      quoteCard: card,
      cardId: 'card-1',
      actionId: 'act-1',
      accountRef: 'acct:test',
      paramsDigest: SHA,
      objectLabel: 'fixture 火锅店',
    });

    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.card.quoteRef).toBe(quote.quoteRef);
      expect(built.card.price?.amount).toBe(minorUnitsToWireAmount(quote.amount, CURRENCY));
      expect(built.card.price?.amount).toBe('53.00');
      expect(built.card.price?.currency).toBe(CURRENCY);
      expect(built.card.subject.objectRef).toBe(MERCHANT);
      expect(built.card.scope).toBe('submit-order');
      expect(built.card.expiresAt).toBe(epochToIso8601(quote.expiresAt));
      expect(assessVisibility(built.card).visible).toBe(true);
    }
  });

  it('I3 过期报价 ⇒ 拒绝且**产不出**确认卡', async () => {
    const { session, clock } = makeSession();
    const quote = await session.requestQuote();
    clock.advance(DEFAULT_QUOTE_TTL_MS); // now == expiresAt ⇒ 已过期

    const built = buildQuoteConfirmCard({
      quoteCard: buildQuoteCard(session, quote),
      cardId: 'card-1',
      actionId: 'act-1',
      accountRef: 'acct:test',
      paramsDigest: SHA,
      objectLabel: 'fixture 火锅店',
    });

    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.rejection).toBe('quote_expired');
      expect(built.requiresReconfirmation).toBe(true);
      expect(built.message).toContain('重新');
    }
    expect('card' in built).toBe(false);
  });

  it('I4 确认口径同源：F05 卡在到期前可过闸门、到点即 expired', async () => {
    const { session } = makeSession();
    const quote = await session.requestQuote();
    const built = buildQuoteConfirmCard({
      quoteCard: buildQuoteCard(session, quote),
      cardId: 'card-1',
      actionId: 'act-1',
      accountRef: 'acct:test',
      paramsDigest: SHA,
      objectLabel: 'fixture 火锅店',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const before = evaluateConfirmGate(built.card, {
      actionId: 'act-1',
      taskRevision: built.card.taskRevision,
      now: epochToIso8601(quote.pricedAt),
    });
    expect(before.ok).toBe(true);

    const atExpiry = evaluateConfirmGate(built.card, {
      actionId: 'act-1',
      taskRevision: built.card.taskRevision,
      now: epochToIso8601(quote.expiresAt),
    });
    expect(atExpiry.ok).toBe(false);
    if (!atExpiry.ok) expect(atExpiry.reason).toBe('expired');
  });
});

// ===========================================================================
// I3/I5 确认：过期不落地 + 绝不本地自签
// ===========================================================================

describe('F10 接线 · confirmQuote 走 F05/K07 原生信任路径', () => {
  function confirmInput(
    quoteCard: ReturnType<typeof buildQuoteCard>,
    nativeTrust: NativeTrustPort | null,
    now: string,
    trustOptions?: TrustOptions,
  ) {
    return {
      quoteCard,
      cardId: 'card-1',
      actionId: 'act-1',
      accountRef: 'acct:test' as const,
      paramsDigest: SHA,
      objectLabel: 'fixture 火锅店',
      nativeTrust,
      now,
      ...(trustOptions === undefined ? {} : { trustOptions }),
    };
  }

  it('I3 过期报价 ⇒ confirmQuote 返回 quote-not-usable，且从未触碰信任端口', async () => {
    const { session, clock } = makeSession();
    const quote = await session.requestQuote();
    clock.advance(DEFAULT_QUOTE_TTL_MS);
    const fake = makeFakeTrust(TASK_ID);

    const res = confirmQuote(confirmInput(buildQuoteCard(session, quote), fake.port, epochToIso8601(clock.now())));

    expect(res.ok).toBe(false);
    if (!res.ok && res.reason === 'quote-not-usable') {
      expect(res.rejection).toBe('quote_expired');
      expect(res.requiresReconfirmation).toBe(true);
    } else {
      throw new Error(`预期 quote-not-usable，实际 ${JSON.stringify(res)}`);
    }
    expect(fake.calls).toEqual([]);
  });

  it('I5 未注入 K07 账本 ⇒ native-trust-unavailable（绝不在本地自签）', async () => {
    const { session } = makeSession();
    const quote = await session.requestQuote();
    const res = confirmQuote(confirmInput(buildQuoteCard(session, quote), null, epochToIso8601(quote.pricedAt)));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('native-trust-unavailable');
  });

  it('账本在场但缺任务身份 ⇒ task-identity-missing，且从未触碰账本（不自造 taskId）', async () => {
    const { session } = makeSession();
    const quote = await session.requestQuote();
    const fake = makeFakeTrust(TASK_ID);
    const { client } = realClient((c) => Promise.resolve(terminal(c)), fake.port);

    // 不传 trustOptions ⇒ F10 没有可用的真实任务身份，必须 fail-closed。
    const res = confirmQuote(
      confirmInput(buildQuoteCard(session, quote), client.nativeTrust, epochToIso8601(quote.pricedAt)),
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('task-identity-missing');
      if (res.reason === 'task-identity-missing') expect(res.message).toContain('taskId');
    }
    expect(fake.calls).toEqual([]);
  });

  it('可用报价 + 真实 KernelClient.nativeTrust ⇒ 经 F05 账本按 (taskId, actionId) 签发一次性授权', async () => {
    const { session } = makeSession();
    const quote = await session.requestQuote();
    const fake = makeFakeTrust(TASK_ID);
    const { client } = realClient((c) => Promise.resolve(terminal(c)), fake.port);

    const res = confirmQuote(
      confirmInput(buildQuoteCard(session, quote), client.nativeTrust, epochToIso8601(quote.pricedAt), {
        taskId: TASK_ID,
      }),
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.trust.ok).toBe(true);
      expect(res.card.status).toBe('confirmed');
      expect(res.card.grant?.consumed).toBe(false);
      // 真实任务身份一路透传到账本签发的授权（替身对不符的 taskId 会抛错）。
      if (res.trust.ok) expect(res.trust.grant.taskId).toBe(TASK_ID);
    }
    expect(fake.calls).toEqual(['recordConfirmAction', 'attest', 'issueGrant']);
  });
});

// ===========================================================================
// I6 进程重启后必须重新取价
// ===========================================================================

describe('F10 接线 · 进程重启后重新取价', () => {
  it('只有引用、没有报价对象（内存丢失）⇒ session-reset', () => {
    const restarted = makeSession();
    const plan = planQuoteResume({ session: restarted.session, quote: null });
    expect(plan.requiresReQuote).toBe(true);
    expect(plan.reason).toBe('session-reset');
    expect(plan.quoteCard).toBeNull();
  });

  it('重启前报价对象在新会话里 not_current ⇒ requiresReQuote，重新取价才恢复', async () => {
    const before = makeSession();
    const oldQuote = await before.session.requestQuote();

    // 进程重启：全新会话，内存里没有当前报价（不同 quoteRefPrefix 避免 fixture 引用撞号）。
    const restarted = makeSession('restarted');
    const plan = planQuoteResume({ session: restarted.session, quote: oldQuote });

    expect(plan.requiresReQuote).toBe(true);
    expect(resumeRequiresReQuote(plan)).toBe(true);
    expect(plan.reason).toBe('quote-stale');
    expect(plan.quoteCard?.confirmable).toBe(false);
    expect(plan.quoteCard?.state).toBe('superseded');
    expect(plan.quoteCard?.staleReasons).toContain('not_current');

    // 重新取价后恢复可用。
    const newQuote = await restarted.session.requestQuote();
    expect(newQuote.quoteRef).not.toBe(oldQuote.quoteRef);
    const recovered = planQuoteResume({ session: restarted.session, quote: newQuote });
    expect(recovered.requiresReQuote).toBe(false);
    expect(recovered.reason).toBe('reusable');
    expect(recovered.quoteCard?.confirmable).toBe(true);
  });

  it('同一会话内可用报价 ⇒ reusable（不为过拒绝）', async () => {
    const { session } = makeSession();
    const quote = await session.requestQuote();
    const plan = planQuoteResume({ session, quote });
    expect(plan.requiresReQuote).toBe(false);
    expect(plan.reason).toBe('reusable');
  });
});

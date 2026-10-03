/**
 * F05 集成验收：**真实 K07 账本接入适配边界**。
 *
 * 本文件覆盖 F05 向协调者提出的两条集成请求的落点：
 *   1. 把真实 K07 `AuthorizationLedger` 作为 `NativeTrustPort` 注入
 *      （`asNativeTrustPort` / `createKernelTrustSubmitter`），授权确由账本签发；
 *   2. 原生确认页 id **可注入**（`createKernelTrustSubmitter` 强制校验 surface，
 *      真实页 id 作为授权 `grantedBy`），不再依赖占位 `DEFAULT_NATIVE_SURFACE`。
 *
 * 并保留 I3 回归：**旧 revision 的卡不得提交**——先在 `evaluateConfirmGate` 直接被拒，
 * 再经真实账本路径被拒且**账本零写入**。
 *
 * 真实模块：`apps/mobile-kernel/actions/`（`AuthorizationLedger` / `createManualClock`），
 * 与 `trust.test.ts` 一致，跨线消费以证明前端确实把签发交给内核原生路径。
 */

import { describe, expect, it } from 'vitest';

import {
  asNativeConfirmSurface,
  asNativeTrustPort,
  createConfirmCard,
  createKernelTrustSubmitter,
  evaluateConfirmGate,
  DEFAULT_NATIVE_SURFACE,
  type ConfirmCardView,
  type ConfirmRequest,
  type ConfirmScope,
  type NativeTrustPort,
} from '../../../apps/mobile-ui/src/decisions/index.js';

import {
  createAuthorizationLedger,
  createManualClock,
  type AuthorizationLedger,
} from '../../../apps/mobile-kernel/actions/index.js';

const T0 = 1_700_000_000_000;
const NOW_ISO = new Date(T0).toISOString();
const EXPIRES_ISO = new Date(T0 + 600_000).toISOString();

/**
 * 任务身份（K-I02 后 K07 `ActionBinding.taskId` 必需，账本键为 `(taskId, actionId)`）。
 * 提交器/端口按任务绑定，F05 不猜。
 */
const TASK_ID = 'task-demo-0001';

function digest(ch: string): `sha256:${string}` {
  return `sha256:${ch.repeat(64)}`;
}

interface Overrides {
  readonly actionId?: string;
  readonly taskRevision?: number;
  readonly amount?: string | null;
  readonly scope?: ConfirmScope | null;
}

function makeCard(overrides: Overrides = {}): ConfirmCardView {
  const amount = overrides.amount === undefined ? '29.90' : overrides.amount;
  return createConfirmCard({
    cardId: 'card-1',
    actionId: overrides.actionId ?? 'act-1',
    taskRevision: overrides.taskRevision ?? 3,
    subject: { objectRef: 'sku:coffee-1', objectLabel: '拿铁（大杯）' },
    scope: overrides.scope === undefined ? 'purchase' : overrides.scope,
    price: amount === null ? null : { amount, currency: 'CNY' },
    expiresAt: EXPIRES_ISO,
    paramsDigest: digest('a'),
    accountRef: 'acct:demo-0001',
    quoteRef: 'quote:2026-10-03-1',
  });
}

function makeLedger(clockMs: number = T0): AuthorizationLedger {
  return createAuthorizationLedger({ clock: createManualClock(clockMs) });
}

const REQUEST = { actionId: 'act-1', taskRevision: 3, now: NOW_ISO } as const satisfies ConfirmRequest;

/** 一个被当作"真实原生页 id"的注入值（非占位）。 */
const REAL_SURFACE = 'android.activity.ConfirmPaymentActivity';

describe('F05 集成 / asNativeTrustPort：真实 K07 账本直通为 NativeTrustPort', () => {
  it('直通同一对象（结构兼容，不复制、不包裹），并满足 NativeTrustPort', () => {
    const ledger = makeLedger();
    const port: NativeTrustPort = asNativeTrustPort(ledger);
    expect(port).toBe(ledger); // 同一引用：账本原子性 / 单写者语义原样保留
    // 端口方法确实转发到真实账本（K-I02 起键是 (taskId, actionId)）。
    expect(port.getConfirmAction(TASK_ID, 'act-1')).toBeUndefined();
  });
});

describe('F05 集成 / createKernelTrustSubmitter：真实账本 + 可注入 surface', () => {
  it('注入的真实 surface 成为授权 grantedBy，授权由账本签发', () => {
    const ledger = makeLedger();
    const submitter = createKernelTrustSubmitter({ ledger, taskId: TASK_ID, surface: REAL_SURFACE });
    expect(submitter.surface).toBe(REAL_SURFACE);
    expect(submitter.port).toBe(ledger);

    const result = submitter.submit(makeCard(), REQUEST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 页 id 可注入：授权 grantedBy 就是注入值，而非占位。
    expect(result.grant.grantedBy).toBe(REAL_SURFACE);
    expect(result.grant.grantedBy).not.toBe(DEFAULT_NATIVE_SURFACE);
    // 授权确由真实账本签发，且绑定的是注入的任务身份。
    expect(result.grant.taskId).toBe(TASK_ID);
    expect(ledger.getGrant(result.grant.grantId)).toBeDefined();
    expect(ledger.observedStateOf(TASK_ID, 'act-1')).toBe('authorized');
    expect(result.card.status).toBe('confirmed');
  });

  it('surface 为空 / 纯空白 ⇒ 构造即拒（fail-closed，账本零写入）', () => {
    const ledger = makeLedger();
    for (const bad of ['', '   ', '\t\n']) {
      expect(() => createKernelTrustSubmitter({ ledger, taskId: TASK_ID, surface: bad })).toThrow(TypeError);
    }
    expect(ledger.counts().confirms).toBe(0);
    expect(ledger.counts().grants).toBe(0);
  });

  it('taskId 为空 / 纯空白 ⇒ 构造即拒（fail-closed，不猜任务身份，账本零写入）', () => {
    const ledger = makeLedger();
    for (const badTask of ['', '   ', '\t\n']) {
      expect(() => createKernelTrustSubmitter({ ledger, taskId: badTask, surface: REAL_SURFACE })).toThrow(TypeError);
    }
    // 运行时防御：类型系统外的调用方也可能传进来。
    expect(() =>
      createKernelTrustSubmitter({ ledger, taskId: undefined as unknown as string, surface: REAL_SURFACE }),
    ).toThrow(TypeError);
    expect(ledger.counts().confirms).toBe(0);
    expect(ledger.counts().grants).toBe(0);
  });

  it('绑定后的 consume 走真实账本：第二次占用 ⇒ already-consumed', () => {
    const ledger = makeLedger();
    const submitter = createKernelTrustSubmitter({ ledger, taskId: TASK_ID, surface: REAL_SURFACE });
    const submitted = submitter.submit(makeCard(), REQUEST);
    if (!submitted.ok) throw new Error(`确认应成功：${submitted.detail}`);

    const binding = {
      taskId: submitted.grant.taskId,
      actionId: submitted.grant.actionId,
      accountRef: submitted.grant.accountRef,
      taskRevision: submitted.grant.taskRevision,
      paramsDigest: submitted.grant.paramsDigest,
      quoteRef: submitted.grant.quoteRef,
      amount: submitted.grant.amount,
      currency: submitted.grant.currency,
      scope: submitted.grant.scope,
    };

    const first = submitter.consume(submitted.grant.grantId, binding);
    expect(first.ok).toBe(true);

    const second = submitter.consume(submitted.grant.grantId, binding);
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toBe('already-consumed');
    expect(second.ok === false && second.code).toBe('grant_already_consumed');
  });
});

describe('F05 集成 / asNativeConfirmSurface：品牌化与拒绝', () => {
  it('非空页 id 通过校验并保持原值', () => {
    expect(asNativeConfirmSurface(REAL_SURFACE)).toBe(REAL_SURFACE);
  });

  it('空 / 纯空白 / 非字符串 ⇒ 拒', () => {
    expect(() => asNativeConfirmSurface('')).toThrow(TypeError);
    expect(() => asNativeConfirmSurface('  ')).toThrow(TypeError);
    // 运行时防御：类型系统外的调用方也可能传进来。
    expect(() => asNativeConfirmSurface(undefined as unknown as string)).toThrow(TypeError);
  });
});

describe('F05 集成 / I3 回归：旧 revision 的卡不得提交', () => {
  it('evaluateConfirmGate 直接拒绝 revision 落后的提交', () => {
    const stale = makeCard({ taskRevision: 4 });
    const gate = evaluateConfirmGate(stale, { actionId: 'act-1', taskRevision: 3, now: NOW_ISO });
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.reason).toBe('revision-mismatch');
  });

  it('经真实账本路径：旧卡被 F05 闸门先拦，账本零写入（不触碰 K07）', () => {
    const ledger = makeLedger();
    const submitter = createKernelTrustSubmitter({ ledger, taskId: TASK_ID, surface: REAL_SURFACE });
    const stale = makeCard({ taskRevision: 4 });

    const result = submitter.submit(stale, { actionId: 'act-1', taskRevision: 3, now: NOW_ISO });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('revision-mismatch');
    expect(result.ok === false && result.code).toBeNull();

    // 闸门在写账本之前拦下：确认请求 / 授权均为 0。
    expect(ledger.counts().confirms).toBe(0);
    expect(ledger.counts().grants).toBe(0);
    expect(ledger.getConfirmAction(TASK_ID, 'act-1')).toBeUndefined();
  });

  it('反向对照：revision 相符则通过（证明上面的拦截不是空壳）', () => {
    const ledger = makeLedger();
    const submitter = createKernelTrustSubmitter({ ledger, taskId: TASK_ID, surface: REAL_SURFACE });
    const result = submitter.submit(makeCard({ taskRevision: 3 }), REQUEST);
    expect(result.ok).toBe(true);
    expect(ledger.counts().grants).toBe(1);
  });
});

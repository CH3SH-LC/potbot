/**
 * F05 验收：**最终确认走 K07 原生信任路径**。
 *
 * 本文件用**真实的** K07 模块 `apps/mobile-kernel/actions/`（`AuthorizationLedger`）
 * 作为注入端口，实跑 `submitThroughNativeTrust`，证明：
 *   1. 授权由 K07 账本**签发**，F05 不再本地自签；
 *   2. F05 闸门（旧 revision / 过期 / 一次性 / 可见性）仍先跑；
 *   3. K07 的可信根（`untrusted_attestation`）与绑定不符（`attestation_binding_mismatch`）
 *      被如实映射为拒因，**不降级**成本地签发；
 *   4. 一键一次性在权威侧成立（第二次 consume ⇒ `already-consumed`）；
 *   5. 走信任路径产出的 `ConfirmAction` 仍通过契约校验器 `contracts/mobile-v1/validate.mjs`。
 *
 * 反向对照（证明判据不是空壳）：
 *   - 本地 `confirmCard` 自签的授权**不在** K07 账本里（`getGrant` 取不到）——
 *     即"前端自签"在权威侧无效；
 *   - 伪造的确认凭证 ⇒ K07 抛 `untrusted_attestation`。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  consumeGrantThroughTrust,
  createConfirmCard,
  confirmCard,
  defaultWireBridge,
  nativeTrustErrorCode,
  submitThroughNativeTrust,
  toNativeConfirmAction,
  toNativeBinding,
  CURRENCY_MINOR_DIGITS,
  DEFAULT_NATIVE_SURFACE,
  type ConfirmCardView,
  type ConfirmRequest,
  type ConfirmScope,
  type NativeAttestation,
  type NativeTrustPort,
  type WireBridge,
} from '../../../apps/mobile-ui/src/decisions/index.js';

// 真实 K07 模块（跨线消费，证明前端确实把签发交给内核原生路径）
import {
  createAuthorizationLedger,
  createManualClock,
  formatWireAmount,
  formatWireTimestamp,
  isAuthorizationError,
  parseWireAmount,
  parseWireTimestamp,
  type AuthorizationLedger,
} from '../../../apps/mobile-kernel/actions/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const VALIDATOR = join(REPO_ROOT, 'contracts', 'mobile-v1', 'validate.mjs');

/** 夹具时间原点（与真实时间无关，仅用于过期判据）。 */
const T0 = 1_700_000_000_000;
const NOW_ISO = new Date(T0).toISOString(); // 2023-11-14T22:13:20.000Z
const EXPIRES_ISO = new Date(T0 + 600_000).toISOString();

/**
 * 任务身份（K-I02 之后 K07 `ActionBinding.taskId` 是**必需**项，账本键为
 * `(taskId, actionId)`，默认 grantId 为 `grant:<taskId>:<actionId>`）。
 * F05 不猜任务 id：由调用方经 `TrustOptions.taskId` 如实注入。
 */
const TASK_ID = 'task-demo-0001';

/** 走真实账本提交：注入任务身份（K07 必需）。 */
function submit(
  card: ConfirmCardView,
  request: ConfirmRequest,
  port: NativeTrustPort,
): ReturnType<typeof submitThroughNativeTrust> {
  return submitThroughNativeTrust(card, request, port, { taskId: TASK_ID });
}

function digest(ch: string): `sha256:${string}` {
  return `sha256:${ch.repeat(64)}`;
}

interface Overrides {
  readonly actionId?: string;
  readonly taskRevision?: number;
  readonly amount?: string | null;
  readonly scope?: ConfirmScope | null;
  readonly expiresAt?: string;
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
    expiresAt: overrides.expiresAt ?? EXPIRES_ISO,
    paramsDigest: digest('a'),
    accountRef: 'acct:demo-0001',
    quoteRef: 'quote:2026-10-03-1',
  });
}

/** 造一枚真账本；时钟固定在 `clockMs`。 */
function makeLedger(clockMs: number = T0): AuthorizationLedger {
  return createAuthorizationLedger({ clock: createManualClock(clockMs) });
}

describe('F05 / 最终确认：授权由 K07 签发（不是本地自签）', () => {
  it('成功路径：授权来自 K07 账本，卡置为已确认', () => {
    const ledger = makeLedger();
    const card = makeCard();

    const result = submit(card, { actionId: 'act-1', taskRevision: 3, now: NOW_ISO }, ledger);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 授权确实是 K07 账本签发的（K-I02 起默认 grantId = `grant:<taskId>:<actionId>`，
    // 与 F05 本地自签的 `grant:<actionId>:r<revision>` 形状不同）。
    expect(result.grant.taskId).toBe(TASK_ID);
    expect(result.grant.grantId).toBe(`grant:${TASK_ID}:act-1`);
    expect(ledger.getGrant(result.grant.grantId)).toBeDefined();
    expect(result.grant.state).toBe('authorized');
    expect(result.grant.consumed).toBe(false);
    expect(result.grant.grantedBy).toBe(DEFAULT_NATIVE_SURFACE);

    // 账本侧可观测状态：已发行未占用（账本键是 (taskId, actionId)）。
    expect(ledger.observedStateOf(TASK_ID, 'act-1')).toBe('authorized');
    expect(ledger.counts().grants).toBe(1);

    // 卡置为已确认，且契约形状的授权被挂上。
    expect(result.card.status).toBe('confirmed');
    expect(result.action.authorizationGrant?.grantId).toBe(`grant:${TASK_ID}:act-1`);
    expect(result.action.authorizationGrant?.consumed).toBe(false);
    expect(result.action.amount).toBe('29.90');
    expect(result.action.currency).toBe('CNY');

    // 入参卡未被就地修改（纯函数）。
    expect(card.status).toBe('pending');
    expect(card.grant).toBeNull();
  });

  it('反向对照：本地 confirmCard 自签的授权**不在** K07 账本里（前端自签在权威侧无效）', () => {
    const ledger = makeLedger();
    const local = confirmCard(makeCard(), { actionId: 'act-1', taskRevision: 3, now: NOW_ISO });
    if (!local.ok) throw new Error('本地确认应通过');
    const localGrantId = local.action.authorizationGrant?.grantId;
    expect(localGrantId).toBe('grant:act-1:r3');
    // K07 账本从未签发过它。
    expect(ledger.getGrant(localGrantId ?? '')).toBeUndefined();
    expect(ledger.counts().grants).toBe(0);
  });

  it('F05 闸门先跑：旧 revision 的卡在触碰账本前被拦下（账本零写入）', () => {
    const ledger = makeLedger();
    const stale = makeCard({ taskRevision: 4 });
    const result = submit(stale, { actionId: 'act-1', taskRevision: 3, now: NOW_ISO }, ledger);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('revision-mismatch');
    expect(result.ok === false && result.code).toBeNull();
    // 账本里没有任何确认请求 / 授权。
    expect(ledger.counts().confirms).toBe(0);
    expect(ledger.counts().grants).toBe(0);
  });

  it('F05 闸门先跑：缺价格的卡被 missing-visible-field 拦下', () => {
    const ledger = makeLedger();
    const result = submit(
      makeCard({ amount: null }),
      { actionId: 'act-1', taskRevision: 3, now: NOW_ISO },
      ledger,
    );
    expect(result.ok === false && result.reason).toBe('missing-visible-field');
    expect(ledger.counts().confirms).toBe(0);
  });

  it('过期：F05 侧过期（now ≥ expiresAt）在账本前拦下，reason=expired', () => {
    const ledger = makeLedger();
    const result = submit(
      makeCard(),
      { actionId: 'act-1', taskRevision: 3, now: EXPIRES_ISO },
      ledger,
    );
    expect(result.ok === false && result.reason).toBe('expired');
    expect(ledger.counts().confirms).toBe(0);
  });

  it('过期：F05 通过但 K07 时钟已过期 ⇒ 账本拒发（reason=expired，code=confirm_expired）', () => {
    // K07 时钟在 expiresAt 之后；F05 的 request.now 仍在期内（两套时钟故意错开，
    // 证明 K07 时钟才是信任路径的权威）。
    const ledger = makeLedger(T0 + 700_000);
    const result = submit(makeCard(), { actionId: 'act-1', taskRevision: 3, now: NOW_ISO }, ledger);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('expired');
    expect(result.ok === false && result.code).toBe('confirm_expired');
    // 未发行授权。
    expect(ledger.counts().grants).toBe(0);
  });

  it('重复点击：已确认的卡再提交 ⇒ not-pending（账本仍只有一条确认请求）', () => {
    const ledger = makeLedger();
    const request = { actionId: 'act-1', taskRevision: 3, now: NOW_ISO } as const;
    const first = submit(makeCard(), request, ledger);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = submit(first.card, request, ledger);
    expect(second.ok === false && second.reason).toBe('not-pending');
    expect(ledger.counts().confirms).toBe(1);
    expect(ledger.counts().grants).toBe(1);
  });
});

describe('F05 / 可信根与绑定：K07 拒因如实映射，不降级', () => {
  it('反向对照：伪造的确认凭证被 K07 拒（untrusted_attestation）', () => {
    const ledger = makeLedger();
    const native = toNativeConfirmAction(makeCard(), TASK_ID);
    if (native === null) throw new Error('卡应可桥接');
    ledger.recordConfirmAction(native);

    const forged = {
      actionId: 'act-1',
      binding: { ...native },
      surface: 'attacker.surface',
      confirmedAt: T0,
    } as unknown as NativeAttestation;

    let caught: unknown;
    try {
      ledger.issueGrant(forged);
    } catch (error) {
      caught = error;
    }
    expect(isAuthorizationError(caught)).toBe(true);
    expect(nativeTrustErrorCode(caught)).toBe('untrusted_attestation');
    expect(ledger.counts().grants).toBe(0);
  });

  it('凭证签发后账本内容被改 ⇒ attestation_binding_mismatch 被映射为 native-trust-rejected', () => {
    const base = makeLedger();
    const actionId = 'act-1';

    // 用一个端口包装真账本：在 issueGrant 前偷偷 amend 账本金额，
    // 触发真实的 K07 attestation_binding_mismatch。
    const tamperingPort: NativeTrustPort = {
      recordConfirmAction: (a) => base.recordConfirmAction(a),
      getConfirmAction: (taskId, id) => base.getConfirmAction(taskId, id),
      attest: (taskId, id, options) => base.attest(taskId, id, options),
      issueGrant: (att) => {
        const current = base.getConfirmAction(TASK_ID, actionId);
        if (current === undefined) throw new Error('夹具应有确认请求');
        base.amendConfirmAction(TASK_ID, actionId, { ...current, amount: current.amount + 1 });
        return base.issueGrant(att);
      },
      consume: (input) => base.consume(input),
    };

    const result = submit(makeCard(), { actionId, taskRevision: 3, now: NOW_ISO }, tamperingPort);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('native-trust-rejected');
    expect(result.ok === false && result.code).toBe('attestation_binding_mismatch');
    // 未发行授权——拒因链上没有"降级成本地签发"这一步。
    expect(base.counts().grants).toBe(0);
  });

  it('卡面参数变化：账本里已有不同绑定的确认请求 ⇒ 拒绝（confirm_binding_stale），不批新卡', () => {
    const ledger = makeLedger();
    // 先用一张卡登记账本
    const first = submit(makeCard(), { actionId: 'act-1', taskRevision: 3, now: NOW_ISO }, ledger);
    expect(first.ok).toBe(true);

    // 换一张同 actionId 但金额不同的卡（模拟参数变了却复用旧 actionId）
    const changed = makeCard({ amount: '99.00' });
    const result = submit(changed, { actionId: 'act-1', taskRevision: 3, now: NOW_ISO }, ledger);
    expect(result.ok).toBe(false);
    // 要么被 F05 闸门挡（卡未确认前不会走到这里），要么账本绑定不一致——
    // 本用例里卡是 pending，故走账本绑定核对分支。
    expect(result.ok === false && result.reason).toBe('native-trust-rejected');
    expect(result.ok === false && result.code).toBe('confirm_binding_stale');
  });
});

describe('F05 / 一键一次性：占用走 K07 账本', () => {
  it('第一次占用成功，第二次 ⇒ already-consumed（重复点击权威侧落点）', () => {
    const ledger = makeLedger();
    const request = { actionId: 'act-1', taskRevision: 3, now: NOW_ISO } as const;
    const submitted = submit(makeCard(), request, ledger);
    if (!submitted.ok) throw new Error('确认应成功');

    const binding = toNativeBinding(submitted.card, TASK_ID);
    if (binding === null) throw new Error('卡应可桥接为绑定');

    const first = consumeGrantThroughTrust(ledger, submitted.grant.grantId, binding);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.grant.consumed).toBe(true);
      expect(first.grant.consumedAt).not.toBeNull();
    }

    const second = consumeGrantThroughTrust(ledger, submitted.grant.grantId, binding);
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toBe('already-consumed');
    expect(second.ok === false && second.code).toBe('grant_already_consumed');
  });

  it('绑定不符：占用时实际值与授权绑定某一项不一致 ⇒ binding-mismatch', () => {
    const ledger = makeLedger();
    const request = { actionId: 'act-2', taskRevision: 3, now: NOW_ISO } as const;
    const submitted = submit(makeCard({ actionId: 'act-2' }), request, ledger);
    if (!submitted.ok) throw new Error('确认应成功');

    const binding = toNativeBinding(submitted.card, TASK_ID);
    if (binding === null) throw new Error('卡应可桥接为绑定');

    // 篡改金额一项后占用
    const tampered = { ...binding, amount: binding.amount + 1 };
    const result = consumeGrantThroughTrust(ledger, submitted.grant.grantId, tampered);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('binding-mismatch');
    expect(result.ok === false && result.code).toBe('grant_binding_mismatch');
  });
});

describe('F05 / 编码桥：按币种最小单位（裁决），与 K07 codec 等价', () => {
  it('defaultWireBridge 按币种位数换算（CNY=2 ⇒ 分）', () => {
    expect(defaultWireBridge.toMinorUnits('29.90', 'CNY')).toBe(2990);
    expect(defaultWireBridge.toMinorUnits('29.9', 'CNY')).toBe(2990);
    expect(defaultWireBridge.toMinorUnits('29.9000', 'CNY')).toBe(2990);
    expect(defaultWireBridge.toMinorUnits('100', 'CNY')).toBe(10000);
    expect(defaultWireBridge.toMinorUnits('100', 'JPY')).toBe(100); // 0 位
    expect(defaultWireBridge.toMinorUnits('1.234', 'BHD')).toBe(1234); // 3 位
    expect(defaultWireBridge.fromMinorUnits(2990, 'CNY')).toBe('29.90');
    expect(defaultWireBridge.fromMinorUnits(100, 'JPY')).toBe('100');
    expect(defaultWireBridge.fromMinorUnits(1, 'BHD')).toBe('0.001');
  });

  it('不可精确表示 / 表外币种一律拒绝（fail-closed，不四舍五入）', () => {
    expect(() => defaultWireBridge.toMinorUnits('1.2345', 'CNY')).toThrow(); // 2 位币种，第 3 位非零
    expect(() => defaultWireBridge.toMinorUnits('1.2300', 'CNY')).not.toThrow(); // 低位全零可精确
    expect(() => defaultWireBridge.toMinorUnits('29.90', 'XYZ')).toThrow(); // 表外币种
    expect(() => defaultWireBridge.toMinorUnits('29.9.9', 'CNY')).toThrow();
  });

  it('时间戳换算：ISO ⇄ 毫秒', () => {
    const ms = defaultWireBridge.toEpochMs(EXPIRES_ISO);
    expect(Number.isSafeInteger(ms)).toBe(true);
    expect(defaultWireBridge.fromEpochMs(ms)).toBe(EXPIRES_ISO);
    expect(() => defaultWireBridge.toEpochMs('2026-02-30T00:00:00Z')).toThrow(); // 非法日历时刻
    expect(() => defaultWireBridge.toEpochMs('2026-10-03T10:10:00.123456Z')).toThrow(); // 微秒非零
  });

  it('桥接出的原生确认请求携带最小单位金额与整数期限', () => {
    const native = toNativeConfirmAction(makeCard(), TASK_ID);
    if (native === null) throw new Error('卡应可桥接');
    expect(native.taskId).toBe(TASK_ID); // 任务身份随绑定一路携带
    expect(native.amount).toBe(2990); // CNY 分
    expect(native.currency).toBe('CNY');
    expect(native.scope).toBe('purchase');
    expect(Number.isSafeInteger(native.expiresAt)).toBe(true);
    expect(native.expiresAt).toBe(Date.parse(EXPIRES_ISO));
  });

  it('非法金额 / 缺价格 / 缺任务身份不可桥接（返回 null，不编造）', () => {
    expect(toNativeConfirmAction(makeCard({ amount: '1.2345' }), TASK_ID)).toBeNull(); // CNY 不可表示
    expect(toNativeConfirmAction(makeCard(), '')).toBeNull(); // 任务身份缺失
    const nullPrice = makeCard({ amount: null });
    expect(toNativeConfirmAction(nullPrice, TASK_ID)).toBeNull();
    expect(toNativeBinding(nullPrice, TASK_ID)).toBeNull();
  });

  it('等价性：defaultWireBridge 与真实 K07 wire-codec 输出逐字一致', () => {
    const corpus: readonly (readonly [string, string])[] = [
      ['29.90', 'CNY'],
      ['29.9', 'CNY'],
      ['29.9000', 'CNY'],
      ['0', 'CNY'],
      ['100', 'CNY'],
      ['100', 'JPY'],
      ['0.001', 'BHD'],
      ['1.2300', 'CNY'],
      ['99999999.99', 'USD'],
    ];
    for (const [amount, currency] of corpus) {
      const expected = parseWireAmount(amount, currency);
      expect(defaultWireBridge.toMinorUnits(amount, currency)).toBe(expected);
      expect(defaultWireBridge.fromMinorUnits(expected, currency)).toBe(formatWireAmount(expected, currency));
    }
    // 币种位数表逐条一致（经往返间接核对 K07 的 minorDigitsOf）
    for (const [currency, digits] of Object.entries(CURRENCY_MINOR_DIGITS)) {
      const minor = 10 ** digits;
      expect(parseWireAmount(formatWireAmount(minor, currency), currency)).toBe(minor);
    }
    // 时间戳等价
    for (const iso of ['2026-10-03T10:10:00Z', '2026-10-03T10:10:00.123Z', '1970-01-01T00:00:00Z']) {
      expect(defaultWireBridge.toEpochMs(iso)).toBe(parseWireTimestamp(iso));
      expect(defaultWireBridge.fromEpochMs(parseWireTimestamp(iso))).toBe(formatWireTimestamp(parseWireTimestamp(iso)));
    }
    // 拒绝集也一致：本桥拒的，K07 codec 同样拒。
    expect(() => defaultWireBridge.toMinorUnits('1.2345', 'CNY')).toThrow();
    expect(() => parseWireAmount('1.2345', 'CNY')).toThrow();
    expect(() => defaultWireBridge.toMinorUnits('29.90', 'XYZ')).toThrow();
    expect(() => parseWireAmount('29.90', 'XYZ')).toThrow();
  });

  it('可注入自定义 WireBridge（生产可换成 K07 codec 等价实现）', () => {
    const k07Bridge: WireBridge = {
      toMinorUnits: (a, c) => parseWireAmount(a, c),
      fromMinorUnits: (m, c) => formatWireAmount(m, c),
      toEpochMs: (iso) => parseWireTimestamp(iso),
      fromEpochMs: (ms) => formatWireTimestamp(ms),
    };
    const native = toNativeConfirmAction(makeCard(), TASK_ID, k07Bridge);
    if (native === null) throw new Error('卡应可桥接');
    expect(native.amount).toBe(2990);

    // 完整信任路径也可注入该桥
    const ledger = makeLedger();
    const result = submitThroughNativeTrust(
      makeCard(),
      { actionId: 'act-1', taskRevision: 3, now: NOW_ISO },
      ledger,
      { taskId: TASK_ID, bridge: k07Bridge },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.grant.amount).toBe(2990);
  });
});

describe('F05 / 信任路径产物仍通过契约校验器', () => {
  it('K07 签发的授权序列化后通过 validate.mjs', () => {
    expect(existsSync(VALIDATOR)).toBe(true);
    const ledger = makeLedger();
    const result = submit(makeCard(), { actionId: 'act-1', taskRevision: 3, now: NOW_ISO }, ledger);
    if (!result.ok) throw new Error(`信任路径确认应成功，实际：${result.detail}`);

    const dir = mkdtempSync(join(tmpdir(), 'f05-trust-contract-'));
    try {
      writeFileSync(
        join(dir, 'trust-confirm-action.json'),
        JSON.stringify(
          { $schemaRef: 'schemas/confirm-action.schema.json', note: 'trust-path', value: result.action },
          null,
          2,
        ),
        'utf8',
      );
      const stdout = execFileSync(process.execPath, [VALIDATOR, dir], { encoding: 'utf8' });
      expect(stdout).toContain('PASS  trust-confirm-action.json');
      expect(stdout).toContain('summary: 1 PASS, 0 FAIL');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

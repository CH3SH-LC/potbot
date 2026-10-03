/**
 * K07 独立验证 ③：**可信确认根**——本包要关掉的那条 P0。
 *
 * P0 原文（外部监督点名、仍未关闭）：
 * `apps/demo/server/adapters-actions.ts:673` 的 `user_approved` 与 `source` **取自请求体**，
 * 而执行路径只检查 `revoked`（:875）——即"客户端可自称用户已批准"。
 *
 * 本文件逐条钉住 K07 的三层对策：
 *   1. 展示数据只能从账本读（`getDisplay` 的 `source === 'ledger'`，声明与账本不符即拒）；
 *   2. 授权只能由账本签发的确认凭证换来（形状相同的自造对象一律 `untrusted_attestation`）；
 *   3. 关键条件变化即失效（账本改写后旧凭证作废）。
 */

import { describe, expect, it } from 'vitest';

import {
  BINDING_FIELDS,
  CONFIRM_SCOPES,
  SUBMISSION_STATES,
  createTrustedReceipt,
  type ActionBinding,
  type ConfirmAction,
  type ConfirmationAttestation,
} from '../../../apps/mobile-kernel/actions/index.js';
import { T0, baseConfirm, binding, expectError, issuedGrant, setupFixture } from './fixtures.js';

describe('可信确认根 ①：确认页展示数据只能来自账本', () => {
  it('getDisplay 明确标注来源是账本，且返回值会随账本内容变化（不是回显调用方字符串）', () => {
    const { ledger, confirm } = setupFixture();

    const first = ledger.getDisplay(confirm.taskId, confirm.actionId);
    expect(first.source).toBe('ledger');
    expect(first.amount).toBe(3980);
    expect(first.currency).toBe('CNY');
    expect(first.accountRef).toBe(confirm.accountRef);
    expect(first.quoteRef).toBe(confirm.quoteRef);
    expect(first.paramsDigest).toBe(confirm.paramsDigest);
    expect(first.expiresAt).toBe(confirm.expiresAt);
    expect(Object.isFrozen(first)).toBe(true);

    // 账本内容被改写：再读一次必须反映**账本的新值**
    // （若实现是回显调用方传入的字符串，这里就会露馅）
    ledger.amendConfirmAction(confirm.taskId, confirm.actionId, {
      ...confirm,
      amount: 4500,
      quoteRef: 'quote:mt-002',
      accountRef: 'acct:meituan:9900',
    });
    const second = ledger.getDisplay(confirm.taskId, confirm.actionId);
    expect(second.amount).toBe(4500);
    expect(second.quoteRef).toBe('quote:mt-002');
    expect(second.accountRef).toBe('acct:meituan:9900');
    expect(second.source).toBe('ledger');
  });

  it('调用方传入的展示摘要与账本不一致 ⇒ 逐项拒绝，且拒因指出是哪一项', () => {
    const { ledger, confirm } = setupFixture();

    const wrong: ReadonlyArray<readonly [string, Partial<ActionBinding>]> = [
      ['amount', { amount: 1 }],
      ['accountRef', { accountRef: 'acct:attacker:0001' }],
      ['paramsDigest', { paramsDigest: 'sha256:deadbeef' }],
      ['quoteRef', { quoteRef: 'quote:mt-999' }],
      ['scope', { scope: 'external-mutation' }],
      ['taskRevision', { taskRevision: 99 }],
      ['currency', { currency: 'USD' }],
      ['actionId', { actionId: 'act-other' }],
    ];
    for (const [field, claim] of wrong) {
      expectError(() => ledger.getDisplay(confirm.taskId, confirm.actionId, claim), 'confirm_digest_mismatch', field);
    }

    // 对照组：与账本一致的声明可以正常读取，并标记 claimVerified
    const ok = ledger.getDisplay(confirm.taskId, confirm.actionId, { amount: 3980, accountRef: confirm.accountRef });
    expect(ok.claimVerified).toBe(true);
    expect(ok.source).toBe('ledger');
    // 未声明的字段照样来自账本
    expect(ok.expiresAt).toBe(confirm.expiresAt);
  });

  it('确认请求字段本身的非法取值在入账时就被拒（不合法就不进账本）', () => {
    const { ledger } = setupFixture();

    const bad: ReadonlyArray<readonly [string, Partial<ConfirmAction>]> = [
      ['amount 浮点', { amount: 39.8 }],
      ['amount 负值', { amount: -1 }],
      ['amount 非数', { amount: Number.NaN }],
      ['currency 小写', { currency: 'cny' }],
      ['currency 符号', { currency: '¥' }],
      ['accountRef 空', { accountRef: '   ' }],
      ['accountRef 形状不符', { accountRef: 'meituan:7788' }],
      ['paramsDigest 空', { paramsDigest: '' }],
      ['paramsDigest 形状不符', { paramsDigest: 'sha256:ABC' }],
      ['scope 空', { scope: '' as never }],
      ['scope 非契约枚举', { scope: 'meituan.order.create' as never }],
      ['taskRevision 小数', { taskRevision: 1.5 }],
      ['expiresAt 非整数', { expiresAt: T0 + 1.5 }],
    ];
    for (const [label, patch] of bad) {
      const badConfirm = baseConfirm({ actionId: `bad-${label}`, ...patch }) as ConfirmAction;
      expectError(() => ledger.recordConfirmAction(badConfirm), 'invalid_confirm_action');
    }

    // 对照：一条合法确认请求可以入账
    expect(() => ledger.recordConfirmAction(baseConfirm({ actionId: 'ok-1' }))).not.toThrow();
    // 重复登记同一个 actionId 也拒
    expectError(() => ledger.recordConfirmAction(baseConfirm({ actionId: 'ok-1' })), 'confirm_already_recorded');
  });

  it('不存在的动作读展示 ⇒ confirm_not_found', () => {
    const { ledger } = setupFixture();
    expectError(() => ledger.getDisplay('task:demo-1', 'act-missing'), 'confirm_not_found');
  });
});

describe('可信确认根 ②：授权只能由账本签发的凭证换来（客户端无法自称已批准）', () => {
  it('形状相同的自造凭证一律拒（untrusted_attestation）', () => {
    const { ledger, confirm } = setupFixture();

    const forged: ConfirmationAttestation = {
      actionId: confirm.actionId,
      binding: confirm,
      surface: 'attacker.js',
      confirmedAt: T0,
    };
    expectError(() => ledger.issueGrant(forged), 'untrusted_attestation');
    expect(ledger.counts().grants).toBe(0);

    // 连"把真凭证 JSON 序列化再解析回来"的副本也不行：可信根是**签发实例**，不是形状
    const real = ledger.attest(confirm.taskId, confirm.actionId, { surface: 'native.confirm' });
    const clone = JSON.parse(JSON.stringify(real)) as ConfirmationAttestation;
    expectError(() => ledger.issueGrant(clone), 'untrusted_attestation');
    expect(ledger.counts().grants).toBe(0);

    // 即使自造凭证里把金额改成 1 分，也不会换来任何授权
    const forgedCheap = { ...forged, binding: { ...confirm, amount: 1 } };
    expectError(() => ledger.issueGrant(forgedCheap), 'untrusted_attestation');

    // 对照组：账本签发的真凭证可以正常发行，且绑定的金额是**账本值**（3980）
    const grant = ledger.issueGrant(real);
    expect(grant.amount).toBe(confirm.amount);
    expect(grant.amount).toBe(3980);
    expect(ledger.counts().grants).toBe(1);
  });

  it('凭证携带的绑定来自账本：未声明的字段也照样绑定账本值', () => {
    const { ledger, confirm } = setupFixture();
    const attestation = ledger.attest(confirm.taskId, confirm.actionId, {
      surface: 'native.confirm',
      claim: { amount: 3980 },
    });
    expect(attestation.binding.amount).toBe(3980);
    expect(attestation.binding.paramsDigest).toBe(confirm.paramsDigest);
    expect(attestation.binding.quoteRef).toBe(confirm.quoteRef);
    expect(attestation.binding.accountRef).toBe(confirm.accountRef);
    expect(Object.isFrozen(attestation)).toBe(true);

    // 声明与账本不符时，连凭证都签不出来
    expectError(
      () => ledger.attest(confirm.taskId, confirm.actionId, { surface: 'native.confirm', claim: { amount: 1 } }),
      'confirm_digest_mismatch',
      'amount',
    );
  });

  it('撤权 / 过期之后不得再签发凭证（不得再靠"再确认一次"绕过）', () => {
    const revoked = setupFixture();
    revoked.ledger.revoke(revoked.confirm.taskId, revoked.confirm.actionId, '用户撤权');
    expectError(
      () => revoked.ledger.attest(revoked.confirm.taskId, revoked.confirm.actionId, { surface: 'native.confirm' }),
      'grant_revoked',
    );

    const expired = setupFixture();
    expired.clock.advance(120_000);
    expectError(
      () => expired.ledger.attest(expired.confirm.taskId, expired.confirm.actionId, { surface: 'native.confirm' }),
      'confirm_expired',
      'expiresAt',
    );
  });
});

describe('可信确认根 ③：关键条件变化即失效', () => {
  it('账本改写后旧凭证作废，须按账本最新内容重新确认', () => {
    const { ledger, confirm } = setupFixture();
    const staleAttestation = ledger.attest(confirm.taskId, confirm.actionId, { surface: 'native.confirm' });

    ledger.amendConfirmAction(confirm.taskId, confirm.actionId, { ...confirm, amount: 4500 });
    expectError(() => ledger.issueGrant(staleAttestation), 'attestation_binding_mismatch', 'amount');

    const fresh = ledger.attest(confirm.taskId, confirm.actionId, { surface: 'native.confirm' });
    expect(fresh.binding.amount).toBe(4500);
    expect(ledger.issueGrant(fresh).amount).toBe(4500);

    // 已被撤权的动作不得改写
    const other = setupFixture();
    other.ledger.revoke(other.confirm.taskId, other.confirm.actionId, '撤权');
    expectError(
      () =>
        other.ledger.amendConfirmAction(other.confirm.taskId, other.confirm.actionId, {
          ...other.confirm,
          amount: 1,
        }),
      'grant_revoked',
    );
  });

  it('绑定字段清单是机器可枚举的：九项（含 taskId）+ 期限', () => {
    expect(BINDING_FIELDS).toEqual([
      'taskId',
      'actionId',
      'accountRef',
      'taskRevision',
      'paramsDigest',
      'quoteRef',
      'amount',
      'currency',
      'scope',
    ]);
    const { grant } = issuedGrant(setupFixture());
    expect(Object.keys(grant)).toEqual(
      expect.arrayContaining([...BINDING_FIELDS, 'grantId', 'expiresAt', 'issuedAt', 'grantedBy']),
    );
  });
});

describe('与 contracts/mobile-v1 的对齐（本包开发期间该契约已由总协调交付）', () => {
  it('八态词表与契约 vocab/status.json 逐字同序', () => {
    expect(SUBMISSION_STATES).toEqual([
      'prepared',
      'authorized',
      'submitting',
      'submitted',
      'unknown',
      'confirmed',
      'failed',
      'cancelled',
    ]);
  });

  it('scope 取值域取自契约 enum（不自由发挥）', () => {
    expect(CONFIRM_SCOPES).toEqual(['purchase', 'payment', 'submit-order', 'write-file', 'external-mutation']);
    for (const scope of CONFIRM_SCOPES) {
      const { ledger } = setupFixture();
      expect(() => ledger.recordConfirmAction(baseConfirm({ actionId: `ok-${scope}`, scope }))).not.toThrow();
    }
    const { ledger } = setupFixture();
    expectError(
      () => ledger.recordConfirmAction(baseConfirm({ actionId: 'bad-scope', scope: 'meituan.order.create' as never })),
      'invalid_confirm_action',
      'scope',
    );
  });

  it('grant.consumed 恒等于 consumedAt !== null（契约 $defs.grant 的必需布尔）', () => {
    const fixture = setupFixture();
    const { ledger, confirm } = fixture;
    const { grant } = issuedGrant(fixture);
    expect(grant.consumed).toBe(false);
    expect(grant.consumedAt).toBeNull();

    ledger.consume({ grantId: grant.grantId, actual: binding() });
    const after = ledger.getGrant(grant.grantId)!;
    expect(after.consumed).toBe(true);
    expect(after.consumedAt).toBe(T0);
  });

  it('fixture 模式的回执不得报 confirmed（假端口不得冒充真实完成）', () => {
    // 负例：fixture + confirmed ⇒ 直接拒
    expectError(
      () =>
        createTrustedReceipt({
          actionId: 'act-1',
          provider: 'fixture-provider',
          requestRef: 'req-1',
          externalId: 'fixture-1',
          observedState: 'confirmed',
          observedAt: T0,
          evidenceRef: 'evidence://fixture/1',
          verificationMode: 'fixture',
        }),
      'fixture_receipt_cannot_confirm',
    );

    // 对照：fixture 可以如实回报 unknown（夹具允许，但不冒充完成）
    const unknownReceipt = createTrustedReceipt({
      actionId: 'act-1',
      provider: 'fixture-provider',
      requestRef: 'req-1',
      externalId: 'fixture-1',
      observedState: 'unknown',
      observedAt: T0,
      evidenceRef: 'evidence://fixture/1',
      verificationMode: 'fixture',
    });
    expect(unknownReceipt.observedState).toBe('unknown');

    // 对照：real 模式可以报 confirmed
    const realReceipt = createTrustedReceipt({
      actionId: 'act-1',
      provider: 'meituan',
      requestRef: 'req-1',
      externalId: 'MT-1',
      observedState: 'confirmed',
      observedAt: T0,
      evidenceRef: 'evidence://meituan/MT-1',
      verificationMode: 'real',
    });
    expect(realReceipt.observedState).toBe('confirmed');

    // verificationMode 缺失 / 非法一律拒（契约要求必需）
    expectError(
      () =>
        createTrustedReceipt({
          actionId: 'act-1',
          provider: 'meituan',
          requestRef: 'req-1',
          externalId: 'MT-1',
          observedState: 'confirmed',
          observedAt: T0,
          evidenceRef: 'evidence://meituan/MT-1',
        } as never),
      'untrusted_receipt',
    );
  });
});

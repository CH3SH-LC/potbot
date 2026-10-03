/**
 * M-I24 —— 端到端「APK/日志无明文」一致性扫描（模块层）。
 *
 * 覆盖成功 / 明文形 keyRef / 非官方端点 / 协议错误四条结果路径：结果对象、证据、
 * 端口记录里都不得出现任何疑似密钥明文；再核对两个包的边界常量与凭证库审计。
 */

import { describe, expect, it } from 'vitest';

import {
  CREDENTIAL_BOUNDARY,
  CREDENTIAL_ISOLATION_PACKAGE,
} from '../../../src/mobile-plugins/meituan/credential-isolation/index.js';
import {
  containsLikelySecret,
  MOBILE_TRANSPORT_BOUNDARY,
  textResponse,
} from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';

import {
  buildStack,
  collectStrings,
  descriptor,
  expectDelivered,
  expectFailure,
  makeVault,
  openStackSession,
  SECRET_SHAPED,
  SYNTHETIC_MATERIAL,
  SYNTHETIC_TOKEN,
  T0,
  UNAUTHORIZED_HOST,
} from './support.js';

const SYNTHETIC_SECRETS = [SECRET_SHAPED, SYNTHETIC_MATERIAL, SYNTHETIC_TOKEN] as const;

/** 断言任意值（字符串 / 对象图）里都不含任何合成密钥明文。 */
function expectNoPlaintext(value: unknown, label: string): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of SYNTHETIC_SECRETS) {
    expect(text, `${label} 不应含疑似密钥明文`).not.toContain(secret);
  }
}

describe('M-I24 端到端无明文一致性', () => {
  it('成功路径：结果 / 证据 / 端口记录均无明文', async () => {
    const stack = buildStack();
    await openStackSession(stack);
    const outcome = expectDelivered(await stack.client.invoke(descriptor(), T0 + 1));

    expectNoPlaintext(outcome, '成功结果');
    expectNoPlaintext(collectStrings(outcome).join('|'), '成功结果字符串集');
    expectNoPlaintext(stack.transport.dump(), '端口记录');
    expect(containsLikelySecret(outcome.evidence)).toBe(false);
    expect(outcome.evidence.plaintextSecretFields).toBe(0);
  });

  it('明文形 keyRef：结果 / 证据无明文（且原值不回显）', async () => {
    const stack = buildStack();
    await openStackSession(stack);
    const outcome = expectFailure(
      await stack.client.invoke(descriptor({ keyRef: SECRET_SHAPED }), T0 + 1),
    );

    expect(outcome.failureKind).toBe('credential_missing');
    expectNoPlaintext(outcome, '拒绝结果');
    expectNoPlaintext(collectStrings(outcome.evidence).join('|'), '拒绝证据');
  });

  it('非官方端点：结果 / 证据无明文', async () => {
    const stack = buildStack();
    await openStackSession(stack);
    const outcome = expectFailure(
      await stack.client.invoke(descriptor({ host: UNAUTHORIZED_HOST }), T0 + 1),
    );

    expect(outcome.failureKind).toBe('endpoint_not_allowed');
    expectNoPlaintext(outcome, '端点拒绝结果');
    expectNoPlaintext(stack.transport.dump(), '端点拒绝端口记录');
  });

  it('协议错误（非 JSON）：结果 / 证据无明文，且不判业务成功', async () => {
    const stack = buildStack({ steps: [textResponse(200, '{not-json')] });
    await openStackSession(stack);
    const outcome = expectFailure(await stack.client.invoke(descriptor(), T0 + 1));

    expect(outcome.failureKind).toBe('protocol_error');
    expect(outcome.protocolErrorKind).toBe('malformed_json');
    expect(outcome.delivered).toBe(false);
    expectNoPlaintext(outcome, '协议错误结果');
    expectNoPlaintext(stack.transport.dump(), '协议错误端口记录');
  });

  it('凭证库审计日志只含引用与判定，无明文', () => {
    const vault = makeVault();
    vault.authorize({
      keyRef: SECRET_SHAPED,
      accountRef: 'acct:meituan:user-a',
      provider: 'meituan',
      requiredScope: 'meituan.catalog.read',
      now: T0 + 1,
    });
    expectNoPlaintext(collectStrings(vault.auditLog()).join('|'), '凭证库审计');
    // 占位符照实可见（证明审计在写，只是不写明文）。
    expect(vault.auditLog().some((entry) => entry.keyRef === '<invalid-key-ref>')).toBe(true);
  });

  it('两个包的边界常量一致声明：无真实网络 / 无明文入口 / 未接密钥库 / fixture 模式', () => {
    expect(MOBILE_TRANSPORT_BOUNDARY.hasRealNetworkCall).toBe(false);
    expect(MOBILE_TRANSPORT_BOUNDARY.acceptsPlaintextDescriptorSecrets).toBe(false);
    expect(MOBILE_TRANSPORT_BOUNDARY.connectsRealPlatform).toBe(false);
    expect(MOBILE_TRANSPORT_BOUNDARY.verificationMode).toBe('fixture');

    expect(CREDENTIAL_BOUNDARY.acceptsPlaintextSecret).toBe(false);
    expect(CREDENTIAL_BOUNDARY.hasRealNetworkCall).toBe(false);
    expect(CREDENTIAL_BOUNDARY.connectsRealKeystore).toBe(false);
    expect(CREDENTIAL_BOUNDARY.verificationMode).toBe('fixture');

    expect(CREDENTIAL_ISOLATION_PACKAGE.promotedFromM_R05).toBe(true);
    expect(CREDENTIAL_ISOLATION_PACKAGE.acceptsPlaintextSecret).toBe(false);
  });
});

/**
 * M-I24 / 断言 (b)：明文形 keyRef 被拒且**零回显**。
 *
 * 两条路径都要挡：
 *  1. 传输层第 1 步就按形状拒绝（在解析凭证 / 端口调用之前），keyRef 用占位符；
 *  2. 若有人绕过传输层直接调桥接解析端口，凭证库 `authorize` 也判 `invalid_key_ref`，
 *     审计只记占位符，绝不落明文。
 */

import { describe, expect, it } from 'vitest';

import { CredentialError } from '../../../src/mobile-plugins/meituan/credential-isolation/index.js';

import {
  buildStack,
  collectStrings,
  descriptor,
  expectFailure,
  openStackSession,
  SECRET_SHAPED,
  SYNTHETIC_MATERIAL,
  T0,
} from './support.js';

describe('M-I24 明文形 keyRef 被拒且不回显', () => {
  it('传输层收到明文形 keyRef => credential_missing，端口与凭证解析均未被调用', async () => {
    const stack = buildStack();
    await openStackSession(stack);

    const outcome = expectFailure(
      await stack.client.invoke(descriptor({ keyRef: SECRET_SHAPED }), T0 + 1),
    );

    expect(outcome.failureKind).toBe('credential_missing');
    // 在解析凭证 / 端口调用之前就拒绝。
    expect(stack.resolver.resolveCount()).toBe(0);
    expect(stack.transport.callCount()).toBe(0);
    // 结果、证据都不回显原值。
    expect(outcome.keyRef).not.toBe(SECRET_SHAPED);
    expect(outcome.keyRef).not.toContain('sk-live');
    expect(JSON.stringify(outcome)).not.toContain(SECRET_SHAPED);
    expect(collectStrings(outcome.evidence)).not.toContain(SECRET_SHAPED);
    expect(outcome.network.transport).toBe('not_sent');
  });

  it('绕过传输层直接调桥接：凭证库判 invalid_key_ref，审计只记占位符', async () => {
    const stack = buildStack();

    let caught: unknown;
    try {
      await stack.resolver.resolve(SECRET_SHAPED);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CredentialError);
    expect((caught as Error).message).not.toContain(SECRET_SHAPED);
    expect((caught as CredentialError).code).toBe('credential_not_authorized');
    expect(stack.resolver.lastDenyReason()).toBe('invalid_key_ref');
    expect(stack.resolver.resolveCount()).toBe(1);
    expect(stack.resolver.denyCount()).toBe(1);

    // 审计里没有任何明文字符串；非法输入落的是占位符。
    const auditStrings = collectStrings(stack.vault.auditLog());
    expect(auditStrings).not.toContain(SECRET_SHAPED);
    expect(stack.vault.auditLog().some((entry) => entry.keyRef === '<invalid-key-ref>')).toBe(true);
  });

  it('合法 keyRef 才会被解析（对照，证明上面的拒绝非空转）', async () => {
    const stack = buildStack();
    const credential = await stack.resolver.resolve('keyref:mt:user-a:cred-1');
    expect(credential.keyRef).toBe('keyref:mt:user-a:cred-1');
    expect(credential.material).toBe(SYNTHETIC_MATERIAL);
  });
});

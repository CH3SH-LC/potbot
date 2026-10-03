/**
 * M02 ①：keyRef 形状 + 官方 host 白名单。
 *
 * 重点把两类"看起来没问题"的写法钉死：
 * - 后缀匹配绕过（`evil-api.example.com` 以 `api.example.com` 结尾）；
 * - 空 allowlist 被当成"全放行"。
 * 以及"非授权 host 时**零网络调用**、凭证不流出"这一条。
 */

import { describe, expect, it } from 'vitest';

import {
  EndpointNotAllowedError,
  assertKeyRef,
  createEndpointPolicy,
  isKeyRef,
  MOBILE_TRANSPORT_BOUNDARY,
} from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';

import {
  OFFICIAL_HOST,
  SUFFIX_ATTACK_HOST,
  TEST_ACCOUNT_REF,
  TEST_KEY_REF,
  UNAUTHORIZED_HOST,
  buildClient,
  createFakeTransport,
  jsonResponse,
} from './support.js';

describe('M02 keyRef 形状', () => {
  it('合法 keyRef 通过', () => {
    expect(isKeyRef(TEST_KEY_REF)).toBe(true);
    expect(assertKeyRef(TEST_KEY_REF)).toBe(TEST_KEY_REF);
  });

  it('明文密钥形状（sk-...）被拒，且拒绝消息不回显原值', () => {
    const plaintext = 'sk-0123456789abcdefABCDEF';
    expect(isKeyRef(plaintext)).toBe(false);
    let caught: unknown;
    try {
      assertKeyRef(plaintext);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).not.toContain(plaintext);
  });

  it('缺前缀 / 非法字符被拒', () => {
    expect(isKeyRef('meituan-demo-primary')).toBe(false);
    expect(isKeyRef('keyref:has space')).toBe(false);
    expect(isKeyRef('')).toBe(false);
    expect(isKeyRef(undefined)).toBe(false);
  });
});

describe('M02 官方 host 白名单', () => {
  it('精确匹配放行；后缀伪装不放行', () => {
    const policy = createEndpointPolicy([OFFICIAL_HOST]);
    expect(policy.isAllowed(OFFICIAL_HOST)).toBe(true);
    expect(policy.isAllowed(OFFICIAL_HOST.toUpperCase())).toBe(true);
    expect(policy.isAllowed(SUFFIX_ATTACK_HOST)).toBe(false);
    expect(policy.isAllowed(UNAUTHORIZED_HOST)).toBe(false);
    expect(policy.isAllowed('')).toBe(false);
  });

  it('空 allowlist 构建即抛错（杜绝"空 = 全放行"）', () => {
    expect(() => createEndpointPolicy([])).toThrow(TypeError);
    expect(() => createEndpointPolicy(['', '  '])).toThrow(TypeError);
  });

  it('重复 / 大小写混写的项去重', () => {
    const policy = createEndpointPolicy([OFFICIAL_HOST, OFFICIAL_HOST.toUpperCase(), OFFICIAL_HOST]);
    expect(policy.allowedHosts).toHaveLength(1);
  });
});

describe('M02 非授权 host：发出前拒绝，零网络调用', () => {
  it('后缀伪装 host ⇒ endpoint_not_allowed 且 transport 未被调用、凭证未被解析', async () => {
    const transport = createFakeTransport([]);
    const { client, resolver } = buildClient({ transport });
    const outcome = await client.invoke(
      { keyRef: TEST_KEY_REF, method: 'POST', host: SUFFIX_ATTACK_HOST, path: '/v1/x', body: {} },
      1_700_000_000_000,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.failureKind).toBe('endpoint_not_allowed');
    expect(transport.callCount()).toBe(0);
    expect(resolver.resolveCount()).toBe(0);
  });

  it('官方 host 会正常发出（对照组）', async () => {
    const transport = createFakeTransport([jsonResponse(200, { code: 'ok' })]);
    const { client, session } = buildClient({ transport });
    await session.open({
      keyRef: TEST_KEY_REF,
      accountRef: TEST_ACCOUNT_REF,
      credential: { keyRef: TEST_KEY_REF, material: 'test-material' },
      now: 1_700_000_000_000,
    });
    const outcome = await client.invoke(
      { keyRef: TEST_KEY_REF, method: 'POST', host: OFFICIAL_HOST, path: '/v1/x', body: {} },
      1_700_000_000_000,
    );
    expect(transport.callCount()).toBe(1);
    expect(outcome.ok).toBe(true);
  });
});

describe('M02 结构边界声明', () => {
  it('边界常量自证未接通真实平台、未内置官方 host / 码表', () => {
    expect(MOBILE_TRANSPORT_BOUNDARY.hasRealNetworkCall).toBe(false);
    expect(MOBILE_TRANSPORT_BOUNDARY.hardcodesOfficialHosts).toBe(false);
    expect(MOBILE_TRANSPORT_BOUNDARY.hardcodesBusinessCodes).toBe(false);
    expect(MOBILE_TRANSPORT_BOUNDARY.connectsRealPlatform).toBe(false);
    expect(MOBILE_TRANSPORT_BOUNDARY.verificationMode).toBe('fixture');
  });

  it('EndpointNotAllowedError 消息含 host 但不含秘密', () => {
    const err = new EndpointNotAllowedError(UNAUTHORIZED_HOST, [OFFICIAL_HOST]);
    expect(err.code).toBe('endpoint_not_allowed');
    expect(err.message).toContain(UNAUTHORIZED_HOST);
  });
});

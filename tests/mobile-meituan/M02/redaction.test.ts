/**
 * M02 ④：脱敏与"证据 / 记录无明文"。
 *
 * 断言：证据条目与假端口的调用记录里都**没有**令牌或密钥明文；形似密钥的片段
 * 会被扫描器抓出并让 `assertEvidenceClean` 抛错。引用（`keyref:` / `sessref:`）
 * 本身不是秘密，不被误报。
 */

import { describe, expect, it } from 'vitest';

import {
  assertEvidenceClean,
  buildEvidence,
  containsLikelySecret,
} from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';

import {
  OFFICIAL_HOST,
  TEST_ACCOUNT_REF,
  TEST_KEY_REF,
  T0,
  buildClient,
  createFakeTransport,
  jsonResponse,
} from './support.js';

describe('M02 密钥形状扫描', () => {
  it('抓出 sk- / Bearer / JWT / 长十六进制', () => {
    expect(containsLikelySecret('sk-0123456789abcdef')).toBe(true);
    expect(containsLikelySecret('Authorization: Bearer abcdef0123456789')).toBe(true);
    expect(containsLikelySecret('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc')).toBe(true);
    expect(containsLikelySecret('deadbeefdeadbeefdeadbeefdeadbeef')).toBe(true);
  });

  it('引用形状不被误报', () => {
    expect(containsLikelySecret(TEST_KEY_REF)).toBe(false);
    expect(containsLikelySecret('sessref:s1-t1')).toBe(false);
    expect(containsLikelySecret('acct:test-user')).toBe(false);
  });

  it('递归扫描对象与数组', () => {
    expect(containsLikelySecret({ nested: { list: ['safe', 'sk-aaaaaaaa'] } })).toBe(true);
    expect(containsLikelySecret({ nested: { list: ['safe'] } })).toBe(false);
  });
});

describe('M02 证据条目', () => {
  it('buildEvidence 结构上无秘密落点', () => {
    const evidence = buildEvidence({
      host: OFFICIAL_HOST,
      path: '/v1/x',
      method: 'POST',
      keyRef: TEST_KEY_REF,
      tokenRef: 'sessref:s1-t1',
      status: 200,
      outcome: 'business:success',
      at: T0,
    });
    expect(evidence.redacted).toBe(true);
    expect(evidence.plaintextSecretFields).toBe(0);
    expect(Object.keys(evidence)).not.toContain('authorization');
    expect(Object.keys(evidence)).not.toContain('body');
    expect(assertEvidenceClean(evidence)).toBeUndefined();
  });

  it('assertEvidenceClean 对混入明文的证据抛错', () => {
    expect(() => assertEvidenceClean({ note: 'Bearer sk-0123456789abcdef' })).toThrow();
    expect(() => assertEvidenceClean({ note: 'keyref:ok', tokenRef: 'sessref:s1-t1' })).not.toThrow();
  });
});

describe('M02 假端口记录不含头值', () => {
  it('调用记录里有"带 Authorization"的事实，但 dump 里没有令牌明文', async () => {
    const transport = createFakeTransport([jsonResponse(200, { code: 'ok' })]);
    const { client, session } = buildClient({ transport });
    await session.open({
      keyRef: TEST_KEY_REF,
      accountRef: TEST_ACCOUNT_REF,
      credential: { keyRef: TEST_KEY_REF, material: 'test-material' },
      now: T0,
    });
    await client.invoke(
      { keyRef: TEST_KEY_REF, method: 'POST', host: OFFICIAL_HOST, path: '/v1/x', body: { q: 1 } },
      T0,
    );
    const dump = transport.dump();
    expect(dump).not.toContain('fake-token');
    expect(dump).not.toContain('Bearer');
    expect(dump).not.toContain('test-material');
    expect(transport.calls[0]?.hasAuthorization).toBe(true);
    expect(transport.calls[0]?.authScheme).toBe('bearer');
  });
});

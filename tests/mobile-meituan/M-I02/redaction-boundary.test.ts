/**
 * M-I02 ③：令牌只在 Authorization 头出现 + 脱敏绝不回显命中材料。
 *
 * 直觉陷阱：把令牌顺手写进 reason / 证据 / 调用记录。本文件用**捕获式端口**拿到
 * **完整**原始请求，逐字段确认令牌**只**出现在 `Authorization` 头：
 * host / path / bodyJson / 其他头值都不含它；结果对象与证据序列化后也不含它。
 *
 * 另半部分是脱敏反向证明：扫描器确实能命中合成令牌（不是空转），命中时
 * `assertEvidenceClean` 抛错且**错误消息不回显**该令牌。
 */

import { describe, expect, it } from 'vitest';

import {
  assertEvidenceClean,
  containsLikelySecret,
} from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';
import type { TransportOutcome } from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';

import {
  SYNTHETIC_TOKEN,
  T0,
  buildClient,
  createCapturingTransport,
  descriptor,
  jsonStep,
  openSession,
  textStep,
} from './support.js';

function headerNamesContaining(headers: Readonly<Record<string, string>>, needle: string): readonly string[] {
  return Object.entries(headers)
    .filter(([, value]) => value.includes(needle))
    .map(([name]) => name);
}

describe('M-I02 Authorization 是令牌唯一允许出现的边界', () => {
  it('成功调用：令牌只在 Authorization 头，host/path/body/其他头/结果均无', async () => {
    const transport = createCapturingTransport([jsonStep(200, { code: 'ok', data: { id: 'x' } })]);
    const { client, session } = buildClient({ transport });
    await openSession(session);

    const outcome = await client.invoke(descriptor({ path: '/v1/order/read', body: { q: 1 } }), T0);
    expect(outcome.ok).toBe(true);

    const request = transport.requests[0];
    expect(request).toBeDefined();
    if (request === undefined) {
      return;
    }
    // 唯一允许的位置：Authorization 头，Bearer 方案。
    expect(request.headers['Authorization']).toBe(`Bearer ${SYNTHETIC_TOKEN}`);
    expect(headerNamesContaining(request.headers, SYNTHETIC_TOKEN)).toEqual(['Authorization']);
    // 其他落点都不含令牌。
    expect(request.host.includes(SYNTHETIC_TOKEN)).toBe(false);
    expect(request.path.includes(SYNTHETIC_TOKEN)).toBe(false);
    expect((request.bodyJson ?? '').includes(SYNTHETIC_TOKEN)).toBe(false);
    expect(request.timeoutMs).toBe(10_000);
    // 结果 / 证据序列化后也不含令牌。
    expect(JSON.stringify(outcome)).not.toContain(SYNTHETIC_TOKEN);
    expect(JSON.stringify(outcome.evidence)).not.toContain(SYNTHETIC_TOKEN);
    expect(assertEvidenceClean(outcome.evidence)).toBeUndefined();
  });

  it('失败路径（网络故障 / HTTP 错误 / 协议错误 / 401）也不含令牌', async () => {
    const plans = [
      [{ kind: 'fault', fault: 'network_error', phase: 'during_send' }],
      [{ kind: 'fault', fault: 'network_error', phase: 'before_send' }],
      [textStep(500, 'boom')],
      [textStep(200, '<html>not json</html>')],
      [textStep(401, ''), textStep(401, '')],
    ] as const;

    for (const plan of plans) {
      const transport = createCapturingTransport([...plan]);
      const { client, session } = buildClient({ transport });
      await openSession(session);
      const outcome: TransportOutcome = await client.invoke(descriptor(), T0);
      expect(JSON.stringify(outcome)).not.toContain(SYNTHETIC_TOKEN);
      if (!outcome.ok) {
        expect(outcome.reason).not.toContain(SYNTHETIC_TOKEN);
      }
      expect(JSON.stringify(outcome.evidence)).not.toContain(SYNTHETIC_TOKEN);
    }
  });

  it('服务端返回体里的密钥形状片段不进入证据（只留在业务 data）', async () => {
    const serverSecret = 'sk-ffffffffffffffffffffffffffffffff';
    const transport = createCapturingTransport([jsonStep(200, { code: 'ok', message: 'ok', data: { note: serverSecret } })]);
    const { client, session } = buildClient({ transport });
    await openSession(session);

    const outcome = await client.invoke(descriptor(), T0);
    expect(outcome.ok).toBe(true);
    // 证据（会进日志 / 账本）里不得出现服务端返回的密钥形状片段。
    expect(JSON.stringify(outcome.evidence)).not.toContain(serverSecret);
    expect(assertEvidenceClean(outcome.evidence)).toBeUndefined();
  });
});

describe('M-I02 脱敏绝不回显命中材料', () => {
  it('扫描器确实能命中合成令牌（不是空转）', () => {
    expect(containsLikelySecret(SYNTHETIC_TOKEN)).toBe(true);
    expect(containsLikelySecret(`Bearer ${SYNTHETIC_TOKEN}`)).toBe(true);
  });

  it('命中时抛错，且错误消息不回显该令牌', () => {
    let caught: unknown;
    try {
      assertEvidenceClean({ leaked: SYNTHETIC_TOKEN });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(SYNTHETIC_TOKEN);
    expect((caught as Error).message).toContain('脱敏');
  });

  it('引用形状（keyref:/sessref:/acct:）不被误报', () => {
    expect(() =>
      assertEvidenceClean({ keyRef: 'keyref:meituan-demo-primary', tokenRef: 'sessref:mi02-t1', accountRef: 'acct:test-user' }),
    ).not.toThrow();
  });
});

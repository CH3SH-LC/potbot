/**
 * M-I24 / 断言 (a)：端口只记录请求头的**形状**（是否有 Authorization / 方案），
 * **从不记录值**；材质 / 令牌不会落进端口记录、结果或证据。
 *
 * 「APK/日志无明文」在工作书里的落点之一就是：假传输端口（真机为原生端口）提供的
 * 调用记录里字段集合固定、无值字段。
 */

import { describe, expect, it } from 'vitest';

import {
  containsLikelySecret,
  type RawTransportResponse,
} from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';

import {
  buildStack,
  descriptor,
  expectDelivered,
  KEY_A,
  OFFICIAL_HOST,
  openStackSession,
  plainResponse,
  SYNTHETIC_MATERIAL,
  SYNTHETIC_TOKEN,
  T0,
} from './support.js';

describe('M-I24 端口只记形状、不记值', () => {
  it('成功调用：端口记录是形状布尔，不是令牌值', async () => {
    const stack = buildStack();
    await openStackSession(stack);
    const outcome = expectDelivered(await stack.client.invoke(descriptor(), T0 + 1));

    expect(stack.transport.callCount()).toBe(1);
    const call = stack.transport.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) {
      throw new Error('端口未记录调用');
    }
    expect(call.hasAuthorization).toBe(true);
    expect(call.authScheme).toBe('bearer');
    // 结构上没有可放令牌值的字段：键集合固定。
    expect(Object.keys(call).sort()).toEqual(
      ['authScheme', 'bodyJson', 'hasAuthorization', 'host', 'method', 'path', 'timeoutMs'].sort(),
    );
    // 值（令牌 / 材质）不出现在记录里。
    expect(stack.transport.dump()).not.toContain(SYNTHETIC_TOKEN);
    expect(stack.transport.dump()).not.toContain(SYNTHETIC_MATERIAL);
    expect(stack.transport.dump()).not.toContain('Bearer ');
    expect(JSON.stringify(outcome)).not.toContain(SYNTHETIC_TOKEN);
    expect(JSON.stringify(outcome)).not.toContain(SYNTHETIC_MATERIAL);
  });

  it('令牌确实到达端口边界（仅在 Authorization 头），材质止于铸造；两者都不落记录', async () => {
    let sawBearer = false;
    let headerHadToken = false;
    let headerHadMaterial = false;
    const stack = buildStack({
      steps: [
        {
          kind: 'handler',
          handle: (request): RawTransportResponse => {
            const auth = request.headers['Authorization'];
            sawBearer = typeof auth === 'string' && auth.startsWith('Bearer ');
            headerHadToken = typeof auth === 'string' && auth.includes(SYNTHETIC_TOKEN);
            headerHadMaterial = typeof auth === 'string' && auth.includes(SYNTHETIC_MATERIAL);
            return plainResponse(200, { code: 'ok', data: null });
          },
        },
      ],
    });
    await openStackSession(stack);
    const outcome = expectDelivered(await stack.client.invoke(descriptor(), T0 + 1));

    // 边界事实：会话令牌只在该头出现（真机原生端口在此取令牌）。
    expect(sawBearer).toBe(true);
    expect(headerHadToken).toBe(true);
    // 材质停在 mint 入参，不上线到端口头。
    expect(headerHadMaterial).toBe(false);

    // 端口留下的记录、结果、证据里都没有令牌与材质。
    expect(stack.transport.dump()).not.toContain(SYNTHETIC_TOKEN);
    expect(stack.transport.dump()).not.toContain(SYNTHETIC_MATERIAL);
    expect(JSON.stringify(outcome)).not.toContain(SYNTHETIC_TOKEN);
    expect(JSON.stringify(outcome)).not.toContain(SYNTHETIC_MATERIAL);
    expect(containsLikelySecret(outcome.evidence)).toBe(false);
    expect(outcome.evidence.plaintextSecretFields).toBe(0);
  });

  it('证据只含引用：keyRef / tokenRef 为引用形状，脱敏标记为真', async () => {
    const stack = buildStack();
    await openStackSession(stack);
    const outcome = expectDelivered(await stack.client.invoke(descriptor(), T0 + 1));

    expect(outcome.evidence.keyRef).toBe(KEY_A);
    expect(outcome.evidence.host).toBe(OFFICIAL_HOST);
    expect(outcome.evidence.tokenRef?.startsWith('sessref:')).toBe(true);
    expect(outcome.evidence.redacted).toBe(true);
    expect(outcome.evidence.plaintextSecretFields).toBe(0);
    expect(containsLikelySecret(outcome.evidence)).toBe(false);
  });

  it('扫描器非空转：合成的令牌 / 材质形态确实会被密钥扫描命中', () => {
    expect(containsLikelySecret(SYNTHETIC_TOKEN)).toBe(true);
    expect(containsLikelySecret(SYNTHETIC_MATERIAL)).toBe(true);
  });
});

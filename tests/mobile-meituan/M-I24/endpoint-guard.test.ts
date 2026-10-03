/**
 * M-I24 / 断言 (e)：非官方端点在任何端口调用之前被拒——`port.callCount()===0`，
 * 且**凭证解析也未被触发**（`resolver.resolveCount()===0`），即凭证绝不会流到非授权 host。
 *
 * 白名单为精确匹配（不做后缀 / 通配），子域伪装不以官方 host 结尾而放行。
 */

import { describe, expect, it } from 'vitest';

import { createEndpointPolicy } from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';

import {
  buildStack,
  descriptor,
  expectDelivered,
  expectFailure,
  OFFICIAL_HOST,
  officialPolicy,
  openStackSession,
  SUFFIX_ATTACK_HOST,
  T0,
  UNAUTHORIZED_HOST,
} from './support.js';

describe('M-I24 非官方端点发出前拒绝（零端口调用）', () => {
  it('非授权 host => endpoint_not_allowed，端口与凭证解析皆零调用', async () => {
    const stack = buildStack();
    await openStackSession(stack);

    const outcome = expectFailure(
      await stack.client.invoke(descriptor({ host: UNAUTHORIZED_HOST }), T0 + 1),
    );

    expect(outcome.failureKind).toBe('endpoint_not_allowed');
    expect(stack.transport.callCount()).toBe(0);
    // 关键：在解析凭证之前就拒绝，凭证不会流到非官方 host。
    expect(stack.resolver.resolveCount()).toBe(0);
    const network = outcome.network;
    expect(network.transport).toBe('not_sent');
    if (network.transport !== 'not_sent') {
      throw new Error('预期发出前失败（not_sent）');
    }
    expect(network.phase).toBe('before_send');
  });

  it('子域伪装（以官方 host 结尾）同样被拒，不做后缀匹配', async () => {
    const stack = buildStack();
    await openStackSession(stack);

    const outcome = expectFailure(
      await stack.client.invoke(descriptor({ host: SUFFIX_ATTACK_HOST }), T0 + 1),
    );

    expect(outcome.failureKind).toBe('endpoint_not_allowed');
    expect(stack.transport.callCount()).toBe(0);
    expect(stack.resolver.resolveCount()).toBe(0);
  });

  it('策略为精确匹配且非空：allowedHosts 只含官方 host；空列表构建即抛错', () => {
    const policy = officialPolicy();
    expect(policy.allowedHosts).toEqual([OFFICIAL_HOST]);
    expect(policy.isAllowed(OFFICIAL_HOST)).toBe(true);
    expect(policy.isAllowed(UNAUTHORIZED_HOST)).toBe(false);
    expect(policy.isAllowed(SUFFIX_ATTACK_HOST)).toBe(false);
    // 空 allowlist 不得退化成"全放行"。
    expect(() => createEndpointPolicy([])).toThrowError(TypeError);
  });

  it('对照：官方 host 通过守卫并送达（守卫并非一律拒绝）', async () => {
    const stack = buildStack();
    await openStackSession(stack);
    const outcome = expectDelivered(
      await stack.client.invoke(descriptor({ host: OFFICIAL_HOST }), T0 + 1),
    );
    expect(outcome.businessSuccess).toBe(true);
    expect(stack.transport.callCount()).toBe(1);
  });
});

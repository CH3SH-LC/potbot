/**
 * F09 验收：权限与连接（M07、I3）。
 *
 * 反向对照：
 *   - 撤权后 `statusOf` / `granted()` / `isCapabilityAllowed` **立即**改变；
 *   - 连接探测报 connected 但缺 network/model 权限或密钥不可用 ⇒ 立即降为 unauthorized；
 *   - 没有探测端口 ⇒ 只报 unknown，绝不假装已连接；
 *   - host 含 scheme/凭据 ⇒ 拒绝（防止把认证信息塞进 host）。
 */

import { describe, expect, it } from 'vitest';

import {
  createPermissionRegistry,
  deriveConnectionView,
  isValidHost,
  recoveryHint,
  testConnection,
  type ConnectionTester,
  type RawConnectionProbe,
} from '../../../apps/mobile-ui/src/settings/index.js';

const NOW = '2026-10-03T10:00:00Z';

describe('F09 / 权限注册表与实时撤权（I3）', () => {
  it('授权后可用，撤销后立即不可用', () => {
    const registry = createPermissionRegistry();
    registry.grant('network', NOW, '主对话网络');

    expect(registry.statusOf('network')).toBe('granted');
    expect(registry.granted()).toContain('network');
    expect(registry.isCapabilityAllowed('chat').allowed).toBe(true);

    registry.revoke('network', NOW);

    expect(registry.statusOf('network')).toBe('revoked');
    expect(registry.granted()).not.toContain('network');
    const decision = registry.isCapabilityAllowed('chat');
    expect(decision.allowed).toBe(false);
    expect(decision.missing).toEqual(['network']);
    expect(decision.hint).toContain('撤销');
  });

  it('能力需要多权限：model-call 需 network + model', () => {
    const registry = createPermissionRegistry();
    registry.grant('network', NOW);
    expect(registry.isCapabilityAllowed('model-call').allowed).toBe(false);
    expect(registry.isCapabilityAllowed('model-call').missing).toEqual(['model']);
    registry.grant('model', NOW);
    expect(registry.isCapabilityAllowed('model-call').allowed).toBe(true);
  });

  it('拒绝提供恢复入口文案', () => {
    const registry = createPermissionRegistry();
    registry.deny('device', NOW);
    const decision = registry.isCapabilityAllowed('device-info');
    expect(decision.allowed).toBe(false);
    expect(decision.hint).toContain('系统设置');
  });

  it('recoveryHint 区分系统级与应用内权限', () => {
    expect(recoveryHint('device', 'not-requested')).toContain('系统设置');
    expect(recoveryHint('storage', 'denied')).toContain('权限与连接');
  });

  it('未知权限抛错', () => {
    const registry = createPermissionRegistry();
    expect(() => registry.grant('telepathy' as never, NOW)).toThrowError(/未知权限/);
  });
});

describe('F09 / 连接视图（I3 / I6）', () => {
  const connectedProbe: RawConnectionProbe = {
    state: 'connected',
    host: 'api.deepseek.com',
    model: 'deepseek-flash',
    checkedAt: NOW,
    verificationMode: 'real',
    failure: null,
  };

  it('权限与密钥齐备 ⇒ 保持 connected', () => {
    const view = deriveConnectionView(connectedProbe, {
      grantedPermissions: ['network', 'model'],
      keyUsable: true,
    });
    expect(view.state).toBe('connected');
    expect(view.label).toContain('已连接');
  });

  it('反向对照：缺 model 权限 ⇒ 立即 unauthorized', () => {
    const view = deriveConnectionView(connectedProbe, {
      grantedPermissions: ['network'],
      keyUsable: true,
    });
    expect(view.state).toBe('unauthorized');
    expect(view.baseState).toBe('connected');
    expect(view.unauthorizedReasons.some((reason) => reason.includes('model'))).toBe(true);
    expect(view.failure?.message).toContain('model');
  });

  it('反向对照：密钥被撤销 ⇒ 立即 unauthorized', () => {
    const view = deriveConnectionView(connectedProbe, {
      grantedPermissions: ['network', 'model'],
      keyUsable: false,
    });
    expect(view.state).toBe('unauthorized');
    expect(view.unauthorizedReasons.some((reason) => reason.includes('密钥'))).toBe(true);
  });

  it('失败文案脱敏后才进视图（I6）', () => {
    const view = deriveConnectionView(
      {
        ...connectedProbe,
        state: 'disconnected',
        failure: { code: 'auth', message: 'Authorization: Bearer a1b2c3d4e5f6g7h8', retryable: false },
      },
      { grantedPermissions: ['network', 'model'], keyUsable: true },
    );
    expect(view.state).toBe('disconnected');
    expect(view.failure?.message).not.toContain('a1b2c3d4e5f6g7h8');
    expect(view.failure?.redactedCount).toBeGreaterThan(0);
  });

  it('反向对照：host 含 scheme/凭据被拒', () => {
    expect(isValidHost('api.deepseek.com')).toBe(true);
    expect(isValidHost('https://user:pass@api.deepseek.com')).toBe(false);
    expect(() =>
      deriveConnectionView({ ...connectedProbe, host: 'https://api.deepseek.com' }, { grantedPermissions: [], keyUsable: true }),
    ).toThrowError(/host/);
  });

  it('反向对照：没有探测端口只报 unknown，不编造连接', () => {
    const view = testConnection(null, { grantedPermissions: ['network', 'model'], keyUsable: true }, NOW);
    expect(view).not.toBeInstanceOf(Promise);
    if (!(view instanceof Promise)) {
      expect(view.state).toBe('unknown');
      expect(view.label).toContain('未知');
      expect(view.checkedAt).toBeNull();
    }
  });

  it('探测端口存在时按其结果推导（同步）', () => {
    const tester: ConnectionTester = { test: () => connectedProbe };
    const view = testConnection(tester, { grantedPermissions: ['network', 'model'], keyUsable: true }, NOW);
    expect(view).not.toBeInstanceOf(Promise);
    if (!(view instanceof Promise)) expect(view.state).toBe('connected');
  });
});

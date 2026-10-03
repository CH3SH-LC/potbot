/**
 * M05 定位授权状态机：四态与合法转移。
 *
 * 被拒是一个**可见终态**，不是静默回退；非法转移一律抛错（失败要看得见）。
 */

import { describe, expect, it } from 'vitest';

import {
  LOCATION_PERMISSION_STATES,
  LocationPermissionError,
  LocationPermissionMachine,
} from '../../../src/mobile-plugins/meituan/address-delivery/index.js';
import { createFixtureLocationPort } from './support.js';

describe('M05 定位授权：四态与请求', () => {
  it('初态为未授权，且被拒/未授权/撤销都不算已授权', () => {
    const machine = new LocationPermissionMachine();
    expect(machine.state).toBe('unauthorized');
    expect(machine.isAuthorized).toBe(false);
    expect(machine.isBlocked).toBe(true);
    expect(LOCATION_PERMISSION_STATES).toEqual(['unauthorized', 'authorized', 'denied', 'revoked']);
  });

  it('端口授权成功 ⇒ 已授权', async () => {
    const machine = new LocationPermissionMachine();
    const port = createFixtureLocationPort('granted');

    const state = await machine.request(port);

    expect(state).toBe('authorized');
    expect(machine.isAuthorized).toBe(true);
    expect(machine.isBlocked).toBe(false);
    expect(port.calls).toBe(1);
  });

  it('端口被拒 ⇒ 被拒（显式可见，不回退到别的状态）', async () => {
    const machine = new LocationPermissionMachine();
    const state = await machine.request(createFixtureLocationPort('denied'));
    expect(state).toBe('denied');
    expect(machine.isAuthorized).toBe(false);
    expect(machine.isBlocked).toBe(true);
  });

  it('被拒后仍可再次请求，脚本按序返回', async () => {
    const machine = new LocationPermissionMachine();
    const port = createFixtureLocationPort(['denied', 'granted']);

    expect(await machine.request(port)).toBe('denied');
    expect(await machine.request(port)).toBe('authorized');
    expect(port.calls).toBe(2);
  });

  it('已授权时再次请求 ⇒ 显式抛错（不静默成功）', async () => {
    const machine = new LocationPermissionMachine();
    await machine.request(createFixtureLocationPort('granted'));
    await expect(machine.request(createFixtureLocationPort('granted'))).rejects.toThrow(LocationPermissionError);
  });
});

describe('M05 定位授权：撤销与复位', () => {
  it('已授权 ⇒ 撤销 ⇒ revoked', async () => {
    const machine = new LocationPermissionMachine();
    await machine.request(createFixtureLocationPort('granted'));
    expect(machine.revoke()).toBe('revoked');
    expect(machine.isBlocked).toBe(true);
  });

  it('未授权就撤销 ⇒ 抛错', () => {
    const machine = new LocationPermissionMachine();
    expect(() => machine.revoke()).toThrow(LocationPermissionError);
  });

  it('被拒后撤销 ⇒ 抛错（只有已授权能撤销）', async () => {
    const machine = new LocationPermissionMachine();
    await machine.request(createFixtureLocationPort('denied'));
    expect(() => machine.revoke()).toThrow(LocationPermissionError);
  });

  it('撤销后可再次请求并恢复授权', async () => {
    const machine = new LocationPermissionMachine();
    await machine.request(createFixtureLocationPort('granted'));
    machine.revoke();
    expect(await machine.request(createFixtureLocationPort('granted'))).toBe('authorized');
  });

  it('reset 从任意态回到未授权', async () => {
    const machine = new LocationPermissionMachine();
    await machine.request(createFixtureLocationPort('granted'));
    expect(machine.reset()).toBe('unauthorized');
    machine.applyResult('denied');
    expect(machine.reset()).toBe('unauthorized');
  });

  it('非法初始态与非法结果都显式抛错', () => {
    expect(() => new LocationPermissionMachine('nope' as never)).toThrow(LocationPermissionError);
    const machine = new LocationPermissionMachine();
    expect(() => machine.applyResult('maybe' as never)).toThrow(LocationPermissionError);
  });
});

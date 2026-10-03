/**
 * M-I14 / 生产出口契约：证明「提升」的公开出口可用，且 schema 目录 ↔ 实现一致。
 *
 * M-R05 集成请求 #1 要求把源码提升到 `src/mobile-plugins/meituan/credential-isolation/`
 * 并注册公开出口。本用例只 import **生产出口** `index.js`。
 */

import { describe, expect, it } from 'vitest';

import * as prod from '../../../src/mobile-plugins/meituan/credential-isolation/index.js';

describe('M-I14 生产出口：核心 API 可见', () => {
  it('导出 vault / 错误类 / schema 目录 / 夹具，且边界常量如实冻结', () => {
    expect(typeof prod.CredentialVault).toBe('function');
    expect(typeof prod.CredentialError).toBe('function');
    expect(typeof prod.requiredFields).toBe('function');
    expect(typeof prod.makeScenario).toBe('function');
    expect(typeof prod.makeEmptyVault).toBe('function');

    expect(prod.CREDENTIAL_BOUNDARY.acceptsPlaintextSecret).toBe(false);
    expect(prod.CREDENTIAL_BOUNDARY.hasRealNetworkCall).toBe(false);
    expect(prod.CREDENTIAL_BOUNDARY.connectsRealKeystore).toBe(false);
    expect(prod.CREDENTIAL_BOUNDARY.verificationMode).toBe('fixture');

    expect(prod.CREDENTIAL_ISOLATION_PACKAGE.promotedFromM_R05).toBe(true);
    expect(prod.CREDENTIAL_ISOLATION_PACKAGE.embedsKeyShapedLiteral).toBe(false);
    expect(Object.isFrozen(prod.CREDENTIAL_ISOLATION_PACKAGE)).toBe(true);
  });

  it('生产出口不导出任何 sk- 形状的密钥常量', () => {
    for (const [name, value] of Object.entries(prod)) {
      if (typeof value !== 'string') {
        continue;
      }
      expect(/sk-[A-Za-z0-9_-]{10,}/.test(value), `导出 ${name} 是 sk- 形状`).toBe(false);
    }
  });
});

describe('M-I14 生产出口：schema 目录 ↔ 实现', () => {
  it('schema 声明的每个操作都在 CredentialVault 原型上真实存在', () => {
    const declared = Object.keys(prod.OPERATION_SCHEMAS).sort();
    expect(declared.length).toBe(8);
    const prototypeMethods = Object.entries(Object.getOwnPropertyDescriptors(prod.CredentialVault.prototype))
      .filter(([name, descriptor]) => name !== 'constructor' && typeof descriptor.value === 'function')
      .map(([name]) => name);
    for (const name of declared) {
      expect(prototypeMethods, `缺少实现 ${name}`).toContain(name);
    }
  });

  it('每个操作都声明了非空字段表、返回值与必填字段', () => {
    for (const [name, schema] of Object.entries(prod.OPERATION_SCHEMAS)) {
      expect(Object.keys(schema.fields).length, name).toBeGreaterThan(0);
      expect(schema.returns.length, name).toBeGreaterThan(0);
      expect(prod.requiredFields(name).length, name).toBeGreaterThan(0);
    }
  });
});

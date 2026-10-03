/**
 * M-R05 / 契约核对：`schemas.ts` 声明的操作必须与 `CredentialVault` 的实现一致。
 *
 * 两个方向都查：
 * 1. schema 声明的操作名，必须真实存在于 `CredentialVault.prototype`（不多不少）；
 * 2. 每个必填字段确实是"必填"——省掉它时，strict 操作抛错、total 操作给出否定 reason。
 * 3. object 形态的 strict 操作，注入未声明字段必须被拒（不是静默忽略）。
 */

import { describe, expect, it } from 'vitest';
import { CredentialError, CredentialVault } from './credential-isolation.js';
import { OPERATION_SCHEMAS, requiredFields, type OperationSchema } from './schemas.js';
import {
  ACCOUNT_A,
  ACTION_1,
  INSTALL_2,
  KEY_A,
  KEY_A_ROTATED,
  SCOPE_READ,
  SCOPE_SUBMIT,
  T0,
  TTL_MS,
  makeScenario,
} from './support.js';

interface Fixture {
  readonly vault: CredentialVault;
}

/** 该操作是否以"字段对象"为入参（才能测未知字段）。 */
const OBJECT_FORM: ReadonlySet<string> = new Set(['importCredential', 'registerPendingAction']);

/** 一次合法调用（返回 void 或结果对象；抛错表示实现拒绝）。 */
function invokeValid(operation: string, fx: Fixture): unknown {
  const { vault } = fx;
  switch (operation) {
    case 'importCredential':
      return vault.importCredential({
        keyRef: KEY_A_ROTATED,
        accountRef: ACCOUNT_A,
        provider: 'meituan',
        scopes: [SCOPE_READ],
        issuedAt: T0,
        expiresAt: T0 + TTL_MS,
      });
    case 'authorize':
      return vault.authorize({
        keyRef: KEY_A,
        accountRef: ACCOUNT_A,
        provider: 'meituan',
        requiredScope: SCOPE_READ,
        now: T0 + 1,
      });
    case 'revoke':
      return vault.revoke(KEY_A, T0 + 1);
    case 'rotate':
      return vault.rotate(KEY_A, { newKeyRef: KEY_A_ROTATED, issuedAt: T0 + TTL_MS, expiresAt: T0 + 2 * TTL_MS }, T0 + TTL_MS);
    case 'switchAccount':
      return vault.switchAccount(ACCOUNT_A, T0 + 1);
    case 'registerPendingAction':
      return vault.registerPendingAction({ actionRef: ACTION_1, keyRef: KEY_A, scope: SCOPE_SUBMIT, expiresAt: T0 + TTL_MS });
    case 'consumePendingAction':
      vault.registerPendingAction({ actionRef: ACTION_1, keyRef: KEY_A, scope: SCOPE_SUBMIT, expiresAt: T0 + TTL_MS });
      return vault.consumePendingAction(ACTION_1, T0 + 1);
    case 'reinstall':
      return vault.reinstall(INSTALL_2, T0 + 1);
    default:
      throw new Error(`未覆盖的操作 ${operation}`);
  }
}

/** 省掉某个必填字段后的调用（返回结果或抛错）。 */
function invokeMissing(operation: string, field: string): unknown {
  const { vault } = makeScenario();
  const full = (
    {
      importCredential: {
        keyRef: KEY_A_ROTATED,
        accountRef: ACCOUNT_A,
        provider: 'meituan',
        scopes: [SCOPE_READ],
        issuedAt: T0,
        expiresAt: T0 + TTL_MS,
      },
      authorize: { keyRef: KEY_A, accountRef: ACCOUNT_A, provider: 'meituan', requiredScope: SCOPE_READ, now: T0 + 1 },
      registerPendingAction: { actionRef: ACTION_1, keyRef: KEY_A, scope: SCOPE_SUBMIT, expiresAt: T0 + TTL_MS },
    } as Readonly<Record<string, Record<string, unknown>>>
  )[operation];
  if (full === undefined) {
    // 位置参数形态：直接按名字删对应实参
    switch (operation) {
      case 'revoke':
        return vault.revoke(undefined as never, T0 + 1);
      case 'rotate':
        return vault.rotate(undefined as never, { newKeyRef: KEY_A_ROTATED, issuedAt: T0, expiresAt: T0 + TTL_MS }, T0 + 1);
      case 'switchAccount':
        return vault.switchAccount(undefined as never, T0 + 1);
      case 'consumePendingAction':
        return vault.consumePendingAction(undefined as never, T0 + 1);
      case 'reinstall':
        return vault.reinstall(undefined as never, T0 + 1);
      default:
        throw new Error(`未覆盖的操作 ${operation}`);
    }
  }
  const copy = { ...full };
  delete copy[field];
  return invokeValidFromObject(operation, vault, copy);
}

function invokeValidFromObject(operation: string, vault: CredentialVault, fields: Record<string, unknown>): unknown {
  switch (operation) {
    case 'importCredential':
      return vault.importCredential(fields as never);
    case 'authorize':
      return vault.authorize(fields as never);
    case 'registerPendingAction':
      return vault.registerPendingAction(fields as never);
    default:
      throw new Error(`未覆盖的 object 操作 ${operation}`);
  }
}

function expectDirectlyRejected(operation: string, field: string): void {
  const schema: OperationSchema = OPERATION_SCHEMAS[operation] as OperationSchema;
  if (schema.enforcement === 'strict') {
    expect(() => invokeMissing(operation, field)).toThrowError(CredentialError);
    return;
  }
  // total：不抛错，但必须给出否定（reason/denied）
  const result = invokeMissing(operation, field) as { allowed?: boolean; consumed?: boolean };
  const denied = result.allowed === false || result.consumed === false;
  expect(denied).toBe(true);
}

describe('M-R05 契约：操作目录 ↔ 实现', () => {
  it('schema 声明的操作与 CredentialVault 原型方法一一对应', () => {
    const declared = Object.keys(OPERATION_SCHEMAS).sort();
    // 用属性描述符识别方法，**不触发** getter（protected 私有字段不能从原型上读取）。
    const prototypeMethods = Object.entries(Object.getOwnPropertyDescriptors(CredentialVault.prototype))
      .filter(([name, descriptor]) => name !== 'constructor' && typeof descriptor.value === 'function')
      .map(([name]) => name);
    for (const name of declared) {
      expect(prototypeMethods, `缺少实现 ${name}`).toContain(name);
    }
  });

  it('每个操作都声明了非空字段表与返回值说明', () => {
    for (const [name, schema] of Object.entries(OPERATION_SCHEMAS)) {
      expect(Object.keys(schema.fields).length, name).toBeGreaterThan(0);
      expect(schema.returns.length, name).toBeGreaterThan(0);
      expect(requiredFields(name).length, name).toBeGreaterThan(0);
    }
  });

  it('每个合法调用都能执行（不回滚成 stub）', () => {
    for (const name of Object.keys(OPERATION_SCHEMAS)) {
      const fx = { vault: makeScenario().vault };
      expect(() => invokeValid(name, fx), name).not.toThrow();
    }
  });

  it('每个必填字段被省略时确实被拒（strict 抛错 / total 否定）', () => {
    for (const [name, schema] of Object.entries(OPERATION_SCHEMAS)) {
      for (const field of requiredFields(name)) {
        expectDirectlyRejected(name, field);
      }
    }
  });

  it('object 形态 strict 操作注入未声明字段必须被拒', () => {
    for (const name of Object.keys(OPERATION_SCHEMAS)) {
      if (!OBJECT_FORM.has(name)) {
        continue;
      }
      const { vault } = makeScenario();
      const base: Record<string, unknown> =
        name === 'importCredential'
          ? { keyRef: KEY_A_ROTATED, accountRef: ACCOUNT_A, provider: 'meituan', scopes: [SCOPE_READ], issuedAt: T0, expiresAt: T0 + TTL_MS }
          : { actionRef: ACTION_1, keyRef: KEY_A, scope: SCOPE_SUBMIT, expiresAt: T0 + TTL_MS };
      expect(() => invokeValidFromObject(name, vault, { ...base, evilExtra: 1 }), name).toThrowError(CredentialError);
    }
  });
});

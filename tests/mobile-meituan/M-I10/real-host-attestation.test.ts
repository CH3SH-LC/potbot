/**
 * M-I10 真机宿主凭证闸门：只能由**已登记**的可信真机传输凭证构造；
 * 缺凭证 / 伪造凭证一律拒；fixture 宿主仍无法被提升为生产；支付永远不是工具。
 */

import { describe, expect, it } from 'vitest';

import {
  assertNoPaymentTool,
  assertProductionActivation,
  assertToolCallAllowed,
  buildDispatchRegistry,
  checkProductionActivation,
  createFixtureFeatureHost,
  createRealFeatureHost,
  HostError,
  isFeatureHost,
  isRealFeatureHost,
  PAYMENT_IS_NOT_A_TOOL,
  promoteToProduction,
  ToolDispatchError,
  type RealTransportProof,
} from '../../../src/mobile-plugins/meituan/mobile-feature/index.js';
import { fullyVerifiedMatrix, matrixFrom, ports, realAttestation, T0 } from './support.js';

function expectHostCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HostError);
    expect((error as HostError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 ${code}，但没有抛错`);
}

const forgedProof: RealTransportProof = {
  verificationMode: 'real',
  deviceRef: 'device:honor-forged',
  requestHostRef: 'host:api.meituan.example',
  transportEvidenceRef: 'net-forged',
  observedAt: T0,
};

describe('M-I10 真机宿主：缺凭证 / 伪造凭证一律拒', () => {
  it('没有 attestation ⇒ real_host_not_wired', () => {
    const scenario = ports();
    expectHostCode(
      () =>
        createRealFeatureHost({
          ports: scenario.ports,
          matrix: fullyVerifiedMatrix(),
        } as never),
      'real_host_not_wired',
    );
  });

  it('形状相同但未登记的伪造凭证 ⇒ untrusted_real_attestation', () => {
    const scenario = ports();
    const forged = { proof: forgedProof, issuedAt: T0 };
    expectHostCode(
      () =>
        createRealFeatureHost({
          ports: scenario.ports,
          matrix: fullyVerifiedMatrix(),
          attestation: forged as never,
        }),
      'untrusted_real_attestation',
    );
  });

  it('伪造的真机宿主对象不被承认为 real 宿主', () => {
    const fake = {
      mode: 'real',
      identity: 'fake',
      activateProduction(): never {
        throw new Error('never');
      },
    };
    expect(isRealFeatureHost(fake)).toBe(false);
    expect(isFeatureHost(fake)).toBe(false);
  });

  it('已登记凭证 + 缺端口 ⇒ missing_quote_port（凭证通过后仍守端口前置）', () => {
    const scenario = ports();
    expectHostCode(
      () =>
        createRealFeatureHost({
          ports: { ...scenario.ports, quote: null },
          matrix: fullyVerifiedMatrix(),
          attestation: realAttestation(),
        } as never),
      'missing_quote_port',
    );
  });
});

describe('M-I10 真机宿主（已登记凭证）：real 台账 + 生产启用闸门', () => {
  it('构造成功：mode=real、isRealFeatureHost=true、isFeatureHost=false（fixture-only）', () => {
    const scenario = ports();
    const host = createRealFeatureHost({
      ports: scenario.ports,
      matrix: matrixFrom({ submit: 'verified' }),
      attestation: realAttestation(),
    });
    expect(host.mode).toBe('real');
    expect(isRealFeatureHost(host)).toBe(true);
    expect(isFeatureHost(host)).toBe(false);
    expect(host.ledger.mode).toBe('real');
    // real 台账能记录 confirmed —— 这正是 fixture 台账写不了的。
    host.ledger.record({
      journeyId: 'journey-real-1',
      stage: 'order_readback',
      observedState: 'confirmed',
      externalOrderId: 'MT-REAL-1',
      amountMinor: 7100,
      currency: 'CNY',
      detail: '平台回读确认已下单（fixture 不可达）',
    });
    expect(host.ledger.summary().confirmedCount).toBe(1);
  });

  it('real manifest 过得了生产启用闸门（fixture manifest 恒过不了）', () => {
    const host = createRealFeatureHost({
      ports: ports().ports,
      matrix: fullyVerifiedMatrix(),
      attestation: realAttestation(),
    });
    const check = checkProductionActivation(host.manifest);
    expect(check.activatable).toBe(true);
    expect(check.blocks).toEqual([]);
    expect(() => assertProductionActivation(host.manifest)).not.toThrow();

    const fixtureHost = createFixtureFeatureHost({ ports: ports().ports });
    expect(checkProductionActivation(fixtureHost.manifest).activatable).toBe(false);
  });

  it('真机宿主的真实下单/支付执行路径仍未接线：activateProduction 抛 real_host_not_wired', () => {
    const host = createRealFeatureHost({
      ports: ports().ports,
      matrix: fullyVerifiedMatrix(),
      attestation: realAttestation(),
    });
    expectHostCode(() => host.activateProduction(), 'real_host_not_wired');
  });

  it('真机宿主已在生产：promoteToProduction 抛 real_host_already_production', () => {
    const host = createRealFeatureHost({
      ports: ports().ports,
      matrix: fullyVerifiedMatrix(),
      attestation: realAttestation(),
    });
    expectHostCode(() => promoteToProduction(host), 'real_host_already_production');
  });

  it('real 宿主工具仍按 scope 暴露：未核实 ⇒ 提交工具未暴露且守卫拒调', () => {
    const host = createRealFeatureHost({
      ports: ports().ports,
      matrix: matrixFrom({ submit: 'verified' }),
      attestation: realAttestation(),
    });
    const ids = host.toolSchemas().map((contract) => contract.toolId);
    expect(ids).toContain('cap.meituan.submitOrder');
    expect(ids).not.toContain('cap.meituan.search');

    const registry = buildDispatchRegistry(host.tools);
    try {
      assertToolCallAllowed(registry, {
        toolId: 'cap.meituan.search',
        arguments: { category: '火锅', location: '上海' },
      });
      throw new Error('期望拒调未暴露工具');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolDispatchError);
      expect((error as ToolDispatchError).code).toBe('tool_not_exposed');
    }
  });
});

describe('M-I10 真机宿主：fixture 仍不能翻转 + 支付永远不是工具', () => {
  it('fixture 宿主 promoteToProduction 仍抛 fixture_host_cannot_be_promoted', () => {
    const fixtureHost = createFixtureFeatureHost({ ports: ports().ports });
    expectHostCode(() => promoteToProduction(fixtureHost), 'fixture_host_cannot_be_promoted');
  });

  it('支付不是工具：PAYMENT_IS_NOT_A_TOOL=true，真机宿主工具集无 pay 能力', () => {
    expect(PAYMENT_IS_NOT_A_TOOL).toBe(true);
    expect(() => assertNoPaymentTool()).not.toThrow();
    const host = createRealFeatureHost({
      ports: ports().ports,
      matrix: fullyVerifiedMatrix(),
      attestation: realAttestation(),
    });
    expect(host.tools.some((tool) => (tool.capability as string | null) === 'pay')).toBe(false);
  });
});

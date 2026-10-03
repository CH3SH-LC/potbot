/**
 * M10 独立宿主：装配、暴露、以及「fixture 不能被翻转为生产」。
 */

import { describe, expect, it } from 'vitest';

import {
  createFixtureFeatureHost,
  createFixtureJourneyPorts,
  createRealFeatureHost,
  HostError,
  isFeatureHost,
  promoteToProduction,
  type FeatureHostPorts,
} from '../../../src/mobile-plugins/meituan/mobile-feature/index.js';
import { fullyVerifiedMatrix, matrixFrom, realAttestation, unverifiedMatrix } from './support.js';

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

describe('M10 fixture 宿主装配', () => {
  it('构造成功，mode=fixture，端口被真实接线可调用', async () => {
    const scenario = createFixtureJourneyPorts();
    const host = createFixtureFeatureHost({ ports: scenario.ports });
    expect(host.mode).toBe('fixture');
    expect(isFeatureHost(host)).toBe(true);
    expect(host.ledger.mode).toBe('fixture');
    // 端口确实被接线：真正调一次报价端口。
    const quote = await host.ports.quote.price({
      merchantId: 'm1',
      currency: 'CNY',
      lines: [{ lineId: 'l1', dishId: 'd1', skuId: 'sku-noodle', specs: [], quantity: 2 }],
      delivery: { addressRef: 'addr-home' },
      pricing: { couponCodes: [], serviceOptions: [] },
      paramsDigest: 'v1-test',
      requestedAt: host.ports.clock.now(),
    });
    expect(quote.amount).toBe(6400 + 700); // 2×3200 + (打包 200 + 配送 500)
    expect(quote.currency).toBe('CNY');
  });

  it('未核实矩阵下 toolSchemas 只含本地确认工具', () => {
    const scenario = createFixtureJourneyPorts();
    const host = createFixtureFeatureHost({ ports: scenario.ports, matrix: unverifiedMatrix() });
    expect(host.toolSchemas().map((c) => c.toolId)).toEqual(['cap.meituan.confirm']);
  });

  it('核实 submit 后 toolSchemas 含提交工具', () => {
    const scenario = createFixtureJourneyPorts();
    const host = createFixtureFeatureHost({ ports: scenario.ports, matrix: matrixFrom({ submit: 'verified' }) });
    expect(host.toolSchemas().map((c) => c.toolId)).toContain('cap.meituan.submitOrder');
  });

  it('缺报价端口 ⇒ missing_quote_port', () => {
    const scenario = createFixtureJourneyPorts();
    const badPorts = { ...scenario.ports, quote: null } as unknown as FeatureHostPorts;
    expectHostCode(() => createFixtureFeatureHost({ ports: badPorts }), 'missing_quote_port');
  });

  it('缺时钟 ⇒ missing_clock', () => {
    const scenario = createFixtureJourneyPorts();
    const badPorts = { ...scenario.ports, clock: {} } as unknown as FeatureHostPorts;
    expectHostCode(() => createFixtureFeatureHost({ ports: badPorts }), 'missing_clock');
  });
});

describe('M10 fixture 宿主不能被翻转为生产', () => {
  it('host.activateProduction() 调用即抛', () => {
    const scenario = createFixtureJourneyPorts();
    const host = createFixtureFeatureHost({ ports: scenario.ports });
    expectHostCode(() => host.activateProduction(), 'fixture_host_cannot_be_promoted');
  });

  it('promoteToProduction(fixture 宿主) 抛错', () => {
    const scenario = createFixtureJourneyPorts();
    const host = createFixtureFeatureHost({ ports: scenario.ports, matrix: fullyVerifiedMatrix() });
    expectHostCode(() => promoteToProduction(host), 'fixture_host_cannot_be_promoted');
  });

  it('promoteToProduction(非宿主) 抛 not_a_host', () => {
    expectHostCode(() => promoteToProduction({}), 'not_a_host');
  });
});

describe('M10 真机宿主是诚实存根', () => {
  it('携带可信凭证可构造，但真实执行路径未接线 ⇒ activateProduction 抛 real_host_not_wired', () => {
    const scenario = createFixtureJourneyPorts();
    // 当前契约：RealFeatureHostConfig 必须携带一枚已登记的可信真机传输凭证。
    const host = createRealFeatureHost({
      ports: scenario.ports,
      matrix: fullyVerifiedMatrix(),
      attestation: realAttestation(),
    });
    expect(host.mode).toBe('real');
    // 真机宿主是诚实存根：真正的下单/支付执行路径仍未接线。
    expectHostCode(() => host.activateProduction(), 'real_host_not_wired');
  });
});

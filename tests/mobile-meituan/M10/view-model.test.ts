/**
 * M10 旅程 ViewModel：逐步状态、无合并 ok、canPay 恒 false、placedClaimable 只在 confirmed。
 */

import { describe, expect, it } from 'vitest';

import {
  buildJourneyViewModel,
  resolveExposedTools,
  type ExposedTool,
  type JourneyViewModelInput,
} from '../../../src/mobile-plugins/meituan/mobile-feature/index.js';
import { fullyVerifiedMatrix, matrixFrom, T0 } from './support.js';

function tools(verified = true): readonly ExposedTool[] {
  return resolveExposedTools(verified ? fullyVerifiedMatrix() : matrixFrom({}));
}

function baseInput(overrides: Partial<JourneyViewModelInput> = {}): JourneyViewModelInput {
  return {
    tools: tools(),
    store: { merchantId: 'm1', name: '示例店', sourceRef: 'src-1' },
    cart: [{ lineId: 'l1', dishName: '牛肉面', skuLabel: '大碗/微辣', quantity: 2 }],
    address: { status: 'ready', addressRef: 'addr-home#v1' },
    quote: { quoteRef: 'q1', amountMinor: 7100, currency: 'CNY', expiresAt: T0 + 300_000, staleReason: null },
    confirmation: { actionId: 'a1', paramsDigest: 'v1-abc', authorization: 'authorized' },
    submission: null,
    tracking: null,
    now: T0,
    ...overrides,
  };
}

describe('M10 ViewModel 基本形状', () => {
  it('九步齐全，且 canPay 恒为 false', () => {
    const vm = buildJourneyViewModel(baseInput());
    expect(vm.steps.map((s) => s.step)).toEqual([
      'scope',
      'store',
      'menu',
      'cart',
      'address',
      'quote',
      'confirm',
      'submit',
      'track',
    ]);
    expect(vm.canPay).toBe(false);
  });

  it('参数齐全且提交工具已暴露 ⇒ canSubmit 为 true、placedClaimable 为 false（还没提交）', () => {
    const vm = buildJourneyViewModel(baseInput());
    expect(vm.canSubmit).toBe(true);
    expect(vm.placedClaimable).toBe(false);
    expect(vm.quoteAmountMinor).toBe(7100);
  });

  it('提交状态为 confirmed 才 placedClaimable=true', () => {
    const vm = buildJourneyViewModel(
      baseInput({ submission: { state: 'confirmed', externalOrderId: 'MT-1' } }),
    );
    expect(vm.placedClaimable).toBe(true);
  });

  it('提交状态为 submitted（平台受理）不算完成', () => {
    const vm = buildJourneyViewModel(
      baseInput({ submission: { state: 'submitted', externalOrderId: 'MT-1' } }),
    );
    expect(vm.placedClaimable).toBe(false);
  });
});

describe('M10 ViewModel 阻断传导', () => {
  it('提交工具未暴露（scope 未核实）⇒ canSubmit false 且原因指向工具', () => {
    const vm = buildJourneyViewModel(baseInput({ tools: tools(false) }));
    expect(vm.canSubmit).toBe(false);
    expect(vm.blockedReason).toContain('提交工具未暴露');
    const submitStep = vm.steps.find((s) => s.step === 'submit');
    expect(submitStep?.status).toBe('blocked');
  });

  it('报价失效 ⇒ quote 步 stale、canSubmit false', () => {
    const vm = buildJourneyViewModel(
      baseInput({
        quote: { quoteRef: 'q1', amountMinor: 7100, currency: 'CNY', expiresAt: T0 + 300_000, staleReason: 'params_changed' },
      }),
    );
    expect(vm.steps.find((s) => s.step === 'quote')?.status).toBe('stale');
    expect(vm.canSubmit).toBe(false);
    expect(vm.blockedReason).toBe('报价失效或过期');
  });

  it('报价过期（注入时钟到点）⇒ stale', () => {
    const vm = buildJourneyViewModel(
      baseInput({
        quote: { quoteRef: 'q1', amountMinor: 7100, currency: 'CNY', expiresAt: T0, staleReason: null },
      }),
    );
    expect(vm.steps.find((s) => s.step === 'quote')?.status).toBe('stale');
    expect(vm.canSubmit).toBe(false);
  });

  it('确认仍是 draft ⇒ 等待确认、canSubmit false', () => {
    const vm = buildJourneyViewModel(
      baseInput({ confirmation: { actionId: 'a1', paramsDigest: 'v1-abc', authorization: 'draft' } }),
    );
    expect(vm.canSubmit).toBe(false);
    expect(vm.blockedReason).toBe('等待用户本次确认');
  });

  it('地址需要显式选择 ⇒ address 步 active', () => {
    const vm = buildJourneyViewModel(
      baseInput({ address: { status: 'needs_explicit_selection', addressRef: null } }),
    );
    expect(vm.steps.find((s) => s.step === 'address')?.status).toBe('active');
  });

  it('订单状态码未识别 ⇒ track 步 stale（不冒充成功）', () => {
    const vm = buildJourneyViewModel(
      baseInput({
        tracking: { externalId: 'MT-1', statusRecognized: false, stages: [] },
      }),
    );
    expect(vm.steps.find((s) => s.step === 'track')?.status).toBe('stale');
  });
});

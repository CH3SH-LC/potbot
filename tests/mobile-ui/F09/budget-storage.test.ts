/**
 * F09 验收：额度与存储（M08、I4）。
 *
 * 反向对照：
 *   - fixture 用量不得被当作真实花费（`real === false` 且文案标注 fixture）；
 *   - 未测量的存储必须报 `measured:false` / 展示「未知」，且「未测量却报数字」抛错；
 *   - 用尽后如实报 `exhausted` 并列出用尽资源。
 */

import { describe, expect, it } from 'vitest';

import {
  computeBudgetUsage,
  describeStorageUsage,
  formatBytes,
} from '../../../apps/mobile-ui/src/settings/index.js';

describe('F09 / 预算用量（I4）', () => {
  it('正常用量：算出剩余与进度比例', () => {
    const usage = computeBudgetUsage({
      maxTokens: 4096,
      usedTokens: 1024,
      maxCostMicros: 2_000_000,
      usedCostMicros: 500_000,
      timeoutMs: 30000,
      verificationMode: 'real',
    });
    expect(usage.tokensRemaining).toBe(3072);
    expect(usage.costMicrosRemaining).toBe(1_500_000);
    expect(usage.exhausted).toBe(false);
    expect(usage.tokenFraction).toBeCloseTo(0.25, 5);
    expect(usage.real).toBe(true);
    expect(usage.label).toContain('1024/4096 tokens');
  });

  it('用尽：exhausted 为真并列出用尽资源', () => {
    const usage = computeBudgetUsage({
      maxTokens: 1000,
      usedTokens: 1000,
      maxCostMicros: 100,
      usedCostMicros: 250,
      timeoutMs: null,
      verificationMode: 'real',
    });
    expect(usage.exhausted).toBe(true);
    expect(usage.exhaustedBy).toEqual(['tokens', 'cost']);
    expect(usage.label).toContain('已用尽');
  });

  it('反向对照：fixture 模式不声称真实花费', () => {
    const usage = computeBudgetUsage({
      maxTokens: 100,
      usedTokens: 10,
      maxCostMicros: null,
      usedCostMicros: 0,
      timeoutMs: null,
      verificationMode: 'fixture',
    });
    expect(usage.real).toBe(false);
    expect(usage.label).toContain('fixture');
    expect(usage.label).toContain('非真实花费');
  });

  it('无上限时剩余为 null，不虚报数字', () => {
    const usage = computeBudgetUsage({
      maxTokens: null,
      usedTokens: 7,
      maxCostMicros: null,
      usedCostMicros: 0,
      timeoutMs: null,
      verificationMode: 'real',
    });
    expect(usage.tokensRemaining).toBeNull();
    expect(usage.costMicrosRemaining).toBeNull();
    expect(usage.tokenFraction).toBeNull();
  });

  it('非法用量抛错', () => {
    expect(() =>
      computeBudgetUsage({
        maxTokens: 10,
        usedTokens: -1,
        maxCostMicros: null,
        usedCostMicros: 0,
        timeoutMs: null,
        verificationMode: 'real',
      }),
    ).toThrowError(/usedTokens/);
  });
});

describe('F09 / 存储用量（I4）', () => {
  it('已测量：给出用量、占比与明细', () => {
    const view = describeStorageUsage({
      measured: true,
      usedBytes: 1024 * 1024 * 512,
      quotaBytes: 1024 * 1024 * 1024,
      cacheBytes: 1024 * 1024 * 64,
      downloadsBytes: 1024 * 1024 * 128,
      retentionDays: 30,
      verificationMode: 'real',
    });
    expect(view.measured).toBe(true);
    expect(view.usedFraction).toBeCloseTo(0.5, 5);
    expect(view.breakdown.map((entry) => entry.kind)).toEqual(['used', 'cache', 'downloads']);
    expect(view.label).toContain('512.0 MB');
    expect(view.label).toContain('保留 30 天');
  });

  it('反向对照：未测量时展示「未知」，绝不用 0 冒充空', () => {
    const view = describeStorageUsage({
      measured: false,
      usedBytes: null,
      quotaBytes: null,
      cacheBytes: null,
      downloadsBytes: null,
      retentionDays: null,
      verificationMode: 'real',
    });
    expect(view.measured).toBe(false);
    expect(view.usedBytes).toBeNull();
    expect(view.usedFraction).toBeNull();
    expect(view.label).toContain('未知');
    expect(view.breakdown).toEqual([]);
  });

  it('反向对照：未测量却报数字（含 0）抛 invalid-storage', () => {
    expect(() =>
      describeStorageUsage({
        measured: false,
        usedBytes: 0,
        quotaBytes: null,
        cacheBytes: null,
        downloadsBytes: null,
        retentionDays: null,
        verificationMode: 'real',
      }),
    ).toThrowError(/未测量/);
  });

  it('formatBytes 人类可读', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
  });
});

/**
 * M-I04 —— ISO-8601 wire 时间戳（M04 nextIncrement #2）。
 *
 * 断言：转换只依赖**注入的** epoch 毫秒，可正反往返，越界/非法输入显式报错。
 */

import { describe, expect, it } from 'vitest';

import {
  CartValidationError,
  epochToIso8601,
  iso8601ToEpoch,
  WIRE_TIMESTAMP_FIELDS,
} from '../../../src/mobile-plugins/meituan/cart/index.js';

describe('epochToIso8601：已知向量', () => {
  it('epoch 0 是 1970-01-01T00:00:00.000Z', () => {
    expect(epochToIso8601(0)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('1 毫秒落在 .001Z', () => {
    expect(epochToIso8601(1)).toBe('1970-01-01T00:00:00.001Z');
  });

  it('2021-01-01T00:00:00.000Z = 1609459200000', () => {
    expect(epochToIso8601(1609459200000)).toBe('2021-01-01T00:00:00.000Z');
  });

  it('闰日 2000-02-29T00:00:00.000Z = 951782400000', () => {
    expect(epochToIso8601(951782400000)).toBe('2000-02-29T00:00:00.000Z');
  });

  it('epoch 前一刻：-1 ⇒ 1969-12-31T23:59:59.999Z', () => {
    expect(epochToIso8601(-1)).toBe('1969-12-31T23:59:59.999Z');
  });

  it('秒精度截断到整秒', () => {
    expect(epochToIso8601(1234, { precision: 'seconds' })).toBe('1970-01-01T00:00:01Z');
  });
});

describe('iso8601ToEpoch：解析', () => {
  it('解析带毫秒与不带毫秒两种形状', () => {
    expect(iso8601ToEpoch('2021-01-01T00:00:00.000Z')).toBe(1609459200000);
    expect(iso8601ToEpoch('2021-01-01T00:00:00Z')).toBe(1609459200000);
    expect(iso8601ToEpoch('2000-02-29T00:00:00.000Z')).toBe(951782400000);
  });

  it('epoch 前的时间为负', () => {
    expect(iso8601ToEpoch('1969-12-31T23:59:59.999Z')).toBe(-1);
  });

  const samples = [0, 1, -1, 951782400000, 1609459200000, 1727913600000];
  it('epoch → ISO → epoch 往返恒等', () => {
    for (const sample of samples) {
      expect(iso8601ToEpoch(epochToIso8601(sample))).toBe(sample);
    }
  });
});

describe('输入校验：显式报错，不静默', () => {
  it('非安全整数 epoch 抛 CartValidationError', () => {
    expect(() => epochToIso8601(1.5)).toThrow(CartValidationError);
    expect(() => epochToIso8601(Number.NaN)).toThrow(CartValidationError);
    expect(() => epochToIso8601(Number.POSITIVE_INFINITY)).toThrow(CartValidationError);
    expect(() => epochToIso8601(Number.MAX_SAFE_INTEGER + 2)).toThrow(CartValidationError);
  });

  it('非法 ISO 字符串抛 CartValidationError', () => {
    for (const bad of [
      '2021-01-01T00:00:00',
      '2021-01-01 00:00:00Z',
      '2021-01-01T00:00:00+08:00',
      '2023-02-30T00:00:00Z',
      '2021-13-01T00:00:00Z',
      '2021-01-01T24:00:00Z',
      'not-a-timestamp',
    ]) {
      expect(() => iso8601ToEpoch(bad), bad).toThrow(CartValidationError);
    }
  });
});

describe('字段清单', () => {
  it('列出需要 wire 转换的报价/请求时间字段', () => {
    expect([...WIRE_TIMESTAMP_FIELDS].sort()).toEqual(['createdAt', 'expiresAt', 'pricedAt', 'requestedAt']);
  });
});

/**
 * M02 ③：协议解码与业务分类。
 *
 * 核心断言：**未登记的业务码一律 `unknown`**；协议层失败（空 body / 非 JSON / 缺 code）
 * 只有"失败"这一个出口，产不出任何"看起来像成功"的对象。
 */

import { describe, expect, it } from 'vitest';

import {
  classifyBusiness,
  createBusinessCodeTable,
  decodeEnvelope,
} from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';

import { businessTable } from './support.js';

describe('M02 decodeEnvelope', () => {
  it('合法信封（含 code）⇒ ok:true', () => {
    const r = decodeEnvelope(JSON.stringify({ code: 'ok', message: 'fine', data: { id: 1 } }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.envelope.code).toBe('ok');
      expect(r.envelope.message).toBe('fine');
      expect(r.envelope.data).toEqual({ id: 1 });
    }
  });

  it('空 body / 全空白 ⇒ empty_body', () => {
    for (const body of ['', '   ', '\n\t']) {
      const r = decodeEnvelope(body);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.protocolErrorKind).toBe('empty_body');
      }
    }
  });

  it('非 JSON ⇒ malformed_json', () => {
    const r = decodeEnvelope('<html>502 Bad Gateway</html>');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.protocolErrorKind).toBe('malformed_json');
    }
  });

  it('顶层是数组 / null / 标量 ⇒ invalid_envelope', () => {
    for (const body of ['[]', 'null', '42', '"ok"']) {
      const r = decodeEnvelope(body);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.protocolErrorKind).toBe('invalid_envelope');
      }
    }
  });

  it('缺 code / code 非非空字符串 ⇒ invalid_envelope', () => {
    for (const body of ['{}', '{"message":"x"}', '{"code":""}', '{"code":123}', '{"code":null}']) {
      const r = decodeEnvelope(body);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.protocolErrorKind).toBe('invalid_envelope');
      }
    }
  });

  it('非字符串输入 ⇒ empty_body（不抛）', () => {
    const r = decodeEnvelope(undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.protocolErrorKind).toBe('empty_body');
    }
  });
});

describe('M02 classifyBusiness', () => {
  const table = businessTable();

  it('登记为 success 的码 ⇒ success', () => {
    expect(classifyBusiness({ code: 'ok', message: null, data: null }, table)).toBe('success');
  });

  it('登记为 business_failure 的码 ⇒ business_failure', () => {
    expect(classifyBusiness({ code: 'sold_out', message: null, data: null }, table)).toBe('business_failure');
  });

  it('未登记的码 ⇒ unknown（绝不猜成功）', () => {
    expect(classifyBusiness({ code: 'brand_new_code', message: null, data: null }, table)).toBe('unknown');
    expect(classifyBusiness({ code: '', message: null, data: null }, table)).toBe('unknown');
  });

  it('登记表 lookup 抛错 ⇒ unknown', () => {
    const broken = { lookup(): never { throw new Error('boom'); } };
    expect(classifyBusiness({ code: 'x', message: null, data: null }, broken)).toBe('unknown');
  });
});

describe('M02 createBusinessCodeTable', () => {
  it('重复码抛错', () => {
    expect(() =>
      createBusinessCodeTable([
        { code: 'ok', kind: 'success' },
        { code: 'ok', kind: 'business_failure' },
      ]),
    ).toThrow(TypeError);
  });

  it('非法 kind 抛错', () => {
    expect(() =>
      createBusinessCodeTable([{ code: 'x', kind: 'maybe' as never }]),
    ).toThrow(TypeError);
  });

  it('空 code 抛错', () => {
    expect(() => createBusinessCodeTable([{ code: '', kind: 'success' }])).toThrow(TypeError);
  });
});

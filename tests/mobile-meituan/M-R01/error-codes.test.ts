/**
 * M-R01 wire 错误码分类：HTTP 成功 ≠ 业务成功，且未知码绝不判成功。
 */

import { describe, expect, it } from 'vitest';

import {
  WIRE_ERROR_CATEGORIES,
  WIRE_ERROR_CODE_TABLE,
  classifyWireError,
  lookupWireErrorCode,
  lookupWireErrorSymbol,
  mayReportWireSuccess,
  toDomainBusinessCode,
  type WireTransport,
} from './error-codes.js';

function response(httpStatus: number, bodyCode: string): WireTransport {
  return { transport: 'response', httpStatus, bodyCode };
}

describe('M-R01 wire 码登记表', () => {
  it('码与符号都唯一，且只有一个 ok', () => {
    const codes = WIRE_ERROR_CODE_TABLE.map((e) => e.code);
    const symbols = WIRE_ERROR_CODE_TABLE.map((e) => e.symbol);
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(symbols).size).toBe(symbols.length);
    expect(WIRE_ERROR_CODE_TABLE.filter((e) => e.category === 'ok').map((e) => e.code)).toEqual(['0']);
  });

  it('分类值都在词表内', () => {
    for (const entry of WIRE_ERROR_CODE_TABLE) {
      expect(WIRE_ERROR_CATEGORIES).toContain(entry.category);
    }
  });

  it('查码 / 查符号可在表内命中；未登记返回 undefined', () => {
    expect(lookupWireErrorCode('1003')?.symbol).toBe('price_changed');
    expect(lookupWireErrorSymbol('duplicate_order')?.code).toBe('4001');
    expect(lookupWireErrorCode('777777')).toBeUndefined();
  });
});

describe('M-R01 classifyWireError：唯一通向 ok 的组合', () => {
  it('HTTP 200 + 码 0 ⇒ ok', () => {
    const c = classifyWireError(response(200, '0'));
    expect(c.category).toBe('ok');
    expect(mayReportWireSuccess(c)).toBe(true);
  });

  it('HTTP 200 + 码 1003（价格变动）⇒ business_reject，不得报成功', () => {
    const c = classifyWireError(response(200, '1003'));
    expect(c.category).toBe('business_reject');
    expect(c.requiresOrderQuery).toBe(false);
    expect(mayReportWireSuccess(c)).toBe(false);
  });

  it('HTTP 200 + 空码 ⇒ unknown 且须查原单（不猜成功）', () => {
    const c = classifyWireError(response(200, ''));
    expect(c.category).toBe('unknown');
    expect(c.requiresOrderQuery).toBe(true);
    expect(mayReportWireSuccess(c)).toBe(false);
  });

  it('HTTP 200 + 未登记码 ⇒ unknown 且须查原单', () => {
    const c = classifyWireError(response(200, 'brand_new_code'));
    expect(c.category).toBe('unknown');
    expect(c.requiresOrderQuery).toBe(true);
  });

  it('HTTP 200 + 4001（重复下单）⇒ unknown 且须查原单（订单可能已存在）', () => {
    const c = classifyWireError(response(200, '4001'));
    expect(c.category).toBe('unknown');
    expect(c.requiresOrderQuery).toBe(true);
    expect(mayReportWireSuccess(c)).toBe(false);
  });

  it('HTTP 500 + 码 0 ⇒ unknown（服务端异常，结果不可知，须查原单）', () => {
    const c = classifyWireError(response(500, '0'));
    expect(c.category).toBe('unknown');
    expect(c.requiresOrderQuery).toBe(true);
  });

  it('HTTP 429 ⇒ rate_limit 可重试且未受理（不必查原单）', () => {
    const c = classifyWireError(response(429, '4290'));
    expect(c.category).toBe('rate_limit');
    expect(c.retryable).toBe(true);
    expect(c.requiresOrderQuery).toBe(false);
  });

  it('HTTP 401/403 ⇒ auth 不可重试', () => {
    expect(classifyWireError(response(401, '')).category).toBe('auth');
    expect(classifyWireError(response(403, '3002')).category).toBe('auth');
    expect(classifyWireError(response(403, '3002')).retryable).toBe(false);
  });

  it('HTTP 400 ⇒ client_error 不构成下单', () => {
    const c = classifyWireError(response(400, 'bad'));
    expect(c.category).toBe('client_error');
    expect(c.requiresOrderQuery).toBe(false);
  });

  it('超时 / 网络错误 ⇒ unknown 且须查原单', () => {
    expect(classifyWireError({ transport: 'timeout', detail: 't' }).category).toBe('unknown');
    expect(classifyWireError({ transport: 'timeout', detail: 't' }).requiresOrderQuery).toBe(true);
    expect(classifyWireError({ transport: 'network_error', detail: 'e' }).requiresOrderQuery).toBe(true);
  });

  it('**没有任何分支仅凭 200 返回 ok**：只有 200 且码 0 才是 ok', () => {
    for (const code of ['', 'ok', '0', '9999', 'x']) {
      const c = classifyWireError(response(200, code));
      expect(mayReportWireSuccess(c)).toBe(code === '0');
    }
  });
});

describe('M-R01 toDomainBusinessCode：wire 码 → M07 领域语义', () => {
  it('已登记码翻译为领域符号；未登记码原样透传（保持未知）', () => {
    expect(toDomainBusinessCode('1003')).toBe('price_changed');
    expect(toDomainBusinessCode('4001')).toBe('duplicate_order');
    expect(toDomainBusinessCode('0')).toBe('ok');
    expect(toDomainBusinessCode('weird')).toBe('weird');
  });
});

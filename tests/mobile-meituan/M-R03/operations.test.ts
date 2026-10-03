/**
 * M-R03 操作信封形状校验（对齐 README §5 v1 命令契约）。
 * 只做形状校验，不执行、不联网。
 */

import { describe, expect, it } from 'vitest';

import {
  MEITUAN_QUOTE_OPERATIONS,
  OPERATION_PAYLOAD_FIELDS,
  OperationValidationError,
  isKnownOperation,
  validateOperationEnvelope,
} from './index.js';

describe('M-R03 操作信封校验', () => {
  it('合法信封被接受并原样返回', () => {
    const envelope = {
      schemaVersion: 'mobile-v1' as const,
      commandId: 'cmd-1',
      operation: 'assess_reconfirmation' as const,
      idempotencyKey: 'idem-1',
      payload: { quoteRef: 'fixture-quote-1' },
    };
    expect(validateOperationEnvelope(envelope)).toBe(envelope);
  });

  it('缺少必需字段时全部收集后一次抛出', () => {
    let caught: OperationValidationError | undefined;
    try {
      validateOperationEnvelope({ operation: 'confirm_quote', payload: {} });
    } catch (error) {
      caught = error as OperationValidationError;
    }
    expect(caught).toBeInstanceOf(OperationValidationError);
    // schemaVersion / commandId / idempotencyKey 缺失 + payload 两个字段缺失
    expect(caught?.problems.length).toBeGreaterThanOrEqual(5);
    expect(caught?.problems.join('|')).toContain('schemaVersion');
    expect(caught?.problems.join('|')).toContain('commandId');
    expect(caught?.problems.join('|')).toContain('idempotencyKey');
    expect(caught?.problems.join('|')).toContain('payload.confirmationRef');
  });

  it('未知操作被拒绝', () => {
    expect(isKnownOperation('place_order')).toBe(false);
    expect(isKnownOperation('observe_quote')).toBe(true);
    expect(() =>
      validateOperationEnvelope({
        schemaVersion: 'mobile-v1',
        commandId: 'c',
        operation: 'place_order',
        idempotencyKey: 'i',
        payload: {},
      }),
    ).toThrow(OperationValidationError);
  });

  it('非对象信封直接拒绝', () => {
    expect(() => validateOperationEnvelope(null)).toThrow(OperationValidationError);
    expect(() => validateOperationEnvelope('nope')).toThrow(OperationValidationError);
  });

  it('操作名与 payload 字段清单固定且齐全', () => {
    expect(MEITUAN_QUOTE_OPERATIONS).toEqual(['observe_quote', 'confirm_quote', 'assess_reconfirmation']);
    for (const operation of MEITUAN_QUOTE_OPERATIONS) {
      expect(OPERATION_PAYLOAD_FIELDS[operation].length).toBeGreaterThan(0);
    }
  });
});

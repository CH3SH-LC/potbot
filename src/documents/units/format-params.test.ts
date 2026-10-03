/**
 * R153 分域校验测试：格式参数与业务数字走**不同的**校验域。
 *
 * 本测试证明两件事：
 * 1. 格式值在**格式域内**有自己的范围规则，越界被拒；
 * 2. 格式参数**携带域标签**，因此无法被误当成业务数字（反之亦然）——
 *    "把第二段设成 12 磅"里的 12 是一个 format 值，不是"凭空出现的事实数字"。
 */

import { describe, expect, it } from 'vitest';
import {
  BUSINESS_NUMBER_DOMAIN,
  FORMAT_FIELDS,
  FORMAT_PARAMETER_DOMAIN,
  isFormatParameter,
  requireFormatParameter,
  validateFormatParameter,
} from './format-params.js';

describe('两个域是两个不同的标签（R153）', () => {
  it('格式域与业务域标签不同', () => {
    expect(FORMAT_PARAMETER_DOMAIN).toBe('format');
    expect(BUSINESS_NUMBER_DOMAIN).toBe('business');
    expect(FORMAT_PARAMETER_DOMAIN).not.toBe(BUSINESS_NUMBER_DOMAIN);
  });

  it('裸数字不是格式参数（没有域标签）', () => {
    expect(isFormatParameter(12)).toBe(false);
    expect(isFormatParameter('12pt')).toBe(false);
    expect(isFormatParameter(null)).toBe(false);
    expect(isFormatParameter({ domain: 'business', field: 'fontSizePt', value: 12 })).toBe(false);
  });

  it('校验成功的值就是带域标签的格式参数', () => {
    const result = validateFormatParameter('fontSizePt', 12);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parameter.domain).toBe(FORMAT_PARAMETER_DOMAIN);
      expect(isFormatParameter(result.parameter)).toBe(true);
    }
  });
});

describe('格式域自己的范围规则', () => {
  it('字号 12pt 合法（判据里的格式值）', () => {
    expect(validateFormatParameter('fontSizePt', 12).ok).toBe(true);
  });

  it('字号边界：1 合法、819 合法、0 与 820 被拒', () => {
    expect(validateFormatParameter('fontSizePt', 1).ok).toBe(true);
    expect(validateFormatParameter('fontSizePt', 819).ok).toBe(true);
    expect(validateFormatParameter('fontSizePt', 0).ok).toBe(false);
    expect(validateFormatParameter('fontSizePt', 820).ok).toBe(false);
  });

  it('倍数行距 1.5 合法（判据里的格式值），0 被拒', () => {
    expect(validateFormatParameter('lineSpacingMultiple', 1.5).ok).toBe(true);
    expect(validateFormatParameter('lineSpacingMultiple', 0).ok).toBe(false);
  });

  it('缩进 2 字合法（判据里的格式值），负数被拒', () => {
    expect(validateFormatParameter('indentChars', 2).ok).toBe(true);
    expect(validateFormatParameter('indentChars', -1).ok).toBe(false);
  });

  it('twips 类字段要求整数', () => {
    expect(validateFormatParameter('indentTwips', 1134).ok).toBe(true);
    expect(validateFormatParameter('indentTwips', 1134.5).ok).toBe(false);
  });

  it('非有限数一律拒绝', () => {
    expect(validateFormatParameter('fontSizePt', Number.NaN).ok).toBe(false);
    expect(validateFormatParameter('fontSizePt', Number.POSITIVE_INFINITY).ok).toBe(false);
  });

  it('失败结果也带格式域标签与原因', () => {
    const result = validateFormatParameter('fontSizePt', -5);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.domain).toBe(FORMAT_PARAMETER_DOMAIN);
      expect(result.reason).toContain('fontSizePt');
      expect(result.value).toBe(-5);
    }
  });

  it('全部字段都能被校验（无遗漏分支）', () => {
    expect(FORMAT_FIELDS.length).toBeGreaterThan(0);
    for (const field of FORMAT_FIELDS) {
      // 每个字段用一个必然越界的值验证"规则确实生效"。
      expect(validateFormatParameter(field, Number.MAX_SAFE_INTEGER).ok, field).toBe(false);
    }
  });

  it('requireFormatParameter：合法返回、非法抛 RangeError', () => {
    expect(requireFormatParameter('fontSizePt', 12).value).toBe(12);
    expect(() => requireFormatParameter('fontSizePt', 0)).toThrow(RangeError);
  });
});

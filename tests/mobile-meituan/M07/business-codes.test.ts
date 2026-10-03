/**
 * M07 业务结果码映射：**HTTP 成功 ≠ 业务成功**。
 *
 * 这是本包最要害的判据。用例分两层：
 * 1. 纯函数层：`classifySubmitResponse` 对传输 + 业务两段一起判定；
 * 2. 端到端层：把"HTTP 200 + 业务失败"喂给执行器，断言提交记录**不是**成功状态、
 *    也**不可以**声称订单已下达。
 */

import { describe, expect, it } from 'vitest';

import {
  ORDER_BUSINESS_CODE_TABLE,
  OrderSubmitError,
  businessFailureResponse,
  classifyBusinessCode,
  classifySubmitResponse,
  createOrderSubmitter,
  httpErrorResponse,
  networkErrorResult,
  okResponse,
  timeoutResult,
} from '../../../src/mobile-plugins/meituan/order-submit/index.js';
import { createScenario } from './support.js';

describe('M07 结果码分类（纯函数）', () => {
  it('HTTP 200 + 业务码 ok ⇒ success（唯一通向成功的组合）', () => {
    const classification = classifySubmitResponse(okResponse('MT-1'));
    expect(classification.kind).toBe('success');
    expect(classification.needsQuery).toBe(false);
  });

  it('HTTP 200 + 业务码 sold_out ⇒ business_failure（**不得报成功**）', () => {
    const classification = classifySubmitResponse(businessFailureResponse('sold_out'));
    expect(classification.kind).toBe('business_failure');
    expect(classification.needsQuery).toBe(false);
  });

  it('HTTP 200 + 空业务码 ⇒ unknown（不猜，尤其不猜成功）', () => {
    expect(classifySubmitResponse(businessFailureResponse('')).kind).toBe('unknown');
  });

  it('HTTP 200 + 未登记业务码 ⇒ unknown', () => {
    const classification = classifySubmitResponse(businessFailureResponse('some_new_code_from_platform'));
    expect(classification.kind).toBe('unknown');
    expect(classification.needsQuery).toBe(true);
  });

  it('HTTP 200 + duplicate_order ⇒ unknown（订单可能已存在，须查原单证实）', () => {
    const classification = classifySubmitResponse(businessFailureResponse('duplicate_order'));
    expect(classification.kind).toBe('unknown');
    expect(classification.needsQuery).toBe(true);
  });

  it('HTTP 500 即使业务码是 ok ⇒ unknown（服务端异常，结果不可知）', () => {
    expect(classifySubmitResponse(okResponse('MT-1', 'ok').transport === 'response' ? { transport: 'response', httpStatus: 500, businessCode: 'ok', providerOrderRef: null } : okResponse('MT-1')).kind).toBe('unknown');
  });

  it('HTTP 400 ⇒ business_failure', () => {
    expect(classifySubmitResponse(httpErrorResponse(400, 'bad_request')).kind).toBe('business_failure');
  });

  it('超时 / 网络错误 ⇒ unknown（可能已到平台，须查原单）', () => {
    expect(classifySubmitResponse(timeoutResult()).kind).toBe('unknown');
    expect(classifySubmitResponse(timeoutResult()).needsQuery).toBe(true);
    expect(classifySubmitResponse(networkErrorResult()).kind).toBe('unknown');
  });

  it('业务码表里没有任何"未登记码当成功"的默认（登记表本身可枚举）', () => {
    const codes = ORDER_BUSINESS_CODE_TABLE.map((entry) => entry.code);
    expect(codes).toContain('ok');
    expect(new Set(codes).size).toBe(codes.length);
    // 只有 ok 一个成功码；其余都是失败或未知。
    expect(ORDER_BUSINESS_CODE_TABLE.filter((entry) => entry.kind === 'success').map((entry) => entry.code)).toEqual(['ok']);
    expect(classifyBusinessCode('definitely_not_registered')).toBe('unknown');
  });
});

describe('M07 端到端：HTTP 成功但业务失败', () => {
  it('提交得到"HTTP 200 + price_changed" ⇒ 记录是 rejected，不是 submitted/成功', async () => {
    const scenario = createScenario({ respond: () => businessFailureResponse('price_changed') });
    const outcome = await scenario.submitter.submit({
      authorization: scenario.ref,
      idempotencyKey: scenario.key,
    });

    expect(outcome.record.state).toBe('rejected');
    expect(outcome.record.outcomeKind).toBe('business_failure');
    expect(outcome.record.httpStatus).toBe(200);
    expect(outcome.record.businessCode).toBe('price_changed');
    // 核心断言：不得被判成功
    expect(outcome.record.state).not.toBe('submitted');
    expect(scenario.submitter.describeExternalOutcome(scenario.key).placedClaimable).toBe(false);
    expect(() => scenario.submitter.assertOrderPlacedClaimable(scenario.key)).toThrowError(OrderSubmitError);
  });

  it('业务成功提交只到 submitted（受理），仍不可声称"已下单"；确认后才可', async () => {
    const scenario = createScenario();
    await scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key });
    expect(scenario.submitter.getRecord(scenario.key)?.state).toBe('submitted');
    expect(scenario.submitter.describeExternalOutcome(scenario.key).placedClaimable).toBe(false);
    await expect(async () => scenario.submitter.assertOrderPlacedClaimable(scenario.key)).rejects.toThrow();
  });
});

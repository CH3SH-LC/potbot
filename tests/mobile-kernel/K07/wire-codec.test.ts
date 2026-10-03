/**
 * K07 独立验证 ④：wire/领域边界换算（`wire-codec.ts`）。
 *
 * 依据：`contracts/mobile-v1/README.md` §"金额与时间编码（总协调裁决，2026-10-03）"。
 * 三条要被本文件咬住的性质：
 *   1. **精确**：wire 十进制字符串 → 整数最小单位**逐位解析**，不经过浮点
 *      （反例：`0.29 * 100 === 28.999999999999996`，本模块必须给出 29）；
 *   2. **fail-closed**：精度超出币种位数（或亚毫秒非零）**拒绝**，不四舍五入不截断；
 *      未知币种**拒绝**，不猜位数；
 *   3. **契约一致**：codec 输出的 wire 对象与静态 fixture 逐字段相等，
 *      并**交给真实的 `contracts/mobile-v1/validate.mjs`** 校验（exit 0），
 *      负例目录必须 exit 1——证明校验不是自证。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CURRENCY_MINOR_DIGITS,
  createTrustedReceipt,
  formatWireAmount,
  formatWireTimestamp,
  fromWireConfirmAction,
  fromWireExternalReceipt,
  minorDigitsOf,
  parseWireAmount,
  parseWireTimestamp,
  toWireConfirmAction,
  toWireExternalReceipt,
  type ConfirmAction,
  type ExternalReceipt,
} from '../../../apps/mobile-kernel/actions/index.js';
import { expectError } from './fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

// 契约里的两个正则在测试里**独立重写**，不 import 实现，避免"用实现自证实现"。
const CONTRACT_AMOUNT_RE = /^[0-9]+(\.[0-9]{1,4})?$/;
const CONTRACT_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

// ---------------------------------------------------------------------------
// 金额
// ---------------------------------------------------------------------------

describe('K07 边界 ①：金额 wire(十进制字符串) ⇄ 领域(整数最小单位)', () => {
  it('逐位精确解析：浮点写法会算错的量，本模块算对', () => {
    // 反例对照：这正是"禁止 parseFloat(str) * 100"的原因
    expect((0.29 as number) * 100).not.toBe(29);
    expect(parseWireAmount('0.29', 'CNY')).toBe(29);

    const cases: ReadonlyArray<readonly [string, number]> = [
      ['0', 0],
      ['1', 100],
      ['123', 12300],
      ['1.2', 120],
      ['1.20', 120],
      ['39.80', 3980],
      ['1.2000', 120],
      ['0.01', 1],
      ['0.10', 10],
      ['10.00', 1000],
    ];
    for (const [wire, minor] of cases) {
      expect(parseWireAmount(wire, 'CNY')).toBe(minor);
    }
  });

  it('格式化是定点、位数与币种一致，且与解析互为往返', () => {
    expect(formatWireAmount(3980, 'CNY')).toBe('39.80');
    expect(formatWireAmount(0, 'CNY')).toBe('0.00');
    expect(formatWireAmount(5, 'CNY')).toBe('0.05');
    expect(formatWireAmount(120, 'CNY')).toBe('1.20');

    for (const minor of [0, 1, 5, 99, 100, 3980, 1234567]) {
      const wire = formatWireAmount(minor, 'CNY');
      expect(wire).toMatch(CONTRACT_AMOUNT_RE);
      expect(parseWireAmount(wire, 'CNY')).toBe(minor);
    }
  });

  it('零小数位币种（JPY）与三位小数币种（BHD）各自正确', () => {
    expect(minorDigitsOf('JPY')).toBe(0);
    expect(parseWireAmount('12300', 'JPY')).toBe(12300);
    expect(formatWireAmount(12300, 'JPY')).toBe('12300');
    expect(formatWireAmount(12300, 'JPY')).toMatch(CONTRACT_AMOUNT_RE);

    expect(minorDigitsOf('BHD')).toBe(3);
    expect(parseWireAmount('1.234', 'BHD')).toBe(1234);
    expect(formatWireAmount(1234, 'BHD')).toBe('1.234');
  });

  it('精度超出币种位数：≥低位非零 ⇒ 拒绝（不四舍五入、不截断）', () => {
    // CNY 2 位，给到 4 位小数
    expectError(() => parseWireAmount('1.2345', 'CNY'), 'wire_amount_not_representable', 'amount');
    expectError(() => parseWireAmount('1.234', 'CNY'), 'wire_amount_not_representable', 'amount');
    // 低位全零是可以精确表示的，放行
    expect(parseWireAmount('1.2300', 'CNY')).toBe(123);
    // JPY 0 位，任何非零小数都不可表示
    expectError(() => parseWireAmount('1.5', 'JPY'), 'wire_amount_not_representable', 'amount');
    expect(parseWireAmount('1.0', 'JPY')).toBe(1);
  });

  it('形状非法 ⇒ wire_amount_invalid（不静默接受）', () => {
    const bad: ReadonlyArray<unknown> = [
      39.8,
      '',
      'abc',
      '1.',
      '.5',
      '-1',
      ' 1',
      '1.23456', // 5 位小数，超出契约 pattern 上限
      '01e3',
      '一',
      null,
      undefined,
    ];
    for (const wire of bad) {
      expectError(() => parseWireAmount(wire as never, 'CNY'), 'wire_amount_invalid', 'amount');
    }
  });

  it('未知币种 ⇒ 拒绝，不猜位数', () => {
    expectError(() => parseWireAmount('1', 'XYZ'), 'unsupported_currency', 'currency');
    expectError(() => minorDigitsOf('cny'), 'unsupported_currency', 'currency'); // 小写不是合法三字母大写
    expectError(() => minorDigitsOf('CN'), 'unsupported_currency', 'currency');
    expect(minorDigitsOf('CNY')).toBe(2);
    // 表里明确登记了这些（不是靠默认值兜底）
    expect(Object.isFrozen(CURRENCY_MINOR_DIGITS)).toBe(true);
    expect(CURRENCY_MINOR_DIGITS['XYZ']).toBeUndefined();
  });

  it('格式化拒绝非法领域值（负数 / 非整数 / NaN）', () => {
    expectError(() => formatWireAmount(-1, 'CNY'), 'wire_amount_invalid', 'amount');
    expectError(() => formatWireAmount(1.5, 'CNY'), 'wire_amount_invalid', 'amount');
    expectError(() => formatWireAmount(Number.NaN, 'CNY'), 'wire_amount_invalid', 'amount');
  });
});

// ---------------------------------------------------------------------------
// 时间戳
// ---------------------------------------------------------------------------

describe('K07 边界 ②：时间戳 wire(ISO-8601) ⇄ 领域(注入时钟整数毫秒)', () => {
  it('解析为整数毫秒（与契约口径一致），且与格式化互为往返', () => {
    expect(parseWireTimestamp('2026-10-03T00:00:00.000Z')).toBe(1_790_985_600_000);
    expect(parseWireTimestamp('1970-01-01T00:00:00Z')).toBe(0);
    expect(parseWireTimestamp('2026-10-03T00:00:05.500Z')).toBe(1_790_985_605_500);

    for (const iso of [
      '2026-10-03T00:00:00.000Z',
      '2026-10-03T00:00:05.123Z',
      '1999-12-31T23:59:59.999Z',
    ]) {
      const epoch = parseWireTimestamp(iso);
      expect(Number.isInteger(epoch)).toBe(true);
      expect(formatWireTimestamp(epoch)).toBe(iso);
    }
    expect(formatWireTimestamp(0)).toMatch(CONTRACT_TIMESTAMP_RE);
  });

  it('亚毫秒位非零 ⇒ 拒绝（不截断）；低位全零可精确表示', () => {
    expectError(
      () => parseWireTimestamp('2026-10-03T00:00:00.123456Z'),
      'wire_timestamp_not_representable',
      'expiresAt',
    );
    // .123000 的低 3 位是 0 ⇒ 可精确表示
    expect(parseWireTimestamp('2026-10-03T00:00:00.123000Z')).toBe(
      parseWireTimestamp('2026-10-03T00:00:00.123Z'),
    );
    expect(parseWireTimestamp('2026-10-03T00:00:00.5Z')).toBe(
      parseWireTimestamp('2026-10-03T00:00:00.500Z'),
    );
  });

  it('非法日历时刻 / 形状 ⇒ wire_timestamp_invalid', () => {
    const bad: ReadonlyArray<unknown> = [
      '2026-02-30T00:00:00Z', // 2 月没有 30 日
      '2026-13-01T00:00:00Z', // 13 月
      '2026-10-03', // 缺时间
      '2026-10-03T00:00:00', // 缺 Z
      '2026-10-03T00:00:00+08:00', // 非 UTC
      'not-a-date',
      '',
      1_790_985_600_000, // 数字不是 wire 形态
      null,
    ];
    for (const iso of bad) {
      expectError(() => parseWireTimestamp(iso as never), 'wire_timestamp_invalid', 'expiresAt');
    }
  });

  it('格式化拒绝非法领域值', () => {
    expectError(() => formatWireTimestamp(1.5), 'wire_timestamp_invalid', 'expiresAt');
    expectError(() => formatWireTimestamp(Number.NaN), 'wire_timestamp_invalid', 'expiresAt');
    expectError(() => formatWireTimestamp('x' as never), 'wire_timestamp_invalid', 'expiresAt');
  });
});

// ---------------------------------------------------------------------------
// 对象级 + 真实契约校验器
// ---------------------------------------------------------------------------

describe('K07 边界 ③：对象级 wire 形态与真实契约校验器', () => {
  const sampleConfirm: ConfirmAction = Object.freeze({
    taskId: 'task:wire-1',
    actionId: 'act-wire-1',
    accountRef: 'acct:meituan:7788',
    taskRevision: 7,
    paramsDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    quoteRef: 'quote:mt-001',
    amount: 3980,
    currency: 'CNY',
    scope: 'purchase',
    expiresAt: 1_790_985_600_000,
  });

  it('toWireConfirmAction 输出与静态 fixture 逐字段相等，并满足契约正则', () => {
    const wire = toWireConfirmAction(sampleConfirm);
    const fixture = JSON.parse(
      readFileSync(join(HERE, 'wire-fixtures', 'confirm-action.json'), 'utf8'),
    ) as { value: unknown };
    expect(wire).toEqual(fixture.value);
    expect(wire.amount).toMatch(CONTRACT_AMOUNT_RE);
    expect(wire.expiresAt).toMatch(CONTRACT_TIMESTAMP_RE);
    expect(Object.isFrozen(wire)).toBe(true);
  });

  it('ConfirmAction wire ⇄ 领域全往返无损失（编码字段 + 回程身份）', () => {
    // K-I28 后的口径：wire 边界只负责编码字段（金额、期限）；任务身份 `taskId`
    // **不经 wire**，由调用方在回程显式传入（原因见下一个用例与 wire-codec.ts 头注）。
    const roundTrip = fromWireConfirmAction(toWireConfirmAction(sampleConfirm), sampleConfirm.taskId);
    expect(roundTrip).toEqual(sampleConfirm);
    expect(roundTrip.amount).toBe(3980);
    expect(roundTrip.expiresAt).toBe(1_790_985_600_000);
  });

  it('wire 层不承载 taskId；任务身份在回程由调用方提供（K-I28 口径）', () => {
    const wire = toWireConfirmAction(sampleConfirm);
    // wire 形状仍不含 taskId：契约 confirm-action.schema.json 是 additionalProperties:false
    // 且 required 无 taskId——写进去会被冻结契约判为"不允许的字段"（K-I15 已实测）。
    expect(Object.prototype.hasOwnProperty.call(wire, 'taskId')).toBe(false);

    // 回程**未传**身份 ⇒ 空串（不猜任务）；空串会被账本 requireText 当场拒，不静默通过。
    const defaulted = fromWireConfirmAction(wire);
    expect(Object.prototype.hasOwnProperty.call(defaulted, 'taskId')).toBe(true);
    expect(defaulted.taskId).toBe('');

    // 回程**显式传入**身份 ⇒ 原样携带，编码字段不变。
    const identified = fromWireConfirmAction(wire, 'task:wire-1');
    expect(identified.taskId).toBe('task:wire-1');
    expect(identified.amount).toBe(3980);
    expect(identified.expiresAt).toBe(1_790_985_600_000);
  });

  it('toWireExternalReceipt 把领域 detail 收进 metadata（契约根对象无顶层 detail）', () => {
    const receipt: ExternalReceipt = createTrustedReceipt({
      actionId: 'act-wire-1',
      provider: 'meituan',
      requestRef: 'sub:act-wire-1',
      externalId: 'MT-2026-0001',
      observedState: 'confirmed',
      observedAt: 1_790_985_605_000,
      evidenceRef: 'evidence://meituan/MT-2026-0001',
      verificationMode: 'real',
      detail: '商家已接单',
    });
    const wire = toWireExternalReceipt(receipt);
    const fixture = JSON.parse(
      readFileSync(join(HERE, 'wire-fixtures', 'external-receipt.json'), 'utf8'),
    ) as { value: unknown };
    expect(wire).toEqual(fixture.value);
    expect(wire).not.toHaveProperty('detail'); // 顶层 detail 会被契约 additionalProperties:false 拒
    expect(wire.metadata?.detail).toBe('商家已接单');
    expect(wire.observedAt).toMatch(CONTRACT_TIMESTAMP_RE);

    const back = fromWireExternalReceipt(wire);
    expect(back.observedAt).toBe(1_790_985_605_000);
    expect(back.detail).toBe('商家已接单');
    expect(back.observedState).toBe('confirmed');
  });

  it('fromWireExternalReceipt 校验词表：非法 observedState / verificationMode ⇒ untrusted_receipt', () => {
    const base = {
      actionId: 'a',
      provider: 'meituan',
      requestRef: 'r',
      externalId: 'e',
      observedState: 'confirmed',
      observedAt: '2026-10-03T00:00:00.000Z',
      evidenceRef: 'evidence://x',
      verificationMode: 'real',
    };
    expectError(
      () => fromWireExternalReceipt({ ...base, observedState: 'done' } as never),
      'untrusted_receipt',
    );
    expectError(
      () => fromWireExternalReceipt({ ...base, verificationMode: 'sandbox' } as never),
      'untrusted_receipt',
    );
  });

  it('真实校验器：codec 输出的正例目录 exit 0，负例目录 exit 1（反向对照）', () => {
    const run = (dir: string): { status: number; stdout: string } => {
      try {
        const stdout = execFileSync(process.execPath, ['contracts/mobile-v1/validate.mjs', dir], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
        });
        return { status: 0, stdout };
      } catch (error) {
        const err = error as { status?: number; stdout?: string };
        return { status: err.status ?? -1, stdout: err.stdout ?? '' };
      }
    };

    const positive = run('tests/mobile-kernel/K07/wire-fixtures');
    expect(positive.status).toBe(0);
    expect(positive.stdout).toContain('2 PASS, 0 FAIL');

    const negative = run('tests/mobile-kernel/K07/wire-fixtures-negative');
    expect(negative.status).toBe(1);
    expect(negative.stdout).toContain('FAIL');
    expect(negative.stdout).toContain('0 PASS');
  });
});

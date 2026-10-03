/**
 * M-I22 §3：**M04 报价金额 → M06 确认金额 → K07 确认动作 wire** 这条真实链上，
 * 金额只被换算一次，且 wire 形态属冻结契约。
 *
 * 这条链的意图（见 `.task-manifest/.../findings-M.json` 的 M04 integrationRequest）：
 * M06 / M07 应消费 `cart.minorUnitsToWireAmount()` 产出 confirm-action 的 `amount`
 * 十进制串，而不是各自手搓元/分换算。本文件把 M06 的领域金额喂进 K07 的 wire 边界，
 * 断言 wire 串与 M04 的换算**逐字符相同**，并与契约正则相符。
 *
 * 全部用 fixture（注入时钟 + 注入计价端口），不接真实平台、不发网络。
 */

import { describe, expect, it } from 'vitest';

import { type ConfirmAction, fromWireConfirmAction, toWireConfirmAction } from '../../../apps/mobile-kernel/actions/index.js';
import { minorUnitsToWireAmount, wireAmountToMinorUnits } from '../../../src/mobile-plugins/meituan/cart/index.js';
import {
  STANDARD_ADDRESS,
  STANDARD_CEILING,
  STANDARD_TIME_SLOT,
  buildPurchaseConfirmationViewModel,
  type PurchaseConfirmationInputs,
} from '../../../src/mobile-plugins/meituan/purchase-confirmation/index.js';
import { ACTION_ID, ACCOUNT_REF, CONFIRM_EXPIRES, TASK_REVISION, fixtureQuote, loadConfirmActionSchema, loadWirePatterns } from './support.js';

async function buildViewModel() {
  const quote = await fixtureQuote('CNY');
  const inputs: PurchaseConfirmationInputs = {
    actionId: ACTION_ID,
    contractAction: 'submit-order',
    quote,
    merchantName: '示例餐厅',
    address: STANDARD_ADDRESS,
    timeSlot: STANDARD_TIME_SLOT,
    scope: 'submit-order',
    accountRef: ACCOUNT_REF,
    taskRevision: TASK_REVISION,
    ceiling: STANDARD_CEILING,
    expiresAt: CONFIRM_EXPIRES,
  };
  return { quote, viewModel: buildPurchaseConfirmationViewModel(inputs) };
}

describe('M-I22 §3 M04 报价金额（领域整数最小单位）', () => {
  it('报价最终价是整数最小单位，且本地只做整数核对', async () => {
    const { quote } = await buildViewModel();
    // 面条 3800×2 + 茶 800×1 + 打包 100 + 配送 300 = 8800 分。
    expect(quote.amount).toBe(8800);
    expect(Number.isInteger(quote.amount)).toBe(true);
    const fees = quote.fees.reduce((sum, fee) => sum + fee.amountMinor, 0);
    const discounts = quote.discounts.reduce((sum, discount) => sum + discount.amountMinor, 0);
    expect(quote.subtotalMinor + fees - discounts).toBe(quote.amount);
  });

  it('报价金额 → wire 走 M04 边界函数，往返精确', async () => {
    const { quote } = await buildViewModel();
    const wire = minorUnitsToWireAmount(quote.amount, quote.currency);
    expect(wire).toBe('88.00');
    expect(wireAmountToMinorUnits(wire, quote.currency)).toBe(quote.amount);
    expect(loadWirePatterns().amount.test(wire)).toBe(true);
  });
});

describe('M-I22 §3 M06 确认金额转发（不重算）', () => {
  it('确认 ViewModel 的总费用与报价最终价**逐分相等**（本地不重算）', async () => {
    const { quote, viewModel } = await buildViewModel();
    expect(viewModel.amounts.totalMinor).toBe(quote.amount);
    expect(viewModel.amounts.currency).toBe(quote.currency);
    expect(Number.isInteger(viewModel.amounts.totalMinor)).toBe(true);
    // 展示串同样是 M04 换算的产物（币种感知），不是另一套格式化。
    expect(viewModel.amounts.formattedTotal).toBe(`${minorUnitsToWireAmount(quote.amount, quote.currency)} CNY`);
    expect(viewModel.amounts.formattedTotal).toBe('88.00 CNY');
  });
});

describe('M-I22 §3 确认动作 → wire（换算恰好一次）', () => {
  it('K07 领域 ConfirmAction（amount=整数分）→ wire 的 amount 与 M04 换算一致', async () => {
    const { viewModel } = await buildViewModel();
    const confirm: ConfirmAction = {
      taskId: 'task-m-i22',
      actionId: viewModel.actionId,
      accountRef: ACCOUNT_REF,
      taskRevision: TASK_REVISION,
      paramsDigest: viewModel.paramsDigest,
      quoteRef: viewModel.quoteRef,
      amount: viewModel.amounts.totalMinor,
      currency: viewModel.amounts.currency,
      scope: viewModel.scope,
      expiresAt: viewModel.expiresAt,
    };

    const wire = toWireConfirmAction(confirm);

    // 恰好换算一次：wire 不是 '176.00'（重复乘 100）也不是 '0.88'（错位）。
    expect(wire.amount).toBe('88.00');
    expect(wire.amount).toBe(minorUnitsToWireAmount(confirm.amount, confirm.currency));
    expect(loadWirePatterns().amount.test(wire.amount)).toBe(true);
    expect(loadWirePatterns().currency.test(wire.currency)).toBe(true);

    // 反解回同一整数（无精度损失、无二次换算）。
    const back = fromWireConfirmAction(wire);
    expect(back.amount).toBe(confirm.amount);
    expect(back.amount).toBe(viewModel.amounts.totalMinor);
    expect(back.currency).toBe(confirm.currency);
    expect(back.expiresAt).toBe(confirm.expiresAt);
  });

  it('wire 对象键集合符合契约：必需键齐全、无契约未允许的键（additionalProperties=false）', async () => {
    const { viewModel } = await buildViewModel();
    const confirm: ConfirmAction = {
      taskId: 'task-m-i22',
      actionId: viewModel.actionId,
      accountRef: ACCOUNT_REF,
      taskRevision: TASK_REVISION,
      paramsDigest: viewModel.paramsDigest,
      quoteRef: viewModel.quoteRef,
      amount: viewModel.amounts.totalMinor,
      currency: viewModel.amounts.currency,
      scope: viewModel.scope,
      expiresAt: viewModel.expiresAt,
    };
    const wire = toWireConfirmAction(confirm) as unknown as Record<string, unknown>;
    const schema = loadConfirmActionSchema();
    const allowed = new Set(Object.keys(schema.properties));

    for (const required of schema.required) {
      expect(Object.prototype.hasOwnProperty.call(wire, required), `wire 缺少必需键 ${required}`).toBe(true);
    }
    for (const key of Object.keys(wire)) {
      expect(allowed.has(key), `wire 出现契约未允许的键 ${key}`).toBe(true);
    }
    // scope 取值必须落在契约 enum 内。
    expect(schema.$defs.scope.enum).toContain(wire['scope']);
    // 时间戳形状（expiresAt 走 ISO-8601 wire 形态）。
    expect(loadWirePatterns().timestamp.test(String(wire['expiresAt']))).toBe(true);
  });

  it('不同币种下这条链同样成立（JPY 0 位 / KWD 3 位）', async () => {
    for (const currency of ['JPY', 'KWD'] as const) {
      const quote = await fixtureQuote(currency);
      const confirm: ConfirmAction = {
        taskId: 'task-m-i22',
        actionId: ACTION_ID,
        accountRef: ACCOUNT_REF,
        taskRevision: TASK_REVISION,
        paramsDigest: `sha256:${'a'.repeat(64)}`,
        quoteRef: quote.quoteRef,
        amount: quote.amount,
        currency,
        scope: 'submit-order',
        expiresAt: CONFIRM_EXPIRES,
      };
      const wire = toWireConfirmAction(confirm);
      expect(wire.amount, `${currency}`).toBe(minorUnitsToWireAmount(quote.amount, currency));
      expect(loadWirePatterns().amount.test(wire.amount), `${currency}`).toBe(true);
      expect(fromWireConfirmAction(wire).amount).toBe(quote.amount);
      if (currency === 'JPY') {
        expect(wire.amount).not.toContain('.');
      } else {
        expect(wire.amount.split('.')[1]?.length).toBe(3);
      }
    }
  });
});

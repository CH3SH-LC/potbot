/**
 * M04 边界与购买保护（**静态扫描 + 导出面检查**）。
 *
 * 本包不接真实平台、不下单、不支付。这些约束不能只写在注释里——
 * 这里用源码扫描把「零依赖」「不读系统时间」「没有下单/支付入口」变成可回归的断言。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as cart from '../../../src/mobile-plugins/meituan/cart/index.js';
import { CartSession } from '../../../src/mobile-plugins/meituan/cart/index.js';
import { createScenario, fillStandardCart } from './support.js';

const CART_DIR = fileURLToPath(new URL('../../../src/mobile-plugins/meituan/cart/', import.meta.url));

function cartSources(): readonly { readonly file: string; readonly text: string }[] {
  return readdirSync(CART_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ file: name, text: readFileSync(join(CART_DIR, name), 'utf8') }));
}

/**
 * 下单 / 支付类能力的命名特征。
 *
 * 先按驼峰切成词再逐词比对，避免「Payload 里含 pay」这种误伤。
 */
const FORBIDDEN_WORDS = new Set([
  'submit',
  'place',
  'checkout',
  'pay',
  'payment',
  'purchase',
  'order',
  'buy',
]);

function wordsOf(name: string): readonly string[] {
  return name
    .split(/[^A-Za-z0-9]+|(?=[A-Z])/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

function forbiddenWordIn(name: string): string | undefined {
  return wordsOf(name).find((word) => FORBIDDEN_WORDS.has(word));
}

/** 墙钟、随机、环境与定时器：本包一律不得使用（时间只能来自注入时钟）。 */
const FORBIDDEN_AMBIENT: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /Date\.now/, why: '不得读系统时间' },
  { pattern: /new Date\(/, why: '不得构造墙钟时间' },
  { pattern: /performance\.now/, why: '不得读系统时间' },
  { pattern: /Math\.random/, why: '不得引入随机性（会破坏可重现）' },
  { pattern: /process\.env/, why: '不得依赖环境变量' },
  { pattern: /setTimeout\(/, why: '不得自行推进时间' },
  { pattern: /setInterval\(/, why: '不得自行推进时间' },
];

describe('M04 边界：不新增下单/支付能力', () => {
  it('模块导出里没有提交订单 / 支付类符号', () => {
    const exportedFunctions = Object.entries(cart).filter(([, value]) => typeof value === 'function');
    expect(exportedFunctions.length).toBeGreaterThan(0);
    for (const [name] of exportedFunctions) {
      expect(forbiddenWordIn(name), `导出符号 ${name} 像下单/支付能力`).toBeUndefined();
    }
  });

  it('会话类的方法里没有下单 / 支付入口', () => {
    const methods = Object.getOwnPropertyNames(CartSession.prototype);
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      expect(forbiddenWordIn(method), `方法 ${method} 像下单/支付能力`).toBeUndefined();
    }
  });

  it('购买边界常量如实声明：不提交、不支付、不接真实平台', () => {
    expect(cart.CART_PURCHASE_BOUNDARY.canSubmitOrder).toBe(false);
    expect(cart.CART_PURCHASE_BOUNDARY.canPay).toBe(false);
    expect(cart.CART_PURCHASE_BOUNDARY.connectsRealPlatform).toBe(false);
    expect(Object.isFrozen(cart.CART_PURCHASE_BOUNDARY)).toBe(true);
  });

  it('报价与本地草稿都不自称权威（不能拿它们当订单/确认）', async () => {
    const scenario = createScenario();
    fillStandardCart(scenario.session);
    const quote = await scenario.session.requestQuote();

    expect(quote.isOrderTotal).toBe(false);
    expect(scenario.session.createConfirmationDraft(quote).authoritative).toBe(false);
  });
});

describe('M04 边界：零依赖与不读环境', () => {
  it('模块只做内部相对导入（不引外部包、不读文件系统）', () => {
    const files = cartSources();
    expect(files.map((entry) => entry.file).sort()).toEqual([
      'cart.ts',
      'digest.ts',
      'errors.ts',
      'fixture.ts',
      'index.ts',
      'money.ts',
      'session.ts',
      'specs.ts',
      'types.ts',
    ]);
    for (const { file, text } of files) {
      const specifiers = [...text.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((match) => match[1] ?? '');
      for (const specifier of specifiers) {
        expect(specifier.startsWith('./'), `${file} 出现了非相对导入：${specifier}`).toBe(true);
      }
    }
  });

  it('模块不读系统时间、不使用随机数与环境变量', () => {
    for (const { file, text } of cartSources()) {
      for (const { pattern, why } of FORBIDDEN_AMBIENT) {
        expect(pattern.test(text), `${file} 命中 ${String(pattern)}（${why}）`).toBe(false);
      }
    }
  });

  it('金额只以整数最小单位出现（源码里没有浮点金额换算）', () => {
    for (const { file, text } of cartSources()) {
      expect(text.includes('toFixed'), `${file} 使用了 toFixed`).toBe(false);
      expect(/parseFloat|Number\(.*\)\s*\*\s*100|\*\s*100\s*\)/.test(text), `${file} 出现疑似元/分换算`).toBe(
        false,
      );
    }
  });
});

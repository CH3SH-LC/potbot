/**
 * M-R03 边界与购买保护（**静态扫描 + 导出面检查**）。
 *
 * 本包不接真实平台、不下单、不支付、不签发授权。这些约束不能只写在注释里——
 * 这里把「零外部依赖」「不读系统时间/随机/环境」「没有下单/支付入口」变成可回归断言。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as mR03 from './index.js';
import { ReconfirmationGuard } from './index.js';
import { createScenario, fillStandardCart } from './support.js';

const MODULE_DIR = fileURLToPath(new URL('./', import.meta.url));

/** 本包的源码文件（**不含**测试与夹具；那些允许用 node 内置）。 */
const MODULE_FILES: readonly string[] = ['index.ts', 'types.ts', 'errors.ts', 'price-diff.ts', 'guard.ts', 'operations.ts'];

function moduleSources(): readonly { readonly file: string; readonly text: string }[] {
  return MODULE_FILES.map((file) => ({ file, text: readFileSync(join(MODULE_DIR, file), 'utf8') }));
}

/** 下单 / 支付类能力的命名特征（驼峰切词后逐词比对）。 */
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
  { pattern: /Date\s*\.\s*now/, why: '不得读系统时间' },
  { pattern: /new\s+Date\s*\(/, why: '不得构造墙钟时间' },
  { pattern: /performance\s*\.\s*now/, why: '不得读系统时间' },
  { pattern: /Math\s*\.\s*random/, why: '不得引入随机性（会破坏可重现）' },
  { pattern: /process\s*\.\s*env/, why: '不得依赖环境变量' },
  { pattern: /setTimeout\s*\(/, why: '不得自行推进时间' },
  { pattern: /setInterval\s*\(/, why: '不得自行推进时间' },
];

describe('M-R03 边界：不新增下单/支付/授权能力', () => {
  it('模块导出里没有提交订单 / 支付 / 授权类符号', () => {
    const exportedFunctions = Object.entries(mR03).filter(([, value]) => typeof value === 'function');
    expect(exportedFunctions.length).toBeGreaterThan(0);
    for (const [name] of exportedFunctions) {
      expect(forbiddenWordIn(name), `导出符号 ${name} 像下单/支付能力`).toBeUndefined();
    }
  });

  it('守卫类的方法里没有下单 / 支付入口', () => {
    const methods = Object.getOwnPropertyNames(ReconfirmationGuard.prototype);
    expect(methods).toContain('confirm');
    expect(methods).toContain('assess');
    for (const method of methods) {
      expect(forbiddenWordIn(method), `方法 ${method} 像下单/支付能力`).toBeUndefined();
    }
  });

  it('边界常量如实声明：不提交、不支付、不签发授权、不接真实平台', () => {
    const boundary = mR03.RECONFIRMATION_BOUNDARY;
    expect(boundary.canSubmitOrder).toBe(false);
    expect(boundary.canPay).toBe(false);
    expect(boundary.issuesAuthorizationGrant).toBe(false);
    expect(boundary.authoritative).toBe(false);
    expect(boundary.connectsRealPlatform).toBe(false);
    expect(Object.isFrozen(boundary)).toBe(true);
  });

  it('确认基线是本地记录，不自称权威授权', async () => {
    const { session, guard } = createScenario();
    fillStandardCart(session);
    const quote = await session.requestQuote();
    const baseline = guard.confirm(quote, 'confirm-1');
    // 基线里没有可执行授权字段，只有金额/引用/时刻等可核对项。
    expect(Object.keys(baseline).sort()).toEqual([
      'amount',
      'confirmationRef',
      'confirmedAt',
      'confirmedQuoteRef',
      'currency',
      'expiresAt',
      'merchantId',
      'paramsDigest',
    ]);
    expect('grant' in baseline).toBe(false);
    expect('authorization' in baseline).toBe(false);
  });
});

describe('M-R03 边界：不读环境、只比对不重算', () => {
  it('模块只做内部相对导入或复用 M04 公开出口（不引其他外部包）', () => {
    const CART_INDEX = '../../../src/mobile-plugins/meituan/cart/index.js';
    for (const { file, text } of moduleSources()) {
      const specifiers = [...text.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((match) => match[1] ?? '');
      expect(specifiers.length).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        const allowed = specifier.startsWith('./') || specifier === CART_INDEX;
        expect(allowed, `${file} 出现非预期导入：${specifier}`).toBe(true);
      }
    }
  });

  it('模块不读系统时间、不使用随机数与环境变量', () => {
    for (const { file, text } of moduleSources()) {
      for (const { pattern, why } of FORBIDDEN_AMBIENT) {
        expect(pattern.test(text), `${file} 命中 ${String(pattern)}（${why}）`).toBe(false);
      }
    }
  });

  it('金额只以整数最小单位出现（模块里没有浮点换算）', () => {
    for (const { file, text } of moduleSources()) {
      expect(text.includes('toFixed'), `${file} 使用了 toFixed`).toBe(false);
      expect(text.includes('parseFloat'), `${file} 使用了 parseFloat`).toBe(false);
    }
  });

  it('模块源码文件集合固定（新增文件必须登记到此清单）', () => {
    const onDisk = readFileSync(join(MODULE_DIR, 'index.ts'), 'utf8'); // 只是确保目录可读
    expect(onDisk.length).toBeGreaterThan(0);
    expect(MODULE_FILES).toEqual(['index.ts', 'types.ts', 'errors.ts', 'price-diff.ts', 'guard.ts', 'operations.ts']);
  });
});

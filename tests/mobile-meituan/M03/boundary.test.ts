/**
 * M03 边界（**静态扫描 + 导出面检查**）。
 *
 * 本包不接真实平台、不下单、不支付、不读系统时间。这些约束不能只写在注释里——
 * 用源码扫描把「零外部依赖」「不读环境/墙钟/随机」「没有下单/支付入口」变成可回归断言。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as catalog from '../../../src/mobile-plugins/meituan/catalog/index.js';
import { CatalogService } from '../../../src/mobile-plugins/meituan/catalog/index.js';

const CATALOG_DIR = fileURLToPath(new URL('../../../src/mobile-plugins/meituan/catalog/', import.meta.url));

function catalogSources(): readonly { readonly file: string; readonly text: string }[] {
  return readdirSync(CATALOG_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ file: name, text: readFileSync(join(CATALOG_DIR, name), 'utf8') }));
}

/**
 * 下单 / 支付类能力的命名特征。
 *
 * 注意：本包合法使用 `minOrder`（起送金额）与「订单」无关，故不把 `order` 列入禁用词；
 * 真正要挡的是提交/结账/支付/购买动作。
 */
const FORBIDDEN_PURCHASE_WORDS = new Set([
  'submit',
  'place',
  'checkout',
  'pay',
  'payment',
  'purchase',
  'buy',
]);

function wordsOf(name: string): readonly string[] {
  return name
    .split(/[^A-Za-z0-9]+|(?=[A-Z])/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

function forbiddenWordIn(name: string): string | undefined {
  return wordsOf(name).find((word) => FORBIDDEN_PURCHASE_WORDS.has(word));
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

describe('M03 边界：不新增下单/支付能力', () => {
  it('模块导出里没有提交订单 / 支付类符号', () => {
    const exportedFunctions = Object.entries(catalog).filter(([, value]) => typeof value === 'function');
    expect(exportedFunctions.length).toBeGreaterThan(10);
    for (const [name] of exportedFunctions) {
      expect(forbiddenWordIn(name), `导出符号 ${name} 像下单/支付能力`).toBeUndefined();
    }
  });

  it('目录服务的方法里没有下单 / 支付入口', () => {
    const methods = Object.getOwnPropertyNames(CatalogService.prototype);
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      expect(forbiddenWordIn(method), `方法 ${method} 像下单/支付能力`).toBeUndefined();
    }
  });

  it('购买边界常量如实声明：不提交、不支付、不接真实平台、不合成未知、文本不作指令', () => {
    expect(catalog.CATALOG_PURCHASE_BOUNDARY.canSubmitOrder).toBe(false);
    expect(catalog.CATALOG_PURCHASE_BOUNDARY.canPay).toBe(false);
    expect(catalog.CATALOG_PURCHASE_BOUNDARY.connectsRealPlatform).toBe(false);
    expect(catalog.CATALOG_PURCHASE_BOUNDARY.synthesizesUnknowns).toBe(false);
    expect(catalog.CATALOG_PURCHASE_BOUNDARY.treatMerchantTextAsInstruction).toBe(false);
    expect(Object.isFrozen(catalog.CATALOG_PURCHASE_BOUNDARY)).toBe(true);
  });
});

describe('M03 边界：零外部依赖与不读环境', () => {
  it('模块只做内部相对导入（不引外部包、不读文件系统）', () => {
    const files = catalogSources();
    expect(files.map((entry) => entry.file).sort()).toEqual([
      'catalog.ts',
      'delivery.ts',
      'errors.ts',
      'fixture.ts',
      'hours.ts',
      'ids.ts',
      'index.ts',
      'known.ts',
      'pagination.ts',
      'provenance.ts',
      'types.ts',
      'untrusted.ts',
      'validate.ts',
    ]);
    for (const { file, text } of files) {
      const specifiers = [...text.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((match) => match[1] ?? '');
      for (const specifier of specifiers) {
        expect(specifier.startsWith('./'), `${file} 出现了非相对导入：${specifier}`).toBe(true);
      }
      expect(/require\(/.test(text), `${file} 出现 require(`).toBe(false);
      expect(text.includes('node:fs'), `${file} 引入 node:fs`).toBe(false);
    }
  });

  it('模块不读系统时间、不使用随机数与环境变量、不自行定时', () => {
    for (const { file, text } of catalogSources()) {
      for (const { pattern, why } of FORBIDDEN_AMBIENT) {
        expect(pattern.test(text), `${file} 命中 ${String(pattern)}（${why}）`).toBe(false);
      }
    }
  });
});

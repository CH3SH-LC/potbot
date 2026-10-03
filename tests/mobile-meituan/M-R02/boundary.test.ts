/**
 * M-R02 边界（**静态扫描 + 导出面检查**）。
 *
 * 美团真实能力未核实，本包必须保持「纯本地、无网络、无下单、无支付、不读环境」。
 * 这些约束靠源码扫描变成可回归断言，而不是只写在注释里。
 *
 * 注意：本包**合法地**处理「起送金额」（含 Order 一词），因此不能照搬 M04 那种
 * 「导出名一律不得含 order」的朴素扫描——这里改成**动词前缀**扫描，只禁真正的下单/支付能力。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as mR02 from './index.js';

const M_R02_DIR = fileURLToPath(new URL('./', import.meta.url));

const EXPECTED_FILES = [
  'errors.ts',
  'fixture.ts',
  'fulfillment.ts',
  'index.ts',
  'preflight.ts',
  'schemas.ts',
  'specs.ts',
  'stock.ts',
  'types.ts',
];

function moduleSources(): readonly { readonly file: string; readonly text: string }[] {
  return readdirSync(M_R02_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'support.ts')
    .map((name) => ({ file: name, text: readFileSync(join(M_R02_DIR, name), 'utf8') }));
}

/** 下单 / 支付动词前缀：只禁「真的会外部产生副作用」的命名。 */
const FORBIDDEN_PREFIXES = ['submit', 'place', 'pay', 'checkout', 'purchase', 'buy', 'createOrder'];

function looksLikePurchase(name: string): boolean {
  const lower = name.toLowerCase();
  return FORBIDDEN_PREFIXES.some((prefix) => lower.startsWith(prefix.toLowerCase()));
}

/** 环境/时间/随机：本包一律不得使用。 */
const FORBIDDEN_AMBIENT: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /Date\.now/, why: '不得读系统时间' },
  { pattern: /new Date\(/, why: '不得构造墙钟时间' },
  { pattern: /performance\.now/, why: '不得读系统时间' },
  { pattern: /Math\.random/, why: '不得引入随机性' },
  { pattern: /process\.env/, why: '不得依赖环境变量' },
  { pattern: /setTimeout\(/, why: '不得自行推进时间' },
  { pattern: /setInterval\(/, why: '不得自行推进时间' },
  { pattern: /\bfetch\(/, why: '不得发起网络请求' },
  { pattern: /require\(/, why: '不得使用 CommonJS require' },
];

describe('M-R02 边界：文件构成与导入面', () => {
  it('源码文件构成与本包范围一致', () => {
    expect(moduleSources().map((entry) => entry.file).sort()).toEqual(EXPECTED_FILES);
  });

  it('所有源码只做相对导入（不引外部包、不引 HTTP 客户端）', () => {
    for (const { file, text } of moduleSources()) {
      const specifiers = [...text.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((match) => match[1] ?? '');
      for (const specifier of specifiers) {
        expect(specifier.startsWith('./'), `${file} 出现非相对导入：${specifier}`).toBe(true);
      }
    }
  });

  it('不读系统时间、不用随机、不读环境变量、不发网络请求', () => {
    for (const { file, text } of moduleSources()) {
      for (const { pattern, why } of FORBIDDEN_AMBIENT) {
        expect(pattern.test(text), `${file} 命中 ${String(pattern)}（${why}）`).toBe(false);
      }
    }
  });
});

describe('M-R02 边界：导出面没有下单/支付能力', () => {
  it('导出的函数里没有下单/支付动词前缀', () => {
    const exported = Object.entries(mR02).filter(([, value]) => typeof value === 'function');
    expect(exported.length).toBeGreaterThan(0);
    for (const [name] of exported) {
      expect(looksLikePurchase(name), `导出符号 ${name} 像下单/支付能力`).toBe(false);
    }
  });

  it('购买边界常量如实声明', () => {
    expect(mR02.CATALOG_PREFLIGHT_BOUNDARY.canSubmitOrder).toBe(false);
    expect(mR02.CATALOG_PREFLIGHT_BOUNDARY.canPay).toBe(false);
    expect(mR02.CATALOG_PREFLIGHT_BOUNDARY.connectsRealPlatform).toBe(false);
    expect(mR02.CATALOG_PREFLIGHT_BOUNDARY.holdsPrices).toBe(false);
    expect(mR02.CATALOG_PREFLIGHT_BOUNDARY.mode).toBe('fixture');
    expect(Object.isFrozen(mR02.CATALOG_PREFLIGHT_BOUNDARY)).toBe(true);
  });

  it('验证模式标记为 fixture，不是真实平台', () => {
    expect(mR02.M_R02_VERIFICATION_MODE).toBe('fixture');
  });
});

describe('M-R02 边界：金额口径', () => {
  it('源码里没有浮点金额换算（toFixed / 元分转换）', () => {
    for (const { file, text } of moduleSources()) {
      expect(text.includes('toFixed'), `${file} 使用了 toFixed`).toBe(false);
    }
  });
});

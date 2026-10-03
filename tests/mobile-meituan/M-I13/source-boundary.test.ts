/**
 * M-I13 边界（**生产源码静态扫描**）。
 *
 * 提升到生产后仍必须保持「纯本地、无网络、无下单、无支付、不读环境/时间/随机」。
 * 扫描对象是 `src/mobile-plugins/meituan/spec-preflight/`（生产目录），
 * 而不是测试树——把边界约束钉在生产源上。
 *
 * 本包**合法地**处理「起送金额」（含 Order 一词），故只禁真正的下单/支付**动词前缀**，
 * 不照搬 M04 那种「导出名一律不得含 order」的朴素扫描。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as prod from '../../../src/mobile-plugins/meituan/spec-preflight/index.js';

const PROD_DIR = fileURLToPath(new URL('../../../src/mobile-plugins/meituan/spec-preflight/', import.meta.url));

/** 生产目录应有的文件构成：8 个源码文件，无 fixture、无测试。 */
const EXPECTED_FILES = [
  'errors.ts',
  'fulfillment.ts',
  'index.ts',
  'preflight.ts',
  'schemas.ts',
  'specs.ts',
  'stock.ts',
  'types.ts',
];

function moduleSources(): readonly { readonly file: string; readonly text: string }[] {
  return readdirSync(PROD_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ file: name, text: readFileSync(join(PROD_DIR, name), 'utf8') }));
}

const FORBIDDEN_PREFIXES = ['submit', 'place', 'pay', 'checkout', 'purchase', 'buy', 'createOrder'];

function looksLikePurchase(name: string): boolean {
  const lower = name.toLowerCase();
  return FORBIDDEN_PREFIXES.some((prefix) => lower.startsWith(prefix.toLowerCase()));
}

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

describe('M-I13 生产边界：文件构成与导入面', () => {
  it('生产源码文件构成与本包范围一致（无 fixture、无测试）', () => {
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

  it('没有浮点金额换算（toFixed / 元分转换）', () => {
    for (const { file, text } of moduleSources()) {
      expect(text.includes('toFixed'), `${file} 使用了 toFixed`).toBe(false);
    }
  });
});

describe('M-I13 生产边界：出口没有下单/支付能力', () => {
  it('导出的函数里没有下单/支付动词前缀', () => {
    const exported = Object.entries(prod).filter(([, value]) => typeof value === 'function');
    expect(exported.length).toBeGreaterThan(0);
    for (const [name] of exported) {
      expect(looksLikePurchase(name), `导出符号 ${name} 像下单/支付能力`).toBe(false);
    }
  });

  it('验证模式标记为 fixture，不是真实平台', () => {
    expect(prod.M_R02_VERIFICATION_MODE).toBe('fixture');
  });
});

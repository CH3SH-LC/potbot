/**
 * M09 边界与购买保护（**静态扫描 + 导出面检查**）。
 *
 * 本包不接真实平台、不下单、不支付、不发起真实退款。这些约束不能只写在注释里——
 * 这里用源码扫描把「零依赖」「不读系统时间」「没有下单/支付/退款提交入口」
 * 变成可回归的断言。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as lifecycle from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import { OrderLifecycleTracker } from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import { makeIntent, makeResult } from './support.js';

const PACKAGE_DIR = fileURLToPath(
  new URL('../../../src/mobile-plugins/meituan/order-lifecycle/', import.meta.url),
);

function packageSources(): readonly { readonly file: string; readonly text: string }[] {
  return readdirSync(PACKAGE_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ file: name, text: readFileSync(join(PACKAGE_DIR, name), 'utf8') }));
}

/**
 * 下单 / 支付 / 退款提交类能力的命名特征。
 *
 * 先按驼峰切成词再逐词比对，避免「Payload 里含 pay」这种误伤。
 * 注意：**不含 `order`**——本包本身就是订单生命周期视图，`order` 是领域名词；
 * 要拦的是「提交/发起」这类**动作**。
 */
const FORBIDDEN_WORDS = new Set(['submit', 'place', 'checkout', 'purchase', 'buy', 'pay', 'payment']);

function wordsOf(name: string): readonly string[] {
  return name
    .split(/[^A-Za-z0-9]+|(?=[A-Z])/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

function forbiddenWordIn(name: string): string | undefined {
  return wordsOf(name).find((word) => FORBIDDEN_WORDS.has(word));
}

/** 墙钟、随机、环境与定时器：本包一律不得使用。 */
const FORBIDDEN_AMBIENT: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /Date\.now/, why: '不得读系统时间' },
  { pattern: /new Date\(/, why: '不得构造墙钟时间' },
  { pattern: /performance\.now/, why: '不得读系统时间' },
  { pattern: /Math\.random/, why: '不得引入随机性（会破坏可重现）' },
  { pattern: /process\.env/, why: '不得依赖环境变量' },
  { pattern: /setTimeout\(/, why: '不得自行推进时间' },
  { pattern: /setInterval\(/, why: '不得自行推进时间' },
];

describe('M09 边界：不新增下单/支付/退款提交能力', () => {
  it('模块导出里没有提交订单 / 支付类符号', () => {
    const exportedFunctions = Object.entries(lifecycle).filter(([, value]) => typeof value === 'function');
    expect(exportedFunctions.length).toBeGreaterThan(0);
    for (const [name] of exportedFunctions) {
      expect(forbiddenWordIn(name), `导出符号 ${name} 像下单/支付能力`).toBeUndefined();
    }
  });

  it('跟踪器的方法里没有下单 / 支付入口', () => {
    const methods = Object.getOwnPropertyNames(OrderLifecycleTracker.prototype);
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      expect(forbiddenWordIn(method), `方法 ${method} 像下单/支付能力`).toBeUndefined();
    }
  });

  it('边界常量如实声明：不提交、不支付、不发起退款、不接真实平台、不合并成一个 ok', () => {
    const boundary = lifecycle.ORDER_LIFECYCLE_BOUNDARY;
    expect(boundary.canSubmitOrder).toBe(false);
    expect(boundary.canPay).toBe(false);
    expect(boundary.canRequestRefund).toBe(false);
    expect(boundary.connectsRealPlatform).toBe(false);
    expect(boundary.mergesStagesIntoSingleOk).toBe(false);
    expect(Object.isFrozen(boundary)).toBe(true);
  });

  it('跟踪器实例上没有任何下单/支付方法可用', () => {
    const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
    const own = new Set(Object.getOwnPropertyNames(tracker));
    for (const name of ['submitOrder', 'placeOrder', 'pay', 'submitRefund', 'requestRefund']) {
      expect(own.has(name), `跟踪器实例上出现了 ${name}`).toBe(false);
      expect((tracker as unknown as Record<string, unknown>)[name], `跟踪器实例上出现了 ${name}`).toBeUndefined();
    }
  });
});

describe('M09 边界：零依赖与不读环境', () => {
  it('包目录的源码文件清单固定（新增/删除都应被看见）', () => {
    const files = packageSources();
    expect(files.map((entry) => entry.file).sort()).toEqual([
      'errors.ts',
      'fixture.ts',
      'index.ts',
      'lifecycle.ts',
      'match.ts',
      'money.ts',
      'persistence.ts',
      'status-map.ts',
      'transitions.ts',
      'types.ts',
    ]);
  });

  it('模块只做包内相对导入（不引外部包、不跨包、不读文件系统）', () => {
    for (const { file, text } of packageSources()) {
      const specifiers = [...text.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((match) => match[1] ?? '');
      for (const specifier of specifiers) {
        expect(specifier.startsWith('./'), `${file} 出现了非包内相对导入：${specifier}`).toBe(true);
      }
      expect(text.includes('node:'), `${file} 引用了 node 内建模块`).toBe(false);
      expect(text.includes('require('), `${file} 使用了 require`).toBe(false);
    }
  });

  it('模块不读系统时间、不使用随机数与环境变量', () => {
    for (const { file, text } of packageSources()) {
      for (const { pattern, why } of FORBIDDEN_AMBIENT) {
        expect(pattern.test(text), `${file} 命中 ${String(pattern)}（${why}）`).toBe(false);
      }
    }
  });

  it('金额只以整数最小单位出现（源码里没有元/分换算）', () => {
    for (const { file, text } of packageSources()) {
      expect(text.includes('toFixed'), `${file} 使用了 toFixed`).toBe(false);
      expect(/parseFloat|Math\.round/.test(text), `${file} 出现疑似金额取整/换算`).toBe(false);
    }
  });

  it('源码里没有裸控制字节的转义写法混入（分隔符一律用可见字符）', () => {
    for (const { file, text } of packageSources()) {
      expect(/\\u000[0-9a-fA-F]/.test(text), `${file} 出现了控制字符转义`).toBe(false);
      expect(/\\x0[0-9a-fA-F]/.test(text), `${file} 出现了控制字符转义`).toBe(false);
    }
  });
});

describe('M09 边界：测试夹具本身没有假装真实平台', () => {
  it('fixture 端口如实声明「结果来自本地回放」', async () => {
    const port = lifecycle.createFixtureOrderQueryPort({ results: [makeResult()] });
    const result = await port.query({ externalId: 'x', accountRef: 'y', reason: 'poll' });
    // 回放的就是本地构造的结果：证据引用可追溯到 fixture。
    expect(result.evidenceRef).toBe('ev-ref-query-1');
    expect(port.calls.length).toBe(1);
    expect(Object.isFrozen(port.calls)).toBe(true);
  });
});

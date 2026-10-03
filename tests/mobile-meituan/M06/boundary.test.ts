/**
 * M06 边界与购买保护（**静态扫描 + 导出面检查**）。
 *
 * 「不接真实平台、不读系统时间、零 `node:*` 依赖、购买必须经确认」不能只写在注释里——
 * 这里把它们变成可回归的断言。允许的**跨包**依赖只有两处，且都列在白名单里：
 * 仓库既有的纯 TS SHA-256；同线 M04 的购物车类型/纯函数。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as m06 from '../../../src/mobile-plugins/meituan/purchase-confirmation/index.js';

const MODULE_DIR = fileURLToPath(
  new URL('../../../src/mobile-plugins/meituan/purchase-confirmation/', import.meta.url),
);

function sources(): readonly { readonly file: string; readonly text: string }[] {
  return readdirSync(MODULE_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ file: name, text: readFileSync(join(MODULE_DIR, name), 'utf8') }));
}

/** 允许的跨包（非 `./`）相对导入白名单。 */
const ALLOWED_CROSS_IMPORTS = new Set([
  '../../../documents/docx/sha256.js',
  '../cart/index.js',
]);

/** 墙钟 / 随机 / 环境 / 定时器：本包一律不得使用。 */
const FORBIDDEN_AMBIENT: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /Date\.now/, why: '不得读系统时间' },
  { pattern: /new Date\(/, why: '不得构造墙钟时间' },
  { pattern: /performance\.now/, why: '不得读系统时间' },
  { pattern: /Math\.random/, why: '不得引入随机性' },
  { pattern: /process\.env/, why: '不得依赖环境变量' },
  { pattern: /setTimeout\(/, why: '不得自行推进时间' },
  { pattern: /setInterval\(/, why: '不得自行推进时间' },
];

describe('M06 边界：文件面与依赖面', () => {
  it('模块文件集合固定（防止悄悄新增未审查文件）', () => {
    expect(sources().map((entry) => entry.file).sort()).toEqual([
      'ceiling.ts',
      'confirmation.ts',
      'contract.ts',
      'digest.ts',
      'errors.ts',
      'fixture.ts',
      'index.ts',
      'types.ts',
      'view-model.ts',
    ]);
  });

  it('导入只走相对路径；跨包导入仅限白名单两处（不引 node:*、不引第三方）', () => {
    for (const { file, text } of sources()) {
      const specifiers = [...text.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((match) => match[1] ?? '');
      for (const specifier of specifiers) {
        expect(specifier.startsWith('.'), `${file} 出现非相对导入：${specifier}`).toBe(true);
        expect(specifier.startsWith('node:'), `${file} 引入 node:*：${specifier}`).toBe(false);
        if (!specifier.startsWith('./')) {
          expect(ALLOWED_CROSS_IMPORTS.has(specifier), `${file} 出现未列入白名单的跨包导入：${specifier}`).toBe(true);
        }
      }
    }
  });

  it('不读系统时间、不使用随机数与环境变量', () => {
    for (const { file, text } of sources()) {
      for (const { pattern, why } of FORBIDDEN_AMBIENT) {
        expect(pattern.test(text), `${file} 命中 ${String(pattern)}（${why}）`).toBe(false);
      }
    }
  });
});

describe('M06 边界：购买保护在导出面上成立', () => {
  it('购买边界常量如实声明', () => {
    expect(m06.PURCHASE_CONFIRMATION_BOUNDARY.connectsRealPlatform).toBe(false);
    expect(m06.PURCHASE_CONFIRMATION_BOUNDARY.hasRealNetworkCall).toBe(false);
    expect(m06.PURCHASE_CONFIRMATION_BOUNDARY.performsRealOrder).toBe(false);
    expect(m06.PURCHASE_CONFIRMATION_BOUNDARY.allowsAutonomousPurchase).toBe(false);
    expect(m06.PURCHASE_CONFIRMATION_BOUNDARY.requiresK07Consumption).toBe(true);
  });

  it('模块导出里**没有**无确认的下单/支付入口（只有受确认保护的出口）', () => {
    const exported = Object.entries(m06).filter(([, value]) => typeof value === 'function');
    expect(exported.length).toBeGreaterThan(0);
    // 受确认保护的出口存在。
    const names = exported.map(([name]) => name);
    expect(names).toContain('authorizePurchase');
    expect(names).toContain('consumeNativePurchaseConfirmation');
    // 不存在「一发就下单/支付」的裸入口名（下划线/驼峰都查）。
    const forbiddenBare = /(^|_)(submitOrder|placeOrder|payOrder|doPayment|purchaseNow)(?![A-Za-z])/i;
    for (const name of names) {
      expect(forbiddenBare.test(name), `导出符号 ${name} 像无确认的下单/支付入口`).toBe(false);
    }
  });
});

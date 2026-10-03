/**
 * M05 边界与纪律（**静态扫描 + 导出面检查**）。
 *
 * 本包不接真实平台、不请求系统权限、不发起真实定位、不下单、不支付。
 * 这些约束不能只写在注释里——这里用源码扫描把「零依赖」「不读系统时间/随机/
 * 环境」「脱敏出口存在」「没有下单/支付入口」变成可回归的断言。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as m05 from '../../../src/mobile-plugins/meituan/address-delivery/index.js';
import { AddressBook, DeliverySlotSelector, LocationPermissionMachine } from '../../../src/mobile-plugins/meituan/address-delivery/index.js';

const M05_DIR = fileURLToPath(new URL('../../../src/mobile-plugins/meituan/address-delivery/', import.meta.url));

function m05Sources(): readonly { readonly file: string; readonly text: string }[] {
  return readdirSync(M05_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ file: name, text: readFileSync(join(M05_DIR, name), 'utf8') }));
}

const FORBIDDEN_WORDS = new Set(['submit', 'place', 'checkout', 'pay', 'payment', 'purchase', 'order', 'buy']);

function wordsOf(name: string): readonly string[] {
  return name
    .split(/[^A-Za-z0-9]+|(?=[A-Z])/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

function forbiddenWordIn(name: string): string | undefined {
  return wordsOf(name).find((word) => FORBIDDEN_WORDS.has(word));
}

const FORBIDDEN_AMBIENT: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /Date\.now/, why: '不得读系统时间' },
  { pattern: /new Date\(/, why: '不得构造墙钟时间' },
  { pattern: /performance\.now/, why: '不得读系统时间' },
  { pattern: /Math\.random/, why: '不得引入随机性（会破坏可重现）' },
  { pattern: /process\.env/, why: '不得依赖环境变量' },
  { pattern: /setTimeout\(/, why: '不得自行推进时间' },
  { pattern: /setInterval\(/, why: '不得自行推进时间' },
];

describe('M05 边界：不新增下单/支付能力', () => {
  it('模块导出里没有提交订单 / 支付类符号', () => {
    const exportedFunctions = Object.entries(m05).filter(
      ([, value]) => typeof value === 'function',
    );
    expect(exportedFunctions.length).toBeGreaterThan(0);
    for (const [name] of exportedFunctions) {
      expect(forbiddenWordIn(name), `导出符号 ${name} 像下单/支付能力`).toBeUndefined();
    }
  });

  it('三个核心类的方法里没有下单 / 支付入口', () => {
    for (const klass of [AddressBook, LocationPermissionMachine, DeliverySlotSelector]) {
      const methods = Object.getOwnPropertyNames(klass.prototype);
      expect(methods.length).toBeGreaterThan(0);
      for (const method of methods) {
        expect(forbiddenWordIn(method), `${klass.name}.${method} 像下单/支付能力`).toBeUndefined();
      }
    }
  });

  it('边界常量如实声明：不接平台、不定位、不请权限、不下单、不支付、不静默换地址', () => {
    expect(m05.ADDRESS_DELIVERY_BOUNDARY.connectsRealPlatform).toBe(false);
    expect(m05.ADDRESS_DELIVERY_BOUNDARY.requestsRealLocation).toBe(false);
    expect(m05.ADDRESS_DELIVERY_BOUNDARY.invokesSystemPermission).toBe(false);
    expect(m05.ADDRESS_DELIVERY_BOUNDARY.canSubmit).toBe(false);
    expect(m05.ADDRESS_DELIVERY_BOUNDARY.canPay).toBe(false);
    expect(m05.ADDRESS_DELIVERY_BOUNDARY.substitutesAddressOnPermissionDenied).toBe(false);
    expect(Object.isFrozen(m05.ADDRESS_DELIVERY_BOUNDARY)).toBe(true);
  });
});

describe('M05 边界：零依赖与不读环境', () => {
  it('源码文件集合固定（新增文件必须显式承认）', () => {
    const files = m05Sources();
    expect(files.map((entry) => entry.file).sort()).toEqual([
      'address-book.ts',
      'binding.ts',
      'bridge.ts',
      'digest.ts',
      'errors.ts',
      'fixture.ts',
      'index.ts',
      'locate.ts',
      'location.ts',
      'mask.ts',
      'slots.ts',
      'types.ts',
      'view-model.ts',
    ]);
  });

  it('只做仓库内相对导入（不引外部包、不读文件系统、不依赖 node:）', () => {
    for (const { file, text } of m05Sources()) {
      const specifiers = [...text.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((match) => match[1] ?? '');
      for (const specifier of specifiers) {
        expect(
          specifier.startsWith('./') || specifier.startsWith('../'),
          `${file} 出现了非相对导入：${specifier}`,
        ).toBe(true);
        expect(specifier.startsWith('node:'), `${file} 产品代码不得依赖 node: 模块（${specifier}）`).toBe(false);
      }
    }
  });

  it('不读系统时间、不使用随机数与环境变量', () => {
    for (const { file, text } of m05Sources()) {
      for (const { pattern, why } of FORBIDDEN_AMBIENT) {
        expect(pattern.test(text), `${file} 命中 ${String(pattern)}（${why}）`).toBe(false);
      }
    }
  });
});

describe('M05 边界：敏感字段与判定确实存在（判据非空壳）', () => {
  it('视图转换确实调用了脱敏函数（不是把明文直接透出）', () => {
    const viewModel = m05Sources().find((entry) => entry.file === 'view-model.ts');
    expect(viewModel).toBeDefined();
    expect(viewModel?.text.includes('maskPhone(')).toBe(true);
    expect(viewModel?.text.includes('maskContactName(')).toBe(true);
  });

  it('脱敏与解析函数都在公开出口里（缺一个说明被删了）', () => {
    const names = Object.keys(m05);
    for (const required of [
      'maskPhone',
      'maskContactName',
      'toAddressView',
      'resolveDelivery',
      'requireDeliveryAddressRef',
      'checkAddressBinding',
      'requireAddressBinding',
      'createDeliveryDetailPort',
    ]) {
      expect(names, `公开出口缺少 ${required}`).toContain(required);
    }
  });
});

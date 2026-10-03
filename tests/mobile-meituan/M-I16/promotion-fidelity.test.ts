/**
 * M-I16 —— 证明「提升」不是「并行重写」。
 *
 * M-R03 集成请求 #1 要求：把源码提升到生产目录并**复用同一实现**，不另建并行实现。
 * 本用例对 6 个被提升文件做保真比对：
 * - `operations.ts`：与 M-R03 原文件**逐字节一致**；
 * - `types.ts` / `errors.ts` / `price-diff.ts` / `guard.ts`：**唯一**差异是把对 M04 的导入
 *   从测试树相对路径改成生产相对路径（`../../../src/mobile-plugins/meituan/cart/index.js`
 *   → `../cart/index.js`）；把该差异归一化后必须逐字节一致；
 * - `index.ts`：docstring 头两行改为生产包路径并加一行「由 M-I16 提升」说明；从
 *   `export * from './types.js';` 起的**代码体**（导出 + 边界常量）与 M-R03 逐字节一致。
 *
 * 若日后删除 M-R03 测试树，请同步更新本用例（见本包报告的 residuals）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const PROD_DIR = fileURLToPath(new URL('../../../src/mobile-plugins/meituan/reconfirmation/', import.meta.url));
const M_R03_DIR = fileURLToPath(new URL('../M-R03/', import.meta.url));

/** 与 M-R03 逐字节一致的文件（不引用 M04，故无需改导入）。 */
const VERBATIM = ['operations.ts'] as const;

/** 唯一差异为 M04 导入路径的文件。 */
const IMPORT_ONLY = ['types.ts', 'errors.ts', 'price-diff.ts', 'guard.ts'] as const;

const M_R03_CART_IMPORT = "'../../../src/mobile-plugins/meituan/cart/index.js'";
const PROD_CART_IMPORT = "'../cart/index.js'";

function read(dir: string, file: string): string {
  return readFileSync(`${dir}${file}`, 'utf8');
}

/** 取 `export * from './types.js';` 起的代码体（跳过 docstring）。 */
function codeBody(text: string): string {
  const marker = "export * from './types.js';";
  const index = text.indexOf(marker);
  return index === -1 ? '' : text.slice(index);
}

describe('M-I16 提升保真：逐字节一致', () => {
  for (const file of VERBATIM) {
    it(`${file} 与 M-R03 原文件逐字节一致`, () => {
      expect(read(PROD_DIR, file)).toBe(read(M_R03_DIR, file));
    });
  }
});

describe('M-I16 提升保真：唯一有意差异 = M04 导入路径', () => {
  for (const file of IMPORT_ONLY) {
    it(`${file} 归一化 M04 导入路径后与 M-R03 逐字节一致`, () => {
      const original = read(M_R03_DIR, file);
      // M-R03 原文件确实用了测试树相对路径（差异是刻意重写，不是遗漏）。
      expect(original, `${file} 应含测试树 M04 导入路径`).toContain(M_R03_CART_IMPORT);
      const normalized = original.replaceAll(M_R03_CART_IMPORT, PROD_CART_IMPORT);
      expect(read(PROD_DIR, file)).toBe(normalized);
      // 生产文件不得残留测试树路径。
      expect(read(PROD_DIR, file), `${file} 残留测试树 M04 导入路径`).not.toContain(M_R03_CART_IMPORT);
    });
  }
});

describe('M-I16 提升保真：index.ts 代码体一致', () => {
  it('从 export 起的代码体（导出面 + 边界常量）与 M-R03 逐字节一致', () => {
    const prodBody = codeBody(read(PROD_DIR, 'index.ts'));
    const mR03Body = codeBody(read(M_R03_DIR, 'index.ts'));
    expect(prodBody.length).toBeGreaterThan(0);
    expect(prodBody).toBe(mR03Body);
  });

  it('生产 index.ts 不 re-export 任何 fixture（测试数据不得成为生产出口）', () => {
    const prodIndex = read(PROD_DIR, 'index.ts');
    expect(prodIndex).not.toContain('fixture');
    expect(prodIndex).not.toContain('./support.js');
  });

  it('生产 index.ts 逐个 re-export 6 个被提升模块，不内联重写实现', () => {
    const prodIndex = read(PROD_DIR, 'index.ts');
    for (const mod of ['types', 'errors', 'price-diff', 'guard', 'operations'] as const) {
      expect(prodIndex, `index.ts 应 re-export ./${mod}.js`).toContain(`from './${mod}.js'`);
    }
    // 唯一非 re-export 的实体是边界常量，且它不是校验实现。
    expect(prodIndex).toContain('RECONFIRMATION_BOUNDARY');
  });
});

/**
 * M-I13 —— 证明「提升」不是「并行重写」。
 *
 * M-R02 集成请求 #1 要求：把源码提升到生产目录并**复用同一 API，不另建并行实现**。
 * 本用例对 7 个被提升文件做**逐字节**比对（生产文件 === M-R02 原文件），
 * 并单独说明唯一的**有意差异**：生产 `index.ts` 不再导出 test-only 的 `fixture.ts`。
 *
 * 若日后要删除 M-R02 测试树，请同步更新本用例（见本包 hand-off 的 residuals）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const PROD_DIR = fileURLToPath(new URL('../../../src/mobile-plugins/meituan/spec-preflight/', import.meta.url));
const M_R02_DIR = fileURLToPath(new URL('../M-R02/', import.meta.url));

/** 被提升的生产文件（M-R02 集成请求 #1 列出的 8 个之中除 index 外，均为原样复制）。 */
const PROMOTED_VERBATIM = ['types.ts', 'errors.ts', 'specs.ts', 'stock.ts', 'fulfillment.ts', 'preflight.ts', 'schemas.ts'] as const;

function read(dir: string, file: string): string {
  return readFileSync(`${dir}${file}`, 'utf8');
}

describe('M-I13 提升保真：逐字节一致', () => {
  for (const file of PROMOTED_VERBATIM) {
    it(`${file} 与 M-R02 原文件逐字节一致`, () => {
      expect(read(PROD_DIR, file)).toBe(read(M_R02_DIR, file));
    });
  }
});

describe('M-I13 提升保真：唯一有意差异', () => {
  it('生产 index.ts 不再 re-export fixture（测试数据不得成为生产出口）', () => {
    const prodIndex = read(PROD_DIR, 'index.ts');
    expect(prodIndex).not.toContain('./fixture.js');
    // M-R02 的 index 确实导出 fixture —— 差异是刻意移除，不是遗漏。
    expect(read(M_R02_DIR, 'index.ts')).toContain("from './fixture.js'");
  });

  it('生产 index.ts 逐个 re-export 7 个被提升模块，不内联重写实现', () => {
    const prodIndex = read(PROD_DIR, 'index.ts');
    for (const mod of ['types', 'errors', 'specs', 'stock', 'fulfillment', 'preflight', 'schemas'] as const) {
      expect(prodIndex, `index.ts 应 re-export ./${mod}.js`).toContain(`from './${mod}.js'`);
    }
    // 唯一非 re-export 的实体是边界常量，且它不是校验实现。
    expect(prodIndex).toContain('CATALOG_PREFLIGHT_BOUNDARY');
  });
});

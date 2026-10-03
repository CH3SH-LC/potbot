/**
 * M-I14 / 提升保真：证明「提升」不是「并行重写」。
 *
 * M-R05 集成请求 #1 要求复用同一 API，不另建并行实现。本用例对两个源文件做**逐字节**
 * 比对（生产文件 === M-R05 原文件），并单独说明夹具的**唯一有意差异**：
 * 生产 `fixture.ts` 不再携带测试面专属的 `sk-` 形状负向向量。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const PROD_DIR = fileURLToPath(new URL('../../../src/mobile-plugins/meituan/credential-isolation/', import.meta.url));
const M_R05_DIR = fileURLToPath(new URL('../M-R05/', import.meta.url));

function read(dir: string, file: string): string {
  return readFileSync(`${dir}${file}`, 'utf8');
}

describe('M-I14 提升保真：逐字节一致', () => {
  for (const file of ['credential-isolation.ts', 'schemas.ts'] as const) {
    it(`${file} 与 M-R05 原文件逐字节一致`, () => {
      expect(read(PROD_DIR, file)).toBe(read(M_R05_DIR, file));
    });
  }
});

describe('M-I14 提升保真：fixture 的唯一有意差异', () => {
  it('生产 fixture.ts 由 support.ts 提升，但刻意不含 sk- 形状字面量', () => {
    const prodFixture = read(PROD_DIR, 'fixture.ts');
    const mR05Support = read(M_R05_DIR, 'support.ts');
    // 差异是刻意的：M-R05 support 含 SECRET_SHAPED 字面量，生产 fixture 移除之。
    expect(mR05Support).toContain('SECRET_SHAPED');
    expect(/sk-[A-Za-z0-9_-]{10,}/.test(prodFixture)).toBe(false);
  });

  it('非秘密夹具常量与构造器仍从 support 逐项保留', () => {
    const prodFixture = read(PROD_DIR, 'fixture.ts');
    for (const token of [
      'T0',
      'TTL_MS',
      'ACCOUNT_A',
      'ACCOUNT_B',
      'INSTALL_1',
      'INSTALL_2',
      'makeScenario',
      'makeEmptyVault',
    ]) {
      expect(prodFixture, `fixture.ts 应保留 ${token}`).toContain(token);
    }
  });
});

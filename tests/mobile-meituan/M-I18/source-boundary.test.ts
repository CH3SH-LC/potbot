/**
 * M-I18｜源码边界：确定性、零网络、无第三方依赖、只相对导入。
 *
 * 机器化扫描本包源码，证明它不读系统时钟 / 不用随机 / 不联网 / 不 import node:* 或
 * 第三方包——「恢复不发网络」「指纹确定性」两条纪律因此是**结构成立**的，而非口头承诺。
 * 这与 M03 / M-R04 的边界测试同一路数。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SOURCE_DIR = fileURLToPath(
  new URL('../../../src/mobile-plugins/meituan/order-intent', import.meta.url),
);

function sourceFiles(): string[] {
  return readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith('.ts'))
    .sort();
}

function read(name: string): string {
  return readFileSync(join(SOURCE_DIR, name), 'utf8');
}

describe('M-I18 源码边界', () => {
  it('本单元源码文件齐备', () => {
    expect(sourceFiles()).toEqual(['errors.ts', 'fingerprint.ts', 'index.ts', 'intent.ts', 'types.ts']);
  });

  const forbidden: readonly { readonly label: string; readonly pattern: RegExp }[] = [
    { label: 'Date.now', pattern: /\bDate\.now\b/ },
    { label: 'new Date', pattern: /\bnew Date\b/ },
    { label: 'Math.random', pattern: /\bMath\.random\b/ },
    { label: 'node: 内置模块', pattern: /from\s+['"]node:/ },
    { label: 'require()', pattern: /\brequire\s*\(/ },
    { label: 'fetch()', pattern: /\bfetch\s*\(/ },
    { label: 'process.env', pattern: /process\.env/ },
    { label: '定时器', pattern: /\b(setTimeout|setInterval|queueMicrotask)\s*\(/ },
  ];

  for (const { label, pattern } of forbidden) {
    it(`源码不出现 ${label}`, () => {
      const offenders = sourceFiles().filter((name) => pattern.test(read(name)));
      expect(offenders).toEqual([]);
    });
  }

  it('只相对导入（不 import node:* 或第三方包）', () => {
    for (const name of sourceFiles()) {
      const specifiers = [...read(name).matchAll(/from\s+['"]([^'"]+)['"]/g)]
        .map((match) => match[1])
        // 捕获组在 matchAll 命中时必然存在；显式收窄以去掉 string | undefined。
        .filter((specifier): specifier is string => specifier !== undefined);
      for (const specifier of specifiers) {
        expect(specifier.startsWith('.'), `${name} 导入了非相对路径 ${specifier}`).toBe(true);
      }
    }
  });
});

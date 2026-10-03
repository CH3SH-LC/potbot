/**
 * M-I20 边界：静态扫描被测源码目录，强制其**零依赖 / 无 `node:*` / 无副作用来源**。
 *
 * 这是本单元的核心约束之一（「zero deps, no node:*」）。测试侧允许 `node:*`，
 * 被测侧（`src/mobile-plugins/meituan/crypto/**`）**不允许**。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const CRYPTO_DIR = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../src/mobile-plugins/meituan/crypto',
);

function sourceFiles(): readonly string[] {
  return readdirSync(CRYPTO_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(CRYPTO_DIR, name));
}

/**
 * 去掉块注释与行注释后再扫描：**指纹应落在代码上，而不是文档字符串上**
 * （源码注释里正当地提到 `require(` / `node:` 这类被禁字面量，不应被判违规）。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 读取某文件并去掉注释后的代码文本。 */
function codeOf(file: string): string {
  return stripComments(readFileSync(file, 'utf8'));
}

describe('M-I20 crypto 包边界（零依赖 / 无 node:* / 纯函数）', () => {
  it('源码目录被正确找到（防止路径写错导致空扫描假绿）', () => {
    const names = readdirSync(CRYPTO_DIR);
    expect(names).toContain('sha256.ts');
    expect(names).toContain('digest.ts');
    expect(names).toContain('index.ts');
  });

  it('不含任何 node:* 导入，也不含 require(', () => {
    for (const file of sourceFiles()) {
      const src = codeOf(file);
      expect(src, file).not.toMatch(/from\s+['"]node:/);
      expect(src, file).not.toMatch(/\bimport\s*\(\s*['"]node:/);
      expect(src, file).not.toMatch(/\brequire\s*\(/);
    }
  });

  it('所有 import 都是相对路径（无第三方 / 裸包名）', () => {
    for (const file of sourceFiles()) {
      const src = codeOf(file);
      const specs: string[] = [];
      for (const match of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        specs.push(match[1] as string);
      }
      for (const spec of specs) {
        expect(spec.startsWith('.'), `${file}: ${spec}`).toBe(true);
      }
    }
  });

  it('不含墙钟 / 随机数 / 环境 / IO / 计时器（纯函数与确定性）', () => {
    const forbidden = [
      /Date\.now\s*\(/,
      /new\s+Date\s*\(/,
      /Math\.random\s*\(/,
      /process\s*\./,
      /setTimeout\s*\(/,
      /setInterval\s*\(/,
      /\bfetch\s*\(/,
      /performance\s*\./,
    ];
    for (const file of sourceFiles()) {
      const src = codeOf(file);
      for (const pattern of forbidden) {
        expect(src, `${file} matches ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });
});

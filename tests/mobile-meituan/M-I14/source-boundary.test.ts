/**
 * M-I14 / 生产源码静态边界扫描（扫 `src/mobile-plugins/meituan/credential-isolation/`）。
 *
 * 提升到生产后仍必须保持「纯本地、无网络、不读时间/随机/环境变量、不内嵌 sk- 形状密钥」。
 * 扫描对象是**生产目录**，把边界约束钉在生产源上。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const PROD_DIR = fileURLToPath(new URL('../../../src/mobile-plugins/meituan/credential-isolation/', import.meta.url));

/** 生产目录应有的源码文件构成（无测试文件）。 */
const EXPECTED_FILES = ['credential-isolation.ts', 'fixture.ts', 'index.ts', 'schemas.ts'];

function moduleSources(): readonly { readonly file: string; readonly text: string }[] {
  return readdirSync(PROD_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ file: name, text: readFileSync(join(PROD_DIR, name), 'utf8') }));
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

describe('M-I14 生产源码边界', () => {
  it('文件构成与本包范围一致（无测试文件）', () => {
    expect(moduleSources().map((entry) => entry.file).sort()).toEqual(EXPECTED_FILES);
  });

  it('所有源码只做相对导入（不引外部包）', () => {
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

  it('生产源码不含任何 sk- 形状的密钥字面量', () => {
    for (const { file, text } of moduleSources()) {
      expect(/sk-[A-Za-z0-9_-]{10,}/.test(text), `${file} 含 sk- 形状字面量`).toBe(false);
    }
  });
});

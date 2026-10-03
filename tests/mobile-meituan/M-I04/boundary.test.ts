/**
 * M-I04 边界扫描。
 *
 * 历史 M04 的 `boundary.test.ts` 只扫描 `cart/` **顶层**（且硬编码了恰好 9 个 `.ts`
 * 文件），不覆盖本次新增的 `cart/contract/` 子目录。这里补齐：对顶层与子目录
 * **都**做「零外部依赖 + 不读墙钟/随机/环境」扫描，并钉住顶层文件清单不变。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const CART_DIR = fileURLToPath(new URL('../../../src/mobile-plugins/meituan/cart/', import.meta.url));
const CONTRACT_DIR = join(CART_DIR, 'contract');

/** 顶层文件名清单——必须与 M04 `boundary.test.ts` 的硬编码清单一致（不得改动）。 */
const PINNED_TOP_LEVEL = [
  'cart.ts',
  'digest.ts',
  'errors.ts',
  'fixture.ts',
  'index.ts',
  'money.ts',
  'session.ts',
  'specs.ts',
  'types.ts',
];

const FORBIDDEN_AMBIENT: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /Date\.now/, why: '不得读系统时间' },
  { pattern: /new Date\(/, why: '不得构造墙钟时间' },
  { pattern: /performance\.now/, why: '不得读系统时间' },
  { pattern: /Math\.random/, why: '不得引入随机性' },
  { pattern: /process\.env/, why: '不得依赖环境变量' },
  { pattern: /setTimeout\(/, why: '不得自行推进时间' },
  { pattern: /setInterval\(/, why: '不得自行推进时间' },
];

function tsFilesIn(dir: string): readonly string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .sort();
}

function sourcesIn(dir: string, files: readonly string[]): readonly { readonly file: string; readonly text: string }[] {
  return files.map((file) => ({ file: `${dir}/${file}`, text: readFileSync(join(dir, file), 'utf8') }));
}

describe('M-I04 边界：目录结构', () => {
  it('顶层仍恰好是 9 个文件（历史 M04 边界用例的硬约束）', () => {
    expect(tsFilesIn(CART_DIR)).toEqual([...PINNED_TOP_LEVEL].sort());
  });

  it('新增模块位于 contract/ 子目录，且恰好两个', () => {
    expect(tsFilesIn(CONTRACT_DIR)).toEqual(['operations.ts', 'timestamp.ts']);
  });

  it('index.ts 重新导出 contract/ 两个模块', () => {
    const index = readFileSync(join(CART_DIR, 'index.ts'), 'utf8');
    expect(index.includes("'./contract/operations.js'")).toBe(true);
    expect(index.includes("'./contract/timestamp.js'")).toBe(true);
  });
});

describe('M-I04 边界：零外部依赖、不读环境', () => {
  const scanned = [
    ...sourcesIn(CART_DIR, tsFilesIn(CART_DIR)),
    ...sourcesIn(CONTRACT_DIR, tsFilesIn(CONTRACT_DIR)),
  ];

  it('所有导入都是相对导入（含 ../ 上一级）', () => {
    for (const { file, text } of scanned) {
      const specifiers = [...text.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((match) => match[1] ?? '');
      for (const specifier of specifiers) {
        expect(specifier.startsWith('.'), `${file} 出现非相对导入：${specifier}`).toBe(true);
      }
    }
  });

  it('顶层与 contract/ 都不读墙钟、不用随机与环境变量', () => {
    for (const { file, text } of scanned) {
      for (const { pattern, why } of FORBIDDEN_AMBIENT) {
        expect(pattern.test(text), `${file} 命中 ${String(pattern)}（${why}）`).toBe(false);
      }
    }
  });
});

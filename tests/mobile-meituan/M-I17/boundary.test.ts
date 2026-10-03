/**
 * M-I17 ③ 提升后源码的**边界静态扫描**（零依赖 / 不读环境 / 无真实购买能力）。
 *
 * 扫描目标是**生产源码目录** `src/mobile-plugins/meituan/network-resilience/`，
 * 不是本测试目录——提升后的源码必须与暂存模块保持同样的纪律：
 * 只做仓库内相对导入、不 import `node:*`、不读墙钟 / 随机 / 环境 / 定时器 / 网络。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as nr from '../../../src/mobile-plugins/meituan/network-resilience/index.js';

const MODULE_DIR = fileURLToPath(
  new URL('../../../src/mobile-plugins/meituan/network-resilience/', import.meta.url),
);

/**
 * 提升后的模块源文件（**精确列举**：只扫 `.ts`，不含任何测试文件）。
 * 新增模块文件必须在此登记，否则本条扫描不再是全覆盖。
 */
const MODULE_FILES = [
  'types.ts',
  'network-state.ts',
  'outcomes.ts',
  'retry-policy.ts',
  'disposition.ts',
  'recovery.ts',
  'resilient-transport.ts',
  'schemas.ts',
  'index.ts',
] as const;

function moduleSources(): readonly { readonly file: string; readonly text: string }[] {
  const present = readdirSync(MODULE_DIR);
  for (const file of MODULE_FILES) {
    expect(present, `模块文件缺失：${file}`).toContain(file);
  }
  return MODULE_FILES.map((file) => ({ file, text: readFileSync(join(MODULE_DIR, file), 'utf8') }));
}

/** 墙钟 / 随机 / 环境 / 定时器 / 网络：提升后一律不得使用。 */
const FORBIDDEN_AMBIENT: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /\bDate\.now\b/, why: '不得读系统时间' },
  { pattern: /\bnew Date\(/, why: '不得构造墙钟时间（HTTP 日期解析除外，见下）' },
  { pattern: /\bperformance\.now\b/, why: '不得读系统时间' },
  { pattern: /\bMath\.random\b/, why: '不得引入随机性' },
  { pattern: /\bprocess\.env\b/, why: '不得依赖环境变量' },
  { pattern: /\bsetTimeout\(/, why: '不得自行推进时间（等待端口必须注入）' },
  { pattern: /\bsetInterval\(/, why: '不得自行推进时间' },
  { pattern: /\bfetch\(/, why: '不得自带网络调用' },
  { pattern: /\bXMLHttpRequest\b/, why: '不得自带网络调用' },
];

describe('M-I17 生产源码边界：零依赖与不读环境', () => {
  it('模块只做仓库内相对导入（不引外部包、不 import node:*、不 import tests/）', () => {
    for (const { file, text } of moduleSources()) {
      const specifiers = [...text.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((match) => match[1] ?? '');
      for (const specifier of specifiers) {
        const ok = specifier.startsWith('./') || specifier.startsWith('../');
        expect(ok, `${file} 出现了不允许的导入：${specifier}`).toBe(true);
        expect(specifier.startsWith('node:'), `${file} 不得 import node:*`).toBe(false);
        expect(specifier.includes('tests/'), `${file} 不得依赖 tests/ 暂存目录：${specifier}`).toBe(false);
      }
    }
  });

  it('模块不读系统时间、不使用随机数、环境变量与定时器', () => {
    for (const { file, text } of moduleSources()) {
      for (const { pattern, why } of FORBIDDEN_AMBIENT) {
        expect(pattern.test(text), `${file} 命中 ${String(pattern)}（${why}）`).toBe(false);
      }
    }
  });

  it('仅 retry-policy.ts 允许出现 new Date(（用于解析 HTTP 日期形式的 Retry-After）', () => {
    for (const { file, text } of moduleSources()) {
      if (file === 'retry-policy.ts') {
        continue;
      }
      expect(/\bnew Date\(/.test(text), `${file} 不应构造墙钟时间`).toBe(false);
    }
  });

  it('导出面里没有 place / pay / checkout / purchase 类真实购买能力', () => {
    const forbidden = new Set(['place', 'pay', 'payment', 'checkout', 'purchase', 'buy']);
    const words = (name: string): readonly string[] =>
      name
        .split(/[^A-Za-z0-9]+|(?=[A-Z])/)
        .filter((word) => word.length > 0)
        .map((word) => word.toLowerCase());
    const exportedFunctions = Object.entries(nr).filter(([, value]) => typeof value === 'function');
    expect(exportedFunctions.length).toBeGreaterThan(0);
    for (const [name] of exportedFunctions) {
      const hit = words(name).find((word) => forbidden.has(word));
      expect(hit, `导出符号 ${name} 像真实购买能力`).toBeUndefined();
    }
  });
});

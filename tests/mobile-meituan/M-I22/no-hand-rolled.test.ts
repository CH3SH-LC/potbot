/**
 * M-I22 §6：**证明仓库里没有第二个"手搓元/分换算"**。
 *
 * "手搓"指的是 `x * 100` / `x / 100` / `toFixed(2)` / `parseFloat(s) * 100` 这类
 * 逐案写的浮点或硬编码位数换算——它正是 mobile-v1 金额裁决明文禁止的东西。
 * 本文件用**源码扫描 + 函数声明计数**把这条约束变成可回归的断言：
 *
 * 1. 金额相关行里没有 `* 100` / `/ 100` / `toFixed(` / `parseFloat(` / `Math.round(`；
 * 2. `parseFloat` 在金额相关目录里一处都没有；
 * 3. 声明 wire 金额形状正则（`[0-9]{1,4}`）的**文件集合**恰好是下面 5 个已知点；
 * 4. 命名换算函数（`minorUnitsToWireAmount` / `formatWireAmount` / `parseWireAmount`）
 *    各自**只在一处**声明。
 *
 * 注释先被剥掉再扫描：源码注释里正当地引用被禁 token（说明"禁止 parseFloat"）不应被判违规。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { amountToScaledUnits } from '../../../apps/mobile-ui/src/decisions/compare.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** 金额可能出现的边界目录（只读扫描；不修改任何被测文件）。 */
const SCAN_ROOTS: readonly string[] = Object.freeze([
  'src/mobile-plugins/meituan',
  'apps/mobile-kernel/actions',
  'apps/mobile-ui/src/decisions',
]);

/** 已知的、有理由存在的 wire 金额形状声明点（路径用 `/` 归一）。 */
const KNOWN_WIRE_AMOUNT_DECLARATIONS: readonly string[] = Object.freeze([
  'src/mobile-plugins/meituan/cart/money.ts',
  'apps/mobile-kernel/actions/wire-codec.ts',
  'apps/mobile-ui/src/decisions/compare.ts',
  'apps/mobile-ui/src/decisions/trust.ts',
  'apps/mobile-ui/src/decisions/types.ts',
]);

function walk(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function relPosix(absolute: string): string {
  return absolute.slice(REPO_ROOT.length).replace(/\\/g, '/');
}

function scannedFiles(): readonly string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const absolute = join(REPO_ROOT, root);
    expect(statSync(absolute).isDirectory(), `扫描根不存在：${root}`).toBe(true);
    files.push(...walk(absolute));
  }
  return files;
}

/** 去掉块注释与行注释后再扫描：指纹应落在代码上，而不是文档字符串上。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 该行是否在谈论金额（避免把时间戳的 `/100`、距离的 `toFixed` 误判为元/分换算）。 */
const MONEY_LINE = /\b(amount|Amount|minor|Minor|price|Price|fee|Fee|currency|Currency|subtotal|discount|cent|Cents?)\b|分|元/;

/** 手搓换算/浮点取整的形态。 */
const HAND_ROLLED = /(\*\s*100\b)|(\/\s*100\b)|\.toFixed\s*\(|parseFloat\s*\(|Math\.round\s*\(/;

describe('M-I22 §6.1 扫描基线（防止路径写错导致空扫描假绿）', () => {
  it('三个扫描根都确实被读到，且文件数可观', () => {
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(30);
    const rel = files.map(relPosix);
    expect(rel).toContain('src/mobile-plugins/meituan/cart/money.ts');
    expect(rel).toContain('apps/mobile-kernel/actions/wire-codec.ts');
    expect(rel).toContain('apps/mobile-ui/src/decisions/trust.ts');
  });
});

describe('M-I22 §6.2 没有手搓元/分换算', () => {
  it('金额相关行里没有 *100 / /100 / toFixed / parseFloat / Math.round', () => {
    const offenders: string[] = [];
    for (const file of scannedFiles()) {
      const code = stripComments(readFileSync(file, 'utf8'));
      code.split(/\r?\n/).forEach((line, index) => {
        if (MONEY_LINE.test(line) && HAND_ROLLED.test(line)) {
          offenders.push(`${relPosix(file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, `金额行出现手搓换算：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('parseFloat 在这些目录一处都没有', () => {
    for (const file of scannedFiles()) {
      expect(stripComments(readFileSync(file, 'utf8')), relPosix(file)).not.toContain('parseFloat');
    }
  });

  it('toFixed 只出现在与金额无关的模块（本轮为 catalog/delivery 的距离展示）', () => {
    const withToFixed = scannedFiles()
      .filter((file) => stripComments(readFileSync(file, 'utf8')).includes('toFixed'))
      .map(relPosix);
    // 只允许距离展示；绝不是金额模块。
    expect(withToFixed).toEqual(['src/mobile-plugins/meituan/catalog/delivery.ts']);
  });
});

describe('M-I22 §6.3 wire 金额形状只在已知边界声明', () => {
  it('声明 [0-9]{1,4} 的文件集合恰好是 5 个已知点', () => {
    const declaring = scannedFiles()
      .filter((file) => /\[0-9\]\{1,4\}/.test(stripComments(readFileSync(file, 'utf8'))))
      .map(relPosix)
      .sort();
    expect(declaring).toEqual([...KNOWN_WIRE_AMOUNT_DECLARATIONS].sort());
  });

  it('命名换算函数各自只在一处声明（不存在平行实现）', () => {
    const countFilesContaining = (needle: string): string[] =>
      scannedFiles()
        .filter((file) => stripComments(readFileSync(file, 'utf8')).includes(needle))
        .map(relPosix)
        .sort();

    expect(countFilesContaining('function minorUnitsToWireAmount')).toEqual([
      'src/mobile-plugins/meituan/cart/money.ts',
    ]);
    expect(countFilesContaining('function wireAmountToMinorUnits')).toEqual([
      'src/mobile-plugins/meituan/cart/money.ts',
    ]);
    expect(countFilesContaining('function formatWireAmount')).toEqual([
      'apps/mobile-kernel/actions/wire-codec.ts',
    ]);
    expect(countFilesContaining('function parseWireAmount')).toEqual([
      'apps/mobile-kernel/actions/wire-codec.ts',
    ]);
  });
});

describe('M-I22 §6.4 F05 的定标比较器不是元/分换算', () => {
  it('amountToScaledUnits 是币种无关的定标（10^4），不是最小单位换算', () => {
    // 定标比较：任何币种都放大到 10^4 的整数，用于排序，不产出最小单位。
    expect(amountToScaledUnits('1.23')).toBe(12_300);
    expect(amountToScaledUnits('1.234')).toBe(12_340);
    expect(amountToScaledUnits('0.1')).toBe(1_000);
    // 若它真是"元/分换算"，'1.23' 会等于 123（分）而不是 12300。
    expect(amountToScaledUnits('1.23')).not.toBe(123);
    // 形状非法一律 null（不做宽松解析）。
    expect(amountToScaledUnits('1.23456')).toBeNull();
    expect(amountToScaledUnits('abc')).toBeNull();
  });
});

/**
 * M-R04 边界（**静态扫描 + 导出面检查**）。
 *
 * 本层不触网、不读系统时间、不使用随机数、不接真实平台。这些约束用源码扫描
 * 变成可回归的断言，而不是只写在注释里。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as mrr04 from './index.js';

const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url));

/**
 * 模块源文件（**精确列举**：只扫 `.ts` 且排除 `*.test.ts` 与本支持文件）。
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

/** 墙钟 / 随机 / 环境 / 定时器 / 网络：本层一律不得使用。 */
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

describe('M-R04 边界：零依赖与不读环境', () => {
  it('模块只做内部相对导入（不引外部包、不 import node:*）', () => {
    for (const { file, text } of moduleSources()) {
      const specifiers = [...text.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((match) => match[1] ?? '');
      for (const specifier of specifiers) {
        const ok = specifier.startsWith('./') || specifier.startsWith('../../../src/');
        expect(ok, `${file} 出现了不允许的导入：${specifier}`).toBe(true);
        expect(specifier.startsWith('node:'), `${file} 不得 import node:*`).toBe(false);
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

  it('购买边界常量如实声明：不触网、不接真实平台、不产生真实订单', () => {
    expect(mrr04.NETWORK_RESILIENCE_BOUNDARY.hasRealNetworkCall).toBe(false);
    expect(mrr04.NETWORK_RESILIENCE_BOUNDARY.transportMustBeInjected).toBe(true);
    expect(mrr04.NETWORK_RESILIENCE_BOUNDARY.connectsRealPlatform).toBe(false);
    expect(mrr04.NETWORK_RESILIENCE_BOUNDARY.producesRealOrder).toBe(false);
    expect(Object.isFrozen(mrr04.NETWORK_RESILIENCE_BOUNDARY)).toBe(true);
  });

  it('导出面里没有 place / pay / checkout / purchase 类真实购买能力', () => {
    const forbidden = new Set(['place', 'pay', 'payment', 'checkout', 'purchase', 'buy']);
    const words = (name: string): readonly string[] =>
      name
        .split(/[^A-Za-z0-9]+|(?=[A-Z])/)
        .filter((word) => word.length > 0)
        .map((word) => word.toLowerCase());
    const exportedFunctions = Object.entries(mrr04).filter(([, value]) => typeof value === 'function');
    expect(exportedFunctions.length).toBeGreaterThan(0);
    for (const [name] of exportedFunctions) {
      const hit = words(name).find((word) => forbidden.has(word));
      expect(hit, `导出符号 ${name} 像真实购买能力`).toBeUndefined();
    }
  });
});

describe('M-R04 操作 schemas', () => {
  it('四个操作齐备、版本为 1、编号唯一', () => {
    const ops = mrr04.MOBILE_NETWORK_OPERATIONS;
    expect(ops.map((entry) => entry.operation)).toEqual([
      'network.observe',
      'network.switch',
      'transport.classify',
      'submit.recover',
    ]);
    for (const op of ops) {
      expect(op.version).toBe('1');
    }
    expect(new Set(ops.map((entry) => entry.operation)).size).toBe(ops.length);
  });

  it('未知操作被拒', () => {
    const result = mrr04.validateOperationInput('nope.operation', {});
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('未知操作');
  });

  it('network.switch 校验 kind 枚举', () => {
    expect(mrr04.validateOperationInput('network.switch', { kind: 'wifi' }).ok).toBe(true);
    expect(mrr04.validateOperationInput('network.switch', { kind: 'satellite' }).ok).toBe(false);
    expect(mrr04.validateOperationInput('network.switch', {}).ok).toBe(false);
  });

  it('submit.recover 校验必需字段与枚举', () => {
    const good = mrr04.validateOperationInput('submit.recover', {
      network: { online: true },
      disposition: { kind: 'timeout', retry: 'after_delay' },
      attemptsMade: 1,
      maxAttempts: 3,
      serverIdempotencyVerified: false,
    });
    expect(good.ok).toBe(true);

    const badKind = mrr04.validateOperationInput('submit.recover', {
      network: {},
      disposition: { kind: 'not_a_kind', retry: 'after_delay' },
      attemptsMade: 1,
      maxAttempts: 3,
      serverIdempotencyVerified: false,
    });
    expect(badKind.ok).toBe(false);

    const badBool = mrr04.validateOperationInput('submit.recover', {
      network: {},
      disposition: { kind: 'timeout', retry: 'after_delay' },
      attemptsMade: 1,
      maxAttempts: 3,
      serverIdempotencyVerified: 'yes',
    });
    expect(badBool.ok).toBe(false);
  });

  it('transport.classify 校验 nowMs 与 outcome', () => {
    expect(mrr04.validateOperationInput('transport.classify', { outcome: {}, nowMs: 1 }).ok).toBe(true);
    expect(mrr04.validateOperationInput('transport.classify', { outcome: {}, nowMs: 'x' }).ok).toBe(false);
    expect(mrr04.validateOperationInput('transport.classify', { nowMs: 1 }).ok).toBe(false);
  });
});

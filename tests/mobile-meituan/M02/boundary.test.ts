/**
 * M02 ⑥：边界与纪律（**静态源码扫描**）。
 *
 * 把"零依赖 / 零网络 / 不读系统时钟与随机 / 描述符无秘密字段 / 未内置官方 host 或码表"
 * 变成可回归的断言，而不是只写在注释里。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as m02 from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';

const M02_DIR = fileURLToPath(new URL('../../../src/mobile-plugins/meituan/mobile-transport/', import.meta.url));

interface Source {
  readonly file: string;
  readonly text: string;
}

function m02Sources(): readonly Source[] {
  return readdirSync(M02_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ file: name, text: readFileSync(join(M02_DIR, name), 'utf8') }));
}

const FORBIDDEN_AMBIENT: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /\bDate\.now\b/, why: '不得读系统时间' },
  { pattern: /new Date\(/, why: '不得构造墙钟时间' },
  { pattern: /\bperformance\.now\b/, why: '不得读系统时间' },
  { pattern: /\bMath\.random\b/, why: '不得引入随机性' },
  { pattern: /\bprocess\.env\b/, why: '不得依赖环境变量' },
  { pattern: /\bsetTimeout\(/, why: '不得自行推进时间' },
  { pattern: /\bsetInterval\(/, why: '不得自行推进时间' },
];

const FORBIDDEN_NETWORK: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /\bfetch\s*\(/, why: '不得直接发起网络请求' },
  { pattern: /require\(['"]node:(http|https|net|tls)/, why: '不得 import 原生网络模块' },
  { pattern: /from ['"]node:(http|https|net|tls)/, why: '不得 import 原生网络模块' },
  { pattern: /\bXMLHttpRequest\b/, why: '不得直接用 XHR' },
  { pattern: /['"]axios['"]/, why: '不得用第三方 HTTP 客户端' },
];

describe('M02 边界：零依赖、零网络、无环境依赖', () => {
  const sources = m02Sources();

  it('源码目录存在且非空', () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  it('不 import node:* 或第三方模块（只用相对 .js 导入）', () => {
    for (const { file, text } of sources) {
      const imports = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const spec of imports) {
        expect(spec?.startsWith('./') || spec?.startsWith('../'), `${file} 导入了非相对模块 ${spec}`).toBe(true);
      }
      expect(/node:/.test(text), `${file} 出现 node: 依赖`).toBe(false);
    }
  });

  it('不读系统时间 / 随机 / 环境，不自推时间', () => {
    for (const { file, text } of sources) {
      for (const { pattern, why } of FORBIDDEN_AMBIENT) {
        expect(pattern.test(text), `${file} 命中禁用项：${why}`).toBe(false);
      }
    }
  });

  it('不自带网络调用', () => {
    for (const { file, text } of sources) {
      for (const { pattern, why } of FORBIDDEN_NETWORK) {
        expect(pattern.test(text), `${file} 命中禁用项：${why}`).toBe(false);
      }
    }
  });
});

describe('M02 边界：描述符无秘密字段', () => {
  it('TransportRequestDescriptor 不含 token / authorization / secret / password', () => {
    const types = readFileSync(join(M02_DIR, 'types.ts'), 'utf8');
    const match = /export interface TransportRequestDescriptor \{([\s\S]*?)\n\}/.exec(types);
    expect(match).not.toBeNull();
    const body = match?.[1] ?? '';
    expect(/\b(authorization|token|secret|password)\b/i.test(body)).toBe(false);
    expect(body).toContain('keyRef');
  });
});

describe('M02 边界：不内置官方 host / 业务码表', () => {
  it('源码不含真实域名后缀', () => {
    for (const { file, text } of m02Sources()) {
      expect(/\.com\b/.test(text), `${file} 出现疑似真实域名`).toBe(false);
      expect(/meituan\.com/i.test(text), `${file} 出现真实美团域名`).toBe(false);
    }
  });

  it('导出函数里没有下单 / 支付类符号', () => {
    const forbidden = new Set(['submit', 'place', 'checkout', 'pay', 'payment', 'purchase', 'order', 'buy']);
    for (const [name, value] of Object.entries(m02)) {
      if (typeof value !== 'function') {
        continue;
      }
      const words = name
        .split(/[^A-Za-z0-9]+|(?=[A-Z])/)
        .filter((w) => w.length > 0)
        .map((w) => w.toLowerCase());
      for (const word of words) {
        expect(forbidden.has(word), `导出 ${name} 像下单/支付能力`).toBe(false);
      }
    }
  });

  it('边界常量声明：零真实网络、未接通平台、仅 fixture', () => {
    expect(m02.MOBILE_TRANSPORT_BOUNDARY.hasRealNetworkCall).toBe(false);
    expect(m02.MOBILE_TRANSPORT_BOUNDARY.connectsRealPlatform).toBe(false);
    expect(m02.MOBILE_TRANSPORT_BOUNDARY.fixtureOnlyPorts).toBe(true);
    expect(m02.MOBILE_TRANSPORT_BOUNDARY.acceptsPlaintextDescriptorSecrets).toBe(false);
  });
});

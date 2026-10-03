/**
 * M-I15 / 非官方 endpoint —— 生产副本的集成验收。
 *
 * 断言点（与 M-R06 request #2 对应）：官方 host 放行；后缀/前缀/近似仿冒、userinfo
 * 欺骗、非 https、裸 IP（v4/v6）、punycode（xn--）、非默认端口、查询串嵌套走私——一律拒；
 * **默认白名单只含 developer.meituan.com**（未核实的下单 host 绝不预置）；
 * 脱敏不泄露查询串里的敏感值。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MEITUAN_ALLOWLIST,
  M06GuardError,
  assertOfficialEndpoint,
  isHostAllowed,
  isM06GuardError,
  isOfficialEndpoint,
  redactEndpoint,
  validateEndpoint,
  withHosts,
} from '../../../src/mobile-plugins/meituan/injection-guard/index.js';
import { INJECTED_ALLOWLIST } from './support.js';

function codeOf(url: unknown, allowlist?: Parameters<typeof validateEndpoint>[1]): string | undefined {
  const v = validateEndpoint(url, allowlist);
  return v.ok ? undefined : v.code;
}

describe('默认白名单的诚实边界', () => {
  it('只登记 developer.meituan.com；不预置未核实的下单 host', () => {
    expect(DEFAULT_MEITUAN_ALLOWLIST.hosts).toEqual(['developer.meituan.com']);
    expect(DEFAULT_MEITUAN_ALLOWLIST.hosts).toHaveLength(1);
    expect(DEFAULT_MEITUAN_ALLOWLIST.wildcardHosts).toEqual([]);
    // 未核实的 api.meituan.com 必须被拒——预置它正是本包要拦的洞。
    expect(codeOf('https://api.meituan.com/order/submit')).toBe('non_official_endpoint');
  });
});

describe('官方 endpoint 放行', () => {
  it('developer.meituan.com https 通过', () => {
    const ep = assertOfficialEndpoint('https://developer.meituan.com/ai-hub');
    expect(ep.scheme).toBe('https');
    expect(ep.host).toBe('developer.meituan.com');
    expect(ep.port).toBe(443);
    expect(isOfficialEndpoint('https://developer.meituan.com/ai-hub')).toBe(true);
  });

  it('显式 :443 端口通过', () => {
    expect(isOfficialEndpoint('https://developer.meituan.com:443/x')).toBe(true);
  });

  it('host 大小写归一', () => {
    expect(isOfficialEndpoint('https://Developer.MeiTuan.com/x')).toBe(true);
  });
});

describe('仿冒 host 被拒', () => {
  const cases: readonly [string, string][] = [
    ['后缀仿冒', 'https://developer.meituan.com.evil.com/x'],
    ['前缀仿冒', 'https://evil-meituan.com/x'],
    ['近似仿冒', 'https://notmeituan.com/x'],
    ['裸域不在白名单', 'https://meituan.com/x'],
    ['子域不在白名单', 'https://api.developer.meituan.com/x'],
  ];
  for (const [label, url] of cases) {
    it(`${label}: ${url}`, () => {
      expect(codeOf(url)).toBe('non_official_endpoint');
    });
  }

  it('userinfo 欺骗 https://official@evil 被拒（host 实为 evil.com）', () => {
    const v = validateEndpoint('https://developer.meituan.com@evil.com/x');
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('invalid_endpoint_url');
      expect(v.host).toBe('evil.com');
    }
  });
});

describe('scheme / 端口 / 主机形态', () => {
  it('http 降级被拒', () => {
    expect(codeOf('http://developer.meituan.com/x')).toBe('insecure_endpoint_scheme');
  });
  it('javascript: 被拒', () => {
    expect(codeOf('javascript:alert(1)')).toBe('insecure_endpoint_scheme');
  });
  it('data: 被拒', () => {
    expect(codeOf('data:text/html,<script>alert(1)</script>')).toBe('insecure_endpoint_scheme');
  });
  it('ws: 被拒', () => {
    expect(codeOf('ws://developer.meituan.com/socket')).toBe('insecure_endpoint_scheme');
  });
  it('裸 IPv4 被拒', () => {
    expect(codeOf('https://203.0.113.9/x')).toBe('ip_literal_endpoint');
  });
  it('裸 IPv6 被拒', () => {
    expect(codeOf('https://[2001:db8::1]/x')).toBe('ip_literal_endpoint');
  });
  it('punycode 同形被拒', () => {
    expect(codeOf('https://xn--meituan-9d0b.com/x')).toBe('non_ascii_host');
  });
  it('非默认端口被拒', () => {
    expect(codeOf('https://developer.meituan.com:8443/x')).toBe('non_default_port');
  });
});

describe('端点走私（查询串嵌套非官方绝对 URL）', () => {
  it('redirect 参数指向 evil 被拒', () => {
    expect(codeOf('https://developer.meituan.com/redirect?url=https://evil.com/x')).toBe(
      'nested_non_official_endpoint',
    );
  });
  it('嵌套指向官方 host 允许', () => {
    expect(isOfficialEndpoint('https://developer.meituan.com/r?url=https://developer.meituan.com/y')).toBe(true);
  });
  it('非绝对 URL 的查询值不误伤', () => {
    expect(isOfficialEndpoint('https://developer.meituan.com/r?q=abc&n=2')).toBe(true);
  });
});

describe('非法输入', () => {
  it('空串 / 非字符串 / 不可解析', () => {
    expect(codeOf('')).toBe('invalid_endpoint_url');
    expect(codeOf('   ')).toBe('invalid_endpoint_url');
    expect(codeOf('not a url')).toBe('invalid_endpoint_url');
    expect(codeOf(null)).toBe('invalid_endpoint_url');
    expect(codeOf(42)).toBe('invalid_endpoint_url');
  });
});

describe('通配白名单（经注入）只匹配真正的子域', () => {
  it('单层子域匹配', () => {
    expect(isHostAllowed('api.meituan.example', INJECTED_ALLOWLIST)).toBe(true);
    expect(isOfficialEndpoint('https://api.meituan.example/v1/menu', INJECTED_ALLOWLIST)).toBe(true);
  });
  it('多层子域匹配', () => {
    expect(isOfficialEndpoint('https://foo.bar.meituan.example/x', INJECTED_ALLOWLIST)).toBe(true);
  });
  it('裸后缀本身不匹配', () => {
    expect(isOfficialEndpoint('https://meituan.example/x', INJECTED_ALLOWLIST)).toBe(false);
  });
  it('前缀粘连不匹配（evilmeituan.example）', () => {
    expect(isOfficialEndpoint('https://evilmeituan.example/x', INJECTED_ALLOWLIST)).toBe(false);
  });
  it('后缀拼接到攻击域不匹配（api.meituan.example.evil.com）', () => {
    expect(isOfficialEndpoint('https://api.meituan.example.evil.com/x', INJECTED_ALLOWLIST)).toBe(false);
  });
  it('withHosts 追加精确 host 且不改默认对象', () => {
    const extended = withHosts(DEFAULT_MEITUAN_ALLOWLIST, 'SHOP.meituan.example');
    expect(extended.hosts).toContain('shop.meituan.example');
    expect(DEFAULT_MEITUAN_ALLOWLIST.hosts).toEqual(['developer.meituan.com']);
    expect(isOfficialEndpoint('https://shop.meituan.example/x', extended)).toBe(true);
  });
});

describe('脱敏不泄露查询串', () => {
  it('redactEndpoint 丢弃 query / userinfo / fragment', () => {
    const red = redactEndpoint('https://developer.meituan.com/ai-hub?token=SECRETVALUE#frag');
    expect(red).toBe('https://developer.meituan.com/ai-hub');
    expect(red.includes('SECRETVALUE')).toBe(false);
  });
  it('不可解析串返回占位符', () => {
    expect(redactEndpoint('not a url')).toBe('(unparseable-url)');
  });
  it('校验结果的 redacted 也不含查询串', () => {
    const ep = assertOfficialEndpoint('https://developer.meituan.com/x?key=abc');
    expect(ep.redacted.includes('abc')).toBe(false);
  });
});

describe('硬拒抛 M06GuardError', () => {
  it('抛出的错误类型与 code 稳定', () => {
    let caught: unknown;
    try {
      assertOfficialEndpoint('http://developer.meituan.com/x');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(M06GuardError);
    expect(isM06GuardError(caught)).toBe(true);
    expect((caught as M06GuardError).code).toBe('insecure_endpoint_scheme');
  });
});

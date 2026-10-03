/**
 * M-I15 —— **可 import 的生产闸门**集成验收（M-R06 request #2 的落地证明）。
 *
 * Wave-1 的三道闸门原先只存在于 `tests/mobile-meituan/M-R06/`，下游无法作为库 import。
 * 本用例证明 `src/mobile-plugins/meituan/injection-guard/` 现在是**可 import 的稳定出口**，
 * 并把三条下游会真实使用的调用链端到端串一遍（描述信封 → 工具参数 → endpoint）。
 */

import { describe, expect, it } from 'vitest';

import * as guard from '../../../src/mobile-plugins/meituan/injection-guard/index.js';
import {
  DEFAULT_MEITUAN_ALLOWLIST,
  assertOfficialEndpoint,
  assertToolCallAllowed,
  buildDescriptionEnvelope,
  renderDescriptionDataBlock,
  validateToolCall,
  withHosts,
} from '../../../src/mobile-plugins/meituan/injection-guard/index.js';
import { DESCRIPTIONS, REAL_MEITUAN_SCHEMAS } from './support.js';

describe('生产出口可 import', () => {
  it('三道闸门以函数形态从 src 出口导出', () => {
    expect(typeof guard.buildDescriptionEnvelope).toBe('function');
    expect(typeof guard.renderDescriptionDataBlock).toBe('function');
    expect(typeof guard.assertToolCallAllowed).toBe('function');
    expect(typeof guard.assertOfficialEndpoint).toBe('function');
    expect(typeof guard.withHosts).toBe('function');
  });

  it('默认白名单**只**含 developer.meituan.com（不预置未核实 host）', () => {
    expect(DEFAULT_MEITUAN_ALLOWLIST.hosts).toEqual(['developer.meituan.com']);
    expect(DEFAULT_MEITUAN_ALLOWLIST.wildcardHosts).toEqual([]);
  });
});

describe('下游调用链：良性输入三道闸全放行', () => {
  it('描述信封 → 数据块围栏 → 工具参数 → endpoint', () => {
    // 1) 描述：良性，给数据信封。
    const env = buildDescriptionEnvelope(DESCRIPTIONS.benign, { source: 'dish:beef-noodle' });
    expect(env.trust).toBe('untrusted_data');
    const block = renderDescriptionDataBlock(env);
    expect(block).toContain('<DATA source="untrusted_merchant_description">');
    expect(block).toContain('</DATA>');

    // 2) 工具参数：真实 schema 下合法调用放行。
    const call = assertToolCallAllowed(REAL_MEITUAN_SCHEMAS, {
      toolId: 'cap.meituan.search',
      arguments: { category: '火锅', location: '徐汇', people: 2 },
    });
    expect(call.droppedParameters).toEqual([]);

    // 3) endpoint：官方 host 放行。
    const ep = assertOfficialEndpoint('https://developer.meituan.com/ai-hub');
    expect(ep.host).toBe('developer.meituan.com');
  });
});

describe('下游调用链：注入输入在对应闸门被拦', () => {
  it('描述注入 → description_injection_blocked', () => {
    expect(() => buildDescriptionEnvelope(DESCRIPTIONS.override, { source: 'm:1' })).toThrowError(
      /description_injection_blocked/,
    );
  });

  it('工具越权参数 → 整调用被拒且 droppedParameters 无出口', () => {
    const v = validateToolCall(REAL_MEITUAN_SCHEMAS, {
      toolId: 'cap.meituan.search',
      arguments: { category: '火锅', location: '徐汇', submit_order: { amount: 1 } },
    });
    expect(v.ok).toBe(false);
    // ok:false 的形状里**没有** ValidatedToolCall / droppedParameters 字段。
    expect(Object.prototype.hasOwnProperty.call(v, 'call')).toBe(false);
  });

  it('非官方 endpoint → non_official_endpoint', () => {
    expect(() => assertOfficialEndpoint('https://api.meituan.com/order/submit')).toThrowError(
      /non_official_endpoint/,
    );
  });

  it('经核实 host 注入后可放行（withHosts 不改默认对象）', () => {
    const extended = withHosts(DEFAULT_MEITUAN_ALLOWLIST, 'api.meituan.example');
    expect(assertOfficialEndpoint('https://api.meituan.example/v1/menu', extended).host).toBe('api.meituan.example');
    // 默认对象保持诚实边界。
    expect(DEFAULT_MEITUAN_ALLOWLIST.hosts).toEqual(['developer.meituan.com']);
    // 注入的白名单不影响默认白名单的判定。
    expect(validateEndpointGuard('https://api.meituan.example/v1/menu')).toBe(false);
  });
});

/** 便捷：用默认白名单判断（避免直接 import validateEndpoint 拉宽本用例的导入面）。 */
function validateEndpointGuard(url: string): boolean {
  return guard.isOfficialEndpoint(url);
}

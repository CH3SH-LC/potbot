/**
 * M01：**真实记录的**只读探针必须忠于实际观察。
 *
 * 这些用例把"我们真的看到了什么"钉死：五个官方页面都只返回站点标题、都不可读；
 * 没有一条探针被伪造成"读到了正文"。真实证据就是本包的全部底气。
 */

import { describe, expect, it } from 'vitest';

import {
  OBSERVED_EMPTY_SHELL_TEXT,
  RECORDED_PROBES,
  buildCapabilityMatrix,
  isOfficialMeituanHost,
} from '../../../src/mobile-plugins/meituan/capability-discovery/index.js';

describe('M01 真实探针记录', () => {
  it('共 5 条探针，全部来自官方 meituan.com', () => {
    expect(RECORDED_PROBES.length).toBe(5);
    for (const probe of RECORDED_PROBES) {
      expect(probe.officialHost).toBe(true);
      expect(isOfficialMeituanHost(probe.url)).toBe(true);
      expect(probe.method).toBe('unauthenticated-readonly-fetch');
    }
  });

  it('全部探针可及但**正文不可读**（只读到站点标题）', () => {
    for (const probe of RECORDED_PROBES) {
      expect(probe.reachable).toBe(true);
      expect(probe.readableContent).toBe(false);
      expect(probe.observedText).toBe(OBSERVED_EMPTY_SHELL_TEXT);
      expect(probe.observedTitle).toBe(OBSERVED_EMPTY_SHELL_TEXT);
    }
  });

  it('探针 ID 唯一，URL 全部是官方页面', () => {
    const ids = RECORDED_PROBES.map((probe) => probe.probeId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const probe of RECORDED_PROBES) {
      expect(probe.url.startsWith('https://developer.meituan.com/')).toBe(true);
    }
  });

  it('默认构造（用真实探针、无证据）⇒ 全 unverified', () => {
    const matrix = buildCapabilityMatrix();
    expect(matrix.allUnverified).toBe(true);
    expect(matrix.probes.length).toBe(5);
  });

  it('官/非官方判定：子域算官方，伪造后缀不算', () => {
    expect(isOfficialMeituanHost('https://openapi.waimai.meituan.com/x')).toBe(true);
    expect(isOfficialMeituanHost('https://meituan.com.evil.example/x')).toBe(false);
    expect(isOfficialMeituanHost('https://notmeituan.com/x')).toBe(false);
    expect(isOfficialMeituanHost('not a url')).toBe(false);
  });
});

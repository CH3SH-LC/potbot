/**
 * 能力发现单测（design-06 P6 / PLG-06；合同 R228 / R231 / R233）。
 *
 * 覆盖：
 * - **正例**：五态是**五个独立问题**——逐态单独为假都会让 `ready` 为假，且 `false_states` 指名道姓；
 * - **正例**：可用操作清单**按需读取、长度受限、不含指令全文**；
 * - **反例 1**：未就绪插件（未装 / 未启 / 未授权 / 缺依赖 / 未实测 / stub）**不出现**在清单里；
 * - **反例 2**：超过上限**显式截断**（`entries.length ≤ limit`、`omitted_count` 对得上）；
 * - **反例 3**：非法上限（0 / 非整数）抛错；指令全文泄露可被检出。
 */

import { describe, expect, it } from 'vitest';

import { asCapabilityId, asLogicalTime } from '../protocol/index.js';
import {
  DISCOVERY_STATE_KEYS,
  OPERATION_LIST_DEFAULT_LIMIT,
  boundOperations,
  findInstructionLeaks,
  readAvailableOperations,
  stateVector,
  stateVectors,
} from './capability-discovery.js';
import { BUSINESS_TEMPLATES, PLUGIN_CATALOG } from './catalog.js';
import { createPluginRegistry, type DiscoveryProbes } from './registry.js';

const L = asLogicalTime;

/** 一切都就绪（正例探针）。 */
const allReady: DiscoveryProbes = {
  dependencies: { isAdapterReady: () => true },
  support: { isActuallySupported: () => true },
};
/** 只缺依赖（能力实测支持，但必需适配器没接）。 */
const missingDeps: DiscoveryProbes = {
  dependencies: { isAdapterReady: () => false },
  support: { isActuallySupported: () => true },
};
/** 依赖就绪但未被实测支持。 */
const unsupported: DiscoveryProbes = {
  dependencies: { isAdapterReady: () => true },
  support: { isActuallySupported: () => false },
};

const OFFICE = ['template.document', 'template.spreadsheet', 'template.presentation'] as const;

/** 装 + 启（内置来源默认受信，故已授权）三个办公模板。 */
function enableOffice() {
  const registry = createPluginRegistry();
  let tick = 0;
  for (const id of OFFICE) {
    tick += 1;
    registry.install(id, { at: L(tick) });
    tick += 1;
    registry.enable(id, L(tick));
  }
  return registry;
}

describe('PLG-06 五态：五个独立问题，逐态可指认', () => {
  it('未安装时只有 installed / enabled / authorized 为假，依赖与实测支持可独立为真', () => {
    const registry = createPluginRegistry();
    const discovery = registry.discover('template.document', allReady);
    expect(discovery).toBeDefined();
    const vector = stateVector(discovery!);
    expect(vector.states.installed).toBe(false);
    expect(vector.states.dependencies_ready).toBe(true);
    expect(vector.states.actually_supported).toBe(true);
    expect(vector.ready).toBe(false);
    expect(vector.false_states).toEqual(['installed', 'enabled', 'authorized']);
    for (const key of vector.false_states) {
      expect(DISCOVERY_STATE_KEYS).toContain(key);
    }
    expect(vector.not_ready_reasons.length).toBeGreaterThan(0);
  });

  it('五态全真才 ready；逐态单独为假都会让 ready 为假且 false_states 指名', () => {
    // 基线：五态全真
    const baseline = stateVector(enableOffice().discover('template.document', allReady)!);
    expect(baseline.false_states).toEqual([]);
    expect(baseline.ready).toBe(true);

    // 逐态单独为假
    const notInstalled = stateVector(createPluginRegistry().discover('template.document', allReady)!);
    expect(notInstalled.ready).toBe(false);
    expect(notInstalled.false_states).toContain('installed');

    const installedOnly = createPluginRegistry();
    installedOnly.install('template.document', { at: L(1) });
    const notEnabled = stateVector(installedOnly.discover('template.document', allReady)!);
    expect(notEnabled.ready).toBe(false);
    expect(notEnabled.states.installed).toBe(true);
    expect(notEnabled.false_states).toContain('enabled');

    const revoked = enableOffice();
    revoked.revokeAuthorization('template.document', L(99));
    const notAuthorized = stateVector(revoked.discover('template.document', allReady)!);
    expect(notAuthorized.ready).toBe(false);
    expect(notAuthorized.false_states).toContain('authorized');

    const depsMissing = stateVector(enableOffice().discover('template.document', missingDeps)!);
    expect(depsMissing.ready).toBe(false);
    expect(depsMissing.false_states).toEqual(['dependencies_ready']);

    const notSupported = stateVector(enableOffice().discover('template.document', unsupported)!);
    expect(notSupported.ready).toBe(false);
    expect(notSupported.false_states).toEqual(['actually_supported']);
  });

  it('stub 清单永不就绪：即便五态全真，stub 仍是五态之外的独立否决项（R233）', () => {
    const registry = createPluginRegistry();
    registry.install('template.meituan', { at: L(1) });
    registry.enable('template.meituan', L(2));
    const vector = stateVector(registry.discover('template.meituan', allReady)!);
    expect(vector.stub).toBe(true);
    expect(vector.ready).toBe(false);
    // 探针说"依赖就绪、能力实测支持" ⇒ 五态确实全真；但 stub 独立否决，ready 仍为假。
    expect(vector.false_states).toEqual([]);
    expect(vector.states.actually_supported).toBe(true);
    expect(vector.not_ready_reasons.join(' ')).toContain('stub');
    // stub 永不进可用操作清单
    expect(readAvailableOperations(registry, allReady).total_available).toBe(0);
  });

  it('stateVectors 对整份已载入目录给向量（数量与发现结果一致）', () => {
    const registry = enableOffice();
    expect(stateVectors(registry, allReady)).toHaveLength(registry.discoverAll(allReady).length);
  });
});

describe('PLG-06 可用操作清单：按需读取、长度受限、不含指令全文', () => {
  it('只列就绪插件的能力标签；条目只有三个字段，无指令全文', () => {
    const registry = enableOffice();
    const listing = readAvailableOperations(registry, allReady);
    expect(listing.total_available).toBe(9); // 三个办公模板 × 各有 3 条能力
    expect(listing.entries).toHaveLength(9);
    expect(listing.truncated).toBe(false);
    expect(listing.omitted_count).toBe(0);
    expect(listing.limit).toBe(OPERATION_LIST_DEFAULT_LIMIT);
    for (const entry of listing.entries) {
      expect(Object.keys(entry).sort()).toEqual(['capability_id', 'label', 'plugin_id']);
      expect(entry.label.length).toBeGreaterThan(0);
      expect('instructions' in entry).toBe(false);
    }
    // 没有任何一条把指令全文当成标签塞进来
    expect(findInstructionLeaks(listing.entries, PLUGIN_CATALOG)).toEqual([]);
  });

  it('反例：未就绪插件不进清单——只装不启时清单为空，启用后才出现', () => {
    const registry = createPluginRegistry();
    registry.install('template.document', { at: L(1) });
    expect(readAvailableOperations(registry, allReady).total_available).toBe(0);

    registry.enable('template.document', L(2));
    expect(readAvailableOperations(registry, allReady).total_available).toBe(3);
  });

  it('反例：超过上限显式截断，`entries.length ≤ limit` 且省略数对得上', () => {
    const registry = enableOffice();
    const listing = readAvailableOperations(registry, allReady, { limit: 2 });
    expect(listing.total_available).toBe(9);
    expect(listing.entries).toHaveLength(2);
    expect(listing.entries.length).toBeLessThanOrEqual(listing.limit);
    expect(listing.truncated).toBe(true);
    expect(listing.omitted_count).toBe(7);
    expect(listing.omitted_count).toBe(listing.total_available - listing.entries.length);
  });

  it('反例：非法上限（0 / 非整数）抛错——无上限等于没有约束', () => {
    expect(() => boundOperations([], 0)).toThrow(/上限/);
    expect(() => boundOperations([], -3)).toThrow(/上限/);
    expect(() => boundOperations([], 1.5)).toThrow(/上限/);
  });

  it('反例：把指令全文当标签塞进清单会被检出', () => {
    const instruction = BUSINESS_TEMPLATES[0]!.instructions[0]!;
    const leaky = [
      { plugin_id: 'template.document' as const, capability_id: asCapabilityId('cap.doc.create'), label: instruction },
    ];
    expect(findInstructionLeaks(leaky, PLUGIN_CATALOG)).toEqual([instruction]);
  });
});

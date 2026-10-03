/**
 * K-I10 独立验证 ①：**投影纯函数**。四态 → K05 两布尔的逐条映射、缺席模板、撞名合并、
 * 摘要确定性，以及"判定只读探针、不读 manifest 自称"这条单一来源纪律。
 *
 * 每条负例都配正向对照，证明投影不是"恒缺席 / 恒阻塞"的空壳。
 */

import { describe, expect, it } from 'vitest';

import {
  coalesceProviders,
  findCollisions,
  isAbsentTemplate,
  projectCapabilityDiscovery,
  projectCapabilityInventory,
  projectCapabilityProviders,
} from '../../../apps/mobile-kernel/adapters/capability-discovery/index.js';
import {
  absentSnapshot,
  blockedState,
  readiness,
  snapshot,
  syntheticManifest,
} from './fixtures.js';

const DOC = syntheticManifest('document', ['cap.doc.create', 'cap.doc.edit']);
const SHEET = syntheticManifest('spreadsheet', ['cap.sheet.create']);

describe('K-I10 投影 · 四态 → authorized/executable 的逐条映射', () => {
  it('四态俱 ready ⇒ authorized=true、executable=true、无 note', () => {
    const inventory = projectCapabilityInventory([snapshot(DOC, readiness({}, 'document'))]);
    expect(inventory).toEqual([
      { capability_id: 'cap.doc.create', template_id: 'document', authorized: true, executable: true },
      { capability_id: 'cap.doc.edit', template_id: 'document', authorized: true, executable: true },
    ]);
    // 每个 manifest 声明的能力都出现，不丢项（单一来源：能力清单取自 manifest）
    expect(inventory.map((entry) => entry.capability_id)).toEqual([...DOC.capabilities]);
  });

  it('authorized not-ready ⇒ authorized=false（K05 将判 capability_not_authorized）', () => {
    const inventory = projectCapabilityInventory([
      snapshot(DOC, readiness({ authorized: blockedState('permission_not_granted:file-write') }, 'document')),
    ]);
    expect(inventory).toHaveLength(2);
    for (const entry of inventory) {
      expect(entry.authorized).toBe(false);
      expect(entry.executable).toBe(true); // enabled 与 portReady 仍就绪
      expect(entry.note).toContain('authorized:permission_not_granted:file-write');
    }
  });

  it('enabled not-ready（停用）⇒ executable=false（K05 将判 capability_not_executable）', () => {
    const inventory = projectCapabilityInventory([
      snapshot(SHEET, readiness({ enabled: blockedState('disabled') }, 'spreadsheet')),
    ]);
    expect(inventory).toHaveLength(1);
    expect(inventory[0]?.authorized).toBe(true);
    expect(inventory[0]?.executable).toBe(false);
    expect(inventory[0]?.note).toContain('enabled:disabled');
  });

  it('portReady not-ready（端口未就绪）⇒ executable=false', () => {
    const inventory = projectCapabilityInventory([
      snapshot(SHEET, readiness({ portReady: blockedState('capability_unavailable:cap.sheet.create') }, 'spreadsheet')),
    ]);
    expect(inventory[0]?.authorized).toBe(true);
    expect(inventory[0]?.executable).toBe(false);
    expect(inventory[0]?.note).toContain('portReady:capability_unavailable:cap.sheet.create');
  });

  it('多态同时 not-ready ⇒ note 汇总每一条原因', () => {
    const inventory = projectCapabilityInventory([
      snapshot(
        SHEET,
        readiness(
          { enabled: blockedState('disabled'), portReady: blockedState('capability_unavailable:cap.sheet.create') },
          'spreadsheet',
        ),
      ),
    ]);
    expect(inventory[0]?.note).toBe(
      'enabled:disabled; portReady:capability_unavailable:cap.sheet.create',
    );
  });
});

describe('K-I10 投影 · 缺席模板（未安装）不进目录', () => {
  it('installed not-ready ⇒ 无条目 + 记入 absent_template_ids', () => {
    const projection = projectCapabilityDiscovery([
      snapshot(DOC, readiness({ installed: blockedState('uninstalled') }, 'document')),
      snapshot(SHEET, readiness({}, 'spreadsheet')),
    ]);
    expect(projection.capabilities.map((entry) => entry.capability_id)).toEqual(['cap.sheet.create']);
    expect(projection.absent_template_ids).toEqual(['document']);
    expect(projection.providers.map((provider) => provider.template_id)).toEqual(['spreadsheet']);
  });

  it('readiness === null（宿主没有任何安装版本）⇒ 同样缺席，且不伪造报告', () => {
    const projection = projectCapabilityDiscovery([absentSnapshot(DOC)]);
    expect(projection.capabilities).toEqual([]);
    expect(projection.absent_template_ids).toEqual(['document']);
    expect(isAbsentTemplate(absentSnapshot(DOC))).toBe(true);
    // 对照：同一 manifest 只要探针报四态俱 ready，就出现
    expect(projectCapabilityInventory([snapshot(DOC, readiness({}, 'document'))])).toHaveLength(2);
  });
});

describe('K-I10 投影 · 单一来源：判定只读探针，不读 manifest 自称', () => {
  it('manifest.probe 全 true 但 installed not-ready ⇒ 仍判缺席（不采信自称）', () => {
    const boastful = {
      ...syntheticManifest('boastful', ['cap.boast']),
      probe: {
        installed: true,
        enabled: true,
        authorized: true,
        portReady: true,
        verificationMode: 'fixture' as const,
        layers: ['unit'] as const,
      },
    };
    const projection = projectCapabilityDiscovery([
      snapshot(boastful, readiness({ installed: blockedState('uninstalled') }, 'boastful')),
    ]);
    expect(projection.capabilities).toEqual([]);
    expect(projection.absent_template_ids).toEqual(['boastful']);
  });

  it('manifest.probe 全 false 但探针报四态俱 ready ⇒ 仍可调度（probe 字段不值钱）', () => {
    // syntheticManifest 默认 probe 全 false。
    const inventory = projectCapabilityInventory([snapshot(DOC, readiness({}, 'document'))]);
    expect(inventory.every((entry) => entry.authorized && entry.executable)).toBe(true);
  });
});

describe('K-I10 投影 · 同一能力被多模板声明的合并口径', () => {
  const A = syntheticManifest('alpha', ['cap.shared', 'cap.alpha-only']);
  const B = syntheticManifest('beta', ['cap.shared', 'cap.beta-only']);

  it('合并取秩最高者：一个就绪、一个未授权 ⇒ 取就绪的提供者', () => {
    const providers = projectCapabilityProviders([
      snapshot(A, readiness({}, 'alpha')), // 全就绪 ⇒ rank 3
      snapshot(B, readiness({ authorized: blockedState('permission_not_granted:storage') }, 'beta')), // rank 1
    ]);
    const inventory = coalesceProviders(providers);
    const shared = inventory.find((entry) => entry.capability_id === 'cap.shared');
    expect(shared?.template_id).toBe('alpha');
    expect(shared?.authorized).toBe(true);
    expect(shared?.executable).toBe(true);
    // 撞名不隐藏：全部提供者仍在诊断视图里，并登记进 collisions
    expect(providers.filter((provider) => provider.capability_id === 'cap.shared')).toHaveLength(2);
    expect(findCollisions(providers)).toEqual([{ capability_id: 'cap.shared', template_ids: ['alpha', 'beta'] }]);
  });

  it('秩相同时取输入顺序在前者（确定性）', () => {
    const providers = projectCapabilityProviders([
      snapshot(A, readiness({}, 'alpha')),
      snapshot(B, readiness({}, 'beta')),
    ]);
    const shared = coalesceProviders(providers).find((entry) => entry.capability_id === 'cap.shared');
    expect(shared?.template_id).toBe('alpha');
    // 反向顺序 ⇒ 取 beta，证明是"顺序"而非"id 字典序"决定
    const reversed = coalesceProviders(
      projectCapabilityProviders([snapshot(B, readiness({}, 'beta')), snapshot(A, readiness({}, 'alpha'))]),
    );
    expect(reversed.find((entry) => entry.capability_id === 'cap.shared')?.template_id).toBe('beta');
  });

  it('两个提供者都不可用 ⇒ 取秩较高者（已授权优先），仍登记冲突', () => {
    const providers = projectCapabilityProviders([
      snapshot(A, readiness({ authorized: blockedState('permission_not_granted:storage') }, 'alpha')), // rank 1
      snapshot(B, readiness({ enabled: blockedState('disabled') }, 'beta')), // authorized=true, executable=false ⇒ rank 2
    ]);
    const shared = coalesceProviders(providers).find((entry) => entry.capability_id === 'cap.shared');
    expect(shared?.template_id).toBe('beta');
    expect(shared?.authorized).toBe(true);
    expect(shared?.executable).toBe(false);
  });
});

describe('K-I10 投影 · 确定性与摘要', () => {
  it('同输入恒同摘要；就绪变化 ⇒ 摘要变化', () => {
    const input = [snapshot(DOC, readiness({}, 'document')), snapshot(SHEET, readiness({}, 'spreadsheet'))];
    const first = projectCapabilityDiscovery(input);
    const second = projectCapabilityDiscovery(input);
    expect(first.digest).toBe(second.digest);

    const changed = projectCapabilityDiscovery([
      snapshot(DOC, readiness({ authorized: blockedState('permission_not_granted:file-write') }, 'document')),
      snapshot(SHEET, readiness({}, 'spreadsheet')),
    ]);
    expect(changed.digest).not.toBe(first.digest);
  });

  it('projectCapabilityInventory 与完整投影的 capabilities 一致（同一合并结果）', () => {
    const input = [snapshot(DOC, readiness({}, 'document')), snapshot(SHEET, readiness({}, 'spreadsheet'))];
    expect(projectCapabilityInventory(input)).toEqual(projectCapabilityDiscovery(input).capabilities);
  });
});

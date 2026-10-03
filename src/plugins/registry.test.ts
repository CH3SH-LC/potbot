/**
 * 注册表单测：安装 / 启用 / 停用 / 卸载的**持久状态**与**五态能力发现**
 * （design-06 P6；合同 R228 / R230 / R231 / R233）。
 *
 * 重点：
 * - 安装 ≠ 启用 ≠ 授权 ≠ 依赖就绪 ≠ 实测支持，五态**互相独立**（R231）；
 * - 停用阻止新实例、撤权**即时**生效（R230）；
 * - stub **永不**判就绪（R233）；
 * - 持久快照恢复后启用状态保留，且**更晚的卸载不被更早的快照复活**。
 */

import { describe, expect, it } from 'vitest';

import {
  PluginRegistry,
  conservativeProbes,
  createPluginRegistry,
  describeDiscovery,
  emptyRegistrySnapshot,
  type DiscoveryProbes,
  type PluginManifest,
} from './index.js';
import { findPluginManifest } from './catalog.js';
import { asLogicalTime } from '../protocol/index.js';

/** 逻辑时间快捷构造（测试里大量使用数字字面量）。 */
const L = asLogicalTime;

/** 探针：所有适配器就绪、所有能力实测支持——用于构造"真正就绪"的正例。 */
const allReady: DiscoveryProbes = {
  dependencies: { isAdapterReady: () => true },
  support: { isActuallySupported: () => true },
};

function mustFind(pluginId: string): PluginManifest {
  const manifest = findPluginManifest(pluginId);
  if (manifest === undefined) throw new Error(`缺 ${pluginId}`);
  return manifest;
}

describe('安装 / 启用 / 停用 / 卸载（PLG-02 / R228）', () => {
  it('安装后是 installed 但**未启用**；启用、停用、卸载各自改变持久状态', () => {
    const registry = createPluginRegistry();
    const install = registry.install('template.document', { at: L(1) });
    expect(install.ok).toBe(true);
    if (!install.ok) return;
    expect(install.record.installed).toBe(true);
    expect(install.record.enabled).toBe(false); // 安装 ≠ 启用
    expect(install.record.authorized).toBe(true); // 内置默认受信

    expect(registry.enable('template.document', L(2)).enabled).toBe(true);
    expect(registry.disable('template.document', L(3)).enabled).toBe(false);
    const removed = registry.uninstall('template.document', L(4));
    expect(removed.installed).toBe(false);
    expect(removed.enabled).toBe(false);
    expect(removed.authorized).toBe(false);
  });

  it('每次变更都推进状态版本号（回归时可核对"确实变了"）', () => {
    const registry = createPluginRegistry();
    const before = registry.revision;
    registry.install('template.document', { at: L(1) });
    expect(registry.revision).toBeGreaterThan(before);
  });

  it('安装未知插件 / 重复安装 / 非内置来源 / 内核不兼容 各自给出结构化失败', () => {
    const registry = createPluginRegistry();

    const unknown = registry.install('template.nope', { at: L(1) });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toBe('unknown_plugin');

    registry.install('template.document', { at: L(1) });
    const again = registry.install('template.document', { at: L(2) });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('already_installed');

    const badSource = registry.install('template.spreadsheet', {
      at: L(1),
      source: { kind: 'declarative_package', origin: 'pkg.x' },
    });
    expect(badSource.ok).toBe(false);
    if (!badSource.ok) expect(badSource.reason).toBe('source_not_acceptable');

    const oldKernel = createPluginRegistry({ kernelVersion: '0.1.0' });
    const incompatible = oldKernel.install('template.document', { at: L(1) });
    expect(incompatible.ok).toBe(false);
    if (!incompatible.ok) expect(incompatible.reason).toBe('version_incompatible');
  });
});

describe('五态能力发现（PLG-06 / R231 / R233）', () => {
  it('未安装 ⇒ 五态全假，且**先给未就绪原因**', () => {
    const registry = createPluginRegistry();
    const discovery = registry.discover('template.document', allReady);
    expect(discovery).toBeDefined();
    if (discovery === undefined) return;
    expect(discovery.installed).toBe(false);
    expect(discovery.ready).toBe(false);
    expect(discovery.not_ready_reasons.length).toBeGreaterThan(0);
    expect(discovery.not_ready_reasons.join(' ')).toContain('未安装');
    expect(discovery.available_operations).toEqual([]);
  });

  it('已安装未启用 ⇒ 未就绪，原因是"未启用"（停用阻止新实例）', () => {
    const registry = createPluginRegistry();
    registry.install('template.document', { at: L(1) });
    const discovery = registry.discover('template.document', allReady);
    if (discovery === undefined) throw new Error('应有发现结果');
    expect(discovery.installed).toBe(true);
    expect(discovery.enabled).toBe(false);
    expect(discovery.ready).toBe(false);
    expect(discovery.not_ready_reasons.join(' ')).toContain('未启用');
  });

  it('依赖未就绪与实测支持是**独立**的两态，缺失时分别给出原因', () => {
    const registry = createPluginRegistry();
    registry.install('template.document', { at: L(1) });
    registry.enable('template.document', L(2));

    // 依赖就绪但未实测支持 ⇒ 仍不就绪，原因是"未实测支持"
    const depsReadyOnly = registry.discover(
      'template.document',
      conservativeProbes({ readyAdapters: ['builtin.docx_builder'] }),
    );
    if (depsReadyOnly === undefined) throw new Error('应有发现结果');
    expect(depsReadyOnly.dependencies_ready).toBe(true);
    expect(depsReadyOnly.actually_supported).toBe(false);
    expect(depsReadyOnly.ready).toBe(false);
    expect(depsReadyOnly.not_ready_reasons.join(' ')).toContain('未实测支持');

    // 什么都没就绪 ⇒ 依赖原因出现在清单里
    const nothingReady = registry.discover('template.document', conservativeProbes());
    if (nothingReady === undefined) throw new Error('应有发现结果');
    expect(nothingReady.dependencies_ready).toBe(false);
    expect(nothingReady.not_ready_reasons.join(' ')).toContain('依赖未就绪');
    expect(nothingReady.not_ready_reasons.join(' ')).toContain('builtin.docx_builder');
  });

  it('五态全真才算就绪，并给出**可用操作清单（只有标签，无指令全文）**', () => {
    const registry = createPluginRegistry();
    registry.install('template.document', { at: L(1) });
    registry.enable('template.document', L(2));

    const discovery = registry.discover('template.document', allReady);
    if (discovery === undefined) throw new Error('应有发现结果');
    expect(discovery.installed && discovery.enabled && discovery.authorized).toBe(true);
    expect(discovery.dependencies_ready && discovery.actually_supported).toBe(true);
    expect(discovery.ready).toBe(true);
    expect(discovery.not_ready_reasons).toEqual([]);

    const manifest = mustFind('template.document');
    expect(discovery.available_operations).toEqual(manifest.capabilities.map((c) => c.label));
    // 可用操作清单里不得混入指令全文
    for (const instruction of manifest.instructions) {
      expect(discovery.available_operations).not.toContain(instruction);
    }
  });

  it('R233：stub 即使安装 / 启用 / 探针全绿，也**永不**判就绪', () => {
    const registry = createPluginRegistry();
    registry.install('template.meituan', { at: L(1) });
    registry.enable('template.meituan', L(2));

    const discovery = registry.discover('template.meituan', allReady);
    if (discovery === undefined) throw new Error('应有发现结果');
    expect(discovery.stub).toBe(true);
    expect(discovery.stub_reason).toBeTruthy();
    expect(discovery.ready).toBe(false);
    expect(discovery.not_ready_reasons.join(' ')).toContain('stub');
    expect(discovery.available_operations).toEqual([]);
  });

  it('整份目录都能被发现；未知插件返回 undefined（不编造结论）', () => {
    const registry = createPluginRegistry();
    expect(registry.discoverAll(allReady)).toHaveLength(10);
    expect(registry.discover('template.nope', allReady)).toBeUndefined();
  });

  it('available operations 只来自**就绪**插件，stub 不出现', () => {
    const registry = createPluginRegistry();
    registry.install('template.document', { at: L(1) });
    registry.enable('template.document', L(2));
    registry.install('template.meituan', { at: L(3) });
    registry.enable('template.meituan', L(4));

    const operations = registry.describeAvailableOperations(allReady);
    const pluginIds = new Set(operations.map((operation) => operation.plugin_id));
    expect(pluginIds.has('template.document')).toBe(true);
    expect(pluginIds.has('template.meituan')).toBe(false);
    for (const operation of operations) {
      expect(Object.keys(operation).sort()).toEqual(['capability_id', 'label', 'plugin_id']);
    }
  });

  it('describeDiscovery 是纯函数，可直接喂记录（未安装时记录为 undefined）', () => {
    const discovery = describeDiscovery(mustFind('template.clock'), undefined, conservativeProbes());
    expect(discovery.installed).toBe(false);
    expect(discovery.ready).toBe(false);
    expect(discovery.stub).toBe(true);
  });
});

describe('版本固定与新建实例闸门（PLG-04 / R230）', () => {
  it('就绪后可签发固定绑定；停用后**阻止新实例**，但既有绑定不被改写', () => {
    const registry = createPluginRegistry();
    registry.install('template.document', { at: L(1) });
    registry.enable('template.document', L(2));

    const binding = registry.pin('template.document', L(3), allReady);
    expect(binding.version).toBe('0.9.0');
    expect(binding.capability_ids).toEqual(
      mustFind('template.document').capabilities.map((c) => c.capability_id),
    );

    registry.disable('template.document', L(4));
    const gate = registry.gateInstanceCreation('template.document', L(5), allReady);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.reasons.join(' ')).toContain('未启用');
    }
    // 既有绑定是签发时的快照，未被改写
    expect(binding.version).toBe('0.9.0');
    expect(binding.pinned_at).toBe(3);
  });

  it('撤权**即时**影响后续新建实例判定', () => {
    const registry = createPluginRegistry();
    registry.install('template.document', { at: L(1) });
    registry.enable('template.document', L(2));
    expect(registry.gateInstanceCreation('template.document', L(3), allReady).ok).toBe(true);

    registry.revokeAuthorization('template.document', L(4));
    const gate = registry.gateInstanceCreation('template.document', L(5), allReady);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.reasons.join(' ')).toContain('未授权');
    }

    registry.authorize('template.document', L(6));
    expect(registry.gateInstanceCreation('template.document', L(7), allReady).ok).toBe(true);
  });

  it('未就绪时签发绑定会抛错（不得凭空拿到绑定）', () => {
    const registry = createPluginRegistry();
    registry.install('template.clock', { at: L(1) });
    expect(() => registry.pin('template.clock', L(2), allReady)).toThrow(/不能签发实例绑定/);
  });
});

describe('持久状态与重启回归（R228 / R230）', () => {
  it('快照恢复后启用状态保留', () => {
    const registry = createPluginRegistry();
    registry.install('template.clock', { at: L(1) });
    registry.enable('template.clock', L(2));

    const restored = createPluginRegistry();
    restored.restoreSnapshot(registry.snapshot());
    const record = restored.recordOf('template.clock');
    expect(record?.installed).toBe(true);
    expect(record?.enabled).toBe(true);
    expect(restored.revision).toBeGreaterThanOrEqual(registry.revision);
  });

  it('更晚的卸载**不被更早的离线快照复活**', () => {
    const registry = createPluginRegistry();
    registry.install('template.document', { at: L(1) });
    registry.enable('template.document', L(2));
    const earlySnapshot = registry.snapshot();

    registry.uninstall('template.document', L(9));
    expect(registry.recordOf('template.document')?.installed).toBe(false);

    // 用"更早"的快照恢复：卸载（updated_at=9）胜出
    registry.restoreSnapshot(earlySnapshot);
    expect(registry.recordOf('template.document')?.installed).toBe(false);

    // 空快照合并不改变任何东西
    registry.restoreSnapshot(emptyRegistrySnapshot());
    expect(registry.recordOf('template.document')?.installed).toBe(false);
  });

  it('声明式包安装后默认**未启用、未授权**，且必须经包校验才可安装', () => {
    const registry = new PluginRegistry();
    const result = registry.installFromPackage(
      {
        package_id: 'pkg.extra',
        version: '1.0.0',
        manifest: mustFind('template.research'),
      },
      L(1),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.installed).toBe(true);
    expect(result.record.enabled).toBe(false);
    expect(result.record.authorized).toBe(false);
    expect(result.record.install_source.kind).toBe('declarative_package');

    const discovery = registry.discover('template.research', allReady);
    expect(discovery?.authorized).toBe(false);
  });
});

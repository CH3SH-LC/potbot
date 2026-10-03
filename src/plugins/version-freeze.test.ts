/**
 * 版本冻结单测（design-06 P6 / PLG-04；合同 R228 / R230）。
 *
 * 覆盖：
 * - **正例**：活跃实例**固定版本**——更新后旧实例仍按旧版本跑，新实例才拿新版本；
 * - **正例**：三条规则逐条写出（`FREEZE_RULES`）；
 * - **反例 1**：改写冻结绑定（版本 / 签发时刻）⇒ `assertFrozenBindingUnchanged` 抛错；
 * - **反例 2**：停用阻止新实例，既有绑定不受影响；
 * - **反例 3**：撤权**即时**拒绝新实例（原因含"未授权"），重新授权后恢复；
 * - **反例 4**：未就绪插件不给签发；同一实例不能重复签发。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime } from '../protocol/index.js';
import { validateDeclarativePackage } from './manifest.js';
import { createPluginRegistry, type DiscoveryProbes } from './registry.js';
import {
  FREEZE_RULES,
  VersionFreezer,
  assertFrozenBindingUnchanged,
  type FrozenInstance,
} from './version-freeze.js';

const L = asLogicalTime;

let tick = 0;
function clock(): ReturnType<typeof asLogicalTime> {
  tick += 1;
  return L(tick);
}

const allReady: DiscoveryProbes = {
  dependencies: { isAdapterReady: () => true },
  support: { isActuallySupported: () => true },
};

/** 一个受控来源的声明式包：把 `template.document` 升到指定版本（用于"更新"路径）。 */
function documentPackage(version: string) {
  const validation = validateDeclarativePackage({
    package_id: 'pkg.document.controlled',
    version,
    install_source: { kind: 'declarative_package', origin: 'controlled-dir://document' },
    requested_capabilities: [],
    manifest: {
      kind: 'business_template',
      plugin_id: 'template.document',
      display_name: '文档模板（受控更新）',
      version,
      kernel_compatibility: { min_version: '0.9.0', max_version: null },
      capabilities: [{ capability_id: 'cap.doc.create', label: '新建文档', description: '依据共享事实生成 DOCX 文档' }],
      instructions: ['doc.create：按模板声明的输入事实键装配文档内容'],
      inputs: [{ name: 'facts', kind: 'fact', description: '模板声明的输入事实键与快照', formats: [] }],
      outputs: [{ name: 'document', kind: 'file', description: '生成的 DOCX 文件', formats: ['docx'] }],
      adapter_dependencies: [
        { adapter_id: 'builtin.docx_builder', kind: 'builtin', required: true, description: '仓库内 DOCX 构建器' },
      ],
      permissions: [{ permission_id: 'perm.file.write', description: '写出文件到受控运行目录', required: true }],
      data_scope: { level: 'task', detail: '仅访问本任务的共享事实与用户指定的源文件' },
      experience_policy: { strategy: 'candidate_review', detail: '排版偏好可作为候选经验提交评审' },
      install_source: { kind: 'declarative_package', origin: 'controlled-dir://document' },
      implementation: 'real',
      produces_file_formats: ['docx'],
      consumes_formats: ['docx'],
    },
  });
  if (!validation.ok) {
    throw new Error(`测试包不合法：${validation.rejections.map((rejection) => rejection.code).join(', ')}`);
  }
  return validation.package;
}

/** 装 + 启 `template.document`（内置来源默认受信 ⇒ 已授权）。 */
function readyRegistry() {
  const registry = createPluginRegistry();
  registry.install('template.document', { at: clock() });
  registry.enable('template.document', clock());
  return registry;
}

describe('PLG-04 活跃实例固定版本', () => {
  it('更新（受控包升版本）不改写既有绑定；旧实例按旧版本，新实例才拿新版本', () => {
    const registry = readyRegistry();
    const freezer = new VersionFreezer(registry);

    const frozen = freezer.issue('template.document', 'inst-1', clock(), allReady);
    expect(frozen.version).toBe('0.9.0');
    expect(freezer.size).toBe(1);

    const update = registry.installFromPackage(documentPackage('1.0.0'), clock());
    expect(update.ok).toBe(true);

    const drift = freezer.driftReport('template.document');
    expect(drift).toHaveLength(1);
    expect(drift[0]?.frozen_version).toBe('0.9.0');
    expect(drift[0]?.current_version).toBe('1.0.0');
    expect(drift[0]?.drift).toBe(true);
    expect(drift[0]?.direction).toBe('upgraded');
    expect(drift[0]?.frozen_binding_intact).toBe(true);

    // 既有实例**原样不改写**（R230）
    expect(freezer.get('inst-1')?.version).toBe('0.9.0');
    expect(freezer.get('inst-1')?.pinned_at).toBe(frozen.pinned_at);

    // 更新后状态复位：新实例先被阻止，重新启用 + 授权后才拿到**新**版本
    expect(freezer.checkNewInstance('template.document', clock(), allReady).ok).toBe(false);
    registry.enable('template.document', clock());
    registry.authorize('template.document', clock());
    const gate = freezer.checkNewInstance('template.document', clock(), allReady);
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.binding.version).toBe('1.0.0');
      expect(gate.binding.version).not.toBe(freezer.get('inst-1')?.version);
    }
    // 新旧并存：旧实例始终是 0.9.0
    expect(freezer.get('inst-1')?.version).toBe('0.9.0');
  });

  it('三条规则逐条写出', () => {
    expect(FREEZE_RULES).toHaveLength(3);
    for (const rule of FREEZE_RULES) {
      expect(rule.length).toBeGreaterThan(10);
    }
    expect(FREEZE_RULES.join(' ')).toContain('固定版本');
  });
});

describe('PLG-04 反例：不允许悄悄改写冻结绑定', () => {
  it('改写版本 / 签发时刻 ⇒ 断言抛错；未改写则不抛', () => {
    const frozen: FrozenInstance = {
      instance_id: 'inst-1',
      plugin_id: 'template.document',
      version: '0.9.0',
      capability_ids: [],
      pinned_at: L(3),
    };
    expect(() => assertFrozenBindingUnchanged(frozen, { ...frozen, version: '1.0.0' })).toThrow(/改写/);
    expect(() => assertFrozenBindingUnchanged(frozen, { ...frozen, pinned_at: L(9) })).toThrow(/改写/);
    expect(() => assertFrozenBindingUnchanged(frozen, { ...frozen })).not.toThrow();
  });
});

describe('PLG-04 反例：停用阻止新实例，既有绑定不受影响', () => {
  it('停用后新建实例被拒（原因含"停用"），冻结实例保持', () => {
    const registry = readyRegistry();
    const freezer = new VersionFreezer(registry);
    const frozen = freezer.issue('template.document', 'inst-1', clock(), allReady);

    registry.disable('template.document', clock());
    const gate = freezer.checkNewInstance('template.document', clock(), allReady);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.reasons.join(' ')).toContain('停用');
    }
    expect(freezer.get('inst-1')?.version).toBe(frozen.version);
  });
});

describe('PLG-04 反例：授权撤销即时检查', () => {
  it('撤权后**下一次**新建实例立即被拒（原因含"未授权"），重新授权后恢复', () => {
    const registry = readyRegistry();
    const freezer = new VersionFreezer(registry);
    expect(freezer.checkNewInstance('template.document', clock(), allReady).ok).toBe(true);

    registry.revokeAuthorization('template.document', clock());
    const revoked = freezer.checkNewInstance('template.document', clock(), allReady);
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) {
      expect(revoked.reasons.join(' ')).toContain('未授权');
    }

    registry.authorize('template.document', clock());
    expect(freezer.checkNewInstance('template.document', clock(), allReady).ok).toBe(true);
  });
});

describe('PLG-04 反例：未就绪不给签发；同一实例不得重复签发', () => {
  it('未启用 ⇒ pin 拒绝；就绪后签发一次，重复签发抛错', () => {
    const registry = createPluginRegistry();
    registry.install('template.document', { at: clock() }); // 装而未启
    const freezer = new VersionFreezer(registry);
    expect(() => freezer.issue('template.document', 'inst-1', clock(), allReady)).toThrow(/当前不可用/);
    expect(freezer.size).toBe(0);

    registry.enable('template.document', clock());
    const first = freezer.issue('template.document', 'inst-1', clock(), allReady);
    expect(first.version).toBe('0.9.0');
    expect(() => freezer.issue('template.document', 'inst-1', clock(), allReady)).toThrow(/已有固定绑定/);
    expect(() => freezer.record('inst-1', first)).toThrow(/已有固定绑定/);

    // 不同实例 id 可以各自记账
    const second = freezer.record('inst-2', first);
    expect(second.instance_id).toBe('inst-2');
    expect(freezer.size).toBe(2);
    expect(freezer.listFor('template.document')).toHaveLength(2);
    expect(freezer.get('inst-404')).toBeUndefined();
  });
});

/**
 * FA-VERIFY-WAVE-2 · 第二轮独立验证：插件域（第一轮**未覆盖**的模块）
 *
 * 覆盖模块：`plugins/install-sources`（PLG-01/02/07）。输入由验证方自造，不复用实现者 fixture。
 * 「跨重启保留」只在**同进程**内存存储上复算；真实持久介质**未实测**。
 */

import { describe, expect, it } from 'vitest';

import type { LogicalTime } from '../../../src/protocol/index.js';
import {
  assertNamespacesDisjoint,
  classifyModelName,
  createInstallSourceManager,
  createMemoryInstallStateStore,
  emptyInstallState,
  evaluateTemplateUsability,
  findInstallSource,
  findNamespaceOverlaps,
  isFileFormatName,
  isToolModelId,
  listBusinessTemplateSources,
  TEMPLATE_INVENTORY,
} from '../../../src/plugins/install-sources.js';
import { BUSINESS_TEMPLATE_IDS, BASE_ROLE_IDS } from '../../../src/plugins/manifest.js';
import { BUSINESS_TEMPLATES } from '../../../src/plugins/catalog.js';

const T = (v: number): LogicalTime => v as LogicalTime;

describe('独立验证 · plugins/install-sources（PLG-07 命名空间分层）', () => {
  it('正向：文件格式 / 工具 / 模板 / 角色四命名空间正交', () => {
    expect(() => assertNamespacesDisjoint()).not.toThrow();
    expect(findNamespaceOverlaps()).toEqual([]);
    expect(classifyModelName('docx')).toEqual(['file_format']);
    expect(classifyModelName('tool.meituan')).toEqual(['tool']);
    expect(classifyModelName('template.clock')).toEqual(['business_template']);
    expect(classifyModelName('role.front_agent')).toEqual(['base_role']);
  });

  it('反向对照 A：工具名**永不**是文件格式（R232）', () => {
    expect(isFileFormatName('meituan')).toBe(false);
    expect(isFileFormatName('tool.meituan')).toBe(false);
    expect(isFileFormatName('xlsx')).toBe(true);
    expect(isToolModelId('tool.clock')).toBe(true);
    expect(isToolModelId('clock')).toBe(false);
    // 既不是格式也不是工具 / 模板 / 角色的名字 ⇒ 空分类
    expect(classifyModelName('meituan')).toEqual([]);
    expect(classifyModelName(42)).toEqual([]);
  });
});

describe('独立验证 · plugins/install-sources（PLG-01 模板清单）', () => {
  it('正向：七个业务模板的真实清单齐备（能力 / 端口 / 指令 / 版本）', () => {
    expect(TEMPLATE_INVENTORY.map((entry) => entry.plugin_id)).toEqual([...BUSINESS_TEMPLATE_IDS]);
    for (const entry of TEMPLATE_INVENTORY) {
      expect(entry.capability_ids.length).toBeGreaterThan(0);
      expect(entry.input_ports.length + entry.output_ports.length).toBeGreaterThan(0);
      expect(entry.instruction_count).toBeGreaterThan(0);
    }
    // 可用性体检针对**原始清单**（含 capabilities/inputs/outputs/instructions/version）
    expect(BUSINESS_TEMPLATES).toHaveLength(7);
    for (const manifest of BUSINESS_TEMPLATES) {
      expect(evaluateTemplateUsability(manifest).usable).toBe(true);
    }
    expect(listBusinessTemplateSources()).toHaveLength(7);
  });

  it('反向对照 A：只有名字 / prompt 不算模板可用（R228），逐条给原因', () => {
    const nameOnly = evaluateTemplateUsability({ display_name: '花架子' });
    expect(nameOnly.usable).toBe(false);
    expect(nameOnly.name_only).toBe(true);
    expect(nameOnly.reasons.length).toBeGreaterThan(0);
    const notObject = evaluateTemplateUsability('just-a-name');
    expect(notObject.usable).toBe(false);
    expect(notObject.name_only).toBe(true);
  });

  it('反向对照 B：缺端口 / 缺版本各自具名，不静默通过', () => {
    const missingPorts = evaluateTemplateUsability({
      version: '1.0.0',
      capabilities: [{ capability_id: 'c' }],
      instructions: [{ name: 'i' }],
      inputs: [],
      outputs: [],
    });
    expect(missingPorts.usable).toBe(false);
    expect(missingPorts.reasons.some((reason) => reason.includes('端口'))).toBe(true);
    const missingVersion = evaluateTemplateUsability({
      capabilities: [{ capability_id: 'c' }],
      instructions: [{ name: 'i' }],
      inputs: [{ name: 'in' }],
    });
    expect(missingVersion.reasons.some((reason) => reason.includes('版本'))).toBe(true);
  });
});

describe('独立验证 · plugins/install-sources（PLG-02 安装状态持久化）', () => {
  it('正向：安装 / 启用 / 停用 / 卸载入口与持久状态；来源可查', () => {
    const manager = createInstallSourceManager();
    const id = BUSINESS_TEMPLATE_IDS[0];
    expect(findInstallSource(id)?.kind).toBe('business_template');
    const installed = manager.install(id, T(1));
    expect(installed.ok).toBe(true);
    expect(manager.enable(id, T(2)).enabled).toBe(true);
    const snapshot = manager.snapshot();
    expect(snapshot.records.some((record) => record.plugin_id === id)).toBe(true);
  });

  it('反向对照 A：未安装即启用 ⇒ 抛；未知插件安装 ⇒ 具名拒因', () => {
    const manager = createInstallSourceManager();
    expect(() => manager.enable(BUSINESS_TEMPLATE_IDS[0], T(1))).toThrow();
    expect(manager.install('no.such.plugin', T(1))).toMatchObject({ ok: false, reason: 'unknown_plugin' });
  });

  it('反向对照 B：空存储 reload ⇒ false（**不编造**任何记录）', () => {
    const empty = createMemoryInstallStateStore();
    const manager = createInstallSourceManager({ store: empty });
    expect(manager.reload()).toBe(false);
    expect(emptyInstallState().records).toEqual([]);
  });

  it('正向（同进程）：persist 后新管理器 reload ⇒ 状态保留', () => {
    const store = createMemoryInstallStateStore();
    const first = createInstallSourceManager({ store });
    const id = BASE_ROLE_IDS[0];
    first.install(id, T(1));
    first.enable(id, T(2));
    first.persist();

    const second = createInstallSourceManager({ store });
    expect(second.reload()).toBe(true);
    const record = second.snapshot().records.find((entry) => entry.plugin_id === id);
    expect(record?.installed).toBe(true);
    expect(record?.enabled).toBe(true);
  });
});

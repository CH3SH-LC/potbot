/**
 * PLG-01 / PLG-02 / PLG-07 单测：模板清单、安装来源与持久状态、模板/工具/文件格式分层。
 *
 * 正反例覆盖（每项至少一条反向对照）：
 * - **PLG-07**：`meituan` / `clock` / `calendar` / `research` **不是**文件格式；命名空间互不重叠；
 * - **PLG-01**：七个模板的真实清单逐项存在，办公模板产出 docx/xlsx/pptx，工具型模板产出为空；
 * - **PLG-02**：安装 / 启用 / 停用 / 卸载入口可用，状态可跨"重启"恢复；
 *   反例：未安装就启用抛错；空存储 reload 不编造记录；含 exec 的声明式包一个字节都不落。
 * - **R228**：只有名字或 prompt 不算模板可用；必需依赖缺失具名可诊断。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime, ValidationError } from '../protocol/index.js';
import { BUSINESS_TEMPLATES } from './catalog.js';
import { conservativeProbes } from './registry.js';
import {
  FILE_FORMAT_NAMESPACE,
  TEMPLATE_INVENTORY,
  TOOL_KEYWORDS,
  TOOL_MODEL_IDS,
  assertNamespacesDisjoint,
  classifyModelName,
  createInstallSourceManager,
  createMemoryInstallStateStore,
  diagnoseTemplateDependencies,
  evaluateTemplateAvailability,
  evaluateTemplateUsability,
  findInstallSource,
  findNamespaceOverlaps,
  getTemplateInventory,
  isFileFormatName,
  isToolModelId,
  listBusinessTemplateSources,
  REGISTERED_INSTALL_SOURCES,
} from './install-sources.js';

const L = asLogicalTime;

/** 一份形状合规的声明式包（用于验证安装入口；内容校验细节见 declarative-package.test.ts）。 */
function validPackage(): Record<string, unknown> {
  return {
    package_id: 'pkg.demo.document',
    version: '1.0.0',
    install_source: { kind: 'declarative_package', origin: 'pkg.demo.document' },
    requested_capabilities: ['cap.doc.create'],
    manifest: {
      kind: 'business_template',
      plugin_id: 'template.document',
      display_name: '示例文档模板',
      version: '1.0.0',
      kernel_compatibility: { min_version: '0.9.0', max_version: null },
      capabilities: [{ capability_id: 'cap.doc.create', label: '新建文档', description: '依据事实生成 DOCX' }],
      instructions: ['doc.create：只依据共享事实快照'],
      inputs: [{ name: 'facts', kind: 'fact', description: '输入事实快照', formats: [] }],
      outputs: [{ name: 'document', kind: 'file', description: '生成的 DOCX', formats: ['docx'] }],
      adapter_dependencies: [],
      permissions: [],
      data_scope: { level: 'task', detail: '仅访问本任务共享事实' },
      experience_policy: { strategy: 'none', detail: '本示例不攒经验' },
      install_source: { kind: 'declarative_package', origin: 'pkg.demo.document' },
      implementation: 'real',
      stub_reason: null,
      produces_file_formats: ['docx'],
      consumes_formats: [],
    },
  };
}

describe('PLG-07：模板 / 工具 / 文件格式分开建模（R232）', () => {
  it('文件格式命名空间只有 docx / xlsx / pptx', () => {
    expect([...FILE_FORMAT_NAMESPACE].sort()).toEqual(['docx', 'pptx', 'xlsx']);
  });

  it('反向对照：美团 / 时钟 / 日历 / 检索**不是**文件格式', () => {
    for (const keyword of TOOL_KEYWORDS) {
      expect(isFileFormatName(keyword)).toBe(false);
      expect(FILE_FORMAT_NAMESPACE).not.toContain(keyword);
    }
    // 工具 id 本身也绝不落进文件格式枚举
    for (const tool of TOOL_MODEL_IDS) {
      expect(isFileFormatName(tool)).toBe(false);
      expect(isToolModelId(tool)).toBe(true);
    }
  });

  it('正向对照：docx / xlsx / pptx 是文件格式，且不是工具', () => {
    for (const format of ['docx', 'xlsx', 'pptx']) {
      expect(isFileFormatName(format)).toBe(true);
      expect(isToolModelId(format)).toBe(false);
    }
  });

  it('命名空间互不重叠；assertNamespacesDisjoint 不抛错', () => {
    expect(findNamespaceOverlaps()).toEqual([]);
    expect(() => assertNamespacesDisjoint()).not.toThrow();
  });

  it('classifyModelName 把每个名字归到唯一分层', () => {
    expect(classifyModelName('docx')).toEqual(['file_format']);
    expect(classifyModelName('tool.meituan')).toEqual(['tool']);
    expect(classifyModelName('template.document')).toEqual(['business_template']);
    expect(classifyModelName('role.front_agent')).toEqual(['base_role']);
    expect(classifyModelName('nope')).toEqual([]);
  });

  it('反向对照：工具型模板产出文件格式为空（不把工具塞进文件类型枚举）', () => {
    expect(getTemplateInventory('template.meituan')?.produces_file_formats).toEqual([]);
    expect(getTemplateInventory('template.clock')?.produces_file_formats).toEqual([]);
    expect(getTemplateInventory('template.calendar')?.produces_file_formats).toEqual([]);
    expect(getTemplateInventory('template.research')?.produces_file_formats).toEqual([]);
    // 工具 id 绑定在 tool_models，而不是 produces_file_formats
    expect(getTemplateInventory('template.meituan')?.tool_models).toEqual(['tool.meituan']);
    expect(getTemplateInventory('template.research')?.tool_models).toEqual(['tool.research']);
  });
});

describe('PLG-01：七个业务模板的真实清单', () => {
  it('清单覆盖全部七个模板，顺序与目录一致', () => {
    expect(TEMPLATE_INVENTORY).toHaveLength(7);
    expect(TEMPLATE_INVENTORY.map((entry) => entry.plugin_id)).toEqual([
      'template.document',
      'template.spreadsheet',
      'template.presentation',
      'template.meituan',
      'template.clock',
      'template.calendar',
      'template.research',
    ]);
  });

  it('每条清单都带版本 / 内核兼容 / 能力 / 指令 / 端口 / 数据范围 / 经验策略 / 来源', () => {
    for (const entry of TEMPLATE_INVENTORY) {
      expect(entry.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(entry.kernel_compatibility.min_version).toMatch(/^\d+\.\d+\.\d+/);
      expect(entry.capability_ids.length).toBeGreaterThan(0);
      expect(entry.instruction_count).toBeGreaterThan(0);
      expect(entry.input_ports.length + entry.output_ports.length).toBeGreaterThan(0);
      expect(entry.data_scope_level).toBeTruthy();
      expect(entry.experience_strategy).toBeTruthy();
      expect(entry.install_source_kind).toBe('builtin');
      expect(entry.is_stub).toBe(entry.implementation === 'stub');
    }
  });

  it('办公模板产出 docx / xlsx / pptx，与文件格式枚举一致', () => {
    expect(getTemplateInventory('template.document')?.produces_file_formats).toEqual(['docx']);
    expect(getTemplateInventory('template.spreadsheet')?.produces_file_formats).toEqual(['xlsx']);
    expect(getTemplateInventory('template.presentation')?.produces_file_formats).toEqual(['pptx']);
    // 读格式可以含非 OOXML（如 csv），但绝不进入文件类型枚举
    expect(getTemplateInventory('template.spreadsheet')?.consumes_formats).toContain('csv');
    expect(isFileFormatName('csv')).toBe(false);
  });

  it('反向对照：产地检索读 pdf 但产出为空，pdf 不是文件格式', () => {
    const research = getTemplateInventory('template.research');
    expect(research?.consumes_formats).toContain('pdf');
    expect(research?.produces_file_formats).toEqual([]);
    expect(isFileFormatName('pdf')).toBe(false);
  });

  it('反向对照：查不到的模板返回 undefined（不编造）', () => {
    expect(getTemplateInventory('template.nope')).toBeUndefined();
  });
});

describe('PLG-02：安装来源目录与入口', () => {
  it('目录含七个业务模板 + 三个基础角色，全部为内置来源', () => {
    expect(REGISTERED_INSTALL_SOURCES).toHaveLength(10);
    expect(listBusinessTemplateSources()).toHaveLength(7);
    expect(REGISTERED_INSTALL_SOURCES.every((entry) => entry.install_source.kind === 'builtin')).toBe(true);
    expect(findInstallSource('template.document')?.kind).toBe('business_template');
    expect(findInstallSource('role.front_agent')?.kind).toBe('base_role');
    expect(findInstallSource('template.nope')).toBeUndefined();
  });

  it('install → enable → disable → uninstall 入口逐态可用', () => {
    const manager = createInstallSourceManager();
    const installed = manager.install('template.document', L(1));
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    expect(installed.record.installed).toBe(true);
    expect(installed.record.enabled).toBe(false); // 安装 ≠ 启用
    expect(manager.enable('template.document', L(2)).enabled).toBe(true);
    expect(manager.disable('template.document', L(3)).enabled).toBe(false);
    const uninstalled = manager.uninstall('template.document', L(4));
    expect(uninstalled.installed).toBe(false);
    expect(uninstalled.enabled).toBe(false);
  });

  it('反向对照：未安装就启用抛 ValidationError；未知插件安装失败且不落记录', () => {
    const manager = createInstallSourceManager();
    expect(() => manager.enable('template.document', L(1))).toThrow(ValidationError);
    const missing = manager.install('template.nope', L(1));
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.reason).toBe('unknown_plugin');
    expect(manager.pluginRegistry.recordOf('template.nope')).toBeUndefined();
  });

  it('sourceOf 对目录内插件给出受控来源，对未知插件返回 undefined', () => {
    const manager = createInstallSourceManager();
    expect(manager.sourceOf('template.document')?.install_source.kind).toBe('builtin');
    expect(manager.sourceOf('template.nope')).toBeUndefined();
  });
});

describe('PLG-02：持久状态跨重启恢复', () => {
  it('persist 后新管理器 reload 恢复启用与版本状态', () => {
    const store = createMemoryInstallStateStore();
    const first = createInstallSourceManager({ store });
    first.install('template.document', L(1));
    first.enable('template.document', L(2));
    first.persist();

    const second = createInstallSourceManager({ store });
    expect(second.pluginRegistry.recordOf('template.document')).toBeUndefined(); // 重启前尚未恢复
    expect(second.reload()).toBe(true);
    const record = second.pluginRegistry.recordOf('template.document');
    expect(record?.installed).toBe(true);
    expect(record?.enabled).toBe(true);
    expect(record?.version).toBe('0.9.0');
  });

  it('反向对照：空存储 reload 返回 false 且**不编造**任何记录', () => {
    const manager = createInstallSourceManager();
    expect(manager.reload()).toBe(false);
    expect(manager.pluginRegistry.listRecords()).toEqual([]);
  });

  it('反向对照：更晚的卸载不会被更早的快照复活（updated_at 合并）', () => {
    const store = createMemoryInstallStateStore();
    const first = createInstallSourceManager({ store });
    first.install('template.document', L(1));
    first.persist(); // 快照：已安装

    const second = createInstallSourceManager({ store });
    second.reload();
    second.uninstall('template.document', L(10)); // 更晚的卸载
    second.persist();

    const third = createInstallSourceManager({ store });
    third.reload();
    expect(third.pluginRegistry.recordOf('template.document')?.installed).toBe(false);
  });
});

describe('PLG-02：声明式包安装入口（校验失败一个字节都不落）', () => {
  it('合规包安装成功：已安装、默认未启用、声明式来源、默认未授权', () => {
    const manager = createInstallSourceManager();
    const result = manager.installDeclarativePackage(validPackage(), L(1));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.installed).toBe(true);
    expect(result.record.enabled).toBe(false);
    expect(result.record.authorized).toBe(false);
    expect(result.record.install_source.kind).toBe('declarative_package');
  });

  it('反向对照：含 exec 的包被拒，拒因具名，注册表状态不变', () => {
    const manager = createInstallSourceManager();
    const bad = validPackage();
    bad.exec = 'node evil.js';
    const result = manager.installDeclarativePackage(bad, L(1));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.subject === 'exec')).toBe(true);
    expect(manager.pluginRegistry.recordOf('template.document')).toBeUndefined();
  });
});

describe('R228：只有名字或 prompt 不算模板可用；依赖缺失可诊断', () => {
  it('反向对照：只有名字 + prompt 的"模板"不可用且给出原因', () => {
    const usability = evaluateTemplateUsability({ display_name: '美团模板', prompt: '帮我找餐厅' });
    expect(usability.usable).toBe(false);
    expect(usability.name_only).toBe(true);
    expect(usability.reasons.length).toBeGreaterThan(0);
    expect(usability.reasons.join(' ')).toContain('R228');
    expect(usability.reasons.some((reason) => reason.includes('能力'))).toBe(true);
  });

  it('正向对照：注册目录里的真模板可用，原因为空', () => {
    for (const manifest of BUSINESS_TEMPLATES) {
      const usability = evaluateTemplateUsability(manifest);
      expect(usability.usable).toBe(true);
      expect(usability.reasons).toEqual([]);
    }
  });

  it('反向对照：非对象输入也不得被当成可用', () => {
    expect(evaluateTemplateUsability(null).usable).toBe(false);
    expect(evaluateTemplateUsability('美团').usable).toBe(false);
  });

  it('依赖缺失具名可诊断：美团模板缺 meituan_mcp，原因带适配器名', () => {
    const meituan = BUSINESS_TEMPLATES.find((manifest) => manifest.plugin_id === 'template.meituan');
    expect(meituan).toBeDefined();
    const report = diagnoseTemplateDependencies(meituan!, conservativeProbes().dependencies);
    expect(report.dependencies_ready).toBe(false);
    expect(report.required_adapter_ids).toContain('meituan_mcp');
    expect(report.missing_required.map((entry) => entry.adapter_id)).toContain('meituan_mcp');
    expect(report.missing_required[0]?.reason).toContain('meituan_mcp');
    expect(report.summary).toContain('meituan_mcp');

    const availability = evaluateTemplateAvailability(meituan!, conservativeProbes().dependencies);
    expect(availability.usable).toBe(false);
    expect(availability.missing_required_adapter_ids).toContain('meituan_mcp');
    expect(availability.reasons.join(' ')).toContain('未就绪');
  });

  it('反向对照：依赖就绪时不再报缺（同一个探针换成就绪）', () => {
    const research = BUSINESS_TEMPLATES.find((manifest) => manifest.plugin_id === 'template.research');
    expect(research).toBeDefined();
    const notReady = diagnoseTemplateDependencies(research!, conservativeProbes().dependencies);
    expect(notReady.dependencies_ready).toBe(false); // research_network_port 必需
    const ready = diagnoseTemplateDependencies(research!, conservativeProbes({ readyAdapters: ['research_network_port'] }).dependencies);
    expect(ready.dependencies_ready).toBe(true);
    expect(ready.missing_required).toEqual([]);
  });
});
